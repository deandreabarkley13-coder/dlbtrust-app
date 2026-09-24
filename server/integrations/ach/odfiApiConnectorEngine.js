'use strict';

/**
 * US ACH API Connector OS — the ODFI leg that moves real external value.
 *
 * Payment Hub, Camel and OpenACH originate *instructions*; only a licensed
 * ODFI holding a funded account can execute them on FedACH. This engine is
 * the provider-agnostic adapter to such a bank-as-API ODFI (`ACH_ODFI_PROVIDER`):
 *
 *   increase  api.increase.com   Bearer key, POST /ach_transfers, Standard Webhooks
 *   column    api.column.com     Basic key, POST /transfers/ach, Column-Signature
 *
 * Every credit is preflighted against the provider account's *available*
 * balance (real dollars, never a Fineract or GL balance), originated once per
 * ach_entries row under an idempotency key, recorded in odfi_api_transfers and
 * driven to accepted / settled / returned on ach_batches from the provider's
 * signed webhooks (or `sync()` polling). Debits are refused: the treasury
 * originates credits only.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');

class OdfiApiError extends Error {
  constructor(message, code, status = 400, details = null) {
    super(message);
    this.name = 'OdfiApiError';
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}

const CREDIT_CODES = ['22', '32'];
const FINAL = ['settled', 'returned', 'rejected', 'canceled'];

function json(res) {
  return res.text().then((t) => {
    try { return t ? JSON.parse(t) : {}; } catch (e) { return { raw: t }; }
  });
}

async function call(cfg, method, path, { body, headers = {}, idempotencyKey } = {}) {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...cfg.driver.auth(cfg),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      ...headers,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const data = await json(res);
  if (!res.ok) {
    const detail = data && (data.detail || data.title || data.message || data.type || data.raw);
    throw new OdfiApiError(`${cfg.provider} ${method} ${path} failed (${res.status})${detail ? `: ${detail}` : ''}`, 'PROVIDER_ERROR', 502, data);
  }
  return data;
}

function hmacB64(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64');
}
function hmacHex(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ---------------------------------------------------------------- drivers */

const increase = {
  defaultBaseUrl: 'https://api.increase.com',
  auth: (cfg) => ({ authorization: `Bearer ${cfg.apiKey}` }),
  async balance(cfg) {
    const b = await call(cfg, 'GET', `/accounts/${encodeURIComponent(cfg.accountId)}/balance`);
    return { availableCents: Number(b.available_balance), currentCents: Number(b.current_balance) };
  },
  async originateCredit(cfg, { entry, batch, idempotencyKey }) {
    const t = await call(cfg, 'POST', '/ach_transfers', {
      idempotencyKey,
      body: {
        account_id: cfg.accountId,
        amount: Number(entry.amount_cents),
        routing_number: String(entry.receiving_routing),
        account_number: String(entry.account_number),
        funding: String(entry.transaction_code) === '32' ? 'savings' : 'checking',
        individual_name: String(entry.individual_name || 'BENEFICIARY').slice(0, 22),
        individual_id: String(entry.individual_id || entry.entry_sequence).slice(0, 15),
        statement_descriptor: String(batch.entry_description || 'TRUST PAYMENT').slice(0, 10),
        company_entry_description: String(batch.entry_description || 'PAYMENT').slice(0, 10),
        standard_entry_class_code: batch.sec_code === 'PPD' ? 'prearranged_payments_and_deposit' : 'corporate_credit_or_debit',
        ...(batch.effective_date ? { preferred_effective_date: { date: new Date(batch.effective_date).toISOString().slice(0, 10) } } : {}),
      },
    });
    return increase.normalize(t);
  },
  async getTransfer(cfg, id) {
    return increase.normalize(await call(cfg, 'GET', `/ach_transfers/${encodeURIComponent(id)}`));
  },
  normalize(t) {
    let status = 'submitted';
    if (['pending_submission', 'pending_reviewing', 'pending_approval', 'requires_attention'].includes(t.status)) status = 'pending';
    else if (t.status === 'returned') status = 'returned';
    else if (t.status === 'rejected') status = 'rejected';
    else if (t.status === 'canceled') status = 'canceled';
    else if (t.settlement && t.settlement.settled_at) status = 'settled';
    return {
      providerTransferId: t.id,
      status,
      traceNumber: t.submission ? t.submission.trace_number : null,
      settledAt: t.settlement ? t.settlement.settled_at : null,
      returnCode: t.return ? t.return.raw_return_reason_code : null,
      returnReason: t.return ? t.return.return_reason_code : null,
      raw: t,
    };
  },
  verifyWebhook(cfg, rawBody, headers) {
    const id = headers['webhook-id'];
    const ts = headers['webhook-timestamp'];
    const sigs = String(headers['webhook-signature'] || '').split(/\s+/).filter(Boolean);
    if (!id || !ts || !sigs.length) return false;
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
    const expected = `v1,${hmacB64(cfg.webhookSecret, `${id}.${ts}.${rawBody.toString('utf8')}`)}`;
    return sigs.some((s) => safeEqual(s, expected));
  },
  // Increase events are thin: {category:'ach_transfer.updated', associated_object_id}.
  webhookTransferIds(body) {
    if (body && body.associated_object_type === 'ach_transfer' && body.associated_object_id) return [body.associated_object_id];
    return [];
  },
};

