---
name: testing-dlbtrust-app
description: How to end-to-end test the DLB Trust treasury dashboard, including stablecoin payments, Hedera Stablecoin Studio, the deployed fly.io instance, and OFX clearing.
---

# Testing DLB Trust (`dlbtrust-app`)

## URLs and credentials

- Local: `http://localhost:3002` (entrypoint `server/server-3002.js`)
- Deployed: `https://dlbtrust-app.fly.dev/`
- Dashboard login: `admin` / `dlb-admin-2026-trust`
- Admin token header for API calls: `x-admin-token: dlb-admin-2026-trust`

## Quick start (local)

1. Verify PostgreSQL is running and the `dlbtrust` database/user exist (or create one).
2. Truncate/seed OFX tables if you need deterministic counts.
3. Start the server in the background with `nohup` and the required env vars:

```bash
cd /path/to/dlbtrust-app
nohup env \
  DATABASE_URL=postgres://dlbtrust:dlbtrust@localhost:5432/dlbtrust \
  JWT_SECRET=<any-stable-secret> \
  ADMIN_SECRET_TOKEN=dlb-admin-2026-trust \
  STABLECOIN_ENABLED=true \
  STABLECOIN_MODE=shadow \
  STABLECOIN_NETWORK=testnet \
  STABLECOIN_DISTRIBUTOR_SECRET=<valid-stellar-secret> \
  STABLECOIN_DISTRIBUTOR_PUBLIC=<matching-public-key> \
  PORT=3002 \
  node server/server-3002.js > /tmp/server-3002.log 2>&1 &
disown
```

- The server warms up Postgres synchronously before listening. It can crash or restart if another process is on port 3002, so verify with `ss -ltnp | grep 3002`.
- Default admin credentials are `admin` / `dlb-admin-2026-trust`.
- The dashboard SPA lives at `http://localhost:3002/`. Set `ADMIN_SECRET_TOKEN` to the admin password so the dashboard's stored `x-admin-token` works as a fallback.

## Common environment issues

- `DATABASE_URL` falls back to `postgres://postgres:postgres@localhost:5432/fineract_tenants` if unset; on a fresh `dlbtrust` DB the core bond/trust tables will be missing and many modules log warnings, but OFX Clearing and the dApp still work.
- Fineract and some backup jobs are not configured locally; expect `fineract` and `pg_dump` errors in the logs. They do not block testing.
- The server may receive `SIGTERM` from an external watchdog or port conflict. If the dashboard starts returning 401 or blank responses, check whether the node process is still alive and restart it.

## UI navigation

- Login via the overlay.
- Use the left sidebar **Stablecoin Payments** nav item to switch to `#page-stablecoin`.
- Use the left sidebar **OFX Clearing** nav item to switch to `#page-ofx`.
- The **Stablecoin Payments** page has cards for readiness, payment creation, source-balance checks, and a payments table.
- The **OFX Clearing** page has cards for institutions, statement import, payment creation, and a payments table.
- Submitting an OFX payment in simulate mode updates the row to `accepted` and persists an XML `ofx_request` in Postgres.
- Creating a stablecoin payment with a non-treasury source (bond, cash, trust, fixed_income, fineract/core_banking) will sweep the source balance into treasury on approve, post the reserve on settle, and reduce the source balance by the payment total.

## Beneficiary Mobile PWA (`/dapp/mobile.html`)

- If the Fly deploy is not live, start the local server connected to the live DB via a `flyctl proxy`:
  ```bash
  flyctl proxy 15432:5432 -a dlbtrust-db &
  env DATABASE_URL=postgres://dlbtrust_app:8r6uuonJw8Jv47a@localhost:15432/dlbtrust_app \
      JWT_SECRET=test ADMIN_SECRET_TOKEN=dlb-admin-2026-trust PORT=3002 \
      SOVEREIGN_TRUST_SHADOW=true node server/server-3002.js
  ```
- Local testing against a live DB requires the same `WALLET_ENCRYPTION_KEY`/`JWT_SECRET` that encrypted the `dapp_wallets.private_key_encrypted` column. If those keys differ, external SIT sends and BitPay payments will fail with `Unsupported state or unable to authenticate data` during `_decrypt`.
- The mobile PWA login returns the PIN in the UI when no email provider is configured; on live SMTP the PIN is hidden, so read it from `dapp_users.otp_code` via `psql`.
- Useful URLs/pages: `http://localhost:3002/dapp/mobile.html`, `http://localhost:3002/dapp/index.html` (mobile portal card), `/dapp/mobile-manifest.json`, `/dapp/mobile-service-worker.js`.
- Camera/QR scanning is unavailable in a headless/desktop test; use `onScan(<string>)` in the console to simulate a QR payload or `el('pay-form').classList.remove('hidden')` to reveal the manual form.
- PWA installability: the manifest must include screenshots with `form_factor` set to `narrow`/`wide` and a valid service worker; without these, Chrome does not show the install button.

## Useful Postgres checks

```sql
-- Stablecoin payments and reserves
SELECT id, status, source_type, source_account_id, total_cents, reserve_id, tx_hash, source_ref
FROM stablecoin_payments ORDER BY created_at DESC;

SELECT account_id, balance_cents, hold_cents, available_cents
FROM stablecoin_treasury_accounts WHERE account_id = 'TREASURY_HOT';

SELECT reserve_id, status, tx_hash FROM stablecoin_reserves ORDER BY created_at DESC;

-- Source balances
SELECT b.id, b.bond_name, bb.principal_balance, bb.accrued_interest
FROM bonds b JOIN bond_balances bb ON bb.bond_id = b.id WHERE b.id = 1;

SELECT account_id, balance_cents FROM cash_accounts WHERE account_id = 'STABLECOIN_CASH_HOLD';
SELECT account_code, balance FROM trust_accounts WHERE account_code = 'TRUST-SRC-TEST2';

-- OFX
SELECT id, status, ofx_request IS NOT NULL AS has_request
FROM ofx_payments ORDER BY id DESC;

SELECT * FROM ofx_statements ORDER BY parsed_at DESC;
SELECT fit_id, type, amount_cents, name, memo FROM ofx_transactions;
```

## Hedera Stablecoin Studio (deployed shadow mode)

- Preconditions: deployed app has `HEDERA_STUDIO_ENABLED=true` and `HEDERA_SHADOW=true`.
- On the **Stablecoin Payments** page, click the in-card **Readiness** button; expect a green `Hedera Ready: OK` result.
- Fill the Hedera card and call `scCreateHederaStablecoin()` to obtain a synthetic `0.0.shadow-<ts>` token ID.
- Call `scMintHederaStablecoin()` to receive a `shadow-<ts>` tx ID.
- Create a payment with `network='hedera-testnet'`, `asset_code='DLBUSD'`, `source_type='treasury'`, `source_account_id='TREASURY_HOT'`.
- Approve and settle via `scApprove(id)` and `scSettle(id)`.
- Verify with API:
  ```bash
  curl -s -H 'x-admin-token: dlb-admin-2026-trust' \
    https://dlbtrust-app.fly.dev/api/stablecoin/payments/<id>
  ```
  Expected: `status: settled`, `tx_hash` starting with `shadow-`, `metadata.hederaTokenId` matching the created token.

## DeFi dApp / Safe multisig (deployed shadow mode)

- dApp lives at `/` and `/dapp`; legacy treasury dashboard at `/treasury`.
- Tabs: Dashboard, Source of Funds, Core Modules, Safe Wallets, Deposit, Payout / 2-Sig, Distribute, P2P Pay, Payment Rails, Bond Tokens, Stablecoin DEX, Sovereign Trust, Asset-Debt Proof, Requests, Automation, Assets / Expenses, FinOps AI, Calendar, Messaging, Documents, Wallet, White Label.
- Safe creation UI: fill label, co-owner address, threshold 2 and call `createSafe()`; server auto-adds its hot-wallet owner and deploys in shadow mode.
- Payout approval without MetaMask:
  1. Create payout via `POST /api/dapp/payouts` with `safeId`, `destination`, `value`, `description`.
  2. Note `safe_tx_hash`.
  3. Generate second-owner signature with `viem`:
     ```js
     const { privateKeyToAccount } = require('viem/accounts');
     const sig = await privateKeyToAccount(privKey).signMessage({ message: { raw: safeTxHash } });
     ```
  4. Approve via `POST /api/dapp/payouts/<id>/approve` with `signature` and `signerAddress`.
  5. In shadow mode expect `status: executed` and `txHash`/`tx_hash` starting with `shadow-`.
- Verify via `GET /api/dapp/safes/<id>` and `GET /api/dapp/payouts/<id>`.

## Common checks

- Treasury hot account balance: `GET /api/stablecoin/treasury/TREASURY_HOT` or click **Check Source Balance**.
- Health: `GET /api/stablecoin/health`.
- Hedera readiness: `GET /api/stablecoin/hedera/readiness`.
- dApp routes: `GET /api/dapp/safes`, `GET /api/dapp/payouts`.

## FinOps AI Agent, Calendar, Messaging, Document Vault (deployed dApp)

- Use the operator token saved in the UI (`$ADMIN_SECRET_TOKEN`) for all `/api/dapp/*` calls.
- Submit a FinOps payment prompt with:
  ```js
  el('finops-prompt').value='Pay $0.01 USDC to 0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16 from cash CA-OPERATING';
  submitFinOpsPrompt();
  ```
- Approve with both trustees using `approveFinOpsTask()`:
  - Administration: `deandreabarkley13@gmail.com` / `DeAndrea Lavar Barkley`
  - Distribution: `annrobinson9800@yahoo.com` / `Malissa Ann Robinson`
- After both approvals the task auto-executes. Poll `loadFinOpsTasks()` until `status: executed`.
- The final `tx_hash` is the USDC transfer to the destination; verify on `https://eth-sepolia.blockscout.com/tx/<txHash>`.
- Calendar auto-creates a `FinOps task: payment <id>` event; you can also create events with `createCalendarEvent()`.
- Messaging auto-creates threads on task creation, each approval, and execution; open one with `openThread(<id>)`.
- Documents list includes `FinOps Payment Confirmation` and `Stablecoin Receipt`s; create a confirmation with `createDocument()`.

## Core Modules funding abstraction (deployed dApp)

- Nav tab **Core Modules** shows grouped module balances (Treasury, Cash Management, Trust Accounting, Bond/Fixed Income, Core Banking, Sub-Ledger, CRM, Tax, Documents) from `GET /api/dapp/modules`.
- Internal transfer: `internalModuleTransfer()` posts to `/api/dapp/modules/transfer` with `{fromType, fromAccountId, toType, toAccountId, amount, memo}`. For cash, `CashEngine.transfer` is used.
- Fund External Rail: `fundExternalRail()` posts to `/api/dapp/modules/fund-rail` with `{sourceType, sourceAccountId, rail, amount, memo, railOptions}`.
  - `cashapp` with `railOptions.cashtag` returns a QR `data:image/png;base64,...` and a `https://cash.app/$<cashtag>/<amount>` deep link.
  - `googlewallet` with `railOptions.email` and `railOptions.walletAddress` returns an `https://pay.google.com/gp/v/save/...` JWT link.
  - `stablecoin_dex` requires amount >= $0.01 (1 cent); the request can hang/take long because it mints DLBUSD and swaps on Sepolia live. For tiny tests prefer an existing `poolAddress` and `createPoolIfMissing:false` if gas is low.
- Note: `STABLECOIN_CASH_HOLDING_ACCOUNT` on the deployed instance may be mapped to `CA-RESERVE`, so rail reservations from `CA-OPERATING` can appear as credits to `CA-RESERVE` in the source-of-funds balance view.

## Live DeFi dApp bond-token / DEX flow (Sepolia, DAPP_SHADOW=false)

- Nav tab **Bond Tokens** exposes Create Token, Mint, DEX Quote and DEX Swap UI.
- Operator hot wallet: `0x3e53028cf69949f3B961ce786Baf2D4D75166562`. Sepolia ETH is required for live factory/pool/swap transactions.
- Readiness: `GET /api/dapp/bond-tokens/readiness` and `GET /api/dapp/dex/readiness` should show `mode: live`.
- Create token: `POST /api/dapp/bond-tokens` with `{bondId, tokenName, tokenSymbol}`; returns `id`, `token_address` (`0x...`).
- Mint: `POST /api/dapp/bond-tokens/<id>/mint` with `{principal, interest, holderAddress}`.
- Create pool: `POST /api/dapp/dex/pools` with `{tokenA, tokenB, amountA, amountB, decimalsA, decimalsB}`; returns `poolAddress`, `txHash`. The engine deploys a `BondDex` contract, sorts tokens by address, approves both tokens, and seeds liquidity.
- Quote: `POST /api/dapp/dex/quote` with `{tokenIn, amountIn, router: <poolAddress>}`; returns live `amountOut` computed from pool reserves.
- Swap: `POST /api/dapp/dex/swap` with `{tokenIn, amountIn, router: <poolAddress>}`; returns live `txHash`.
- If the operator wallet is low on Sepolia ETH, request a top-up or use the CDP EVM faucet (`ethereum-sepolia`) with `COINBASE_CDP_KEY_NAME` / `COINBASE_CDP_PRIVATE_KEY` Fly secrets.
- Blockscout Sepolia explorer: `https://eth-sepolia.blockscout.com/tx/<txHash>`.

## Sovereign Trust Token (SIT) (local shadow mode)

- The dApp nav tab **Sovereign Trust** uses `GET /api/dapp/sovereign-trust/readiness`, `POST /api/dapp/sovereign-trust/deploy`, `POST /api/dapp/sovereign-trust/mint`, `POST /api/dapp/sovereign-trust/burn`, `POST /api/dapp/sovereign-trust/meta-tx/build`, `POST /api/dapp/sovereign-trust/meta-tx/relay`, and `GET /api/dapp/sovereign-trust/orders`.
- In shadow mode (`SOVEREIGN_TRUST_SHADOW=true`), deploy returns `shadow-token-<ts>` and `shadow-forwarder-<ts>`; mint/burn return `shadow-tx-...` hashes; relay returns `shadow-relay-<ts>`.
- Start local server with:
  ```bash
  export ADMIN_SECRET_TOKEN=dlb-admin-2026-trust \
    BOND_DB_NAME=dlbtrust \
    SOVEREIGN_TRUST_ENABLED=true \
    SOVEREIGN_TRUST_SHADOW=true \
    SOVEREIGN_RESERVE_ACCOUNT=TREASURY_HOT \
    DAPP_PRIVATE_KEY=<valid-0x-private-key> \
    DAPP_OPERATOR_ADDRESS=<matching-0x-address> \
    DAPP_RPC_URL=https://ethereum-sepolia.publicnode.com \
    PORT=3002
  node server/server-3002.js
  ```
- Use the dApp UI `admin-token` field with `dlb-admin-2026-trust`.
- For the gasless transfer without MetaMask, mock `window.ethereum` before calling `signSovereignTransfer()`:
  ```js
  window.ethereum = {
    request: async ({ method, params }) => {
      if (method === 'eth_signTypedData_v4') return '0x' + '1'.repeat(130);
      return null;
    }
  };
  ```
  Then call `relaySovereignTransfer()` to relay the signed meta-tx.
- Use `TREASURY_HOT` as the treasury source account for mint and burn; for non-treasury sources ensure the source-of-funds account has a positive balance.

## Sovereign Trust Token (SIT) live mainnet deploy (deployed dApp)

