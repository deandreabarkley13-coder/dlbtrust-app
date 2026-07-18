'use strict';

/**
 * Internal Rails connector — bridges the Banking Aggregator to this platform's
 * own payment rails so the hub can move money in both directions across
 * Wire, ACH, and STP (straight-through processing) without leaving the app.
 *
 * OUTBOUND (push): initiate a debit or credit through a rail.
 *   payload = {
 *     rail: 'wire' | 'ach' | 'stp' | 'bill' | 'auto',   // default: connection.config.defaultRail || 'auto'
 *     direction: 'debit' | 'credit',                    // credit = pay out, debit = collect
 *     amount, payeeName, payeeRouting, payeeAccount, payeeBankName,
 *     paymentType, priority, subLedgerId, sourceAccountCode,
 *     description, memo, vendorId, initiatedBy
 *   }
 *   → routes to electronicSettlementEngine.submitElectronicPayment (wire/ach/bill/auto)
 *     or stpEngine.processPayment (stp), and returns { ok, providerRef, response }.
 *
 * INBOUND (pull): read recent rail settlements/wires back into the aggregator's
 *   normalized transaction shape so both systems share a single view of debits
 *   and credits. These are NOT re-posted to the GL by DataBridge — the rail
 *   engines already post their own journal entries (DataBridge excludes the
 *   internal_rails connector from aggregator→accounting posting).
 *
 * All engine modules are required lazily so this connector never forces the
 * heavy payment engines to load unless a connection actually uses them.
 */

const RAILS = new Set(['wire', 'ach', 'stp', 'bill', 'auto']);

function pick(obj, keys, fallback) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return fallback;
}

function resolveRail(conn, payload) {
  const raw = pick(payload, ['rail', 'type', 'method'], null)
    || (conn.config && conn.config.defaultRail)
    || 'auto';
  const rail = String(raw).toLowerCase();
  if (!RAILS.has(rail)) {
    throw new Error(`Unsupported rail "${rail}". Use one of: ${Array.from(RAILS).join(', ')}`);
  }
  return rail;
}

// Normalize a payload into the option shape the settlement/STP engines expect.
function toEngineOpts(conn, payload, method) {
  const amount = Number(pick(payload, ['amount', 'amountDollars'], NaN));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('A positive amount is required');
  const payeeName = pick(payload, ['payeeName', 'payee_name', 'beneficiaryName'], null);
  if (!payeeName) throw new Error('payeeName is required');

  return {
    amount,
    payee_name: payeeName,
    payee_routing: pick(payload, ['payeeRouting', 'payee_routing', 'routing'], null),
    payee_account: pick(payload, ['payeeAccount', 'payee_account', 'account'], null),
    payee_bank_name: pick(payload, ['payeeBankName', 'payee_bank_name', 'bankName'], null),
    payment_type: pick(payload, ['paymentType', 'payment_type'], 'vendor_payment'),
    priority: pick(payload, ['priority'], 'standard'),
    force_method: method,                       // undefined for 'auto'
    method: method || 'ach',                    // STP engine uses opts.method
    sub_ledger_id: pick(payload, ['subLedgerId', 'sub_ledger_id'], null),
    source_account_code: pick(payload, ['sourceAccountCode', 'source_account_code'], undefined),
    vendor_id: pick(payload, ['vendorId', 'vendor_id'], null),
    description: pick(payload, ['description'], null)
      || `Aggregator ${pick(payload, ['direction'], 'credit')} via ${conn.name || conn.id}`,
    memo: pick(payload, ['memo'], null),
    initiated_by: pick(payload, ['initiatedBy', 'initiated_by'], 'aggregator'),
    direction: pick(payload, ['direction'], 'credit'),
  };
}

const internalRailsConnector = {
  type: 'internal_rails',

  /**
   * Initiate a debit/credit through the selected internal rail.
   */
  async push(conn, payload) {
    const rail = resolveRail(conn, payload || {});

    if (rail === 'stp') {
      const stpEngine = require('../../payments/stpEngine');
      const opts = toEngineOpts(conn, payload || {}, payload.method || 'ach');
      const result = await stpEngine.processPayment(opts);
      return {
        ok: true,
        providerRef: result.stp_id || result.settlement_id || null,
        rail: 'stp',
        response: result,
      };
    }

    const esEngine = require('../../payments/electronicSettlementEngine');
    // 'auto' lets the engine choose the optimal method; wire/ach/bill force it.
    const method = rail === 'auto' ? undefined : rail;
    const opts = toEngineOpts(conn, payload || {}, method);
    const result = await esEngine.submitElectronicPayment(opts);
    return {
      ok: true,
      providerRef: result.settlement_id || result.payment_ref || null,
      rail: result.method || rail,
      response: result,
    };
  },

  /**
   * Pull recent rail settlements as normalized aggregator transactions so the
   * hub reflects debits/credits moved through Wire/ACH/STP.
   */
  async pullTransactions(conn, opts) {
    const pool = require('../../bonds/pgPool');
    const limit = Math.min(parseInt((opts && opts.limit) || '100', 10) || 100, 500);
    let rows = [];
    try {
      const res = await pool.query(
        `SELECT settlement_id, payment_method, amount, status, payee_name,
                description, submitted_at, created_at
         FROM electronic_settlements
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );
      rows = res.rows;
    } catch (e) {
      // Table may not exist yet in a fresh environment — nothing to pull.
      return [];
    }

    return rows.map((r) => ({
      externalTxnId: r.settlement_id,
      externalAccountId: r.payment_method || 'rail',
      postedDate: r.submitted_at || r.created_at,
      // Outbound rail settlements move cash out of the trust → debit.
      amount: Math.abs(Number(r.amount) || 0),
      currency: 'USD',
      direction: 'debit',
      description: r.description || (`${r.payment_method || 'rail'} payment to ${r.payee_name || 'payee'}`),
      status: r.status || 'posted',
      raw: { source: 'internal_rails', ...r },
    })).filter((t) => t.externalTxnId != null);
  },
};

module.exports = { internalRailsConnector };
