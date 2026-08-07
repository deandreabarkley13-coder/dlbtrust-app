'use strict';

/**
 * SpritzEngine — crypto-to-fiat off-ramp via the Spritz Finance API.
 *
 * Uses the user API key (SPRITZ_API_KEY) as a Bearer token against
 * https://platform.spritz.finance. Supports bank-account management,
 * off-ramp quotes, on-chain transaction params, and execution from an
 * internal DLB wallet.
 */

const { getConfig } = require('../dapp/config');

let viem, chains, privateKeyToAccount;
try { viem = require('viem'); chains = require('viem/chains'); ({ privateKeyToAccount } = require('viem/accounts')); } catch (e) { viem = null; chains = null; privateKeyToAccount = null; }

const erc20Abi = [
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'allowance', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
];

const SUPPORTED_CHAINS = ['ethereum','polygon','arbitrum','base','optimism','avalanche','binance-smart-chain','solana','bitcoin','dash','tron','sui','hyperevm','monad','sonic','unichain'];
const SUPPORTED_RAILS = ['ach_standard','ach_same_day','rtp','wire','eft','sepa','faster_payments','push_to_card','push_to_debit','bill_pay','card_deposit'];

function str(name, def = '') { return (process.env[name] || def).trim(); }
function baseUrl() { return str('SPRITZ_API_BASE_URL', 'https://platform.spritz.finance').replace(/\/$/, ''); }
function apiKey() {
  const key = str('SPRITZ_API_KEY');
  if (!key) throw new Error('SPRITZ_API_KEY not configured');
  return key;
}
function useProxy() { return str('SPRITZ_USE_PROXY', 'false').toLowerCase() === 'true' || baseUrl() !== 'https://platform.spritz.finance'; }

function cleanPath(p) { return p.startsWith('/') ? p : '/' + p; }

async function spritzRequest(method, path, body) {
  const url = baseUrl() + cleanPath(path);
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'dlbtrust-spritz-engine/1.0',
    Origin: 'https://dlbtrust-app.fly.dev',
  };
  if (useProxy()) {
    headers['x-spritz-key'] = apiKey();
    const proxyAuth = str('SPRITZ_PROXY_AUTH');
    if (proxyAuth) headers['Authorization'] = proxyAuth;
  } else {
    headers['Authorization'] = `Bearer ${apiKey()}`;
  }
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Spritz API ${method} ${path} failed: ${res.status} ${res.statusText} — ${text || 'no body'}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

class SpritzEngine {
  static async getUser() {
    return spritzRequest('GET', '/v1/users/me');
  }

  static async listBankAccounts() {
    return spritzRequest('GET', '/v1/bank-accounts/');
  }

  static async deleteBankAccount(accountId) {
    if (!accountId) throw new Error('accountId required');
    return spritzRequest('DELETE', `/v1/bank-accounts/${accountId}`);
  }

  static async createUSBankAccount({ routingNumber, accountNumber, accountSubtype = 'checking', ownership = 'personal', label } = {}) {
    if (!routingNumber || !accountNumber) throw new Error('routingNumber and accountNumber required');
    const body = {
      type: 'us',
      ownership,
      routingNumber,
      accountNumber,
      accountSubtype: accountSubtype.toLowerCase(),
    };
    if (label) body.label = label;
    return spritzRequest('POST', '/v1/bank-accounts/', body);
  }

  static async createOffRampQuote({ accountId, amount, chain = 'ethereum', tokenAddress, amountMode = 'output', rail = 'ach_standard', memo } = {}) {
    if (!accountId || amount === undefined || amount === null) throw new Error('accountId and amount required');
    const c = String(chain).toLowerCase();
    if (!SUPPORTED_CHAINS.includes(c)) throw new Error(`Unsupported chain: ${chain}`);
    const r = String(rail).toLowerCase();
    if (!SUPPORTED_RAILS.includes(r)) throw new Error(`Unsupported rail: ${rail}`);
    const body = { accountId, amount: String(amount), chain: c, rail: r, amountMode: amountMode === 'input' ? 'input' : 'output' };
    if (tokenAddress) body.tokenAddress = tokenAddress;
    if (memo) body.memo = memo;
    return spritzRequest('POST', '/v1/off-ramp-quotes/', body);
  }

  static async getOffRampQuote(quoteId) {
    if (!quoteId) throw new Error('quoteId required');
    return spritzRequest('GET', `/v1/off-ramp-quotes/${quoteId}`);
  }

