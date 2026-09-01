'use strict';

/**
 * Wire Engine — DLB Trust Platform
 *
 * Fedwire-style wire transfer origination with:
 * - Wire message formatting (Type/Subtype codes, sender/receiver info)
 * - IMAD/OMAD tracking (Input/Output Message Accountability Data)
 * - Dual-approval (maker/checker) workflow for high-value payments
 * - Auto-routing: payments above threshold go wire, below go ACH
 * - Full lifecycle: initiated → pending_approval → approved → sent → confirmed → settled
 * - GL integration via TrustAccountingEngine
 * - Cashflow event recording
 *
 * PostgreSQL-backed via fineract_tenants pool.
 */

const pool = require('../bonds/pgPool');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');
const { buildMtlsOptions } = require('../ach/openBankApi');
const { PartnerBankRails } = require('../rails/partnerBankRails');

let ReserveEngine;
try { ({ ReserveEngine } = require('../finops/reserveEngine')); } catch (e) { ReserveEngine = null; }
let AttestationOsEngine;
try { ({ AttestationOsEngine } = require('../os/attestationOsEngine')); } catch (e) { AttestationOsEngine = null; }

// Wire transfer statuses
const WIRE_STATUSES = [
  'initiated',        // created by maker
  'pending_approval', // waiting for checker approval
  'approved',         // checker approved, ready to send
  'rejected',         // checker rejected
  'sending',          // transmission in progress
  'sent',             // transmitted to Fed
  'confirmed',        // Fed confirmed (IMAD received)
  'settled',          // funds settled
  'failed',           // transmission failed
  'cancelled',        // cancelled before sending
  'returned',         // wire returned by beneficiary bank
];

// Fedwire Type/Subtype codes
const WIRE_TYPE_CODES = {
  funds_transfer: { type: '10', subtype: '00', label: 'Funds Transfer' },
  foreign_transfer: { type: '10', subtype: '01', label: 'Foreign Transfer' },
  settlement: { type: '10', subtype: '02', label: 'Settlement Transfer' },
  drawdown_request: { type: '10', subtype: '40', label: 'Drawdown Request' },
  drawdown_response: { type: '10', subtype: '42', label: 'Drawdown Response' },
  service_message: { type: '10', subtype: '90', label: 'Service Message' },
};

// Account codes (matching PaymentOrchestrator)
const ACCOUNT_CODES = {
  CASH: '1000',
  DISTRIBUTIONS: '3100',
  CORPUS: '3000',
  EXPENSES: '5300',
  INTEREST_INCOME: '4100',
  ACCRUED_INTEREST: '1200',
};

// Default wire threshold (cents) — amounts >= this route to wire
const DEFAULT_WIRE_THRESHOLD_CENTS = 2500000; // $25,000

class WireEngine {

