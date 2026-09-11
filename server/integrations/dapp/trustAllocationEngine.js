'use strict';

/**
 * Cash-flow allocation buckets for governed distributions.
 *
 *   coupon_income    DLB-PRB coupon income (ERP coupon_payments, status paid)
 *                    -> Hold Account beneficiaries, purposes distribution/medical/education/housing
 *   trust_operating  Trust Operating allocation (treasury module / DLB-TREASURY)
 *                    -> trustees, purposes operating/trustee_fee
 *
 * A bucket decides three things for a Spritz payout or an ERP funding leg:
 * which ERP source backs it, which wallets may be paid, and which policy
 * purposes are valid. The liquidity lives in the Treasury-Core banking ERP
 * (Fineract GL): when a bucket's GL cash account is configured
 * (COUPON_INCOME_GL_ACCOUNT_CODE / TRUST_OPERATING_GL_ACCOUNT_CODE) the bucket
 * funds as the `canonical` source of that account, so a draw is a GL move
 * (Dr USDC treasury / Cr bucket cash) plus a USDC deposit from the treasury
 * wallet — no DEX pool. Without a GL code the bucket falls back to its module
 * token on Base and needs a canonical liquidity pool to swap through. Amounts staged
 * against a bucket are tracked so its ERP headroom (income recognised minus
 * payouts already staged/executed) is never exceeded. Headroom is an ERP
 * accounting figure: the policy contract still needs real USDC (see
 * SpritzTreasuryLegEngine.fund) before any distribution can execute.
 *
 * Payees default to the policy allow-list in contracts/policy.base.json,
 * split by `$role`; TRUST_ALLOCATION_BENEFICIARY_WALLETS /
 * TRUST_ALLOCATION_TRUSTEE_WALLETS (comma-separated) override them.
 */

const fs = require('fs');
const path = require('path');

const { ModuleSmartAccountEngine, MODULES } = require('./moduleSmartAccountEngine');

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const POLICY_CONFIG = path.join(__dirname, '..', '..', '..', 'contracts', 'policy.base.json');

const BUCKETS = {
  coupon_income: {
    key: 'coupon_income',
    label: 'Coupon income -> beneficiaries',
    sourceModule: 'bond_portfolio',
    tokenEnv: 'DLB_PRB_TOKEN_ADDRESS',
    payeeRole: 'beneficiary',
    purposes: ['distribution', 'medical', 'education', 'housing'],
    erpSource: 'coupon_payments',
    glEnv: 'COUPON_INCOME_GL_ACCOUNT_CODE',
  },
  trust_operating: {
    key: 'trust_operating',
    label: 'Trust Operating allocation -> trustees',
    sourceModule: 'treasury',
    tokenEnv: 'DLB_TREASURY_TOKEN_ADDRESS',
    payeeRole: 'trustee',
    purposes: ['operating', 'trustee_fee'],
    erpSource: 'treasury_module',
    glEnv: 'TRUST_OPERATING_GL_ACCOUNT_CODE',
  },
};

const CANONICAL_SOURCE_TYPES = new Set(['canonical', 'erp', 'core_banking_canonical']);

const TABLE = 'trust_allocation_payouts';
let tableReady = false;

function str(name, def = '') { return (process.env[name] || def).trim(); }
function lower(a) { return String(a || '').toLowerCase(); }
function isCanonical(sourceType) { return CANONICAL_SOURCE_TYPES.has(lower(sourceType)); }

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function listEnv(name) {
  return str(name).split(',').map((s) => s.trim()).filter(Boolean);
}

function policyPayees() {
  try {
    const cfg = JSON.parse(fs.readFileSync(POLICY_CONFIG, 'utf8'));
    return (cfg.beneficiaries || []).map((b) => ({ address: b.beneficiary, role: b.$role || 'beneficiary', name: b.$name || null }));
  } catch (e) {
    return [];
  }
}

