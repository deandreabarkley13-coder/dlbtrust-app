#!/usr/bin/env node
'use strict';

/**
 * Apply a policy configuration to a deployed TrustDistributionPolicy: roles,
 * purpose codes, token ceilings, beneficiary allow-list and beneficiary
 * ceilings. Every call goes through the backend engine, so it is submitted
 * from the thirdweb server wallet and the contract still refuses anything the
 * caller does not hold the role for.
 *
 * The config carries no secrets — only addresses, limits and purposes — so it
 * can live in the repo or in ops notes. Example (policy.config.json):
 *
 * {
 *   "roles": [
 *     { "role": "maker",    "account": "0xServerWallet" },
 *     { "role": "checker",  "account": "0xTrusteeA" },
 *     { "role": "checker",  "account": "0xTrusteeB" },
 *     { "role": "executor", "account": "0xServerWallet" },
 *     { "role": "compliance", "account": "0xComplianceOfficer" }
 *   ],
 *   "purposes": ["distribution", "medical", "education", "housing"],
 *   "tokens": [
 *     { "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "maxPerDistribution": "25000000000", "periodCap": "100000000000", "periodSeconds": 2592000 }
 *   ],
 *   "beneficiaries": [
 *     { "beneficiary": "0xBeneficiary", "token": "0x8335...2913", "maxPerDistribution": "500000000", "periodCap": "2000000000", "periodSeconds": 2592000 }
 *   ],
 *   "governance": { "approvalThreshold": 2, "releaseDelaySeconds": 86400, "clawbackWindowSeconds": 86400, "claimWindowSeconds": 0 }
 * }
 *
 * Usage: node scripts/configureTrustDistributionPolicy.cjs --file=policy.config.json [--confirm]
 */

const fs = require('fs');
const { TrustPolicyEngine } = require('../server/integrations/dapp/trustPolicyEngine');

function arg(name, def = null) {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const [, value] = hit.split('=');
  return value === undefined ? true : value;
}

async function main() {
  const file = arg('file');
  if (!file) throw new Error('--file=<policy config json> is required');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const confirm = Boolean(arg('confirm', false));

  const readiness = TrustPolicyEngine.readiness();
  console.log(`contract ${readiness.contract || '(unset)'} on chain ${readiness.chainId}, live=${readiness.live}`);
  if (!readiness.contract) throw new Error('TRUST_POLICY_ADDRESS is not set');

  const plan = [];
  for (const entry of config.roles || []) plan.push(['setRole', () => TrustPolicyEngine.setRole({ allowed: true, ...entry })]);
  for (const purpose of config.purposes || []) plan.push(['setPurpose', () => TrustPolicyEngine.setPurpose({ purpose, allowed: true })]);
  for (const token of config.tokens || []) plan.push(['setTokenLimits', () => TrustPolicyEngine.setTokenLimits({ allowed: true, ...token })]);
  for (const b of config.beneficiaries || []) {
    plan.push(['setBeneficiary', () => TrustPolicyEngine.setBeneficiary({ beneficiary: b.beneficiary, allowed: b.allowed !== false })]);
    if (b.maxPerDistribution || b.periodCap) plan.push(['setBeneficiaryLimits', () => TrustPolicyEngine.setBeneficiaryLimits(b)]);
  }
  if (config.governance) plan.push(['setGovernance', () => TrustPolicyEngine.setGovernance(config.governance)]);

  console.log(`${plan.length} call(s) planned:`);
  for (const [name] of plan) console.log(`  - ${name}`);
  if (!confirm) {
    console.log('\nDry run. Re-run with --confirm to submit.');
    return;
  }

  for (const [name, run] of plan) {
    const result = await run();
    const list = Array.isArray(result) ? result : [result];
    for (const r of list) console.log(`${name}: ${r.status}${r.transactionId ? ` tx=${r.transactionId}` : ''}`);
  }
  console.log('\nDone. Verify with: GET /api/dapp/trust-policy/status');
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
