/**
 * Trust Accounting Engine — DLB Trust Platform
 *
 * Double-entry trust accounting with chart of accounts, journal entries,
 * trial balance, income statement, and balance sheet generation.
 * Integrates with Fineract GL for reconciliation.
 * All storage via PostgreSQL (fineract_tenants).
 */

'use strict';

const pool = require('../bonds/pgPool');
const { FineractClient } = require('../fineract/fineractClient');

class TrustAccountingEngine {

  // ─── Chart of Accounts ────────────────────────────────────────────────────

  static async createAccount({
    accountCode, accountName, accountType, subType,
    parentAccountCode, linkedCashAccount, linkedFineractGl,
    description,
  }) {
    const result = await pool.query(
      `INSERT INTO trust_accounts
         (account_code, account_name, account_type, sub_type,
          parent_account_code, linked_cash_account, linked_fineract_gl, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        accountCode, accountName, accountType, subType || null,
        parentAccountCode || null, linkedCashAccount || null,
        linkedFineractGl || null, description || null,
      ]
    );
    return result.rows[0];
  }

  static async getAccount(accountCode) {
    const result = await pool.query(
      `SELECT * FROM trust_accounts WHERE account_code = $1`,
      [accountCode]
    );
    return result.rows[0] || null;
  }

  static async listAccounts({ accountType, subType, isActive } = {}) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (accountType) { conditions.push(`account_type = $${idx++}`); params.push(accountType); }
    if (subType) { conditions.push(`sub_type = $${idx++}`); params.push(subType); }
    if (isActive !== undefined) { conditions.push(`is_active = $${idx++}`); params.push(isActive); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await pool.query(
      `SELECT * FROM trust_accounts ${where}
       ORDER BY account_code ASC`,
      params
    );
    return result.rows;
  }

  static async updateAccount(accountCode, updates) {
    const fields = [];
    const params = [];
    let idx = 1;

    const allowed = [
      'account_name', 'sub_type', 'parent_account_code',
      'linked_cash_account', 'linked_fineract_gl',
      'is_active', 'description',
    ];

    const fieldMap = {
      accountName: 'account_name', subType: 'sub_type',
      parentAccountCode: 'parent_account_code',
      linkedCashAccount: 'linked_cash_account',
      linkedFineractGl: 'linked_fineract_gl',
      isActive: 'is_active',
    };

    for (const [key, val] of Object.entries(updates)) {
      const col = fieldMap[key] || key;
      if (allowed.includes(col) && val !== undefined) {
        fields.push(`${col} = $${idx++}`);
        params.push(val);
      }
    }

    if (fields.length === 0) throw new Error('No valid fields to update');

    fields.push(`updated_at = NOW()`);
    params.push(accountCode);

    const result = await pool.query(
      `UPDATE trust_accounts SET ${fields.join(', ')}
       WHERE account_code = $${idx}
       RETURNING *`,
      params
    );
    if (result.rows.length === 0) throw new Error(`Account ${accountCode} not found`);
    return result.rows[0];
  }

  // ─── Journal Entries (Double-Entry) ───────────────────────────────────────

  static async postJournalEntry({
    entryDate, description, lines,
    referenceType, referenceId, bondId,
    postedBy, postToFineract,
  }) {
    if (!lines || lines.length < 2) {
      throw new Error('Journal entry requires at least 2 lines');
    }

    let totalDebits = 0;
    let totalCredits = 0;
    for (const line of lines) {
      totalDebits += parseFloat(line.debitAmount || 0);
      totalCredits += parseFloat(line.creditAmount || 0);
    }

    if (Math.abs(totalDebits - totalCredits) > 0.01) {
      throw new Error(`Debits ($${totalDebits.toFixed(2)}) must equal credits ($${totalCredits.toFixed(2)})`);
    }

    const entryId = 'JRN-' + Date.now() + '-'
      + Math.random().toString(36).slice(2, 8).toUpperCase();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO trust_journal_entries
           (entry_id, entry_date, description, reference_type, reference_id,
            bond_id, posted_by, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'posted')`,
        [
          entryId, entryDate || new Date(), description,
          referenceType || null, referenceId || null,
          bondId || null, postedBy || null,
        ]
      );

      for (const line of lines) {
        await client.query(
          `INSERT INTO trust_journal_lines
             (entry_id, account_code, debit_amount, credit_amount, memo)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            entryId, line.accountCode,
            parseFloat(line.debitAmount || 0),
            parseFloat(line.creditAmount || 0),
            line.memo || null,
          ]
        );

        const netAmount = parseFloat(line.debitAmount || 0) - parseFloat(line.creditAmount || 0);

        const acctResult = await client.query(
          `SELECT account_type FROM trust_accounts WHERE account_code = $1`,
          [line.accountCode]
        );
        if (acctResult.rows.length === 0) {
          throw new Error(`Account ${line.accountCode} not found`);
        }

        const acctType = acctResult.rows[0].account_type;
        let balanceChange = 0;
        if (acctType === 'asset' || acctType === 'expense') {
          balanceChange = netAmount;
        } else {
          balanceChange = -netAmount;
        }

        await client.query(
          `UPDATE trust_accounts SET balance = balance + $1, updated_at = NOW()
           WHERE account_code = $2`,
          [balanceChange, line.accountCode]
        );
      }

      await client.query('COMMIT');

      if (postToFineract) {
        try {
          const fineractDebits = lines
            .filter(l => parseFloat(l.debitAmount || 0) > 0)
            .map(l => ({ glAccountId: parseInt(l.fineractGlId || 1), amount: parseFloat(l.debitAmount) }));
          const fineractCredits = lines
            .filter(l => parseFloat(l.creditAmount || 0) > 0)
            .map(l => ({ glAccountId: parseInt(l.fineractGlId || 2), amount: parseFloat(l.creditAmount) }));

          if (fineractDebits.length > 0 && fineractCredits.length > 0) {
            const glResult = await FineractClient.postJournalEntry({
              officeId: 1,
              transactionDate: new Date(entryDate || Date.now()),
              credits: fineractCredits,
              debits: fineractDebits,
              comments: `Trust JE ${entryId}: ${description}`,
            });

            const fineractTxnId = glResult && glResult.resourceId ? String(glResult.resourceId) : null;
            if (fineractTxnId) {
              await pool.query(
                `UPDATE trust_journal_entries SET fineract_txn_id = $1
                 WHERE entry_id = $2`,
                [fineractTxnId, entryId]
              );
            }
          }
        } catch (glErr) {
          console.warn('[TrustAccounting] Fineract GL post failed (entry still recorded):', glErr.message);
        }
      }

      const entry = await pool.query(
        `SELECT * FROM trust_journal_entries WHERE entry_id = $1`,
        [entryId]
      );
      const entryLines = await pool.query(
        `SELECT * FROM trust_journal_lines WHERE entry_id = $1 ORDER BY id`,
        [entryId]
      );

      return {
        ...entry.rows[0],
        lines: entryLines.rows,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  static async getJournalEntry(entryId) {
    const entry = await pool.query(
      `SELECT * FROM trust_journal_entries WHERE entry_id = $1`,
      [entryId]
    );
    if (entry.rows.length === 0) return null;

    const lines = await pool.query(
      `SELECT jl.*, ta.account_name, ta.account_type
       FROM trust_journal_lines jl
       JOIN trust_accounts ta ON ta.account_code = jl.account_code
       WHERE jl.entry_id = $1 ORDER BY jl.id`,
      [entryId]
    );

    return { ...entry.rows[0], lines: lines.rows };
  }

  static async listJournalEntries({
    fromDate, toDate, status, bondId, referenceType,
    limit, offset,
  } = {}) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (fromDate) { conditions.push(`entry_date >= $${idx++}`); params.push(fromDate); }
    if (toDate) { conditions.push(`entry_date <= $${idx++}`); params.push(toDate); }
    if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
    if (bondId) { conditions.push(`bond_id = $${idx++}`); params.push(bondId); }
    if (referenceType) { conditions.push(`reference_type = $${idx++}`); params.push(referenceType); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const lim = parseInt(limit) || 100;
    const off = parseInt(offset) || 0;

    const result = await pool.query(
      `SELECT * FROM trust_journal_entries ${where}
       ORDER BY entry_date DESC, created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, lim, off]
    );
    return result.rows;
  }

