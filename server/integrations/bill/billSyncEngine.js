'use strict';

/**
 * BILL Cash Sync Engine — DLB Trust Platform
 *
 * Programmatic real-time sync with BILL Cash Account:
 *  - Polling sync: fetches BILL balance + transactions, reconciles with GL 1050
 *  - Settlement tracking: matches pending deposits to BILL confirmations
 *  - Auto-reconciliation: flags balance mismatches between BILL and GL
 *  - Sync history with audit trail
 */

const pool = require('../bonds/pgPool');
const billClient = require('./billClient');

const BILL_CASH_GL = '1050';
const TRUST_CASH_GL = '1000';

class BillSyncEngine {

  // ═══════════════════════════════════════════════════════════════════════════
  //  TABLE SETUP
  // ═══════════════════════════════════════════════════════════════════════════

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bill_sync_log (
        id                SERIAL PRIMARY KEY,
        sync_id           TEXT UNIQUE NOT NULL,
        sync_type         TEXT NOT NULL DEFAULT 'poll'
                            CHECK (sync_type IN ('poll','settlement','reconcile','full')),
        status            TEXT NOT NULL DEFAULT 'running'
                            CHECK (status IN ('running','completed','failed')),
        bill_balance      NUMERIC(18,2),
        gl_balance        NUMERIC(18,2),
        balance_matched   BOOLEAN,
        deposits_synced   INTEGER DEFAULT 0,
        settlements_found INTEGER DEFAULT 0,
        discrepancies     INTEGER DEFAULT 0,
        details           TEXT,
        error_message     TEXT,
        started_at        TIMESTAMPTZ DEFAULT NOW(),
        completed_at      TIMESTAMPTZ,
        triggered_by      TEXT DEFAULT 'system'
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bill_settlement_queue (
        id                SERIAL PRIMARY KEY,
        settlement_id     TEXT UNIQUE NOT NULL,
        deposit_ref       TEXT NOT NULL,
        deposit_method    TEXT NOT NULL,
        amount            NUMERIC(18,2) NOT NULL,
        status            TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','clearing','settled','failed','expired')),
        bill_txn_id       TEXT,
        bill_confirmed_at TIMESTAMPTZ,
        expected_settle   TIMESTAMPTZ,
        actual_settle     TIMESTAMPTZ,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SYNC ID GENERATION
  // ═══════════════════════════════════════════════════════════════════════════

  static generateSyncId() {
    var ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    var seq = Math.random().toString(36).slice(2, 6).toUpperCase();
    return 'BSYNC-' + ts + '-' + seq;
  }

  static generateSettlementId() {
    var ts = Date.now().toString(36).toUpperCase();
    var seq = Math.random().toString(36).slice(2, 6).toUpperCase();
    return 'BSTL-' + ts + '-' + seq;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  FULL SYNC (poll + settlement + reconcile)
  // ═══════════════════════════════════════════════════════════════════════════

  static async fullSync(triggeredBy) {
    var syncId = BillSyncEngine.generateSyncId();
    await pool.query(
      `INSERT INTO bill_sync_log (sync_id, sync_type, triggered_by) VALUES ($1, 'full', $2)`,
      [syncId, triggeredBy || 'system']
    );

    var result = {
      sync_id: syncId,
      bill_balance: null,
      gl_balance: null,
      balance_matched: false,
      deposits_synced: 0,
      settlements_found: 0,
      discrepancies: 0,
      details: {},
    };

    try {
      // 1. Poll BILL for current balance
      var balanceResult = await BillSyncEngine._pollBalance();
      result.bill_balance = balanceResult.bill_balance;
      result.gl_balance = balanceResult.gl_balance;
      result.balance_matched = balanceResult.matched;

      // 2. Sync transactions from BILL
      var txnResult = await BillSyncEngine._syncTransactions();
      result.deposits_synced = txnResult.synced;
      result.details.transactions = txnResult;

      // 3. Process settlement queue
      var settlementResult = await BillSyncEngine._processSettlements();
      result.settlements_found = settlementResult.settled;
      result.details.settlements = settlementResult;

      // 4. Reconcile
      var reconResult = await BillSyncEngine._reconcile();
      result.discrepancies = reconResult.discrepancies;
      result.details.reconciliation = reconResult;

      // Update sync log
      await pool.query(`
        UPDATE bill_sync_log SET status = 'completed', completed_at = NOW(),
          bill_balance = $2, gl_balance = $3, balance_matched = $4,
          deposits_synced = $5, settlements_found = $6, discrepancies = $7,
          details = $8
        WHERE sync_id = $1
      `, [
        syncId, result.bill_balance, result.gl_balance, result.balance_matched,
        result.deposits_synced, result.settlements_found, result.discrepancies,
        JSON.stringify(result.details),
      ]);

      return result;

    } catch (err) {
      await pool.query(
        `UPDATE bill_sync_log SET status = 'failed', completed_at = NOW(), error_message = $2 WHERE sync_id = $1`,
        [syncId, err.message]
      );
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  POLL BALANCE
  // ═══════════════════════════════════════════════════════════════════════════

  static async _pollBalance() {
    var billBalance = 0;
    try {
      var balanceData = await billClient.getBankBalance();
      if (balanceData && typeof balanceData === 'object') {
        if (balanceData.totalBalance !== undefined) {
          billBalance = parseFloat(balanceData.totalBalance) || 0;
        } else if (Array.isArray(balanceData)) {
          balanceData.forEach(function(b) {
            billBalance += parseFloat(b.balance || b.amount || 0);
          });
        }
      }
    } catch (e) {
      console.warn('[BillSync] BILL balance fetch failed:', e.message);
    }

    // Get GL 1050 balance
    var glBalance = 0;
    try {
      var res = await pool.query(`
        SELECT COALESCE(SUM(debit_amount), 0) - COALESCE(SUM(credit_amount), 0) as balance
        FROM trust_journal_lines jl
        JOIN trust_journal_entries je ON je.id = jl.journal_entry_id
        WHERE jl.account_code = $1 AND je.status = 'posted'
      `, [BILL_CASH_GL]);
      glBalance = parseFloat(res.rows[0].balance) || 0;
    } catch (e) {
      console.warn('[BillSync] GL balance query failed:', e.message);
    }

    var diff = Math.abs(billBalance - glBalance);
    return {
      bill_balance: billBalance,
      gl_balance: glBalance,
      difference: diff,
      matched: diff < 0.01,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SYNC TRANSACTIONS FROM BILL
  // ═══════════════════════════════════════════════════════════════════════════

  static async _syncTransactions() {
    var synced = 0;
    var received = [];
    var sent = [];

    try {
      received = await billClient.listReceivedPayments(50);
    } catch (e) {
      console.warn('[BillSync] List received payments failed:', e.message);
    }
    try {
      sent = await billClient.listSentPayments(50);
    } catch (e) {
      console.warn('[BillSync] List sent payments failed:', e.message);
    }

    // Match received payments to pending settlements
    for (var i = 0; i < received.length; i++) {
      var rp = received[i];
      try {
        var existing = await pool.query(
          `SELECT id FROM bill_settlement_queue WHERE bill_txn_id = $1`, [rp.id]
        );
        if (existing.rowCount === 0) {
          // Check if this matches a pending deposit
          var pending = await pool.query(
            `SELECT * FROM bill_settlement_queue
             WHERE status IN ('pending', 'clearing')
               AND ABS(amount - $1) < 0.01
             ORDER BY created_at ASC LIMIT 1`,
            [parseFloat(rp.amount)]
          );
          if (pending.rowCount > 0) {
            await pool.query(`
              UPDATE bill_settlement_queue SET
                status = 'settled', bill_txn_id = $2,
                bill_confirmed_at = $3, actual_settle = NOW(), updated_at = NOW()
              WHERE settlement_id = $1
            `, [pending.rows[0].settlement_id, rp.id, rp.createdTime || rp.paymentDate || new Date()]);
            synced++;
          }
        }
      } catch (e) {
        console.warn('[BillSync] Transaction match failed:', e.message);
      }
    }

    return {
      received_count: received.length,
      sent_count: sent.length,
      synced: synced,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PROCESS SETTLEMENT QUEUE
  // ═══════════════════════════════════════════════════════════════════════════

  static async _processSettlements() {
    var settled = 0;
    var expired = 0;

    // Move pending→clearing for items older than 30 min (funds in transit)
    try {
      var res = await pool.query(`
        UPDATE bill_settlement_queue SET status = 'clearing', updated_at = NOW()
        WHERE status = 'pending' AND created_at < NOW() - INTERVAL '30 minutes'
        RETURNING settlement_id
      `);
      // 'clearing' count for info
    } catch (e) {
      console.warn('[BillSync] Settlement clearing update failed:', e.message);
    }

    // Expire items older than 5 days that haven't settled
    try {
      var expRes = await pool.query(`
        UPDATE bill_settlement_queue SET status = 'expired', updated_at = NOW()
        WHERE status IN ('pending', 'clearing') AND created_at < NOW() - INTERVAL '5 days'
        RETURNING settlement_id
      `);
      expired = expRes.rowCount;
    } catch (e) {
      console.warn('[BillSync] Settlement expiry update failed:', e.message);
    }

    // Count current settled
    try {
      var sRes = await pool.query(
        `SELECT COUNT(*) as cnt FROM bill_settlement_queue WHERE status = 'settled' AND actual_settle > NOW() - INTERVAL '24 hours'`
      );
      settled = parseInt(sRes.rows[0].cnt);
    } catch (e) {}

    return { settled: settled, expired: expired };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RECONCILE
  // ═══════════════════════════════════════════════════════════════════════════

  static async _reconcile() {
    var discrepancies = 0;

    // Count pending deposits that should have settled by now (ACH: >2 days, Wire: >1 day)
    try {
      var achStale = await pool.query(`
        SELECT COUNT(*) as cnt FROM bill_settlement_queue
        WHERE deposit_method = 'ach' AND status IN ('pending', 'clearing')
          AND created_at < NOW() - INTERVAL '2 days'
      `);
      var wireStale = await pool.query(`
        SELECT COUNT(*) as cnt FROM bill_settlement_queue
        WHERE deposit_method = 'wire' AND status IN ('pending', 'clearing')
          AND created_at < NOW() - INTERVAL '1 day'
      `);
      discrepancies = parseInt(achStale.rows[0].cnt) + parseInt(wireStale.rows[0].cnt);
    } catch (e) {
      console.warn('[BillSync] Reconciliation query failed:', e.message);
    }

    return { discrepancies: discrepancies };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  QUEUE DEPOSIT FOR SETTLEMENT TRACKING
  // ═══════════════════════════════════════════════════════════════════════════

  static async queueForSettlement(depositRef, method, amount) {
    var settlementId = BillSyncEngine.generateSettlementId();
    // Calculate expected settlement time
    var expectedSettle = new Date();
    if (method === 'ach') {
      expectedSettle.setDate(expectedSettle.getDate() + 2); // ACH: 1-2 business days
    } else if (method === 'wire') {
      expectedSettle.setHours(expectedSettle.getHours() + 4); // Wire: same day
    } else {
      expectedSettle.setHours(expectedSettle.getHours() + 1); // Direct: near-instant
    }

    await pool.query(`
      INSERT INTO bill_settlement_queue
        (settlement_id, deposit_ref, deposit_method, amount, expected_settle)
      VALUES ($1, $2, $3, $4, $5)
    `, [settlementId, depositRef, method, amount, expectedSettle]);

    return {
      settlement_id: settlementId,
      expected_settle: expectedSettle,
      status: 'pending',
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DASHBOARD DATA
  // ═══════════════════════════════════════════════════════════════════════════

  static async getDashboard() {
    var [
      lastSync,
      syncHistory,
      settlementQueue,
      settlementStats,
    ] = await Promise.all([
      pool.query(`SELECT * FROM bill_sync_log ORDER BY started_at DESC LIMIT 1`),
      pool.query(`SELECT * FROM bill_sync_log ORDER BY started_at DESC LIMIT 10`),
      pool.query(`
        SELECT * FROM bill_settlement_queue
        WHERE status IN ('pending', 'clearing')
        ORDER BY created_at ASC
      `),
      pool.query(`
        SELECT
          COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
          COUNT(CASE WHEN status = 'clearing' THEN 1 END) as clearing,
          COUNT(CASE WHEN status = 'settled' THEN 1 END) as settled,
          COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
          COUNT(CASE WHEN status = 'expired' THEN 1 END) as expired,
          COALESCE(SUM(CASE WHEN status = 'settled' THEN amount ELSE 0 END), 0) as total_settled,
          COALESCE(SUM(CASE WHEN status IN ('pending', 'clearing') THEN amount ELSE 0 END), 0) as total_pending
        FROM bill_settlement_queue
      `),
    ]);

    var last = lastSync.rows[0] || null;
    var stats = settlementStats.rows[0] || {};

    return {
      last_sync: last ? {
        sync_id: last.sync_id,
        status: last.status,
        bill_balance: last.bill_balance,
        gl_balance: last.gl_balance,
        balance_matched: last.balance_matched,
        deposits_synced: last.deposits_synced,
        settlements_found: last.settlements_found,
        discrepancies: last.discrepancies,
        started_at: last.started_at,
        completed_at: last.completed_at,
        triggered_by: last.triggered_by,
      } : null,
      sync_history: syncHistory.rows,
      settlement_queue: settlementQueue.rows,
      settlement_stats: {
        pending: parseInt(stats.pending) || 0,
        clearing: parseInt(stats.clearing) || 0,
        settled: parseInt(stats.settled) || 0,
        failed: parseInt(stats.failed) || 0,
        expired: parseInt(stats.expired) || 0,
        total_settled: parseFloat(stats.total_settled) || 0,
        total_pending: parseFloat(stats.total_pending) || 0,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  AUTO-SYNC INTERVAL
  // ═══════════════════════════════════════════════════════════════════════════

  static _syncInterval = null;

  static startAutoSync(intervalMs) {
    if (BillSyncEngine._syncInterval) return;
    var interval = intervalMs || 5 * 60 * 1000; // default 5 minutes
    console.log('[BillSync] Auto-sync started, interval:', interval / 1000, 'seconds');
    BillSyncEngine._syncInterval = setInterval(async function() {
      try {
        await BillSyncEngine.fullSync('auto');
        console.log('[BillSync] Auto-sync completed');
      } catch (e) {
        console.warn('[BillSync] Auto-sync failed:', e.message);
      }
    }, interval);
  }

  static stopAutoSync() {
    if (BillSyncEngine._syncInterval) {
      clearInterval(BillSyncEngine._syncInterval);
      BillSyncEngine._syncInterval = null;
      console.log('[BillSync] Auto-sync stopped');
    }
  }
}

module.exports = { BillSyncEngine };
