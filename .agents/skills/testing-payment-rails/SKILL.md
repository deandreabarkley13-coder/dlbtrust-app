---
name: testing-payment-rails
description: Test the multi-provider Payment Rails feature (Increase + Mercury) end-to-end. Use when verifying provider selection, rail validation, transaction filtering, or send-modal UI changes in the Payment Rails view.
---

# Testing Payment Rails (Multi-Provider: Increase + Mercury)

## Overview
The Payment Rails view routes payments through either **Increase** (ACH, Wire, RTP, Check) or **Mercury** (ACH, Wire, Check — no RTP). Provider selection drives dynamic rail availability, fee previews, transaction badges, and a provider filter.

## Setup
1. Start the server: `cd /home/ubuntu/repos/dlbtrust-app && node app.js` (serves on http://localhost:3001).
2. The app runs in **offline/SANDBOX mode** without API keys — payments are stored locally with provider ID `local` and never actually submitted. This is the correct mode for testing; do NOT use real API keys.
3. **Gotcha — empty 'From Account' dropdown:** The send modal only renders accounts with `status='active'`. A fresh DB may seed accounts as `pending`. Fix directly via SQLite:
   ```bash
   node -e "const db=require('better-sqlite3')('data/dlbtrust.db'); db.prepare(\"UPDATE trust_accounts SET status='active' WHERE id=1\").run();"
   ```
   Then reload the page (F5) and reopen the modal.

## Key UI element IDs (for reliable selection)
- `rail-provider-select` — provider dropdown inside the send modal
- `rail-select` — payment rail dropdown inside the send modal
- `rail-provider-filter` — provider filter dropdown above the transaction table

Note: native `<select>` dropdowns can be finicky to click via screenshot coordinates. Setting `.value` then dispatching a `change` event via `browser_console` is a reliable way to drive them, but always take a screenshot afterward to capture the visible state for the recording.

## Core assertions to verify
1. **Dashboard**: Provider badges (`Increase ✗ Mercury ✗` when no keys), Default=Increase, Env=SANDBOX, daily limit bars (ACH $500K, Wire $1M).
2. **Provider defaults to Increase** with all 4 rails enabled.
3. **Select Mercury** → RTP option becomes `disabled` with text `RTP (not available via Mercury)`; if RTP was selected it auto-switches to ACH.
4. **Fee preview** updates per rail+provider, e.g. `WIRE via Mercury — Fee: $25.00 | Speed: Same day`, `ACH ... Fee: $0.00`.
5. **After submit** the new transaction row shows the correct Provider badge (Increase=green/badge-approved, Mercury=blue/badge-open), Rail, and Fee. Total Fees + daily-limit usage update.
6. **Backend validation** (test even though frontend guards it):
   ```bash
   curl -s -X POST http://localhost:3001/api/payment-rails/send -H 'Content-Type: application/json' \
     -d '{"provider":"mercury","rail":"rtp","amount":100,"recipient_name":"Test","recipient_routing":"021000021","recipient_account":"123456789","from_account_id":1}'
   # → 400: "Mercury does not support RTP rail. Supported rails: ach, wire, check"
   ```
7. **Provider filter** (`rail-provider-filter`) isolates rows: Increase-only, Mercury-only, All. Verify row counts actually change.
8. **Bidirectional toggle**: switching Mercury→Increase re-enables RTP with original text `RTP — Real-Time Payment ($1.00)`.

## Provider/rail support matrix (source of truth)
Defined in `server/engines/payment-rail-engine.js` `PROVIDERS` constant:
- Increase: `ach, wire, rtp, check`
- Mercury: `ach, wire, check`
Both frontend (`frontend/app.js` `updateProviderRails()`) and backend (`server/routes/payment-rails.js` POST `/send`) enforce this.

## Recording
This is a GUI feature — record the browser session. Maximize the window first. Annotate each test with `test_start` and an `assertion` (passed/failed).

## Devin Secrets Needed
- None for offline/sandbox testing. Real submission would require `INCREASE_API_KEY` / `MERCURY_API_KEY` (not used in tests).
- Deployment to Fly.io uses `FLY_API_TOKEN` (saved org-level) — not needed for local testing.
