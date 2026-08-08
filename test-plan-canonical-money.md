# Test Plan — Canonical Money Engine on FinOps Dashboard

## Scope
End-to-end verify the new **Canonical Money** module card and panel on the deployed FinOps dashboard (`/dapp/finops.html`). Test the quote flow for a ledger source and for DLB-PTCUSD, then create and approve a tiny conversion and capture the expected on-chain gas failure.

## Environment
- Deployed app: `https://dlbtrust-app.fly.dev/dapp/finops.html`
- Admin token: `dlb-admin-2026-trust`
- API base: `https://dlbtrust-app.fly.dev/api/finops/canonical-money`
- Backend: `server/integrations/dapp/canonicalMoneyEngine.js` and routes in `server/routes/finops.js`
- UI code: `public/dapp/finops.html` (lines 164, 1580–1650)

## Preconditions
- Browser opened to `/dapp/finops.html` in a fresh session with the admin token saved in `localStorage` as `dlb-admin-token` and `loadAll()` triggered.
- Recording started once the dashboard is visible.

## Test 1 — Canonical Money card is visible
1. Wait for the Live Modules grid to load.

**Pass criteria**
- The grid contains a card titled **Canonical Money** with description containing "Turn trust assets and income into canonical spendable stablecoins".
- Surrounding cards **Canonical Liquidity**, **Coordination Engine**, etc., remain visible.

## Test 2 — Panel loads conversion form and request list
1. Click the **Canonical Money** card.
2. Wait for the panel to render.

**Pass criteria**
- Panel title is **Canonical Money**.
- A **Convert Asset / Income** section is visible with fields:
  - Source type dropdown (`cash`, `treasury`, `trust`, `bond`, `fixed_income`, `fineract`, `sub_ledger`, `DLB-PTCUSD`, `DLB-PRB`, etc.)
  - Source account / token address input
  - Amount input
  - Target asset dropdown (`USDC`, `USDS`, `DAI`, `WETH`, `ETH`)
  - Pool address input (optional)
  - Recipient input (optional)
  - **Quote** and **Propose** buttons
- A **Conversion Requests** section is shown (empty or listing prior requests).
- No `status err` banner appears.

## Test 3 — Quote for a ledger source (fixed_income / account 1 → USDC)
1. Select source type `fixed_income / bond_interest`.
2. Enter source account / id `1`.
3. Enter amount `1`.
4. Leave target asset as `USDC`.
5. Click **Quote**.

**Pass criteria**
- The quote result box shows `Route: mint_and_swap` and the note "Mint DLBUSD from ledger and swap on DEX".
- The route object contains `sourceType: 'fixed_income'`, `sourceAccountId: '1'`, `targetAsset: 'USDC'`.
- No error banner is shown.

## Test 4 — Quote for DLB-PTCUSD → USDC with no pool
1. Change source type to `DLB-PTCUSD`.
2. Leave source id empty.
3. Enter amount `100`.
4. Leave target asset as `USDC`.
5. Click **Quote**.

**Pass criteria**
- The quote result box shows `Route: ptc_swap` and the note "No canonical liquidity pool found; create one first".
- `poolAddress` is `null` or absent.
- No error banner is shown.

## Test 5 — Propose a tiny fixed_income → USDC conversion and approve as checker
1. With source type `fixed_income`, source id `1`, amount `0.01`, target `USDC`, click **Propose**.

**Pass criteria**
- `POST /api/finops/canonical-money/requests` returns `201` with `success: true`, a `requestId`, and a `proposalId`.
- The new request appears in the **Conversion Requests** list with `status: pending` and an **Approve** control that includes:
  - a role dropdown (`maker`/`checker`)
  - an email input
  - an **Approve** button
2. Select role `checker` and enter email `dbnettrust@gmail.com`.
3. Click the request's **Approve** button.

**Pass criteria**
- The request body sent by the UI includes `role` and `approverEmail`.
- The backend executes the proposal; because the operator wallet has ~0.000008 ETH, the on-chain mint fails with an `insufficient funds for gas * price + value` error.
- After reload, the request status changes from `pending` to `failed` and the `result.error` contains the gas/balance message.

## Test 6 — Verify UI approve button for Canonical Liquidity also passes role/email (regression of the previous fix)
1. Open the **Canonical Liquidity** panel.
2. Create a new `create_pool` proposal or use an existing pending one.
3. Use the **Approve** control in the Proposals list.

**Pass criteria**
- The approve request body includes `role` and `approverEmail`.
- It does not fail with `Unknown consensus role: undefined`.
- If it triggers execution, it fails only due to gas (expected).

## Test 7 — Regression in surrounding cards
1. Close the Canonical Money panel.
2. Open **Canonical Liquidity**, **Stablecoin Engine**, and **Redemption Gateway** one at a time.

**Pass criteria**
- Each panel opens with its correct title, form, and data.
- No `status err` banner appears.

## Test 8 — Local sanity checks
1. Run `npm run typecheck` in `/home/ubuntu/repos/dlbtrust-app`.
2. Run `npm test`.

**Pass criteria**
- `npm run typecheck` exits `0`.
- `npm test` passes all tests.

## Failure / abort criteria
- If the **Canonical Money** card is missing from the dashboard, abort and report a deploy/frontend issue.
- If the **Quote** button returns `success: false` or `500`, abort and report a backend issue.
- If the approve button still fails with `Unknown consensus role`, report that the UI fix did not land.
