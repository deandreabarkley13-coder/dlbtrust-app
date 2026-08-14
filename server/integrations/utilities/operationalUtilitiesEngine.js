'use strict';

/**
 * Operational Utilities Engine — Live system orchestration and cross-module status.
 *
 * Provides a unified operational layer that can query every major subsystem,
 * trigger background utilities (backup, sync, reconciliation, coupon runs),
 * and run a scheduler that keeps the platform healthy without operator
 * intervention. Money-moving utilities are opt-in and flagged dangerous.
 */

const pool = require('../bonds/pgPool');
const journal = require('../backup/transactionJournal');

const TABLES_SQL = `
CREATE TABLE IF NOT EXISTS operational_utility_runs (
  id SERIAL PRIMARY KEY,
  run_id TEXT UNIQUE NOT NULL,
  utility TEXT NOT NULL,
  status TEXT NOT NULL,
  result JSONB,
  initiated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS operational_utility_schedule (
  utility TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  interval_ms BIGINT NOT NULL DEFAULT 3600000,
  last_run_at TIMESTAMPTZ
);
`;

const DEFAULT_SCHEDULE = [
  { utility: 'health_check', enabled: true, interval_ms: 5 * 60 * 1000 },
  { utility: 'aggregate_sync', enabled: true, interval_ms: 15 * 60 * 1000 },
  { utility: 'reconcile_all', enabled: true, interval_ms: 60 * 60 * 1000 },
];

let _schedulerInterval = null;
let _running = new Set();

function safeRequire(relPath) {
  try { return require(relPath); } catch (e) { return null; }
}

function nowMs() {
  return Number(process.env.OPERATIONAL_UTILITIES_INTERVAL_MS || 15 * 60 * 1000);
}

class OperationalUtilitiesEngine {
  static id(prefix = 'OPU') {
    return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  }

  static async ensureTables() {
    await pool.query(TABLES_SQL);
    for (const row of DEFAULT_SCHEDULE) {
      await pool.query(
        'INSERT INTO operational_utility_schedule (utility, enabled, interval_ms) VALUES ($1, $2, $3) ' +
        'ON CONFLICT (utility) DO NOTHING',
        [row.utility, row.enabled, row.interval_ms]
      );
    }
  }

  static async recordRun(utility, status, result, initiatedBy) {
    const runId = OperationalUtilitiesEngine.id();
    try {
      await pool.query(
        'INSERT INTO operational_utility_runs (run_id, utility, status, result, initiated_by, completed_at) ' +
        'VALUES ($1, $2, $3, $4, $5, NOW())',
        [runId, utility, status, JSON.stringify(result), initiatedBy || 'system']
      );
    } catch (e) {
      console.warn('[operational-utilities] failed to record run:', e.message);
    }
    try { journal.record('utility_run', { utility, status, runId }, initiatedBy || 'system'); } catch (_) {}
    return runId;
  }

  static async listRuns(limit = 50) {
    const res = await pool.query(
      'SELECT * FROM operational_utility_runs ORDER BY created_at DESC LIMIT $1',
      [Math.min(Number(limit) || 50, 500)]
    );
    return res.rows;
  }

  static async getSchedule() {
    const res = await pool.query('SELECT * FROM operational_utility_schedule ORDER BY utility');
    return res.rows;
  }

  static async updateSchedule(utility, fields) {
    const res = await pool.query(
      'UPDATE operational_utility_schedule SET enabled = $2, interval_ms = $3, last_run_at = COALESCE($4, last_run_at) ' +
      'WHERE utility = $1 RETURNING *',
      [utility, fields.enabled, fields.interval_ms, fields.last_run_at || null]
    );
    return res.rows[0];
  }

