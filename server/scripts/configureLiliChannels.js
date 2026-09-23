'use strict';

/**
 * Lili channel bootstrap (run after terraform apply + secret seeding +
 * liliMcpOAuthSetup.js).
 *
 * Wires the two Lili channels on the deployed app and refuses to exit 0 until
 * both report ready:
 *
 *   1. Destination (RDFI)  — POST /api/finops/lili/direct-deposits/destination
 *      (LiliDirectDepositEngine.setDestination). Tries
 *      syncDestinationFromLili first when the MCP is configured; Lili returns
 *      the account number masked, so the full LILI_DD_ACCOUNT_NUMBER is
 *      always keyed from env.
 *   2. Readiness — GET /api/finops/lili/settlement-bank/status
 *      (LiliSettlementBankEngine.status) and
 *      GET /api/finops/lili/direct-deposits/status
 *      (LiliDirectDepositEngine.getWorkflowStatus). Exit 0 only when
 *      mode=live, destination.configured, odfi.ready and mcp.configured.
 *
 * Usage:
 *   ADMIN_TOKEN=... API_BASE=https://<cloud run url> \
 *   LILI_DD_ROUTING_NUMBER=121145307 LILI_DD_ACCOUNT_NUMBER=... LILI_DD_ACCOUNT_NAME="DB NET MGMT LLC" \
 *     node server/scripts/configureLiliChannels.js
 *
 *   --dry-run        validate env + readiness fields only; no writes
 *   --skip-sync      do not call syncDestinationFromLili
 *   --transmit       flush the awaiting_odfi backlog (transmitQueued) once ready
 */

const { URL } = require('url');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const API_BASE = process.env.API_BASE || process.env.APP_URL || 'https://dlbtrust-app-r5oawu76jq-ue.a.run.app';
const ARGS = new Set(process.argv.slice(2));
const DRY_RUN = ARGS.has('--dry-run');
const SKIP_SYNC = ARGS.has('--skip-sync');
const TRANSMIT = ARGS.has('--transmit');

const REQUIRED_READINESS = [
  ['mode', (s) => s.mode === 'live', 'LILI_CLEARING_LIVE=true'],
  ['destination.configured', (s) => s.destination && s.destination.configured === true, 'LILI_DD_ROUTING_NUMBER / LILI_DD_ACCOUNT_NUMBER'],
  ['odfi.ready', (s) => s.odfi && s.odfi.ready === true, 'an external ODFI channel (ACH_SFTP_URL / ACH_MFT_CHANNEL / AS2 partner)'],
  ['mcp.configured', (s) => s.mcp && s.mcp.configured === true, 'Lili MCP OAuth (liliMcpOAuthSetup.js or LILI_OAUTH_* secrets)'],
];

function destinationFromEnv() {
  return {
    routingNumber: process.env.LILI_DD_ROUTING_NUMBER || null,
    accountNumber: process.env.LILI_DD_ACCOUNT_NUMBER || null,
    accountName: process.env.LILI_DD_ACCOUNT_NAME || 'DB NET MGMT LLC',
  };
}

/** Returns the readiness fields that fail on a LiliSettlementBankEngine.status() payload. */
function validateReadiness(status) {
  if (!status || typeof status !== 'object') return REQUIRED_READINESS.map(([field, , fix]) => ({ field, fix }));
  return REQUIRED_READINESS.filter(([, ok]) => !ok(status)).map(([field, , fix]) => ({ field, fix }));
}

