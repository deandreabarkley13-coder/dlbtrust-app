'use strict';

/**
 * Worker half of the synchronous Postgres bridge. Runs one query at a time on
 * a warm pool and hands the result back through shared memory, so the calling
 * thread can block on it with Atomics.wait instead of awaiting a promise.
 */

const { parentPort, workerData } = require('worker_threads');
const pool = require('../bonds/pgPool');

if (!pool.connect) {
  throw new Error('pg-sync worker requires a pool exposing connect()');
}

const control = new Int32Array(workerData.control);
const payload = new Uint8Array(workerData.payload);

const SIGNAL = 0;
const LENGTH = 1;
const STATUS = 2;

const OK = 0;
const FAILED = 1;
const TOO_LARGE = 2;

function reply(status, body) {
  let bytes = Buffer.from(JSON.stringify(body), 'utf8');
  let code = status;
  if (bytes.length > payload.length) {
    code = TOO_LARGE;
    bytes = Buffer.from(JSON.stringify({ size: bytes.length, capacity: payload.length }), 'utf8');
  }
  payload.set(bytes, 0);
  Atomics.store(control, LENGTH, bytes.length);
  Atomics.store(control, STATUS, code);
  Atomics.store(control, SIGNAL, 1);
  Atomics.notify(control, SIGNAL);
}

// A checked-out client for callers that need several statements to share one
// transaction, which is how a locked read-modify-write is expressed.
let session = null;

function releaseSession() {
  const client = session;
  session = null;
  if (client) client.release();
}

async function run(msg) {
  if (msg.release) {
    releaseSession();
    return { rows: [], rowCount: 0 };
  }
  if (!msg.session) {
    return pool.query(msg.sql, msg.params || []);
  }
  if (!session) session = await pool.connect();
  return session.query(msg.sql, msg.params || []);
}

parentPort.on('message', (msg) => {
  run(msg)
    .then((res) => { reply(OK, { rows: res.rows, rowCount: res.rowCount }); })
    .catch((err) => {
      // A broken session client must not be handed to the next caller.
      if (msg.session) { try { releaseSession(); } catch (e) { /* already gone */ } }
      reply(FAILED, { message: err.message, code: err.code || null });
    });
});