  static async getHealthSnapshot() {
    const checks = { database: { ok: false }, bonds: {}, cashAccounts: {}, trustAccounts: {}, authUsers: {} };
    try {
      const [bondRes, cashRes, trustRes, userRes] = await Promise.all([
        pool.query("SELECT COUNT(*) as c, COALESCE(SUM(face_value),0) as total FROM bonds WHERE status = 'active'"),
        pool.query("SELECT COUNT(*) as c FROM cash_accounts WHERE status = 'active'"),
        pool.query('SELECT COUNT(*) as c FROM trust_accounts'),
        pool.query('SELECT COUNT(*) as c FROM auth_users'),
      ]);
      checks.database = { ok: true };
      checks.bonds = { ok: parseInt(bondRes.rows[0].c) > 0, count: parseInt(bondRes.rows[0].c), totalValue: Number(bondRes.rows[0].total) };
      checks.cashAccounts = { ok: parseInt(cashRes.rows[0].c) > 0, count: parseInt(cashRes.rows[0].c) };
      checks.trustAccounts = { ok: parseInt(trustRes.rows[0].c) > 0, count: parseInt(trustRes.rows[0].c) };
      checks.authUsers = { ok: parseInt(userRes.rows[0].c) > 0, count: parseInt(userRes.rows[0].c) };
    } catch (e) {
      checks.database = { ok: false, error: e.message };
    }

    try {
      const fineract = safeRequire('../fineract/fineractClient');
      if (fineract && fineract.FineractClient) {
        await fineract.FineractClient.healthCheck();
        checks.fineract = { ok: true };
      } else {
        checks.fineract = { ok: false, reason: 'module unavailable' };
      }
    } catch (e) {
      checks.fineract = { ok: false, error: e.message };
    }

    const coreOk = checks.database.ok && checks.bonds.ok && checks.cashAccounts.ok && checks.trustAccounts.ok && checks.authUsers.ok;
    return { status: coreOk ? 'healthy' : 'degraded', uptime: process.uptime(), startedAt: global.__dlb_startup || new Date().toISOString(), checks };
  }

  static async getModuleStatus() {
    const modules = {};

    const jobs = [
      {
        name: 'bill',
        fn: async () => {
          const m = safeRequire('../bill/billClient');
          if (!m) return { ok: false, reason: 'module unavailable' };
          const configured = typeof m.isConfigured === 'function' ? m.isConfigured() : false;
          if (!configured) return { ok: false, configured: false };
          const status = await m.getStatus();
          return { ok: Boolean(status.connected), configured: true, status };
        }
      },
      {
        name: 'stablecoin',
        fn: async () => {
          const m = safeRequire('../stablecoin/stablecoinGateway');
          if (!m || !m.StablecoinGateway) return { ok: false, reason: 'module unavailable' };
          const r = await m.StablecoinGateway.readiness({ publicHealth: true });
          return { ok: Boolean(r.ready), ...r };
        }
      },
      {
        name: 'paymentHub',
        fn: async () => {
          const m = safeRequire('../paymentHub/paymentHubEngine');
          if (!m || !m.PaymentHubEngine) return { ok: false, reason: 'module unavailable' };
          const d = await m.PaymentHubEngine.dashboard();
          return { ok: true, ...d };
        }
      },
      {
        name: 'dapp',
        fn: async () => {
          const m = safeRequire('../dapp/dappEngine');
          if (!m || !m.DappEngine) return { ok: false, reason: 'module unavailable' };
          const rows = await m.DappEngine.listSourceBalances();
          return { ok: rows.length > 0, sourceCount: rows.length, sources: rows.slice(0, 10) };
        }
      },
      {
        name: 'aggregator',
        fn: async () => {
          const m = safeRequire('../aggregator/bankingAggregator');
          if (!m || !m.BankingAggregator) return { ok: false, reason: 'module unavailable' };
          const rows = await m.BankingAggregator.listConnections();
          return { ok: true, connections: rows.length };
        }
      },
      {
        name: 'cash',
        fn: async () => {
          const m = safeRequire('../cash/cashEngine');
          if (!m || !m.CashEngine) return { ok: false, reason: 'module unavailable' };
          const rows = await m.CashEngine.listAccounts();
          return { ok: rows.length > 0, accounts: rows.length };
        }
      },
      {
        name: 'crm',
        fn: async () => {
          const m = safeRequire('../crm/crmEngine');
          if (!m || !m.CrmEngine) return { ok: false, reason: 'module unavailable' };
          const d = await m.CrmEngine.getDashboard();
          return { ok: true, ...d };
        }
      },
      {
        name: 'corporateTreasury',
        fn: async () => {
          const m = safeRequire('../finops/corporateTreasuryEngine');
          if (!m || !m.CorporateTreasuryEngine) return { ok: false, reason: 'module unavailable' };
          const d = await m.CorporateTreasuryEngine.getDashboard();
          return { ok: true, ...d };
        }
      },
      {
        name: 'treasuryPrime',
        fn: async () => {
          const m = safeRequire('../treasuryprime/treasuryPrimeEngine');
          if (!m || !m.TreasuryPrimeEngine) return { ok: false, reason: 'module unavailable' };
          const s = await m.TreasuryPrimeEngine.getStatus();
          return { ok: Boolean(s.connected || s.configured), ...s };
        }
      },
      {
        name: 'bonds',
        fn: async () => {
          const m = safeRequire('../bonds/liveEngine');
          if (!m || !m.LiveBondEngine) return { ok: false, reason: 'module unavailable' };
          const s = await m.LiveBondEngine.getPortfolioSnapshot();
          return { ok: true, ...s };
        }
      },
      {
        name: 'tax',
        fn: async () => {
          const m = safeRequire('../tax/taxEngine');
          if (!m || !m.TaxEngine) return { ok: false, reason: 'module unavailable' };
          const d = await m.TaxEngine.getDashboard();
          return { ok: true, ...d };
        }
      },
      {
        name: 'electronicSettlement',
        fn: async () => {
          const m = safeRequire('../payments/electronicSettlementEngine');
          if (!m || typeof m.getDashboard !== 'function') return { ok: false, reason: 'module unavailable' };
          const d = await m.getDashboard();
          return { ok: true, ...d };
        }
      },
    ];

    await Promise.all(jobs.map(async (job) => {
      try {
        const data = await job.fn();
        modules[job.name] = data.ok === undefined ? { ok: true, ...data } : data;
      } catch (e) {
        modules[job.name] = { ok: false, error: e.message };
      }
    }));

    return modules;
  }