  // ─── Table Setup ──────────────────────────────────────────────────────────

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wire_transfers (
        id                    SERIAL PRIMARY KEY,
        wire_id               TEXT UNIQUE NOT NULL,
        status                TEXT NOT NULL DEFAULT 'initiated'
                                CHECK (status IN ('initiated','pending_approval','approved','rejected',
                                                  'sending','sent','confirmed','settled',
                                                  'failed','cancelled','returned')),
        -- Amount
        amount_cents          BIGINT NOT NULL,
        currency              TEXT NOT NULL DEFAULT 'USD',

        -- Wire type
        wire_type             TEXT NOT NULL DEFAULT 'funds_transfer',
        type_code             TEXT DEFAULT '10',
        subtype_code          TEXT DEFAULT '00',

        -- Payment purpose
        payment_type          TEXT DEFAULT 'trust_distribution',
        purpose               TEXT,
        description           TEXT,

        -- Sender (originator)
        sender_name           TEXT NOT NULL DEFAULT 'DLB Trust',
        sender_routing        TEXT NOT NULL DEFAULT '',
        sender_account        TEXT NOT NULL DEFAULT '1000000001',
        sender_address        TEXT DEFAULT 'P.O. Box Trust Administration',

        -- Beneficiary (receiver)
        beneficiary_name      TEXT NOT NULL,
        beneficiary_routing   TEXT NOT NULL,
        beneficiary_account   TEXT NOT NULL,
        beneficiary_bank_name TEXT,
        beneficiary_address   TEXT,

        -- Intermediary bank (optional)
        intermediary_routing  TEXT,
        intermediary_name     TEXT,

        -- Tracking
        imad                  TEXT,
        omad                  TEXT,
        fed_reference         TEXT,
        confirmation_number   TEXT,

        -- Approval chain (maker/checker)
        initiated_by          TEXT NOT NULL DEFAULT 'system',
        approved_by           TEXT,
        rejected_by           TEXT,
        rejection_reason      TEXT,
        requires_approval     BOOLEAN NOT NULL DEFAULT TRUE,

        -- GL integration
        journal_entry_id      TEXT,

        -- Error tracking
        error_message         TEXT,
        retry_count           INTEGER DEFAULT 0,

        -- Timestamps
        initiated_at          TIMESTAMPTZ DEFAULT NOW(),
        approved_at           TIMESTAMPTZ,
        rejected_at           TIMESTAMPTZ,
        sent_at               TIMESTAMPTZ,
        confirmed_at          TIMESTAMPTZ,
        settled_at            TIMESTAMPTZ,
        returned_at           TIMESTAMPTZ,
        created_at            TIMESTAMPTZ DEFAULT NOW(),
        updated_at            TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_wire_status ON wire_transfers(status);
      CREATE INDEX IF NOT EXISTS idx_wire_initiated_by ON wire_transfers(initiated_by);
      CREATE INDEX IF NOT EXISTS idx_wire_beneficiary ON wire_transfers(beneficiary_name);
    `);

    await pool.query(`ALTER TABLE wire_transfers ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';`);

    // Wire audit log
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wire_audit_log (
        id                    SERIAL PRIMARY KEY,
        wire_id               TEXT NOT NULL,
        action                TEXT NOT NULL,
        actor                 TEXT,
        details               JSONB,
        created_at            TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_wire_audit_wire_id ON wire_audit_log(wire_id);
    `);
  }

  // ─── Wire ID Generation ───────────────────────────────────────────────────

  static generateWireId() {
    const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const seq = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `WIRE-${date}-${seq}`;
  }

  static generateIMAD() {
    const now = new Date();
    const date = now.toISOString().split('T')[0].replace(/-/g, '');
    const seq = String(Math.floor(Math.random() * 999999)).padStart(6, '0');
    return `${date}B1Q${seq}`;
  }

  static generateOMAD() {
    const now = new Date();
    const date = now.toISOString().split('T')[0].replace(/-/g, '');
    const seq = String(Math.floor(Math.random() * 999999)).padStart(6, '0');
    return `${date}N1Q${seq}`;
  }

  // ─── Initiate Wire ────────────────────────────────────────────────────────

  /**
   * Initiate a new wire transfer. Creates the record and optionally posts GL entry.
   *
   * @param {Object} opts
   * @param {number} opts.amountCents - wire amount in cents
   * @param {string} opts.beneficiaryName - receiver name
   * @param {string} opts.beneficiaryRouting - receiver ABA routing
   * @param {string} opts.beneficiaryAccount - receiver account number
   * @param {string} opts.beneficiaryBankName - receiver bank name
   * @param {string} opts.beneficiaryAddress - receiver address
   * @param {string} opts.paymentType - trust_distribution|vendor_payment|interest_payment|principal_return
   * @param {string} opts.purpose - wire purpose / OBI
   * @param {string} opts.description - human-readable description
   * @param {string} opts.wireType - funds_transfer|foreign_transfer|settlement|etc
   * @param {string} opts.initiatedBy - maker username/ID
   * @param {boolean} opts.requiresApproval - require checker approval (default true)
   * @param {string} opts.intermediaryRouting - intermediary bank routing (optional)
   * @param {string} opts.intermediaryName - intermediary bank name (optional)
   * @returns {Object} wire transfer record
   */
  static async initiateWire(opts) {
    const {
      amountCents, beneficiaryName, beneficiaryRouting, beneficiaryAccount,
      beneficiaryBankName, beneficiaryAddress,
      paymentType, purpose, description, wireType,
      initiatedBy, requiresApproval,
      intermediaryRouting, intermediaryName,
      senderName, senderRouting, senderAccount, senderAddress,
      metadata,
    } = opts;
    const amountCentsNum = Number(amountCents);
    const wireMetadata = metadata || {};

    if (!Number.isFinite(amountCentsNum) || amountCentsNum <= 0) throw new Error('amountCents must be positive');
    if (!beneficiaryName) throw new Error('beneficiaryName is required');
    if (!beneficiaryRouting) throw new Error('beneficiaryRouting is required');
    if (!beneficiaryAccount) throw new Error('beneficiaryAccount is required');

    // Validate routing number (9 digits)
    if (!/^\d{9}$/.test(String(beneficiaryRouting))) {
      throw new Error('beneficiaryRouting must be a 9-digit ABA routing number');
    }

    // Security: per-transaction limit ($10M)
    const PER_WIRE_LIMIT_CENTS = 1000000000; // $10M
    if (amountCentsNum > PER_WIRE_LIMIT_CENTS) {
      throw new Error('Wire amount exceeds per-transaction limit of $10,000,000');
    }

    // Security: daily aggregate limit ($25M)
    const DAILY_LIMIT_CENTS = 2500000000; // $25M
    const todayTotal = await pool.query(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM wire_transfers
       WHERE DATE(created_at) = CURRENT_DATE AND status NOT IN ('cancelled', 'rejected', 'failed', 'returned')`
    );
    if (parseInt(todayTotal.rows[0].total, 10) + amountCentsNum > DAILY_LIMIT_CENTS) {
      throw new Error('Wire would exceed daily aggregate limit of $25,000,000. Current daily total: $' +
        (parseInt(todayTotal.rows[0].total, 10) / 100).toLocaleString());
    }

    // Security: velocity check (max 20 wires per hour)
    const hourCount = await pool.query(
      `SELECT COUNT(*) AS cnt FROM wire_transfers WHERE created_at > NOW() - INTERVAL '1 hour'`
    );
    if (parseInt(hourCount.rows[0].cnt, 10) >= 20) {
      throw new Error('Wire velocity limit exceeded: maximum 20 wires per hour');
    }

    const wireId = WireEngine.generateWireId();
    const wType = wireType || 'funds_transfer';
    const typeInfo = WIRE_TYPE_CODES[wType] || WIRE_TYPE_CODES.funds_transfer;
    const needsApproval = requiresApproval !== false;
    const initialStatus = needsApproval ? 'pending_approval' : 'approved';

    const result = await pool.query(
      `INSERT INTO wire_transfers
        (wire_id, status, amount_cents, currency,
         wire_type, type_code, subtype_code,
         payment_type, purpose, description,
         sender_name, sender_routing, sender_account, sender_address,
         beneficiary_name, beneficiary_routing, beneficiary_account,
         beneficiary_bank_name, beneficiary_address,
         intermediary_routing, intermediary_name,
         initiated_by, requires_approval, metadata,
         initiated_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'USD',
               $4, $5, $6,
               $7, $8, $9,
               $10, $11, $12, $13,
               $14, $15, $16, $17, $18,
               $19, $20,
               $21, $22, $23,
               NOW(), NOW(), NOW())
       RETURNING *`,
      [
        wireId, initialStatus, amountCentsNum,
        wType, typeInfo.type, typeInfo.subtype,
        paymentType || 'trust_distribution', purpose || null, description || null,
        senderName || 'DLB Trust', senderRouting || process.env.TRUST_BANK_ROUTING || '',
        senderAccount || '1000000001', senderAddress || 'P.O. Box Trust Administration',
        beneficiaryName, beneficiaryRouting, beneficiaryAccount,
        beneficiaryBankName || null, beneficiaryAddress || null,
        intermediaryRouting || null, intermediaryName || null,
        initiatedBy || 'system', needsApproval,
        JSON.stringify(wireMetadata),
      ]
    );

    const wire = result.rows[0];

    // Audit log
    await WireEngine.logAudit(wireId, 'initiated', initiatedBy || 'system', {
      amount_cents: amountCentsNum,
      beneficiary: beneficiaryName,
      payment_type: paymentType,
      requires_approval: needsApproval,
    });

    return wire;
  }

