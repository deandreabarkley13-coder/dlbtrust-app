# Beneficiary go-live checklist (coupon-income direct deposit, fiat only)

Scope: distributing coupon / interest income received in the trust's Betterment Trust
Checking to beneficiaries by direct deposit, on GCP project `dlb-treasury-management`.
The former on-chain rail (thirdweb wallet, TrustDistributionPolicy, Spritz off-ramp)
is retired and is intentionally absent from this checklist. Companion document:
`docs/LIVE_VALUE_RUNBOOK.md`.

```
coupon / interest credit lands in Betterment Trust Checking
  → SimpleFIN aggregator pull (15 min)            DR 1020 Coupon Cash / CR 4100 Coupon Income  (DataBridge → Fineract)
trust funding account at the sponsor ODFI
  → EnterpriseOdfi creditTrustAccount → release    ACH CCD credit (direct deposit) into Betterment Trust Checking
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
| rail tests | `npx vitest run tests/aggregatorConnector.test.ts tests/engineWiringReadiness.test.ts tests/liliDirectDeposit.test.ts tests/unifiedPipelineSpendable.test.ts` |
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
| B3 | Trust can credit Betterment (ACH credit) | `POST /api/os/enterprise-odfi/process { action: 'trust-account-credit' }` → `blockers: []`; `GET /api/os/enterprise-odfi/readiness` → `trustAccountCredit.ready: true` | `BETTERMENT_ROUTING_NUMBER` / `BETTERMENT_ACCOUNT_NUMBER` and `ENTERPRISE_ODFI_FUNDING_ACCOUNT_NUMBER` secret versions, `ENTERPRISE_ODFI_FUNDING_ROUTING_NUMBER` / `_NAME`, countersigned originator profile, verified sponsor network, active Fineract account of record (runbook §4) |
| B3a | Trustee / beneficiary savings accounts exist | `GET /api/fineract/trust-accounts` → no `blockers`, one active `trustee:<id>:savings` / `beneficiary:<id>:savings` per eligible contact | `POST /api/fineract/trust-accounts/provision { dryRun: true }`, then without `dryRun` |
| B4 | Stripe webhook reaches the app | `GET /api/payment-server/v1/stripe-intakes/readiness` → webhook configured | `STRIPE_WEBHOOK_SECRET` for the Cloud Run URL `/api/payment-server/v1/stripe/webhook` |
| B5 | Payment Processor live and real-value capable | `GET /api/os/payment-processor/readiness`; `processors()` shows the chosen processor `live: true, realValue: true` | `PAYMENT_PROCESSOR_LIVE=true`, `STRIPE_SECRET_KEY`, `STRIPE_PAYMENTS_SECRET_KEY`, `PAYMENT_DATA_ENCRYPTION_KEY` |
| B6 | Payment Gateway live | `GET /api/os/payment-gateway/readiness` | `PAYMENT_GATEWAY_LIVE=true`, `PAYMENT_GATEWAY_WEBHOOK_SECRET`, `PAYMENT_GATEWAY_REQUIRE_DISTRIBUTION_REQUEST=true` |
| B7 | Enterprise network participant registered | `POST /api/os/enterprise-network/process { action: 'participants' }` lists the beneficiary with an exposure limit ≥ the distribution | `ENTERPRISE_NETWORK_LIVE=true`; `{ action: 'submit', kind: 'onboard_participant', participant }` then checker `{ action: 'approve', intentId, approvalRef, screeningRef }` |
| B8 | Beneficiary payout instrument on file | participant has a tokenized `payment_methods` row (routing/account encrypted with `PAYMENT_DATA_ENCRYPTION_KEY`) | collect via the member dashboard or `POST /api/os/payment-gateway/process { action: 'tokenize', type: 'us_bank_account', … }` |
| B9 | Private Payment Network live, gates intact | `GET /api/os/private-payment-network/readiness` → `live: true`, `requireApproval: true`, `requireScreening: true`, `requireParticipant: true` | `PRIVATE_PAYMENT_NETWORK_LIVE=true`; never set the `REQUIRE_*` flags to false |
| B10 | Distribution request approved by two trustees | distribution request `approved`, `approvalRef` issued | maker/checker flow (`PAYMENT_APPROVAL_THRESHOLD=2`) |
| B11 | Compliance screening passed | `screeningRef` issued for the beneficiary | compliance engine screening |
| B12 | Source ledger account funded by real money | `CA-STRIPE-BALANCE` ≥ amount **and** the funding intake is `succeeded` on Stripe | §C |
| B13 | Real dollars back the ledgers | `POST /api/os/canonical-money/process { action: 'pipeline' }` → `data.result.spendable.value.summary.realSpendableCents` ≥ amount, `unbackedCents: 0`, `fundingRailReady: true` (Enterprise ODFI trust-account credit), `gaps: []` | §C, then a Reserve OS attestation of the funded balance |

Flags set in `infra/gcp/variables.tf` on 2026-09-30 (runbook §8): `TREASURY_BANK_ENABLED`,
`PAYMENT_PROCESSOR_LIVE`, `PAYMENT_GATEWAY_LIVE`, `ENTERPRISE_NETWORK_LIVE`,
`PRIVATE_PAYMENT_NETWORK_LIVE` and `CANONICAL_FUNDING_LIVE` → `true`, with
`TREASURY_BANK_ID=betterment`, `PAYMENT_PROCESSOR_DEFAULT=lili` and every `REQUIRE_*`
gate still `true`. B3's config half and B5/B6/B7/B9's flag half are therefore closed on
the next deploy; B3's link/verify, B4/B5/B6 secret versions,
`CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID` (per-deployment, `terraform.tfvars`) and B12/B13
remain operator steps. Enabling the flags moves no money — only the trustee's explicit
pull in §C does.

Superseded the same day (runbook §8, second change): `TREASURY_BANK_ENABLED=false` —
Betterment is credited by the Enterprise ODFI, not debited through Stripe; B3 is the
trust-account credit gate and §C is the credit procedure. `CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID`
may stay empty once the Fineract account of record is recorded (B3a). With the debit
off, `CA-STRIPE-BALANCE` (B12) is funded only by other signed Stripe intakes.

Gates that are **not** on this rail and must stay closed: `PRIVATE_PAYMENT_NETWORK_MFT_LIVE`
(no ODFI AS2 partner), every `THIRDWEB_*` / `STABLECOIN_*` / `SPRITZ_*` / `TRUST_POLICY_*`
flag (retired rail).

## C. Credit Betterment from the trust (ACH credit, runbook §4)

1. B3 and B3a open; approval and screening references issued (B10, B11).
2. Maker: `POST /api/os/enterprise-odfi/process { action: 'credit-trust-account',
   amountCents, idempotencyKey, approvalRef, screeningRef, from: { role:
   'account-of-record' } }` (or `role: 'trustee' | 'beneficiary', partyRef: '<crm
   contact_id>'`) → `planned` batch; nothing has moved.
3. Checker (different trustee): `{ action: 'release', batchId }` → items `posted` by the
   Clearing Agent (originated to the sponsor network, Fineract debtor account withdrawn).
4. Receipt: the credit appears in the Betterment feed (B1). Until then treat the funds as
   in flight; a return comes back through `{ action: 'exception' }` and is redeposited.

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
