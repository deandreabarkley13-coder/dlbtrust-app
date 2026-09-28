'use strict';

/**
 * Enterprise ODFI OS (agentic originator operating system)
 *
 * The trust company is NOT a bank: an ODFI is a Fed-member depository
 * institution with ACH origination rights. This engine is the ORIGINATOR-side
 * operating system that runs the trust's relationship with its sponsor ODFI /
 * instant-payment participant for trust administration — distributions,
 * disbursements, vendor payouts and trustee expenses. It
 *
 *   1. keeps the originator profile (company name, company-ID last-4, SEC codes,
 *      exposure and same-day limits, sponsor ODFI network) as a maker/checker
 *      record: declared by one trustee, countersigned by a distinct trustee;
 *   2. takes approved + screened payout items (approvalRef + screeningRef from
 *      the PPN / distribution request / IDP-OCR review) and groups them into a
 *      batch; the agentic planner (Vertex AI Gemini on GCP when configured,
 *      deterministic rules otherwise) proposes a rail per item — family book
 *      transfer on the PPN, RTP/FedNow, same-day or standard ACH — with a
 *      rationale. The planner is ADVISORY: a deterministic validator re-checks
 *      every proposal (US-only, USD, admitted networks, limits, windows) and
 *      the batch cannot leave the box until a distinct trustee releases it;
 *   3. releases: each item is cleared and posted through the Clearing Agent OS
 *      (HMAC-signed, Egress-OS-authorised, Fineract-posted, idempotent);
 *   4. handles returns / NOCs: records the R-/C-code, re-deposits a returned
 *      posted item on the debtor's Fineract account, flags NOC corrections;
 *   5. reconciles: outstanding exposure vs. posted vs. returned.
 *
 * Item instructions (routing/account numbers) are stored AES-256-GCM encrypted
 * under PAYMENT_DATA_ENCRYPTION_KEY; API responses carry only last-4.
 * Profiles, plans and reconciliation never move money; only `release` does,
 * and only through a Clearing-Agent-verified network. The engine reports LIVE
 * only when a verified external (non-family) ODFI network exists.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { EgressOsEngine } = require('./egressOsEngine');
const { ClearingAgentOsEngine, canonicalize, redactPayload } = require('./clearingAgentOsEngine');
const { FineractClient } = require('../fineract/fineractClient');
const { getAccessToken, googleFetch, loadServiceAccount, onGoogleRuntime } = require('../google/googleServiceAccount');

const COUNTRY = 'US';
const PURPOSE_CLASSES = ['distribution', 'disbursement', 'vendor_payout', 'trustee_expense'];
const RAILS = ['family_book', 'rtp', 'fednow', 'ach_same_day', 'ach_standard'];
const SEC_CODES = ['PPD', 'CCD'];
const BATCH_STATES = ['planned', 'released', 'originated', 'partially_failed', 'cancelled'];
const ITEM_STATES = ['planned', 'cleared', 'posted', 'rejected', 'failed', 'returned', 'noc'];
const RETURN_CODE = /^R\d{2}$/;
const NOC_CODE = /^C\d{2}$/;
const VERTEX_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const EXTERNAL_KINDS = ['ach_operator', 'rtp_participant', 'fednow_participant'];
const RAIL_TO_KIND = { family_book: ['private_payment_network', 'book_transfer'], rtp: ['rtp_participant'], fednow: ['fednow_participant'], ach_same_day: ['ach_operator'], ach_standard: ['ach_operator'] };

class EnterpriseOdfiError extends Error {
  constructor(message, code, statusCode = 400, details = {}) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}
function bool(v, dflt = false) {
  if (v === undefined || v === null || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}
function normalizeActor(a) {
  return a ? String(a).trim().toLowerCase() : null;
}
function last4(s) {
  const d = String(s || '').replace(/\D/g, '');
  return d ? `${'*'.repeat(Math.max(0, d.length - 4))}${d.slice(-4)}` : null;
}

function getEnterpriseOdfiConfig(env = process.env) {
  return {
    enabled: bool(env.ENTERPRISE_ODFI_ENABLED, true),
    live: bool(env.ENTERPRISE_ODFI_LIVE, false),
    originatorId: env.ENTERPRISE_ODFI_ORIGINATOR_ID || 'DLB-TRUST-ORIGINATOR',
    requireDistinctReleaser: bool(env.ENTERPRISE_ODFI_REQUIRE_DISTINCT_RELEASER, true),
    exposureLimitCents: Math.max(0, Number(env.ENTERPRISE_ODFI_EXPOSURE_LIMIT_CENTS) || 25000000),
    sameDayLimitCents: Math.max(0, Number(env.ENTERPRISE_ODFI_SAME_DAY_LIMIT_CENTS) || 100000000),
    instantLimitCents: Math.max(0, Number(env.ENTERPRISE_ODFI_INSTANT_LIMIT_CENTS) || 100000000),
    maxBatchItems: Math.max(1, Number(env.ENTERPRISE_ODFI_MAX_BATCH_ITEMS) || 200),
    aiEnabled: bool(env.ENTERPRISE_ODFI_AI_ENABLED, false),
    aiProject: env.ENTERPRISE_ODFI_AI_PROJECT || env.GOOGLE_CLOUD_PROJECT || env.GCP_PROJECT || null,
    aiLocation: env.ENTERPRISE_ODFI_AI_LOCATION || 'us-east1',
    aiModel: env.ENTERPRISE_ODFI_AI_MODEL || 'gemini-2.0-flash',
    aiTimeoutMs: Math.max(1000, Number(env.ENTERPRISE_ODFI_AI_TIMEOUT_MS) || 20000),
    encryptionKeyConfigured: Boolean(env.PAYMENT_DATA_ENCRYPTION_KEY),
    familyOnly: bool(env.PRIVATE_PAYMENT_NETWORK_FAMILY_ONLY, false),
    makers: actorList(env.ENTERPRISE_ODFI_MAKERS),
    checkers: actorList(env.ENTERPRISE_ODFI_CHECKERS),
  };
}

/** Comma-separated trustee identities (portal usernames / emails); empty = any trustee may act in that role. */
function actorList(v) {
  return String(v || '').split(',').map((s) => normalizeActor(s)).filter(Boolean);
}
function assertRole(cfg, role, actor) {
  const list = role === 'maker' ? cfg.makers : cfg.checkers;
  if (list.length && !list.includes(normalizeActor(actor))) throw new EnterpriseOdfiError(`${actor} is not a designated ${role} (ENTERPRISE_ODFI_${role.toUpperCase()}S)`, 'ENTERPRISE_ODFI_ROLE', 403);
}
const RAIL_SPEED = { rtp: 'instant', fednow: 'instant', ach_same_day: 'same_day', ach_standard: 'standard', family_book: 'instant' };

