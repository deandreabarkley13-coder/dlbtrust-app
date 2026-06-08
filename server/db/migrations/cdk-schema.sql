-- ---------------------------------------------------------------------------
-- Polygon CDK Appchain Schema
-- DEANDREA LAVAR BARKLEY TRUST — Private Blockchain Layer
-- Deployed smart contracts, token minting/burning, bridge operations
-- ---------------------------------------------------------------------------

-- --- CDK Chain Configuration ------------------------------------------------
CREATE TABLE IF NOT EXISTS cdk_chain_config (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  config_key    TEXT NOT NULL UNIQUE,
  config_value  TEXT,
  updated_at    TEXT DEFAULT (datetime('now'))
);

-- Seed default config
INSERT OR IGNORE INTO cdk_chain_config (config_key, config_value) VALUES
  ('chain_name',         'DLB Trust Chain'),
  ('chain_id',           '137'),
  ('network',            'MATIC'),
  ('rpc_url',            'https://polygon-bor-rpc.publicnode.com'),
  ('explorer_url',       'https://polygonscan.com'),
  ('token_name',         'DLB Trust Token'),
  ('token_symbol',       'DLBT'),
  ('token_decimals',     '6'),
  ('status',             'active'),
  ('deployer_wallet_id', NULL);

-- --- Deployed Smart Contracts -----------------------------------------------
CREATE TABLE IF NOT EXISTS cdk_contracts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_type   TEXT NOT NULL,                    -- 'token', 'bridge', 'governance', 'distribution'
  contract_name   TEXT NOT NULL,
  contract_address TEXT,                            -- On-chain address (0x...)
  deployer_address TEXT,                            -- Address that deployed the contract
  tx_hash         TEXT,                             -- Deployment transaction hash
  blockchain      TEXT NOT NULL DEFAULT 'MATIC',
  abi_json        TEXT,                             -- Contract ABI (JSON string)
  constructor_args TEXT,                            -- Constructor arguments (JSON string)
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending, deployed, verified, paused, destroyed
  block_number    INTEGER,
  gas_used        TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cdk_contracts_type ON cdk_contracts(contract_type);
CREATE INDEX IF NOT EXISTS idx_cdk_contracts_address ON cdk_contracts(contract_address);

-- --- Token Mint/Burn Operations ---------------------------------------------
CREATE TABLE IF NOT EXISTS cdk_token_operations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_type  TEXT NOT NULL,                    -- 'mint', 'burn'
  operation_number TEXT NOT NULL UNIQUE,            -- MINT-YYYYMMDD-XXXX or BURN-YYYYMMDD-XXXX
  -- Source/Destination
  from_account_id INTEGER,                         -- Banking account (for mint = source, burn = destination)
  to_wallet_id    INTEGER,                         -- Blockchain wallet (for mint = destination, burn = source)
  wallet_address  TEXT,                             -- On-chain wallet address
  -- Value
  amount_cents    INTEGER NOT NULL DEFAULT 0,       -- Banking ledger amount in cents
  token_amount    TEXT NOT NULL DEFAULT '0',         -- On-chain token amount (string, 6 decimals)
  -- Contract
  contract_id     INTEGER,                          -- Reference to cdk_contracts
  contract_address TEXT,                            -- Token contract address
  -- Transaction
  tx_hash         TEXT,                             -- On-chain transaction hash
  block_number    INTEGER,
  gas_used        TEXT,
  -- Status
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending, submitted, confirmed, failed, cancelled
  error_message   TEXT,
  -- Audit
  initiated_by    TEXT DEFAULT 'system',
  approved_by     TEXT,
  gl_journal_id   TEXT,                             -- Trust accounting journal entry reference
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (from_account_id) REFERENCES trust_accounts(id),
  FOREIGN KEY (to_wallet_id)    REFERENCES blockchain_wallets(id),
  FOREIGN KEY (contract_id)     REFERENCES cdk_contracts(id)
);

CREATE INDEX IF NOT EXISTS idx_cdk_ops_type ON cdk_token_operations(operation_type);
CREATE INDEX IF NOT EXISTS idx_cdk_ops_status ON cdk_token_operations(status);
CREATE INDEX IF NOT EXISTS idx_cdk_ops_number ON cdk_token_operations(operation_number);

