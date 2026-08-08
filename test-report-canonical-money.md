# Test Report — Canonical Money Engine on `dlbtrust-app.fly.dev`

**Tested on:** `https://dlbtrust-app.fly.dev/dapp/finops.html`  
**Admin token used:** `dlb-admin-2026-trust`  
**Operator address:** `0x3e53028cf69949f3B961ce786Baf2D4D75166562`  
**Operator ETH balance at test time:** `0.000008027257292042 ETH`

## Summary

End-to-end verified the new **Canonical Money** FinOps module. The dashboard card is visible, the panel loads the conversion form and request list, quotes return the expected routes, and a tiny `fixed_income -> USDC` proposal can be created, checker-approved, and executed. Execution predictably fails with `insufficient funds for gas * price + value` because the operator wallet is nearly empty. The **Approve** UI for Canonical Money (and Canonical Liquidity) now correctly sends `role` and `approverEmail` in the request body. Local `npm run typecheck` and `npm test` both pass.

## Test evidence

### 1. Canonical Money card visible

The FinOps dashboard loads and shows the **Canonical Money** card next to the other modules.

![Dashboard card](https://app.devin.ai/attachments/7e8da7b5-b469-4514-9f88-c6c73b583868/ss_9b11f886.png)

### 2. Panel loads conversion form + request list

Opening the panel reveals the conversion form (source type, source id, amount, target asset, optional pool/recipient) and the existing request list.

### 3. Quote for `fixed_income` / account `1` / amount `1` / target `USDC`

**Expected route:** `mint_and_swap`  
**Result:** ✅ `Route: mint_and_swap` — `Mint DLBUSD from ledger and swap on DEX`

![Fixed income quote](https://app.devin.ai/attachments/6f82fb2f-e01a-451d-94e8-2f3451d9108f/ss_868bf3a3.png)

### 4. Quote for source `DLB-PTCUSD` / amount `100` / target `USDC`

**Expected route:** `ptc_swap` with no pool available  
**Result:** ✅ `Route: ptc_swap` — `No canonical liquidity pool found; create one first`

![DLB-PTCUSD no pool quote](https://app.devin.ai/attachments/f0af8eec-dd19-4c10-aefb-6f64be509626/ss_1c01ad90.png)

### 5. Propose + approve tiny `fixed_income -> USDC` conversion

A new request `CM-1786192844227-10LJLH` (proposal `CC-1786192844230-4WVLWM`) for `0.01` fixed_income to USDC was created with status `pending`.

The UI approve control was set to `checker` / `dbnettrust@gmail.com` and clicked. A browser fetch interceptor confirmed the request body:

```json
{"role":"checker","approverEmail":"dbnettrust@gmail.com"}
```

Auto-execution then failed predictably due to insufficient operator ETH. The UI alert shows:

> The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.

![Money approve gas error](https://app.devin.ai/attachments/893d082c-84eb-48a2-b442-bcf8e36c3b5e/ss_2e448d24.png)

The canonical proposal record confirms the failure:

```json
{
  "id": "CC-1786192844230-4WVLWM",
  "category": "canonical_money",
  "status": "failed",
  "result": {
    "error": "insufficient funds for gas * price + value: have 8027257292042 want 73426000000000\n...mint(address to, uint256 value)..."
  },
  "approvals": [
    {
      "role": "checker",
      "email": "dbnettrust@gmail.com",
      "status": "approved"
    }
  ]
}
```

### 6. UI approve button passes `role` and `approverEmail` ✅

Both **Canonical Money** and **Canonical Liquidity** approve controls send `role` + `approverEmail`. The previous `Unknown consensus role: undefined` bug is fixed.

![Liquidity approve with role/email](https://app.devin.ai/attachments/32a1795b-9f88-45a9-823f-bda478cd828e/ss_13b63894.png)

### 7. Regression check — surrounding cards still load

- **Stablecoin Engine** panel loaded with token supply and reserve details.
- **Redemption Gateway** panel loaded with request form and existing requests.

![Stablecoin Engine regression](https://app.devin.ai/attachments/a2f1d77d-3581-42ba-a0c6-855a7c2cd012/ss_1da37043.png)

![Redemption Gateway regression](https://app.devin.ai/attachments/15d6ac1d-a5f3-4318-8ab5-d02aa0f96151/ss_db2bb066.png)

### 8. Local sanity checks

- `npm run typecheck` exited `0`.
- `npm test` passed: `7 test files`, `45 tests`.

## Issues / observations

1. **Status mismatch on failure:** When `CanonicalMoneyEngine._executeRoute` throws, `CanonicalMoneyEngine._execute` does not catch it, so the `canonical_money_requests` table keeps `status = 'pending'` and `result = {}`. The parent `canonical_proposals` row is correctly updated to `failed` with the error. If the UI request list is trusted, this can look like the request is still pending. Consider wrapping `_executeRoute` in `try/catch` inside `_execute` and writing the error to `canonical_money_requests`.
2. **Operator ETH is too low for any real conversion/pool creation.** This is expected and documented; the operator wallet has ~8 Gwei.
3. **UI card stat is `—`.** `loadAll()` does not populate the Canonical Money stat; it is cosmetic for this PR.

## Artifacts

- Screen recording: `/home/ubuntu/screencasts/rec-3af52cb0-3919-49af-adee-8573501dcdfc/rec-3af52cb0-3919-49af-adee-8573501dcdfc-edited.mp4`
- Test plan: `/home/ubuntu/repos/dlbtrust-app/test-plan-canonical-money.md`
- Test report: `/home/ubuntu/repos/dlbtrust-app/test-report-canonical-money.md`
- Updated skill: `/home/ubuntu/repos/dlbtrust-app/.agents/skills/testing-dlbtrust-app/SKILL.md`

## Suggested PR comment

```markdown
Canonical Money Engine verified end-to-end on `https://dlbtrust-app.fly.dev/dapp/finops.html` ✅

- New **Canonical Money** card appears on the FinOps dashboard and the panel loads the conversion form + request list.
- `fixed_income` → `USDC` quote returns `Route: mint_and_swap` (mint DLBUSD then DEX swap).
- `DLB-PTCUSD` → `USDC` quote returns `Route: ptc_swap` with `No canonical liquidity pool found; create one first`.
- Created a `0.01` `fixed_income -> USDC` request; checker approval from the UI now sends `role` and `approverEmail` in the request body (the previous `Unknown consensus role` bug is fixed for both Money and Liquidity).
- Execution predictably fails with `insufficient funds for gas * price + value` because the operator wallet has ~0.000008 ETH; the `canonical_proposals` record updates to `failed` with the error.
- Regression: Stablecoin Engine and Redemption Gateway panels still load correctly.
- `npm run typecheck` and `npm test` (45/45) pass.

![Dashboard card](https://app.devin.ai/attachments/7e8da7b5-b469-4514-9f88-c6c73b583868/ss_9b11f886.png)
![Fixed income quote](https://app.devin.ai/attachments/6f82fb2f-e01a-451d-94e8-2f3451d9108f/ss_868bf3a3.png)
![DLB-PTCUSD no pool](https://app.devin.ai/attachments/f0af8eec-dd19-4c10-aefb-6f64be509626/ss_1c01ad90.png)
![Money approve gas error](https://app.devin.ai/attachments/893d082c-84eb-48a2-b442-bcf8e36c3b5e/ss_2e448d24.png)
```

## Remaining note for the lead

`CanonicalMoneyEngine._execute` should catch `_executeRoute` errors and persist `status='failed'` plus the error message in `canonical_money_requests`, mirroring what `CanonicalConsensusEngine.executeProposal` already does for `canonical_proposals`.
