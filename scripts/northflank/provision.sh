#!/usr/bin/env bash
# Provision the Northflank project, PostgreSQL addons, /data volume, the
# dlbtrust-app combined service, the OpenACH service and the Apache Fineract
# GL service from the JSON specs in northflank/.
#
# OpenACH replaces the IONOS-hosted ach.dlbtrust.cloud instance: it runs from
# openach/Dockerfile against its own openach-db addon, so ACH origination lives
# in the same project as the treasury app instead of on an unmanaged host.
#
# Idempotent: existing resources are left untouched.
#
# Requires: NORTHFLANK_API_TOKEN, the Northflank CLI (npm i -g @northflank/cli)
# and a Northflank account with the GitHub repo linked (the service builds
# straight from git).
set -euo pipefail

: "${NORTHFLANK_API_TOKEN:?NORTHFLANK_API_TOKEN is required}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPEC_DIR="$REPO_ROOT/northflank"
PROJECT_ID="${NORTHFLANK_PROJECT_ID:-dlbtrust}"
SERVICE_ID="${NORTHFLANK_SERVICE_ID:-dlbtrust-app}"
ADDON_ID="${NORTHFLANK_ADDON_ID:-dlbtrust-db}"
VOLUME_ID="${NORTHFLANK_VOLUME_ID:-dlbtrust-data}"
OPENACH_SERVICE_ID="${NORTHFLANK_OPENACH_SERVICE_ID:-openach}"
OPENACH_ADDON_ID="${NORTHFLANK_OPENACH_ADDON_ID:-openach-db}"
FINERACT_SERVICE_ID="${NORTHFLANK_FINERACT_SERVICE_ID:-dlbtrust-fineract}"
FINERACT_ADDON_ID="${NORTHFLANK_FINERACT_ADDON_ID:-fineract-db}"

northflank login -t "$NORTHFLANK_API_TOKEN" -n dlbtrust --override >/dev/null

nf() { northflank "$@" --output json; }

exists() {
  # exists <resource...> — resource getters exit non-zero when absent
  nf get "$@" >/dev/null 2>&1
}

if exists project --project "$PROJECT_ID"; then
  echo "project $PROJECT_ID already exists"
else
  echo "creating project $PROJECT_ID"
  nf create project -f "$SPEC_DIR/project.json"
fi

if exists addon --project "$PROJECT_ID" --addon "$ADDON_ID"; then
  echo "addon $ADDON_ID already exists"
else
  echo "creating postgres addon $ADDON_ID"
  nf create addon --project "$PROJECT_ID" -f "$SPEC_DIR/addon-postgres.json"
fi

if exists service --project "$PROJECT_ID" --service "$SERVICE_ID"; then
  echo "service $SERVICE_ID already exists"
else
  echo "creating combined service $SERVICE_ID"
  nf create service combined --project "$PROJECT_ID" -f "$SPEC_DIR/service-dlbtrust-app.json"
fi

if exists volume --project "$PROJECT_ID" --volume "$VOLUME_ID"; then
  echo "volume $VOLUME_ID already exists"
else
  echo "creating volume $VOLUME_ID mounted at /data"
  nf create volume --project "$PROJECT_ID" -f "$SPEC_DIR/volume-data.json"
fi

if exists addon --project "$PROJECT_ID" --addon "$OPENACH_ADDON_ID"; then
  echo "addon $OPENACH_ADDON_ID already exists"
else
  echo "creating postgres addon $OPENACH_ADDON_ID for OpenACH"
  nf create addon --project "$PROJECT_ID" -f "$SPEC_DIR/addon-postgres-openach.json"
fi

if exists service --project "$PROJECT_ID" --service "$OPENACH_SERVICE_ID"; then
  echo "service $OPENACH_SERVICE_ID already exists"
else
  echo "creating combined service $OPENACH_SERVICE_ID"
  nf create service combined --project "$PROJECT_ID" -f "$SPEC_DIR/service-openach.json"
fi

if exists addon --project "$PROJECT_ID" --addon "$FINERACT_ADDON_ID"; then
  echo "addon $FINERACT_ADDON_ID already exists"
else
  echo "creating postgres addon $FINERACT_ADDON_ID for Fineract"
  nf create addon --project "$PROJECT_ID" -f "$SPEC_DIR/addon-postgres-fineract.json"
fi

if exists service --project "$PROJECT_ID" --service "$FINERACT_SERVICE_ID"; then
  echo "service $FINERACT_SERVICE_ID already exists"
else
  echo "creating deployment service $FINERACT_SERVICE_ID"
  nf create service deployment --project "$PROJECT_ID" -f "$SPEC_DIR/service-fineract.json"
fi

cat <<EOF

Fineract needs its database credentials and dlbtrust-app needs the connection
variables (FINERACT_URL, FINERACT_TENANT_ID, FINERACT_USERNAME,
FINERACT_PASSWORD, FINERACT_DATABASE_URL, FINERACT_DB_HOST, FINERACT_DB_PORT):
  FINERACT_PASSWORD=... node scripts/northflank/configure-fineract.mjs
which writes the fineract-runtime group (restricted to $FINERACT_SERVICE_ID)
and links $FINERACT_ADDON_ID into dlbtrust-runtime. Both services live in
project $PROJECT_ID, so $FINERACT_SERVICE_ID resolves over the project network.
EOF

cat <<EOF

OpenACH still needs its runtime configuration before it will boot:
  DATABASE_URL              link from the $OPENACH_ADDON_ID addon
  OPENACH_ENCRYPTION_KEY    openssl rand -hex 32  (cannot be rotated later)
  OPENACH_VALIDATION_KEY    openssl rand -hex 32
then bootstrap the installation and issue the trust's api credential — see
docs/OPENACH_NORTHFLANK.md.
EOF

cat <<EOF

Provisioned. Remaining steps:
  1. scripts/northflank/migrate-fly-secrets.sh   copy runtime secrets from Fly
  2. scripts/northflank/migrate-postgres.sh      copy the ledger database
  3. scripts/northflank/migrate-data-volume.sh   copy /data (Melio exports, governance)
EOF
