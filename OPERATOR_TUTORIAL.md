# DLB Trust Platform — Operator Tutorial

A complete guide to the modules, features, and day-to-day operations of the DLB Trust treasury and DeFi dApp.

---

## 1. What is this system?

The DLB Trust platform is a treasury management and wealth operations system built for trustees and beneficiaries. It combines:

- Traditional trust accounting and core-banking ledgers.
- Bond and fixed-income portfolio tracking.
- Cash management, CRM, tax, and document management.
- Stablecoin and DeFi rails: SAFE multisig wallets, DEX swaps, bond tokenization, and gasless stablecoin payouts.
- AI-driven operations through the **On-Chain FinOps AI Agent**, using natural-language prompts and two-trustee approval.
- Calendar, messaging, and document vault modules wired into all workflows.

The system is intentionally **bank-rail agnostic**: it does not rely on ACH or wire transfers for crypto/stablecoin workflows, but it still records every movement through the legacy source-of-funds ledgers.

---

## 2. Architecture at a glance

```
Frontend:  public/dapp/index.html  (DeFi dApp SPA)
           public/dashboard.html   (legacy treasury dashboard)
Backend:   server/server-3002.js  (Express entrypoint)
Modules:   server/integrations/<domain>/<engine>.js
Routes:    server/routes/<domain>.js
Database:  PostgreSQL (bonds, dApp, FinOps, calendar, messaging, documents)
           SQLite fallback via DATABASE_PATH for some auth/treasury data
```

### Key entrypoints

- **Production dApp**: `https://dlbtrust-app.fly.dev/` and `https://dlbtrust-app.fly.dev/dapp`
- **Legacy dashboard**: `https://dlbtrust-app.fly.dev/treasury`
- **Health/integrity**: `GET /api/health`
- **Admin API token**: set `x-admin-token: $ADMIN_SECRET_TOKEN` (or login via `/api/auth/login`)

### Network defaults (deployed)

- **EVM chain**: Sepolia testnet (`DAPP_CHAIN_ID=11155111`)
- **DLBUSD token**: `0xd0C51931dCD5b76112581f2a53C08Ad198cB2121`
- **DLBUSD/USDC pool**: `0x29163502317276cb89c3774b411c695e2b4b8426`
- **Operator hot wallet**: derived from `DAPP_PRIVATE_KEY` (pays gas for all users)

---

## 3. Module directory

### 3.1 Core ledgers & accounting

| Module | Engines | What it does |
|--------|---------|--------------|
| `accounting` | `dataBridge.js`, `subLedgerEngine.js`, `trustAccountingEngine.js` | Trust chart of accounts, journal entries, trial balance, balance sheet, income statement, cashflow, period close, sub-ledgers, and Fineract GL bridge. |
| `cash` | `cashEngine.js` | Cash accounts, deposits, transfers, reconciliation, and position reporting. |
| `bonds` | `bondEngine.js`, `couponService.js`, `liveEngine.js`, `pgPool.js` | Bond portfolio, issuance, interest accrual, coupon/principal payments, bondholders, and live market data. |
| `fineract` | `fineractClient.js`, `fineractResilience.js` | Apache Fineract core banking client with circuit-breaker and retry logic. |
| `crm` | `crmEngine.js` | Contacts, beneficiaries, subscriptions, KYC, interactions, and Fineract linkage. |
| `tax` | `taxEngine.js` | Form 1041 computation, K-1 generation, tax payments, and income tracking. |

### 3.2 Payments & settlement

| Module | Engines | What it does |
|--------|---------|--------------|
| `ach` / `achPipeline` | `achEngine.js`, `nachaGenerator.js`, `as2Client.js`, `paymentOrchestrator.js`, etc. | NACHA file generation, AS2 transmission, acknowledgements, returns, and bank routing. |
| `wire` | — | Fedwire origination, dual-approval workflow, returns, and audit. |
| `electronicSettlement` | `electronicSettlementEngine.js`, `stpEngine.js`, `trustSweepScheduler.js` | STP dashboard, bank sweeps, settlement lifecycle, and MFA trust window. |
| `paymentHub` | `paymentHubEngine.js`, `paymentHubClient.js`, `usAchConnector.js`, `stablecoinConnector.js` | Payment intent orchestration and connector execution. |
| `openach` | `openachClient.js` | OpenACH API client for credit union ODFI/RDFI operations. |
| `nifi` | `nifiPaymentEngine.js` | Apache NiFi payment file transfer, outbox/inbox, and push/ack workflows. |
| `payments` | `electronicSettlementEngine.js`, `hcePaymentEngine.js`, `stpEngine.js`, `trustIdentity.js`, `trustSweepScheduler.js` | Payment profiles, scheduled disbursements, and HCE contactless payments. |
| `hce` | `hcePaymentEngine.js` | Host Card Emulation (NFC) device registration, authorization, QR payments, and token verification. |
| `as2` | `as2Server.js`, `certManager.js`, `partnerManager.js` | AS2 certificate and partner management. |

