'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const paymentCrypto = require('./paymentCrypto');
const { readiness, isSecureEndpoint } = require('./paymentHubConfig');
const { PaymentHubClient } = require('./paymentHubClient');
const { PaymentHubEngine } = require('./paymentHubEngine');
const { generateNACHAFile, parseNACHAFile, validateRouting } = require('../ach/nachaGenerator');
const { OpenBankApi } = require('../ach/openBankApi');

async function testCrypto() {
  process.env.PAYMENT_DATA_ENCRYPTION_KEY = '11'.repeat(32);
  const encrypted = paymentCrypto.encrypt('123456789');
  assert.ok(encrypted.startsWith('enc:v1:'));
  assert.strictEqual(paymentCrypto.decrypt(encrypted), '123456789');
  assert.notStrictEqual(encrypted, paymentCrypto.encrypt('123456789'));
  assert.strictEqual(paymentCrypto.mask('123456789'), '*****6789');
  assert.strictEqual(paymentCrypto.timingSafeEqual('same', 'same'), true);
  assert.strictEqual(paymentCrypto.timingSafeEqual('same', 'different'), false);
  assert.strictEqual(paymentCrypto.validateConfiguration(), true);
  assert.strictEqual(isSecureEndpoint('https://payments.example.test/callback'), true);
  assert.strictEqual(isSecureEndpoint('http://payment-hub.svc.cluster.local/callback'), true);
  assert.strictEqual(isSecureEndpoint('http://payments.example.test/callback'), false);

  process.env.NODE_ENV = 'production';
  process.env.PAYMENT_DATA_ENCRYPTION_KEY = 'not-a-valid-production-encryption-key';
  assert.throws(() => paymentCrypto.encrypt('sensitive'), /32-byte base64 value or 64 hex characters/);
  assert.throws(() => paymentCrypto.validateConfiguration(), /32-byte base64 value or 64 hex characters/);
  process.env.PAYMENT_DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  assert.strictEqual(paymentCrypto.validateConfiguration(), true);
  process.env.NODE_ENV = 'test';
  process.env.PAYMENT_DATA_ENCRYPTION_KEY = '11'.repeat(32);
}

async function testNacha() {
  assert.strictEqual(validateRouting('021000021'), true);
  assert.strictEqual(validateRouting('021000022'), false);
  const content = generateNACHAFile({
    immediateDestination: '021000021',
    immediateDestinationName: 'TEST ODFI',
    immediateOrigin: '1234567890',
    immediateOriginName: 'DLB TRUST',
    companyName: 'DLB TRUST',
    companyId: 'DLBTRUST01',
    fileCreationDate: new Date('2026-07-12T12:00:00Z'),
  }, [{
    secCode: 'CCD',
    companyEntryDescription: 'PAYMENT',
    effectiveEntryDate: new Date('2026-07-13T12:00:00Z'),
    entries: [{
      receivingRouting: '021000021',
      accountNumber: '1234567890',
      amountCents: 12500,
      transactionCode: '22',
      individualId: 'INTENT-1',
      individualName: 'TEST BENEFICIARY',
    }],
  }]);
  const lines = content.trimEnd().split('\n').map(line => line.replace(/\r$/, ''));
  assert.ok(lines.length >= 10);
  assert.ok(lines.every(line => line.length === 94));
  const parsed = parseNACHAFile(content);
  assert.strictEqual(parsed.fileControl.entryCount, 1);
  assert.strictEqual(parsed.fileControl.totalCredit, 12500);
}

async function testEncryptedAchExport() {
  process.env.NODE_ENV = 'test';
  process.env.PAYMENT_DATA_ENCRYPTION_KEY = '11'.repeat(32);
  const content = '101 TEST NACHA CONTENT';
  const exported = OpenBankApi._exportFile(content, 'payment-hub-test.ach', 'PAYMENT-HUB-TEST');
  try {
    const stored = fs.readFileSync(exported.export_path, 'utf8');
    assert.ok(stored.startsWith('enc:v1:'));
    assert.strictEqual(stored.includes(content), false);
    assert.strictEqual(paymentCrypto.decrypt(stored), content);
    const listed = OpenBankApi.listExports('PAYMENT-HUB-TEST');
    assert.strictEqual(listed.some(file => file.filename === 'payment-hub-test.ach'), true);
    assert.strictEqual(listed.some(file => Object.hasOwn(file, 'path')), false);
  } finally {
    fs.rmSync(exported.export_path, { force: true });
  }
}

