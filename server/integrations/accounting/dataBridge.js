'use strict';

/**
 * DataBridge — Cross-Module Data Flow Engine
 *
 * Bridges the gap between trust accounting, core banking (Fineract GL),
 * cash management, ACH pipeline, wire transfers, bonds, BILL, and tax.
 *
 * Data flow architecture:
 *   Bond accruals/coupons ──┐
 *   ACH settlements ────────┤
 *   Wire transfers ──────────┤──→ Trust Accounting ──→ Fineract GL
 *   BILL deposits/payments ──┤
 *   Cash account activity ───┘
 *
 * Key capabilities:
 *   - Sync bond accrual data into trust journal entries
 *   - Post ACH settlement journal entries automatically
 *   - Reconcile cash account balances with trust accounting
 *   - Sync BILL deposit transactions to trust accounting
 *   - Bidirectional reconciliation: trust accounting ↔ Fineract GL
 *   - Push unsynced trust journal entries to Fineract GL
 *   - Unified data flow dashboard and reconciliation reports
 */

var pool = require('../bonds/pgPool');

// Account code constants (matching trust chart of accounts)
var ACCOUNTS = {
  CASH:              '1000',
  BOND_INVESTMENTS:  '1100',
  ACCOUNTS_RECEIVABLE: '1200',
  ACCRUED_INTEREST:  '1300',
  ACCOUNTS_PAYABLE:  '2000',
  DISTRIBUTIONS_PAYABLE: '2100',
  TRUST_CORPUS:      '3000',
  RETAINED_EARNINGS: '3100',
  INTEREST_INCOME:   '4000',
  COUPON_INCOME:     '4100',
  FEE_INCOME:        '4200',
  PAYMENT_EXPENSE:   '5000',
  OPERATING_EXPENSE: '5100',
  FEE_EXPENSE:       '5200',
};

class DataBridge {

