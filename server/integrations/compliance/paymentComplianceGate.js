'use strict';

const { ComplianceEngine } = require('./complianceEngine');
const { CustomerIdentificationEngine } = require('./customerIdentificationEngine');

function configuredCipRails() {
  return new Set(
    String(process.env.COMPLIANCE_CIP_REQUIRED_RAILS || 'ach,wire,bank_transfer,open_banking,web_payment,nickel')
      .split(',')
      .map((rail) => rail.trim().toLowerCase())
      .filter(Boolean)
  );
}

function complianceError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  error.code = 'COMPLIANCE_GATE_BLOCKED';
  return error;
}

class PaymentComplianceGate {
  static isCipRequired(rail, explicit) {
    if (explicit !== undefined) return explicit === true;
    return configuredCipRails().has(String(rail || '').toLowerCase());
  }

  static async paymentReadiness({ rail, action = 'execute' } = {}) {
    const compliance = await ComplianceEngine.readiness();
    const issues = [...(compliance.issues || [])];
    let paymentProvider = {
      rail: rail || 'unknown',
      action,
      ready: true,
      mode: 'configured',
      liveExecution: action === 'execute',
      issues: [],
    };

    if (String(rail || '').toLowerCase() === 'melio') {
      let MelioEngine;
      try { ({ MelioEngine } = require('../os/osEngine')); } catch (e) { MelioEngine = null; }
      if (!MelioEngine) {
        paymentProvider = {
          rail: 'melio',
          action,
          ready: false,
          mode: 'unavailable',
          liveExecution: false,
          issues: ['MelioEngine not available'],
        };
      } else {
        const status = await MelioEngine.status();
        const exportOnly = action === 'export';
        const providerIssues = [...(status.issues || [])];
        if (!status.enabled) providerIssues.push('Melio is disabled');
        // MelioEngine reports 'live_api' when the verified API is in use;
        // 'shadow' and 'manual_upload' are not live execution modes.
        const liveMode = status.mode === 'live' || status.mode === 'live_api';
        if (!exportOnly && !liveMode) {
          providerIssues.push('Melio live execution is not enabled');
        }
        if (!exportOnly && !(status.apiStatus && status.apiStatus.reachable)) {
          providerIssues.push('Melio API is not reachable');
        }
        paymentProvider = {
          rail: 'melio',
          action,
          ready: providerIssues.length === 0,
          mode: exportOnly ? 'manual_export' : status.mode,
          liveExecution: !exportOnly && liveMode,
          apiReachable: !!(status.apiStatus && status.apiStatus.reachable),
          issues: providerIssues,
        };
      }
    } else if (action === 'execute') {
      const mode = String(process.env.VENDOR_PAYMENT_EXECUTION_MODE || 'disabled').toLowerCase();
      const allowedTestMode = process.env.NODE_ENV !== 'production'
        && mode === 'test'
        && process.env.COMPLIANCE_ALLOW_TEST_PAYMENT_EXECUTION === 'true';
      const providerIssues = [];
      if (mode !== 'live' && !allowedTestMode) {
        providerIssues.push('VENDOR_PAYMENT_EXECUTION_MODE is not live');
      }
      if (!allowedTestMode && String(rail || '').toLowerCase() === 'bill') {
        const missingBill = ['BILL_DEV_KEY', 'BILL_USERNAME', 'BILL_PASSWORD', 'BILL_ORG_ID']
          .filter((key) => !process.env[key]);
        if (missingBill.length) providerIssues.push(`Missing BILL configuration: ${missingBill.join(', ')}`);
      }
      if (!allowedTestMode && String(rail || '').toLowerCase() === 'nickel') {
        if (process.env.NICKEL_LIVE !== 'true' || process.env.NICKEL_SHADOW !== 'false') {
          providerIssues.push('Nickel live mode is not enabled');
        }
        if (!process.env.NICKEL_API_KEY && !(process.env.NICKEL_CLIENT_ID && process.env.NICKEL_CLIENT_SECRET)) {
          providerIssues.push('Nickel credentials are not configured');
        }
      }
      paymentProvider = {
        rail: rail || 'unknown',
        action,
        ready: providerIssues.length === 0,
        mode,
        liveExecution: mode === 'live',
        issues: providerIssues,
      };
    }

    issues.push(...paymentProvider.issues);
    return {
      ready: compliance.ready && paymentProvider.ready,
      compliance,
      paymentProvider,
      issues,
    };
  }

  static async assertReady(options = {}) {
    const readiness = await this.paymentReadiness(options);
    if (!readiness.ready) {
      throw complianceError(
        `Payment compliance is not ready: ${readiness.issues.join('; ') || 'unknown readiness failure'}`,
        503
      );
    }
    return readiness;
  }

  static _recipient(vendor = {}) {
    const nestedBank = vendor.bankAccount || vendor.bank_account || {};
    return {
      fullName: vendor.fullName || vendor.full_name || vendor.contactName || vendor.contact_name,
      businessName: vendor.businessName || vendor.business_name || vendor.name || vendor.vendor_name,
      email: vendor.email || vendor.contact_email,
      phone: vendor.phone || vendor.contact_phone,
      address: vendor.address,
      bankAccount: vendor.accountNumber || vendor.account_number || nestedBank.accountNumber || nestedBank.account_number,
      routingNumber: vendor.routingNumber || vendor.routing_number || nestedBank.routingNumber || nestedBank.routing_number,
      country: vendor.country || (vendor.address && vendor.address.country) || 'US',
    };
  }

  static async screenVendorPayment({
    vendor,
    amount,
    sourceAccountId,
    rail,
    action = 'execute',
    requireCip,
    screenedBy = 'system',
    reference,
  } = {}) {
    const recipient = this._recipient(vendor);
    if (!recipient.fullName && !recipient.businessName) {
      throw complianceError('Vendor identity is required before payment');
    }
    await this.assertReady({ rail, action });

    const screening = await ComplianceEngine.screenRecipientForPayout(
      recipient,
      amount,
      sourceAccountId,
      {
        screenedBy,
        notes: reference ? `Payment reference: ${reference}` : undefined,
      }
    );
    ComplianceEngine.mustPass(screening);

    let cip = { valid: true, required: false };
    if (this.isCipRequired(rail, requireCip)) {
      cip = await CustomerIdentificationEngine.validatePayoutRecipient({
        fullName: recipient.fullName || recipient.businessName,
        email: recipient.email,
        requireClear: true,
      });
      if (!cip.valid) {
        throw complianceError(`CIP clearance required before payment: ${cip.reason || cip.status || 'not clear'}`);
      }
    }

    return {
      screeningId: screening.screening_id || screening.id,
      status: screening.status,
      provider: screening.provider,
      riskLevel: screening.risk_level || screening.level,
      riskScore: screening.risk_score ?? screening.score,
      cip,
      screenedAt: screening.created_at || new Date().toISOString(),
    };
  }

  static async verifyRecordedScreening(screeningId) {
    if (!screeningId) throw complianceError('Compliance screening is required before payment');
    const readiness = await ComplianceEngine.assertPaymentReady();
    const screening = await ComplianceEngine.getScreening(screeningId);
    ComplianceEngine.mustPass(screening);
    if (String(screening.provider || '').toLowerCase() !== String(readiness.provider || '').toLowerCase()) {
      throw complianceError('Compliance screening provider does not match the active payment provider');
    }
    return screening;
  }
}

module.exports = { PaymentComplianceGate, complianceError };
