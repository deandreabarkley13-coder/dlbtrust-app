---
name: testing-bill-cash
description: Test the BILL Cash Account deposit flow end-to-end. Use when verifying BILL Cash deposit UI, API, payment method changes, or journal entry reference display.
---

# Testing BILL Cash Account Deposits

## Overview
The BILL Cash module lets the trust push funds to the BILL Cash Account (Bill.com, LLC -- routing 028000024, account ****0240) via three methods: Direct (BILL API only, instant), ACH Credit (batch + BILL recording, 1-2 days), and Wire Transfer (wire + BILL recording, same day). All methods call `billClient.recordDeposit()` to record the payment in BILL's dashboard.

**Important**: As of PR #145, deposits target the BILL Cash Account (****0240), NOT the Betterment bank account (****3054). The BILL Cash Account routing/account numbers are configured via `BILL_CASH_ROUTING` and `BILL_CASH_ACCOUNT` env vars (defaults: 028000024 / 10141741110240).

**Accounting**: Every BILL deposit creates a journal entry: DR 1050 BILL Cash / CR 1000 Trust Cash. The deposit result box shows a JE reference line in blue text (e.g. `JE: JRN-{timestamp}-{hash} | DR 1050 BILL Cash / CR 1000 Trust Cash`). The deposit form subtitle references both GL accounts: "Push funds from Trust Cash (1000) to BILL Cash Account (1050 -- ****0240)".

**Wire double-booking prevention**: As of PR #156, wire deposits from bill.js use `paymentType: 'bill_deposit'`, and wireEngine.sendWire() skips its own GL posting and cashflow event for `bill_deposit` wires to prevent double-booking Trust Cash.

## Devin Secrets Needed
- `BILL_DEV_KEY` / `BILL_USERNAME` / `BILL_PASSWORD` / `BILL_ORG_ID` -- stored in the app's environment (Fly.io secrets). Not needed directly by the tester; the app uses them server-side.
- `BILL_CASH_ROUTING` / `BILL_CASH_ACCOUNT` -- BILL Cash Account routing and account numbers (set as Fly.io secrets).
- Admin credentials for dashboard login (username: admin, password is the admin token configured in env).

## Prerequisites
1. App must be deployed (Fly.io at `https://dlbtrust-app.fly.dev` or local dev server on port 3002).
2. BILL API must be connected -- verify by checking the "Connection: Connected" badge on the BILL Cash page.
3. The subtitle under "Deposit Funds to BILL Account" should reference "BILL Cash Account (****0240)".

## How to Access
1. Navigate to the dashboard URL
2. Log in as admin
3. Click "BILL Cash" in the sidebar under "Core Banking"

## Test Procedure

### Test 1: Verify UI shows BILL Cash Account target with GL codes
- The subtitle should say "Push funds from Trust Cash (1000) to BILL Cash Account (1050 -- ****0240)."
- NOT "Betterment" or "****3054"
- Must reference BOTH GL account codes: 1000 (Trust Cash) and 1050 (BILL Cash)
- The Method dropdown should show 3 options: "Direct to BILL (instant)", "ACH Credit (1-2 business days)", "Wire Transfer (same day, requires approval)"

### Test 2: Direct deposit with journal entry
- Enter a small amount (e.g. $0.10), keep method as Direct, add a memo
- Click Send Funds, confirm the dialog -- dialog should say "to your BILL Cash Account (****0240)"
- Verify success box shows: "BILL Cash ****0240" as destination, Method: "Direct BILL API", BILL Ref starting with "0rp01"
- **Critical**: Verify the JE reference line appears in blue text: "JE: JRN-{id} | DR 1050 BILL Cash / CR 1000 Trust Cash"
- If JE line is missing, check server logs for "Journal entry failed" -- may indicate an import issue in `server/routes/bill.js`

### Test 3: ACH deposit with journal entry
- Change method to "ACH Credit", enter amount (e.g. $0.05), add memo
- Submit and confirm -- dialog should say "ACH Credit to your BILL Cash Account (****0240)"
- Verify: Method: "ACH Credit", Batch ID format "ACH-{timestamp}-{hash}", BILL Ref present
- **Critical**: Verify the JE reference line appears: "JE: JRN-{id} | DR 1050 BILL Cash / CR 1000 Trust Cash"
- Check deposit history -- BOTH the BILL API entry AND the ACH batch entry should show ****0240 destination

