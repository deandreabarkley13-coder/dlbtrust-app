# Beneficiary go-live checklist (coupon_income rail)

Scope: the beneficiary distribution rail only.

```
thirdweb Universal Bridge top-up                       DR 1210 crypto / CR 1000 cash   (§4a/§4b, CanonicalFundingSource.commit)
  → DLBT-FTC server wallet 0x1A904F795a0511C31Ba6347504D08d1bA58E4f89 (Base 8453)
  → SpritzTreasuryLegEngine.stagePayout   (Spritz off-ramp quote + TrustPolicyEngine.propose, bucket coupon_income)
  → TrustDistributionPolicy 0x9682bEF7fbA219DB0dF7A52B5b7151484aFceB64  (maker propose → checker approve → 24h release delay → execute)
  → SpritzTreasuryLegEngine.executePayout (policy release → payQuoteFromServerWallet approve+payment via thirdweb)
  → Spritz off-ramp → DB NET MGMT settlement bank        DR 2000 distributions / CR 1210 crypto (+ DR fee)   (_bookPayout)
```

Vendor bill pay (nickel/melio) and the trustee `trust_operating` bucket are out of scope.
Nothing in this checklist broadcasts a transaction; every command below is read-only
or shadow until the final §D command with `--live`.

Evidence was captured on 2026-09-15 against `main` (36e00d0) with a local server
configured with the production *public* values (wallet, policy, chain, token,
`SPRITZ_PAYOUT_WALLET_PROVIDER=thirdweb`) and every `*_LIVE` flag unset.

## 0. Test / lint / typecheck (step 1)

| Check | Result |
| --- | --- |
| `npm run lint` | exit 0, 0 errors (179 pre-existing warnings) |
| `npm run typecheck` | exit 0 |
| `npx vitest run` (full) | 88/95 files, 1,286/1,391 tests passed; the 7 file aborts are the known better-sqlite3 native teardown (`Assertion failed: (env) != nullptr`), no test assertion failed |
| `npx vitest run tests/spritzTreasuryLeg.test.ts tests/thirdwebTreasuryFunding.test.ts` | 2/2 files, 36/36 tests passed |

Note: the full suite leaks a fixture top-up (`TWTOP-…`, link `https://thirdweb.com/pay/pay_c`,
from `tests/canonicalFundingSource.test.ts`) into the local state store; the local runbook
then "resumes" it. It is not a real checkout. Production state is unaffected.

## A. Gates for this rail (steps 2 + 3)

`npm run trust:runbook -- --strict --json` exit 2 (shadow, 4 blocking). Stage → how to close it.
"Prod" is the Northflank `dlbtrust-runtime` secret group (`node scripts/northflank/set-secrets.mjs --group dlbtrust-runtime KEY=value …`) **and**, where noted, the service-level runtime env (`POST /v1/projects/dlbtrust/services/dlbtrust-app/runtime-environment`, merged body), followed by `POST /v1/projects/dlbtrust/services/dlbtrust-app/restart`.

