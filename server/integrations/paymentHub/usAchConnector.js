'use strict';

const fs = require('fs');
const pool = require('../bonds/pgPool');
const { ACHEngine } = require('../ach/achEngine');
const { AS2Partners } = require('../ach/as2Partners');
const { SystemSettings } = require('../ach/systemSettings');
const { validateRouting } = require('../ach/nachaGenerator');

function originatorConfig() {
  return {
    immediateDestination: process.env.ACH_ODFI_ROUTING || '',
    immediateDestinationName: process.env.ACH_ODFI_NAME || '',
    immediateOrigin: process.env.ACH_IMMEDIATE_ORIGIN || '',
    immediateOriginName: process.env.ACH_ORIGINATOR_NAME || '',
    companyName: process.env.ACH_COMPANY_NAME || '',
    companyId: process.env.ACH_COMPANY_ID || '',
  };
}

class USAchConnector {
  static async readiness() {
    const production = process.env.NODE_ENV === 'production';
    const issues = [];
    const warnings = [];
    const originator = originatorConfig();

    if (!validateRouting(originator.immediateDestination)) issues.push('ACH_ODFI_ROUTING must be a valid 9-digit routing number');
    if (!originator.immediateDestinationName) issues.push('ACH_ODFI_NAME is required');
    if (!/^\d{10}$/.test(originator.immediateOrigin)) issues.push('ACH_IMMEDIATE_ORIGIN must be 10 digits');
    if (!originator.immediateOriginName) issues.push('ACH_ORIGINATOR_NAME is required');
    if (!originator.companyName) issues.push('ACH_COMPANY_NAME is required');
    if (!/^[A-Za-z0-9]{10}$/.test(originator.companyId)) issues.push('ACH_COMPANY_ID must be 10 alphanumeric characters');

    const mode = await SystemSettings.getMode();
    const configuredPartnerId = process.env.ACH_PARTNER_ID || '';
    const registeredPartner = configuredPartnerId
      ? await AS2Partners.getPartnerConfig(configuredPartnerId)
      : null;
    const partner = registeredPartner || (mode === 'production' ? await SystemSettings.getProductionPartnerConfig() : null);
    if (production && mode !== 'production') issues.push('System Settings must be in production mode for live ACH transmission');
    if (production && configuredPartnerId && !registeredPartner) issues.push('ACH_PARTNER_ID does not identify an active partner');
    if (production && !partner) issues.push('A verified external ODFI endpoint is required');
    if (partner && partner.protocol === 'bill_api') {
      issues.push('BILL deposit recording is not a supported outbound ACH connector');
    }
    if (partner && partner.protocol === 'rest_api') {
      const endpoint = partner.apiBaseUrl || partner.partnerUrl || '';
      const authType = partner.apiAuthType || '';
      if (!/^https:\/\//i.test(endpoint)) issues.push('The bank REST API endpoint must use HTTPS');
      if (!['bearer', 'basic', 'api_key', 'hmac'].includes(authType)) issues.push('A supported bank REST API authentication method is required');
      if (!partner.apiKey) issues.push('Bank REST API credentials are required');
      if (['basic', 'hmac'].includes(authType) && !partner.apiSecret) issues.push('The bank REST API secret is required');
      if (!partner.webhookSecret) issues.push('A bank webhook verification secret is required');
    }
    if (partner && partner.protocol === 'as2') {
      if (!partner.partnerUrl) issues.push('The AS2 partner endpoint is required');
      if (!partner.partnerAs2Id || !partner.localAs2Id) issues.push('Both AS2 identifiers are required');
      if (![partner.signingCertPath, partner.signingKeyPath, partner.partnerCertPath].every(file => file && fs.existsSync(file))) {
        issues.push('AS2 signing and partner certificates are required');
      }
      if (process.env.AS2_PRODUCTION_APPROVED !== 'true') {
        issues.push('AS2 transmission is blocked until bank certification is recorded with AS2_PRODUCTION_APPROVED=true');
      }
    }
    // Mutual-TLS validation — when the partner presents a client certificate,
    // the cert/key (and CA, if provided) must exist on disk. Additive to header auth.
    if (partner && (partner.useMtls === true || (partner.apiAuthType || '') === 'mtls')) {
      if (!partner.clientCertPath || !fs.existsSync(partner.clientCertPath)) {
        issues.push('mTLS client certificate not found — configure the client cert file');
      }
      if (!partner.clientKeyPath || !fs.existsSync(partner.clientKeyPath)) {
        issues.push('mTLS client private key not found — configure the client key file');
      }
      if (partner.clientCaPath && !fs.existsSync(partner.clientCaPath)) {
        issues.push('mTLS CA bundle path is set but the file was not found');
      }
    }
    if (!production && mode !== 'production') warnings.push('Sandbox ACH transmissions do not reach an ODFI');

    return {
      ready: issues.length === 0,
      issues,
      warnings,
      systemMode: mode,
      partner: partner ? {
        partnerId: partner.partnerId,
        partnerName: partner.partnerName,
        protocol: partner.protocol,
        endpointConfigured: Boolean(partner.apiBaseUrl || partner.partnerUrl),
      } : null,
      originator: {
        odfiRoutingConfigured: validateRouting(originator.immediateDestination),
        odfiNameConfigured: Boolean(originator.immediateDestinationName),
        immediateOriginConfigured: /^\d{10}$/.test(originator.immediateOrigin),
        companyNameConfigured: Boolean(originator.companyName),
        companyIdConfigured: /^[A-Za-z0-9]{10}$/.test(originator.companyId),
      },
    };
  }

  static async transmit(intent) {
    const production = process.env.NODE_ENV === 'production';
    const status = await USAchConnector.readiness();
    if (production && !status.ready) {
      throw new Error('U.S. ACH connector is not production-ready: ' + status.issues.join('; '));
    }

    const existing = await pool.query(
      `SELECT batch_id, status, filename FROM ach_batches
       WHERE payment_intent_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [intent.intent_id]
    );
    if (existing.rows.length) {
      const batch = existing.rows[0];
      if (['transmitted', 'accepted', 'settled'].includes(batch.status)) {
        return {
          achBatchId: batch.batch_id,
          transmissionId: null,
          status: batch.status,
          awaitingConfirmation: batch.status === 'transmitted',
          idempotent: true,
        };
      }
      if (batch.status === 'transmitting' || (production && batch.status === 'failed')) {
        throw new Error('ACH transmission status is ambiguous; reconcile the bank status before retrying');
      }
      const transmission = await ACHEngine.transmitBatch(batch.batch_id);
      return {
        achBatchId: batch.batch_id,
        transmissionId: transmission.message_id || null,
        status: transmission.batch_status || 'transmitted',
        awaitingConfirmation: transmission.awaiting_confirmation === true,
        idempotent: true,
      };
    }

    const amountCents = Number(intent.amount_cents);
    const batch = await ACHEngine.createBatch({
      effectiveDate: intent.effective_date,
      secCode: intent.sec_code,
      description: (intent.description || intent.payment_type || 'PAYMENT').slice(0, 10).toUpperCase(),
      createdBy: intent.maker_id,
      partnerId: process.env.ACH_PARTNER_ID || null,
      nachaConfig: originatorConfig(),
    }, [{
      receivingRouting: intent.beneficiary_routing,
      accountNumber: intent.beneficiary_account,
      amountCents,
      transactionCode: intent.beneficiary_account_type === 'savings' ? '32' : '22',
      individualId: intent.intent_id.slice(-15),
      individualName: intent.beneficiary_name,
      memo: intent.description || intent.payment_type,
    }]);

    await pool.query(
      `UPDATE ach_batches SET orchestration_owner = 'payment_hub', payment_intent_id = $2 WHERE batch_id = $1`,
      [batch.batch_id, intent.intent_id]
    );
    const transmission = await ACHEngine.transmitBatch(batch.batch_id);
    return {
      achBatchId: batch.batch_id,
      transmissionId: transmission.message_id || null,
      status: transmission.batch_status || 'transmitted',
      awaitingConfirmation: transmission.awaiting_confirmation === true,
    };
  }

  static async status(batchId) {
    const batch = await ACHEngine.getBatch(batchId);
    if (!batch) throw new Error(`ACH batch not found: ${batchId}`);
    return {
      batchId,
      status: batch.status,
      transmittedAt: batch.transmitted_at,
      acceptedAt: batch.accepted_at,
      settledAt: batch.settled_at,
      returnedAt: batch.returned_at,
      returnCode: batch.return_code,
      returnReason: batch.return_reason,
    };
  }
}

module.exports = { USAchConnector, originatorConfig };