  // ─── Approve Wire (Checker) ───────────────────────────────────────────────

  static async approveWire(wireId, approvedBy) {
    if (!approvedBy) throw new Error('approvedBy is required for approval');

    const wire = await WireEngine.getWire(wireId);
    if (!wire) throw new Error(`Wire not found: ${wireId}`);
    if (wire.status !== 'pending_approval') {
      throw new Error(`Wire must be in 'pending_approval' status to approve, current: ${wire.status}`);
    }
    if (wire.initiated_by === approvedBy) {
      throw new Error('Maker cannot approve their own wire (dual-control violation)');
    }

    await pool.query(
      `UPDATE wire_transfers
       SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW()
       WHERE wire_id = $1`,
      [wireId, approvedBy]
    );

    await WireEngine.logAudit(wireId, 'approved', approvedBy, { previous_status: 'pending_approval' });

    return WireEngine.getWire(wireId);
  }

  // ─── Reject Wire (Checker) ────────────────────────────────────────────────

  static async rejectWire(wireId, rejectedBy, reason) {
    if (!rejectedBy) throw new Error('rejectedBy is required for rejection');

    const wire = await WireEngine.getWire(wireId);
    if (!wire) throw new Error(`Wire not found: ${wireId}`);
    if (wire.status !== 'pending_approval') {
      throw new Error(`Wire must be in 'pending_approval' status to reject, current: ${wire.status}`);
    }

    await pool.query(
      `UPDATE wire_transfers
       SET status = 'rejected', rejected_by = $2, rejection_reason = $3,
           rejected_at = NOW(), updated_at = NOW()
       WHERE wire_id = $1`,
      [wireId, rejectedBy, reason || 'Rejected by approver']
    );

    await WireEngine.logAudit(wireId, 'rejected', rejectedBy, { reason: reason || 'Rejected by approver' });

    return WireEngine.getWire(wireId);
  }

  // ─── Send Wire ────────────────────────────────────────────────────────────

  static _providerValue(body, names) {
    const roots = [body, body?.data, body?.wire, body?.payment].filter(Boolean);
    for (const root of roots) {
      for (const name of names) {
        if (root[name] !== undefined && root[name] !== null && String(root[name]).trim()) {
          return String(root[name]).trim();
        }
      }
    }
    return null;
  }

  static _providerAcceptance(responseBody) {
    let body = responseBody;
    if (typeof body === 'string') {
      try {
        body = body ? JSON.parse(body) : {};
      } catch {
        throw new Error('Wire provider returned a non-JSON response');
      }
    }
    const status = WireEngine._providerValue(body, [
      'status',
      'state',
      'payment_status',
      'wire_status',
    ]);
    if (status && ['failed', 'rejected', 'cancelled', 'canceled', 'error'].includes(status.toLowerCase())) {
      throw new Error(`Wire provider rejected transmission with status ${status}`);
    }
    const providerReference = WireEngine._providerValue(body, [
      'provider_reference',
      'external_reference',
      'wire_id',
      'payment_id',
      'transaction_id',
      'id',
    ]);
    if (!providerReference) {
      throw new Error('Wire provider response did not include an external reference');
    }
    return {
      providerReference,
      providerStatus: status || 'accepted',
      imad: WireEngine._providerValue(body, ['imad', 'input_message_accountability_data']),
      omad: WireEngine._providerValue(body, ['omad', 'output_message_accountability_data']),
      fedReference: WireEngine._providerValue(body, ['fed_reference', 'fedReference']),
      confirmationNumber: WireEngine._providerValue(body, [
        'confirmation_number',
        'confirmationNumber',
      ]),
    };
  }

  static _wireInstruction(wire) {
    const metadata = wire.metadata || {};
    return {
      reference: wire.wire_id,
      amountCents: Number(wire.amount_cents),
      currency: wire.currency || 'USD',
      beneficiaryName: wire.beneficiary_name,
      beneficiaryRouting: wire.beneficiary_routing,
      beneficiaryAccount: wire.beneficiary_account,
      description: wire.description || wire.purpose || wire.payment_type,
      counterpartyId: metadata.partnerCounterpartyId || null,
      externalAccountId: metadata.partnerExternalAccountId || null,
    };
  }

