'use strict';

/**
 * ERP payout workflow — Treasury-Core (Fineract) funded payouts driven through
 * the Corporate Treasury maker/checker workflow, with an X12 820 emitted over
 * AS2 once the ERP draw is committed and the external leg is on its way.
 *
 * Sequence (runs on CorporateTreasuryEngine.executeWorkflow for
 * reference_type='erp_payout', or via executeWorkflow() here):
 *
 *   1. maker/checker  — workflow must be `approved`; the maker never counts
 *                        among the approvers (CorporateTreasuryEngine enforces
 *                        self-approval rejection, we re-check here so the
 *                        engine cannot be driven around the endpoints)
 *   2. ERP funding    — CanonicalFundingSource.assertAvailable() then
 *                        .commit(); fail-closed, shadow plan unless
 *                        CANONICAL_FUNDING_LIVE=true
 *   3. external leg   — WireOriginationEngine for wire / ACH (NACHA over
 *                        ACHEngine); only when the ERP draw actually committed.
 *                        In shadow mode the leg is planned, never originated.
 *   4. 820            — Edi820RemittanceEngine.emit(), keyed by the ERP
 *                        reference; shadow unless EDI_820_LIVE and
 *                        CANONICAL_FUNDING_LIVE are both true.
 *
 * Nothing here talks to a rail directly — the engines above already do.
 */

const { CanonicalFundingSource } = require('../fineract/canonicalFundingSource');
const { Edi820RemittanceEngine } = require('../edi/edi820RemittanceEngine');

let WireOriginationEngine = null;
try { ({ WireOriginationEngine } = require('../dapp/wireOriginationEngine')); } catch (e) { /* optional */ }

class ErpPayoutError extends Error {
  constructor(message, code = 'ERP_PAYOUT_ERROR', status = 400) {
    super(message);
    this.name = 'ErpPayoutError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

const REFERENCE_TYPE = 'erp_payout';
const METHODS = new Set(['wire', 'ach']);

function workflowId(workflow) { return workflow.workflow_id || workflow.id; }
function makerOf(workflow) {
  const md = workflow.metadata || {};
  const maker = md.createdBy || workflow.created_by;
  return maker ? String(maker) : null;
}

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function toCents(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) throw new ErpPayoutError('amountCents must be a positive integer', 'ERP_PAYOUT_INVALID_AMOUNT');
  return n;
}

class ErpPayoutWorkflowEngine {
  static get REFERENCE_TYPE() { return REFERENCE_TYPE; }

  static getConfig() {
    return {
      cashAccountCode: str('ERP_PAYOUT_CASH_GL_CODE', '1000'),
      clearingAccountCode: str('ERP_PAYOUT_CLEARING_GL_CODE', '1150'),
      sourceAccountId: str('ERP_PAYOUT_SOURCE_ACCOUNT_ID') || str('FINERACT_PAYOUT_SOURCE_ACCOUNT_ID', 'CA-OPERATING'),
      canonicalLive: CanonicalFundingSource.getConfig().live,
      edi820Live: Edi820RemittanceEngine.getConfig().live,
    };
  }

  /** Shape metadata stored on the Corporate Treasury workflow record. */
  static buildPayoutMetadata({ erpReference, method, payee, remittance = [], purpose, memo, effectiveDate } = {}) {
    if (!erpReference || !String(erpReference).trim()) throw new ErpPayoutError('erpReference is required', 'ERP_PAYOUT_NO_REFERENCE');
    const m = String(method || 'ach').toLowerCase();
    if (!METHODS.has(m)) throw new ErpPayoutError(`method must be one of ${[...METHODS].join(', ')}`, 'ERP_PAYOUT_INVALID_METHOD');
    if (!payee || !payee.name) throw new ErpPayoutError('payee.name is required', 'ERP_PAYOUT_NO_PAYEE');
    if (!payee.routingNumber || !payee.accountNumber) throw new ErpPayoutError('payee.routingNumber and payee.accountNumber are required', 'ERP_PAYOUT_NO_PAYEE_BANK');
    return {
      erpReference: String(erpReference).trim(),
      method: m,
      payee: {
        name: String(payee.name).trim(),
        id: payee.id ? String(payee.id) : undefined,
        routingNumber: String(payee.routingNumber).replace(/\D/g, ''),
        accountNumber: String(payee.accountNumber).trim(),
        accountType: payee.accountType || 'checking',
        addressLine1: payee.addressLine1, addressLine2: payee.addressLine2,
        city: payee.city, state: payee.state, postalCode: payee.postalCode, country: payee.country,
      },
      remittance: Array.isArray(remittance) ? remittance : [],
      purpose: purpose || 'erp_payout',
      memo: memo || undefined,
      effectiveDate: effectiveDate || undefined,
    };
  }

