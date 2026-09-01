'use strict';

/**
 * Buying USDC on Stellar's own order books, with XLM the distributor already
 * holds.
 *
 * This is the only funding route with no venue and no fiat leg: the distributor
 * signs a path payment to itself, sending XLM and receiving an exact amount of
 * Circle's USDC at whatever price the network's order books offer. No account
 * anywhere else, no KYC, no bank.
 *
 * What it is not: a way to create value. It is an exchange of one asset the
 * trust owns for another, so it can only ever spend XLM that is already in the
 * distributor. If the trust holds no XLM, no code here can conjure the first
 * dollar — that is what an on-ramp or an exchange is for.
 *
 * Controls, because this signs a real transaction:
 *
 *   • Strict *receive*: the destination amount is exact, and `sendMax` bounds
 *     what the trust can pay for it. A thin order book therefore fails the
 *     transaction rather than quietly costing more.
 *   • The XLM reserve is respected: Stellar accounts are deleted if they fall
 *     below their base reserve, and the distributor also needs fees, so a swap
 *     that would eat the reserve is refused.
 *   • The asset bought is whatever the payout rail is pinned to — Circle's USDC
 *     for the configured network — so this cannot accidentally buy a look-alike
 *     asset from a different issuer.
 */

const { getConfig } = require('./config');
const { StablecoinPayoutRail } = require('../os/stablecoinPayoutRail');

