'use strict';

/**
 * PDCflow Engine — DLB Trust Private Trust Company
 *
 * PDCflow is the trust's gateway to its own ACH/card processing account. Its
 * Transaction Service originates both directions, which is what makes it usable
 * as the trust's payment processor rather than only a collections front end:
 *
 *   DEBIT  — pull from a payer's bank account or card (funds the trust)
 *   CREDIT — push to a beneficiary or vendor bank account (pays out)
 *
 * Reference: https://apidocs.pdcflow.com/pages/TransactionService/
 * Auth is HTTP Basic (`username:password`, base64). Every transaction must name
 * an `accountDirective` (format `XXX-X`), which is the processing account
 * PDCflow's Customer Success team provisions per service once the underlying
 * ACH/card processor approves the trust company.
 *
 * Configuration (env):
 *   PDCFLOW_BASE_URL           Transaction Service base URL from your account
 *   PDCFLOW_USERNAME           API username
 *   PDCFLOW_PASSWORD           API password
 *   PDCFLOW_ACH_PATH           ACH transaction path (from your API docs)
 *   PDCFLOW_CARD_PATH          Card transaction path (optional)
 *   PDCFLOW_DEBIT_DIRECTIVE    directive for pulling funds in
 *   PDCFLOW_CREDIT_DIRECTIVE   directive for pushing funds out
 *   PDCFLOW_ORIGIN             transactionOrigin code (e.g. API)
 *   PDCFLOW_POSTBACK_URL       HTTPS callback for settlement status
 *   PDCFLOW_POSTBACK_AUTH      Authorization header value PDCflow will send back
 *
 * No endpoint is guessed: when the configuration is incomplete the engine
 * refuses, rather than transmitting to a host that may not answer.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const DIRECTIONS = { debit: 'DEBIT', credit: 'CREDIT' };
const TERMINAL_FAILURES = ['DECLINED', 'FAILED', 'RETURNED', 'VOIDED', 'CANCELLED', 'REJECTED', 'ERROR'];
const SETTLED = ['SETTLED', 'COMPLETE', 'COMPLETED', 'FUNDED', 'PAID', 'APPROVED'];

function text(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

function digits(value) {
  return text(value).replace(/\D/g, '');
}

function splitName(fullName) {
  const parts = text(fullName).split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function scheduleDate(value) {
  if (text(value)) return text(value).slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

class PDCflowEngine {
  static config() {
    return {
      baseUrl: (process.env.PDCFLOW_BASE_URL || '').replace(/\/+$/, ''),
      username: process.env.PDCFLOW_USERNAME || '',
      password: process.env.PDCFLOW_PASSWORD || '',
      achPath: process.env.PDCFLOW_ACH_PATH || '',
      cardPath: process.env.PDCFLOW_CARD_PATH || '',
      debitDirective: process.env.PDCFLOW_DEBIT_DIRECTIVE || '',
      creditDirective: process.env.PDCFLOW_CREDIT_DIRECTIVE || '',
      origin: process.env.PDCFLOW_ORIGIN || 'API',
      postBackUrl: process.env.PDCFLOW_POSTBACK_URL || '',
      postBackAuthHeader: process.env.PDCFLOW_POSTBACK_AUTH || '',
    };
  }

  /** Safe for dashboards: never returns the password or the postback secret. */
  static status() {
    const cfg = this.config();
    const missing = [];
    if (!cfg.baseUrl) missing.push('PDCFLOW_BASE_URL');
    if (!cfg.username) missing.push('PDCFLOW_USERNAME');
    if (!cfg.password) missing.push('PDCFLOW_PASSWORD');
    if (!cfg.achPath) missing.push('PDCFLOW_ACH_PATH');
    const ready = missing.length === 0;
    return {
      configured: Boolean(cfg.baseUrl || cfg.username),
      ready,
      baseUrl: cfg.baseUrl || null,
      credentialsConfigured: Boolean(cfg.username && cfg.password),
      directives: {
        debit: Boolean(cfg.debitDirective),
        credit: Boolean(cfg.creditDirective),
      },
      capabilities: {
        achDebit: ready && Boolean(cfg.debitDirective),
        achCredit: ready && Boolean(cfg.creditDirective),
        card: ready && Boolean(cfg.cardPath),
      },
      postBackConfigured: Boolean(cfg.postBackUrl),
      missingConfiguration: missing,
      note: ready
        ? 'PDCflow transactions execute against the configured processing account.'
        : 'PDCflow is not configured — request the ACH debit/credit directives in'
          + ' Configure → Payment Settings, then set the environment values.',
    };
  }

  static isConfigured() {
    return this.status().ready;
  }

  static _assertReady(direction) {
    const cfg = this.config();
    const status = this.status();
    if (!status.ready) {
      throw new Error(
        `PDCflow is not configured (missing ${status.missingConfiguration.join(', ')}).`
        + ' The gateway cannot originate without an approved processing account.'
      );
    }
    const directive = direction === 'credit' ? cfg.creditDirective : cfg.debitDirective;
    if (!directive) {
      throw new Error(
        `No PDCflow ${direction} account directive configured`
        + ` (set PDCFLOW_${direction.toUpperCase()}_DIRECTIVE to the directive PDCflow assigned).`
      );
    }
    return { cfg, directive };
  }

  /**
   * An instruction is rail-agnostic:
   * { reference, amountCents, counterpartyName, routingNumber, accountNumber,
   *   accountType, bankAccountToken, description, email, dateScheduled }
   */
  static _normalize(instruction = {}) {
    const amountCents = Number(instruction.amountCents);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new Error('PDCflow requires a positive integer amountCents');
    }
    const { firstName, lastName } = splitName(
      instruction.counterpartyName || instruction.beneficiaryName || instruction.accountHolderName
    );
    if (!firstName || !lastName) {
      throw new Error('PDCflow requires the account holder name (firstName and lastName)');
    }
    const token = text(instruction.bankAccountToken);
    if (!token && (!digits(instruction.routingNumber) || !digits(instruction.accountNumber))) {
      throw new Error('PDCflow requires either a bankAccountToken or a routing and account number');
    }
    return { ...instruction, amountCents, firstName, lastName, bankAccountToken: token };
  }

  static _buildAchRequest(direction, instruction) {
    const { cfg, directive } = this._assertReady(direction);
    const normalized = this._normalize(instruction);
    const body = {
      accountDirective: directive,
      transactionType: DIRECTIONS[direction],
      transactionOrigin: cfg.origin,
      paymentAmount: (normalized.amountCents / 100).toFixed(2),
      dateScheduled: scheduleDate(normalized.dateScheduled),
      firstName: normalized.firstName,
      lastName: normalized.lastName,
      sendReceiptToEmailAddress: Boolean(text(normalized.email)),
      memo: text(normalized.description).slice(0, 50) || undefined,
      emailAddress: text(normalized.email) || undefined,
      uniqueRequestId: text(normalized.reference).slice(0, 50) || undefined,
    };
    if (normalized.bankAccountToken) {
      body.bankAccountToken = normalized.bankAccountToken;
      if (normalized.accountType) body.bankAccountType = String(normalized.accountType).toUpperCase();
    } else {
      body.bankRoutingNumber = digits(normalized.routingNumber);
      body.bankAccountNumber = digits(normalized.accountNumber);
      body.bankAccountType = String(normalized.accountType || 'checking').toUpperCase();
    }
    if (cfg.postBackUrl) {
      body.postBackUrl = cfg.postBackUrl;
      if (cfg.postBackAuthHeader) body.postBackAuthHeader = cfg.postBackAuthHeader;
    }
    Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
    return {
      method: 'POST',
      url: `${cfg.baseUrl}${cfg.achPath}`,
      body: JSON.stringify(body),
    };
  }

  /** Build the exact request without sending it — used for dry runs. */
  static prepareAch(direction, instruction) {
    const request = this._buildAchRequest(direction, instruction);
    const redacted = JSON.parse(request.body);
    if (redacted.bankAccountNumber) {
      redacted.bankAccountNumber = `****${redacted.bankAccountNumber.slice(-4)}`;
    }
    if (redacted.postBackAuthHeader) redacted.postBackAuthHeader = '[redacted]';
    return { method: request.method, url: request.url, body: redacted };
  }

  static _request(url, method, body, cfg) {
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) {
      throw new Error('PDCflow base URL must use HTTP or HTTPS');
    }
    const lib = target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request({
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Accept: 'application/json',
          'User-Agent': 'DLBTrust-Canonical/1.0',
          Authorization: `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`,
        },
        timeout: 60000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else reject(new Error(`PDCflow returned ${res.statusCode}: ${data.slice(0, 300)}`));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('PDCflow request timed out'));
      });
      req.write(body);
      req.end();
    });
  }

  /**
   * Originate an ACH transaction. Resolves with normalized acceptance evidence;
   * a throw always means PDCflow accepted nothing. Acceptance is not settlement:
   * `settled` only becomes true once PDCflow reports a funded/settled status,
   * normally via the postback.
   */
  static async originateAch(direction, instruction) {
    if (!DIRECTIONS[direction]) throw new Error(`Unsupported PDCflow direction: ${direction}`);
    const { cfg } = this._assertReady(direction);
    const request = this._buildAchRequest(direction, instruction);
    const raw = await this._request(request.url, request.method, request.body, cfg);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new Error('PDCflow returned a non-JSON response');
    }
    return this._interpret(direction, body);
  }

  static _interpret(direction, body = {}) {
    const errors = Array.isArray(body.requestErrorList) ? body.requestErrorList : [];
    if (errors.length) {
      const detail = errors.map((e) => e.message || e.description || JSON.stringify(e)).join('; ');
      throw new Error(`PDCflow rejected the request: ${detail}`);
    }
    const status = text(body.currentStatus || body.transactionStatus || body.status).toUpperCase();
    if (TERMINAL_FAILURES.includes(status)) {
      throw new Error(`PDCflow ${direction} was not accepted (status ${status})`);
    }
    const providerReference = text(body.transactionId) || text(body.arrivalId);
    if (!providerReference) {
      throw new Error('PDCflow accepted the request without returning a transactionId');
    }
    return {
      provider: 'pdcflow',
      direction,
      providerReference,
      arrivalId: text(body.arrivalId) || null,
      providerStatus: status || 'PENDING',
      settled: SETTLED.includes(status),
      dateScheduled: body.dateScheduled || null,
      paymentMethod: body.paymentMethod || 'ACH',
    };
  }

  /**
   * Interpret a PDCflow postback body. The postback is the settlement evidence:
   * only a settled status may move a canonical payment to settled.
   */
  static interpretPostback(body = {}) {
    const status = text(body.currentStatus || body.transactionStatus).toUpperCase();
    return {
      providerReference: text(body.transactionId) || text(body.arrivalId) || null,
      arrivalId: text(body.arrivalId) || null,
      providerStatus: status || null,
      settled: SETTLED.includes(status),
      failed: TERMINAL_FAILURES.includes(status),
      paymentMethod: body.paymentMethod || null,
    };
  }
}

module.exports = { PDCflowEngine };
