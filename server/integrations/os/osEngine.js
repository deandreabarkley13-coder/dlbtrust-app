'use strict';

/**
 * OS Engines — unified operating-system layer for the treasury platform.
 *
 * Exposes eight domain engines (Bank, Treasury, Payment, Clearing, Settlement,
 * Compliance, Security, REST API) behind a common interface so they can be
 * wired, scripted, and monitored from a single endpoint tree:
 *
 *   GET  /api/os/:engine/status
 *   GET  /api/os/:engine/health
 *   GET  /api/os/:engine/list
 *   GET  /api/os/:engine/get/:eventId
 *   POST /api/os/:engine/process   { action, ...payload }
 *
 * Each engine logs every operation to the shared `os_events` table, falls back
 * to shadow/simulated mode when third-party credentials are missing, and
 * delegates to the existing domain-specific engines when they are configured.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const crypto = require('crypto');

function id(prefix = 'EVT') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function safeJson(obj) {
  try { return JSON.stringify(obj || {}, (k, v) => (typeof v === 'bigint' ? String(v) : v)); } catch { return '{}'; }
}

function toCents(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error('amount must be positive');
  return Math.round(n * 100);
}

async function query(text, params) {
  if (!pool) throw new Error('Postgres pool not available');
  return pool.query(text, params);
}

function tryRequire(mod) {
  try { return require(mod); } catch (e) { return null; }
}

// ─── Base Engine ──────────────────────────────────────────────────────────────

class BaseOSEngine {
  static get engineName() { return 'base'; }

  static async ensureTables() {
    if (!pool) return;
    await query(`
      CREATE TABLE IF NOT EXISTS os_events (
        event_id TEXT PRIMARY KEY,
        engine TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'completed',
        payload JSONB DEFAULT '{}',
        result JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_os_events_engine ON os_events(engine)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_os_events_action ON os_events(action)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_os_events_status ON os_events(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_os_events_created ON os_events(created_at DESC)`);
  }

  static async _log(action, payload, result, status = 'completed') {
    const eventId = id(`${this.engineName}-`);
    if (pool) {
      try {
        await query(
          `INSERT INTO os_events (event_id, engine, action, status, payload, result) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
          [eventId, this.engineName, action, status, safeJson(payload), safeJson(result)]
        );
      } catch (e) { console.warn(`[os-${this.engineName}] log failed:`, e.message); }
    }
    return { eventId, status, logged: !!pool };
  }

  static async status() {
    return {
      engine: this.engineName,
      healthy: true,
      mode: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString(),
    };
  }

  static async health() { return this.status(); }

  static async list({ limit = 50, status } = {}) {
    if (!pool) return [];
    let sql = 'SELECT event_id, engine, action, status, payload, result, created_at FROM os_events WHERE engine = $1';
    const params = [this.engineName];
    if (status) { sql += ` AND status = $${params.length + 1}`; params.push(status); }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    const res = await query(sql, params);
    return res.rows;
  }

  static async get(eventId) {
    if (!pool) return null;
    const res = await query('SELECT * FROM os_events WHERE event_id = $1 AND engine = $2', [eventId, this.engineName]);
    return res.rows[0] || null;
  }

  static async process(payload = {}) {
    const action = String(payload.action || 'noop');
    try {
      const result = await this._process(action, payload);
      const log = await this._log(action, payload, result, 'completed');
      return { success: true, engine: this.engineName, action, eventId: log.eventId, result };
    } catch (err) {
      await this._log(action, payload, { error: err.message }, 'failed').catch(() => {});
      const e = new Error(`${this.engineName}.${action} failed: ${err.message}`);
      e.status = err.status || 400;
      throw e;
    }
  }

  static async _process(action, payload) {
    return { note: `${this.engineName} ${action} processed` };
  }
}

// ─── Bank Engine ──────────────────────────────────────────────────────────────

class BankEngine extends BaseOSEngine {
  static get engineName() { return 'bank'; }

  static async status() {
    const BankSync = tryRequire('../finops/bankSyncEngine')?.BankSyncEngine;
    const TrustBank = tryRequire('../dapp/trustBankEngine')?.TrustBankEngine;
    const Corporate = tryRequire('../finops/corporateTreasuryEngine')?.CorporateTreasuryEngine;
    const bankSyncCfg = !!process.env.BANKSYNC_API_KEY;
    return {
      engine: 'bank',
      healthy: true,
      mode: bankSyncCfg ? 'live' : 'shadow',
      integrations: {
        banksync: bankSyncCfg && !!BankSync,
        trustBank: !!TrustBank,
        corporateTreasury: !!Corporate,
      },
      timestamp: new Date().toISOString(),
    };
  }

  static async _process(action, payload) {
    const BankSync = tryRequire('../finops/bankSyncEngine')?.BankSyncEngine;
    switch (action) {
      case 'sync':
        if (BankSync && process.env.BANKSYNC_API_KEY) return await BankSync.listBanks();
        return { mode: 'shadow', note: 'BANKSYNC_API_KEY not configured' };
      case 'listAccounts':
        if (BankSync && payload.bankId) return await BankSync.listAccounts(payload.bankId);
        return { mode: 'shadow', note: 'bankId required or BANKSYNC not configured' };
      case 'balance':
        if (BankSync && payload.bankId && payload.accountId) return await BankSync.getAccountBalance(payload.bankId, payload.accountId);
        return { mode: 'shadow', note: 'bankId and accountId required or BANKSYNC not configured' };
      case 'status':
      default:
        return await this.status();
    }
  }
}

// ─── Treasury Engine ──────────────────────────────────────────────────────────

class TreasuryEngine extends BaseOSEngine {
  static get engineName() { return 'treasury'; }

  static async status() {
    const Corp = tryRequire('../finops/corporateTreasuryEngine')?.CorporateTreasuryEngine;
    const StableTreasury = tryRequire('../stablecoin/treasuryEngine')?.TreasuryEngine;
    return {
      engine: 'treasury',
      healthy: true,
      mode: process.env.TREASURY_SHADOW === 'false' ? 'live' : 'shadow',
      integrations: { corporateTreasury: !!Corp, stablecoinTreasury: !!StableTreasury },
      timestamp: new Date().toISOString(),
    };
  }

  static async _process(action, payload) {
    const Corp = tryRequire('../finops/corporateTreasuryEngine')?.CorporateTreasuryEngine;
    const StableTreasury = tryRequire('../stablecoin/treasuryEngine')?.TreasuryEngine;
    switch (action) {
      case 'position':
        if (Corp && payload.accountId) return await Corp.getPosition(payload.accountId);
        if (StableTreasury) return await StableTreasury.getPosition(payload.accountId);
        return { mode: 'shadow', note: 'Treasury engines not configured' };
      case 'sweep':
        if (Corp) return await Corp.sweep(payload.poolId || 'default', payload.amount);
        return { mode: 'shadow', note: 'CorporateTreasuryEngine not available' };
      case 'reserve':
        if (StableTreasury) return await StableTreasury.hold(payload.paymentId || id('PMT-'), payload.accountId || 'TREASURY_HOT', toCents(payload.amount));
        return { mode: 'shadow', note: 'Stablecoin treasury not available' };
      case 'release':
        if (StableTreasury && payload.reserveId) return await StableTreasury.release(payload.reserveId);
        return { mode: 'shadow', note: 'reserveId required or treasury not available' };
      case 'post':
        if (StableTreasury && payload.reserveId) {
          return await StableTreasury.post(payload.reserveId, payload.txHash, { settledAmountCents: payload.settledAmount ? toCents(payload.settledAmount) : undefined });
        }
        return { mode: 'shadow', note: 'reserveId and txHash required' };
      case 'status':
      default:
        return await this.status();
    }
  }
}

// ─── Payment Engine ───────────────────────────────────────────────────────────

class PaymentEngine extends BaseOSEngine {
  static get engineName() { return 'payment'; }

  static async status() {
    const Gateway = tryRequire('../payments/paymentGatewayServerEngine')?.PaymentGatewayServerEngine;
    const Processor = tryRequire('../payments/paymentProcessorServerEngine')?.PaymentProcessorServerEngine;
    return {
      engine: 'payment',
      healthy: true,
      mode: (Gateway || Processor) ? 'ready' : 'shadow',
      integrations: { gateway: !!Gateway, processor: !!Processor },
      timestamp: new Date().toISOString(),
    };
  }

  static async _process(action, payload) {
    const Gateway = tryRequire('../payments/paymentGatewayServerEngine')?.PaymentGatewayServerEngine;
    switch (action) {
      case 'tokenize':
        if (Gateway) return await Gateway.tokenizePaymentMethod({
          type: payload.type,
          processor: payload.processor,
          payload: payload.payload,
          billingDetails: payload.billingDetails,
          memberId: payload.memberId,
          initiatedBy: payload.initiatedBy,
        });
        return { mode: 'shadow', note: 'PaymentGatewayServerEngine not available' };
      case 'authorize':
        if (Gateway) return await Gateway.authorize({
          sessionId: payload.sessionId,
          amount: payload.amount,
          currency: payload.currency,
          methodId: payload.methodId,
          reference: payload.reference,
          direction: payload.direction,
          source: payload.source,
          destination: payload.destination,
          metadata: payload.metadata,
          initiatedBy: payload.initiatedBy,
        });
        return { mode: 'shadow', note: 'PaymentGatewayServerEngine not available' };
      case 'sale':
        if (Gateway) return await Gateway.sale({
          amount: payload.amount,
          currency: payload.currency,
          methodId: payload.methodId,
          reference: payload.reference,
          direction: payload.direction,
          source: payload.source,
          destination: payload.destination,
          processor: payload.processor,
          metadata: payload.metadata,
          initiatedBy: payload.initiatedBy,
        });
        return { mode: 'shadow', note: 'PaymentGatewayServerEngine not available' };
      case 'capture':
        if (Gateway && payload.gatewayTxId) return await Gateway.capture({ gatewayTxId: payload.gatewayTxId, amount: payload.amount, initiatedBy: payload.initiatedBy });
        return { mode: 'shadow', note: 'gatewayTxId required or gateway not available' };
      case 'refund':
        if (Gateway && payload.gatewayTxId) return await Gateway.refund({ gatewayTxId: payload.gatewayTxId, amount: payload.amount, initiatedBy: payload.initiatedBy, reason: payload.reason });
        return { mode: 'shadow', note: 'gatewayTxId required or gateway not available' };
      case 'void':
        if (Gateway && payload.gatewayTxId) return await Gateway.void({ gatewayTxId: payload.gatewayTxId, initiatedBy: payload.initiatedBy, reason: payload.reason });
        return { mode: 'shadow', note: 'gatewayTxId required or gateway not available' };
      case 'listMethods':
        if (Gateway) return await Gateway.listMethods({ memberId: payload.memberId, type: payload.type, processor: payload.processor, limit: payload.limit });
        return { mode: 'shadow', note: 'PaymentGatewayServerEngine not available' };
      case 'listTx':
        if (Gateway) return await Gateway.list({ status: payload.status, methodId: payload.methodId, type: payload.type, limit: payload.limit });
        return { mode: 'shadow', note: 'PaymentGatewayServerEngine not available' };
      case 'status':
      default:
        return await this.status();
    }
  }
}

// ─── Clearing Engine ──────────────────────────────────────────────────────────

class ClearingEngine extends BaseOSEngine {
  static get engineName() { return 'clearing'; }

  static async status() {
    const ClearingApi = tryRequire('../payments/clearingApiEngine')?.ClearingApiEngine;
    const ClearingSettle = tryRequire('../stablecoin/clearingAndSettlementEngine')?.ClearingAndSettlementEngine;
    return {
      engine: 'clearing',
      healthy: true,
      mode: (ClearingApi || ClearingSettle) ? 'ready' : 'shadow',
      integrations: { clearingApi: !!ClearingApi, clearingAndSettlement: !!ClearingSettle },
      timestamp: new Date().toISOString(),
    };
  }

  static async _process(action, payload) {
    const ClearingApi = tryRequire('../payments/clearingApiEngine')?.ClearingApiEngine;
    switch (action) {
      case 'submit':
        if (ClearingApi) return await ClearingApi.submit({
          direction: payload.direction,
          rail: payload.rail,
          amount: payload.amount,
          currency: payload.currency,
          sourceAccountId: payload.sourceAccountId,
          destination: payload.destination,
          reference: payload.reference,
          metadata: payload.metadata,
          initiatedBy: payload.initiatedBy,
        });
        return { mode: 'shadow', note: 'ClearingApiEngine not available' };
      case 'get':
        if (ClearingApi && payload.clearingId) return await ClearingApi.getStatus(payload.clearingId);
        return { mode: 'shadow', note: 'clearingId required or engine not available' };
      case 'list':
        if (ClearingApi) return await ClearingApi.list({ direction: payload.direction, status: payload.status, rail: payload.rail, limit: payload.limit });
        return { mode: 'shadow', note: 'ClearingApiEngine not available' };
      case 'reconcile':
        if (ClearingApi) return await ClearingApi.reconcileFromWebhook(payload);
        return { mode: 'shadow', note: 'ClearingApiEngine not available' };
      case 'status':
      default:
        return await this.status();
    }
  }
}

// ─── Settlement Engine ──────────────────────────────────────────────────────────

class SettlementEngine extends BaseOSEngine {
  static get engineName() { return 'settlement'; }

  static async status() {
    const Settle = tryRequire('../dapp/settlementEngine')?.SettlementEngine;
    const DepositSettle = tryRequire('../payments/depositAndSettlementEngine')?.DepositAndSettlementEngine;
    const Electronic = tryRequire('../payments/electronicSettlementEngine')?.ElectronicSettlementEngine;
    return {
      engine: 'settlement',
      healthy: true,
      mode: (Settle || DepositSettle || Electronic) ? 'ready' : 'shadow',
      integrations: { settlement: !!Settle, depositAndSettlement: !!DepositSettle, electronicSettlement: !!Electronic },
      timestamp: new Date().toISOString(),
    };
  }

  static async _process(action, payload) {
    const Settle = tryRequire('../dapp/settlementEngine')?.SettlementEngine;
    switch (action) {
      case 'submit':
        if (Settle) return await Settle.createSettlement(payload);
        return { mode: 'shadow', note: 'SettlementEngine not available' };
      case 'get':
        if (Settle && payload.settlementId) return await Settle.getSettlement(payload.settlementId);
        return { mode: 'shadow', note: 'settlementId required or engine not available' };
      case 'list':
        if (Settle) return await Settle.listSettlements({ status: payload.status, rail: payload.rail, limit: payload.limit });
        return { mode: 'shadow', note: 'SettlementEngine not available' };
      case 'execute':
        if (Settle && payload.settlementId) return await Settle.executeSettlement(payload.settlementId);
        return { mode: 'shadow', note: 'settlementId required or engine not available' };
      case 'reconcile':
        if (Settle && payload.settlementId) return await Settle.reconcile(payload.settlementId, payload.txHash, payload.settledAmountCents);
        return { mode: 'shadow', note: 'settlementId required or engine not available' };
      case 'status':
      default:
        return await this.status();
    }
  }
}

// ─── Compliance Engine ─────────────────────────────────────────────────────────

class ComplianceEngine extends BaseOSEngine {
  static get engineName() { return 'compliance'; }

  static async status() {
    const Compliance = tryRequire('../compliance/complianceEngine')?.ComplianceEngine;
    return {
      engine: 'compliance',
      healthy: true,
      mode: Compliance ? 'ready' : 'shadow',
      sanctionedCount: (process.env.COMPLIANCE_SANCTIONED_NAMES || '').split(',').filter(Boolean).length,
      timestamp: new Date().toISOString(),
    };
  }

  static async _process(action, payload) {
    const Compliance = tryRequire('../compliance/complianceEngine')?.ComplianceEngine;
    switch (action) {
      case 'screen':
        if (Compliance) return await Compliance.screen(payload);
        return { mode: 'shadow', note: 'ComplianceEngine not available' };
      case 'get':
        if (Compliance && payload.screeningId) return await Compliance.getScreening(payload.screeningId);
        return { mode: 'shadow', note: 'screeningId required or engine not available' };
      case 'list':
        if (Compliance) return await Compliance.list({ status: payload.status, limit: payload.limit });
        return { mode: 'shadow', note: 'ComplianceEngine not available' };
      case 'approve':
        if (Compliance && payload.screeningId) return await Compliance.approve(payload.screeningId, { reviewedBy: payload.reviewedBy, notes: payload.notes });
        return { mode: 'shadow', note: 'screeningId required or engine not available' };
      case 'block':
        if (Compliance && payload.screeningId) return await Compliance.block(payload.screeningId, { reviewedBy: payload.reviewedBy, notes: payload.notes });
        return { mode: 'shadow', note: 'screeningId required or engine not available' };
      case 'screenRecipient':
        if (Compliance) return await Compliance.screenRecipientForPayout(payload.recipient, payload.amount, payload.sourceAccountId);
        return { mode: 'shadow', note: 'ComplianceEngine not available' };
      case 'status':
      default:
        return await this.status();
    }
  }
}

// ─── Security Engine ───────────────────────────────────────────────────────────

class SecurityEngine extends BaseOSEngine {
  static get engineName() { return 'security'; }

  static async ensureTables() {
    await super.ensureTables();
    if (!pool) return;
    await query(`
      CREATE TABLE IF NOT EXISTS os_audit_log (
        event_id TEXT PRIMARY KEY,
        actor TEXT NOT NULL DEFAULT 'system',
        action TEXT NOT NULL,
        resource TEXT NOT NULL DEFAULT '',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_os_audit_log_actor ON os_audit_log(actor)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_os_audit_log_action ON os_audit_log(action)`);
  }

  static async status() {
    const auth = tryRequire('../auth/securityMiddleware');
    return {
      engine: 'security',
      healthy: true,
      mode: process.env.NODE_ENV || 'development',
      jwt: !!process.env.JWT_SECRET,
      adminToken: !!process.env.ADMIN_SECRET_TOKEN,
      rateLimiting: !!(auth && auth.globalRateLimiter),
      timestamp: new Date().toISOString(),
    };
  }

  static async _process(action, payload) {
    switch (action) {
      case 'audit':
        return await this._audit(payload);
      case 'threatCheck':
        return this._threatCheck(payload);
      case 'rotateAdminToken':
        return { mode: 'manual', note: 'Set ADMIN_SECRET_TOKEN env var and restart; never return secrets in API responses' };
      case 'status':
      default:
        return await this.status();
    }
  }

  static async _audit(payload) {
    if (!pool) return { logged: false };
    const eventId = id('SEC-');
    await query(
      `INSERT INTO os_audit_log (event_id, actor, action, resource, metadata) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [eventId, payload.actor || 'system', payload.action || 'audit', payload.resource || '', safeJson(payload.metadata)]
    );
    return { eventId, logged: true };
  }

  static _threatCheck(payload) {
    const findings = [];
    const userAgent = String(payload.userAgent || '');
    if (/curl|bot|scraper|nmap/i.test(userAgent)) findings.push({ rule: 'suspicious_ua', message: 'Suspicious user agent' });
    if ((payload.failedAttempts || 0) > 5) findings.push({ rule: 'brute_force', message: 'High failed auth attempts' });
    if (payload.country && ['IR','KP','CU','RU','BY'].includes(String(payload.country).toUpperCase())) findings.push({ rule: 'high_risk_country', message: 'High risk country' });
    const risk = findings.length ? 'elevated' : 'low';
    return { risk, findings, checkedAt: new Date().toISOString() };
  }
}

// ─── REST API Engine ──────────────────────────────────────────────────────────

class RestApiEngine extends BaseOSEngine {
  static get engineName() { return 'rest-api'; }

  static async ensureTables() {
    await super.ensureTables();
    if (!pool) return;
    await query(`
      CREATE TABLE IF NOT EXISTS os_api_keys (
        key_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        prefix TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'operator',
        scopes JSONB DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_used_at TIMESTAMPTZ
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_os_api_keys_prefix ON os_api_keys(prefix)`);
  }

  static async status() {
    return {
      engine: 'rest-api',
      healthy: true,
      mode: process.env.NODE_ENV || 'development',
      port: process.env.PORT || 3002,
      shadow: process.env.REST_API_SHADOW !== 'false',
      timestamp: new Date().toISOString(),
    };
  }

  static async _process(action, payload) {
    switch (action) {
      case 'createApiKey':
        return await this._createApiKey(payload);
      case 'disableApiKey':
        return await this._disableApiKey(payload);
      case 'metrics':
        return await this._metrics(payload);
      case 'gatewayStatus':
      case 'status':
      default:
        return await this.status();
    }
  }

  static _hashKey(key) {
    return crypto.createHash('sha256').update(String(key)).digest('hex');
  }

  static async _createApiKey({ name, role = 'operator', scopes = [], createdBy } = {}) {
    if (!name) throw new Error('name is required');
    const keyId = id('AK-');
    const key = crypto.randomBytes(32).toString('base64url');
    const prefix = key.slice(0, 8);
    const keyHash = this._hashKey(key);
    if (pool) {
      await query(
        `INSERT INTO os_api_keys (key_id, name, key_hash, prefix, role, scopes, created_by) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [keyId, name, keyHash, prefix, role, safeJson(scopes), createdBy || 'system']
      );
    }
    return { keyId, name, prefix, role, scopes, apiKey: key, note: 'Store this key now; it will not be shown again' };
  }

  static async _disableApiKey({ keyId } = {}) {
    if (!keyId) throw new Error('keyId is required');
    if (pool) await query(`UPDATE os_api_keys SET status='disabled' WHERE key_id=$1`, [keyId]);
    return { keyId, status: 'disabled' };
  }

  static async _metrics({ limit = 100 } = {}) {
    if (!pool) return { events: 0 };
    const total = await query('SELECT COUNT(*) as c FROM os_events').then((r) => Number(r.rows[0].c));
    const perEngine = await query('SELECT engine, COUNT(*) as c FROM os_events GROUP BY engine').then((r) => r.rows);
    const recent = await query('SELECT event_id, engine, action, status, created_at FROM os_events ORDER BY created_at DESC LIMIT $1', [limit]).then((r) => r.rows);
    const keyCount = await query('SELECT COUNT(*) as c FROM os_api_keys WHERE status=$1', ['active']).then((r) => Number(r.rows[0].c));
    return { totalEvents: total, perEngine, recent, activeApiKeys: keyCount };
  }
}

const ENGINES = {
  bank: BankEngine,
  treasury: TreasuryEngine,
  payment: PaymentEngine,
  clearing: ClearingEngine,
  settlement: SettlementEngine,
  compliance: ComplianceEngine,
  security: SecurityEngine,
  'rest-api': RestApiEngine,
  restapi: RestApiEngine,
};

async function ensureAll() {
  for (const [name, Engine] of Object.entries(ENGINES)) {
    try {
      await Engine.ensureTables();
      console.log(`[os-engines] ${name} tables ensured`);
    } catch (e) {
      console.warn(`[os-engines] ${name} table init:`, e.message);
    }
  }
}

module.exports = {
  BankEngine,
  TreasuryEngine,
  PaymentEngine,
  ClearingEngine,
  SettlementEngine,
  ComplianceEngine,
  SecurityEngine,
  RestApiEngine,
  engines: ENGINES,
  ensureAll,
};
