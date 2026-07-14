/**
 * Sub-Ledger Engine — DLB Trust Platform
 *
 * Manages per-client sub-ledger accounts within Core Banking.
 * Each CRM contact can have sub-ledger accounts that break down
 * their portion of trust GL accounts (bond investments, distributions,
 * accrued interest, etc.).
 *
 * Sub-ledger balances roll up to the parent trust GL account and
 * sync to Fineract via DataBridge.
 */

'use strict';

var pool = require('../bonds/pgPool');
var { FineractClient } = require('../fineract/fineractClient');

class SubLedgerEngine {

  // ═══════════════════════════════════════════════════════════════════════════
  //  TABLE SETUP
  // ═══════════════════════════════════════════════════════════════════════════

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS client_sub_ledgers (
        id                  SERIAL PRIMARY KEY,
        sub_ledger_id       TEXT UNIQUE NOT NULL,
        contact_id          TEXT NOT NULL,
        parent_account_code TEXT NOT NULL,
        sub_account_name    TEXT NOT NULL,
        sub_account_type    TEXT NOT NULL DEFAULT 'general'
                              CHECK (sub_account_type IN (
                                'bond_investment','distribution','accrued_interest',
                                'fee','escrow','operating','general'
                              )),
        balance             NUMERIC(18,2) NOT NULL DEFAULT 0,
        currency            TEXT NOT NULL DEFAULT 'USD',
        status              TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','frozen','closed')),
        fineract_savings_id TEXT,
        notes               TEXT,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        updated_at          TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sub_ledger_transactions (
        id                SERIAL PRIMARY KEY,
        transaction_id    TEXT UNIQUE NOT NULL,
        sub_ledger_id     TEXT NOT NULL,
        transaction_type  TEXT NOT NULL
                            CHECK (transaction_type IN (
                              'debit','credit','opening_balance','adjustment',
                              'distribution','fee','interest','transfer'
                            )),
        amount            NUMERIC(18,2) NOT NULL,
        running_balance   NUMERIC(18,2) NOT NULL,
        description       TEXT,
        reference_type    TEXT,
        reference_id      TEXT,
        journal_entry_id  TEXT,
        posted_by         TEXT DEFAULT 'system',
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sub_ledger_contact ON client_sub_ledgers(contact_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sub_ledger_parent ON client_sub_ledgers(parent_account_code)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sub_txn_ledger ON sub_ledger_transactions(sub_ledger_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sub_txn_ref ON sub_ledger_transactions(reference_type, reference_id)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SUB-LEDGER ACCOUNT CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  static async createSubLedger({
    contactId, parentAccountCode, subAccountName, subAccountType,
    openingBalance, currency, notes,
  }) {
    var subLedgerId = 'SL-' + contactId.replace('CRM-', '') + '-' + parentAccountCode + '-' + Date.now().toString(36).toUpperCase();
    var balance = parseFloat(openingBalance || 0);

    var result = await pool.query(
      `INSERT INTO client_sub_ledgers
         (sub_ledger_id, contact_id, parent_account_code, sub_account_name,
          sub_account_type, balance, currency, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [subLedgerId, contactId, parentAccountCode, subAccountName,
       subAccountType || 'general', balance, currency || 'USD', notes || null]
    );

    // Record opening balance transaction if non-zero
    if (balance !== 0) {
      var txnId = 'SLT-' + Date.now() + '-OB';
      await pool.query(
        `INSERT INTO sub_ledger_transactions
           (transaction_id, sub_ledger_id, transaction_type, amount, running_balance,
            description, reference_type, posted_by)
         VALUES ($1, $2, 'opening_balance', $3, $3, $4, 'sub_ledger_setup', 'system')`,
        [txnId, subLedgerId, balance, 'Opening balance for ' + subAccountName]
      );
    }

    return result.rows[0];
  }

  static async getSubLedger(subLedgerId) {
    var result = await pool.query(
      `SELECT sl.*, c.first_name, c.last_name, c.company, c.contact_type,
              ta.account_name AS parent_account_name, ta.account_type AS parent_type
       FROM client_sub_ledgers sl
       LEFT JOIN crm_contacts c ON c.contact_id = sl.contact_id
       LEFT JOIN trust_accounts ta ON ta.account_code = sl.parent_account_code
       WHERE sl.sub_ledger_id = $1`,
      [subLedgerId]
    );
    return result.rows[0] || null;
  }

  static async listSubLedgers({ contactId, parentAccountCode, subAccountType, status } = {}) {
    var conditions = [];
    var params = [];
    var idx = 1;

    if (contactId) { conditions.push('sl.contact_id = $' + idx++); params.push(contactId); }
    if (parentAccountCode) { conditions.push('sl.parent_account_code = $' + idx++); params.push(parentAccountCode); }
    if (subAccountType) { conditions.push('sl.sub_account_type = $' + idx++); params.push(subAccountType); }
    if (status) { conditions.push('sl.status = $' + idx++); params.push(status); }

    var where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    var result = await pool.query(
      `SELECT sl.*, c.first_name, c.last_name, c.company, c.contact_type,
              ta.account_name AS parent_account_name, ta.account_type AS parent_type
       FROM client_sub_ledgers sl
       LEFT JOIN crm_contacts c ON c.contact_id = sl.contact_id
       LEFT JOIN trust_accounts ta ON ta.account_code = sl.parent_account_code
       ${where}
       ORDER BY sl.created_at DESC`,
      params
    );
    return result.rows;
  }

  static async updateSubLedger(subLedgerId, updates) {
    var allowed = ['sub_account_name', 'notes', 'status', 'fineract_savings_id'];
    var sets = [];
    var params = [];
    var idx = 1;

    for (var key in updates) {
      var snakeKey = key.replace(/[A-Z]/g, function(c) { return '_' + c.toLowerCase(); });
      if (allowed.indexOf(snakeKey) !== -1) {
        sets.push(snakeKey + ' = $' + idx++);
        params.push(updates[key]);
      }
    }
    if (sets.length === 0) throw new Error('No valid fields to update');

    sets.push('updated_at = NOW()');
    params.push(subLedgerId);

    var result = await pool.query(
      'UPDATE client_sub_ledgers SET ' + sets.join(', ') + ' WHERE sub_ledger_id = $' + idx + ' RETURNING *',
      params
    );
    if (result.rows.length === 0) throw new Error('Sub-ledger ' + subLedgerId + ' not found');
    return result.rows[0];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TRANSACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  static async postTransaction({
    subLedgerId, transactionType, amount, description,
    referenceType, referenceId, journalEntryId, postedBy, postToFineract = true,
  }) {
    var client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the sub-ledger row
      var ledgerRes = await client.query(
        'SELECT * FROM client_sub_ledgers WHERE sub_ledger_id = $1 FOR UPDATE',
        [subLedgerId]
      );
      if (ledgerRes.rows.length === 0) throw new Error('Sub-ledger ' + subLedgerId + ' not found');

      var ledger = ledgerRes.rows[0];
      if (ledger.status !== 'active') throw new Error('Sub-ledger ' + subLedgerId + ' is ' + ledger.status);

      var txnAmount = parseFloat(amount);
      if (txnAmount <= 0) throw new Error('Amount must be positive');

      // Calculate new balance
      var isDebit = ['debit', 'fee', 'distribution'].indexOf(transactionType) !== -1;
      var newBalance = parseFloat(ledger.balance) + (isDebit ? -txnAmount : txnAmount);
      if (newBalance < 0) throw new Error('Insufficient sub-ledger balance');

      var txnId = 'SLT-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();

      await client.query(
        `INSERT INTO sub_ledger_transactions
           (transaction_id, sub_ledger_id, transaction_type, amount, running_balance,
            description, reference_type, reference_id, journal_entry_id, posted_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [txnId, subLedgerId, transactionType, txnAmount, newBalance,
         description || null, referenceType || null, referenceId || null,
         journalEntryId || null, postedBy || 'system']
      );

      await client.query(
        'UPDATE client_sub_ledgers SET balance = $1, updated_at = NOW() WHERE sub_ledger_id = $2',
        [newBalance, subLedgerId]
      );

      await client.query('COMMIT');

      var txnResult = {
        transactionId: txnId,
        subLedgerId: subLedgerId,
        transactionType: transactionType,
        amount: txnAmount,
        previousBalance: parseFloat(ledger.balance),
        newBalance: newBalance,
      };

      if (postToFineract) {
        SubLedgerEngine._postFineractJE(ledger, txnResult).catch(function() {});
      }

      return txnResult;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Auto-post a Fineract journal entry for a sub-ledger transaction
   * if the contact is a trustee or beneficiary.
   */
  static async _postFineractJE(ledger, txn) {
    if (!FineractClient) return;
    if (!ledger.fineract_savings_id) return;

    // Only for trustees and beneficiaries
    try {
      var contactRes = await pool.query(
        'SELECT contact_type, fineract_client_id FROM crm_contacts WHERE contact_id = $1',
        [ledger.contact_id]
      );
      if (contactRes.rows.length === 0) return;
      var contact = contactRes.rows[0];
      if (contact.contact_type !== 'trustee' && contact.contact_type !== 'beneficiary') return;

      var fineractGLId = parseInt(ledger.fineract_savings_id);
      if (isNaN(fineractGLId) || fineractGLId <= 0) return;

      var isDebit = ['debit', 'fee', 'distribution'].indexOf(txn.transactionType) !== -1;
      var debits = isDebit
        ? [{ glAccountId: fineractGLId, amount: txn.amount }]
        : [{ glAccountId: 1, amount: txn.amount }];
      var credits = isDebit
        ? [{ glAccountId: 1, amount: txn.amount }]
        : [{ glAccountId: fineractGLId, amount: txn.amount }];

      await FineractClient.postJournalEntry({
        officeId: 1,
        transactionDate: new Date(),
        comments: 'Sub-ledger txn ' + txn.transactionId + ': ' + txn.transactionType + ' $' + txn.amount,
        debits: debits,
        credits: credits,
      });
      console.log('[SubLedger] Fineract JE posted for ' + txn.transactionId);
    } catch (err) {
      console.warn('[SubLedger] Fineract JE auto-post failed for ' + txn.transactionId + ':', err.message);
    }
  }

  static async getTransactions(subLedgerId, { limit, offset, fromDate, toDate } = {}) {
    var conditions = ['sub_ledger_id = $1'];
    var params = [subLedgerId];
    var idx = 2;

    if (fromDate) { conditions.push('created_at >= $' + idx++); params.push(fromDate); }
    if (toDate) { conditions.push('created_at <= $' + idx++); params.push(toDate); }

    var lim = limit ? parseInt(limit, 10) : 100;
    var off = offset ? parseInt(offset, 10) : 0;
    params.push(lim, off);

    var result = await pool.query(
      'SELECT * FROM sub_ledger_transactions WHERE ' + conditions.join(' AND ') +
      ' ORDER BY created_at DESC LIMIT $' + idx++ + ' OFFSET $' + idx,
      params
    );
    return result.rows;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TRANSFER BETWEEN SUB-LEDGERS
  // ═══════════════════════════════════════════════════════════════════════════

  static async transfer({ fromSubLedgerId, toSubLedgerId, amount, description, postedBy }) {
    var client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock both sub-ledgers (ordered by ID to prevent deadlocks)
      var ids = [fromSubLedgerId, toSubLedgerId].sort();
      var from = (await client.query(
        'SELECT * FROM client_sub_ledgers WHERE sub_ledger_id = $1 FOR UPDATE', [ids[0]]
      )).rows[0];
      var to = (await client.query(
        'SELECT * FROM client_sub_ledgers WHERE sub_ledger_id = $1 FOR UPDATE', [ids[1]]
      )).rows[0];

      // Reassign based on actual IDs
      if (ids[0] !== fromSubLedgerId) { var tmp = from; from = to; to = tmp; }

      if (!from) throw new Error('Source sub-ledger not found');
      if (!to) throw new Error('Destination sub-ledger not found');
      if (from.status !== 'active') throw new Error('Source sub-ledger is ' + from.status);
      if (to.status !== 'active') throw new Error('Destination sub-ledger is ' + to.status);

      var txnAmount = parseFloat(amount);
      if (txnAmount <= 0) throw new Error('Amount must be positive');

      var fromNewBalance = parseFloat(from.balance) - txnAmount;
      var toNewBalance = parseFloat(to.balance) + txnAmount;

      var txnIdFrom = 'SLT-' + Date.now() + '-XFER-FROM';
      var txnIdTo = 'SLT-' + Date.now() + '-XFER-TO';
      var memo = description || 'Transfer between sub-ledgers';

      // Debit from source
      await client.query(
        `INSERT INTO sub_ledger_transactions
           (transaction_id, sub_ledger_id, transaction_type, amount, running_balance,
            description, reference_type, reference_id, posted_by)
         VALUES ($1, $2, 'transfer', $3, $4, $5, 'sub_ledger_transfer', $6, $7)`,
        [txnIdFrom, fromSubLedgerId, txnAmount, fromNewBalance,
         'Transfer out: ' + memo, toSubLedgerId, postedBy || 'system']
      );
      await client.query(
        'UPDATE client_sub_ledgers SET balance = $1, updated_at = NOW() WHERE sub_ledger_id = $2',
        [fromNewBalance, fromSubLedgerId]
      );

      // Credit to destination
      await client.query(
        `INSERT INTO sub_ledger_transactions
           (transaction_id, sub_ledger_id, transaction_type, amount, running_balance,
            description, reference_type, reference_id, posted_by)
         VALUES ($1, $2, 'transfer', $3, $4, $5, 'sub_ledger_transfer', $6, $7)`,
        [txnIdTo, toSubLedgerId, txnAmount, toNewBalance,
         'Transfer in: ' + memo, fromSubLedgerId, postedBy || 'system']
      );
      await client.query(
        'UPDATE client_sub_ledgers SET balance = $1, updated_at = NOW() WHERE sub_ledger_id = $2',
        [toNewBalance, toSubLedgerId]
      );

      await client.query('COMMIT');

      return {
        fromTransaction: txnIdFrom,
        toTransaction: txnIdTo,
        amount: txnAmount,
        fromNewBalance: fromNewBalance,
        toNewBalance: toNewBalance,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ROLLUP & RECONCILIATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Roll up sub-ledger balances by parent account to verify they match
   * the parent GL account balance in trust accounting.
   */
  static async getSubLedgerRollup() {
    var result = await pool.query(`
      SELECT sl.parent_account_code,
             ta.account_name AS parent_account_name,
             ta.account_type AS parent_type,
             ta.balance AS gl_balance,
             COUNT(sl.id) AS sub_ledger_count,
             SUM(sl.balance) AS sub_ledger_total,
             ta.balance - SUM(sl.balance) AS unallocated
      FROM client_sub_ledgers sl
      LEFT JOIN trust_accounts ta ON ta.account_code = sl.parent_account_code
      WHERE sl.status = 'active'
      GROUP BY sl.parent_account_code, ta.account_name, ta.account_type, ta.balance
      ORDER BY sl.parent_account_code
    `);

    return result.rows.map(function(row) {
      return {
        parentAccountCode: row.parent_account_code,
        parentAccountName: row.parent_account_name,
        parentType: row.parent_type,
        glBalance: parseFloat(row.gl_balance || 0),
        subLedgerCount: parseInt(row.sub_ledger_count),
        subLedgerTotal: parseFloat(row.sub_ledger_total || 0),
        unallocated: parseFloat(row.unallocated || 0),
        isReconciled: Math.abs(parseFloat(row.unallocated || 0)) < 0.01,
      };
    });
  }

  /**
   * Get a client's complete sub-ledger statement across all their accounts.
   */
  static async getClientStatement(contactId, { fromDate, toDate } = {}) {
    var ledgers = await SubLedgerEngine.listSubLedgers({ contactId: contactId });

    var statement = {
      contactId: contactId,
      generatedAt: new Date().toISOString(),
      accounts: [],
      totalBalance: 0,
    };

    for (var i = 0; i < ledgers.length; i++) {
      var ledger = ledgers[i];
      var txns = await SubLedgerEngine.getTransactions(ledger.sub_ledger_id, {
        fromDate: fromDate, toDate: toDate, limit: 50,
      });

      statement.accounts.push({
        subLedgerId: ledger.sub_ledger_id,
        subAccountName: ledger.sub_account_name,
        subAccountType: ledger.sub_account_type,
        parentAccountCode: ledger.parent_account_code,
        parentAccountName: ledger.parent_account_name,
        balance: parseFloat(ledger.balance),
        transactionCount: txns.length,
        recentTransactions: txns,
      });
      statement.totalBalance += parseFloat(ledger.balance);
    }

    return statement;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DASHBOARD
  // ═══════════════════════════════════════════════════════════════════════════

  static async getDashboard() {
    var [totals, byType, byParent, recentTxns] = await Promise.all([
      pool.query(`
        SELECT COUNT(*) AS total_accounts,
               COUNT(CASE WHEN status = 'active' THEN 1 END) AS active_accounts,
               COALESCE(SUM(CASE WHEN status = 'active' THEN balance END), 0) AS total_balance,
               COUNT(DISTINCT contact_id) AS unique_clients
        FROM client_sub_ledgers
      `),
      pool.query(`
        SELECT sub_account_type, COUNT(*) AS count,
               COALESCE(SUM(balance), 0) AS total_balance
        FROM client_sub_ledgers WHERE status = 'active'
        GROUP BY sub_account_type ORDER BY total_balance DESC
      `),
      pool.query(`
        SELECT sl.parent_account_code, ta.account_name,
               COUNT(sl.id) AS sub_count,
               COALESCE(SUM(sl.balance), 0) AS sub_total,
               ta.balance AS gl_balance
        FROM client_sub_ledgers sl
        LEFT JOIN trust_accounts ta ON ta.account_code = sl.parent_account_code
        WHERE sl.status = 'active'
        GROUP BY sl.parent_account_code, ta.account_name, ta.balance
        ORDER BY sub_total DESC
      `),
      pool.query(`
        SELECT st.*, sl.sub_account_name, sl.contact_id
        FROM sub_ledger_transactions st
        JOIN client_sub_ledgers sl ON sl.sub_ledger_id = st.sub_ledger_id
        ORDER BY st.created_at DESC LIMIT 10
      `),
    ]);

    var row = totals.rows[0];
    return {
      totalAccounts: parseInt(row.total_accounts),
      activeAccounts: parseInt(row.active_accounts),
      totalBalance: parseFloat(row.total_balance),
      uniqueClients: parseInt(row.unique_clients),
      byType: byType.rows.map(function(r) {
        return { type: r.sub_account_type, count: parseInt(r.count), totalBalance: parseFloat(r.total_balance) };
      }),
      byParentAccount: byParent.rows.map(function(r) {
        return {
          parentAccountCode: r.parent_account_code,
          parentAccountName: r.account_name,
          subLedgerCount: parseInt(r.sub_count),
          subLedgerTotal: parseFloat(r.sub_total),
          glBalance: parseFloat(r.gl_balance || 0),
          unallocated: parseFloat(r.gl_balance || 0) - parseFloat(r.sub_total),
        };
      }),
      recentTransactions: recentTxns.rows,
      generatedAt: new Date().toISOString(),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DELETE SUB-LEDGER
  // ═══════════════════════════════════════════════════════════════════════════

  static async deleteSubLedger(subLedgerId) {
    var client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM sub_ledger_transactions WHERE sub_ledger_id = $1', [subLedgerId]);
      var result = await client.query('DELETE FROM client_sub_ledgers WHERE sub_ledger_id = $1 RETURNING *', [subLedgerId]);
      await client.query('COMMIT');
      if (result.rows.length === 0) throw new Error('Sub-ledger ' + subLedgerId + ' not found');
      return result.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PUSH SUB-LEDGERS TO FINERACT GL
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create corresponding Fineract GL sub-accounts for each sub-ledger.
   * Maps sub-ledger parent account types to Fineract GL types:
   *   asset=1, liability=2, equity=3, income=4, expense=5
   */
  static async pushToFineract() {
    var synced = 0;
    var skipped = 0;
    var failed = 0;
    var errors = [];

    try {
      var ledgers = await pool.query(`
        SELECT sl.*, ta.account_type AS parent_type, ta.account_name AS parent_name
        FROM client_sub_ledgers sl
        LEFT JOIN trust_accounts ta ON ta.account_code = sl.parent_account_code
        WHERE sl.status = 'active' AND (sl.fineract_savings_id IS NULL OR sl.fineract_savings_id = '')
      `);

      var typeMap = { asset: 1, liability: 2, equity: 3, income: 4, expense: 5 };

      for (var i = 0; i < ledgers.rows.length; i++) {
        var sl = ledgers.rows[i];
        try {
          var glType = typeMap[sl.parent_type] || 1;
          var glCode = sl.parent_account_code + '-' + sl.sub_ledger_id.replace('SL-', '').substring(0, 12);

          var fineractAcct = await FineractClient.createGLAccount({
            name: sl.sub_account_name,
            glCode: glCode,
            type: glType,
            usage: 2,
            description: 'Sub-ledger: ' + sl.sub_account_name + ' (parent: ' + sl.parent_account_code + ')',
            manualEntriesAllowed: true,
          });

          var fineractId = fineractAcct && (fineractAcct.resourceId || fineractAcct.id) ? String(fineractAcct.resourceId || fineractAcct.id) : glCode;

          await pool.query(
            'UPDATE client_sub_ledgers SET fineract_savings_id = $1, updated_at = NOW() WHERE sub_ledger_id = $2',
            [fineractId, sl.sub_ledger_id]
          );

          // Post opening JE in Fineract if balance > 0
          if (parseFloat(sl.balance) > 0) {
            try {
              await FineractClient.postJournalEntry({
                officeId: 1,
                transactionDate: new Date(),
                comments: 'Sub-ledger opening balance: ' + sl.sub_account_name,
                debits: [{ glAccountId: parseInt(fineractId) || 1, amount: parseFloat(sl.balance) }],
                credits: [{ glAccountId: 1, amount: parseFloat(sl.balance) }],
              });
            } catch (jeErr) {
              // Non-fatal — GL account exists but JE may fail if Fineract IDs aren't numeric
              console.warn('[SubLedger] Fineract JE failed for ' + sl.sub_ledger_id + ':', jeErr.message);
            }
          }

          synced++;
        } catch (err) {
          failed++;
          errors.push({ subLedgerId: sl.sub_ledger_id, error: err.message });
        }
      }
    } catch (outerErr) {
      errors.push({ phase: 'query', error: outerErr.message });
    }

    return { synced: synced, skipped: skipped, failed: failed, errors: errors };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  AUTO-CREATE SUB-LEDGERS FROM BOND SUBSCRIPTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * For each CRM bond subscription, create a bond_investment sub-ledger
   * if one doesn't already exist.
   */
  static async syncFromSubscriptions() {
    var synced = 0;
    var skipped = 0;
    var errors = [];

    try {
      var subs = await pool.query(`
        SELECT s.subscription_id, s.contact_id, s.bond_id, s.subscription_amount,
               c.first_name, c.last_name, b.bond_name
        FROM crm_bond_subscriptions s
        JOIN crm_contacts c ON c.contact_id = s.contact_id
        JOIN bonds b ON b.id = s.bond_id
        WHERE s.status = 'active'
      `);

      for (var i = 0; i < subs.rows.length; i++) {
        var sub = subs.rows[i];
        try {
          // Check if sub-ledger already exists for this contact + bond investment
          var existing = await pool.query(
            `SELECT 1 FROM client_sub_ledgers
             WHERE contact_id = $1 AND parent_account_code = '1100'
               AND sub_account_type = 'bond_investment'
               AND notes LIKE $2`,
            [sub.contact_id, '%' + sub.subscription_id + '%']
          );

          if (existing.rows.length > 0) { skipped++; continue; }

          var name = sub.first_name + ' ' + sub.last_name + ' — ' + sub.bond_name + ' Investment';
          await SubLedgerEngine.createSubLedger({
            contactId: sub.contact_id,
            parentAccountCode: '1100',
            subAccountName: name,
            subAccountType: 'bond_investment',
            openingBalance: sub.subscription_amount,
            notes: 'Auto-created from subscription ' + sub.subscription_id,
          });
          synced++;
        } catch (err) {
          errors.push({ subscriptionId: sub.subscription_id, error: err.message });
        }
      }
    } catch (outerErr) {
      errors.push({ phase: 'query', error: outerErr.message });
    }

    return { synced: synced, skipped: skipped, errors: errors };
  }
}

module.exports = { SubLedgerEngine };
