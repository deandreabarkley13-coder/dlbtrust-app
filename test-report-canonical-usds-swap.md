# Test Report — Canonical USDS Swap (FinOps dashboard)

## Summary
End-to-end tested the new **Canonical USDS Swap** FinOps module on the live Fly deployment. The module card renders, the panel opens, and the read-only API endpoints return the expected live contract address and active order #2. No live order state was changed. Local `npm run typecheck` and `npm test` pass. The main UI issue found is that the **Active Orders** table displays raw on-chain amounts instead of human-readable token amounts.

## Environment
- URL: `https://dlbtrust-app.fly.dev/dapp/finops.html`
- Admin token: `dlb-admin-2026-trust` (set in `localStorage` as `dlb-admin-token`)
- Contract: `0xf06f89f03d3a6003d8bc1bf5934b857c41258f75`
- Recording: `/home/ubuntu/screencasts/rec-69ab11eb-69fa-4c86-983d-67edf22a7e3c/rec-69ab11eb-69fa-4c86-983d-67edf22a7e3c-edited.mp4`

## Test Results

### 1. FinOps dashboard loads and the Canonical USDS Swap card is visible
**Result: PASS**
- The **Live Modules** grid contains a card titled **Canonical USDS Swap** with description `Audited P2P contract: DLBUSD/DLB-PTCUSD → USDS/USDC/DAI`.
- No `status err` banner appeared during `loadAll()`.

![Dashboard with card visible](https://app.devin.ai/attachments/7788b88e-54de-4fe6-bea6-78d367600de8/ss_98d68834.png)

### 2. Clicking the card opens the panel with Contract, Create Order, and Active Orders sections
**Result: PASS (with a UI formatting note)**
- Panel title is **Canonical USDS Swap**.
- **Contract** section shows the live badge and deployed contract address `0xf06f89f03d3a6003d8bc1bf5934b857c41258f75`.
- **Create Order** section shows inputs for `tokenIn`, `tokenOut`, `amountIn`, `amountOut`, and `recipient`, plus a **Create Order** button.
- **Active Orders** section shows order `2` with token addresses and `active` status.
- The **Active Orders** table currently shows raw on-chain amounts (`433721510000` / `433721510000000000000000`) rather than human-readable `433,721.51` values. The backend returns raw strings and the UI does not divide by decimals. This is a cosmetic issue that should be fixed before operators rely on the table.

![Panel with contract and active orders](https://app.devin.ai/attachments/52085b20-eab4-4901-b5ad-f1de720d364a/ss_f1d00774.png)

### 3. Readiness endpoint returns `mode: 'live'` and the deployed contract address
**Result: PASS**

```bash
curl -sS -H 'x-admin-token: dlb-admin-2026-trust' \
  https://dlbtrust-app.fly.dev/api/finops/canonical-swap/readiness
```

```json
{
  "success": true,
  "data": {
    "ready": true,
    "mode": "live",
    "issues": [],
    "contractAddress": "0xf06f89f03d3a6003d8bc1bf5934b857c41258f75"
  }
}
```

### 4. Orders endpoint returns active order #2
**Result: PASS**

```bash
curl -sS -H 'x-admin-token: dlb-admin-2026-trust' \
  https://dlbtrust-app.fly.dev/api/finops/canonical-swap/orders
```

```json
{
  "success": true,
  "data": [
    {
      "orderId": "2",
      "maker": "0x3e53028cf69949f3B961ce786Baf2D4D75166562",
      "tokenIn": "0x6bA8D02596a3b091A7246e38e3e078f770D33985",
      "amountIn": "433721510000",
      "tokenOut": "0xdC035D45d973E3EC169d2276DDab16f1e407384F",
      "amountOut": "433721510000000000000000",
      "recipient": "0x3e53028cf69949f3B961ce786Baf2D4D75166562",
      "active": true
    }
  ]
}
```

Single-order fetch also matched:

```bash
curl -sS -H 'x-admin-token: dlb-admin-2026-trust' \
  https://dlbtrust-app.fly.dev/api/finops/canonical-swap/orders/2
```

Same object as above.

### 5. Read-only quote sanity check
**Result: PASS**

```bash
curl -sS -H 'x-admin-token: dlb-admin-2026-trust' -H 'Content-Type: application/json' \
  -X POST -d '{"tokenIn":"0x6bA8D02596a3b091A7246e38e3e078f770D33985","amountIn":"1","tokenOut":"0xdC035D45d973E3EC169d2276DDab16f1e407384F"}' \
  https://dlbtrust-app.fly.dev/api/finops/canonical-swap/quote
```

```json
{
  "success": true,
  "data": {
    "tokenIn": "0x6bA8D02596a3b091A7246e38e3e078f770D33985",
    "tokenOut": "0xdC035D45d973E3EC169d2276DDab16f1e407384F",
    "amountIn": "1",
    "amountOut": "1",
    "price": "1.0",
    "note": "P2P swap; amountOut is the maker asking price. A taker must supply that amount of canonical token to fill."
  }
}
```

No on-chain transaction was sent.

### 6. No live order state changed
**Result: PASS**
- Did not click **Cancel** or **Create Order**.
- Did not call `POST /api/finops/canonical-swap/orders/2/fill` or `/cancel`.
- After the test, `GET /api/finops/canonical-swap/orders/2` still returns `active: true` with the original `amountIn`/`amountOut`.

### 7. Local checks
**Result: PASS**
- `npm run typecheck` exits `0`.
- `npm test` passes: `7 test files`, `45 tests`.

## Issues Found
1. **UI formatting issue (cosmetic):** The **Active Orders** table displays raw `amountIn`/`amountOut` values from the contract without converting to human-readable units. For order #2 the UI shows `433721510000` / `433721510000000000000000` instead of `433,721.51` DLBUSD / `433,721.51` USDS. The fix is to format `amountIn` with `viem.formatUnits(amountIn, tokenInDecimals)` and `amountOut` with `viem.formatUnits(amountOut, tokenOutDecimals)` (or fetch decimals via `DlbCanonicalSwapEngine._decimals`).

## Artifacts
- Screen recording: `/home/ubuntu/screencasts/rec-69ab11eb-69fa-4c86-983d-67edf22a7e3c/rec-69ab11eb-69fa-4c86-983d-67edf22a7e3c-edited.mp4`
- Test plan: `/home/ubuntu/repos/dlbtrust-app/test-plan-canonical-usds-swap.md`
- Updated skill: `/home/ubuntu/repos/dlbtrust-app/.agents/skills/testing-dlbtrust-app/SKILL.md`
- Test report: `/home/ubuntu/repos/dlbtrust-app/test-report-canonical-usds-swap.md`
