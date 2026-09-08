'use strict';

/**
 * Treasury deposits — funding the thirdweb server wallet from the trust's own
 * external wallet or exchange, i.e. value the trust already holds off-platform
 * and sends in itself. This is the counterpart of
 * `thirdwebTreasuryFundingEngine` (fiat → tokens through thirdweb's bridge
 * checkout): here no provider is involved, so the only thing the backend can
 * do is state the deposit instructions, watch the wallet, and book the credit
 * once it actually arrives.
 *
 * A deposit is declared before it is sent so the arrival can be attributed:
 * the wallet balance at declaration time is the baseline, and everything above
 * it is credited against the expected amount. Comparing a delta rather than a
 * single balance keeps pre-existing treasury holdings out of the credit, and
 * lets a partially funded deposit stay open instead of resolving as complete.
 *
 * Accounting follows the chain, never the declaration: `expected` books
 * nothing, `credited` books once (debit the on-chain asset account, credit the
 * external-funding contra account) and is idempotent, and a deposit that never
 * arrives can be cancelled without ever having touched the ledger.
 */

const { ThirdwebPriceOracle, NATIVE_TOKEN } = require('./thirdwebPriceOracle');
const { ThirdwebServerWalletEngine } = require('./thirdwebServerWalletEngine');

let TrustAccountingEngine = null;
try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { /* optional */ }

let pool = null;
try { pool = require('../bonds/pgPool'); } catch (e) { /* no DB in tests */ }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

