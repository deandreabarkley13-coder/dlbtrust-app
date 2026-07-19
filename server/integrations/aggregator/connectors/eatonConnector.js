'use strict';

/**
 * Eaton Family CU connector — a production outbound connector for the direct,
 * self-owned machine-to-machine link to Eaton over REST. It reuses the hardened
 * HTTP layer from the generic REST connector (OAuth2 client-credentials token
 * fetch/cache/refresh, mutual TLS, SSRF guard, timeouts) so there is no manual
 * credential handling and no duplicated transport code.
 *
 * What it adds on top of generic_rest is *payment-file* semantics — the pieces a
 * bank file-exchange API needs that a plain JSON payment POST does not:
 *
 * OUTBOUND (push):
 *   payload.kind === 'ach_file'  → transmit a NACHA/ISO 20022 payment FILE to
 *       Eaton's file-intake endpoint. The file content comes from either
 *       payload.content (inline) or is loaded from an existing ACH batch via
 *       payload.ach_batch_id. Sent as a JSON envelope:
 *         { filename, format, encoding:'base64', content }
 *       Returns { ok, providerRef: <file/submission id>, response }.
 *   otherwise → a standard JSON payment instruction POST (delegated to the
 *       generic connector's push), so REST-native payment initiation still works.
 *
 * INBOUND (pull):
 *   pullTransactions(conn, opts)          → normalized transactions (generic).
 *   pullFileStatus(conn, { submissionId }) → status of a submitted file.
 *   pullReturns(conn, opts)               → ACH returns / ACK-NACK records so the
 *       app learns which credits were rejected (R01/R02/…) — this is what closes
 *       the loop and lets us NOT treat a transmitted file as settled money.
 *
 * Expected connection.config (all optional unless noted; secrets never logged):
 * {
 *   baseUrl,                                   // required
 *   auth: { type:'oauth2_client_credentials', tokenUrl, clientId, clientSecret, scope, audience },
 *   useMtls, clientCertPath, clientKeyPath, clientCaPath,   // optional mutual TLS
 *   endpoints: {
 *     fileIntake:  '/ach/files',      // POST payment file
 *     fileStatus:  '/ach/files',      // GET  {fileStatus}/{submissionId}
 *     returns:     '/ach/returns',    // GET  returns / ACK-NACK
 *     transactions:'/transactions',   // GET  transactions (inbound)
 *     push:        '/payments',       // POST JSON payment instruction (fallback)
 *   },
 *   defaultFileFormat: 'nacha',       // label sent with the file envelope
 * }
 */

const {
  genericRestConnector,
  request,
  endpointUrl,
  extractList,
  toNumber,
} = require('./genericRestConnector');

const DEFAULT_ENDPOINTS = {
  fileIntake: '/ach/files',
  fileStatus: '/ach/files',
  returns: '/ach/returns',
};

// Resolve an endpoint URL, honoring config.endpoints overrides with an Eaton
// default. Falls back to the generic helper's error if baseUrl is missing.
function eatonEndpointUrl(config, key) {
  const cfg = Object.assign({}, config);
  cfg.endpoints = Object.assign({}, DEFAULT_ENDPOINTS, config.endpoints || {});
  return endpointUrl(cfg, key);
}

// Load NACHA content for a batch id without forcing the ACH engine to load
// unless a file transmit actually needs it.
async function loadBatchFile(batchId) {
  const { ACHEngine } = require('../../ach/achEngine');
  const batch = await ACHEngine.getBatch(batchId);
  if (!batch) throw new Error('ACH batch not found: ' + batchId);
  if (!batch.nacha_content) throw new Error('ACH batch has no NACHA content: ' + batchId);
  return { content: batch.nacha_content, filename: batch.filename };
}

const eatonConnector = {
  type: 'eaton',

  /**
   * Outbound. Transmit a payment file when payload.kind === 'ach_file'
   * (or an ach_batch_id / content is present); otherwise fall back to a
   * standard JSON payment POST.
   */
  async push(conn, payload) {
    payload = payload || {};
    const config = conn.config || {};
    const isFile = payload.kind === 'ach_file' || !!payload.ach_batch_id || !!payload.content;
    if (!isFile) {
      // REST-native payment instruction — reuse the generic push.
      return genericRestConnector.push(conn, payload);
    }

    let content = payload.content;
    let filename = payload.filename;
    if (!content && payload.ach_batch_id) {
      const loaded = await loadBatchFile(payload.ach_batch_id);
      content = loaded.content;
      filename = filename || loaded.filename;
    }
    if (!content) throw new Error('ach_file push requires content or ach_batch_id');
    filename = filename || ('payment-' + Date.now() + '.ach');

    const envelope = {
      filename,
      format: payload.format || config.defaultFileFormat || 'nacha',
      encoding: 'base64',
      content: Buffer.from(String(content), 'utf8').toString('base64'),
    };
    if (payload.metadata && typeof payload.metadata === 'object') envelope.metadata = payload.metadata;

    const url = eatonEndpointUrl(config, 'fileIntake');
    const { json } = await request('POST', url, config, envelope, conn);
    const providerRef = json && (json.submission_id || json.file_id || json.id || json.reference) || null;
    return { ok: true, providerRef, filename, response: json };
  },

  /**
   * Inbound transactions — normalized via the generic connector.
   */
  async pullTransactions(conn, opts) {
    return genericRestConnector.pullTransactions(conn, opts);
  },

  /**
   * Status of a previously submitted payment file.
   */
  async pullFileStatus(conn, opts) {
    opts = opts || {};
    const config = conn.config || {};
    if (!opts.submissionId) throw new Error('pullFileStatus requires opts.submissionId');
    let url = eatonEndpointUrl(config, 'fileStatus');
    url += (url.endsWith('/') ? '' : '/') + encodeURIComponent(opts.submissionId);
    const { json } = await request('GET', url, config, null, conn);
    return {
      submissionId: opts.submissionId,
      status: json && (json.status || json.state) || null,
      raw: json,
    };
  },

  /**
   * ACH returns / ACK-NACK records. Normalized to a compact shape so callers can
   * reconcile which originated credits were accepted vs. returned.
   */
  async pullReturns(conn, opts) {
    opts = opts || {};
    const config = conn.config || {};
    let url = eatonEndpointUrl(config, 'returns');
    if (opts.since) url += (url.indexOf('?') === -1 ? '?' : '&') + 'since=' + encodeURIComponent(opts.since);
    const { json } = await request('GET', url, config, null, conn);
    const list = extractList(json, (config.listPaths || {}).returns);
    return list.map((rec) => ({
      externalReturnId: rec.id || rec.return_id || rec.trace || null,
      submissionId: rec.submission_id || rec.file_id || null,
      returnCode: rec.return_code || rec.reason_code || rec.code || null,
      reason: rec.reason || rec.description || null,
      amount: toNumber(rec.amount),
      accepted: rec.accepted === true || rec.status === 'accepted',
      raw: rec,
    })).filter((r) => r.externalReturnId != null || r.submissionId != null);
  },
};

module.exports = { eatonConnector };
