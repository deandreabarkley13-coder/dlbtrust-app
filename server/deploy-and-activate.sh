#!/bin/bash
# ============================================================
# dlbtrust.cloud — Complete OpenACH Deploy + Activate
# Run this ONE command on your server (Plesk terminal or SSH)
#
# Usage:
#   bash /path/to/deploy-and-activate.sh
#
# Or if you haven't pulled yet, run this one-liner:
#   curl -s https://raw.githubusercontent.com/deandreabarkley13-coder/dlbtrust-app/main/server/deploy-and-activate.sh | bash
# ============================================================

set -e

echo "============================================================"
echo " dlbtrust.cloud — OpenACH Deploy + Activate"
echo "============================================================"

# Find app directory — check for app.js or server.js
APP_DIR=""
for ENTRY in app.js server.js; do
  FOUND=$(find /var/www/vhosts/dlbtrust.cloud -name "$ENTRY" \
    -not -path "*/node_modules/*" 2>/dev/null | head -1 | xargs dirname 2>/dev/null)
  if [ -n "$FOUND" ]; then
    APP_DIR="$FOUND"
    ENTRY_FILE="$ENTRY"
    break
  fi
done

if [ -z "$APP_DIR" ]; then
  APP_DIR="/var/www/vhosts/dlbtrust.cloud/httpdocs"
  # Prefer app.js (newly committed) over server.js
  if [ -f "$APP_DIR/app.js" ]; then
    ENTRY_FILE="app.js"
  else
    ENTRY_FILE="server.js"
  fi
fi

echo ""
echo "[1] App directory: $APP_DIR"
echo "    Entry file: $ENTRY_FILE"
cd "$APP_DIR"

# Pull latest code
echo "[2] Pulling latest code from GitHub..."
git pull origin main 2>&1 || echo "    git pull failed — continuing with local files"

# Install dependencies
echo ""
echo "[2b] Installing Node.js dependencies..."
npm install --production 2>&1 || echo "    npm install failed — check manually"

# Patch entry file if not already patched
echo ""
echo "[3] Patching $ENTRY_FILE with OpenACH routes..."
if grep -q "openach-patch" "$ENTRY_FILE" 2>/dev/null; then
  echo "    Already patched — skipping"
else
  if grep -q "app\.listen" "$ENTRY_FILE" 2>/dev/null; then
    sed -i "s|app\.listen|require('./server/openach-patch')(app, typeof db !== 'undefined' ? db : app.locals.db);\napp.listen|" "$ENTRY_FILE"
    echo "    Patched successfully (app.listen hook)"
  elif grep -q "server\.listen" "$ENTRY_FILE" 2>/dev/null; then
    sed -i "s|server\.listen|require('./server/openach-patch')(app, typeof db !== 'undefined' ? db : app.locals.db);\nserver.listen|" "$ENTRY_FILE"
    echo "    Patched successfully (server.listen hook)"
  else
    echo "    WARNING: Could not auto-patch $ENTRY_FILE"
    echo "    Manually add this line before your app.listen():"
    echo "      require('./server/openach-patch')(app, db);"
  fi
fi

# Ensure dotenv is loaded at top of entry file
if ! grep -q "dotenv" "$ENTRY_FILE" 2>/dev/null; then
  sed -i "1s|^|require('dotenv').config();\n|" "$ENTRY_FILE"
  echo "    Added dotenv.config() at top of $ENTRY_FILE"
fi

# OpenACH API credentials
# Provisioning is a separate, explicit operator step so that no credential is
# carried in this script: server-side-setup.js generates a pair, registers it in
# the OpenACH database and prints the env lines to add.
echo ""
echo "[4] Checking OpenACH API credentials..."

if [ -n "$OPENACH_API_TOKEN" ] && [ -n "$OPENACH_API_KEY" ]; then
  echo "    Using OPENACH_API_TOKEN / OPENACH_API_KEY from the environment"
else
  echo "    No OpenACH credential in the environment."
  echo "    Provision one with:"
  echo "      node $APP_DIR/server/integrations/openach/server-side-setup.js"
fi

# Update .env with OpenACH settings
echo ""
echo "[5] Updating .env with OpenACH settings..."
ENV_FILE="$APP_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  touch "$ENV_FILE"
  echo "    Created new .env file"
fi

add_env_var() {
  local key="$1"
  local val="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    echo "    $key already set"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
    echo "    Added: ${key}=${val}"
  fi
}

