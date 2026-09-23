'use strict';

/**
 * thirdweb treasury funding — closes the fiat → on-chain gap with thirdweb's
 * Universal Bridge instead of a second on-ramp provider (Circle Mint,
 * MoonPay, Coinbase). The trust already authenticates to thirdweb with its
 * project secret key, so no additional custody credential is required:
 *
 *   GET  /v1/bridge/convert          fiat amount → token amount (rate check)
 *   POST /v1/bridge/payments         hosted checkout that delivers tokens to
 *                                    the treasury server wallet (the on-ramp)
 *   GET  /v1/bridge/payments/{id}    PENDING | COMPLETED | FAILED + tx hashes
 *   POST /v1/bridge/swap             rebalance treasury assets (e.g. ETH→USDC)
 *
 * Direction matters for the live gate. A top-up is *inbound*: creating a
 * payment link moves nothing and cannot spend trust assets, so it is allowed
 * whenever a secret key is present — otherwise the treasury could never be
 * funded in the first place. A swap spends assets the treasury already holds,
 * so it is gated on THIRDWEB_SERVER_WALLET_LIVE like every other live rail.
 *
 * Accounting follows reality, not intent: a top-up is only booked once
 * thirdweb reports COMPLETED, at which point the fiat leaves the trust hold
 * account and the journal moves value from trust cash into the on-chain asset
 * account. Until then the row sits PENDING and the hold account is untouched.
 *
 * Funding source: `sourceType` decides who is authoritative for "does this
 * money exist". `canonical` routes to CanonicalFundingSource, i.e. the
 * treasury core-banking ERP (Fineract) GL — availability is capped by the ERP,
 * drift against the sub-ledger blocks the draw, and the settlement entry posts
 * to both books in one call. Any other value keeps the previous behaviour of
 * asking SourceOfFundsAdapter (trust sub-ledger, cash, bonds, sub-ledgers).
 *
 * Settlement leg (TREASURY_TOPUP_SETTLEMENT_LEG) decides how the fiat actually
 * becomes tokens in the wallet:
 *   hosted_checkout  thirdweb collects the fiat itself (card / wallet prompt);
 *                    booked when the bridge reports COMPLETED.
 *   erp_credit_push  the ERP originates the money: SpritzFiatFundingEngine
 *                    posts DR asset / CR canonical cash in Fineract, pushes an
 *                    ACH / wire credit from the canonical cash account to the
 *                    Spritz auto-ramp account for the treasury wallet, and the
 *                    auto-ramp converts the deposit to USDC at that wallet.
 *                    No checkout link exists; the top-up completes when the
 *                    Spritz on-ramp settles. Requires a canonical source.
 */

const DistributionPolicy = require('./distributionPolicy');
const { ThirdwebPriceOracle, NATIVE_TOKEN } = require('./thirdwebPriceOracle');
const { ThirdwebServerWalletEngine } = require('./thirdwebServerWalletEngine');
const { SourceOfFundsAdapter } = require('../stablecoin/sourceOfFundsAdapter');
const { CanonicalFundingSource } = require('../fineract/canonicalFundingSource');

let SpritzFiatFundingEngine = null;
try { ({ SpritzFiatFundingEngine } = require('../spritz/spritzFiatFundingEngine')); } catch (e) { /* optional */ }

const SETTLEMENT_LEGS = new Set(['hosted_checkout', 'erp_credit_push']);
const ERP_LEG = 'erp_credit_push';
const CHECKOUT_LEG = 'hosted_checkout';

const CANONICAL_SOURCE_TYPES = new Set(['canonical', 'erp', 'core_banking_canonical']);

let TrustAccountingEngine = null;
try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { /* optional */ }

let pool = null;
try { pool = require('../bonds/pgPool'); } catch (e) { /* no DB in tests */ }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

const FIAT_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'KRW', 'CNY', 'INR', 'NOK', 'SEK',
  'CHF', 'AUD', 'CAD', 'NZD', 'MXN', 'BRL', 'CLP', 'CZK', 'DKK', 'HKD', 'HUF', 'IDR', 'ILS', 'ISK']);
const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED']);

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function num(name, def = 0) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : def; }
function toCents(usd) { return Math.round(Number(usd) * 100); }
function fromCents(cents) { return (Number(cents) || 0) / 100; }
function id(prefix = 'TWTOP') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

