# Live DeFi dApp Bond-Token / DEX End-to-End Test Report

**Target:** `https://dlbtrust-app.fly.dev/` (`devin/circle-mint-onramp`, PR #234)  
**Mode:** `DAPP_SHADOW=false` on Sepolia — real on-chain transactions, real gas  
**Auth:** `x-admin-token: dlb-admin-2026-trust`

## One-sentence summary

The live bond-token factory, DEX pool creation, and bond → USDC swap flow on Sepolia were verified end-to-end: a new ERC-20 bond token was created through the factory, minted to the operator wallet, a new BondDex pool was seeded with bond tokens + USDC, and a live swap returned a successful Sepolia `txHash` confirmed on Blockscout.

## Escalations / observations

- The first `POST /api/dapp/dex/pools` attempt failed with `addLiquidity` reverted because the request tried to seed `1.0 USDC` while the operator wallet only held `0.93 USDC`. Reducing the seed amount to `0.5 USDC` succeeded.
- During the run an unrelated `fees is not defined` error appeared in `DexSwapEngine.createPool`/`.swap` because `walletClient()` returned `fees` but the call sites did not destructure it. A later commit (`65255ca`) fixed this by destructuring `fees` in `bondTokenizationEngine.js` and `dexSwapEngine.js`.
- The final live swap was executed after the operator wallet was refilled with Sepolia ETH; the swap `txHash` was provided by the lead and verified on-chain and on Blockscout.

## Test assertions

- ✅ dApp loads at `https://dlbtrust-app.fly.dev/dapp` and the **Bond Tokens** tab is present and functional.
- ✅ `/api/dapp/bond-tokens/readiness` and `/api/dapp/dex/readiness` return `mode: live`, `ready: true`.
- ✅ `POST /api/dapp/bond-tokens` created a live ERC-20 bond token `BTOK-1785531547752-4WH658` at `0xb2712300ae339ef73557A8b79EA3BB127270Be6a`.
- ✅ `POST /api/dapp/bond-tokens/<id>/mint` minted `100,000` tokens to the operator wallet.
- ✅ `POST /api/dapp/dex/pools` deployed and seeded a new BondDex pool at `0x47698a4d50ddfc0eb4ffc36927b4b569a1dfb24f` with `0.5 USDC` + `100,000` bond tokens (`tx 0x56ce...baba`).
- ✅ Final live bond → USDC swap executed against the new pool: `tx 0xf467...3c89`, status `success`, gasUsed `83,361`, Blockscout shows `Swap 10 DLBLV1785531547580 for 0.000049 USDC`.
- ✅ On-chain balances after final swap match: operator `USDC = 0.431620`, operator `BOND = 90`, pool `USDC = 0.499951`, pool `BOND = 100,010`.
- ✅ Mint tx `0x4848...ff14` is confirmed on Sepolia, minting an additional `100` DLBLV tokens before the swap.
- ✅ `npm run typecheck` passed.
- ✅ `npm test` passed (7 test files, 45/45 tests).

## Evidence

**dApp Bond Tokens tab with token creation and mint results**
![Bond Tokens UI](https://app.devin.ai/attachments/7284f220-44a4-49c4-af77-d519dc6df8ed/ss_b787bfe6.png)

**Blockscout: token contract page**
![Token contract](https://app.devin.ai/attachments/f6924b6c-e240-4546-97c5-f7493ec7e37c/ss_391a564b.png)

**Blockscout: pool creation / addLiquidity tx**
![Pool creation tx](https://app.devin.ai/attachments/7e7b16f7-a52b-4e8b-9faa-ad3476ceaff8/ss_6a15bb7e.png)

**Blockscout: mint tx**
![Mint tx](https://app.devin.ai/attachments/15b87ed0-83b1-4769-9e89-831b1e928530/ss_371d2509.png)

**Blockscout: final swap tx**
![Swap tx](https://app.devin.ai/attachments/7dac4654-a780-48be-877e-8fc4f9ae0ada/ss_997dc3c3.png)

## On-chain details

| Item | Value |
|------|-------|
| Bond token ID | `BTOK-1785531547752-4WH658` |
| Bond token address | `0xb2712300ae339ef73557A8b79EA3BB127270Be6a` |
| Bond token symbol | `DLBLV1785531547580` |
| BondDex pool | `0x47698a4d50ddfc0eb4ffc36927b4b569a1dfb24f` |
| Pool token0 | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` (USDC) |
| Pool token1 | `0xb2712300ae339ef73557A8b79EA3BB127270Be6a` (DLBLV) |
| Pool reserves | USDC `499951` / bond `100010000000` |
| Operator wallet | `0x3e53028cf69949f3B961ce786Baf2D4D75166562` |
| Operator after swap | ETH `0.002199781847371288`, USDC `0.431620`, bond `90` |
| Pool creation tx | `0x56ce27b5fa1023427e613016b15c09a0ac5f2550304e6ae0d008d05a1610baba` |
| Mint tx | `0x4848cf9c079cdf5805afe6c3895b25438ef9b470b0d3cad4ca7c8927063fff14` |
| Swap tx | `0xf4671e77eeda35d00f7b3deeaa3d99e81aac91c40b979b83df6b20c8eebf3c89` |

## Regression checks

- `npm run typecheck` ✅
- `npm test` ✅ 45 passed, 7 test files

## Recording paths

- Partial recording covering dApp load, bond token creation, mint, and pool creation: `/home/ubuntu/screencasts/rec-38b01e44-7262-4e5d-b55b-31d109f808de/rec-38b01e44-7262-4e5d-b55b-31d109f808de-edited.mp4`
- Earlier recording covering the initial gas-failure, a live swap against the pre-existing pool, and the Bond Tokens tab UI: `/home/ubuntu/screencasts/rec-9b4678c9-fdd0-4bf9-ad44-2cb894c4218d/rec-9b4678c9-fdd0-4bf9-ad44-2cb894c4218d-edited.mp4`

The final swap was executed after the lead refilled gas and is captured in the Blockscout screenshots above.

## Suggested PR comment for PR #234

```markdown
Live DeFi dApp bond-token factory, DEX pool, and swap end-to-end verified on Sepolia ✅

**Tested:** `https://dlbtrust-app.fly.dev/dapp` with `DAPP_SHADOW=false`.

**Passed:**
- Bond-token factory created a new ERC-20 `DLBLV1785531547580` at `0xb2712300ae339ef73557A8b79EA3BB127270Be6a`.
- Minted `100,000` tokens to the operator wallet `0x3e530...6562`.
- Created and seeded a new BondDex pool at `0x4769...B24f` with `0.5 USDC` + `100,000` bond tokens (`tx 0x56ce...baba`).
- Final live bond → USDC swap succeeded (`tx 0xf467...3c89`), swapping `10` bond tokens for `0.000049 USDC` with gasUsed `83,361`.
- All transactions are confirmed and visible on Sepolia Blockscout.
- `npm test` passed 45/45 and `npm run typecheck` passed.

**Notes:**
- First pool-creation attempt reverted because the requested `1.0 USDC` seed exceeded the operator wallet's USDC balance; retry with `0.5 USDC` succeeded.
- A transient `fees is not defined` bug in `DexSwapEngine` was fixed in `65255ca` (destructure `fees` from `walletClient()`).

![Token and pool](https://app.devin.ai/attachments/7284f220-44a4-49c4-af77-d519dc6df8ed/ss_b787bfe6.png)
![Pool creation](https://app.devin.ai/attachments/7e7b16f7-a52b-4e8b-9faa-ad3476ceaff8/ss_6a15bb7e.png)
![Final swap](https://app.devin.ai/attachments/7dac4654-a780-48be-877e-8fc4f9ae0ada/ss_997dc3c3.png)
```

## SKILL.md suggestions

- Updated `/home/ubuntu/repos/dlbtrust-app/.agents/skills/testing-dlbtrust-app/SKILL.md` with the live Sepolia bond-token / DEX flow, endpoints, operator wallet, and CDP faucet note.

## Suggested blueprint updates

- Add the deployed dApp URL `https://dlbtrust-app.fly.dev/dapp` and the live Sepolia test flow (factory, DEX pool, swap) to the repo blueprint.
- Document that operator wallet `0x3e53028cf69949f3B961ce786Baf2D4D75166562` needs Sepolia ETH and USDC for live pool seeding, and that CDP EVM faucet credentials (`COINBASE_CDP_KEY_NAME`, `COINBASE_CDP_PRIVATE_KEY`) are available as Fly secrets.

## Anything still needed from the user

Nothing. The full live Sepolia bond-token / DEX flow is verified and all on-chain evidence is captured.
