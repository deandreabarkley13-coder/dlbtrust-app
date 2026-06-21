---
name: testing-dlbtrust-app
description: Test the DLB Trust treasury management app end-to-end. Use when verifying dashboard, accounting, bond, cash, or reporting changes.
---

## Local Dev Setup

1. **Install PostgreSQL** (if not in blueprint):
   ```bash
   sudo apt-get install -y postgresql postgresql-client
   sudo pg_ctlcluster 14 main start
   ```

2. **Configure PostgreSQL auth** — default `pg_hba.conf` uses peer auth which blocks password connections:
   ```bash
   sudo sed -i 's/local   all             postgres                                peer/local   all             postgres                                md5/' /etc/postgresql/14/main/pg_hba.conf
   sudo sed -i 's/local   all             all                                     peer/local   all             all                                     md5/' /etc/postgresql/14/main/pg_hba.conf
   sudo pg_ctlcluster 14 main restart
   ```

3. **Set PostgreSQL password and create database**:
   ```bash
   sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';"
   sudo -u postgres psql -c "CREATE DATABASE fineract_tenants;"
   ```

4. **Run all migrations** in order:
   ```bash
   cd /home/ubuntu/repos/dlbtrust-app
   PGPASSWORD=postgres psql -U postgres -d fineract_tenants -f server/scripts/migrate-postgres-full.sql
   PGPASSWORD=postgres psql -U postgres -d fineract_tenants -f server/scripts/migrate-docs-accounting.sql
   PGPASSWORD=postgres psql -U postgres -d fineract_tenants -f server/scripts/migrate-reports-gl-mappings.sql
   PGPASSWORD=postgres psql -U postgres -d fineract_tenants -f server/scripts/migrate-ach.sql
   PGPASSWORD=postgres psql -U postgres -d fineract_tenants -f server/scripts/migrate-as2.sql
   PGPASSWORD=postgres psql -U postgres -d fineract_tenants -f server/scripts/migrate-tax-engine.sql
   PGPASSWORD=postgres psql -U postgres -d fineract_tenants -f server/scripts/migrate-cashflow-events.sql
   ```

5. **Start the server** (use `server-3002.js` — the production entry point with all routes):
   ```bash
   ADMIN_SECRET_TOKEN=test-admin-token-123 PORT=3009 node server/server-3002.js
   ```
   Server runs on the specified PORT (default 3002). Use 3009 or another port to avoid conflicts.

## Key Endpoints

- **Dashboard**: `http://localhost:<PORT>` — Treasury Dashboard with sidebar navigation
- **Admin Controls**: sidebar → Admin Controls → enter admin token → view System Health + Audit Log
- **Fixed Income Engine**: sidebar → Fixed Income Engine → tabs: Holdings, Live Metrics, Cashflow, Transactions
- **Trust Accounting**: sidebar → Trust Accounting → tabs: Chart of Accounts, Journal Entries, Trial Balance, Balance Sheet, Income Statement, Cashflow, Periods, Statements
- **Tax Engine**: sidebar → Tax Engine → tabs: Form 1041, K-1 Schedules, Tax Payments, Trust Config
- **Payments & Disbursements**: sidebar → Payments & Disbursements → summary cards, disbursement form, batch table
- **Health API**: `GET /api/admin/system/health` (requires `x-admin-token` header)
- **Audit API**: `GET /api/admin/audit-log` (requires `x-admin-token` header)
- **Fixed Income Dashboard API**: `GET /api/bonds/fixed-income/dashboard`
- **Fixed Income Cashflow API**: `GET /api/bonds/fixed-income/cashflow`
- **Accounting Cashflow API**: `GET /api/accounting/reports/cashflow` (includes bond cashflow enrichment)
- **Accrue All API**: `POST /api/admin/system/accrue-all` (requires `x-admin-token` header)
- **Statement Generation**: `POST /api/accounting/statements/generate` with `{ reportType, fromDate, toDate, format }`
- **Statement Render**: `GET /api/documents/statements/:jobId/render`
- **Payment Summary API**: `GET /api/ach-pipeline/payment-summary`

## Admin Auth

The admin routes require an `x-admin-token` header (or `?adminToken=` query param) matching the `ADMIN_SECRET_TOKEN` environment variable. Set this to any value when starting the server for local testing.

## Database Connection

The app connects via `pgPool.js` using:
- Host: `FINERACT_DB_HOST` or `localhost`
- Port: `FINERACT_DB_PORT` or `5432`
- User: `FINERACT_DB_USER` or `postgres`
- Password: `FINERACT_DB_PASSWORD` or `postgres`
- Database: `BOND_DB_NAME` or `fineract_tenants`

