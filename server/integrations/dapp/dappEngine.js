'use strict';

const { SafeEngine } = require('./safeEngine');
const { getConfig } = require('./config');
const { SourceOfFundsAdapter } = require('../stablecoin/sourceOfFundsAdapter');
const { getTrusteeByEmail } = require('./trustees');
const { JWT_SECRET } = require('../auth/userAuth');

let CashEngine, TrustAccountingEngine, BondEngine, FineractClient, CrmEngine, TaxEngine, DocumentEngine, SubLedgerEngine, EmailEngine;
try { EmailEngine = require('./emailEngine').EmailEngine; } catch (e) { }
try { CashEngine = require('../cash/cashEngine').CashEngine; } catch (e) { }
try { TrustAccountingEngine = require('../accounting/trustAccountingEngine').TrustAccountingEngine; } catch (e) { }
try { BondEngine = require('../bonds/bondEngine').BondEngine; } catch (e) { }
try { FineractClient = require('../fineract/fineractClient').FineractClient; } catch (e) { }
try { CrmEngine = require('../crm/crmEngine').CrmEngine; } catch (e) { }
try { TaxEngine = require('../tax/taxEngine').TaxEngine; } catch (e) { }
try { DocumentEngine = require('../documents/documentEngine').DocumentEngine; } catch (e) { }
try { SubLedgerEngine = require('../accounting/subLedgerEngine').SubLedgerEngine; } catch (e) { }

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

let viem;
try { viem = require('viem'); } catch (e) { }

let BondTokenizationEngine;
try { BondTokenizationEngine = require('./bondTokenizationEngine').BondTokenizationEngine; } catch (e) { }

const https = require('https');
const { URL } = require('url');
let jwt;
try { jwt = require('jsonwebtoken'); } catch (e) { }

const memory = { safes: new Map(), payouts: new Map(), deposits: new Map(), distributions: new Map(), whiteLabel: new Map(), users: new Map() };

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

function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({ hostname: u.hostname, path: `${u.pathname}${u.search}`, port: u.port || 443, headers: { 'Accept': 'application/json', ...(options.headers || {}) } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(options.timeout || 15000, () => { req.destroy(); reject(new Error('HTTP timeout')); });
  });
}

const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
];

function evmPublicClient(cfg) {
  if (!viem) throw new Error('viem not installed');
  const chains = require('viem/chains');
  const chain = cfg.chainId === 1 ? chains.mainnet
    : (cfg.chainId === 11155111 ? chains.sepolia
    : { id: cfg.chainId, name: 'custom', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } });
  return viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) });
}

function normalizeHexAddress(addr) {
  if (!addr || typeof addr !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(addr)) throw new Error('invalid EVM address');
  return addr.toLowerCase();
}

function hederaMirrorBase() {
  const base = (process.env.HEDERA_MIRROR_NODE || 'https://mainnet.mirrornode.hedera.com/api/v1/').trim();
  return base.replace(/\/$/, '') + '/';
}

