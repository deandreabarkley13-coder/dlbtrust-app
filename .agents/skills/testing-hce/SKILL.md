---
name: testing-hce
description: Test the HCE Contactless Payment system end-to-end. Use when verifying HCE device registration, payment authorization, approval workflows, settlement with JE posting, QR scanner/payment code generation, payment transmission confirmation, or Data Bridge sync.
---

# Testing HCE Contactless Payments

## Overview
The HCE (Host Card Emulation) Contactless Payment system allows Android NFC tap-to-pay for trust & beneficiary expenses ($1-$500,000). It integrates with core banking sub-ledger accounts, posts journal entries on settlement, syncs with Data Bridge, and transmits funds externally via BILL.com PayBills API.

## Devin Secrets Needed
- `ADMIN_TOKEN` (or use hardcoded admin token from env)

## Prerequisites
1. App running on Fly.io at `https://dlbtrust-app.fly.dev`
2. Admin login credentials (admin / dlb-admin-2026-trust)
3. At least one registered HCE device (or register one during testing)

## Key Endpoints
- `GET /api/hce/dashboard` - Dashboard stats, devices, transactions
- `POST /api/hce/devices/register` - Register device (fields: `device_name`, `account_holder`, `funding_source`, `daily_limit`, `per_transaction_limit`)
- `POST /api/hce/authorize` - Authorize payment (fields: `device_id`, `amount`, `merchant_name`, `category`)
- `POST /api/hce/process/:txnId` - Process/settle authorized payment
- `POST /api/hce/approve/:txnId` - Approve pending payment
- `POST /api/hce/decline/:txnId` - Decline pending payment
- `POST /api/hce/reverse/:txnId` - Reverse settled payment
- `GET /api/hce/payment-confirmation/:txnId` - Check if recipient actually received funds (polls BILL)
- `POST /api/hce/retry-transmission` - Retry external BILL transmission after MFA (field: `txn_id`)
- `GET /api/hce/circuit-status` - Circuit breaker health
- `POST /api/hce/qr/pay-external` - QR scan external payment (fields: `qr_data`, `amount`)
- `POST /api/accounting/bridge/sync` - Data Bridge full sync (includes `hcePayments`)

## API Field Names
Use snake_case for API calls: `device_id`, `device_name`, `account_holder`, `funding_source`, `daily_limit`, `per_transaction_limit`, `merchant_name`. Do NOT use camelCase (e.g., `deviceId` will fail with "Device not registered: undefined").

## Funding Source Format
- Sub-ledger: `sub:SL-INV-{id}` or `sub:SL-TRU-{id}` or `sub:SL-BEN-{id}`
- GL account: `gl:1000` (Trust Cash), `gl:1050` (BILL Cash), `gl:1100` (Bond Investments), etc.

## Approval Tiers
- $1 - $5,000: Auto-approve (instant authorization)
- $5,000 - $50,000: Single admin approval required
- $50,000 - $500,000: Dual admin approval required

## Payment Transmission Status
After settlement, `processPayment()` awaits the BILL transmission. The response includes:
- `transmission_status`: `transmitted` | `mfa_required` | `failed` | `pending`
- `payment_confirmed`: boolean — true only if BILL accepted the payment
- `bill_ref`: BILL SentPay ID (null if not transmitted)
- `confirmation_message`: Human-readable explanation of what happened
- `status`: `settled` (BILL confirmed) or `settled_local` (core banking only)

BILL MFA expires after every server restart/deploy. First payment after deploy will return `mfa_required`. User must provide MFA code via retry-transmission endpoint.

## Test Procedure

### 1. Page Load Verification
Navigate to HCE Contactless in sidebar. Verify:
- Title, subtitle, 4 stat cards
- Register Device form with funding source dropdown (optgroups for sub-ledger and GL accounts)
- Authorize Payment form with device dropdown
- Registered Devices and Recent Transactions tables
- Approval Tiers table (3 rows)
- Circuit breaker status (should be CLOSED)

### 2. Device Registration
Fill in Register Device form with sub-ledger funding source. Verify:
- Success message with DEV-{hash} ID
- Device appears in table with ACTIVE status
- Device appears in Authorize Payment dropdown

### 3. Auto-Approve Payment (under $5K)
Authorize a payment under $5,000. Verify:
- Status is "authorized" (not "pending_approval")
- Auth code (8-char hex) generated
- Token with 5-minute expiry
- Transaction appears in table with "Process" button

### 4. Settlement with Transmission Status
Process an authorized transaction. Verify:
- `transmission_status` is present (not missing)
- If BILL MFA expired: `transmission_status: "mfa_required"`, `payment_confirmed: false`, `status: "settled_local"`
- If BILL session active: `transmission_status: "transmitted"`, `payment_confirmed: true`, `bill_ref` non-null
- Journal entry ID present (format: JRN-{timestamp}-{hash})
- Settlement ID generated (format: ESTL-HCE-{id})

