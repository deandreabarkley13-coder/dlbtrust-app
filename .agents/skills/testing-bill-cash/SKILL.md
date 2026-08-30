---
name: testing-bill-cash
description: Test the BILL Cash Account deposit flow end-to-end. Use when verifying BILL Cash deposit UI, API, payment method changes, real-time sync engine, or settlement tracking.
---

# Testing BILL Cash Account Deposits & Sync Engine

## Overview
The BILL Cash module lets the trust push funds to the BILL Cash Account (Bill.com, LLC — routing 028000024, account ****0240) via three methods: Direct (BILL API only, instant), ACH Credit (batch + BILL recording, 1-2 days), and Wire Transfer (wire + BILL recording, same day). All methods call `billClient.recordDeposit()` to record the payment in BILL's dashboard.

**Important**: As of PR #145, deposits target the BILL Cash Account (****0240), NOT the Betterment bank account (****3054). The BILL Cash Account routing/account numbers are configured via `BILL_CASH_ROUTING` and `BILL_CASH_ACCOUNT` env vars (defaults: 028000024 / 10141741110240).

**Accounting**: As of PR #155, every BILL deposit creates a journal entry: DR 1050 BILL Cash / CR 1000 Trust Cash. The deposit result box shows a JE reference line (e.g. `JE: JRN-{timestamp}-{hash} | DR 1050 BILL Cash / CR 1000 Trust Cash`). The deposit form subtitle now references both GL accounts: "Push funds from Trust Cash (1000) to BILL Cash Account (1050 -- ****0240)".

## Devin Secrets Needed
- `BILL_DEV_KEY` / `BILL_USERNAME` / `BILL_PASSWORD` / `BILL_ORG_ID` — stored in the app's environment (Fly.io secrets). Not needed directly by the tester; the app uses them server-side.
- `BILL_CASH_ROUTING` / `BILL_CASH_ACCOUNT` — BILL Cash Account routing and account numbers (set as Fly.io secrets).
- `BILL_SYNC_TOKEN` — opaque sync token for BILL's GetEntityChanges incremental polling API. Stored as Fly.io secret.
- Admin credentials for dashboard login (username: admin, password is the admin token configured in env).

## Prerequisites
1. App must be deployed (Fly.io at `https://dlbtrust-app.fly.dev` or local dev server on port 3002).
2. BILL API must be connected — verify by checking the "Connection: Connected" badge on the BILL Cash page.
3. The subtitle under "Deposit Funds to BILL Account" should reference "BILL Cash Account (****0240)".

## How to Access
1. Navigate to the dashboard URL
2. Log in as admin
3. Click "BILL Cash" in the sidebar under "Core Banking"

## Test Procedure

### Test 1: Verify UI shows BILL Cash Account target with GL codes
- The subtitle should say "Push funds from Trust Cash (1000) to BILL Cash Account (1050 -- ****0240). Journal entry: DR 1050 BILL Cash / CR 1000 Trust Cash."
- NOT "Betterment" or "****3054"
- Must reference BOTH GL account codes: 1000 (Trust Cash) and 1050 (BILL Cash)
- The Method dropdown should show 3 options: "Direct to BILL (instant)", "ACH Credit (1-2 business days)", "Wire Transfer (same day, requires approval)"

### Test 2: Direct deposit with journal entry
- Enter a small amount (e.g. $0.10), keep method as Direct, add a memo
- Click Send Funds, confirm the dialog — dialog should say "to your BILL Cash Account (****0240)"
- Verify success box shows: "BILL Cash ****0240" as destination, Method: "Direct BILL API", BILL Ref starting with "0rp01"
- **Critical**: Verify the JE reference line appears: "JE: JRN-{id} | DR 1050 BILL Cash / CR 1000 Trust Cash"
- If JE line is missing, check server logs for "Journal entry failed" — may indicate an import issue in `server/routes/bill.js`

### Test 3: ACH deposit with journal entry
- Change method to "ACH Credit", enter amount (e.g. $0.05), add memo
- Submit and confirm — dialog should say "ACH Credit to your BILL Cash Account (****0240)"
- Verify: Method: "ACH Credit", Batch ID format "ACH-{timestamp}-{hash}", BILL Ref present
- **Critical**: Verify the JE reference line appears: "JE: JRN-{id} | DR 1050 BILL Cash / CR 1000 Trust Cash"
- Check deposit history — BOTH the BILL API entry AND the ACH batch entry should show ****0240 destination

