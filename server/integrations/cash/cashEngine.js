/**
 * Cash Management Engine — DLB Trust Platform
 *
 * Manages cash accounts, inter-account transfers, deposits, and Fineract reconciliation.
 * All storage via PostgreSQL (fineract_tenants).
 */

'use strict';

const pool = require('../bonds/pgPool');
const { FineractClient } = require('../fineract/fineractClient');

class CashEngine {

  static async init() {
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('cash_accounts', 'cash_movements')`
    );
    return {
      cash_accounts: tables.rows.some(r => r.table_name === 'cash_accounts'),
      cash_movements: tables.rows.some(r => r.table_name === 'cash_movements'),
    };
  }

  static async createAccount({ accountId, accountName, accountType, linkedFineractAccountId, notes }) {
    const id = accountId || 'CA-' + Date.now();
    const result = await pool.query(
      `INSERT INTO cash_accounts (account_id, account_name, account_type, linked_fineract_account_id, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, accountName, accountType, linkedFineractAccountId || null, notes || null]
    );
    return result.rows[0];
  }

  static async getAccount(accountId) {
    const result = await pool.query(
      `SELECT * FROM cash_accounts WHERE account_id = $1`,
      [accountId]
    );
    return result.rows[0] || null;
  }

  static async listAccounts({ type, status } = {}) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (type) { conditions.push(`account_type = $${idx++}`); params.push(type); }
    if (status) { conditions.push(`status = $${idx++}`); params.push(status); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(
      `SELECT * FROM cash_accounts ${where} ORDER BY created_at DESC`,
      params
    );
    return result.rows;
  }

  static async transfer({
    fromAccountId, toAccountId, amountCents, movementType, memo,
    referenceId, referenceType, initiatedBy, glDebitAccountId, glCreditAccountId,
    requireFineractPost,
  }) {
    // Validate GL mapping: if either GL ID is provided, both must be present
    if (glDebitAccountId && !glCreditAccountId) {
      throw new Error('GL mapping incomplete: glDebitAccountId provided but glCreditAccountId is missing');
    }
    if (!glDebitAccountId && glCreditAccountId) {
      throw new Error('GL mapping incomplete: glCreditAccountId provided but glDebitAccountId is missing');
    }
    if (requireFineractPost && (!glDebitAccountId || !glCreditAccountId)) {
      throw new Error('Fineract GL post required but GL account mappings are missing — provide both glDebitAccountId and glCreditAccountId');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Deduct from source
      const fromResult = await client.query(
        `UPDATE cash_accounts SET balance_cents = balance_cents - $1, updated_at = NOW()
         WHERE account_id = $2 AND status = 'active'
         RETURNING *`,
        [amountCents, fromAccountId]
      );
      if (fromResult.rows.length === 0) {
        throw new Error(`Source account ${fromAccountId} not found or not active`);
      }
      if (parseFloat(fromResult.rows[0].balance_cents) < 0) {
        throw new Error(`Insufficient balance in ${fromAccountId}`);
      }

      // Credit destination
      const toResult = await client.query(
        `UPDATE cash_accounts SET balance_cents = balance_cents + $1, updated_at = NOW()
         WHERE account_id = $2 AND status = 'active'
         RETURNING *`,
        [amountCents, toAccountId]
      );
      if (toResult.rows.length === 0) {
        throw new Error(`Destination account ${toAccountId} not found or not active`);
      }

      const movementId = 'MOV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();

      const movResult = await client.query(
        `INSERT INTO cash_movements
           (movement_id, from_account_id, to_account_id, amount_cents, movement_type,
            reference_id, reference_type, gl_journal_id, memo, initiated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [movementId, fromAccountId, toAccountId, amountCents, movementType || 'transfer',
         referenceId || null, referenceType || null, null, memo || null, initiatedBy || null]
      );

      await client.query('COMMIT');

      // Post GL entry after commit to avoid inconsistency on rollback
      if (glDebitAccountId && glCreditAccountId) {
        try {
          const amountDollars = amountCents / 100;
          const glResult = await FineractClient.postJournalEntry({
            officeId: 1,
            transactionDate: new Date(),
            credits: [{ glAccountId: glCreditAccountId, amount: amountDollars }],
            debits: [{ glAccountId: glDebitAccountId, amount: amountDollars }],
            comments: `Cash transfer ${movementId}: ${fromAccountId} → ${toAccountId}`,
          });
          const glJournalId = glResult && glResult.resourceId ? String(glResult.resourceId) : null;
          if (glJournalId) {
            await pool.query(
              `UPDATE cash_movements SET gl_journal_id = $1 WHERE movement_id = $2`,
              [glJournalId, movementId]
            );
          }
        } catch (glErr) {
          console.warn('[CashEngine] GL post failed (transfer still recorded):', glErr.message);
        }
      }

      return movResult.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  static async deposit({ toAccountId, amountCents, memo, referenceId, initiatedBy }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const acctResult = await client.query(
        `UPDATE cash_accounts SET balance_cents = balance_cents + $1, updated_at = NOW()
         WHERE account_id = $2 AND status = 'active'
         RETURNING *`,
        [amountCents, toAccountId]
      );
      if (acctResult.rows.length === 0) {
        throw new Error(`Account ${toAccountId} not found or not active`);
      }

      const movementId = 'MOV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();

      const movResult = await client.query(
        `INSERT INTO cash_movements
           (movement_id, to_account_id, amount_cents, movement_type, reference_id, memo, initiated_by)
         VALUES ($1, $2, $3, 'deposit', $4, $5, $6)
         RETURNING *`,
        [movementId, toAccountId, amountCents, referenceId || null, memo || null, initiatedBy || null]
      );

      await client.query('COMMIT');
      return movResult.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  static async getPositionSummary() {
    const result = await pool.query(
      `SELECT account_type, SUM(balance_cents) AS total_cents, COUNT(*) AS account_count
       FROM cash_accounts
       WHERE status = 'active'
       GROUP BY account_type
       ORDER BY account_type`
    );

    const byType = {};
    let grandTotal = 0;
    for (const row of result.rows) {
      byType[row.account_type] = {
        total_cents: parseInt(row.total_cents, 10),
        account_count: parseInt(row.account_count, 10),
      };
      grandTotal += parseInt(row.total_cents, 10);
    }

    return {
      by_type: byType,
      grand_total_cents: grandTotal,
      grand_total_dollars: grandTotal / 100,
      generated_at: new Date().toISOString(),
    };
  }

  static async getMovements({ fromAccountId, toAccountId, movementType, fromDate, toDate, limit, offset } = {}) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (fromAccountId) { conditions.push(`from_account_id = $${idx++}`); params.push(fromAccountId); }
    if (toAccountId) { conditions.push(`to_account_id = $${idx++}`); params.push(toAccountId); }
    if (movementType) { conditions.push(`movement_type = $${idx++}`); params.push(movementType); }
    if (fromDate) { conditions.push(`created_at >= $${idx++}`); params.push(fromDate); }
    if (toDate) { conditions.push(`created_at <= $${idx++}`); params.push(toDate); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const lim = limit ? parseInt(limit, 10) : 100;
    const off = offset ? parseInt(offset, 10) : 0;

    params.push(lim, off);
    const result = await pool.query(
      `SELECT * FROM cash_movements ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      params
    );
    return result.rows;
  }

  static async reconcile(accountId) {
    const acct = await CashEngine.getAccount(accountId);
    if (!acct) throw new Error(`Account ${accountId} not found`);

    if (!acct.linked_fineract_account_id) {
      return {
        account_id: accountId,
        local_balance_cents: parseInt(acct.balance_cents, 10),
        fineract_balance_cents: null,
        discrepancy_cents: null,
        in_sync: null,
        message: 'No linked Fineract account',
      };
    }

    try {
      const fineractAcct = await FineractClient.getAccountBalance(acct.linked_fineract_account_id);
      const fineractBalanceCents = Math.round((fineractAcct.summary?.accountBalance || 0) * 100);
      const localBalanceCents = parseInt(acct.balance_cents, 10);
      const discrepancy = localBalanceCents - fineractBalanceCents;

      return {
        account_id: accountId,
        local_balance_cents: localBalanceCents,
        fineract_balance_cents: fineractBalanceCents,
        discrepancy_cents: discrepancy,
        in_sync: discrepancy === 0,
      };
    } catch (err) {
      return {
        account_id: accountId,
        local_balance_cents: parseInt(acct.balance_cents, 10),
        fineract_balance_cents: null,
        discrepancy_cents: null,
        in_sync: null,
        error: err.message,
      };
    }
  }
}

module.exports = { CashEngine };
