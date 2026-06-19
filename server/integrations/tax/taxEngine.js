/**
 * Tax Engine — DLB Trust Platform
 *
 * Computes IRS Form 1041 (trust income tax return) and generates
 * Schedule K-1 allocations for each beneficiary. Pulls income and
 * expense data from the trust accounting engine and beneficiary
 * data from CRM contacts.
 *
 * All storage via PostgreSQL (fineract_tenants).
 */

'use strict';

const pool = require('../bonds/pgPool');

// 2024/2025 trust tax brackets (indexed annually by IRS)
const TRUST_TAX_BRACKETS = [
  { limit: 3150,   rate: 0.10 },
  { limit: 11450,  rate: 0.24 },
  { limit: 15650,  rate: 0.35 },
  { limit: Infinity, rate: 0.37 },
];

// Personal exemption: $300 for complex trusts, $0 if required to distribute
const COMPLEX_TRUST_EXEMPTION = 300;
const SIMPLE_TRUST_EXEMPTION = 300;

class TaxEngine {

  // ─── Trust Configuration ──────────────────────────────────────────────────

  static async getConfig(key) {
    const result = await pool.query(
      `SELECT config_value FROM trust_config WHERE config_key = $1`,
      [key]
    );
    return result.rows.length > 0 ? result.rows[0].config_value : null;
  }

  static async setConfig(key, value, description) {
    await pool.query(
      `INSERT INTO trust_config (config_key, config_value, description, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (config_key) DO UPDATE
         SET config_value = $2, description = COALESCE($3, trust_config.description), updated_at = NOW()`,
      [key, value, description || null]
    );
  }

  static async getAllConfig() {
    const result = await pool.query(
      `SELECT config_key, config_value, description, updated_at FROM trust_config ORDER BY config_key`
    );
    const config = {};
    for (const row of result.rows) {
      config[row.config_key] = row.config_value;
    }
    return { config, rows: result.rows };
  }

  // ─── Income & Expense Aggregation ─────────────────────────────────────────

  static async aggregateIncome(taxYear) {
    const startDate = `${taxYear}-01-01`;
    const endDate = `${taxYear}-12-31`;

    // Pull from trust accounting journal entries + accounts
    const result = await pool.query(`
      SELECT
        ta.account_code,
        ta.account_name,
        ta.account_type,
        ta.sub_type,
        COALESCE(SUM(
          CASE WHEN ta.account_type = 'expense'
               THEN jl.debit_amount - jl.credit_amount
               ELSE jl.credit_amount - jl.debit_amount
          END
        ), 0) AS net_amount
      FROM trust_accounts ta
      LEFT JOIN trust_journal_lines jl ON jl.account_code = ta.account_code
      LEFT JOIN trust_journal_entries je ON je.entry_id = jl.entry_id
        AND je.status = 'posted'
        AND je.entry_date >= $1 AND je.entry_date <= $2
      WHERE ta.is_active = TRUE AND ta.account_type IN ('income', 'expense')
      GROUP BY ta.account_code, ta.account_name, ta.account_type, ta.sub_type
      ORDER BY ta.account_code
    `, [startDate, endDate]);

    const income = { interest: 0, dividends: 0, capital_gains: 0, rental: 0, other: 0 };
    const expenses = { trustee_fees: 0, legal_fees: 0, tax_prep: 0, other: 0 };
    const details = { income_accounts: [], expense_accounts: [] };

    for (const row of result.rows) {
      const amount = parseFloat(row.net_amount);
      if (row.account_type === 'income') {
        details.income_accounts.push({ code: row.account_code, name: row.account_name, sub_type: row.sub_type, amount });
        // Classify income by sub_type or account name
        const name = (row.account_name || '').toLowerCase();
        const sub = (row.sub_type || '').toLowerCase();
        if (sub === 'interest' || name.includes('interest')) {
          income.interest += amount;
        } else if (sub === 'dividend' || name.includes('dividend')) {
          income.dividends += amount;
        } else if (sub === 'capital_gain' || name.includes('gain')) {
          income.capital_gains += amount;
        } else if (sub === 'rental' || name.includes('rent')) {
          income.rental += amount;
        } else {
          income.other += amount;
        }
      } else if (row.account_type === 'expense') {
        details.expense_accounts.push({ code: row.account_code, name: row.account_name, sub_type: row.sub_type, amount });
        const name = (row.account_name || '').toLowerCase();
        if (name.includes('trustee') || name.includes('management')) {
          expenses.trustee_fees += amount;
        } else if (name.includes('legal')) {
          expenses.legal_fees += amount;
        } else if (name.includes('tax') && name.includes('prep')) {
          expenses.tax_prep += amount;
        } else {
          expenses.other += amount;
        }
      }
    }

    return { income, expenses, details };
  }

