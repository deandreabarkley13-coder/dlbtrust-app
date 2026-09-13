# OS Engines (yield vault → StableSwap AMM → floor redemption)

Three engines that give the trust's own token, `DLB-PTCUSD`, a peg that holds
and value that is actually spendable. Income earned by the trust is paid out to
holders in the token; a dedicated StableSwap pool lets anyone swap the token
for canonical stablecoins near 1:1; and a canonical-funded floor contract
guarantees the last resort — redeem at $1 — while the arbitrage loop between
the two keeps the market price pinned to it.

```
trust income           bond accrued interest (LiveBondEngine / BondEngine)
                       LP yield (InternalMarketMakerEngine.accrueYield → payoutAccruedYield)
                       vault reserve surplus vs PtcStablecoinEngine.totalSupply()
  → yield vault        YieldVaultOsEngine        pro-rata to LP positions + DLB-PTCUSD holders
  → StableSwap pool    StableAmmPool.sol         DLB-PTCUSD / USDC, amplified invariant, low slippage
  → market making      AmmOsEngine               price vs $1, swap the surplus side back in when |Δ| > band
  → floor reserve      FloorPriceRedemption.sol  owner-funded canonical, redeem DLB-PTCUSD at floorPrice
  → peg defense        FloorRedemptionOsEngine   AMM price < floor ⇒ buy on AMM, redeem at floor, book spread
  → evidence           TrustAccountingEngine.postJournalEntry + FabricLedgerEngine.notarize
```

Nothing here mints canonical money. Canonical enters only through the operator
wallet (funded by `TreasuryOnRampBridgeEngine`); whenever an engine needs
canonical the wallet or the reserve does not hold, it stops and reports
`awaiting_funds`, exactly like `TreasuryOnRampBridgeEngine._redeemInternal` and
`RedemptionGatewayEngine._spritzPayout`.

## Shadow by default

Every engine computes `shadow` the same way `DexSwapEngine.getConfig()` does:

```
shadow = <ENGINE>_SHADOW (default true)
      || DAPP_SHADOW === true
      || (DAPP_SIGNER=thirdweb && !THIRDWEB_SERVER_WALLET_LIVE)
```

In shadow mode `plan`, `snapshot`, `quote` and `coverage` run against real chain
reads, and every would-be write is recorded in Postgres with `mode = 'shadow'`
— no approval, transfer, deploy or swap is signed. Setting
`YIELD_VAULT_OS_SHADOW=false`, `AMM_OS_SHADOW=false` or
`FLOOR_REDEMPTION_OS_SHADOW=false` alone is not enough: `DAPP_SHADOW` must not be
`true`, and with the thirdweb signer `THIRDWEB_SERVER_WALLET_LIVE=true` is also
required. `<ENGINE>_ENABLED=false` is the kill switch; writes then fail with
`409 DISABLED`.

## Yield Vault OS — `server/integrations/dapp/yieldVaultOsEngine.js`

| Step | What happens |
| --- | --- |
| `sources()` | gross income per source (`bond_interest`, `lp_yield`, `reserve_surplus`), minus what earlier cycles already paid from each, → `available` and `distributable` |
| `plan()` | `min(distributable, YIELD_VAULT_OS_MAX_DISTRIBUTION_USD)` split `YIELD_VAULT_OS_LP_SHARE_BPS` to LP positions (weighted by `lp_balance` from `InternalMarketMakerEngine.listPositions()`) and the rest to holders (beneficiary expense wallets + `YIELD_VAULT_OS_HOLDERS`, weighted by `PtcStablecoinEngine.balanceOf`). `proRata()` rounds to 6 dp and gives the dust to the largest weight so allocations sum exactly |
| `distribute()` | pays each allocation — `PtcStablecoinEngine.transfer` for DLB-PTCUSD (recipients must already be whitelisted on the trust token; a failed transfer is recorded per allocation and the cycle ends `partial`) or an ERC-20 transfer of USDC — then posts one balanced journal (`YIELD_VAULT_OS_EXPENSE_ACCOUNT` / `STABLECOIN_ASSET_ACCOUNT`) and notarizes the cycle (`yield_vault_os_cycle`) |
| `runCycle()` | `plan` + `distribute`; skipped below `YIELD_VAULT_OS_MIN_DISTRIBUTION_USD` or with no recipients |

`InternalMarketMakerEngine.accrueYield({ payout: true })` now settles what it
accrues: `payoutAccruedYield` transfers each position's `accrued_yield` in
DLB-PTCUSD to the holder and zeroes the column (shadow: reports the intended
payments, leaves the column alone). `POST /api/finops/yield-vault-os/lp-payout`
and `node server/scripts/yieldVaultOsCycle.js lp-payout` expose it.

Tables: `yield_vault_os_cycles`, `yield_vault_os_distributions`.

## AMM OS — `contracts/StableAmmPool.sol` + `server/integrations/dapp/ammOsEngine.js`

`StableAmmPool` is a two-coin Curve-style pool: inline `IERC20`, `token0 <
token1`, reserves tracked in storage, LP shares minted against the invariant
`D`, reentrancy lock, owner-only `setParameters(A, feeBps)` and `pause` / `unpause`. Both sides are
normalised to 18 decimals so DLB-PTCUSD (18) pairs with USDC (6). With
`A = 200` a pool 30 % out of balance still quotes within ~40 bps of parity;
`getPrice()` returns the marginal price of `token0` in `token1` (1e18 = 1) and
`getVirtualPrice()` returns `D / totalSupply`.

