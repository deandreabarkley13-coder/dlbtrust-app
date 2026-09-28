'use strict';

/**
 * IDP / OCR OS — intelligent document processing for the trust's paper.
 *
 * Distribution instructions, disbursement requests, beneficiary requests and
 * vendor invoices arrive as PDFs / images. This engine:
 *
 *   • ingests the document (sha256, size, mime) and stores the bytes in the
 *     private GCS bucket IDP_OCR_BUCKET (runtime identity; never in Cloud SQL);
 *   • extracts text + entities with Google Document AI (IDP_OCR_PROCESSOR) —
 *     every call leaves through the Egress OS door — or, when no processor is
 *     configured, from caller-supplied plain text with a capped confidence so
 *     the result can never auto-clear review;
 *   • classifies the document (distribution | disbursement | request |
 *     vendor_payout), redacts identifiers to last-4 before anything is written,
 *     and records the redacted field set + confidence in idp_documents;
 *   • gates: extraction below IDP_OCR_MIN_CONFIDENCE (or any missing required
 *     field) -> needs_review; review by a trustee -> reviewed; approval by a
 *     *different* trustee -> approved; `link` ties the approved document to the
 *     downstream maker-checker request (distribution request / vendor bill /
 *     Payer disbursement) that actually moves money.
 *
 * OCR never authorises or executes a payout: this engine writes no
 * cash_movements, calls no rail and creates no PPN transaction. It only tells
 * the trustees what the paper says and who checked it.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { EgressOsEngine } = require('./egressOsEngine');
const { getAccessToken, googleFetch, loadServiceAccount, onGoogleRuntime } = require('../google/googleServiceAccount');

const KINDS = ['distribution', 'disbursement', 'request', 'vendor_payout'];
const STATUSES = ['received', 'extracted', 'needs_review', 'reviewed', 'approved', 'linked', 'rejected'];
const MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/tiff', 'text/plain'];
const TEXT_ONLY_MAX_CONFIDENCE = 0.5;
const MAX_BYTES = 20 * 1024 * 1024;

const GCS_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';
const DOC_AI_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const GCS_UPLOAD = 'https://storage.googleapis.com/upload/storage/v1/b';

// Fields a document must yield before it can be approved, per kind.
const REQUIRED_FIELDS = {
  distribution: ['amount', 'payee_name'],
  disbursement: ['amount', 'payee_name', 'purpose'],
  request: ['amount', 'requester_name'],
  vendor_payout: ['amount', 'vendor_name', 'invoice_number'],
};

const KIND_KEYWORDS = {
  vendor_payout: ['invoice', 'invoice number', 'bill to', 'remit to', 'vendor', 'net 30', 'amount due', 'payable to'],
  disbursement: ['disbursement', 'disburse', 'expense', 'reimburse', 'pay on behalf', 'trustee fee'],
  request: ['request', 'requesting', 'i request', 'please distribute', 'hardship', 'hems', 'health, education, maintenance'],
  distribution: ['distribution', 'distribute', 'beneficiary', 'income distribution', 'k-1', 'schedule k-1'],
};

class IdpOcrError extends Error {
  constructor(message, code = 'IDP_OCR_ERROR', status = 409, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function isTrue(v, dflt = false) {
  const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  if (!s) return dflt;
  return s === 'true' || s === '1' || s === 'yes';
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function getIdpOcrConfig(env = process.env) {
  const processor = String(env.IDP_OCR_PROCESSOR || '').trim() || null; // projects/<n>/locations/<loc>/processors/<id>
  const m = processor ? /^projects\/[^/]+\/locations\/([^/]+)\/processors\/[^/]+$/.exec(processor) : null;
  return {
    enabled: isTrue(env.IDP_OCR_ENABLED, true),
    live: isTrue(env.IDP_OCR_LIVE),
    provider: processor ? 'document_ai' : 'text_only',
    processor,
    processorLocation: m ? m[1] : null,
    bucket: String(env.IDP_OCR_BUCKET || '').trim() || null,
    prefix: String(env.IDP_OCR_BUCKET_PREFIX || 'idp/documents').replace(/\/+$/, ''),
    minConfidence: Math.min(1, Math.max(0, Number(env.IDP_OCR_MIN_CONFIDENCE) || 0.85)),
    requireDistinctApprover: isTrue(env.IDP_OCR_REQUIRE_DISTINCT_APPROVER, true),
    kinds: KINDS,
    timeoutMs: Number(env.IDP_OCR_TIMEOUT_MS) || 60000,
  };
}

// ─── Redaction ────────────────────────────────────────────────────────────────

/** Mask anything that looks like an account / TIN / routing / card number to its last 4. */
function redactIdentifiers(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, (s) => `***-**-${s.slice(-4)}`)
    .replace(/\b\d{2}-\d{7}\b/g, (s) => `**-***${s.slice(-4)}`)
    .replace(/\b\d{9,19}\b/g, (s) => `${'*'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`);
}

function redactFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'number') { out[k] = v; continue; }
    out[k] = redactIdentifiers(v).slice(0, 512);
  }
  return out;
}

// ─── Classification and heuristic extraction ──────────────────────────────────

function classify(text) {
  const t = String(text || '').toLowerCase();
  const scores = {};
  for (const [kind, words] of Object.entries(KIND_KEYWORDS)) {
    scores[kind] = words.reduce((n, w) => n + (t.includes(w.toLowerCase()) ? 1 : 0), 0);
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [kind, hits] = ranked[0];
  const runnerUp = ranked[1] ? ranked[1][1] : 0;
  if (!hits) return { kind: null, confidence: 0, scores };
  const confidence = Math.min(1, 0.4 + 0.15 * hits - 0.1 * runnerUp);
  return { kind, confidence: Math.max(0, Math.round(confidence * 100) / 100), scores };
}

function firstMatch(text, patterns) {
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return (m[1] || m[0]).trim();
  }
  return null;
}

function parseAmount(s) {
  if (!s) return null;
  const n = Number(String(s).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** Text-only extraction: enough to route a plain request, never enough to clear review. */
function extractFromText(text) {
  const t = String(text || '');
  const amount = parseAmount(firstMatch(t, [/(?:amount(?: due)?|total(?: due)?|sum of|for)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i, /\$\s*([\d,]+(?:\.\d{2})?)/]));
  const fields = {
    amount,
    currency: 'USD',
    payee_name: firstMatch(t, [/(?:pay(?:able)? to|payee|beneficiary)\s*[:\-]\s*([A-Za-z][A-Za-z .,'&-]{2,80})/i]),
    vendor_name: firstMatch(t, [/(?:vendor|from|remit to)\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9 .,'&-]{2,80})/i]),
    requester_name: firstMatch(t, [/(?:requested by|requester|from)\s*[:\-]\s*([A-Za-z][A-Za-z .,'-]{2,80})/i]),
    invoice_number: firstMatch(t, [/invoice\s*(?:no\.?|number|#)\s*[:\-]?\s*([A-Za-z0-9-]{2,40})/i]),
    purpose: firstMatch(t, [/(?:purpose|for|memo|description)\s*[:\-]\s*([^\n]{3,160})/i]),
    date: firstMatch(t, [/\b(\d{4}-\d{2}-\d{2})\b/, /\b(\d{1,2}\/\d{1,2}\/\d{4})\b/]),
  };
  const present = Object.values(fields).filter((v) => v !== null && v !== undefined).length;
  const confidence = Math.min(TEXT_ONLY_MAX_CONFIDENCE, 0.1 * present);
  return { fields, confidence: Math.round(confidence * 100) / 100 };
}

/** Map Document AI entities (invoice / form parsers) onto the trust's field names. */
function fieldsFromDocumentAi(doc) {
  const entities = Array.isArray(doc && doc.entities) ? doc.entities : [];
  const fields = {};
  const confidences = [];
  const put = (key, e) => {
    if (fields[key] !== undefined) return;
    const v = e.normalizedValue && e.normalizedValue.text ? e.normalizedValue.text : e.mentionText;
    if (v === undefined || v === null || v === '') return;
    fields[key] = key === 'amount' ? parseAmount(v) : String(v).trim();
    if (typeof e.confidence === 'number') confidences.push(e.confidence);
  };
  for (const e of entities) {
    const type = String(e.type || '').toLowerCase();
    if (['total_amount', 'amount_due', 'net_amount', 'amount'].includes(type)) put('amount', e);
    else if (['supplier_name', 'vendor_name', 'remit_to_name'].includes(type)) put('vendor_name', e);
    else if (['receiver_name', 'payee', 'payee_name', 'beneficiary_name'].includes(type)) put('payee_name', e);
    else if (['requester_name', 'sender_name', 'from'].includes(type)) put('requester_name', e);
    else if (['invoice_id', 'invoice_number'].includes(type)) put('invoice_number', e);
    else if (['invoice_date', 'due_date', 'date'].includes(type)) put('date', e);
    else if (['line_item/description', 'description', 'purpose', 'memo'].includes(type)) put('purpose', e);
    else if (['currency'].includes(type)) put('currency', e);
  }
  const confidence = confidences.length ? Math.min(...confidences) : 0;
  return { fields, confidence: Math.round(confidence * 100) / 100, text: String(doc && doc.text ? doc.text : '') };
}

function missingRequired(kind, fields) {
  return (REQUIRED_FIELDS[kind] || REQUIRED_FIELDS.request).filter((f) => fields[f] === null || fields[f] === undefined || fields[f] === '');
}

function normalizeActor(actor) {
  return String(actor || '').trim().toLowerCase() || null;
}

const IdpOcrOsEngine = {
  Error: IdpOcrError,
  getConfig: getIdpOcrConfig,
  classify,
  extractFromText,
  fieldsFromDocumentAi,
  redactIdentifiers,
  redactFields,
  KINDS,
  STATUSES,
  REQUIRED_FIELDS,

  async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS idp_documents (
        document_id      VARCHAR(64) PRIMARY KEY,
        declared_kind    VARCHAR(32),
        kind             VARCHAR(32),
        kind_confidence  NUMERIC(5,4),
        status           VARCHAR(24) NOT NULL DEFAULT 'received',
        mime_type        VARCHAR(64),
        byte_size        BIGINT,
        sha256           CHAR(64) NOT NULL,
        storage_uri      TEXT,
        provider         VARCHAR(32),
        processor        TEXT,
        confidence       NUMERIC(5,4),
        fields           JSONB NOT NULL DEFAULT '{}'::jsonb,
        missing_fields   JSONB NOT NULL DEFAULT '[]'::jsonb,
        review_notes     TEXT,
        submitted_by     VARCHAR(128),
        reviewed_by      VARCHAR(128),
        approved_by      VARCHAR(128),
        linked_type      VARCHAR(48),
        linked_ref       VARCHAR(128),
        error            TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_idp_documents_status ON idp_documents(status, created_at DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_idp_documents_sha ON idp_documents(sha256)');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS idp_events (
        event_id     VARCHAR(64) PRIMARY KEY,
        document_id  VARCHAR(64),
        event_type   VARCHAR(48) NOT NULL,
        actor        VARCHAR(128),
        detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_idp_events_doc ON idp_events(document_id, created_at DESC)');
  },

  async _event(documentId, type, actor, detail = {}) {
    if (!pool) return;
    await pool.query(
      'INSERT INTO idp_events (event_id, document_id, event_type, actor, detail) VALUES ($1,$2,$3,$4,$5)',
      [newId('IDPE'), documentId, type, actor, JSON.stringify(detail)]
    ).catch(() => {});
  },

  async _doc(documentId) {
    if (!pool) return null;
    const r = await pool.query('SELECT * FROM idp_documents WHERE document_id = $1', [documentId]);
    return r.rows[0] || null;
  },

  async _update(documentId, patch) {
    const keys = Object.keys(patch);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const vals = keys.map((k) => (k === 'fields' || k === 'missing_fields' ? JSON.stringify(patch[k]) : patch[k]));
    const r = await pool.query(
      `UPDATE idp_documents SET ${sets.join(', ')}, updated_at = NOW() WHERE document_id = $1 RETURNING *`,
      [documentId, ...vals]
    );
    return r.rows[0] || null;
  },

  // ─── Storage (private GCS bucket, runtime identity) ─────────────────────────

  storage(cfg = getIdpOcrConfig()) {
    if (!cfg.bucket) return { enabled: false, bucket: null, ready: false, reason: 'IDP_OCR_BUCKET not set' };
    let sa = null;
    let error = null;
    try { sa = loadServiceAccount({ keyEnv: 'IDP_OCR_SERVICE_ACCOUNT_KEY' }); } catch (e) { error = e.message; }
    const credentialed = Boolean(sa) || onGoogleRuntime();
    return {
      enabled: true,
      bucket: cfg.bucket,
      prefix: cfg.prefix,
      credential: sa ? sa.source : (onGoogleRuntime() ? 'runtime_identity' : null),
      ready: credentialed && !error,
      reason: error || (credentialed ? null : 'not running on Cloud Run and no IDP_OCR_SERVICE_ACCOUNT_KEY'),
    };
  },

  async _token(scope) {
    let sa = null;
    try { sa = loadServiceAccount({ keyEnv: 'IDP_OCR_SERVICE_ACCOUNT_KEY' }); } catch { sa = null; }
    return getAccessToken(sa, scope);
  },

  async _store(documentId, bytes, mimeType, cfg) {
    const store = this.storage(cfg);
    if (!store.enabled) return null;
    if (!store.ready) throw new IdpOcrError(`document store not writable: ${store.reason}`, 'IDP_OCR_STORE', 503);
    const objectName = `${store.prefix}/${new Date().toISOString().slice(0, 10)}/${documentId}`;
    const url = `${GCS_UPLOAD}/${encodeURIComponent(store.bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
    await EgressOsEngine.authorize(url, { caller: 'idp-ocr', record: false });
    const token = await this._token(GCS_SCOPE);
    const res = await googleFetch('POST', url, token, bytes, { headers: { 'Content-Type': mimeType }, timeoutMs: cfg.timeoutMs });
    if (!res.ok) throw new IdpOcrError(`GCS upload failed: HTTP ${res.statusCode}`, 'IDP_OCR_STORE', 502);
    return `gs://${store.bucket}/${objectName}`;
  },

  // ─── Provider extraction ────────────────────────────────────────────────────

  async _documentAi(bytes, mimeType, cfg) {
    const url = `https://${cfg.processorLocation}-documentai.googleapis.com/v1/${cfg.processor}:process`;
    await EgressOsEngine.authorize(url, { caller: 'idp-ocr', record: false });
    const token = await this._token(DOC_AI_SCOPE);
    const res = await googleFetch('POST', url, token, {
      skipHumanReview: true,
      rawDocument: { content: bytes.toString('base64'), mimeType },
    }, { timeoutMs: cfg.timeoutMs });
    if (!res.ok) throw new IdpOcrError(`Document AI HTTP ${res.statusCode}`, 'IDP_OCR_PROVIDER', 502);
    return fieldsFromDocumentAi(res.json && res.json.document ? res.json.document : {});
  },

  /**
   * Run extraction for a document already ingested. `bytes` is the raw file
   * (never persisted in Cloud SQL); `text` is the plain-text fallback.
   */
  async _extract({ bytes, mimeType, text }, cfg) {
    if (cfg.provider === 'document_ai' && bytes) {
      const r = await this._documentAi(bytes, mimeType, cfg);
      return { provider: 'document_ai', fields: r.fields, confidence: r.confidence, text: r.text };
    }
    const src = text || (mimeType === 'text/plain' && bytes ? bytes.toString('utf8') : '');
    const r = extractFromText(src);
    return { provider: 'text_only', fields: r.fields, confidence: r.confidence, text: src };
  },

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * ingest: { contentBase64?, text?, mimeType, declaredKind?, actor }
   * Stores bytes (GCS), extracts, classifies, redacts, and lands the document
   * in `extracted` (confidence >= threshold and nothing missing) or
   * `needs_review`. Text-only extraction always lands in needs_review.
   */
  async ingest({ contentBase64 = null, text = null, mimeType = 'application/pdf', declaredKind = null, actor = null } = {}) {
    const cfg = getIdpOcrConfig();
    if (!cfg.enabled) throw new IdpOcrError('IDP_OCR_ENABLED=false', 'IDP_OCR_DISABLED', 503);
    if (!pool) throw new IdpOcrError('ledger database not connected', 'IDP_OCR_DB', 503);
    if (!contentBase64 && !text) throw new IdpOcrError('contentBase64 or text is required', 'IDP_OCR_BAD_REQUEST', 400);
    if (declaredKind && !KINDS.includes(declaredKind)) throw new IdpOcrError(`declaredKind must be one of ${KINDS.join(', ')}`, 'IDP_OCR_BAD_REQUEST', 400);
    const mime = contentBase64 ? String(mimeType || '').toLowerCase() : 'text/plain';
    if (!MIME_TYPES.includes(mime)) throw new IdpOcrError(`unsupported mimeType ${mime}`, 'IDP_OCR_BAD_REQUEST', 400);

    const bytes = contentBase64 ? Buffer.from(String(contentBase64), 'base64') : Buffer.from(String(text), 'utf8');
    if (!bytes.length) throw new IdpOcrError('empty document', 'IDP_OCR_BAD_REQUEST', 400);
    if (bytes.length > MAX_BYTES) throw new IdpOcrError('document exceeds 20 MB', 'IDP_OCR_BAD_REQUEST', 413);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

    const dup = await pool.query("SELECT document_id, status FROM idp_documents WHERE sha256 = $1 AND status <> 'rejected' LIMIT 1", [sha256]);
    if (dup.rows.length) throw new IdpOcrError(`duplicate of ${dup.rows[0].document_id} (${dup.rows[0].status})`, 'IDP_OCR_DUPLICATE', 409, { documentId: dup.rows[0].document_id });

    const documentId = newId('IDP');
    await pool.query(
      `INSERT INTO idp_documents (document_id, declared_kind, status, mime_type, byte_size, sha256, provider, processor, submitted_by)
       VALUES ($1,$2,'received',$3,$4,$5,$6,$7,$8)`,
      [documentId, declaredKind, mime, bytes.length, sha256, cfg.provider, cfg.processor, actor]
    );
    await this._event(documentId, 'idp.received', actor, { mime, bytes: bytes.length, declaredKind });

    let storageUri = null;
    try {
      storageUri = await this._store(documentId, bytes, mime, cfg);
    } catch (e) {
      await this._update(documentId, { error: e.message });
      await this._event(documentId, 'idp.store_failed', actor, { error: e.message });
      throw e;
    }
    if (storageUri) await this._update(documentId, { storage_uri: storageUri });

    return this._runExtraction(documentId, { bytes: contentBase64 ? bytes : null, mimeType: mime, text: text || null }, cfg, actor);
  },

  async _runExtraction(documentId, source, cfg, actor) {
    let ext;
    try {
      ext = await this._extract(source, cfg);
    } catch (e) {
      await this._update(documentId, { status: 'needs_review', error: e.message });
      await this._event(documentId, 'idp.extract_failed', actor, { error: e.message });
      return this._doc(documentId);
    }
    const doc = await this._doc(documentId);
    const cls = classify(ext.text);
    const kind = doc.declared_kind || cls.kind || 'request';
    const fields = redactFields(ext.fields);
    const missing = missingRequired(kind, fields);
    const kindMismatch = Boolean(doc.declared_kind && cls.kind && cls.kind !== doc.declared_kind);
    const clears = ext.provider === 'document_ai' && ext.confidence >= cfg.minConfidence && !missing.length && !kindMismatch;
    const status = clears ? 'extracted' : 'needs_review';
    const notes = [];
    if (ext.provider !== 'document_ai') notes.push('text-only extraction (no Document AI processor configured)');
    if (ext.confidence < cfg.minConfidence) notes.push(`confidence ${ext.confidence} below IDP_OCR_MIN_CONFIDENCE ${cfg.minConfidence}`);
    if (missing.length) notes.push(`missing required fields: ${missing.join(', ')}`);
    if (kindMismatch) notes.push(`declared ${doc.declared_kind} but text reads as ${cls.kind}`);
    const updated = await this._update(documentId, {
      kind,
      kind_confidence: cls.confidence,
      status,
      provider: ext.provider,
      confidence: ext.confidence,
      fields,
      missing_fields: missing,
      review_notes: notes.join('; ') || null,
      error: null,
    });
    await this._event(documentId, `idp.${status}`, actor, { kind, confidence: ext.confidence, missing, kindMismatch, provider: ext.provider });
    return updated;
  },

  /** review: a trustee confirms/corrects the redacted field set and kind. */
  async review({ documentId, fields = {}, kind = null, notes = null, actor = null } = {}) {
    const doc = await this._doc(documentId);
    if (!doc) throw new IdpOcrError('document not found', 'IDP_OCR_NOT_FOUND', 404);
    if (!['extracted', 'needs_review', 'reviewed'].includes(doc.status)) throw new IdpOcrError(`cannot review a ${doc.status} document`, 'IDP_OCR_STATE', 409);
    if (!normalizeActor(actor)) throw new IdpOcrError('reviewer identity required', 'IDP_OCR_ACTOR', 401);
    const k = kind || doc.kind;
    if (!KINDS.includes(k)) throw new IdpOcrError(`kind must be one of ${KINDS.join(', ')}`, 'IDP_OCR_BAD_REQUEST', 400);
    const merged = redactFields({ ...(doc.fields || {}), ...fields });
    if (merged.amount !== undefined && merged.amount !== null) merged.amount = parseAmount(merged.amount);
    const missing = missingRequired(k, merged);
    if (missing.length) throw new IdpOcrError(`still missing: ${missing.join(', ')}`, 'IDP_OCR_INCOMPLETE', 409, { missing });
    const updated = await this._update(documentId, { kind: k, fields: merged, missing_fields: [], status: 'reviewed', reviewed_by: normalizeActor(actor), review_notes: notes || doc.review_notes });
    await this._event(documentId, 'idp.reviewed', actor, { kind: k, corrected: Object.keys(fields) });
    return updated;
  },

  /** approve: a second, distinct trustee accepts the reviewed extraction. Moves no money. */
  async approve({ documentId, actor = null } = {}) {
    const cfg = getIdpOcrConfig();
    const doc = await this._doc(documentId);
    if (!doc) throw new IdpOcrError('document not found', 'IDP_OCR_NOT_FOUND', 404);
    if (doc.status !== 'reviewed') throw new IdpOcrError(`document is ${doc.status}; review is required before approval`, 'IDP_OCR_STATE', 409);
    const a = normalizeActor(actor);
    if (!a) throw new IdpOcrError('approver identity required', 'IDP_OCR_ACTOR', 401);
    if (cfg.requireDistinctApprover && a === normalizeActor(doc.reviewed_by)) throw new IdpOcrError('approver must differ from reviewer (maker/checker)', 'IDP_OCR_SAME_ACTOR', 409);
    const updated = await this._update(documentId, { status: 'approved', approved_by: a });
    await this._event(documentId, 'idp.approved', actor, { reviewedBy: doc.reviewed_by });
    return updated;
  },

  /** link: tie an approved document to the maker-checker request that will move the money. */
  async link({ documentId, linkedType, linkedRef, actor = null } = {}) {
    const doc = await this._doc(documentId);
    if (!doc) throw new IdpOcrError('document not found', 'IDP_OCR_NOT_FOUND', 404);
    if (doc.status !== 'approved') throw new IdpOcrError(`document is ${doc.status}; only approved documents can be linked`, 'IDP_OCR_STATE', 409);
    const allowed = ['distribution_request', 'vendor_bill', 'payer_disbursement', 'private_payment_network_transaction'];
    if (!allowed.includes(linkedType)) throw new IdpOcrError(`linkedType must be one of ${allowed.join(', ')}`, 'IDP_OCR_BAD_REQUEST', 400);
    if (!linkedRef) throw new IdpOcrError('linkedRef required', 'IDP_OCR_BAD_REQUEST', 400);
    const updated = await this._update(documentId, { status: 'linked', linked_type: linkedType, linked_ref: String(linkedRef) });
    await this._event(documentId, 'idp.linked', actor, { linkedType, linkedRef });
    return updated;
  },

  async reject({ documentId, reason = null, actor = null } = {}) {
    const doc = await this._doc(documentId);
    if (!doc) throw new IdpOcrError('document not found', 'IDP_OCR_NOT_FOUND', 404);
    if (['linked', 'rejected'].includes(doc.status)) throw new IdpOcrError(`cannot reject a ${doc.status} document`, 'IDP_OCR_STATE', 409);
    const updated = await this._update(documentId, { status: 'rejected', review_notes: reason || doc.review_notes });
    await this._event(documentId, 'idp.rejected', actor, { reason });
    return updated;
  },

  // ─── Status / readiness ─────────────────────────────────────────────────────

  async counts() {
    const out = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    if (!pool) return out;
    const r = await pool.query('SELECT status, COUNT(*)::int AS n FROM idp_documents GROUP BY status');
    for (const row of r.rows) out[row.status] = row.n;
    return out;
  },

  async status() {
    const cfg = getIdpOcrConfig();
    return {
      engine: 'idp-ocr',
      enabled: cfg.enabled,
      live: cfg.live,
      provider: cfg.provider,
      processor: cfg.processor ? cfg.processor.replace(/processors\/.*/, 'processors/***') : null,
      processorLocation: cfg.processorLocation,
      storage: this.storage(cfg),
      policy: { minConfidence: cfg.minConfidence, requireDistinctApprover: cfg.requireDistinctApprover, kinds: KINDS, requiredFields: REQUIRED_FIELDS, textOnlyMaxConfidence: TEXT_ONLY_MAX_CONFIDENCE, movesMoney: false },
      documents: await this.counts(),
    };
  },

  async health() {
    const s = await this.status();
    return { ok: s.enabled, engine: 'idp-ocr', provider: s.provider, storage: s.storage.ready };
  },

  async readiness() {
    const s = await this.status();
    const cfg = getIdpOcrConfig();
    const blockers = [];
    if (!s.enabled) blockers.push('IDP_OCR_ENABLED=false');
    if (!cfg.processor) blockers.push('IDP_OCR_PROCESSOR not set (Document AI processor resource name; text-only extraction cannot clear review)');
    else if (!cfg.processorLocation) blockers.push('IDP_OCR_PROCESSOR is not projects/<n>/locations/<loc>/processors/<id>');
    if (!s.storage.enabled) blockers.push('IDP_OCR_BUCKET not set (private GCS bucket for document bytes)');
    else if (!s.storage.ready) blockers.push(`document store not writable: ${s.storage.reason}`);
    if (cfg.minConfidence < 0.8) blockers.push(`IDP_OCR_MIN_CONFIDENCE ${cfg.minConfidence} below 0.8`);
    if (!cfg.requireDistinctApprover) blockers.push('IDP_OCR_REQUIRE_DISTINCT_APPROVER=false (maker/checker disabled)');
    if (!s.live) blockers.push('IDP_OCR_LIVE not true');
    const live = blockers.length === 0;
    return { ready: live, mode: live ? 'live' : 'shadow', blockers, status: s };
  },

  async list({ limit = 50, status = null } = {}) {
    if (!pool) return [];
    const lim = Math.min(500, Math.max(1, Number(limit) || 50));
    const r = status
      ? await pool.query('SELECT * FROM idp_documents WHERE status = $1 ORDER BY created_at DESC LIMIT $2', [status, lim])
      : await pool.query('SELECT * FROM idp_documents ORDER BY created_at DESC LIMIT $1', [lim]);
    return r.rows;
  },

  async get(documentId) {
    const doc = await this._doc(documentId);
    if (!doc) return null;
    const ev = await pool.query('SELECT * FROM idp_events WHERE document_id = $1 ORDER BY created_at ASC', [documentId]);
    return { ...doc, events: ev.rows };
  },

  async process({ action, actor = null, ...body } = {}) {
    switch (action) {
      case 'ingest': return this.ingest({ ...body, actor });
      case 'review': return this.review({ ...body, actor });
      case 'approve': return this.approve({ ...body, actor });
      case 'link': return this.link({ ...body, actor });
      case 'reject': return this.reject({ ...body, actor });
      case 'classify': return classify(body.text);
      default: throw new IdpOcrError(`Unknown action: ${action}`, 'IDP_OCR_BAD_ACTION', 400);
    }
  },
};

module.exports = { IdpOcrOsEngine, IdpOcrError, getIdpOcrConfig, classify, extractFromText, fieldsFromDocumentAi, redactIdentifiers, redactFields, KINDS, REQUIRED_FIELDS };
