# Live value runbook: Smart Router gate + thirdweb treasury funding → server-wallet send

Two independent paths let the trust move real value. Both are shadow by default
and fail closed until every gate on the path is open.

```
fiat (trust card/bank)                      authority + book of record: ERP (canonical:1000)
  → thirdweb Universal Bridge checkout        ── Fineract GL post on settle ────┐
  → THIRDWEB_SERVER_WALLET_ADDRESS (Base)     DR 1210 crypto / CR 1000 cash     ┘
  → ThirdwebServerWalletEngine.send()         → beneficiary / vendor wallet

SmartRouterEngine.deliver()  (SMART_ROUTER_LIVE)
  → fiat        PaymentGatewayServerEngine    PAYMENT_MODE=production | PAYMENT_HUB_LIVE=true
  → stablecoin  StablecoinGateway             STABLECOIN_MODE=mainnet (+STABLECOIN_ENABLED, THIRDWEB_RAIL_ENABLED)
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
| `TREASURY_TOPUP_HOLD_SOURCE_TYPE` | `canonical` | the Fineract ERP is the availability authority and book of record (`CanonicalFundingSource.assertAvailable` / `.commit`); `trust` falls back to the local sub-ledger sweep |
| `TRUST_POLICY_ENFORCED` | `false` | see §5 |

Smart Router rail gates (all live except canonical, which needs a signer secret):

| Variable | Value | Rail | Why |
| --- | --- | --- | --- |
| `PAYMENT_HUB_LIVE` | `true` | fiat | `_route` marks fiat `live`; `PaymentGatewayServerEngine.sale` still needs the chosen processor's credentials (Stripe / Moov / ACH) to settle |
| `STABLECOIN_ENABLED` | `true` | stablecoin | `StablecoinGateway.readiness().ready` is false without it, so the rail is never a candidate |
| `STABLECOIN_MODE` | `mainnet` | stablecoin | gateway accepts `disabled\|shadow\|testnet\|mainnet`; the router treats `mainnet` (or legacy `live`) as live |
| `STABLECOIN_NETWORK` | `thirdweb` | stablecoin | settle through the pinned thirdweb server wallet instead of Stellar |
| `THIRDWEB_RAIL_ENABLED` | `true` | stablecoin | required for `STABLECOIN_NETWORK=thirdweb` |
| `FUNDING_LIVE` | `true` | funding | `FundingEngine.executePlan` runs instead of returning a shadow plan |
| `DAPP_SHADOW` | `false` | canonical | already false; **`DAPP_PRIVATE_KEY`** (secret) must also be set or the canonical rail is never a candidate |

Optional guard rails worth setting before the first live send:
`THIRDWEB_SERVER_WALLET_ALLOWED_RECIPIENTS` (comma-separated allowlist),
`THIRDWEB_SERVER_WALLET_MAX_QUANTITY` (smallest units), `TREASURY_TOPUP_MAX_USD`,
`THIRDWEB_SERVER_WALLET_MIN_GAS_WEI`.

### 1a. Production state (Northflank `dlbtrust-app`)

Everything above is applied. Notes that differ from the defaults in this document:

- The pinned wallet in production is `DLBT-FTC` at
  `0x1A904F795a0511C31Ba6347504D08d1bA58E4f89` on Base (`8453`), not the
  `dlbtrust-treasury` example wallet.
- `TREASURY_TOPUP_HOLD_SOURCE_TYPE=canonical`, `TREASURY_TOPUP_HOLD_ACCOUNT_ID=1000`
  (Fineract GL `1000` Trust Cash & Equivalents). The ERP is the authority:
  `GET /api/dapp/canonical-source/position` must show `fundingEligible: true` and
  drift `0`, and a settled top-up is booked into Fineract (the top-up record
  carries `bookOfRecord: "fineract"`, `journalEntryId`, `fineractTransactionId`,
  `bookedAt`). `trust:1000` is no longer the book of record for top-ups.
- `TRUST_POLICY_ENFORCED=true` in production (a `TRUST_POLICY_ADDRESS` is set),
  so direct `server-wallet/send` is refused with `409 TRUST_POLICY_ENFORCED` even
  though readiness reports `canSend: true` — value must go through the
  TrustDistributionPolicy maker/checker path (§5). Set it to `false` only if the
  trustee explicitly wants direct sends.
- The service also carries **service-level** runtime environment variables that
  take precedence over the `dlbtrust-runtime` secret group. `STABLECOIN_MODE` and
  `STABLECOIN_NETWORK` had to be changed there as well
  (`POST /v1/projects/dlbtrust/services/dlbtrust-app/runtime-environment`, merged,
  never a partial body); if a group change does not show up in
  `/api/os/smart-router/status` after a restart, check the service-level env.
- Secret-group changes are not picked up until the service restarts
  (`POST /v1/projects/dlbtrust/services/dlbtrust-app/restart`).
- Treasury wallet balance is still 0 ETH / 0 USDC: the first top-up plus Base ETH
  for gas is the remaining prerequisite before any outbound send.
- `SPRITZ_PAYOUT_WALLET` / `SPRITZ_PAYOUT_WALLET_PROVIDER` were also pinned at the
  service level (to the old Coinbase wallet) and had to be changed there as well
  as in the group; both now point at `DLBT-FTC` / `thirdweb`, and
  `SPRITZ_BILLPAY_LIVE=true` is set in both places. `GET /spritz/wallet` reports
  `signer.type: thirdweb`.
- The Spritz Bill Pay engine in `treasury_wallet` funding mode signs through
  `ThirdwebServerWalletEngine.sendTransactions` (Spritz approve + payment
  calldata), which is not subject to the `TRUST_POLICY_ENFORCED` direct-send
  refusal. `scripts/spritz-pipeline.cjs settle` still releases through the
  policy contract first, so that path needs the policy funded.

`SMART_ROUTER_LIVE=true` on its own only changes `status.mode` to `live`; `deliver`
still refuses every rail whose own gate is closed (`Rail <rail> is not live or not
available`). With the table above applied, `route` reports `canExecute: true` for
fiat, stablecoin and funding; canonical stays closed until `DAPP_PRIVATE_KEY` exists.

## 1b. One automated entry point: `trust:runbook`

`server/integrations/os/liveValueRunbookOsEngine.js` (`LiveValueRunbookOsEngine`,
OS engine `live-value-runbook`) orchestrates §2–§4 over the engines that own each
stage — thirdweb treasury funding, FundingEngine (gas), Collateral OS, the Spritz
treasury leg, thirdweb settlement, and the trust control plane — without
reimplementing any of them.

```sh
npm run trust:runbook                                   # readiness + pipeline, read-only
npm run trust:runbook -- --plan --amount 250 --role beneficiary --purpose medical
npm run trust:runbook -- --execute --amount 250         # shadow: records what would run, moves nothing
npm run trust:runbook -- --execute --amount 250 --live  # broadcasts only if every relevant *_LIVE gate is set
npm run trust:runbook -- --strict [--json]              # exit 2 on any blocking gate (deploy gate)
```

- `readiness` lists every gate as `{ key, label, ok, detail, blocking }` (same shape
  as the Spritz pipeline stages the dashboards render): thirdweb API, pinned server
  wallet, `THIRDWEB_SERVER_WALLET_LIVE`, `THIRDWEB_SHADOW`, `THIRDWEB_GAS_SPONSORSHIP_LIVE`,
  `CANONICAL_FUNDING_LIVE`, `SMART_ROUTER_LIVE`, `TRUST_POLICY_ENFORCED`/`TRUST_POLICY_LIVE`,
  the Spritz `signer.type`, Collateral OS, treasury ETH/USDC and ERP `fundingEligible`.
- `plan` orders the steps for an amount — pre-flight (`evaluateDistribution`), §4a
  top-up, §4b book, gas, §4c collateral draw + checker approval, §4e governed
  settlement (`CollateralOsEngine.settle` → checker → `executeSettlement`), reconcile —
  and marks each `canExecute` or blocked with the exact reason.
- `execute` runs the executable steps in order and STOPS at the first human step
  (the §4a hosted checkout link, a checker approval) or closed gate with an
  actionable message. It is shadow unless `--live` is passed AND the live gates are
  open; settlement always goes through the policy contract and Spritz leg, never a
  raw server-wallet send.

Over HTTP: `POST /api/os/live-value-runbook/process` with
`{ action: 'readiness' | 'plan' | 'execute' | 'pipeline', amountUsd, role, purpose, live }`.

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

Prerequisites the trustee must supply: the secrets in §1, a canonical source that
covers the amount (`GET /api/dapp/canonical-source/position` — the top-up is
refused with `INSUFFICIENT_CANONICAL_FUNDS` otherwise), and enough ETH on
`0x95bb85FdeC42b1517d282e8AD43A789d390aAda2` for gas (an ERC-20 send with
`THIRDWEB_SERVER_WALLET_FUNDING_PREFLIGHT=true` is refused if the wallet cannot
cover gas).

### 4a. Fund the treasury wallet (fiat → USDC on Base)

```sh
node server/scripts/thirdwebTreasuryFundingWire.js \
  --amount 1000 --currency USD \
  --source-type canonical --source-account 1000
