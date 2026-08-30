'use strict';

/**
 * Direct Send — transport
 *
 * Two ways into a bank's clearing pipeline, one vocabulary:
 *
 *   • `pipeline`: POST the raw bytes to the bank's clearing endpoint over mutual
 *     TLS. The synchronous response is a file-level receipt, so the trust knows
 *     within one call whether the pipeline took the file and what it counted.
 *   • `file`: drop the identical bytes into the bank's host-to-host directory
 *     with the existing pinned transport. The signature and manifest are written
 *     first and the data file last, because the bank's collector triggers on the
 *     data file and must never find it without its companions.
 *
 * The distinction that matters most here is *ambiguity*. A refusal the bank
 * clearly returned (a 4xx with a body) means the file did not clear and the
 * batch may be rebuilt. A timeout, a dropped socket or a 5xx means the pipeline
 * may already hold the bytes; that is flagged `ambiguous` and the engine
 * escalates it to an operator instead of sending the file again.
 */

const fsp = require('fs/promises');
const https = require('https');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const { withWireTransport } = require('./wireTransport');
const { getWireChannelConfig } = require('./wireHostToHostConfig');

class WireDirectSendTransportError extends Error {
  constructor(message, code = 'WIRE_DIRECT_SEND_TRANSPORT', status = 502, { ambiguous = false, detail = null } = {}) {
    super(message);
    this.name = 'WireDirectSendTransportError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
    // True when the bank may already hold the file: never auto-resend.
    this.ambiguous = ambiguous;
    this.detail = detail;
  }
}

function dirname(remotePath) {
  const trimmed = String(remotePath || '/').replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  return cut <= 0 ? '/' : trimmed.slice(0, cut);
}

/** Where a dropped clearing file lands on the bank host. */
function dropPathFor(config, channelConfig = getWireChannelConfig()) {
  const dir = config.dropDir || 'clearing';
  if (dir.startsWith('/')) return dir;
  return `${dirname(channelConfig.outboundPath)}/${dir}`.replace(/\/{2,}/g, '/');
}

async function readMaybe(inline, filePath) {
  if (inline) return inline;
  if (filePath) return fsp.readFile(filePath);
  return null;
}

/** Keep our own copy of every file we sent; the file is the instruction. */
async function archiveLocally({ file, manifest, signature, config }) {
  const dir = path.join(config.archiveDir, file.batchId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, file.filename), file.payload, 'utf8');
  if (manifest) {
    await fsp.writeFile(
      path.join(dir, `${file.filename}${config.manifestSuffix}`),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8'
    );
  }
  if (signature) {
    await fsp.writeFile(
      path.join(dir, `${file.filename}${config.signatureSuffix}`),
      `${signature.algorithm} ${signature.value}\n`,
      'utf8'
    );
  }
  return dir;
}

function parseReceipt(status, body) {
  let parsed = null;
  try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
  const pick = (...names) => {
    if (!parsed) return null;
    for (const name of names) {
      if (parsed[name] !== undefined && parsed[name] !== null) return parsed[name];
    }
    return null;
  };
  const count = pick('acceptedCount', 'accepted', 'nbOfTxs', 'count');
  const total = pick('totalAmountCents', 'totalCents');
  return {
    httpStatus: status,
    status: String(pick('status', 'state') || 'accepted'),
    reference: pick('reference', 'receiptId', 'fileId', 'id', 'trackingId'),
    acceptedCount: count === null ? null : Number(count),
    totalAmountCents: total === null ? null : Number(total),
    body: body ? String(body).slice(0, 4000) : null,
  };
}

