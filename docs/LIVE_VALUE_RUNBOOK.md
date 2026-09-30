# Live value runbook (fiat only) — GCP `dlb-treasury-management`

How the DEANDREA LAVAR BARKLEY FAMILY TRUST moves real money through the platform,
what is live in production today, and what each remaining gate needs.

Scope decisions that govern this document:

- **Fiat only.** The blockchain / stablecoin rail (thirdweb server wallet,
  TrustDistributionPolicy, BondDex / DLBUSD, Spritz off-ramp, Smart Router
  stablecoin and canonical rails) was retired by the trustee on 2026-09-27. Nothing in
  this runbook broadcasts an on-chain transaction; `docs/TRUST_TOKEN_RAIL.md`,
  `docs/USDC_TREASURY_SETUP.md` and the `THIRDWEB_*` / `STABLECOIN_*` / `DAPP_*`
  variables are historical and must not be re-enabled.
- **Income support only.** The trust agreement does not permit the sale of corpus or
  bonds. Value that enters the platform is coupon / interest income received into the
  trust's deposit account; the bond and fixed-income engines schedule and classify that
  income, they do not create it.
- **Ledgers do not hold dollars.** Fineract, the trust cash ledger, OpenACH, Payment
  Hub EE and the Private Electronic Payment Network record, route and originate.
  Real value exists only in a funded deposit account, and only a bank acknowledgement
  or a signed processor webhook proves settlement.

```
Betterment Trust Checking (nbkc)              read: SimpleFIN aggregator → DataBridge → Fineract GL
   │  ACH debit (Stripe us_bank_account mandate)   TreasuryFundingBankEngine.pull()      TREASURY_BANK_ENABLED
   ▼
Stripe balance  (CA-STRIPE-BALANCE)           signed webhook payment_intent.succeeded → treasury ledger + GL
   │  maker submit → checker approve (approvalRef + screeningRef)
   ▼
Private Electronic Payment Network            PRIVATE_PAYMENT_NETWORK_LIVE
   ├─ funding source Fineract core-banking savings account of record             CANONICAL_FUNDING_LIVE + CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID
   │                   (cash_accounts.linked_fineract_account_id) — balance / debit-block check, withdrawal before dispatch, redeposit on return
   ├─ book_transfer  trust ledger ↔ trust ledger (CashEngine, mirrored in Fineract)  no bank involved
   ├─ payout         PaymentGatewayServerEngine → PaymentProcessorServerEngine     PAYMENT_GATEWAY_LIVE + PAYMENT_PROCESSOR_LIVE
   │                   → Stripe payout to a registered external bank (Lili ****)      LILI_ORIGINATOR=stripe_payout
   │                   → direct deposit to a beneficiary payout instrument
   └─ mft_as2        NACHA file → MFT Gateway AS2 → ODFI                             shadow: no ODFI AS2 partner exists
```

## 1. Where things run

| Component | GCP resource | Notes |
| --- | --- | --- |
| API / dashboards | Cloud Run `dlbtrust-app` (us-east1) | env in `infra/gcp/variables.tf` `runtime_environment`, overridden by the git-ignored `terraform.tfvars`; secrets in Secret Manager (`infra/gcp/secrets.tf`), runtime SA `dlbtrust-app-runtime@…` |
| Database | Cloud SQL Postgres `dlbtrust` | aggregator, ledger, OS engine tables |
| Core banking & treasury (Fineract) | Cloud Run `dlbtrust-fineract` (+ Mifos X UI) | trust account of record (savings, client "DeAndrea Lavar Barkley Irrevocable Trust") = PPN funding source; GL migrated: 2,080 journal entries, 57 GL accounts |
| ACH file generation | Cloud Run `openach` + job `dlbtrust-openach-nightly` | ODFI branch uses the `Manual` plugin → files land in `gs://dlb-treasury-management-openach-ach-files/export/` |
| Payment Hub EE | Cloud Run `dlbtrust-phee` (internal ingress) | `PAYMENT_HUB_MODE=phee`; ACH connector needs a verified external ODFI endpoint |
| Schedulers | Cloud Scheduler → Cloud Run | aggregator pull every 15 min, OpenACH nightly, treasury sweeps |

