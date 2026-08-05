require('dotenv').config();

const { BondTrustReconciliation } = require('../integrations/bonds/bondTrustReconciliation');

async function run() {
  const bondId = process.argv[2] || 'DLB-PRB';
  console.log(`[syncBondToTrust] Reconciling bond ${bondId} ...`);
  const result = await BondTrustReconciliation.sync(bondId);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

run().catch(err => {
  console.error('[syncBondToTrust] Fatal error:', err);
  process.exit(1);
});
