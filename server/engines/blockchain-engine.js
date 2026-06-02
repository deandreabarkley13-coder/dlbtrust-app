/**
 * Blockchain Engine — Open-Source Private Stack + Circle Fallback
 * DEANDREA LAVAR BARKLEY TRUST — Crypto Rails for Private Trust Banking
 *
 * Unified engine for:
 *   1. PRIVATE STACK: Direct Polygon RPC via ethers.js (no API keys)
 *      - HD wallet generation (BIP39/BIP44)
 *      - Direct USDC contract interaction
 *      - Role-based access control (trustee, beneficiary, vendor)
 *      - Multi-sig approval for large transfers
 *   2. CIRCLE FALLBACK: Circle Programmable Wallets
 *   3. Trust governance (spending limits, approval thresholds)
 *
 * Provider modes: 'private' (open-source, no API keys) or 'circle' (API)
 *
 * All fiat amounts are strings with 2 decimal places for precision.
 * Internal cents conversions provided for ledger compatibility.
 */

'use strict';

const { ethers } = require('ethers');
const crypto = require('crypto');

// --- Constants ---------------------------------------------------------------

const CIRCLE_SANDBOX_URL = 'https://api-sandbox.circle.com';
const CIRCLE_PRODUCTION_URL = 'https://api.circle.com';

// --- RPC Endpoints (Public, Free — No API Keys) -----------------------------
const RPC_ENDPOINTS = {
  'MATIC':       'https://polygon-rpc.com',
  'MATIC-AMOY':  'https://rpc-amoy.polygon.technology',
  'ETH':         'https://ethereum-rpc.publicnode.com',
  'ETH-SEPOLIA': 'https://ethereum-sepolia-rpc.publicnode.com',
  'ARB':         'https://arb1.arbitrum.io/rpc',
  'AVAX':        'https://api.avax.network/ext/bc/C/rpc',
};

// --- USDC Contract Addresses Per Chain --------------------------------------
const USDC_CONTRACTS = {
  'MATIC':       '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',  // Native USDC on Polygon
  'MATIC-AMOY':  '0x41E94Eb71898E8B51d8b2611b8F73eE29A0bDbC2',  // Testnet USDC
  'ETH':         '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',  // USDC on Ethereum
  'ETH-SEPOLIA': '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',  // Testnet USDC
  'ARB':         '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',  // USDC on Arbitrum
  'AVAX':        '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',  // USDC on Avalanche
};

// --- ERC-20 ABI (minimal for USDC interaction) ------------------------------
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

// --- WPOL (Wrapped POL/MATIC) Addresses ------------------------------------
const WPOL_CONTRACTS = {
  'MATIC':      '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
  'MATIC-AMOY': '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // same on testnet
};

// --- DEX Router Addresses (QuickSwap V3 / Algebra) -------------------------
const DEX_ROUTERS = {
  'MATIC':      '0xf5b509bB0909a69B1c207E495f687a596C168E12', // QuickSwap V3 SwapRouter
  'MATIC-AMOY': '0xf5b509bB0909a69B1c207E495f687a596C168E12', // same contract
};

