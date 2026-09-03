/**
 * Bond Financial Statement — Official Statement of Account & Proof of Venue
 *
 * Builds the periodic coupon schedule a bond's terms imply, registers elapsed
 * coupon periods on the immutable bond ledger (idempotently), and renders the
 * statement the trust issues to the bondholder from that ledger.
 */

'use strict';

const pool = require('./pgPool');
const { buildStatementPdf } = require('./bondStatementPdf');

const COUPON_TXN_TYPE = 'coupon_accrual';

const PERIODS_PER_YEAR = { monthly: 12, quarterly: 4, 'semi-annual': 2, annual: 1 };

function round2(n) {
  return Math.round(n * 100) / 100;
}

function isoDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function utc(value) {
  const [y, m, d] = isoDate(value).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addMonths(date, months, anchorDay) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(anchorDay, lastDay)));
}

function periodLabel(freq) {
  return { monthly: 'Monthly', quarterly: 'Quarterly', 'semi-annual': 'Semi-Annual', annual: 'Annual' }[freq] || freq;
}

class BondStatementEngine {

  static async ensureSchema() {
    await pool.query(`ALTER TABLE bonds ADD COLUMN IF NOT EXISTS statement_id TEXT`);
    await pool.query(`ALTER TABLE bonds ADD COLUMN IF NOT EXISTS bondholder TEXT`);
    await pool.query(`ALTER TABLE bonds ADD COLUMN IF NOT EXISTS venue_state TEXT`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bonds_statement_id ON bonds(statement_id) WHERE statement_id IS NOT NULL`);
  }

  /**
   * Resolve a bond by numeric id, statement id, bond identifier or name.
   */
  static async findBond(ref) {
    const key = String(ref || '').trim().replace(/^#/, '');
    if (!key) return null;
    const numericId = /^[0-9]{1,9}$/.test(key) ? Number(key) : null;
    const { rows } = await pool.query(
      `SELECT b.*, bb.principal_balance, bb.accrued_interest, bb.total_interest_paid,
              bb.total_principal_paid, bb.last_accrual_date, bb.last_payment_date
       FROM bonds b
       JOIN bond_balances bb ON bb.bond_id = b.id
       WHERE b.statement_id = $1
          OR b.id = $2
          OR UPPER(COALESCE(b.bond_identifier, '')) = UPPER($1)
          OR UPPER(b.bond_name) = UPPER($1)
       ORDER BY (b.statement_id = $1) DESC NULLS LAST, b.id
       LIMIT 1`,
      [key, numericId]
    );
    return rows[0] || null;
  }

  /**
   * Coupon schedule implied by the bond's terms: one row per period from
   * issuance through `asOf` (period 0 is the issuance itself).
   */
  static schedule(bond, asOf = new Date()) {
    const freq = PERIODS_PER_YEAR[bond.payment_freq];
    if (!freq) throw new Error(`Unsupported payment frequency: ${bond.payment_freq}`);
    const face = parseFloat(bond.face_value);
    const rate = parseFloat(bond.coupon_rate);
    const coupon = round2(face * rate / freq);
    const issue = utc(bond.issue_date);
    const maturity = utc(bond.maturity_date);
    const end = utc(asOf);
    const months = 12 / freq;

    const rows = [{ period: 0, date: isoDate(issue), event: 'Bond Issuance', periodInterest: 0, cumulativeInterest: 0, endingBalance: face }];
    let cumulative = 0;
    for (let n = 1; ; n++) {
      const date = addMonths(issue, months * n, issue.getUTCDate());
      if (date > end || date > maturity) break;
      cumulative = round2(cumulative + coupon);
      rows.push({
        period: n,
        date: isoDate(date),
        event: `${periodLabel(bond.payment_freq)} Coupon`,
        periodInterest: coupon,
        cumulativeInterest: cumulative,
        endingBalance: round2(face + cumulative),
      });
    }
    return { couponPerPeriod: coupon, periodRate: rate / freq, periodsPerYear: freq, rows };
  }

  /**
   * Register every elapsed coupon period on the bond ledger that is not yet
   * recorded. Safe to re-run: existing coupon rows are matched by date.
   */
  static async registerCoupons(bondRef, { asOf = new Date(), actor = null } = {}) {
    const resolved = await this.findBond(bondRef);
    if (!resolved) throw new Error(`Bond ${bondRef} not found`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT b.*, bb.principal_balance, bb.accrued_interest, bb.last_accrual_date
         FROM bonds b JOIN bond_balances bb ON bb.bond_id = b.id
         WHERE b.id = $1 FOR UPDATE OF bb`,
        [resolved.id]
      );
      const bond = found.rows[0];

      const { rows: existing } = await client.query(
        `SELECT transaction_date FROM bond_transactions WHERE bond_id = $1 AND transaction_type = $2`,
        [bond.id, COUPON_TXN_TYPE]
      );
      const recorded = new Set(existing.map((r) => isoDate(r.transaction_date)));

      const sched = this.schedule(bond, asOf);
      const principal = parseFloat(bond.principal_balance);
      let accrued = parseFloat(bond.accrued_interest);
      let lastAccrual = bond.last_accrual_date ? isoDate(bond.last_accrual_date) : isoDate(bond.issue_date);
      const registered = [];

      for (const row of sched.rows.slice(1)) {
        if (recorded.has(row.date)) continue;
        accrued = round2(accrued + row.periodInterest);
        await client.query(
          `INSERT INTO bond_transactions (bond_id, transaction_type, amount, running_balance, accrued_interest, description, transaction_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [bond.id, COUPON_TXN_TYPE, row.periodInterest, principal, accrued,
           `${row.event} — period ${row.period} (${(sched.periodRate * 100).toFixed(2)}% per period)${actor ? ` registered by ${actor}` : ''}`,
           row.date]
        );
        if (row.date > lastAccrual) lastAccrual = row.date;
        registered.push(row);
      }

      if (registered.length) {
        await client.query(
          `UPDATE bond_balances SET accrued_interest = $1, last_accrual_date = $2, updated_at = NOW() WHERE bond_id = $3`,
          [accrued, lastAccrual, bond.id]
        );
      }
      await client.query('COMMIT');
      return { bondId: bond.id, registered, skipped: sched.rows.length - 1 - registered.length, accruedInterest: accrued, lastAccrualDate: lastAccrual };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Statement of account as of a date, built from the ledger and reconciled
   * against the schedule the terms imply.
   */
  static async buildStatement(bondRef, { asOf = new Date() } = {}) {
    const bond = await this.findBond(bondRef);
    if (!bond) throw new Error(`Bond ${bondRef} not found`);

    const sched = this.schedule(bond, asOf);
    const { rows: ledger } = await pool.query(
      `SELECT transaction_type, amount, running_balance, accrued_interest, transaction_date, description
       FROM bond_transactions
       WHERE bond_id = $1 AND transaction_type IN ('issuance', $2) AND transaction_date <= $3
       ORDER BY transaction_date, id`,
      [bond.id, COUPON_TXN_TYPE, isoDate(asOf)]
    );
    const ledgerCoupons = ledger.filter((t) => t.transaction_type === COUPON_TXN_TYPE);
    const ledgerInterest = round2(ledgerCoupons.reduce((s, t) => s + parseFloat(t.amount), 0));
    const ledgerDates = new Set(ledgerCoupons.map((t) => isoDate(t.transaction_date)));

    const face = parseFloat(bond.face_value);
    const periodsElapsed = sched.rows.length - 1;
    const cumulativeInterest = sched.rows[periodsElapsed].cumulativeInterest;
    const missing = sched.rows.slice(1).filter((r) => !ledgerDates.has(r.date)).map((r) => r.date);
    const years = Math.round((utc(bond.maturity_date).getUTCFullYear() - utc(bond.issue_date).getUTCFullYear()));

    return {
      statementId: bond.statement_id || String(bond.bond_identifier || bond.id),
      title: 'Bond Financial Statement',
      subtitle: 'Official Statement of Account & Proof of Venue',
      asOf: isoDate(asOf),
      issuer: bond.issuer || 'DeAndrea Lavar Barkley Trust Company',
      bondholder: bond.bondholder || null,
      venueState: bond.venue_state || bond.issuer_state || null,
      bond: {
        id: bond.id,
        name: bond.bond_name,
        identifier: bond.bond_identifier,
        isin: bond.isin,
        currency: bond.currency,
        status: bond.status,
      },
      terms: {
        principal: face,
        couponRate: parseFloat(bond.coupon_rate),
        paymentFrequency: periodLabel(bond.payment_freq),
        periodRate: sched.periodRate,
        couponPerPeriod: sched.couponPerPeriod,
        issueDate: isoDate(bond.issue_date),
        maturityDate: isoDate(bond.maturity_date),
        termYears: years,
      },
      balance: {
        originalPrincipal: face,
        periodsElapsed,
        cumulativeInterest,
        endToDateBalance: round2(face + cumulativeInterest),
      },
      schedule: sched.rows.map((r) => ({ ...r, ledgered: r.period === 0 ? ledger.some((t) => t.transaction_type === 'issuance') : ledgerDates.has(r.date) })),
      ledger: {
        couponRows: ledgerCoupons.length,
        cumulativeInterest: ledgerInterest,
        principalBalance: parseFloat(bond.principal_balance),
        accruedInterest: parseFloat(bond.accrued_interest),
        reconciled: missing.length === 0 && ledgerInterest === cumulativeInterest,
        missingPeriods: missing,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  static async renderPdf(bondRef, opts = {}) {
    const statement = await this.buildStatement(bondRef, opts);
    return { statement, pdf: buildStatementPdf(statement), filename: `bond-statement-${statement.statementId}-${statement.asOf}.pdf` };
  }
}

module.exports = { BondStatementEngine, COUPON_TXN_TYPE };
