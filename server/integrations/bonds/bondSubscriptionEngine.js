'use strict';

/**
 * Bond subscription rail — how stablecoin enters the trust without a fiat rail.
 *
 * A subscriber (outside investor, lender, or a family member with their own
 * funds) buys units of a tokenized private-placement bond. The payment leg is
 * thirdweb Payments (POST /v1/bridge/payments): the subscriber settles the
 * hosted link in the settlement token (USDC) or, through thirdweb's own
 * on-ramp, by card/bank — either way the settlement token lands in the trust's
 * thirdweb server wallet. The delivery leg is the trust's own: once thirdweb
 * reports the payment COMPLETED the operator wallet transfers the bond units
 * to the subscriber's wallet (BondTokenizationEngine.applyTransfer), and the
 * register and journal move in the same step.
 *
 * Nothing is booked, and no unit moves, until the payment has actually
 * settled. Units are priced at par against principal ($1 = 1 unit) unless
 * BOND_SUBSCRIPTION_PRICE_BPS says otherwise; the operator must hold the
 * units it is selling, so a subscription can never create supply.
 *
 * Books: settlement token received is an on-chain asset (1210); units now in
 * a third party's hands are a claim on the corpus (2010 Token Claims Payable),
 * the same account Mint & Exchange OS uses for token it issues to holders.
 */

const { ThirdwebServerWalletEngine } = require('../dapp/thirdwebServerWalletEngine');
const { BondTokenizationEngine } = require('../dapp/bondTokenizationEngine');

let TrustAccountingEngine = null;
try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { /* optional */ }

