# Test Plan — PR #243 (branch `devin/17857-master-wallets`) — revised

**Target:** Live deployed dApp at `https://dlbtrust-app.fly.dev/` and `https://dlbtrust-app.fly.dev/dapp`  
**Admin / operator token:** `dlb-admin-2026-trust`  
**Recording:** start after browser is open, token saved, and the primary dashboard is visible.

## Current live baseline (probed)

- `GET /api/dapp/master-wallets` returns four wallets:
  - principal → `0xECCDF9A767799999320C5D4AFb513f11F1bA2f6e`
  - interest → `0xaC066AF63cdB3d60f81CBC9879736d6FA422aC0E`
  - operating → `0x0CB900C845F2E0F85625d09bc3CEfe36D62A42e3`
  - distribution → `0x4eC020Dc4E9A846bCeffB97DB2a8E95fC9D02500`
- The deployed `DLB-PRB` bond is `matured` with `principal_balance: 0`, `accrued_interest: 0`, `accrued_interest_total: 0`. It cannot be used for active fixed-income/backfill tests, so this plan creates a small active test bond.
- Operator `0x3e53028cf69949f3B961ce786Baf2D4D75166562` has ~0.0138 ETH on mainnet; gas fees are currently low (base fee ~0.074 gwei) so this is enough for the planned transactions.

## What changed in this branch

- `BondEngine.payInterest`, `payPrincipal`, and `receivePrincipal` now cast `amount` to `Number(amount)` before arithmetic, fixing the string-concatenation bug.
- `MasterWalletEngine.distributeFixedIncome` and `backfillMasterWallets` mint DLBUSD from bond principal/interest and route it through the Stablecoin DEX.
- `master-dashboard.html` has one-click **Ensure master wallets**, **Backfill principal + interest**, and **Distribute fixed income** buttons, plus master-wallet transfer forms.

## Preconditions

1. Open Chrome, navigate to `https://dlbtrust-app.fly.dev/dapp/master-dashboard.html`.
2. Enter `dlb-admin-2026-trust` in the **Admin / Operator Token** input and click **Save token**.
3. Click **Refresh all** once.
4. If tab clicks do nothing, use the console workaround (see TC1 note) because `showTab` references the global `event` object.

---

## TC1 — Master Dashboard loads and trustee/admin-only bond data is gated

**Steps:**
1. Confirm page title is `DLB Trust — Master Dashboard`.
2. Save token and click **Refresh all**.
3. Wait for the Overview panel to render.
4. If the tab buttons do not switch, run in the browser console:
   ```js
   document.querySelectorAll('.section').forEach(s => s.classList.add('hidden'));
   document.getElementById('masters').classList.remove('hidden');
   loadMasters();
   ```
5. Run:
   ```js
   document.querySelectorAll('.section').forEach(s => s.classList.add('hidden'));
   document.getElementById('bonds').classList.remove('hidden');
   loadBonds();
   ```

**Pass criteria:**
- Overview shows four master wallet addresses.
- Master Wallets tab shows the four cards with internal/external balances.
- Bond / Fixed Income panel lists `DLB-PRB` and metrics without 401/403/500.
- `GET /api/dapp/bonds/portfolio` returns `success: true` and one bond.

**Fail criteria:**
- Any tab missing, address blank, or API returns 401/403/500.
- Fewer than four master wallets.

---

## TC2 — Active test bond creation and accrual

**Steps (shell):**
1. Create an active bond with a 54-day accrual window (so `accrued_interest` rounds to exactly `$0.02`):
   ```bash
   curl -s -X POST https://dlbtrust-app.fly.dev/api/bonds \
     -H 'Content-Type: application/json' \
     -d '{
       "bondName": "PR243-Test-54d-'$(date +%s)'",
       "faceValue": 1.00,
       "couponRate": 0.10,
       "issueDate": "2026-06-10",
       "maturityDate": "2099-12-31",
       "paymentFreq": "monthly",
       "dayCount": "30/360",
       "currency": "USD"
     }'
   ```
   Record the returned `id` as `TEST_BOND_ID`.
2. Accrue to today:
   ```bash
   curl -s -X POST https://dlbtrust-app.fly.dev/api/bonds/$TEST_BOND_ID/accrue \
     -H 'Content-Type: application/json' \
     -d '{"toDate":"2026-08-04"}'
   ```
3. Verify live metrics:
   ```bash
   curl -s https://dlbtrust-app.fly.dev/api/bonds/$TEST_BOND_ID/metrics
   ```