  static async getLiveStatus() {
    const [health, modules, runs, schedule] = await Promise.all([
      OperationalUtilitiesEngine.getHealthSnapshot(),
      OperationalUtilitiesEngine.getModuleStatus().catch(err => ({ error: err.message })),
      OperationalUtilitiesEngine.listRuns(10).catch(() => []),
      OperationalUtilitiesEngine.getSchedule().catch(() => []),
    ]);
    return { timestamp: new Date().toISOString(), health, modules, recentRuns: runs, schedule };
  }

  static async runUtility(name, opts = {}, initiatedBy) {
    if (_running.has(name)) return { skipped: true, reason: name + ' already running' };
    _running.add(name);
    let result;
    let status = 'completed';

    try {
      switch (name) {
        case 'health_check':
          result = await OperationalUtilitiesEngine.getHealthSnapshot();
          break;
        case 'module_status':
          result = await OperationalUtilitiesEngine.getModuleStatus();
          break;
        case 'backup_full':
          result = await OperationalUtilitiesEngine._runBackup();
          break;
        case 'export_system':
          result = await OperationalUtilitiesEngine._runExport();
          break;
        case 'aggregate_sync':
          result = await OperationalUtilitiesEngine._runAggregateSync();
          break;
        case 'sweep':
          result = await OperationalUtilitiesEngine._runSweep(opts);
          break;
        case 'reconcile_all':
          result = await OperationalUtilitiesEngine._runReconcile();
          break;
        case 'bond_accrual':
          result = await OperationalUtilitiesEngine._runBondAccrual();
          break;
        case 'coupon_payout':
          result = await OperationalUtilitiesEngine._runCouponPayout();
          break;
        default:
          throw new Error('Unknown utility: ' + name + '. Supported: health_check, module_status, backup_full, export_system, aggregate_sync, sweep, reconcile_all, bond_accrual, coupon_payout');
      }
    } catch (e) {
      status = 'failed';
      result = { error: e.message };
    } finally {
      _running.delete(name);
    }

    await OperationalUtilitiesEngine.recordRun(name, status, result, initiatedBy);
    return { utility: name, status, result, timestamp: new Date().toISOString() };
  }