let pool = null;
try { pool = require('./pgPool'); } catch (e) { /* no DB in tests */ }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function num(name, def = 0) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : def; }
function list(name) { return str(name).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean); }
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function newId() { return `BSUB-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }
function fail(message, status = 422, code = 'BOND_SUBSCRIPTION_ERROR') {
  return Object.assign(new Error(message), { status, statusCode: status, code });
}

let tablesReady = null;
async function ensureTables() {
  if (!pool || !pool.query) return;
  if (tablesReady) return tablesReady;
  tablesReady = pool.query(`
    CREATE TABLE IF NOT EXISTS bond_subscriptions (
      id TEXT PRIMARY KEY,
      token_id TEXT NOT NULL,
      bond_id INTEGER,
      units NUMERIC NOT NULL,
      price_bps INTEGER NOT NULL,
      amount_usd NUMERIC NOT NULL,
      settlement_token TEXT NOT NULL,
      settlement_quantity TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      recipient TEXT NOT NULL,
      investor_address TEXT NOT NULL,
      investor_name TEXT,
      payment_id TEXT,
      link TEXT,
      status TEXT NOT NULL,
      payment_hash TEXT,
      delivery_hash TEXT,
      journal_entry_id TEXT,
      failure_reason TEXT,
      requested_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch((e) => { tablesReady = null; throw e; });
  return tablesReady;
}

const memory = [];

class BondSubscriptionEngine {
  static getConfig() {
    const wallet = ThirdwebServerWalletEngine.getConfig();
    return {
      enabled: str('BOND_SUBSCRIPTION_ENABLED', 'true').toLowerCase() === 'true',
      secretKey: wallet.secretKey,
      chainId: wallet.chainId,
      recipient: wallet.address || null,
      settlementToken: str('BOND_SUBSCRIPTION_SETTLEMENT_TOKEN') || str('DAPP_USDC_ADDRESS') || null,
      settlementDecimals: num('BOND_SUBSCRIPTION_SETTLEMENT_DECIMALS', 6),
      priceBps: num('BOND_SUBSCRIPTION_PRICE_BPS', 10000),
      minUnits: num('BOND_SUBSCRIPTION_MIN_UNITS', 1),
      maxUnits: num('BOND_SUBSCRIPTION_MAX_UNITS', 0),
      // Private placement: when set, only these wallets may subscribe.
      allowedInvestors: list('BOND_SUBSCRIPTION_ALLOWED_INVESTORS'),
      assetAccountCode: str('BOND_SUBSCRIPTION_ASSET_ACCOUNT_CODE', '1210'),
      claimAccountCode: str('TOKEN_CLAIM_LIABILITY_ACCOUNT', '2010'),
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.enabled) issues.push('BOND_SUBSCRIPTION_ENABLED=false');
    if (!cfg.secretKey) issues.push('THIRDWEB_SECRET_KEY not configured');
    if (!cfg.settlementToken) issues.push('BOND_SUBSCRIPTION_SETTLEMENT_TOKEN (or DAPP_USDC_ADDRESS) not configured');
    if (!cfg.recipient) issues.push('THIRDWEB_SERVER_WALLET_ADDRESS not configured');
    if (!(cfg.priceBps > 0)) issues.push('BOND_SUBSCRIPTION_PRICE_BPS must be positive');
    const tokenization = BondTokenizationEngine.readiness();
    const shadow = tokenization.mode === 'shadow';
    if (shadow) issues.push('BOND_TOKEN_SHADOW=true: deliveries would be ledger-only');
    return {
      provider: 'thirdweb-payments',
      chainId: cfg.chainId,
      recipient: cfg.recipient,
      settlementToken: cfg.settlementToken,
      priceBps: cfg.priceBps,
      minUnits: cfg.minUnits,
      maxUnits: cfg.maxUnits || null,
      allowedInvestors: cfg.allowedInvestors.length,
      canDeliver: !shadow,
      ready: issues.length === 0,
      issues,
    };
  }

  static _quantity(amountUsd, decimals) {
    return (BigInt(Math.round(amountUsd * 100)) * 10n ** BigInt(decimals) / 100n).toString();
  }

  /** Units the operator wallet can still sell for a token, per the register. */
  static async availableUnits(tokenId) {
    const holdings = await BondTokenizationEngine.getHoldings(tokenId);
    const operator = String(BondTokenizationEngine.operatorAddress() || '').toLowerCase();
    return holdings
      .filter((h) => String(h.holder_address || '').toLowerCase() === operator)
      .reduce((s, h) => s + Number(h.balance || 0), 0);
  }

  /**
   * Open a subscription: validate the offer, create the thirdweb payment and
   * return the hosted link. Moves nothing.
   */
  static async create({ tokenId, units, investorAddress, investorName = null, requestedBy = null } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw fail('BOND_SUBSCRIPTION_ENABLED=false', 409, 'DISABLED');
    if (!cfg.settlementToken) throw fail('BOND_SUBSCRIPTION_SETTLEMENT_TOKEN not configured');
    const qty = Number(units);
    if (!Number.isFinite(qty) || qty <= 0) throw fail('units must be a positive number');
    if (qty < cfg.minUnits) throw fail(`units ${qty} below BOND_SUBSCRIPTION_MIN_UNITS ${cfg.minUnits}`);
    if (cfg.maxUnits && qty > cfg.maxUnits) throw fail(`units ${qty} exceeds BOND_SUBSCRIPTION_MAX_UNITS ${cfg.maxUnits}`, 422, 'LIMIT_EXCEEDED');
    if (!ADDRESS.test(String(investorAddress || ''))) throw fail('investorAddress must be an EVM address');
    if (cfg.allowedInvestors.length && !cfg.allowedInvestors.includes(String(investorAddress).toLowerCase())) {
      throw fail('investor is not in BOND_SUBSCRIPTION_ALLOWED_INVESTORS', 403, 'INVESTOR_NOT_ALLOWED');
    }

    const token = await BondTokenizationEngine.getToken(tokenId);
    if (token.status !== 'active') throw fail(`token ${tokenId} is ${token.status}`, 409, 'TOKEN_INACTIVE');
    if (token.bond_id == null) throw fail(`token ${tokenId} is not backed by a bond`, 409, 'TOKEN_UNBACKED');
    if (BondTokenizationEngine.classifyToken(token) !== 'on_chain') throw fail(`token ${tokenId} is not deployed on chain ${cfg.chainId}`, 409, 'TOKEN_OFF_CHAIN');
    const available = await this.availableUnits(tokenId);
    if (qty > available + 1e-9) throw fail(`operator holds ${available} ${token.token_symbol}, cannot sell ${qty}`, 409, 'INSUFFICIENT_UNITS');

    const amountUsd = round2(qty * cfg.priceBps / 10000);
    const settlementQuantity = this._quantity(amountUsd, cfg.settlementDecimals);
    const recipient = await ThirdwebServerWalletEngine.resolveAddress();
    const id = newId();
    const payment = await ThirdwebServerWalletEngine._request('POST', '/v1/bridge/payments', {
      name: `${token.token_symbol} subscription — ${qty} units`,
      description: `Subscription for ${qty} units of ${token.token_name} (bond #${token.bond_id}) at ${cfg.priceBps / 100}% of par, delivered to ${investorAddress}`,
      token: { address: cfg.settlementToken, chainId: cfg.chainId, amount: settlementQuantity },
      recipient,
      purchaseData: { trust: 'DLB', subscriptionId: id, tokenId, bondId: token.bond_id, units: qty, investorAddress, requestedBy },
    });

    return this._insert({
      id,
      tokenId,
      bondId: token.bond_id == null ? null : Number(token.bond_id),
      units: qty,
      priceBps: cfg.priceBps,
      amountUsd,
      settlementToken: cfg.settlementToken,
      settlementQuantity,
      chainId: cfg.chainId,
      recipient,
      investorAddress,
      investorName,
      paymentId: payment.id || null,
      link: payment.link || null,
      status: 'PENDING_PAYMENT',
      paymentHash: null,
      deliveryHash: null,
      journalEntryId: null,
      failureReason: null,
      requestedBy,
    });
  }

  /**
   * Ask thirdweb where the payment stands; on COMPLETED deliver the units.
   * Idempotent: a delivered subscription is returned as is.
   */
  static async sync(id) {
    const record = await this.get(id);
    if (!record) throw fail(`subscription ${id} not found`, 404, 'NOT_FOUND');
    if (record.status === 'DELIVERED' || record.status === 'FAILED') return record;
    if (record.status === 'PAID') return this.deliver(id);
    if (!record.paymentId) return record;

    const response = await ThirdwebServerWalletEngine._request('GET', `/v1/bridge/payments/${record.paymentId}`);
    const payments = Array.isArray(response) ? response : (response.data || []);
    const latest = payments[0] || {};
    const status = latest.status || 'PENDING';
    const hash = (latest.transactions || []).map((t) => t.transactionHash).find(Boolean) || null;

    if (status === 'FAILED') return this._update(id, { status: 'FAILED', failureReason: 'thirdweb reported the payment FAILED' });
    if (status !== 'COMPLETED') return this._update(id, { paymentHash: hash });
    if (latest.destinationAmount && BigInt(latest.destinationAmount) < BigInt(record.settlementQuantity)) {
      return this._update(id, { status: 'FAILED', paymentHash: hash, failureReason: `settled ${latest.destinationAmount} < expected ${record.settlementQuantity}` });
    }
    await this._update(id, { status: 'PAID', paymentHash: hash });
    return this.deliver(id);
  }

  /** Transfer the units to the subscriber and book the subscription. */
  static async deliver(id) {
    const record = await this.get(id);
    if (!record) throw fail(`subscription ${id} not found`, 404, 'NOT_FOUND');
    if (record.status === 'DELIVERED') return record;
    if (record.status !== 'PAID') throw fail(`subscription ${id} is ${record.status}, not PAID`, 409, 'NOT_PAID');

    let transfer;
    try {
      transfer = await BondTokenizationEngine.applyTransfer({ tokenId: record.tokenId, amount: record.units, toAddress: record.investorAddress });
    } catch (e) {
      await this._update(id, { failureReason: `delivery failed: ${e.message}` });
      throw e;
    }
    const journal = await this._book(record);
    return this._update(id, {
      status: 'DELIVERED',
      deliveryHash: transfer.txHash || null,
      journalEntryId: journal ? (journal.entry_id || journal.entryId || null) : null,
      failureReason: journal ? null : 'journal entry not posted',
    });
  }

  static async _book(record) {
    if (!TrustAccountingEngine) return null;
    const cfg = this.getConfig();
    return TrustAccountingEngine.postJournalEntry({
      entryDate: new Date(),
      description: `Bond subscription ${record.id}: ${record.units} units to ${record.investorAddress}`,
      referenceType: 'bond_subscription',
      referenceId: record.id,
      bondId: record.bondId,
      postedBy: record.requestedBy || 'bond-subscription-engine',
      postToFineract: false,
      lines: [
        { accountCode: cfg.assetAccountCode, debitAmount: record.amountUsd, creditAmount: 0, memo: `${record.settlementQuantity} settlement units to ${record.recipient} (${record.paymentHash || 'pending hash'})` },
        { accountCode: cfg.claimAccountCode, debitAmount: 0, creditAmount: record.amountUsd, memo: `${record.units} ${record.tokenId} claim held by ${record.investorAddress}` },
      ],
    }).catch((err) => {
      console.warn(`[BondSubscriptionEngine] journal entry failed: ${err.message}`);
      return null;
    });
  }

  static async _insert(record) {
    if (!pool || !pool.query) { memory.unshift(record); return record; }
    await ensureTables();
    await pool.query(
      `INSERT INTO bond_subscriptions
         (id, token_id, bond_id, units, price_bps, amount_usd, settlement_token, settlement_quantity, chain_id,
          recipient, investor_address, investor_name, payment_id, link, status, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [record.id, record.tokenId, record.bondId, record.units, record.priceBps, record.amountUsd, record.settlementToken,
        record.settlementQuantity, record.chainId, record.recipient, record.investorAddress, record.investorName,
        record.paymentId, record.link, record.status, record.requestedBy]
    );
    return record;
  }

  static async _update(id, patch) {
    const current = await this.get(id);
    const next = { ...current, ...patch };
    if (!pool || !pool.query) {
      const i = memory.findIndex((r) => r.id === id);
      if (i >= 0) memory[i] = next;
      return next;
    }
    await pool.query(
      `UPDATE bond_subscriptions
          SET status = $2, payment_hash = $3, delivery_hash = $4, journal_entry_id = $5, failure_reason = $6, updated_at = NOW()
        WHERE id = $1`,
      [id, next.status, next.paymentHash, next.deliveryHash, next.journalEntryId, next.failureReason]
    );
    return next;
  }

  static _fromRow(r) {
    return {
      id: r.id,
      tokenId: r.token_id,
      bondId: r.bond_id == null ? null : Number(r.bond_id),
      units: Number(r.units),
      priceBps: Number(r.price_bps),
      amountUsd: Number(r.amount_usd),
      settlementToken: r.settlement_token,
      settlementQuantity: r.settlement_quantity,
      chainId: Number(r.chain_id),
      recipient: r.recipient,
      investorAddress: r.investor_address,
      investorName: r.investor_name,
      paymentId: r.payment_id,
      link: r.link,
      status: r.status,
      paymentHash: r.payment_hash,
      deliveryHash: r.delivery_hash,
      journalEntryId: r.journal_entry_id,
      failureReason: r.failure_reason,
      requestedBy: r.requested_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  static async get(id) {
    if (!pool || !pool.query) return memory.find((r) => r.id === id) || null;
    await ensureTables();
    const res = await pool.query('SELECT * FROM bond_subscriptions WHERE id = $1', [id]);
    return res.rows[0] ? this._fromRow(res.rows[0]) : null;
  }

  static async list({ status = null, limit = 50 } = {}) {
    if (!pool || !pool.query) return memory.filter((r) => !status || r.status === status).slice(0, limit);
    await ensureTables();
    const res = status
      ? await pool.query('SELECT * FROM bond_subscriptions WHERE status = $1 ORDER BY created_at DESC LIMIT $2', [status, limit])
      : await pool.query('SELECT * FROM bond_subscriptions ORDER BY created_at DESC LIMIT $1', [limit]);
    return res.rows.map((r) => this._fromRow(r));
  }

  /** Sync every open subscription; used by the scheduler and the admin route. */
  static async syncOpen() {
    const open = await this.list({ status: 'PENDING_PAYMENT', limit: 200 });
    const paid = await this.list({ status: 'PAID', limit: 200 });
    const results = [];
    for (const r of [...open, ...paid]) {
      try { results.push(await this.sync(r.id)); } catch (e) { results.push({ id: r.id, error: e.message }); }
    }
    return results;
  }
}

module.exports = { BondSubscriptionEngine };
