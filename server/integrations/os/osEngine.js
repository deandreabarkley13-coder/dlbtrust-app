'use strict';

/**
 * OS Engines — unified operating-system layer for the treasury platform.
 *
 * Exposes domain engines (Bank, Treasury, Payment, Clearing, Settlement,
 * Compliance, Security, REST API, Bookkeeping, Cash, Asset Acquisition,
 * Bank Account Aggregator, Funding, Smart Router, Back Office) behind a common interface
 * so they can be wired, scripted, and monitored from a single endpoint tree:
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

const SENSITIVE_RE = /\b(api[_-]?key|private[_-]?key|\w*secret|password|pwd|\w*token|cvv|cvc|pan|card[_-]?number|account[_-]?number|routing[_-]?number|iban|bic|ssn|tax[_-]?id|authorization|signature|payload|instrument|track[12]?|emv)\b/i;

function redact(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_RE.test(String(k)) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

function sanitize(obj) {
  try { return redact(JSON.parse(safeJson(obj || {}))); } catch { return {}; }
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
          [eventId, this.engineName, action, status, safeJson(sanitize(payload)), safeJson(sanitize(result))]
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
      case 'accounts':
      case 'listAccounts':
        if (BankSync && process.env.BANKSYNC_API_KEY && payload.bankId) return await BankSync.listAccounts(payload.bankId);
        return { mode: 'shadow', note: 'bankId required or BANKSYNC not configured' };
      case 'balance':
        if (BankSync && process.env.BANKSYNC_API_KEY && payload.bankId && payload.accountId) return await BankSync.getAccountBalance(payload.bankId, payload.accountId);
        return { mode: 'shadow', note: 'bankId and accountId required or BANKSYNC not configured' };
      case 'getBank':
        if (BankSync && process.env.BANKSYNC_API_KEY && payload.bankId) return await BankSync.getBank(payload.bankId);
        return { mode: 'shadow', note: 'bankId required or BANKSYNC not configured' };
      case 'transactions':
      case 'listTransactions':
        if (BankSync && process.env.BANKSYNC_API_KEY && payload.bankId && payload.accountId) {
          return await BankSync.listTransactions(payload.bankId, payload.accountId, {
            from: payload.from,
            to: payload.to,
            cursor: payload.cursor,
            limit: payload.limit ? Number(payload.limit) : undefined,
          });
        }
        return { mode: 'shadow', note: 'bankId and accountId required or BANKSYNC not configured' };
      case 'syncToLedger':
      case 'sync-to-ledger':
        if (BankSync && process.env.BANKSYNC_API_KEY && payload.accountId) {
          return await BankSync.syncToLedger({
            bankId: payload.bankId,
            accountId: payload.accountId,
            trustAccountCode: payload.trustAccountCode,
            cashAccountId: payload.cashAccountId,
          });
        }
        return { mode: 'shadow', note: 'accountId required or BANKSYNC not configured' };
      case 'cachedBanks':
        if (BankSync && process.env.BANKSYNC_API_KEY) return await BankSync.getCachedBanks();
        return { mode: 'shadow', note: 'BANKSYNC_API_KEY not configured' };
      case 'cachedAccounts':
        if (BankSync && process.env.BANKSYNC_API_KEY) return await BankSync.getCachedAccounts({ bankId: payload.bankId });
        return { mode: 'shadow', note: 'BANKSYNC_API_KEY not configured' };
      case 'cachedTransactions':
        if (BankSync && process.env.BANKSYNC_API_KEY && payload.accountId) {
          return await BankSync.getCachedTransactions({ accountId: payload.accountId, limit: payload.limit, offset: payload.offset });
        }
        return { mode: 'shadow', note: 'accountId required or BANKSYNC not configured' };
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
        if (StableTreasury) return await StableTreasury.getPosition(payload.accountId);
        if (Corp && payload.accountId) return await Corp.getAccount(payload.accountId);
        return { mode: 'shadow', note: 'Treasury engines not configured' };
      case 'sweep':
        if (Corp && payload.poolId) return await Corp.sweepCashPool(payload.poolId);
        return { mode: 'shadow', note: 'poolId required or CorporateTreasuryEngine not available' };
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
        if (Settle && payload.settlementId) return await Settle.confirmSettlement(payload.settlementId, { txHash: payload.txHash, settledAmountCents: payload.settledAmountCents });
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
      [eventId, payload.actor || 'system', payload.action || 'audit', payload.resource || '', safeJson(sanitize(payload.metadata))]
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

// ─── Bookkeeping Engine ───────────────────────────────────────────────────────

class BookkeepingEngine extends BaseOSEngine {
  static get engineName() { return 'bookkeeping'; }

  static async status() {
    const BookkeepingAgent = tryRequire('../agents/bookkeepingAgent')?.BookkeepingAgent;
    const SubLedger = tryRequire('../accounting/subLedgerEngine')?.SubLedgerEngine;
    const TrustAccounting = tryRequire('../accounting/trustAccountingEngine')?.TrustAccountingEngine;
    return {
      engine: 'bookkeeping',
      healthy: true,
      mode: process.env.BOOKKEEPING_LIVE === 'true' ? 'live' : 'shadow',
      integrations: { bookkeepingAgent: !!BookkeepingAgent, subLedger: !!SubLedger, trustAccounting: !!TrustAccounting },
      timestamp: new Date().toISOString(),
    };
  }

  static async _process(action, payload) {
    const BookkeepingAgent = tryRequire('../agents/bookkeepingAgent')?.BookkeepingAgent;
    const SubLedger = tryRequire('../accounting/subLedgerEngine')?.SubLedgerEngine;
    const AssetDebtProof = tryRequire('../accounting/assetDebtProofEngine')?.AssetDebtProofEngine;

    switch (action) {
      case 'reverseTransaction':
      case 'reverse-transaction':
        if (BookkeepingAgent && payload.entryId) return await BookkeepingAgent.reverseTransaction(payload.entryId, { reason: payload.reason, approvedBy: payload.approvedBy });
        return { mode: 'shadow', note: 'entryId required or BookkeepingAgent not available' };
      case 'postAdjustment':
      case 'post-adjustment':
        if (BookkeepingAgent && payload.lines && payload.reason) return await BookkeepingAgent.postAdjustment({
          description: payload.description,
          lines: payload.lines,
          reason: payload.reason,
          adjustmentType: payload.adjustmentType,
          originalEntryId: payload.originalEntryId,
          approvedBy: payload.approvedBy,
        });
        return { mode: 'shadow', note: 'lines and reason required or BookkeepingAgent not available' };
      case 'detectDuplicates':
      case 'detect-duplicates':
        if (BookkeepingAgent) return await BookkeepingAgent.detectDuplicates({ amount: payload.amount, windowHours: payload.windowHours, minAmount: payload.minAmount });
        return { mode: 'shadow', note: 'BookkeepingAgent not available' };
      case 'reverseDuplicate':
      case 'reverse-duplicate':
        if (BookkeepingAgent && payload.amount) return await BookkeepingAgent.reverseDuplicate(payload.amount, { reason: payload.reason, keepEntryId: payload.keepEntryId });
        return { mode: 'shadow', note: 'amount required or BookkeepingAgent not available' };
      case 'reconcileBILLCash':
      case 'reconcile-bill-cash':
        if (BookkeepingAgent) return await BookkeepingAgent.reconcileBILLCash();
        return { mode: 'shadow', note: 'BookkeepingAgent not available' };
      case 'processVendorPayment':
      case 'process-vendor-payment':
        if (process.env.BOOKKEEPING_LIVE !== 'true') return { mode: 'shadow', note: 'Set BOOKKEEPING_LIVE=true to execute real vendor payments' };
        if (BookkeepingAgent && payload.paymentId) return await BookkeepingAgent.processVendorPayment(payload.paymentId);
        return { mode: 'shadow', note: 'paymentId required or BookkeepingAgent not available' };
      case 'subLedgerCreate':
      case 'sub-ledger-create':
        if (SubLedger) return await SubLedger.createSubLedger({
          contactId: payload.contactId,
          parentAccountCode: payload.parentAccountCode,
          subAccountName: payload.subAccountName,
          subAccountType: payload.subAccountType,
          openingBalance: payload.openingBalance,
          currency: payload.currency,
          notes: payload.notes,
        });
        return { mode: 'shadow', note: 'SubLedgerEngine not available' };
      case 'subLedgerGet':
      case 'sub-ledger-get':
        if (SubLedger && payload.subLedgerId) return await SubLedger.getSubLedger(payload.subLedgerId);
        return { mode: 'shadow', note: 'subLedgerId required or SubLedgerEngine not available' };
      case 'subLedgerList':
      case 'sub-ledger-list':
        if (SubLedger) return await SubLedger.listSubLedgers({ contactId: payload.contactId, parentAccountCode: payload.parentAccountCode, subAccountType: payload.subAccountType, status: payload.status });
        return { mode: 'shadow', note: 'SubLedgerEngine not available' };
      case 'subLedgerPost':
      case 'sub-ledger-post':
        if (SubLedger && payload.subLedgerId) return await SubLedger.postTransaction({
          subLedgerId: payload.subLedgerId,
          transactionType: payload.transactionType,
          amount: payload.amount,
          description: payload.description,
          referenceType: payload.referenceType,
          referenceId: payload.referenceId,
          journalEntryId: payload.journalEntryId,
          postedBy: payload.postedBy,
        });
        return { mode: 'shadow', note: 'subLedgerId required or SubLedgerEngine not available' };
      case 'subLedgerTransfer':
      case 'sub-ledger-transfer':
        if (SubLedger && payload.fromSubLedgerId && payload.toSubLedgerId) return await SubLedger.transfer({
          fromSubLedgerId: payload.fromSubLedgerId,
          toSubLedgerId: payload.toSubLedgerId,
          amount: payload.amount,
          description: payload.description,
          postedBy: payload.postedBy,
        });
        return { mode: 'shadow', note: 'fromSubLedgerId and toSubLedgerId required or SubLedgerEngine not available' };
      case 'subLedgerRollup':
      case 'sub-ledger-rollup':
        if (SubLedger) return await SubLedger.getSubLedgerRollup();
        return { mode: 'shadow', note: 'SubLedgerEngine not available' };
      case 'getClientStatement':
      case 'get-client-statement':
        if (SubLedger && payload.contactId) return await SubLedger.getClientStatement(payload.contactId, { fromDate: payload.fromDate, toDate: payload.toDate });
        return { mode: 'shadow', note: 'contactId required or SubLedgerEngine not available' };
      case 'computeProof':
      case 'compute-proof':
        if (AssetDebtProof) return await AssetDebtProof.computeProof({
          liabilities: payload.liabilities,
          memo: payload.memo,
          includePendingLiabilities: payload.includePendingLiabilities,
          includeHardAssets: payload.includeHardAssets,
          createdBy: payload.createdBy,
        });
        return { mode: 'shadow', note: 'AssetDebtProofEngine not available' };
      case 'getLatestCertified':
      case 'get-latest-certified':
        if (AssetDebtProof) return await AssetDebtProof.getLatestCertified();
        return { mode: 'shadow', note: 'AssetDebtProofEngine not available' };
      case 'status':
      default:
        return await this.status();
    }
  }
}

// ─── Cash Engine ──────────────────────────────────────────────────────────────

class CashOSEngine extends BaseOSEngine {
  static get engineName() { return 'cash'; }

  static async status() {
    const Cash = tryRequire('../cash/cashEngine')?.CashEngine;
    return {
      engine: 'cash',
      healthy: true,
      mode: process.env.CASH_LIVE === 'true' ? 'live' : 'shadow',
      integrations: { cashEngine: !!Cash },
      timestamp: new Date().toISOString(),
    };
  }

  static async _process(action, payload) {
    const Cash = tryRequire('../cash/cashEngine')?.CashEngine;
    switch (action) {
      case 'createAccount':
      case 'create-account':
        if (Cash && payload.accountName) return await Cash.createAccount({
          accountId: payload.accountId,
          accountName: payload.accountName,
          accountType: payload.accountType,
          linkedFineractAccountId: payload.linkedFineractAccountId,
          notes: payload.notes,
        });
        return { mode: 'shadow', note: 'accountName required or CashEngine not available' };
      case 'getAccount':
      case 'get-account':
        if (Cash && payload.accountId) return await Cash.getAccount(payload.accountId);
        return { mode: 'shadow', note: 'accountId required or CashEngine not available' };
      case 'listAccounts':
      case 'list-accounts':
        if (Cash) return await Cash.listAccounts({ type: payload.type, status: payload.status });
        return { mode: 'shadow', note: 'CashEngine not available' };
      case 'transfer':
        if (Cash && payload.fromAccountId && payload.toAccountId && payload.amount) {
          return await Cash.transfer({
            fromAccountId: payload.fromAccountId,
            toAccountId: payload.toAccountId,
            amountCents: toCents(payload.amount),
            movementType: payload.movementType,
            memo: payload.memo,
            referenceId: payload.referenceId,
            referenceType: payload.referenceType,
            initiatedBy: payload.initiatedBy,
            glDebitAccountId: payload.glDebitAccountId,
            glCreditAccountId: payload.glCreditAccountId,
            requireFineractPost: payload.requireFineractPost,
          });
        }
        return { mode: 'shadow', note: 'fromAccountId, toAccountId and amount required or CashEngine not available' };
      case 'deposit':
        if (Cash && payload.toAccountId && payload.amount) {
          return await Cash.deposit({
            toAccountId: payload.toAccountId,
            amountCents: toCents(payload.amount),
            memo: payload.memo,
            referenceId: payload.referenceId,
            initiatedBy: payload.initiatedBy,
          });
        }
        return { mode: 'shadow', note: 'toAccountId and amount required or CashEngine not available' };
      case 'positionSummary':
      case 'position-summary':
        if (Cash) return await Cash.getPositionSummary();
        return { mode: 'shadow', note: 'CashEngine not available' };
      case 'getMovements':
      case 'get-movements':
        if (Cash) return await Cash.getMovements({
          fromAccountId: payload.fromAccountId,
          toAccountId: payload.toAccountId,
          movementType: payload.movementType,
          fromDate: payload.fromDate,
          toDate: payload.toDate,
          limit: payload.limit,
          offset: payload.offset,
        });
        return { mode: 'shadow', note: 'CashEngine not available' };
      case 'reconcile':
        if (Cash && payload.accountId) return await Cash.reconcile(payload.accountId);
        return { mode: 'shadow', note: 'accountId required or CashEngine not available' };
      case 'status':
      default:
        return await this.status();
    }
  }
}

// ─── Asset Acquisition Engine ─────────────────────────────────────────────────

class AssetAcquisitionEngine extends BaseOSEngine {
  static get engineName() { return 'asset-acquisition'; }

  static get assetCategories() {
    return ['real_estate', 'vehicle', 'boat', 'jewelry', 'equipment', 'art', 'collectible', 'other'];
  }

  static normalizeCategory(raw) {
    const s = String(raw || 'other').toLowerCase().replace(/\s+/g, '_');
    const map = {
      real_estate: 'real_estate', realestate: 'real_estate', property: 'real_estate',
      vehicle: 'vehicle', motor_vehicle: 'vehicle', car: 'vehicle', auto: 'vehicle', truck: 'vehicle',
      boat: 'boat', watercraft: 'boat', yacht: 'boat',
      jewelry: 'jewelry', jewellery: 'jewelry', watch: 'jewelry', timepiece: 'jewelry',
      equipment: 'equipment', machinery: 'equipment',
      art: 'art', fine_art: 'art',
      collectible: 'collectible', collectable: 'collectible', collectibles: 'collectible',
      other: 'other',
    };
    return Object.hasOwn(map, s) ? map[s] : 'other';
  }

  static async status() {
    const Expense = tryRequire('../accounting/expenseManagementEngine')?.ExpenseManagementEngine;
    return {
      engine: 'asset-acquisition',
      healthy: true,
      mode: process.env.ASSET_ACQUISITION_LIVE === 'true' ? 'live' : 'shadow',
      integrations: { expenseManagement: !!Expense },
      categories: this.assetCategories,
      timestamp: new Date().toISOString(),
    };
  }

  static async _process(action, payload) {
    const Expense = tryRequire('../accounting/expenseManagementEngine')?.ExpenseManagementEngine;
    const TrustAccounting = tryRequire('../accounting/trustAccountingEngine')?.TrustAccountingEngine;
    if (!Expense) return { mode: 'shadow', note: 'ExpenseManagementEngine not available' };

    switch (action) {
      case 'acquire':
      case 'purchase':
      case 'create': {
        if (!payload.name || payload.amountUsd == null) throw new Error('name and amountUsd required');
        const category = this.normalizeCategory(payload.category);
        const asset = await Expense.createRecord({
          type: 'asset',
          category,
          name: payload.name,
          identifier: payload.identifier,
          description: payload.description,
          amountUsd: payload.amountUsd,
          currency: payload.currency || 'USD',
          owner: payload.owner,
          linkedSourceType: payload.linkedSourceType,
          linkedSourceAccountId: payload.linkedSourceAccountId,
          documents: payload.documents,
          metadata: {
            ...(payload.metadata || {}),
            acquiredVia: 'asset-acquisition',
            assetAccountCode: payload.assetAccountCode || null,
            cashAccountCode: payload.cashAccountCode || null,
          },
          createdBy: payload.createdBy,
        });
        let journalEntry = null;
        if (payload.postJournalEntry && TrustAccounting && payload.assetAccountCode && payload.cashAccountCode) {
          try {
            const assetAcct = await TrustAccounting.getAccount(payload.assetAccountCode);
            const cashAcct = await TrustAccounting.getAccount(payload.cashAccountCode);
            if (assetAcct && cashAcct) {
              journalEntry = await TrustAccounting.postJournalEntry({
                entryDate: new Date(),
                description: `Asset acquisition: ${asset.name} (${asset.id})`,
                referenceType: 'asset_acquisition',
                referenceId: asset.id,
                postedBy: payload.createdBy,
                lines: [
                  { accountCode: payload.assetAccountCode, debitAmount: payload.amountUsd, creditAmount: 0, memo: `Acquire ${asset.name}` },
                  { accountCode: payload.cashAccountCode, debitAmount: 0, creditAmount: payload.amountUsd, memo: `Cash for ${asset.name}` },
                ],
              });
            }
          } catch (jeErr) {
            journalEntry = { error: jeErr.message };
          }
        }
        return { asset, journalEntry, category };
      }
      case 'list':
        return await Expense.listRecords({ type: 'asset', category: this.normalizeCategory(payload.category), status: payload.status, limit: payload.limit || 100 });
      case 'get':
        if (!payload.assetId) throw new Error('assetId required');
        return await Expense.getRecord(payload.assetId);
      case 'update':
        if (!payload.assetId) throw new Error('assetId required');
        return await Expense.updateRecord(payload.assetId, payload.updates);
      case 'dispose':
      case 'sell': {
        if (!payload.assetId) throw new Error('assetId required');
        const original = await Expense.getRecord(payload.assetId);
        const costBasisCents = original?.amount_cents || 0;
        const costBasisUsd = costBasisCents / 100;
        const saleUsd = payload.saleAmountUsd != null ? Number(payload.saleAmountUsd) : costBasisUsd;
        const updates = {
          status: 'sold',
          metadata: {
            ...(original?.metadata || {}),
            ...(payload.metadata || {}),
            saleAmountUsd: saleUsd,
            soldAt: new Date().toISOString(),
          },
        };
        const asset = await Expense.updateRecord(payload.assetId, updates);
        let journalEntry = null;
        if (payload.postJournalEntry && TrustAccounting && payload.cashAccountCode && payload.gainAccountCode) {
          try {
            const gain = saleUsd - costBasisUsd;
            const assetAccountCode = payload.assetAccountCode || original?.metadata?.assetAccountCode;
            if (!assetAccountCode) throw new Error('assetAccountCode required to post disposal journal entry');
            const lines = [
              { accountCode: payload.cashAccountCode, debitAmount: saleUsd, creditAmount: 0, memo: `Proceeds from sale of ${original?.name}` },
              { accountCode: assetAccountCode, debitAmount: 0, creditAmount: costBasisUsd, memo: `Remove ${original?.name} from books` },
            ];
            if (gain > 0) lines.push({ accountCode: payload.gainAccountCode, debitAmount: 0, creditAmount: gain, memo: `Gain on sale` });
            if (gain < 0) lines.push({ accountCode: payload.gainAccountCode, debitAmount: Math.abs(gain), creditAmount: 0, memo: `Loss on sale` });
            journalEntry = await TrustAccounting.postJournalEntry({
              entryDate: new Date(),
              description: `Asset disposal: ${original?.name} (${payload.assetId})`,
              referenceType: 'asset_disposal',
              referenceId: payload.assetId,
              postedBy: payload.postedBy,
              lines,
            });
          } catch (jeErr) {
            journalEntry = { error: jeErr.message };
          }
        }
        return { asset, journalEntry, costBasisUsd, saleUsd, gain: saleUsd - costBasisUsd };
      }
      case 'status':
      default:
        return await this.status();
    }
  }
}

// ─── Bank Account Aggregator Engine ───────────────────────────────────────────

class BankAccountAggregatorEngine extends BaseOSEngine {
  static get engineName() { return 'bank-aggregator'; }

  static async status() {
    const Aggregator = tryRequire('../aggregator/bankingAggregator')?.BankingAggregator;
    const Connectors = tryRequire('../aggregator/connectors');
    return {
      engine: 'bank-aggregator',
      healthy: true,
      mode: process.env.BANK_AGGREGATOR_LIVE === 'true' ? 'live' : 'shadow',
      integrations: { bankingAggregator: !!Aggregator },
      connectorsAvailable: Aggregator ? (Connectors?.listConnectorTypes() || []) : [],
      timestamp: new Date().toISOString(),
    };
  }

  static async _process(action, payload) {
    const Aggregator = tryRequire('../aggregator/bankingAggregator')?.BankingAggregator;
    const live = process.env.BANK_AGGREGATOR_LIVE === 'true';
    switch (action) {
      case 'connectorTypes':
      case 'connector-types':
        if (Aggregator) {
          const Connectors = tryRequire('../aggregator/connectors');
          return { connectors: Connectors?.listConnectorTypes() || [] };
        }
        return { mode: 'shadow', note: 'BankingAggregator not available' };
      case 'listConnections':
      case 'list-connections':
        if (Aggregator) return await Aggregator.listConnections();
        return { mode: 'shadow', note: 'BankingAggregator not available' };
      case 'createConnection':
      case 'create-connection':
        if (Aggregator && payload.name && payload.connectorType) {
          return await Aggregator.createConnection({
            id: payload.id,
            name: payload.name,
            connectorType: payload.connectorType,
            direction: payload.direction || 'both',
            config: payload.config || {},
            active: payload.active !== false,
          });
        }
        return { mode: 'shadow', note: 'name and connectorType required or BankingAggregator not available' };
      case 'getConnection':
      case 'get-connection':
        if (Aggregator && payload.connectionId) return await Aggregator.getConnection(payload.connectionId);
        return { mode: 'shadow', note: 'connectionId required or BankingAggregator not available' };
      case 'updateConnection':
      case 'update-connection':
        if (Aggregator && payload.connectionId) return await Aggregator.updateConnection(payload.connectionId, payload.updates || payload);
        return { mode: 'shadow', note: 'connectionId required or BankingAggregator not available' };
      case 'deleteConnection':
      case 'delete-connection':
        if (Aggregator && payload.connectionId) return { deleted: await Aggregator.deleteConnection(payload.connectionId) };
        return { mode: 'shadow', note: 'connectionId required or BankingAggregator not available' };
      case 'pull':
        if (!live) return { mode: 'shadow', note: 'Set BANK_AGGREGATOR_LIVE=true to pull external financial data' };
        if (Aggregator && payload.connectionId) return await Aggregator.pull(payload.connectionId, { kinds: payload.kinds, since: payload.since, accountId: payload.accountId });
        return { mode: 'shadow', note: 'connectionId required or BankingAggregator not available' };
      case 'push':
        if (!live) return { mode: 'shadow', note: 'Set BANK_AGGREGATOR_LIVE=true to push outbound payments/financial data' };
        if (Aggregator && payload.connectionId) return await Aggregator.push(payload.connectionId, payload);
        return { mode: 'shadow', note: 'connectionId required or BankingAggregator not available' };
      case 'listAccounts':
      case 'list-accounts':
        if (Aggregator) return await Aggregator.listAccounts(payload.connectionId);
        return { mode: 'shadow', note: 'BankingAggregator not available' };
      case 'listTransactions':
      case 'list-transactions':
        if (Aggregator) return await Aggregator.listTransactions({ connectionId: payload.connectionId, accountId: payload.accountId, limit: payload.limit });
        return { mode: 'shadow', note: 'BankingAggregator not available' };
      case 'listStatements':
      case 'list-statements':
        if (Aggregator) return await Aggregator.listStatements(payload.connectionId);
        return { mode: 'shadow', note: 'BankingAggregator not available' };
      case 'listEvents':
      case 'list-events':
        if (Aggregator) return await Aggregator.listEvents({ connectionId: payload.connectionId, direction: payload.direction, limit: payload.limit });
        return { mode: 'shadow', note: 'BankingAggregator not available' };
      case 'pullReturns':
      case 'pull-returns':
      case 'returns':
        if (!live) return { mode: 'shadow', note: 'Set BANK_AGGREGATOR_LIVE=true to pull ACH returns' };
        if (Aggregator && payload.connectionId) return await Aggregator.pullReturns(payload.connectionId, { limit: payload.limit, since: payload.since });
        return { mode: 'shadow', note: 'connectionId required or BankingAggregator not available' };
      case 'pullFileStatus':
      case 'file-status':
        if (!live) return { mode: 'shadow', note: 'Set BANK_AGGREGATOR_LIVE=true to pull payment file status' };
        if (Aggregator && payload.connectionId) return await Aggregator.pullFileStatus(payload.connectionId, { submissionId: payload.submissionId });
        return { mode: 'shadow', note: 'connectionId and submissionId required or BankingAggregator not available' };
      case 'status':
      default:
        return await this.status();
    }
  }
}

// ─── Funding OS Engine ────────────────────────────────────────────────────────

class FundingOSEngine extends BaseOSEngine {
  static get engineName() { return 'funding'; }

  static async status() {
    const Funding = tryRequire('../dapp/fundingEngine')?.FundingEngine;
    const status = {
      engine: 'funding',
      healthy: true,
      mode: process.env.FUNDING_LIVE === 'true' ? 'live' : 'shadow',
      integrations: { fundingEngine: !!Funding },
      timestamp: new Date().toISOString(),
    };
    if (Funding) {
      try { status.fundingStatus = await Funding.getStatus(); } catch (e) { status.fundingStatusError = e.message; }
    }
    return status;
  }

  static async _process(action, payload) {
    const Funding = tryRequire('../dapp/fundingEngine')?.FundingEngine;
    switch (action) {
      case 'getStatus':
      case 'get-status':
      case 'status':
        if (Funding) {
          try { return await Funding.getStatus(); } catch (e) { return { mode: 'shadow', note: e.message }; }
        }
        return { mode: 'shadow', note: 'FundingEngine not available' };
      case 'getConfig':
      case 'get-config':
      case 'config':
        if (Funding) return Funding.getConfig();
        return { mode: 'shadow', note: 'FundingEngine not available' };
      case 'buildPlan':
      case 'build-plan':
      case 'plan':
        if (Funding) return await Funding.buildPlan(payload || {});
        return { mode: 'shadow', note: 'FundingEngine not available' };
      case 'executePlan':
      case 'execute-plan':
      case 'execute':
        if (process.env.FUNDING_LIVE !== 'true') return { mode: 'shadow', note: 'Set FUNDING_LIVE=true to execute funding rails that move value' };
        if (Funding) return await Funding.executePlan(payload || {});
        return { mode: 'shadow', note: 'FundingEngine not available' };
      case 'depositInvoice':
      case 'deposit-invoice':
      case 'invoice':
        if (Funding) return await Funding.getDepositInvoice(payload || {});
        return { mode: 'shadow', note: 'FundingEngine not available' };
      case 'sourceBalances':
      case 'source-balances':
        {
          const DappEngine = tryRequire('../dapp/dappEngine')?.DappEngine;
          if (DappEngine && DappEngine.listSourceBalances) return await DappEngine.listSourceBalances();
          return { mode: 'shadow', note: 'DappEngine.listSourceBalances not available' };
        }
      default:
        return await this.status();
    }
  }
}

// ─── Smart Router Engine ──────────────────────────────────────────────────────

class SmartRouterEngine extends BaseOSEngine {
  static get engineName() { return 'smart-router'; }

  static _isLive() {
    return process.env.SMART_ROUTER_LIVE === 'true';
  }

  static async ensureTables() {
    await super.ensureTables();
    if (!pool) return;
    await query(`
      CREATE TABLE IF NOT EXISTS smart_router_payments (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        rail TEXT,
        amount_cents BIGINT,
        currency TEXT DEFAULT 'USD',
        source JSONB DEFAULT '{}',
        destination JSONB DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','settled','failed','shadow')),
        reference TEXT,
        confirmation JSONB DEFAULT '{}',
        receipt JSONB DEFAULT '{}',
        raw_request JSONB DEFAULT '{}',
        raw_response JSONB DEFAULT '{}',
        metadata JSONB DEFAULT '{}',
        initiated_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_srp_status ON smart_router_payments(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_srp_reference ON smart_router_payments(reference)`);
  }

  static async _loadDeps() {
    return {
      PaymentGateway: tryRequire('../payments/paymentGatewayServerEngine')?.PaymentGatewayServerEngine,
      Stablecoin: tryRequire('../stablecoin/stablecoinGateway')?.StablecoinGateway,
      Canonical: tryRequire('../dapp/canonicalMoneyEngine')?.CanonicalMoneyEngine,
      Consensus: tryRequire('../dapp/canonicalConsensusEngine')?.CanonicalConsensusEngine,
      Funding: tryRequire('../dapp/fundingEngine')?.FundingEngine,
    };
  }

  static async status() {
    const deps = await this._loadDeps();
    const rails = {};
    try {
      const ready = deps.Stablecoin ? await deps.Stablecoin.readiness({ publicHealth: true }).catch(() => ({ ready: false })) : { ready: false };
      rails.stablecoin = {
        available: !!deps.Stablecoin,
        ready: ready.ready,
        mode: ready.mode || process.env.STABLECOIN_MODE || 'shadow',
      };
    } catch (e) { rails.stablecoin = { available: !!deps.Stablecoin, ready: false, error: e.message }; }
    rails.canonical = {
      available: !!deps.Canonical,
      configured: !!process.env.DAPP_PRIVATE_KEY && process.env.DAPP_SHADOW !== 'true',
    };
    rails.fiat = {
      available: !!deps.PaymentGateway,
      configured: process.env.PAYMENT_MODE === 'production' || !!process.env.STRIPE_SECRET_KEY || !!process.env.STRIPE_TREASURY_API_KEY || process.env.PAYMENT_HUB_LIVE === 'true',
    };
    rails.funding = {
      available: !!deps.Funding,
      configured: process.env.FUNDING_LIVE === 'true',
    };
    return {
      engine: 'smart-router',
      healthy: true,
      mode: this._isLive() ? 'live' : 'shadow',
      live: this._isLive(),
      rails,
      timestamp: new Date().toISOString(),
    };
  }

  static async list({ limit = 50, status } = {}) {
    if (!pool) return [];
    let sql = 'SELECT * FROM smart_router_payments';
    const params = [];
    if (status) { sql += ' WHERE status = $1'; params.push(status); }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    const res = await query(sql, params);
    return res.rows.map((r) => this._sanitizeRow(r));
  }

  static async get(paymentId) {
    if (!pool) return null;
    const res = await query('SELECT * FROM smart_router_payments WHERE id = $1', [paymentId]);
    const row = res.rows[0];
    return row ? this._sanitizeRow(row) : null;
  }

  static _sanitizeRow(row) {
    return {
      ...row,
      source: sanitize(row.source),
      destination: sanitize(row.destination),
      raw_request: sanitize(row.raw_request),
      raw_response: sanitize(row.raw_response),
      confirmation: sanitize(row.confirmation),
      receipt: sanitize(row.receipt),
    };
  }

  static _toReceipt(row) {
    return {
      paymentId: row.id,
      engine: 'smart-router',
      rail: row.rail,
      amount: row.amount_cents ? row.amount_cents / 100 : null,
      currency: row.currency,
      source: row.source,
      destination: row.destination,
      status: row.status,
      reference: row.reference,
      confirmation: row.confirmation,
      receiptUrl: `/api/os/smart-router/get/${row.id}`,
      confirmAction: { action: 'confirm', paymentId: row.id },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  static async _route(payload) {
    const deps = await this._loadDeps();
    const amount = Number(payload.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be a positive number');
    const currency = String(payload.currency || 'USD').toUpperCase();
    const source = payload.source || {};
    const destination = payload.destination || {};
    const preferred = String(payload.preferred || payload.rail || '').toLowerCase();
    const memo = payload.memo || payload.reference || `SmartRouter ${new Date().toISOString()}`;

    const destType = String(destination.type || '').toLowerCase();
    const hasWallet = !!(destination.address || destination.walletAddress);
    const hasBank = !!(destination.accountNumber || destination.iban || destType === 'bank' || destType === 'card');

    const candidates = [];
    const stableReady = deps.Stablecoin ? await deps.Stablecoin.readiness({ publicHealth: true }).catch(() => ({ ready: false })) : { ready: false };

    if (hasWallet || ['USDC','USDT','DLBUSD'].includes(currency)) {
      if (deps.Stablecoin && stableReady.ready) {
        const cfg = stableReady;
        candidates.push({ rail: 'stablecoin', feeEstimateUsd: Math.max(0.01, amount * 0.001), speed: 'seconds', live: process.env.STABLECOIN_MODE === 'live', network: cfg.network || 'testnet', assetCode: cfg.assetCode || 'USDC' });
      }
      if (deps.Canonical && process.env.DAPP_PRIVATE_KEY) {
        candidates.push({ rail: 'canonical', feeEstimateUsd: Math.max(0.10, amount * 0.002 + 0.20), speed: 'minutes', live: process.env.DAPP_SHADOW !== 'true' });
      }
    }
    if (hasBank || ['USD','EUR','GBP'].includes(currency)) {
      if (deps.PaymentGateway) {
        candidates.push({ rail: 'fiat', feeEstimateUsd: Math.max(0.25, amount * 0.005), speed: 'hours', live: process.env.PAYMENT_MODE === 'production' || process.env.PAYMENT_HUB_LIVE === 'true' });
      }
    }
    if (payload.targetAsset || source.type === 'cash' || source.sourceType === 'cash') {
      if (deps.Funding) {
        candidates.push({ rail: 'funding', feeEstimateUsd: 0, speed: 'varies', live: process.env.FUNDING_LIVE === 'true' });
      }
    }

    if (preferred) {
      const idx = candidates.findIndex((c) => c.rail === preferred);
      if (idx > 0) {
        const [chosen] = candidates.splice(idx, 1);
        candidates.unshift(chosen);
      } else if (idx === -1) {
        candidates.push({ rail: preferred, feeEstimateUsd: 0, speed: 'unknown', live: false, missing: 'preferred rail not available' });
      }
    }

    const chosen = candidates.find((c) => !c.missing) || candidates[0] || null;
    return {
      amount,
      currency,
      source,
      destination,
      preferred,
      chosenRail: chosen ? chosen.rail : null,
      candidates,
      canExecute: this._isLive() && !!chosen && chosen.live && !chosen.missing,
      live: this._isLive(),
      missing: candidates.filter((c) => c.missing).map((c) => `${c.rail}: ${c.missing}`),
      memo,
    };
  }

  static async _record({ paymentId, action, rail, amount, currency, source, destination, status, reference, confirmation, rawRequest, rawResponse, initiatedBy }) {
    if (!pool) return;
    await query(
      `INSERT INTO smart_router_payments (id, action, rail, amount_cents, currency, source, destination, status, reference, confirmation, raw_request, raw_response, metadata, initiated_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14)`,
      [paymentId, action, rail, toCents(amount), currency, safeJson(source), safeJson(destination), status, reference || null, safeJson(confirmation || {}), safeJson(rawRequest || {}), safeJson(rawResponse || {}), safeJson({}), initiatedBy || 'system']
    );
  }

  static async _updateConfirmation(paymentId, confirmation, status) {
    if (!pool) return;
    const setParts = ['confirmation = $1::jsonb', 'updated_at = NOW()'];
    const values = [safeJson(confirmation || {})];
    if (status) { setParts.push('status = $3'); values.push(status); }
    values.push(paymentId);
    await query(`UPDATE smart_router_payments SET ${setParts.join(', ')} WHERE id = $${values.length}`, values);
  }

  static async _deliverFiat(plan, payload, paymentId, deps) {
    if (!deps.PaymentGateway) throw new Error('PaymentGatewayServerEngine not available');
    const sale = await deps.PaymentGateway.sale({
      amount: plan.amount,
      currency: plan.currency,
      methodId: payload.methodId || null,
      reference: paymentId,
      direction: 'outbound',
      source: plan.source,
      destination: plan.destination,
      processor: payload.processor || null,
      metadata: { smartRouter: paymentId, memo: plan.memo, ...(payload.metadata || {}) },
      initiatedBy: payload.initiatedBy || 'system',
    });
    return { rail: 'fiat', gatewayTxId: sale.gatewayTxId, processorTxId: sale.processorTxId, status: sale.status, amount: sale.amount, currency: sale.currency, result: sale.result };
  }

  static async _deliverStablecoin(plan, payload, paymentId, deps) {
    if (!deps.Stablecoin) throw new Error('StablecoinGateway not available');
    const dest = plan.destination;
    const source = plan.source;
    const created = await deps.Stablecoin.createPayment({
      amount: plan.amount,
      assetCode: payload.assetCode || plan.currency,
      network: payload.network || 'testnet',
      destinationWallet: dest.address || dest.walletAddress,
      sourceType: source.type || payload.sourceType || 'treasury',
      sourceAccountId: source.accountId || payload.sourceAccountId,
      memo: plan.memo,
      metadata: { smartRouter: paymentId, ...payload.metadata },
    });
    let status = created.status;
    let settled = null;
    if (created.id && process.env.STABLECOIN_MODE === 'live') {
      await deps.Stablecoin.approvePayment(created.id, source.accountId || payload.sourceAccountId);
      settled = await deps.Stablecoin.settlePayment(created.id, { memo: plan.memo });
      status = settled.status;
    }
    return { rail: 'stablecoin', stablecoinPaymentId: created.id, status, network: created.network, tx_hash: settled ? settled.tx_hash : (created.tx_hash || null), result: settled || created };
  }

  static async _deliverCanonical(plan, payload, paymentId, deps) {
    if (!deps.Canonical) throw new Error('CanonicalMoneyEngine not available');
    const source = plan.source;
    const dest = plan.destination;
    const autoApprove = this._isLive() && process.env.SMART_ROUTER_AUTO_APPROVE === 'true' && process.env.DAPP_SHADOW !== 'true';
    const proposal = await deps.Canonical.propose({
      sourceType: source.type,
      sourceAccountId: source.accountId,
      sourceToken: payload.sourceToken,
      sourceModule: payload.sourceModule,
      amount: plan.amount,
      targetAsset: payload.targetAsset || plan.currency || 'USDC',
      poolAddress: payload.poolAddress,
      recipient: dest.address || dest.walletAddress || dest.identifier,
      createPoolIfMissing: payload.createPoolIfMissing,
      poolSeedUsdc: payload.poolSeedUsdc,
      poolSeedDlbusd: payload.poolSeedDlbusd,
      title: payload.title || `SmartRouter: ${plan.amount} ${plan.currency}`,
      createdBy: payload.initiatedBy || 'system',
      autoApprove,
    });
    return { rail: 'canonical', requestId: proposal.requestId, proposalId: proposal.proposalId, autoApprove, proposal: proposal.proposal };
  }

  static async _deliverFunding(plan, payload, paymentId, deps) {
    if (!deps.Funding) throw new Error('FundingEngine not available');
    const source = plan.source;
    const built = await deps.Funding.buildPlan({
      amountUsd: plan.amount,
      sourceType: source.type || payload.sourceType,
      sourceAccountId: source.accountId || payload.sourceAccountId,
      targetAsset: payload.targetAsset || 'ETH',
      strategy: payload.strategy || 'auto',
      cashtag: payload.cashtag,
    });
    if (process.env.FUNDING_LIVE === 'true') {
      const executed = await deps.Funding.executePlan({
        amountUsd: plan.amount,
        sourceType: source.type || payload.sourceType,
        sourceAccountId: source.accountId || payload.sourceAccountId,
        targetAsset: payload.targetAsset || 'ETH',
        strategy: payload.strategy || 'auto',
        railOptions: payload.railOptions,
        cashtag: payload.cashtag,
        memo: plan.memo,
      });
      return { rail: 'funding', status: 'executed', plan: built, executed };
    }
    return { rail: 'funding', status: 'shadow', plan: built, note: 'FUNDING_LIVE is not true' };
  }

  static async _deliver(plan, payload, paymentId, deps) {
    const rail = payload.rail || payload.preferred || plan.chosenRail;
    if (!rail) throw new Error('No rail chosen; call route first or provide preferred rail');
    const planRail = plan.candidates.find((c) => c.rail === rail);
    if (!this._isLive()) throw new Error('SMART_ROUTER_LIVE is not true');
    if (!planRail || !planRail.live) throw new Error(`Rail ${rail} is not live or not available`);

    switch (rail) {
      case 'fiat': return await this._deliverFiat(plan, payload, paymentId, deps);
      case 'stablecoin': return await this._deliverStablecoin(plan, payload, paymentId, deps);
      case 'canonical': return await this._deliverCanonical(plan, payload, paymentId, deps);
      case 'funding': return await this._deliverFunding(plan, payload, paymentId, deps);
      default: throw new Error(`Unsupported rail: ${rail}`);
    }
  }

  static async _deliverAndRecord(payload, deps) {
    const plan = await this._route(payload);
    const paymentId = id('SRP');
    const rail = payload.rail || payload.preferred || plan.chosenRail;
    if (!this._isLive()) {
      await this._record({
        paymentId, action: 'deliver', rail, amount: plan.amount, currency: plan.currency,
        source: plan.source, destination: plan.destination, status: 'shadow',
        reference: payload.reference || null,
        confirmation: { mode: 'shadow', plan },
        rawRequest: payload,
        rawResponse: { mode: 'shadow' },
        initiatedBy: payload.initiatedBy || 'system',
      });
      return { mode: 'shadow', paymentId, rail, plan: { ...plan }, note: 'Set SMART_ROUTER_LIVE=true to move real value' };
    }
    try {
      const result = await this._deliver(plan, payload, paymentId, deps);
      const status = result.status === 'completed' || result.status === 'settled' ? 'settled' : (result.status === 'failed' ? 'failed' : 'confirmed');
      const confirmation = { rail, ...result };
      await this._record({
        paymentId, action: 'deliver', rail, amount: plan.amount, currency: plan.currency,
        source: plan.source, destination: plan.destination, status,
        reference: payload.reference || null, confirmation,
        rawRequest: payload, rawResponse: result,
        initiatedBy: payload.initiatedBy || 'system',
      });
      return { paymentId, rail, status, confirmation: sanitize(confirmation), receiptUrl: `/api/os/smart-router/get/${paymentId}`, result: sanitize(result) };
    } catch (err) {
      await this._record({
        paymentId, action: 'deliver', rail, amount: plan.amount, currency: plan.currency,
        source: plan.source, destination: plan.destination, status: 'failed',
        reference: payload.reference || null, confirmation: { error: err.message },
        rawRequest: payload, rawResponse: { error: err.message },
        initiatedBy: payload.initiatedBy || 'system',
      });
      throw err;
    }
  }

  static async _confirm(payload, deps) {
    const paymentId = payload.paymentId || payload.id;
    if (!paymentId) throw new Error('paymentId or id required');
    const row = await this.get(paymentId);
    if (!row) throw new Error('payment not found');
    let externalStatus = null;
    if (row.rail === 'stablecoin' && row.confirmation && row.confirmation.stablecoinPaymentId && deps.Stablecoin) {
      externalStatus = await deps.Stablecoin.getPayment(row.confirmation.stablecoinPaymentId);
    } else if (row.rail === 'fiat' && row.confirmation && row.confirmation.gatewayTxId && deps.PaymentGateway) {
      externalStatus = await deps.PaymentGateway.getStatus(row.confirmation.gatewayTxId);
    } else if (row.rail === 'canonical' && row.confirmation && row.confirmation.proposalId && deps.Consensus) {
      externalStatus = await deps.Consensus.getProposal(row.confirmation.proposalId);
    }
    if (externalStatus) {
      const status = externalStatus.status || row.status;
      const confirmation = { ...row.confirmation, externalStatus };
      await this._updateConfirmation(paymentId, confirmation, status);
      return { paymentId, rail: row.rail, status, externalStatus: sanitize(externalStatus), confirmation: sanitize(confirmation) };
    }
    return { paymentId, rail: row.rail, status: row.status, confirmation: row.confirmation, note: 'No external confirmation available' };
  }

  static async _process(action, payload) {
    const deps = await this._loadDeps();
    switch (action) {
      case 'route':
      case 'plan':
        return await this._route(payload);
      case 'deliver':
      case 'execute':
        return await this._deliverAndRecord(payload, deps);
      case 'confirm':
      case 'status':
        return await this._confirm(payload, deps);
      case 'receipt': {
        const row = await this.get(payload.paymentId || payload.id);
        if (!row) throw new Error('payment not found');
        return { receipt: this._toReceipt(row), payment: row };
      }
      case 'list':
        return await this.list({ limit: payload.limit, status: payload.status });
      case 'get':
        return await this.get(payload.id || payload.paymentId);
      default:
        return await this.status();
    }
  }
}

// ─── Back Office Engine ─────────────────────────────────────────────────────────

class BackOfficeEngine extends BaseOSEngine {
  static get engineName() { return 'back-office'; }

  static _isLive() { return process.env.BACK_OFFICE_LIVE === 'true'; }

  static async ensureTables() {
    await super.ensureTables();
    if (!pool) return;
    await query(`
      CREATE TABLE IF NOT EXISTS back_office_batches (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'distribution',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
        items JSONB DEFAULT '[]',
        result JSONB DEFAULT '{}',
        metadata JSONB DEFAULT '{}',
        initiated_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_back_office_batches_status ON back_office_batches(status)`);
    await query(`
      CREATE TABLE IF NOT EXISTS back_office_tasks (
        id TEXT PRIMARY KEY,
        batch_id TEXT REFERENCES back_office_batches(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        payload JSONB DEFAULT '{}',
        result JSONB DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_back_office_tasks_batch ON back_office_tasks(batch_id)`);
  }

  static async _loadDeps() {
    return {
      TrustAccounting: tryRequire('../accounting/trustAccountingEngine')?.TrustAccountingEngine,
      Cash: tryRequire('../cash/cashEngine')?.CashEngine,
      Bond: tryRequire('../bonds/bondEngine')?.BondEngine,
      CorporateTreasury: tryRequire('../finops/corporateTreasuryEngine')?.CorporateTreasuryEngine,
      BankSync: tryRequire('../finops/bankSyncEngine')?.BankSyncEngine,
      Distribution: tryRequire('../dapp/distributionRequestEngine')?.DistributionRequestEngine,
    };
  }

  static async status() {
    const deps = await this._loadDeps();
    const distCount = await this._distributionCount();
    return {
      engine: 'back-office',
      healthy: true,
      mode: this._isLive() ? 'live' : 'shadow',
      live: this._isLive(),
      integrations: {
        trustAccounting: !!deps.TrustAccounting,
        cash: !!deps.Cash,
        bond: !!deps.Bond,
        corporateTreasury: !!deps.CorporateTreasury,
        bankSync: !!deps.BankSync,
        distribution: !!deps.Distribution,
      },
      distributionCount: distCount,
      timestamp: new Date().toISOString(),
    };
  }

  static async _distributionCount() {
    if (!pool) return 0;
    try {
      const res = await query("SELECT COUNT(*)::int AS c FROM dapp_distribution_requests");
      return res.rows[0]?.c || 0;
    } catch (e) { return 0; }
  }

  static async _treasurySummary() {
    const deps = await this._loadDeps();
    const summary = { asOf: new Date().toISOString(), sources: {}, totals: { assetsCents: 0, liabilitiesCents: 0, equityCents: 0, cashCents: 0, bondsCents: 0 } };
    if (deps.TrustAccounting) {
      try {
        const bs = await deps.TrustAccounting.getBalanceSheet({});
        summary.sources.trustAccounting = bs;
        summary.totals.assetsCents += Number(bs.totalAssetsCents || 0);
        summary.totals.liabilitiesCents += Number(bs.totalLiabilitiesCents || 0);
        summary.totals.equityCents += Number(bs.totalEquityCents || 0);
      } catch (e) { summary.sources.trustAccountingError = e.message; }
    }
    if (deps.Cash) {
      try {
        const pos = await deps.Cash.getPositionSummary();
        summary.sources.cash = pos;
        summary.totals.cashCents += Number(pos.totalBalanceCents || 0);
      } catch (e) { summary.sources.cashError = e.message; }
    }
    if (deps.Bond) {
      try {
        const bonds = await deps.Bond.listBonds();
        summary.sources.bonds = bonds;
        summary.totals.bondsCents = Array.isArray(bonds)
          ? bonds.reduce((sum, b) => sum + Number(b.balance_cents || b.face_value_cents || 0), 0)
          : 0;
      } catch (e) { summary.sources.bondsError = e.message; }
    }
    if (deps.CorporateTreasury) {
      try {
        const corp = await deps.CorporateTreasury.getStatus ? await deps.CorporateTreasury.getStatus() : null;
        summary.sources.corporateTreasury = corp;
      } catch (e) { summary.sources.corporateTreasuryError = e.message; }
    }
    return summary;
  }

  static async _bankReconciliation(payload) {
    const deps = await this._loadDeps();
    if (!deps.BankSync) return { mode: 'shadow', note: 'BankSyncEngine not available' };
    const live = this._isLive() && process.env.BANKSYNC_API_KEY;
    let banks = [];
    let accounts = [];
    let transactions = [];
    try {
      banks = await (live ? deps.BankSync.listBanks() : deps.BankSync.getCachedBanks());
      accounts = await (live && payload.bankId ? deps.BankSync.listAccounts(payload.bankId) : deps.BankSync.getCachedAccounts({ bankId: payload.bankId }));
      if (payload.accountId) {
        transactions = await (live ? deps.BankSync.listTransactions(payload.bankId, payload.accountId, { limit: payload.limit || 50 }) : deps.BankSync.getCachedTransactions({ accountId: payload.accountId, limit: payload.limit || 50 }));
      }
    } catch (e) {
      return { mode: live ? 'live' : 'shadow', note: e.message };
    }
    return {
      mode: live ? 'live' : 'shadow',
      bankCount: Array.isArray(banks) ? banks.length : 0,
      accountCount: Array.isArray(accounts) ? accounts.length : 0,
      transactionCount: Array.isArray(transactions) ? transactions.length : 0,
      banks: Array.isArray(banks) ? banks.slice(0, 10) : [],
      accounts: Array.isArray(accounts) ? accounts.slice(0, 10) : [],
      transactions: Array.isArray(transactions) ? transactions.slice(0, 10) : [],
      reconciledAt: new Date().toISOString(),
    };
  }

  static async _listDistributions(payload) {
    const deps = await this._loadDeps();
    if (!deps.Distribution) return { mode: 'shadow', note: 'DistributionRequestEngine not available' };
    return await deps.Distribution.listRequests({ status: payload.status, beneficiaryEmail: payload.beneficiaryEmail, limit: payload.limit || 50 });
  }

  static async _getDistribution(payload) {
    const deps = await this._loadDeps();
    if (!deps.Distribution) return { mode: 'shadow', note: 'DistributionRequestEngine not available' };
    if (!payload.requestId && !payload.id) throw new Error('requestId or id required');
    return await deps.Distribution.getRequest(payload.requestId || payload.id);
  }

  static async _createDistribution(payload) {
    const deps = await this._loadDeps();
    if (!deps.Distribution) return { mode: 'shadow', note: 'DistributionRequestEngine not available' };
    return await deps.Distribution.createRequest({
      type: payload.type || 'distribution',
      requesterRole: payload.requesterRole || 'trustee',
      beneficiaryId: payload.beneficiaryId,
      beneficiaryEmail: payload.beneficiaryEmail,
      beneficiaryName: payload.beneficiaryName,
      beneficiaryAddress: payload.beneficiaryAddress,
      amountUsd: payload.amountUsd || payload.amount,
      currency: payload.currency || 'USD',
      destinationAddress: payload.destinationAddress || payload.destination,
      memo: payload.memo,
      proofId: payload.proofId,
      safeId: payload.safeId,
      sourceType: payload.sourceType,
      sourceAccountId: payload.sourceAccountId,
      createdBy: payload.createdBy || 'system',
    });
  }

  static async _approveDistribution(payload) {
    const deps = await this._loadDeps();
    if (!deps.Distribution) return { mode: 'shadow', note: 'DistributionRequestEngine not available' };
    const role = payload.role || 'maker';
    if (role === 'checker' && !this._isLive()) {
      return { mode: 'shadow', note: 'Set BACK_OFFICE_LIVE=true to checker-approve and execute distributions' };
    }
    return await deps.Distribution.approveRequest({
      requestId: payload.requestId || payload.id,
      role,
      trusteeEmail: payload.trusteeEmail,
      signature: payload.signature,
      signerName: payload.signerName,
      proofId: payload.proofId,
    });
  }

  static async _rejectDistribution(payload) {
    const deps = await this._loadDeps();
    if (!deps.Distribution) return { mode: 'shadow', note: 'DistributionRequestEngine not available' };
    return await deps.Distribution.rejectRequest({
      requestId: payload.requestId || payload.id,
      trusteeEmail: payload.trusteeEmail,
      reason: payload.reason,
    });
  }

  static async _executeDistribution(payload) {
    const deps = await this._loadDeps();
    if (!deps.Distribution) return { mode: 'shadow', note: 'DistributionRequestEngine not available' };
    if (!this._isLive()) return { mode: 'shadow', note: 'Set BACK_OFFICE_LIVE=true to execute distributions' };
    return await deps.Distribution.executeRequest(payload.requestId || payload.id);
  }

  static async _batchProcess(payload) {
    if (!pool) return { mode: 'shadow', note: 'Postgres not available' };
    const batchId = id('BOB');
    const items = Array.isArray(payload.items) ? payload.items : [];
    await query(
      `INSERT INTO back_office_batches (id, type, status, items, metadata, initiated_by) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
      [batchId, payload.type || 'distribution', 'pending', safeJson(items), safeJson(payload.metadata || {}), payload.initiatedBy || 'system']
    );
    const results = [];
    for (const item of items) {
      if (!this._isLive()) {
        results.push({ action: item.action, status: 'shadow', note: 'BACK_OFFICE_LIVE not true' });
        continue;
      }
      try {
        let result;
        if (item.action === 'createDistribution') result = await this._createDistribution(item.payload || {});
        else if (item.action === 'approveDistribution') result = await this._approveDistribution(item.payload || {});
        else if (item.action === 'executeDistribution') result = await this._executeDistribution(item.payload || {});
        else throw new Error(`Unknown batch action: ${item.action}`);
        results.push({ action: item.action, status: 'completed', result });
      } catch (err) {
        results.push({ action: item.action, status: 'failed', error: err.message });
      }
    }
    const batchStatus = results.some((r) => r.status === 'failed') ? 'failed' : 'completed';
    await query(
      `UPDATE back_office_batches SET status = $1, result = $2::jsonb, updated_at = NOW() WHERE id = $3`,
      [batchStatus, safeJson(results), batchId]
    );
    return { batchId, type: payload.type || 'distribution', status: batchStatus, results };
  }

  static async _process(action, payload) {
    switch (action) {
      case 'status':
        return await this.status();
      case 'treasurySummary':
      case 'treasury-summary':
        return await this._treasurySummary();
      case 'bankReconciliation':
      case 'bank-reconciliation':
      case 'reconcile':
        return await this._bankReconciliation(payload || {});
      case 'listDistributions':
      case 'list-distributions':
      case 'list':
        return await this._listDistributions(payload || {});
      case 'getDistribution':
      case 'get-distribution':
      case 'get':
        return await this._getDistribution(payload || {});
      case 'createDistribution':
      case 'create-distribution':
      case 'create':
        return await this._createDistribution(payload || {});
      case 'approveDistribution':
      case 'approve-distribution':
      case 'approve':
        return await this._approveDistribution(payload || {});
      case 'rejectDistribution':
      case 'reject-distribution':
      case 'reject':
        return await this._rejectDistribution(payload || {});
      case 'executeDistribution':
      case 'execute-distribution':
      case 'execute':
        return await this._executeDistribution(payload || {});
      case 'batchProcess':
      case 'batch-process':
      case 'batch':
        return await this._batchProcess(payload || {});
      default:
        return await this.status();
    }
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
  bookkeeping: BookkeepingEngine,
  cash: CashOSEngine,
  'asset-acquisition': AssetAcquisitionEngine,
  'bank-aggregator': BankAccountAggregatorEngine,
  funding: FundingOSEngine,
  'smart-router': SmartRouterEngine,
  'back-office': BackOfficeEngine,
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
  BookkeepingEngine,
  CashOSEngine,
  AssetAcquisitionEngine,
  BankAccountAggregatorEngine,
  FundingOSEngine,
  SmartRouterEngine,
  BackOfficeEngine,
  engines: ENGINES,
  ensureAll,
};
