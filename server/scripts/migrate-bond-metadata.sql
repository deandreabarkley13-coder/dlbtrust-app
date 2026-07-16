-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Add bond metadata columns (identifier, type, tax status)
-- Supports private placement bond identifiers and tax-exempt municipal bonds
-- ─────────────────────────────────────────────────────────────────────────────

-- Add new metadata columns to bonds table
ALTER TABLE bonds ADD COLUMN IF NOT EXISTS bond_identifier TEXT;
ALTER TABLE bonds ADD COLUMN IF NOT EXISTS bond_type TEXT DEFAULT 'corporate'
  CHECK (bond_type IN ('corporate', 'municipal', 'treasury', 'agency', 'private_placement'));
ALTER TABLE bonds ADD COLUMN IF NOT EXISTS tax_exempt BOOLEAN DEFAULT FALSE;
ALTER TABLE bonds ADD COLUMN IF NOT EXISTS tax_exempt_type TEXT;
ALTER TABLE bonds ADD COLUMN IF NOT EXISTS placement_type TEXT DEFAULT 'public'
  CHECK (placement_type IN ('public', 'private'));
ALTER TABLE bonds ADD COLUMN IF NOT EXISTS issuer TEXT;
ALTER TABLE bonds ADD COLUMN IF NOT EXISTS issuer_state TEXT;

-- Update DLB-PRB with private placement bond metadata
UPDATE bonds SET
  bond_identifier = '19781443-DLB-PRB',
  bond_type = 'municipal',
  tax_exempt = TRUE,
  tax_exempt_type = 'interest',
  placement_type = 'private',
  issuer = 'DeAndrea Lavar Barkley Trust',
  issuer_state = 'CA'
WHERE bond_name = 'DLB-PRB';