```

The script quotes the fiat amount, asserts availability against the ERP, creates a hosted
thirdweb checkout and prints `checkout: https://...` plus the top-up id
(`TWTOP-...`). A trustee completes the checkout link with the trust's card or bank
account; tokens are delivered to the server wallet when the bridge settles.

### 4b. Book the settled top-up

```sh
node server/scripts/thirdwebTreasuryFundingWire.js --sync TWTOP-<id>
```

Polls thirdweb; on `COMPLETED` the journal entry `DR 1210 / CR 1000` is posted
once through `CanonicalFundingSource.commit` — the local trust journal *and* the
Fineract GL (`booked: true`, `bookOfRecord: "fineract"`, `journalEntryId`,
`fineractTransactionId`). Re-running is idempotent (a booked record never
commits again). `PENDING` means the checkout has not settled yet — run again
later. If `CANONICAL_FUNDING_LIVE` is off the commit is shadow and the record
stays `booked: false` so the next sync retries. With `--source-type trust` the
fiat is instead swept from the sub-ledger hold account (`bookOfRecord: "trust_ledger"`).

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

### 4e. Fiat out through the thirdweb wallet (Spritz payouts)

Set `SPRITZ_PAYOUT_WALLET` to the pinned `THIRDWEB_SERVER_WALLET_ADDRESS`
(`SPRITZ_PAYOUT_WALLET_PROVIDER=thirdweb` is informational). The payout signer
then reports `type: thirdweb` in `GET /spritz/wallet` / treasury readiness, and
`executePayout` (treasury payout) and bill-pay both sign the Spritz approve +
payment calldata through the thirdweb API and book the GL entry once each
transaction is `CONFIRMED` — no Coinbase signing step, no `/confirm` call.
Requires `THIRDWEB_SERVER_WALLET_LIVE=true` (otherwise
`409 PAYOUT_SIGNER_NOT_LIVE`), the wallet allow-listed as a beneficiary on the
policy contract, and USDC + Base ETH in the wallet (otherwise
`409 PAYOUT_WALLET_UNDERFUNDED`). The governed path is unchanged: the
distribution is still released via `TrustPolicyEngine.execute` first.

```sh
node scripts/northflank/set-secrets.mjs --group dlbtrust-runtime \
  SPRITZ_PAYOUT_WALLET=0x1A904F795a0511C31Ba6347504D08d1bA58E4f89 \
  SPRITZ_PAYOUT_WALLET_PROVIDER=thirdweb
# restart the service, then check GET /spritz/wallet -> signer.type === 'thirdweb'
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
