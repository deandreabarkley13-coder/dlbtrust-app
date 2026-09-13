'use strict';

/**
 * thirdweb on-ramp → server wallet → Spritz bill pay, as one governed run.
 *
 *   1. quote the Spritz bill (gross = amount + Spritz fee)
 *   2. read the thirdweb server wallet's USDC; if it is short, open a thirdweb
 *      Bridge top-up (hosted checkout) for the shortfall — the trustee pays it
 *      with card/bank, thirdweb delivers USDC to the wallet
 *   3. once the wallet is funded (immediately, or after advance() sees the
 *      top-up COMPLETED and booked), stage the vendor bill as a canonical
 *      vendor_bill proposal with fundingMode 'treasury_wallet'
 *   4. maker + checker sign in the consensus panel; execution pays the bill
 *      from the wallet through the thirdweb API with no ERP draw
 *
 * The proposal is only created after funds are confirmed so a signature can
 * never fire an underfunded settlement. Nothing here bypasses maker/checker.
 */

const { SpritzBillPayEngine } = require('./spritzBillPayEngine');
const { SpritzTreasuryLegEngine } = require('./spritzTreasuryLegEngine');

let pool = null;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

let ThirdwebTreasuryFundingEngine = null;
try { ({ ThirdwebTreasuryFundingEngine } = require('../dapp/thirdwebTreasuryFundingEngine')); } catch (e) { ThirdwebTreasuryFundingEngine = null; }
let VendorPaymentEngine = null;
try { ({ VendorPaymentEngine } = require('../dapp/vendorPaymentEngine')); } catch (e) { VendorPaymentEngine = null; }
let CanonicalConsensusEngine = null;
try { ({ CanonicalConsensusEngine } = require('../dapp/canonicalConsensusEngine')); } catch (e) { CanonicalConsensusEngine = null; }

const STATUSES = {
  AWAITING_TOPUP: 'awaiting_topup',
  AWAITING_FUNDS: 'awaiting_funds',
  AWAITING_APPROVAL: 'awaiting_approval',
  PAID: 'paid',
  TOPUP_FAILED: 'topup_failed',
  FAILED: 'failed',
};
const TERMINAL = new Set([STATUSES.PAID, STATUSES.TOPUP_FAILED, STATUSES.FAILED]);

