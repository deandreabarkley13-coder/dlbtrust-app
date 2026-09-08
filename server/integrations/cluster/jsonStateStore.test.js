'use strict';

/**
 * Shared state store validation — run with
 *   `node server/integrations/cluster/jsonStateStore.test.js`
 * Uses a scratch directory; touches no real state document.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'state-store-'));
process.env.PERSISTENT_DATA_DIR = scratch;

const store = require('./jsonStateStore');
const FILE = 'test-state.json';

function testRoundTrip() {
  assert.deepStrictEqual(store.read(FILE, () => ({ items: [] })), { items: [] });
  store.write(FILE, { items: ['a'] });
  assert.deepStrictEqual(store.read(FILE, () => ({ items: [] })), { items: ['a'] });
  // The fallback must be produced fresh each time, or a mutation would leak
  // into the next reader of a missing document.
  const first = store.read('missing.json', () => ({ items: [] }));
  first.items.push('leaked');
  assert.deepStrictEqual(store.read('missing.json', () => ({ items: [] })), { items: [] });
}

function testNoPartialReads() {
  // A large document written while another reader is looping must never parse
  // as truncated JSON — that is what the temp-file-and-rename buys.
  const big = { items: [] };
  for (let i = 0; i < 20000; i++) big.items.push({ i, pad: 'x'.repeat(40) });
  const child = require('child_process').spawn(process.execPath, ['-e', `
    const store = require(${JSON.stringify(path.join(__dirname, 'jsonStateStore.js'))});
    const big = { items: [] };
    for (let i = 0; i < 20000; i++) big.items.push({ i, pad: 'x'.repeat(40) });
    for (let n = 0; n < 40; n++) store.write('big.json', big);
  `], { env: Object.assign({}, process.env), stdio: 'inherit' });

  let reads = 0;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && child.exitCode === null) {
    const doc = store.read('big.json', () => null);
    if (doc) {
      assert.strictEqual(doc.items.length, 20000, 'a reader must never see a partial document');
      reads++;
    }
  }
  try { child.kill(); } catch (e) { /* already exited */ }
  assert.ok(reads > 0, 'the reader loop must have observed the document at least once');
}

function testUpdateSerialises() {
  store.write('counter.json', { n: 0, writers: [] });
  // Four processes each append 25 entries under the lock; nothing may be lost.
  const script = `
    const store = require(${JSON.stringify(path.join(__dirname, 'jsonStateStore.js'))});
    for (let i = 0; i < 25; i++) {
      store.update('counter.json', () => ({ n: 0, writers: [] }), (doc) => {
        doc.n += 1;
        doc.writers.push(process.pid + ':' + i);
      });
    }
  `;
  const kids = [];
  for (let p = 0; p < 4; p++) {
    kids.push(require('child_process').spawn(process.execPath, ['-e', script], {
      env: Object.assign({}, process.env), stdio: 'inherit',
    }));
  }
  const done = new Promise((resolve) => {
    let left = kids.length;
    kids.forEach((k) => k.on('exit', () => { if (--left === 0) resolve(); }));
  });
  return done.then(() => {
    const doc = store.read('counter.json', () => null);
    assert.strictEqual(doc.n, 100, 'every locked increment must survive, got ' + doc.n);
    assert.strictEqual(doc.writers.length, 100);
    assert.strictEqual(new Set(doc.writers).size, 100, 'no entry may be duplicated');
  });
}

function testConflictIsReported() {
  store.write('conflict.json', { v: 1 });
  store.read('conflict.json', () => null);
  const before = store.stats().conflicts;
  // Another instance writes behind this process's back.
  execFileSync(process.execPath, ['-e', `
    const store = require(${JSON.stringify(path.join(__dirname, 'jsonStateStore.js'))});
    store.write('conflict.json', { v: 2 });
  `], { env: Object.assign({}, process.env) });
  store.write('conflict.json', { v: 3 });
  assert.strictEqual(store.stats().conflicts, before + 1, 'an overwrite of a changed document must be counted');
}

function testStaleLockIsCleared() {
  const lock = store.resolve('stale.json') + '.lock';
  fs.writeFileSync(lock, 'dead-instance');
  const old = Date.now() - 60000;
  fs.utimesSync(lock, old / 1000, old / 1000);
  store.update('stale.json', () => ({ n: 0 }), (doc) => { doc.n = 7; });
  assert.deepStrictEqual(store.read('stale.json', () => null), { n: 7 });
  assert.strictEqual(fs.existsSync(lock), false, 'the lock must be released after the update');
}

async function main() {
  testRoundTrip();
  console.log('  ✓ documents round-trip and fallbacks are not shared');
  testNoPartialReads();
  console.log('  ✓ concurrent readers never observe a partial document');
  await testUpdateSerialises();
  console.log('  ✓ locked updates from four processes all survive');
  testConflictIsReported();
  console.log('  ✓ overwriting a document changed elsewhere is counted and logged');
  testStaleLockIsCleared();
  console.log('  ✓ a lock left by a dead instance is cleared');
  console.log('jsonStateStore: all checks passed');
}

main().then(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
}).catch((e) => {
  console.error('jsonStateStore test failed:', e.message);
  process.exit(1);
});
