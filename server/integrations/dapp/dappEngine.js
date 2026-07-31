'use strict';

const { SafeEngine } = require('./safeEngine');
const { getConfig } = require('./config');
const { SourceOfFundsAdapter } = require('../stablecoin/sourceOfFundsAdapter');

let CashEngine, TrustAccountingEngine, BondEngine, FineractClient, CrmEngine, TaxEngine, DocumentEngine;
try { CashEngine = require('../cash/cashEngine').CashEngine; } catch (e) { }
try { TrustAccountingEngine = require('../accounting/trustAccountingEngine').TrustAccountingEngine; } catch (e) { }
try { BondEngine = require('../bonds/bondEngine').BondEngine; } catch (e) { }
try { FineractClient = require('../fineract/fineractClient').FineractClient; } catch (e) { }
try { CrmEngine = require('../crm/crmEngine').CrmEngine; } catch (e) { }
try { TaxEngine = require('../tax/taxEngine').TaxEngine; } catch (e) { }
try { DocumentEngine = require('../documents/documentEngine').DocumentEngine; } catch (e) { }

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
          source_type TEXT,
          source_account_id TEXT,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await query(`ALTER TABLE dapp_distributions ADD COLUMN IF NOT EXISTS source_type TEXT;`);
      await query(`ALTER TABLE dapp_distributions ADD COLUMN IF NOT EXISTS source_account_id TEXT;`);

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
  static async createPayout({ safeId, type = 'payout', destination, value, token, tokenAmount, description, sourceType, sourceAccountId, amountUsd } = {}) {
    if (!safeId || !destination) throw new Error('safeId and destination required');
    if (!value && !tokenAmount && !amountUsd) throw new Error('value, tokenAmount or amountUsd required');
    const safe = await this.getSafe(safeId);
    if (safe.status !== 'deployed') throw new Error('Safe must be deployed before payouts');
    const cfg = getConfig();

    let amountCents = 0;
    if (amountUsd) {
      amountCents = Math.round(Number(amountUsd) * 100);
      if (!token) token = cfg.usdcAddress;
      if (!tokenAmount) tokenAmount = String(Math.round(Number(amountUsd) * 1e6));
      if (!value) value = '0';
    }

    const id = identifier('PAY');
    let reserve = null;
    if (sourceType && amountCents > 0) {
      reserve = await SourceOfFundsAdapter.reserve({
        id,
        source_type: sourceType,
        source_account_id: sourceAccountId || '',
        total_cents: amountCents,
      });
    }

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

    const metadata = { safeTx: safeTx.data, proposer, amountUsd, amountCents, sourceRef: reserve };
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
      reserve_id: reserve ? reserve.reserveId : null,
      distribution_id: null,
      metadata: JSON.stringify(metadata),
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
    if (!signatures.find(s => s.signature === signature)) {
      signatures.push({ signer: recovered, signature, kind: 'approver' });
    }
    await this._update('dapp_payouts', payoutId, { signatures: JSON.stringify(signatures) });

    if (signatures.length >= safe.threshold) {
      const result = await SafeEngine.executeTransaction({ safeAddress: safe.safe_address, safeTx });
      const metadata = jsonbValue(payout.metadata || '{}') || {};
      metadata.result = result;
      await this._finalizeSource(payout, result.txHash, metadata);
      await this._update('dapp_payouts', payoutId, { status: 'executed', tx_hash: result.txHash, metadata: JSON.stringify(metadata) });
      payout.status = 'executed';
      payout.tx_hash = result.txHash;
      payout.metadata = JSON.stringify(metadata);
      return { ...payout, txHash: result.txHash, signatures };
    }

    await this._update('dapp_payouts', payoutId, { status: 'pending' });
    return { ...payout, status: 'pending', signatures, pendingApprovals: safe.threshold - signatures.length };
  }

  static _rebuildSafeTx(payout) {
    const metadata = jsonbValue(payout.metadata || '{}') || {};
    const txData = metadata.safeTx || {};
    const sigs = [];
    if (payout.server_signature) sigs.push({ signer: payout.proposer || metadata.proposer, signature: payout.server_signature });
    const stored = Array.isArray(payout.signatures) ? payout.signatures : (jsonbValue(payout.signatures || '[]') || []);
    for (const s of stored) {
      if (s && s.signature && !sigs.find(x => x.signature === s.signature)) sigs.push(s);
    }
    return SafeEngine.rebuildTransaction(txData, sigs);
  }

  static async _finalizeSource(payout, txHash, metadata) {
    if (!payout.reserve_id || !payout.source_type) return;
    const amountCents = metadata.amountCents || 0;
    const payment = {
      id: payout.id,
      source_type: payout.source_type,
      source_account_id: payout.source_account_id,
      reserve_id: payout.reserve_id,
      total_cents: amountCents,
      amount_cents: amountCents,
      source_ref: metadata.sourceRef || {},
      metadata: metadata.sourceRef || {},
    };
    try {
      const sourcePost = await SourceOfFundsAdapter.post(payment, txHash, { settledAmountCents: amountCents });
      metadata.sourcePost = sourcePost;
    } catch (err) {
      console.warn('[dappEngine] source post failed:', err.message);
      metadata.sourcePostError = err.message;
    }
    try {
      await SourceOfFundsAdapter.recordCrmAndDocuments({ ...payout, amount_cents: amountCents, asset_code: payout.token }, txHash);
    } catch (err) {
      console.warn('[dappEngine] CRM/document recording failed:', err.message);
    }
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
    const metadata2 = jsonbValue(payout.metadata || '{}') || {};
    metadata2.result = result;
    await this._finalizeSource(payout, result.txHash, metadata2);
    await this._update('dapp_payouts', payoutId, { status: 'executed', tx_hash: result.txHash, metadata: JSON.stringify(metadata2) });
    payout.status = 'executed';
    payout.tx_hash = result.txHash;
    payout.metadata = JSON.stringify(metadata2);
    return { ...payout, txHash: result.txHash };
  }

  static async getPayout(id) { return this._selectOne('dapp_payouts', id); }
  static async listPayouts() { return this._selectAll('dapp_payouts'); }

  // ─── Distributions ────────────────────────────────────────────────────────────
  static async createDistribution({ safeId, name, asset, totalAmount, beneficiaries, sourceType, sourceAccountId } = {}) {
    if (!safeId || !Array.isArray(beneficiaries) || !beneficiaries.length) throw new Error('safeId and beneficiaries required');
    const id = identifier('DIS');
    const safe = await this.getSafe(safeId);
    const totalUsd = beneficiaries.reduce((s, b) => s + (Number(b.amountUsd) || 0), 0);
    const dist = {
      id, safe_id: safeId, name: name || `Distribution ${id}`, asset,
      total_amount: String(totalAmount || totalUsd),
      beneficiaries: JSON.stringify(beneficiaries), status: 'pending',
      source_type: sourceType || null,
      source_account_id: sourceAccountId || null,
    };
    await this._insert('dapp_distributions', dist);

    // Create child payout records for each beneficiary
    for (const b of beneficiaries) {
      await this.createPayout({
        safeId, type: 'distribution_item', destination: b.address,
        value: b.value || '0', token: b.token, tokenAmount: b.tokenAmount,
        amountUsd: b.amountUsd,
        description: `Distribution ${id} to ${b.name || b.address}`,
        sourceType,
        sourceAccountId,
      });
    }
    return dist;
  }

  static async getDistribution(id) { return this._selectOne('dapp_distributions', id); }
  static async listDistributions() { return this._selectAll('dapp_distributions'); }

  // ─── P2P payments ───────────────────────────────────────────────────────────────
  static async createP2p({ safeId, destination, value, token, tokenAmount, description, sourceType, sourceAccountId, amountUsd } = {}) {
    return this.createPayout({ safeId, type: 'p2p', destination, value, token, tokenAmount, description, sourceType, sourceAccountId, amountUsd });
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

  // ─── Source of Funds bridge (legacy modules -> dApp stablecoin rails) ───────────
  static async listSourceBalances() {
    const balances = [];
    const push = (type, id, name, balance_cents, currency = 'USD', meta = {}) => {
      balances.push({ type, id, name, balance_cents: Number(balance_cents) || 0, currency, ...meta });
    };

    try {
      const bal = await SourceOfFundsAdapter.getBalance({ sourceType: 'treasury' });
      push('treasury', 'TREASURY_HOT', 'Treasury Hot', bal, 'USDC', { asset: 'USDC' });
    } catch (e) { /* optional */ }

    try {
      if (CashEngine) {
        const accts = await CashEngine.listAccounts({ status: 'active' });
        for (const a of accts) {
          const bal = await SourceOfFundsAdapter.getBalance({ sourceType: 'cash', sourceAccountId: a.account_id }).catch(() => 0);
          push('cash', a.account_id, a.account_name || a.account_id, bal, a.currency || 'USD', { account_type: a.account_type });
        }
      }
    } catch (e) { }

    try {
      if (TrustAccountingEngine) {
        const accts = await TrustAccountingEngine.listAccounts({ isActive: true });
        for (const a of accts) {
          const bal = await SourceOfFundsAdapter.getBalance({ sourceType: 'trust', sourceAccountId: a.account_code }).catch(() => 0);
          push('trust', a.account_code, a.account_name || a.account_code, bal, 'USD', { account_type: a.account_type, sub_type: a.sub_type });
        }
      }
    } catch (e) { }

    try {
      if (BondEngine) {
        const bonds = await BondEngine.listBonds();
        for (const b of bonds) {
          const bal = await SourceOfFundsAdapter.getBalance({ sourceType: 'bond', sourceAccountId: String(b.id) }).catch(() => 0);
          push('bond', String(b.id), b.bond_name || b.isin || `Bond ${b.id}`, bal, b.currency || 'USD', { isin: b.isin, status: b.status });
        }
      }
    } catch (e) { }

    try {
      if (FineractClient) {
        const savings = await FineractClient.listSavingsAccounts({ limit: 100 });
        const page = savings.pageItems || [];
        for (const acct of page) {
          const summary = await FineractClient.getAccountBalance(acct.id).catch(() => ({}));
          const bal = (summary.accountBalance || summary.balance || 0) * 100;
          push('core_banking', String(acct.id), acct.productName || acct.clientName || `Savings ${acct.id}`, bal, summary.currency?.code || 'USD', { clientId: acct.clientId });
        }
      }
    } catch (e) { }

    try {
      if (CrmEngine) {
        const contacts = await CrmEngine.listContacts({ status: 'active' });
        for (const c of contacts) {
          balances.push({ type: 'crm', id: c.contact_id, name: `${c.first_name || ''} ${c.last_name || ''}`.trim() || c.company || c.contact_id, balance_cents: 0, currency: 'USD', email: c.email, phone: c.phone, linked_wallet_id: c.linked_wallet_id });
        }
      }
    } catch (e) { }

    try {
      if (TaxEngine) {
        const dash = await TaxEngine.getDashboard();
        push('tax', 'trust_tax_reserve', 'Tax Reserve / Distributions', Math.round((dash.total_distributions || dash.estimated_payments || 0) * 100), 'USD', { tax_year: dash.tax_year });
      }
    } catch (e) { }

    try {
      if (DocumentEngine) {
        const stats = await DocumentEngine.getStats();
        push('documents', 'document_vault', 'Document Vault', (stats.total_documents || 0), 'count', stats);
      }
    } catch (e) { }

    return balances;
  }

  static async depositFromSource({ sourceType, sourceAccountId, safeId, asset, amount, memo }) {
    if (!sourceType || !amount) throw new Error('sourceType and amount required');
    const amountCents = Math.round((Number(amount) || 0) * 100);
    if (amountCents <= 0) throw new Error('amount must be positive');
    const depositId = identifier('DEP');

    // Sweep legacy fiat balance into the stablecoin treasury (real source-of-funds movement)
    const sweep = await SourceOfFundsAdapter._fundSourceToTreasury({
      sourceType,
      sourceAccountId,
      paymentId: depositId,
      amountCents,
    }).catch(err => {
      if (sourceType === 'treasury') {
        return { sourceType, sourceAccountId, skipped: true, reason: err.message };
      }
      throw err;
    });

    const cfg = getConfig();
    const row = {
      id: depositId,
      safe_id: safeId || null,
      asset: asset || cfg.nativeTokenSymbol || 'USDC',
      amount: String(amount),
      from_address: sourceAccountId || sourceType,
      tx_hash: `shadow-${Date.now()}`,
      status: 'confirmed',
      metadata: JSON.stringify({ sourceType, sourceAccountId, sweep }),
    };
    await this._insert('dapp_deposits', row);
    return row;
  }
}

module.exports = { DappEngine };