function badRequest(message, code = 'BAD_REQUEST') { return Object.assign(new Error(message), { status: 400, code }); }
function conflict(message, code) { return Object.assign(new Error(message), { status: 409, code }); }
function notFound(message) { return Object.assign(new Error(message), { status: 404, code: 'NOT_FOUND' }); }
function id() { return `TWBP-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }
function round2(n) { return Math.round(Number(n) * 100) / 100; }

const memory = [];
let tablesReady = null;
async function ensureTables() {
  if (!pool || !pool.query) return;
  if (tablesReady) return tablesReady;
  tablesReady = pool.query(`
    CREATE TABLE IF NOT EXISTS thirdweb_onramp_billpay_pipelines (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      spritz_bill_id TEXT NOT NULL,
      vendor_bill_id TEXT,
      proposal_id TEXT,
      top_up_id TEXT,
      amount_usd NUMERIC NOT NULL,
      fee_usd NUMERIC NOT NULL DEFAULT 0,
      required_usd NUMERIC NOT NULL,
      wallet TEXT,
      wallet_balance_usd NUMERIC,
      created_by TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch((e) => { tablesReady = null; throw e; });
  return tablesReady;
}

function fromRow(row) {
  const m = typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : (row.metadata || {});
  return {
    id: row.id,
    status: row.status,
    spritzBillId: row.spritz_bill_id,
    vendorBillId: row.vendor_bill_id,
    proposalId: row.proposal_id,
    topUpId: row.top_up_id,
    amountUsd: Number(row.amount_usd),
    feeUsd: Number(row.fee_usd),
    requiredUsd: Number(row.required_usd),
    wallet: row.wallet,
    walletBalanceUsd: row.wallet_balance_usd === null || row.wallet_balance_usd === undefined ? null : Number(row.wallet_balance_usd),
    createdBy: row.created_by,
    metadata: m,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class ThirdwebOnrampBillPayPipeline {
  static get STATUSES() { return STATUSES; }

  static async readiness() {
    const billPay = SpritzBillPayEngine.config();
    const issues = [];
    if (billPay.payoutWalletSigner !== 'thirdweb') issues.push('SPRITZ_PAYOUT_WALLET must be the thirdweb server wallet (THIRDWEB_SERVER_WALLET_ADDRESS)');
    if (!ThirdwebTreasuryFundingEngine) issues.push('ThirdwebTreasuryFundingEngine not available');
    if (!VendorPaymentEngine) issues.push('VendorPaymentEngine not available');
    if (!CanonicalConsensusEngine) issues.push('CanonicalConsensusEngine not available');
    let topUp = null;
    if (ThirdwebTreasuryFundingEngine) {
      topUp = ThirdwebTreasuryFundingEngine.readiness();
      if (!topUp.canTopUp) issues.push('thirdweb bridge top-ups unavailable (THIRDWEB_SECRET_KEY)');
    }
    return {
      ready: issues.length === 0,
      issues,
      payoutWallet: billPay.payoutWallet,
      payoutWalletSigner: billPay.payoutWalletSigner,
      billPayLive: billPay.live,
      fundingMode: 'treasury_wallet',
      topUp,
    };
  }

  /**
   * Open a pipeline for one Spritz bill. Returns the record plus, when a
   * top-up was needed, the hosted checkout link the trustee must complete.
   */
  static async start({ spritzBillId, amountUsd, vendorBillId, memo, topUp = {}, createdBy = 'system' } = {}) {
    if (!spritzBillId) throw badRequest('spritzBillId required');
    if (!ThirdwebTreasuryFundingEngine || !VendorPaymentEngine || !CanonicalConsensusEngine) throw conflict('pipeline dependencies unavailable', 'PIPELINE_UNAVAILABLE');
    const cfg = SpritzBillPayEngine.config();
    if (cfg.payoutWalletSigner !== 'thirdweb') throw conflict('SPRITZ_PAYOUT_WALLET is not the thirdweb server wallet; the on-ramp pipeline settles from that wallet', 'PAYOUT_SIGNER_MISMATCH');

    const quoted = await SpritzBillPayEngine.quote({ spritzBillId, amountUsd });
    const required = round2(quoted.amountUsd + quoted.feeUsd);
    const balance = await this._walletBalance(cfg.payoutWallet);
    const shortfall = balance === null ? required : Math.max(0, round2(required - balance));

    let vendorBill = null;
    if (vendorBillId) {
      vendorBill = await VendorPaymentEngine.getBill(vendorBillId);
      if (!vendorBill) throw notFound(`Vendor bill ${vendorBillId} not found`);
    }

    let topUpRecord = null;
    const topUpAmount = topUp.amountFiat !== undefined ? Number(topUp.amountFiat) : shortfall;
    if (topUpAmount > 0) {
      if (topUpAmount + 1e-9 < shortfall) throw badRequest(`topUp.amountFiat ${topUpAmount} does not cover the ${shortfall.toFixed(2)} USDC shortfall`, 'TOPUP_TOO_SMALL');
      topUpRecord = await ThirdwebTreasuryFundingEngine.createTopUp({
        amountFiat: topUpAmount,
        currency: topUp.currency,
        chainId: topUp.chainId || cfg.chainId,
        tokenAddress: topUp.tokenAddress || cfg.settlementToken,
        sourceType: topUp.sourceType,
        sourceAccountId: topUp.sourceAccountId,
        requestedBy: createdBy,
        requesterRole: topUp.requesterRole || 'trustee',
      });
    }

    const record = {
      id: id(),
      status: topUpRecord ? STATUSES.AWAITING_TOPUP : STATUSES.AWAITING_APPROVAL,
      spritzBillId: quoted.bill.id,
      vendorBillId: vendorBill ? vendorBill.bill_id : null,
      proposalId: null,
      topUpId: topUpRecord ? topUpRecord.id : null,
      amountUsd: quoted.amountUsd,
      feeUsd: quoted.feeUsd,
      requiredUsd: required,
      wallet: cfg.payoutWallet,
      walletBalanceUsd: balance,
      createdBy,
      metadata: {
        bill: quoted.bill,
        memo: memo || null,
        quote: { id: quoted.quoteId, expiresAt: quoted.expiresAt },
        shortfallUsd: shortfall,
        topUp: topUpRecord ? { id: topUpRecord.id, paymentId: topUpRecord.paymentId, link: topUpRecord.link, amountFiat: topUpRecord.amountFiat, status: topUpRecord.status } : null,
        history: [{ at: new Date().toISOString(), status: topUpRecord ? STATUSES.AWAITING_TOPUP : STATUSES.AWAITING_APPROVAL, note: topUpRecord ? `top-up ${topUpRecord.id} opened for ${topUpAmount}` : 'wallet already funded' }],
      },
    };
    await this._insert(record);
    if (!topUpRecord) await this._stageProposal(record);
    return this._present(await this.get(record.id));
  }

  /**
   * Move a pipeline forward: sync the top-up, re-check the wallet, stage the
   * proposal once funded, and reflect the proposal's execution outcome.
   */
  static async advance(pipelineId) {
    let record = await this.get(pipelineId);
    if (!record) throw notFound(`pipeline ${pipelineId} not found`);
    if (TERMINAL.has(record.status)) return this._present(record);

    if (record.topUpId && !record.proposalId) {
      const topUp = await ThirdwebTreasuryFundingEngine.syncTopUp(record.topUpId);
      record = await this._patch(record.id, {
        metadata: { ...record.metadata, topUp: { ...(record.metadata.topUp || {}), status: topUp.status, booked: topUp.booked, transactionHash: topUp.transactionHash } },
      });
      if (topUp.status === 'FAILED') {
        return this._present(await this._transition(record, STATUSES.TOPUP_FAILED, `top-up ${topUp.id} FAILED`));
      }
      if (topUp.status !== 'COMPLETED' || !topUp.booked) {
        return this._present(await this._transition(record, STATUSES.AWAITING_TOPUP, `top-up ${topUp.id} ${topUp.status}${topUp.status === 'COMPLETED' ? ' (not booked)' : ''}`));
      }
    }

    if (!record.proposalId) {
      const balance = await this._walletBalance(record.wallet);
      record = await this._patch(record.id, { walletBalanceUsd: balance });
      if (balance === null || balance + 1e-9 < record.requiredUsd) {
        return this._present(await this._transition(record, STATUSES.AWAITING_FUNDS, `wallet holds ${balance === null ? 'unknown' : balance.toFixed(2)} of ${record.requiredUsd.toFixed(2)} USDC`));
      }
      record = await this._stageProposal(record);
      return this._present(record);
    }

    const proposal = await CanonicalConsensusEngine.getProposal(record.proposalId);
    if (proposal.status === 'executed') {
      const payment = proposal.result && proposal.result.payment ? proposal.result.payment : null;
      record = await this._patch(record.id, { metadata: { ...record.metadata, payment } });
      return this._present(await this._transition(record, STATUSES.PAID, `proposal ${proposal.id} executed`));
    }
    if (proposal.status === 'failed' || proposal.status === 'rejected') {
      record = await this._patch(record.id, { metadata: { ...record.metadata, proposalError: proposal.result && proposal.result.error } });
      return this._present(await this._transition(record, STATUSES.FAILED, `proposal ${proposal.id} ${proposal.status}`));
    }
    return this._present(await this._transition(record, STATUSES.AWAITING_APPROVAL, `proposal ${proposal.id} ${proposal.status}`));
  }

  static async list({ status, limit = 50 } = {}) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
    if (!pool || !pool.query) return memory.filter((r) => !status || r.status === status).slice(0, n).map((r) => this._present(r));
    await ensureTables();
    const { rows } = status
      ? await pool.query('SELECT * FROM thirdweb_onramp_billpay_pipelines WHERE status = $1 ORDER BY created_at DESC LIMIT $2', [status, n])
      : await pool.query('SELECT * FROM thirdweb_onramp_billpay_pipelines ORDER BY created_at DESC LIMIT $1', [n]);
    return rows.map((r) => this._present(fromRow(r)));
  }

  static async get(pipelineId) {
    if (!pool || !pool.query) return memory.find((r) => r.id === pipelineId) || null;
    await ensureTables();
    const { rows } = await pool.query('SELECT * FROM thirdweb_onramp_billpay_pipelines WHERE id = $1', [pipelineId]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  static async _walletBalance(wallet) {
    try {
      const v = await SpritzTreasuryLegEngine.payoutWalletUsdcBalance({ address: wallet });
      if (v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    } catch (e) {
      return null;
    }
  }

  /** Create the vendor bill (if needed) and the maker/checker proposal in treasury_wallet mode. */
  static async _stageProposal(record) {
    const bill = await this._ensureVendorBill(record);
    const vendor = await VendorPaymentEngine.getVendor(bill.vendor_id);
    if (!vendor) throw notFound(`Vendor ${bill.vendor_id} not found`);
    const cfg = SpritzBillPayEngine.config();
    const proposal = await CanonicalConsensusEngine.createProposal({
      title: `Pay ${record.metadata.bill.name || record.spritzBillId} via Spritz Bill Pay from treasury wallet (${bill.bill_id})`,
      description: record.metadata.memo || bill.memo,
      category: 'vendor_bill',
      createdBy: record.createdBy,
      payload: {
        vendorPaymentBillId: bill.bill_id,
        amount: Number(bill.amount_cents) / 100,
        vendor,
        rail: 'spritz_bill_pay',
        spritzBillId: record.spritzBillId,
        fundingMode: 'treasury_wallet',
        fundingSource: { kind: 'treasury_wallet', wallet: cfg.payoutWallet, assetAccountCode: cfg.fundingSource.assetAccountCode, topUpId: record.topUpId },
        memo: record.metadata.memo || bill.memo,
        pipelineId: record.id,
      },
    });
    const patched = await this._patch(record.id, { vendorBillId: bill.bill_id, proposalId: proposal.id });
    return this._transition(patched, STATUSES.AWAITING_APPROVAL, `proposal ${proposal.id} staged; maker + checker signatures required`);
  }

  static async _ensureVendorBill(record) {
    if (record.vendorBillId) {
      const existing = await VendorPaymentEngine.getBill(record.vendorBillId);
      if (existing) return existing;
    }
    const spritzBill = record.metadata.bill || {};
    const vendors = await VendorPaymentEngine.listVendors({ status: 'active', limit: 500 });
    let vendor = vendors.find((v) => v.metadata && v.metadata.spritzBillId === record.spritzBillId) || null;
    if (!vendor) {
      vendor = await VendorPaymentEngine.createVendor({
        name: `${spritzBill.institution || 'Biller'} ${spritzBill.name || ''}`.trim(),
        country: 'US',
        metadata: { spritzBillId: record.spritzBillId, spritzBill: { type: spritzBill.type, institution: spritzBill.institution, accountNumberLast4: spritzBill.accountNumberLast4 }, source: 'spritz_bill_pay' },
      });
    }
    return VendorPaymentEngine.createBill({
      vendorId: vendor.vendor_id,
      amount: record.amountUsd,
      dueDate: (spritzBill.liability && spritzBill.liability.nextPaymentDueDate) || undefined,
      memo: record.metadata.memo || `Spritz Bill Pay ${spritzBill.name || record.spritzBillId} (thirdweb on-ramp pipeline ${record.id})`,
      metadata: { spritzBillId: record.spritzBillId, source: 'spritz_bill_pay', fundingMode: 'treasury_wallet', pipelineId: record.id },
    });
  }

  static async _transition(record, status, note) {
    const history = [...(record.metadata.history || []), { at: new Date().toISOString(), status, note }];
    return this._patch(record.id, { status, metadata: { ...record.metadata, history } });
  }

  static async _insert(record) {
    if (!pool || !pool.query) { memory.unshift(record); return record; }
    await ensureTables();
    await pool.query(
      `INSERT INTO thirdweb_onramp_billpay_pipelines
         (id, status, spritz_bill_id, vendor_bill_id, proposal_id, top_up_id, amount_usd, fee_usd, required_usd, wallet, wallet_balance_usd, created_by, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [record.id, record.status, record.spritzBillId, record.vendorBillId, record.proposalId, record.topUpId, record.amountUsd, record.feeUsd,
        record.requiredUsd, record.wallet, record.walletBalanceUsd, record.createdBy, JSON.stringify(record.metadata || {})]
    );
    return record;
  }

  static async _patch(pipelineId, patch) {
    const current = await this.get(pipelineId);
    if (!current) throw notFound(`pipeline ${pipelineId} not found`);
    const next = { ...current, ...patch };
    if (!pool || !pool.query) {
      const i = memory.findIndex((r) => r.id === pipelineId);
      if (i >= 0) memory[i] = next;
      return next;
    }
    await pool.query(
      `UPDATE thirdweb_onramp_billpay_pipelines
          SET status = $2, vendor_bill_id = $3, proposal_id = $4, wallet_balance_usd = $5, metadata = $6, updated_at = NOW()
        WHERE id = $1`,
      [pipelineId, next.status, next.vendorBillId, next.proposalId, next.walletBalanceUsd, JSON.stringify(next.metadata || {})]
    );
    return next;
  }

  static _present(record) {
    if (!record) return null;
    const topUp = record.metadata && record.metadata.topUp;
    return {
      ...record,
      fundingMode: 'treasury_wallet',
      checkoutLink: topUp && record.status === STATUSES.AWAITING_TOPUP ? topUp.link || null : null,
      nextAction: record.status === STATUSES.AWAITING_TOPUP ? 'complete the thirdweb checkout, then POST /advance'
        : record.status === STATUSES.AWAITING_FUNDS ? 'fund the payout wallet, then POST /advance'
          : record.status === STATUSES.AWAITING_APPROVAL ? 'maker and checker sign the vendor_bill proposal, then POST /advance'
            : null,
    };
  }

  static _resetMemory() { memory.length = 0; }
}

module.exports = { ThirdwebOnrampBillPayPipeline, PIPELINE_STATUSES: STATUSES };
