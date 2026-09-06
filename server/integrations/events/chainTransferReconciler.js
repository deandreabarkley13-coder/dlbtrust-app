'use strict';

/**
 * Chain Transfer Reconciler
 *
 * Turns the on-demand `alchemy_getAssetTransfers` reads in
 * `DappEngine._alchemyTransfers` into durable canonical events: every confirmed
 * transfer for a watched address is written once to `canonical_event_outbox`
 * under `trust.chain.transfer.reconciled`, so confirmed on-chain value
 * auto-reconciles into the ledger pipeline instead of only being displayed.
 *
 * Read-only with respect to chains and rails: this module observes and records.
 * It never signs, broadcasts, or settles anything, and it stays a no-op until
 * an Alchemy RPC URL is configured (CHAIN_RECONCILER_ENABLED=false disables it
 * outright). Ledger posting from these events remains gated by the ordinary
 * *_LIVE / *_SHADOW flags of the downstream engines.
 */

const { KafkaEventBus } = require('./kafkaEventBus');
const { getConfig } = require('../dapp/config');

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const memorySeen = new Set();
let tablesReady = null;

function dedupeKey(transfer, address) {
  return [
    String(transfer.hash || '').toLowerCase(),
    String(transfer.direction || ''),
    String(transfer.asset || ''),
    String(address || '').toLowerCase(),
  ].join(':');
}