### Test 4: Wire deposit
- Change method to "Wire Transfer", enter amount (e.g. $0.25), add memo
- Submit and confirm -- dialog should say "Wire Transfer to your BILL Cash Account (****0240)"
- Verify: Method: "Wire Transfer", Wire ID format "WIRE-{date}-{hash}", Status: "pending_approval", BILL Ref present
- **Critical**: Verify only ONE JE is created (the bill.js JE with DR 1050/CR 1000), NOT a second one from wireEngine

### Test 5: Deposit history
- Scroll to Deposit History table
- All new deposits should show destination ****0240 (not ****3054)
- Old pre-PR#145 deposits may still show ****3054 -- this is expected historical data
- BILL API records show "Submitted to BILL" status; ACH batches show "accepted"

## Key Code Paths
- Deposit route: `server/routes/bill.js` (BILL Cash Account config ~line 115, 3 method branches: direct ~line 133, ach ~line 180, wire ~line 200)
- Journal entry creation: Each method branch calls `TrustAccountingEngine.postJournalEntry()` after deposit succeeds
- Cashflow events: Each method branch inserts into `cashflow_events` table for audit trail
- **Import pattern**: `var { TrustAccountingEngine } = require(...)` -- must use destructured import because `trustAccountingEngine.js` exports `module.exports = { TrustAccountingEngine }` (named export)
- Wire double-booking prevention: bill.js uses `paymentType: 'bill_deposit'`; wireEngine.sendWire() skips GL posting when `wire.payment_type === 'bill_deposit'`
- Deposit history: `server/routes/bill.js` (GET /api/bill/deposits ~line 286, routing array includes billCashRouting ~line 296)
- Frontend form: `public/dashboard.html` (subtitle ~line 848, dropdown ~line 857, billDeposit() ~line 3518, confirm dialog ~line 3530, jeRef display ~line 3596)
- BILL API client: `server/integrations/bill/billClient.js` (recordDeposit ~line 263)

## Common Issues
- **Deposit history missing new entries**: If ACH deposits to BILL Cash Account don't appear in history, check that `billCashRouting` (028000024) is included in the `routings` array in the deposits endpoint (~line 296). This was a bug fixed in PR #145.
- ******3054 showing for BILL API entries**: The BILL API payments section of deposit history should show ****0240. If it shows ****3054, the hardcoded value wasn't updated.
- **Masked account numbers**: BILL API returns `*****3054` for linked bank accounts. The deposit route uses BILL Cash Account numbers from env vars, not the masked values.
- **ACH batch status stuck on "pending"**: After BILL confirms a deposit, the batch should be updated to "accepted". Check the batch status update SQL.
- **BILL API session errors**: BILL uses session-based auth. If deposits fail with auth errors, check `billClient.js` login flow.
- **Journal entry missing ("postJournalEntry is not a function")**: This happens when `server/routes/bill.js` uses `var TrustAccountingEngine = require(...)` instead of `var { TrustAccountingEngine } = require(...)`. The module exports a named export `{ TrustAccountingEngine }`, so without destructuring you get the wrapper object, not the class.
- **JE reference not showing in result**: The frontend conditionally renders the JE line only when `r.journalEntry` exists with an `entryId` property. If the server-side JE creation fails silently, the result will show the deposit but no JE line.
- **Chrome crash during testing**: If the browser crashes after confirming a deposit dialog, the deposit may still have gone through server-side. Re-open the browser and check deposit history.
- **Confirmation dialog text**: The dialog should mention "BILL Cash Account (****0240)" not "Betterment".
- **Fly.io Postgres idle connections**: After long idle periods, the first API call may fail with "Connection terminated unexpectedly". Retry 2-3 times or restart the Fly.io machine (`fly apps restart dlbtrust-app`).

## Tips
- Use small amounts for testing ($0.01 minimum for Direct, $0.25+ for ACH/Wire).
- Each deposit creates a real record in BILL's sandbox/production -- be aware when testing repeatedly.
- The deposit history merges records from multiple sources (BILL API received payments + local ACH batches + wire records). If entries are missing, check all sources and verify the routing number is in the query's `routings` array.
- When switching deposit methods in the dropdown, the form fields reset. Re-enter amount and memo after changing methods.
