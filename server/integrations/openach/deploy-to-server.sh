#!/bin/bash
# =============================================================================
# Deploy OpenACH integration to IONOS server
# Run from local machine: bash deploy-to-server.sh
# Requires: ssh root access to 74.208.191.205
# =============================================================================

SERVER="root@74.208.191.205"
APP_DIR="/var/www/vhosts/dlbtrust.cloud/httpdocs"   # adjust if different

echo "=== Deploying OpenACH integration to dlbtrust.cloud ==="

# 1. Copy integration files to server
echo "[1] Uploading OpenACH client and routes..."
ssh $SERVER "mkdir -p $APP_DIR/server/integrations/openach $APP_DIR/server/routes"

scp server/integrations/openach/openachClient.js  $SERVER:$APP_DIR/server/integrations/openach/
scp server/routes/payments.js                      $SERVER:$APP_DIR/server/routes/
scp server/integrations/openach/db-migration.sql   $SERVER:$APP_DIR/server/integrations/openach/

# 2. Run DB migration
echo "[2] Running DB migration..."
ssh $SERVER "cd $APP_DIR && sqlite3 dlbtrust.db < server/integrations/openach/db-migration.sql && echo 'Migration OK'"

# 3. Add payment routes to main server.js
echo "[3] Checking if payment routes are registered in server.js..."
ssh $SERVER "grep -q 'payments' $APP_DIR/server.js && echo 'Routes already registered' || echo 'ADD THIS LINE to server.js: app.use(\"/api/payments\", require(\"./server/routes/payments\"));'"

# 4. Restart Node app
echo "[4] Restarting Node.js application..."
ssh $SERVER "cd $APP_DIR && pm2 restart dlbtrust 2>/dev/null || pm2 restart all 2>/dev/null || node server.js &"

echo ""
echo "=== Deploy complete ==="
echo "Test with: curl https://dlbtrust.cloud/api/payments/health"
