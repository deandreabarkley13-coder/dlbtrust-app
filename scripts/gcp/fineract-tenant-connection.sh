#!/usr/bin/env bash
# Point Fineract's tenant store at the Cloud SQL copy of fineract_default.
#
# Fineract resolves each tenant's database from fineract_tenants.tenant_server_connections,
# not from FINERACT_DEFAULT_TENANTDB_*; those env vars are only used when the
# row is first created. After migrate-postgres.sh copies the store, the row
# still names the Northflank addon host, so the service boots, connects to the
# tenant store, then hangs trying to reach the old database. Run this once
# after the restore and before the first Cloud Run revision starts.
#
# schema_password is left alone: it is encrypted with Fineract's master
# password, so the Cloud SQL role must keep the Northflank password
# (FINERACT_DB_PASSWORD is copied from FINERACT_DEFAULT_TENANTDB_PWD).
#
# Usage:
#   CLOUDSQL_CONNECTION_NAME=...  CLOUDSQL_ADMIN_PASSWORD=...
#   scripts/gcp/fineract-tenant-connection.sh
set -euo pipefail

: "${CLOUDSQL_CONNECTION_NAME:?CLOUDSQL_CONNECTION_NAME is required}"
: "${CLOUDSQL_ADMIN_PASSWORD:?CLOUDSQL_ADMIN_PASSWORD is required}"
FINERACT_DB_USER="${FINERACT_DB_USER:-fineract}"
FINERACT_DB_NAME="${FINERACT_DB_NAME:-fineract_default}"
PROXY_PORT="${PROXY_PORT:-15433}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"; [[ -n "${PROXY_PID:-}" ]] && kill "$PROXY_PID" 2>/dev/null || true' EXIT

SQL_HOST="$(gcloud sql instances describe "${CLOUDSQL_CONNECTION_NAME##*:}" \
  --project "${CLOUDSQL_CONNECTION_NAME%%:*}" \
  --format 'value(ipAddresses.filter("type:PRIVATE").extract("ipAddress").flatten())')"
[[ -n "$SQL_HOST" ]] || { echo "instance has no private IP" >&2; exit 1; }

cloud-sql-proxy --port "$PROXY_PORT" "$CLOUDSQL_CONNECTION_NAME" >"$WORK_DIR/proxy.log" 2>&1 &
PROXY_PID=$!
for _ in $(seq 1 30); do
  PGPASSWORD="$CLOUDSQL_ADMIN_PASSWORD" psql -h 127.0.0.1 -p "$PROXY_PORT" -U postgres -d fineract_tenants -c 'select 1' >/dev/null 2>&1 && break
  sleep 1
done

PGPASSWORD="$CLOUDSQL_ADMIN_PASSWORD" psql -h 127.0.0.1 -p "$PROXY_PORT" -U postgres -d fineract_tenants \
  -v ON_ERROR_STOP=1 -v host="$SQL_HOST" -v user="$FINERACT_DB_USER" -v db="$FINERACT_DB_NAME" <<'SQL'
UPDATE tenant_server_connections
   SET schema_server = :'host',
       schema_server_port = '5432',
       schema_name = :'db',
       schema_username = :'user'
 WHERE id = (SELECT oltp_id FROM tenants WHERE identifier = 'default');
SELECT identifier, schema_server, schema_server_port, schema_name, schema_username
  FROM tenants t JOIN tenant_server_connections c ON c.id = t.oltp_id;
SQL