async function ensureTable() {
  if (tableReady || !pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      reference        TEXT PRIMARY KEY,
      bucket           TEXT NOT NULL,
      payout_wallet    TEXT NOT NULL,
      purpose          TEXT NOT NULL,
      amount_usd       NUMERIC(18,2) NOT NULL,
      distribution_id  TEXT,
      spritz_quote_id  TEXT,
      status           TEXT NOT NULL DEFAULT 'staged',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  tableReady = true;
}

class TrustAllocationEngine {
  static buckets() { return Object.values(BUCKETS); }

  static bucket(key) {
    const b = BUCKETS[String(key || '').trim()];
    if (!b) throw httpError(400, `unknown allocation bucket ${key}; expected one of ${Object.keys(BUCKETS).join(', ')}`, 'ALLOCATION_BUCKET_UNKNOWN');
    return b;
  }

  /** The bucket a policy purpose belongs to (investment belongs to none). */
  static bucketForPurpose(purpose) {
    return this.buckets().find((b) => b.purposes.includes(String(purpose || '').trim())) || null;
  }

  static tokenEnvFor(moduleKey) {
    const b = this.buckets().find((x) => x.sourceModule === moduleKey);
    return b ? b.tokenEnv : `${MODULES[moduleKey].tokenSymbol.replace(/-/g, '_')}_TOKEN_ADDRESS`;
  }

  /** Wallets a bucket may pay; policy allow-list by $role unless overridden by env. */
  static payees(bucketKey) {
    const b = this.bucket(bucketKey);
    const override = listEnv(b.payeeRole === 'trustee' ? 'TRUST_ALLOCATION_TRUSTEE_WALLETS' : 'TRUST_ALLOCATION_BENEFICIARY_WALLETS');
    if (override.length) return override.map((address) => ({ address, role: b.payeeRole, name: null }));
    return policyPayees().filter((p) => p.role === b.payeeRole);
  }

  /** Treasury-Core ERP GL cash account a bucket draws from, or null. */
  static glAccountCode(bucketKey) {
    return str(this.bucket(bucketKey).glEnv) || null;
  }

  /**
   * ERP funding source for a bucket: the bucket's canonical GL account when
   * configured, else the module token deployed on Base, else the module ledger.
   */
  static fundingSource(bucketKey) {
    const b = this.bucket(bucketKey);
    const gl = this.glAccountCode(b.key);
    if (gl) return { sourceType: 'canonical', sourceAccountId: gl, sourceModule: b.sourceModule };
    const token = str(b.tokenEnv);
    return token ? { sourceToken: token, sourceModule: b.sourceModule } : { sourceModule: b.sourceModule };
  }

  /** The bucket an ERP funding source belongs to, or null when it belongs to none. */
  static bucketForSource({ sourceType, sourceAccountId, sourceToken, sourceModule } = {}) {
    const token = lower(sourceToken);
    const mod = String(sourceModule || '').trim();
    const gl = isCanonical(sourceType) ? String(sourceAccountId || '').trim() : '';
    return this.buckets().find((b) => (token && lower(str(b.tokenEnv)) === token)
      || (mod && b.sourceModule === mod)
      || (gl && str(b.glEnv) && str(b.glEnv) === gl)) || null;
  }

  /**
   * Segregation guard for a funding leg: every source must belong to exactly
   * one bucket, and a bucket may only be funded from its own source. Coupon
   * income (DLB-PRB / bond_portfolio) never funds Trust Operating and the
   * treasury module never funds beneficiary support. Returns the resolved
   * bucket and source. The canonical ERP GL account of a bucket is its own
   * source; any other ledger source (sourceType+sourceAccountId) belongs to no
   * bucket and is refused whenever a bucket is in play.
   */
  static assertFundingSource({ bucket, sourceType, sourceAccountId, sourceToken, sourceModule } = {}) {
    const explicit = bucket ? this.bucket(bucket) : null;
    const owner = this.bucketForSource({ sourceType, sourceAccountId, sourceToken, sourceModule });
    const tokenOwner = sourceToken ? this.bucketForSource({ sourceToken }) : null;
    const moduleOwner = sourceModule ? this.bucketForSource({ sourceModule }) : null;
    const glOwner = isCanonical(sourceType) ? this.bucketForSource({ sourceType, sourceAccountId }) : null;
    if (tokenOwner && moduleOwner && tokenOwner.key !== moduleOwner.key) {
      throw httpError(409, `sourceToken belongs to ${tokenOwner.key} but sourceModule ${sourceModule} belongs to ${moduleOwner.key}`, 'ALLOCATION_SOURCE_MISMATCH');
    }
    if (glOwner && moduleOwner && glOwner.key !== moduleOwner.key) {
      throw httpError(409, `canonical GL account ${sourceAccountId} belongs to ${glOwner.key} but sourceModule ${sourceModule} belongs to ${moduleOwner.key}`, 'ALLOCATION_SOURCE_MISMATCH');
    }
    const b = explicit || owner;
    if (!b) {
      if (sourceType || sourceToken || sourceModule) return { bucket: null, source: { sourceType, sourceAccountId, sourceToken, sourceModule } };
      throw httpError(400, `bucket required: ${Object.keys(BUCKETS).join(' or ')}`, 'ALLOCATION_BUCKET_REQUIRED');
    }
    if (isCanonical(sourceType)) {
      if (glOwner && glOwner.key !== b.key) {
        throw httpError(409, `${b.key} cannot be funded from ${glOwner.key} GL account ${sourceAccountId}; ${BUCKETS.coupon_income.label} and ${BUCKETS.trust_operating.label} must not mix`, 'ALLOCATION_SOURCE_MISMATCH');
      }
      if (!glOwner) {
        throw httpError(409, `canonical GL account ${sourceAccountId || '(none)'} is not the allocated ERP account of ${b.key} (${b.glEnv}${str(b.glEnv) ? '=' + str(b.glEnv) : ' not configured'})`, 'ALLOCATION_SOURCE_MISMATCH');
      }
    } else if (sourceType || sourceAccountId) {
      throw httpError(409, `${b.key} is funded only from its allocated source (${str(b.glEnv) ? 'canonical GL ' + str(b.glEnv) : b.sourceModule}); ledger source ${sourceType || ''}${sourceAccountId ? ':' + sourceAccountId : ''} is not segregated`, 'ALLOCATION_SOURCE_MISMATCH');
    }
    if (owner && owner.key !== b.key) {
      throw httpError(409, `${b.key} cannot be funded from ${owner.key} source (${sourceToken || sourceModule}); ${BUCKETS.coupon_income.label} and ${BUCKETS.trust_operating.label} must not mix`, 'ALLOCATION_SOURCE_MISMATCH');
    }
    if ((sourceToken || sourceModule) && !owner) {
      throw httpError(409, `${sourceToken || sourceModule} is not the allocated source of ${b.key} (${b.sourceModule}${str(b.tokenEnv) ? ' / ' + str(b.tokenEnv) : ''})`, 'ALLOCATION_SOURCE_MISMATCH');
    }
    return { bucket: b, source: this.fundingSource(b.key) };
  }

  /**
   * The two segregated ERP funding sources and whether each can convert to
   * USDC for the policy contract right now (`quote` prices 1 USD through
   * CanonicalMoneyEngine without creating anything).
   */
  static async fundingSources({ quote } = {}) {
    return Promise.all(this.buckets().map(async (b) => {
      const source = this.fundingSource(b.key);
      const entry = {
        bucket: b.key,
        label: b.label,
        erpSource: b.erpSource,
        sourceModule: b.sourceModule,
        sourceType: source.sourceType || null,
        glAccountCode: source.sourceType ? source.sourceAccountId : null,
        glEnv: b.glEnv,
        sourceToken: source.sourceToken || null,
        tokenEnv: b.tokenEnv,
        payeeRole: b.payeeRole,
        purposes: b.purposes,
        liquidity: source.sourceType ? 'treasury_core_erp' : (source.sourceToken ? 'dex_pool' : 'module_ledger'),
        configured: Boolean(source.sourceType || source.sourceToken),
        executable: null,
        route: null,
        issue: source.sourceType || source.sourceToken ? null : `${b.glEnv} and ${b.tokenEnv} not configured; ${b.key} falls back to the ${b.sourceModule} ledger`,
      };
      if (typeof quote === 'function') {
        try {
          const route = await quote({ ...source, amount: '1', targetAsset: 'USDC' });
          entry.route = route;
          entry.executable = TrustAllocationEngine.routeExecutable(route);
          if (!entry.executable) entry.issue = route.note || `no canonical liquidity route for ${b.key}`;
        } catch (e) {
          entry.executable = false;
          entry.issue = e.message;
        }
      }
      return entry;
    }));
  }

  /** Whether a CanonicalMoneyEngine route can run now (ERP routes need no pool). */
  static routeExecutable(route) {
    if (!route) return false;
    return route.action === 'erp_treasury' || route.action === 'mint_and_swap' || Boolean(route.poolAddress);
  }

  /** Income recognised in the ERP for a bucket, in USD. */
  static async recognised(bucketKey) {
    const b = this.bucket(bucketKey);
    if (b.erpSource === 'coupon_payments') {
      if (!pool) return 0;
      const bondId = Number(MODULES.bond_portfolio.sourceAccountId);
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM coupon_payments WHERE bond_id = $1 AND status = 'paid'`, [bondId]
      );
      return Number((rows[0] && rows[0].total) || 0);
    }
    return Number(await ModuleSmartAccountEngine.getModuleBalance(b.sourceModule));
  }

  static async staged(bucketKey) {
    await ensureTable();
    if (!pool) return 0;
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(amount_usd), 0) AS total FROM ${TABLE} WHERE bucket = $1 AND status <> 'cancelled'`, [bucketKey]
    );
    return Number((rows[0] && rows[0].total) || 0);
  }

  static async summary(bucketKey) {
    const b = this.bucket(bucketKey);
    const [recognised, staged] = await Promise.all([this.recognised(b.key), this.staged(b.key)]);
    return {
      bucket: b.key,
      label: b.label,
      sourceModule: b.sourceModule,
      sourceToken: str(b.tokenEnv) || null,
      glAccountCode: this.glAccountCode(b.key),
      purposes: b.purposes,
      payees: this.payees(b.key),
      recognisedUsd: +recognised.toFixed(2),
      stagedUsd: +staged.toFixed(2),
      headroomUsd: +(recognised - staged).toFixed(2),
      note: 'headroom is an ERP figure; the policy contract must hold USDC before a distribution executes',
    };
  }

  static async summaries() {
    return Promise.all(this.buckets().map((b) => this.summary(b.key)));
  }

  /**
   * Validate a payout against its bucket: wallet must be a bucket payee,
   * purpose must belong to the bucket, and amount must fit the ERP headroom.
   * Returns the bucket. A previously staged `reference` is accepted as-is.
   */
  static async assertPayout({ bucket, payoutWallet, purpose, amountUsd, reference } = {}) {
    const b = bucket ? this.bucket(bucket) : this.bucketForPurpose(purpose);
    if (!b) throw httpError(400, `purpose ${purpose} is not allocated to any bucket (coupon_income: ${BUCKETS.coupon_income.purposes.join('/')}; trust_operating: ${BUCKETS.trust_operating.purposes.join('/')})`, 'ALLOCATION_PURPOSE_UNALLOCATED');
    if (!b.purposes.includes(String(purpose || '').trim())) {
      throw httpError(409, `purpose ${purpose} is not payable from ${b.key} (allowed: ${b.purposes.join(', ')})`, 'ALLOCATION_PURPOSE_MISMATCH');
    }
    const payees = this.payees(b.key);
    if (!payees.some((p) => lower(p.address) === lower(payoutWallet))) {
      throw httpError(409, `${payoutWallet} is not a ${b.payeeRole} payee of ${b.key}`, 'ALLOCATION_PAYEE_NOT_ALLOWED');
    }
    const amount = Number(amountUsd);
    if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, 'amountUsd must be a positive number');

    await ensureTable();
    if (pool && reference) {
      const { rows } = await pool.query(`SELECT bucket FROM ${TABLE} WHERE reference = $1`, [reference]);
      if (rows.length) {
        if (rows[0].bucket !== b.key) throw httpError(409, `reference ${reference} already staged in ${rows[0].bucket}`, 'ALLOCATION_REFERENCE_CONFLICT');
        return b;
      }
    }
    const [recognised, staged] = await Promise.all([this.recognised(b.key), this.staged(b.key)]);
    if (amount > recognised - staged + 1e-9) {
      throw httpError(409, `${b.key} headroom is ${(recognised - staged).toFixed(2)} USD (recognised ${recognised.toFixed(2)}, staged ${staged.toFixed(2)}); cannot stage ${amount.toFixed(2)}`, 'ALLOCATION_HEADROOM_EXCEEDED');
    }
    return b;
  }

  static async recordPayout({ bucket, reference, payoutWallet, purpose, amountUsd, distributionId, spritzQuoteId } = {}) {
    await ensureTable();
    if (!pool) return null;
    await pool.query(
      `INSERT INTO ${TABLE} (reference, bucket, payout_wallet, purpose, amount_usd, distribution_id, spritz_quote_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'staged')
       ON CONFLICT (reference) DO UPDATE SET distribution_id = COALESCE(EXCLUDED.distribution_id, ${TABLE}.distribution_id),
         spritz_quote_id = COALESCE(EXCLUDED.spritz_quote_id, ${TABLE}.spritz_quote_id), updated_at = NOW()`,
      [reference, bucket, payoutWallet, purpose, Number(amountUsd).toFixed(2), distributionId ? String(distributionId) : null, spritzQuoteId || null]
    );
    return { reference, bucket, status: 'staged' };
  }

  static async markExecuted(reference) {
    await ensureTable();
    if (!pool || !reference) return null;
    const { rows } = await pool.query(
      `UPDATE ${TABLE} SET status = 'executed', updated_at = NOW() WHERE reference = $1 RETURNING bucket`, [reference]
    );
    return rows[0] || null;
  }
}

module.exports = { TrustAllocationEngine, BUCKETS };
