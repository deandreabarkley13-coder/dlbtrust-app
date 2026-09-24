'use strict';

/**
 * Registry of settlement banks the S2S payment server may credit.
 *
 * Only registered accounts can be settled to. Lili is auto-registered as
 * bank_id='lili' / provider='lili' with the destination resolved from
 * LiliDirectDepositEngine.getDestination() (LILI_DD_* settings); any Lili
 * registration or settlement whose destination is not that account is refused
 * with 400 — the same rule as LiliSettlementBankEngine._resolveDestination.
 */

const { LiliDirectDepositEngine } = require('./liliDirectDepositEngine');
const { LiliSettlementBankEngine } = require('./liliSettlementBankEngine');

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const PROVIDERS = ['lili', 'host_to_host', 'column', 'increase', 'generic', 'api_gateway', 'stripe_payout'];
const LILI_BANK_ID = 'lili';

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

function last4(v) { return v ? String(v).slice(-4) : null; }

function normalizeId(id) {
  const s = String(id || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(s)) throw httpError('bankId must be 1-64 chars of a-z, 0-9, _ or -', 400);
  return s;
}

function rowToBank(row) {
  if (!row) return null;
  return {
    bankId: row.bank_id,
    provider: row.provider,
    name: row.name,
    routingNumber: row.routing_number,
    accountNumberMasked: row.account_last4 ? `****${row.account_last4}` : null,
    accountName: row.account_name,
    rail: row.default_rail,
    endpointId: row.endpoint_id,
    enabled: row.enabled !== false,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    _account: row.account_number || null,
  };
}

class SettlementBankRegistry {
  static get PROVIDERS() { return PROVIDERS; }