  // ═══════════════════════════════════════════════════════════════════════════
  //  TABLE SETUP
  // ═══════════════════════════════════════════════════════════════════════════

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS data_bridge_sync_log (
        id              SERIAL PRIMARY KEY,
        sync_id         TEXT UNIQUE NOT NULL,
        sync_type       TEXT NOT NULL,
        source_module   TEXT NOT NULL,
        target_module   TEXT NOT NULL,
        items_synced    INTEGER DEFAULT 0,
        items_skipped   INTEGER DEFAULT 0,
        items_failed    INTEGER DEFAULT 0,
        details         JSONB,
        status          TEXT NOT NULL DEFAULT 'completed'
                          CHECK (status IN ('running','completed','failed','partial')),
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS data_bridge_discrepancies (
        id              SERIAL PRIMARY KEY,
        discrepancy_id  TEXT UNIQUE NOT NULL,
        discrepancy_type TEXT NOT NULL,
        module_a        TEXT NOT NULL,
        module_b        TEXT NOT NULL,
        account_code    TEXT,
        amount_a        NUMERIC(18,2),
        amount_b        NUMERIC(18,2),
        difference      NUMERIC(18,2),
        severity        TEXT NOT NULL DEFAULT 'normal'
                          CHECK (severity IN ('low','normal','high','critical')),
        resolved        BOOLEAN DEFAULT FALSE,
        resolution      TEXT,
        details         JSONB,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        resolved_at     TIMESTAMPTZ
      )
    `);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  BOND → TRUST ACCOUNTING SYNC
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sync bond accrual events that were posted to Fineract GL but not to trust accounting.
   * Looks for bond_accruals rows without a corresponding trust journal entry.
   */
  static async syncBondsToAccounting() {
    var { TrustAccountingEngine } = require('./trustAccountingEngine');

    var syncId = 'SYNC-BOND-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    var synced = 0;
    var skipped = 0;
    var failed = 0;
    var errors = [];

    try {
      // Find bond accruals that don't have matching trust journal entries
      var accruals = await pool.query(`
        SELECT ba.*, b.bond_id AS bond_code, b.issuer, b.face_value
        FROM bond_accruals ba
        JOIN bonds b ON b.id = ba.bond_id
        WHERE ba.is_reversed = FALSE
          AND NOT EXISTS (
            SELECT 1 FROM trust_journal_entries je
            WHERE je.reference_type = 'bond_accrual'
              AND je.reference_id = CAST(ba.id AS TEXT)
              AND je.status = 'posted'
          )
        ORDER BY ba.accrual_date ASC
        LIMIT 100
      `);

      for (var i = 0; i < accruals.rows.length; i++) {
        var acc = accruals.rows[i];
        try {
          // Ensure accrued interest account exists
          await DataBridge._ensureAccount(ACCOUNTS.ACCRUED_INTEREST, 'Accrued Interest Receivable', 'asset', 'current');

          await TrustAccountingEngine.postJournalEntry({
            entryDate: acc.accrual_date,
            description: 'Bond interest accrual — ' + acc.bond_code + ' (' + acc.issuer + ')',
            lines: [
              { accountCode: ACCOUNTS.ACCRUED_INTEREST, debitAmount: parseFloat(acc.accrual_amount), creditAmount: 0, memo: 'Interest accrued ' + acc.accrual_date },
              { accountCode: ACCOUNTS.INTEREST_INCOME, debitAmount: 0, creditAmount: parseFloat(acc.accrual_amount), memo: 'Interest income ' + acc.bond_code },
            ],
            referenceType: 'bond_accrual',
            referenceId: String(acc.id),
            bondId: acc.bond_code,
            postedBy: 'data_bridge',
            postToFineract: false,
          });
          synced++;
        } catch (err) {
          failed++;
          errors.push({ accrualId: acc.id, bondId: acc.bond_code, error: err.message });
        }
      }

      // Sync coupon payments
      var coupons = await pool.query(`
        SELECT cp.*, b.bond_id AS bond_code, b.issuer
        FROM coupon_payments cp
        JOIN bonds b ON b.id = cp.bond_id
        WHERE cp.status = 'paid'
          AND NOT EXISTS (
            SELECT 1 FROM trust_journal_entries je
            WHERE je.reference_type = 'coupon_payment'
              AND je.reference_id = CAST(cp.id AS TEXT)
              AND je.status = 'posted'
          )
        ORDER BY cp.payment_date ASC
        LIMIT 100
      `);

      for (var j = 0; j < coupons.rows.length; j++) {
        var cpn = coupons.rows[j];
        try {
          await DataBridge._ensureAccount(ACCOUNTS.COUPON_INCOME, 'Coupon Income', 'income');

          var couponAmount = parseFloat(cpn.amount_cents || cpn.coupon_amount || 0);
          if (cpn.amount_cents) couponAmount = couponAmount / 100;

          if (couponAmount > 0) {
            // Fetch accrued interest balance to cap the credit
            var accruedResult = await pool.query(
              'SELECT COALESCE(balance, 0) AS balance FROM trust_accounts WHERE account_code = $1',
              [ACCOUNTS.ACCRUED_INTEREST]
            );
            var accruedBalance = accruedResult.rows.length > 0 ? parseFloat(accruedResult.rows[0].balance) : 0;
            var settleAmount = Math.min(couponAmount, Math.max(accruedBalance, 0));
            var excessAmount = couponAmount - settleAmount;

            var couponLines = [
              { accountCode: ACCOUNTS.CASH, debitAmount: couponAmount, creditAmount: 0, memo: 'Coupon received ' + cpn.bond_code },
            ];
            if (settleAmount > 0) {
              couponLines.push({ accountCode: ACCOUNTS.ACCRUED_INTEREST, debitAmount: 0, creditAmount: settleAmount, memo: 'Accrued interest settled' });
            }
            if (excessAmount > 0.001) {
              couponLines.push({ accountCode: ACCOUNTS.COUPON_INCOME, debitAmount: 0, creditAmount: excessAmount, memo: 'Coupon income (excess over accrued)' });
            }
            if (settleAmount <= 0) {
              couponLines.push({ accountCode: ACCOUNTS.COUPON_INCOME, debitAmount: 0, creditAmount: couponAmount, memo: 'Coupon income ' + cpn.bond_code });
            }

            await TrustAccountingEngine.postJournalEntry({
              entryDate: cpn.payment_date,
              description: 'Coupon payment received — ' + cpn.bond_code,
              lines: couponLines,
              referenceType: 'coupon_payment',
              referenceId: String(cpn.id),
              bondId: cpn.bond_code,
              postedBy: 'data_bridge',
              postToFineract: false,
            });
            synced++;
          } else {
            skipped++;
          }
        } catch (err) {
          failed++;
          errors.push({ couponId: cpn.id, bondId: cpn.bond_code, error: err.message });
        }
      }
    } catch (outerErr) {
      errors.push({ phase: 'query', error: outerErr.message });
    }

    await DataBridge._logSync(syncId, 'bond_to_accounting', 'bonds', 'trust_accounting', synced, skipped, failed, errors);

    return { syncId: syncId, synced: synced, skipped: skipped, failed: failed, errors: errors };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ACH → TRUST ACCOUNTING SYNC
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sync settled ACH batches into trust accounting as journal entries.
   * ACH engine currently has no trust accounting integration at all.
   */
  static async syncACHToAccounting() {
    var { TrustAccountingEngine } = require('./trustAccountingEngine');

    var syncId = 'SYNC-ACH-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    var synced = 0;
    var skipped = 0;
    var failed = 0;
    var errors = [];

    try {
      // Find ACH batches that are transmitted/settled but don't have trust JEs
      var batches = await pool.query(`
        SELECT ab.*
        FROM ach_batches ab
        WHERE ab.status IN ('transmitted', 'settled', 'acknowledged')
          AND NOT EXISTS (
            SELECT 1 FROM trust_journal_entries je
            WHERE je.reference_type = 'ach_batch'
              AND je.reference_id = ab.batch_id
              AND je.status = 'posted'
          )
        ORDER BY ab.created_at ASC
        LIMIT 100
      `);

      for (var i = 0; i < batches.rows.length; i++) {
        var batch = batches.rows[i];
        try {
          var amount = parseFloat(batch.total_amount_cents || 0) / 100;
          if (amount <= 0) { skipped++; continue; }

          // Determine debit/credit based on SEC code and transaction type
          var isCredit = (batch.transaction_code === '22' || batch.transaction_code === '32');
          var description = 'ACH ' + (isCredit ? 'credit' : 'debit') + ' — Batch ' + batch.batch_id;
          if (batch.company_entry_desc) description += ' (' + batch.company_entry_desc + ')';

          var lines;
          if (isCredit) {
            // ACH credit: cash goes out (credit asset), expense increases (debit expense)
            lines = [
              { accountCode: ACCOUNTS.PAYMENT_EXPENSE, debitAmount: amount, creditAmount: 0, memo: 'ACH disbursement ' + batch.batch_id },
              { accountCode: ACCOUNTS.CASH, debitAmount: 0, creditAmount: amount, memo: 'Cash disbursed via ACH' },
            ];
          } else {
            // ACH debit: cash comes in (debit asset), income increases (credit income)
            lines = [
              { accountCode: ACCOUNTS.CASH, debitAmount: amount, creditAmount: 0, memo: 'ACH collection ' + batch.batch_id },
              { accountCode: ACCOUNTS.FEE_INCOME, debitAmount: 0, creditAmount: amount, memo: 'ACH income received' },
            ];
          }

          await TrustAccountingEngine.postJournalEntry({
            entryDate: batch.effective_date || batch.created_at,
            description: description,
            lines: lines,
            referenceType: 'ach_batch',
            referenceId: batch.batch_id,
            postedBy: 'data_bridge',
            postToFineract: false,
          });
          synced++;
        } catch (err) {
          failed++;
          errors.push({ batchId: batch.batch_id, error: err.message });
        }
      }
    } catch (outerErr) {
      errors.push({ phase: 'query', error: outerErr.message });
    }

    await DataBridge._logSync(syncId, 'ach_to_accounting', 'ach', 'trust_accounting', synced, skipped, failed, errors);

    return { syncId: syncId, synced: synced, skipped: skipped, failed: failed, errors: errors };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CASH → TRUST ACCOUNTING RECONCILIATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Reconcile cash_accounts balances with trust_accounts cash balance.
   * Cash engine tracks balances independently — this detects drift.
   */
  static async reconcileCashToAccounting() {
    var syncId = 'RECON-CASH-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    var discrepancies = [];
    var cashModuleTotal = 0;
    var trustCashBalance = 0;

    try {
      // Get total cash from cash_accounts table
      var cashResult = await pool.query(`
        SELECT COALESCE(SUM(balance_cents), 0) AS total_cents
        FROM cash_accounts
        WHERE status = 'active'
      `);
      cashModuleTotal = parseInt(cashResult.rows[0].total_cents) / 100;

      // Get cash balance from trust accounting
      var trustResult = await pool.query(`
        SELECT COALESCE(balance, 0) AS balance
        FROM trust_accounts
        WHERE account_code = $1
      `, [ACCOUNTS.CASH]);
      trustCashBalance = trustResult.rows.length > 0 ? parseFloat(trustResult.rows[0].balance) : 0;

      var diff = Math.abs(cashModuleTotal - trustCashBalance);

      if (diff > 0.01) {
        var discId = 'DISC-CASH-' + Date.now();
        discrepancies.push({
          discrepancyId: discId,
          type: 'cash_balance_mismatch',
          moduleA: 'cash_management',
          moduleB: 'trust_accounting',
          accountCode: ACCOUNTS.CASH,
          amountA: cashModuleTotal,
          amountB: trustCashBalance,
          difference: cashModuleTotal - trustCashBalance,
          severity: diff > 10000 ? 'critical' : diff > 1000 ? 'high' : diff > 100 ? 'normal' : 'low',
        });

        await DataBridge._logDiscrepancy(discId, 'cash_balance_mismatch', 'cash_management', 'trust_accounting',
          ACCOUNTS.CASH, cashModuleTotal, trustCashBalance, cashModuleTotal - trustCashBalance,
          diff > 10000 ? 'critical' : diff > 1000 ? 'high' : diff > 100 ? 'normal' : 'low');
      }

      // Per-account comparison
      var cashAccounts = await pool.query(`
        SELECT account_id, account_name, balance_cents, routing_number, account_number
        FROM cash_accounts WHERE status = 'active'
      `);

      for (var i = 0; i < cashAccounts.rows.length; i++) {
        var ca = cashAccounts.rows[i];
        var trustAcct = await pool.query(`
          SELECT balance FROM trust_accounts
          WHERE linked_cash_account = $1 AND is_active = TRUE
        `, [ca.account_id]);

        if (trustAcct.rows.length > 0) {
          var cashBal = parseInt(ca.balance_cents) / 100;
          var trustBal = parseFloat(trustAcct.rows[0].balance);
          var acctDiff = Math.abs(cashBal - trustBal);

          if (acctDiff > 0.01) {
            discrepancies.push({
              type: 'individual_cash_mismatch',
              accountId: ca.account_id,
              accountName: ca.account_name,
              cashBalance: cashBal,
              trustBalance: trustBal,
              difference: cashBal - trustBal,
            });
          }
        }
      }
    } catch (err) {
      discrepancies.push({ type: 'error', error: err.message });
    }

    await DataBridge._logSync(syncId, 'cash_reconciliation', 'cash_management', 'trust_accounting',
      0, 0, 0, discrepancies);

    return {
      syncId: syncId,
      cashModuleTotal: cashModuleTotal,
      trustAccountingTotal: trustCashBalance,
      difference: cashModuleTotal - trustCashBalance,
      isReconciled: Math.abs(cashModuleTotal - trustCashBalance) < 0.01,
      discrepancies: discrepancies,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  BILL → TRUST ACCOUNTING SYNC
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sync BILL deposit transactions to trust accounting.
   * BILL client records deposits but creates no trust journal entries.
   */
  static async syncBILLToAccounting() {
    var { TrustAccountingEngine } = require('./trustAccountingEngine');

    var syncId = 'SYNC-BILL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    var synced = 0;
    var skipped = 0;
    var failed = 0;
    var errors = [];

    try {
      // Check if bill_transactions table exists
      var tableCheck = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_name = 'bill_transactions'
        ) AS exists
      `);

