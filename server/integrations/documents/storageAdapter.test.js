'use strict';

/**
 * Encrypted document storage checks. No network: the HTTPS layer is replaced
 * with a recorder so the thirdweb upload/gateway contract is asserted locally.
 *
 * Run: node server/integrations/documents/storageAdapter.test.js
 */

const assert = require('assert');
const crypto = require('crypto');
const { DocumentStorageAdapter } = require('./storageAdapter');

const KEY_A = crypto.randomBytes(32).toString('hex');
const KEY_B = crypto.randomBytes(32).toString('hex');
const PLAINTEXT = 'Trust distribution resolution 2026-03 — beneficiary Jane Doe, acct ****4821';

const realRequest = DocumentStorageAdapter._request;
const ENV_KEYS = [
  'DOCUMENT_STORAGE_BACKEND', 'DOCUMENT_STORAGE_LIVE', 'DOCUMENT_STORAGE_ENCRYPTION_KEY',
  'DOCUMENT_STORAGE_ENCRYPTION_KEYS_PREVIOUS', 'DOCUMENT_STORAGE_REQUIRE_ENCRYPTION',
  'DOCUMENT_STORAGE_THIRDWEB_SECRET_KEY', 'DOCUMENT_STORAGE_IPFS_GATEWAY', 'THIRDWEB_CLIENT_ID',
];

function setEnv(env) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
}

function stubUpload() {
  const calls = [];
  const pinned = new Map();
  DocumentStorageAdapter._request = async (url, opts = {}) => {
    calls.push({ url, ...opts });
    if (opts.method === 'POST') {
      const cid = 'bafy' + crypto.createHash('sha256').update(opts.body).digest('hex').slice(0, 20);
      // Strip the multipart framing the way a pinning service would.
      const body = opts.body.toString('utf8');
      pinned.set(cid, Buffer.from(body.slice(body.indexOf('\r\n\r\n') + 4, body.lastIndexOf('\r\n--')), 'utf8'));
      return { status: 200, body: JSON.stringify({ IpfsHash: cid }) };
    }
    const cid = url.split('/').pop();
    if (!pinned.has(cid)) return { status: 404, body: Buffer.alloc(0) };
    return { status: 200, body: pinned.get(cid) };
  };
  return { calls, pinned };
}