The live truth for every flag is `GET /api/os/readiness` (`x-admin-token`), not the
defaults in `variables.tf`. See `docs/GCP_MIGRATION.md` for the deploy procedure.

## 2. Bank accounts of record

### 2a. Betterment Trust Checking — the funded account

- **Read (live):** Banking Aggregator connection
  `CONN-BETTERMENT-TRUST-CHECKING-SIMPLEFIN` (connector `simplefin`, secret
  `SIMPLEFIN_ACCESS_URL`, handshake `verified`, capabilities `pull:true push:false`).
  `DataBridge.classifyAggregatorTxn` posts every transaction to Fineract:
  coupon credits → DR 1020 / CR 4100 Coupon Income; interest → CR 4000; other credits →
  CR 3000 Trust Corpus; fees → DR 5000; distributions → DR 2000; other debits → DR 5300.
  The Alderfi-compatible MCP surface (`POST /api/aggregator/mcp`) is read-only.
- **Write:** Betterment publishes no ACH-origination API and no NACHA / SFTP / AS2 file
  intake. `server/integrations/ach/treasuryOdfiBank.js` (`ACH_ODFI_BANK=betterment`)
  stamps the trust's routing/account onto originated files but `status()` fails closed
  with "no ready file-delivery channel" because there is nowhere to deliver them.
  **Do not treat Betterment as an executing ODFI.**
- **The only bidirectional path** is `server/integrations/payments/treasuryFundingBankEngine.js`
  (§4). Betterment is saved in Stripe as a `us_bank_account` PaymentMethod under an ACH
  debit mandate; the platform pulls funds from Betterment into the Stripe balance and
  pays out from there. `TREASURY_BANK_ENABLED=true` in `infra/gcp/variables.tf` since
  2026-09-30 (§8); the engine still fails closed until the mandate is linked and
  verified, and nothing is pulled without the operator steps in §4.
- BILL.com is separately linked to the same account (`systemSettings.js` partner
  `bill-cash`, `server/integrations/bill/billClient.js`); BILL debits appear in the feed
  and post to 5300 Operating Expense.

### 2b. Stripe — the disbursing balance

- Live account. Intake enabled: `STRIPE_INTAKE_ENABLED=true`,
  `STRIPE_INTAKE_PAYMENT_METHODS=card,us_bank_account`. Settled PaymentIntents are
  posted to `CA-STRIPE-BALANCE` by the signed webhook
  (`POST /api/payment-server/v1/stripe/webhook`, `STRIPE_WEBHOOK_SECRET`).
- Payout destination: the Lili business account is registered as the Stripe external
  bank account (`STRIPE_PAYOUT_EXTERNAL_ACCOUNT_ID`, `LILI_ORIGINATOR=stripe_payout`,
  `LILI_STRIPE_PAYOUT_METHOD=standard`).
- No Stripe Treasury financial account exists; Treasury OutboundPayments are not a rail.

### 2c. Lili (Sunrise Banks N.A.)

- Receives Stripe payouts. Lili's MCP OAuth cannot complete for this account (Lili's
  login returns no MCP session token → `error=server_error`); enabling it is a Lili
  support request. Until then `POST /api/finops/lili/direct-deposits/reconcile` cannot
  run, and transmitted-but-unconfirmed deposits are closed out with
  `POST /api/finops/lili/direct-deposits/:id/return` and an audit reason — never marked
  reconciled without bank data.

## 3. Readiness (nothing moves)

```sh
BASE=https://dlbtrust-app-514695212719.us-east1.run.app
H="x-admin-token: $ADMIN_SECRET_TOKEN"
curl -s -H "$H" $BASE/api/os/readiness | jq '.ready, .engines[] | select(.ready==false) | {engine,blockers}'
curl -s -H "$H" $BASE/api/os/readiness/aggregator
curl -s -H "$H" $BASE/api/os/private-payment-network/readiness
curl -s -H "$H" $BASE/api/os/payment-processor/readiness
curl -s -H "Authorization: Bearer $PAYMENT_SERVER_SERVICE_TOKEN" $BASE/api/payment-server/v1/treasury-bank
curl -s -H "Authorization: Bearer $PAYMENT_SERVER_SERVICE_TOKEN" $BASE/api/payment-server/v1/stripe-intakes/readiness
```

