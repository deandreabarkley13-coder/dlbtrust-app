'use strict';

/**
 * Beneficiary expense wallets — one thirdweb server wallet per beneficiary and
 * expense purpose (lifestyle, medical, travel, home, education), funded from a
 * trust hold account.
 *
 * A wallet is derived from a deterministic identifier
 * (`<prefix>-<beneficiary>-<purpose>`, e.g. `dlbt-exp-jane-doe-medical`), so
 * provisioning is idempotent and never rotates an address. Creating a wallet
 * holds no funds and broadcasts nothing.
 *
 * Funding is two legs that must agree:
 *
 *   fiat leg   the hold account is checked through SourceOfFundsAdapter and
 *              swept into the stablecoin treasury, then a double-entry journal
 *              records the beneficiary obligation.
 *   value leg  ThirdwebServerWalletEngine.send moves the token quantity the
 *              oracle prices at the requested USD amount from the trust's
 *              treasury server wallet to the expense wallet.
 *
 * Both legs are gated by THIRDWEB_SERVER_WALLET_LIVE. While it is false the
 * call returns the full plan — resolved wallet, hold-account position, token
 * quantity, policy decision — and neither the ledger nor the chain is touched.
 */

const DistributionPolicy = require('./distributionPolicy');
const { ThirdwebPriceOracle } = require('./thirdwebPriceOracle');
const { ThirdwebServerWalletEngine } = require('./thirdwebServerWalletEngine');
const { SourceOfFundsAdapter } = require('../stablecoin/sourceOfFundsAdapter');

let TrustAccountingEngine = null;
try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { /* optional */ }

// Loaded on demand: it pulls the whole wallet stack in for its chart of accounts.
function getWalletFundingEngine() {
  try { return require('./walletFundingEngine').WalletFundingEngine; } catch (e) { return null; }
}

let pool = null;
try { pool = require('../bonds/pgPool'); } catch (e) { /* no DB in tests */ }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

const DEFAULT_IDENTIFIER_PREFIX = 'dlbt-exp';
const WALLET_FUNDS_CODE = 'WALLET-FUNDS';
const WALLET_ALLOCATIONS_CODE = 'WALLET-ALLOCATIONS';

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function toCents(usd) { return Math.round(Number(usd) * 100); }
function fromCents(cents) { return (Number(cents) || 0) / 100; }
function id(prefix = 'BEW') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

/** Beneficiary key used in wallet identifiers: lowercase, hyphenated, no domain. */
function slug(beneficiary) {
  const text = String(beneficiary || '').trim().toLowerCase().split('@')[0];
  const cleaned = text.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned) throw Object.assign(new Error('beneficiary required'), { status: 422 });
  return cleaned;
}

