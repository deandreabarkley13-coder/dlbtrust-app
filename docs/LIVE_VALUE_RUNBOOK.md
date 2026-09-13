# Live value runbook: Smart Router gate + thirdweb treasury funding → server-wallet send

Two independent paths let the trust move real value. Both are shadow by default
and fail closed until every gate on the path is open.

```
fiat (trust card/bank)                      hold account (trust:1000)
  → thirdweb Universal Bridge checkout        ── swept + journalled on settle ──┐
  → THIRDWEB_SERVER_WALLET_ADDRESS (Base)     DR 1210 crypto / CR 1000 cash     ┘
  → ThirdwebServerWalletEngine.send()         → beneficiary / vendor wallet

SmartRouterEngine.deliver()  (SMART_ROUTER_LIVE)
  → fiat        PaymentGatewayServerEngine    PAYMENT_MODE=production | PAYMENT_HUB_LIVE=true
  → stablecoin  StablecoinGateway             STABLECOIN_MODE=live
  → canonical   CanonicalMoneyEngine          DAPP_PRIVATE_KEY + DAPP_SHADOW=false
  → funding     FundingEngine                 FUNDING_LIVE=true
```

## 1. Secrets and flags the deployment secret store must hold

Set these in the Northflank `dlbtrust-runtime` secret group
(`node scripts/northflank/set-secrets.mjs --group dlbtrust-runtime KEY=value ...`).
Never commit any of them.

| Variable | Value | Why |
| --- | --- | --- |
| `SMART_ROUTER_LIVE` | `true` | `SmartRouterEngine._isLive()`; `deliver` throws without it |
| `THIRDWEB_SERVER_WALLET_ENABLED` | `true` | kill switch for the server-wallet rail |
| `THIRDWEB_SERVER_WALLET_LIVE` | `true` | `send` is a shadow record until set |
| `THIRDWEB_SHADOW` | `false` | account-abstraction / gas sponsorship leg calls thirdweb |
| `THIRDWEB_SECRET_KEY` | project secret key | **secret** — authenticates every thirdweb call (`x-secret-key`) |
| `THIRDWEB_SERVER_WALLET_ADDRESS` | `0x95bb85FdeC42b1517d282e8AD43A789d390aAda2` | pinned `dlbtrust-treasury` server wallet; `canSend` is false without it |
| `THIRDWEB_SERVER_WALLET_IDENTIFIER` | `dlbtrust-treasury` | identifier the pinned wallet was created from |
| `THIRDWEB_SERVER_WALLET_CHAIN_ID` | `8453` | Base mainnet (defaults to `DAPP_CHAIN_ID`) |
| `TREASURY_TOPUP_HOLD_ACCOUNT_ID` | `1000` (or the funded hold account) | fiat for a top-up is drawn from `TREASURY_TOPUP_HOLD_SOURCE_TYPE:this` |
| `TREASURY_TOPUP_HOLD_SOURCE_TYPE` | `trust` | `canonical` makes the Fineract ERP the availability authority |
| `TRUST_POLICY_ENFORCED` | `false` | see §5 |

Optional guard rails worth setting before the first live send:
`THIRDWEB_SERVER_WALLET_ALLOWED_RECIPIENTS` (comma-separated allowlist),
`THIRDWEB_SERVER_WALLET_MAX_QUANTITY` (smallest units), `TREASURY_TOPUP_MAX_USD`,
`THIRDWEB_SERVER_WALLET_MIN_GAS_WEI`.

The Smart Router rail gates (`PAYMENT_MODE`, `STABLECOIN_MODE`, `DAPP_PRIVATE_KEY`,
`FUNDING_LIVE`) are **not** flipped by this runbook. `SMART_ROUTER_LIVE=true` on its
own only changes `status.mode` to `live`; `deliver` still refuses every rail whose
own gate is closed (`Rail <rail> is not live or not available`).

## 2. Readiness (nothing moves)

```sh
npm run trust:treasury-funding        # node server/scripts/thirdwebTreasuryFundingWire.js
npm run trust:server-wallet           # node server/scripts/thirdwebServerWalletWire.js
```

Expected: funding readiness `canTopUp: true, ready: true, issues: []`; server-wallet
readiness `canSend: true, ready: true` and `using pinned THIRDWEB_SERVER_WALLET_ADDRESS`.
Both scripts print the treasury balances (ETH and USDC on Base).

Over HTTP: `GET /api/dapp/thirdweb/server-wallet/readiness` and
`GET /api/os/smart-router/status` (`x-admin-token`).

## 3. Shadow proof (server running, no live secret)