### 3.3 Stablecoin & DeFi rails

| Module | Engines | What it does |
|--------|---------|--------------|
| `stablecoin` | `stablecoinGateway.js`, `blockchainEngine.js`, `treasuryEngine.js`, `sourceOfFundsAdapter.js`, `hederaEngine.js`, `circleMintClient.js`, `circleKitEngine.js`, `fystackEngine.js`, `coinbaseHbarEngine.js`, `clearingAndSettlementEngine.js`, `magicWalletService.js`, `wso2ApiManager.js`, `hollaExClient.js` | Stellar/Hedera stablecoin payments, treasury holds, Circle Mint/Kit, FyStack, Coinbase HBAR, Magic WaaS, clearing/settlement, and HollaEx conversion. |
| `dapp` | `dappEngine.js`, `safeEngine.js`, `bondTokenizationEngine.js`, `dexSwapEngine.js`, `stablecoinDexEngine.js`, `sourceToDexBridge.js`, `coinbaseSpotEngine.js`, `coinbaseTreasuryBridge.js`, `cashAppEngine.js`, `googleWalletEngine.js` | SAFE multisig, source-of-funds deposits, payouts/distributions/P2P, bond tokenization, DEX swap, stablecoin DEX, Coinbase off-ramp, and white-label payment rails. |
| `hollaex` | `hollaExClient.js` | Fiat-to-crypto conversion quotes and execution. |

### 3.4 Data, documents & integration

| Module | Engines | What it does |
|--------|---------|--------------|
| `documents` | `documentEngine.js`, `generationEngine.js`, `templateEngine.js` | Document vault, templates, generation, bond packages, statements, and receipts. |
| `ofx` | `ofxEngine.js` | OFX statement import, institution management, and OFX-originated payments. |
| `aggregator` | `bankingAggregator.js`, `scheduler`, connectors | Banking data aggregation with Eaton/generic/internal connectors, pull/push, webhooks, and returns. |
| `backup` | `backupEngine.js`, `gracefulShutdown.js`, `transactionJournal.js`, `watchdog.js` | Backup, journal replay, and graceful shutdown resilience. |

### 3.5 AI, agents & collaboration

| Module | Engines | What it does |
|--------|---------|--------------|
| `agents` | `finOpsAgent.js`, `bookkeepingAgent.js`, `trusteeAgent.js`, `agentPromptRouter.js` | On-Chain FinOps AI Agent, trustee reviews, bookkeeping reconciliation, and prompt routing. |
| `calendar` | `calendarEngine.js` | Calendar events, scheduling, and auto-created events from FinOps tasks. |
| `messaging` | `messagingEngine.js` | Message threads, notifications, and approval/execution audit threads. |

### 3.6 Security

| Module | Engines | What it does |
|--------|---------|--------------|
| `auth` | `securityMiddleware.js`, `userAuth.js` | JWT/login, role checks (`admin`, `operator`, `trustee_admin`, `trustee_secretary`, `beneficiary`, `viewer`), rate limiting, CORS, CSP, input sanitization, CSRF. |

---

## 4. The DeFi dApp UI

The dApp is a single-page app served at `/` and `/dapp`. The top navigation exposes these sections:

