'use strict';

/**
 * Synchronous Postgres queries for the engines whose state accessors are
 * synchronous.
 *
 * Those engines keep their records in JSON documents and read them through
 * plain synchronous calls in the middle of request handling. Moving the
 * documents into Postgres — which every instance can reach — would otherwise
 * mean turning several hundred call sites async.
 *
 * A worker thread holds the connection pool and answers one query at a time
 * through a SharedArrayBuffer; the caller blocks on Atomics.wait until the
 * answer lands. The query itself runs on the worker's event loop, so the
 * blocked thread is waiting on the database rather than on itself, and because
 * the caller blocks there is never more than one query in flight.
 *
 * Spawning a process per query instead costs ~950ms on this image (the pool
 * module and TLS handshake are paid every time); the warm worker costs
 * single-digit milliseconds.
 */

const path = require('path');
const { Worker } = require('worker_threads');

const SIGNAL = 0;
const LENGTH = 1;
const STATUS = 2;

const OK = 0;
const FAILED = 1;
const TOO_LARGE = 2;

const DEFAULT_TIMEOUT_MS = parseInt(process.env.PG_SYNC_TIMEOUT_MS || '20000', 10);
const PAYLOAD_BYTES = parseInt(process.env.PG_SYNC_PAYLOAD_BYTES || String(16 * 1024 * 1024), 10);

let worker = null;
let control = null;
let payload = null;
let queries = 0;
let failures = 0;

function start() {
  if (worker) return worker;
  const controlBuffer = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);
  const payloadBuffer = new SharedArrayBuffer(PAYLOAD_BYTES);
  control = new Int32Array(controlBuffer);
  payload = new Uint8Array(payloadBuffer);
  worker = new Worker(path.join(__dirname, 'pgSyncWorker.js'), {
    workerData: { control: controlBuffer, payload: payloadBuffer },
  });
  worker.on('error', (err) => {
    console.error('[pg-sync] worker error: ' + err.message);
    discard();
  });
  worker.on('exit', () => { worker = null; });
  // The worker must never be the reason the process stays alive.
  worker.unref();
  return worker;
}

function discard() {
  const current = worker;
  worker = null;
  control = null;
  payload = null;
  if (current) {
    current.removeAllListeners();
    current.terminate().catch(() => { /* already gone */ });
  }
}

/**
 * Run one query and block until it answers. Throws on database errors, on
 * timeout, and on results too large for the shared buffer.
 */
function query(sql, params, options) {
  const timeoutMs = (options && options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const active = start();
  Atomics.store(control, SIGNAL, 0);
  Atomics.store(control, LENGTH, 0);
  Atomics.store(control, STATUS, OK);
  queries += 1;
  active.postMessage({
    sql: sql,
    params: params || [],
    session: Boolean(options && options.session),
    release: Boolean(options && options.release),
  });
  const waited = Atomics.wait(control, SIGNAL, 0, timeoutMs);
  if (waited === 'timed-out') {
    // The worker may still be about to write into the shared buffer, so this
    // one cannot be reused: a late answer would be read as the next query's.
    failures += 1;
    discard();
    throw new Error('pg-sync query timed out after ' + timeoutMs + 'ms');
  }
  const status = Atomics.load(control, STATUS);
  const length = Atomics.load(control, LENGTH);
  const body = JSON.parse(Buffer.from(payload.buffer, 0, length).toString('utf8'));
  if (status === TOO_LARGE) {
    failures += 1;
    throw new Error('pg-sync result of ' + body.size + ' bytes exceeds the '
      + body.capacity + '-byte buffer; raise PG_SYNC_PAYLOAD_BYTES');
  }
  if (status === FAILED) {
    failures += 1;
    const err = new Error(body.message);
    if (body.code) err.code = body.code;
    throw err;
  }
  return body;
}

/**
 * Run `body` inside one transaction on a single connection, so a read taken
 * with FOR UPDATE still holds its lock when the write lands. `body` receives a
 * query function bound to that connection.
 */
function transaction(body) {
  query('BEGIN', [], { session: true });
  let result;
  try {
    result = body((sql, params) => query(sql, params, { session: true }));
  } catch (err) {
    try { query('ROLLBACK', [], { session: true }); } catch (e) { /* connection already gone */ }
    releaseSession();
    throw err;
  }
  try {
    query('COMMIT', [], { session: true });
  } finally {
    releaseSession();
  }
  return result;
}

function releaseSession() {
  if (!worker) return;
  try { query('', [], { release: true }); } catch (e) { /* worker already discarded */ }
}

function stats() {
  return { running: Boolean(worker), queries: queries, failures: failures, payloadBytes: PAYLOAD_BYTES };
}

module.exports = {
  query: query,
  transaction: transaction,
  stats: stats,
  stop: discard,
};
