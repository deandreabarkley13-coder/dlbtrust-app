/**
 * Trust Accounting Engine
 * DEANDREA LAVAR BARKLEY TRUST — Fiduciary Compliance Accounting
 *
 * Double-entry bookkeeping, principal vs income allocation (UPIA),
 * journal entry validation, GL balances, financial reporting,
 * and distributable net income (DNI) calculation.
 */

'use strict';

// --- Account Types & Normal Balances ----------------------------------------

const ACCOUNT_TYPES = ['asset', 'liability', 'corpus', 'income', 'expense'];

const NORMAL_BALANCES = {
  asset: 'debit',
  liability: 'credit',
  corpus: 'credit',
  income: 'credit',
  expense: 'debit',
};

const ENTRY_TYPES = ['standard', 'adjusting', 'closing', 'reversing', 'opening'];

const REFERENCE_TYPES = [
  'transfer', 'payment', 'interest', 'fee', 'distribution',
  'receipt', 'adjustment', 'investment', 'tax', 'depreciation',
];

const ALLOCATION_CATEGORIES = [
  'interest', 'dividend', 'capital_gain', 'rental', 'royalty',
  'trustee_fee', 'tax', 'legal_fee', 'accounting_fee', 'misc_expense',
];

const ALLOCATION_CLASSES = ['principal', 'income'];

const PERIOD_STATUSES = ['open', 'closed', 'locked'];

// --- UPIA Default Allocations -----------------------------------------------
// Uniform Principal and Income Act — default classification rules

const UPIA_DEFAULTS = {
  interest:        'income',      // §401 — ordinary interest → income
  dividend:        'income',      // §401 — ordinary dividends → income
  capital_gain:    'principal',   // §404(2) — capital gains → principal
  rental:          'income',      // §401 — rent → income
  royalty:         'income',      // §401 — royalties → income
  trustee_fee:     'income',      // §501 — 50/50 split typical, default to income
  tax:             'income',      // §505 — taxes on income → income
  legal_fee:       'principal',   // §501 — legal fees re: principal → principal
  accounting_fee:  'income',      // §501 — routine accounting → income
  misc_expense:    'income',      // default miscellaneous → income
};

// --- Validation Helpers -----------------------------------------------------

function validateChartOfAccount(data) {
  const errors = [];
  if (!data.account_code || !data.account_code.trim()) {
    errors.push('account_code is required');
  }
  if (!data.account_name || !data.account_name.trim()) {
    errors.push('account_name is required');
  }
  if (data.account_type && !ACCOUNT_TYPES.includes(data.account_type)) {
    errors.push(`Invalid account_type. Must be one of: ${ACCOUNT_TYPES.join(', ')}`);
  }
  if (data.normal_balance && !['debit', 'credit'].includes(data.normal_balance)) {
    errors.push('normal_balance must be debit or credit');
  }
  return errors;
}

function validateJournalEntry(data, lines) {
  const errors = [];
  if (!data.entry_date) {
    errors.push('entry_date is required');
  }
  if (!data.description || !data.description.trim()) {
    errors.push('description is required');
  }
  if (data.entry_type && !ENTRY_TYPES.includes(data.entry_type)) {
    errors.push(`Invalid entry_type. Must be one of: ${ENTRY_TYPES.join(', ')}`);
  }
  if (!lines || !Array.isArray(lines) || lines.length < 2) {
    errors.push('Journal entry must have at least 2 lines');
  }
  if (lines && Array.isArray(lines)) {
    let totalDebits = 0;
    let totalCredits = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l.account_id && !l.account_code) {
        errors.push(`Line ${i + 1}: account_id or account_code is required`);
      }
      const d = l.debit_cents || 0;
      const c = l.credit_cents || 0;
      if (d === 0 && c === 0) {
        errors.push(`Line ${i + 1}: must have either debit_cents or credit_cents > 0`);
      }
      if (d > 0 && c > 0) {
        errors.push(`Line ${i + 1}: a line cannot have both debit and credit`);
      }
      if (d < 0 || c < 0) {
        errors.push(`Line ${i + 1}: amounts cannot be negative`);
      }
      totalDebits += d;
      totalCredits += c;
    }
    if (totalDebits !== totalCredits) {
      errors.push(`Debits (${totalDebits}) must equal credits (${totalCredits})`);
    }
  }
  return errors;
}

