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
 *   banking_aggregator_connections   — registered external systems + connector config
 *   banking_aggregator_accounts      — normalized accounts + latest balances
 *   banking_aggregator_transactions  — normalized transactions
 *   banking_aggregator_statements    — normalized statement/document references
 *   banking_aggregator_events        — inbound webhook + outbound push audit log
 *
 * HANDSHAKE (connection lifecycle)
 *   Connectors may declare `handshake(conn, opts)`. For those connectors a
 *   connection moves pending → challenged → verified|failed: the connector
 *   posts a challenge to the provider's registration endpoint, verifies the
 *   HMAC-signed reply, and returns the provider's external_connection_id plus
 *   the negotiated capabilities (pull/push/webhook). pull/push refuse until
 *   handshake_state = 'verified'. The handshake runs automatically on
 *   createConnection / updateConnection (config change) unless
 *   config.autoHandshake === false, and can be (re)run via handshake(id).
 *
 * OUTBOUND MODE (fail-closed)
 *   Every connection has a mode — config.mode, else AGGREGATOR_DEFAULT_MODE,
 *   else 'shadow'. In shadow mode push() records the intent in
 *   banking_aggregator_events and never calls the provider. In live mode a
 *   push must carry approvalRef (maker/checker record) and screeningRef
 *   (PaymentComplianceGate screening id) — the same rule as
 *   BankSettlementEngine.clearAndSettle — or it is refused with 409.
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
  'hmacSecret', 'webhookSecret', 'clientKeyPassphrase', 'clientSecret', 'accessToken',
  'credentialsKey', 'transactionsKey',
];

const HANDSHAKE_STATES = ['pending', 'challenged', 'verified', 'failed'];
const MODES = ['live', 'shadow'];
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15000;

function httpError(message, status) { return Object.assign(new Error(message), { status }); }

