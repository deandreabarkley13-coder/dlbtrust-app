'use strict';

/**
 * Canonical GL map builder — derives `trust account code → Fineract GL id`
 * from live data instead of a hand-written CANONICAL_GL_MAP string.
 *
 * CanonicalFundingSource refuses to post unless every line resolves to a
 * Fineract GL id, so the map is the gate on real movement. Three live sources
 * disagree in practice and the builder reconciles them explicitly:
 *
 *   trust_accounts        the sub-ledger chart (what we want to post)
 *   fineract_gl_mappings  what the app currently believes (may be stale)
 *   GET /glaccounts       what the ERP actually has (the authority)
 *
 * Live production data at the time of writing: 50 trust accounts, 18 mappings,
 * with `1210 Stablecoin Backing Asset` — the treasury funding target —
 * unmapped. A "missing" and a "wrong" mapping fail very differently, so each
 * account gets a status rather than being silently dropped from the map:
 *
 *   mapped        mapping id == live GL with the same glCode
 *   drifted       mapping points at a different id than the live glCode match
 *   stale         mapping points at a GL id the ERP no longer has
 *   discoverable  no mapping, but the ERP already has that glCode
 *   absent        neither book has it — needs a GL account created
 *   unpostable    matched GL is a HEADER or forbids manual entries
 *   type_mismatch sub-ledger says asset, the ERP GL says something else
 *   unverified    mapping exists but the ERP is unreachable — do not trust it
 *
 * Only `mapped` and the repairable states yield a GL id; `unpostable` and
 * `type_mismatch` are withheld from the map on purpose, because posting into a
 * header account or the wrong side of the chart corrupts the canonical books.
 */

const { FineractClient } = require('./fineractClient');

let pool = null;
try { pool = require('../bonds/pgPool'); } catch (e) { /* no DB in tests */ }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

// Fineract GL type ids, and the trust chart's account_type they correspond to.
const TYPE_BY_TRUST_TYPE = { asset: 1, liability: 2, equity: 3, income: 4, expense: 5 };
const TRUST_TYPE_BY_ID = { 1: 'asset', 2: 'liability', 3: 'equity', 4: 'income', 5: 'expense' };
const MAPPING_TYPE = 'trust_journal';
// The fixed 4-digit chart. Everything else (PTC-*, TRUST-CRM-*, HLD-*, VA-*) is
// generated per client/holding and is opt-in, since each one becomes a GL account.
const CORE_CODE = /^\d{4}$/;

const REPAIRABLE = new Set(['drifted', 'stale', 'discoverable']);
const WITHHELD = new Set(['unpostable', 'type_mismatch', 'absent', 'unverified']);

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function glTypeId(account) {
  const type = account && account.type;
  return Number(type && (type.id !== undefined ? type.id : type)) || null;
}
function isHeader(account) {
  const usage = account && account.usage;
  const id = Number(usage && (usage.id !== undefined ? usage.id : usage));
  return id === 1;
}

class CanonicalGlMapBuilder {
  static getConfig() {
    return {
      mappingType: MAPPING_TYPE,
      fineractUrl: str('FINERACT_URL', 'https://localhost:8443/fineract-provider/api/v1'),
      // Codes the canonical funding rail cannot operate without.
      requiredCodes: [
        str('CANONICAL_FUNDING_CASH_ACCOUNT_CODE') || str('TREASURY_TOPUP_CASH_ACCOUNT_CODE', '1000'),
        str('CANONICAL_FUNDING_ASSET_ACCOUNT_CODE') || str('TREASURY_TOPUP_CRYPTO_ACCOUNT_CODE', '1210'),
      ].filter(Boolean),
      overrideMap: str('CANONICAL_GL_MAP'),
    };
  }

  /** Seam for the connection pool so callers/tests can supply their own. */
  static _db() {
    return pool && pool.query ? pool : null;
  }

  /** Live sub-ledger chart of accounts. */
  static async trustAccounts({ codes, includeDynamic = false } = {}) {
    const db = this._db();
    if (!db) return [];
    const { rows } = await db.query(
      `SELECT account_code, account_name, account_type, sub_type, is_active
         FROM trust_accounts ORDER BY account_code`
    );
    const wanted = codes && codes.length ? new Set(codes.map(String)) : null;
    return rows.filter((row) => {
      const code = String(row.account_code);
      if (wanted) return wanted.has(code);
      return includeDynamic || CORE_CODE.test(code);
    });
  }

  /** What the app currently believes, straight from fineract_gl_mappings. */
  static async storedMappings() {
    const map = {};
    const db = this._db();
    if (!db) return map;
    const { rows } = await db.query(
      `SELECT trust_account_code, fineract_gl_id FROM fineract_gl_mappings
        WHERE mapping_type = $1 AND is_active IS NOT FALSE`,
      [MAPPING_TYPE]
    ).catch(() => ({ rows: [] }));
    for (const row of rows) map[String(row.trust_account_code)] = Number(row.fineract_gl_id);
    return map;
  }

