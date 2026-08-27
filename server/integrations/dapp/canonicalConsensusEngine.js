'use strict';

/**
 * Canonical Consensus Engine
 *
 * Two-trustee Maker / Checker attestation layer for ledger-to-token actions.
 * A Maker proposes a canonical operation (mint, redeem, transfer, swap, etc.)
 * and one or more Checker/Maker roles approve it before it is executed.
 *
 * Default: 1-of-2 approval between `maker` and `checker`.
 */

const { query } = require('../bonds/pgPool');
const {
  TRUSTEES,
  REQUIRED_ROLES,
  normalizeRole,
  getTrusteeByRole,
  getTrusteeByEmail,
  getTrusteeSignatureOfRecord,
  getSignatureOfRecord,
} = require('./trustees');
const { PaymentComplianceGate } = require('../compliance/paymentComplianceGate');

let PtcStablecoinEngine, StablecoinDexEngine, ModuleP2PSwapEngine, OnOffRampEngine, TrustMarketEngine, IntentRoutingEngine, ExternalWalletEngine;
try { PtcStablecoinEngine = require('./ptcStablecoinEngine').PtcStablecoinEngine; } catch (e) { /* optional */ }
try { StablecoinDexEngine = require('./stablecoinDexEngine').StablecoinDexEngine; } catch (e) { /* optional */ }
try { ModuleP2PSwapEngine = require('./moduleP2PSwapEngine').ModuleP2PSwapEngine; } catch (e) { /* optional */ }
try { OnOffRampEngine = require('./onOffRampEngine').OnOffRampEngine; } catch (e) { /* optional */ }
try { TrustMarketEngine = require('./trustMarketEngine').TrustMarketEngine; } catch (e) { /* optional */ }
try { IntentRoutingEngine = require('./intentRoutingEngine').IntentRoutingEngine; } catch (e) { /* optional */ }
try { ExternalWalletEngine = require('./externalWalletEngine').ExternalWalletEngine; } catch (e) { /* optional */ }
let MelioEngine;
try { MelioEngine = require('../os/osEngine').MelioEngine; } catch (e) { /* optional */ }
let EmailEngine;
try { EmailEngine = require('./emailEngine').EmailEngine; } catch (e) { EmailEngine = null; }

function id(prefix = 'CC') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }
function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }

function defaultRequiredRoles() {
  return ['maker', 'checker'];
}

