'use strict';

/**
 * Partner Bank Rails — DLB Trust Platform
 *
 * The canonical engines are the trust's books of record, but Fedwire, ACH and
 * RTP origination happen at a depository institution. This adapter turns a
 * canonical payment instruction into the request shape of whichever partner
 * bank API the trust holds its account with, so the rail can be switched by
 * configuration instead of code.
 *
 * Providers:
 * - `column`   — https://api.column.com (form encoded, basic auth, key as password)
 * - `increase` — https://api.increase.com (JSON, bearer auth)
 * - `generic`  — the platform's own JSON envelope, for a bank that implements it
 *
 * Configuration (env):
 *   PARTNER_BANK_PROVIDER        column | increase | generic
 *   PARTNER_BANK_API_KEY         API key / bearer token
 *   PARTNER_BANK_BASE_URL        overrides the provider default
 *   PARTNER_BANK_ACCOUNT_ID      the trust's account/bank-account id at the provider
 *   PARTNER_BANK_ACCOUNT_LABEL   human label shown in dashboards
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const RAILS = ['wire', 'ach', 'rtp'];

function digits(value) {
  return String(value === null || value === undefined ? '' : value).replace(/\D/g, '');
}

function text(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

function formEncode(pairs) {
  return pairs
    .filter(([, value]) => text(value) !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

function firstValue(body, names) {
  for (const name of names) {
    if (body && body[name] !== undefined && body[name] !== null && body[name] !== '') {
      return String(body[name]);
    }
  }
  return null;
}

/**
 * An instruction is rail-agnostic and provider-agnostic:
 * { reference, amountCents, currency, beneficiaryName, beneficiaryRouting,
 *   beneficiaryAccount, beneficiaryAccountType, description, counterpartyId,
 *   externalAccountId, secCode }
 */
