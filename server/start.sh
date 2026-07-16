#!/bin/bash
# dlbtrust.cloud — Server Startup Script
# Pulls latest code, installs deps, and restarts via pm2

set -e

APP_DIR="/var/www/vhosts/dlbtrust.cloud/httpdocs"

echo "============================================================"
echo " dlbtrust.cloud — Start / Restart"
echo "============================================================"

cd "$APP_DIR"

echo "[1] Pulling latest code from GitHub..."
git pull origin main || echo "    git pull failed — continuing with local files"

echo "[2] Installing dependencies..."
npm install --production

echo "[3] Restarting app with pm2..."
pm2 delete dlbtrust 2>/dev/null || true
pm2 start app.js --name dlbtrust --env production

echo "[4] Saving pm2 config..."
pm2 save

sleep 3

echo "[5] Recent logs:"
pm2 logs dlbtrust --lines 20 --nostream

echo ""
echo "[6] Process status:"
pm2 status dlbtrust

echo "============================================================"
echo " Done. Run: curl https://dlbtrust.cloud/api/ach/health"
echo "============================================================"
