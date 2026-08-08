# Test Plan — Liquidity Pool Engine (PR #274)

## Scope
End-to-end verify the new **Liquidity Pool Engine** module card and panel on the deployed FinOps dashboard (`/dapp/finops.html`), the read-only `GET` pool endpoints, and the `POST /api/finops/liquidity-pool/quote` endpoint. No live mainnet writes will be executed.

## Environment
- Deployed app: `https://dlbtrust-app.fly.dev/dapp/finops.html`
- Admin token: `dlb-admin-2026-trust`
- API base: `https://dlbtrust-app.fly.dev/api/finops/liquidity-pool`
- Backend: `server/integrations/dapp/liquidityPoolEngine.js`; routes in `server/routes/finops.js`
- UI code: `public/dapp/finops.html` (line 164, lines 1581–1658)
- Live BondDex pool (`BOND_DEX_ADDRESS`): `0x6d81a71daa0aea908d57c31251db0013b2e41aea`
  - token0: `0x6bA8D02596a3b091A7246e38e3e078f770D33985` (DLBUSD, 6 decimals)
  - token1: `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` (WETH, 18 decimals)

## Preconditions
- Browser opened to `/dapp/finops.html` in a fresh session with admin token saved and `loadAll()` triggered.
- Recording starts once the dashboard is visible.

## Test 1 — Dashboard renders the Liquidity Pool Engine card
1. Wait for the Live Modules grid to load.

**Pass criteria**
- The grid contains a card titled **Liquidity Pool Engine** with description containing "Full pool lifecycle: create, add/remove liquidity, swap, and positions".
- No `status err` banner appears.

## Test 2 — Panel loads with all required inputs and a Pools list
1. Click the **Liquidity Pool Engine** card.
2. Wait for the panel to render.

**Pass criteria**
- Panel title is **Liquidity Pool Engine**.
- A **Create Pool** section is visible with inputs for token A address, token B address, decimals A, decimals B, amount A, amount B, and a **Create Pool** button.
- An **Add / Remove Liquidity** section is visible with inputs for pool address, amount A, amount B, and **Add** / **Remove LP** buttons.
- A **Swap / Quote** section is visible with inputs for pool address, token in address, amount in, min out / slippage, recipient, and **Quote** / **Swap** buttons.
- A **Pools** section is shown (empty or listing pools).
- No `status err` banner appears.

## Test 3 — GET /api/finops/liquidity-pool returns success
1. Call `GET https://dlbtrust-app.fly.dev/api/finops/liquidity-pool` with header `x-admin-token: dlb-admin-2026-trust`.

**Pass criteria**
- HTTP `200` with JSON `success: true`.
- `data` is an array (empty or populated).

## Test 4 — GET /api/finops/liquidity-pool/:address returns the live pool
1. Call `GET https://dlbtrust-app.fly.dev/api/finops/liquidity-pool/0x6d81a71daa0aea908d57c31251db0013b2e41aea`.

**Pass criteria**
- HTTP `200` with JSON `success: true`.
- `data.poolAddress` matches `0x6d81...1aea`.
- `data.token0`, `data.token1`, `data.decimals0`, `data.decimals1`, `data.reserve0`, `data.reserve1` are present and non-empty.

## Test 5 — POST /api/finops/liquidity-pool/quote returns a live quote
1. Call `POST /api/finops/liquidity-pool/quote` with:
   ```json
   {
     "poolAddress": "0x6d81a71daa0aea908d57c31251db0013b2e41aea",
     "tokenIn": "0x6bA8D02596a3b091A7246e38e3e078f770D33985",
     "amountIn": "1",
     "decimalsIn": 6
   }
   ```

**Pass criteria**
- HTTP `200` with JSON `success: true`.
- `data.tokenOut` is `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`.
- `data.amountOut` and `data.amountOutMinimum` are positive numeric strings.
- `data.mode` is `live`.

## Test 6 — UI Quote button returns a quote for the live pool
1. Fill the panel **Swap / Quote** inputs:
   - Pool address: `0x6d81a71daa0aea908d57c31251db0013b2e41aea`
   - Token in address: `0x6bA8D02596a3b091A7246e38e3e078f770D33985`
   - Amount in: `1`
2. Click **Quote**.

**Pass criteria**
- The quote result box appears with `Out:` followed by a positive amount and the token-out address prefix.
- No `status err` banner appears.

## Test 7 — Controlled error for an invalid pool
1. Call `POST /api/finops/liquidity-pool/quote` with `poolAddress: 0x0000000000000000000000000000000000000000`.

**Pass criteria**
- The response is either HTTP `200` with `success: false` and an `error` message, or HTTP `500` with a clear error body; it must not crash the server or return a stack trace to the UI.

## Test 8 — Regression in surrounding cards
1. Close the Liquidity Pool Engine panel.
2. Open **Canonical Money** and **Stablecoin Engine** cards.

**Pass criteria**
- Each panel opens with its correct title and controls.
- No `status err` banner appears.

## Failure / abort criteria
- If the **Liquidity Pool Engine** card is missing, abort and report a frontend/deploy issue.
- If `GET /api/finops/liquidity-pool` returns `success: false` or `500`, abort and report a backend issue.
- If the quote endpoint crashes (returns HTML/stack trace) for the valid pool, report a backend bug.
