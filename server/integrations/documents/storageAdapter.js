'use strict';

/**
 * Document Storage Adapter — content hashing and optional decentralized pinning.
 *
 * Every document gets a deterministic sha256 content hash so tokenized bond and
 * receipt documents can be anchored/attested against an immutable digest. The
 * hash is always computed locally; pinning to an external backend only happens
 * when a backend is explicitly configured AND DOCUMENT_STORAGE_LIVE=true.
 *
 * Defaults (no env set): backend `none`, live disabled → shadow mode. Nothing
 * leaves the process, the returned `storage_uri` is a local `shadow://` marker,
 * and no live value or data movement occurs. Set
 * DOCUMENT_STORAGE_BACKEND=s3|ipfs|thirdweb plus DOCUMENT_STORAGE_LIVE=true to
 * actually pin.
 *
 * PRIVACY: IPFS is a public content-addressed network. A CID is not a secret —
 * anyone holding it can fetch the block from any public gateway, and pinned
 * content cannot be unpublished. Trust documents therefore never leave this
 * process as plaintext: content is sealed with AES-256-GCM under
 * DOCUMENT_STORAGE_ENCRYPTION_KEY and only the ciphertext envelope is pinned,
 * so the CID discloses nothing and destroying the key retires the document
 * (the only deletion IPFS allows).
 */

const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');

function bool(name, def = false) {
  const v = process.env[name];
  if (v === undefined) return def;
  return v === 'true' || v === '1';
}

const ENVELOPE_VERSION = 1;
const ENVELOPE_ALG = 'AES-256-GCM';
const THIRDWEB_UPLOAD_URL = 'https://storage.thirdweb.com/ipfs/upload';
const PUBLIC_GATEWAY = 'https://ipfs.io/ipfs/';

/** Accepts a 32-byte key as hex or base64; anything else is a configuration error. */
function parseKey(raw, label) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const buf = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');
  if (buf.length !== 32) {
    throw new Error(`${label} must be 32 bytes (64 hex chars or base64), got ${buf.length}`);
  }
  return buf;
}

