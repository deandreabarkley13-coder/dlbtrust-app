'use strict';

/**
 * Egress OS — the one door out of the trust's GCP workload.
 *
 * Every outbound call the platform makes (Fineract, OpenACH, PHEE, the bank
 * H2H hosts, the Open Banking Tracker dataset) leaves Cloud Run through the
 * Serverless VPC connector with egress=ALL_TRAFFIC and exits the VPC through
 * Cloud NAT on one static address (infra/gcp/backends.tf,
 * google_compute_address.egress). This engine is the policy and the audit for
 * that door:
 *
 *   • an allow-list of destination hosts (EGRESS_ALLOWED_HOSTS + the hosts the
 *     other engines are configured with) and a deny-list of retired ones
 *     (EGRESS_DENIED_HOSTS — blockchain / stablecoin / Stripe rails);
 *   • `authorize(url)` — the check other engines call before opening a socket;
 *     denied and un-listed hosts are refused (fail-closed when
 *     EGRESS_ENFORCE=true) and every decision is written to egress_events;
 *   • `probe()` — proves the static NAT IP (EGRESS_STATIC_IP) is what the
 *     internet actually sees, by asking an allow-listed echo endpoint;
 *   • readiness — shadow until enforcement is on, the static IP is declared
 *     and verified, and no retired host is reachable through the policy.
 *
 * It never opens a connection for anyone else; it only says yes or no.
 */

const https = require('https');
const { URL } = require('url');
const pool = require('../bonds/pgPool');

const DEFAULT_ECHO_URL = 'https://api.ipify.org?format=json';

// Hosts that must never be reachable again: the retired on-chain / stablecoin
// / Stripe rails. Kept in code so an env typo can't silently re-open them.
const RETIRED_HOSTS = [
  'api.stripe.com', 'files.stripe.com',
  'thirdweb.com', 'api.thirdweb.com', 'rpc.thirdweb.com',
  'spritz.finance', 'api.spritz.finance',
  'hedera.com', 'mainnet-public.mirrornode.hedera.com',
  'mainnet.infura.io', 'polygon-rpc.com', 'bsc-dataseed.binance.org', 'arb1.arbitrum.io', 'mainnet.base.org',
];

