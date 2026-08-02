'use strict';

/**
 * Shared trustee configuration for FinOps, Asset-Debt proofs, and
 * distribution/disbursement approvals.
 *
 * Two-trustee control: Administration + Distribution.
 */

const TRUSTEES = [
  {
    role: 'administration',
    name: process.env.TRUST_ADMIN_NAME || 'DeAndrea Lavar Barkley',
    email: process.env.TRUST_ADMIN_EMAIL || 'deandreabarkley13@gmail.com',
    phone: process.env.TRUST_ADMIN_PHONE || '(216)632-2353',
    address: process.env.TRUST_ADMIN_ADDRESS || '',
  },
  {
    role: 'distribution',
    name: process.env.TRUST_DIST_NAME || 'Malissa Ann Robinson',
    email: process.env.TRUST_DIST_EMAIL || 'annrobinson9800@yahoo.com',
    phone: process.env.TRUST_DIST_PHONE || '(216)484-4804',
    address: process.env.TRUST_DIST_ADDRESS || '',
  },
];

const REQUIRED_ROLES = ['administration', 'distribution'];

function getTrusteeByRole(role) {
  return TRUSTEES.find(t => String(t.role).toLowerCase() === String(role).toLowerCase());
}

function getTrusteeByEmail(email) {
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
  getTrusteeByRole,
  getTrusteeByEmail,
  validateTrustee,
};
