-- ---------------------------------------------------------------------------
-- Blockchain / Crypto Rails Schema
-- DEANDREA LAVAR BARKLEY TRUST — Open-Source Private Stack + Circle Fallback
-- Supports: Direct Polygon RPC (ethers.js), USDC Transfers, Role-Based Access
-- ---------------------------------------------------------------------------

-- --- Blockchain Wallets (Private Stack + Circle Fallback) -------------------
CREATE TABLE IF NOT EXISTS blockchain_wallets (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_wallet_id      TEXT UNIQUE,                          -- Circle wallet UUID (null for private stack)
  circle_wallet_set_id  TEXT,                                 -- Circle wallet set UUID
  trust_account_id      INTEGER,                              -- Link to local trust_accounts
  contact_id            INTEGER,                              -- Link to crm_contacts (beneficiary wallet)
  wallet_name           TEXT NOT NULL,
  wallet_type           TEXT NOT NULL DEFAULT 'trust',        -- trust, beneficiary, vendor, expense, reserve
  blockchain            TEXT NOT NULL DEFAULT 'MATIC-AMOY',   -- MATIC, MATIC-AMOY, ETH, ETH-SEPOLIA, etc.
  address               TEXT,                                 -- On-chain wallet address (0x...)
  address_tag           TEXT,                                 -- For chains that need memo/tag
  wallet_state          TEXT NOT NULL DEFAULT 'live',         -- live, frozen
  custody_type          TEXT NOT NULL DEFAULT 'developer',    -- developer (api-controlled)
  -- Provider
  provider              TEXT NOT NULL DEFAULT 'private',      -- 'private' (direct RPC) or 'circle' (API)
  -- Private Stack: Encrypted key storage
  encrypted_private_key TEXT,                                 -- AES-256-GCM encrypted private key
  key_derivation_path   TEXT,                                 -- BIP44 derivation path
  -- Balances (last synced from chain)
  usdc_balance          TEXT NOT NULL DEFAULT '0.00',         -- USDC balance (string for precision)
  native_balance        TEXT NOT NULL DEFAULT '0.00',         -- MATIC/ETH balance for gas
  -- Governance
  spending_limit_daily  TEXT DEFAULT '50000.00',              -- Daily spending limit in USDC
  requires_approval     INTEGER NOT NULL DEFAULT 0,           -- 1 = transfers need trustee approval
  approval_threshold    TEXT DEFAULT '10000.00',              -- Amount above which approval is required
  multisig_required     INTEGER NOT NULL DEFAULT 0,           -- 1 = requires multi-sig for transfers
  multisig_threshold    INTEGER DEFAULT 2,                    -- Number of approvals needed
  -- Metadata
  status                TEXT NOT NULL DEFAULT 'active',       -- active, frozen, archived
  last_synced_at        TEXT,
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (trust_account_id) REFERENCES trust_accounts(id),
  FOREIGN KEY (contact_id) REFERENCES crm_contacts(id)
);

CREATE INDEX IF NOT EXISTS idx_bw_circle ON blockchain_wallets(circle_wallet_id);
CREATE INDEX IF NOT EXISTS idx_bw_trust ON blockchain_wallets(trust_account_id);
CREATE INDEX IF NOT EXISTS idx_bw_contact ON blockchain_wallets(contact_id);
CREATE INDEX IF NOT EXISTS idx_bw_type ON blockchain_wallets(wallet_type);
CREATE INDEX IF NOT EXISTS idx_bw_address ON blockchain_wallets(address);