class EgressError extends Error {
  constructor(message, code = 'EGRESS_ERROR', status = 409, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function list(v) {
  return String(v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function hostOf(u) {
  try { return new URL(String(u)).hostname.toLowerCase(); } catch { return ''; }
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(16).slice(2, 8).toUpperCase()}`;
}

/** Hosts the other engines are configured to talk to, derived from their env. */
function derivedHosts(env = process.env) {
  const out = new Set();
  for (const k of ['FINERACT_URL', 'OPENACH_BASE_URL', 'PAYMENT_HUB_BASE_URL', 'MFTGATEWAY_BASE_URL', 'OPEN_BANKING_TRACKER_BASE_URL', 'OPEN_BANKING_TRACKER_INDEX_URL', 'EGRESS_ECHO_URL']) {
    const h = hostOf(env[k]);
    if (h) out.add(h);
  }
  for (const h of list(env.H2H_DISCOVERY_ALLOWED_HOSTS)) out.add(h);
  // Google APIs the runtime itself needs (Secret Manager, Cloud SQL connector, GCS, metadata).
  for (const h of ['secretmanager.googleapis.com', 'sqladmin.googleapis.com', 'storage.googleapis.com', 'oauth2.googleapis.com', 'www.googleapis.com', 'metadata.google.internal', 'run.googleapis.com', 'logging.googleapis.com']) out.add(h);
  return [...out];
}

function getEgressConfig(env = process.env) {
  const explicit = list(env.EGRESS_ALLOWED_HOSTS);
  const derived = derivedHosts(env);
  const denied = [...new Set([...RETIRED_HOSTS, ...list(env.EGRESS_DENIED_HOSTS)])];
  return {
    enabled: String(env.EGRESS_OS_ENABLED || 'true').toLowerCase() !== 'false',
    enforce: String(env.EGRESS_ENFORCE || 'false').toLowerCase() === 'true',
    staticIp: String(env.EGRESS_STATIC_IP || '').trim() || null,
    echoUrl: String(env.EGRESS_ECHO_URL || DEFAULT_ECHO_URL).trim(),
    vpcConnector: String(env.EGRESS_VPC_CONNECTOR || '').trim() || null,
    natName: String(env.EGRESS_NAT_NAME || 'dlbtrust-egress').trim(),
    allowedHosts: [...new Set([...explicit, ...derived])],
    explicitHosts: explicit,
    derivedHosts: derived,
    deniedHosts: denied,
    httpsOnly: String(env.EGRESS_HTTPS_ONLY || 'true').toLowerCase() !== 'false',
    timeoutMs: Number(env.EGRESS_PROBE_TIMEOUT_MS) || 8000,
  };
}

function matches(host, patterns) {
  return patterns.some(p => host === p || host.endsWith(`.${p}`));
}

/** Pure decision: { allowed, reason, host, protocol } — no I/O. */
function decide(url, cfg = getEgressConfig()) {
  let u;
  try { u = new URL(String(url)); } catch { return { allowed: false, host: null, protocol: null, reason: 'invalid URL' }; }
  const host = u.hostname.toLowerCase();
  const protocol = u.protocol.replace(':', '');
  if (matches(host, cfg.deniedHosts)) return { allowed: false, host, protocol, reason: `host ${host} is on the egress deny-list (retired rail)` };
  if (cfg.httpsOnly && protocol !== 'https' && host !== 'metadata.google.internal') return { allowed: false, host, protocol, reason: `${protocol}:// egress refused; EGRESS_HTTPS_ONLY` };
  if (!matches(host, cfg.allowedHosts)) return { allowed: false, host, protocol, reason: `host ${host} is not on the egress allow-list (EGRESS_ALLOWED_HOSTS)` };
  return { allowed: true, host, protocol, reason: null };
}

const EgressOsEngine = {
  Error: EgressError,
  getConfig: getEgressConfig,
  decide,

  async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS egress_events (
        event_id     VARCHAR(64) PRIMARY KEY,
        event_type   VARCHAR(48) NOT NULL,
        host         VARCHAR(255),
        protocol     VARCHAR(16),
        allowed      BOOLEAN,
        enforced     BOOLEAN NOT NULL DEFAULT FALSE,
        caller       VARCHAR(64),
        actor        VARCHAR(128),
        reason       TEXT,
        detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_egress_events_host ON egress_events(host, created_at DESC)');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS egress_probes (
        probe_id     VARCHAR(64) PRIMARY KEY,
        echo_url     TEXT NOT NULL,
        observed_ip  VARCHAR(64),
        expected_ip  VARCHAR(64),
        matched      BOOLEAN,
        error        TEXT,
        actor        VARCHAR(128),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
  },

  /**
   * The check callers make before connecting. Returns the decision; throws
   * (fail-closed) when enforcement is on and the decision is "no".
   */
  async authorize(url, { caller = null, actor = null, record = true } = {}) {
    const cfg = getEgressConfig();
    const d = decide(url, cfg);
    const enforced = cfg.enabled && cfg.enforce;
    if (record && pool) {
      await pool.query(
        'INSERT INTO egress_events (event_id, event_type, host, protocol, allowed, enforced, caller, actor, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [newId('EGR'), d.allowed ? 'egress.allowed' : 'egress.refused', d.host, d.protocol, d.allowed, enforced, caller, actor, d.reason]
      ).catch(() => {});
    }
    if (!d.allowed && enforced) throw new EgressError(d.reason, 'EGRESS_REFUSED', 403, { host: d.host, caller });
    return { ...d, enforced, wouldBlock: !d.allowed && !enforced };
  },

  _fetchJson(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { timeout: timeoutMs, headers: { 'user-agent': 'dlbtrust-egress-os/1.0' } }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => { body += c; if (body.length > 65536) req.destroy(new Error('echo response too large')); });
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`echo returned HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(body)); } catch { resolve({ ip: body.trim() }); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('echo timeout')));
      req.on('error', reject);
    });
  },

  /** Ask the echo endpoint which public IP our egress presents, compare with EGRESS_STATIC_IP. */
  async probe({ actor = null } = {}) {
    const cfg = getEgressConfig();
    const d = decide(cfg.echoUrl, cfg);
    const row = { probeId: newId('EGRP'), echoUrl: cfg.echoUrl, observedIp: null, expectedIp: cfg.staticIp, matched: null, error: null };
    if (!d.allowed) row.error = `echo endpoint refused by policy: ${d.reason}`;
    else {
      try {
        const j = await this._fetchJson(cfg.echoUrl, cfg.timeoutMs);
        row.observedIp = String(j.ip || j.origin || '').trim() || null;
        row.matched = Boolean(cfg.staticIp && row.observedIp === cfg.staticIp);
      } catch (e) { row.error = e.message; }
    }
    if (pool) {
      await pool.query(
        'INSERT INTO egress_probes (probe_id, echo_url, observed_ip, expected_ip, matched, error, actor) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [row.probeId, row.echoUrl, row.observedIp, row.expectedIp, row.matched, row.error, actor]
      );
    }
    return row;
  },

  async lastProbe() {
    if (!pool) return null;
    const r = await pool.query('SELECT * FROM egress_probes ORDER BY created_at DESC LIMIT 1');
    const p = r.rows[0];
    return p ? { probeId: p.probe_id, observedIp: p.observed_ip, expectedIp: p.expected_ip, matched: p.matched, error: p.error, at: p.created_at } : null;
  },

  /** Policy check of every host the platform is configured to call, without connecting. */
  audit() {
    const cfg = getEgressConfig();
    const hosts = [...new Set([...cfg.derivedHosts, ...cfg.explicitHosts])];
    const rows = hosts.map(h => ({ host: h, ...decide(`https://${h}/`, cfg) }));
    const deniedButConfigured = rows.filter(r => !r.allowed && matches(r.host, cfg.deniedHosts)).map(r => r.host);
    return { hosts: rows, deniedButConfigured };
  },

  async status() {
    const cfg = getEgressConfig();
    const audit = this.audit();
    let counts = { allowed: 0, refused: 0 };
    if (pool) {
      const r = await pool.query(`SELECT allowed, COUNT(*)::int AS n FROM egress_events WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY allowed`);
      for (const row of r.rows) counts[row.allowed ? 'allowed' : 'refused'] = row.n;
    }
    return {
      engine: 'egress',
      enabled: cfg.enabled,
      enforce: cfg.enforce,
      httpsOnly: cfg.httpsOnly,
      path: { vpcConnector: cfg.vpcConnector, nat: cfg.natName, staticIp: cfg.staticIp, egress: 'ALL_TRAFFIC via Serverless VPC connector → Cloud NAT (infra/gcp/backends.tf)' },
      allowedHosts: cfg.allowedHosts,
      deniedHosts: cfg.deniedHosts,
      audit,
      last24h: counts,
      lastProbe: await this.lastProbe(),
    };
  },

  async health() {
    const s = await this.status();
    return { ok: s.enabled, engine: 'egress', enforce: s.enforce, staticIp: s.path.staticIp };
  },

  async readiness() {
    const s = await this.status();
    const blockers = [];
    if (!s.enabled) blockers.push('EGRESS_OS_ENABLED=false');
    if (!s.enforce) blockers.push('EGRESS_ENFORCE=false (decisions are audited but not enforced)');
    if (!s.path.staticIp) blockers.push('EGRESS_STATIC_IP not set (expected: google_compute_address.egress in infra/gcp/backends.tf)');
    if (!s.path.vpcConnector) blockers.push('EGRESS_VPC_CONNECTOR not set (Serverless VPC connector name)');
    if (s.audit.deniedButConfigured.length) blockers.push(`retired hosts still configured: ${s.audit.deniedButConfigured.join(', ')}`);
    if (!s.lastProbe) blockers.push('no egress probe yet (action=probe verifies the static NAT IP)');
    else if (s.lastProbe.error) blockers.push(`last egress probe failed: ${s.lastProbe.error}`);
    else if (!s.lastProbe.matched) blockers.push(`egress IP ${s.lastProbe.observedIp} does not match EGRESS_STATIC_IP ${s.lastProbe.expectedIp}`);
    const live = s.enabled && s.enforce && s.lastProbe && s.lastProbe.matched && !s.audit.deniedButConfigured.length;
    return { ready: blockers.length === 0, mode: live ? 'live' : 'shadow', blockers, status: s };
  },

  async list({ limit = 100 } = {}) {
    if (!pool) return [];
    const r = await pool.query('SELECT * FROM egress_events ORDER BY created_at DESC LIMIT $1', [Math.min(500, Math.max(1, Number(limit) || 100))]);
    return r.rows;
  },

  async get(eventId) {
    if (!pool) return null;
    const r = await pool.query('SELECT * FROM egress_events WHERE event_id = $1', [eventId]);
    return r.rows[0] || null;
  },

  async process({ action, actor = null, ...body } = {}) {
    switch (action) {
      case 'authorize': return this.authorize(body.url, { caller: body.caller || 'operator', actor, record: body.record !== false });
      case 'decide': return decide(body.url);
      case 'probe': return this.probe({ actor });
      case 'audit': return this.audit();
      default: throw new EgressError(`Unknown action: ${action}`, 'EGRESS_BAD_ACTION', 400);
    }
  },
};

module.exports = { EgressOsEngine, EgressError, getEgressConfig, decide, derivedHosts, RETIRED_HOSTS };
