'use strict';

/**
 * Family Wallets — the banking-as-a-service face of the in-house bank
 *
 * The virtual account manager already knows how to hold a claim on the trust's
 * settlement account. What it does not know is who is allowed to spend it, on
 * what, and how much of it per day. That is what a wallet is here: a named
 * holder, one virtual account, and a set of spend controls that are checked
 * *before* an instruction is allowed into the payment pipeline.
 *
 * The split matters:
 *
 *   • The wallet never moves money. Every debit, credit, hold and posting
 *     still happens inside `InHouseBankEngine` / `VirtualAccountManager`, so
 *     there is exactly one place where a balance can change and one ledger to
 *     reconcile. A wallet that could post its own entries would be a second
 *     source of truth.
 *   • Wallet controls are a *narrowing*, never a widening. A wallet can only
 *     make the bank's own governance stricter — it cannot raise a limit,
 *     unlock a rail, or skip an approval, because those decisions belong to
 *     the trust's policy engine and are evaluated afterwards regardless.
 *
 * Spend is measured against payments that are still alive (received through
 * settled). A rejected, cancelled, failed or returned payment never spent the
 * money, so counting it would lock a holder out of their own funds after a
 * bank error.
 */

const crypto = require('crypto');
const pool = require('../../bonds/pgPool');
const { getConfig } = require('../inHouseBankConfig');
const { VirtualAccountManager } = require('../virtualAccountManager');
const { InHouseBankEngine } = require('../inHouseBankEngine');
const { DualLedgerEngine } = require('../dualLedgerEngine');

const WALLET_TYPES = Object.freeze(['family_member', 'entity', 'series', 'expense', 'escrow', 'reserve']);
const WALLET_STATUSES = Object.freeze(['active', 'frozen', 'closed']);

/** Payment statuses in which the money is committed and must count against a limit. */
const LIVE_PAYMENT_STATUSES = Object.freeze(['received', 'pending_approval', 'approved', 'dispatched', 'settled']);

