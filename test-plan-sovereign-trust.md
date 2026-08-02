# Sovereign Trust Token (SIT) End-to-End Test Plan

## Environment
- Local server: `http://localhost:3002/dapp`
- Admin token: `dlb-admin-2026-trust` (saved in dApp UI `admin-token` field)
- Shadow mode env: `SOVEREIGN_TRUST_SHADOW=true`, `SOVEREIGN_RESERVE_ACCOUNT=TREASURY_HOT`
- Server process: `PORT=3002 BOND_DB_NAME=dlbtrust node server/server-3002.js`

## Scope
Prove the self-issued Sovereign Trust Token (SIT) flow works end-to-end through the dApp UI:
1. Readiness shows shadow mode and no deployment.
2. Deploy Token & Forwarder returns shadow addresses.
3. Mint SIT (on-ramp) debits a source-of-funds ledger, returns an order, and updates the Ramp Orders table.
4. Gasless SIT Transfer builds a meta-tx payload and is relayed through the UI without requiring a real wallet.
5. Burn SIT (off-ramp) returns an order and updates the Ramp Orders table.
6. `npm test` and `npm run typecheck` pass locally.

## Pre-conditions
- Server is running locally with the SIT shadow env and `BOND_DB_NAME=dlbtrust`.
- Browser is maximized (`wmctrl -r :ACTIVE: -b add,maximized_vert,maximized_horz`).
- dApp token field is set to `dlb-admin-2026-trust`.

---

## Test Case 1: Sovereign Trust readiness and deployment

### Steps
1. Open `http://localhost:3002/dapp`.
2. In the dApp, enter `dlb-admin-2026-trust` in the operator token field and save if prompted.
3. Click the **Sovereign Trust** tab.
4. Observe the readiness card.
5. Click **Deploy Token & Forwarder**.
6. Observe the readiness card again.

### Pass/Fail Criteria
- **P1.1** The readiness card displays `mode: "shadow"` and `token: { deployed: false }` before deploy.
- **P1.2** After deploy, the response shows `success: true`, `shadow: true`, a `token` address starting with `shadow-token-`, and a `forwarder` address starting with `shadow-forwarder-`.
- **P1.3** The readiness card no longer shows `deployed: false`; it shows the generated shadow token/forwarder addresses.
- **P1.4** No 5xx/auth errors appear in the browser console for `/api/dapp/sovereign-trust/*` calls.

---

## Test Case 2: Mint SIT (on-ramp) from treasury

### Steps
1. Ensure the **Sovereign Trust** tab is open.
2. In the **Mint SIT** form:
   - Source Type: `treasury`
   - Source Account ID: `TREASURY_HOT`
   - Amount: `0.10`
   - Recipient Address: `0x9B3601d3e395d2A40F910161669F87fe64195CF7` (or any valid 0x address)
   - Memo: `SIT test on-ramp`
3. Click **Mint SIT**.
4. Observe the result area and the **Ramp Orders** table.

### Pass/Fail Criteria
- **P2.1** The result area shows `success: true`, a shadow `tx` starting with `shadow-tx-mint-`, an `orderId` starting with `SIT-RAMP-`, `amount: "0.10"`, and `token` matching the deployed shadow token.
- **P2.2** The **Ramp Orders** table contains a new row with `Direction: on_ramp`, `Source: treasury:TREASURY_HOT`, `Amount: 0.10`, and `Status: completed`.
- **P2.3** The on-chain tx cell in the table starts with `shadow-tx-mint-`.

---

## Test Case 3: Gasless SIT Transfer (meta-tx relay)

### Steps
1. In the **Gasless SIT Transfer** form:
   - From: `0x9B3601d3e395d2A40F910161669F87fe64195CF7`
   - To: `0x0000000000000000000000000000000000000001`
   - Amount: `0.05`
2. Open the browser console and mock `window.ethereum` so MetaMask is not required:
   ```js
   window.ethereum = {
     request: async ({ method, params }) => {
       if (method === 'eth_signTypedData_v4') return '0x' + '1'.repeat(130);
       return null;
     }
   };
   ```
3. Click **Sign in MetaMask**.
4. Click **Relay Signed Tx**.
5. Observe the result area.

### Pass/Fail Criteria
- **P3.1** After **Sign in MetaMask**, the result area shows `Signed. Click Relay Signed Tx.` (green/success).
- **P3.2** After **Relay Signed Tx**, the result area shows `success: true`, `shadow: true`, and a `tx` starting with `shadow-relay-`.
- **P3.3** No uncaught errors appear in the browser console during the sign/relay flow.

---

## Test Case 4: Burn SIT (off-ramp) back to treasury

### Steps
1. In the **Burn SIT** form:
   - Source Type (credit): `treasury`
   - Source Account ID: `TREASURY_HOT`
   - Amount: `0.05` (must be <= minted amount)
   - From Address: `0x9B3601d3e395d2A40F910161669F87fe64195CF7`
   - Memo: `SIT test off-ramp`
2. Click **Burn SIT & Release Reserve**.
3. Observe the result area and the **Ramp Orders** table.

### Pass/Fail Criteria
- **P4.1** The result area shows `success: true`, a shadow `tx` starting with `shadow-tx-burnFrom-`, an `orderId` starting with `SIT-RAMP-`, `amount: "0.05"`, and `releasedTo: treasury:TREASURY_HOT`.
- **P4.2** The **Ramp Orders** table contains a new row with `Direction: off_ramp`, `Source: treasury:TREASURY_HOT`, `Amount: 0.05`, and `Status: completed`.
- **P4.3** The table now shows at least one `on_ramp` record and one `off_ramp` record.

---

## Test Case 5: Local checks

### Steps
1. In the repo root, run `npm test`.
2. Run `npm run typecheck`.

### Pass/Fail Criteria
- **P5.1** `npm test` exits 0 and reports all tests passed.
- **P5.2** `npm run typecheck` exits 0 with no TypeScript errors.

---

## Evidence to Capture
- Screenshot of the **Sovereign Trust** tab before deploy (readiness card with `deployed: false`).
- Screenshot of the **Sovereign Trust** tab after deploy (shadow token/forwarder addresses).
- Screenshot of the **Mint SIT** result and Ramp Orders table after on-ramp.
- Screenshot of the **Gasless SIT Transfer** result after relay.
- Screenshot of the **Burn SIT** result and Ramp Orders table after off-ramp.
- Terminal output of `npm test` and `npm run typecheck`.
- Browser console log showing no 5xx/auth errors during the flow.
