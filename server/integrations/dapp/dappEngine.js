'use strict';

const { SafeEngine } = require('./safeEngine');
const { getConfig } = require('./config');

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

const memory = { safes: new Map(), payouts: new Map(), deposits: new Map(), distributions: new Map(), whiteLabel: new Map() };

function jsonbValue(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') return JSON.parse(raw || '{}');
  return raw;
}

function identifier(prefix = 'DAP') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

async function query(sql, params) {
  if (!pool || !pool.query) throw new Error('Postgres pool unavailable');
  return pool.query(sql, params);
}

async function withFallback(fn, fallback) {
  try { return await fn(); } catch (e) { if (!pool) return fallback(e); throw e; }
}

class DappEngine {
  static async ensureTables() {
    return withFallback(async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS dapp_safes (
          id TEXT PRIMARY KEY,
          label TEXT,
          safe_address TEXT NOT NULL,
          chain_id INTEGER NOT NULL DEFAULT 1,
          owners JSONB NOT NULL,
          threshold INTEGER NOT NULL,
          salt_nonce TEXT,
          deploy_tx_hash TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','deployed','failed')),
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS dapp_payouts (
          id TEXT PRIMARY KEY,
          safe_id TEXT NOT NULL REFERENCES dapp_safes(id) ON DELETE CASCADE,
          type TEXT NOT NULL DEFAULT 'payout' CHECK (type IN ('payout','disbursement','p2p','distribution_item')),
          destination TEXT NOT NULL,
          value TEXT,
          token TEXT,
          token_amount TEXT,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','executed','failed')),
          safe_tx_hash TEXT,
          server_signature TEXT,
          signatures JSONB DEFAULT '[]',
          tx_hash TEXT,
          source_type TEXT,
          source_account_id TEXT,
          reserve_id TEXT,
          distribution_id TEXT,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_dapp_payouts_status ON dapp_payouts(status);`);
      await query(`CREATE INDEX IF NOT EXISTS idx_dapp_payouts_safe ON dapp_payouts(safe_id);`);

      await query(`
        CREATE TABLE IF NOT EXISTS dapp_deposits (
          id TEXT PRIMARY KEY,
          safe_id TEXT REFERENCES dapp_safes(id) ON DELETE SET NULL,
          asset TEXT NOT NULL,
          amount TEXT NOT NULL,
          from_address TEXT,
          tx_hash TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','failed')),
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS dapp_distributions (
          id TEXT PRIMARY KEY,
          safe_id TEXT REFERENCES dapp_safes(id) ON DELETE SET NULL,
          name TEXT,
          asset TEXT NOT NULL,
          total_amount TEXT NOT NULL,
          beneficiaries JSONB NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','executed','failed')),
          tx_hash TEXT,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS dapp_white_label (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT UNIQUE,
          primary_color TEXT DEFAULT '#0f172a',
          secondary_color TEXT DEFAULT '#3b82f6',
          logo_url TEXT,
          favicon_url TEXT,
          contact_email TEXT,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
    }, () => { /* memory fallback */ });
  }

  static _memKey(table) {
    const map = { dapp_safes: 'safes', dapp_payouts: 'payouts', dapp_deposits: 'deposits', dapp_distributions: 'distributions', dapp_white_label: 'whiteLabel' };
    return map[table] || table;
  }

  static async _insert(table, row, conflictKey = 'id') {
    return withFallback(async () => {
      const keys = Object.keys(row);
      const values = keys.map((_, i) => `$${i + 1}`).join(',');
      await query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${values}) ON CONFLICT (${conflictKey}) DO NOTHING`, Object.values(row));
    }, () => { const k = this._memKey(table); if (!memory[k]) memory[k] = new Map(); memory[k].set(row.id, row); });
  }

  static async _update(table, id, fields) {
    return withFallback(async () => {
      const keys = Object.keys(fields);
      if (!keys.length) return;
      const set = keys.map((k, i) => `${k} = $${i + 1}`).join(',');
      await query(`UPDATE ${table} SET ${set}, updated_at = NOW() WHERE id = $${keys.length + 1}`, [...Object.values(fields), id]);
    }, () => { const k = this._memKey(table); const r = memory[k].get(id); if (r) Object.assign(r, fields, { updated_at: new Date().toISOString() }); });
  }

  static async _selectOne(table, id) {
    return withFallback(async () => {
      const rows = await query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
      if (!rows.rows.length) throw new Error(`${table} not found: ${id}`);
      return rows.rows[0];
    }, () => { const k = this._memKey(table); const r = memory[k].get(id); if (!r) throw new Error(`${table} not found: ${id}`); return r; });
  }

  static async _selectAll(table, { limit = 100, offset = 0, order = 'created_at DESC' } = {}) {
    return withFallback(async () => {
      const rows = await query(`SELECT * FROM ${table} ORDER BY ${order} LIMIT $1 OFFSET $2`, [limit, offset]);
      return rows.rows;
    }, () => { const k = this._memKey(table); return Array.from(memory[k].values()).slice(offset, offset + limit); });
  }

  // ─── Safe wallets ─────────────────────────────────────────────────────────────
  static async createSafe({ label, owners, threshold, saltNonce, deployNow = false }) {
    const cfg = getConfig();
    if (!cfg.dappEnabled) throw new Error('DApp is disabled');
    if (!Array.isArray(owners) || !owners.length) throw new Error('Owners array required');

    const serverAccount = SafeEngine._account();
    if (!owners.map(o => o.toLowerCase()).includes(serverAccount.address.toLowerCase())) {
      owners.push(serverAccount.address);
    }
    if (threshold > owners.length) throw new Error('Threshold cannot exceed number of owners');

    const prediction = await SafeEngine.predictSafeAddress({ owners, threshold, saltNonce });
    const id = identifier('SAFE');
    const row = {
      id,
      label: label || `Safe ${id}`,
      safe_address: prediction.safeAddress,
      chain_id: cfg.chainId,
      owners: JSON.stringify(owners),
      threshold,
      salt_nonce: prediction.saltNonce,
      deploy_tx_hash: null,
      status: 'pending',
      metadata: JSON.stringify({ deploymentTransaction: prediction.deploymentTransaction }),
    };
    await this._insert('dapp_safes', row);

    if (deployNow || cfg.dappShadow) {
      try {
        const deploy = await SafeEngine.deploySafe({ owners, threshold, saltNonce });
        await this._update('dapp_safes', id, { deploy_tx_hash: deploy.txHash, status: 'deployed' });
        row.deploy_tx_hash = deploy.txHash;
        row.status = 'deployed';
      } catch (e) {
        await this._update('dapp_safes', id, { status: 'failed', metadata: JSON.stringify({ error: e.message }) });
        throw e;
      }
    }

    return row;
  }

  static async getSafe(id) {
    return this._selectOne('dapp_safes', id);
  }

  static async listSafes() {
    return this._selectAll('dapp_safes');
  }

  static async syncSafe(id) {
    const safe = await this.getSafe(id);
    const info = await SafeEngine.getSafeInfo(safe.safe_address);
    await this._update('dapp_safes', id, { status: info.isDeployed ? 'deployed' : 'pending', metadata: JSON.stringify({ ...safe.metadata, ...info }) });
    return { ...safe, ...info };
  }

  // ─── Deposits ─────────────────────────────────────────────────────────────────
  static async createDeposit({ safeId, asset, amount, fromAddress, txHash, status = 'pending' } = {}) {
    const id = identifier('DEP');
    const row = { id, safe_id: safeId || null, asset, amount: String(amount), from_address: fromAddress, tx_hash: txHash, status };
    await this._insert('dapp_deposits', row);
    return row;
  }

  static async listDeposits() { return this._selectAll('dapp_deposits'); }
  static async getDeposit(id) { return this._selectOne('dapp_deposits', id); }

  // ─── Payouts with 2-signature approval ──────────────────────────────────────────
  static async createPayout({ safeId, type = 'payout', destination, value, token, tokenAmount, description, sourceType, sourceAccountId } = {}) {
    if (!safeId || !destination || (!value && !tokenAmount)) throw new Error('safeId, destination and value/tokenAmount required');
    const safe = await this.getSafe(safeId);
    if (safe.status !== 'deployed') throw new Error('Safe must be deployed before payouts');
    const owners = Array.isArray(safe.owners) ? safe.owners : (jsonbValue(safe.owners) || []);
    const predictedSafe = {
      safeAccountConfig: { owners, threshold: safe.threshold },
      safeDeploymentConfig: { saltNonce: safe.salt_nonce || '0' },
    };

    const { safeTx, safeTxHash, serverSignature, proposer } = await SafeEngine.createTransaction({
      safeAddress: safe.safe_address,
      predictedSafe,
      to: destination,
      value,
      token,
      tokenAmount,
    });

    const id = identifier('PAY');
    const row = {
      id,
      safe_id: safeId,
      type,
      destination,
      value: value ? String(value) : null,
      token,
      token_amount: tokenAmount ? String(tokenAmount) : null,
      description,
      status: 'pending',
      safe_tx_hash: safeTxHash,
      server_signature: serverSignature,
      signatures: JSON.stringify([{ signer: proposer, signature: serverSignature, kind: 'proposer' }]),
      tx_hash: null,
      source_type: sourceType || null,
      source_account_id: sourceAccountId || null,
      reserve_id: null,
      distribution_id: null,
      metadata: JSON.stringify({ safeTx: safeTx.data, proposer }),
    };
    await this._insert('dapp_payouts', row);
    return { ...row, safeTxHash, needsSignature: true, pendingApprovals: safe.threshold - 1 };
  }

  static async approvePayout({ payoutId, signature, signerAddress }) {
    if (!payoutId || !signature) throw new Error('payoutId and signature required');
    const payout = await this.getPayout(payoutId);
    if (payout.status !== 'pending') throw new Error(`Payout status ${payout.status} cannot be approved`);

    const safe = await this.getSafe(payout.safe_id);
    const owners = Array.isArray(safe.owners) ? safe.owners : (jsonbValue(safe.owners) || []);
    const { safeTx } = await SafeEngine.addSignature({
      safeAddress: safe.safe_address,
      safeTx: this._rebuildSafeTx(payout),
      signature,
      safeTxHash: payout.safe_tx_hash,
      owners,
    });

    let recovered = signerAddress;
    if (!recovered) {
      recovered = await SafeEngine.recoverSigner(payout.safe_tx_hash, signature);
    }

    const signatures = Array.isArray(payout.signatures) ? payout.signatures : (jsonbValue(payout.signatures || '[]') || []);
    signatures.push({ signer: recovered, signature, kind: 'approver' });
    await this._update('dapp_payouts', payoutId, { signatures: JSON.stringify(signatures) });

    if (signatures.length >= safe.threshold) {
      const result = await SafeEngine.executeTransaction({ safeAddress: safe.safe_address, safeTx });
      await this._update('dapp_payouts', payoutId, { status: 'executed', tx_hash: result.txHash, metadata: JSON.stringify({ ...(jsonbValue(payout.metadata || '{}') || {}), result }) });
      return { ...payout, status: 'executed', txHash: result.txHash, signatures };
    }

    await this._update('dapp_payouts', payoutId, { status: 'pending' });
    return { ...payout, status: 'pending', signatures, pendingApprovals: safe.threshold - signatures.length };
  }

  static _rebuildSafeTx(payout) {
    const metadata = typeof payout.metadata === 'string' ? JSON.parse(payout.metadata || '{}') : (payout.metadata || {});
    const txData = metadata.safeTx || {};
    const sigs = [];
    if (payout.server_signature) sigs.push({ signer: payout.proposer || metadata.proposer, signature: payout.server_signature });
    const stored = Array.isArray(payout.signatures) ? payout.signatures : (jsonbValue(payout.signatures || '[]') || []);
    for (const s of stored) {
      if (s && s.signature && !sigs.find(x => x.signature === s.signature)) sigs.push(s);
    }
    return SafeEngine.rebuildTransaction(txData, sigs);
  }

  static async executePayout(payoutId) {
    const payout = await this.getPayout(payoutId);
    if (payout.status !== 'pending') throw new Error(`Payout status ${payout.status} cannot be executed`);
    const safe = await this.getSafe(payout.safe_id);
    const signatures = Array.isArray(payout.signatures) ? payout.signatures : (jsonbValue(payout.signatures || '[]') || []);
    if (signatures.length < safe.threshold) throw new Error(`Not enough signatures (${signatures.length}/${safe.threshold})`);
    const safeTx = this._rebuildSafeTx(payout);
    for (const sig of signatures) {
      await SafeEngine.addSignature({ safeAddress: safe.safe_address, safeTx, signature: sig.signature, safeTxHash: payout.safe_tx_hash });
    }
    const result = await SafeEngine.executeTransaction({ safeAddress: safe.safe_address, safeTx });
    await this._update('dapp_payouts', payoutId, { status: 'executed', tx_hash: result.txHash, metadata: JSON.stringify({ ...(jsonbValue(payout.metadata || '{}') || {}), result }) });
    return { ...payout, status: 'executed', txHash: result.txHash };
  }

  static async getPayout(id) { return this._selectOne('dapp_payouts', id); }
  static async listPayouts() { return this._selectAll('dapp_payouts'); }

  // ─── Distributions ────────────────────────────────────────────────────────────
  static async createDistribution({ safeId, name, asset, totalAmount, beneficiaries } = {}) {
    if (!safeId || !Array.isArray(beneficiaries) || !beneficiaries.length) throw new Error('safeId and beneficiaries required');
    const id = identifier('DIS');
    const safe = await this.getSafe(safeId);
    const dist = {
      id, safe_id: safeId, name: name || `Distribution ${id}`, asset, total_amount: String(totalAmount),
      beneficiaries: JSON.stringify(beneficiaries), status: 'pending',
    };
    await this._insert('dapp_distributions', dist);

    // Create child payout records for each beneficiary
    for (const b of beneficiaries) {
      await this.createPayout({
        safeId, type: 'distribution_item', destination: b.address, value: b.amount, token: b.token,
        tokenAmount: b.tokenAmount, description: `Distribution ${id} to ${b.name || b.address}`,
        sourceType: 'treasury',
      });
    }
    return dist;
  }

  static async getDistribution(id) { return this._selectOne('dapp_distributions', id); }
  static async listDistributions() { return this._selectAll('dapp_distributions'); }

  // ─── P2P payments ───────────────────────────────────────────────────────────────
  static async createP2p({ safeId, destination, value, token, tokenAmount, description, sourceType, sourceAccountId } = {}) {
    return this.createPayout({ safeId, type: 'p2p', destination, value, token, tokenAmount, description, sourceType, sourceAccountId });
  }

  // ─── White-label ──────────────────────────────────────────────────────────────
  static async getWhiteLabel(idOrSlug) {
    return withFallback(async () => {
      const rows = await query('SELECT * FROM dapp_white_label WHERE id = $1 OR slug = $1', [idOrSlug]);
      if (!rows.rows.length) throw new Error('White-label config not found');
      return rows.rows[0];
    }, () => {
      for (const v of memory.whiteLabel.values()) if (v.id === idOrSlug || v.slug === idOrSlug) return v;
      throw new Error('White-label config not found');
    });
  }

  static async setWhiteLabel({ id, name, slug, primaryColor, secondaryColor, logoUrl, faviconUrl, contactEmail } = {}) {
    const row = { id: id || identifier('WL'), name, slug, primary_color: primaryColor, secondary_color: secondaryColor, logo_url: logoUrl, favicon_url: faviconUrl, contact_email: contactEmail };
    await withFallback(async () => {
      const keys = Object.keys(row).filter(k => row[k] !== undefined);
      const cols = keys.join(',');
      const vals = keys.map((_, i) => `$${i + 1}`).join(',');
      const updateSet = keys.map((k, i) => `${k} = $${i + 1}`).join(',');
      await query(`INSERT INTO dapp_white_label (${cols}) VALUES (${vals}) ON CONFLICT (id) DO UPDATE SET ${updateSet}, updated_at = NOW() RETURNING *`,
        [...keys.map(k => row[k]), ...keys.map(k => row[k])]);
    }, () => { memory.whiteLabel.set(row.id, row); });
    return row;
  }
}

module.exports = { DappEngine };
