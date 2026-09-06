'use strict';

/**
 * thirdweb settlement engine — closes the gap between the canonical ERP
 * records (dapp_distribution_requests, expense_records, bond_subscriptions)
 * and on-chain money movement through thirdweb:
 *
 *   settleDistribution(id)  approved distribution → stablecoin transfer from the
 *                           thirdweb server wallet to the request's destination
 *   settleExpense(id)       approved expense → transfer to the payee wallet
 *   handleWebhook(...)      verified thirdweb webhook events (engine.transaction.*,
 *                           pay.onchain-transaction, insight.*) finalize the
 *                           canonical record the transfer belongs to
 *   reconcile()             polls every open transfer (wire script / cron path
 *                           when webhooks are late or not configured)
 *
 * Nothing here bypasses the existing gates: every transfer goes through
 * ThirdwebServerWalletEngine.send (distribution policy, recipient allow-list,
 * THIRDWEB_SERVER_WALLET_LIVE shadow mode, audit table). Settlement is
 * idempotent per canonical record: a request/expense already carrying a
 * thirdweb transfer id is never sent twice.
 *
 * Webhook signature: HMAC-SHA256(secret, `${timestamp}.${rawBody}`), hex,
 * from `x-webhook-signature`/`x-webhook-timestamp` (thirdweb Webhooks) or
 * `x-payload-signature`/`x-timestamp` (Payments/Bridge). Secret comes from
 * THIRDWEB_WEBHOOK_SECRET; without it the endpoint refuses every delivery.
 */

const crypto = require('crypto');
const { ThirdwebServerWalletEngine } = require('./thirdwebServerWalletEngine');
const { ThirdwebPriceOracle } = require('./thirdwebPriceOracle');

let pool = null;
try { pool = require('../bonds/pgPool'); } catch (e) { /* no DB in tests */ }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

let BondSubscriptionEngine = null;
try { ({ BondSubscriptionEngine } = require('../bonds/bondSubscriptionEngine')); } catch (e) { /* optional */ }
let MessagingEngine = null;
try { ({ MessagingEngine } = require('../messaging/messagingEngine')); } catch (e) { /* optional */ }

const OPEN_TRANSFER_STATUSES = new Set(['submitted', 'queued']);
const DEFAULT_MAX_AGE_SECONDS = 10 * 60;

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function lower(v) { return String(v || '').toLowerCase(); }
function isAddress(v) { return /^0x[0-9a-fA-F]{40}$/.test(String(v || '')); }

