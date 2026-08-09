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
- Use the left sidebar **OFX Clearing** nav item to switch to `#page-ofx`.
- The page has cards for institutions, statement import, payment creation, and a payments table.
- Submitting a payment in simulate mode updates the row to `accepted` and persists an XML `ofx_request` in Postgres.

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

## Devin Secrets Needed

- `DATABASE_URL` or local Postgres credentials (`dlbtrust`/`dlbtrust`).
- `JWT_SECRET` and `ADMIN_SECRET_TOKEN` for stable auth.
- `secret:org:HEDERA_OPERATOR_KEY` — only needed for live (non-shadow) Hedera tests.
- `secret:org:DLBTRUST_API_KEY` — for programmatic API access if enabled.
- `secret:org:FLY_API_TOKEN` — needed for `flyctl deploy` and `flyctl secrets set` against `dlbtrust-app`.
