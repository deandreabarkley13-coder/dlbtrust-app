# OFX Clearing End-to-End Test Plan

**Target branch:** `devin/ofx-clearing`
**App URL:** `http://localhost:3002`
**Server entry:** `server/server-3002.js`

## Preconditions (setup already done)

- PostgreSQL running with `dlbtrust` user/database and `DATABASE_URL=postgres://dlbtrust:dlbtrust@localhost:5432/dlbtrust`.
- `node server/server-3002.js` started with env vars `JWT_SECRET` and `ADMIN_SECRET_TOKEN=dlb-admin-2026-trust` on port 3002.
- Admin user `admin` / `dlb-admin-2026-trust` seeded.
- OFX tables reset to a known state (truncate `ofx_institutions`, `ofx_statements`, `ofx_transactions`, `ofx_payments`) so counts are deterministic.
- `/tmp/sample.ofx` exists with the sample OFX 2.0 statement.

## Primary End-to-End Flow

### 1. Log in and open OFX Clearing

1. Open Chrome and navigate to `http://localhost:3002`.
2. In the login overlay, type `admin` in **Username** and `dlb-admin-2026-trust` in **Password**, then click **Sign In**.
3. Click the sidebar nav item labeled **OFX Clearing** (icon 🌐).

**Pass/fail criteria**
- Login succeeds: overlay disappears and dashboard shows the sidebar with a user badge containing `admin` / `Administrator`.
- The `#page-ofx` section becomes visible, showing heading **OFX Clearing**, sub-title, and a **Refresh** button.
- The **Readiness** stat badge shows `Ready` (green) and **Institutions** / **Statements** / **Payments** stat cards show `0` (or match post-reset state).

### 2. Create an OFX institution

1. In the **OFX Institutions** card, fill:
   - **Institution Name**: `OFX Test Bank`
   - **OFX Org**: `OFXTEST`
   - **FI ID**: `99999`
   - **Base URL**: `https://ofx.example.com/ofx`
   - **Username**: `testuser`
   - **Password**: `testpass`
   - **Bank ID (Routing/SWIFT)**: `111000025`
   - **Account ID**: `123456789`
   - **Account Type**: `CHECKING`
   - **Mode**: `Simulate`
   - **Status**: `Active`
2. Click **Save Institution**.

**Pass/fail criteria**
- A green success message appears: `Institution saved: <id>`.
- The institutions table shows a new row with `OFX Test Bank`, mode `simulate`, status `active`, and the same Bank ID / Account ID values.
- The **Institutions** stat card increments from `0` to `1`.
- Backend response `POST /api/ofx/institutions` returns HTTP 201 with `success: true` and a JSON payload containing `id`, `bankId: '111000025'`, `accountId: '123456789'`, `mode: 'simulate'`.

### 3. Create a wire payment

1. In the **Create OFX Payment** card:
   - **Institution**: select `OFX Test Bank (simulate)`.
   - **Payment Type**: `Wire Transfer`.
   - **Amount ($)**: `1000.00`.
   - **Payee Name**: `Beneficiary LLC`.
   - **Payee Account**: `987654321`.
   - **Payee Bank ID / Routing**: `021000021`.
   - **Address Line 1**: `123 Main St`.
   - **City**: `New York`.
   - **State**: `NY`.
   - **Postal Code**: `10001`.
   - **Country**: `USA`.
   - **Due Date**: choose today.
   - **Memo / Distribution Note**: `Trust distribution Q3`.
   - **Source Account ID**: `TREASURY_HOT`.
   - **Source Type**: `Treasury`.
2. Click **Create Payment**.

**Pass/fail criteria**
- A green success message appears: `Payment created: <id> — [Submit]`.
- The **OFX Payments** table shows a new row with the generated ID, status `pending`, type `wire`, amount `$1,000.00`, payee `Beneficiary LLC`, and a **Submit** button.
- Backend `POST /api/ofx/payments` returns HTTP 201 with `success: true` and the payment object.

### 4. Submit the wire payment and verify acceptance

1. Click the **Submit** button on the newly created pending payment row.

**Pass/fail criteria**
- No browser alert with an error.
- The **OFX Payments** table re-renders and the same row now has status `accepted`.
- A direct SQL query against `dlbtrust` shows the matching `ofx_payments` row with:
  - `status = 'accepted'`
  - `ofx_request` is non-null and contains `<?xml`, `<WIRETRNRQ>`, `<WIRERQ>`, and the payee/account/routing values.
  - `ofx_response` is non-null and contains `<OFX>` and `<STATUS>`.
  - `server_id` starts with `SIM-`.

### 5. Parse-preview the sample OFX statement

1. In the **Import OFX Statement** card:
   - **Institution**: leave as `None / Manual`.
   - **Statement Source** (optional): `sample.ofx`.
   - Paste the full contents of `/tmp/sample.ofx` into **OFX File Content**.
2. Click **Parse Preview**.

**Pass/fail criteria**
- A green preview message appears: `Parsed 3 transactions. Account 987654321 / USD Balance $2,114.50`.
- A preview table lists exactly 3 rows:
  - `20250115`, `DEBIT`, `-50.00`, `AMAZON PURCHASE`, `Order #12345`
  - `20250116`, `CREDIT`, `1500.00`, `PAYROLL DEPOSIT`, `January salary`
  - `20250117`, `CHECK`, `-200.00`, `RENT PAYMENT`, `January rent`
- No statement is persisted yet: `ofx_statements` count remains unchanged after the preview.

### 6. Import the sample OFX statement

1. With the same content still in the **OFX File Content** textarea, click **Import Statement**.

**Pass/fail criteria**
- A green success message appears: `Statement imported: ID <id>`.
- The **OFX Statements** count stat card increments by `1` (e.g. from `0` to `1`).
- A direct SQL query shows a new `ofx_statements` row with:
  - `account_id = '987654321'`
  - `currency = 'USD'`
  - `ledger_balance_cents = 211450`
  - `start_date = 20250101` and `end_date = 20250131`.
- The `ofx_transactions` table contains 3 rows for that statement with `fit_id`, `type`, `amount_cents`, `name`, and `memo` matching the sample.

### 7. Static checks

1. In the repo root, run `npm run typecheck`.
2. Run `npm test`.

**Pass/fail criteria**
- `npm run typecheck` exits with code `0` and prints no TypeScript errors.
- `npm test` exits with code `0` and reports all test files passing.

## What distinguishes working from broken

- A broken backend would return `5xx` or `success: false` for `POST /api/ofx/institutions` or `/api/ofx/payments`, or the UI would show a red error message instead of green success.
- A broken payment submit would leave the status at `pending` or `rejected` and `ofx_request` would be null.
- A broken parser would fail to display the 3 transactions or show an incorrect balance.
- A broken import would fail to persist the statement/transaction rows in Postgres.
- Broken TypeScript or unit tests would cause `typecheck` or `test` to fail.
