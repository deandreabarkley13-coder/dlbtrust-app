'use strict';

/**
 * Distribution / Disbursement Request Engine
 *
 * - Beneficiaries can submit distribution/disbursement requests.
 * - Trustees (Administration + Distribution) must approve before execution.
 * - Approved requests can be executed as a Safe payout/distribution using
 *   the dApp's 2-sig Safe flow.
 * - Integrates with Asset-Debt Proof Engine, Messaging, and Calendar.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

const { TRUSTEES, REQUIRED_ROLES, validateTrustee, normalizeRole, getTrusteeByRole } = require('./trustees');

let DappEngine;
try { DappEngine = require('./dappEngine').DappEngine; } catch (e) { DappEngine = null; }

let PayoutCenterEngine;
try { PayoutCenterEngine = require('./payoutCenterEngine').PayoutCenterEngine; } catch (e) { PayoutCenterEngine = null; }

let EmailEngine;
try { EmailEngine = require('./emailEngine').EmailEngine; } catch (e) { EmailEngine = null; }

let AssetDebtProofEngine;
try { AssetDebtProofEngine = require('../accounting/assetDebtProofEngine').AssetDebtProofEngine; } catch (e) { AssetDebtProofEngine = null; }

let MessagingEngine;
try { MessagingEngine = require('../messaging/messagingEngine').MessagingEngine; } catch (e) { MessagingEngine = null; }

let CalendarEngine;
try { CalendarEngine = require('../calendar/calendarEngine').CalendarEngine; } catch (e) { CalendarEngine = null; }

function id(prefix = 'REQ') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

async function query(sql, params) {
  if (!pool || !pool.query) throw new Error('Postgres pool unavailable');
  return pool.query(sql, params);
}

async function withFallback(fn, fallback) {
  try { return await fn(); } catch (e) { if (!pool) return fallback(e); throw e; }
}

function jsonbValue(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') return JSON.parse(raw || '{}');
  return raw;
}

class DistributionRequestEngine {

  static async ensureTables() {
    await withFallback(async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS dapp_distribution_requests (
          id                TEXT PRIMARY KEY,
          type              TEXT NOT NULL CHECK (type IN ('distribution','disbursement')),
          requester_role    TEXT NOT NULL CHECK (requester_role IN ('beneficiary','trustee')),
          beneficiary_id    TEXT,
          beneficiary_email TEXT,
          beneficiary_name  TEXT,
          beneficiary_address TEXT,
          amount_cents      BIGINT NOT NULL DEFAULT 0,
          currency          TEXT NOT NULL DEFAULT 'USD',
          destination_address TEXT,
          memo              TEXT,
          proof_id          TEXT,
          safe_id           TEXT,
          source_type       TEXT,
          source_account_id TEXT,
          status            TEXT NOT NULL DEFAULT 'requested'
            CHECK (status IN ('requested','under_review','approved','rejected','payout_created','executed','failed')),
          approvals         JSONB DEFAULT '[]',
          signatures        JSONB DEFAULT '[]',
          payout_id         TEXT,
          tx_hash           TEXT,
          metadata          JSONB DEFAULT '{}',
          created_by        TEXT,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_dapp_dist_requests_status ON dapp_distribution_requests(status)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_dapp_dist_requests_beneficiary ON dapp_distribution_requests(beneficiary_email)`);
    }, () => {});
  }

  static async _mem(op, ...args) {
    if (!DistributionRequestEngine._memory) DistributionRequestEngine._memory = new Map();
    if (op === 'set') { DistributionRequestEngine._memory.set(args[0], args[1]); return args[1]; }
    if (op === 'get') return DistributionRequestEngine._memory.get(args[0]) || null;
    if (op === 'list') return Array.from(DistributionRequestEngine._memory.values());
    return null;
  }

  static async _insert(row) {
    return withFallback(async () => {
      const keys = Object.keys(row).filter(k => row[k] !== undefined);
      const cols = keys.join(',');
      const vals = keys.map((_, i) => `$${i + 1}`).join(',');
      const result = await query(`INSERT INTO dapp_distribution_requests (${cols}) VALUES (${vals}) RETURNING *`,
        keys.map(k => (k === 'approvals' || k === 'signatures' || k === 'metadata') ? JSON.stringify(row[k]) : row[k]));
      return result.rows[0];
    }, async () => this._mem('set', row.id, row));
  }

  static async _update(id, updates) {
    return withFallback(async () => {
      const keys = Object.keys(updates).filter(k => updates[k] !== undefined);
      if (!keys.length) return this.getRequest(id);
      const set = keys.map((k, i) => `${k} = $${i + 1}`).join(',');
      const values = keys.map(k => (k === 'approvals' || k === 'signatures' || k === 'metadata') ? JSON.stringify(updates[k]) : updates[k]);
      const result = await query(`UPDATE dapp_distribution_requests SET ${set}, updated_at = NOW() WHERE id = $${keys.length + 1} RETURNING *`, [...values, id]);
      return result.rows[0];
    }, async () => {
      const row = await this._mem('get', id);
      if (!row) return null;
      Object.assign(row, updates);
      return this._mem('set', id, row);
    });
  }

  static _rowToObject(row) {
    if (!row) return null;
    return {
      ...row,
      approvals: jsonbValue(row.approvals) || [],
      signatures: jsonbValue(row.signatures) || [],
      metadata: jsonbValue(row.metadata) || {},
    };
  }

  static async getRequest(id) {
    await this.ensureTables();
    return withFallback(async () => {
      const result = await query('SELECT * FROM dapp_distribution_requests WHERE id = $1', [id]);
      return this._rowToObject(result.rows[0]);
    }, async () => this._rowToObject(await this._mem('get', id)));
  }

  static async listRequests({ status, beneficiaryEmail, limit = 50 } = {}) {
    await this.ensureTables();
    return withFallback(async () => {
      const conditions = [];
      const params = [];
      let idx = 1;
      if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
      if (beneficiaryEmail) { conditions.push(`beneficiary_email = $${idx++}`); params.push(beneficiaryEmail); }
      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
      const result = await query(`SELECT * FROM dapp_distribution_requests ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`, [...params, limit, 0]);
      return result.rows.map(r => this._rowToObject(r));
    }, async () => {
      let all = await this._mem('list');
      if (status) all = all.filter(r => r.status === status);
      if (beneficiaryEmail) all = all.filter(r => String(r.beneficiary_email).toLowerCase() === String(beneficiaryEmail).toLowerCase());
      return all.reverse().slice(0, limit);
    });
  }

  /**
   * Create a distribution/disbursement request.
   */
  static async createRequest({
    type = 'distribution',
    requesterRole = 'beneficiary',
    beneficiaryId,
    beneficiaryEmail,
    beneficiaryName,
    beneficiaryAddress,
    amountUsd,
    currency = 'USD',
    destinationAddress,
    memo,
    proofId,
    safeId,
    sourceType,
    sourceAccountId,
    createdBy,
  } = {}) {
    await this.ensureTables();
    if (!['distribution', 'disbursement'].includes(type)) throw new Error('type must be distribution or disbursement');
    if (!['beneficiary', 'trustee'].includes(requesterRole)) throw new Error('requesterRole must be beneficiary or trustee');
    if (!beneficiaryEmail) throw new Error('beneficiaryEmail required');
    if (!amountUsd || Number(amountUsd) <= 0) throw new Error('amountUsd required');
    if (!destinationAddress) throw new Error('destinationAddress required');

    const amountCents = Math.round(Number(amountUsd) * 100);

    // Optional proof check
    let status = 'requested';
    if (proofId && AssetDebtProofEngine) {
      const proof = await AssetDebtProofEngine.getProof(proofId);
      if (!proof) throw new Error('Proof not found');
      if (proof.status !== 'certified') status = 'under_review';
    } else if (requesterRole === 'beneficiary') {
      status = 'under_review';
    }

    const row = {
      id: id(),
      type,
      requester_role: requesterRole,
      beneficiary_id: beneficiaryId || null,
      beneficiary_email: beneficiaryEmail,
      beneficiary_name: beneficiaryName || null,
      beneficiary_address: beneficiaryAddress || destinationAddress || null,
      amount_cents: amountCents,
      currency,
      destination_address: destinationAddress,
      memo: memo || null,
      proof_id: proofId || null,
      safe_id: safeId || null,
      source_type: sourceType || null,
      source_account_id: sourceAccountId || null,
      status,
      approvals: [],
      signatures: [],
      payout_id: null,
      tx_hash: null,
      metadata: { requesterRole, createdBy },
      created_by: createdBy || null,
    };

    const inserted = await this._insert(row);
    const request = this._rowToObject(inserted);

    try {
      if (MessagingEngine) {
        await MessagingEngine.notify({
          subject: `New ${type} request ${request.id} from ${requesterRole}`,
          body: `${beneficiaryName || beneficiaryEmail} requested $${(amountCents / 100).toFixed(2)} to ${destinationAddress}. Status: ${status}.`,
          participants: [...TRUSTEES.map(t => t.email), beneficiaryEmail],
          referenceType: 'distribution_request',
          referenceId: request.id,
          sender: 'Distribution Request Engine',
        });
      }
      if (CalendarEngine) {
        await CalendarEngine.createEvent({
          title: `Approve ${type} request ${request.id}`,
          description: `$${(amountCents / 100).toFixed(2)} request from ${beneficiaryName || beneficiaryEmail}. Awaiting two-trustee approval.`,
          start: new Date().toISOString(),
          eventType: 'disbursement',
          relatedModule: 'distribution_request',
          referenceId: request.id,
          attendees: TRUSTEES.map(t => t.email),
          createdBy: 'Distribution Request Engine',
        });
      }
    } catch (e) { console.warn('[DistributionRequestEngine] notification failed:', e.message); }

    // Sequential approval: email maker first with a one-time PIN
    try {
      const maker = getTrusteeByRole('maker');
      if (maker && EmailEngine && DappEngine) {
        const otp = await DappEngine.generateOtp(maker.email);
        await EmailEngine.sendOtp({
          to: maker.email,
          name: maker.name,
          otp: otp.otp_code || otp.otp || 'N/A',
          action: 'approve',
          actionUrl: `https://dlbtrust-app.fly.dev/dapp/request-approval.html?request=${request.id}&role=maker`,
        });
      }
    } catch (e) { console.warn('[DistributionRequestEngine] maker email failed:', e.message); }

    return request;
  }

  static async approveRequest({ requestId, role, trusteeEmail, signature, signerName, proofId } = {}) {
    await this.ensureTables();
    if (!requestId || !role || !trusteeEmail) throw new Error('requestId, role and trusteeEmail required');
    const trustee = validateTrustee(role, trusteeEmail);
    const normalizedRole = normalizeRole(role);

    const request = await this.getRequest(requestId);
    if (!request) throw new Error('Request not found');
    if (['rejected', 'executed', 'failed'].includes(request.status)) throw new Error(`Request already ${request.status}`);

    // Optionally require a certified proof before approving
    if (proofId && AssetDebtProofEngine) {
      const proof = await AssetDebtProofEngine.getProof(proofId);
      if (!proof || proof.status !== 'certified') throw new Error('A certified asset-debt proof is required before approval');
      request.proof_id = proofId;
    }

    const approvals = request.approvals || [];
    if (approvals.some(a => a.role === normalizedRole)) throw new Error(`Role ${normalizedRole} has already approved this request`);

    approvals.push({
      role: normalizedRole,
      trusteeEmail,
      signerName: signerName || trustee.name,
      signature: signature || `sig-${normalizedRole}-${Date.now()}`,
      approvedAt: new Date().toISOString(),
    });

    const updates = { approvals };
    const isMaker = normalizedRole === 'maker';
    const isChecker = normalizedRole === 'checker';

    if (isMaker) {
      updates.status = 'under_review';
    } else if (isChecker) {
      if (!approvals.some(a => a.role === 'maker')) throw new Error('Maker approval required before checker can approve');
      updates.status = 'approved';
    }

    const updated = await this._update(requestId, updates);
    const result = this._rowToObject(updated);

    try {
      if (MessagingEngine) {
        await MessagingEngine.notify({
          subject: `Distribution request ${requestId} ${isChecker ? 'approved' : `signed by ${role}`}`,
          body: `${trustee.name} ${isMaker ? 'approved as maker; awaiting checker.' : 'approved as checker; funds will be released.'}`,
          participants: [...TRUSTEES.map(t => t.email), request.beneficiary_email],
          referenceType: 'distribution_request',
          referenceId: requestId,
          sender: 'Distribution Request Engine',
        });
      }
    } catch (e) { console.warn('[DistributionRequestEngine] approve notify failed:', e.message); }

    // Sequential email flow
    try {
      if (isMaker && EmailEngine && DappEngine) {
        const checker = getTrusteeByRole('checker');
        const otp = await DappEngine.generateOtp(checker.email);
        await EmailEngine.sendOtp({
          to: checker.email,
          name: checker.name,
          otp: otp.otp_code || otp.otp || 'N/A',
          action: 'approve',
          actionUrl: `https://dlbtrust-app.fly.dev/dapp/request-approval.html?request=${requestId}&role=checker`,
        });
      }
      if (isChecker) {
        if (EmailEngine) {
          await EmailEngine.send({
            to: request.beneficiary_email,
            subject: 'Your DLB Trust distribution has been approved',
            body: `Your request ${requestId} for $${(request.amount_cents / 100).toFixed(2)} has been approved and is being released to ${request.destination_address}.`,
          });
        }
        // Auto-execute on checker approval
        if (process.env.AUTO_EXECUTE_APPROVED_REQUESTS !== 'false') {
          try {
            const executed = await this.executeRequest(requestId);
            result.payment = executed.payment;
            result.executed = true;
          } catch (execErr) {
            console.warn('[DistributionRequestEngine] auto-execute failed:', execErr.message);
            result.execute_error = execErr.message;
          }
        }
      }
    } catch (e) { console.warn('[DistributionRequestEngine] sequential email/execute failed:', e.message); }

    return result;
  }

  static async rejectRequest({ requestId, trusteeEmail, reason } = {}) {
    await this.ensureTables();
    const request = await this.getRequest(requestId);
    if (!request) throw new Error('Request not found');
    if (['executed', 'failed'].includes(request.status)) throw new Error('Request already finalized');
    const byAdmin = TRUSTEES.find(t => t.email.toLowerCase() === String(trusteeEmail).toLowerCase());
    if (!byAdmin) throw new Error('Unauthorized');
    const metadata = request.metadata || {};
    metadata.rejection = { by: trusteeEmail, reason: reason || 'Rejected', at: new Date().toISOString() };
    const updated = await this._update(requestId, { status: 'rejected', metadata });
    return this._rowToObject(updated);
  }

  /**
   * Execute an approved request by creating and (if threshold allows) executing a Safe payout.
   */
  static async executeRequest(requestId) {
    await this.ensureTables();
    const request = await this.getRequest(requestId);
    if (!request) throw new Error('Request not found');
    if (request.status !== 'approved') throw new Error('Request must be approved by both trustees before execution');
    if (!PayoutCenterEngine) throw new Error('PayoutCenterEngine not available');

    const amountUsd = (Number(request.amount_cents) / 100).toFixed(2);
    const sourceType = request.source_type || 'treasury';
    const sourceAccountId = request.source_account_id || 'TREASURY_HOT';

    const payment = await PayoutCenterEngine.createPayment({
      paymentType: request.type,
      sourceType,
      sourceAccountId,
      recipientType: 'external',
      recipientIdentifier: request.destination_address,
      amount: amountUsd,
      asset: 'SIT',
      description: request.memo || `${request.type} request ${request.id}`,
      rail: 'sit',
    });

    await this._update(requestId, { status: 'executed', tx_hash: payment.tx_hash || null, payout_id: payment.id, metadata: { ...request.metadata, payment } });

    try {
      if (MessagingEngine) {
        await MessagingEngine.notify({
          subject: `Distribution request ${requestId} executed`,
          body: `$${amountUsd} paid to ${request.destination_address}. Tx: ${payment.tx_hash || 'pending'}.`,
          participants: [...TRUSTEES.map(t => t.email), request.beneficiary_email],
          referenceType: 'distribution_request',
          referenceId: requestId,
          sender: 'Distribution Request Engine',
        });
      }
      if (CalendarEngine) {
        await CalendarEngine.createEvent({
          title: `Distribution request ${requestId} executed`,
          description: `$${amountUsd} paid to ${request.destination_address}.`,
          start: new Date().toISOString(),
          eventType: 'disbursement',
          relatedModule: 'distribution_request',
          referenceId: requestId,
          attendees: [request.beneficiary_email, ...TRUSTEES.map(t => t.email)],
          createdBy: 'Distribution Request Engine',
        });
      }
    } catch (e) { console.warn('[DistributionRequestEngine] execute notify failed:', e.message); }

    return { request: await this.getRequest(requestId), payment };
  }

  /**
   * Beneficiary view: all requests and any payouts whose destination matches.
   */
  static async getBeneficiaryActivity(beneficiaryEmail) {
    await this.ensureTables();
    const requests = await this.listRequests({ beneficiaryEmail, limit: 100 });
    const addressSet = new Set();
    requests.forEach(r => { if (r.destination_address) addressSet.add(r.destination_address.toLowerCase()); if (r.beneficiary_address) addressSet.add(r.beneficiary_address.toLowerCase()); });

    let payouts = [];
    if (DappEngine) {
      try {
        const allPayouts = await DappEngine.listPayouts();
        payouts = allPayouts.filter(p => addressSet.has(String(p.destination).toLowerCase()));
      } catch (e) { console.warn('[DistributionRequestEngine] list payouts failed:', e.message); }
    }

    return { beneficiaryEmail, requests, payouts };
  }
}

module.exports = { DistributionRequestEngine };