## Testing GL Validation

GL mapping validation can be tested via Node.js CLI without the browser:
```bash
cd /home/ubuntu/repos/dlbtrust-app
node -e "
const { BondEngine } = require('./server/integrations/bonds/bondEngine');
BondEngine.accrueInterest(1, new Date(), { glDebitAccountId: 100 })
  .catch(e => console.log(e.message));
// Expected: 'GL mapping incomplete: glDebitAccountId provided but glCreditAccountId is missing'
"
```

## Testing ACH Pipeline & AS2 Integration

The ACH Pipeline page (sidebar → "ACH Pipeline") shows AS2 configuration status. Key fields:
- **AS2 Configured**: "Yes"/"No" — checks both DB-managed partners and env vars
- **Partner AS2 ID**: Shows the active DB partner's AS2 ID, or falls back to env var default
- **DB partner(s)**: Sub-text showing count of database-managed partners

To test the pipeline integration:
1. Navigate to **AS2 Server** (sidebar → "AS2 Server")
2. Click **"+ Add Partner"** → fill Name, AS2 ID, Endpoint URL → **"Save Partner"**
3. Navigate to **ACH Pipeline** → verify "AS2 Configured" changed from "No" to "Yes"
4. Verify API: `curl -s http://localhost:3001/api/ach-pipeline/status | python3 -m json.tool`
   - `data.configured` should be `true`
   - `data.as2_config.db_partners` should be `1`
   - `data.as2_config.active_partner.as2_id` should match the partner you added