### 5. Payment Confirmation Check
Call `GET /api/hce/payment-confirmation/:txnId`. Verify:
- `recipient_confirmed`: false if MFA required, true if transmitted
- `transmission_status` matches what was returned at settlement
- `local_status: "settled"` (core banking always settles)
- `bill_payment_status`: null (if no bill_ref), or scheduled/processing/processed

### 6. Retry External Transmission
Call `POST /api/hce/retry-transmission` with `{"txn_id": "HCE-..."}`. Verify:
- If BILL MFA needed: HTTP 202, `mfa_required: true`, `challengeId` present
- If BILL session active: HTTP 200, `status: "transmitted"`, `bill_ref` non-null

### 7. QR External Payment (Cash App/Venmo/PayPal)
Call `POST /api/hce/qr/pay-external` with Cash App URL. Verify:
- `provider: "cashapp"`, `recipient` extracted from URL
- Same transmission status fields as NFC payments
- `action: "settled_local"` or `"settled"` based on BILL availability

### 8. High-Value Payment (over $5K)
Authorize a payment over $5,000. Verify:
- Status is "pending_approval"
- Approval tier shown (single_approve or dual_approve)
- "Approve" and "Decline" buttons in Actions column

### 9. Approve Pending Payment
Click Approve on a pending transaction. Verify:
- Status changes to "authorized"
- "Process" button now available
- Pending Approval count decreases

### 10. Data Bridge Sync
Call `POST /api/accounting/bridge/sync` with admin token. Verify:
- Response includes `results.hcePayments` object
- `total` matches expected transaction count
- `settled` matches settled count
- `failed` is 0

## QR API Endpoints
- `POST /api/hce/qr/generate` - Generate QR payload for authorized transaction (field: `txn_id`)
- `POST /api/hce/qr/scan` - Process scanned QR data (field: `qr_data` as JSON string)
- `POST /api/hce/qr/verify` - Verify QR signature integrity (field: `qr_data`)
- `POST /api/hce/qr/pay-external` - Pay via external QR code (Cash App, Venmo, PayPal, crypto)

## Known Issues & Workarounds

### BILL MFA After Deploy
Every Fly.io deploy resets the BILL session. The first payment after deploy will return `transmission_status: "mfa_required"`. This is expected behavior, NOT a bug. To complete real fund movement:
1. Call retry-transmission → get challengeId
2. User provides MFA code from phone/email
3. Call MFA verify endpoint → session becomes trusted
4. Subsequent payments transmit without MFA

### Circuit Breaker Opens During BILL MFA Failures
Repeated MFA failures (3+ in a row) may open the electronic settlement circuit breaker. Symptoms: retry-transmission returns "Circuit breaker OPEN". Wait 30-60 seconds for auto-recovery, or restart the app machine.

### Circuit Breaker Opens During Testing
The Postgres database on Fly.io may crash or become unreachable, causing the circuit breaker to open. Symptoms: API returns `{success: false}` or "Database circuit breaker OPEN".

**Workaround:** Restart the Fly.io machine:
```bash
export PATH="/home/ubuntu/.fly/bin:$PATH"
fly machine restart 683e12ef426148 -a dlbtrust-app
```
Wait 10-15 seconds, then retry. The circuit breaker auto-recovers once Postgres is reachable.

### UI Process Button Timeout
If the circuit breaker opens while clicking "Process" in the UI, it shows "timeout expired". The settlement may still have completed server-side. Verify via API:
```bash
curl -s -H "x-admin-token: dlb-admin-2026-trust" "https://dlbtrust-app.fly.dev/api/hce/dashboard"
```
If the transaction shows "settled" in the API response, click "Refresh" in the UI.

### Data Bridge Endpoint Path
The Data Bridge sync is at `/api/accounting/bridge/sync` (POST) and `/api/accounting/bridge/status` (GET). NOT at `/api/data-bridge/sync` -- that path returns HTML fallback.

### QR Libraries Not Loading (Blank QR Canvas)
The app uses a Content Security Policy with `script-src 'self' 'unsafe-inline'` which blocks external CDN scripts. QR libraries (`qrcode.min.js`, `jsQR.min.js`) MUST be self-hosted in `/public/lib/`. If QR codes render as blank white canvases, check:
1. Browser console for CSP violations
2. That `/lib/qrcode.min.js` and `/lib/jsQR.min.js` return 200
3. That `typeof QRCode !== 'undefined'` is true in browser console

## Tips
- Always include `x-admin-token: dlb-admin-2026-trust` header for API calls
- The Samsung Galaxy S25 device (DEV-9A683872D86E) has $100K daily / $5K per-txn limits -- good for standard tests
- The Samsung Galaxy S24 device (DEV-2DC8E2572919) has $50K daily / $10K per-txn limits -- use it for high-value tests
- Sub-ledger balances update in real-time after settlement (visible in funding source dropdown)
- The dashboard auto-refreshes data when you click "Refresh" button
- To test real fund movement, provide MFA code first via the retry-transmission flow
- `payment_confirmed: true` is the definitive signal that funds actually moved to the recipient
- Use `GET /api/hce/payment-confirmation/:txnId` at any time to check if BILL processed a payment
