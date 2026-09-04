'use strict';

/**
 * Third-Party Sender OS — the compliance register that lets the trust
 * originate ACH through a bank without being the bank.
 *
 * Under the Nacha Operating Rules a Third-Party Sender (TPS) is the party that
 * sits between an Originator and the ODFI: it has the ODFI agreement, it
 * warrants the Originators to the bank, and it carries most of the ODFI's
 * obligations one step down. For a private trust company that means the PTC
 * is the TPS, the trust / its entities are the Originators, and the ODFI is
 * whichever bank (or BaaS sponsor) signs the origination agreement.
 *
 * What the engine owns, mapped to the rule that makes it mandatory:
 *
 *   agreements    The ODFI origination agreement (Art. 2 §2.2.2 / §2.2.3 —
 *                 Originator/TPS agreements; §2.17.3 — ODFI registers each TPS
 *                 with Nacha). Exposure limits, permitted SEC codes, transport,
 *                 audit rights and registration reference live here. Nothing
 *                 originates until an agreement is `executed`.
 *   originators   Every party the TPS originates for (Art. 2 §2.2.2.1 — the
 *                 TPS performs the Originator due diligence the ODFI would).
 *                 KYB/beneficial-owner record, sanctions screening, risk
 *                 rating, permitted SEC codes, exposure limits, periodic
 *                 review. Nested Third-Party Senders (2021 rule, §2.17.3.3)
 *                 must be disclosed up the chain.
 *   exposure      Per-Originator daily and multi-day exposure against the
 *                 limits the ODFI granted (Art. 2 §2.2.3 (d) — exposure limits
 *                 and monitoring).
 *   returns       Return-rate monitoring against Nacha's thresholds
 *                 (Art. 2 §2.17.2): unauthorized 0.5%, administrative 3%,
 *                 overall 15%. Breaches suspend discretionary origination.
 *   obligations   The compliance calendar: annual Rules Compliance Audit
 *                 (Art. 1 §1.2.2, due 31 Dec), annual risk assessment
 *                 (§1.2.4), data-security controls (§1.6), Originator reviews,
 *                 and the trust's own semi-annual policy review.
 *   preflight     The gate the ACH pipeline asks before a file leaves: is
 *                 there an executed agreement, an approved Originator cleared
 *                 by sanctions screening, within SEC code, limit and
 *                 return-rate bounds, with no overdue mandatory obligation.
 *
 * Family-trust governance: approvals are four-eyes (approver ≠ onboarder) and
 * the register records the fiduciary capacity of every control person, so the
 * ODFI's due-diligence request can be answered from one place.
 *
 * None of this moves money. It decides whether the rails are *allowed* to.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');

const AGREEMENT_STATUSES = ['draft', 'executed', 'suspended', 'terminated'];
const ORIGINATOR_STATUSES = ['onboarding', 'approved', 'suspended', 'terminated'];
const ENTITY_TYPES = ['trust', 'private_trust_company', 'llc', 'corporation', 'individual', 'nested_third_party_sender'];
const RISK_RATINGS = ['low', 'medium', 'high'];
const SEC_CODES = ['PPD', 'CCD', 'CTX', 'WEB', 'TEL', 'IAT'];
const RETURN_CATEGORIES = ['unauthorized', 'administrative', 'overall'];

/** Nacha Art. 2 §2.17.2 return-rate thresholds, in basis points of debit entries. */
const RETURN_THRESHOLDS_BPS = { unauthorized: 50, administrative: 300, overall: 1500 };
const UNAUTHORIZED_RETURN_CODES = ['R05', 'R07', 'R10', 'R11', 'R29', 'R51'];
const ADMINISTRATIVE_RETURN_CODES = ['R02', 'R03', 'R04'];

const DEFAULT_OBLIGATIONS = [
  { key: 'rules_compliance_audit', ruleRef: 'Nacha Art. 1 §1.2.2', title: 'Annual ACH Rules Compliance Audit', cadence: 'annual', dueMonthDay: '12-31', mandatory: true },
  { key: 'risk_assessment', ruleRef: 'Nacha Art. 1 §1.2.4', title: 'Annual ACH risk assessment and risk-management program review', cadence: 'annual', dueMonthDay: '12-31', mandatory: true },
  { key: 'tps_registration', ruleRef: 'Nacha Art. 2 §2.17.3', title: 'Confirm ODFI has registered the PTC as a Third-Party Sender (and any nested TPS) with Nacha', cadence: 'annual', dueMonthDay: '01-31', mandatory: true },
  { key: 'data_security', ruleRef: 'Nacha Art. 1 §1.6', title: 'Account-number protection review (encryption at rest, access controls, large-originator rule)', cadence: 'annual', dueMonthDay: '06-30', mandatory: true },
  { key: 'originator_review', ruleRef: 'Nacha Art. 2 §2.2.2.1', title: 'Periodic Originator due-diligence refresh (KYB, sanctions, exposure limits)', cadence: 'annual', dueMonthDay: '09-30', mandatory: true },
  { key: 'sanctions_program', ruleRef: 'OFAC / 31 CFR Part 501', title: 'OFAC sanctions screening program attestation', cadence: 'annual', dueMonthDay: '03-31', mandatory: true },
  { key: 'trust_policy_review', ruleRef: 'Liquidity & Capital Management Policy', title: 'Semi-annual trustee review of liquidity and origination policy', cadence: 'semi_annual', dueMonthDay: '06-30', mandatory: false },
];