  // ─── Form 1041 Computation ────────────────────────────────────────────────

  static async computeForm1041(taxYear, { save = true } = {}) {
    const { income, expenses } = await TaxEngine.aggregateIncome(taxYear);

    // Part I — Income
    const totalIncome =
      income.interest + income.dividends + income.capital_gains +
      income.rental + income.other;

    // Deductions
    const totalDeductions =
      expenses.trustee_fees + expenses.legal_fees +
      expenses.tax_prep + expenses.other;

    // Adjusted total income
    const adjustedTotalIncome = totalIncome - totalDeductions;

    // Distributable Net Income (DNI)
    // DNI = total income - deductions (capital gains excluded for simple trusts)
    const trustType = await TaxEngine.getConfig('trust_type') || 'complex';
    const dni = Math.max(0, adjustedTotalIncome);

    // Income distribution deduction (lesser of DNI or actual distributions)
    const distributions = await TaxEngine._getTotalDistributions(taxYear);
    const incomeDistributionDeduction = Math.min(dni, distributions);

    // Personal exemption
    const exemption = trustType === 'simple'
      ? SIMPLE_TRUST_EXEMPTION
      : COMPLEX_TRUST_EXEMPTION;

    // Taxable income
    const taxableIncome = Math.max(0,
      adjustedTotalIncome - incomeDistributionDeduction - exemption
    );

    // Tax computation using trust brackets
    const taxLiability = TaxEngine._computeTax(taxableIncome);

    // Estimated payments made
    const estimatedPayments = await TaxEngine._getEstimatedPayments(taxYear);

    // Tax due / overpayment
    const taxDue = taxLiability - estimatedPayments;

    const returnData = {
      tax_year: taxYear,
      interest_income: round2(income.interest),
      dividend_income: round2(income.dividends),
      capital_gains: round2(income.capital_gains),
      rental_income: round2(income.rental),
      other_income: round2(income.other),
      total_income: round2(totalIncome),
      trustee_fees: round2(expenses.trustee_fees),
      legal_fees: round2(expenses.legal_fees),
      tax_prep_fees: round2(expenses.tax_prep),
      other_deductions: round2(expenses.other),
      total_deductions: round2(totalDeductions),
      distributable_net_income: round2(dni),
      income_distribution_deduction: round2(incomeDistributionDeduction),
      adjusted_total_income: round2(adjustedTotalIncome),
      personal_exemption: round2(exemption),
      taxable_income: round2(taxableIncome),
      tax_liability: round2(taxLiability),
      estimated_payments: round2(estimatedPayments),
      tax_due: round2(taxDue),
    };

    if (save) {
      const returnId = `1041-${taxYear}-` + Date.now().toString(36).toUpperCase();
      const ein = await TaxEngine.getConfig('ein') || '99-6411566';
      const trustName = await TaxEngine.getConfig('trust_name') || 'DEANDREA LAVAR BARKLEY TRUST';

      await pool.query(`
        INSERT INTO tax_returns_1041
          (return_id, tax_year, status,
           interest_income, dividend_income, capital_gains, rental_income, other_income, total_income,
           trustee_fees, legal_fees, tax_prep_fees, other_deductions, total_deductions,
           distributable_net_income, income_distribution_deduction,
           adjusted_total_income, personal_exemption, taxable_income,
           tax_liability, estimated_payments, tax_due,
           ein, trust_name, computed_at)
        VALUES ($1,$2,'computed',
                $3,$4,$5,$6,$7,$8,
                $9,$10,$11,$12,$13,
                $14,$15,
                $16,$17,$18,
                $19,$20,$21,
                $22,$23,NOW())
        ON CONFLICT (return_id) DO UPDATE SET
          status = 'computed',
          interest_income=$3, dividend_income=$4, capital_gains=$5,
          rental_income=$6, other_income=$7, total_income=$8,
          trustee_fees=$9, legal_fees=$10, tax_prep_fees=$11,
          other_deductions=$12, total_deductions=$13,
          distributable_net_income=$14, income_distribution_deduction=$15,
          adjusted_total_income=$16, personal_exemption=$17, taxable_income=$18,
          tax_liability=$19, estimated_payments=$20, tax_due=$21,
          computed_at=NOW(), updated_at=NOW()
      `, [
        returnId, taxYear,
        returnData.interest_income, returnData.dividend_income,
        returnData.capital_gains, returnData.rental_income,
        returnData.other_income, returnData.total_income,
        returnData.trustee_fees, returnData.legal_fees,
        returnData.tax_prep_fees, returnData.other_deductions,
        returnData.total_deductions,
        returnData.distributable_net_income, returnData.income_distribution_deduction,
        returnData.adjusted_total_income, returnData.personal_exemption,
        returnData.taxable_income,
        returnData.tax_liability, returnData.estimated_payments, returnData.tax_due,
        ein, trustName,
      ]);

      returnData.return_id = returnId;
    }

    return returnData;
  }

