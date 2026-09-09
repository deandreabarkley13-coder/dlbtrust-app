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
 * which ERP source backs it (the module token deployed on Base), which
 * wallets may be paid, and which policy purposes are valid. Amounts staged
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
  },
  trust_operating: {
    key: 'trust_operating',
    label: 'Trust Operating allocation -> trustees',
    sourceModule: 'treasury',
    tokenEnv: 'DLB_TREASURY_TOKEN_ADDRESS',
    payeeRole: 'trustee',
    purposes: ['operating', 'trustee_fee'],
    erpSource: 'treasury_module',
  },
};

const TABLE = 'trust_allocation_payouts';
let tableReady = false;

function str(name, def = '') { return (process.env[name] || def).trim(); }
function lower(a) { return String(a || '').toLowerCase(); }

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

  /** ERP funding source for a bucket: the module token deployed on Base, else the module ledger. */
  static fundingSource(bucketKey) {
    const b = this.bucket(bucketKey);
    const token = str(b.tokenEnv);
    return token ? { sourceToken: token, sourceModule: b.sourceModule } : { sourceModule: b.sourceModule };
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
