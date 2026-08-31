'use strict';

/**
 * Stablecoin payout rail — real USDC, or nothing.
 *
 * This is the rail behind Payer OS's `stablecoin_payout` disbursement type. It
 * exists because the trust has no fiat channel: no ODFI, no processor, and the
 * Melio portal is out. A token rail needs no bank, but it earns none of the
 * assumptions a bank rail gets, so the guards here are deliberate:
 *
 *   • The asset must be USDC issued by Circle. Stellar lets anybody issue an
 *     asset called "USDC", and one issued by us would be a look-alike nobody
 *     redeems. The issuer is pinned to Circle's published issuer for the
 *     network (overridable only by naming issuers explicitly), so a mistyped or
 *     home-made issuer is refused rather than paid.
 *   • Destinations are an allowlist. PAYER_OS_WALLETS names them, exactly like
 *     PAYER_OS_PAYEES names ACH accounts; an address never arrives as a
 *     parameter, and a wallet registered for one network cannot be paid on
 *     another.
 *   • The funding authority is the token position, not the cash ledger. USDC
 *     is not dollars in Trust Operating, so spendable is the distributor's
 *     actual on-chain trustline balance, read from Horizon, less what Payer OS
 *     already has in flight on this rail. A USDC payout can therefore never be
 *     authorized against 1010 cash.
 *   • Settlement is verified, not asserted. The transaction hash is looked up
 *     on Horizon and must be a successful payment of the right asset, amount
 *     and destination before anything posts. Shadow mode returns a fabricated
 *     hash, so shadow mode cannot originate at all.
 *   • Mainnet is armed deliberately, not by a typo. Pointing STABLECOIN_NETWORK
 *     at mainnet is a network setting, not authority to move real value, so
 *     origination there additionally requires STABLECOIN_MAINNET_AUTHORIZED and a
 *     per-push ceiling (PAYER_OS_MAX_AMOUNT_CENTS). Testnet needs neither.
 *   • Only the Stellar rail is implemented. The Circle App Kit and Hedera
 *     engines in this repo cannot report a USDC position or verify a hash the
 *     same way, and a payout that cannot be funded from a read balance or
 *     confirmed afterwards is refused rather than guessed at.
 */

const { getConfig } = require('../stablecoin/config');
const { BlockchainEngine } = require('../stablecoin/blockchainEngine');

/**
 * Circle's published USDC issuers, per
 * https://developers.circle.com/stablecoins/usdc-contract-addresses.
 */
const CIRCLE_USDC_ISSUERS = Object.freeze({
  public: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  testnet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
});

/** Networks this rail knows how to fund and verify. */
const STELLAR_NETWORKS = Object.freeze({
  mainnet: 'public',
  public: 'public',
  testnet: 'testnet',
});

const HORIZON_TIMEOUT_MS = 15_000;

