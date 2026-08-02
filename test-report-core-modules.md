# Core Modules Funding Abstraction — dApp End-to-End Test Report

**Target:** `https://dlbtrust-app.fly.dev/dapp` (`devin/circle-mint-onramp`, PR #234)  
**Auth:** `x-admin-token: dlb-admin-2026-trust`  
**Mode:** deployed live Sepolia for `stablecoin_dex`; instrument rails generated without merchant keys.

## Summary

End-to-end tested the new Core Modules tab, internal cash transfer, Cash App Pay QR, and Google Wallet Pass generation. The tab loads and groups balances correctly; the internal transfer updates balances; both instrument rails generate shareable QR/pass links. The optional `stablecoin_dex` rail failed/timed out for tiny amounts and should be re-tested once gas and pool state are confirmed.

A notable observation: funds reserved from `CA-OPERATING` for the two `$1.00` rail instruments appear as credits to `CA-RESERVE` rather than a separate `STABLECOIN_CASH_HOLD` account. This is consistent with the deployed `STABLECOIN_CASH_HOLDING_ACCOUNT` being configured to `CA-RESERVE`, but worth confirming because `CA-RESERVE` is also a user-visible module account.

## Test results

### 1. Core Modules tab loads grouped balances

- **Result:** ✅ Passed
- `/api/dapp/modules` returned `success: true` and grouped balances for Treasury, Cash Management, Trust Accounting, Bond / Fixed Income, Sub-Ledger, CRM, Tax, and Documents.
- The dApp rendered the **Core Modules Ledger View** table with `CA-OPERATING` at `$5,999,961.81` and `CA-RESERVE` at `$42.19`.

![dApp loaded with operator token saved](https://app.devin.ai/attachments/c3d1954c-b3f6-4ce7-8312-8cfe3532153a/ss_c5a9d271.png)

![Core Modules tab with grouped balances](https://app.devin.ai/attachments/fc25d996-2c8e-4a3d-b9e9-40de21ccc0ac/ss_4af30f0e.png)

### 2. Internal transfer `CA-OPERATING` → `CA-RESERVE` for `$0.01`

- **Result:** ✅ Passed
- `POST /api/dapp/modules/transfer` returned `transferId: INT-1785642052451-4OX7EH` and the UI showed "Transfer INT-1785642052451-4OX7EH completed."
- After refresh:
  - `CA-OPERATING`: `$5,999,961.81` → `$5,999,961.80`
  - `CA-RESERVE`: `$42.19` → `$42.20`

![Internal transfer completed](https://app.devin.ai/attachments/6f760f28-fab9-4b38-8e0e-a9f4c80f963c/ss_089d1ad3.png)

### 3. Fund External Rail — Cash App Pay QR from `cash:CA-OPERATING`

- **Result:** ✅ Passed
- Rail `cashapp` with options `{"cashtag":"$DLBTrust"}` for `$1.00` returned funding id `CASH-1785642073144-RDH1MA`.
- UI rendered a QR code image (`data:image/png;base64,...`) and a deep link `https://cash.app/$DLBTrust/1?note=...`.
- `CA-OPERATING` decreased by `$1.00` (from `$5,999,961.80` to `$5,999,960.80`).

![Cash App Pay QR generated](https://app.devin.ai/attachments/8df16540-5aa6-453d-a1fd-13ae0406ed66/ss_97c12b66.png)

### 4. Fund External Rail — Google Wallet Pass from `cash:CA-OPERATING`

- **Result:** ✅ Passed
- Rail `googlewallet` with options `{"email":"deandreabarkley13@gmail.com","walletAddress":"0x8a0dfd17efca67590e7a144df5a4d2fce4a054f1"}` for `$1.00` returned funding id `RAIL-1785642114897-QUU7GN`.
- UI rendered an **Open payment link / pass** link to `https://pay.google.com/gp/v/save/...`.
- `CA-OPERATING` decreased by another `$1.00` (from `$5,999,960.80` to `$5,999,959.80`).

![Google Wallet pass link generated](https://app.devin.ai/attachments/eca78ed1-55db-4a2b-9d8e-21b16df80a62/ss_ac1413aa.png)

### 5. Optional `stablecoin_dex` rail from `cash:CA-OPERATING`

- **Result:** ⚠️ Failed / not verifiable
- Attempting `$0.001` was rejected immediately: `amount must be positive` (less than 1 cent).
- Attempting `$0.01` with `createPoolIfMissing:true` hung without returning a response (API calls timed out after 60–90 seconds).
- Attempting `$0.01` against the existing BondDex pool `0x29163502317276cb89c3774b411c695e2b4b8426` with `createPoolIfMissing:false` also hung.
- Operator Sepolia ETH balance is ~`0.00046 ETH`, which may be insufficient for live mint + swap.

![stablecoin_dex amount rejected](https://app.devin.ai/attachments/4c5635f2-b61a-48a7-93de-6b98f2ea0ef4/ss_f5891238.png)

![stablecoin_dex $0.01 attempt](https://app.devin.ai/attachments/6d898a2f-73b1-48a7-afb7-801f08d036cd/ss_e4f6cf71.png)

## Observations and red flags

1. **Rail reserves credited `CA-RESERVE` instead of a holding account.**
   - After the two `$1.00` rail reservations, `CA-OPERATING` decreased by `$2.00` and `CA-RESERVE` increased by `$2.00` (final `CA-RESERVE` `$44.20`).
   - This is consistent with the deployed `STABLECOIN_CASH_HOLDING_ACCOUNT` being `CA-RESERVE`, but it is confusing because `CA-RESERVE` is also a user-visible module account used for the internal transfer test.
   - If `STABLECOIN_CASH_HOLDING_ACCOUNT` is intentionally `CA-RESERVE`, the Core Modules UI should probably show that account as the "Cash Holding" reserve rather than "Trust Reserve".
   - If it is not intentional, `SourceOfFundsAdapter._fundSourceToTreasury` for cash may be crediting the wrong account.

2. **Final Core Modules balances (from `GET /api/dapp/modules`)**

   | Account | Balance (cents) | Balance (USD) |
   |---------|-----------------|---------------|
   | TREASURY_HOT | 113548 | $1135.48 |
   | CA-OPERATING | 599995980 | $5,999,959.80 |
   | CA-RESERVE | 4420 | $44.20 |

   ![Final Core Modules balances](https://app.devin.ai/attachments/0c97d098-eca9-44ce-949d-91745752191b/ss_edd860c7.png)

3. **`stablecoin_dex` rail is not suitable for tiny quick tests in live mode.**
   - The minimum expressible amount is `$0.01` (1 cent), and the live mint/swap path takes too long or stalls when gas/pool liquidity is marginal.
   - The prompt was explicit that this step was optional and should not consume significant time; it is therefore recorded as an open issue, not a blocker.

## Artifacts

- **Screen recording:** `/home/ubuntu/screencasts/rec-core-modules/rec-core-modules-edited.mp4`
- **Test plan:** `/home/ubuntu/repos/dlbtrust-app/test-plan-core-modules.md`
- **SKILL.md updated:** `/home/ubuntu/repos/dlbtrust-app/.agents/skills/testing-dlbtrust-app/SKILL.md`

## Suggested PR comment

```markdown
Core Modules funding abstraction end-to-end test — mostly passed, one observation

**Tested:** `https://dlbtrust-app.fly.dev/dapp`

**Passed:**
- Core Modules tab loads grouped balances (Treasury, Cash, Trust Accounting, Bond/Fixed Income, Sub-Ledger, CRM, Tax, Documents).
- Internal transfer `CA-OPERATING` → `CA-RESERVE` `$0.01` succeeded (`INT-1785642052451-4OX7EH`) and both balances updated.
- Cash App Pay QR generated from `cash:CA-OPERATING` `$1.00` without merchant keys: `CASH-1785642073144-RDH1MA`.
- Google Wallet Pass generated from `cash:CA-OPERATING` `$1.00` without merchant keys: `RAIL-1785642114897-QUU7GN`.

**Open issue:**
- The optional `stablecoin_dex` rail timed out for `$0.01` (with and without `createPoolIfMissing`) and rejected `$0.001` as below 1 cent. Operator Sepolia ETH is ~0.00046; the live mint/swap path needs more gas or an existing pool with liquidity.

**Red flag:**
- Rail reservations from `CA-OPERATING` appear as credits to `CA-RESERVE` rather than a dedicated holding account. If `STABLECOIN_CASH_HOLDING_ACCOUNT` is set to `CA-RESERVE` on deploy this is expected, but it should be confirmed because `CA-RESERVE` is also a user-visible module account.

![Core Modules balances](https://app.devin.ai/attachments/0c97d098-eca9-44ce-949d-91745752191b/ss_edd860c7.png)
```

## SKILL.md and blueprint suggestions

- `SKILL.md` updated with a Core Modules section covering `loadCoreModules()`, `internalModuleTransfer()`, `fundExternalRail()` for `cashapp` and `googlewallet`, the `$0.01` minimum for `stablecoin_dex`, and the `CA-RESERVE` holding-account observation.
- Blueprint update suggestion: add a note that the deployed `https://dlbtrust-app.fly.dev/dapp` URL is the dApp entrypoint and that `STABLECOIN_CASH_HOLDING_ACCOUNT` can affect which cash account is credited during rail reservations.

## Anything still needed

1. Confirm whether the deployed `STABLECOIN_CASH_HOLDING_ACCOUNT` is intentionally `CA-RESERVE` or should be `STABLECOIN_CASH_HOLD`.
2. If the `stablecoin_dex` rail needs to be proven, top up the operator Sepolia wallet and re-run with a known good `poolAddress` and `createPoolIfMissing:false`.
