'use strict';

/**
 * H2H Discovery OS — web data scraping for host-to-host (H2H) file-drop onboarding.
 *
 * Banks publish their H2H / MFT / AS2 onboarding details (AS2 identifiers, client
 * IDs, API base URLs, SFTP hosts, MDN endpoints, certificate fingerprints) on
 * developer portals and integration guides. This engine fetches those public
 * pages, extracts candidate values, and holds them as *candidates* until a
 * trustee confirms them. Only confirmed values are applied to the AS2/REST
 * partner register (AS2Partners) or an MFT channel — never a scraped secret:
 * API keys, passwords and private keys are refused at extraction time.
 *
 *   sources      One public URL per bank/document, restricted to an allow-list
 *                of hosts (H2H_DISCOVERY_ALLOWED_HOSTS) so the scraper can never
 *                be pointed at an internal service.
 *   scan         Fetch (HTTPS only, size/time capped), strip markup, extract
 *                candidates per field with conservative patterns, dedupe by
 *                (source, field, value). Nothing is applied.
 *   confirm      A trustee marks a candidate confirmed or rejected.
 *   apply        A *different* trustee than the confirmer applies the confirmed
 *                candidates for a bank onto a partner record (maker/checker).
 *   readiness    live only once a bank has confirmed+applied intake values;
 *                otherwise shadow with the honest blocker.
 */

const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const pool = require('../bonds/pgPool');

