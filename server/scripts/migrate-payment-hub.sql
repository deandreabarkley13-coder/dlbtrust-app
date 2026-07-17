CREATE TABLE IF NOT EXISTS payment_intents (
  id BIGSERIAL PRIMARY KEY,
  intent_id TEXT UNIQUE NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_approval' CHECK (status IN (
    'draft','pending_approval','approved','queued','orchestrating','transmitting',
    'transmitted','accepted','clearing','settled','returned','failed','rejected','cancelled'
  )),
  rail TEXT NOT NULL DEFAULT 'ach' CHECK (rail IN ('ach','wire')),
  payment_type TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  source_type TEXT NOT NULL DEFAULT 'trust_account' CHECK (source_type IN ('trust_account','sub_ledger')),
  source_account_code TEXT,
  source_sub_ledger_id TEXT,
  debit_account_code TEXT NOT NULL,
  beneficiary_name TEXT NOT NULL,
  beneficiary_routing_encrypted TEXT NOT NULL,
  beneficiary_routing_hash TEXT NOT NULL,
  beneficiary_routing_last4 CHAR(4) NOT NULL,
  beneficiary_account_encrypted TEXT NOT NULL,
  beneficiary_account_hash TEXT NOT NULL,
  beneficiary_account_last4 VARCHAR(4) NOT NULL,
  beneficiary_account_type TEXT NOT NULL DEFAULT 'checking' CHECK (beneficiary_account_type IN ('checking','savings')),
  sec_code CHAR(3) NOT NULL DEFAULT 'CCD' CHECK (sec_code IN ('CCD','PPD')),
  effective_date DATE NOT NULL,
  description TEXT,
  maker_id TEXT NOT NULL,
  approval_count INTEGER NOT NULL DEFAULT 0,
  required_approvals INTEGER NOT NULL DEFAULT 1,
  payment_hub_txn_id TEXT,
  ach_batch_id TEXT,
  remote_reference TEXT,
  hold_id TEXT,
  accounting_status TEXT NOT NULL DEFAULT 'pending' CHECK (accounting_status IN ('pending','posting','posted','failed','reversed','not_required')),
  journal_entry_id TEXT,
  accounting_error TEXT,
  error_code TEXT,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  approved_at TIMESTAMPTZ,
  queued_at TIMESTAMPTZ,
  transmitted_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  returned_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (source_type = 'trust_account' AND source_account_code IS NOT NULL)
    OR (source_type = 'sub_ledger' AND source_sub_ledger_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS payment_approvals (
  id BIGSERIAL PRIMARY KEY,
  approval_id TEXT UNIQUE NOT NULL,
  intent_id TEXT NOT NULL,
  approver_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (intent_id, approver_id)
);

CREATE TABLE IF NOT EXISTS payment_events (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT UNIQUE NOT NULL,
  intent_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  actor_id TEXT NOT NULL,
  external_event_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  previous_hash CHAR(64),
  event_hash CHAR(64) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (intent_id, external_event_id)
);

CREATE TABLE IF NOT EXISTS payment_funding_holds (
  id BIGSERIAL PRIMARY KEY,
  hold_id TEXT UNIQUE NOT NULL,
  intent_id TEXT UNIQUE NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('trust_account','sub_ledger')),
  source_id TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','captured','released','expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  captured_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  release_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_webhook_receipts (
  id BIGSERIAL PRIMARY KEY,
  receipt_id TEXT UNIQUE NOT NULL,
  external_event_id TEXT UNIQUE NOT NULL,
  intent_id TEXT,
  event_type TEXT NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'pending' CHECK (processing_status IN ('pending','processed','rejected','failed')),
  error_message TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF to_regclass('public.ach_batches') IS NOT NULL THEN
    ALTER TABLE ach_batches ADD COLUMN IF NOT EXISTS orchestration_owner TEXT;
    ALTER TABLE ach_batches ADD COLUMN IF NOT EXISTS payment_intent_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_ach_batches_payment_intent ON ach_batches(payment_intent_id);
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.vendor_payments') IS NOT NULL THEN
    ALTER TABLE vendor_payments ADD COLUMN IF NOT EXISTS payment_intent_id TEXT;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.electronic_settlements') IS NOT NULL THEN
    ALTER TABLE electronic_settlements ADD COLUMN IF NOT EXISTS payment_intent_id TEXT;
    ALTER TABLE electronic_settlements ADD COLUMN IF NOT EXISTS payment_hub_txn_id TEXT;
    ALTER TABLE electronic_settlements ADD COLUMN IF NOT EXISTS payment_hub_status TEXT;
    ALTER TABLE electronic_settlements ADD COLUMN IF NOT EXISTS accounting_status TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE electronic_settlements ADD COLUMN IF NOT EXISTS accounting_error TEXT;
    UPDATE electronic_settlements
    SET accounting_status = 'posted'
    WHERE journal_entry_id IS NOT NULL AND accounting_status <> 'posted';
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'electronic_settlements'::regclass
        AND conname = 'electronic_settlements_accounting_status_check'
    ) THEN
      ALTER TABLE electronic_settlements
        ADD CONSTRAINT electronic_settlements_accounting_status_check
        CHECK (accounting_status IN ('pending','posting','posted','failed'));
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.wire_transfers') IS NOT NULL THEN
    ALTER TABLE wire_transfers ADD COLUMN IF NOT EXISTS accounting_status TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE wire_transfers ADD COLUMN IF NOT EXISTS accounting_error TEXT;
    UPDATE wire_transfers
    SET accounting_status = 'posted'
    WHERE journal_entry_id IS NOT NULL AND accounting_status <> 'posted';
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'wire_transfers'::regclass
        AND conname = 'wire_transfers_accounting_status_check'
    ) THEN
      ALTER TABLE wire_transfers
        ADD CONSTRAINT wire_transfers_accounting_status_check
        CHECK (accounting_status IN ('pending','posting','posted','failed'));
    END IF;
    ALTER TABLE wire_transfers ALTER COLUMN sender_name DROP DEFAULT;
    ALTER TABLE wire_transfers ALTER COLUMN sender_routing DROP DEFAULT;
    ALTER TABLE wire_transfers ALTER COLUMN sender_account DROP DEFAULT;
    ALTER TABLE wire_transfers ALTER COLUMN sender_address DROP DEFAULT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payment_intents_status ON payment_intents(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_intents_hub_txn ON payment_intents(payment_hub_txn_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_ach_batch ON payment_intents(ach_batch_id);
CREATE INDEX IF NOT EXISTS idx_payment_events_intent ON payment_events(intent_id, id);
CREATE INDEX IF NOT EXISTS idx_payment_holds_source ON payment_funding_holds(source_type, source_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_holds_expiry ON payment_funding_holds(status, expires_at);