      if (!tableCheck.rows[0].exists) {
        return { syncId: syncId, synced: 0, skipped: 0, failed: 0, message: 'No bill_transactions table — BILL module not active' };
      }

      var deposits = await pool.query(`
        SELECT bt.*
        FROM bill_transactions bt
        WHERE bt.type IN ('deposit', 'payment')
          AND bt.status = 'completed'
          AND NOT EXISTS (
            SELECT 1 FROM trust_journal_entries je
            WHERE je.reference_type = 'bill_transaction'
              AND je.reference_id = bt.transaction_id
              AND je.status = 'posted'
          )
        ORDER BY bt.created_at ASC
        LIMIT 100
      `);

      for (var i = 0; i < deposits.rows.length; i++) {
        var txn = deposits.rows[i];
        try {
          var amount = parseFloat(txn.amount_cents || txn.amount || 0);
          if (txn.amount_cents) amount = amount / 100;
          if (amount <= 0) { skipped++; continue; }

          var lines;
          if (txn.type === 'deposit') {
            lines = [
              { accountCode: ACCOUNTS.CASH, debitAmount: amount, creditAmount: 0, memo: 'BILL deposit ' + txn.transaction_id },
              { accountCode: ACCOUNTS.ACCOUNTS_RECEIVABLE, debitAmount: 0, creditAmount: amount, memo: 'BILL deposit received' },
            ];
          } else {
            lines = [
              { accountCode: ACCOUNTS.PAYMENT_EXPENSE, debitAmount: amount, creditAmount: 0, memo: 'BILL payment ' + txn.transaction_id },
              { accountCode: ACCOUNTS.CASH, debitAmount: 0, creditAmount: amount, memo: 'BILL payment sent' },
            ];
          }

          await TrustAccountingEngine.postJournalEntry({
            entryDate: txn.created_at,
            description: 'BILL ' + txn.type + ' — ' + (txn.memo || txn.transaction_id),
            lines: lines,
            referenceType: 'bill_transaction',
            referenceId: txn.transaction_id,
            postedBy: 'data_bridge',
            postToFineract: false,
          });
          synced++;
        } catch (err) {
          failed++;
          errors.push({ transactionId: txn.transaction_id, error: err.message });
        }
      }
    } catch (outerErr) {
      errors.push({ phase: 'query', error: outerErr.message });
    }

    await DataBridge._logSync(syncId, 'bill_to_accounting', 'bill', 'trust_accounting', synced, skipped, failed, errors);

    return { syncId: syncId, synced: synced, skipped: skipped, failed: failed, errors: errors };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TRUST ACCOUNTING ↔ FINERACT GL RECONCILIATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Bidirectional reconciliation between trust accounting and Fineract GL.
   * Compares account balances and flags discrepancies.
   */
  static async reconcileFineractGL() {
    var { FineractClient } = require('../fineract/fineractClient');

    var syncId = 'RECON-GL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    var discrepancies = [];
    var matched = 0;
    var unmatched = 0;

    try {
      // Get GL mappings
      var mappings = await pool.query(`
        SELECT trust_account_code, fineract_gl_id, description
        FROM fineract_gl_mappings
        WHERE mapping_type = 'trust_journal'
      `);

      if (mappings.rows.length === 0) {
        return { syncId: syncId, matched: 0, unmatched: 0, message: 'No GL mappings configured — run Fineract sync setup first' };
      }

      // Get trust accounting balances
      var trustAccounts = await pool.query(`
        SELECT account_code, account_name, account_type, balance
        FROM trust_accounts WHERE is_active = TRUE
      `);
      var trustMap = {};
      for (var t = 0; t < trustAccounts.rows.length; t++) {
        trustMap[trustAccounts.rows[t].account_code] = trustAccounts.rows[t];
      }

      // Get Fineract GL balances
      var glSummary;
      try {
        glSummary = await FineractClient.getGLSummary();
      } catch (glErr) {
        return { syncId: syncId, matched: 0, unmatched: 0, error: 'Cannot connect to Fineract: ' + glErr.message, discrepancies: [] };
      }

      var glMap = {};
      if (glSummary && Array.isArray(glSummary.accounts)) {
        for (var g = 0; g < glSummary.accounts.length; g++) {
          var glAcct = glSummary.accounts[g];
          glMap[glAcct.id] = glAcct;
        }
      }

      // Compare mapped accounts
      for (var m = 0; m < mappings.rows.length; m++) {
        var mapping = mappings.rows[m];
        var trustAcct = trustMap[mapping.trust_account_code];
        var fineractAcct = glMap[mapping.fineract_gl_id];

        if (!trustAcct || !fineractAcct) {
          unmatched++;
          discrepancies.push({
            type: 'missing_account',
            trustAccountCode: mapping.trust_account_code,
            fineractGlId: mapping.fineract_gl_id,
            trustExists: !!trustAcct,
            fineractExists: !!fineractAcct,
          });
          continue;
        }

        var trustBalance = parseFloat(trustAcct.balance || 0);
        var fineractBalance = parseFloat(fineractAcct.balance || 0);
        var diff = Math.abs(trustBalance - fineractBalance);

        if (diff > 0.01) {
          unmatched++;
          var discId = 'DISC-GL-' + Date.now() + '-' + mapping.trust_account_code;
          discrepancies.push({
            discrepancyId: discId,
            type: 'balance_mismatch',
            trustAccountCode: mapping.trust_account_code,
            trustAccountName: trustAcct.account_name,
            fineractGlId: mapping.fineract_gl_id,
            trustBalance: trustBalance,
            fineractBalance: fineractBalance,
            difference: trustBalance - fineractBalance,
            severity: diff > 100000 ? 'critical' : diff > 10000 ? 'high' : diff > 1000 ? 'normal' : 'low',
          });

          await DataBridge._logDiscrepancy(discId, 'gl_balance_mismatch', 'trust_accounting', 'fineract_gl',
            mapping.trust_account_code, trustBalance, fineractBalance, trustBalance - fineractBalance,
            diff > 100000 ? 'critical' : diff > 10000 ? 'high' : diff > 1000 ? 'normal' : 'low');
        } else {
          matched++;
        }
      }

      // Count unsynced trust journal entries (posted but no fineract_txn_id)
      var unsyncedResult = await pool.query(`
        SELECT COUNT(*) AS count
        FROM trust_journal_entries
        WHERE status = 'posted' AND fineract_txn_id IS NULL
      `);
      var unsyncedCount = parseInt(unsyncedResult.rows[0].count);

    } catch (outerErr) {
      discrepancies.push({ type: 'error', error: outerErr.message });
    }

    await DataBridge._logSync(syncId, 'fineract_reconciliation', 'trust_accounting', 'fineract_gl',
      matched, 0, unmatched, discrepancies);

    return {
      syncId: syncId,
      matched: matched,
      unmatched: unmatched,
      unsyncedJournalEntries: unsyncedCount || 0,
      discrepancies: discrepancies,
    };
  }

  /**
   * Push all unsynced trust journal entries to Fineract GL.
   */
  static async pushToFineract() {
    var { TrustAccountingEngine } = require('./trustAccountingEngine');
    var { FineractClient } = require('../fineract/fineractClient');

    var syncId = 'PUSH-GL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    var synced = 0;
    var skipped = 0;
    var failed = 0;
    var errors = [];

    try {
      // Get unsynced journal entries
      var entries = await pool.query(`
        SELECT je.*, json_agg(json_build_object(
          'account_code', jl.account_code,
          'debit_amount', jl.debit_amount,
          'credit_amount', jl.credit_amount,
          'memo', jl.memo
        )) AS lines
        FROM trust_journal_entries je
        JOIN trust_journal_lines jl ON jl.entry_id = je.entry_id
        WHERE je.status = 'posted' AND je.fineract_txn_id IS NULL
        GROUP BY je.entry_id
        ORDER BY je.entry_date ASC
        LIMIT 50
      `);

      // Get GL mappings
      var mappings = await pool.query(`
        SELECT trust_account_code, fineract_gl_id
        FROM fineract_gl_mappings WHERE mapping_type = 'trust_journal'
      `);
      var glMap = {};
      for (var m = 0; m < mappings.rows.length; m++) {
        glMap[mappings.rows[m].trust_account_code] = parseInt(mappings.rows[m].fineract_gl_id);
      }

      for (var i = 0; i < entries.rows.length; i++) {
        var entry = entries.rows[i];
        try {
          var lines = entry.lines;
          var debits = [];
          var credits = [];
          var hasMissingMapping = false;

          for (var j = 0; j < lines.length; j++) {
            var line = lines[j];
            var glId = glMap[line.account_code];
            if (!glId) { hasMissingMapping = true; break; }

            if (parseFloat(line.debit_amount) > 0) {
              debits.push({ glAccountId: glId, amount: parseFloat(line.debit_amount) });
            }
            if (parseFloat(line.credit_amount) > 0) {
              credits.push({ glAccountId: glId, amount: parseFloat(line.credit_amount) });
            }
          }

          if (hasMissingMapping) { skipped++; continue; }
          if (debits.length === 0 || credits.length === 0) { skipped++; continue; }

          var glResult = await FineractClient.postJournalEntry({
            officeId: 1,
            transactionDate: new Date(entry.entry_date),
            debits: debits,
            credits: credits,
            comments: 'Trust JE ' + entry.entry_id + ': ' + entry.description,
          });

          var fineractTxnId = glResult && glResult.resourceId ? String(glResult.resourceId) : null;
          if (fineractTxnId) {
            await pool.query(
              `UPDATE trust_journal_entries SET fineract_txn_id = $1 WHERE entry_id = $2`,
              [fineractTxnId, entry.entry_id]
            );
          }
          synced++;
        } catch (err) {
          failed++;
          errors.push({ entryId: entry.entry_id, error: err.message });
        }
      }
    } catch (outerErr) {
      errors.push({ phase: 'query', error: outerErr.message });
    }

    await DataBridge._logSync(syncId, 'push_to_fineract', 'trust_accounting', 'fineract_gl', synced, skipped, failed, errors);

    return { syncId: syncId, synced: synced, skipped: skipped, failed: failed, errors: errors };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  WIRE → ACCOUNTING VERIFICATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Verify wire transfers have corresponding trust journal entries.
   * WireEngine already posts JEs, but this catches any that slipped through.
   */
  static async verifyWireSync() {
    var syncId = 'VERIFY-WIRE-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    var gaps = [];

    try {
      var unsynced = await pool.query(`
        SELECT wt.wire_id, wt.amount_cents, wt.status, wt.created_at
        FROM wire_transfers wt
        WHERE wt.status IN ('settled', 'confirmed', 'sent')
          AND wt.journal_entry_id IS NULL
        ORDER BY wt.created_at ASC
      `);

      for (var i = 0; i < unsynced.rows.length; i++) {
        gaps.push({
          wireId: unsynced.rows[i].wire_id,
          amount: parseInt(unsynced.rows[i].amount_cents) / 100,
          status: unsynced.rows[i].status,
          createdAt: unsynced.rows[i].created_at,
        });
      }
    } catch (err) {
      gaps.push({ type: 'error', error: err.message });
    }

    await DataBridge._logSync(syncId, 'wire_verification', 'wire', 'trust_accounting',
      0, 0, gaps.length, gaps);

    return { syncId: syncId, totalWiresWithoutJE: gaps.length, gaps: gaps };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  UNIFIED DATA FLOW STATUS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get comprehensive data flow status across all modules.
   */
  static async getDataFlowStatus() {
    var status = {
      generatedAt: new Date().toISOString(),
      modules: {},
      syncHealth: 'healthy',
      totalDiscrepancies: 0,
      unresolvedDiscrepancies: 0,
    };

    try {
      // Trust Accounting status
      var jeCount = await pool.query(`SELECT COUNT(*) AS c FROM trust_journal_entries WHERE status = 'posted'`);
      var unsyncedJE = await pool.query(`SELECT COUNT(*) AS c FROM trust_journal_entries WHERE status = 'posted' AND fineract_txn_id IS NULL`);
      var acctCount = await pool.query(`SELECT COUNT(*) AS c FROM trust_accounts WHERE is_active = TRUE`);
      status.modules.trust_accounting = {
        journalEntries: parseInt(jeCount.rows[0].c),
        unsyncedToFineract: parseInt(unsyncedJE.rows[0].c),
        activeAccounts: parseInt(acctCount.rows[0].c),
      };
    } catch (e) { status.modules.trust_accounting = { error: e.message }; }

    try {
      // Fineract GL status
      var glMappings = await pool.query(`SELECT COUNT(*) AS c FROM fineract_gl_mappings WHERE mapping_type = 'trust_journal'`);
      status.modules.fineract_gl = {
        mappedAccounts: parseInt(glMappings.rows[0].c),
      };
    } catch (e) { status.modules.fineract_gl = { error: e.message }; }

    try {
      // Cash Management status
      var cashTotal = await pool.query(`SELECT COUNT(*) AS c, COALESCE(SUM(balance_cents),0) AS total FROM cash_accounts WHERE status = 'active'`);
      status.modules.cash_management = {
        activeAccounts: parseInt(cashTotal.rows[0].c),
        totalBalanceCents: parseInt(cashTotal.rows[0].total),
        totalBalance: parseInt(cashTotal.rows[0].total) / 100,
      };
    } catch (e) { status.modules.cash_management = { error: e.message }; }

    try {
      // ACH status
      var achCount = await pool.query(`SELECT COUNT(*) AS c, COUNT(CASE WHEN status IN ('transmitted','settled','acknowledged') THEN 1 END) AS settled FROM ach_batches`);
      var achNoJE = await pool.query(`
        SELECT COUNT(*) AS c FROM ach_batches ab
        WHERE ab.status IN ('transmitted','settled','acknowledged')
          AND NOT EXISTS (SELECT 1 FROM trust_journal_entries je WHERE je.reference_type = 'ach_batch' AND je.reference_id = ab.batch_id AND je.status = 'posted')
      `);
      status.modules.ach = {
        totalBatches: parseInt(achCount.rows[0].c),
        settledBatches: parseInt(achCount.rows[0].settled),
        unsyncedToAccounting: parseInt(achNoJE.rows[0].c),
      };
    } catch (e) { status.modules.ach = { error: e.message }; }

    try {
      // Wire status
      var wireCount = await pool.query(`SELECT COUNT(*) AS c, COUNT(CASE WHEN status IN ('settled','confirmed','sent') THEN 1 END) AS completed FROM wire_transfers`);
      var wireNoJE = await pool.query(`SELECT COUNT(*) AS c FROM wire_transfers WHERE status IN ('settled','confirmed','sent') AND journal_entry_id IS NULL`);
      status.modules.wire = {
        totalTransfers: parseInt(wireCount.rows[0].c),
        completedTransfers: parseInt(wireCount.rows[0].completed),
        missingJournalEntries: parseInt(wireNoJE.rows[0].c),
      };
    } catch (e) { status.modules.wire = { error: e.message }; }

    try {
      // Bond status
      var bondCount = await pool.query(`SELECT COUNT(*) AS c, COALESCE(SUM(face_value),0) AS total FROM bonds WHERE status = 'active'`);
      var accrualNoJE = await pool.query(`
        SELECT COUNT(*) AS c FROM bond_accruals ba
        WHERE ba.is_reversed = FALSE
          AND NOT EXISTS (SELECT 1 FROM trust_journal_entries je WHERE je.reference_type = 'bond_accrual' AND je.reference_id = CAST(ba.id AS TEXT) AND je.status = 'posted')
      `);
      status.modules.bonds = {
        activeBonds: parseInt(bondCount.rows[0].c),
        totalFaceValue: parseFloat(bondCount.rows[0].total),
        unsyncedAccruals: parseInt(accrualNoJE.rows[0].c),
      };
    } catch (e) { status.modules.bonds = { error: e.message }; }

    try {
      // Discrepancies
      var discCount = await pool.query(`SELECT COUNT(*) AS total, COUNT(CASE WHEN resolved = FALSE THEN 1 END) AS unresolved FROM data_bridge_discrepancies`);
      status.totalDiscrepancies = parseInt(discCount.rows[0].total);
      status.unresolvedDiscrepancies = parseInt(discCount.rows[0].unresolved);
    } catch (e) { /* table may not exist yet */ }

    try {
      // Recent sync log
      var recentSyncs = await pool.query(`
        SELECT sync_id, sync_type, source_module, target_module, items_synced, items_failed, status, created_at
        FROM data_bridge_sync_log
        ORDER BY created_at DESC LIMIT 10
      `);
      status.recentSyncs = recentSyncs.rows;
    } catch (e) { status.recentSyncs = []; }

    // Determine sync health
    var hasUnsyncedACH = status.modules.ach && status.modules.ach.unsyncedToAccounting > 0;
    var hasUnsyncedBonds = status.modules.bonds && status.modules.bonds.unsyncedAccruals > 0;
    var hasUnsyncedJE = status.modules.trust_accounting && status.modules.trust_accounting.unsyncedToFineract > 0;
    var hasMissingWireJE = status.modules.wire && status.modules.wire.missingJournalEntries > 0;

    if (status.unresolvedDiscrepancies > 5 || (hasUnsyncedACH && status.modules.ach.unsyncedToAccounting > 10)) {
      status.syncHealth = 'critical';
    } else if (hasUnsyncedACH || hasUnsyncedBonds || hasUnsyncedJE || hasMissingWireJE) {
      status.syncHealth = 'needs_sync';
    }

    return status;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  FULL SYNC — RUN ALL SYNC OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Execute all sync operations in sequence.
   * Returns a unified report of all sync results.
   */
  static async runFullSync() {
    var startTime = Date.now();
    var results = {};

    // 1. Sync bonds to accounting
    try { results.bonds = await DataBridge.syncBondsToAccounting(); }
    catch (e) { results.bonds = { error: e.message }; }

    // 2. Sync ACH to accounting
    try { results.ach = await DataBridge.syncACHToAccounting(); }
    catch (e) { results.ach = { error: e.message }; }

    // 3. Sync BILL to accounting
    try { results.bill = await DataBridge.syncBILLToAccounting(); }
    catch (e) { results.bill = { error: e.message }; }

    // 4. Verify wire sync
    try { results.wire = await DataBridge.verifyWireSync(); }
    catch (e) { results.wire = { error: e.message }; }

    // 5. Reconcile cash
    try { results.cash = await DataBridge.reconcileCashToAccounting(); }
    catch (e) { results.cash = { error: e.message }; }

    // 6. Reconcile Fineract GL
    try { results.fineractGL = await DataBridge.reconcileFineractGL(); }
    catch (e) { results.fineractGL = { error: e.message }; }

    // 7. Push unsynced entries to Fineract
    try { results.fineractPush = await DataBridge.pushToFineract(); }
    catch (e) { results.fineractPush = { error: e.message }; }

    var elapsed = Date.now() - startTime;

    var totalSynced = (results.bonds.synced || 0) + (results.ach.synced || 0) +
      (results.bill.synced || 0) + (results.fineractPush.synced || 0);
    var totalFailed = (results.bonds.failed || 0) + (results.ach.failed || 0) +
      (results.bill.failed || 0) + (results.fineractPush.failed || 0);

    return {
      timestamp: new Date().toISOString(),
      durationMs: elapsed,
      totalSynced: totalSynced,
      totalFailed: totalFailed,
      results: results,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RECONCILIATION REPORT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generate a comprehensive reconciliation report across all modules.
   */
  static async getReconciliationReport() {
    var report = {
      generatedAt: new Date().toISOString(),
      sections: [],
    };

    // Section 1: Trust Accounting vs Cash Management
    try {
      var cashRecon = await DataBridge.reconcileCashToAccounting();
      report.sections.push({
        title: 'Cash Management ↔ Trust Accounting',
        isReconciled: cashRecon.isReconciled,
        cashModuleTotal: cashRecon.cashModuleTotal,
        trustAccountingTotal: cashRecon.trustAccountingTotal,
        difference: cashRecon.difference,
        discrepancies: cashRecon.discrepancies.length,
      });
    } catch (e) {
      report.sections.push({ title: 'Cash Management ↔ Trust Accounting', error: e.message });
    }

    // Section 2: Trust Accounting vs Fineract GL
    try {
      var glRecon = await DataBridge.reconcileFineractGL();
      report.sections.push({
        title: 'Trust Accounting ↔ Fineract GL',
        matched: glRecon.matched,
        unmatched: glRecon.unmatched,
        unsyncedJournalEntries: glRecon.unsyncedJournalEntries,
        discrepancies: glRecon.discrepancies.length,
      });
    } catch (e) {
      report.sections.push({ title: 'Trust Accounting ↔ Fineract GL', error: e.message });
    }

    // Section 3: Unsynced transactions
    try {
      var flowStatus = await DataBridge.getDataFlowStatus();
      report.sections.push({
        title: 'Unsynced Transactions',
        achUnsyncedBatches: flowStatus.modules.ach ? flowStatus.modules.ach.unsyncedToAccounting : 0,
        bondUnsyncedAccruals: flowStatus.modules.bonds ? flowStatus.modules.bonds.unsyncedAccruals : 0,
        wiresMissingJE: flowStatus.modules.wire ? flowStatus.modules.wire.missingJournalEntries : 0,
        journalEntriesNotInFineract: flowStatus.modules.trust_accounting ? flowStatus.modules.trust_accounting.unsyncedToFineract : 0,
      });
      report.syncHealth = flowStatus.syncHealth;
    } catch (e) {
      report.sections.push({ title: 'Unsynced Transactions', error: e.message });
    }

    // Section 4: Historical discrepancies
    try {
      var discrepancies = await pool.query(`
        SELECT discrepancy_id, discrepancy_type, module_a, module_b, account_code,
               amount_a, amount_b, difference, severity, resolved, created_at
        FROM data_bridge_discrepancies
        WHERE resolved = FALSE
        ORDER BY
          CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
          created_at DESC
        LIMIT 20
      `);
      report.sections.push({
        title: 'Unresolved Discrepancies',
        count: discrepancies.rows.length,
        items: discrepancies.rows,
      });
    } catch (e) {
      report.sections.push({ title: 'Unresolved Discrepancies', error: e.message });
    }

    return report;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SYNC LOG HISTORY
  // ═══════════════════════════════════════════════════════════════════════════

  static async getSyncHistory({ limit, syncType } = {}) {
    var conditions = [];
    var params = [];
    var idx = 1;

    if (syncType) { conditions.push('sync_type = $' + idx++); params.push(syncType); }

    var where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    var lim = limit || 50;

    var result = await pool.query(
      'SELECT * FROM data_bridge_sync_log ' + where + ' ORDER BY created_at DESC LIMIT ' + lim,
      params
    );
    return result.rows;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  static async _ensureAccount(code, name, type, subType) {
    var exists = await pool.query('SELECT 1 FROM trust_accounts WHERE account_code = $1', [code]);
    if (exists.rows.length === 0) {
      await pool.query(
        'INSERT INTO trust_accounts (account_code, account_name, account_type, sub_type) VALUES ($1, $2, $3, $4)',
        [code, name, type, subType || null]
      );
    }
  }

  static async _logSync(syncId, syncType, source, target, synced, skipped, failed, details) {
    try {
      var status = failed > 0 && synced === 0 ? 'failed' : failed > 0 ? 'partial' : 'completed';
      await pool.query(
        `INSERT INTO data_bridge_sync_log
           (sync_id, sync_type, source_module, target_module, items_synced, items_skipped, items_failed, details, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [syncId, syncType, source, target, synced, skipped, failed, JSON.stringify(details || []), status]
      );
    } catch (e) {
      console.warn('[DataBridge] Failed to log sync:', e.message);
    }
  }

  static async _logDiscrepancy(discId, type, moduleA, moduleB, accountCode, amountA, amountB, difference, severity) {
    try {
      await pool.query(
        `INSERT INTO data_bridge_discrepancies
           (discrepancy_id, discrepancy_type, module_a, module_b, account_code,
            amount_a, amount_b, difference, severity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (discrepancy_id) DO UPDATE SET
           amount_a = $6, amount_b = $7, difference = $8, severity = $9`,
        [discId, type, moduleA, moduleB, accountCode, amountA, amountB, difference, severity]
      );
    } catch (e) {
      console.warn('[DataBridge] Failed to log discrepancy:', e.message);
    }
  }
}

module.exports = { DataBridge };
