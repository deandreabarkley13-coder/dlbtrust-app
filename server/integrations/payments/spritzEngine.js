'use strict';

/**
 * Spritz Finance off-ramp integration.
 *
 * Uses the official @spritz-finance/api-client (https://github.com/spritz-finance/api-client)
 * to create users, bank accounts, payment requests, and then executes the on-chain
 * SpritzPayV3 contract call from the operator hot wallet.
 *
 * Required environment variables:
 *   SPRITZ_INTEGRATION_KEY  - Integrator key from https://app.spritz.finance/api-keys
 *   SPRITZ_ENVIRONMENT      - 'sandbox' (default) or 'production'
 *   SPRITZ_DEFAULT_EMAIL    - Trust email to use when creating the Spritz user
 *   DAPP_PRIVATE_KEY        - Operator hot wallet private key (same as stablecoin DEX)
 */

const { SpritzApiClient, Environment, PaymentNetwork, AmountMode, PaymentDeliveryMethod } = require('@spritz-finance/api-client');
const { getConfig: getDappConfig } = require('../dapp/config');
const { StablecoinDexEngine } = require('../dapp/stablecoinDexEngine');
const { WalletEngine } = require('../dapp/walletEngine');

let viem, chains, accountFns;
try { viem = require('viem'); chains = require('viem/chains'); accountFns = require('viem/accounts'); } catch (e) { viem = null; }

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

function str(name, fallback = '') { return (process.env[name] || fallback).trim(); }
function id(prefix = 'SRTZ') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

async function dbQuery(sql, params) {
  if (!pool) throw new Error('Postgres pool unavailable');
  return pool.query(sql, params);
}

async function withFallback(fn, fallback) {
  try { return await fn(); } catch (e) { if (!pool) return fallback(e); throw e; }
}

const memoryUsers = new Map();

