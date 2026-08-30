'use strict';

/**
 * Wire transmission state machine
 *
 * A wire that has left the building cannot be un-sent, and the difference
 * between "we wrote a file" and "the bank owes us money movement" is exactly
 * the difference between two of these states. So the transitions are declared
 * once, here, and every write to `ihb_wire_transmissions` goes through
 * `assertTransition`. Nothing in the engine sets a status by hand.
 *
 * The states, in the order a healthy wire walks them:
 *
 *   prepared     the pacs.008 has been rendered and hashed; nothing has left
 *   reserved     the idempotency vault has granted this process the right to
 *                transmit this payment, exactly once
 *   transmitting the file is being written to the bank's staging name
 *   transmitted  the rename landed: the bank now has a complete file and this
 *                is the point of no return
 *   acknowledged the bank's ACK names our file and accepts it
 *   settled      the bank confirms the funds moved, with its reference
 *   returned     the beneficiary side sent it back; the ledger must reverse
 *   rejected     the bank refused the file or the payment before settlement
 *   failed       the transmission itself failed before the bank had the file
 *
 * Two rules are worth stating out loud because they are the ones that protect
 * money rather than tidiness:
 *
 *   • `transmitted` may never go back to `failed`. Once the bank can see a
 *     complete file, a local error is a reconciliation exception, not a
 *     failure, because the wire may well be executing. Losing that distinction
 *     is how a payment gets sent twice.
 *   • `settled` and `returned` are terminal-with-one-exception: a settled wire
 *     may still be `returned`, because a genuine return arrives days later and
 *     must reverse the ledger. Nothing else may leave a terminal state.
 */

const TRANSITIONS = Object.freeze({
  prepared: ['reserved', 'rejected', 'failed'],
  reserved: ['transmitting', 'rejected', 'failed'],
  transmitting: ['transmitted', 'failed'],
  transmitted: ['acknowledged', 'settled', 'returned', 'rejected'],
  acknowledged: ['settled', 'returned', 'rejected'],
  settled: ['returned'],
  returned: [],
  rejected: [],
  failed: ['prepared', 'reserved'],
});

const WIRE_STATES = Object.freeze(Object.keys(TRANSITIONS));

/** States in which the bank is known to hold a complete copy of the file. */
const BANK_HAS_FILE = Object.freeze(['transmitted', 'acknowledged', 'settled', 'returned', 'rejected']);

/** States that will never move again on their own. */
const TERMINAL = Object.freeze(['returned', 'rejected']);

class WireStateError extends Error {
  constructor(message, code = 'WIRE_H2H_ILLEGAL_TRANSITION', status = 409) {
    super(message);
    this.name = 'WireStateError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function isWireState(state) {
  return Object.prototype.hasOwnProperty.call(TRANSITIONS, state);
}

function canTransition(from, to) {
  if (!isWireState(from) || !isWireState(to)) return false;
  return TRANSITIONS[from].includes(to);
}

/**
 * Throw unless `from -> to` is legal. Re-entering the same state is allowed and
 * reported as a no-op, so that replaying an advice the bank sent twice does not
 * blow up — it simply changes nothing.
 */
function assertTransition(from, to, context = {}) {
  if (!isWireState(to)) {
    throw new WireStateError(`${to} is not a wire transmission state`, 'WIRE_H2H_UNKNOWN_STATE', 400);
  }
  if (from === to) return { changed: false, from, to };
  if (!isWireState(from)) {
    throw new WireStateError(`${from} is not a wire transmission state`, 'WIRE_H2H_UNKNOWN_STATE', 400);
  }
  if (!canTransition(from, to)) {
    const where = context.transmissionId ? ` for ${context.transmissionId}` : '';
    throw new WireStateError(
      `A wire${where} cannot go from ${from} to ${to}; legal next states are ${TRANSITIONS[from].join(', ') || 'none'}`
    );
  }
  return { changed: true, from, to };
}

function bankHoldsFile(state) {
  return BANK_HAS_FILE.includes(state);
}

function isTerminal(state) {
  return TERMINAL.includes(state);
}

/** The in-house-bank payment outcome implied by a terminal wire state. */
function paymentOutcomeFor(state) {
  if (state === 'settled') return 'settled';
  if (state === 'returned') return 'returned';
  if (state === 'rejected' || state === 'failed') return 'failed';
  return null;
}

module.exports = {
  TRANSITIONS,
  WIRE_STATES,
  WireStateError,
  isWireState,
  canTransition,
  assertTransition,
  bankHoldsFile,
  isTerminal,
  paymentOutcomeFor,
};
