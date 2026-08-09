# Test Plan — Canonical USDS Swap (FinOps dashboard)

## Scope
End-to-end verify the new **Canonical USDS Swap** FinOps module on the live Fly deployment. The test is read-only: we must not create, fill, or cancel the live order.

## Environment
- Deployed app: `https://dlbtrust-app.fly.dev/dapp/finops.html`
- Admin token: `dlb-admin-2026-trust` (stored in `dlb-admin-token` localStorage key)
- Backend engine: `server/integrations/dapp/dlbCanonicalSwapEngine.js`
- Routes: `server/routes/finops.js` lines 903–937 (`/api/finops/canonical-swap/*`)
- UI: `public/dapp/finops.html` lines 173 (card), 2464–2562 (panel)
- Contract: `0xf06f89f03d3a6003d8bc1bf5934b857c41258f75`
- Active order #2: `433,721.51 DLBUSD` (`0x6bA8D02596a3b091A7246e38e3e078f770D33985`) → `433,721.51 USDS` (`0xdC035D45d973E3EC169d2276DDab16f1e407384F`), tx `0x9ab8a15e56eb36023631ec92b82ec997ca87132a0e5897ed800ae0641f302558`

## Preconditions
- Browser session is clean (no stale `dlb-finops-token`).
- `localStorage.setItem('dlb-admin-token','dlb-admin-2026-trust')` is set and `loadAll()` is invoked so the Live Modules grid populates.
- Recording is active before the dashboard is visible.

## Test 1 — Canonical USDS Swap card renders on the dashboard
1. Wait for the **Live Modules** grid to render.
2. Locate the card titled **Canonical USDS Swap** with description containing `Audited P2P contract: DLBUSD/DLB-PTCUSD → USDS/USDC/DAI`.

**Pass criteria**
- Card title and description are visible in the grid.
- No `status err` banner appears in the `token-status` area.

## Test 2 — Panel opens with Contract, Create Order, and Active Orders sections
1. Click the **Canonical USDS Swap** card.

**Pass criteria**
- Panel title is `Canonical USDS Swap`.
- A **Contract** section shows a readiness badge, the deployed contract address `0xf06f89f03d3a6003d8bc1bf5934b857c41258f75`, and no error.
- A **Create Order** section shows inputs for `tokenIn`, `tokenOut`, `amountIn`, `amountOut`, `recipient`, and a **Create Order** button.
- An **Active Orders** section shows at least one row for order `2`.
- No browser console error occurs.

## Test 3 — Readiness API returns live mode and deployed contract
1. Either read the readiness display in the Contract section or call `GET /api/finops/canonical-swap/readiness` with `x-admin-token: dlb-admin-2026-trust`.

**Pass criteria**
- Response is `success: true`.
- `data.mode` equals `'live'`.
- `data.contractAddress` equals `0xf06f89f03d3a6003d8bc1bf5934b857c41258f75`.
- `data.issues` is empty or absent.

## Test 4 — Orders endpoint returns active order #2
1. Call `GET /api/finops/canonical-swap/orders` with `x-admin-token: dlb-admin-2026-trust`.
2. Call `GET /api/finops/canonical-swap/orders/2` with the same header.

**Pass criteria**
- `/orders` returns `success: true` and `data` is an array containing an object whose `orderId` is `'2'` and `active` is `true`.
- That object has `tokenIn` = `0x6bA8D02596a3b091A7246e38e3e078f770D33985`, `tokenOut` = `0xdC035D45d973E3EC169d2276DDab16f1e407384F`, `maker`/`recipient` = `0x3e53028cf69949f3B961ce786Baf2D4D75166562`.
- `/orders/2` returns the same object.

## Test 5 — Read-only quote sanity check
1. In the panel (or via `curl`), call `POST /api/finops/canonical-swap/quote` with body `{ "tokenIn": "0x6bA8D02596a3b091A7246e38e3e078f770D33985", "amountIn": "1", "tokenOut": "0xdC035D45d973E3EC169d2276DDab16f1e407384F" }`.

**Pass criteria**
- Response is `success: true`.
- `data.amountOut` equals `"1"` (1:1 quote) and `data.price` equals `"1.0"`.
- No on-chain transaction is sent.

## Test 6 — No live order state changes
1. During the entire session, do not click **Cancel** or **Create Order** for order #2, and do not call `POST /api/finops/canonical-swap/orders/2/fill` or `/cancel`.

**Pass criteria**
- After the test, `GET /api/finops/canonical-swap/orders/2` still shows `active: true` with the original `amountIn`/`amountOut`.

## Test 7 — Local checks (already passing in planning)
1. Run `npm run typecheck` in `/home/ubuntu/repos/dlbtrust-app`.
2. Run `npm test` in the same directory.

**Pass criteria**
- `npm run typecheck` exits `0`.
- `npm test` passes all suites (`7 test files`, `45 tests`).
