'use strict';

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const forge = require('node-forge');

/**
 * AS2 Client — Applicability Statement 2 (RFC 4130)
 *
 * Sends files to trading partners with S/MIME encryption + digital signatures
 * over HTTPS. Processes synchronous MDN (Message Disposition Notification)
 * responses for delivery confirmation.
 */

function generateMessageId(localAs2Id) {
  const uuid = crypto.randomUUID();
  const domain = localAs2Id.replace(/[^a-zA-Z0-9.-]/g, '') || 'dlbtrust.local';
  return `<${uuid}@${domain}>`;
}

function generateMicHash(payload, algorithm = 'sha256') {
  const hash = crypto.createHash(algorithm);
  hash.update(payload);
  return hash.digest('base64');
}

/**
 * Sign payload using PKCS7 (S/MIME) with the sender's private key + cert.
 * Returns a DER-encoded signed-data PKCS7 blob.
 */
function signPayload(payload, pemPrivateKey, pemCertificate) {
  const cert = forge.pki.certificateFromPem(pemCertificate);
  const privateKey = forge.pki.privateKeyFromPem(pemPrivateKey);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(payload, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key: privateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() }
    ]
  });
  p7.sign();

  const der = forge.asn1.toDer(p7.toAsn1());
  return Buffer.from(der.getBytes(), 'binary');
}

/**
 * Encrypt payload using PKCS7 (S/MIME) with the recipient's public certificate.
 * Returns a DER-encoded enveloped-data PKCS7 blob.
 */
function encryptPayload(payload, pemRecipientCert) {
  const cert = forge.pki.certificateFromPem(pemRecipientCert);

  const p7 = forge.pkcs7.createEnvelopedData();
  p7.addRecipient(cert);
  p7.content = forge.util.createBuffer(payload, 'binary');
  p7.encrypt();

  const der = forge.asn1.toDer(p7.toAsn1());
  return Buffer.from(der.getBytes(), 'binary');
}

/**
 * Generate a self-signed certificate + private key for AS2 testing.
 * Returns { certificate: PEM, privateKey: PEM }
 */
function generateSelfSignedCert(commonName = 'DLB Trust AS2') {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 5);

  const attrs = [
    { name: 'commonName', value: commonName },
    { name: 'organizationName', value: 'DLB Trust' },
    { shortName: 'ST', value: 'OH' },
    { name: 'countryName', value: 'US' }
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, dataEncipherment: true },
    { name: 'extKeyUsage', clientAuth: true, serverAuth: true }
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    certificate: forge.pki.certificateToPem(cert),
    privateKey: forge.pki.privateKeyToPem(keys.privateKey)
  };
}

/**
 * Build MIME body for AS2 message.
 */
function buildMimeBody(filename, contentType, payload) {
  const boundary = `----=_Part_${crypto.randomUUID().replace(/-/g, '')}`;
  const body = [
    `--${boundary}`,
    `Content-Type: ${contentType}; name="${filename}"`,
    `Content-Transfer-Encoding: binary`,
    `Content-Disposition: attachment; filename="${filename}"`,
    '',
    payload,
    `--${boundary}--`
  ].join('\r\n');
  return { body, boundary, contentType: `multipart/mixed; boundary="${boundary}"` };
}

/**
 * Parse a synchronous MDN response from the partner's HTTP response.
 */
function parseMdnResponse(statusCode, headers, body) {
  const disposition = body.match(/Disposition:\s*([^\r\n]+)/i);
  const finalRecipient = body.match(/Final-Recipient:\s*([^\r\n]+)/i);
  const originalMessageId = body.match(/Original-Message-ID:\s*([^\r\n]+)/i);
  const receivedMic = body.match(/Received-Content-MIC:\s*([^\r\n]+)/i);

  let status = 'unknown';
  let dispositionText = '';
  if (disposition) {
    dispositionText = disposition[1].trim();
    if (dispositionText.toLowerCase().includes('processed')) {
      status = 'confirmed';
    } else if (dispositionText.toLowerCase().includes('failed') || dispositionText.toLowerCase().includes('error')) {
      status = 'failed';
    }
  }

  if (statusCode >= 200 && statusCode < 300 && status === 'unknown') {
    status = 'confirmed';
  } else if (statusCode >= 400) {
    status = 'failed';
  }

  return {
    status,
    statusCode,
    disposition: dispositionText,
    finalRecipient: finalRecipient ? finalRecipient[1].trim() : null,
    originalMessageId: originalMessageId ? originalMessageId[1].trim() : null,
    receivedMic: receivedMic ? receivedMic[1].trim() : null,
    rawBody: body
  };
}

