/**
 * Blockchain Engine — Circle + Polygon USDC Integration
 * DEANDREA LAVAR BARKLEY TRUST — Crypto Rails for Private Trust Banking
 *
 * Unified engine for:
 *   1. Circle Programmable Wallets (developer-controlled)
 *   2. USDC transfers (wallet-to-wallet, on-chain)
 *   3. Fiat on/off ramp via Circle Mint (USD ↔ USDC)
 *   4. Trust governance (spending limits, approval thresholds)
 *
 * All fiat amounts are strings with 2 decimal places for precision.
 * Internal cents conversions provided for ledger compatibility.
 */

'use strict';

// --- Constants ---------------------------------------------------------------

const CIRCLE_SANDBOX_URL = 'https://api-sandbox.circle.com';
const CIRCLE_PRODUCTION_URL = 'https://api.circle.com';

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
  CircleClient,
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
};
