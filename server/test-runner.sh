#!/bin/bash
# dlbtrust.cloud — Automated Test Runner + Error Logger
# Logs all results to /tmp/dlbtrust-test-results.log

LOG=/tmp/dlbtrust-test-results.log
echo "=== dlbtrust.cloud Test Run: $(date) ===" | tee -a $LOG

PASS=0; FAIL=0

check() {
  local name="$1"; local cmd="$2"; local expect="$3"
  result=$(eval "$cmd" 2>&1 | head -c 300)
  if echo "$result" | grep -q "$expect"; then
    echo "  ✅ PASS: $name" | tee -a $LOG
    PASS=$((PASS+1))
  else
    echo "  ❌ FAIL: $name" | tee -a $LOG
    echo "     Expected: $expect" | tee -a $LOG
    echo "     Got: $result" | tee -a $LOG
    FAIL=$((FAIL+1))
  fi
}

echo "--- Service Status ---" | tee -a $LOG
check "Apache running"    "service apache2 status"         "active (running)"
check "pm2 running"       "pm2 list"                       "online"
check "Docker running"    "docker ps | grep openach"       "openach"

echo "--- API Endpoints ---" | tee -a $LOG
check "Wallets API"       "curl -s http://localhost:3000/api/wallets"   "wallet_id"
check "Transactions API"  "curl -s http://localhost:3000/api/transactions" "type"
check "ACH health"        "curl -s http://localhost:3000/api/ach/health"  "openach_connected"
check "Analytics API"     "curl -s http://localhost:3000/api/analytics/summary" "total_corpus"

echo "--- OpenACH ---" | tee -a $LOG
check "OA connect"  "curl -s -X POST http://localhost/openach/api/connect -H 'Host: ach.dlbtrust.cloud' --data 'user_api_token=3caee1c2-c218-4959-b6d2-21d4b2a1b42e&user_api_key=b74966cf-5276-4d8b-8650-5bd57dcee272'" "success.*true"

echo "" | tee -a $LOG
echo "Results: $PASS passed, $FAIL failed" | tee -a $LOG
echo "Full log: $LOG"
[ $FAIL -eq 0 ] && exit 0 || exit 1