const PROVIDERS = {
  column: {
    label: 'Column',
    defaultBaseUrl: 'https://api.column.com',
    authType: 'basic_key_as_password',
    supports: ['wire', 'ach'],
    buildRequest(rail, instruction, cfg) {
      const common = [
        ['amount', instruction.amountCents],
        ['currency_code', instruction.currency || 'USD'],
        ['bank_account_id', cfg.accountId],
        ['description', instruction.description],
      ];
      if (!instruction.counterpartyId) {
        throw new Error(
          'Column requires a counterparty_id — register the beneficiary as a Column'
          + ' counterparty and pass counterpartyId on the instruction'
        );
      }
      if (rail === 'wire') {
        return {
          method: 'POST',
          path: '/transfers/wire',
          contentType: 'application/x-www-form-urlencoded',
          body: formEncode([...common, ['counterparty_id', instruction.counterpartyId]]),
        };
      }
      return {
        method: 'POST',
        path: '/transfers/ach',
        contentType: 'application/x-www-form-urlencoded',
        body: formEncode([
          ...common,
          ['counterparty_id', instruction.counterpartyId],
          ['type', 'CREDIT'],
          ['entry_class_code', instruction.secCode || 'CCD'],
        ]),
      };
    },
    parseResponse(rail, body) {
      return {
        providerReference: firstValue(body, ['id']),
        providerStatus: firstValue(body, ['status']) || 'accepted',
        imad: firstValue(body, ['imad']),
        omad: firstValue(body, ['omad']),
        fedReference: firstValue(body, ['imad', 'trace_number']),
        confirmationNumber: firstValue(body, ['id', 'idempotency_key']),
      };
    },
  },

  increase: {
    label: 'Increase',
    defaultBaseUrl: 'https://api.increase.com',
    authType: 'bearer',
    supports: ['wire', 'ach', 'rtp'],
    buildRequest(rail, instruction, cfg) {
      const destination = instruction.externalAccountId
        ? { external_account_id: instruction.externalAccountId }
        : {
          routing_number: digits(instruction.beneficiaryRouting),
          account_number: digits(instruction.beneficiaryAccount),
        };
      if (rail === 'wire') {
        return {
          method: 'POST',
          path: '/wire_transfers',
          contentType: 'application/json',
          body: JSON.stringify({
            account_id: cfg.accountId,
            amount: instruction.amountCents,
            beneficiary_name: instruction.beneficiaryName,
            message_to_recipient: text(instruction.description).slice(0, 140),
            ...destination,
          }),
        };
      }
      if (rail === 'ach') {
        return {
          method: 'POST',
          path: '/ach_transfers',
          contentType: 'application/json',
          body: JSON.stringify({
            account_id: cfg.accountId,
            amount: instruction.amountCents,
            statement_descriptor: text(instruction.description).slice(0, 10) || 'TRUST PMT',
            funding: instruction.beneficiaryAccountType === 'savings' ? 'savings' : 'checking',
            individual_name: instruction.beneficiaryName,
            standard_entry_class_code: (instruction.secCode || 'CCD').toLowerCase() === 'ppd'
              ? 'internet_initiated'
              : 'corporate_credit_or_debit',
            ...destination,
          }),
        };
      }
      return {
        method: 'POST',
        path: '/real_time_payments_transfers',
        contentType: 'application/json',
        body: JSON.stringify({
          source_account_id: cfg.accountId,
          amount: instruction.amountCents,
          creditor_name: instruction.beneficiaryName,
          remittance_information: text(instruction.description).slice(0, 140),
          ...(instruction.externalAccountId
            ? { external_account_id: instruction.externalAccountId }
            : {
              destination_routing_number: digits(instruction.beneficiaryRouting),
              destination_account_number: digits(instruction.beneficiaryAccount),
            }),
        }),
      };
    },
    parseResponse(rail, body) {
      const submission = body?.submission || {};
      return {
        providerReference: firstValue(body, ['id']),
        providerStatus: firstValue(body, ['status']) || 'accepted',
        imad: firstValue(submission, ['input_message_accountability_data']),
        omad: firstValue(submission, ['output_message_accountability_data']),
        fedReference: firstValue(submission, [
          'input_message_accountability_data',
          'trace_number',
          'transaction_identification',
        ]),
        confirmationNumber: firstValue(body, ['id', 'transaction_id']),
      };
    },
  },

  generic: {
    label: 'Generic bank API',
    defaultBaseUrl: '',
    authType: 'bearer',
    supports: RAILS,
    buildRequest(rail, instruction, cfg) {
      return {
        method: 'POST',
        path: cfg.railPaths[rail] || `/${rail}`,
        contentType: 'application/json',
        body: JSON.stringify({
          client_reference: instruction.reference,
          type: rail === 'wire' ? 'fedwire' : rail,
          amount_cents: instruction.amountCents,
          currency: instruction.currency || 'USD',
          originator_account_id: cfg.accountId,
          beneficiary_name: instruction.beneficiaryName,
          beneficiary_routing: digits(instruction.beneficiaryRouting),
          beneficiary_account: digits(instruction.beneficiaryAccount),
          description: instruction.description,
          submitted_at: new Date().toISOString(),
        }),
      };
    },
    parseResponse(rail, body) {
      return {
        providerReference: firstValue(body, [
          'provider_reference', 'providerReference', 'reference', 'id', 'transaction_id',
        ]),
        providerStatus: firstValue(body, ['status', 'state', 'transfer_status']) || 'accepted',
        imad: firstValue(body, ['imad', 'input_message_accountability_data']),
        omad: firstValue(body, ['omad', 'output_message_accountability_data']),
        fedReference: firstValue(body, ['fed_reference', 'fedReference']),
        confirmationNumber: firstValue(body, ['confirmation_number', 'confirmationNumber', 'id']),
      };
    },
  },
};

const REJECTED_STATUSES = ['failed', 'rejected', 'returned', 'cancelled', 'canceled', 'declined'];

class PartnerBankRails {

  static config() {
    const providerName = String(process.env.PARTNER_BANK_PROVIDER || '').toLowerCase().trim();
    const provider = PROVIDERS[providerName] || null;
    return {
      providerName: providerName || null,
      provider,
      apiKey: process.env.PARTNER_BANK_API_KEY || '',
      accountId: process.env.PARTNER_BANK_ACCOUNT_ID || '',
      accountLabel: process.env.PARTNER_BANK_ACCOUNT_LABEL || '',
      baseUrl: (process.env.PARTNER_BANK_BASE_URL || provider?.defaultBaseUrl || '').replace(/\/+$/, ''),
      railPaths: {
        wire: process.env.PARTNER_BANK_WIRE_PATH || '',
        ach: process.env.PARTNER_BANK_ACH_PATH || '',
        rtp: process.env.PARTNER_BANK_RTP_PATH || '',
      },
    };
  }

