-- ─────────────────────────────────────────────────────────────────────────────
-- Document & Trust Accounting Migration — DLB Trust Platform
-- Run against the fineract_tenants database.
-- Creates Document Templates, Documents, Generated Documents,
-- and Trust Accounting tables.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Document Templates ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_templates (
  id              SERIAL PRIMARY KEY,
  template_id     TEXT UNIQUE NOT NULL,
  template_name   TEXT NOT NULL,
  template_type   TEXT NOT NULL CHECK (template_type IN (
    'trust_agreement','bond_indenture','subscription_agreement',
    'distribution_notice','tax_form','compliance_report',
    'trustee_report','investor_statement','payment_confirmation',
    'amendment','resolution','custom'
  )),
  category        TEXT DEFAULT 'general' CHECK (category IN (
    'legal','financial','compliance','investor','trustee','tax','operational','general'
  )),
  description     TEXT,
  body_template   TEXT NOT NULL,
  header_template TEXT,
  footer_template TEXT,
  variables       JSONB DEFAULT '[]',
  metadata        JSONB DEFAULT '{}',
  version         INTEGER DEFAULT 1,
  is_active       BOOLEAN DEFAULT TRUE,
  is_default      BOOLEAN DEFAULT FALSE,
  created_by      TEXT,
  updated_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Documents (managed files/records) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
  id              SERIAL PRIMARY KEY,
  document_id     TEXT UNIQUE NOT NULL,
  document_name   TEXT NOT NULL,
  document_type   TEXT NOT NULL CHECK (document_type IN (
    'trust_agreement','bond_indenture','subscription_agreement',
    'distribution_notice','tax_form','compliance_report',
    'trustee_report','investor_statement','payment_confirmation',
    'amendment','resolution','correspondence','receipt','other'
  )),
  category        TEXT DEFAULT 'general' CHECK (category IN (
    'legal','financial','compliance','investor','trustee','tax','operational','general'
  )),
  content         TEXT,
  content_type    TEXT DEFAULT 'text/plain' CHECK (content_type IN (
    'text/plain','text/html','application/json','application/pdf'
  )),
  file_size_bytes INTEGER,
  bond_id         INTEGER REFERENCES bonds(id),
  contact_id      TEXT,
  cash_account_id TEXT,
  reference_type  TEXT,
  reference_id    TEXT,
  tags            TEXT[],
  metadata        JSONB DEFAULT '{}',
  status          TEXT DEFAULT 'active' CHECK (status IN ('draft','active','archived','superseded','deleted')),
  version         INTEGER DEFAULT 1,
  parent_document_id TEXT,
  created_by      TEXT,
  updated_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Generated Documents (from templates) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS generated_documents (
  id              SERIAL PRIMARY KEY,
  generation_id   TEXT UNIQUE NOT NULL,
  template_id     TEXT NOT NULL REFERENCES document_templates(template_id),
  document_id     TEXT REFERENCES documents(document_id),
  bond_id         INTEGER REFERENCES bonds(id),
  contact_id      TEXT,
  variables_used  JSONB DEFAULT '{}',
  rendered_content TEXT NOT NULL,
  content_type    TEXT DEFAULT 'text/html',
  status          TEXT DEFAULT 'completed' CHECK (status IN ('pending','completed','failed','expired')),
  generated_by    TEXT,
  generated_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ
);

-- ─── Trust Accounts (chart of trust accounts) ────────────────────────────────
CREATE TABLE IF NOT EXISTS trust_accounts (
  id                  SERIAL PRIMARY KEY,
  account_code        TEXT UNIQUE NOT NULL,
  account_name        TEXT NOT NULL,
  account_type        TEXT NOT NULL CHECK (account_type IN (
    'asset','liability','equity','income','expense'
  )),
  sub_type            TEXT CHECK (sub_type IN (
    'cash','investment','receivable','payable',
    'trust_corpus','undistributed_income',
    'interest_income','fee_income','management_fee',
    'trustee_fee','legal_fee','operating_expense',
    'distribution','unrealized_gain','realized_gain',
    'tax_provision','reserve','other'
  )),
  parent_account_code TEXT,
  linked_cash_account TEXT REFERENCES cash_accounts(account_id),
  linked_fineract_gl  TEXT,
  balance             NUMERIC(18,2) DEFAULT 0,
  currency            TEXT DEFAULT 'USD',
  is_active           BOOLEAN DEFAULT TRUE,
  description         TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Trust Journal Entries (double-entry ledger) ──────────────────────────────
CREATE TABLE IF NOT EXISTS trust_journal_entries (
  id              SERIAL PRIMARY KEY,
  entry_id        TEXT UNIQUE NOT NULL,
  entry_date      DATE NOT NULL,
  description     TEXT NOT NULL,
  reference_type  TEXT,
  reference_id    TEXT,
  bond_id         INTEGER REFERENCES bonds(id),
  posted_by       TEXT,
  fineract_txn_id TEXT,
  status          TEXT DEFAULT 'posted' CHECK (status IN ('draft','posted','reversed','void')),
  reversal_of     TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Trust Journal Lines (individual debit/credit entries) ────────────────────
CREATE TABLE IF NOT EXISTS trust_journal_lines (
  id              SERIAL PRIMARY KEY,
  entry_id        TEXT NOT NULL REFERENCES trust_journal_entries(entry_id) ON DELETE CASCADE,
  account_code    TEXT NOT NULL REFERENCES trust_accounts(account_code),
  debit_amount    NUMERIC(18,2) DEFAULT 0,
  credit_amount   NUMERIC(18,2) DEFAULT 0,
  memo            TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Trust Periods (accounting periods) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS trust_periods (
  id              SERIAL PRIMARY KEY,
  period_name     TEXT NOT NULL,
  start_date      DATE NOT NULL,
  end_date        DATE NOT NULL,
  status          TEXT DEFAULT 'open' CHECK (status IN ('open','closing','closed')),
  closed_by       TEXT,
  closed_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_doc_templates_type ON document_templates(template_type);
CREATE INDEX IF NOT EXISTS idx_doc_templates_active ON document_templates(is_active);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(document_type);
CREATE INDEX IF NOT EXISTS idx_documents_bond_id ON documents(bond_id);
CREATE INDEX IF NOT EXISTS idx_documents_contact_id ON documents(contact_id);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_gen_docs_template ON generated_documents(template_id);
CREATE INDEX IF NOT EXISTS idx_gen_docs_bond ON generated_documents(bond_id);
CREATE INDEX IF NOT EXISTS idx_trust_accounts_type ON trust_accounts(account_type);
CREATE INDEX IF NOT EXISTS idx_trust_journal_date ON trust_journal_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_trust_journal_status ON trust_journal_entries(status);
CREATE INDEX IF NOT EXISTS idx_trust_journal_lines_entry ON trust_journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_trust_journal_lines_acct ON trust_journal_lines(account_code);
CREATE INDEX IF NOT EXISTS idx_trust_periods_status ON trust_periods(status);

-- ─── Seed Default Document Templates ──────────────────────────────────────────

INSERT INTO document_templates (template_id, template_name, template_type, category, description, body_template, variables, is_default)
VALUES
  ('TPL-TRUST-AGREE', 'Trust Agreement', 'trust_agreement', 'legal',
   'Standard trust agreement template for DLB Trust',
   '<h1>TRUST AGREEMENT</h1><p>This Trust Agreement is entered into as of {{effectiveDate}} by and between {{trustorName}} ("Trustor") and {{trusteeName}} ("Trustee") for the benefit of {{beneficiaryName}} ("Beneficiary").</p><h2>Article I — Trust Property</h2><p>The Trustor hereby transfers and assigns to the Trustee the following property: {{trustProperty}}</p><h2>Article II — Trust Purpose</h2><p>{{trustPurpose}}</p><h2>Article III — Terms</h2><p>Trust established under the laws of {{jurisdiction}}. Face value: ${{faceValue}}. Coupon rate: {{couponRate}}%.</p><p>This agreement is effective as of {{effectiveDate}}.</p>',
   '["effectiveDate","trustorName","trusteeName","beneficiaryName","trustProperty","trustPurpose","jurisdiction","faceValue","couponRate"]',
   TRUE),

  ('TPL-BOND-INDENT', 'Bond Indenture', 'bond_indenture', 'legal',
   'Bond indenture template for private placement bonds',
   '<h1>BOND INDENTURE</h1><p>Bond: {{bondName}} (ISIN: {{isin}})</p><p>Face Value: ${{faceValue}} | Coupon Rate: {{couponRate}}% | Maturity: {{maturityDate}}</p><h2>Terms and Conditions</h2><p>This indenture is between {{issuerName}} and {{trusteeName}}, dated {{issueDate}}.</p><p>Payment Frequency: {{paymentFreq}} | Day Count: {{dayCount}}</p><h2>Covenants</h2><p>{{covenants}}</p>',
   '["bondName","isin","faceValue","couponRate","maturityDate","issuerName","trusteeName","issueDate","paymentFreq","dayCount","covenants"]',
   TRUE),

  ('TPL-SUB-AGREE', 'Subscription Agreement', 'subscription_agreement', 'investor',
   'Investor subscription agreement for bond purchases',
   '<h1>SUBSCRIPTION AGREEMENT</h1><p>Investor: {{investorName}} ({{investorEmail}})</p><p>Bond: {{bondName}} | Subscription Amount: ${{subscriptionAmount}}</p><p>Settlement Date: {{settlementDate}} | Offering Price: {{offeringPrice}}</p><h2>Representations</h2><p>The undersigned investor represents that they are an accredited investor as defined under Regulation D of the Securities Act of 1933.</p>',
   '["investorName","investorEmail","bondName","subscriptionAmount","settlementDate","offeringPrice"]',
   TRUE),

  ('TPL-DIST-NOTICE', 'Distribution Notice', 'distribution_notice', 'financial',
   'Beneficiary distribution notice template',
   '<h1>DISTRIBUTION NOTICE</h1><p>Date: {{distributionDate}}</p><p>To: {{recipientName}}</p><p>Re: Distribution from {{trustName}}</p><p>Amount: ${{amount}} | Payment Method: {{paymentMethod}}</p><p>Period: {{periodStart}} to {{periodEnd}}</p><p>Description: {{description}}</p>',
   '["distributionDate","recipientName","trustName","amount","paymentMethod","periodStart","periodEnd","description"]',
   TRUE),

  ('TPL-INV-STMT', 'Investor Statement', 'investor_statement', 'investor',
   'Periodic investor account statement',
   '<h1>INVESTOR STATEMENT</h1><p>Statement Period: {{periodStart}} — {{periodEnd}}</p><p>Investor: {{investorName}} | Account: {{accountId}}</p><h2>Holdings</h2><p>Bond: {{bondName}} | Face Value: ${{faceValue}} | Market Value: ${{marketValue}}</p><h2>Income</h2><p>Interest Earned: ${{interestEarned}} | Distributions Paid: ${{distributionsPaid}}</p><h2>Summary</h2><p>Beginning Balance: ${{beginBalance}} | Ending Balance: ${{endBalance}}</p>',
   '["periodStart","periodEnd","investorName","accountId","bondName","faceValue","marketValue","interestEarned","distributionsPaid","beginBalance","endBalance"]',
   TRUE),

  ('TPL-PAY-CONF', 'Payment Confirmation', 'payment_confirmation', 'financial',
   'Payment confirmation receipt',
   '<h1>PAYMENT CONFIRMATION</h1><p>Confirmation #: {{confirmationNumber}}</p><p>Date: {{paymentDate}} | Amount: ${{amount}}</p><p>From: {{fromAccount}} | To: {{toAccount}}</p><p>Payment Type: {{paymentType}} | Reference: {{referenceId}}</p><p>Memo: {{memo}}</p>',
   '["confirmationNumber","paymentDate","amount","fromAccount","toAccount","paymentType","referenceId","memo"]',
   TRUE)
ON CONFLICT (template_id) DO NOTHING;

-- ─── Seed Default Trust Chart of Accounts ─────────────────────────────────────

INSERT INTO trust_accounts (account_code, account_name, account_type, sub_type, description)
VALUES
  -- Assets
  ('1000', 'Trust Cash & Equivalents', 'asset', 'cash', 'Primary cash holdings'),
  ('1100', 'Bond Investments', 'asset', 'investment', 'Fixed income bond holdings at cost'),
  ('1200', 'Accrued Interest Receivable', 'asset', 'receivable', 'Interest earned but not yet received'),
  ('1300', 'Other Receivables', 'asset', 'receivable', 'Other amounts due to the trust'),
  -- Liabilities
  ('2000', 'Distributions Payable', 'liability', 'payable', 'Approved but unpaid distributions'),
  ('2100', 'Fees Payable', 'liability', 'payable', 'Accrued management and trustee fees'),
  ('2200', 'Tax Provisions', 'liability', 'tax_provision', 'Estimated tax liabilities'),
  -- Equity
  ('3000', 'Trust Corpus', 'equity', 'trust_corpus', 'Original trust principal / corpus'),
  ('3100', 'Undistributed Income', 'equity', 'undistributed_income', 'Accumulated income not yet distributed'),
  ('3200', 'Unrealized Gains/Losses', 'equity', 'unrealized_gain', 'Mark-to-market unrealized P&L'),
  -- Income
  ('4000', 'Interest Income', 'income', 'interest_income', 'Bond coupon and interest earnings'),
  ('4100', 'Fee Income', 'income', 'fee_income', 'Trust fee revenue'),
  ('4200', 'Realized Gains', 'income', 'realized_gain', 'Gains from asset sales'),
  -- Expenses
  ('5000', 'Management Fees', 'expense', 'management_fee', 'Trust management fees'),
  ('5100', 'Trustee Fees', 'expense', 'trustee_fee', 'Trustee compensation'),
  ('5200', 'Legal & Professional', 'expense', 'legal_fee', 'Legal and advisory fees'),
  ('5300', 'Operating Expenses', 'expense', 'operating_expense', 'General trust operating costs')
ON CONFLICT (account_code) DO NOTHING;

-- ─── Seed Initial Trust Period ────────────────────────────────────────────────

INSERT INTO trust_periods (period_name, start_date, end_date, status)
SELECT '2024-Q1', '2024-01-01', '2024-03-31', 'closed'
WHERE NOT EXISTS (SELECT 1 FROM trust_periods WHERE period_name = '2024-Q1');

INSERT INTO trust_periods (period_name, start_date, end_date, status)
SELECT '2024-Q2', '2024-04-01', '2024-06-30', 'closed'
WHERE NOT EXISTS (SELECT 1 FROM trust_periods WHERE period_name = '2024-Q2');

INSERT INTO trust_periods (period_name, start_date, end_date, status)
SELECT '2024-Q3', '2024-07-01', '2024-09-30', 'closed'
WHERE NOT EXISTS (SELECT 1 FROM trust_periods WHERE period_name = '2024-Q3');

INSERT INTO trust_periods (period_name, start_date, end_date, status)
SELECT '2024-Q4', '2024-10-01', '2024-12-31', 'closed'
WHERE NOT EXISTS (SELECT 1 FROM trust_periods WHERE period_name = '2024-Q4');

INSERT INTO trust_periods (period_name, start_date, end_date, status)
SELECT '2025-Q1', '2025-01-01', '2025-03-31', 'closed'
WHERE NOT EXISTS (SELECT 1 FROM trust_periods WHERE period_name = '2025-Q1');

INSERT INTO trust_periods (period_name, start_date, end_date, status)
SELECT '2025-Q2', '2025-04-01', '2025-06-30', 'closed'
WHERE NOT EXISTS (SELECT 1 FROM trust_periods WHERE period_name = '2025-Q2');

INSERT INTO trust_periods (period_name, start_date, end_date, status)
SELECT '2025-Q3', '2025-07-01', '2025-09-30', 'closed'
WHERE NOT EXISTS (SELECT 1 FROM trust_periods WHERE period_name = '2025-Q3');

INSERT INTO trust_periods (period_name, start_date, end_date, status)
SELECT '2025-Q4', '2025-10-01', '2025-12-31', 'closed'
WHERE NOT EXISTS (SELECT 1 FROM trust_periods WHERE period_name = '2025-Q4');

INSERT INTO trust_periods (period_name, start_date, end_date, status)
SELECT '2026-Q1', '2026-01-01', '2026-03-31', 'closed'
WHERE NOT EXISTS (SELECT 1 FROM trust_periods WHERE period_name = '2026-Q1');

INSERT INTO trust_periods (period_name, start_date, end_date, status)
SELECT '2026-Q2', '2026-04-01', '2026-06-30', 'open'
WHERE NOT EXISTS (SELECT 1 FROM trust_periods WHERE period_name = '2026-Q2');