  static async reverseJournalEntry(entryId, { postedBy } = {}) {
    const original = await TrustAccountingEngine.getJournalEntry(entryId);
    if (!original) throw new Error(`Journal entry ${entryId} not found`);
    if (original.status !== 'posted') throw new Error(`Cannot reverse ${original.status} entry`);

    const reversalLines = original.lines.map(line => ({
      accountCode: line.account_code,
      debitAmount: parseFloat(line.credit_amount),
      creditAmount: parseFloat(line.debit_amount),
      memo: `Reversal of ${entryId}: ${line.memo || ''}`,
    }));

    const reversal = await TrustAccountingEngine.postJournalEntry({
      entryDate: new Date(),
      description: `Reversal of ${entryId}: ${original.description}`,
      lines: reversalLines,
      referenceType: 'reversal',
      referenceId: entryId,
      bondId: original.bond_id,
      postedBy,
    });

    await pool.query(
      `UPDATE trust_journal_entries SET status = 'reversed' WHERE entry_id = $1`,
      [entryId]
    );

    await pool.query(
      `UPDATE trust_journal_entries SET reversal_of = $1 WHERE entry_id = $2`,
      [entryId, reversal.entry_id]
    );

    return reversal;
  }

  // ─── Financial Reports ────────────────────────────────────────────────────

