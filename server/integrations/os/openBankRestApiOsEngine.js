'use strict';

/**
 * Open Bank REST API OS — the trust's OBP-style REST surface plus the Open Banking
 * Tracker directory, used to find and register bank file-drop / API intakes.
 *
 * Two halves:
 *
 *   directory    Open Banking Tracker (openbankingtracker.com) publishes one JSON
 *                profile per account provider in the public dataset
 *                `not-a-bank/open-banking-tracker-data` (data/account-providers/<id>.json):
 *                developer portal URL, API products with documentation / reference
 *                URLs, sandbox status, compliance. `importProvider` pulls a profile
 *                into `open_bank_providers`, and `seedDiscovery` hands its
 *                documentation URLs to the H2H Discovery OS as scrape sources so the
 *                AS2 ID / client ID / base URL for that bank can be found.
 *
 *   rest api     The trust's own Open Bank REST API (/api/open-bank/v1): banks,
 *                accounts (Fineract core-banking savings: account of record,
 *                principal, interest income, trustee / beneficiary sub-accounts —
 *                read-only), providers, and file-drop registrations. A file-drop
 *                registration records the intake a bank offers (AS2 / REST / SFTP)
 *                and projects it onto the AS2Partners register or an MFT channel.
 *                Credentials are never accepted here — only identifiers and
 *                endpoints; secrets live in Secret Manager / env by name.
 *
 * Readiness is live only when at least one file drop is registered and verified;
 * until then shadow with the honest blocker (e.g. Betterment lists no intake).
 */

const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const pool = require('../bonds/pgPool');

const DEFAULT_TRACKER_BASE = 'https://raw.githubusercontent.com/not-a-bank/open-banking-tracker-data/master/data/account-providers';
const DEFAULT_TRACKER_INDEX = 'https://api.github.com/repos/not-a-bank/open-banking-tracker-data/contents/data/account-providers';
const API_VERSION = 'v1';
const PROTOCOLS = ['as2', 'rest_api', 'sftp'];
const FILE_DROP_STATUSES = ['registered', 'verified', 'suspended'];

class OpenBankError extends Error {
  constructor(message, code = 'OPEN_BANK_ERROR', status = 409, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function text(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === null || String(v).trim() === '' ? fallback : String(v).trim();
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function getOpenBankConfig(env = process.env) {
  return {
    enabled: String(env.OPEN_BANK_API_ENABLED || 'true').toLowerCase() !== 'false',
    trackerBase: text('OPEN_BANKING_TRACKER_BASE_URL', DEFAULT_TRACKER_BASE).replace(/\/+$/, ''),
    trackerIndex: text('OPEN_BANKING_TRACKER_INDEX_URL', DEFAULT_TRACKER_INDEX),
    timeoutMs: Number(env.OPEN_BANKING_TRACKER_TIMEOUT_MS) || 15000,
    bankId: text('OPEN_BANK_ID', 'dlb-trust-company'),
    bankName: text('OPEN_BANK_NAME', 'DeAndrea LaVar Barkley Trust Company'),
    userAgent: text('OPEN_BANK_USER_AGENT', 'dlbtrust-open-bank-api/1.0'),
    publicBaseUrl: text('OPEN_BANK_PUBLIC_BASE_URL', ''),
  };
}

function getJson(url, cfg) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new OpenBankError(`Invalid URL: ${url}`, 'OPEN_BANK_BAD_URL', 400)); }
    if (u.protocol !== 'https:') return reject(new OpenBankError('Only https:// directory sources are used', 'OPEN_BANK_BAD_URL', 400));
    const req = https.request(u, { method: 'GET', headers: { 'User-Agent': cfg.userAgent, Accept: 'application/json' }, timeout: cfg.timeoutMs }, (res) => {
      if (res.statusCode === 404) { res.resume(); return reject(new OpenBankError(`Not found in Open Banking Tracker: ${u.pathname.split('/').pop()}`, 'OPEN_BANK_PROVIDER_NOT_FOUND', 404)); }
      if (!res.statusCode || res.statusCode >= 400) { res.resume(); return reject(new OpenBankError(`HTTP ${res.statusCode} from ${u.hostname}`, 'OPEN_BANK_FETCH', 502)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new OpenBankError(`Invalid JSON from ${u.hostname}: ${e.message}`, 'OPEN_BANK_FETCH', 502)); }
      });
    });
    req.on('timeout', () => req.destroy(new OpenBankError('Tracker fetch timed out', 'OPEN_BANK_TIMEOUT', 504)));
    req.on('error', (e) => reject(e instanceof OpenBankError ? e : new OpenBankError(e.message, 'OPEN_BANK_FETCH', 502)));
    req.end();
  });
}