  // ─── K-1 Generation ───────────────────────────────────────────────────────

  static async generateK1s(returnId) {
    // Get the 1041 return
    const retResult = await pool.query(
      `SELECT * FROM tax_returns_1041 WHERE return_id = $1`,
      [returnId]
    );
    if (retResult.rows.length === 0) {
      throw new Error(`Tax return ${returnId} not found`);
    }
    const taxReturn = retResult.rows[0];
    const taxYear = taxReturn.tax_year;

    // Get all beneficiary contacts
    const beneficiaries = await pool.query(
      `SELECT * FROM crm_contacts WHERE contact_type = 'beneficiary' AND status = 'active'
       ORDER BY created_at ASC`
    );

    if (beneficiaries.rows.length === 0) {
      throw new Error('No active beneficiaries found. Add beneficiary contacts in CRM first.');
    }

    // Equal allocation by default (can be overridden per-beneficiary)
    const numBeneficiaries = beneficiaries.rows.length;
    const defaultPct = round6(100 / numBeneficiaries);

    // Check for existing K-1 allocations to preserve custom percentages
    const existingK1s = await pool.query(
      `SELECT beneficiary_contact_id, allocation_percentage FROM k1_schedules
       WHERE return_id = $1`,
      [returnId]
    );
    const existingAlloc = {};
    for (const k of existingK1s.rows) {
      existingAlloc[k.beneficiary_contact_id] = parseFloat(k.allocation_percentage);
    }

    const k1s = [];
    const dni = parseFloat(taxReturn.distributable_net_income);

    for (const ben of beneficiaries.rows) {
      const pct = existingAlloc[ben.contact_id] || defaultPct;
      const fraction = pct / 100;

      const k1Data = {
        return_id: returnId,
        tax_year: taxYear,
        beneficiary_contact_id: ben.contact_id,
        beneficiary_name: `${ben.first_name} ${ben.last_name}`,
        beneficiary_tin_last4: ben.ssn_last4 || null,
        allocation_percentage: pct,
        interest_income: round2(parseFloat(taxReturn.interest_income) * fraction),
        dividend_income: round2(parseFloat(taxReturn.dividend_income) * fraction),
        capital_gains: round2(parseFloat(taxReturn.capital_gains) * fraction),
        rental_income: round2(parseFloat(taxReturn.rental_income) * fraction),
        other_income: round2(parseFloat(taxReturn.other_income) * fraction),
        deductions: round2(parseFloat(taxReturn.total_deductions) * fraction),
        distributions_paid: round2(await TaxEngine._getBeneficiaryDistributions(ben.contact_id, taxYear)),
      };
      k1Data.total_income = round2(
        k1Data.interest_income + k1Data.dividend_income + k1Data.capital_gains +
        k1Data.rental_income + k1Data.other_income
      );

      const k1Id = `K1-${taxYear}-${ben.contact_id}-` + Date.now().toString(36).toUpperCase();

      await pool.query(`
        INSERT INTO k1_schedules
          (k1_id, return_id, tax_year,
           beneficiary_contact_id, beneficiary_name, beneficiary_tin_last4,
           allocation_percentage,
           interest_income, dividend_income, capital_gains, rental_income, other_income,
           total_income, deductions, distributions_paid,
           status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'computed')
        ON CONFLICT (k1_id) DO UPDATE SET
          allocation_percentage=$7,
          interest_income=$8, dividend_income=$9, capital_gains=$10,
          rental_income=$11, other_income=$12, total_income=$13,
          deductions=$14, distributions_paid=$15,
          status='computed', updated_at=NOW()
      `, [
        k1Id, returnId, taxYear,
        ben.contact_id, k1Data.beneficiary_name, k1Data.beneficiary_tin_last4,
        k1Data.allocation_percentage,
        k1Data.interest_income, k1Data.dividend_income, k1Data.capital_gains,
        k1Data.rental_income, k1Data.other_income, k1Data.total_income,
        k1Data.deductions, k1Data.distributions_paid,
      ]);

      k1s.push({ k1_id: k1Id, ...k1Data });
    }

    return { return_id: returnId, tax_year: taxYear, k1_count: k1s.length, k1s };
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  static async getReturn(returnId) {
    const result = await pool.query(
      `SELECT * FROM tax_returns_1041 WHERE return_id = $1`,
      [returnId]
    );
    if (result.rows.length === 0) return null;

    const k1s = await pool.query(
      `SELECT * FROM k1_schedules WHERE return_id = $1 ORDER BY beneficiary_name`,
      [returnId]
    );

    return { ...result.rows[0], k1s: k1s.rows };
  }

  static async listReturns({ taxYear, status } = {}) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (taxYear) { conditions.push(`tax_year = $${idx++}`); params.push(taxYear); }
    if (status) { conditions.push(`status = $${idx++}`); params.push(status); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(
      `SELECT * FROM tax_returns_1041 ${where} ORDER BY tax_year DESC, created_at DESC`,
      params
    );
    return result.rows;
  }

  static async getK1sForReturn(returnId) {
    const result = await pool.query(
      `SELECT k.*, c.email, c.mailing_address, c.first_name, c.last_name
       FROM k1_schedules k
       JOIN crm_contacts c ON c.contact_id = k.beneficiary_contact_id
       WHERE k.return_id = $1
       ORDER BY k.beneficiary_name`,
      [returnId]
    );
    return result.rows;
  }

  static async getK1(k1Id) {
    const result = await pool.query(
      `SELECT k.*, c.email, c.mailing_address, c.first_name, c.last_name
       FROM k1_schedules k
       JOIN crm_contacts c ON c.contact_id = k.beneficiary_contact_id
       WHERE k.k1_id = $1`,
      [k1Id]
    );
    return result.rows[0] || null;
  }

  static async updateK1Allocation(k1Id, allocationPercentage) {
    const result = await pool.query(
      `UPDATE k1_schedules SET allocation_percentage = $1, updated_at = NOW()
       WHERE k1_id = $2 RETURNING *`,
      [allocationPercentage, k1Id]
    );
    if (result.rows.length === 0) throw new Error(`K-1 ${k1Id} not found`);
    return result.rows[0];
  }

  // ─── Tax Payments ─────────────────────────────────────────────────────────

  static async recordPayment({ taxYear, quarter, paymentType, amount, paymentDate, reference, notes }) {
    const paymentId = `TAXPAY-${taxYear}-Q${quarter || 0}-` + Date.now().toString(36).toUpperCase();
    const result = await pool.query(
      `INSERT INTO tax_payments (payment_id, tax_year, quarter, payment_type, amount, payment_date, reference, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [paymentId, taxYear, quarter || null, paymentType, amount, paymentDate, reference || null, notes || null]
    );
    return result.rows[0];
  }

  static async listPayments(taxYear) {
    const result = await pool.query(
      `SELECT * FROM tax_payments WHERE tax_year = $1 ORDER BY payment_date ASC`,
      [taxYear]
    );
    return result.rows;
  }

  // ─── Dashboard Summary ────────────────────────────────────────────────────

  static async getDashboard(taxYear) {
    const year = taxYear || new Date().getFullYear();
    const config = await TaxEngine.getAllConfig();

    // Latest return for the year
    const returns = await pool.query(
      `SELECT * FROM tax_returns_1041 WHERE tax_year = $1 ORDER BY created_at DESC LIMIT 1`,
      [year]
    );
    const latestReturn = returns.rows[0] || null;

    // K-1 count
    let k1Count = 0;
    if (latestReturn) {
      const k1Result = await pool.query(
        `SELECT COUNT(*) AS cnt FROM k1_schedules WHERE return_id = $1`,
        [latestReturn.return_id]
      );
      k1Count = parseInt(k1Result.rows[0].cnt, 10);
    }

    // Beneficiary count
    const benResult = await pool.query(
      `SELECT COUNT(*) AS cnt FROM crm_contacts WHERE contact_type = 'beneficiary' AND status = 'active'`
    );
    const beneficiaryCount = parseInt(benResult.rows[0].cnt, 10);

    // Payments for the year
    const payments = await TaxEngine.listPayments(year);
    const totalPayments = payments.reduce((s, p) => s + parseFloat(p.amount), 0);

    return {
      tax_year: year,
      ein: config.config.ein || '99-6411566',
      trust_name: config.config.trust_name || 'DEANDREA LAVAR BARKLEY TRUST',
      trust_type: config.config.trust_type || 'complex',
      latest_return: latestReturn,
      k1_count: k1Count,
      beneficiary_count: beneficiaryCount,
      estimated_payments: round2(totalPayments),
      payments,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  static _computeTax(taxableIncome) {
    let tax = 0;
    let remaining = taxableIncome;
    let prevLimit = 0;

    for (const bracket of TRUST_TAX_BRACKETS) {
      const bracketSize = bracket.limit === Infinity
        ? remaining
        : Math.min(remaining, bracket.limit - prevLimit);
      if (bracketSize <= 0) break;
      tax += bracketSize * bracket.rate;
      remaining -= bracketSize;
      prevLimit = bracket.limit;
    }

    return round2(tax);
  }

  static async _getTotalDistributions(taxYear) {
    const startDate = `${taxYear}-01-01`;
    const endDate = `${taxYear}-12-31`;

    const result = await pool.query(`
      SELECT COALESCE(SUM(amount_cents), 0) AS total
      FROM cash_movements
      WHERE movement_type = 'distribution'
        AND settled_at >= $1 AND settled_at <= $2
        AND status = 'settled'
    `, [startDate, endDate]);

    return parseFloat(result.rows[0].total) / 100;
  }

  static async _getBeneficiaryDistributions(contactId, taxYear) {
    // For now, use equal split of total distributions
    // In production, would track per-beneficiary distributions
    const total = await TaxEngine._getTotalDistributions(taxYear);
    const benCount = await pool.query(
      `SELECT COUNT(*) AS cnt FROM crm_contacts WHERE contact_type = 'beneficiary' AND status = 'active'`
    );
    const count = parseInt(benCount.rows[0].cnt, 10) || 1;
    return total / count;
  }

  static async _getEstimatedPayments(taxYear) {
    const result = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM tax_payments WHERE tax_year = $1`,
      [taxYear]
    );
    return parseFloat(result.rows[0].total);
  }
}

function round2(n) { return Math.round((n || 0) * 100) / 100; }
function round6(n) { return Math.round((n || 0) * 1000000) / 1000000; }

module.exports = { TaxEngine };
