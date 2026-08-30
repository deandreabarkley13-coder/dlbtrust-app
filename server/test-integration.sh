#!/bin/bash
# dlbtrust.cloud — Integration Test Script
# Tests all major endpoints and OpenACH API connectivity

echo "=== dlbtrust.cloud Integration Test ==="
echo "Time: $(date)"
echo ""

if [ -z "$OPENACH_API_TOKEN" ] || [ -z "$OPENACH_API_KEY" ]; then
  echo "Set OPENACH_API_TOKEN and OPENACH_API_KEY before running (e.g. set -a; . .env; set +a)."
  exit 1
fi
OPENACH_CREDS="user_api_token=$OPENACH_API_TOKEN&user_api_key=$OPENACH_API_KEY"

echo "1. Wallets endpoint:"
curl -s --max-time 10 https://dlbtrust.cloud/api/wallets | python3 -m json.tool 2>/dev/null | head -10 || echo "   FAILED or not JSON"
echo ""

echo "2. OpenACH API connect (external via HTTPS):"
curl -s --max-time 10 -X POST https://ach.dlbtrust.cloud/openach/api/connect \
  --data "$OPENACH_CREDS" \
  -c /tmp/oa_test_cookies.txt
echo ""
echo ""

echo "3. OpenACH API connect (via localhost HTTP — server-side test):"
curl -s --max-time 10 -X POST http://localhost/openach/api/connect \
  -H "Host: ach.dlbtrust.cloud" \
  --data "$OPENACH_CREDS" \
  -c /tmp/oa_test_cookies_local.txt
echo ""
echo ""

echo "4. ACH health check:"
curl -s --max-time 10 https://dlbtrust.cloud/api/ach/health
echo ""
echo ""

echo "5. Payment types (using session from step 2):"
SESSION=$(curl -s --max-time 10 -X POST https://ach.dlbtrust.cloud/openach/api/connect \
  --data "$OPENACH_CREDS" \
  2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null)

if [ -n "$SESSION" ]; then
  echo "   Session: $SESSION"
  curl -s --max-time 10 -X POST https://ach.dlbtrust.cloud/openach/api/getPaymentTypes \
    -H "Cookie: PHPSESSID=$SESSION"
  echo ""
  # Disconnect
  curl -s --max-time 5 -X POST https://ach.dlbtrust.cloud/openach/api/disconnect \
    -H "Cookie: PHPSESSID=$SESSION" > /dev/null
else
  echo "   Could not get session - testing via app endpoint instead"
  curl -s --max-time 10 https://dlbtrust.cloud/api/ach/payment-types
fi
echo ""
echo ""

echo "6. pm2 status:"
pm2 status 2>/dev/null || echo "   pm2 not running or not installed"
echo ""

echo "=== Test complete ==="
