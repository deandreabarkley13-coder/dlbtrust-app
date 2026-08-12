'use strict';

/**
 * Shared trustee configuration for FinOps, Asset-Debt proofs, and
 * distribution/disbursement approvals.
 *
 * Two-trustee control: Maker + Checker.
 * Backward-compatible aliases: administration, distribution.
 */

const TRUSTEES = [
  {
    role: 'administration',
    name: process.env.TRUST_ADMIN_NAME || 'DeAndrea Barkley',
    email: process.env.TRUST_ADMIN_EMAIL || 'dbarkley1130@gmail.com',
    phone: process.env.TRUST_ADMIN_PHONE || '',
    address: process.env.TRUST_ADMIN_ADDRESS || '',
  },
  {
    role: 'distribution',
    name: process.env.TRUST_DIST_NAME || 'Malissa Robinson',
    email: process.env.TRUST_DIST_EMAIL || 'barkley420lavar@gmail.com',
    phone: process.env.TRUST_DIST_PHONE || '',
    address: process.env.TRUST_DIST_ADDRESS || '',
  },
  {
    role: 'maker',
    name: process.env.TRUST_MAKER_NAME || 'Malissa Robinson',
    email: process.env.TRUST_MAKER_EMAIL || 'barkley420lavar@gmail.com',
    phone: process.env.TRUST_MAKER_PHONE || '',
    address: process.env.TRUST_MAKER_ADDRESS || '',
  },
  {
    role: 'checker',
    name: process.env.TRUST_CHECKER_NAME || 'DeAndrea Barkley',
    email: process.env.TRUST_CHECKER_EMAIL || 'dbarkley1130@gmail.com',
    phone: process.env.TRUST_CHECKER_PHONE || '',
    address: process.env.TRUST_CHECKER_ADDRESS || '',
  },
];

const REQUIRED_ROLES = ['maker', 'checker'];

const ROLE_ALIASES = {
  administration: 'maker',
  distribution: 'checker',
  trustee_admin: 'maker',
  trustee_maker: 'maker',
  trustee_checker: 'checker',
};

function normalizeRole(role) {
  const r = String(role).toLowerCase();
  return ROLE_ALIASES[r] || r;
}

function getTrusteeByRole(role) {
  const normalized = normalizeRole(role);
  return TRUSTEES.find(t => String(t.role).toLowerCase() === normalized);
}

function getTrusteeByEmail(email) {
  if (!email) return null;
  return TRUSTEES.find(t => String(t.email).toLowerCase() === String(email).toLowerCase());
}

function validateTrustee(role, email) {
  const trustee = getTrusteeByRole(role);
  if (!trustee) throw new Error(`Unknown trustee role: ${role}`);
  if (String(trustee.email).toLowerCase() !== String(email).toLowerCase()) {
    throw new Error(`Email ${email} is not authorized for role ${role}`);
  }
  return trustee;
}

module.exports = {
  TRUSTEES,
  REQUIRED_ROLES,
  ROLE_ALIASES,
  normalizeRole,
  getTrusteeByRole,
  getTrusteeByEmail,
  validateTrustee,
};