async function postToPipeline({ file, manifest, signature, config }) {
  const url = new URL(config.endpoint);
  const client = url.protocol === 'http:' ? http : https;
  const payload = Buffer.from(file.payload, 'utf8');

  const headers = {
    'Content-Type': config.contentType,
    'Content-Length': payload.length,
    Accept: 'application/json',
    'Idempotency-Key': file.batchId,
    'X-Batch-Id': file.batchId,
    'X-File-Name': file.filename,
    'X-Sender-Id': config.senderId,
    'X-Content-Sha256': file.payloadHash,
    'X-Item-Count': String(file.count),
    'X-Total-Amount': (file.totalAmountCents / 100).toFixed(2),
    'X-Currency': file.currency,
  };
  if (config.receiverId) headers['X-Receiver-Id'] = config.receiverId;
  if (signature) {
    headers['X-Signature'] = signature.value;
    headers['X-Signature-Algorithm'] = signature.algorithm;
  }
  if (config.authToken) headers.Authorization = `Bearer ${config.authToken}`;
  if (config.apiKey) headers[config.apiKeyHeader] = config.apiKey;
  if (manifest) headers['X-Manifest-Sha256'] = require('crypto')
    .createHash('sha256')
    .update(JSON.stringify(manifest), 'utf8')
    .digest('hex');

  const options = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port || (url.protocol === 'http:' ? 80 : 443),
    path: `${url.pathname}${url.search}`,
    headers,
    timeout: config.timeoutMs,
  };
  if (client === https) {
    const cert = await readMaybe(config.clientCert, config.clientCertPath);
    const key = await readMaybe(config.clientKey, config.clientKeyPath);
    const ca = await readMaybe(config.caCert, config.caCertPath);
    if (cert) options.cert = cert;
    if (key) options.key = key;
    if (ca) options.ca = ca;
    if (config.clientKeyPassphrase) options.passphrase = config.clientKeyPassphrase;
    options.rejectUnauthorized = !config.insecureTls;
  }

  return new Promise((resolve, reject) => {
    let sent = false;
    const request = client.request(options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const status = response.statusCode || 0;
        if (status >= 200 && status < 300) {
          resolve(parseReceipt(status, body));
          return;
        }
        reject(new WireDirectSendTransportError(
          `The clearing pipeline refused ${file.filename} with HTTP ${status}`,
          'WIRE_DIRECT_SEND_REFUSED',
          502,
          // A 5xx is not a refusal: the pipeline may have ingested the file
          // before failing to answer.
          { ambiguous: status >= 500, detail: body ? body.slice(0, 2000) : null }
        ));
      });
    });
    request.on('timeout', () => {
      request.destroy(new WireDirectSendTransportError(
        `The clearing pipeline did not answer within ${config.timeoutMs}ms; it may hold ${file.filename}`,
        'WIRE_DIRECT_SEND_TIMEOUT',
        504,
        { ambiguous: true }
      ));
    });
    request.on('error', error => {
      if (error instanceof WireDirectSendTransportError) { reject(error); return; }
      reject(new WireDirectSendTransportError(
        `The clearing pipeline could not be reached: ${error.message}`,
        'WIRE_DIRECT_SEND_UNREACHABLE',
        502,
        // Before the body was written nothing could have been ingested.
        { ambiguous: sent }
      ));
    });
    request.write(payload, () => { sent = true; });
    request.end();
  });
}

async function dropOnBankHost({ file, manifest, signature, config }) {
  const channelConfig = getWireChannelConfig();
  const dir = dropPathFor(config, channelConfig);
  const remotePath = await withWireTransport(async session => {
    if (signature) {
      await session.put(dir, `${file.filename}${config.signatureSuffix}`, `${signature.algorithm} ${signature.value}\n`);
    }
    if (manifest) {
      await session.put(dir, `${file.filename}${config.manifestSuffix}`, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    // Last: the collector triggers on the data file.
    return session.put(dir, file.filename, file.payload);
  }, channelConfig);

  return {
    httpStatus: null,
    status: 'dropped',
    reference: remotePath,
    acceptedCount: null,
    totalAmountCents: null,
    body: null,
    transport: channelConfig.transport,
    remotePath,
  };
}

/**
 * Send one clearing file. Resolves with the bank's receipt; rejects with an
 * error whose `ambiguous` flag says whether a resend is safe.
 */
async function sendClearingFile({ file, manifest, signature, config }) {
  const archivePath = await archiveLocally({ file, manifest, signature, config });
  const receipt = config.mode === 'pipeline'
    ? await postToPipeline({ file, manifest, signature, config })
    : await dropOnBankHost({ file, manifest, signature, config });
  return { ...receipt, archivePath, mode: config.mode };
}

module.exports = {
  WireDirectSendTransportError,
  sendClearingFile,
  dropPathFor,
  archiveLocally,
  parseReceipt,
};
