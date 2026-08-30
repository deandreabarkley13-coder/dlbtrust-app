/**
 * OpenACH api credential provisioning — run by an operator against the
 * Northflank OpenACH service
 *
 * OpenACH authenticates the in-house bank's ACH rail with an api token/key pair
 * that only exists as a row in OpenACH's own database, so the pair cannot be
 * issued from the application side: it has to be generated and registered where
 * that database lives. This script does both over the OpenACH Postgres addon,
 * then proves the pair works by opening a session against the service's api and
 * reading back the payment types the rail needs.
 *
 *   OPENACH_DATABASE_URL=postgres://... \
 *   OPENACH_BASE_URL=https://<openach-service>.code.run/api \
 *     node server/integrations/openach/server-side-setup.js
 *
 * The installation itself (originator, ODFI branch, settlement account, payment
 * types) is bootstrapped inside the service with `openach-bootstrap` — see
 * docs/OPENACH_NORTHFLANK.md. This script only issues credentials against it.
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
 *   OPENACH_ORIGINATOR_ID pin the originator info id instead of taking the first one
 *   OPENACH_HOST_HEADER   host header to send, when the service sits behind a proxy
 */

'use strict';

const crypto = require('crypto');
const { Client } = require('pg');

const DATABASE_URL = process.env.OPENACH_DATABASE_URL || process.env.OPENACH_DB_URL;
const BASE_URL = (process.env.OPENACH_BASE_URL || '').replace(/\/$/, '');
const HOST_HEADER = process.env.OPENACH_HOST_HEADER || null;
const REVOKE_TOKEN = process.env.OPENACH_REVOKE_TOKEN || null;

// Generated here rather than defaulted to a literal: a credential committed to
// the repository is a credential that has to be rotated.
const TOKEN = process.env.OPENACH_API_TOKEN || crypto.randomUUID();
const KEY = process.env.OPENACH_API_KEY || crypto.randomUUID();
const GENERATED = !process.env.OPENACH_API_TOKEN || !process.env.OPENACH_API_KEY;

/** POST form-encoded to the OpenACH api, carrying the php session when given. */
async function api(endpoint, { data = null, cookie = null } = {}) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (cookie) headers.Cookie = cookie;
  if (HOST_HEADER) headers.Host = HOST_HEADER;

  const res = await fetch(`${BASE_URL}/${endpoint}`, {
    method: 'POST',
    headers,
    body: data ? new URLSearchParams(data).toString() : '',
  });
  const raw = await res.text();
  try {
    return JSON.parse(raw);
  } catch {
    return { raw: raw.slice(0, 500) };
  }
}

async function main() {
  console.log('=== OpenACH api credential provisioning ===\n');

  if (!DATABASE_URL) {
    console.error('OPENACH_DATABASE_URL is required (the OpenACH Postgres addon connection string).');
    process.exit(1);
  }
  if (!BASE_URL) {
    console.error('OPENACH_BASE_URL is required (e.g. https://<openach-service>.code.run/api).');
    process.exit(1);
  }

  const db = new Client({
    connectionString: DATABASE_URL,
    ssl: /sslmode=disable/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
  });
  await db.connect();

  try {
    console.log('[1] Reading the OpenACH user and originator to attach the credential to');
    const userId = process.env.OPENACH_USER_ID
      || (await db.query(
        `SELECT user_id FROM "user" WHERE user_status = 'enabled' ORDER BY user_id LIMIT 1`
      )).rows[0]?.user_id;
    const originatorInfoId = process.env.OPENACH_ORIGINATOR_ID
      || (await db.query(
        `SELECT originator_info_id FROM originator_info ORDER BY originator_info_id LIMIT 1`
      )).rows[0]?.originator_info_id;

    if (!userId || !originatorInfoId) {
      console.error('    OpenACH has no user / originator yet — run `openach-bootstrap` in the');
      console.error('    OpenACH service first (see docs/OPENACH_NORTHFLANK.md).');
      process.exit(1);
    }
    console.log(`    user       ${userId}`);
    console.log(`    originator ${originatorInfoId}`);

    console.log(`\n[2] Registering the api credential (${GENERATED ? 'generated here' : 'taken from the environment'})`);
    const existing = await db.query(
      'SELECT user_api_status FROM user_api WHERE user_api_token = $1',
      [TOKEN]
    );
    if (existing.rowCount) {
      // Re-registering the same token must not silently leave it disabled.
      await db.query(
        `UPDATE user_api
            SET user_api_key = $2,
                user_api_user_id = $3,
                user_api_originator_info_id = $4,
                user_api_status = 'enabled'
          WHERE user_api_token = $1`,
        [TOKEN, KEY, userId, originatorInfoId]
      );
      console.log('    already present; re-pointed and enabled');
    } else {
      await db.query(
        `INSERT INTO user_api (
            user_api_token, user_api_key, user_api_datetime,
            user_api_user_id, user_api_originator_info_id, user_api_status
         ) VALUES ($1, $2, now(), $3, $4, 'enabled')`,
        [TOKEN, KEY, userId, originatorInfoId]
      );
      console.log('    registered');
    }

    if (REVOKE_TOKEN) {
      console.log('\n[2b] Disabling the superseded token');
      const revoked = await db.query(
        `UPDATE user_api SET user_api_status = 'disabled' WHERE user_api_token = $1`,
        [REVOKE_TOKEN]
      );
      console.log(revoked.rowCount ? '    disabled' : '    no row for that token');
    }
  } finally {
    await db.end();
  }

  console.log('\n[3] Opening a session with the credential');
  const connected = await api('connect', { data: { user_api_token: TOKEN, user_api_key: KEY } });
  if (!connected.success || !connected.session_id) {
    console.error('    The credential did not authenticate:', JSON.stringify(connected));
    process.exit(1);
  }
  const cookie = `PHPSESSID=${connected.session_id}`;
  console.log('    authenticated');

  console.log('\n[4] Reading the payment types the ACH rail originates against');
  const types = await api('getPaymentTypes', { cookie });
  const list = Array.isArray(types) ? types : (types.payment_types || types.data || []);
  let standard = null;
  let sameDay = null;
  if (Array.isArray(list) && list.length) {
    list.forEach(type => {
      const name = String(type.payment_type_name || '');
      console.log(`    ${type.payment_type_id}  ${name}  ${type.payment_type_transaction_type || ''}`);
      const lower = name.toLowerCase();
      if (!sameDay && /same[\s-]?day/.test(lower)) {
        sameDay = type.payment_type_id;
      } else if (!standard && type.payment_type_transaction_type === 'credit') {
        standard = type.payment_type_id;
      }
    });
    if (!standard) standard = list[0].payment_type_id;
  } else {
    console.log('    OpenACH returned no payment types:', JSON.stringify(types));
  }

  await api('disconnect', { cookie });

  console.log('\n=== Add to the app environment (do not commit these) ===');
  console.log('OPENACH_BASE_URL=' + BASE_URL);
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
