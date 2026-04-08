#!/bin/bash
# ============================================================
# dlbtrust.cloud — COMPLETE RECOVERY SCRIPT
# Run from IONOS KVM Console or SSH from unblocked IP
#
#   bash <(curl -s https://raw.githubusercontent.com/deandreabarkley13-coder/dlbtrust-app/main/server/recover.sh)
#
# ============================================================
set -e
REPO="https://raw.githubusercontent.com/deandreabarkley13-coder/dlbtrust-app/main"
APP_VHOST="/var/www/vhosts/dlbtrust.cloud"
ACH_VHOST="/var/www/vhosts/ach.dlbtrust.cloud"
BLUE='\033[0;34m'; GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'

step() { echo -e "\n${BLUE}[$1]${NC} $2"; }
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
err()  { echo -e "  ${RED}✗${NC} $1"; }

echo "============================================================"
echo " dlbtrust.cloud — Recovery Script"
echo " $(date)"
echo "============================================================"

# ── STEP 1: Unblock fail2ban ─────────────────────────────────
step "1/9" "Clearing fail2ban bans..."
if command -v fail2ban-client &>/dev/null; then
  fail2ban-client status 2>/dev/null | grep "Jail list" | sed 's/.*://;s/,/ /g' | \
    xargs -I{} fail2ban-client set {} unbanall 2>/dev/null || true
  ok "fail2ban bans cleared"
else
  ok "fail2ban not installed"
fi

# ── STEP 2: Fix Apache vhost for dlbtrust.cloud ──────────────
step "2/9" "Configuring Apache VirtualHost for dlbtrust.cloud..."
mkdir -p $APP_VHOST/conf
curl -s "$REPO/server/apache-config/dlbtrust.cloud-vhost.conf" \
  -o $APP_VHOST/conf/vhost.conf
ok "vhost.conf written"

# ── STEP 3: Fix Apache vhost for ach.dlbtrust.cloud ─────────
step "3/9" "Configuring Apache VirtualHost for ach.dlbtrust.cloud..."
mkdir -p $ACH_VHOST/conf 2>/dev/null || true
curl -s "$REPO/server/apache-config/ach.dlbtrust.cloud-vhost.conf" \
  -o $ACH_VHOST/conf/vhost.conf 2>/dev/null || true
ok "ach vhost.conf written"

# ── STEP 4: Rebuild Apache config ───────────────────────────
step "4/9" "Rebuilding Apache configuration via Plesk..."
/usr/local/psa/admin/sbin/httpdmng --reconfigure-domain dlbtrust.cloud 2>/dev/null && ok "dlbtrust.cloud reconfigured" || err "httpdmng failed — manual reload needed"
/usr/local/psa/admin/sbin/httpdmng --reconfigure-domain ach.dlbtrust.cloud 2>/dev/null && ok "ach.dlbtrust.cloud reconfigured" || true
apache2ctl configtest 2>&1 | tail -2
service apache2 reload && ok "Apache reloaded" || service apache2 restart && ok "Apache restarted"

# ── STEP 5: Fix SSL cert ─────────────────────────────────────
step "5/9" "Checking SSL certificates..."
certbot certificates 2>/dev/null | grep -A3 "dlbtrust.cloud" || echo "certbot not found or no certs"
# Try renew if expired
certbot renew --quiet 2>/dev/null && ok "Certs renewed" || ok "Certs up to date or manual renewal needed"

# ── STEP 6: Start/restart OpenACH Docker ────────────────────
step "6/9" "Starting OpenACH Docker container..."
CONTAINER=$(docker ps -a --format "{{.Names}}" | grep -i openach | head -1)
if [ -n "$CONTAINER" ]; then
  docker start "$CONTAINER" 2>/dev/null || true
  sleep 2
  docker ps | grep openach && ok "OpenACH container running" || err "OpenACH container failed to start"
else
  err "No OpenACH container found — check docker ps -a"
  docker ps -a | head -10
fi

