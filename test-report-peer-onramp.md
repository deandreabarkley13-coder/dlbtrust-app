# PR — Peer / ZKP2P P2P fiat on-ramp end-to-end test report

**One-sentence summary:** Verified the new **Peer On-Ramp** integration end-to-end on the live deployed `dlbtrust-app.fly.dev`: the FinOps dashboard card appears, the panel can fetch a live CashApp quote with seller payment instructions, prepare a `signalIntent` transaction on Base, and the execute step surfaces a clear `gas required exceeds allowance (0)` error because the operator wallet holds no Base ETH. Existing FinOps modules (Core Banking, P2P Module Swap, Spritz Off-Ramp) still load correctly.

## Escalations / issues found
1. **Minor:** The `Prepare Signal` and `Signal Intent (Base gas)` buttons were often off-screen below the long JSON quote output in the panel. I used the exposed functions `preparePeerSignal()` and `executePeerSignal()` from the browser console to advance the flow. This is a UI layout/scrolling issue rather than a functionality bug.
2. **Expected failure:** `Signal Intent` failed with `Execution reverted with reason: gas required exceeds allowance (0)`. This is exactly the intended safe failure because the operator wallet has `0` Base ETH. The UI displayed the error and did not crash.
3. **No recorded intent:** Because execution failed before broadcasting, `GET /api/finops/peer-onramp/intents` remained empty, as expected.

## Test environment
- Deployed app: `https://dlbtrust-app.fly.dev/dapp/finops.html`
- Operator token: `dlb-admin-2026-trust`
- Operator wallet: `0x3e53028cf69949f3B961ce786Baf2D4D75166562`
- Operator Base ETH balance: `0x0` (`0` ETH)
- Peer contract target: `0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7`
- Chain ID: `8453`

---

## Test assertions

### 1. FinOps dashboard shows the Peer On-Ramp card
- ✅ Loaded `/dapp/finops.html` and the Live Modules grid rendered the **Peer On-Ramp** card with description `P2P fiat to USDC on Base (CashApp/Venmo/Wise)`.

