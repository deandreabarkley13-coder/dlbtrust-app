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
const { TrustPolicyEngine } = require('./trustPolicyEngine');

let pool = null;
try { pool = require('../bonds/pgPool'); } catch (e) { /* no DB in tests */ }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

let BondSubscriptionEngine = null;
try { ({ BondSubscriptionEngine } = require('../bonds/bondSubscriptionEngine')); } catch (e) { /* optional */ }
let ThirdwebTreasuryFundingEngine = null;
try { ({ ThirdwebTreasuryFundingEngine } = require('./thirdwebTreasuryFundingEngine')); } catch (e) { /* optional */ }
let MessagingEngine = null;
try { ({ MessagingEngine } = require('../messaging/messagingEngine')); } catch (e) { /* optional */ }

const DEFAULT_MAX_AGE_SECONDS = 10 * 60;
const STUCK_CLAIM_MS = 15 * 60 * 1000;

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function lower(v) { return String(v || '').toLowerCase(); }
function isAddress(v) { return /^0x[0-9a-fA-F]{40}$/.test(String(v || '')); }
function isUsd(currency) { return !currency || String(currency).toUpperCase() === 'USD'; }

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
    if (!cfg.webhookSecret) issues.push('THIRDWEB_WEBHOOK_SECRET not configured (webhook deliveries are acknowledged but ignored)');
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
      policy: TrustPolicyEngine.readiness(),
      live: wallet.live,
      shadow: wallet.shadow,
      ready: issues.length === 0,
      issues,
    };
  }

  // ─── settlement queue ────────────────────────────────────────────────────

  static async queue({ limit = 50, offset = 0 } = {}) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const off = Math.max(Number(offset) || 0, 0);
    const WALLET_DEST = `COALESCE(destination_type, 'wallet') = 'wallet'`;
    const DIST_WHERE = `${WALLET_DEST} AND (status IN ('approved', 'settling') OR (status = 'payout_created' AND metadata ? 'thirdwebTransferId'))`;
    const EXP_WHERE = `status IN ('approved', 'settling') OR (status = 'payment_pending' AND metadata ? 'thirdwebTransferId')`;
    const count = (sql) => query(sql).then((r) => Number(r.rows[0]?.n ?? 0)).catch(() => 0);
    const [distributions, expenses, open, distributionsAwaiting, expensesAwaiting, openTransfers] = await Promise.all([
      query(`SELECT id, type, beneficiary_name, beneficiary_email, amount_cents, currency, destination_address, memo, status, metadata, updated_at
               FROM dapp_distribution_requests WHERE ${DIST_WHERE}
              ORDER BY updated_at ASC, id ASC LIMIT $1 OFFSET $2`, [n, off]).then((r) => r.rows).catch(() => []),
      query(`SELECT id, expense_type, payee, amount_cents, currency, description, status, metadata, updated_at
               FROM expense_records WHERE ${EXP_WHERE}
              ORDER BY updated_at ASC, id ASC LIMIT $1 OFFSET $2`, [n, off]).then((r) => r.rows).catch(() => []),
      ThirdwebServerWalletEngine.openTransfers({ limit: n, offset: off }).catch(() => []),
      count(`SELECT COUNT(*)::int AS n FROM dapp_distribution_requests WHERE ${WALLET_DEST} AND status = 'approved'`),
      count(`SELECT COUNT(*)::int AS n FROM expense_records WHERE status = 'approved'`),
      count(`SELECT COUNT(*)::int AS n FROM thirdweb_server_wallet_transfers WHERE status IN ('queued', 'submitted')`),
    ]);
    return {
      asOf: new Date().toISOString(),
      readiness: this.readiness(),
      page: { limit: n, offset: off },
      distributions: distributions.map((d) => ({
        id: d.id,
        type: d.type,
        beneficiary: d.beneficiary_name || d.beneficiary_email,
        amountUsd: Number(d.amount_cents) / 100,
        currency: d.currency || 'USD',
        destination: d.destination_address,
        memo: d.memo,
        status: d.status,
        thirdwebTransferId: d.metadata?.thirdwebTransferId || null,
        canSettle: d.status === 'approved' && isAddress(d.destination_address) && isUsd(d.currency),
        blockedReason: this._eligibility(d.status, d.destination_address, d.currency),
        updatedAt: d.updated_at,
      })),
      expenses: expenses.map((e) => ({
        id: e.id,
        expenseType: e.expense_type,
        payee: e.payee,
        amountUsd: Number(e.amount_cents) / 100,
        currency: e.currency || 'USD',
        description: e.description,
        status: e.status,
        destination: this._expenseDestination(e),
        thirdwebTransferId: e.metadata?.thirdwebTransferId || null,
        canSettle: e.status === 'approved' && isAddress(this._expenseDestination(e)) && isUsd(e.currency),
        blockedReason: this._eligibility(e.status, this._expenseDestination(e), e.currency),
        updatedAt: e.updated_at,
      })),
      openTransfers: open,
      counts: { distributionsAwaiting, expensesAwaiting, openTransfers },
    };
  }

  static _eligibility(status, destination, currency) {
    if (status !== 'approved') return null;
    if (!isAddress(destination)) return 'no EVM destination address';
    if (!isUsd(currency)) return `currency ${currency} is not USD`;
    return null;
  }

  /**
   * Atomically move an approved payable to `settling` so exactly one caller may
   * broadcast. Returns false when another caller already claimed or settled it.
   */
  static async _claim(table, id) {
    if (!pool || !pool.query) return true;
    const res = await query(
      `UPDATE ${table}
          SET status = 'settling', metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = NOW()
        WHERE id = $1 AND status = 'approved' AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'thirdwebTransferId')`,
      [id, JSON.stringify({ settlementClaimedAt: new Date().toISOString() })]
    );
    return Number(res.rowCount) === 1;
  }

  static async _release(table, id) {
    await query(`UPDATE ${table} SET status = 'approved', updated_at = NOW() WHERE id = $1 AND status = 'settling'`, [id])
      .catch((e) => console.error(`[ThirdwebSettlement] could not release ${table} ${id}:`, e.message));
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
    if (!isUsd(request.currency)) throw Object.assign(new Error(`request currency ${request.currency} is not USD; thirdweb settlement only pays USD-denominated records`), { status: 422 });
    if (!(await this._claim('dapp_distribution_requests', request.id))) {
      throw Object.assign(new Error('request is already being settled by another operator'), { status: 409 });
    }

    const amountUsd = Number(request.amount_cents) / 100;
    let transfer; let quote;
    try {
      ({ transfer, quote } = await this._transfer({
        to: request.destination_address,
        amountUsd,
        reference: request.id,
        memo: request.memo || `${request.type} ${request.id}`,
        purpose: request.metadata?.purpose,
        requesterRole,
      }));
    } catch (e) {
      await this._release('dapp_distribution_requests', request.id);
      throw e;
    }
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

  // ─── on-chain policy route ───────────────────────────────────────────────

  /**
   * Raise the distribution as a proposal on TrustDistributionPolicy instead of
   * transferring straight out of the server wallet. Value stays in the
   * contract until the checker threshold, the timelock and the ceilings are
   * satisfied on chain, so the canonical record stays `approved` and only
   * `syncPolicyDistribution` moves it on.
   */
  static async proposeViaPolicy(requestId, { requesterRole = 'trustee', purpose, installments, intervalSeconds, expiresAt } = {}) {
    const cfg = this.getConfig();
    const { rows } = await query('SELECT * FROM dapp_distribution_requests WHERE id = $1', [requestId]);
    const request = rows[0];
    if (!request) throw Object.assign(new Error(`distribution request ${requestId} not found`), { status: 404 });
    if (request.metadata?.thirdwebTransferId) {
      throw Object.assign(new Error('request already settled by a direct transfer'), { status: 409 });
    }
    if (request.metadata?.policyDistributionRef) {
      return { request, proposal: null, alreadyProposed: true, onChain: await TrustPolicyEngine.findByReference(request.id).catch(() => null) };
    }
    if (request.status !== 'approved') throw Object.assign(new Error(`request is ${request.status}; only approved requests are proposed on chain`), { status: 409 });
    if (!isAddress(request.destination_address)) throw Object.assign(new Error('destination_address is not an EVM address'), { status: 422 });
    if (!isUsd(request.currency)) throw Object.assign(new Error(`request currency ${request.currency} is not USD`), { status: 422 });

    const amountUsd = Number(request.amount_cents) / 100;
    const quote = await ThirdwebPriceOracle.quantityForUsd({ chainId: cfg.chainId, tokenAddress: cfg.settlementToken, amountUsd });
    const proposal = await TrustPolicyEngine.propose({
      beneficiary: request.destination_address,
      quantity: quote.quantity,
      tokenAddress: cfg.settlementToken,
      purpose: purpose || request.metadata?.purpose,
      reference: request.id,
      installments,
      intervalSeconds,
      expiresAt,
    });
    await query(
      `UPDATE dapp_distribution_requests
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = NOW()
        WHERE id = $1`,
      [request.id, JSON.stringify({
        settlementRail: 'trust-distribution-policy',
        policyContract: proposal.contract,
        policyChainId: proposal.chainId,
        policyDistributionRef: proposal.ref,
        policyProposedAt: new Date().toISOString(),
        policyProposedBy: requesterRole,
        policyShadow: Boolean(proposal.shadow),
        policyTransactionId: proposal.transactionId,
        policyQuote: { token: quote.tokenAddress || cfg.settlementToken, quantity: quote.quantity, priceUsd: quote.priceUsd },
      })]
    );
    return {
      request: (await query('SELECT * FROM dapp_distribution_requests WHERE id = $1', [request.id])).rows[0],
      proposal,
      quote,
    };
  }

  /**
   * Reconcile a proposed request against the contract: reports the on-chain
   * status and escrow, and closes the record once the beneficiary has actually
   * claimed the whole escrow (or the proposal was cancelled/revoked).
   */
  static async syncPolicyDistribution(requestId) {
    const { rows } = await query('SELECT * FROM dapp_distribution_requests WHERE id = $1', [requestId]);
    const request = rows[0];
    if (!request) throw Object.assign(new Error(`distribution request ${requestId} not found`), { status: 404 });
    if (!request.metadata?.policyDistributionRef) throw Object.assign(new Error('request was not proposed on chain'), { status: 409 });

    const onChain = await TrustPolicyEngine.findByReference(request.id);
    if (!onChain) return { request, onChain: null, escrow: null, changed: false, reason: 'no matching proposal on chain yet' };
    const escrow = onChain.escrowId ? await TrustPolicyEngine.escrow(onChain.escrowId) : null;

    const patch = {
      policyDistributionId: onChain.distributionId,
      policyStatus: onChain.status,
      policyApprovals: onChain.approvals,
      policyReleasableAt: onChain.releasableAt,
      policyEscrowId: onChain.escrowId,
      policyClaimed: escrow?.claimed || null,
      policySyncedAt: new Date().toISOString(),
    };
    let changed = false;
    const fullyClaimed = escrow && !escrow.revoked && BigInt(escrow.claimed || '0') >= BigInt(escrow.quantity || '0');
    if (fullyClaimed && request.status !== 'executed') {
      await this._finalizeDistribution(request.id, { id: `TDP-${onChain.distributionId}`, transactionHash: null, transactionId: request.metadata.policyTransactionId || null }, 'confirmed');
      changed = true;
    } else if (onChain.status === 'cancelled' && request.status === 'approved') {
      patch.policyCancelled = true;
      changed = true;
    }
    await query(
      `UPDATE dapp_distribution_requests SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [request.id, JSON.stringify(patch)]
    );
    return {
      request: (await query('SELECT * FROM dapp_distribution_requests WHERE id = $1', [request.id])).rows[0],
      onChain,
      escrow,
      changed,
    };
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
    if (!isUsd(expense.currency)) throw Object.assign(new Error(`expense currency ${expense.currency} is not USD; thirdweb settlement only pays USD-denominated records`), { status: 422 });
    if (!(await this._claim('expense_records', expense.id))) {
      throw Object.assign(new Error('expense is already being settled by another operator'), { status: 409 });
    }

    const amountUsd = Number(expense.amount_cents) / 100;
    let transfer;
    try {
      ({ transfer } = await this._transfer({
        to,
        amountUsd,
        reference: expense.id,
        memo: expense.description || `expense ${expense.id}`,
        purpose: expense.metadata?.purpose || expense.expense_type,
        requesterRole,
      }));
    } catch (e) {
      await this._release('expense_records', expense.id);
      throw e;
    }
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
    );
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
    return ThirdwebServerWalletEngine.transferById(id).catch(() => null);
  }

  /**
   * Repair payables stuck in `settling`: a transfer was broadcast (persisted in
   * thirdweb_server_wallet_transfers under reference = record id) but the
   * canonical update after broadcast failed. Re-attach instead of re-paying.
   */
  static async _repairStuck() {
    const repaired = [];
    for (const [table, pendingStatus] of [['dapp_distribution_requests', 'payout_created'], ['expense_records', 'payment_pending']]) {
      const { rows } = await query(
        `SELECT r.id, r.metadata, t.id AS transfer_id, t.thirdweb_transaction_id, t.transaction_hash, t.status AS transfer_status, t.shadow
           FROM ${table} r LEFT JOIN thirdweb_server_wallet_transfers t ON t.reference = r.id
          WHERE r.status = 'settling' AND NOT (COALESCE(r.metadata, '{}'::jsonb) ? 'thirdwebTransferId')
          ORDER BY r.updated_at ASC LIMIT 200`
      ).catch(() => ({ rows: [] }));
      for (const row of rows) {
        if (!row.transfer_id) {
          const ageMs = Date.now() - new Date(row.metadata?.settlementClaimedAt || 0).getTime();
          if (ageMs > STUCK_CLAIM_MS) { await this._release(table, row.id); repaired.push({ table, id: row.id, action: 'released' }); }
          continue;
        }
        const transfer = { id: row.transfer_id, transactionId: row.thirdweb_transaction_id, transactionHash: row.transaction_hash, status: row.transfer_status, shadow: row.shadow };
        if (table === 'expense_records') await this._markExpense(row.id, transfer, pendingStatus);
        else {
          await query(
            `UPDATE ${table} SET status = $2, metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb, updated_at = NOW() WHERE id = $1`,
            [row.id, pendingStatus, JSON.stringify({ thirdwebTransferId: transfer.id, thirdwebTransactionId: transfer.transactionId, settlementRail: 'thirdweb-server-wallet', settlementShadow: Boolean(transfer.shadow), settlementRepaired: true })]
          );
        }
        repaired.push({ table, id: row.id, action: 'reattached', transferId: transfer.id });
      }
    }
    return repaired;
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
  static async reconcile({ pageSize = 200, maxTransfers = 5000 } = {}) {
    const repaired = await this._repairStuck();
    const results = [];
    let checked = 0;
    for (let offset = 0; offset < maxTransfers; offset += pageSize) {
      const page = await ThirdwebServerWalletEngine.openTransfers({ limit: pageSize, offset }).catch(() => []);
      if (!page.length) break;
      for (const t of page) {
        if (!t.transactionId) continue;
        checked += 1;
        try {
          const tx = await ThirdwebServerWalletEngine.getTransaction(t.transactionId);
          results.push({ transferId: t.id, transactionId: t.transactionId, status: tx.status, ...(await this._applyTransaction(tx)) });
        } catch (e) {
          results.push({ transferId: t.id, transactionId: t.transactionId, error: e.message });
        }
      }
      if (page.length < pageSize) break;
    }
    let subscriptions = [];
    if (BondSubscriptionEngine && BondSubscriptionEngine.syncOpen) {
      try { subscriptions = await BondSubscriptionEngine.syncOpen(); } catch (e) { subscriptions = [{ error: e.message }]; }
    }
    let topUps = [];
    if (ThirdwebTreasuryFundingEngine && ThirdwebTreasuryFundingEngine.syncOpen) {
      try { topUps = await ThirdwebTreasuryFundingEngine.syncOpen(); } catch (e) { topUps = [{ error: e.message }]; }
    }
    return { asOf: new Date().toISOString(), checked, repaired, results, subscriptions, topUps };
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
    // thirdweb only creates a webhook after its URL answers 200, and the secret
    // only exists after creation. Until the secret is configured we acknowledge
    // deliveries without reading or acting on them; nothing is persisted.
    if (!this.getConfig().webhookSecret) {
      console.warn('[ThirdwebSettlement] webhook delivery ignored: THIRDWEB_WEBHOOK_SECRET not configured');
      return { id: null, topic: null, duplicate: false, ignored: true, reason: 'THIRDWEB_WEBHOOK_SECRET not configured' };
    }
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

    // Dispatch first; only a successful dispatch is recorded as delivered. A
    // failure is re-thrown as 5xx so thirdweb redelivers, and the redelivery is
    // not treated as a duplicate.
    let outcome;
    try {
      outcome = await this._dispatch(topic, data, event);
    } catch (e) {
      console.error(`[ThirdwebSettlement] webhook ${id} (${topic}) dispatch failed:`, e.message);
      throw Object.assign(new Error('webhook processing failed; retry'), { status: 500, expose: true });
    }
    const row = { id, topic, object: event.object || null, triggeredAt: event.triggered_at ? new Date(Number(event.triggered_at) * 1000) : null, payload: event, outcome, error: null };
    memoryEvents.push(row);
    if (memoryEvents.length > 500) memoryEvents.splice(0, memoryEvents.length - 500);
    await query(
      `INSERT INTO thirdweb_webhook_events (id, topic, object, triggered_at, payload, outcome, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
      [id, topic, row.object, row.triggeredAt, JSON.stringify(event), JSON.stringify(outcome), null]
    );
    return { id, topic, duplicate: false, outcome };
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
      const synced = [];
      if (BondSubscriptionEngine) {
        const { rows } = await query('SELECT id FROM bond_subscriptions WHERE payment_id = $1', [data.paymentId]);
        for (const r of rows) synced.push(await BondSubscriptionEngine.sync(r.id).catch((e) => ({ id: r.id, error: e.message })));
      }
      const topUps = [];
      if (ThirdwebTreasuryFundingEngine) {
        const rows = await ThirdwebTreasuryFundingEngine.topUpsByPaymentId(data.paymentId);
        for (const r of rows) topUps.push(await ThirdwebTreasuryFundingEngine.syncTopUp(r.id).catch((e) => ({ id: r.id, error: e.message })));
      }
      if (!BondSubscriptionEngine && !ThirdwebTreasuryFundingEngine) return { handled: false, reason: 'payment consumers unavailable' };
      return { handled: true, paymentId: data.paymentId, status: data.status, subscriptions: synced, topUps };
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
