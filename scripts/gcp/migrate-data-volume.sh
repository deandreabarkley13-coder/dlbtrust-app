#!/usr/bin/env bash
# Copy the Northflank /data volume (Melio CSV exports, governance documents,
# journals, shutdown state) into the Cloud Storage bucket that Cloud Run mounts
# at /data. Counterpart of scripts/northflank/migrate-data-volume.sh.
#
# Usage:
#   NORTHFLANK_API_TOKEN=... DATA_BUCKET=dlb-treasury-management-dlbtrust-app-data \
#     scripts/gcp/migrate-data-volume.sh
set -euo pipefail

: "${NORTHFLANK_API_TOKEN:?NORTHFLANK_API_TOKEN is required}"
: "${DATA_BUCKET:?DATA_BUCKET is required (terraform output data_bucket)}"
PROJECT_ID="${NORTHFLANK_PROJECT_ID:-dlbtrust}"
SERVICE_ID="${NORTHFLANK_SERVICE_ID:-dlbtrust-app}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

northflank login -t "$NORTHFLANK_API_TOKEN" -n dlbtrust --override >/dev/null

echo "archiving /data on Northflank service $SERVICE_ID"
northflank exec service --project "$PROJECT_ID" --service "$SERVICE_ID" \
  --cmd "/bin/sh -c 'tar -cz -C / data'" > "$WORK_DIR/data.tar.gz"
mkdir -p "$WORK_DIR/extract"
tar -xzf "$WORK_DIR/data.tar.gz" -C "$WORK_DIR/extract"
echo "archive size: $(du -h "$WORK_DIR/data.tar.gz" | cut -f1)"

# The app expects these directories; GCS has no empty directories, so seed each
# with a placeholder object FUSE renders as a directory.
for dir in melio-exports governance journal backups shutdown-state; do
  mkdir -p "$WORK_DIR/extract/data/$dir"
  touch "$WORK_DIR/extract/data/$dir/.keep"
done

echo "syncing to gs://$DATA_BUCKET"
gcloud storage rsync --recursive "$WORK_DIR/extract/data" "gs://$DATA_BUCKET"
gcloud storage ls --recursive "gs://$DATA_BUCKET" | wc -l | xargs echo "objects in bucket:"