let tablesReady = null;
async function ensureTables() {
  if (!pool || !pool.query) return;
  if (tablesReady) return tablesReady;
  tablesReady = pool.query(`
    CREATE TABLE IF NOT EXISTS thirdweb_treasury_topups (
      id TEXT PRIMARY KEY,
      payment_id TEXT,
      link TEXT,
      chain_id INTEGER NOT NULL,
      token_address TEXT,
      symbol TEXT,
      quantity NUMERIC NOT NULL,
      amount_fiat NUMERIC NOT NULL,
      currency TEXT NOT NULL,
      recipient TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_account_id TEXT,
      status TEXT NOT NULL,
      booked BOOLEAN NOT NULL DEFAULT FALSE,
      transaction_hash TEXT,
      requested_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE thirdweb_treasury_topups ADD COLUMN IF NOT EXISTS book_of_record TEXT;
    ALTER TABLE thirdweb_treasury_topups ADD COLUMN IF NOT EXISTS journal_entry_id TEXT;
    ALTER TABLE thirdweb_treasury_topups ADD COLUMN IF NOT EXISTS fineract_transaction_id TEXT;
    ALTER TABLE thirdweb_treasury_topups ADD COLUMN IF NOT EXISTS booked_at TIMESTAMPTZ;
    ALTER TABLE thirdweb_treasury_topups ADD COLUMN IF NOT EXISTS settlement_leg TEXT NOT NULL DEFAULT 'hosted_checkout';
    ALTER TABLE thirdweb_treasury_topups ADD COLUMN IF NOT EXISTS settlement JSONB;
  `).catch((e) => { tablesReady = null; throw e; });
  return tablesReady;
}

const memoryTopUps = [];

class ThirdwebTreasuryFundingEngine {
  static getConfig() {
    const wallet = ThirdwebServerWalletEngine.getConfig();
    return {
      apiUrl: wallet.apiUrl,
      secretKey: wallet.secretKey,
      chainId: wallet.chainId,
      live: wallet.live,
      treasuryAddress: wallet.address,
      treasuryIdentifier: wallet.identifier,
      // Token the treasury is topped up in; native asset when unset.
      tokenAddress: str('TREASURY_TOPUP_TOKEN_ADDRESS') || str('DAPP_USDC_ADDRESS') || null,
      currency: str('TREASURY_TOPUP_CURRENCY', 'USD').toUpperCase(),
      // 'canonical' = the core-banking ERP is the authority on availability.
      holdSourceType: str('TREASURY_TOPUP_HOLD_SOURCE_TYPE', 'trust'),
      holdSourceAccountId: str('TREASURY_TOPUP_HOLD_ACCOUNT_ID') || str('EXPENSE_WALLET_HOLD_ACCOUNT_ID') || null,
      cryptoAccountCode: str('TREASURY_TOPUP_CRYPTO_ACCOUNT_CODE', '1210'),
      cashAccountCode: str('TREASURY_TOPUP_CASH_ACCOUNT_CODE', '1000'),
      settlementLeg: str('TREASURY_TOPUP_SETTLEMENT_LEG', CHECKOUT_LEG).toLowerCase(),
      erpRail: str('TREASURY_TOPUP_ERP_RAIL') || null,
      maxTopUpUsd: num('TREASURY_TOPUP_MAX_USD', 0),
      slippageBps: num('TREASURY_SWAP_SLIPPAGE_BPS', 50),
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.secretKey) issues.push('THIRDWEB_SECRET_KEY not configured');
    if (!FIAT_CURRENCIES.has(cfg.currency)) issues.push(`TREASURY_TOPUP_CURRENCY ${cfg.currency} is not supported by thirdweb bridge`);
    if (!cfg.holdSourceAccountId) issues.push('TREASURY_TOPUP_HOLD_ACCOUNT_ID not configured (pass sourceAccountId per request)');
    const canonical = this._isCanonical(cfg.holdSourceType) ? CanonicalFundingSource.readiness() : null;
    if (canonical && !canonical.ready) issues.push(...canonical.issues.map((i) => `canonical source: ${i}`));
    if (!SETTLEMENT_LEGS.has(cfg.settlementLeg)) issues.push(`TREASURY_TOPUP_SETTLEMENT_LEG ${cfg.settlementLeg} is not ${[...SETTLEMENT_LEGS].join(' or ')}`);
    if (cfg.settlementLeg === ERP_LEG) {
      if (!this._isCanonical(cfg.holdSourceType)) issues.push('erp_credit_push settlement requires TREASURY_TOPUP_HOLD_SOURCE_TYPE=canonical');
      if (!SpritzFiatFundingEngine) issues.push('SpritzFiatFundingEngine (ERP credit-push origination) not available');
    }
    return {
      provider: 'thirdweb-bridge',
      apiUrl: cfg.apiUrl,
      chainId: cfg.chainId,
      tokenAddress: cfg.tokenAddress,
      currency: cfg.currency,
      treasuryIdentifier: cfg.treasuryIdentifier,
      treasuryAddress: cfg.treasuryAddress || null,
      holdSourceType: cfg.holdSourceType,
      holdSourceAccountId: cfg.holdSourceAccountId,
      settlementLeg: cfg.settlementLeg,
      maxTopUpUsd: cfg.maxTopUpUsd || null,
      live: cfg.live,
      // Inbound funding needs no live flag; rebalancing treasury assets does.
      canTopUp: Boolean(cfg.secretKey),
      canSwap: cfg.live && Boolean(cfg.secretKey),
      canonicalSource: canonical,
      ready: issues.length === 0,
      issues,
    };
  }

