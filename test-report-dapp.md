# DLB Trust DeFi dApp End-to-End Test Report

**Target:** `https://dlbtrust-app.fly.dev/` (`devin/circle-mint-onramp` / PR #234 with new dApp module)  
**Auth:** `x-admin-token: dlb-admin-2026-trust`  
**Recording:** `/home/ubuntu/screencasts/rec-dapp-e2e/rec-dapp-e2e-edited.mp4`

## Summary

The new DeFi dApp was verified end-to-end on the deployed Fly.io app. The dApp renders correctly at `/` with all seven tabs, the Safe/payout 2-signature flow works through the backend API in `DAPP_SHADOW=true` mode, and the legacy treasury dashboard remains available at `/treasury`. MetaMask is not injected in the test browser, so the second-owner signature was generated with `viem` and submitted via the API.

---

## UI evidence

### Dashboard and tabs

The dApp loads at `/` and shows Dashboard, Safe Wallets, Deposit, Payout / 2-Sig, Distribute, P2P Pay, and White Label tabs.

![Dashboard](https://app.devin.ai/attachments/c66ce7ce-bc8d-435b-ac38-6eb41e9eaa75/ss_6e805c45.png)

### Safe Wallets — create Safe

Created a new Safe from the UI with label **E2E Test Safe**, co-owner `0xfc6963Ef45eB6DBf8ED9208d69319702A06CBd85`, and threshold `2`.

![Safe created](https://app.devin.ai/attachments/40036353-29f4-4e41-8c69-18c1a245b626/ss_d3cf3c04.png)

### Payout / 2-Sig — executed payout

The payout proposed via API is listed with `executed` status in the dApp UI.

![Payout executed](https://app.devin.ai/attachments/c867f622-d869-4066-b1b3-eb5726f54786/ss_ae49e092.png)

### Other tabs render

Deposit, Distribute, P2P Pay, and White Label sections all rendered without console errors.

![Deposit tab](https://app.devin.ai/attachments/35bf7342-7e2b-42d4-b0e5-6592e8be8e21/ss_e6bd2f17.png)
![Distribute tab](https://app.devin.ai/attachments/bd21ae1d-db96-4a3d-94c2-9cf639a06a9c/ss_ae3182c3.png)
![P2P Pay tab](https://app.devin.ai/attachments/5b423def-fb83-4857-b128-5bf6ded44e80/ss_674247a4.png)
![White Label tab](https://app.devin.ai/attachments/52b11de3-c00e-4a41-a892-e93dfc66e288/ss_d295924e.png)

### Legacy `/treasury` still loads

The existing Treasury Dashboard remains accessible at `/treasury` with its sidebar and stats.

![Treasury dashboard](https://app.devin.ai/attachments/bec6553c-aa01-41a5-a00b-732f52eed476/ss_37d25184.png)

---

## API test evidence

### Safe creation response

```json
{
  "success": true,
  "data": {
    "id": "SAFE-1785503005767-KKHCP7",
    "label": "E2E Test Safe",
    "safe_address": "0x0F2f954c1e7FBee6063F0ab91f55b143041c37AF",
    "chain_id": 11155111,
    "owners": [
      "0xfc6963Ef45eB6DBf8ED9208d69319702A06CBd85",
      "0x3e53028cf69949f3B961ce786Baf2D4D75166562"
    ],
    "threshold": 2,
    "salt_nonce": "0",
    "deploy_tx_hash": "shadow-1785503006085",
    "status": "deployed"
  }
}
```

The server hot wallet (`0x3e530...`) was automatically appended to the supplied owner, and the Safe was deployed in shadow mode.

### Payout creation response

```json
{
  "success": true,
  "data": {
    "id": "PAY-1785503031919-3BKHWG",
    "safe_id": "SAFE-1785503005767-KKHCP7",
    "status": "pending",
    "safe_tx_hash": "0x8ab2c416f63ec0e8b9a6ab4eab60979f290111f8ad8a06876ebc24b98653af5b",
    "server_signature": "0xd30091dd5946138b8ecdb55d780ec11d8791775d01b67151f5e1d10c0bb3c7c67468ce092d2e32201a79366e148c28356dfcddc7020e9fb4e383b65b98b8148a20",
    "safeTxHash": "0x8ab2c416f63ec0e8b9a6ab4eab60979f290111f8ad8a06876ebc24b98653af5b",
    "needsSignature": true,
    "pendingApprovals": 1
  }
}
```

### Second-owner signature

Generated offline with `viem`:

```js
const { privateKeyToAccount } = require('viem/accounts');
const sig = await privateKeyToAccount(coOwnerPrivKey)
  .signMessage({ message: { raw: safeTxHash } });
// 0x5378c28d920e2bb60b35fd6184abf877014048a95df359f371d34bf58c0035e837d977214f6962675cfcba9d66a544ef16778ad83964da63b6a2e19fad35d8911c
```

### Payout approval / execution response

```json
{
  "success": true,
  "data": {
    "id": "PAY-1785503031919-3BKHWG",
    "status": "executed",
    "safe_tx_hash": "0x8ab2c416f63ec0e8b9a6ab4eab60979f290111f8ad8a06876ebc24b98653af5b",
    "signatures": [
      {
        "kind": "proposer",
        "signer": "0x3e53028cf69949f3B961ce786Baf2D4D75166562",
        "signature": "0xd30091dd...8148a20"
      },
      {
        "kind": "approver",
        "signer": "0xfc6963Ef45eB6DBf8ED9208d69319702A06CBd85",
        "signature": "0x5378c28d...35d8911c"
      }
    ],
    "txHash": "shadow-1785503050307"
  }
}
```

The `GET /api/dapp/payouts/PAY-1785503031919-3BKHWG` endpoint confirms the stored `tx_hash` is `shadow-1785503050307`.

---

## Assertions

| Assertion | Result |
|-----------|--------|
| `/` returns the new dApp with all 7 tabs | ✅ passed |
| Safe created via UI returns `deployed` status and a valid `safe_address` | ✅ passed |
| Safe owners include both the supplied co-owner and the server hot wallet | ✅ passed |
| `POST /api/dapp/payouts` returns `pending` with a non-empty `safe_tx_hash` | ✅ passed |
| Second-owner signature generated with `viem` is accepted by `/payouts/:id/approve` | ✅ passed |
| Approval returns `executed` and a shadow `txHash` | ✅ passed |
| Payout table in UI shows the new payout as `executed` | ✅ passed |
| Legacy `/treasury` still loads the old dashboard | ✅ passed |
| No 5xx or auth errors in the browser console for `/api/dapp/*` | ✅ passed |

---

## Observations / notes

- **MetaMask not available:** The test browser has no wallet injection, so the dApp's `connectWallet()` cannot get an EOA account. The second-owner approval was therefore performed via `viem` + `curl`. This is acceptable per the test instructions.
- **Minor API response inconsistency:** `approvePayout` returns the executed payout object with a top-level `txHash` property set to the shadow hash, but the legacy `tx_hash` field in the returned object remains `null` until re-fetched. The stored row (confirmed by `GET`) contains `tx_hash: "shadow-..."`. This is a harmless serialization quirk, but it makes the immediate response slightly confusing.
- **Expo mobile wrapper:** The `dapp/App.js` React Native wrapper was not tested because it requires a mobile/emulator build. The wrapped URL (`https://dlbtrust-app.fly.dev/dapp`) loads the same HTML app.

---

## Suggested PR comment

```markdown
DLB Trust DeFi dApp end-to-end test passed ✅

**Tested:** `https://dlbtrust-app.fly.dev/`

**Passed:**
- dApp renders at `/` with Dashboard, Safe Wallets, Deposit, Payout / 2-Sig, Distribute, P2P Pay, White Label tabs.
- Created Safe `SAFE-1785503005767-KKHCP7` from the UI → `deployed`, threshold 2, owners include co-owner `0xfc69…Bd85` and server hot wallet `0x3e53…6562`.
- Created payout `PAY-1785503031919-3BKHWG` via API → `safe_tx_hash` returned, status `pending`.
- Generated second-owner `viem` signature over the `safe_tx_hash` and approved via `POST /api/dapp/payouts/PAY-1785503031919-3BKHWG/approve`.
- Approval returned `status: executed` and `txHash: shadow-1785503050307`.
- dApp Payout table shows the new payout as `executed`.
- Legacy Treasury Dashboard still loads at `/treasury`.
- No 5xx or auth errors in console for `/api/dapp/*`.

**Notes:**
- MetaMask is not available in the test browser, so the second signature was produced offline with `viem` and sent via API.
- `approvePayout` returns `txHash` in the response but `tx_hash` in the object body is `null` until re-fetched; DB row is correct.

![Dashboard](https://app.devin.ai/attachments/c66ce7ce-bc8d-435b-ac38-6eb41e9eaa75/ss_6e805c45.png)
![Safe created](https://app.devin.ai/attachments/40036353-29f4-4e41-8c69-18c1a245b626/ss_d3cf3c04.png)
![Payout executed](https://app.devin.ai/attachments/c867f622-d869-4066-b1b3-eb5726f54786/ss_ae49e092.png)
![Treasury legacy](https://app.devin.ai/attachments/bec6553c-aa01-41a5-a00b-732f52eed476/ss_37d25184.png)
```