  static async getTrialBalance({ asOfDate } = {}) {
    let joinFilter = '';
    const params = [];

    if (asOfDate) {
      joinFilter = 'AND je.entry_date <= $1 AND je.status = \'posted\'';
      params.push(asOfDate);
    } else {
      joinFilter = 'AND je.status = \'posted\'';
    }

    const result = await pool.query(`
      SELECT
        ta.account_code,
        ta.account_name,
        ta.account_type,
        ta.sub_type,
        COALESCE(SUM(jl.debit_amount), 0) AS total_debits,
        COALESCE(SUM(jl.credit_amount), 0) AS total_credits,
        ta.balance AS current_balance
      FROM trust_accounts ta
      LEFT JOIN trust_journal_lines jl ON jl.account_code = ta.account_code
      LEFT JOIN trust_journal_entries je ON je.entry_id = jl.entry_id
        ${joinFilter}
      WHERE ta.is_active = TRUE
      GROUP BY ta.account_code, ta.account_name, ta.account_type, ta.sub_type, ta.balance
      ORDER BY ta.account_code
    `, params);

    const accounts = result.rows;
    const totalDebits = accounts.reduce((s, a) => s + parseFloat(a.total_debits), 0);
    const totalCredits = accounts.reduce((s, a) => s + parseFloat(a.total_credits), 0);

    return {
      as_of_date: asOfDate || new Date().toISOString().split('T')[0],
      accounts,
      total_debits: Math.round(totalDebits * 100) / 100,
      total_credits: Math.round(totalCredits * 100) / 100,
      is_balanced: Math.abs(totalDebits - totalCredits) < 0.01,
      generated_at: new Date().toISOString(),
    };
  }

  static async getBalanceSheet({ asOfDate } = {}) {
    const accounts = await TrustAccountingEngine.listAccounts({ isActive: true });

    const assets = accounts.filter(a => a.account_type === 'asset');
    const liabilities = accounts.filter(a => a.account_type === 'liability');
    const equity = accounts.filter(a => a.account_type === 'equity');

    const sumBalance = (arr) => arr.reduce((s, a) => s + parseFloat(a.balance), 0);

    const totalAssets = sumBalance(assets);
    const totalLiabilities = sumBalance(liabilities);
    const totalEquity = sumBalance(equity);

    return {
      as_of_date: asOfDate || new Date().toISOString().split('T')[0],
      assets: assets.map(a => ({ account_code: a.account_code, account_name: a.account_name, sub_type: a.sub_type, balance: parseFloat(a.balance) })),
      liabilities: liabilities.map(a => ({ account_code: a.account_code, account_name: a.account_name, sub_type: a.sub_type, balance: parseFloat(a.balance) })),
      equity: equity.map(a => ({ account_code: a.account_code, account_name: a.account_name, sub_type: a.sub_type, balance: parseFloat(a.balance) })),
      total_assets: Math.round(totalAssets * 100) / 100,
      total_liabilities: Math.round(totalLiabilities * 100) / 100,
      total_equity: Math.round(totalEquity * 100) / 100,
      total_liabilities_and_equity: Math.round((totalLiabilities + totalEquity) * 100) / 100,
      is_balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
      generated_at: new Date().toISOString(),
    };
  }