if [ -n "$OPENACH_BASE_URL" ]; then
  add_env_var "OPENACH_BASE_URL" "$OPENACH_BASE_URL"
else
  echo "    OPENACH_BASE_URL unset: point it at the Northflank openach service"
fi
if [ -n "$OPENACH_API_TOKEN" ] && [ -n "$OPENACH_API_KEY" ]; then
  add_env_var "OPENACH_API_TOKEN" "$OPENACH_API_TOKEN"
  add_env_var "OPENACH_API_KEY" "$OPENACH_API_KEY"
fi

# Get payment type ID for Trust Dist
echo ""
echo "[6] Fetching Trust Dist payment type ID..."
if [ -z "$OPENACH_API_TOKEN" ] || [ -z "$OPENACH_API_KEY" ] || [ -z "$OPENACH_BASE_URL" ]; then
  echo "    Skipped: no OpenACH service url / credential to authenticate with"
  CONNECT=""
else
  CONNECT=$(curl -s --max-time 8 \
    -X POST "$OPENACH_BASE_URL/connect" \
    --data "user_api_token=$OPENACH_API_TOKEN&user_api_key=$OPENACH_API_KEY" 2>/dev/null)
  echo "    Connect: $CONNECT"
fi

SESSION=$(echo "$CONNECT" | grep -oP '"session_id"\s*:\s*"[^"]*"' | grep -oP '"[^"]*"$' | tr -d '"')
if [ -n "$SESSION" ]; then
  TYPES=$(curl -s --max-time 8 \
    -X POST "$OPENACH_BASE_URL/getPaymentTypes" \
    -H "Cookie: PHPSESSID=$SESSION" 2>/dev/null)
  echo "    Payment types: $TYPES"
  
  # Disconnect
  curl -s --max-time 5 -X POST "$OPENACH_BASE_URL/disconnect" \
    -H "Cookie: PHPSESSID=$SESSION" > /dev/null 2>&1
  
  # Extract payment type ID
  PT_ID=$(echo "$TYPES" | grep -oP '"payment_type_id"\s*:\s*"[^"]*"' | head -1 | grep -oP '"[^"]*"$' | tr -d '"')
  if [ -n "$PT_ID" ]; then
    echo "    ✅ Payment Type ID: $PT_ID"
    add_env_var "OPENACH_PAYMENT_TYPE_ID" "$PT_ID"
  fi
fi

# Restart the Node.js app
echo ""
echo "[7] Restarting Node.js app..."
if command -v pm2 &>/dev/null; then
  pm2 delete dlbtrust 2>/dev/null || true
  pm2 start "$ENTRY_FILE" --name dlbtrust --env production
  pm2 save
  echo "    pm2 started dlbtrust"
else
  PIDFILE="/tmp/dlbtrust.pid"
  if [ -f "$PIDFILE" ]; then
    kill $(cat "$PIDFILE") 2>/dev/null || true
  fi
  nohup node "$ENTRY_FILE" > /tmp/dlbtrust.log 2>&1 &
  echo $! > "$PIDFILE"
  echo "    Started PID $(cat $PIDFILE)"
fi

sleep 4

# Final health check
echo ""
echo "[8] Health checks..."
echo -n "    OpenACH API:  "
if [ -n "$OPENACH_API_TOKEN" ] && [ -n "$OPENACH_API_KEY" ] && [ -n "$OPENACH_BASE_URL" ]; then
  curl -s --max-time 8 \
    -X POST "$OPENACH_BASE_URL/connect" \
    --data "user_api_token=$OPENACH_API_TOKEN&user_api_key=$OPENACH_API_KEY" 2>/dev/null | grep -oP '"success":\s*(true|false)'
else
  echo "skipped (no service url / credential in the environment)"
fi

echo -n "    ACH endpoint: "
curl -s --max-time 8 "http://localhost:3001/api/ach/health" 2>/dev/null | grep -oP '"openach_connected":\s*(true|false)' || \
curl -s --max-time 8 "http://localhost:3000/api/ach/health" 2>/dev/null | grep -oP '"openach_connected":\s*(true|false)' || \
echo "    (check manually: curl https://dlbtrust.cloud/api/ach/health)"

echo ""
echo "============================================================"
echo " COMPLETE — OpenACH integration deployed and active"
echo " Test disbursement: https://dlbtrust.cloud/api/ach/health"
echo "============================================================"