  /** Corporate Treasury workflow record → 820 run. */
  static runFromWorkflow(workflow) {
    if (!workflow) throw new ErpPayoutError('workflow not found', 'ERP_PAYOUT_WORKFLOW_NOT_FOUND', 404);
    if (workflow.reference_type !== REFERENCE_TYPE) {
      throw new ErpPayoutError(`workflow ${workflowId(workflow)} is ${workflow.reference_type || 'untyped'}, not an ERP payout`, 'ERP_PAYOUT_WRONG_TYPE', 409);
    }
    const md = workflow.metadata || {};
    const payout = md.payout || md;
    const erpReference = payout.erpReference || workflow.reference_id;
    return {
      erpReference,
      workflowId: workflowId(workflow),
      effectiveDate: payout.effectiveDate || undefined,
      payments: [{
        reference: workflowId(workflow),
        amountCents: Number(workflow.amount_cents),
        currency: workflow.currency || 'USD',
        method: payout.method || 'ach',
        purpose: payout.purpose,
        payee: payout.payee,
        remittance: payout.remittance || [],
      }],
    };
  }

  /**
   * Maker/checker re-check independent of the HTTP layer: status must be
   * `approved`, and at least `required_approvals` approvers other than the
   * maker must have signed.
   */
  static assertDualControl(workflow) {
    if (!workflow) throw new ErpPayoutError('workflow not found', 'ERP_PAYOUT_WORKFLOW_NOT_FOUND', 404);
    if (workflow.status !== 'approved') {
      throw new ErpPayoutError(`workflow ${workflowId(workflow)} is ${workflow.status}, not approved`, 'ERP_PAYOUT_NOT_APPROVED', 409);
    }
    const maker = makerOf(workflow);
    if (!maker) throw new ErpPayoutError(`workflow ${workflowId(workflow)} has no recorded maker; dual control cannot be verified`, 'ERP_PAYOUT_DUAL_CONTROL', 403);
    const approvals = Array.isArray(workflow.approvals) ? workflow.approvals : [];
    const checkers = new Set(approvals.map(a => String(a && a.approver)).filter(a => a && a !== 'undefined' && a !== maker));
    const required = Math.max(1, Number(workflow.required_approvals) || 1);
    if (checkers.size < required) {
      throw new ErpPayoutError(
        `workflow ${workflowId(workflow)} needs ${required} approver(s) other than the maker; has ${checkers.size}`,
        'ERP_PAYOUT_DUAL_CONTROL',
        403
      );
    }
    return { maker, checkers: [...checkers], required };
  }

