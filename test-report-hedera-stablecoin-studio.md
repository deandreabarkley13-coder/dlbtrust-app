# Hedera Stablecoin Studio End-to-End Test Report

**Target:** `https://dlbtrust-app.fly.dev/` (`devin/hedera-stablecoin-studio` branch)  
**Auth:** `admin` / `dlb-admin-2026-trust`  
**Recording:** `/home/ubuntu/screencasts/rec-d8faae83-98eb-41fb-8282-88a8c8da4f3e/rec-d8faae83-98eb-41fb-8282-88a8c8da4f3e-edited.mp4`

## Summary

The Hedera Stablecoin Studio integration was exercised end-to-end through the Stablecoin Payments dashboard in **shadow mode**. A DLBUSD stablecoin was created, minted, and used to fund a `$1.00` Hedera Testnet payment that was approved and settled. The final API response confirmed `status: settled`, a non-empty `tx_hash`, and `metadata.hederaTokenId` matching the created token. Treasury accounting reduced and recovered correctly.

---

## Test evidence

### 1. Hedera readiness and stablecoin creation/mint

The in-card **Readiness** button returned `Hedera Ready: OK` (not shown separately in the top stat card, see Observations). The stablecoin was created with token ID `0.0.shadow-1785428926905`, minted to `0.0.101`, and the balance check returned `0` as expected in shadow mode.

![Hedera stablecoin created and minted](https://app.devin.ai/attachments/35687ed1-ccd1-42ba-9720-251f8f2f702d/ss_3a0aa70d.png)

### 2. Payment creation

The Create Stablecoin Payment form was filled with:

- Destination: `0.0.101`
- Amount: `$1.00`
- Source Type: `Treasury`
- Source Account: `TREASURY_HOT`
- Asset Code: `DLBUSD`
- Network: `Hedera Testnet`

![Payment form populated](https://app.devin.ai/attachments/248d4431-4263-47e4-a76a-a3072b7cbd5f/ss_70b5702c.png)

The dashboard reported `Payment created: SCP-1785428987469-FX45OZ`.

![Payment created](https://app.devin.ai/attachments/99afbf66-d482-44db-8270-615ce814ff28/ss_d0bb13da.png)

### 3. Approve and treasury hold

Before approve, the treasury source balance was `Available: $994.00`.

![Before approve](https://app.devin.ai/attachments/1740ef2d-958d-40ba-8d7d-346fb507e646/ss_2c891ec6.png)

After approve, `Available: $992.75`, reflecting the `$1.25` total hold ($1.00 + $0.25 gateway fee). The payment row updated to `approved`.

![After approve](https://app.devin.ai/attachments/87746cce-3c71-4709-b7e0-84acb10d5384/ss_afe989ae.png)

### 4. Settle and final balance

After settle, the source balance returned to `Available: $993.00` (the `$1.00` disbursed minus the retained `$0.25` fee). The payment row showed `settled`.

![After settle](https://app.devin.ai/attachments/479b41c9-8f94-425d-a449-64a93f249199/ss_ae4d2baf.png)

### 5. API verification

```bash
curl -s -H 'x-admin-token: dlb-admin-2026-trust' \
  https://dlbtrust-app.fly.dev/api/stablecoin/payments/SCP-1785428987469-FX45OZ
```

Response:

```json
{
  "success": true,
  "data": {
    "id": "SCP-1785428987469-FX45OZ",
    "status": "settled",
    "amount_cents": "100",
    "fee_cents": "25",
    "total_cents": "125",
    "asset_code": "DLBUSD",
    "network": "hedera-testnet",
    "destination_wallet": "0.0.101",
    "source_type": "treasury",
    "source_account_id": "TREASURY_HOT",
    "reserve_id": "RES-1785429015245-6fnal1",
    "tx_hash": "shadow-1785429039259",
    "metadata": {
      "hederaTokenId": "0.0.shadow-1785428926905",
      "beneficiaryName": "",
      "fyStackWalletId": "",
      "circleSourceAddress": ""
    }
  }
}
```

`/api/stablecoin/health` returned `ready: true` and `/api/stablecoin/hedera/readiness` returned `ready: true, mode: shadow, network: testnet, operatorId: 0.0.100`.

---

## Assertions

| Assertion | Result |
|-----------|--------|
| Hedera in-card readiness shows OK | ✅ passed |
| Stablecoin creation returns `0.0.shadow-*` token ID | ✅ passed |
| Mint returns `shadow-*` tx ID | ✅ passed |
| `$1.00` DLBUSD payment created with total `$1.25` | ✅ passed |
| Approve reduces available by `$1.25` and reserves funds | ✅ passed |
| Settle returns non-empty `tx_hash` | ✅ passed |
| Settle updates `metadata.hederaTokenId` to created token | ✅ passed |
| Final treasury available reduced by exactly `$1.00` (fee retained) | ✅ passed |
| No 500/401 errors during flow | ✅ passed |

---

## Observations / notes

- The top **Readiness** stat card shows `Ready` but does **not** display a separate `Hedera Ready` badge. The Hedera Studio card's own **Readiness** button correctly reports `Hedera Ready: OK`.
- Because the tool's 1024x768 coordinate space does not map reliably to small form buttons on the 1600×1069 viewport, form fields were populated and action handlers were triggered via short JavaScript snippets in the browser console. Navigation and visual state changes are captured in the recording.
- The deployed app is in Hedera **shadow mode**, so all token IDs and transaction hashes are synthetic (`0.0.shadow-*` / `shadow-*`). No live Hashgraph transaction was submitted.

---

## Suggested PR comment

```markdown
Hedera Stablecoin Studio end-to-end test passed ✅

**Tested:** `https://dlbtrust-app.fly.dev/` in shadow mode.

**Passed:**
- Hedera Stablecoin Studio card shows `Hedera Ready: OK`.
- Created DLBUSD stablecoin: `0.0.shadow-1785428926905`.
- Minted `100` DLBUSD to `0.0.101` with tx `shadow-1785428944113`.
- Created `$1.00` Hedera Testnet payment `SCP-1785428987469-FX45OZ` (total `$1.25`).
- Approved: treasury available dropped `$994.00` → `$992.75`.
- Settled: payment row `settled`, final treasury available `$993.00` (fee retained).
- API confirmed `status: settled`, `tx_hash: shadow-1785429039259`, and `metadata.hederaTokenId: 0.0.shadow-1785428926905`.

**Note:** The top readiness stat card does not show a separate `Hedera Ready` badge; the in-card Readiness button is the reliable indicator.

![Hedera stablecoin created and minted](https://app.devin.ai/attachments/35687ed1-ccd1-42ba-9720-251f8f2f702d/ss_3a0aa70d.png)
![Payment created](https://app.devin.ai/attachments/99afbf66-d482-44db-8270-615ce814ff28/ss_d0bb13da.png)
![After settle](https://app.devin.ai/attachments/479b41c9-8f94-425d-a449-64a93f249199/ss_ae4d2baf.png)
```