/** Normalise a tracker account-provider profile to what we store. Pure. */
function normalizeProvider(p) {
  if (!p || typeof p !== 'object' || !p.id) throw new OpenBankError('Tracker profile missing id', 'OPEN_BANK_BAD_PROFILE', 502);
  const products = Array.isArray(p.apiProducts) ? p.apiProducts : [];
  const docUrls = [p.developerPortalUrl, p.apiReferenceUrl, p.apiChangelogUrl, ...products.flatMap(x => [x.documentationUrl, x.apiReferenceUrl])]
    .filter(u => typeof u === 'string' && /^https:\/\//i.test(u));
  const paymentInitiation = products.some(x => x.type === 'paymentInitiation' || (Array.isArray(x.categories) && x.categories.includes('payments')));
  return {
    providerId: String(p.id).toLowerCase(),
    name: p.name || p.label || p.id,
    legalName: p.legalName || null,
    countryHQ: p.countryHQ || null,
    countries: Array.isArray(p.countries) ? p.countries : [],
    websiteUrl: p.websiteUrl || p.website || null,
    developerPortalUrl: p.developerPortalUrl || null,
    sandboxStatus: p.sandbox && p.sandbox.status ? p.sandbox.status : null,
    apiProducts: products.map(x => ({ label: x.label || null, type: x.type || null, stage: x.stage || null, specification: x.specification || null, documentationUrl: x.documentationUrl || null, apiReferenceUrl: x.apiReferenceUrl || null })),
    paymentInitiation,
    documentationUrls: [...new Set(docUrls)],
    compliance: Array.isArray(p.compliance) ? p.compliance : [],
    raw: p,
  };
}

function mapProvider(r) {
  return {
    providerId: r.provider_id, name: r.name, legalName: r.legal_name, countryHQ: r.country_hq, countries: r.countries || [], websiteUrl: r.website_url,
    developerPortalUrl: r.developer_portal_url, sandboxStatus: r.sandbox_status, paymentInitiation: r.payment_initiation, apiProducts: r.api_products || [],
    documentationUrls: r.documentation_urls || [], source: r.source, fetchedAt: r.fetched_at,
  };
}

function mapFileDrop(r) {
  return {
    fileDropId: r.file_drop_id, providerId: r.provider_id, protocol: r.protocol, endpoint: r.endpoint, as2Id: r.as2_id, clientId: r.client_id, mdnUrl: r.mdn_url,
    partnerId: r.partner_id, channelId: r.channel_id, status: r.status, registeredBy: r.registered_by, registeredAt: r.registered_at, verifiedBy: r.verified_by, verifiedAt: r.verified_at, notes: r.notes,
  };
}

const OpenBankRestApiOsEngine = {
  API_VERSION,
  normalizeProvider,
  _getJson: getJson,

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS open_bank_providers (
        provider_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        legal_name TEXT,
        country_hq TEXT,
        countries JSONB NOT NULL DEFAULT '[]'::jsonb,
        website_url TEXT,
        developer_portal_url TEXT,
        sandbox_status TEXT,
        payment_initiation BOOLEAN NOT NULL DEFAULT FALSE,
        api_products JSONB NOT NULL DEFAULT '[]'::jsonb,
        documentation_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
        compliance JSONB NOT NULL DEFAULT '[]'::jsonb,
        raw JSONB NOT NULL DEFAULT '{}'::jsonb,
        source TEXT NOT NULL DEFAULT 'open-banking-tracker',
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        imported_by TEXT
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS open_bank_file_drops (
        file_drop_id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        protocol TEXT NOT NULL,
        endpoint TEXT,
        as2_id TEXT,
        client_id TEXT,
        mdn_url TEXT,
        partner_id TEXT,
        channel_id TEXT,
        status TEXT NOT NULL DEFAULT 'registered',
        registered_by TEXT,
        registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        verified_by TEXT,
        verified_at TIMESTAMPTZ,
        notes TEXT,
        UNIQUE (provider_id, protocol)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS open_bank_events (
        event_id TEXT PRIMARY KEY,
        provider_id TEXT,
        event_type TEXT NOT NULL,
        actor TEXT,
        detail JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
  },

  // ── Directory (Open Banking Tracker) ────────────────────────────────────────

  async trackerIndex({ limit = 500 } = {}) {
    const cfg = getOpenBankConfig();
    const items = await this._getJson(cfg.trackerIndex, cfg);
    if (!Array.isArray(items)) throw new OpenBankError('Unexpected tracker index shape', 'OPEN_BANK_FETCH', 502);
    return items.filter(i => typeof i.name === 'string' && i.name.endsWith('.json')).slice(0, limit).map(i => i.name.replace(/\.json$/, ''));
  },

  async importProvider({ providerId, actor = null } = {}) {
    if (!providerId) throw new OpenBankError('providerId is required', 'OPEN_BANK_BAD_REQUEST', 400);
    const cfg = getOpenBankConfig();
    const id = String(providerId).toLowerCase().replace(/[^a-z0-9._-]/g, '');
    if (!id) throw new OpenBankError('providerId is invalid', 'OPEN_BANK_BAD_REQUEST', 400);
    const profile = normalizeProvider(await this._getJson(`${cfg.trackerBase}/${id}.json`, cfg));
    const res = await pool.query(
      `INSERT INTO open_bank_providers (provider_id, name, legal_name, country_hq, countries, website_url, developer_portal_url, sandbox_status, payment_initiation, api_products, documentation_urls, compliance, raw, imported_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14)
       ON CONFLICT (provider_id) DO UPDATE SET name = EXCLUDED.name, legal_name = EXCLUDED.legal_name, country_hq = EXCLUDED.country_hq, countries = EXCLUDED.countries,
         website_url = EXCLUDED.website_url, developer_portal_url = EXCLUDED.developer_portal_url, sandbox_status = EXCLUDED.sandbox_status, payment_initiation = EXCLUDED.payment_initiation,
         api_products = EXCLUDED.api_products, documentation_urls = EXCLUDED.documentation_urls, compliance = EXCLUDED.compliance, raw = EXCLUDED.raw, fetched_at = NOW(), imported_by = EXCLUDED.imported_by
       RETURNING *`,
      [profile.providerId, profile.name, profile.legalName, profile.countryHQ, JSON.stringify(profile.countries), profile.websiteUrl, profile.developerPortalUrl, profile.sandboxStatus, profile.paymentInitiation,
        JSON.stringify(profile.apiProducts), JSON.stringify(profile.documentationUrls), JSON.stringify(profile.compliance), JSON.stringify(profile.raw), actor]
    );
    await this._event(profile.providerId, 'provider.imported', actor, { documentationUrls: profile.documentationUrls.length, paymentInitiation: profile.paymentInitiation });
    return mapProvider(res.rows[0]);
  },

  async providers({ providerId = null } = {}) {
    const res = await pool.query('SELECT * FROM open_bank_providers WHERE ($1::text IS NULL OR provider_id = $1) ORDER BY name', [providerId ? String(providerId).toLowerCase() : null]);
    return res.rows.map(mapProvider);
  },

  /** Register the provider's documentation URLs as H2H Discovery scrape sources. */
  async seedDiscovery({ providerId, actor = null } = {}) {
    const [provider] = await this.providers({ providerId });
    if (!provider) throw new OpenBankError(`Provider not imported: ${providerId}`, 'OPEN_BANK_NOT_FOUND', 404);
    const { H2hDiscoveryOsEngine } = require('./h2hDiscoveryOsEngine');
    const seeded = [];
    const skipped = [];
    for (const url of provider.documentationUrls) {
      try {
        seeded.push(await H2hDiscoveryOsEngine.registerSource({ bankId: provider.providerId, bankName: provider.name, url, kind: 'open-banking-tracker', createdBy: actor }));
      } catch (e) {
        skipped.push({ url, error: e.message, code: e.code || null });
      }
    }
    await this._event(provider.providerId, 'discovery.seeded', actor, { seeded: seeded.length, skipped: skipped.length });
    return { providerId: provider.providerId, seeded, skipped };
  },

  // ── File-drop registration ──────────────────────────────────────────────────

  async registerFileDrop({ providerId, protocol, endpoint = null, as2Id = null, clientId = null, mdnUrl = null, notes = null, actor = null, fromDiscovery = false } = {}) {
    if (!providerId) throw new OpenBankError('providerId is required', 'OPEN_BANK_BAD_REQUEST', 400);
    if (!actor) throw new OpenBankError('actor is required', 'OPEN_BANK_BAD_REQUEST', 400);
    const pid = String(providerId).toLowerCase();
    let values = { protocol, endpoint, as2Id, clientId, mdnUrl };
    let appliedRef = null;
    if (fromDiscovery) {
      const { H2hDiscoveryOsEngine } = require('./h2hDiscoveryOsEngine');
      const applied = await H2hDiscoveryOsEngine.apply({ bankId: pid, actor, partnerId: `OB-${pid.toUpperCase()}`, partnerName: `${pid} (Open Bank file drop)` });
      values = { protocol: applied.protocol, endpoint: applied.values.as2Url || applied.values.baseUrl || applied.values.sftpHost || null, as2Id: applied.values.as2Id, clientId: applied.values.clientId, mdnUrl: applied.values.mdnUrl };
      appliedRef = applied;
    }
    if (!PROTOCOLS.includes(values.protocol)) throw new OpenBankError(`protocol must be one of ${PROTOCOLS.join(', ')}`, 'OPEN_BANK_BAD_REQUEST', 400);
    if (!values.endpoint && !values.as2Id) throw new OpenBankError('endpoint (or as2Id for AS2) is required', 'OPEN_BANK_BAD_REQUEST', 400);
    for (const [k, v] of Object.entries({ endpoint: values.endpoint, mdnUrl: values.mdnUrl })) {
      if (v && values.protocol !== 'sftp' && !/^https:\/\//i.test(v)) throw new OpenBankError(`${k} must be https://`, 'OPEN_BANK_BAD_REQUEST', 400);
    }
    if (/(api[_-]?key|secret|password|private[_-]?key)\s*[:=]/i.test(`${notes || ''} ${values.clientId || ''}`)) {
      throw new OpenBankError('Credentials are never accepted here; store them in Secret Manager and reference by name', 'OPEN_BANK_SECRET_REFUSED', 400);
    }

    let partnerId = appliedRef ? appliedRef.partnerId : null;
    let channelId = appliedRef && appliedRef.protocol === 'sftp' ? (appliedRef.partner && appliedRef.partner.channelId) || null : null;
    if (!appliedRef) {
      if (values.protocol === 'sftp') {
        const { MftOsEngine } = require('./mftOsEngine');
        const [host, port] = String(values.endpoint).replace(/^sftp:\/\//i, '').split(':');
        const ch = await MftOsEngine.registerChannel({ name: `${pid} SFTP (Open Bank)`, bankName: pid, config: { host, port: Number(port) || 22, username: values.clientId || '' }, createdBy: actor });
        channelId = ch.channelId;
      } else {
        const { AS2Partners } = require('../ach/as2Partners');
        partnerId = `OB-${pid.toUpperCase()}`;
        const payload = { partnerName: `${pid} (Open Bank file drop)`, protocol: values.protocol, partnerUrl: values.endpoint, partnerAs2Id: values.as2Id, mdnUrl: values.mdnUrl, apiBaseUrl: values.protocol === 'rest_api' ? values.endpoint : null, notes: `${notes || ''} registered via Open Bank REST API by ${actor}${values.clientId ? `; clientId=${values.clientId}` : ''}`.trim() };
        if (await AS2Partners.getPartner(partnerId)) await AS2Partners.update(partnerId, payload);
        else await AS2Partners.register({ partnerId, ...payload });
      }
    }
    const res = await pool.query(
      `INSERT INTO open_bank_file_drops (file_drop_id, provider_id, protocol, endpoint, as2_id, client_id, mdn_url, partner_id, channel_id, registered_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (provider_id, protocol) DO UPDATE SET endpoint = EXCLUDED.endpoint, as2_id = EXCLUDED.as2_id, client_id = EXCLUDED.client_id, mdn_url = EXCLUDED.mdn_url,
         partner_id = EXCLUDED.partner_id, channel_id = EXCLUDED.channel_id, status = 'registered', registered_by = EXCLUDED.registered_by, registered_at = NOW(), verified_by = NULL, verified_at = NULL, notes = EXCLUDED.notes
       RETURNING *`,
      [newId('OBFD'), pid, values.protocol, values.endpoint, values.as2Id, values.clientId, values.mdnUrl, partnerId, channelId, actor, notes]
    );
    await this._event(pid, 'file_drop.registered', actor, { protocol: values.protocol, partnerId, channelId, fromDiscovery: Boolean(fromDiscovery) });
    return mapFileDrop(res.rows[0]);
  },

  /** A second trustee verifies the registration (maker/checker) once the bank has acknowledged the partner. */
  async verifyFileDrop({ fileDropId, actor } = {}) {
    if (!fileDropId || !actor) throw new OpenBankError('fileDropId and actor are required', 'OPEN_BANK_BAD_REQUEST', 400);
    const cur = await pool.query('SELECT * FROM open_bank_file_drops WHERE file_drop_id = $1', [fileDropId]);
    if (!cur.rows.length) throw new OpenBankError('File drop not found', 'OPEN_BANK_NOT_FOUND', 404);
    if (cur.rows[0].registered_by && cur.rows[0].registered_by === actor) throw new OpenBankError('Verifier must differ from the registering trustee (maker/checker)', 'OPEN_BANK_SAME_ACTOR', 403);
    const res = await pool.query(`UPDATE open_bank_file_drops SET status = 'verified', verified_by = $2, verified_at = NOW() WHERE file_drop_id = $1 RETURNING *`, [fileDropId, actor]);
    await this._event(res.rows[0].provider_id, 'file_drop.verified', actor, { fileDropId });
    return mapFileDrop(res.rows[0]);
  },

  async fileDrops({ providerId = null, status = null } = {}) {
    const res = await pool.query('SELECT * FROM open_bank_file_drops WHERE ($1::text IS NULL OR provider_id = $1) AND ($2::text IS NULL OR status = $2) ORDER BY registered_at DESC', [providerId ? String(providerId).toLowerCase() : null, status]);
    return res.rows.map(mapFileDrop);
  },

  // ── REST API resources (read-only views over the core bank) ─────────────────

  async banks() {
    const cfg = getOpenBankConfig();
    return [{ id: cfg.bankId, shortName: 'DLB Trust', fullName: cfg.bankName, coreBanking: 'Apache Fineract (Cloud Run dlbtrust-fineract)', apiVersion: API_VERSION, baseUrl: cfg.publicBaseUrl ? `${cfg.publicBaseUrl}/api/open-bank/${API_VERSION}` : `/api/open-bank/${API_VERSION}` }];
  },

  async accounts() {
    const { TrustAccountStructure } = require('../fineract/trustAccountStructure');
    const inv = await TrustAccountStructure.inventory();
    const view = (a) => a && ({ id: a.externalId, fineractAccountId: a.id || null, accountNo: a.accountNo || null, role: a.role, glCode: a.glCode, label: a.partyName || a.role, status: a.status || (a.found ? 'found' : 'missing'), active: Boolean(a.active), balance: a.balance ?? null, availableBalance: a.availableBalance ?? null, currency: 'USD' });
    return [view(inv.accountOfRecord), view(inv.principal), view(inv.interestIncome), ...(inv.trustees || []).map(view), ...(inv.beneficiaries || []).map(view)].filter(Boolean);
  },

  async status() {
    const cfg = getOpenBankConfig();
    const [providers, drops] = await Promise.all([this.providers(), this.fileDrops()]);
    return {
      engine: 'open-bank-rest-api',
      enabled: cfg.enabled,
      apiVersion: API_VERSION,
      bank: { id: cfg.bankId, name: cfg.bankName },
      tracker: { base: cfg.trackerBase, index: cfg.trackerIndex },
      providers: { total: providers.length, withPaymentInitiation: providers.filter(p => p.paymentInitiation).length, ids: providers.map(p => p.providerId) },
      fileDrops: { total: drops.length, registered: drops.filter(d => d.status === 'registered').length, verified: drops.filter(d => d.status === 'verified').length, byProtocol: drops.reduce((a, d) => { a[d.protocol] = (a[d.protocol] || 0) + 1; return a; }, {}) },
      policy: { credentialsAccepted: false, httpsOnly: true, makerChecker: true, statuses: FILE_DROP_STATUSES },
    };
  },

  async health() {
    const s = await this.status();
    return { ok: s.enabled, engine: 'open-bank-rest-api', providers: s.providers.total, fileDrops: s.fileDrops.total };
  },

  async readiness() {
    const s = await this.status();
    const blockers = [];
    if (!s.enabled) blockers.push('OPEN_BANK_API_ENABLED=false');
    if (!s.providers.total) blockers.push('no providers imported from the Open Banking Tracker (action=importProvider)');
    if (!s.fileDrops.total) blockers.push('no bank file-drop intake registered (action=registerFileDrop); Betterment publishes no AS2/SFTP/API intake');
    else if (!s.fileDrops.verified) blockers.push(`${s.fileDrops.registered} file drop(s) registered, none verified by a second trustee`);
    return { ready: blockers.length === 0, mode: s.fileDrops.verified ? 'live' : 'shadow', blockers, status: s };
  },

  async list({ limit = 100 } = {}) {
    const res = await pool.query('SELECT * FROM open_bank_events ORDER BY created_at DESC LIMIT $1', [Math.min(500, Math.max(1, Number(limit) || 100))]);
    return res.rows;
  },

  async get(eventId) {
    const res = await pool.query('SELECT * FROM open_bank_events WHERE event_id = $1', [eventId]);
    return res.rows[0] || null;
  },

  async process({ action, actor = null, ...body } = {}) {
    switch (action) {
      case 'trackerIndex': return this.trackerIndex(body);
      case 'importProvider': return this.importProvider({ ...body, actor });
      case 'seedDiscovery': return this.seedDiscovery({ ...body, actor });
      case 'registerFileDrop': return this.registerFileDrop({ ...body, actor });
      case 'verifyFileDrop': return this.verifyFileDrop({ ...body, actor });
      case 'providers': return this.providers(body);
      case 'fileDrops': return this.fileDrops(body);
      case 'accounts': return this.accounts();
      default: throw new OpenBankError(`Unknown action: ${action}`, 'OPEN_BANK_BAD_ACTION', 400);
    }
  },

  async _event(providerId, eventType, actor, detail) {
    await pool.query(
      'INSERT INTO open_bank_events (event_id, provider_id, event_type, actor, detail) VALUES ($1, $2, $3, $4, $5::jsonb)',
      [newId('OBEV'), providerId, eventType, actor, JSON.stringify(detail || {})]
    );
  },
};

module.exports = { OpenBankRestApiOsEngine, OpenBankError, getOpenBankConfig, normalizeProvider, API_VERSION, PROTOCOLS };