  static async getIncomeStatement({ fromDate, toDate } = {}) {
    const accounts = await TrustAccountingEngine.listAccounts({ isActive: true });

    const income = accounts.filter(a => a.account_type === 'income');
    const expenses = accounts.filter(a => a.account_type === 'expense');

    const sumBalance = (arr) => arr.reduce((s, a) => s + parseFloat(a.balance), 0);

    const totalIncome = sumBalance(income);
    const totalExpenses = sumBalance(expenses);
    const netIncome = totalIncome - totalExpenses;

    return {
      period_start: fromDate || null,
      period_end: toDate || new Date().toISOString().split('T')[0],
      income: income.map(a => ({ account_code: a.account_code, account_name: a.account_name, sub_type: a.sub_type, balance: parseFloat(a.balance) })),
      expenses: expenses.map(a => ({ account_code: a.account_code, account_name: a.account_name, sub_type: a.sub_type, balance: parseFloat(a.balance) })),
      total_income: Math.round(totalIncome * 100) / 100,
      total_expenses: Math.round(totalExpenses * 100) / 100,
      net_income: Math.round(netIncome * 100) / 100,
      generated_at: new Date().toISOString(),
    };
  }

  // ─── Accounting Periods ───────────────────────────────────────────────────

  static async listPeriods({ status } = {}) {
    const conditions = [];
    const params = [];

    if (status) { conditions.push('status = $1'); params.push(status); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(
      `SELECT * FROM trust_periods ${where} ORDER BY start_date DESC`,
      params
    );
    return result.rows;
  }

  static async createPeriod({ periodName, startDate, endDate }) {
    const result = await pool.query(
      `INSERT INTO trust_periods (period_name, start_date, end_date, status)
       VALUES ($1, $2, $3, 'open')
       RETURNING *`,
      [periodName, startDate, endDate]
    );
    return result.rows[0];
  }

  static async closePeriod(periodId, { closedBy } = {}) {
    const result = await pool.query(
      `UPDATE trust_periods
       SET status = 'closed', closed_by = $1, closed_at = NOW()
       WHERE id = $2 AND status = 'open'
       RETURNING *`,
      [closedBy || null, periodId]
    );
    if (result.rows.length === 0) throw new Error(`Period ${periodId} not found or not open`);
    return result.rows[0];
  }

  // ─── Accounting Dashboard ─────────────────────────────────────────────────

  static async getDashboard() {
    const accounts = await TrustAccountingEngine.listAccounts({ isActive: true });
    const sumByType = (type) => accounts
      .filter(a => a.account_type === type)
      .reduce((s, a) => s + parseFloat(a.balance), 0);

    const journalCount = await pool.query(
      `SELECT COUNT(*) AS count FROM trust_journal_entries WHERE status = 'posted'`
    );
    const periodCount = await pool.query(
      `SELECT
        COUNT(CASE WHEN status = 'open' THEN 1 END) AS open_periods,
        COUNT(CASE WHEN status = 'closed' THEN 1 END) AS closed_periods
       FROM trust_periods`
    );

    return {
      total_assets: Math.round(sumByType('asset') * 100) / 100,
      total_liabilities: Math.round(sumByType('liability') * 100) / 100,
      total_equity: Math.round(sumByType('equity') * 100) / 100,
      total_income: Math.round(sumByType('income') * 100) / 100,
      total_expenses: Math.round(sumByType('expense') * 100) / 100,
      net_income: Math.round((sumByType('income') - sumByType('expense')) * 100) / 100,
      account_count: accounts.length,
      journal_entries_count: parseInt(journalCount.rows[0].count),
      open_periods: parseInt(periodCount.rows[0].open_periods),
      closed_periods: parseInt(periodCount.rows[0].closed_periods),
      generated_at: new Date().toISOString(),
    };
  }
}

module.exports = { TrustAccountingEngine };