  /**
   * Execute an approved ERP payout workflow. Called from
   * CorporateTreasuryEngine.executeWorkflow(); may also be invoked directly.
   */
  static async execute(workflow, { executedBy } = {}) {
    const control = this.assertDualControl(workflow);

    const run = this.runFromWorkflow(workflow);
    const payment = run.payments[0];
    const amountCents = toCents(payment.amountCents);
    const amountUsd = amountCents / 100;
    const cfg = this.getConfig();

    // 1. ERP funding — assertAvailable + commit through the canonical source (fail-closed).
    await CanonicalFundingSource.assertAvailable({ amountUsd, accountCode: cfg.cashAccountCode, purpose: payment.purpose || 'erp_payout' });
    const funding = await CanonicalFundingSource.commit({
      amountUsd,
      reference: run.erpReference,
      referenceType: REFERENCE_TYPE,
      memo: `ERP payout ${run.erpReference} → ${payment.payee.name}`,
      cashAccountCode: cfg.cashAccountCode,
      assetAccountCode: cfg.clearingAccountCode,
      postedBy: executedBy || control.checkers[0] || 'system',
      purpose: payment.purpose || 'erp_payout',
    });
    const fundingCommitted = Boolean(funding && funding.committed);

    // 2. External leg — only when the ERP draw is real.
    const externalLeg = await this._originateExternalLeg({ run, payment, workflow, fundingCommitted, control, executedBy });

    // 3. 820 — keyed by ERP reference, gated on both live flags.
    const edi820 = await Edi820RemittanceEngine.emit({ run, fundingCommitted, workflowId: run.workflowId });

    return {
      workflowId: run.workflowId,
      erpReference: run.erpReference,
      amountCents,
      method: payment.method,
      shadow: !fundingCommitted,
      dualControl: control,
      funding,
      externalLeg,
      edi820: {
        documentId: edi820.documentId,
        status: edi820.status,
        transmitted: edi820.transmitted === true,
        shadow: edi820.shadow === true,
        duplicate: edi820.duplicate === true,
        reason: edi820.reason || null,
        payloadHash: edi820.payloadHash,
        interchangeControlNumber: edi820.interchangeControlNumber,
      },
    };
  }

  static async _originateExternalLeg({ run, payment, workflow, fundingCommitted, control, executedBy }) {
    const plan = {
      rail: payment.method,
      engine: 'WireOriginationEngine',
      sourceAccountId: this.getConfig().sourceAccountId,
      amountCents: payment.amountCents,
      payee: { name: payment.payee.name, routingNumber: payment.payee.routingNumber, accountLast4: String(payment.payee.accountNumber).slice(-4) },
    };
    if (!fundingCommitted) {
      return { ...plan, shadow: true, originated: false, reason: 'ERP draw was a shadow plan; external leg not originated' };
    }
    if (!WireOriginationEngine) {
      throw new ErpPayoutError('WireOriginationEngine unavailable; cannot originate external leg', 'ERP_PAYOUT_NO_RAIL', 503);
    }
    const md = workflow.metadata || {};
    const payoutMd = md.payout || md;
    const payout = await WireOriginationEngine.createPayout({
      sourceType: 'cash',
      sourceAccountId: plan.sourceAccountId,
      amountCents: payment.amountCents,
      currency: payment.currency || 'USD',
      counterparty: {
        name: payment.payee.name,
        routingNumber: payment.payee.routingNumber,
        accountNumber: payment.payee.accountNumber,
        accountType: payment.payee.accountType || 'checking',
        addressLine1: payment.payee.addressLine1,
        city: payment.payee.city,
        state: payment.payee.state,
        postalCode: payment.payee.postalCode,
      },
      method: payment.method,
      memo: payoutMd.memo || `ERP payout ${run.erpReference}`,
      reference: run.erpReference,
      createdBy: control.maker || 'system',
      // The Corporate Treasury workflow already carries the independent approval;
      // WireOriginationEngine's own second signature is the checker.
      requiredApprovals: 1,
    });
    const approver = control.checkers[0] || executedBy || 'checker';
    await WireOriginationEngine.approvePayout(payout.id, approver);
    const sent = await WireOriginationEngine.sendPayout(payout.id);
    return { ...plan, shadow: false, originated: true, payoutId: payout.id, status: sent.status, sent };
  }
}

module.exports = { ErpPayoutWorkflowEngine, ErpPayoutError, ERP_PAYOUT_REFERENCE_TYPE: REFERENCE_TYPE };
