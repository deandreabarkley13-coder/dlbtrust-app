'use strict';

/**
 * Decimal-string money helpers for the Treasury Prime rails.
 *
 * Treasury Prime represents every monetary value as a decimal STRING
 * ("250.00"), unlike Stripe and the internal cash ledger which use integer
 * minor units. This module keeps Treasury Prime amounts in their native
 * string form end to end: nothing here ever produces a JavaScript float, so
 * amounts survive the round trip API -> Postgres NUMERIC -> API unchanged.
 *
 * Arithmetic is done in BigInt minor units internally and immediately
 * formatted back to a decimal string, which is exact for any value the API
 * accepts.
 */

const AMOUNT_RE = /^-?\d+(\.\d{1,2})?$/;

function isValidAmount(value) {
  return typeof value === 'string' && AMOUNT_RE.test(value.trim());
}

/**
 * Validate and canonicalize an amount to exactly two decimal places.
 * Accepts a string, or a number/BigInt for callers bridging from other rails.
 */
function normalizeAmount(value, label = 'amount') {
  if (value === null || value === undefined || value === '') {
    throw new Error(`${label} is required as a decimal string, e.g. "250.00"`);
  }
  const raw = typeof value === 'string' ? value.trim() : String(value);
  if (!AMOUNT_RE.test(raw)) {
    throw new Error(`${label} must be a decimal string with at most 2 decimal places, e.g. "250.00" (got "${raw}")`);
  }
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction = ''] = unsigned.split('.');
  const cents = `${fraction}00`.slice(0, 2);
  return `${negative ? '-' : ''}${whole}.${cents}`;
}

/** Decimal string -> BigInt minor units. Exact, no float involved. */
function toMinorUnits(value, label = 'amount') {
  const normalized = normalizeAmount(value, label);
  return BigInt(normalized.replace('.', ''));
}

/** BigInt minor units -> decimal string. */
function fromMinorUnits(minor) {
  const negative = minor < 0n;
  const abs = (negative ? -minor : minor).toString().padStart(3, '0');
  const whole = abs.slice(0, -2);
  const cents = abs.slice(-2);
  return `${negative ? '-' : ''}${whole}.${cents}`;
}

function addAmounts(a, b) {
  return fromMinorUnits(toMinorUnits(a) + toMinorUnits(b));
}

function subtractAmounts(a, b) {
  return fromMinorUnits(toMinorUnits(a) - toMinorUnits(b));
}

/** -1, 0 or 1 — use instead of comparing decimal strings lexically. */
function compareAmounts(a, b) {
  const left = toMinorUnits(a);
  const right = toMinorUnits(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isPositiveAmount(value) {
  return toMinorUnits(value) > 0n;
}

function isZeroAmount(value) {
  return toMinorUnits(value) === 0n;
}

function negateAmount(value) {
  return fromMinorUnits(-toMinorUnits(value));
}

function absAmount(value) {
  const minor = toMinorUnits(value);
  return fromMinorUnits(minor < 0n ? -minor : minor);
}

/**
 * Coerce whatever the API (or Postgres NUMERIC) handed back into a decimal
 * string, returning null when there is no value. Never throws — use for
 * read paths where a malformed upstream value must not break a listing.
 */
function coerceAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  // Postgres NUMERIC can come back with extra scale ("250.0000"); drop trailing
  // zeros past the cent so the canonical two-place form is recoverable.
  const raw = (typeof value === 'string' ? value.trim() : String(value))
    .replace(/^(-?\d+\.\d{2})0+$/, '$1');
  try {
    return normalizeAmount(raw);
  } catch (e) {
    return null;
  }
}

module.exports = {
  isValidAmount,
  normalizeAmount,
  toMinorUnits,
  fromMinorUnits,
  addAmounts,
  subtractAmounts,
  compareAmounts,
  isPositiveAmount,
  isZeroAmount,
  negateAmount,
  absAmount,
  coerceAmount,
};