  /**
   * A wire may only be transmitted against reserves the trust actually holds at
   * an external custodian. Throws before anything reaches the bank otherwise.
   *
   * Attestation OS answers first, because it adds the condition the reserve
   * arithmetic cannot see: whether anyone has actually looked at the custodian
   * lately. A balance observed last month is a memory. It then hands the sizing
   * question to the reserve engine, so there is still one rule about how much.
   */
  static async _assertReserveBacked(wire) {
    if (!ReserveEngine) return null;
    let metadata = {};
    try { metadata = typeof wire.metadata === 'string' ? JSON.parse(wire.metadata) : (wire.metadata || {}); } catch { metadata = {}; }
    const request = {
      amountCents: Number(wire.amount_cents),
      rail: 'wire',
      accountId: metadata.sourceCashAccountId || metadata.fundingAccountId || null,
      seriesId: metadata.seriesId || metadata.seriesCode || null,
    };
    const decision = AttestationOsEngine
      ? await AttestationOsEngine.assertLive({ ...request, domain: 'treasury' })
      : await ReserveEngine.assertSpendable(request);
    if (decision && decision.warning) {
      console.warn('[wire] reserve check:', decision.warning);
    }
    return decision;
  }

  /** The exact partner bank request for an approved wire, without sending it. */
  static async previewWireOrigination(wireId) {
    const wire = await WireEngine.getWire(wireId);
    if (!wire) throw new Error(`Wire not found: ${wireId}`);
    return PartnerBankRails.prepare('wire', WireEngine._wireInstruction(wire));
  }

  static async _transmitWire(wire, wireEndpoint, bankAuth = {}) {
    await WireEngine._assertReserveBacked(wire);
    if (PartnerBankRails.isConfigured()) {
      return await PartnerBankRails.originate('wire', WireEngine._wireInstruction(wire));
    }
    const wirePayload = JSON.stringify({
      client_reference: wire.wire_id,
      type: 'fedwire',
      amount_cents: wire.amount_cents,
      currency: wire.currency || 'USD',
      sender_name: wire.sender_name,
      sender_routing: wire.sender_routing,
      sender_account: wire.sender_account,
      beneficiary_name: wire.beneficiary_name,
      beneficiary_routing: wire.beneficiary_routing,
      beneficiary_account: wire.beneficiary_account,
      beneficiary_bank: wire.beneficiary_bank_name,
      purpose: wire.payment_type,
      description: wire.description,
      submitted_at: new Date().toISOString(),
    });
    const parsed = new URL(wireEndpoint);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Wire endpoint must use HTTP or HTTPS');
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const mtlsOptions = buildMtlsOptions(bankAuth);
    const reqHeaders = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(wirePayload),
      'X-Request-ID': wire.wire_id,
      'Idempotency-Key': wire.wire_id,
      'User-Agent': 'DLBTrust-Wire/1.0',
    };
    if (bankAuth.authType === 'bearer' && bankAuth.apiKey) {
      reqHeaders.Authorization = `Bearer ${bankAuth.apiKey}`;
    } else if (bankAuth.authType === 'basic' && bankAuth.apiKey) {
      reqHeaders.Authorization = `Basic ${Buffer.from(
        `${bankAuth.apiKey}:${bankAuth.apiSecret || ''}`
      ).toString('base64')}`;
    } else if (bankAuth.authType === 'api_key' && bankAuth.apiKey) {
      reqHeaders['X-API-Key'] = bankAuth.apiKey;
    }

