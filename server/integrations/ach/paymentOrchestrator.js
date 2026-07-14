'use strict';

/**
 * Payment Orchestrator — DLB Trust Platform
 *
 * Routes legacy ACH disbursement calls into canonical payment instructions.
 * Accounting is deferred until bank-confirmed settlement.
 */

const pool = require('../bonds/pgPool');
const { ACHEngine } = require('./achEngine');
const { PaymentHubEngine } = require('../paymentHub/paymentHubEngine');
const { getConfig } = require('../paymentHub/paymentHubConfig');
let WireEngine;
try { WireEngine = require('../wire/wireEngine').WireEngine; } catch (e) { WireEngine = null; }

class PaymentOrchestrator {

  static async createDisbursementWithAccounting(opts) {
    const { entries, effectiveDate, secCode, description, paymentType, createdBy, partnerId } = opts;
    if (!Array.isArray(entries) || !entries.length) throw new Error('At least one payment entry is required');
    const totalCents = entries.reduce((sum, entry) => sum + Number(entry.amountCents || 0), 0);
    const config = getConfig();

    if (config.mode === 'disabled') {
      const batch = await ACHEngine.createBatch(
        { effectiveDate, secCode, description, createdBy, partnerId, nachaConfig: opts.nachaConfig },
        entries
      );
      return {
        batch,
        journal_entry: null,
        accounting_integrated: false,
        accounting_deferred_until_settlement: true,
        total_amount: totalCents / 100,
      };
    }

    const groupId = 'PHG-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
    const intents = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const result = await PaymentHubEngine.createIntent({
        idempotencyKey: `${opts.idempotencyKey || groupId}:${index + 1}`,
        paymentType: paymentType || 'vendor_payment',
        amountCents: Number(entry.amountCents),
        sourceType: opts.sourceSubLedgerId ? 'sub_ledger' : 'trust_account',
        sourceSubLedgerId: opts.sourceSubLedgerId,
        sourceAccountCode: opts.sourceAccountCode || '1000',
        debitAccountCode: opts.debitAccountCode,
        beneficiaryName: entry.individualName || description || 'Beneficiary',
        beneficiaryRouting: entry.receivingRouting,
        beneficiaryAccount: entry.accountNumber,
        beneficiaryAccountType: ['32', '37'].includes(String(entry.transactionCode)) ? 'savings' : 'checking',
        secCode: secCode || 'CCD',
        effectiveDate,
        description: entry.memo || description,
        metadata: { groupId, legacyOrchestrator: true },
      }, createdBy || 'system');
      intents.push(result.intent);
    }