// --- DEX ABIs (QuickSwap V3 Algebra-based Router) --------------------------
const WPOL_ABI = [
  'function deposit() payable',
  'function withdraw(uint256 amount)',
  'function balanceOf(address account) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const SWAP_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

// --- Trust Access Roles -----------------------------------------------------
const TRUST_ROLES = {
  TRUSTEE:       'trustee',
  BENEFICIARY:   'beneficiary',
  VENDOR:        'vendor',
  AUDITOR:       'auditor',
  CO_TRUSTEE:    'co_trustee',
};

const ROLE_PERMISSIONS = {
  trustee:       { canSend: true, canApprove: true, canFreeze: true, canCreateWallet: true, canViewAll: true, maxDailyUsd: null },
  co_trustee:    { canSend: true, canApprove: true, canFreeze: true, canCreateWallet: true, canViewAll: true, maxDailyUsd: null },
  beneficiary:   { canSend: false, canApprove: false, canFreeze: false, canCreateWallet: false, canViewAll: false, maxDailyUsd: 5000 },
  vendor:        { canSend: false, canApprove: false, canFreeze: false, canCreateWallet: false, canViewAll: false, maxDailyUsd: 0 },
  auditor:       { canSend: false, canApprove: false, canFreeze: false, canCreateWallet: false, canViewAll: true, maxDailyUsd: 0 },
};

const SUPPORTED_BLOCKCHAINS = {
  'MATIC':       { name: 'Polygon',         type: 'mainnet', native: 'MATIC',  explorer: 'https://polygonscan.com' },
  'MATIC-AMOY':  { name: 'Polygon Amoy',    type: 'testnet', native: 'MATIC',  explorer: 'https://amoy.polygonscan.com' },
  'ETH':         { name: 'Ethereum',         type: 'mainnet', native: 'ETH',    explorer: 'https://etherscan.io' },
  'ETH-SEPOLIA': { name: 'Ethereum Sepolia', type: 'testnet', native: 'ETH',    explorer: 'https://sepolia.etherscan.io' },
  'ARB':         { name: 'Arbitrum',         type: 'mainnet', native: 'ETH',    explorer: 'https://arbiscan.io' },
  'SOL':         { name: 'Solana',           type: 'mainnet', native: 'SOL',    explorer: 'https://solscan.io' },
  'SOL-DEVNET':  { name: 'Solana Devnet',    type: 'testnet', native: 'SOL',    explorer: 'https://solscan.io/?cluster=devnet' },
  'AVAX':        { name: 'Avalanche',        type: 'mainnet', native: 'AVAX',   explorer: 'https://snowtrace.io' },
};

const WALLET_TYPES = {
  trust:       'Trust Corpus',
  beneficiary: 'Beneficiary',
  vendor:      'Vendor',
  expense:     'Expense',
  reserve:     'Reserve',
};

const TRANSFER_TYPES = {
  internal:       'Internal Transfer',
  external:       'External Transfer',
  distribution:   'Beneficiary Distribution',
  vendor_payment: 'Vendor Payment',
  expense:        'Expense Payment',
};

const TX_STATUS_MAP = {
  // Circle states → our states
  INITIATED:           'initiated',
  PENDING_RISK_SCREENING: 'submitted',
  QUEUED:              'submitted',
  SENT:                'confirming',
  CONFIRMED:           'completed',
  COMPLETE:            'completed',
  FAILED:              'failed',
  CANCELLED:           'cancelled',
  DENIED:              'failed',
};

const FIAT_STATUS_MAP = {
  pending:    'pending',
  confirmed:  'processing',
  paid:       'completed',
  complete:   'completed',
  failed:     'failed',
  returned:   'refunded',
};

// --- Number Generators -------------------------------------------------------

function generateChainTxNumber() {
  const d = new Date();
  const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `CHAIN-${dateStr}-${rand}`;
}

function generateFiatOrderNumber() {
  const d = new Date();
  const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `FIAT-${dateStr}-${rand}`;
}

function generateIdempotencyKey(prefix = 'dlb') {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${ts}_${rand}`;
}

function usdToCents(usdStr) {
  return Math.round(parseFloat(usdStr || '0') * 100);
}

function centsToUsd(cents) {
  return (cents / 100).toFixed(2);
}

// --- Circle API Client -------------------------------------------------------

class CircleClient {
  constructor(apiKey, environment = 'sandbox') {
    this.apiKey = apiKey;
    this.baseUrl = environment === 'production'
      ? CIRCLE_PRODUCTION_URL
      : CIRCLE_SANDBOX_URL;
  }

  async request(method, path, body = null, headers = {}) {
    const reqHeaders = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...headers,
    };

    const options = { method, headers: reqHeaders };
    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = JSON.stringify(body);
    }

    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, options);

    if (response.status === 204) return { success: true };

    const data = await response.json();

    if (!response.ok) {
      const err = new Error(
        data.message || data.code || `Circle API error ${response.status}`
      );
      err.status = response.status;
      err.circleError = data;
      throw err;
    }
    return data;
  }

  // --- Wallet Sets ---

  async createWalletSet({ name, idempotencyKey, entitySecretCiphertext }) {
    return this.request('POST', '/v1/w3s/developer/walletSets', {
      name,
      idempotencyKey: idempotencyKey || generateIdempotencyKey('wset'),
      entitySecretCiphertext,
    });
  }

  async listWalletSets(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request('GET', `/v1/w3s/developer/walletSets${qs ? '?' + qs : ''}`);
  }

  // --- Wallets ---

  async createWallet({ walletSetId, blockchains, count = 1, idempotencyKey, entitySecretCiphertext, metadata }) {
    return this.request('POST', '/v1/w3s/developer/wallets', {
      walletSetId,
      blockchains: blockchains || ['MATIC-AMOY'],
      count,
      idempotencyKey: idempotencyKey || generateIdempotencyKey('wal'),
      entitySecretCiphertext,
      metadata: metadata || [],
    });
  }

  async getWallet(walletId) {
    return this.request('GET', `/v1/w3s/developer/wallets/${walletId}`);
  }

  async listWallets(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request('GET', `/v1/w3s/developer/wallets${qs ? '?' + qs : ''}`);
  }

  async getWalletBalance(walletId) {
    return this.request('GET', `/v1/w3s/developer/wallets/${walletId}/balances`);
  }

  // --- Transfers (Wallet-to-Wallet / On-Chain) ---

  async createTransfer({ walletId, destinationAddress, amounts, tokenId, blockchain, idempotencyKey, entitySecretCiphertext }) {
    return this.request('POST', '/v1/w3s/developer/transactions/transfer', {
      walletId,
      destinationAddress,
      amounts: amounts || [],
      tokenId,
      blockchain,
      idempotencyKey: idempotencyKey || generateIdempotencyKey('txfr'),
      entitySecretCiphertext,
      feeLevel: 'MEDIUM',
    });
  }

  async getTransaction(txId) {
    return this.request('GET', `/v1/w3s/transactions/${txId}`);
  }

  async listTransactions(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request('GET', `/v1/w3s/transactions${qs ? '?' + qs : ''}`);
  }

  // --- Token Lookup ---

  async getTokenBalance(walletId) {
    return this.request('GET', `/v1/w3s/developer/wallets/${walletId}/balances`);
  }

  // --- Circle Mint: Balances ---

  async getMintBalances() {
    return this.request('GET', '/v1/businessAccount/balances');
  }

  // --- Circle Mint: Payouts (USDC → USD off-ramp) ---

  async createPayout({ destination, amount, currency = 'USD', idempotencyKey }) {
    return this.request('POST', '/v1/payouts', {
      destination,
      amount: { amount: amount.toString(), currency },
      idempotencyKey: idempotencyKey || generateIdempotencyKey('pout'),
    });
  }

  async getPayout(payoutId) {
    return this.request('GET', `/v1/payouts/${payoutId}`);
  }

  async listPayouts(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request('GET', `/v1/payouts${qs ? '?' + qs : ''}`);
  }

  // --- Circle Mint: Payments (USD → USDC on-ramp) ---

  async getMintDepositAddress() {
    return this.request('POST', '/v1/businessAccount/wallets/addresses/deposit', {
      currency: 'USD',
      chain: 'MATIC',
      idempotencyKey: generateIdempotencyKey('dep'),
    });
  }

  // --- Circle Mint: Bank Accounts ---

  async createBankAccount({ bankAddress, billingDetails, idempotencyKey }) {
    return this.request('POST', '/v1/businessAccount/banks/wires', {
      bankAddress,
      billingDetails,
      idempotencyKey: idempotencyKey || generateIdempotencyKey('bank'),
    });
  }

  async listBankAccounts() {
    return this.request('GET', '/v1/businessAccount/banks/wires');
  }

  async getBankAccountInstructions(bankId) {
    return this.request('GET', `/v1/businessAccount/banks/wires/${bankId}/instructions`);
  }

  // --- Healthcheck ---

  async ping() {
    try {
      await this.request('GET', '/ping');
      return true;
    } catch {
      return false;
    }
  }
}

// --- Wallet Manager ----------------------------------------------------------

class WalletManager {
  constructor(db) {
    this.db = db;
  }

  createWallet({ circleWalletId, circleWalletSetId, trustAccountId, contactId,
                 walletName, walletType, blockchain, address }) {
    const stmt = this.db.prepare(`
      INSERT INTO blockchain_wallets
        (circle_wallet_id, circle_wallet_set_id, trust_account_id, contact_id,
         wallet_name, wallet_type, blockchain, address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      circleWalletId, circleWalletSetId, trustAccountId || null,
      contactId || null, walletName, walletType || 'trust',
      blockchain || 'MATIC-AMOY', address || null
    );
    return this.getWallet(result.lastInsertRowid);
  }

  getWallet(id) {
    return this.db.prepare('SELECT * FROM blockchain_wallets WHERE id = ?').get(id);
  }

  getWalletByCircleId(circleWalletId) {
    return this.db.prepare('SELECT * FROM blockchain_wallets WHERE circle_wallet_id = ?').get(circleWalletId);
  }

  getWalletByAddress(address) {
    return this.db.prepare('SELECT * FROM blockchain_wallets WHERE address = ?').get(address);
  }

  listWallets(filters = {}) {
    let sql = 'SELECT * FROM blockchain_wallets WHERE 1=1';
    const params = [];
    if (filters.wallet_type) { sql += ' AND wallet_type = ?'; params.push(filters.wallet_type); }
    if (filters.status) { sql += ' AND status = ?'; params.push(filters.status); }
    if (filters.blockchain) { sql += ' AND blockchain = ?'; params.push(filters.blockchain); }
    if (filters.trust_account_id) { sql += ' AND trust_account_id = ?'; params.push(filters.trust_account_id); }
    sql += ' ORDER BY created_at DESC';
    return this.db.prepare(sql).all(...params);
  }

  updateBalance(id, usdcBalance, nativeBalance) {
    this.db.prepare(`
      UPDATE blockchain_wallets
      SET usdc_balance = ?, native_balance = ?, last_synced_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(usdcBalance, nativeBalance || '0.00', id);
  }

  updateStatus(id, status) {
    this.db.prepare(`
      UPDATE blockchain_wallets SET status = ?, updated_at = datetime('now') WHERE id = ?
    `).run(status, id);
  }

  getStats() {
    const total = this.db.prepare('SELECT COUNT(*) as count FROM blockchain_wallets').get().count;
    const active = this.db.prepare("SELECT COUNT(*) as count FROM blockchain_wallets WHERE status = 'active'").get().count;
    const totalUsdc = this.db.prepare("SELECT COALESCE(SUM(CAST(usdc_balance AS REAL)), 0) as total FROM blockchain_wallets WHERE status = 'active'").get().total;
    const byType = this.db.prepare("SELECT wallet_type, COUNT(*) as count FROM blockchain_wallets WHERE status = 'active' GROUP BY wallet_type").all();
    return { total, active, totalUsdc: totalUsdc.toFixed(2), byType };
  }
}

// --- Transaction Manager -----------------------------------------------------

class TransactionManager {
  constructor(db) {
    this.db = db;
  }

  createTransaction({ txNumber, circleTxId, fromWalletId, fromAddress,
                       toWalletId, toAddress, token, amount, amountCents,
                       blockchain, transferType, direction, description,
                       requiresApproval, idempotencyKey, initiatedBy }) {
    const stmt = this.db.prepare(`
      INSERT INTO blockchain_transactions
        (tx_number, circle_tx_id, from_wallet_id, from_address,
         to_wallet_id, to_address, token, amount, amount_cents,
         blockchain, transfer_type, direction, description,
         requires_approval, idempotency_key, initiated_by, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const status = requiresApproval ? 'pending_approval' : 'initiated';
    const result = stmt.run(
      txNumber || generateChainTxNumber(), circleTxId || null,
      fromWalletId || null, fromAddress || null,
      toWalletId || null, toAddress,
      token || 'USDC', amount, amountCents || usdToCents(amount),
      blockchain || 'MATIC-AMOY', transferType || 'internal',
      direction || 'outbound', description || null,
      requiresApproval ? 1 : 0,
      idempotencyKey || generateIdempotencyKey('ctx'),
      initiatedBy || 'system', status
    );
    return this.getTransaction(result.lastInsertRowid);
  }

  getTransaction(id) {
    return this.db.prepare('SELECT * FROM blockchain_transactions WHERE id = ?').get(id);
  }

  getTransactionByCircleId(circleTxId) {
    return this.db.prepare('SELECT * FROM blockchain_transactions WHERE circle_tx_id = ?').get(circleTxId);
  }

  listTransactions(filters = {}) {
    let sql = 'SELECT * FROM blockchain_transactions WHERE 1=1';
    const params = [];
    if (filters.status) { sql += ' AND status = ?'; params.push(filters.status); }
    if (filters.transfer_type) { sql += ' AND transfer_type = ?'; params.push(filters.transfer_type); }
    if (filters.from_wallet_id) { sql += ' AND from_wallet_id = ?'; params.push(filters.from_wallet_id); }
    if (filters.to_wallet_id) { sql += ' AND to_wallet_id = ?'; params.push(filters.to_wallet_id); }
    if (filters.blockchain) { sql += ' AND blockchain = ?'; params.push(filters.blockchain); }
    if (filters.direction) { sql += ' AND direction = ?'; params.push(filters.direction); }
    sql += ' ORDER BY created_at DESC';
    if (filters.limit) { sql += ' LIMIT ?'; params.push(parseInt(filters.limit)); }
    return this.db.prepare(sql).all(...params);
  }

  updateStatus(id, status, extra = {}) {
    let sql = `UPDATE blockchain_transactions SET status = ?, updated_at = datetime('now')`;
    const params = [status];
    if (extra.circleTxId) { sql += ', circle_tx_id = ?'; params.push(extra.circleTxId); }
    if (extra.txHash) { sql += ', tx_hash = ?'; params.push(extra.txHash); }
    if (extra.blockNumber) { sql += ', block_number = ?'; params.push(extra.blockNumber); }
    if (extra.circleState) { sql += ', circle_state = ?'; params.push(extra.circleState); }
    if (extra.gasUsed) { sql += ', gas_used = ?'; params.push(extra.gasUsed); }
    if (extra.networkFee) { sql += ', network_fee = ?'; params.push(extra.networkFee); }
    if (extra.failureReason) { sql += ', failure_reason = ?'; params.push(extra.failureReason); }
    if (extra.approvedBy) { sql += ", approved_by = ?, approved_at = datetime('now')"; params.push(extra.approvedBy); }
    sql += ' WHERE id = ?';
    params.push(id);
    this.db.prepare(sql).run(...params);
  }

  getStats() {
    const total = this.db.prepare('SELECT COUNT(*) as count FROM blockchain_transactions').get().count;
    const completed = this.db.prepare("SELECT COUNT(*) as count FROM blockchain_transactions WHERE status = 'completed'").get().count;
    const pending = this.db.prepare("SELECT COUNT(*) as count FROM blockchain_transactions WHERE status IN ('initiated','submitted','confirming','pending_approval')").get().count;
    const failed = this.db.prepare("SELECT COUNT(*) as count FROM blockchain_transactions WHERE status = 'failed'").get().count;
    const totalVolume = this.db.prepare("SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) as total FROM blockchain_transactions WHERE status = 'completed'").get().total;
    const todayVolume = this.db.prepare("SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) as total FROM blockchain_transactions WHERE status = 'completed' AND date(created_at) = date('now')").get().total;
    return {
      total, completed, pending, failed,
      totalVolume: totalVolume.toFixed(2),
      todayVolume: todayVolume.toFixed(2),
    };
  }
}

// --- Fiat Gateway Manager ----------------------------------------------------

class FiatGatewayManager {
  constructor(db) {
    this.db = db;
  }

  createOrder({ orderNumber, circlePaymentId, direction, fiatAmount, fiatCurrency,
                cryptoAmount, cryptoCurrency, walletId, bankName, bankAccountMasked,
                rail, idempotencyKey, initiatedBy }) {
    const stmt = this.db.prepare(`
      INSERT INTO fiat_gateway_orders
        (order_number, circle_payment_id, direction, fiat_amount, fiat_currency,
         crypto_amount, crypto_currency, wallet_id, bank_name, bank_account_masked,
         rail, idempotency_key, initiated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      orderNumber || generateFiatOrderNumber(), circlePaymentId || null,
      direction, fiatAmount, fiatCurrency || 'USD',
      cryptoAmount || null, cryptoCurrency || 'USDC',
      walletId || null, bankName || null, bankAccountMasked || null,
      rail || 'wire',
      idempotencyKey || generateIdempotencyKey('fiat'),
      initiatedBy || 'system'
    );
    return this.getOrder(result.lastInsertRowid);
  }

  getOrder(id) {
    return this.db.prepare('SELECT * FROM fiat_gateway_orders WHERE id = ?').get(id);
  }

  getOrderByCircleId(circlePaymentId) {
    return this.db.prepare('SELECT * FROM fiat_gateway_orders WHERE circle_payment_id = ?').get(circlePaymentId);
  }

  listOrders(filters = {}) {
    let sql = 'SELECT * FROM fiat_gateway_orders WHERE 1=1';
    const params = [];
    if (filters.direction) { sql += ' AND direction = ?'; params.push(filters.direction); }
    if (filters.status) { sql += ' AND status = ?'; params.push(filters.status); }
    sql += ' ORDER BY created_at DESC';
    if (filters.limit) { sql += ' LIMIT ?'; params.push(parseInt(filters.limit)); }
    return this.db.prepare(sql).all(...params);
  }

  updateStatus(id, status, extra = {}) {
    let sql = `UPDATE fiat_gateway_orders SET status = ?, updated_at = datetime('now')`;
    const params = [status];
    if (extra.circleStatus) { sql += ', circle_status = ?'; params.push(extra.circleStatus); }
    if (extra.cryptoAmount) { sql += ', crypto_amount = ?'; params.push(extra.cryptoAmount); }
    if (extra.circleFee) { sql += ', circle_fee = ?'; params.push(extra.circleFee); }
    if (extra.settledAt) { sql += ', settled_at = ?'; params.push(extra.settledAt); }
    if (extra.failureReason) { sql += ', failure_reason = ?'; params.push(extra.failureReason); }
    sql += ' WHERE id = ?';
    params.push(id);
    this.db.prepare(sql).run(...params);
  }

  getStats() {
    const total = this.db.prepare('SELECT COUNT(*) as count FROM fiat_gateway_orders').get().count;
    const onRamp = this.db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(CAST(fiat_amount AS REAL)), 0) as volume FROM fiat_gateway_orders WHERE direction = 'on_ramp' AND status = 'completed'").get();
    const offRamp = this.db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(CAST(fiat_amount AS REAL)), 0) as volume FROM fiat_gateway_orders WHERE direction = 'off_ramp' AND status = 'completed'").get();
    const pending = this.db.prepare("SELECT COUNT(*) as count FROM fiat_gateway_orders WHERE status IN ('pending','processing')").get().count;
    return {
      total, pending,
      onRampCount: onRamp.count,
      onRampVolume: onRamp.volume.toFixed(2),
      offRampCount: offRamp.count,
      offRampVolume: offRamp.volume.toFixed(2),
    };
  }
}

// =============================================================================
// PRIVATE BLOCKCHAIN STACK — Open Source, No API Keys Required
// =============================================================================

// --- Key Encryption (for storing private keys in DB) -------------------------

const ENCRYPTION_ALGO = 'aes-256-gcm';

function deriveEncryptionKey(masterSecret) {
  return crypto.scryptSync(masterSecret, 'dlbtrust-wallet-keys', 32);
}

function encryptPrivateKey(privateKey, masterSecret) {
  const key = deriveEncryptionKey(masterSecret);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGO, key, iv);
  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

function decryptPrivateKey(encryptedStr, masterSecret) {
  const key = deriveEncryptionKey(masterSecret);
  const [ivHex, tagHex, encrypted] = encryptedStr.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGO, key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// --- Polygon Client (Direct RPC — No API Keys) ------------------------------

class PolygonClient {
  constructor(blockchain = 'MATIC-AMOY', customRpcUrl = null) {
    this.blockchain = blockchain;
    const rpcUrl = customRpcUrl || RPC_ENDPOINTS[blockchain];
    if (!rpcUrl) throw new Error(`No RPC endpoint for blockchain: ${blockchain}`);
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.usdcAddress = USDC_CONTRACTS[blockchain] || null;
  }

  // Generate a new random wallet (returns address + encrypted private key)
  generateWallet(masterSecret) {
    const wallet = ethers.Wallet.createRandom();
    const encryptedKey = encryptPrivateKey(wallet.privateKey, masterSecret);
    return {
      address: wallet.address,
      encryptedPrivateKey: encryptedKey,
    };
  }

  // Get a signer from encrypted private key
  getSigner(encryptedPrivateKey, masterSecret) {
    const privateKey = decryptPrivateKey(encryptedPrivateKey, masterSecret);
    return new ethers.Wallet(privateKey, this.provider);
  }

  // Check USDC balance directly on-chain
  async getUsdcBalance(address) {
    if (!this.usdcAddress) return '0.00';
    try {
      const contract = new ethers.Contract(this.usdcAddress, ERC20_ABI, this.provider);
      const balance = await contract.balanceOf(address);
      const decimals = await contract.decimals();
      return ethers.formatUnits(balance, decimals);
    } catch (err) {
      console.warn('[PolygonClient] USDC balance check failed:', err.message);
      return '0.00';
    }
  }

  // Check native token balance (MATIC/ETH for gas)
  async getNativeBalance(address) {
    try {
      const balance = await this.provider.getBalance(address);
      return ethers.formatEther(balance);
    } catch (err) {
      console.warn('[PolygonClient] Native balance check failed:', err.message);
      return '0.00';
    }
  }

  // Send USDC directly on-chain (signs locally, broadcasts to network)
  async sendUsdc(encryptedPrivateKey, masterSecret, toAddress, amountUsd) {
    if (!this.usdcAddress) throw new Error('USDC contract not configured for this chain');
    const signer = this.getSigner(encryptedPrivateKey, masterSecret);
    const contract = new ethers.Contract(this.usdcAddress, ERC20_ABI, signer);
    const decimals = await contract.decimals();
    const amountWei = ethers.parseUnits(amountUsd.toString(), decimals);

    const tx = await contract.transfer(toAddress, amountWei);
    return {
      txHash: tx.hash,
      from: signer.address,
      to: toAddress,
      amount: amountUsd,
      blockchain: this.blockchain,
    };
  }

  // Wait for transaction confirmation
  async waitForConfirmation(txHash, confirmations = 1) {
    const receipt = await this.provider.waitForTransaction(txHash, confirmations, 120000);
    return {
      confirmed: receipt.status === 1,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.gasPrice ? ethers.formatUnits(receipt.gasPrice, 'gwei') : '0',
    };
  }

  // Get transaction receipt
  async getTransactionReceipt(txHash) {
    return this.provider.getTransactionReceipt(txHash);
  }

  // Get current gas price
  async getGasPrice() {
    try {
      const feeData = await this.provider.getFeeData();
      return {
        gasPrice: feeData.gasPrice ? ethers.formatUnits(feeData.gasPrice, 'gwei') : '0',
        maxFeePerGas: feeData.maxFeePerGas ? ethers.formatUnits(feeData.maxFeePerGas, 'gwei') : null,
      };
    } catch {
      return { gasPrice: '0', maxFeePerGas: null };
    }
  }

  // Swap native POL → USDC via QuickSwap V3 DEX (on-chain, no API key)
  async swapPolToUsdc(encryptedPrivateKey, masterSecret, amountPol, slippageBps = 100) {
    const wpolAddr = WPOL_CONTRACTS[this.blockchain];
    const routerAddr = DEX_ROUTERS[this.blockchain];
    if (!wpolAddr || !routerAddr) throw new Error(`DEX swap not supported on ${this.blockchain}`);
    if (!this.usdcAddress) throw new Error('USDC contract not configured for this chain');

    const signer = this.getSigner(encryptedPrivateKey, masterSecret);
    const amountIn = ethers.parseEther(amountPol.toString());

    // Step 1: Wrap POL → WPOL
    const wpol = new ethers.Contract(wpolAddr, WPOL_ABI, signer);
    const wrapTx = await wpol.deposit({ value: amountIn });
    await wrapTx.wait();

    // Step 2: Approve router to spend WPOL
    const approveTx = await wpol.approve(routerAddr, amountIn);
    await approveTx.wait();

    // Step 3: Swap WPOL → USDC via QuickSwap V3 Router
    const router = new ethers.Contract(routerAddr, SWAP_ROUTER_ABI, signer);
    const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minutes
    const amountOutMinimum = 0; // slippage handled by sqrtPriceLimitX96=0 (accept any price)

    const swapTx = await router.exactInputSingle({
      tokenIn: wpolAddr,
      tokenOut: this.usdcAddress,
      recipient: signer.address,
      deadline,
      amountIn,
      amountOutMinimum,
      sqrtPriceLimitX96: 0n,
    });
    const receipt = await swapTx.wait();

    // Read USDC balance change from transfer event
    const usdcContract = new ethers.Contract(this.usdcAddress, ERC20_ABI, this.provider);
    const usdcDecimals = await usdcContract.decimals();
    const usdcBalance = await usdcContract.balanceOf(signer.address);

    return {
      txHash: receipt.hash,
      from: signer.address,
      amountPolIn: amountPol.toString(),
      usdcBalanceAfter: ethers.formatUnits(usdcBalance, usdcDecimals),
      blockchain: this.blockchain,
      router: routerAddr,
      gasUsed: receipt.gasUsed.toString(),
    };
  }

  // Get a swap quote (estimated USDC output for a given POL input)
  async getSwapQuote(amountPol) {
    const wpolAddr = WPOL_CONTRACTS[this.blockchain];
    if (!wpolAddr || !this.usdcAddress) return { supported: false };

    try {
      // Use the Quoter contract to estimate output
      const quoterAddr = '0xa15F0D7377B2A0C0c10db057f641beD21028FC89'; // QuickSwap V3 Quoter
      const quoterAbi = [
        'function quoteExactInputSingle(address tokenIn, address tokenOut, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut, uint16 fee)',
      ];
      const quoter = new ethers.Contract(quoterAddr, quoterAbi, this.provider);
      const amountIn = ethers.parseEther(amountPol.toString());
      const result = await quoter.quoteExactInputSingle.staticCall(
        wpolAddr, this.usdcAddress, amountIn, 0n
      );
      const amountOut = result[0] || result;
      const usdcContract = new ethers.Contract(this.usdcAddress, ERC20_ABI, this.provider);
      const decimals = await usdcContract.decimals();
      return {
        supported: true,
        amountPolIn: amountPol.toString(),
        estimatedUsdcOut: ethers.formatUnits(amountOut, decimals),
        router: DEX_ROUTERS[this.blockchain],
      };
    } catch (err) {
      return { supported: true, amountPolIn: amountPol.toString(), estimatedUsdcOut: null, error: err.message };
    }
  }

  // Test RPC connectivity
  async ping() {
    try {
      const blockNumber = await this.provider.getBlockNumber();
      return { connected: true, blockNumber };
    } catch (err) {
      return { connected: false, error: err.message };
    }
  }
}

// --- Access Control Manager --------------------------------------------------

class AccessControlManager {
  constructor(db) {
    this.db = db;
  }

  assignRole(walletId, role, assignedBy) {
    this.db.prepare(`
      INSERT OR REPLACE INTO wallet_access_roles (wallet_id, role, assigned_by, updated_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(walletId, role, assignedBy || 'system');
  }

  getRole(walletId) {
    const row = this.db.prepare('SELECT role FROM wallet_access_roles WHERE wallet_id = ?').get(walletId);
    return row ? row.role : 'trustee';
  }

  getPermissions(walletId) {
    const role = this.getRole(walletId);
    return { role, ...(ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.trustee) };
  }

  listRoles() {
    return this.db.prepare('SELECT * FROM wallet_access_roles ORDER BY wallet_id').all();
  }

  checkPermission(walletId, action) {
    const perms = this.getPermissions(walletId);
    return perms[action] || false;
  }

  // Multi-sig: check if enough trustees have approved
  checkMultiSigApproval(txId, requiredApprovals = 2) {
    const row = this.db.prepare(
      'SELECT COUNT(DISTINCT approver_wallet_id) as count FROM multisig_approvals WHERE tx_id = ?'
    ).get(txId);
    return (row ? row.count : 0) >= requiredApprovals;
  }

  addMultiSigApproval(txId, approverWalletId) {
    this.db.prepare(`
      INSERT OR IGNORE INTO multisig_approvals (tx_id, approver_wallet_id, approved_at)
      VALUES (?, ?, datetime('now'))
    `).run(txId, approverWalletId);
  }

  getMultiSigApprovals(txId) {
    return this.db.prepare(
      'SELECT * FROM multisig_approvals WHERE tx_id = ? ORDER BY approved_at'
    ).all(txId);
  }
}

// --- Audit Logger ------------------------------------------------------------

function logAudit(db, { eventType, entityType, entityId, details, actor }) {
  db.prepare(`
    INSERT INTO blockchain_audit_log (event_type, entity_type, entity_id, details, actor)
    VALUES (?, ?, ?, ?, ?)
  `).run(eventType, entityType || null, entityId || null,
    typeof details === 'object' ? JSON.stringify(details) : details || null,
    actor || 'system');
}

// --- Helpers -----------------------------------------------------------------

function mapCircleTxStatus(circleState) {
  return TX_STATUS_MAP[circleState] || circleState || 'unknown';
}

function mapFiatStatus(circleStatus) {
  return FIAT_STATUS_MAP[circleStatus] || circleStatus || 'unknown';
}

function maskAddress(address) {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function getExplorerUrl(blockchain, txHash) {
  const chain = SUPPORTED_BLOCKCHAINS[blockchain];
  if (!chain || !txHash) return null;
  return `${chain.explorer}/tx/${txHash}`;
}

// --- Exports -----------------------------------------------------------------

module.exports = {
  CIRCLE_SANDBOX_URL,
  CIRCLE_PRODUCTION_URL,
  SUPPORTED_BLOCKCHAINS,
  WALLET_TYPES,
  TRANSFER_TYPES,
  TX_STATUS_MAP,
  FIAT_STATUS_MAP,
  TRUST_ROLES,
  ROLE_PERMISSIONS,
  RPC_ENDPOINTS,
  USDC_CONTRACTS,
  WPOL_CONTRACTS,
  DEX_ROUTERS,
  ERC20_ABI,
  CircleClient,
  PolygonClient,
  AccessControlManager,
  WalletManager,
  TransactionManager,
  FiatGatewayManager,
  logAudit,
  generateChainTxNumber,
  generateFiatOrderNumber,
  generateIdempotencyKey,
  usdToCents,
  centsToUsd,
  mapCircleTxStatus,
  mapFiatStatus,
  maskAddress,
  getExplorerUrl,
  encryptPrivateKey,
  decryptPrivateKey,
};
