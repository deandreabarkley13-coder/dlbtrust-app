#!/usr/bin/env bash
# Copy the treasury ledger from the Northflank PostgreSQL 16 addon into Cloud SQL.
#
# Source: the addon's external TLS endpoint (enable external access on
# `dlbtrust-db` for the duration, then turn it off again). Target: the Cloud SQL
# instance through the Cloud SQL Auth Proxy, as the `postgres` admin user, so
# ownership can be handed to the application user at the end — the app creates
# missing tables at boot and aborts with `must be owner of table` otherwise.
#
# The Cloud Run service must be at zero traffic / not yet deployed when this
# runs, for the same reason as the Fly → Northflank move: the service seeds rows
# at boot that collide with the dump's primary keys. `public` is dropped and
# recreated on the target.
#
# Usage:
#   SOURCE_DATABASE_URL=postgresql://...  (Northflank addon external URI)
#   CLOUDSQL_CONNECTION_NAME=dlb-treasury-management:us-east1:dlbtrust-db-xxxx
#   CLOUDSQL_ADMIN_PASSWORD=...          (postgres user; set with `gcloud sql users set-password`)
#   APP_DB_USER=dlbtrust APP_DB_NAME=dlbtrust
#   scripts/gcp/migrate-postgres.sh [--dry-run]
set -euo pipefail

: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL is required}"
: "${CLOUDSQL_CONNECTION_NAME:?CLOUDSQL_CONNECTION_NAME is required}"
: "${CLOUDSQL_ADMIN_PASSWORD:?CLOUDSQL_ADMIN_PASSWORD is required}"
APP_DB_USER="${APP_DB_USER:-dlbtrust}"
APP_DB_NAME="${APP_DB_NAME:-dlbtrust}"
PROXY_PORT="${PROXY_PORT:-15433}"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

for bin in pg_dump psql pg_restore cloud-sql-proxy; do
  command -v "$bin" >/dev/null || { echo "$bin not found on PATH" >&2; exit 1; }
done
pg_dump --version | grep -Eq ' (1[6-9]|[2-9][0-9])\.' || {
  echo "pg_dump must be >= 16 (source server is 16)" >&2; exit 1; }

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"; [[ -n "${PROXY_PID:-}" ]] && kill "$PROXY_PID" 2>/dev/null || true' EXIT

echo "dumping source database"
pg_dump --format=custom --no-owner --no-acl --file "$WORK_DIR/ledger.dump" "$SOURCE_DATABASE_URL"
echo "dump size: $(du -h "$WORK_DIR/ledger.dump" | cut -f1)"
pg_restore --list "$WORK_DIR/ledger.dump" | grep -c 'TABLE DATA' | xargs echo "tables with data:"

if $DRY_RUN; then
  echo "dry run: not restoring"
  exit 0
fi

echo "starting Cloud SQL Auth Proxy on :$PROXY_PORT"
cloud-sql-proxy --port "$PROXY_PORT" "$CLOUDSQL_CONNECTION_NAME" >"$WORK_DIR/proxy.log" 2>&1 &
PROXY_PID=$!
for _ in $(seq 1 30); do
  PGPASSWORD="$CLOUDSQL_ADMIN_PASSWORD" psql -h 127.0.0.1 -p "$PROXY_PORT" -U postgres -d postgres -c 'select 1' >/dev/null 2>&1 && break
  sleep 1
done

TARGET="postgresql://postgres:${CLOUDSQL_ADMIN_PASSWORD}@127.0.0.1:${PROXY_PORT}/${APP_DB_NAME}"

# Lock the application role out for the duration so a lingering Cloud Run
# instance cannot reconnect and re-seed tables between the drop and the restore.
echo "locking out $APP_DB_USER and terminating its sessions"
psql "$TARGET" -v ON_ERROR_STOP=1 <<SQL
ALTER ROLE "$APP_DB_USER" NOLOGIN;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '$APP_DB_USER';
SQL
trap 'psql "$TARGET" -c "ALTER ROLE \"$APP_DB_USER\" LOGIN" >/dev/null 2>&1; rm -rf "$WORK_DIR"; [[ -n "${PROXY_PID:-}" ]] && kill "$PROXY_PID" 2>/dev/null || true' EXIT

