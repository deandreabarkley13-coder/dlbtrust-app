---
name: testing-ach-pipeline
description: Test the ACH pipeline lifecycle endpoints end-to-end. Use when verifying ACH batch creation, state transitions, returns, acknowledgements, reconciliation, or dashboard metrics.
---

# Testing ACH Pipeline

## Overview
The ACH pipeline lives at `/api/ach-pipeline` (mounted in `server/server-3002.js`). It handles NACHA file generation, AS2 transmission, and the full settlement lifecycle.

## Local Setup

1. Start PostgreSQL:
   ```bash
   sudo pg_ctlcluster 14 main start
   ```

2. Ensure trust auth for localhost connections in `/etc/postgresql/14/main/pg_hba.conf`, or use:
   ```bash
   PGPASSWORD=postgres psql -U postgres -h localhost
   ```

3. Create the database and run migrations:
   ```bash
   PGPASSWORD=postgres psql -U postgres -h localhost -c "CREATE DATABASE fineract_tenants;"
   PGPASSWORD=postgres psql -U postgres -h localhost -d fineract_tenants -f server/scripts/migrate-ach.sql
   ```

4. Start the server:
   ```bash
   PGPASSWORD=postgres FINERACT_DB_HOST=localhost FINERACT_DB_USER=postgres FINERACT_DB_PASSWORD=postgres ADMIN_SECRET_TOKEN=test-admin-token-123 PORT=3002 node server/server-3002.js
   ```
   Verify: `[ach-pipeline] loaded` appears in console output.

## Authentication

All POST routes on `/api/ach-pipeline` require admin authentication via the `x-admin-token` header (value must match `ADMIN_SECRET_TOKEN` env var). GET routes are public.

```bash
# Authenticated request example
curl -X POST http://localhost:3002/api/ach-pipeline/batches \
  -H "Content-Type: application/json" \
  -H "x-admin-token: test-admin-token-123" \
  -d '{"entries":[...]}'

# Unauthenticated POST returns 401:
# {"success":false,"error":"Admin authentication required. Provide x-admin-token header."}
```

## Key Endpoints

### Existing (batch creation & transmission) — require auth
- `POST /api/ach-pipeline/batches` — create batch
- `POST /api/ach-pipeline/batches/:id/transmit` — transmit via AS2
- `GET /api/ach-pipeline/batches/:id` — get batch with entries (public)
- `GET /api/ach-pipeline/status` — pipeline status (public)

### Lifecycle (acceptance, settlement, returns)
- `POST /api/ach-pipeline/batches/:id/accept` — mark batch accepted
- `POST /api/ach-pipeline/batches/:id/settle` — mark batch settled
- `POST /api/ach-pipeline/batches/:id/returns` — process returns for entries
- `GET /api/ach-pipeline/batches/:id/entries` — entry-level statuses
- `GET /api/ach-pipeline/batches/:id/returns` — return history
- `GET /api/ach-pipeline/batches/:id/acknowledgements` — ack history

### Acknowledgement ingestion
- `POST /api/ach-pipeline/acknowledgements/mdn` — AS2 MDN receipts
- `POST /api/ach-pipeline/acknowledgements/file-ack` — bank file acks
- `POST /api/ach-pipeline/acknowledgements/bank-ack` — bank batch acks

### Reconciliation
- `POST /api/ach-pipeline/reconciliation/run` — trigger reconciliation
- `GET /api/ach-pipeline/reconciliation/history` — list runs
- `GET /api/ach-pipeline/reconciliation/:id` — get specific run
- `GET /api/ach-pipeline/settlement/status` — settlement overview

### AS2 Setup & Credential Management (admin-only)
- `GET /api/ach-pipeline/as2/setup` — get saved AS2 config (secrets redacted)
- `POST /api/ach-pipeline/as2/setup` — save partner URL, AS2 IDs, certificates
- `GET /api/ach-pipeline/as2/validate` — check if config is complete for transmission
- `POST /api/ach-pipeline/as2/generate-cert` — generate self-signed RSA keypair
- `POST /api/ach-pipeline/as2/load-saved` — reload saved config from DB into env

