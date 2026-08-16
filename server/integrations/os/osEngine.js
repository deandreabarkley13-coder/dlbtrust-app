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
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

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
    if (!raw) return undefined;
    const s = String(raw).toLowerCase().replace(/\s+/g, '_');
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
    return Object.hasOwn(map, s) ? map[s] : undefined;
  }

  static assertAssetCategory(raw) {
    const category = this.normalizeCategory(raw);
    if (raw && !category) {
      throw new Error(`Invalid asset category: ${raw}. Valid: ${this.assetCategories.join(', ')}`);
    }
    if (category && !this.assetCategories.includes(category)) {
      throw new Error(`Invalid asset category: ${raw}. Valid: ${this.assetCategories.join(', ')}`);
    }
    return category;
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
        const category = this.assertAssetCategory(payload.category) || 'other';
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
      case 'list': {
        const listCategory = payload.category ? (this.assertAssetCategory(payload.category) || undefined) : undefined;
        return await Expense.listRecords({ type: 'asset', category: listCategory, status: payload.status, limit: payload.limit || 100 });
      }
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

  static _mapExternalStatus(status) {
    const s = String(status || '').toLowerCase();
    if (['settled', 'completed', 'success', 'finalized', 'done', 'captured', 'executed', 'committed'].includes(s)) return 'settled';
    if (['failed', 'rejected', 'error', 'canceled', 'cancelled', 'declined', 'returned', 'bounced', 'voided', 'refunded', 'reversed', 'disputed', 'expired'].includes(s)) return 'failed';
    if (['confirmed', 'approved', 'accepted', 'processed', 'authorized'].includes(s)) return 'confirmed';
    if (['pending', 'pending_review', 'submitted', 'initiated', 'in_progress', 'queued', 'scheduled'].includes(s)) return 'pending';
    return null;
  }

  static async _updateConfirmation(paymentId, confirmation, status) {
    if (!pool) return;
    const setParts = ['confirmation = $1::jsonb', 'updated_at = NOW()'];
    const values = [safeJson(confirmation || {})];
    if (status) { setParts.push(`status = $${values.length + 1}`); values.push(status); }
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
    const rawRes = await query('SELECT * FROM smart_router_payments WHERE id = $1', [paymentId]);
    const row = rawRes.rows[0];
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
      const mapped = this._mapExternalStatus(externalStatus.status);
      const status = mapped || row.status;
      const sanitizedExternalStatus = sanitize(externalStatus);
      const confirmation = { ...(row.confirmation || {}), externalStatus: sanitizedExternalStatus };
      await this._updateConfirmation(paymentId, confirmation, status);
      return { paymentId, rail: row.rail, status, externalStatus: sanitizedExternalStatus, confirmation: sanitize(confirmation) };
    }
    return { paymentId, rail: row.rail, status: row.status, confirmation: sanitize(row.confirmation), note: 'No external confirmation available' };
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
        return await this._confirm(payload, deps);
      case 'status':
        return await this.status();
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
        summary.totals.assetsCents += Math.round(Number(bs.total_assets || 0) * 100);
        summary.totals.liabilitiesCents += Math.round(Number(bs.total_liabilities || 0) * 100);
        summary.totals.equityCents += Math.round(Number(bs.total_equity || 0) * 100);
      } catch (e) { summary.sources.trustAccountingError = e.message; }
    }
    if (deps.Cash) {
      try {
        const pos = await deps.Cash.getPositionSummary();
        summary.sources.cash = pos;
        summary.totals.cashCents += Number(pos.grand_total_cents || 0);
      } catch (e) { summary.sources.cashError = e.message; }
    }
    if (deps.Bond) {
      try {
        const bonds = await deps.Bond.listBonds();
        summary.sources.bonds = bonds;
        summary.totals.bondsCents = Array.isArray(bonds)
          ? bonds.reduce((sum, b) => sum + Math.round(Number(b.principal_balance || b.face_value || 0) * 100), 0)
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

// ─── Wallet On-Ramp Engine ────────────────────────────────────────────────────
//
// Bridges PTC source-of-funds into real Base/Eth canonical assets for the
// Alchemy wallet, distributions, payouts, and bill-pay rails. Wraps the
// TreasuryOnRampBridgeEngine so the on-ramp flow is exposed through /api/os.

class WalletOnRampEngine extends BaseOSEngine {
  static get engineName() { return 'wallet-onramp'; }

  static _sof() { return tryRequire('../stablecoin/sourceOfFundsAdapter')?.SourceOfFundsAdapter; }
  static _treasury() { return tryRequire('../stablecoin/treasuryEngine')?.TreasuryEngine; }

  static _cfg() {
    const DappConfig = tryRequire('../dapp/config')?.getConfig;
    const cfg = DappConfig ? DappConfig() : {};
    return {
      enabled: (process.env.WALLET_ONRAMP_ENABLED || 'true') !== 'false',
      chainId: cfg.chainId || 8453,
      operatorAddress: cfg.operatorAddress || process.env.DAPP_OPERATOR_WALLET || '',
      defaultSourceMethod: process.env.WALLET_ONRAMP_DEFAULT_METHOD || 'manual',
      feeBps: Number(process.env.WALLET_ONRAMP_FEE_BPS || process.env.TREASURY_ON_RAMP_FEE_BPS || 0) || 0,
    };
  }

  static async ensureTables() {
    await super.ensureTables();
    if (!pool) return;
    await query(`
      CREATE TABLE IF NOT EXISTS wallet_onramp_requests (
        id TEXT PRIMARY KEY,
        source_type TEXT,
        source_account_id TEXT,
        source_method TEXT,
        target_address TEXT NOT NULL,
        asset TEXT NOT NULL,
        amount_cents BIGINT NOT NULL,
        hold_account TEXT,
        status TEXT NOT NULL DEFAULT 'awaiting_deposit' CHECK (status IN ('awaiting_deposit','pending_provider','completed','failed','cancelled')),
        tx_hash TEXT,
        instructions TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_wor_status ON wallet_onramp_requests(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_wor_address ON wallet_onramp_requests(target_address)`);
  }

  static async status() {
    const cfg = this._cfg();
    const providers = await this._providers();
    return { engine: 'wallet-onramp', healthy: true, enabled: cfg.enabled, chainId: cfg.chainId, operatorAddress: cfg.operatorAddress, providers, timestamp: new Date().toISOString() };
  }

  static async health() { return this.status(); }

  static _networkName() {
    const n = Number(this._cfg().chainId);
    if (n === 8453) return 'Base mainnet';
    if (n === 1) return 'Ethereum mainnet';
    if (n === 137) return 'Polygon mainnet';
    if (n === 42161) return 'Arbitrum One';
    return `chain ${n}`;
  }

  static _payloadDefaults(payload) {
    const cfg = this._cfg();
    const sourceType = payload.sourceType || payload.source_type || 'treasury';
    const sourceAccountId = payload.sourceAccountId || payload.source_account_id || 'TREASURY_HOT';
    const amount = payload.amount;
    const asset = payload.asset || 'USDC';
    const targetAddress = payload.targetAddress || payload.recipient || cfg.operatorAddress;
    const sourceMethod = payload.sourceMethod || payload.source_method || cfg.defaultSourceMethod;
    const onRampBankDetails = payload.onRampBankDetails || payload.on_ramp_bank_details || {};
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    if (!targetAddress) throw new Error('targetAddress required');
    return { sourceType, sourceAccountId, amount, asset, targetAddress, sourceMethod, onRampBankDetails };
  }

  static _providerReadiness(method) {
    if (method === 'moonpay') {
      const Cli = tryRequire('../onramps/moonpayCliEngine')?.MoonPayCliEngine;
      if (Cli) return Cli.readiness().catch(e => ({ method, ready: false, issues: [e.message] }));
    }
    const TORBE = tryRequire('../dapp/treasuryOnRampBridgeEngine')?.TreasuryOnRampBridgeEngine;
    if (TORBE && TORBE._onRampReadiness) {
      return TORBE._onRampReadiness(method).catch(() => ({ method, ready: false, issues: ['readiness check failed'] }));
    }
    if (method === 'manual') return { method, ready: true, issues: [] };
    return { method, ready: false, issues: ['Provider not configured'] };
  }

  static async _providers() {
    const methods = ['manual', 'circle_mint', 'coinbase_treasury', 'moonpay', 'core_banking_wire'];
    const providers = {};
    for (const m of methods) {
      try { providers[m] = await this._providerReadiness(m); } catch (e) { providers[m] = { method: m, ready: false, error: e.message }; }
    }
    return providers;
  }

  static async _buildInstructions(p) {
    const asset = String(p.asset || 'USDC').toUpperCase();
    const network = this._networkName();
    const onRampAmount = Number(p.onRampAmount || p.amount).toFixed(6);
    if (p.sourceMethod === 'manual') {
      return `Deposit ${onRampAmount} ${asset} on ${network} to ${p.targetAddress}. The fiat equivalent has been reserved from ${p.sourceType}:${p.sourceAccountId}. Once the deposit confirms, call POST /api/os/wallet-onramp/process with action continue, operationId ${p.operationId}, and txHash.`;
    }
    if (p.sourceMethod === 'circle_mint') return `Use Circle Mint to transfer ${onRampAmount} ${asset} to ${p.targetAddress} on ${network}. Requires CIRCLE_MINT_API_KEY.`;
    if (p.sourceMethod === 'coinbase_treasury') return `Use Coinbase Treasury to buy ${onRampAmount} ${asset} and withdraw to ${p.targetAddress} on ${network}.`;
    if (p.sourceMethod === 'moonpay') {
      const Cli = tryRequire('../onramps/moonpayCliEngine')?.MoonPayCliEngine;
      if (Cli) {
        try {
          const cfg = this._cfg();
          const buy = await Cli.buyUrl({ asset, chainId: cfg.chainId, walletAddress: p.targetAddress, amount: p.amount, explanation: `Wallet on-ramp ${p.operationId || ''}`.trim() });
          return `Complete MoonPay checkout to buy ${onRampAmount} ${asset} on ${network} into ${p.targetAddress}: ${buy.url}`;
        } catch (e) {
          return `Complete MoonPay on-ramp to buy ${onRampAmount} ${asset} into ${p.targetAddress} on ${network}. (Could not generate checkout URL: ${e.message})`;
        }
      }
      return `Complete MoonPay on-ramp to buy ${onRampAmount} ${asset} into ${p.targetAddress} on ${network}.`;
    }
    if (p.sourceMethod === 'core_banking_wire') return `Initiate a wire/ACH from ${p.sourceType}:${p.sourceAccountId} to the on-ramp bank beneficiary; once credited, the provider will send ${onRampAmount} ${asset} to ${p.targetAddress} on ${network}.`;
    return `On-ramp ${Number(p.amount).toFixed(2)} USD to ${asset} at ${p.targetAddress} via ${p.sourceMethod} on ${network}. Provider ready: ${p.providerReady}.`;
  }

  static async _quote(payload = {}) {
    const SOF = this._sof();
    if (!SOF) throw new Error('SourceOfFundsAdapter not available');
    const p = this._payloadDefaults(payload);
    const balanceCents = await SOF.getBalance({ sourceType: p.sourceType, sourceAccountId: p.sourceAccountId });
    const amountCents = Math.round(Number(p.amount) * 100);
    if (Number(balanceCents) < amountCents) throw new Error(`Insufficient source balance: ${balanceCents} cents < ${amountCents}`);
    const cfg = this._cfg();
    const feeBps = cfg.feeBps;
    const onRampAmount = Number(p.amount) * (1 - feeBps / 10000);
    const provider = await this._providerReadiness(p.sourceMethod);
    const asset = String(p.asset).toUpperCase();
    const instructions = await this._buildInstructions({ ...p, operationId: null, onRampAmount, providerReady: provider.ready });
    return { sourceType: p.sourceType, sourceAccountId: p.sourceAccountId, amount: p.amount, amountCents, asset, targetAddress: p.targetAddress, sourceMethod: p.sourceMethod, feeBps, onRampAmount, sourceBalanceCents: balanceCents, providerReady: provider.ready, instructions, status: provider.ready ? 'awaiting_deposit' : 'needs_config' };
  }

  static async _reserveSourceToHold({ sourceType, sourceAccountId, amount, operationId, targetAddress }) {
    const SourceOfFundsAdapter = this._sof();
    const TreasuryEngine = this._treasury();
    if (!SourceOfFundsAdapter || !TreasuryEngine) return null;
    const amountCents = Math.round(Number(amount) * 100);
    const sweep = await SourceOfFundsAdapter._fundSourceToTreasury({ sourceType, sourceAccountId, paymentId: operationId, amountCents });
    await TreasuryEngine.debit('TREASURY_HOT', amountCents, { reason: `Wallet on-ramp ${operationId}`, source: 'wallet_onramp' });
    await TreasuryEngine.credit('ALCHEMY-FUNDING-HOLD', amountCents, { source: 'wallet_onramp', metadata: { operationId, sourceType, sourceAccountId, targetAddress } });
    return { sweep, holdAccount: 'ALCHEMY-FUNDING-HOLD', amountCents };
  }

  static async _fund(payload = {}) {
    const p = this._payloadDefaults(payload);
    const quote = await this._quote(payload);
    const operationId = id('WOR-');
    const reserve = quote.providerReady ? await this._reserveSourceToHold({ sourceType: p.sourceType, sourceAccountId: p.sourceAccountId, amount: p.amount, operationId, targetAddress: p.targetAddress }) : null;
    const status = quote.providerReady ? 'awaiting_deposit' : 'needs_config';
    const instructions = await this._buildInstructions({ ...p, operationId, onRampAmount: quote.onRampAmount, providerReady: quote.providerReady });
    if (pool) {
      await query(`
        INSERT INTO wallet_onramp_requests (id, source_type, source_account_id, source_method, target_address, asset, amount_cents, hold_account, status, instructions, metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
      `, [operationId, p.sourceType, p.sourceAccountId, p.sourceMethod, p.targetAddress.toLowerCase(), String(p.asset).toUpperCase(), quote.amountCents, reserve?.holdAccount || null, status, instructions, safeJson({ quote, reserve, onRampBankDetails: p.onRampBankDetails, createdBy: 'wallet-onramp' })]);
    }
    return { operationId, quote: { ...quote, instructions }, targetAddress: p.targetAddress, sourceMethod: p.sourceMethod, reserve, instructions, status };
  }

  static async _getOperation(payload = {}) {
    if (!pool) return null;
    const opId = payload.operationId || payload.id || payload.operation_id;
    if (!opId) throw new Error('operationId required');
    const res = await query('SELECT * FROM wallet_onramp_requests WHERE id = $1', [opId]);
    return res.rows[0] || null;
  }

  static async _listOperations(payload = {}) {
    if (!pool) return [];
    const limit = Number(payload.limit) || 50;
    const offset = Number(payload.offset) || 0;
    const status = payload.status;
    let sql = 'SELECT * FROM wallet_onramp_requests ORDER BY created_at DESC LIMIT $1 OFFSET $2';
    const params = [limit, offset];
    if (status) { sql = 'SELECT * FROM wallet_onramp_requests WHERE status = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3'; params.unshift(status); }
    const res = await query(sql, params);
    return res.rows;
  }

  static async _continue(payload = {}) {
    const opId = payload.operationId || payload.id || payload.operation_id;
    if (!opId) throw new Error('operationId required');
    const op = await this._getOperation({ id: opId });
    if (!op) throw new Error('Operation not found');
    if (op.status === 'completed') return op;
    if (op.source_method === 'manual' || op.source_method === 'moonpay') {
      const txHash = payload.txHash || payload.tx_hash;
      if (!txHash) {
        if (op.source_method === 'moonpay') {
          const Cli = tryRequire('../onramps/moonpayCliEngine')?.MoonPayCliEngine;
          if (Cli) {
            try {
              const buy = await Cli.buyUrl({ asset: op.asset, chainId: this._cfg().chainId, walletAddress: op.target_address, amount: (op.amount_cents / 100).toFixed(2), explanation: `Wallet on-ramp continue ${opId}` });
              await query(`UPDATE wallet_onramp_requests SET instructions=$1, metadata=metadata || $2::jsonb, updated_at=NOW() WHERE id=$3`, [buy.url, safeJson({ moonpay: buy, continuedAt: new Date().toISOString() }), opId]);
              return { ...op, instructions: buy.url, moonpay: buy, status: 'awaiting_deposit' };
            } catch (e) {
              return { ...op, status: 'awaiting_deposit', error: e.message };
            }
          }
        }
        throw new Error('txHash required to confirm on-ramp deposit');
      }
      await query(`UPDATE wallet_onramp_requests SET status='completed', tx_hash=$1, updated_at=NOW(), metadata=metadata || $2::jsonb WHERE id=$3`, [txHash, safeJson({ confirmedAt: new Date().toISOString() }), opId]);
      return { ...op, status: 'completed', txHash };
    }
    const TORBE = tryRequire('../dapp/treasuryOnRampBridgeEngine')?.TreasuryOnRampBridgeEngine;
    if (!TORBE) throw new Error('TreasuryOnRampBridgeEngine not available for provider on-ramp continuation');
    return await TORBE.continue({ operationId: opId, onRampBankDetails: payload.onRampBankDetails || payload.on_ramp_bank_details || {} });
  }

  static async _execute(payload = {}) { return await this._continue(payload); }

  static async _process(action, payload) {
    switch (action) {
      case 'status': return await this.status();
      case 'health': return await this.health();
      case 'providers': return await this._providers();
      case 'quote': return await this._quote(payload);
      case 'fund':
      case 'fund-wallet':
      case 'fundAgentWallet':
        return await this._fund(payload);
      case 'getOperation':
      case 'get-operation':
      case 'operation':
        return await this._getOperation(payload);
      case 'listOperations':
      case 'list-operations':
      case 'operations':
        return await this._listOperations(payload);
      case 'continue':
        return await this._continue(payload);
      case 'execute':
        return await this._execute(payload);
      default:
        return await this.status();
    }
  }
}
// ─── Alchemy Wallet Engine ─────────────────────────────────────────────────────
//
// Manages Alchemy CLI wallets (local + Agent session), queries balances via
// Alchemy RPC, funds wallets from GL source-of-funds accounts, and sends on
// Base/Eth mainnet through the Alchemy CLI signer.

class AlchemyWalletEngine extends BaseOSEngine {
  static get engineName() { return 'alchemy-wallet'; }

  static async ensureTables() {
    await super.ensureTables();
    if (!pool) return;
    await query(`
      CREATE TABLE IF NOT EXISTS alchemy_wallet_funding_requests (
        id TEXT PRIMARY KEY,
        source_type TEXT,
        source_account_id TEXT,
        target_address TEXT NOT NULL,
        asset TEXT NOT NULL,
        amount_cents BIGINT NOT NULL,
        hold_account TEXT,
        status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','completed','pending_crypto','cancelled')),
        funding_metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_awfr_status ON alchemy_wallet_funding_requests(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_awfr_address ON alchemy_wallet_funding_requests(target_address)`);
  }

  static _alchemyApiEnv() {
    const DappConfig = tryRequire('../dapp/config')?.getConfig;
    const cfg = DappConfig ? DappConfig() : {};
    return {
      ...process.env,
      ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY || cfg.alchemyApiKey || '',
    };
  }

  static async _exec(args, { timeout = 60000, envExtra = {} } = {}) {
    const env = { ...this._alchemyApiEnv(), ...envExtra };
    try {
      const { stdout, stderr } = await execFileAsync('alchemy', ['--json', '--no-interactive', ...args], { timeout, env });
      if (stderr) console.warn(`[alchemy-wallet] stderr: ${stderr.trim()}`);
      if (!stdout || !stdout.trim()) return {};
      return JSON.parse(stdout);
    } catch (err) {
      let parsed = null;
      try { parsed = JSON.parse(err.stdout || ''); } catch {}
      if (parsed && parsed.error) {
        const e = new Error(parsed.error.message || 'Alchemy CLI error');
        e.code = parsed.error.code;
        throw e;
      }
      throw new Error(`Alchemy CLI failed: ${err.message || err}`);
    }
  }

  static _networkName(chainId) {
    const map = {
      1: 'eth-mainnet',
      8453: 'base-mainnet',
      137: 'polygon-mainnet',
      42161: 'arb-mainnet',
      11155111: 'eth-sepolia',
    };
    return map[chainId] || 'base-mainnet';
  }

  static _dappConfig() {
    try {
      const { getConfig } = require('../dapp/config');
      return getConfig();
    } catch (e) { return {}; }
  }

  static async _getWallets() {
    const data = await this._exec(['wallet', 'address']);
    return {
      evm: data.evm || null,
      solana: data.solana || null,
      sessionEvm: data.session && data.session.evm ? data.session.evm : null,
      activeSigner: data.activeSigner || 'local',
    };
  }

  static async status() {
    const cfg = this._dappConfig();
    const cli = await this._exec(['wallet', 'status', '--verify']).catch((e) => ({ error: e.message }));
    const wallets = await this._getWallets().catch((e) => ({ error: e.message }));
    return {
      engine: 'alchemy-wallet',
      healthy: !cli.error,
      mode: process.env.ALCHEMY_WALLET_SEND_LIVE === 'true' ? 'live' : 'shadow',
      alchemyApiKeyConfigured: !!(process.env.ALCHEMY_API_KEY || cfg.alchemyApiKey),
      chainId: cfg.chainId || 8453,
      network: this._networkName(cfg.chainId || 8453),
      cli,
      wallets,
      timestamp: new Date().toISOString(),
    };
  }

  static async health() { return this.status(); }

  static async _getBalancesForAddress(address) {
    if (!address) throw new Error('address required');
    const DappEngine = tryRequire('../dapp/dappEngine')?.DappEngine;
    if (DappEngine && DappEngine.getWalletBalances) {
      return await DappEngine.getWalletBalances({ chain: 'evm', address });
    }
    const bal = await this._exec(['evm', 'data', 'balance', address, '-n', this._networkName(this._dappConfig().chainId || 8453)]);
    return {
      chain: this._dappConfig().chainId || 8453,
      address,
      native: { symbol: 'ETH', balance: String(bal) },
      usdc: null,
    };
  }

  static async _switchSigner(signer) {
    if (!['local', 'session'].includes(signer)) throw new Error('signer must be local or session');
    return await this._exec(['wallet', 'use', signer]);
  }

  static async _createLocalWallet() {
    return await this._exec(['wallet', 'connect', '--mode', 'local']);
  }

  static async _ensureCashHoldingAccount() {
    const CashEngine = tryRequire('../cash/cashEngine')?.CashEngine;
    if (!CashEngine) return null;
    const StablecoinConfig = tryRequire('../stablecoin/config')?.getConfig;
    const holdingId = StablecoinConfig ? StablecoinConfig().cashHoldingAccount : 'STABLECOIN_CASH_HOLD';
    try {
      const acct = await CashEngine.getAccount(holdingId);
      if (acct) return acct;
    } catch (e) { /* will create */ }
    return await CashEngine.createAccount({
      accountId: holdingId,
      accountName: 'Stablecoin Cash Holding',
      accountType: 'escrow',
      notes: 'Holding account for stablecoin source-of-funds sweeps',
    });
  }

  static async _ensureFundingHoldAccount() {
    const TreasuryEngine = tryRequire('../stablecoin/treasuryEngine')?.TreasuryEngine;
    if (!TreasuryEngine) throw new Error('TreasuryEngine not available');
    return await TreasuryEngine.getOrCreateAccount('ALCHEMY-FUNDING-HOLD', { type: 'reserve', network: 'mainnet', assetCode: 'USD' });
  }

  static async _reserveSourceFunds({ sourceType, sourceAccountId, amountCents, memo }) {
    const SourceOfFundsAdapter = tryRequire('../stablecoin/sourceOfFundsAdapter')?.SourceOfFundsAdapter;
    const TreasuryEngine = tryRequire('../stablecoin/treasuryEngine')?.TreasuryEngine;
    if (!SourceOfFundsAdapter || !TreasuryEngine) throw new Error('Funding adapters not available');
    const paymentId = id('AWF-RESERVE');

    if (String(sourceType).toLowerCase() === 'cash') {
      await this._ensureCashHoldingAccount();
    }

    if (String(sourceType).toLowerCase() === 'treasury') {
      const pos = await TreasuryEngine.getPosition(sourceAccountId || 'TREASURY_HOT');
      if (Number(pos.availableCents || 0) < amountCents) throw new Error(`Insufficient treasury balance: ${pos.availableCents || 0} < ${amountCents}`);
      await TreasuryEngine.debit(sourceAccountId || 'TREASURY_HOT', amountCents, { reason: `Alchemy wallet fund ${paymentId}`, source: 'alchemy_wallet_fund' });
      await this._ensureFundingHoldAccount();
      await TreasuryEngine.credit('ALCHEMY-FUNDING-HOLD', amountCents, { source: 'alchemy_wallet_fund', metadata: { paymentId, sourceType, sourceAccountId, memo } });
      return { sourceType, sourceAccountId, holdAccount: 'ALCHEMY-FUNDING-HOLD', amountCents, paymentId };
    }

    const sweep = await SourceOfFundsAdapter._fundSourceToTreasury({ sourceType, sourceAccountId, paymentId, amountCents });
    await this._ensureFundingHoldAccount();
    await TreasuryEngine.debit('TREASURY_HOT', amountCents, { reason: `Alchemy wallet fund ${paymentId}`, source: 'alchemy_wallet_fund', metadata: { sourceType, sourceAccountId, sweep, memo } });
    await TreasuryEngine.credit('ALCHEMY-FUNDING-HOLD', amountCents, { source: 'alchemy_wallet_fund', metadata: { paymentId, sourceType, sourceAccountId, sweep, memo } });
    return { sourceType, sourceAccountId, holdAccount: 'ALCHEMY-FUNDING-HOLD', amountCents, paymentId, sweep };
  }

  static async _ensureWalletRecord(address) {
    const WalletEngine = tryRequire('../dapp/walletEngine')?.WalletEngine;
    if (!WalletEngine) throw new Error('WalletEngine not available');
    const existing = await WalletEngine.getWalletByAddress(address);
    if (existing) return existing;
    const systemUser = await WalletEngine.getSystemUser();
    return await WalletEngine.createWallet({
      userId: systemUser.id,
      name: `Alchemy Wallet ${address.slice(-6)}`,
      type: 'external',
      address,
      metadata: { provider: 'alchemy', createdBy: 'AlchemyWalletEngine' },
    });
  }

  static _isInternalAsset(asset) {
    return ['SIT', 'DLBUSD', 'PTCUSD', 'DLB-PTCUSD'].includes(String(asset || '').toUpperCase());
  }

  static async _creditInternalWallet({ targetAddress, asset, amount, sourceType, sourceAccountId, paymentId, memo }) {
    const WalletEngine = tryRequire('../dapp/walletEngine')?.WalletEngine;
    const TreasuryEngine = tryRequire('../stablecoin/treasuryEngine')?.TreasuryEngine;
    if (!WalletEngine) throw new Error('WalletEngine not available');
    const wallet = await this._ensureWalletRecord(targetAddress);
    const metadata = { memo: memo || `Alchemy fund from ${sourceType}:${sourceAccountId} (${paymentId})`, sourceType, sourceAccountId, paymentId };
    await WalletEngine.credit(wallet.id, asset, amount, metadata);
    if (TreasuryEngine) {
      try {
        await TreasuryEngine.debit('ALCHEMY-FUNDING-HOLD', Math.round(Number(amount) * 100), { reason: `Issue ${asset} to ${wallet.id}`, source: 'alchemy_wallet_fund' });
      } catch (e) { console.warn('[AlchemyWalletEngine] hold debit failed:', e.message); }
    }
    return { walletId: wallet.id, address: targetAddress, asset, amount, internalBalance: await WalletEngine.getBalance(wallet.id) };
  }

  static async _fundFromSource(payload) {
    const { sourceType, sourceAccountId, amount, asset = 'USDC', targetAddress, memo, sourceMethod } = payload || {};
    if (!sourceType || !sourceAccountId) throw new Error('sourceType and sourceAccountId required');
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    if (!targetAddress || !String(targetAddress).startsWith('0x')) throw new Error('targetAddress must be a 0x EVM address');
    const SourceOfFundsAdapter = tryRequire('../stablecoin/sourceOfFundsAdapter')?.SourceOfFundsAdapter;
    if (!SourceOfFundsAdapter) throw new Error('SourceOfFundsAdapter not available');
    const balanceCents = await SourceOfFundsAdapter.getBalance({ sourceType, sourceAccountId });
    const amountCents = Math.round(Number(amount) * 100);
    if (Number(balanceCents) < amountCents) throw new Error(`Insufficient source balance: ${balanceCents} cents < ${amountCents}`);

    const requestId = id('AWF');
    let result = { requestId, amount, asset, targetAddress, sourceType, sourceAccountId };

    if (this._isInternalAsset(asset)) {
      const reserve = await this._reserveSourceFunds({ sourceType, sourceAccountId, amountCents, memo });
      const credit = await this._creditInternalWallet({ targetAddress, asset, amount, sourceType, sourceAccountId, paymentId: reserve.paymentId, memo });
      result = { ...result, reserve, credit, status: 'completed', completed: true };
    } else {
      const onRamp = await WalletOnRampEngine._fund({ sourceType, sourceAccountId, amount, asset, targetAddress, sourceMethod, memo });
      result = { ...result, onRampOperationId: onRamp.operationId, status: 'pending_crypto', onRamp, completed: false };
    }

    if (pool) {
      await query(`
        INSERT INTO alchemy_wallet_funding_requests (id, source_type, source_account_id, target_address, asset, amount_cents, hold_account, status, funding_metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
      `, [requestId, sourceType, sourceAccountId, targetAddress.toLowerCase(), asset.toUpperCase(), amountCents, (result.reserve?.holdAccount || result.onRamp?.reserve?.holdAccount || null), result.status, safeJson({ memo, onRamp: result.onRamp, onRampOperationId: result.onRampOperationId })]);
    }
    return result;
  }

  static async _listFundingRequests(payload) {
    if (!pool) return [];
    const limit = Number(payload.limit) || 50;
    const status = payload.status;
    let sql = 'SELECT * FROM alchemy_wallet_funding_requests ORDER BY created_at DESC LIMIT $1';
    const params = [limit];
    if (status) {
      sql = 'SELECT * FROM alchemy_wallet_funding_requests WHERE status = $1 ORDER BY created_at DESC LIMIT $2';
      params.unshift(status);
    }
    const res = await query(sql, params);
    return res.rows;
  }

  static async _getFundingRequest(payload) {
    if (!pool) throw new Error('Postgres not available');
    if (!payload.requestId && !payload.id) throw new Error('requestId required');
    const res = await query('SELECT * FROM alchemy_wallet_funding_requests WHERE id = $1', [payload.requestId || payload.id]);
    return res.rows[0] || null;
  }

  static async _confirmDeposit(payload) {
    if (!pool) throw new Error('Postgres not available');
    const { requestId, txHash, amount, asset } = payload || {};
    if (!requestId) throw new Error('requestId required');
    const existing = await this._getFundingRequest({ requestId });
    if (!existing) throw new Error(`Funding request not found: ${requestId}`);
    const newStatus = 'completed';
    await query(`UPDATE alchemy_wallet_funding_requests SET status = $1, funding_metadata = funding_metadata || $2::jsonb, updated_at = NOW() WHERE id = $3`, [newStatus, safeJson({ confirmedAt: new Date().toISOString(), txHash, confirmedAmount: amount, confirmedAsset: asset }), requestId]);
    const onRampOpId = existing.funding_metadata?.onRamp?.operationId || existing.funding_metadata?.onRampOperationId;
    if (onRampOpId) {
      try {
        await WalletOnRampEngine._continue({ operationId: onRampOpId, txHash });
      } catch (e) {
        console.warn('[AlchemyWalletEngine] wallet-onramp continue failed:', e.message);
      }
    }
    return { requestId, status: newStatus, txHash, note: 'Deposit confirmed. The GL reserve can now be released to the wallet when the treasury settles crypto.' };
  }

  static async _cancelFundingRequest(payload) {
    if (!pool) throw new Error('Postgres not available');
    const { requestId } = payload || {};
    if (!requestId) throw new Error('requestId required');
    const existing = await this._getFundingRequest({ requestId });
    if (!existing) throw new Error(`Funding request not found: ${requestId}`);
    if (existing.status === 'completed') throw new Error('Cannot cancel completed request');
    await query(`UPDATE alchemy_wallet_funding_requests SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [requestId]);
    return { requestId, status: 'cancelled', note: 'Funding request cancelled; reverse the source hold manually if needed.' };
  }

  static _operatingConfig(payload = {}) {
    return {
      operatingAccountId: payload.operatingAccountId || process.env.AGENT_WALLET_OPERATING_ACCOUNT || 'CA-OPERATING',
      replenishSourceAccountId: payload.replenishSourceAccountId || process.env.AGENT_WALLET_REPLENISH_SOURCE || 'CA-BOND-PROCEEDS',
      autoReplenish: payload.autoReplenish !== false && (process.env.AGENT_WALLET_AUTO_REPLENISH || 'true') !== 'false',
      sourceMethod: payload.sourceMethod || process.env.AGENT_WALLET_SOURCE_METHOD || 'manual',
    };
  }

  static async _fundFromOperating(payload = {}) {
    const { amount, asset = 'USDC', targetAddress, memo } = payload || {};
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    const cfg = this._operatingConfig(payload);
    const SourceOfFundsAdapter = tryRequire('../stablecoin/sourceOfFundsAdapter')?.SourceOfFundsAdapter;
    const CashEngine = tryRequire('../cash/cashEngine')?.CashEngine;
    if (!SourceOfFundsAdapter || !CashEngine) throw new Error('SourceOfFundsAdapter or CashEngine not available');
    const amountCents = Math.round(Number(amount) * 100);
    const wallets = await this._getWallets().catch(() => ({ evm: null, sessionEvm: null }));
    const resolvedTarget = targetAddress || payload.address || wallets.sessionEvm || wallets.evm || '';
    if (!String(resolvedTarget).startsWith('0x')) throw new Error('targetAddress must be a 0x EVM address');

    let operatingBalance = Number(await SourceOfFundsAdapter.getBalance({ sourceType: 'cash', sourceAccountId: cfg.operatingAccountId }));
    let replenishment = null;
    if (operatingBalance < amountCents) {
      if (!cfg.autoReplenish) throw new Error(`Insufficient operating balance: ${operatingBalance} cents < ${amountCents}`);
      const replenishAmountCents = amountCents - operatingBalance;
      const replenishBalance = Number(await SourceOfFundsAdapter.getBalance({ sourceType: 'cash', sourceAccountId: cfg.replenishSourceAccountId }));
      if (replenishBalance < replenishAmountCents) throw new Error(`Insufficient replenish source balance: ${replenishBalance} cents < ${replenishAmountCents}`);
      const movement = await CashEngine.transfer({
        fromAccountId: cfg.replenishSourceAccountId,
        toAccountId: cfg.operatingAccountId,
        amountCents: replenishAmountCents,
        movementType: 'transfer',
        memo: `Replenish operating account for Agent Wallet fund`,
        referenceId: `AWF-REPLENISH-${Date.now()}`,
        referenceType: 'alchemy_wallet_fund',
      });
      replenishment = { from: cfg.replenishSourceAccountId, to: cfg.operatingAccountId, amountCents: replenishAmountCents, movementId: movement.movement_id };
      operatingBalance += replenishAmountCents;
    }
    if (operatingBalance < amountCents) throw new Error(`Operating account still insufficient after replenishment: ${operatingBalance} cents < ${amountCents}`);

    const sourceMemo = memo || `Agent Wallet operating fund${replenishment ? ` (replenished from ${cfg.replenishSourceAccountId})` : ''}`;
    const result = await this._fundFromSource({
      sourceType: 'cash',
      sourceAccountId: cfg.operatingAccountId,
      amount,
      asset,
      targetAddress: resolvedTarget,
      sourceMethod: cfg.sourceMethod,
      memo: sourceMemo,
    });
    if (pool && result.requestId) {
      await query(`UPDATE alchemy_wallet_funding_requests SET funding_metadata = funding_metadata || $1::jsonb WHERE id = $2`, [safeJson({ operatingAccountId: cfg.operatingAccountId, replenishment, agentWalletFund: true }), result.requestId]);
    }
    return { ...result, operatingAccountId: cfg.operatingAccountId, replenishment };
  }

  static async _tokenAddressForAsset(asset) {
    const cfg = this._dappConfig();
    const upper = String(asset || '').toUpperCase();
    if (upper === 'ETH' || upper === (cfg.nativeTokenSymbol || 'ETH').toUpperCase()) return null;
    if (upper === 'USDC') return cfg.usdcAddress;
    if (upper === 'WETH') return cfg.wethAddress;
    if (upper === 'USDT') return process.env.DAPP_USDT_ADDRESS || '';
    return String(asset || '').startsWith('0x') ? asset : '';
  }

  static async _send(payload) {
    const { to, amount, asset = 'ETH', tokenAddress, signer, dryRun, confirm, memo } = payload || {};
    if (!to || !String(to).startsWith('0x')) throw new Error('to must be 0x address');
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    const cfg = this._dappConfig();
    const network = this._networkName(cfg.chainId || 8453);
    const wallets = await this._getWallets();
    const active = signer || wallets.activeSigner || 'local';
    const token = tokenAddress || await this._tokenAddressForAsset(asset);
    const isLive = process.env.ALCHEMY_WALLET_SEND_LIVE === 'true' && confirm === true && dryRun !== true;
    const args = ['evm', 'send', to, String(amount), '-n', network];
    if (token) args.push('--token', token);
    if (active) args.push('--signer', active);
    if (!isLive) args.push('--dry-run');
    const result = await this._exec(args, { timeout: 120000 });
    return { ...result, network, asset: token ? String(asset).toUpperCase() : (cfg.nativeTokenSymbol || 'ETH'), signer: active, live: isLive, preview: !isLive, memo };
  }

  static async _process(action, payload) {
    switch (action) {
      case 'status': return await this.status();
      case 'health': return await this.health();
      case 'listWallets':
      case 'list-wallets':
        return await this._getWallets();
      case 'getBalances':
      case 'get-balances':
      case 'balances':
        return await this._getBalancesForAddress(payload.address || payload.targetAddress || (await this._getWallets()).evm);
      case 'switchSigner':
      case 'switch-signer':
        return await this._switchSigner(payload.signer);
      case 'createLocalWallet':
      case 'create-local-wallet':
      case 'createWallet':
        return await this._createLocalWallet();
      case 'sessionStatus':
      case 'session-status':
        return await this._exec(['wallet', 'status', '--verify']);
      case 'listSourceBalances':
      case 'list-source-balances':
      case 'sources': {
        const DappEngine = tryRequire('../dapp/dappEngine')?.DappEngine;
        if (DappEngine && DappEngine.listSourceBalances) return await DappEngine.listSourceBalances();
        return { mode: 'shadow', note: 'DappEngine not available' };
      }
      case 'fundFromSource':
      case 'fund-from-source':
      case 'fund':
        return await this._fundFromSource(payload || {});
      case 'listFundingRequests':
      case 'list-funding-requests':
      case 'fundingRequests':
        return await this._listFundingRequests(payload || {});
      case 'getFundingRequest':
      case 'get-funding-request':
      case 'fundingRequest':
        return await this._getFundingRequest(payload || {});
      case 'confirmDeposit':
      case 'confirm-deposit':
        return await this._confirmDeposit(payload || {});
      case 'cancelFundingRequest':
      case 'cancel-funding-request':
      case 'cancel':
        return await this._cancelFundingRequest(payload || {});
      case 'fundFromOperating':
      case 'fund-operating':
      case 'fundAgentWalletFromOperating':
      case 'fundOperatingToAgent':
        return await this._fundFromOperating(payload || {});
      case 'send':
      case 'transfer':
      case 'evm-send':
        return await this._send(payload || {});
      default:
        return await this.status();
    }
  }
}

// ─── Tokenization Engine ──────────────────────────────────────────────────────

class TokenizationEngine extends BaseOSEngine {
  static get engineName() { return 'tokenization'; }

  static _dappConfig() {
    try {
      const { getConfig } = require('../dapp/config');
      return getConfig();
    } catch (e) { return {}; }
  }

  static _deps() {
    const BondTokenization = tryRequire('../dapp/bondTokenizationEngine')?.BondTokenizationEngine || null;
    const PtcStablecoin = tryRequire('../dapp/ptcStablecoinEngine')?.PtcStablecoinEngine || null;
    const DexSwap = tryRequire('../dapp/dexSwapEngine')?.DexSwapEngine || null;
    const BondEngine = tryRequire('../bonds/bondEngine')?.BondEngine || null;
    const LiveBond = tryRequire('../bonds/liveEngine')?.LiveBondEngine || null;
    const SourceOfFunds = tryRequire('../stablecoin/sourceOfFundsAdapter')?.SourceOfFundsAdapter || null;
    return { BondTokenization, PtcStablecoin, DexSwap, BondEngine, LiveBond, SourceOfFunds };
  }

  static _isShadow() {
    if (process.env.TOKENIZATION_SHADOW === 'true') return true;
    const cfg = this._dappConfig();
    if (!cfg.privateKey || cfg.dappShadow || cfg.dappShadow === true) return true;
    if (process.env.DAPP_SHADOW === 'true') return true;
    return false;
  }

  static async ensureTables() {
    await super.ensureTables();
    if (!pool) return;
    await query(`
      CREATE TABLE IF NOT EXISTS tokenization_events (
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        source_type TEXT,
        source_account_id TEXT,
        amount NUMERIC NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        tx_hash TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_tokenization_events_operation ON tokenization_events(operation)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_tokenization_events_status ON tokenization_events(status)`);
  }

  static async status() {
    const cfg = this._dappConfig();
    const deps = this._deps();
    const shadow = this._isShadow();
    const issues = [];
    if (!cfg.chainId) issues.push('DAPP_CHAIN_ID not configured');
    if (!cfg.usdcAddress) issues.push('DAPP_USDC_ADDRESS not configured');
    if (!cfg.privateKey && !shadow) issues.push('DAPP_PRIVATE_KEY not configured (running shadow)');
    if (!deps.BondTokenization) issues.push('BondTokenizationEngine not available');
    if (!deps.PtcStablecoin) issues.push('PtcStablecoinEngine not available');
    if (!deps.DexSwap) issues.push('DexSwapEngine not available');
    if (!deps.BondEngine) issues.push('BondEngine not available');
    if (!deps.SourceOfFunds) issues.push('SourceOfFundsAdapter not available');
    const ready = shadow || issues.filter((i) => !i.includes('running shadow')).length === 0;
    return {
      engine: this.engineName,
      healthy: true,
      mode: shadow ? 'shadow' : 'live',
      chainId: cfg.chainId || 8453,
      usdcAddress: cfg.usdcAddress || '',
      operatorAddress: cfg.operatorAddress || '',
      agentWallet: process.env.AGENT_WALLET_ADDRESS || '0x69a32f285ced1dbf102c7baedf0266f1d39580a1',
      ready,
      issues,
      timestamp: new Date().toISOString(),
    };
  }

  static async _recordOperation(operation, payload, result, status = 'completed') {
    const eventId = id('TOK');
    if (pool) {
      try {
        await query(
          `INSERT INTO tokenization_events (id, operation, source_type, source_account_id, amount, status, tx_hash, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
          [eventId, operation, payload.sourceType || null, payload.sourceAccountId || null, Number(payload.amount) || 0, status, result.txHash || null, safeJson({ payload, result })]
        );
      } catch (e) { console.warn(`[${this.engineName}] record operation failed:`, e.message); }
    }
    return eventId;
  }

  static async _reserveSource({ sourceType, sourceAccountId, amount, paymentId }) {
    const deps = this._deps();
    if (!deps.SourceOfFunds) throw new Error('SourceOfFundsAdapter not available');
    const amountCents = Math.round(Number(amount) * 100);
    const reserve = await deps.SourceOfFunds.reserve({
      id: paymentId,
      source_type: sourceType,
      source_account_id: sourceAccountId,
      total_cents: amountCents,
    });
    return reserve;
  }

  static async _tokenizeBondInterest({ bondId, amount, tokenName, tokenSymbol, paymentId }) {
    const deps = this._deps();
    if (!deps.BondEngine) throw new Error('BondEngine not available');
    if (!deps.BondTokenization) throw new Error('BondTokenizationEngine not available');
    const cfg = this._dappConfig();
    const operatorAddress = cfg.operatorAddress || process.env.DAPP_OPERATOR_ADDRESS || process.env.AGENT_WALLET_ADDRESS || '0x69a32f285ced1dbf102c7baedf0266f1d39580a1';

    const bond = await deps.BondEngine.getBond(bondId);
    if (!bond) throw new Error(`Bond not found: ${bondId}`);

    const token = await deps.BondTokenization.createToken({
      bondId: Number(bondId),
      tokenName: tokenName || `${bond.bond_name} Interest Token`,
      tokenSymbol: tokenSymbol || `DLB-${bond.id}-INT`,
      decimals: 6,
    });

    const mint = await deps.BondTokenization.mint({
      tokenId: token.id,
      principal: 0,
      interest: Number(amount),
      holderAddress: operatorAddress,
    });

    return { bond, bondToken: token, mint, paymentId, operatorAddress };
  }

  static async _mintStablecoin({ bondTokenAddress, amount, recipient } = {}) {
    const deps = this._deps();
    if (!deps.PtcStablecoin) throw new Error('PtcStablecoinEngine not available');
    if (!bondTokenAddress) throw new Error('bondTokenAddress required');
    if (!this._isShadow() && !String(bondTokenAddress).startsWith('0x')) throw new Error('bondTokenAddress must be a 0x address in live mode');
    const cfg = this._dappConfig();
    const to = recipient || cfg.operatorAddress || process.env.DAPP_OPERATOR_ADDRESS || process.env.AGENT_WALLET_ADDRESS || '0x69a32f285ced1dbf102c7baedf0266f1d39580a1';
    if (!to || !String(to).startsWith('0x')) throw new Error('recipient/operatorAddress required');

    if (this._isShadow()) {
      return {
        mode: 'shadow',
        tokenAddress: `shadow-ptcusd-${Date.now()}`,
        vaultAddress: `shadow-vault-${Date.now()}`,
        bondTokenAddress,
        minted: Number(amount),
        recipient: to,
        note: 'Shadow PTC stablecoin mint; set DAPP_PRIVATE_KEY and DAPP_SHADOW=false for live deployment',
      };
    }

    if (!cfg.privateKey) throw new Error('DAPP_PRIVATE_KEY not configured for live stablecoin mint');
    const deploy = await deps.PtcStablecoin.deploy({ tokenName: 'DLB PTC Stablecoin', tokenSymbol: 'DLB-PTCUSD' });
    await deps.PtcStablecoin.addReserveToken({ token: bondTokenAddress, decimals: 6, price: '1000000000000000000' });
    const deposit = await deps.PtcStablecoin.approveAndDeposit({ token: bondTokenAddress, amount: String(amount), recipient: to });
    const info = await deps.PtcStablecoin.info();
    return {
      mode: 'live',
      tokenAddress: info.tokenAddress,
      vaultAddress: info.vaultAddress,
      bondTokenAddress,
      minted: deposit.mintedStablecoin,
      recipient: to,
      deployTx: deploy.deployTx,
      depositTx: deposit.txHash,
    };
  }

  static async _swapToUsdc({ tokenIn, amount, recipient, poolAddress, swapRouter } = {}) {
    const deps = this._deps();
    if (!deps.DexSwap) throw new Error('DexSwapEngine not available');
    if (!tokenIn) throw new Error('tokenIn required');
    if (!this._isShadow() && !String(tokenIn).startsWith('0x')) throw new Error('tokenIn must be a 0x address in live mode');
    const cfg = this._dappConfig();
    const tokenOut = cfg.usdcAddress || process.env.DAPP_USDC_ADDRESS || '';
    if (!tokenOut) throw new Error('DAPP_USDC_ADDRESS not configured');
    const to = recipient || process.env.AGENT_WALLET_ADDRESS || '0x69a32f285ced1dbf102c7baedf0266f1d39580a1';

    if (this._isShadow()) {
      return {
        mode: 'shadow',
        tokenIn,
        tokenOut,
        amountIn: amount,
        amountOut: (Number(amount) * 0.98).toFixed(6),
        recipient: to,
        txHash: `shadow-swap-${Date.now()}`,
        note: 'Shadow DEX swap; live swap requires an approved pool/router with USDC liquidity',
      };
    }

    if (!cfg.privateKey) throw new Error('DAPP_PRIVATE_KEY not configured for live DEX swap');

    if (poolAddress) {
      const quote = await deps.DexSwap.quote({ tokenIn, tokenOut, amountIn: amount, decimalsIn: 18, decimalsOut: 6, router: poolAddress });
      const swap = await deps.DexSwap.swap({ tokenIn, tokenOut, amountIn: amount, amountOutMinimum: quote.amountOutMinimum, recipient: to, decimalsIn: 18, decimalsOut: 6, router: poolAddress });
      return { ...swap, tokenIn, tokenOut, recipient: to, mode: 'live' };
    }

    const quote = await deps.DexSwap.quoteUniswapV2({ tokenIn, tokenOut, amountIn: amount, decimalsIn: 18, decimalsOut: 6, path: [tokenIn, tokenOut], router: swapRouter });
    const swap = await deps.DexSwap.swapOnUniswapV2({
      tokenIn,
      tokenOut,
      amountIn: amount,
      amountOutMinimum: quote.amountOutMinimum,
      recipient: to,
      decimalsIn: 18,
      decimalsOut: 6,
      path: [tokenIn, tokenOut],
      router: swapRouter,
    });
    return { ...swap, tokenIn, tokenOut, recipient: to, mode: 'live' };
  }

  static async _sendToAgentWallet({ asset, amount, to, tokenAddress } = {}) {
    const cfg = this._dappConfig();
    const target = to || process.env.AGENT_WALLET_ADDRESS || '0x69a32f285ced1dbf102c7baedf0266f1d39580a1';
    if (!tokenAddress || !String(tokenAddress).startsWith('0x')) throw new Error('tokenAddress required');

    if (this._isShadow()) {
      return {
        mode: 'shadow',
        asset,
        amount,
        to: target,
        tokenAddress,
        txHash: `shadow-send-${Date.now()}`,
        note: 'Shadow token send to Agent Wallet',
      };
    }

    if (!cfg.privateKey) throw new Error('DAPP_PRIVATE_KEY not configured for live token send');
    let viem = null; try { viem = require('viem'); } catch (e) {}
    let privateKeyToAccount; try { ({ privateKeyToAccount } = require('viem/accounts')); } catch (e) {}
    let chains; try { chains = require('viem/chains'); } catch (e) {}
    if (!viem || !privateKeyToAccount) throw new Error('viem not installed');

    const account = privateKeyToAccount(cfg.privateKey);
    const chain = cfg.chainId === 8453 && chains?.base ? chains.base : (cfg.chainId === 11155111 ? chains?.sepolia : chains?.mainnet);
    const publicClient = viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) });
    const walletClient = viem.createWalletClient({ account, chain, transport: viem.http(cfg.rpcUrl) });
    const raw = viem.parseUnits(String(amount), 6);
    const hash = await walletClient.writeContract({
      address: tokenAddress,
      abi: [{ type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' }],
      functionName: 'transfer',
      args: [target, raw],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`transfer failed: ${hash}`);
    return { mode: 'live', asset, amount, to: target, tokenAddress, txHash: hash };
  }

  static async _tokenizeAndSend(payload = {}) {
    const {
      amount, sourceType = 'bond_interest', sourceAccountId = '1',
      tokenName, tokenSymbol, recipient,
      poolAddress, swapRouter,
    } = payload;
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    const cfg = this._dappConfig();
    const operatorAddress = cfg.operatorAddress || process.env.DAPP_OPERATOR_ADDRESS || process.env.AGENT_WALLET_ADDRESS || '0x69a32f285ced1dbf102c7baedf0266f1d39580a1';
    const targetAddress = recipient || process.env.AGENT_WALLET_ADDRESS || '0x69a32f285ced1dbf102c7baedf0266f1d39580a1';
    const paymentId = id('TOKPAY');

    // 1. Reserve the coupon interest in the GL
    const reserve = await this._reserveSource({ sourceType, sourceAccountId, amount, paymentId });

    // 2. Mint a bond-interest ERC-20 to the operator
    const tokenizeResult = await this._tokenizeBondInterest({ bondId: sourceAccountId, amount, tokenName, tokenSymbol, paymentId });
    const bondTokenAddress = tokenizeResult.bondToken.token_address;

    // 3. Deposit bond token into PTC reserve vault and mint DLB-PTCUSD 1:1
    const stablecoin = await this._mintStablecoin({ bondTokenAddress, amount, recipient: operatorAddress });

    // 4. Swap DLB-PTCUSD to USDC and deliver to Agent Wallet
    const stablecoinAddress = stablecoin.tokenAddress;
    const swap = await this._swapToUsdc({ tokenIn: stablecoinAddress, amount, recipient: targetAddress, poolAddress, swapRouter });

    // 5. If the swap did not deliver to the Agent Wallet, sweep the resulting tokens
    const finalSend = swap.recipient && String(swap.recipient).toLowerCase() === String(targetAddress).toLowerCase()
      ? null
      : await this._sendToAgentWallet({ asset: 'USDC', amount: swap.amountOut, to: targetAddress, tokenAddress: cfg.usdcAddress });

    const result = {
      paymentId,
      sourceType,
      sourceAccountId,
      amount,
      agentWallet: targetAddress,
      reserve,
      tokenizeResult,
      stablecoin,
      swap,
      finalSend,
      mode: this._isShadow() ? 'shadow' : 'live',
      note: this._isShadow()
        ? 'End-to-end tokenization flow simulated. Set DAPP_PRIVATE_KEY, fund gas, and provide a USDC pool/router to execute live.'
        : 'Tokenization flow executed live. Verify USDC balance in the Agent Wallet.',
    };
    return result;
  }

  static async _process(action, payload = {}) {
    switch (action) {
      case 'status':
        return await this.status();
      case 'health':
        return await this.health();
      case 'configure':
        return { configured: true, ...await this.status() };
      case 'tokenize':
        return await this._tokenizeBondInterest({ ...payload, paymentId: id('TOKPAY') });
      case 'mintStablecoin':
      case 'mint-stablecoin':
        return await this._mintStablecoin(payload || {});
      case 'swap':
        return await this._swapToUsdc(payload || {});
      case 'send':
      case 'sendToAgentWallet':
      case 'send-to-agent-wallet':
        return await this._sendToAgentWallet(payload || {});
      case 'execute':
      case 'tokenizeAndSend':
      case 'tokenize-and-send': {
        const result = await this._tokenizeAndSend(payload || {});
        await this._recordOperation('tokenizeAndSend', payload || {}, result, 'completed');
        return result;
      }
      default:
        return await this.status();
    }
  }
}

// ─── Conduit Engine ───────────────────────────────────────────────────────────
//
// Collects proceeds from bond-portfolio, fixed-income, cash, and other
// source-of-funds engines into a single canonical digital token (SIT /
// DLB-DIGITAL), then swaps that canonical token for Base mainnet USDC and
// settles it into the Agent Wallet. This is the "Canonical Digital Layer of
// Digital Money" that unifies PTC ledgers into a real on-chain asset.

class ConduitEngine extends BaseOSEngine {
  static get engineName() { return 'conduit'; }

  static _dappConfig() {
    try {
      const { getConfig } = require('../dapp/config');
      return getConfig();
    } catch (e) { return {}; }
  }

  static _deps() {
    const SovereignTrust = tryRequire('../dapp/sovereignTrustEngine')?.SovereignTrustEngine || null;
    const DexSwap = tryRequire('../dapp/dexSwapEngine')?.DexSwapEngine || null;
    return { SovereignTrust, DexSwap };
  }

  static _isShadow() {
    if (process.env.CONDUIT_SHADOW === 'true') return true;
    if (process.env.CONDUIT_SHADOW === 'false') return false;
    const cfg = this._dappConfig();
    if (!cfg.privateKey || cfg.dappShadow || cfg.dappShadow === true) return true;
    if (process.env.DAPP_SHADOW === 'true') return true;
    return false;
  }

  static _operatorAddress() {
    const cfg = this._dappConfig();
    let operator = cfg.operatorAddress || process.env.DAPP_OPERATOR_ADDRESS || '';
    if (!operator && cfg.privateKey) {
      try {
        const { privateKeyToAccount } = require('viem/accounts');
        operator = privateKeyToAccount(cfg.privateKey).address;
      } catch (e) { /* ignore */ }
    }
    if (!operator) operator = process.env.AGENT_WALLET_ADDRESS || '0x69a32f285ced1dbf102c7baedf0266f1d39580a1';
    return operator;
  }

  static _agentAddress() {
    return process.env.AGENT_WALLET_ADDRESS || '0x69a32f285ced1dbf102c7baedf0266f1d39580a1';
  }

  static async ensureTables() {
    await super.ensureTables();
    if (!pool) return;
    await query(`
      CREATE TABLE IF NOT EXISTS conduit_events (
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        source_type TEXT,
        source_account_id TEXT,
        amount NUMERIC NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        tx_hash TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_conduit_events_operation ON conduit_events(operation)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_conduit_events_status ON conduit_events(status)`);

    const deps = this._deps();
    if (deps.SovereignTrust) {
      try { await deps.SovereignTrust.readiness(); } catch (e) { /* tables initialized inside readiness */ }
    }
  }

  static async status() {
    const cfg = this._dappConfig();
    const deps = this._deps();
    const issues = [];
    if (!cfg.chainId) issues.push('DAPP_CHAIN_ID not configured');
    if (!cfg.usdcAddress) issues.push('DAPP_USDC_ADDRESS not configured');
    if (!this._isShadow() && !cfg.privateKey) issues.push('DAPP_PRIVATE_KEY not configured');
    if (!deps.SovereignTrust) issues.push('SovereignTrustEngine not available');
    if (!deps.DexSwap) issues.push('DexSwapEngine not available');
    const ready = this._isShadow() || issues.filter((i) => !i.includes('DAPP_PRIVATE_KEY')).length === 0;
    const canonicalSymbol = process.env.CONDUIT_CANONICAL_TOKEN_SYMBOL || process.env.SOVEREIGN_TOKEN_SYMBOL || 'SIT';
    const canonicalName = process.env.CONDUIT_CANONICAL_TOKEN_NAME || process.env.SOVEREIGN_TOKEN_NAME || 'Sovereign Trust Token';
    return {
      engine: this.engineName,
      healthy: true,
      mode: this._isShadow() ? 'shadow' : 'live',
      chainId: cfg.chainId || 8453,
      usdcAddress: cfg.usdcAddress || '',
      operatorAddress: this._operatorAddress(),
      agentWallet: this._agentAddress(),
      canonicalTokenSymbol: canonicalSymbol,
      canonicalTokenName: canonicalName,
      ready,
      issues,
      timestamp: new Date().toISOString(),
    };
  }

  static async _recordEvent(operation, payload, result, status = 'completed') {
    const eventId = id('CND');
    if (pool) {
      try {
        await query(
          `INSERT INTO conduit_events (id, operation, source_type, source_account_id, amount, status, tx_hash, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
          [eventId, operation, payload.sourceType || null, payload.sourceAccountId || null, Number(payload.amount) || 0, status, result.txHash || null, safeJson({ payload, result })]
        );
      } catch (e) { console.warn(`[${this.engineName}] record event failed:`, e.message); }
    }
    return eventId;
  }

  static _normalizeSources(payload) {
    const sources = [];
    if (Array.isArray(payload.sources)) {
      for (const s of payload.sources) {
        if (s && s.amount) sources.push({ sourceType: s.sourceType || 'bond_interest', sourceAccountId: s.sourceAccountId || '1', amount: Number(s.amount) });
      }
    }
    if (payload.sourceType && payload.amount) {
      sources.push({ sourceType: payload.sourceType, sourceAccountId: payload.sourceAccountId || '1', amount: Number(payload.amount) });
    }
    if (!sources.length) {
      sources.push({ sourceType: 'bond_interest', sourceAccountId: '1', amount: Number(payload.amount) || 0 });
    }
    return sources.filter((s) => s.amount > 0);
  }

  static async _collectSources(sources) {
    const deps = this._deps();
    if (!deps.SovereignTrust) throw new Error('SovereignTrustEngine not available');
    const operator = this._operatorAddress();
    const mints = [];
    let total = 0;
    for (const source of sources) {
      const mint = await deps.SovereignTrust.mintFromSource({
        sourceType: source.sourceType,
        sourceAccountId: source.sourceAccountId,
        to: operator,
        amount: source.amount,
        memo: `Conduit canonical digital money ${source.sourceType}:${source.sourceAccountId}`,
      });
      mints.push({ source, ...mint });
      total += Number(source.amount);
    }
    return { mints, total, operator };
  }

  static async _getCanonicalTokenAddress() {
    const deps = this._deps();
    if (!deps.SovereignTrust) return null;
    const token = await deps.SovereignTrust._loadToken();
    return token?.token_address || null;
  }

  static async _swapToUsdc({ tokenIn, amount, recipient }) {
    const deps = this._deps();
    if (!deps.DexSwap) throw new Error('DexSwapEngine not available');
    if (!tokenIn) throw new Error('canonical token address not available');
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    const cfg = this._dappConfig();
    const tokenOut = cfg.usdcAddress || process.env.DAPP_USDC_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const to = recipient || this._agentAddress();
    const router = process.env.UNISWAP_V2_ROUTER || '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24';
    const slippageBps = Number(process.env.DEX_SLIPPAGE_BPS || 100);
    const slippage = slippageBps / 10000;

    if (this._isShadow() || !cfg.privateKey) {
      const out = Number(amount) * (0.99 * (1 - slippage));
      return {
        mode: 'shadow',
        tokenIn,
        tokenOut,
        amountIn: amount,
        amountOut: out.toFixed(6),
        recipient: to,
        router,
        txHash: `shadow-conduit-swap-${Date.now()}`,
        note: 'Shadow swap to Base USDC; live requires DAPP_PRIVATE_KEY, gas, and a SIT/USDC liquidity pool',
      };
    }

    try {
      const quote = await deps.DexSwap.quoteUniswapV2({
        tokenIn, tokenOut, amountIn: amount, decimalsIn: 6, decimalsOut: 6, router, path: [tokenIn, tokenOut],
      });
      const swap = await deps.DexSwap.swapOnUniswapV2({
        tokenIn,
        tokenOut,
        amountIn: amount,
        amountOutMinimum: quote.amountOutMinimum,
        recipient: to,
        decimalsIn: 6,
        decimalsOut: 6,
        router,
        path: [tokenIn, tokenOut],
      });
      return { ...swap, tokenIn, tokenOut, recipient: to, mode: 'live' };
    } catch (err) {
      console.warn('[ConduitEngine] live swap failed, falling back to shadow:', err.message);
      const out = Number(amount) * (0.99 * (1 - slippage));
      return {
        mode: 'shadow-fallback',
        tokenIn,
        tokenOut,
        amountIn: amount,
        amountOut: out.toFixed(6),
        recipient: to,
        router,
        txHash: `shadow-conduit-swap-${Date.now()}`,
        note: `Live swap failed (${err.message}); recorded as shadow fallback`,
      };
    }
  }

  static async _balance(address) {
    const deps = this._deps();
    if (!deps.SovereignTrust || !address) return { canonical: '0', usdc: '0' };
    const canonical = await deps.SovereignTrust.tokenBalanceOf(address);
    return { canonical, usdc: '0' };
  }

  static async _execute(payload = {}) {
    const sources = this._normalizeSources(payload);
    if (!sources.length) throw new Error('No source amounts provided');
    const { mints, total, operator } = await this._collectSources(sources);
    const tokenAddress = await this._getCanonicalTokenAddress();
    const recipient = payload.recipient || this._agentAddress();
    const swap = await this._swapToUsdc({ tokenIn: tokenAddress, amount: total, recipient });
    const result = {
      engine: this.engineName,
      operation: 'canonicalDigitalMoney',
      sources,
      mints,
      totalCanonicalMinted: total,
      canonicalToken: tokenAddress,
      operator,
      agentWallet: recipient,
      swap,
      mode: this._isShadow() ? 'shadow' : 'live',
      note: this._isShadow()
        ? 'Conduit flow simulated. Set CONDUIT_SHADOW=false, DAPP_PRIVATE_KEY, and seed a SIT/USDC pool for live execution.'
        : 'Conduit flow executed live. Verify Base USDC balance in the Agent Wallet.',
    };
    await this._recordEvent('execute', payload, result, 'completed');
    return result;
  }

  static async _process(action, payload = {}) {
    switch (action) {
      case 'status':
        return await this.status();
      case 'health':
        return await this.health();
      case 'configure':
        return { configured: true, ...await this.status() };
      case 'collect':
      case 'mintCanonical':
      case 'mint-canonical':
        return await this._collectSources(this._normalizeSources(payload));
      case 'swap':
      case 'swapToUsdc':
      case 'swap-to-usdc':
        return await this._swapToUsdc({ tokenIn: payload.tokenIn || await this._getCanonicalTokenAddress(), amount: payload.amount, recipient: payload.recipient });
      case 'send':
      case 'sendToAgentWallet':
      case 'send-to-agent-wallet':
        return await this._swapToUsdc({ tokenIn: payload.tokenIn || await this._getCanonicalTokenAddress(), amount: payload.amount, recipient: payload.recipient });
      case 'balance':
        return await this._balance(payload.address || this._operatorAddress());
      case 'execute':
      case 'canonical-digital-money':
      case 'canonicalDigitalMoney':
        return await this._execute(payload);
      default:
        return await this.status();
    }
  }
}

// ─── Issuer Bridge Engine ─────────────────────────────────────────────────────
//
// Bridges PTC ledger balances (coupon / accrued interest GL accounts such as
// 1200 Accrued Interest Receivable) to real on-chain USDC through regulated
// issuer rails, primarily Circle Mint. It reserves the source account in the
// trust ledger, credits the stablecoin backing asset account (1210), and
// initiates a 1:1 USDC transfer on Base mainnet to the Agent Wallet. When no
// issuer API is configured it falls back to manual on-ramp instructions.

class IssuerBridgeEngine extends BaseOSEngine {
  static get engineName() { return 'issuer-bridge'; }

  static _dappConfig() {
    try {
      const { getConfig } = require('../dapp/config');
      return getConfig();
    } catch (e) { return {}; }
  }

  static _deps() {
    return {
      SourceOfFunds: tryRequire('../stablecoin/sourceOfFundsAdapter')?.SourceOfFundsAdapter || null,
      Treasury: tryRequire('../stablecoin/treasuryEngine')?.TreasuryEngine || null,
      Circle: tryRequire('../stablecoin/circleMintClient')?.CircleMintClient || null,
      MoonPay: tryRequire('../onramps/moonpayCliEngine')?.MoonPayCliEngine || null,
      TrustAcct: tryRequire('../accounting/trustAccountingEngine')?.TrustAccountingEngine || null,
      Cash: tryRequire('../cash/cashEngine')?.CashEngine || null,
    };
  }

  static _cfg() {
    const cfg = this._dappConfig();
    return {
      chainId: cfg.chainId || Number(process.env.DAPP_CHAIN_ID) || 8453,
      usdcAddress: cfg.usdcAddress || process.env.DAPP_USDC_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      agentWallet: process.env.AGENT_WALLET_ADDRESS || '0x69a32f285ced1dbf102c7baedf0266f1d39580a1',
      operatorAddress: cfg.operatorAddress || process.env.DAPP_OPERATOR_ADDRESS || process.env.AGENT_WALLET_ADDRESS || '0x69a32f285ced1dbf102c7baedf0266f1d39580a1',
      circleApiKey: process.env.CIRCLE_MINT_API_KEY || cfg.circleMintApiKey || '',
      circleBaseUrl: process.env.CIRCLE_MINT_BASE_URL || 'https://api.circle.com',
      circleRecipientId: process.env.CIRCLE_MINT_RECIPIENT_ID || '',
      circleChain: process.env.CIRCLE_MINT_CHAIN || 'BASE',
      defaultSourceType: process.env.ISSUER_BRIDGE_SOURCE_TYPE || 'trust',
      defaultSourceAccountId: process.env.ISSUER_BRIDGE_SOURCE_ACCOUNT_ID || '1200',
      defaultAsset: process.env.ISSUER_BRIDGE_ASSET || 'USDC',
      defaultMethod: process.env.ISSUER_BRIDGE_SOURCE_METHOD || (process.env.CIRCLE_MINT_API_KEY ? 'circle_mint' : 'manual'),
      assetAccount: process.env.ISSUER_BRIDGE_ASSET_ACCOUNT || '1210',
      enabled: (process.env.ISSUER_BRIDGE_ENABLED || 'true') !== 'false',
      shadow: (process.env.ISSUER_BRIDGE_SHADOW || 'false') === 'true',
    };
  }

  static _isShadow() { return this._cfg().shadow; }

  static async ensureTables() {
    await super.ensureTables();
    if (!pool) return;
    await query(`
      CREATE TABLE IF NOT EXISTS issuer_bridge_requests (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_account_id TEXT NOT NULL,
        source_method TEXT NOT NULL,
        asset TEXT NOT NULL DEFAULT 'USDC',
        amount NUMERIC(18,2) NOT NULL,
        amount_cents BIGINT NOT NULL,
        recipient TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','quoted','source_reserved','needs_config','needs_deposit','needs_recipient_setup','awaiting_deposit','pending_onramp','completed','failed','cancelled')),
        provider TEXT,
        reserve_id TEXT,
        journal_entry_id TEXT,
        tx_hash TEXT,
        instructions TEXT,
        result JSONB DEFAULT '{}',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_issuer_bridge_status ON issuer_bridge_requests(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_issuer_bridge_source ON issuer_bridge_requests(source_type, source_account_id)`);
  }

  static async _sourceBalance(sourceType, sourceAccountId) {
    const deps = this._deps();
    sourceType = String(sourceType || this._cfg().defaultSourceType).toLowerCase();
    sourceAccountId = sourceAccountId || this._cfg().defaultSourceAccountId;
    if (sourceType === 'trust' || sourceType === 'trust_account') {
      if (!deps.TrustAcct) throw new Error('TrustAccountingEngine not available');
      const acct = await deps.TrustAcct.getAccount(sourceAccountId);
      return acct ? { balanceCents: Math.round(Number(acct.balance || 0) * 100), account: acct } : { balanceCents: 0, account: null };
    }
    if (sourceType === 'cash') {
      if (!deps.Cash) throw new Error('CashEngine not available');
      const acct = await deps.Cash.getAccount(sourceAccountId);
      return acct ? { balanceCents: Number(acct.balance_cents || 0), account: acct } : { balanceCents: 0, account: null };
    }
    if (deps.SourceOfFunds) {
      const balanceCents = await deps.SourceOfFunds.getBalance({ sourceType, sourceAccountId });
      return { balanceCents: Number(balanceCents || 0), account: null };
    }
    return { balanceCents: 0, account: null };
  }

  static async _providerReadiness(method) {
    const deps = this._deps();
    const cfg = this._cfg();
    const base = { method, ready: false, issues: [] };
    if (method === 'manual') return { ...base, ready: true };
    if (method === 'circle_mint') {
      const issues = [];
      if (!cfg.circleApiKey) issues.push('CIRCLE_MINT_API_KEY not configured');
      return { ...base, ready: issues.length === 0, issues };
    }
    if (method === 'moonpay') {
      if (!deps.MoonPay) return { ...base, issues: ['MoonPayCliEngine not available'] };
      const r = await deps.MoonPay.readiness().catch(e => ({ ready: false, issues: [e.message] }));
      return { ...base, ready: !!r.ready, issues: r.issues || [] };
    }
    return { ...base, issues: ['Unsupported source method'] };
  }

  static async status() {
    const cfg = this._cfg();
    const sourceInfo = await this._sourceBalance(cfg.defaultSourceType, cfg.defaultSourceAccountId).catch(e => ({ balanceCents: 0, error: e.message }));
    const providers = {
      manual: await this._providerReadiness('manual'),
      circle_mint: await this._providerReadiness('circle_mint'),
      moonpay: await this._providerReadiness('moonpay'),
    };
    const issues = [];
    if (!cfg.enabled) issues.push('ISSUER_BRIDGE_ENABLED is false');
    if (sourceInfo.error) issues.push(sourceInfo.error);
    return {
      engine: this.engineName,
      healthy: true,
      enabled: cfg.enabled,
      mode: this._isShadow() ? 'shadow' : 'live',
      chainId: cfg.chainId,
      usdcAddress: cfg.usdcAddress,
      agentWallet: cfg.agentWallet,
      defaultSourceType: cfg.defaultSourceType,
      defaultSourceAccountId: cfg.defaultSourceAccountId,
      sourceBalanceCents: sourceInfo.balanceCents,
      sourceBalanceUsd: ((sourceInfo.balanceCents || 0) / 100).toFixed(2),
      providers,
      issues,
      timestamp: new Date().toISOString(),
    };
  }

  static async health() { return this.status(); }

  static _payloadDefaults(payload) {
    const cfg = this._cfg();
    const sourceType = payload.sourceType || payload.source_type || cfg.defaultSourceType;
    const sourceAccountId = payload.sourceAccountId || payload.source_account_id || cfg.defaultSourceAccountId;
    const amount = Number(payload.amount);
    const asset = String(payload.asset || cfg.defaultAsset || 'USDC').toUpperCase();
    const recipient = payload.recipient || payload.targetAddress || cfg.agentWallet;
    const sourceMethod = payload.sourceMethod || payload.source_method || cfg.defaultMethod;
    const assetAccount = payload.assetAccount || cfg.assetAccount;
    if (!amount || amount <= 0) throw new Error('amount must be positive');
    if (!recipient || !String(recipient).startsWith('0x')) throw new Error('recipient must be a 0x address');
    return { sourceType, sourceAccountId, amount, asset, recipient, sourceMethod, assetAccount };
  }

  static async _reserveSource({ sourceType, sourceAccountId, amount, operationId, assetAccount }) {
    const deps = this._deps();
    if (!deps.TrustAcct) throw new Error('TrustAccountingEngine not available for GL reservation');
    if (!deps.Treasury) throw new Error('TreasuryEngine not available');
    const amountCents = toCents(amount);
    const source = await deps.TrustAcct.getAccount(sourceAccountId);
    if (!source) throw new Error(`Trust account not found: ${sourceAccountId}`);
    const asset = await deps.TrustAcct.getAccount(assetAccount);
    if (!asset) throw new Error(`Backing asset account not found: ${assetAccount}`);
    if (Number(source.balance || 0) * 100 < amountCents) throw new Error(`Insufficient source balance in ${sourceAccountId}: ${source.balance} < ${amount}`);
    const journal = await deps.TrustAcct.postJournalEntry({
      entryDate: new Date(),
      description: `Issuer Bridge reserve ${operationId}`,
      referenceType: 'issuer_bridge',
      referenceId: operationId,
      postedBy: 'issuer-bridge',
      postToFineract: false,
      lines: [
        { accountCode: assetAccount, debitAmount: amountCents / 100, creditAmount: 0, memo: `Stablecoin backing from ${sourceAccountId}` },
        { accountCode: sourceAccountId, debitAmount: 0, creditAmount: amountCents / 100, memo: `Source funds to issuer bridge ${operationId}` },
      ],
    });
    await deps.Treasury.credit('TREASURY_HOT', amountCents, { source: 'issuer-bridge', txHash: null, metadata: { operationId, sourceType, sourceAccountId, journalEntryId: journal.entry_id } });
    const hold = await deps.Treasury.hold(operationId, 'TREASURY_HOT', amountCents);
    return { journalEntryId: journal.entry_id, reserveId: hold.reserveId, amountCents };
  }

  static async _createOperation(data) {
    if (!pool) return;
    const record = {
      id: data.id,
      source_type: data.sourceType,
      source_account_id: data.sourceAccountId,
      source_method: data.sourceMethod,
      asset: data.asset,
      amount: data.amount,
      amount_cents: data.amountCents,
      recipient: data.recipient,
      status: data.status,
      reserve_id: data.reserveId || null,
      journal_entry_id: data.journalEntryId || null,
      tx_hash: data.txHash || null,
      instructions: data.instructions || null,
      provider: data.provider || null,
      result: safeJson(data.result || {}),
      metadata: safeJson(data.metadata || {}),
    };
    const cols = Object.keys(record).join(', ');
    const vals = Object.keys(record).map((_, i) => `$${i + 1}`).join(', ');
    await query(`INSERT INTO issuer_bridge_requests (${cols}) VALUES (${vals})`, Object.values(record));
  }

  static async _updateOperation(operationId, updates) {
    if (!pool || !operationId) return;
    const parts = [];
    const values = [];
    let idx = 1;
    if (updates.status !== undefined) { parts.push(`status=$${idx++}`); values.push(updates.status); }
    if (updates.txHash !== undefined) { parts.push(`tx_hash=$${idx++}`); values.push(updates.txHash); }
    if (updates.instructions !== undefined) { parts.push(`instructions=$${idx++}`); values.push(updates.instructions); }
    if (updates.result !== undefined) { parts.push(`result=$${idx++}::jsonb`); values.push(safeJson(updates.result)); }
    if (updates.provider !== undefined) { parts.push(`provider=$${idx++}`); values.push(updates.provider); }
    if (updates.metadata !== undefined) { parts.push(`metadata=$${idx++}::jsonb`); values.push(safeJson(updates.metadata)); }
    if (!parts.length) return;
    values.push(operationId);
    await query(`UPDATE issuer_bridge_requests SET ${parts.join(', ')}, updated_at=NOW() WHERE id=$${idx}`, values);
  }

  static async _getOperation(operationId) {
    if (!pool || !operationId) return null;
    const res = await query('SELECT * FROM issuer_bridge_requests WHERE id = $1', [operationId]);
    return res.rows[0] || null;
  }

  static async _listOperations({ limit = 50, offset = 0, status } = {}) {
    if (!pool) return [];
    let sql = 'SELECT * FROM issuer_bridge_requests';
    const params = [];
    if (status) { sql += ' WHERE status=$1'; params.push(status); }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
    const res = await query(sql, params);
    return res.rows;
  }

  static async list({ limit = 50, offset = 0, status } = {}) {
    return await this._listOperations({ limit, offset, status });
  }

  static async get(operationId) {
    return await this._getOperation(operationId);
  }

  static async _finalize(reserveId, txHash) {
    const deps = this._deps();
    if (deps.Treasury && reserveId) {
      await deps.Treasury.post(reserveId, txHash);
    }
  }

  static _buildInstructions(cfg, p, operationId, overrideMethod, reserved = false) {
    const method = overrideMethod || p.sourceMethod;
    const amount = Number(p.amount).toFixed(2);
    const reservedText = reserved ? 'has been reserved' : 'will be reserved';
    const opText = operationId ? `operationId '${operationId}'` : 'the returned operationId';
    if (method === 'manual') {
      return `Send ${amount} ${p.asset} on Base mainnet to ${p.recipient} (token ${cfg.usdcAddress}). The fiat equivalent ${reservedText} from ${p.sourceType}:${p.sourceAccountId}. Once the deposit confirms, call /api/os/issuer-bridge/process with action 'confirm', ${opText}, and txHash.`;
    }
    if (method === 'circle_mint') {
      return `Use Circle Mint to transfer ${amount} USDC to ${p.recipient} on ${cfg.circleChain}. Operation ${operationId || 'pending'}.`;
    }
    if (method === 'moonpay') {
      return `Use MoonPay to buy ${amount} ${p.asset} on Base into ${p.recipient}. Operation ${operationId || 'pending'}.`;
    }
    return `On-ramp ${amount} USD to ${p.asset} at ${p.recipient} via ${method}. Operation ${operationId || 'pending'}.`;
  }

  static async _issueManual(operationId, p) {
    const cfg = this._cfg();
    return { status: 'awaiting_deposit', provider: 'manual', instructions: this._buildInstructions(cfg, p, operationId, 'manual', true) };
  }

  static async _issueCircle(operationId, p) {
    const cfg = this._cfg();
    if (!cfg.circleApiKey) throw new Error('CIRCLE_MINT_API_KEY not configured');
    const deps = this._deps();
    if (!deps.Circle) throw new Error('CircleMintClient not available');
    const client = new deps.Circle({ apiKey: cfg.circleApiKey, baseUrl: cfg.circleBaseUrl });
    const balances = await client.getBalances();
    const usd = balances && balances.data && balances.data.find((b) => b.currency === 'USD' || b.currency === 'USDC');
    const available = usd ? Number(usd.availableAmount) : 0;
    if (available < Number(p.amount)) {
      return { status: 'needs_deposit', provider: 'circle_mint', available, needed: p.amount, instructions: `Wire USD to Circle Mint. Available: ${available} USD; needed: ${p.amount} USD.` };
    }
    let recipientAddressId = cfg.circleRecipientId;
    if (!recipientAddressId) {
      const created = await client.createRecipientAddress({ address: p.recipient, chain: cfg.circleChain, currency: 'USD', description: `Issuer Bridge Agent Wallet ${operationId}`, idempotencyKey: operationId });
      const rec = created && created.data;
      recipientAddressId = rec && rec.id;
      if (!recipientAddressId) {
        return { status: 'needs_recipient_setup', provider: 'circle_mint', circleResponse: created, instructions: `Create and approve a Circle Mint recipient address for ${p.recipient} on ${cfg.circleChain}, then set CIRCLE_MINT_RECIPIENT_ID and retry.` };
      }
    }
    const transfer = await client.createTransfer({ destinationAddressId: recipientAddressId, amount: String(p.amount), currency: 'USD', idempotencyKey: operationId });
    const tx = transfer && transfer.data;
    const txHash = tx && tx.transactionHash;
    const status = tx && tx.status === 'complete' ? 'completed' : 'pending_onramp';
    return { status, provider: 'circle_mint', recipientAddressId, transfer: tx, txHash, instructions: txHash ? `Circle Mint transfer ${tx.id} submitted. Track on Base: ${txHash}` : `Circle Mint transfer ${tx && tx.id} pending. Call continue with operationId.` };
  }

  static async _issueMoonpay(operationId, p) {
    const deps = this._deps();
    const cfg = this._cfg();
    if (!deps.MoonPay) throw new Error('MoonPayCliEngine not available');
    const buy = await deps.MoonPay.buyUrl({ asset: p.asset, chainId: cfg.chainId, walletAddress: p.recipient, amount: p.amount, explanation: `Issuer Bridge ${operationId}` });
    return { status: 'awaiting_onramp', provider: 'moonpay', instructions: `Complete MoonPay checkout for ${Number(p.amount).toFixed(2)} ${p.asset} on Base to ${p.recipient}: ${buy.url}`, moonpay: buy };
  }

  static async _quote(payload) {
    const cfg = this._cfg();
    const p = this._payloadDefaults(payload);
    const sourceInfo = await this._sourceBalance(p.sourceType, p.sourceAccountId);
    const amountCents = toCents(p.amount);
    if ((sourceInfo.balanceCents || 0) < amountCents) throw new Error(`Insufficient source balance: ${((sourceInfo.balanceCents || 0) / 100).toFixed(2)} < ${p.amount}`);
    const provider = await this._providerReadiness(p.sourceMethod);
    return {
      sourceType: p.sourceType,
      sourceAccountId: p.sourceAccountId,
      amount: p.amount,
      asset: p.asset,
      recipient: p.recipient,
      sourceMethod: p.sourceMethod,
      sourceBalanceCents: sourceInfo.balanceCents,
      providerReady: provider.ready,
      providerIssues: provider.issues,
      instructions: this._buildInstructions(cfg, p, null, null, false),
      status: 'quoted',
    };
  }

  static async _issue(payload) {
    const p = this._payloadDefaults(payload);
    const sourceInfo = await this._sourceBalance(p.sourceType, p.sourceAccountId);
    const amountCents = toCents(p.amount);
    if ((sourceInfo.balanceCents || 0) < amountCents) throw new Error(`Insufficient source balance: ${((sourceInfo.balanceCents || 0) / 100).toFixed(2)} < ${p.amount}`);
    const operationId = id('IB-');
    const reserve = await this._reserveSource({ sourceType: p.sourceType, sourceAccountId: p.sourceAccountId, amount: p.amount, operationId, assetAccount: p.assetAccount });
    let providerResult;
    if (p.sourceMethod === 'circle_mint') providerResult = await this._issueCircle(operationId, p);
    else if (p.sourceMethod === 'manual') providerResult = await this._issueManual(operationId, p);
    else if (p.sourceMethod === 'moonpay') providerResult = await this._issueMoonpay(operationId, p);
    else providerResult = { status: 'needs_config', provider: p.sourceMethod, instructions: `Source method ${p.sourceMethod} not supported by IssuerBridgeEngine` };
    const status = providerResult.status === 'completed' ? 'completed' : providerResult.status;
    const txHash = providerResult.txHash || null;
    const result = { ...providerResult, operationId, reserve };
    await this._createOperation({ id: operationId, sourceType: p.sourceType, sourceAccountId: p.sourceAccountId, sourceMethod: p.sourceMethod, asset: p.asset, amount: p.amount, amountCents, recipient: p.recipient, status, reserveId: reserve.reserveId, journalEntryId: reserve.journalEntryId, txHash, instructions: providerResult.instructions, provider: providerResult.provider, result, metadata: { payload: p } });
    if (status === 'completed' && reserve.reserveId && txHash) {
      await this._finalize(reserve.reserveId, txHash);
    }
    return { operationId, sourceType: p.sourceType, sourceAccountId: p.sourceAccountId, amount: p.amount, asset: p.asset, recipient: p.recipient, status, txHash, instructions: providerResult.instructions, result };
  }

  static async _continue(payload) {
    const cfg = this._cfg();
    const operationId = payload.operationId || payload.id || payload.operation_id;
    if (!operationId) throw new Error('operationId required');
    const op = await this._getOperation(operationId);
    if (!op) throw new Error('Operation not found');
    if (op.status === 'completed') return op;
    let result;
    if (op.source_method === 'circle_mint') {
      const prev = (op.result && op.result.transfer && op.result.transfer.id) ? op.result.transfer.id : null;
      if (!prev) throw new Error('No Circle transfer id recorded');
      const deps = this._deps();
      if (!deps.Circle) throw new Error('CircleMintClient not available');
      const client = new deps.Circle({ apiKey: cfg.circleApiKey, baseUrl: cfg.circleBaseUrl });
      const txResp = await client.getTransfer(prev);
      const tx = txResp && txResp.data;
      const txHash = tx && tx.transactionHash;
      const status = tx && tx.status === 'complete' ? 'completed' : 'pending_onramp';
      result = { ...op.result, transfer: tx, status, txHash };
      if (status === 'completed' && op.reserve_id && txHash) {
        await this._finalize(op.reserve_id, txHash);
      }
      await this._updateOperation(operationId, { status, txHash, result, instructions: tx ? `Circle transfer ${tx.id} status: ${tx.status}` : op.instructions });
      return { operationId, status, txHash, result };
    }
    const txHash = payload.txHash || payload.tx_hash;
    if (!txHash) throw new Error('txHash required to confirm deposit');
    if (op.reserve_id) await this._finalize(op.reserve_id, txHash);
    result = { ...(op.result || {}), txHash, status: 'completed' };
    await this._updateOperation(operationId, { status: 'completed', txHash, result });
    return { operationId, status: 'completed', txHash, result };
  }

  static async _confirm(payload) {
    const operationId = payload.operationId || payload.id || payload.operation_id;
    const txHash = payload.txHash || payload.tx_hash;
    if (!operationId) throw new Error('operationId required');
    if (!txHash) throw new Error('txHash required');
    const op = await this._getOperation(operationId);
    if (!op) throw new Error('Operation not found');
    if (op.status === 'completed') return op;
    if (op.reserve_id) await this._finalize(op.reserve_id, txHash);
    const result = { ...(op.result || {}), txHash, status: 'completed' };
    await this._updateOperation(operationId, { status: 'completed', txHash, result });
    return await this._getOperation(operationId);
  }

  static async _process(action, payload = {}) {
    switch (action) {
      case 'status': return await this.status();
      case 'health': return await this.health();
      case 'quote': return await this._quote(payload);
      case 'issue':
      case 'execute':
      case 'issueAndSend':
        return await this._issue(payload);
      case 'continue': return await this._continue(payload);
      case 'confirm': return await this._confirm(payload);
      case 'get':
      case 'getOperation': return await this.get(payload.operationId || payload.id || payload.operation_id);
      case 'list':
      case 'listOperations': return await this._listOperations({ limit: payload.limit, offset: payload.offset, status: payload.status });
      default: return await this.status();
    }
  }
}

// ─── Melio B2B Payments Engine ────────────────────────────────────────────────
//
// Fiat B2B payment rail that pays vendors / settlement accounts from PTC
// ledger sources (cash, trust, bond, fixed income). When a payment settles,
// the corresponding treasury reserve is posted so the ledger stays in sync.
// In live mode it calls the Melio Payments API; in shadow mode it returns a
// payment intent and wire/ACH instructions that an operator can complete.

class MelioEngine extends BaseOSEngine {
  static get engineName() { return 'melio'; }

  static _cfg() {
    return {
      apiKey: process.env.MELIO_API_KEY || '',
      baseUrl: process.env.MELIO_BASE_URL || 'https://api.meliopayments.com',
      shadow: process.env.MELIO_SHADOW ? process.env.MELIO_SHADOW === 'true' : !process.env.MELIO_API_KEY,
      enabled: (process.env.MELIO_ENABLED || 'true') !== 'false',
      defaultSourceType: process.env.MELIO_SOURCE_TYPE || 'cash',
      defaultSourceAccountId: process.env.MELIO_SOURCE_ACCOUNT_ID || 'CA-OPERATING',
      defaultDeliveryMethod: process.env.MELIO_DELIVERY_METHOD || 'ach',
      webhookSecret: process.env.MELIO_WEBHOOK_SECRET || '',
      reserveOnSchedule: (process.env.MELIO_RESERVE_ON_SCHEDULE || 'true') !== 'false',
    };
  }

  static _client() {
    const Melio = tryRequire('../melio/melioClient')?.getClient;
    if (!Melio) return null;
    return Melio();
  }

  static _deps() {
    return {
      SourceOfFunds: tryRequire('../stablecoin/sourceOfFundsAdapter')?.SourceOfFundsAdapter || null,
      Treasury: tryRequire('../stablecoin/treasuryEngine')?.TreasuryEngine || null,
      TrustAcct: tryRequire('../accounting/trustAccountingEngine')?.TrustAccountingEngine || null,
      Cash: tryRequire('../cash/cashEngine')?.CashEngine || null,
    };
  }

  static async ensureTables() {
    await super.ensureTables();
    if (!pool) return;
    await query(`
      CREATE TABLE IF NOT EXISTS melio_payments (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','quoted','scheduled','processing','completed','failed','cancelled')),
        amount NUMERIC(18,2) NOT NULL,
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        source_type TEXT,
        source_account_id TEXT,
        vendor_id TEXT,
        bill_id TEXT,
        melio_payment_id TEXT,
        reserve_id TEXT,
        journal_entry_id TEXT,
        funding JSONB DEFAULT '{}',
        instructions TEXT,
        result JSONB DEFAULT '{}',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_melio_payments_status ON melio_payments(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_melio_payments_source ON melio_payments(source_type, source_account_id)`);
  }

  static async _sourceBalance(sourceType, sourceAccountId) {
    const deps = this._deps();
    sourceType = String(sourceType || this._cfg().defaultSourceType).toLowerCase();
    sourceAccountId = sourceAccountId || this._cfg().defaultSourceAccountId;
    if ((sourceType === 'trust' || sourceType === 'trust_account') && deps.TrustAcct) {
      const acct = await deps.TrustAcct.getAccount(sourceAccountId);
      return acct ? { balanceCents: Math.round(Number(acct.balance || 0) * 100), account: acct } : { balanceCents: 0, account: null };
    }
    if (sourceType === 'cash' && deps.Cash) {
      const acct = await deps.Cash.getAccount(sourceAccountId);
      return acct ? { balanceCents: Number(acct.balance_cents || 0), account: acct } : { balanceCents: 0, account: null };
    }
    if (deps.SourceOfFunds) {
      const balanceCents = await deps.SourceOfFunds.getBalance({ sourceType, sourceAccountId });
      return { balanceCents: Number(balanceCents || 0), account: null };
    }
    return { balanceCents: 0, account: null };
  }

  static async status() {
    const cfg = this._cfg();
    const sourceInfo = await this._sourceBalance(cfg.defaultSourceType, cfg.defaultSourceAccountId).catch(e => ({ balanceCents: 0, error: e.message }));
    const client = this._client();
    let apiStatus = { reachable: false };
    if (client && !cfg.shadow) {
      try { apiStatus = { reachable: true, company: await client.getCompany() }; } catch (e) { apiStatus = { reachable: false, error: e.message }; }
    }
    const issues = [];
    if (!cfg.enabled) issues.push('MELIO_ENABLED is false');
    if (!cfg.apiKey && !cfg.shadow) issues.push('MELIO_API_KEY not configured');
    return {
      engine: this.engineName,
      healthy: true,
      enabled: cfg.enabled,
      mode: cfg.shadow ? 'shadow' : 'live',
      sourceBalanceCents: sourceInfo.balanceCents,
      sourceBalanceUsd: ((sourceInfo.balanceCents || 0) / 100).toFixed(2),
      apiStatus,
      issues,
      timestamp: new Date().toISOString(),
    };
  }

  static async health() { return this.status(); }

  static _payloadDefaults(payload) {
    const cfg = this._cfg();
    const sourceType = payload.sourceType || payload.source_type || cfg.defaultSourceType;
    const sourceAccountId = payload.sourceAccountId || payload.source_account_id || cfg.defaultSourceAccountId;
    const amount = Number(payload.amount);
    const currency = String(payload.currency || 'USD').toUpperCase();
    const deliveryMethod = payload.deliveryMethod || payload.delivery_method || cfg.defaultDeliveryMethod;
    const vendor = payload.vendor || {};
    const bill = payload.bill || {};
    if (!amount || amount <= 0) throw new Error('amount must be positive');
    if (!vendor.name && !payload.vendorId) throw new Error('vendor.name or vendorId required');
    if (!currency) throw new Error('currency required');
    return { sourceType, sourceAccountId, amount, currency, deliveryMethod, vendor, bill, memo: payload.memo || '', metadata: payload.metadata || {} };
  }

  static _instructions(record, cfg) {
    const amount = Number(record.amount).toFixed(2);
    if (record.melioPaymentId) {
      const reserveNote = record.reserveId ? ` Reserve ${record.reserveId} will be posted when payment completes.` : '';
      return `Melio payment ${record.melioPaymentId} scheduled for $${amount} ${record.currency} via ${record.deliveryMethod || cfg.defaultDeliveryMethod}. Track in Melio dashboard.${reserveNote}`;
    }
    return `Shadow Melio payment for $${amount} ${record.currency}. To send live, set MELIO_API_KEY and MELIO_SHADOW=false, then retry.`;
  }

  static async _recordPayment(record) {
    if (!pool) return;
    const values = [
      record.id, record.action, record.status, record.amount, record.amountCents, record.currency,
      record.sourceType, record.sourceAccountId, record.vendorId || null, record.billId || null,
      record.melioPaymentId || null, record.reserveId || null, record.journalEntryId || null,
      safeJson(record.funding || {}), record.instructions || null, safeJson(record.result || {}), safeJson(record.metadata || {}),
    ];
    await query(`
      INSERT INTO melio_payments
        (id, action, status, amount, amount_cents, currency, source_type, source_account_id, vendor_id, bill_id, melio_payment_id, reserve_id, journal_entry_id, funding, instructions, result, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16::jsonb,$17::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        status=EXCLUDED.status,
        vendor_id=EXCLUDED.vendor_id,
        bill_id=EXCLUDED.bill_id,
        melio_payment_id=EXCLUDED.melio_payment_id,
        reserve_id=EXCLUDED.reserve_id,
        journal_entry_id=EXCLUDED.journal_entry_id,
        funding=EXCLUDED.funding,
        instructions=EXCLUDED.instructions,
        result=EXCLUDED.result,
        metadata=EXCLUDED.metadata,
        updated_at=NOW()
    `, values);
  }

  static async _getPaymentRecord(id) {
    if (!pool || !id) return null;
    const res = await query('SELECT * FROM melio_payments WHERE id = $1 OR melio_payment_id = $1', [id]);
    return res.rows[0] || null;
  }

  static async _reserveSource({ sourceType, sourceAccountId, amount, paymentId }) {
    const deps = this._deps();
    if (!deps.SourceOfFunds) throw new Error('SourceOfFundsAdapter not available');
    if (!deps.Treasury) throw new Error('TreasuryEngine not available');
    const amountCents = toCents(amount);
    const funding = await deps.SourceOfFunds._fundSourceToTreasury({ sourceType, sourceAccountId, paymentId, amountCents });
    const hold = await deps.Treasury.hold(paymentId, 'TREASURY_HOT', amountCents);
    return { funding, reserveId: hold.reserveId, amountCents };
  }

  static async _releaseReserve(reserveId) {
    const deps = this._deps();
    if (deps.Treasury && reserveId) {
      try { await deps.Treasury.release(reserveId); } catch (e) { console.warn('[melio] release failed:', e.message); }
    }
  }

  static async _finalizeReserve(reserveId, reference) {
    const deps = this._deps();
    if (deps.Treasury && reserveId) {
      await deps.Treasury.post(reserveId, reference);
    }
  }

  static async _listVendors() {
    const client = this._client();
    if (!client) return { mode: 'shadow', note: 'Melio client not available' };
    return await client.listVendors();
  }

  static async _createVendor(payload) {
    const client = this._client();
    if (!client) return { mode: 'shadow', note: 'Melio client not available' };
    const vendor = payload.vendor || payload;
    if (!vendor.name) throw new Error('vendor.name required');
    return await client.createVendor(vendor);
  }

  static async _createBill(payload) {
    const client = this._client();
    if (!client) return { mode: 'shadow', note: 'Melio client not available' };
    const { vendorId, amount, currency, dueDate, description } = payload;
    if (!vendorId) throw new Error('vendorId required');
    if (!amount) throw new Error('amount required');
    return await client.createBill({ vendor_id: vendorId, amount: String(amount), currency: (currency || 'USD').toUpperCase(), due_date: dueDate, description });
  }

  static async _schedulePayment(payload) {
    const cfg = this._cfg();
    const p = this._payloadDefaults(payload);
    const amountCents = toCents(p.amount);
    const sourceInfo = await this._sourceBalance(p.sourceType, p.sourceAccountId);
    if ((sourceInfo.balanceCents || 0) < amountCents) throw new Error(`Insufficient source balance: ${((sourceInfo.balanceCents || 0) / 100).toFixed(2)} < ${p.amount}`);

    const paymentId = id('MEL-');
    let funding = null;
    let journalEntryId = null;
    let reserveId = null;
    if (!cfg.shadow && cfg.reserveOnSchedule) {
      const r = await this._reserveSource({ sourceType: p.sourceType, sourceAccountId: p.sourceAccountId, amount: p.amount, paymentId });
      funding = r.funding;
      journalEntryId = r.funding?.journalEntryId || r.funding?.journalId || r.funding?.movementId || null;
      reserveId = r.reserveId;
    }

    const client = this._client();
    if (!client) throw new Error('Melio client not available');
    let vendor = null;
    let bill = null;
    let melioPayment = null;
    try {
      if (payload.vendorId) {
        vendor = { id: payload.vendorId };
      } else {
        vendor = await client.createVendor(p.vendor);
      }
      if (payload.billId) {
        bill = { id: payload.billId };
      } else {
        bill = await client.createBill({
          vendor_id: vendor.id,
          amount: String(p.amount),
          currency: p.currency,
          due_date: payload.dueDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
          description: p.bill.description || p.memo || `B2B payment from PTC ${paymentId}`,
        });
      }
      melioPayment = await client.schedulePayment({
        vendor_id: vendor.id,
        bill_id: bill.id,
        amount: String(p.amount),
        currency: p.currency,
        delivery_method: p.deliveryMethod,
        scheduled_date: payload.scheduledDate || new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        memo: p.memo,
      });
    } catch (err) {
      if (reserveId) await this._releaseReserve(reserveId);
      throw err;
    }

    const record = {
      id: paymentId,
      action: 'schedulePayment',
      status: melioPayment.status === 'completed' ? 'completed' : (melioPayment.status || 'scheduled'),
      amount: p.amount,
      amountCents,
      currency: p.currency,
      sourceType: p.sourceType,
      sourceAccountId: p.sourceAccountId,
      vendorId: vendor.id,
      billId: bill.id,
      melioPaymentId: melioPayment.id,
      reserveId,
      journalEntryId,
      funding: funding || {},
      result: { vendor, bill, melioPayment },
      metadata: { payload: p },
    };
    record.instructions = this._instructions({ ...record, deliveryMethod: p.deliveryMethod }, cfg);
    if (melioPayment.status === 'completed' && reserveId) {
      try { await this._finalizeReserve(reserveId, `melio:${melioPayment.id}`); record.status = 'completed'; } catch (e) { /* keep status */ }
    }
    await this._recordPayment(record);
    return record;
  }

  static async _getPayment(payload) {
    const cfg = this._cfg();
    const paymentId = payload.paymentId || payload.id;
    if (!paymentId) throw new Error('paymentId required');
    const client = this._client();
    if (!client) throw new Error('Melio client not available');
    const record = await this._getPaymentRecord(paymentId);
    const melioPaymentId = (record && record.melio_payment_id) || paymentId;
    const remote = await client.getPayment(melioPaymentId);
    if (record && remote) {
      const status = remote.status || record.status;
      if (['completed', 'sent', 'settled'].includes(status) && record.reserve_id && record.status !== 'completed') {
        try { await this._finalizeReserve(record.reserve_id, `melio:${remote.id || paymentId}`); } catch (e) { console.warn('[melio] finalize failed:', e.message); }
      }
      const updated = { ...record, status, result: { ...record.result, remote } };
      updated.instructions = this._instructions({ ...updated, deliveryMethod: record.delivery_method || cfg.defaultDeliveryMethod }, cfg);
      await this._recordPayment(updated);
      return updated;
    }
    return { paymentId, remote, record, status: (record && record.status) || 'unknown' };
  }

  static async _listPayments(payload) {
    const client = this._client();
    if (!client) return { mode: 'shadow', note: 'Melio client not available' };
    return await client.listPayments({ limit: payload.limit || 50 });
  }

  static async _webhook(payload) {
    const cfg = this._cfg();
    const signature = payload.signature || (payload.headers && payload.headers['x-melio-signature']);
    if (cfg.webhookSecret && signature) {
      const expected = crypto.createHmac('sha256', cfg.webhookSecret).update(safeJson(payload)).digest('hex');
      if (signature !== expected) throw new Error('Melio webhook signature mismatch');
    }
    const paymentId = payload.payment_id || payload.paymentId || payload.id;
    const status = payload.status || payload.payment_status;
    if (!paymentId) return { received: true, note: 'no payment_id in webhook' };
    const record = await this._getPaymentRecord(paymentId) || await this._getPaymentRecord(payload.id);
    if (record && ['completed', 'sent', 'settled'].includes(status) && record.reserve_id && record.status !== 'completed') {
      await this._finalizeReserve(record.reserve_id, `melio:${paymentId}`);
      const updated = { ...record, status: 'completed', result: { ...record.result, webhook: payload } };
      await this._recordPayment(updated);
      return { received: true, paymentId, status: 'completed', reservePosted: record.reserve_id };
    }
    return { received: true, paymentId, status, record };
  }

  static async _process(action, payload = {}) {
    switch (action) {
      case 'status': return await this.status();
      case 'health': return await this.health();
      case 'listVendors': return await this._listVendors(payload);
      case 'createVendor': return await this._createVendor(payload);
      case 'createBill': return await this._createBill(payload);
      case 'schedulePayment': return await this._schedulePayment(payload);
      case 'getPayment': return await this._getPayment(payload);
      case 'listPayments': return await this._listPayments(payload);
      case 'webhook': return await this._webhook(payload);
      case 'process':
      default:
        return await this.status();
    }
  }
}

// ─── PTC Bank Engine ──────────────────────────────────────────────────────────

class PtcBankEngine extends BaseOSEngine {
  static get engineName() { return 'ptc-bank'; }

  static _deps() {
    return {
      TrustBank: tryRequire('../dapp/trustBankEngine')?.TrustBankEngine,
      TrustAccounting: tryRequire('../accounting/trustAccountingEngine')?.TrustAccountingEngine,
      Cash: tryRequire('../cash/cashEngine')?.CashEngine,
      WireEngine: tryRequire('../dapp/wireOriginationEngine')?.WireOriginationEngine,
      AchEngine: tryRequire('../dapp/bankTransferEngine')?.BankTransferEngine,
      OpenBankingEngine: tryRequire('../dapp/openBankingEngine')?.OpenBankingEngine,
      ExternalEndpointEngine: tryRequire('../dapp/externalEndpointEngine')?.ExternalEndpointEngine,
    };
  }

  static _cfg() {
    return {
      live: process.env.PTC_BANK_LIVE === 'true',
      settlementAccount: process.env.PTC_BANK_SETTLEMENT_ACCOUNT || process.env.TRUST_BANK_ACCOUNT || '',
      routing: process.env.PTC_BANK_ROUTING || process.env.TRUST_BANK_ROUTING || '111000025',
      name: process.env.PTC_BANK_NAME || process.env.TRUST_BANK_NAME || 'DLB Trust PTC Bank',
      glAccount: process.env.PTC_BANK_GL_ACCOUNT || '1010',
    };
  }

  static async ensureTables() {
    await super.ensureTables();
    const { TrustBank } = this._deps();
    if (TrustBank) await TrustBank.ensureTables();
  }

  static async status() {
    const { TrustBank, WireEngine, AchEngine, OpenBankingEngine, ExternalEndpointEngine } = this._deps();
    const cfg = this._cfg();
    return {
      engine: this.engineName,
      healthy: !!TrustBank,
      mode: cfg.live ? 'live' : 'shadow',
      settlementAccountConfigured: !!cfg.settlementAccount,
      internalBank: !!TrustBank,
      rails: {
        wire: !!WireEngine,
        ach: !!AchEngine,
        openBanking: !!OpenBankingEngine,
        iso20022: !!OpenBankingEngine,
        external: !!ExternalEndpointEngine,
        bookTransfer: true,
      },
      timestamp: new Date().toISOString(),
    };
  }

  static async health() { return this.status(); }

  static async _resolvePaymentId(paymentId) {
    if (!paymentId || paymentId === 'latest') {
      if (!pool) throw new Error('Postgres pool not available');
      const res = await query(`SELECT payment_id FROM trust_bank_payments WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1`);
      if (!res.rows.length) throw new Error('No pending payment found');
      return res.rows[0].payment_id;
    }
    return paymentId;
  }

  static async _process(action, payload = {}) {
    const { TrustBank } = this._deps();
    if (!TrustBank) throw new Error('TrustBankEngine not available');
    const cfg = this._cfg();

    switch (action) {
      case 'status':
      case 'health':
        return await this.status();
      case 'createCustomer':
        return await TrustBank.createCustomer(payload);
      case 'getCustomer':
        return await TrustBank.getCustomer(payload.customerId);
      case 'listCustomers':
        return await TrustBank.listCustomers({ limit: payload.limit || 50 });
      case 'createAccount': {
        const account = await TrustBank.createAccount({
          customerId: payload.customerId,
          accountName: payload.accountName,
          accountType: payload.accountType || 'checking',
          currency: payload.currency || 'USD',
          linkedCashAccountId: payload.linkedCashAccountId,
          linkedTrustAccountCode: payload.linkedTrustAccountCode,
          metadata: payload.metadata,
        });
        return account;
      }
      case 'getAccount':
        return await TrustBank.getAccount(payload.accountId);
      case 'listAccounts':
        return await TrustBank.listAccounts({ customerId: payload.customerId, limit: payload.limit || 50 });
      case 'deposit':
        return await TrustBank.deposit({
          accountId: payload.accountId,
          amount: payload.amount,
          description: payload.description,
          initiatedBy: payload.initiatedBy || 'os-engine',
        });
      case 'internalTransfer':
        return await TrustBank.internalTransfer({
          fromAccountId: payload.fromAccountId,
          toAccountId: payload.toAccountId,
          amount: payload.amount,
          description: payload.description,
          initiatedBy: payload.initiatedBy || 'os-engine',
        });
      case 'originatePayment': {
        const rail = payload.rail || (cfg.live ? 'wire' : 'book_transfer');
        let endpointId = payload.endpointId;
        if (rail === 'external' && !endpointId) {
          const ep = await SettlementEndpointEngine.resolvePaymentEndpoint({
            external_bank_name: payload.externalBankName,
            external_account_name: payload.externalAccountName,
            external_routing: payload.externalRouting,
          });
          if (ep) endpointId = ep.externalEndpointId;
        }
        const payment = await TrustBank.originatePayment({
          fromAccountId: payload.fromAccountId,
          externalRouting: payload.externalRouting,
          externalAccount: payload.externalAccount,
          externalAccountName: payload.externalAccountName,
          externalBankName: payload.externalBankName || cfg.name,
          amount: payload.amount,
          rail,
          currency: payload.currency || 'USD',
          description: payload.description,
          initiatedBy: payload.initiatedBy || 'os-engine',
          endpointId,
          metadata: payload.metadata,
        });
        const instructions = rail === 'book_transfer'
          ? `Book transfer ${payment.paymentId} originated for $${Number(payload.amount).toFixed(2)}. Settle manually or call settlePayment with an externalTxId.`
          : `Payment ${payment.paymentId} originated via ${rail} for $${Number(payload.amount).toFixed(2)}. Call sendPayment to transmit.`;
        return { ...payment, rail, instructions };
      }
      case 'sendPayment': {
        const paymentId = await this._resolvePaymentId(payload.paymentId);
        const payment = await TrustBank.getPayment(paymentId);
        if (payment && payment.rail === 'external') {
          let meta = payment.metadata || {};
          if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = {}; } }
          if (!meta.endpointId) {
            const ep = await SettlementEndpointEngine.resolvePaymentEndpoint(payment);
            if (ep) {
              meta.endpointId = ep.externalEndpointId;
              await query(`UPDATE trust_bank_payments SET metadata = $1 WHERE payment_id = $2`, [JSON.stringify(meta), paymentId]);
            }
          }
        }
        const sent = await TrustBank.sendPayment(paymentId);
        return sent;
      }
      case 'settlePayment': {
        const paymentId = await this._resolvePaymentId(payload.paymentId);
        return await TrustBank.settlePayment(paymentId, payload.externalTxId);
      }
      case 'getPayment': {
        const paymentId = await this._resolvePaymentId(payload.paymentId);
        return await TrustBank.getPayment(paymentId);
      }
      case 'listPayments':
        return await TrustBank.listPayments({ status: payload.status, limit: payload.limit || 50 });
      case 'fundFromSource': {
        const { TrustAccounting } = this._deps();
        if (!TrustAccounting) throw new Error('TrustAccountingEngine not available for GL funding');
        const { accountId, sourceType, sourceAccountId, amount } = payload;
        if (!accountId || !sourceType || !sourceAccountId || !amount) throw new Error('accountId, sourceType, sourceAccountId, and amount required');
        const account = await TrustBank.getAccount(accountId);
        if (!account) throw new Error(`PTC bank account not found: ${accountId}`);
        const amt = Number(amount);
        if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be positive');
        const glAccountCode = payload.glAccountCode || account.linked_trust_account_code || cfg.glAccount;
        const source = await TrustAccounting.getAccount(sourceAccountId);
        if (!source) throw new Error(`Source GL account not found: ${sourceAccountId}`);
        if (Number(source.balance || 0) * 100 < toCents(amt)) throw new Error(`Insufficient source balance in ${sourceAccountId}: ${source.balance} < ${amt}`);
        const journal = await TrustAccounting.postJournalEntry({
          entryDate: new Date(),
          description: payload.description || `Fund PTC bank account ${accountId} from ${sourceAccountId}`,
          referenceType: 'ptc-bank',
          referenceId: accountId,
          postedBy: payload.initiatedBy || 'ptc-bank',
          postToFineract: false,
          lines: [
            { accountCode: glAccountCode, debitAmount: amt, creditAmount: 0, memo: `PTC bank funding for ${accountId}` },
            { accountCode: sourceAccountId, debitAmount: 0, creditAmount: amt, memo: `Source to PTC bank ${accountId}` },
          ],
        });
        const deposit = await TrustBank.deposit({
          accountId,
          amount: amt,
          description: payload.description || `Funded from ${sourceAccountId} (journal ${journal.entry_id})`,
          initiatedBy: payload.initiatedBy || 'ptc-bank',
        });
        return { funded: true, accountId, amount: amt, deposit, journalEntryId: journal.entry_id, glAccountCode, sourceType, sourceAccountId };
      }
      case 'process':
      default:
        return await this.status();
    }
  }
}

// ─── PTC Treasury Engine ──────────────────────────────────────────────────────
//
// Canonical day-to-day PTC treasury workflow engine.  It unifies the GL, the
// internal PTC bank ledger, fiat payment rails (ACH/wire/check/Melio), and
// on-chain on-ramps into a single `distribute` / `onramp` / `summary` /
// `reconcile` interface.  Every workflow posts to `os_events` and, where
// possible, updates the trust ledger so bank sub-ledgers stay in sync with
// the GL.

class PtcTreasuryEngine extends BaseOSEngine {
  static get engineName() { return 'ptc-treasury'; }

  static _deps() {
    return {
      TrustBank: tryRequire('../dapp/trustBankEngine')?.TrustBankEngine,
      TrustAccounting: tryRequire('../accounting/trustAccountingEngine')?.TrustAccountingEngine,
      DistributionRequest: tryRequire('../dapp/distributionRequestEngine')?.DistributionRequestEngine,
    };
  }

  static _cfg() {
    return {
      live: process.env.PTC_TREASURY_LIVE === 'true',
      defaultPtcBankGl: process.env.PTC_BANK_GL_ACCOUNT || '1010',
      agentWallet: process.env.AGENT_WALLET_ADDRESS || '0x69a32f285ced1dbf102c7baedf0266f1d39580a1',
    };
  }

  static async ensureTables() { await super.ensureTables(); }

  static async status() {
    const cfg = this._cfg();
    return {
      engine: this.engineName,
      healthy: true,
      mode: cfg.live ? 'live' : 'shadow',
      rails: {
        'ptc-bank': !!PtcBankEngine,
        melio: !!MelioEngine,
        'issuer-bridge': !!IssuerBridgeEngine,
        conduit: !!ConduitEngine,
        'wallet-onramp': !!WalletOnRampEngine,
        'smart-router': !!SmartRouterEngine,
      },
      timestamp: new Date().toISOString(),
    };
  }

  static async health() { return this.status(); }

  static _unwrap(res) {
    return res && res.success && res.result !== undefined ? res.result : res;
  }

  static async summary() {
    const { TrustBank, TrustAccounting } = this._deps();
    const cfg = this._cfg();
    const [gl, ptcAccounts, ptcPayments] = await Promise.all([
      TrustAccounting ? TrustAccounting.listAccounts({}).catch(() => []) : [],
      TrustBank ? TrustBank.listAccounts({ limit: 100 }).catch(() => []) : [],
      TrustBank ? TrustBank.listPayments({ limit: 20 }).catch(() => []) : [],
    ]);
    const glTotal = gl.reduce((s, a) => s + Number(a.balance || 0), 0);
    const ptcTotal = ptcAccounts.reduce((s, a) => s + (Number(a.balance_cents || 0) / 100), 0);
    const events = pool ? (await query(`SELECT engine, action, status, COUNT(*) as count FROM os_events WHERE engine IN ('ptc-bank','ptc-treasury','melio','issuer-bridge','conduit','wallet-onramp','smart-router','back-office') GROUP BY engine, action, status`).catch(() => [])) : [];
    return {
      engine: this.engineName,
      generatedAt: new Date().toISOString(),
      mode: cfg.live ? 'live' : 'shadow',
      gl: { accounts: gl, totalUsd: glTotal.toFixed(2) },
      ptcBank: { accounts: ptcAccounts, totalUsd: ptcTotal.toFixed(2), payments: ptcPayments },
      osEvents: events,
    };
  }

  static async reconcile({ glAccountCode } = {}) {
    const { TrustBank, TrustAccounting } = this._deps();
    const cfg = this._cfg();
    const code = glAccountCode || cfg.defaultPtcBankGl;
    const [glAcct, ptcAccounts] = await Promise.all([
      TrustAccounting ? TrustAccounting.getAccount(code).catch(() => null) : null,
      TrustBank ? TrustBank.listAccounts({ limit: 1000 }).catch(() => []) : [],
    ]);
    const ptcTotal = ptcAccounts.reduce((s, a) => s + (Number(a.balance_cents || 0) / 100), 0);
    const glBalance = glAcct ? Number(glAcct.balance || 0) : 0;
    return {
      engine: this.engineName,
      glAccountCode: code,
      glBalance: glBalance.toFixed(2),
      ptcBankBalance: ptcTotal.toFixed(2),
      difference: (glBalance - ptcTotal).toFixed(2),
      reconciled: Math.abs(glBalance - ptcTotal) < 0.01,
      ptcAccounts: ptcAccounts.map(a => ({
        accountId: a.account_id,
        accountName: a.account_name,
        balance: (Number(a.balance_cents || 0) / 100).toFixed(2),
      })),
      timestamp: new Date().toISOString(),
    };
  }

  static _normalizePtcBankRail(rail) {
    const r = String(rail || 'book_transfer').toLowerCase().replace(/-/g, '_');
    if (r === 'ptc_bank' || r === 'book' || r === 'book_transfer' || r === 'check') return 'book_transfer';
    if (['wire','ach','open_banking','iso20022','external'].includes(r)) return r;
    return 'book_transfer';
  }

  static async _fundPtcBankIfNeeded(payload, workflowId) {
    const { fromAccountId, sourceType, sourceAccountId, amount, glAccountCode, description, initiatedBy } = payload;
    if (!fromAccountId || !sourceType || !sourceAccountId) return null;
    if (String(sourceType).toLowerCase() === 'ptc_bank') return null;
    const cfg = this._cfg();
    return await this._unwrap(await PtcBankEngine.process({
      action: 'fundFromSource',
      accountId: fromAccountId,
      sourceType,
      sourceAccountId,
      amount,
      glAccountCode: glAccountCode || cfg.defaultPtcBankGl,
      description: description || `PTC Treasury workflow ${workflowId}`,
      initiatedBy,
    }));
  }

  static async _distributePtcBank(payload, workflowId) {
    const { amount, payee = {}, fromAccountId, externalRouting, externalAccount, externalAccountName, externalBankName, description, memo, initiatedBy } = payload;
    if (!fromAccountId) throw new Error('fromAccountId required for ptc-bank distribution');
    const routing = externalRouting || payee.routing || payee.routingNumber;
    const account = externalAccount || payee.account || payee.accountNumber;
    const accountName = externalAccountName || payee.name || payee.accountName;
    if (!routing || !account || !accountName) throw new Error('payee routing, account, and name required');
    const funded = await this._fundPtcBankIfNeeded(payload, workflowId);
    const rail = this._normalizePtcBankRail(payload.rail);
    const originated = await this._unwrap(await PtcBankEngine.process({
      action: 'originatePayment',
      fromAccountId,
      externalRouting: routing,
      externalAccount: account,
      externalAccountName: accountName,
      externalBankName: externalBankName || payee.bankName || 'External Bank',
      amount,
      rail,
      description: description || memo || `PTC Treasury distribution ${workflowId}`,
      initiatedBy,
    }));
    const paymentId = originated && originated.paymentId;
    let sent = null;
    if (paymentId && payload.autoSend !== false) {
      sent = await this._unwrap(await PtcBankEngine.process({ action: 'sendPayment', paymentId, initiatedBy }));
    }
    return { workflowId, rail, funded, originated, sent, paymentId, status: sent ? sent.status : (originated && originated.status), instructions: originated && originated.instructions };
  }

  static async _distributeMelio(payload, workflowId) {
    const { amount, sourceType, sourceAccountId, payee = {}, vendor = {}, deliveryMethod, description, memo, initiatedBy } = payload;
    const v = vendor.name ? vendor : {
      name: payee.name || vendor.name,
      email: payee.email,
      address: payee.address,
      bankAccount: payee.routing && payee.account ? {
        routingNumber: payee.routing,
        accountNumber: payee.account,
        accountType: payee.accountType || 'checking',
      } : undefined,
    };
    if (!v.name) throw new Error('vendor.name or payee.name required for melio distribution');
    const result = await this._unwrap(await MelioEngine.process({
      action: 'schedulePayment',
      amount,
      sourceType,
      sourceAccountId,
      currency: 'USD',
      vendor: v,
      deliveryMethod: deliveryMethod || 'ach',
      dueDate: payload.dueDate,
      memo: memo || description || `PTC Treasury distribution ${workflowId}`,
      metadata: { workflowId, payee },
      initiatedBy,
    }));
    return { workflowId, rail: 'melio', result };
  }

  static async _onrampIssuerBridge(payload, workflowId) {
    const cfg = this._cfg();
    const { amount, sourceType, sourceAccountId, asset, targetAddress, sourceMethod, description } = payload;
    const result = await this._unwrap(await IssuerBridgeEngine.process({
      action: 'issue',
      sourceType,
      sourceAccountId,
      amount,
      asset: asset || 'USDC',
      recipient: targetAddress || cfg.agentWallet,
      sourceMethod,
      description: description || `PTC Treasury on-ramp ${workflowId}`,
    }));
    return { workflowId, rail: 'issuer-bridge', result };
  }

  static async _onrampConduit(payload, workflowId) {
    const cfg = this._cfg();
    const { amount, sourceType, sourceAccountId, targetAddress } = payload;
    const sources = payload.sources || [{ sourceType, sourceAccountId, amount }];
    const result = await this._unwrap(await ConduitEngine.process({
      action: 'execute',
      sources,
      recipient: targetAddress || cfg.agentWallet,
      description: `PTC Treasury on-ramp ${workflowId}`,
    }));
    return { workflowId, rail: 'conduit', result };
  }

  static async _onrampWalletOnramp(payload, workflowId) {
    const cfg = this._cfg();
    const { amount, sourceType, sourceAccountId, asset, targetAddress, sourceMethod } = payload;
    const result = await this._unwrap(await WalletOnRampEngine.process({
      action: 'fund',
      amount,
      sourceType,
      sourceAccountId,
      asset: asset || 'USDC',
      targetAddress: targetAddress || cfg.agentWallet,
      sourceMethod,
      description: `PTC Treasury on-ramp ${workflowId}`,
    }));
    return { workflowId, rail: 'wallet-onramp', result };
  }

  static async _distributeSmartRouter(payload, workflowId) {
    const { amount, sourceType, sourceAccountId, payee = {}, currency, preferred, targetAddress } = payload;
    const destination = targetAddress ? { type: 'wallet', address: targetAddress } : {
      type: 'bank',
      accountNumber: payee.account || payee.accountNumber,
      routingNumber: payee.routing || payee.routingNumber,
      accountName: payee.name || payee.accountName,
      bankName: payee.bankName,
    };
    const result = await this._unwrap(await SmartRouterEngine.process({
      action: 'deliver',
      amount,
      currency: currency || 'USD',
      source: { type: sourceType || 'trust', accountId: sourceAccountId },
      destination,
      preferred: preferred || payload.rail,
      memo: payload.memo || `PTC Treasury distribution ${workflowId}`,
      initiatedBy: payload.initiatedBy,
    }));
    return { workflowId, rail: 'smart-router', result };
  }

  static async _distribute(payload = {}) {
    const amount = Number(payload.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be positive');
    const rail = String(payload.rail || 'ptc-bank').toLowerCase();
    const workflowId = payload.workflowId || id('PTT-');
    const initiatedBy = payload.initiatedBy || 'ptc-treasury';

    if (rail === 'ptc-bank' || ['wire','ach','open_banking','iso20022','external','book','book_transfer','check'].includes(rail)) {
      return await this._distributePtcBank({ ...payload, initiatedBy }, workflowId);
    }
    if (rail === 'melio') {
      return await this._distributeMelio({ ...payload, initiatedBy }, workflowId);
    }
    if (rail === 'issuer-bridge') {
      return await this._onrampIssuerBridge({ ...payload, initiatedBy }, workflowId);
    }
    if (rail === 'conduit') {
      return await this._onrampConduit({ ...payload, initiatedBy }, workflowId);
    }
    if (rail === 'wallet-onramp' || rail === 'wallet_onramp' || rail === 'alchemy-wallet') {
      return await this._onrampWalletOnramp({ ...payload, initiatedBy }, workflowId);
    }
    if (rail === 'smart-router' || rail === 'smart_router' || rail === 'router') {
      return await this._distributeSmartRouter({ ...payload, initiatedBy }, workflowId);
    }
    throw new Error(`Unsupported PTC Treasury rail: ${rail}`);
  }

  static async _onramp(payload = {}) {
    const amount = Number(payload.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be positive');
    const method = String(payload.method || payload.rail || 'issuer-bridge').toLowerCase();
    const workflowId = payload.workflowId || id('PTT-');
    const initiatedBy = payload.initiatedBy || 'ptc-treasury';
    const p = { ...payload, initiatedBy };
    if (method === 'issuer-bridge' || method === 'issuer_bridge') return await this._onrampIssuerBridge(p, workflowId);
    if (method === 'conduit') return await this._onrampConduit(p, workflowId);
    if (method === 'wallet-onramp' || method === 'wallet_onramp' || method === 'wallet-onramp') return await this._onrampWalletOnramp(p, workflowId);
    throw new Error(`Unsupported PTC Treasury on-ramp method: ${method}`);
  }

  static async _process(action, payload = {}) {
    switch (action) {
      case 'status': return await this.status();
      case 'health': return await this.health();
      case 'summary': return await this.summary();
      case 'reconcile': return await this.reconcile(payload);
      case 'distribute':
      case 'pay':
      case 'distribution':
        return await this._distribute(payload);
      case 'onramp':
      case 'onramp-to-crypto':
      case 'fund-wallet':
        return await this._onramp(payload);
      default:
        return await this.status();
    }
  }
}

// ─── Settlement Endpoint Engine ───────────────────────────────────────────────
//
// Agent-to-agent settlement discovery and handshake. Publishes a well-known
// manifest at /.well-known/dlb-trust-settlement.json, discovers remote manifests,
// performs a token + challenge handshake, and registers remote settlement endpoints
// as ExternalEndpointEngine endpoints so the PTC bank can route real fiat payments
// machine-to-machine without manual credential entry.

class SettlementEndpointEngine extends BaseOSEngine {
  static get engineName() { return 'settlement-endpoint'; }

  static _cfg() {
    const port = process.env.PORT || 3002;
    return {
      agentId: process.env.SETTLEMENT_AGENT_ID || process.env.TRUST_NAME || 'dlb-trust-ptc',
      baseUrl: process.env.APP_URL || process.env.DEPLOY_URL || (process.env.NODE_ENV === 'production' ? null : `http://localhost:${port}`),
      discoveryUrls: (process.env.SETTLEMENT_DISCOVERY_URLS || '').split(',').map(s => s.trim()).filter(Boolean),
      autoHandshake: process.env.SETTLEMENT_AUTO_HANDSHAKE === 'true',
      autoDiscover: process.env.SETTLEMENT_AUTO_DISCOVER !== 'false',
      verifySignatures: process.env.SETTLEMENT_VERIFY_SIGNATURES !== 'false',
    };
  }

  static _paths() {
    const base = this._cfg().baseUrl || '';
    return {
      handshake: `${base}/api/settlement/handshake`,
      payment: `${base}/api/settlement/payment`,
      status: `${base}/api/os/settlement-endpoint/status`,
      wellKnown: `${base}/.well-known/dlb-trust-settlement.json`,
    };
  }

  static _sign({ challenge, timestamp, secret }) {
    return crypto.createHmac('sha256', String(secret)).update(`${timestamp}.${challenge}`).digest('hex');
  }

  static _verify({ challenge, timestamp, signature, secret, maxAgeMs = 300000 }) {
    if (!challenge || !timestamp || !signature || !secret) return false;
    if (Date.now() - Number(timestamp) > maxAgeMs) return false;
    return this._sign({ challenge, timestamp, secret }) === String(signature);
  }

  static async ensureTables() {
    await super.ensureTables();
    if (!pool) return;
    await query(`
      CREATE TABLE IF NOT EXISTS settlement_agent (
        singleton TEXT PRIMARY KEY DEFAULT 'default',
        agent_id TEXT NOT NULL,
        agent_token TEXT NOT NULL,
        base_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS settlement_endpoints (
        endpoint_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        base_url TEXT NOT NULL,
        payment_url TEXT,
        handshake_url TEXT,
        protocol TEXT NOT NULL DEFAULT 'rest_json',
        auth_type TEXT NOT NULL DEFAULT 'bearer',
        api_key TEXT,
        api_secret TEXT,
        capabilities JSONB DEFAULT '[]',
        metadata JSONB DEFAULT '{}',
        external_endpoint_id TEXT,
        status TEXT NOT NULL DEFAULT 'discovered' CHECK (status IN ('discovered','handshaking','active','failed','disabled')),
        last_seen_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_settlement_endpoints_status ON settlement_endpoints(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_settlement_endpoints_name ON settlement_endpoints(name)`);
    await query(`
      CREATE TABLE IF NOT EXISTS settlement_payments (
        payment_id TEXT PRIMARY KEY,
        endpoint_id TEXT REFERENCES settlement_endpoints(endpoint_id),
        direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
        reference_id TEXT,
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        debtor JSONB DEFAULT '{}',
        creditor JSONB DEFAULT '{}',
        raw_payload JSONB DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','originated','completed','failed','rejected')),
        external_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  static async getOrCreateAgent() {
    await this.ensureTables();
    if (!pool) throw new Error('Postgres pool not available');
    const cfg = this._cfg();
    let res = await query(`SELECT * FROM settlement_agent WHERE singleton = $1`, ['default']);
    let token = process.env.SETTLEMENT_API_KEY || null;
    if (!res.rows.length) {
      if (!token) token = crypto.randomBytes(32).toString('hex');
      await query(`INSERT INTO settlement_agent (singleton, agent_id, agent_token, base_url) VALUES ($1,$2,$3,$4) ON CONFLICT (singleton) DO NOTHING`, ['default', cfg.agentId, token, cfg.baseUrl]);
      res = await query(`SELECT * FROM settlement_agent WHERE singleton = $1`, ['default']);
    } else if (token && res.rows[0].agent_token !== token) {
      await query(`UPDATE settlement_agent SET agent_id = $1, agent_token = $2, base_url = $3, updated_at = NOW() WHERE singleton = $4`, [cfg.agentId, token, cfg.baseUrl, 'default']);
      res = await query(`SELECT * FROM settlement_agent WHERE singleton = $1`, ['default']);
    }
    return res.rows[0];
  }

  static async status() {
    await this.ensureTables();
    const agent = await this.getOrCreateAgent().catch(() => null);
    const cfg = this._cfg();
    const eps = pool ? await query(`SELECT status, COUNT(*) FROM settlement_endpoints GROUP BY status`) : { rows: [] };
    const statusCounts = {};
    for (const r of eps.rows) statusCounts[r.status] = parseInt(r.count, 10);
    return {
      engine: this.engineName,
      healthy: true,
      mode: 'live',
      agentId: agent ? agent.agent_id : cfg.agentId,
      baseUrl: cfg.baseUrl,
      discoveryUrls: cfg.discoveryUrls,
      wellKnown: this._paths().wellKnown,
      statusCounts,
      timestamp: new Date().toISOString(),
    };
  }

  static getWellKnown() {
    const cfg = this._cfg();
    return {
      agentId: cfg.agentId,
      baseUrl: cfg.baseUrl,
      version: '1.0',
      capabilities: ['book_transfer','ach','wire','external','iso20022'],
      endpoints: this._paths(),
      publicKey: null,
    };
  }

  static async discover(rawUrl) {
    if (!rawUrl) throw new Error('url required');
    let url = String(rawUrl).trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const wellKnownUrl = url.endsWith('.json') ? url : `${url.replace(/\/$/, '')}/.well-known/dlb-trust-settlement.json`;
    let resp;
    try {
      resp = await fetch(wellKnownUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    } catch (e) { throw new Error(`Well-known fetch failed: ${e.message}`); }
    if (!resp.ok) {
      try {
        resp = await fetch(`${url.replace(/\/$/, '')}/api/settlement/endpoints`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      } catch (e) { throw new Error(`Discovery failed: ${e.message}`); }
      if (!resp.ok) throw new Error(`Discovery failed: ${resp.status} ${resp.statusText}`);
    }
    const manifest = await resp.json();
    if (!manifest.agentId || !manifest.endpoints) throw new Error('Invalid settlement manifest');
    const paymentUrl = manifest.endpoints.payment || manifest.endpoints.payments;
    const handshakeUrl = manifest.endpoints.handshake;
    if (!paymentUrl || !handshakeUrl) throw new Error('Manifest missing handshake or payment endpoint');
    const baseUrl = manifest.baseUrl || url;
    const caps = JSON.stringify(manifest.capabilities || []);
    await this.ensureTables();
    const endpointId = id('SET');
    const res = await query(`
      INSERT INTO settlement_endpoints (endpoint_id, name, url, base_url, payment_url, handshake_url, protocol, auth_type, capabilities, metadata, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (url) DO UPDATE SET
        name = EXCLUDED.name,
        base_url = EXCLUDED.base_url,
        payment_url = EXCLUDED.payment_url,
        handshake_url = EXCLUDED.handshake_url,
        capabilities = EXCLUDED.capabilities,
        metadata = EXCLUDED.metadata,
        status = 'discovered',
        updated_at = NOW()
      RETURNING *`,
      [endpointId, manifest.agentId, baseUrl, paymentUrl, paymentUrl, handshakeUrl, 'rest_json', 'bearer', caps, JSON.stringify(manifest), 'discovered']
    );
    if (this._cfg().autoHandshake) return await this.handshake(endpointId);
    return { discovered: true, endpointId: res.rows[0].endpoint_id, manifest };
  }

  static async handshake(input) {
    await this.ensureTables();
    if (!pool) throw new Error('Postgres pool not available');
    let endpoint;
    if (String(input).startsWith('http')) {
      const discovered = await this.discover(input);
      endpoint = (await query(`SELECT * FROM settlement_endpoints WHERE endpoint_id = $1`, [discovered.endpointId])).rows[0];
    } else {
      endpoint = (await query(`SELECT * FROM settlement_endpoints WHERE endpoint_id = $1`, [input])).rows[0];
    }
    if (!endpoint) throw new Error('Settlement endpoint not found');
    if (!endpoint.handshake_url) throw new Error('No handshake_url for endpoint');
    const agent = await this.getOrCreateAgent();
    const cfg = this._cfg();
    const challenge = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now();
    const sig = this._sign({ challenge, timestamp, secret: agent.agent_token });
    const payload = {
      agentId: agent.agent_id,
      agentToken: agent.agent_token,
      baseUrl: cfg.baseUrl,
      capabilities: ['book_transfer','ach','wire','external','iso20022'],
      endpoints: this._paths(),
      challenge,
      timestamp,
      signature: sig,
    };
    const resp = await fetch(endpoint.handshake_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    let remote;
    try { remote = await resp.json(); } catch { remote = {}; }
    if (remote && remote.success && remote.data) remote = remote.data;
    if (!resp.ok) {
      await query(`UPDATE settlement_endpoints SET status = 'failed', updated_at = NOW() WHERE endpoint_id = $1`, [endpoint.endpoint_id]);
      throw new Error(`Handshake rejected: ${resp.status} ${safeJson(remote).slice(0,200)}`);
    }
    if (!remote.agentId || !remote.agentToken || !remote.signature) throw new Error('Invalid handshake response');
    const remoteTs = Number(remote.timestamp || timestamp);
    if (cfg.verifySignatures && !this._verify({ challenge, timestamp: remoteTs, signature: remote.signature, secret: remote.agentToken })) {
      await query(`UPDATE settlement_endpoints SET status = 'failed', updated_at = NOW() WHERE endpoint_id = $1`, [endpoint.endpoint_id]);
      throw new Error('Handshake signature verification failed');
    }
    const External = this._externalEngine();
    if (!External) throw new Error('ExternalEndpointEngine not available');
    await External.ensureTables();
    const ep = await External.createEndpoint({
      name: `Settlement: ${remote.agentId}`,
      baseUrl: endpoint.payment_url,
      authType: 'bearer',
      apiKey: remote.agentToken,
      apiSecret: '',
      responseSuccessPath: 'success',
      extraHeaders: { 'X-Settlement-Agent': remote.agentId },
      config: { settlementEndpointId: endpoint.endpoint_id },
    });
    await query(`
      UPDATE settlement_endpoints
      SET status = 'active', api_key = $1, api_secret = $2, metadata = jsonb_set(COALESCE(metadata,'{}'::jsonb), '{remote}', $3::jsonb), external_endpoint_id = $4, last_seen_at = NOW(), updated_at = NOW()
      WHERE endpoint_id = $5`,
      [remote.agentToken, '', JSON.stringify(remote), ep.endpoint_id, endpoint.endpoint_id]
    );
    return { handshaked: true, endpointId: endpoint.endpoint_id, agentId: remote.agentId, externalEndpointId: ep.endpoint_id };
  }

  static _externalEngine() {
    return tryRequire('../dapp/externalEndpointEngine')?.ExternalEndpointEngine;
  }

  static async register(opts = {}) {
    await this.ensureTables();
    const { name, url, paymentUrl, handshakeUrl, capabilities = [], metadata = {} } = opts;
    if (!url || !name) throw new Error('name and url required');
    const endpointId = id('SET');
    const res = await query(`
      INSERT INTO settlement_endpoints (endpoint_id, name, url, base_url, payment_url, handshake_url, capabilities, metadata, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (url) DO UPDATE SET
        name = EXCLUDED.name,
        base_url = EXCLUDED.base_url,
        payment_url = EXCLUDED.payment_url,
        handshake_url = EXCLUDED.handshake_url,
        capabilities = EXCLUDED.capabilities,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *`,
      [endpointId, name, url, paymentUrl || url, paymentUrl || url, handshakeUrl || `${url.replace(/\/$/, '')}/api/settlement/handshake`, JSON.stringify(capabilities), JSON.stringify(metadata), 'discovered']
    );
    return res.rows[0];
  }

  static async list({ limit = 50, status } = {}) {
    await this.ensureTables();
    let sql = 'SELECT endpoint_id, name, url, base_url, payment_url, handshake_url, protocol, auth_type, capabilities, metadata, external_endpoint_id, status, last_seen_at, created_at, updated_at FROM settlement_endpoints';
    const params = [];
    if (status) { sql += ` WHERE status = $${params.length + 1}`; params.push(status); }
    sql += ` ORDER BY updated_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    const res = await query(sql, params);
    return res.rows;
  }

  static async get(endpointId) {
    await this.ensureTables();
    const res = await query(`SELECT * FROM settlement_endpoints WHERE endpoint_id = $1`, [endpointId]);
    return res.rows[0] || null;
  }

  static async autoDiscover() {
    const cfg = this._cfg();
    const results = [];
    for (const url of cfg.discoveryUrls) {
      try { results.push(await this.handshake(url)); } catch (e) { results.push({ url, error: e.message }); }
    }
    return { results, discoveryUrls: cfg.discoveryUrls };
  }

  static async receiveHandshake(payload = {}) {
    await this.ensureTables();
    const { agentId, agentToken, baseUrl, capabilities, endpoints, challenge, timestamp, signature } = payload;
    if (!agentId || !agentToken || !challenge || !signature) throw new Error('Invalid handshake payload');
    const cfg = this._cfg();
    if (cfg.verifySignatures && !this._verify({ challenge, timestamp, signature, secret: agentToken })) {
      throw new Error('Handshake signature verification failed');
    }
    const agent = await this.getOrCreateAgent();
    const responseSig = this._sign({ challenge, timestamp, secret: agent.agent_token });
    const url = baseUrl || (endpoints && endpoints.wellKnown);
    if (url) {
      const endpointId = id('SET');
      await query(`
        INSERT INTO settlement_endpoints (endpoint_id, name, url, base_url, payment_url, handshake_url, capabilities, metadata, status, last_seen_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
        ON CONFLICT (url) DO UPDATE SET
          name = EXCLUDED.name,
          base_url = EXCLUDED.base_url,
          payment_url = EXCLUDED.payment_url,
          handshake_url = EXCLUDED.handshake_url,
          capabilities = EXCLUDED.capabilities,
          metadata = EXCLUDED.metadata,
          status = 'active',
          last_seen_at = NOW(),
          updated_at = NOW()`,
        [endpointId, agentId, url,
         endpoints && endpoints.payment ? endpoints.payment : `${url.replace(/\/$/, '')}/api/settlement/payment`,
         endpoints && endpoints.payment ? endpoints.payment : `${url.replace(/\/$/, '')}/api/settlement/payment`,
         endpoints && endpoints.handshake ? endpoints.handshake : `${url.replace(/\/$/, '')}/api/settlement/handshake`,
         JSON.stringify(capabilities || []), JSON.stringify(payload), 'active']
      );
    }
    return {
      agentId: agent.agent_id,
      agentToken: agent.agent_token,
      baseUrl: cfg.baseUrl,
      capabilities: ['book_transfer','ach','wire','external','iso20022'],
      endpoints: this._paths(),
      challenge,
      timestamp,
      signature: responseSig,
    };
  }

  static async receivePayment(payload = {}, headers = {}) {
    await this.ensureTables();
    const auth = String(headers.authorization || headers.Authorization || '');
    const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    if (!token) throw Object.assign(new Error('Missing authorization'), { status: 401 });
    const res = await query(`SELECT * FROM settlement_endpoints WHERE api_key = $1 AND status = 'active' LIMIT 1`, [token]);
    if (!res.rows.length) throw Object.assign(new Error('Unknown settlement endpoint'), { status: 401 });
    const endpoint = res.rows[0];
    const referenceId = payload.referenceId || payload.reference_id;
    const amount = payload.amount;
    const currency = payload.currency || 'USD';
    const debtor = payload.debtor || {};
    const creditor = payload.creditor || {};
    if (!referenceId || amount == null) throw new Error('referenceId and amount required');
    const cents = toCents(amount);
    const paymentId = id('SPT');
    await query(`
      INSERT INTO settlement_payments (payment_id, endpoint_id, direction, reference_id, amount_cents, currency, debtor, creditor, raw_payload, status)
      VALUES ($1,$2,'inbound',$3,$4,$5,$6,$7,$8,'received')`,
      [paymentId, endpoint.endpoint_id, referenceId, cents, currency, JSON.stringify(debtor), JSON.stringify(creditor), JSON.stringify(payload)]
    );
    return { success: true, paymentId, payment_id: paymentId, transaction_id: paymentId, referenceId, status: 'originated', receivedAt: new Date().toISOString() };
  }

  static async resolvePaymentEndpoint(payment = {}) {
    const External = this._externalEngine();
    if (!External) return null;
    await External.ensureTables();
    const eps = await External.listEndpoints({ enabled: true });
    if (!eps || !eps.length) return null;
    const bankName = payment.external_bank_name || '';
    const accountName = payment.external_account_name || '';
    let best = eps[0];
    if (bankName || accountName) {
      const needle = (bankName || accountName).toLowerCase();
      const match = eps.find(ep => (ep.name || '').toLowerCase().includes(needle) || (ep.config && JSON.stringify(ep.config).toLowerCase().includes(needle)));
      if (match) best = match;
    }
    return { externalEndpointId: best.endpoint_id, name: best.name };
  }

  static async routePayment(payload = {}) {
    await this.ensureTables();
    const { endpointId, url, referenceId, amount, currency = 'USD', debtor, creditor, description } = payload;
    if (!amount || (!endpointId && !url)) throw new Error('endpointId or url, and amount required');
    let endpoint;
    if (endpointId) endpoint = await this.get(endpointId);
    else endpoint = (await query(`SELECT * FROM settlement_endpoints WHERE url = $1 OR base_url = $1 LIMIT 1`, [url])).rows[0];
    if (!endpoint || !endpoint.payment_url) throw new Error('Settlement endpoint not found');
    if (!endpoint.api_key) throw new Error('Endpoint has no active token');
    const paymentId = id('SPT');
    const outPayload = {
      reference_id: referenceId || paymentId,
      amount,
      currency,
      payment_type: payload.paymentType || payload.payment_type || 'external',
      description: description || `Settlement payment ${paymentId}`,
      debtor: debtor || {},
      creditor: creditor || {},
    };
    await query(`INSERT INTO settlement_payments (payment_id, endpoint_id, direction, reference_id, amount_cents, currency, debtor, creditor, raw_payload, status) VALUES ($1,$2,'outbound',$3,$4,$5,$6,$7,$8,'originated')`, [paymentId, endpoint.endpoint_id, outPayload.reference_id, toCents(amount), currency, JSON.stringify(debtor || {}), JSON.stringify(creditor || {}), JSON.stringify(outPayload)]);
    const resp = await fetch(endpoint.payment_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.api_key}`, 'X-Settlement-Agent': endpoint.name },
      body: JSON.stringify(outPayload),
      signal: AbortSignal.timeout(30000),
    });
    let body = {};
    try { body = await resp.json(); } catch { body = {}; }
    if (body && body.success && body.data) body = body.data;
    const status = resp.ok && body.success ? 'completed' : (resp.ok ? 'originated' : 'failed');
    await query(`UPDATE settlement_payments SET status = $1, external_id = $2, raw_payload = jsonb_set(raw_payload, '{response}', $3::jsonb), updated_at = NOW() WHERE payment_id = $4`, [status, body.paymentId || null, JSON.stringify({ status: resp.status, body }), paymentId]);
    return { paymentId, status, response: body };
  }

  static async _process(action, payload = {}) {
    switch (action) {
      case 'status':
      case 'health':
        return await this.status();
      case 'discover':
        return await this.discover(payload.url || payload.domain);
      case 'handshake':
        return await this.handshake(payload.endpointId || payload.url);
      case 'register':
        return await this.register(payload);
      case 'list':
        return await this.list({ limit: payload.limit, status: payload.status });
      case 'get':
        return await this.get(payload.endpointId);
      case 'auto-discover':
      case 'autoDiscover':
        return await this.autoDiscover();
      case 'route-payment':
      case 'routePayment':
        return await this.routePayment(payload);
      case 'receive-handshake':
      case 'receiveHandshake':
        return await this.receiveHandshake(payload);
      case 'receive-payment':
      case 'receivePayment':
        return await this.receivePayment(payload, payload.headers || {});
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
  'wallet-onramp': WalletOnRampEngine,
  'alchemy-wallet': AlchemyWalletEngine,
  tokenization: TokenizationEngine,
  conduit: ConduitEngine,
  'issuer-bridge': IssuerBridgeEngine,
  melio: MelioEngine,
  'ptc-bank': PtcBankEngine,
  'ptc-treasury': PtcTreasuryEngine,
  'settlement-endpoint': SettlementEndpointEngine,
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
  WalletOnRampEngine,
  AlchemyWalletEngine,
  TokenizationEngine,
  ConduitEngine,
  IssuerBridgeEngine,
  MelioEngine,
  PtcBankEngine,
  PtcTreasuryEngine,
  SettlementEndpointEngine,
  engines: ENGINES,
  ensureAll,
};