# `pooler` is Northflank's pgbouncer auth schema (SECURITY DEFINER lookup on
# pg_shadow); Cloud SQL has its own connector, so it is not carried over.
EXCLUDE_SCHEMAS=(pooler)
mapfile -t DUMP_SCHEMAS < <(pg_restore --list "$WORK_DIR/ledger.dump" | awk '$4 == "SCHEMA" && $5 == "-" && $6 != "public" {print $6}')
echo "resetting schemas on target: public ${DUMP_SCHEMAS[*]}"
{
  for s in public "${DUMP_SCHEMAS[@]}" "${EXCLUDE_SCHEMAS[@]}"; do
    echo "DROP SCHEMA IF EXISTS \"$s\" CASCADE;"
  done
  echo 'CREATE SCHEMA public;'
  echo "GRANT ALL ON SCHEMA public TO \"$APP_DB_USER\";"
} | psql "$TARGET" -v ON_ERROR_STOP=1 -q

echo "restoring"
EXCLUDE_ARGS=()
for s in "${EXCLUDE_SCHEMAS[@]}"; do EXCLUDE_ARGS+=(--exclude-schema "$s"); done
pg_restore --no-owner --no-acl --exit-on-error "${EXCLUDE_ARGS[@]}" --dbname "$TARGET" "$WORK_DIR/ledger.dump"

echo "handing ownership to $APP_DB_USER"
SCHEMA_LIST="'public'"
for s in "${DUMP_SCHEMAS[@]}"; do SCHEMA_LIST+=", '$s'"; done
psql "$TARGET" -v ON_ERROR_STOP=1 <<SQL
-- PostgreSQL 16 requires SET ROLE rights on the new owner for ALTER ... OWNER TO.
GRANT "$APP_DB_USER" TO postgres;
DO \$\$
DECLARE r record;
BEGIN
  -- Cloud SQL's postgres role is not a superuser; serial sequences move with
  -- their table, so only touch objects postgres still owns.
  FOR r IN SELECT schemaname, tablename AS name FROM pg_tables
           WHERE schemaname IN ($SCHEMA_LIST) AND tableowner <> '$APP_DB_USER' LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO %I', r.schemaname, r.name, '$APP_DB_USER');
  END LOOP;
  FOR r IN SELECT schemaname, sequencename AS name FROM pg_sequences
           WHERE schemaname IN ($SCHEMA_LIST) AND sequenceowner <> '$APP_DB_USER' LOOP
    EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO %I', r.schemaname, r.name, '$APP_DB_USER');
  END LOOP;
  FOR r IN SELECT schemaname, viewname AS name FROM pg_views
           WHERE schemaname IN ($SCHEMA_LIST) AND viewowner <> '$APP_DB_USER' LOOP
    EXECUTE format('ALTER VIEW %I.%I OWNER TO %I', r.schemaname, r.name, '$APP_DB_USER');
  END LOOP;
  FOR r IN SELECT nspname AS name FROM pg_namespace
           WHERE nspname IN ($SCHEMA_LIST) LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO %I', r.name, '$APP_DB_USER');
  END LOOP;
END
\$\$;
ALTER ROLE "$APP_DB_USER" LOGIN;
SQL

echo "row counts (source vs target) for the ledger tables"
for t in bonds cash_accounts trust_accounts users canonical_payments; do
  s=$(psql "$SOURCE_DATABASE_URL" -tAc "select count(*) from $t" 2>/dev/null || echo n/a)
  d=$(psql "$TARGET" -tAc "select count(*) from $t" 2>/dev/null || echo n/a)
  printf '  %-20s %10s %10s\n' "$t" "$s" "$d"
done
echo "done — disable external access on the Northflank addon again"
