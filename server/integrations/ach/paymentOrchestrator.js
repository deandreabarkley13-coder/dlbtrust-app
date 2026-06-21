'use strict';

/**
 * Payment Orchestrator — DLB Trust Platform
 *
 * Bridges payment operations (ACH disbursements, trust distributions, K-1 payments)
 * to trust accounting journal entries and Fineract GL posting.
 *
 * Every outbound payment creates:
 * 1. An ACH batch (NACHA file) via ACHEngine
 * 2. A trust journal entry (DR expense/distribution, CR cash) via TrustAccountingEngine
 * 3. A cashflow event for reporting
 * 4. (optional) Fineract GL posting
 *
 * Account codes used:
 *   1000 — Cash & Equivalents (credit on outflow)
 *   5100 — Trust Distributions (debit for beneficiary distributions)
 *   5200 — Operating Expenses / Vendor Payments (debit)
 *   4100 — Interest Income / Fee Income (credit for interest received)
 */

const pool = require('../bonds/pgPool');
const { ACHEngine } = require('./achEngine');
const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');

const ACCOUNT_CODES = {
  CASH: '1000',
  DISTRIBUTIONS: '5100',
  EXPENSES: '5200',
  INTEREST_INCOME: '4100',
  ACCRUED_INTEREST: '1200',
};

class PaymentOrchestrator {