const OPEN_STATUSES = ['expected', 'partial'];

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function id() { return `TWDEP-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }
function lower(value) { return String(value || '').toLowerCase(); }
function isAddress(value) { return /^0x[0-9a-fA-F]{40}$/.test(String(value || '')); }

function toBigInt(value, label = 'quantity') {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(text)) {
    throw Object.assign(new Error(`${label} must be an integer in smallest units, got "${text}"`), { status: 422 });
  }
  return BigInt(text);
}

/** Display amount (e.g. "250.5") → smallest units, without float rounding. */
function unitsFromAmount(amount, decimals) {
  const text = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw Object.assign(new Error(`amount "${text}" is not a positive decimal`), { status: 422 });
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) {
    throw Object.assign(new Error(`amount ${text} has more than ${decimals} decimal places`), { status: 422 });
  }
  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

function display(units, decimals) {
  if (!Number.isFinite(Number(decimals))) return String(units);
  const text = BigInt(units).toString().padStart(Number(decimals) + 1, '0');
  const cut = text.length - Number(decimals);
  const fraction = text.slice(cut).replace(/0+$/, '');
  return fraction ? `${text.slice(0, cut)}.${fraction}` : text.slice(0, cut);
}

let tablesReady = null;
async function ensureTables() {
  if (!pool || !pool.query) return;
  if (tablesReady) return tablesReady;
  tablesReady = pool.query(`
    CREATE TABLE IF NOT EXISTS treasury_wallet_deposits (
      id TEXT PRIMARY KEY,
      chain_id INTEGER NOT NULL,
      wallet_address TEXT NOT NULL,
      token_address TEXT,
      symbol TEXT,
      decimals INTEGER,
      expected_quantity NUMERIC NOT NULL,
      baseline_quantity NUMERIC NOT NULL,
      credited_quantity NUMERIC NOT NULL DEFAULT 0,
      from_address TEXT,
      status TEXT NOT NULL,
      booked BOOLEAN NOT NULL DEFAULT FALSE,
      amount_usd NUMERIC,
      memo TEXT,
      requested_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      credited_at TIMESTAMPTZ
    )
  `).catch((e) => { tablesReady = null; throw e; });
  return tablesReady;
}

const memoryDeposits = [];

class TreasuryDepositEngine {
  static getConfig() {
    const wallet = ThirdwebServerWalletEngine.getConfig();
    return {
      chainId: wallet.chainId,
      walletAddress: wallet.address,
      walletIdentifier: wallet.identifier,
      secretKey: wallet.secretKey,
      // Asset the treasury settles distributions in; native gas when unset.
      settlementToken: str('THIRDWEB_SETTLEMENT_TOKEN') || str('DAPP_USDC_ADDRESS') || null,
      cryptoAccountCode: str('TREASURY_DEPOSIT_CRYPTO_ACCOUNT_CODE', str('TREASURY_TOPUP_CRYPTO_ACCOUNT_CODE', '1210')),
      contraAccountCode: str('TREASURY_DEPOSIT_CONTRA_ACCOUNT_CODE', '1000'),
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.secretKey) issues.push('THIRDWEB_SECRET_KEY not configured');
    if (!cfg.walletAddress) issues.push('THIRDWEB_SERVER_WALLET_ADDRESS not configured');
    else if (!isAddress(cfg.walletAddress)) issues.push('THIRDWEB_SERVER_WALLET_ADDRESS is not a valid address');
    return {
      provider: 'treasury-deposit',
      chainId: cfg.chainId,
      walletAddress: cfg.walletAddress || null,
      walletIdentifier: cfg.walletIdentifier,
      settlementToken: cfg.settlementToken,
      cryptoAccountCode: cfg.cryptoAccountCode,
      contraAccountCode: cfg.contraAccountCode,
      accountingConfigured: Boolean(TrustAccountingEngine),
      // Watching an inbound deposit spends nothing, so it needs no live flag.
      canTrack: issues.length === 0,
      ready: issues.length === 0,
      issues,
    };
  }

  /**
   * Where to send funds, and what the wallet already holds. Gas and the
   * settlement token are reported separately because a distribution needs both.
   */
  static async instructions({ chainId, tokenAddress } = {}) {
    const cfg = this.getConfig();
    const chain = Number(chainId || cfg.chainId);
    const token = tokenAddress === undefined ? cfg.settlementToken : tokenAddress;
    const funding = await ThirdwebServerWalletEngine.fundingStatus({ chainId: chain, tokenAddress: token });
    return {
      depositAddress: funding.address,
      chainId: chain,
      chain: chain === 8453 ? 'Base' : chain === 1 ? 'Ethereum' : `chain ${chain}`,
      walletIdentifier: cfg.walletIdentifier,
      gasAsset: funding.gas,
      settlementAsset: { tokenAddress: funding.tokenAddress, ...funding.asset },
      funded: funding.funded,
      warning: `send only on chain ${chain}; funds sent on another chain are not recoverable by this wallet`,
    };
  }

  /** Token symbol/decimals for a deposit; the oracle already caches metadata. */
  static async _asset(chainId, tokenAddress) {
    const price = await ThirdwebPriceOracle.getPrice({ chainId, tokenAddress: tokenAddress || null });
    return { symbol: price.symbol, decimals: Number(price.decimals) };
  }

  /**
   * Declare an inbound deposit. Records the current balance as the baseline so
   * the arrival can be told apart from what the treasury already held. Nothing
   * is booked here — the deposit has not happened yet.
   */
  static async declare({
    quantity, amount, chainId, tokenAddress, fromAddress = null, memo = null, requestedBy = null,
  } = {}) {
    const cfg = this.getConfig();
    const chain = Number(chainId || cfg.chainId);
    const token = tokenAddress === undefined ? cfg.settlementToken : tokenAddress;
    if (token && !isAddress(token)) throw Object.assign(new Error('tokenAddress invalid'), { status: 422 });
    if (fromAddress && !isAddress(fromAddress)) throw Object.assign(new Error('fromAddress invalid'), { status: 422 });

    const asset = await this._asset(chain, token);
    const expected = quantity !== undefined && quantity !== null && quantity !== ''
      ? toBigInt(quantity)
      : unitsFromAmount(amount, asset.decimals);
    if (expected <= 0n) throw Object.assign(new Error('deposit amount must be positive'), { status: 422 });

    const funding = await ThirdwebServerWalletEngine.fundingStatus({ chainId: chain, tokenAddress: token });
    const record = {
      id: id(),
      chainId: chain,
      walletAddress: funding.address,
      tokenAddress: token || null,
      symbol: asset.symbol,
      decimals: asset.decimals,
      expectedQuantity: expected.toString(),
      baselineQuantity: funding.asset.held,
      creditedQuantity: '0',
      fromAddress: fromAddress ? lower(fromAddress) : null,
      status: 'expected',
      booked: false,
      amountUsd: null,
      memo,
      requestedBy,
      creditedAt: null,
    };
    await this._insert(record);
    return {
      ...record,
      expectedAmount: display(expected, asset.decimals),
      instructions: {
        depositAddress: funding.address,
        chainId: chain,
        tokenAddress: token || NATIVE_TOKEN,
        symbol: asset.symbol,
        amount: display(expected, asset.decimals),
      },
    };
  }

  /**
   * Compare the wallet against the baseline and credit what arrived. Credits
   * are capped at the expected amount so an unrelated inbound transfer cannot
   * inflate a deposit, and the journal is posted exactly once.
   */
  static async sync(depositId) {
    const record = await this.get(depositId);
    if (!record) throw Object.assign(new Error(`deposit ${depositId} not found`), { status: 404 });
    if (!OPEN_STATUSES.includes(record.status)) return record;

    const funding = await ThirdwebServerWalletEngine.fundingStatus({
      chainId: record.chainId, tokenAddress: record.tokenAddress,
    });
    const expected = BigInt(record.expectedQuantity);
    const delta = BigInt(funding.asset.held) - BigInt(record.baselineQuantity);
    const credited = delta <= 0n ? 0n : (delta > expected ? expected : delta);
    const status = credited >= expected ? 'credited' : credited > 0n ? 'partial' : 'expected';

    const patch = {
      creditedQuantity: credited.toString(),
      status,
      creditedAt: status === 'credited' ? new Date() : record.creditedAt,
    };
    if (status === 'credited' && !record.booked) {
      const booking = await this._book({ ...record, creditedQuantity: credited.toString() });
      patch.booked = booking.booked;
      patch.amountUsd = booking.amountUsd;
    }
    return this._update(record.id, patch);
  }

  /** Sync every open deposit; used by the dashboard and the reconcile job. */
  static async syncOpen({ limit = 100 } = {}) {
    const open = (await this.list({ status: 'open', limit })).filter((d) => OPEN_STATUSES.includes(d.status));
    const results = [];
    for (const deposit of open) {
      try {
        results.push(await this.sync(deposit.id));
      } catch (err) {
        results.push({ ...deposit, error: err.message });
      }
    }
    return { checked: results.length, credited: results.filter((r) => r.status === 'credited').length, deposits: results };
  }

  static async cancel(depositId, { reason = null } = {}) {
    const record = await this.get(depositId);
    if (!record) throw Object.assign(new Error(`deposit ${depositId} not found`), { status: 404 });
    if (record.status === 'credited') {
      throw Object.assign(new Error(`deposit ${depositId} already credited on chain and cannot be cancelled`), { status: 409, code: 'ALREADY_CREDITED' });
    }
    return this._update(depositId, { status: 'cancelled', memo: reason || record.memo });
  }

  /**
   * Book a credited deposit: the on-chain asset account is debited and the
   * external funding contra account credited, valued by the oracle. A failed
   * valuation or posting leaves the deposit unbooked rather than half-booked.
   */
  static async _book(record) {
    const cfg = this.getConfig();
    let amountUsd = null;
    try {
      const quote = await ThirdwebPriceOracle.quoteUsd({
        chainId: record.chainId, tokenAddress: record.tokenAddress, quantity: record.creditedQuantity,
      });
      amountUsd = quote.amountUsd;
    } catch (err) {
      console.warn(`[TreasuryDepositEngine] valuation of ${record.id} failed: ${err.message}`);
      return { booked: false, amountUsd: null };
    }
    if (!TrustAccountingEngine) return { booked: false, amountUsd };
    const posted = await TrustAccountingEngine.postJournalEntry({
      entryDate: new Date(),
      description: `Treasury deposit of ${display(record.creditedQuantity, record.decimals)} ${record.symbol} into wallet ${record.walletAddress}`,
      referenceType: 'treasury_deposit',
      referenceId: record.id,
      postedBy: 'treasury-deposit-engine',
      postToFineract: false,
      lines: [
        { accountCode: cfg.cryptoAccountCode, debitAmount: amountUsd, creditAmount: 0, memo: `${record.creditedQuantity} ${record.symbol} on chain ${record.chainId}` },
        { accountCode: cfg.contraAccountCode, debitAmount: 0, creditAmount: amountUsd, memo: record.fromAddress ? `deposit from ${record.fromAddress}` : 'external treasury deposit' },
      ],
    }).catch((err) => {
      console.warn(`[TreasuryDepositEngine] journal entry for ${record.id} failed: ${err.message}`);
      return null;
    });
    return { booked: Boolean(posted), amountUsd };
  }

  static async _insert(record) {
    if (!pool || !pool.query) {
      memoryDeposits.unshift({ ...record });
      return record;
    }
    await ensureTables();
    await pool.query(
      `INSERT INTO treasury_wallet_deposits
         (id, chain_id, wallet_address, token_address, symbol, decimals, expected_quantity,
          baseline_quantity, credited_quantity, from_address, status, booked, amount_usd, memo, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [record.id, record.chainId, record.walletAddress, record.tokenAddress, record.symbol, record.decimals,
        record.expectedQuantity, record.baselineQuantity, record.creditedQuantity, record.fromAddress,
        record.status, record.booked, record.amountUsd, record.memo, record.requestedBy]
    );
    return record;
  }

  static async _update(depositId, patch) {
    const current = await this.get(depositId);
    const next = { ...current, ...patch };
    if (!pool || !pool.query) {
      const index = memoryDeposits.findIndex((d) => d.id === depositId);
      if (index >= 0) memoryDeposits[index] = next;
      return next;
    }
    await ensureTables();
    await pool.query(
      `UPDATE treasury_wallet_deposits
          SET credited_quantity = $2, status = $3, booked = $4, amount_usd = $5, memo = $6,
              credited_at = $7, updated_at = NOW()
        WHERE id = $1`,
      [depositId, next.creditedQuantity, next.status, next.booked, next.amountUsd, next.memo, next.creditedAt]
    );
    return next;
  }

  static async get(depositId) {
    if (!pool || !pool.query) return memoryDeposits.find((d) => d.id === depositId) || null;
    await ensureTables();
    const { rows } = await pool.query(
      'SELECT * FROM treasury_wallet_deposits WHERE id = $1', [depositId]
    );
    return rows[0] ? this._fromRow(rows[0]) : null;
  }

  static async list({ status = null, limit = 50 } = {}) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const wanted = status === 'open' ? OPEN_STATUSES : status ? [String(status)] : null;
    if (!pool || !pool.query) {
      return memoryDeposits.filter((d) => !wanted || wanted.includes(d.status)).slice(0, n);
    }
    await ensureTables();
    const { rows } = wanted
      ? await pool.query(
        'SELECT * FROM treasury_wallet_deposits WHERE status = ANY($1) ORDER BY created_at DESC LIMIT $2', [wanted, n]
      )
      : await pool.query(
        'SELECT * FROM treasury_wallet_deposits ORDER BY created_at DESC LIMIT $1', [n]
      );
    return rows.map((row) => this._fromRow(row));
  }

  static _fromRow(row) {
    return {
      id: row.id,
      chainId: Number(row.chain_id),
      walletAddress: row.wallet_address,
      tokenAddress: row.token_address,
      symbol: row.symbol,
      decimals: row.decimals === null ? null : Number(row.decimals),
      expectedQuantity: String(row.expected_quantity),
      baselineQuantity: String(row.baseline_quantity),
      creditedQuantity: String(row.credited_quantity),
      expectedAmount: display(row.expected_quantity, row.decimals),
      creditedAmount: display(row.credited_quantity, row.decimals),
      fromAddress: row.from_address,
      status: row.status,
      booked: row.booked,
      amountUsd: row.amount_usd === null ? null : Number(row.amount_usd),
      memo: row.memo,
      requestedBy: row.requested_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      creditedAt: row.credited_at,
    };
  }
}

module.exports = { TreasuryDepositEngine, OPEN_STATUSES, display, unitsFromAmount };
