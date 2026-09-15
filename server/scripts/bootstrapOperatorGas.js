#!/usr/bin/env node
'use strict';

/**
 * Bootstrap Operator Gas
 *
 * Run from the repo root:
 *   node server/scripts/bootstrapOperatorGas.js [strategy] [amountUsd]
 *
 * Defaults: strategy=auto, amountUsd=100
 * Strategies: auto | dex | skrill | coinbase | cashapp
 *
 * This script audits every funding rail, prints a plan, and tries to execute
 * the cheapest automated step. A cold (0-ETH) operator is never routed through
 * the DEX rail first; `skrill` stages the Coinbase delivery and prints the
 * manual Skrill -> Coinbase withdrawal instructions. If no rail can close the
 * gap, it prints the manual deposit invoice.
 */

require('dotenv').config();

const { FundingEngine } = require('../integrations/dapp/fundingEngine');

async function main() {
  const strategy = (process.argv[2] || 'auto').toLowerCase();
  const amountUsd = Number(process.argv[3] || '100');
  const sourceType = process.argv[4] || 'treasury';
  const sourceAccountId = process.argv[5] || 'TREASURY_HOT';

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Funding Engine Bootstrap');
  console.log(`Strategy: ${strategy} | Amount USD: ${amountUsd}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log('⏳ Fetching funding status...');
  const status = await FundingEngine.getStatus({ amountUsd });
  console.log(JSON.stringify(status, null, 2));
  console.log(`\nOperator ${status.operator.address}: ${status.operator.eth} ETH | ${status.operator.usdc} USDC${status.coldStart ? ' (cold start: on-ramp before DEX)' : ''}`);

  if (strategy === 'skrill') {
    const skrill = status.rails.skrill || {};
    console.log(`Skrill rail: ${skrill.ready ? 'configured' : 'NOT configured'}${skrill.missing && skrill.missing.length ? ` — missing ${skrill.missing.join(', ')}` : ''} | Coinbase delivery: ${skrill.coinbaseReady ? 'enabled' : 'NOT enabled'}`);
  }

  console.log('\n⏳ Building funding plan...');
  const plan = await FundingEngine.buildPlan({ strategy, amountUsd, sourceType, sourceAccountId });
  console.log(JSON.stringify(plan, null, 2));

  if (!plan.canExecute) {
    console.log('\n⚠️  No automated rail can mint ETH. Manual deposit invoice:');
    const invoice = await FundingEngine.getDepositInvoice({ amountEth: '0.01' });
    console.log(JSON.stringify(invoice, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log('\n⏳ Executing best available rail...');
  const result = await FundingEngine.executePlan({ strategy, amountUsd, sourceType, sourceAccountId });
  console.log(JSON.stringify(result, null, 2));

  const skrillStep = (result.executed || []).find(r => r.rail === 'skrill' && r.result && r.result.instructions);
  if (skrillStep) {
    const ins = skrillStep.result.instructions;
    console.log('\n📝 Manual Skrill withdrawal (no bank-withdrawal API behind SKRILL_MERCHANT_EMAIL/SKRILL_API_PASSWORD):');
    console.log(`   ${ins.message}`);
    (ins.steps || []).forEach((s, i) => console.log(`   ${i + 1}. ${s}`));
    (ins.doNot || []).forEach(s => console.log(`   ✖ ${s}`));
    if (ins.automationNote) console.log(`   ℹ ${ins.automationNote}`);
  }

  const after = await FundingEngine.getStatus({ amountUsd });
  console.log(`\nOperator balances after run: ${after.operator.eth} ETH | ${after.operator.usdc} USDC`);

  if (!result.executed || result.executed.length === 0 || result.executed.every(r => r.error)) {
    console.log('\n⚠️  Execution did not complete. Manual deposit invoice:');
    const invoice = await FundingEngine.getDepositInvoice({ amountEth: '0.01' });
    console.log(JSON.stringify(invoice, null, 2));
    process.exitCode = 1;
  } else {
    console.log('\n✅ Funding step executed. Check operator balance and retry on-chain operations.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
