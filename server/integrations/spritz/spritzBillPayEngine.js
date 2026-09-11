'use strict';

/**
 * SpritzBillPayEngine — vendor-bill settlement through Spritz Bill Pay,
 * funded by the Treasury-Core Banking ERP canonical GL.
 *
 *   Treasury-Core ERP cash (CanonicalFundingSource, Dr USDC treasury / Cr ERP cash)
 *     --> USDC held by the treasury payout wallet
 *     --(Spritz off-ramp quote, rail `bill_pay`, accountId = linked Spritz bill)-->
 *     biller (credit card, utility, loan, ...).
 *
 * The trust has no bank account, so the only fiat leg is Spritz's: the
 * platform never debits anything outside the ERP. Every payment is keyed by
 * the vendor payment run so a replay is idempotent, and is booked as
 * Dr bill expense (+ Dr Spritz fee) / Cr USDC treasury. Live movement needs
 * SPRITZ_BILLPAY_LIVE=true and CANONICAL_FUNDING_LIVE=true; otherwise the
 * quote is created and the full plan is recorded as a shadow run.
 *
 * When the payout wallet is externally held (the trust's Coinbase Spritz
 * wallet, the default) the server never signs: a live run stops at
 * `awaiting_signature` with the unsigned approve/payment calls, and
 * confirm({ paymentId, txHash }) books it once the wallet has sent them.
 */

const { SpritzEngine } = require('./spritzEngine');
const { SpritzTreasuryLegEngine, bookJournal, defaultFundingSource } = require('./spritzTreasuryLegEngine');

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }
let CanonicalFundingSource;
try { ({ CanonicalFundingSource } = require('../fineract/canonicalFundingSource')); } catch (e) { CanonicalFundingSource = null; }

const PAYABLE_STATUS = 'active';
const REFERENCE_TYPE = 'spritz_bill_pay';

function str(name, def = '') { return (process.env[name] || def).trim(); }

function badRequest(message, code = 'BAD_REQUEST') {
  return Object.assign(new Error(message), { status: 400, code });
}