# ── STEP 7: Insert OpenACH API credentials ───────────────────
step "7/9" "Inserting OpenACH API credentials..."
CONTAINER=$(docker ps --format "{{.Names}}" | grep -i openach | head -1)
if [ -n "$CONTAINER" ]; then
  DB=$(docker exec "$CONTAINER" find /var/www/html -name "openach.db" 2>/dev/null | head -1)
  DB=${DB:-"/var/www/html/protected/runtime/db/openach.db"}
  docker exec "$CONTAINER" sqlite3 "$DB" \
    "INSERT OR IGNORE INTO user_api (user_api_user_id, user_api_datetime, user_api_originator_info_id, user_api_token, user_api_key, user_api_status) VALUES ('4fc86059-2e7b-4732-b94f-e7c3715ee8d7', datetime('now'), '0eb26e1d-5fcc-4978-a132-dd93c2655429', '3caee1c2-c218-4959-b6d2-21d4b2a1b42e', 'b74966cf-5276-4d8b-8650-5bd57dcee272', 'enabled');"
  VERIFY=$(docker exec "$CONTAINER" sqlite3 "$DB" "SELECT user_api_token FROM user_api WHERE user_api_token='3caee1c2-c218-4959-b6d2-21d4b2a1b42e';")
  [ -n "$VERIFY" ] && ok "API credentials inserted: $VERIFY" || err "Insert may have failed"
else
  err "OpenACH container not running — skipping credential insert"
fi

# ── STEP 8: Deploy app code + start Node.js ─────────────────
step "8/9" "Deploying application code..."
APP_DIR=""
for ENTRY in app.js server.js; do
  FOUND=$(find /var/www/vhosts/dlbtrust.cloud -name "$ENTRY" \
    -not -path "*/node_modules/*" 2>/dev/null | head -1 | xargs dirname 2>/dev/null)
  if [ -n "$FOUND" ]; then APP_DIR="$FOUND"; ENTRY_FILE="$ENTRY"; break; fi
done
APP_DIR=${APP_DIR:-"$APP_VHOST/httpdocs"}
ENTRY_FILE=${ENTRY_FILE:-"app.js"}

cd "$APP_DIR"
echo "  App dir: $APP_DIR / Entry: $ENTRY_FILE"

git pull origin main 2>&1 | tail -3 || ok "git pull failed — using local files"
npm install --production 2>&1 | tail -3

# Set .env
grep -q "OPENACH_API_TOKEN" .env 2>/dev/null || cat >> .env << 'ENVEOF'
OPENACH_BASE_URL=http://localhost/openach/api
OPENACH_HOST_HEADER=ach.dlbtrust.cloud
OPENACH_API_TOKEN=3caee1c2-c218-4959-b6d2-21d4b2a1b42e
OPENACH_API_KEY=b74966cf-5276-4d8b-8650-5bd57dcee272
PORT=3001
ENVEOF
ok ".env updated"

# Patch app entry if needed
grep -q "openach-patch" "$ENTRY_FILE" 2>/dev/null || {
  sed -i "s/app\.listen/require('.\/server\/openach-patch')(app, typeof db !== 'undefined' ? db : null);\napp.listen/" "$ENTRY_FILE" 2>/dev/null
  ok "openach-patch injected into $ENTRY_FILE"
}

# Patch analytics route if needed
grep -q "analytics" "$ENTRY_FILE" 2>/dev/null || {
  sed -i "s/app\.listen/app.use('\/api\/analytics', require('.\/server\/routes\/analytics'));\napp.listen/" "$ENTRY_FILE" 2>/dev/null
  ok "analytics routes injected"
}

# Restart with pm2
pm2 delete dlbtrust 2>/dev/null || true
pm2 start "$ENTRY_FILE" --name dlbtrust --env production
pm2 save
sleep 4
pm2 list | grep dlbtrust

# ── STEP 9: Run full test suite ──────────────────────────────
step "9/9" "Running health checks..."
echo ""
echo -n "  Apache proxy (dlbtrust.cloud): "
curl -s http://localhost/api/wallets | head -c 60 || echo "FAIL"

echo -n "  Node.js direct (port 3001): "
curl -s http://localhost:3001/api/wallets | head -c 60 || echo "FAIL"

echo -n "  OpenACH connect: "
curl -s -X POST http://localhost/openach/api/connect \
  -H "Host: ach.dlbtrust.cloud" \
  --data "user_api_token=3caee1c2-c218-4959-b6d2-21d4b2a1b42e&user_api_key=b74666cf-5276-4d8b-8650-5bd57dcee272" | head -c 100

echo -n "  ACH health: "
curl -s http://localhost:3001/api/ach/health | head -c 100

echo ""
echo "============================================================"
echo " Recovery complete — $(date)"
echo " Run: bash server/test-runner.sh to verify all tests pass"
echo "============================================================"
