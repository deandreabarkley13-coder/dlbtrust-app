# Live DeFi dApp Bond-Token / DEX End-to-End Test Plan

**Target:** `https://dlbtrust-app.fly.dev/` (`devin/circle-mint-onramp`, PR #234)  
**Auth:** `x-admin-token: dlb-admin-2026-trust`  
**Mode:** `DAPP_SHADOW=false` on Sepolia — real on-chain transactions, real gas.

## What changed

- `server/routes/dapp.js` added bond-token and DEX routes (lines 220-270).
- `server/integrations/dapp/bondTokenizationEngine.js` creates ERC-20 bond tokens through the on-chain `BondTokenFactory` (`BOND_TOKEN_FACTORY` env; `.env.example` line 271 = `0x2df7755239615ea7792ffd2db005c2ca10f826dd`) and mints via `BondToken.mint`.
- `server/integrations/dapp/dexSwapEngine.js` deploys a `BondDex` constant-product pool for two ERC-20s, approves both tokens, seeds liquidity, quotes from the pool reserves, and swaps `tokenIn -> USDC`.
- `public/dapp/index.html` lines 102 and 297-335 expose a **Bond Tokens** tab with UI for **Create Token**, **Mint**, **Get Quote**, and **Execute Swap**; pool creation is only available via API.

## What distinguishes working from broken

- Broken factory wiring returns `success: false`, a `shadow-` address, or 5xx from `POST /api/dapp/bond-tokens`.
- Broken mint wiring returns a non-chain `txHash` (null/shadow) or 5xx.
- Broken pool wiring returns `shadow-pool-`, no `0x` `poolAddress`, or `receipt.status !== success`.
- Broken swap wiring returns a `shadow-` hash, a quote that ignores pool reserves, or a failed on-chain transaction.
- A real Sepolia flow must return live `0x...` transaction hashes for token creation/mint, pool deploy/liquidity, and swap; these hashes must be visible on a Sepolia explorer.

## Preconditions

- Operator hot wallet (`0x3e53028cf69949f3B961ce786Baf2D4D75166562`) has enough Sepolia ETH for factory deploy + mint + pool deploy + approvals + addLiquidity + swap (estimated ~2.0–2.2M gas at current ~1.09 gwei base fee).
- Operator wallet holds a small amount of Sepolia USDC (deployed env `DAPP_USDC_ADDRESS = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` per `.env.example` line 266) to seed the pool.
- Admin token is saved in the dApp UI (`dlb-admin-2026-trust`).

## Step 1: Open dApp and verify the Bond Tokens tab

**UI action:**
1. Open `https://dlbtrust-app.fly.dev/`.
2. If the **Operator Token** card is visible, click it and ensure `dlb-admin-2026-trust` is set.
3. Click the **Bond Tokens** tab in the nav.

**Pass criteria:**
- Page loads and nav contains **Bond Tokens**.
- The **Tokenize Fixed Income / Bond Position**, **Mint Bond Tokens**, and **DEX Swap** cards are visible.
- No `401`/`403` errors in the browser console for `/api/dapp/*`.

**Fail criteria:** Missing tab, console auth errors, or JS errors.

## Step 2: Create a new bond token (UI)

**UI action:**
1. In the **Tokenize Fixed Income / Bond Position** card:
   - Bond ID: `999` (or leave blank)
   - Token Name: `DLB Live Test Bond`
   - Token Symbol: `DLBLIVE`
2. Click **Create Token**.

**Pass criteria:**
- `bt-create-result` shows a success message with a `BTOK-...` id and an `0x...` `token_address` (not `shadow-`).
- API response `POST /api/dapp/bond-tokens` returns `success: true` and `data.token_address` starts with `0x`.
- The Sepolia transaction is confirmed on `https://sepolia.etherscan.io/tx/<creation-tx-hash>` (the engine logs the tx hash in the server; it is returned in `data.token_address` only, so the token contract address is verified on-chain).

**Fail criteria:** Error message, `shadow-` address, or 5xx response.

**Note:** This uses the factory at `0x2df7755239615ea7792ffd2db005c2ca10f826dd`.

## Step 3: Mint bond tokens to the operator wallet (UI)

**UI action:**
1. In the **Mint Bond Tokens** card:
   - Token ID: the `BTOK-...` id from Step 2
   - Principal: `10000`
   - Interest: `0`
   - Holder Address: `0x3e53028cf69949f3B961ce786Baf2D4D75166562` (operator hot wallet)
2. Click **Mint**.

**Pass criteria:**
- `bt-mint-result` shows `Minted 10000 ...` and the `total_supply` is `10000`.
- API response `POST /api/dapp/bond-tokens/<id>/mint` returns `success: true`, `data.txHash` is non-empty and starts with `0x` (live Sepolia hash).
- `GET /api/dapp/bond-tokens/<id>/holdings` shows the operator wallet balance as `10000`.

**Fail criteria:** Error message, empty/null `txHash`, or holdings not updated.

## Step 4: Create a DEX pool via API (token + USDC)

**API action:** `POST /api/dapp/dex/pools` with header `x-admin-token: dlb-admin-2026-trust` and body:
```json
{
  "tokenA": "<BOND_TOKEN_ADDRESS_FROM_STEP_2>",
  "tokenB": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  "amountA": 10000,
  "amountB": 1,
  "decimalsA": 6,
  "decimalsB": 6
}
```

**Pass criteria:**
- Response `success: true`.
- `data.poolAddress` starts with `0x` and is not `shadow-pool-`.
- `data.txHash` is non-empty and starts with `0x`.
- Pool `token0`/`token1` and `reserve0`/`reserve1` on Sepolia match the supplied tokens/amounts.

**Fail criteria:** `shadow-` address, 5xx, or `txHash` missing.

**Note:** The engine deploys a new `BondDex` (`.env.example` lines 276-278), sorts tokens by address, approves both tokens, and calls `addLiquidity`.

## Step 5: Get a live DEX quote (UI)

**UI action:**
1. In the **DEX Swap (Bond Token → USDC)** card:
   - Token In: the bond token `0x...` address from Step 2
   - Amount In: `10`
2. Click **Get Quote**.

**Pass criteria:**
- `dex-result` shows a quote with `mode: live`, `amountOut` computed from the pool reserves with 0.3% fee, and `price` > 0.
- API response `POST /api/dapp/dex/quote` returns `success: true`, `data.mode: 'live'`, and `data.amountOut` matches the constant-product math `(10 * 0.997) / (10000 + 10*0.997) * 1 USDC` ≈ `0.0009969`.

**Fail criteria:** `mode: shadow`, negative or zero `amountOut`, 5xx.

## Step 6: Execute a live bond → USDC swap (UI)

**UI action:**
1. Use the same Token In and Amount In from Step 5.
2. Click **Execute Swap**.

**Pass criteria:**
- `dex-result` shows `Swap executed: tx <0x...>`.
- API response `POST /api/dapp/dex/swap` returns `success: true`, `data.status: 'executed'`, `data.mode: 'live'`, and a non-empty `0x...` `txHash`.
- The swap transaction is visible and successful on Sepolia explorer (`https://sepolia.etherscan.io/tx/<txHash>`).

**Fail criteria:** `status: shadow`, `txHash` starts with `shadow-dex-`, 5xx, or explorer shows failure.

## Step 7: Run regression checks

**Shell action:** In the repo root, run:
- `npm run typecheck`
- `npm test`

**Pass criteria:**
- `typecheck` exits 0.
- `npm test` reports `45 passed` across 7 test files.

**Fail criteria:** Any failing test or type error.

## Fallback if gas is insufficient

If any live on-chain step fails because the operator wallet lacks Sepolia ETH, record the exact API error, current operator balance, and request a top-up before continuing. Do not mask the failure with shadow-mode calls.