const column = {
  defaultBaseUrl: 'https://api.column.com',
  auth: (cfg) => ({ authorization: `Basic ${Buffer.from(`:${cfg.apiKey}`).toString('base64')}` }),
  async balance(cfg) {
    const a = await call(cfg, 'GET', `/bank-accounts/${encodeURIComponent(cfg.accountId)}`);
    const b = a.balances || {};
    return { availableCents: Number(b.available_amount), currentCents: Number(b.holding_amount != null ? b.available_amount + b.holding_amount : b.available_amount) };
  },
  async originateCredit(cfg, { entry, batch, idempotencyKey }) {
    const cp = await call(cfg, 'POST', '/counterparties', {
      idempotencyKey: `${idempotencyKey}:cp`,
      body: {
        routing_number: String(entry.receiving_routing),
        account_number: String(entry.account_number),
        account_type: String(entry.transaction_code) === '32' ? 'savings' : 'checking',
        name: String(entry.individual_name || 'BENEFICIARY'),
      },
    });
    const t = await call(cfg, 'POST', '/transfers/ach', {
      idempotencyKey,
      body: {
        bank_account_id: cfg.accountId,
        counterparty_id: cp.id,
        amount: Number(entry.amount_cents),
        currency_code: 'USD',
        type: 'CREDIT',
        entry_class_code: batch.sec_code || 'CCD',
        description: String(batch.entry_description || 'PAYMENT').slice(0, 10),
        company_name: String(batch.company_name || process.env.ACH_ORIGINATOR_NAME || '').slice(0, 16) || undefined,
        ...(batch.effective_date ? { effective_date: new Date(batch.effective_date).toISOString().slice(0, 10) } : {}),
      },
    });
    return column.normalize(t);
  },
  async getTransfer(cfg, id) {
    return column.normalize(await call(cfg, 'GET', `/transfers/ach/${encodeURIComponent(id)}`));
  },
  normalize(t) {
    const s = String(t.status || '').toUpperCase();
    let status = 'submitted';
    if (['INITIATED', 'PENDING_SUBMISSION', 'MANUAL_REVIEW'].includes(s)) status = 'pending';
    else if (['RETURNED', 'RETURN_DISHONORED', 'RETURN_CONTESTED'].includes(s)) status = 'returned';
    else if (['SETTLED', 'COMPLETED'].includes(s)) status = 'settled';
    else if (s === 'REJECTED') status = 'rejected';
    else if (s === 'CANCELED') status = 'canceled';
    return {
      providerTransferId: t.id,
      status,
      traceNumber: t.trace_number || null,
      settledAt: t.settled_at || t.completed_at || null,
      returnCode: t.return_details && t.return_details[0] ? t.return_details[0].return_code : null,
      returnReason: t.return_details && t.return_details[0] ? t.return_details[0].description : null,
      raw: t,
    };
  },
  verifyWebhook(cfg, rawBody, headers) {
    const sig = headers['column-signature'];
    return Boolean(sig) && safeEqual(sig, hmacHex(cfg.webhookSecret, rawBody.toString('utf8')));
  },
  webhookTransferIds(body) {
    const d = body && body.data;
    if (d && d.id && /^ach\./.test(String(body.type || ''))) return [d.id];
    return [];
  },
};