class TpsError extends Error {
  constructor(message, code = 'TPS_ERROR', status = 409, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function cents(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new TpsError(`${field} must be a non-negative integer number of cents`, 'TPS_INVALID', 400);
  return n;
}

function secCodes(list, fallback) {
  if (list === undefined || list === null) return fallback;
  const codes = (Array.isArray(list) ? list : String(list).split(',')).map(s => String(s).trim().toUpperCase()).filter(Boolean);
  for (const c of codes) if (!SEC_CODES.includes(c)) throw new TpsError(`unsupported SEC code '${c}'`, 'TPS_INVALID', 400, { supported: SEC_CODES });
  return codes;
}

function maskTaxId(taxId) {
  if (!taxId) return null;
  const digits = String(taxId).replace(/\D/g, '');
  return digits.length >= 4 ? `***-**-${digits.slice(-4)}` : '****';
}

function isoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new TpsError(`invalid date '${value}'`, 'TPS_INVALID', 400);
  return d.toISOString().slice(0, 10);
}

function nextDue(monthDay, from = new Date()) {
  const [m, d] = monthDay.split('-').map(Number);
  const year = from.getUTCFullYear();
  const candidate = new Date(Date.UTC(year, m - 1, d));
  return (candidate >= from ? candidate : new Date(Date.UTC(year + 1, m - 1, d))).toISOString().slice(0, 10);
}

function returnCategory(code) {
  const c = String(code || '').toUpperCase();
  if (UNAUTHORIZED_RETURN_CODES.includes(c)) return 'unauthorized';
  if (ADMINISTRATIVE_RETURN_CODES.includes(c)) return 'administrative';
  return 'overall';
}

function enforced() {
  const v = String(process.env.TPS_OS_ENFORCE || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

// ── Row mapping ──────────────────────────────────────────────────────────────

function mapAgreement(r) {
  if (!r) return null;
  return {
    agreementId: r.agreement_id, odfiName: r.odfi_name, odfiRouting: r.odfi_routing, sponsor: r.sponsor,
    agreementRef: r.agreement_ref, status: r.status, transport: r.transport,
    executedAt: r.executed_at, effectiveDate: r.effective_date, expiresAt: r.expires_at,
    nachaRegistrationRef: r.nacha_registration_ref, tpsRegistered: Boolean(r.nacha_registration_ref),
    exposureLimitCents: r.exposure_limit_cents === null ? null : Number(r.exposure_limit_cents),
    dailyLimitCents: r.daily_limit_cents === null ? null : Number(r.daily_limit_cents),
    exposureWindowDays: Number(r.exposure_window_days),
    secCodes: parseJson(r.sec_codes, []), sameDayAllowed: Boolean(r.same_day_allowed), auditRights: Boolean(r.audit_rights),
    warranties: parseJson(r.warranties, []), contacts: parseJson(r.contacts, []),
    createdBy: r.created_by, createdAt: r.created_at,
  };
}

function mapOriginator(r) {
  if (!r) return null;
  return {
    originatorId: r.originator_id, legalName: r.legal_name, entityType: r.entity_type, taxIdMasked: r.tax_id_masked,
    fiduciaryCapacity: r.fiduciary_capacity, natureOfBusiness: r.nature_of_business, agreementId: r.agreement_id,
    originatorAgreementRef: r.originator_agreement_ref, status: r.status, riskRating: r.risk_rating,
    kyb: parseJson(r.kyb, {}), sanctionsScreeningId: r.sanctions_screening_id, sanctionsStatus: r.sanctions_status,
    secCodes: parseJson(r.sec_codes, []),
    dailyLimitCents: r.daily_limit_cents === null ? null : Number(r.daily_limit_cents),
    exposureLimitCents: r.exposure_limit_cents === null ? null : Number(r.exposure_limit_cents),
    isNestedTps: Boolean(r.is_nested_tps), nestedDisclosure: parseJson(r.nested_disclosure, null), isDefault: Boolean(r.is_default),
    onboardedBy: r.onboarded_by, approvedBy: r.approved_by, approvedAt: r.approved_at, nextReviewAt: r.next_review_at,
    createdAt: r.created_at,
  };
}

function mapObligation(r) {
  if (!r) return null;
  return {
    obligationId: r.obligation_id, key: r.key, ruleRef: r.rule_ref, title: r.title, cadence: r.cadence, mandatory: Boolean(r.mandatory),
    owner: r.owner, dueAt: r.due_at, status: r.status, completedAt: r.completed_at, completedBy: r.completed_by,
    evidence: parseJson(r.evidence, null), createdAt: r.created_at,
  };
}

// ── Engine ───────────────────────────────────────────────────────────────────

const TpsOsEngine = {
  TpsError,
  enforced,

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tps_odfi_agreements (
        agreement_id TEXT PRIMARY KEY,
        odfi_name TEXT NOT NULL,
        odfi_routing TEXT,
        sponsor TEXT,
        agreement_ref TEXT,
        status TEXT NOT NULL,
        transport TEXT,
        executed_at TIMESTAMPTZ,
        effective_date DATE,
        expires_at DATE,
        nacha_registration_ref TEXT,
        exposure_limit_cents BIGINT,
        daily_limit_cents BIGINT,
        exposure_window_days INTEGER NOT NULL DEFAULT 2,
        sec_codes JSONB NOT NULL DEFAULT '[]',
        same_day_allowed BOOLEAN NOT NULL DEFAULT FALSE,
        audit_rights BOOLEAN NOT NULL DEFAULT TRUE,
        warranties JSONB NOT NULL DEFAULT '[]',
        contacts JSONB NOT NULL DEFAULT '[]',
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS tps_originators (
        originator_id TEXT PRIMARY KEY,
        legal_name TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        tax_id_masked TEXT,
        fiduciary_capacity TEXT,
        nature_of_business TEXT,
        agreement_id TEXT,
        originator_agreement_ref TEXT,
        status TEXT NOT NULL,
        risk_rating TEXT,
        kyb JSONB NOT NULL DEFAULT '{}',
        sanctions_screening_id TEXT,
        sanctions_status TEXT,
        sec_codes JSONB NOT NULL DEFAULT '[]',
        daily_limit_cents BIGINT,
        exposure_limit_cents BIGINT,
        is_nested_tps BOOLEAN NOT NULL DEFAULT FALSE,
        nested_disclosure JSONB,
        is_default BOOLEAN NOT NULL DEFAULT FALSE,
        onboarded_by TEXT,
        approved_by TEXT,
        approved_at TIMESTAMPTZ,
        next_review_at DATE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS tps_obligations (
        obligation_id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        rule_ref TEXT,
        title TEXT NOT NULL,
        cadence TEXT NOT NULL,
        mandatory BOOLEAN NOT NULL DEFAULT TRUE,
        owner TEXT,
        due_at DATE NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        completed_at TIMESTAMPTZ,
        completed_by TEXT,
        evidence JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS tps_exposure (
        exposure_id TEXT PRIMARY KEY,
        originator_id TEXT NOT NULL,
        batch_ref TEXT,
        direction TEXT NOT NULL,
        sec_code TEXT,
        amount_cents BIGINT NOT NULL,
        entry_count INTEGER NOT NULL DEFAULT 1,
        effective_date DATE NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS tps_returns (
        return_id TEXT PRIMARY KEY,
        originator_id TEXT NOT NULL,
        batch_ref TEXT,
        return_code TEXT NOT NULL,
        category TEXT NOT NULL,
        amount_cents BIGINT NOT NULL DEFAULT 0,
        returned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS tps_events (
        event_id TEXT PRIMARY KEY,
        subject_type TEXT,
        subject_id TEXT,
        event_type TEXT NOT NULL,
        actor TEXT,
        detail JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  },

  // ── ODFI agreements ────────────────────────────────────────────────────────

  async createAgreement({ odfiName, odfiRouting = null, sponsor = null, agreementRef = null, transport = null, effectiveDate = null, expiresAt = null,
    nachaRegistrationRef = null, exposureLimitCents = null, dailyLimitCents = null, exposureWindowDays = 2, secCodes: codes = ['PPD', 'CCD'],
    sameDayAllowed = false, auditRights = true, warranties = [], contacts = [], createdBy = null } = {}) {
    if (!odfiName) throw new TpsError('odfiName is required', 'TPS_INVALID', 400);
    if (!['as2', 'sftp', 'api', null].includes(transport)) throw new TpsError('transport must be as2, sftp or api', 'TPS_INVALID', 400);
    await this.ensureTables();
    const agreementId = newId('ODFI');
    const res = await pool.query(
      `INSERT INTO tps_odfi_agreements (agreement_id, odfi_name, odfi_routing, sponsor, agreement_ref, status, transport, effective_date, expires_at,
         nacha_registration_ref, exposure_limit_cents, daily_limit_cents, exposure_window_days, sec_codes, same_day_allowed, audit_rights, warranties, contacts, created_by)
       VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16::jsonb, $17::jsonb, $18) RETURNING *`,
      [agreementId, odfiName, odfiRouting, sponsor, agreementRef, transport, isoDate(effectiveDate), isoDate(expiresAt), nachaRegistrationRef,
        cents(exposureLimitCents, 'exposureLimitCents'), cents(dailyLimitCents, 'dailyLimitCents'), Math.max(1, Number(exposureWindowDays) || 2),
        JSON.stringify(secCodes(codes, ['PPD', 'CCD'])), Boolean(sameDayAllowed), Boolean(auditRights), JSON.stringify(warranties || []), JSON.stringify(contacts || []), createdBy]
    );
    await this._event('agreement', agreementId, 'agreement_drafted', createdBy, { odfiName });
    return mapAgreement(res.rows[0]);
  },

  async agreement(agreementId) {
    const res = await pool.query('SELECT * FROM tps_odfi_agreements WHERE agreement_id = $1', [agreementId]);
    if (!res.rows[0]) throw new TpsError(`agreement ${agreementId} not found`, 'TPS_NOT_FOUND', 404);
    return mapAgreement(res.rows[0]);
  },

  async agreements() {
    const res = await pool.query('SELECT * FROM tps_odfi_agreements ORDER BY created_at DESC');
    return res.rows.map(mapAgreement);
  },

  /**
   * Mark the ODFI agreement executed. Requires the signed reference and the
   * Nacha TPS registration reference the ODFI provides (§2.17.3): without the
   * registration the bank is not permitted to originate for us.
   */
  async executeAgreement(agreementId, { agreementRef, nachaRegistrationRef, executedAt = new Date(), actor = null } = {}) {
    const a = await this.agreement(agreementId);
    if (a.status !== 'draft' && a.status !== 'suspended') throw new TpsError(`agreement is ${a.status}`, 'TPS_STATE', 409);
    const ref = agreementRef || a.agreementRef;
    const reg = nachaRegistrationRef || a.nachaRegistrationRef;
    if (!ref) throw new TpsError('agreementRef (signed origination agreement) is required to execute', 'TPS_INVALID', 400);
    if (!reg) throw new TpsError('nachaRegistrationRef (ODFI Third-Party Sender registration) is required to execute', 'TPS_INVALID', 400);
    await pool.query(
      `UPDATE tps_odfi_agreements SET status = 'executed', agreement_ref = $2, nacha_registration_ref = $3, executed_at = $4 WHERE agreement_id = $1`,
      [agreementId, ref, reg, new Date(executedAt).toISOString()]
    );
    await this._event('agreement', agreementId, 'agreement_executed', actor, { agreementRef: ref, nachaRegistrationRef: reg });
    return this.agreement(agreementId);
  },

  async setAgreementStatus(agreementId, status, { actor = null, reason = null } = {}) {
    if (!['suspended', 'terminated'].includes(status)) throw new TpsError('status must be suspended or terminated', 'TPS_INVALID', 400);
    await this.agreement(agreementId);
    await pool.query('UPDATE tps_odfi_agreements SET status = $2 WHERE agreement_id = $1', [agreementId, status]);
    await this._event('agreement', agreementId, `agreement_${status}`, actor, { reason });
    return this.agreement(agreementId);
  },

  // ── Originators ────────────────────────────────────────────────────────────

  /**
   * Onboard an Originator: the due diligence the ODFI delegates to the TPS
   * (§2.2.2.1). Runs sanctions screening through ComplianceEngine and stores
   * the screening id; the record stays `onboarding` until a second person
   * approves it.
   */
  async onboardOriginator({ legalName, entityType, taxId = null, fiduciaryCapacity = null, natureOfBusiness = null, agreementId = null,
    originatorAgreementRef = null, riskRating = null, kyb = {}, secCodes: codes = ['PPD', 'CCD'], dailyLimitCents = null, exposureLimitCents = null,
    isNestedTps = false, nestedDisclosure = null, isDefault = false, onboardedBy = null, country = 'US' } = {}) {
    if (!legalName) throw new TpsError('legalName is required', 'TPS_INVALID', 400);
    if (!ENTITY_TYPES.includes(entityType)) throw new TpsError(`entityType must be one of ${ENTITY_TYPES.join('|')}`, 'TPS_INVALID', 400);
    if (riskRating !== null && !RISK_RATINGS.includes(riskRating)) throw new TpsError('riskRating must be low, medium or high', 'TPS_INVALID', 400);
    const nested = Boolean(isNestedTps) || entityType === 'nested_third_party_sender';
    if (nested && !(nestedDisclosure && nestedDisclosure.originators && nestedDisclosure.originators.length)) {
      throw new TpsError('nested Third-Party Senders must disclose their downstream Originators (Nacha §2.17.3.3)', 'TPS_NESTED_DISCLOSURE', 400);
    }
    await this.ensureTables();
    if (agreementId) await this.agreement(agreementId);

    let screening = null;
    try {
      const { ComplianceEngine } = require('../compliance/complianceEngine');
      screening = await ComplianceEngine.screen({
        type: 'sanctions', entityType: entityType === 'individual' ? 'individual' : 'business',
        fullName: entityType === 'individual' ? legalName : undefined, businessName: entityType === 'individual' ? undefined : legalName,
        country, screenedBy: onboardedBy || 'tps-os', notes: 'Third-Party Sender Originator onboarding',
      });
    } catch (e) {
      screening = { screening_id: null, status: 'error', error: e.message };
    }
    const sanctionsStatus = screening && screening.status ? String(screening.status) : 'unscreened';

    const originatorId = newId('ORIG');
    const res = await pool.query(
      `INSERT INTO tps_originators (originator_id, legal_name, entity_type, tax_id_masked, fiduciary_capacity, nature_of_business, agreement_id, originator_agreement_ref,
         status, risk_rating, kyb, sanctions_screening_id, sanctions_status, sec_codes, daily_limit_cents, exposure_limit_cents, is_nested_tps, nested_disclosure, is_default, onboarded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'onboarding', $9, $10::jsonb, $11, $12, $13::jsonb, $14, $15, $16, $17::jsonb, $18, $19) RETURNING *`,
      [originatorId, legalName, entityType, maskTaxId(taxId), fiduciaryCapacity, natureOfBusiness, agreementId, originatorAgreementRef, riskRating,
        JSON.stringify(kyb || {}), screening ? screening.screening_id || null : null, sanctionsStatus, JSON.stringify(secCodes(codes, ['PPD', 'CCD'])),
        cents(dailyLimitCents, 'dailyLimitCents'), cents(exposureLimitCents, 'exposureLimitCents'), nested, nestedDisclosure ? JSON.stringify(nestedDisclosure) : null,
        Boolean(isDefault), onboardedBy]
    );
    await this._event('originator', originatorId, 'originator_onboarded', onboardedBy, { legalName, entityType, sanctionsStatus, screeningId: screening ? screening.screening_id : null });
    return mapOriginator(res.rows[0]);
  },

  async originator(originatorId) {
    const res = await pool.query('SELECT * FROM tps_originators WHERE originator_id = $1', [originatorId]);
    if (!res.rows[0]) throw new TpsError(`originator ${originatorId} not found`, 'TPS_NOT_FOUND', 404);
    return mapOriginator(res.rows[0]);
  },

  async originators() {
    const res = await pool.query('SELECT * FROM tps_originators ORDER BY created_at DESC');
    return res.rows.map(mapOriginator);
  },

  async defaultOriginator() {
    const res = await pool.query('SELECT * FROM tps_originators WHERE is_default = TRUE ORDER BY created_at DESC LIMIT 1');
    return mapOriginator(res.rows[0]);
  },

  /** What still blocks an Originator from approval. Empty means approvable. */
  originatorApprovalBlockers(o, agreement) {
    const blockers = [];
    if (!o.agreementId) blockers.push('no ODFI agreement linked');
    else if (!agreement || agreement.status !== 'executed') blockers.push(`ODFI agreement is ${agreement ? agreement.status : 'missing'}, not executed`);
    if (!o.originatorAgreementRef) blockers.push('no Originator agreement reference (Nacha §2.2.2)');
    if (!o.riskRating) blockers.push('risk rating not assigned');
    if (!['cleared', 'approved', 'clear', 'passed'].includes(String(o.sanctionsStatus || '').toLowerCase())) blockers.push(`sanctions screening is '${o.sanctionsStatus}'`);
    const controlPersons = (o.kyb && (o.kyb.controlPersons || o.kyb.control_persons)) || [];
    const owners = (o.kyb && (o.kyb.beneficialOwners || o.kyb.beneficial_owners)) || [];
    if (o.entityType !== 'individual' && !controlPersons.length) blockers.push('KYB missing control persons (trustees / officers)');
    if (['llc', 'corporation', 'nested_third_party_sender'].includes(o.entityType) && !owners.length) blockers.push('KYB missing beneficial owners (25%+)');
    if (o.isNestedTps && !(o.nestedDisclosure && o.nestedDisclosure.originators && o.nestedDisclosure.originators.length)) blockers.push('nested TPS disclosure incomplete');
    if (agreement && agreement.secCodes.length) {
      const outside = o.secCodes.filter(c => !agreement.secCodes.includes(c));
      if (outside.length) blockers.push(`SEC codes ${outside.join(',')} not permitted under ODFI agreement`);
    }
    if (agreement && agreement.dailyLimitCents !== null && o.dailyLimitCents !== null && o.dailyLimitCents > agreement.dailyLimitCents) blockers.push('Originator daily limit exceeds ODFI daily limit');
    if (agreement && agreement.exposureLimitCents !== null && o.exposureLimitCents !== null && o.exposureLimitCents > agreement.exposureLimitCents) blockers.push('Originator exposure limit exceeds ODFI exposure limit');
    return blockers;
  },

  /** Four-eyes approval: the approver may not be the person who onboarded. */
  async approveOriginator(originatorId, { approvedBy, reviewIntervalMonths = 12 } = {}) {
    if (!approvedBy) throw new TpsError('approvedBy is required', 'TPS_INVALID', 400);
    const o = await this.originator(originatorId);
    if (o.status === 'terminated') throw new TpsError('originator is terminated', 'TPS_STATE', 409);
    if (o.onboardedBy && String(o.onboardedBy).toLowerCase() === String(approvedBy).toLowerCase()) {
      throw new TpsError('approval requires a second person (four-eyes): approver cannot be the onboarder', 'TPS_FOUR_EYES', 403);
    }
    const agreement = o.agreementId ? await this.agreement(o.agreementId) : null;
    const blockers = this.originatorApprovalBlockers(o, agreement);
    if (blockers.length) throw new TpsError('originator cannot be approved yet', 'TPS_APPROVAL_BLOCKED', 409, { blockers });
    const nextReview = new Date();
    nextReview.setUTCMonth(nextReview.getUTCMonth() + Math.max(1, Number(reviewIntervalMonths) || 12));
    await pool.query(
      `UPDATE tps_originators SET status = 'approved', approved_by = $2, approved_at = NOW(), next_review_at = $3 WHERE originator_id = $1`,
      [originatorId, approvedBy, nextReview.toISOString().slice(0, 10)]
    );
    await this._event('originator', originatorId, 'originator_approved', approvedBy, { nextReviewAt: nextReview.toISOString().slice(0, 10) });
    return this.originator(originatorId);
  },

  async updateOriginator(originatorId, patch = {}) {
    const { sanctionsStatus, riskRating, originatorAgreementRef, kyb, agreementId, dailyLimitCents, exposureLimitCents, isDefault, actor = null } = patch;
    const o = await this.originator(originatorId);
    if (riskRating !== undefined && riskRating !== null && !RISK_RATINGS.includes(riskRating)) throw new TpsError('riskRating must be low, medium or high', 'TPS_INVALID', 400);
    if (agreementId) await this.agreement(agreementId);
    const next = {
      sanctions_status: sanctionsStatus !== undefined ? sanctionsStatus : o.sanctionsStatus,
      risk_rating: riskRating !== undefined ? riskRating : o.riskRating,
      originator_agreement_ref: originatorAgreementRef !== undefined ? originatorAgreementRef : o.originatorAgreementRef,
      kyb: JSON.stringify(kyb !== undefined ? { ...o.kyb, ...kyb } : o.kyb),
      agreement_id: agreementId !== undefined ? agreementId : o.agreementId,
      daily_limit_cents: dailyLimitCents !== undefined ? cents(dailyLimitCents, 'dailyLimitCents') : o.dailyLimitCents,
      exposure_limit_cents: exposureLimitCents !== undefined ? cents(exposureLimitCents, 'exposureLimitCents') : o.exposureLimitCents,
      is_default: isDefault !== undefined ? Boolean(isDefault) : o.isDefault,
    };
    // Any change to the diligence record re-opens approval.
    const reopens = o.status === 'approved' && (sanctionsStatus !== undefined || kyb !== undefined || agreementId !== undefined || riskRating !== undefined);
    await pool.query(
      `UPDATE tps_originators SET sanctions_status = $2, risk_rating = $3, originator_agreement_ref = $4, kyb = $5::jsonb, agreement_id = $6,
         daily_limit_cents = $7, exposure_limit_cents = $8, is_default = $9, status = $10 WHERE originator_id = $1`,
      [originatorId, next.sanctions_status, next.risk_rating, next.originator_agreement_ref, next.kyb, next.agreement_id,
        next.daily_limit_cents, next.exposure_limit_cents, next.is_default, reopens ? 'onboarding' : o.status]
    );
    await this._event('originator', originatorId, reopens ? 'originator_reopened' : 'originator_updated', actor, { fields: Object.keys(patch).filter(k => k !== 'actor' && patch[k] !== undefined) });
    return this.originator(originatorId);
  },

  async setOriginatorStatus(originatorId, status, { actor = null, reason = null } = {}) {
    if (!['suspended', 'terminated'].includes(status)) throw new TpsError('status must be suspended or terminated', 'TPS_INVALID', 400);
    await this.originator(originatorId);
    await pool.query('UPDATE tps_originators SET status = $2 WHERE originator_id = $1', [originatorId, status]);
    await this._event('originator', originatorId, `originator_${status}`, actor, { reason });
    return this.originator(originatorId);
  },

  // ── Exposure ───────────────────────────────────────────────────────────────

  async recordExposure({ originatorId, batchRef = null, direction = 'credit', secCode = null, amountCents, entryCount = 1, effectiveDate = null }) {
    if (!['credit', 'debit'].includes(direction)) throw new TpsError('direction must be credit or debit', 'TPS_INVALID', 400);
    const amt = cents(amountCents, 'amountCents');
    if (amt === null) throw new TpsError('amountCents is required', 'TPS_INVALID', 400);
    await this.originator(originatorId);
    const exposureId = newId('EXP');
    await pool.query(
      `INSERT INTO tps_exposure (exposure_id, originator_id, batch_ref, direction, sec_code, amount_cents, entry_count, effective_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [exposureId, originatorId, batchRef, direction, secCode ? String(secCode).toUpperCase() : null, amt, Math.max(1, Number(entryCount) || 1), isoDate(effectiveDate) || new Date().toISOString().slice(0, 10)]
    );
    return { exposureId, originatorId, batchRef, direction, amountCents: amt };
  },

  /** Today's and rolling-window usage against Originator and ODFI limits. */
  async exposureSnapshot(originatorId, { asOf = new Date(), additionalCents = 0 } = {}) {
    const o = await this.originator(originatorId);
    const agreement = o.agreementId ? await this.agreement(o.agreementId) : null;
    const windowDays = agreement ? agreement.exposureWindowDays : 2;
    const today = new Date(asOf).toISOString().slice(0, 10);
    const windowStart = new Date(new Date(asOf).getTime() - (windowDays - 1) * 86400000).toISOString().slice(0, 10);
    const res = await pool.query(
      `SELECT effective_date, SUM(amount_cents) AS total FROM tps_exposure WHERE originator_id = $1 AND effective_date >= $2 GROUP BY effective_date`,
      [originatorId, windowStart]
    );
    let todayCents = 0; let windowCents = 0;
    for (const r of res.rows) {
      const t = Number(r.total);
      windowCents += t;
      if (String(r.effective_date).slice(0, 10) === today) todayCents += t;
    }
    const dailyLimit = o.dailyLimitCents !== null ? o.dailyLimitCents : (agreement ? agreement.dailyLimitCents : null);
    const exposureLimit = o.exposureLimitCents !== null ? o.exposureLimitCents : (agreement ? agreement.exposureLimitCents : null);
    const projectedToday = todayCents + additionalCents;
    const projectedWindow = windowCents + additionalCents;
    return {
      originatorId, asOf: today, windowDays, todayCents, windowCents, dailyLimitCents: dailyLimit, exposureLimitCents: exposureLimit,
      dailyRemainingCents: dailyLimit === null ? null : Math.max(0, dailyLimit - todayCents),
      exposureRemainingCents: exposureLimit === null ? null : Math.max(0, exposureLimit - windowCents),
      breaches: [
        ...(dailyLimit !== null && projectedToday > dailyLimit ? [{ limit: 'daily', limitCents: dailyLimit, projectedCents: projectedToday }] : []),
        ...(exposureLimit !== null && projectedWindow > exposureLimit ? [{ limit: 'exposure', limitCents: exposureLimit, projectedCents: projectedWindow }] : []),
      ],
    };
  },

  // ── Returns ────────────────────────────────────────────────────────────────

  async recordReturn({ originatorId, batchRef = null, returnCode, amountCents = 0, returnedAt = new Date() }) {
    if (!returnCode) throw new TpsError('returnCode is required', 'TPS_INVALID', 400);
    await this.originator(originatorId);
    const category = returnCategory(returnCode);
    const returnId = newId('RET');
    await pool.query(
      `INSERT INTO tps_returns (return_id, originator_id, batch_ref, return_code, category, amount_cents, returned_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [returnId, originatorId, batchRef, String(returnCode).toUpperCase(), category, cents(amountCents, 'amountCents') || 0, new Date(returnedAt).toISOString()]
    );
    await this._event('originator', originatorId, 'return_recorded', null, { returnId, returnCode, category, batchRef });
    return { returnId, originatorId, returnCode: String(returnCode).toUpperCase(), category };
  },

  /**
   * Return rates over a trailing window against §2.17.2 thresholds. Rates are
   * computed against debit entries, which is what the rule measures; if the
   * Originator has only sent credits the rate is 0 and no threshold applies.
   */
  async returnRates(originatorId, { days = 60 } = {}) {
    await this.originator(originatorId);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const [debits, returns] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(entry_count), 0) AS entries FROM tps_exposure WHERE originator_id = $1 AND direction = 'debit' AND recorded_at >= $2`, [originatorId, since]),
      pool.query(`SELECT category, COUNT(*) AS n FROM tps_returns WHERE originator_id = $1 AND returned_at >= $2 GROUP BY category`, [originatorId, since]),
    ]);
    const debitEntries = Number(debits.rows[0] ? debits.rows[0].entries : 0);
    const counts = { unauthorized: 0, administrative: 0, overall: 0 };
    for (const r of returns.rows) counts[r.category] = Number(r.n);
    const totalReturns = counts.unauthorized + counts.administrative + counts.overall;
    const bps = (n) => (debitEntries > 0 ? Math.round((n / debitEntries) * 10000) : 0);
    const rates = {
      unauthorized: { count: counts.unauthorized, bps: bps(counts.unauthorized), thresholdBps: RETURN_THRESHOLDS_BPS.unauthorized },
      administrative: { count: counts.administrative, bps: bps(counts.administrative), thresholdBps: RETURN_THRESHOLDS_BPS.administrative },
      overall: { count: totalReturns, bps: bps(totalReturns), thresholdBps: RETURN_THRESHOLDS_BPS.overall },
    };
    const breaches = RETURN_CATEGORIES.filter(c => debitEntries > 0 && rates[c].bps > rates[c].thresholdBps);
    return { originatorId, windowDays: days, debitEntries, rates, breaches };
  },

  // ── Obligations (compliance calendar) ──────────────────────────────────────

  async seedObligations({ owner = null, actor = null } = {}) {
    await this.ensureTables();
    const existing = await pool.query('SELECT key FROM tps_obligations WHERE status = $1', ['open']);
    const openKeys = new Set(existing.rows.map(r => r.key));
    const created = [];
    for (const def of DEFAULT_OBLIGATIONS) {
      if (openKeys.has(def.key)) continue;
      const obligationId = newId('OBL');
      await pool.query(
        `INSERT INTO tps_obligations (obligation_id, key, rule_ref, title, cadence, mandatory, owner, due_at, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open')`,
        [obligationId, def.key, def.ruleRef, def.title, def.cadence, def.mandatory, owner, nextDue(def.dueMonthDay)]
      );
      created.push(obligationId);
    }
    if (created.length) await this._event('obligation', null, 'obligations_seeded', actor, { created: created.length });
    return this.obligations();
  },

  async obligations({ status = null } = {}) {
    const res = status
      ? await pool.query('SELECT * FROM tps_obligations WHERE status = $1 ORDER BY due_at ASC', [status])
      : await pool.query('SELECT * FROM tps_obligations ORDER BY due_at ASC');
    const today = new Date().toISOString().slice(0, 10);
    return res.rows.map(mapObligation).map(o => ({ ...o, overdue: o.status === 'open' && String(o.dueAt).slice(0, 10) < today }));
  },

  /** Completing an obligation records the evidence and schedules the next occurrence. */
  async completeObligation(obligationId, { completedBy, evidence = {} } = {}) {
    if (!completedBy) throw new TpsError('completedBy is required', 'TPS_INVALID', 400);
    const res = await pool.query('SELECT * FROM tps_obligations WHERE obligation_id = $1', [obligationId]);
    const o = mapObligation(res.rows[0]);
    if (!o) throw new TpsError(`obligation ${obligationId} not found`, 'TPS_NOT_FOUND', 404);
    if (o.status !== 'open') throw new TpsError(`obligation is ${o.status}`, 'TPS_STATE', 409);
    await pool.query(
      `UPDATE tps_obligations SET status = 'completed', completed_at = NOW(), completed_by = $2, evidence = $3::jsonb WHERE obligation_id = $1`,
      [obligationId, completedBy, JSON.stringify(evidence || {})]
    );
    const months = o.cadence === 'annual' ? 12 : o.cadence === 'semi_annual' ? 6 : o.cadence === 'quarterly' ? 3 : o.cadence === 'monthly' ? 1 : 0;
    let next = null;
    if (months) {
      const due = new Date(o.dueAt);
      due.setUTCMonth(due.getUTCMonth() + months);
      next = newId('OBL');
      await pool.query(
        `INSERT INTO tps_obligations (obligation_id, key, rule_ref, title, cadence, mandatory, owner, due_at, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open')`,
        [next, o.key, o.ruleRef, o.title, o.cadence, o.mandatory, o.owner, due.toISOString().slice(0, 10)]
      );
    }
    await this._event('obligation', obligationId, 'obligation_completed', completedBy, { key: o.key, nextObligationId: next });
    return { completed: obligationId, next };
  },

  // ── Preflight ──────────────────────────────────────────────────────────────

  /**
   * The question the ACH pipeline asks before a file leaves. Never throws for
   * a compliance failure — it returns `allowed: false` with the blockers so
   * the caller can refuse with the reasons and the register can log it.
   */
  async preflight({ originatorId = null, secCode = 'CCD', amountCents = 0, entryCount = 1, direction = 'credit', sameDay = false, batchRef = null, actor = null } = {}) {
    await this.ensureTables();
    const blockers = [];
    const warnings = [];
    const code = String(secCode || 'CCD').toUpperCase();
    const overdue = (await this.obligations({ status: 'open' })).filter(x => x.overdue && x.mandatory);
    for (const x of overdue) blockers.push(`overdue mandatory obligation: ${x.title} (${x.ruleRef}, due ${String(x.dueAt).slice(0, 10)})`);
    const o = originatorId ? await this.originator(originatorId).catch(() => null) : await this.defaultOriginator();
    if (!o) {
      blockers.push(originatorId ? `originator ${originatorId} not found` : 'no default Originator designated');
      return this._preflightResult({ allowed: false, blockers, warnings, originator: null, agreement: null, batchRef, actor });
    }
    if (o.status !== 'approved') blockers.push(`originator ${o.legalName} is ${o.status}, not approved`);
    const agreement = o.agreementId ? await this.agreement(o.agreementId).catch(() => null) : null;
    if (!agreement) blockers.push('no ODFI agreement linked to originator');
    else {
      if (agreement.status !== 'executed') blockers.push(`ODFI agreement with ${agreement.odfiName} is ${agreement.status}`);
      if (!agreement.tpsRegistered) blockers.push('Third-Party Sender not registered with Nacha by ODFI (§2.17.3)');
      if (agreement.expiresAt && String(agreement.expiresAt).slice(0, 10) < new Date().toISOString().slice(0, 10)) blockers.push('ODFI agreement expired');
      if (agreement.secCodes.length && !agreement.secCodes.includes(code)) blockers.push(`SEC code ${code} not permitted under ODFI agreement`);
      if (sameDay && !agreement.sameDayAllowed) blockers.push('Same Day ACH not permitted under ODFI agreement');
    }
    if (o.secCodes.length && !o.secCodes.includes(code)) blockers.push(`SEC code ${code} not permitted for originator`);
    if (o.nextReviewAt && String(o.nextReviewAt).slice(0, 10) < new Date().toISOString().slice(0, 10)) warnings.push('originator periodic review overdue');

    const amt = Number(amountCents) || 0;
    const exposure = await this.exposureSnapshot(o.originatorId, { additionalCents: amt });
    for (const b of exposure.breaches) blockers.push(`${b.limit} limit ${b.limitCents} exceeded (projected ${b.projectedCents})`);

    const returns = await this.returnRates(o.originatorId);
    if (returns.breaches.length) blockers.push(`return-rate threshold breached: ${returns.breaches.join(', ')} (Nacha §2.17.2)`);

    return this._preflightResult({ allowed: blockers.length === 0, blockers, warnings, originator: o, agreement, exposure, returns, batchRef, actor, request: { secCode: code, amountCents: amt, entryCount, direction, sameDay } });
  },

  async _preflightResult(r) {
    await this._event('preflight', r.batchRef, r.allowed ? 'preflight_passed' : 'preflight_blocked', r.actor, { blockers: r.blockers, warnings: r.warnings, originatorId: r.originator ? r.originator.originatorId : null, request: r.request || null });
    return {
      allowed: r.allowed, enforced: enforced(), blockers: r.blockers, warnings: r.warnings,
      originator: r.originator ? { originatorId: r.originator.originatorId, legalName: r.originator.legalName, status: r.originator.status, riskRating: r.originator.riskRating } : null,
      agreement: r.agreement ? { agreementId: r.agreement.agreementId, odfiName: r.agreement.odfiName, status: r.agreement.status, tpsRegistered: r.agreement.tpsRegistered } : null,
      exposure: r.exposure || null, returns: r.returns || null,
    };
  },

  /**
   * Called by the ACH pipeline. Advisory unless TPS_OS_ENFORCE=true, in which
   * case a blocked preflight refuses transmission.
   */
  async gateTransmission(batch, { actor = null } = {}) {
    const result = await this.preflight({
      originatorId: batch.originator_id || batch.originatorId || null,
      secCode: batch.sec_code || batch.secCode || 'CCD',
      amountCents: Number(batch.total_amount_cents || batch.totalAmountCents || 0),
      entryCount: Number(batch.entry_count || batch.entryCount || 1),
      direction: 'credit',
      batchRef: batch.batch_id || batch.batchId || null,
      actor,
    });
    if (!result.allowed && enforced()) {
      throw new TpsError('Third-Party Sender preflight refused transmission', 'TPS_PREFLIGHT_BLOCKED', 409, { blockers: result.blockers });
    }
    return result;
  },

  // ── Status ─────────────────────────────────────────────────────────────────

  async status() {
    await this.ensureTables();
    const [agreements, originators, obligations] = await Promise.all([this.agreements(), this.originators(), this.obligations()]);
    const executed = agreements.filter(a => a.status === 'executed');
    const approved = originators.filter(o => o.status === 'approved');
    const open = obligations.filter(o => o.status === 'open');
    const overdue = open.filter(o => o.overdue);
    const readinessBlockers = [];
    if (!executed.length) readinessBlockers.push('no executed ODFI origination agreement');
    if (executed.length && !executed.some(a => a.tpsRegistered)) readinessBlockers.push('ODFI has not registered the PTC as a Third-Party Sender');
    if (!approved.length) readinessBlockers.push('no approved Originator');
    if (!originators.some(o => o.isDefault)) readinessBlockers.push('no default Originator designated for the ACH pipeline');
    if (!obligations.length) readinessBlockers.push('compliance calendar not seeded');
    if (overdue.some(o => o.mandatory)) readinessBlockers.push(`${overdue.filter(o => o.mandatory).length} mandatory obligation(s) overdue`);
    return {
      engine: 'third-party-sender-os',
      role: { thirdPartySender: 'Private Trust Company (PTC)', originators: 'trust / trust-owned entities', odfi: executed.map(a => a.odfiName) },
      enforced: enforced(),
      readiness: { ready: readinessBlockers.length === 0, blockers: readinessBlockers },
      agreements: { total: agreements.length, executed: executed.length, items: agreements.map(a => ({ agreementId: a.agreementId, odfiName: a.odfiName, status: a.status, tpsRegistered: a.tpsRegistered, transport: a.transport, secCodes: a.secCodes, dailyLimitCents: a.dailyLimitCents, exposureLimitCents: a.exposureLimitCents })) },
      originators: { total: originators.length, approved: approved.length, items: originators.map(o => ({ originatorId: o.originatorId, legalName: o.legalName, entityType: o.entityType, status: o.status, riskRating: o.riskRating, sanctionsStatus: o.sanctionsStatus, isDefault: o.isDefault, isNestedTps: o.isNestedTps, nextReviewAt: o.nextReviewAt })) },
      obligations: { open: open.length, overdue: overdue.length, items: open },
      thresholds: { returnRatesBps: RETURN_THRESHOLDS_BPS, secCodes: SEC_CODES },
      governance: { approval: 'four-eyes (approver ≠ onboarder)', policyChanges: 'majority trustee consent + written authorization', reviewCadence: 'annual Originator review; semi-annual policy review' },
    };
  },

  async events({ subjectId = null, limit = 100 } = {}) {
    const res = subjectId
      ? await pool.query('SELECT * FROM tps_events WHERE subject_id = $1 ORDER BY created_at DESC LIMIT $2', [subjectId, Math.min(500, Number(limit) || 100)])
      : await pool.query('SELECT * FROM tps_events ORDER BY created_at DESC LIMIT $1', [Math.min(500, Number(limit) || 100)]);
    return res.rows.map(r => ({ eventId: r.event_id, subjectType: r.subject_type, subjectId: r.subject_id, eventType: r.event_type, actor: r.actor, detail: parseJson(r.detail, {}), createdAt: r.created_at }));
  },

  async _event(subjectType, subjectId, eventType, actor, detail) {
    await pool.query(
      'INSERT INTO tps_events (event_id, subject_type, subject_id, event_type, actor, detail) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
      [newId('TPSEV'), subjectType, subjectId, eventType, actor, JSON.stringify(detail || {})]
    );
  },
};

module.exports = {
  TpsOsEngine, TpsError, enforced, returnCategory, nextDue,
  AGREEMENT_STATUSES, ORIGINATOR_STATUSES, ENTITY_TYPES, RISK_RATINGS, SEC_CODES, RETURN_THRESHOLDS_BPS, DEFAULT_OBLIGATIONS,
};
