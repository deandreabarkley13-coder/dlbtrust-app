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

/** Credit-push rails available at settlement (ERP -> USDC -> Spritz -> bank / bill). */
async function rails() {
  const data = await call('/api/finops/spritz/treasury/rails');
  console.log(`Source: ${data.source.kind} ${data.source.account} -> USDC via policy ${data.source.via}; payout wallet ${data.payoutWallet}`);
  if (!data.rails.length) { console.log('No settlement bank or payable bill linked in Spritz.'); return; }
  for (const r of data.rails) console.log(`${r.default ? '*' : ' '} ${r.rail.padEnd(14)} -> ${r.destination} ${r.label} (${r.accountId}) [${r.status}]`);
}

/**
 * Stage a governed payout: policy contract -> payout wallet -> Spritz credit push.
 *   --amount 100 --purpose beneficiary_support --reference REF-1 --bucket coupon_income [--rail rtp | --bill <billId>]
 */
async function payout() {
  const data = await call('/api/finops/spritz/treasury/payout/stage', {
    method: 'POST',
    body: { amountUsd: arg('amount'), purpose: arg('purpose'), reference: arg('reference'), bucket: arg('bucket'), rail: arg('rail'), billId: arg('bill'), bankAccountId: arg('bank'), memo: arg('memo') },
  });
  console.log(`${data.status} ${data.reference}: ${data.amountUsd} USD via ${data.rail} -> ${data.destination.kind} ${data.destination.accountId}`);
  console.log(`distribution ${data.distribution && (data.distribution.distributionId || data.distribution.id)} quote ${data.spritzQuoteId}`);
  console.log(data.next);
}

/** Session-key relayer state for the payout smart account. */
async function relayer() {
  const data = await call('/api/finops/spritz/relayer');
  console.log(`mode ${data.mode} ready ${data.ready} | account ${data.smartAccount} | relayer ${data.relayer} (key: ${data.relayerHasKey}) | sponsorship ${data.gasSponsorship}`);
  if (data.session) console.log(`session active ${data.session.active} targets ${data.session.approvedTargets.join(', ')} expires in ${data.session.expiresInSeconds}s`);
  for (const i of data.issues) console.log(`- ${i}`);
}

/**
 * Prepare the one-time EIP-712 session-key grant for the trustee admin to sign.
 *   [--days 30] [--targets 0x..,0x..] [--revoke]
 */
async function grant() {
  const days = Number(arg('days', '0'));
  const data = await call('/api/finops/spritz/relayer/session-key/prepare', {
    method: 'POST',
    body: { durationSeconds: days ? days * 86400 : undefined, approvedTargets: arg('targets') ? arg('targets').split(',') : undefined, revoke: process.argv.includes('--revoke') },
  });
  console.log(`${data.action} on ${data.smartAccount} (chain ${data.chainId}) for signer ${data.signer}; admins: ${data.admins.join(', ') || 'unknown'}`);
  console.log(data.instructions);
  console.log(JSON.stringify(data.typedData, null, 2));
}

const commands = { status, allowlist, wallet, rails, payout, relayer, grant };
const cmd = process.argv[2] || 'status';
if (!commands[cmd]) {
  console.error(`unknown command ${cmd}; expected one of ${Object.keys(commands).join(', ')}`);
  process.exit(2);
}
commands[cmd]().catch((e) => { console.error(e.message); process.exit(1); });
