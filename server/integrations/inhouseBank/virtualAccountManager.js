'use strict';

/**
 * Virtual Account Management (VAM) for the PTC In-House Family Bank
 *
 * The trust holds one real account at the partner bank. Every family member,
 * entity, series and purpose gets a *virtual* account inside it: its own
 * account number that counterparties can pay to, its own balance, its own
 * limits — but no separate bank account behind it. That is what makes an
 * in-house bank an in-house bank rather than a folder of bank accounts.
 *
 * Two rules hold the model together and are enforced here rather than by
 * convention:
 *
 *   • The sum of every virtual balance must equal what the bank owes its
 *     account holders in the trust GL. `position()` states that sum and the
 *     drift against the deposit liability, so a break is visible instead of
 *     inferred. The settlement account is reported next to it as coverage:
 *     it also carries trust activity that has nothing to do with the bank, so
 *     it is asked whether it *covers* the pool, not whether it equals it.
 *   • Available balance is balance − holds + overdraft, and a debit that would
 *     breach it is refused by the same UPDATE that would have applied it. Two
 *     concurrent debits therefore cannot both see the same funds.
 *
 * Holds exist because an authorized payment that has not yet settled has
 * already spent the money: leaving it available would let a second payment
 * spend it twice while the first is in flight on an external rail.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { getConfig } = require('./inHouseBankConfig');

const ACCOUNT_TYPES = Object.freeze([
  'family_member',   // an individual beneficiary of the family bank
  'entity',          // an operating company or LLC under the trust
  'series',          // a ring-fenced series of the master trust
  'expense',         // a purpose account: tuition, medical, household
  'escrow',          // funds held for a named counterparty obligation
  'reserve',         // buffer held back from allocation
  'settlement',      // the mirror of the real partner-bank account
]);

const STATUSES = Object.freeze(['active', 'frozen', 'closed']);

class VirtualAccountError extends Error {
  constructor(message, code = 'IHB_VA_REFUSED', status = 409) {
    super(message);
    this.name = 'VirtualAccountError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function id(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * ISO 7064 mod-97-10: the same check the IBAN standard uses. Letters are
 * folded to digits the IBAN way (A=10 … Z=35) so a lettered account prefix
 * still produces real check digits instead of arithmetic on NaN.
 */
function checkDigits(base) {
  const numeric = `${base}00`.toUpperCase().replace(/[^0-9A-Z]/g, '')
    .split('')
    .map(char => (/[0-9]/.test(char) ? char : String(char.charCodeAt(0) - 55)))
    .join('');
  let remainder = 0;
  for (const char of numeric) {
    remainder = (remainder * 10 + Number(char)) % 97;
  }
  const check = 98 - remainder;
  return String(check).padStart(2, '0');
}

function cents(value, field = 'amountCents') {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new VirtualAccountError(`${field} must be an integer number of cents`, 'IHB_VA_BAD_AMOUNT', 400);
  return number;
}