-- --- Blockchain Transactions (On-chain USDC movements) ----------------------
CREATE TABLE IF NOT EXISTS blockchain_transactions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_number             TEXT NOT NULL UNIQUE,                 -- CHAIN-YYYYMMDD-XXXX
  circle_tx_id          TEXT UNIQUE,                          -- Circle transaction UUID
  -- Source
  from_wallet_id        INTEGER,                              -- Local wallet ID (sender)
  from_address          TEXT,                                 -- On-chain sender address
  -- Destination
  to_wallet_id          INTEGER,                              -- Local wallet ID (recipient, if internal)
  to_address            TEXT NOT NULL,                        -- On-chain recipient address
  -- Value
  token                 TEXT NOT NULL DEFAULT 'USDC',         -- USDC, EURC, etc.
  amount                TEXT NOT NULL,                        -- Amount in token units (string for precision)
  amount_cents          INTEGER NOT NULL DEFAULT 0,           -- Mirror in cents for ledger compatibility
  -- Chain details
  blockchain            TEXT NOT NULL DEFAULT 'MATIC-AMOY',
  tx_hash               TEXT,                                 -- On-chain transaction hash
  block_number          INTEGER,
  gas_used              TEXT,
  gas_price             TEXT,
  -- Transfer type
  transfer_type         TEXT NOT NULL DEFAULT 'internal',     -- internal (wallet-to-wallet), external (to outside address), distribution, vendor_payment, expense
  direction             TEXT NOT NULL DEFAULT 'outbound',     -- outbound, inbound
  -- Status
  status                TEXT NOT NULL DEFAULT 'initiated',
  -- initiated, pending_approval, approved, submitted, confirming, confirmed, completed, failed, cancelled
  -- Provider
  provider              TEXT NOT NULL DEFAULT 'private',      -- 'private' or 'circle'
  -- Circle state mapping
  circle_state          TEXT,                                 -- Circle's native state
  -- Approval
  requires_approval     INTEGER NOT NULL DEFAULT 0,
  approved_by           TEXT,
  approved_at           TEXT,
  -- Fees
  network_fee           TEXT DEFAULT '0.00',                  -- Gas fee in native token
  platform_fee          TEXT DEFAULT '0.00',                  -- Our fee (if any)
  -- Idempotency
  idempotency_key       TEXT UNIQUE,
  -- Error
  failure_reason        TEXT,
  -- Audit
  description           TEXT,
  initiated_by          TEXT DEFAULT 'system',
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (from_wallet_id) REFERENCES blockchain_wallets(id),
  FOREIGN KEY (to_wallet_id) REFERENCES blockchain_wallets(id)
);

CREATE INDEX IF NOT EXISTS idx_btx_number ON blockchain_transactions(tx_number);
CREATE INDEX IF NOT EXISTS idx_btx_circle ON blockchain_transactions(circle_tx_id);
CREATE INDEX IF NOT EXISTS idx_btx_hash ON blockchain_transactions(tx_hash);
CREATE INDEX IF NOT EXISTS idx_btx_status ON blockchain_transactions(status);
CREATE INDEX IF NOT EXISTS idx_btx_from ON blockchain_transactions(from_wallet_id);
CREATE INDEX IF NOT EXISTS idx_btx_to ON blockchain_transactions(to_wallet_id);
CREATE INDEX IF NOT EXISTS idx_btx_type ON blockchain_transactions(transfer_type);
CREATE INDEX IF NOT EXISTS idx_btx_idempotency ON blockchain_transactions(idempotency_key);

-- --- Fiat Gateway Orders (Circle Payments + Payouts) ------------------------
CREATE TABLE IF NOT EXISTS fiat_gateway_orders (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number          TEXT NOT NULL UNIQUE,                 -- FIAT-YYYYMMDD-XXXX
  circle_payment_id     TEXT,                                 -- Circle payment/payout UUID
  -- Direction
  direction             TEXT NOT NULL,                        -- on_ramp (USD→USDC), off_ramp (USDC→USD)
  -- Amounts
  fiat_amount           TEXT NOT NULL,                        -- USD amount
  fiat_currency         TEXT NOT NULL DEFAULT 'USD',
  crypto_amount         TEXT,                                 -- USDC amount (may differ slightly due to fees)
  crypto_currency       TEXT NOT NULL DEFAULT 'USDC',
  -- Source/Destination
  wallet_id             INTEGER,                              -- Blockchain wallet for crypto side
  bank_name             TEXT,                                 -- Bank name for fiat side
  bank_account_masked   TEXT,                                 -- Masked bank account ****1234
  wire_routing          TEXT,                                 -- Wire routing number
  -- Settlement
  rail                  TEXT DEFAULT 'wire',                  -- wire, ach, sepa, rtp
  -- Status
  status                TEXT NOT NULL DEFAULT 'pending',
  -- pending, processing, action_required, completed, failed, refunded, cancelled
  circle_status         TEXT,                                 -- Circle's native status
  -- Fees
  circle_fee            TEXT DEFAULT '0.00',
  network_fee           TEXT DEFAULT '0.00',
  -- Tracking
  estimated_settlement  TEXT,
  settled_at            TEXT,
  -- Error
  failure_reason        TEXT,
  -- Idempotency
  idempotency_key       TEXT UNIQUE,
  -- Audit
  initiated_by          TEXT DEFAULT 'system',
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (wallet_id) REFERENCES blockchain_wallets(id)
);