  static _isCanonical(sourceType) {
    return CANONICAL_SOURCE_TYPES.has(String(sourceType || '').toLowerCase());
  }

  /**
   * readiness() plus the settlement leg's own gates. For erp_credit_push that
   * is SpritzFiatFundingEngine.readiness() against the treasury wallet: Spritz
   * integrator credentials, fiat_to_crypto capability, an auto-ramp account
   * converting to this wallet, and a bank channel the credit push can leave by.
   */
  static async settlementReadiness() {
    const base = this.readiness();
    if (base.settlementLeg !== ERP_LEG || !SpritzFiatFundingEngine) return { ...base, settlement: null };
    let settlement;
    try {
      settlement = await SpritzFiatFundingEngine.readiness({ destination: base.treasuryAddress || undefined });
    } catch (e) {
      settlement = { provider: 'spritz-fiat-funding', ready: false, issues: [e.message] };
    }
    const issues = [...base.issues, ...(settlement.issues || []).map((i) => `erp credit push: ${i}`)];
    return { ...base, settlement, canTopUp: base.canTopUp && settlement.ready, ready: issues.length === 0, issues };
  }

  /** Fiat → token amount straight from thirdweb (independent of the oracle). */
  static async convert({ amountFiat, currency, chainId, tokenAddress } = {}) {
    const cfg = this.getConfig();
    const fiat = Number(amountFiat);
    if (!Number.isFinite(fiat) || fiat <= 0) throw Object.assign(new Error('amountFiat must be a positive number'), { status: 422 });
    const cur = String(currency || cfg.currency).toUpperCase();
    if (!FIAT_CURRENCIES.has(cur)) throw Object.assign(new Error(`currency ${cur} not supported`), { status: 422 });
    const chain = Number(chainId || cfg.chainId);
    const token = tokenAddress === undefined ? cfg.tokenAddress : tokenAddress;
    const query = new URLSearchParams({
      from: cur,
      fromAmount: String(fiat),
      chainId: String(chain),
      to: token || NATIVE_TOKEN,
    });
    const result = await ThirdwebServerWalletEngine._request('GET', `/v1/bridge/convert?${query}`);
    const amount = Number(typeof result === 'object' ? result.result ?? result.amount : result);
    if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error('thirdweb bridge returned no conversion rate'), { status: 502 });
    const price = await ThirdwebPriceOracle.getPrice({ chainId: chain, tokenAddress: token });
    const quantity = this._toUnits(amount, price.decimals);
    return {
      currency: cur,
      amountFiat: fiat,
      chainId: chain,
      tokenAddress: token || NATIVE_TOKEN,
      symbol: price.symbol,
      decimals: price.decimals,
      amount,
      quantity,
      source: 'thirdweb-bridge',
    };
  }

  static _toUnits(amount, decimals) {
    const safe = Math.min(Number(decimals), 15);
    const scaled = BigInt(Math.round(amount * 10 ** safe));
    return (decimals > 15 ? scaled * 10n ** BigInt(decimals - 15) : scaled).toString();
  }

  static async _holdPosition({ sourceType, sourceAccountId, amountUsd }) {
    if (this._isCanonical(sourceType)) {
      const position = await CanonicalFundingSource.assertAvailable({
        amountUsd, accountCode: sourceAccountId, purpose: 'treasury top-up',
      });
      return { position, availableCents: position.availableBalanceCents, neededCents: toCents(amountUsd) };
    }
    const position = await SourceOfFundsAdapter.getPosition({ sourceType, sourceAccountId, purpose: 'payment' });
    const availableCents = Number(position.availableBalanceCents || 0);
    const neededCents = toCents(amountUsd);
    if (!position.fundingEligible) {
      throw Object.assign(
        new Error(`hold account ${sourceType}:${sourceAccountId} is not eligible to fund the treasury (${position.segregationReason || 'restricted'})`),
        { status: 422, code: 'SOURCE_RESTRICTED' }
      );
    }
    if (availableCents < neededCents) {
      throw Object.assign(
        new Error(`hold account ${sourceType}:${sourceAccountId} has $${fromCents(availableCents)} available, needs $${fromCents(neededCents)}`),
        { status: 422, code: 'INSUFFICIENT_SOURCE_FUNDS' }
      );
    }
    return { position, availableCents, neededCents };
  }

  /**
   * Create a hosted thirdweb checkout that delivers tokens to the treasury
   * server wallet. The returned `link` is what a trustee completes with the
   * trust's card or bank account; nothing is booked until it settles.
   */
  static async createTopUp({
    amountFiat, currency, chainId, tokenAddress,
    sourceType, sourceAccountId, requestedBy = null, requesterRole = 'trustee', rail,
  } = {}) {
    const cfg = this.getConfig();
    const fiat = Number(amountFiat);
    // A top-up is trust money leaving a hold account, so the trustee ceiling applies.
    DistributionPolicy.enforce({ requesterRole, amountUsd: fiat, purposeRequired: false });
    if (cfg.maxTopUpUsd && fiat > cfg.maxTopUpUsd) {
      throw Object.assign(new Error(`top-up ${fiat} exceeds TREASURY_TOPUP_MAX_USD ${cfg.maxTopUpUsd}`), { status: 422, code: 'TOPUP_LIMIT_EXCEEDED' });
    }
    const source = {
      sourceType: sourceType || cfg.holdSourceType,
      sourceAccountId: sourceAccountId || cfg.holdSourceAccountId,
    };
    if (!source.sourceAccountId) {
      throw Object.assign(new Error('sourceAccountId required (or set TREASURY_TOPUP_HOLD_ACCOUNT_ID)'), { status: 422 });
    }
    await this._holdPosition({ ...source, amountUsd: fiat });

    const quote = await this.convert({ amountFiat: fiat, currency, chainId, tokenAddress });
    const recipient = await ThirdwebServerWalletEngine.resolveAddress();
    if (cfg.settlementLeg === ERP_LEG) return this._createErpTopUp({ cfg, fiat, quote, recipient, source, requestedBy, rail });
    if (cfg.settlementLeg !== CHECKOUT_LEG) {
      throw Object.assign(new Error(`TREASURY_TOPUP_SETTLEMENT_LEG ${cfg.settlementLeg} is not supported`), { status: 409, code: 'SETTLEMENT_LEG_UNSUPPORTED' });
    }
    const payment = await ThirdwebServerWalletEngine._request('POST', '/v1/bridge/payments', {
      name: `DLB Trust treasury top-up (${quote.symbol})`,
      description: `Fund trust treasury wallet ${cfg.treasuryIdentifier} with ${quote.amount} ${quote.symbol} from ${source.sourceType}:${source.sourceAccountId}`,
      token: { address: quote.tokenAddress, chainId: quote.chainId, amount: quote.quantity },
      recipient,
      purchaseData: { trust: 'DLB', sourceType: source.sourceType, sourceAccountId: source.sourceAccountId, requestedBy },
    });

    return this._recordTopUp({
      id: id(),
      paymentId: payment.id || null,
      link: payment.link || null,
      chainId: quote.chainId,
      tokenAddress: quote.tokenAddress,
      symbol: quote.symbol,
      quantity: quote.quantity,
      amountFiat: fiat,
      currency: quote.currency,
      recipient,
      sourceType: source.sourceType,
      sourceAccountId: source.sourceAccountId,
      settlementLeg: CHECKOUT_LEG,
      settlement: null,
      status: 'PENDING',
      booked: false,
      transactionHash: null,
      requestedBy,
    });
  }

  /**
   * ERP-originated settlement: the canonical cash account is drawn in Fineract
   * and an ACH / wire credit is pushed to the Spritz auto-ramp account that
   * converts into USDC at the treasury wallet. The ERP entry (DR crypto asset /
   * CR canonical cash) posts at origination because that is when the cash
   * leaves the ERP; the on-chain leg is tracked by syncTopUp.
   */
  static async _createErpTopUp({ cfg, fiat, quote, recipient, source, requestedBy, rail }) {
    if (!this._isCanonical(source.sourceType)) {
      throw Object.assign(
        new Error(`erp_credit_push settlement originates only from the canonical ERP cash account, not ${source.sourceType}:${source.sourceAccountId}`),
        { status: 409, code: 'SETTLEMENT_SOURCE_NOT_CANONICAL' }
      );
    }
    if (!SpritzFiatFundingEngine) {
      throw Object.assign(new Error('SpritzFiatFundingEngine (ERP credit-push origination) not available'), { status: 503, code: 'ERP_ORIGINATION_UNAVAILABLE' });
    }
    const topUpId = id();
    const base = {
      id: topUpId, paymentId: null, link: null,
      chainId: quote.chainId, tokenAddress: quote.tokenAddress, symbol: quote.symbol, quantity: quote.quantity,
      amountFiat: fiat, currency: quote.currency, recipient,
      sourceType: source.sourceType, sourceAccountId: source.sourceAccountId,
      settlementLeg: ERP_LEG, transactionHash: null, requestedBy,
    };
    let funding;
    try {
      funding = await SpritzFiatFundingEngine.fund({
        amountUsd: fiat,
        reference: topUpId,
        rail: rail || cfg.erpRail || undefined,
        createdBy: requestedBy || 'thirdweb-treasury-funding-engine',
        memo: `ERP credit push: treasury top-up ${quote.amount} ${quote.symbol} to ${cfg.treasuryIdentifier} ${recipient} [${topUpId}]`,
        destination: recipient,
        assetAccountCode: cfg.cryptoAccountCode,
        sourceType: source.sourceType,
        sourceAccountId: source.sourceAccountId,
      });
    } catch (err) {
      // Origination can fail after the ERP commit; keep the top-up so the
      // Fineract draw stays visible and syncable instead of orphaned.
      const failed = await SpritzFiatFundingEngine.get(topUpId).catch(() => null);
      if (failed) {
        await this._recordTopUp({ ...base, ...this._bookingFromCommit(failed.erpCommit), settlement: this._settlementFromFunding(failed), status: 'FAILED' });
      }
      throw err;
    }
    return this._recordTopUp({
      ...base,
      ...this._bookingFromCommit(funding.erpCommit),
      settlement: this._settlementFromFunding(funding),
      status: 'PENDING',
    });
  }

  static _bookingFromCommit(commit) {
    if (!commit || !commit.committed) return { booked: false, bookOfRecord: null, journalEntryId: null, fineractTransactionId: null, bookedAt: null };
    return {
      booked: true,
      bookOfRecord: 'fineract',
      journalEntryId: commit.journalEntryId || commit.entryId || null,
      fineractTransactionId: commit.fineractTransactionId || null,
      bookedAt: new Date(),
    };
  }

  static _settlementFromFunding(funding) {
    if (!funding) return null;
    const transfer = funding.transfer || {};
    const account = funding.autoRampAccount || {};
    return {
      leg: ERP_LEG,
      provider: 'spritz-fiat-funding',
      status: funding.status || null,
      rail: funding.rail || null,
      destination: funding.destination || account.address || null,
      autoRampAccountId: account.id || funding.autoRampAccountId || null,
      transferId: transfer.id || funding.transferId || null,
      transferStatus: transfer.status || funding.transferStatus || null,
      onRampId: funding.onRampId || null,
      onRampStatus: funding.onRamp && funding.onRamp.status || null,
      error: funding.error || null,
    };
  }

  /**
   * ERP leg sync: transmit the originated credit push if it is still only
   * prepared, then follow the Spritz on-ramp until it completes.
   */
  static async _syncErpTopUp(record) {
    if (!SpritzFiatFundingEngine) return record;
    let funding = await SpritzFiatFundingEngine.get(record.id);
    if (!funding) return record;
    if (funding.status === 'prepared') {
      try {
        funding = await SpritzFiatFundingEngine.send({ reference: record.id });
      } catch (err) {
        // The credit push stays originated-but-untransmitted (e.g. no bank channel yet); surface why on the row.
        await this._updateTopUp(record.id, { settlement: { ...this._settlementFromFunding(funding), error: err.message } });
        throw err;
      }
    }
    if (!['completed', 'failed', 'cancelled'].includes(funding.status)) {
      await SpritzFiatFundingEngine.reconcile();
      funding = (await SpritzFiatFundingEngine.get(record.id)) || funding;
    }
    const status = funding.status === 'completed' ? 'COMPLETED'
      : ['failed', 'cancelled'].includes(funding.status) ? 'FAILED'
        : 'PENDING';
    const output = funding.onRamp && funding.onRamp.output || {};
    const hash = output.transactionHash || output.txHash || record.transactionHash || null;
    const patch = { status, transactionHash: hash, booked: record.booked, settlement: this._settlementFromFunding(funding) };
    if (record.booked) {
      Object.assign(patch, {
        bookOfRecord: record.bookOfRecord, journalEntryId: record.journalEntryId,
        fineractTransactionId: record.fineractTransactionId, bookedAt: record.bookedAt,
      });
    } else if (funding.erpCommit && funding.erpCommit.committed) {
      Object.assign(patch, this._bookingFromCommit(funding.erpCommit));
    }
    return this._updateTopUp(record.id, patch);
  }

  /**
   * Poll thirdweb for a top-up. On COMPLETED the fiat is swept out of the
   * hold account and journalled into the on-chain asset account exactly once.
   */
  static async syncTopUp(topUpId) {
    const record = await this.getTopUp(topUpId);
    if (!record) throw Object.assign(new Error(`top-up ${topUpId} not found`), { status: 404 });
    if (TERMINAL_STATUSES.has(record.status) && record.booked) return record;
    if (record.settlementLeg === ERP_LEG) return this._syncErpTopUp(record);
    if (!record.paymentId) return record;

    const response = await ThirdwebServerWalletEngine._request('GET', `/v1/bridge/payments/${record.paymentId}`);
    const payments = Array.isArray(response) ? response : (response.data || []);
    const latest = payments[0] || {};
    const status = latest.status || record.status;
    const hash = (latest.transactions || []).map((t) => t.transactionHash).find(Boolean) || record.transactionHash;

    const patch = {
      status, transactionHash: hash, booked: record.booked, bookOfRecord: record.bookOfRecord,
      journalEntryId: record.journalEntryId, fineractTransactionId: record.fineractTransactionId, bookedAt: record.bookedAt,
    };
    if (status === 'COMPLETED' && !record.booked) {
      Object.assign(patch, await this._book(record));
    }
    return this._updateTopUp(record.id, patch);
  }

  /**
   * Settle a completed top-up against its funding source. The canonical path
   * draws from the ERP and posts the entry to both books itself, so it does
   * not also run the sub-ledger-only journal; a shadow commit moves nothing
   * and therefore leaves the top-up unbooked.
   */
  static async _book(record) {
    const cfg = this.getConfig();
    if (this._isCanonical(record.sourceType)) {
      const result = await CanonicalFundingSource.commit({
        amountUsd: record.amountFiat,
        reference: record.id,
        referenceType: 'treasury_topup',
        memo: `thirdweb bridge top-up ${record.quantity} ${record.symbol} to ${record.recipient}`,
        cashAccountCode: record.sourceAccountId || cfg.cashAccountCode,
        assetAccountCode: cfg.cryptoAccountCode,
        postedBy: 'thirdweb-treasury-funding-engine',
        purpose: 'treasury top-up',
      });
      if (!result.committed) return { booked: false };
      return {
        booked: true,
        bookOfRecord: 'fineract',
        journalEntryId: result.journalEntryId || null,
        fineractTransactionId: result.fineractTransactionId || null,
        bookedAt: new Date(),
      };
    }
    await SourceOfFundsAdapter._fundSourceToTreasury({
      sourceType: record.sourceType,
      sourceAccountId: record.sourceAccountId,
      paymentId: record.id,
      amountCents: toCents(record.amountFiat),
    });
    const journal = await this._postJournal(record);
    return {
      booked: true,
      bookOfRecord: 'trust_ledger',
      journalEntryId: (journal && (journal.entry_id || journal.entryId || journal.id)) || null,
      fineractTransactionId: null,
      bookedAt: new Date(),
    };
  }

  static async _postJournal(record) {
    if (!TrustAccountingEngine) return null;
    const cfg = this.getConfig();
    return TrustAccountingEngine.postJournalEntry({
      entryDate: new Date(),
      description: `thirdweb bridge top-up of treasury wallet ${record.recipient} (${record.symbol})`,
      referenceType: 'treasury_topup',
      referenceId: record.id,
      postedBy: 'thirdweb-treasury-funding-engine',
      postToFineract: false,
      lines: [
        { accountCode: cfg.cryptoAccountCode, debitAmount: record.amountFiat, creditAmount: 0, memo: `${record.quantity} ${record.symbol} on chain ${record.chainId}` },
        { accountCode: cfg.cashAccountCode, debitAmount: 0, creditAmount: record.amountFiat, memo: `${record.sourceType}:${record.sourceAccountId}` },
      ],
    }).catch((err) => {
      console.warn(`[ThirdwebTreasuryFundingEngine] journal entry failed: ${err.message}`);
      return null;
    });
  }

  /**
   * Rebalance assets the treasury already holds (gas ↔ stablecoin) through
   * the bridge. Spends treasury value, so it needs the live flag.
   */
  static async swap({ quantity, amountUsd, fromTokenAddress, toTokenAddress, chainId, slippageBps } = {}) {
    const cfg = this.getConfig();
    if (!cfg.live) throw Object.assign(new Error('THIRDWEB_SERVER_WALLET_LIVE=false: treasury swaps are shadowed'), { status: 409, code: 'NOT_LIVE' });
    const chain = Number(chainId || cfg.chainId);
    const tokenIn = fromTokenAddress || NATIVE_TOKEN;
    const tokenOut = toTokenAddress || cfg.tokenAddress;
    if (!tokenOut) throw Object.assign(new Error('toTokenAddress required (or set TREASURY_TOPUP_TOKEN_ADDRESS)'), { status: 422 });
    let units = quantity;
    if (!units) {
      const quote = await ThirdwebPriceOracle.quantityForUsd({ chainId: chain, tokenAddress: tokenIn === NATIVE_TOKEN ? null : tokenIn, amountUsd });
      units = quote.quantity;
    }
    const from = await ThirdwebServerWalletEngine.resolveAddress();
    const result = await ThirdwebServerWalletEngine._request('POST', '/v1/bridge/swap', {
      exact: 'input',
      tokenIn: { address: tokenIn, chainId: chain, amount: String(units) },
      tokenOut: { address: tokenOut, chainId: chain },
      from,
      slippageToleranceBps: slippageBps === undefined ? cfg.slippageBps : slippageBps,
    });
    return { from, chainId: chain, tokenIn, tokenOut, quantity: String(units), transactionId: result.transactionId || null };
  }

  /** Native + configured token balance of the treasury wallet. */
  static async treasuryBalances({ chainId } = {}) {
    const cfg = this.getConfig();
    const chain = Number(chainId || cfg.chainId);
    const address = await ThirdwebServerWalletEngine.resolveAddress();
    const balances = await ThirdwebServerWalletEngine.balance({ address, chainId: chain });
    if (cfg.tokenAddress) {
      const token = await ThirdwebServerWalletEngine.balance({ address, chainId: chain, tokenAddress: cfg.tokenAddress });
      return { address, chainId: chain, balances: [...(balances.balances || balances), ...(token.balances || token)] };
    }
    return { address, chainId: chain, balances: balances.balances || balances };
  }

  static async _recordTopUp(record) {
    if (!pool || !pool.query) {
      memoryTopUps.unshift(record);
      return record;
    }
    await ensureTables();
    await pool.query(
      `INSERT INTO thirdweb_treasury_topups
         (id, payment_id, link, chain_id, token_address, symbol, quantity, amount_fiat, currency,
          recipient, source_type, source_account_id, status, booked, transaction_hash, requested_by,
          settlement_leg, settlement, book_of_record, journal_entry_id, fineract_transaction_id, booked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [record.id, record.paymentId, record.link, record.chainId, record.tokenAddress, record.symbol,
        record.quantity, record.amountFiat, record.currency, record.recipient, record.sourceType,
        record.sourceAccountId, record.status, record.booked, record.transactionHash, record.requestedBy,
        record.settlementLeg || CHECKOUT_LEG, record.settlement ? JSON.stringify(record.settlement) : null,
        record.bookOfRecord || null, record.journalEntryId || null, record.fineractTransactionId || null, record.bookedAt || null]
    );
    return record;
  }

  static async _updateTopUp(topUpId, patch) {
    const current = await this.getTopUp(topUpId);
    const next = { ...current, ...patch };
    if (!pool || !pool.query) {
      const index = memoryTopUps.findIndex((r) => r.id === topUpId);
      if (index >= 0) memoryTopUps[index] = next;
      return next;
    }
    await pool.query(
      `UPDATE thirdweb_treasury_topups
          SET status = $2, transaction_hash = $3, booked = $4, book_of_record = $5,
              journal_entry_id = $6, fineract_transaction_id = $7, booked_at = $8, settlement = $9, updated_at = NOW()
        WHERE id = $1`,
      [topUpId, next.status, next.transactionHash, next.booked, next.bookOfRecord || null,
        next.journalEntryId || null, next.fineractTransactionId || null, next.bookedAt || null,
        next.settlement ? JSON.stringify(next.settlement) : null]
    );
    return next;
  }

  static _fromRow(row) {
    return {
      id: row.id,
      paymentId: row.payment_id,
      link: row.link,
      chainId: Number(row.chain_id),
      tokenAddress: row.token_address,
      symbol: row.symbol,
      quantity: row.quantity,
      amountFiat: Number(row.amount_fiat),
      currency: row.currency,
      recipient: row.recipient,
      sourceType: row.source_type,
      sourceAccountId: row.source_account_id,
      settlementLeg: row.settlement_leg || CHECKOUT_LEG,
      settlement: row.settlement || null,
      status: row.status,
      booked: row.booked,
      bookOfRecord: row.book_of_record || null,
      journalEntryId: row.journal_entry_id || null,
      fineractTransactionId: row.fineract_transaction_id || null,
      bookedAt: row.booked_at || null,
      transactionHash: row.transaction_hash,
      requestedBy: row.requested_by,
      createdAt: row.created_at,
    };
  }

  static async getTopUp(topUpId) {
    if (!pool || !pool.query) return memoryTopUps.find((r) => r.id === topUpId) || null;
    await ensureTables();
    const { rows } = await pool.query('SELECT * FROM thirdweb_treasury_topups WHERE id = $1', [topUpId]);
    return rows[0] ? this._fromRow(rows[0]) : null;
  }

  static async listTopUps({ limit = 25, status = null } = {}) {
    const n = Math.min(Math.max(Number(limit) || 25, 1), 500);
    if (!pool || !pool.query) return memoryTopUps.filter((r) => !status || r.status === status).slice(0, n);
    await ensureTables();
    const { rows } = status
      ? await pool.query('SELECT * FROM thirdweb_treasury_topups WHERE status = $1 ORDER BY created_at DESC LIMIT $2', [status, n])
      : await pool.query('SELECT * FROM thirdweb_treasury_topups ORDER BY created_at DESC LIMIT $1', [n]);
    return rows.map((row) => this._fromRow(row));
  }

  /** Top-ups thirdweb has not yet reported terminal, or reported COMPLETED but not yet booked. */
  static async openTopUps({ limit = 500 } = {}) {
    const n = Math.min(Math.max(Number(limit) || 500, 1), 2000);
    if (!pool || !pool.query) {
      return memoryTopUps.filter((r) => (r.paymentId || r.settlementLeg === ERP_LEG) && (!TERMINAL_STATUSES.has(r.status) || (r.status === 'COMPLETED' && !r.booked))).slice(0, n);
    }
    await ensureTables();
    const { rows } = await pool.query(
      `SELECT * FROM thirdweb_treasury_topups
        WHERE (payment_id IS NOT NULL OR settlement_leg = '${ERP_LEG}')
          AND (status NOT IN ('COMPLETED', 'FAILED') OR (status = 'COMPLETED' AND booked = FALSE))
        ORDER BY created_at ASC LIMIT $1`,
      [n]
    );
    return rows.map((row) => this._fromRow(row));
  }

  static async topUpsByPaymentId(paymentId) {
    if (!paymentId) return [];
    if (!pool || !pool.query) return memoryTopUps.filter((r) => r.paymentId === paymentId);
    await ensureTables();
    const { rows } = await pool.query('SELECT * FROM thirdweb_treasury_topups WHERE payment_id = $1', [paymentId]);
    return rows.map((row) => this._fromRow(row));
  }

  /** Sync every open top-up; used by the reconcile loop and the webhook fallback. */
  static async syncOpen() {
    const open = await this.openTopUps();
    const results = [];
    for (const r of open) {
      try { results.push(await this.syncTopUp(r.id)); } catch (e) { results.push({ id: r.id, error: e.message }); }
    }
    return results;
  }
}

module.exports = { ThirdwebTreasuryFundingEngine };
