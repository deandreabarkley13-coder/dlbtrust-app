'use strict';

/**
 * Offline coverage for distributor key custody. No network, no Horizon: every
 * signature is verified locally against the Stellar SDK.
 *
 *   node server/integrations/stablecoin/walletSigner.test.js
 */

const assert = require('assert');
const sdk = require('@stellar/stellar-sdk');
const signing = require('./walletSigner');
const { getConfig } = require('./config');

const SIGNER_ENV = [
  'STABLECOIN_SIGNER',
  'STABLECOIN_SIGNER_TIMEOUT_MS',
  'STABLECOIN_ALLOW_ENV_KEY_MAINNET',
  'STABLECOIN_DISTRIBUTOR_SECRET',
  'STABLECOIN_DISTRIBUTOR_PUBLIC',
  'STABLECOIN_NETWORK',
  'STABLECOIN_MODE',
  'VAULT_ADDR',
  'VAULT_TOKEN',
  'VAULT_TRANSIT_MOUNT',
  'VAULT_TRANSIT_KEY',
  'STABLECOIN_SIGNER_URL',
  'STABLECOIN_SIGNER_TOKEN',
];

function resetEnv() {
  SIGNER_ENV.forEach((k) => { delete process.env[k]; });
}

/** A minimal payment transaction to sign; never submitted anywhere. */
function buildTx(sourcePublic) {
  const account = new sdk.Account(sourcePublic, '1');
  return new sdk.TransactionBuilder(account, {
    fee: sdk.BASE_FEE,
    networkPassphrase: sdk.Networks.TESTNET,
  })
    .addOperation(sdk.Operation.payment({
      destination: sdk.Keypair.random().publicKey(),
      asset: sdk.Asset.native(),
      amount: '1.00',
    }))
    .setTimeout(60)
    .build();
}

/** Confirms a signature is genuinely valid for the tx, not merely well-formed. */
function assertSignedBy(tx, publicKey) {
  assert.strictEqual(tx.signatures.length, 1, 'expected exactly one signature');
  const kp = sdk.Keypair.fromPublicKey(publicKey);
  const sig = tx.signatures[0].signature();
  assert.ok(kp.verify(tx.hash(), sig), 'signature does not verify against the distributor public key');
  const hint = tx.signatures[0].hint();
  assert.deepStrictEqual(
    Buffer.from(hint),
    sdk.StrKey.decodeEd25519PublicKey(publicKey).slice(-4),
    'signature hint does not match the public key'
  );
}

async function withStubbedFetch(handler, fn) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, headers: (init && init.headers) || {}, body });
    return handler(url, body, init);
  };
  try {
    return await fn(calls);
  } finally {
    global.fetch = original;
  }
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

async function testEnvSigner() {
  resetEnv();
  const kp = sdk.Keypair.random();
  process.env.STABLECOIN_DISTRIBUTOR_SECRET = kp.secret();

  const signer = signing.createSigner(getConfig());
  assert.strictEqual(signer.backend, 'env');
  assert.strictEqual(signer.publicKey(), kp.publicKey());

  const tx = buildTx(kp.publicKey());
  await signer.signTransaction(tx);
  assertSignedBy(tx, kp.publicKey());

  // Readiness must expose the public key without unlocking a signer.
  assert.strictEqual(signing.distributorPublicKey(getConfig()), kp.publicKey());

  delete process.env.STABLECOIN_DISTRIBUTOR_SECRET;
  assert.throws(() => signing.createSigner(getConfig()), /STABLECOIN_DISTRIBUTOR_SECRET not configured/);

  process.env.STABLECOIN_DISTRIBUTOR_SECRET = 'not-a-secret';
  assert.throws(() => signing.createSigner(getConfig()), /Invalid Stellar secret key/);
}

async function testMainnetEnvKeyRefused() {
  resetEnv();
  const kp = sdk.Keypair.random();
  process.env.STABLECOIN_DISTRIBUTOR_SECRET = kp.secret();
  process.env.STABLECOIN_NETWORK = 'mainnet';

  assert.throws(() => signing.createSigner(getConfig()), /Refusing to sign mainnet settlement/);

  const status = signing.custodyStatus(getConfig());
  assert.strictEqual(status.keyInEnvironment, true);
  assert.strictEqual(status.custodial, false);
  assert.strictEqual(status.issues.length, 1);
  assert.match(status.issues[0], /Refusing to sign mainnet settlement/);

  // 'mode: mainnet' is production even when the network string is not.
  delete process.env.STABLECOIN_NETWORK;
  process.env.STABLECOIN_MODE = 'mainnet';
  assert.throws(() => signing.createSigner(getConfig()), /Refusing to sign mainnet settlement/);

  // Anything other than an exact opt-in stays refused.
  process.env.STABLECOIN_ALLOW_ENV_KEY_MAINNET = 'yes';
  assert.throws(() => signing.createSigner(getConfig()), /Refusing to sign mainnet settlement/);

  process.env.STABLECOIN_ALLOW_ENV_KEY_MAINNET = 'true';
  const signer = signing.createSigner(getConfig());
  assert.strictEqual(signer.publicKey(), kp.publicKey());

  // A custodian is never blocked on mainnet.
  resetEnv();
  process.env.STABLECOIN_NETWORK = 'mainnet';
  process.env.STABLECOIN_SIGNER = 'vault';
  process.env.STABLECOIN_DISTRIBUTOR_PUBLIC = kp.publicKey();
  process.env.VAULT_ADDR = 'https://vault.internal';
  process.env.VAULT_TOKEN = 'token';
  process.env.VAULT_TRANSIT_KEY = 'dlbtrust-distributor';
  const vaultSigner = signing.createSigner(getConfig());
  assert.strictEqual(vaultSigner.backend, 'vault');
  assert.strictEqual(signing.custodyStatus(getConfig()).custodial, true);
}

