'use strict';

/**
 * Trust Mandate — the one place that says who the platform operates for and
 * how money is allowed to move.
 *
 * Every component (accounting, fixed income, thirdweb, FireFly/Fabric,
 * distributions, deployment) reads this instead of carrying its own copy of
 * the trust's name, role or funding policy. The mandate is configuration, not
 * legal authority: trust instruments, custody agreements and licensing live
 * outside the software and are only referenced here.
 *
 * Funding policy: beneficiary support is paid out of fixed-income income
 * (coupons and accrued interest). Distributions that would draw on corpus
 * are surfaced as a gap and refused when TRUST_MANDATE_ENFORCE=true.
 */

const DEFAULT_LEGAL_NAME = 'DEANDREA LAVAR BARKLEY FAMILY TRUST';
const DEFAULT_SHORT_NAME = 'DLB Trust';

/** Ordered stages a beneficiary distribution must pass through. */
const PIPELINE_STAGES = [
  { key: 'income', label: 'Fixed-income income', description: 'Coupons and accrued interest on bond positions (postgres:bonds+bond_balances).' },
  { key: 'distributable', label: 'Distributable income', description: 'Income less the mandated reserve; the only pool beneficiary support is paid from.' },
  { key: 'policy', label: 'Distribution policy', description: 'Per-role ceilings and permitted purposes (DistributionPolicy).' },
  { key: 'funding', label: 'Canonical funding', description: 'Fineract GL must hold the cash and agree with the trust sub-ledger (CanonicalFundingSource).' },
  { key: 'notarize', label: 'Fabric notarization', description: 'Tamper-evident digest of the record anchored on Hyperledger Fabric.' },
  { key: 'settle', label: 'Settlement', description: 'Value moves through thirdweb (wallet/stablecoin) or FireFly (token pool).' },
  { key: 'confirm', label: 'Confirmation', description: 'External rail confirms the transfer; nothing is booked before this.' },
  { key: 'book', label: 'Accounting booking', description: 'Journal entry posted to the trust ledger / Fineract after confirmation.' },
  { key: 'reconcile', label: 'Reconciliation', description: 'Fineract vs sub-ledger vs bonds vs wallets vs pools vs notarizations agree.' },
];

/** Which system is authoritative for which fact. Nothing else may override these. */
const AUTHORITY = {
  cashAndGl: 'fineract',
  subLedger: 'postgres:trust_accounts',
  fixedIncome: 'postgres:bonds+bond_balances',
  beneficiaries: 'postgres:ptc_beneficiaries',
  issuerAssets: 'postgres:issuer_assets',
  evidence: 'hyperledger-fabric',
  settlementRails: ['thirdweb', 'hyperledger-firefly', 'sit'],
  deployment: ['gcp-vm', 'northflank'],
};

function bool(name, def = false) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(v);
}

function num(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function getMandate() {
  const legalName = (process.env.TRUST_LEGAL_NAME || DEFAULT_LEGAL_NAME).trim();
  const shortName = (process.env.TRUST_NAME || DEFAULT_SHORT_NAME).trim();
  return {
    legalName,
    shortName,
    /** How the platform acts on behalf of the trust. */
    roles: ['custodian', 'issuer'],
    purpose: 'Trust asset custody and beneficiary support funded by fixed-income income',
    jurisdictionNote: process.env.TRUST_JURISDICTION || null,
    fundingPolicy: {
      source: 'fixed-income',
      /** Share of income held back before anything is distributable (0-100). */
      reserveIncomePct: num('TRUST_MANDATE_RESERVE_INCOME_PCT', 10),
      /** Corpus (principal) is never a distribution source unless explicitly allowed. */
      allowCorpusDistributions: bool('TRUST_MANDATE_ALLOW_CORPUS', false),
      /** Distributions must clear the canonical (Fineract) funding check when it is configured. */
      requireCanonicalFunding: bool('TRUST_MANDATE_REQUIRE_CANONICAL', false),
      /** Refuse (rather than only report) distributions that violate the mandate. */
      enforce: bool('TRUST_MANDATE_ENFORCE', false),
    },
    authority: AUTHORITY,
    pipeline: PIPELINE_STAGES.map((s) => s.key),
  };
}

module.exports = { getMandate, PIPELINE_STAGES, AUTHORITY, DEFAULT_LEGAL_NAME, DEFAULT_SHORT_NAME };