```sh
SMART_ROUTER_LIVE=false THIRDWEB_SERVER_WALLET_LIVE=false THIRDWEB_SHADOW=true \
  node server/server-3002.js &
node server/scripts/osEngineSmokeTest.js       # smart-router: status/health/route/deliver/receipt/confirm/get
node server/scripts/valueWorkflowSmokeTest.js  # OTP → smart wallet → SIWE → ramp quote → propose/approve/execute → anchor → reconcile
```

`deliver` returns `mode: "shadow"` with the full routing plan and a
`smart_router_payments` row in status `shadow`; `confirm` and `get` read it back.

## 4. Moving real value (operator commands)

Prerequisites the trustee must supply: the secrets in §1, a funded hold account
(`trust:1000` seeds at $0.00 — the top-up is refused with
`INSUFFICIENT_SOURCE_FUNDS` until it carries the fiat), and enough ETH on
`0x95bb85FdeC42b1517d282e8AD43A789d390aAda2` for gas (an ERC-20 send with
`THIRDWEB_SERVER_WALLET_FUNDING_PREFLIGHT=true` is refused if the wallet cannot
cover gas).

### 4a. Fund the treasury wallet (fiat → USDC on Base)

```sh
node server/scripts/thirdwebTreasuryFundingWire.js \
  --amount 1000 --currency USD \
  --source-type trust --source-account 1000
```

The script quotes the fiat amount, checks the hold account, creates a hosted
thirdweb checkout and prints `checkout: https://...` plus the top-up id
(`TWTOP-...`). A trustee completes the checkout link with the trust's card or bank
account; tokens are delivered to the server wallet when the bridge settles.

### 4b. Book the settled top-up

```sh
node server/scripts/thirdwebTreasuryFundingWire.js --sync TWTOP-<id>
```

Polls thirdweb; on `COMPLETED` the fiat is swept from the hold account and the
journal entry `DR 1210 / CR 1000` is posted once (`booked: true`). Re-running is
idempotent. `PENDING` means the checkout has not settled yet — run again later.

### 4c. Send value out of the server wallet

```sh
node server/scripts/thirdwebServerWalletWire.js --live \
  --send <recipient 0x…> <quantity in smallest units> \
  --token 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  --usd <amount USD> --role trustee --purpose lifestyle --wait
```

* `quantity` is in smallest units: USDC has 6 decimals, so `250 USDC` = `250000000`;
  omit `--token` to send native ETH (18 decimals, wei).
* `--usd` is cross-checked against the thirdweb price oracle and must agree within
  `THIRDWEB_PRICE_TOLERANCE_PCT` (5%) or the send fails with `PRICE_MISMATCH`.
* `--role` is `beneficiary` ($100,000 per-transaction limit) or `trustee` ($500,000).
* `--purpose` is one of `lifestyle|medical|travel|home|education` (required for a send).
* `--wait` polls the thirdweb transaction to a terminal status and exits non-zero
  unless it is `CONFIRMED`.

Without `--live` (and with `THIRDWEB_SERVER_WALLET_LIVE` unset) the same command
records a shadow transfer and broadcasts nothing — run it that way first.

The HTTP equivalent is `POST /api/dapp/thirdweb/server-wallet/send`
(`adminAuth`) with `{ to, quantity, tokenAddress, amountUsd, requesterRole, purpose }`.

### 4d. Smart Router (once a rail's own gate is open)

```sh
curl -X POST localhost:3002/api/os/smart-router/process -H "x-admin-token: $ADMIN_SECRET_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"action":"route","amount":100,"currency":"USDC","destination":{"address":"0x…"},"preferred":"stablecoin"}'
# review candidates[].live / canExecute, then action:"deliver" with the same payload, then action:"confirm" with the paymentId
```

## 5. `TRUST_POLICY_ENFORCED`

Left `false`. With `false`, `ThirdwebServerWalletEngine.send` is allowed to move
value directly, governed only by the off-chain `DistributionPolicy` (role
limits, purpose codes, allowlist, quantity ceiling). With `true` **and**
`TRUST_POLICY_ADDRESS` set, every direct server-wallet transfer is refused with
`409 TRUST_POLICY_ENFORCED` and value may only leave through the on-chain
`TrustDistributionPolicy` contract (beneficiary allow-list, maker/checker
approval, timelock, escrow/clawback, freeze). Flip it to `true` once the policy
contract (`0x9682bEF7fbA219DB0dF7A52B5b7151484aFceB64` on Base) is funded and
`TRUST_POLICY_LIVE=true`; until then `true` would block all outbound value.
