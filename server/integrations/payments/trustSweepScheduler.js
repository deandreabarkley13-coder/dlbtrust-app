'use strict';

/**
 * Trust cash sweep scheduler — the hands-off "fixed-income cash → bank" loop.
 *
 * On a fixed interval it moves accumulated cash out of a source GL account
 * (default main trust cash `1000`, credited by coupon/fixed-income receipts)
 * into the Eaton Family CU Trust Checking account via an on-us ACH credit
 * (`depositToTrustChecking`), booking the asset-reclass JE (DR 1010 / CR source)
 * and — when TRUST_BANK_AUTO_TRANSMIT is enabled — auto-delivering the NACHA
 * file to Eaton over SFTP. No operator involved.
 *
 * Safety:
 *   - OFF by default. Must be explicitly enabled with TRUST_SWEEP_ENABLED=true,
 *     because this scheduler moves money without a human in the loop.
 *   - Keeps TRUST_SWEEP_MIN_RESERVE in the source account.
 *   - Skips runs below TRUST_SWEEP_MIN_AMOUNT (no dust transfers) and caps each
 *     run at TRUST_SWEEP_MAX_AMOUNT when set.
 *   - Overlapping runs are prevented with an in-flight guard.
 *   - depositToTrustChecking still enforces the TRUST_BANK_ACCOUNT requirement.
 */

var pool = require('../bonds/pgPool');

var DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
var DEFAULT_START_DELAY_MS = 60 * 1000;        // first run 60s after startup
var DEFAULT_SOURCE_ACCOUNT = '1000';
var DEFAULT_MIN_AMOUNT = 0.01;

var _interval = null;
var _running = false;

function isEnabled() {
  return String(process.env.TRUST_SWEEP_ENABLED || 'false').toLowerCase() === 'true';
}

