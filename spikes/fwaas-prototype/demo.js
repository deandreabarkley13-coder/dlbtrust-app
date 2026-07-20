'use strict';

/**
 * FWaaS spike end-to-end demo.
 *
 *   1. Double-entry ledger (TigerBeetle, or in-memory fallback) books a trust
 *      distribution as a two-phase PENDING transfer (an atomic hold).
 *   2. The USDC-on-Stellar (testnet) rail settles the payment on-chain in ~5s.
 *   3. On confirmation the pending transfer is POSTed (settled); on failure it
 *      is VOIDed. The ledger and the chain stay reconciled with no bank in the
 *      path — self-custody + near-instant clearing.
 *
 * Env:
 *   TB_ADDRESS=3033        use a running TigerBeetle cluster (else in-memory)
 *   LEDGER_ONLY=1          skip the on-chain settlement (ledger mechanics only)
 *   AMOUNT_CENTS=125000    distribution amount (default $1,250.00)
 *   SEED_CENTS=500000      initial trust funding (default $5,000.00)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { makeLedger, CODE } = require('./ledger');

function genId() {
  // Non-zero, unique 128-bit id acceptable to both backends.
  return BigInt('0x' + crypto.randomBytes(16).toString('hex')) || 1n;
}

const fmt = (cents) => '$' + (Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });

async function main() {
  const AMOUNT_CENTS = Number(process.env.AMOUNT_CENTS || 125000);
  const SEED_CENTS = Number(process.env.SEED_CENTS || 500000);
  const ledgerOnly = process.env.LEDGER_ONLY === '1';

  const summary = { startedAt: new Date().toISOString(), amountCents: AMOUNT_CENTS, seedCents: SEED_CENTS };

  console.log('══════════════════════════════════════════════════════════════');
  console.log(' FWaaS spike — bank-free ledger + instant on-chain settlement');
  console.log('══════════════════════════════════════════════════════════════\n');

  const ledger = await makeLedger();
  summary.ledgerBackend = ledger.backend;
  console.log(`[1] Ledger backend: ${ledger.backend}\n`);

  // Accounts
  const FUNDING = genId(), OPERATING = genId(), BENEFICIARY = genId();
  await ledger.createAccount(FUNDING, 9000);
  await ledger.createAccount(OPERATING, CODE.TRUST_OPERATING);
  await ledger.createAccount(BENEFICIARY, CODE.BENEFICIARY);

  // Seed the trust operating wallet (represents completed USD→USDC on-ramp).
  const seedId = genId();
  await ledger._pending(seedId, FUNDING, OPERATING, BigInt(SEED_CENTS));
  await ledger._post(genId(), seedId, SEED_CENTS);
  console.log(`[2] Funded trust operating wallet: ${fmt(SEED_CENTS)}\n`);

  // Book the distribution as a hold (maker/checker style two-phase transfer).
  const holdId = genId();
  await ledger._pending(holdId, OPERATING, BENEFICIARY, BigInt(AMOUNT_CENTS));
  console.log(`[3] Booked distribution HOLD: ${fmt(AMOUNT_CENTS)}  (pending, funds reserved)`);
  const afterHold = await ledger.balance(OPERATING);
  console.log(`    operating: posted_in=${afterHold.credits_posted} debits_pending=${afterHold.debits_pending}\n`);

  let settled = false;
  if (ledgerOnly) {
    console.log('[4] LEDGER_ONLY=1 → skipping on-chain settlement; posting hold directly.\n');
    await ledger._post(genId(), holdId, AMOUNT_CENTS);
    settled = true;
  } else {
    const { StellarSettlement } = require('./stellarSettlement');
    const rail = new StellarSettlement();
    try {
      console.log('[4] Provisioning USDC-on-Stellar (testnet): issuer/distributor/beneficiary…');
      const acc = await rail.provision({ seedCents: SEED_CENTS });
      summary.stellar = acc;
      console.log(`    asset:        ${acc.asset}`);
      console.log(`    distributor:  ${acc.distributor}`);
      console.log(`    beneficiary:  ${acc.beneficiary}`);
      const preBal = await rail.usdcBalance(acc.beneficiary);
      console.log(`    beneficiary USDC before: ${preBal}\n`);

      console.log('[5] Settling on-chain (distributor → beneficiary)…');
      const s = await rail.settle({ amountCents: AMOUNT_CENTS, memo: 'trust-distribution' });
      summary.settlement = s;
      console.log(`    ✔ confirmed in ledger #${s.ledger} in ${s.latencyMs} ms`);
      console.log(`    tx:       ${s.hash}`);
      console.log(`    explorer: ${s.explorer}`);
      const postBal = await rail.usdcBalance(acc.beneficiary);
      console.log(`    beneficiary USDC after:  ${postBal}  (+${s.amount})\n`);

      // On-chain confirmed → POST the ledger hold.
      await ledger._post(genId(), holdId, AMOUNT_CENTS);
      settled = true;
      console.log('[6] On-chain confirmed → ledger hold POSTED (settled).\n');
    } catch (err) {
      summary.error = err.message;
      console.error(`    ✖ settlement failed: ${err.message}`);
      await ledger._void(genId(), holdId);
      console.log('[6] Settlement failed → ledger hold VOIDED (funds released, no double-spend).\n');
    }
  }

  // Final reconciliation
  const op = await ledger.balance(OPERATING);
  const bn = await ledger.balance(BENEFICIARY);
  const available = op.credits_posted - op.debits_posted - op.debits_pending;
  const received = bn.credits_posted;
  console.log('[7] Final reconciliation (cents):');
  console.log(`    trust operating available: ${available}  (= ${fmt(available)})`);
  console.log(`    beneficiary received:      ${received}  (= ${fmt(received)})`);
  summary.result = { settled, operatingAvailableCents: Number(available), beneficiaryReceivedCents: Number(received) };
  summary.finishedAt = new Date().toISOString();

  const outPath = path.join(__dirname, 'last-run.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`\n[✓] Wrote run summary → ${outPath}`);

  await ledger.close();
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('demo failed:', err);
  process.exit(1);
});