  /** Readiness of each rail, safe to expose in dashboards (never the key). */
  static status() {
    const cfg = this.config();
    const missing = [];
    if (!cfg.provider) missing.push('PARTNER_BANK_PROVIDER');
    if (!cfg.apiKey) missing.push('PARTNER_BANK_API_KEY');
    if (!cfg.accountId) missing.push('PARTNER_BANK_ACCOUNT_ID');
    if (!cfg.baseUrl) missing.push('PARTNER_BANK_BASE_URL');
    const ready = missing.length === 0;
    return {
      configured: Boolean(cfg.provider),
      ready,
      provider: cfg.providerName,
      providerLabel: cfg.provider?.label || null,
      baseUrl: cfg.baseUrl || null,
      accountLabel: cfg.accountLabel || null,
      accountConfigured: Boolean(cfg.accountId),
      rails: RAILS.reduce((acc, rail) => {
        acc[rail] = ready && (cfg.provider?.supports || []).includes(rail);
        return acc;
      }, {}),
      missingConfiguration: missing,
      note: ready
        ? 'Origination executes against the configured partner bank.'
        : 'No partner bank configured — origination is refused rather than sent to a dead host.',
    };
  }

  static isConfigured() {
    return this.status().configured;
  }

  static _assertReady(rail) {
    if (!RAILS.includes(rail)) throw new Error(`Unsupported rail: ${rail}`);
    const cfg = this.config();
    const status = this.status();
    if (!status.ready) {
      throw new Error(
        `Partner bank rail is not configured (missing ${status.missingConfiguration.join(', ')}).`
        + ' Origination requires a funded account at a partner bank; the canonical ledger'
        + ' cannot originate ACH or Fedwire on its own.'
      );
    }
    if (!cfg.provider.supports.includes(rail)) {
      throw new Error(`${cfg.provider.label} does not support the ${rail} rail`);
    }
    return cfg;
  }

  /** Build the exact provider request without sending it — used for dry runs. */
  static prepare(rail, instruction) {
    const cfg = this._assertReady(rail);
    const request = cfg.provider.buildRequest(rail, this._normalize(instruction), cfg);
    return {
      provider: cfg.providerName,
      url: `${cfg.baseUrl}${request.path}`,
      method: request.method,
      contentType: request.contentType,
      body: request.body,
    };
  }

  static _normalize(instruction = {}) {
    const amountCents = Number(instruction.amountCents);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new Error('Origination requires a positive integer amountCents');
    }
    if (!text(instruction.beneficiaryName)) {
      throw new Error('Origination requires a beneficiary name');
    }
    if (!instruction.externalAccountId && !instruction.counterpartyId
      && (!digits(instruction.beneficiaryRouting) || !digits(instruction.beneficiaryAccount))) {
      throw new Error(
        'Origination requires either a provider counterparty/external account id or the'
        + " beneficiary's routing and account numbers"
      );
    }
    return { ...instruction, amountCents };
  }

  /**
   * Originate on a rail. Resolves with normalized acceptance evidence, or
   * throws — a throw always means nothing was accepted by the bank.
   */
  static async originate(rail, instruction) {
    const cfg = this._assertReady(rail);
    const normalized = this._normalize(instruction);
    const request = cfg.provider.buildRequest(rail, normalized, cfg);
    const url = new URL(`${cfg.baseUrl}${request.path}`);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Partner bank base URL must use HTTP or HTTPS');
    }
    const headers = {
      'Content-Type': request.contentType,
      'Content-Length': Buffer.byteLength(request.body),
      'User-Agent': 'DLBTrust-Rails/1.0',
      Accept: 'application/json',
    };
    const idempotencyKey = text(normalized.reference);
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
      headers['X-Request-ID'] = idempotencyKey;
    }
    if (cfg.provider.authType === 'basic_key_as_password') {
      headers.Authorization = `Basic ${Buffer.from(`:${cfg.apiKey}`).toString('base64')}`;
    } else {
      headers.Authorization = `Bearer ${cfg.apiKey}`;
    }

    const lib = url.protocol === 'https:' ? https : http;
    const raw = await new Promise((resolve, reject) => {
      const req = lib.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
        timeout: 60000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else reject(new Error(`${cfg.provider.label} returned ${res.statusCode}: ${data.slice(0, 300)}`));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`${cfg.provider.label} request timed out`));
      });
      req.write(request.body);
      req.end();
    });

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new Error(`${cfg.provider.label} returned a non-JSON response`);
    }
    const acceptance = cfg.provider.parseResponse(rail, body);
    if (REJECTED_STATUSES.includes(String(acceptance.providerStatus).toLowerCase())) {
      throw new Error(
        `${cfg.provider.label} rejected the ${rail} origination with status `
        + `${acceptance.providerStatus}`
      );
    }
    if (!acceptance.providerReference) {
      throw new Error(`${cfg.provider.label} response did not include an external reference`);
    }
    return { ...acceptance, provider: cfg.providerName, rail };
  }
}

module.exports = { PartnerBankRails, PARTNER_BANK_PROVIDERS: PROVIDERS, PARTNER_BANK_RAILS: RAILS };