    const responseBody = await new Promise((resolve, reject) => {
      const req = lib.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: reqHeaders,
        timeout: 60000,
        ...mtlsOptions,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else reject(new Error(`Wire endpoint returned ${res.statusCode}: ${data.substring(0, 200)}`));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Wire endpoint timeout'));
      });
      req.write(wirePayload);
      req.end();
    });
    return WireEngine._providerAcceptance(responseBody);
  }

  static async sendWire(wireId) {
    const wire = await WireEngine.getWire(wireId);
    if (!wire) throw new Error(`Wire not found: ${wireId}`);
    if (wire.status !== 'approved') {
      throw new Error(`Wire must be in 'approved' status to send, current: ${wire.status}`);
    }
    if (!wire.requires_approval || !wire.approved_by || wire.approved_by === wire.initiated_by) {
      throw new Error('Live wire transmission requires independent maker/checker approval');
    }

    let providerAcceptance = null;
    let sentRecorded = false;
    try {
      const { SystemSettings } = require('../ach/systemSettings');
      const systemMode = await SystemSettings.getMode();
      if (systemMode !== 'production') {
        throw new Error('Wire transmission requires production system mode');
      }
      const partnerBank = PartnerBankRails.isConfigured();
      let wireEndpoint = null;
      let bankAuth = {};
      if (!partnerBank) {
        wireEndpoint = await SystemSettings.getWireEndpoint();
        if (!wireEndpoint) {
          throw new Error(
            'Wire transmission endpoint is not configured. Configure a partner bank'
            + ' (PARTNER_BANK_PROVIDER/PARTNER_BANK_API_KEY/PARTNER_BANK_ACCOUNT_ID) or a'
            + ' bank wire endpoint before sending.'
          );
        }
        const productionConfig = await SystemSettings.getProductionPartnerConfig();
        if (productionConfig?.isBill) {
          throw new Error('BILL payment recording is not a wire transmission provider');
        }
        bankAuth = await SystemSettings.getBankAuth();
      }
      const sending = await pool.query(
        `UPDATE wire_transfers SET status = 'sending', error_message = NULL,
         updated_at = NOW() WHERE wire_id = $1 AND status = 'approved'
         RETURNING wire_id`,
        [wireId]
      );
      if (!sending.rows.length) {
        throw new Error('Wire approval state changed before transmission');
      }
      const acceptance = await WireEngine._transmitWire(wire, wireEndpoint, bankAuth);
      providerAcceptance = acceptance;
      const transmissionMetadata = {
        externalProviderReference: acceptance.providerReference,
        externalProviderStatus: acceptance.providerStatus,
        transmittedAt: new Date().toISOString(),
      };

      const sent = await pool.query(
        `UPDATE wire_transfers
         SET status = 'sent', imad = $2, omad = $3, fed_reference = $4,
             confirmation_number = $5,
             metadata = COALESCE(metadata, '{}'::jsonb) || $6::jsonb,
             sent_at = NOW(), updated_at = NOW()
         WHERE wire_id = $1 AND status = 'sending'
         RETURNING wire_id`,
        [
          wireId,
          acceptance.imad,
          acceptance.omad,
          acceptance.fedReference,
          acceptance.confirmationNumber,
          JSON.stringify(transmissionMetadata),
        ]
      );
      if (!sent.rows.length) {
        throw new Error('Wire provider accepted transmission but local state changed');
      }
      sentRecorded = true;

      try {
        await WireEngine.logAudit(wireId, 'sent', 'system', {
          provider_reference: acceptance.providerReference,
          provider_status: acceptance.providerStatus,
          imad: acceptance.imad,
          omad: acceptance.omad,
          fed_reference: acceptance.fedReference,
          confirmation_number: acceptance.confirmationNumber,
        });
      } catch (auditErr) {
        console.warn(`[WireEngine] Audit logging failed for sent wire ${wireId}:`, auditErr.message);
      }

      return WireEngine.getWire(wireId);
    } catch (err) {
      if (sentRecorded) {
        throw err;
      }
      if (providerAcceptance) {
        const recoveryMetadata = {
          externalProviderReference: providerAcceptance.providerReference,
          externalProviderStatus: providerAcceptance.providerStatus,
          transmissionRecordingError: err.message,
        };
        await pool.query(
          `UPDATE wire_transfers SET status = 'sending', error_message = $2,
           metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
           retry_count = retry_count + 1, updated_at = NOW()
           WHERE wire_id = $1`,
          [wireId, err.message, JSON.stringify(recoveryMetadata)]
        );
        await WireEngine.logAudit(wireId, 'transmission_reconciliation_required', 'system', {
          error: err.message,
          provider_reference: providerAcceptance.providerReference,
        });
      } else {
        await pool.query(
          `UPDATE wire_transfers SET status = 'failed', error_message = $2,
           retry_count = retry_count + 1, updated_at = NOW()
           WHERE wire_id = $1`,
          [wireId, err.message]
        );
        await WireEngine.logAudit(wireId, 'failed', 'system', { error: err.message });
      }

      throw err;
    }
  }

  static async postAccountingEntry(wireOrId, { postedBy } = {}) {
    const wire = typeof wireOrId === 'string' ? await WireEngine.getWire(wireOrId) : wireOrId;
    if (!wire) throw new Error(`Wire not found: ${wireOrId}`);
    if (wire.payment_type === 'bill_deposit') return null;

    const lockClient = await pool.connect();
    try {
      await lockClient.query('BEGIN');
      await lockClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`wire-accounting:${wire.wire_id}`]);

      const existing = await lockClient.query(
        `SELECT entry_id
         FROM trust_journal_entries
         WHERE reference_id = $1
           AND reference_type IN ('wire_transfer', 'wire')
           AND status = 'posted'
         ORDER BY created_at ASC
         LIMIT 1`,
        [wire.wire_id]
      );
      if (existing.rows.length) {
        await lockClient.query(
          'UPDATE wire_transfers SET journal_entry_id = $2, updated_at = NOW() WHERE wire_id = $1',
          [wire.wire_id, existing.rows[0].entry_id]
        );
        await lockClient.query('COMMIT');
        return existing.rows[0];
      }

      const totalDollars = Number(wire.amount_cents) / 100;
      let debitAccountCode = ACCOUNT_CODES.EXPENSES;
      let journalDescription = `Wire payment: ${wire.description || wire.beneficiary_name}`;

      if (wire.payment_type === 'trust_distribution' || wire.payment_type === 'interest_payment') {
        debitAccountCode = ACCOUNT_CODES.DISTRIBUTIONS;
        journalDescription = `Wire distribution: ${wire.description || wire.beneficiary_name}`;
      } else if (wire.payment_type === 'principal_return') {
        debitAccountCode = ACCOUNT_CODES.CORPUS;
        journalDescription = `Wire principal return: ${wire.description || wire.beneficiary_name}`;
      } else if (wire.payment_type === 'settlement_funding') {
        journalDescription = `Wire settlement funding: ${wire.description || wire.beneficiary_name}`;
      }

      let wireMetadata = wire.metadata || {};
      if (typeof wireMetadata === 'string') {
        try { wireMetadata = JSON.parse(wireMetadata); } catch { wireMetadata = {}; }
      }
      if (wireMetadata.glDebitAccountCode) debitAccountCode = wireMetadata.glDebitAccountCode;
      const creditAccountCode = wireMetadata.glCreditAccountCode || ACCOUNT_CODES.CASH;

      const journalEntry = await TrustAccountingEngine.postJournalEntry({
        entryDate: wire.sent_at || new Date(),
        description: journalDescription,
        lines: [
          {
            accountCode: debitAccountCode,
            debitAmount: totalDollars,
            creditAmount: 0,
            memo: `Wire ${wire.wire_id}: ${wire.description || wire.payment_type}`,
          },
          {
            accountCode: creditAccountCode,
            debitAmount: 0,
            creditAmount: totalDollars,
            memo: `Wire outflow: ${wire.wire_id}`,
          },
        ],
        referenceType: 'wire_transfer',
        referenceId: wire.wire_id,
        postedBy: postedBy || wire.initiated_by || 'system',
        transactionClient: lockClient,
      });

      await lockClient.query(
        'UPDATE wire_transfers SET journal_entry_id = $2, updated_at = NOW() WHERE wire_id = $1',
        [wire.wire_id, journalEntry.entry_id]
      );
      await lockClient.query('COMMIT');
      return journalEntry;
    } catch (err) {
      await lockClient.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      lockClient.release();
    }
  }

  // ─── Settle Wire ──────────────────────────────────────────────────────────

  static async confirmWire(wireId, evidence = {}) {
    const wire = await WireEngine.getWire(wireId);
    if (!wire) throw new Error(`Wire not found: ${wireId}`);
    if (wire.status === 'confirmed') {
      return { ...wire, alreadyConfirmed: true };
    }
    const providerStatus = String(
      evidence.providerStatus || evidence.provider_status || evidence.status || ''
    ).toLowerCase();
    const confirmationReference = String(
      evidence.confirmationReference
      || evidence.confirmation_reference
      || evidence.settlementReference
      || evidence.settlement_reference
      || evidence.reference
      || ''
    ).trim();
    if (!confirmationReference) {
      throw new Error('Authenticated provider confirmation reference is required');
    }
    if (!['confirmed', 'completed', 'settled'].includes(providerStatus)) {
      throw new Error('Provider status must show confirmed, completed, or settled');
    }
    let wireMetadata = wire.metadata || {};
    if (typeof wireMetadata === 'string') {
      try { wireMetadata = JSON.parse(wireMetadata); } catch { wireMetadata = {}; }
    }
    const reconciliationPending = wire.status === 'sending'
      && Boolean(wireMetadata.externalProviderReference);
    if (wire.status !== 'sent' && !reconciliationPending) {
      throw new Error(`Wire must be in 'sent' status to confirm, current: ${wire.status}`);
    }
    const confirmationMetadata = {
      providerConfirmationReference: confirmationReference,
      providerConfirmationStatus: providerStatus,
      providerConfirmedAt: evidence.confirmedAt
        || evidence.confirmed_at
        || new Date().toISOString(),
    };
    const updated = await pool.query(
      `UPDATE wire_transfers
       SET status = 'confirmed',
           confirmation_number = COALESCE($2, confirmation_number),
           imad = COALESCE($3, imad),
           omad = COALESCE($4, omad),
           fed_reference = COALESCE($5, fed_reference),
           metadata = COALESCE(metadata, '{}'::jsonb) || $6::jsonb,
           confirmed_at = NOW(), updated_at = NOW()
       WHERE wire_id = $1 AND status IN ('sent','sending')
       RETURNING wire_id`,
      [
        wireId,
        evidence.confirmationNumber || evidence.confirmation_number || null,
        evidence.imad || null,
        evidence.omad || null,
        evidence.fedReference || evidence.fed_reference || null,
        JSON.stringify(confirmationMetadata),
      ]
    );
    if (!updated.rows.length) {
      throw new Error('Wire state changed before provider confirmation was recorded');
    }
    await WireEngine.logAudit(wireId, 'confirmed', evidence.confirmedBy || 'authenticated_operator', {
      provider_reference: confirmationReference,
      provider_status: providerStatus,
    });
    return WireEngine.getWire(wireId);
  }

  static async settleWire(wireId, evidence = {}) {
    const wire = await WireEngine.getWire(wireId);
    if (!wire) throw new Error(`Wire not found: ${wireId}`);
    if (wire.status === 'settled') return { ...wire, alreadySettled: true };
    if (wire.status !== 'confirmed') {
      throw new Error(`Wire must be in 'confirmed' status to settle, current: ${wire.status}`);
    }
    const providerStatus = String(
      evidence.providerStatus || evidence.provider_status || evidence.status || ''
    ).toLowerCase();
    const settlementReference = String(
      evidence.settlementReference
      || evidence.settlement_reference
      || evidence.reference
      || ''
    ).trim();
    if (!settlementReference) {
      throw new Error('Authenticated provider settlement reference is required');
    }
    if (!['completed', 'settled'].includes(providerStatus)) {
      throw new Error('Provider status must show completed or settled');
    }

    let journalEntry = null;
    if (wire.payment_type !== 'bill_deposit') {
      journalEntry = await WireEngine.postAccountingEntry({
        ...wire,
        sent_at: evidence.settledAt || evidence.settled_at || new Date(),
      }, {
        postedBy: evidence.settledBy || 'authenticated_operator',
      });
    }
    const settlementMetadata = {
      providerSettlementReference: settlementReference,
      providerSettlementStatus: providerStatus,
      providerSettledAt: evidence.settledAt
        || evidence.settled_at
        || new Date().toISOString(),
    };
    const updated = await pool.query(
      `UPDATE wire_transfers
       SET status = 'settled',
           fed_reference = COALESCE($2, fed_reference),
           confirmation_number = COALESCE($3, confirmation_number),
           journal_entry_id = COALESCE($4, journal_entry_id),
           metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
           settled_at = NOW(), updated_at = NOW()
       WHERE wire_id = $1 AND status = 'confirmed'
       RETURNING wire_id`,
      [
        wireId,
        evidence.fedReference || evidence.fed_reference || null,
        evidence.confirmationNumber || evidence.confirmation_number || null,
        journalEntry?.entry_id || wire.journal_entry_id || null,
        JSON.stringify(settlementMetadata),
      ]
    );
    // A settlement funding wire moves the trust's money between its own
    // accounts: recording it as an outflow would report the cash as spent while
    // it is still the trust's, and double-count it when the rail spends it.
    const isInternalTransfer = wire.payment_type === 'settlement_funding';
    if (updated.rows.length && wire.payment_type !== 'bill_deposit' && !isInternalTransfer) {
      try {
        await pool.query(
          `INSERT INTO cashflow_events
             (event_type, category, amount, direction, description, event_date, created_at)
           SELECT $1, $2, $3, 'outflow', $4, NOW(), NOW()
           WHERE NOT EXISTS (
             SELECT 1 FROM cashflow_events
             WHERE description = $4
           )`,
          [
            wire.payment_type === 'trust_distribution' ? 'distribution' : 'wire_payment',
            wire.payment_type === 'trust_distribution' ? 'financing' : 'operating',
            wire.amount_cents / 100,
            `Wire ${wireId}: ${wire.description || wire.beneficiary_name}`,
          ]
        );
      } catch (err) {
        console.warn(`[WireEngine] Cashflow event failed for settled wire ${wireId}:`, err.message);
      }
    }

    await WireEngine.logAudit(wireId, 'settled', evidence.settledBy || 'authenticated_operator', {
      provider_reference: settlementReference,
      provider_status: providerStatus,
      journal_entry_id: journalEntry?.entry_id || wire.journal_entry_id || null,
    });
    return WireEngine.getWire(wireId);
  }

  // ─── Cancel Wire ──────────────────────────────────────────────────────────

  static async cancelWire(wireId, cancelledBy) {
    const wire = await WireEngine.getWire(wireId);
    if (!wire) throw new Error(`Wire not found: ${wireId}`);

    const cancellable = ['initiated', 'pending_approval', 'approved'];
    if (!cancellable.includes(wire.status)) {
      throw new Error(`Cannot cancel wire in '${wire.status}' status — only pre-send wires can be cancelled`);
    }

    await pool.query(
      `UPDATE wire_transfers SET status = 'cancelled', updated_at = NOW() WHERE wire_id = $1`,
      [wireId]
    );

    await WireEngine.logAudit(wireId, 'cancelled', cancelledBy || 'system', {});

    return WireEngine.getWire(wireId);
  }

  // ─── Return Wire ──────────────────────────────────────────────────────────

  static async returnWire(wireId, reason) {
    const wire = await WireEngine.getWire(wireId);
    if (!wire) throw new Error(`Wire not found: ${wireId}`);
    if (!['sent', 'confirmed', 'settled'].includes(wire.status)) {
      throw new Error(`Wire must be in sent/confirmed/settled status to return, current: ${wire.status}`);
    }

    await pool.query(
      `UPDATE wire_transfers SET status = 'returned', error_message = $2,
       returned_at = NOW(), updated_at = NOW()
       WHERE wire_id = $1`,
      [wireId, reason || 'Wire returned by beneficiary bank']
    );

    let journalEntryId = wire.journal_entry_id;
    if (!journalEntryId) {
      const existing = await pool.query(
        `SELECT entry_id
         FROM trust_journal_entries
         WHERE reference_id = $1
           AND reference_type IN ('wire_transfer', 'wire')
           AND status = 'posted'
         ORDER BY created_at ASC
         LIMIT 1`,
        [wireId]
      );
      journalEntryId = existing.rows[0] && existing.rows[0].entry_id;
      if (journalEntryId) {
        await pool.query(
          'UPDATE wire_transfers SET journal_entry_id = $2, updated_at = NOW() WHERE wire_id = $1',
          [wireId, journalEntryId]
        );
      }
    }

    if (journalEntryId) {
      try {
        await TrustAccountingEngine.reverseJournalEntry(journalEntryId, {
          postedBy: 'system',
        });
      } catch (revErr) {
        console.warn(`[WireEngine] GL reversal failed for ${wireId}:`, revErr.message);
      }
    }

    await WireEngine.logAudit(wireId, 'returned', 'system', { reason });

    return WireEngine.getWire(wireId);
  }

  // ─── Query Methods ────────────────────────────────────────────────────────

  static async getWire(wireId) {
    const result = await pool.query(
      'SELECT * FROM wire_transfers WHERE wire_id = $1',
      [wireId]
    );
    return result.rows[0] || null;
  }

  static async listWires({ status, fromDate, toDate, initiatedBy, limit, offset } = {}) {
    let sql = 'SELECT * FROM wire_transfers WHERE 1=1';
    const params = [];
    let idx = 1;

    if (status) { sql += ` AND status = $${idx++}`; params.push(status); }
    if (fromDate) { sql += ` AND created_at >= $${idx++}`; params.push(fromDate); }
    if (toDate) { sql += ` AND created_at <= $${idx++}`; params.push(toDate); }
    if (initiatedBy) { sql += ` AND initiated_by = $${idx++}`; params.push(initiatedBy); }

    sql += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(parseInt(limit) || 50, parseInt(offset) || 0);

    const result = await pool.query(sql, params);
    return result.rows;
  }

  static async getWireAuditLog(wireId) {
    const result = await pool.query(
      'SELECT * FROM wire_audit_log WHERE wire_id = $1 ORDER BY created_at ASC',
      [wireId]
    );
    return result.rows;
  }

  static async getPendingApprovals() {
    const result = await pool.query(
      `SELECT * FROM wire_transfers WHERE status = 'pending_approval' ORDER BY created_at ASC`
    );
    return result.rows;
  }

  // ─── Dashboard Metrics ────────────────────────────────────────────────────

  static async getWireSummary() {
    const [
      totalWires,
      pendingApproval,
      approvedWires,
      sentWires,
      confirmedWires,
      settledWires,
      failedWires,
      returnedWires,
      cancelledWires,
      rejectedWires,
      totalSentAmount,
      totalSettledAmount,
      recentWires,
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM wire_transfers'),
      pool.query("SELECT COUNT(*) as count FROM wire_transfers WHERE status = 'pending_approval'"),
      pool.query("SELECT COUNT(*) as count FROM wire_transfers WHERE status = 'approved'"),
      pool.query("SELECT COUNT(*) as count FROM wire_transfers WHERE status IN ('sending','sent')"),
      pool.query("SELECT COUNT(*) as count FROM wire_transfers WHERE status = 'confirmed'"),
      pool.query("SELECT COUNT(*) as count FROM wire_transfers WHERE status = 'settled'"),
      pool.query("SELECT COUNT(*) as count FROM wire_transfers WHERE status = 'failed'"),
      pool.query("SELECT COUNT(*) as count FROM wire_transfers WHERE status = 'returned'"),
      pool.query("SELECT COUNT(*) as count FROM wire_transfers WHERE status = 'cancelled'"),
      pool.query("SELECT COUNT(*) as count FROM wire_transfers WHERE status = 'rejected'"),
      pool.query("SELECT COALESCE(SUM(amount_cents), 0) as total FROM wire_transfers WHERE status IN ('sent','confirmed','settled')"),
      pool.query("SELECT COALESCE(SUM(amount_cents), 0) as total FROM wire_transfers WHERE status = 'settled'"),
      pool.query(`SELECT wire_id, beneficiary_name, amount_cents, status, payment_type,
                         imad, confirmation_number, created_at, confirmed_at, settled_at
                  FROM wire_transfers ORDER BY created_at DESC LIMIT 10`),
    ]);

    const sentCents = parseInt(totalSentAmount.rows[0].total, 10);
    const settledCents = parseInt(totalSettledAmount.rows[0].total, 10);

    return {
      total_wires: parseInt(totalWires.rows[0].count, 10),
      pending_approval: parseInt(pendingApproval.rows[0].count, 10),
      approved: parseInt(approvedWires.rows[0].count, 10),
      sent: parseInt(sentWires.rows[0].count, 10),
      confirmed: parseInt(confirmedWires.rows[0].count, 10),
      settled: parseInt(settledWires.rows[0].count, 10),
      failed: parseInt(failedWires.rows[0].count, 10),
      returned: parseInt(returnedWires.rows[0].count, 10),
      cancelled: parseInt(cancelledWires.rows[0].count, 10),
      rejected: parseInt(rejectedWires.rows[0].count, 10),
      total_sent_cents: sentCents,
      total_sent_dollars: sentCents / 100,
      total_settled_cents: settledCents,
      total_settled_dollars: settledCents / 100,
      wire_threshold_cents: DEFAULT_WIRE_THRESHOLD_CENTS,
      wire_threshold_dollars: DEFAULT_WIRE_THRESHOLD_CENTS / 100,
      recent_wires: recentWires.rows,
    };
  }

  // ─── Auto-Routing Logic ───────────────────────────────────────────────────

  /**
   * Determine whether a payment should route via wire or ACH.
   * @param {number} amountCents - payment amount
   * @param {Object} opts - { urgent, paymentType }
   * @returns {{ channel: 'wire'|'ach', reason: string }}
   */
  static routePayment(amountCents, opts = {}) {
    const threshold = opts.wireThreshold || DEFAULT_WIRE_THRESHOLD_CENTS;

    if (opts.urgent) {
      return { channel: 'wire', reason: 'Urgent payment — same-day wire required' };
    }
    if (amountCents >= threshold) {
      return {
        channel: 'wire',
        reason: `Amount $${(amountCents / 100).toLocaleString()} exceeds wire threshold $${(threshold / 100).toLocaleString()}`,
      };
    }
    return {
      channel: 'ach',
      reason: `Amount $${(amountCents / 100).toLocaleString()} below wire threshold — routing to ACH`,
    };
  }

  // ─── Fedwire Message Formatting ───────────────────────────────────────────

  /**
   * Format a Fedwire-style message for a wire transfer.
   * Returns a structured message object (not a raw SWIFT/Fedwire binary).
   */
  static formatWireMessage(wire) {
    const typeInfo = WIRE_TYPE_CODES[wire.wire_type] || WIRE_TYPE_CODES.funds_transfer;
    const amountFormatted = (wire.amount_cents / 100).toFixed(2);

    return {
      // Message header
      type_code: typeInfo.type,
      subtype_code: typeInfo.subtype,
      message_type: typeInfo.label,
      imad: wire.imad || null,
      omad: wire.omad || null,

      // Amount
      amount: amountFormatted,
      amount_cents: wire.amount_cents,
      currency: wire.currency || 'USD',

      // Sender
      sender: {
        name: wire.sender_name,
        routing: wire.sender_routing,
        account: wire.sender_account,
        address: wire.sender_address,
      },

      // Beneficiary
      beneficiary: {
        name: wire.beneficiary_name,
        routing: wire.beneficiary_routing,
        account: wire.beneficiary_account,
        bank_name: wire.beneficiary_bank_name,
        address: wire.beneficiary_address,
      },

      // Intermediary (optional)
      intermediary: wire.intermediary_routing ? {
        routing: wire.intermediary_routing,
        name: wire.intermediary_name,
      } : null,

      // Purpose
      purpose: wire.purpose,
      description: wire.description,
      payment_type: wire.payment_type,

      // Tracking
      wire_id: wire.wire_id,
      fed_reference: wire.fed_reference,
      confirmation_number: wire.confirmation_number,
      status: wire.status,
    };
  }

  // ─── Audit Log ────────────────────────────────────────────────────────────

  static async logAudit(wireId, action, actor, details) {
    try {
      await pool.query(
        `INSERT INTO wire_audit_log (wire_id, action, actor, details, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [wireId, action, actor || 'system', JSON.stringify(details || {})]
      );
    } catch (err) {
      console.warn(`[WireEngine] Audit log failed for ${wireId}:`, err.message);
    }
  }
}

module.exports = { WireEngine, WIRE_STATUSES, WIRE_TYPE_CODES, ACCOUNT_CODES, DEFAULT_WIRE_THRESHOLD_CENTS };
