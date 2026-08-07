# Test Plan — Peer/ZKP2P P2P fiat on-ramp integration

## Scope
Verify the new Peer On-Ramp card and `/api/finops/peer-onramp/*` routes on the deployed `dlbtrust-app.fly.dev`. The primary flow is: open the panel, get a live quote, prepare the `signalIntent` calldata, attempt to signal on Base, and confirm a gas/funds error is surfaced cleanly. Also regression-check the existing FinOps module cards.

## Environment
- Deployed app: `https://dlbtrust-app.fly.dev/dapp/finops.html`
- Operator token: `dlb-admin-2026-trust`
- Operator wallet: `0x3e53028cf69949f3B961ce786Baf2D4D75166562`
- Operator Base ETH balance: `0` (confirmed via `eth_getBalance` on Base)
- Peer contract target: `0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7`
- Chain ID: `8453`

## Preconditions
- Browser open and maximized; operator token saved in `localStorage` or entered in the Operator Access card.
- Recording started after setup.

## Test 1 — Peer On-Ramp card and quote
1. Navigate to `/dapp/finops.html`.
2. Confirm the Live Modules grid shows a **Peer On-Ramp** card with description `P2P fiat to USDC on Base (CashApp/Venmo/Wise)`.
3. Click the **Peer On-Ramp** card to open the panel.
4. Leave platform as `cashapp`, fiat as `USD`, amount as `10`.
5. Click **Get Quote**.

**Pass criteria**
- Panel opens with title `Peer On-Ramp`.
- Quote response renders a JSON block containing `available: true`.
- `fiatAmount` is present (e.g. `4.87 USD`).
- `tokenAmount` is present (e.g. `4.97 USDC`).
- `paymentInstructions.offchainId` is a non-empty string (e.g. `TsoKX2q70iRpkCAmJaeh`).
- `intent` object includes `depositId`, `processorName`, `amount`, `toAddress`, `payeeDetails`, `escrowAddress`, and `chainId: 8453`.
- Status message shows `Quote ready.` and **Prepare Signal** button appears.

## Test 2 — Prepare Signal
1. In the Peer On-Ramp panel, click **Prepare Signal**.

**Pass criteria**
- API returns `success: true`.
- The response renders a `prepared` transaction object with:
  - `to`: `0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7`
  - `chainId`: `8453`
  - `value`: `0`
  - `data` is a non-empty hex string starting with `0x`
- Status message shows `Prepared. Need Base gas to execute.` and **Signal Intent (Base gas)** button appears.

## Test 3 — Signal Intent fails cleanly with zero Base ETH
1. Click **Signal Intent (Base gas)**.
2. Wait for the API response.

**Pass criteria**
- UI does not crash or blank out.
- A status/error message appears in `peer-status`.
- The error is a gas/revert/insufficient funds type message (e.g. `insufficient funds for intrinsic transaction cost` or `The total amount... exceeds account balance`).
- No successful `txHash` is returned and no intent is recorded by `GET /api/finops/peer-onramp/intents`.

## Test 4 — Regression: existing FinOps modules still load
1. Click **Core Banking** card.
2. Confirm table or data loads without errors.
3. Click **P2P Module Swap** card.
4. Confirm the active orders table renders (at least the existing orders).
5. Click **Spritz Off-Ramp** card.
6. Confirm the panel opens and shows the Spritz user/load UI without a hard error.

**Pass criteria**
- All three module panels open and render their content/controls.
- No `err` status banner for any of the modules.

## Failure / abort criteria
- If `GET /api/finops/peer-onramp/quote` fails before returning a quote, abort and report the error.
- If the operator wallet is found to have a non-zero Base ETH balance, abort the execute step and report, to avoid an unintended real transaction.
