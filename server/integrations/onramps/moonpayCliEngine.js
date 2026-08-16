'use strict';

/**
 * MoonPay CLI Adapter
 *
 * Wraps the `@moonpay/cli` (`mp`) executable so the PTC OS engines can
 * generate fiat-to-crypto on-ramp URLs, list local wallets, check balances,
 * and move settled funds without a custodial API key. The CLI is
 * non-custodial: keys are encrypted locally and the agent only ever handles
 * signed checkout URLs and on-chain transactions.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const CLI = process.env.MOONPAY_CLI_PATH || 'mp';

function chainName(chainId) {
  const id = Number(chainId);
  if (id === 8453) return 'base';
  if (id === 1) return 'ethereum';
  if (id === 137) return 'polygon';
  if (id === 42161) return 'arbitrum';
  if (id === 10) return 'optimism';
  if (id === 56) return 'bnb';
  if (id === 43114) return 'avalanche';
  if (id === 84532) return 'base-sepolia';
  if (id === 11155111) return 'ethereum-sepolia';
  return 'base';
}

function tokenSymbol(asset) {
  const a = String(asset || 'USDC').toUpperCase();
  if (a === 'ETH') return 'ETH';
  if (a === 'USDC') return 'USDC';
  if (a === 'USDT') return 'USDT';
  if (a === 'DAI') return 'DAI';
  return a;
}

async function mp(args, { timeout = 60000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(CLI, ['--json', ...args], { timeout, env: process.env });
    if (stderr && stderr.trim()) console.warn(`[moonpay-cli] stderr: ${stderr.trim()}`);
    if (!stdout || !stdout.trim()) return {};
    return JSON.parse(stdout);
  } catch (err) {
    let parsed = null;
    try { parsed = JSON.parse(err.stdout || ''); } catch {}
    if (parsed && parsed.error) {
      const e = new Error(parsed.error.message || 'MoonPay CLI error');
      e.code = parsed.error.code;
      throw e;
    }
    throw new Error(`MoonPay CLI failed (${err.code || err.message || err})`);
  }
}

class MoonPayCliEngine {
  static chainName(chainId) { return chainName(chainId); }

  static tokenSymbol(asset) { return tokenSymbol(asset); }

  static async readiness() {
    try {
      const user = await mp(['user', 'retrieve'], { timeout: 30000 });
      return { ready: true, mode: 'cli', authenticated: true, email: user.email, issues: [] };
    } catch (e) {
      return { ready: false, mode: 'cli', authenticated: false, issues: [e.message] };
    }
  }

  static async walletList() {
    return await mp(['wallet', 'list'], { timeout: 30000 });
  }

  static async createWallet(name = 'ptc-treasury') {
    return await mp(['wallet', 'create', '--name', name], { timeout: 60000 });
  }

  /**
   * Generate a signed MoonPay checkout URL so a buyer can complete the
   * fiat-to-crypto purchase. Returns { url, guide, currencyCode, walletAddress }.
   */
  static async buyUrl({ asset = 'USDC', chainId = 8453, walletAddress, amount, fiatCurrency = 'usd', explanation = 'PTC treasury on-ramp' } = {}) {
    if (!walletAddress) throw new Error('walletAddress required');
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    const chain = chainName(chainId);
    const token = tokenSymbol(asset);
    const result = await mp([
      'buy',
      '--token', token,
      '--chain', chain,
      '--wallet', walletAddress,
      '--amount', String(amount),
      '--explanation', explanation,
    ], { timeout: 60000 });
    if (!result || !result.url) throw new Error('MoonPay did not return a checkout URL');
    return {
      url: result.url,
      guide: result.guide,
      currencyCode: `${token.toLowerCase()}_${chain}`,
      walletAddress,
      amount: Number(amount),
      chain,
      token,
    };
  }

  static async tokenBalanceList({ walletAddress, walletName, chainId = 8453 } = {}) {
    const chain = chainName(chainId);
    const wallet = walletName || walletAddress;
    if (!wallet) throw new Error('walletName or walletAddress required');
    return await mp(['token', 'balance', 'list', '--wallet', wallet, '--chain', chain], { timeout: 60000 });
  }

  static async tokenTransfer({ walletName, chainId = 8453, tokenAddress, amount, to, explanation = 'PTC treasury transfer' } = {}) {
    if (!walletName || !tokenAddress || !amount || !to) throw new Error('walletName, tokenAddress, amount, and to required');
    const chain = chainName(chainId);
    return await mp([
      'token', 'transfer',
      '--wallet', walletName,
      '--chain', chain,
      '--token', tokenAddress,
      '--amount', String(amount),
      '--to', to,
      '--explanation', explanation,
    ], { timeout: 120000 });
  }

  static async virtualAccountRetrieve() {
    return await mp(['virtual-account', 'retrieve'], { timeout: 30000 });
  }

  static async virtualAccountOnrampCreate({ name = 'PTC Treasury On-Ramp', fiat = 'usd', stablecoin = 'usdc', wallet, chainId = 8453, explanation = 'PTC treasury fiat on-ramp' } = {}) {
    if (!wallet) throw new Error('wallet required');
    const chain = chainName(chainId);
    return await mp([
      'virtual-account', 'onramp', 'create',
      '--name', name,
      '--fiat', fiat,
      '--stablecoin', stablecoin,
      '--wallet', wallet,
      '--chain', chain,
      '--explanation', explanation,
    ], { timeout: 60000 });
  }

  static async virtualAccountOnrampList() {
    return await mp(['virtual-account', 'onramp', 'list'], { timeout: 30000 });
  }
}

module.exports = { MoonPayCliEngine };