**Expected:**
- `status` = `active`.
- `accrued_interest_total` = `0.02`.
- `principal_balance` = `1.00`.
- `coupon_rate_pct` = `10`.

**Why 0.02?** `1.00 * (0.10/360) * 54 = 0.015` → `Math.round(0.015*100)/100 = 0.02` (whole-cent accrual avoids sub-cent rounding errors in later `SourceOfFundsAdapter` checks).

---

## TC3 — One-click fixed-income distribution

**Steps:**
1. In the browser console, switch to the **Bond / Fixed Income** tab:
   ```js
   document.querySelectorAll('.section').forEach(s => s.classList.add('hidden'));
   document.getElementById('bonds').classList.remove('hidden');
   loadBonds();
   ```
2. Baseline the **Income Distribution Master** external/internal balances via the UI cards or API.
3. Select the new test bond in the **Bond** dropdown.
4. Enter **Amount** `0.01` and **Target asset** `ETH`.
5. Click **Distribute fixed income**.
6. Wait for the `dist-result` box and click **Refresh all**.

**Pass criteria:**
- `dist-result` shows `success: true`.
- JSON contains:
  - `bond_id`: the test bond ID
  - `interest_paid`: `0.01`
  - `target_asset`: `ETH`
  - `amount_out`: a small positive number of ETH
  - `distribution_wallet`: `0x4eC020Dc4E9A846bCeffB97DB2a8E95fC9D02500`
  - `swap` object with `txHash` / `mintTxHash` starting with `0x`
  - `unwrap.amountEth` a positive value
- No `invalid input syntax for type numeric` error (this would indicate the string-concat bug).
- The Income Distribution wallet's external ETH balance increases by the small `amount_out`.
- Test bond `accrued_interest_total` drops from `0.02` to `0.01`.

**Fail criteria:**
- Any 500 / Postgres numeric error.
- `amount_out` is `0`.
- `WaitForTransactionReceiptTimeoutError` with no `tx_hash`.
- Bond metrics show `accrued_interest_total` still `0.02`.

---

## TC4 — One-click backfill after distribution

**Steps:**
1. Click **Refresh all**.
2. Click **Backfill principal + interest** in the Overview tab (or call the API).
3. Wait for `dist-result`.

**Pass criteria:**
- `dist-result` shows `success: true`.
- `data.results.principal.minted` = `1.00` (DLBUSD minted to Principal Token Master).
- `data.results.interest.amount_out` = `0.01` or another non-zero positive amount.
- `data.results.interest.distribution_wallet` = the Income Distribution Master address.
- Principal Token Master internal DLBUSD balance increases by `1.00`.
- The test bond `principal_balance` becomes `0` and `status` becomes `matured`.

**Fail criteria:**
- `invalid input syntax for type numeric` error.
- `results.principal` or `results.interest` is `null` when the bond still has principal/accrued.
- Backfill fails with `Insufficient bond interest`/`bond liquidity` when metrics show positive balances.

**Known possible behaviors to report:**
- If the USDC swap/DEX pool creation fails, the interest path falls back to minting DLBUSD. The `backfillMasterWallets` code does **not** update `usedAsset` from `USDC` to `DLBUSD` in the fallback branch, so the internal ledger may be credited under the wrong asset label.
- If the operator wallet has no USDC, the pool-creation `addLiquidity` will revert and consume gas before the DLBUSD fallback runs.

---

## TC5 — Public landing request, maker/checker approvals, and SIT mint

**Steps:**
1. Baseline beneficiary SIT balance:
   ```bash
   curl -s -H 'x-admin-token: dlb-admin-2026-trust' \
     https://dlbtrust-app.fly.dev/api/dapp/sovereign-trust/balance/0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16
   ```
2. Open `https://dlbtrust-app.fly.dev/`.
3. Fill the **Beneficiary Distribution Request** form:
   - Name: `PR243v2 Test Beneficiary`
   - Email: a unique address, e.g. `dlbpr243v2-<timestamp>@example.com`
   - Phone: `+1-555-0200`
   - Wallet Address: `0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16`
   - Amount: `0.01`
   - Type: `Distribution`
   - Message: `PR #243 v2 public request E2E test`
4. Submit and record the request ID.
5. Back in `master-dashboard.html`, switch to the **Requests** tab:
   ```js
   document.querySelectorAll('.section').forEach(s => s.classList.add('hidden'));
   document.getElementById('requests').classList.remove('hidden');
   loadRequests();
   ```
