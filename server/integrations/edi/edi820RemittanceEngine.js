'use strict';

/**
 * EDI 820 remittance engine — renders, stores and (when allowed) transmits
 * the X12 820 that accompanies a committed ERP payout.
 *
 * Transport is EDI_820_TRANSPORT: `as2` (our own AS2Client to a registered
 * as2_partners row) or `mftgateway` (hosted MFT Gateway station via its REST
 * API — the station signs/encrypts and delivers to the named partner).
 *
 * Two gates, both required before anything leaves over either transport:
 *
 *   CANONICAL_FUNDING_LIVE=true   the ERP draw the 820 describes actually
 *                                 happened (CanonicalFundingSource.commit
 *                                 returned committed, not a shadow plan)
 *   EDI_820_LIVE=true             the remittance rail itself is live
 *
 * Otherwise emit() renders the document, stores it as `shadow`, and returns
 * it without opening a connection — the same discipline the other rails use.
 *
 * Documents are keyed by ERP reference. A second emit for the same reference
 * returns the stored document: if it was already transmitted nothing is sent
 * again; if it is still shadow it is re-rendered from the stored run and the
 * gates are evaluated afresh, so flipping the flags later drives the same
 * interchange out once.
 */

const { renderEdi820, Edi820Error } = require('./edi820Generator');
const { CanonicalFundingSource } = require('../fineract/canonicalFundingSource');

let AS2Client = null;
try { ({ AS2Client } = require('../ach/as2Client')); } catch (e) { /* optional */ }
let AS2Partners = null;
try { ({ AS2Partners } = require('../ach/as2Partners')); } catch (e) { /* optional */ }
const { MftGatewayClient } = require('./mftGatewayClient');

const TRANSPORTS = ['as2', 'mftgateway'];

let pool = null;
try { pool = require('../bonds/pgPool'); } catch (e) { /* no DB in tests */ }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

const TABLE = 'edi_820_documents';
const memory = new Map();
let tablesReady = false;

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function bool(name, def = false) { const v = process.env[name]; return v ? String(v).toLowerCase() === 'true' : def; }

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (e) { return fallback; }
}

class Edi820RemittanceEngine {
  static getConfig() {
    return {
      rail: 'edi_820',
      transport: str('EDI_820_TRANSPORT', 'as2').toLowerCase(),
      senderId: str('EDI_820_SENDER_ID') || str('AS2_LOCAL_AS2_ID', 'DLBTRUST-AS2'),
      senderQualifier: str('EDI_820_SENDER_QUALIFIER', 'ZZ'),
      receiverId: str('EDI_820_RECEIVER_ID') || str('AS2_PARTNER_AS2_ID'),
      receiverQualifier: str('EDI_820_RECEIVER_QUALIFIER', 'ZZ'),
      senderName: str('EDI_820_PAYER_NAME') || str('NACHA_COMPANY_NAME') || str('TRUST_LEGAL_NAME', 'DLB TRUST'),
      originatorId: str('EDI_820_ORIGINATOR_ID') || str('ACH_COMPANY_ID'),
      payer: {
        name: str('EDI_820_PAYER_NAME') || str('NACHA_COMPANY_NAME') || str('TRUST_LEGAL_NAME', 'DLB TRUST'),
        id: str('EDI_820_PAYER_ID') || str('ACH_COMPANY_ID') || str('EDI_820_SENDER_ID'),
        routingNumber: str('EDI_820_ODFI_ROUTING') || str('NACHA_ODFI_ROUTING'),
        accountNumber: str('EDI_820_ODFI_ACCOUNT'),
        originatorId: str('EDI_820_ORIGINATOR_ID') || str('ACH_COMPANY_ID'),
      },
      // AS2 partner the 820 is delivered to (as2_partners.partner_id); default partner when empty.
      as2PartnerId: str('EDI_820_AS2_PARTNER_ID'),
      usageIndicator: str('EDI_820_USAGE_INDICATOR', bool('EDI_820_LIVE') ? 'P' : 'T').toUpperCase() === 'P' ? 'P' : 'T',
      live: bool('EDI_820_LIVE'),
      canonicalLive: CanonicalFundingSource.getConfig().live,
    };
  }

