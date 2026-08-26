#!/usr/bin/env node
// Copy the treasury ledger database from the Fly.io PostgreSQL instance into the
// Northflank PostgreSQL addon.
//
// The Fly machine image ships postgresql-client 15 while the Fly database server
// runs 17, so pg_dump cannot run inside the container. Instead the Fly database
// is reached through `flyctl proxy` and dumped locally with a pg_dump that is at
// least as new as the server (set PG_BIN_DIR, e.g. /usr/lib/postgresql/17/bin).
//
// The restore uses the addon's external TLS endpoint, so enable external access
// on the addon first (`--manage-external-access` does this and turns it back off
// afterwards). Because the restore runs as the addon admin user, table ownership
// and schema privileges are handed to the application user at the end —
// server/server-3002.js creates missing tables at boot and fails without them.
//
// Usage:
//   FLY_API_TOKEN=... NORTHFLANK_API_TOKEN=... \
//     node scripts/northflank/migrate-postgres.mjs [--dry-run] [--manage-external-access]

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');
const MANAGE_EXTERNAL = process.argv.includes('--manage-external-access');
const FLY_APP = process.env.FLY_APP || 'dlbtrust-app';
const FLY_DB_APP = process.env.FLY_DB_APP || 'dlbtrust-db';
const PROXY_PORT = process.env.FLY_PROXY_PORT || '15432';
const PROJECT_ID = process.env.NORTHFLANK_PROJECT_ID || 'dlbtrust';
const ADDON_ID = process.env.NORTHFLANK_ADDON_ID || 'dlbtrust-db';
const NF_API = process.env.NORTHFLANK_API_HOST || 'https://api.northflank.com';
const FLYCTL = process.env.FLYCTL_BIN || 'flyctl';
const PG_BIN_DIR = process.env.PG_BIN_DIR || '';

