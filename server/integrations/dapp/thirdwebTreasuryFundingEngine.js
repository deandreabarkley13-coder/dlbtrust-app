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
 */

const DistributionPolicy = require('./distributionPolicy');
const { ThirdwebPriceOracle, NATIVE_TOKEN } = require('./thirdwebPriceOracle');
const { ThirdwebServerWalletEngine } = require('./thirdwebServerWalletEngine');
const { SourceOfFundsAdapter } = require('../stablecoin/sourceOfFundsAdapter');
const { CanonicalFundingSource } = require('../fineract/canonicalFundingSource');

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
    )
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
    sourceType, sourceAccountId, requestedBy = null, requesterRole = 'trustee',
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
      status: 'PENDING',
      booked: false,
      transactionHash: null,
      requestedBy,
    });
  }

  /**
   * Poll thirdweb for a top-up. On COMPLETED the fiat is swept out of the
   * hold account and journalled into the on-chain asset account exactly once.
   */
  static async syncTopUp(topUpId) {
    const record = await this.getTopUp(topUpId);
    if (!record) throw Object.assign(new Error(`top-up ${topUpId} not found`), { status: 404 });
    if (!record.paymentId) return record;
    if (TERMINAL_STATUSES.has(record.status) && record.booked) return record;

    const response = await ThirdwebServerWalletEngine._request('GET', `/v1/bridge/payments/${record.paymentId}`);
    const payments = Array.isArray(response) ? response : (response.data || []);
    const latest = payments[0] || {};
    const status = latest.status || record.status;
    const hash = (latest.transactions || []).map((t) => t.transactionHash).find(Boolean) || record.transactionHash;

    let booked = record.booked;
    if (status === 'COMPLETED' && !booked) {
      booked = await this._book(record);
    }
    return this._updateTopUp(record.id, { status, transactionHash: hash, booked });
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
      return Boolean(result.committed);
    }
    await SourceOfFundsAdapter._fundSourceToTreasury({
      sourceType: record.sourceType,
      sourceAccountId: record.sourceAccountId,
      paymentId: record.id,
      amountCents: toCents(record.amountFiat),
    });
    await this._postJournal(record);
    return true;
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
          recipient, source_type, source_account_id, status, booked, transaction_hash, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [record.id, record.paymentId, record.link, record.chainId, record.tokenAddress, record.symbol,
        record.quantity, record.amountFiat, record.currency, record.recipient, record.sourceType,
        record.sourceAccountId, record.status, record.booked, record.transactionHash, record.requestedBy]
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
          SET status = $2, transaction_hash = $3, booked = $4, updated_at = NOW()
        WHERE id = $1`,
      [topUpId, next.status, next.transactionHash, next.booked]
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
      status: row.status,
      booked: row.booked,
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
      return memoryTopUps.filter((r) => r.paymentId && (!TERMINAL_STATUSES.has(r.status) || (r.status === 'COMPLETED' && !r.booked))).slice(0, n);
    }
    await ensureTables();
    const { rows } = await pool.query(
      `SELECT * FROM thirdweb_treasury_topups
        WHERE payment_id IS NOT NULL
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