-- --- Bridge Operations (L1 ↔ DLBT Chain) ------------------------------------
CREATE TABLE IF NOT EXISTS cdk_bridge_operations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  bridge_number   TEXT NOT NULL UNIQUE,             -- BRG-CDK-YYYYMMDD-XXXX
  direction       TEXT NOT NULL,                    -- 'deposit' (L1→DLBT), 'withdraw' (DLBT→L1)
  -- Source
  source_chain    TEXT NOT NULL DEFAULT 'MATIC',    -- Source chain
  source_address  TEXT,                             -- Source address on source chain
  source_tx_hash  TEXT,                             -- Source chain transaction hash
  -- Destination
  dest_chain      TEXT NOT NULL DEFAULT 'DLBT',     -- Destination chain
  dest_address    TEXT,                             -- Destination address on dest chain
  dest_tx_hash    TEXT,                             -- Destination chain transaction hash
  -- Value
  token           TEXT NOT NULL DEFAULT 'DLBT',     -- Token being bridged
  amount          TEXT NOT NULL,                    -- Amount in token units
  amount_cents    INTEGER NOT NULL DEFAULT 0,       -- Cents equivalent
  -- Status
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending, processing, confirmed, failed
  confirmations   INTEGER DEFAULT 0,
  error_message   TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cdk_bridge_status ON cdk_bridge_operations(status);
CREATE INDEX IF NOT EXISTS idx_cdk_bridge_direction ON cdk_bridge_operations(direction);

-- --- Coupon Distribution Events ---------------------------------------------
CREATE TABLE IF NOT EXISTS cdk_distributions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  distribution_number TEXT NOT NULL UNIQUE,          -- DIST-YYYYMMDD-XXXX
  distribution_type   TEXT NOT NULL,                 -- 'coupon', 'principal', 'income', 'custom'
  -- Source
  source_bond_id  INTEGER,                           -- Reference to fixed_income_holdings
  source_account_id INTEGER,                         -- Banking account funding the distribution
  -- Recipients
  recipients_json TEXT,                              -- JSON array of {address, amount, wallet_id}
  total_amount    TEXT NOT NULL DEFAULT '0',          -- Total DLBT distributed
  total_cents     INTEGER NOT NULL DEFAULT 0,
  -- Transaction
  contract_id     INTEGER,
  tx_hash         TEXT,
  batch_tx_hashes TEXT,                              -- JSON array if multi-tx
  -- Status
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending, processing, completed, failed
  error_message   TEXT,
  gl_journal_id   TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cdk_dist_type ON cdk_distributions(distribution_type);
CREATE INDEX IF NOT EXISTS idx_cdk_dist_status ON cdk_distributions(status);

-- --- Liquidity Pools (QuickSwap V3 / DEX) -----------------------------------
CREATE TABLE IF NOT EXISTS cdk_liquidity_pools (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_address    TEXT NOT NULL,                     -- On-chain pool address
  token0_address  TEXT NOT NULL,                     -- Token0 address (sorted by address)
  token1_address  TEXT NOT NULL,                     -- Token1 address
  dlbt_address    TEXT NOT NULL,                     -- DLBT token address
  usdc_address    TEXT NOT NULL,                     -- USDC address
  dex_name        TEXT NOT NULL DEFAULT 'QuickSwap V3',
  status          TEXT NOT NULL DEFAULT 'active',    -- active, paused, removed
  create_tx_hash  TEXT,
  init_tx_hash    TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cdk_lp_pool ON cdk_liquidity_pools(pool_address);

-- --- Liquidity Positions (NFT-based LP positions) ---------------------------
CREATE TABLE IF NOT EXISTS cdk_liquidity_positions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  position_number TEXT NOT NULL UNIQUE,              -- LP-YYYYMMDD-XXXX
  pool_address    TEXT NOT NULL,
  nft_token_id    TEXT,                              -- NFT position token ID
  dlbt_amount     TEXT NOT NULL DEFAULT '0',          -- DLBT deposited
  usdc_amount     TEXT NOT NULL DEFAULT '0',          -- USDC deposited
  tx_hash         TEXT,
  status          TEXT NOT NULL DEFAULT 'active',    -- active, removed
  owner_address   TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cdk_lpos_pool ON cdk_liquidity_positions(pool_address);
CREATE INDEX IF NOT EXISTS idx_cdk_lpos_status ON cdk_liquidity_positions(status);
