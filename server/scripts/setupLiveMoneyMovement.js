'use strict';

/**
 * Setup script for Live Money Movement Engine.
 *
 * Usage: node server/scripts/setupLiveMoneyMovement.js [EXECUTE]
 *
 * - Creates the required tables.
 * - Creates a default test host-to-host partner pointing to httpbin.org/anything.
 * - Optionally initiates and executes a $0.01 live money movement to
 *   "Db Net Mgmt LLC" from CA-OPERATING when EXECUTE argument is passed.
 */

require('dotenv').config();
const { LiveMoneyMovementEngine } = require('../integrations/dapp/liveMoneyMovementEngine');
const { HostToHostEngine } = require('../integrations/dapp/hostToHostEngine');

async function main() {
  const execute = process.argv.includes('EXECUTE');

  await LiveMoneyMovementEngine.ensureTables();
  await HostToHostEngine.ensureTables();

  const partners = await HostToHostEngine.listPartners({ enabled: true });
  let partner = partners.find(p => p.name === 'Default Live Money Test Partner');
  if (!partner) {
    partner = await HostToHostEngine.createPartner({
      name: 'Default Live Money Test Partner',
      protocol: 'https',
      host: 'httpbin.org',
      port: 443,
      remotePath: '/anything',
      messageType: 'json',
      apiKey: 'test-key'
    });
    console.log('Created H2H partner:', partner.partner_id);
  } else {
    console.log('Using existing H2H partner:', partner.partner_id);
  }

  if (execute) {
    const movement = await LiveMoneyMovementEngine.initiateMovement({
      sourceAccountId: 'CA-OPERATING',
      amount: 0.01,
      rail: 'host_to_host',
      endpointId: partner.partner_id,
      creditorName: 'Db Net Mgmt LLC',
      creditorAccount: '692101092959',
      creditorRouting: '091017138',
      creditorBank: 'Sunrise Banks N.A.',
      description: 'Live money movement setup test'
    });
    console.log('Initiated movement:', movement.movement_id);
    const result = await LiveMoneyMovementEngine.executeMovement(movement.movement_id);
    console.log('Executed movement:', result.movement_id, 'status:', result.status, 'settlement:', result.settlement_id);
  } else {
    console.log('Run with EXECUTE argument to send a $0.01 test movement.');
  }
}

main().catch(err => {
  console.error('Setup error:', err.message);
  process.exit(1);
});