### Dashboard
- `GET /api/ach-pipeline/payment-summary` — full metrics including accepted/settled/returned

### Multi-Partner Management
- `GET /api/ach-pipeline/partners` — list all partners (public)
- `POST /api/ach-pipeline/partners` — register new partner (admin)
- `GET /api/ach-pipeline/partners/:id` — get partner details (public)
- `GET /api/ach-pipeline/partners/:id/validate` — check partner readiness (public)
- `POST /api/ach-pipeline/partners/:id/test` — test partner connectivity (admin)
- `DELETE /api/ach-pipeline/partners/:id` — deactivate partner (admin)
- `POST /api/ach-pipeline/partners/:id/activate` — reactivate partner (admin)

### API Credentials
- `GET /api/ach-pipeline/credentials?active=true` — list active credentials (admin)
- `POST /api/ach-pipeline/credentials` — generate new key pair (admin)
- `POST /api/ach-pipeline/credentials/:keyId/rotate` — rotate credential (admin)
- `DELETE /api/ach-pipeline/credentials/:keyId` — revoke credential (admin)

### HTTPS Receive Endpoint
- `POST /api/ach-pipeline/receive` — accept NACHA file via HTTPS (admin auth)

### File Exports
- `GET /api/ach-pipeline/exports` — list exported NACHA files (admin)

## Testing Strategy

### Testing Dashboard UI
The dashboard is at `http://localhost:3002/dashboard.html`. To test UI features:

1. **Set admin token in browser**: Open browser console and run:
   ```js
   localStorage.setItem('dlb_admin_token', 'test-admin-token-123');
   ```
   Then refresh. The dashboard JS uses this token for all authenticated API calls via `adminHeaders()`.

2. **Dashboard navigation**: Sidebar nav items use `data-page` attribute. Key pages:
   - `ach` — ACH Pipeline (has Batches/Exported Files tabs)
   - `partners` — Partner Management
   - `apikeys` — API Credentials

3. **Partners page assertions**:
   - Summary cards show Total Partners, REST API count, AS2 count, Default partner name
   - Table shows partner_id, name, protocol badge (REST_API/AS2), URL, DEFAULT badge, ACTIVE status
   - Each row has Details, Test, Deactivate buttons
   - "+ Register Partner" button toggles form with fields: Partner ID, Name, Protocol, URL, API Key, API Secret, Auth Type, Default
   - "Details" button shows partner detail card with validation readiness (READY/NOT READY badge)

4. **API Keys page assertions**:
   - Summary cards show Active Keys and Total Issued counts
   - Table shows key_id, label, key preview (`dlb_key_...`), scope badges, last used, expires, status, Rotate/Revoke buttons
   - Generate form has Label input and Expiry dropdown (Never/30d/90d/1y)
   - After generation: key_id, api_key (`dlb_key_*`), api_secret (`dlb_secret_*`) shown in red with "Save the secret now" warning
   - Usage reference table shows Bearer, API Key, Admin Token patterns

5. **ACH Pipeline page assertions**:
   - Summary cards: Total Batches, Transmitted, Settled (with rate %), Returned (with rate %), Total Disbursed ($)
   - Tabs: "Batches" (default active) and "Exported Files"
   - Batches table has Partner column showing partner IDs
   - Status badges: pending=green, transmitted=purple, accepted=blue, settled=green, returned=red, failed=red
   - Pending batches show "Transmit" button; all batches show "NACHA" download link
   - Exported Files tab shows file list or empty state message