/**
 * Send a file to an AS2 trading partner.
 *
 * @param {Object} opts
 * @param {string} opts.url - Partner's AS2 receiver URL
 * @param {string} opts.as2From - Our AS2 ID
 * @param {string} opts.as2To - Partner's AS2 ID
 * @param {string} opts.filename - Name of the file being sent
 * @param {string|Buffer} opts.payload - File content
 * @param {string} opts.contentType - MIME type (e.g. 'application/octet-stream')
 * @param {string} [opts.signingKey] - PEM private key for signing
 * @param {string} [opts.signingCert] - PEM certificate for signing
 * @param {string} [opts.encryptionCert] - Partner's PEM certificate for encryption
 * @param {boolean} [opts.requestMdn=true] - Request synchronous MDN
 * @param {string} [opts.micAlgorithm='sha256'] - MIC hash algorithm
 * @returns {Promise<Object>} - { messageId, mic, mdn, sent_at }
 */
async function sendAs2Message(opts) {
  const {
    url,
    as2From,
    as2To,
    filename,
    payload,
    contentType = 'application/octet-stream',
    signingKey,
    signingCert,
    encryptionCert,
    requestMdn = true,
    micAlgorithm = 'sha256'
  } = opts;

  const messageId = generateMessageId(as2From);
  const mic = generateMicHash(typeof payload === 'string' ? payload : payload.toString('utf8'), micAlgorithm);

  let sendBody;
  let sendContentType;

  if (signingKey && signingCert) {
    // Sign the payload
    let signedData = signPayload(
      typeof payload === 'string' ? payload : payload.toString('utf8'),
      signingKey,
      signingCert
    );

    if (encryptionCert) {
      // Encrypt the signed payload
      const encrypted = encryptPayload(signedData, encryptionCert);
      sendBody = encrypted;
      sendContentType = 'application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"';
    } else {
      sendBody = signedData;
      sendContentType = 'application/pkcs7-mime; smime-type=signed-data; name="smime.p7m"';
    }
  } else if (encryptionCert) {
    // Encrypt only (no signature)
    const encrypted = encryptPayload(
      typeof payload === 'string' ? Buffer.from(payload) : payload,
      encryptionCert
    );
    sendBody = encrypted;
    sendContentType = 'application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"';
  } else {
    // Plain — no signing or encryption (for testing)
    sendBody = typeof payload === 'string' ? Buffer.from(payload) : payload;
    sendContentType = contentType;
  }

  const headers = {
    'Content-Type': sendContentType,
    'Content-Length': sendBody.length,
    'AS2-From': as2From,
    'AS2-To': as2To,
    'AS2-Version': '1.2',
    'Message-ID': messageId,
    'Subject': filename,
    'MIME-Version': '1.0',
    'Date': new Date().toUTCString(),
    'Content-Disposition': `attachment; filename="${filename}"`
  };

  if (requestMdn) {
    headers['Disposition-Notification-To'] = as2From;
    headers['Disposition-Notification-Options'] =
      `signed-receipt-protocol=optional, pkcs7-signature; signed-receipt-micalg=optional, ${micAlgorithm}`;
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers,
      rejectUnauthorized: false, // allow self-signed partner certs in testing
      timeout: 30000
    };

    const req = transport.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('utf8');
        const mdn = parseMdnResponse(res.statusCode, res.headers, responseBody);
        resolve({
          messageId,
          mic,
          micAlgorithm,
          mdn,
          sent_at: new Date().toISOString()
        });
      });
    });

    req.on('error', (err) => {
      reject(new Error(`AS2 transport error: ${err.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('AS2 request timed out after 30s'));
    });

    req.write(sendBody);
    req.end();
  });
}

module.exports = {
  sendAs2Message,
  signPayload,
  encryptPayload,
  generateSelfSignedCert,
  generateMessageId,
  generateMicHash,
  parseMdnResponse
};
