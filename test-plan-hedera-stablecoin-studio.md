# Hedera Stablecoin Studio End-to-End Test Plan

**Target:** `https://dlbtrust-app.fly.dev/` (`devin/hedera-stablecoin-studio` branch)  
**Auth:** Login as `admin` / `dlb-admin-2026-trust` (dashboard stores the password as the `x-admin-token` header).  
**Test type:** UI-driven end-to-end on the deployed app, with API calls used only for verification steps that the dashboard table does not display (`tx_hash`, `metadata.hederaTokenId`).

## Preconditions

- Treasury hot account has at least `125` cents available. If not, credit it with `POST /api/stablecoin/treasury/TREASURY_HOT/credit` using header `x-admin-token: dlb-admin-2026-trust` and body `{"amountCents":500,"source":"test"}`.
- The deployed app reports `HEDERA_STUDIO_ENABLED=true` and `/api/stablecoin/hedera/readiness` returns `ready: true`.

## Code references that inform this plan

- Dashboard UI fields: `public/dashboard.html` lines 1538-1594.
- Dashboard `loadStablecoin()` / `scActionButtons()`: `public/dashboard.html` lines 6451-6498.
- Dashboard Hedera functions `scCreateHederaStablecoin()`, `scMintHederaStablecoin()`, `scHederaBalance()`, `scCheckHederaReadiness()`: `public/dashboard.html` lines 6651-6692.
- Hedera engine `createStablecoin()`, `cashIn()`, `settle()`: `server/integrations/stablecoin/hederaEngine.js` lines 178-217, 282-304, 338-366.
- Gateway `createPayment()` / `settlePayment()`: `server/integrations/stablecoin/stablecoinGateway.js` lines 136-189, 233-275.
- Routes: `server/routes/stablecoin.js` lines 47-84 (payments), 95-133 (Hedera).
- Config/env: `server/integrations/stablecoin/config.js` lines 57-71.

## What distinguishes working from broken

- A broken Hedera wiring would return `success: false` or 500 from `/api/stablecoin/hedera/create-stablecoin`, `/mint`, or `/hedera/readiness`.
- A broken settle path would leave the payment in `approved`/`failed`, return an empty `tx_hash`, or omit `metadata.hederaTokenId`.
- A broken treasury hold would not reduce `availableCents` by the full `total_cents` (amount + fee) on approve, or would not retain the `0.25` fee on settle.

---

## Step 1: Navigate to Stablecoin Payments and verify readiness

**UI action:** Click sidebar item **Stablecoin Payments**.

**Pass criteria:**
- The `sc-readiness` stat shows `Ready`.
- It also shows a `Hedera Ready` badge (green).
- `sc-network` is not `—` and `sc-asset` is not `—`.
- No `401` or `403` errors in the browser console for `/api/stablecoin/health` or `/api/stablecoin/payments`.

**Fail criteria:** `Hedera Not Ready`, `Auth`, `Unavailable`, or console network errors.

---

## Step 2: Create a Hedera stablecoin in the dashboard

**UI action:** In the **Hedera Stablecoin Studio** card:
- Set **Symbol** to `DLBUSD`.
- Set **Decimals** to `6`.
- Set **Initial Supply ($)** to `1000`.
- Click **Create Stablecoin**.

**Pass criteria:**
- The `sc-hedera-result` div shows a success message containing a token ID.
- The **Token ID** input (`sc-hedera-token-id`) is populated with a value starting with `0.0.`.
- API response `POST /api/stablecoin/hedera/create-stablecoin` returns `success: true` and `data.tokenId` matches the displayed token ID.

**Fail criteria:** Error message, empty token ID, or token ID not matching `0.0.*`.

---

## Step 3: Mint the Hedera stablecoin

**UI action:** In the same card:
- Leave **Token ID** populated from Step 2.
- Set **Mint to Account** to `0.0.101`.
- Set **Mint Amount ($)** to `100.00`.
- Click **Mint**.

**Pass criteria:**
- `sc-hedera-result` shows a success message with a non-empty transaction ID.
- `POST /api/stablecoin/hedera/mint` returns `success: true` and `data.txId` is non-empty.

**Fail criteria:** Error message or empty `txId`.

---

## Step 4: Check Hedera balance

**UI action:** Click **Balance** in the Hedera card.

**Pass criteria:**
- `sc-hedera-result` shows a balance response for account `0.0.101` with no errors.
- `GET /api/stablecoin/hedera/balance?tokenId=<tokenId>&accountId=0.0.101` returns `success: true`.

**Fail criteria:** Any error message.

---

## Step 5: Create a $1.00 stablecoin payment on Hedera Testnet

**UI action:** In the **Create Stablecoin Payment** card:
- **Destination Wallet:** `0.0.101`
- **Amount ($):** `1.00`
- **Source Type:** `Treasury`
- **Source Account ID:** `TREASURY_HOT`
- **Asset Code:** `DLBUSD`
- **Network:** `Hedera Testnet`
- Click **Create Payment**.

**Pass criteria:**
- `sc-create-result` shows `Payment created: SCP-...`.
- A new row appears in the payments table with:
  - `Status` = `pending`
  - `Amount` = `$1.00`
  - `Fee` = `$0.25`
  - `Total` = `$1.25`
  - `Asset` = `DLBUSD`
  - `Destination` = `0.0.101`

**Fail criteria:** Create error, row missing, or any field value differs from above.

---

## Step 6: Approve the payment and verify treasury reserve

**UI action:**
1. Click **Check Source Balance** and record the displayed `availableCents`.
2. Click **Approve** on the new payment row.
3. Click **Check Source Balance** again.

**Pass criteria:**
- Before-approve `availableCents` >= `125`.
- After-approve `availableCents` = before-approve value - `125`.
- The payment row updates to `Status` = `approved`.
- No error alert.

**Fail criteria:** Approve fails, balance unchanged, or reduction not exactly `125` cents.

---

## Step 7: Settle the payment and verify on-chain metadata

**UI action:** Click **Settle** on the approved payment row.

**Pass criteria:**
- The payment row updates to `Status` = `settled` and the action buttons disappear.
- `GET /api/stablecoin/payments/<id>` returns:
  - `status` = `settled`
  - `tx_hash` non-empty and starts with `shadow-` (deployed app is in Hedera shadow mode)
  - `metadata.hederaTokenId` equals the `tokenId` captured in Step 2

**Fail criteria:**
- Payment status remains `approved` or becomes `failed`.
- `tx_hash` empty or missing.
- `metadata.hederaTokenId` missing or different from the created token ID.

---

## Step 8: Verify final treasury balance

**UI action:** Click **Check Source Balance**.

**Pass criteria:**
- `availableCents` = (before-approve value) - `100`.
- This reflects the `$1.00` disbursed; the `$0.25` gateway fee has been retained by the treasury.

**Fail criteria:** Final `availableCents` does not equal the pre-approve value minus `100` cents.

---

## Step 9: Confirm no console/network errors

**Pass criteria:**
- No `500`, `401`, or `403` responses in the browser console or network tab for `/api/stablecoin/hedera/*` or `/api/stablecoin/payments/*` during the recorded flow.

**Fail criteria:** Any `5xx` or auth error during the Hedera flow.