function validateAllocation(data) {
  const errors = [];
  if (!data.category || !ALLOCATION_CATEGORIES.includes(data.category)) {
    errors.push(`Invalid category. Must be one of: ${ALLOCATION_CATEGORIES.join(', ')}`);
  }
  if (data.classification && !ALLOCATION_CLASSES.includes(data.classification)) {
    errors.push(`Invalid classification. Must be one of: ${ALLOCATION_CLASSES.join(', ')}`);
  }
  if (!data.amount_cents || data.amount_cents <= 0) {
    errors.push('amount_cents must be a positive integer');
  }
  return errors;
}

// --- Entry Number Generation ------------------------------------------------

function generateEntryNumber() {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = String(Math.floor(1000 + Math.random() * 9000));
  return `JE-${ymd}-${rand}`;
}

// --- GL Balance Calculation -------------------------------------------------

function calculateGLBalance(db, accountId, throughDate) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(jl.debit_cents), 0)  AS total_debits,
      COALESCE(SUM(jl.credit_cents), 0) AS total_credits
    FROM trust_journal_lines jl
    JOIN trust_journal_entries je ON jl.journal_entry_id = je.id
    WHERE jl.account_id = ? AND je.is_posted = 1 AND je.entry_date <= ?
  `).get(accountId, throughDate);

  return {
    total_debits: row.total_debits,
    total_credits: row.total_credits,
    balance: row.total_debits - row.total_credits, // positive = debit balance
  };
}

// --- Trial Balance ----------------------------------------------------------

function buildAccountingTrialBalance(db, asOfDate) {
  const accounts = db.prepare(`SELECT * FROM trust_chart_of_accounts WHERE is_active = 1 ORDER BY account_code`).all();
  let totalDebits = 0;
  let totalCredits = 0;
  const rows = [];

  for (const acct of accounts) {
    const bal = calculateGLBalance(db, acct.id, asOfDate);
    const netBalance = bal.balance; // debit - credit
    let debitBal = 0;
    let creditBal = 0;
    if (acct.normal_balance === 'debit') {
      debitBal = netBalance;
    } else {
      creditBal = -netBalance;
    }
    if (debitBal === 0 && creditBal === 0) continue; // skip zero-balance accounts
    totalDebits += debitBal;
    totalCredits += creditBal;
    rows.push({
      account_code: acct.account_code,
      account_name: acct.account_name,
      account_type: acct.account_type,
      debit_cents: debitBal,
      credit_cents: creditBal,
      debit_usd: toDollars(debitBal),
      credit_usd: toDollars(creditBal),
    });
  }

  return {
    as_of_date: asOfDate,
    rows,
    total_debit_cents: totalDebits,
    total_credit_cents: totalCredits,
    total_debit_usd: toDollars(totalDebits),
    total_credit_usd: toDollars(totalCredits),
    balanced: totalDebits === totalCredits,
  };
}

// --- Financial Statements ---------------------------------------------------

function buildBalanceSheet(db, asOfDate) {
  const accounts = db.prepare(`SELECT * FROM trust_chart_of_accounts WHERE is_active = 1 ORDER BY account_code`).all();
  const sections = { asset: [], liability: [], corpus: [] };
  const totals = { asset: 0, liability: 0, corpus: 0 };

  for (const acct of accounts) {
    if (!sections[acct.account_type]) continue;
    const bal = calculateGLBalance(db, acct.id, asOfDate);
    const netBalance = acct.normal_balance === 'debit' ? bal.balance : -bal.balance;
    if (netBalance === 0) continue;
    sections[acct.account_type].push({
      account_code: acct.account_code,
      account_name: acct.account_name,
      balance_cents: netBalance,
      balance_usd: toDollars(netBalance),
    });
    totals[acct.account_type] += netBalance;
  }

  return {
    as_of_date: asOfDate,
    trust_name: 'DeAndrea Lavar Barkley Trust',
    assets: { items: sections.asset, total_cents: totals.asset, total_usd: toDollars(totals.asset) },
    liabilities: { items: sections.liability, total_cents: totals.liability, total_usd: toDollars(totals.liability) },
    corpus: { items: sections.corpus, total_cents: totals.corpus, total_usd: toDollars(totals.corpus) },
    total_liabilities_and_corpus_cents: totals.liability + totals.corpus,
    total_liabilities_and_corpus_usd: toDollars(totals.liability + totals.corpus),
    balanced: totals.asset === totals.liability + totals.corpus,
  };
}

function buildIncomeStatement(db, startDate, endDate) {
  const accounts = db.prepare(`SELECT * FROM trust_chart_of_accounts WHERE is_active = 1 AND account_type IN ('income', 'expense') ORDER BY account_code`).all();
  const sections = { income: [], expense: [] };
  const totals = { income: 0, expense: 0 };

  for (const acct of accounts) {
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(jl.debit_cents), 0) AS total_debits,
        COALESCE(SUM(jl.credit_cents), 0) AS total_credits
      FROM trust_journal_lines jl
      JOIN trust_journal_entries je ON jl.journal_entry_id = je.id
      WHERE jl.account_id = ? AND je.is_posted = 1 AND je.entry_date BETWEEN ? AND ?
    `).get(acct.id, startDate, endDate);

    const netBalance = acct.normal_balance === 'debit'
      ? row.total_debits - row.total_credits
      : row.total_credits - row.total_debits;
    if (netBalance === 0) continue;

    sections[acct.account_type].push({
      account_code: acct.account_code,
      account_name: acct.account_name,
      amount_cents: netBalance,
      amount_usd: toDollars(netBalance),
    });
    totals[acct.account_type] += netBalance;
  }

  const netIncome = totals.income - totals.expense;
  return {
    period: { start_date: startDate, end_date: endDate },
    trust_name: 'DeAndrea Lavar Barkley Trust',
    income: { items: sections.income, total_cents: totals.income, total_usd: toDollars(totals.income) },
    expenses: { items: sections.expense, total_cents: totals.expense, total_usd: toDollars(totals.expense) },
    net_income_cents: netIncome,
    net_income_usd: toDollars(netIncome),
  };
}