async function testBankWebhook() {
  const payload = { event: 'ach.settled', batch_id: 'BATCH-1' };
  const rawBody = Buffer.from(JSON.stringify(payload));
  const webhookSecret = 'test-bank-webhook-secret';
  const signature = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const event = OpenBankApi.processWebhook('BANK-1', payload, signature, { webhookSecret }, rawBody);
  assert.strictEqual(event.mapped_status, 'settled');
  assert.throws(
    () => OpenBankApi.processWebhook('BANK-1', payload, signature, {}, rawBody),
    /Webhook secret is not configured/
  );
  assert.throws(
    () => OpenBankApi.processWebhook('BANK-1', payload, 'bad-signature', { webhookSecret }, rawBody),
    /Invalid webhook signature/
  );

  const acceptedPayload = { event: 'ach.accepted', batch_id: 'BATCH-1', transaction_id: 'TXN-1' };
  const settledPayload = { event: 'ach.settled', batch_id: 'BATCH-1', transaction_id: 'TXN-1' };
  const acceptedRaw = Buffer.from(JSON.stringify(acceptedPayload));
  const settledRaw = Buffer.from(JSON.stringify(settledPayload));
  const acceptedSignature = crypto.createHmac('sha256', webhookSecret).update(acceptedRaw).digest('hex');
  const settledSignature = crypto.createHmac('sha256', webhookSecret).update(settledRaw).digest('hex');
  const acceptedEvent = OpenBankApi.processWebhook('BANK-1', acceptedPayload, acceptedSignature, { webhookSecret }, acceptedRaw);
  const settledEvent = OpenBankApi.processWebhook('BANK-1', settledPayload, settledSignature, { webhookSecret }, settledRaw);
  assert.notStrictEqual(acceptedEvent.external_event_id, settledEvent.external_event_id);
}

async function testClient() {
  let request;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      request = { headers: req.headers, body: JSON.parse(body) };
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ transactionId: 'PHEE-123', status: 'ORCHESTRATING' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  process.env.NODE_ENV = 'test';
  process.env.PAYMENT_HUB_MODE = 'phee';
  process.env.PAYMENT_HUB_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.PAYMENT_HUB_AUTH_TOKEN = 'test-token';
  process.env.PAYMENT_HUB_SERVICE_TOKEN = 'service-token';
  process.env.PAYMENT_HUB_WEBHOOK_SECRET = 'webhook-secret';
  process.env.PAYMENT_HUB_CALLBACK_URL = 'http://127.0.0.1/callback';
  process.env.PAYMENT_HUB_ACH_CONNECTOR_URL = 'http://127.0.0.1/connector';
  process.env.PAYMENT_HUB_MAX_RETRIES = '0';

  assert.strictEqual(readiness().ready, true);
  assert.strictEqual(readiness().canTransmit, false);
  try {
    const result = await PaymentHubClient.submit({
      intent_id: 'PAY-123',
      idempotency_key: 'idem-123',
      amount_cents: 12500,
      currency: 'USD',
      source_account_code: '1000',
      source_sub_ledger_id: null,
      beneficiary_name: 'TEST BENEFICIARY',
      beneficiary_account_type: 'checking',
      beneficiary_routing: '021000021',
      beneficiary_account: '1234567890',
      payment_type: 'vendor_payment',
      sec_code: 'CCD',
      effective_date: '2026-07-13',
      description: 'Invoice payment',
    });
    assert.strictEqual(result.externalId, 'PHEE-123');
    assert.strictEqual(Object.hasOwn(result, 'response'), false);
    await assert.rejects(
      PaymentHubEngine.executeAchConnector('PAY-123', 'test-service'),
      /PAYMENT_HUB_LIVE=true/
    );
    assert.strictEqual(request.headers['idempotency-key'], 'idem-123');
    assert.strictEqual(request.body.amount.amount, '125.00');
    assert.strictEqual(request.body.extensions.dlbTrustIntentId, 'PAY-123');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function main() {
  const originalEnv = { ...process.env };
  try {
    await testCrypto();
    await testNacha();
    await testEncryptedAchExport();
    await testBankWebhook();
    await testClient();
    console.log('Payment Hub validation passed');
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
