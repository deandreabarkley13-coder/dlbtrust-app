# Test Plan — Sovereign Trust live gas-limit deploy (PR #238)

**Branch:** `devin/sovereign-gas-limit`  
**App:** `https://dlbtrust-app.fly.dev`  
**Admin token:** `dlb-admin-2026-trust`  
**Operator wallet:** `0x3e53028cf69949f3B961ce786Baf2D4D75166562`  
**Network:** mainnet (per current readiness response)  
**Starting ETH balance:** ~0.048476 ETH

## What changed

`server/integrations/dapp/sovereignTrustEngine.js` now uses explicit `gas` limits in `deployContracts()`:

- Forwarder deployment: `gas: 2500000n` (line 274)
- Token deployment: `gas: 5000000n` (line 288)

The token bytecode file is `32378` hex chars (`~16 KB`), so ~5M gas should cover the `G_CREATE` + `G_CODEDEPOSIT` cost. The forwarder is `8382` hex chars (`~4 KB`). `walletClient()` hard-codes EIP-1559 fees at `maxFeePerGas: 3 gwei`, `maxPriorityFeePerGas: 0.0015 gwei` (line 115). Current mainnet base fee is ~0.2 gwei, so 3 gwei is sufficient.

## TC1 — Deploy branch to Fly

1. Ensure the local working tree is on `devin/sovereign-gas-limit` and clean.
2. Run `fly deploy --app dlbtrust-app --yes`.
3. Wait for the build and deployment to complete.

**Pass criteria:**
- `fly deploy` exits with code 0.
- `flyctl status --app dlbtrust-app` shows a new deployment version and `started` machines.

**Fail criteria:**
- Build fails or deployment exits non-zero. Capture the final error lines.

## TC2 — Pre-deploy readiness baseline

1. `GET https://dlbtrust-app.fly.dev/api/dapp/sovereign-trust/readiness` with `x-admin-token: dlb-admin-2026-trust`.

**Pass criteria:**
- `success: true`.
- `data.mode` is `live` and `data.network` is `mainnet`.
- `data.ready` is `false` because no token/forwarder is deployed yet.
- `data.issues` contains `SOVEREIGN_TOKEN_ADDRESS not set or shadow` and `SOVEREIGN_FORWARDER_ADDRESS not set or shadow`.

**Fail criteria:**
- `mode` is `shadow`, `network` is not `mainnet`, or the request errors.

## TC3 — Deploy Sovereign Trust Token and Forwarder on mainnet

1. `POST https://dlbtrust-app.fly.dev/api/dapp/sovereign-trust/deploy` with `x-admin-token: dlb-admin-2026-trust` and empty body `{}`.
2. The server will wait for transaction receipts (timeout 120s each).

**Pass criteria:**
- Response `success: true`.
- `data.shadow` is `false`.
- `data.token` is a checksummed `0x...` mainnet address.
- `data.forwarder` is a checksummed `0x...` mainnet address.
- `data.operator` is `0x3e53028cf69949f3B961ce786Baf2D4D75166562`.
- Both contract addresses have non-zero code at `eth_getCode` on mainnet.
- The operator ETH balance decreases by a reasonable deploy cost (< 0.03 ETH).

**Fail criteria:**
- Response `success: false` or any error.
- Token/forwarder address is missing or starts with `shadow-`.
- `eth_getCode` for either address returns `0x`.
- If deploy fails, capture the transaction hash from the response or Fly logs.

## TC4 — Post-deploy readiness

1. `GET https://dlbtrust-app.fly.dev/api/dapp/sovereign-trust/readiness`.
2. `GET https://dlbtrust-app.fly.dev/api/dapp/sovereign-trust/token`.

**Pass criteria:**
- Readiness `data.ready` is `true`.
- Readiness `data.issues` is empty.
- Readiness `data.token.address` and `data.forwarder.address` match the deploy response.
- Token info `data.deployed` is `true` and `data.token_address` / `data.forwarder_address` are the same live addresses.

**Fail criteria:**
- `ready` remains `false` or issues remain.
- Token info `deployed` is `false`.

## TC5 — (Optional) Mint SIT and verify balance

1. `POST https://dlbtrust-app.fly.dev/api/dapp/sovereign-trust/mint` with:
   ```json
   {
     "sourceType": "treasury",
     "sourceAccountId": "TREASURY_HOT",
     "amount": "0.01",
     "to": "0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16",
     "memo": "PR #238 live mint test"
   }
   ```
2. Wait for the response.
3. `GET https://dlbtrust-app.fly.dev/api/dapp/sovereign-trust/balance/0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16`.

**Pass criteria:**
- Mint returns `success: true`, an `orderId`, and an on-chain `tx` hash.
- Balance endpoint returns `balance: "0.01"` (or `10000` raw units).
- The `tx` hash is confirmed on mainnet (status success).

**Fail criteria (acceptable if reserve config is not ready):**
- Mint fails because `SOVEREIGN_RESERVE_ACCOUNT` defaults to a non-existent ledger (`SOVEREIGN_RESERVE`). Capture the exact error.
- If mint succeeds on-chain but balance is not updated, report the `tx` hash and contract state.

## TC6 — Final operator ETH balance and summary

1. Query `eth_getBalance` for `0x3e53028cf69949f3B961ce786Baf2D4D75166562`.

**Pass criteria:**
- Final balance is reported.
- If deploy and optional mint succeeded, balance is > 0 and the total gas spend is recorded.

**Fail criteria:**
- Cannot query balance.

## Evidence to collect

- `fly deploy` output (last 50 lines).
- `flyctl status` after deploy.
- Readiness responses before and after deploy.
- Deploy response JSON.
- `eth_getCode` results for token and forwarder.
- Operator ETH balance before/after.
- Mint request/response and balance (if attempted).
- Fly logs if any step fails.
