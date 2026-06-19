/**
 * Fixed Income Orchestrator — Engine Integration Layer
 *
 * Bridges the Bond Engine, Cash Engine, Trust Accounting, and Fineract GL
 * into a unified pipeline. When a bond operation occurs (accrual, interest
 * payment, principal payment), this orchestrator:
 *
 *   1. Executes the bond/cash operation (BondEngine)
 *   2. Creates a double-entry trust journal entry (TrustAccountingEngine)
 *   3. Auto-resolves and posts Fineract GL entries (GLResolver + FineractClient)
 *   4. Records a cashflow event for reporting
 *
 * Trust Chart Account Codes (from seed):
 *   1000 Cash & Equivalents (asset/cash)
 *   1100 Bond Portfolio (asset/investment)
 *   1200 Accrued Interest Receivable (asset/receivable)
 *   4100 Interest Income (income)
 *   5100 Management Fees (expense)
 */

'use strict';

const pool = require('./pgPool');
const { BondEngine } = require('./bondEngine');
const { GLResolver } = require('./glResolver');
const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');

// Default trust chart account codes for bond operations
const ACCT = {
  CASH:                '1000',
  BOND_PORTFOLIO:      '1100',
  ACCRUED_INTEREST:    '1200',
  INTEREST_INCOME:     '4100',
  BOND_PAYABLE:        '2100',
};

class FixedIncomeOrchestrator {

  /**
   * Accrue interest on a bond with full GL + accounting integration.
   *
   * Accounting entry:
   *   DR 1200 Accrued Interest Receivable
   *   CR 4100 Interest Income
   */
  static async accrueWithGL(bondId, toDate) {
    // Resolve GL mappings
    const { debitGlId, creditGlId } = await GLResolver.resolvePair(
      'accrual', ACCT.ACCRUED_INTEREST, ACCT.INTEREST_INCOME, bondId
    );

    // Execute accrual with GL posting
    const result = await BondEngine.accrueInterest(bondId, toDate, {
      glDebitAccountId: debitGlId,
      glCreditAccountId: creditGlId,
    });

    if (result.accrued <= 0) return result;

    // Post to trust accounting
    try {
      const bond = await BondEngine.getBond(bondId);
      const entry = await TrustAccountingEngine.postJournalEntry({
        entryDate: result.to_date,
        description: `Bond interest accrual: ${bond.bond_name} (${result.days} days)`,
        lines: [
          {
            accountCode: ACCT.ACCRUED_INTEREST,
            debitAmount: result.accrued,
            creditAmount: 0,
            fineractGlId: debitGlId,
            memo: `Accrued interest ${result.from_date} to ${result.to_date}`,
          },
          {
            accountCode: ACCT.INTEREST_INCOME,
            debitAmount: 0,
            creditAmount: result.accrued,
            fineractGlId: creditGlId,
            memo: `Interest income on ${bond.bond_name}`,
          },
        ],
        referenceType: 'bond_accrual',
        referenceId: String(bondId),
        bondId,
        postToFineract: !!(debitGlId && creditGlId),
      });
      result.journal_entry_id = entry.entry_id;
    } catch (err) {
      console.warn('[Orchestrator] Trust journal post failed (accrual still recorded):', err.message);
    }

    // Record cashflow event
    await FixedIncomeOrchestrator._recordCashflowEvent({
      eventType: 'bond_accrual',
      category: 'operating',
      amount: result.accrued,
      direction: 'inflow',
      bondId,
      description: `Interest accrual: ${result.days} days`,
      eventDate: result.to_date,
    });

    return result;
  }