// ─── Encryption at rest for item instructions ────────────────────────────────

function dataKey() {
  const k = process.env.PAYMENT_DATA_ENCRYPTION_KEY;
  if (!k) throw new EnterpriseOdfiError('PAYMENT_DATA_ENCRYPTION_KEY not set (instructions are stored encrypted)', 'ENTERPRISE_ODFI_NO_KEY', 503);
  return crypto.createHash('sha256').update(String(k)).digest();
}
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', dataKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
function decrypt(s) {
  const [v, iv, tag, ct] = String(s || '').split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new EnterpriseOdfiError('encrypted instruction malformed', 'ENTERPRISE_ODFI_CRYPTO', 500);
  const d = crypto.createDecipheriv('aes-256-gcm', dataKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8'));
}

/** What an API caller may see of an instruction: names, last-4, Fineract ids, amounts. */
function publicInstruction(ix) {
  const p = (x) => (x ? { name: x.name, routingNumber: x.routingNumber, accountLast4: last4(x.accountNumber), accountType: x.accountType || null, fineractAccountId: x.fineractAccountId || null, participantId: x.participantId || null } : null);
  return { endToEndId: ix.endToEndId, amountCents: ix.amountCents, currency: ix.currency, purpose: ix.purpose, secCode: ix.secCode, requestedExecutionDate: ix.requestedExecutionDate, debtor: p(ix.debtor), creditor: p(ix.creditor) };
}

// ─── Deterministic planner (rules) and agentic advisor (Vertex AI) ──────────

/** Which rails a network can carry, from its registered kind. */
function railsForNetwork(n) {
  const rails = RAILS.filter((r) => RAIL_TO_KIND[r].includes(n.kind));
  // TabaPay processes ACH (next/same-day) and RTP over one API regardless of the registered kind.
  if (n.capabilities && n.capabilities.adapter === 'tabapay') for (const r of ['rtp', 'ach_same_day', 'ach_standard']) if (!rails.includes(r)) rails.push(r);
  return rails;
}

/**
 * rulesPlan: the deterministic baseline. Family book transfers stay on the PPN;
 * external items prefer the fastest verified rail that respects the limits.
 */
function rulesPlan(item, networks, cfg) {
  const verified = networks.filter((n) => n.handshake_state === 'verified' && n.country === COUNTRY);
  const isFamily = Boolean(item.instruction.creditor.fineractAccountId);
  const cand = [];
  if (isFamily) cand.push('family_book');
  if (item.urgency === 'instant' && item.instruction.amountCents <= cfg.instantLimitCents) cand.push('rtp', 'fednow');
  if (item.urgency !== 'standard' && item.instruction.amountCents <= cfg.sameDayLimitCents) cand.push('ach_same_day');
  cand.push('ach_standard');
  for (const rail of cand) {
    const n = verified.find((x) => railsForNetwork(x).includes(rail));
    if (n) return { rail, networkId: n.network_id, rationale: `rules: ${rail} is the fastest verified US rail within limits for ${item.purposeClass}` };
  }
  return { rail: cand[0] || 'ach_standard', networkId: null, rationale: `rules: no verified network carries ${cand.join('/')}; release will be blocked` };
}

/** Validate an advisory proposal against the hard rules; returns the accepted plan or the rules plan. */
function acceptProposal(proposal, item, networks, cfg) {
  const base = rulesPlan(item, networks, cfg);
  if (!proposal || !RAILS.includes(proposal.rail)) return { ...base, advisor: 'rejected: unknown rail' };
  const n = networks.find((x) => x.network_id === proposal.networkId && x.handshake_state === 'verified' && x.country === COUNTRY);
  if (!n || !railsForNetwork(n).includes(proposal.rail)) return { ...base, advisor: 'rejected: network not verified for rail' };
  if (['rtp', 'fednow'].includes(proposal.rail) && item.instruction.amountCents > cfg.instantLimitCents) return { ...base, advisor: 'rejected: over instant limit' };
  if (proposal.rail === 'ach_same_day' && item.instruction.amountCents > cfg.sameDayLimitCents) return { ...base, advisor: 'rejected: over same-day limit' };
  if (proposal.rail === 'family_book' && !item.instruction.creditor.fineractAccountId) return { ...base, advisor: 'rejected: family_book needs creditor Fineract account' };
  return { rail: proposal.rail, networkId: n.network_id, rationale: String(proposal.rationale || '').slice(0, 300), advisor: 'accepted' };
}

async function vertexAdvise(items, networks, cfg) {
  if (!cfg.aiEnabled) return { provider: 'rules', proposals: null, note: 'ENTERPRISE_ODFI_AI_ENABLED not true' };
  if (!cfg.aiProject) return { provider: 'rules', proposals: null, note: 'ENTERPRISE_ODFI_AI_PROJECT not set' };
  const url = `https://${cfg.aiLocation}-aiplatform.googleapis.com/v1/projects/${cfg.aiProject}/locations/${cfg.aiLocation}/publishers/google/models/${cfg.aiModel}:generateContent`;
  try {
    await EgressOsEngine.authorize(url, { caller: 'enterprise-odfi', record: false });
    let sa = null;
    try { sa = loadServiceAccount({ keyEnv: 'ENTERPRISE_ODFI_SERVICE_ACCOUNT_KEY' }); } catch { sa = null; }
    if (!sa && !onGoogleRuntime()) return { provider: 'rules', proposals: null, note: 'no Google runtime identity for Vertex AI' };
    const token = await getAccessToken(sa, VERTEX_SCOPE);
    // Only non-sensitive fields leave the box: no account numbers, no names.
    const view = {
      networks: networks.filter((n) => n.handshake_state === 'verified').map((n) => ({ networkId: n.network_id, kind: n.kind, rails: railsForNetwork(n) })),
      limits: { instantLimitCents: cfg.instantLimitCents, sameDayLimitCents: cfg.sameDayLimitCents },
      items: items.map((it) => ({ itemId: it.itemId, purposeClass: it.purposeClass, urgency: it.urgency, amountCents: it.instruction.amountCents, familyCreditor: Boolean(it.instruction.creditor.fineractAccountId) })),
    };
    const prompt = `You are the routing advisor for a US family trust company's payment originator. For each item choose one rail from ${RAILS.join(', ')} and a networkId from the verified networks that carries it, respecting the limits. Family creditors with a Fineract account should use family_book on a private_payment_network. Reply ONLY with JSON: {"proposals":[{"itemId":"...","rail":"...","networkId":"...","rationale":"<=200 chars"}]}\n${JSON.stringify(view)}`;
    const res = await googleFetch('POST', url, token, {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    }, { timeoutMs: cfg.aiTimeoutMs });
    if (!res.ok) return { provider: 'rules', proposals: null, note: `Vertex AI HTTP ${res.statusCode}` };
    const text = res.json && res.json.candidates && res.json.candidates[0] && res.json.candidates[0].content && res.json.candidates[0].content.parts ? res.json.candidates[0].content.parts.map((p) => p.text || '').join('') : '';
    const parsed = JSON.parse(text);
    return { provider: 'vertex_ai', model: cfg.aiModel, proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [] };
  } catch (e) {
    return { provider: 'rules', proposals: null, note: `Vertex AI unavailable: ${e.message}` };
  }
}

async function planItems(items, cfg) {
  const networks = await ClearingAgentOsEngine.networks();
  const advice = await vertexAdvise(items, networks, cfg);
  const plans = items.map((it) => {
    const proposal = advice.proposals ? advice.proposals.find((p) => p && p.itemId === it.itemId) : null;
    const plan = advice.proposals ? acceptProposal(proposal, it, networks, cfg) : { ...rulesPlan(it, networks, cfg), advisor: 'n/a' };
    return { itemId: it.itemId, ...plan };
  });
  return { planner: advice.provider, model: advice.model || null, note: advice.note || null, plans };
}

// ─── Engine ──────────────────────────────────────────────────────────────────

const EnterpriseOdfiOsEngine = {
  name: 'enterprise-odfi',
  PURPOSE_CLASSES,
  RAILS,

  async ensureTables() {
    if (!pool) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS enterprise_odfi_profiles (
      originator_id      VARCHAR(64) PRIMARY KEY,
      company_name       TEXT NOT NULL,
      company_id_last4   VARCHAR(8),
      sec_codes          JSONB NOT NULL DEFAULT '["PPD","CCD"]'::jsonb,
      exposure_limit_cents BIGINT NOT NULL,
      same_day_limit_cents BIGINT NOT NULL,
      sponsor_network_id VARCHAR(64),
      agreement_ref      TEXT,
      declared_by        VARCHAR(128) NOT NULL,
      countersigned_by   VARCHAR(128),
      countersigned_at   TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS enterprise_odfi_batches (
      batch_id       VARCHAR(64) PRIMARY KEY,
      purpose_class  VARCHAR(32) NOT NULL,
      status         VARCHAR(24) NOT NULL DEFAULT 'planned',
      item_count     INT NOT NULL,
      total_cents    BIGINT NOT NULL,
      planner        VARCHAR(32) NOT NULL,
      plan_note      TEXT,
      planned_by     VARCHAR(128) NOT NULL,
      released_by    VARCHAR(128),
      released_at    TIMESTAMPTZ,
      error          TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS enterprise_odfi_items (
      item_id          VARCHAR(64) PRIMARY KEY,
      batch_id         VARCHAR(64) NOT NULL,
      idempotency_key  VARCHAR(128) NOT NULL UNIQUE,
      purpose_class    VARCHAR(32) NOT NULL,
      urgency          VARCHAR(16) NOT NULL DEFAULT 'standard',
      status           VARCHAR(16) NOT NULL DEFAULT 'planned',
      amount_cents     BIGINT NOT NULL,
      creditor_name    TEXT,
      creditor_last4   VARCHAR(8),
      debtor_fineract_id VARCHAR(32),
      creditor_fineract_id VARCHAR(32),
      instruction_enc  TEXT NOT NULL,
      approval_ref     VARCHAR(128) NOT NULL,
      screening_ref    VARCHAR(128) NOT NULL,
      rail             VARCHAR(24),
      network_id       VARCHAR(64),
      rationale        TEXT,
      advisor          VARCHAR(64),
      clearing_instruction_id VARCHAR(64),
      return_code      VARCHAR(4),
      return_reason    TEXT,
      fineract_redeposit_id TEXT,
      error            TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS enterprise_odfi_events (
      event_id   VARCHAR(64) PRIMARY KEY,
      batch_id   VARCHAR(64),
      item_id    VARCHAR(64),
      event_type VARCHAR(48) NOT NULL,
      actor      VARCHAR(128),
      detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  },

  async _event(type, { batchId = null, itemId = null, actor = null, detail = {} } = {}) {
    if (!pool) return;
    await pool.query(
      'INSERT INTO enterprise_odfi_events (event_id, batch_id, item_id, event_type, actor, detail) VALUES ($1,$2,$3,$4,$5,$6)',
      [newId('EOE'), batchId, itemId, type, normalizeActor(actor), JSON.stringify(redactPayload(detail))]
    ).catch(() => {});
  },
  async _profile() {
    if (!pool) return null;
    const r = await pool.query('SELECT * FROM enterprise_odfi_profiles WHERE originator_id = $1', [getEnterpriseOdfiConfig().originatorId]);
    return r.rows[0] || null;
  },
  async _batch(batchId) {
    if (!pool) return null;
    const r = await pool.query('SELECT * FROM enterprise_odfi_batches WHERE batch_id = $1', [batchId]);
    return r.rows[0] || null;
  },
  async _items(batchId) {
    if (!pool) return [];
    const r = await pool.query('SELECT * FROM enterprise_odfi_items WHERE batch_id = $1 ORDER BY created_at', [batchId]);
    return r.rows;
  },
  async _item(itemId) {
    if (!pool) return null;
    const r = await pool.query('SELECT * FROM enterprise_odfi_items WHERE item_id = $1', [itemId]);
    return r.rows[0] || null;
  },
  async _update(table, idCol, id, patch) {
    const keys = Object.keys(patch);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const r = await pool.query(`UPDATE ${table} SET ${sets.join(', ')}, updated_at = NOW() WHERE ${idCol} = $1 RETURNING *`, [id, ...keys.map((k) => patch[k])]);
    return r.rows[0] || null;
  },
  _publicItem(row) {
    if (!row) return null;
    const { instruction_enc, ...rest } = row;
    return { ...rest, instruction: instruction_enc ? 'encrypted' : null };
  },

  // ─── Originator profile (maker/checker) ───────────────────────────────────

  async profile({ companyName, companyId = null, secCodes = SEC_CODES, exposureLimitCents, sameDayLimitCents, sponsorNetworkId = null, agreementRef = null, actor = null } = {}) {
    const cfg = getEnterpriseOdfiConfig();
    if (!cfg.enabled) throw new EnterpriseOdfiError('ENTERPRISE_ODFI_ENABLED=false', 'ENTERPRISE_ODFI_DISABLED', 503);
    if (!pool) throw new EnterpriseOdfiError('ledger database not connected', 'ENTERPRISE_ODFI_DB', 503);
    const a = normalizeActor(actor);
    if (!a) throw new EnterpriseOdfiError('declaring trustee identity required', 'ENTERPRISE_ODFI_ACTOR', 401);
    assertRole(cfg, 'maker', a);
    if (!companyName || String(companyName).trim().length < 2) throw new EnterpriseOdfiError('companyName required', 'ENTERPRISE_ODFI_BAD_REQUEST', 400);
    const secs = [...new Set((Array.isArray(secCodes) ? secCodes : [secCodes]).map((s) => String(s).toUpperCase()))];
    if (!secs.length || secs.some((s) => !SEC_CODES.includes(s))) throw new EnterpriseOdfiError(`secCodes must be among ${SEC_CODES.join(', ')}`, 'ENTERPRISE_ODFI_BAD_REQUEST', 400);
    const exposure = Number.isInteger(Number(exposureLimitCents)) && Number(exposureLimitCents) > 0 ? Number(exposureLimitCents) : cfg.exposureLimitCents;
    const sameDay = Number.isInteger(Number(sameDayLimitCents)) && Number(sameDayLimitCents) > 0 ? Number(sameDayLimitCents) : cfg.sameDayLimitCents;
    if (sponsorNetworkId) {
      const nets = await ClearingAgentOsEngine.networks();
      if (!nets.find((n) => n.network_id === sponsorNetworkId)) throw new EnterpriseOdfiError('sponsorNetworkId is not a registered Clearing Agent network', 'ENTERPRISE_ODFI_BAD_REQUEST', 400);
    }
    await pool.query(
      `INSERT INTO enterprise_odfi_profiles (originator_id, company_name, company_id_last4, sec_codes, exposure_limit_cents, same_day_limit_cents, sponsor_network_id, agreement_ref, declared_by, countersigned_by, countersigned_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL)
       ON CONFLICT (originator_id) DO UPDATE SET company_name = EXCLUDED.company_name, company_id_last4 = EXCLUDED.company_id_last4, sec_codes = EXCLUDED.sec_codes,
         exposure_limit_cents = EXCLUDED.exposure_limit_cents, same_day_limit_cents = EXCLUDED.same_day_limit_cents, sponsor_network_id = EXCLUDED.sponsor_network_id,
         agreement_ref = EXCLUDED.agreement_ref, declared_by = EXCLUDED.declared_by, countersigned_by = NULL, countersigned_at = NULL, updated_at = NOW()`,
      [cfg.originatorId, String(companyName).trim(), last4(companyId), JSON.stringify(secs), exposure, sameDay, sponsorNetworkId, agreementRef, a]
    );
    await this._event('enterprise_odfi.profile_declared', { actor: a, detail: { companyName, secCodes: secs, exposure, sameDay, sponsorNetworkId } });
    return this._profile();
  },

  async countersign({ actor = null } = {}) {
    const p = await this._profile();
    if (!p) throw new EnterpriseOdfiError('no originator profile declared', 'ENTERPRISE_ODFI_NOT_FOUND', 404);
    const a = normalizeActor(actor);
    if (!a) throw new EnterpriseOdfiError('countersigning trustee identity required', 'ENTERPRISE_ODFI_ACTOR', 401);
    assertRole(getEnterpriseOdfiConfig(), 'checker', a);
    if (a === normalizeActor(p.declared_by)) throw new EnterpriseOdfiError('countersigner must differ from declaring trustee (maker/checker)', 'ENTERPRISE_ODFI_SAME_ACTOR', 409);
    const row = await this._update('enterprise_odfi_profiles', 'originator_id', p.originator_id, { countersigned_by: a, countersigned_at: new Date() });
    await this._event('enterprise_odfi.profile_countersigned', { actor: a });
    return row;
  },

  // ─── Origination: originate (plan) → release ──────────────────────────────

  /**
   * originate: { purposeClass, items:[{ idempotencyKey, approvalRef, screeningRef, urgency, instruction }], actor }
   * Creates a planned batch. Nothing leaves the box; nothing is booked.
   */
  async originate({ purposeClass, items = [], actor = null } = {}) {
    const cfg = getEnterpriseOdfiConfig();
    if (!cfg.enabled) throw new EnterpriseOdfiError('ENTERPRISE_ODFI_ENABLED=false', 'ENTERPRISE_ODFI_DISABLED', 503);
    if (!pool) throw new EnterpriseOdfiError('ledger database not connected', 'ENTERPRISE_ODFI_DB', 503);
    const a = normalizeActor(actor);
    if (!a) throw new EnterpriseOdfiError('originating trustee identity required', 'ENTERPRISE_ODFI_ACTOR', 401);
    assertRole(cfg, 'maker', a);
    if (!PURPOSE_CLASSES.includes(purposeClass)) throw new EnterpriseOdfiError(`purposeClass must be one of ${PURPOSE_CLASSES.join(', ')}`, 'ENTERPRISE_ODFI_BAD_REQUEST', 400);
    if (!Array.isArray(items) || !items.length) throw new EnterpriseOdfiError('items required', 'ENTERPRISE_ODFI_BAD_REQUEST', 400);
    if (items.length > cfg.maxBatchItems) throw new EnterpriseOdfiError(`batch exceeds ENTERPRISE_ODFI_MAX_BATCH_ITEMS (${cfg.maxBatchItems})`, 'ENTERPRISE_ODFI_BAD_REQUEST', 400);
    const p = await this._profile();
    if (!p) throw new EnterpriseOdfiError('originator profile not declared', 'ENTERPRISE_ODFI_PROFILE', 409);

    const prepared = [];
    const keys = new Set();
    for (const raw of items) {
      const key = String(raw.idempotencyKey || '').trim();
      if (!key) throw new EnterpriseOdfiError('each item needs idempotencyKey', 'ENTERPRISE_ODFI_BAD_REQUEST', 400);
      if (keys.has(key)) throw new EnterpriseOdfiError(`duplicate idempotencyKey ${key} in batch`, 'ENTERPRISE_ODFI_BAD_REQUEST', 400);
      keys.add(key);
      if (!raw.approvalRef || !raw.screeningRef) throw new EnterpriseOdfiError(`item ${key}: approvalRef and screeningRef are required`, 'ENTERPRISE_ODFI_APPROVAL', 403);
      const urgency = ['instant', 'same_day', 'standard'].includes(raw.urgency) ? raw.urgency : 'standard';
      let ix;
      try { ix = canonicalize({ ...raw.instruction, idempotencyKey: key }); } catch (e) { throw new EnterpriseOdfiError(`item ${key}: ${e.message}`, 'ENTERPRISE_ODFI_BAD_REQUEST', 400); }
      if (!(p.sec_codes || SEC_CODES).includes(ix.secCode)) throw new EnterpriseOdfiError(`item ${key}: SEC code ${ix.secCode} not in originator profile`, 'ENTERPRISE_ODFI_SEC', 422);
      if (cfg.familyOnly && purposeClass === 'distribution' && !ix.creditor.participantId) throw new EnterpriseOdfiError(`item ${key}: family-only mode requires creditor.participantId`, 'ENTERPRISE_ODFI_FAMILY_ONLY', 403);
      const dup = await pool.query('SELECT item_id, batch_id FROM enterprise_odfi_items WHERE idempotency_key = $1', [key]);
      if (dup.rows.length) throw new EnterpriseOdfiError(`item ${key} already originated in batch ${dup.rows[0].batch_id}`, 'ENTERPRISE_ODFI_DUPLICATE', 409);
      prepared.push({ itemId: newId('EOI'), key, approvalRef: String(raw.approvalRef), screeningRef: String(raw.screeningRef), urgency, purposeClass, instruction: ix });
    }
    const total = prepared.reduce((s, x) => s + x.instruction.amountCents, 0);
    const exposure = await this.exposure();
    const limit = Number(p.exposure_limit_cents || cfg.exposureLimitCents);
    if (exposure.outstandingCents + total > limit) throw new EnterpriseOdfiError(`batch would exceed exposure limit (${exposure.outstandingCents + total} > ${limit} cents)`, 'ENTERPRISE_ODFI_EXPOSURE', 422);

    const plan = await planItems(prepared, cfg);
    const batchId = newId('EOB');
    await pool.query(
      'INSERT INTO enterprise_odfi_batches (batch_id, purpose_class, status, item_count, total_cents, planner, plan_note, planned_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [batchId, purposeClass, 'planned', prepared.length, total, plan.planner, plan.note, a]
    );
    for (const it of prepared) {
      const pl = plan.plans.find((x) => x.itemId === it.itemId);
      await pool.query(
        `INSERT INTO enterprise_odfi_items (item_id, batch_id, idempotency_key, purpose_class, urgency, status, amount_cents, creditor_name, creditor_last4, debtor_fineract_id, creditor_fineract_id, instruction_enc, approval_ref, screening_ref, rail, network_id, rationale, advisor)
         VALUES ($1,$2,$3,$4,$5,'planned',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [it.itemId, batchId, it.key, purposeClass, it.urgency, it.instruction.amountCents, it.instruction.creditor.name, last4(it.instruction.creditor.accountNumber), it.instruction.debtor.fineractAccountId || null, it.instruction.creditor.fineractAccountId || null,
          encrypt(it.instruction), it.approvalRef, it.screeningRef, pl.rail, pl.networkId, pl.rationale, pl.advisor]
      );
    }
    await this._event('enterprise_odfi.planned', { batchId, actor: a, detail: { purposeClass, items: prepared.length, totalCents: total, planner: plan.planner, model: plan.model } });
    return this.batch({ batchId });
  },

  /** replan: re-run the planner on a planned batch (e.g. after a new network verifies). */
  async replan({ batchId, actor = null } = {}) {
    const b = await this._batch(batchId);
    if (!b) throw new EnterpriseOdfiError('batch not found', 'ENTERPRISE_ODFI_NOT_FOUND', 404);
    if (b.status !== 'planned') throw new EnterpriseOdfiError(`batch is ${b.status}; only planned batches replan`, 'ENTERPRISE_ODFI_STATE', 409);
    const cfg = getEnterpriseOdfiConfig();
    const rows = await this._items(batchId);
    const prepared = rows.map((r) => ({ itemId: r.item_id, purposeClass: r.purpose_class, urgency: r.urgency, instruction: decrypt(r.instruction_enc) }));
    const plan = await planItems(prepared, cfg);
    for (const pl of plan.plans) await this._update('enterprise_odfi_items', 'item_id', pl.itemId, { rail: pl.rail, network_id: pl.networkId, rationale: pl.rationale, advisor: pl.advisor });
    await this._update('enterprise_odfi_batches', 'batch_id', batchId, { planner: plan.planner, plan_note: plan.note });
    await this._event('enterprise_odfi.replanned', { batchId, actor, detail: { planner: plan.planner } });
    return this.batch({ batchId });
  },

  /**
   * release: a DISTINCT trustee releases a planned batch. Each item clears and
   * posts through the Clearing Agent (verified network, HMAC, Egress OS,
   * Fineract). This is the only action that moves money.
   */
  async release({ batchId, actor = null } = {}) {
    const cfg = getEnterpriseOdfiConfig();
    const b = await this._batch(batchId);
    if (!b) throw new EnterpriseOdfiError('batch not found', 'ENTERPRISE_ODFI_NOT_FOUND', 404);
    if (b.status !== 'planned') throw new EnterpriseOdfiError(`batch is ${b.status}; only planned batches release`, 'ENTERPRISE_ODFI_STATE', 409);
    const a = normalizeActor(actor);
    if (!a) throw new EnterpriseOdfiError('releasing trustee identity required', 'ENTERPRISE_ODFI_ACTOR', 401);
    assertRole(cfg, 'checker', a);
    if (cfg.requireDistinctReleaser && a === normalizeActor(b.planned_by)) throw new EnterpriseOdfiError('releaser must differ from originating trustee (maker/checker)', 'ENTERPRISE_ODFI_SAME_ACTOR', 409);
    const p = await this._profile();
    if (!p || !p.countersigned_by) throw new EnterpriseOdfiError('originator profile not countersigned by a second trustee', 'ENTERPRISE_ODFI_PROFILE', 409);
    if (!cfg.live) throw new EnterpriseOdfiError('ENTERPRISE_ODFI_LIVE not true (shadow: batches plan only)', 'ENTERPRISE_ODFI_SHADOW', 409);
    const items = await this._items(batchId);
    const unrouted = items.filter((it) => !it.network_id);
    if (unrouted.length) throw new EnterpriseOdfiError(`${unrouted.length} item(s) have no verified network for their rail; register/verify a sponsor ODFI network and replan`, 'ENTERPRISE_ODFI_UNROUTED', 409, { items: unrouted.map((x) => x.item_id) });

    await this._update('enterprise_odfi_batches', 'batch_id', batchId, { status: 'released', released_by: a, released_at: new Date() });
    await this._event('enterprise_odfi.released', { batchId, actor: a, detail: { items: items.length, totalCents: b.total_cents } });
    let failed = 0;
    for (const it of items) {
      if (it.status !== 'planned') continue;
      try {
        const ix = { ...decrypt(it.instruction_enc), speed: RAIL_SPEED[it.rail] || 'standard' };
        const cleared = await ClearingAgentOsEngine.submit({ networkId: it.network_id, instruction: ix, idempotencyKey: it.idempotency_key, approvalRef: it.approval_ref, screeningRef: it.screening_ref, actor: a });
        if (cleared.status !== 'cleared' && cleared.status !== 'posted') {
          failed += 1;
          await this._update('enterprise_odfi_items', 'item_id', it.item_id, { status: cleared.status === 'rejected' ? 'rejected' : 'failed', clearing_instruction_id: cleared.instruction_id || null, error: cleared.error || `clearing agent: ${cleared.status}` });
          await this._event('enterprise_odfi.item_failed', { batchId, itemId: it.item_id, actor: a, detail: { status: cleared.status, error: cleared.error } });
          continue;
        }
        const posted = cleared.status === 'posted' ? cleared : await ClearingAgentOsEngine.post({ instructionId: cleared.instruction_id, actor: a });
        const ok = posted.status === 'posted';
        if (!ok) failed += 1;
        await this._update('enterprise_odfi_items', 'item_id', it.item_id, { status: ok ? 'posted' : 'cleared', clearing_instruction_id: cleared.instruction_id, error: ok ? null : posted.error || 'posting pending' });
        await this._event(ok ? 'enterprise_odfi.item_posted' : 'enterprise_odfi.item_cleared', { batchId, itemId: it.item_id, actor: a, detail: { instructionId: cleared.instruction_id, amountCents: it.amount_cents, rail: it.rail } });
      } catch (e) {
        failed += 1;
        await this._update('enterprise_odfi_items', 'item_id', it.item_id, { status: 'failed', error: e.message });
        await this._event('enterprise_odfi.item_failed', { batchId, itemId: it.item_id, actor: a, detail: { error: e.message } });
      }
    }
    await this._update('enterprise_odfi_batches', 'batch_id', batchId, { status: failed ? 'partially_failed' : 'originated', error: failed ? `${failed} item(s) did not post` : null });
    return this.batch({ batchId });
  },

  async cancel({ batchId, reason = null, actor = null } = {}) {
    const b = await this._batch(batchId);
    if (!b) throw new EnterpriseOdfiError('batch not found', 'ENTERPRISE_ODFI_NOT_FOUND', 404);
    if (b.status !== 'planned') throw new EnterpriseOdfiError(`batch is ${b.status}; only planned batches cancel`, 'ENTERPRISE_ODFI_STATE', 409);
    await this._update('enterprise_odfi_batches', 'batch_id', batchId, { status: 'cancelled', error: reason });
    await this._event('enterprise_odfi.cancelled', { batchId, actor, detail: { reason } });
    return this.batch({ batchId });
  },

  // ─── Returns / NOCs ───────────────────────────────────────────────────────

  /**
   * exception: { itemId, code: 'Rxx'|'Cxx', reason, actor }. A return on a posted
   * item re-deposits the amount on the debtor's Fineract account (idempotent);
   * a NOC only records the correction request.
   */
  async exception({ itemId, code, reason = null, actor = null } = {}) {
    const it = await this._item(itemId);
    if (!it) throw new EnterpriseOdfiError('item not found', 'ENTERPRISE_ODFI_NOT_FOUND', 404);
    const c = String(code || '').toUpperCase();
    const a = normalizeActor(actor);
    if (!a) throw new EnterpriseOdfiError('trustee identity required', 'ENTERPRISE_ODFI_ACTOR', 401);
    if (NOC_CODE.test(c)) {
      const row = await this._update('enterprise_odfi_items', 'item_id', itemId, { status: 'noc', return_code: c, return_reason: reason });
      await this._event('enterprise_odfi.noc', { batchId: it.batch_id, itemId, actor: a, detail: { code: c, reason } });
      return this._publicItem(row);
    }
    if (!RETURN_CODE.test(c)) throw new EnterpriseOdfiError('code must be an ACH return (Rxx) or NOC (Cxx) code', 'ENTERPRISE_ODFI_BAD_REQUEST', 400);
    if (it.status === 'returned') return { ...this._publicItem(it), idempotent: true };
    if (!['posted', 'cleared'].includes(it.status)) throw new EnterpriseOdfiError(`item is ${it.status}; only cleared/posted items return`, 'ENTERPRISE_ODFI_STATE', 409);
    let redepositId = it.fineract_redeposit_id;
    if (it.status === 'posted' && it.debtor_fineract_id && !redepositId) {
      const d = await FineractClient.depositSavings({ accountId: it.debtor_fineract_id, amount: Number(it.amount_cents) / 100, note: `enterprise-odfi return ${c} ${it.item_id}` });
      redepositId = String(d && d.resourceId ? d.resourceId : d && d.transactionId ? d.transactionId : 'ok');
    }
    const row = await this._update('enterprise_odfi_items', 'item_id', itemId, { status: 'returned', return_code: c, return_reason: reason, fineract_redeposit_id: redepositId });
    await this._event('enterprise_odfi.returned', { batchId: it.batch_id, itemId, actor: a, detail: { code: c, reason, redepositId, amountCents: it.amount_cents } });
    return this._publicItem(row);
  },

  // ─── Reconciliation / reporting ───────────────────────────────────────────

  async exposure() {
    const out = { outstandingCents: 0, postedCents: 0, returnedCents: 0, byStatus: Object.fromEntries(ITEM_STATES.map((s) => [s, 0])) };
    if (!pool) return out;
    const r = await pool.query('SELECT status, COUNT(*)::int AS n, COALESCE(SUM(amount_cents),0)::bigint AS cents FROM enterprise_odfi_items GROUP BY status');
    for (const row of r.rows) {
      out.byStatus[row.status] = row.n;
      if (['planned', 'cleared'].includes(row.status)) out.outstandingCents += Number(row.cents);
      if (row.status === 'posted') out.postedCents += Number(row.cents);
      if (row.status === 'returned') out.returnedCents += Number(row.cents);
    }
    return out;
  },

  async reconcile() {
    const cfg = getEnterpriseOdfiConfig();
    const p = await this._profile();
    const e = await this.exposure();
    const limit = Number((p && p.exposure_limit_cents) || cfg.exposureLimitCents);
    return { ...e, exposureLimitCents: limit, headroomCents: Math.max(0, limit - e.outstandingCents), asOf: new Date().toISOString() };
  },

  async batch({ batchId } = {}) {
    const b = await this._batch(batchId);
    if (!b) throw new EnterpriseOdfiError('batch not found', 'ENTERPRISE_ODFI_NOT_FOUND', 404);
    return { ...b, items: (await this._items(batchId)).map((r) => this._publicItem(r)) };
  },

  async batches({ limit = 50 } = {}) {
    if (!pool) return [];
    const r = await pool.query('SELECT * FROM enterprise_odfi_batches ORDER BY created_at DESC LIMIT $1', [Math.min(500, Math.max(1, Number(limit) || 50))]);
    return r.rows;
  },

  /** Verified Clearing Agent networks grouped by the rails they carry; external = a real sponsor ODFI / instant participant. */
  async rails() {
    const nets = (await ClearingAgentOsEngine.networks()).filter((n) => n.handshake_state === 'verified');
    const byRail = Object.fromEntries(RAILS.map((r) => [r, nets.filter((n) => railsForNetwork(n).includes(r)).map((n) => n.network_id)]));
    return { byRail, external: nets.filter((n) => EXTERNAL_KINDS.includes(n.kind)).map((n) => ({ networkId: n.network_id, kind: n.kind })), family: nets.filter((n) => !EXTERNAL_KINDS.includes(n.kind)).map((n) => n.network_id) };
  },

  async status() {
    const cfg = getEnterpriseOdfiConfig();
    const p = await this._profile();
    return {
      engine: 'enterprise-odfi',
      enabled: cfg.enabled,
      live: cfg.live,
      originatorId: cfg.originatorId,
      country: COUNTRY,
      currency: 'USD',
      purposeClasses: PURPOSE_CLASSES,
      rails: await this.rails(),
      profile: p ? { companyName: p.company_name, companyIdLast4: p.company_id_last4, secCodes: p.sec_codes, exposureLimitCents: Number(p.exposure_limit_cents), sameDayLimitCents: Number(p.same_day_limit_cents), sponsorNetworkId: p.sponsor_network_id, agreementRef: p.agreement_ref, declaredBy: p.declared_by, countersignedBy: p.countersigned_by, countersigned: Boolean(p.countersigned_by) } : null,
      planner: { provider: cfg.aiEnabled ? 'vertex_ai' : 'rules', model: cfg.aiEnabled ? cfg.aiModel : null, location: cfg.aiLocation, advisory: true, validator: 'deterministic', sensitiveDataLeavesBox: false },
      exposure: await this.reconcile(),
      storage: { instructions: 'aes-256-gcm under PAYMENT_DATA_ENCRYPTION_KEY', keyConfigured: cfg.encryptionKeyConfigured },
      policy: { usaOnly: true, requireDistinctReleaser: cfg.requireDistinctReleaser, makers: cfg.makers, checkers: cfg.checkers, approvalAndScreeningRequired: true, plannerMovesMoney: false, profileMovesMoney: false, releaseVia: 'clearing-agent (verified network, HMAC, Egress OS, Fineract post)', isBank: false, note: 'originator-side OS; settlement is by the sponsor ODFI network, never by this software' },
    };
  },

  async health() {
    const s = await this.status();
    return { ok: s.enabled, engine: 'enterprise-odfi', profile: Boolean(s.profile), externalNetworks: s.rails.external.length };
  },

  async readiness() {
    const cfg = getEnterpriseOdfiConfig();
    const s = await this.status();
    const blockers = [];
    if (!s.enabled) blockers.push('ENTERPRISE_ODFI_ENABLED=false');
    if (!cfg.encryptionKeyConfigured) blockers.push('PAYMENT_DATA_ENCRYPTION_KEY not set (item instructions are stored encrypted)');
    if (!s.profile) blockers.push('originator profile not declared (POST process action=profile)');
    else if (!s.profile.countersigned) blockers.push('originator profile awaiting countersignature by a distinct trustee (action=countersign)');
    if (!cfg.requireDistinctReleaser) blockers.push('ENTERPRISE_ODFI_REQUIRE_DISTINCT_RELEASER=false (maker/checker disabled)');
    const ca = await ClearingAgentOsEngine.readiness();
    if (!ca.ready) blockers.push(...ca.blockers.map((b) => `clearing-agent: ${b}`));
    if (!s.rails.external.length) blockers.push('no verified external sponsor ODFI network (ach_operator / rtp_participant / fednow_participant); only family book transfers can route');
    if (!s.live) blockers.push('ENTERPRISE_ODFI_LIVE not true');
    const live = blockers.length === 0;
    return { ready: live, mode: live ? 'live' : 'shadow', blockers, status: s };
  },

  async list({ limit = 50 } = {}) {
    return this.batches({ limit });
  },

  async get(id) {
    const b = await this._batch(id);
    if (b) return this.batch({ batchId: id });
    return this._publicItem(await this._item(id));
  },

  async process({ action, actor = null, ...body } = {}) {
    switch (action) {
      case 'profile': return this.profile({ ...body, actor });
      case 'countersign': return this.countersign({ actor });
      case 'originate': return this.originate({ ...body, actor });
      case 'replan': return this.replan({ ...body, actor });
      case 'release': return this.release({ ...body, actor });
      case 'cancel': return this.cancel({ ...body, actor });
      case 'exception': return this.exception({ ...body, actor });
      case 'reconcile': return this.reconcile();
      case 'rails': return this.rails();
      case 'batches': return this.batches(body);
      case 'batch': return this.batch(body);
      default: throw new EnterpriseOdfiError('action must be profile|countersign|originate|replan|release|cancel|exception|reconcile|rails|batches|batch', 'ENTERPRISE_ODFI_BAD_ACTION', 400);
    }
  },
};

module.exports = {
  EnterpriseOdfiOsEngine,
  EnterpriseOdfiError,
  getEnterpriseOdfiConfig,
  rulesPlan,
  acceptProposal,
  publicInstruction,
  encrypt,
  decrypt,
  PURPOSE_CLASSES,
  RAILS,
  BATCH_STATES,
  ITEM_STATES,
};