function hederaNetworkName() {
  return (process.env.HEDERA_NETWORK || 'mainnet').toLowerCase();
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
          safe_id TEXT REFERENCES dapp_safes(id) ON DELETE CASCADE,
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
      await query(`ALTER TABLE dapp_payouts ALTER COLUMN safe_id DROP NOT NULL;`);

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

      await query(`
        CREATE TABLE IF NOT EXISTS dapp_users (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE,
          phone TEXT,
          name TEXT,
          role TEXT NOT NULL DEFAULT 'beneficiary',
          roles JSONB DEFAULT '["beneficiary"]',
          active_role TEXT,
          wallet_address TEXT,
          safe_owner_address TEXT,
          linked_wallet_provider TEXT,
          verified BOOLEAN NOT NULL DEFAULT false,
          is_active BOOLEAN NOT NULL DEFAULT true,
          otp_code TEXT,
          otp_expires TIMESTAMPTZ,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      // Migrate existing dapp_users tables that predate the RBAC columns.
      await query(`ALTER TABLE dapp_users ADD COLUMN IF NOT EXISTS roles JSONB DEFAULT '["beneficiary"]'`);
      await query(`ALTER TABLE dapp_users ADD COLUMN IF NOT EXISTS active_role TEXT`);
      await query(`ALTER TABLE dapp_users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true`);
      await query(`ALTER TABLE dapp_users DROP CONSTRAINT IF EXISTS dapp_users_role_check`);
    }, () => { /* memory fallback */ });
  }

  static _memKey(table) {
    const map = { dapp_safes: 'safes', dapp_payouts: 'payouts', dapp_deposits: 'deposits', dapp_distributions: 'distributions', dapp_white_label: 'whiteLabel', dapp_users: 'users' };
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

  // ─── Payouts with 2-signature Safe approval ─────────────────────────────────────
  static async createPayout({ safeId, type = 'payout', destination, value, token, tokenAmount, description, sourceType, sourceAccountId, amountUsd } = {}) {
    if (!safeId || !destination) throw new Error('safeId and destination required');
    if (!value && !tokenAmount && !amountUsd) throw new Error('value, tokenAmount or amountUsd required');
    const cfg = getConfig();
    const safe = await this.getSafe(safeId);
    if (safe.status !== 'deployed') throw new Error('Safe must be deployed before payouts');

    let amountCents = 0;
    let resolvedAmountUsd = amountUsd;
    if (resolvedAmountUsd) {
      amountCents = Math.round(Number(resolvedAmountUsd) * 100);
      if (!token) token = cfg.usdcAddress;
      if (!tokenAmount) tokenAmount = String(Math.round(Number(resolvedAmountUsd) * 1e6));
      if (!value) value = '0';
    } else if (tokenAmount && token === cfg.usdcAddress) {
      resolvedAmountUsd = (Number(tokenAmount) / 1e6).toFixed(2);
      amountCents = Math.round(Number(resolvedAmountUsd) * 100);
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

    const metadata = { safeTx: safeTx.data, proposer, amountUsd: resolvedAmountUsd, amountCents, sourceRef: reserve };
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

    // Direct payouts are already executed; approval is a no-op record.
    if (!payout.safe_id) {
      const metadata = jsonbValue(payout.metadata || '{}') || {};
      metadata.approval = { signature, signerAddress, at: new Date().toISOString() };
      await this._update('dapp_payouts', payoutId, { status: 'executed', metadata: JSON.stringify(metadata) });
      return { ...payout, status: 'executed', metadata: JSON.stringify(metadata) };
    }

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

    // Direct payouts are already executed on creation; just mark completed.
    if (!payout.safe_id) {
      if (payout.tx_hash) return { ...payout, txHash: payout.tx_hash, direct: true };
      throw new Error('Direct payout has no tx_hash');
    }

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
  static async createDistribution({ safeId, name, asset = 'USDC', totalAmount, beneficiaries, sourceType, sourceAccountId } = {}) {
    if (!safeId) throw new Error('safeId required for Safe-governed distribution');
    if (!Array.isArray(beneficiaries) || !beneficiaries.length) throw new Error('beneficiaries required');
    const id = identifier('DIS');
    const totalUsd = beneficiaries.reduce((s, b) => s + (Number(b.amountUsd) || 0), 0);
    const dist = {
      id, safe_id: safeId || null, name: name || `Distribution ${id}`, asset,
      total_amount: String(totalAmount || totalUsd),
      beneficiaries: JSON.stringify(beneficiaries), status: 'pending',
      source_type: sourceType || null,
      source_account_id: sourceAccountId || null,
    };
    await this._insert('dapp_distributions', dist);

    // Create child payout records for each beneficiary (direct if no deployed Safe)
    for (const b of beneficiaries) {
      await this.createPayout({
        safeId: safeId || undefined, type: 'distribution_item', destination: b.address,
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
      if (rows.rows.length) return rows.rows[0];
      return { id: 'default', slug: 'default', name: 'Sovereign Trust', primary_color: '#3b82f6', secondary_color: '#2563eb', logo_url: '', favicon_url: '', contact_email: '' };
    }, () => {
      for (const v of memory.whiteLabel.values()) if (v.id === idOrSlug || v.slug === idOrSlug) return v;
      return { id: 'default', slug: 'default', name: 'Sovereign Trust', primary_color: '#3b82f6', secondary_color: '#2563eb', logo_url: '', favicon_url: '', contact_email: '' };
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
          const trustContactId = a.linked_cash_account ? a.linked_cash_account.replace(/^CA-/, '') : null;
          push('trust', a.account_code, a.account_name || a.account_code, bal, 'USD', { account_type: a.account_type, sub_type: a.sub_type, contact_id: trustContactId });
        }
      }
    } catch (e) { }

    try {
      if (BondEngine) {
        const bonds = await BondEngine.listBonds();
        for (const b of bonds) {
          const bal = await SourceOfFundsAdapter.getBalance({ sourceType: 'bond', sourceAccountId: String(b.id) }).catch(() => 0);
          const accruedCents = Math.round(Number(b.accrued_interest || 0) * 100);
          push('bond', String(b.id), b.bond_name || b.isin || `Bond ${b.id}`, bal, b.currency || 'USD', { isin: b.isin, status: b.status, accrued_interest_cents: accruedCents });
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
      if (SubLedgerEngine) {
        const ledgers = await SubLedgerEngine.listSubLedgers({ status: 'active' });
        for (const sl of ledgers) {
          const bal = await SourceOfFundsAdapter.getBalance({ sourceType: 'sub_ledger', sourceAccountId: sl.sub_ledger_id }).catch(() => 0);
          balances.push({ type: 'sub_ledger', id: sl.sub_ledger_id, name: `${sl.sub_account_name} (${sl.parent_account_code})`, balance_cents: Number(bal) || 0, currency: sl.currency || 'USD', contact_id: sl.contact_id, parent_account_code: sl.parent_account_code, sub_account_type: sl.sub_account_type });
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

  // ─── dApp Users / Identity (email/phone login) ─────────────────────────────────
  static async createUser({ email, phone, name, role, roles = [], activeRole, walletAddress, safeOwnerAddress, provider, isActive = true, metadata = {} } = {}) {
    if (!email && !phone) throw new Error('email or phone required');
    if (email) {
      const existing = await this.getUserByEmail(email).catch(() => null);
      if (existing) throw new Error('User with this email already exists');
    }
    const inferred = roles && roles.length ? roles : (role ? [role] : []);
    const resolvedRoles = inferred.length ? inferred : this.inferRoles(email);
    const primaryRole = activeRole || role || resolvedRoles[0] || 'beneficiary';
    const id = identifier('USR');
    const row = {
      id, email: email || null, phone: phone || null, name: name || null,
      role: primaryRole,
      roles: JSON.stringify(resolvedRoles),
      active_role: activeRole || primaryRole,
      wallet_address: walletAddress || null,
      safe_owner_address: safeOwnerAddress || null,
      linked_wallet_provider: provider || null,
      verified: false, is_active: isActive, metadata: JSON.stringify(metadata),
    };
    await this._insert('dapp_users', row);
    return row;
  }

  static async getUser(id) { return this._sanitizeUser(await this._selectOne('dapp_users', id)); }
  static async listUsers() {
    const rows = await this._selectAll('dapp_users');
    return rows.map(u => this._sanitizeUser(u));
  }

  static async getUserByEmail(email) {
    const lower = String(email || '').toLowerCase();
    return withFallback(async () => {
      const rows = await query('SELECT * FROM dapp_users WHERE LOWER(email) = LOWER($1) LIMIT 1', [lower]);
      if (!rows.rows.length) throw new Error('User not found');
      return rows.rows[0];
    }, () => {
      for (const u of memory.users.values()) if (String(u.email || '').toLowerCase() === lower) return u;
      throw new Error('User not found');
    });
  }

  static inferRoles(email) {
    const trustee = getTrusteeByEmail(email);
    if (trustee) {
      const lower = String(trustee.role).toLowerCase();
      if (lower === 'administration') return ['trustee_admin', 'beneficiary'];
      if (lower === 'distribution' || lower === 'maker') return ['trustee_maker', 'beneficiary'];
      if (lower === 'checker') return ['trustee_checker', 'beneficiary'];
      return ['trustee', 'beneficiary'];
    }
    return ['beneficiary'];
  }

  static inferRole(email) {
    return this.inferRoles(email)[0];
  }

  static async generateOtp(email) {
    let user = await this.getUserByEmail(email).catch(() => null);
    const roles = this.inferRoles(email);
    const role = roles[0];
    if (!user) {
      user = await this.createUser({ email, name: email.split('@')[0], role, roles });
    } else {
      const existingRoles = Array.isArray(user.roles) ? user.roles : (user.roles ? JSON.parse(user.roles) : [user.role || 'beneficiary']);
      const merged = Array.from(new Set([...existingRoles, ...roles]));
      const primary = user.active_role || user.role || merged[0];
      await this._update('dapp_users', user.id, { role: primary, roles: JSON.stringify(merged) });
      user.role = primary;
      user.roles = merged;
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await this._update('dapp_users', user.id, { otp_code: code, otp_expires: expires });

    let emailStatus = { sent: false, note: 'No email provider configured' };
    if (EmailEngine) {
      try {
        emailStatus = await EmailEngine.sendOtp({ to: email, name: user.name || email, otp: code, action: 'login' });
      } catch (e) { console.warn('[DappEngine] OTP email failed:', e.message); }
    }

    const showCodeInResponse = process.env.NODE_ENV !== 'production'
      && process.env.DAPP_OTP_ALWAYS_SHOW_CODE === 'true';
    if (!emailStatus.sent && !showCodeInResponse) {
      throw new Error("We couldn't deliver your PIN. Contact the administrator.");
    }
    return { email, code: showCodeInResponse ? code : null, expires, role, roles, sent: emailStatus.sent, provider: emailStatus.provider, message: emailStatus.note || 'OTP generated' };
  }

  static _sanitizeUser(user) {
    if (!user) return user;
    const u = { ...user };
    delete u.otp_code;
    delete u.otp_expires;
    if (typeof u.roles === 'string') { try { u.roles = JSON.parse(u.roles); } catch { u.roles = [u.role || 'beneficiary']; } }
    if (!Array.isArray(u.roles)) u.roles = [u.role || 'beneficiary'];
    return u;
  }

  static async verifyOtp({ email, code } = {}) {
    const user = await this.getUserByEmail(email);
    if (user.is_active === false) throw new Error('Account is disabled. Contact administrator.');
    const now = new Date();
    if (String(user.otp_code || '').trim() !== String(code).trim()) throw new Error('Invalid code');
    if (!user.otp_expires || new Date(user.otp_expires) < now) throw new Error('Code expired');
    await this._update('dapp_users', user.id, { verified: true, otp_code: null, otp_expires: null });
    const sanitized = this._sanitizeUser(await this.getUser(user.id));
    const secret = JWT_SECRET || process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is not configured');
    const token = jwt ? jwt.sign({ userId: sanitized.id, email: sanitized.email, role: sanitized.role, roles: sanitized.roles, tokenId: identifier('DSE') }, secret, { expiresIn: '8h' }) : null;
    return { ...sanitized, token, tokenExpiresAt: token ? new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString() : null };
  }

  static async linkWallet({ email, walletAddress, provider, safeOwnerAddress } = {}) {
    const user = await this.getUserByEmail(email);
    const updates = {};
    if (walletAddress) updates.wallet_address = walletAddress;
    if (provider) updates.linked_wallet_provider = provider;
    if (safeOwnerAddress) updates.safe_owner_address = safeOwnerAddress;
    await this._update('dapp_users', user.id, updates);
    return this._sanitizeUser(await this.getUser(user.id));
  }

  static async switchActiveRole({ email, activeRole } = {}) {
    const user = await this.getUserByEmail(email);
    const roles = Array.isArray(user.roles) ? user.roles : (user.roles ? JSON.parse(user.roles) : [user.role || 'beneficiary']);
    if (!roles.includes(activeRole)) throw new Error(`Role ${activeRole} is not assigned to this user`);
    await this._update('dapp_users', user.id, { active_role: activeRole, role: activeRole });
    return this._sanitizeUser(await this.getUser(user.id));
  }

  static async setUserRoles({ email, roles = [], activeRole } = {}) {
    const user = await this.getUserByEmail(email);
    if (!Array.isArray(roles) || roles.length === 0) throw new Error('roles array required');
    const primary = activeRole || roles[0];
    await this._update('dapp_users', user.id, { roles: JSON.stringify(roles), active_role: primary, role: primary });
    return this._sanitizeUser(await this.getUser(user.id));
  }

  static async setUserActive(email, isActive) {
    const user = await this.getUserByEmail(email);
    await this._update('dapp_users', user.id, { is_active: isActive });
    return this._sanitizeUser(await this.getUser(user.id));
  }

  static async ensurePortalUsers() {
    const seeded = [
      // Barkley Family Trust PTC: maker + checker trustees and 3 beneficiaries
      { email: 'barkley420lavar@gmail.com', name: 'Malissa Robinson', roles: ['trustee_maker', 'beneficiary'], activeRole: 'trustee_maker' },
      { email: 'dbarkley1130@gmail.com', name: 'DeAndrea Barkley', roles: ['trustee_checker', 'beneficiary'], activeRole: 'trustee_checker' },
      { email: 'deandreabarkley13@gmail.com', name: 'DeAndrea L Barkley', roles: ['beneficiary'], activeRole: 'beneficiary' },
      { email: 'annrobinson9800@yahoo.com', name: 'Malissa A Robinson', roles: ['beneficiary'], activeRole: 'beneficiary' },
      { email: 'robinsonjeremy22a@gmail.com', name: 'Jeremy N Robinson', roles: ['beneficiary'], activeRole: 'beneficiary' },
    ];
    const results = [];
    for (const s of seeded) {
      let user = await this.getUserByEmail(s.email).catch(() => null);
      if (!user) {
        user = await this.createUser({ email: s.email, name: s.name, roles: s.roles, activeRole: s.activeRole });
      } else {
        const existingRoles = Array.isArray(user.roles) ? user.roles : (user.roles ? JSON.parse(user.roles) : [user.role || 'beneficiary']);
        const merged = Array.from(new Set([...existingRoles, ...s.roles]));
        const primary = s.activeRole || user.active_role || merged[0];
        await this._update('dapp_users', user.id, { role: primary, active_role: primary, roles: JSON.stringify(merged), name: s.name });
        user = await this.getUser(user.id);
      }
      results.push(this._sanitizeUser(user));
    }
    return results;
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Wallet balances & activity (MetaMask / any address)
  // ═════════════════════════════════════════════════════════════════════════════

  static async getWalletBalances({ chain, address } = {}) {
    if (!address) throw new Error('address is required');
    const chainNorm = String(chain || 'evm').toLowerCase();
    if (chainNorm === 'hedera' || chainNorm === '295') return this._getHederaBalances(address);
    return this._getEvmBalances(address);
  }

  static async getWalletActivity({ chain, address } = {}) {
    if (!address) throw new Error('address is required');
    const chainNorm = String(chain || 'evm').toLowerCase();
    if (chainNorm === 'hedera' || chainNorm === '295') return this._getHederaActivity(address);
    return this._getEvmActivity(address);
  }

  static async _getEvmBalances(address) {
    const cfg = getConfig();
    if (!viem) throw new Error('viem not installed');
    const normalized = normalizeHexAddress(address);
    const publicClient = evmPublicClient(cfg);

    const [ethWei, usdcRaw] = await Promise.all([
      publicClient.getBalance({ address: normalized }),
      publicClient.readContract({ address: cfg.usdcAddress, abi: erc20Abi, functionName: 'balanceOf', args: [normalized] }).catch(() => 0n),
    ]);

    let dlbusd = null;
    try {
      if (BondTokenizationEngine) {
        const token = await BondTokenizationEngine.getTokenBySymbol('DLBUSD');
        const tokenMeta = token && token.metadata ? jsonbValue(token.metadata) : {};
        const tokenChain = Number(tokenMeta.chainId || tokenMeta.chain_id || cfg.chainId);
        if (token && token.token_address && !token.token_address.startsWith('shadow-') && tokenChain === cfg.chainId) {
          const [raw, decimals] = await Promise.all([
            publicClient.readContract({ address: token.token_address, abi: erc20Abi, functionName: 'balanceOf', args: [normalized] }),
            publicClient.readContract({ address: token.token_address, abi: erc20Abi, functionName: 'decimals' }).catch(() => 6),
          ]);
          dlbusd = { tokenAddress: token.token_address, balance: viem.formatUnits(raw, decimals || 6) };
        }
      }
    } catch (e) { /* optional */ }

    return {
      chain: cfg.chainId,
      rpcUrl: cfg.rpcUrl.replace(/\/v2\/[^\/]+/, '/v2/[hidden]'),
      address: normalized,
      native: { symbol: cfg.nativeTokenSymbol || 'ETH', balance: viem.formatEther(ethWei) },
      usdc: { symbol: 'USDC', tokenAddress: cfg.usdcAddress, balance: viem.formatUnits(usdcRaw, 6) },
      dlbusd,
    };
  }

  static async _getEvmActivity(address) {
    const normalized = normalizeHexAddress(address);
    const cfg = getConfig();
    const items = [];

    // Internal dApp activity
    if (pool) {
      try {
        const [payoutRows, depositRows, distributionRows] = await Promise.all([
          pool.query("SELECT id, type, destination, value, token, status, tx_hash, source_type, source_account_id, created_at FROM dapp_payouts WHERE destination ILIKE $1 ORDER BY created_at DESC LIMIT 50", [normalized]),
          pool.query("SELECT id, asset, amount, from_address, tx_hash, status, created_at FROM dapp_deposits WHERE from_address ILIKE $1 ORDER BY created_at DESC LIMIT 50", [normalized]),
          pool.query("SELECT id, name, asset, total_amount, beneficiaries, status, tx_hash, source_type, source_account_id, created_at FROM dapp_distributions WHERE beneficiaries::text ILIKE $1 ORDER BY created_at DESC LIMIT 50", [normalized]),
        ]);
        for (const r of payoutRows.rows) items.push({ type: 'payout', ...r });
        for (const r of depositRows.rows) items.push({ type: 'deposit', ...r });
        for (const r of distributionRows.rows) items.push({ type: 'distribution', ...r });
      } catch (e) { console.warn('[wallet-activity] DB query failed', e.message); }
    }

    // On-chain transfers via Alchemy
    try {
      const alchemyUrl = cfg.rpcUrl;
      if (alchemyUrl && alchemyUrl.includes('alchemy.com')) {
        const transfers = await this._alchemyTransfers(alchemyUrl, normalized);
        for (const t of transfers) items.push({ type: 'chain_transfer', ...t });
      }
    } catch (e) { console.warn('[wallet-activity] Alchemy transfers failed', e.message); }

    items.sort((a, b) => new Date(b.created_at || b.timestamp || 0) - new Date(a.created_at || a.timestamp || 0));
    return { chain: cfg.chainId, address: normalized, items: items.slice(0, 50) };
  }

  static async _alchemyTransfers(alchemyUrl, address) {
    const results = [];
    const categories = ['external', 'erc20', 'erc721', 'erc1155'];
    const directions = [
      { fromAddress: address },
      { toAddress: address },
    ];
    for (const dir of directions) {
      const body = {
        jsonrpc: '2.0', id: 1,
        method: 'alchemy_getAssetTransfers',
        params: [{
          fromBlock: '0x0',
          toBlock: 'latest',
          category: categories,
          withMetadata: true,
          maxCount: '0x19',
          order: 'descending',
          ...dir,
        }],
      };
      const data = await this._rpcPost(alchemyUrl, body);
      if (data && Array.isArray(data.result && data.result.transfers)) {
        for (const t of data.result.transfers) {
          results.push({
            hash: t.hash,
            from: t.from,
            to: t.to,
            value: t.value,
            asset: t.asset || t.tokenId || 'ETH',
            category: t.category,
            direction: dir.fromAddress ? 'out' : 'in',
            timestamp: t.metadata ? t.metadata.blockTimestamp : null,
            created_at: t.metadata ? t.metadata.blockTimestamp : null,
          });
        }
      }
    }
    return results;
  }

  static async _rpcPost(url, body) {
    const u = new URL(url);
    const postData = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = https.request({ hostname: u.hostname, path: `${u.pathname}${u.search}`, port: u.port || 443, method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' } }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(data); } });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  static async _getHederaBalances(address) {
    const normalized = normalizeHexAddress(address);
    const base = hederaMirrorBase();
    const data = await httpGet(`${base}accounts/${normalized}?timestamp=gt:0`);
    const notFound = (data._status && data._status.messages && data._status.messages.some(m => /not found/i.test(m.message)));
    if (notFound) {
      return {
        chain: 295,
        network: hederaNetworkName(),
        address: normalized,
        created: false,
        account: null,
        alias: null,
        evm_address: normalized,
        native: { symbol: 'HBAR', balance: 0 },
        tokens: [],
        note: 'This EVM address has not been auto-created on Hedera mainnet. Send at least 0.2 HBAR to create it.',
      };
    }
    const hbarBalance = data.balance ? Number(data.balance) / 1e8 : 0;
    const tokens = (data.tokens || []).map(t => ({
      token_id: t.token_id,
      balance: String(Number(t.balance) / Math.pow(10, t.decimals || 0)),
      raw_balance: t.balance,
      decimals: t.decimals,
    }));
    return {
      chain: 295,
      network: hederaNetworkName(),
      address: normalized,
      created: true,
      account: data.account || null,
      alias: data.alias || null,
      evm_address: data.evm_address || normalized,
      native: { symbol: 'HBAR', balance: hbarBalance },
      tokens,
    };
  }

  static async _getHederaActivity(address) {
    const normalized = normalizeHexAddress(address);
    const base = hederaMirrorBase();
    const [txData, account] = await Promise.all([
      httpGet(`${base}accounts/${normalized}/transactions?limit=25&order=desc`).catch(() => ({ transactions: [] })),
      httpGet(`${base}accounts/${normalized}?timestamp=gt:0`).catch(() => ({})),
    ]);
    const items = (txData.transactions || []).map(tx => ({
      type: 'hedera_transaction',
      name: tx.name,
      transaction_id: tx.transaction_id,
      consensus_timestamp: tx.consensus_timestamp,
      result: tx.result,
      charged_tx_fee: tx.charged_tx_fee,
      transfers: (tx.transfers || []).filter(tr => (tr.account === account.account) || (String(tr.account).includes(address.slice(2)))) || tx.transfers,
      created_at: tx.consensus_timestamp ? new Date(Number(tx.consensus_timestamp.split('.')[0]) * 1000).toISOString() : null,
    }));
    return { chain: 295, network: hederaNetworkName(), address: normalized, account: account.account || null, items };
  }
}

module.exports = { DappEngine };