const FIELDS = {
  as2_id: { label: 'AS2 ID', patterns: [/AS2[\s-]*(?:ID|identifier|name)\s*[:=]\s*["']?([A-Za-z0-9_.\-]{3,64})/gi] },
  client_id: { label: 'Client ID', patterns: [/client[\s_-]*id\s*[:=]\s*["']?([A-Za-z0-9_.\-]{4,128})/gi] },
  base_url: { label: 'API base URL', patterns: [/(?:base|api)[\s_-]*url\s*[:=]?\s*["']?(https:\/\/[A-Za-z0-9._\-]+(?:\/[A-Za-z0-9._\-\/]*)?)/gi, /(https:\/\/api[A-Za-z0-9._\-]*\.[A-Za-z0-9.\-]+(?:\/[A-Za-z0-9._\-\/]*)?)/gi] },
  sftp_host: { label: 'SFTP host', patterns: [/sftp:\/\/([A-Za-z0-9.\-]+)(?::(\d+))?/gi, /sftp[\s_-]*(?:host|server|hostname)\s*[:=]\s*["']?([A-Za-z0-9.\-]+\.[A-Za-z]{2,})/gi] },
  as2_url: { label: 'AS2 endpoint URL', patterns: [/AS2[\s_-]*(?:url|endpoint)\s*[:=]?\s*["']?(https:\/\/[A-Za-z0-9._\-]+(?:\/[A-Za-z0-9._\-\/]*)?)/gi] },
  mdn_url: { label: 'MDN URL', patterns: [/MDN[\s_-]*(?:url|endpoint)\s*[:=]?\s*["']?(https:\/\/[A-Za-z0-9._\-]+(?:\/[A-Za-z0-9._\-\/]*)?)/gi] },
  cert_fingerprint: { label: 'Certificate fingerprint', patterns: [/(?:SHA-?256|fingerprint|thumbprint)\s*[:=]?\s*((?:[0-9A-Fa-f]{2}[: ]){15,31}[0-9A-Fa-f]{2})/g] },
  routing_number: { label: 'ODFI routing number', patterns: [/(?:routing|ABA)[\s_-]*(?:number|no\.?|#)?\s*[:=]\s*(\d{9})\b/gi] },
};

const SECRET_PATTERNS = [/api[\s_-]*(?:key|secret)\s*[:=]/i, /password\s*[:=]/i, /BEGIN (?:RSA |EC )?PRIVATE KEY/i, /client[\s_-]*secret\s*[:=]/i, /bearer\s+[A-Za-z0-9._\-]{16,}/i];
// Redact secret-bearing spans (label + following token) before any text is stored as candidate context.
const SECRET_REDACT = [
  /(api[\s_-]*(?:key|secret)|client[\s_-]*secret|password|passphrase|secret[\s_-]*key|access[\s_-]*token)\s*[:=]\s*["']?[^\s"'<]{1,512}/gi,
  /bearer\s+[A-Za-z0-9._\-]{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

function redactSecrets(text) {
  return SECRET_REDACT.reduce((s, re) => s.replace(re, (m, label) => `${label || 'secret'}: [REDACTED]`), text);
}

const CANDIDATE_STATUSES = ['candidate', 'confirmed', 'rejected', 'applied'];
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;

class H2hDiscoveryError extends Error {
  constructor(message, code = 'H2H_DISCOVERY_ERROR', status = 409, details = {}) {
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

function getH2hConfig(env = process.env) {
  const allowed = String(env.H2H_DISCOVERY_ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return {
    enabled: String(env.H2H_DISCOVERY_ENABLED || 'true').toLowerCase() !== 'false',
    allowedHosts: allowed,
    maxBytes: Number(env.H2H_DISCOVERY_MAX_BYTES) || DEFAULT_MAX_BYTES,
    timeoutMs: Number(env.H2H_DISCOVERY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    userAgent: text('H2H_DISCOVERY_USER_AGENT', 'dlbtrust-h2h-discovery/1.0 (+treasury onboarding)'),
    requireDistinctApplier: String(env.H2H_DISCOVERY_REQUIRE_DISTINCT_APPLIER || 'true').toLowerCase() !== 'false',
  };
}

function hostAllowed(hostname, allowedHosts) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return false;
  if (!allowedHosts.length) return false;
  return allowedHosts.some(a => h === a || h.endsWith(`.${a}`));
}

function stripMarkup(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pure extraction: text → [{ field, value, context }] (no secrets, deduped). */
function extractCandidates(rawText) {
  const t = redactSecrets(stripMarkup(rawText));
  const out = [];
  const seen = new Set();
  for (const [field, def] of Object.entries(FIELDS)) {
    for (const re of def.patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(t)) !== null) {
        const value = field === 'sftp_host' && m[2] ? `${m[1]}:${m[2]}` : String(m[1] || '').trim();
        if (!value) continue;
        const start = Math.max(0, m.index - 80);
        const context = t.slice(start, Math.min(t.length, m.index + m[0].length + 80));
        if (SECRET_PATTERNS.some(sp => sp.test(m[0]))) continue;
        const key = `${field}|${value.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ field, value, context });
      }
    }
  }
  return out;
}

function fetchPublic(url, cfg) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new H2hDiscoveryError(`Invalid URL: ${url}`, 'H2H_BAD_URL', 400)); }
    if (u.protocol !== 'https:') return reject(new H2hDiscoveryError('Only https:// sources are scanned', 'H2H_BAD_URL', 400));
    if (!hostAllowed(u.hostname, cfg.allowedHosts)) {
      return reject(new H2hDiscoveryError(`Host ${u.hostname} is not in H2H_DISCOVERY_ALLOWED_HOSTS`, 'H2H_HOST_NOT_ALLOWED', 403, { host: u.hostname }));
    }
    const req = https.request(u, { method: 'GET', headers: { 'User-Agent': cfg.userAgent, Accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5' }, timeout: cfg.timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, u).toString(); } catch { return reject(new H2hDiscoveryError('Bad redirect', 'H2H_FETCH', 502)); }
        return fetchPublic(next, cfg).then(resolve, reject);
      }
      if (!res.statusCode || res.statusCode >= 400) {
        res.resume();
        return reject(new H2hDiscoveryError(`HTTP ${res.statusCode} from ${u.hostname}`, 'H2H_FETCH', 502));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > cfg.maxBytes) { req.destroy(new H2hDiscoveryError(`Response exceeds ${cfg.maxBytes} bytes`, 'H2H_TOO_LARGE', 502)); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'] || '', body: Buffer.concat(chunks).toString('utf8'), finalUrl: u.toString() }));
    });
    req.on('timeout', () => req.destroy(new H2hDiscoveryError('Fetch timed out', 'H2H_TIMEOUT', 504)));
    req.on('error', (e) => reject(e instanceof H2hDiscoveryError ? e : new H2hDiscoveryError(e.message, 'H2H_FETCH', 502)));
    req.end();
  });
}

function mapSource(r) {
  return {
    sourceId: r.source_id, bankId: r.bank_id, bankName: r.bank_name, url: r.url, kind: r.kind, status: r.status,
    lastScanAt: r.last_scan_at, lastScanStatus: r.last_scan_status, lastScanError: r.last_scan_error, candidateCount: Number(r.candidate_count || 0),
    createdBy: r.created_by, createdAt: r.created_at,
  };
}

function mapCandidate(r) {
  return {
    candidateId: r.candidate_id, sourceId: r.source_id, bankId: r.bank_id, field: r.field, label: (FIELDS[r.field] || {}).label || r.field, value: r.value, context: r.context,
    status: r.status, discoveredAt: r.discovered_at, confirmedBy: r.confirmed_by, confirmedAt: r.confirmed_at, appliedBy: r.applied_by, appliedAt: r.applied_at, appliedTo: r.applied_to,
  };
}

const H2hDiscoveryOsEngine = {
  FIELDS,
  extractCandidates,
  stripMarkup,
  hostAllowed,
  _fetch: fetchPublic,

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS h2h_discovery_sources (
        source_id TEXT PRIMARY KEY,
        bank_id TEXT NOT NULL,
        bank_name TEXT,
        url TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'developer-portal',
        status TEXT NOT NULL DEFAULT 'active',
        last_scan_at TIMESTAMPTZ,
        last_scan_status TEXT,
        last_scan_error TEXT,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (bank_id, url)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS h2h_discovery_candidates (
        candidate_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES h2h_discovery_sources(source_id) ON DELETE CASCADE,
        bank_id TEXT NOT NULL,
        field TEXT NOT NULL,
        value TEXT NOT NULL,
        context TEXT,
        status TEXT NOT NULL DEFAULT 'candidate',
        discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        confirmed_by TEXT,
        confirmed_at TIMESTAMPTZ,
        applied_by TEXT,
        applied_at TIMESTAMPTZ,
        applied_to TEXT,
        UNIQUE (source_id, field, value)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS h2h_discovery_events (
        event_id TEXT PRIMARY KEY,
        source_id TEXT,
        bank_id TEXT,
        event_type TEXT NOT NULL,
        actor TEXT,
        detail JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
  },

  async registerSource({ bankId, bankName = null, url, kind = 'developer-portal', createdBy = null } = {}) {
    if (!bankId) throw new H2hDiscoveryError('bankId is required', 'H2H_BAD_SOURCE', 400);
    if (!url) throw new H2hDiscoveryError('url is required', 'H2H_BAD_SOURCE', 400);
    const cfg = getH2hConfig();
    let u;
    try { u = new URL(url); } catch { throw new H2hDiscoveryError(`Invalid URL: ${url}`, 'H2H_BAD_URL', 400); }
    if (u.protocol !== 'https:') throw new H2hDiscoveryError('Only https:// sources are allowed', 'H2H_BAD_URL', 400);
    if (!hostAllowed(u.hostname, cfg.allowedHosts)) {
      throw new H2hDiscoveryError(`Host ${u.hostname} is not in H2H_DISCOVERY_ALLOWED_HOSTS`, 'H2H_HOST_NOT_ALLOWED', 403, { host: u.hostname, allowedHosts: cfg.allowedHosts });
    }
    const sourceId = newId('H2HSRC');
    const res = await pool.query(
      `INSERT INTO h2h_discovery_sources (source_id, bank_id, bank_name, url, kind, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (bank_id, url) DO UPDATE SET bank_name = COALESCE(EXCLUDED.bank_name, h2h_discovery_sources.bank_name), kind = EXCLUDED.kind, status = 'active'
       RETURNING *`,
      [sourceId, String(bankId).toLowerCase(), bankName, u.toString(), kind, createdBy]
    );
    const row = res.rows[0];
    await this._event(row.source_id, row.bank_id, 'source.registered', createdBy, { url: row.url, kind });
    return mapSource(row);
  },

  async sources({ bankId = null } = {}) {
    const res = await pool.query(
      `SELECT s.*, (SELECT COUNT(*) FROM h2h_discovery_candidates c WHERE c.source_id = s.source_id) AS candidate_count
         FROM h2h_discovery_sources s
        WHERE ($1::text IS NULL OR s.bank_id = $1)
        ORDER BY s.bank_id, s.created_at`,
      [bankId ? String(bankId).toLowerCase() : null]
    );
    return res.rows.map(mapSource);
  },

  async candidates({ bankId = null, sourceId = null, status = null, field = null, limit = 200 } = {}) {
    const res = await pool.query(
      `SELECT * FROM h2h_discovery_candidates
        WHERE ($1::text IS NULL OR bank_id = $1)
          AND ($2::text IS NULL OR source_id = $2)
          AND ($3::text IS NULL OR status = $3)
          AND ($4::text IS NULL OR field = $4)
        ORDER BY bank_id, field, discovered_at DESC
        LIMIT $5`,
      [bankId ? String(bankId).toLowerCase() : null, sourceId, status, field, Math.min(1000, Math.max(1, Number(limit) || 200))]
    );
    return res.rows.map(mapCandidate);
  },

  /** Scan one source (or every active source of a bank). Read-only against the bank: nothing is applied. */
  async scan({ sourceId = null, bankId = null, actor = null } = {}) {
    const cfg = getH2hConfig();
    if (!cfg.enabled) throw new H2hDiscoveryError('H2H_DISCOVERY_ENABLED=false', 'H2H_DISABLED', 409);
    const res = await pool.query(
      `SELECT * FROM h2h_discovery_sources WHERE status = 'active' AND ($1::text IS NULL OR source_id = $1) AND ($2::text IS NULL OR bank_id = $2)`,
      [sourceId, bankId ? String(bankId).toLowerCase() : null]
    );
    if (!res.rows.length) throw new H2hDiscoveryError('No active source matches', 'H2H_NO_SOURCE', 404);
    const results = [];
    for (const src of res.rows) {
      let fetched;
      try {
        fetched = await this._fetch(src.url, cfg);
      } catch (e) {
        await pool.query('UPDATE h2h_discovery_sources SET last_scan_at = NOW(), last_scan_status = $2, last_scan_error = $3 WHERE source_id = $1', [src.source_id, 'error', e.message]);
        await this._event(src.source_id, src.bank_id, 'scan.failed', actor, { error: e.message, code: e.code || null });
        results.push({ sourceId: src.source_id, bankId: src.bank_id, url: src.url, ok: false, error: e.message, code: e.code || null });
        continue;
      }
      const found = extractCandidates(fetched.body);
      let inserted = 0;
      for (const c of found) {
        const ins = await pool.query(
          `INSERT INTO h2h_discovery_candidates (candidate_id, source_id, bank_id, field, value, context)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (source_id, field, value) DO NOTHING`,
          [newId('H2HC'), src.source_id, src.bank_id, c.field, c.value, c.context]
        );
        inserted += ins.rowCount || 0;
      }
      await pool.query('UPDATE h2h_discovery_sources SET last_scan_at = NOW(), last_scan_status = $2, last_scan_error = NULL WHERE source_id = $1', [src.source_id, 'ok']);
      await this._event(src.source_id, src.bank_id, 'scan.completed', actor, { url: fetched.finalUrl, bytes: fetched.body.length, found: found.length, inserted });
      results.push({ sourceId: src.source_id, bankId: src.bank_id, url: src.url, ok: true, found: found.length, inserted, byField: found.reduce((acc, c) => { acc[c.field] = (acc[c.field] || 0) + 1; return acc; }, {}) });
    }
    return { scanned: results.length, results };
  },

  async confirm({ candidateId, actor, decision = 'confirmed' } = {}) {
    if (!candidateId) throw new H2hDiscoveryError('candidateId is required', 'H2H_BAD_REQUEST', 400);
    if (!actor) throw new H2hDiscoveryError('actor is required', 'H2H_BAD_REQUEST', 400);
    if (!['confirmed', 'rejected'].includes(decision)) throw new H2hDiscoveryError('decision must be confirmed or rejected', 'H2H_BAD_REQUEST', 400);
    const res = await pool.query(
      `UPDATE h2h_discovery_candidates SET status = $2, confirmed_by = $3, confirmed_at = NOW()
        WHERE candidate_id = $1 AND status IN ('candidate', 'confirmed', 'rejected') RETURNING *`,
      [candidateId, decision, actor]
    );
    if (!res.rows.length) throw new H2hDiscoveryError('Candidate not found or already applied', 'H2H_NOT_FOUND', 404);
    const row = res.rows[0];
    await this._event(row.source_id, row.bank_id, `candidate.${decision}`, actor, { candidateId, field: row.field });
    return mapCandidate(row);
  },

  /**
   * Apply the confirmed candidates of a bank onto its partner record. Maker/checker:
   * the applier must differ from whoever confirmed each candidate. Never writes a
   * credential — only identifiers/endpoints. Returns the partner payload written.
   */
  async apply({ bankId, actor, partnerId = null, partnerName = null } = {}) {
    if (!bankId) throw new H2hDiscoveryError('bankId is required', 'H2H_BAD_REQUEST', 400);
    if (!actor) throw new H2hDiscoveryError('actor is required', 'H2H_BAD_REQUEST', 400);
    const cfg = getH2hConfig();
    const bid = String(bankId).toLowerCase();
    const confirmed = await this.candidates({ bankId: bid, status: 'confirmed', limit: 500 });
    if (!confirmed.length) throw new H2hDiscoveryError('No confirmed candidates for this bank', 'H2H_NOTHING_TO_APPLY', 409);
    if (cfg.requireDistinctApplier) {
      const self = confirmed.filter(c => c.confirmedBy && c.confirmedBy === actor);
      if (self.length) throw new H2hDiscoveryError('Applier must differ from the confirming trustee (maker/checker)', 'H2H_SAME_ACTOR', 403, { candidateIds: self.map(c => c.candidateId) });
    }
    const pick = (field) => (confirmed.find(c => c.field === field) || {}).value || null;
    const values = {
      as2Id: pick('as2_id'), clientId: pick('client_id'), baseUrl: pick('base_url'), as2Url: pick('as2_url'), mdnUrl: pick('mdn_url'),
      sftpHost: pick('sftp_host'), certFingerprint: pick('cert_fingerprint'), routingNumber: pick('routing_number'),
    };
    const protocol = values.as2Id || values.as2Url ? 'as2' : values.baseUrl ? 'rest_api' : values.sftpHost ? 'sftp' : null;
    if (!protocol) throw new H2hDiscoveryError('Confirmed candidates do not include an intake endpoint (AS2 ID/URL, base URL or SFTP host)', 'H2H_NO_ENDPOINT', 409, { values });

    const { AS2Partners } = require('../ach/as2Partners');
    const pid = partnerId || `H2H-${bid.toUpperCase()}`;
    const name = partnerName || `${bid} (H2H discovered)`;
    const notes = `Applied from H2H discovery by ${actor} at ${new Date().toISOString()}${values.clientId ? `; clientId=${values.clientId}` : ''}${values.certFingerprint ? `; cert=${values.certFingerprint}` : ''}${values.routingNumber ? `; routing=${values.routingNumber}` : ''}`;
    let partner;
    const existing = await AS2Partners.getPartner(pid);
    if (protocol === 'sftp') {
      const { MftOsEngine } = require('./mftOsEngine');
      const [host, port] = String(values.sftpHost).split(':');
      partner = await MftOsEngine.registerChannel({ name: `${name} SFTP`, bankName: name, config: { host, port: Number(port) || 22, username: values.clientId || '' }, createdBy: actor });
    } else if (existing) {
      partner = await AS2Partners.update(pid, {
        partnerName: name, protocol,
        partnerUrl: values.as2Url || values.baseUrl || undefined, partnerAs2Id: values.as2Id || undefined,
        mdnUrl: values.mdnUrl || undefined, apiBaseUrl: values.baseUrl || undefined, notes,
      });
    } else {
      partner = await AS2Partners.register({
        partnerId: pid, partnerName: name, protocol,
        partnerUrl: values.as2Url || values.baseUrl || null, partnerAs2Id: values.as2Id || null,
        mdnUrl: values.mdnUrl || null, apiBaseUrl: values.baseUrl || null, notes,
      });
    }
    await pool.query(
      `UPDATE h2h_discovery_candidates SET status = 'applied', applied_by = $2, applied_at = NOW(), applied_to = $3 WHERE candidate_id = ANY($1)`,
      [confirmed.map(c => c.candidateId), actor, protocol === 'sftp' ? `mft:${partner && partner.channelId}` : `as2_partners:${pid}`]
    );
    await this._event(null, bid, 'candidates.applied', actor, { protocol, partnerId: pid, fields: confirmed.map(c => c.field) });
    return { bankId: bid, protocol, partnerId: pid, applied: confirmed.length, values: { ...values }, partner: partner && (partner.partnerId || partner.partner_id || partner.channelId) ? partner : { partnerId: pid } };
  },

  async status() {
    const cfg = getH2hConfig();
    const [sources, counts] = await Promise.all([
      this.sources(),
      pool.query(`SELECT status, COUNT(*)::int AS n FROM h2h_discovery_candidates GROUP BY status`),
    ]);
    const byStatus = Object.fromEntries(CANDIDATE_STATUSES.map(s => [s, 0]));
    for (const r of counts.rows) byStatus[r.status] = r.n;
    const banks = [...new Set(sources.map(s => s.bankId))];
    const appliedBanks = (await pool.query(`SELECT DISTINCT bank_id FROM h2h_discovery_candidates WHERE status = 'applied'`)).rows.map(r => r.bank_id);
    return {
      engine: 'h2h-discovery',
      enabled: cfg.enabled,
      allowedHosts: cfg.allowedHosts,
      policy: { httpsOnly: true, secretsNeverStored: true, requireDistinctApplier: cfg.requireDistinctApplier, maxBytes: cfg.maxBytes, timeoutMs: cfg.timeoutMs },
      fields: Object.keys(FIELDS),
      sources: { total: sources.length, banks, lastScanOk: sources.filter(s => s.lastScanStatus === 'ok').length, lastScanError: sources.filter(s => s.lastScanStatus === 'error').length },
      candidates: byStatus,
      appliedBanks,
    };
  },

  async health() {
    const s = await this.status();
    return { ok: s.enabled, engine: 'h2h-discovery', sources: s.sources.total, candidates: s.candidates };
  },

  async readiness() {
    const s = await this.status();
    const blockers = [];
    if (!s.enabled) blockers.push('H2H_DISCOVERY_ENABLED=false');
    if (!s.allowedHosts.length) blockers.push('H2H_DISCOVERY_ALLOWED_HOSTS is empty: no bank documentation host may be scanned');
    if (!s.sources.total) blockers.push('no discovery sources registered (POST /api/os/h2h-discovery/process action=registerSource)');
    if (s.sources.total && !s.candidates.candidate && !s.candidates.confirmed && !s.candidates.applied) blockers.push('no intake candidates discovered yet (run action=scan)');
    if (s.candidates.confirmed) blockers.push(`${s.candidates.confirmed} confirmed candidate(s) awaiting apply by a second trustee`);
    if (!s.appliedBanks.length) blockers.push('no bank has confirmed+applied H2H intake values; file drop stays shadow');
    return { ready: blockers.length === 0, mode: s.appliedBanks.length ? 'live' : 'shadow', blockers, status: s };
  },

  async list({ limit = 100 } = {}) {
    const res = await pool.query('SELECT * FROM h2h_discovery_events ORDER BY created_at DESC LIMIT $1', [Math.min(500, Math.max(1, Number(limit) || 100))]);
    return res.rows;
  },

  async get(eventId) {
    const res = await pool.query('SELECT * FROM h2h_discovery_events WHERE event_id = $1', [eventId]);
    return res.rows[0] || null;
  },

  async process({ action, actor = null, ...body } = {}) {
    switch (action) {
      case 'registerSource': return this.registerSource({ ...body, createdBy: actor });
      case 'scan': return this.scan({ ...body, actor });
      case 'confirm': return this.confirm({ ...body, actor });
      case 'reject': return this.confirm({ ...body, actor, decision: 'rejected' });
      case 'apply': return this.apply({ ...body, actor });
      case 'candidates': return this.candidates(body);
      case 'sources': return this.sources(body);
      default: throw new H2hDiscoveryError(`Unknown action: ${action}`, 'H2H_BAD_ACTION', 400);
    }
  },

  async _event(sourceId, bankId, eventType, actor, detail) {
    await pool.query(
      'INSERT INTO h2h_discovery_events (event_id, source_id, bank_id, event_type, actor, detail) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
      [newId('H2HEV'), sourceId, bankId, eventType, actor, JSON.stringify(detail || {})]
    );
  },
};

module.exports = { H2hDiscoveryOsEngine, H2hDiscoveryError, getH2hConfig, extractCandidates, stripMarkup, hostAllowed, FIELDS };