const erc20Abi = [
  { type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'allowance', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
];

class SpritzEngine {
  static getConfig() {
    const env = (str('SPRITZ_ENVIRONMENT', 'sandbox') || 'sandbox').toLowerCase();
    const environment = env === 'production' ? Environment.Production : Environment.Sandbox;
    return {
      integrationKey: str('SPRITZ_INTEGRATION_KEY', ''),
      environment,
      baseUrl: env === 'production' ? 'https://platform.spritz.finance' : 'https://sandbox.spritz.finance',
      defaultEmail: str('SPRITZ_DEFAULT_EMAIL', ''),
      enabled: Boolean(str('SPRITZ_INTEGRATION_KEY', '')),
    };
  }

  static isConfigured() {
    return Boolean(this.getConfig().integrationKey);
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.enabled) issues.push('SPRITZ_INTEGRATION_KEY not set');
    if (!cfg.defaultEmail) issues.push('SPRITZ_DEFAULT_EMAIL not set');
    const dapp = getDappConfig();
    if (!dapp.privateKey) issues.push('DAPP_PRIVATE_KEY not configured');
    return { ready: issues.length === 0, rail: 'spritz', mode: cfg.environment === Environment.Production ? 'production' : 'sandbox', issues };
  }

  static ensureTables() {
    return withFallback(async () => {
      await dbQuery(`
        CREATE TABLE IF NOT EXISTS dapp_spritz_users (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          spritz_user_id TEXT,
          api_key TEXT,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    }, () => {});
  }

  static client({ apiKey } = {}) {
    const cfg = this.getConfig();
    if (!cfg.integrationKey && !apiKey) throw new Error('Spritz integration key or user API key required');
    return SpritzApiClient.initialize({
      environment: cfg.environment,
      integrationKey: cfg.integrationKey,
      apiKey,
    });
  }

  static async _storeUser(email, userId, apiKey) {
    await this.ensureTables();
    const encrypted = WalletEngine._encrypt(apiKey);
    const lower = String(email).toLowerCase();
    return withFallback(async () => {
      const existing = await dbQuery('SELECT id FROM dapp_spritz_users WHERE email = $1', [lower]);
      if (existing.rows.length) {
        await dbQuery('UPDATE dapp_spritz_users SET spritz_user_id = $1, api_key = $2, updated_at = NOW() WHERE email = $3', [userId, encrypted, lower]);
      } else {
        await dbQuery('INSERT INTO dapp_spritz_users (id, email, spritz_user_id, api_key) VALUES ($1, $2, $3, $4)', [id(), lower, userId, encrypted]);
      }
    }, () => { memoryUsers.set(lower, { userId, apiKey: encrypted }); });
  }

  static async _getStoredUser(email) {
    await this.ensureTables();
    const lower = String(email).toLowerCase();
    return withFallback(async () => {
      const rows = await dbQuery('SELECT * FROM dapp_spritz_users WHERE email = $1', [lower]);
      return rows.rows[0] || null;
    }, () => memoryUsers.get(lower) || null);
  }

  static async getOrCreateUser(email) {
    if (!email) throw new Error('Spritz email required');
    const lower = String(email).toLowerCase();
    const stored = await this._getStoredUser(lower);
    if (stored && stored.api_key) {
      const apiKey = WalletEngine._decrypt(stored.api_key);
      return { email: lower, userId: stored.spritz_user_id, apiKey };
    }
    const client = this.client();
    const user = await client.user.create({ email: lower });
    if (!user.apiKey) throw new Error('Spritz user creation did not return an API key');
    await this._storeUser(lower, user.userId, user.apiKey);
    return { email: lower, userId: user.userId, apiKey: user.apiKey };
  }

  static async createBankAccount({ apiKey, type, ...details } = {}) {
    if (!apiKey) throw new Error('apiKey required');
    if (!type) throw new Error('bank account type required');
    const client = this.client({ apiKey });
    return client.bankAccount.create({ type, ...details });
  }

  static async listBankAccounts(apiKey) {
    if (!apiKey) throw new Error('apiKey required');
    return this.client({ apiKey }).bankAccount.list();
  }

  static async createPaymentRequest({ apiKey, accountId, amount, network = PaymentNetwork.Ethereum, tokenAddress, deliveryMethod, amountMode = AmountMode.AMOUNT_RECEIVED, memo }) {
    if (!apiKey) throw new Error('apiKey required');
    if (!accountId) throw new Error('accountId required');
    const input = { accountId, amount: Number(amount), network };
    if (tokenAddress) input.tokenAddress = tokenAddress;
    if (deliveryMethod && PaymentDeliveryMethod[deliveryMethod]) input.deliveryMethod = PaymentDeliveryMethod[deliveryMethod];
    else if (deliveryMethod) input.deliveryMethod = deliveryMethod;
    if (amountMode) input.amountMode = amountMode;
    if (memo) input.memo = memo;
    return this.client({ apiKey }).paymentRequest.create(input);
  }

  static async getWeb3PaymentParams({ apiKey, paymentRequest, tokenAddress }) {
    if (!apiKey) throw new Error('apiKey required');
    return this.client({ apiKey }).paymentRequest.getWeb3PaymentParams({ paymentRequest, paymentTokenAddress: tokenAddress });
  }

  static async getPaymentForRequest(apiKey, paymentRequestId) {
    if (!apiKey || !paymentRequestId) return null;
    try { return await this.client({ apiKey }).payment.getForPaymentRequest(paymentRequestId); } catch (e) { return null; }
  }

  static _normalizePrivateKey(privateKey) {
    let pk = privateKey;
    if (pk && pk.length === 64 && !pk.startsWith('0x')) pk = '0x' + pk;
    return pk;
  }

  static _operatorWallet() {
    if (!viem) throw new Error('viem not installed');
    if (!accountFns) throw new Error('viem/accounts not installed');
    const dappCfg = getDappConfig();
    if (!dappCfg.privateKey) throw new Error('DAPP_PRIVATE_KEY not configured');
    const privateKey = this._normalizePrivateKey(dappCfg.privateKey);
    const account = accountFns.privateKeyToAccount(privateKey);
    const chain = dappCfg.chainId === 11155111 ? chains.sepolia : chains.mainnet;
    const publicClient = viem.createPublicClient({ chain, transport: viem.http(dappCfg.rpcUrl) });
    return { account, chain, publicClient, privateKey, config: dappCfg };
  }

  static async _signAndSend({ to, data, value = 0n, privateKey }) {
    if (!viem) throw new Error('viem not installed');
    if (!accountFns) throw new Error('viem/accounts not installed');
    const dappCfg = getDappConfig();
    if (!dappCfg.rpcUrl) throw new Error('DAPP_RPC_URL not configured');
    const pk = this._normalizePrivateKey(privateKey);
    const account = accountFns.privateKeyToAccount(pk);
    const chain = dappCfg.chainId === 11155111 ? chains.sepolia : chains.mainnet;
    const publicClient = viem.createPublicClient({ chain, transport: viem.http(dappCfg.rpcUrl) });
    const fees = dappCfg.getFees ? dappCfg.getFees() : { maxFeePerGas: viem.parseGwei('3'), maxPriorityFeePerGas: viem.parseGwei('0.1') };
    const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const estimated = await publicClient.estimateGas({ account: account.address, to, value: value || 0n, data: data || '0x', ...fees }).catch(() => 100000n);
    const gas = (estimated * 120n) / 100n;
    const tx = { to, data: data || '0x', value: value || 0n, gas, ...fees, nonce, chainId: BigInt(dappCfg.chainId || 1), type: 'eip1559' };
    const raw = await account.signTransaction(tx);
    const hash = await publicClient.sendRawTransaction({ serializedTransaction: raw });
    await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    return hash;
  }

  static async _approveIfNeeded({ tokenAddress, spender, requiredAmount, privateKey }) {
    if (!viem) throw new Error('viem not installed');
    const { account, publicClient } = this._operatorWallet();
    const allowance = await publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'allowance', args: [account.address, spender] });
    if (BigInt(allowance) >= BigInt(requiredAmount)) return null;
    const data = viem.encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, BigInt(requiredAmount)] });
    return this._signAndSend({ to: tokenAddress, data, value: 0n, privateKey });
  }

  static async payPaymentRequest({ apiKey, paymentRequest, tokenAddress, tokenDecimals = 18 }) {
    if (!apiKey) throw new Error('apiKey required');
    if (!paymentRequest || !paymentRequest.id) throw new Error('paymentRequest required');
    const params = await this.getWeb3PaymentParams({ apiKey, paymentRequest, tokenAddress });
    if (!params || !params.contractAddress || !params.calldata) {
      throw new Error('Spritz did not return EVM transaction parameters');
    }
    const { account, publicClient, privateKey } = this._operatorWallet();
    const tokenBalance = await publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
    const required = BigInt(params.requiredTokenInput || 0);
    if (BigInt(tokenBalance) < required) {
      throw new Error(`Insufficient token balance for Spritz payment: have ${tokenBalance.toString()}, need ${required.toString()}`);
    }
    const approveHash = await this._approveIfNeeded({ tokenAddress, spender: params.contractAddress, requiredAmount: required, privateKey });
    const value = BigInt(params.value || 0);
    const payHash = await this._signAndSend({ to: params.contractAddress, data: params.calldata, value, privateKey });
    const payment = await this.getPaymentForRequest(apiKey, paymentRequest.id);
    return { paymentRequestId: paymentRequest.id, contractAddress: params.contractAddress, method: params.method, requiredTokenInput: required.toString(), approveHash, payHash, payment };
  }

  static async offRamp({ sourceType, sourceAccountId, amount, targetAsset = 'DAI', accountId, bankAccount, email, deliveryMethod, amountMode = AmountMode.AMOUNT_RECEIVED, bufferPercent = 5, memo } = {}) {
    if (!this.isConfigured()) throw new Error('Spritz engine not configured (SPRITZ_INTEGRATION_KEY)');
    if (!sourceType || !sourceAccountId) throw new Error('sourceType and sourceAccountId required');
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    const cfg = this.getConfig();
    const userEmail = email || cfg.defaultEmail;
    if (!userEmail) throw new Error('email or SPRITZ_DEFAULT_EMAIL required');

    const { apiKey } = await this.getOrCreateUser(userEmail);

    let accountIdUsed = accountId;
    if (!accountIdUsed && bankAccount) {
      const acct = await this.createBankAccount({ apiKey, ...bankAccount });
      accountIdUsed = acct.id;
    }
    if (!accountIdUsed) throw new Error('accountId or bankAccount details required');

    const targetUpper = String(targetAsset).toUpperCase();
    const tokenOut = StablecoinDexEngine.targetTokenAddress(targetUpper);
    const decimalsOut = StablecoinDexEngine.targetTokenDecimals(targetUpper);
    if (!tokenOut) throw new Error(`Target asset ${targetAsset} has no token address configured`);

    // Source enough USD to cover the fiat amount + slippage/fees.
    const sourcedUsd = Number(amount) * (1 + Number(bufferPercent || 0) / 100);
    const swap = await StablecoinDexEngine.depositAndSwap({
      sourceType,
      sourceAccountId,
      amount: sourcedUsd,
      targetAsset: targetUpper,
      recipient: undefined,
    });
    if (!swap || !swap.amountOut) throw new Error('Stablecoin DEX swap did not produce output tokens');

    const paymentRequest = await this.createPaymentRequest({
      apiKey,
      accountId: accountIdUsed,
      amount: Number(amount),
      network: PaymentNetwork.Ethereum,
      tokenAddress: tokenOut,
      deliveryMethod,
      amountMode,
      memo,
    });

    const payment = await this.payPaymentRequest({ apiKey, paymentRequest, tokenAddress: tokenOut, tokenDecimals: decimalsOut });

    return {
      success: true,
      offRampId: payment.payment && payment.payment.id,
      paymentRequestId: payment.paymentRequestId,
      accountId: accountIdUsed,
      amount: Number(amount),
      targetAsset: targetUpper,
      tokenAddress: tokenOut,
      sourcedUsd,
      swap,
      payment,
    };
  }
}

module.exports = { SpritzEngine };
