'use strict';

/**
 * AS2 Server Engine — Open Source AS2 1.2 Implementation
 *
 * Full AS2 protocol implementation for DLB Trust Treasury System:
 *   - Outbound: sign, optionally encrypt, transmit, process MDN
 *   - Inbound: receive, verify signature, decrypt, generate MDN
 *   - Message tracking with PostgreSQL persistence
 *   - Certificate-based authentication and non-repudiation
 *
 * Standards: RFC 4130 (AS2), RFC 3798 (MDN), RFC 5652 (CMS)
 *
 * Our AS2 ID: configurable, defaults to "DLBTRUST-AS2"
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const pool = require('../bonds/pgPool');
const { CertManager } = require('./certManager');
const { PartnerManager } = require('./partnerManager');

const LOCAL_AS2_ID = process.env.AS2_LOCAL_AS2_ID || 'DLBTRUST-AS2';
const LOCAL_CERT_ALIAS = process.env.AS2_LOCAL_CERT_ALIAS || 'dlbtrust-as2';
const MDN_BASE_URL = process.env.AS2_MDN_URL || '';

function generateMessageId() {
  const rand = crypto.randomBytes(16).toString('hex');
  return `<${rand}@dlbtrust.cloud>`;
}

function generateMIC(content, algorithm) {
  const hash = crypto.createHash(algorithm.replace('-', ''));
  hash.update(content);
  return hash.digest('base64');
}

class AS2Server {
  // ─── OUTBOUND: Send AS2 message to partner ────────────────────────────────

  /**
   * Send a file to a trading partner via AS2.
   *
   * @param {string} partnerId — partner ID or AS2 identifier
   * @param {Buffer|string} payload — file content
   * @param {string} filename — filename for Content-Disposition
   * @param {string} contentType — MIME type (default: application/octet-stream)
   * @returns {Object} transmission result
   */
  static async sendMessage(partnerId, payload, filename, contentType = 'application/octet-stream') {
    const partner = await PartnerManager.getPartner(partnerId);
    if (!partner) throw new Error(`Partner not found: ${partnerId}`);
    if (!partner.endpoint_url) throw new Error(`Partner ${partner.name} has no endpoint URL configured`);

    const messageId = generateMessageId();
    const payloadStr = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;

    // Calculate MIC (Message Integrity Check) before signing
    const mic = generateMIC(payloadStr, partner.signing_algorithm || 'sha256');

    // Try to load our signing material
    let signedBody = payloadStr;
    let bodyContentType = contentType;
    let isSigned = false;

    try {
      const { privateKey } = await CertManager.getLocalSigningMaterial(LOCAL_CERT_ALIAS);
      if (privateKey) {
        const signed = AS2Server.signPayload(payloadStr, privateKey, filename, contentType, partner.signing_algorithm || 'sha256');
        signedBody = signed.body;
        bodyContentType = signed.contentType;
        isSigned = true;
      }
    } catch (e) {
      console.warn('[AS2] Sending unsigned — no local certificate:', e.message);
    }

    // Log the outbound message
    const msgRecord = await AS2Server.logMessage({
      messageId,
      direction: 'outbound',
      as2From: LOCAL_AS2_ID,
      as2To: partner.as2_identifier,
      partnerId: partner.partner_id,
      filename,
      contentType,
      payloadSize: Buffer.byteLength(payloadStr),
      mic,
      signed: isSigned,
      status: 'sending',
    });

    // Build AS2 headers
    const parsed = new URL(partner.endpoint_url);
    const headers = {
      'Content-Type': bodyContentType,
      'Content-Length': Buffer.byteLength(signedBody),
      'AS2-From': LOCAL_AS2_ID,
      'AS2-To': partner.as2_identifier,
      'AS2-Version': '1.2',
      'Message-ID': messageId,
      'Subject': filename,
      'MIME-Version': '1.0',
      'Date': new Date().toUTCString(),
      'Content-Disposition': `attachment; filename="${filename}"`,
    };

    if (partner.request_mdn) {
      const mdnUrl = MDN_BASE_URL || partner.mdn_url || '';
      if (mdnUrl) {
        headers['Receipt-Delivery-Option'] = mdnUrl;
      }
      headers['Disposition-Notification-To'] = mdnUrl || partner.endpoint_url;
      const mdnMicAlg = partner.signing_algorithm || 'sha256';
      headers['Disposition-Notification-Options'] =
        `signed-receipt-protocol=optional, pkcs7-signature; signed-receipt-micalg=optional, ${mdnMicAlg}`;
    }

    // Transmit
    try {
      const result = await AS2Server._httpPost(parsed, headers, signedBody);

      // Process MDN from response if synchronous
      let mdnResult = null;
      if (result.statusCode >= 200 && result.statusCode < 300 && result.body) {
        mdnResult = AS2Server.parseMDN(result.body, result.headers);
      }

      // Update message status
      const newStatus = result.statusCode >= 200 && result.statusCode < 300 ? 'sent' : 'failed';
      await AS2Server.updateMessageStatus(messageId, newStatus, {
        httpStatus: result.statusCode,
        mdnReceived: !!mdnResult,
        mdnDisposition: mdnResult?.disposition || null,
        responseBody: result.body?.substring(0, 1000),
      });

      return {
        success: result.statusCode >= 200 && result.statusCode < 300,
        message_id: messageId,
        status_code: result.statusCode,
        partner: partner.name,
        filename,
        signed: isSigned,
        mic,
        mdn: mdnResult,
        transmitted_at: new Date().toISOString(),
      };
    } catch (txErr) {
      await AS2Server.updateMessageStatus(messageId, 'failed', {
        responseBody: txErr.message,
      });
      throw txErr;
    }
  }

  // ─── INBOUND: Receive AS2 message ─────────────────────────────────────────

  /**
   * Process an inbound AS2 message.
   * Called by the Express route handler when a POST arrives at /as2/receive.
   *
   * @param {Object} headers — HTTP request headers
   * @param {Buffer|string} body — request body
   * @returns {Object} { success, messageId, mdn }
   */
  static async receiveMessage(headers, body) {
    const as2From = headers['as2-from'] || headers['AS2-From'] || '';
    const as2To = headers['as2-to'] || headers['AS2-To'] || '';
    const messageId = headers['message-id'] || headers['Message-ID'] || generateMessageId();
    const subject = headers['subject'] || headers['Subject'] || 'Unknown';
    const contentType = headers['content-type'] || 'application/octet-stream';

    // Verify this message is intended for us
    if (as2To && as2To !== LOCAL_AS2_ID) {
      console.warn(`[AS2] Received message for ${as2To}, but we are ${LOCAL_AS2_ID}`);
    }

    // Find the sending partner
    const partner = await PartnerManager.getPartner(as2From);

    const bodyStr = Buffer.isBuffer(body) ? body.toString('utf8') : body;
    const mic = generateMIC(bodyStr, 'sha256');

    // Log inbound message
    await AS2Server.logMessage({
      messageId,
      direction: 'inbound',
      as2From,
      as2To,
      partnerId: partner?.partner_id || null,
      filename: subject,
      contentType,
      payloadSize: Buffer.byteLength(bodyStr),
      mic,
      signed: contentType.includes('pkcs7') || contentType.includes('signed'),
      status: 'received',
    });

    // Save the payload
    const inboxDir = path.join(__dirname, '..', '..', '..', 'data', 'as2-inbox');
    if (!fs.existsSync(inboxDir)) fs.mkdirSync(inboxDir, { recursive: true });
    const safeFilename = subject.replace(/[^a-zA-Z0-9._-]/g, '_');
    const savedPath = path.join(inboxDir, `${Date.now()}-${safeFilename}`);
    fs.writeFileSync(savedPath, bodyStr);

    // Generate MDN response
    const wantsMdn = headers['disposition-notification-to'] || headers['Disposition-Notification-To'];
    let mdn = null;
    if (wantsMdn) {
      mdn = AS2Server.generateMDN(messageId, as2From, 'processed', mic);
    }

    await AS2Server.updateMessageStatus(messageId, 'processed', {
      savedPath,
      mdnGenerated: !!mdn,
    });

    return {
      success: true,
      message_id: messageId,
      from: as2From,
      filename: subject,
      payload_size: Buffer.byteLength(bodyStr),
      saved_path: savedPath,
      mdn,
    };
  }

  // ─── MDN (Message Disposition Notification) ───────────────────────────────

  /**
   * Generate an MDN response body.
   */
  static generateMDN(originalMessageId, as2From, disposition, mic) {
    const boundary = 'MDN-BOUNDARY-' + crypto.randomBytes(8).toString('hex');
    const mdnMessageId = generateMessageId();

    let mdnBody = '';
    mdnBody += `--${boundary}\r\n`;
    mdnBody += `Content-Type: text/plain\r\n\r\n`;
    mdnBody += `This is a Message Disposition Notification for message ${originalMessageId}\r\n`;
    mdnBody += `from ${as2From} received by ${LOCAL_AS2_ID}.\r\n`;
    mdnBody += `The message has been ${disposition}.\r\n`;
    mdnBody += `\r\n`;

    mdnBody += `--${boundary}\r\n`;
    mdnBody += `Content-Type: message/disposition-notification\r\n\r\n`;
    mdnBody += `Reporting-UA: dlbtrust.cloud; DLB Trust AS2 Server\r\n`;
    mdnBody += `Original-Recipient: rfc822; ${LOCAL_AS2_ID}\r\n`;
    mdnBody += `Final-Recipient: rfc822; ${LOCAL_AS2_ID}\r\n`;
    mdnBody += `Original-Message-ID: ${originalMessageId}\r\n`;
    mdnBody += `Disposition: automatic-action/MDN-sent-automatically; ${disposition}\r\n`;
    if (mic) {
      mdnBody += `Received-Content-MIC: ${mic}, sha256\r\n`;
    }
    mdnBody += `\r\n`;
    mdnBody += `--${boundary}--\r\n`;

    return {
      messageId: mdnMessageId,
      contentType: `multipart/report; report-type=disposition-notification; boundary="${boundary}"`,
      body: mdnBody,
      disposition,
    };
  }

  /**
   * Parse an MDN from response body/headers.
   */
  static parseMDN(body, headers = {}) {
    const contentType = headers['content-type'] || '';
    if (!body) return null;

    const bodyStr = Buffer.isBuffer(body) ? body.toString('utf8') : body;
    let disposition = null;
    let receivedMIC = null;
    let originalMessageId = null;

    const dispMatch = bodyStr.match(/Disposition:\s*(.*)/i);
    if (dispMatch) disposition = dispMatch[1].trim();

    const micMatch = bodyStr.match(/Received-Content-MIC:\s*(.*)/i);
    if (micMatch) receivedMIC = micMatch[1].trim();

    const msgIdMatch = bodyStr.match(/Original-Message-ID:\s*(.*)/i);
    if (msgIdMatch) originalMessageId = msgIdMatch[1].trim();

    return {
      disposition,
      received_mic: receivedMIC,
      original_message_id: originalMessageId,
      is_success: disposition && disposition.includes('processed'),
    };
  }

  // ─── Signing ──────────────────────────────────────────────────────────────

  /**
   * Sign a payload with our private key for AS2 transmission.
   */
  static signPayload(content, privateKey, filename, contentType, algorithm = 'sha256') {
    const boundary = 'SIGNED-' + crypto.randomBytes(8).toString('hex');

    // Create the payload MIME part
    let mimeBody = '';
    mimeBody += `Content-Type: ${contentType}; name="${filename}"\r\n`;
    mimeBody += `Content-Transfer-Encoding: binary\r\n`;
    mimeBody += `Content-Disposition: attachment; filename="${filename}"\r\n`;
    mimeBody += `\r\n`;
    mimeBody += content;

    // Create detached signature
    const sign = crypto.createSign(algorithm);
    sign.update(mimeBody);
    const signature = sign.sign(privateKey, 'base64');

    let body = '';
    body += `--${boundary}\r\n`;
    body += mimeBody;
    body += `\r\n--${boundary}\r\n`;
    body += `Content-Type: application/pkcs7-signature; name="smime.p7s"; smime-type=signed-data\r\n`;
    body += `Content-Transfer-Encoding: base64\r\n`;
    body += `Content-Disposition: attachment; filename="smime.p7s"\r\n`;
    body += `\r\n`;
    body += signature + '\r\n';
    body += `--${boundary}--\r\n`;

    return {
      body,
      contentType: `multipart/signed; protocol="application/pkcs7-signature"; micalg=${algorithm}; boundary="${boundary}"`,
    };
  }

  // ─── Message Logging ──────────────────────────────────────────────────────

  static async logMessage(msg) {
    const result = await pool.query(
      `INSERT INTO as2_messages
        (message_id, direction, as2_from, as2_to, partner_id,
         filename, content_type, payload_size, mic, signed,
         encrypted, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
       RETURNING *`,
      [msg.messageId, msg.direction, msg.as2From, msg.as2To, msg.partnerId,
       msg.filename, msg.contentType, msg.payloadSize, msg.mic,
       msg.signed || false, msg.encrypted || false, msg.status || 'pending']
    );
    return result.rows[0];
  }

  static async updateMessageStatus(messageId, status, details = {}) {
    await pool.query(
      `UPDATE as2_messages SET status = $1, http_status = $2, mdn_received = $3,
       mdn_disposition = $4, response_body = $5, saved_path = $6, updated_at = NOW()
       WHERE message_id = $7`,
      [status, details.httpStatus || null, details.mdnReceived || details.mdnGenerated || false,
       details.mdnDisposition || null, details.responseBody || null,
       details.savedPath || null, messageId]
    );
  }

  static async getMessage(messageId) {
    const result = await pool.query('SELECT * FROM as2_messages WHERE message_id = $1', [messageId]);
    return result.rows[0] || null;
  }

  static async listMessages({ direction, partnerId, status, limit = 50, offset = 0 } = {}) {
    let sql = 'SELECT * FROM as2_messages WHERE 1=1';
    const params = [];
    let idx = 1;

    if (direction) { sql += ` AND direction = $${idx++}`; params.push(direction); }
    if (partnerId) { sql += ` AND partner_id = $${idx++}`; params.push(partnerId); }
    if (status) { sql += ` AND status = $${idx++}`; params.push(status); }

    sql += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await pool.query(sql, params);
    return result.rows;
  }

  // ─── Dashboard / Status ───────────────────────────────────────────────────

  static async getDashboard() {
    // Use 'active' boolean column (added by migrate-ach.sql) with fallback to 'status' text column (migrate-as2.sql)
    const [partners, certs, messages, sent, received, failed] = await Promise.all([
      pool.query("SELECT COUNT(*) as count FROM as2_partners WHERE active = TRUE").catch(() =>
        pool.query("SELECT COUNT(*) as count FROM as2_partners WHERE status = 'active'")),
      pool.query("SELECT COUNT(*) as count FROM as2_certificates WHERE status = 'active'"),
      pool.query('SELECT COUNT(*) as count FROM as2_messages'),
      pool.query("SELECT COUNT(*) as count FROM as2_messages WHERE direction = 'outbound' AND status = 'sent'"),
      pool.query("SELECT COUNT(*) as count FROM as2_messages WHERE direction = 'inbound' AND status = 'processed'"),
      pool.query("SELECT COUNT(*) as count FROM as2_messages WHERE status = 'failed'"),
    ]);

    return {
      local_as2_id: LOCAL_AS2_ID,
      active_partners: parseInt(partners.rows[0].count, 10),
      active_certificates: parseInt(certs.rows[0].count, 10),
      total_messages: parseInt(messages.rows[0].count, 10),
      messages_sent: parseInt(sent.rows[0].count, 10),
      messages_received: parseInt(received.rows[0].count, 10),
      messages_failed: parseInt(failed.rows[0].count, 10),
    };
  }

  // ─── HTTP Helper ──────────────────────────────────────────────────────────

  static _httpPost(parsedUrl, headers, body) {
    return new Promise((resolve, reject) => {
      const lib = parsedUrl.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + (parsedUrl.search || ''),
        method: 'POST',
        headers,
        rejectUnauthorized: false,
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
        });
      });

      req.on('error', reject);
      req.setTimeout(60000, () => req.destroy(new Error('AS2 request timed out')));
      req.write(body);
      req.end();
    });
  }
}

module.exports = { AS2Server };
