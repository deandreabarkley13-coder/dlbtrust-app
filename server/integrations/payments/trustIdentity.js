'use strict';

/**
 * Trust Identity — protected, env-driven identifiers for the trust entity.
 *
 * These values (trust ID and trust master account number) are sensitive
 * financial identifiers and are NEVER hardcoded in the repo. They are read
 * from the environment (or provisioned secrets) at runtime:
 *
 *   TRUST_ID              trust identifier (e.g. tax/registration ID)
 *   TRUST_MASTER_ACCOUNT  trust master (control) account number
 *   TRUST_NAME            display name (non-sensitive, optional)
 *
 * Helpers here redact values for logging — full values are only used where the
 * business logic genuinely needs them (e.g. building a payment record), never
 * emitted to logs, responses, or errors.
 */

function clean(v) {
  return v == null ? '' : String(v).trim();
}

/**
 * Mask an identifier for safe logging/display: shows only the last `visible`
 * characters, e.g. "1978144300" -> "******4300". Empty/short values become
 * a fixed placeholder so we never accidentally leak a full short value.
 */
function mask(value, visible = 4) {
  const s = clean(value);
  if (!s) return null;
  if (s.length <= visible) return '*'.repeat(s.length);
  return '*'.repeat(s.length - visible) + s.slice(-visible);
}

function getTrustId() {
  return clean(process.env.TRUST_ID) || null;
}

function getTrustMasterAccount() {
  return clean(process.env.TRUST_MASTER_ACCOUNT) || null;
}

function getTrustName() {
  return clean(process.env.TRUST_NAME) || 'DLB Trust';
}

/**
 * True when both protected identifiers are present.
 */
function isConfigured() {
  return !!(getTrustId() && getTrustMasterAccount());
}

/**
 * A log/response-safe view of the trust identity — never contains full
 * sensitive values.
 */
function summary() {
  return {
    trust_name: getTrustName(),
    trust_id: mask(getTrustId()),
    trust_master_account: mask(getTrustMasterAccount()),
    configured: isConfigured(),
  };
}

/**
 * Throw if the protected identifiers are not configured. Use before any flow
 * that must be attributed to the trust entity.
 */
function requireConfigured() {
  const missing = [];
  if (!getTrustId()) missing.push('TRUST_ID');
  if (!getTrustMasterAccount()) missing.push('TRUST_MASTER_ACCOUNT');
  if (missing.length) {
    throw new Error(
      'Trust identity not configured — set ' + missing.join(', ')
      + ' (protected secrets, never hardcoded)'
    );
  }
  return true;
}

module.exports = {
  mask,
  getTrustId,
  getTrustMasterAccount,
  getTrustName,
  isConfigured,
  requireConfigured,
  summary,
};
