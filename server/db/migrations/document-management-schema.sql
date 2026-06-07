-- ---------------------------------------------------------------------------
-- Document Management System Schema
-- DEANDREA LAVAR BARKLEY TRUST — Trust Document Repository
-- ---------------------------------------------------------------------------

-- --- Documents ---------------------------------------------------------------
-- Core document records (trust agreements, amendments, certificates, etc.)
CREATE TABLE IF NOT EXISTS dms_documents (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  title                 TEXT NOT NULL,
  description           TEXT,
  category              TEXT NOT NULL DEFAULT 'general',
  -- trust_agreement, amendment, certificate, offering_memorandum,
  -- compliance, tax, financial_statement, correspondence,
  -- board_resolution, beneficiary, vendor, regulatory, general
  sub_category          TEXT,
  -- Document metadata
  file_name             TEXT NOT NULL,
  file_type             TEXT NOT NULL,     -- pdf, docx, xlsx, jpg, png, txt, etc.
  file_size_bytes       INTEGER NOT NULL DEFAULT 0,
  mime_type             TEXT,
  -- Storage (file stored as base64 in content or as file path)
  storage_type          TEXT NOT NULL DEFAULT 'database',  -- database, filesystem
  file_content          BLOB,              -- actual file content (for small files)
  file_path             TEXT,              -- relative path for filesystem storage
  -- Versioning
  version               INTEGER NOT NULL DEFAULT 1,
  parent_document_id    INTEGER,           -- points to previous version
  is_latest             INTEGER NOT NULL DEFAULT 1,
  -- Trust association
  related_entity_type   TEXT,              -- account, bond, wallet, contact, transfer
  related_entity_id     INTEGER,
  -- Workflow
  status                TEXT NOT NULL DEFAULT 'draft',  -- draft, active, under_review, approved, archived, superseded
  requires_signature    INTEGER NOT NULL DEFAULT 0,
  signed_by             TEXT,
  signed_at             TEXT,
  approved_by           TEXT,
  approved_at           TEXT,
  -- Tags (comma-separated for simple search)
  tags                  TEXT,
  -- Expiration (for compliance documents)
  effective_date        TEXT,
  expiration_date       TEXT,
  -- Audit
  uploaded_by           TEXT NOT NULL DEFAULT 'system',
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (parent_document_id) REFERENCES dms_documents(id)
);

CREATE INDEX IF NOT EXISTS idx_dms_doc_category ON dms_documents(category);
CREATE INDEX IF NOT EXISTS idx_dms_doc_status ON dms_documents(status);
CREATE INDEX IF NOT EXISTS idx_dms_doc_entity ON dms_documents(related_entity_type, related_entity_id);
CREATE INDEX IF NOT EXISTS idx_dms_doc_tags ON dms_documents(tags);
CREATE INDEX IF NOT EXISTS idx_dms_doc_latest ON dms_documents(is_latest);
CREATE INDEX IF NOT EXISTS idx_dms_doc_expiration ON dms_documents(expiration_date);

-- --- Document Access Log -----------------------------------------------------
-- Who accessed what document and when
CREATE TABLE IF NOT EXISTS dms_access_log (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id           INTEGER NOT NULL,
  action                TEXT NOT NULL,      -- view, download, print, share, edit, sign, approve
  performed_by          TEXT NOT NULL DEFAULT 'system',
  ip_address            TEXT,
  details               TEXT,              -- JSON with additional context
  created_at            TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (document_id) REFERENCES dms_documents(id)
);

CREATE INDEX IF NOT EXISTS idx_dms_access_doc ON dms_access_log(document_id);
CREATE INDEX IF NOT EXISTS idx_dms_access_time ON dms_access_log(created_at);

-- --- Document Templates -------------------------------------------------------
-- Reusable templates for common trust documents
CREATE TABLE IF NOT EXISTS dms_templates (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT NOT NULL,
  description           TEXT,
  category              TEXT NOT NULL,
  template_content      TEXT,              -- HTML/text template with placeholders
  placeholders          TEXT,              -- JSON array of placeholder field definitions
  is_active             INTEGER NOT NULL DEFAULT 1,
  usage_count           INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dms_tmpl_category ON dms_templates(category);

-- --- Document Retention Policies ----------------------------------------------
-- Automated retention and disposition rules
CREATE TABLE IF NOT EXISTS dms_retention_policies (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT NOT NULL,
  category              TEXT NOT NULL,      -- which document category this applies to
  retention_years       INTEGER NOT NULL DEFAULT 7,
  action_on_expiry      TEXT NOT NULL DEFAULT 'archive',  -- archive, delete, review
  notification_days     INTEGER NOT NULL DEFAULT 30,  -- notify N days before expiry
  is_active             INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dms_ret_category ON dms_retention_policies(category);
