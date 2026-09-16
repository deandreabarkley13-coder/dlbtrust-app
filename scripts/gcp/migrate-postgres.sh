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

echo "resetting public schema on target"
psql "$TARGET" -v ON_ERROR_STOP=1 <<SQL
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO "$APP_DB_USER";
SQL

echo "restoring"
pg_restore --no-owner --no-acl --dbname "$TARGET" "$WORK_DIR/ledger.dump"

echo "handing ownership to $APP_DB_USER"
psql "$TARGET" -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO %I', r.tablename, '$APP_DB_USER');
  END LOOP;
  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO %I', r.sequencename, '$APP_DB_USER');
  END LOOP;
  FOR r IN SELECT viewname FROM pg_views WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER VIEW public.%I OWNER TO %I', r.viewname, '$APP_DB_USER');
  END LOOP;
END
\$\$;
ALTER SCHEMA public OWNER TO "$APP_DB_USER";
SQL

echo "row counts (source vs target) for the ledger tables"
for t in bonds cash_accounts trust_accounts users canonical_payments; do
  s=$(psql "$SOURCE_DATABASE_URL" -tAc "select count(*) from $t" 2>/dev/null || echo n/a)
  d=$(psql "$TARGET" -tAc "select count(*) from $t" 2>/dev/null || echo n/a)
  printf '  %-20s %10s %10s\n' "$t" "$s" "$d"
done
echo "done — disable external access on the Northflank addon again"
