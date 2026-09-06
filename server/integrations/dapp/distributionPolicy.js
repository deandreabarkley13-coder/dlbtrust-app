'use strict';

/**
 * Trust distribution policy: per-transaction USD ceilings by requester role
 * and the expense purposes a distribution may support.
 *
 *   beneficiary  $100,000 per transaction   (DISTRIBUTION_LIMIT_BENEFICIARY_USD)
 *   trustee      $500,000 per transaction   (DISTRIBUTION_LIMIT_TRUSTEE_USD)
 *   purposes     lifestyle, medical, travel, home, education (DISTRIBUTION_PURPOSES)
 *
 * Shared by the distribution-request engine and every rail that moves value
 * on a requester's behalf (e.g. the thirdweb server wallet).
 */

const DEFAULT_LIMITS_USD = { beneficiary: 100000, trustee: 500000 };
const DEFAULT_PURPOSES = ['lifestyle', 'medical', 'travel', 'home', 'education'];

function envNumber(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function getPolicy() {
  const purposes = (process.env.DISTRIBUTION_PURPOSES || '')
    .split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  return {
    limitsUsd: {
      beneficiary: envNumber('DISTRIBUTION_LIMIT_BENEFICIARY_USD', DEFAULT_LIMITS_USD.beneficiary),
      trustee: envNumber('DISTRIBUTION_LIMIT_TRUSTEE_USD', DEFAULT_LIMITS_USD.trustee),
    },
    purposes: purposes.length ? purposes : DEFAULT_PURPOSES,
  };
}

function normalizeRequesterRole(role) {
  const r = String(role || '').toLowerCase();
  if (r.includes('trustee')) return 'trustee';
  if (r === 'beneficiary' || r === '') return 'beneficiary';
  throw new Error('requesterRole must be beneficiary or trustee');
}

function normalizePurpose(purpose, { required = false } = {}) {
  const { purposes } = getPolicy();
  const p = String(purpose || '').trim().toLowerCase();
  if (!p) {
    if (required) throw new Error(`purpose required (one of ${purposes.join(', ')})`);
    return null;
  }
  if (!purposes.includes(p)) throw new Error(`purpose "${p}" not permitted; allowed: ${purposes.join(', ')}`);
  return p;
}

/**
 * Validate a single distribution against the policy. Returns the normalized
 * { requesterRole, purpose, amountUsd, limitUsd } or throws.
 */
function enforce({ requesterRole, amountUsd, purpose, purposeRequired = false } = {}) {
  const role = normalizeRequesterRole(requesterRole);
  const usd = Number(amountUsd);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error('amountUsd must be a positive number');
  const limitUsd = getPolicy().limitsUsd[role];
  if (limitUsd > 0 && usd > limitUsd) {
    const err = new Error(`${role} distribution of $${usd.toLocaleString('en-US')} exceeds the $${limitUsd.toLocaleString('en-US')} per-transaction limit`);
    err.status = 422;
    err.code = 'DISTRIBUTION_LIMIT_EXCEEDED';
    throw err;
  }
  return { requesterRole: role, purpose: normalizePurpose(purpose, { required: purposeRequired }), amountUsd: usd, limitUsd };
}

module.exports = { DEFAULT_LIMITS_USD, DEFAULT_PURPOSES, getPolicy, normalizeRequesterRole, normalizePurpose, enforce };