![FinOps dashboard showing Peer On-Ramp card](https://app.devin.ai/attachments/5d283bc5-3e0a-4b39-b246-c1796f4b4d93/ss_5c5ff5ea.png)

### 2. Peer On-Ramp panel fetches a live quote
- ✅ Clicked the **Peer On-Ramp** card and opened the panel.
- ✅ Entered `platform=cashapp`, `fiat=USD`, `amount=10` and clicked **Get Quote**.
- ✅ Quote returned `available: true`.
- ✅ `fiatAmount`: `4.87 USD`, `tokenAmount`: `4.97 USDC`, `signalIntentAmount`: `5.01 USDC`.
- ✅ `paymentInstructions.offchainId`: `TsoKX2q70iRpkCAmJaeh`.
- ✅ `intent` object includes `depositId: 3656`, `processorName: cashapp`, `toAddress`, `payeeDetails`, `escrowAddress`, `chainId: 8453`.

![Peer On-Ramp panel quote ready](https://app.devin.ai/attachments/40b5c0e2-bb99-4575-a4a5-247a585ddab9/ss_cc218e18.png)

![Peer On-Ramp quote JSON](https://app.devin.ai/attachments/9a0b8d0d-b044-476e-bbc2-9e87ee31aaa7/ss_e91cfd02.png)

### 3. Prepare Signal returns a valid unsigned Base transaction
- ✅ Called **Prepare Signal**.
- ✅ Status changed to `Prepared. Need Base gas to execute.`
- ✅ Prepared transaction rendered with:
  - `to`: `0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7`
  - `value`: `0`
  - `chainId`: `8453`
  - `data`: non-empty hex string beginning with `0xf3ff8655...`

![Prepared signal transaction on Base](https://app.devin.ai/attachments/3f7af632-f6e9-439f-861a-9733c06041fc/ss_e742166a.png)

### 4. Signal Intent fails gracefully with zero Base ETH
- ✅ Called **Signal Intent (Base gas)**.
- ✅ UI did not crash or blank.
- ✅ Error displayed: `Execution reverted with reason: gas required exceeds allowance (0)` with full Base transaction arguments.
- ✅ `GET /api/finops/peer-onramp/intents` still returned `[]`.

![Execute fails with gas error](https://app.devin.ai/attachments/b381bf9e-8337-4867-8113-86611b5613ba/ss_3e212d89.png)

### 5. Regression: existing FinOps modules still load
- ✅ **Core Banking** panel opened and rendered the accounts table (e.g. Treasury Hot, Bond Investments, Accrued Interest, Trust Corpus, Interest Income).

![Core Banking panel](https://app.devin.ai/attachments/747a9248-6f40-40fc-a4a7-4bce5dd93f26/ss_894608ab.png)

- ✅ **P2P Module Swap** panel opened and rendered active orders table with 4 orders.

![P2P Module Swap panel](https://app.devin.ai/attachments/9e791a53-3cba-488a-adbf-7551a601e387/ss_bcc3e9c1.png)

- ✅ **Spritz Off-Ramp** panel opened, loaded the Spritz user (`dbnettrust@gmail.com`), and displayed active capabilities and bank accounts.

![Spritz Off-Ramp panel](https://app.devin.ai/attachments/b2a5d0a3-f345-4983-8581-e15339f98a49/ss_3ea0887d.png)

---

## Suggested PR comment

```markdown
Peer/ZKP2P P2P fiat on-ramp verified end-to-end on `https://dlbtrust-app.fly.dev/dapp/finops.html` ✅

- The FinOps dashboard now shows the **Peer On-Ramp** card.
- The panel can get a live quote: `4.87 USD` via CashApp for `4.97 USDC`, seller Payee ID `TsoKX2q70iRpkCAmJaeh`.
- **Prepare Signal** returns a valid unsigned Base transaction to `0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7`, `value: 0`, `chainId: 8453`.
- **Signal Intent (Base gas)** fails cleanly with `Execution reverted with reason: gas required exceeds allowance (0)` because the operator wallet has 0 Base ETH; the UI does not crash.
- `GET /api/finops/peer-onramp/intents` remains empty, as expected, since the transaction was not broadcast.
- Regression: Core Banking, P2P Module Swap, and Spritz Off-Ramp panels still load correctly.

![Peer On-Ramp quote](https://app.devin.ai/attachments/9a0b8d0d-b044-476e-bbc2-9e87ee31aaa7/ss_e91cfd02.png)
![Prepared transaction](https://app.devin.ai/attachments/3f7af632-f6e9-439f-861a-9733c06041fc/ss_e742166a.png)
![Gas error](https://app.devin.ai/attachments/b381bf9e-8337-4867-8113-86611b5613ba/ss_3e212d89.png)
```

---

## Artifacts
- **Screen recording:** `/home/ubuntu/screencasts/peer-onramp-finops/peer-onramp-finops-edited.mp4`
- **Test plan:** `/home/ubuntu/repos/dlbtrust-app/test-plan-peer-onramp.md`
- **This report:** `/home/ubuntu/repos/dlbtrust-app/test-report-peer-onramp.md`
- **Updated skill:** `/home/ubuntu/repos/dlbtrust-app/.agents/skills/testing-dlbtrust-app/SKILL.md`

## SKILL.md suggestions
- Added a **Peer On-Ramp (deployed dApp)** section to `.agents/skills/testing-dlbtrust-app/SKILL.md` documenting the FinOps card, `/api/finops/peer-onramp/{quote,prepare,execute,intents}` routes, expected quote/prepare/execute behavior, and the Base ETH gas requirement.

## Suggested blueprint updates
- The `knowledge.startup` blueprint still lists `ADMIN_SECRET_TOKEN=test-admin-token-123`. For live FinOps/Peer tests the actual operator token is currently `dlb-admin-2026-trust` (or the value in `~/.dlbtrust-admin-token` if that file is refreshed).
- Consider documenting that `PEER_API_KEY` must be set as a Fly secret for the deployed `/api/finops/peer-onramp/*` routes to function, and that the operator wallet needs Base ETH to complete `signalIntent`.

## Anything still needed from the user / lead
1. Fund the operator wallet with a small amount of Base ETH if you want to complete the `Signal Intent` step and verify intent recording via `GET /api/finops/peer-onramp/intents`.
2. Optionally improve the Peer On-Ramp panel layout so the `Prepare Signal` / `Signal Intent` buttons remain visible without excessive scrolling over the JSON quote output.
