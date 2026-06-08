-- ---------------------------------------------------------------------------
-- Trust Accounting Engine Schema
-- DEANDREA LAVAR BARKLEY TRUST — Fiduciary Compliance Accounting
-- ---------------------------------------------------------------------------

-- --- Chart of Accounts -----------------------------------------------------
-- Trust-specific double-entry chart of accounts
-- Categories follow fiduciary accounting standards (UPIA)
CREATE TABLE IF NOT EXISTS trust_chart_of_accounts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  account_code          TEXT NOT NULL UNIQUE,               -- e.g. 1000, 1010, 2000, 3000
  account_name          TEXT NOT NULL,
  account_type          TEXT NOT NULL,                      -- asset, liability, corpus, income, expense
  sub_type              TEXT,                               -- cash, investments, receivable, payable, principal, interest_income, dividend_income, etc.
  normal_balance        TEXT NOT NULL DEFAULT 'debit',      -- debit or credit
  parent_code           TEXT,                               -- for sub-accounts (hierarchical)
  description           TEXT,
  is_active             INTEGER NOT NULL DEFAULT 1,
  is_system             INTEGER NOT NULL DEFAULT 0,         -- system accounts cannot be deleted
  display_order         INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_coa_type ON trust_chart_of_accounts(account_type);
CREATE INDEX IF NOT EXISTS idx_coa_parent ON trust_chart_of_accounts(parent_code);