| Tab | Purpose |
|-----|---------|
| **Dashboard** | Wallet/Safe overview, recent activity, and readiness badges. |
| **Source of Funds** | Live balances from Treasury, Cash, Trust, Bond, Sub-Ledger, Core Banking, CRM, and Tax. |
| **Safe Wallets** | Create and view Gnosis Safe-compatible multisig wallets. |
| **Deposit** | Record a crypto deposit or sweep from a legacy ledger. |
| **Payout / 2-Sig** | Create a payout, collect two signatures, and execute on-chain. |
| **Distribute** | One-to-many disbursement to beneficiaries. |
| **P2P Pay** | Person-to-person stablecoin payment. |
| **Payment Rails** | Google Wallet pass generation and Cash App payment request links. |
| **Bond Tokens** | Tokenize bond/fixed-income positions into ERC-20 tokens. |
| **Stablecoin DEX** | DLBUSD → USDC/USDS swap with a gasless relayer. |
| **FinOps AI** | Natural-language command center for operations. |
| **Calendar** | View and create events linked to tasks/payments. |
| **Messaging** | Threads and notifications for approvals and execution. |
| **Documents** | Vault for receipts, confirmations, and generated reports. |
| **White Label** | Configure branding for external beneficiary portals. |

---

## 5. Two-signature approval

Every state-changing DeFi operation follows a **two-trustee** model:

- **Administration**: DeAndrea Lavar Barkley (`deandreabarkley13@gmail.com`, `(216)632-2353`)
- **Distribution**: Malissa Ann Robinson (`annrobinson9800@yahoo.com`, `(216)484-4804`)

Both trustees must approve before the system executes:

1. Payouts (`/api/dapp/payouts/:id/approve`)
2. Distributions (`/api/dapp/distributions`)
3. P2P payments (`/api/dapp/p2p`)
4. FinOps AI tasks (`/api/dapp/finops-ai/tasks/:id/approve`)

Approvals are recorded in the task/payout row and in the messaging thread.

---

## 6. On-Chain FinOps AI Agent

The FinOps agent translates natural language into a structured task, enforces two-trustee approval, and executes the action.

### Supported prompt intents

| Action | Example prompt |
|--------|----------------|
| `payment` | "Pay $0.01 USDC to `0x8616...FA16` from cash CA-OPERATING" |
| `distribution` | "Distribute $5 each to 0xA..., 0xB... from trust 1000" |
| `dex_swap` | "Swap $10 DLBUSD for USDC" |
| `create_safe` | "Create a new safe wallet for the bond reserve" |
| `schedule` | "Schedule a trustee review meeting on 2026-08-01T14:00" |
| `document` | "Generate a payment confirmation for task FINOPS-xxx" |
| `overview` | "Show me the source of funds balances" |

### Workflow

1. `POST /api/dapp/finops-ai/prompt` with `{ "prompt": "..." }`
2. The agent parses the prompt into an `intent` (action, amount, asset, source, destination, date, title).
3. The task status is `pending_approval`.
4. Administration trustee calls `POST /api/dapp/finops-ai/tasks/:id/approve` with `role: "administration"`.
5. Distribution trustee calls the same endpoint with `role: "distribution"`.
6. Once both approve, `execute` runs automatically (or call `POST /api/dapp/finops-ai/tasks/:id/execute`).
7. The agent creates a calendar event, messaging thread, and document confirmation.

### Example cURL

```bash
curl -s -X POST https://dlbtrust-app.fly.dev/api/dapp/finops-ai/prompt \
  -H "Content-Type: application/json" \
  -H "x-admin-token: $ADMIN_SECRET_TOKEN" \
  -d '{"prompt":"Pay $0.01 USDC to 0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16 from cash CA-OPERATING"}'
```

---

## 7. Source-of-funds ledgers

The dApp can pull balances from and reserve against these legacy ledgers:

| Source type | Example ID | Notes |
|-------------|------------|-------|
| `cash` | `CA-OPERATING` | Cash management account. |
| `trust` | `1000` | Trust accounting account. |
| `bond` | `1` / `DLB-PRB` | Bond/fixed income principal & interest. |
| `core_banking` | Fineract savings ID | Apache Fineract savings/current account. |
| `sub_ledger` | `SL-INV-...` | Client/investor sub-ledger. |
| `crm` | contact ID | Beneficiary/contact record (no stored balance; used for P2P identity). |
| `tax` | `trust_tax_reserve` | Tax reserve/distributions. |

To view all available balances:

```bash
curl -s -H "x-admin-token: $ADMIN_SECRET_TOKEN" \
  https://dlbtrust-app.fly.dev/api/dapp/source-of-funds
```

To sweep from a ledger into the stablecoin treasury/Safe:

```bash
curl -s -X POST https://dlbtrust-app.fly.dev/api/dapp/deposits/from-source \
  -H "Content-Type: application/json" \
  -H "x-admin-token: $ADMIN_SECRET_TOKEN" \
  -d '{
    "sourceType": "cash",
    "sourceAccountId": "CA-OPERATING",
    "asset": "USDC",
    "amount": "1.00"
  }'
```

---

## 8. DeFi workflows

### 8.1 Payout with two signatures

1. Create payout:
   ```bash
   curl -s -X POST https://dlbtrust-app.fly.dev/api/dapp/payouts \
     -H "x-admin-token: $ADMIN_SECRET_TOKEN" -H "Content-Type: application/json" \
     -d '{
       "destination": "0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16",
       "value": "0.01",
       "token": "USDC",
       "sourceType": "cash",
       "sourceAccountId": "CA-OPERATING",
       "description": "Trust expense payment"
     }'
   ```
2. Approve twice (`POST /api/dapp/payouts/:id/approve`) with signatures/addresses.
3. Execute (`POST /api/dapp/payouts/:id/execute`) to broadcast the Safe transaction.

### 8.2 DLBUSD → USDC stablecoin DEX

The `StablecoinDexEngine` mints DLBUSD from a source ledger and swaps it for USDC in one call.

```bash
curl -s -X POST https://dlbtrust-app.fly.dev/api/dapp/stablecoin-dex/deposit-and-swap \
  -H "x-admin-token: $ADMIN_SECRET_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "sourceType": "cash",
    "sourceAccountId": "CA-OPERATING",
    "amount": "0.01",
    "targetAsset": "USDC",
    "recipient": "0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16"
  }'
```

The operator hot wallet pays gas; the recipient does not need ETH.

### 8.3 Bond tokenization + DEX

1. `POST /api/dapp/bond-tokens` — create an ERC-20 bond token.
2. `POST /api/dapp/bond-tokens/:id/mint` — mint tokens to the Safe/operator wallet.
3. `POST /api/dapp/dex/pools` — create a `BondDex` AMM pool with token + USDC.
4. `POST /api/dapp/dex/quote` and `POST /api/dapp/dex/swap` — quote and swap.

### 8.4 Fund the Safe from source ledger via DEX

```bash
curl -s -X POST https://dlbtrust-app.fly.dev/api/dapp/fund-from-source \
  -H "x-admin-token: $ADMIN_SECRET_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "sourceType": "bond",
    "sourceAccountId": "1",
    "targetAsset": "USDC",
    "amount": "0.10",
    "beneficiary": "0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16"
  }'
```

This reserves the ledger, tokenizes the bond amount, creates a pool if needed, swaps for the target stablecoin, and credits the Safe/operator wallet.

---

## 9. Calendar, messaging & documents

### Calendar

- `GET /api/dapp/calendar/events`
- `POST /api/dapp/calendar/events` with `title`, `start`, `end`, `eventType`, `relatedModule`, `referenceId`, etc.
- `PUT /api/dapp/calendar/events/:id`
- `DELETE /api/dapp/calendar/events/:id`

The FinOps agent auto-creates events for payments, distributions, and schedules.

### Messaging

- `GET /api/dapp/messaging/threads`
- `POST /api/dapp/messaging/threads`
- `GET /api/dapp/messaging/threads/:id`
- `POST /api/dapp/messaging/threads/:id/messages`

Auto-generated threads notify trustees at task creation, each approval, and execution.

### Documents

- `GET /api/dapp/documents`
- `POST /api/dapp/documents`
- `GET /api/dapp/documents/:id`

Use to store receipts, payment confirmations, K-1s, and generated bond packages.

---

## 10. API route quick reference

The backend mounts route modules under `/api/` prefixes as shown in `server/server-3002.js`.

### 10.1 dApp (`/api/dapp/...`)

