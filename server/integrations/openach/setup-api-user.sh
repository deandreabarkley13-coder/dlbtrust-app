#!/bin/bash
# =============================================================================
# OpenACH API User Setup Script
# Run this on the IONOS server (74.208.191.205) as root or sudo
# Creates the API user credentials needed for REST API access
# =============================================================================

set -e

echo "============================================"
echo " OpenACH API User Setup — dlbtrust.cloud"
echo "============================================"

# Step 1: Find the OpenACH container
echo ""
echo "[1] Finding OpenACH Docker container..."
CONTAINER=$(docker ps --format '{{.Names}}' | grep -i openach | head -1)

if [ -z "$CONTAINER" ]; then
  echo "ERROR: No OpenACH container found. Trying by image name..."
  CONTAINER=$(docker ps --format '{{.Names}}\t{{.Image}}' | grep -i openach | awk '{print $1}' | head -1)
fi

if [ -z "$CONTAINER" ]; then
  echo "ERROR: Cannot find OpenACH container. Listing all containers:"
  docker ps
  exit 1
fi

echo "Found container: $CONTAINER"

# Step 2: Get the user_id and originator_info_id from the database
echo ""
echo "[2] Querying OpenACH database for user and originator IDs..."

# Try to find the database path
DB_PATH=$(docker exec "$CONTAINER" find /var/www/html -name "openach.db" 2>/dev/null | head -1)
if [ -z "$DB_PATH" ]; then
  DB_PATH="/var/www/html/protected/runtime/db/openach.db"
fi

echo "Database path: $DB_PATH"

echo ""
echo "--- Users ---"
docker exec "$CONTAINER" sqlite3 "$DB_PATH" "SELECT user_id, user_login, user_email_address FROM oa_user WHERE user_status='enabled' LIMIT 5;"

echo ""
echo "--- Originator Info ---"
docker exec "$CONTAINER" sqlite3 "$DB_PATH" "SELECT originator_info_id, originator_info_name FROM oa_originator_info LIMIT 5;"

echo ""
echo "--- Existing API Users (if any) ---"
docker exec "$CONTAINER" sqlite3 "$DB_PATH" "SELECT user_api_user_id, user_api_token, user_api_key, user_api_user_originator_info_id FROM oa_user_api_user LIMIT 5;" 2>/dev/null || echo "(table may not exist yet)"

# Step 3: Extract the IDs
echo ""
echo "[3] Extracting IDs..."
USER_ID=$(docker exec "$CONTAINER" sqlite3 "$DB_PATH" "SELECT user_id FROM oa_user WHERE user_status='enabled' ORDER BY user_created_date LIMIT 1;")
ORIGINATOR_INFO_ID=$(docker exec "$CONTAINER" sqlite3 "$DB_PATH" "SELECT originator_info_id FROM oa_originator_info LIMIT 1;")

if [ -z "$USER_ID" ] || [ -z "$ORIGINATOR_INFO_ID" ]; then
  echo "ERROR: Could not extract IDs automatically."
  echo "USER_ID: '$USER_ID'"
  echo "ORIGINATOR_INFO_ID: '$ORIGINATOR_INFO_ID'"
  echo ""
  echo "Please run manually:"
  echo "  docker exec $CONTAINER sqlite3 $DB_PATH 'SELECT user_id FROM oa_user;'"
  echo "  docker exec $CONTAINER sqlite3 $DB_PATH 'SELECT originator_info_id FROM oa_originator_info;'"
  exit 1
fi

echo "user_id: $USER_ID"
echo "originator_info_id: $ORIGINATOR_INFO_ID"

# Step 4: Create the API user
echo ""
echo "[4] Creating OpenACH API user..."
docker exec "$CONTAINER" bash -c "cd /var/www/html/protected && php ../yiic apiuser create --user_id=$USER_ID --originator_info_id=$ORIGINATOR_INFO_ID"

# Step 5: Retrieve the newly created credentials
echo ""
echo "[5] Retrieving API credentials from database..."
docker exec "$CONTAINER" sqlite3 "$DB_PATH" "SELECT user_api_token, user_api_key, user_api_user_originator_info_id FROM oa_user_api_user ORDER BY rowid DESC LIMIT 1;"

echo ""
echo "============================================"
echo " DONE — Copy the token and key above into"
echo " your .env file as:"
echo "   OPENACH_API_TOKEN=<token>"
echo "   OPENACH_API_KEY=<key>"
echo "============================================"
