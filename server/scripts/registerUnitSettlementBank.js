'use strict';

/**
 * Register the trust's Unit (Unit Finance BaaS) settlement bank.
 *
 * Upserts bank_id='unit-operating' (UNIT_SETTLEMENT_BANK_ID) with provider='unit'
 * in settlement_banks so BankSettlementEngine settles it through
 * PartnerBankRails (PARTNER_BANK_PROVIDER=unit). Idempotent: re-running updates
 * the row in place.
 *
 * Destination (one of):
 *   UNIT_SETTLEMENT_ROUTING_NUMBER + UNIT_SETTLEMENT_ACCOUNT_NUMBER  inline ACH/wire beneficiary
 *   UNIT_SETTLEMENT_COUNTERPARTY_ID      pre-created Unit counterparty id (ACH)
 *   UNIT_SETTLEMENT_RECEIVING_ACCOUNT_ID another Unit deposit account of the trust (book payment)
 * Optional: UNIT_SETTLEMENT_NAME, UNIT_SETTLEMENT_ACCOUNT_NAME, UNIT_SETTLEMENT_RAIL (ach|wire).
 *
 * Usage:
 *   DATABASE_URL=... node server/scripts/registerUnitSettlementBank.js
 *     writes directly via SettlementBankRegistry.register (Cloud SQL via the
 *     Cloud SQL Auth Proxy).
 *   API_BASE=https://... PAYMENT_SERVER_SERVICE_TOKEN=... \
 *     node server/scripts/registerUnitSettlementBank.js --via-api
 *     POSTs /api/payment-server/v1/settlement-banks and prints its readiness;
 *     IAP_ID_TOKEN (optional) is sent as Proxy-Authorization for IAP-fronted hosts.
 *   --dry-run prints the registration payload (account number masked) and exits.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const VIA_API = process.argv.includes('--via-api');
const DRY_RUN = process.argv.includes('--dry-run');

function env(name) {
  return String(process.env[name] || '').trim();
}

function buildRegistration() {
  const receivingAccountId = env('UNIT_SETTLEMENT_RECEIVING_ACCOUNT_ID');
  const registration = {
    bankId: env('UNIT_SETTLEMENT_BANK_ID') || 'unit-operating',
    provider: 'unit',
    name: env('UNIT_SETTLEMENT_NAME') || 'Unit',
    routingNumber: env('UNIT_SETTLEMENT_ROUTING_NUMBER') || undefined,
    accountNumber: env('UNIT_SETTLEMENT_ACCOUNT_NUMBER') || undefined,
    accountName: env('UNIT_SETTLEMENT_ACCOUNT_NAME') || env('PARTNER_BANK_ACCOUNT_LABEL') || undefined,
    endpointId: env('UNIT_SETTLEMENT_COUNTERPARTY_ID') || undefined,
    rail: env('UNIT_SETTLEMENT_RAIL') || 'ach',
    metadata: {
      partnerBank: 'unit',
      ...(receivingAccountId ? { receivingAccountId } : {}),
    },
  };
  if (!(registration.routingNumber && registration.accountNumber) && !registration.endpointId && !receivingAccountId) {
    throw new Error(
      'Set UNIT_SETTLEMENT_ROUTING_NUMBER + UNIT_SETTLEMENT_ACCOUNT_NUMBER, UNIT_SETTLEMENT_COUNTERPARTY_ID'
      + ' or UNIT_SETTLEMENT_RECEIVING_ACCOUNT_ID'
    );
  }
  if (!['ach', 'wire'].includes(registration.rail)) throw new Error('UNIT_SETTLEMENT_RAIL must be ach or wire');
  return registration;
}

function masked(registration) {
  const { accountNumber, ...rest } = registration;
  return { ...rest, accountNumber: accountNumber ? `****${accountNumber.slice(-4)}` : undefined };
}

function requestJson(method, urlPath, body) {
  const base = env('API_BASE') || env('APP_URL');
  const token = env('PAYMENT_SERVER_SERVICE_TOKEN');
  if (!base || !token) throw new Error('--via-api requires API_BASE and PAYMENT_SERVER_SERVICE_TOKEN');
  const url = new URL(urlPath, base);
  const payload = body ? JSON.stringify(body) : null;
  const iap = env('IAP_ID_TOKEN');
  const headers = {
    'x-payment-server-service-token': token,
    Authorization: `Bearer ${token}`,
    ...(iap ? { 'Proxy-Authorization': `Bearer ${iap}` } : {}),
    Accept: 'application/json',
    ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
  };
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch (e) { /* non-JSON body */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`${method} ${url.pathname} timed out`)); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function viaApi(registration) {
  const created = await requestJson('POST', '/api/payment-server/v1/settlement-banks', registration);
  if (created.status !== 201) throw new Error(`register failed (${created.status}): ${JSON.stringify(created.body)}`);
  console.log('Registered:', JSON.stringify(created.body.data, null, 2));
  const readiness = await requestJson('GET', `/api/payment-server/v1/settlement-banks/${encodeURIComponent(registration.bankId)}/readiness`);
  console.log(`Readiness (${readiness.status}):`, JSON.stringify(readiness.body, null, 2));
}

async function direct(registration) {
  const { SettlementBankRegistry } = require('../integrations/payments/settlementBankRegistry');
  const bank = await SettlementBankRegistry.register({ ...registration, createdBy: 'registerUnitSettlementBank' });
  console.log('Registered:', JSON.stringify(SettlementBankRegistry.publicView(bank), null, 2));
}

async function main() {
  const registration = buildRegistration();
  if (DRY_RUN) {
    console.log(JSON.stringify(masked(registration), null, 2));
    return;
  }
  if (VIA_API) await viaApi(registration);
  else await direct(registration);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message || e); process.exit(1); });
