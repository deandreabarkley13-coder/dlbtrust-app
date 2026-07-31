---
name: testing-treasury-system
description: Test the DLB Trust Treasury Management System end-to-end, including Core Banking (Fineract + Fixed Income Engine), bond lifecycle, and Fly.io SPA integration.
---

# Testing DLB Trust Treasury Management System

## Prerequisites

### Services Required
1. **PostgreSQL** — Bond data storage (port 5432)
2. **Apache Fineract** — Core banking engine (port 8443)
3. **Node.js app** — Express server (port 3001)

### Start Services
```bash
cd /home/ubuntu/repos/dlbtrust-app
docker compose up -d   # Starts PostgreSQL + Fineract
npm start              # Or: node app.js
```

### Environment Variables
- `PGHOST=localhost`, `PGPORT=5432`, `PGUSER=postgres`, `PGPASSWORD=postgres`, `PGDATABASE=fineract_tenants`
- `FINERACT_URL=https://localhost:8443/fineract-provider/api/v1`
- `FINERACT_TENANT_ID=default`, `FINERACT_USERNAME=mifos`, `FINERACT_PASSWORD=password`

## Devin Secrets Needed
None — all credentials are local development defaults in docker-compose.yml.

## Key API Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/fineract/health` | Verify Fineract connectivity |
| `GET /api/bonds` | List all bonds |
| `POST /api/bonds` | Create bond |
| `POST /api/bonds/:id/accrue` | Accrue interest |
| `GET /api/bonds/:id/dashboard` | Real-time bond dashboard |
| `GET /api/bonds/:id/transactions` | Transaction history |
| `GET /api/analytics/gl-summary` | GL summary (Fineract-first, SQLite fallback) |

## Testing the Fly.io SPA (Frontend)

### Access
- **Local:** `http://localhost:3001/index.html` (full SPA with sidebar)
- **Standalone dashboard:** `http://localhost:3001/dashboard.html`
- **Production (Fly.io):** `https://dlbtrust-app.fly.dev/`

### Core Banking Page
Click "Core Banking" in the sidebar. Verify:
- "Fineract: Connected" green badge (top-right)
- Summary cards show aggregated bond data
- Bond Portfolio table lists all bonds with status badges
- Recent Transactions shows transaction history

### Important Notes
- Other SPA pages (Dashboard, Bond Portfolio, Beneficiaries, etc.) call `/api/treasury/*` endpoints which may only exist on the Fly.io production deployment. Errors on those pages locally are expected.
- The Core Banking page uses `/api/bonds` and `/api/fineract/*` which work locally.
- The Fineract tenant header is `Fineract-Platform-TenantId` (NOT `X-Fineract-Platform-TenantId`).

## Bond Lifecycle Testing (curl)

```bash
# Create bond
curl -s -X POST http://localhost:3001/api/bonds \
  -H 'Content-Type: application/json' \
  -d '{"bond_name":"Test Bond","face_value":1000000,"coupon_rate":0.055,"issue_date":"2025-01-01","maturity_date":"2030-01-01","payment_frequency":"semi_annual","day_count":"30/360"}'

# Accrue interest (90 days)
curl -s -X POST http://localhost:3001/api/bonds/1/accrue \
  -H 'Content-Type: application/json' \
  -d '{"days":90}'

# Pay interest
curl -s -X POST http://localhost:3001/api/bonds/1/pay \
  -H 'Content-Type: application/json' \
  -d '{"payment_type":"interest","amount":5000}'

# Check dashboard
curl -s http://localhost:3001/api/bonds/1/dashboard
```

## Math Verification (30/360 day count)
- Daily rate = coupon_rate / 360
- Accrual for N days = face_value × daily_rate × N
- Example: $1M × 0.055/360 × 90 = **$13,750.00**

## Known Issues
- The `insert` CI job always fails — it SSHes into production to manage OpenACH container, unrelated to code changes
- `legalFormId: 1` is required when creating Fineract clients (not documented in Fineract API docs)
- Fineract takes ~30-60 seconds to boot after `docker compose up`
