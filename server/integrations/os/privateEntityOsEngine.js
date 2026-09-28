'use strict';

/**
 * Private Entity OS — the trustee-declared operating profile of the family
 * trust company, and the platform's evidence that it operates inside it.
 *
 * The trustees declare (register) the profile: a private, non-public family
 * trust company organised under Ohio Revised Code Chapters 1111–1112 as the
 * trustees understand them, serving one family across generations, not
 * licensed and not regulated as a public trust company, non-depository,
 * income-support only (no asset sales), settling family distributions over
 * the Private Electronic Payment Network only. A second trustee attests.
 *
 * Readiness then checks that the running platform actually matches the
 * declaration: IAP-enforced private access with a family allow-list and no
 * public invoker; PPN family-only with Stripe/card rails excluded; no public
 * onboarding surface; no deposit-taking or asset-sale capability enabled;
 * the tax entity (EIN, trust name) configured; two distinct attestations.
 *
 * What this engine is not: a filing, a licence, or a legal opinion. Recording
 * a profile here does not establish legal status, an exemption, or compliance;
 * it records what the trustees declared and whether the software honours it.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');

const ENTITY_TYPE = 'family_trust_company';
const JURISDICTION = 'US-OH';
const STATUTE_REFERENCE = 'Ohio Revised Code Chapters 1111-1112 (as declared by the trustees)';
const FAMILY_SCOPE = 'single_family_multigenerational';
const SETTLEMENT_RAIL = 'private-payment-network';
const REQUIRED_ATTESTATIONS = 2;

const DECLARATIONS = {
  private_non_public: 'Private entity: no public customers, no public onboarding, no advertising of trust services.',
  single_family: 'Serves one family only: trustees, beneficiaries and family members of the DEANDREA LAVAR BARKLEY FAMILY TRUST.',
  multigenerational: 'Multigenerational scope: beneficiaries across generations of the same family.',
  unlicensed_unregulated: 'Not licensed or regulated as a public trust company; trustees rely on Ohio ORC 1111-1112 for the family trust company form.',
  non_depository: 'Non-depository: takes no deposits from anyone; the trust account of record is a Fineract core-banking record of the trust\'s own funds.',
  income_support_only: 'Income support only: corpus is not sold or distributed; distributions come from interest and coupon income.',
  family_only_settlement: 'Distributions and disbursements settle on the Private Electronic Payment Network between family sub-accounts; no public payment processor.',
  not_legal_advice: 'The platform records the trustees\' declaration; it does not establish legal status, an exemption or compliance.',
};

class PrivateEntityError extends Error {
  constructor(message, code = 'PRIVATE_ENTITY_ERROR', status = 409, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function isTrue(v, dflt = false) {
  const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  if (!s) return dflt;
  return s === 'true' || s === '1' || s === 'yes';
}

function newId(prefix) { return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }
function normalizeActor(a) { return String(a || '').trim().toLowerCase() || null; }

function getPrivateEntityConfig(env = process.env) {
  return {
    enabled: isTrue(env.PRIVATE_ENTITY_ENABLED, true),
    live: isTrue(env.PRIVATE_ENTITY_LIVE),
    entityName: String(env.PRIVATE_ENTITY_NAME || 'DEANDREA LAVAR BARKLEY TRUST COMPANY').trim(),
    familyName: String(env.PRIVATE_ENTITY_FAMILY_NAME || 'BARKLEY').trim(),
    entityType: ENTITY_TYPE,
    jurisdiction: JURISDICTION,
    statuteReference: STATUTE_REFERENCE,
    familyScope: FAMILY_SCOPE,
    settlementRail: SETTLEMENT_RAIL,
    requiredAttestations: Math.max(1, Number(env.PRIVATE_ENTITY_REQUIRED_ATTESTATIONS) || REQUIRED_ATTESTATIONS),
    publicOnboarding: isTrue(env.PUBLIC_ONBOARDING_ENABLED),
    depositTaking: isTrue(env.DEPOSIT_TAKING_ENABLED),
    assetSales: isTrue(env.ASSET_SALES_ENABLED),
  };
}

function tryRequire(mod) { try { return require(mod); } catch { return null; } }

const PrivateEntityOsEngine = {
  Error: PrivateEntityError,
  getConfig: getPrivateEntityConfig,
  DECLARATIONS,
  ENTITY_TYPE,
  JURISDICTION,
  STATUTE_REFERENCE,
  FAMILY_SCOPE,

  async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS private_entity_profile (
        profile_id        VARCHAR(64) PRIMARY KEY,
        version           INTEGER NOT NULL,
        entity_name       TEXT NOT NULL,
        entity_type       VARCHAR(48) NOT NULL,
        jurisdiction      VARCHAR(16) NOT NULL,
        statute_reference TEXT NOT NULL,
        family_name       TEXT NOT NULL,
        family_scope      VARCHAR(48) NOT NULL,
        settlement_rail   VARCHAR(48) NOT NULL,
        declarations      JSONB NOT NULL DEFAULT '{}'::jsonb,
        designated_family_member TEXT,
        registered_by     VARCHAR(128) NOT NULL,
        status            VARCHAR(24) NOT NULL DEFAULT 'declared',
        superseded_at     TIMESTAMPTZ,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS private_entity_attestations (
        attestation_id  VARCHAR(64) PRIMARY KEY,
        profile_id      VARCHAR(64) NOT NULL REFERENCES private_entity_profile(profile_id) ON DELETE CASCADE,
        attested_by     VARCHAR(128) NOT NULL,
        role            VARCHAR(32) NOT NULL DEFAULT 'trustee',
        statement       TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (profile_id, attested_by)
      )`);
  },

  async current() {
    if (!pool) return null;
    const r = await pool.query("SELECT * FROM private_entity_profile WHERE superseded_at IS NULL ORDER BY version DESC LIMIT 1");
    const p = r.rows[0];
    if (!p) return null;
    const a = await pool.query('SELECT attestation_id, attested_by, role, statement, created_at FROM private_entity_attestations WHERE profile_id = $1 ORDER BY created_at', [p.profile_id]);
    return { ...p, attestations: a.rows };
  },

  /** register: a trustee declares (or re-declares, superseding) the operating profile. */
  async register({ designatedFamilyMember = null, entityName = null, familyName = null, actor = null } = {}) {
    const cfg = getPrivateEntityConfig();
    if (!cfg.enabled) throw new PrivateEntityError('PRIVATE_ENTITY_ENABLED=false', 'PRIVATE_ENTITY_DISABLED', 503);
    if (!pool) throw new PrivateEntityError('ledger database not connected', 'PRIVATE_ENTITY_DB', 503);
    const a = normalizeActor(actor);
    if (!a) throw new PrivateEntityError('trustee identity required', 'PRIVATE_ENTITY_ACTOR', 401);
    const prev = await this.current();
    const version = prev ? prev.version + 1 : 1;
    const profileId = newId('PENT');
    if (prev) await pool.query('UPDATE private_entity_profile SET superseded_at = NOW(), status = $2 WHERE profile_id = $1', [prev.profile_id, 'superseded']);
    await pool.query(
      `INSERT INTO private_entity_profile (profile_id, version, entity_name, entity_type, jurisdiction, statute_reference, family_name, family_scope, settlement_rail, declarations, designated_family_member, registered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [profileId, version, entityName || cfg.entityName, cfg.entityType, cfg.jurisdiction, cfg.statuteReference, familyName || cfg.familyName, cfg.familyScope, cfg.settlementRail, JSON.stringify(DECLARATIONS), designatedFamilyMember, a]
    );
    await pool.query(
      'INSERT INTO private_entity_attestations (attestation_id, profile_id, attested_by, role, statement) VALUES ($1,$2,$3,$4,$5)',
      [newId('PATT'), profileId, a, 'trustee', 'Registered the private entity profile and attests to its declarations.']
    );
    return this.current();
  },

  /** attest: a second, distinct trustee countersigns the current profile. */
  async attest({ statement = null, actor = null } = {}) {
    const a = normalizeActor(actor);
    if (!a) throw new PrivateEntityError('trustee identity required', 'PRIVATE_ENTITY_ACTOR', 401);
    const p = await this.current();
    if (!p) throw new PrivateEntityError('no profile registered (action=register first)', 'PRIVATE_ENTITY_NOT_FOUND', 404);
    if (p.attestations.some((x) => normalizeActor(x.attested_by) === a)) throw new PrivateEntityError('this trustee has already attested to the current profile', 'PRIVATE_ENTITY_SAME_ACTOR', 409);
    await pool.query(
      'INSERT INTO private_entity_attestations (attestation_id, profile_id, attested_by, role, statement) VALUES ($1,$2,$3,$4,$5)',
      [newId('PATT'), p.profile_id, a, 'trustee', statement || 'Attests to the private entity declarations.']
    );
    const cfg = getPrivateEntityConfig();
    const cur = await this.current();
    if (cur.attestations.length >= cfg.requiredAttestations && cur.status !== 'attested') {
      await pool.query("UPDATE private_entity_profile SET status = 'attested' WHERE profile_id = $1", [cur.profile_id]);
      cur.status = 'attested';
    }
    return cur;
  },

  /** Does the running platform honour the declaration? Pure config checks, no I/O beyond the profile row. */
  audit(env = process.env) {
    const cfg = getPrivateEntityConfig(env);
    const Guard = tryRequire('../auth/privateAccessGuard');
    const Ppn = tryRequire('./privatePaymentNetworkOsEngine')?.PrivatePaymentNetworkOsEngine;
    const g = Guard ? Guard.status(env) : null;
    const ppn = Ppn ? Ppn.getConfig(env) : null;
    const checks = [
      { id: 'private_access_enforced', declaration: 'private_non_public', ok: Boolean(g && g.mode === 'enforce'), detail: g ? `PRIVATE_ACCESS_MODE=${g.mode}` : 'privateAccessGuard not loadable' },
      { id: 'iap_enabled', declaration: 'private_non_public', ok: isTrue(env.PRIVATE_ACCESS_IAP_ENABLED), detail: `PRIVATE_ACCESS_IAP_ENABLED=${env.PRIVATE_ACCESS_IAP_ENABLED || 'unset'}` },
      { id: 'no_public_invoker', declaration: 'private_non_public', ok: !isTrue(env.PRIVATE_ACCESS_PUBLIC_INVOKER), detail: `PRIVATE_ACCESS_PUBLIC_INVOKER=${env.PRIVATE_ACCESS_PUBLIC_INVOKER || 'false'}` },
      { id: 'family_identities_listed', declaration: 'single_family', ok: Boolean(g && (g.familyEmails || g.familyDomains)), detail: g ? `${g.familyEmails} family emails, ${g.familyDomains} domains` : 'n/a' },
      { id: 'no_public_onboarding', declaration: 'private_non_public', ok: !cfg.publicOnboarding, detail: `PUBLIC_ONBOARDING_ENABLED=${cfg.publicOnboarding}` },
      { id: 'ppn_family_only', declaration: 'family_only_settlement', ok: Boolean(ppn && ppn.familyOnly), detail: ppn ? `PRIVATE_PAYMENT_NETWORK_FAMILY_ONLY=${ppn.familyOnly}` : 'PPN not loadable' },
      { id: 'no_public_processor', declaration: 'family_only_settlement', ok: Boolean(ppn && ppn.excludedProcessors.some((p) => /^stripe/.test(p))), detail: ppn ? `excluded: ${ppn.excludedProcessors.join(',')}` : 'n/a' },
      { id: 'non_depository', declaration: 'non_depository', ok: !cfg.depositTaking && !isTrue(env.STRIPE_INTAKE_ENABLED) && !isTrue(env.TREASURY_BANK_ENABLED), detail: `DEPOSIT_TAKING_ENABLED=${cfg.depositTaking}, STRIPE_INTAKE_ENABLED=${env.STRIPE_INTAKE_ENABLED || 'false'}, TREASURY_BANK_ENABLED=${env.TREASURY_BANK_ENABLED || 'false'}` },
      { id: 'no_asset_sales', declaration: 'income_support_only', ok: !cfg.assetSales, detail: `ASSET_SALES_ENABLED=${cfg.assetSales}` },
      { id: 'no_onchain_rails', declaration: 'family_only_settlement', ok: !isTrue(env.SMART_ROUTER_LIVE) && !isTrue(env.NICKEL_LIVE) && !isTrue(env.TRUST_POLICY_LIVE), detail: `SMART_ROUTER_LIVE=${env.SMART_ROUTER_LIVE || 'false'}, NICKEL_LIVE=${env.NICKEL_LIVE || 'false'}, TRUST_POLICY_LIVE=${env.TRUST_POLICY_LIVE || 'false'}` },
    ];
    return { checks, failing: checks.filter((c) => !c.ok).map((c) => c.id) };
  },

  async status() {
    const cfg = getPrivateEntityConfig();
    const profile = await this.current().catch(() => null);
    let tax = { einConfigured: false, trustName: null, state: null };
    if (pool) {
      const r = await pool.query("SELECT config_key, config_value FROM trust_config WHERE config_key IN ('ein','trust_name','state')").catch(() => ({ rows: [] }));
      const c = Object.fromEntries(r.rows.map((x) => [x.config_key, x.config_value]));
      tax = { einConfigured: Boolean(c.ein), trustName: c.trust_name || null, state: c.state || null };
    }
    return {
      engine: 'private-entity',
      enabled: cfg.enabled,
      live: cfg.live,
      entity: { name: profile ? profile.entity_name : cfg.entityName, type: cfg.entityType, jurisdiction: cfg.jurisdiction, statuteReference: cfg.statuteReference, family: profile ? profile.family_name : cfg.familyName, familyScope: cfg.familyScope, settlementRail: cfg.settlementRail },
      declarations: DECLARATIONS,
      profile: profile ? { profileId: profile.profile_id, version: profile.version, status: profile.status, registeredBy: profile.registered_by, designatedFamilyMember: profile.designated_family_member, attestations: profile.attestations.map((a) => ({ by: a.attested_by, role: a.role, at: a.created_at })), createdAt: profile.created_at } : null,
      requiredAttestations: cfg.requiredAttestations,
      tax,
      audit: this.audit(),
      legalStatus: 'declared by trustees; not established by this software',
      movesMoney: false,
    };
  },

  async health() {
    const s = await this.status();
    return { ok: s.enabled, engine: 'private-entity', profile: Boolean(s.profile), failingChecks: s.audit.failing.length };
  },

  async readiness() {
    const s = await this.status();
    const blockers = [];
    if (!s.enabled) blockers.push('PRIVATE_ENTITY_ENABLED=false');
    if (!s.profile) blockers.push('no private entity profile registered (action=register by a trustee)');
    else if (s.profile.attestations.length < s.requiredAttestations) blockers.push(`profile has ${s.profile.attestations.length}/${s.requiredAttestations} trustee attestations (action=attest by a second trustee)`);
    for (const c of s.audit.checks) if (!c.ok) blockers.push(`${c.id}: ${c.detail}`);
    if (!s.tax.einConfigured) blockers.push('trust_config.ein not set');
    if (s.tax.state && s.tax.state !== 'OH') blockers.push(`trust_config.state=${s.tax.state}; declared jurisdiction is Ohio (PUT /api/tax/config/state)`);
    if (!s.live) blockers.push('PRIVATE_ENTITY_LIVE not true');
    const live = blockers.length === 0;
    return { ready: live, mode: live ? 'live' : 'shadow', blockers, status: s };
  },

  async list({ limit = 50 } = {}) {
    if (!pool) return [];
    const r = await pool.query('SELECT * FROM private_entity_profile ORDER BY version DESC LIMIT $1', [Math.min(500, Math.max(1, Number(limit) || 50))]);
    return r.rows;
  },

  async get(profileId) {
    if (!pool) return null;
    const r = await pool.query('SELECT * FROM private_entity_profile WHERE profile_id = $1', [profileId]);
    return r.rows[0] || null;
  },

  async process({ action, actor = null, ...body } = {}) {
    switch (action) {
      case 'register': return this.register({ ...body, actor });
      case 'attest': return this.attest({ ...body, actor });
      case 'audit': return this.audit();
      default: throw new PrivateEntityError(`Unknown action: ${action}`, 'PRIVATE_ENTITY_BAD_ACTION', 400);
    }
  },
};

module.exports = { PrivateEntityOsEngine, PrivateEntityError, getPrivateEntityConfig, DECLARATIONS };
