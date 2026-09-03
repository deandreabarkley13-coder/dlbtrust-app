-- ─────────────────────────────────────────────────────────────────────────────
-- Bond Financial Statement — statement identity, bondholder and venue on bonds,
-- and alignment of DLB-PRB with Bond Financial Statement #197814430
-- (Official Statement of Account & Proof of Venue, as of September 1, 2026).
-- Idempotent; safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE bonds ADD COLUMN IF NOT EXISTS statement_id TEXT;
ALTER TABLE bonds ADD COLUMN IF NOT EXISTS bondholder TEXT;
ALTER TABLE bonds ADD COLUMN IF NOT EXISTS venue_state TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bonds_statement_id ON bonds(statement_id) WHERE statement_id IS NOT NULL;

-- Statement terms: $100,000,000 par, 1.00% per annum paid semi-annually
-- (0.50% / $500,000.00 per period), issued 2024-02-28, matures 2124-02-28,
-- issued by DEANDREA LAVAR BARKLEY TRUST COMPANY to DeAndrea Lavar Barkley,
-- venue State of Ohio.
UPDATE bonds
SET statement_id  = '197814430',
    bondholder    = 'DeAndrea Lavar Barkley',
    issuer        = 'DEANDREA LAVAR BARKLEY TRUST COMPANY',
    venue_state   = 'OH',
    payment_freq  = 'semi-annual',
    updated_at    = NOW()
WHERE bond_name = 'DLB-PRB'
  AND face_value = 100000000.00
  AND coupon_rate = 0.01
  AND issue_date = '2024-02-28'
  AND maturity_date = '2124-02-28'
  AND statement_id IS NULL;

-- Coupon periods 1..5 (08/28/2024 .. 08/28/2026) are registered on the ledger
-- by BondStatementEngine.registerCoupons — run:
--   node server/scripts/registerBondStatement.js 197814430 2026-09-01
