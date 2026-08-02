# DLB Trust DeFi dApp End-to-End Test Plan

**Target:** `https://dlbtrust-app.fly.dev/` (`devin/circle-mint-onramp` / PR #234 with new dApp module)  
**Auth:** Dashboard uses MetaMask fallback; API uses header `x-admin-token: dlb-admin-2026-trust`  
**Mode:** `DAPP_SHADOW=true` on the deployed app, so Safe deployment and transaction execution are simulated.

## Code references

- dApp route mounting: `server/server-3002.js` line 76
- dApp routes: `server/routes/dapp.js` lines 16-125
- Safe/payout engine: `server/integrations/dapp/dappEngine.js` lines 164, 233, 277
- Safe low-level signatures: `server/integrations/dapp/safeEngine.js` lines 54-159
- dApp frontend tabs and handlers: `public/dapp/index.html` lines 94-100, 132-150, 169-188, 392-401

## What distinguishes working from broken

- A broken dApp mount would return 404 or the legacy treasury dashboard at `/`.
- A broken Safe creation would return `success: false`, no `safe_address`, or a missing `deploy_tx_hash`.
- A broken payout flow would return `safe_tx_hash` missing, fail to store the payout, or fail to recover the second signer and execute in shadow mode.
- A broken legacy `/treasury` route would not return the old dashboard.

---

## Step 1: dApp UI renders at root and legacy /treasury still loads

**UI action:** Open `https://dlbtrust-app.fly.dev/` and `https://dlbtrust-app.fly.dev/treasury` in separate tabs.

**Pass criteria:**
- `/` shows the new DeFi dApp with tabs: Dashboard, Safe Wallets, Deposit, Payout / 2-Sig, Distribute, P2P Pay, White Label.
- `/treasury` shows the legacy treasury dashboard with sidebar and stablecoin / OFX sections.
- No `404` or `5xx`.

**Fail criteria:** Root path returns legacy dashboard, `/dapp` 404s, or `/treasury` 404s.

---

## Step 2: API Safe creation

**API action:** `POST /api/dapp/safes` with body:

```json
{
  "label": "E2E Test Safe",
  "owners": ["0x<co-owner-address>"],
  "threshold": 2,
  "deployNow": false
}
```

The `co-owner-address` is the address of a fresh secp256k1 keypair generated for this test.

**Pass criteria:**
- Response `success: true`.
- `data.status` is `deployed` (because `DAPP_SHADOW=true` auto-deploys).
- `data.safe_address` is a non-empty checksummed EVM address.
- `data.deploy_tx_hash` starts with `shadow-`.
- `data.owners` includes both the supplied co-owner address and the server hot-wallet address.
- `data.threshold` is `2`.

**Fail criteria:** `success: false`, missing `safe_address`, status not `deployed`, `deploy_tx_hash` empty, or threshold/owners incorrect.

---

## Step 3: API payout creation

**API action:** `POST /api/dapp/payouts` with body:

```json
{
  "safeId": "<safe id from Step 2>",
  "type": "payout",
  "destination": "0x000000000000000000000000000000000000dEaD",
  "value": "1000000000000000",
  "description": "dapp e2e payout"
}
```

**Pass criteria:**
- Response `success: true`.
- `data.status` is `pending`.
- `data.safe_tx_hash` is a non-empty 32-byte hash (`0x...`).
- `data.server_signature` is non-empty.

**Fail criteria:** `success: false`, missing `safe_tx_hash`, status not `pending`, or error.

---

## Step 4: Second-owner signature generation and approval

**API action:**
1. Generate a valid Ethereum signed message signature over `safe_tx_hash` using the co-owner private key.
2. `POST /api/dapp/payouts/<payoutId>/approve` with body:

```json
{
  "signature": "0x<secp256k1 signature of safe_tx_hash with Ethereum message prefix>",
  "signerAddress": "<co-owner-address>"
}
```

Signature algorithm (viem):

```js
const { privateKeyToAccount } = require('viem/accounts');
const sig = await privateKeyToAccount(coOwnerPrivKey).signMessage({ message: { raw: safeTxHash } });
```

**Pass criteria:**
- Response `success: true`.
- `data.status` is `executed`.
- `data.txHash` starts with `shadow-`.

**Fail criteria:** `success: false`, status not `executed`, or recovered signer validation error.

---

## Step 5: List Safes and Payouts in the dApp UI

**UI action:** In the dApp, navigate to **Safe Wallets** and **Payout / 2-Sig** tabs after saving the operator token.

**Pass criteria:**
- Safe Wallets table shows the newly created safe with label, address, threshold `2`, and `deployed` status.
- Payout / 2-Sig table shows the new payout with `executed` status.

**Fail criteria:** Tables empty, error toasts, or stale/incorrect status.

---

## Step 6: Confirm no console/network errors

**Pass criteria:**
- Browser console shows no `5xx` or `401` errors for `/api/dapp/*` during the recorded UI flow.

**Fail criteria:** Any `5xx` or auth error for dApp routes.
