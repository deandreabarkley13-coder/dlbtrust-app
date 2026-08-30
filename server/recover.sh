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

# OpenACH is no longer hosted here: it runs as the `openach` service in the
# Northflank project (openach/Dockerfile), reached over OPENACH_BASE_URL.

# ── STEP 4: Rebuild Apache config ───────────────────────────
step "4/9" "Rebuilding Apache configuration via Plesk..."
/usr/local/psa/admin/sbin/httpdmng --reconfigure-domain dlbtrust.cloud 2>/dev/null && ok "dlbtrust.cloud reconfigured" || err "httpdmng failed — manual reload needed"
apache2ctl configtest 2>&1 | tail -2
service apache2 reload && ok "Apache reloaded" || service apache2 restart && ok "Apache restarted"

# ── STEP 5: Fix SSL cert ─────────────────────────────────────
step "5/9" "Checking SSL certificates..."
certbot certificates 2>/dev/null | grep -A3 "dlbtrust.cloud" || echo "certbot not found or no certs"
# Try renew if expired
certbot renew --quiet 2>/dev/null && ok "Certs renewed" || ok "Certs up to date or manual renewal needed"

# ── STEP 6: Check the OpenACH service ───────────────────────
step "6/9" "Checking the OpenACH service..."
if [ -n "$OPENACH_BASE_URL" ]; then
  curl -s -o /dev/null -w "  HTTP %{http_code} from $OPENACH_BASE_URL\n" --max-time 10 \
    -X POST "$OPENACH_BASE_URL/connect" || err "OpenACH unreachable"
else
  err "OPENACH_BASE_URL is unset — point it at the Northflank openach service"
fi

# ── STEP 7: Check the OpenACH API credential ─────────────────
# Recovery does not mint credentials: provisioning one is an explicit operator
# step (server/integrations/openach/server-side-setup.js) so that no token or key
# ever lives in this script.
step "7/9" "Checking OpenACH API credential..."
if [ -n "$OPENACH_API_TOKEN" ] && [ -n "$OPENACH_API_KEY" ]; then
  ok "OpenACH credential present in the environment"
else
  err "No OPENACH_API_TOKEN / OPENACH_API_KEY — run server/integrations/openach/server-side-setup.js"
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

# Set .env — the api credential itself is provisioned separately, by
# server/integrations/openach/server-side-setup.js, and never written from here.
grep -q "OPENACH_BASE_URL" .env 2>/dev/null || cat >> .env << 'ENVEOF'
# api base of the Northflank openach service, e.g.
# https://p01--openach--<project-hash>.code.run/api
OPENACH_BASE_URL=
PORT=3001
ENVEOF
grep -q "OPENACH_API_TOKEN" .env 2>/dev/null \
  || ok "OPENACH_API_TOKEN not in .env — run server/integrations/openach/server-side-setup.js"
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
if [ -n "$OPENACH_API_TOKEN" ] && [ -n "$OPENACH_API_KEY" ] && [ -n "$OPENACH_BASE_URL" ]; then
  curl -s -X POST "$OPENACH_BASE_URL/connect" \
    --data "user_api_token=$OPENACH_API_TOKEN&user_api_key=$OPENACH_API_KEY" | head -c 100
else
  echo "SKIPPED (OPENACH_BASE_URL / credential not in the environment)"
fi

echo -n "  ACH health: "
curl -s http://localhost:3001/api/ach/health | head -c 100

echo ""
echo "============================================================"
echo " Recovery complete — $(date)"
echo " Run: bash server/test-runner.sh to verify all tests pass"
echo "============================================================"
