#!/usr/bin/env node
'use strict';

/**
 * Send a fiat payment through the PTC Bank OS engine.
 *
 * Usage:
 *   ADMIN_SECRET_TOKEN=dlb-admin-2026-trust node server/scripts/sendPaymentViaPtcBank.js \
 *     --action originatePayment \
 *     --fromAccountId TBA-xxx \
 *     --amount 100 \
 *     --routing 111000025 \
 *     --account 000123456789 \
 *     --name "Vendor Inc" \
 *     --bankName "Example Bank" \
 *     --rail book_transfer
 *
 * Full one-shot demo (creates customer + account + deposit + payment):
 *   ADMIN_SECRET_TOKEN=dlb-admin-2026-trust node server/scripts/sendPaymentViaPtcBank.js \
 *     --action full \
 *     --name "PTC Customer" \
 *     --accountName "PTC Checking" \
 *     --amount 100 \
 *     --routing 111000025 \
 *     --account 000123456789 \
 *     --payeeName "Vendor Inc" \
 *     --rail book_transfer
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
  const url = `${BASE_URL}/api/os/ptc-bank/process`;
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
    throw new Error(`PTC Bank ${action} failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  const a = parseArgs();
  const action = a.action || 'full';

  if (action === 'full') {
    required(a, ['name', 'amount', 'routing', 'account']);
    const amount = Number(a.amount);
    if (!amount || amount <= 0) throw new Error('--amount must be positive');

    console.log('Creating PTC Bank customer...');
    const customer = await call('createCustomer', { name: a.name, email: a.email || '', phone: a.phone || '' });
    const customerId = customer.data && customer.data.customer_id;
    if (!customerId) throw new Error('createCustomer did not return customer_id');
    console.log(`Customer: ${customerId}`);

    console.log('Creating PTC Bank account...');
    const accountName = a.accountName || `${a.name} Checking`;
    const account = await call('createAccount', {
      customerId,
      accountName,
      accountType: a.accountType || 'checking',
      linkedCashAccountId: a.linkedCashAccountId || '',
    });
    const accountId = account.data && account.data.account_id;
    if (!accountId) throw new Error('createAccount did not return account_id');
    console.log(`Account: ${accountId}`);

    console.log(`Depositing $${amount.toFixed(2)} into account...`);
    await call('deposit', { accountId, amount, description: a.description || 'CLI deposit' });

    console.log('Originating external payment...');
    const paymentResult = await call('originatePayment', {
      fromAccountId: accountId,
      externalRouting: a.routing,
      externalAccount: a.account,
      externalAccountName: a.payeeName || a.name,
      externalBankName: a.bankName || 'External Bank',
      amount,
      rail: a.rail || 'book_transfer',
      description: a.memo || `PTC Bank payment from ${accountId}`,
    });
    const paymentId = paymentResult.data && paymentResult.data.paymentId;
    console.log(`Payment originated: ${paymentId}`);

    if (a.rail && a.rail !== 'book_transfer') {
      console.log('Sending payment...');
      const sent = await call('sendPayment', { paymentId });
      console.log(JSON.stringify(sent, null, 2));
      return;
    }

    console.log('Book transfer payment created. Call sendPayment to transmit, or settle manually.');
    console.log(JSON.stringify(paymentResult, null, 2));
    return;
  }

  if (action === 'originatePayment') {
    required(a, ['fromAccountId', 'amount', 'routing', 'account']);
    const amount = Number(a.amount);
    if (!amount || amount <= 0) throw new Error('--amount must be positive');
    const result = await call('originatePayment', {
      fromAccountId: a.fromAccountId,
      externalRouting: a.routing,
      externalAccount: a.account,
      externalAccountName: a.name || 'External Payee',
      externalBankName: a.bankName || 'External Bank',
      amount,
      rail: a.rail || 'book_transfer',
      description: a.memo || `PTC Bank payment`,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (action === 'sendPayment') {
    required(a, ['paymentId']);
    const result = await call('sendPayment', { paymentId: a.paymentId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (action === 'settlePayment') {
    required(a, ['paymentId']);
    const result = await call('settlePayment', { paymentId: a.paymentId, externalTxId: a.externalTxId || '' });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (action === 'createCustomer') {
    required(a, ['name']);
    const result = await call('createCustomer', { name: a.name, email: a.email || '', phone: a.phone || '' });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (action === 'createAccount') {
    required(a, ['customerId', 'accountName']);
    const result = await call('createAccount', {
      customerId: a.customerId,
      accountName: a.accountName,
      accountType: a.accountType || 'checking',
      linkedCashAccountId: a.linkedCashAccountId || '',
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (action === 'deposit') {
    required(a, ['accountId', 'amount']);
    const amount = Number(a.amount);
    if (!amount || amount <= 0) throw new Error('--amount must be positive');
    const result = await call('deposit', { accountId: a.accountId, amount, description: a.description || 'CLI deposit' });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (action === 'internalTransfer') {
    required(a, ['fromAccountId', 'toAccountId', 'amount']);
    const amount = Number(a.amount);
    if (!amount || amount <= 0) throw new Error('--amount must be positive');
    const result = await call('internalTransfer', {
      fromAccountId: a.fromAccountId,
      toAccountId: a.toAccountId,
      amount,
      description: a.description || 'CLI internal transfer',
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unknown action: ${action}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