// --- DNI Calculation --------------------------------------------------------
// Distributable Net Income per IRC §643(a)

function calculateDNI(db, startDate, endDate) {
  // Total trust income (allocated to income, not principal)
  const incomeAllocs = db.prepare(`
    SELECT category, SUM(amount_cents) AS total_cents
    FROM trust_income_allocations
    WHERE classification = 'income' AND allocation_date BETWEEN ? AND ?
    GROUP BY category
  `).all(startDate, endDate);

  const totalIncome = incomeAllocs.reduce((s, a) => s + a.total_cents, 0);

  // Deductible expenses charged to income
  const expenseAllocs = db.prepare(`
    SELECT category, SUM(amount_cents) AS total_cents
    FROM trust_income_allocations
    WHERE classification = 'income' AND amount_cents < 0 AND allocation_date BETWEEN ? AND ?
    GROUP BY category
  `).all(startDate, endDate);

  // Get expenses from expense accounts in journal
  const expenseAccounts = db.prepare(`SELECT id FROM trust_chart_of_accounts WHERE account_type = 'expense' AND is_active = 1`).all();
  let totalExpenses = 0;
  for (const acct of expenseAccounts) {
    const row = db.prepare(`
      SELECT COALESCE(SUM(jl.debit_cents - jl.credit_cents), 0) AS net
      FROM trust_journal_lines jl
      JOIN trust_journal_entries je ON jl.journal_entry_id = je.id
      WHERE jl.account_id = ? AND je.is_posted = 1 AND je.entry_date BETWEEN ? AND ?
    `).get(acct.id, startDate, endDate);
    totalExpenses += row.net;
  }

  const dni = totalIncome - totalExpenses;

  return {
    period: { start_date: startDate, end_date: endDate },
    trust_name: 'DeAndrea Lavar Barkley Trust',
    gross_income_cents: totalIncome,
    gross_income_usd: toDollars(totalIncome),
    income_breakdown: incomeAllocs.map(a => ({
      category: a.category,
      amount_cents: a.total_cents,
      amount_usd: toDollars(a.total_cents),
    })),
    deductible_expenses_cents: totalExpenses,
    deductible_expenses_usd: toDollars(totalExpenses),
    distributable_net_income_cents: dni,
    distributable_net_income_usd: toDollars(dni),
  };
}

