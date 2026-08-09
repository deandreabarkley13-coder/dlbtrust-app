# Test Plan — Canonical Liquidity Engine on FinOps Dashboard

## Scope
End-to-end verify the new **Canonical Liquidity** module card and panel on the deployed FinOps dashboard (`/dapp/finops.html`), the create/approve/execute proposal flow for a tiny `create_pool` proposal, and that the surrounding modules still render correctly. The on-chain execution is expected to fail because the operator wallet has insufficient mainnet ETH.

## Environment
- Deployed app: `https://dlbtrust-app.fly.dev/dapp/finops.html`
- Admin token: `dlb-admin-2026-trust`
- Canonical Liquidity API base: `https://dlbtrust-app.fly.dev/api/finops/liquidity`
- PTC token (token A): `0xb01e6280ffe6faac679a17b029df8e065e8d0002`
- USDC (token B): `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
- Tiny amounts: `0.001` / `0.001`
- Checker email/role fallback: `dbnettrust@gmail.com` / `checker`

## Preconditions
- Browser opened to `/dapp/finops.html` in a fresh session.
- Legacy admin token saved in `localStorage` as `dlb-admin-token` and `loadAll()` triggered.
- Recording started once dashboard is visible.

## Test 1 — Dashboard renders the Canonical Liquidity card and surrounding modules
1. Load `/dapp/finops.html` after setting admin token and triggering `loadAll()`.
2. Wait for Live Modules grid to populate.

**Pass criteria**
- The grid contains a card titled **Canonical Liquidity** with description containing "Governed DEX liquidity pools and swaps for trust assets".
- Surrounding cards **Canonical Consensus**, **Redemption Gateway**, and **Stablecoin Engine** are visible in the same grid.
- No JS error banner appears in the page.

## Test 2 — Canonical Liquidity panel loads proposal form, pools, and proposals
1. Click the **Canonical Liquidity** card.
2. Wait for the panel to render.

**Pass criteria**
- Panel title is **Canonical Liquidity**.
- The **Create Proposal** form is visible with fields: Action (`create_pool`), Title, Pool, Token A, Token B, Amount A, Amount B, Recipient, and a **Propose** button.
- A **Pools** section is shown (even if currently empty: `No pools`).
- A **Proposals** section is shown listing existing proposals (if any) with their status.
- No `status err` banner appears.

## Test 3 — Create a create_pool proposal and approve/execute it
1. Fill the Create Proposal form:
   - Action: `create_pool`
   - Title: `Create DLB-PTCUSD/USDC pool (tiny test)`
   - Token A: `0xb01e6280ffe6faac679a17b029df8e065e8d0002`
   - Token B: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
   - Amount A: `0.001`
   - Amount B: `0.001`
2. Click **Propose**.
3. After the new proposal appears in the Proposals list, click its **Approve** button.
   - If the UI approve button fails with `Unknown consensus role`, capture the error; then fall back to the API to approve as checker:
     ```bash
     curl -s -H 'x-admin-token: dlb-admin-2026-trust' \
       -H 'Content-Type: application/json' \
       -X POST \
       -d '{"role":"checker","approverEmail":"dbnettrust@gmail.com"}' \
       https://dlbtrust-app.fly.dev/api/finops/liquidity/proposals/<id>/approve
     ```
4. Because the default threshold is `1` and `maker`/`checker` are both valid, the approval should trigger execution automatically.

**Pass criteria**
- `POST /api/finops/liquidity/proposals` returns `201` with `success: true` and a `proposalId`.
- The new proposal appears in the panel with `status: pending`.
- After approval, the proposal transitions to `status: failed` (not `pending`).
- The proposal `result.error` contains text about insufficient balance / gas cost exceeding account balance, e.g. `"The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account."`
- This failure is captured as expected behavior due to low operator ETH; the UI or API does not crash.

## Test 4 — Liquidity API endpoints return valid JSON
1. `curl -H 'x-admin-token: dlb-admin-2026-trust' https://dlbtrust-app.fly.dev/api/finops/liquidity`
2. `curl -H 'x-admin-token: dlb-admin-2026-trust' https://dlbtrust-app.fly.dev/api/finops/liquidity/proposals`

**Pass criteria**
- Both return HTTP `200` and JSON with `success: true`.
- `/api/finops/liquidity` returns `data` array (list of pools).
- `/api/finops/liquidity/proposals` returns `data` array of proposals; the newly created/failed proposal appears with `id`, `title`, `category: 'liquidity'`, `payload.action`, and `status`.

## Test 5 — Regression: surrounding module cards still load
1. Close the Canonical Liquidity panel.
2. Click **Canonical Consensus**, **Redemption Gateway**, and **Stablecoin Engine** cards one at a time.

**Pass criteria**
- Each panel opens with its correct title and no `status err` banner.
- Canonical Consensus panel shows the **Create Proposal** form and at least lists existing proposals or `No pending proposals`.
- Redemption Gateway panel shows the **Create Request** form.
- Stablecoin Engine panel shows mint/redeem/transfer/settle controls.

## Test 6 — Local sanity checks
1. In `/home/ubuntu/repos/dlbtrust-app` run `npm run typecheck`.
2. Run `npm test`.

**Pass criteria**
- `npm run typecheck` exits `0`.
- `npm test` passes all tests.

## Failure / abort criteria
- If the **Canonical Liquidity** card is missing from the dashboard, abort and report a frontend/deploy issue.
- If `POST /api/finops/liquidity/proposals` returns `success: false` or `500`, abort and report backend issue.
- If the execution failure message is something other than gas/insufficient funds (e.g. contract ABI missing, bytecode missing, `tokenA required`), report as a real bug.
