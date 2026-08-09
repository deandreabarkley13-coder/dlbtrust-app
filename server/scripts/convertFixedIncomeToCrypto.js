'use strict';

/**
 * Convert DLB-PRB fixed-income balances (principal or accrued interest)
 * into on-chain DAI, USDS, USDC, ETH, or WETH and sweep to a master wallet.
 *
 * Usage:
 *   node server/scripts/convertFixedIncomeToCrypto.js [bond-name] \
 *     --target-asset=DAI|USDS|USDC|ETH|WETH \
 *     [--amount=0.10] \
 *     [--principal] \
 *     [--recipient=0x...] \
 *     [--reconcile] \
 *     [--dry-run] \
 *     [--skip-ledger-credit]
 *
 * Defaults:
 *   bond-name: DLB-PRB
 *   target-asset: DAI
 *   source: bond_interest (use --principal for bond principal)
 *   recipient: Income Distribution Master wallet
 */

require('dotenv').config();

const { BondEngine } = require('../integrations/bonds/bondEngine');
const { LiveBondEngine } = require('../integrations/bonds/liveEngine');
const { BondTrustReconciliation } = require('../integrations/bonds/bondTrustReconciliation');
const { StablecoinDexEngine } = require('../integrations/dapp/stablecoinDexEngine');
const { MasterWalletEngine } = require('../integrations/dapp/masterWalletEngine');
const { WalletEngine } = require('../integrations/dapp/walletEngine');
const pool = require('../integrations/bonds/pgPool');

const DEFAULT_TARGET_ASSET = 'DAI';
const DEFAULT_BOND_NAME = 'DLB-PRB';

function parseArgs() {
  const argv = {
    targetAsset: process.env.TARGET_ASSET || DEFAULT_TARGET_ASSET,
    amount: process.env.AMOUNT,
    principal: false,
    reconcile: false,
    dryRun: false,
    skipLedgerCredit: false,
    bondName: null,
    recipient: process.env.RECIPIENT || null,
  };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--principal') argv.principal = true;
    else if (a === '--reconcile') argv.reconcile = true;
    else if (a === '--dry-run') argv.dryRun = true;
    else if (a === '--skip-ledger-credit') argv.skipLedgerCredit = true;
    else if (a.startsWith('--target-asset=')) argv.targetAsset = a.split('=').slice(1).join('=').trim();
    else if (a.startsWith('--amount=')) argv.amount = a.split('=').slice(1).join('=').trim();
    else if (a.startsWith('--recipient=')) argv.recipient = a.split('=').slice(1).join('=').trim();
    else if (a.startsWith('--')) throw new Error(`Unknown option: ${a}`);
    else if (!argv.bondName) argv.bondName = a;
  }
  if (!argv.bondName) argv.bondName = DEFAULT_BOND_NAME;
  return argv;
}

function usage() {
  console.log(`
Usage: node server/scripts/convertFixedIncomeToCrypto.js [bond-name] [options]

Options:
  --target-asset=DAI|USDS|USDC|ETH|WETH   Output stablecoin/crypto (default: DAI)
  --amount=N                             USD amount to convert (default: all available)
  --principal                            Convert principal balance instead of accrued interest
  --recipient=0x...                      Destination address (default: Income Distribution Master)
  --reconcile                            Re-run BondTrustReconciliation first
  --dry-run                              Quote only; do not sign or broadcast transactions
  --skip-ledger-credit                   Do not credit the internal wallet ledger after on-chain receipt
`);
}

async function resolveBond(bondName) {
  const { rows } = await pool.query(
    'SELECT id, bond_name FROM bonds WHERE bond_name = $1 OR isin = $1 LIMIT 1',
    [bondName]
  );
  if (!rows.length) throw new Error(`Bond not found: ${bondName}`);
  return { id: rows[0].id, name: rows[0].bond_name };
}

async function ensureDistributionWallet(argv) {
  if (argv.recipient) {
    const byAddress = await WalletEngine.getWalletByAddress(argv.recipient);
    if (byAddress) return byAddress;
    return { address: argv.recipient, id: null, external: true };
  }
  const wallet = await MasterWalletEngine.getDistributionWallet();
  if (!wallet) throw new Error('Income Distribution Master wallet not found. Run MasterWalletEngine.ensureMasterWallets first.');
  return wallet;
}

