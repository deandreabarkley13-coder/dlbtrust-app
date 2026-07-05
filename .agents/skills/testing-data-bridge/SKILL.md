---
name: testing-data-bridge
description: Test Data Bridge sync health, reconciliation, and cross-module data flow end-to-end. Use when verifying Data Bridge status, reconciliation logic, sync operations, or discrepancy resolution.
---

# Testing Data Bridge

## Overview
The Data Bridge page shows cross-module data flow status between trust accounting, core banking (Fineract GL), cash management, ACH, wire, bonds, BILL, and sub-ledgers. The primary thing to verify is that `syncHealth` displays as "healthy" (green "All Synced") and reconciliation checks pass.

## Prerequisites
- App running on Fly.io: https://dlbtrust-app.fly.dev
- Login: admin / dlb-admin-2026-trust
- Navigate to Data Bridge via sidebar nav item "Data Bridge" under DATA BRIDGE section

## Devin Secrets Needed
- `FLY_API_TOKEN` — for deploying to Fly.io (already configured in environment)
- `BILL_DEV_KEY`, `BILL_USERNAME`, `BILL_PASSWORD`, `BILL_ORG_ID` — for BILL integration (set as Fly.io secrets)

## Key API Endpoints
- `GET /api/accounting/bridge/status` — Returns sync health, module statuses, discrepancies
- `POST /api/accounting/bridge/sync` — Run full cross-module sync
- `POST /api/accounting/bridge/reconcile/cash` — Run cash reconciliation
- `POST /api/accounting/bridge/reconcile/fineract` — Run Fineract GL reconciliation
- `POST /api/accounting/bridge/reconcile/sub-ledgers` — Run sub-ledger reconciliation

## Test Procedure

### Test 1: Sync Health Status
1. Navigate to Data Bridge page
2. Check the health banner at the top
3. **Pass**: Green dot + "Sync Health: All Synced"
4. **Fail**: Yellow "Needs Sync" or Red "Critical"

### Test 2: Discrepancies Count
1. Check the "Discrepancies" stat card (4th stat)
2. **Pass**: Shows 0 or 1 (low-severity only)
3. **Fail**: Shows 2+ or any high/critical discrepancies

### Test 3: Run Full Sync
1. Click "Run Full Sync" button (top-right)
2. Confirm the dialog
3. **Pass**: Green banner "Full Sync Complete (Xms)", Total failed: 0, all sync history rows show "completed" (green text)
4. **Fail**: Any row shows "failed" status or Total failed > 0

### Test 4: Cash Reconciliation
1. Click "Reconcile Cash" button in Sync Actions
2. Check the result banner
3. **Pass**: "Cash module: $6,000,000.00" (excludes bond proceeds), Difference < $100
4. **Fail**: Cash module shows $100M+ (includes bond proceeds) or Difference > $10,000

### Test 5: Sub-ledger Reconciliation
1. Check sync history for `sub_ledger_reconciliation` row after full sync
2. **Pass**: Status="completed", Failed=0
3. **Fail**: Status="failed" or Failed > 0

## Common Issues & Workarounds

### Fly.io Postgres connection drops
- Symptom: Pages hang or return 500s after idle period
- Cause: Fly.io Postgres proxy kills idle connections ~5 minutes
- Workaround: The app has a 3-tier retry pool with circuit breaker. If it crashes, restart the app machine via `flyctl machines restart <id> -a dlbtrust-app`

### Cash reconciliation shows $100M
- Cause: bond_proceeds not excluded from cash comparison
- Fix: dataBridge.js `reconcileCashToAccounting()` must filter `WHERE account_type NOT IN ('bond_proceeds')`

### Sub-ledger reconciliation always fails
- Cause: Under-allocation (GL > sub-ledger) incorrectly flagged as discrepancy
- Fix: Only flag over-allocation (sub-ledger > GL) as discrepancy; under-allocation is normal partial allocation

### syncHealth stuck on "needs_sync"
- Cause: Thresholds too aggressive (any unsynced item triggers needs_sync)
- Fix: Use materiality-based thresholds (e.g., unsyncedACH > 3, unsyncedBonds > 5, unsyncedJE > 20)

### Fineract GL reconciliation shows 0 matched despite accounts existing
- Cause: `FineractClient.getGLSummary()` returns `{ accounts: { assets: [...], liabilities: [...], ... } }` (categorized object), but `reconcileFineractGL()` checked `Array.isArray(glSummary.accounts)` which always failed
- Fix: Flatten the categorized accounts object before iterating: `[].concat(accounts.assets, accounts.liabilities, accounts.equity, accounts.income, accounts.expenses)`
- After fix: expect 15+ matched accounts (18 total GL accounts, some unmapped)

## Key Code Locations
- Data Bridge engine: `server/integrations/accounting/dataBridge.js`
- Dashboard UI (Data Bridge section): `public/dashboard.html` lines ~3600-3800
- Cash reconciliation logic: `dataBridge.js` `reconcileCashToAccounting()` (~line 330)
- Fineract GL reconciliation: `dataBridge.js` `reconcileFineractGL()` (~line 530)
- Sub-ledger reconciliation: `dataBridge.js` `reconcileSubLedgers()` (~line 943)
- syncHealth calculation: `dataBridge.js` `getStatus()` (~line 1160)
- Stale cleanup: `dataBridge.js` `runFullSync()` step 10 (~line 1290)
