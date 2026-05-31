---
name: testing-route-validation
description: Test route input validation, HTTP status codes, error responses, and security fixes end-to-end. Use when verifying API route changes.
---

# Testing Route Validation & Security Fixes

## Overview
This skill covers end-to-end testing of Express route validation, HTTP status codes, credential leak prevention, and SQL injection fixes via curl against locally running servers.

## Setup

### Install Dependencies
```bash
cd /home/ubuntu/repos/dlbtrust-app && npm install
```

### Create Test Database
The analytics routes require `server/routes/trust.db` and `api-routes-patched.cjs` requires `server/data.db`. Create minimal test DBs:

```bash
node -e "
const Database = require('better-sqlite3');
const path = require('path');

// Analytics DB
const db1 = new Database(path.join(__dirname, 'server', 'routes', 'trust.db'));
db1.exec('CREATE TABLE IF NOT EXISTS wallets (id INTEGER PRIMARY KEY, wallet_id TEXT, name TEXT, role TEXT, fiat_balance INTEGER DEFAULT 0, currency TEXT DEFAULT \"USD\", status TEXT DEFAULT \"active\", email TEXT, phone TEXT, holder_name TEXT, public_address TEXT, routing_number TEXT, account_number TEXT)');
db1.exec('CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY, wallet_id INTEGER, type TEXT, amount INTEGER, balance_before INTEGER, balance_after INTEGER, description TEXT, counterparty_wallet_id INTEGER, reference_id TEXT, status TEXT DEFAULT \"completed\", created_at TEXT DEFAULT (datetime(\"now\")), category TEXT, payment_method TEXT, from_wallet_id TEXT, to_wallet_id TEXT)');
db1.close();

// Patched routes DB
const db2 = new Database(path.join(__dirname, 'server', 'data.db'));
db2.exec('CREATE TABLE IF NOT EXISTS trust_profile (id INTEGER PRIMARY KEY, name TEXT)');
db2.exec('CREATE TABLE IF NOT EXISTS wallets (id INTEGER PRIMARY KEY, name TEXT, balance INTEGER DEFAULT 0)');
db2.exec('CREATE TABLE IF NOT EXISTS distributions (id INTEGER PRIMARY KEY, name TEXT, amount INTEGER)');
db2.exec('CREATE TABLE IF NOT EXISTS distribution_items (id INTEGER PRIMARY KEY, distribution_id INTEGER, description TEXT)');
db2.exec('CREATE TABLE IF NOT EXISTS ledger_entries (id INTEGER PRIMARY KEY, created_at TEXT DEFAULT (datetime(\"now\")))');
db2.exec('CREATE TABLE IF NOT EXISTS bonds (id INTEGER PRIMARY KEY, name TEXT)');
db2.exec(\"INSERT OR IGNORE INTO distributions (id, name, amount) VALUES (1, 'Test', 5000)\");
db2.close();
console.log('Test DBs created');
"
```

### Start Servers
The app has multiple server entry points. Start them on separate ports:

| Server | Port | Command | Routes Covered |
|--------|------|---------|----------------|
| app.js (main) | 3001 | `node app.js` | `/api/ach/*`, `/api/analytics/*` |
| server-proxy.js | 3003 | `node server/server-proxy.js` | Proxy `/api/ach/health` |
| payments (inline) | 4001 | See below | `/api/payments/*` |
| api-routes-patched | 4002 | See below | `/api/wallets/*`, `/api/distributions/*`, `/api/gateway/*` |

For payments and patched routes, mount them on throwaway Express servers:
```bash
# Payments
node -e "const e=require('express')();e.use(require('express').json());e.use('/api/payments',require('./server/routes/payments'));e.listen(4001)" &

# Patched routes
node -e "const e=require('express')();e.use(require('express').json());require('./server/api-routes-patched.cjs')(e);e.listen(4002)" &
```

## Key Test Patterns

All testing is curl-based (no GUI recording needed). Use `-w "\nHTTP_STATUS:%{http_code}"` to capture status codes.

### Input Validation (expect 400)
- Send empty body `{}` to POST endpoints → should get 400 with `success:false` and field list
- Send invalid format values (e.g., 5-digit routing number, non-Checking/Savings account type, negative amounts, invalid dates)
- Send non-numeric IDs to param routes (e.g., `/schedules/abc`)

### Query Param Validation
- Invalid dates: `?from=not-a-date` → 400
- Invalid year: `?year=abcd` → 400
- Limit/offset clamping: `?limit=5000` should clamp to 1000, `?offset=-10` should clamp to 0 (check `page` field in response JSON)

### Security
- Health endpoints must NOT contain `api_token` or `originator_id` in response JSON
- SQL injection: `GET /distributions/1%20OR%201=1` should return only id=1 (parseInt + parameterized query neutralizes injection)

### HTTP Status Codes
- Missing env vars (e.g., OPENACH_API_TOKEN) → 503 (not 200)
- DB errors → 500 (not 200)
- Input validation failures → 400 (not 500)

## Known Limitations
- `server-3002-minimal.js` requires Plesk production paths — can only syntax-check with `node -c`
- `server-standalone.js` requires production trust.db path — syntax-check only
- `openach-patch.js` container name validation requires running Docker/OpenACH — syntax-check only
- Analytics routes fail with 500 if `trust.db` doesn't exist, blocking validation tests. Always create the test DB first.

## CI Notes
- `validate` job: Runs syntax/lint checks — should pass
- `insert` job: SSHes into production to insert OpenACH Docker creds. May fail if `openach-web-1` container doesn't exist on the server. This is an infrastructure issue, not a code issue.

## Devin Secrets Needed
None required for local testing. OpenACH env vars (`OPENACH_API_TOKEN`, `OPENACH_API_KEY`) are optional — tests verify the 503 error response when they're missing.
