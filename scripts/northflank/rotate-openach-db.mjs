// Rotate the credentials of the OpenACH PostgreSQL addon by recreating it.
//
// Northflank exposes no credential-reset endpoint for addons: the generated
// user and password live for as long as the addon does. Recreating the addon is
// therefore the only rotation, and it is destructive — OpenACH's origination
// state (user, originator, ODFI branch, settlement account, payment types, api
// credentials) is carried across as a dump/restore.
//
// The addon has external access disabled, so it is turned on for the dump and
// the restore and off again afterwards. `openach-runtime` then gets the new
// connection string merged in and the openach service is restarted onto it.
// OPENACH_ENCRYPTION_KEY is deliberately untouched: rotating it would strand
// every encrypted column in the restored data.
//
// Requires a pg_dump/pg_restore at least as new as the addon (16) — set
// PG_BIN_DIR, e.g. /usr/lib/postgresql/16/bin.
//
// Usage:
//   NORTHFLANK_API_TOKEN=... PG_BIN_DIR=/usr/lib/postgresql/16/bin \
//     node scripts/northflank/rotate-openach-db.mjs [--dry-run]
//
// --dry-run dumps the current addon and stops before anything is deleted.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DRY_RUN = process.argv.includes('--dry-run');
const NF_API = process.env.NORTHFLANK_API_HOST || 'https://api.northflank.com';
const PROJECT_ID = process.env.NORTHFLANK_PROJECT_ID || 'dlbtrust';
const ADDON_ID = process.env.NORTHFLANK_OPENACH_ADDON_ID || 'openach-db';
const SERVICE_ID = process.env.NORTHFLANK_OPENACH_SERVICE_ID || 'openach';
const SECRET_GROUP = process.env.NORTHFLANK_OPENACH_SECRET_GROUP || 'openach-runtime';
const PG_BIN_DIR = process.env.PG_BIN_DIR || '';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SPEC_PATH = join(REPO_ROOT, 'northflank', 'addon-postgres-openach.json');

const pg = (binary) => (PG_BIN_DIR ? join(PG_BIN_DIR, binary) : binary);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function nfRequest(method, path, body = null) {
  const response = await fetch(`${NF_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NORTHFLANK_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`);
  }
  return response.json();
}

const addonPath = `/v1/projects/${PROJECT_ID}/addons/${ADDON_ID}`;

function setExternalAccess(enabled) {
  return nfRequest('PATCH', addonPath, { externalAccessEnabled: enabled });
}

function withSslMode(uri) {
  if (/sslmode=/.test(uri)) return uri;
  return `${uri}${uri.includes('?') ? '&' : '?'}sslmode=require`;
}

/** Wait until the addon is running and hands out an external admin uri. */
async function readyUris({ external }) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { data: addon } = await nfRequest('GET', addonPath);
    const { data } = await nfRequest('GET', `${addonPath}/credentials`);
    const envs = data?.envs ?? {};
    const admin = external ? envs.EXTERNAL_POSTGRES_URI_ADMIN : envs.POSTGRES_URI_ADMIN;
    if (addon.status === 'running' && admin && envs.POSTGRES_URI) {
      return { admin: withSslMode(admin), app: withSslMode(envs.POSTGRES_URI) };
    }
    await sleep(10_000);
  }
  throw new Error(`addon ${ADDON_ID} did not become reachable`);
}

function psql(uri, args, { capture = false, check = true } = {}) {
  const result = spawnSync(pg('psql'), [...args, uri], {
    encoding: 'utf8',
    stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
  });
  if (check && result.status !== 0) throw new Error(`psql exited with ${result.status}`);
  return result.stdout ?? '';
}

function tableCounts(adminUri) {
  return psql(
    adminUri,
    ['-Atq', '-c', 'select relname || \'|\' || n_live_tup from pg_stat_user_tables where n_live_tup > 0 order by relname'],
    { capture: true },
  ).trim();
}