async function testVaultSigner() {
  resetEnv();
  const kp = sdk.Keypair.random();
  process.env.STABLECOIN_SIGNER = 'vault';
  process.env.STABLECOIN_DISTRIBUTOR_PUBLIC = kp.publicKey();
  process.env.VAULT_ADDR = 'https://vault.internal/';
  process.env.VAULT_TOKEN = 'vault-token';
  process.env.VAULT_TRANSIT_KEY = 'dlbtrust-distributor';

  const tx = buildTx(kp.publicKey());
  // Vault holds the key; emulate it by signing the submitted payload.
  await withStubbedFetch((url, body) => {
    const payload = Buffer.from(body.input, 'base64');
    return jsonResponse({ data: { signature: `vault:v1:${kp.sign(payload).toString('base64')}` } });
  }, async (calls) => {
    const signer = signing.createSigner(getConfig());
    await signer.signTransaction(tx);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://vault.internal/v1/transit/sign/dlbtrust-distributor');
    assert.strictEqual(calls[0].headers['X-Vault-Token'], 'vault-token');
    assert.strictEqual(calls[0].body.prehashed, false);
    // What Vault signs must be exactly the Stellar signature payload.
    assert.deepStrictEqual(Buffer.from(calls[0].body.input, 'base64'), tx.hash());
    // The secret must never be sent anywhere.
    assert.ok(!JSON.stringify(calls[0].body).includes(kp.secret()));
  });
  assertSignedBy(tx, kp.publicKey());

  process.env.VAULT_TRANSIT_MOUNT = 'trust-transit';
  await withStubbedFetch((url, body) => jsonResponse({
    data: { signature: `vault:v1:${kp.sign(Buffer.from(body.input, 'base64')).toString('base64')}` },
  }), async (calls) => {
    await signing.createSigner(getConfig()).signTransaction(buildTx(kp.publicKey()));
    assert.match(calls[0].url, /\/v1\/trust-transit\/sign\//);
  });

  // Upstream failures must not leak request material.
  await withStubbedFetch(() => jsonResponse({ errors: ['permission denied'] }, 403), async () => {
    await assert.rejects(
      signing.createSigner(getConfig()).signTransaction(buildTx(kp.publicKey())),
      (e) => /vault signer rejected the request: HTTP 403/.test(e.message) && !e.message.includes('permission denied')
    );
  });

  await withStubbedFetch(() => jsonResponse({ data: {} }), async () => {
    await assert.rejects(
      signing.createSigner(getConfig()).signTransaction(buildTx(kp.publicKey())),
      /missing data\.signature/
    );
  });

  // A truncated signature must be rejected rather than attached.
  await withStubbedFetch((url, body) => jsonResponse({
    data: { signature: `vault:v1:${kp.sign(Buffer.from(body.input, 'base64')).slice(0, 32).toString('base64')}` },
  }), async () => {
    await assert.rejects(
      signing.createSigner(getConfig()).signTransaction(buildTx(kp.publicKey())),
      /expected 64 bytes/
    );
  });

  // Wrong signer identity: well-formed signature, wrong key. Must be rejected
  // locally rather than submitted and bounced as tx_bad_auth.
  const other = sdk.Keypair.random();
  await withStubbedFetch((url, body) => jsonResponse({
    data: { signature: `vault:v1:${other.sign(Buffer.from(body.input, 'base64')).toString('base64')}` },
  }), async () => {
    const wrongTx = buildTx(kp.publicKey());
    await assert.rejects(
      signing.createSigner(getConfig()).signTransaction(wrongTx),
      /does not verify against the distributor public key/
    );
    assert.strictEqual(wrongTx.signatures.length, 0);
  });

  delete process.env.VAULT_TOKEN;
  assert.throws(() => signing.createSigner(getConfig()), /VAULT_TOKEN is required/);
}

async function testExternalSigner() {
  resetEnv();
  const kp = sdk.Keypair.random();
  process.env.STABLECOIN_SIGNER = 'external';
  process.env.STABLECOIN_DISTRIBUTOR_PUBLIC = kp.publicKey();
  process.env.STABLECOIN_SIGNER_URL = 'https://hsm.internal/sign';
  process.env.STABLECOIN_SIGNER_TOKEN = 'hsm-token';

  const tx = buildTx(kp.publicKey());
  await withStubbedFetch((url, body) => jsonResponse({
    signature: kp.sign(Buffer.from(body.payloadBase64, 'base64')).toString('base64'),
  }), async (calls) => {
    await signing.createSigner(getConfig()).signTransaction(tx);
    assert.strictEqual(calls[0].url, 'https://hsm.internal/sign');
    assert.strictEqual(calls[0].headers.Authorization, 'Bearer hsm-token');
    assert.strictEqual(calls[0].body.algorithm, 'ed25519');
    assert.strictEqual(calls[0].body.publicKey, kp.publicKey());
    assert.deepStrictEqual(Buffer.from(calls[0].body.payloadBase64, 'base64'), tx.hash());
  });
  assertSignedBy(tx, kp.publicKey());

  await withStubbedFetch(() => jsonResponse({ result: 'ok' }), async () => {
    await assert.rejects(
      signing.createSigner(getConfig()).signTransaction(buildTx(kp.publicKey())),
      /missing "signature"/
    );
  });

  // Plaintext HTTP is tolerable on testnet, never on mainnet.
  process.env.STABLECOIN_SIGNER_URL = 'http://hsm.internal/sign';
  assert.ok(signing.createSigner(getConfig()));
  process.env.STABLECOIN_NETWORK = 'mainnet';
  assert.throws(() => signing.createSigner(getConfig()), /must use HTTPS on mainnet/);
}

async function testConfigValidation() {
  resetEnv();
  process.env.STABLECOIN_SIGNER = 'kms';
  assert.throws(() => signing.createSigner(getConfig()), /STABLECOIN_SIGNER must be one of/);

  resetEnv();
  process.env.STABLECOIN_SIGNER = 'vault';
  process.env.VAULT_ADDR = 'https://vault.internal';
  process.env.VAULT_TOKEN = 'token';
  process.env.VAULT_TRANSIT_KEY = 'key';
  assert.throws(() => signing.createSigner(getConfig()), /STABLECOIN_DISTRIBUTOR_PUBLIC is required/);

  process.env.STABLECOIN_DISTRIBUTOR_PUBLIC = 'GNOTAVALIDKEY';
  assert.throws(() => signing.createSigner(getConfig()), /not a valid Stellar public key/);

  // Remote custody must not report a public key it was never given.
  resetEnv();
  process.env.STABLECOIN_SIGNER = 'vault';
  process.env.STABLECOIN_DISTRIBUTOR_SECRET = sdk.Keypair.random().secret();
  assert.strictEqual(signing.distributorPublicKey(getConfig()), null);
}

async function testCustodyStatus() {
  // A public key without the matching secret cannot sign: report it rather than
  // letting readiness pass and failing at settlement time.
  resetEnv();
  process.env.STABLECOIN_DISTRIBUTOR_PUBLIC = sdk.Keypair.random().publicKey();
  const noSecret = signing.custodyStatus(getConfig());
  assert.strictEqual(noSecret.backend, 'env');
  assert.strictEqual(noSecret.custodial, false);
  assert.match(noSecret.issues.join('|'), /STABLECOIN_DISTRIBUTOR_SECRET is required/);

  resetEnv();
  process.env.STABLECOIN_DISTRIBUTOR_SECRET = sdk.Keypair.random().secret();
  assert.deepStrictEqual(signing.custodyStatus(getConfig()).issues, []);

  // An unknown backend must be reported, not thrown, so /health still answers.
  resetEnv();
  process.env.STABLECOIN_SIGNER = 'valut';
  const typo = signing.custodyStatus(getConfig());
  assert.strictEqual(typo.backend, null);
  assert.strictEqual(typo.custodial, false);
  assert.strictEqual(typo.keyInEnvironment, false);
  assert.strictEqual(typo.distributorPublic, null);
  assert.match(typo.issues.join('|'), /STABLECOIN_SIGNER must be one of/);
}

async function testRedaction() {
  resetEnv();
  const { redact } = require('./config');
  process.env.VAULT_TOKEN = 'super-secret-vault-token';
  process.env.STABLECOIN_SIGNER_TOKEN = 'super-secret-hsm-token';
  process.env.STABLECOIN_DISTRIBUTOR_SECRET = sdk.Keypair.random().secret();
  const redacted = redact(getConfig());
  assert.strictEqual(redacted.vaultToken, '***');
  assert.strictEqual(redacted.externalSignerToken, '***');
  assert.strictEqual(redacted.distributorSecret, '***');
  assert.ok(!JSON.stringify(redacted).includes('super-secret'));
}

async function main() {
  const tests = [
    testEnvSigner,
    testMainnetEnvKeyRefused,
    testVaultSigner,
    testExternalSigner,
    testConfigValidation,
    testCustodyStatus,
    testRedaction,
  ];
  for (const test of tests) {
    await test();
    console.log(`  ✓ ${test.name}`);
  }
  resetEnv();
  console.log('Wallet signer custody validation passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