  /** What the ERP actually has. Never throws — unreachable is a state, not a crash. */
  static async liveGlAccounts() {
    try {
      const accounts = await FineractClient.getGLAccounts();
      const list = Array.isArray(accounts) ? accounts : [];
      return {
        reachable: true,
        byCode: new Map(list.map((a) => [String(a.glCode), a])),
        byId: new Map(list.map((a) => [Number(a.id), a])),
        count: list.length,
        error: null,
      };
    } catch (err) {
      return { reachable: false, byCode: new Map(), byId: new Map(), count: 0, error: err.message };
    }
  }

  /**
   * Reconcile the three books into one plan. Read-only: nothing is written and
   * no GL account is created, so it is safe to run against production.
   */
  static async build({ codes, includeDynamic = false } = {}) {
    const cfg = this.getConfig();
    const [accounts, stored, live] = await Promise.all([
      this.trustAccounts({ codes, includeDynamic }),
      this.storedMappings(),
      this.liveGlAccounts(),
    ]);

    const entries = accounts.map((account) => this._classify(account, stored, live));

    // Codes only present in the mapping table are orphans: something posts to
    // them but the sub-ledger chart no longer explains what they are.
    const known = new Set(entries.map((e) => e.accountCode));
    const orphans = Object.keys(stored).filter((code) => !known.has(code)
      && (includeDynamic || CORE_CODE.test(code) || (codes || []).map(String).includes(code)));

    const map = {};
    for (const entry of entries) if (entry.fineractGlId) map[entry.accountCode] = entry.fineractGlId;

    const missingRequired = cfg.requiredCodes.filter((code) => !map[code]);
    const issues = [];
    if (!live.reachable) issues.push(`ERP unreachable (${live.error}) — mappings could not be verified`);
    for (const code of missingRequired) {
      const entry = entries.find((e) => e.accountCode === code);
      issues.push(`required account ${code} unusable: ${entry ? entry.status : 'not in trust chart'}`);
    }
    for (const entry of entries.filter((e) => WITHHELD.has(e.status) && e.status !== 'unverified')) {
      issues.push(`${entry.accountCode} ${entry.accountName}: ${entry.reason}`);
    }

    return {
      generatedAt: new Date().toISOString(),
      system: 'fineract',
      fineractUrl: cfg.fineractUrl,
      erp: { reachable: live.reachable, glAccounts: live.count, error: live.error },
      requiredCodes: cfg.requiredCodes,
      entries,
      orphanMappings: orphans.map((code) => ({ accountCode: code, fineractGlId: stored[code] })),
      map,
      envLine: this.envLine(map),
      coverage: {
        trustAccounts: entries.length,
        mapped: entries.filter((e) => e.status === 'mapped').length,
        repairable: entries.filter((e) => REPAIRABLE.has(e.status)).length,
        needsGlAccount: entries.filter((e) => e.status === 'absent').length,
        withheld: entries.filter((e) => WITHHELD.has(e.status)).length,
      },
      ok: missingRequired.length === 0,
      issues,
    };
  }

  static _classify(account, stored, live) {
    const code = String(account.account_code);
    const base = {
      accountCode: code,
      accountName: account.account_name,
      accountType: account.account_type,
      subType: account.sub_type || null,
      subLedgerActive: account.is_active !== false,
      storedGlId: stored[code] !== undefined ? stored[code] : null,
      liveGlId: null,
      fineractGlId: null,
      status: null,
      reason: null,
      action: 'none',
    };

    const liveByCode = live.byCode.get(code) || null;
    if (liveByCode) base.liveGlId = Number(liveByCode.id);

    if (!live.reachable) {
      // Cannot tell mapped from stale, so the mapping is reported but not trusted.
      return base.storedGlId
        ? { ...base, status: 'unverified', reason: `ERP unreachable: ${live.error}`, action: 'verify' }
        : { ...base, status: 'absent', reason: `no mapping and ERP unreachable: ${live.error}`, action: 'create-gl' };
    }

    if (!liveByCode) {
      const storedAccount = base.storedGlId !== null ? live.byId.get(base.storedGlId) : null;
      if (storedAccount) {
        // The mapped GL exists but carries a different glCode — a deliberate
        // pairing the codes cannot express, so keep it and say so.
        return {
          ...base,
          fineractGlId: base.storedGlId,
          status: 'mapped',
          reason: `mapped to GL ${base.storedGlId} (${storedAccount.glCode} ${storedAccount.name}) — glCode differs from trust code`,
          action: 'none',
        };
      }
      return base.storedGlId !== null
        ? { ...base, status: 'stale', reason: `mapping points at GL id ${base.storedGlId}, which the ERP does not have`, action: 'create-gl' }
        : { ...base, status: 'absent', reason: 'no GL account with this glCode in the ERP', action: 'create-gl' };
    }

    const expectedType = TYPE_BY_TRUST_TYPE[String(account.account_type || '').toLowerCase()];
    const actualType = glTypeId(liveByCode);
    if (expectedType && actualType && expectedType !== actualType) {
      return {
        ...base,
        status: 'type_mismatch',
        reason: `trust chart says ${account.account_type}, ERP GL ${liveByCode.id} is ${TRUST_TYPE_BY_ID[actualType] || actualType}`,
        action: 'resolve-manually',
      };
    }
    if (isHeader(liveByCode) || liveByCode.manualEntriesAllowed === false || liveByCode.disabled === true) {
      return {
        ...base,
        status: 'unpostable',
        reason: isHeader(liveByCode)
          ? `ERP GL ${liveByCode.id} is a HEADER account and cannot be posted to`
          : `ERP GL ${liveByCode.id} is disabled or forbids manual entries`,
        action: 'resolve-manually',
      };
    }

    if (base.storedGlId === null) {
      return { ...base, fineractGlId: base.liveGlId, status: 'discoverable', reason: 'ERP already has this glCode; mapping row missing', action: 'write-mapping' };
    }
    if (base.storedGlId !== base.liveGlId) {
      return {
        ...base,
        fineractGlId: base.liveGlId,
        status: 'drifted',
        reason: `mapping says GL ${base.storedGlId}, ERP glCode ${code} is GL ${base.liveGlId}`,
        action: 'write-mapping',
      };
    }
    return { ...base, fineractGlId: base.liveGlId, status: 'mapped', reason: null, action: 'none' };
  }