`overall ready: true` means every engine is wired and its configuration is coherent. It
does **not** mean money has moved: the liquidity reserve
(`MOV-1790548206543-IL2GNN`, CA-OPERATING → CA-RESERVE, $985,246.28) is a ledger sweep
with no bank funds behind it.

How many real dollars back the ledgers is reported by the unified value pipeline's
`spendable` stage:

```sh
curl -s -X POST -H "$H" -H 'Content-Type: application/json' -d '{"action":"pipeline"}' \
  $BASE/api/os/canonical-money/process | jq '.data.result.spendable.value | {summary, gaps}'
```

`summary.realSpendableCents` is Reserve OS's externally **attested** reserve
(`ReserveEngine.coverage()`), never a ledger balance. Alongside it: `ledgerCashCents`
and `unbackedCents` (ledger cash with no attestation behind it), `stripeBalanceCents`
(`CA-STRIPE-BALANCE`), `payerSourceSpendableCents` (`PayerOsEngine.readiness()` funding
source net of in-flight wires/ACH) and `fundingRailReady` (`TreasuryFundingBankEngine.status()`).
Each source that is missing or fails is listed in `gaps` instead of failing the pipeline.

Locally: `npm run lint && npm run typecheck && npx vitest run tests/aggregatorConnector.test.ts tests/engineWiringReadiness.test.ts tests/liliDirectDeposit.test.ts tests/unifiedPipelineSpendable.test.ts`.

## 4. Funding the platform from Betterment (Stripe ACH debit)

Gates (all in `infra/gcp/variables.tf` / Secret Manager, applied with Terraform or
`gcloud run services update`):

| Variable / secret | Required value | Why |
| --- | --- | --- |
| `TREASURY_BANK_ENABLED` | `true` | `TreasuryFundingBankEngine` refuses `link/verify/pull` otherwise |
| `TREASURY_BANK_ID` / `TREASURY_BANK_NAME` | `betterment` / `Betterment Checking` | account identity on ledger postings |
| `TREASURY_BANK_ACCOUNT_HOLDER` | `DEANDREA LAVAR BARKLEY TRUST COMPANY` | mandate holder name |
| `TREASURY_BANK_REGISTER_SETTLEMENT` | `true` | also registers Betterment as a payout destination |
| `BETTERMENT_ROUTING_NUMBER`, `BETTERMENT_ACCOUNT_NUMBER` | Secret Manager versions | never in env or docs |
| `STRIPE_PAYMENTS_SECRET_KEY` | live-mode key | creates the PaymentMethod, mandate and PaymentIntents |
| `STRIPE_WEBHOOK_SECRET` | live endpoint secret | funds are recognised only from the signed webhook |

Procedure (service token `Authorization: Bearer $PAYMENT_SERVER_SERVICE_TOKEN`):

1. `POST /api/payment-server/v1/treasury-bank/link` — Stripe creates the
   `us_bank_account` PaymentMethod and ACH mandate. Response says whether instant
   verification succeeded or micro-deposits were sent (1–2 business days; they appear in
   the SimpleFIN feed and post to the GL automatically).
2. `POST /api/payment-server/v1/treasury-bank/verify { amounts | descriptorCode }` when
   micro-deposits were used. `GET /treasury-bank` must then show `verified: true`.
3. `POST /api/payment-server/v1/treasury-bank/pull { amountCents, reference, purpose,
   description }` (`purpose` defaults to `trust_income`) — originates a
   real ACH debit of Betterment. The intake is `processing` until Stripe's
   `payment_intent.succeeded` webhook arrives (~4 business days); only then is
   `CA-STRIPE-BALANCE` credited and Fineract posted (DR cash / CR 3000 or 4100 per
   classification). A `payment_failed` webhook (NSF, R-codes) closes the intake with no
   posting.
4. `GET /api/payment-server/v1/stripe-intakes/:id` to follow it.

Nothing in this section is executed automatically; every pull is an operator action
subject to the amount limits in `TREASURY_BANK_*` and the maker/checker record.

