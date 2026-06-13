'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'dlbtrust.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Helper: add column if it doesn't exist ──────────────────────────────────
function addColumnIfMissing(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    console.log(`[DB] Added column ${table}.${column}`);
  }
}

// ─── Schema Initialization ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS trust_profile (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    trust_name      TEXT NOT NULL DEFAULT 'DEANDREA LAVAR BARKLEY TRUST',
    ein             TEXT,
    formation_date  TEXT,
    jurisdiction    TEXT DEFAULT 'Ohio',
    trustee_name    TEXT DEFAULT 'DeAndrea Lavar Barkley',
    total_corpus    INTEGER DEFAULT 0,
    currency        TEXT DEFAULT 'USD',
    status          TEXT DEFAULT 'active',
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS wallets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id       TEXT UNIQUE,
    name            TEXT NOT NULL,
    holder_name     TEXT,
    role            TEXT NOT NULL DEFAULT 'beneficiary',
    fiat_balance    INTEGER DEFAULT 0,
    currency        TEXT DEFAULT 'USD',
    email           TEXT,
    phone           TEXT,
    public_address  TEXT,
    status          TEXT DEFAULT 'active',
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id               INTEGER REFERENCES wallets(id),
    from_wallet_id          TEXT,
    to_wallet_id            TEXT,
    type                    TEXT NOT NULL,
    category                TEXT DEFAULT 'transfer',
    method                  TEXT DEFAULT 'internal',
    amount                  INTEGER NOT NULL,
    balance_before          INTEGER,
    balance_after           INTEGER,
    description             TEXT,
    counterparty_wallet_id  INTEGER,
    reference_id            TEXT,
    status                  TEXT DEFAULT 'pending',
    created_at              TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ledger_entries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_type      TEXT NOT NULL,
    amount          INTEGER NOT NULL,
    description     TEXT,
    reference_id    TEXT,
    wallet_id       INTEGER REFERENCES wallets(id),
    status          TEXT DEFAULT 'completed',
    created_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS distributions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT,
    total_amount    INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'pending',
    approved_by     TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    completed_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS distribution_items (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    distribution_id   INTEGER REFERENCES distributions(id),
    wallet_id         INTEGER REFERENCES wallets(id),
    amount            INTEGER NOT NULL,
    status            TEXT DEFAULT 'pending',
    created_at        TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS expenses (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    category        TEXT,
    description     TEXT,
    amount          INTEGER NOT NULL,
    vendor          TEXT,
    status          TEXT DEFAULT 'pending',
    created_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bonds (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    bond_name       TEXT NOT NULL,
    issuer          TEXT,
    face_value      INTEGER DEFAULT 0,
    coupon_rate     REAL DEFAULT 0,
    maturity_date   TEXT,
    purchase_date   TEXT,
    status          TEXT DEFAULT 'active',
    created_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bank_transfers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    direction       TEXT NOT NULL,
    amount          INTEGER NOT NULL,
    bank_name       TEXT,
    routing_number  TEXT,
    account_last4   TEXT,
    status          TEXT DEFAULT 'pending',
    reference_id    TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS disbursements (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_schedule_id   TEXT NOT NULL,
    external_account_id   TEXT NOT NULL,
    payment_profile_id    TEXT NOT NULL,
    amount                REAL NOT NULL,
    send_date             TEXT NOT NULL,
    beneficiary_name      TEXT,
    status                TEXT DEFAULT 'scheduled',
    created_by            TEXT,
    created_at            TEXT DEFAULT (datetime('now')),
    updated_at            TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_transactions_wallet ON transactions(wallet_id);
  CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
  CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category);
  CREATE INDEX IF NOT EXISTS idx_ledger_wallet ON ledger_entries(wallet_id);
  CREATE INDEX IF NOT EXISTS idx_disbursements_profile ON disbursements(payment_profile_id);
  CREATE INDEX IF NOT EXISTS idx_disbursements_status ON disbursements(status);
  CREATE INDEX IF NOT EXISTS idx_disbursements_date ON disbursements(send_date);
`);

// ─── Migrations: add columns that may be missing on existing DBs ─────────────
addColumnIfMissing('transactions', 'type', "TEXT DEFAULT 'transfer'");
addColumnIfMissing('transactions', 'from_wallet_id', 'TEXT');
addColumnIfMissing('transactions', 'to_wallet_id', 'TEXT');
addColumnIfMissing('transactions', 'category', "TEXT DEFAULT 'transfer'");
addColumnIfMissing('transactions', 'method', "TEXT DEFAULT 'internal'");
addColumnIfMissing('transactions', 'balance_before', 'INTEGER');
addColumnIfMissing('transactions', 'balance_after', 'INTEGER');
addColumnIfMissing('transactions', 'counterparty_wallet_id', 'INTEGER');
addColumnIfMissing('transactions', 'reference_id', 'TEXT');
addColumnIfMissing('wallets', 'wallet_id', 'TEXT');
addColumnIfMissing('wallets', 'holder_name', 'TEXT');
addColumnIfMissing('wallets', 'currency', "TEXT DEFAULT 'USD'");
addColumnIfMissing('wallets', 'email', 'TEXT');
addColumnIfMissing('wallets', 'phone', 'TEXT');
addColumnIfMissing('wallets', 'public_address', 'TEXT');
addColumnIfMissing('wallets', 'status', "TEXT DEFAULT 'active'");
addColumnIfMissing('wallets', 'updated_at', "TEXT DEFAULT (datetime('now'))");

// Create indexes that depend on migrated columns (safe to run after migration)
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_from ON transactions(from_wallet_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_to ON transactions(to_wallet_id)`);
} catch (_) { /* indexes may already exist */ }

// ─── Seed trust profile if empty ──────────────────────────────────────────────
const profileCount = db.prepare('SELECT COUNT(*) AS count FROM trust_profile').get();
if (profileCount.count === 0) {
  db.prepare(`
    INSERT INTO trust_profile (trust_name, ein, formation_date, jurisdiction, trustee_name, total_corpus, currency, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'DEANDREA LAVAR BARKLEY TRUST',
    '00-0000000',
    '2024-01-01',
    'Ohio',
    'DeAndrea Lavar Barkley',
    1004904005000, // $10,049,040,050.00 in cents
    'USD',
    'active',
  );
}

// ─── Seed wallets if empty ────────────────────────────────────────────────────
const walletCount = db.prepare('SELECT COUNT(*) AS count FROM wallets').get();
if (walletCount.count === 0) {
  const seedWallets = [
    { wallet_id: 'W-TRUST-001', name: 'Trust Primary', holder_name: 'DEANDREA LAVAR BARKLEY TRUST', role: 'trust_entity', fiat_balance: 1004904005000 },
    { wallet_id: 'W-TRUSTEE-001', name: 'Trustee Operating', holder_name: 'DeAndrea Lavar Barkley', role: 'trustee', fiat_balance: 0 },
    { wallet_id: 'W-BEN-001', name: 'Beneficiary 1', holder_name: 'Beneficiary 1', role: 'beneficiary', fiat_balance: 0 },
    { wallet_id: 'W-BEN-002', name: 'Beneficiary 2', holder_name: 'Beneficiary 2', role: 'beneficiary', fiat_balance: 0 },
    { wallet_id: 'W-BEN-003', name: 'Beneficiary 3', holder_name: 'Beneficiary 3', role: 'beneficiary', fiat_balance: 0 },
    { wallet_id: 'W-BEN-004', name: 'Beneficiary 4', holder_name: 'Beneficiary 4', role: 'beneficiary', fiat_balance: 0 },
    { wallet_id: 'W-BEN-005', name: 'Beneficiary 5', holder_name: 'Beneficiary 5', role: 'beneficiary', fiat_balance: 0 },
    { wallet_id: 'W-BEN-006', name: 'Beneficiary 6', holder_name: 'Beneficiary 6', role: 'beneficiary', fiat_balance: 0 },
  ];

  const insertWallet = db.prepare(`
    INSERT INTO wallets (wallet_id, name, holder_name, role, fiat_balance)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const w of seedWallets) {
    insertWallet.run(w.wallet_id, w.name, w.holder_name, w.role, w.fiat_balance);
  }

  // Seed initial corpus transaction
  db.prepare(`
    INSERT INTO transactions (wallet_id, from_wallet_id, to_wallet_id, type, category, method, amount, balance_before, balance_after, description, status, created_at)
    VALUES (1, NULL, 'W-TRUST-001', 'deposit', 'corpus', 'wire', 1004904005000, 0, 1004904005000, 'Initial trust corpus funding', 'completed', '2024-01-01 00:00:00')
  `).run();

  db.prepare(`
    INSERT INTO ledger_entries (entry_type, amount, description, wallet_id, status, created_at)
    VALUES ('corpus_deposit', 1004904005000, 'Initial trust corpus funding', 1, 'completed', '2024-01-01 00:00:00')
  `).run();
}

console.log('[DB] Schema initialized, path:', DB_PATH);

module.exports = db;
