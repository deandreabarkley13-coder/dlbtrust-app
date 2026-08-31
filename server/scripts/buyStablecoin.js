#!/usr/bin/env node
'use strict';

/**
 * Buy the USDC the payout rail spends, under dual control.
 *
 * The purchase has two legs and only the second is an API call: the trust
 * wires USD to Circle Mint from Trust Operating, then Circle sends USDC to the
 * trust's own Stellar distributor. This script drives both, and posts the
 * ledger for the second only once the distributor's Horizon balance has
 * actually risen.
 *
 * Usage:
 *   node server/scripts/buyStablecoin.js status
 *   node server/scripts/buyStablecoin.js instructions
 *   node server/scripts/buyStablecoin.js plan      [--amount 500]
 *   node server/scripts/buyStablecoin.js initiate  --amount 500 --maker trustee-one@…
 *   node server/scripts/buyStablecoin.js approve   --id USDCBUY-… --checker trustee-two@…
 *   node server/scripts/buyStablecoin.js wire      --id USDCBUY-… --reference <bank wire ref>
 *   node server/scripts/buyStablecoin.js transfer  --id USDCBUY-… --yes
 *   node server/scripts/buyStablecoin.js confirm   --id USDCBUY-…
 *   node server/scripts/buyStablecoin.js list
 *
 * `--amount` is dollars. With no amount, the purchase is sized to the gap
 * between the position and STABLECOIN_TARGET_FLOOR_CENTS.
 */

const { StablecoinTreasuryEngine } = require('../integrations/os/stablecoinTreasuryEngine');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function dollarsToCents(value) {
  if (value === undefined || value === true) return null;
  const cents = Math.round(Number(value) * 100);
  if (!Number.isFinite(cents) || cents <= 0) throw new Error(`--amount ${value} is not a positive dollar amount`);
  return cents;
}

function print(label, value) {
  console.log(`  ${String(label).padEnd(22)} ${value}`);
}

function showPurchase(purchase) {
  print('purchase', purchase.purchase_id);
  print('status', purchase.status);
  print('amount', `$${(Number(purchase.amount_cents) / 100).toFixed(2)}`);
  print('distributor', purchase.distributor_address);
  if (purchase.circle_transfer_id) print('circle transfer', purchase.circle_transfer_id);
  if (purchase.wire_reference) print('wire reference', purchase.wire_reference);
  if (purchase.journal_entry_id) print('journal entry', purchase.journal_entry_id);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'status';

  if (command === 'status') {
    const position = await StablecoinTreasuryEngine.position();
    console.log('\nDistributor');
    print('network', position.network);
    print('address', position.distributor);
    print('held', position.held);
    print('spendable', position.spendable);
    print('buying', position.purchasing);
    print('floor', `$${(position.targetFloorCents / 100).toFixed(2)}`);
    print('short of floor', position.shortOfFloor);
    console.log('\nCircle Mint');
    if (position.circle.ready) {
      const balances = await StablecoinTreasuryEngine.circleBalances();
      (balances.available || []).forEach(entry => print(entry.currency, entry.amount));
      if (!(balances.available || []).length) print('available', 'nothing');
    } else {
      position.circle.issues.forEach(issue => print('blocked', issue));
    }
    console.log('');
    return;
  }

  if (command === 'instructions') {
    const instructions = await StablecoinTreasuryEngine.wireInstructions();
    console.log('\nWire USD to Circle Mint using exactly these details:\n');
    console.log(JSON.stringify(instructions, null, 2));
    console.log('\nThe reference line matters: Circle credits the account by it.\n');
    return;
  }

  if (command === 'plan') {
    const plan = await StablecoinTreasuryEngine.plan({ amountCents: dollarsToCents(args.amount) });
    console.log('');
    print('buying', plan.amount);
    print('funding account', plan.fundingAccount ? `${plan.fundingAccount.id} ${plan.fundingAccount.name}` : 'unresolved');
    plan.legs.forEach(leg => {
      console.log(`\n  ${leg.leg} (${leg.automated ? 'automated' : 'manual bank wire'})`);
      print('  does', leg.description);
      print('  posts', leg.posts);
    });
    console.log('');
    return;
  }

  if (command === 'initiate') {
    const { purchase } = await StablecoinTreasuryEngine.initiate({
      amountCents: dollarsToCents(args.amount),
      initiatedBy: args.maker,
      memo: typeof args.memo === 'string' ? args.memo : null,
    });
    console.log('');
    showPurchase(purchase);
    console.log('\n  A second trustee must approve before Circle is called.\n');
    return;
  }

  if (command === 'approve') {
    const purchase = await StablecoinTreasuryEngine.approve(args.id, args.checker);
    console.log('');
    showPurchase(purchase);
    console.log('');
    return;
  }

  if (command === 'wire') {
    const purchase = await StablecoinTreasuryEngine.recordWire(args.id, {
      reference: args.reference,
      sentBy: typeof args.by === 'string' ? args.by : null,
    });
    console.log('');
    showPurchase(purchase);
    console.log('\n  Dollars are now in transit to Circle. Transfer once Circle shows the balance.\n');
    return;
  }

  if (command === 'transfer') {
    if (!args.yes) throw new Error('transfer moves real money at Circle: pass --yes to confirm');
    const purchase = await StablecoinTreasuryEngine.transfer(args.id, {
      executedBy: typeof args.by === 'string' ? args.by : null,
    });
    console.log('');
    showPurchase(purchase);
    console.log('\n  Run confirm once Horizon shows the tokens; the ledger posts only then.\n');
    return;
  }

  if (command === 'confirm') {
    const result = await StablecoinTreasuryEngine.confirm(args.id, {
      confirmedBy: typeof args.by === 'string' ? args.by : null,
    });
    console.log('');
    if (result.confirmed === false) {
      print('not yet', result.reason);
      console.log('');
      process.exitCode = 1;
      return;
    }
    showPurchase(result.purchase);
    console.log('');
    return;
  }

  if (command === 'list') {
    const rows = await StablecoinTreasuryEngine.list({
      status: typeof args.status === 'string' ? args.status : null,
    });
    console.log('');
    if (!rows.length) console.log('  no USDC purchases');
    rows.forEach(row => {
      console.log(`  ${row.purchase_id}  ${String(row.status).padEnd(16)} $${(Number(row.amount_cents) / 100).toFixed(2)}`);
    });
    console.log('');
    return;
  }

  throw new Error(`Unknown command "${command}"`);
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch(error => {
    console.error(`\nFailed: ${error.message}\n`);
    process.exit(1);
  });
