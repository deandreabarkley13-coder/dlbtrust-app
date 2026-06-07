-- Banking ↔ Crypto Bridge Schema
-- Tracks conversions between trust banking accounts and crypto wallets via MoonPay

CREATE TABLE IF NOT EXISTS bridge_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL CHECK(direction IN ('bank_to_crypto', 'crypto_to_bank')),
  status TEXT NOT NULL DEFAULT 'initiated' CHECK(status IN (
    'initiated', 'pending_approval', 'approved', 'moonpay_pending',
    'moonpay_processing', 'completed', 'failed', 'cancelled'
  )),
  -- Source
  source_account_id INTEGER,
  source_wallet_id INTEGER,
  -- Destination
  destination_wallet_id INTEGER,
  destination_account_id INTEGER,
  -- Amounts
  fiat_amount_cents INTEGER NOT NULL,
  crypto_amount TEXT, -- USDC amount (string for precision)
  fee_cents INTEGER DEFAULT 0,
  exchange_rate TEXT DEFAULT '1.000000', -- USD:USDC rate
  -- MoonPay
  moonpay_transaction_id TEXT,
  moonpay_widget_url TEXT,
  moonpay_status TEXT,
  moonpay_crypto_tx_hash TEXT,
  -- Polygon
  polygon_tx_hash TEXT,
  destination_address TEXT,
  -- GL
  journal_entry_id INTEGER,
  -- Approval
  requires_approval INTEGER DEFAULT 0,
  approved_by TEXT,
  approved_at TEXT,
  -- Metadata
  initiated_by TEXT DEFAULT 'user',
  notes TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bridge_orders_status ON bridge_orders(status);
CREATE INDEX IF NOT EXISTS idx_bridge_orders_direction ON bridge_orders(direction);
CREATE INDEX IF NOT EXISTS idx_bridge_orders_source_account ON bridge_orders(source_account_id);
CREATE INDEX IF NOT EXISTS idx_bridge_orders_moonpay ON bridge_orders(moonpay_transaction_id);

-- MoonPay webhook events for audit trail
CREATE TABLE IF NOT EXISTS moonpay_webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  transaction_id TEXT,
  status TEXT,
  crypto_amount TEXT,
  fiat_amount TEXT,
  wallet_address TEXT,
  tx_hash TEXT,
  raw_payload TEXT,
  processed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_moonpay_webhooks_txn ON moonpay_webhook_events(transaction_id);
