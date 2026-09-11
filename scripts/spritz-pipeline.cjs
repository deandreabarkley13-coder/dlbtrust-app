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
 *   node scripts/spritz-pipeline.cjs relayer | grant | account
 *       Session-key relayer state, trustee grant typed data, payout smart account.
 *   node scripts/spritz-pipeline.cjs funding [--ensure-account] [--reconcile]
 *       ERP fiat credit push -> Spritz auto-ramp readiness, deposit instructions,
 *       recorded fundings; --ensure-account opens the auto-ramp account.
 *   node scripts/spritz-pipeline.cjs fund --amount=USD --reference=REF --bucket=B [--rail=ach|wire] [--send --confirm]
 *       Originate the ERP credit push; --send --confirm transmits it.
 *   node scripts/spritz-pipeline.cjs settle --amount=USD --purpose=P --reference=REF --bucket=B [--rail=..] [--bill=..] [--transmit --confirm]
 *       Straight-through run: advances one reference as far as governance allows.
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

/**
 * Predict / deploy the thirdweb payout smart account (trustee = admin).
 *   account [--admin=0x..] [--salt=..]          read-only: address + unsigned createAccount tx
 *   account --deploy --confirm                   server wallet pays gas and broadcasts
 */
async function account() {
  const body = { admin: arg('admin'), salt: arg('salt') };
  const deploy = process.argv.includes('--deploy');
  if (deploy && !process.argv.includes('--confirm')) throw new Error('--deploy broadcasts a transaction; add --confirm');
  const data = await call(`/api/finops/spritz/relayer/account/${deploy ? 'deploy' : 'prepare'}`, { method: 'POST', body: deploy ? { ...body, confirm: true, via: arg('via') } : body });
  console.log(`${data.action}: ${data.address} (chain ${data.chainId}, factory ${data.factory}) admin ${data.admin} deployed ${data.deployed} configured ${data.configured}`);
  if (data.txHash) console.log(`tx ${data.txHash} status ${data.status} paid by ${data.payer}`);
  for (const i of data.issues) console.log(`- ${i}`);
  if (data.unsignedTx) console.log(JSON.stringify(data.unsignedTx, null, 2));
  data.next.forEach((n, i) => console.log(`${i + 1}. ${n}`));
}

function printFunding(f) {
  console.log(`${f.status.padEnd(16)} ${f.reference} ${usd(f.amountUsd)} via ${f.rail} transfer ${f.transferId || '-'} (${f.transferStatus || '-'}) on-ramp ${f.onRampId || '-'}${f.error ? ` error: ${f.error}` : ''}`);
}

/** ERP fiat credit push -> Spritz auto-ramp -> USDC on the policy contract. */
async function funding() {
  if (process.argv.includes('--ensure-account')) {
    const a = await call('/api/finops/spritz/fiat-funding/account', { method: 'POST' });
    console.log(`auto-ramp account ${a.id} ${a.status}${a.created ? ' (created)' : ''} -> ${a.token} on ${a.network} at ${a.address}`);
  }
  const r = await call('/api/finops/spritz/fiat-funding/readiness');
  console.log(`fiat funding ${r.ready ? 'READY' : 'BLOCKED'} (${r.direction}, default rail ${r.defaultRail})`);
  for (const i of r.issues) console.log(`- ${i}`);
  if (r.erp) console.log(`ERP ${r.erp.system} cash ${r.erp.cashAccountCode} -> ${r.erp.assetAccountCode} live=${r.erp.live}`);
  for (const c of r.capabilities || []) console.log(`capability ${c.method}: ${c.status}${c.requirements.length ? ' ' + c.requirements.map((q) => `${q.type} ${q.status}${q.actionUrl ? ' ' + q.actionUrl : ''}`).join('; ') : ''}`);
  if (r.autoRampAccount && r.autoRampAccount.depositInstructions) {
    const d = r.autoRampAccount.depositInstructions;
    console.log(`deposit to ${d.bankName} routing ${d.bankRoutingNumber} account ••••${String(d.bankAccountNumber || '').slice(-4)} rails ${d.paymentRails.join(', ')}`);
  }
  if (r.collateral) console.log(`collateral OS gate ${r.collateral.gated ? 'on' : 'off'}${r.collateral.availableUsd !== undefined ? ` available ${usd(r.collateral.availableUsd)} of ${usd(r.collateral.spendableUsd)}` : ` (${r.collateral.reason})`}`);
  const list = process.argv.includes('--reconcile')
    ? (await call('/api/finops/spritz/fiat-funding/reconcile', { method: 'POST' })).fundings
    : await call('/api/finops/spritz/fiat-funding');
  console.log(`${list.length} funding(s)`);
  list.forEach(printFunding);
}

async function fund() {
  const send = process.argv.includes('--send');
  if (send && !process.argv.includes('--confirm')) throw new Error('--send transmits a real ERP credit push; add --confirm');
  const data = await call('/api/finops/spritz/fiat-funding', {
    method: 'POST',
    body: { amountUsd: arg('amount'), reference: arg('reference'), bucket: arg('bucket'), rail: arg('rail'), memo: arg('memo') },
  });
  console.log(`${data.status} ${data.reference}: ${usd(data.amountUsd)} via ${data.rail} from ERP ${data.source ? data.source.account : data.sourceAccount}${data.idempotent ? ' (existing)' : ''}`);
  if (data.transfer) console.log(`transfer ${data.transfer.id} ${data.transfer.status}`);
  if (data.next) console.log(data.next);
  if (send) {
    const sent = await call(`/api/finops/spritz/fiat-funding/${encodeURIComponent(data.reference)}/send`, { method: 'POST' });
    printFunding(sent);
  }
}

async function settle() {
  const transmit = process.argv.includes('--transmit');
  if (transmit && !process.argv.includes('--confirm')) throw new Error('--transmit sends a real ERP credit push; add --confirm');
  const data = await call('/api/finops/spritz/treasury/settle', {
    method: 'POST',
    body: { amountUsd: arg('amount'), purpose: arg('purpose'), reference: arg('reference'), bucket: arg('bucket'), rail: arg('rail'), billId: arg('bill'), bankAccountId: arg('bank'), memo: arg('memo'), fundingRail: arg('funding-rail'), transmit },
  });
  for (const t of data.trail) console.log(`${t.ok ? 'OK     ' : 'BLOCKED'} ${t.stage}: ${t.detail}`);
  console.log(`${data.status.toUpperCase()} at ${data.stage}: ${data.detail}`);
}

const commands = { status, allowlist, wallet, rails, payout, relayer, grant, account, funding, fund, settle };
const cmd = process.argv[2] || 'status';
if (!commands[cmd]) {
  console.error(`unknown command ${cmd}; expected one of ${Object.keys(commands).join(', ')}`);
  process.exit(2);
}
commands[cmd]().catch((e) => { console.error(e.message); process.exit(1); });
