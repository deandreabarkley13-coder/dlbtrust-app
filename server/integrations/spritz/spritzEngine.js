'use strict';

/**
 * SpritzEngine — crypto-to-fiat off-ramp via Spritz Finance.
 *
 * Wraps the @spritz-finance/api-client to:
 * - create / recover Spritz users per email
 * - manage bank accounts / cards / bills
 * - create payment requests (off-ramps)
 * - return EVM calldata and optionally execute the on-chain `payWithToken` call
 *   from the operator wallet.
 */

const { query } = require('../bonds/pgPool');
const { getConfig } = require('../dapp/config');

let SpritzApiClient, Environment, PaymentNetwork, BankAccountType, BankAccountSubType;
try {
  const m = require('@spritz-finance/api-client');
  SpritzApiClient = m.SpritzApiClient;
  Environment = m.Environment;
  PaymentNetwork = m.PaymentNetwork;
  BankAccountType = m.BankAccountType;
  BankAccountSubType = m.BankAccountSubType;
} catch (e) {
  console.warn('[SpritzEngine] api-client not available:', e.message);
}

function envVal(key, def = '') { return (process.env[key] || def).trim(); }
function envBool(key, def = false) { const v = process.env[key]; return v ? String(v).toLowerCase() === 'true' : def; }

async function ensureTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS spritz_users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      user_id TEXT,
      api_key TEXT,
      environment TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `, []);
}

class SpritzEngine {
  static _getIntegrationKey() {
    const key = envVal('SPRITZ_API_KEY');
    if (!key) throw new Error('SPRITZ_API_KEY not configured');
    return key;
  }

  static _getEnvironment() {
    const cfg = envVal('SPRITZ_ENV', 'Production');
    if (cfg.toLowerCase() === 'sandbox' || cfg.toLowerCase() === 'staging') return Environment.Sandbox;
    return Environment.Production;
  }

  static _baseClient() {
    if (!SpritzApiClient) throw new Error('Spritz API client not available');
    return SpritzApiClient.initialize({
      environment: this._getEnvironment(),
      integrationKey: this._getIntegrationKey(),
    });
  }

  static async _getUserRow(email) {
    await ensureTable();
    const res = await query('SELECT * FROM spritz_users WHERE email = $1', [email.toLowerCase()]);
    return res.rows[0] || null;
  }

  static async _saveUser(email, userId, apiKey) {
    await ensureTable();
    await query(
      `INSERT INTO spritz_users (email, user_id, api_key, environment)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET user_id = EXCLUDED.user_id, api_key = EXCLUDED.api_key, environment = EXCLUDED.environment, updated_at = NOW()`,
      [email.toLowerCase(), userId, apiKey, String(this._getEnvironment())]
    );
  }

  static async _getUserClient(email) {
    const row = await this._getUserRow(email);
    const client = this._baseClient();
    if (row && row.api_key) {
      client.setApiKey(row.api_key);
      return { client, userId: row.user_id };
    }
    // Create user
    const user = await client.user.create({ email });
    if (!user || !user.apiKey) throw new Error('Spritz user creation did not return apiKey');
    client.setApiKey(user.apiKey);
    await this._saveUser(email, user.userId || user.id || null, user.apiKey);
    return { client, userId: user.userId || user.id };
  }

  static async getUser(email) {
    const { client } = await this._getUserClient(email);
    return client.user.getCurrentUser();
  }

  static async getUserAccess(email) {
    const { client } = await this._getUserClient(email);
    return client.user.getUserAccess();
  }

  static async getVerificationParams(email) {
    const { client } = await this._getUserClient(email);
    return client.user.getVerificationParams();
  }

  static async listBankAccounts(email) {
    const { client } = await this._getUserClient(email);
    return client.bankAccount.list();
  }

  static async createUSBankAccount(email, { accountNumber, routingNumber, name, subType = 'Checking' } = {}) {
    if (!accountNumber || !routingNumber || !name) throw new Error('accountNumber, routingNumber, and name required');
    const { client } = await this._getUserClient(email);
    const sub = String(subType).toLowerCase() === 'savings' ? BankAccountSubType.Savings : BankAccountSubType.Checking;
    return client.bankAccount.create(BankAccountType.USBankAccount, {
      accountNumber,
      routingNumber,
      name,
      ownedByUser: true,
      subType: sub,
    });
  }

  static async createPlaidLinkToken(email, { redirectUri } = {}) {
    const { client } = await this._getUserClient(email);
    return client.bankAccount.createLinkToken(redirectUri ? { redirectUri } : undefined);
  }

  static async completePlaidLink(email, { publicToken, accountIds, institutionId, institutionName } = {}) {
    if (!publicToken || !accountIds) throw new Error('publicToken and accountIds required');
    const { client } = await this._getUserClient(email);
    return client.bankAccount.completeLinking({ publicToken, accountIds, institutionId, institutionName });
  }

  static async createPaymentRequest(email, { amount, accountId, network = 'Ethereum', deliveryMethod, amountMode } = {}) {
    if (!amount || !accountId) throw new Error('amount and accountId required');
    const { client } = await this._getUserClient(email);
    const net = PaymentNetwork[Object.keys(PaymentNetwork).find(k => k.toLowerCase() === String(network).toLowerCase()) || 'Ethereum'] || PaymentNetwork.Ethereum;
    const opts = { amount: Number(amount), accountId, network: net };
    if (deliveryMethod) opts.deliveryMethod = deliveryMethod;
    if (amountMode) opts.amountMode = amountMode;
    return client.paymentRequest.create(opts);
  }

  static async getWeb3PaymentParams(email, { paymentRequestId, paymentTokenAddress } = {}) {
    if (!paymentRequestId || !paymentTokenAddress) throw new Error('paymentRequestId and paymentTokenAddress required');
    const { client } = await this._getUserClient(email);
    // Re-fetch payment request object
    const requests = await client.paymentRequest.list();
    const paymentRequest = (requests || []).find(r => r.id === paymentRequestId);
    if (!paymentRequest) throw new Error('Payment request not found');
    return client.paymentRequest.getWeb3PaymentParams({ paymentRequest, paymentTokenAddress });
  }

  static async fulfillFromWallet(email, { paymentRequestId, paymentTokenAddress, fromWalletId } = {}) {
    const params = await this.getWeb3PaymentParams(email, { paymentRequestId, paymentTokenAddress });
    // We can either return params for the caller to sign, or execute from operator wallet.
    // For server-side execution we need the USDC in the wallet; caller must move funds first.
    return { params, fromWalletId: fromWalletId || null };
  }
}

module.exports = { SpritzEngine, BankAccountType, BankAccountSubType, PaymentNetwork };
