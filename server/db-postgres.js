'use strict';

/**
 * PostgreSQL Database Module — Treasury Management System
 * DEANDREA LAVAR BARKLEY TRUST
 *
 * Irrevocable Trust ← Private Trust Company ← Private Placement Bond (asset)
 * Income: Bond coupon payments → Trust Corpus → Scheduled Distributions → Beneficiaries
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

// ─── Schema Initialization ────────────────────────────────────────────────────
const SCHEMA_SQL = `
-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ═══════════════════════════════════════════════════════════════════════════════
-- TRUST ENTITY & GOVERNANCE
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS trusts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trust_name      TEXT NOT NULL,
  trust_type      TEXT NOT NULL DEFAULT 'irrevocable',
  ein             TEXT,
  formation_date  DATE,
  jurisdiction    TEXT DEFAULT 'Ohio',
  governing_law   TEXT DEFAULT 'Ohio Revised Code',
  trust_company   TEXT,
  status          TEXT DEFAULT 'active' CHECK (status IN ('active','suspended','terminated','dissolved')),
  total_corpus    BIGINT DEFAULT 0,
  currency        TEXT DEFAULT 'USD',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trustees (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trust_id        UUID NOT NULL REFERENCES trusts(id),
  name            TEXT NOT NULL,
  role            TEXT DEFAULT 'trustee' CHECK (role IN ('trustee','co-trustee','successor_trustee','investment_advisor')),
  ein_or_ssn      TEXT,
  email           TEXT,
  phone           TEXT,
  address         TEXT,
  authority_level TEXT DEFAULT 'full' CHECK (authority_level IN ('full','limited','investment_only','distribution_only')),
  appointment_date DATE,
  status          TEXT DEFAULT 'active',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- BENEFICIARIES
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS beneficiaries (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trust_id          UUID NOT NULL REFERENCES trusts(id),
  name              TEXT NOT NULL,
  beneficiary_type  TEXT DEFAULT 'income' CHECK (beneficiary_type IN ('income','remainder','contingent','charitable')),
  classification    TEXT DEFAULT 'individual' CHECK (classification IN ('individual','entity','charity','minor')),
  ein_or_ssn        TEXT,
  email             TEXT,
  phone             TEXT,
  address           TEXT,
  city              TEXT,
  state             TEXT,
  zip               TEXT,
  distribution_pct  NUMERIC(5,2) DEFAULT 0,
  distribution_fixed BIGINT DEFAULT 0,
  tax_withholding_pct NUMERIC(5,2) DEFAULT 0,
  status            TEXT DEFAULT 'active' CHECK (status IN ('active','suspended','deceased','removed')),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- PRIVATE PLACEMENT BOND (TRUST ASSET)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS bonds (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trust_id          UUID NOT NULL REFERENCES trusts(id),
  bond_name         TEXT NOT NULL,
  isin              TEXT,
  cusip             TEXT,
  issuer            TEXT NOT NULL,
  issuer_type       TEXT DEFAULT 'private_trust_company' CHECK (issuer_type IN ('private_trust_company','corporate','government','municipal')),
  bond_type         TEXT DEFAULT 'private_placement' CHECK (bond_type IN ('private_placement','registered','bearer','zero_coupon')),
  face_value        BIGINT NOT NULL,
  purchase_price    BIGINT,
  coupon_rate       NUMERIC(8,5) NOT NULL,
  coupon_frequency  TEXT DEFAULT 'semi_annual' CHECK (coupon_frequency IN ('monthly','quarterly','semi_annual','annual')),
  day_count         TEXT DEFAULT '30/360' CHECK (day_count IN ('30/360','actual/360','actual/365','actual/actual')),
  issue_date        DATE NOT NULL,
  maturity_date     DATE NOT NULL,
  first_coupon_date DATE,
  next_coupon_date  DATE,
  accrued_interest  BIGINT DEFAULT 0,
  currency          TEXT DEFAULT 'USD',
  status            TEXT DEFAULT 'active' CHECK (status IN ('active','matured','called','defaulted')),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bond_coupon_payments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bond_id         UUID NOT NULL REFERENCES bonds(id),
  payment_date    DATE NOT NULL,
  period_start    DATE,
  period_end      DATE,
  coupon_amount   BIGINT NOT NULL,
  status          TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled','accrued','received','missed','deferred')),
  received_at     TIMESTAMPTZ,
  ledger_entry_id UUID,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- WALLETS / ACCOUNTS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS wallets (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trust_id        UUID NOT NULL REFERENCES trusts(id),
  wallet_code     TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  holder_name     TEXT,
  wallet_type     TEXT DEFAULT 'beneficiary' CHECK (wallet_type IN ('corpus','income','expense','beneficiary','trustee','reserve','tax_withholding')),
  balance         BIGINT DEFAULT 0,
  currency        TEXT DEFAULT 'USD',
  status          TEXT DEFAULT 'active' CHECK (status IN ('active','frozen','closed')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- BENEFICIARY BANK ACCOUNTS (for external payments)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS bank_accounts (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beneficiary_id    UUID NOT NULL REFERENCES beneficiaries(id),
  bank_name         TEXT NOT NULL,
  routing_number    TEXT NOT NULL,
  account_number_encrypted TEXT NOT NULL,
  account_type      TEXT DEFAULT 'checking' CHECK (account_type IN ('checking','savings')),
  account_last4     TEXT,
  is_verified       BOOLEAN DEFAULT FALSE,
  verification_method TEXT,
  verified_at       TIMESTAMPTZ,
  is_primary        BOOLEAN DEFAULT FALSE,
  status            TEXT DEFAULT 'active' CHECK (status IN ('active','closed','suspended')),
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- DISTRIBUTION SCHEDULES & RULES
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS distribution_schedules (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trust_id            UUID NOT NULL REFERENCES trusts(id),
  name                TEXT NOT NULL,
  schedule_type       TEXT DEFAULT 'recurring' CHECK (schedule_type IN ('recurring','one_time','on_demand')),
  frequency           TEXT DEFAULT 'monthly' CHECK (frequency IN ('weekly','bi_weekly','monthly','quarterly','semi_annual','annual','on_demand')),
  distribution_basis  TEXT DEFAULT 'fixed' CHECK (distribution_basis IN ('fixed','percentage_of_income','percentage_of_corpus','discretionary','unitrust')),
  source_wallet_id    UUID REFERENCES wallets(id),
  next_distribution   DATE,
  last_distribution   DATE,
  day_of_month        INTEGER DEFAULT 1,
  total_distributed   BIGINT DEFAULT 0,
  requires_approval   BOOLEAN DEFAULT TRUE,
  approval_threshold  BIGINT DEFAULT 100000,
  status              TEXT DEFAULT 'active' CHECK (status IN ('active','paused','completed','cancelled')),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS distribution_rules (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  schedule_id           UUID NOT NULL REFERENCES distribution_schedules(id),
  beneficiary_id        UUID NOT NULL REFERENCES beneficiaries(id),
  allocation_type       TEXT DEFAULT 'fixed' CHECK (allocation_type IN ('fixed','percentage','equal_share','remainder')),
  fixed_amount          BIGINT DEFAULT 0,
  percentage            NUMERIC(5,2) DEFAULT 0,
  max_per_period        BIGINT,
  min_per_period        BIGINT DEFAULT 0,
  tax_withholding_pct   NUMERIC(5,2) DEFAULT 0,
  payment_method        TEXT DEFAULT 'ach' CHECK (payment_method IN ('ach','wire','check','internal')),
  bank_account_id       UUID REFERENCES bank_accounts(id),
  status                TEXT DEFAULT 'active',
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- DISTRIBUTIONS (executed batches)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS distributions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trust_id          UUID NOT NULL REFERENCES trusts(id),
  schedule_id       UUID REFERENCES distribution_schedules(id),
  distribution_date DATE NOT NULL,
  total_amount      BIGINT NOT NULL,
  net_amount        BIGINT NOT NULL,
  tax_withheld      BIGINT DEFAULT 0,
  status            TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','processing','completed','failed','cancelled')),
  approved_by       TEXT,
  approved_at       TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS distribution_payments (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  distribution_id   UUID NOT NULL REFERENCES distributions(id),
  beneficiary_id    UUID NOT NULL REFERENCES beneficiaries(id),
  bank_account_id   UUID REFERENCES bank_accounts(id),
  gross_amount      BIGINT NOT NULL,
  tax_withheld      BIGINT DEFAULT 0,
  net_amount        BIGINT NOT NULL,
  payment_method    TEXT DEFAULT 'ach',
  payment_reference TEXT,
  status            TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','submitted','settled','failed','returned')),
  submitted_at      TIMESTAMPTZ,
  settled_at        TIMESTAMPTZ,
  failure_reason    TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- GENERAL LEDGER (double-entry)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ledger_entries (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trust_id        UUID NOT NULL REFERENCES trusts(id),
  entry_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  entry_type      TEXT NOT NULL CHECK (entry_type IN ('income','distribution','expense','transfer','tax','adjustment','coupon_received','corpus_addition')),
  debit_wallet_id UUID REFERENCES wallets(id),
  credit_wallet_id UUID REFERENCES wallets(id),
  amount          BIGINT NOT NULL CHECK (amount > 0),
  description     TEXT,
  reference_type  TEXT,
  reference_id    UUID,
  status          TEXT DEFAULT 'posted' CHECK (status IN ('pending','posted','reversed','void')),
  posted_by       TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- PAYMENT INSTRUCTIONS & EXECUTION
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS payment_instructions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trust_id            UUID NOT NULL REFERENCES trusts(id),
  distribution_payment_id UUID REFERENCES distribution_payments(id),
  payment_rail        TEXT NOT NULL CHECK (payment_rail IN ('ach_credit','ach_debit','wire','check','internal','rtp')),
  amount              BIGINT NOT NULL,
  currency            TEXT DEFAULT 'USD',
  beneficiary_name    TEXT NOT NULL,
  bank_name           TEXT,
  routing_number      TEXT,
  account_number_encrypted TEXT,
  account_type        TEXT,
  memo                TEXT,
  effective_date      DATE,
  batch_id            TEXT,
  external_ref        TEXT,
  status              TEXT DEFAULT 'created' CHECK (status IN ('created','queued','submitted','accepted','settled','returned','failed','cancelled')),
  submitted_at        TIMESTAMPTZ,
  settled_at          TIMESTAMPTZ,
  failure_code        TEXT,
  failure_reason      TEXT,
  retry_count         INTEGER DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- APPROVAL WORKFLOW
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS approvals (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trust_id        UUID NOT NULL REFERENCES trusts(id),
  entity_type     TEXT NOT NULL CHECK (entity_type IN ('distribution','payment','expense','transfer')),
  entity_id       UUID NOT NULL,
  requested_by    TEXT,
  approved_by     TEXT,
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  notes           TEXT,
  expires_at      TIMESTAMPTZ,
  decided_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- AUDIT LOG (immutable)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS audit_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trust_id        UUID REFERENCES trusts(id),
  actor           TEXT NOT NULL,
  action          TEXT NOT NULL,
  entity_type     TEXT,
  entity_id       UUID,
  details         JSONB,
  ip_address      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- TAX TRACKING
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tax_records (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trust_id          UUID NOT NULL REFERENCES trusts(id),
  beneficiary_id    UUID REFERENCES beneficiaries(id),
  tax_year          INTEGER NOT NULL,
  form_type         TEXT DEFAULT '1099-INT' CHECK (form_type IN ('1099-INT','1099-DIV','K-1','1041','1099-MISC')),
  gross_income      BIGINT DEFAULT 0,
  tax_withheld      BIGINT DEFAULT 0,
  net_distributed   BIGINT DEFAULT 0,
  status            TEXT DEFAULT 'draft' CHECK (status IN ('draft','filed','amended','void')),
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_wallets_trust ON wallets(trust_id);
CREATE INDEX IF NOT EXISTS idx_wallets_code ON wallets(wallet_code);
CREATE INDEX IF NOT EXISTS idx_beneficiaries_trust ON beneficiaries(trust_id);
CREATE INDEX IF NOT EXISTS idx_bonds_trust ON bonds(trust_id);
CREATE INDEX IF NOT EXISTS idx_bond_coupons_bond ON bond_coupon_payments(bond_id);
CREATE INDEX IF NOT EXISTS idx_bond_coupons_date ON bond_coupon_payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_ledger_trust_date ON ledger_entries(trust_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_ledger_type ON ledger_entries(entry_type);
CREATE INDEX IF NOT EXISTS idx_distributions_trust ON distributions(trust_id);
CREATE INDEX IF NOT EXISTS idx_distributions_status ON distributions(status);
CREATE INDEX IF NOT EXISTS idx_distribution_payments_dist ON distribution_payments(distribution_id);
CREATE INDEX IF NOT EXISTS idx_payment_instructions_status ON payment_instructions(status);
CREATE INDEX IF NOT EXISTS idx_payment_instructions_date ON payment_instructions(effective_date);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_audit_log_trust ON audit_log(trust_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_tax_records_year ON tax_records(tax_year);
`;

// ─── Initialize Database ──────────────────────────────────────────────────────
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query(SCHEMA_SQL);
    console.log('[DB] PostgreSQL schema initialized');

    // Seed trust if not exists
    const { rows } = await client.query('SELECT COUNT(*) AS count FROM trusts');
    if (parseInt(rows[0].count) === 0) {
      await seedDatabase(client);
    }
  } finally {
    client.release();
  }
}

// ─── Seed Data ────────────────────────────────────────────────────────────────
async function seedDatabase(client) {
  console.log('[DB] Seeding initial trust data...');

  // Create the trust
  const { rows: [trust] } = await client.query(`
    INSERT INTO trusts (trust_name, trust_type, ein, formation_date, jurisdiction, trust_company, total_corpus, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id
  `, [
    'DEANDREA LAVAR BARKLEY TRUST',
    'irrevocable',
    '00-0000000',
    '2024-01-01',
    'Ohio',
    'DLB Private Trust Company',
    1004904005000, // $10,049,040,050.00 in cents
    'active',
  ]);
  const trustId = trust.id;

  // Create trustee
  await client.query(`
    INSERT INTO trustees (trust_id, name, role, email, authority_level, appointment_date)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [trustId, 'DeAndrea Lavar Barkley', 'trustee', 'deandreabarkley13@gmail.com', 'full', '2024-01-01']);

  // Create wallets
  const walletSeeds = [
    { code: 'W-CORPUS-001', name: 'Trust Corpus', type: 'corpus', balance: 1004904005000 },
    { code: 'W-INCOME-001', name: 'Income Account', type: 'income', balance: 0 },
    { code: 'W-EXPENSE-001', name: 'Expense Account', type: 'expense', balance: 0 },
    { code: 'W-TAX-001', name: 'Tax Withholding', type: 'tax_withholding', balance: 0 },
    { code: 'W-RESERVE-001', name: 'Reserve', type: 'reserve', balance: 0 },
    { code: 'W-BEN-001', name: 'Beneficiary 1 Account', type: 'beneficiary', balance: 0 },
    { code: 'W-BEN-002', name: 'Beneficiary 2 Account', type: 'beneficiary', balance: 0 },
    { code: 'W-BEN-003', name: 'Beneficiary 3 Account', type: 'beneficiary', balance: 0 },
    { code: 'W-BEN-004', name: 'Beneficiary 4 Account', type: 'beneficiary', balance: 0 },
    { code: 'W-BEN-005', name: 'Beneficiary 5 Account', type: 'beneficiary', balance: 0 },
    { code: 'W-BEN-006', name: 'Beneficiary 6 Account', type: 'beneficiary', balance: 0 },
  ];

  for (const w of walletSeeds) {
    await client.query(`
      INSERT INTO wallets (trust_id, wallet_code, name, wallet_type, balance)
      VALUES ($1, $2, $3, $4, $5)
    `, [trustId, w.code, w.name, w.type, w.balance]);
  }

  // Create beneficiaries
  for (let i = 1; i <= 6; i++) {
    await client.query(`
      INSERT INTO beneficiaries (trust_id, name, beneficiary_type, distribution_pct)
      VALUES ($1, $2, $3, $4)
    `, [trustId, `Beneficiary ${i}`, 'income', (100 / 6).toFixed(2)]);
  }

  // Create the Private Placement Bond
  await client.query(`
    INSERT INTO bonds (trust_id, bond_name, issuer, issuer_type, bond_type, face_value, purchase_price, coupon_rate, coupon_frequency, issue_date, maturity_date, first_coupon_date, next_coupon_date, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
  `, [
    trustId,
    'DLB Private Placement Bond Series A',
    'DLB Private Trust Company',
    'private_trust_company',
    'private_placement',
    1004904005000,  // Face value = corpus
    1004904005000,  // Purchase at par
    5.25,           // 5.25% coupon rate
    'semi_annual',
    '2024-01-01',
    '2054-01-01',   // 30-year bond
    '2024-07-01',
    '2026-07-01',   // Next coupon date
    'active',
  ]);

  // Initial ledger entry: corpus establishment
  await client.query(`
    INSERT INTO ledger_entries (trust_id, entry_date, entry_type, credit_wallet_id, amount, description, status, posted_by)
    VALUES ($1, $2, $3, (SELECT id FROM wallets WHERE wallet_code = 'W-CORPUS-001'), $4, $5, $6, $7)
  `, [trustId, '2024-01-01', 'corpus_addition', 1004904005000, 'Initial trust corpus — Private Placement Bond at par', 'posted', 'system']);

  console.log('[DB] Seed data complete — trust, wallets, bond, beneficiaries created');
}

// ─── Query Helpers ────────────────────────────────────────────────────────────
async function query(text, params) {
  const result = await pool.query(text, params);
  return result;
}

async function queryOne(text, params) {
  const result = await pool.query(text, params);
  return result.rows[0] || null;
}

async function queryAll(text, params) {
  const result = await pool.query(text, params);
  return result.rows;
}

async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  query,
  queryOne,
  queryAll,
  transaction,
  initializeDatabase,
};