  /**
   * Create a disbursement batch with full accounting integration.
   * Creates the ACH batch AND posts a journal entry for the payment.
   *
   * @param {Object} opts
   * @param {Array} opts.entries - ACH entry details
   * @param {string} opts.effectiveDate - payment date
   * @param {string} opts.secCode - SEC code (PPD/CCD)
   * @param {string} opts.description - batch description
   * @param {string} opts.paymentType - trust_distribution|vendor_payment|interest_payment|principal_return
   * @param {string} opts.createdBy - who initiated
   * @returns {Object} { batch, journal_entry }
   */
  static async createDisbursementWithAccounting(opts) {
    const { entries, effectiveDate, secCode, description, paymentType, createdBy } = opts;

    // 1. Create the ACH batch (NACHA file generation)
    const batch = await ACHEngine.createBatch(
      { effectiveDate, secCode, description, createdBy },
      entries
    );

    const totalCents = entries.reduce((sum, e) => sum + Number(e.amountCents || 0), 0);
    const totalDollars = totalCents / 100;
    const batchId = batch.batch_id;

    // 2. Determine debit account based on payment type
    let debitAccountCode;
    let journalDescription;
    switch (paymentType) {
      case 'trust_distribution':
        debitAccountCode = ACCOUNT_CODES.DISTRIBUTIONS;
        journalDescription = `Trust distribution: ${description || 'Beneficiary payment'}`;
        break;
      case 'interest_payment':
        debitAccountCode = ACCOUNT_CODES.ACCRUED_INTEREST;
        journalDescription = `Interest payment: ${description || 'Bond interest'}`;
        break;
      case 'vendor_payment':
      case 'principal_return':
      default:
        debitAccountCode = ACCOUNT_CODES.EXPENSES;
        journalDescription = `${(paymentType || 'payment').replace(/_/g, ' ')}: ${description || 'Payment'}`;
        break;
    }

    // 3. Post trust journal entry (DR expense/distribution, CR cash)
    let journalEntry = null;
    try {
      journalEntry = await TrustAccountingEngine.postJournalEntry({
        entryDate: effectiveDate || new Date(),
        description: journalDescription,
        lines: [
          {
            accountCode: debitAccountCode,
            debitAmount: totalDollars,
            creditAmount: 0,
            memo: `ACH batch ${batchId}: ${description || paymentType}`,
          },
          {
            accountCode: ACCOUNT_CODES.CASH,
            debitAmount: 0,
            creditAmount: totalDollars,
            memo: `ACH outflow: ${batchId}`,
          },
        ],
        referenceType: 'ach_disbursement',
        referenceId: batchId,
        postedBy: createdBy || 'system',
      });
    } catch (err) {
      console.warn('[PaymentOrchestrator] Journal entry failed (batch still created):', err.message);
    }

    // 4. Record cashflow event
    try {
      await pool.query(
        `INSERT INTO cashflow_events
           (event_type, category, amount, direction, description, event_date, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [
          paymentType === 'trust_distribution' ? 'distribution' : 'other',
          paymentType === 'trust_distribution' ? 'financing' : 'operating',
          totalDollars,
          'outflow',
          journalDescription,
          effectiveDate || new Date(),
        ]
      );
    } catch (err) {
      console.warn('[PaymentOrchestrator] Cashflow event failed:', err.message);
    }

    return {
      batch,
      journal_entry: journalEntry,
      accounting_integrated: !!journalEntry,
      total_amount: totalDollars,
    };
  }

  /**
   * Create a K-1 distribution batch — disburse K-1 amounts to beneficiaries via ACH.
   *
   * @param {Object} opts
   * @param {string} opts.returnId - tax return ID
   * @param {number} opts.taxYear - tax year
   * @param {string} opts.effectiveDate - payment date
   * @param {string} opts.createdBy - who initiated
   * @returns {Object} { batch, journal_entry, beneficiaries_paid }
   */
  static async disburseK1(opts) {
    const { returnId, taxYear, effectiveDate, createdBy } = opts;

    // Get K-1 schedules for the return
    const k1Result = await pool.query(
      `SELECT k.*, c.first_name, c.last_name, c.email,
              c.routing_number, c.account_number, c.bank_account_type
       FROM k1_schedules k
       JOIN crm_contacts c ON k.beneficiary_contact_id = c.contact_id
       WHERE k.return_id = $1 AND k.status = 'generated'`,
      [returnId]
    );

    if (!k1Result.rows.length) {
      throw new Error('No generated K-1 schedules found for this return');
    }

    const entries = [];
    const skipped = [];

    for (const k1 of k1Result.rows) {
      if (!k1.routing_number || !k1.account_number) {
        skipped.push({
          name: `${k1.first_name} ${k1.last_name}`,
          reason: 'Missing bank account info',
        });
        continue;
      }

      const distributionAmount = parseFloat(k1.total_income || 0) - parseFloat(k1.total_deductions || 0);
      if (distributionAmount <= 0) {
        skipped.push({
          name: `${k1.first_name} ${k1.last_name}`,
          reason: 'No distributable amount',
        });
        continue;
      }

      entries.push({
        receivingRouting: k1.routing_number,
        accountNumber: k1.account_number,
        amountCents: Math.round(distributionAmount * 100),
        transactionCode: k1.bank_account_type === 'savings' ? '32' : '22',
        individualId: k1.beneficiary_contact_id.substring(0, 15),
        individualName: `${k1.first_name} ${k1.last_name}`.substring(0, 22),
        memo: `K-1 ${taxYear} distribution`,
      });
    }

    if (!entries.length) {
      throw new Error(`No beneficiaries with bank info found. Skipped: ${skipped.map(s => s.name + ' (' + s.reason + ')').join(', ')}`);
    }

    const result = await PaymentOrchestrator.createDisbursementWithAccounting({
      entries,
      effectiveDate: effectiveDate || new Date().toISOString().split('T')[0],
      secCode: 'PPD',
      description: `K1-${taxYear}`,
      paymentType: 'trust_distribution',
      createdBy,
    });

    // Update K-1 statuses to 'distributed'
    const batchId = result.batch.batch_id;
    for (const k1 of k1Result.rows) {
      if (k1.routing_number && k1.account_number) {
        await pool.query(
          `UPDATE k1_schedules SET status = 'distributed', updated_at = NOW()
           WHERE id = $1`,
          [k1.id]
        );
      }
    }

    return {
      ...result,
      beneficiaries_paid: entries.length,
      beneficiaries_skipped: skipped,
      tax_year: taxYear,
      return_id: returnId,
    };
  }

  /**
   * Get payment summary for dashboard display.
   */
  static async getPaymentSummary() {
    const [totalBatches, pendingBatches, transmittedBatches, totalDisbursed, recentPayments] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM ach_batches'),
      pool.query("SELECT COUNT(*) as count FROM ach_batches WHERE status = 'pending'"),
      pool.query("SELECT COUNT(*) as count FROM ach_batches WHERE status = 'transmitted'"),
      pool.query("SELECT COALESCE(SUM(total_amount_cents), 0) as total FROM ach_batches WHERE status = 'transmitted'"),
      pool.query(`SELECT batch_id, entry_description, total_amount_cents, status, entry_count, created_at
                  FROM ach_batches ORDER BY created_at DESC LIMIT 10`),
    ]);

    return {
      total_batches: parseInt(totalBatches.rows[0].count, 10),
      pending_batches: parseInt(pendingBatches.rows[0].count, 10),
      transmitted_batches: parseInt(transmittedBatches.rows[0].count, 10),
      total_disbursed_cents: parseInt(totalDisbursed.rows[0].total, 10),
      total_disbursed_dollars: parseInt(totalDisbursed.rows[0].total, 10) / 100,
      recent_payments: recentPayments.rows,
    };
  }
}

module.exports = { PaymentOrchestrator };