  /**
   * Pay interest on a bond with full GL + accounting integration.
   *
   * Accounting entry:
   *   DR 1000 Cash & Equivalents (cash received)
   *   CR 1200 Accrued Interest Receivable (reduces receivable)
   */
  static async payInterestWithGL(bondId, amount) {
    const { debitGlId, creditGlId } = await GLResolver.resolvePair(
      'interest_payment', ACCT.CASH, ACCT.ACCRUED_INTEREST, bondId
    );

    const result = await BondEngine.payInterest(bondId, amount, {
      glDebitAccountId: debitGlId,
      glCreditAccountId: creditGlId,
    });

    // Post to trust accounting
    try {
      const bond = await BondEngine.getBond(bondId);
      const entry = await TrustAccountingEngine.postJournalEntry({
        entryDate: new Date().toISOString().split('T')[0],
        description: `Bond interest payment received: ${bond.bond_name}`,
        lines: [
          {
            accountCode: ACCT.CASH,
            debitAmount: result.paid,
            creditAmount: 0,
            fineractGlId: debitGlId,
            memo: `Interest payment received`,
          },
          {
            accountCode: ACCT.ACCRUED_INTEREST,
            debitAmount: 0,
            creditAmount: result.paid,
            fineractGlId: creditGlId,
            memo: `Accrued interest settled`,
          },
        ],
        referenceType: 'bond_interest_payment',
        referenceId: String(bondId),
        bondId,
        postToFineract: !!(debitGlId && creditGlId),
      });
      result.journal_entry_id = entry.entry_id;
    } catch (err) {
      console.warn('[Orchestrator] Trust journal post failed (payment still recorded):', err.message);
    }

    await FixedIncomeOrchestrator._recordCashflowEvent({
      eventType: 'interest_payment',
      category: 'operating',
      amount: result.paid,
      direction: 'inflow',
      bondId,
      description: `Interest payment: $${result.paid.toFixed(2)}`,
      eventDate: new Date().toISOString().split('T')[0],
    });

    return result;
  }

  /**
   * Process a principal payment with full GL + accounting integration.
   *
   * Accounting entry:
   *   DR 1000 Cash & Equivalents
   *   CR 1100 Bond Portfolio (reduces investment)
   */
  static async payPrincipalWithGL(bondId, amount) {
    const { debitGlId, creditGlId } = await GLResolver.resolvePair(
      'principal_payment', ACCT.CASH, ACCT.BOND_PORTFOLIO, bondId
    );

    const result = await BondEngine.payPrincipal(bondId, amount, {
      glDebitAccountId: debitGlId,
      glCreditAccountId: creditGlId,
    });

    try {
      const bond = await BondEngine.getBond(bondId);
      const entry = await TrustAccountingEngine.postJournalEntry({
        entryDate: new Date().toISOString().split('T')[0],
        description: `Bond principal payment: ${bond.bond_name}` +
          (result.bond_status === 'matured' ? ' (MATURED)' : ''),
        lines: [
          {
            accountCode: ACCT.CASH,
            debitAmount: result.paid,
            creditAmount: 0,
            fineractGlId: debitGlId,
            memo: `Principal payment received`,
          },
          {
            accountCode: ACCT.BOND_PORTFOLIO,
            debitAmount: 0,
            creditAmount: result.paid,
            fineractGlId: creditGlId,
            memo: result.bond_status === 'matured' ? 'Bond matured — principal repaid' : `Principal reduction`,
          },
        ],
        referenceType: 'bond_principal_payment',
        referenceId: String(bondId),
        bondId,
        postToFineract: !!(debitGlId && creditGlId),
      });
      result.journal_entry_id = entry.entry_id;
    } catch (err) {
      console.warn('[Orchestrator] Trust journal post failed (payment still recorded):', err.message);
    }

    await FixedIncomeOrchestrator._recordCashflowEvent({
      eventType: 'principal_payment',
      category: 'investing',
      amount: result.paid,
      direction: 'inflow',
      bondId,
      description: `Principal payment: $${result.paid.toFixed(2)}`,
      eventDate: new Date().toISOString().split('T')[0],
    });

    return result;
  }

  /**
   * Run accrual for all active bonds with GL + accounting integration.
   * Called by the daily scheduler and admin accrue-all.
   */
  static async accrueAllWithGL(toDate) {
    const bonds = await pool.query(
      `SELECT id, bond_name FROM bonds WHERE status = 'active'`
    );

    const results = [];
    let totalAccrued = 0;

    for (const bond of bonds.rows) {
      try {
        const r = await FixedIncomeOrchestrator.accrueWithGL(bond.id, toDate);
        results.push({
          bond_id: bond.id,
          bond_name: bond.bond_name,
          accrued: r.accrued,
          days: r.days,
          journal_entry_id: r.journal_entry_id || null,
          fineract_txn_id: r.fineract_txn_id || null,
        });
        totalAccrued += r.accrued || 0;
      } catch (err) {
        results.push({ bond_id: bond.id, bond_name: bond.bond_name, error: err.message });
      }
    }

    return {
      bonds_processed: results.length,
      total_accrued: Math.round(totalAccrued * 100) / 100,
      results,
      accrued_at: new Date().toISOString(),
    };
  }