-- --- Accounting Periods ----------------------------------------------------
-- Fiscal periods for the trust (monthly or annual)
CREATE TABLE IF NOT EXISTS trust_accounting_periods (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  period_name           TEXT NOT NULL,                      -- e.g. "2026-01", "FY2025"
  period_type           TEXT NOT NULL DEFAULT 'monthly',    -- monthly, quarterly, annual
  start_date            TEXT NOT NULL,                      -- YYYY-MM-DD
  end_date              TEXT NOT NULL,                      -- YYYY-MM-DD
  status                TEXT NOT NULL DEFAULT 'open',       -- open, closed, locked
  closed_by             TEXT,
  closed_date           TEXT,
  notes                 TEXT,
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_period_name ON trust_accounting_periods(period_name);
CREATE INDEX IF NOT EXISTS idx_period_status ON trust_accounting_periods(status);

-- --- Journal Entries -------------------------------------------------------
-- Double-entry journal — every transaction is a journal entry
CREATE TABLE IF NOT EXISTS trust_journal_entries (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_number          TEXT NOT NULL UNIQUE,               -- JE-YYYYMMDD-XXXX
  entry_date            TEXT NOT NULL,                      -- posting date (YYYY-MM-DD)
  period_id             INTEGER,                            -- accounting period
  entry_type            TEXT NOT NULL DEFAULT 'standard',   -- standard, adjusting, closing, reversing, opening
  description           TEXT NOT NULL,
  memo                  TEXT,
  reference_type        TEXT,                               -- transfer, payment, interest, fee, distribution, receipt, adjustment
  reference_id          INTEGER,                            -- ID of the source transaction
  source_engine         TEXT,                               -- banking, payment, external_transfer, fixed_income
  is_posted             INTEGER NOT NULL DEFAULT 1,         -- 1 = posted, 0 = draft
  is_reversed           INTEGER NOT NULL DEFAULT 0,
  reversal_of           INTEGER,                            -- journal entry id being reversed
  total_debit_cents     INTEGER NOT NULL DEFAULT 0,
  total_credit_cents    INTEGER NOT NULL DEFAULT 0,
  created_by            TEXT DEFAULT 'system',
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (period_id) REFERENCES trust_accounting_periods(id)
);

CREATE INDEX IF NOT EXISTS idx_je_date ON trust_journal_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_je_period ON trust_journal_entries(period_id);
CREATE INDEX IF NOT EXISTS idx_je_type ON trust_journal_entries(entry_type);
CREATE INDEX IF NOT EXISTS idx_je_ref ON trust_journal_entries(reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_je_source ON trust_journal_entries(source_engine);

-- --- Journal Lines ---------------------------------------------------------
-- Individual debit/credit lines within a journal entry
CREATE TABLE IF NOT EXISTS trust_journal_lines (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_entry_id      INTEGER NOT NULL,
  line_number           INTEGER NOT NULL,                   -- ordering within the entry
  account_id            INTEGER NOT NULL,                   -- trust_chart_of_accounts.id
  account_code          TEXT NOT NULL,                      -- denormalized for reporting
  debit_cents           INTEGER NOT NULL DEFAULT 0,
  credit_cents          INTEGER NOT NULL DEFAULT 0,
  description           TEXT,
  allocation_type       TEXT,                               -- principal, income, or null (for P&I tracking)
  contact_id            INTEGER,                            -- optional CRM contact reference
  trust_account_id      INTEGER,                            -- optional link to trust_accounts
  created_at            TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (journal_entry_id) REFERENCES trust_journal_entries(id),
  FOREIGN KEY (account_id) REFERENCES trust_chart_of_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_jl_entry ON trust_journal_lines(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_jl_account ON trust_journal_lines(account_id);
CREATE INDEX IF NOT EXISTS idx_jl_allocation ON trust_journal_lines(allocation_type);

-- --- Income/Principal Allocations ------------------------------------------
-- Tracks principal vs income classification per Uniform Principal & Income Act
CREATE TABLE IF NOT EXISTS trust_income_allocations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_entry_id      INTEGER,                            -- optional link to journal entry
  allocation_date       TEXT NOT NULL,                      -- YYYY-MM-DD
  category              TEXT NOT NULL,                      -- interest, dividend, capital_gain, rental, royalty, trustee_fee, tax, legal_fee, accounting_fee, misc_expense
  classification        TEXT NOT NULL,                      -- principal or income
  amount_cents          INTEGER NOT NULL,
  beneficiary_id        INTEGER,                            -- crm_contacts.id (for beneficiary-specific allocations)
  trust_account_id      INTEGER,                            -- which trust account this relates to
  description           TEXT,
  rule_applied          TEXT,                               -- UPIA section reference (e.g. "UPIA §401" for receipts)
  created_by            TEXT DEFAULT 'system',
  created_at            TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (journal_entry_id) REFERENCES trust_journal_entries(id)
);

CREATE INDEX IF NOT EXISTS idx_alloc_class ON trust_income_allocations(classification);
CREATE INDEX IF NOT EXISTS idx_alloc_cat ON trust_income_allocations(category);
CREATE INDEX IF NOT EXISTS idx_alloc_date ON trust_income_allocations(allocation_date);
CREATE INDEX IF NOT EXISTS idx_alloc_beneficiary ON trust_income_allocations(beneficiary_id);

-- --- Seed Default Chart of Accounts ----------------------------------------
-- Standard trust accounting chart of accounts

-- ASSETS (1000-1999)
INSERT OR IGNORE INTO trust_chart_of_accounts (account_code, account_name, account_type, sub_type, normal_balance, description, is_system, display_order)
VALUES
  ('1000', 'Cash & Cash Equivalents', 'asset', 'cash', 'debit', 'Total cash held in trust bank accounts', 1, 100),
  ('1010', 'Operating Cash', 'asset', 'cash', 'debit', 'Cash in operating/checking accounts', 1, 110),
  ('1020', 'Reserve Cash', 'asset', 'cash', 'debit', 'Cash held in reserve accounts', 1, 120),
  ('1100', 'Fixed Income Investments', 'asset', 'investments', 'debit', 'Bonds, CDs, Treasury securities', 1, 130),
  ('1200', 'Equity Investments', 'asset', 'investments', 'debit', 'Stocks, mutual funds, ETFs', 1, 140),
  ('1300', 'Real Estate', 'asset', 'investments', 'debit', 'Trust-owned real property', 1, 150),
  ('1400', 'Accounts Receivable', 'asset', 'receivable', 'debit', 'Amounts owed to the trust', 1, 160),
  ('1500', 'Accrued Interest Receivable', 'asset', 'receivable', 'debit', 'Interest earned but not yet received', 1, 170),
  ('1900', 'Other Assets', 'asset', 'other', 'debit', 'Miscellaneous trust assets', 1, 190);

-- LIABILITIES (2000-2999)
INSERT OR IGNORE INTO trust_chart_of_accounts (account_code, account_name, account_type, sub_type, normal_balance, description, is_system, display_order)
VALUES
  ('2000', 'Accounts Payable', 'liability', 'payable', 'credit', 'Amounts owed by the trust', 1, 200),
  ('2100', 'Distributions Payable', 'liability', 'payable', 'credit', 'Approved but unpaid beneficiary distributions', 1, 210),
  ('2200', 'Taxes Payable', 'liability', 'payable', 'credit', 'Federal, state, local taxes owed', 1, 220),
  ('2300', 'Trustee Fees Payable', 'liability', 'payable', 'credit', 'Accrued trustee compensation', 1, 230),
  ('2400', 'Accrued Expenses', 'liability', 'payable', 'credit', 'Other accrued obligations', 1, 240),
  ('2900', 'Other Liabilities', 'liability', 'other', 'credit', 'Miscellaneous liabilities', 1, 290);

-- CORPUS / PRINCIPAL (3000-3999)
INSERT OR IGNORE INTO trust_chart_of_accounts (account_code, account_name, account_type, sub_type, normal_balance, description, is_system, display_order)
VALUES
  ('3000', 'Trust Corpus (Principal)', 'corpus', 'principal', 'credit', 'Original trust principal / corpus', 1, 300),
  ('3100', 'Additions to Corpus', 'corpus', 'principal', 'credit', 'Subsequent contributions to principal', 1, 310),
  ('3200', 'Capital Gains — Principal', 'corpus', 'capital_gains', 'credit', 'Realized capital gains allocated to principal', 1, 320),
  ('3300', 'Unrealized Gains/Losses', 'corpus', 'unrealized', 'credit', 'Mark-to-market adjustments', 1, 330),
  ('3900', 'Retained Income', 'corpus', 'retained', 'credit', 'Accumulated undistributed income', 1, 390);

-- INCOME (4000-4999)
INSERT OR IGNORE INTO trust_chart_of_accounts (account_code, account_name, account_type, sub_type, normal_balance, description, is_system, display_order)
VALUES
  ('4000', 'Interest Income', 'income', 'interest_income', 'credit', 'Interest from bonds, CDs, bank accounts', 1, 400),
  ('4100', 'Dividend Income', 'income', 'dividend_income', 'credit', 'Dividends from equity investments', 1, 410),
  ('4200', 'Rental Income', 'income', 'rental_income', 'credit', 'Income from trust-owned real estate', 1, 420),
  ('4300', 'Royalty Income', 'income', 'royalty_income', 'credit', 'Royalties from intellectual property or mineral rights', 1, 430),
  ('4400', 'Capital Gains — Income', 'income', 'capital_gains', 'credit', 'Short-term capital gains (allocated to income)', 1, 440),
  ('4900', 'Other Income', 'income', 'other', 'credit', 'Miscellaneous trust income', 1, 490);

-- EXPENSES (5000-5999)
INSERT OR IGNORE INTO trust_chart_of_accounts (account_code, account_name, account_type, sub_type, normal_balance, description, is_system, display_order)
VALUES
  ('5000', 'Trustee Fees', 'expense', 'trustee_fee', 'debit', 'Compensation paid to trustee(s)', 1, 500),
  ('5100', 'Legal & Professional Fees', 'expense', 'legal_fee', 'debit', 'Attorney, CPA, advisor fees', 1, 510),
  ('5200', 'Accounting & Tax Prep Fees', 'expense', 'accounting_fee', 'debit', 'Trust tax return preparation, audit fees', 1, 520),
  ('5300', 'Investment Management Fees', 'expense', 'investment_fee', 'debit', 'Advisory and management fees on investments', 1, 530),
  ('5400', 'Property Expenses', 'expense', 'property', 'debit', 'Real estate taxes, maintenance, insurance on trust property', 1, 540),
  ('5500', 'Federal Income Tax', 'expense', 'tax', 'debit', 'Federal income tax on undistributed income', 1, 550),
  ('5600', 'State Income Tax', 'expense', 'tax', 'debit', 'State income tax on trust income', 1, 560),
  ('5700', 'Bank & Processing Fees', 'expense', 'bank_fee', 'debit', 'Wire fees, ACH fees, bank charges', 1, 570),
  ('5800', 'Beneficiary Distributions', 'expense', 'distribution', 'debit', 'Distributions of income to beneficiaries', 1, 580),
  ('5900', 'Other Expenses', 'expense', 'other', 'debit', 'Miscellaneous trust expenses', 1, 590);
