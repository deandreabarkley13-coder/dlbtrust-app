'use strict';

/**
 * Trust Aggregator Engine
 *
 * Open-finance account aggregation across internal trust ledgers, bank
 * accounts, virtual accounts, issuer assets, and external feeds. Produces a
 * consolidated net-worth and transaction view for trust operators and
 * beneficiaries.
 */

const pool = require('../bonds/pgPool');

let CashEngine, TrustAccountingEngine, IssuerEngine, VirtualAccountEngine, TrustBankEngine, BankTransferEngine, WireOriginationEngine, OpenBankingEngine;
function loadDeps() {
  try { ({ CashEngine } = require('../cash/cashEngine')); } catch (e) { CashEngine = null; }
  try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { TrustAccountingEngine = null; }
  try { ({ IssuerEngine } = require('./issuerEngine')); } catch (e) { IssuerEngine = null; }
  try { ({ VirtualAccountEngine } = require('./virtualAccountEngine')); } catch (e) { VirtualAccountEngine = null; }
  try { ({ TrustBankEngine } = require('./trustBankEngine')); } catch (e) { TrustBankEngine = null; }
  try { ({ BankTransferEngine } = require('./bankTransferEngine')); } catch (e) { BankTransferEngine = null; }
  try { ({ WireOriginationEngine } = require('./wireOriginationEngine')); } catch (e) { WireOriginationEngine = null; }
  try { ({ OpenBankingEngine } = require('./openBankingEngine')); } catch (e) { OpenBankingEngine = null; }
}

function generateId(prefix = 'TA') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

class TrustAggregatorEngine {
  static async ensureTables() {
    loadDeps();
    // Recover from any partial/legacy schema in this session
    try {
      const col = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='aggregator_connections' AND column_name='connection_id'`);
      if (!col.rows.length) {
        await pool.query(`DROP TABLE IF EXISTS aggregator_transactions, aggregator_balances, aggregator_connections CASCADE`);
      }
    } catch (e) { /* ignore */ }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS aggregator_connections (
        connection_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN ('cash','trust','issuer','virtual','trust_bank','bank_transfer','wire','open_banking','external','manual')),
        source_id TEXT,
        credentials_encrypted JSONB DEFAULT '{}',
        refresh_token TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','error','disconnected')),
        last_sync_at TIMESTAMPTZ,
        error_message TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS aggregator_balances (
        balance_id TEXT PRIMARY KEY,
        connection_id TEXT REFERENCES aggregator_connections(connection_id),
        account_id TEXT,
        account_name TEXT,
        account_type TEXT,
        source_type TEXT NOT NULL,
        balance_cents BIGINT NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        extra JSONB DEFAULT '{}',
        sync_id TEXT,
        synced_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS aggregator_transactions (
        transaction_id TEXT PRIMARY KEY,
        connection_id TEXT REFERENCES aggregator_connections(connection_id),
        account_id TEXT,
        external_tx_id TEXT,
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        description TEXT,
        tx_type TEXT,
        posted_at TIMESTAMPTZ,
        extra JSONB DEFAULT '{}',
        sync_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_aggregator_balances_conn ON aggregator_balances(connection_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_aggregator_transactions_conn ON aggregator_transactions(connection_id)`);
  }