## 5. Distributing income (Private Electronic Payment Network)

Gates:

| Variable | Value | Effect |
| --- | --- | --- |
| `PRIVATE_PAYMENT_NETWORK_LIVE` | `true` | otherwise approvals are recorded in shadow and no ledger posting or provider call happens |
| `PAYMENT_GATEWAY_LIVE`, `PAYMENT_PROCESSOR_LIVE` | `true` | payouts dispatch through the gateway and processor engines |
| `ENTERPRISE_NETWORK_LIVE` | `true` | participant registry / exposure limits are enforced (it never moves money itself) |
| `PRIVATE_PAYMENT_NETWORK_REQUIRE_APPROVAL_REF`, `..._REQUIRE_SCREENING_REF`, `..._REQUIRE_PARTICIPANT` | `true` | **must never be relaxed in a live plan** |
| `PAYMENT_PROCESSOR_DEFAULT` | `lili` | Stripe payout to the registered Lili external account |
| `PAYMENT_GATEWAY_WEBHOOK_SECRET`, `PRIVATE_PAYMENT_NETWORK_WEBHOOK_SECRET`, `PAYMENT_DATA_ENCRYPTION_KEY` | Secret Manager | webhook HMAC + instrument encryption |
| `PRIVATE_PAYMENT_NETWORK_MFT_LIVE` | `false` | keep shadow until an ODFI AS2 partner exists (§6) |
| `CANONICAL_FUNDING_LIVE`, `CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID` | `true`, Fineract savings account id | Fineract (core banking & treasury, `dlbtrust-fineract`) is the funding source of record: a payout is admitted only if the Fineract account linked to the source ledger account (`POST /api/cash/accounts/:id/link-fineract`) is active, not debit-blocked and covers the amount; it is withdrawn before the processor is called and redeposited if the processor rejects or returns it. `false` → every external processor reports shadow |
| `FINERACT_URL`, `FINERACT_USERNAME`, `FINERACT_PASSWORD`, `FINERACT_TENANT_ID` | Secret Manager | Fineract API (must be the Cloud Run service URL, not localhost) |

Procedure (`POST /api/os/private-payment-network/process`, `x-admin-token`):

1. Maker: `{ action: 'submit', type: 'book_transfer' | 'payout', sourceAccountId,
   destinationAccountId | participantId + methodId, amountCents, memo, makerId }`.
   Purpose drives the GL: `distribution` → DR 2000 Distributions Payable / CR 1000;
   `operating_expense` → DR 5300 / CR 1000.
2. Compliance screening produces `screeningRef`; the maker/checker record produces
   `approvalRef` (`PAYMENT_APPROVAL_THRESHOLD=2`).
3. Checker (distinct from maker): `{ action: 'approve', transactionId, checkerId,
   approvalRef, screeningRef }`. A book transfer settles on the trust ledger
   immediately; a payout is `cleared` and dispatched via the gateway/processor.
4. Settlement: processor webhook (`POST /api/os/private-payment-network/webhook`,
   HMAC-SHA256) or `{ action: 'reconcile', transactionId, processorTxId, status }` moves
   it to `settled` or `returned`; only `settled` posts the GL.
5. `{ action: 'pipeline' }` lists open transactions and exposure per participant.

A Fineract withdrawal is a core-banking movement, not external settlement: real value
leaves only when the source ledger account is backed by actual funds in the
Stripe balance (§4 or card / ACH intakes) and the processor acknowledges. Approving a payout against an unfunded
ledger balance produces the same result as the three 2026-09 Lili test deposits:
transmitted, never confirmed, closed out as `returned`.

## 6. Rails that remain shadow, and what closes them

| Rail | State | Closes with |
| --- | --- | --- |
| `mft_as2` NACHA file drop (PPN / OpenACH `OpenAchFileRelay`) | shadow; files accumulate in the OpenACH export bucket | an ODFI or sponsor bank that accepts AS2/SFTP intake for the trust: set `MFTGATEWAY_PARTNER_AS2_ID` (or `ACH_SFTP_URL` + creds), then `PRIVATE_PAYMENT_NETWORK_MFT_LIVE=true` |
| Payment Hub EE ACH connector | health ok, origination queued | System Settings production partner (`bank_endpoint`, auth, webhook secret) pointing at a real ODFI API |
| Lili reconciliation via MCP | blocked | Lili enables MCP for the trust's business login, then `POST /api/finops/lili/mcp/oauth/start` |
| Betterment origination by file/API | not possible | n/a — use §4 |