class StablecoinRailError extends Error {
  constructor(message, code = 'STABLECOIN_RAIL_ERROR', status = 409) {
    super(message);
    this.name = 'StablecoinRailError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function str(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

/** A Stellar public key, checked by shape so no SDK is needed to reject junk. */
function isStellarAddress(value) {
  return /^G[A-Z2-7]{55}$/.test(str(value));
}

/**
 * Whose USDC this rail will send. Mainnet is Circle's issuer and nothing else:
 * real value leaves on that network, and an operator who can set an env var is
 * not an authority on what USDC is. Testnet may be pointed elsewhere, since
 * test assets are worth nothing and issuers there come and go.
 */
function trustedIssuers(network) {
  const pinned = CIRCLE_USDC_ISSUERS[network];
  const declared = str(process.env.STABLECOIN_TRUSTED_ISSUERS);
  if (declared && network !== 'public') {
    return declared.split(',').map(entry => str(entry)).filter(Boolean);
  }
  return pinned ? [pinned] : [];
}

function parseWallets() {
  const raw = str(process.env.PAYER_OS_WALLETS);
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StablecoinRailError(
      'PAYER_OS_WALLETS must be a valid JSON object keyed by payee name',
      'STABLECOIN_BAD_CONFIG',
      500
    );
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new StablecoinRailError(
      'PAYER_OS_WALLETS must be a valid JSON object keyed by payee name',
      'STABLECOIN_BAD_CONFIG',
      500
    );
  }
  return parsed;
}

/**
 * A registered wallet, as the trust wrote it down. The network and asset are
 * part of the registration: a wallet recorded for testnet USDC is not an
 * instruction to pay the same address on mainnet.
 */
function describeWallet(key, raw, cfg) {
  if (!raw || typeof raw !== 'object') {
    throw new StablecoinRailError(
      `Wallet "${key}" must be an object with name, address, network, asset and glAccountCode`,
      'STABLECOIN_BAD_WALLET',
      500
    );
  }
  const name = str(raw.name || raw.beneficiaryName);
  const address = str(raw.address || raw.wallet || raw.publicKey);
  const network = str(raw.network).toLowerCase();
  const asset = str(raw.asset || raw.assetCode).toUpperCase();
  const glAccountCode = str(raw.glAccountCode || raw.gl_account_code);

  if (!name) {
    throw new StablecoinRailError(
      `Wallet "${key}" needs the name of the party being paid`,
      'STABLECOIN_BAD_WALLET',
      500
    );
  }
  if (!isStellarAddress(address)) {
    throw new StablecoinRailError(
      `Wallet "${key}" needs a valid Stellar public key as its address`,
      'STABLECOIN_BAD_WALLET',
      500
    );
  }
  if (!STELLAR_NETWORKS[network]) {
    throw new StablecoinRailError(
      `Wallet "${key}" needs network "testnet" or "mainnet": a wallet with no network cannot be paid`,
      'STABLECOIN_BAD_WALLET',
      500
    );
  }
  if (asset !== 'USDC') {
    throw new StablecoinRailError(
      `Wallet "${key}" is registered for ${asset || 'no asset'}; this rail pays USDC only`,
      'STABLECOIN_BAD_WALLET',
      500
    );
  }
  if (!glAccountCode) {
    throw new StablecoinRailError(
      `Wallet "${key}" needs glAccountCode: the account this payout is charged to, or the debit has nowhere to land`,
      'STABLECOIN_BAD_WALLET',
      500
    );
  }
  if (cfg && STELLAR_NETWORKS[network] !== STELLAR_NETWORKS[cfg.network]) {
    throw new StablecoinRailError(
      `"${key}" is registered on ${network}, but this system is configured for ${cfg.network};`
      + ' paying it here would send real value on the wrong network',
      'STABLECOIN_WALLET_WRONG_NETWORK',
      409
    );
  }

  return {
    key,
    purpose: 'stablecoin_payout',
    label: str(raw.label) || name,
    name,
    address,
    addressLast4: address.slice(-4),
    network,
    asset,
    memo: str(raw.memo) || null,
    glAccountCode,
    email: str(raw.email) || null,
  };
}

async function horizon(cfg, path) {
  const base = str(cfg.horizonUrl).replace(/\/+$/, '');
  if (!base) {
    throw new StablecoinRailError('HORIZON_URL is not configured', 'STABLECOIN_NO_HORIZON', 503);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HORIZON_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}${path}`, { signal: controller.signal });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new StablecoinRailError(
        `Horizon returned ${response.status} for ${path}`,
        'STABLECOIN_HORIZON_ERROR',
        502
      );
    }
    return await response.json();
  } catch (error) {
    if (error instanceof StablecoinRailError) throw error;
    throw new StablecoinRailError(
      `Horizon at ${base} is unreachable: ${error.message}`,
      'STABLECOIN_HORIZON_UNREACHABLE',
      503
    );
  } finally {
    clearTimeout(timer);
  }
}

/** USDC carries seven decimals on Stellar; cents are what the ledger speaks. */
function unitsToCents(units) {
  const [whole, fraction = ''] = str(units || '0').split('.');
  const cents = BigInt(whole || '0') * 100n + BigInt(`${fraction}00`.slice(0, 2));
  return Number(cents);
}

function centsToUnits(cents) {
  const value = BigInt(Math.trunc(Number(cents)));
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

const StablecoinPayoutRail = {
  StablecoinRailError,
  CIRCLE_USDC_ISSUERS,

  config: getConfig,

  /** Every wallet the trust may credit. Addresses are shown truncated. */
  wallets() {
    const cfg = getConfig();
    return Object.entries(parseWallets())
      .map(([key, raw]) => describeWallet(str(key).toLowerCase(), raw, null))
      .filter(wallet => STELLAR_NETWORKS[wallet.network] === STELLAR_NETWORKS[cfg.network])
      .map(wallet => ({ ...wallet, address: `…${wallet.addressLast4}` }));
  },

  wallet(key) {
    const cfg = getConfig();
    const wanted = str(key).toLowerCase();
    if (!wanted) {
      throw new StablecoinRailError(
        'payee is required: a stablecoin push names a registered wallet, never an address',
        'STABLECOIN_WALLET_REQUIRED',
        400
      );
    }
    const registry = parseWallets();
    const match = registry[wanted]
      || registry[Object.keys(registry).find(entry => str(entry).toLowerCase() === wanted)];
    if (!match) {
      const known = Object.keys(registry);
      throw new StablecoinRailError(
        `"${wanted}" is not a registered wallet`
        + (known.length ? `; registered: ${known.join(', ')}` : '; PAYER_OS_WALLETS is empty')
        + '. This rail credits pre-registered wallets only.',
        'STABLECOIN_WALLET_UNKNOWN',
        409
      );
    }
    return describeWallet(wanted, match, cfg);
  },

  /**
   * Whether this rail could originate right now, and why not. The issuer check
   * is the important one: everything else is plumbing, but an unpinned issuer
   * means the "USDC" being sent may be somebody's home-made token.
   */
  async readiness() {
    const cfg = getConfig();
    const issues = [];
    const warnings = [];
    const network = STELLAR_NETWORKS[cfg.network] || null;

    if (!cfg.enabled) issues.push('STABLECOIN_ENABLED is not true');
    if (cfg.mode === 'disabled') issues.push('STABLECOIN_MODE is disabled');
    if (cfg.mode === 'shadow') {
      issues.push('STABLECOIN_MODE is shadow: settlement would be simulated, so origination is refused');
    }
    if (!network) {
      issues.push(
        `STABLECOIN_NETWORK is "${cfg.network}"; this rail funds and verifies the Stellar USDC rail only`
      );
    }
    if (cfg.assetCode !== 'USDC') {
      issues.push(`STABLECOIN_ASSET_CODE is ${cfg.assetCode}; this rail pays real USDC only`);
    }

    const trusted = network ? trustedIssuers(network) : [];
    if (!cfg.issuerPublic) {
      issues.push('STABLECOIN_ISSUER_PUBLIC is required: USDC must name the issuer it is redeemed against');
    } else if (trusted.length && !trusted.includes(cfg.issuerPublic)) {
      issues.push(
        `STABLECOIN_ISSUER_PUBLIC is not Circle's USDC issuer for ${network}`
        + ` (expected ${trusted.join(' or ')}); a look-alike asset would not be redeemable`
      );
    }
    if (str(process.env.STABLECOIN_TRUSTED_ISSUERS)) {
      warnings.push(network === 'public'
        ? 'STABLECOIN_TRUSTED_ISSUERS is ignored on mainnet: USDC there is Circle\'s issuer only'
        : `STABLECOIN_TRUSTED_ISSUERS overrides the pinned Circle issuer on ${network || 'this network'}`);
    }
    if (!cfg.distributorSecret) {
      issues.push('STABLECOIN_DISTRIBUTOR_SECRET is required to sign the payment');
    }
    if (!parseWallets() || !Object.keys(parseWallets()).length) {
      issues.push('PAYER_OS_WALLETS is empty: there is no registered wallet to credit');
    }

    // Real value leaves on mainnet, so the network setting alone does not arm
    // the rail: somebody has to say so, and say how large a single push may be.
    if (network === 'public') {
      if (!/^(1|true|yes|on)$/i.test(str(process.env.STABLECOIN_MAINNET_AUTHORIZED))) {
        issues.push(
          'STABLECOIN_MAINNET_AUTHORIZED is not set: mainnet moves redeemable USDC,'
          + ' so the rail stays closed until it is armed deliberately'
        );
      }
      if (!Number(str(process.env.PAYER_OS_MAX_AMOUNT_CENTS))) {
        issues.push(
          'PAYER_OS_MAX_AMOUNT_CENTS is not set: mainnet will not originate without'
          + ' a per-push ceiling to refuse against'
        );
      }
    }

    return {
      ready: issues.length === 0,
      issues,
      warnings,
      network: cfg.network,
      asset: cfg.assetCode,
      issuer: cfg.issuerPublic || null,
      trustedIssuers: trusted,
      horizonUrl: cfg.horizonUrl,
      distributorPublic: cfg.distributorPublic || null,
      walletCount: Object.keys(parseWallets()).length,
    };
  },

  /**
   * What the trust actually holds on this rail: the distributor's USDC
   * trustline balance, read from Horizon. There is no ledger opinion here on
   * purpose — the chain is the authority for a token position, exactly as the
   * bank is for cash.
   */
  async position() {
    const cfg = getConfig();
    const readiness = await this.readiness();
    const address = cfg.distributorPublic;
    if (!address) {
      throw new StablecoinRailError(
        'STABLECOIN_DISTRIBUTOR_PUBLIC is required to read the trust\'s USDC position',
        'STABLECOIN_NO_DISTRIBUTOR',
        503
      );
    }
    if (!cfg.issuerPublic) {
      throw new StablecoinRailError(
        'STABLECOIN_ISSUER_PUBLIC is required to read a USDC position',
        'STABLECOIN_NO_ISSUER',
        503
      );
    }

    const account = await horizon(cfg, `/accounts/${address}`);
    if (!account) {
      throw new StablecoinRailError(
        `The distributor account ${address} does not exist on ${cfg.network}, so it holds nothing`,
        'STABLECOIN_NO_ACCOUNT',
        409
      );
    }
    const line = (account.balances || []).find(balance => (
      balance.asset_code === cfg.assetCode && balance.asset_issuer === cfg.issuerPublic
    ));
    if (!line) {
      throw new StablecoinRailError(
        `${address} holds no ${cfg.assetCode} trustline for ${cfg.issuerPublic},`
        + ' so it cannot pay this asset',
        'STABLECOIN_NO_TRUSTLINE',
        409
      );
    }

    return {
      address,
      asset: cfg.assetCode,
      issuer: cfg.issuerPublic,
      network: cfg.network,
      balance: line.balance,
      availableCents: unitsToCents(line.balance),
      readiness,
    };
  },

  /**
   * Submit the payment. Refuses unless the rail is fully ready, so a shadow
   * hash can never be recorded as an origination.
   */
  async submit({ wallet, amountCents, memo = null } = {}) {
    const readiness = await this.readiness();
    if (!readiness.ready) {
      throw new StablecoinRailError(
        `The USDC rail cannot originate this payout: ${readiness.issues.join(' ')}`,
        'STABLECOIN_NOT_READY',
        503
      );
    }
    const target = wallet && wallet.address ? wallet : this.wallet(wallet);
    const result = await new BlockchainEngine().settle({
      destination: target.address,
      amountCents: Number(amountCents),
      memo: memo || target.memo || null,
    });
    if (!result || result.simulated || !result.hash) {
      throw new StablecoinRailError(
        'The USDC rail returned a simulated result, so nothing was originated',
        'STABLECOIN_SIMULATED',
        503
      );
    }
    return {
      reference: result.hash,
      explorer: result.explorer || null,
      ledger: result.ledger || null,
      amount: result.amount,
      wallet: { key: target.key, address: target.address, addressLast4: target.addressLast4 },
    };
  },

  /**
   * Confirm on-chain that this hash is the payment we think it is. A hash that
   * Horizon does not know, that failed, or that paid a different party, asset
   * or amount is not settlement.
   */
  async verify({ reference, wallet = null, amountCents = null } = {}) {
    const cfg = getConfig();
    const hash = str(reference);
    if (!hash) {
      throw new StablecoinRailError('A transaction hash is required', 'STABLECOIN_NO_REFERENCE', 400);
    }
    const transaction = await horizon(cfg, `/transactions/${hash}`);
    if (!transaction) {
      return { confirmed: false, reason: `Horizon does not know transaction ${hash}` };
    }
    if (transaction.successful === false) {
      return { confirmed: false, reason: `Transaction ${hash} failed on ${cfg.network}` };
    }

    const operations = await horizon(cfg, `/transactions/${hash}/operations?limit=200`);
    const records = (operations && operations._embedded && operations._embedded.records) || [];
    const payments = records.filter(record => record.type === 'payment');
    if (!payments.length) {
      return { confirmed: false, reason: `Transaction ${hash} carries no payment operation` };
    }

    const wantedAddress = wallet ? str(wallet.address || wallet) : null;
    const wantedUnits = amountCents === null ? null : centsToUnits(amountCents);
    const match = payments.find(payment => (
      payment.asset_code === cfg.assetCode
      && payment.asset_issuer === cfg.issuerPublic
      && (!wantedAddress || payment.to === wantedAddress)
      // Compared as a number, not by cents: USDC carries seven decimals, and a
      // payment of 0.345 is not a payment of 0.34 that happens to round down.
      && (wantedUnits === null || Number(payment.amount) === Number(wantedUnits))
    ));
    if (!match) {
      return {
        confirmed: false,
        reason: `Transaction ${hash} does not pay ${wantedUnits || 'the expected amount'} ${cfg.assetCode}`
          + (wantedAddress ? ` to …${wantedAddress.slice(-4)}` : ''),
      };
    }

    return {
      confirmed: true,
      ledger: transaction.ledger,
      createdAt: transaction.created_at,
      amountCents: unitsToCents(match.amount),
      to: match.to,
      asset: match.asset_code,
      issuer: match.asset_issuer,
    };
  },
};

module.exports = {
  StablecoinPayoutRail,
  StablecoinRailError,
  CIRCLE_USDC_ISSUERS,
  unitsToCents,
  centsToUnits,
};