function conflict(message, code) {
  return Object.assign(new Error(message), { status: 409, code });
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function meta(row) {
  if (!row) return {};
  const m = row.metadata;
  if (!m) return {};
  if (typeof m === 'string') { try { return JSON.parse(m); } catch (e) { return {}; } }
  return m;
}

function summarizeBill(bill) {
  if (!bill) return null;
  return {
    id: bill.id,
    status: bill.status,
    name: bill.name || null,
    type: bill.type || null,
    institution: (bill.institution && bill.institution.name) || null,
    accountNumberLast4: bill.accountNumberLast4 || null,
    currency: bill.currency || 'USD',
    liability: bill.liability || null,
    unpayableCode: bill.unpayableCode || null,
    requirements: bill.requirements || [],
    payable: bill.status === PAYABLE_STATUS && !bill.unpayableCode,
  };
}

class SpritzBillPayEngine {
  static config() {
    const leg = SpritzTreasuryLegEngine.config();
    const erp = CanonicalFundingSource ? CanonicalFundingSource.getConfig() : null;
    const funding = defaultFundingSource();
    return {
      live: str('SPRITZ_BILLPAY_LIVE', 'false').toLowerCase() === 'true',
      network: leg.network,
      chainId: leg.chainId,
      settlementToken: leg.settlementToken,
      payoutWallet: leg.payoutWallet,
      payoutWalletSigner: leg.payoutWalletSigner,
      payoutWalletProvider: leg.payoutWalletProvider,
      fundingSource: {
        kind: 'treasury_core_erp',
        system: (erp && erp.system) || 'fineract',
        sourceType: 'canonical',
        // ERP GL cash account the bill is drawn from.
        cashAccountCode: str('SPRITZ_BILLPAY_ERP_CASH_ACCOUNT') || funding.sourceAccountId || (erp && erp.cashAccountCode) || '1000',
        // USDC treasury asset account the draw lands in (and the bill is paid out of).
        assetAccountCode: str('SPRITZ_BILLPAY_USDC_ACCOUNT') || (erp && erp.assetAccountCode) || leg.gl.treasuryAccount,
        live: Boolean(erp && erp.live),
      },
      gl: {
        expenseAccount: str('SPRITZ_BILLPAY_EXPENSE_GL_ACCOUNT', '5100'),
        feeAccount: leg.gl.feeAccount,
      },
    };
  }

  static async ensureTables() {
    if (!pool || !pool.query) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS spritz_bill_payments (
        payment_id TEXT PRIMARY KEY,
        run_id TEXT UNIQUE,
        vendor_bill_id TEXT,
        spritz_bill_id TEXT NOT NULL,
        spritz_quote_id TEXT,
        spritz_offramp_id TEXT,
        tx_hash TEXT,
        amount_usd NUMERIC(18,2) NOT NULL,
        fee_usd NUMERIC(18,2) DEFAULT 0,
        erp_cash_account TEXT,
        erp_journal_entry_id TEXT,
        gl_journal_entry_id TEXT,
        status TEXT NOT NULL DEFAULT 'shadow' CHECK (status IN ('shadow','quoted','funded','awaiting_signature','settling','completed','failed')),
        payer_wallet TEXT,
        memo TEXT,
        metadata JSONB DEFAULT '{}',
        created_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query('ALTER TABLE spritz_bill_payments DROP CONSTRAINT IF EXISTS spritz_bill_payments_status_check');
    await pool.query(`ALTER TABLE spritz_bill_payments ADD CONSTRAINT spritz_bill_payments_status_check
      CHECK (status IN ('shadow','quoted','funded','awaiting_signature','settling','completed','failed'))`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_spritz_bill_payments_bill ON spritz_bill_payments(spritz_bill_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_spritz_bill_payments_status ON spritz_bill_payments(status)');
  }

  static async readiness() {
    const cfg = this.config();
    const issues = [];
    if (!str('SPRITZ_API_KEY')) issues.push('SPRITZ_API_KEY not configured');
    if (!cfg.network) issues.push(`chain ${cfg.chainId} has no Spritz network mapping`);
    if (!cfg.payoutWallet) issues.push('SPRITZ_PAYOUT_WALLET / DAPP operator wallet not configured');
    if (!CanonicalFundingSource) issues.push('CanonicalFundingSource (Treasury-Core ERP) not available');
    if (cfg.live && !cfg.fundingSource.live) issues.push('SPRITZ_BILLPAY_LIVE=true but CANONICAL_FUNDING_LIVE=false: ERP draw would only be shadowed');
    let bills = [];
    let capability = null;
    if (str('SPRITZ_API_KEY')) {
      try {
        bills = (await SpritzEngine.listBills() || []).map(summarizeBill);
        const caps = await SpritzEngine.capabilities().catch(() => []);
        capability = (Array.isArray(caps) ? caps : []).find(c => c.product === 'crypto_to_fiat' && /bill/i.test(String(c.method || c.name || ''))) || null;
      } catch (e) {
        issues.push(e.message);
      }
      if (capability && capability.status !== 'active') issues.push(`Spritz Bill Pay is ${capability.status}`);
      if (!bills.some(b => b.payable)) issues.push('No payable Spritz bill linked (activate Spritz Bill Pay and link a bill)');
    }
    return {
      ready: issues.length === 0,
      mode: cfg.live && cfg.fundingSource.live ? 'live' : 'shadow',
      fundingSource: cfg.fundingSource,
      gl: cfg.gl,
      payoutWallet: cfg.payoutWallet || null,
      payoutWalletSigner: { type: cfg.payoutWalletSigner, provider: cfg.payoutWalletSigner === 'external' ? cfg.payoutWalletProvider : 'server' },
      network: cfg.network,
      billPay: capability ? { status: capability.status } : null,
      bills,
      issues,
    };
  }

  static async listBills() {
    const bills = await SpritzEngine.listBills();
    return (Array.isArray(bills) ? bills : []).map(summarizeBill);
  }

  static async getPayableBill(spritzBillId) {
    if (!spritzBillId) throw badRequest('spritzBillId required', 'SPRITZ_BILL_ID_REQUIRED');
    const bill = await SpritzEngine.getBill(spritzBillId);
    if (!bill) throw conflict(`Spritz bill ${spritzBillId} is not linked on this account`, 'SPRITZ_BILL_NOT_FOUND');
    const s = summarizeBill(bill);
    if (!s.payable) throw conflict(`Spritz bill ${spritzBillId} is ${s.unpayableCode || s.status}, not payable`, 'SPRITZ_BILL_NOT_PAYABLE');
    return s;
  }

  /** The Spritz bill a vendor bill settles to: bill metadata, then vendor metadata. */
  static spritzBillIdFor({ bill, vendor } = {}) {
    const b = meta(bill);
    const v = meta(vendor);
    return b.spritzBillId || b.spritz_bill_id || v.spritzBillId || v.spritz_bill_id || null;
  }

  static async quote({ spritzBillId, amountUsd } = {}) {
    const cfg = this.config();
    const amount = num(amountUsd);
    if (amount <= 0) throw badRequest('amountUsd must be a positive number');
    const bill = await this.getPayableBill(spritzBillId);
    const quote = await SpritzEngine.createBillPayQuote({
      billId: bill.id,
      amount: amount.toFixed(2),
      chain: cfg.network,
      tokenAddress: cfg.settlementToken || undefined,
      amountMode: 'output',
    });
    const input = num(quote && (quote.input && quote.input.amount));
    const output = num(quote && (quote.output && quote.output.amount)) || amount;
    const fee = num(quote && (quote.feeUsd || (quote.fees && quote.fees.total))) || Math.max(0, +(input - output).toFixed(2));
    return {
      bill,
      quoteId: quote && quote.id,
      status: quote && quote.status,
      fulfillment: quote && quote.fulfillment,
      amountUsd: +output.toFixed(2),
      inputUsd: input || null,
      feeUsd: +fee.toFixed(2),
      expiresAt: quote && (quote.expiresAt || quote.expires_at) || null,
      fundingSource: cfg.fundingSource,
      quote,
    };
  }

  static async getPayment({ paymentId, runId } = {}) {
    if (!pool || !pool.query) return null;
    await this.ensureTables();
    const r = paymentId
      ? await pool.query('SELECT * FROM spritz_bill_payments WHERE payment_id = $1', [paymentId])
      : await pool.query('SELECT * FROM spritz_bill_payments WHERE run_id = $1', [runId]);
    return r.rows[0] || null;
  }

  static async listPayments({ status, spritzBillId, limit = 100 } = {}) {
    if (!pool || !pool.query) return [];
    await this.ensureTables();
    const conds = [];
    const params = [];
    if (status) { conds.push(`status = $${params.length + 1}`); params.push(status); }
    if (spritzBillId) { conds.push(`spritz_bill_id = $${params.length + 1}`); params.push(spritzBillId); }
    params.push(limit);
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await pool.query(`SELECT * FROM spritz_bill_payments ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return r.rows;
  }

  /**
   * Settle one vendor bill through Spritz Bill Pay from the ERP. Idempotent on
   * `runId`: a replay returns the recorded payment.
   */
  static async pay({ runId, vendorBillId, spritzBillId, amountUsd, memo, initiatedBy = 'system' } = {}) {
    if (!runId) throw badRequest('runId required');
    const cfg = this.config();
    await this.ensureTables();
    const existing = await this.getPayment({ runId });
    if (existing && existing.status !== 'failed') return { ...this._result(existing), idempotent: true };

    const quoted = await this.quote({ spritzBillId, amountUsd });
    const amount = quoted.amountUsd;
    const gross = +(amount + quoted.feeUsd).toFixed(2);
    const paymentId = existing ? existing.payment_id : `SBP-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const description = memo || `Spritz Bill Pay ${quoted.bill.name || quoted.bill.id} (${vendorBillId || runId})`;

    // 1. Treasury-Core ERP draw: Dr USDC treasury / Cr ERP cash (shadow plan when not live).
    if (!CanonicalFundingSource) throw conflict('CanonicalFundingSource (Treasury-Core ERP) not available', 'ERP_UNAVAILABLE');
    const funding = await CanonicalFundingSource.commit({
      amountUsd: gross,
      reference: runId,
      referenceType: `${REFERENCE_TYPE}_funding`,
      memo: `ERP ${cfg.fundingSource.cashAccountCode} -> ${gross} USDC for ${description}`,
      cashAccountCode: cfg.fundingSource.cashAccountCode,
      assetAccountCode: cfg.fundingSource.assetAccountCode,
      postedBy: initiatedBy,
      purpose: 'spritz bill pay',
    });

    const live = cfg.live && funding.committed === true;
    const base = {
      paymentId, runId, vendorBillId: vendorBillId || null, spritzBillId: quoted.bill.id, spritzQuoteId: quoted.quoteId,
      amountUsd: amount, feeUsd: quoted.feeUsd, erpCashAccount: cfg.fundingSource.cashAccountCode,
      erpJournalEntryId: funding.journalEntryId || null, payerWallet: cfg.payoutWallet || null, memo: description, createdBy: initiatedBy,
      metadata: { bill: quoted.bill, quote: { id: quoted.quoteId, status: quoted.status, inputUsd: quoted.inputUsd, expiresAt: quoted.expiresAt }, funding, network: cfg.network, fundingSource: cfg.fundingSource },
    };

    if (!live) {
      const row = await this._save({ ...base, status: 'shadow', metadata: { ...base.metadata, reason: !cfg.live ? 'SPRITZ_BILLPAY_LIVE=false' : (funding.reason || 'ERP draw not committed') } });
      return this._result(row);
    }

    // 2. Pay the quote on-chain from the payout wallet (USDC -> Spritz -> biller).
    let settlement;
    try {
      if (cfg.payoutWalletSigner === 'external') {
        const unsignedTx = await SpritzEngine.prepareQuoteTransaction(quoted.quoteId, { senderAddress: cfg.payoutWallet });
        const row = await this._save({
          ...base,
          status: 'awaiting_signature',
          metadata: { ...base.metadata, unsignedTx, signer: { type: 'external', provider: cfg.payoutWalletProvider } },
        });
        return {
          ...this._result(row),
          unsignedTx,
          next: `Sign ${unsignedTx.approve ? 'approve then ' : ''}payment from ${cfg.payoutWallet} in the ${cfg.payoutWalletProvider} wallet, then POST /spritz/bill-pay/payments/${paymentId}/confirm { txHash }`,
        };
      }
      settlement = await SpritzEngine.executeQuote(quoted.quoteId);
    } catch (err) {
      // Never leave the ERP short: put the draw back before failing.
      if (funding.journalEntryId) {
        await CanonicalFundingSource.reverse({ journalEntryId: funding.journalEntryId, amountUsd: gross, reference: runId, postedBy: initiatedBy })
          .catch((e) => console.warn(`[SpritzBillPayEngine] ERP reversal failed for ${runId}: ${e.message}`));
      }
      await this._save({ ...base, status: 'failed', metadata: { ...base.metadata, error: err.message, erpReversed: Boolean(funding.journalEntryId) } });
      throw err;
    }

    const row = await this._settle({ base, quoted, gross, settlement, initiatedBy });
    return this._result(row);
  }

  /** Book a paid quote (Dr expense (+ Dr fee) / Cr USDC treasury) and mark the payment settling. */
  static async _settle({ base, quoted, gross, settlement, initiatedBy }) {
    const cfg = this.config();
    const amount = quoted.amountUsd;
    const journal = await bookJournal({
      referenceType: REFERENCE_TYPE,
      referenceId: quoted.quoteId,
      description: `Spritz Bill Pay ${amount.toFixed(2)} USD to ${quoted.bill.name || quoted.bill.id} [${base.runId}]`,
      lines: [
        { accountCode: cfg.gl.expenseAccount, debitAmount: amount, creditAmount: 0, description: `Bill ${quoted.bill.name || quoted.bill.id} paid via Spritz Bill Pay` },
        ...(quoted.feeUsd > 0 ? [{ accountCode: cfg.gl.feeAccount, debitAmount: quoted.feeUsd, creditAmount: 0, description: 'Spritz Bill Pay fee' }] : []),
        { accountCode: cfg.fundingSource.assetAccountCode, debitAmount: 0, creditAmount: gross, description: `USDC sent from payout wallet ${base.payerWallet || cfg.payoutWallet}` },
      ],
      postedBy: initiatedBy,
    });
    return this._save({
      ...base,
      status: 'settling',
      txHash: settlement && settlement.txHash || null,
      spritzOfframpId: settlement && (settlement.offRampId || settlement.offrampId) || null,
      glJournalEntryId: journal && journal.entryId || null,
      metadata: { ...base.metadata, settlement, journal },
    });
  }

  /** The external (Coinbase) payout wallet has sent the prepared transaction: record and book it. */
  static async confirm({ paymentId, txHash, confirmedBy = 'operator' } = {}) {
    if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(String(txHash))) throw badRequest('txHash required');
    const row = await this.getPayment({ paymentId });
    if (!row) throw badRequest(`Spritz bill payment not found: ${paymentId}`, 'NOT_FOUND');
    if (row.status !== 'awaiting_signature') {
      if (row.tx_hash && String(row.tx_hash).toLowerCase() === String(txHash).toLowerCase()) return { ...this._result(row), idempotent: true };
      throw conflict(`Spritz bill payment ${paymentId} is ${row.status}, not awaiting a signature`, 'NOT_AWAITING_SIGNATURE');
    }
    const m = meta(row);
    const base = {
      paymentId: row.payment_id, runId: row.run_id, vendorBillId: row.vendor_bill_id, spritzBillId: row.spritz_bill_id, spritzQuoteId: row.spritz_quote_id,
      amountUsd: num(row.amount_usd), feeUsd: num(row.fee_usd), erpCashAccount: row.erp_cash_account, erpJournalEntryId: row.erp_journal_entry_id,
      payerWallet: row.payer_wallet, memo: row.memo, createdBy: row.created_by, metadata: { ...m, confirmedBy, confirmedAt: new Date().toISOString() },
    };
    const quoted = { quoteId: row.spritz_quote_id, amountUsd: base.amountUsd, feeUsd: base.feeUsd, bill: m.bill || { id: row.spritz_bill_id } };
    const gross = +(base.amountUsd + base.feeUsd).toFixed(2);
    const saved = await this._settle({ base, quoted, gross, settlement: { txHash, quoteId: row.spritz_quote_id, signer: 'external' }, initiatedBy: confirmedBy });
    return this._result(saved);
  }

  /** Refresh a settling payment from the Spritz quote / off-ramp status. */
  static async refresh(paymentId) {
    const row = await this.getPayment({ paymentId });
    if (!row) throw badRequest(`Spritz bill payment not found: ${paymentId}`, 'NOT_FOUND');
    if (row.status !== 'settling' || !row.spritz_quote_id) return this._result(row);
    const quote = await SpritzEngine.getOffRampQuote(row.spritz_quote_id);
    const s = String(quote && quote.status || '').toLowerCase();
    let status = row.status;
    if (s === 'completed') status = 'completed';
    else if (['failed', 'expired', 'refunded', 'transaction_failed', 'insufficient_funds'].includes(s)) status = 'failed';
    if (status !== row.status && pool && pool.query) {
      await pool.query(
        `UPDATE spritz_bill_payments SET status = $2, metadata = metadata || $3::jsonb, updated_at = NOW() WHERE payment_id = $1`,
        [paymentId, status, JSON.stringify({ spritzStatus: s, refreshedAt: new Date().toISOString() })]
      );
    }
    return this._result({ ...row, status, metadata: { ...meta(row), spritzStatus: s } });
  }

  static async _save(p) {
    if (!pool || !pool.query) return { payment_id: p.paymentId, run_id: p.runId, vendor_bill_id: p.vendorBillId, spritz_bill_id: p.spritzBillId, spritz_quote_id: p.spritzQuoteId, spritz_offramp_id: p.spritzOfframpId || null, tx_hash: p.txHash || null, amount_usd: p.amountUsd, fee_usd: p.feeUsd, erp_cash_account: p.erpCashAccount, erp_journal_entry_id: p.erpJournalEntryId, gl_journal_entry_id: p.glJournalEntryId || null, status: p.status, payer_wallet: p.payerWallet, memo: p.memo, metadata: p.metadata, created_by: p.createdBy };
    const r = await pool.query(
      `INSERT INTO spritz_bill_payments (payment_id, run_id, vendor_bill_id, spritz_bill_id, spritz_quote_id, spritz_offramp_id, tx_hash, amount_usd, fee_usd,
          erp_cash_account, erp_journal_entry_id, gl_journal_entry_id, status, payer_wallet, memo, metadata, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (payment_id) DO UPDATE SET
         spritz_quote_id = EXCLUDED.spritz_quote_id, spritz_offramp_id = EXCLUDED.spritz_offramp_id, tx_hash = EXCLUDED.tx_hash,
         amount_usd = EXCLUDED.amount_usd, fee_usd = EXCLUDED.fee_usd, erp_journal_entry_id = EXCLUDED.erp_journal_entry_id,
         gl_journal_entry_id = EXCLUDED.gl_journal_entry_id, status = EXCLUDED.status, metadata = EXCLUDED.metadata, updated_at = NOW()
       RETURNING *`,
      [p.paymentId, p.runId, p.vendorBillId, p.spritzBillId, p.spritzQuoteId || null, p.spritzOfframpId || null, p.txHash || null, p.amountUsd, p.feeUsd || 0,
        p.erpCashAccount || null, p.erpJournalEntryId || null, p.glJournalEntryId || null, p.status, p.payerWallet || null, p.memo || null, JSON.stringify(p.metadata || {}), p.createdBy || null]
    );
    return r.rows[0];
  }

  static _result(row) {
    const m = meta(row);
    return {
      paymentId: row.payment_id,
      runId: row.run_id,
      vendorBillId: row.vendor_bill_id,
      spritzBillId: row.spritz_bill_id,
      spritzQuoteId: row.spritz_quote_id,
      spritzOfframpId: row.spritz_offramp_id || null,
      txHash: row.tx_hash || null,
      amountUsd: num(row.amount_usd),
      feeUsd: num(row.fee_usd),
      fundingSource: m.fundingSource || { kind: 'treasury_core_erp', cashAccountCode: row.erp_cash_account },
      erpJournalEntryId: row.erp_journal_entry_id || null,
      glJournalEntryId: row.gl_journal_entry_id || null,
      status: row.status,
      shadow: row.status === 'shadow',
      unsignedTx: row.status === 'awaiting_signature' ? (m.unsignedTx || null) : undefined,
      payerWallet: row.payer_wallet || null,
      memo: row.memo || null,
      metadata: m,
    };
  }
}

module.exports = { SpritzBillPayEngine, summarizeBill };
