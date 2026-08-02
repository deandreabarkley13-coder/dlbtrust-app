# Core Modules Funding Abstraction — dApp End-to-End Test Plan

**Target:** `https://dlbtrust-app.fly.dev/dapp` (`devin/circle-mint-onramp`, PR #234)  
**Auth:** `x-admin-token: dlb-admin-2026-trust`  
**Mode:** live Sepolia for `stablecoin_dex` rail; instrument rails (`cashapp`, `googlewallet`) generate QR/pass without merchant keys.

## What changed

- New **Core Modules** tab in `public/dapp/index.html` (next to Source of Funds). It calls `GET /api/dapp/modules` and renders grouped module balances.
- New `ModuleFundingEngine` (`server/integrations/dapp/moduleFundingEngine.js`) provides:
  - `GET /api/dapp/modules` — grouped module balances from `DappEngine.listSourceBalances()`.
  - `POST /api/dapp/modules/transfer` — internal transfer between like-module accounts.
  - `POST /api/dapp/modules/fund-rail` — reserve source-of-funds ledger and generate/fund an external rail (`cashapp`, `cashapp_fund_operator`, `googlewallet`, `stablecoin_dex`, `coinbase_treasury`, `safe_payout`).
- `CashAppEngine.requestPayment` and `GoogleWalletEngine.createPass` do not require real merchant keys; they generate a shareable QR/deep link or an "Add to Google Wallet" JWT link.

## Preconditions

- Operator token `dlb-admin-2026-trust` saved in the dApp UI.
- `CA-OPERATING` has enough balance for a $0.01 internal transfer plus two $1.00 rail reservations (current: $5,999,961.81).
- `CA-RESERVE` is a valid cash account (current: $42.19).
- Live BondDex pool exists for optional `stablecoin_dex` rail (pool `0x29163502317276cb89c3774b411c695e2b4b8426` from prior tests).

## Step 1: Open Core Modules tab and verify grouped balances load

**UI action:**
1. Open `https://dlbtrust-app.fly.dev/dapp`.
2. Click the **Core Modules** tab.

**Pass criteria:**
- The **Core Modules Ledger View** card appears with a table containing columns: Module, Name, ID, Balance, Currency.
- The table lists at least Treasury, Cash Management, Trust Accounting, Bond/Fixed Income, Core Banking, Sub-Ledger, CRM, Tax, and Documents groups.
- `CA-OPERATING` appears under **Cash Management** with balance `$5,999,961.81` (or current value) and `CA-RESERVE` appears with its current balance.
- No `401`/`403`/5xx errors in the browser console for `/api/dapp/modules`.

## Step 2: Internal transfer between two Cash accounts

**UI action:**
1. In the **Internal Module Transfer** card:
   - From Module: `Cash Management`
   - From Account ID: `CA-OPERATING`
   - To Module: `Cash Management`
   - To Account ID: `CA-RESERVE`
   - Amount: `0.01`
   - Memo: `Core modules test transfer`
2. Click **Transfer**.
3. Click **Refresh** on the Core Modules ledger view.

**Pass criteria:**
- `int-result` shows `Transfer INT-... completed.` with a green success class.
- API `POST /api/dapp/modules/transfer` returns `success: true` and a `transferId` starting with `INT-`.
- After refresh, `CA-OPERATING` balance decreased by `$0.01` and `CA-RESERVE` balance increased by `$0.01`.

**Fail criteria:** Error message, unchanged balances, or `success: false`.

## Step 3: Fund External Rail — Cash App Pay QR

**UI action:**
1. In the **Fund External Rail from Module** card:
   - Source Module: `Cash`
   - Source Account ID: `CA-OPERATING`
   - Amount: `1.00`
   - Rail: `Cash App Pay QR`
   - Rail Options (JSON): `{"cashtag":"$DLBTrust"}`
2. Click **Generate / Fund Rail**.
3. Click **Refresh** on the Core Modules ledger view.

**Pass criteria:**
- `rail-result` shows a success message with `cashapp` rail, source `cash:CA-OPERATING`, amount `$1.00`, and a `fundingId`.
- A QR code image is rendered (from `qrDataUrl` or `cashAppQrDataUrl`).
- A shareable/deep link is present (e.g., `https://cash.app/$DLBTrust/1.00?note=...`).
- `CA-OPERATING` balance decreased by `$1.00` (the rail reserved source funds).
- API `POST /api/dapp/modules/fund-rail` returns `success: true`.

**Fail criteria:** Error message, no QR image, or balance not updated.

## Step 4: Fund External Rail — Google Wallet Pass

**UI action:**
1. In the **Fund External Rail from Module** card:
   - Source Module: `Cash`
   - Source Account ID: `CA-OPERATING`
   - Amount: `1.00`
   - Rail: `Google Wallet Pass`
   - Rail Options (JSON): `{"email":"deandreabarkley13@gmail.com","walletAddress":"0x8a0dfd17efca67590e7a144df5a4d2fce4a054f1"}`
2. Click **Generate / Fund Rail**.
3. Click **Refresh** on the Core Modules ledger view.

**Pass criteria:**
- `rail-result` shows a success message with `googlewallet` rail, source `cash:CA-OPERATING`, amount `$1.00`, and a `fundingId`.
- An "Open payment link / pass" link is rendered pointing to `https://pay.google.com/gp/v/save/...`.
- `CA-OPERATING` balance decreased by another `$1.00`.
- API `POST /api/dapp/modules/fund-rail` returns `success: true`.

**Fail criteria:** Error message, no link, or balance not updated.

## Step 5 (optional): Fund External Rail — Stablecoin DEX

**UI action:**
1. In the **Fund External Rail from Module** card:
   - Source Module: `Cash`
   - Source Account ID: `CA-OPERATING`
   - Amount: `0.01`
   - Rail: `Stablecoin DEX (DLBUSD -> USDC)`
   - Rail Options (JSON): `{"recipient":"0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16","createPoolIfMissing":true}`
2. Click **Generate / Fund Rail**.

**Pass criteria (if attempted):**
- If the operator wallet has enough Sepolia ETH and a pool can be created/funded, the response shows `success: true`, `mode: live`, and a real `tx_hash`.
- If it fails due to insufficient gas or pool liquidity, the error is captured and reported without retrying repeatedly.

**Note:** This step is exploratory; do not spend significant time troubleshooting gas or pool creation.

## What distinguishes working from broken

- Broken module grouping returns an empty table or only Treasury.
- Broken internal transfer does not debit/credit the cash accounts or returns a 5xx.
- Broken Cash App rail does not generate a QR data URL or shareable link.
- Broken Google Wallet rail does not generate an `addToWalletLink`.
- A broken `stablecoin_dex` rail would return a `shadow-` hash or fail silently instead of a real `0x` hash or a clear error.
