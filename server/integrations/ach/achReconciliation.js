'use strict';

/**
 * ACH Settlement Reconciliation — DLB Trust Platform
 *
 * Compares bank-reported settled items against local batches and updates
 * settled_at, status, and summary reporting. Runs as a reconciliation job
 * that can be triggered on-demand or scheduled.
 *
 * Settlement data can come from:
 *   - Bank settlement reports (CSV/fixed-width)
 *   - API responses from the bank
 *   - Manual entry for reconciliation
 */

const pool = require('../bonds/pgPool');
const { ACHEngine } = require('./achEngine');

class ACHReconciliation {

  /**
   * Run a reconciliation job comparing bank-reported settlements against local batches.
   *
   * @param {Object} opts
   * @param {Array} opts.settledItems - [{ batchId, settlementDate, settledAmountCents, entries? }]
   * @param {Array} opts.returnedItems - [{ batchId, returnCode, returnReason, entries }]
   * @returns {Object} reconciliation summary
   */
  static async runReconciliation(opts = {}) {
    const { settledItems = [], returnedItems = [] } = opts;
    const reconciliationId = 'RECON-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();

    // Start reconciliation record
    await pool.query(
      `INSERT INTO ach_reconciliations
        (reconciliation_id, run_date, status)
       VALUES ($1, NOW(), 'running')`,
      [reconciliationId]
    );

    let batchesChecked = 0;
    let batchesSettled = 0;
    let batchesReturned = 0;
    let entriesSettled = 0;
    let entriesReturned = 0;
    let totalSettledCents = 0;
    let totalReturnedCents = 0;
    const discrepancies = [];

    try {
      // Process settled items
      for (const item of settledItems) {
        batchesChecked++;
        const batch = await ACHEngine.getBatch(item.batchId);
        if (!batch) {
          discrepancies.push(`Batch ${item.batchId} not found in local records`);
          continue;
        }

        // Verify amounts match
        if (item.settledAmountCents && item.settledAmountCents !== batch.total_amount_cents) {
          discrepancies.push(
            `Amount mismatch for ${item.batchId}: local=${batch.total_amount_cents}, bank=${item.settledAmountCents}`
          );
        }

        // Settle the batch if not already settled
        if (['transmitted', 'accepted'].includes(batch.status)) {
          await ACHEngine.settleBatch(item.batchId, {
            settlementDate: item.settlementDate,
          });
          batchesSettled++;
          totalSettledCents += batch.total_amount_cents;

          // Count entries
          const entryCount = await pool.query(
            `SELECT COUNT(*) as count FROM ach_entries WHERE batch_id = $1 AND status = 'settled'`,
            [item.batchId]
          );
          entriesSettled += parseInt(entryCount.rows[0].count, 10);
        } else if (batch.status === 'settled') {
          // Already settled — verify date matches
          if (item.settlementDate && batch.settlement_date &&
              item.settlementDate !== batch.settlement_date.toISOString().split('T')[0]) {
            discrepancies.push(
              `Settlement date mismatch for ${item.batchId}: local=${batch.settlement_date}, bank=${item.settlementDate}`
            );
          }
        }
      }

      // Process returned items
      for (const item of returnedItems) {
        batchesChecked++;
        const batch = await ACHEngine.getBatch(item.batchId);
        if (!batch) {
          discrepancies.push(`Batch ${item.batchId} not found in local records`);
          continue;
        }

        if (item.entries && item.entries.length) {
          const result = await ACHEngine.processReturns(item.batchId, item.entries, {
            returnFileRef: `recon:${reconciliationId}`,
          });
          entriesReturned += result.returns_processed;
          if (result.all_entries_returned) batchesReturned++;

          for (const ret of result.returns) {
            totalReturnedCents += parseInt(ret.return_amount_cents || 0, 10);
          }
        }
      }

      // Auto-settle: check for batches past their effective date that are still accepted/transmitted
      const autoSettleCandidates = await pool.query(
        `SELECT * FROM ach_batches
         WHERE status IN ('accepted', 'transmitted')
           AND effective_date < CURRENT_DATE - INTERVAL '2 days'
         ORDER BY effective_date ASC`
      );

      for (const candidate of autoSettleCandidates.rows) {
        // Only auto-settle if no explicit bank data contradicts
        const hasReturn = await pool.query(
          'SELECT COUNT(*) as count FROM ach_returns WHERE batch_id = $1',
          [candidate.batch_id]
        );
        if (parseInt(hasReturn.rows[0].count, 10) === 0) {
          batchesChecked++;
          // Don't auto-settle without explicit bank confirmation — just flag
          discrepancies.push(
            `Batch ${candidate.batch_id} past effective date (${candidate.effective_date}) but no settlement confirmation received`
          );
        }
      }

      // Complete reconciliation record
      await pool.query(
        `UPDATE ach_reconciliations
         SET batches_checked = $2, batches_settled = $3, batches_returned = $4,
             entries_settled = $5, entries_returned = $6,
             total_settled_cents = $7, total_returned_cents = $8,
             discrepancies = $9, status = 'completed', completed_at = NOW()
         WHERE reconciliation_id = $1`,
        [reconciliationId, batchesChecked, batchesSettled, batchesReturned,
         entriesSettled, entriesReturned, totalSettledCents, totalReturnedCents,
         discrepancies.length ? JSON.stringify(discrepancies) : null]
      );

      return {
        reconciliation_id: reconciliationId,
        batches_checked: batchesChecked,
        batches_settled: batchesSettled,
        batches_returned: batchesReturned,
        entries_settled: entriesSettled,
        entries_returned: entriesReturned,
        total_settled_cents: totalSettledCents,
        total_returned_cents: totalReturnedCents,
        discrepancies,
        status: 'completed',
      };
    } catch (err) {
      await pool.query(
        `UPDATE ach_reconciliations SET status = 'failed', discrepancies = $2, completed_at = NOW()
         WHERE reconciliation_id = $1`,
        [reconciliationId, JSON.stringify([err.message, ...discrepancies])]
      );
      throw err;
    }
  }