  static async getTransactionParams(quoteId, { senderAddress, feePayer } = {}) {
    if (!quoteId) throw new Error('quoteId required');
    const body = {};
    if (senderAddress) body.senderAddress = senderAddress;
    if (feePayer) body.feePayer = feePayer;
    return spritzRequest('POST', `/v1/off-ramp-quotes/${quoteId}/transaction`, body);
  }

  static async listOffRamps() {
    return spritzRequest('GET', '/v1/off-ramps/');
  }

  static async getOffRamp(offRampId) {
    if (!offRampId) throw new Error('offRampId required');
    return spritzRequest('GET', `/v1/off-ramps/${offRampId}`);
  }

  static async executeQuote(quoteId) {
    if (!viem || !privateKeyToAccount) throw new Error('viem not installed');
    const cfg = getConfig();
    if (!cfg.privateKey) throw new Error('DAPP_PRIVATE_KEY not configured');
    const account = privateKeyToAccount(cfg.privateKey);
    const chain = cfg.chainId === 1 ? (chains && chains.mainnet) : (chains && chains.sepolia) || undefined;
    const publicClient = viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) });
    const walletClient = viem.createWalletClient({ account, chain, transport: viem.http(cfg.rpcUrl) });
    const fees = cfg.getFees ? (cfg.getFees() || { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') }) : { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') };

    const params = await this.getTransactionParams(quoteId, { senderAddress: account.address });
    if (!params || params.type !== 'evm' || !params.contractAddress || !params.calldata) throw new Error('Invalid or non-EVM transaction params');
    const { contractAddress, calldata, inputToken, requiredTokenInput } = params;
    const required = BigInt(requiredTokenInput);

    const balance = await publicClient.readContract({ address: inputToken, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
    if (balance < required) throw new Error(`Insufficient ${inputToken} balance: have ${balance.toString()}, need ${required.toString()}`);

    const allowance = await publicClient.readContract({ address: inputToken, abi: erc20Abi, functionName: 'allowance', args: [account.address, contractAddress] });
    if (allowance < required) {
      const approveHash = await walletClient.writeContract({
        address: inputToken,
        abi: erc20Abi,
        functionName: 'approve',
        args: [contractAddress, required],
        gas: 100000n,
        ...fees,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 120000 });
    }

    const hash = await walletClient.sendTransaction({
      to: contractAddress,
      data: calldata,
      value: 0n,
      gas: 300000n,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`Spritz payment transaction reverted: ${hash}`);
    return { txHash: hash, quoteId, params };
  }

  static async listBills() {
    return spritzRequest('GET', '/v1/bills/');
  }

  static async activateBills({ termsText, termsTextVersion, acceptedAt } = {}) {
    const consent = {
      termsText: termsText || str('SPRITZ_BILLPAY_TERMS', 'I agree to the Spritz bill pay terms.'),
      termsTextVersion: termsTextVersion || str('SPRITZ_BILLPAY_TERMS_VERSION', '2026-01-01'),
      acceptedAt: acceptedAt || new Date().toISOString(),
    };
    return spritzRequest('POST', '/v1/bills/activate', { consent });
  }

  static async startBillVerification(activationId) {
    if (!activationId) throw new Error('activationId required');
    return spritzRequest('POST', '/v1/bills/start_verification', { activationId });
  }

  static async submitBillVerification(activationId, responses) {
    if (!activationId) throw new Error('activationId required');
    if (!Array.isArray(responses)) throw new Error('responses array required');
    return spritzRequest('POST', `/v1/bills/submit_verification/${activationId}`, { responses });
  }

  static async deleteBill(billId) {
    if (!billId) throw new Error('billId required');
    return spritzRequest('DELETE', `/v1/bills/${billId}`);
  }

  static async listCards() {
    return spritzRequest('GET', '/v1/cards/');
  }

  static async getCardBalance() {
    return spritzRequest('GET', '/v1/cards/balance');
  }

  static async listDebitCards() {
    return spritzRequest('GET', '/v1/debit-cards/');
  }

  static async createDebitCard(payload) {
    if (!payload || !payload.encryptedCardNumber) throw new Error('Encrypted card data required');
    return spritzRequest('POST', '/v1/debit-cards/', payload);
  }

  static async updateCardStatus(cardId, status) {
    if (!cardId || !status) throw new Error('cardId and status required');
    return spritzRequest('POST', `/v1/cards/${cardId}/update_status`, { status });
  }

  static async updateCardLimit(cardId, { amount, interval }) {
    if (!cardId || !amount || !interval) throw new Error('cardId, amount and interval required');
    return spritzRequest('POST', `/v1/cards/${cardId}/update_limit`, { spendLimit: { amount: String(amount), interval } });
  }
}

module.exports = { SpritzEngine, SUPPORTED_CHAINS, SUPPORTED_RAILS };
