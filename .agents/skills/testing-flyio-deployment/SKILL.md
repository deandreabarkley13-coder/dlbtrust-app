---
name: testing-flyio-deployment
description: Test the DLB Trust Treasury Management app deployed on Fly.io. Use when verifying Fly.io deployment, Dashboard, or Core Banking page changes.
---

# Testing Fly.io Deployment

## Prerequisites

- Fly.io API token available as `FLY_API_TOKEN` environment variable
- `flyctl` CLI installed (check `~/.fly/bin/flyctl`)
- No browser auth needed — the app is publicly accessible

## Devin Secrets Needed

- `FLY_API_TOKEN` — for deploying via `flyctl deploy`

## Production Environment

- **URL:** https://dlbtrust-app.fly.dev/
- **App name:** `dlbtrust-app`
- **Region:** `iad`
- **Database:** Fly.io managed PostgreSQL via `DATABASE_URL` secret

## Deploying

```bash
export PATH="/home/ubuntu/.fly/bin:$PATH"
cd /path/to/dlbtrust-app
flyctl deploy --app dlbtrust-app --remote-only
```

Deploy takes ~30-60 seconds. The app auto-restarts and schema auto-initializes on startup.

## Available Pages

The app is a single-page SPA (`public/index.html`) with sidebar navigation:

| Page | Status | Data Source |
|---|---|---|
| Dashboard | Working | `/api/bonds` |
| Core Banking | Working | `/api/bonds` + `/api/fineract/health` |
| Bond Portfolio through File Transfer | Shows "Module Unavailable" | Requires `/api/treasury/*` backend (not on Fly.io) |

## Available API Endpoints

| Endpoint | Method | Works on Fly.io |
|---|---|---|
| `/api/bonds` | GET | Yes — returns bond portfolio |
| `/api/bonds/:id/transactions` | GET | Yes — returns transaction history |
| `/api/bonds/:id/dashboard` | GET | Yes — returns bond dashboard with pending accrual |
| `/api/bonds` | POST | Yes — create a new bond |
| `/api/bonds/:id/accrue` | POST | Yes — accrue interest |
| `/api/bonds/:id/pay-interest` | POST | Yes — pay interest |
| `/api/bonds/:id/pay-principal` | POST | Yes — pay principal |
| `/api/fineract/health` | GET | Yes — returns `fineract_connected: false` (expected) |
| `/api/treasury/*` | * | No — these endpoints don't exist on Fly.io |

## Key Gotchas

1. **Dashboard calls `/api/bonds`, not `/api/treasury/*`** — The Dashboard was rewritten to use the bond engine API. If you see "Unexpected token '<'", the Dashboard is trying to fetch a non-existent endpoint that returns HTML.

2. **Fineract is always disconnected on Fly.io** — Fineract only runs in Docker Compose (local dev). On production, `fineract_connected: false` is expected. The Core Banking page shows a red "Fineract: Disconnected" badge.

3. **Schema auto-initializes on startup** — Bond tables are created via `CREATE TABLE IF NOT EXISTS` in `app.js`. No manual migration needed.

4. **UUID migration** — If you see `operator does not exist: integer = uuid`, the legacy UUID tables weren't migrated. The auto-init checks for this and drops/recreates tables. Redeploy to trigger.

5. **SSL config** — `pgPool.js` uses conditional spread for SSL: `...(DB_SSL === 'true' && { ssl: ... })`. Don't set `ssl: false` explicitly as it overrides `sslmode` from `DATABASE_URL`.

6. **CI `insert` job always fails** — This is a pre-existing OpenACH infrastructure issue (SSHes into `74.208.191.205` to manage Docker containers). Only `validate` matters for code quality.

7. **Browser cache** — After redeployment, clear browser cache or hard-refresh to see updated frontend code.

## Testing Approach

This is a **browser + shell** test:
- Shell: curl API endpoints to verify JSON responses with exact values
- Browser: Navigate the SPA, verify Dashboard and Core Banking pages render with correct data

Record browser interactions for visual proof. Key assertions:
- Dashboard: portfolio value = principal + accrued interest
- Core Banking: summary cards match `/api/bonds` response
- Transactions: count and amounts match `/api/bonds/:id/transactions`
- Unavailable pages: show "Module Unavailable" (not raw errors)