/** Stable, non-secret identifier so an envelope names the key that sealed it. */
function keyId(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

class DocumentStorageAdapter {
  static config() {
    return {
      backend: (process.env.DOCUMENT_STORAGE_BACKEND || 'none').toLowerCase(),
      // Master safety switch: pinning is a no-op until this is true.
      live: bool('DOCUMENT_STORAGE_LIVE', false),
      s3: {
        bucket: process.env.DOCUMENT_STORAGE_S3_BUCKET || '',
        region: process.env.DOCUMENT_STORAGE_S3_REGION || 'us-east-1',
        prefix: process.env.DOCUMENT_STORAGE_S3_PREFIX || 'documents/',
        accessKeyId: process.env.DOCUMENT_STORAGE_S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.DOCUMENT_STORAGE_S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || '',
        endpoint: process.env.DOCUMENT_STORAGE_S3_ENDPOINT || '',
      },
      ipfs: {
        apiUrl: process.env.DOCUMENT_STORAGE_IPFS_API_URL || '',
        token: process.env.DOCUMENT_STORAGE_IPFS_TOKEN || '',
        gateway: process.env.DOCUMENT_STORAGE_IPFS_GATEWAY || PUBLIC_GATEWAY,
      },
      thirdweb: {
        uploadUrl: process.env.DOCUMENT_STORAGE_THIRDWEB_UPLOAD_URL || THIRDWEB_UPLOAD_URL,
        secretKey: process.env.DOCUMENT_STORAGE_THIRDWEB_SECRET_KEY || process.env.THIRDWEB_SECRET_KEY || '',
        clientId: process.env.THIRDWEB_CLIENT_ID || '',
        gateway: process.env.DOCUMENT_STORAGE_IPFS_GATEWAY
          || (process.env.THIRDWEB_CLIENT_ID
            ? `https://${process.env.THIRDWEB_CLIENT_ID}.ipfscdn.io/ipfs/`
            : PUBLIC_GATEWAY),
      },
      encryption: {
        required: bool('DOCUMENT_STORAGE_REQUIRE_ENCRYPTION', true),
        key: process.env.DOCUMENT_STORAGE_ENCRYPTION_KEY || '',
        previousKeys: process.env.DOCUMENT_STORAGE_ENCRYPTION_KEYS_PREVIOUS || '',
      },
      timeoutMs: Number(process.env.DOCUMENT_STORAGE_TIMEOUT_MS || 15000),
    };
  }

  /** Primary key first; the rest are decrypt-only, so a rotation stays readable. */
  static _keys() {
    const cfg = this.config().encryption;
    const keys = [];
    const primary = parseKey(cfg.key, 'DOCUMENT_STORAGE_ENCRYPTION_KEY');
    if (primary) keys.push(primary);
    for (const raw of String(cfg.previousKeys).split(',')) {
      const key = parseKey(raw, 'DOCUMENT_STORAGE_ENCRYPTION_KEYS_PREVIOUS');
      if (key) keys.push(key);
    }
    return keys;
  }

  /** Ciphertext envelope: self-describing, so retrieval needs only the key. */
  static seal(content) {
    const [key] = this._keys();
    if (!key) throw new Error('DOCUMENT_STORAGE_ENCRYPTION_KEY not configured');
    const plaintext = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      keyId: keyId(key),
      envelope: Buffer.from(JSON.stringify({
        v: ENVELOPE_VERSION,
        alg: ENVELOPE_ALG,
        kid: keyId(key),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ct: ciphertext.toString('base64'),
      }), 'utf8'),
    };
  }

  static open(envelope) {
    let parsed;
    try {
      parsed = JSON.parse(Buffer.isBuffer(envelope) ? envelope.toString('utf8') : String(envelope));
    } catch (e) {
      throw new Error('not an encrypted document envelope');
    }
    if (parsed.v !== ENVELOPE_VERSION || parsed.alg !== ENVELOPE_ALG) {
      throw new Error(`unsupported envelope (v${parsed.v}, ${parsed.alg})`);
    }
    const keys = this._keys();
    if (!keys.length) throw new Error('DOCUMENT_STORAGE_ENCRYPTION_KEY not configured');
    const key = keys.find((k) => keyId(k) === parsed.kid);
    if (!key) {
      throw new Error(
        `no configured key matches envelope key ${parsed.kid} — add it to `
        + 'DOCUMENT_STORAGE_ENCRYPTION_KEYS_PREVIOUS to keep older documents readable'
      );
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parsed.ct, 'base64')), decipher.final()]);
  }

  static status() {
    const cfg = this.config();
    let encryptionKeys = 0;
    let encryptionError = null;
    try {
      encryptionKeys = this._keys().length;
    } catch (e) {
      encryptionError = e.message;
    }
    return {
      backend: cfg.backend,
      live: cfg.live,
      mode: cfg.live && cfg.backend !== 'none' ? 'live' : 'shadow',
      s3Configured: Boolean(cfg.s3.bucket && cfg.s3.accessKeyId && cfg.s3.secretAccessKey),
      ipfsConfigured: Boolean(cfg.ipfs.apiUrl),
      thirdwebConfigured: Boolean(cfg.thirdweb.secretKey),
      gateway: cfg.backend === 'thirdweb' ? cfg.thirdweb.gateway : cfg.ipfs.gateway,
      encryption: {
        required: cfg.encryption.required,
        configured: encryptionKeys > 0,
        keys: encryptionKeys,
        ...(encryptionError ? { error: encryptionError } : {}),
      },
      note: 'Content hashing always runs; pinning requires DOCUMENT_STORAGE_LIVE=true, and '
        + 'IPFS backends pin the AES-256-GCM envelope, never plaintext.',
    };
  }

  static contentHash(content) {
    if (content == null) return null;
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    return `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
  }

  /**
   * Hash the content and (optionally) pin it.
   * @returns {{ contentHash: string|null, storageUri: string|null, backend: string, mode: string, error?: string }}
   */
  static async anchor({ documentId, content, contentType = 'text/plain' } = {}) {
    const cfg = this.config();
    const contentHash = this.contentHash(content);
    const base = { documentId: documentId || null, contentHash, backend: cfg.backend, live: cfg.live };

    if (!contentHash) return { ...base, storageUri: null, mode: 'skipped', reason: 'no content' };

    // Shadow default: record where the object *would* live without pinning it.
    if (!cfg.live || cfg.backend === 'none') {
      return {
        ...base,
        storageUri: `shadow://${cfg.backend}/${documentId || contentHash.replace('sha256:', '')}`,
        mode: 'shadow',
      };
    }

    try {
      // Sealed before it reaches any backend: on IPFS the CID is public, and on
      // S3 this keeps the object useless to anyone who gains bucket access.
      let payload = content;
      let encryption = null;
      if (cfg.encryption.required || this._keys().length) {
        const sealed = this.seal(content);
        payload = sealed.envelope;
        encryption = { alg: ENVELOPE_ALG, keyId: sealed.keyId };
      } else if (cfg.backend === 'ipfs' || cfg.backend === 'thirdweb') {
        throw new Error(
          'refusing to pin plaintext to a public network: set DOCUMENT_STORAGE_ENCRYPTION_KEY'
        );
      }
      const sealedBase = { ...base, encryption };
      const pinType = encryption ? 'application/json' : contentType;

      if (cfg.backend === 's3') {
        const uri = await this._pinToS3({ documentId, content: payload, contentType: pinType, cfg: cfg.s3, timeoutMs: cfg.timeoutMs });
        return { ...sealedBase, storageUri: uri, mode: 'live' };
      }
      if (cfg.backend === 'ipfs') {
        const uri = await this._pinToIpfs({ documentId, content: payload, contentType: pinType, cfg: cfg.ipfs, timeoutMs: cfg.timeoutMs });
        return { ...sealedBase, storageUri: uri, mode: 'live' };
      }
      if (cfg.backend === 'thirdweb') {
        const uri = await this._pinToThirdweb({ documentId, content: payload, contentType: pinType, cfg: cfg.thirdweb, timeoutMs: cfg.timeoutMs });
        return { ...sealedBase, storageUri: uri, mode: 'live' };
      }
      return { ...base, storageUri: null, mode: 'shadow', error: `unknown backend: ${cfg.backend}` };
    } catch (e) {
      // Never fail document creation because a pin failed: keep the hash and
      // fall back to the shadow marker so the row is still anchored locally.
      return {
        ...base,
        storageUri: `shadow://${cfg.backend}/${documentId || contentHash.replace('sha256:', '')}`,
        mode: 'shadow',
        error: e.message,
      };
    }
  }

  /**
   * Read a pinned document back and unseal it.
   * @returns {{ content: Buffer, encrypted: boolean, contentHash: string, verified: boolean|null }}
   */
  static async retrieve({ storageUri, contentHash = null } = {}) {
    const cfg = this.config();
    if (!storageUri) throw new Error('storageUri required');
    if (storageUri.startsWith('shadow://')) {
      throw new Error('document was never pinned (shadow marker) — content lives in the database row');
    }
    if (!storageUri.startsWith('ipfs://')) {
      throw new Error(`retrieval not supported for ${storageUri.split(':')[0]}:// URIs`);
    }
    const thirdweb = cfg.backend === 'thirdweb';
    const gateway = thirdweb ? cfg.thirdweb.gateway : cfg.ipfs.gateway;
    // The project gateway authorizes by client id (browser) or secret key (backend);
    // without one it answers 401 even for content this project pinned.
    const headers = thirdweb && cfg.thirdweb.secretKey ? { 'x-secret-key': cfg.thirdweb.secretKey } : {};
    const res = await this._request(gateway.replace(/\/$/, '') + '/' + storageUri.slice('ipfs://'.length), {
      headers,
      timeoutMs: cfg.timeoutMs,
      binary: true,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`gateway fetch failed (${res.status})`);
    }
    let content = Buffer.isBuffer(res.body) ? res.body : Buffer.from(String(res.body), 'utf8');
    let encrypted = false;
    try {
      content = this.open(content);
      encrypted = true;
    } catch (e) {
      if (!/not an encrypted document envelope/.test(e.message)) throw e;
    }
    const hash = this.contentHash(content);
    return {
      content,
      encrypted,
      contentHash: hash,
      verified: contentHash ? hash === contentHash : null,
    };
  }

  static async _pinToThirdweb({ documentId, content, contentType, cfg, timeoutMs }) {
    if (!cfg.secretKey) throw new Error('THIRDWEB_SECRET_KEY not configured');
    const boundary = `----dlbtrust${crypto.randomBytes(8).toString('hex')}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${documentId || 'document'}"\r\nContent-Type: ${contentType}\r\n\r\n`),
      Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await this._request(cfg.uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        'x-secret-key': cfg.secretKey,
      },
      body,
      timeoutMs,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`thirdweb storage rejected the secret key (${res.status})`);
    }
    let cid = null;
    try {
      cid = JSON.parse(String(res.body).trim()).IpfsHash || null;
    } catch (e) { /* fall through to error below */ }
    if (!cid) throw new Error(`thirdweb upload returned no CID (status ${res.status})`);
    return `ipfs://${cid}`;
  }

  static async _pinToIpfs({ documentId, content, contentType, cfg, timeoutMs }) {
    if (!cfg.apiUrl) throw new Error('DOCUMENT_STORAGE_IPFS_API_URL not configured');
    const boundary = `----dlbtrust${crypto.randomBytes(8).toString('hex')}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${documentId || 'document'}"\r\nContent-Type: ${contentType}\r\n\r\n`),
      Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const headers = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
    };
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
    const res = await this._request(cfg.apiUrl, { method: 'POST', headers, body, timeoutMs });
    let cid = null;
    try {
      const parsed = JSON.parse(String(res.body).trim().split('\n').pop());
      cid = parsed.Hash || parsed.cid || parsed.IpfsHash || null;
    } catch (e) { /* fall through to error below */ }
    if (!cid) throw new Error(`IPFS pin returned no CID (status ${res.status})`);
    return `ipfs://${cid}`;
  }

  static async _pinToS3({ documentId, content, contentType, cfg, timeoutMs }) {
    if (!cfg.bucket) throw new Error('DOCUMENT_STORAGE_S3_BUCKET not configured');
    if (!cfg.accessKeyId || !cfg.secretAccessKey) throw new Error('S3 credentials not configured');
    const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const key = `${cfg.prefix}${documentId || crypto.randomBytes(8).toString('hex')}`;
    const host = cfg.endpoint
      ? new URL(cfg.endpoint).host
      : `${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
    const canonicalUri = `/${cfg.endpoint ? `${cfg.bucket}/` : ''}${key}`;

    // Minimal SigV4 PUT so the adapter needs no AWS SDK dependency.
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256', amzDate, scope,
      crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const hmac = (key2, data) => crypto.createHmac('sha256', key2).update(data).digest();
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, dateStamp), cfg.region), 's3'), 'aws4_request');
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    const res = await this._request(`https://${host}${canonicalUri}`, {
      method: 'PUT',
      headers: {
        Host: host,
        'Content-Type': contentType,
        'Content-Length': body.length,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      body,
      timeoutMs,
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`S3 PUT failed (${res.status}): ${String(res.body).slice(0, 200)}`);
    return `s3://${cfg.bucket}/${key}`;
  }

  static _request(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15000, binary = false } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method,
        headers,
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => { chunks.push(chunk); });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, body: binary ? buf : buf.toString('utf8') });
        });
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('storage request timeout')); });
      if (body) req.write(body);
      req.end();
    });
  }
}

module.exports = { DocumentStorageAdapter };
