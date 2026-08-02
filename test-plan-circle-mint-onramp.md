# PR #234: Clearing & Settlement Engine End-to-End Test Plan

**Target branch:** `devin/circle-mint-onramp` (PR #234)
**Local app URL:** `http://localhost:3002`
**Server entry:** `server/server-3002.js`

## Goal

Prove the new `ClearingAndSettlementEngine` works end-to-end through the dashboard:

1. Wallets can be registered and linked to a treasury source ledger.
2. A Circle-network clear-and-settle returns a `CSO-` order id, `status: settled`, and a shadow `tx_hash`.
3. A Stellar testnet clear-and-settle returns a `CSO-` order id, `status: settled`, and a **real** Stellar testnet `tx_hash` with explorer URL.
4. List endpoints surface both the wallet and both orders.

## Environment

```
DATABASE_URL=postgres://dlbtrust:dlbtrust@localhost:5432/dlbtrust
JWT_SECRET=test-jwt-secret
ADMIN_SECRET_TOKEN=dlb-admin-2026-trust
PORT=3002
STABLECOIN_ENABLED=true
STABLECOIN_MODE=testnet          # required for a real Stellar testnet tx; Circle still simulates via CIRCLE_SHADOW
STABLECOIN_NETWORK=testnet
STABLECOIN_ASSET_CODE=USDC
STABLECOIN_DISTRIBUTOR_SECRET=<freshly-generated Stellar testnet secret>
STABLECOIN_DISTRIBUTOR_PUBLIC=<matching public key>
STABLECOIN_ISSUER_SECRET=<same secret as distributor, for self-issuing test USDC>
CIRCLE_ENABLED=true
CIRCLE_SHADOW=true
CIRCLE_CHAIN=Ethereum
CIRCLE_TOKEN=USDC
CIRCLE_API_KEY=dummy
CIRCLE_ENTITY_SECRET=dummy
CIRCLE_SOURCE_ADDRESS=0xDummySourceAddress
```

The `STABLECOIN_DISTRIBUTOR_SECRET` account must be funded by Friendbot before the server is started; `STABLECOIN_ISSUER_SECRET` is the same key so the distributor can issue the test `USDC` asset to the destination.

## Test steps and pass/fail criteria

### 1. Server startup and treasury credit

- Kill any existing `server-3002.js` process and start with the env above.
- Credit `TREASURY_HOT` via `POST /api/stablecoin/treasury/TREASURY_HOT/credit`:
  ```json
  { "amountCents": 500, "source": "test" }
  ```
  using header `x-admin-token: dlb-admin-2026-trust`.

**Pass:**
- Server log contains `[stablecoin] tables ensured` and no 500 errors during startup.
- Credit response `success: true` and `data.balance_cents >= 500`.

### 2. Register a Circle wallet from the dashboard

- Log in as `admin` / `dlb-admin-2026-trust` and navigate to **Stablecoin Payments**.
- In the **Clearing & Settlement** card, set:
  - Source Type: `treasury`
  - Source Account ID: `TREASURY_HOT`
  - Wallet Address: `0x080e0d0ae80c86cc80bb050dbe0d5e5bdb6cd225`
  - Network: `circle`
  - Wallet Provider: `circle`
- Click **Register Wallet**, then **List Wallets**.

**Pass:**
- Register response `success: true`, `data.id` starts with `WAL-`.
- `data.source_type` is `treasury`, `data.source_account_id` is `TREASURY_HOT`, `data.address` is the address above, `data.network` is `circle`, `data.wallet_provider` is `circle`.
- List Wallets shows the newly registered wallet in `sc-clearing-result`.

### 3. Circle clear-and-settle for $25.00

- In the same card, set:
  - Destination Wallet: `0x080e0d0ae80c86cc80bb050dbe0d5e5bdb6cd225`
  - Amount: `25.00`
  - Network: `circle`
  - Provider: `circle`
- Click **Clear & Settle**.

**Pass:**
- Response `success: true`, `data.id` starts with `CSO-`.
- `data.status` is `settled`.
- `data.tx_hash` is non-empty and starts with `circle-shadow-` (because `CIRCLE_SHADOW=true`).
- `data.amount_cents` is `2500`, `data.fee_cents` is `25`, `data.total_cents` is `2525`.
- `TREASURY_HOT` balance decreases by the total (`2525` cents) or by the payment amount plus retained fee (a clear decrease; exact ledger state is captured in screenshots).

### 4. Stellar testnet clear-and-settle for $1.00

- Generate a fresh Stellar testnet keypair, fund the public key via Friendbot, and copy the public key into **Destination Wallet** and the secret key into **Destination Secret (testnet trustline)**.
- Set:
  - Source Type: `treasury`
  - Source Account ID: `TREASURY_HOT`
  - Amount: `1.00`
  - Network: `testnet`
  - Provider: `direct`
- Click **Clear & Settle**.

**Pass:**
- Response `success: true`, `data.id` starts with `CSO-`.
- `data.status` is `settled`.
- `data.tx_hash` is a real 64-character Stellar testnet transaction hash (not `shadow-` and not `circle-shadow-`).
- `data.tx_explorer` contains `https://stellar.expert/explorer/testnet/tx/<data.tx_hash>` and is reachable in a browser.
- `data.network` is `testnet`, `data.wallet_provider` is `direct`.

### 5. List wallets and orders

- Click **List Wallets** and **List Orders** in the Clearing & Settlement card.

**Pass:**
- List Wallets returns at least the registered Circle wallet (`WAL-...`).
- List Orders returns both `CSO-...` orders, the Circle one with `network: 'circle'` and `status: 'settled'`, and the Stellar one with `network: 'testnet'` and `status: 'settled'`.

### 6. Server log and database verification

- Inspect `/tmp/server-3002.log` (or the chosen log file) for 500/401 errors on `/api/stablecoin/clearing/*` routes.
- Query Postgres:
  - `SELECT id, status, network, tx_hash FROM stablecoin_clearing_orders ORDER BY created_at DESC;`
  - `SELECT id, source_type, source_account_id, address, network FROM stablecoin_wallet_registry;`

**Pass:**
- No 500/401 errors on clearing routes during the recorded flows.
- Both orders and the wallet are persisted in Postgres.

## What distinguishes working from broken

- **Missing `clearAndSettle` route or engine:** a `POST /api/stablecoin/clearing/clear-and-settle` would 404 or return `success: false`.
- **Wallet not linked to source ledger:** `data.source_type`/`data.source_account_id` would be wrong or null.
- **Circle not in shadow mode:** without `CIRCLE_SHADOW=true`, readiness/address/settle would fail due to missing real Circle credentials.
- **Stellar testnet not wired correctly:** `data.tx_hash` would be `shadow-...` (because `STABLECOIN_MODE=shadow`) or missing, and `tx_explorer` would be empty.
- **Source funds not reserved:** `TREASURY_HOT` balance would not decrease, or the order would fail with an insufficient-balance error.

## Code references

- `server/integrations/stablecoin/clearingAndSettlementEngine.js` — `WalletRegistry.register`, `ClearingAndSettlementEngine.clearAndSettle`, `listOrders`.
- `server/routes/stablecoin.js` lines 371–429 — new `/api/stablecoin/clearing/*` routes.
- `public/dashboard.html` lines 1682–1712 — Clearing & Settlement card and `scClearingRegisterWallet` / `scClearingSettle` / `scClearingListOrders`.
- `server/integrations/stablecoin/blockchainEngine.js` lines 233–295 — real Stellar settlement and `ensureDestinationTrustline`.
- `server/integrations/stablecoin/circleKitEngine.js` lines 152–163 — shadow Circle settlement.
- `server/integrations/stablecoin/stablecoinGateway.js` lines 242–291 — `settlePayment` orchestration.