  static envLine(map) {
    const pairs = Object.keys(map).sort().map((code) => `${code}:${map[code]}`);
    return pairs.length ? `CANONICAL_GL_MAP=${pairs.join(',')}` : '';
  }

  /**
   * Persist the plan. Writes only rows the ERP confirmed (`write-mapping`), and
   * creates GL accounts for `absent`/`stale` codes when asked. Refuses to run
   * against an unreachable ERP, because writing unverified ids is how a wrong
   * mapping becomes the thing everything trusts.
   */
  static async apply({ codes, includeDynamic = false, createMissing = false, plan } = {}) {
    const built = plan || await this.build({ codes, includeDynamic });
    if (!built.erp.reachable) {
      throw Object.assign(new Error(`refusing to write mappings while the ERP is unreachable: ${built.erp.error}`),
        { code: 'ERP_UNREACHABLE', status: 503 });
    }
    if (!this._db()) {
      throw Object.assign(new Error('no database connection — cannot write fineract_gl_mappings'), { code: 'NO_DB', status: 503 });
    }

    const created = [];
    const written = [];
    const skipped = [];

    for (const entry of built.entries) {
      let glId = entry.fineractGlId;

      if (!glId && createMissing && entry.action === 'create-gl') {
        const type = TYPE_BY_TRUST_TYPE[String(entry.accountType || '').toLowerCase()];
        if (!type) { skipped.push({ ...entry, skipReason: `unknown trust account_type "${entry.accountType}"` }); continue; }
        const result = await FineractClient.createGLAccount({
          name: entry.accountName,
          glCode: entry.accountCode,
          type,
          usage: 2, // DETAIL — postable
          description: `Trust account: ${entry.accountName} (${entry.subType || entry.accountType})`,
        });
        glId = Number(result.resourceId || result.id);
        created.push({ accountCode: entry.accountCode, accountName: entry.accountName, fineractGlId: glId });
      }

      if (!glId) { skipped.push({ ...entry, skipReason: entry.reason || entry.status }); continue; }
      if (entry.status === 'mapped' && entry.storedGlId === glId) continue;

      await this._upsertMapping(entry, glId);
      written.push({ accountCode: entry.accountCode, fineractGlId: glId, previousGlId: entry.storedGlId, status: entry.status });
    }

    const verified = await this.build({ codes, includeDynamic });
    return {
      generatedAt: new Date().toISOString(),
      created,
      written,
      skipped,
      map: verified.map,
      envLine: verified.envLine,
      coverage: verified.coverage,
      ok: verified.ok,
      issues: verified.issues,
    };
  }

  static async _upsertMapping(entry, glId) {
    const db = this._db();
    const description = `${entry.accountName} (${entry.accountType})`;
    await db.query(
      `INSERT INTO fineract_gl_mappings (mapping_type, trust_account_code, fineract_gl_id, description)
       SELECT $1, $2, $3, $4
        WHERE NOT EXISTS (SELECT 1 FROM fineract_gl_mappings WHERE mapping_type = $1 AND trust_account_code = $2)`,
      [MAPPING_TYPE, entry.accountCode, glId, description]
    );
    await db.query(
      `UPDATE fineract_gl_mappings SET fineract_gl_id = $1, description = $2, is_active = TRUE, updated_at = NOW()
        WHERE mapping_type = $3 AND trust_account_code = $4`,
      [glId, description, MAPPING_TYPE, entry.accountCode]
    );
  }
}

module.exports = { CanonicalGlMapBuilder, MAPPING_TYPE, TYPE_BY_TRUST_TYPE };