### Test 4: Wire deposit
- Change method to "Wire Transfer", enter amount (e.g. $0.25), add memo
- Submit and confirm — dialog should say "Wire Transfer to your BILL Cash Account (****0240)"
- Verify: Method: "Wire Transfer", Wire ID format "WIRE-{date}-{hash}", Status: "pending_approval", BILL Ref present

### Test 5: Deposit history
- Scroll to Deposit History table
- All new deposits should show destination ****0240 (not ****3054)
- Old pre-PR#145 deposits may still show ****3054 — this is expected historical data
- BILL API records show "Submitted to BILL" status; ACH batches show "accepted"

## Key Code Paths
- Deposit route: `server/routes/bill.js` (BILL Cash Account config ~line 115, 3 method branches: direct ~line 133, ach ~line 180, wire ~line 200)
- Journal entry creation: Each method branch calls `TrustAccountingEngine.postJournalEntry()` after deposit succeeds
- **Import pattern**: `var { TrustAccountingEngine } = require(...)` — must use destructured import because `trustAccountingEngine.js` exports `module.exports = { TrustAccountingEngine }` (named export)
- Deposit history: `server/routes/bill.js` (GET /api/bill/deposits ~line 286, routing array includes billCashRouting ~line 296)
- Frontend form: `public/dashboard.html` (subtitle ~line 848, dropdown ~line 857, billDeposit() ~line 3518, confirm dialog ~line 3530)
- BILL API client: `server/integrations/bill/billClient.js` (recordDeposit ~line 263)

## Common Issues
- **Deposit history missing new entries**: If ACH deposits to BILL Cash Account don't appear in history, check that `billCashRouting` (028000024) is included in the `routings` array in the deposits endpoint (~line 296). This was a bug fixed in PR #145.
- ******3054 showing for BILL API entries**: The BILL API payments section of deposit history should show ****0240 (dynamic from `BILL_CASH_ACCOUNT` env var). If it shows ****3054, the hardcoded value wasn't updated.
- **Masked account numbers**: BILL API returns `*****3054` for linked bank accounts. The deposit route uses BILL Cash Account numbers from env vars, not the masked values.
- **ACH batch status stuck on "pending"**: After BILL confirms a deposit, the batch should be updated to "accepted". Check the batch status update SQL.
- **BILL API session errors**: BILL uses session-based auth. If deposits fail with auth errors, check `billClient.js` login flow.
- **Journal entry missing ("postJournalEntry is not a function")**: This happens when `server/routes/bill.js` uses `var TrustAccountingEngine = require(...)` instead of `var { TrustAccountingEngine } = require(...)`. The module exports a named export `{ TrustAccountingEngine }`, so without destructuring you get the wrapper object, not the class. The deposit still succeeds (JE creation is wrapped in try/catch) but the JE reference won't appear in the result.
- **JE reference not showing in result**: The frontend conditionally renders the JE line only when `r.journalEntry` exists with an `entryId` property. If the server-side JE creation fails silently, the result will show the deposit but no JE line.
- **Chrome crash during testing**: If the browser crashes after confirming a deposit dialog (observed during wire testing), the deposit may still have gone through server-side. Re-open the browser and check deposit history.
- **Confirmation dialog text**: The dialog should mention "BILL Cash Account (****0240)" not "Betterment". Check the frontend `billDeposit()` function.

## Real-Time Sync Engine Testing (PR #161+)

The BILL Cash page includes a "Real-Time Sync Engine" section below the deposit history. This polls the BILL API for balance/transactions, tracks deposit settlements, and auto-reconciles GL 1050.

### Test 6: Sync dashboard renders
- Scroll below Deposit History to the "Real-Time Sync Engine" section (green left border)
- Verify "Sync Now" and "Start Auto-Sync" buttons are visible
- Verify 4 stat cards: "BILL Balance", "GL 1050 Balance", "Pending Settlement", "Total Settled"
- Before any sync: cards may show "$0.00" or "—", status says "No sync has been run yet" or shows last sync time
- Settlement Queue section visible below with "No pending settlements"
- Sync History table visible (may be empty or show prior syncs)

### Test 7: Manual sync runs
- Click "Sync Now" button
- After sync: stat cards populate with dollar amounts
- Balance match indicator: green checkmark "Balance matched" if BILL balance equals GL 1050
- Status line updates: "Last sync: completed Xs ago, Synced: N deposits, Settled: N, Triggered by: manual"
- Sync History table adds a row with BSYNC-{timestamp}-{hash} ID, type "full", status "completed"

