# OpenACH on Northflank

The trust's ACH rail originates through OpenACH. OpenACH used to run as an
unmanaged Docker container behind an IONOS Plesk vhost (`ach.dlbtrust.cloud`),
which is unreachable from CI and from the app's own host; it now runs as the
`openach` service inside the same Northflank project as `dlbtrust-app`, built
from `openach/Dockerfile` against its own `openach-db` PostgreSQL addon.

```
dlbtrust-app  ──OPENACH_BASE_URL──▶  openach (php:7.4-apache, pinned upstream)
     │                                    │
 dlbtrust-db                          openach-db
 (treasury ledger)                    (ACH origination + api credentials)
```

`openach-db` is deliberately separate: OpenACH owns origination state, the
treasury ledger stays the single source of truth for payments, and
`InHouseBankEngine.confirm()` remains the only settlement gate.

## 1. Provision

```bash
export NORTHFLANK_API_TOKEN=...        # org secret
bash scripts/northflank/provision.sh   # idempotent; creates openach-db + openach
```

Current deployment: service `openach`, url
`https://p01--openach--gcq8bn6c4zlp.code.run` (api at `/api`), addon `openach-db`.
The runtime configuration below lives in the project secret group
`openach-runtime`, restricted to the `openach` service.

The service builds `/openach/Dockerfile` from this repo, so the Northflank
account must have the GitHub repo linked.

## 2. Runtime configuration (`openach` service)

| Variable | Source |
| --- | --- |
| `DATABASE_URL` | link the `openach-db` addon into the service (`postgres://…`) |
| `OPENACH_ENCRYPTION_KEY` | Northflank secret — exactly 16, 24 or 32 characters, **never rotate once encrypted rows exist** |
| `OPENACH_VALIDATION_KEY` | Northflank secret — 32+ random bytes |

```bash
openssl rand -hex 16   # OPENACH_ENCRYPTION_KEY (32 chars)
openssl rand -hex 32   # OPENACH_VALIDATION_KEY
```

The encryption key is handed to Yii's `CSecurityManager` as the raw rijndael
key, so a longer value is rejected — not by the api, but by the first save of a
record with an encrypted column (`Encryption key length can be 16,24,32`). The
entrypoint now refuses to start on a wrong length instead.

The entrypoint refuses to start without all three. On first boot it installs
the upstream PostgreSQL schema and seed data, then applies `openach/migrations/*.sql`.

## 3. Bootstrap the installation

Run once, in a shell on the `openach` service, with the trust's real banking
details:

```bash
OPENACH_ADMIN_LOGIN=... OPENACH_ADMIN_PASSWORD=... OPENACH_ADMIN_EMAIL=... \
OPENACH_ORIGINATOR_NAME='DLB TRUST' \
OPENACH_ORIGINATOR_ID=... \
OPENACH_ODFI_ROUTING=... \
OPENACH_SETTLEMENT_ACCOUNT=... \
  openach-bootstrap
```

It creates the user, originator, ODFI and settlement account and prints the
payment types. `OPENACH_ORIGINATOR_NAME` is the ACH batch header company name
and is capped at 16 characters, so the trust's full legal name does not fit.

Outbound disbursements originate as ACH **credits**, so the payment type id the
app is configured with must be the one OpenACH lists as `credit`.

## 4. Register the api credential

`openach-db` has external access disabled, so run this from inside the project —
a shell on the `dlbtrust-app` service, which has node and `pg` — with the
addon's `POSTGRES_URI` and the service url:

```bash
OPENACH_DATABASE_URL=postgres://…openach-db… \
OPENACH_BASE_URL=https://p01--openach--gcq8bn6c4zlp.code.run/api \
OPENACH_API_TOKEN=<new token> OPENACH_API_KEY=<new key> \
  node server/integrations/openach/server-side-setup.js
```

It inserts the credential into OpenACH's `user_api` table, authenticates
`POST /connect`, lists the payment types and prints the `OPENACH_PAYMENT_TYPE_ID`
values. Pass `OPENACH_REVOKE_TOKEN=<old token>` to disable a superseded
credential in the same run. Token and key are never written to the repo.

## 5. Point the app at the service

On `dlbtrust-app` (Northflank secrets, not git). Write them with
`scripts/northflank/set-secrets.mjs` — a raw `PATCH` on a secret group replaces
every variable in it:

```bash
NORTHFLANK_API_TOKEN=... node scripts/northflank/set-secrets.mjs \
  --group dlbtrust-runtime OPENACH_BASE_URL=... OPENACH_API_TOKEN=...
```

```
OPENACH_BASE_URL=https://p01--openach--gcq8bn6c4zlp.code.run/api
OPENACH_API_TOKEN=…
OPENACH_API_KEY=…
OPENACH_PAYMENT_TYPE_ID=…             # standard ACH type from step 4
OPENACH_SAME_DAY_PAYMENT_TYPE_ID=…    # only if the ODFI profile has one
OPENACH_RAILS=ach_standard            # add ach_same_day only when configured
```

There is no default OpenACH host anywhere in the code: with `OPENACH_BASE_URL`
unset the rail reports itself unready and the family-bank flow escalates ACH
payments to the manual rail instead of originating.

Verify:

```bash
curl -s -X POST "$OPENACH_BASE_URL/connect" \
  --data "user_api_token=$OPENACH_API_TOKEN&user_api_key=$OPENACH_API_KEY"
curl -s "$APP_URL/api/openach-rail/health"
```

## Local verification

```bash
docker build -t openach:local openach
docker run -d --name openach-db -e POSTGRES_PASSWORD=openach -e POSTGRES_DB=openach postgres:16
docker run -d --name openach -p 8081:80 --link openach-db \
  -e DATABASE_URL=postgres://postgres:openach@openach-db:5432/openach \
  -e OPENACH_ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e OPENACH_VALIDATION_KEY=$(openssl rand -hex 32) openach:local
```

Then run steps 3 and 4 against `http://localhost:8081/api` (set
`OPENACH_ALLOW_INSECURE_TLS=true` only for hosts without a valid certificate).