  /** Both gates, plus why transmission would stop. */
  static transmissionGate({ fundingCommitted } = {}) {
    const cfg = this.getConfig();
    const reasons = [];
    if (!cfg.canonicalLive) reasons.push('CANONICAL_FUNDING_LIVE=false');
    if (!cfg.live) reasons.push('EDI_820_LIVE=false');
    if (fundingCommitted === false) reasons.push('ERP draw was a shadow plan, not a committed posting');
    if (!TRANSPORTS.includes(cfg.transport)) {
      reasons.push(`EDI_820_TRANSPORT=${cfg.transport} is not a supported transport (${TRANSPORTS.join(', ')})`);
    } else if (cfg.transport === 'mftgateway') {
      try {
        if (!MftGatewayClient.configured()) reasons.push('MFT Gateway API token not configured');
      } catch (err) {
        reasons.push(err.message);
      }
    } else if (!AS2Client) reasons.push('AS2 client not available');
    return { allowed: reasons.length === 0, reasons, live: cfg.live, canonicalLive: cfg.canonicalLive };
  }

  static async readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.senderId) issues.push('EDI_820_SENDER_ID not configured');
    if (!cfg.receiverId) issues.push('EDI_820_RECEIVER_ID not configured');
    let partner = null;
    let station = null;
    if (!TRANSPORTS.includes(cfg.transport)) {
      issues.push(`EDI_820_TRANSPORT=${cfg.transport} is not a supported transport (${TRANSPORTS.join(', ')})`);
    } else if (cfg.transport === 'mftgateway') {
      let mft = null;
      try { mft = MftGatewayClient.getConfig(); } catch (err) { issues.push(err.message); }
      if (mft) {
        issues.push(...MftGatewayClient.issues());
        partner = { partnerId: mft.partnerAs2Id || null, partnerName: 'MFT Gateway partner', partnerUrl: mft.apiUrl, partnerAs2Id: mft.partnerAs2Id || null };
        if (MftGatewayClient.configured()) {
          try {
            const stations = await MftGatewayClient.listStations();
            station = stations.find((s) => s.identifier === mft.stationAs2Id) || null;
            if (!station) issues.push(`MFT Gateway station ${mft.stationAs2Id} not found on the account`);
          } catch (err) {
            issues.push(`MFT Gateway unreachable: ${err.message}`);
          }
        }
      }
    } else {
      if (!AS2Client) issues.push('AS2 client not available');
      try {
        partner = await this.resolvePartner();
      } catch (err) {
        issues.push(`AS2 partner lookup failed: ${err.message}`);
      }
      if (!partner) issues.push(cfg.as2PartnerId ? `AS2 partner ${cfg.as2PartnerId} is not registered or inactive` : 'no default AS2 partner registered');
      else if (!partner.partnerUrl) issues.push(`AS2 partner ${partner.partnerId} has no partner URL`);
    }
    const gate = this.transmissionGate();
    return {
      rail: cfg.rail,
      transport: cfg.transport,
      senderId: cfg.senderId,
      senderQualifier: cfg.senderQualifier,
      receiverId: cfg.receiverId,
      receiverQualifier: cfg.receiverQualifier,
      usageIndicator: cfg.usageIndicator,
      as2PartnerId: cfg.as2PartnerId || null,
      partner: partner ? { partnerId: partner.partnerId, partnerName: partner.partnerName, partnerUrl: partner.partnerUrl, partnerAs2Id: partner.partnerAs2Id } : null,
      station: station ? { identifier: station.identifier, name: station.name } : null,
      live: cfg.live,
      canonicalLive: cfg.canonicalLive,
      transmissionAllowed: gate.allowed,
      transmissionBlockers: gate.reasons,
      mode: gate.allowed ? 'live' : 'shadow',
      ready: issues.length === 0,
      issues,
    };
  }

  static async resolvePartner() {
    if (!AS2Partners) return null;
    const cfg = this.getConfig();
    if (cfg.as2PartnerId) return AS2Partners.getPartnerConfig(cfg.as2PartnerId);
    return AS2Partners.getDefaultPartnerConfig();
  }

  static profile() {
    const cfg = this.getConfig();
    return {
      senderId: cfg.senderId,
      senderQualifier: cfg.senderQualifier,
      receiverId: cfg.receiverId,
      receiverQualifier: cfg.receiverQualifier,
      senderName: cfg.senderName,
      originatorId: cfg.originatorId,
      payer: cfg.payer,
      usageIndicator: cfg.usageIndicator,
    };
  }

  /** Render without storing or sending — the preview path. */
  static render(run, { createdAt } = {}) {
    return renderEdi820({ run, profile: this.profile(), createdAt: createdAt || new Date() });
  }

  static filename(document) {
    return `EDI820-${String(document.erpReference).replace(/[^A-Za-z0-9._-]/g, '_')}-${document.interchangeControlNumber}.edi`;
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  static async ensureTables() {
    if (!pool || tablesReady) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        erp_reference TEXT PRIMARY KEY,
        document_id TEXT UNIQUE NOT NULL,
        workflow_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('shadow','rendered','transmitted','failed')),
        interchange_control_number TEXT NOT NULL,
        group_control_number TEXT NOT NULL,
        payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        controls JSONB NOT NULL DEFAULT '{}',
        run JSONB NOT NULL DEFAULT '{}',
        partner_id TEXT,
        as2_message_id TEXT,
        transmission JSONB,
        error_message TEXT,
        rendered_at TIMESTAMPTZ NOT NULL,
        transmitted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_workflow ON ${TABLE}(workflow_id)`);
    tablesReady = true;
  }

  static _fromRow(row) {
    if (!row) return null;
    return {
      erpReference: row.erp_reference,
      documentId: row.document_id,
      workflowId: row.workflow_id || null,
      status: row.status,
      interchangeControlNumber: row.interchange_control_number,
      groupControlNumber: row.group_control_number,
      payload: row.payload,
      payloadHash: row.payload_hash,
      controls: parseJson(row.controls, {}),
      run: parseJson(row.run, {}),
      partnerId: row.partner_id || null,
      as2MessageId: row.as2_message_id || null,
      transmission: parseJson(row.transmission, null),
      errorMessage: row.error_message || null,
      renderedAt: row.rendered_at instanceof Date ? row.rendered_at.toISOString() : row.rendered_at,
      transmittedAt: row.transmitted_at instanceof Date ? row.transmitted_at.toISOString() : (row.transmitted_at || null),
    };
  }

  static async get(erpReference) {
    if (!erpReference) return null;
    if (!pool) return memory.get(String(erpReference)) || null;
    await this.ensureTables();
    const { rows } = await pool.query(`SELECT * FROM ${TABLE} WHERE erp_reference = $1`, [String(erpReference)]);
    return this._fromRow(rows[0]);
  }

  static async getByWorkflow(workflowId) {
    if (!workflowId) return null;
    if (!pool) return [...memory.values()].find(d => d.workflowId === String(workflowId)) || null;
    await this.ensureTables();
    const { rows } = await pool.query(`SELECT * FROM ${TABLE} WHERE workflow_id = $1 ORDER BY created_at DESC LIMIT 1`, [String(workflowId)]);
    return this._fromRow(rows[0]);
  }

  static async list({ status, limit = 50 } = {}) {
    if (!pool) {
      return [...memory.values()]
        .filter(d => !status || d.status === status)
        .sort((a, b) => String(b.renderedAt).localeCompare(String(a.renderedAt)))
        .slice(0, Number(limit) || 50);
    }
    await this.ensureTables();
    const params = [];
    let where = '';
    if (status) { params.push(status); where = 'WHERE status = $1'; }
    params.push(Number(limit) || 50);
    const { rows } = await pool.query(`SELECT * FROM ${TABLE} ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return rows.map(r => this._fromRow(r));
  }

  static async _save(doc) {
    if (!pool) { memory.set(doc.erpReference, doc); return doc; }
    await this.ensureTables();
    await pool.query(
      `INSERT INTO ${TABLE}
         (erp_reference, document_id, workflow_id, status, interchange_control_number, group_control_number, payload, payload_hash, controls, run, partner_id, as2_message_id, transmission, error_message, rendered_at, transmitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (erp_reference) DO UPDATE SET
         status = EXCLUDED.status, payload = EXCLUDED.payload, payload_hash = EXCLUDED.payload_hash,
         controls = EXCLUDED.controls, run = EXCLUDED.run, partner_id = EXCLUDED.partner_id,
         as2_message_id = EXCLUDED.as2_message_id, transmission = EXCLUDED.transmission,
         error_message = EXCLUDED.error_message, transmitted_at = EXCLUDED.transmitted_at, updated_at = NOW()`,
      [
        doc.erpReference, doc.documentId, doc.workflowId || null, doc.status,
        doc.interchangeControlNumber, doc.groupControlNumber, doc.payload, doc.payloadHash,
        JSON.stringify(doc.controls || {}), JSON.stringify(doc.run || {}), doc.partnerId || null,
        doc.as2MessageId || null, doc.transmission ? JSON.stringify(doc.transmission) : null,
        doc.errorMessage || null, doc.renderedAt, doc.transmittedAt || null,
      ]
    );
    return doc;
  }

  // ── Emission ───────────────────────────────────────────────────────────────

  /**
   * Render-and-deliver for a committed payout run. Idempotent on
   * `run.erpReference`: an already-transmitted document is returned as-is
   * with `duplicate: true` and nothing is sent.
   *
   * @param {Object} opts.run               payout run (see edi820Generator)
   * @param {boolean} [opts.fundingCommitted] result of CanonicalFundingSource.commit().committed
   * @param {string} [opts.workflowId]
   */
  static async emit({ run, fundingCommitted, workflowId } = {}) {
    if (!run || !run.erpReference) throw new Edi820Error('run.erpReference is required', 'EDI_820_NO_REFERENCE', 400);
    const erpReference = String(run.erpReference);

    const existing = await this.get(erpReference);
    if (existing && existing.status === 'transmitted') {
      return { ...existing, transmitted: true, shadow: false, duplicate: true, reason: 'already transmitted for this ERP reference' };
    }

    const renderedAt = existing ? new Date(existing.renderedAt) : new Date();
    const rendered = this.render(run, { createdAt: renderedAt });
    const doc = {
      erpReference,
      documentId: existing ? existing.documentId : `EDI820-${rendered.interchangeControlNumber}`,
      workflowId: workflowId || (existing && existing.workflowId) || run.workflowId || null,
      status: 'shadow',
      interchangeControlNumber: rendered.interchangeControlNumber,
      groupControlNumber: rendered.groupControlNumber,
      payload: rendered.payload,
      payloadHash: rendered.payloadHash,
      controls: rendered.controls,
      run,
      partnerId: null,
      as2MessageId: null,
      transmission: null,
      errorMessage: null,
      renderedAt: rendered.createdAt,
      transmittedAt: null,
    };

    const gate = this.transmissionGate({ fundingCommitted });
    if (!gate.allowed) {
      await this._save(doc);
      return { ...doc, transmitted: false, shadow: true, duplicate: Boolean(existing), reason: gate.reasons.join('; '), filename: this.filename(doc) };
    }
    return this._transmit(doc, { duplicate: Boolean(existing) });
  }

  /**
   * Drive a stored document out over AS2. Same gates as emit(); a document
   * that already went out is not sent twice.
   */
  static async transmit(erpReference, { fundingCommitted } = {}) {
    const doc = await this.get(erpReference);
    if (!doc) throw new Edi820Error(`no 820 has been rendered for ${erpReference}`, 'EDI_820_NOT_FOUND', 404);
    if (doc.status === 'transmitted') {
      return { ...doc, transmitted: true, shadow: false, duplicate: true, reason: 'already transmitted for this ERP reference' };
    }
    const gate = this.transmissionGate({ fundingCommitted });
    if (!gate.allowed) {
      return { ...doc, transmitted: false, shadow: true, duplicate: false, reason: gate.reasons.join('; '), filename: this.filename(doc) };
    }
    return this._transmit(doc, { duplicate: false });
  }

  static async _transmit(doc, { duplicate }) {
    const { transport } = this.getConfig();
    if (!TRANSPORTS.includes(transport)) {
      throw new Edi820Error(`EDI_820_TRANSPORT=${transport} is not a supported transport`, 'EDI_820_BAD_TRANSPORT', 503);
    }
    if (transport === 'mftgateway') return this._transmitViaMftGateway(doc, { duplicate });
    const partner = await this.resolvePartner();
    if (!partner || !partner.partnerUrl) {
      throw new Edi820Error(
        this.getConfig().as2PartnerId
          ? `AS2 partner ${this.getConfig().as2PartnerId} is not registered, inactive or has no URL`
          : 'no AS2 partner is registered for 820 delivery',
        'EDI_820_NO_AS2_PARTNER',
        503
      );
    }
    const filename = this.filename(doc);
    try {
      const result = await AS2Client.transmit(doc.payload, filename, partner);
      if (!result || result.success === false) {
        throw new Error(`AS2 endpoint answered ${result && result.status_code}: ${(result && result.response_body) || 'no body'}`);
      }
      const sent = {
        ...doc,
        status: 'transmitted',
        partnerId: partner.partnerId || null,
        as2MessageId: result.message_id || null,
        transmission: result,
        errorMessage: null,
        transmittedAt: result.transmitted_at || new Date().toISOString(),
      };
      await this._save(sent);
      return { ...sent, transmitted: true, shadow: false, duplicate, filename };
    } catch (err) {
      await this._save({ ...doc, status: 'failed', partnerId: partner.partnerId || null, errorMessage: err.message });
      throw new Edi820Error(`820 transmission for ${doc.erpReference} failed: ${err.message}`, 'EDI_820_TRANSMIT_FAILED', 502);
    }
  }

  static async _transmitViaMftGateway(doc, { duplicate }) {
    const mft = MftGatewayClient.getConfig();
    if (!MftGatewayClient.configured() || !mft.partnerAs2Id) {
      throw new Edi820Error(`MFT Gateway transport not configured: ${MftGatewayClient.issues().join('; ')}`, 'EDI_820_NO_AS2_PARTNER', 503);
    }
    const filename = this.filename(doc);
    try {
      const result = await MftGatewayClient.submit(doc.payload, filename, {
        subject: `X12 820 ${doc.erpReference}`,
      });
      if (!result.success) {
        throw new Error(`MFT Gateway answered ${result.status_code}: ${result.response_body || 'no body'}`);
      }
      const sent = {
        ...doc,
        status: 'transmitted',
        partnerId: mft.partnerAs2Id,
        as2MessageId: result.message_id || null,
        transmission: result,
        errorMessage: null,
        transmittedAt: result.transmitted_at,
      };
      await this._save(sent);
      return { ...sent, transmitted: true, shadow: false, duplicate, filename };
    } catch (err) {
      await this._save({ ...doc, status: 'failed', partnerId: mft.partnerAs2Id, errorMessage: err.message });
      throw new Edi820Error(`820 transmission for ${doc.erpReference} failed: ${err.message}`, 'EDI_820_TRANSMIT_FAILED', 502);
    }
  }

  /** Test hook: forget in-memory documents. */
  static _resetMemory() { memory.clear(); }
}

module.exports = { Edi820RemittanceEngine, Edi820Error };
