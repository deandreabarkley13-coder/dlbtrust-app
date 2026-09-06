'use strict';

/**
 * thirdweb server wallet engine — a project-owned wallet whose key lives in
 * thirdweb's managed Vault and which the trust backend drives through the
 * thirdweb API (https://api.thirdweb.com):
 *
 *   POST /v1/wallets/server                  create-or-fetch a wallet by identifier
 *   GET  /v1/wallets/server                  list the project's server wallets
 *   GET  /v1/wallets/{address}/balance       native or ERC-20 balance
 *   POST /v1/wallets/send                    transfer native / ERC-20 value
 *   GET  /v1/transactions/{transactionId}    QUEUED | SUBMITTED | CONFIRMED | FAILED
 *
 * Unlike `ThirdwebWalletEngine` (address prediction + gas sponsorship for
 * user smart accounts, which never holds funds), this wallet CAN broadcast
 * and move value, so it is gated like every other live rail:
 *
 *   THIRDWEB_SERVER_WALLET_LIVE=false (default)  → `send` returns a shadow
 *     record describing what would have been sent; nothing reaches thirdweb.
 *   THIRDWEB_SERVER_WALLET_LIVE=true             → the transfer is submitted
 *     and its thirdweb transaction id is recorded for reconciliation.
 *
 * Reads (readiness, list, balance, transaction status) are always allowed
 * when a secret key is present. Every send, shadow or live, is written to
 * `thirdweb_server_wallet_transfers` (or memory without a DB) for audit.
 *
 * Authentication is the project secret key (`x-secret-key`). A Vault access
 * token (`x-vault-access-token`) is only needed for projects that ejected
 * from thirdweb's managed vault; pass it through THIRDWEB_VAULT_ACCESS_TOKEN.
 */

const { getConfig: getBaseConfig } = require('./config');

let viem;
try { viem = require('viem'); } catch (e) { /* address validation degrades to a regex */ }

let pool = null;
try { pool = require('../bonds/pgPool'); } catch (e) { /* no DB in tests */ }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

const DEFAULT_API_URL = 'https://api.thirdweb.com';
const DEFAULT_IDENTIFIER = 'dlbtrust-treasury';
const TERMINAL_STATUSES = new Set(['CONFIRMED', 'FAILED']);

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function bool(name, def = false) { const v = process.env[name]; return v ? String(v).toLowerCase() === 'true' : def; }
function num(name, def = 0) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : def; }

function isAddress(value) {
  if (viem && viem.isAddress) return viem.isAddress(value);
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || ''));
}

function checksum(address) {
  if (viem && viem.isAddress && viem.isAddress(address)) return viem.getAddress(address);
  return address;
}

function lower(value) { return String(value || '').toLowerCase(); }

/** Quantities are wei / smallest unit; accept decimal or 0x strings. */
function toBigInt(value) {
  if (value === undefined || value === null || value === '') throw new Error('quantity required');
  if (typeof value === 'bigint') return value;
  const text = String(value).trim();
  if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(text)) throw new Error(`quantity must be an integer in smallest units, got "${text}"`);
  return BigInt(text);
}

function identifier(prefix = 'TWSW') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

