/**
 * Graceful Shutdown — Preserves state on process exit
 *
 * On SIGTERM/SIGINT:
 * 1. Stop accepting new requests
 * 2. Save in-flight ACH batch states
 * 3. Flush pending GL entries
 * 4. Write shutdown marker for recovery on restart
 * 5. Close DB connections
 * 6. Exit cleanly
 */

'use strict';

var os = require('os');
var path = require('path');

var stateStore = require('../cluster/jsonStateStore');

var SHUTDOWN_DOC = 'shutdown-state.json';
var INSTANCE = (process.env.HOSTNAME || os.hostname()) + ':' + process.pid;
var MARKER_HISTORY = 20;
var _server = null;
var _shutdownInProgress = false;

function registerServer(server) {
  _server = server;
}

/**
 * Markers are a shared list rather than one document per instance: with
 * replicas, whichever instance starts next reports the shutdowns nobody has
 * seen yet, instead of a marker being lost with the container that wrote it.
 */
function writeMarker(state) {
  stateStore.update(SHUTDOWN_DOC, function() { return { markers: [] }; }, function(doc) {
    if (!doc || !Array.isArray(doc.markers)) doc = { markers: [] };
    doc.markers.push(Object.assign({ instance: INSTANCE, consumed: false }, state));
    if (doc.markers.length > MARKER_HISTORY) doc.markers = doc.markers.slice(-MARKER_HISTORY);
    return doc;
  });
}

async function performGracefulShutdown(signal) {
  if (_shutdownInProgress) return;
  _shutdownInProgress = true;

  console.log('[shutdown] ' + signal + ' received — starting graceful shutdown...');
  var startTime = Date.now();

  // 1. Stop accepting new connections
  if (_server) {
    _server.close(function() {
      console.log('[shutdown] HTTP server closed');
    });
  }

  // 2. Release the leader lock first, so a surviving replica picks up the
  //    background loops now instead of waiting out the election interval.
  try {
    var leader = require(path.join(__dirname, '../cluster/leaderElection'));
    await leader.stop();
  } catch(e) {
    console.warn('[shutdown] Leader release failed:', e.message);
  }

  // 3. Save in-flight state
  var state = {
    shutdown_at: new Date().toISOString(),
    signal: signal,
    uptime_seconds: Math.floor(process.uptime()),
    pending_operations: [],
  };

  try {
    var pool = require(path.join(__dirname, '../../integrations/bonds/pgPool'));

    // Check for in-flight ACH batches
    try {
      var pendingBatches = await pool.query(
        "SELECT batch_id, status, amount FROM ach_batches WHERE status IN ('pending', 'processing', 'transmitting')"
      );
      if (pendingBatches.rowCount > 0) {
        state.pending_operations = pendingBatches.rows.map(function(b) {
          return { type: 'ach_batch', id: b.batch_id, status: b.status, amount: b.amount };
        });
        console.log('[shutdown] Found ' + pendingBatches.rowCount + ' in-flight ACH batch(es) — state preserved for recovery');
      }
    } catch(e) {}

    // 4. Close DB pool
    try { await pool.end(); } catch(e) {}

  } catch(e) {
    console.warn('[shutdown] DB state save error:', e.message);
  }

  // 5. Write shutdown marker
  try {
    writeMarker(state);
    console.log('[shutdown] State marker written');
  } catch(e) {
    console.warn('[shutdown] Failed to write state marker:', e.message);
  }

  var elapsed = Date.now() - startTime;
  console.log('[shutdown] Graceful shutdown complete in ' + elapsed + 'ms');

  // 6. Exit
  process.exit(0);
}

/**
 * Check for pending operations from previous shutdown (called on startup)
 */
function checkRecoveryState() {
  try {
    var unseen = [];
    stateStore.update(SHUTDOWN_DOC, function() { return { markers: [] }; }, function(doc) {
      if (!doc || !Array.isArray(doc.markers)) return { markers: [] };
      doc.markers.forEach(function(marker) {
        if (marker.consumed) return;
        unseen.push(marker);
        marker.consumed = true;
        marker.consumed_by = INSTANCE;
      });
      return doc;
    });
    if (!unseen.length) return null;

    unseen.forEach(function(state) {
      console.log('[recovery] Previous shutdown detected at ' + state.shutdown_at + ' (signal: ' + state.signal
        + ', instance: ' + state.instance + ')');
      if (state.pending_operations && state.pending_operations.length > 0) {
        console.log('[recovery] ' + state.pending_operations.length + ' pending operation(s) found from previous session:');
        state.pending_operations.forEach(function(op) {
          console.log('[recovery]   - ' + op.type + ' ' + op.id + ' (was: ' + op.status + ')');
        });
      } else {
        console.log('[recovery] No pending operations — clean shutdown');
      }
    });

    return unseen[unseen.length - 1];
  } catch(e) {
    console.warn('[recovery] Failed to read shutdown state:', e.message);
    return null;
  }
}

/**
 * Install signal handlers
 */
function install() {
  process.on('SIGTERM', function() { performGracefulShutdown('SIGTERM'); });
  process.on('SIGINT', function() { performGracefulShutdown('SIGINT'); });
  process.on('uncaughtException', function(err) {
    console.error('[shutdown] Uncaught exception:', err.message);
    console.error(err.stack);
    // Write marker synchronously (event loop may be corrupted) and exit with error code
    try {
      writeMarker({ shutdown_at: new Date().toISOString(), signal: 'uncaughtException', uptime_seconds: Math.floor(process.uptime()), error: err.message, pending_operations: [] });
    } catch(e) {}
    process.exit(1);
  });
  process.on('unhandledRejection', function(reason) {
    console.error('[shutdown] Unhandled rejection:', reason);
  });

  // Check recovery state from previous run
  var recovery = checkRecoveryState();
  if (recovery) {
    global.__dlb_recovery_state = recovery;
  }

  console.log('[shutdown] Graceful shutdown handlers installed');
}

module.exports = {
  install: install,
  registerServer: registerServer,
  checkRecoveryState: checkRecoveryState,
  performGracefulShutdown: performGracefulShutdown,
};