function resolveInterval(intervalMs) {
  if (intervalMs && Number(intervalMs) > 0) return Number(intervalMs);
  var fromEnv = Number(process.env.TRUST_SWEEP_INTERVAL_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_INTERVAL_MS;
}

function toNumber(value, fallback) {
  var n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Persisted sweep ledger — survives restarts so a crash/redeploy mid-window can't
 * double-sweep. Each sweep attempt claims a unique sweep_key (per source + time
 * window); a second attempt for the same window is rejected by the UNIQUE index.
 */
async function ensureSweepLedger() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS trust_sweeps (' +
    ' id SERIAL PRIMARY KEY,' +
    ' sweep_key TEXT UNIQUE NOT NULL,' +
    ' source_account_code TEXT NOT NULL,' +
    ' amount NUMERIC(18,2),' +
    ' reserve NUMERIC(18,2),' +
    ' status TEXT NOT NULL,' +
    ' settlement_id TEXT,' +
    ' ach_batch_id TEXT,' +
    ' journal_entry_id TEXT,' +
    ' error TEXT,' +
    ' initiated_by TEXT,' +
    ' created_at TIMESTAMPTZ DEFAULT NOW(),' +
    ' updated_at TIMESTAMPTZ DEFAULT NOW())'
  );
}

/**
 * Idempotency key for a sweep: an explicit override, or a bucket derived from the
 * source account and the sweep cadence so at most one sweep runs per window.
 */
function buildSweepKey(sourceAccount, windowMs, explicitKey) {
  if (explicitKey) return String(explicitKey);
  var bucket = Math.floor(Date.now() / windowMs);
  return sourceAccount + ':' + windowMs + ':' + bucket;
}

/**
 * Claim a sweep window. Returns { claimed, rowId, existing } — claimed=false when
 * another completed/in-flight sweep already owns this window (idempotent skip).
 * A previously failed attempt for the same window is allowed to retry.
 */
async function claimSweepWindow(sweepKey, sourceAccount, reserve, initiatedBy) {
  var ins = await pool.query(
    'INSERT INTO trust_sweeps (sweep_key, source_account_code, reserve, status, initiated_by)' +
    " VALUES ($1, $2, $3, 'in_progress', $4)" +
    ' ON CONFLICT (sweep_key) DO NOTHING RETURNING id',
    [sweepKey, sourceAccount, reserve, initiatedBy]
  );
  if (ins.rows.length) return { claimed: true, rowId: ins.rows[0].id };

  var existing = await pool.query(
    'SELECT id, status FROM trust_sweeps WHERE sweep_key = $1',
    [sweepKey]
  );
  var row = existing.rows[0];
  if (row && row.status === 'failed') {
    await pool.query(
      "UPDATE trust_sweeps SET status = 'in_progress', error = NULL, updated_at = NOW() WHERE id = $1",
      [row.id]
    );
    return { claimed: true, rowId: row.id, retriedFrom: 'failed' };
  }
  return { claimed: false, existing: row || null };
}

async function finalizeSweepRow(rowId, fields) {
  await pool.query(
    'UPDATE trust_sweeps SET status = $2, amount = $3, settlement_id = $4,' +
    ' ach_batch_id = $5, journal_entry_id = $6, error = $7, updated_at = NOW() WHERE id = $1',
    [rowId, fields.status, fields.amount != null ? fields.amount : null,
     fields.settlement_id || null, fields.ach_batch_id || null,
     fields.journal_entry_id || null, fields.error || null]
  );
}

/**
 * Pure sweep math: available = balance - reserve, floored at 0, capped at
 * maxAmount, rounded to cents. Kept separate from the DB read so it's testable.
 */
function computeAvailable(balance, reserve, maxAmount) {
  var available = (Number(balance) || 0) - (Number(reserve) || 0);
  if (available < 0) available = 0;
  if (maxAmount != null && available > maxAmount) available = maxAmount;
  return Math.round(available * 100) / 100;
}

/**
 * Compute how much is sweepable from the source account right now:
 *   available = balance(source) - reserve, capped at maxAmount, floored at 0.
 */
async function computeSweepAmount(sourceAccount, reserve, maxAmount) {
  var res = await pool.query(
    'SELECT balance FROM trust_accounts WHERE account_code = $1',
    [sourceAccount]
  );
  if (!res.rows.length) {
    return { available: 0, balance: null, reason: 'source account not found' };
  }
  var balance = Number(res.rows[0].balance) || 0;
  return { available: computeAvailable(balance, reserve, maxAmount), balance: balance };
}

/**
 * Run one sweep cycle. Returns a summary; safe to call manually (e.g. from a
 * route) regardless of whether the recurring loop is enabled.
 */
async function runOnce(opts) {
  opts = opts || {};
  if (_running) {
    return { skipped: true, reason: 'a sweep cycle is already running' };
  }
  _running = true;
  var started = Date.now();
  var summary = { swept: false, amount: 0 };

  try {
    var sourceAccount = opts.source_account_code || process.env.TRUST_SWEEP_SOURCE_ACCOUNT || DEFAULT_SOURCE_ACCOUNT;
    var reserve = toNumber(opts.min_reserve != null ? opts.min_reserve : process.env.TRUST_SWEEP_MIN_RESERVE, 0);
    var minAmount = toNumber(opts.min_amount != null ? opts.min_amount : process.env.TRUST_SWEEP_MIN_AMOUNT, DEFAULT_MIN_AMOUNT);
    var maxAmountRaw = opts.max_amount != null ? opts.max_amount : process.env.TRUST_SWEEP_MAX_AMOUNT;
    var maxAmount = maxAmountRaw != null && maxAmountRaw !== '' ? toNumber(maxAmountRaw, null) : null;

    var calc = await computeSweepAmount(sourceAccount, reserve, maxAmount);
    summary.source_account_code = sourceAccount;
    summary.source_balance = calc.balance;
    summary.available = calc.available;

    if (calc.reason) {
      summary.reason = calc.reason;
      return summary;
    }
    if (calc.available < minAmount) {
      summary.reason = 'available (' + calc.available + ') below minimum (' + minAmount + ')';
      return summary;
    }

    // Claim the sweep window in the persisted ledger before moving any money, so a
    // restart mid-window can't run a second sweep for the same period.
    await ensureSweepLedger();
    var initiatedBy = opts.initiated_by || 'sweep-scheduler';
    var windowMs = resolveInterval(opts.interval_ms);
    // opts.force bypasses the window guard with a unique key (manual override).
    var explicitKey = opts.force ? ('force:' + sourceAccount + ':' + Date.now()) : opts.idempotency_key;
    var sweepKey = buildSweepKey(sourceAccount, windowMs, explicitKey);
    summary.sweep_key = sweepKey;

    var claim = await claimSweepWindow(sweepKey, sourceAccount, reserve, initiatedBy);
    if (!claim.claimed) {
      summary.reason = 'sweep window already processed (idempotent skip)';
      summary.existing_status = claim.existing ? claim.existing.status : null;
      return summary;
    }

    var settlementEngine = require('./electronicSettlementEngine');
    try {
      var deposit = await settlementEngine.depositToTrustChecking({
        amount: calc.available,
        source_account_code: sourceAccount,
        description: opts.description || 'Scheduled fixed-income cash sweep to Eaton Trust Checking',
        initiated_by: initiatedBy,
        transmit: opts.transmit,
      });

      summary.swept = true;
      summary.amount = calc.available;
      summary.settlement_id = deposit.settlement_id;
      summary.ach_batch_id = deposit.ach_batch_id;
      summary.journal_entry_id = deposit.journal_entry_id;
      summary.transmission = deposit.transmission || null;

      await finalizeSweepRow(claim.rowId, {
        status: 'completed',
        amount: calc.available,
        settlement_id: deposit.settlement_id,
        ach_batch_id: deposit.ach_batch_id,
        journal_entry_id: deposit.journal_entry_id,
      });
    } catch (depErr) {
      // Mark the window failed so it can be retried on the next cycle.
      await finalizeSweepRow(claim.rowId, { status: 'failed', amount: calc.available, error: depErr.message });
      throw depErr;
    }
  } catch (e) {
    summary.error = e.message;
  } finally {
    _running = false;
    summary.durationMs = Date.now() - started;
  }

  return summary;
}

/**
 * Start the recurring sweep loop. No-op unless TRUST_SWEEP_ENABLED=true.
 */
function start(intervalMs) {
  if (!isEnabled()) {
    console.log('[trust-sweep] disabled (set TRUST_SWEEP_ENABLED=true to enable)');
    return;
  }
  if (_interval) return; // already started
  var interval = resolveInterval(intervalMs);
  console.log('[trust-sweep] auto-sweep every ' + (interval / 3600000).toFixed(2) + ' h');

  setTimeout(function () {
    runOnce()
      .then(function (s) { console.log('[trust-sweep] initial sweep:', JSON.stringify({ swept: s.swept, amount: s.amount, reason: s.reason, error: s.error })); })
      .catch(function (e) { console.warn('[trust-sweep] initial sweep failed:', e.message); });
  }, DEFAULT_START_DELAY_MS);

  _interval = setInterval(function () {
    runOnce()
      .then(function (s) { console.log('[trust-sweep] sweep:', JSON.stringify({ swept: s.swept, amount: s.amount, reason: s.reason, error: s.error })); })
      .catch(function (e) { console.warn('[trust-sweep] sweep failed:', e.message); });
  }, interval);

  if (_interval.unref) _interval.unref();
}

function stop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

/**
 * Recent sweep ledger rows (audit trail). Safe if the table doesn't exist yet.
 */
async function listSweeps(limit) {
  await ensureSweepLedger();
  var n = Number(limit) > 0 ? Math.min(Number(limit), 500) : 50;
  var res = await pool.query(
    'SELECT sweep_key, source_account_code, amount, reserve, status, settlement_id,' +
    ' ach_batch_id, journal_entry_id, error, initiated_by, created_at, updated_at' +
    ' FROM trust_sweeps ORDER BY created_at DESC LIMIT $1',
    [n]
  );
  return res.rows;
}

module.exports = {
  start: start,
  stop: stop,
  runOnce: runOnce,
  computeSweepAmount: computeSweepAmount,
  computeAvailable: computeAvailable,
  buildSweepKey: buildSweepKey,
  ensureSweepLedger: ensureSweepLedger,
  listSweeps: listSweeps,
  isEnabled: isEnabled,
};
