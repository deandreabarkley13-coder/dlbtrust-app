'use strict';

/**
 * Banking Aggregator — provider-agnostic, bi-directional financial data hub.
 *
 * PURPOSE
 *   A single normalized layer for exchanging financial data with external
 *   institutions/providers regardless of vendor:
 *     • INBOUND  (PULL)  — accounts, balances, transactions, statements
 *     • OUTBOUND (PUSH)  — payments / financial data
 *     • WEBHOOKS (PUSH-in) — provider-initiated event notifications
 *
 *   The hub is vendor-neutral: each external system is modeled as a
 *   "connection" bound to a pluggable "connector" (see ./connectors). A
 *   connector knows how to talk to one class of provider and returns data in
 *   the aggregator's normalized shape, so the rest of the platform never sees
 *   provider-specific formats.
 *
 *   This makes the platform CAPABLE of aggregating financial data — it does not
 *   by itself create a live provider connection; a real endpoint and
 *   credentials must be configured on a connection.
 *
 * DATA MODEL (PostgreSQL)
 *   aggregator_connections   — registered external systems + connector config
 *   aggregator_accounts      — normalized accounts + latest balances
 *   aggregator_transactions  — normalized transactions
 *   aggregator_statements    — normalized statement/document references
 *   aggregator_events        — inbound webhook + outbound push audit log
 *
 * SECURITY
 *   Connection config may contain secrets (tokens, keys, webhook secrets,
 *   private-key passphrases). Secrets are persisted but NEVER returned by the
 *   API — see _redactConnection, which exposes only non-secret config plus
 *   booleans like has_api_key. Secrets are never logged.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { getConnector, listConnectorTypes } = require('./connectors');

// Config keys treated as secret material — never returned by the API, never logged.
const SECRET_CONFIG_KEYS = [
  'apiKey', 'apiSecret', 'bearerToken', 'token', 'password',
  'hmacSecret', 'webhookSecret', 'clientKeyPassphrase', 'clientSecret',
];

let tablesReady = false;
let tablesReadyPromise = null;

// Advisory-lock key that serializes concurrent migrations. Without it, the
// dashboard's parallel aggregator requests can each run CREATE TABLE IF NOT
// EXISTS at once and collide on the pg_type catalog
// ("duplicate key value violates unique constraint pg_type_typname_nsp_index").
const MIGRATION_LOCK_KEY = 4820251;

class BankingAggregator {
  // ═══════════════════════════════════════════════════════════════════════════
  //  TABLE SETUP
  // ═══════════════════════════════════════════════════════════════════════════

  static async ensureTables() {
    if (tablesReady) return;
    if (tablesReadyPromise) return tablesReadyPromise;

    tablesReadyPromise = BankingAggregator._createTables()
      .then(() => { tablesReady = true; })
      .catch((e) => { tablesReadyPromise = null; throw e; });

    return tablesReadyPromise;
  }

  static async _createTables() {
    // Serialize DDL across concurrent callers and across processes/machines so
    // parallel CREATE TABLE IF NOT EXISTS statements don't race the pg_type
    // catalog. The lock is held on a single dedicated connection and released
    // in finally.
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS aggregator_connections (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        connector_type    TEXT NOT NULL,
        direction         TEXT NOT NULL DEFAULT 'both'
                            CHECK (direction IN ('inbound','outbound','both')),
        config            JSONB NOT NULL DEFAULT '{}'::jsonb,
        active            BOOLEAN NOT NULL DEFAULT TRUE,
        last_pull_at      TIMESTAMPTZ,
        last_push_at      TIMESTAMPTZ,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS aggregator_accounts (
        id                  TEXT PRIMARY KEY,
        connection_id       TEXT NOT NULL REFERENCES aggregator_connections(id) ON DELETE CASCADE,
        external_account_id TEXT NOT NULL,
        name                TEXT,
        account_type        TEXT,
        currency            TEXT DEFAULT 'USD',
        mask                TEXT,
        balance_available   NUMERIC(20,2),
        balance_current     NUMERIC(20,2),
        raw                 JSONB,
        updated_at          TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (connection_id, external_account_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS aggregator_transactions (
        id                  TEXT PRIMARY KEY,
        connection_id       TEXT NOT NULL REFERENCES aggregator_connections(id) ON DELETE CASCADE,
        external_account_id TEXT,
        external_txn_id     TEXT NOT NULL,
        posted_date         DATE,
        amount              NUMERIC(20,2) NOT NULL,
        currency            TEXT DEFAULT 'USD',
        direction           TEXT CHECK (direction IN ('credit','debit')),
        description         TEXT,
        category            TEXT,
        status              TEXT DEFAULT 'posted',
        raw                 JSONB,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (connection_id, external_txn_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS aggregator_statements (
        id                  TEXT PRIMARY KEY,
        connection_id       TEXT NOT NULL REFERENCES aggregator_connections(id) ON DELETE CASCADE,
        external_account_id TEXT,
        external_statement_id TEXT NOT NULL,
        period_start        DATE,
        period_end          DATE,
        format              TEXT,
        uri                 TEXT,
        raw                 JSONB,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (connection_id, external_statement_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS aggregator_events (
        id            TEXT PRIMARY KEY,
        connection_id TEXT REFERENCES aggregator_connections(id) ON DELETE SET NULL,
        direction     TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
        event_type    TEXT NOT NULL,
        payload       JSONB,
        status        TEXT NOT NULL DEFAULT 'received'
                        CHECK (status IN ('received','processed','failed','sent')),
        error         TEXT,
        provider_ref  TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(function () {});
      client.release();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CONNECTION CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  static async listConnections() {
    await BankingAggregator.ensureTables();
    const result = await pool.query(
      'SELECT * FROM aggregator_connections ORDER BY created_at DESC'
    );
    return result.rows.map(BankingAggregator._redactConnection);
  }

  static async getConnection(id) {
    await BankingAggregator.ensureTables();
    const result = await pool.query(
      'SELECT * FROM aggregator_connections WHERE id = $1', [id]
    );
    return result.rows[0] ? BankingAggregator._redactConnection(result.rows[0]) : null;
  }

  /** Internal: full (unredacted) row for connector use — never returned by the API. */
  static async _getConnectionRaw(id) {
    await BankingAggregator.ensureTables();
    const result = await pool.query(
      'SELECT * FROM aggregator_connections WHERE id = $1', [id]
    );
    return result.rows[0] || null;
  }

  static async createConnection(opts) {
    await BankingAggregator.ensureTables();
    const name = (opts.name || '').trim();
    const connectorType = (opts.connectorType || opts.connector_type || '').trim();
    const direction = opts.direction || 'both';

    if (!name) throw new Error('Connection name is required');
    if (!connectorType) throw new Error('connectorType is required');
    if (!listConnectorTypes().includes(connectorType)) {
      throw new Error(`Unknown connectorType "${connectorType}". Available: ${listConnectorTypes().join(', ')}`);
    }
    if (!['inbound', 'outbound', 'both'].includes(direction)) {
      throw new Error('direction must be inbound, outbound, or both');
    }

    const id = opts.id || 'CONN-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const config = opts.config && typeof opts.config === 'object' ? opts.config : {};

    await pool.query(
      `INSERT INTO aggregator_connections (id, name, connector_type, direction, config, active)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [id, name, connectorType, direction, JSON.stringify(config), opts.active !== false]
    );
    return BankingAggregator.getConnection(id);
  }

  static async updateConnection(id, opts) {
    const existing = await BankingAggregator._getConnectionRaw(id);
    if (!existing) throw new Error('Connection not found: ' + id);

    const sets = [];
    const params = [];
    let idx = 1;

    if (opts.name !== undefined) { sets.push(`name = $${idx++}`); params.push(String(opts.name).trim()); }
    if (opts.direction !== undefined) {
      if (!['inbound', 'outbound', 'both'].includes(opts.direction)) {
        throw new Error('direction must be inbound, outbound, or both');
      }
      sets.push(`direction = $${idx++}`); params.push(opts.direction);
    }
    if (opts.active !== undefined) { sets.push(`active = $${idx++}`); params.push(opts.active === true || opts.active === 'true'); }
    if (opts.config !== undefined && typeof opts.config === 'object') {
      // Merge: new config keys overwrite existing; preserves secrets not re-sent.
      const merged = Object.assign({}, existing.config || {}, opts.config);
      sets.push(`config = $${idx++}::jsonb`); params.push(JSON.stringify(merged));
    }

    if (sets.length === 0) return BankingAggregator.getConnection(id);
    sets.push(`updated_at = NOW()`);
    params.push(id);
    await pool.query(
      `UPDATE aggregator_connections SET ${sets.join(', ')} WHERE id = $${idx}`,
      params
    );
    return BankingAggregator.getConnection(id);
  }

  static async deleteConnection(id) {
    await BankingAggregator.ensureTables();
    const result = await pool.query(
      'DELETE FROM aggregator_connections WHERE id = $1 RETURNING id', [id]
    );
    return result.rowCount > 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  INBOUND — PULL financial data via the connector, persist normalized rows
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Pull one or more data kinds from a connection and upsert normalized rows.
   * @param {string} id connection id
   * @param {Object} opts { kinds?: ['accounts','transactions','statements'], since?, accountId? }
   */
  static async pull(id, opts = {}) {
    const conn = await BankingAggregator._getConnectionRaw(id);
    if (!conn) throw new Error('Connection not found: ' + id);
    if (!conn.active) throw new Error('Connection is inactive: ' + id);
    if (conn.direction === 'outbound') throw new Error('Connection is outbound-only: ' + id);

    const connector = getConnector(conn.connector_type);
    // Precedence: explicit opts.kinds > per-connection config.pullKinds > all.
    // config.pullKinds lets a connection opt out of data kinds its provider does
    // not serve (e.g. MX has no statements endpoint) so scheduled syncs are not
    // recorded as failed for requesting an unsupported endpoint every cycle.
    const configKinds = conn.config && Array.isArray(conn.config.pullKinds) && conn.config.pullKinds.length
      ? conn.config.pullKinds
      : null;
    const kinds = Array.isArray(opts.kinds) && opts.kinds.length
      ? opts.kinds
      : (configKinds || ['accounts', 'transactions', 'statements']);

    const summary = { accounts: 0, transactions: 0, statements: 0, errors: [] };

    for (const kind of kinds) {
      try {
        if (kind === 'accounts' && typeof connector.pullAccounts === 'function') {
          const accounts = await connector.pullAccounts(conn, opts);
          for (const a of accounts) { await BankingAggregator._upsertAccount(id, a); summary.accounts++; }
        } else if (kind === 'transactions' && typeof connector.pullTransactions === 'function') {
          const txns = await connector.pullTransactions(conn, opts);
          for (const t of txns) { await BankingAggregator._upsertTransaction(id, t); summary.transactions++; }
        } else if (kind === 'statements' && typeof connector.pullStatements === 'function') {
          const stmts = await connector.pullStatements(conn, opts);
          for (const s of stmts) { await BankingAggregator._upsertStatement(id, s); summary.statements++; }
        }
      } catch (err) {
        summary.errors.push({ kind, error: err.message });
      }
    }

    await pool.query('UPDATE aggregator_connections SET last_pull_at = NOW() WHERE id = $1', [id]);
    await BankingAggregator._logEvent(id, 'inbound', 'pull', summary,
      summary.errors.length ? 'failed' : 'processed', summary.errors.length ? summary.errors[0].error : null);
    return summary;
  }

  static async _upsertAccount(connectionId, a) {
    const acctId = 'ACCT-' + connectionId + '-' + a.externalAccountId;
    await pool.query(
      `INSERT INTO aggregator_accounts
         (id, connection_id, external_account_id, name, account_type, currency, mask,
          balance_available, balance_current, raw, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,NOW())
       ON CONFLICT (connection_id, external_account_id) DO UPDATE SET
         name = EXCLUDED.name, account_type = EXCLUDED.account_type,
         currency = EXCLUDED.currency, mask = EXCLUDED.mask,
         balance_available = EXCLUDED.balance_available,
         balance_current = EXCLUDED.balance_current,
         raw = EXCLUDED.raw, updated_at = NOW()`,
      [acctId, connectionId, String(a.externalAccountId), a.name || null,
       a.accountType || null, a.currency || 'USD', a.mask || null,
       a.balanceAvailable != null ? a.balanceAvailable : null,
       a.balanceCurrent != null ? a.balanceCurrent : null,
       JSON.stringify(a.raw || {})]
    );
  }

  static async _upsertTransaction(connectionId, t) {
    const txnId = 'TXN-' + connectionId + '-' + t.externalTxnId;
    await pool.query(
      `INSERT INTO aggregator_transactions
         (id, connection_id, external_account_id, external_txn_id, posted_date, amount,
          currency, direction, description, category, status, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
       ON CONFLICT (connection_id, external_txn_id) DO UPDATE SET
         posted_date = EXCLUDED.posted_date, amount = EXCLUDED.amount,
         currency = EXCLUDED.currency, direction = EXCLUDED.direction,
         description = EXCLUDED.description, category = EXCLUDED.category,
         status = EXCLUDED.status, raw = EXCLUDED.raw`,
      [txnId, connectionId, t.externalAccountId || null, String(t.externalTxnId),
       t.postedDate || null, t.amount, t.currency || 'USD',
       t.direction || null, t.description || null, t.category || null,
       t.status || 'posted', JSON.stringify(t.raw || {})]
    );
  }

  static async _upsertStatement(connectionId, s) {
    const stmtId = 'STMT-' + connectionId + '-' + s.externalStatementId;
    await pool.query(
      `INSERT INTO aggregator_statements
         (id, connection_id, external_account_id, external_statement_id,
          period_start, period_end, format, uri, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (connection_id, external_statement_id) DO UPDATE SET
         period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end,
         format = EXCLUDED.format, uri = EXCLUDED.uri, raw = EXCLUDED.raw`,
      [stmtId, connectionId, s.externalAccountId || null, String(s.externalStatementId),
       s.periodStart || null, s.periodEnd || null, s.format || null,
       s.uri || null, JSON.stringify(s.raw || {})]
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  OUTBOUND — PUSH payment / financial data via the connector
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Push a payload outbound through the connection's connector.
   * @param {string} id connection id
   * @param {Object} payload { type, ...data }
   */
  static async push(id, payload) {
    const conn = await BankingAggregator._getConnectionRaw(id);
    if (!conn) throw new Error('Connection not found: ' + id);
    if (!conn.active) throw new Error('Connection is inactive: ' + id);
    if (conn.direction === 'inbound') throw new Error('Connection is inbound-only: ' + id);

    const connector = getConnector(conn.connector_type);
    if (typeof connector.push !== 'function') {
      throw new Error(`Connector "${conn.connector_type}" does not support outbound push`);
    }

    let result;
    try {
      result = await connector.push(conn, payload || {});
    } catch (err) {
      await BankingAggregator._logEvent(id, 'outbound', (payload && payload.type) || 'push',
        { type: payload && payload.type }, 'failed', err.message);
      throw err;
    }

    await pool.query('UPDATE aggregator_connections SET last_push_at = NOW() WHERE id = $1', [id]);
    await BankingAggregator._logEvent(id, 'outbound', (payload && payload.type) || 'push',
      { type: payload && payload.type, providerRef: result && result.providerRef },
      'sent', null, result && result.providerRef);
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  WEBHOOKS — provider-initiated inbound events
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle an inbound webhook for a connection. Verifies the signature (when the
   * connector supports it), records the event, and lets the connector normalize
   * it. Returns { ok, verified, eventId }.
   */
  static async handleWebhook(id, headers, rawBody) {
    const conn = await BankingAggregator._getConnectionRaw(id);
    if (!conn) throw new Error('Connection not found: ' + id);

    const connector = getConnector(conn.connector_type);
    let verified = true;
    if (typeof connector.verifyWebhook === 'function') {
      verified = connector.verifyWebhook(conn, headers, rawBody);
    }

    let parsed;
    try { parsed = rawBody ? JSON.parse(rawBody.toString()) : {}; } catch (e) { parsed = { _raw: String(rawBody) }; }
    const eventType = parsed.type || parsed.event || 'webhook';

    const eventId = await BankingAggregator._logEvent(id, 'inbound', eventType, parsed,
      verified ? 'received' : 'failed', verified ? null : 'signature verification failed');

    if (verified && typeof connector.handleWebhook === 'function') {
      try {
        await connector.handleWebhook(conn, parsed, BankingAggregator);
        await pool.query(`UPDATE aggregator_events SET status = 'processed' WHERE id = $1`, [eventId]);
      } catch (err) {
        await pool.query(`UPDATE aggregator_events SET status = 'failed', error = $2 WHERE id = $1`,
          [eventId, err.message]);
      }
    }

    return { ok: verified, verified, eventId };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  QUERIES
  // ═══════════════════════════════════════════════════════════════════════════

  static async listAccounts(connectionId) {
    await BankingAggregator.ensureTables();
    const clause = connectionId ? 'WHERE connection_id = $1' : '';
    const params = connectionId ? [connectionId] : [];
    const result = await pool.query(
      `SELECT * FROM aggregator_accounts ${clause} ORDER BY updated_at DESC`, params);
    return result.rows;
  }

  static async listTransactions(opts = {}) {
    await BankingAggregator.ensureTables();
    const where = [];
    const params = [];
    let idx = 1;
    if (opts.connectionId) { where.push(`connection_id = $${idx++}`); params.push(opts.connectionId); }
    if (opts.accountId) { where.push(`external_account_id = $${idx++}`); params.push(opts.accountId); }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const limit = Math.min(parseInt(opts.limit || '200', 10) || 200, 1000);
    const result = await pool.query(
      `SELECT * FROM aggregator_transactions ${clause} ORDER BY posted_date DESC NULLS LAST, created_at DESC LIMIT ${limit}`,
      params);
    return result.rows;
  }

  static async listStatements(connectionId) {
    await BankingAggregator.ensureTables();
    const clause = connectionId ? 'WHERE connection_id = $1' : '';
    const params = connectionId ? [connectionId] : [];
    const result = await pool.query(
      `SELECT * FROM aggregator_statements ${clause} ORDER BY period_end DESC NULLS LAST, created_at DESC`, params);
    return result.rows;
  }

  static async listEvents(opts = {}) {
    await BankingAggregator.ensureTables();
    const where = [];
    const params = [];
    let idx = 1;
    if (opts.connectionId) { where.push(`connection_id = $${idx++}`); params.push(opts.connectionId); }
    if (opts.direction) { where.push(`direction = $${idx++}`); params.push(opts.direction); }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const limit = Math.min(parseInt(opts.limit || '100', 10) || 100, 500);
    const result = await pool.query(
      `SELECT * FROM aggregator_events ${clause} ORDER BY created_at DESC LIMIT ${limit}`, params);
    return result.rows;
  }

  static async status() {
    await BankingAggregator.ensureTables();
    const [conns, accts, txns, evts] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE active)::int AS active FROM aggregator_connections'),
      pool.query('SELECT COUNT(*)::int AS n FROM aggregator_accounts'),
      pool.query('SELECT COUNT(*)::int AS n FROM aggregator_transactions'),
      pool.query('SELECT COUNT(*)::int AS n FROM aggregator_events'),
    ]);
    return {
      connectors_available: listConnectorTypes(),
      connections: conns.rows[0].n,
      connections_active: conns.rows[0].active,
      accounts: accts.rows[0].n,
      transactions: txns.rows[0].n,
      events: evts.rows[0].n,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  static async _logEvent(connectionId, direction, eventType, payload, status, error, providerRef) {
    const id = 'EVT-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    await pool.query(
      `INSERT INTO aggregator_events (id, connection_id, direction, event_type, payload, status, error, provider_ref)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
      [id, connectionId, direction, eventType, JSON.stringify(payload || {}),
       status || 'received', error || null, providerRef || null]
    );
    return id;
  }

  /**
   * Strip secret material from a connection row for API responses. Exposes
   * non-secret config plus has_<secret> booleans; never returns secret values.
   */
  static _redactConnection(row) {
    if (!row) return null;
    const config = row.config && typeof row.config === 'object' ? row.config : {};
    const safeConfig = {};
    const flags = {};
    for (const [k, v] of Object.entries(config)) {
      if (SECRET_CONFIG_KEYS.includes(k)) {
        flags['has_' + k] = v != null && v !== '';
      } else if (k === 'auth' && v && typeof v === 'object') {
        const safeAuth = {};
        for (const [ak, av] of Object.entries(v)) {
          if (SECRET_CONFIG_KEYS.includes(ak)) flags['has_' + ak] = av != null && av !== '';
          else safeAuth[ak] = av;
        }
        safeConfig.auth = safeAuth;
      } else {
        safeConfig[k] = v;
      }
    }
    return {
      id: row.id,
      name: row.name,
      connector_type: row.connector_type,
      direction: row.direction,
      active: row.active,
      config: safeConfig,
      credentials: flags,
      last_pull_at: row.last_pull_at,
      last_push_at: row.last_push_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

module.exports = { BankingAggregator, SECRET_CONFIG_KEYS };
