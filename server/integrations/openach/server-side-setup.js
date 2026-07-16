/**
 * Server-Side OpenACH Setup Script
 * Run this DIRECTLY on the IONOS server (not from local):
 * 
 *   node /var/www/vhosts/dlbtrust.cloud/httpdocs/server/integrations/openach/server-side-setup.js
 * 
 * It will:
 *   1. Insert API credentials into the OpenACH SQLite DB via Docker exec
 *   2. Test the API connection (localhost, no TLS issues)
 *   3. Retrieve the Trust Dist payment_type_id
 *   4. Print the .env values you need to add
 */

const { execSync } = require('child_process');
const https = require('https');
const http = require('http');

const TOKEN = '3caee1c2-c218-4959-b6d2-21d4b2a1b42e';
const KEY   = 'b74966cf-5276-4d8b-8650-5bd57dcee272';
const USER_ID          = '4fc86059-2e7b-4732-b94f-e7c3715ee8d7';
const ORIGINATOR_INFO  = '0eb26e1d-5fcc-4978-a132-dd93c2655429';

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 15000 }).trim();
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

function post(url, data) {
  return new Promise((resolve) => {
    const body = new URLSearchParams(data).toString();
    // Use HTTP to avoid TLS issues on localhost routing
    const req = http.request(url.replace('https://', 'http://'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Host': 'ach.dlbtrust.cloud',
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); }
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('=== OpenACH Server-Side Setup ===\n');

  // Step 1: Find the container
  console.log('[1] Finding OpenACH container...');
  const container = run(`docker ps --format "{{.Names}}" | grep openach | head -1`);
  if (!container || container.startsWith('ERROR')) {
    console.error('Cannot find OpenACH container. Is Docker running?');
    console.error(container);
    process.exit(1);
  }
  console.log(`    Container: ${container}`);

  // Step 2: Find DB path
  const dbPath = run(`docker exec ${container} find /var/www/html -name "openach.db" 2>/dev/null | head -1`) 
    || '/var/www/html/protected/runtime/db/openach.db';
  console.log(`    DB: ${dbPath}`);

  // Step 3: Check if credentials already exist
  console.log('\n[2] Checking for existing API credentials...');
  const existing = run(`docker exec ${container} sqlite3 "${dbPath}" "SELECT user_api_token, user_api_key FROM user_api WHERE user_api_token='${TOKEN}' LIMIT 1;"`);
  
  if (existing && !existing.startsWith('ERROR') && existing.includes(TOKEN)) {
    console.log('    Credentials already exist. Skipping insert.');
  } else {
    // Step 4: Insert credentials
    console.log('\n[3] Inserting API credentials into OpenACH DB...');
    const insertSQL = `INSERT INTO user_api (user_api_user_id, user_api_datetime, user_api_originator_info_id, user_api_token, user_api_key, user_api_status) VALUES ('${USER_ID}', datetime('now'), '${ORIGINATOR_INFO}', '${TOKEN}', '${KEY}', 'enabled');`;
    const insertResult = run(`docker exec ${container} sqlite3 "${dbPath}" "${insertSQL}"`);
    if (insertResult.startsWith('ERROR')) {
      console.error('    Insert failed:', insertResult);
      // Try the CLI method as fallback
      console.log('\n    Trying CLI method...');
      const cliResult = run(`docker exec ${container} bash -c "cd /var/www/html/protected && php ../yiic apiuser create --user_id=${USER_ID} --originator_info_id=${ORIGINATOR_INFO}"`);
      console.log('    CLI result:', cliResult);
    } else {
      console.log('    Insert OK');
    }
  }

  // Step 5: Test API connection (use HTTP directly to avoid TLS on server)
  console.log('\n[4] Testing API connection via localhost...');
  const connectResult = run(`curl -s -X POST http://localhost/openach/api/connect \
    -H "Host: ach.dlbtrust.cloud" \
    --data "user_api_token=${TOKEN}&user_api_key=${KEY}"`);
  console.log('    Connect result:', connectResult);

  let sessionCookie = null;
  try {
    const parsed = JSON.parse(connectResult);
    if (parsed.success) {
      console.log('    ✅ API Connected! Session:', parsed.session_id);
      sessionCookie = `PHPSESSID=${parsed.session_id}`;
    } else {
      console.error('    ❌ Connect failed:', parsed.error);
    }
  } catch (e) {
    console.error('    Could not parse connect response');
  }

  // Step 6: Get payment types
  if (sessionCookie) {
    console.log('\n[5] Fetching payment types...');
    const typesResult = run(`curl -s -X POST http://localhost/openach/api/getPaymentTypes \
      -H "Host: ach.dlbtrust.cloud" \
      -H "Cookie: ${sessionCookie}"`);
    console.log('    Payment types:', typesResult);

    try {
      const types = JSON.parse(typesResult);
      if (Array.isArray(types)) {
        const trustDist = types.find(t => 
          (t.payment_type_name || '').toLowerCase().includes('trust') ||
          (t.payment_type_name || '').toLowerCase().includes('dist')
        );
        if (trustDist) {
          console.log('\n    ✅ Trust Dist payment_type_id:', trustDist.payment_type_id);
          console.log('    Add to .env: OPENACH_PAYMENT_TYPE_ID=' + trustDist.payment_type_id);
        } else {
          console.log('\n    Available types:');
          types.forEach(t => console.log(`      - ${t.payment_type_id}: ${t.payment_type_name}`));
        }
      }
    } catch (e) {}

    // Disconnect
    run(`curl -s http://localhost/openach/api/disconnect -H "Host: ach.dlbtrust.cloud" -H "Cookie: ${sessionCookie}"`);
  }

  console.log('\n=== Summary ===');
  console.log('Add these to your server .env:');
  console.log(`OPENACH_BASE_URL=http://localhost/openach/api`);
  console.log(`OPENACH_API_TOKEN=${TOKEN}`);
  console.log(`OPENACH_API_KEY=${KEY}`);
  console.log('\nAlso add to server.js:');
  console.log(`  app.use('/api/payments', require('./server/integrations/openach/../../../server/routes/payments'));`);
}

main().catch(console.error);
