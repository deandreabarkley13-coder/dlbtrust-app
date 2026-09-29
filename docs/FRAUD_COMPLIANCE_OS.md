# Fraud & Compliance OS

`server/integrations/os/fraudComplianceOsEngine.js` is the screening authority
behind every `screeningRef` a live settlement carries. It runs inside the
existing `dlbtrust-app` Cloud Run service (Cloud SQL ledger, Secret Manager,
Cloud NAT egress), not as a separate service.

## Workflow

```
maker   POST /api/payment-server/v1/fraud-compliance/screenings   (service token)
        or /api/os/fraud-compliance/process {action:"screen"}     (portal, actor stamped)
          { payee:{name,routingNumber,accountNumber,country:"US"}, amountCents, rail, bankId, approvalRef?, reference? }
        -> sanctions: ComplianceEngine.screen (COMPLIANCE_PROVIDER=ofac|opensanctions)
        -> fraud/AML: Sardine POST {SARDINE_BASE_URL}/v1/customers (HTTP Basic client id/secret)
        -> screening_ref FCS-…  status = worst(sanctions, sardine level/amlLevel)
             low -> clear, medium|high -> review, very_high -> blocked

checker /api/os/fraud-compliance/process {action:"review", screeningRef, decision:"clear"|"block", notes}
        distinct from the requester; must be on FRAUD_COMPLIANCE_REVIEWERS when set;
        the linked compliance_screenings row is approved/blocked too

settle  POST /api/payment-server/v1/settlements { bankId, amountCents, approvalRef, screeningRef }
        BankSettlementEngine: approvalRef + screeningRef required (unchanged); with
        FRAUD_COMPLIANCE_ENFORCE_SETTLEMENT=true the screeningRef must be live, clear,
        unexpired (FRAUD_COMPLIANCE_TTL_MINUTES), for exactly this amount and bank,
        and is consumed (single use) before the provider is called.
```

A screening is bound to amount, settlement bank and a SHA-256 of the payee
(name, routing, account); only the last 4 digits are stored in
`fraud_compliance_screenings`. Audit trail: `fraud_compliance_events`.
USA-only: non-US payees are refused.

Shadow (`FRAUD_COMPLIANCE_LIVE` not `true`): screenings are recorded; a missing
Sardine credential or an unavailable sanctions list yields `review`, and a
shadow screening never satisfies a live settlement. Live: any missing
prerequisite or provider failure is a 503 and nothing is recorded as clear.

## Readiness

`GET /api/os/readiness/fraud-compliance` and
`GET /api/payment-server/v1/fraud-compliance/readiness` are `live` only when:
sanctions list is ofac/opensanctions and ready, `FRAUD_COMPLIANCE_PROVIDER=sardine`,
`SARDINE_CLIENT_ID` / `SARDINE_CLIENT_SECRET` set, `SARDINE_BASE_URL` set
explicitly, `FRAUD_COMPLIANCE_LIVE=true`, `FRAUD_COMPLIANCE_ENFORCE_SETTLEMENT=true`.

## Go-live

1. Subscribe to Sardine "Fraud and Compliance Operating Suite" on Google Cloud
   Marketplace (project `dlb-treasury-management`) or contract directly, and
   get sandbox + production client id / secret from Sardine. Ask Sardine for
   the flow names and business-entity customer fields they want (the engine
   sends `SARDINE_FLOW_<rail>`, individual first/last name or `businessName`).
2. Seed the secrets:
   ```sh
   printf '%s' "$SARDINE_CLIENT_ID"     | gcloud secrets versions add SARDINE_CLIENT_ID --data-file=-
   printf '%s' "$SARDINE_CLIENT_SECRET" | gcloud secrets versions add SARDINE_CLIENT_SECRET --data-file=-
   ```
3. `infra/gcp/terraform.tfvars`: add both names to `secret_names`; in
   `runtime_environment` set `SARDINE_BASE_URL=https://api.sandbox.sardine.ai`
   first, `FRAUD_COMPLIANCE_REVIEWERS`, and keep `FRAUD_COMPLIANCE_LIVE=false`.
   `terraform -chdir=infra/gcp apply`. The Sardine host joins the egress
   allowlist automatically (derived from `SARDINE_BASE_URL`); give Sardine
   `terraform -chdir=infra/gcp output -raw egress_ip` if they IP-allowlist.
4. Sandbox run: screen a test payee, review it, check `/api/os/readiness/fraud-compliance`.
5. Switch `SARDINE_BASE_URL=https://api.sardine.ai`, `FRAUD_COMPLIANCE_LIVE=true`,
   apply, screen one real payee.
6. Set `FRAUD_COMPLIANCE_ENFORCE_SETTLEMENT=true` and apply. From then on every
   live settlement (Unit, Column, Increase, Lili, …) needs a live screening.

Terraform plan preconditions (`infra/gcp/cloudrun.tf`) refuse: live without
the Sardine secrets, live without `SARDINE_BASE_URL`, live with a provider other
than sardine, live with `COMPLIANCE_PROVIDER=local`, and enforcement without live.

Caveat: the request / response mapping follows Sardine's public customer API
docs (`POST /v1/customers`, `level`, `transaction.amlLevel`); confirm the
contract and field names with Sardine during sandbox onboarding.
