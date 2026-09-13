# Trust Mandate control plane

One place that says who the platform acts for, which system is the authority
for each kind of fact, and whether the beneficiary-support pipeline is actually
wired end to end — across Fineract (treasury core), the Postgres sub-ledger,
fixed income, the private trust company / issuer engines, thirdweb, Hyperledger
Fabric + FireFly, the Spritz treasury leg (ERP -> USDC -> policy contract ->
fiat off-ramp / bill pay), Northflank and the GCP VM.

`components.spritz` is `live` only when both `CANONICAL_FUNDING_LIVE=true` (the
ERP draw moves) and `TRUST_POLICY_LIVE=true` (the policy contract is written);
its issues are the ones `GET /api/finops/spritz/treasury/readiness` reports and
flow into the aggregate `gaps` and the `settle` stage.

The software expresses the intended operating model. Legal fiduciary, custodial,
issuer and licensing status come from the trust instrument, bank/custody
agreements and regulators, not from these settings.

## Mandate

`server/integrations/trust/trustMandate.js` is the single definition every
component reads (the analytics route, the distribution engine and the control
plane all resolve the trust name from it).

| Setting | Env | Default |
| --- | --- | --- |
| Legal name | `TRUST_LEGAL_NAME` | `DEANDREA LAVAR BARKLEY FAMILY TRUST` |
| Short name | `TRUST_NAME` | `DLB Trust` |
| Roles | — | `custodian`, `issuer` |
| Funding source | — | fixed-income income |
| Reserve kept from income | `TRUST_MANDATE_RESERVE_INCOME_PCT` | `10` |
| Corpus distributions allowed | `TRUST_MANDATE_ALLOW_CORPUS` | `false` |
| Fineract must fund every distribution | `TRUST_MANDATE_REQUIRE_CANONICAL` | `false` |
| Refuse distributions that fail the mandate | `TRUST_MANDATE_ENFORCE` | `false` (report only) |

Authorities: cash and GL = Fineract; sub-ledger = `trust_accounts`; fixed income
= `bonds` + `bond_balances`; beneficiaries = `ptc_beneficiaries`; issued assets =
`issuer_assets`; evidence = Fabric; settlement rails = thirdweb, FireFly, SIT;
deployment = GCP VM, Northflank.

## Pipeline

```
income → distributable → policy → funding → notarize → settle → confirm → book → reconcile
```

`distributable = sub-ledger booked income − reserve − distributions executed in the trailing 12 months`, floored at zero. Bond accrued interest is the same interest before booking, so it is reconciled against the booked figure (a gap if they differ) and only used as income when the sub-ledger cannot be read — never added on top. Anything distributed beyond distributable income is a corpus draw and is a gap (blocking unless `TRUST_MANDATE_ALLOW_CORPUS=true`).

The reconcile stage also compares the custodian view (`PrivateTrustCompanyEngine.getSourceOfTruth`) with the sub-ledger and bond authorities; a custodian figure that is the sum of both is reported as a double count rather than trusted.

Each stage is `ok`, `gap` or `unavailable`. An authority that cannot be read is
never assumed to agree — it is reported as `unavailable` with a high-severity gap.

## Surfaces

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/trust/mandate` | operator |
| GET | `/api/trust/control-plane` | operator — readiness + snapshot + pipeline + gaps |
| GET | `/api/trust/control-plane/readiness` | operator — config only, no DB; `?full=true` also evaluates the Spritz leg against the Spritz API |
| GET | `/api/trust/control-plane/pipeline` | operator |
| POST | `/api/trust/control-plane/evaluate` | operator — `{ amountUsd, requesterRole?, purpose? }`, side-effect free |

```
npm run trust:control-plane -- [--evaluate 500] [--role beneficiary] [--purpose medical] [--json] [--strict]
```

Read-only. `--strict` exits 2 when any high-severity gap is present or the
evaluated distribution is not allowed, so it can gate a deploy.

## Distribution guard

`DistributionRequestEngine.executeRequest` evaluates every approved request
against the mandate (policy ceiling, distributable income, canonical funding,
settlement rail) before paying and stores the decision under
`metadata.mandate`. With `TRUST_MANDATE_ENFORCE=true` a blocked request is
refused with `422 MANDATE_VIOLATION` and nothing is paid. After a successful
payout the record is digested and notarized on Fabric (shadow unless
`FABRIC_LEDGER_LIVE=true`), stored under `metadata.notarization`. A control
plane that is itself down never stops an approved payout; the failure is
recorded instead.
