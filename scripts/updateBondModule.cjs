#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { query } = require('../server/integrations/bonds/pgPool');

const PRB_TOKEN_ID = 'BTOK-1786140651946-IO551I';
const PRB_TOKEN_ADDRESS = '0x3f3a354f76be6ad0e7fc9b6efe39727b39cbd160';
const OLD_BOND_TOKEN = '0xe8dee80f97349f3f88c2ca0c21e7ff0df14c5c05';

function statePath() {
  if (process.env.PERSISTENT_DATA_DIR && fs.existsSync(process.env.PERSISTENT_DATA_DIR)) {
    return path.join(process.env.PERSISTENT_DATA_DIR, 'ptc-stablecoin-state.json');
  }
  if (fs.existsSync('/data')) return '/data/ptc-stablecoin-state.json';
  return path.join(process.cwd(), 'data', 'ptc-stablecoin-state.json');
}

(async () => {
  const mod = (await query('SELECT * FROM module_smart_accounts WHERE module_key = $1', ['bond_portfolio'])).rows[0];
  if (mod) {
    const metadata = typeof mod.metadata === 'string' ? JSON.parse(mod.metadata || '{}') : (mod.metadata || {});
    metadata.tokenSymbol = 'DLB-PRB';
    metadata.tokenName = 'DLB Private Placement Bond';
    metadata.mintedAmount = 100_000_000;
    metadata.balance = { amount: 100_000_000, balance: 100_000_000 };
    await query(
      'UPDATE module_smart_accounts SET token_id = $1, token_address = $2, metadata = $3, updated_at = NOW() WHERE id = $4',
      [PRB_TOKEN_ID, PRB_TOKEN_ADDRESS, JSON.stringify(metadata), mod.id]
    );
    console.log('Updated bond_portfolio module to DLB-PRB');
  }

  const state = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  state.reserveTokens = (state.reserveTokens || []).filter(
    r => r.address.toLowerCase() !== OLD_BOND_TOKEN.toLowerCase()
  );
  state.reserveTokens.push({
    address: PRB_TOKEN_ADDRESS,
    decimals: 6,
    moduleKey: 'bond_portfolio',
    name: 'DLB-PRB',
    price: '1000000000000000000',
    addedAt: new Date().toISOString(),
  });
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
  console.log('Updated ptc-stablecoin-state.json');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