let tablesReady = null;
async function ensureTables() {
  if (!pool || !pool.query) return;
  if (tablesReady) return tablesReady;
  tablesReady = pool.query(`
    CREATE TABLE IF NOT EXISTS beneficiary_expense_wallets (
      identifier TEXT PRIMARY KEY,
      beneficiary TEXT NOT NULL,
      beneficiary_key TEXT NOT NULL,
      purpose TEXT NOT NULL,
      address TEXT NOT NULL,
      smart_account_address TEXT,
      chain_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (beneficiary_key, purpose)
    )
  `).then(() => pool.query(`
    CREATE TABLE IF NOT EXISTS beneficiary_expense_wallet_fundings (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      beneficiary_key TEXT NOT NULL,
      purpose TEXT NOT NULL,
      requester_role TEXT NOT NULL,
      amount_usd NUMERIC NOT NULL,
      source_type TEXT NOT NULL,
      source_account_id TEXT,
      chain_id INTEGER NOT NULL,
      token_address TEXT,
      quantity NUMERIC NOT NULL,
      shadow BOOLEAN NOT NULL,
      transfer_id TEXT,
      swept_cents BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)).catch((e) => { tablesReady = null; throw e; });
  return tablesReady;
}

const memoryWallets = new Map();
const memoryFundings = [];

class BeneficiaryExpenseWalletEngine {
  static getConfig() {
    const wallet = ThirdwebServerWalletEngine.getConfig();
    return {
      identifierPrefix: str('EXPENSE_WALLET_IDENTIFIER_PREFIX', DEFAULT_IDENTIFIER_PREFIX),
      purposes: DistributionPolicy.getPolicy().purposes,
      chainId: wallet.chainId,
      tokenAddress: str('EXPENSE_WALLET_TOKEN_ADDRESS') || null,
      // Hold account the distributions are funded from.
      holdSourceType: str('EXPENSE_WALLET_HOLD_SOURCE_TYPE', 'trust'),
      holdSourceAccountId: str('EXPENSE_WALLET_HOLD_ACCOUNT_ID') || null,
      live: wallet.live,
    };
  }

  static identifierFor(beneficiary, purpose) {
    const cfg = this.getConfig();
    const p = DistributionPolicy.normalizePurpose(purpose, { required: true });
    return `${cfg.identifierPrefix}-${slug(beneficiary)}-${p}`;
  }

  static readiness() {
    const cfg = this.getConfig();
    const wallet = ThirdwebServerWalletEngine.readiness();
    const issues = [...wallet.issues];
    if (!cfg.holdSourceAccountId) issues.push('EXPENSE_WALLET_HOLD_ACCOUNT_ID not configured (pass sourceAccountId per request)');
    return {
      provider: 'beneficiary-expense-wallets',
      identifierPrefix: cfg.identifierPrefix,
      purposes: cfg.purposes,
      chainId: cfg.chainId,
      tokenAddress: cfg.tokenAddress,
      holdSourceType: cfg.holdSourceType,
      holdSourceAccountId: cfg.holdSourceAccountId,
      treasuryWallet: wallet.address,
      live: cfg.live,
      shadow: !cfg.live,
      canFund: wallet.canSend,
      ready: wallet.ready,
      issues,
    };
  }

  static async _persistWallet(record) {
    if (!pool || !pool.query) {
      memoryWallets.set(record.identifier, record);
      return record;
    }
    await ensureTables();
    await pool.query(
      `INSERT INTO beneficiary_expense_wallets
         (identifier, beneficiary, beneficiary_key, purpose, address, smart_account_address, chain_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (identifier) DO UPDATE SET address = EXCLUDED.address,
         smart_account_address = EXCLUDED.smart_account_address, chain_id = EXCLUDED.chain_id`,
      [record.identifier, record.beneficiary, record.beneficiaryKey, record.purpose,
        record.address, record.smartAccountAddress, record.chainId]
    );
    return record;
  }

  /** Create-or-fetch the wallet for one beneficiary/purpose pair. */
  static async ensureWallet({ beneficiary, purpose } = {}) {
    const cfg = this.getConfig();
    const identifier = this.identifierFor(beneficiary, purpose);
    const wallet = await ThirdwebServerWalletEngine.ensureWallet(identifier);
    return this._persistWallet({
      identifier,
      beneficiary: String(beneficiary).trim(),
      beneficiaryKey: slug(beneficiary),
      purpose: DistributionPolicy.normalizePurpose(purpose, { required: true }),
      address: wallet.address,
      smartAccountAddress: wallet.smartAccountAddress,
      chainId: cfg.chainId,
      createdAt: wallet.createdAt,
    });
  }

  /** One wallet per permitted expense purpose for a beneficiary. */
  static async ensureWallets({ beneficiary, purposes } = {}) {
    const wanted = (purposes && purposes.length ? purposes : this.getConfig().purposes)
      .map((p) => DistributionPolicy.normalizePurpose(p, { required: true }));
    const wallets = [];
    for (const purpose of wanted) {
      wallets.push(await this.ensureWallet({ beneficiary, purpose }));
    }
    return { beneficiary: String(beneficiary).trim(), beneficiaryKey: slug(beneficiary), wallets };
  }

  static async listWallets({ beneficiary } = {}) {
    const key = beneficiary ? slug(beneficiary) : null;
    if (!pool || !pool.query) {
      return [...memoryWallets.values()].filter((w) => !key || w.beneficiaryKey === key);
    }
    await ensureTables();
    const { rows } = await pool.query(
      `SELECT identifier, beneficiary, beneficiary_key, purpose, address, smart_account_address, chain_id, created_at
         FROM beneficiary_expense_wallets
        WHERE ($1::text IS NULL OR beneficiary_key = $1)
        ORDER BY beneficiary_key, purpose`,
      [key]
    );
    return rows.map((r) => ({
      identifier: r.identifier,
      beneficiary: r.beneficiary,
      beneficiaryKey: r.beneficiary_key,
      purpose: r.purpose,
      address: r.address,
      smartAccountAddress: r.smart_account_address,
      chainId: Number(r.chain_id),
      createdAt: r.created_at,
    }));
  }

  static async balances({ beneficiary, tokenAddress, chainId } = {}) {
    const cfg = this.getConfig();
    const wallets = await this.listWallets({ beneficiary });
    const token = tokenAddress === undefined ? cfg.tokenAddress : tokenAddress;
    const out = [];
    for (const wallet of wallets) {
      try {
        out.push({
          ...wallet,
          balances: await ThirdwebServerWalletEngine.balance({
            address: wallet.address,
            chainId: chainId || wallet.chainId,
            tokenAddress: token,
          }),
        });
      } catch (e) {
        out.push({ ...wallet, balances: [], error: e.message });
      }
    }
    return out;
  }

  /** Hold-account position backing a distribution, with the USD shortfall check. */
  static async _holdPosition({ sourceType, sourceAccountId, amountUsd }) {
    const position = await SourceOfFundsAdapter.getPosition({ sourceType, sourceAccountId, purpose: 'payment' });
    const availableCents = Number(position.availableBalanceCents || 0);
    const neededCents = toCents(amountUsd);
    if (!position.fundingEligible) {
      throw Object.assign(
        new Error(`hold account ${sourceType}:${sourceAccountId} is not eligible to fund distributions (${position.segregationReason || 'restricted'})`),
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

  static async _recordFunding(record) {
    if (!pool || !pool.query) {
      memoryFundings.unshift(record);
      return record;
    }
    await ensureTables();
    await pool.query(
      `INSERT INTO beneficiary_expense_wallet_fundings
         (id, identifier, beneficiary_key, purpose, requester_role, amount_usd, source_type,
          source_account_id, chain_id, token_address, quantity, shadow, transfer_id, swept_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [record.id, record.identifier, record.beneficiaryKey, record.purpose, record.requesterRole,
        record.amountUsd, record.sourceType, record.sourceAccountId, record.chainId,
        record.tokenAddress, record.quantity, record.shadow, record.transferId, record.sweptCents]
    );
    return record;
  }

  static async _postJournal({ identifier, amountUsd, purpose, fundingId }) {
    if (!TrustAccountingEngine) return null;
    const walletFunding = getWalletFundingEngine();
    if (walletFunding) await walletFunding.ensureAccounts();
    return TrustAccountingEngine.postJournalEntry({
      entryDate: new Date(),
      description: `Fund ${purpose} expense wallet ${identifier} from trust hold account`,
      referenceType: 'expense_wallet_funding',
      referenceId: fundingId,
      postedBy: 'beneficiary-expense-wallet-engine',
      postToFineract: false,
      lines: [
        { accountCode: WALLET_FUNDS_CODE, debitAmount: amountUsd, creditAmount: 0, memo: identifier },
        { accountCode: WALLET_ALLOCATIONS_CODE, debitAmount: 0, creditAmount: amountUsd, memo: `Obligation for ${identifier}` },
      ],
    });
  }

  /**
   * Move `amountUsd` of trust value from a hold account into a beneficiary's
   * expense wallet. Shadow unless THIRDWEB_SERVER_WALLET_LIVE=true, in which
   * case the hold account is swept, the journal is posted, and the token
   * transfer is submitted to thirdweb.
   */
  static async fund({
    beneficiary, purpose, amountUsd, requesterRole = 'beneficiary',
    sourceType, sourceAccountId, tokenAddress, chainId, memo = null,
  } = {}) {
    const cfg = this.getConfig();
    const policy = DistributionPolicy.enforce({ requesterRole, amountUsd, purpose, purposeRequired: true });
    const source = {
      sourceType: sourceType || cfg.holdSourceType,
      sourceAccountId: sourceAccountId || cfg.holdSourceAccountId,
    };
    if (!source.sourceAccountId) {
      throw Object.assign(new Error('sourceAccountId required (or set EXPENSE_WALLET_HOLD_ACCOUNT_ID)'), { status: 422 });
    }

    const wallet = await this.ensureWallet({ beneficiary, purpose: policy.purpose });
    const chain = Number(chainId || wallet.chainId || cfg.chainId);
    const token = tokenAddress === undefined ? cfg.tokenAddress : tokenAddress;
    const hold = await this._holdPosition({ ...source, amountUsd: policy.amountUsd });
    const quote = await ThirdwebPriceOracle.quantityForUsd({ chainId: chain, tokenAddress: token, amountUsd: policy.amountUsd });

    const fundingId = id();
    let sweptCents = 0;
    if (cfg.live) {
      await SourceOfFundsAdapter._fundSourceToTreasury({
        ...source,
        paymentId: fundingId,
        amountCents: hold.neededCents,
      });
      sweptCents = hold.neededCents;
    }

    let transfer;
    try {
      transfer = await ThirdwebServerWalletEngine.send({
        to: wallet.address,
        quantity: quote.quantity,
        tokenAddress: token,
        chainId: chain,
        amountUsd: policy.amountUsd,
        purpose: policy.purpose,
        requesterRole: policy.requesterRole,
        reference: fundingId,
        memo: memo || `${policy.purpose} expense wallet funding for ${wallet.beneficiary}`,
      });
    } catch (err) {
      if (sweptCents > 0) {
        await SourceOfFundsAdapter._reverseSourceOnly({
          ...source, amountCents: sweptCents, paymentId: fundingId, sourceRef: null,
        }).catch((e) => console.warn('[BeneficiaryExpenseWalletEngine] hold reversal failed:', e.message));
      }
      throw err;
    }

    const record = {
      id: fundingId,
      identifier: wallet.identifier,
      beneficiary: wallet.beneficiary,
      beneficiaryKey: wallet.beneficiaryKey,
      purpose: policy.purpose,
      requesterRole: policy.requesterRole,
      limitUsd: policy.limitUsd,
      amountUsd: policy.amountUsd,
      sourceType: source.sourceType,
      sourceAccountId: source.sourceAccountId,
      sourceAvailableUsd: fromCents(hold.availableCents),
      chainId: chain,
      tokenAddress: token,
      asset: token ? 'erc20' : 'native',
      symbol: quote.symbol,
      priceUsd: quote.priceUsd,
      quantity: quote.quantity,
      address: wallet.address,
      shadow: transfer.shadow,
      transferId: transfer.id,
      transactionId: transfer.transactionId,
      sweptCents,
      reason: transfer.reason || null,
    };
    await this._recordFunding(record);
    if (!transfer.shadow) {
      await this._postJournal({
        identifier: wallet.identifier, amountUsd: policy.amountUsd, purpose: policy.purpose, fundingId,
      }).catch((e) => console.warn('[BeneficiaryExpenseWalletEngine] journal entry failed:', e.message));
    }
    return record;
  }

  static async recentFundings(limit = 20) {
    const max = Math.min(Math.max(Number(limit) || 20, 1), 200);
    if (!pool || !pool.query) return memoryFundings.slice(0, max);
    await ensureTables();
    const { rows } = await pool.query(
      `SELECT id, identifier, beneficiary_key, purpose, requester_role, amount_usd::float8 AS amount_usd,
              source_type, source_account_id, chain_id, token_address, quantity, shadow, transfer_id,
              swept_cents, created_at
         FROM beneficiary_expense_wallet_fundings ORDER BY created_at DESC LIMIT $1`,
      [max]
    );
    return rows.map((r) => ({
      id: r.id,
      identifier: r.identifier,
      beneficiaryKey: r.beneficiary_key,
      purpose: r.purpose,
      requesterRole: r.requester_role,
      amountUsd: r.amount_usd,
      sourceType: r.source_type,
      sourceAccountId: r.source_account_id,
      chainId: Number(r.chain_id),
      tokenAddress: r.token_address,
      quantity: r.quantity,
      shadow: r.shadow,
      transferId: r.transfer_id,
      sweptUsd: fromCents(Number(r.swept_cents || 0)),
      createdAt: r.created_at,
    }));
  }
}

module.exports = { BeneficiaryExpenseWalletEngine, DEFAULT_IDENTIFIER_PREFIX };
