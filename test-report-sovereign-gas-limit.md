# Test Report — Sovereign Trust live gas-limit deploy (PR #238)

**Branch:** `devin/sovereign-gas-limit`  
**Deployed app:** `https://dlbtrust-app.fly.dev/dapp`  
**Admin token:** `dlb-admin-2026-trust`  
**Operator wallet:** `0x3e53028cf69949f3B961ce786Baf2D4D75166562`  
**Network:** mainnet (`DAPP_CHAIN_ID=1`)

---

## Summary

The branch was successfully deployed to Fly and the Sovereign Trust Token (`SIT`) and `SovereignTrustForwarder` were deployed on Ethereum mainnet. The new gas limits (`gas: 2,500,000` for the forwarder, `gas: 5,000,000` for the 15 KB token) were sufficient. After configuring the deployed contract addresses as Fly secrets, readiness passed, and a live `$0.01` SIT mint to `0x8616…FA16` succeeded and was confirmed on-chain.

`npm run typecheck` and `npm test` (45/45) passed.

---

## Test assertions

- **✅ Fly deploy succeeded.** Local build and push completed; machine updated and started.
- **✅ `POST /api/dapp/sovereign-trust/deploy` returned live mainnet addresses.**
  - Token: `0xa2b3da97072881acf760fa1315a896de0cf34b30`
  - Forwarder: `0xfd7090e72ca4d1ccdef92573cbd7254525385969`
- **✅ On-chain deploy tx receipts confirmed.**
  - Forwarder deploy: `0x52ea6289c90c573169cf7ccc6164dff3c637f7b47a0ffd999928b17de2c897e9` — gasUsed `950,594`, status `success`.
  - Token deploy: `0xca754d578dee6dc57ca32655c3440c230108d991be49fee992b24ffb14cb009d` — gasUsed `3,312,962`, status `success`.
  - `setTrustedForwarder`: `0xf5a5c3f2e704b0b6d567c629c0787c234fcc8ae7806aeec1b0ee08e8b79660a0` — status `success`.
- **✅ `eth_getCode` for both token and forwarder returned non-empty bytecode.**
- **✅ `GET /api/dapp/sovereign-trust/readiness` showed `mode: live`, `ready: true`, no issues** after setting `SOVEREIGN_TOKEN_ADDRESS` and `SOVEREIGN_FORWARDER_ADDRESS` Fly secrets.
- **✅ Optional live mint succeeded.**
  - Whitelisted destination `0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16` (tx `0xcb4d51369bbc354b7990cf3af4b4231cd2568107a5b99b49155d861f131c4ad2`).
  - Minted `0.01` SIT from `treasury:TREASURY_HOT` — order `SIT-RAMP-1785789109144-3U69S1`, tx `0x64a47d3569c6f87696a3f71f1aedce754364654bbb8a64abf25c399b08568df3`.
  - `GET /api/dapp/sovereign-trust/balance/0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16` returned `balance: "0.01"`.
  - On-chain receipt status `0x1` (success), gasUsed `79,640`.
- **✅ `npm run typecheck` passed.**
- **✅ `npm test` passed (45/45).**

---

## Issues and workarounds

### 1. `fly.toml` `[build]` did not specify the Dockerfile

`flyctl deploy` initially failed with:

```
Error: failed to fetch an image or build from source: app does not have a Dockerfile or buildpacks configured.
```

The repo has a `Dockerfile` at the root, but `fly.toml` had an empty `[build]` section. I temporarily added `dockerfile = "Dockerfile"` under `[build]`, ran the deploy, then reverted the local file to keep the checkout clean. The deployed image was built correctly.

**Suggested fix:** Add `[build]` `dockerfile = "Dockerfile"` to `fly.toml` in this branch.

### 2. Readiness requires env addresses after deploy

Immediately after `POST /sovereign-trust/deploy` succeeded, `/sovereign-trust/readiness` still reported:

```json
{
  "ready": false,
  "issues": [
    "SOVEREIGN_TOKEN_ADDRESS not set or shadow",
    "SOVEREIGN_FORWARDER_ADDRESS not set or shadow"
  ]
}
```

`SovereignTrustEngine.readiness()` checks `cfg.tokenAddress` / `cfg.forwarderAddress` from env even though `deployContracts()` persists them to `sovereign_tokens`. I set the deployed addresses as Fly secrets and the app restarted. Readiness then returned `ready: true` with no issues.

**Suggested fix:** Make `readiness()` clear these issues when a non-shadow token/forwarder already exists in the database.

### 3. First mint failed because `SOVEREIGN_RESERVE` treasury account did not exist

`POST /sovereign-trust/mint` returned:

```json
{ "success": false, "error": "Treasury account not found: SOVEREIGN_RESERVE" }
```