  /**
   * Get integrated cashflow summary combining:
   *   - Bond cash flows (accruals, interest payments, principal payments)
   *   - Cash account movements (transfers, deposits)
   *   - Trust journal entries
   */
  static async getIntegratedCashflow({ fromDate, toDate } = {}) {
    const dateConditions = [];
    const params = [];
    let idx = 1;

    if (fromDate) { dateConditions.push(`event_date >= $${idx++}`); params.push(fromDate); }
    if (toDate) { dateConditions.push(`event_date <= $${idx++}`); params.push(toDate); }
    const dateFilter = dateConditions.length > 0 ? 'WHERE ' + dateConditions.join(' AND ') : '';

    // Get cashflow events from our tracking table
    const events = await pool.query(
      `SELECT * FROM cashflow_events ${dateFilter} ORDER BY event_date DESC, created_at DESC`,
      params
    );

    // Also get bond transactions for the period (as source of truth)
    const bondTxnConditions = [];
    const bondParams = [];
    let bIdx = 1;
    if (fromDate) { bondTxnConditions.push(`bt.transaction_date >= $${bIdx++}`); bondParams.push(fromDate); }
    if (toDate) { bondTxnConditions.push(`bt.transaction_date <= $${bIdx++}`); bondParams.push(toDate); }
    const bondDateFilter = bondTxnConditions.length > 0 ? 'AND ' + bondTxnConditions.join(' AND ') : '';

    const bondTxns = await pool.query(`
      SELECT bt.*, b.bond_name, b.coupon_rate, b.face_value
      FROM bond_transactions bt
      JOIN bonds b ON b.id = bt.bond_id
      WHERE 1=1 ${bondDateFilter}
      ORDER BY bt.transaction_date DESC, bt.id DESC
    `, bondParams);

    // Cash movements for the period
    const cashConditions = [];
    const cashParams = [];
    let cIdx = 1;
    if (fromDate) { cashConditions.push(`created_at >= $${cIdx++}`); cashParams.push(fromDate); }
    if (toDate) { cashConditions.push(`created_at <= $${cIdx++}`); cashParams.push(toDate); }
    const cashDateFilter = cashConditions.length > 0 ? 'WHERE ' + cashConditions.join(' AND ') : '';

    const cashMovements = await pool.query(
      `SELECT * FROM cash_movements ${cashDateFilter} ORDER BY created_at DESC`,
      cashParams
    );

    // Categorize bond transactions
    const operating = [];
    const investing = [];
    let operatingTotal = 0;
    let investingTotal = 0;
    let financingTotal = 0;

    for (const txn of bondTxns.rows) {
      const amount = parseFloat(txn.amount);
      if (txn.transaction_type === 'interest_accrual') {
        operating.push({
          date: txn.transaction_date,
          description: `Interest accrual: ${txn.bond_name}`,
          amount,
          type: 'accrual',
        });
        operatingTotal += amount;
      } else if (txn.transaction_type === 'interest_payment') {
        operating.push({
          date: txn.transaction_date,
          description: `Interest payment: ${txn.bond_name}`,
          amount,
          type: 'interest_payment',
        });
        operatingTotal += amount;
      } else if (txn.transaction_type === 'principal_payment' || txn.transaction_type === 'maturity') {
        investing.push({
          date: txn.transaction_date,
          description: `${txn.transaction_type === 'maturity' ? 'Maturity' : 'Principal'}: ${txn.bond_name}`,
          amount,
          type: txn.transaction_type,
        });
        investingTotal += amount;
      } else if (txn.transaction_type === 'issuance') {
        investing.push({
          date: txn.transaction_date,
          description: `Bond issued: ${txn.bond_name}`,
          amount: -amount,
          type: 'issuance',
        });
        investingTotal -= amount;
      }
    }

    // Cash movement totals
    let cashInflowTotal = 0;
    let cashOutflowTotal = 0;
    for (const mov of cashMovements.rows) {
      const amt = parseInt(mov.amount_cents) / 100;
      if (mov.movement_type === 'deposit') {
        cashInflowTotal += amt;
      } else if (mov.from_account_id) {
        cashOutflowTotal += amt;
      }
    }

    return {
      period_start: fromDate || null,
      period_end: toDate || new Date().toISOString().split('T')[0],
      operating: {
        items: operating,
        total: Math.round(operatingTotal * 100) / 100,
        label: 'Operating Activities (Bond Interest)',
      },
      investing: {
        items: investing,
        total: Math.round(investingTotal * 100) / 100,
        label: 'Investing Activities (Bond Principal)',
      },
      financing: {
        items: [],
        total: Math.round(financingTotal * 100) / 100,
        label: 'Financing Activities',
      },
      cash_movements: {
        deposits: Math.round(cashInflowTotal * 100) / 100,
        transfers: Math.round(cashOutflowTotal * 100) / 100,
        net: Math.round((cashInflowTotal - cashOutflowTotal) * 100) / 100,
      },
      net_cashflow: Math.round((operatingTotal + investingTotal + financingTotal) * 100) / 100,
      bond_transactions_count: bondTxns.rows.length,
      cash_movements_count: cashMovements.rows.length,
      cashflow_events_count: events.rows.length,
      generated_at: new Date().toISOString(),
    };
  }

