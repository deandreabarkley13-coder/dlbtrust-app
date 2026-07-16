'use strict';

const { getConfig, readiness } = require('./paymentHubConfig');

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

class PaymentHubClient {
  static async submit(intent) {
    const config = getConfig();
    const status = readiness();
    if (config.mode !== 'phee') throw new Error('Payment Hub EE client requires PAYMENT_HUB_MODE=phee');
    if (!status.ready) throw new Error('Payment Hub EE configuration is incomplete: ' + status.issues.join('; '));

    const payload = {
      requestId: intent.intent_id,
      idempotencyKey: intent.idempotency_key,
      transactionType: 'US_ACH_CREDIT',
      amount: {
        amount: (Number(intent.amount_cents) / 100).toFixed(2),
        currency: intent.currency,
      },
      payer: {
        accountId: intent.source_sub_ledger_id || intent.source_account_code,
        accountType: intent.source_sub_ledger_id ? 'SUB_LEDGER' : 'GL_ACCOUNT',
      },
      payee: {
        name: intent.beneficiary_name,
        accountType: intent.beneficiary_account_type,
        routingNumber: intent.beneficiary_routing,
        accountNumber: intent.beneficiary_account,
      },
      payment: {
        type: intent.payment_type,
        secCode: intent.sec_code,
        effectiveDate: intent.effective_date,
        description: intent.description,
      },
      extensions: {
        dlbTrustIntentId: intent.intent_id,
        callbackUrl: config.callbackUrl,
        connectorUrl: config.connectorUrl,
      },
    };

    const response = await PaymentHubClient._request('POST', config.transferPath, payload, intent.idempotency_key);
    const externalId = response.transactionId || response.requestId || response.id || null;
    if (!externalId) throw new Error('Payment Hub EE accepted the request without a transaction identifier');
    return {
      externalId,
      status: response.status || 'ORCHESTRATING',
    };
  }

  static async getStatus(externalId) {
    if (!externalId) throw new Error('Payment Hub transaction ID is required');
    return PaymentHubClient._request('GET', `/channel/transactions/${encodeURIComponent(externalId)}`);
  }

  static async health() {
    const config = getConfig();
    if (config.mode !== 'phee') return { connected: false, mode: config.mode, reason: 'PHEE mode is not enabled' };
    try {
      const response = await PaymentHubClient._request('GET', '/actuator/health', null, null, 0);
      return { connected: true, status: response.status || 'UP' };
    } catch (err) {
      return { connected: false, error: err.message };
    }
  }

  static async _request(method, requestPath, body, idempotencyKey, retriesOverride) {
    const config = getConfig();
    const url = config.baseUrl + requestPath;
    const attempts = (retriesOverride === undefined ? config.maxRetries : retriesOverride) + 1;
    let lastError;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
      try {
        const headers = {
          Accept: 'application/json',
          Authorization: `Bearer ${config.authToken}`,
          'Content-Type': 'application/json',
          'X-Tenant-Identifier': config.tenantId,
          'X-Request-ID': idempotencyKey || `status-${Date.now()}`,
        };
        if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

        const response = await fetch(url, {
          method,
          headers,
          body: body === null || body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await response.text();
        let data = {};
        if (text) {
          try { data = JSON.parse(text); }
          catch (err) { data = { message: text.substring(0, 500) }; }
        }

        if (response.ok) return data;

        const retryable = response.status === 429 || response.status >= 500;
        const error = new Error(`Payment Hub EE request failed with HTTP ${response.status}`);
        error.statusCode = response.status;
        error.retryable = retryable;
        if (!retryable || attempt === attempts - 1) throw error;
        lastError = error;
      } catch (err) {
        const normalized = err.name === 'AbortError'
          ? new Error(`Payment Hub EE request timed out after ${config.requestTimeoutMs}ms`)
          : err;
        lastError = normalized;
        if (normalized.retryable === false || attempt === attempts - 1) throw normalized;
      } finally {
        clearTimeout(timer);
      }

      await wait(Math.min(250 * (2 ** attempt), 2000));
    }

    throw lastError;
  }
}

module.exports = { PaymentHubClient };
