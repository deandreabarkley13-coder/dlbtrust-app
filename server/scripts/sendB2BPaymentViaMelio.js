#!/usr/bin/env node
'use strict';

/**
 * Compatibility entrypoint for live canonical Melio payments.
 *
 * The canonical workflow enforces authenticated maker/checker approvals,
 * compliance screening, accounting classification, and source reservations.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const workflow = path.join(__dirname, 'melioCanonicalPaymentWorkflow.js');
const args = process.argv.slice(2);
if (!args.includes('--executionMode')) {
  args.push('--executionMode', 'live_api');
}

const result = spawnSync(process.execPath, [workflow, ...args], {
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