| key | label | ok (local shadow) | blocking | detail | closes with |
| --- | --- | --- | --- | --- | --- |
| `thirdwebApi` | thirdweb API (Universal Bridge top-up) | true | yes | `thirdweb-bridge chain 8453, hold canonical:1000` | `THIRDWEB_SECRET_KEY`, `TREASURY_TOPUP_HOLD_SOURCE_TYPE=canonical`, `TREASURY_TOPUP_HOLD_ACCOUNT_ID=1000` (already set in prod, §1a) |
| `serverWallet` | pinned thirdweb server wallet | true | yes | `0x1A90…4f89 chain 8453 (shadow)` | `THIRDWEB_SERVER_WALLET_ADDRESS=0x1A904F795a0511C31Ba6347504D08d1bA58E4f89`, `THIRDWEB_SERVER_WALLET_IDENTIFIER=DLBT-FTC`, `THIRDWEB_SERVER_WALLET_CHAIN_ID=8453` |
| `serverWalletLive` | THIRDWEB_SERVER_WALLET_LIVE | false | no | shadow: outbound legs recorded | `THIRDWEB_SERVER_WALLET_LIVE=true` — required for `payQuoteFromServerWallet` (else `409 PAYOUT_SIGNER_NOT_LIVE`) and for the runbook `settle`/`release` steps |
| `thirdwebShadow` | THIRDWEB_SHADOW=false | false | no | sponsorship leg simulated | `THIRDWEB_SHADOW=false` (part of `liveGatesOpen`; `--live` is downgraded to shadow without it) |
| `gasSponsorship` | THIRDWEB_GAS_SPONSORSHIP_LIVE | false | no | not sponsoring; wallet must hold ≥ 0.003 ETH | Not needed if DLBT-FTC holds Base ETH (§C-a). Otherwise §4-gas of the runbook |
| `canonicalFunding` | Fineract canonical funding source (§4b book of record) | false (local: no Fineract) | yes | `FINERACT_URL still points at localhost` | `CANONICAL_FUNDING_LIVE=true` + reachable `FINERACT_URL`/creds (prod already has Fineract). Without it a settled top-up stays `booked:false` |
| `smartRouter` | SMART_ROUTER_LIVE | false | no | not on this rail | none required for this rail |
| `trustPolicy` | TrustDistributionPolicy | false | yes | `0x9682… enforced=false live=false` | `TRUST_POLICY_ADDRESS=0x9682bEF7fbA219DB0dF7A52B5b7151484aFceB64`, `TRUST_POLICY_LIVE=true` (+ `TRUST_POLICY_ENFORCED=true` as prod already has). Without `TRUST_POLICY_LIVE` `stagePayout` records a shadow proposal with no on-chain distribution |
| `signer` | Spritz payout signer = thirdweb | **true** | yes | `signer.type thirdweb` | `SPRITZ_PAYOUT_WALLET=0x1A904F795a0511C31Ba6347504D08d1bA58E4f89`, `SPRITZ_PAYOUT_WALLET_PROVIDER=thirdweb` — set at **group and service level** (§1a), then restart; verify `GET /api/finops/spritz/wallet` → `signer.type === 'thirdweb'`, `address === DLBT-FTC` |
| `collateralOs` | Collateral OS destination | true | yes | `destination 0x9682… chain 8453` | `COLLATERAL_OS_ENABLED=true`, destination = policy address (the runbook's §4c draw leg; already true) |
| `settlementReconcile` | thirdweb settlement reconcile | false | no | `THIRDWEB_WEBHOOK_SECRET not configured` | `THIRDWEB_WEBHOOK_SECRET` (optional; poll path still books) |
| `treasuryEth` | Treasury ETH ≥ 0.003 | false | yes | on-chain: **0 ETH** on DLBT-FTC | §C-a: deposit ~0.005 Base ETH to `0x1A904F795a0511C31Ba6347504D08d1bA58E4f89` |
| `treasuryUsdc` | Treasury USDC | false | no | on-chain: **0 USDC** on DLBT-FTC | §C-a top-up |
| `fundingEligible` | ERP position fundingEligible, drift 0 | false (local) | yes | Fineract circuit breaker open locally | prod: `GET /api/dapp/canonical-source/position` must show `fundingEligible:true`, `driftCents:0`, `availableBalanceCents ≥ amount` |

Endpoint readiness (same run):

| endpoint | key | ok | blocking | closes with |
| --- | --- | --- | --- | --- |
| `GET /api/dapp/thirdweb/server-wallet/readiness` | `ready` | true | — | — |
| | `canSend` | false | yes | `THIRDWEB_SERVER_WALLET_LIVE=true` + `THIRDWEB_VAULT_ACCESS_TOKEN` (`vaultAccessTokenConfigured:false` locally) |
| `GET /api/finops/spritz/treasury/readiness` | `payoutWalletSigner.type` | thirdweb | — | — |
| | `coupon_income funding source` | false | yes | "No canonical liquidity pool found" — create the coupon_income pool (TrustAllocationEngine) before `fund()`; not needed when the wallet is funded via the thirdweb top-up |
| | Spritz API `GET /v1/users/me` | false | yes | valid `SPRITZ_API_KEY` (the key provisioned in this Devin environment returns 401 — rotate/replace it in the Devin secret store; prod uses its own) |
| | settlement destination | false | yes | link the DB NET MGMT bank account in Spritz (`SpritzEngine.listBankAccounts` must return it; pass `bankAccountId` or set the default) |
| `GET /api/dapp/canonical-source/position` | `fundingEligible` | false (local) | yes | reachable Fineract; `segregationStatus` must be `eligible` |
| `GET /api/dapp/trust-policy/readiness` | `ready` | true | — | — |
| | `checkerSignerConfigured` / `checkerLive` | false | yes (for approve) | `TRUST_POLICY_CHECKER_PRIVATE_KEY`, `TRUST_POLICY_CHECKER_RPC_URL=https://mainnet.base.org`, `TRUST_POLICY_CHECKER_LIVE=true` |
| | `live` | false | yes | `TRUST_POLICY_LIVE=true` |
| `GET /api/finops/spritz/wallet` | `signer.type` | **thirdweb** | — | confirmed (step 3) |
| | `registry` | null | yes | one-time `POST /api/finops/spritz/wallet/connect { address: 0x1A90…4f89, provider: 'thirdweb' }` |
| | `policy.allowed` | **false** (on-chain `beneficiaryAllowed(DLBT-FTC)=false`) | yes | §C-b |

Step 3 set-secrets command if `signer.type` is ever not `thirdweb` in prod:

```sh
node scripts/northflank/set-secrets.mjs --group dlbtrust-runtime \
  SPRITZ_PAYOUT_WALLET=0x1A904F795a0511C31Ba6347504D08d1bA58E4f89 \
  SPRITZ_PAYOUT_WALLET_PROVIDER=thirdweb
# also at service level (takes precedence over the group):
#   POST /v1/projects/dlbtrust/services/dlbtrust-app/runtime-environment (merged body with the same two keys)
# then: POST /v1/projects/dlbtrust/services/dlbtrust-app/restart
curl -s -H "x-admin-token: $ADMIN_SECRET_TOKEN" "$BASE/api/finops/spritz/wallet" | jq '.data.signer.type, .data.address'
```

## B. Shadow run (step 4)

`npm run trust:runbook -- --execute --amount 250 --role beneficiary --purpose medical --json`
→ `mode: shadow`, `moved: false`, `bucket: coupon_income`, exit 0. Recorded plan/results:

| step | § | status | message |
| --- | --- | --- | --- |
| `preflight` | §2 | shadow | mandate / distribution policy pre-flight passed (beneficiary ≤ $100,000, purpose `medical`) |
| `selfFund` | §4a-alt | skipped | `DAPP_PRIVATE_KEY` not configured (optional swap path) |
| `topUp` | §4a | shadow | would sync/create the thirdweb hosted checkout → USDC to DLBT-FTC |
| `book` | §4b | shadow | would book the settled top-up **DR 1210 / CR 1000**; "live would need CANONICAL_FUNDING_LIVE" |
| `gas` | §4 | **stopped** | treasury holds 0 ETH and FundingEngine funds the operator, not the treasury → deposit ≥ 0.003 ETH to DLBT-FTC (§C-a) |
| `draw` / `fund` | §4c | pending | (not reached) |
| `settle` | §4e | pending | plan reason: `TRUST_POLICY_LIVE=false … ; THIRDWEB_SERVER_WALLET_LIVE not set` → `CollateralOsEngine.settle` → `SpritzTreasuryLegEngine.stagePayout` (Spritz off-ramp quote, `coupon_income`, `TrustPolicyEngine.propose`) |
| `release` | §4e | pending | human: checker approve + 24h delay → `executeSettlement` → `executePayout` → `payQuoteFromServerWallet` → **DR 2000 / CR 1210** (+ DR fee account) |
| `reconcile` | §4 | pending | |

The plan therefore contains the expected legs in the expected order; the shadow
run correctly stops at the first *funding* prerequisite (gas) rather than at any
code gate. GL entries confirmed from the engines:

- top-up book: `CanonicalFundingSource.commit` → `DR 1210 / CR 1000` (`liveValueRunbookOsEngine` step `book`).
- payout book: `SpritzTreasuryLegEngine._bookPayout` → `DR 2000 (SPRITZ_DISTRIBUTIONS_GL_ACCOUNT) gross / CR 1210 (SPRITZ_TREASURY_GL_ACCOUNT) gross+fee / DR fee account`, `referenceType: spritz_offramp`.

Direct engine dry-run (`SpritzTreasuryLegEngine.stagePayout` then `payQuoteFromServerWallet(quoteId, { dryRun: true })`):
`stagePayout` could not be exercised locally — it first reads `beneficiaryAllowed(DLBT-FTC)` through the thirdweb contract-read API, and both the thirdweb and Spritz keys available to this session return **401 Unauthorized** (see below). The on-chain state was read directly instead (Base public RPC): `beneficiaryAllowed(0x1A90…4f89) = false`, `frozen = false`, so in production `stagePayout` currently returns `409 PAYOUT_WALLET_NOT_ALLOWLISTED` until §C-b is done. Once it is, `payQuoteFromServerWallet(...{ dryRun:true })` returns `{ dryRun: true, live, signer: 'thirdweb', payoutWallet, steps: [{ kind:'approve', to: USDC }, { kind:'payment', to: <Spritz contract> }] }` (the approve step is omitted when the allowance already covers the quote) — covered by `tests/spritzTreasuryLeg.test.ts`.

Run the dry-run in production once the wallet is allow-listed:

```sh
northflank exec service --project dlbtrust --service dlbtrust-app --cmd 'sh -c "node -e \"
const {SpritzTreasuryLegEngine}=require(\\\"./server/integrations/spritz/spritzTreasuryLegEngine.js\\\");
(async()=>{const s=await SpritzTreasuryLegEngine.stagePayout({amountUsd:250,purpose:\\\"medical\\\",reference:\\\"GL-DRYRUN-\\\"+Date.now(),bucket:\\\"coupon_income\\\"});
console.log(JSON.stringify(await SpritzTreasuryLegEngine.payQuoteFromServerWallet(s.spritzQuoteId,{dryRun:true}),null,2));})()\""'
```
(With `TRUST_POLICY_LIVE=true` this creates a real Spritz quote and a real on-chain *proposal* — no value moves; cancel the proposal afterwards if it is not wanted.)

## C. Operator prerequisites that need secrets / funds (step 5)

On-chain state read 2026-09-15 (Base): policy owner `0xD7Fa15572dc6553FEaC54E2304E42dCe82443CB0`, `paused=false`, `approvalThreshold=1`, `releaseDelay=86400s`, `distributionCount=0`, policy USDC `0`, DLBT-FTC `0 USDC / 0 ETH`, checker `0x95bb85…aAda2` `0 ETH`.

Roles on the contract: DLBT-FTC = maker + executor; owner `0xD7Fa…` = pauser + compliance;
**no address checked (`0x95bb85…`, owner, DLBT-FTC, operator `0x3e53…`) holds the CHECKER role (1)**.
`Checker Approve` will revert until the owner grants it — see (b).

### (a) Fund DLBT-FTC — USDC via the Universal Bridge + Base ETH for gas

```sh
# ERP must cover it: GET /api/dapp/canonical-source/position → fundingEligible:true, driftCents:0
node server/scripts/thirdwebTreasuryFundingWire.js --amount 250 --currency USD --source-type canonical --source-account 1000
#   → prints checkout: https://… and TWTOP-<id>; a trustee completes the link with the trust card/bank
node server/scripts/thirdwebTreasuryFundingWire.js --sync TWTOP-<id>      # on COMPLETED books DR 1210 / CR 1000 (needs CANONICAL_FUNDING_LIVE=true)
# gas: send ~0.005 Base ETH to 0x1A904F795a0511C31Ba6347504D08d1bA58E4f89 (declare first: POST /api/dapp/treasury-deposits { amount, tokenAddress: null }, then /sync)
```

### (b) Allow-list the payout wallet + grant the checker role (contract owner signs)

The setters are `onlyOwner`; the server wallet cannot sign them. Generate the unsigned txs:

```sh
# unsigned owner txs (from 0xD7Fa…, to 0x9682…, chainId 8453)
curl -s -X POST -H "x-admin-token: $ADMIN_SECRET_TOKEN" -H 'content-type: application/json' \
  "$BASE/api/finops/spritz/wallet/allowlist/prepare" -d '{"maxPerDistributionUsd":100000,"periodCapUsd":0,"periodSeconds":0}'
# equivalent: SpritzTreasuryLegEngine.prepareAllowlistPayoutWallet({ maxPerDistributionUsd: 100000, periodCapUsd: 0, periodSeconds: 0 })
#             TrustPolicyEngine.prepareBeneficiaryAllowlist({ beneficiary: DLBT-FTC, token: USDC, maxPerDistribution: '100000000000' })
```

Pre-encoded calldata (verified with viem; `to = 0x9682bEF7fbA219DB0dF7A52B5b7151484aFceB64`, `value = 0`):

| tx | function | data |
| --- | --- | --- |
| 1 | `setBeneficiary(0x1A904F795a0511C31Ba6347504D08d1bA58E4f89, true)` | `0x7eb5da0d0000000000000000000000001a904f795a0511c31ba6347504d08d1ba58e4f890000000000000000000000000000000000000000000000000000000000000001` |
| 2 | `setBeneficiaryLimits(DLBT-FTC, USDC 0x8335…2913, 100000e6, 0, 0)` | `0x566bb7bc0000000000000000000000001a904f795a0511c31ba6347504d08d1ba58e4f89000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000000000000000000000000000000000174876e80000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000` |
| 3 | `setRole(1 /*CHECKER*/, 0x95bb85FdeC42b1517d282e8AD43A789d390aAda2, true)` | `0x50c6d02e000000000000000000000000000000000000000000000000000000000000000100000000000000000000000095bb85fdec42b1517d282e8ad43a789d390aada20000000000000000000000000000000000000000000000000000000000000001` |

Verify: `GET /api/finops/spritz/wallet` → `policy.allowed: true`; `hasRole(1, 0x95bb85…) == true`.

### (c) Policy contract funding + live flags + checker signer

```sh
# policy contract must hold the USDC it releases (coupon_income bucket):
#   SpritzTreasuryLegEngine.fund({ amountUsd, bucket: 'coupon_income' })  → ERP reserve → USDC → 0x9682…  (maker/checker canonical_money proposal)
#   or the runbook's §4c draw/fund steps (Collateral OS) which book DR 1210 / CR 2400
node scripts/northflank/set-secrets.mjs --group dlbtrust-runtime \
  TRUST_POLICY_LIVE=true TRUST_POLICY_ENFORCED=true \
  TRUST_POLICY_CHECKER_PRIVATE_KEY=<key for 0x95bb85…, never the server wallet> \
  TRUST_POLICY_CHECKER_RPC_URL=https://mainnet.base.org \
  TRUST_POLICY_CHECKER_LIVE=true \
  THIRDWEB_SERVER_WALLET_LIVE=true THIRDWEB_SHADOW=false CANONICAL_FUNDING_LIVE=true
# restart; then send ~0.002 Base ETH to the checker 0x95bb85FdeC42b1517d282e8AD43A789d390aAda2 (it pays its own approve gas)
curl -s -H "x-admin-token: $ADMIN_SECRET_TOKEN" "$BASE/api/dapp/trust-policy/readiness"   # checkerSignerConfigured:true, checkerLive:true, live:true
npm run trust:runbook -- --strict --json                                                   # exit 0 = every blocking gate open
```

## D. Go-live sequence (§5a) and command

1. **Maker Propose** (maker seat, On-Chain Policy tab, or `POST /api/dapp/trust-policy/requests/:id/propose`) — signs with DLBT-FTC. In the runbook this is `settle` → `stagePayout` (creates the Spritz quote for exactly the approved amount, then `propose`).
2. **Checker Approve** (checker seat, `POST /api/dapp/trust-policy/distributions/:id/approve`) — signs with `TRUST_POLICY_CHECKER_PRIVATE_KEY` → `0x95bb85…`; `409 TRUST_POLICY_CHECKER_IS_MAKER` if the key resolves to the server wallet.
3. Wait the release delay (24h on-chain).
4. **Execute** (`POST /api/dapp/trust-policy/distributions/:id/execute`, or re-run the runbook which picks the `settling` draw up as `release`) → `executePayout` → `payQuoteFromServerWallet` (approve + payment via thirdweb, each awaited to `CONFIRMED`) → `_bookPayout` **DR 2000 / CR 1210**.

Run once (a)–(c) are done and `--strict` exits 0. Shadow first, then live:

```sh
npm run trust:runbook -- --execute --amount 250 --role beneficiary --purpose medical          # shadow rehearsal, moves nothing
npm run trust:runbook -- --execute --amount 250 --role beneficiary --purpose medical --live   # broadcasts; stops at the checker approval
# after the checker approves and the 24h delay:
npm run trust:runbook -- --execute --amount 250 --role beneficiary --purpose medical --live --reference LVR-<ref printed above>
```

`--purpose` ∈ `lifestyle|medical|travel|home|education`; `--role beneficiary` maps to the `coupon_income` bucket and the $100,000 per-transaction ceiling.
`--live` is silently downgraded to shadow while any of `THIRDWEB_SECRET_KEY`, `THIRDWEB_SERVER_WALLET_ENABLED`, `THIRDWEB_SERVER_WALLET_LIVE`, `THIRDWEB_SHADOW=false`, `CANONICAL_FUNDING_LIVE`, `TRUST_POLICY_LIVE` is closed (`shadowReason` names them).

## E. Findings outside the code

- The `THIRDWEB_SECRET_KEY` and `SPRITZ_API_KEY` provisioned to this Devin environment both return `401 Unauthorized` (`GET /v1/wallets/…/balance`, `POST /v1/contracts/read`, `GET /v1/users/me`). Production readiness must be re-run in Northflank with the live keys; replace the stored copies.
- `SpritzTreasuryLegEngine.prepareAllowlistPayoutWallet` rejected an explicit `periodCapUsd: 0` ("amountUsd must be a positive number") although `0` is the contract's "no cap"; fixed in this change (treated as `0` units).