async function reconcileBond(bondId, bondName) {
  console.log(`[convertFixedIncome] Reconciling ${bondName} (id=${bondId}) ...`);
  await pool.query(
    `DELETE FROM bond_transactions
     WHERE bond_id = $1
       AND (description LIKE 'Scheduled principal payment%'
            OR description LIKE 'Scheduled interest payment%'
            OR description LIKE 'Amortized interest accrual%')`,
    [bondId]
  );
  const result = await BondTrustReconciliation.sync(bondId);
  console.log('[convertFixedIncome] Reconciled:', JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const argv = parseArgs();

  console.log(`[convertFixedIncome] target=${argv.targetAsset} principal=${argv.principal} reconcile=${argv.reconcile} dryRun=${argv.dryRun}`);

  const bond = await resolveBond(argv.bondName);
  console.log(`[convertFixedIncome] Resolved bond: ${bond.name} (id=${bond.id})`);

  if (argv.reconcile) await reconcileBond(bond.id, bond.name);

  const metrics = await LiveBondEngine.getBondLiveMetrics(bond.id);
  console.log('[convertFixedIncome] Live metrics:', {
    principal_balance: metrics.principal_balance,
    accrued_interest_total: metrics.accrued_interest_total,
    total_current_value: metrics.total_current_value,
    next_coupon_date: metrics.next_coupon_date,
  });

  const sourceType = argv.principal ? 'bond' : 'bond_interest';
  const available = argv.principal ? Number(metrics.principal_balance || 0) : Number(metrics.accrued_interest_total || 0);
  if (available <= 0) throw new Error(`No ${argv.principal ? 'principal' : 'accrued interest'} available for conversion`);

  const requestedAmount = argv.amount ? Number(argv.amount) : available;
  if (requestedAmount <= 0) throw new Error('Amount must be positive');
  if (requestedAmount > available + 1e-9) throw new Error(`Requested ${requestedAmount} exceeds available ${available}`);

  const amount = Math.round(requestedAmount * 100) / 100;
  console.log(`[convertFixedIncome] Converting ${amount} USD of ${sourceType} to ${argv.targetAsset}`);

  const recipientWallet = await ensureDistributionWallet(argv);
  console.log(`[convertFixedIncome] Recipient: ${recipientWallet.address}${recipientWallet.id ? ` (wallet ${recipientWallet.id})` : ''}`);

  if (argv.dryRun) {
    const token = await StablecoinDexEngine.getOrCreateDLBUSDToken();
    const tokenOut = StablecoinDexEngine.targetTokenAddress(argv.targetAsset);
    if (!tokenOut) throw new Error(`Unsupported target asset: ${argv.targetAsset}`);
    const quote = await StablecoinDexEngine.quote({
      amount,
      targetAsset: ['DAI', 'ETH', 'USDS', 'USDC'].includes(argv.targetAsset.toUpperCase()) ? 'WETH' : argv.targetAsset,
      poolAddress: process.env.BOND_DEX_ADDRESS,
    });
    console.log('[convertFixedIncome] Dry-run quote (first leg DLBUSD -> WETH):', JSON.stringify(quote, null, 2));
    if (['DAI', 'USDS', 'USDC'].includes(argv.targetAsset.toUpperCase())) {
      const wethAddress = StablecoinDexEngine.getConfig().wethAddress;
      const usdcAddress = StablecoinDexEngine.getConfig().usdcAddress;
      const outAddress = StablecoinDexEngine.targetTokenAddress(argv.targetAsset);
      const decimalsOut = argv.targetAsset.toUpperCase() === 'DAI' || argv.targetAsset.toUpperCase() === 'USDS' ? 18 : 6;
      const secondQuote = await require('../integrations/dapp/dexSwapEngine').DexSwapEngine.quoteUniswapV2({
        path: [wethAddress, outAddress],
        amountIn: quote.amountOut,
        decimalsIn: 18,
        decimalsOut,
      });
      console.log(`[convertFixedIncome] Dry-run quote (second leg WETH -> ${argv.targetAsset}):`, JSON.stringify(secondQuote, null, 2));
    }
    console.log('[convertFixedIncome] Dry run complete; no transactions broadcast.');
    return;
  }

  const result = await StablecoinDexEngine.depositAndSwap({
    sourceType,
    sourceAccountId: bond.id,
    amount,
    targetAsset: argv.targetAsset,
    recipient: recipientWallet.address,
    poolAddress: process.env.BOND_DEX_ADDRESS,
  });

  console.log('[convertFixedIncome] Swap result:', JSON.stringify({
    operationId: result.operationId,
    sourceType: result.sourceType,
    sourceAccountId: result.sourceAccountId,
    amount: result.amount,
    targetAsset: result.targetAsset,
    actualTargetAsset: result.actualTargetAsset,
    amountOut: result.amountOut,
    mintTxHash: result.mintTxHash,
    poolAddress: result.poolAddress,
    recipient: result.recipient,
    mode: result.mode,
  }, null, 2));

  if (result.amountOut && !argv.skipLedgerCredit && recipientWallet.id) {
    try {
      await WalletEngine.credit(
        recipientWallet.id,
        result.actualTargetAsset || argv.targetAsset,
        result.amountOut,
        {
          memo: `Fixed income ${sourceType} conversion from ${bond.name}`,
          operation_id: result.operationId,
          mint_tx_hash: result.mintTxHash,
          swap_tx_hash: result.swap && result.swap.txHash,
        }
      );
      console.log(`[convertFixedIncome] Credited ${result.amountOut} ${result.actualTargetAsset || argv.targetAsset} to wallet ${recipientWallet.id}`);
    } catch (creditErr) {
      console.warn('[convertFixedIncome] Internal ledger credit failed (tokens are already on-chain):', creditErr.message);
    }
  }

  console.log('[convertFixedIncome] Done');
}

main().catch(err => {
  console.error('[convertFixedIncome] Fatal error:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
