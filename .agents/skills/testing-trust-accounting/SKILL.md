---
name: testing-trust-accounting
description: Test the Trust Accounting feature end-to-end. Use when verifying double-entry bookkeeping, UPIA compliance, financial reports, or journal entry lifecycle changes.
---

# Testing Trust Accounting

## Prerequisites

- Server running on localhost:3001 (`node app.js` from repo root)
- Fresh database recommended: delete `data/dlbtrust.db` and restart server to get clean state with 36 seeded COA accounts and 0 journal entries
- Kill any existing server process first: `fuser -k 3001/tcp`

## Navigation

- Click "Trust Accounting" in the left nav (data-view="accounting")
- Use the dropdown selector (`#accounting-tab`) to switch between 7 sub-views:
  - `dashboard` (Overview) — metrics, trial balance check, income/principal bars
  - `journal` (Journal Entries) — full JE list with status and Reverse button
  - `ledger` (General Ledger) — per-account running balances
  - `trial-balance` (Trial Balance) — formal debit/credit balance check
  - `coa` (Chart of Accounts) — all 36 seeded accounts
  - `allocations` (Income/Principal) — UPIA classification tracking
  - `reports` (Reports) — Balance Sheet, Income Statement, DNI, K-1 cards

**Dropdown switching tip:** Using `document.getElementById('accounting-tab').value = 'xxx'; sel.dispatchEvent(new Event('change'));` via browser console is more reliable than clicking the native dropdown with computer-use tools.

## Key Test Cases

### 1. Empty-State Verification
- On fresh DB: COA=36, JE=0, This Year=0, Open Periods=0
- Trial Balance Check shows "Balanced" with $0/$0

### 2. Journal Entry with Balance Validation
- Click "+ Journal Entry" button to open modal
- The modal has a live balance check (`#je-balance-check`) that updates on every input change
- Enter only debit line first → shows red "Unbalanced" with diff amount
- Enter matching credit line → shows green "Balanced"
- Account dropdown uses `#je-line-account-0`, `#je-line-account-1` pattern
- Debit/credit fields use `[name="line_debit_0"]`, `[name="line_credit_0"]` pattern
- Post button submits to `POST /api/trust-accounting/journal-entries`
- Entry number format: `JE-YYYYMMDD-XXXX`

### 3. Chart of Accounts
- Should show exactly 36 rows: 9 asset, 6 liability, 5 corpus, 6 income, 10 expense
- Columns: Code, Name, Type, Sub-Type, Normal Balance, System

### 4. Trial Balance
- Shows only accounts with non-zero balances
- TOTALS footer must have Debit = Credit (proves double-entry integrity)
- After reversal, TOTALS should be $0/$0

### 5. UPIA Auto-Classification
- Click "+ Record Allocation" on the Income/Principal sub-view
- Set Category (e.g., "interest", "capital_gain") and leave Classification empty
- Backend applies UPIA defaults from `trust-accounting-engine.js`:
  - interest → income (§401)
  - dividend → income (§401)
  - capital_gain → principal (§404(2))
  - rental → income, royalty → income
  - legal_fee → principal, accounting_fee → principal
- Verify the Classification column shows the auto-assigned value
- Metrics cards show Principal vs Income totals

### 6. Financial Reports
- Reports sub-view shows 4 clickable cards: Balance Sheet, Income Statement, DNI Report, K-1 Data
- Click each card to load the report below the cards
- Balance Sheet: Assets = L + Corpus equation
- Income Statement: Income - Expenses = Net Income
- DNI: IRC §643(a) Distributable Net Income calculation
- Note: Balance Sheet may show "Unbalanced" if income hasn't been closed to corpus — this is expected accounting behavior (income accounts are temporary)

### 7. Journal Entry Reversal
- On Journal Entries sub-view, posted entries have a red "Reverse" button
- Click Reverse → browser confirm dialog appears
- After confirmation: original entry gets "Reversed" status, new reversing entry created with "Posted" status
- Trial Balance should zero out completely ($0/$0)
- Toast message confirms: "Entry JE-XXXXXXXX-XXXX reversed"

## Common Pitfalls

- **Port conflicts:** Always kill existing server before restarting (`fuser -k 3001/tcp`)
- **Schema changes:** If the schema has been modified, delete the DB file and restart to re-seed
- **NOT NULL constraint on income allocations:** The `journal_entry_id` column in `trust_income_allocations` was changed to nullable — if you see constraint errors, the schema migration may not have run
- **Dropdown not switching:** Native HTML select clicks can be unreliable with computer-use tools; prefer JS-based switching via browser console
- **Stale trial balance:** After reversals, switch away from and back to Trial Balance sub-view to force a fresh API call

## API Endpoints Reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/trust-accounting/chart-of-accounts` | GET | List all 36 accounts |
| `/api/trust-accounting/journal-entries` | GET/POST | List or create journal entries |
| `/api/trust-accounting/journal-entries/:id/reverse` | POST | Reverse a posted entry |
| `/api/trust-accounting/trial-balance` | GET | Formal trial balance |
| `/api/trust-accounting/general-ledger` | GET | GL with running balances |
| `/api/trust-accounting/income-principal` | GET/POST | Allocation tracking |
| `/api/trust-accounting/reports/balance-sheet` | GET | Balance sheet |
| `/api/trust-accounting/reports/income-statement` | GET | Income statement |
| `/api/trust-accounting/reports/dni` | GET | DNI calculation |
| `/api/trust-accounting/reports/k1-data` | GET | K-1 beneficiary data |
| `/api/trust-accounting/dashboard` | GET | Dashboard metrics |
