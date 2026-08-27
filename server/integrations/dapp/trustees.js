'use strict';

const path = require('path');

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
    email: process.env.TRUST_DIST_EMAIL || 'malissa1130@gmail.com',
    phone: process.env.TRUST_DIST_PHONE || '',
    address: process.env.TRUST_DIST_ADDRESS || '',
  },
  {
    role: 'maker',
    name: process.env.TRUST_MAKER_NAME || 'Malissa Robinson',
    email: process.env.TRUST_MAKER_EMAIL || 'malissa1130@gmail.com',
    phone: process.env.TRUST_MAKER_PHONE || '',
    address: process.env.TRUST_MAKER_ADDRESS || '',
    signatureOfRecordLegalName: process.env.TRUST_MAKER_LEGAL_NAME || 'Malissa Ann Robinson',
  },
  {
    role: 'checker',
    name: process.env.TRUST_CHECKER_NAME || 'DeAndrea Barkley',
    email: process.env.TRUST_CHECKER_EMAIL || 'dbarkley1130@gmail.com',
    phone: process.env.TRUST_CHECKER_PHONE || '',
    address: process.env.TRUST_CHECKER_ADDRESS || '',
    signatureOfRecordLegalName: process.env.TRUST_CHECKER_LEGAL_NAME || 'DeAndrea Lavar Barkley',
  },
];

const REQUIRED_ROLES = ['maker', 'checker'];

// Additional addresses a trustee may sign in from. The primary email above stays
// the address of record for notifications and the signature page.
function altEmails(value) {
  return String(value || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
}

TRUSTEES.forEach((trustee) => {
  const envKey = {
    administration: 'TRUST_ADMIN_ALT_EMAILS',
    distribution: 'TRUST_DIST_ALT_EMAILS',
    maker: 'TRUST_MAKER_ALT_EMAILS',
    checker: 'TRUST_CHECKER_ALT_EMAILS',
  }[trustee.role];
  trustee.altEmails = envKey ? altEmails(process.env[envKey]) : [];
});

function trusteeEmails(trustee) {
  return [String(trustee.email || '').toLowerCase()]
    .concat(trustee.altEmails || [])
    .filter(Boolean);
}

function trusteeOwnsEmail(trustee, email) {
  const lower = String(email || '').toLowerCase();
  return Boolean(lower) && trusteeEmails(trustee).includes(lower);
}

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
  return TRUSTEES.find(t => trusteeOwnsEmail(t, email));
}

function validateTrustee(role, email) {
  const trustee = getTrusteeByRole(role);
  if (!trustee) throw new Error(`Unknown trustee role: ${role}`);
  if (!trusteeOwnsEmail(trustee, email)) {
    throw new Error(`Email ${email} is not authorized for role ${role}`);
  }
  return trustee;
}

function signatureDocumentPath() {
  const configuredPath = process.env.TRUST_SIGNATURE_DOCUMENT_PATH;
  return configuredPath
    ? path.resolve(configuredPath)
    : (process.env.NODE_ENV === 'production'
      ? '/data/governance/Trustees_Signature_Page.pdf'
      : path.join(process.cwd(), 'data', 'governance', 'Trustees_Signature_Page.pdf'));
}

function getTrusteeSignatureOfRecord(role) {
  const trustee = getTrusteeByRole(role);
  if (!trustee || !trustee.signatureOfRecordLegalName) return null;
  return {
    role: trustee.role,
    legalName: trustee.signatureOfRecordLegalName,
    document: {
      title: 'Trustees Signature Page',
      fileName: 'Trustees_Signature_Page.pdf',
      sha256: '461ccddfb9f29fadae824d4905f74c18b24484f82877b8115cd871c1152ce4b4',
      pageCount: 1,
      path: signatureDocumentPath(),
      executionStatus: 'executed',
    },
  };
}

function getSignatureOfRecord() {
  return REQUIRED_ROLES.map(getTrusteeSignatureOfRecord);
}

module.exports = {
  TRUSTEES,
  REQUIRED_ROLES,
  ROLE_ALIASES,
  normalizeRole,
  getTrusteeByRole,
  getTrusteeByEmail,
  trusteeEmails,
  trusteeOwnsEmail,
  validateTrustee,
  signatureDocumentPath,
  getTrusteeSignatureOfRecord,
  getSignatureOfRecord,
};
