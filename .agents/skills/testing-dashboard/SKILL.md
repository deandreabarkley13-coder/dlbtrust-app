---
name: testing-dashboard
description: Run the DLB Trust treasury server locally and log into public/dashboard.html to test features end-to-end (Payment Hub, Banking Aggregator, and other pages). Use when verifying dashboard UI or backend route changes at runtime.
---

# Testing the DLB Trust dashboard locally

The frontend is a single static page `public/dashboard.html` served by the CommonJS server. It talks to `/api/*` routes.

## Run the server
The repo root `package.json` is `type: module`, but the server tree under `server/` is CommonJS. Do NOT run `node server-new-fixed.js`. Run the port-3002 entrypoint (matches the Dockerfile CMD):

1. Install deps at repo root (Dockerfile does `npm ci --omit=dev`): `npm ci --omit=dev`. The CJS server resolves `express` etc. from the root `node_modules` even though root is `type:module`. `server/package.json` only sets `type:commonjs` and has no deps of its own.
2. Start Postgres: `sudo pg_ctlcluster 14 main start`.
3. Ensure DB access. The shared pool (`server/integrations/bonds/pgPool.js`) uses `DATABASE_URL` if set, else `FINERACT_DB_*` env vars (defaults user/password `postgres`/`postgres`, db `fineract_tenants`). If local `pg_hba.conf` rejects connections, set the postgres role password and use trust for local, then create the db:
   - `ALTER USER postgres PASSWORD 'postgres';`
   - `CREATE DATABASE fineract_tenants;`
4. Start:
```
DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5432/fineract_tenants" \
ADMIN_SECRET_TOKEN=test-admin-token-123 \
JWT_SECRET=test-jwt-secret-please-change JWT_EXPIRY=8h \
PORT=3002 node server/server-3002.js
```
Tables (incl. payment_hub) auto-migrate on boot. Open `http://localhost:3002/dashboard.html`.

Note: `/api/health` may report `unhealthy` if unrelated `bonds`/`crm` tables aren't seeded — this does not block auth, Payment Hub, or aggregator routes.

## Auth / roles
Three roles (see `server/integrations/auth/userAuth.js`): `admin` (level 100) > `operator` (50) > `viewer` (10). `requireAuth({role})` checks level >= required, so an admin token satisfies operator-only routes.

- Default admin is auto-created on first boot: username `admin`, password `dlb-admin-2026-trust`.
- Create other users via admin: `POST /api/auth/users` with `{username,password,displayName,role}` and `Authorization: Bearer <adminJWT>`.
- UI login: enter username/password on the dashboard login form. The frontend stores the JWT in `localStorage.dlb_jwt_token` and the legacy admin token in `localStorage.dlb_admin_token`.

### Two auth schemes in the frontend (important)
`adminHeaders()` in dashboard.html adds BOTH `Authorization: Bearer <jwt>` (if a JWT is present) and `x-admin-token` (if an admin token is present).
- **Payment Hub** routes use `requireAuth({role:'operator'})` (JWT). Logging in as operator/admin is enough.
- **Banking Aggregator** routes use `requireAdmin` (the legacy `x-admin-token`, matching `ADMIN_SECRET_TOKEN`). A JWT login alone does NOT satisfy them — the page shows a "Set your admin token on the Security page" empty-state. Set the admin token via the Security page to actually load aggregator data.

## Feature-specific notes
- **Payment Hub** (`🏧` nav item): create intents (form sends a client-generated `Idempotency-Key`), then Approve/Reject/Submit/Cancel/Retry per row. Maker/checker is enforced server-side — the operator who created an intent CANNOT approve it ("Maker cannot approve the same payment instruction"). To demonstrate a successful state change from the maker, use Cancel (allowed for the maker); to test Approve, use a second operator user. Beneficiary routing/account come back masked (e.g. `*****0021 / ****7890`).

## Devin Secrets Needed
None required for local testing (local Postgres password `postgres` and the test JWT/admin tokens above are dev-only, not real secrets).
