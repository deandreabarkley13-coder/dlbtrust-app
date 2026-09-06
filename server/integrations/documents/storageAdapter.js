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
 * and no live value or data movement occurs. Set DOCUMENT_STORAGE_BACKEND=s3|ipfs
 * plus DOCUMENT_STORAGE_LIVE=true to actually pin.
 */

const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');

function bool(name, def = false) {
  const v = process.env[name];
  if (v === undefined) return def;
  return v === 'true' || v === '1';
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
        gateway: process.env.DOCUMENT_STORAGE_IPFS_GATEWAY || 'https://ipfs.io/ipfs/',
      },
      timeoutMs: Number(process.env.DOCUMENT_STORAGE_TIMEOUT_MS || 15000),
    };
  }

  static status() {
    const cfg = this.config();
    return {
      backend: cfg.backend,
      live: cfg.live,
      mode: cfg.live && cfg.backend !== 'none' ? 'live' : 'shadow',
      s3Configured: Boolean(cfg.s3.bucket && cfg.s3.accessKeyId && cfg.s3.secretAccessKey),
      ipfsConfigured: Boolean(cfg.ipfs.apiUrl),
      note: 'Content hashing always runs; pinning requires DOCUMENT_STORAGE_LIVE=true.',
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
      if (cfg.backend === 's3') {
        const uri = await this._pinToS3({ documentId, content, contentType, cfg: cfg.s3, timeoutMs: cfg.timeoutMs });
        return { ...base, storageUri: uri, mode: 'live' };
      }
      if (cfg.backend === 'ipfs') {
        const uri = await this._pinToIpfs({ documentId, content, contentType, cfg: cfg.ipfs, timeoutMs: cfg.timeoutMs });
        return { ...base, storageUri: uri, mode: 'live' };
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

  static _request(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method,
        headers,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('storage request timeout')); });
      if (body) req.write(body);
      req.end();
    });
  }
}

module.exports = { DocumentStorageAdapter };