// The restore runs as the addon admin, so every object has to be handed to the
// application user the openach service connects as. Objects owned by an
// extension (pg_stat_statements, pg_stat_kcache) belong to Northflank's own
// tooling and cannot be reassigned.
function handOverToAppUser(adminUri, appUser) {
  const statements = psql(
    adminUri,
    [
      '-Atq',
      '-c',
      `select format('ALTER %s %s OWNER TO %I;',
         case c.relkind when 'S' then 'SEQUENCE' when 'v' then 'VIEW' when 'm' then 'MATERIALIZED VIEW' else 'TABLE' end,
         c.oid::regclass, '${appUser}')
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       left join pg_depend d on d.objid = c.oid and d.deptype = 'e'
       where n.nspname = 'public' and c.relkind in ('r','p','S','v','m') and d.objid is null
       union all
       select format('ALTER TYPE %s OWNER TO %I;', t.oid::regtype, '${appUser}')
       from pg_type t
       join pg_namespace n on n.oid = t.typnamespace
       left join pg_depend d on d.objid = t.oid and d.deptype = 'e'
       where n.nspname = 'public' and t.typtype in ('e','d') and t.typarray <> 0 and d.objid is null`,
    ],
    { capture: true },
  );
  for (const statement of statements.split('\n').map((line) => line.trim()).filter(Boolean)) {
    psql(adminUri, ['-v', 'ON_ERROR_STOP=1', '-q', '-c', statement]);
  }
  for (const grant of [
    `GRANT USAGE, CREATE ON SCHEMA public TO "${appUser}";`,
    `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "${appUser}";`,
    `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "${appUser}";`,
  ]) {
    psql(adminUri, ['-q', '-c', grant], { check: false });
  }
  const stragglers = psql(
    adminUri,
    [
      '-Atq',
      '-c',
      `select count(*) from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_roles r on r.oid = c.relowner
         left join pg_depend d on d.objid = c.oid and d.deptype = 'e'
       where n.nspname = 'public' and c.relkind in ('r','p')
         and d.objid is null and r.rolname <> '${appUser}'`,
    ],
    { capture: true },
  ).trim();
  if (stragglers !== '0') throw new Error(`${stragglers} table(s) are still not owned by the app user`);
}

async function setDatabaseUrl(uri) {
  const path = `/v1/projects/${PROJECT_ID}/secrets/${SECRET_GROUP}`;
  const { data } = await nfRequest('GET', path);
  const variables = { ...(data?.secrets?.variables ?? {}), DATABASE_URL: uri };
  // A raw PATCH replaces secrets.variables wholesale, so the merged set is
  // written back in full.
  await nfRequest('PATCH', path, { secrets: { variables } });
}

async function main() {
  if (!process.env.NORTHFLANK_API_TOKEN) throw new Error('NORTHFLANK_API_TOKEN is required');

  const workDir = mkdtempSync(join(process.env.MIGRATION_WORK_DIR || homedir(), 'openach-rotate-'));
  const dumpPath = join(workDir, 'openach-db.dump');

  console.log('[1] enabling external access and dumping the current addon');
  await setExternalAccess(true);
  let before;
  try {
    const { admin } = await readyUris({ external: true });
    before = tableCounts(admin);
    const dump = spawnSync(pg('pg_dump'), ['-Fc', '--no-owner', '--no-acl', '-f', dumpPath, admin], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    if (dump.status !== 0) throw new Error(`pg_dump exited with ${dump.status}`);
    const { size } = statSync(dumpPath);
    if (size < 1024) throw new Error(`dump looks empty (${size} bytes) — refusing to recreate the addon`);
    console.log(`    dumped ${size} bytes to ${dumpPath}`);
  } catch (error) {
    await setExternalAccess(false);
    throw error;
  }

  if (DRY_RUN) {
    await setExternalAccess(false);
    console.log(`--dry-run: dump kept at ${dumpPath}, addon left alone`);
    return;
  }

  console.log(`[2] deleting addon ${ADDON_ID}`);
  await nfRequest('DELETE', addonPath);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await nfRequest('GET', addonPath);
    } catch {
      break;
    }
    if (attempt >= 60) throw new Error(`addon ${ADDON_ID} was not deleted`);
    await sleep(10_000);
  }

  console.log('[3] recreating it from the spec (new user and password)');
  const spec = { ...JSON.parse(readFileSync(SPEC_PATH, 'utf8')), externalAccessEnabled: true };
  await nfRequest('POST', `/v1/projects/${PROJECT_ID}/addons`, spec);
  const uris = await readyUris({ external: true });

  console.log('[4] restoring the dump');
  const restore = spawnSync(pg('pg_restore'), ['--no-owner', '--no-acl', '-d', uris.admin, dumpPath], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  // Northflank's own pooler schema and extensions are already present in the
  // fresh addon, so those statements fail; the ownership check below is what
  // decides whether the restore is usable.
  if (restore.status !== 0) console.log('    (pre-existing Northflank objects reported errors; verifying)');
  const after = tableCounts(uris.admin);
  if (after !== before) {
    throw new Error(`row counts differ after restore:\nbefore:\n${before}\nafter:\n${after}`);
  }
  handOverToAppUser(uris.admin, new URL(uris.app).username);
  console.log('    row counts match and ownership handed to the application user');

  console.log('[5] closing external access, repointing the service and restarting it');
  await setExternalAccess(false);
  await setDatabaseUrl(uris.app);
  await nfRequest('POST', `/v1/projects/${PROJECT_ID}/services/${SERVICE_ID}/restart`, {});

  console.log(`
Rotated. The old credential is gone with the old addon. Verify:
  curl -s -X POST "$OPENACH_BASE_URL/connect" \\
    --data "user_api_token=$OPENACH_API_TOKEN&user_api_key=$OPENACH_API_KEY"
The dump still holds the trust's origination data — delete ${dumpPath} once done.`);
}

await main();
