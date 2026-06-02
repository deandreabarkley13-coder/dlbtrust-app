-- ---------------------------------------------------------------------------
-- CRM Engine Schema
-- DEANDREA LAVAR BARKLEY TRUST — Contact Relationship Management
-- ---------------------------------------------------------------------------

-- --- CRM Contacts ----------------------------------------------------------
-- Unified registry for trustees, beneficiaries, and vendors
CREATE TABLE IF NOT EXISTS crm_contacts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_type      TEXT NOT NULL DEFAULT 'beneficiary',  -- trustee, beneficiary, vendor
  status            TEXT NOT NULL DEFAULT 'active',       -- active, inactive, pending_kyc, suspended
  first_name        TEXT NOT NULL,
  last_name         TEXT NOT NULL,
  company_name      TEXT,                                 -- for vendors/organizations
  display_name      TEXT GENERATED ALWAYS AS (
    CASE WHEN company_name IS NOT NULL AND company_name != ''
      THEN company_name
      ELSE first_name || ' ' || last_name
    END
  ) STORED,
  email             TEXT,
  phone             TEXT,
  mobile            TEXT,
  address_line1     TEXT,
  address_line2     TEXT,
  city              TEXT,
  state             TEXT,
  zip               TEXT,
  country           TEXT NOT NULL DEFAULT 'US',
  tax_id            TEXT,                                 -- SSN or EIN (encrypted at rest)
  tax_id_type       TEXT DEFAULT 'ssn',                   -- ssn, ein, itin
  date_of_birth     TEXT,                                 -- for individuals
  kyc_status        TEXT NOT NULL DEFAULT 'pending',      -- pending, verified, expired, failed
  kyc_verified_date TEXT,
  kyc_expiry_date   TEXT,
  aml_risk_rating   TEXT NOT NULL DEFAULT 'low',          -- low, medium, high
  -- Vendor-specific fields
  vendor_category   TEXT,                                 -- legal, accounting, property, insurance, financial, other
  payment_terms     TEXT DEFAULT 'net_30',                -- immediate, net_15, net_30, net_60, net_90
  -- Trustee-specific fields
  trustee_role      TEXT,                                 -- primary, successor, co-trustee, special
  trustee_start_date TEXT,
  trustee_end_date  TEXT,
  -- Beneficiary-specific fields
  beneficiary_class TEXT,                                 -- income, remainder, contingent, discretionary
  distribution_pct  REAL DEFAULT 0,                       -- percentage share (0-100)
  -- Common
  notes             TEXT,
  tags              TEXT,                                 -- JSON array of tags
  created_by        TEXT DEFAULT 'system',
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_crm_contacts_type ON crm_contacts(contact_type);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_status ON crm_contacts(status);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_name ON crm_contacts(last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_email ON crm_contacts(email);

-- --- CRM Payment Methods ---------------------------------------------------
-- Bank accounts, wire details, check addresses for each contact
CREATE TABLE IF NOT EXISTS crm_payment_methods (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id        INTEGER NOT NULL REFERENCES crm_contacts(id),
  method_type       TEXT NOT NULL DEFAULT 'ach',          -- ach, wire, check, zelle
  label             TEXT NOT NULL DEFAULT 'Primary',      -- Primary, Secondary, Business, etc.
  is_default        INTEGER NOT NULL DEFAULT 0,           -- 1 = default method for this contact
  bank_name         TEXT,
  routing_number    TEXT,
  account_number    TEXT,                                 -- last 4 visible, rest masked
  account_type      TEXT DEFAULT 'checking',              -- checking, savings
  -- Wire-specific
  swift_code        TEXT,
  wire_instructions TEXT,
  intermediary_bank TEXT,
  -- Check-specific
  payable_to        TEXT,
  mail_address      TEXT,
  -- Verification
  verified          INTEGER NOT NULL DEFAULT 0,
  verified_date     TEXT,
  verification_method TEXT,                               -- micro_deposit, plaid, manual
  -- Status
  status            TEXT NOT NULL DEFAULT 'active',       -- active, inactive, suspended
  notes             TEXT,
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_crm_payment_contact ON crm_payment_methods(contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_payment_default ON crm_payment_methods(contact_id, is_default);

-- --- CRM Relationships -----------------------------------------------------
-- Links contacts to trust accounts (beneficiary → account, vendor → account, etc.)
CREATE TABLE IF NOT EXISTS crm_relationships (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id        INTEGER NOT NULL REFERENCES crm_contacts(id),
  account_id        INTEGER REFERENCES trust_accounts(id),
  relationship_type TEXT NOT NULL,                        -- beneficiary_of, vendor_for, trustee_of, advisor_to
  role_detail       TEXT,                                 -- e.g. "income beneficiary", "estate attorney"
  share_pct         REAL,                                 -- % allocation if applicable
  start_date        TEXT DEFAULT (date('now')),
  end_date          TEXT,
  status            TEXT NOT NULL DEFAULT 'active',       -- active, terminated, pending
  authorized_actions TEXT,                                -- JSON: ["view_balance","request_distribution"]
  notes             TEXT,
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_crm_rel_contact ON crm_relationships(contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_rel_account ON crm_relationships(account_id);
CREATE INDEX IF NOT EXISTS idx_crm_rel_type ON crm_relationships(relationship_type);

-- --- CRM Documents ---------------------------------------------------------
-- Document tracking per contact (W-9, contracts, agreements, etc.)
CREATE TABLE IF NOT EXISTS crm_documents (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id        INTEGER NOT NULL REFERENCES crm_contacts(id),
  document_type     TEXT NOT NULL,                        -- w9, contract, trust_agreement, id_verification, insurance, tax_return, invoice
  document_name     TEXT NOT NULL,
  file_path         TEXT,                                 -- path or reference to stored document
  issue_date        TEXT,
  expiry_date       TEXT,
  status            TEXT NOT NULL DEFAULT 'active',       -- active, expired, pending_review, archived
  review_required   INTEGER NOT NULL DEFAULT 0,
  reviewed_by       TEXT,
  reviewed_date     TEXT,
  notes             TEXT,
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_crm_docs_contact ON crm_documents(contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_docs_expiry ON crm_documents(expiry_date);
CREATE INDEX IF NOT EXISTS idx_crm_docs_type ON crm_documents(document_type);

-- --- CRM Notes / Communications Log ----------------------------------------
-- Activity notes, calls, emails, meetings per contact
CREATE TABLE IF NOT EXISTS crm_notes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id        INTEGER NOT NULL REFERENCES crm_contacts(id),
  note_type         TEXT NOT NULL DEFAULT 'general',      -- general, call, email, meeting, task, follow_up
  subject           TEXT,
  body              TEXT NOT NULL,
  priority          TEXT NOT NULL DEFAULT 'normal',       -- low, normal, high, urgent
  due_date          TEXT,
  completed         INTEGER NOT NULL DEFAULT 0,
  completed_date    TEXT,
  created_by        TEXT DEFAULT 'system',
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_crm_notes_contact ON crm_notes(contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_notes_type ON crm_notes(note_type);
CREATE INDEX IF NOT EXISTS idx_crm_notes_due ON crm_notes(due_date);