| Method | Path | Purpose |
|--------|------|---------|
| GET/POST | `/safes`, `/safes/:id`, `/safes/:id/sync` | Safe multisig wallets |
| GET/POST | `/deposits`, `/deposits/from-source` | Deposits and ledger sweeps |
| GET | `/source-of-funds` | All legacy ledger balances |
| GET/POST | `/payouts`, `/payouts/:id/approve`, `/payouts/:id/execute` | 2-sig payouts |
| GET/POST | `/distributions` | One-to-many distributions |
| GET/POST | `/p2p` | P2P payments |
| GET/POST | `/users`, `/users/link-wallet`, `/auth/send-code`, `/auth/verify` | Email/phone P2P identity |
| GET/POST | `/payment-rails/*` | Google Wallet pass / Cash App request |
| GET/POST | `/bond-tokens/*` | Bond tokenization and minting |
| GET/POST | `/dex/*` | Bond-token DEX quote/swap/pool |
| GET/POST | `/stablecoin-dex/*` | DLBUSD stablecoin DEX (quote/pool/swap/deposit-and-swap) |
| POST | `/fund-from-source` | Source ledger → token → DEX → stablecoin bridge |
| GET/POST | `/coinbase-spot/*` | Coinbase spot buy off-ramp |
| GET/POST | `/coinbase-treasury/*` | Treasury → Coinbase deposit → buy → on-chain send |
| GET/POST | `/finops-ai/*` | FinOps AI agent prompts, tasks, approvals, execution |
| GET/POST/PUT/DELETE | `/calendar/events*` | Calendar CRUD |
| GET/POST | `/messaging/threads*` | Messaging threads and messages |
| GET/POST | `/documents*` | Document vault |
| GET/POST | `/white-label*` | White-label portal config |

### 10.2 Stablecoin rails (`/api/stablecoin/...`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Gateway health |
| POST | `/quote` | Payment quote |
| GET | `/source-types` | Supported source-of-funds types |
| GET | `/sources/:type/:id/balance` | Ledger balance |
| GET/POST | `/payments*` | Stablecoin payment lifecycle |
| POST | `/ensure-trustline` | Stellar trustline setup |
| GET/POST | `/hedera/*` | Hedera Stablecoin Studio (create/mint/balance/associate) |
| GET/POST | `/convert/*` | HollaEx fiat↔crypto conversion |
| GET/POST | `/fystack/*` | FyStack self-hosted custody wallets/withdrawals |
| GET/POST | `/circle/*` | Circle App Kit stablecoin send |
| GET/POST | `/treasury/*` | Treasury position/credit |
| GET/POST | `/wallets*` | Magic WaaS wallets/sign |
| GET/POST | `/circle-mint/*` | Circle Mint regulated bank-wire on-ramp |
| GET/POST | `/clearing/*` | Clearing & settlement batch/orders |
| GET/POST | `/coinbase-hbar/*` | Coinbase → HBAR funding |

### 10.3 Other key routes

| Prefix | Module | Example endpoint |
|--------|--------|------------------|
| `/api/auth` | Login/users | `POST /api/auth/login` |
| `/api/admin` | System/GL/clients/accounts/bonds | `GET /api/admin/system/health` |
| `/api/analytics` | Dashboards and summaries | `GET /api/analytics/summary` |
| `/api/fineract` | Core banking | `GET /api/fineract/health` |
| `/api/bonds` | Bond portfolio | `POST /api/bonds/:id/pay-interest` |
| `/api/cash` | Cash accounts | `GET /api/cash/position` |
| `/api/crm` | Contacts | `GET /api/crm/contacts` |
| `/api/accounting` | Trust accounting | `GET /api/accounting/reports/trial-balance` |
| `/api/sub-ledgers` | Sub-ledger | `GET /api/sub-ledgers/rollup` |
| `/api/tax` | Tax | `POST /api/tax/1041/compute` |
| `/api/documents` | Document templates/generation | `POST /api/documents/generate` |
| `/api/ofx` | OFX | `POST /api/ofx/statements` |
| `/api/aggregator` | Banking aggregator | `POST /api/aggregator/connections` |
| `/api/wire` | Wire transfers | `POST /api/wire/initiate` |
| `/api/ach-pipeline` | ACH batch/AS2 | `POST /api/ach-pipeline/batches` |
| `/api/electronic-settlement` | STP/sweeps | `POST /api/electronic-settlement/sweep-now` |
| `/api/payment-hub` | Payment intents | `POST /api/payment-hub/intents` |
| `/api/bill` | Bill.com sync | `POST /api/bill/sync/run` |
| `/api/vendors` | Vendor payments | `POST /api/vendors/payments/initiate` |
| `/api/hce` | NFC/contactless | `POST /api/hce/authorize` |
| `/api/backup` | Backups/journal | `POST /api/backup/run` |
| `/api/as2` | AS2 messaging | `POST /api/as2/send` |
| `/api/nifi` | NiFi transfers | `POST /api/nifi/push/:fileId` |
| `/api/agents` | Trustee/bookkeeping agents | `POST /api/agents/trustee/asset-review` |