class WalletError extends Error {
  constructor(message, code = 'WALLET_REFUSED', status = 409) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function id(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function cents(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new WalletError(`${field} must be a non-negative integer number of cents`, 'WALLET_BAD_AMOUNT', 400);
  }
  return number;
}

/**
 * A handle is what one family member types to pay another, so it has to be
 * unambiguous: lower case, no spaces, and never confusable with an account
 * number.
 */
function normalizeHandle(raw, fallbackName) {
  const source = String(raw || fallbackName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!source) throw new WalletError('A wallet handle could not be derived; supply one', 'WALLET_BAD_HANDLE', 400);
  if (/^\d+$/.test(source)) throw new WalletError('A wallet handle cannot be only digits', 'WALLET_BAD_HANDLE', 400);
  return source.slice(0, 48);
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function publicWallet(row, account = null) {
  if (!row) return null;
  return {
    walletId: row.wallet_id,
    handle: row.handle,
    holderName: row.holder_name,
    holderRef: row.holder_ref,
    holderEmail: row.holder_email,
    walletType: row.wallet_type,
    status: row.status,
    vaId: row.va_id,
    accountNumber: row.account_number,
    controls: {
      perPaymentLimitCents: row.per_payment_limit_cents === null ? null : Number(row.per_payment_limit_cents),
      dailyLimitCents: row.daily_limit_cents === null ? null : Number(row.daily_limit_cents),
      monthlyLimitCents: row.monthly_limit_cents === null ? null : Number(row.monthly_limit_cents),
      allowedRails: parseJson(row.allowed_rails, null),
      payeeAllowlist: parseJson(row.payee_allowlist, null),
      internalOnly: Boolean(row.internal_only),
    },
    openedBy: row.opened_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    account: account || null,
  };
}

class WalletEngine {
  static walletTypes() {
    return WALLET_TYPES.slice();
  }

  static async ensureTables() {
    await VirtualAccountManager.ensureTables();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ihb_wallets (
        wallet_id               TEXT PRIMARY KEY,
        handle                  TEXT UNIQUE NOT NULL,
        holder_name             TEXT NOT NULL,
        holder_ref              TEXT,
        holder_email            TEXT,
        wallet_type             TEXT NOT NULL DEFAULT 'family_member',
        status                  TEXT NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active','frozen','closed')),
        va_id                   TEXT UNIQUE NOT NULL,
        account_number          TEXT UNIQUE NOT NULL,
        per_payment_limit_cents BIGINT,
        daily_limit_cents       BIGINT,
        monthly_limit_cents     BIGINT,
        allowed_rails           JSONB,
        payee_allowlist         JSONB,
        internal_only           BOOLEAN NOT NULL DEFAULT FALSE,
        opened_by               TEXT,
        closed_at               TIMESTAMPTZ,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ihb_wallets_holder ON ihb_wallets (holder_ref, status)`);
    return true;
  }

  // ── Provisioning ───────────────────────────────────────────────────────────

  /**
   * Open a wallet and the virtual account behind it. The two are created
   * together because a wallet without an account cannot hold value and an
   * account nobody is named on cannot be governed.
   */
  static async open({
    holderName,
    handle = null,
    holderRef = null,
    holderEmail = null,
    walletType = 'family_member',
    purpose = null,
    seriesRef = null,
    parentRef = null,
    overdraftLimitCents = 0,
    perPaymentLimitCents = null,
    dailyLimitCents = null,
    monthlyLimitCents = null,
    allowedRails = null,
    payeeAllowlist = null,
    internalOnly = false,
    openedBy = 'operator',
  } = {}) {
    await this.ensureTables();
    if (!holderName || !String(holderName).trim()) {
      throw new WalletError('holderName is required', 'WALLET_NO_HOLDER', 400);
    }
    if (!WALLET_TYPES.includes(walletType)) {
      throw new WalletError(`walletType must be one of ${WALLET_TYPES.join(', ')}`, 'WALLET_BAD_TYPE', 400);
    }
    const normalizedHandle = normalizeHandle(handle, holderName);
    const existing = await this.get(normalizedHandle);
    if (existing) throw new WalletError(`Wallet handle ${normalizedHandle} is already taken`, 'WALLET_HANDLE_TAKEN', 409);

    const account = await VirtualAccountManager.open({
      name: String(holderName).trim(),
      ownerRef: holderRef || normalizedHandle,
      accountType: walletType,
      purpose,
      seriesRef,
      parentRef,
      overdraftLimitCents,
      allowedRails,
      openedBy,
    });

    const walletId = id('WAL');
    const rows = await pool.query(
      `INSERT INTO ihb_wallets
         (wallet_id, handle, holder_name, holder_ref, holder_email, wallet_type, va_id, account_number,
          per_payment_limit_cents, daily_limit_cents, monthly_limit_cents, allowed_rails, payee_allowlist,
          internal_only, opened_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        walletId, normalizedHandle, String(holderName).trim(), holderRef, holderEmail, walletType,
        account.vaId, account.accountNumber,
        cents(perPaymentLimitCents, 'perPaymentLimitCents'),
        cents(dailyLimitCents, 'dailyLimitCents'),
        cents(monthlyLimitCents, 'monthlyLimitCents'),
        allowedRails ? JSON.stringify(allowedRails) : null,
        payeeAllowlist ? JSON.stringify(payeeAllowlist) : null,
        Boolean(internalOnly), openedBy,
      ]
    );

    await DualLedgerEngine.appendEvent({
      eventType: 'wallet.opened',
      actor: openedBy,
      payload: { walletId, handle: normalizedHandle, accountNumber: account.accountNumber, walletType },
    }).catch(() => null);

    return publicWallet(rows.rows[0], account);
  }

  static async get(ref, { withAccount = false } = {}) {
    if (!ref) return null;
    await this.ensureTables();
    const rows = await pool.query(
      `SELECT * FROM ihb_wallets
        WHERE wallet_id = $1 OR handle = LOWER($1) OR va_id = $1 OR account_number = $1
        LIMIT 1`,
      [String(ref)]
    );
    const row = rows.rows[0];
    if (!row) return null;
    const account = withAccount ? await VirtualAccountManager.get(row.va_id) : null;
    return publicWallet(row, account);
  }

  static async require(ref, options = {}) {
    const wallet = await this.get(ref, options);
    if (!wallet) throw new WalletError(`Wallet ${ref} not found`, 'WALLET_NOT_FOUND', 404);
    return wallet;
  }

  static async list({ status = null, holderRef = null, walletType = null, limit = 200 } = {}) {
    await this.ensureTables();
    const rows = await pool.query(
      `SELECT * FROM ihb_wallets
        WHERE ($1::text IS NULL OR status = $1)
          AND ($2::text IS NULL OR holder_ref = $2)
          AND ($3::text IS NULL OR wallet_type = $3)
        ORDER BY created_at DESC
        LIMIT $4`,
      [status, holderRef, walletType, Math.min(Math.max(Number(limit) || 200, 1), 1000)]
    );
    return rows.rows.map(row => publicWallet(row));
  }

  /**
   * Freezing a wallet freezes the account under it, so a frozen wallet cannot
   * be bypassed by paying its account number directly through the operator
   * API. Closing follows the account's own rule: a balance has to be swept
   * out first.
   */
  static async setStatus(ref, status, { actor = 'operator', reason = null } = {}) {
    if (!WALLET_STATUSES.includes(status)) {
      throw new WalletError(`status must be one of ${WALLET_STATUSES.join(', ')}`, 'WALLET_BAD_STATUS', 400);
    }
    const wallet = await this.require(ref);
    const account = await VirtualAccountManager.setStatus(wallet.vaId, status, actor);
    const rows = await pool.query(
      `UPDATE ihb_wallets
          SET status = $2, closed_at = CASE WHEN $2 = 'closed' THEN NOW() ELSE NULL END, updated_at = NOW()
        WHERE wallet_id = $1
        RETURNING *`,
      [wallet.walletId, status]
    );
    await DualLedgerEngine.appendEvent({
      eventType: `wallet.${status}`,
      actor,
      payload: { walletId: wallet.walletId, handle: wallet.handle, reason },
    }).catch(() => null);
    return publicWallet(rows.rows[0], account);
  }

  static async setControls(ref, controls = {}, { actor = 'operator' } = {}) {
    const wallet = await this.require(ref);
    const next = {
      per_payment_limit_cents: controls.perPaymentLimitCents === undefined
        ? wallet.controls.perPaymentLimitCents
        : cents(controls.perPaymentLimitCents, 'perPaymentLimitCents'),
      daily_limit_cents: controls.dailyLimitCents === undefined
        ? wallet.controls.dailyLimitCents
        : cents(controls.dailyLimitCents, 'dailyLimitCents'),
      monthly_limit_cents: controls.monthlyLimitCents === undefined
        ? wallet.controls.monthlyLimitCents
        : cents(controls.monthlyLimitCents, 'monthlyLimitCents'),
      allowed_rails: controls.allowedRails === undefined
        ? (wallet.controls.allowedRails ? JSON.stringify(wallet.controls.allowedRails) : null)
        : (controls.allowedRails ? JSON.stringify(controls.allowedRails) : null),
      payee_allowlist: controls.payeeAllowlist === undefined
        ? (wallet.controls.payeeAllowlist ? JSON.stringify(wallet.controls.payeeAllowlist) : null)
        : (controls.payeeAllowlist ? JSON.stringify(controls.payeeAllowlist) : null),
      internal_only: controls.internalOnly === undefined ? wallet.controls.internalOnly : Boolean(controls.internalOnly),
    };
    const rows = await pool.query(
      `UPDATE ihb_wallets
          SET per_payment_limit_cents = $2, daily_limit_cents = $3, monthly_limit_cents = $4,
              allowed_rails = $5, payee_allowlist = $6, internal_only = $7, updated_at = NOW()
        WHERE wallet_id = $1
        RETURNING *`,
      [
        wallet.walletId, next.per_payment_limit_cents, next.daily_limit_cents, next.monthly_limit_cents,
        next.allowed_rails, next.payee_allowlist, next.internal_only,
      ]
    );
    await DualLedgerEngine.appendEvent({
      eventType: 'wallet.controls.changed',
      actor,
      payload: { walletId: wallet.walletId, controls: publicWallet(rows.rows[0]).controls },
    }).catch(() => null);
    return publicWallet(rows.rows[0]);
  }

  // ── Spend controls ─────────────────────────────────────────────────────────

  /** What this wallet has committed today and this month, and what is left. */
  static async spend(ref) {
    const wallet = await this.require(ref);
    const rows = await pool.query(
      `SELECT
         COALESCE(SUM(amount_cents + fee_cents) FILTER (WHERE created_at >= date_trunc('day', NOW())), 0)::bigint AS day_cents,
         COALESCE(SUM(amount_cents + fee_cents) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0)::bigint AS month_cents,
         COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW()))::int AS day_count
       FROM ihb_payments
       WHERE debtor_va_id = $1 AND status = ANY($2::text[])`,
      [wallet.vaId, LIVE_PAYMENT_STATUSES]
    );
    const row = rows.rows[0] || {};
    const dayCents = Number(row.day_cents || 0);
    const monthCents = Number(row.month_cents || 0);
    const { dailyLimitCents, monthlyLimitCents } = wallet.controls;
    return {
      walletId: wallet.walletId,
      dayCents,
      dayCount: Number(row.day_count || 0),
      monthCents,
      dailyLimitCents,
      monthlyLimitCents,
      dailyRemainingCents: dailyLimitCents === null ? null : Math.max(dailyLimitCents - dayCents, 0),
      monthlyRemainingCents: monthlyLimitCents === null ? null : Math.max(monthlyLimitCents - monthCents, 0),
    };
  }

  /**
   * Decide whether this wallet may send this instruction, before anything is
   * written. Returns the reasons rather than throwing so a caller can quote a
   * limit back to the holder; `pay` turns a refusal into an error.
   */
  static async check(ref, { amountCents, creditorAccountNumber = null, rail = null } = {}) {
    const wallet = await this.require(ref, { withAccount: true });
    const amount = Number(amountCents);
    const violations = [];

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      violations.push({ code: 'WALLET_BAD_AMOUNT', detail: 'amountCents must be a positive integer' });
    }
    if (wallet.status !== 'active') {
      violations.push({ code: 'WALLET_INACTIVE', detail: `Wallet ${wallet.handle} is ${wallet.status}` });
    }

    const internalPayee = creditorAccountNumber ? await VirtualAccountManager.get(creditorAccountNumber) : null;
    if (wallet.controls.internalOnly && !internalPayee) {
      violations.push({
        code: 'WALLET_INTERNAL_ONLY',
        detail: `Wallet ${wallet.handle} may only pay other accounts inside the family bank`,
      });
    }
    if (wallet.controls.payeeAllowlist && wallet.controls.payeeAllowlist.length) {
      const allowed = wallet.controls.payeeAllowlist.map(entry => String(entry).toLowerCase());
      const candidate = String(creditorAccountNumber || '').toLowerCase();
      if (!allowed.includes(candidate)) {
        violations.push({
          code: 'WALLET_PAYEE_NOT_ALLOWED',
          detail: `${creditorAccountNumber || 'this payee'} is not on the allowlist for ${wallet.handle}`,
        });
      }
    }
    if (rail && wallet.controls.allowedRails && wallet.controls.allowedRails.length
      && !wallet.controls.allowedRails.includes(rail)) {
      violations.push({
        code: 'WALLET_RAIL_NOT_ALLOWED',
        detail: `Wallet ${wallet.handle} may not send over ${rail}`,
      });
    }
    if (wallet.controls.perPaymentLimitCents !== null && amount > wallet.controls.perPaymentLimitCents) {
      violations.push({
        code: 'WALLET_PER_PAYMENT_LIMIT',
        detail: `${(amount / 100).toFixed(2)} exceeds the ${(wallet.controls.perPaymentLimitCents / 100).toFixed(2)} per-payment limit`,
      });
    }

    const spend = await this.spend(wallet.walletId);
    if (spend.dailyRemainingCents !== null && amount > spend.dailyRemainingCents) {
      violations.push({
        code: 'WALLET_DAILY_LIMIT',
        detail: `${(amount / 100).toFixed(2)} exceeds the ${(spend.dailyRemainingCents / 100).toFixed(2)} left of today's limit`,
      });
    }
    if (spend.monthlyRemainingCents !== null && amount > spend.monthlyRemainingCents) {
      violations.push({
        code: 'WALLET_MONTHLY_LIMIT',
        detail: `${(amount / 100).toFixed(2)} exceeds the ${(spend.monthlyRemainingCents / 100).toFixed(2)} left of this month's limit`,
      });
    }
    if (wallet.account && amount > wallet.account.availableCents) {
      violations.push({
        code: 'WALLET_INSUFFICIENT',
        detail: `${wallet.handle} has ${wallet.account.available} available`,
      });
    }

    return {
      allowed: violations.length === 0,
      wallet,
      internal: Boolean(internalPayee),
      spend,
      violations,
    };
  }

  // ── Money movement (always through the in-house bank) ──────────────────────

  /**
   * Send from a wallet. The wallet's own controls are applied first, then the
   * instruction is handed to the in-house bank exactly as any other channel's
   * would be — including governance, routing and dual approval.
   */
  static async pay(ref, {
    idempotencyKey,
    amountCents = null,
    amount = null,
    creditor = {},
    paymentPurpose = null,
    purposeCode = null,
    requestedSpeed = 'standard',
    memo = null,
    actor = null,
  } = {}) {
    const wallet = await this.require(ref);
    if (!idempotencyKey) {
      throw new WalletError('An idempotency key is required to send from a wallet', 'WALLET_NO_IDEMPOTENCY_KEY', 400);
    }
    const config = getConfig();
    const resolvedAmount = amountCents !== null && amountCents !== undefined
      ? Number(amountCents)
      : Math.round(Number(amount) * 100);

    const decision = await this.check(wallet.walletId, {
      amountCents: resolvedAmount,
      creditorAccountNumber: creditor.accountNumber || null,
    });
    if (!decision.allowed) {
      const [first] = decision.violations;
      throw new WalletError(first.detail, first.code, first.code === 'WALLET_INACTIVE' ? 409 : 400);
    }

    const principal = { principal: actor || `wallet:${wallet.handle}`, role: 'service', scope: 'payments:initiate' };
    const result = await InHouseBankEngine.submit({
      idempotencyKey,
      channel: 'api',
      principal,
      payload: {
        debtorAccount: wallet.accountNumber,
        amountCents: resolvedAmount,
        currency: config.currency,
        creditor,
        paymentPurpose,
        purposeCode,
        requestedSpeed,
        remittanceInformation: memo,
      },
    });
    return { wallet, ...result };
  }

  /**
   * Wallet to wallet. This is the case the family bank exists for: it is an
   * on-us book transfer, so it settles the moment it is approved and no rail
   * ever sees it.
   */
  static async transfer(fromRef, {
    toRef,
    idempotencyKey,
    amountCents = null,
    amount = null,
    memo = null,
    actor = null,
  } = {}) {
    const payee = await this.require(toRef);
    if (payee.status !== 'active') {
      throw new WalletError(`Wallet ${payee.handle} is ${payee.status} and cannot receive`, 'WALLET_PAYEE_INACTIVE');
    }
    const payer = await this.require(fromRef);
    if (payer.walletId === payee.walletId) {
      throw new WalletError('A wallet cannot pay itself', 'WALLET_SELF_PAYMENT', 400);
    }
    return this.pay(payer.walletId, {
      idempotencyKey,
      amountCents,
      amount,
      memo,
      paymentPurpose: `Transfer to ${payee.handle}`,
      actor,
      creditor: { name: payee.holderName, accountNumber: payee.accountNumber },
    });
  }

  /** Operator-side funding: value in or out of the wallet against the settlement account. */
  static async fund(ref, { amountCents, direction = 'credit', memo = null, actor = 'operator' } = {}) {
    const wallet = await this.require(ref);
    if (wallet.status === 'closed') {
      throw new WalletError(`Wallet ${wallet.handle} is closed`, 'WALLET_INACTIVE');
    }
    const account = await InHouseBankEngine.fund({
      accountRef: wallet.vaId,
      amountCents,
      direction,
      memo: memo || `${direction === 'credit' ? 'Deposit to' : 'Withdrawal from'} wallet ${wallet.handle}`,
      actor,
    });
    return { ...wallet, account };
  }

  // ── Holder views ───────────────────────────────────────────────────────────

  static async balance(ref) {
    const wallet = await this.require(ref, { withAccount: true });
    const spend = await this.spend(wallet.walletId);
    return { wallet, spend };
  }

  static async activity(ref, { limit = 50 } = {}) {
    const wallet = await this.require(ref);
    const payments = await InHouseBankEngine.list({ debtorRef: wallet.vaId, limit });
    const rows = await pool.query(
      `SELECT * FROM ihb_postings WHERE va_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [wallet.vaId, Math.min(Math.max(Number(limit) || 50, 1), 500)]
    );
    return { wallet, payments, postings: rows.rows };
  }

  static async statement(ref, { fromDate = null, toDate = null } = {}) {
    const wallet = await this.require(ref);
    return InHouseBankEngine.statement({ accountRef: wallet.vaId, fromDate, toDate });
  }

  static async dashboard() {
    await this.ensureTables();
    const rows = await pool.query(
      `SELECT w.status, COUNT(*)::int AS wallets, COALESCE(SUM(v.balance_cents), 0)::bigint AS balance_cents
         FROM ihb_wallets w
         JOIN ihb_virtual_accounts v ON v.va_id = w.va_id
        GROUP BY w.status`
    );
    const byStatus = rows.rows.reduce((acc, row) => {
      acc[row.status] = { wallets: Number(row.wallets), balanceCents: Number(row.balance_cents) };
      return acc;
    }, {});
    const totals = rows.rows.reduce(
      (acc, row) => ({ wallets: acc.wallets + Number(row.wallets), balanceCents: acc.balanceCents + Number(row.balance_cents) }),
      { wallets: 0, balanceCents: 0 }
    );
    return {
      bank: getConfig().bankName,
      byStatus,
      totals,
      position: await VirtualAccountManager.position(),
    };
  }
}

module.exports = { WalletEngine, WalletError, WALLET_TYPES, WALLET_STATUSES };
