---
name: testing-electronic-settlement
description: Test the Electronic Settlement engine end-to-end. Use when verifying electronic payment submission, settlement lifecycle, integrity hash verification, Data Bridge sync, or circuit breaker behavior.
---

# Testing Electronic Settlement Engine

## Overview
The Electronic Settlement module provides instant payment transmission with secure settlement tracking. Payments are funded from Core Banking sub-ledger accounts and synchronized across modules via Data Bridge.

Settlement lifecycle: `submitted -> transmitted -> accepted -> clearing -> settled -> confirmed -> finalized`

## Devin Secrets Needed
- Admin token for API calls (stored as `ADMIN_SECRET_TOKEN` in Fly.io secrets, value: `dlb-admin-2026-trust`)
- BILL API credentials (`BILL_DEV_KEY`, `BILL_USERNAME`, `BILL_PASSWORD`, `BILL_ORG_ID`) — used server-side, not needed directly by tester

## Prerequisites
1. App deployed at `https://dlbtrust-app.fly.dev` (or local dev on port 3002)
2. BILL API connected (check System Status on dashboard: "BILL Cash Account: Connected")
3. At least one sub-ledger account with sufficient balance for test payments

## How to Access
1. Navigate to dashboard URL
2. Sidebar: click "Electronic Settlement" under "Core Banking"
3. Page shows: stat cards, submit form, recent settlements table, pending settlements table

## Test Procedure

### Test 1: Submit Payment with Sub-Ledger Funding
- Fill form: Payee Name, Amount (e.g. $10), Priority=Standard, Method=BILL API (instant)
- Select a sub-ledger from "Funding Source" dropdown (NOT "Trust Cash — default")
- Click "Submit Electronic Payment"
- **Pass criteria**: Green success box appears with:
  - Settlement ID starting with `ESTL-`
  - Payment Ref starting with `EPAY-`
  - BILL Ref starting with `0rp01` (proves BILL API called)
  - JE reference (`JRN-{timestamp}-{hash}`)
  - "Funded from: SL-INV-..." line (sub-ledger funding)
  - SLA deadline ~48h from now (for Standard priority)
- **Fail indicator**: If BILL Ref is missing or error appears, check server logs for `recordDeposit` failures. A common bug was calling `billClient.recordDeposit()` with positional args instead of a single object parameter — the function expects `recordDeposit({amount, method, memo})`.
- Sub-ledger balance in the dropdown should decrease by the payment amount

### Test 2: Settlement Table Verification
- After Test 1, check the "Recent Settlements" table
- **Pass criteria**: New row shows correct Settlement ID, Payee, Amount, Method=bill, Priority=standard, Sub-Ledger ID (NOT "Trust Cash"), Status=accepted, Sync button visible

### Test 3: Integrity Hash Verification (Critical)
- Call API: `GET /api/electronic-settlement/settlements/{settlement_id}/verify` with admin token
- **Pass criteria**: `integrity_valid: true`, `stored_hash === computed_hash` (both non-empty)
- **Fail indicator**: If `integrity_valid: false`, the timestamp used in hash computation doesn't match the stored `submitted_at`. The fix is to store the timestamp in a variable and pass it explicitly to both the INSERT and the hash computation.

### Test 4: Settlement Lifecycle (Confirm + Finalize)
- To advance status, click "Poll Updates" button (advances accepted -> clearing)
- When status is `clearing` or `settled`, a "Confirm" button appears in the Actions column
- Click "Confirm" — alert shows confirmation code (`ECONF-{base36}-{6chars}`)
- Status changes to `confirmed`, "Finalize" button appears
- Click "Finalize" — alert shows "Finalized! Settlement is now immutable."
- Status changes to `finalized`, no action buttons remain
- **Note**: The Confirm button only appears for `clearing` or `settled` status. You may need to click "Poll Updates" multiple times to advance through the lifecycle.

### Test 5: Data Bridge Sync
- Click "Sync" button on a settlement row (available for non-finalized settlements)
- Alert shows sync results for each module: trust_accounting, fineract, sub_ledger, cash
- **Pass criteria**: All modules show "OK"

### Test 6: Circuit Breaker Status
- Call API: `GET /api/electronic-settlement/circuit-status` with admin token
- **Pass criteria**: `open: false`, `failures: 0`, `threshold: 5`

### Test 7: Data Bridge Full Sync includes Electronic Settlements
- Call API: `POST /api/accounting/bridge/sync` with admin token
- **Pass criteria**: Response `results.electronicSettlements` object exists with `total`, `synced`, `unsynced` fields
- This validates the totalSynced undercount fix

## Key Code Paths
- Engine: `server/integrations/payments/electronicSettlementEngine.js`
- Routes: `server/routes/electronicSettlement.js`
- BILL payment execution: `executeBILLPayment()` at ~line 620 — calls `billClient.recordDeposit({amount, method, memo})`
- Integrity hash: `computeIntegrityHash()` — SHA256 of `settlement_id|amount|payee|submitted_at`
- Circuit breaker: `checkCircuit()` / `recordCircuitFailure()` — opens after 5 failures, resets after 60s
- Data Bridge integration: `server/integrations/accounting/dataBridge.js` step 10 in `runFullSync()`
- Frontend: `public/dashboard.html` — electronic settlement section starts at ~line 1395, JS functions at ~line 4570

## Common Issues
- **"Missing required data for: amount"**: The `billClient.recordDeposit()` function expects a single object `{amount, method, memo}`. If the call uses positional arguments `recordDeposit(amount, method, {description})`, the amount becomes the entire opts parameter and `opts.amount` is undefined.
- **Integrity hash mismatch**: The `submitted_at` timestamp must be stored in a variable before both the INSERT query and the hash computation. If `NOW()` is used in SQL and `new Date()` in JS, they produce different timestamps.
- **totalSynced undercount**: The `totalSynced` calculation in `dataBridge.js` must include `(results.electronicSettlements.synced || 0)`.
- **Confirm button not visible**: Only appears when status is `clearing` or `settled`. Use "Poll Updates" to advance from `accepted`.
- **Fly.io Postgres connection drops**: First request after idle may fail. Retry or click Refresh.
- **Data Bridge full-sync endpoint**: The correct URL is `POST /api/accounting/bridge/sync` (NOT `/api/data-bridge/full-sync`).
- **"BILL PayBills failed: Untrusted session"**: Vendor Payment type uses BILL's PayBills API which requires an MFA-trusted session. MFA sessions expire after server restarts or idle periods. The user must provide a new MFA code via `/api/bill/mfa/verify`. To test without MFA, use the "Record Deposit (ledger only)" payment type instead — it uses RecordARPayment which does not require MFA and still exercises sub-ledger debit, journal entry posting, and Data Bridge sync.
- **Data Bridge settlement sync shows unsynced**: The sync filter must use `status NOT IN ('failed','rejected','cancelled')` (exclusion-based), not `status IN ('confirmed','finalized')` (inclusion-based). Most settlements stay in `accepted`/`transmitted` status after BILL execution.

## Tips
- Use small amounts ($10 or less) for testing
- The "Poll Updates" button simulates BILL checking in on pending settlements and advances the lifecycle
- Each payment creates a real BILL API record — be aware when testing repeatedly
- The failed settlement from the pre-fix attempt (positional args bug) will remain in the table as evidence
- Sub-ledger balance decreases immediately on payment submission; if the BILL call fails, the debit is auto-reversed
- Settlement IDs follow format `ESTL-{8chars}-{4chars}`, confirmation codes `ECONF-{8chars}-{6chars}`