For the full route list, inspect `server/routes/*.js`.

---

## 11. Configuration & environment variables

Key settings in `.env.example`:

| Variable | Purpose |
|----------|---------|
| `PORT` / `NODE_ENV` | Server port and environment |
| `JWT_SECRET` / `ADMIN_SECRET_TOKEN` | Auth signing secret and legacy admin API token |
| `DATABASE_PATH` | SQLite path for local treasury/auth |
| `BOND_DB_NAME` | PostgreSQL database name for bond/dApp data |
| `DATABASE_URL` or `FINERACT_DB_*` | PostgreSQL connection |
| `FINERACT_URL`, `FINERACT_TENANT_ID`, `FINERACT_USERNAME`, `FINERACT_PASSWORD` | Apache Fineract core banking |
| `PAYMENT_MODE` | `sandbox` or `production` |
| `DAPP_ENABLED` / `DAPP_SHADOW` | Enable/disable DeFi dApp and shadow/demo mode |
| `DAPP_CHAIN_ID` / `DAPP_RPC_URL` | EVM network |
| `DAPP_PRIVATE_KEY` / `DAPP_OPERATOR_ADDRESS` | Operator hot wallet |
| `DAPP_USDC_ADDRESS` / `DAPP_WETH_ADDRESS` | Stablecoin/WETH contract addresses |
| `BOND_TOKEN_FACTORY` / `BOND_DEX_ADDRESS` / `DEX_SWAP_ROUTER` | Bond token & DEX pool addresses |
| `BOND_TOKEN_BYTECODE_PATH` / `BOND_TOKEN_ABI_PATH` | Contract artifacts |
| `HEDERA_*` | Hedera Stablecoin Studio config |
| `STABLECOIN_*` | Stellar stablecoin gateway config |
| `CIRCLE_MINT_*`, `CIRCLE_*` | Circle Mint/App Kit keys |
| `COINBASE_CDP_KEY_NAME`, `COINBASE_CDP_PRIVATE_KEY` | Coinbase CDP API key for HBAR/spot/treasury |
| `FYSTACK_*` | FyStack Ignite config |
| `HOLLAEX_*` | HollaEx Kit config |
| `MAGIC_*` | Magic WaaS config |
| `WSO2_*` | WSO2 API Manager proxy config |
| `OFX_*` | OFX institution credentials |
| `ACH_*` / `WIRE_*` / `AS2_*` / `NIFI_*` | Legacy bank-rail configuration |
| `SUPABASE_*` | Supabase auth (client-side) |

**Never commit real keys.** Set them via Fly secrets, `.env`, or your deployment platform.

---

## 12. Common operator recipes

### Recipe 1: Pay a beneficiary in one command via FinOps

1. Open the dApp → **FinOps AI**.
2. Enter: `Pay $10 USDC to 0x... from cash CA-OPERATING` and submit.
3. Administration trustee approves.
4. Distribution trustee approves.
5. System executes; check the **Messaging** and **Calendar** tabs for auto-created records.

### Recipe 2: Sweep a bond/fixed-income position into stablecoins

1. **Source of Funds** tab → confirm bond balance.
2. **Bond Tokens** tab → create token and mint from bond ID.
3. **Stablecoin DEX** tab → choose source ledger, amount, target `USDC`, and swap.
4. The operator wallet pays gas and the stablecoin lands in the Safe.

### Recipe 3: Create and execute a distribution

1. **Distribute** tab → enter total amount, asset, and beneficiary list.
2. Submit; collect two signatures.
3. Execute; each beneficiary receives their split.

### Recipe 4: Generate a tax K-1

1. `POST /api/tax/k1/generate` with year and beneficiary.
2. Retrieve with `GET /api/tax/k1/:returnId`.
3. Store in the document vault with `POST /api/dapp/documents`.

### Recipe 5: Reconcile legacy bank files

1. **OFX** route: `POST /api/ofx/statements` with OFX file.
2. **Accounting** route: `POST /api/accounting/bridge/sync`.
3. **Agents** route: `POST /api/agents/bookkeeping/reconcile-ach` or `reconcile-wires`.