  /**
   * Get reconciliation history.
   */
  static async listReconciliations({ limit = 20, offset = 0 } = {}) {
    const result = await pool.query(
      `SELECT * FROM ach_reconciliations ORDER BY run_date DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return result.rows;
  }

  /**
   * Get a specific reconciliation run by ID.
   */
  static async getReconciliation(reconciliationId) {
    const result = await pool.query(
      'SELECT * FROM ach_reconciliations WHERE reconciliation_id = $1',
      [reconciliationId]
    );
    if (!result.rows.length) return null;
    const recon = result.rows[0];
    if (recon.discrepancies && typeof recon.discrepancies === 'string') {
      try { recon.discrepancies = JSON.parse(recon.discrepancies); } catch (e) { /* keep as string */ }
    }
    return recon;
  }

  /**
   * Get settlement status overview for dashboard.
   */
  static async getSettlementOverview() {
    const [
      awaitingSettlement,
      settledThisWeek,
      returnedThisWeek,
      totalSettledCents,
      totalReturnedCents,
      recentReconciliations,
    ] = await Promise.all([
      pool.query("SELECT COUNT(*) as count FROM ach_batches WHERE status IN ('transmitted', 'accepted')"),
      pool.query("SELECT COUNT(*) as count FROM ach_batches WHERE status = 'settled' AND settled_at > NOW() - INTERVAL '7 days'"),
      pool.query("SELECT COUNT(*) as count FROM ach_batches WHERE status = 'returned' AND returned_at > NOW() - INTERVAL '7 days'"),
      pool.query("SELECT COALESCE(SUM(total_amount_cents), 0) as total FROM ach_batches WHERE status = 'settled'"),
      pool.query("SELECT COALESCE(SUM(return_amount_cents), 0) as total FROM ach_returns WHERE processed_at > NOW() - INTERVAL '30 days'"),
      pool.query('SELECT * FROM ach_reconciliations ORDER BY run_date DESC LIMIT 5'),
    ]);

    return {
      awaiting_settlement: parseInt(awaitingSettlement.rows[0].count, 10),
      settled_this_week: parseInt(settledThisWeek.rows[0].count, 10),
      returned_this_week: parseInt(returnedThisWeek.rows[0].count, 10),
      total_settled_cents: parseInt(totalSettledCents.rows[0].total, 10),
      total_returned_cents: parseInt(totalReturnedCents.rows[0].total, 10),
      recent_reconciliations: recentReconciliations.rows,
    };
  }
}

module.exports = { ACHReconciliation };