const pg = (binary) => (PG_BIN_DIR ? join(PG_BIN_DIR, binary) : binary);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function nfRequest(path, init = {}) {
  const response = await fetch(`${NF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.NORTHFLANK_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${init.method || 'GET'} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function setExternalAccess(enabled) {
  return nfRequest(`/v1/projects/${PROJECT_ID}/addons/${ADDON_ID}`, {
    method: 'PATCH',
    body: JSON.stringify({ externalAccessEnabled: enabled }),
  });
}

async function addonConnectionUris({ waitForExternal = false } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const { data } = await nfRequest(`/v1/projects/${PROJECT_ID}/addons/${ADDON_ID}/credentials`);
    const envs = data?.envs ?? {};
    if (envs.EXTERNAL_POSTGRES_URI_ADMIN && envs.EXTERNAL_POSTGRES_URI) {
      return { admin: envs.EXTERNAL_POSTGRES_URI_ADMIN, app: envs.EXTERNAL_POSTGRES_URI };
    }
    if (!waitForExternal || attempt >= 20) {
      throw new Error('addon has no external connection URIs — enable external access before migrating');
    }
    await sleep(15_000);
  }
}

function withSslMode(uri) {
  if (/sslmode=/.test(uri)) return uri;
  return `${uri}${uri.includes('?') ? '&' : '?'}sslmode=require`;
}

function flyDatabaseUrl() {
  const raw = execFileSync(
    FLYCTL,
    ['ssh', 'console', '-a', FLY_APP, '-C', '/bin/sh -c "printenv DATABASE_URL"'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const url = raw.split('\n').map((line) => line.trim()).find((line) => line.startsWith('postgres'));
  if (!url) throw new Error(`could not read DATABASE_URL from Fly app ${FLY_APP}`);
  return url;
}

async function withFlyProxy(callback) {
  const proxy = spawn(FLYCTL, ['proxy', `${PROXY_PORT}:5432`, '-a', FLY_DB_APP], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await sleep(8_000);
    if (proxy.exitCode !== null) throw new Error(`flyctl proxy exited with ${proxy.exitCode}`);
    return await callback();
  } finally {
    proxy.kill();
  }
}

function dumpFromFly(dumpPath) {
  const flyUrl = new URL(flyDatabaseUrl());
  return withFlyProxy(() => {
    const local = new URL(flyUrl);
    local.hostname = '127.0.0.1';
    local.port = PROXY_PORT;
    const result = spawnSync(
      pg('pg_dump'),
      ['--no-owner', '--no-privileges', '--clean', '--if-exists', '-f', dumpPath, local.toString()],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    if (result.status !== 0) throw new Error(`pg_dump exited with ${result.status}`);
    const { size } = statSync(dumpPath);
    if (size < 1024) throw new Error(`dump looks empty (${size} bytes) — check the Fly database`);
    console.log(`dumped ${size} bytes from Fly database ${FLY_DB_APP}`);
  });
}

function psql(uri, args, options = {}) {
  const result = spawnSync(pg('psql'), [...args, uri], {
    encoding: 'utf8',
    stdio: ['ignore', options.capture ? 'pipe' : 'inherit', 'inherit'],
  });
  if (options.check !== false && result.status !== 0) throw new Error(`psql exited with ${result.status}`);
  return result.stdout ?? '';
}

// Objects restored by the admin user must end up owned by the application user,
// otherwise the app's boot-time `CREATE TABLE IF NOT EXISTS` migrations abort
// with "must be owner of table ...".
function handOverToAppUser(adminUri, appUser, workDir) {
  psql(adminUri, ['-v', 'ON_ERROR_STOP=1', '-q', '-c', `ALTER SCHEMA public OWNER TO "${appUser}";`]);
  const statements = psql(
    adminUri,
    [
      '-Atq',
      '-c',
      `select format('ALTER %s %s OWNER TO %I;',
         case c.relkind when 'r' then 'TABLE' when 'p' then 'TABLE' when 'S' then 'SEQUENCE'
                        when 'v' then 'VIEW' when 'm' then 'MATERIALIZED VIEW' end,
         c.oid::regclass, '${appUser}')
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','p','v','m')
       union all
       select format('ALTER FUNCTION %s OWNER TO %I;', p.oid::regprocedure, '${appUser}')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind = 'f'
       union all
       select format('ALTER TYPE %s OWNER TO %I;', t.oid::regtype, '${appUser}')
       from pg_type t join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'public' and t.typtype in ('e','d') and t.typarray <> 0`,
    ],
    { capture: true },
  );
  const ownershipPath = join(workDir, 'ownership.sql');
  writeFileSync(ownershipPath, statements, { mode: 0o600 });
  psql(adminUri, ['-q', '-f', ownershipPath], { check: false });
  for (const grant of [
    `GRANT USAGE, CREATE ON SCHEMA public TO "${appUser}";`,
    `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "${appUser}";`,
    `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "${appUser}";`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "${appUser}";`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "${appUser}";`,
  ]) {
    psql(adminUri, ['-v', 'ON_ERROR_STOP=1', '-q', '-c', grant]);
  }
  const stragglers = psql(
    adminUri,
    [
      '-Atq',
      '-c',
      `select count(*) from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_roles r on r.oid = c.relowner
       where n.nspname = 'public' and c.relkind in ('r','p') and r.rolname <> '${appUser}'`,
    ],
    { capture: true },
  ).trim();
  if (stragglers !== '0') throw new Error(`${stragglers} table(s) are still not owned by the app user`);
  console.log('schema ownership and privileges handed to the application user');
}

async function main() {
  if (!process.env.FLY_API_TOKEN) throw new Error('FLY_API_TOKEN is required');
  const workDir = mkdtempSync(join(process.env.MIGRATION_WORK_DIR || homedir(), 'dlbtrust-pg-'));
  const dumpPath = join(workDir, 'dump.sql');
  await dumpFromFly(dumpPath);
  if (DRY_RUN) {
    console.log(`--dry-run: dump kept at ${dumpPath}, nothing restored`);
    return;
  }
  if (!process.env.NORTHFLANK_API_TOKEN) throw new Error('NORTHFLANK_API_TOKEN is required');

  if (MANAGE_EXTERNAL) {
    console.log('enabling addon external access');
    await setExternalAccess(true);
  }
  try {
    const uris = await addonConnectionUris({ waitForExternal: MANAGE_EXTERNAL });
    const adminUri = withSslMode(uris.admin);
    const appUser = new URL(uris.app).username;
    // The app creates its own tables at boot, so start from an empty schema to
    // avoid primary-key collisions with rows it seeded before the restore.
    psql(adminUri, ['-v', 'ON_ERROR_STOP=1', '-q', '-c', 'drop schema if exists public cascade; create schema public;']);
    psql(adminUri, ['-v', 'ON_ERROR_STOP=off', '-q', '-f', dumpPath], { check: false });
    handOverToAppUser(adminUri, appUser, workDir);
    const tables = psql(
      adminUri,
      ['-Atq', '-c', "select count(*) from information_schema.tables where table_schema = 'public'"],
      { capture: true },
    ).trim();
    console.log(`restore complete — ${tables} tables in public`);
  } finally {
    if (MANAGE_EXTERNAL) {
      console.log('disabling addon external access');
      await setExternalAccess(false);
    }
  }
}

await main();