  static async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settlement_banks (
        bank_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        routing_number TEXT,
        account_number TEXT,
        account_last4 TEXT,
        account_name TEXT,
        default_rail TEXT,
        endpoint_id TEXT,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  /** The Lili entry, built live from LiliDirectDepositEngine.getDestination(). */
  static async liliBank() {
    const dest = await LiliDirectDepositEngine.getDestination();
    const cfg = LiliSettlementBankEngine._cfg();
    return {
      bankId: LILI_BANK_ID,
      provider: 'lili',
      name: 'Lili',
      routingNumber: dest.routingNumber,
      accountNumberMasked: dest.accountNumberMasked,
      accountName: dest.accountName,
      rail: 'ach',
      endpointId: null,
      enabled: true,
      metadata: { direction: cfg.direction, role: 'RDFI (credit destination only)', secCode: cfg.secCode, live: cfg.live },
      configured: Boolean(dest.configured),
      _account: dest._account,
    };
  }

  /**
   * Same rule as LiliSettlementBankEngine._resolveDestination: a supplied
   * destination must be the registered Lili account (full or ****last4 match).
   */
  static async assertLiliDestination(destination) {
    const lili = await this.liliBank();
    if (!destination || (!destination.routingNumber && !destination.routing && !destination.accountNumber && !destination.account)) {
      return lili;
    }
    if (!lili.configured) throw httpError('Lili credit destination not configured (LILI_DD_ROUTING_NUMBER / LILI_DD_ACCOUNT_NUMBER)', 503);
    const routing = String(destination.routingNumber || destination.routing || '');
    const account = String(destination.accountNumber || destination.account || '');
    const sameRouting = routing === String(lili.routingNumber);
    const sameAccount = account === String(lili._account) || (account.startsWith('****') && last4(account) === last4(lili._account));
    if (!sameRouting || !sameAccount) {
      throw httpError(`Lili provider credits only the registered Lili account (****${last4(lili._account)}); arbitrary destinations are not accepted`, 400);
    }
    return lili;
  }

  static async register({ bankId, provider, name, routingNumber, accountNumber, accountName, rail, endpointId, enabled = true, metadata = {}, createdBy = 'payment_server' } = {}) {
    await this.ensureTables();
    const id = normalizeId(bankId);
    const prov = String(provider || '').toLowerCase();
    if (!PROVIDERS.includes(prov)) throw httpError(`provider must be one of ${PROVIDERS.join(', ')}`, 400);

    if (id === LILI_BANK_ID || prov === 'lili') {
      if (id !== LILI_BANK_ID || prov !== 'lili') throw httpError(`Lili is registered only as bank_id='${LILI_BANK_ID}' with provider='lili'`, 400);
      const lili = await this.assertLiliDestination({ routingNumber, accountNumber });
      if (!lili.configured) throw httpError('Lili credit destination not configured (LILI_DD_ROUTING_NUMBER / LILI_DD_ACCOUNT_NUMBER)', 503);
      routingNumber = lili.routingNumber;
      accountNumber = lili._account;
      accountName = accountName || lili.accountName;
      name = name || 'Lili';
      rail = rail || 'ach';
      metadata = { ...lili.metadata, ...metadata };
    }

    if (!name) throw httpError('name is required', 400);
    if (prov === 'host_to_host' && !endpointId) throw httpError('endpointId (host-to-host partner) is required for provider host_to_host', 400);
    if (['column', 'increase', 'generic'].includes(prov) && !(routingNumber && accountNumber) && !endpointId) {
      throw httpError('routingNumber + accountNumber (or endpointId counterparty) required for partner-bank providers', 400);
    }

    if (!pool) throw httpError('settlement_banks storage unavailable', 503);
    const res = await pool.query(
      `INSERT INTO settlement_banks
         (bank_id, provider, name, routing_number, account_number, account_last4, account_name, default_rail, endpoint_id, enabled, metadata, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
       ON CONFLICT (bank_id) DO UPDATE SET
         provider = EXCLUDED.provider, name = EXCLUDED.name, routing_number = EXCLUDED.routing_number,
         account_number = EXCLUDED.account_number, account_last4 = EXCLUDED.account_last4, account_name = EXCLUDED.account_name,
         default_rail = EXCLUDED.default_rail, endpoint_id = EXCLUDED.endpoint_id, enabled = EXCLUDED.enabled,
         metadata = EXCLUDED.metadata, updated_at = NOW()
       RETURNING *`,
      [id, prov, name, routingNumber || null, accountNumber || null, last4(accountNumber), accountName || null,
        rail || null, endpointId || null, enabled !== false, JSON.stringify(metadata || {}), createdBy],
    );
    return rowToBank(res.rows[0]);
  }

  /** Registered bank or 404. Lili always resolves (auto-registered) but reports `configured`. */
  static async resolve(bankId) {
    const id = normalizeId(bankId);
    if (id === LILI_BANK_ID) {
      const lili = await this.liliBank();
      if (pool) {
        await this.ensureTables();
        const r = await pool.query('SELECT * FROM settlement_banks WHERE bank_id = $1', [id]);
        if (r.rows[0]) {
          const stored = rowToBank(r.rows[0]);
          if (lili.configured && (String(stored.routingNumber) !== String(lili.routingNumber) || String(stored._account) !== String(lili._account))) {
            throw httpError(`settlement_banks.lili no longer matches the registered Lili destination (****${last4(lili._account)}); re-run configureLiliChannels.js`, 400);
          }
          return { ...lili, enabled: stored.enabled, metadata: { ...lili.metadata, ...stored.metadata } };
        }
      }
      return lili;
    }
    if (!pool) throw httpError('settlement_banks storage unavailable', 503);
    await this.ensureTables();
    const r = await pool.query('SELECT * FROM settlement_banks WHERE bank_id = $1', [id]);
    if (!r.rows[0]) throw httpError(`settlement bank '${id}' is not registered`, 404);
    return rowToBank(r.rows[0]);
  }

  static async list() {
    const banks = [];
    const lili = await this.liliBank();
    banks.push(lili);
    if (pool) {
      await this.ensureTables();
      const r = await pool.query('SELECT * FROM settlement_banks WHERE bank_id <> $1 ORDER BY bank_id', [LILI_BANK_ID]);
      for (const row of r.rows) banks.push(rowToBank(row));
    }
    return banks.map((b) => this.publicView(b));
  }

  static publicView(bank) {
    if (!bank) return null;
    const pub = { ...bank };
    delete pub._account;
    return pub;
  }
}

module.exports = { SettlementBankRegistry, PROVIDERS, LILI_BANK_ID };
