/**
 * OpenACH API user provisioning — run on the OpenACH host, by an operator
 *
 * OpenACH authenticates the in-house bank's ACH rail with an api token/key pair
 * that only exists as a row in OpenACH's own database, so the pair cannot be
 * issued from the application side: it has to be generated and registered where
 * that database lives. This script does both, then proves the pair works by
 * opening a session with it and reading back the payment types the rail needs.
 *
 *   node server/integrations/openach/server-side-setup.js
 *
 * A pair is generated for you unless OPENACH_API_TOKEN / OPENACH_API_KEY are
 * already in the environment, in which case those are registered instead. The
 * user and originator the row hangs off are read out of OpenACH rather than
 * assumed, and nothing is written until an existing row for the same token is
 * ruled out.
 *
 * Optional:
 *   OPENACH_REVOKE_TOKEN  disable a superseded (or compromised) token afterwards
 *   OPENACH_USER_ID       pin the OpenACH user instead of taking the first enabled one
 *   OPENACH_ORIGINATOR_ID pin the originator instead of taking the first one
 *   OPENACH_HOST_HEADER   vhost OpenACH answers on (default ach.dlbtrust.cloud)
 *   OPENACH_LOCAL_URL     local api base (default http://localhost/openach/api)
 */

'use strict';

const { execSync } = require('child_process');
const crypto = require('crypto');

const HOST_HEADER = process.env.OPENACH_HOST_HEADER || 'ach.dlbtrust.cloud';
const LOCAL_URL = process.env.OPENACH_LOCAL_URL || 'http://localhost/openach/api';
const REVOKE_TOKEN = process.env.OPENACH_REVOKE_TOKEN || null;

// Generated here rather than defaulted to a literal: a credential committed to
// the repository is a credential that has to be rotated.
const TOKEN = process.env.OPENACH_API_TOKEN || crypto.randomUUID();
const KEY = process.env.OPENACH_API_KEY || crypto.randomUUID();
const GENERATED = !process.env.OPENACH_API_TOKEN || !process.env.OPENACH_API_KEY;

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 15000 }).trim();
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

function failed(output) {
  return !output || output.startsWith('ERROR');
}

/** Run a statement against the OpenACH sqlite database inside its container. */
function sqlite(container, dbPath, sql) {
  return run(`docker exec ${container} sqlite3 "${dbPath}" ${JSON.stringify(sql)}`);
}