- The dApp **Sovereign Trust** tab reads `GET /api/dapp/sovereign-trust/readiness` and calls `POST /api/dapp/sovereign-trust/deploy`, `POST /api/dapp/sovereign-trust/mint`, etc.
- On mainnet (`SOVEREIGN_TRUST_SHADOW=false`, `DAPP_CHAIN_ID=1`), readiness initially reports `ready: false` with issues `SOVEREIGN_TOKEN_ADDRESS not set or shadow` / `SOVEREIGN_FORWARDER_ADDRESS not set or shadow` until the token and forwarder are deployed.
- Deploy:
  1. Confirm `fly.toml` contains `[build]` `dockerfile = "Dockerfile"` (without it `fly deploy` reports `app does not have a Dockerfile or buildpacks configured`).
  2. From the repo root run `flyctl deploy --app dlbtrust-app --yes --local-only` (or omit `--local-only` if the remote builder picks up the Dockerfile).
  3. `POST /api/dapp/sovereign-trust/deploy` with `x-admin-token: dlb-admin-2026-trust`. The server waits for receipts; it may take >120s. It returns `token` and `forwarder` mainnet addresses.
  4. Set Fly secrets so readiness passes and the app knows the deployed contracts:
     ```bash
     flyctl secrets set --app dlbtrust-app \
       SOVEREIGN_TOKEN_ADDRESS=<token-address> \
       SOVEREIGN_FORWARDER_ADDRESS=<forwarder-address>
     ```
- Verify deploy:
  - `GET /api/dapp/sovereign-trust/readiness` should return `ready: true`, `mode: live`, `network: mainnet`, no issues, and the token/forwarder addresses.
  - `eth_getCode` for both addresses should return non-empty bytecode.
  - Deploy tx hashes (from `eth_getTransactionByHash` with `to: null`):
    - Forwarder deploy uses `gas: 2500000` and input length ~8KB.
    - Token deploy uses `gas: 5000000` and input length ~32KB (16KB deployed bytecode).
- Optional live mint:
  - First ensure the destination address is whitelisted (`POST /api/dapp/sovereign-trust/whitelist` with `address` and `allowed: true`) because `whitelistEnabled` is `true`.
  - First mint on a fresh deploy may fail with `Treasury account not found: SOVEREIGN_RESERVE` because `SOVEREIGN_RESERVE` does not exist in `stablecoin_treasury_accounts`. Create it by SSHing into the Fly machine and calling `TreasuryEngine.getOrCreateAccount('SOVEREIGN_RESERVE')`, or set `SOVEREIGN_RESERVE_ACCOUNT` to an existing account (e.g. `TREASURY_HOT`) before the deploy.
  - `POST /api/dapp/sovereign-trust/mint` with `sourceType: treasury`, `sourceAccountId: TREASURY_HOT`, `amount: 0.01`, and `to: <destination>`.
  - Verify balance with `GET /api/dapp/sovereign-trust/balance/<destination>` and on-chain with `eth_getBalance` of the token contract or `eth_call` `balanceOf(<destination>)`.
- Operator wallet: `0x3e53028cf69949f3B961ce786Baf2D4D75166562`. Live deploy + whitelist + 0.01 SIT mint used ~0.0016 ETH at ~0.17 gwei effective gas price.

## Assets / Expenses & One-Click Automation (deployed dApp)

- Nav tabs **Assets / Expenses** and **Automation** expose the new features.
- **Assets / Expenses** handlers:
  - `addAsset()`, `addLiability()`, `addExpense()`, `loadAssets()`, `loadLiabilities()`, `loadExpenses()`, `loadExpenseTotals()`.
  - Expense pay uses `payExpense(id)`, which calls `window.prompt` for destination, Safe ID, source type, and source account. For scripted tests override `window.prompt` to return the desired values.
  - Example:
    ```js
    const origPrompt = window.prompt;
    window.prompt = (msg) => {
      if (msg.includes('destination')) return '0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16';
      if (msg.includes('Safe ID')) return 'SAFE-1785504557741-WW39EK';
      if (msg.includes('Source type')) return 'cash';
      if (msg.includes('Source account ID')) return 'CA-OPERATING';
      return '';
    };
    payExpense('EXP-...');
    window.prompt = origPrompt;
    ```
- **Automation** handlers:
  - `runOneClickAutomation()` calls `POST /api/dapp/automations/one-click-distribution` with `includeHardAssets` controlled by `el('auto-hard-assets').checked`.
  - `approveExecuteAutomationRun()` calls `POST /api/dapp/automations/runs/<id>/approve-execute`.
- The **Asset-Debt Proof** tab exposes an `Include hard assets / liabilities` checkbox (`adp-hard-assets`). `computeAssetDebtProof()` passes `includeHardAssets` to `/api/dapp/asset-debt-proofs/compute`.
- The **Automation** tab also has an `Include hard assets / liabilities` checkbox (`auto-hard-assets`) and a `Auto-execute after approval` checkbox.
- Existing Sepolia Safe for execution tests: `SAFE-1785504557741-WW39EK` is threshold 1 with status `deployed` but not actually on-chain; execution will fail with `Safe is not deployed yet` due to the operator wallet having no gas. This is the expected testnet behavior.
- Trustee signatures for automation and requests:
  - Administration: `deandreabarkley13@gmail.com` / `DeAndrea Lavar Barkley`
  - Distribution: `annrobinson9800@yahoo.com` / `Malissa Ann Robinson`
- Beneficiary activity: `loadBeneficiaryActivity()` calls `GET /api/dapp/beneficiary/activity?email=<email>` and displays matching requests/payouts.
- Calendar/Messaging: automation run and distribution request creation auto-create Calendar events and Messaging threads.

## Master Dashboard, Fixed-Income Distribution, Public Requests, and Master Wallet Transfers (PR #243)

- Open `https://dlbtrust-app.fly.dev/dapp/master-dashboard.html` directly; the dApp navigation may not load this page reliably from the landing tab bar.
- Enter the operator token `dlb-admin-2026-trust` and click **Save Token**. Most endpoints require `x-admin-token`.
- **Masters tab:** `loadMasters()` calls `GET /api/dapp/master-wallets` and renders four cards: `principal`, `interest`, `operating`, `distribution`. Master wallet on-chain addresses are deterministic and known:
  - principal: `0xECCDF9A767799999320C5D4AFb513f11F1bA2f6e`
  - interest: `0xaC066AF63cdB3d60f81CBC9879736d6FA422aC0E`
  - operating: `0x0CB900C845F2E0F85625d09bc3CEfe36D62A42e3`
  - distribution: `0x4eC020Dc4E9A846bCeffB97DB2a8E95fC9D02500`
- **Ensure master wallets:** `ensureMasterWallets()` calls `POST /api/dapp/master-wallets/ensure` and seeds each wallet with `MASTER_WALLET_GAS_SEED` ETH. This is idempotent.
- **Bond fixed-income distribution:** `distributeFixedIncome()` calls `POST /api/dapp/bonds/<bondId>/distribute-interest` with `{ amount, targetAsset: 'ETH' }`. As of the PR #243 build, `BondEngine.payInterest` adds the string `amount` to `total_interest_paid`, so decimal strings like `"5.00"` cause Postgres numeric parse errors. Calling the API directly with a JSON number (e.g. `5`) bypasses the UI bug but may still run into `WaitForTransactionReceiptTimeoutError` on mainnet.
- **Public landing request** (`https://dlbtrust-app.fly.dev/`):
  - Fill the Beneficiary Distribution Request form and submit. `submitRequest()` posts to `POST /api/dapp/public/request` and creates a beneficiary, maker, checker, and a run with a distribution request.
  - Maker trustee: `annrobinson9800@yahoo.com`. Checker trustee: `dbnettrust@gmail.com`.
  - In Master Dashboard **Requests**, `approveAs(id, 'maker', email)` and `approveAs(id, 'checker', email)` call `POST /api/dapp/distribution-requests/<id>/approve` with `{ role, trusteeEmail, signature: 'sig-<role>-<ts>' }`. Checker approval auto-executes.
  - Execution calls `PayoutCenterEngine.createPayment` with rail `sit`, then `SovereignTrustEngine.mintFromSource`, so the beneficiary address receives SIT on mainnet.
- **Master wallet transfers:**
  - Internal transfer: `masterTransfer()` calls `POST /api/dapp/master-wallets/<fromSubtype>/transfer` with `{ toSubtype, amount, asset }`. Works for `SIT` and `ETH`.
  - External send: `masterExternalSend()` calls `POST /api/dapp/master-wallets/<fromSubtype>/external-send` with `{ toAddress, amount, asset, tokenAddress, decimals }`. For `ETH` it sends native ETH via `WalletEngine.externalEthSend`; for `SIT` it uses `WalletEngine.externalSend` and relays the meta-tx.

## P2P Module Swap (deployed dApp)

