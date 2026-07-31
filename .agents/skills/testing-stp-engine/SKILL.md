---
name: testing-stp-engine
description: Test the STP (Straight-Through Processing) engine end-to-end. Use when verifying STP enrichment, T+1 settlement dates, BILL status polling, or STP dashboard stats.
---

# Testing STP Engine

## Overview
The STP engine enriches payment data before BILL API transmission (COA mapping, GL posting date, payment terms, settlement dates) and tracks settlement lifecycle through T+1 availability. It integrates with the Electronic Settlement engine — every payment submitted through E-Settlement is automatically processed by STP.

STP lifecycle: `pending -> enriched -> transmitted -> clearing -> cleared -> posted -> available`

## Devin Secrets Needed
- Admin token for API calls (value: `dlb-admin-2026-trust`, header: `x-admin-token`)
- BILL API credentials (server-side, not needed directly by tester)

## Prerequisites
1. App deployed at `https://dlbtrust-app.fly.dev` (or local dev)
2. Navigate to Electronic Settlement page (sidebar: "Electronic Settlement" under Core Banking)
3. STP section is at the bottom of the Electronic Settlement page, below the Recent Settlements table

## How to Access
1. Navigate to dashboard → Electronic Settlement
2. Scroll to "Straight-Through Processing (STP)" section
3. Section has: stat cards, volume cards, STP recent table, "Poll BILL Status" and "Check T+1" buttons

## Test Procedure

### Test 1: STP Dashboard Section Renders
- Scroll to STP section on Electronic Settlement page
- **Pass**: Title "Straight-Through Processing (STP)" visible, two buttons, 4 stat cards (Clearing/Cleared/Posted/Available), 3 volume cards, recent table area
- **Fail**: Section missing or cards not rendering

### Test 2: STP Dashboard Stats Load
- After page loads, check stat card values
- **Known Bug**: UI accesses `d.clearing` but API returns `d.stats.clearing`. Stats may show default values (0/$0.00) even when real data exists. The `|| 0` fallback masks this when all stats are genuinely zero.
- To verify: submit a payment first (Test 3), then check if "Pending Volume" shows the payment amount or stays at $0.00
- If Pending Volume stays $0.00 after a payment, the nesting bug is still present
- **Fix needed**: `d.clearing` → `d.stats.clearing` in `loadSTPDashboard()` (dashboard.html ~line 5167)

### Test 3: Submit Payment with STP Enrichment
- Use "Record Deposit (ledger only)" payment type to avoid MFA requirements
- Fill form: Payee="STP Test", Amount=$5, Priority=Standard, Funding Source=Trust Cash
- Click "Submit Electronic Payment"
- **Pass**: Green success box shows ALL of:
  - Settlement ID (`ESTL-{8chars}-{4chars}`)
  - BILL Ref (`0rp01...`)
  - STP ID (`STP-{8chars}-{4chars}`)
  - Settlement date (YYYY-MM-DD)
  - Availability date (YYYY-MM-DD, T+1 = next business day, skips weekends)
  - SLA deadline
- **Fail**: STP line missing from result — STP engine didn't execute

### Test 4: STP Entry in Dashboard Table
- After Test 3, scroll to STP section
- **Pass**: New row in STP table with correct STP ID, Type, Amount, Settlement Date, Availability, Status="transmitted"
- **Fail**: Table still shows "No STP entries yet"

### Test 5: Poll BILL Status
- Click "Poll BILL Status" button
- **Pass**: Green message "Poll complete: checked=N, advanced=N"
- The STP entry status should advance (e.g. transmitted → clearing)
- **Fail**: Red error message

### Test 6: Check T+1 Availability
- Click "Check T+1" button
- **Pass**: Green message "T+1 check: N payments now available, N checked"
- Note: only "posted" entries are eligible for T+1 availability check
- If no entries are in "posted" status, result will be 0 available (which is correct)

### Test 7: STP API Verification (curl)
```bash
curl -s -H "x-admin-token: dlb-admin-2026-trust" \
  https://dlbtrust-app.fly.dev/api/electronic-settlement/stp/dashboard | python3 -m json.tool
```
- **Pass**: `success: true`, `data.stats` has integer counts (total, clearing, cleared, posted, available, failed, cleared_volume, pending_volume), `data.recent` is an array
- Each recent entry should have: `stp_id`, `payment_type`, `amount`, `stp_status`, `settlement_date`, `availability_date`, `enrichment_complete: true`

## Key Code Paths
- STP Engine: `server/integrations/payments/stpEngine.js`
  - `enrichPaymentData()` (~line 217): COA mapping, GL posting date, payment terms
  - `processPayment()` (~line 344): Main entry point — enrich → validate → transmit → track
  - `pollBILLStatuses()` (~line 596): Query actual SentPay/ReceivedPay status from BILL
  - `checkAvailability()` (~line 779): Mark posted entries as available when T+1 date passes
  - `getDashboard()` (~line 799): Return stats and recent entries
- Integration point: `electronicSettlementEngine.js` `executeBILLPayment()` calls `STPEngine.processPayment()`
- Frontend: `dashboard.html` — STP section at ~line 1362, JS functions at ~line 5162
- Routes: `server/routes/electronicSettlement.js` — `/stp/dashboard`, `/stp/poll`, `/stp/check-availability`

## Common Issues
- **Stats show 0/$0.00 despite entries existing**: Nesting bug — `loadSTPDashboard()` reads `d.clearing` but API returns `d.stats.clearing`. Fix: access `d.stats.*` instead of `d.*`.
- **COA column shows "—" for deposits**: Expected — the COA mapping (`BILL_COA_MAPPING`) may not have a specific code for deposit types. This is cosmetic, not a bug.
- **MFA required for vendor payments**: Use "Record Deposit (ledger only)" payment type for STP testing to avoid BILL MFA requirements. This still exercises the full STP enrichment pipeline.
- **T+1 availability check shows 0**: This is correct when no entries have reached "posted" status. Entries must advance through clearing → cleared → posted before T+1 availability check applies.
- **Settlement dates skip weekends**: `addBusinessDays()` correctly skips Saturday/Sunday. Example: Friday 7/4 + T+1 = Monday 7/6.
- **Fly.io Postgres connection drops**: First request after idle may fail with circuit breaker open. Click Refresh to retry.

## Tips
- Use "Record Deposit (ledger only)" for STP testing — no MFA needed, full enrichment pipeline still runs
- Use small amounts ($5 or less) to minimize impact on real BILL Cash Account
- Each payment creates a real BILL API record (RecordARPayment for deposits)
- The "Poll BILL Status" button queries actual BILL SentPay/ReceivedPay statuses via `billClient.readEntity()`
- STP entries are stored in the `stp_processing` table (separate from `electronic_settlements`)
- STP ID format: `STP-{8chars}-{4chars}` (e.g. `STP-MR5QUSF9-3C20`)