**Important field mapping notes** (fixed in PR #85):
- Dashboard form sends `{ name, as2Id, url }` — these must match `PartnerManager.createPartner()` schema
- Partner table reads `p.name` and `p.as2_identifier` from DB — not `partner_name`/`as2_id`
- If these mappings are wrong, the form will fail with "as2Id and name are required" and the table will show blank cells

**AS2 certificate generation**: Click "Generate Keypair" on AS2 Server page. Creates a self-signed RSA cert stored in `data/as2-certs/`. The cert alias defaults to `as2-local-TIMESTAMP`.

## Testing Fineract GL Seeding

Navigate to Admin Controls → set admin token → click "Seed Fineract GL". Expected: 17 accounts listed with action "created" (first run) or "skipped" (subsequent runs). Requires Docker Fineract running (`docker compose up -d`).

## Fineract

Fineract (Apache Fineract GL) requires Docker (`docker compose up -d`). It will show as "error"/"disconnected" in local testing without Docker. This is expected and does not block testing of other features.

## Testing Fixed Income Engine

The Fixed Income Engine page (sidebar → "Fixed Income Engine") shows bond portfolio with GL integration. Key elements:

- **Summary cards**: Principal Outstanding, Accrued Interest, Daily Accrual, Total Interest Paid, Wtd Avg Coupon, Active Bonds
- **GL badge**: Shows "GL CONNECTED" (green) with "17 GL mappings active" when `fineract_gl_mappings` table is populated
- **4 tabs**: Holdings, Live Metrics, Cashflow, Transactions
- **"Run Accrual (GL+Accounting)" button**: Triggers `POST /api/admin/system/accrue-all` via the FixedIncomeOrchestrator — requires admin token set first

**Admin token setup** (required before accrual): Navigate to Admin Controls → enter token in input → click "Set Token". Token is stored in `localStorage` as `dlb_admin_token`.

**Testing the accrual flow:**
1. Note current Accrued Interest value on the Fixed Income Engine page
2. Set admin token in Admin Controls
3. Return to Fixed Income Engine → click "Run Accrual (GL+Accounting)"
4. Alert should show: "Accrual complete: N bonds, +$X.XX (GL + Accounting integrated)"
5. Accrued Interest card should increase by the accrued amount
6. Cashflow tab should show new line item under "Operating (Bond Interest)"

**Expected values for DLB-PRB bond:**
- Face value: $100,000,000
- Coupon rate: 1% (30/360 day count)
- Daily accrual: $2,777.78 (= $100M × 0.01 / 360)
- Annual income estimate: $1,000,000

**Verifying journal entries (shell):**
```bash
curl -s http://localhost:<PORT>/api/accounting/journal | python3 -m json.tool
# Look for entries with reference_type: "bond_accrual"
# Each should have entry_id starting with "JRN-"
```

**Verifying journal lines in DB:**
```bash
PGPASSWORD=postgres psql -U postgres -d fineract_tenants -c "
  SELECT entry_id, account_code, debit_amount, credit_amount
  FROM trust_journal_lines
  WHERE entry_id = '<JRN-ID>'
  ORDER BY id;
"
# Expected: DR 1200 (Accrued Interest Receivable) / CR 4100 (Fee Income)
```

**Trust Accounting cashflow enrichment:**
Navigate to Trust Accounting → Cashflow tab. Should show:
- "Operating Activities (Bond Interest)" with bond accrual amounts
- "Investing Activities (Bond Principal)" with bond issuance (-$100M)
- "Integrated Net Cashflow" label (not old "Net Cash Change")

**Key architecture note:** The `FixedIncomeOrchestrator` wraps `BondEngine` operations and automatically creates trust journal entries + cashflow events. The `/api/bonds/fixed-income/dashboard` and `/api/bonds/fixed-income/cashflow` routes MUST be defined before `/:id` routes in `server/routes/bonds.js` to avoid route collision (otherwise "fixed-income" gets parsed as a bond ID).

## Testing Tax Engine

The Tax Engine page (sidebar → "Tax Engine") shows Form 1041 computation and K-1 generation.

- **Summary cards**: Trust EIN (99-6411566), Trust Type (COMPLEX), Beneficiary Count
- **4 tabs**: Form 1041, K-1 Schedules, Tax Payments, Trust Config
- **Form 1041 Compute**: Click "Compute 1041" → shows tax computation with $100 exemption (complex trust)
- **K-1 Generate**: Click "Generate K-1s" → creates K-1 for each active beneficiary
- **Tax default year**: Uses current year. If testing with prior year data, results may be empty

## Testing Payment & Distribution Engine

The Payments & Disbursements page (sidebar → "Payments & Disbursements") shows ACH payment management. Key elements:

- **Summary cards**: Total Batches, Transmitted, Total Disbursed, ODFI (241075470)
- **Disbursement form**: Beneficiary name, bank info, amount, payment type, memo
- **Payment Type dropdown**: Trust Distribution, Vendor Payment, Interest Payment, Principal Return
- **Batch table**: Shows batch ID, description, entries, amount, SEC code, status, actions (Transmit/Cancel)
- **Confirmation dialogs**: Both Transmit and Cancel buttons show `confirm()` dialog before executing

**Testing the disbursement flow:**
1. Navigate to Payments & Disbursements
2. Fill form: First Name, Last Name, Bank Name, Routing (9 digits), Account Number, Amount, Payment Type
3. Click "Create Disbursement Batch"
4. Verify: green success message with Batch ID (ACH-*), NACHA filename
5. Verify: batch table shows new row with correct amount (converted from cents), PPD badge, PENDING status
6. Verify: summary cards update (Total Batches +1, pending count +1)

**Verifying journal entries (shell):**
```bash
PGPASSWORD=postgres psql -U postgres -d fineract_tenants -c "
  SELECT entry_id, account_code, debit_amount, credit_amount
  FROM trust_journal_lines ORDER BY id DESC LIMIT 4;
"
# Trust Distribution: DR 5100 (Distributions) / CR 1000 (Cash)
# Vendor Payment: DR 5200 (Expenses) / CR 1000 (Cash)
```

**Verifying cashflow events (shell):**
```bash
PGPASSWORD=postgres psql -U postgres -d fineract_tenants -c "
  SELECT event_type, category, amount, direction
  FROM cashflow_events WHERE event_type = 'distribution';
"
# Expected: event_type=distribution, category=financing, direction=outflow
```

**Important notes:**
- The `cashflow_events` table has a CHECK constraint on `event_type`. Valid values: bond_accrual, interest_payment, principal_payment, bond_issuance, bond_maturity, cash_deposit, cash_transfer, cash_withdrawal, fee_payment, distribution, other. Using invalid values (e.g., 'ach_disbursement') will cause silent INSERT failures.
- The batch table reads `total_amount_cents` from DB (not `total_amount`) — amount is divided by 100 for display.
- The `loadOverview()` function needs the admin health API call to display Payment Mode in System Status. If admin token is not set, Payment Mode badge may not appear.
- `PAYMENT_MODE` env var controls sandbox/production display (default: sandbox).

**Testing cancel confirmation:**
1. Click "Cancel" on a pending batch → confirm dialog appears
2. Dismiss dialog → batch stays PENDING (proves gate works)
3. Click "Cancel" again → confirm → batch changes to CANCELLED, buttons removed

## Server Entry Points

- `server-new-fixed.js` — older entry point, may be missing newer routes (tax, fixed income orchestrator)
- `server/server-3002.js` — **production entry point**, has all routes including tax engine and fixed income. Use this for testing.

## Devin Secrets Needed

- No secrets are strictly required for local testing
- `ADMIN_SECRET_TOKEN` can be set to any value locally
- PostgreSQL uses default `postgres`/`postgres` credentials locally
