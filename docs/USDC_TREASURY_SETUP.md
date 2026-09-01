# Funding the USDC distributor

What it takes to buy real USDC and land it in the account Payer OS pays out of,
in the order it has to happen. Steps 1–3 are account opening at a licensed
venue and cannot be done by the software; steps 4 onward are.

## 0. Which funding source

Four, and they differ in who has an account where, not in what arrives. Every
one of them ends the same way: the tokens are recognised in the ledger only
once the distributor's Horizon balance actually rises.

| `--source` | What you need | What the software does |
| --- | --- | --- |
| `circle_mint` | A Circle Mint business account (KYB) | Wire instructions, then originates the Circle-to-Stellar transfer |
| `exchange` | An exchange account that withdraws USDC on Stellar | Sizes it, holds dual control, records the venue's references |
| `onramp` | A MoonPay account with Stellar enabled | Issues a signed checkout; a human pays it |
| `stellar_dex` | XLM already in the distributor | Signs the order-book swap itself |

The honest constraint: only the first three add value. `stellar_dex` exchanges
one asset the trust already owns for another, so it cannot be the first
funding — with no XLM anywhere, there is nothing to swap from.

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

`trust:stellar-mainnet` does the parts that do not need money, and names the one
that does:

```
npm run trust:stellar-mainnet -- status       # exists? XLM? trustline? balance?
npm run trust:stellar-mainnet -- trustline --yes
npm run trust:stellar-mainnet -- preflight    # every gate before a purchase or a payout
```

The system funds the account itself when it can:

```
npm run trust:stellar-mainnet -- sources          # every key the trust holds, and its mainnet XLM
npm run trust:stellar-mainnet -- fund --yes       # create/top up the distributor from one of them
```

`fund` sends from `STELLAR_FUNDING_SECRET` (override with `--from-env NAME`) —
`createAccount` if the distributor does not exist yet, a plain payment if it
does. Secrets are read from named environment variables and never taken as
arguments, because a seed on a command line lands in shell history and in every
`ps` on the box. It refuses to spend into the source account's own reserve: a
balance of 1.6 XLM against one trustline is entirely reserve and sends nothing.

What it cannot do is originate value. `sources` answers "can we fund this
ourselves?" from Horizon, and while every key reads 0 the answer is no: XLM has
to arrive from an exchange or another wallet first, to the distributor directly
or to a funding account named by `sources`.

Until the address has received XLM from somewhere else, `status` reports the
account as non-existent and no step is available: an account comes into being by
being paid, which no script here can do. `trustline` refuses unless the network
is mainnet, the issuer is Circle's, the seed signs for the configured address,
and the account holds enough XLM for the reserve.

## 3. Recipients

Every payee opens their own USDC trustline on their own account. Nobody else
can do it for them, and a payment to an account without one fails on
submission (`op_no_trust`).

### Payees who share one account (muxed addresses)

A muxed address (`M…`) is a base account plus a 64-bit subaccount id, so one
funded account can serve many payees: none of them needs a Stellar account, an
XLM reserve or a trustline of their own. It is routing, not custody — the base
account holds the money and its owner can spend it — so it fits beneficiaries
paid *through* an account the trust or a family member already controls, and not
a payee who must hold their own funds.

```
npm run trust:muxed -- create --address G… --id 7   # build the address
npm run trust:muxed -- parse  --address M…          # who actually gets paid
npm run trust:muxed -- check  --address M… | G…     # base account exists? trustline?
```

Either kind of address can be registered in `PAYER_OS_WALLETS`. Settlement
verification treats them differently on purpose: Horizon reports a muxed payment
against the base account with `to_muxed_id` alongside, and a payment to the bare
base account does **not** confirm a payout owed to a subaccount, because nothing
in it says which payee was credited.

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
have left the bank but have not yet arrived as tokens.
`STABLECOIN_XLM_ASSET_ACCOUNT` defaults to `1216` and holds the XLM an
order-book swap gives up. Both must exist in the chart of accounts:

```
psql "$DATABASE_URL" -f server/scripts/migrate-stablecoin-funding-accounts.sql
```

For the on-ramp source, additionally:

```
STABLECOIN_ONRAMP_PROVIDER=moonpay
MOONPAY_ENV=live                 # or sandbox
MOONPAY_PUBLISHABLE_KEY=pk_live_…
MOONPAY_SECRET_KEY=sk_live_…     # signs the checkout; secret store only
MOONPAY_USDC_CURRENCY_CODE=usdc_xlm
```

MoonPay enables Stellar per partner, so confirm your account can sell
`usdc_xlm` before relying on it. Their listing for it is live-only
(`supportsTestMode: false`), so `MOONPAY_ENV=sandbox` can rehearse the signing
but never a delivery, and the checkout is refused rather than issued. Before
sending anyone to pay, the checkout is checked against that listing — chain,
issuer (MoonPay sells Circle's `GA5ZSEJ…`, and anything else would be
unspendable here), address shape, and the $5 minimum. Coinbase Onramp is refused outright here: its
documented USDC networks do not include Stellar, and delivering to a different
chain would be real money this rail cannot see.

For the swap source:

```
STABLECOIN_DEX_XLM_RESERVE=3       # XLM kept back for reserves and fees
STABLECOIN_DEX_MAX_SLIPPAGE_BPS=200
```

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

The other three sources share `initiate` / `approve` / `confirm` and differ
only in the middle:

```
# exchange: buy and withdraw on Stellar at your venue, then record it
node server/scripts/buyStablecoin.js initiate   --amount 500 --maker … --source exchange
node server/scripts/buyStablecoin.js wire       --id USDCBUY-… --reference <deposit ref>
node server/scripts/buyStablecoin.js withdrawal --id USDCBUY-… --reference <withdrawal id or tx hash>

# on-ramp: the checkout is signed here, paid by a human
node server/scripts/buyStablecoin.js initiate   --amount 500 --maker … --source onramp
node server/scripts/buyStablecoin.js checkout   --id USDCBUY-…
node server/scripts/buyStablecoin.js withdrawal --id USDCBUY-… --reference <provider tx id>

# order books: no venue, no fiat, spends the distributor's own XLM
node server/scripts/buyStablecoin.js quote      --amount 500
node server/scripts/buyStablecoin.js initiate   --amount 500 --maker … --source stellar_dex
node server/scripts/buyStablecoin.js swap       --id USDCBUY-… --yes
```

`withdrawal` and `checkout` record intent, not arrival — a provider reporting
"complete" is the provider's opinion, and only `confirm` reads Horizon. A swap
is strict-receive and bounded by `sendMax`, so a thin order book fails the
transaction instead of quietly costing more, and it refuses to spend the XLM
held back for reserves and fees.

Same lifecycle over HTTP under `/api/wealth-os/usdc-treasury`.

## 6. Paying out

```
node server/scripts/stablecoinMainnetPreflight.js
node server/scripts/sendPayerCredit.js initiate --type stablecoin_payout --payee db-net-mgmt --amount 0.34 --maker …
node server/scripts/sendPayerCredit.js approve --id PAYUSDC-… --checker …
node server/scripts/sendPayerCredit.js send    --id PAYUSDC-… --yes
node server/scripts/sendPayerCredit.js settle  --id PAYUSDC-… --reference <tx hash>
```
