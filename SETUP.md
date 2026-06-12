# DLB Trust App — PostgreSQL Setup

This app uses PostgreSQL (via Supabase) as its database backend.

## Prerequisites

- Node.js >= 18
- A Supabase project (or any PostgreSQL database)
- `psql` CLI (optional, for running the migration)

## Steps

### 1. Configure Environment

Copy `.env.example` to `.env` and fill in `DATABASE_URL` with your Supabase connection string:

```bash
cp .env.example .env
```

Find the connection string in your Supabase dashboard:
**Settings → Database → Connection string → URI**

It should look like:
```
DATABASE_URL=postgresql://postgres:YOUR-PASSWORD@db.ihegrfvgdwkivpsrmdzs.supabase.co:5432/postgres
```

### 2. Run the Database Schema Migration

```bash
psql $DATABASE_URL -f server/integrations/openach/db-migration.sql
```

This creates the `wallets`, `transactions`, and `disbursements` tables with appropriate indexes.

### 3. Install Dependencies

```bash
npm install
```

### 4. Start the Server

```bash
npm start
```

The server runs on port 3001 by default (configurable via `PORT` env var).