function handshakeTimeoutMs() {
  const n = Number(process.env.AGGREGATOR_HANDSHAKE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_HANDSHAKE_TIMEOUT_MS;
}

/** env suffix -> connection config key, resolved by _withEnvCredentials. */
const ENV_CREDENTIAL_KEYS = {
  _API_KEY: 'apiKey',
  _API_SECRET: 'apiSecret',
  _WEBHOOK_SECRET: 'webhookSecret',
  _BEARER_TOKEN: 'bearerToken',
  _CLIENT_SECRET: 'clientSecret',
  _ACCESS_TOKEN: 'accessToken',
  _CREDENTIALS_KEY: 'credentialsKey',
  _TRANSACTIONS_KEY: 'transactionsKey',
};

function defaultMode() {
  const m = String(process.env.AGGREGATOR_DEFAULT_MODE || 'shadow').toLowerCase();
  return MODES.includes(m) ? m : 'shadow';
}

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

  static async _legacyTableHasColumn(client, table, column) {
    const res = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column]
    );
    return res.rows.length > 0;
  }

  static async _migrateLegacyTables(client) {
    let begun = false;
    try {
      // Run the legacy backfill exactly once per deployment. Wrap it in a
      // transaction so a partial failure rolls back and the migration marker
      // is only written when every table has been copied successfully.
      await client.query('BEGIN');
      begun = true;

      const markerRes = await client.query(
        `SELECT 1 FROM banking_aggregator_migrations WHERE key = $1`,
        ['legacy_aggregator_v1']
      );
      if (markerRes.rows.length) {
        await client.query('COMMIT');
        return;
      }

      // Migrate legacy `aggregator_*` tables that match the banking schema.
      // Trust-aggregator tables share the `aggregator_*` prefix but have a
      // different schema (e.g. `connection_id` PK and `source_type`), so we
      // check for banking-specific columns before copying.
      if (await this._legacyTableHasColumn(client, 'aggregator_connections', 'connector_type')) {
        await client.query(`
          INSERT INTO banking_aggregator_connections (id, name, connector_type, direction, config, active, last_pull_at, last_push_at, created_at, updated_at)
          SELECT id, name, connector_type, direction, config::jsonb, active, last_pull_at, last_push_at, created_at, updated_at
          FROM aggregator_connections
          ON CONFLICT (id) DO NOTHING
        `);
      }
      if (await this._legacyTableHasColumn(client, 'aggregator_accounts', 'external_account_id')) {
        await client.query(`
          INSERT INTO banking_aggregator_accounts (id, connection_id, external_account_id, name, account_type, currency, mask, balance_available, balance_current, raw, updated_at)
          SELECT id, connection_id, external_account_id, name, account_type, currency, mask, balance_available, balance_current, raw::jsonb, updated_at
          FROM aggregator_accounts
          ON CONFLICT (connection_id, external_account_id) DO NOTHING
        `);
      }
      if (await this._legacyTableHasColumn(client, 'aggregator_transactions', 'external_txn_id')) {
        await client.query(`
          INSERT INTO banking_aggregator_transactions (id, connection_id, external_account_id, external_txn_id, posted_date, amount, currency, direction, description, category, status, raw, created_at)
          SELECT id, connection_id, external_account_id, external_txn_id, posted_date, amount, currency, direction, description, category, status, raw::jsonb, created_at
          FROM aggregator_transactions
          ON CONFLICT (connection_id, external_txn_id) DO NOTHING
        `);
      }
      if (await this._legacyTableHasColumn(client, 'aggregator_statements', 'external_statement_id')) {
        await client.query(`
          INSERT INTO banking_aggregator_statements (id, connection_id, external_account_id, external_statement_id, period_start, period_end, format, uri, raw, created_at)
          SELECT id, connection_id, external_account_id, external_statement_id, period_start, period_end, format, uri, raw::jsonb, created_at
          FROM aggregator_statements
          ON CONFLICT (connection_id, external_statement_id) DO NOTHING
        `);
      }
      if (await this._legacyTableHasColumn(client, 'aggregator_events', 'event_type')) {
        await client.query(`
          INSERT INTO banking_aggregator_events (id, connection_id, direction, event_type, payload, status, error, provider_ref, created_at)
          SELECT id, connection_id, direction, event_type, payload::jsonb, status, error, provider_ref, created_at
          FROM aggregator_events
          ON CONFLICT (id) DO NOTHING
        `);
      }

      await client.query(`
        INSERT INTO banking_aggregator_migrations (key, migrated_at)
        VALUES ('legacy_aggregator_v1', NOW())
        ON CONFLICT (key) DO NOTHING
      `);

      await client.query('COMMIT');
    } catch (e) {
      if (begun) await client.query('ROLLBACK').catch(() => {});
      console.warn('[BankingAggregator] legacy migration failed:', e.message);
      throw e;
    }
  }

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
      CREATE TABLE IF NOT EXISTS banking_aggregator_connections (
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
      ALTER TABLE banking_aggregator_connections
        ADD COLUMN IF NOT EXISTS handshake_state TEXT NOT NULL DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS handshake_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS handshake_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS external_connection_id TEXT
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'banking_aggregator_connections_handshake_state_check') THEN
          ALTER TABLE banking_aggregator_connections
            ADD CONSTRAINT banking_aggregator_connections_handshake_state_check
            CHECK (handshake_state IN ('pending','challenged','verified','failed'));
        END IF;
      END $$
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS banking_aggregator_accounts (
        id                  TEXT PRIMARY KEY,
        connection_id       TEXT NOT NULL REFERENCES banking_aggregator_connections(id) ON DELETE CASCADE,
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
      CREATE TABLE IF NOT EXISTS banking_aggregator_transactions (
        id                  TEXT PRIMARY KEY,
        connection_id       TEXT NOT NULL REFERENCES banking_aggregator_connections(id) ON DELETE CASCADE,
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
      CREATE TABLE IF NOT EXISTS banking_aggregator_statements (
        id                  TEXT PRIMARY KEY,
        connection_id       TEXT NOT NULL REFERENCES banking_aggregator_connections(id) ON DELETE CASCADE,
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
      CREATE TABLE IF NOT EXISTS banking_aggregator_events (
        id            TEXT PRIMARY KEY,
        connection_id TEXT REFERENCES banking_aggregator_connections(id) ON DELETE SET NULL,
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

    await client.query(`
      CREATE TABLE IF NOT EXISTS banking_aggregator_migrations (
        key          TEXT PRIMARY KEY,
        migrated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await BankingAggregator._migrateLegacyTables(client);
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
      'SELECT * FROM banking_aggregator_connections ORDER BY created_at DESC'
    );
    return result.rows.map((r) => BankingAggregator._redactConnection(BankingAggregator._withEnvCredentials(r)));
  }

  static async getConnection(id) {
    const row = await BankingAggregator._getConnectionRaw(id);
    return row ? BankingAggregator._redactConnection(row) : null;
  }

  /** Internal: full (unredacted) row for connector use — never returned by the API. */
  static async _getConnectionRaw(id) {
    await BankingAggregator.ensureTables();
    const result = await pool.query(
      'SELECT * FROM banking_aggregator_connections WHERE id = $1', [id]
    );
    return result.rows[0] ? BankingAggregator._withEnvCredentials(result.rows[0]) : null;
  }

  /**
   * Secret Manager -> Cloud Run env name prefix for a connection:
   * config.credentialsEnvPrefix, else AGGREGATOR_<NAME> (name upper-cased,
   * non-alphanumerics collapsed to '_').
   */
  static credentialsEnvPrefix(conn) {
    const explicit = conn && conn.config && conn.config.credentialsEnvPrefix;
    if (explicit) return String(explicit).replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
    const slug = String((conn && conn.name) || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return slug ? 'AGGREGATOR_' + slug : null;
  }

  /**
   * Project per-connection credentials from the environment onto the config
   * (config values win). Only the in-memory row is touched; the stored config
   * never receives the values, so the API cannot echo them back.
   */
  static _withEnvCredentials(row) {
    if (!row) return row;
    const prefix = BankingAggregator.credentialsEnvPrefix(row);
    if (!prefix) return row;
    const config = Object.assign({}, row.config && typeof row.config === 'object' ? row.config : {});
    let touched = false;
    for (const [suffix, key] of Object.entries(ENV_CREDENTIAL_KEYS)) {
      const v = process.env[prefix + suffix];
      if (v && (config[key] == null || config[key] === '')) { config[key] = v; touched = true; }
    }
    return touched ? Object.assign({}, row, { config }) : row;
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

    if (config.mode !== undefined && !MODES.includes(config.mode)) {
      throw new Error('config.mode must be live or shadow');
    }

    await pool.query(
      `INSERT INTO banking_aggregator_connections (id, name, connector_type, direction, config, active)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [id, name, connectorType, direction, JSON.stringify(config), opts.active !== false]
    );
    await BankingAggregator._autoHandshake(id);
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
    let configChanged = false;
    if (opts.config !== undefined && typeof opts.config === 'object') {
      // Merge: new config keys overwrite existing; preserves secrets not re-sent.
      const merged = Object.assign({}, existing.config || {}, opts.config);
      if (merged.mode !== undefined && !MODES.includes(merged.mode)) {
        throw new Error('config.mode must be live or shadow');
      }
      configChanged = JSON.stringify(merged) !== JSON.stringify(existing.config || {});
      sets.push(`config = $${idx++}::jsonb`); params.push(JSON.stringify(merged));
      if (configChanged) {
        // Credentials/endpoints may have changed: the previous verification no
        // longer proves anything, so the connection must re-handshake.
        sets.push(`handshake_state = 'pending'`, `handshake_at = NULL`, `external_connection_id = NULL`,
          `handshake_meta = '{}'::jsonb`);
      }
    }

    if (sets.length === 0) return BankingAggregator.getConnection(id);
    sets.push(`updated_at = NOW()`);
    params.push(id);
    await pool.query(
      `UPDATE banking_aggregator_connections SET ${sets.join(', ')} WHERE id = $${idx}`,
      params
    );
    if (configChanged) await BankingAggregator._autoHandshake(id);
    return BankingAggregator.getConnection(id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HANDSHAKE — connection registration / capability negotiation
  // ═══════════════════════════════════════════════════════════════════════════

  static _connectorHasHandshake(connector) {
    return Boolean(connector) && typeof connector.handshake === 'function';
  }

  static _modeOf(conn) {
    const m = conn && conn.config && conn.config.mode;
    return MODES.includes(m) ? m : defaultMode();
  }

  /** Run the handshake automatically unless the connection opts out. Never throws. */
  static async _autoHandshake(id) {
    const conn = await BankingAggregator._getConnectionRaw(id);
    if (!conn) return null;
    let connector;
    try { connector = getConnector(conn.connector_type); } catch (e) { return null; }
    if (!BankingAggregator._connectorHasHandshake(connector)) return null;
    if (conn.config && conn.config.autoHandshake === false) return null;
    try {
      return await BankingAggregator.handshake(id);
    } catch (e) {
      return { state: 'failed', error: e.message };
    }
  }

  /**
   * One-time account-linking bootstrap for data aggregators whose bank link is
   * established interactively (Orange Rails → Quiltt Connector widget). The
   * connector returns a short-lived widget session token; nothing about the
   * bank login is persisted here.
   */
  static async createLinkToken(id, opts) {
    const conn = await BankingAggregator._getConnectionRaw(id);
    if (!conn) throw httpError('Connection not found: ' + id, 404);
    const connector = getConnector(conn.connector_type);
    if (typeof connector.createLinkToken !== 'function') {
      throw httpError(`Connector "${conn.connector_type}" does not support account linking`, 400);
    }
    const result = await connector.createLinkToken(conn, opts || {});
    await BankingAggregator._logEvent(id, 'outbound', 'link_token', { env: result.env || null }, 'processed', null);
    return result;
  }

  /** Post-widget check: does the provider now hold a linked bank connection? */
  static async linkStatus(id) {
    const conn = await BankingAggregator._getConnectionRaw(id);
    if (!conn) throw httpError('Connection not found: ' + id, 404);
    const connector = getConnector(conn.connector_type);
    if (typeof connector.linkStatus !== 'function') {
      throw httpError(`Connector "${conn.connector_type}" does not support account linking`, 400);
    }
    const result = await connector.linkStatus(conn, { timeoutMs: handshakeTimeoutMs() });
    await BankingAggregator._logEvent(id, 'inbound', 'link_status', { linked: !!result.linked }, 'processed', null);
    return Object.assign({
      next: result.linked
        ? 'POST /connections/:id/handshake to verify, then pull.'
        : 'Complete the bank link in the widget (POST /connections/:id/link-token), then re-check.',
    }, result);
  }

  /**
   * Initiate (or retry) the handshake for a connection. Transitions
   * pending|failed|verified → challenged → verified|failed. Returns the
   * handshake view (see getHandshake).
   */
  static async handshake(id) {
    const conn = await BankingAggregator._getConnectionRaw(id);
    if (!conn) throw httpError('Connection not found: ' + id, 404);
    const connector = getConnector(conn.connector_type);
    if (!BankingAggregator._connectorHasHandshake(connector)) {
      throw httpError(`Connector "${conn.connector_type}" does not support a handshake`, 400);
    }

    const startedAt = new Date().toISOString();
    await pool.query(
      `UPDATE banking_aggregator_connections
          SET handshake_state = 'challenged', handshake_at = NOW(),
              handshake_meta = handshake_meta || $2::jsonb, updated_at = NOW()
        WHERE id = $1`,
      [id, JSON.stringify({ challengedAt: startedAt })]
    );

    const timeoutMs = handshakeTimeoutMs();
    let timer;
    let result;
    try {
      result = await Promise.race([
        connector.handshake(conn, { timeoutMs }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Handshake timed out after ${timeoutMs}ms`)), timeoutMs);
          if (timer.unref) timer.unref();
        }),
      ]);
      if (!result || !result.externalConnectionId) {
        throw new Error('Connector handshake returned no externalConnectionId');
      }
    } catch (err) {
      clearTimeout(timer);
      const meta = { challengedAt: startedAt, failedAt: new Date().toISOString(), error: err.message };
      await pool.query(
        `UPDATE banking_aggregator_connections
            SET handshake_state = 'failed', handshake_at = NOW(), external_connection_id = NULL,
                handshake_meta = $2::jsonb, updated_at = NOW()
          WHERE id = $1`,
        [id, JSON.stringify(meta)]
      );
      await BankingAggregator._logEvent(id, 'outbound', 'handshake', { state: 'failed' }, 'failed', err.message);
      return BankingAggregator.getHandshake(id);
    }
    clearTimeout(timer);

    const capabilities = BankingAggregator._normalizeCapabilities(result.capabilities);
    const meta = Object.assign({}, result.meta || {}, {
      challengedAt: startedAt,
      verifiedAt: new Date().toISOString(),
      capabilities,
      connector: conn.connector_type,
    });
    await pool.query(
      `UPDATE banking_aggregator_connections
          SET handshake_state = 'verified', handshake_at = NOW(), external_connection_id = $2,
              handshake_meta = $3::jsonb, updated_at = NOW()
        WHERE id = $1`,
      [id, String(result.externalConnectionId), JSON.stringify(meta)]
    );
    await BankingAggregator._logEvent(id, 'outbound', 'handshake',
      { state: 'verified', capabilities }, 'processed', null, String(result.externalConnectionId));
    return BankingAggregator.getHandshake(id);
  }

  /** Handshake state + negotiated capabilities for a connection (no secrets). */
  static async getHandshake(id) {
    const conn = await BankingAggregator._getConnectionRaw(id);
    if (!conn) throw httpError('Connection not found: ' + id, 404);
    let supported = false;
    try { supported = BankingAggregator._connectorHasHandshake(getConnector(conn.connector_type)); } catch (e) { supported = false; }
    const meta = conn.handshake_meta && typeof conn.handshake_meta === 'object' ? conn.handshake_meta : {};
    return {
      connection_id: conn.id,
      connector_type: conn.connector_type,
      handshake_supported: supported,
      handshake_required: supported,
      handshake_state: conn.handshake_state || 'pending',
      handshake_at: conn.handshake_at || null,
      external_connection_id: conn.external_connection_id || null,
      capabilities: meta.capabilities || null,
      mode: BankingAggregator._modeOf(conn),
      error: meta.error || null,
      meta,
    };
  }

  static _normalizeCapabilities(caps) {
    const out = { pull: false, push: false, webhook: false };
    if (Array.isArray(caps)) {
      for (const c of caps) if (c in out) out[c] = true;
    } else if (caps && typeof caps === 'object') {
      for (const k of Object.keys(out)) out[k] = caps[k] === true || caps[k] === 'true';
    }
    return out;
  }

  /**
   * Fail-closed gate applied before any data exchange: a connector that
   * declares a handshake must have a verified connection, and the negotiated
   * capability for the requested operation must be present.
   */
  static _assertHandshake(conn, connector, capability) {
    if (!BankingAggregator._connectorHasHandshake(connector)) return;
    if (conn.handshake_state !== 'verified') {
      throw httpError(`Connection ${conn.id} handshake_state is ${conn.handshake_state || 'pending'}; ${capability} refused until the handshake is verified (POST /api/aggregator/connections/${conn.id}/handshake)`, 409);
    }
    const caps = conn.handshake_meta && conn.handshake_meta.capabilities;
    if (caps && caps[capability] === false) {
      throw httpError(`Connection ${conn.id} did not negotiate the ${capability} capability during its handshake`, 409);
    }
  }

  static async deleteConnection(id) {
    await BankingAggregator.ensureTables();
    const result = await pool.query(
      'DELETE FROM banking_aggregator_connections WHERE id = $1 RETURNING id', [id]
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
    BankingAggregator._assertHandshake(conn, connector, 'pull');
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

    await pool.query('UPDATE banking_aggregator_connections SET last_pull_at = NOW() WHERE id = $1', [id]);
    await BankingAggregator._logEvent(id, 'inbound', 'pull', summary,
      summary.errors.length ? 'failed' : 'processed', summary.errors.length ? summary.errors[0].error : null);
    return summary;
  }

  static async _upsertAccount(connectionId, a) {
    const acctId = 'ACCT-' + connectionId + '-' + a.externalAccountId;
    await pool.query(
      `INSERT INTO banking_aggregator_accounts
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
      `INSERT INTO banking_aggregator_transactions
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
      `INSERT INTO banking_aggregator_statements
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
   *
   * Fail-closed, mirroring BankSettlementEngine.clearAndSettle: in live mode
   * the payload must carry approvalRef (maker/checker record) and screeningRef
   * (PaymentComplianceGate screening id) or the push is refused with 409. In
   * shadow mode (the default) the event is journaled and the provider is never
   * called.
   *
   * @param {string} id connection id
   * @param {Object} payload { type, approvalRef, screeningRef, ...data }
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
    BankingAggregator._assertHandshake(conn, connector, 'push');

    const body = payload || {};
    const eventType = body.type || 'push';
    const mode = BankingAggregator._modeOf(conn);
    const approvalRef = body.approvalRef || null;
    const screeningRef = body.screeningRef || null;

    if (mode === 'shadow') {
      const eventId = await BankingAggregator._logEvent(id, 'outbound', eventType,
        { type: eventType, mode: 'shadow', approvalRef, screeningRef, payload: BankingAggregator._redactPayload(body) },
        'processed', null);
      return { ok: true, mode: 'shadow', shadow: true, eventId, providerRef: null,
        note: 'shadow mode: recorded in banking_aggregator_events, provider not called (set config.mode=live to transmit)' };
    }

    if (!approvalRef) throw httpError('approvalRef (maker/checker record) is required for a live aggregator push', 409);
    if (!screeningRef) throw httpError('screeningRef (compliance screening id) is required for a live aggregator push', 409);

    let result;
    try {
      result = await connector.push(conn, body);
    } catch (err) {
      await BankingAggregator._logEvent(id, 'outbound', eventType,
        { type: eventType, mode: 'live', approvalRef, screeningRef }, 'failed', err.message);
      throw err;
    }

    await pool.query('UPDATE banking_aggregator_connections SET last_push_at = NOW() WHERE id = $1', [id]);
    await BankingAggregator._logEvent(id, 'outbound', eventType,
      { type: eventType, mode: 'live', approvalRef, screeningRef, providerRef: result && result.providerRef },
      'sent', null, result && result.providerRef);
    return Object.assign({ mode: 'live', shadow: false }, result);
  }

  /** Strip secret-looking keys from a push payload before journaling it. */
  static _redactPayload(body) {
    const out = {};
    for (const [k, v] of Object.entries(body || {})) {
      if (SECRET_CONFIG_KEYS.includes(k)) continue;
      out[k] = v;
    }
    return out;
  }

  /**
   * Pull the status of a previously transmitted payment file (connectors that
   * support file exchange). Returns the connector's status shape.
   */
  static async pullFileStatus(id, opts) {
    const conn = await BankingAggregator._getConnectionRaw(id);
    if (!conn) throw new Error('Connection not found: ' + id);
    const connector = getConnector(conn.connector_type);
    if (typeof connector.pullFileStatus !== 'function') {
      throw new Error(`Connector "${conn.connector_type}" does not support file status`);
    }
    BankingAggregator._assertHandshake(conn, connector, 'pull');
    const result = await connector.pullFileStatus(conn, opts || {});
    await BankingAggregator._logEvent(id, 'inbound', 'file_status',
      { submissionId: opts && opts.submissionId, status: result && result.status }, 'processed', null);
    return result;
  }

  /**
   * Pull ACH returns / ACK-NACK records so the app can reconcile which
   * originated credits were accepted vs. returned (R01/R02/…).
   */
  static async pullReturns(id, opts) {
    const conn = await BankingAggregator._getConnectionRaw(id);
    if (!conn) throw new Error('Connection not found: ' + id);
    if (conn.direction === 'outbound') throw new Error('Connection is outbound-only: ' + id);
    const connector = getConnector(conn.connector_type);
    if (typeof connector.pullReturns !== 'function') {
      throw new Error(`Connector "${conn.connector_type}" does not support returns`);
    }
    BankingAggregator._assertHandshake(conn, connector, 'pull');
    let returns;
    try {
      returns = await connector.pullReturns(conn, opts || {});
    } catch (err) {
      await BankingAggregator._logEvent(id, 'inbound', 'returns', { count: 0 }, 'failed', err.message);
      throw err;
    }
    await pool.query('UPDATE banking_aggregator_connections SET last_pull_at = NOW() WHERE id = $1', [id]);
    await BankingAggregator._logEvent(id, 'inbound', 'returns', { count: returns.length }, 'processed', null);
    return returns;
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
        await pool.query(`UPDATE banking_aggregator_events SET status = 'processed' WHERE id = $1`, [eventId]);
      } catch (err) {
        await pool.query(`UPDATE banking_aggregator_events SET status = 'failed', error = $2 WHERE id = $1`,
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
      `SELECT * FROM banking_aggregator_accounts ${clause} ORDER BY updated_at DESC`, params);
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
      `SELECT * FROM banking_aggregator_transactions ${clause} ORDER BY posted_date DESC NULLS LAST, created_at DESC LIMIT ${limit}`,
      params);
    return result.rows;
  }

  static async listStatements(connectionId) {
    await BankingAggregator.ensureTables();
    const clause = connectionId ? 'WHERE connection_id = $1' : '';
    const params = connectionId ? [connectionId] : [];
    const result = await pool.query(
      `SELECT * FROM banking_aggregator_statements ${clause} ORDER BY period_end DESC NULLS LAST, created_at DESC`, params);
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
      `SELECT * FROM banking_aggregator_events ${clause} ORDER BY created_at DESC LIMIT ${limit}`, params);
    return result.rows;
  }

  static async status() {
    await BankingAggregator.ensureTables();
    const [conns, accts, txns, evts, hs] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE active)::int AS active FROM banking_aggregator_connections'),
      pool.query('SELECT COUNT(*)::int AS n FROM banking_aggregator_accounts'),
      pool.query('SELECT COUNT(*)::int AS n FROM banking_aggregator_transactions'),
      pool.query('SELECT COUNT(*)::int AS n FROM banking_aggregator_events'),
      pool.query(`SELECT id, connector_type, handshake_state, config->>'mode' AS mode FROM banking_aggregator_connections`),
    ]);
    return {
      connectors_available: listConnectorTypes(),
      connections: conns.rows[0].n,
      connections_active: conns.rows[0].active,
      accounts: accts.rows[0].n,
      transactions: txns.rows[0].n,
      events: evts.rows[0].n,
      default_mode: defaultMode(),
      handshake: BankingAggregator._handshakeSummary(hs.rows),
    };
  }

  /** Aggregate handshake / mode counts over connection rows. */
  static _handshakeSummary(rows) {
    const byState = { pending: 0, challenged: 0, verified: 0, failed: 0 };
    const byMode = { live: 0, shadow: 0 };
    let required = 0;
    for (const r of rows) {
      let supported = false;
      try { supported = BankingAggregator._connectorHasHandshake(getConnector(r.connector_type)); } catch (e) { supported = false; }
      if (supported) required++;
      const st = HANDSHAKE_STATES.includes(r.handshake_state) ? r.handshake_state : 'pending';
      byState[st]++;
      byMode[MODES.includes(r.mode) ? r.mode : defaultMode()]++;
    }
    return {
      handshake_required: required,
      verified: byState.verified,
      by_state: byState,
      by_mode: byMode,
      timeout_ms: handshakeTimeoutMs(),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  static async _logEvent(connectionId, direction, eventType, payload, status, error, providerRef) {
    const id = 'EVT-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    await pool.query(
      `INSERT INTO banking_aggregator_events (id, connection_id, direction, event_type, payload, status, error, provider_ref)
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
      mode: BankingAggregator._modeOf(row),
      config: safeConfig,
      credentials: Object.assign(flags, { env_prefix: BankingAggregator.credentialsEnvPrefix(row) }),
      handshake_state: row.handshake_state || 'pending',
      handshake_at: row.handshake_at || null,
      external_connection_id: row.external_connection_id || null,
      capabilities: (row.handshake_meta && row.handshake_meta.capabilities) || null,
      last_pull_at: row.last_pull_at,
      last_push_at: row.last_push_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

module.exports = { BankingAggregator, SECRET_CONFIG_KEYS, HANDSHAKE_STATES, MODES, ENV_CREDENTIAL_KEYS };
