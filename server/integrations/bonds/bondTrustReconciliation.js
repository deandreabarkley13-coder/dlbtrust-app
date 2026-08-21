'use strict';

/**
 * Reconcile trust-accounting and sub-ledger balances with the live BondEngine.
 * Makes DLB-PRB the single source of truth for fixed-income assets.
 */

const { BondEngine } = require('./bondEngine');
const pool = require('./pgPool');

class BondTrustReconciliation {
  static async resolveBondId(client, bondIdOrName) {
    if (typeof bondIdOrName === 'number' || /^\d+$/.test(String(bondIdOrName))) {
      const r = await client.query('SELECT id FROM bonds WHERE id = $1', [Number(bondIdOrName)]);
      if (r.rows.length) return r.rows[0].id;
    }
    const r = await client.query(
      'SELECT id FROM bonds WHERE bond_name = $1 OR isin = $1 LIMIT 1',
      [String(bondIdOrName)]
    );
    if (!r.rows.length) throw new Error(`Bond not found: ${bondIdOrName}`);
    return r.rows[0].id;
  }

  static async sync(bondIdOrName = 'DLB-PRB') {
    const client = await pool.connect();
    try {
      const bondId = await this.resolveBondId(client, bondIdOrName);
      const today = new Date().toISOString().split('T')[0];

      // Recompute amortized bond state up to today
      const amortized = await BondEngine.applyAmortization(bondId, today);
      const bond = await BondEngine.getBond(bondId);
      const principal = Number(bond.principal_balance || 0);
      const accrued = Number(bond.accrued_interest || 0);
      const totalInterestPaid = Number(bond.total_interest_paid || 0);
      const totalInterestAccrued = totalInterestPaid + accrued;
      const totalPrincipalPaid = Number(bond.total_principal_paid || 0);

      await client.query('BEGIN');

      const journalBalances = await client.query(
        `SELECT ta.account_code, ta.account_type, ta.balance AS stored_balance,
                COALESCE(SUM(
                  CASE WHEN je.entry_id IS NOT NULL AND ta.account_type IN ('asset', 'expense')
                    THEN jl.debit_amount - jl.credit_amount
                    WHEN je.entry_id IS NOT NULL THEN jl.credit_amount - jl.debit_amount
                    ELSE 0
                  END
                ), 0) AS journal_balance
         FROM trust_accounts ta
         LEFT JOIN trust_journal_lines jl ON jl.account_code = ta.account_code
         LEFT JOIN trust_journal_entries je ON je.entry_id = jl.entry_id AND je.status = 'posted'
         WHERE ta.account_code = ANY($1::text[])
         GROUP BY ta.account_code, ta.account_type, ta.balance`,
        [['1100', '1200', '4000']]
      );
      const bondBalances = { '1100': principal, '1200': accrued, '4000': totalInterestAccrued };
      const trustAccountDrift = ['1100', '1200', '4000'].map((accountCode) => {
        const row = journalBalances.rows.find((item) => item.account_code === accountCode) || {};
        const journalBalance = Number(row.journal_balance || 0);
        const bondBalance = bondBalances[accountCode];
        const drift = bondBalance - journalBalance;
        if (Math.abs(drift) > 0.005) {
          console.warn(`[BondTrustReconciliation] ${accountCode} drift: BondEngine ${bondBalance.toFixed(2)} vs journal ${journalBalance.toFixed(2)} (${drift.toFixed(2)})`);
        } else {
          console.log(`[BondTrustReconciliation] ${accountCode} reconciled at ${journalBalance.toFixed(2)}`);
        }
        return {
          account_code: accountCode,
          bond_engine_balance: bondBalance,
          journal_balance: journalBalance,
          stored_balance: Number(row.stored_balance || 0),
          drift,
        };
      });

      // Bond proceeds cash is already represented by the bond asset; zero to avoid double counting
      await client.query(
        `UPDATE cash_accounts SET balance_cents = 0, updated_at = NOW() WHERE account_id = $1`,
        ['CA-BOND-PROCEEDS']
      );

      // Sub-ledgers: principal investment
      const principalSl = await client.query(
        `SELECT sub_ledger_id FROM client_sub_ledgers
         WHERE parent_account_code = '1100' AND sub_account_type = 'bond_investment'
         ORDER BY created_at DESC LIMIT 1`
      );
      if (principalSl.rows.length) {
        await client.query(
          `UPDATE client_sub_ledgers SET balance = $1, updated_at = NOW() WHERE sub_ledger_id = $2`,
          [principal, principalSl.rows[0].sub_ledger_id]
        );
      }

      // Sub-ledgers: accrued interest
      const accruedSl = await client.query(
        `SELECT sub_ledger_id FROM client_sub_ledgers
         WHERE parent_account_code = '1200' AND sub_account_type = 'accrued_interest'
         ORDER BY created_at DESC LIMIT 1`
      );
      if (accruedSl.rows.length) {
        await client.query(
          `UPDATE client_sub_ledgers SET balance = $1, updated_at = NOW() WHERE sub_ledger_id = $2`,
          [accrued, accruedSl.rows[0].sub_ledger_id]
        );
      }

      await client.query('COMMIT');

      return {
        bond_id: bondId,
        bond_name: bond.bond_name,
        principal_balance: principal,
        accrued_interest: accrued,
        total_interest_paid: totalInterestPaid,
        total_interest_accrued: totalInterestAccrued,
        total_principal_paid: totalPrincipalPaid,
        amortization_applied: amortized,
        trust_account_drift: trustAccountDrift,
        trust_accounts_updated: false,
        cash_bond_proceeds_zeroed: 'CA-BOND-PROCEEDS',
      };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (e) { /* no active transaction */ }
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = { BondTrustReconciliation };