## 7. Operating rules

- Never print secret values; log lengths or last-4 only. Secrets live in Secret Manager
  and are mounted by `infra/gcp/cloudrun.tf`.
- Every live payout needs a distinct maker and checker, an `approvalRef` and a
  `screeningRef`. Shadow mode calls no provider and posts no ledger entry.
- Do not test a rail with real value without the trustee's explicit source,
  destination, amount and purpose.
- When this document and `GET /api/os/readiness` disagree, readiness wins; update this
  document in the same PR that changes a flag.

## 8. Flag change log

### 2026-09-30 — fiat funding and payout gates enabled (`infra/gcp/variables.tf`)

| Variable | Was | Now |
| --- | --- | --- |
| `TREASURY_BANK_ENABLED` | `false` | `true` |
| `PAYMENT_PROCESSOR_LIVE` | `false` | `true` |
| `PAYMENT_GATEWAY_LIVE` | `false` | `true` |
| `ENTERPRISE_NETWORK_LIVE` | `false` | `true` |
| `PRIVATE_PAYMENT_NETWORK_LIVE` | `false` | `true` |
| `CANONICAL_FUNDING_LIVE` | `false` | `true` |

Unchanged and confirmed: `TREASURY_BANK_ID=betterment`, `TREASURY_BANK_NAME="Betterment Checking"`,
`TREASURY_BANK_ACCOUNT_HOLDER="DEANDREA LAVAR BARKLEY TRUST COMPANY"`,
`TREASURY_BANK_REGISTER_SETTLEMENT=true`, `PAYMENT_PROCESSOR_DEFAULT=lili`, every
`PRIVATE_PAYMENT_NETWORK_REQUIRE_*` / `*_REQUIRE_APPROVAL_REF` / `*_REQUIRE_SCREENING_REF`
flag `true`, `PRIVATE_PAYMENT_NETWORK_MFT_LIVE=false`, and every `THIRDWEB_*` /
`STABLECOIN_*` / `SPRITZ_*` / `TRUST_POLICY_*` flag off.

- `CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID` is a per-deployment value set in the git-ignored
  `infra/gcp/terraform.tfvars` (the Fineract savings account of record); left empty,
  each source ledger account's linked Fineract account is used and an unlinked
  account blocks the payout.
- `infra/gcp/secrets.tf` now declares the Secret Manager containers each enabled rail
  needs (`STRIPE_SECRET_KEY`, `STRIPE_PAYMENTS_SECRET_KEY`, `PAYMENT_DATA_ENCRYPTION_KEY`,
  `PAYMENT_GATEWAY_WEBHOOK_SECRET`, `ENTERPRISE_NETWORK_WEBHOOK_SECRET`,
  `PRIVATE_PAYMENT_NETWORK_WEBHOOK_SECRET`, `FINERACT_URL` / `FINERACT_USERNAME` /
  `FINERACT_PASSWORD`, plus the always-declared `STRIPE_WEBHOOK_SECRET`,
  `BETTERMENT_ROUTING_NUMBER`, `BETTERMENT_ACCOUNT_NUMBER`). Values are added out of
  band with `gcloud secrets versions add`, never in Terraform.
- The Trust Administration workflow's `funding` stage reports
  `TreasuryFundingBankEngine.status()` whenever `TREASURY_BANK_ENABLED=true` (the ODFI
  otherwise).
- This makes the rail **capable**; it moves no money. Real dollars reach
  `CA-STRIPE-BALANCE` only after the trustee runs §4 (link, verify micro-deposits,
  explicit pull) and the signed `payment_intent.succeeded` webhook posts it. Until
  then the pipeline's `spendable.summary.realSpendableCents` stays at the attested
  reserve and `gaps` lists the unverified treasury bank.