CREATE INDEX IF NOT EXISTS idx_fgo_number ON fiat_gateway_orders(order_number);
CREATE INDEX IF NOT EXISTS idx_fgo_circle ON fiat_gateway_orders(circle_payment_id);
CREATE INDEX IF NOT EXISTS idx_fgo_direction ON fiat_gateway_orders(direction);
CREATE INDEX IF NOT EXISTS idx_fgo_status ON fiat_gateway_orders(status);
CREATE INDEX IF NOT EXISTS idx_fgo_wallet ON fiat_gateway_orders(wallet_id);
CREATE INDEX IF NOT EXISTS idx_fgo_idempotency ON fiat_gateway_orders(idempotency_key);

-- --- Blockchain Configuration -----------------------------------------------
CREATE TABLE IF NOT EXISTS blockchain_config (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  config_key            TEXT NOT NULL UNIQUE,
  config_value          TEXT,
  is_sensitive          INTEGER NOT NULL DEFAULT 0,           -- 1 = mask in UI
  description           TEXT,
  updated_at            TEXT DEFAULT (datetime('now'))
);

-- Seed default configuration
INSERT OR IGNORE INTO blockchain_config (config_key, config_value, is_sensitive, description) VALUES
  ('provider',             'private', 0, 'Active provider: private (direct RPC, no API key) or circle (API)'),
  ('circle_api_key',       '',        1, 'Circle API key — only needed if provider=circle'),
  ('circle_entity_secret', '',        1, 'Circle entity secret for wallet operations'),
  ('environment',          'testnet', 0, 'testnet or mainnet'),
  ('default_blockchain',   'MATIC-AMOY', 0, 'Default blockchain for new wallets (MATIC-AMOY for testnet, MATIC for mainnet)'),
  ('wallet_set_id',        '',        0, 'Circle wallet set ID for trust wallets'),
  ('master_wallet_id',     '',        0, 'Primary trust corpus wallet ID'),
  ('usdc_token_id',        '',        0, 'Circle USDC token ID for the selected blockchain'),
  ('daily_transfer_limit', '100000.00', 0, 'Maximum daily USDC transfer limit'),
  ('approval_threshold',   '10000.00',  0, 'Amount above which trustee approval is required'),
  ('multisig_threshold',   '2',       0, 'Number of trustee approvals for multi-sig transactions'),
  ('auto_sync_enabled',    'true',    0, 'Auto-sync wallet balances on dashboard load'),
  ('gas_sponsor_enabled',  'true',    0, 'Sponsor gas fees for beneficiary wallets'),
  ('fiat_gateway_enabled', 'true',    0, 'Enable fiat on/off ramp via Circle Mint'),
  ('rpc_url_override',     '',        0, 'Custom RPC URL (leave blank for public endpoints)'),
  ('master_encryption_key','',        1, 'Master key for encrypting wallet private keys (auto-generated if blank)');

-- --- Blockchain Audit Log ---------------------------------------------------
CREATE TABLE IF NOT EXISTS blockchain_audit_log (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type            TEXT NOT NULL,                        -- wallet_created, transfer_sent, transfer_received, fiat_on_ramp, fiat_off_ramp, config_changed, wallet_frozen, approval_granted
  entity_type           TEXT,                                 -- wallet, transaction, fiat_order, config
  entity_id             INTEGER,
  details               TEXT,                                 -- JSON details
  actor                 TEXT DEFAULT 'system',
  ip_address            TEXT,
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bal_event ON blockchain_audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_bal_entity ON blockchain_audit_log(entity_type, entity_id);

-- --- Wallet Access Roles (Trust Governance) ---------------------------------
CREATE TABLE IF NOT EXISTS wallet_access_roles (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_id             INTEGER NOT NULL,
  role                  TEXT NOT NULL DEFAULT 'trustee',      -- trustee, co_trustee, beneficiary, vendor, auditor
  assigned_by           TEXT DEFAULT 'system',
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (wallet_id) REFERENCES blockchain_wallets(id),
  UNIQUE(wallet_id)
);

CREATE INDEX IF NOT EXISTS idx_war_wallet ON wallet_access_roles(wallet_id);
CREATE INDEX IF NOT EXISTS idx_war_role ON wallet_access_roles(role);

-- --- Multi-Sig Approvals ----------------------------------------------------
CREATE TABLE IF NOT EXISTS multisig_approvals (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id                 INTEGER NOT NULL,
  approver_wallet_id    INTEGER NOT NULL,
  approved_at           TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tx_id) REFERENCES blockchain_transactions(id),
  FOREIGN KEY (approver_wallet_id) REFERENCES blockchain_wallets(id),
  UNIQUE(tx_id, approver_wallet_id)
);

CREATE INDEX IF NOT EXISTS idx_msa_tx ON multisig_approvals(tx_id);
CREATE INDEX IF NOT EXISTS idx_msa_approver ON multisig_approvals(approver_wallet_id);
