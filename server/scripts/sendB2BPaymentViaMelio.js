#!/usr/bin/env node
'use strict';

/**
 * Send a B2B fiat payment through the Melio OS engine.
 *
 * Usage:
 *   ADMIN_SECRET_TOKEN=dlb-admin-2026-trust node server/scripts/sendB2BPaymentViaMelio.js \
 *     --amount 100 \
 *     --sourceAccountId 1200 \
 *     --sourceType trust \
 *     --vendorName "Vendor Inc" \
 *     --vendorEmail "pay@example.com" \
 *     --vendorAddressLine1 "123 Main St" \
 *     --vendorCity "Austin" \
 *     --vendorState "TX" \
 *     --vendorPostalCode "78701" \
 *     --vendorCountry "US" \
 *     --routing 111000025 \
 *     --account 000123456789 \
 *     --accountType checking \
 *     --deliveryMethod ach \
 *     --memo "B2B vendor payout"
 */

const BASE_URL = (process.env.OS_TEST_BASE_URL || 'http://localhost:3002').replace(/\/$/, '');
const TOKEN = process.env.ADMIN_SECRET_TOKEN || 'dlb-admin-2026-trust';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const k = args[i];
    if (k.startsWith('--')) {
      out[k.slice(2)] = args[i + 1] || '';
      i += 1;
    }
  }
  return out;
}

function required(a, keys) {
  for (const k of keys) {
    if (!a[k]) throw new Error(`Missing required argument: --${k}`);
  }
}

async function call(action, payload) {
  const url = `${BASE_URL}/api/os/melio/process`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': TOKEN,
    },
    body: JSON.stringify({ action, ...payload }),
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  if (!res.ok) {
    throw new Error(`Melio API ${action} failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  const a = parseArgs();
  required(a, ['amount', 'vendorName', 'routing', 'account']);

  const amount = Number(a.amount);
  if (!amount || amount <= 0) throw new Error('--amount must be a positive number');

  const payload = {
    amount,
    sourceType: a.sourceType || 'trust',
    sourceAccountId: a.sourceAccountId || '1000',
    deliveryMethod: a.deliveryMethod || 'ach',
    memo: a.memo || `B2B payment from PTC`,
    vendor: {
      name: a.vendorName,
      email: a.vendorEmail || '',
      address: {
        line1: a.vendorAddressLine1 || '',
        city: a.vendorCity || '',
        state: a.vendorState || '',
        postalCode: a.vendorPostalCode || '',
        country: a.vendorCountry || 'US',
      },
      bankAccount: {
        accountNumber: a.account,
        routingNumber: a.routing,
        accountType: a.accountType || 'checking',
      },
    },
  };

  console.log('Sending B2B payment request to Melio engine...');
  const result = await call('schedulePayment', payload);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
