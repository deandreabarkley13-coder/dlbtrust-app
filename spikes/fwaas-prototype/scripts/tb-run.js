#!/usr/bin/env node
'use strict';

/**
 * Helper to format a TigerBeetle data file and start a single-replica dev
 * cluster. TigerBeetle is a single static binary; point TB_BIN at it.
 *
 *   TB_BIN=~/tigerbeetle/tigerbeetle node scripts/tb-run.js format
 *   TB_BIN=~/tigerbeetle/tigerbeetle node scripts/tb-run.js start
 *
 * Defaults: data file spikes/fwaas-prototype/0_0.tigerbeetle, port 3033.
 */

const { spawnSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TB_BIN = process.env.TB_BIN || path.join(os.homedir(), 'tigerbeetle', 'tigerbeetle');
const DATA_FILE = process.env.TB_DATA_FILE || path.join(__dirname, '..', '0_0.tigerbeetle');
const PORT = process.env.TB_PORT || '3033';
const CLUSTER = process.env.TB_CLUSTER || '0';

const cmd = process.argv[2];

if (!fs.existsSync(TB_BIN)) {
  console.error(`[tb-run] TigerBeetle binary not found at ${TB_BIN}. Set TB_BIN.`);
  process.exit(1);
}

if (cmd === 'format') {
  if (fs.existsSync(DATA_FILE)) fs.rmSync(DATA_FILE);
  const r = spawnSync(TB_BIN, [
    'format', `--cluster=${CLUSTER}`, '--replica=0', '--replica-count=1', DATA_FILE,
  ], { stdio: 'inherit' });
  process.exit(r.status || 0);
} else if (cmd === 'start') {
  const child = spawn(TB_BIN, [
    'start', `--addresses=${PORT}`, DATA_FILE,
  ], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code || 0));
} else {
  console.error('usage: tb-run.js [format|start]');
  process.exit(1);
}
