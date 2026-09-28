# Beneficiary go-live checklist (coupon-income direct deposit, fiat only)

Scope: distributing coupon / interest income received in the trust's Betterment Trust
Checking to beneficiaries by direct deposit, on GCP project `dlb-treasury-management`.
The former on-chain rail (thirdweb wallet, TrustDistributionPolicy, Spritz off-ramp)
is retired and is intentionally absent from this checklist. Companion document:
`docs/LIVE_VALUE_RUNBOOK.md`.

```
coupon / interest credit lands in Betterment Trust Checking
  → SimpleFIN aggregator pull (15 min)            DR 1020 Coupon Cash / CR 4100 Coupon Income  (DataBridge → Fineract)
  → TreasuryFundingBankEngine.pull()              Stripe ACH debit of Betterment → CA-STRIPE-BALANCE on signed webhook
  → PPN submit(payout) → approve(approvalRef, screeningRef)
  → PaymentGateway → PaymentProcessor → direct deposit to beneficiary instrument
  → webhook / reconcile → settled                 DR 2000 Distributions Payable / CR 1000 Cash
```

Nothing below moves value until §D, and §D moves value only with every gate in §B open
and a distinct maker and checker.

## A. Code health

| Check | Command |
| --- | --- |
| lint | `npm run lint` |
| types | `npm run typecheck` |
| rail tests | `npx vitest run tests/aggregatorConnector.test.ts tests/engineWiringReadiness.test.ts tests/liliDirectDeposit.test.ts` |
| infra | `cd infra/gcp && terraform validate` |

## B. Gates (production Cloud Run env / Secret Manager)

Check with `GET /api/os/readiness` (`x-admin-token`). "Prod" changes are made in
`infra/gcp/terraform.tfvars` (git-ignored) or `gcloud run services update dlbtrust-app
--region us-east1 --update-env-vars …` / `--update-secrets …`, then recorded in
`infra/gcp/variables.tf` comments and this file.

| # | Gate | How to verify | Closes with |
| --- | --- | --- | --- |
| B1 | Income is being read from Betterment | `GET /api/os/readiness/aggregator` → 1 live connection, handshake `verified`, `lastPullAt` recent | `SIMPLEFIN_ACCESS_URL` secret + Cloud Scheduler aggregator job (already live) |
| B2 | Income posts to the GL as coupon / interest, not corpus | Fineract journal for the credit shows CR 4100 / 4000 | descriptor rules in `DataBridge.classifyAggregatorTxn`; add the obligor's descriptor if it lands in 3000 |
| B3 | Betterment linked to Stripe as ACH-debit source | `GET /api/payment-server/v1/treasury-bank` → `ready: true, verified: true` | `TREASURY_BANK_ENABLED=true`, live `STRIPE_PAYMENTS_SECRET_KEY`, `BETTERMENT_ROUTING_NUMBER` / `BETTERMENT_ACCOUNT_NUMBER` secret versions, `POST /treasury-bank/link` then `/verify` (micro-deposits) |
| B4 | Stripe webhook reaches the app | `GET /api/payment-server/v1/stripe-intakes/readiness` → webhook configured | `STRIPE_WEBHOOK_SECRET` for the Cloud Run URL `/api/payment-server/v1/stripe/webhook` |
| B5 | Payment Processor live and real-value capable | `GET /api/os/payment-processor/readiness`; `processors()` shows the chosen processor `live: true, realValue: true` | `PAYMENT_PROCESSOR_LIVE=true`, `STRIPE_SECRET_KEY`, `STRIPE_PAYMENTS_SECRET_KEY`, `PAYMENT_DATA_ENCRYPTION_KEY` |
| B6 | Payment Gateway live | `GET /api/os/payment-gateway/readiness` | `PAYMENT_GATEWAY_LIVE=true`, `PAYMENT_GATEWAY_WEBHOOK_SECRET`, `PAYMENT_GATEWAY_REQUIRE_DISTRIBUTION_REQUEST=true` |
| B7 | Enterprise network participant registered | `POST /api/os/enterprise-network/process { action: 'participants' }` lists the beneficiary with an exposure limit ≥ the distribution | `ENTERPRISE_NETWORK_LIVE=true`; `{ action: 'submit', kind: 'onboard_participant', participant }` then checker `{ action: 'approve', intentId, approvalRef, screeningRef }` |
| B8 | Beneficiary payout instrument on file | participant has a tokenized `payment_methods` row (routing/account encrypted with `PAYMENT_DATA_ENCRYPTION_KEY`) | collect via the member dashboard or `POST /api/os/payment-gateway/process { action: 'tokenize', type: 'us_bank_account', … }` |
| B9 | Private Payment Network live, gates intact | `GET /api/os/private-payment-network/readiness` → `live: true`, `requireApproval: true`, `requireScreening: true`, `requireParticipant: true` | `PRIVATE_PAYMENT_NETWORK_LIVE=true`; never set the `REQUIRE_*` flags to false |
| B10 | Distribution request approved by two trustees | distribution request `approved`, `approvalRef` issued | maker/checker flow (`PAYMENT_APPROVAL_THRESHOLD=2`) |
| B11 | Compliance screening passed | `screeningRef` issued for the beneficiary | compliance engine screening |
| B12 | Source ledger account funded by real money | `CA-STRIPE-BALANCE` ≥ amount **and** the funding intake is `succeeded` on Stripe | §C |

