-- ─── AS2 Certificates ────────────────────────────────────────────────────────
-- Stores local keypairs and partner public certificates

CREATE TABLE IF NOT EXISTS as2_certificates (
  id                  SERIAL PRIMARY KEY,
  alias               TEXT UNIQUE NOT NULL,
  cert_type           TEXT NOT NULL CHECK (cert_type IN ('local','partner')),
  subject_cn          TEXT,
  subject_org         TEXT,
  country             TEXT DEFAULT 'US',
  key_size            INTEGER,
  fingerprint_sha256  TEXT,
  certificate_pem     TEXT,
  private_key_path    TEXT,
  certificate_path    TEXT,
  valid_from          TIMESTAMPTZ,
  valid_to            TIMESTAMPTZ,
  status              TEXT DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ─── AS2 Trading Partners ────────────────────────────────────────────────────
-- Configuration for each bank/counterparty we exchange files with

CREATE TABLE IF NOT EXISTS as2_partners (
  id                      SERIAL PRIMARY KEY,
  partner_id              TEXT UNIQUE NOT NULL,
  as2_identifier          TEXT UNIQUE NOT NULL,
  name                    TEXT NOT NULL,
  endpoint_url            TEXT,
  cert_alias              TEXT REFERENCES as2_certificates(alias),
  encryption_algorithm    TEXT DEFAULT 'aes256-cbc',
  signing_algorithm       TEXT DEFAULT 'sha256',
  request_mdn             BOOLEAN DEFAULT TRUE,
  signed_mdn              BOOLEAN DEFAULT TRUE,
  mdn_url                 TEXT,
  content_type            TEXT DEFAULT 'application/octet-stream',
  notes                   TEXT,
  status                  TEXT DEFAULT 'active' CHECK (status IN ('active','inactive','suspended')),
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- ─── AS2 Messages ────────────────────────────────────────────────────────────
-- Tracks every inbound and outbound AS2 message

CREATE TABLE IF NOT EXISTS as2_messages (
  id                  SERIAL PRIMARY KEY,
  message_id          TEXT UNIQUE NOT NULL,
  direction           TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  as2_from            TEXT NOT NULL,
  as2_to              TEXT NOT NULL,
  partner_id          TEXT,
  filename            TEXT,
  content_type        TEXT,
  payload_size        INTEGER,
  mic                 TEXT,
  signed              BOOLEAN DEFAULT FALSE,
  encrypted           BOOLEAN DEFAULT FALSE,
  status              TEXT DEFAULT 'pending'
                        CHECK (status IN ('pending','sending','sent','received','processed','failed','error')),
  http_status         INTEGER,
  mdn_received        BOOLEAN DEFAULT FALSE,
  mdn_disposition     TEXT,
  response_body       TEXT,
  saved_path          TEXT,
  error_message       TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_as2_messages_direction ON as2_messages(direction);
CREATE INDEX IF NOT EXISTS idx_as2_messages_partner ON as2_messages(partner_id);
CREATE INDEX IF NOT EXISTS idx_as2_messages_status ON as2_messages(status);
CREATE INDEX IF NOT EXISTS idx_as2_messages_created ON as2_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_as2_partners_as2id ON as2_partners(as2_identifier);
CREATE INDEX IF NOT EXISTS idx_as2_certs_alias ON as2_certificates(alias);
