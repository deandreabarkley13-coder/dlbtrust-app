# Test Plan — PTC-backed stablecoin FinOps dashboard card

## Scope
Verify the new `PTC Stablecoin` module card and panel on the deployed FinOps dashboard (`/dapp/finops.html`). The primary flow is read-only: confirm the card stat, open the panel, and cross-check the API data. Write/deposit/redeem/transfer actions are not executed.

## Environment
- Deployed app: `https://dlbtrust-app.fly.dev/dapp/finops.html`
- Admin token: `dlb-admin-2026-trust`
- Expected PTC token: `0xb01e6280ffe6faac679a17b029df8e065e8d0002`
- Expected PTC vault: `0xc8b2f6909b50a43ac839e74c3d0e82ae060094d1`
- Expected total supply: `211,187,497.44` DLB-PTCUSD (API `totalSupply`)
- Expected recipient balance for `0x491c175a4C24106e52a7423f216a56af7786125F`: `100` DLB-PTCUSD

## Preconditions
- Browser open to `/dapp/finops.html` in a fresh session (no cached `dlb-finops-token`/`dlb-admin-token` stale state).
- Admin token saved in `localStorage` as `dlb-admin-token` or trustee email/PIN flow completed.
- Recording started after setup.

## Test 1 — Dashboard loads and PTC Stablecoin card appears with non-zero stat
1. Load `/dapp/finops.html`.
2. Authenticate (admin token or trustee email/PIN).
3. Wait for `loadAll()` to finish.

**Pass criteria**
- The Live Modules grid includes a card titled **PTC Stablecoin** with description `DLB-PTCUSD backed by bond/fixed-income reserves`.
- The card stat is non-zero and reflects the API `totalSupply` (e.g. `$211,187,497` or similar, depending on formatting).
- All other module cards also load their stats (Core Banking, Treasury, etc.).

## Test 2 — PTC Stablecoin panel displays token/vault/owner/reserves
1. Click the **PTC Stablecoin** card.
2. Wait for the panel to load.

**Pass criteria**
- Panel title is `PTC Stablecoin`.
- The panel shows:
  - **Token:** `DLB-PTCUSD — 0xb01e...0002`
  - **Vault:** `0xc8b2...94d1`
  - **Total Supply:** `211,187,497.44 DLB-PTCUSD` (or matching formatted value)
  - **Owner:** `0x3e5302...` (operator wallet)
- The **Reserve Tokens** list shows at least five reserves (DLB-BOND, DLB-FIXED-INCOME, DLB-TREASURY, DLB-TRUST, DLB-CORE) with non-zero vault balances.
- The panel includes read-only sections for Deposit Reserve, Manage, Transfer/Redeem, but no write action is executed.

## Test 3 — API sanity checks
1. `curl -H 'x-admin-token: dlb-admin-2026-trust' https://dlbtrust-app.fly.dev/api/finops/ptc-stablecoin`
2. `curl -H 'x-admin-token: dlb-admin-2026-trust' https://dlbtrust-app.fly.dev/api/finops/ptc-stablecoin/balance/0x491c175a4C24106e52a7423f216a56af7786125F`

**Pass criteria**
- `/api/finops/ptc-stablecoin` returns `success: true`, `data.deployed: true`, `data.tokenAddress` and `data.vaultAddress` matching expected addresses, `data.totalSupply` > 0.
- `/balance/...` returns `success: true`, `data.balance: "100"`.

## Test 4 — Local checks
1. Run `npm run typecheck` in `/home/ubuntu/repos/dlbtrust-app`.
2. Run `npm test` in the same directory.

**Pass criteria**
- `npm run typecheck` exits `0`.
- `npm test` passes all tests.

## Failure / abort criteria
- If the `PTC Stablecoin` card is missing from the dashboard, abort and report a deploy/frontend issue.
- If the API returns `deployed: false` or a 403/401, abort and report auth or deploy issue.
