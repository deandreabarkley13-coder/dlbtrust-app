'use strict';

/**
 * Coupon Service — Bridge between Bond Accrual and ACH Payment
 *
 * Handles:
 *  - Coupon payment detection (is a coupon due today?)
 *  - Building ACH entries from bondholder contacts
 *  - Creating ACH batch + GL entry via PaymentOrchestrator
 *  - Recording coupon payment history
 *  - Reducing accrued interest via BondEngine.payInterest()
 *  - Scheduling automatic coupon deposits
 */

const pool = require('./pgPool');
const { BondEngine } = require('./bondEngine');
const { LiveBondEngine } = require('./liveEngine');
const { PaymentOrchestrator } = require('../ach/paymentOrchestrator');

class CouponService {

  /**
   * Ensure the coupon_payments tracking table exists.
   */
  static async ensureTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS coupon_payments (
        id                  SERIAL PRIMARY KEY,
        coupon_payment_id   TEXT UNIQUE NOT NULL,
        bond_id             INTEGER NOT NULL,
        coupon_date         DATE NOT NULL,
        amount              NUMERIC(18,2) NOT NULL,
        status              TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','processing','paid','failed')),
        ach_batch_id        TEXT,
        bondholders_paid    INTEGER DEFAULT 0,
        bondholders_skipped INTEGER DEFAULT 0,
        journal_entry_id    TEXT,
        error_message       TEXT,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        updated_at          TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  /**
   * Seed sample bondholder contacts for the trust.
   * Only seeds if no investor contacts exist.
   */
  static async seedBondholders() {
    const existing = await pool.query(
      `SELECT COUNT(*) as count FROM crm_contacts WHERE contact_type = 'investor'`
    );
    if (parseInt(existing.rows[0].count, 10) > 0) return { seeded: false, message: 'Investors already exist' };

    const bondholders = [
      {
        contact_id: 'CRM-INV-001',
        contact_type: 'investor',
        first_name: 'DeAndrea',
        last_name: 'Barkley',
        company: 'DLB Trust',
        email: 'deandreabarkley13@gmail.com',
        routing_number: '021000021',
        account_number: '123456789',
        bank_account_type: 'checking',
        bank_name: 'JPMorgan Chase',
        kyc_status: 'verified',
        notes: 'Primary bondholder — 100% allocation of DLB-PRB',
      },
    ];

    for (const bh of bondholders) {
      await pool.query(
        `INSERT INTO crm_contacts
           (contact_id, contact_type, first_name, last_name, company, email,
            routing_number, account_number, bank_account_type, bank_name,
            kyc_status, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (contact_id) DO NOTHING`,
        [bh.contact_id, bh.contact_type, bh.first_name, bh.last_name,
         bh.company, bh.email, bh.routing_number, bh.account_number,
         bh.bank_account_type, bh.bank_name, bh.kyc_status, bh.notes]
      );
    }

    // Link bondholder to bond via subscription if not already linked
    try {
      await pool.query(
        `INSERT INTO crm_bond_subscriptions
           (subscription_id, contact_id, bond_id, subscription_amount, offering_price, settlement_date)
         VALUES ('SUB-DLB-PRB-001', 'CRM-INV-001', 1, 100000000, 1.0, '2024-02-28')
         ON CONFLICT DO NOTHING`
      );
    } catch (e) { /* ignore if already exists */ }

    return { seeded: true, count: bondholders.length };
  }

  /**
   * Get bondholders for a specific bond with their bank details.
   * Returns investors linked via crm_bond_subscriptions.
   */
  static async getBondholders(bondId) {
    const result = await pool.query(
      `SELECT c.contact_id, c.first_name, c.last_name, c.company,
              c.routing_number, c.account_number, c.bank_account_type, c.bank_name,
              c.email, c.kyc_status,
              s.subscription_amount, s.offering_price
       FROM crm_bond_subscriptions s
       JOIN crm_contacts c ON c.contact_id = s.contact_id
       WHERE s.bond_id = $1 AND c.status = 'active'
       ORDER BY s.subscription_amount DESC`,
      [bondId]
    );
    return result.rows;
  }

  /**
   * Deposit (pay) a coupon — the core bridge method.
   *
   * 1. Get bond live metrics (coupon amount, next date)
   * 2. Look up bondholders with bank details
   * 3. Build ACH entries proportional to holdings
   * 4. Create ACH batch via PaymentOrchestrator (GL entry included)
   * 5. Reduce accrued interest via BondEngine.payInterest()
   * 6. Record coupon_payment history
   * 7. Transmit the batch
   *
   * @param {number} bondId
   * @param {Object} opts
   * @param {number} opts.amount - override payment amount (defaults to coupon_per_period)
   * @param {string} opts.couponDate - override coupon date
   * @param {boolean} opts.autoTransmit - transmit immediately (default true)
   * @returns {Object} coupon payment result
   */
  static async depositCoupon(bondId, opts = {}) {
    await CouponService.ensureTable();

    // 1. Get live bond metrics
    const metrics = await LiveBondEngine.getBondLiveMetrics(bondId);
    const paymentAmount = opts.amount || metrics.coupon_per_period;
    const couponDate = opts.couponDate || metrics.next_coupon_date;

    if (paymentAmount <= 0) {
      throw new Error('Coupon payment amount must be positive');
    }

    // Check if total accrued covers the payment
    if (paymentAmount > metrics.accrued_interest_total) {
      throw new Error(
        `Insufficient accrued interest: $${metrics.accrued_interest_total.toFixed(2)} ` +
        `available, $${paymentAmount.toFixed(2)} needed for coupon`
      );
    }

    // Check for duplicate payment on same date
    const dupCheck = await pool.query(
      `SELECT coupon_payment_id FROM coupon_payments
       WHERE bond_id = $1 AND coupon_date = $2 AND status IN ('paid','processing')`,
      [bondId, couponDate]
    );
    if (dupCheck.rows.length > 0) {
      throw new Error(`Coupon already paid/processing for ${couponDate}: ${dupCheck.rows[0].coupon_payment_id}`);
    }

    // 2. Get bondholders
    const bondholders = await CouponService.getBondholders(bondId);
    if (!bondholders.length) {
      throw new Error('No bondholders with bank details found. Register investors in CRM first.');
    }

    // 3. Compute proportional allocation
    const totalSubscription = bondholders.reduce(
      (sum, bh) => sum + parseFloat(bh.subscription_amount || 0), 0
    );

    const entries = [];
    const skipped = [];

    for (const bh of bondholders) {
      if (!bh.routing_number || !bh.account_number) {
        skipped.push({ name: `${bh.first_name} ${bh.last_name}`, reason: 'Missing bank details' });
        continue;
      }

      const proportion = totalSubscription > 0
        ? parseFloat(bh.subscription_amount || 0) / totalSubscription
        : 1 / bondholders.length;

      const bhAmount = Math.round(paymentAmount * proportion * 100); // cents

      entries.push({
        receivingRouting: bh.routing_number,
        accountNumber: bh.account_number,
        amountCents: bhAmount,
        transactionCode: bh.bank_account_type === 'savings' ? '32' : '22',
        individualId: bh.contact_id.substring(0, 15),
        individualName: `${bh.first_name} ${bh.last_name}`.substring(0, 22),
        memo: `Coupon ${couponDate} ${metrics.bond_name}`,
      });
    }

    if (!entries.length) {
      throw new Error(`All bondholders skipped: ${skipped.map(s => s.name + ' (' + s.reason + ')').join(', ')}`);
    }

    // Generate coupon payment ID
    const couponPaymentId = `CPN-${bondId}-${couponDate.replace(/-/g, '')}`;

    // Record as processing
    await pool.query(
      `INSERT INTO coupon_payments (coupon_payment_id, bond_id, coupon_date, amount, status, bondholders_paid, bondholders_skipped)
       VALUES ($1, $2, $3, $4, 'processing', $5, $6)
       ON CONFLICT (coupon_payment_id) DO UPDATE SET status = 'processing', updated_at = NOW()`,
      [couponPaymentId, bondId, couponDate, paymentAmount, entries.length, skipped.length]
    );

    try {
      // 4. Create ACH batch with GL entry
      const effectiveDate = new Date().toISOString().split('T')[0];
      const batchResult = await PaymentOrchestrator.createDisbursementWithAccounting({
        entries,
        effectiveDate,
        secCode: 'CCD',
        description: `COUPON ${metrics.bond_name}`,
        paymentType: 'interest_payment',
        createdBy: 'coupon-service',
      });

      // 5. Reduce accrued interest on the bond
      const payResult = await BondEngine.payInterest(bondId, paymentAmount);

      // 6. Update coupon payment record
      await pool.query(
        `UPDATE coupon_payments
         SET status = 'paid', ach_batch_id = $1,
             journal_entry_id = $2, updated_at = NOW()
         WHERE coupon_payment_id = $3`,
        [
          batchResult.batch.batch_id,
          batchResult.journal_entry ? batchResult.journal_entry.entry_id : null,
          couponPaymentId,
        ]
      );

      // 7. Auto-transmit the batch
      let transmitResult = null;
      if (opts.autoTransmit !== false) {
        try {
          const { ACHEngine } = require('../ach/achEngine');
          transmitResult = await ACHEngine.transmitBatch(batchResult.batch.batch_id);
        } catch (txErr) {
          console.warn('[CouponService] Auto-transmit failed (batch still created):', txErr.message);
        }
      }

      return {
        coupon_payment_id: couponPaymentId,
        bond_id: bondId,
        bond_name: metrics.bond_name,
        coupon_date: couponDate,
        payment_amount: paymentAmount,
        bondholders_paid: entries.length,
        bondholders_skipped: skipped,
        ach_batch_id: batchResult.batch.batch_id,
        journal_entry: batchResult.journal_entry ? { entry_id: batchResult.journal_entry.entry_id } : null,
        accrued_before: metrics.accrued_interest_total,
        accrued_after: payResult.remaining_accrued,
        transmitted: !!transmitResult,
        transmit_result: transmitResult,
        status: 'paid',
      };
    } catch (err) {
      // Mark as failed
      await pool.query(
        `UPDATE coupon_payments SET status = 'failed', error_message = $1, updated_at = NOW()
         WHERE coupon_payment_id = $2`,
        [err.message, couponPaymentId]
      );
      throw err;
    }
  }

  /**
   * Get coupon payment history for a bond.
   */
  static async getCouponPayments(bondId, { limit } = {}) {
    const result = await pool.query(
      `SELECT * FROM coupon_payments
       WHERE bond_id = $1
       ORDER BY coupon_date DESC
       LIMIT $2`,
      [bondId, limit || 50]
    );
    return result.rows;
  }

  /**
   * Get coupon schedule — upcoming and past coupons.
   */
  static async getCouponSchedule(bondId) {
    const metrics = await LiveBondEngine.getBondLiveMetrics(bondId);
    const payments = await CouponService.getCouponPayments(bondId, { limit: 12 });

    return {
      bond_id: bondId,
      bond_name: metrics.bond_name,
      coupon_rate_pct: metrics.coupon_rate_pct,
      payment_freq: metrics.payment_freq,
      coupon_per_period: metrics.coupon_per_period,
      annual_coupon_income: metrics.annual_coupon_income,
      next_coupon_date: metrics.next_coupon_date,
      accrued_interest_total: metrics.accrued_interest_total,
      daily_accrual: metrics.daily_accrual,
      can_pay_coupon: metrics.accrued_interest_total >= metrics.coupon_per_period,
      total_interest_paid: metrics.total_interest_paid,
      recent_payments: payments,
    };
  }

  /**
   * Check if any bonds have a coupon due today and auto-deposit.
   * Called by the scheduled job.
   */
  static async checkAndPayDueCoupons() {
    await CouponService.ensureTable();

    const bonds = await pool.query(
      `SELECT b.id, b.bond_name FROM bonds b WHERE b.status = 'active'`
    );

    const results = [];
    const today = new Date().toISOString().split('T')[0];

    for (const bond of bonds.rows) {
      try {
        const metrics = await LiveBondEngine.getBondLiveMetrics(bond.id);
        const nextCoupon = metrics.next_coupon_date;

        if (nextCoupon === today) {
          // Check if already paid
          const existing = await pool.query(
            `SELECT coupon_payment_id FROM coupon_payments
             WHERE bond_id = $1 AND coupon_date = $2 AND status IN ('paid','processing')`,
            [bond.id, today]
          );

          if (existing.rows.length === 0 && metrics.accrued_interest_total >= metrics.coupon_per_period) {
            console.log(`[CouponService] Coupon due today for ${bond.bond_name} — depositing $${metrics.coupon_per_period}`);
            const result = await CouponService.depositCoupon(bond.id, {
              couponDate: today,
            });
            results.push({ bond: bond.bond_name, status: 'paid', result });
          } else if (existing.rows.length > 0) {
            results.push({ bond: bond.bond_name, status: 'already_paid' });
          } else {
            results.push({
              bond: bond.bond_name,
              status: 'insufficient_accrual',
              accrued: metrics.accrued_interest_total,
              needed: metrics.coupon_per_period,
            });
          }
        } else {
          results.push({ bond: bond.bond_name, status: 'not_due', next_coupon: nextCoupon });
        }
      } catch (err) {
        results.push({ bond: bond.bond_name, status: 'error', error: err.message });
      }
    }

    return { checked_at: new Date().toISOString(), bonds_checked: bonds.rows.length, results };
  }

  /**
   * Schedule the coupon payment check job.
   * Runs every 6 hours to catch coupon dates.
   */
  static scheduleCouponJob() {
    const runCheck = async () => {
      try {
        const result = await CouponService.checkAndPayDueCoupons();
        const paid = result.results.filter(r => r.status === 'paid');
        if (paid.length > 0) {
          console.log(`[CouponService] Auto-deposited ${paid.length} coupon(s)`);
        }
      } catch (err) {
        console.error('[CouponService] Coupon check job error:', err.message);
      }
    };

    // Run 10s after startup, then every 6 hours
    setTimeout(runCheck, 10000);
    setInterval(runCheck, 6 * 60 * 60 * 1000);
    console.log('[CouponService] Coupon payment check job scheduled (startup + 6h interval)');
  }
}

module.exports = { CouponService };
