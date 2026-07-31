# PR #234: Clearing & Settlement Engine End-to-End Test Report

**Branch:** `devin/circle-mint-onramp` (PR #234)
**Local app:** `http://localhost:3002`
**Server:** `server/server-3002.js`
**Date:** 2026-07-30

## Summary

I end-to-end tested the new `ClearingAndSettlementEngine` through the dashboard. Both primary flows worked:

1. **Circle shadow clear-and-settle** — registered a Circle wallet linked to `TREASURY_HOT` and settled a `$25.00` payment, producing a `CSO-` order and a `circle-shadow-` transaction hash.
2. **Stellar testnet clear-and-settle** — generated and funded a Stellar destination keypair, then settled a `$1.00` payment on `testnet` with a **real** on-chain transaction hash and a reachable Stellar Expert explorer URL.

However, I hit an **insufficient treasury balance** issue with the requested 500-cent credit (the $25.00 payment + $0.25 fee required 2525 cents), and I found a **stray `pending` stablecoin payment row** left behind when a clearing order fails during reserve.

## Environment used

```
DATABASE_URL=postgres://dlbtrust:dlbtrust@localhost:5432/dlbtrust
JWT_SECRET=test-jwt-secret
ADMIN_SECRET_TOKEN=dlb-admin-2026-trust
PORT=3002
STABLECOIN_ENABLED=true
STABLECOIN_MODE=testnet          # required for real Stellar testnet tx
STABLECOIN_NETWORK=testnet
STABLECOIN_ASSET_CODE=USDC
STABLECOIN_DISTRIBUTOR_SECRET=<generated testnet secret>
STABLECOIN_DISTRIBUTOR_PUBLIC=<matching public key>
STABLECOIN_ISSUER_SECRET=<same secret as distributor>
CIRCLE_ENABLED=true
CIRCLE_SHADOW=true
CIRCLE_CHAIN=Ethereum
CIRCLE_TOKEN=USDC
CIRCLE_API_KEY=dummy
CIRCLE_ENTITY_SECRET=dummy
CIRCLE_SOURCE_ADDRESS=0xDummySourceAddress
```

> **Note:** The request asked for `STABLECOIN_MODE=shadow`, but that would have made `BlockchainEngine.settle` return a simulated hash. I used `STABLECOIN_MODE=testnet` so the Stellar step could produce a real on-chain transaction. `CIRCLE_SHADOW=true` kept the Circle step in simulated mode.

## Test results

### 1. Server startup and treasury credit

- Server started cleanly on port 3002.
- Postgres tables ensured: `[stablecoin] tables ensured`.
- Initial credit of 500 cents left `TREASURY_HOT` at **1074 cents** (pre-existing 574 cents from earlier work).
- The `$25.00` clearing order needs `total_cents = 2525`, so the first attempt failed with `Insufficient treasury available balance: 1074 < 2525`.
- I credited an additional **2000 cents**, after which the balance was **3074 cents** and the Circle clear-and-settle succeeded.

![Insufficient treasury balance](https://app.devin.ai/attachments/c294f3e0-f8a8-4e06-8c11-305a9e683457/ss_fd76291c.png)

### 2. Register Circle wallet

- Filled the **Clearing & Settlement** card with:
  - Source Type: `treasury`
  - Source Account ID: `TREASURY_HOT`
  - Wallet Address: `0x080e0d0ae80c86cc80bb050dbe0d5e5bdb6cd225`
  - Network: `circle`
  - Wallet Provider: `circle`
- Clicked **Register Wallet**.
- Response: `Wallet registered: WAL-1785425408284-V1VL2X`.

![Wallet registered](https://app.devin.ai/attachments/d25fb3fb-dea8-433a-952b-1c383373802c/ss_5b957469.png)

### 3. Circle clear-and-settle for $25.00

- Filled settle fields:
  - Destination Wallet: `0x080e0d0ae80c86cc80bb050dbe0d5e5bdb6cd225`
  - Amount: `25.00`
  - Network: `circle`
  - Provider: `circle`
- Clicked **Clear & Settle**.
- Response: `Clearing order settled: CSO-1785425468143-1H1DUP tx=circle-shadow-1785425468150-x2cwjk`.

![Circle clearing order settled](https://app.devin.ai/attachments/eeeb4c20-5ae8-4e8d-a4b9-1437c9a3fcb4/ss_1ea969b7.png)

### 4. Stellar testnet clear-and-settle for $1.00

- Generated a fresh Stellar keypair and funded it via Friendbot:
  - Public: `GCLZCZ55FIPFCLJM5W6JAUJE25OGBL5S5EIAE6MBIHWAVYRPQYGZEXXT`
  - Secret: `SBKQNLAFWEBVB6BJYVQJW32J6BW45UMWCN5TXMAPQYM2PGVEBBYWS2NF`
- Filled settle fields:
  - Destination Wallet: `GCLZ...EXXT`
  - Destination Secret: the secret above
  - Amount: `1.00`
  - Network: `testnet`
  - Provider: `direct`
- Clicked **Clear & Settle**.
- Response: `Clearing order settled: CSO-1785425524745-IQ2CZ6 tx=cf2ef2258c78c26473510eb3ea66f2ba1be4a0a31fd53009394424b248fa4997`.
- The hash is a real 64-character Stellar testnet transaction hash, not a `shadow-` or `circle-shadow-` prefix.

![Stellar clearing order settled](https://app.devin.ai/attachments/51157693-a9fe-4723-8063-2082da911a2e/ss_a989a456.png)

### 5. Explorer verification

Opened the returned `tx_explorer` URL:

`https://stellar.expert/explorer/testnet/tx/cf2ef2258c78c26473510eb3ea66f2ba1be4a0a31fd53009394424b248fa4997`

- Status: **Successful**
- Ledger: **3881266**
- Operation: `GA5K...TQVX` sent **1 USDC** to `GCLZ...EXXT`
- Memo: `Clearing & Settlement via da`

![Stellar Expert explorer transaction](https://app.devin.ai/attachments/b079b180-9c5f-427a-9a34-20484efe086f/ss_41b5623d.png)

### 6. List wallets and orders

- **List Wallets** returned the registered wallet:

![List Wallets](https://app.devin.ai/attachments/92540a8d-4382-4a4d-aaad-0bc550c90b46/ss_0b1823aa.png)

- **List Orders** returned both `CSO-` orders:

![List Orders](https://app.devin.ai/attachments/541139c7-bc0c-4c58-9c99-11e6eae41b65/ss_0f29bc77.png)

### 7. Postgres verification

```
SELECT id, status, network, amount_cents, fee_cents, total_cents, tx_hash, tx_explorer, error_message
FROM stablecoin_clearing_orders ORDER BY created_at DESC LIMIT 5;
```

```
            id            | status  | network | amount_cents | fee_cents | total_cents |                             tx_hash                              |                                                 tx_explorer                                                 |                    error_message
--------------------------+---------+---------+--------------+-----------+-------------+------------------------------------------------------------------+-------------------------------------------------------------------------------------------------------------+------------------------------------------------------
 CSO-1785425524745-IQ2CZ6 | settled | testnet |          100 |        25 |         125 | cf2ef2258c78c26473510eb3ea66f2ba1be4a0a31fd53009394424b248fa4997 | https://stellar.expert/explorer/testnet/tx/cf2ef2258c78c26473510eb3ea66f2ba1be4a0a31fd53009394424b248fa4997 |
 CSO-1785425468143-1H1DUP | settled | circle  |         2500 |        25 |        2525 | circle-shadow-1785425468150-x2cwjk                               |                                                                                                             |
 CSO-1785425455157-QGTHDF | failed  | circle  |         2500 |        25 |        2525 |                                                                  |                                                                                                             | Insufficient treasury available balance: 1074 < 2525
```

Wallet registry:

```
            id            | source_type | source_account_id |                  address                   | network | wallet_provider | status
--------------------------+-------------+-------------------+--------------------------------------------+---------+-----------------+--------
 WAL-1785425408284-V1VL2X | treasury    | TREASURY_HOT      | 0x080e0d0ae80c86cc80bb050dbe0d5e5bdb6cd225 | circle  | circle          | active
```

Treasury final state:

```
  account_id  | balance_cents | hold_cents | available_cents
--------------+---------------+------------+-----------------
 TREASURY_HOT |           474 |          0 |             474
```

(Started at 1074, reserved 2525, then credited 2000, settled 2500 + fee retained 25 = net 474.)

## Issues found

1. **Requested 500-cent credit is insufficient for the $25.00 test.**
   The instructions said to credit `TREASURY_HOT` with `amountCents: 500`. In this database there was already a 574-cent balance, so the total after the credit was 1074 cents. The `$25.00` clearing order requires `total_cents = 2525` (amount + $0.25 fee), so it failed until an additional 2000 cents was credited. In a clean environment with only the 500-cent credit, the $25.00 Circle clear-and-settle would fail immediately.

2. **Failed clearing attempts leave a stray `pending` stablecoin payment row.**
   The first failed Circle attempt produced `CSO-1785425455157-QGTHDF` with status `failed`, but the underlying `stablecoin_payments` row `SCP-1785425455159-PYMQJO` remained `pending`:

   ```
                id            | status  | network | amount_cents | fee_cents | total_cents | tx_hash | tx_explorer | source_account_id |             destination_wallet
   --------------------------+---------+---------+--------------+-----------+-------------+---------+-------------+-------------------+--------------------------------------------
    SCP-1785425524748-RZJ97B | settled | testnet |          100 |        25 |         125 | ...     | ...         | TREASURY_HOT      | GCLZ...EXXT
    SCP-1785425468144-VSWYJU | settled | circle  |         2500 |        25 |        2525 | ...     |             | TREASURY_HOT      | 0x080e...cd225
    SCP-1785425455159-PYMQJO | pending | circle  |         2500 |        25 |        2525 |         |             | TREASURY_HOT      | 0x080e...cd225
   ```

   This means `ClearingAndSettlementEngine.clearAndSettle` does not roll back or fail the underlying `stablecoin_payments` row when `SourceOfFundsAdapter.reserve` throws. The reserve was not created (because reserve itself failed), but the payment stays in `pending`, which is a ledger inconsistency.

3. **No 500/401 errors on `/api/stablecoin/clearing/*` routes**, but unrelated local dev errors appear in the log (`/api/as2/dashboard` 500, `/api/fineract/health` 503, `/api/ach-pipeline/status` 500, `pg_dump` Fineract DB errors). These are pre-existing local setup issues and did not affect the clearing flow.

## Test assertions

- ✅ Server starts with clearing tables ensured.
- ✅ `POST /api/stablecoin/treasury/TREASURY_HOT/credit` returns `success: true`.
- ✅ Dashboard **Clearing & Settlement** card renders and **Register Wallet** succeeds with `WAL-` id.
- ✅ Circle **Clear & Settle** for `$25.00` returns `success: true`, `id` starts with `CSO-`, `status: settled`, and a `circle-shadow-` `tx_hash`.
- ✅ Stellar testnet **Clear & Settle** for `$1.00` returns `success: true`, `id` starts with `CSO-`, `status: settled`, and a real Stellar testnet `tx_hash` with a valid `tx_explorer` URL.
- ✅ Stellar Expert confirms transaction is **Successful**, ledger 3881266, 1 USDC sent.
- ✅ **List Wallets** shows the registered Circle wallet.
- ✅ **List Orders** shows both `CSO-` orders.
- ✅ Postgres persists wallet, orders, and payments correctly (except the stray pending payment noted above).
- ⚠️ Initial 500-cent credit was insufficient for the requested $25.00 test.
- ⚠️ Failed clearing order leaves a `pending` `stablecoin_payments` row.

## Artifacts

- **Screen recording:** `/home/ubuntu/screencasts/rec-475507aa-54ec-4d79-a818-07332bd174c7/rec-475507aa-54ec-4d79-a818-07332bd174c7-edited.mp4`
- **This report:** `/home/ubuntu/repos/dlbtrust-app/test-report-circle-mint-onramp.md`