- Page: `/dapp/finops.html` -> click the **P2P Module Swap** card.
- Backend: `server/integrations/dapp/moduleP2PSwapEngine.js`, routes `GET /api/finops/module-p2p/orders`, `POST /api/finops/module-p2p/orders`, `POST /api/finops/module-p2p/orders/:id/fill|cancel`.
- Contract: `ModuleTokenSwap` at `MODULE_P2P_SWAP_ADDRESS` (mainnet example `0x9af32c917e319461e906863f3b6b1223ccc8ccce`).
- Listing reads all active orders from the contract `orders` mapping; `createOrder` approves `tokenIn` (DLBUSD/module token) for the P2P contract, then calls `createOrder(tokenIn, amountInRaw, tokenOut, amountOutRaw, recipient)`.
- Units: `amountIn`/`amountOut` in the UI are decimal strings (e.g. `0.001`); the engine `parseUnits(..., 6)` converts them to 1,000 6-decimal units.
- Operator wallet (`0x3e53028cf69949f3B961ce786Baf2D4D75166562`) must hold the tokenIn (DLBUSD) and enough mainnet ETH for the approve + createOrder transactions.
- To create an order from the UI:
  1. Open `/dapp/finops.html`, save the operator token.
  2. Click **P2P Module Swap** (or call `openModule('p2p-swap')` if clicks don't register in headless tests).
  3. In the create form set `tokenIn` to the DLBUSD/module token address, `amountIn`/`amountOut` to `0.001`, and a valid `recipient` address, then click **List Order**.
- Verify: API `GET /api/finops/module-p2p/orders` returns the new order with `active: true`, and `ModuleTokenSwap.orders(orderId)` on-chain shows the same details.
- Useful explorer: `https://etherscan.io/tx/<txHash>` (txHash is not returned by the list endpoint; fetch it from the `OrderCreated` event logs for the order id).

## Peer On-Ramp (deployed dApp) — `/dapp/finops.html` -> **Peer On-Ramp** card

- Backend: `server/integrations/peer/peerOnRampEngine.js` (`@zkp2p/sdk` `OfframpClient`).
- Routes (all require `x-admin-token: dlb-admin-2026-trust`):
  - `POST /api/finops/peer-onramp/quote`
  - `POST /api/finops/peer-onramp/prepare`
  - `POST /api/finops/peer-onramp/execute`
  - `GET /api/finops/peer-onramp/intents`
  - `GET /api/finops/peer-onramp/intents/:hash`
- Target contract: `0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7` on Base (`chainId: 8453`); default USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- Required secret on Fly: `PEER_API_KEY`.
- UI flow:
  1. Open `/dapp/finops.html`, save the operator token, click the **Peer On-Ramp** card (or `openPeerOnRampPanel()`).
  2. Enter platform (`cashapp`, `venmo`, `wise`, etc.), fiat currency (`USD`), and USDC amount (e.g. `10`).
  3. Click **Get Quote**. Expect `available: true` with `fiatAmount`, `tokenAmount`, `paymentInstructions.offchainId`, and an `intent` object.
  4. Click **Prepare Signal**. Expect `prepared.to` = `0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7`, `prepared.chainId` = `8453`, `prepared.value` = `0`, and a hex `prepared.data`.
  5. Click **Signal Intent (Base gas)**. Without Base ETH in `DAPP_OPERATOR_ADDRESS`, this should fail with a `gas required exceeds allowance (0)` message; the UI must not crash.
- If testing the full happy path, fund the operator wallet with Base ETH and check `GET /api/finops/peer-onramp/intents` afterward for the recorded intent.

## PR #264 — Fixed-Income Reconcile + Crypto Conversion (`devin/convert-fixed-income`)

- The Fly deploy may be on `main` and not contain the new script. Deploy the branch before testing: `flyctl deploy --app dlbtrust-app --yes --local-only` from `/home/ubuntu/repos/dlbtrust-app` (requires `secret:org:FLY_API_TOKEN`).
- The relevant UI is `https://dlbtrust-app.fly.dev/dapp/master-dashboard.html`:
  - **Overview** shows aggregated fixed-income totals (all bonds).
  - **Bond / Fixed Income** tab shows the `DLB-PRB` card with principal, accrued interest, total current value, next coupon, and coupon per period.
  - **Master Wallets** tab shows the four master wallets; the Income Distribution Master lists `DAI`, `USDS`, `WETH`, and `DLBUSD` balances.
- Tab buttons may not respond to mouse clicks; use `showTab('overview'|'masters'|'bonds'|'requests')` in the browser console to switch panels.
- CLI conversion script: `node /app/server/scripts/convertFixedIncomeToCrypto.js DLB-PRB --target-asset=DAI --amount=0.01` (run via `flyctl ssh console -a dlbtrust-app -C '...'`):
  - Uses `SourceOfFundsAdapter._fundSourceToTreasury({ sourceType: 'bond_interest', ... })` to debit bond accrued interest, then `StablecoinDexEngine.depositAndSwap` to mint DLBUSD, swap `DLBUSD -> WETH` on the BondDex pool, then `WETH -> DAI` on Uniswap V2.
  - Add `--dry-run` to get a two-leg quote without broadcasting; add `--reconcile` to also run `BondTrustReconciliation.sync` (updates `trust_accounts` 1100/1200/4000 and zeros `CA-BOND-PROCEEDS`).
  - A real conversion credits the Income Distribution Master internal ledger with `actualTargetAsset` and `amountOut`.
- After a real conversion without `--reconcile`, run `POST /api/dapp/bonds/reconcile-trust` with `{"bondId":1}` to keep `trust_accounts` 1200/4000 in sync with `bond_balances`.
- Useful API checks:
  - `GET /api/dapp/bonds/portfolio` for DLB-PRB live metrics.
  - `GET /api/dapp/source-of-funds` for trust account balances.
  - `GET /api/dapp/master-wallets` for the Income Distribution Master asset balances.
- Operator gas: the operator wallet (`0x3e53028...`) must have mainnet ETH for approval/swap transactions; current `DAPP_MAX_FEE_GWEI=3` makes conversions cheap at low base-fee periods.

## PTC-backed Stablecoin (`/dapp/finops.html`)

- Module card: **PTC Stablecoin** (`key:'ptc-stablecoin'`, `action:'openPtcStablecoinPanel'`) in `public/dapp/finops.html`.
- Backend: `server/integrations/dapp/ptcStablecoinEngine.js` with routes in `server/routes/finops.js`:
  - `GET /api/finops/ptc-stablecoin`
  - `GET /api/finops/ptc-stablecoin/balance/:address`
  - `POST /api/finops/ptc-stablecoin/deploy`
  - `POST /api/finops/ptc-stablecoin/reserve-tokens`
  - `POST /api/finops/ptc-stablecoin/reserve-tokens/default`
  - `POST /api/finops/ptc-stablecoin/deposit`
  - `POST /api/finops/ptc-stablecoin/deposit-all`
  - `POST /api/finops/ptc-stablecoin/redeem`
  - `POST /api/finops/ptc-stablecoin/transfer`
  - `POST /api/finops/ptc-stablecoin/whitelist`
- Expected live token/vault addresses are stored in `/data/ptc-stablecoin-state.json` on the Fly machine and returned by the `info()` method:
  - Token `DLB-PTCUSD`: `0xb01e6280ffe6faac679a17b029df8e065e8d0002`
  - Vault: `0xc8b2f6909b50a43ac839e74c3d0e82ae060094d1`
- Read-only verification:
  1. Load `/dapp/finops.html` and authenticate (trustee email/PIN or admin token in `dlb-admin-token`).
  2. Because `resumeSession()` only auto-runs `loadAll()` for JWT sessions, admin-token users may need to call `loadAll()` from the console to populate card stats.
  3. Confirm the **PTC Stablecoin** card shows a non-zero stat (e.g. `$211,187,497` from `totalSupply`).
  4. Click the card; the panel should show token, vault, total supply, owner, and reserve tokens (DLB-BOND, DLB-FIXED-INCOME, DLB-TREASURY, DLB-TRUST, DLB-CORE) with vault balances.
  5. `curl -H 'x-admin-token: dlb-admin-2026-trust' https://dlbtrust-app.fly.dev/api/finops/ptc-stablecoin` should return `deployed: true`, matching token/vault, `totalSupply > 0`, and reserves.
  6. `curl -H 'x-admin-token: dlb-admin-2026-trust' https://dlbtrust-app.fly.dev/api/finops/ptc-stablecoin/balance/<address>` returns the on-chain balance.
- Write operations (deploy, deposit, transfer, redeem) require `DAPP_PRIVATE_KEY` and mainnet ETH; do not execute in read-only tests without confirming gas.

## Canonical Liquidity Engine (`/dapp/finops.html`)

- Module card: **Canonical Liquidity** (`key:'canonical-liquidity'`, `action:'openCanonicalLiquidityPanel'`) in `public/dapp/finops.html`.
- Backend: `server/integrations/dapp/canonicalLiquidityEngine.js` and routes in `server/routes/finops.js`:
  - `GET /api/finops/liquidity` (list pools)
  - `GET /api/finops/liquidity/proposals` (list proposals)
  - `POST /api/finops/liquidity/proposals` (create proposal)
  - `POST /api/finops/liquidity/proposals/:id/approve`
  - `POST /api/finops/liquidity/proposals/:id/execute`
- Proposals are stored as `category:'liquidity'` in the canonical consensus (`canonical_proposals`) table; `CanonicalLiquidityEngine` delegates execution to `DexSwapEngine.createPool`/`addLiquidity`/`swap`.
- The panel supports `create_pool`, `add_liquidity`, and `swap` proposals; sample tiny `create_pool`:
  - Token A: `0xb01e6280ffe6faac679a17b029df8e065e8d0002` (DLB-PTCUSD)
  - Token B: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` (USDC)
  - Amounts: `0.001` / `0.001`
- Approval flow:
  1. The UI **Approve** button calls `canonicalLiquidityApprove(proposalId)` and now sends a JSON body with `role` and `approverEmail` (fixed in the build that added Canonical Money).
  2. Select role `checker` and enter a valid checker email, then click **Approve**.
  3. With threshold `1` and a single `checker` approval, the proposal auto-executes. Because `DAPP_SHADOW=false` on the live deploy, `DexSwapEngine` attempts a real mainnet pool deployment. The operator wallet (`0x3e5302...`) usually has too little ETH, so execution fails with `insufficient funds for gas * price + value` and the proposal `status` becomes `failed`. This is the expected on-chain failure.
- Read-only verification:
  1. `GET /api/finops/liquidity` should return `success: true` and `data: []` (or existing pools).
  2. `GET /api/finops/liquidity/proposals` should return `success: true` and a list including the newly created/failed proposal with `category: 'liquidity'`.
- The card stat is currently always `—`; `loadAll()` does not populate it from the proposal count. This is cosmetic if the panel functions correctly.

## Canonical Money Engine (`/dapp/finops.html`)

- Module card: **Canonical Money** (`key:'canonical-money'`, `action:'openCanonicalMoneyPanel'`).
- Backend: `server/integrations/dapp/canonicalMoneyEngine.js`, routes in `server/routes/finops.js`:
  - `GET /api/finops/canonical-money` — list conversion requests.
  - `POST /api/finops/canonical-money/quote` — get route for a source/target combination.
  - `POST /api/finops/canonical-money/requests` — propose a conversion (creates a `canonical_money` consensus proposal).
  - `POST /api/finops/canonical-money/requests/:id/approve` — approve and auto-execute.
- UI form fields:
  - Source type: ledger sources (`cash`, `treasury`, `trust`, `bond`, `fixed_income`, `fineract`, `sub_ledger`) or token/module (`DLB-PTCUSD`, `DLB-PRB`, `DLB-FIXED-INCOME`, etc.).
  - Source account / token address: ledger account id (e.g. `1`) for source types, or leave blank for tokens/modules.
  - Target asset: `USDC`, `USDS`, `DAI`, `WETH`, `ETH`.
  - Optional pool address and recipient.
- Expected quote behavior:
  - `fixed_income` source → route `action: 'mint_and_swap'`, note `Mint DLBUSD from ledger and swap on DEX`.
  - `DLB-PTCUSD` source with no active pool → route `action: 'ptc_swap'`, `poolAddress: null`, note `No canonical liquidity pool found; create one first`.
- Approval flow:
  1. The **Approve** button calls `canonicalMoneyApprove(proposalId)` with `role` and `approverEmail` from the per-row dropdown/input (verify with a fetch interceptor or network tab).
  2. Auto-execution runs through `CanonicalConsensusEngine._execute` → `CanonicalMoneyEngine._executeRoute`. For ledger sources it uses `StablecoinDexEngine.depositAndSwap`; for PTC/module sources it uses `PtcStablecoinEngine`/`DexSwapEngine`.
  3. With operator ETH near zero, execution fails quickly with `insufficient funds for gas * price + value`. The `canonical_proposals` row is updated to `failed` with the error in `result`.
- Caveat: `CanonicalMoneyEngine._execute` does not wrap `_executeRoute` in a try/catch, so `canonical_money_requests` is not updated to `failed` when the route throws. Check `canonical_proposals` status for the real execution result if the UI request list still shows `pending`.
- Read-only verification:
  - `GET /api/finops/canonical-money` returns `success: true` and an array of requests.
  - `GET /api/finops/consensus/proposals/<proposalId>` returns the proposal with `category: 'canonical_money'`, approvals, and `status`/`result`.

## Liquidity Pool Engine (`/dapp/finops.html`)

- Module card: **Liquidity Pool Engine** (`key:'liquidity-pool'`, `action:'openLiquidityPoolPanel'`).
- Backend: `server/integrations/dapp/liquidityPoolEngine.js`, routes in `server/routes/finops.js`:
  - `GET /api/finops/liquidity-pool` — list pools from `canonical_liquidity_pools` (currently empty until pools are created through this engine).
  - `GET /api/finops/liquidity-pool/:address` — on-chain pool info via `DexSwapEngine.getPoolInfo`.
  - `POST /api/finops/liquidity-pool/create`
  - `POST /api/finops/liquidity-pool/add-liquidity`
  - `POST /api/finops/liquidity-pool/remove-liquidity`
  - `POST /api/finops/liquidity-pool/quote`
  - `POST /api/finops/liquidity-pool/swap`
- UI panel sections:
  - **Create Pool** — tokenA, tokenB, decimals A/B, amountA, amountB.
  - **Add / Remove Liquidity** — pool address, amountA, amountB.
  - **Swap / Quote** — pool address, tokenIn, amountIn, minOut/slippage, recipient.
- Testing the quote (read-only):
  - If `BOND_DEX_ADDRESS` is configured (env on Fly), use it as the pool address.
  - Example payload for the live BondDex pool (`0x6d81a71daa0aea908d57c31251db0013b2e41aea`):
    ```json
    {
      "poolAddress": "0x6d81a71daa0aea908d57c31251db0013b2e41aea",
      "tokenIn": "0x6bA8D02596a3b091A7246e38e3e078f770D33985",
      "amountIn": "1",
      "decimalsIn": 6
    }
    ```
  - Expected response: `success: true`, `data.tokenOut` is the other pool token, `data.amountOut` is a positive decimal string, `data.mode: 'live'`.
- Note: `create`/`add`/`remove`/`swap` are write endpoints and require mainnet gas; skip them unless the operator wallet is funded.
- The `GET /api/finops/liquidity-pool` list may be empty even when a BondDex pool exists on-chain, because `listPools()` only queries the `canonical_liquidity_pools` table populated by this engine.

## Cross-Chain Conversion & Interoperability Engine (PR #275)

- Module card: **Cross-Chain Conversion** (`key:'cross-chain'`, `action:'openCrossChainPanel'`).
- Backend: `server/integrations/dapp/crossChainConversionEngine.js`; routes in `server/routes/finops.js`:
  - `GET /api/finops/cross-chain` (list requests)
  - `GET /api/finops/cross-chain/:id` (single request)
  - `POST /api/finops/cross-chain/quote`
  - `POST /api/finops/cross-chain/requests`
  - `POST /api/finops/cross-chain/requests/:id/approve`
  - `POST /api/finops/cross-chain/requests/:id/execute`
  - `GET /api/finops/cross-chain/adapters/chains`
  - `GET /api/finops/cross-chain/adapters/assets`
- UI panel sections: New Conversion (source type/id, amount, target asset/chain/bridge, recipient, slippage), Quote Routes, Propose, Chains, Assets, Conversion Requests.
- Example quote payload for a sub_ledger source:
  ```json
  {
    "sourceType": "sub_ledger",
    "sourceAccountId": "SL-INV-1782881392896-1200-MR1OZ6PO",
    "amount": "433721.62",
    "targetAsset": "USDS",
    "targetChain": "ethereum"
  }
  ```
- Expected quote response: `data.recommendation` is `p2p_order` when DEX liquidity is tiny; `same_chain_dex` route has `status: 'no_liquidity'` with a high-slippage warning; `p2p_order` route has `status: 'awaiting_buyer'`.
- Propose/approve/execute flow creates a Canonical Consensus proposal under `category: 'cross_chain'`. The UI Approve button sends `role` and `approverEmail`.
- **Caution:** `execute` may actually succeed on mainnet even with a low ETH balance, minting DLBUSD from the source ledger and locking it in the `ModuleTokenSwap` contract. Test with tiny amounts or a shadow/testnet environment; do not assume operator gas will fail.
- The `_p2pDisplayFromRaw` helper now uses `viem.formatUnits(raw, 6)` so `ModuleP2PSwapEngine.createOrder` receives the correct display string for both 6- and 18-decimal tokens despite its hard-coded 6-decimal parse.

## Canonical USDS Swap (`/dapp/finops.html`)

- Module card: **Canonical USDS Swap** (`key:'canonical-swap'`, `action:'openDlbCanonicalSwapPanel'`).
- Backend: `server/integrations/dapp/dlbCanonicalSwapEngine.js`; routes in `server/routes/finops.js`:
  - `GET /api/finops/canonical-swap/readiness` — returns `mode` (`live`/`shadow`), `contractAddress`, and `issues`.
  - `GET /api/finops/canonical-swap/orders` — lists active orders from the on-chain `DlbCanonicalSwap` contract.
  - `GET /api/finops/canonical-swap/orders/:id` — single order details.
  - `POST /api/finops/canonical-swap/quote` — returns a 1:1 quote.
  - `POST /api/finops/canonical-swap/orders` — create order (write; requires operator ETH).
  - `POST /api/finops/canonical-swap/orders/:id/fill` — fill order (write).
  - `POST /api/finops/canonical-swap/orders/:id/cancel` — cancel order (write).
- Deployed mainnet contract: `0xf06f89f03d3a6003d8bc1bf5934b857c41258f75`.
- Live tokens used by the contract:
  - DLBUSD: `0x6bA8D02596a3b091A7246e38e3e078f770D33985` (6 decimals)
  - USDS: `0xdC035D45d973E3EC169d2276DDab16f1e407384F` (18 decimals)
  - USDC: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
  - DAI: `0x6B175474E89094C44Da98b954EedeAC495271d0F`
  - WETH: `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`
- UI panel sections:
  - **Contract** — shows readiness badge (`live`/`shadow`) and the deployed contract address; a **Deploy Contract** button and a **Refresh Orders** button.
  - **Create Order** — inputs for `tokenIn`, `tokenOut`, `amountIn`, `amountOut`, and `recipient`; **Create Order** button.
  - **Active Orders** — table with columns `ID`, `Token In`, `Amount In`, `Token Out`, `Amount Out`, `Recipient`, `Status`, and a **Cancel** button per row.
- Read-only verification:
  - `GET /api/finops/canonical-swap/readiness` should return `ready: true`, `mode: 'live'`, and `contractAddress: '0xf06f89f03d3a6003d8bc1bf5934b857c41258f75'`.
  - `GET /api/finops/canonical-swap/orders` should return a live order with `orderId: '2'`, `tokenIn` = `0x6bA8D02596a3b091A7246e38e3e078f770D33985`, `tokenOut` = `0xdC035D45d973E3EC169d2276DDab16f1e407384F`, `active: true`, and raw `amountIn`/`amountOut` strings.
  - `POST /api/finops/canonical-swap/quote` with `{"tokenIn":"0x6bA8...","amountIn":"1","tokenOut":"0xdC035D..."}` returns `success: true`, `data.price: '1.0'`, and `data.amountOut: '1'`.
- **Caution:** `listOrders()` returns raw on-chain amounts. The UI table currently displays these raw values without `viem.formatUnits`, so the `Amount In`/`Amount Out` columns may show very large integers rather than human-readable token amounts. This is cosmetic but should be fixed before operators rely on the table.
- Do **not** click **Cancel** or **Create Order** on a live order unless explicitly testing write flows with a funded operator wallet.

## Paired Asset Engine (PR #275+)

- Module card: **Paired Asset Engine** (`key:'paired-assets'`, `action:'openPairedAssetsPanel'`).
- Backend: `server/integrations/dapp/pairedAssetEngine.js`; routes in `server/routes/finops.js` under `/api/finops/paired-assets`.
- Quote/propose/approve/execute flow sources the real canonical asset (USDS/USDC/DAI/WETH) needed to seed a `DLBUSD` pool, then adds liquidity through `LiquidityPoolEngine`.
- Funding sources: `manual`, `counterparty`, `moonpay`, `circle_mint`, `coinbase_treasury`.
- The engine cannot mint canonical stablecoins; it returns `awaiting_deposit`/`awaiting_onramp` until real paired capital is available.

## External Endpoint Engine (`/dapp/finops.html`)

- Module card: **External Endpoint Engine** (`key:'external-endpoint'`, `action:'openExternalEndpointPanel'`).
- Backend: `server/integrations/dapp/externalEndpointEngine.js`; routes in `server/routes/finops.js`:
  - `GET /api/finops/external-endpoints` — list endpoints.
  - `POST /api/finops/external-endpoints` — create an endpoint.
  - `GET /api/finops/external-endpoints/:id` — get one endpoint.
  - `POST /api/finops/external-endpoints/:id/test` — test the connection.
  - `POST /api/finops/external-endpoints/:id/payments` — create and send a payment through the endpoint.
  - `GET /api/finops/external-payments` — list recent payments.
  - `GET /api/finops/external-payments/:id` — get a single payment (includes `raw_request` and `raw_response`).
  - `POST /api/finops/external-payments/:id/send` — resend a pending payment.
- UI panel sections:
  - **Add External Endpoint** — name, protocol (`rest_json`/`rest_xml`/`soap`/`iso20022_xml`/`grpc`/`mft_sftp`/`as2`/`manual`), auth type, base URL, API key/secret, response-success JSON path, extra headers, payload template.
  - **Endpoints** table with **Test** and **Delete** buttons.
  - **Send Payment via Endpoint** — select endpoint, optional source cash account, amount, creditor (name / account / routing / bank), optional debtor, description.
  - **Recent External Payments** table showing `payment_id`, `endpoint_id`, amount, status, and error.
- Test endpoints against public test URLs:
  - `https://httpbin.org/anything` accepts GET and POST — connection test returns `connected: true` and payments usually end in `manual_pending` because the echo response does not contain a payment `id`/`payment_id`/`transaction_id`.
  - `https://httpbin.org/post` only accepts POST — the built-in **Test** button sends a GET, so it returns `connected: false` with a 405 error. Use `/anything` for a reliable positive connection test.
- Payment flow verification:
  - A `$0.01` REST/JSON payment to `/anything` should create a payment with `status: manual_pending` and `raw_response` containing the full httpbin echo (including `url`, `data`, `json`, `headers`, and `method: POST`).
  - `raw_request` is a JSON string with `reference_id`, `amount`, `currency`, `payment_type`, `description`, `debtor`, and `creditor` objects.
- Trust Bank integration:
  - Trust Bank API panel can originate payments with `rail: external` and select an external endpoint from the dropdown.
  - The balance of the trust bank account is debited; a linked external payment record is created with `payment_type: trust_bank_external`.
- `manual` protocol is intended for offline/CSV/SWIFT/fax rails and stores `raw_request` without making an HTTP call.
- **Known issue:** `loadAll()` in `public/dapp/finops.html` references an undefined `results` variable at `const webPayments = results[20];`, so `loadAll()` logs a console error and module card stats remain `—`. This does not block the panel functions but should be fixed.

## Rally Protocol (`/dashboard` Rally Wallet tab)

- Tab: **Rally Wallet** in `public/dapp/trust-dashboard.html`.
- Backend: `server/integrations/dapp/rallyProtocolEngine.js`; routes in `server/routes/rallyProtocol.js`:
  - `GET /api/rally/readiness` (auth-protected by `operatorAuth`).
  - `GET /api/rally/wallets`, `POST /api/rally/wallets`.
  - `GET /api/rally/wallets/:id/balance`, `POST /api/rally/wallets/:id/fund`.
  - `POST /api/rally/wallets/:id/pay-requests`.
  - `POST /api/rally/payouts`, `GET /api/rally/payouts`.
  - `POST /api/rally/scan-qr`, `POST /api/rally/tap-pay`.
  - `GET /api/rally/requests`.
- Authentication: dashboard uses `localStorage` key `dlb-admin-token` (`dlb-admin-2026-trust` on Fly), which is sent as `x-admin-token`.
- Typical end-to-end flow:
  1. Create wallet: fills `rally-label`, `rally-email`, `rally-type`; call `createRallyWallet()`.
  2. Fund wallet: select wallet in `rally-fund-wallet`, amount in `rally-fund-amount`; call `fundRallyWallet()`.
  3. Request payment (QR): select wallet in `rally-req-wallet`, amount/memo; call `createRallyRequest()`. The panel shows a base64 PNG (`qrDataUrl`) and a deep link (`shareableUrl`).
  4. Tap-pay: paste the deep link in `rally-qr-data` and call `scanRallyQr()`; select a different funded payer wallet in `rally-pay-wallet`; call `rallyTapPay()`.
  5. Duplicate tap-pay: calling `rallyTapPay()` again with the same `requestId` returns `payment request already processed` and no second payout is created.
  6. Direct payout: fill `rally-pay-wallet`, `rally-pay-to`, `rally-pay-amount`, `rally-pay-memo`; call `createRallyPayout()`.
- Wallet address derivation uses `AccountAbstractionEngine.getSmartAccountAddress(owner, BigInt(index))`. The new wallet index is allocated atomically from a Postgres sequence (`rally_wallet_index_seq`) or `max(file state) + 1` fallback, and the record is inserted to the DB before JSON state.
- The engine runs in `aa-fallback` mode (`RALLY_API_KEY` not set), using the existing `AccountAbstractionEngine` / `SovereignTrustPaymaster` for gasless transfers.
- Token: DLB-PTCUSD (`0xb01e6280ffe6faac679a17b029df8e065e8d0002`). Paymaster: `0x6f0c2c593bb3942cf11eacbef46c78fd51b99948`. Operator: `0x3e53028cf69949f3B961ce786Baf2D4D75166562`.
- UI escape: `escapeHtml()` is applied to wallet labels, addresses, IDs, payout fields, shareable URLs, and QR scan output, so creating a wallet with label `<script>alert(1)</script> Test` renders literally and does not execute.
- **Auto-deploy fix:** `RallyProtocolEngine.fundWallet` and `createPayout` now call `_ensureSmartAccountDeployed(wallet, cfg)` to deploy the smart account via `SimpleAccountFactory.createAccount` from the operator EOA, so the first outgoing direct payout/tap-pay no longer carries `initCode`. The userOp shown in error responses will have `initCode: "0x"` after this fix.
- **Paymaster deposit is still required:** the paymaster's EntryPoint deposit is what caps `maxFeePerGas` in `AccountAbstractionEngine._feeValues`. If deposit is low, the bundler rejects the userOp with `maxFeePerGas or maxPriorityFeePerGas is too low` even though the account is deployed. Check `/api/finops/account-abstraction/balance` first; if `entryPointDeposit` is < ~0.0001 ETH, fund the paymaster with `POST /api/finops/account-abstraction/fund-paymaster` (e.g. `amountEth: "0.0001"`) from operator ETH before testing a first outgoing payout from a new wallet.
- **Gotcha:** a brand-new wallet must be deployed on-chain before it can send a direct payout. The auto-deploy in `fundWallet`/`createPayout` deploys the smart-account from the operator EOA, but the first *outgoing* transfer will still fail if the paymaster deposit cannot cover the gas. Prefer checking the paymaster balance and topping up when needed.

## Decentralized Ramps (`/dapp/finops.html`)

- Routes:
  - `GET /api/finops/decentralized-ramps/providers`
  - `POST /api/finops/decentralized-ramps/quote`
  - `POST /api/finops/decentralized-ramps/requests`
  - `GET /api/finops/decentralized-ramps/requests/:id`
  - `GET /api/finops/decentralized-ramps/requests`
  - `POST /api/finops/decentralized-ramps/requests/:id/approve`
  - `POST /api/finops/decentralized-ramps/requests/:id/execute`
- UI IDs: `dramp-direction`, `dramp-source`, `dramp-target`, `dramp-amount`, `dramp-source-type`, `dramp-source-account`, `dramp-target-address`; buttons call `drampQuote()` and `drampPropose()`; results render in `dramp-quote`, `dramp-providers`, `dramp-requests`.
- Test quote: direction `exchange`, source `DLB-PTCUSD`, target `DAI`, amount `0.001`.
- Expected route providers: `cross_chain` (`ModuleTokenSwap / OTC order book`), `trust_market` (`DLB Trust P2P Market`), `p2p_canonical_swap` (`DLB Canonical P2P Swap`). `stablecoin_dex` appears if source is `DLBUSD`.
- Canonical Consensus approval: one approval from `maker` (`annrobinson9800@yahoo.com`) or `checker` (`dbnettrust@gmail.com`); `required_approvals` defaults to 1.
- **Known issue:** the UI `drampPropose()` only sends `routeProvider` (display string) and not the full `route` object. `DecentralizedRampEngine.propose()` skips re-quoting when `routeProvider` is provided, so `payload.route` is `null` and `_execute` cannot dispatch `cross_chain`/`p2p_order` routes. Work-around: use the API directly and include the `route` object, or select the `trust_market` provider, whose execution path depends only on the `routeProvider` string. A proper fix is needed in the UI or engine before the recommended cross-chain route works end-to-end from the panel.
- `trust_market` execution calls `TrustMarketEngine.createOffer()`, which returns an existing active P2P order (e.g. `orderId: "10"`) without locking new tokens or spending gas when a matching order already exists.
- Dashboard stat badge `decentralized-ramps` is the count of requests with `status === 'pending'`.

## Reserve Vault (CDP) (`/dapp/finops.html`)

- Routes:
  - `GET /api/finops/reserve-vault/readiness`
  - `GET /api/finops/reserve-vault/info`
  - `GET /api/finops/reserve-vault/positions`
  - `GET /api/finops/reserve-vault/positions/:id`
  - `POST /api/finops/reserve-vault/mint`
  - `POST /api/finops/reserve-vault/quote`
  - `POST /api/finops/reserve-vault/swap`
- UI IDs: `rv-source-type`, `rv-source-account`, `rv-amount`, `rv-target`, `rv-position-id`, `rv-target-asset`; buttons call `rvMint()`, `rvQuote()`, `rvSwap()`; positions list `rv-positions`.
- Minting requires `StablecoinDexEngine` to be available; it creates a `reserve_vault_positions` row and a mainnet `mintTxHash`.
- Test mint: `sourceType: 'trust_account'`, `sourceAccountId: '4000'`, `amount: 1` (or any small positive value).
- Quote: `POST /api/finops/reserve-vault/quote` with `{ positionId, targetAsset: 'DAI' }` returns routes from `DecentralizedRampEngine.quote`.
- For `DLBUSD -> DAI`, expect `stablecoin_dex` (tiny/near-zero output if no DAI liquidity), `trust_market`/`p2p_canonical_swap` ready at 1:1, `ptc_bondex` if source is `DLB-PTCUSD`, and `BondDex + Uniswap V2` likely `no_liquidity`.
- Operator wallet `0x3e53028c...` needs mainnet ETH for gas; gas costs are tiny when base fee is low.

## Push-to-Card Engine (`/dapp/finops.html`)

- Module card: **Push-to-Card Engine** (`key:'push-to-card'`, `action:'openPushToCardPanel'`).
- Backend: `server/integrations/payments/pushToCardEngine.js`; routes in `server/routes/finops.js`:
  - `GET /api/finops/push-to-card/info`
  - `GET /api/finops/push-to-card/providers`
  - `GET /api/finops/push-to-card/payments`
  - `POST /api/finops/push-to-card/payments`
  - `POST /api/finops/push-to-card/payments/:id/execute`
  - `POST /api/finops/push-to-card/payments/:id/cancel`
  - `GET /api/finops/push-to-card/payments/:id`
- UI IDs: `ptc-provider`, `ptc-source`, `ptc-name`, `ptc-last4`, `ptc-network`, `ptc-recipient`, `ptc-amount`, `ptc-currency`, `ptc-config`, `ptc-memo`; buttons call `createPushToCard()` and `executePushToCard(paymentId)`; status area `ptc-status`; payments table `ptc-list`.
- Providers exposed: `visa_direct`, `mastercard_send`, `formance`, `apache_http`, `manual`, `card_vault`.
- Sources: `cash:CA-OPERATING` and `ledger:4000` (hardcoded in the UI select).
- Provider config JSON (`ptc-config`) can override `connectorId`, `formanceSourceAccountId`, `destinationAccountId`, `pushUrl`. Note: `formance` looks for `formanceSourceAccountId` (not `sourceAccountId`) when reading from the stored config.
- **Apache HTTP (self-hosted)**: requires `APACHE_HTTP_PUSH_URL` and optional `APACHE_HTTP_API_KEY`. The UI calls `POST /api/finops/push-to-card/payments/:id/execute`; the backend POSTs to `push.php` with `x-api-key`. The endpoint returns `{ status: 'submitted', txId: 'TX-...' }` and the payment row becomes `submitted`.
- **Formance (self-hosted)**: requires `FORMANCE_API_URL`, `FORMANCE_API_TOKEN`, `FORMANCE_CONNECTOR_ID/SOURCE_ACCOUNT_ID/DESTINATION_ACCOUNT_ID` (or config overrides). If not configured, execution falls back to `manual_pending` and `raw_response` contains the `PAYOUT` payload plus a manual-instruction note.
- Live Visa Direct requires `VISA_DIRECT_API_KEY`, `VISA_DIRECT_SHARED_SECRET`, `VISA_DIRECT_URL`, and `VISA_DIRECT_LIVE=true`. Without them, `visa_direct` falls back to `manual_pending` with manual instructions.
- Test flow:
  1. Select `apache_http` provider and `cash:CA-OPERATING` (or `ledger:4000`).
  2. Fill cardholder name, last 4, amount, currency, optional memo. Leave `ptc-config` empty to use Fly secrets.
  3. Click **Create Push-to-Card** — a `pending` `push_to_card_payments` row is created.
  4. Click **Execute** on the row — funds are reserved (cash transferred to `PTC-HOLD` or a ledger JE posted to `PTC-HOLD`) and status becomes `submitted` with a `tx_id` from the Apache endpoint.
  5. `GET /api/finops/push-to-card/payments/:id` should show `status: 'submitted'`, non-null `tx_id`, and `raw_response` containing the Apache `pushUrl` and the endpoint's JSON response.
- `metadata.reserve` is populated with `holdAccount: 'PTC-HOLD'` or `journalEntryId` for ledger sources.
- The dashboard `loadAll()` now fetches `/api/finops/push-to-card/payments` and calls `setStat('push-to-card', activeCount)`; the module badge reflects the count of `pending`/`reserved`/`manual_pending`/`submitted` payments.

## FINOS CDM Engine (`/dapp/finops.html`)

- Module card: **FINOS CDM Engine** (`key:'finos-cdm'`, `action:'openFinosCdmPanel'`).
- Backend: `server/integrations/finops/finosCdmEngine.js`; routes in `server/routes/finops.js`:
  - `GET /api/finops/finos-cdm/events?referenceId=...`
  - `GET /api/finops/finos-cdm/events/:id`
  - `POST /api/finops/finos-cdm/events`
  - `POST /api/finops/finos-cdm/events/:id/validate`
  - `POST /api/finops/finos-cdm/push-to-card/:id/event`
- UI IDs: `cdm-reference`, `cdm-ptc-id`; buttons call `loadCdmEvents()` and `recordCdmPushToCard()`; status area `cdm-status`; events table `cdm-list`.
- `PushToCardEngine.executePayment()` auto-calls `FinosCdmEngine.recordPushToCard()` on successful execution, so a CDM `CashTransfer` event is created with `intent: 'PUSH_TO_CARD_PAYMENT'`, `reference_id` matching the `payment_id`, and `status` matching the payment status.
- To test manually: open the panel, enter a PTC `payment_id` in `cdm-ptc-id`, and click **Record CDM Event**.
- `GET /api/finops/finos-cdm/events?referenceId=PTC-...` should return the event with `event_type: 'CashTransfer'`, `counterparty_id` set to the cardholder name, `amount` in USD, and `payload` containing `meta`, `eventIdentifier`, `functionEvent.primitive.cashTransfer`, and `metadata` (cardholder, last4, network).

## BankSync Integration (`/dapp/finops.html`)

- Module card: **BankSync Integration** (`key:'banksync'`, `action:'openBankSyncPanel'`).
- Backend: `server/integrations/finops/bankSyncEngine.js`; routes in `server/routes/finops.js`:
  - `GET /api/finops/banksync/whoami`
  - `GET /api/finops/banksync/banks`
  - `GET /api/finops/banksync/banks/:id`
  - `GET /api/finops/banksync/banks/:id/accounts`
  - `GET /api/finops/banksync/accounts/:aid/balances`
  - `GET /api/finops/banksync/accounts/:aid/transactions`
  - `GET /api/finops/banksync/banks/:bid/accounts/:aid/balances`
  - `GET /api/finops/banksync/banks/:bid/accounts/:aid/transactions`
  - `POST /api/finops/banksync/banks/:bid/accounts/:aid/sync`
  - `GET /api/finops/banksync/cached/banks`
  - `GET /api/finops/banksync/cached/accounts`
  - `GET /api/finops/banksync/cached/accounts/:id/transactions`
- Required secret on Fly: `BANKSYNC_API_KEY`.
- UI IDs: workspace display `bs-whoami`, banks list `bs-banks`, accounts `bs-accounts`, transactions `bs-txs`, status `bs-status`.
- Panel buttons: `loadBankSyncBanks()` fetches banks; `loadBankSyncTransactions()` fetches txns for the account id in `bs-account-id`.
- `GET /api/finops/banksync/whoami` returns `{ success:true, data:{ workspaceId, workspaceName, authMethod, scopes, planTier }}` (the BankSync `{success, data}` envelope is unwrapped in `bankSyncEngine.banksyncRequest` and the route returns `data: raw.data || raw`). The UI `loadBankSyncWhoami()` reads `res.data.workspaceName` and should display the workspace name.
- With a write-only API key, `GET /api/finops/banksync/banks` returns `Missing required scope: banks:read`; the UI should surface this in `bs-banks` and remain usable.
- Native clicks on module cards may be unreliable in scaled viewports; if so, call `openModule('banksync')` from the browser console.

## Finance Operating Server (`/dapp/finops.html`)

- Backend: `server/integrations/finops/financeOperatingServerEngine.js` (ensure tables, execute command, health, cash position, processors, sessions, command logging).
- Routes under `/api/finops/finance-operating/*` in `server/routes/finops.js` (all `operatorAuth`):
  - `POST /execute` — natural-language command dispatch
  - `POST /sessions`, `GET /sessions`, `GET /sessions/:id`
  - `GET /commands`
  - `GET /health`
  - `GET /cash-position`
  - `GET /processors`
- Tables: `finance_operating_sessions` and `finance_operating_commands` are ensured by `server/server-3002.js` on startup (log line `[finance-operating] tables ensured`).
- Login: use `dlb-admin-2026-trust` stored in `localStorage` as `dlb-admin-token` (set via `javascript:localStorage.setItem('dlb-admin-token','dlb-admin-2026-trust');location.reload()`). The page also supports email/PIN trustee login.
- UI: module card key `finance-operating` calls `openFinanceOperatingPanel()`. The panel shows system health, a `Run Operating Command` input (`#fose-command`) with `foseExecute()`, a cash-position JSON block, a processor grid, and a `Recent Commands` table.
- The FinOps Agent chat on the right sidebar (`#chat-input` / `sendChat()`) also posts to `/api/finops/finance-operating/execute`.
- Example commands:
  - `health` → panel status `System health: OK/degraded`
  - `cash position` → cash-position JSON block refreshes
  - `list processors` → processor grid with 8 processors (stripe_treasury, clearing, deposit_settlement, payout_center, lili, skrill, web_payment_rail, payment_hub)
  - `pay $0.25 manual` → dispatches to `PaymentProcessorServerEngine` / `ClearingApiEngine`, returns `status: manual` and a `CLR-` clearing row with `manual_pending`
- **Known gotcha (PR #321):** `public/dapp/finops.html` line `onkeydown="if(event.key==='Enter') foseExecute()"` is inside a single-quoted JS string and terminates it, causing the entire page script to fail (blank module grid). Patch: change the inner single quotes to HTML entities (`&quot;`) so the attribute becomes `onkeydown="if(event.key===&quot;Enter&quot;) foseExecute()"`.
- Commands are persisted and retrievable via `GET /api/finops/finance-operating/commands`; `POST /sessions` creates a `FOS-` session ID.

## Deposit & Settlement / Clearing (`/trust-portal/dashboard.html`)

- New backend engines: `server/integrations/payments/depositAndSettlementEngine.js` and `clearingApiEngine.js`.
- New routes (all require `operatorAuth`, i.e. admin token or a portal user with `operator`/`trustee` level):
  - `GET /api/dapp/ptc/deposit-settlement/orders`
  - `GET /api/dapp/ptc/deposit-settlement/orders/:id`
  - `POST /api/dapp/ptc/deposit-settlement/deposit`
  - `POST /api/dapp/ptc/deposit-settlement/settle`
  - `POST /api/dapp/ptc/deposit-settlement/reconcile`
  - `GET /api/dapp/ptc/clearing/list`
  - `GET /api/dapp/ptc/clearing/status/:id`
- Tables `deposit_settlement_orders` and `clearing_settlements` are created by `server/server-3002.js` on startup.
- UI IDs: `#tab-deposit-settlement`, `recordDsDeposit()`, `initiateDsSettlement()`, `reconcileDsOrder()`, `loadDsOrders()`.
- **Record Deposit**: `POST /api/dapp/ptc/deposit-settlement/deposit` with `{ amount, rail, cashAccountId, trustAccountCode, externalReference }` creates a `deposit_settlement_orders` row with `direction: 'deposit'`, `status: 'posted'`, plus a cash movement and trust journal entry. The default `cashAccountId` in the UI is `CA-STRIPE-TREASURY` and default `trustAccountCode` is `PTC-DEPOSIT-CLEARING`.
- **Initiate Settlement**: `POST /api/dapp/ptc/deposit-settlement/settle` with `{ amount, rail, sourceCashAccountId, destination, requireCip }`.
  - For `rail: 'stripe_ach'` (or any `stripe_*` rail) and `requireCip: true`, the engine calls `CustomerIdentificationEngine.validatePayoutRecipient({ fullName, email, requireClear: true })` first. If no `clear` CIP record exists for the email or name, it returns `CIP required for settlement: No CIP record found for recipient` without writing ledger entries or `ptc_payouts` rows.
  - After a cleared CIP exists, the next failure is typically `Stripe secret key not configured` in local/sandbox environments.
  - With `rail: 'manual'`, CIP is skipped, the source cash account balance is checked, a trust journal entry is posted (debit `PTC-SETTLEMENT-CLEARING`, credit `1100`), and `ClearingApiEngine.submit` creates a `clearing_settlements` row with `status: 'manual_pending'`.
- **Reconcile**: `POST /api/dapp/ptc/deposit-settlement/reconcile` with `{ orderId, status }` updates the order status and, for `failed`/`returned`, posts a reversal journal. Allowed status values: `completed`, `failed`, `returned`, `posted`.
- **List endpoints**: `GET /api/dapp/ptc/deposit-settlement/orders?limit=50` and `GET /api/dapp/ptc/clearing/list` return the persisted rows.
- Environment: set `STRIPE_TREASURY_CIP_REQUIRED=true` to enforce CIP on Stripe rails. `CA-OPERATING` is the default settlement source cash account; record a deposit to the same cash account (or any other funded account) before testing settlement success.
- UI gotchas in scaled viewports: native mouse clicks on the `Deposit & Settlement` tab and the form buttons may not register. Work around by navigating to `javascript:showTab('deposit-settlement')` and calling `recordDsDeposit()` / `initiateDsSettlement()` / `reconcileDsOrder()` from the address bar after filling fields via `javascript:` URLs, e.g.:
  ```js
  javascript:(function(){
    el('ds-deposit-amount').value='1.23';
    el('ds-deposit-rail').value='stripe_treasury';
    el('ds-deposit-credit').value='PTC-DEPOSIT-CLEARING';
    el('ds-deposit-cash').value='CA-STRIPE-TREASURY';
    el('ds-deposit-ref').value='E2E-DEP-001';
    recordDsDeposit();
  })()
  ```
- Known UX note: when `initiateDsSettlement()` returns `status: 'manual'` with a manual clearing, the panel message reads `Manual prefund required: undefined` because the UI reads `res.data.instruction` but the engine returns the instruction inside `res.data.clearingResult.result.instruction`. The settlement and clearing rows are still created correctly.

## Trust-Portal Compliance / CIP (`/trust-portal/dashboard.html`)

- Backend: `server/integrations/compliance/customerIdentificationEngine.js`; routes in `server/routes/dapp.js`:
  - `GET /api/dapp/ptc/cip/records`
  - `POST /api/dapp/ptc/cip/records`
  - `POST /api/dapp/ptc/cip/records/:id/approve`
  - `POST /api/dapp/ptc/cip/records/:id/block`
  - `GET /api/dapp/ptc/cip/status`
- UI tabs are shown based on role; trustees see **Trustee Actions**, **Stripe Treasury**, and **Compliance**.
- Login is email/PIN via `/api/dapp/auth/send-code` and `/api/dapp/auth/verify`. When no email provider is configured, the PIN is displayed in the UI (`#status`) and can be entered.
- The **Compliance** tab contains:
  - `Download Compliance PDF` link → `/trust-portal/stripe-treasury-compliance-package.pdf`.
  - CIP / KYC onboarding form with `cip-name`, `cip-email`, etc.; `submitCip()` posts to `/api/dapp/ptc/cip/records`.
  - CIP records table `cip-records`, loaded by `loadCipRecords()` (calls the CIP GET route). It shows columns Name, Email, Status, Score, Actions.
- Environment flag for payout blocking: set `STRIPE_TREASURY_CIP_REQUIRED=true`. With this flag, `PtcPortalEngine.executeRequest()` blocks `stripe_*` rails when `CustomerIdentificationEngine.validatePayoutRecipient()` returns `valid: false` (no CIP record or status not `clear`).
- `createRecord` now defaults to `kyc_status: 'pending'` and only auto-clears when both `idVerificationProvider` and `idVerificationReference` are supplied and `ComplianceEngine.screen()` returns `clear`.
- `ptcPortalEngine.executeRequest` runs the CIP gate **before** `PrivateTrustCompanyEngine.createDistribution`/`redeemSupport`, so a blocked `stripe_*` payout leaves no `ptc_payouts` or ledger side effects.
- After a CIP record is cleared, re-executing the same `stripe_ach` request should no longer produce a `CIP required` error; it will fail at the next stage (e.g., `Stripe secret key not configured`) depending on environment.
- Trust-portal CIP table escapes HTML (`escapeHtml`) and uses `data-record-id` buttons with `addEventListener` instead of inline `onclick`. To test XSS handling, create a record whose `fullLegalName` contains `<b>` or `&` and confirm it is rendered as literal text, not HTML.
- Test CIP enforcement: beneficiary creates a support request (`POST /api/dapp/ptc/request`), two trustees approve (`POST /api/dapp/ptc/requests/:id/approve`), then a trustee executes with `rail=stripe_ach` and an email without an approved CIP record. Expect `success: false` and error containing `CIP required for Stripe Treasury payout`.
- Local DB gotcha: if `dapp_users` was created from an older migration, it may be missing `roles`, `active_role`, and `is_active` columns and the `role` check constraint can reject trustee roles. Run `DappEngine.ensureTables()` or `ALTER TABLE dapp_users ADD COLUMN ...` and `DROP CONSTRAINT IF EXISTS dapp_users_role_check` to unblock portal login.

## Treasury Prime rails (`/api/treasury-prime`)

- Backend only, no UI: `server/routes/treasuryPrime.js` + `server/integrations/treasuryprime/*`. Test with `curl`/node scripts, not the browser.
- Offline unit test (fetch stubbed, no network): `node server/integrations/treasuryprime/treasuryPrime.test.js` — prints `Treasury Prime validation passed`.
- Start the server with TP creds bound from secrets:
  ```bash
  set -a; . ./.env.bonds; set +a
  TREASURY_PRIME_API_KEY_ID=... TREASURY_PRIME_API_SECRET=... \
    ADMIN_SECRET_TOKEN=test-admin-token-123 PORT=3002 node server/server-3002.js
  ```
  Use `setsid nohup ... < /dev/null &` — a plain backgrounded `nohup` from the exec tool gets SIGTERM when the shell call ends, and the server logs `[shutdown] SIGTERM received`.
- Sandbox host is the default (`https://api.sandbox.treasuryprime.com`). Never set `TREASURY_PRIME_BASE_URL` to production. Keep test transfers ≤ $1.00.
- All routes need `x-admin-token: <ADMIN_SECRET_TOKEN>` except `POST /api/treasury-prime/webhooks/receive`; missing/wrong token returns 401 `Authentication required`.
- Webhook auth: only enforced when `TREASURY_PRIME_WEBHOOK_SECRET` is set — start a second server on another port (e.g. 3012) with that env var to test the 401 path without disturbing the main one. Header is `x-treasury-prime-secret` (query `?secret=` also accepted).
- Money invariant to check: every monetary field (`amount`, `balance`, `available_balance`, `current_balance`, `availableBalance`, `currentBalance`, `last_reconciled_balance`) must be a JSON **string** matching `^-?\d+\.\d{2}$`. A JSON walker over every read route is the fastest way to catch float leakage; Postgres NUMERIC columns come back as strings via `pg`.
- Reconciliation (`POST /accounts/:id/reconcile`) is stateful: it writes `treasury_prime_accounts.last_reconciled_balance`. The first call after a balance change posts a journal entry; the immediate second call returns `journalResult: "no-change"` with `drift: "0.00"`. To re-test the posting path, move money (a $1 book transfer) or reset `last_reconciled_balance`.
- Useful psql checks:
  ```sql
  SELECT id,kind,amount,status,hold_transaction_id,initiated_by FROM treasury_prime_transfers ORDER BY created_at DESC;
  SELECT id,event_type,object_id,status FROM treasury_prime_webhook_events ORDER BY received_at DESC;
  SELECT entry_id,account_code,debit_amount,credit_amount,memo FROM trust_journal_lines ORDER BY id;
  ```
- Note: `TrustAccountingEngine.postJournalEntry` internally balances with `parseFloat` and a $0.01 tolerance, so extreme-precision journal drift (many lines, >$0.01 accumulation) is a plausible weak spot to probe.

## Stablecoin distributor signing on a real Stellar testnet (`/api/stablecoin`, dashboard "Stablecoin Payments")

Use this to prove real on-chain settlement (not shadow mode) without touching mainnet or real funds.

- Signing goes through `server/integrations/stablecoin/walletSigner.js` (`STABLECOIN_SIGNER=env|vault|external`); `blockchainEngine.js` calls `signer.signTransaction(tx)`. Unit test: `node server/integrations/stablecoin/walletSigner.test.js`.
- Server env for a real testnet settle (start with `setsid nohup <script> > /tmp/sc-server.log 2>&1 < /dev/null & disown`, a plain background launch gets SIGTERM):
  ```bash
  STABLECOIN_ENABLED=true STABLECOIN_MODE=testnet STABLECOIN_NETWORK=testnet \
  STABLECOIN_ASSET_CODE=USDC STABLECOIN_SIGNER=env \
  HORIZON_URL=https://horizon-testnet.stellar.org FRIENDBOT_URL=https://friendbot.stellar.org \
  STABLECOIN_DISTRIBUTOR_SECRET=<throwaway testnet seed> \
  ADMIN_SECRET_TOKEN=test-admin-token-123 PORT=3002 node server/server-3002.js
  ```
  `STABLECOIN_MODE=shadow` returns fake `shadow-<ts>` hashes with `simulated:true` — it never proves signing, so always use `testnet`.
- Leave `STABLECOIN_ISSUER_PUBLIC`/`ISSUER_SECRET` unset: `getAsset()` then falls back to native XLM, so no trustline setup is needed even with `STABLECOIN_ASSET_CODE=USDC`. Generate keys with `sdk.Keypair.random()`, store seeds in mode-600 files (e.g. `/tmp/sc-keys/*.secret`), never echo them, and fund both accounts via `https://friendbot.stellar.org?addr=<pub>`.
- Fund the internal ledger before approving: credit `TREASURY_HOT` (e.g. 2000 cents) or approval fails with "Insufficient treasury balance".
- UI flow (dashboard → **Stablecoin Payments**): destination public key + amount + Asset `USDC` + Network `Stellar Testnet` → **Get Quote** → **Create Payment** → **Approve** (takes a hold of `total_cents`) → **Settle**. The payments table is at the very bottom of the page (`End` key); Approve/Settle buttons shift position after each refresh, so re-screenshot before clicking.
- After settle, verify on-chain, not just the UI:
  ```bash
  curl -s https://horizon-testnet.stellar.org/transactions/<hash> | jq '.successful,.ledger,.source_account,.signatures|length'
  curl -s https://horizon-testnet.stellar.org/transactions/<hash>/operations | jq '._embedded.records[]|{type,asset_type,amount,to}'
  curl -s https://horizon-testnet.stellar.org/accounts/<dest pub> | jq '.balances'
  ```
  A broken signer would fail submission with `tx_bad_auth`, so a `successful:true` tx with 1 signature and source == distributor public key is the decisive proof.
- Ledger check: `GET /api/stablecoin/treasury/TREASURY_HOT` (needs `x-admin-token`) — hold goes 0 → `total_cents` on approve and back to 0 on settle. Note settle debits only `amount_cents` (the fee portion of the hold is released, not captured) — that is existing `sourceOfFundsAdapter.post` behavior, not a regression.
- Mainnet custody guard: with `STABLECOIN_MODE/NETWORK=mainnet` and `STABLECOIN_SIGNER=env`, `createSigner`/`readiness`/`settle` all refuse with "Refusing to sign mainnet settlement…". Test it in an isolated node script that wraps `global.fetch` and asserts the recorded request list is empty — never against a live server. `STABLECOIN_ALLOW_ENV_KEY_MAINNET` is parsed by the repo-wide `bool()` helper, so it is case-insensitive (`TRUE` unlocks) but `1`/`yes`/`"true "` do not.
- Remote-signer stub for signature verification: point `STABLECOIN_SIGNER=external` + `STABLECOIN_SIGNER_URL` at a tiny local http server; it receives `{publicKey,network,algorithm,payloadBase64}` and must answer `{"signature":"<base64 64-byte sig>"}`. Also set `signerTimeoutMs`/`STABLECOIN_SIGNER_TIMEOUT_MS` in hand-built configs, otherwise the abort timer fires immediately and you get "timed out after undefinedms". A signature from the wrong keypair is rejected locally with "does not verify against the distributor public key".
- Leak check after any settle: `grep -c "$(cat /tmp/sc-keys/distributor.secret)" /tmp/sc-server.log` and `grep -oE '\bS[A-Z2-7]{55}\b'` over logs and captured responses; both should be 0.

## Agent mandates / spend limits (FinOps agent)

- Routes live on the dapp router mounted at `/api/dapp` (`server-3002.js:76`), so the endpoints are
  `/api/dapp/mandates`, `/api/dapp/mandates/decisions`, `/api/dapp/mandates/audit/verify`,
  `/api/dapp/mandates/:id/spend`, `/api/dapp/mandates/:id/status`, `/api/dapp/finops-ai/preview`.
- Auth: `requireAuth` (`server/integrations/auth/securityMiddleware.js:141-207`) accepts a JWT, an API key, or
  the legacy `x-admin-token` / `?adminToken=` value equal to `ADMIN_SECRET_TOKEN`. The legacy token maps to role
  `admin` (level 100), which satisfies both `adminAuth` and `operatorAuth` — one header covers every mandate
  route, and `?adminToken=…` lets you eyeball GET endpoints straight in the browser for recordings.
- Test mandates safely with `POST /api/dapp/finops-ai/preview {"prompt":"…"}`: it evaluates and logs a decision
  but never creates a task or moves value (verify with `select count(*) from finops_tasks`). `POST /mandates`
  always forces `agent: "finops"`, so previews and mandates line up automatically.
- Prompt parser (`finOpsAgent.js:125-190`): `pay|send|transfer` ⇒ action `payment`, the **first** number in the
  string ⇒ amount, a `USDC|ETH|…` token ⇒ asset, `0x` + 40 hex ⇒ destination. `Pay 100 USDC to 0xAAAA…0001` is
  the minimal allow-case prompt; put no other digits before the amount.
- Period spend only counts *consumed* decisions (`consumed = TRUE`, set by `executeTask` on
  `status === 'executed'`). To exercise cumulative `period_limit` without moving value, call
  `MandateEngine.markConsumed('<decisionId>')` from a node script and then re-preview. Pick amounts so the
  cumulative reason fires alone (e.g. 750.00 consumed + a 400.00 request under a 500.00 max / 1000.00 day cap),
  otherwise the max-amount reason masks it.
- Suspending/revoking a mandate makes the agent fall back to `escalate` with reason
  `no mandate on file for this agent` (inactive mandates are filtered out, `mandateEngine.js:82-86`) — assert
  "not allow" rather than a revoked-specific reason.
- Audit chain: `GET /mandates/audit/verify` → `{ok,verified,brokenAt}`. Prove it is real by editing a row
  (`UPDATE agent_mandate_decisions SET amount=1.00 WHERE id='MDEC-…'`) → `ok:false` with `brokenAt` naming the
  row, then restore the value → `ok:true`.
- All money fields come back as JSON decimal strings (`"500.00"`, `"750.00"`); a number in
  `max_amount`/`amount`/`spent` is a failure.
- `sendError` in `server/routes/dapp.js:51` returns **HTTP 500** for every error including validation
  ("status must be one of…", "payees is required"), so don't expect 400s from dapp routes.

## OS Engine Layer (PR #339)

The `devin/os-engines` branch adds `server/integrations/os/osEngine.js` with `BaseOSEngine` plus `BankEngine`, `TreasuryEngine`, `PaymentEngine`, `ClearingEngine`, `SettlementEngine`, `ComplianceEngine`, `SecurityEngine`, and `RestApiEngine`, all exposed through `/api/os`.

### Startup and env

- Start with the standard local Postgres + admin token env.
- `server/server-3002.js` calls `osEngine.ensureAll()` during startup. Verify log contains `[os-engines] all tables ensured` and `[dlbtrust-treasury] running on port 3002`.
- No extra env vars are required for shadow mode; engines fall back to shadow/ready when third-party keys are absent.

### End-to-end smoke test

Use `x-admin-token: dlb-admin-2026-trust` for all calls.

1. `GET /api/os` → expect 8 entries (bank, treasury, payment, clearing, settlement, compliance, security, rest-api), each `healthy: true`.
2. `GET /api/os/bank/status` and `/api/os/bank/health` → `success: true`, `data.healthy: true`, `data.engine: 'bank'`.
3. `POST /api/os/bank/process` with `{"action":"accounts","bankId":"..."}` → `success: true`, `data.eventId` present and an account list result. Without `bankId` it returns a shadow-mode note.
4. `POST /api/os/treasury/process` with `{"action":"position"}` → `success: true`, `data.result` contains position info (or `mode: 'shadow'` if unconfigured).
5. `POST /api/os/payment/process` with `{"action":"listMethods"}` → `success: true`, `data.result` (possibly an empty array in shadow/unconfigured mode).
6. `POST /api/os/compliance/process` with `{"action":"screen","subject":"ACME Corp"}` → `success: true`, `data.result` contains a compliance record with `screening_id`, `status`, `risk_score`, etc.
7. `POST /api/os/security/process` with `{"action":"audit","actor":"admin","resource":"/api/os","outcome":"allow"}` → `success: true`, `data.result.logged: true`.
8. `POST /api/os/rest-api/process` with `{"action":"metrics"}` → `success: true`, `data.result.totalEvents`, `perEngine`, `recent`, `activeApiKeys`.
9. `GET /api/os/bank/list` → array containing the bank event from step 3.
10. `GET /api/os/bank/get/<eventId>` → single `os_events` row matching the eventId.
11. `npm run lint` and `npm run typecheck` should exit `0`.

### What to watch for

- `os_events` and `os_audit_log` tables are created on startup. If `ensureAll()` fails, the `process` endpoints may fail to log or the `list`/`get` endpoints may return empty.
- `ComplianceEngine.screen` may create a row with `status: 'review'` and `risk_score` when only `subject` is provided.
- `npm run lint` may still show many pre-existing `no-unused-vars` warnings across other files, but the OS engine files should be clean.

## Wallet On-Ramp OS Engine (PR #350)

The `devin/wallet-onramp-sourceofunds` branch adds `WalletOnRampEngine` (`wallet-onramp`) and `AlchemyWalletEngine` (`alchemy-wallet`) to `server/integrations/os/osEngine.js` and exposes them through `/api/os` and `public/os-engine-dashboard.html`.

### Startup and env

- Start with the standard local Postgres + admin token env.
- Set `DAPP_CHAIN_ID=8453` (Base mainnet) and a real `ALCHEMY_API_KEY` for live balance reads.
- The server must have already ensured `wallet_onramp_requests` and `alchemy_wallet_funding_requests` tables via `osEngine.ensureAll()`.
- The flow is shadow/manual by default; no real on-chain value moves.

### End-to-end verification

Use `x-admin-token: dlb-admin-2026-trust` for all calls.

1. `GET /api/os` → expect 17 entries including `wallet-onramp` and `alchemy-wallet`, both `healthy: true`.
2. `POST /api/os/wallet-onramp/process` action `fund` with the cash source:
   ```json
   {
     "action": "fund",
     "sourceType": "cash",
     "sourceAccountId": "CA-BOND-PROCEEDS",
     "amount": 0.01,
     "asset": "USDC",
     "targetAddress": "0x69a32f285ced1dbf102c7baedf0266f1d39580a1",
     "sourceMethod": "manual"
   }
   ```
   Expected: `success: true`, `data.result.operationId` starts with `WOR-`, `data.result.status` is `awaiting_deposit`, and `data.result.instructions` contains `Deposit 0.010000 USDC on Base mainnet to 0x69a32f285ced1dbf102c7baedf0266f1d39580a1`.
3. `POST /api/os/alchemy-wallet/process` action `getBalances`:
   ```json
   {"action": "getBalances", "address": "0x62EE94918C008849fDebe69651174334841E1ABd"}
   ```
   Expected: `data.result.chain` is `8453`, `data.result.usdc.tokenAddress` is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, `data.result.rpcUrl` contains `base-mainnet.g.alchemy.com/v2/` and **not** the raw API key, and `data.result.native.symbol` is `ETH`.
4. Operator dashboard at `/os-engine-dashboard.html`:
   - Registry shows cards for `wallet-onramp` and `alchemy-wallet` with `HEALTHY` badges.
   - `Process Action` engine dropdown contains both engines.
   - Selecting `wallet-onramp` reveals action `fund`; selecting `alchemy-wallet` reveals action `getBalances`.
   - `Event Log` shows `Wallet On-Ramp` and `Alchemy Wallet` buttons and lists the corresponding `os_events` rows.
5. `npm run lint` and `npm run typecheck` should exit `0`.
6. `node server/scripts/osEngineSmokeTest.js` should pass (70/70) and include `wallet-onramp: process fund` and `alchemy-wallet: process getBalances`.

### What to watch for

- If `ALCHEMY_API_KEY` is missing, `alchemy-wallet` `getBalances` falls back to the public Base RPC and still returns `chain: 8453` but `balance` will be `0` (no live Alchemy call).
- The dashboard's `Run` button and payload textarea can be hard to interact with via scaled coordinate tools. Use `document.getElementById('proc-payload').value` and `runProcess()` in the browser console if UI typing is not registering, then click the `Run` button.
- Rapid repeated `process` calls can trigger the server's `Too many write operations. Please slow down.` rate limit. Wait 30–60 s between bursts or rely on the `osEngineSmokeTest.js` output for the final assertion.

## Devin Secrets Needed

- `DATABASE_URL` or local Postgres credentials (`dlbtrust`/`dlbtrust`).
- `JWT_SECRET` and `ADMIN_SECRET_TOKEN` for stable auth.
- `secret:org:HEDERA_OPERATOR_KEY` — only needed for live (non-shadow) Hedera tests.
- `secret:org:DLBTRUST_API_KEY` — for programmatic API access if enabled.
- `secret:org:FLY_API_TOKEN` — needed for `flyctl deploy` and `flyctl secrets set` against `dlbtrust-app`.
- `TREASURY_PRIME_API_KEY_ID` / `TREASURY_PRIME_API_SECRET` — Treasury Prime sandbox Basic-auth credentials, required for any `/api/treasury-prime` live testing.
- `ALCHEMY_API_KEY` — only needed to exercise the live Alchemy Base RPC balance call; the dashboard/engine still work in shadow/fallback mode without it.

## Melio B2B OS Engine (PR #351)

The `devin/moonpay-cli-onramp` branch adds `MelioEngine` (`melio`) to `server/integrations/os/osEngine.js` and registers it at `/api/os/melio`. It also adds `public/os-engine-dashboard.html` wiring and the CLI helper `server/scripts/sendB2BPaymentViaMelio.js`.

### Startup and env

- Start with the standard local Postgres + admin token env.
- No `MELIO_API_KEY` is needed; the engine runs in shadow/demo mode by default.
- Trust account `1200` has sufficient balance for shadow `$100` test payments; cash sources can also be used.
- The server must call `osEngine.ensureAll()` on startup to create `melio_payments`. If the table is missing, restart the server.

### End-to-end verification

Use `x-admin-token: dlb-admin-2026-trust` for all calls.

1. `GET /api/os` → expect 21 engines including `melio` with `healthy: true` and `mode: 'shadow'`.
2. `POST /api/os/melio/process` action `status` with `{}` → `success: true`, `data.result.mode` is `shadow`, `healthy` is `true`.
3. `POST /api/os/melio/process` action `listVendors` with `{}` → `success: true`, `data.result.data` contains a shadow vendor record.
4. `POST /api/os/melio/process` action `schedulePayment`:
   ```json
   {
     "action": "schedulePayment",
     "amount": 100,
     "sourceType": "trust",
     "sourceAccountId": "1200",
     "vendor": {
       "name": "Vendor Inc",
       "email": "pay@example.com",
       "address": { "line1": "123 Main St", "city": "Austin", "state": "TX", "postalCode": "78701", "country": "US" },
       "bankAccount": { "accountNumber": "000123456789", "routingNumber": "111000025", "accountType": "checking" }
     },
     "deliveryMethod": "ach",
     "memo": "B2B vendor payout"
   }
   ```
   Expected: `success: true`, `data.result.id` starts with `MEL-`, `data.result.status` is `scheduled`, `data.result.instructions` is non-empty.
5. CLI script:
   ```bash
   ADMIN_SECRET_TOKEN=dlb-admin-2026-trust node server/scripts/sendB2BPaymentViaMelio.js \
     --amount 0.01 --sourceAccountId 1200 --sourceType trust \
     --vendorName "Test Vendor" --routing 111000025 --account 000123456789
   ```
   Expected exit `0`, `success: true`, and a `MEL-` payment record.
6. Operator dashboard at `/os-engine-dashboard.html`:
   - Registry shows a `melio` card with `healthy` badge.
   - `Process Action` engine dropdown contains `melio` and the action dropdown contains `schedulePayment`.
   - `Autofill Sample` populates `vendor`, `bankAccount`, `routingNumber`, and `accountNumber`.
   - `status`, `listVendors`, and `schedulePayment` run successfully from the UI.
   - `Event Log` contains a `Melio B2B` button and lists `melio` events.
7. `npm run lint` and `npm run typecheck` should exit `0`.
8. `node server/scripts/osEngineSmokeTest.js` should report `85/87` passed with all `melio` steps green. The two expected failures are `alchemy-wallet: send` and `tokenization: execute`.

### What to watch for

- The dashboard `Run` button and payload textarea may not register scaled coordinate typing. Set `document.getElementById('proc-payload').value` and/or `proc-engine`/`proc-action` values via the browser console, then click `Run`.
- The dashboard `runProcess` builds the request as `{ action, ...payload }`, so if the payload itself contains an `action` field it will override the Action dropdown selection. Clear the payload to `{}` when testing `status` or `listVendors`.
- Shadow-mode `schedulePayment` returns `reserveId: null`; the `instructions` string will say `Reserve null will be posted when payment completes.` This is expected when no live Melio API key is configured.

## PTC Bank OS Engine (PR #351 ptc-bank update)

The `devin/moonpay-cli-onramp` branch also adds `PtcBankEngine` (`ptc-bank`) to `server/integrations/os/osEngine.js` and registers it at `/api/os/ptc-bank`. It wraps `TrustBankEngine` and exposes customer/account/deposit/transfer/payment actions. The CLI helper is `server/scripts/sendPaymentViaPtcBank.js` and the dashboard adds a `PTC Bank` event-log button.

### Startup and env

- Start with the standard local Postgres + admin token env.
- No `PTC_BANK_*` env vars are required for shadow mode; `PTC_BANK_LIVE` defaults to `false`.
- `PtcBankEngine.ensureTables()` calls `TrustBankEngine.ensureTables()` and creates `trust_bank_customers`, `trust_bank_accounts`, `trust_bank_payments`, and `trust_bank_transactions`.

### End-to-end verification

Use `x-admin-token: dlb-admin-2026-trust` for all calls.

1. `GET /api/os` → expect 22 engines including `ptc-bank` with `healthy: true` and `mode: 'shadow'`.
2. `GET /api/os/ptc-bank/status` → `success: true`, `data.healthy: true`, `data.mode: 'shadow'`, `data.internalBank: true`, `data.rails.bookTransfer: true`.
3. Dashboard `/os-engine-dashboard.html`:
   - Registry shows `ptc-bank` healthy.
   - `Process Action` engine dropdown contains `ptc-bank`; action dropdown contains `createCustomer`, `createAccount`, `deposit`, `internalTransfer`, `originatePayment`, etc.
   - `Autofill Sample` for `ptc-bank`/`createCustomer` populates `name`, `email`, `phone`.
   - Run `createCustomer`, `createAccount` (twice for checking + savings), `deposit`, `internalTransfer`, and `originatePayment` (rail `book_transfer`).
   - Expected IDs: `customer_id` starts with `TBC-`, `account_id` starts with `TBA-`, internal-transfer and payment IDs start with `TBP-`.
   - `originatePayment` should return `status: 'pending'`, `rail: 'book_transfer'`, and instructions containing `Book transfer ... originated for $...`.
4. CLI script (expected to work; if it fails with `createCustomer did not return customer_id`, the script is not reading the nested `data.result` response shape — see below):
   ```bash
   ADMIN_SECRET_TOKEN=dlb-admin-2026-trust node server/scripts/sendPaymentViaPtcBank.js \
     --action full --name "PTC Test Customer" --accountName "PTC Checking" --amount 10 \
     --routing 111000025 --account 000123456789 --payeeName "Test Vendor" --rail book_transfer
   ```
   Expected: exit `0`, a `TBC-` customer, a `TBA-` account, a deposit, and a `TBP-` payment ID.
5. `npm run lint` and `npm run typecheck` exit `0`.
6. `node server/scripts/osEngineSmokeTest.js` passes all `ptc-bank` steps; the only expected failures are `alchemy-wallet: send` and `tokenization: execute`.

### What to watch for

- The CLI script `sendPaymentViaPtcBank.js` as of the tested commit parses `customer.data.customer_id`, `account.data.account_id`, and `paymentResult.data.paymentId`, but the `/api/os/ptc-bank/process` response is wrapped as `{ success: true, data: { success: true, engine, action, eventId, result: { ... } } }`. The script needs to read `data.result.customer_id`, `data.result.account_id`, and `data.result.paymentId` (or handle both shapes).
- The dashboard `Run` button may not register scaled coordinate typing. Set `proc-engine`, `proc-action`, and `proc-payload` values via the browser console, then click `Run`.
- The dashboard `runProcess` builds the request as `{ action, ...payload }`. If the payload contains an `action` field, it overrides the dropdown; keep them matching.
- `deposit` returns `{ account: { ... }, transaction_id: <accountId> }` (transaction_id mirrors account_id in the current implementation).

## Programmable Money Engine (PR #331)

- Endpoints (all require an admin/operator JWT, e.g. from `/api/auth/login`):
  - `GET /api/programmable-money/programs`
  - `POST /api/programmable-money/programs`
  - `GET /api/programmable-money/programs/<id>`
  - `POST /api/programmable-money/programs/<id>/approve`
  - `POST /api/programmable-money/programs/<id>/reject`
  - `POST /api/programmable-money/programs/<id>/trigger`
  - `GET /api/programmable-money/runs`
  - `GET /api/programmable-money/runs/<id>`
- There is no dashboard UI for these endpoints yet; test via `curl`/HTTP client.
- Start the server with `ADMIN_SECRET_TOKEN` and `TRUST_CHECKER_ADMIN_PASSWORD` to seed the checker admin user (`dbarkley1130@gmail.com` / `test-admin-token-123` by default) with role `admin`.
- End-to-end smoke test:
  ```bash
  TOKEN=$(curl -s -X POST http://localhost:3002/api/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"username":"dbarkley1130@gmail.com","password":"test-admin-token-123"}' | jq -r .token)
  PROG=$(curl -s -X POST http://localhost:3002/api/programmable-money/programs \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"name":"E2E Test Program","description":"convert to USDC","sourceType":"wallet","sourceAccount":"wallet-1","sourceToken":"USDT","amount":100,"targetAsset":"USDC","action":"convert"}' | jq -r .data.programId)
  curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3002/api/programmable-money/programs | jq
  curl -s -X POST "http://localhost:3002/api/programmable-money/programs/$PROG/approve" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"role":"checker","approverEmail":"dbarkley1130@gmail.com"}' | jq
  curl -s -X POST "http://localhost:3002/api/programmable-money/programs/$PROG/trigger" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"trigger":"manual"}' | jq
  curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3002/api/programmable-money/runs | jq
  ```
- In dev without `DAPP_PRIVATE_KEY`, the trigger reaches `CanonicalMoneyEngine` and fails with `DAPP_PRIVATE_KEY not configured`. The endpoint returns HTTP 400, `success: false`, and the run record is persisted with `status: failed` and `result.error` containing `DAPP_PRIVATE_KEY`.
- If `STABLECOIN_DEX_SHADOW=true` or a valid `DAPP_PRIVATE_KEY` is present, the engine will instead attempt live/sepolia DEX execution; set `STABLECOIN_DEX_SHADOW=true` for safe local shadow execution.

## PTC Treasury / Wire Interest Payment (PR #353 wire-PTC-bank-interest)

The `wire-PTC-bank-interest` branch extends `PtcTreasuryEngine` (`ptc-treasury`) and `PtcBankEngine` (`ptc-bank`) to originate real fiat wire transfers for interest payments. `PtcTreasuryEngine._distribute` with `rail: 'wire'` maps an income/liability/equity source GL account (e.g. `4000` Interest Income) to the accrued-interest asset account `1200`, funds the internal PTC bank account from cash account `1010`, and then calls `PtcBankEngine` `originatePayment` + `sendPayment` with `rail: 'wire'`. `TrustBankEngine.sendPayment` invokes `WireEngine.initiateWire` + `WireEngine.sendWire`, which posts a GL entry and writes wire message artifacts to `data/wire-messages/<wire_id>.json` and `.pacs.008.xml`.

### Startup and env

- Start with the standard local Postgres + admin token env.
- Set `PTC_BANK_LIVE=true` and `PTC_TREASURY_LIVE=true` to exercise the live wire path (the transmission is still simulated locally; no real Fedwire call is made unless `SystemSettings` returns a production `wireEndpoint`).
- `WireEngine` creates `wire_transfers` and `wire_audit_log` tables.

### End-to-end verification

Use `x-admin-token: dlb-admin-2026-trust` for all calls.

1. `GET /api/os` → expect `ptc-bank`, `ptc-treasury`, and `settlement-endpoint` engines `healthy: true`.
2. `GET /api/os/ptc-treasury/status` → `mode: 'live'` when `PTC_TREASURY_LIVE=true`.
3. `npm run lint` and `npm run typecheck` exit `0`.
4. `node server/scripts/osEngineSmokeTest.js` → all `ptc-bank`, `ptc-treasury`, and `settlement-endpoint` steps pass. The only expected failures are `alchemy-wallet: send` and `tokenization: execute`.
5. Existing manual wire verification:
   - `trust_bank_payments.payment_id = 'TBP-1786921825782-PTV4A4'` exists, `status = 'completed'`, `external_tx_id = 'WIRE-20260816-8YTIL9'`, `amount_cents = 500000`, `rail = 'wire'`, `raw_message` non-null.
   - `wire_transfers.wire_id = 'WIRE-20260816-8YTIL9'` exists, `status` in (`confirmed`, `settled`), `amount_cents = 500000`, `payment_type = 'interest_payment'`, beneficiary `DB NET MGMT` at Lili Bank routing `121145307` / account `692101092959`.
   - Artifacts `data/wire-messages/WIRE-20260816-8YTIL9.json` and `.pacs.008.xml` exist and are well-formed.
   - GL impact of the wire (funding + send, ignoring the reversal of the replaced ACH payment): `1010` cash unchanged net, `1200` Accrued Interest Receivable down $5,000, `4000` Interest Income down $5,000.
6. Optional tiny distribution API test:
   ```bash
   curl -s -X POST http://localhost:3002/api/os/ptc-treasury/process \
     -H 'Content-Type: application/json' \
     -H 'x-admin-token: dlb-admin-2026-trust' \
     -d '{
       "action": "distribute",
       "rail": "wire",
       "amount": 0.01,
       "sourceAccountId": "4000",
       "sourceType": "trust",
       "fromAccountId": "<active-ptc-checking-account-id>",
       "payee": { "name": "Test Payee", "bankName": "Test Bank", "routing": "111000025", "account": "000987654321" },
       "description": "PR353 tiny wire test",
       "autoSend": true
     }'
   ```
   Expected: `data.result.status` is `completed`, `data.result.sent.externalTxId` starts with `WIRE-`, a new `trust_bank_payments` row for `amount_cents = 1`, and a new `wire_transfers` row for `amount_cents = 1`. The GL impact should mirror the $5,000 wire scaled to the tiny amount (`1200` and `4000` each down by the amount, `1010` unchanged net).

### What to watch for

- `PtcBankEngine.process` returns `{ success: true, engine, action, eventId, result }` at the top level (not nested under `data.result`). Scripts calling it directly should read `res.result`.
- `WireEngine.sendWire` marks wires `confirmed` when `SystemSettings.get('auto_settle')` is `'true'`; otherwise `sent`. `TrustBankEngine.sendPayment` maps both to `completed` for `trust_bank_payments`.
- The `ptc-treasury` `distribute` action with an income/liability/equity `sourceAccountId` (like `4000`) internally substitutes `1200` as the balance-sheet cash source and posts `debit 1010 / credit 1200` before the wire. The wire send then posts `debit 4000 / credit 1010`.
- If the `fromAccountId` has no `linked_trust_account_code`, the default `PTC_BANK_GL_ACCOUNT` (or `1010`) is used for the funding journal.
- `data/wire-messages/` is created automatically; the JSON artifact is `WireEngine.formatWireMessage(wire)` and the XML artifact is a manually generated `pacs.008.001.08` document.

## Moov Paygate OS Engine (`devin/moov-paygate-os-engine`)

The `devin/moov-paygate-os-engine` branch adds `MoovPaygateEngine` (`moov-paygate`) to `server/integrations/os/osEngine.js` and registers it at `/api/os/moov-paygate`. It supports `status`, `health`, `createCustomer`, `createAccount`, `createTransfer`, `getTransfer`, `cancelTransfer`, `triggerCutoff`, `webhook`, and `sendPayment` actions. `PtcBankEngine`/`PtcTreasuryEngine`/`TrustBankEngine` accept the `moov_paygate` rail, and `server/scripts/sendPtcMoovPaygatePayment.js` provides a CLI for one-shot PTC interest payments.

### Startup and env

- Start with the standard local Postgres + admin token env.
- Set `MOOV_PAYGATE_LIVE=false` (or leave it unset) for shadow mode. In shadow mode the engine creates synthetic `MOOV-CUST-*` / `MOOV-ACCT-*` / `MOOV-TX-*` IDs and does not call real Moov Paygate services.
- To test the PTC-treasury distribution, set `PTC_BANK_LIVE=true`, `PTC_TREASURY_LIVE=true`, `PTC_BANK_NAME='DLB Trust PTC Bank'`, `PTC_BANK_ROUTING=121145307`, and `PTC_BANK_SETTLEMENT_ACCOUNT` to an active PTC bank account number.
- The server must call `osEngine.ensureAll()` on startup to create `moov_paygate_parties` and `moov_paygate_transfers`.

### End-to-end verification

Use `x-admin-token: dlb-admin-2026-trust` for all calls.

1. `GET /api/os/moov-paygate/status` → `success: true`, `data.healthy: true`, `data.mode: 'shadow'`.
2. `POST /api/os/moov-paygate/process` action `sendPayment` with source/destination `routingNumber`/`accountNumber` and `amount: 0.01`:
   ```json
   {
     "action": "sendPayment",
     "amount": 0.01,
     "source": { "name": "PTC Smoke Origin", "routingNumber": "111000025", "accountNumber": "000123456789", "accountType": "checking", "customerType": "business" },
     "destination": { "name": "DB NET MGMT", "routingNumber": "121145307", "accountNumber": "692101092959", "accountType": "checking", "customerType": "individual" },
     "description": "Moov Paygate tiny shadow test",
     "sameDay": false,
     "triggerCutoff": false
   }
   ```
   Expected: `success: true`, `data.result.transferId` starts with `MOOV-TX-`, `status: 'originated'`, `shadow: true`.
3. CLI script:
   ```bash
   ADMIN_SECRET_TOKEN=dlb-admin-2026-trust \
   PTC_BANK_LIVE=true PTC_TREASURY_LIVE=true \
   PTC_BANK_NAME='DLB Trust PTC Bank' PTC_BANK_ROUTING=121145307 \
   PTC_BANK_SETTLEMENT_ACCOUNT=<active-ptc-checking> \
     node server/scripts/sendPtcMoovPaygatePayment.js \
     --amount 0.01 --sourceAccountId 4000 --routing 121145307 --account 692101092959 \
     --name "DB NET MGMT" --bankName "Lili Bank" \
     --senderRouting 111000025 --senderAccount 000123456789
   ```
   Expected: exit `0`, `success: true`, a `TBP-` payment record with `rail = 'moov_paygate'`, and a `MOOV-TX-*` `external_tx_id`. GL impact should be `1010` unchanged net, `1200` and `4000` each reduced by the amount (interest-income distribution flow).
4. Operator dashboard at `/os-engine-dashboard.html`:
   - Registry shows a `moov-paygate` card with `healthy` badge and `mode: shadow`.
   - `Process Action` engine dropdown contains `moov-paygate`; action dropdown contains `sendPayment`.
   - `Autofill Sample` populates source/destination `routingNumber`/`accountNumber` fields.
   - `sendPayment` with a 0.01 USD payload runs successfully and returns a `MOOV-TX-*` transferId.
   - `Event Log` contains a `Moov Paygate` button and lists `moov-paygate` events.
5. `npm run lint` and `npm run typecheck` exit `0`.
6. `node server/scripts/osEngineSmokeTest.js` should pass the `moov-paygate` steps. The expected failures remain `alchemy-wallet: send` and `tokenization: execute`.

### What to watch for

- The dashboard `Run` button and payload textarea may not register scaled coordinate typing. Set `document.getElementById('proc-payload').value` and/or `proc-engine`/`proc-action` values via the browser console, then click `Run`.
- The dashboard `runProcess` builds the request as `{ ...payload, action }`, so the Action dropdown always overrides an `action` field in the payload; keep them consistent.
- In shadow mode, `MoovPaygateEngine._createTransfer` returns `status: 'originated'`, not `completed`. `TrustBankEngine.sendPayment` preserves that status for `moov_paygate` rail payments, so `trust_bank_payments` will show `originated` until a real Paygate webhook/settlement advances it.
- The CLI script uses `PtcTreasuryEngine.process` directly (not the HTTP API) and requires `PTC_BANK_LIVE`/`PTC_TREASURY_LIVE` env vars in the shell, or a `.env` file with those values.

## Apache APISIX OS Engine (`devin/apisix-gateway` / PR #357)

The `devin/apisix-gateway` branch adds `ApacheApisixEngine` (`apisix`) to `server/integrations/os/osEngine.js` and registers it at `/api/os/apisix/process`. It supports `status`, `health`, `sendPayment`, `sendWire`, `sendPush`, and `pushToCard` actions and is intended as a fiat payout rail for PTC treasury distributions. `PtcTreasuryEngine._normalizePtcBankRail` accepts `rail: 'apisix'` and routes it through `PtcBankEngine` (`fundFromSource` → `originatePayment` → `sendPayment`) then `TrustBankEngine.sendPayment` for the `apisix` rail. The CLI script is `server/scripts/sendPtcApacheApisixPayment.js`.

### Startup and env

- Start with the standard local Postgres + admin token env.
- Set `APISIX_LIVE=false` (or leave it unset) for shadow/simulated mode. In shadow mode the engine skips live HTTP calls to `http://localhost:9080` and returns synthetic `APISIX-TX-*` transfer IDs with `status: 'originated'`.
- For PTC-treasury distribution tests, set `PTC_BANK_LIVE=true`, `PTC_TREASURY_LIVE=true`, `PTC_BANK_NAME='DLB Trust PTC Bank'`, `PTC_BANK_ROUTING=121145307`, and `PTC_BANK_SETTLEMENT_ACCOUNT` to an active PTC checking account.
- The server must call `osEngine.ensureAll()` on startup to create the `apisix` events table and schema.

### End-to-end verification

Use `x-admin-token: dlb-admin-2026-trust` for all API calls.

1. `GET /api/os/apisix/status` → `success: true`, `data.healthy: true`, `data.mode: 'shadow'`.
2. `POST /api/os/apisix/process` action `sendPayment` with source/destination `routingNumber`/`accountNumber` and `amount: 0.01`:
   ```json
   {
     "action": "sendPayment",
     "amount": 0.01,
     "source": { "name": "PTC Smoke Origin", "routingNumber": "111000025", "accountNumber": "000123456789", "accountType": "checking", "customerType": "business" },
     "destination": { "name": "DB NET MGMT", "routingNumber": "121145307", "accountNumber": "692101092959", "accountType": "checking", "customerType": "individual" },
     "description": "Apache APISIX tiny shadow test",
     "type": "wire"
   }
   ```
   Expected: `success: true`, `data.result.transferId` starts with `APISIX-TX-`, `status: 'originated'`, `shadow: true`.
3. CLI script:
   ```bash
   ADMIN_SECRET_TOKEN=dlb-admin-2026-trust \
   PTC_BANK_LIVE=true PTC_TREASURY_LIVE=true \
   PTC_BANK_NAME='DLB Trust PTC Bank' PTC_BANK_ROUTING=121145307 \
   PTC_BANK_SETTLEMENT_ACCOUNT=<active-ptc-checking> \
     node server/scripts/sendPtcApacheApisixPayment.js \
     --amount 0.01 --sourceAccountId 4000
   ```
   Expected: exit `0`, `success: true`, a `TBP-` payment record with `rail = 'apisix'`, and an `APISIX-TX-*` `external_tx_id`. GL impact should be `1010` unchanged net, `1200` and `4000` each reduced by the amount (interest-income distribution flow).
4. Operator dashboard at `/os-engine-dashboard.html`:
   - Registry shows an `apisix` card with `healthy` badge and `mode: shadow`.
   - `Process Action` engine dropdown contains `apisix`; action dropdown contains `status`, `health`, `sendPayment`, `sendWire`, `sendPush`.
   - `ptc-treasury` → `distribute` with `rail: 'apisix'`, `sourceType: 'trust'`, `sourceAccountId: '4000'`, `autoSend: true`, and a payee object with `routing`/`account`/`name`/`bankName` successfully creates an `APISIX-TX-*` `externalTxId`.
   - `Event Log` contains an `apisix` button and lists `apisix` events.
5. `npm run lint` and `npm run typecheck` exit `0`.
6. `node server/scripts/osEngineSmokeTest.js` should pass the `apisix` status and sendPayment steps. The expected failures remain `alchemy-wallet: send` and `tokenization: execute`.

### Gateway config spot-check

Run `grep -E '^\s+uri:' docker/apisix/apisix.yaml` and confirm only `/ptc/wire` and `/ptc/push` are exposed and no `/api/os/*` route exists.

### What to watch for

- In shadow mode `ApacheApisixEngine._sendPayment` now returns `status: 'completed'` (as of PR #357 fix). `TrustBankEngine.sendPayment` records a `bank_transfers` row with `rail: 'apisix'` and the same `external_tx_id` for `rail === 'apisix'`.
- If `bank_transfers` inserts fail, verify `BankTransferEngine.ensureTables()` ran at startup (it drops and re-adds the `bank_transfers_rail_check` constraint to include `'apisix'`).
- The Fly deploy `https://dlbtrust-app.fly.dev` often lags the local branch and may not show the `apisix` engine; if `GET /api/os/apisix/status` returns `404` and the dashboard registry omits `apisix`, Fly has not been deployed with this branch yet.
- The dashboard `Run` button and payload textarea may not register scaled coordinate typing. Set `document.getElementById('proc-payload').value` and `proc-engine`/`proc-action` values via the browser console, then click `Run`.

## Melio Vendor Invoice / CSV Distribution (PR #361)

The `devin/melio-vendor-invoice-1787071715` branch adds a vendor-payments → `MelioEngine.exportPayment` workflow. `VendorEngine` supports `payment_method: 'melio'`, `processPayment`, `settleMelioPayment`, and CSV/email notifications. `MelioEngine.exportPayment` (shadow mode, no `MELIO_API_KEY`) writes a CSV to `data/melio-exports/` and posts a source → `2100` Fees Payable GL journal entry. Settlement posts `2100` → `1000` Trust Cash and logs buyer/seller notification emails (or falls back to `sent: false, provider: 'log'` when SMTP/SendGrid is not configured). Dashboard sections: **One-Click Melio CSV Distribution**, **Melio Invoice Sync (DB NET MGMT)**, and **Settle Melio Payment**.

### Startup and env

```bash
cd /home/ubuntu/repos/dlbtrust-app
nohup env \
  DATABASE_URL=postgres://dlbtrust:dlbtrust@localhost:5432/dlbtrust \
  JWT_SECRET=<any-stable-secret> \
  ADMIN_SECRET_TOKEN=dlb-admin-2026-trust \
  MELIO_PAY_BILLS_EMAIL=deandrealavarbarkleysolep_1663@invoicesmelio.com \
  MELIO_PAYABLES_GL_ACCOUNT=2100 \
  MELIO_POST_PAYABLE_GL=true \
  PORT=3002 \
  node server/server-3002.js > /tmp/server-3002-pr361.log 2>&1 &
disown
```

### End-to-end verification

1. Static checks:
   ```bash
   npm run lint
   npm run typecheck
   node server/scripts/osEngineSmokeTest.js
   ```
   Expected: lint/typecheck exit `0`; smoke test `115/117` passed (only `alchemy-wallet: send` and `tokenization: execute` fail).

2. CLI invoice + settle:
   ```bash
   # IMPORTANT: `testDbNetMgmtInvoice.js` parseArgs treats every flag as a key/value pair,
   # so pass `--process true --settle true` instead of bare `--process --settle`.
   ADMIN_SECRET_TOKEN=dlb-admin-2026-trust \
   MELIO_PAY_BILLS_EMAIL=deandrealavarbarkleysolep_1663@invoicesmelio.com \
     node server/scripts/testDbNetMgmtInvoice.js \
     --amount 0.01 --sourceAccountId 4000 \
     --process true --settle true \
     --buyerEmail admin@example.com --sellerEmail vendor@example.com
   ```
   Expected: vendor DB NET MGMT created/found with routing `121145307`, account `692101092959`, bank `Lili Bank`, `accountType: 'checking'`; payment reaches `status: 'settled'`; `melio_export_id` starts with `MEL-`; CSV path under `data/melio-exports/`; export GL `4000` → `2100` and settlement GL `2100` → `1000`.

3. CSV content check:
   ```bash
   ls -1 data/melio-exports/melio-export-MEL-*.csv | tail -1
   cat data/melio-exports/melio-export-MEL-*.csv | tail -1
   ```
   Expected columns: `VendorName,Amount,InvoiceNumber,DueDate,BillDate,Memo,Email,Address,RoutingNumber,AccountNumber,AccountType,BankName`; `VendorName` = `DB NET MGMT`, `Amount` = `0.01`, `RoutingNumber` = `121145307`, `AccountNumber` = `692101092959`, `BankName` = `Lili Bank`, `AccountType` = `checking`, dates in `YYYY-MM-DD`.

4. Dashboard (`/os-engine-dashboard.html`):
   - Set admin token `dlb-admin-2026-trust`.
   - **One-Click Melio CSV Distribution**: amount `0.01`, source GL `4000`, click **Send Melio CSV Distribution**. Response: `success: true`, `MEL-` export id, CSV path, `journalEntryId`.
   - **Melio Invoice Sync (DB NET MGMT)**: amount `0.01`, source GL `4000`, buyer `admin@example.com`, seller `vendor@example.com`, click **Submit Invoice & Sync**. Response: vendor payment `VPAY-*`, `melio_export_id`, `csv_path`, `journal_entry_id`.
   - **Settle Melio Payment**: paste the payment id, settlement ref, same buyer/seller emails, click **Settle & Notify**. Response: `status: 'settled'`, `journal_entry_id`, `csv_path`, `notifications` array (log fallback `sent: false`).

### What to watch for

- `testDbNetMgmtInvoice.js` does not parse bare boolean flags; use explicit truthy values (`--process true --settle true`) or call `VendorEngine.processPayment`/`settleMelioPayment` directly.
- `settleMelioPayment` tries to insert a `cashflow_events` row; if the table does not exist it logs a non-fatal warning and continues.
- The dashboard buttons may not respond to scaled-coordinate mouse clicks; invoke the underlying handlers via the browser console (`submitMelioInvoiceAndSync()` and `settleMelioPayment()`) and click **Set Token** first so the `x-admin-token` is set.
- `EmailEngine` attachment support only sends attachments when a real SMTP/SendGrid provider is configured; the `log` provider returns `sent: false` with the notification metadata.

## Camel family-bank integration context + OpenACH rail (PR #421, `server/integrations/camel`, `server/integrations/openach`)

Backend-only feature: `/api/camel` and `/api/openach-rail` routers mounted in `server/server-3002.js`,
Postgres tables `camel_exchanges` and `ihb_openach_dispatches`, CLI `node server/scripts/camelBus.js`.

### Boot

```bash
setsid nohup env DATABASE_URL=postgres://dlbtrust:dlbtrust@localhost:5432/dlbtrust \
  JWT_SECRET=dev-jwt-secret ADMIN_SECRET_TOKEN=dlb-admin-2026-trust \
  PAYMENT_DATA_ENCRYPTION_KEY=$(openssl rand -hex 32) DAPP_OTP_ALWAYS_SHOW_CODE=true \
  PORT=3002 node server/server-3002.js > /tmp/camel-server.log 2>&1 < /dev/null & disown
grep -E '\[camel\]|\[openach-rail\]|running on port' /tmp/camel-server.log
```
Expect `[camel] loaded`, `[openach-rail] loaded`, `[camel] context driving every 60s`. Any
`[camel] init:` line means table creation or flow install failed.

### Auth on the new routers

Both routers go through `ZeroTrustGateway`. Unauthenticated → HTTP 401
`{"success":false,...,"code":"IHB_NO_CREDENTIAL"}` (never 500). The legacy admin token works and
can be passed as a query param, which makes browser-visible evidence easy:
`http://localhost:3002/api/camel/status?adminToken=dlb-admin-2026-trust`. `/api/camel/yaml`
is served as a download (`content-disposition`); Chrome saves it to `~/Downloads/yaml` — open
`file:///home/ubuntu/Downloads/yaml` to show the rendered Camel YAML on screen.

`/api/openach-rail/health` legitimately returns **HTTP 503 with `ready:false`** when
`OPENACH_API_TOKEN`/`OPENACH_API_KEY` and the ACH payment type ids are unset. That is
fail-closed behaviour, not a crash — do not report it as a failure unless credentials are configured.

### Signed inbox (`POST /api/camel/inbox/:routeId`)

Fail-closed when `CAMEL_INBOUND_HMAC_SECRET` is unset: HTTP 503 `CAMEL_INBOX_CLOSED`. To prove
signature verification actually works, run a **second** instance on another port with the secret set
(`CAMEL_INBOUND_HMAC_SECRET=test-inbound-secret CAMEL_BUS_ENABLED=false PORT=3013`) against the same
database, then:

```bash
B='{"paymentId":"SIGTEST","outcome":"settled"}'; TS=$(date +%s)
SIG=$(printf '%s' "$TS.family-bank-advice.$B" | openssl dgst -sha256 -hmac 'test-inbound-secret' -hex | awk '{print $2}')
curl -i -X POST -H 'content-type: application/json' -H "x-camel-timestamp: $TS" \
     -H "x-camel-signature: $SIG" -H "x-camel-message-key: sig-$TS" -d "$B" \
     http://localhost:3013/api/camel/inbox/family-bank-advice
```
Signed base string is `timestamp.routeId.rawBody`. Expect 401 `CAMEL_UNSIGNED` (no headers),
401 `CAMEL_BAD_SIGNATURE`, 401 `CAMEL_STALE_SIGNATURE` (old timestamp), 202 for a valid signature.
Remember to kill the extra instance afterwards — exchanges it creates show up in the main
server's `/api/camel/status` because the database is shared.

### Proving the engine mediates (not just that the router loaded)

```bash
T=dlb-admin-2026-trust; K=e2e-$(date +%s)
curl -s -X POST -H "x-admin-token: $T" -H 'content-type: application/json' \
  -d "{\"body\":{\"paymentId\":\"NOPE\"},\"messageKey\":\"$K\",\"deliver\":\"later\"}" \
  http://localhost:3002/api/camel/routes/family-bank-advice/send
curl -s -X POST -H "x-admin-token: $T" http://localhost:3002/api/camel/drive
```
Without `deliver:"later"` the exchange is processed synchronously inside the send call, so a
`pending → drive → filtered` transition can only be observed with the deferred form. An advice with
no `outcome` must end `filtered` with trace `transform(normalizeAdvice)` then
`filter(adviceHasOutcome)` note `stopped here`. Re-sending the same `messageKey` must return
`accepted:false` and must not create a second `camel_exchanges` row.

### CLI

```bash
DATABASE_URL=postgres://dlbtrust:dlbtrust@localhost:5432/dlbtrust node server/scripts/camelBus.js status|routes|yaml|drive|dead-letters|openach-status
```
`routes` prints **10** family-bank routes (ingress, execute, dispatch, openach-dispatch,
wire-dispatch, onus, manual-rail, openach-status, advice, file-batch) — PR descriptions may say 9.
`status` from the CLI shows `running:false` because the scheduler lives in the server process, not the
CLI; that is expected. Each command can take >10s to exit, so run them with a longer shell timeout.

### Devin Secrets Needed

- none for this flow locally; `OPENACH_API_TOKEN` / `OPENACH_API_KEY` (plus OpenACH ACH payment type
  ids) would be required to test real ACH origination, and are intentionally absent.
