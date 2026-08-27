# Northflank migration

Replaces the Fly.io deployment of `dlbtrust-app` (app `dlbtrust-app`, volume
`dlbtrust_data`, Fly Postgres `dlbtrust-db`) with a Northflank project.

## Target topology

| Fly.io | Northflank |
| --- | --- |
| app `dlbtrust-app` (Dockerfile, port 3002) | project `dlbtrust` (`us-east1`, team DLB-TRUST), combined service `dlbtrust-app` — `northflank/service-dlbtrust-app.json` |
| Postgres app `dlbtrust-db` | PostgreSQL addon `dlbtrust-db` — `northflank/addon-postgres.json` |
| volume `dlbtrust_data` mounted at `/data` | volume `dlbtrust-data` mounted at `/data` — `northflank/volume-data.json` |
| `[env]` block in `fly.toml` | `runtimeEnvironment` in the service spec |
| 130 runtime variables | secret group `dlbtrust-runtime` (`environment` scope, priority 10, unrestricted) |
| `.github/workflows/fly-deploy.yml` | `.github/workflows/northflank-deploy.yml` |

The service runs a single `deployment` instance because the `/data` volume is
`ReadWriteOnce` and holds Melio CSV exports, the executed Trustees Signature
Page and the journal/shutdown state. (`statefulSet`, the `ssd` storage class and
build-plan-sized ephemeral storage are all feature-flagged off on this account —
the specs use `deployment`, `nvme` and Northflank's default 1 GiB ephemeral
storage instead, and `nvme` has a 6 GiB minimum.)

The live service URL is `https://p01--dlbtrust-app--gcq8bn6c4zlp.code.run`.

`FINERACT_URL` pointed at the Fly-internal Fineract app
(`dlbtrust-fineract.internal`). Fineract is **not** part of this migration; the
Melio workflow does not need it. Point it at a reachable Fineract instance or
leave it unset before cutting DNS over.

## Order of operations

Prerequisites, all verified against the live account — provisioning fails
without them:

- `NORTHFLANK_API_TOKEN` (project/service/secret/volume read+write) and
  `FLY_API_TOKEN`, plus `npm i -g @northflank/cli`.
- A default payment method on the Northflank team. Without one every create call
  returns `409 Please complete your account by adding a default payment method`,
  including the free-tier-sized addon here.
- GitHub linked under Northflank → Account/team settings → Version control, with
  the app granted access to `deandreabarkley13-coder/dlbtrust-app`. A combined
  service requires `vcsData`, and `northflank list vcs` must show the link —
  this is an OAuth flow, so it cannot be done with an API token.

```bash
# 1. project, postgres addon, service, /data volume
NORTHFLANK_API_TOKEN=... scripts/northflank/provision.sh

# 2. runtime credentials (reads them out of the running Fly container —
#    Fly secrets cannot be read back through the API). --dry-run lists the
#    variable names without writing anything.
#    Values that intentionally differ from Fly are passed with --set, so a
#    re-sync does not revert them (Fly releases are currently blocked by an
#    overdue Fly invoice, so the maker trustee email only changes on Northflank).
FLY_API_TOKEN=... NORTHFLANK_API_TOKEN=... node scripts/northflank/migrate-fly-secrets.mjs \
  --set TRUST_MAKER_EMAIL=AnnRobinson1117@gmail.com

# 3. ledger database. The dump is taken through `flyctl proxy` with a local
#    pg_dump >= the Fly server major version (the Fly image only ships client
#    15 against a 17 server), then restored over the addon's external TLS
#    endpoint. --manage-external-access enables external access for the restore
#    and turns it back off afterwards.
FLY_API_TOKEN=... NORTHFLANK_API_TOKEN=... PG_BIN_DIR=/usr/lib/postgresql/17/bin \
  node scripts/northflank/migrate-postgres.mjs --manage-external-access

# 4. /data contents: Melio exports, governance documents, journals
FLY_API_TOKEN=... NORTHFLANK_API_TOKEN=... scripts/northflank/migrate-data-volume.sh
```

`DATABASE_URL` is deliberately excluded from the secret migration. Instead the
addon is linked into the `dlbtrust-runtime` secret group with its connection URI
aliased, so the app follows the addon if it is ever rotated or forked:

```bash
curl -X PATCH "https://api.northflank.com/v1/projects/dlbtrust/secrets/dlbtrust-runtime" \
  -H "Authorization: Bearer $NORTHFLANK_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"addonDependencies":[{"addonId":"dlbtrust-db","keys":[{"keyName":"POSTGRES_URI","aliases":["DATABASE_URL"]}]}]}'
```

Two restore details are easy to miss:

- The service creates its own tables at boot, so it must be scaled to zero (or
  restored before its first deploy) — otherwise the rows it seeds collide with
  the dump's primary keys. `migrate-postgres.mjs` drops and recreates `public`
  for this reason.
- The restore runs as the addon **admin** user, so ownership and schema
  privileges have to be handed to the application user afterwards, or the app
  aborts at boot with `no schema has been selected to create in` / `must be
  owner of table ...`. The script does this at the end of the restore.

Builds of a combined service can only be triggered from a commit SHA:
`northflank start service build --input '{"sha": "<sha>"}'`, which is what the
deploy workflow does.

## Melio workflow checks after cutover

The Melio path is CSV-export based (`MELIO_USE_API=false`), so it depends on the
database, `/data` and the GL configuration — all three of which move here.

1. `GET /api/health` returns ok — it reports the migrated bond/cash/trust/user
   counts, so it doubles as a database check.
2. `GET /api/vendors/payments/melio` lists the payment records migrated from Fly
   (operator auth required).
3. `MELIO_EXPORT_DIR=/data/melio-exports` exists and is writable. Fly's `/data`
   never contained an export directory, so the migration creates
   `melio-exports`, `governance`, `journal`, `backups` and `shutdown-state`
   after the volume copy.
4. `TRUST_SIGNATURE_DOCUMENT_PATH` resolves, so maker/checker approvals of a
   `vendor_bill` proposal still execute.
5. A canonical vendor bill proposal approved by maker + checker posts the accrual
   (DR `MELIO_EXPENSE_GL_ACCOUNT` / CR `MELIO_PAYABLES_GL_ACCOUNT`) and writes a
   CSV; `POST /api/vendors/payments/melio/:identifier/mark-paid` settles it.

Keep `MELIO_USE_API=false` and no email provider configured while verifying — a
live API call or a delivered mail creates real bills in the trust's Melio
account.

## Sanctions screening provider

`COMPLIANCE_PROVIDER=local` can never authorize a production payment — the
readiness check treats an operator-maintained name list as unsafe in
`NODE_ENV=production`, so maker/checker approval of a vendor bill fails closed on
`Payment compliance is not ready`. Production must run a real list provider:
`ofac` (US Treasury SDN/consolidated files) or `opensanctions` (the
[OpenSanctions](https://www.opensanctions.org/datasets/sanctions/) consolidated
dataset, which includes OFAC plus EU/UN/UK and other regimes).

The OpenSanctions engine streams `targets.simple.csv` from
`data.opensanctions.org` into `compliance_sanctions_lists` /
`compliance_sanctions_entries` (primary names and aliases as separate list keys)
and screens names in PostgreSQL, since the dataset holds ~170k screenable names —
far more than the process should cache. Configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMPLIANCE_PROVIDER` | `local` | Set to `opensanctions` to screen against the dataset |
| `COMPLIANCE_OPENSANCTIONS_DATASET` | `sanctions` | Any OpenSanctions dataset publishing `targets.simple.csv` |
| `COMPLIANCE_OPENSANCTIONS_MAX_AGE_HOURS` | `48` | Readiness fails when the ingest is older |
| `COMPLIANCE_OPENSANCTIONS_MIN_TARGETS` | `5000` | Guards against a truncated download |
| `COMPLIANCE_OPENSANCTIONS_AUTO_REFRESH` | enabled | Set `false` to disable the startup/interval refresh |
| `COMPLIANCE_OPENSANCTIONS_REFRESH_INTERVAL_HOURS` | `12` | Background refresh cadence |
| `COMPLIANCE_OPENSANCTIONS_API_KEY` | unset | Only needed for licensed/API-hosted datasets |

Refresh out of band with `npm run compliance:refresh-opensanctions` or
`POST /api/finops/compliance/opensanctions/refresh` (operator auth), and check
`GET /api/finops/compliance/readiness`.

Two limitations to keep in mind: names are matched after ASCII normalization, so
non-Latin-script entries are not transliterated (same as the OFAC engine); and
the bulk data is published under CC-BY-NC 4.0, so commercial production use of
OpenSanctions data needs a license from OpenSanctions — `ofac` remains the
license-free option.

## Cutover

The Fly app keeps running until the Northflank service is verified. Once it is:

1. Disable `.github/workflows/fly-deploy.yml` (delete it, or leave it on
   `workflow_dispatch` only) so pushes to `main` no longer deploy to Fly.
2. Move the custom domain / bookmark to the Northflank service URL.
3. Scale the Fly app to zero (`fly scale count 0 -a dlbtrust-app`) rather than
   destroying it, so the Fly volume remains available as a rollback for a while.
