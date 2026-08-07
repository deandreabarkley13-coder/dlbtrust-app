#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
function statePath() {
  if (process.env.PERSISTENT_DATA_DIR && fs.existsSync(process.env.PERSISTENT_DATA_DIR)) {
    return path.join(process.env.PERSISTENT_DATA_DIR, 'ptc-stablecoin-state.json');
  }
  if (fs.existsSync('/data')) return '/data/ptc-stablecoin-state.json';
  return path.join(process.cwd(), 'data', 'ptc-stablecoin-state.json');
}
const state = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
const seen = new Set();
state.reserveTokens = (state.reserveTokens || []).filter(r => {
  const key = r.address.toLowerCase();
  if (key === '0x3f3a354f76be6ad0e7fc9b6efe39727b39cbd160') {
    if (seen.has(key)) return false;
    seen.add(key);
    r.moduleKey = 'bond_portfolio';
    r.name = 'DLB-PRB';
    return true;
  }
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});
fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
console.log('cleaned');