### HTTPS Default Transmission Mode
As of PR #104, the default transmission mode is `remote` (HTTPS REST API), not `direct` (local file save). When a batch is transmitted without a configured external partner URL, the system auto-upgrades to HTTPS self-transmit:
- `OpenBankApi.transmit()` calls `_getSelfUrl()` which returns the platform's own URL (from `APP_URL`, `DEPLOY_URL`, or `http://localhost:PORT`)
- The NACHA file is POSTed to `POST /api/ach-pipeline/receive` on the same server
- The `/receive` endpoint validates the NACHA structure, exports the file to `/data/ach-exports/`, and returns a receipt
- The transmit alert in the dashboard shows `Mode: remote` (not `Mode: direct`)

To verify HTTPS mode is working:
1. Create a batch and transmit it
2. The alert should show `Mode: remote` with a `REQ-` message ID
3. Check `/data/ach-exports/DLBTRUST-DIRECT/<date>/` for the exported .ach file

**Note:** The Exported Files tab in the dashboard might show "No exported files yet" even though files exist on disk — this is a known issue with the exports listing endpoint, not with the transmission itself.

### Admin Auth Status Banner
The Admin Controls page (`admin` nav item) shows an auth status banner:
- **No token set**: Amber-bordered banner with "Authentication required" text, System Health shows error prompt
- **Token set**: Green-bordered banner with "Authenticated" text, System Health loads with PostgreSQL status
- To test: clear `localStorage.removeItem('dlb_admin_token')`, refresh, navigate to Admin Controls
- To set token via UI: type in Token input field, click "Set Token"

### Simulating Transmission (Legacy)
If you need to bypass actual transmission and set status directly:
```bash
PGPASSWORD=postgres psql -U postgres -h localhost -d fineract_tenants -c \
  "UPDATE ach_batches SET status = 'transmitted', transmitted_at = NOW() WHERE batch_id = 'ACH-xxx';"
PGPASSWORD=postgres psql -U postgres -h localhost -d fineract_tenants -c \
  "UPDATE ach_entries SET status = 'transmitted' WHERE batch_id = 'ACH-xxx';"
```

### State Machine Rules
- `accept`: only from `transmitted`
- `settle`: only from `accepted` or `transmitted`
- `returns`: only from `transmitted`, `accepted`, or `settled`
- Auto-transition: if ALL entries in a batch are returned, batch auto-transitions to `returned`

### Test Assertions
- Verify `accepted_at`, `settled_at`, `returned_at` timestamps are set
- Verify `settlement_date` matches what was passed
- Verify entry-level `status` propagates correctly
- Verify invalid transitions return `success: false` with descriptive errors
- Verify partial returns don't transition the batch
- Verify MDN ingestion auto-accepts the batch

### Testing AS2 Setup Flow
To test the AS2 credential management cycle:
1. `POST /as2/generate-cert` — generates signing keypair
2. `POST /as2/setup` with `partnerUrl` and `partnerAs2Id` — saves config to DB and updates runtime env
3. `GET /as2/config` — verify runtime AS2Client config was updated (proves `reloadConfig()` works)
4. `GET /as2/validate` — check readiness; should list only missing items
5. Partial update: `POST /as2/setup` with URL change only — verify certs are preserved

**Important:** `AS2Client` reads config from a static object loaded at startup. The `as2Setup` module calls `AS2Client.reloadConfig()` after any config change. To verify this works, compare `GET /as2/config` before and after `POST /as2/setup` — if the static config wasn't reloaded, the GET would still show the old values.

## Devin Secrets Needed
- None required for local testing (PostgreSQL uses default `postgres/postgres`)
- `ADMIN_SECRET_TOKEN` must be set in env for admin-authenticated endpoints (use `test-admin-token-123` locally)
- `AS2_PARTNER_URL` needed only for real AS2 transmission testing (not required locally)

## Common Issues
- PostgreSQL might need `pg_hba.conf` configured for trust/md5 on localhost
- The `cashflow_events` table might not exist if only ACH migrations are run — the payment orchestrator's journal/cashflow features will warn but ACH lifecycle still works
- Server might fail to start if port 3002 is already in use — kill existing processes first
- The Exported Files tab may show empty even when files exist on disk — verify via shell: `find data/ach-exports -type f`