const DRIVERS = { increase, column };

/* ----------------------------------------------------------------- engine */

class OdfiApiConnectorEngine {
  static providers() { return Object.keys(DRIVERS); }

  static config() {
    const env = process.env;
    const provider = String(env.ACH_ODFI_PROVIDER || '').trim().toLowerCase();
    const driver = DRIVERS[provider] || null;
    return {
      enabled: !['0', 'false', 'no', 'off'].includes(String(env.ACH_ODFI_ENABLED || 'true').toLowerCase()) && Boolean(provider),
      provider,
      driver,
      baseUrl: String(env.ACH_ODFI_API_BASE_URL || (driver ? driver.defaultBaseUrl : '')).replace(/\/+$/, ''),
      apiKey: env.ACH_ODFI_API_KEY || '',
      accountId: env.ACH_ODFI_ACCOUNT_ID || '',
      webhookSecret: env.ACH_ODFI_WEBHOOK_SECRET || '',
      name: env.ACH_ODFI_PROVIDER_NAME || (provider ? `${provider} ODFI` : ''),
    };
  }

  static readiness() {
    const cfg = OdfiApiConnectorEngine.config();
    const issues = [];
    const warnings = [];
    if (!cfg.provider) issues.push('ACH_ODFI_PROVIDER is not set (increase | column)');
    else if (!cfg.driver) issues.push(`ACH_ODFI_PROVIDER "${cfg.provider}" is not supported (${OdfiApiConnectorEngine.providers().join(', ')})`);
    if (cfg.provider && !cfg.enabled) issues.push('ACH_ODFI_ENABLED=false');
    if (cfg.driver && !cfg.apiKey) issues.push('ACH_ODFI_API_KEY (Secret Manager) is required');
    if (cfg.driver && !cfg.accountId) issues.push('ACH_ODFI_ACCOUNT_ID (the funded origination account at the provider) is required');
    if (cfg.driver && !cfg.webhookSecret) warnings.push('ACH_ODFI_WEBHOOK_SECRET missing: provider webhooks will be refused; settlement relies on sync()');
    return {
      ready: issues.length === 0,
      issues,
      warnings,
      provider: cfg.provider || null,
      providerName: cfg.name || null,
      baseUrl: cfg.baseUrl || null,
      accountConfigured: Boolean(cfg.accountId),
      webhookConfigured: Boolean(cfg.webhookSecret),
      creditsOnly: true,
    };
  }