    return {
      batch: {
        batch_id: groupId,
        status: 'pending_approval',
        entry_count: intents.length,
        total_amount_cents: totalCents,
      },
      journal_entry: null,
      accounting_integrated: false,
      accounting_deferred_until_settlement: true,
      payment_intents: intents,
      total_amount: totalCents / 100,
    };
  }

  /**
   * Smart payment routing — automatically chooses ACH or Wire based on amount/urgency.
   * For wire-eligible payments, creates a wire transfer instead of an ACH batch.
   *
   * @param {Object} opts - same as createDisbursementWithAccounting, plus:
   * @param {boolean} opts.urgent - force wire for same-day settlement
   * @param {string} opts.forceChannel - 'ach' or 'wire' to override auto-routing
   * @param {string} opts.beneficiaryRouting - required for wire
   * @param {string} opts.beneficiaryAccount - required for wire
   * @param {string} opts.beneficiaryBankName - optional
   * @returns {Object} { channel, batch|wire, journal_entry, routing_reason }
   */
  static async routePayment(opts) {
    const { entries, urgent, forceChannel } = opts;
    const totalCents = entries.reduce((sum, e) => sum + Number(e.amountCents || 0), 0);

    // Determine channel
    let channel, reason;
    if (forceChannel) {
      channel = forceChannel;
      reason = `Forced to ${forceChannel} by caller`;
    } else if (WireEngine) {
      const routing = WireEngine.routePayment(totalCents, { urgent });
      channel = routing.channel;
      reason = routing.reason;
    } else {
      channel = 'ach';
      reason = 'Wire engine not available — defaulting to ACH';
    }

    if (channel === 'wire' && getConfig().mode !== 'disabled') {
      throw new Error('Wire transmission is blocked while Payment Hub mode is enabled; use a canonical supported connector');
    }

    if (channel === 'wire' && WireEngine) {
      // Route to wire — use first entry as beneficiary (for single-payee wires)
      const entry = entries[0];
      const wire = await WireEngine.initiateWire({
        amountCents: totalCents,
        beneficiaryName: entry.individualName || opts.description || 'Beneficiary',
        beneficiaryRouting: opts.beneficiaryRouting || entry.receivingRouting,
        beneficiaryAccount: opts.beneficiaryAccount || entry.accountNumber,
        beneficiaryBankName: opts.beneficiaryBankName || null,
        paymentType: opts.paymentType || 'trust_distribution',
        purpose: opts.description || 'Trust payment',
        description: opts.description,
        initiatedBy: opts.createdBy || 'system',
        requiresApproval: true,
      });

      return {
        channel: 'wire',
        wire,
        routing_reason: reason,
        total_amount: totalCents / 100,
      };
    }

    // Default: route to ACH
    const result = await PaymentOrchestrator.createDisbursementWithAccounting(opts);
    return {
      channel: 'ach',
      ...result,
      routing_reason: reason,
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
      idempotencyKey: `k1-distribution:${returnId}:${taxYear}`,
    });

    return {
      ...result,
      beneficiaries_paid: 0,
      beneficiaries_queued: entries.length,
      beneficiaries_skipped: skipped,
      tax_year: taxYear,
      return_id: returnId,
    };
  }

  /**
   * Get payment summary for dashboard display.
   * Reports across all lifecycle states: pending, transmitted, accepted, settled, returned.
   */
  static async getPaymentSummary() {
    const [
      totalBatches,
      pendingBatches,
      transmittedBatches,
      acceptedBatches,
      settledBatches,
      returnedBatches,
      failedBatches,
      totalDisbursed,
      totalSettled,
      totalReturned,
      recentPayments,
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM ach_batches'),
      pool.query("SELECT COUNT(*) as count FROM ach_batches WHERE status = 'pending'"),
      pool.query("SELECT COUNT(*) as count FROM ach_batches WHERE status = 'transmitted'"),
      pool.query("SELECT COUNT(*) as count FROM ach_batches WHERE status = 'accepted'"),
      pool.query("SELECT COUNT(*) as count FROM ach_batches WHERE status = 'settled'"),
      pool.query("SELECT COUNT(*) as count FROM ach_batches WHERE status = 'returned'"),
      pool.query("SELECT COUNT(*) as count FROM ach_batches WHERE status = 'failed'"),
      pool.query("SELECT COALESCE(SUM(total_amount_cents), 0) as total FROM ach_batches WHERE status IN ('transmitted','accepted','settled')"),
      pool.query("SELECT COALESCE(SUM(total_amount_cents), 0) as total FROM ach_batches WHERE status = 'settled'"),
      pool.query("SELECT COALESCE(SUM(return_amount_cents), 0) as total FROM ach_returns"),
      pool.query(`SELECT batch_id, entry_description, total_amount_cents, status, entry_count,
                         settled_at, returned_at, return_code, created_at
                  FROM ach_batches ORDER BY created_at DESC LIMIT 10`),
    ]);

    const disbursedCents = parseInt(totalDisbursed.rows[0].total, 10);
    const settledCents = parseInt(totalSettled.rows[0].total, 10);
    const returnedCents = parseInt(totalReturned.rows[0].total, 10);

    return {
      total_batches: parseInt(totalBatches.rows[0].count, 10),
      pending_batches: parseInt(pendingBatches.rows[0].count, 10),
      transmitted_batches: parseInt(transmittedBatches.rows[0].count, 10),
      accepted_batches: parseInt(acceptedBatches.rows[0].count, 10),
      settled_batches: parseInt(settledBatches.rows[0].count, 10),
      returned_batches: parseInt(returnedBatches.rows[0].count, 10),
      failed_batches: parseInt(failedBatches.rows[0].count, 10),
      total_disbursed_cents: disbursedCents,
      total_disbursed_dollars: disbursedCents / 100,
      total_settled_cents: settledCents,
      total_settled_dollars: settledCents / 100,
      total_returned_cents: returnedCents,
      total_returned_dollars: returnedCents / 100,
      settlement_rate: disbursedCents > 0
        ? Math.round((settledCents / disbursedCents) * 10000) / 100
        : 0,
      return_rate: disbursedCents > 0
        ? Math.round((returnedCents / disbursedCents) * 10000) / 100
        : 0,
      recent_payments: recentPayments.rows,
    };
  }
}

module.exports = { PaymentOrchestrator };
