#!/usr/bin/env node
'use strict';

/**
 * Setup Corporate Treasury for Private Trust Company (PTC) Custodian / Issuer use
 *
 * Run from the repo root:
 *   node server/scripts/setupCorporateTreasuryForPTC.js [ptcEntityId] [trustId]
 *
 * Defaults:
 *   ptcEntityId = PTC-DLB-TRUST
 *   trustId     = TRUST-DLB-001
 *
 * This script creates the standard PTC treasury account structure and seeds
 * default treasury policies/limits for custodian reserve segregation,
 * issuer reserve backing, trust corpus protection, and beneficiary escrow.
 */

require('dotenv').config();

const { CorporateTreasuryEngine } = require('../integrations/finops/corporateTreasuryEngine');

async function main() {
  const ptcEntityId = process.argv[2] || 'PTC-DLB-TRUST';
  const trustId = process.argv[3] || 'TRUST-DLB-001';

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Corporate Treasury PTC Setup');
  console.log(`PTC Entity: ${ptcEntityId} | Trust: ${trustId}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log('⏳ Ensuring treasury tables...');
  await CorporateTreasuryEngine.ensureTables();

  console.log('⏳ Creating PTC default treasury accounts...');
  const accounts = await CorporateTreasuryEngine.setupPTCDefaultAccounts({ ptcEntityId, trustId });
  for (const [role, acct] of Object.entries(accounts)) {
    console.log(`  ✓ ${acct.name} (${acct.category}) => ${acct.account_id}`);
  }

  console.log('\n⏳ Seeding default treasury policies...');
  const policies = [
    { name: 'Payment Limit - Operating', type: 'payment_limit', maxAmount: 1000000, currency: 'USD', scope: accounts.operating.account_id },
    { name: 'Daily Outflow Limit - Operating', type: 'daily_limit', maxAmount: 5000000, currency: 'USD', scope: accounts.operating.account_id },
    { name: 'Approval Threshold', type: 'approval_threshold', threshold: 100000, currency: 'USD' },
    { name: 'Counterparty Limit - Db Net Mgmt', type: 'counterparty_limit', maxAmount: 1000000, currency: 'USD', scope: 'Db Net Mgmt LLC' },
    { name: 'Custodian Concentration Guard', type: 'concentration', maxAmount: 80, currency: 'USD' },
  ];
  for (const p of policies) {
    try {
      const created = await CorporateTreasuryEngine.createPolicy(p);
      console.log(`  ✓ ${created.name} => ${created.policy_id}`);
    } catch (e) {
      console.warn(`  ⚠ Policy ${p.name} skipped:`, e.message);
    }
  }

  console.log('\n⏳ Creating sample cash-pool rule...');
  const pool = await CorporateTreasuryEngine.createCashPool({
    name: 'PTC Operating Concentration Pool',
    currency: 'USD',
    masterAccountId: accounts.operating.account_id,
    targetBalance: 500000,
    sweepThreshold: 100000,
    sweepDirection: 'pull',
    participants: [
      { account_id: accounts.payroll.account_id },
      { account_id: accounts.tax.account_id },
    ],
  });
  console.log(`  ✓ ${pool.name} => ${pool.pool_id}`);

  console.log('\n⏳ Fetching PTC treasury report...');
  const report = await CorporateTreasuryEngine.getPTCReport({ ptcEntityId });
  console.log(JSON.stringify({
    totalCash: `$${(report.totalCashCents / 100).toLocaleString()}`,
    custodianReserve: `$${(report.custodianReserveCents / 100).toLocaleString()}`,
    issuerBacking: `$${(report.issuerBackingCents / 100).toLocaleString()}`,
    trustCorpus: `$${(report.trustCorpusCents / 100).toLocaleString()}`,
    issuedLiability: `$${(report.issuedLiabilityCents / 100).toLocaleString()}`,
    reserveRatioBps: report.reserveRatioBps,
  }, null, 2));

  console.log('\n✅ Corporate Treasury PTC setup complete.');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Setup failed:', err);
  process.exit(1);
});