// --- K-1 Data ---------------------------------------------------------------

function buildK1Data(db, startDate, endDate) {
  // Get all beneficiary contacts
  let beneficiaries = [];
  try {
    beneficiaries = db.prepare(`SELECT id, first_name, last_name, company_name, tax_id, tax_id_type FROM crm_contacts WHERE contact_type = 'beneficiary' AND status = 'active'`).all();
  } catch (_) { /* CRM table may not exist */ }

  const dni = calculateDNI(db, startDate, endDate);

  // Get distributions per beneficiary
  const k1s = beneficiaries.map(b => {
    let distributions = 0;
    try {
      const row = db.prepare(`
        SELECT COALESCE(SUM(amount_cents), 0) AS total
        FROM trust_income_allocations
        WHERE beneficiary_id = ? AND allocation_date BETWEEN ? AND ?
      `).get(b.id, startDate, endDate);
      distributions = row.total;
    } catch (_) {}

    // Also check external transfers as distributions
    try {
      const extRow = db.prepare(`
        SELECT COALESCE(SUM(amount_cents), 0) AS total
        FROM external_transfers
        WHERE contact_id = ? AND payment_type = 'beneficiary_distribution' AND status = 'completed'
          AND completed_date BETWEEN ? AND ?
      `).get(b.id, startDate, endDate);
      distributions += extRow.total;
    } catch (_) {}

    const name = b.company_name || `${b.first_name} ${b.last_name}`;
    const maskedTaxId = b.tax_id ? `***-**-${b.tax_id.slice(-4)}` : null;

    return {
      beneficiary_id: b.id,
      beneficiary_name: name,
      tax_id_masked: maskedTaxId,
      tax_id_type: b.tax_id_type,
      total_distributions_cents: distributions,
      total_distributions_usd: toDollars(distributions),
      share_of_dni: dni.distributable_net_income_cents > 0
        ? Math.round((distributions / dni.distributable_net_income_cents) * 10000) / 100
        : 0,
    };
  });

  return {
    period: { start_date: startDate, end_date: endDate },
    trust_name: 'DeAndrea Lavar Barkley Trust',
    trust_ein: '**-***7890', // masked
    dni,
    beneficiaries: k1s,
    total_distributed_cents: k1s.reduce((s, k) => s + k.total_distributions_cents, 0),
    total_distributed_usd: toDollars(k1s.reduce((s, k) => s + k.total_distributions_cents, 0)),
  };
}

// --- Dollar formatting (reuse from banking engine) --------------------------

function toDollars(cents) {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// --- Exports ----------------------------------------------------------------

module.exports = {
  ACCOUNT_TYPES,
  NORMAL_BALANCES,
  ENTRY_TYPES,
  REFERENCE_TYPES,
  ALLOCATION_CATEGORIES,
  ALLOCATION_CLASSES,
  PERIOD_STATUSES,
  UPIA_DEFAULTS,
  validateChartOfAccount,
  validateJournalEntry,
  validateAllocation,
  generateEntryNumber,
  calculateGLBalance,
  buildAccountingTrialBalance,
  buildBalanceSheet,
  buildIncomeStatement,
  calculateDNI,
  buildK1Data,
  toDollars,
};
