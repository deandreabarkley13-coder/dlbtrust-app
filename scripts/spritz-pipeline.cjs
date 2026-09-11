#!/usr/bin/env node
'use strict';

/**
 * Operate the unified settlement pipeline against a running dlbtrust-app:
 * Treasury-Core ERP canonical GL -> USDC in the TrustDistributionPolicy ->
 * Coinbase payout wallet -> Spritz off-ramp (bank / Bill Pay), plus Collateral OS.
 *
 *   node scripts/spritz-pipeline.cjs status
 *       Print every stage (OK/BLOCKED), balances, buckets and recent legs.
 *   node scripts/spritz-pipeline.cjs allowlist [--max=USD] [--cap=USD] [--period=SECONDS]
 *       Encode the owner-only setBeneficiary/setBeneficiaryLimits txs for the
 *       payout wallet. Nothing is submitted: the contract owner (trustee wallet)
 *       signs the printed calldata.
 *   node scripts/spritz-pipeline.cjs wallet
 *       Payout wallet registry / balance / allow-list state.
 *
 * Env: DLBTRUST_BASE_URL (default http://localhost:3002), ADMIN_SECRET_TOKEN.
 */

const BASE = (process.env.DLBTRUST_BASE_URL || 'http://localhost:3002').replace(/\/$/, '');
const TOKEN = process.env.ADMIN_SECRET_TOKEN || '';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

async function call(path, { method = 'GET', body } = {}) {
  if (!TOKEN) throw new Error('ADMIN_SECRET_TOKEN is required');
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error(`${path}: HTTP ${res.status} ${text.slice(0, 200)}`); }
  if (!res.ok || json.success === false) throw new Error(`${path}: ${json.error || res.statusText}`);
  return json.data;
}

const usd = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function status() {
  const p = await call('/api/finops/spritz/pipeline?limit=10');
  console.log(`Pipeline ${p.ready ? 'READY' : 'BLOCKED'} as of ${p.asOf}`);
  for (const s of p.stages) console.log(`  [${s.ok ? ' OK  ' : 'BLOCK'}] ${s.label}${s.detail ? ` — ${s.detail}` : ''}`);
  for (const e of p.errors) console.log(`  [ERROR] ${e}`);
  if (p.policy) console.log(`Policy ${p.policy.contract} owner ${p.policy.owner} USDC available ${usd(Number(p.policy.treasury.available) / 1e6)}${p.policy.paused ? ' PAUSED' : ''}`);
  if (p.payoutWallet) console.log(`Payout wallet ${p.payoutWallet.address} USDC ${p.payoutWallet.usdcBalance ?? '?'} allow-listed=${p.payoutWallet.policy ? p.payoutWallet.policy.allowed : '?'}`);
  for (const b of p.buckets || []) console.log(`Bucket ${b.bucket}: recognised ${usd(b.recognisedUsd)} staged ${usd(b.stagedUsd)} headroom ${usd(b.headroomUsd)}`);
  if (p.collateralOs && p.collateralOs.facility) {
    const f = p.collateralOs.facility;
    console.log(`Collateral OS: collateral ${usd(f.collateralUsd)} spendable ${usd(f.spendableUsd)} drawn ${usd(f.drawnUsd)} available ${usd(f.availableUsd)}`);
  }
  console.log(`Funding legs: ${(p.fundingLegs || []).length}, payouts: ${(p.payouts || []).length}, bill payments: ${(p.billPayments || []).length}`);
}

async function allowlist() {
  const data = await call('/api/finops/spritz/wallet/allowlist/prepare', {
    method: 'POST',
    body: { maxPerDistributionUsd: arg('max'), periodCapUsd: arg('cap'), periodSeconds: Number(arg('period', '0')) },
  });
  console.log(`Beneficiary ${data.beneficiary} token ${data.token} already allowed: ${data.alreadyAllowed}`);
  console.log(`Contract owner: ${data.owner} (server wallet is owner: ${data.serverWalletIsOwner})`);
  console.log(data.instructions);
  for (const tx of data.txs) console.log(JSON.stringify({ action: tx.action, from: tx.from, to: tx.to, chainId: tx.chainId, value: tx.value, data: tx.data }, null, 2));
}

async function wallet() {
  console.log(JSON.stringify(await call('/api/finops/spritz/wallet'), null, 2));
}

const commands = { status, allowlist, wallet };
const cmd = process.argv[2] || 'status';
if (!commands[cmd]) {
  console.error(`unknown command ${cmd}; expected one of ${Object.keys(commands).join(', ')}`);
  process.exit(2);
}
commands[cmd]().catch((e) => { console.error(e.message); process.exit(1); });