async function main() {
  try {
    // ── plaintext never reaches the network ─────────────────────────────────
    setEnv({
      DOCUMENT_STORAGE_BACKEND: 'thirdweb',
      DOCUMENT_STORAGE_LIVE: 'true',
      DOCUMENT_STORAGE_THIRDWEB_SECRET_KEY: 'sk-test',
      DOCUMENT_STORAGE_ENCRYPTION_KEY: KEY_A,
    });
    const { calls, pinned } = stubUpload();

    const anchor = await DocumentStorageAdapter.anchor({ documentId: 'DOC-1', content: PLAINTEXT });
    assert.strictEqual(anchor.mode, 'live', anchor.error || 'pin should have gone live');
    assert.ok(anchor.storageUri.startsWith('ipfs://'), 'thirdweb pin returns an ipfs uri');
    assert.strictEqual(anchor.encryption.alg, 'AES-256-GCM');
    assert.strictEqual(anchor.contentHash, DocumentStorageAdapter.contentHash(PLAINTEXT),
      'the anchored hash is of the plaintext, not the envelope');

    const upload = calls[0];
    assert.strictEqual(upload.url, 'https://storage.thirdweb.com/ipfs/upload');
    assert.strictEqual(upload.headers['x-secret-key'], 'sk-test');
    assert.ok(!upload.body.toString('utf8').includes('Jane Doe'), 'plaintext must not be uploaded');
    const envelope = JSON.parse([...pinned.values()][0].toString('utf8'));
    assert.deepStrictEqual(Object.keys(envelope).sort(), ['alg', 'ct', 'iv', 'kid', 'tag', 'v']);
    console.log('  ✓ thirdweb pin uploads only the AES-256-GCM envelope');

    // ── round trip through the gateway ──────────────────────────────────────
    const got = await DocumentStorageAdapter.retrieve({
      storageUri: anchor.storageUri,
      contentHash: anchor.contentHash,
    });
    assert.strictEqual(got.content.toString('utf8'), PLAINTEXT);
    assert.strictEqual(got.encrypted, true);
    assert.strictEqual(got.verified, true, 'retrieved plaintext must hash to the anchored digest');
    console.log('  ✓ retrieval unseals the envelope and verifies the anchored hash');

    // ── a rotated key still reads older documents ───────────────────────────
    setEnv({
      DOCUMENT_STORAGE_BACKEND: 'thirdweb',
      DOCUMENT_STORAGE_LIVE: 'true',
      DOCUMENT_STORAGE_THIRDWEB_SECRET_KEY: 'sk-test',
      DOCUMENT_STORAGE_ENCRYPTION_KEY: KEY_B,
    });
    await assert.rejects(
      () => DocumentStorageAdapter.retrieve({ storageUri: anchor.storageUri }),
      /no configured key matches envelope key/,
      'rotating the key without keeping the old one must fail loudly'
    );
    process.env.DOCUMENT_STORAGE_ENCRYPTION_KEYS_PREVIOUS = KEY_A;
    const afterRotation = await DocumentStorageAdapter.retrieve({ storageUri: anchor.storageUri });
    assert.strictEqual(afterRotation.content.toString('utf8'), PLAINTEXT);
    console.log('  ✓ previous keys keep already-pinned documents readable after rotation');

    // ── refuses to publish plaintext ────────────────────────────────────────
    setEnv({
      DOCUMENT_STORAGE_BACKEND: 'thirdweb',
      DOCUMENT_STORAGE_LIVE: 'true',
      DOCUMENT_STORAGE_THIRDWEB_SECRET_KEY: 'sk-test',
      DOCUMENT_STORAGE_REQUIRE_ENCRYPTION: 'false',
    });
    const unkeyed = await DocumentStorageAdapter.anchor({ documentId: 'DOC-2', content: PLAINTEXT });
    assert.strictEqual(unkeyed.mode, 'shadow');
    assert.match(unkeyed.error, /refusing to pin plaintext to a public network/);
    assert.ok(unkeyed.storageUri.startsWith('shadow://'), 'a refused pin degrades to the local marker');
    console.log('  ✓ refuses to pin plaintext to a public network');

    // ── missing key with encryption required is a config error, not a leak ──
    setEnv({
      DOCUMENT_STORAGE_BACKEND: 'thirdweb',
      DOCUMENT_STORAGE_LIVE: 'true',
      DOCUMENT_STORAGE_THIRDWEB_SECRET_KEY: 'sk-test',
    });
    const noKey = await DocumentStorageAdapter.anchor({ documentId: 'DOC-3', content: PLAINTEXT });
    assert.strictEqual(noKey.mode, 'shadow');
    assert.match(noKey.error, /DOCUMENT_STORAGE_ENCRYPTION_KEY not configured/);
    const status = DocumentStorageAdapter.status();
    assert.strictEqual(status.encryption.configured, false);
    assert.strictEqual(status.encryption.required, true);
    assert.strictEqual(status.thirdwebConfigured, true);
    console.log('  ✓ an unconfigured key blocks the pin and shows in status');

    // ── malformed keys are rejected up front ────────────────────────────────
    setEnv({ DOCUMENT_STORAGE_ENCRYPTION_KEY: 'too-short' });
    assert.throws(() => DocumentStorageAdapter._keys(), /must be 32 bytes/);
    assert.match(DocumentStorageAdapter.status().encryption.error, /must be 32 bytes/);
    console.log('  ✓ a malformed key is a configuration error');

    // ── gateway follows the configured client id ────────────────────────────
    setEnv({ DOCUMENT_STORAGE_BACKEND: 'thirdweb', THIRDWEB_CLIENT_ID: 'cid123' });
    assert.strictEqual(DocumentStorageAdapter.status().gateway, 'https://cid123.ipfscdn.io/ipfs/');
    console.log('  ✓ gateway resolves to the project ipfscdn host');

    // ── shadow default still leaks nothing ─────────────────────────────────
    setEnv({});
    const shadow = await DocumentStorageAdapter.anchor({ documentId: 'DOC-4', content: PLAINTEXT });
    assert.strictEqual(shadow.mode, 'shadow');
    assert.strictEqual(shadow.storageUri, 'shadow://none/DOC-4');
    await assert.rejects(
      () => DocumentStorageAdapter.retrieve({ storageUri: shadow.storageUri }),
      /never pinned/
    );
    console.log('  ✓ default configuration pins nothing');

    console.log('document storage adapter: all checks passed');
  } finally {
    DocumentStorageAdapter._request = realRequest;
    setEnv({});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
