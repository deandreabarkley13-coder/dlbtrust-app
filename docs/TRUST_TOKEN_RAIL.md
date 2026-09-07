# Trust token rail (fixed income → spendable trust token)

The trust is custodian and issuer of its own assets, so the value a beneficiary
spends does not have to come from a bank: a fixed-income position is tokenized
on chain, deposited as reserve into a vault the trust controls, and the vault
mints the trust's own token against it. That token is what lands in a
beneficiary's expense wallet. No fiat, no partner, no private key on the host —
every contract call is signed by the thirdweb Vault-held server wallet.

```
fixed-income position   FixedIncomeDataService (ledger is the source of truth)
  → bond token          BondTokenizationEngine   ERC-20, 6 decimals, 1 unit = $1 principal
  → issuance            IssuanceOs (maker) → approve (checker) → MintExchangeOs mint, GL claim
  → trust token         PtcStablecoinEngine      PtcBackedStablecoin + PtcReserveVault, 18 decimals
  → reserve deposit     vault.depositReserve     mints trust token = units × reserve price
  → distribution        BeneficiaryExpenseWalletEngine.fund(sourceType: trust_token)
  → evidence            FabricLedgerEngine.notarize(trust_token_rail, runId)
  → reconcile           ledger vs chain vs Fabric vs books
```

The software expresses the operating model. Legal custodian/issuer status comes
from the trust instrument and counsel, not from this configuration.

## Signer: `DAPP_SIGNER=thirdweb`

`server/integrations/dapp/thirdwebChainSigner.js` replaces the raw-key viem
client in `BondTokenizationEngine` and `PtcStablecoinEngine`:

| Operation | thirdweb API | Notes |
| --- | --- | --- |
| deploy | `POST /v1/contracts` | raw bytecode + ABI, `from` = server wallet, salted → idempotent (same salt returns the same address with no tx) |
| write | `POST /v1/contracts/write` | human-readable method signature rendered from the ABI |
| read | `POST /v1/contracts/read` | decoded to viem shapes (`bigint`, `boolean`, tuples) |
| confirm | `GET /v1/transactions/{id}` | polled until `CONFIRMED`/`FAILED`; both the thirdweb transaction id and the chain hash are persisted |

Raw-key signing (`DAPP_PRIVATE_KEY`) remains available when `DAPP_SIGNER` is
unset. Base Sepolia deployments through the Vault execute factory-like, so the
PTC contracts take an explicit owner and every run verifies `owner()` before
anything is minted.

| Env | Default | Purpose |
| --- | --- | --- |
| `DAPP_SIGNER` | — | `thirdweb` to sign with the Vault wallet |
| `DAPP_CHAIN_ID` | `1` | `84532` Base Sepolia (validation), `8453` Base (production) |
| `THIRDWEB_SECRET_KEY`, `THIRDWEB_SERVER_WALLET_ADDRESS` | — | project key and the `dlbtrust-treasury` wallet |
| `THIRDWEB_SERVER_WALLET_LIVE` | `false` | the rail is shadow until this and `DAPP_SHADOW=false`/`BOND_TOKEN_SHADOW=false` are set |
| `THIRDWEB_DEPLOY_SALT_PREFIX` | `dlbtrust` | deployment salt namespace |
| `THIRDWEB_TX_TIMEOUT_MS` / `THIRDWEB_TX_POLL_MS` | `180000` / `3000` | confirmation polling |
| `BOND_TOKEN_FACTORY` | — | factory the bond tokens are deployed through |
| `TRUST_TOKEN_RAIL_ENABLED` | `true` | kill switch |
| `TRUST_TOKEN_RAIL_MAX_ISSUE_USD` | `1000` | per-run issuance ceiling |
| `TRUST_TOKEN_RAIL_RESERVE_PRICE_USD` | `1` | vault valuation of one bond unit |
| `TRUST_TOKEN_NAME` / `TRUST_TOKEN_SYMBOL` | `DLB Trust USD` / `DLB-PTCUSD` | trust token identity |
| `THIRDWEB_PINNED_PRICES` | — | `chainId:address:priceUsd:decimals:symbol,...`; the trust token is pinned at $1 by the issuer at runtime |
| `EXPENSE_WALLET_HOLD_SOURCE_TYPE=trust_token` + `EXPENSE_WALLET_TOKEN_ADDRESS` | — | fund expense wallets from the treasury's trust-token balance instead of a hold account |

## Controls that survive the port

* Position headroom: a run can only issue up to the untokenized principal of an
  active position; ledger rows never mint on their own.
* Maker/checker: `initiatedBy` and `approvedBy` must differ; cap control is
  assessed before issuance.
* Reserve arithmetic is verified on chain: the run reads `totalSupply` before and
  after the deposit and fails with `RESERVE_UNITS_MISMATCH` /
  `RESERVE_MINT_MISMATCH` if the vault moved or minted anything other than the
  valuation.
* Distribution keeps `DistributionPolicy` (role, purpose, ceilings), the
  recipient allowlist, whitelist-only transfers, and books the beneficiary
  obligation only after `waitForTransaction` reports `CONFIRMED`.
* Every run — completed, shadow or failed — is notarized on Fabric under
  `trust_token_rail/<runId>` and the reconcile stage verifies that digest.

## Spending outside the trust

The trust token is a whitelist-only entitlement. `GET /api/trust/token-rail/off-ramp`
lists the hooks that carry it to a merchant, card or bill (redeem to USDC via the
vault, Spritz push-to-card / bill pay, HCE) and whether each is configured.
None of them is required for the internal rail to run.

## Running it

```
npm run trust:token-rail -- --status
npm run trust:token-rail -- --plan --issue 25 --beneficiary "Jane Doe" --purpose medical
npm run trust:token-rail -- --run  --issue 25 --distribute 10 --beneficiary "Jane Doe" --purpose medical \
                                   --role trustee --by trustee-a --approve trustee-b
npm run trust:token-rail -- --reconcile --run-id TTR-...
```

Routes (`/api/trust/token-rail...`, operator token; `run` requires admin):
`GET /`, `GET /readiness`, `GET /off-ramp`, `POST /plan`, `POST /run`,
`GET /runs`, `GET /runs/:id`, `POST /reconcile`. A failed run is persisted and
returned with HTTP 422.

Go-live order: Base Sepolia with every gate on → verify owners, reserve balance,
supply, beneficiary balance, Fabric digest, journal and reconcile → only then
Base mainnet, with a non-empty `THIRDWEB_SERVER_WALLET_ALLOWED_RECIPIENTS`.
