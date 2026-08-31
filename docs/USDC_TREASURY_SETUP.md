# Funding the USDC distributor

What it takes to buy real USDC and land it in the account Payer OS pays out of,
in the order it has to happen. Steps 1–3 are account opening at a licensed
venue and cannot be done by the software; steps 4 onward are.

## 1. Circle Mint business account

Circle Mint is the regulated USD↔USDC leg. Apply at
<https://www.circle.com/circle-mint>. It is a business onboarding — legal entity
details, ownership, and the trust's bank account — and approval is not instant.
Nothing below works until the account exists and is approved.

Once approved, in the Circle console:

- create an API key → `CIRCLE_MINT_API_KEY`
- link the trust's bank account for wires, and take its id →
  `CIRCLE_MINT_WIRE_BANK_ACCOUNT_ID`

## 2. Mainnet distributor

Generated locally; the secret never leaves your instance.

```
node -e "const {Keypair}=require('@stellar/stellar-sdk');const k=Keypair.random();console.log(k.publicKey());console.log(k.secret())"
```

The account needs ~2 XLM before it can hold anything (1 XLM base reserve, 0.5
per trustline, plus fees), and a USDC trustline to Circle's mainnet issuer
`GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`.

## 3. Recipients

Every payee opens their own USDC trustline on their own account. Nobody else
can do it for them, and a payment to an account without one fails on
submission (`op_no_trust`).

## 4. Configuration

```
CIRCLE_MINT_API_KEY=<from step 1>
CIRCLE_MINT_WIRE_BANK_ACCOUNT_ID=<from step 1>
STABLECOIN_TARGET_FLOOR_CENTS=<how much USDC to keep on hand, in cents>

STABLECOIN_ENABLED=true
STABLECOIN_MODE=mainnet
STABLECOIN_NETWORK=mainnet
STABLECOIN_ASSET_CODE=USDC
STABLECOIN_ISSUER_PUBLIC=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
STABLECOIN_MAINNET_AUTHORIZED=true
PAYER_OS_MAX_AMOUNT_CENTS=<per-push ceiling>
STABLECOIN_DISTRIBUTOR_PUBLIC=<step 2>
STABLECOIN_DISTRIBUTOR_SECRET=<step 2, secret store only>
PAYER_OS_WALLETS='{"db-net-mgmt":{"name":"DB NET MGMT","address":"<their mainnet address>","network":"mainnet","asset":"USDC","glAccountCode":"5300"}}'
VENDOR_PAYMENT_EXECUTION_MODE=live
```

`STABLECOIN_PURCHASE_TRANSIT_ACCOUNT` defaults to `1215` and holds dollars that
have left the bank but have not yet arrived as tokens; it must exist in the
chart of accounts.

## 5. Buying

```
node server/scripts/buyStablecoin.js status                     # position, gap, Circle balances
node server/scripts/buyStablecoin.js instructions               # where to wire the USD
node server/scripts/buyStablecoin.js initiate --amount 500 --maker trustee-one@…
node server/scripts/buyStablecoin.js approve  --id USDCBUY-… --checker trustee-two@…
node server/scripts/buyStablecoin.js wire     --id USDCBUY-… --reference <bank wire ref>
node server/scripts/buyStablecoin.js transfer --id USDCBUY-… --yes
node server/scripts/buyStablecoin.js confirm  --id USDCBUY-…
```

`wire` records that the bank sent the dollars — the trust's bank sends them,
not this system. `confirm` posts the tokens into `1210` only once the
distributor's own Horizon balance has risen by the amount; until then it
returns "not yet" rather than a journal entry.

Same lifecycle over HTTP under `/api/wealth-os/usdc-treasury`.

## 6. Paying out

```
node server/scripts/stablecoinMainnetPreflight.js
node server/scripts/sendPayerCredit.js initiate --type stablecoin_payout --payee db-net-mgmt --amount 0.34 --maker …
node server/scripts/sendPayerCredit.js approve --id PAYUSDC-… --checker …
node server/scripts/sendPayerCredit.js send    --id PAYUSDC-… --yes
node server/scripts/sendPayerCredit.js settle  --id PAYUSDC-… --reference <tx hash>
```