async function ensureTables() {
  if (!pool || !pool.query) return;
  if (tablesReady) return tablesReady;
  tablesReady = pool.query(`
    CREATE TABLE IF NOT EXISTS chain_transfer_reconciliations (
      dedupe_key   TEXT PRIMARY KEY,
      tx_hash      TEXT NOT NULL,
      address      TEXT NOT NULL,
      direction    TEXT NOT NULL,
      asset        TEXT,
      amount       TEXT,
      counterparty TEXT,
      chain_id     INTEGER,
      event_id     TEXT,
      block_time   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).then(() => pool.query(
    `CREATE INDEX IF NOT EXISTS idx_chain_transfer_recon_hash ON chain_transfer_reconciliations(tx_hash)`
  )).catch((e) => {
    tablesReady = null;
    throw e;
  });
  return tablesReady;
}

class ChainTransferReconciler {
  static config() {
    const cfg = getConfig();
    return {
      enabled: (process.env.CHAIN_RECONCILER_ENABLED || 'true') !== 'false',
      rpcUrl: cfg.rpcUrl,
      chainId: cfg.chainId,
      // Only Alchemy exposes alchemy_getAssetTransfers.
      supported: Boolean(cfg.rpcUrl && cfg.rpcUrl.includes('alchemy.com')),
      minConfirmations: Number(process.env.CHAIN_RECONCILER_MIN_CONFIRMATIONS || 1),
      maxPerRun: Number(process.env.CHAIN_RECONCILER_MAX_PER_RUN || 200),
    };
  }

  /**
   * A transfer counts as confirmed when Alchemy has assigned it a mined block
   * (asset-transfer results are only returned for mined blocks) and it carries
   * a tx hash we can reconcile against.
   */
  static isConfirmed(transfer = {}) {
    if (!transfer.hash) return false;
    if (transfer.blockNum && Number(transfer.blockNum) === 0) return false;
    return Boolean(transfer.timestamp || transfer.created_at || transfer.blockNum);
  }

  static async _alreadyReconciled(key) {
    if (memorySeen.has(key)) return true;
    if (!pool || !pool.query) return false;
    try {
      await ensureTables();
      const rows = await pool.query('SELECT 1 FROM chain_transfer_reconciliations WHERE dedupe_key = $1', [key]);
      return rows.rowCount > 0;
    } catch (e) {
      return false;
    }
  }

  static async _markReconciled(key, transfer, address, eventId) {
    memorySeen.add(key);
    if (!pool || !pool.query) return;
    try {
      await ensureTables();
      const blockTime = transfer.timestamp || transfer.created_at || null;
      await pool.query(
        `INSERT INTO chain_transfer_reconciliations
           (dedupe_key, tx_hash, address, direction, asset, amount, counterparty, chain_id, event_id, block_time)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [
          key,
          transfer.hash,
          String(address).toLowerCase(),
          transfer.direction || 'unknown',
          transfer.asset || null,
          transfer.value != null ? String(transfer.value) : null,
          (transfer.direction === 'out' ? transfer.to : transfer.from) || null,
          this.config().chainId,
          eventId || null,
          blockTime,
        ]
      );
    } catch (e) {
      console.warn('[chain-reconciler] dedupe write failed:', e.message);
    }
  }

  /**
   * Reconcile one address. Confirmed, not-yet-seen transfers are published to
   * the canonical outbox exactly once.
   */
  static async reconcileAddress(address, { transfers = null } = {}) {
    const cfg = this.config();
    const summary = {
      address, chainId: cfg.chainId, enabled: cfg.enabled, supported: cfg.supported,
      scanned: 0, reconciled: 0, skipped: 0, duplicates: 0, events: [],
    };
    if (!cfg.enabled) return { ...summary, reason: 'disabled' };
    if (!address) throw new Error('address required');

    let rows = transfers;
    if (!rows) {
      if (!cfg.supported) return { ...summary, reason: 'alchemy rpc not configured' };
      const { DappEngine } = require('../dapp/dappEngine');
      rows = await DappEngine._alchemyTransfers(cfg.rpcUrl, String(address).toLowerCase());
    }
    rows = (rows || []).slice(0, cfg.maxPerRun);
    summary.scanned = rows.length;

    for (const transfer of rows) {
      if (!this.isConfirmed(transfer)) { summary.skipped += 1; continue; }
      const key = dedupeKey(transfer, address);
      if (await this._alreadyReconciled(key)) { summary.duplicates += 1; continue; }

      const event = await KafkaEventBus.publish(
        KafkaEventBus.TOPICS.chainTransferReconciled,
        {
          reference: transfer.hash,
          txHash: transfer.hash,
          chainId: cfg.chainId,
          address: String(address).toLowerCase(),
          direction: transfer.direction || 'unknown',
          counterparty: (transfer.direction === 'out' ? transfer.to : transfer.from) || null,
          from: transfer.from || null,
          to: transfer.to || null,
          asset: transfer.asset || null,
          category: transfer.category || null,
          amount: transfer.value != null ? String(transfer.value) : null,
          blockTimestamp: transfer.timestamp || transfer.created_at || null,
          source: 'alchemy_getAssetTransfers',
          // Reconciliation is observational; ledger effects stay shadow-gated.
          mode: 'reconciliation',
        },
        { key: transfer.hash }
      );

      await this._markReconciled(key, transfer, address, event.eventId);
      summary.reconciled += 1;
      summary.events.push({ eventId: event.eventId, txHash: transfer.hash, published: event.published });
    }

    return summary;
  }

  /** Reconcile several addresses (e.g. every dApp wallet) in one pass. */
  static async reconcileAddresses(addresses = []) {
    const results = [];
    for (const address of addresses) {
      try {
        results.push(await this.reconcileAddress(address));
      } catch (e) {
        results.push({ address, error: e.message });
      }
    }
    return {
      addresses: addresses.length,
      reconciled: results.reduce((sum, r) => sum + (r.reconciled || 0), 0),
      results,
    };
  }

  static async status() {
    const cfg = this.config();
    let recorded = null;
    if (pool && pool.query) {
      try {
        await ensureTables();
        const rows = await pool.query('SELECT COUNT(*)::int AS count FROM chain_transfer_reconciliations');
        recorded = rows.rows[0].count;
      } catch (e) { recorded = null; }
    }
    return {
      enabled: cfg.enabled,
      supported: cfg.supported,
      chainId: cfg.chainId,
      topic: KafkaEventBus.TOPICS.chainTransferReconciled,
      recorded,
      bus: KafkaEventBus.status(),
      note: 'Observational reconciler: writes canonical events only, never moves value.',
    };
  }

  /** Test hook. */
  static _resetMemory() { memorySeen.clear(); }
}

module.exports = { ChainTransferReconciler };