let tablesReady = null;
async function ensureTables() {
  if (!pool || !pool.query) return;
  if (tablesReady) return tablesReady;
  tablesReady = pool.query(`
    CREATE TABLE IF NOT EXISTS thirdweb_server_wallet_transfers (
      id TEXT PRIMARY KEY,
      chain_id INTEGER NOT NULL,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      token_address TEXT,
      quantity NUMERIC NOT NULL,
      shadow BOOLEAN NOT NULL,
      status TEXT NOT NULL,
      thirdweb_transaction_id TEXT,
      transaction_hash TEXT,
      reference TEXT,
      memo TEXT,
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch((e) => { tablesReady = null; throw e; });
  return tablesReady;
}

const memoryTransfers = [];

class ThirdwebServerWalletEngine {
  static getConfig() {
    const base = getBaseConfig();
    return {
      enabled: bool('THIRDWEB_SERVER_WALLET_ENABLED', true),
      live: bool('THIRDWEB_SERVER_WALLET_LIVE', false),
      apiUrl: str('THIRDWEB_API_URL', DEFAULT_API_URL).replace(/\/+$/, ''),
      secretKey: str('THIRDWEB_SECRET_KEY'),
      vaultAccessToken: str('THIRDWEB_VAULT_ACCESS_TOKEN'),
      identifier: str('THIRDWEB_SERVER_WALLET_IDENTIFIER', DEFAULT_IDENTIFIER),
      address: str('THIRDWEB_SERVER_WALLET_ADDRESS'),
      chainId: num('THIRDWEB_SERVER_WALLET_CHAIN_ID', base.chainId),
      // Per-transfer ceiling in smallest units; 0 disables the check.
      maxQuantityPerSend: BigInt(str('THIRDWEB_SERVER_WALLET_MAX_QUANTITY', '0') || '0'),
      allowedRecipients: str('THIRDWEB_SERVER_WALLET_ALLOWED_RECIPIENTS')
        .split(',').map((v) => lower(v.trim())).filter(Boolean),
      timeoutMs: num('THIRDWEB_API_TIMEOUT_MS', 20000),
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.enabled) issues.push('THIRDWEB_SERVER_WALLET_ENABLED=false');
    if (!cfg.secretKey) issues.push('THIRDWEB_SECRET_KEY not configured');
    if (cfg.address && !isAddress(cfg.address)) issues.push('THIRDWEB_SERVER_WALLET_ADDRESS is not a valid address');
    return {
      provider: 'thirdweb-server-wallet',
      enabled: cfg.enabled,
      live: cfg.live,
      shadow: !cfg.live,
      apiUrl: cfg.apiUrl,
      chainId: cfg.chainId,
      identifier: cfg.identifier,
      address: cfg.address ? checksum(cfg.address) : null,
      vaultAccessTokenConfigured: Boolean(cfg.vaultAccessToken),
      maxQuantityPerSend: cfg.maxQuantityPerSend.toString(),
      allowedRecipients: cfg.allowedRecipients,
      canSend: cfg.enabled && cfg.live && Boolean(cfg.secretKey) && Boolean(cfg.address),
      ready: issues.length === 0,
      issues,
    };
  }

  static _headers(cfg) {
    const headers = { 'Content-Type': 'application/json', 'x-secret-key': cfg.secretKey };
    if (cfg.vaultAccessToken) headers['x-vault-access-token'] = cfg.vaultAccessToken;
    return headers;
  }

  static async _request(method, path, body) {
    const cfg = this.getConfig();
    if (!cfg.secretKey) throw new Error('THIRDWEB_SECRET_KEY is required to call the thirdweb API');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    let response;
    try {
      response = await fetch(`${cfg.apiUrl}${path}`, {
        method,
        headers: this._headers(cfg),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.error) {
      const detail = json.error ? (json.error.message || JSON.stringify(json.error)) : response.statusText;
      const err = new Error(`thirdweb ${method} ${path} failed (${response.status}): ${detail}`);
      err.status = response.status >= 400 && response.status <= 599 ? response.status : 502;
      throw err;
    }
    return json.result === undefined ? json : json.result;
  }

  /** List the project's server wallets (EOA + smart account addresses). */
  static async listWallets({ limit = 20, page = 1 } = {}) {
    const result = await this._request('GET', `/v1/wallets/server?limit=${Number(limit)}&page=${Number(page)}`);
    return {
      wallets: (result.wallets || []).map((w) => ({
        address: checksum(w.address),
        smartAccountAddress: w.smartAccountAddress ? checksum(w.smartAccountAddress) : null,
        identifier: (w.profiles || []).map((p) => p.identifier || p.id || p.email).find(Boolean) || null,
        createdAt: w.createdAt || null,
      })),
      pagination: result.pagination || null,
    };
  }

  /**
   * Create-or-fetch the trust's server wallet. thirdweb derives one wallet
   * per identifier, so this is idempotent and never rotates the address.
   * Creating a wallet holds no funds and broadcasts nothing, so it is not
   * behind the live gate.
   */
  static async ensureWallet(id = this.getConfig().identifier) {
    if (!id) throw new Error('server wallet identifier required');
    const result = await this._request('POST', '/v1/wallets/server', { identifier: id });
    return {
      identifier: id,
      address: checksum(result.address),
      smartAccountAddress: result.smartAccountAddress ? checksum(result.smartAccountAddress) : null,
      createdAt: result.createdAt || null,
    };
  }

  /** Configured server wallet address, else the wallet behind the identifier. */
  static async resolveAddress() {
    const cfg = this.getConfig();
    if (cfg.address) return checksum(cfg.address);
    const wallet = await this.ensureWallet(cfg.identifier);
    return wallet.address;
  }

  static async balance({ address, chainId, tokenAddress } = {}) {
    const cfg = this.getConfig();
    const owner = address ? checksum(address) : await this.resolveAddress();
    const chain = Number(chainId || cfg.chainId);
    const query = new URLSearchParams({ chainId: String(chain) });
    if (tokenAddress) query.set('tokenAddress', tokenAddress);
    const result = await this._request('GET', `/v1/wallets/${owner}/balance?${query.toString()}`);
    const rows = Array.isArray(result) ? result : [result];
    return rows.map((r) => ({
      chainId: Number(r.chainId),
      tokenAddress: r.tokenAddress,
      symbol: r.symbol,
      decimals: r.decimals,
      value: r.value,
      displayValue: r.displayValue,
    }));
  }

  static async getTransaction(transactionId) {
    if (!transactionId) throw new Error('transactionId required');
    const tx = await this._request('GET', `/v1/transactions/${encodeURIComponent(transactionId)}`);
    return {
      id: tx.id,
      status: tx.status,
      chainId: tx.chainId ? Number(tx.chainId) : null,
      from: tx.from || null,
      transactionHash: tx.transactionHash || null,
      confirmedAt: tx.confirmedAt || null,
      errorMessage: tx.errorMessage || null,
    };
  }

  /** Poll a thirdweb transaction until it is CONFIRMED or FAILED. */
  static async waitForTransaction(transactionId, { timeoutMs = 120000, intervalMs = 3000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = await this.getTransaction(transactionId);
    while (!TERMINAL_STATUSES.has(last.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      last = await this.getTransaction(transactionId);
    }
    if (last.transactionHash || TERMINAL_STATUSES.has(last.status)) {
      await this._update(transactionId, last).catch(() => undefined);
    }
    return last;
  }

  /**
   * Transfer native or ERC-20 value from the server wallet. `quantity` is in
   * smallest units (wei). Shadow unless THIRDWEB_SERVER_WALLET_LIVE=true;
   * both outcomes are recorded.
   */
  static async send({ to, quantity, tokenAddress = null, chainId, reference = null, memo = null } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw new Error('THIRDWEB_SERVER_WALLET_ENABLED=false');
    if (!isAddress(to)) throw new Error('recipient address invalid');
    if (tokenAddress && !isAddress(tokenAddress)) throw new Error('tokenAddress invalid');
    const amount = toBigInt(quantity);
    if (amount <= 0n) throw new Error('quantity must be positive');
    if (cfg.maxQuantityPerSend > 0n && amount > cfg.maxQuantityPerSend) {
      throw new Error(`quantity ${amount} exceeds THIRDWEB_SERVER_WALLET_MAX_QUANTITY (${cfg.maxQuantityPerSend})`);
    }
    if (cfg.allowedRecipients.length && !cfg.allowedRecipients.includes(lower(to))) {
      throw new Error('recipient is not in THIRDWEB_SERVER_WALLET_ALLOWED_RECIPIENTS');
    }
    const chain = Number(chainId || cfg.chainId);
    const from = cfg.address ? checksum(cfg.address) : (cfg.live ? await this.resolveAddress() : null);

    const record = {
      id: identifier(),
      provider: 'thirdweb-server-wallet',
      chainId: chain,
      from,
      to: checksum(to),
      tokenAddress: tokenAddress ? checksum(tokenAddress) : null,
      asset: tokenAddress ? 'erc20' : 'native',
      quantity: amount.toString(),
      shadow: !cfg.live,
      status: cfg.live ? 'submitted' : 'shadow',
      transactionId: null,
      transactionHash: null,
      reference,
      memo,
      error: null,
    };

    if (!cfg.live) {
      record.reason = 'THIRDWEB_SERVER_WALLET_LIVE=false: transfer recorded, nothing sent to thirdweb';
      await this._persist(record).catch(() => undefined);
      return record;
    }
    if (!cfg.secretKey) throw new Error('THIRDWEB_SECRET_KEY is required for a live transfer');

    const body = {
      from,
      chainId: chain,
      recipients: [{ address: record.to, quantity: record.quantity }],
    };
    if (record.tokenAddress) body.tokenAddress = record.tokenAddress;

    try {
      const result = await this._request('POST', '/v1/wallets/send', body);
      record.transactionId = (result.transactionIds || [])[0] || null;
      if (!record.transactionId) throw new Error('thirdweb returned no transactionId');
    } catch (e) {
      record.status = 'failed';
      record.error = e.message;
      await this._persist(record).catch(() => undefined);
      throw e;
    }
    await this._persist(record).catch(() => undefined);
    return record;
  }

  static async _persist(record) {
    memoryTransfers.push({ ...record });
    if (memoryTransfers.length > 500) memoryTransfers.splice(0, memoryTransfers.length - 500);
    if (!pool || !pool.query) return;
    await ensureTables();
    await pool.query(
      `INSERT INTO thirdweb_server_wallet_transfers
         (id, chain_id, from_address, to_address, token_address, quantity, shadow, status,
          thirdweb_transaction_id, transaction_hash, reference, memo, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        record.id, record.chainId, record.from || '', record.to, record.tokenAddress, record.quantity,
        record.shadow, record.status, record.transactionId, record.transactionHash,
        record.reference, record.memo, record.error,
      ]
    );
  }

  static async _update(transactionId, tx) {
    const status = tx.status === 'CONFIRMED' ? 'confirmed' : tx.status === 'FAILED' ? 'failed' : 'submitted';
    const mine = memoryTransfers.find((t) => t.transactionId === transactionId);
    if (mine) Object.assign(mine, { status, transactionHash: tx.transactionHash, error: tx.errorMessage });
    if (!pool || !pool.query) return;
    await ensureTables();
    await pool.query(
      `UPDATE thirdweb_server_wallet_transfers
          SET status = $2, transaction_hash = $3, error = $4, updated_at = NOW()
        WHERE thirdweb_transaction_id = $1`,
      [transactionId, status, tx.transactionHash || null, tx.errorMessage || null]
    );
  }

  static async recentTransfers(limit = 25) {
    const n = Math.min(Math.max(Number(limit) || 25, 1), 200);
    if (!pool || !pool.query) return memoryTransfers.slice(-n).reverse();
    await ensureTables();
    const { rows } = await pool.query(
      `SELECT id, chain_id, from_address, to_address, token_address, quantity::text AS quantity, shadow, status,
              thirdweb_transaction_id, transaction_hash, reference, memo, error, created_at, updated_at
         FROM thirdweb_server_wallet_transfers
        ORDER BY created_at DESC
        LIMIT $1`,
      [n]
    );
    return rows.map((r) => ({
      id: r.id,
      chainId: r.chain_id,
      from: r.from_address,
      to: r.to_address,
      tokenAddress: r.token_address,
      quantity: r.quantity,
      shadow: r.shadow,
      status: r.status,
      transactionId: r.thirdweb_transaction_id,
      transactionHash: r.transaction_hash,
      reference: r.reference,
      memo: r.memo,
      error: r.error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }
}

module.exports = { ThirdwebServerWalletEngine, DEFAULT_API_URL, DEFAULT_IDENTIFIER, toBigInt };
