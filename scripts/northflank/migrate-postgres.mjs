#!/usr/bin/env node
// Copy the treasury ledger database from the Fly.io PostgreSQL instance into the
// Northflank PostgreSQL addon.
//
// The dump is taken inside the Fly machine (its image ships postgresql-client)
// so the Fly-internal database host does not have to be reachable locally, and
// is restored over the addon's external TLS endpoint. Enable external access on
// the addon before running (Northflank UI: addon -> settings, or set
// externalAccessEnabled).
//
// Usage:
//   FLY_API_TOKEN=... NORTHFLANK_API_TOKEN=... node scripts/northflank/migrate-postgres.mjs [--dry-run]

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');
const FLY_APP = process.env.FLY_APP || 'dlbtrust-app';
const PROJECT_ID = process.env.NORTHFLANK_PROJECT_ID || 'dlbtrust';
const ADDON_ID = process.env.NORTHFLANK_ADDON_ID || 'dlbtrust-db';
const NF_API = process.env.NORTHFLANK_API_HOST || 'https://api.northflank.com';
const FLYCTL = process.env.FLYCTL_BIN || 'flyctl';

async function addonConnectionUri() {
  const response = await fetch(`${NF_API}/v1/projects/${PROJECT_ID}/addons/${ADDON_ID}/credentials`, {
    headers: { Authorization: `Bearer ${process.env.NORTHFLANK_API_TOKEN}` },
  });
  if (!response.ok) {
    throw new Error(`addon credentials request failed: ${response.status} ${await response.text()}`);
  }
  const { data } = await response.json();
  const envs = data?.envs ?? {};
  const externalKey = Object.keys(envs).find((key) => /EXTERNAL/i.test(key) && /URI|URL/i.test(key));
  if (externalKey) return envs[externalKey];

  const { host, port, username, password, database } = data?.secrets ?? {};
  if (!host || !username) {
    throw new Error(
      'no external connection details on the addon — enable external access before migrating',
    );
  }
  const auth = `${encodeURIComponent(username)}:${encodeURIComponent(password)}`;
  return `postgresql://${auth}@${host}:${port || 5432}/${database || 'postgres'}?sslmode=require`;
}

function dumpFromFly(dumpPath) {
  // pg_dump runs inside the Fly container, where DATABASE_URL resolves.
  const remote = `pg_dump --no-owner --no-privileges --clean --if-exists "$DATABASE_URL"`;
  execFileSync(
    'bash',
    ['-c', `${FLYCTL} ssh console -a ${FLY_APP} -C "/bin/sh -c '${remote}'" > ${dumpPath}`],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  const { size } = statSync(dumpPath);
  if (size < 1024) throw new Error(`dump looks empty (${size} bytes) — check the Fly machine`);
  console.log(`dumped ${size} bytes from Fly app ${FLY_APP}`);
}

function restore(uri, dumpPath) {
  const result = spawnSync('psql', ['--set', 'ON_ERROR_STOP=off', '-f', dumpPath, uri], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.status !== 0) throw new Error(`psql restore exited with ${result.status}`);
}

async function main() {
  if (!process.env.FLY_API_TOKEN) throw new Error('FLY_API_TOKEN is required');
  const dumpPath = join(mkdtempSync(join(tmpdir(), 'dlbtrust-pg-')), 'dump.sql');
  dumpFromFly(dumpPath);
  if (DRY_RUN) {
    console.log(`--dry-run: dump kept at ${dumpPath}, nothing restored`);
    return;
  }
  if (!process.env.NORTHFLANK_API_TOKEN) throw new Error('NORTHFLANK_API_TOKEN is required');
  restore(await addonConnectionUri(), dumpPath);
  console.log('restore complete');
}

await main();