6. Locate the new request (`under_review`).
7. Click **Approve Maker** with `annrobinson9800@yahoo.com`.
8. After refresh, click **Approve Checker** with `dbnettrust@gmail.com`.
9. Wait for status and tx hash.
10. Re-check the beneficiary SIT balance.

**Pass criteria:**
- Landing form submit returns `success` and a request ID.
- Request appears in the dashboard with `under_review`.
- After maker approval, approvals include `maker` and status remains `under_review`.
- After checker approval, status becomes `executed` and a `tx_hash` starting with `0x` appears.
- Beneficiary SIT balance increases by `0.01`.
- The `tx_hash` is successful on mainnet.

**Fail criteria:**
- Form submit errors.
- Approval fails with `Invalid trustee` or other error.
- Status does not become `executed`.
- `tx_hash` missing or the on-chain transaction reverts.
- Beneficiary balance does not increase.

---

## TC6 — Master wallet internal SIT/ETH transfers and external SIT send

### 6a — Internal SIT transfer
**Steps:**
1. In the **Master Wallets** tab, note baseline internal SIT balances.
2. Set **From** = `interest`, **To** = `distribution`, **Asset** = `SIT`, **Amount** = `0.10`.
3. Click **Transfer**.

**Pass criteria:**
- `m-transfer-result` shows success JSON.
- Interest internal SIT decreases by `0.10`.
- Distribution internal SIT increases by `0.10`.

### 6b — External SIT send from Income Distribution Master
**Steps:**
1. If Distribution has no on-chain SIT, credit internal+external SIT via the operator API:
   ```bash
   curl -s -X POST -H 'x-admin-token: dlb-admin-2026-trust' \
     -H 'Content-Type: application/json' \
     -d '{"amount":"0.50","asset":"SIT","sourceType":"treasury","sourceAccountId":"TREASURY_HOT"}' \
     https://dlbtrust-app.fly.dev/api/dapp/wallets/<distribution_wallet_id>/fund
   ```
2. Set **From** = `distribution`, **To Address** = `0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16`, **Asset** = `SIT`, **Amount** = `0.05`.
3. Click **Send externally**.

**Pass criteria:**
- `mx-result` shows a JSON result with `txHash` starting with `0x`.
- Distribution internal SIT decreases by `0.05`.
- Beneficiary on-chain SIT balance increases by `0.05`.

**Note:** If the on-chain SIT balance of the distribution wallet is insufficient, this test documents the failure and moves on; do **not** spend excessive gas trying to mint/fund it.

---

## TC7 — OTP / email behavior

**Steps:**
1. Open `https://dlbtrust-app.fly.dev/dapp/index.html`.
2. Scroll to the **Portal Sign In / Security** card.
3. Enter any test email and click **Send Code**.
4. Observe the `user-auth-status` text and the network response.

**Pass criteria:**
- The UI shows a 6-digit code and a note that in production it would be sent via SMS/email.
- The response `data.code` is returned and `data.sent` is `false`.
- No 500 error.

**Why emails are not sent:** `server/integrations/dapp/emailEngine.js` only sends via SendGrid when `SENDGRID_API_KEY` is set. The deployed Fly app does not have that secret, so the engine logs the code and returns it in the API response for demo/testing.

---

## TC8 — Local regression / build checks

**Steps (local checkout `/home/ubuntu/repos/dlbtrust-app`):**
1. `npm run typecheck`
2. `npm test`

**Pass criteria:**
- `typecheck` exits `0`.
- `npm test` passes 45/45.

---

## Evidence to collect

- Screenshot of Master Dashboard Overview and Master Wallets tabs before/after backfill.
- Screenshot of `dist-result` JSON for TC3 (fixed-income distribution) and TC4 (backfill).
- Mainnet tx hashes for any successful fixed-income swap/mint and the SIT mint.
- Screenshot of public landing form submit confirmation and Requests table with approvals/execution.
- Before/after API responses for beneficiary SIT balance.
- Screenshot of `m-transfer-result` and `mx-result`.
- Screenshot of Portal Sign In showing the returned OTP code.

## Scope note

This plan is adversarial: it will fail loudly if the string-concat bug returns, if `backfillMasterWallets`/`distributeFixedIncome` look only at zero `live.*` fields, if the SIT mint/transfer chain is broken, or if the public request approval flow fails.
