'use strict';
/**
 * One-time script to update DLB-PRB to the correct amortizing terms and reset
 * its balances to the amortized schedule as of today.
 *
 * Correct terms:
 *   face_value: $100,000,000
 *   coupon_rate: 1% (0.01)
 *   issue_date: 2024-02-28
 *   maturity_date: 2124-02-28
 *   payment_freq: semi-annual
 *   amortizing: true
 */

const pool = require('../integrations/bonds/pgPool');

function freqPerYear(freq) {
  switch ((freq || 'monthly').toLowerCase().replace(/_/g, '-')) {
    case 'monthly': return 12;
    case 'quarterly': return 4;
    case 'semi-annual':
    case 'semi-annual': return 2;
    case 'annual': return 1;
    default: return 12;
  }
}

function addMonths(d, months) {
  const nd = new Date(d);
  nd.setMonth(nd.getMonth() + months);
  nd.setHours(0, 0, 0, 0);
  return nd;
}

function days30_360(d1, d2) {
  const y1 = d1.getFullYear(), m1 = d1.getMonth() + 1, day1 = Math.min(d1.getDate(), 30);
  const y2 = d2.getFullYear(), m2 = d2.getMonth() + 1, day2 = Math.min(d2.getDate(), 30);
  return Math.max(0, (y2 - y1) * 360 + (m2 - m1) * 30 + (day2 - day1));
}

async function main() {
  const now = new Date();
  const asOf = new Date(now.toISOString().split('T')[0]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ensure amortizing column exists
    await client.query(`ALTER TABLE bonds ADD COLUMN IF NOT EXISTS amortizing BOOLEAN NOT NULL DEFAULT false`);

    // Fetch DLB-PRB
    const bondRes = await client.query(`SELECT id, face_value, coupon_rate, issue_date, maturity_date, payment_freq, day_count FROM bonds WHERE isin = $1 OR bond_name = $2 FOR UPDATE`, ['US-DLB-PRB-2024', 'DLB-PRB']);
    if (!bondRes.rows.length) throw new Error('DLB-PRB not found');
    const bond = bondRes.rows[0];
    const bondId = bond.id;

    // Update bond terms
    await client.query(
      `UPDATE bonds SET bond_name = 'DLB-PRB', isin = 'US-DLB-PRB-2024', face_value = $1, coupon_rate = $2,
          issue_date = $3, maturity_date = $4, payment_freq = $5, day_count = $6, amortizing = true, status = 'active', updated_at = NOW()
       WHERE id = $7`,
      [100000000, 0.01, '2024-02-28', '2124-02-28', 'semi-annual', '30/360', bondId]
    );

    // Reset balances and clear old transactions for a clean amortization start
    await client.query(`DELETE FROM bond_transactions WHERE bond_id = $1`, [bondId]);
    await client.query(
      `INSERT INTO bond_transactions (bond_id, transaction_type, amount, running_balance, accrued_interest, description, transaction_date)
       VALUES ($1, 'issuance', $2, $2, 0, 'Bond issued — initial principal', $3)
       ON CONFLICT DO NOTHING`,
      [bondId, 100000000, '2024-02-28']
    );

    const face = 100000000;
    const coupon = 0.01;
    const freq = 2;
    const r = coupon / freq;
    const monthsPerPeriod = 6;
    const totalMonths = (2124 - 2024) * 12 + (2 - 2); // 1200
    const n = Math.round(totalMonths / monthsPerPeriod); // 200
    const pmt = (face * r) / (1 - Math.pow(1 + r, -n));

    let currentBalance = face;
    let totalPrincipalPaid = 0;
    let totalInterestPaid = 0;
    const issueDate = new Date('2024-02-28');
    let lastPaymentDate = issueDate;
    let nextPayment = addMonths(issueDate, monthsPerPeriod);

    while (nextPayment <= asOf) {
      const interest = Math.round(currentBalance * r * 100) / 100;
      const principal = Math.round((pmt - interest) * 100) / 100;
      currentBalance = Math.round((currentBalance - principal) * 100) / 100;
      totalPrincipalPaid = Math.round((totalPrincipalPaid + principal) * 100) / 100;
      totalInterestPaid = Math.round((totalInterestPaid + interest) * 100) / 100;

      await client.query(
        `INSERT INTO bond_transactions (bond_id, transaction_type, amount, running_balance, accrued_interest, description, transaction_date)
         VALUES ($1, 'principal_payment', $2, $3, $4, $5, $6)`,
        [bondId, principal, currentBalance, 0, `Scheduled principal payment — ${nextPayment.toISOString().split('T')[0]}`, nextPayment.toISOString().split('T')[0]]
      );
      await client.query(
        `INSERT INTO bond_transactions (bond_id, transaction_type, amount, running_balance, accrued_interest, description, transaction_date)
         VALUES ($1, 'interest_payment', $2, $3, $4, $5, $6)`,
        [bondId, interest, currentBalance, 0, `Scheduled interest payment — ${nextPayment.toISOString().split('T')[0]}`, nextPayment.toISOString().split('T')[0]]
      );

      lastPaymentDate = nextPayment;
      nextPayment = addMonths(nextPayment, monthsPerPeriod);
    }

    const daysInPartial = days30_360(lastPaymentDate, asOf);
    const accruedInterest = Math.round(currentBalance * coupon * (daysInPartial / 360) * 100) / 100;

    await client.query(
      `UPDATE bond_balances
       SET principal_balance = $1, total_principal_paid = $2, total_interest_paid = $3,
           accrued_interest = $4, last_accrual_date = $5, last_payment_date = $6, updated_at = NOW()
       WHERE bond_id = $7`,
      [currentBalance, totalPrincipalPaid, totalInterestPaid, accruedInterest, asOf.toISOString().split('T')[0], lastPaymentDate.toISOString().split('T')[0], bondId]
    );

    await client.query('COMMIT');
    console.log('[amortizeBond] Updated DLB-PRB to amortizing, semi-annual, 1% coupon.');
    console.log({
      bond_id: bondId,
      as_of: asOf.toISOString().split('T')[0],
      payment_amount: Math.round(pmt * 100) / 100,
      principal_balance: currentBalance,
      total_principal_paid: totalPrincipalPaid,
      total_interest_paid: totalInterestPaid,
      accrued_interest: accruedInterest,
      total_current_value: Math.round((currentBalance + accruedInterest) * 100) / 100,
      last_payment_date: lastPaymentDate.toISOString().split('T')[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[amortizeBond] Error:', err);
    process.exit(1);
  } finally {
    client.release();
  }
  process.exit(0);
}

main();
