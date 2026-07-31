# Circle Developer-Controlled Wallet Review Fix — End-to-End Test Plan

**Target branch:** `devin/circle-review-fix` (PR #230 review follow-up)
**App URL:** `http://localhost:3003`
**Server entry:** `server/server-3002.js`

## Goal

Prove that the Circle App Kit integration works in local shadow mode after the review fix (`getConfig()` restored in `settlePayment`). Specifically:

1. The **Circle App Kit readiness** badge reports **Ready** without real credentials when `CIRCLE_SHADOW=true`.
2. The **Get Source Address** button returns a simulated EVM address.
3. A stablecoin payment with `network = circle`, `sourceType = cash` can be created, approved, and settled, reducing the cash source balance and producing a `circle-shadow-` tx hash.
4. A `sourceType = treasury` payment with `network = circle` also settles correctly.
5. Server logs contain no 500/401 errors and the UI renders the new Circle card/fields.

## Preconditions

- PostgreSQL `dlbtrust` database is running and reachable at `postgres://dlbtrust:dlbtrust@localhost:5432/dlbtrust`.
- `STABLECOIN_CASH_HOLD` cash account exists and is `active`.
- A cash source account with at least `$2.00` (e.g. `CA-BOND-PROCEEDS`) exists.
- `TREASURY_HOT` treasury account has at least `$2.00` available.
- Port 3003 is free.
- Admin credentials: `admin` / `dlb-admin-2026-trust`.

## Environment for local server

```bash
cd /home/ubuntu/repos/dlbtrust-app
nohup env \
  DATABASE_URL=postgres://dlbtrust:dlbtrust@localhost:5432/dlbtrust \
  JWT_SECRET=test-jwt-secret \
  ADMIN_SECRET_TOKEN=dlb-admin-2026-trust \
  PORT=3003 \
  STABLECOIN_ENABLED=true \
  STABLECOIN_MODE=shadow \
  STABLECOIN_NETWORK=testnet \
  STABLECOIN_ASSET_CODE=USDC \
  CIRCLE_ENABLED=true \
  CIRCLE_SHADOW=true \
  CIRCLE_CHAIN=Ethereum \
  CIRCLE_TOKEN=USDC \
  CIRCLE_ADAPTER_TYPE=circle-wallets \
  CIRCLE_API_KEY=dummy \
  CIRCLE_ENTITY_SECRET=dummy \
  CIRCLE_SOURCE_ADDRESS=0xDummySourceAddress \
  node server/server-3002.js > /tmp/server-3003.log 2>&1 &
disown
```

## Test steps and pass/fail criteria

### 1. Server startup and login

- Kill any existing server on 3002/3003, start with env above, and verify `ss -ltnp | grep 3003`.
- Open `http://localhost:3003/` and log in as `admin` / `dlb-admin-2026-trust`.
- Navigate to **Stablecoin Payments**.

**Pass:** page loads, payment table or form visible.

### 2. Circle readiness and source address

- Click **Check Readiness** in the **Circle App Kit (Mainnet USDC)** card.
- Click **Get Source Address**.

**Pass:** readiness message says "Circle Ready" with `CIRCLE_SHADOW=true` warning; source address is a `0x...` string.

### 3. Circle cash payment

- Set Network = `circle`.
- Set Source Type = `cash`, Source Account ID = `CA-BOND-PROCEEDS`.
- Set Destination Wallet = `0x000000000000000000000000000000000000dEaD`.
- Set Amount = `1.00`, Asset = `USDC`.
- Click **Create Payment**.
- Click **Approve** on the new row.
- Click **Settle** on the approved row.

**Pass:**
- Payment row shows `pending` → `approved` → `settled`.
- `tx_hash` starts with `circle-shadow-`.
- Cash source `CA-BOND-PROCEEDS` balance is reduced by `$1.25`.
- `STABLECOIN_CASH_HOLD` balance increased by `$1.25` (temporary sweep).
- Treasury `TREASURY_HOT` final state reflects fee retained (`balance` up `$0.25`, `hold` back to baseline).
- No server 500/401 errors.

### 4. Circle treasury payment

- Set Network = `circle`, Source Type = `treasury`.
- Set Destination Wallet = `0x1111111111111111111111111111111111111111`.
- Set Amount = `0.50`.
- Create, Approve, Settle.

**Pass:** row becomes `settled`, `tx_hash` starts with `circle-shadow-`, treasury `TREASURY_HOT` balance reduced by `$0.50` (fee retained $0.25, net available down $0.50).

### 5. Server log and UI verification

- Check `/tmp/server-3003.log` for `500`/`401` errors.
- Verify the dashboard displays the Circle card, source-address/chain/token fields, and network/source-type inputs.

## What distinguishes working from broken

- **Missing `getConfig()` fix:** if `settlePayment` could not read `cfg.circleSourceAddress`, the Circle engine would throw `CIRCLE_SOURCE_ADDRESS is required` or the settle call would fail with `getConfig is not defined`.
- **Broken Circle shadow settle:** if `CircleKitEngine.settle` did not return a `circle-shadow-` hash, `tx_hash` would be null and `payment.status` would be `failed`.
- **Broken source-of-funds sweep:** if `SourceOfFundsAdapter._fundSourceToTreasury` for `cash` failed, the approve action would error and no treasury hold would be created.
- **Broken treasury post:** if `TreasuryEngine.post` did not clear the hold and retain the fee, `hold_cents` would remain non-zero after settlement.

## Code references

- `server/integrations/stablecoin/stablecoinGateway.js` lines 236–286 (`settlePayment`, Circle branch).
- `server/integrations/stablecoin/circleKitEngine.js` lines 38–205 (`readiness`, `getSourceAddress`, `settle`).
- `server/integrations/stablecoin/sourceOfFundsAdapter.js` lines 85–104 (cash sweep), 229–248 (reserve), 250–294 (post).
- `public/dashboard.html` lines 1547–1606 (form and Circle card), 6705–6722 (Circle JS functions).
