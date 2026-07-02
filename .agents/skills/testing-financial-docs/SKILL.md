---
name: testing-financial-docs
description: Test financial document generation (balance sheet, income statement, trial balance, cashflow, bond statement) for correct totals. Use when verifying accounting report computations or document generation.
---

# Testing Financial Document Generation

## Overview
The Trust Accounting module generates financial reports from journal entry data. The key reports are:
- **Balance Sheet**: Assets = Liabilities + Equity (including net income)
- **Income Statement**: Revenue - Expenses = Net Income
- **Trial Balance**: Total Debits = Total Credits
- **Cashflow Statement**: Operating + Investing + Financing activities
- **Bond Statement**: Bond metadata + transaction history

## Devin Secrets Needed
- No special secrets needed for read-only report viewing
- Admin token needed only if generating new statements via POST

## Prerequisites
1. App deployed (Fly.io at `https://dlbtrust-app.fly.dev` or local on port 3002)
2. Trust Accounting must have journal entries posted
3. At least one active bond for bond statement testing

## How to Access
1. **Trust Accounting page**: Sidebar > "Trust Accounting" > tabs: Balance Sheet, Income Statement, Trial Balance, Cashflow, Statements
2. **Documents page**: Sidebar > "Documents" > "Generate Financial Report" section
3. **API endpoints**: Can also verify via curl for exact JSON values

## Key API Endpoints
- `GET /api/accounting/reports/balance-sheet` — balance sheet with is_balanced flag
- `GET /api/accounting/reports/income-statement` — income statement with net_income
- `GET /api/accounting/reports/trial-balance` — trial balance with is_balanced flag
- `GET /api/accounting/reports/cashflow` — cashflow statement
- `POST /api/accounting/statements/generate` — generate a rendered HTML statement
- `GET /api/accounting/dashboard` — summary totals (assets, liabilities, equity, net income)

## Test Procedure

### Test 1: Balance Sheet is balanced
- Navigate to Trust Accounting > Balance Sheet tab
- Verify: Assets total = Equity total (Liabilities are $0 currently)
- Verify: Equity section includes "Retained Earnings (Net Income)" line item
- The net income value should equal Income Statement's net income
- **Critical check**: If "Retained Earnings (Net Income)" is missing, the balance sheet will NOT balance — this was a past bug where net income was excluded from equity

### Test 2: Generate Balance Sheet document
- Go to Trust Accounting > Statements tab
- Select "Balance Sheet", click "Generate"
- Click "View / Print" to see rendered HTML
- Verify: Shows "Balanced: Yes" at the bottom
- Verify: "L + E" row matches Assets row

### Test 3: Income Statement totals
- Navigate to Trust Accounting > Income Statement tab
- Verify: Revenue = sum of income account balances
- Verify: Expenses = sum of expense account balances
- Verify: Net Income = Revenue - Expenses
- Cross-check: Net Income here should match the "Retained Earnings" line in Balance Sheet

### Test 4: Trial Balance
- Navigate to Trust Accounting > Trial Balance tab
- Verify: Total Debits = Total Credits (balanced)
- Each account should show debit and credit totals from journal entries

### Test 5: Bond Statement
- Go to Documents > Reports or Trust Accounting > Statements
- Select "Bond Statement" and choose a bond from the selector
- Generate and view the statement
- Verify: Principal Balance, Accrued Interest, Coupon Rate, Face Value match bond portfolio data

## Key Code Paths
- Balance sheet computation: `server/integrations/accounting/trustAccountingEngine.js` (~line 413, `getBalanceSheet()`)
- Income statement: same file (~line 461, `getIncomeStatement()`)
- Trial balance: same file (~line 338, `getTrialBalance()`)
- Document renderer: `server/integrations/documents/generationEngine.js` (`_renderBalanceSheet`, `_renderIncomeStatement`, etc.)
- Routes: `server/routes/accounting.js` (reports at lines 149-200, statements at line 246)
- Dashboard rendering: `public/dashboard.html` (Trust Accounting section at ~line 2315)

## Common Issues
- **Balance sheet not balanced**: If `getBalanceSheet()` doesn't include income/expense accounts in the equity computation, net income is excluded and Assets != L+E. The fix queries income/expense accounts and adds "Retained Earnings (Net Income)" to equity.
- **Accrued interest mismatch**: Bond engine's `accrued_interest` (current unpaid) may differ from Trust Accounting's Accrued Interest Receivable (JE-based). Difference is usually equal to paid coupons if coupon JEs were reversed.
- **"Balanced: No" on generated document**: Same root cause as above — net income not in equity.
- **Connection terminated**: Fly.io Postgres proxy kills idle connections. If generating a report fails, retry — the pool reconnects with `keepAlive: true`.
- **Bond selector not appearing**: For bond statements, the UI must toggle the bond selector visible when "Bond Statement" type is selected. If missing, check `toggleStmtBondSelect()` in dashboard.html.
- **Label accuracy**: The net income line was previously labeled "Current Period" but it's actually cumulative (from inception). Now labeled "Retained Earnings (Net Income)".

## Tips
- Always verify balance sheet balancing with the API first (`curl /api/accounting/reports/balance-sheet | jq .data.is_balanced`) before UI testing
- Compare net income across three places: Balance Sheet equity section, Income Statement bottom line, and Dashboard overview card
- The dashboard's Accounting Summary shows Equity and Net Income as separate line items (this is correct — it's a summary view, not the full balance sheet)
- Generated statements are stored and can be re-viewed from the Statements tab list