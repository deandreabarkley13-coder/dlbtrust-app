/**
 * Health Check Watchdog — Monitors system health and auto-recovers
 *
 * Runs as a separate PM2 process. Pings /api/health every 30 seconds.
 * If health check fails 3 consecutive times, triggers auto-restart of the API.
 *
 * Can run standalone: node server/integrations/backup/watchdog.js
 */

'use strict';

var http = require('http');
var { exec } = require('child_process');
var fs = require('fs');
var path = require('path');

var INTERVAL = parseInt(process.env.WATCHDOG_INTERVAL || '30000', 10); // 30s
var FAILURES_THRESHOLD = parseInt(process.env.WATCHDOG_FAILURES_THRESHOLD || '3', 10);
var API_PORT = parseInt(process.env.API_PORT || '3002', 10);
var LOG_FILE = path.resolve(__dirname, '../../../logs/watchdog.log');

var consecutiveFailures = 0;
var totalChecks = 0;
var totalFailures = 0;
var lastHealthy = null;
var lastRestart = null;

// Ensure logs directory
var logDir = path.dirname(LOG_FILE);
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

function log(msg) {
  var ts = new Date().toISOString();
  var line = '[' + ts + '] ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch(e) {}
}

function checkHealth() {
  totalChecks++;

  var req = http.get('http://localhost:' + API_PORT + '/api/health', { timeout: 10000 }, function(res) {
    var data = '';
    res.on('data', function(chunk) { data += chunk; });
    res.on('end', function() {
      try {
        var health = JSON.parse(data);
        if (health.status === 'healthy') {
          if (consecutiveFailures > 0) {
            log('RECOVERED after ' + consecutiveFailures + ' failure(s)');
          }
          consecutiveFailures = 0;
          lastHealthy = new Date().toISOString();
        } else {
          onFailure('Degraded: ' + (health.status || 'unknown'));
        }
      } catch (e) {
        onFailure('Invalid health response');
      }
    });
  });

  req.on('error', function(err) {
    onFailure('Connection failed: ' + err.message);
  });

  req.on('timeout', function() {
    req.destroy();
    onFailure('Health check timeout (10s)');
  });
}

function onFailure(reason) {
  consecutiveFailures++;
  totalFailures++;
  log('FAILURE #' + consecutiveFailures + '/' + FAILURES_THRESHOLD + ': ' + reason);

  if (consecutiveFailures >= FAILURES_THRESHOLD) {
    triggerRestart();
  }
}

function triggerRestart() {
  log('TRIGGERING AUTO-RESTART (consecutive failures: ' + consecutiveFailures + ')');
  lastRestart = new Date().toISOString();
  consecutiveFailures = 0;

  // Try PM2 restart (primary mechanism)
  var { execFile } = require('child_process');
  execFile('pm2', ['restart', 'dlbtrust-api'], function(err, stdout, stderr) {
    if (err) {
      log('PM2 restart failed: ' + err.message + ' — attempting fuser fallback');
      // Fallback: kill process on port and restart via node
      exec('fuser -k ' + parseInt(API_PORT, 10) + '/tcp 2>/dev/null; sleep 2; cd ' + path.resolve(__dirname, '../../..') + ' && node server/server-3002.js &', function(err2) {
        if (err2) log('Fallback restart error: ' + err2.message);
        else log('Fallback restart triggered');
      });
    } else {
      log('PM2 restart triggered successfully');
    }
  });
}

// Status endpoint for the watchdog itself
function getStatus() {
  return {
    running: true,
    interval_ms: INTERVAL,
    failures_threshold: FAILURES_THRESHOLD,
    total_checks: totalChecks,
    total_failures: totalFailures,
    consecutive_failures: consecutiveFailures,
    last_healthy: lastHealthy,
    last_restart: lastRestart,
    uptime_seconds: Math.floor(process.uptime()),
  };
}

// Start monitoring
log('Watchdog started — checking localhost:' + API_PORT + '/api/health every ' + (INTERVAL / 1000) + 's (threshold: ' + FAILURES_THRESHOLD + ' failures)');

// Wait 10s before first check (give server time to start)
setTimeout(function() {
  checkHealth();
  setInterval(checkHealth, INTERVAL);
}, 10000);

// Export for testing
module.exports = { getStatus: getStatus, checkHealth: checkHealth };