  /**
   * Get a complete fixed income dashboard combining all engine data.
   */
  static async getDashboard() {
    const [bonds, position, glMappings] = await Promise.all([
      BondEngine.listBonds(),
      pool.query(`SELECT COUNT(*) as count FROM fineract_gl_mappings WHERE is_active = TRUE`),
      pool.query(`SELECT COUNT(*) as count FROM fineract_gl_mappings WHERE mapping_type = 'trust_journal' AND is_active = TRUE`),
    ]);

    const activeBonds = bonds.filter(b => b.status === 'active');
    const totalPrincipal = activeBonds.reduce((s, b) => s + parseFloat(b.principal_balance || 0), 0);
    const totalAccrued = activeBonds.reduce((s, b) => s + parseFloat(b.accrued_interest || 0), 0);
    const totalInterestPaid = bonds.reduce((s, b) => s + parseFloat(b.total_interest_paid || 0), 0);
    const totalPrincipalPaid = bonds.reduce((s, b) => s + parseFloat(b.total_principal_paid || 0), 0);
    const weightedCoupon = totalPrincipal > 0
      ? activeBonds.reduce((s, b) => s + parseFloat(b.coupon_rate) * parseFloat(b.principal_balance), 0) / totalPrincipal
      : 0;

    // Calculate daily accrual across all active bonds
    let dailyAccrual = 0;
    for (const b of activeBonds) {
      const principal = parseFloat(b.principal_balance);
      const rate = parseFloat(b.coupon_rate);
      dailyAccrual += principal * (rate / 360);
    }

    // Recent cashflow events
    let recentEvents = [];
    try {
      const evtResult = await pool.query(
        `SELECT * FROM cashflow_events ORDER BY event_date DESC, created_at DESC LIMIT 10`
      );
      recentEvents = evtResult.rows;
    } catch (err) {
      // Table might not exist yet
    }

    return {
      portfolio: {
        total_bonds: bonds.length,
        active_bonds: activeBonds.length,
        total_principal: Math.round(totalPrincipal * 100) / 100,
        total_accrued_interest: Math.round(totalAccrued * 100) / 100,
        total_current_value: Math.round((totalPrincipal + totalAccrued) * 100) / 100,
        total_interest_paid: Math.round(totalInterestPaid * 100) / 100,
        total_principal_paid: Math.round(totalPrincipalPaid * 100) / 100,
        weighted_avg_coupon_pct: Math.round(weightedCoupon * 10000) / 100,
        daily_accrual: Math.round(dailyAccrual * 100) / 100,
        annual_income_estimate: Math.round(dailyAccrual * 360 * 100) / 100,
      },
      gl_integration: {
        total_mappings: parseInt(position.rows[0].count),
        journal_mappings: parseInt(glMappings.rows[0].count),
        status: parseInt(glMappings.rows[0].count) > 0 ? 'connected' : 'not_configured',
      },
      recent_cashflow_events: recentEvents,
      generated_at: new Date().toISOString(),
    };
  }

  /**
   * Record a cashflow event for reporting.
   */
  static async _recordCashflowEvent({ eventType, category, amount, direction, bondId, cashAccountId, description, eventDate }) {
    try {
      await pool.query(
        `INSERT INTO cashflow_events
           (event_type, category, amount, direction, bond_id, cash_account_id, description, event_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [eventType, category, amount, direction, bondId || null, cashAccountId || null, description, eventDate]
      );
    } catch (err) {
      // Table may not exist yet — non-fatal
      console.warn('[Orchestrator] cashflow_events insert failed:', err.message);
    }
  }
}

module.exports = { FixedIncomeOrchestrator, ACCT };
