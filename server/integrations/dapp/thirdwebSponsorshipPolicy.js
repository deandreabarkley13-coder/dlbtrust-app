'use strict';

/**
 * thirdweb gas-sponsorship policy — the trust's own server verifier.
 *
 * thirdweb decides whether to sponsor a user operation by calling an
 * app-owned endpoint ("server verifier") with the client id, chain id and the
 * user operation, and expects `{ isAllowed, reason }` back. Dashboard rules
 * (spend limit, chain and contract allowlists) are coarse and live outside the
 * repo; this engine is where the trust's own rules live, in code and under
 * review, so a sponsorship decision is auditable:
 *
 *   sender is a smart account this trust provisioned, or one of the trust's
 *     own treasury wallets (THIRDWEB_POLICY_ALLOWED_SENDERS)
 *   → chain is allowlisted
 *   → target contracts are allowlisted
 *   → per-operation gas ceiling
 *   → per-sender daily operation and gas budget
 *   → sponsorship is actually live
 *
 * Sponsored gas is the trust spending its own native balance, so it is real
 * value movement and gated like every other rail: while
 * THIRDWEB_GAS_SPONSORSHIP_LIVE=false or THIRDWEB_SHADOW=true (the defaults)
 * every decision is denied, and the decision the rules *would* have reached is
 * recorded as `wouldAllow` so the policy can be observed before it can spend.
 */

const { ThirdwebWalletEngine } = require('./thirdwebWalletEngine');

let pool = null;
try { pool = require('../bonds/pgPool'); } catch (e) { /* no DB in tests */ }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function bool(name, def = false) { const v = process.env[name]; return v ? String(v).toLowerCase() === 'true' : def; }
function num(name, def = 0) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : def; }

function list(name) {
  return str(name).split(',').map((v) => v.trim()).filter(Boolean);
}

function lower(value) { return String(value || '').toLowerCase(); }

/** Hop-by-hop / platform headers; anything else is one the caller set deliberately. */
const STANDARD_HEADERS = new Set([
  'host', 'connection', 'content-type', 'content-length', 'accept', 'accept-encoding', 'accept-language',
  'user-agent', 'referer', 'origin', 'cache-control', 'pragma', 'via', 'date', 'transfer-encoding',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'x-real-ip', 'x-request-id',
  'traceparent', 'tracestate', 'cf-connecting-ip', 'cf-ray', 'cf-ipcountry', 'cf-visitor', 'cdn-loop',
]);

/** Accepts decimal or 0x-prefixed quantities, as they appear in user ops. */
function toBigInt(value) {
  if (value === undefined || value === null || value === '') return 0n;
  try { return BigInt(value); } catch (e) { return 0n; }
}

