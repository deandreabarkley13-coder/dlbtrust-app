#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { DataBridge } = require('../integrations/accounting/dataBridge');
const pool = require('../integrations/bonds/pgPool');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const execute = hasFlag('execute');
  if (execute && process.env.BOOKKEEPING_LIVE !== 'true') {
    throw new Error('Set BOOKKEEPING_LIVE=true before executing live bookkeeping');
  }

  const result = await DataBridge.runLiveBookkeeping({
    dryRun: !execute,
    includeFineract: !hasFlag('skip-fineract'),
  });
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((err) => {
    console.error('ERROR:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
