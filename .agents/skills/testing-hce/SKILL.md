---
name: testing-hce
description: Test the HCE Contactless Payment system end-to-end. Use when verifying HCE device registration, payment authorization, approval workflows, settlement with JE posting, QR scanner/payment code generation, or Data Bridge sync.
---

# Testing HCE Contactless Payments

## Overview
The HCE (Host Card Emulation) Contactless Payment system allows Android NFC tap-to-pay for trust & beneficiary expenses ($1-$500,000). It integrates with core banking sub-ledger accounts, posts journal entries on settlement, and syncs with Data Bridge.

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
- `GET /api/hce/circuit-status` - Circuit breaker health
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

### 4. Settlement (Process Payment)
Click Process on an authorized transaction. Verify:
- Status changes to "settled"
- Journal entry ID is NOT "n/a" (format: JRN-{timestamp}-{hash})
- Settlement ID generated (format: ESTL-HCE-{id})
- "Reverse" button replaces "Process"
- Settled count and volume stats update
- Sub-ledger balance decreases by payment amount

### 5. High-Value Payment (over $5K)
Authorize a payment over $5,000. Verify:
- Status is "pending_approval"
- Approval tier shown (single_approve or dual_approve)
- "Approve" and "Decline" buttons in Actions column

### 6. Approve Pending Payment
Click Approve on a pending transaction. Verify:
- Status changes to "authorized"
- "Process" button now available
- Pending Approval count decreases

### 7. Data Bridge Sync
Call `POST /api/accounting/bridge/sync` with admin token. Verify:
- Response includes `results.hcePayments` object
- `total` matches expected transaction count
- `settled` matches settled count
- `failed` is 0

### 8. QR Scanner UI Elements
Navigate to HCE page and scroll to QR section. Verify:
- QR Scanner card with "Start Camera Scanner" button
- Manual paste input with placeholder "Paste QR JSON data..."
- "Process" button next to manual input
- QR Payment Code card with transaction dropdown and "Generate QR Code" button

### 9. Inline QR Code After Authorization
Authorize a payment under $5K. Verify:
- QR Payment Code canvas renders INSIDE the success alert
- Canvas shows black squares on white background (not blank)
- Text "Present this QR code at the payment terminal" below canvas
- The newly authorized transaction appears in the QR Payment Code dropdown

### 10. Generate QR Code for Existing Transaction
In QR Payment Code card, select an authorized transaction and click "Generate QR Code". Verify:
- QR code canvas renders with visible pattern
- Text "Scan this code at the terminal — expires in 5 minutes"
- "Copy QR Data" button visible

### 11. Process Payment via Manual QR Scan
1. Get QR payload via API: `POST /api/hce/qr/generate` with `{"txn_id": "HCE-..."}`
2. Copy `qr_payload` value from response
3. Paste into manual input field on QR Scanner card
4. Click "Process"
Verify:
- Green alert: "Payment Processed via QR!"
- Shows Txn ID, Auth code, JE reference (NOT "n/a"), Settlement ID
- Transaction status changes to "settled" in table
- Settled count and volume stats increase

## QR API Endpoints
- `POST /api/hce/qr/generate` - Generate QR payload for authorized transaction (field: `txn_id`)
- `POST /api/hce/qr/scan` - Process scanned QR data (field: `qr_data` as JSON string)
- `POST /api/hce/qr/verify` - Verify QR signature integrity (field: `qr_data`)

## Known Issues & Workarounds

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

**Workaround if broken:** Download libraries and place in `public/lib/`:
```bash
curl -sL "https://cdn.jsdelivr.net/npm/qrcode@1.5.1/build/qrcode.min.js" -o public/lib/qrcode.min.js
curl -sL "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js" -o public/lib/jsQR.min.js
```
Update `dashboard.html` script tags to reference `/lib/qrcode.min.js` and `/lib/jsQR.min.js`.

## Tips
- Always include `x-admin-token: dlb-admin-2026-trust` header for API calls
- The Samsung Galaxy S25 device (DEV-9A683872D86E) has $100K daily / $5K per-txn limits -- good for standard tests
- The Samsung Galaxy S24 device (DEV-2DC8E2572919) has $50K daily / $10K per-txn limits -- use it for high-value tests
- Sub-ledger balances update in real-time after settlement (visible in funding source dropdown)
- The dashboard auto-refreshes data when you click "Refresh" button
- For QR scan testing, use the API to generate the payload then paste into manual input -- camera scanner requires physical device