/** POST to the local OpenACH api, which avoids the vhost's TLS on the host. */
function api(endpoint, { data = null, cookie = null } = {}) {
  const parts = [`curl -s -X POST ${LOCAL_URL}/${endpoint}`, `-H "Host: ${HOST_HEADER}"`];
  if (cookie) parts.push(`-H "Cookie: ${cookie}"`);
  if (data) parts.push(`--data ${JSON.stringify(new URLSearchParams(data).toString())}`);
  const raw = run(parts.join(' '));
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

/**
 * OpenACH releases differ on where api users live (`user_api` in the release
 * this deployment runs, `oa_user_api_user` in others), so the table and its
 * columns are discovered instead of hardcoded — writing the wrong shape would
 * leave a row that never authenticates.
 */
function findApiUserTable(container, dbPath) {
  const listed = sqlite(
    container,
    dbPath,
    "SELECT name FROM sqlite_master WHERE type='table' AND (name='user_api' OR name='oa_user_api_user' OR name LIKE '%user_api%');"
  );
  if (failed(listed)) return null;
  const table = listed.split('\n').map(l => l.trim()).filter(Boolean)[0];
  if (!table) return null;

  const info = sqlite(container, dbPath, `PRAGMA table_info(${table});`);
  if (failed(info)) return null;
  const columns = info.split('\n').map(line => line.split('|')[1]).filter(Boolean);
  return { table, columns };
}

function pickColumn(columns, candidates) {
  return candidates.find(candidate => columns.includes(candidate)) || null;
}

async function main() {
  console.log('=== OpenACH api user provisioning ===\n');

  console.log('[1] Locating the OpenACH container and database');
  const container = run('docker ps --format "{{.Names}}" | grep -i openach | head -1');
  if (failed(container)) {
    console.error('    Cannot find a running OpenACH container:', container);
    process.exit(1);
  }
  const found = run(`docker exec ${container} find /var/www/html -name "openach.db" 2>/dev/null | head -1`);
  const dbPath = failed(found) ? '/var/www/html/protected/runtime/db/openach.db' : found;
  console.log(`    container ${container}`);
  console.log(`    database  ${dbPath}`);

  const schema = findApiUserTable(container, dbPath);
  if (!schema) {
    console.error('    Cannot find the api user table in the OpenACH database.');
    process.exit(1);
  }
  const tokenColumn = pickColumn(schema.columns, ['user_api_token']);
  const keyColumn = pickColumn(schema.columns, ['user_api_key']);
  const userColumn = pickColumn(schema.columns, ['user_api_user_id', 'user_api_user_user_id']);
  const originatorColumn = pickColumn(schema.columns, [
    'user_api_originator_info_id',
    'user_api_user_originator_info_id',
  ]);
  if (!tokenColumn || !keyColumn || !userColumn || !originatorColumn) {
    console.error(`    Unexpected ${schema.table} shape: ${schema.columns.join(', ')}`);
    process.exit(1);
  }
  console.log(`    api users in ${schema.table}`);

  console.log('\n[2] Reading the OpenACH user and originator to attach the credential to');
  const userId = process.env.OPENACH_USER_ID
    || sqlite(container, dbPath, "SELECT user_id FROM oa_user WHERE user_status='enabled' LIMIT 1;");
  const originatorId = process.env.OPENACH_ORIGINATOR_ID
    || sqlite(container, dbPath, 'SELECT originator_info_id FROM oa_originator_info LIMIT 1;');
  if (failed(userId) || failed(originatorId)) {
    console.error('    Could not read a user / originator from OpenACH.');
    console.error(`    user: ${userId}`);
    console.error(`    originator: ${originatorId}`);
    process.exit(1);
  }
  console.log(`    user       ${userId}`);
  console.log(`    originator ${originatorId}`);

  console.log(`\n[3] Registering the api credential (${GENERATED ? 'generated here' : 'taken from the environment'})`);
  const existing = sqlite(
    container,
    dbPath,
    `SELECT ${tokenColumn} FROM ${schema.table} WHERE ${tokenColumn}='${TOKEN}' LIMIT 1;`
  );
  if (!failed(existing) && existing.includes(TOKEN)) {
    console.log('    already registered; leaving it alone');
  } else {
    const columns = [userColumn, originatorColumn, tokenColumn, keyColumn];
    const values = [`'${userId}'`, `'${originatorId}'`, `'${TOKEN}'`, `'${KEY}'`];
    if (schema.columns.includes('user_api_datetime')) {
      columns.push('user_api_datetime');
      values.push("datetime('now')");
    }
    if (schema.columns.includes('user_api_status')) {
      columns.push('user_api_status');
      values.push("'enabled'");
    }
    const insert = sqlite(
      container,
      dbPath,
      `INSERT INTO ${schema.table} (${columns.join(', ')}) VALUES (${values.join(', ')});`
    );
    if (failed(insert)) {
      console.error('    Insert failed:', insert);
      process.exit(1);
    }
    console.log('    registered');
  }

  if (REVOKE_TOKEN && schema.columns.includes('user_api_status')) {
    console.log('\n[3b] Disabling the superseded token');
    const revoked = sqlite(
      container,
      dbPath,
      `UPDATE ${schema.table} SET user_api_status='disabled' WHERE ${tokenColumn}='${REVOKE_TOKEN}';`
    );
    console.log(failed(revoked) ? `    could not disable it: ${revoked}` : '    disabled');
  } else if (REVOKE_TOKEN) {
    console.log(`\n[3b] ${schema.table} has no status column; delete the superseded row manually`);
  }

  console.log('\n[4] Opening a session with the credential');
  const connected = api('connect', { data: { user_api_token: TOKEN, user_api_key: KEY } });
  if (!connected.success || !connected.session_id) {
    console.error('    The credential did not authenticate:', JSON.stringify(connected));
    process.exit(1);
  }
  const cookie = `PHPSESSID=${connected.session_id}`;
  console.log('    authenticated');

  console.log('\n[5] Reading the payment types the ACH rail originates against');
  const types = api('getPaymentTypes', { cookie });
  const list = Array.isArray(types) ? types : (types.payment_types || types.data || []);
  let standard = null;
  let sameDay = null;
  if (Array.isArray(list) && list.length) {
    list.forEach(type => {
      const name = String(type.payment_type_name || '');
      console.log(`    ${type.payment_type_id}  ${name}`);
      const lower = name.toLowerCase();
      if (!sameDay && (lower.includes('same day') || lower.includes('same-day') || lower.includes('sameday'))) {
        sameDay = type.payment_type_id;
      } else if (!standard && (lower.includes('trust') || lower.includes('dist'))) {
        standard = type.payment_type_id;
      }
    });
    if (!standard) standard = list[0].payment_type_id;
  } else {
    console.log('    OpenACH returned no payment types:', JSON.stringify(types));
  }

  api('disconnect', { cookie });

  console.log('\n=== Add to the server environment (do not commit these) ===');
  console.log('OPENACH_BASE_URL=' + LOCAL_URL);
  console.log('OPENACH_HOST_HEADER=' + HOST_HEADER);
  console.log('OPENACH_API_TOKEN=' + TOKEN);
  console.log('OPENACH_API_KEY=' + KEY);
  if (standard) console.log('OPENACH_PAYMENT_TYPE_ID=' + standard);
  if (sameDay) console.log('OPENACH_SAME_DAY_PAYMENT_TYPE_ID=' + sameDay);
  if (!sameDay) {
    console.log('# no same-day payment type found: set OPENACH_RAILS=ach_standard to close that rail');
  }
  console.log('\nThen check the rail with: curl -s localhost:3002/api/openach-rail/health');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