class StellarDexError extends Error {
  constructor(message, code = 'STELLAR_DEX_ERROR', status = 409) {
    super(message);
    this.name = 'StellarDexError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function text(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === null ? fallback : String(value).trim();
}

function swapConfig() {
  return {
    // XLM the distributor must keep: base reserve, trustline reserves, and fees.
    reserveXlm: Number(text('STABLECOIN_DEX_XLM_RESERVE', '3')) || 0,
    maxSlippageBps: Number(text('STABLECOIN_DEX_MAX_SLIPPAGE_BPS', '200')) || 0,
  };
}

function sdk() {
  try {
    return require('@stellar/stellar-sdk');
  } catch (err) {
    throw new StellarDexError(
      '@stellar/stellar-sdk is not installed, so no swap can be signed',
      'STELLAR_DEX_NO_SDK',
      503
    );
  }
}

function passphraseFor(stellar, network) {
  const configured = text('STELLAR_NETWORK_PASSPHRASE');
  if (configured) return configured;
  const name = String(network || '').toLowerCase();
  if (name === 'mainnet' || name === 'public') return stellar.Networks.PUBLIC;
  if (name === 'testnet') return stellar.Networks.TESTNET;
  throw new StellarDexError(
    `Stellar network ${network || '(unset)'} has no known passphrase; set STELLAR_NETWORK_PASSPHRASE`,
    'STELLAR_DEX_UNKNOWN_NETWORK',
    400
  );
}

const StellarDexSwap = {
  StellarDexError,
  config: swapConfig,

  /** The rail's asset, its Horizon, and a keypair that can sign for it. */
  async _context({ needsSecret = false } = {}) {
    const stellar = sdk();
    const cfg = getConfig();
    const readiness = await StablecoinPayoutRail.readiness();
    if (!readiness.issuer || !readiness.asset) {
      throw new StellarDexError(
        'No USDC issuer is configured, so there is nothing to buy',
        'STELLAR_DEX_NO_ASSET',
        503
      );
    }
    if (!readiness.horizonUrl) {
      throw new StellarDexError('No Horizon URL is configured', 'STELLAR_DEX_NO_HORIZON', 503);
    }
    if (!cfg.distributorPublic) {
      throw new StellarDexError(
        'STABLECOIN_DISTRIBUTOR_PUBLIC is not set, so there is no account to swap from',
        'STELLAR_DEX_NO_DISTRIBUTOR',
        503
      );
    }
    if (needsSecret && !cfg.distributorSecret) {
      throw new StellarDexError(
        'STABLECOIN_DISTRIBUTOR_SECRET is required to sign the swap',
        'STELLAR_DEX_NO_SECRET',
        503
      );
    }
    return {
      stellar,
      cfg,
      readiness,
      server: new stellar.Horizon.Server(readiness.horizonUrl),
      asset: new stellar.Asset(readiness.asset, readiness.issuer),
      distributor: cfg.distributorPublic,
    };
  },

  readiness() {
    const cfg = getConfig();
    const swap = swapConfig();
    const issues = [];
    if (!cfg.distributorPublic) issues.push('STABLECOIN_DISTRIBUTOR_PUBLIC is not set');
    if (!cfg.distributorSecret) issues.push('STABLECOIN_DISTRIBUTOR_SECRET is required to sign the swap');
    if (!cfg.issuerPublic) issues.push('STABLECOIN_ISSUER_PUBLIC is not set');
    if (!swap.maxSlippageBps) {
      issues.push('STABLECOIN_DEX_MAX_SLIPPAGE_BPS must be a positive number of basis points');
    }
    return { ready: issues.length === 0, issues, reserveXlm: swap.reserveXlm, maxSlippageBps: swap.maxSlippageBps };
  },

  /** The distributor's XLM, and what of it is spendable after the reserve. */
  async xlmPosition() {
    const { server, distributor } = await this._context();
    const swap = swapConfig();
    const account = await server.loadAccount(distributor).catch((err) => {
      throw new StellarDexError(
        `Distributor ${distributor} was not found on this network: ${err.message}`,
        'STELLAR_DEX_NO_ACCOUNT',
        503
      );
    });
    const native = (account.balances || []).find(b => b.asset_type === 'native');
    const balance = Number((native && native.balance) || 0);
    return {
      address: distributor,
      xlmBalance: balance,
      reserveXlm: swap.reserveXlm,
      spendableXlm: Math.max(0, balance - swap.reserveXlm),
    };
  },

  /**
   * What the order books would charge, right now, for an exact amount of USDC.
   * Reads only; a quote is not a commitment and is re-taken before signing.
   */
  async quote({ amountCents } = {}) {
    const cents = Number(amountCents);
    if (!Number.isInteger(cents) || cents <= 0) {
      throw new StellarDexError(
        'amountCents must be a positive whole number of cents',
        'STELLAR_DEX_BAD_AMOUNT',
        400
      );
    }
    const { stellar, server, asset, readiness } = await this._context();
    const swap = swapConfig();
    const destAmount = (cents / 100).toFixed(7);

    const paths = await server
      .strictReceivePaths([stellar.Asset.native()], asset, destAmount)
      .call();
    const best = (paths.records || [])[0];
    if (!best) {
      throw new StellarDexError(
        `No Stellar order book path from XLM to ${readiness.asset} for ${destAmount};`
        + ' the books are too thin for this size right now',
        'STELLAR_DEX_NO_PATH',
        503
      );
    }

    const sendAmount = Number(best.source_amount);
    const sendMax = (sendAmount * (1 + swap.maxSlippageBps / 10000)).toFixed(7);
    const position = await this.xlmPosition();
    return {
      amountCents: cents,
      destAmount,
      asset: readiness.asset,
      issuer: readiness.issuer,
      network: readiness.network,
      sendAssetCode: 'XLM',
      sendAmount: sendAmount.toFixed(7),
      sendMax,
      maxSlippageBps: swap.maxSlippageBps,
      path: (best.path || []).map(hop => (hop.asset_type === 'native'
        ? { code: 'XLM', issuer: null }
        : { code: hop.asset_code, issuer: hop.asset_issuer })),
      xlmBalance: position.xlmBalance.toFixed(7),
      spendableXlm: position.spendableXlm.toFixed(7),
      reserveXlm: position.reserveXlm,
      affordable: position.spendableXlm >= Number(sendMax),
      pricePerUsdc: (sendAmount / (cents / 100)).toFixed(7),
    };
  },

  /**
   * Sign and submit the swap. Strict receive, so the distributor gets exactly
   * `amountCents` of USDC or the transaction fails.
   */
  async swap({ amountCents } = {}) {
    const quote = await this.quote({ amountCents });
    if (!quote.affordable) {
      throw new StellarDexError(
        `The swap needs up to ${quote.sendMax} XLM but only ${quote.spendableXlm} is spendable`
        + ` (${quote.reserveXlm} XLM is held back for reserves and fees)`,
        'STELLAR_DEX_INSUFFICIENT_XLM',
        409
      );
    }

    const { stellar, cfg, server, asset, readiness } = await this._context({ needsSecret: true });
    const keypair = stellar.Keypair.fromSecret(cfg.distributorSecret);
    if (keypair.publicKey() !== cfg.distributorPublic) {
      throw new StellarDexError(
        'STABLECOIN_DISTRIBUTOR_SECRET does not belong to STABLECOIN_DISTRIBUTOR_PUBLIC',
        'STELLAR_DEX_KEY_MISMATCH',
        400
      );
    }

    const account = await server.loadAccount(keypair.publicKey());
    const transaction = new stellar.TransactionBuilder(account, {
      fee: stellar.BASE_FEE,
      networkPassphrase: passphraseFor(stellar, readiness.network),
    })
      .addOperation(stellar.Operation.pathPaymentStrictReceive({
        sendAsset: stellar.Asset.native(),
        sendMax: quote.sendMax,
        destination: keypair.publicKey(),
        destAsset: asset,
        destAmount: quote.destAmount,
        path: quote.path.map(hop => (hop.issuer ? new stellar.Asset(hop.code, hop.issuer) : stellar.Asset.native())),
      }))
      .setTimeout(90)
      .build();
    transaction.sign(keypair);

    const submitted = await server.submitTransaction(transaction);
    return {
      hash: submitted.hash,
      quote,
      ledger: submitted.ledger || null,
      successful: submitted.successful !== false,
    };
  },
};

module.exports = { StellarDexSwap, StellarDexError };
