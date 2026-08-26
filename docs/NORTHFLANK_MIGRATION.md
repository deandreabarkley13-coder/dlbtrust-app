# Northflank migration

Replaces the Fly.io deployment of `dlbtrust-app` (app `dlbtrust-app`, volume
`dlbtrust_data`, Fly Postgres `dlbtrust-db`) with a Northflank project.

## Target topology

| Fly.io | Northflank |
| --- | --- |
| app `dlbtrust-app` (Dockerfile, port 3002) | project `dlbt-erp` (`us-east1`), combined service `dlbtrust-app` — `northflank/service-dlbtrust-app.json` |
| Postgres app `dlbtrust-db` | PostgreSQL addon `dlbtrust-db` — `northflank/addon-postgres.json` |
| volume `dlbtrust_data` mounted at `/data` | volume `dlbtrust-data` mounted at `/data` — `northflank/volume-data.json` |
| `[env]` block in `fly.toml` | `runtimeEnvironment` in the service spec |
| 131 `fly secrets` | secret group `dlbtrust-runtime` (`environment` scope, priority 10) |
| `.github/workflows/fly-deploy.yml` | `.github/workflows/northflank-deploy.yml` |

The service is a `statefulSet` with one instance because the `/data` volume is
`ReadWriteOnce` and holds Melio CSV exports, the executed Trustees Signature
Page and the journal/shutdown state.

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
NORTHFLANK_API_TOKEN=... scripts/northflank/provision.sh   # project dlbt-erp already exists

# 2. runtime credentials (reads them out of the running Fly container —
#    Fly secrets cannot be read back through the API). --dry-run lists the
#    variable names without writing anything.
FLY_API_TOKEN=... NORTHFLANK_API_TOKEN=... node scripts/northflank/migrate-fly-secrets.mjs

# 3. ledger database (dump runs inside the Fly machine, restore over the
#    addon's external TLS endpoint — enable external access on the addon first)
FLY_API_TOKEN=... NORTHFLANK_API_TOKEN=... node scripts/northflank/migrate-postgres.mjs

# 4. /data contents: Melio exports, governance documents, journals
FLY_API_TOKEN=... NORTHFLANK_API_TOKEN=... scripts/northflank/migrate-data-volume.sh
```

`DATABASE_URL` is deliberately excluded from the secret migration: link the
`dlbtrust-db` addon into the `dlbtrust-runtime` secret group and alias its
connection URI to `DATABASE_URL`, so the app follows the addon if it is ever
rotated or forked.

## Melio workflow checks after cutover

The Melio path is CSV-export based (`MELIO_USE_API=false`), so it depends on the
database, `/data` and the GL configuration — all three of which move here.

1. `GET /api/health` returns ok.
2. `GET /api/vendors/payments/melio` lists the payment records migrated from Fly.
3. `MELIO_EXPORT_DIR=/data/melio-exports` exists and still contains the previously
   generated spreadsheets (verifies the volume copy).
4. `TRUST_SIGNATURE_DOCUMENT_PATH` resolves, so maker/checker approvals of a
   `vendor_bill` proposal still execute.
5. A canonical vendor bill proposal approved by maker + checker posts the accrual
   (DR `MELIO_EXPENSE_GL_ACCOUNT` / CR `MELIO_PAYABLES_GL_ACCOUNT`) and writes a
   CSV; `POST /api/vendors/payments/melio/:identifier/mark-paid` settles it.

Keep `MELIO_USE_API=false` and no email provider configured while verifying — a
live API call or a delivered mail creates real bills in the trust's Melio
account.

## Cutover

The Fly app keeps running until the Northflank service is verified. Once it is:

1. Disable `.github/workflows/fly-deploy.yml` (delete it, or leave it on
   `workflow_dispatch` only) so pushes to `main` no longer deploy to Fly.
2. Move the custom domain / bookmark to the Northflank service URL.
3. Scale the Fly app to zero (`fly scale count 0 -a dlbtrust-app`) rather than
   destroying it, so the Fly volume remains available as a rollback for a while.