function requestJson(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, API_BASE);
    const postData = body ? JSON.stringify(body) : null;
    const req = require(url.protocol === 'https:' ? 'https' : 'http').request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search || ''}`,
      method,
      headers: {
        'x-admin-token': ADMIN_TOKEN,
        ...(postData ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function redact(dest) {
  return { ...dest, accountNumber: dest.accountNumber ? `****${String(dest.accountNumber).slice(-4)}` : null };
}

async function configureDestination(env) {
  if (!env.routingNumber || !env.accountNumber) {
    throw new Error('LILI_DD_ROUTING_NUMBER and LILI_DD_ACCOUNT_NUMBER are required (full account number; Lili MCP only returns it masked)');
  }
  let synced = null;
  if (!SKIP_SYNC) {
    const r = await requestJson('POST', '/api/finops/lili/direct-deposits/destination/sync', {});
    synced = r.body && r.body.success ? r.body.data : null;
    if (synced && synced.routingNumber && String(synced.routingNumber) !== String(env.routingNumber)) {
      throw new Error(`Lili MCP reports routing ${synced.routingNumber} but LILI_DD_ROUTING_NUMBER=${env.routingNumber}; refusing to register a mismatched destination`);
    }
    if (synced && synced.accountNumberMasked && String(synced.accountNumberMasked).slice(-4) !== String(env.accountNumber).slice(-4)) {
      throw new Error(`Lili MCP reports account ${synced.accountNumberMasked} but LILI_DD_ACCOUNT_NUMBER ends in ${String(env.accountNumber).slice(-4)}; refusing to register a mismatched destination`);
    }
    console.log(synced ? `syncDestinationFromLili: ${JSON.stringify(synced)}` : `syncDestinationFromLili unavailable (${JSON.stringify(r.body && r.body.error || r.status)}); using keyed values`);
  }
  const set = await requestJson('POST', '/api/finops/lili/direct-deposits/destination', env);
  if (!set.body || !set.body.success) throw new Error(`setDestination failed: ${JSON.stringify(set.body)}`);
  console.log('destination:', JSON.stringify(set.body.data));
  return set.body.data;
}

async function main() {
  const env = destinationFromEnv();
  console.log(`Lili channel bootstrap against ${API_BASE}${DRY_RUN ? ' (dry run)' : ''}`);
  console.log('destination from env:', JSON.stringify(redact(env)));

  if (DRY_RUN) {
    const missing = [];
    if (!env.routingNumber) missing.push('LILI_DD_ROUTING_NUMBER');
    if (!env.accountNumber) missing.push('LILI_DD_ACCOUNT_NUMBER');
    if (missing.length) { console.error('missing:', missing.join(', ')); process.exit(2); }
    if (!ADMIN_TOKEN) { console.log('ADMIN_TOKEN not set; env validated, skipping remote readiness'); return; }
  } else {
    if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN is required');
    await configureDestination(env);
  }

  const [bank, workflow] = await Promise.all([
    requestJson('GET', '/api/finops/lili/settlement-bank/status'),
    requestJson('GET', '/api/finops/lili/direct-deposits/status'),
  ]);
  if (!bank.body || !bank.body.success) throw new Error(`settlement-bank/status failed: ${JSON.stringify(bank.body)}`);
  if (!workflow.body || !workflow.body.success) throw new Error(`direct-deposits/status failed: ${JSON.stringify(workflow.body)}`);

  console.log('\nLiliSettlementBankEngine.status():\n' + JSON.stringify(bank.body.data, null, 2));
  console.log('\nLiliDirectDepositEngine.getWorkflowStatus():\n' + JSON.stringify(workflow.body.data, null, 2));

  const failures = validateReadiness(bank.body.data);
  if (failures.length) {
    console.error('\nNOT READY:');
    for (const f of failures) console.error(`  - ${f.field}: configure ${f.fix}`);
    process.exit(1);
  }

  if (TRANSMIT && !DRY_RUN) {
    const t = await requestJson('POST', '/api/finops/lili/direct-deposits/transmit-queued', {});
    console.log('\ntransmitQueued:', JSON.stringify(t.body));
  } else {
    const queued = workflow.body.data.counts && workflow.body.data.counts.awaiting_odfi;
    if (queued && queued.count) console.log(`\n${queued.count} deposit(s) awaiting_odfi — rerun with --transmit (LiliDirectDepositEngine.transmitQueued) to flush.`);
  }
  console.log('\nREADY: treasury -> Lili ACH credit can originate (live, destination + ODFI + MCP reconciliation configured).');
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}

module.exports = { validateReadiness, destinationFromEnv, REQUIRED_READINESS };