let tablesReady = null;
async function ensureTables() {
  if (!pool) return;
  if (tablesReady) return tablesReady;
  tablesReady = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS thirdweb_sponsorship_decisions (
        id TEXT PRIMARY KEY,
        chain_id INTEGER,
        sender TEXT,
        targets TEXT,
        gas_wei NUMERIC DEFAULT 0,
        allowed BOOLEAN NOT NULL,
        would_allow BOOLEAN NOT NULL,
        shadow BOOLEAN NOT NULL,
        reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_tw_sponsorship_sender_day
        ON thirdweb_sponsorship_decisions (sender, created_at)
    `);
  })().catch((e) => { tablesReady = null; throw e; });
  return tablesReady;
}

const memoryDecisions = [];

class ThirdwebSponsorshipPolicy {
  static getConfig() {
    const tw = ThirdwebWalletEngine.getConfig();
    const chains = list('THIRDWEB_POLICY_CHAIN_IDS').map(Number).filter(Number.isFinite);
    return {
      shadow: tw.shadow,
      // Denying while sponsorship is not live is the whole point: the verifier
      // must never authorize the trust to spend gas before the flag is set.
      sponsorshipLive: tw.sponsorshipLive && !tw.shadow,
      clientId: tw.clientId,
      // A shared secret sent as an additional header from the thirdweb
      // dashboard. Unset means the endpoint cannot be trusted, so it denies.
      verifierSecret: str('THIRDWEB_VERIFIER_SECRET'),
      chainIds: chains.length ? chains : [tw.chainId],
      allowedTargets: list('THIRDWEB_POLICY_ALLOWED_TARGETS').map(lower),
      // Trust-owned senders (e.g. the Vault-held treasury server wallet) that
      // are not provisioned smart accounts but may still be sponsored.
      allowedSenders: list('THIRDWEB_POLICY_ALLOWED_SENDERS').map(lower),
      requireProvisioned: bool('THIRDWEB_POLICY_REQUIRE_PROVISIONED', true),
      maxGasWeiPerOp: toBigInt(str('THIRDWEB_POLICY_MAX_GAS_WEI_PER_OP', '2000000000000000')), // 0.002 native
      dailyOpsPerSender: num('THIRDWEB_POLICY_DAILY_OPS_PER_SENDER', 25),
      dailyGasWeiPerSender: toBigInt(str('THIRDWEB_POLICY_DAILY_GAS_WEI_PER_SENDER', '20000000000000000')), // 0.02 native
    };
  }

  static describe() {
    const cfg = this.getConfig();
    return {
      provider: 'thirdweb',
      verifierPath: '/api/dapp/thirdweb/sponsorship/verify',
      shadow: cfg.shadow,
      enforcing: cfg.sponsorshipLive,
      verifierSecretConfigured: Boolean(cfg.verifierSecret),
      chainIds: cfg.chainIds,
      allowedTargets: cfg.allowedTargets,
      allowedSenders: cfg.allowedSenders,
      requireProvisioned: cfg.requireProvisioned,
      maxGasWeiPerOp: cfg.maxGasWeiPerOp.toString(),
      dailyOpsPerSender: cfg.dailyOpsPerSender,
      dailyGasWeiPerSender: cfg.dailyGasWeiPerSender.toString(),
      note: cfg.sponsorshipLive
        ? 'Live: allowed operations are sponsored with trust funds.'
        : 'Shadow: every operation is denied; rule outcomes are recorded as wouldAllow.',
    };
  }

  /** Constant-time-ish check of the shared secret thirdweb sends back to us. */
  static authorize(headers = {}) {
    const cfg = this.getConfig();
    if (!cfg.verifierSecret) return { ok: false, reason: 'THIRDWEB_VERIFIER_SECRET not configured' };
    const raw = headers['x-thirdweb-verifier-secret']
      || headers['X-Thirdweb-Verifier-Secret']
      || String(headers.authorization || '').replace(/^Bearer\s+/i, '');
    const presented = String(raw || '').trim().replace(/^["']|["']$/g, '');
    if (!presented || presented !== cfg.verifierSecret) {
      const customHeaders = Object.keys(headers).filter((h) => !STANDARD_HEADERS.has(h.toLowerCase()));
      return {
        ok: false,
        reason: 'invalid verifier secret',
        diagnostics: {
          presented: Boolean(presented),
          presentedLength: presented.length,
          expectedLength: cfg.verifierSecret.length,
          customHeaders,
        },
      };
    }
    return { ok: true };
  }

  /** Is this sender a smart account the trust provisioned? */
  static async _isProvisionedSender(sender) {
    if (!pool || !pool.query) return null;
    try {
      const { rows } = await pool.query(
        `SELECT 1 FROM dapp_users WHERE LOWER(smart_account_address) = $1 LIMIT 1`,
        [lower(sender)]
      );
      return rows.length > 0;
    } catch (e) {
      // An unreadable directory must not silently widen the policy.
      return null;
    }
  }

  static async _dailyUsage(sender) {
    if (!pool || !pool.query) {
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const mine = memoryDecisions.filter((d) => d.sender === lower(sender) && d.at >= since && d.wouldAllow);
      return { ops: mine.length, gasWei: mine.reduce((sum, d) => sum + d.gasWei, 0n) };
    }
    try {
      await ensureTables();
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS ops, COALESCE(SUM(gas_wei), 0)::text AS gas_wei
           FROM thirdweb_sponsorship_decisions
          WHERE LOWER(sender) = $1
            AND would_allow = TRUE
            AND created_at > NOW() - INTERVAL '24 hours'`,
        [lower(sender)]
      );
      const row = rows[0] || { ops: 0, gas_wei: '0' };
      return { ops: row.ops, gasWei: toBigInt(row.gas_wei) };
    } catch (e) {
      return { ops: 0, gasWei: 0n, issue: e.message };
    }
  }

  /**
   * Apply the trust's rules to a thirdweb verifier request. Returns the
   * response body thirdweb expects (`isAllowed`/`reason`) plus the rule
   * outcome for audit.
   */
  static async evaluate({ clientId, chainId, userOp } = {}) {
    const cfg = this.getConfig();
    const op = userOp || {};
    const sender = op.sender;
    const targets = (op.targets || (op.data && op.data.targets) || []).map(lower);
    const gasWei = toBigInt(op.gasLimit) * toBigInt(op.gasPrice);

    const deny = async (reason) => this._record({ chainId, sender, targets, gasWei, cfg, wouldAllow: false, reason });

    if (!sender) return deny('userOp.sender missing');
    if (cfg.clientId && clientId && clientId !== cfg.clientId) return deny('clientId does not match this project');
    if (chainId !== undefined && chainId !== null && !cfg.chainIds.includes(Number(chainId))) {
      return deny(`chain ${chainId} is not sponsored`);
    }
    if (cfg.requireProvisioned && !cfg.allowedSenders.includes(lower(sender))) {
      const provisioned = await this._isProvisionedSender(sender);
      if (provisioned === null) return deny('cannot verify the sender is a trust-provisioned account');
      if (!provisioned) return deny('sender is not a trust-provisioned smart account');
    }
    if (cfg.allowedTargets.length) {
      const disallowed = targets.filter((t) => !cfg.allowedTargets.includes(t));
      if (!targets.length) return deny('no target contract to check against the allowlist');
      if (disallowed.length) return deny(`target not allowlisted: ${disallowed[0]}`);
    }
    if (cfg.maxGasWeiPerOp > 0n && gasWei > cfg.maxGasWeiPerOp) {
      return deny(`operation gas ${gasWei} exceeds the per-operation ceiling ${cfg.maxGasWeiPerOp}`);
    }

    const usage = await this._dailyUsage(sender);
    if (cfg.dailyOpsPerSender > 0 && usage.ops >= cfg.dailyOpsPerSender) {
      return deny(`sender reached the daily sponsored-operation limit (${cfg.dailyOpsPerSender})`);
    }
    if (cfg.dailyGasWeiPerSender > 0n && usage.gasWei + gasWei > cfg.dailyGasWeiPerSender) {
      return deny(`sender would exceed the daily sponsored-gas budget (${cfg.dailyGasWeiPerSender} wei)`);
    }

    return this._record({ chainId, sender, targets, gasWei, cfg, wouldAllow: true, reason: 'within trust sponsorship policy' });
  }

  static async _record({ chainId, sender, targets, gasWei, cfg, wouldAllow, reason }) {
    // Rules can pass and sponsorship still be refused: the live flag is the
    // last gate, so a shadow deployment never spends gas.
    const isAllowed = wouldAllow && cfg.sponsorshipLive;
    const decision = {
      isAllowed,
      reason: isAllowed
        ? reason
        : wouldAllow
          ? 'sponsorship is not live (THIRDWEB_GAS_SPONSORSHIP_LIVE/THIRDWEB_SHADOW)'
          : reason,
      wouldAllow,
      shadow: !cfg.sponsorshipLive,
      sender: sender || null,
      chainId: chainId === undefined ? null : chainId,
      gasWei: gasWei.toString(),
    };
    await this._persist({ chainId, sender, targets, gasWei, decision }).catch(() => undefined);
    return decision;
  }

  static async _persist({ chainId, sender, targets, gasWei, decision }) {
    memoryDecisions.push({ sender: lower(sender), gasWei, wouldAllow: decision.wouldAllow, at: Date.now() });
    if (memoryDecisions.length > 500) memoryDecisions.splice(0, memoryDecisions.length - 500);
    if (!pool || !pool.query) return;
    await ensureTables();
    await pool.query(
      `INSERT INTO thirdweb_sponsorship_decisions
         (id, chain_id, sender, targets, gas_wei, allowed, would_allow, shadow, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        `TWSP-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        chainId === undefined || chainId === null ? null : Number(chainId),
        sender || null,
        (targets || []).join(','),
        gasWei.toString(),
        decision.isAllowed,
        decision.wouldAllow,
        decision.shadow,
        decision.reason,
      ]
    );
  }

  static async recentDecisions(limit = 25) {
    if (!pool || !pool.query) {
      return memoryDecisions.slice(-limit).reverse().map((d) => ({
        sender: d.sender,
        gasWei: d.gasWei.toString(),
        wouldAllow: d.wouldAllow,
        createdAt: new Date(d.at).toISOString(),
      }));
    }
    await ensureTables();
    const { rows } = await pool.query(
      `SELECT sender, targets, gas_wei::text AS gas_wei, allowed, would_allow, shadow, reason, created_at
         FROM thirdweb_sponsorship_decisions
        ORDER BY created_at DESC
        LIMIT $1`,
      [Math.max(1, Math.min(200, Number(limit) || 25))]
    );
    return rows;
  }

  static _resetMemory() { memoryDecisions.length = 0; }
}

module.exports = { ThirdwebSponsorshipPolicy };
