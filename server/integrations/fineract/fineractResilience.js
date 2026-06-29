/**
 * Fineract Resilience — Monitoring, auto-recovery, and Liquibase lock cleanup
 *
 * Features:
 * - Periodic health monitoring of Fineract Java container
 * - Liquibase lock auto-cleanup on detected stuck migrations
 * - Fly.io machine restart if Fineract is unresponsive
 * - Status reporting for dashboard/health endpoint
 */

'use strict';

var http = require('http');
var https = require('https');
var { URL } = require('url');

var FINERACT_URL = process.env.FINERACT_URL || 'https://localhost:8443/fineract-provider/api/v1';
var CHECK_INTERVAL = parseInt(process.env.FINERACT_CHECK_INTERVAL || '60000', 10); // 60s
var MAX_CONSECUTIVE_FAILURES = parseInt(process.env.FINERACT_FAILURE_THRESHOLD || '5', 10);

var state = {
  lastCheck: null,
  lastHealthy: null,
  consecutiveFailures: 0,
  totalChecks: 0,
  totalFailures: 0,
  totalRecoveries: 0,
  liquibaseLocksCleaned: 0,
  status: 'unknown', // unknown, healthy, degraded, down
};

var _monitorInterval = null;

/**
 * Check Fineract health by hitting the offices endpoint
 */
function checkFineractHealth() {
  return new Promise(function(resolve) {
    state.totalChecks++;
    state.lastCheck = new Date().toISOString();

    var url;
    try {
      url = new URL(FINERACT_URL.replace(/\/api\/v1\/?$/, '/actuator/health'));
    } catch(e) {
      // Fallback to offices endpoint
      url = new URL(FINERACT_URL + '/offices');
    }

    var options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method: 'GET',
      timeout: 15000,
      headers: {
        'Fineract-Platform-TenantId': 'default',
        'Authorization': 'Basic ' + Buffer.from('mifos:password').toString('base64'),
      },
      rejectUnauthorized: false,
    };

    var transport = url.protocol === 'https:' ? https : http;
    var req = transport.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        if (res.statusCode >= 200 && res.statusCode < 500) {
          onSuccess();
          resolve({ ok: true, statusCode: res.statusCode });
        } else {
          onFailure('HTTP ' + res.statusCode);
          resolve({ ok: false, error: 'HTTP ' + res.statusCode });
        }
      });
    });

    req.on('error', function(err) {
      onFailure(err.message);
      resolve({ ok: false, error: err.message });
    });

    req.on('timeout', function() {
      req.destroy();
      onFailure('timeout (15s)');
      resolve({ ok: false, error: 'timeout' });
    });

    req.end();
  });
}

function onSuccess() {
  if (state.consecutiveFailures > 0) {
    state.totalRecoveries++;
    console.log('[fineract-monitor] RECOVERED after ' + state.consecutiveFailures + ' failure(s)');
  }
  state.consecutiveFailures = 0;
  state.lastHealthy = new Date().toISOString();
  state.status = 'healthy';
}

function onFailure(reason) {
  state.consecutiveFailures++;
  state.totalFailures++;

  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    state.status = 'down';
    console.error('[fineract-monitor] Fineract DOWN — ' + state.consecutiveFailures + ' consecutive failures. Last: ' + reason);
    attemptRecovery();
  } else {
    state.status = 'degraded';
    console.warn('[fineract-monitor] Fineract failure #' + state.consecutiveFailures + '/' + MAX_CONSECUTIVE_FAILURES + ': ' + reason);
  }
}

/**
 * Attempt to recover Fineract by clearing Liquibase locks
 * The actual machine restart is handled by Fly.io health checks
 */
async function attemptRecovery() {
  console.log('[fineract-monitor] Attempting recovery — clearing Liquibase locks');
  try {
    await cleanLiquibaseLocks();
  } catch(e) {
    console.warn('[fineract-monitor] Lock cleanup failed:', e.message);
  }
}

/**
 * Clear stuck Liquibase changelog locks from both Fineract databases
 * This is needed when Fineract crashes during migration
 */
async function cleanLiquibaseLocks() {
  var pool;
  try {
    pool = require('../bonds/pgPool');
  } catch(e) {
    console.warn('[fineract-monitor] Cannot access pgPool:', e.message);
    return { success: false, error: e.message };
  }

  var databases = ['fineract_tenants', 'fineract_default'];
  var results = [];

  for (var i = 0; i < databases.length; i++) {
    var db = databases[i];
    try {
      // Check if databasechangeloglock table exists
      var tableCheck = await pool.query(
        "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_catalog = $1 AND table_name = 'databasechangeloglock')",
        [db]
      );

      if (!tableCheck.rows[0].exists) {
        results.push({ database: db, action: 'skipped', reason: 'no lock table' });
        continue;
      }

      // Connect to the specific database to clear locks
      var { Pool } = require('pg');
      var dbUrl = process.env.DATABASE_URL;
      if (dbUrl) {
        dbUrl = dbUrl.replace(/\/[^/?]+(\?|$)/, '/' + db + '$1');
      } else {
        dbUrl = 'postgresql://' + (process.env.FINERACT_DB_USER || 'dlbtrust_app') +
          ':' + (process.env.FINERACT_DB_PASSWORD || '') +
          '@' + (process.env.FINERACT_DB_HOST || 'localhost') +
          ':' + (process.env.FINERACT_DB_PORT || '5432') +
          '/' + db + '?sslmode=disable';
      }

      var tempPool = new Pool({ connectionString: dbUrl, ssl: false, max: 1 });
      try {
        var lockResult = await tempPool.query(
          "UPDATE databasechangeloglock SET locked = false, lockgranted = NULL, lockedby = NULL WHERE locked = true"
        );
        if (lockResult.rowCount > 0) {
          state.liquibaseLocksCleaned += lockResult.rowCount;
          console.log('[fineract-monitor] Cleared ' + lockResult.rowCount + ' Liquibase lock(s) in ' + db);
          results.push({ database: db, action: 'cleared', count: lockResult.rowCount });
        } else {
          results.push({ database: db, action: 'no_locks' });
        }
      } finally {
        await tempPool.end();
      }
    } catch(e) {
      results.push({ database: db, action: 'error', error: e.message });
    }
  }

  return { success: true, results: results };
}

/**
 * Start periodic Fineract monitoring
 */
function startMonitoring(intervalMs) {
  var interval = intervalMs || CHECK_INTERVAL;
  console.log('[fineract-monitor] Started — checking every ' + (interval / 1000) + 's (threshold: ' + MAX_CONSECUTIVE_FAILURES + ' failures)');

  // First check after 30s (give Fineract time to boot)
  setTimeout(function() {
    checkFineractHealth();
    _monitorInterval = setInterval(checkFineractHealth, interval);
  }, 30000);
}

/**
 * Stop monitoring
 */
function stopMonitoring() {
  if (_monitorInterval) {
    clearInterval(_monitorInterval);
    _monitorInterval = null;
  }
}

/**
 * Get current Fineract monitoring status
 */
function getStatus() {
  return Object.assign({}, state, { monitoring: !!_monitorInterval });
}

module.exports = {
  checkFineractHealth: checkFineractHealth,
  cleanLiquibaseLocks: cleanLiquibaseLocks,
  startMonitoring: startMonitoring,
  stopMonitoring: stopMonitoring,
  getStatus: getStatus,
};