---

## 13. Testing & health checks

```bash
# Unit tests
npm test

# Type check
npm run typecheck

# Start backend locally (uses server CommonJS context)
node server/server-3002.js

# Health
GET /api/health
GET /api/dapp/stablecoin-dex/readiness
GET /api/dapp/bond-tokens/readiness
GET /api/dapp/dex/readiness
GET /api/stablecoin/health
```

Before any real mainnet operation, confirm:

- `DAPP_SHADOW=false`
- `DAPP_CHAIN_ID` matches the target network.
- Operator wallet has ETH for gas.
- Safe has the stablecoin/asset being sent.
- Source-of-funds ledger has sufficient reserved balance.

---

## 14. Operator Gas Tank (auto ETH replenishment)

The **Operator Gas Tank** keeps the operator hot wallet funded so that on-chain transactions, paymaster seeding, and DEX swaps can execute without manual ETH purchases.

- Card: **Sovereign Trust → Operator Gas Tank**
- Threshold: `OPERATOR_GAS_TANK_THRESHOLD_ETH` (default `0.005 ETH`)
- Top-up amount: `OPERATOR_GAS_TANK_TOPUP_USD` (default `$100`)
- Source: any source-of-funds ledger (`treasury`, `cash`, `trust`, `bond`, `sub_ledger`, `core_banking`)

### Flow
1. `GET /api/dapp/operator-gas-tank/status` reads the operator balance and shows recent top-ups.
2. `POST /api/dapp/operator-gas-tank/check-and-topup` checks the balance. If below the threshold, it sweeps `$100` from the source ledger into the Treasury, stages a `CoinbaseTreasuryBridge` transfer, and tries to market-buy ETH and send it to the operator wallet.
3. If Coinbase has USD, the buy and on-chain send complete automatically and the status is `completed`.
4. If Coinbase has no USD, the status is `needs_deposit`; the source ledger is already reserved. Wire/ACH USD into the connected Coinbase account, then call `POST /api/dapp/operator-gas-tank/topups/:id/execute` to retry.
5. Optional: set `OPERATOR_GAS_TANK_AUTO_CHECK=true` to run the check every `OPERATOR_GAS_TANK_CHECK_INTERVAL_MS` (default 5 minutes) and `OPERATOR_GAS_TANK_SEED_PAYMASTER_ETH` to auto-seed the paymaster after each top-up.

---

## 15. Security & audit

- All routes require `x-admin-token`, JWT, or session auth.
- Write routes use rate limiting (`writeRateLimiter`).
- Input is sanitized (null bytes, oversized strings).
- Helmet headers, CORS lockdown, and CSRF tokens are enforced.
- Every FinOps/payout/distribution action records approvals, signatures, and tx hashes.
- Source-of-funds debits are atomic: failed on-chain transactions roll back ledger reserves.
- Use `ADMIN_SECRET_TOKEN` only for service-to-service or operator API calls; beneficiaries log in with email/phone OTP.

---

## 15. Troubleshooting

| Symptom | Likely cause | Fix |
|----------|--------------|-----|
| `DAPP_SHADOW` returns `mode: shadow` | Env not set to `false` or no real RPC | Set `DAPP_SHADOW=false`, `DAPP_RPC_URL` to a live RPC, and fund the operator wallet. |
| `needs_deposit` from Coinbase/Circle | No fiat balance in the connected exchange account | Deposit USD/wire, then retry execute. |
| `No liquidity` from DEX | Pool not seeded | Create pool with `POST /api/dapp/dex/pools` or `POST /api/dapp/stablecoin-dex/pool`. |
| `source ledger has no balance` | Ledger entry missing or already reserved | Check `/api/dapp/source-of-funds` and release pending holds. |
| `missing trustee approval` | Both trustees have not approved | Confirm Administration and Distribution approvals. |
| `safe threshold not met` | Signatures insufficient | Add second owner signature/approval and re-execute. |
| FinOps task stays `pending_approval` | Not enough approvals | Approve with both trustee roles. |

For deeper diagnostics, check `GET /api/health`, application logs, and the `/api/admin/system/health` and `/api/admin/audit-log` endpoints.

---

*This tutorial is a living document. As new modules are added, extend the relevant section and update the route tables.*