### Test 8: Deposit creates settlement tracking
- Make a Direct deposit (e.g. $0.10)
- **Critical**: Deposit result must include a purple settlement line: "Settlement: BSTL-{id} | Expected: {datetime}"
- Expected datetime should be ~1 hour from now for Direct method
- Settlement Queue table should update: new entry with BSTL ID, method "DIRECT", amount, status "pending"
- Pending Settlement stat card should increment (e.g. "1, $0.10 in transit")

### Test 9: Post-deposit sync settles Direct deposits
- After making a Direct deposit, click "Sync Now" again
- Direct deposits auto-settle on sync (instant method)
- Sync status line should show "Synced: 1 deposits, Settled: 1"
- Settlement Queue should clear ("No pending settlements")
- Total Settled stat card should increment
- Sync History should add a new row showing Synced=1, Settled=1

### Test 10: Incremental sync via API (sync token)
- Call `POST /api/bill/sync/run` via curl or browser
- Response JSON must include `details.transactions.incremental_changes` field (number >= 0)
- Response must include `details.transactions.next_sync_token` field (may be null)
- `received_count` should be > 0 (proves full list fallback works)
- `synced` count reflects matched settlements
- Note: `incremental_changes` may be 0 and `next_sync_token` may be null if BILL's `GetEntityChanges` API doesn't support the token format — this is expected, the full list fallback handles it

### Settlement timing expectations
- **Direct**: Settles instantly on next sync (~1 hour expected, but auto-settled on sync)
- **ACH**: 1-2 business days — won't settle on immediate re-sync
- **Wire**: Same day — may not settle on immediate re-sync

### Sync Token Integration (PR #162)
- The sync engine uses `BILL_SYNC_TOKEN` env var for incremental polling via BILL's `GetEntityChanges` API
- Incremental sync is attempted first; if it returns no data or fails, the engine falls back to full list (`listReceivedPayments` + `listSentPayments`)
- The sync token client function is in `server/integrations/bill/billClient.js` (`getEntityChanges()`)
- API route: `POST /api/bill/sync/run` triggers a full sync cycle including incremental attempt

### Common Sync Issues
- **Fly.io Postgres connection drops**: The first 1-2 sync attempts after idle periods may fail with "Connection terminated unexpectedly" or "connection timeout". This is caused by Fly.io's Postgres proxy killing idle connections. The pool recovers on retry — just click "Sync Now" again. The pool has keepAlive and retry logic but may still hit stale connections after extended idle.
- **BILL Balance shows $0.00**: Expected in the current setup. BILL's `GetBalance` API returns balance for the organization, which may be $0 depending on how AR payments are categorized.
- **incremental_changes always 0**: The `GetEntityChanges` endpoint may not be available or may not recognize the sync token format. This is non-blocking — the full list fallback works correctly and settlements still get matched.

## Key Sync Code Paths
- Sync engine: `server/integrations/bill/billSyncEngine.js` (BillSyncEngine class)
- Sync routes: `server/routes/bill.js` (POST /api/bill/sync ~line 377, GET /api/bill/sync/status ~line 400, GET /api/bill/sync/history ~line 420)
- Settlement tracking: Created in deposit routes, managed by BillSyncEngine.settleDeposits()
- Frontend sync UI: `public/dashboard.html` (sync section ~line 882, JS functions ~line 4306)

## Tips
- Use small amounts for testing ($0.01 minimum for Direct, $0.25+ for ACH/Wire).
- Each deposit creates a real record in BILL's sandbox/production — be aware when testing repeatedly.
- The deposit history merges records from multiple sources (BILL API received payments + local ACH batches + wire records). If entries are missing, check all sources and verify the routing number is in the query's `routings` array.
- When switching deposit methods in the dropdown, the form fields reset. Re-enter amount and memo after changing methods.
- The sync dashboard only populates after the first "Sync Now" click — before that it shows initial state messages.
- Sync History table rows are added in reverse chronological order (newest first).
- BILL sandbox API returns $0.00 balance — balance match will always be green checkmark in sandbox mode.
- Settlement tracking IDs follow format BSTL-{8chars}-{4chars} (e.g. BSTL-MR2KVLBI-L58H).
