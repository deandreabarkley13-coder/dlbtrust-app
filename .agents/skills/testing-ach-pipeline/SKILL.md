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

## Key Endpoints

### Existing (batch creation & transmission)
- `POST /api/ach-pipeline/batches` — create batch
- `POST /api/ach-pipeline/batches/:id/transmit` — transmit via AS2
- `GET /api/ach-pipeline/batches/:id` — get batch with entries
- `GET /api/ach-pipeline/status` — pipeline status

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

### Dashboard
- `GET /api/ach-pipeline/payment-summary` — full metrics including accepted/settled/returned

## Testing Strategy

### Simulating Transmission
AS2 partner is not configured locally. Simulate by updating batch/entry status directly:
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

## Devin Secrets Needed
- None required for local testing (PostgreSQL uses default `postgres/postgres`)
- `AS2_PARTNER_URL` needed only for real AS2 transmission testing (not required locally)

## Common Issues
- PostgreSQL might need `pg_hba.conf` configured for trust/md5 on localhost
- The `cashflow_events` table might not exist if only ACH migrations are run — the payment orchestrator's journal/cashflow features will warn but ACH lifecycle still works
- Server might fail to start if port 3002 is already in use — kill existing processes first
