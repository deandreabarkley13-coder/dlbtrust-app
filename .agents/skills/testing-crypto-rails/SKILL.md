---
name: testing-crypto-rails
description: Test the Crypto Rails / Private Blockchain Stack feature end-to-end. Use when verifying blockchain wallet creation, USDC transfers, provider switching, or RPC connectivity.
---

# Testing Crypto Rails / Private Blockchain Stack

## Prerequisites

- Server running on port 3001: `PORT=3001 node app.js`
- Database at `data/dlbtrust.db` (SQLite)
- No API keys needed for Private Stack testing (uses public Polygon Amoy RPC)

## Devin Secrets Needed

None required for Private Stack testing. Circle API testing requires `CIRCLE_API_KEY` (org secret).

## How to Start the App

```bash
cd /home/ubuntu/repos/dlbtrust-app
PORT=3001 node app.js
```

Navigate to `http://localhost:3001` → Click "Crypto Rails" in sidebar.

## Key Test Scenarios

### 1. Provider Default & RPC Connectivity
- Verify dropdown shows "Private Stack (No API Key)" by default
- Click "Test RPC" → expect toast with "Block #" (number > 30M for Polygon Amoy)
- Status bar should show: Network: Polygon Amoy, Status: Connected, USDC contract address

### 2. Wallet Creation
- Click "+ New Wallet" → fill name, select blockchain (Polygon Amoy)
- Expect: 42-char 0x address, "PRIVATE" badge (not "CIRCLE"), Polygonscan link
- Verify via API: `curl -s http://localhost:3001/api/blockchain/wallets | python3 -m json.tool`
- CRITICAL: Response must NOT contain `encrypted_private_key` field
- Verify DB has key: `node -e "const db = require('better-sqlite3')('data/dlbtrust.db'); console.log(db.prepare('SELECT length(encrypted_private_key) as len FROM blockchain_wallets').all());"`

### 3. USDC Transfer Threshold Enforcement
- Threshold is $10,000 (configurable via `approval_threshold` in config)
- Below threshold ($5K): Status should be `initiated`, toast says "queued locally"
- Above threshold ($25K): Status should be `pending_approval`, "Approve" button visible
- Use test address: `0x1234567890abcdef1234567890abcdef12345678`

### 4. Provider Switching
- Switch dropdown from "Private Stack" to "Circle API (Fallback)"
- Expect: Status → "Not Connected", "Test RPC" button disappears
- Switch back: Status → "Connected", "Test RPC" button reappears
- Both switches should trigger toast confirmation messages

### 5. Wallet Sync
- Click "Sync" on wallet card
- Should complete without error (even if balance is $0.00)
- Verifies RPC query uses wallet's own blockchain (not global default)

## Tips & Gotchas

- The Send USDC modal retains previous form values after submission. When testing multiple sends, verify the amount field is updated.
- Wallet dropdown in Send modal might not respond to native clicks — use browser console: `document.querySelector('[devinid="23"]').value = '1'; document.querySelector('[devinid="23"]').dispatchEvent(new Event('change'));`
- Private wallets have `circle_wallet_id` starting with `private_` prefix (not `local_`)
- The `insert` CI job always fails (preexisting Docker SSH issue) — only `validate` matters
- Transactions are queued locally since wallet has no real USDC — this is expected behavior
- RPC endpoints are public and free — no rate limiting issues for testing

## API Endpoints for Verification

```bash
# List wallets (no key leak)
curl -s http://localhost:3001/api/blockchain/wallets | python3 -m json.tool

# Check provider status
curl -s http://localhost:3001/api/blockchain/status | python3 -m json.tool

# RPC ping
curl -s http://localhost:3001/api/blockchain/rpc-ping | python3 -m json.tool

# List transactions
curl -s http://localhost:3001/api/blockchain/transactions | python3 -m json.tool
```