  /** Partner config for ACHEngine.transmitBatch, or null when this channel is not live. */
  static partnerConfig() {
    const r = OdfiApiConnectorEngine.readiness();
    if (!r.ready) return null;
    const cfg = OdfiApiConnectorEngine.config();
    return {
      partnerId: `ODFI-API-${cfg.provider.toUpperCase()}`,
      partnerName: cfg.name,
      protocol: 'odfi_api',
      apiBaseUrl: cfg.baseUrl,
      provider: cfg.provider,
    };
  }

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS odfi_api_transfers (
        transfer_id          TEXT PRIMARY KEY,
        provider             TEXT NOT NULL,
        provider_transfer_id TEXT,
        batch_id             TEXT NOT NULL,
        entry_sequence       INTEGER NOT NULL,
        amount_cents         BIGINT NOT NULL,
        status               TEXT NOT NULL,
        trace_number         TEXT,
        return_code          TEXT,
        return_reason        TEXT,
        settled_at           TIMESTAMPTZ,
        raw                  JSONB,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (batch_id, entry_sequence)
      )`);
    await pool.query('CREATE INDEX IF NOT EXISTS odfi_api_transfers_provider_ref ON odfi_api_transfers (provider, provider_transfer_id)');
  }

  static _live() {
    const r = OdfiApiConnectorEngine.readiness();
    if (!r.ready) throw new OdfiApiError(`US ACH API connector not ready: ${r.issues.join('; ')}`, 'NOT_READY', 503);
    return OdfiApiConnectorEngine.config();
  }

  /** Real available dollars at the ODFI — the only balance a credit may draw on. */
  static async fundedBalance() {
    const cfg = OdfiApiConnectorEngine._live();
    const b = await cfg.driver.balance(cfg);
    if (!Number.isFinite(b.availableCents)) throw new OdfiApiError(`${cfg.provider} returned no available balance`, 'BALANCE_UNREADABLE', 502);
    return { provider: cfg.provider, accountId: cfg.accountId, ...b };
  }

  /**
   * Originate every entry of an ach_batches row as an ODFI credit. Returns the
   * ACHEngine transmit result shape; the batch stays 'transmitted' until the
   * provider confirms settlement.
   */
  static async originateBatch(batch) {
    const cfg = OdfiApiConnectorEngine._live();
    await OdfiApiConnectorEngine.ensureTables();
    const entries = Array.isArray(batch.entries) && batch.entries.length
      ? batch.entries
      : (await pool.query('SELECT * FROM ach_entries WHERE batch_id = $1 ORDER BY entry_sequence', [batch.batch_id])).rows;
    if (!entries.length) throw new OdfiApiError(`Batch ${batch.batch_id} has no entries to originate`, 'NO_ENTRIES');
    const debit = entries.find((e) => !CREDIT_CODES.includes(String(e.transaction_code || '22')));
    if (debit) throw new OdfiApiError(`ODFI API channel originates credits only; entry ${debit.entry_sequence} has transaction code ${debit.transaction_code}`, 'CREDITS_ONLY');

    const totalCents = entries.reduce((s, e) => s + Number(e.amount_cents || 0), 0);
    const balance = await OdfiApiConnectorEngine.fundedBalance();
    if (balance.availableCents < totalCents) {
      throw new OdfiApiError(
        `Insufficient available funds at ${cfg.provider}: ${(balance.availableCents / 100).toFixed(2)} available, ${(totalCents / 100).toFixed(2)} required`,
        'INSUFFICIENT_FUNDS', 409, { availableCents: balance.availableCents, requiredCents: totalCents }
      );
    }

    const originated = [];
    for (const entry of entries) {
      const existing = await pool.query('SELECT * FROM odfi_api_transfers WHERE batch_id = $1 AND entry_sequence = $2', [batch.batch_id, entry.entry_sequence]);
      if (existing.rows[0] && existing.rows[0].provider_transfer_id) {
        originated.push(OdfiApiConnectorEngine._row(existing.rows[0]));
        continue;
      }
      const idempotencyKey = `dlbtrust:${batch.batch_id}:${entry.entry_sequence}`;
      const t = await cfg.driver.originateCredit(cfg, { entry, batch, idempotencyKey });
      const transferId = existing.rows[0] ? existing.rows[0].transfer_id : `OAT-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const { rows } = await pool.query(
        `INSERT INTO odfi_api_transfers (transfer_id, provider, provider_transfer_id, batch_id, entry_sequence, amount_cents, status, trace_number, settled_at, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (batch_id, entry_sequence) DO UPDATE SET provider_transfer_id = EXCLUDED.provider_transfer_id, status = EXCLUDED.status,
           trace_number = EXCLUDED.trace_number, settled_at = EXCLUDED.settled_at, raw = EXCLUDED.raw, updated_at = NOW()
         RETURNING *`,
        [transferId, cfg.provider, t.providerTransferId, batch.batch_id, entry.entry_sequence, Number(entry.amount_cents), t.status, t.traceNumber, t.settledAt, JSON.stringify(t.raw || {})]
      );
      if (t.traceNumber) {
        await pool.query('UPDATE ach_entries SET trace_number = COALESCE(trace_number, $3) WHERE batch_id = $1 AND entry_sequence = $2', [batch.batch_id, entry.entry_sequence, t.traceNumber]).catch(() => {});
      }
      originated.push(OdfiApiConnectorEngine._row(rows[0]));
    }

    return {
      success: true,
      mode: 'odfi_api',
      message_id: `ODFI-${cfg.provider.toUpperCase()}-${batch.batch_id}`,
      status_code: 200,
      mdn_received: false,
      response_body: JSON.stringify({ provider: cfg.provider, account_id: cfg.accountId, available_cents_before: balance.availableCents, transfers: originated }),
      odfi: { provider: cfg.provider, transfers: originated },
    };
  }

  static _row(r) {
    return {
      transferId: r.transfer_id,
      provider: r.provider,
      providerTransferId: r.provider_transfer_id,
      batchId: r.batch_id,
      entrySequence: Number(r.entry_sequence),
      amountCents: Number(r.amount_cents),
      status: r.status,
      traceNumber: r.trace_number,
      returnCode: r.return_code,
      returnReason: r.return_reason,
      settledAt: r.settled_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /** Apply a provider-side transfer state to our record and drive the batch. */
  static async _apply(row, t) {
    const previousStatus = row.status;
    const { rows } = await pool.query(
      `UPDATE odfi_api_transfers SET status = $2, trace_number = COALESCE($3, trace_number), settled_at = COALESCE($4, settled_at),
         return_code = COALESCE($5, return_code), return_reason = COALESCE($6, return_reason), raw = $7, updated_at = NOW()
       WHERE transfer_id = $1 RETURNING *`,
      [row.transfer_id, t.status, t.traceNumber, t.settledAt, t.returnCode, t.returnReason, JSON.stringify(t.raw || {})]
    );
    const updated = rows[0];
    const { ACHEngine } = require('./achEngine');
    const batch = await ACHEngine.getBatch(row.batch_id);
    if (!batch) return OdfiApiConnectorEngine._row(updated);

    if (t.status === 'returned' && previousStatus !== 'returned' && ['transmitted', 'accepted', 'settled'].includes(batch.status)) {
      await ACHEngine.processReturns(row.batch_id, [{
        entrySequence: Number(row.entry_sequence),
        traceNumber: t.traceNumber || row.trace_number || null,
        returnCode: t.returnCode || 'R99',
        returnReason: t.returnReason || `${row.provider} return`,
        returnAmountCents: Number(row.amount_cents),
        returnDate: new Date().toISOString().slice(0, 10),
      }], { returnFileRef: `odfi_api:${row.provider}:${t.providerTransferId}` });
    } else if (['submitted', 'settled'].includes(t.status) && batch.status === 'transmitted') {
      await ACHEngine.acceptBatch(row.batch_id, { source: `odfi_api:${row.provider}` });
    }
    if (t.status === 'settled') {
      const pending = await pool.query(`SELECT COUNT(*)::int AS n FROM odfi_api_transfers WHERE batch_id = $1 AND status <> 'settled'`, [row.batch_id]);
      const fresh = await ACHEngine.getBatch(row.batch_id);
      if (pending.rows[0].n === 0 && fresh && fresh.status === 'accepted') {
        await ACHEngine.settleBatch(row.batch_id, { settlementDate: (t.settledAt || new Date().toISOString()).slice(0, 10), source: `odfi_api:${row.provider}` });
      }
    }
    return OdfiApiConnectorEngine._row(updated);
  }

  /** Signed provider webhook → transfer state → batch state. */
  static async handleWebhook(provider, rawBody, headers = {}) {
    const cfg = OdfiApiConnectorEngine._live();
    if (String(provider || '').toLowerCase() !== cfg.provider) throw new OdfiApiError(`Webhook for "${provider}" but ACH_ODFI_PROVIDER is ${cfg.provider}`, 'PROVIDER_MISMATCH', 404);
    if (!cfg.webhookSecret) throw new OdfiApiError('ACH_ODFI_WEBHOOK_SECRET not configured', 'WEBHOOK_SECRET_REQUIRED', 503);
    const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''));
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
    if (!cfg.driver.verifyWebhook(cfg, raw, lower)) throw new OdfiApiError('Webhook signature verification failed', 'BAD_SIGNATURE', 401);
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch (e) { throw new OdfiApiError('Webhook body is not JSON', 'BAD_BODY'); }

    await OdfiApiConnectorEngine.ensureTables();
    const updated = [];
    for (const id of cfg.driver.webhookTransferIds(body)) {
      const { rows } = await pool.query('SELECT * FROM odfi_api_transfers WHERE provider = $1 AND provider_transfer_id = $2', [cfg.provider, id]);
      if (!rows[0]) continue;
      const t = await cfg.driver.getTransfer(cfg, id);
      updated.push(await OdfiApiConnectorEngine._apply(rows[0], t));
    }
    return { received: true, provider: cfg.provider, updated };
  }

  /** Poll every non-final transfer at the provider (webhook fallback / recovery). */
  static async sync({ limit = 200 } = {}) {
    const cfg = OdfiApiConnectorEngine._live();
    await OdfiApiConnectorEngine.ensureTables();
    const { rows } = await pool.query(
      `SELECT * FROM odfi_api_transfers WHERE provider = $1 AND provider_transfer_id IS NOT NULL AND NOT (status = ANY($2)) ORDER BY created_at LIMIT $3`,
      [cfg.provider, FINAL, limit]
    );
    const updated = [];
    for (const row of rows) {
      const t = await cfg.driver.getTransfer(cfg, row.provider_transfer_id);
      if (t.status !== row.status || t.traceNumber !== row.trace_number) updated.push(await OdfiApiConnectorEngine._apply(row, t));
    }
    return { checked: rows.length, updated };
  }

  static async list({ batchId, status, limit = 100 } = {}) {
    await OdfiApiConnectorEngine.ensureTables();
    const where = [];
    const params = [];
    if (batchId) { params.push(batchId); where.push(`batch_id = $${params.length}`); }
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    params.push(Math.min(Number(limit) || 100, 1000));
    const { rows } = await pool.query(
      `SELECT * FROM odfi_api_transfers ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${params.length}`, params
    );
    return rows.map(OdfiApiConnectorEngine._row);
  }

  static async status() {
    const readiness = OdfiApiConnectorEngine.readiness();
    const out = { ...readiness, providers: OdfiApiConnectorEngine.providers(), balance: null, counts: {} };
    if (readiness.ready) {
      try { out.balance = await OdfiApiConnectorEngine.fundedBalance(); } catch (e) {
        out.ready = false;
        out.issues = [...out.issues, `provider account unreadable: ${e.message}`];
      }
      try {
        await OdfiApiConnectorEngine.ensureTables();
        const { rows } = await pool.query('SELECT status, COUNT(*)::int AS n, COALESCE(SUM(amount_cents),0)::bigint AS cents FROM odfi_api_transfers GROUP BY status');
        for (const r of rows) out.counts[r.status] = { count: r.n, cents: Number(r.cents) };
      } catch (e) { out.warnings = [...out.warnings, `transfer register unreadable: ${e.message}`]; }
    }
    return out;
  }
}

module.exports = { OdfiApiConnectorEngine, OdfiApiError, DRIVERS };