  static async addConnection({ name, sourceType, sourceId, credentials, metadata } = {}) {
    if (!name || !sourceType) throw new Error('name and sourceType required');
    await this.ensureTables();
    const connectionId = generateId('TAC');
    await pool.query(
      `INSERT INTO aggregator_connections (connection_id, name, source_type, source_id, credentials_encrypted, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [connectionId, name, sourceType, sourceId || null, JSON.stringify(credentials || {}), JSON.stringify(metadata || {})]
    );
    return this.getConnection(connectionId);
  }

  static async getConnection(connectionId) {
    await this.ensureTables();
    const result = await pool.query(`SELECT * FROM aggregator_connections WHERE connection_id = $1`, [connectionId]);
    return result.rows[0] || null;
  }

  static async listConnections({ sourceType, status, limit = 100 } = {}) {
    await this.ensureTables();
    const conditions = [];
    const params = [];
    if (sourceType) { conditions.push(`source_type = $${params.length + 1}`); params.push(sourceType); }
    if (status) { conditions.push(`status = $${params.length + 1}`); params.push(status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const result = await pool.query(`SELECT * FROM aggregator_connections ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return result.rows;
  }

  static async sync(connectionId) {
    await this.ensureTables();
    const conn = await this.getConnection(connectionId);
    if (!conn) throw new Error('Connection not found');
    const syncId = generateId('TAS');
    const balances = [];
    const transactions = [];

    try {
      if (conn.source_type === 'cash' && CashEngine) {
        const accounts = await CashEngine.listAccounts({});
        for (const a of accounts) {
          balances.push({ connection_id: conn.connection_id, account_id: a.account_id, account_name: a.account_name, account_type: a.type || 'cash', source_type: 'cash', balance_cents: Number(a.balance_cents || 0), currency: a.currency || 'USD', extra: { type: a.type } });
        }
      } else if (conn.source_type === 'trust' && TrustAccountingEngine) {
        const accounts = await TrustAccountingEngine.listAccounts({});
        for (const a of accounts) {
          if (a.currency === 'USD') balances.push({ connection_id: conn.connection_id, account_id: a.account_code, account_name: a.account_name, account_type: a.sub_type || a.account_type, source_type: 'trust', balance_cents: toCents(a.balance), currency: a.currency || 'USD', extra: { sub_type: a.sub_type } });
        }
      } else if (conn.source_type === 'issuer' && IssuerEngine) {
        const assets = await IssuerEngine.listAssets();
        for (const asset of assets) {
          const bals = await IssuerEngine.listBalances(asset.asset_code);
          for (const b of bals) balances.push({ connection_id: conn.connection_id, account_id: `${asset.asset_code}:${b.account_id}`, account_name: `${asset.asset_code} (${b.account_id})`, account_type: 'issuer', source_type: 'issuer', balance_cents: toCents(b.balance), currency: asset.currency || 'USD', extra: { asset_code: asset.asset_code } });
        }
      } else if (conn.source_type === 'virtual' && VirtualAccountEngine) {
        const accounts = await VirtualAccountEngine.listAccounts();
        for (const a of accounts) balances.push({ connection_id: conn.connection_id, account_id: a.id, account_name: a.name, account_type: 'virtual', source_type: 'virtual', balance_cents: toCents(a.balance), currency: a.currency || 'USD', extra: { account_number: a.accountNumber } });
      } else if (conn.source_type === 'trust_bank' && TrustBankEngine) {
        const accounts = await TrustBankEngine.listAccounts({});
        for (const a of accounts) balances.push({ connection_id: conn.connection_id, account_id: a.account_id, account_name: a.account_name, account_type: a.account_type, source_type: 'trust_bank', balance_cents: Number(a.balance_cents || 0), currency: a.currency || 'USD', extra: { account_number: a.account_number } });
      } else if (conn.source_type === 'wire' && WireOriginationEngine) {
        const payouts = await WireOriginationEngine.listPayouts ? await WireOriginationEngine.listPayouts({ limit: 100 }) : [];
        for (const p of payouts) transactions.push({ connection_id: conn.connection_id, account_id: p.payout_id, external_tx_id: p.wire_id, amount_cents: -Number(p.amount_cents || 0), currency: p.currency || 'USD', description: p.description, tx_type: 'wire_out', posted_at: p.updated_at, extra: { status: p.status } });
      } else if (conn.source_type === 'bank_transfer' && BankTransferEngine && BankTransferEngine.listBankTransfers) {
        const transfers = await BankTransferEngine.listBankTransfers({ limit: 100 });
        for (const t of transfers) transactions.push({ connection_id: conn.connection_id, account_id: t.transfer_id, external_tx_id: t.external_tx_id, amount_cents: Number(t.amount_cents || 0) * (t.direction === 'out' ? -1 : 1), currency: t.currency || 'USD', description: t.description, tx_type: t.rail, posted_at: t.updated_at, extra: { direction: t.direction, status: t.status } });
      } else if (conn.source_type === 'external') {
        const stub = conn.credentials_encrypted || {};
        if (stub.balance_cents != null) {
          balances.push({ connection_id: conn.connection_id, account_id: conn.source_id || 'external', account_name: conn.name, account_type: 'external', source_type: 'external', balance_cents: Number(stub.balance_cents || 0), currency: stub.currency || 'USD', extra: stub });
        }
      } else if (conn.source_type === 'manual') {
        const stub = conn.credentials_encrypted || {};
        if (stub.balance_cents != null) {
          balances.push({ connection_id: conn.connection_id, account_id: conn.source_id || 'manual', account_name: conn.name, account_type: 'manual', source_type: 'manual', balance_cents: Number(stub.balance_cents || 0), currency: stub.currency || 'USD', extra: stub });
        }
      }

      // persist balances and transactions
      await pool.query(`DELETE FROM aggregator_balances WHERE connection_id = $1`, [conn.connection_id]);
      for (const b of balances) {
        const id = generateId('TAB');
        await pool.query(
          `INSERT INTO aggregator_balances (balance_id, connection_id, account_id, account_name, account_type, source_type, balance_cents, currency, extra, sync_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [id, b.connection_id, b.account_id, b.account_name, b.account_type, b.source_type, b.balance_cents, b.currency, JSON.stringify(b.extra || {}), syncId]
        );
      }
      for (const t of transactions) {
        const id = generateId('TAT');
        await pool.query(
          `INSERT INTO aggregator_transactions (transaction_id, connection_id, account_id, external_tx_id, amount_cents, currency, description, tx_type, posted_at, extra, sync_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [id, t.connection_id, t.account_id, t.external_tx_id || null, t.amount_cents, t.currency, t.description || null, t.tx_type || null, t.posted_at || null, JSON.stringify(t.extra || {}), syncId]
        );
      }
      await pool.query(`UPDATE aggregator_connections SET last_sync_at = NOW(), status = 'active', error_message = NULL, updated_at = NOW() WHERE connection_id = $1`, [conn.connection_id]);
    } catch (e) {
      await pool.query(`UPDATE aggregator_connections SET status = 'error', error_message = $2, updated_at = NOW() WHERE connection_id = $1`, [conn.connection_id, e.message]);
      throw e;
    }
    return { connectionId, syncId, balances: balances.length, transactions: transactions.length };
  }

  static async syncAll() {
    const conns = await this.listConnections({});
    const results = [];
    for (const c of conns) {
      try { results.push({ connectionId: c.connection_id, status: 'ok', result: await this.sync(c.connection_id) }); } catch (e) { results.push({ connectionId: c.connection_id, status: 'error', error: e.message }); }
    }
    return results;
  }

  static async aggregateBalances() {
    await this.ensureTables();
    const result = await pool.query(`
      SELECT source_type, SUM(balance_cents) AS balance_cents, COUNT(*) AS accounts
      FROM aggregator_balances GROUP BY source_type
    `);
    const bySource = {};
    let totalCents = 0;
    for (const row of result.rows) {
      bySource[row.source_type] = { balance: round2(row.balance_cents / 100), accounts: Number(row.accounts) };
      totalCents += Number(row.balance_cents || 0);
    }
    const details = await this.listBalances();
    return { total: round2(totalCents / 100), by_source: bySource, balances: details };
  }

  static async listBalances({ connectionId, limit = 1000 } = {}) {
    await this.ensureTables();
    const conditions = [];
    const params = [];
    if (connectionId) { conditions.push(`connection_id = $${params.length + 1}`); params.push(connectionId); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const result = await pool.query(`SELECT * FROM aggregator_balances ${where} ORDER BY balance_cents DESC LIMIT $${params.length}`, params);
    return result.rows;
  }

  static async listTransactions({ connectionId, limit = 1000 } = {}) {
    await this.ensureTables();
    const conditions = [];
    const params = [];
    if (connectionId) { conditions.push(`connection_id = $${params.length + 1}`); params.push(connectionId); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const result = await pool.query(`SELECT * FROM aggregator_transactions ${where} ORDER BY posted_at DESC NULLS LAST, created_at DESC LIMIT $${params.length}`, params);
    return result.rows;
  }

  static async getNetWorth() {
    const agg = await this.aggregateBalances();
    const connections = await this.listConnections({});
    return { total: agg.total, by_source: agg.by_source, connections: connections.length, balances: agg.balances };
  }

  static async autoConnectInternalSources() {
    await this.ensureTables();
    const sources = [];
    if (CashEngine) sources.push({ name: 'Cash Accounts', sourceType: 'cash' });
    if (TrustAccountingEngine) sources.push({ name: 'Trust Accounts', sourceType: 'trust' });
    if (IssuerEngine) sources.push({ name: 'Issuer Assets', sourceType: 'issuer' });
    if (VirtualAccountEngine) sources.push({ name: 'Virtual Accounts', sourceType: 'virtual' });
    if (TrustBankEngine) sources.push({ name: 'Trust Bank Accounts', sourceType: 'trust_bank' });
    if (WireOriginationEngine) sources.push({ name: 'Wire Payouts', sourceType: 'wire' });
    if (BankTransferEngine) sources.push({ name: 'Bank Transfers', sourceType: 'bank_transfer' });

    const created = [];
    for (const s of sources) {
      const existing = await pool.query(`SELECT connection_id FROM aggregator_connections WHERE source_type = $1 LIMIT 1`, [s.sourceType]);
      if (existing.rows.length) continue;
      created.push(await this.addConnection({ name: s.name, sourceType: s.sourceType }));
    }
    return created;
  }
}

module.exports = { TrustAggregatorEngine };
