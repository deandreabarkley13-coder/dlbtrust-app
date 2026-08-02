# Stablecoin Source-of-Funds Wiring — End-to-End Test Plan

**Target branch:** `devin/stablecoin-source-funding` (PR #227)
**App URL:** `http://localhost:3002`
**Primary source type under test:** `bond` (Bond id `1` — `DLB-PRB`)

## Goal

Prove that a stablecoin payment can be created, approved, and settled using a **non-treasury source** (Bond `id 1`) and that:

1. The source balance is reduced by the payment total.
2. `approvePayment` no longer overwrites `source_account_id` for non-treasury sources.
3. The treasury ledger reflects the source-sweep → hold → post cycle.
4. A simulated `shadow-` tx hash appears on settlement.

## Preconditions

- PostgreSQL `dlbtrust` database is running and reachable at `postgres://dlbtrust:dlbtrust@localhost:5432/dlbtrust`.
- Server `server/server-3002.js` is running on port 3002 with the environment:
  - `DATABASE_URL=postgres://dlbtrust:dlbtrust@localhost:5432/dlbtrust`
  - `JWT_SECRET=<any-stable-secret>`
  - `ADMIN_SECRET_TOKEN=dlb-admin-2026-trust`
  - `STABLECOIN_ENABLED=true`
  - `STABLECOIN_MODE=shadow`
  - `STABLECOIN_NETWORK=testnet`
  - `STABLECOIN_DISTRIBUTOR_SECRET` and `STABLECOIN_DISTRIBUTOR_PUBLIC` set to a valid Stellar keypair (readiness needs the secret, but settlement is simulated in shadow mode)
  - `PORT=3002`
- Admin user `admin` / `dlb-admin-2026-trust` is logged in and on the **Stablecoin Payments** page (`#page-stablecoin`).
- Readiness stat shows **Ready** (green) and Network = `testnet`, Asset = `USDC`.
- Bond `id 1` (`DLB-PRB`) has enough principal for the test amount.
- Pre-test DB baselines are captured for:
  - `bond_balances.principal_balance` where `bond_id = 1`
  - `stablecoin_treasury_accounts` row where `account_id = 'TREASURY_HOT'`

## Test steps and pass/fail criteria

### 1. Check source balance before payment

**UI actions:**
1. Click the **Source Type** dropdown and select `Bond`.
2. Enter `1` in **Source Account ID**.
3. Click **Check Source Balance**.

**Pass/fail criteria:**
- A green success message appears below the buttons showing a positive amount.
- The amount equals `(bond_balances.principal_balance + bond_balances.accrued_interest) * 100` cents for `bond_id = 1`.
- API `GET /api/stablecoin/sources/bond/1/balance` returns `success: true` and `data.availableCents` matching the calculation.

### 2. Create a stablecoin payment

**UI actions:**
1. Enter `GAA_TESTWALLET` in **Destination Wallet** (any non-empty value is valid in shadow mode).
2. Enter `100.00` in **Amount ($)**.
3. Select **Source Type** `Bond`.
4. Enter `1` in **Source Account ID**.
5. Click **Create Payment**.

**Pass/fail criteria:**
- Green message: `Payment created: SCP-...`.
- The **Stablecoin Payments** table gains a new top row with:
  - Status `pending`
  - Amount `$100.00`
  - Fee `$0.25`
  - Total `$100.25`
  - Source `bond / 1`
- API `POST /api/stablecoin/payments` returned HTTP 201 with `success: true`.
- DB `stablecoin_payments` row:
  - `status = 'pending'`
  - `source_type = 'bond'`
  - `source_account_id = '1'`
  - `amount_cents = 10000`
  - `fee_cents = 25`
  - `total_cents = 10025`

### 3. Approve the payment

**UI actions:**
1. Click the **Approve** button on the newly created pending row.

**Pass/fail criteria:**
- Table row status changes to `approved`.
- DB `stablecoin_payments`:
  - `status = 'approved'`
  - `source_account_id` remains `'1'` (must not become `TREASURY_HOT`)
  - `source_ref` JSON contains `bondTransactionId` and `newPrincipalCents`
  - `reserve_id` is non-null
- DB `bond_balances` for `bond_id = 1`:
  - `principal_balance` is reduced by exactly `$100.25` from the pre-test baseline.
- DB `stablecoin_treasury_accounts` for `TREASURY_HOT`:
  - `balance_cents = baseline_balance + 10025`
  - `hold_cents = 10025`
  - `available_cents = baseline_balance`

### 4. Settle the payment

**UI actions:**
1. Click the **Settle** button on the approved row.

**Pass/fail criteria:**
- Table row status changes to `settled` and Actions shows `Settled`.
- DB `stablecoin_payments`:
  - `status = 'settled'`
  - `tx_hash` is non-null and starts with `shadow-`
  - `source_ref.post` contains `bondTransactionId` and `posted: true`
- DB `stablecoin_reserves` for the payment's `reserve_id`:
  - `status = 'posted'`
  - `tx_hash` matches the payment `tx_hash`
- DB `stablecoin_treasury_accounts` for `TREASURY_HOT`:
  - `balance_cents = baseline_balance + 25` (fee retained)
  - `hold_cents = 0`
  - `available_cents = baseline_balance + 25`

### 5. Check source balance after payment

**UI actions:**
1. Click **Check Source Balance** again with `Bond / 1`.

**Pass/fail criteria:**
- Green message shows the available amount reduced by exactly `$100.25` (10,025 cents) from the value in Step 1.

## What distinguishes working from broken

- **Old `approvePayment` behavior:** if `source_account_id` were overwritten to `TREASURY_HOT` for a non-treasury source, the approve call would fail or the bond balance would not decrease, and `source_ref` would not contain `bondTransactionId`.
- **Missing source sweep:** if `_fundSourceToTreasury` did not sweep bond principal into treasury, the treasury `balance_cents` would not increase by `10025` and `hold_cents` would not become `10025` after approve.
- **Broken settlement posting:** if `TreasuryEngine.post` or `SourceOfFundsAdapter.post` were skipped, the reserve would remain `active`, `hold_cents` would stay `10025`, `available_cents` would not become `baseline + 25`, and `tx_hash` would be null.
- **Incorrect source balance reduction:** if `BondEngine.payPrincipal` did not reduce `principal_balance` by the total amount, the post-approve source balance would not decrease by `$100.25`.

## Code references

- `public/dashboard.html` lines 1526–1591 (Stablecoin Payments form) and 6424–6550 (`loadStablecoin`, `scCreatePayment`, `scApprove`, `scSettle`, `scCheckSourceBalance`).
- `server/routes/stablecoin.js` lines 40–84 (source balance, create, approve, settle endpoints).
- `server/integrations/stablecoin/stablecoinGateway.js` lines 194–209 (`approvePayment` preserves `source_account_id` for non-treasury sources).
- `server/integrations/stablecoin/sourceOfFundsAdapter.js` lines 45–79 (`getBalance`), 129–139 (bond sweep into treasury), 250–293 (`post` for source types).
- `server/integrations/stablecoin/treasuryEngine.js` lines 121–139 (`credit`), 177–216 (`hold`), 262–306 (`post`).
- `server/integrations/bonds/bondEngine.js` lines 342–446 (`payPrincipal`), 448–515 (`receivePrincipal` rollback).
- `server/integrations/stablecoin/blockchainEngine.js` lines 233–245 (`settle` in shadow mode).

## Recording

Start recording on the **Stablecoin Payments** page after login. The recording should cover Steps 1–5 in one continuous flow, with annotations at each major state change.