`AmmOsEngine` mirrors the math in JS (`StableSwapMath`) so it can quote and
size trades off a snapshot:

| Method | What happens |
| --- | --- |
| `ensurePool()` | env `AMM_OS_POOL_ADDRESS` → Postgres → otherwise salted `deployContract`, whitelist the pool on the trust token, seed `AMM_OS_SEED_USD` of each side from the operator wallet (`awaiting_funds` if short) and register the pool with `InternalMarketMakerEngine` so its positions accrue yield |
| `snapshot()` / `evaluate()` | price of DLB-PTCUSD in canonical, `deviationBps`, and the action: above the band → the pool is short of trust token → swap trust token in; below → swap canonical in. Size = half the normalised reserve gap |
| `quote()` | output, fee and slippage for a given input |
| `rebalance()` | executes the sized swap (capped at `AMM_OS_MAX_REBALANCE_USD`, `AMM_OS_SLIPPAGE_BPS` min-out) or reports `in_band` / `awaiting_funds` |
| `runCycle()` | `ensurePool` + `rebalance` |

Tables: `amm_os_pools`, `amm_os_actions`.

## Floor Redemption OS — `contracts/FloorPriceRedemption.sol` + `server/integrations/dapp/floorRedemptionOsEngine.js`

`FloorPriceRedemption` holds a canonical reserve the owner funds
(`fundReserve`) and pays `trustAmount × floorPrice / 1e18` canonical to a
whitelisted redeemer (`redeem`), pulling the trust token and optionally burning
it. Owner controls: `setFloorPrice`, `setRedeemer`, `setWhitelistEnabled`,
`setBurnOnRedeem`, `withdrawReserve`, pausers; views: `reserveBalance`,
`quoteRedeem`, `maxRedeemable`, `coverageBps(supply)`. `Redeemed`,
`ReserveFunded`, `ReserveWithdrawn`, `FloorPriceSet` events.

| Method | What happens |
| --- | --- |
| `deploy()` | salted, idempotent deploy; whitelists the contract on the trust token and the operator as redeemer |
| `status()` | reserve, floor, `coverage = reserve ÷ (supply × floor)` in bps with shortfall, AMM price |
| `fund({ amount })` | moves canonical from the operator wallet into the reserve (default: shortfall to `FLOOR_REDEMPTION_OS_TARGET_COVERAGE_BPS`). Wallet short → proposes a `TreasuryOnRampBridgeEngine` operation for the shortfall and returns `awaiting_funds` |
| `redeem({ amount, to })` | operator-side redemption; `awaiting_funds` when the reserve cannot honour it |
| `arbCycle()` | `planArb`: AMM price below the floor by more than `FLOOR_REDEMPTION_OS_MIN_SPREAD_BPS` + fee ⇒ spend canonical (≤ `FLOOR_REDEMPTION_OS_MAX_ARB_USD`, ≤ wallet balance, ≤ half the reserve gap) on the AMM, redeem the bought token at the floor, profit = redeemed − spent. Redemption is capped by the reserve (`awaiting_funds` for the remainder). Live runs book the spread to `FLOOR_REDEMPTION_OS_INCOME_ACCOUNT` and notarize `floor_redemption_os_arb` |

Tables: `floor_redemption_os_contracts`, `floor_redemption_os_actions`.

## Routes

All under `/api/finops`, operator auth; writes also pass `writeRateLimiter()`.

| Engine | GET | POST |
| --- | --- | --- |
| Yield Vault | `/yield-vault-os`, `/readiness`, `/plan`, `/cycles` | `/distribute`, `/cycle`, `/lp-payout` |
| AMM | `/amm-os`, `/readiness`, `/quote?tokenIn&amountIn`, `/actions` | `/deploy`, `/rebalance`, `/cycle` |
| Floor | `/floor-redemption-os`, `/readiness`, `/actions` | `/deploy`, `/fund`, `/redeem`, `/cycle` |

The FinOps dashboard (`public/dapp/finops.html`) has a card and panel for each.

## Running it

```bash
node scripts/compileOsEngines.cjs                      # StableAmmPool + FloorPriceRedemption artifacts

node server/scripts/yieldVaultOsCycle.js plan          # allocations, no writes
node server/scripts/yieldVaultOsCycle.js cycle         # schedule this

node server/scripts/ammOsRebalance.js status
node server/scripts/ammOsRebalance.js quote --amount 100 --token DLB-PTCUSD
node server/scripts/ammOsRebalance.js cycle            # schedule this

node server/scripts/floorRedemptionOsArb.js deploy
node server/scripts/floorRedemptionOsArb.js fund --amount 500
node server/scripts/floorRedemptionOsArb.js arb        # schedule this
```

Going live, in order: deploy the PTC stablecoin (`PtcStablecoinEngine.deploy`),
set `DAPP_USDC_ADDRESS`, fund the operator wallet with canonical through the
on-ramp bridge, then flip `AMM_OS_SHADOW=false` (pool + seed),
`FLOOR_REDEMPTION_OS_SHADOW=false` (deploy + fund), and finally
`YIELD_VAULT_OS_SHADOW=false`. Tests: `npx vitest run tests/osEngines.test.ts`.
