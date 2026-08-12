require('dotenv').config();
const { PrivateTrustCompanyEngine } = require('../integrations/dapp/privateTrustCompanyEngine');

async function main() {
  const mode = process.argv[2] || 'interest';
  const form = process.argv[3] || 'ledger';
  try {
    if (mode === 'refresh') {
      const r = await PrivateTrustCompanyEngine.refreshPoolCapacity();
      console.log('Source of truth refreshed:', JSON.stringify(r, null, 2));
      return;
    }
    if (mode === 'statement') {
      const bens = await PrivateTrustCompanyEngine.listBeneficiaries();
      console.log('Beneficiaries:', JSON.stringify(bens, null, 2));
      return;
    }
    if (mode === 'custom') {
      const amount = parseFloat(process.argv[3] || '0');
      const f = process.argv[4] || 'ledger';
      const r = await PrivateTrustCompanyEngine.createDistribution({ type: 'support', totalCents: Math.round(amount * 100), form: f, memo: 'CLI family support issuance' });
      console.log('Distribution:', JSON.stringify(r, null, 2));
      return;
    }
    if (mode === 'interest' && !process.argv[3]) {
      const r = await PrivateTrustCompanyEngine.distributeAllBondInterest({ form });
      console.log('Bond interest distribution:', JSON.stringify(r, null, 2));
      return;
    }
    const bondId = parseInt(mode, 10) || parseInt(process.argv[3], 10);
    const type = process.argv[4] || 'interest';
    const f = process.argv[5] || form;
    const r = await PrivateTrustCompanyEngine.distributeFromBonds({ bondId, type, form: f });
    console.log('Bond distribution:', JSON.stringify(r, null, 2));
  } catch (e) {
    console.error('PTC distribution failed:', e.message);
    process.exit(1);
  }
}

main();
