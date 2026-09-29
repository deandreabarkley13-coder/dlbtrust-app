# Fraud & Compliance OS

`server/integrations/os/fraudComplianceOsEngine.js` is the screening authority
behind every `screeningRef` a live payment carries. It runs inside the
existing `dlbtrust-app` Cloud Run service (Cloud SQL ledger, Secret Manager,
Cloud NAT egress, API Gateway), not as a separate service.

Providers (`FRAUD_COMPLIANCE_PROVIDER`):

- `internal` (default): OFAC / OpenSanctions list (`COMPLIANCE_PROVIDER`) +
  DLB internal fraud rules over the Cloud SQL screening history. No vendor.
- `sardine`: the same, plus Sardine fraud / AML risk (Google Cloud Marketplace
  "Fraud and Compliance Operating Suite"), worst result wins.

## Workflow

```
maker   POST /api/transfer/v1/screenings                          (API Gateway, Google ID token, Idempotency-Key)
        or POST /api/payment-server/v1/fraud-compliance/screenings (service token)
        or /api/os/fraud-compliance/process {action:"screen"}     (portal, actor stamped)
          { payee:{name,routingNumber,accountNumber,country:"US"}, amountCents, rail, bankId, approvalRef?, reference? }
        -> sanctions: ComplianceEngine.screen (COMPLIANCE_PROVIDER=ofac|opensanctions)
        -> DLB rules (per payee hash):
             prior_block      payee has a blocked screening             -> blocked
             max_amount       > FRAUD_COMPLIANCE_MAX_AMOUNT_CENTS (0=off) -> blocked
             review_amount    >= FRAUD_COMPLIANCE_REVIEW_AMOUNT_CENTS ($10k) -> review
             new_payee        no prior reviewed / settled screening     -> review
             velocity_count   >= FRAUD_COMPLIANCE_VELOCITY_COUNT (5) / 24h -> review
             velocity_amount  >= FRAUD_COMPLIANCE_VELOCITY_CENTS ($50k) / 24h -> review
             bank_details     ach / wire payee without routing + account -> review
        -> Sardine (provider=sardine only): POST {SARDINE_BASE_URL}/v1/customers
        -> screening_ref FCS-…  status = worst(sanctions, rules, sardine)

checker POST /api/transfer/v1/screenings/{ref}/review {decision:"clear"|"block", notes}
        or /api/os/fraud-compliance/process {action:"review", screeningRef, decision, notes}
        distinct from the requester; must be on FRAUD_COMPLIANCE_REVIEWERS when set;
        the linked compliance_screenings row is approved/blocked too

settle  POST /api/payment-server/v1/settlements { bankId, amountCents, approvalRef, screeningRef }
        POST /api/transfer/v1/transfers {items:[{approvalRef, screeningRef, instruction}]}
          -> Enterprise ODFI -> ClearingAgentOsEngine.submit
        approvalRef + screeningRef required (unchanged); with
        FRAUD_COMPLIANCE_ENFORCE_SETTLEMENT=true the screeningRef must be live, clear,
        unexpired (FRAUD_COMPLIANCE_TTL_MINUTES), for exactly this amount (and bank /
        creditor), and is consumed (single use) before the bank or network is called.
        Vendor / payer flows (PaymentComplianceGate.verifyRecordedScreening) accept
        FCS- refs as well.
```

A screening is bound to amount, settlement bank and a SHA-256 of the payee
(name, routing, account); only the last 4 digits are stored in
`fraud_compliance_screenings`. Audit trail: `fraud_compliance_events`.
USA-only: non-US payees are refused. After a checker clears the first payment
to a payee, later payments under the thresholds screen `clear` automatically.

Shadow (`FRAUD_COMPLIANCE_LIVE` not `true`): screenings are recorded but never
satisfy a live settlement. Live: any missing prerequisite or provider failure
is a 503 and nothing is recorded as clear.

## GCP configuration (infra/gcp)

`variables.tf` `runtime_environment` default runs it live with the internal
provider: `FRAUD_COMPLIANCE_LIVE=true`, `FRAUD_COMPLIANCE_PROVIDER=internal`,
`COMPLIANCE_PROVIDER=opensanctions`, `FRAUD_COMPLIANCE_REVIEWERS` = the trust
checker. The Transfer API gateway (`transfer_api.tf`,
`transfer_api_openapi.yaml.tpl`) exposes `createScreening`, `getScreening` and
`reviewScreening`; writes need a Google ID token + Idempotency-Key.

`FRAUD_COMPLIANCE_ENFORCE_SETTLEMENT` stays `false` until every caller of
`/settlements` and the Transfer API sends FCS- refs (step 3 below); turning it
on earlier refuses live settlements that carry older `COMP-` screening ids.

Terraform plan preconditions (`cloudrun.tf`) refuse: live with a provider other
than internal / sardine, live with `COMPLIANCE_PROVIDER=local`, enforcement
without live, and with provider=sardine: missing Sardine secrets or a missing
`SARDINE_BASE_URL`.

## Readiness

`GET /api/os/readiness/fraud-compliance` and
`GET /api/payment-server/v1/fraud-compliance/readiness` are `live` only when the
sanctions list is ofac/opensanctions and ready, the provider is internal (or
sardine with credentials + explicit `SARDINE_BASE_URL`),
`FRAUD_COMPLIANCE_LIVE=true` and `FRAUD_COMPLIANCE_ENFORCE_SETTLEMENT=true`.

## Go-live (internal provider)

1. `terraform -chdir=infra/gcp apply` (the defaults above; copy them into
   `terraform.tfvars` if it overrides `runtime_environment`). Tables are created
   at boot.
2. Screen a real payee through `POST /api/transfer/v1/screenings` as the maker,
   review it as the checker, confirm readiness shows only the enforcement blocker.
3. Send the returned FCS- ref as `screeningRef` on `/settlements` and Transfer
   API items, then set `FRAUD_COMPLIANCE_ENFORCE_SETTLEMENT=true` and apply.

## Adding Sardine (optional)

1. Subscribe to Sardine "Fraud and Compliance Operating Suite" on Google Cloud
   Marketplace (project `dlb-treasury-management`) or contract directly; get
   sandbox + production client id / secret. Confirm flow names and
   business-entity fields with Sardine (the engine sends `SARDINE_FLOW_<rail>`,
   first/last name or `businessName`).
2. Seed the secrets:
   ```sh
   printf '%s' "$SARDINE_CLIENT_ID"     | gcloud secrets versions add SARDINE_CLIENT_ID --data-file=-
   printf '%s' "$SARDINE_CLIENT_SECRET" | gcloud secrets versions add SARDINE_CLIENT_SECRET --data-file=-
   ```
3. Add both to `secret_names`; set `FRAUD_COMPLIANCE_PROVIDER=sardine` and
   `SARDINE_BASE_URL=https://api.sandbox.sardine.ai` (then
   `https://api.sardine.ai`); apply. The Sardine host joins the egress allowlist
   automatically; give Sardine `terraform -chdir=infra/gcp output -raw egress_ip`
   if they IP-allowlist.

Caveat: the Sardine mapping follows Sardine's public customer API docs
(`POST /v1/customers`, `level`, `transaction.amlLevel`); confirm it during
sandbox onboarding.
