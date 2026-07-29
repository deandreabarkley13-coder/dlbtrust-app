---
name: Testing the DLB Trust treasury app (server-3002)
description: How to start, authenticate, and end-to-end test the dlbtrust-app Express server on port 3002.
---

# Testing DLB Trust (`dlbtrust-app`)

## Quick start

1. Verify PostgreSQL is running and the `dlbtrust` database/user exist (or create one).
2. Truncate/seed OFX tables if you need deterministic counts.
3. Start the server in the background with `nohup` and the required env vars:

```bash
cd /path/to/dlbtrust-app
nohup env \
  DATABASE_URL=postgres://dlbtrust:dlbtrust@localhost:5432/dlbtrust \
  JWT_SECRET=<any-stable-secret> \
  ADMIN_SECRET_TOKEN=dlb-admin-2026-trust \
  STABLECOIN_ENABLED=true \
  STABLECOIN_MODE=shadow \
  STABLECOIN_NETWORK=testnet \
  STABLECOIN_DISTRIBUTOR_SECRET=<valid-stellar-secret> \
  STABLECOIN_DISTRIBUTOR_PUBLIC=<matching-public-key> \
  PORT=3002 \
  node server/server-3002.js > /tmp/server-3002.log 2>&1 &
disown
```

- The server warms up Postgres synchronously before listening. It can crash or restart if another process is on port 3002, so verify with `ss -ltnp | grep 3002`.
- Default admin credentials are `admin` / `dlb-admin-2026-trust`.
- The dashboard SPA lives at `http://localhost:3002/`. Set `ADMIN_SECRET_TOKEN` to the admin password so the dashboard's stored `x-admin-token` works as a fallback.

## Common environment issues

- `DATABASE_URL` falls back to `postgres://postgres:postgres@localhost:5432/fineract_tenants` if unset; on a fresh `dlbtrust` DB the core bond/trust tables will be missing and many modules log warnings, but OFX Clearing still works.
- Fineract and some backup jobs are not configured locally; expect `fineract` and `pg_dump` errors in the logs. They do not block OFX testing.
- The server may receive `SIGTERM` from an external watchdog or port conflict. If the dashboard starts returning 401 or blank responses, check whether the node process is still alive and restart it.

## UI navigation

- Login via the overlay.
- Use the left sidebar **Stablecoin Payments** nav item to switch to `#page-stablecoin`.
- Use the left sidebar **OFX Clearing** nav item to switch to `#page-ofx`.
- The Stablecoin Payments page has cards for readiness, payment creation, source-balance checks, and a payments table.
- The OFX Clearing page has cards for institutions, statement import, payment creation, and a payments table.
- Submitting an OFX payment in simulate mode updates the row to `accepted` and persists an XML `ofx_request` in Postgres.
- Creating a stablecoin payment with a non-treasury source (bond, cash, trust, fixed_income, fineract/core_banking) will sweep the source balance into treasury on approve, post the reserve on settle, and reduce the source balance by the payment total.

## Useful Postgres checks

```sql
-- Stablecoin payments and reserves
SELECT id, status, source_type, source_account_id, total_cents, reserve_id, tx_hash, source_ref
FROM stablecoin_payments ORDER BY created_at DESC;

SELECT account_id, balance_cents, hold_cents, available_cents
FROM stablecoin_treasury_accounts WHERE account_id = 'TREASURY_HOT';

SELECT reserve_id, status, tx_hash FROM stablecoin_reserves ORDER BY created_at DESC;

-- Source balances
SELECT b.id, b.bond_name, bb.principal_balance, bb.accrued_interest
FROM bonds b JOIN bond_balances bb ON bb.bond_id = b.id WHERE b.id = 1;

SELECT account_id, balance_cents FROM cash_accounts WHERE account_id = 'STABLECOIN_CASH_HOLD';
SELECT account_code, balance FROM trust_accounts WHERE account_code = 'TRUST-SRC-TEST2';

-- OFX
SELECT id, status, ofx_request IS NOT NULL AS has_request
FROM ofx_payments ORDER BY id DESC;

SELECT * FROM ofx_statements ORDER BY parsed_at DESC;
SELECT fit_id, type, amount_cents, name, memo FROM ofx_transactions;
```

## Devin Secrets Needed

- `DATABASE_URL` or local Postgres credentials (`dlbtrust`/`dlbtrust`).
- `JWT_SECRET` and `ADMIN_SECRET_TOKEN` for stable auth.