  static async runAll(opts = {}, initiatedBy) {
    const utilities = ['health_check', 'module_status', 'backup_full', 'aggregate_sync', 'reconcile_all'];
    if (opts.includeDangerous) {
      utilities.push('sweep', 'bond_accrual', 'coupon_payout');
    }
    const results = {};
    await Promise.all(utilities.map(async (name) => {
      results[name] = await OperationalUtilitiesEngine.runUtility(name, opts, initiatedBy);
    }));
    return { timestamp: new Date().toISOString(), includeDangerous: Boolean(opts.includeDangerous), results };
  }

  static async startScheduler(intervalMs) {
    OperationalUtilitiesEngine.stopScheduler();
    if (String(process.env.OPERATIONAL_UTILITIES_AUTO_RUN).toLowerCase() === 'false') {
      console.log('[operational-utilities] scheduler disabled (OPERATIONAL_UTILITIES_AUTO_RUN=false)');
      return;
    }
    const interval = Number(intervalMs) > 0 ? Number(intervalMs) : nowMs();
    console.log('[operational-utilities] scheduler starting, interval=' + interval + 'ms');
    _schedulerInterval = setInterval(async () => {
      try {
        const summary = await OperationalUtilitiesEngine.runAll({}, 'scheduler');
        console.log('[operational-utilities] scheduled run complete:', Object.keys(summary.results).length, 'utilities');
      } catch (e) {
        console.warn('[operational-utilities] scheduled run failed:', e.message);
      }
    }, interval);
    if (_schedulerInterval.unref) _schedulerInterval.unref();
  }

  static stopScheduler() {
    if (_schedulerInterval) { clearInterval(_schedulerInterval); _schedulerInterval = null; }
  }

  static getSchedulerStatus() {
    return { running: _schedulerInterval !== null, intervalMs: _schedulerInterval ? nowMs() : null };
  }

  // ─── Individual utility implementations ─────────────────────────────────────

  static async _runBackup() {
    const backup = safeRequire('../backup/backupEngine');
    if (!backup || typeof backup.runFullBackup !== 'function') throw new Error('backup engine unavailable');
    return await backup.runFullBackup();
  }

  static async _runExport() {
    const backup = safeRequire('../backup/backupEngine');
    if (!backup || typeof backup.exportSystemState !== 'function') throw new Error('backup engine unavailable');
    return await backup.exportSystemState();
  }

  static async _runAggregateSync() {
    const scheduler = safeRequire('../aggregator/aggregatorScheduler');
    if (!scheduler || typeof scheduler.runOnce !== 'function') throw new Error('aggregator scheduler unavailable');
    return await scheduler.runOnce();
  }

  static async _runSweep(opts) {
    const sweep = safeRequire('../payments/trustSweepScheduler');
    if (!sweep || typeof sweep.runOnce !== 'function') throw new Error('sweep scheduler unavailable');
    return await sweep.runOnce({ force: true, initiated_by: 'operational-utilities', ...opts });
  }

  static async _runReconcile() {
    const dataBridge = safeRequire('../accounting/dataBridge');
    if (!dataBridge || !dataBridge.DataBridge) throw new Error('data bridge unavailable');
    const fullSync = await dataBridge.DataBridge.runFullSync();
    const report = await dataBridge.DataBridge.getReconciliationReport();
    return { fullSync, report };
  }

  static async _runBondAccrual() {
    const bondEngine = safeRequire('../bonds/bondEngine');
    if (!bondEngine || !bondEngine.BondEngine) throw new Error('bond engine unavailable');
    const res = await pool.query("SELECT id, bond_name FROM bonds WHERE status = 'active'");
    const results = [];
    for (const row of res.rows) {
      try {
        const r = await bondEngine.BondEngine.accrueInterest(row.id, new Date(), {});
        results.push({ bondId: row.id, bondName: row.bond_name, status: 'ok', ...r });
      } catch (e) {
        results.push({ bondId: row.id, bondName: row.bond_name, status: 'error', error: e.message });
      }
    }
    return { bondsChecked: res.rows.length, results };
  }

  static async _runCouponPayout() {
    const coupon = safeRequire('../bonds/couponService');
    if (!coupon || !coupon.CouponService) throw new Error('coupon service unavailable');
    return await coupon.CouponService.checkAndPayDueCoupons();
  }
}

module.exports = { OperationalUtilitiesEngine };