let tablesReady = null;
async function ensureTables() {
  if (!pool || !pool.query) return;
  if (tablesReady) return tablesReady;
  tablesReady = pool.query(`
    CREATE TABLE IF NOT EXISTS thirdweb_webhook_events (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      object TEXT,
      triggered_at TIMESTAMPTZ,
      payload JSONB NOT NULL,
      outcome JSONB,
      error TEXT,
      received_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch((e) => { tablesReady = null; throw e; });
  return tablesReady;
}

const memoryEvents = [];

async function query(sql, params) {
  if (!pool || !pool.query) return { rows: [] };
  return pool.query(sql, params);
}

class ThirdwebSettlementEngine {
  static getConfig() {
    const wallet = ThirdwebServerWalletEngine.getConfig();
    return {
      webhookSecret: str('THIRDWEB_WEBHOOK_SECRET'),
      webhookMaxAgeSeconds: Number(str('THIRDWEB_WEBHOOK_MAX_AGE_SECONDS', String(DEFAULT_MAX_AGE_SECONDS))) || DEFAULT_MAX_AGE_SECONDS,
      settlementToken: str('THIRDWEB_SETTLEMENT_TOKEN') || str('BOND_SUBSCRIPTION_SETTLEMENT_TOKEN') || str('DAPP_USDC_ADDRESS') || null,
      chainId: Number(str('THIRDWEB_SETTLEMENT_CHAIN_ID')) || wallet.chainId,
      wallet,
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const wallet = ThirdwebServerWalletEngine.readiness();
    const issues = [...wallet.issues];
    if (!cfg.webhookSecret) issues.push('THIRDWEB_WEBHOOK_SECRET not configured (webhook deliveries are rejected)');
    if (!cfg.settlementToken) issues.push('THIRDWEB_SETTLEMENT_TOKEN (or DAPP_USDC_ADDRESS) not configured');
    else if (!isAddress(cfg.settlementToken)) issues.push('THIRDWEB_SETTLEMENT_TOKEN is not a valid address');
    return {
      provider: 'thirdweb-settlement',
      chainId: cfg.chainId,
      settlementToken: cfg.settlementToken,
      webhookConfigured: Boolean(cfg.webhookSecret),
      webhookPath: '/api/dapp/thirdweb/webhooks',
      topics: ['engine.transaction.sent', 'engine.transaction.confirmed', 'engine.transaction.failed', 'pay.onchain-transaction', 'insight.event'],
      serverWallet: wallet,
      live: wallet.live,
      shadow: wallet.shadow,
      ready: issues.length === 0,
      issues,
    };
  }

  // ─── settlement queue ────────────────────────────────────────────────────

  static async queue({ limit = 50 } = {}) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const [distributions, expenses, transfers] = await Promise.all([
      query(`SELECT id, type, beneficiary_name, beneficiary_email, amount_cents, destination_address, memo, status, metadata, updated_at
               FROM dapp_distribution_requests
              WHERE status = 'approved' OR (status = 'payout_created' AND metadata ? 'thirdwebTransferId')
              ORDER BY updated_at DESC LIMIT $1`, [n]).then((r) => r.rows).catch(() => []),
      query(`SELECT id, expense_type, payee, amount_cents, description, status, metadata, updated_at
               FROM expense_records
              WHERE status = 'approved' OR (status = 'payment_pending' AND metadata ? 'thirdwebTransferId')
              ORDER BY updated_at DESC LIMIT $1`, [n]).then((r) => r.rows).catch(() => []),
      ThirdwebServerWalletEngine.recentTransfers(n).catch(() => []),
    ]);
    const open = transfers.filter((t) => OPEN_TRANSFER_STATUSES.has(lower(t.status)));
    return {
      asOf: new Date().toISOString(),
      readiness: this.readiness(),
      distributions: distributions.map((d) => ({
        id: d.id,
        type: d.type,
        beneficiary: d.beneficiary_name || d.beneficiary_email,
        amountUsd: Number(d.amount_cents) / 100,
        destination: d.destination_address,
        memo: d.memo,
        status: d.status,
        thirdwebTransferId: d.metadata?.thirdwebTransferId || null,
        canSettle: d.status === 'approved' && isAddress(d.destination_address),
        updatedAt: d.updated_at,
      })),
      expenses: expenses.map((e) => ({
        id: e.id,
        expenseType: e.expense_type,
        payee: e.payee,
        amountUsd: Number(e.amount_cents) / 100,
        description: e.description,
        status: e.status,
        destination: this._expenseDestination(e),
        thirdwebTransferId: e.metadata?.thirdwebTransferId || null,
        canSettle: e.status === 'approved' && isAddress(this._expenseDestination(e)),
        updatedAt: e.updated_at,
      })),
      openTransfers: open,
      counts: {
        distributionsAwaiting: distributions.filter((d) => d.status === 'approved').length,
        expensesAwaiting: expenses.filter((e) => e.status === 'approved').length,
        openTransfers: open.length,
      },
    };
  }

  static _expenseDestination(row) {
    const m = row.metadata || {};
    const candidate = m.walletAddress || m.payeeAddress || m.destinationAddress || row.payee;
    return isAddress(candidate) ? candidate : null;
  }

  // ─── outbound settlement ─────────────────────────────────────────────────

  static async _transfer({ to, amountUsd, reference, memo, purpose, requesterRole }) {
    const cfg = this.getConfig();
    if (!cfg.settlementToken) throw new Error('THIRDWEB_SETTLEMENT_TOKEN not configured');
    const quote = await ThirdwebPriceOracle.quantityForUsd({ chainId: cfg.chainId, tokenAddress: cfg.settlementToken, amountUsd });
    const transfer = await ThirdwebServerWalletEngine.send({
      to,
      quantity: quote.quantity,
      tokenAddress: cfg.settlementToken,
      chainId: cfg.chainId,
      reference,
      memo,
      amountUsd,
      requesterRole,
      purpose,
    });
    return { transfer, quote };
  }

  static async settleDistribution(requestId, { requesterRole = 'trustee' } = {}) {
    const { rows } = await query('SELECT * FROM dapp_distribution_requests WHERE id = $1', [requestId]);
    const request = rows[0];
    if (!request) throw Object.assign(new Error(`distribution request ${requestId} not found`), { status: 404 });
    if (request.metadata?.thirdwebTransferId) {
      return { request, transfer: await this._transferById(request.metadata.thirdwebTransferId), alreadySettled: true };
    }
    if (request.status !== 'approved') throw Object.assign(new Error(`request is ${request.status}; only approved requests settle`), { status: 409 });
    if (!isAddress(request.destination_address)) throw Object.assign(new Error('destination_address is not an EVM address'), { status: 422 });

    const amountUsd = Number(request.amount_cents) / 100;
    const { transfer, quote } = await this._transfer({
      to: request.destination_address,
      amountUsd,
      reference: request.id,
      memo: request.memo || `${request.type} ${request.id}`,
      purpose: request.metadata?.purpose,
      requesterRole,
    });
    const status = transfer.status === 'failed' ? 'failed' : 'payout_created';
    await query(
      `UPDATE dapp_distribution_requests
          SET status = $2, tx_hash = COALESCE($3, tx_hash),
              metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb, updated_at = NOW()
        WHERE id = $1`,
      [request.id, status, transfer.transactionHash, JSON.stringify({
        thirdwebTransferId: transfer.id,
        thirdwebTransactionId: transfer.transactionId,
        settlementRail: 'thirdweb-server-wallet',
        settlementShadow: transfer.shadow,
        settlementQuote: { token: quote.tokenAddress || null, quantity: quote.quantity, priceUsd: quote.priceUsd },
      })]
    );
    if (request.metadata?.expenseId) await this._markExpense(request.metadata.expenseId, transfer, 'payment_pending');
    if (transfer.shadow) await this._finalizeDistribution(request.id, transfer, 'shadow');
    return { request: (await query('SELECT * FROM dapp_distribution_requests WHERE id = $1', [request.id])).rows[0], transfer };
  }

  static async settleExpense(expenseId, { requesterRole = 'trustee' } = {}) {
    const { rows } = await query('SELECT * FROM expense_records WHERE id = $1', [expenseId]);
    const expense = rows[0];
    if (!expense) throw Object.assign(new Error(`expense ${expenseId} not found`), { status: 404 });
    if (expense.metadata?.thirdwebTransferId) {
      return { expense, transfer: await this._transferById(expense.metadata.thirdwebTransferId), alreadySettled: true };
    }
    if (expense.status !== 'approved') throw Object.assign(new Error(`expense is ${expense.status}; only approved expenses settle`), { status: 409 });
    const to = this._expenseDestination(expense);
    if (!to) throw Object.assign(new Error('expense has no payee wallet (metadata.walletAddress)'), { status: 422 });

    const amountUsd = Number(expense.amount_cents) / 100;
    const { transfer } = await this._transfer({
      to,
      amountUsd,
      reference: expense.id,
      memo: expense.description || `expense ${expense.id}`,
      purpose: expense.metadata?.purpose || expense.expense_type,
      requesterRole,
    });
    await this._markExpense(expense.id, transfer, transfer.status === 'failed' ? 'payment_failed' : (transfer.shadow ? 'paid' : 'payment_pending'));
    return { expense: (await query('SELECT * FROM expense_records WHERE id = $1', [expense.id])).rows[0], transfer };
  }

  static async _markExpense(expenseId, transfer, status) {
    await query(
      `UPDATE expense_records
          SET status = $2, metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb, updated_at = NOW()
        WHERE id = $1`,
      [expenseId, status, JSON.stringify({
        thirdwebTransferId: transfer.id,
        thirdwebTransactionId: transfer.transactionId || null,
        thirdwebTransactionHash: transfer.transactionHash || null,
        settlementRail: 'thirdweb-server-wallet',
        settlementShadow: Boolean(transfer.shadow),
        settlementStatus: transfer.status,
      })]
    ).catch((e) => console.warn('[ThirdwebSettlement] expense update failed:', e.message));
  }

  static async _finalizeDistribution(requestId, transfer, outcome) {
    const status = outcome === 'failed' ? 'failed' : 'executed';
    await query(
      `UPDATE dapp_distribution_requests
          SET status = $2, tx_hash = COALESCE($3, tx_hash),
              metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb, updated_at = NOW()
        WHERE id = $1`,
      [requestId, status, transfer.transactionHash || null, JSON.stringify({ settlementStatus: outcome, settledAt: new Date().toISOString(), settlementError: transfer.error || null })]
    );
    const { rows } = await query('SELECT metadata, amount_cents, destination_address FROM dapp_distribution_requests WHERE id = $1', [requestId]);
    const row = rows[0];
    if (row?.metadata?.expenseId) await this._markExpense(row.metadata.expenseId, transfer, status === 'executed' ? 'paid' : 'payment_failed');
    if (MessagingEngine && row) {
      MessagingEngine.notify({
        subject: `Distribution ${requestId} ${status} via thirdweb`,
        body: `$${(Number(row.amount_cents) / 100).toFixed(2)} → ${row.destination_address}. Tx: ${transfer.transactionHash || transfer.id}.`,
        referenceType: 'distribution_request',
        referenceId: requestId,
        sender: 'thirdweb Settlement Engine',
      }).catch(() => undefined);
    }
  }

  static async _transferById(id) {
    const list = await ThirdwebServerWalletEngine.recentTransfers(200).catch(() => []);
    return list.find((t) => t.id === id) || null;
  }

  /** Apply a terminal thirdweb transaction state to whichever canonical record referenced it. */
  static async _applyTransaction(tx) {
    if (!tx || !tx.id) return { applied: false };
    await ThirdwebServerWalletEngine._update(tx.id, tx).catch(() => undefined);
    const { rows } = await query('SELECT id, reference, transaction_hash, error FROM thirdweb_server_wallet_transfers WHERE thirdweb_transaction_id = $1', [tx.id]);
    const transfer = rows[0];
    if (!transfer) return { applied: false, reason: 'no transfer for this transactionId' };
    const record = { id: transfer.id, transactionHash: tx.transactionHash || transfer.transaction_hash, transactionId: tx.id, error: tx.errorMessage || null, status: lower(tx.status) };
    const outcome = tx.status === 'CONFIRMED' ? 'confirmed' : tx.status === 'FAILED' ? 'failed' : null;
    if (!outcome) return { applied: false, reason: `status ${tx.status} not terminal`, transferId: transfer.id };

    const dist = await query('SELECT id FROM dapp_distribution_requests WHERE metadata->>\'thirdwebTransferId\' = $1', [transfer.id]);
    for (const row of dist.rows) await this._finalizeDistribution(row.id, record, outcome);
    const exp = await query('SELECT id FROM expense_records WHERE metadata->>\'thirdwebTransferId\' = $1 AND status <> \'paid\'', [transfer.id]);
    for (const row of exp.rows) await this._markExpense(row.id, record, outcome === 'confirmed' ? 'paid' : 'payment_failed');
    return { applied: true, transferId: transfer.id, outcome, distributions: dist.rows.map((r) => r.id), expenses: exp.rows.map((r) => r.id) };
  }

  /** Poll every open server-wallet transfer; the wire-script / cron path. */
  static async reconcile({ limit = 100 } = {}) {
    const transfers = await ThirdwebServerWalletEngine.recentTransfers(limit).catch(() => []);
    const open = transfers.filter((t) => OPEN_TRANSFER_STATUSES.has(lower(t.status)) && t.transactionId);
    const results = [];
    for (const t of open) {
      try {
        const tx = await ThirdwebServerWalletEngine.getTransaction(t.transactionId);
        results.push({ transferId: t.id, transactionId: t.transactionId, status: tx.status, ...(await this._applyTransaction(tx)) });
      } catch (e) {
        results.push({ transferId: t.id, transactionId: t.transactionId, error: e.message });
      }
    }
    let subscriptions = [];
    if (BondSubscriptionEngine && BondSubscriptionEngine.syncOpen) {
      try { subscriptions = await BondSubscriptionEngine.syncOpen(); } catch (e) { subscriptions = [{ error: e.message }]; }
    }
    return { asOf: new Date().toISOString(), checked: open.length, results, subscriptions };
  }

  // ─── webhooks ────────────────────────────────────────────────────────────

  static verifySignature({ rawBody, headers }) {
    const cfg = this.getConfig();
    if (!cfg.webhookSecret) throw Object.assign(new Error('THIRDWEB_WEBHOOK_SECRET not configured'), { status: 503 });
    const h = (name) => headers[name] || headers[name.toLowerCase()];
    const signature = h('x-webhook-signature') || h('x-payload-signature') || h('x-pay-signature');
    const timestamp = h('x-webhook-timestamp') || h('x-timestamp') || h('x-pay-timestamp');
    if (!signature || !timestamp) throw Object.assign(new Error('missing webhook signature headers'), { status: 401 });
    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
    if (!Number.isFinite(age) || age > cfg.webhookMaxAgeSeconds) throw Object.assign(new Error('webhook timestamp outside tolerance'), { status: 401 });
    const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
    const expected = crypto.createHmac('sha256', cfg.webhookSecret).update(`${timestamp}.${body}`).digest();
    let actual;
    try { actual = Buffer.from(String(signature).replace(/^0x/, ''), 'hex'); } catch (e) { actual = Buffer.alloc(0); }
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      throw Object.assign(new Error('invalid webhook signature'), { status: 401 });
    }
    return true;
  }

  static async handleWebhook({ rawBody, headers }) {
    this.verifySignature({ rawBody, headers });
    const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
    const event = JSON.parse(body);
    const topic = event.type || event.topic || 'unknown';
    const data = event.data || {};
    const id = event.id || (topic.startsWith('pay.') && data.paymentId ? `pay:${data.paymentId}:${data.status}` : null)
      || crypto.createHash('sha256').update(body).digest('hex');

    await ensureTables();
    const existing = await query('SELECT id, outcome FROM thirdweb_webhook_events WHERE id = $1', [id]);
    if (existing.rows[0]) return { id, topic, duplicate: true, outcome: existing.rows[0].outcome };
    if (memoryEvents.some((e) => e.id === id)) return { id, topic, duplicate: true };

    let outcome; let error = null;
    try {
      outcome = await this._dispatch(topic, data, event);
    } catch (e) {
      error = e.message;
      outcome = { handled: false };
    }
    const row = { id, topic, object: event.object || null, triggeredAt: event.triggered_at ? new Date(Number(event.triggered_at) * 1000) : null, payload: event, outcome, error };
    memoryEvents.push(row);
    if (memoryEvents.length > 500) memoryEvents.splice(0, memoryEvents.length - 500);
    await query(
      `INSERT INTO thirdweb_webhook_events (id, topic, object, triggered_at, payload, outcome, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
      [id, topic, row.object, row.triggeredAt, JSON.stringify(event), JSON.stringify(outcome), error]
    ).catch((e) => console.warn('[ThirdwebSettlement] webhook persist failed:', e.message));
    return { id, topic, duplicate: false, outcome, error };
  }

  static async _dispatch(topic, data) {
    if (topic.startsWith('engine.transaction')) {
      const tx = {
        id: data.id || data.transactionId,
        status: String(data.status || (topic.endsWith('confirmed') ? 'CONFIRMED' : topic.endsWith('failed') ? 'FAILED' : 'SUBMITTED')).toUpperCase(),
        transactionHash: data.transactionHash || null,
        errorMessage: data.errorMessage || null,
      };
      return { handled: true, ...(await this._applyTransaction(tx)) };
    }
    if (topic.startsWith('pay.')) {
      if (!BondSubscriptionEngine) return { handled: false, reason: 'bond subscriptions unavailable' };
      const { rows } = await query('SELECT id FROM bond_subscriptions WHERE payment_id = $1', [data.paymentId]);
      const synced = [];
      for (const r of rows) synced.push(await BondSubscriptionEngine.sync(r.id).catch((e) => ({ id: r.id, error: e.message })));
      return { handled: true, paymentId: data.paymentId, status: data.status, subscriptions: synced };
    }
    if (topic.startsWith('insight.')) {
      const cfg = this.getConfig();
      const to = lower(data.decoded?.indexedParams?.to || data.to || data.decoded?.to);
      const treasury = lower(cfg.wallet.address);
      const inbound = treasury && to === treasury;
      if (inbound && MessagingEngine) {
        MessagingEngine.notify({
          subject: 'Inbound on-chain receipt to treasury wallet',
          body: `Tx ${data.transaction_hash || data.transactionHash || ''} on chain ${data.chain_id || data.chainId || ''}.`,
          referenceType: 'thirdweb_insight',
          referenceId: data.transaction_hash || data.transactionHash || null,
          sender: 'thirdweb Settlement Engine',
        }).catch(() => undefined);
      }
      return { handled: true, inboundToTreasury: inbound };
    }
    return { handled: false, reason: `unhandled topic ${topic}` };
  }

  static async recentEvents(limit = 50) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    if (!pool || !pool.query) return memoryEvents.slice(-n).reverse();
    await ensureTables();
    const { rows } = await query('SELECT id, topic, object, triggered_at, outcome, error, received_at FROM thirdweb_webhook_events ORDER BY received_at DESC LIMIT $1', [n]);
    return rows;
  }
}

module.exports = { ThirdwebSettlementEngine };
