'use strict';

/**
 * Aggregator auto-sync scheduler — the "no human intervention" loop.
 *
 * On a fixed interval it:
 *   1. Pulls fresh accounts/transactions/statements from every active inbound
 *      (or bidirectional) connection, authenticating automatically (e.g. via
 *      the connector's OAuth2 client-credentials flow — no operator involved).
 *   2. Auto-posts the newly pulled external transactions to the trust GL and
 *      pushes them onward to Fineract (DataBridge.syncAggregatorToAccounting +
 *      pushToFineract), so two systems keep exchanging financial data hands-off.
 *
 * Safety:
 *   - Disabled by setting AGGREGATOR_AUTO_SYNC=false.
 *   - Overlapping runs are prevented with an in-flight guard.
 *   - Individual connection failures are logged and never abort the batch.
 *   - Pushing money out is NOT automated here; only inbound pulls + GL posting
 *     run on the timer. Outbound rail payments remain explicit push calls.
 */

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_START_DELAY_MS = 30 * 1000;   // first run 30s after startup

let _interval = null;
let _running = false;

function isEnabled() {
  return String(process.env.AGGREGATOR_AUTO_SYNC || 'true').toLowerCase() !== 'false';
}

function resolveInterval(intervalMs) {
  if (intervalMs && Number(intervalMs) > 0) return Number(intervalMs);
  const fromEnv = Number(process.env.AGGREGATOR_SYNC_INTERVAL_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_INTERVAL_MS;
}

/**
 * Run one full sync cycle. Returns a summary; safe to call manually.
 */
async function runOnce() {
  if (_running) {
    return { skipped: true, reason: 'a sync cycle is already running' };
  }
  _running = true;
  const started = Date.now();
  const summary = { connections: 0, pulled: 0, errors: [], accounting: null };

  try {
    const { BankingAggregator } = require('./bankingAggregator');
    const { DataBridge } = require('../accounting/dataBridge');

    let connections = [];
    try {
      connections = await BankingAggregator.listConnections();
    } catch (e) {
      summary.errors.push({ phase: 'list', error: e.message });
      connections = [];
    }

    for (const conn of connections) {
      if (!conn.active) continue;
      if (conn.direction === 'outbound') continue; // pull only from inbound/both
      summary.connections++;
      try {
        const pull = await BankingAggregator.pull(conn.id, {});
        summary.pulled += (pull.transactions || 0);
        if (pull.errors && pull.errors.length) {
          summary.errors.push({ connectionId: conn.id, errors: pull.errors });
        }
      } catch (e) {
        summary.errors.push({ connectionId: conn.id, error: e.message });
      }
    }

    // Auto-post pulled external transactions to the GL and push to Fineract.
    try {
      const acct = await DataBridge.syncAggregatorToAccounting();
      let fineract = null;
      try { fineract = await DataBridge.pushToFineract(); }
      catch (e) { fineract = { error: e.message }; }
      summary.accounting = { posted: acct.synced, failed: acct.failed, fineract };
    } catch (e) {
      summary.errors.push({ phase: 'accounting', error: e.message });
    }
  } catch (e) {
    summary.errors.push({ phase: 'fatal', error: e.message });
  } finally {
    _running = false;
  }

  summary.durationMs = Date.now() - started;
  return summary;
}

/**
 * Start the recurring auto-sync loop. No-op if disabled via env.
 */
function start(intervalMs) {
  if (!isEnabled()) {
    console.log('[aggregator-scheduler] disabled (AGGREGATOR_AUTO_SYNC=false)');
    return;
  }
  if (_interval) return; // already started
  const interval = resolveInterval(intervalMs);
  console.log('[aggregator-scheduler] auto-sync every ' + (interval / 60000).toFixed(1) + ' min');

  setTimeout(function () {
    runOnce()
      .then(function (s) { console.log('[aggregator-scheduler] initial sync:', JSON.stringify({ connections: s.connections, pulled: s.pulled, errors: s.errors.length })); })
      .catch(function (e) { console.warn('[aggregator-scheduler] initial sync failed:', e.message); });
  }, DEFAULT_START_DELAY_MS);

  _interval = setInterval(function () {
    runOnce()
      .then(function (s) { console.log('[aggregator-scheduler] sync:', JSON.stringify({ connections: s.connections, pulled: s.pulled, errors: s.errors.length })); })
      .catch(function (e) { console.warn('[aggregator-scheduler] sync failed:', e.message); });
  }, interval);

  if (_interval.unref) _interval.unref();
}

function stop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = { start, stop, runOnce };
