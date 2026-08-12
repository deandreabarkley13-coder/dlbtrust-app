'use strict';

/**
 * Finance Operating Server Engine
 *
 * Central operating layer for the AI FinOps Agent. It unifies cash, treasury,
 * payment processor, payment gateway, deposit/settlement, clearing, and system
 * health into a single command/response interface and persists every command
 * for audit and replay.
 */

const pg = require('../bonds/pgPool');

const COMMANDS_TABLE = 'finance_operating_commands';
const SESSIONS_TABLE = 'finance_operating_sessions';

function generateId(prefix = 'FOSE') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function safeJson(value) {
  try { return JSON.stringify(value || {}); } catch (e) { return '{}'; }
}

function toCents(amount) {
  return Math.round(parseFloat(amount || 0) * 100);
}

function parseAmount(text) {
  const m = String(text).match(/(?:\$?\s*)([0-9,]+(?:\.[0-9]+)?)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

function parseJsonLike(value) {
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (e) { return null; }
}

class FinanceOperatingServerEngine {
  static async ensureTables() {
    if (!pg || !pg.query) return;
    await pg.query(`
      CREATE TABLE IF NOT EXISTS ${SESSIONS_TABLE} (
        session_id TEXT PRIMARY KEY,
        user_id TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed','expired')),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pg.query(`
      CREATE TABLE IF NOT EXISTS ${COMMANDS_TABLE} (
        command_id TEXT PRIMARY KEY,
        session_id TEXT,
        user_id TEXT,
        command TEXT NOT NULL,
        intent TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
        response JSONB DEFAULT '{}',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_fose_commands_session ON ${COMMANDS_TABLE}(session_id, created_at DESC)`);
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_fose_commands_user ON ${COMMANDS_TABLE}(user_id, created_at DESC)`);
  }

  static async createSession({ userId, metadata = {} } = {}) {
    await this.ensureTables();
    const sessionId = generateId('FOS');
    if (pg && pg.query) {
      await pg.query(
        `INSERT INTO ${SESSIONS_TABLE} (session_id, user_id, metadata) VALUES ($1,$2,$3::jsonb)`,
        [sessionId, userId || null, safeJson(metadata)]
      );
    }
    return { sessionId, status: 'active' };
  }

  static async getSession(sessionId) {
    if (!pg || !pg.query) return null;
    const res = await pg.query(`SELECT * FROM ${SESSIONS_TABLE} WHERE session_id=$1`, [sessionId]);
    return res.rows[0] || null;
  }

  static async listSessions({ userId, limit = 50 } = {}) {
    if (!pg || !pg.query) return [];
    const where = userId ? 'WHERE user_id=$1' : '';
    const params = userId ? [userId, limit] : [limit];
    const res = await pg.query(
      `SELECT * FROM ${SESSIONS_TABLE} ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    return res.rows;
  }

  static async _logCommand({ sessionId, userId, command, intent, status, response, metadata }) {
    if (!pg || !pg.query) return null;
    const commandId = generateId('FOC');
    await pg.query(
      `INSERT INTO ${COMMANDS_TABLE} (command_id, session_id, user_id, command, intent, status, response, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
      [commandId, sessionId || null, userId || null, command, intent || 'unknown', status, safeJson(response), safeJson(metadata)]
    );
    return commandId;
  }

  static async listCommands({ sessionId, userId, limit = 50 } = {}) {
    if (!pg || !pg.query) return [];
    const conditions = [];
    const params = [];
    if (sessionId) { conditions.push(`session_id=$${params.length + 1}`); params.push(sessionId); }
    if (userId) { conditions.push(`user_id=$${params.length + 1}`); params.push(userId); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const res = await pg.query(
      `SELECT * FROM ${COMMANDS_TABLE} ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    return res.rows.map(r => ({
      ...r,
      response: typeof r.response === 'string' ? JSON.parse(r.response) : r.response,
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata,
    }));
  }

  static _inferCommandIntent(command) {
    const t = String(command || '').toLowerCase();
    if (/\b(health|status|system check|ping)\b/.test(t)) return 'health';
    if (/\b(cash position|cash|balance|balances|treasury|liquidity|position)\b/.test(t)) return 'cash_position';
    if (/\b(processors|rails|payment rails|gateways|providers)\b/.test(t)) return 'list_processors';
    if (/\b(pay|send|payout|disburse|process payment)\b/.test(t)) return 'process_payment';
    if (/\b(deposit|fund|inbound|receive)\b/.test(t)) return 'record_deposit';
    if (/\b(settle|settlement|outbound settlement|clear)\b/.test(t)) return 'initiate_settlement';
    if (/\b(reconcile|reconciliation|match|update status)\b/.test(t)) return 'reconcile';
    if (/\b(sessions|history|list commands|my commands)\b/.test(t)) return 'list_commands';
    if (/\b(swap|convert|exchange)\b.*\b(dai|usds|usdc|eth|dlb-prb|interest|principal)\b/.test(t)) return 'finops_agent';
    if (/\b(show|get|list|what is|what are|overview)\b/.test(t)) return 'finops_agent';
    return 'unknown';
  }

  static async _health() {
    const checks = { timestamp: new Date().toISOString(), ok: true, checks: {} };

    try {
      const { FinOpsCoordinationEngine } = require('./finopsCoordinationEngine');
      checks.checks.finopsCoordination = await FinOpsCoordinationEngine.systemHealth();
      if (!checks.checks.finopsCoordination.ok) checks.ok = false;
    } catch (e) { checks.checks.finopsCoordination = { ok: false, error: e.message }; checks.ok = false; }

    try {
      const { CashEngine } = require('../cash/cashEngine');
      const summary = await CashEngine.getPositionSummary();
      checks.checks.cash = { ok: true, summary };
    } catch (e) { checks.checks.cash = { ok: false, error: e.message }; checks.ok = false; }

    try {
      const { PaymentProcessorServerEngine } = require('../payments/paymentProcessorServerEngine');
      const processors = PaymentProcessorServerEngine.getProcessors();
      checks.checks.paymentProcessors = { ok: true, count: processors.length };
    } catch (e) { checks.checks.paymentProcessors = { ok: false, error: e.message }; checks.ok = false; }

    return checks;
  }

  static async _cashPosition() {
    const result = { timestamp: new Date().toISOString(), sources: {} };

    try {
      const { CashEngine } = require('../cash/cashEngine');
      result.sources.cashAccounts = await CashEngine.listAccounts({});
      result.sources.cashSummary = await CashEngine.getPositionSummary();
    } catch (e) { result.sources.cashError = e.message; }

    try {
      const { DappEngine } = require('../dapp/dappEngine');
      result.sources.sourceOfFunds = await DappEngine.listSourceBalances();
    } catch (e) { result.sources.sourceOfFundsError = e.message; }

    try {
      const { CorporateTreasuryEngine } = require('./corporateTreasuryEngine');
      result.sources.corporateTreasury = await CorporateTreasuryEngine.getDashboard();
    } catch (e) { result.sources.corporateTreasuryError = e.message; }

    try {
      const { PaymentProcessorServerEngine } = require('../payments/paymentProcessorServerEngine');
      result.sources.processors = PaymentProcessorServerEngine.getProcessors().map(p => p.name);
    } catch (e) { result.sources.processorsError = e.message; }

    return result;
  }

  static async _listProcessors() {
    const { PaymentProcessorServerEngine } = require('../payments/paymentProcessorServerEngine');
    const processors = PaymentProcessorServerEngine.getProcessors();
    return { processors };
  }

  static async _processPayment(command, params = {}) {
    const amount = parseAmount(command) || params.amount;
    if (!amount) throw new Error('Amount not found in command or params');

    const processor = params.processor || this._extractProcessor(command);
    const rail = params.rail || this._extractRail(command);
    const direction = params.direction || (/\b(deposit|inbound|receive|fund)\b/i.test(command) ? 'inbound' : 'outbound');

    const destination = params.destination || parseJsonLike(params.destinationJson) || {};
    const source = params.source || parseJsonLike(params.sourceJson) || {};

    const { PaymentProcessorServerEngine } = require('../payments/paymentProcessorServerEngine');
    const result = await PaymentProcessorServerEngine.processPayment({
      processor,
      rail,
      direction,
      amount,
      currency: params.currency || 'USD',
      source,
      destination,
      reference: params.reference || `FOSE-${Date.now()}`,
      metadata: params.metadata || {},
      initiatedBy: params.userId || 'finance-operating-engine',
    });
    return result;
  }

  static async _recordDeposit(params = {}) {
    const { DepositAndSettlementEngine } = require('../payments/depositAndSettlementEngine');
    return await DepositAndSettlementEngine.deposit({
      amount: params.amount,
      rail: params.rail || 'stripe_treasury',
      cashAccountId: params.cashAccountId || 'CA-STRIPE-TREASURY',
      trustAccountCode: params.trustAccountCode || 'PTC-DEPOSIT-CLEARING',
      externalReference: params.externalReference || `FOSE-DEP-${Date.now()}`,
      description: params.description || 'Finance Operating Server deposit',
      metadata: params.metadata || {},
      initiatedBy: params.userId || 'finance-operating-engine',
    });
  }

  static async _initiateSettlement(params = {}) {
    const { DepositAndSettlementEngine } = require('../payments/depositAndSettlementEngine');
    return await DepositAndSettlementEngine.initiateSettlement({
      amount: params.amount,
      rail: params.rail || 'manual',
      sourceCashAccountId: params.sourceCashAccountId || 'CA-OPERATING',
      sourceTrustAccountCode: params.sourceTrustAccountCode || 'PTC-DEPOSIT-CLEARING',
      destination: parseJsonLike(params.destination) || params.destination || {},
      requireCip: params.requireCip !== false,
      description: params.description || 'Finance Operating Server settlement',
      metadata: params.metadata || {},
      initiatedBy: params.userId || 'finance-operating-engine',
    });
  }

  static async _reconcile(params = {}) {
    const { DepositAndSettlementEngine } = require('../payments/depositAndSettlementEngine');
    const { PaymentProcessorServerEngine } = require('../payments/paymentProcessorServerEngine');

    if (params.processorTxId || params.processor) {
      return await PaymentProcessorServerEngine.reconcile({
        txId: params.txId || params.processorTxId,
        externalReference: params.externalReference,
        status: params.status,
        rawResponse: params.rawResponse || {},
        initiatedBy: params.userId || 'finance-operating-engine',
      });
    }

    return await DepositAndSettlementEngine.reconcile({
      orderId: params.orderId,
      externalReference: params.externalReference,
      status: params.status,
      rawResponse: params.rawResponse || {},
      initiatedBy: params.userId || 'finance-operating-engine',
    });
  }

  static _extractProcessor(text) {
    const t = String(text || '').toLowerCase();
    if (/\b(stripe|stripe treasury)\b/.test(t)) return 'stripe_treasury';
    if (/\b(clearing|clearpoint)\b/.test(t)) return 'clearing';
    if (/\b(lili|lili bank)\b/.test(t)) return 'lili';
    if (/\b(skrill)\b/.test(t)) return 'skrill';
    if (/\b(payout center|payout)\b/.test(t)) return 'payout_center';
    return null;
  }

  static _extractRail(text) {
    const t = String(text || '').toLowerCase();
    if (/\bach\b/.test(t) && !/\bwire\b/.test(t)) return 'ach';
    if (/\bwire\b/.test(t)) return 'wire';
    if (/\bmanual\b/.test(t)) return 'manual';
    if (/\bcard\b/.test(t)) return 'push_to_card';
    return null;
  }

  static async _finopsAgentFallback({ command, userId }) {
    try {
      const { FinOpsAgent } = require('../agents/finOpsAgent');
      return await FinOpsAgent.process({ command, userId });
    } catch (e) {
      return { type: 'error', summary: `FinOps Agent fallback failed: ${e.message}` };
    }
  }

  static async executeCommand({ command, userId, sessionId, params = {} }) {
    await this.ensureTables();
    const intent = this._inferCommandIntent(command);
    const response = { intent, type: 'action', summary: '', data: null, requiresApproval: false };
    let status = 'completed';

    try {
      switch (intent) {
        case 'health':
          response.data = await this._health();
          response.type = 'data';
          response.summary = `System health: ${response.data.ok ? 'OK' : 'degraded'}.`;
          break;
        case 'cash_position':
          response.data = await this._cashPosition();
          response.type = 'data';
          response.summary = 'Cash and treasury position loaded.';
          break;
        case 'list_processors':
          response.data = await this._listProcessors();
          response.type = 'data';
          response.summary = `Available processors: ${response.data.processors.map(p => p.name).join(', ')}.`;
          break;
        case 'process_payment':
          response.data = await this._processPayment(command, { ...params, userId });
          response.summary = `Payment processed: ${response.data.processorTxId || response.data.transactionId} (${response.data.status}).`;
          break;
        case 'record_deposit':
          response.data = await this._recordDeposit({ ...params, userId });
          response.summary = `Deposit recorded: ${response.data.orderId} (${response.data.status}).`;
          break;
        case 'initiate_settlement':
          response.data = await this._initiateSettlement({ ...params, userId });
          response.summary = `Settlement initiated: ${response.data.orderId} (${response.data.status}).`;
          if (response.data.status === 'manual') {
            response.summary += ` Instruction: ${response.data.clearingResult?.result?.instruction || response.data.prefundResult?.instruction || 'see clearing result'}`;
          }
          break;
        case 'reconcile':
          response.data = await this._reconcile({ ...params, userId });
          response.summary = `Reconciled: ${response.data.orderId || response.data.txId} now ${response.data.status}.`;
          break;
        case 'list_commands':
          response.data = await this.listCommands({ sessionId, userId, limit: params.limit || 20 });
          response.type = 'data';
          response.summary = `Found ${response.data.length} recent command(s).`;
          break;
        default:
          response.data = await this._finopsAgentFallback({ command, userId });
          response.type = response.data.type || 'action';
          response.summary = response.data.summary || 'FinOps Agent handled the command.';
          response.requiresApproval = response.data.requiresApproval || false;
      }
    } catch (err) {
      status = 'failed';
      response.summary = err.message;
      response.error = err.message;
    }

    const commandId = await this._logCommand({
      sessionId,
      userId,
      command,
      intent,
      status,
      response,
      metadata: params,
    });

    return { commandId, sessionId, ...response };
  }

  static async health() { return this.executeCommand({ command: 'health check' }); }
  static async cashPosition() { return this.executeCommand({ command: 'cash position' }); }
  static async listProcessors() { return this.executeCommand({ command: 'list processors' }); }
}

module.exports = { FinanceOperatingServerEngine };
