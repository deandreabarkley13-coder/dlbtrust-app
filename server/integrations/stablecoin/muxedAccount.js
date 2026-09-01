'use strict';

/**
 * Muxed accounts (SEP-0023, `M…`): one funded Stellar account carrying a 64-bit
 * subaccount id, so the trust can credit many beneficiaries without each of
 * them creating an account, funding a reserve and opening a USDC trustline.
 *
 * What this changes and what it does not:
 *   - the *base* account holds the XLM reserve, the trustline and the balance;
 *     a muxed address is a routing instruction, not a second account
 *   - the id identifies a payee within the base account's own books, which is
 *     why an exchange gives each customer one instead of a deposit memo
 *   - the trust must therefore treat the base account holder as the party it is
 *     actually paying, since it is the one who can spend the money
 *
 * Every function refuses rather than guesses: a mistyped `M…`, an id that is
 * not an unsigned 64-bit integer, or a base that is not a real Stellar account
 * throws instead of producing an address that would silently pay a stranger.
 */

let sdk = null;
try {
  // Optional for the same reason the settlement engine treats it as optional:
  // the app boots without it and simulates instead of pretending to pay.
  sdk = require('@stellar/stellar-sdk');
} catch {
  sdk = null;
}

function requireSdk() {
  if (!sdk) {
    throw new MuxedAddressError(
      '@stellar/stellar-sdk is not installed, so Stellar addresses cannot be decoded',
      'MUXED_SDK_MISSING',
      503
    );
  }
  return sdk;
}

class MuxedAddressError extends Error {
  constructor(message, code = 'MUXED_ADDRESS_INVALID', status = 400) {
    super(message);
    this.name = 'MuxedAddressError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

const MAX_MUXED_ID = 18_446_744_073_709_551_615n; // 2^64 - 1

function str(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

/**
 * Shape only, matching how the payout rail has always screened a `G…` address:
 * the strict decode happens where an address is turned into a transaction, and
 * the chain rejects a bad key there rather than sending value nowhere.
 */
function isBaseAddress(value) {
  return /^G[A-Z2-7]{55}$/.test(str(value));
}

/** Muxed addresses are decoded, not just shaped: the id lives inside the string. */
function isMuxedAddress(value) {
  const address = str(value);
  if (!/^M[A-Z2-7]{68}$/.test(address)) return false;
  return requireSdk().StrKey.isValidMed25519PublicKey(address);
}

/**
 * Normalise a subaccount id. Stellar's id is an unsigned 64-bit integer, so it
 * is carried as a decimal string: a JS number loses precision above 2^53 and
 * would quietly route a payment to the wrong payee.
 */
function normalizeId(id) {
  const raw = str(id);
  if (!raw) throw new MuxedAddressError('A muxed subaccount id is required');
  if (!/^\d+$/.test(raw)) {
    throw new MuxedAddressError(
      `Muxed id "${raw}" must be a whole number: Stellar carries it as an unsigned 64-bit integer`
    );
  }
  const value = BigInt(raw);
  if (value > MAX_MUXED_ID) {
    throw new MuxedAddressError(`Muxed id ${raw} exceeds the maximum ${MAX_MUXED_ID}`);
  }
  return value.toString();
}

/** Build the `M…` address that routes to `id` within `baseAddress`. */
function muxedAddress(baseAddress, id) {
  const base = str(baseAddress);
  if (!isBaseAddress(base)) {
    throw new MuxedAddressError(
      `"${base || 'nothing'}" is not a Stellar account address; a muxed address is built on a real G… account`
    );
  }
  const { MuxedAccount, Account } = requireSdk();
  return new MuxedAccount(new Account(base, '0'), normalizeId(id)).accountId();
}

/** Split an `M…` address back into the account that holds the money and the id. */
function parseMuxed(address) {
  const value = str(address);
  if (!isMuxedAddress(value)) {
    throw new MuxedAddressError(
      `"${value || 'nothing'}" is not a muxed address; a muxed address starts with M and is 69 characters`
    );
  }
  const parsed = requireSdk().MuxedAccount.fromAddress(value, '0');
  return { baseAddress: parsed.baseAccount().accountId(), id: normalizeId(parsed.id()) };
}

/**
 * Describe any Stellar destination uniformly, so callers can stop caring which
 * kind they were given: `baseAddress` is the account Horizon knows and where
 * the trustline and balance live, `address` is what a payment is addressed to.
 */
function describeAddress(address) {
  const value = str(address);
  if (isMuxedAddress(value)) {
    const { baseAddress, id } = parseMuxed(value);
    return { address: value, muxed: true, baseAddress, muxedId: id };
  }
  if (isBaseAddress(value)) {
    return { address: value, muxed: false, baseAddress: value, muxedId: null };
  }
  throw new MuxedAddressError(
    `"${value || 'nothing'}" is not a Stellar address: expected a G… account or an M… muxed address`
  );
}

/**
 * Whether a Horizon payment record credited this destination. Horizon reports a
 * muxed payment as `to` = the base account plus `to_muxed`/`to_muxed_id`, so a
 * naive `to === address` comparison reads a real muxed payment as unconfirmed.
 * A payment to the bare base account does *not* satisfy a muxed destination:
 * the money arrived at the right account credited to nobody in particular.
 */
function paymentCreditsAddress(payment, address) {
  if (!payment) return false;
  const wanted = describeAddress(address);
  const to = str(payment.to);
  if (!wanted.muxed) return to === wanted.baseAddress;
  if (str(payment.to_muxed) === wanted.address) return true;
  return to === wanted.baseAddress && str(payment.to_muxed_id) === wanted.muxedId;
}

module.exports = {
  MuxedAddressError,
  isBaseAddress,
  isMuxedAddress,
  muxedAddress,
  parseMuxed,
  describeAddress,
  paymentCreditsAddress,
  MAX_MUXED_ID,
};
