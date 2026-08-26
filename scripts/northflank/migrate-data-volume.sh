#!/usr/bin/env bash
# Copy the contents of the Fly.io /data volume (Melio CSV exports, governance
# documents, journals, shutdown state) into the Northflank /data volume.
#
# Fly side is read with `fly ssh sftp`, Northflank side is written with the
# Northflank CLI file upload, so both containers keep running throughout.
#
# Usage:
#   FLY_API_TOKEN=... NORTHFLANK_API_TOKEN=... scripts/northflank/migrate-data-volume.sh
set -euo pipefail

: "${FLY_API_TOKEN:?FLY_API_TOKEN is required}"
: "${NORTHFLANK_API_TOKEN:?NORTHFLANK_API_TOKEN is required}"

FLY_APP="${FLY_APP:-dlbtrust-app}"
FLYCTL="${FLYCTL_BIN:-flyctl}"
PROJECT_ID="${NORTHFLANK_PROJECT_ID:-dlbtrust}"
SERVICE_ID="${NORTHFLANK_SERVICE_ID:-dlbtrust-app}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "archiving /data on Fly app $FLY_APP"
"$FLYCTL" ssh console -a "$FLY_APP" -C "/bin/sh -c 'tar -cz -C / data'" > "$WORK_DIR/data.tar.gz"
tar -tzf "$WORK_DIR/data.tar.gz" | head -20
echo "archive size: $(du -h "$WORK_DIR/data.tar.gz" | cut -f1)"

northflank login -t "$NORTHFLANK_API_TOKEN" -n dlbtrust --override >/dev/null

echo "uploading archive to $SERVICE_ID:/tmp/data.tar.gz"
northflank upload service file \
  --project "$PROJECT_ID" \
  --service "$SERVICE_ID" \
  --localPath "$WORK_DIR/data.tar.gz" \
  --remotePath /tmp/data.tar.gz

echo "extracting into /data"
northflank exec service \
  --project "$PROJECT_ID" \
  --service "$SERVICE_ID" \
  --shell-cmd 'sh -c' \
  --cmd 'tar -xz -C / -f /tmp/data.tar.gz && rm /tmp/data.tar.gz && ls -la /data'

# The volume mount hides the directories the Dockerfile creates, and Fly's /data
# never held an export directory, so recreate the paths the app writes to.
echo "ensuring /data layout"
northflank exec service \
  --project "$PROJECT_ID" \
  --service "$SERVICE_ID" \
  --shell-cmd 'sh -c' \
  --cmd 'mkdir -p /data/melio-exports /data/governance /data/journal /data/backups /data/shutdown-state && ls /data'

echo "done"
