'use strict';

/**
 * Shutdown/recovery marker validation — run with
 *   `node server/integrations/backup/gracefulShutdown.test.js`
 *
 * Covers the property that matters with replicas: a marker written by one
 * instance is reported exactly once, by whichever instance reads it first.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-'));
process.env.PERSISTENT_DATA_DIR = scratch;
process.env.STATE_STORE_BACKEND = 'file';

const stateStore = require('../cluster/jsonStateStore');
const shutdown = require('./gracefulShutdown');

function markers() {
  return stateStore.read('shutdown-state.json', () => ({ markers: [] })).markers;
}

try {
  assert.strictEqual(shutdown.checkRecoveryState(), null, 'no marker means no recovery state');

  stateStore.update('shutdown-state.json', () => ({ markers: [] }), (doc) => {
    doc.markers.push({
      instance: 'replica-1:1',
      consumed: false,
      shutdown_at: '2026-01-01T00:00:00.000Z',
      signal: 'SIGTERM',
      uptime_seconds: 42,
      pending_operations: [{ type: 'ach_batch', id: 'B1', status: 'transmitting', amount: '10.00' }],
    });
    return doc;
  });

  const recovered = shutdown.checkRecoveryState();
  assert.ok(recovered, 'the marker must be reported');
  assert.strictEqual(recovered.instance, 'replica-1:1');
  assert.strictEqual(recovered.pending_operations.length, 1, 'pending ACH work must survive the restart');

  assert.strictEqual(shutdown.checkRecoveryState(), null, 'a claimed marker is not reported twice');
  const stored = markers();
  assert.strictEqual(stored.length, 1, 'the marker is kept as history, not deleted');
  assert.strictEqual(stored[0].consumed, true);
  assert.ok(stored[0].consumed_by, 'the claiming instance is recorded');
  assert.strictEqual(fs.existsSync(path.join(scratch, 'shutdown-state.json')), true);
  console.log('✓ a shutdown marker is reported once and kept as shared history');
  console.log('graceful shutdown: all checks passed');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
