# Stablecoin Source-of-Funds Wiring — End-to-End Test Report

**Branch:** `devin/stablecoin-source-funding` (PR #227)
**Server:** `http://localhost:3002` (`server/server-3002.js` on port 3002)
**Database:** `postgres://dlbtrust:dlbtrust@localhost:5432/dlbtrust`
**Mode:** `STABLECOIN_MODE=shadow`
**Tested by:** testing agent

## Summary

I created a `$100.00` stablecoin payment funded from **Bond id `1` (`DLB-PRB`)**, approved it, settled it, and verified that:

- The payment row progressed `pending → approved → settled` with a simulated `shadow-...` tx hash.
- `stablecoinGateway.approvePayment` preserved `source_account_id = '1'` for the non-treasury source.
- `SourceOfFundsAdapter` swept `$100.25` from the bond principal into the treasury (`bond_balances.principal_balance` decreased by `$100.25`).
- `TreasuryEngine.hold` reserved `$100.25` and `TreasuryEngine.post` finalized the reserve, leaving the treasury with the `$0.25` fee.
- The source balance check in the UI dropped from `$102,419,433.95` to `$102,419,333.70` (down `$100.25`).

`npm run typecheck` and `npm test` both passed.

## Preconditions

Server started with:

```bash
nohup env \
  DATABASE_URL=postgres://dlbtrust:dlbtrust@localhost:5432/dlbtrust \
  JWT_SECRET=devin-jwt-secret-2026 \
  ADMIN_SECRET_TOKEN=dlb-admin-2026-trust \
  STABLECOIN_ENABLED=true \
  STABLECOIN_MODE=shadow \
  STABLECOIN_NETWORK=testnet \
  STABLECOIN_DISTRIBUTOR_SECRET=<valid-stellar-secret> \
  STABLECOIN_DISTRIBUTOR_PUBLIC=<matching-public-key> \
  PORT=3002 \
  node server/server-3002.js > /tmp/server-3002.log 2>&1 &
disown
```

`/api/stablecoin/health` returned:

```json
{"success":true,"data":{"ready":true,"mode":"shadow","network":"testnet","assetCode":"USDC"}}
```

Pre-test baselines:

| Source | Balance |
|--------|---------|
| Bond id 1 principal | `99,999,989.75` |
| Bond id 1 accrued interest | `2,419,444.20` |
| Treasury `TREASURY_HOT` balance | `100` cents |
| Treasury `TREASURY_HOT` hold | `0` cents |
| Treasury `TREASURY_HOT` available | `100` cents |

## Test assertions

### 1. Source balance check (before)

Selected **Source Type = Bond**, entered **Source Account ID = 1**, and clicked **Check Source Balance**. The UI showed:

![Source balance before](https://app.devin.ai/attachments/e5a95711-0f26-412c-bbe4-bf6b87b632c7/ss_dd71bc59.png)

- ✅ Green `Available: $102,419,433.95` (principal `99,999,989.75` + accrued `2,419,444.20`).

### 2. Create payment

Filled **Destination Wallet** `GAA_TESTWALLET`, **Amount** `100.00`, **Source Type** `Bond`, **Source Account ID** `1`, and clicked **Create Payment**.

![Payment created](https://app.devin.ai/attachments/d83a74ad-c4a8-4a52-85fc-0d76c9c6b1ba/ss_6d23e8eb.png)

- ✅ Green `Payment created: SCP-1785333675445-7PQW4L`.
- ✅ New table row: `pending`, `$100.00`, `$0.25`, `$100.25`, `USDC`, destination `GAA_TESTWALLET`, source `bond / 1`.
- ✅ `stablecoin_payments` row:

```
 id            | status  | source_type | source_account_id | total_cents | reserve_id | tx_hash
--------------------------+---------+-------------+-------------------+-------------+------------+---------
 SCP-1785333675445-7PQW4L | pending | bond        | 1                 | 10025       |            |
```

### 3. Approve payment

Clicked **Approve** on the new row.

![Payment approved](https://app.devin.ai/attachments/81e8c6b8-d144-4f92-920f-ca5eef654c73/ss_0cf7f0e1.png)

- ✅ Table row changed to `approved`.
- ✅ `source_account_id` remained `1` (not `TREASURY_HOT`).
- ✅ `source_ref` included `bondTransactionId` and `newPrincipalCents`.
- ✅ Bond principal decreased by `$100.25`:

```
 id | bond_name | principal_balance | accrued_interest
----+-----------+-------------------+------------------
  1 | DLB-PRB   |       99999889.50 |       2419444.20
```

- ✅ Treasury ledger credited and held:

```
  account_id  | balance_cents | hold_cents | available_cents
--------------+---------------+------------+-----------------
 TREASURY_HOT |         10125 |      10025 |             100
```

### 4. Settle payment

Clicked **Settle** on the approved row.

![Payment settled](https://app.devin.ai/attachments/0b4a9ea6-8b29-4a63-9be5-c088419a125a/ss_d4e1d01d.png)

- ✅ Table row changed to `settled`, Actions shows `Settled`.
- ✅ `tx_hash` generated: `shadow-1785333706537-xgalvdcrdh9`.
- ✅ `stablecoin_reserves` posted:

```
        reserve_id           | status |             tx_hash
-----------------------------+--------+----------------------------------
 RES-1785333685858-9a4ytt    | posted | shadow-1785333706537-xgalvdcrdh9
```

- ✅ Treasury final state: fee retained, hold released.

```
  account_id  | balance_cents | hold_cents | available_cents
--------------+---------------+------------+-----------------
 TREASURY_HOT |           125 |          0 |             125
```

- ✅ `source_ref.post` contains `posted: true`, `sourceType: bond`, `sourceAccountId: 1`, `bondTransactionId: 4`.

### 5. Source balance check (after)

Clicked **Check Source Balance** again for Bond / 1.

![Source balance after](https://app.devin.ai/attachments/25f71505-f500-4317-8e9f-6d0f041c2935/ss_f52e7c3d.png)

- ✅ Green `Available: $102,419,333.70` — exactly `$100.25` less than the pre-approve value.

### 6. Static checks

- ✅ `npm run typecheck` passed.
- ✅ `npm test` passed: 7 files, 45 tests.

## Issues / notes

- **Native dropdown selection was unreliable during automation.** My first attempts to select `Bond` with mouse/keyboard selected `Fineract` or `Core Banking` instead. I used a browser-console one-liner to set `sc-source-type.value = 'bond'` and dispatch a `change` event, then the rest of the flow worked. This appears to be a test-automation coordinate/keyboard timing issue rather than a product bug, but the select control may be sensitive.
- **Prior pending stablecoin payments exist** (`SCP-1785333162310-YV988C`, `SCP-1785333146770-NBACQN` from earlier runs). They did not interfere with this test because the new payment sorted to the top and was handled independently.

## Artifacts

- Screen recording: `/home/ubuntu/screencasts/stablecoin-source-of-funds-e2e/stablecoin-source-of-funds-e2e-edited.mp4`
- Test plan: `/home/ubuntu/repos/dlbtrust-app/test-plan-stablecoin-source-of-funds.md`
- Skill file: `/home/ubuntu/repos/dlbtrust-app/.agents/skills/testing-dlbtrust-app/SKILL.md`
- This report: `/home/ubuntu/repos/dlbtrust-app/test-report-stablecoin-source-of-funds.md`
