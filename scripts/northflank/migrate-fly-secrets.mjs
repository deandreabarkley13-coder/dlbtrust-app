#!/usr/bin/env node
// Copy the runtime environment of the Fly.io machine into a Northflank secret
// group, so the 130+ integration credentials do not have to be re-entered by
// hand. Fly secrets are write-only through the API, so the values are read out
// of the running container instead.
//
// Values are never printed: only variable names are logged.
//
// Usage:
//   FLY_API_TOKEN=... NORTHFLANK_API_TOKEN=... node scripts/northflank/migrate-fly-secrets.mjs [--dry-run]
//
// Env overrides: FLY_APP (dlbtrust-app), NORTHFLANK_PROJECT_ID (dlbtrust),
// NORTHFLANK_SECRET_ID (dlbtrust-runtime).

import { execFileSync } from 'node:child_process';

const DRY_RUN = process.argv.includes('--dry-run');
const FLY_APP = process.env.FLY_APP || 'dlbtrust-app';
const PROJECT_ID = process.env.NORTHFLANK_PROJECT_ID || 'dlbtrust';
const SECRET_ID = process.env.NORTHFLANK_SECRET_ID || 'dlbtrust-runtime';
const NF_API = process.env.NORTHFLANK_API_HOST || 'https://api.northflank.com';
const FLYCTL = process.env.FLYCTL_BIN || 'flyctl';

// Container/platform variables that must not be carried over, plus the ones
// Northflank owns: the port and NODE_ENV come from the service spec and
// DATABASE_URL comes from the PostgreSQL addon.
const SKIP_EXACT = new Set([
  'DATABASE_URL',
  'HOME',
  'HOSTNAME',
  'NODE_ENV',
  'NODE_VERSION',
  'PATH',
  'PORT',
  'PRIMARY_REGION',
  'PWD',
  'SHLVL',
  'TERM',
  'YARN_VERSION',
  '_',
]);
const SKIP_PREFIX = ['FLY_'];

function readFlyEnvironment() {
  const raw = execFileSync(
    FLYCTL,
    ['ssh', 'console', '-a', FLY_APP, '-C', '/usr/bin/env'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const variables = {};
  let current = null;
  for (const line of raw.split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_./-]*)=(.*)$/.exec(line);
    if (match) {
      current = match[1];
      variables[current] = match[2];
    } else if (current !== null) {
      // multi-line value (e.g. PEM keys)
      variables[current] += `\n${line}`;
    }
  }
  return variables;
}

function filterVariables(variables) {
  const kept = {};
  for (const [key, value] of Object.entries(variables)) {
    if (SKIP_EXACT.has(key)) continue;
    if (SKIP_PREFIX.some((prefix) => key.startsWith(prefix))) continue;
    if (value === '') continue;
    kept[key] = value;
  }
  return kept;
}

async function nfRequest(method, path, body) {
  const response = await fetch(`${NF_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NORTHFLANK_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

async function main() {
  if (!process.env.FLY_API_TOKEN) throw new Error('FLY_API_TOKEN is required');
  if (!DRY_RUN && !process.env.NORTHFLANK_API_TOKEN) {
    throw new Error('NORTHFLANK_API_TOKEN is required');
  }

  const variables = filterVariables(readFlyEnvironment());
  const names = Object.keys(variables).sort();
  if (names.length === 0) throw new Error('no variables read from the Fly machine');
  console.log(`carrying over ${names.length} variables:`);
  for (const name of names) console.log(`  ${name}`);

  if (DRY_RUN) {
    console.log('\n--dry-run: nothing written to Northflank');
    return;
  }

  // PUT is upsert-by-id, so re-running the migration re-syncs the group.
  const payload = {
    name: SECRET_ID,
    description: 'Runtime credentials migrated from Fly.io',
    secretType: 'environment',
    priority: 10,
    secrets: { variables },
  };
  const put = await nfRequest('PUT', `/v1/projects/${PROJECT_ID}/secrets/${SECRET_ID}`, payload);
  if (put.ok) {
    console.log(`\nwrote secret group ${SECRET_ID} (${put.status})`);
    return;
  }
  const create = await nfRequest('POST', `/v1/projects/${PROJECT_ID}/secrets`, payload);
  if (!create.ok) {
    throw new Error(`secret group write failed: PUT ${put.status} ${put.text}; POST ${create.status} ${create.text}`);
  }
  console.log(`\ncreated secret group ${SECRET_ID} (${create.status})`);
}

await main();