Gates that are **not** on this rail and must stay closed: `PRIVATE_PAYMENT_NETWORK_MFT_LIVE`
(no ODFI AS2 partner), every `THIRDWEB_*` / `STABLECOIN_*` / `SPRITZ_*` / `TRUST_POLICY_*`
flag (retired rail).

## C. Fund the disbursing balance (real ACH debit of Betterment)

1. Confirm the coupon credit is in Betterment and posted (B1, B2).
2. `POST /api/payment-server/v1/treasury-bank/pull { amountCents, reference:
   "<distribution request id>", purpose: "trust_income" }` (service token). Returns
   `202` with the intake id; status `processing`.
3. Wait for `payment_intent.succeeded` (~4 business days). `GET
   /api/payment-server/v1/stripe-intakes/:id` → `succeeded`, `CA-STRIPE-BALANCE`
   credited, Fineract entry present. A failure webhook (R01 NSF etc.) leaves the balance
   untouched — stop here.

## D. Distribute (the only step that moves value to a beneficiary)

1. Maker: `POST /api/os/private-payment-network/process { action: 'submit', type:
   'payout', sourceAccountId: 'CA-STRIPE-BALANCE', participantId, methodId, amountCents,
   memo: 'coupon income distribution <period>', makerId }` → `submitted`.
2. Checker (different user): `{ action: 'approve', transactionId, checkerId,
   approvalRef, screeningRef }`. With B5–B9 open the response is `mode: 'live'`,
   status `cleared`, and a processor transaction id. `mode: 'shadow'` means a gate is
   closed — nothing was sent; read `reason`.
3. Settlement: processor webhook (`POST /api/os/private-payment-network/webhook`) or
   `{ action: 'reconcile', transactionId, processorTxId, status: 'settled' }` →
   `settled`, GL DR 2000 / CR 1000. `returned` reverses nothing on the bank side and
   posts nothing; investigate before retrying.
4. Evidence to retain per distribution: transaction id, processor transaction id,
   approvalRef, screeningRef, Fineract journal id, bank/processor settlement timestamp.

## E. First-run recommendation

Run §C–§D once for a small amount (e.g. $1.00) to a trustee-controlled account before
the first beneficiary distribution, and keep the settlement evidence. Do not scale up
until the processor reports `settled` from its own webhook — "transmitted" is not
settlement (see the returned 2026-09 Lili test deposits).
