'use strict';

/**
 * Whether the trust can create or top up a Stellar account from value it already
 * holds, and by exactly how much.
 *
 * Two facts make this worth its own module. A Stellar account cannot be spent
 * down to zero: it must retain a base reserve plus half an XLM for every
 * subentry (each trustline, offer, signer), and a balance that looks like 1.6
 * XLM may be entirely reserve. And a non-existent destination is funded by a
 * different operation (createAccount) than an existing one (payment), with a
 * minimum starting balance the network enforces.
 *
 * So the decision is made here, from a Horizon account and an amount, and the
 * script only signs what this returns. Nothing here reads a key or submits a
 * transaction, which is what makes it testable without touching mainnet.
 */

/** Network base reserve, in XLM. */
const BASE_RESERVE = 0.5;
/** An account holds 2 base reserves, plus one per subentry. */
const BASE_ENTRIES = 2;
/** Left behind for the fees of the funding transaction and the ones after it. */
const FEE_HEADROOM = 0.1;
/** Base reserve (1) + one subentry for a USDC trustline (0.5) + fee headroom. */
const XLM_FOR_TRUSTLINE = 2;

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nativeBalance(account) {
  const balances = (account && account.balances) || [];
  const native = balances.find(balance => balance.asset_type === 'native');
  return toNumber(native && native.balance);
}

/** The reserve this account may never spend below, given its subentries. */
function reservedXlm(account) {
  const subentries = toNumber(account && account.subentry_count);
  return (BASE_ENTRIES + subentries) * BASE_RESERVE;
}

/**
 * What the account can actually send, keeping its reserve and fee headroom.
 * Never negative: an account can be below its own reserve after a fee change.
 */
function spendableXlm(account) {
  const spendable = nativeBalance(account) - reservedXlm(account) - FEE_HEADROOM;
  return spendable > 0 ? Number(spendable.toFixed(7)) : 0;
}

/**
 * Decide how to move `amount` XLM from `source` to a destination that may not
 * exist yet. Returns either `{ ok: false, reason }` — the honest refusal a
 * caller should print rather than submit — or the operation to sign.
 */
function planFunding({ source, destinationExists, amount = XLM_FOR_TRUSTLINE } = {}) {
  const wanted = toNumber(amount);
  if (wanted <= 0) {
    return { ok: false, reason: 'amount must be a positive number of XLM' };
  }
  if (!source) {
    return { ok: false, reason: 'the funding account does not exist on this network, so it holds nothing to send' };
  }
  if (!destinationExists && wanted < XLM_FOR_TRUSTLINE) {
    return {
      ok: false,
      reason: `${wanted} XLM creates an account that cannot then open a USDC trustline;`
        + ` send at least ${XLM_FOR_TRUSTLINE}`,
    };
  }

  const spendable = spendableXlm(source);
  if (spendable < wanted) {
    return {
      ok: false,
      reason: `the funding account holds ${nativeBalance(source)} XLM but can only send ${spendable}`
        + ` after its ${reservedXlm(source)} XLM reserve and fees: ${wanted} is not available`,
      spendable,
    };
  }

  return {
    ok: true,
    operation: destinationExists ? 'payment' : 'createAccount',
    amount: wanted.toFixed(7),
    spendable,
    reserved: reservedXlm(source),
  };
}

module.exports = {
  BASE_RESERVE,
  FEE_HEADROOM,
  XLM_FOR_TRUSTLINE,
  nativeBalance,
  reservedXlm,
  spendableXlm,
  planFunding,
};