function publicAccount(row) {
  if (!row) return null;
  const balance = Number(row.balance_cents || 0);
  const hold = Number(row.hold_cents || 0);
  const overdraft = Number(row.overdraft_limit_cents || 0);
  return {
    vaId: row.va_id,
    accountNumber: row.account_number,
    virtualIban: row.virtual_iban,
    name: row.name,
    ownerRef: row.owner_ref,
    accountType: row.account_type,
    purpose: row.purpose,
    parentVaId: row.parent_va_id,
    seriesRef: row.series_ref,
    currency: row.currency,
    status: row.status,
    balanceCents: balance,
    holdCents: hold,
    overdraftLimitCents: overdraft,
    availableCents: balance - hold + overdraft,
    balance: (balance / 100).toFixed(2),
    available: ((balance - hold + overdraft) / 100).toFixed(2),
    settlementAccountCode: row.settlement_account_code,
    allowedRails: row.allowed_rails || null,
    openedBy: row.opened_by,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

class VirtualAccountManager {
  static accountTypes() {
    return ACCOUNT_TYPES.slice();
  }

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ihb_virtual_accounts (
        va_id                  TEXT PRIMARY KEY,
        account_number         TEXT UNIQUE NOT NULL,
        virtual_iban           TEXT UNIQUE,
        name                   TEXT NOT NULL,
        owner_ref              TEXT,
        account_type           TEXT NOT NULL,
        purpose                TEXT,
        parent_va_id           TEXT,
        series_ref             TEXT,
        currency               TEXT NOT NULL DEFAULT 'USD',
        status                 TEXT NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active','frozen','closed')),
        balance_cents          BIGINT NOT NULL DEFAULT 0,
        hold_cents             BIGINT NOT NULL DEFAULT 0,
        overdraft_limit_cents  BIGINT NOT NULL DEFAULT 0,
        settlement_account_code TEXT,
        allowed_rails          JSONB,
        opened_by              TEXT,
        closed_at              TIMESTAMPTZ,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_ihb_va_owner ON ihb_virtual_accounts (owner_ref, status)`
    );
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ihb_holds (
        hold_id      TEXT PRIMARY KEY,
        va_id        TEXT NOT NULL,
        payment_id   TEXT,
        amount_cents BIGINT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','released','captured')),
        reason       TEXT,
        placed_by    TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at  TIMESTAMPTZ
      )
    `);
    return true;
  }

  static async open({
    name,
    ownerRef = null,
    accountType = 'family_member',
    purpose = null,
    parentRef = null,
    seriesRef = null,
    overdraftLimitCents = 0,
    allowedRails = null,
    openedBy = 'operator',
  } = {}) {
    await this.ensureTables();
    const config = getConfig();
    if (!name || !String(name).trim()) throw new VirtualAccountError('name is required', 'IHB_VA_NO_NAME', 400);
    if (!ACCOUNT_TYPES.includes(accountType)) {
      throw new VirtualAccountError(`accountType must be one of ${ACCOUNT_TYPES.join(', ')}`, 'IHB_VA_BAD_TYPE', 400);
    }
    const overdraft = cents(overdraftLimitCents, 'overdraftLimitCents');
    if (overdraft < 0) throw new VirtualAccountError('overdraftLimitCents cannot be negative', 'IHB_VA_BAD_AMOUNT', 400);

    let parent = null;
    if (parentRef) {
      parent = await this.get(parentRef);
      if (!parent) throw new VirtualAccountError(`Parent virtual account ${parentRef} not found`, 'IHB_VA_NO_PARENT', 404);
    }

    const vaId = id('VA');
    const serial = String(Date.now()).slice(-9) + crypto.randomInt(0, 10);
    const base = `${config.virtualAccountPrefix}${serial}`;
    const accountNumber = `${base}${checkDigits(base)}`;
    const virtualIban = `${config.bankBic.slice(0, 4)}-${accountNumber}`;

    const rows = await pool.query(
      `INSERT INTO ihb_virtual_accounts
         (va_id, account_number, virtual_iban, name, owner_ref, account_type, purpose, parent_va_id,
          series_ref, currency, overdraft_limit_cents, settlement_account_code, allowed_rails, opened_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        vaId, accountNumber, virtualIban, String(name).trim(), ownerRef, accountType, purpose,
        parent ? parent.vaId : null, seriesRef, config.currency, overdraft,
        config.settlementAccountCode, allowedRails ? JSON.stringify(allowedRails) : null, openedBy,
      ]
    );
    return publicAccount(rows.rows[0]);
  }

  static async get(ref) {
    if (!ref) return null;
    await this.ensureTables();
    const rows = await pool.query(
      `SELECT * FROM ihb_virtual_accounts
        WHERE va_id = $1 OR account_number = $1 OR virtual_iban = $1
        LIMIT 1`,
      [String(ref)]
    );
    return publicAccount(rows.rows[0]);
  }

  static async require(ref, label = 'virtual account') {
    const account = await this.get(ref);
    if (!account) throw new VirtualAccountError(`Unknown ${label} ${ref}`, 'IHB_VA_NOT_FOUND', 404);
    return account;
  }

  static async list({ status = null, ownerRef = null, accountType = null, limit = 200 } = {}) {
    await this.ensureTables();
    const rows = await pool.query(
      `SELECT * FROM ihb_virtual_accounts
        WHERE ($1::text IS NULL OR status = $1)
          AND ($2::text IS NULL OR owner_ref = $2)
          AND ($3::text IS NULL OR account_type = $3)
        ORDER BY created_at DESC
        LIMIT $4`,
      [status, ownerRef, accountType, Math.min(Math.max(Number(limit) || 200, 1), 1000)]
    );
    return rows.rows.map(publicAccount);
  }

  static async setStatus(ref, status, actor = 'operator') {
    if (!STATUSES.includes(status)) throw new VirtualAccountError(`status must be one of ${STATUSES.join(', ')}`, 'IHB_VA_BAD_STATUS', 400);
    const account = await this.require(ref);
    if (status === 'closed' && account.balanceCents !== 0) {
      throw new VirtualAccountError(
        `Virtual account ${account.accountNumber} still holds ${account.balance}; sweep it before closing`,
        'IHB_VA_NOT_EMPTY'
      );
    }
    const rows = await pool.query(
      `UPDATE ihb_virtual_accounts
          SET status = $2, closed_at = CASE WHEN $2 = 'closed' THEN NOW() ELSE NULL END, updated_at = NOW()
        WHERE va_id = $1
        RETURNING *`,
      [account.vaId, status]
    );
    return { ...publicAccount(rows.rows[0]), changedBy: actor };
  }

  /**
   * Restrict which rails this account may send over. Governance reads this on
   * every submission, so it is the only rail restriction the router honours;
   * anything held elsewhere is advisory.
   */
  static async setAllowedRails(ref, allowedRails) {
    const account = await this.require(ref);
    const rows = await pool.query(
      `UPDATE ihb_virtual_accounts SET allowed_rails = $2, updated_at = NOW() WHERE va_id = $1 RETURNING *`,
      [account.vaId, allowedRails && allowedRails.length ? JSON.stringify(allowedRails) : null]
    );
    return publicAccount(rows.rows[0]);
  }

  // ── Balance movement ───────────────────────────────────────────────────────

  /**
   * Debit is refused by the same statement that would apply it, so the
   * available-funds check and the deduction cannot be separated by a race.
   */
  static async debit({ ref, amountCents, allowFrozen = false }) {
    const account = await this.require(ref);
    const amount = cents(amountCents);
    if (amount <= 0) throw new VirtualAccountError('Debit amount must be positive', 'IHB_VA_BAD_AMOUNT', 400);
    if (account.status !== 'active' && !allowFrozen) {
      throw new VirtualAccountError(`Virtual account ${account.accountNumber} is ${account.status}`, 'IHB_VA_INACTIVE');
    }
    const rows = await pool.query(
      `UPDATE ihb_virtual_accounts
          SET balance_cents = balance_cents - $2, updated_at = NOW()
        WHERE va_id = $1
          AND (balance_cents - hold_cents + overdraft_limit_cents) >= $2
        RETURNING *`,
      [account.vaId, amount]
    );
    if (!rows.rows.length) {
      throw new VirtualAccountError(
        `Virtual account ${account.accountNumber} has ${account.available} available; ${(amount / 100).toFixed(2)} was requested`,
        'IHB_VA_INSUFFICIENT'
      );
    }
    return publicAccount(rows.rows[0]);
  }

  static async credit({ ref, amountCents }) {
    const account = await this.require(ref);
    const amount = cents(amountCents);
    if (amount <= 0) throw new VirtualAccountError('Credit amount must be positive', 'IHB_VA_BAD_AMOUNT', 400);
    if (account.status === 'closed') {
      throw new VirtualAccountError(`Virtual account ${account.accountNumber} is closed`, 'IHB_VA_INACTIVE');
    }
    const rows = await pool.query(
      `UPDATE ihb_virtual_accounts
          SET balance_cents = balance_cents + $2, updated_at = NOW()
        WHERE va_id = $1
        RETURNING *`,
      [account.vaId, amount]
    );
    return publicAccount(rows.rows[0]);
  }

  // ── Holds ──────────────────────────────────────────────────────────────────

  static async placeHold({ ref, amountCents, paymentId = null, reason = null, placedBy = 'system' }) {
    const account = await this.require(ref);
    const amount = cents(amountCents);
    if (amount <= 0) throw new VirtualAccountError('Hold amount must be positive', 'IHB_VA_BAD_AMOUNT', 400);
    const rows = await pool.query(
      `UPDATE ihb_virtual_accounts
          SET hold_cents = hold_cents + $2, updated_at = NOW()
        WHERE va_id = $1
          AND status = 'active'
          AND (balance_cents - hold_cents + overdraft_limit_cents) >= $2
        RETURNING *`,
      [account.vaId, amount]
    );
    if (!rows.rows.length) {
      throw new VirtualAccountError(
        `Cannot hold ${(amount / 100).toFixed(2)} on ${account.accountNumber}: ${account.available} is available`,
        'IHB_VA_INSUFFICIENT'
      );
    }
    const holdId = id('HLD');
    await pool.query(
      `INSERT INTO ihb_holds (hold_id, va_id, payment_id, amount_cents, reason, placed_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [holdId, account.vaId, paymentId, amount, reason, placedBy]
    );
    return { holdId, account: publicAccount(rows.rows[0]), amountCents: amount };
  }

  static async _resolveHold(holdId, outcome) {
    const rows = await pool.query(
      `UPDATE ihb_holds SET status = $2, resolved_at = NOW()
        WHERE hold_id = $1 AND status = 'active'
        RETURNING *`,
      [holdId, outcome]
    );
    const hold = rows.rows[0];
    if (!hold) return null;
    await pool.query(
      `UPDATE ihb_virtual_accounts
          SET hold_cents = GREATEST(hold_cents - $2, 0), updated_at = NOW()
        WHERE va_id = $1`,
      [hold.va_id, Number(hold.amount_cents)]
    );
    return hold;
  }

  /** The payment died before it moved: the money goes back to available. */
  static async releaseHold(holdId) {
    const hold = await this._resolveHold(holdId, 'released');
    return hold ? { holdId, released: true, amountCents: Number(hold.amount_cents) } : { holdId, released: false };
  }

  /** The payment moved: the hold is retired and the balance is actually debited. */
  static async captureHold(holdId) {
    const hold = await this._resolveHold(holdId, 'captured');
    if (!hold) return { holdId, captured: false };
    const account = await this.debit({ ref: hold.va_id, amountCents: Number(hold.amount_cents), allowFrozen: true });
    return { holdId, captured: true, amountCents: Number(hold.amount_cents), account };
  }

  static async holdsFor(paymentId) {
    await this.ensureTables();
    const rows = await pool.query('SELECT * FROM ihb_holds WHERE payment_id = $1 ORDER BY created_at DESC', [paymentId]);
    return rows.rows;
  }

  // ── Pooled position ────────────────────────────────────────────────────────

  /**
   * The whole point of the model: virtual balances are claims on one real
   * balance, so their sum has to equal it. Anything else is a break, and the
   * engine reports it rather than netting it away.
   */
  static async position() {
    await this.ensureTables();
    const config = getConfig();
    const rows = await pool.query(
      `SELECT COUNT(*)::int AS accounts,
              COALESCE(SUM(balance_cents), 0)::bigint AS balance_cents,
              COALESCE(SUM(hold_cents), 0)::bigint AS hold_cents
         FROM ihb_virtual_accounts
        WHERE status <> 'closed'`
    );
    const summary = rows.rows[0] || {};
    const virtualCents = Number(summary.balance_cents || 0);

    let settlementCents = null;
    let depositLiabilityCents = null;
    try {
      const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');
      const [settlement, deposits] = await Promise.all([
        TrustAccountingEngine.getAccount(config.settlementAccountCode),
        TrustAccountingEngine.getAccount(config.glDepositAccountCode),
      ]);
      if (settlement) settlementCents = Math.round(Number(settlement.balance || 0) * 100);
      if (deposits) depositLiabilityCents = Math.round(Number(deposits.balance || 0) * 100);
    } catch (err) {
      settlementCents = null;
    }

    const driftCents = depositLiabilityCents === null ? null : depositLiabilityCents - virtualCents;
    const coverageCents = settlementCents === null ? null : settlementCents - virtualCents;
    return {
      accounts: Number(summary.accounts || 0),
      virtualBalanceCents: virtualCents,
      virtualBalance: (virtualCents / 100).toFixed(2),
      heldCents: Number(summary.hold_cents || 0),
      settlementAccountCode: config.settlementAccountCode,
      settlementBalanceCents: settlementCents,
      depositAccountCode: config.glDepositAccountCode,
      depositLiabilityCents,
      coverageCents,
      covered: coverageCents === null ? null : coverageCents >= 0,
      driftCents,
      balanced: driftCents === 0,
      note: depositLiabilityCents === null
        ? 'The deposit liability could not be read, so the virtual pool is unverified against the trust GL.'
        : driftCents === 0
          ? 'Virtual balances sum exactly to what the bank owes its account holders in the trust GL.'
          : `Virtual balances differ from the deposit liability by ${(driftCents / 100).toFixed(2)}; a posting reached one ledger and not the other.`,
      coverageNote: settlementCents === null
        ? 'The settlement account balance could not be read, so pool coverage is unverified.'
        : coverageCents >= 0
          ? `The settlement account holds ${(coverageCents / 100).toFixed(2)} more than the virtual pool, so every virtual balance is backed by real cash.`
          : `The settlement account is ${(Math.abs(coverageCents) / 100).toFixed(2)} short of the virtual pool; fund it before releasing further payments.`,
    };
  }
}

module.exports = { VirtualAccountManager, VirtualAccountError, ACCOUNT_TYPES };
