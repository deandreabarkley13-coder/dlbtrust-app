# Unit (Unit Finance BaaS) partner bank

`PARTNER_BANK_PROVIDER=unit` routes partner-bank origination
(`server/integrations/rails/partnerBankRails.js`) to Unit's JSON:API
(`POST /payments`, bearer auth). A settlement bank registered with
`provider: 'unit'` settles through the same `BankSettlementEngine` →
`PartnerBankRails.originate` path as `column` / `increase` / `generic`, so the
live-call `approvalRef` + `screeningRef` gates apply unchanged.

| Instruction | Unit resource | Relationships / attributes |
| --- | --- | --- |
| ACH with `counterpartyId` (or settlement bank `endpointId`) | `achPayment` | `account` → `depositAccount`, `counterparty` → `counterparty` |
| ACH with routing + account only | `achPayment` | `account`; inline `attributes.counterparty {name, routingNumber, accountNumber, accountType}` |
| Wire | `wirePayment` | `account`; inline `attributes.counterparty` (Unit wires do not take a counterparty id) |
| `receivingAccountId` (trust's own Unit account; settlement bank `metadata.receivingAccountId`) | `bookPayment` | `account`, `counterpartyAccount` → `depositAccount` |

Response: `data.id` → `providerReference`, `data.attributes.status` →
`providerStatus` (`Rejected` / `Canceled` / `Returned` throw),
`attributes.imadOmad.imad` / `traceNumber` → `fedReference` /
`confirmationNumber`. The instruction `reference` is sent as
`attributes.idempotencyKey`.

## 1. Seed the token

Create an org API token in the Unit dashboard (scope `payments-write`; add
`counterparties-write` if counterparties are created via the API).

```bash
gcloud secrets create UNIT_API_TOKEN --replication-policy=automatic   # first time only
printf '%s' "$UNIT_TOKEN" | gcloud secrets versions add UNIT_API_TOKEN --data-file=-
```

## 2. Terraform

In `infra/gcp/terraform.tfvars` (see `terraform.tfvars.example`):

- add `"UNIT_API_TOKEN"` to `secret_names` (the `cloudrun.tf` precondition
  fails the plan when `PARTNER_BANK_PROVIDER=unit` without it);
- add to `runtime_environment` (it replaces the `variables.tf` default map, so
  carry the default entries over):

```hcl
PARTNER_BANK_PROVIDER      = "unit"
PARTNER_BANK_BASE_URL      = "https://api.unit.co"   # live; sandbox https://api.s.unit.sh (provider default)
PARTNER_BANK_ACCOUNT_ID    = "<unit-deposit-account-id>"
PARTNER_BANK_ACCOUNT_LABEL = "DLB Trust Unit Operating"
```

`PARTNER_BANK_API_KEY` / `PARTNER_BANK_ACCOUNT_ID` win when set;
`UNIT_API_TOKEN` / `UNIT_ACCOUNT_ID` are the fallbacks for `unit`.

```bash
cd infra/gcp
terraform plan && terraform apply
```

`GET /api/wire/rails` should then report `provider: "unit"`, `ready: true`.

## 3. Register the settlement bank

`server/scripts/registerUnitSettlementBank.js` upserts `bank_id=unit-operating`
(idempotent). Destination env — one of:

- `UNIT_SETTLEMENT_ROUTING_NUMBER` + `UNIT_SETTLEMENT_ACCOUNT_NUMBER`
- `UNIT_SETTLEMENT_COUNTERPARTY_ID` (pre-created Unit counterparty)
- `UNIT_SETTLEMENT_RECEIVING_ACCOUNT_ID` (book payment to another trust Unit account)

Optional: `UNIT_SETTLEMENT_BANK_ID`, `UNIT_SETTLEMENT_NAME`,
`UNIT_SETTLEMENT_ACCOUNT_NAME`, `UNIT_SETTLEMENT_RAIL` (`ach` | `wire`).

Through the running service (payment server service token):

```bash
API_BASE="$(gcloud run services describe dlbtrust-app --region us-east1 --format='value(status.url)')" \
PAYMENT_SERVER_SERVICE_TOKEN="$(gcloud secrets versions access latest --secret=PAYMENT_SERVER_SERVICE_TOKEN)" \
IAP_ID_TOKEN="$(gcloud auth print-identity-token)" \
UNIT_SETTLEMENT_COUNTERPARTY_ID=... \
node server/scripts/registerUnitSettlementBank.js --via-api
```

The service token goes in `Authorization` / `x-payment-server-service-token`;
the IAP ID token (if IAP fronts the URL) goes in `Proxy-Authorization`. The
script prints the registered bank and
`GET /api/payment-server/v1/settlement-banks/unit-operating/readiness`.

Directly against Cloud SQL (via the Cloud SQL Auth Proxy, `DATABASE_URL` set),
omit `--via-api`. `--dry-run` prints the payload with the account number masked.

## 4. IP allowlisting

If Unit allowlists source IPs, give them the Cloud NAT egress address:

```bash
terraform -chdir=infra/gcp output -raw egress_ip
```

## Caveats

- Confirm base URLs against current Unit API docs before going live: at the
  time of writing `https://api.s.unit.sh` is the sandbox (the provider default)
  and `https://api.unit.co` is live — set `PARTNER_BANK_BASE_URL` explicitly in
  production.
- Counterparty requirements: Unit documents a `counterparty` relationship for
  ACH and inline counterparties for wires; confirm whether your Unit program
  allows inline ACH counterparties or requires pre-created counterparties
  (`POST /counterparties`, then register with `UNIT_SETTLEMENT_COUNTERPARTY_ID`).
- Unit book payments use the `counterpartyAccount` relationship (the trust's
  receiving deposit account).