`TreasuryEngine.credit()` does not auto-create the reserve account in Postgres on the first call. I created the account by SSHing into the Fly machine and calling `TreasuryEngine.getOrCreateAccount('SOVEREIGN_RESERVE')`. The subsequent mint succeeded.

**Suggested fix:** Ensure `SOVEREIGN_RESERVE` is created during startup (or in `mintFromSource`) when `SOVEREIGN_TRUST_ENABLED=true`, or set `SOVEREIGN_RESERVE_ACCOUNT` to an existing account for the initial deploy.

---

## Evidence

### dApp before deploy

![Before deploy](https://app.devin.ai/attachments/270d630c-b094-48eb-911b-b19bd57b494d/ss_e8f31b03.png)

Readiness `ready: false`, `mode: live`, `token.deployed: false`.

### dApp after deploy but before env secrets were set

![After deploy before env secrets](https://app.devin.ai/attachments/8e1109c9-035e-458f-a690-30d3a25c878a/ss_6d670d4f.png)

Token/forwarder addresses returned and saved, but readiness still `ready: false` because `SOVEREIGN_TOKEN_ADDRESS` / `SOVEREIGN_FORWARDER_ADDRESS` env vars were not set.

### dApp after env secrets set and live mint

![After mint and readiness](https://app.devin.ai/attachments/88b08d53-702e-424e-a6eb-3b3d21229c74/ss_6eb4810e.png)

`ready: true`, `mode: live`, `token.deployed: true`, `totalSupply: "0.01"`, and the Ramp Orders table shows the completed `on_ramp` order `SIT-RAMP-1785789109144-3U69S1`.

### Deploy response

```json
{
  "success": true,
  "data": {
    "success": true,
    "shadow": false,
    "token": "0xa2b3da97072881acf760fa1315a896de0cf34b30",
    "forwarder": "0xfd7090e72ca4d1ccdef92573cbd7254525385969",
    "operator": "0x3e53028cf69949f3B961ce786Baf2D4D75166562"
  }
}
```

### Readiness after config

```json
{
  "success": true,
  "data": {
    "ready": true,
    "mode": "live",
    "issues": [],
    "token": {
      "address": "0xa2b3da97072881acf760fa1315a896de0cf34b30",
      "forwarder": "0xfd7090e72ca4d1ccdef92573cbd7254525385969",
      "symbol": "SIT"
    },
    "operatorAddress": "0x3e53028cf69949f3B961ce786Baf2D4D75166562",
    "network": "mainnet"
  }
}
```

### Balance

```json
{
  "success": true,
  "data": {
    "address": "0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16",
    "balance": "0.01"
  }
}
```

### Operator ETH balance

- **Before deploy:** `0.048476320860161265 ETH`
- **After deploy + whitelist + mint:** `0.0468981622459466 ETH`
- **Total spent:** `~0.001578 ETH`

### Key transaction hashes

| Action | Tx hash |
|---|---|
| Forwarder deploy | `0x52ea6289c90c573169cf7ccc6164dff3c637f7b47a0ffd999928b17de2c897e9` |
| Token deploy | `0xca754d578dee6dc57ca32655c3440c230108d991be49fee992b24ffb14cb009d` |
| setTrustedForwarder | `0xf5a5c3f2e704b0b6d567c629c0787c234fcc8ae7806aeec1b0ee08e8b79660a0` |
| Whitelist destination | `0xcb4d51369bbc354b7990cf3af4b4231cd2568107a5b99b49155d861f131c4ad2` |
| Mint 0.01 SIT | `0x64a47d3569c6f87696a3f71f1aedce754364654bbb8a64abf25c399b08568df3` |

### Typecheck / tests

```
npm run typecheck  # passed (exit 0)
npm test           # 45/45 passed (7 files)
```

---

## Conclusion

PR #238's gas-limit increase works end-to-end on mainnet: the `SovereignTrustToken` (16 KB deployed bytecode) and `SovereignTrustForwarder` deploy successfully with `gas: 5,000,000` and `gas: 2,500,000` respectively. The live mint path also works once the reserve treasury account exists and the destination is whitelisted. Three operational/config fixes are needed to make the flow work out-of-the-box on a fresh deploy:

1. Add `dockerfile = "Dockerfile"` to `fly.toml`.
2. Either update `readiness()` to trust the DB token, or set `SOVEREIGN_TOKEN_ADDRESS` / `SOVEREIGN_FORWARDER_ADDRESS` after deploy.
3. Ensure `SOVEREIGN_RESERVE` treasury account is created on first mint (or set `SOVEREIGN_RESERVE_ACCOUNT`).

**Recording:** `/home/ubuntu/screencasts/rec-sovereign-gas-limit/rec-sovereign-gas-limit-edited.mp4`