function defaultRequiredApprovals() {
  const n = parseInt(process.env.CANONICAL_CONSENSUS_THRESHOLD, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function isVendorBill(categoryOrProposal) {
  const category = typeof categoryOrProposal === 'string'
    ? categoryOrProposal
    : categoryOrProposal && categoryOrProposal.category;
  return category === 'vendor_bill';
}

function normalizeSignature(value) {
  return String(value || '')
    .trim()
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function isPlaceholderSignature(value) {
  return /^(sig[-_]|placeholder\b|auto[- ]?generated\b)/i.test(String(value || '').trim());
}

function approvalPortalUrl() {
  const base = process.env.APP_URL || process.env.DEPLOY_URL || '';
  return base ? `${base.replace(/\/+$/, '')}/dapp/trust-dashboard.html#finops-consensus` : '';
}

function vendorBillSummary(payload = {}) {
  const batchField = ['payables', 'items', 'rows'].find((field) => Array.isArray(payload[field]));
  const rows = batchField ? payload[batchField] : [payload];
  const lines = rows.map((row) => {
    const vendor = (row.vendor && (row.vendor.name || row.vendor.vendor_name)) || row.businessName || row.vendorName || 'unknown vendor';
    const amount = Number(row.amount);
    const invoice = row.invoiceNumber || row.invoice_number || '';
    const due = row.dueDate || row.due_date || '';
    return `  - ${vendor}: $${Number.isFinite(amount) ? amount.toFixed(2) : row.amount}${invoice ? ` (invoice ${invoice})` : ''}${due ? `, due ${due}` : ''}`;
  });
  const total = rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  return { lines, total, count: rows.length };
}

function requireVendorIdentity(payload, context) {
  const vendor = payload && payload.vendor;
  if (!vendor || (!vendor.name && !payload.vendorId)) {
    throw new Error(`${context} requires vendor.name or vendorId`);
  }
}

class CanonicalConsensusEngine {
  static _requiredApprovals(categoryOrProposal, requested) {
    const threshold = Number(requested) > 0 ? Number(requested) : defaultRequiredApprovals();
    return isVendorBill(categoryOrProposal) ? Math.max(2, threshold) : threshold;
  }

  static _validateVendorBillPayload(payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('vendor_bill payload must be an object');
    }
    if (payload.vendorPaymentBillId) {
      requireVendorIdentity(payload, 'vendor_bill');
      if (!Number.isFinite(Number(payload.amount)) || Number(payload.amount) <= 0) {
        throw new Error('vendor_bill amount must be positive');
      }
      if (!['bank_transfer', 'wire', 'ach', 'open_banking', 'web_payment'].includes(String(payload.rail || 'bank_transfer'))) {
        throw new Error('vendor_bill rail is not supported');
      }
      return { batch: false, count: 1, direct: true };
    }
    if (!MelioEngine) throw new Error('MelioEngine not available');

    const batchField = ['payables', 'items', 'rows'].find((field) => payload[field] !== undefined);
    if (batchField) {
      if (!Array.isArray(payload[batchField]) || payload[batchField].length === 0) {
        throw new Error('vendor_bill payables must be a non-empty array');
      }
      payload[batchField].forEach((bill, index) => {
        try {
          requireVendorIdentity(bill, `vendor_bill payable ${index + 1}`);
          MelioEngine._buildCsvRow(bill || {}, `CONSENSUS-BILL-${index}`);
        } catch (err) {
          throw new Error(`vendor_bill payable ${index + 1} invalid: ${err.message}`);
        }
      });
      return { batch: true, count: payload[batchField].length };
    }

    requireVendorIdentity(payload, 'vendor_bill');
    MelioEngine._buildCsvRow(payload, 'CONSENSUS-BILL');
    return { batch: false, count: 1 };
  }

  static async _executeVendorBill(payload = {}, proposalId) {
    if (payload.vendorPaymentBillId) {
      const { VendorPaymentEngine } = require('./vendorPaymentEngine');
      return VendorPaymentEngine.payBill({
        billId: payload.vendorPaymentBillId,
        consensusProposalId: proposalId,
        sourceCashAccountId: payload.sourceCashAccountId || payload.source_cash_account_id,
        rail: payload.rail,
        webPaymentAdapter: payload.webPaymentAdapter,
        openBankingConnector: payload.openBankingConnector,
        memo: payload.memo,
        initiatedBy: 'canonical-consensus',
      });
    }
    if (!MelioEngine) throw new Error('MelioEngine not available');
    const batchField = ['payables', 'items', 'rows'].find((field) => payload[field] !== undefined);
    if (batchField) {
      const screenedPayables = [];
      const complianceScreeningIds = [];
      for (const payable of payload[batchField]) {
        const compliance = await PaymentComplianceGate.screenVendorPayment({
          vendor: payable.vendor,
          amount: payable.amount,
          sourceAccountId: payable.sourceAccountId || payable.source_account_id
            || payload.sourceAccountId || payload.source_account_id,
          rail: 'melio',
          action: 'export',
          screenedBy: 'canonical-consensus',
          reference: payable.invoiceNumber || payable.invoice_number,
        });
        complianceScreeningIds.push(compliance.screeningId);
        screenedPayables.push({
          ...payable,
          metadata: {
            ...(payable.metadata || {}),
            complianceScreeningId: compliance.screeningId,
          },
        });
      }
      const result = await MelioEngine.process({
        action: 'exportBatch',
        ...payload,
        payables: screenedPayables,
      });
      const batch = result && result.result && result.result.batchId ? result.result : result;
      return {
        ...result,
        exportIdentifier: batch.batchId,
        paymentMode: 'manual_export',
        complianceScreeningIds,
        fileNames: (batch.files || []).map((file) => file.fileName),
        paymentIds: (batch.records || []).map((record) => record.id),
        journalEntryIds: (batch.records || [])
          .map((record) => record.journalEntryId)
          .filter(Boolean),
      };
    }

    const compliance = await PaymentComplianceGate.screenVendorPayment({
      vendor: payload.vendor,
      amount: payload.amount,
      sourceAccountId: payload.sourceAccountId || payload.source_account_id,
      rail: 'melio',
      action: 'export',
      screenedBy: 'canonical-consensus',
      reference: payload.invoiceNumber || payload.invoice_number,
    });
    const result = await MelioEngine.process({
      action: 'exportPayment',
      ...payload,
      metadata: {
        ...(payload.metadata || {}),
        complianceScreeningId: compliance.screeningId,
      },
    });
    const record = result && result.result && result.result.id ? result.result : result;
    return {
      ...result,
      exportIdentifier: record.id,
      paymentMode: 'manual_export',
      complianceScreeningId: compliance.screeningId,
      paymentId: record.id,
      fileName: record.result && record.result.fileName,
      journalEntryId: record.journalEntryId || null,
    };
  }

  static async ensureTables() {
    await query(`
      CREATE TABLE IF NOT EXISTS canonical_proposals (
        id                TEXT PRIMARY KEY,
        title             TEXT NOT NULL,
        description       TEXT,
        category          TEXT NOT NULL,
        payload           JSONB DEFAULT '{}',
        status            TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','executed','failed')),
        required_roles    JSONB DEFAULT '["maker","checker"]',
        required_approvals INTEGER DEFAULT 1,
        approvals         JSONB DEFAULT '[]',
        result            JSONB DEFAULT '{}',
        created_by        TEXT,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_canonical_proposals_status ON canonical_proposals(status)`);
  }

  static normalizeRole(role) {
    return normalizeRole(role);
  }

  static getSignatureOfRecord() {
    return getSignatureOfRecord();
  }

  static validateApprover(role, email) {
    const normalized = normalizeRole(role);
    const byRole = getTrusteeByRole(normalized);
    if (!byRole) throw new Error(`Unknown consensus role: ${role}`);
    if (String(byRole.email).toLowerCase() !== String(email).toLowerCase()) {
      throw new Error(`Email ${email} is not authorized for role ${role}`);
    }
    return { role: normalized, name: byRole.name, email: byRole.email };
  }

  static async createProposal({
    title,
    description,
    category,
    payload,
    requiredRoles,
    requiredApprovals,
    createdBy,
    autoExecute = false,
  } = {}) {
    await this.ensureTables();
    if (!title) throw new Error('title is required');
    if (!category) throw new Error('category is required');
    if (isVendorBill(category)) this._validateVendorBillPayload(payload);
    const roles = isVendorBill(category)
      ? defaultRequiredRoles()
      : (Array.isArray(requiredRoles) && requiredRoles.length ? requiredRoles : defaultRequiredRoles());
    const threshold = this._requiredApprovals(category, requiredApprovals);
    const proposalId = id();
    await query(
      `INSERT INTO canonical_proposals (id, title, description, category, payload, required_roles, required_approvals, approvals, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [proposalId, title, description || '', category, safeJson(payload || {}), safeJson(roles), threshold, safeJson([]), createdBy || '']
    );
    const proposal = await this.getProposal(proposalId);
    if (isVendorBill(category)) {
      try {
        await this.notifyApprovers(proposal);
      } catch (err) {
        console.warn('[consensus] approver notification failed:', err.message);
      }
    }
    if (autoExecute && this.isApproved(proposal)) {
      return this.executeProposal(proposalId);
    }
    return proposal;
  }

  static async notifyApprovers(proposalOrId) {
    const proposal = typeof proposalOrId === 'string' ? await this.getProposal(proposalOrId) : proposalOrId;
    const summary = vendorBillSummary(proposal.payload);
    const portal = approvalPortalUrl();
    const notifications = [];
    for (const role of REQUIRED_ROLES) {
      const trustee = getTrusteeByRole(role);
      if (!trustee || !trustee.email) continue;
      if (String(proposal.created_by || '').toLowerCase() === String(trustee.email).toLowerCase()) {
        notifications.push({ role, email: trustee.email, sent: false, note: 'requester cannot approve this proposal' });
        continue;
      }
      const signatureOfRecord = getTrusteeSignatureOfRecord(role);
      const body = [
        `${trustee.name},`,
        '',
        `A vendor bill batch is awaiting your ${role} signature.`,
        '',
        `Proposal: ${proposal.id}`,
        `Title: ${proposal.title}`,
        proposal.description ? `Description: ${proposal.description}` : '',
        `Payables: ${summary.count}`,
        ...summary.lines,
        `Batch total: $${summary.total.toFixed(2)}`,
        '',
        'Both the maker and the checker must sign before the Melio CSV batch is exported.',
        `Sign with your full legal name of record: ${signatureOfRecord ? signatureOfRecord.legalName : trustee.name}`,
        portal ? `Approve here: ${portal}` : 'Approve from the FinOps consensus panel in the trust dashboard.',
        '',
        'No funds move when you sign. Signing only authorizes the manual Melio CSV export.',
      ].filter(Boolean).join('\n');
      if (!EmailEngine) {
        notifications.push({ role, email: trustee.email, sent: false, note: 'EmailEngine not available' });
        continue;
      }
      try {
        const result = await EmailEngine.send({
          to: trustee.email,
          subject: `Signature required: vendor bill ${proposal.id}`,
          body,
        });
        notifications.push({ role, email: trustee.email, sent: Boolean(result && result.sent), provider: result && result.provider });
      } catch (err) {
        notifications.push({ role, email: trustee.email, sent: false, note: err.message });
      }
    }
    return { proposalId: proposal.id, notifications };
  }

  static async getProposal(proposalId) {
    await this.ensureTables();
    const res = await query('SELECT * FROM canonical_proposals WHERE id = $1', [proposalId]);
    if (!res.rows.length) throw new Error('Proposal not found');
    return this._format(res.rows[0]);
  }

  static async listProposals({ status, limit = 50, offset = 0 } = {}) {
    await this.ensureTables();
    let sql = 'SELECT * FROM canonical_proposals';
    const params = [];
    if (status) { sql += ' WHERE status = $1'; params.push(status); }
    sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(Number(limit), Number(offset));
    const res = await query(sql, params);
    return res.rows.map(r => this._format(r));
  }

  static _format(row) {
    return {
      ...row,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload || '{}') : (row.payload || {}),
      approvals: Array.isArray(row.approvals) ? row.approvals : JSON.parse(row.approvals || '[]'),
      required_roles: Array.isArray(row.required_roles) ? row.required_roles : JSON.parse(row.required_roles || '[]'),
      result: typeof row.result === 'string' ? JSON.parse(row.result || '{}') : (row.result || {}),
    };
  }

  static isApproved(proposal) {
    const approvals = Array.isArray(proposal.approvals) ? proposal.approvals : [];
    const unique = new Set();
    for (const a of approvals) {
      if (a.status === 'approved' && a.role) unique.add(a.role.toLowerCase());
    }
    const threshold = this._requiredApprovals(proposal, proposal.required_approvals);
    if (isVendorBill(proposal)) {
      return unique.has('maker') && unique.has('checker') && unique.size >= threshold;
    }
    return unique.size >= threshold;
  }

  static async _saveApprovals(proposalId, approvals, status) {
    await query(
      `UPDATE canonical_proposals SET approvals = $1, status = $2, updated_at = NOW() WHERE id = $3`,
      [safeJson(approvals), status, proposalId]
    );
  }

  static async approveProposal({ proposalId, role, approverEmail, signature, signerName } = {}) {
    await this.ensureTables();
    const proposal = await this.getProposal(proposalId);
    if (proposal.status === 'executed' || proposal.status === 'failed') throw new Error(`Proposal already ${proposal.status}`);
    if (proposal.status === 'rejected') throw new Error('Proposal was rejected');

    const approver = this.validateApprover(role, approverEmail);
    let signatureOfRecord;
    if (isVendorBill(proposal)) {
      if (!['maker', 'checker'].includes(approver.role)) {
        throw new Error('vendor_bill approvals require maker and checker roles');
      }
      if (String(proposal.created_by || '').toLowerCase() === String(approver.email).toLowerCase()) {
        throw new Error('The requester cannot approve a vendor_bill proposal');
      }
      if (typeof signature !== 'string' || !signature.trim()) {
        throw new Error('A vendor_bill approval requires your full legal name signature');
      }
      if (isPlaceholderSignature(signature)) {
        throw new Error('Generated or placeholder signatures are not accepted for vendor_bill approvals');
      }
      signatureOfRecord = getTrusteeSignatureOfRecord(approver.role);
      if (
        !signatureOfRecord
        || normalizeSignature(signature) !== normalizeSignature(signatureOfRecord.legalName)
      ) {
        throw new Error(`Signature does not match the signature of record for ${approver.role}`);
      }
    }
    const approvals = proposal.approvals || [];
    const normalizedRole = approver.role;
    if (approvals.find(a => a.role === normalizedRole && a.status === 'approved')) {
      throw new Error(`Role ${normalizedRole} has already approved this proposal`);
    }

    const approvedAt = new Date().toISOString();
    const approval = {
      role: normalizedRole,
      status: 'approved',
      email: approver.email,
      name: signerName || approver.name,
      signature: signature || `sig-${normalizedRole}-${Date.now()}`,
      approvedAt,
    };
    if (signatureOfRecord) {
      const auditDocument = { ...(signatureOfRecord.document || {}) };
      delete auditDocument.path;
      approval.signatureOfRecord = {
        legalName: signatureOfRecord.legalName,
        document: auditDocument,
        signedAt: approvedAt,
      };
    }
    approvals.push(approval);

    const approved = this.isApproved({ ...proposal, approvals });
    const newStatus = approved ? 'approved' : proposal.status;

    await this._saveApprovals(proposalId, approvals, newStatus);

    const updated = await this.getProposal(proposalId);
    if (updated.status === 'approved') {
      return this.executeProposal(proposalId);
    }
    return updated;
  }

  static async rejectProposal({ proposalId, role, rejectorEmail, reason } = {}) {
    await this.ensureTables();
    const proposal = await this.getProposal(proposalId);
    if (['executed', 'failed', 'rejected'].includes(proposal.status)) throw new Error(`Proposal already ${proposal.status}`);

    const approver = this.validateApprover(role, rejectorEmail);
    const approvals = proposal.approvals || [];
    const idx = approvals.findIndex(a => a.role === approver.role);
    const rejection = { role: approver.role, status: 'rejected', email: approver.email, name: approver.name, reason: reason || '', rejectedAt: new Date().toISOString() };
    if (idx >= 0) approvals[idx] = rejection;
    else approvals.push(rejection);

    await query(
      `UPDATE canonical_proposals SET approvals = $1, status = 'rejected', updated_at = NOW() WHERE id = $2`,
      [safeJson(approvals), proposalId]
    );
    return this.getProposal(proposalId);
  }

  static async executeProposal(proposalId) {
    await this.ensureTables();
    const proposal = await this.getProposal(proposalId);
    if (proposal.status !== 'approved' && proposal.status !== 'pending') throw new Error(`Proposal status ${proposal.status} cannot be executed`);
    if (isVendorBill(proposal) && !this.isApproved(proposal)) {
      throw new Error('vendor_bill requires maker and checker approvals before execution');
    }

    try {
      const result = await this._execute(proposal);
      await query(
        `UPDATE canonical_proposals SET status = 'executed', result = $1, updated_at = NOW() WHERE id = $2`,
        [safeJson(result), proposalId]
      );
      return { ...await this.getProposal(proposalId), executed: true };
    } catch (err) {
      await query(
        `UPDATE canonical_proposals SET status = 'failed', result = $1, updated_at = NOW() WHERE id = $2`,
        [safeJson({ error: err.message }), proposalId]
      );
      throw err;
    }
  }

  static async _execute(proposal) {
    const { category, payload } = proposal;
    switch (category) {
      case 'ptc_mint':
        if (!PtcStablecoinEngine) throw new Error('PtcStablecoinEngine not available');
        return PtcStablecoinEngine.approveAndDeposit(payload || {});
      case 'ptc_redeem':
        if (!PtcStablecoinEngine) throw new Error('PtcStablecoinEngine not available');
        return PtcStablecoinEngine.redeem(payload || {});
      case 'ptc_transfer':
        if (!PtcStablecoinEngine) throw new Error('PtcStablecoinEngine not available');
        return PtcStablecoinEngine.transfer(payload || {});
      case 'ptc_whitelist':
        if (!PtcStablecoinEngine) throw new Error('PtcStablecoinEngine not available');
        return PtcStablecoinEngine.whitelist(payload.address, payload.allowed !== false);
      case 'dex_swap':
        if (!StablecoinDexEngine) throw new Error('StablecoinDexEngine not available');
        return StablecoinDexEngine.swap(payload || {});
      case 'p2p_order':
        if (!ModuleP2PSwapEngine) throw new Error('ModuleP2PSwapEngine not available');
        return ModuleP2PSwapEngine.createOrder(payload || {});
      case 'p2p_fill':
        if (!ModuleP2PSwapEngine) throw new Error('ModuleP2PSwapEngine not available');
        return ModuleP2PSwapEngine.fillOrder(payload || {});
      case 'liquidity': {
        const { CanonicalLiquidityEngine } = require('./canonicalLiquidityEngine');
        if (!CanonicalLiquidityEngine) throw new Error('CanonicalLiquidityEngine not available');
        return CanonicalLiquidityEngine._execute(proposal);
      }
      case 'canonical_money': {
        const { CanonicalMoneyEngine } = require('./canonicalMoneyEngine');
        if (!CanonicalMoneyEngine) throw new Error('CanonicalMoneyEngine not available');
        return CanonicalMoneyEngine._execute(proposal);
      }
      case 'cross_chain': {
        const { CrossChainConversionEngine } = require('./crossChainConversionEngine');
        if (!CrossChainConversionEngine) throw new Error('CrossChainConversionEngine not available');
        return CrossChainConversionEngine._execute(proposal);
      }
      case 'paired_asset': {
        const { PairedAssetEngine } = require('./pairedAssetEngine');
        if (!PairedAssetEngine) throw new Error('PairedAssetEngine not available');
        return PairedAssetEngine._execute(proposal);
      }
      case 'ramp':
        if (!OnOffRampEngine) throw new Error('OnOffRampEngine not available');
        return OnOffRampEngine._execute(proposal);
      case 'decentralized_ramp': {
        const { DecentralizedRampEngine } = require('./decentralizedRampEngine');
        if (!DecentralizedRampEngine) throw new Error('DecentralizedRampEngine not available');
        return DecentralizedRampEngine._execute(proposal);
      }
      case 'trust_market':
        if (!TrustMarketEngine) throw new Error('TrustMarketEngine not available');
        return TrustMarketEngine._execute(proposal);
      case 'intent':
        if (!IntentRoutingEngine) throw new Error('IntentRoutingEngine not available');
        return IntentRoutingEngine._execute(proposal);
      case 'external_wallet_swap':
        if (!ExternalWalletEngine) throw new Error('ExternalWalletEngine not available');
        return ExternalWalletEngine._execute(proposal);
      case 'capital_fund': {
        const { CapitalFundEngine } = require('./capitalFundEngine');
        if (!CapitalFundEngine) throw new Error('CapitalFundEngine not available');
        return CapitalFundEngine.executeFund(proposal.payload && proposal.payload.fundId);
      }
      case 'treasury_on_ramp': {
        const { TreasuryOnRampBridgeEngine } = require('./treasuryOnRampBridgeEngine');
        if (!TreasuryOnRampBridgeEngine) throw new Error('TreasuryOnRampBridgeEngine not available');
        return TreasuryOnRampBridgeEngine._execute(proposal);
      }
      case 'programmable_money': {
        const { ProgrammableMoneyEngine } = require('./programmableMoneyEngine');
        if (!ProgrammableMoneyEngine) throw new Error('ProgrammableMoneyEngine not available');
        return ProgrammableMoneyEngine.activateFromProposal(payload && payload.programId);
      }
      case 'vendor_bill':
        return this._executeVendorBill(payload || {}, proposal.id);
      case 'custom':
        return { status: 'approved', message: 'Custom proposal approved, no automatic execution configured', payload };
      default:
        throw new Error(`Unknown proposal category: ${category}`);
    }
  }
}

module.exports = { CanonicalConsensusEngine };
