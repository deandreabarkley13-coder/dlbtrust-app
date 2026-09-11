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
 * Every send also passes the trust distribution policy (distributionPolicy.js):
 * the quantity is priced in USD by ThirdwebPriceOracle (a caller-supplied
 * `amountUsd` must agree within THIRDWEB_PRICE_TOLERANCE_PCT, and is only
 * trusted on its own when THIRDWEB_PRICE_FALLBACK_TO_CALLER=true and the
 * oracle is unavailable), and the per-transaction ceiling for the requester
 * role is enforced before anything is recorded or submitted.
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
const DistributionPolicy = require('./distributionPolicy');
const { ThirdwebPriceOracle } = require('./thirdwebPriceOracle');

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
  `).then(() => pool.query(`
    ALTER TABLE thirdweb_server_wallet_transfers
      ADD COLUMN IF NOT EXISTS requester_role TEXT,
      ADD COLUMN IF NOT EXISTS amount_usd NUMERIC,
      ADD COLUMN IF NOT EXISTS purpose TEXT
  `)).catch((e) => { tablesReady = null; throw e; });
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
      // Gas the wallet must still hold after a transfer for the next one to broadcast.
      minGasWei: BigInt(str('THIRDWEB_SERVER_WALLET_MIN_GAS_WEI', '0') || '0'),
      fundingPreflight: bool('THIRDWEB_SERVER_WALLET_FUNDING_PREFLIGHT', true),
      timeoutMs: num('THIRDWEB_API_TIMEOUT_MS', 20000),
      priceTolerancePct: num('THIRDWEB_PRICE_TOLERANCE_PCT', 5),
      priceFallbackToCaller: bool('THIRDWEB_PRICE_FALLBACK_TO_CALLER', false),
    };
  }

  /**
   * USD valuation of a transfer. The oracle is authoritative; a caller value
   * is cross-checked against it and only stands alone as a configured fallback.
   */
  static async _valueUsd({ chainId, tokenAddress, quantity, amountUsd }, cfg) {
    const stated = amountUsd === undefined || amountUsd === null || amountUsd === '' ? null : Number(amountUsd);
    let quote;
    try {
      quote = await ThirdwebPriceOracle.quoteUsd({ chainId, tokenAddress, quantity });
    } catch (e) {
      if (cfg.priceFallbackToCaller && stated !== null && Number.isFinite(stated) && stated > 0) {
        return { amountUsd: stated, priceUsd: null, priceSource: 'caller', priceWarning: e.message };
      }
      throw e;
    }
    if (stated !== null && Number.isFinite(stated) && quote.amountUsd > 0) {
      const driftPct = Math.abs(stated - quote.amountUsd) / quote.amountUsd * 100;
      if (driftPct > cfg.priceTolerancePct) {
        throw Object.assign(
          new Error(`stated amountUsd ${stated} is ${driftPct.toFixed(1)}% off the oracle value $${quote.amountUsd} (${quote.symbol} @ $${quote.priceUsd})`),
          { status: 422, code: 'PRICE_MISMATCH' }
        );
      }
    }
    return { amountUsd: quote.amountUsd, priceUsd: quote.priceUsd, priceSource: quote.source, symbol: quote.symbol, decimals: quote.decimals };
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
      minGasWei: cfg.minGasWei.toString(),
      fundingPreflight: cfg.fundingPreflight,
      allowedRecipients: cfg.allowedRecipients,
      distributionPolicy: DistributionPolicy.getPolicy(),
      priceOracle: ThirdwebPriceOracle.readiness(),
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

  /**
   * Refuse direct value movement while the on-chain distribution policy is the
   * mandated route. Env is read here rather than through TrustPolicyEngine to
   * keep the two modules free of a require cycle.
   */
  static _assertPolicyNotEnforced() {
    if (String(process.env.TRUST_POLICY_ENFORCED || '').toLowerCase() !== 'true') return;
    const contract = str('TRUST_POLICY_ADDRESS');
    if (!contract) return;
    throw Object.assign(
      new Error(`TRUST_POLICY_ENFORCED=true: distributions must go through the policy contract ${contract}, not a direct server-wallet transfer`),
      { status: 409, code: 'TRUST_POLICY_ENFORCED' }
    );
  }

  /**
   * Contract views through thirdweb (POST /v1/contracts/read). `calls` are
   * `{ contractAddress, method, params }`; `method` is a human-readable
   * signature ("function available(address) view returns (uint256)").
   */
  static async readContract({ calls, chainId } = {}) {
    if (!Array.isArray(calls) || !calls.length) throw new Error('calls required');
    const result = await this._request('POST', '/v1/contracts/read', {
      calls,
      chainId: Number(chainId || this.getConfig().chainId),
    });
    return (result.results || result || []).map((r) => (r && Object.prototype.hasOwnProperty.call(r, 'data') ? r.data : r));
  }

  /**
   * Contract calls sent from the server wallet (POST /v1/contracts/write).
   * `idempotencyKey` makes a retried call return the original transaction
   * instead of submitting a second one.
   */
  static async writeContract({ calls, chainId, from, idempotencyKey } = {}) {
    if (!Array.isArray(calls) || !calls.length) throw new Error('calls required');
    const cfg = this.getConfig();
    const body = {
      calls,
      chainId: Number(chainId || cfg.chainId),
      from: from || (cfg.address ? checksum(cfg.address) : await this.resolveAddress()),
    };
    if (idempotencyKey) body.idempotencyKey = idempotencyKey;
    const result = await this._request('POST', '/v1/contracts/write', body);
    return { transactionIds: result.transactionIds || [], from: body.from, chainId: body.chainId };
  }

  /** Deploy a contract from the server wallet (POST /v1/contracts). */
  static async deployContract({ abi, bytecode, constructorParams = {}, chainId, from, salt } = {}) {
    if (!Array.isArray(abi) || !abi.length) throw new Error('abi required');
    if (!bytecode) throw new Error('bytecode required');
    const cfg = this.getConfig();
    const body = {
      abi,
      bytecode: bytecode.startsWith('0x') ? bytecode : `0x${bytecode}`,
      constructorParams,
      chainId: Number(chainId || cfg.chainId),
      from: from || (cfg.address ? checksum(cfg.address) : await this.resolveAddress()),
    };
    if (salt) body.salt = salt;
    const result = await this._request('POST', '/v1/contracts', body);
    return {
      address: result.address ? checksum(result.address) : null,
      transactionId: (result.transactionIds || [])[0] || result.transactionId || null,
      chainId: body.chainId,
      from: body.from,
    };
  }

  /**
   * ERC-20 holders and their balances straight from chain indexing
   * (GET /v1/tokens/{chainId}/{address}/owners). Pages until exhausted or
   * `maxPages` is hit; amounts are returned in base units as strings.
   */
  static async tokenOwners({ tokenAddress, chainId, limit = 100, maxPages = 10 } = {}) {
    const cfg = this.getConfig();
    if (!isAddress(tokenAddress)) throw new Error('tokenAddress invalid');
    const chain = Number(chainId || cfg.chainId);
    const owners = [];
    let page = 1;
    let hasMore = true;
    while (hasMore && page <= maxPages) {
      const result = await this._request('GET', `/v1/tokens/${chain}/${checksum(tokenAddress)}/owners?limit=${Number(limit)}&page=${page}`);
      for (const o of result.owners || []) owners.push({ address: checksum(o.address), amount: String(o.amount) });
      hasMore = Boolean(result.pagination && result.pagination.hasMore);
      page += 1;
    }
    return { chainId: chain, tokenAddress: checksum(tokenAddress), owners, complete: !hasMore };
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

  /**
   * What the wallet holds versus what a live transfer needs: the settlement
   * token (or native asset) plus the gas floor. Read-only.
   */
  static async fundingStatus({ chainId, tokenAddress = null, quantity = null } = {}) {
    const cfg = this.getConfig();
    const chain = Number(chainId || cfg.chainId);
    const address = await this.resolveAddress();
    const native = pickBalance(await this.balance({ address, chainId: chain }), null);
    const token = tokenAddress
      ? pickBalance(await this.balance({ address, chainId: chain, tokenAddress }), tokenAddress)
      : null;
    const want = quantity === null || quantity === undefined ? 0n : toBigInt(quantity);
    const gasHeld = BigInt(native ? native.value || '0' : '0');
    const assetHeld = token ? BigInt(token.value || '0') : gasHeld;
    const assetWant = tokenAddress ? want : want + cfg.minGasWei;
    return {
      address,
      chainId: chain,
      tokenAddress: tokenAddress ? checksum(tokenAddress) : null,
      gas: { symbol: native ? native.symbol : null, held: gasHeld.toString(), required: cfg.minGasWei.toString(), sufficient: gasHeld >= cfg.minGasWei },
      asset: {
        symbol: token ? token.symbol : (native ? native.symbol : null),
        decimals: token ? token.decimals : (native ? native.decimals : null),
        held: assetHeld.toString(),
        required: assetWant.toString(),
        sufficient: assetHeld >= assetWant,
      },
      funded: gasHeld >= cfg.minGasWei && assetHeld >= assetWant,
    };
  }

  /** Refuse a live transfer the wallet cannot pay for, instead of letting it revert on-chain. */
  static async assertFunded({ chainId, tokenAddress = null, quantity } = {}) {
    const status = await this.fundingStatus({ chainId, tokenAddress, quantity });
    const short = [];
    if (!status.asset.sufficient) {
      short.push(`${status.asset.symbol || 'asset'}: holds ${status.asset.held}, needs ${status.asset.required}`);
    }
    if (!status.gas.sufficient) {
      short.push(`gas ${status.gas.symbol || 'native'}: holds ${status.gas.held}, needs ${status.gas.required}`);
    }
    if (short.length) {
      throw Object.assign(
        new Error(`treasury wallet ${status.address} on chain ${status.chainId} is underfunded (${short.join('; ')}); fund it before settling`),
        { status: 409, code: 'TREASURY_UNDERFUNDED', funding: status }
      );
    }
    return status;
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
   * smallest units (wei) and is priced in USD by the oracle for the requester
   * role's per-transaction limit. Shadow unless THIRDWEB_SERVER_WALLET_LIVE=true;
   * both outcomes are recorded.
   *
   * With the on-chain policy enforced, a direct transfer would sidestep the
   * contract's ceilings, checker approvals and clawback window, so it is
   * refused: value leaves through TrustDistributionPolicy instead.
   */
  static async send({
    to, quantity, tokenAddress = null, chainId, reference = null, memo = null,
    amountUsd, requesterRole = 'beneficiary', purpose,
  } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw new Error('THIRDWEB_SERVER_WALLET_ENABLED=false');
    this._assertPolicyNotEnforced();
    if (!isAddress(to)) throw new Error('recipient address invalid');
    if (tokenAddress && !isAddress(tokenAddress)) throw new Error('tokenAddress invalid');
    const amount = toBigInt(quantity);
    if (amount <= 0n) throw new Error('quantity must be positive');
    const chain = Number(chainId || cfg.chainId);
    const valuation = await this._valueUsd({ chainId: chain, tokenAddress, quantity: amount, amountUsd }, cfg);
    const policy = DistributionPolicy.enforce({ requesterRole, amountUsd: valuation.amountUsd, purpose, purposeRequired: true });
    if (cfg.maxQuantityPerSend > 0n && amount > cfg.maxQuantityPerSend) {
      throw new Error(`quantity ${amount} exceeds THIRDWEB_SERVER_WALLET_MAX_QUANTITY (${cfg.maxQuantityPerSend})`);
    }
    if (cfg.allowedRecipients.length && !cfg.allowedRecipients.includes(lower(to))) {
      throw new Error('recipient is not in THIRDWEB_SERVER_WALLET_ALLOWED_RECIPIENTS');
    }
    const from = cfg.address ? checksum(cfg.address) : (cfg.live ? await this.resolveAddress() : null);
    if (cfg.live && cfg.fundingPreflight) {
      await this.assertFunded({ chainId: chain, tokenAddress, quantity: amount });
    }

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
      requesterRole: policy.requesterRole,
      amountUsd: policy.amountUsd,
      priceUsd: valuation.priceUsd,
      priceSource: valuation.priceSource,
      purpose: policy.purpose,
      limitUsd: policy.limitUsd,
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

  /**
   * Deposit USDC from the treasury wallet into TrustDistributionPolicy. This
   * is the ERP -> policy funding leg (Treasury-Core GL already debited by
   * CanonicalFundingSource), not a distribution: value only reaches a payee
   * through the contract's maker/checker flow, so the enforced-policy guard
   * and the per-role distribution limits do not apply. Refuses any recipient
   * other than TRUST_POLICY_ADDRESS. Shadow unless THIRDWEB_SERVER_WALLET_LIVE.
   */
  static async fundPolicy({ quantity, tokenAddress, chainId, reference = null, memo = null, amountUsd } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw new Error('THIRDWEB_SERVER_WALLET_ENABLED=false');
    const policyAddress = str('TRUST_POLICY_ADDRESS');
    if (!policyAddress) throw Object.assign(new Error('TRUST_POLICY_ADDRESS not configured'), { status: 409, code: 'TRUST_POLICY_NOT_CONFIGURED' });
    const token = tokenAddress || getBaseConfig().usdcAddress;
    if (!isAddress(token)) throw new Error('tokenAddress invalid');
    const amount = toBigInt(quantity);
    if (amount <= 0n) throw new Error('quantity must be positive');
    const chain = Number(chainId || cfg.chainId);
    if (cfg.maxQuantityPerSend > 0n && amount > cfg.maxQuantityPerSend) {
      throw new Error(`quantity ${amount} exceeds THIRDWEB_SERVER_WALLET_MAX_QUANTITY (${cfg.maxQuantityPerSend})`);
    }
    const from = cfg.address ? checksum(cfg.address) : (cfg.live ? await this.resolveAddress() : null);
    if (cfg.live && cfg.fundingPreflight) {
      await this.assertFunded({ chainId: chain, tokenAddress: token, quantity: amount });
    }
    const record = {
      id: identifier(),
      provider: 'thirdweb-server-wallet',
      chainId: chain,
      from,
      to: checksum(policyAddress),
      tokenAddress: checksum(token),
      asset: 'erc20',
      quantity: amount.toString(),
      shadow: !cfg.live,
      status: cfg.live ? 'submitted' : 'shadow',
      transactionId: null,
      transactionHash: null,
      reference,
      memo,
      requesterRole: 'treasury',
      amountUsd: amountUsd === undefined || amountUsd === null ? null : Number(amountUsd),
      priceUsd: null,
      priceSource: null,
      purpose: 'policy_funding',
      limitUsd: null,
      error: null,
    };
    if (!cfg.live) {
      record.reason = 'THIRDWEB_SERVER_WALLET_LIVE=false: policy funding recorded, nothing sent to thirdweb';
      await this._persist(record).catch(() => undefined);
      return record;
    }
    if (!cfg.secretKey) throw new Error('THIRDWEB_SECRET_KEY is required for a live transfer');
    try {
      const result = await this._request('POST', '/v1/wallets/send', {
        from, chainId: chain, tokenAddress: record.tokenAddress,
        recipients: [{ address: record.to, quantity: record.quantity }],
      });
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
          thirdweb_transaction_id, transaction_hash, reference, memo, error,
          requester_role, amount_usd, purpose)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        record.id, record.chainId, record.from || '', record.to, record.tokenAddress, record.quantity,
        record.shadow, record.status, record.transactionId, record.transactionHash,
        record.reference, record.memo, record.error,
        record.requesterRole, record.amountUsd, record.purpose,
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
              thirdweb_transaction_id, transaction_hash, reference, memo, error,
              requester_role, amount_usd::float8 AS amount_usd, purpose, created_at, updated_at
         FROM thirdweb_server_wallet_transfers
        ORDER BY created_at DESC
        LIMIT $1`,
      [n]
    );
    return rows.map(mapTransferRow);
  }

  /** Every non-terminal transfer (queued/submitted), oldest first, regardless of how many newer transfers exist. */
  static async openTransfers({ limit = 500, offset = 0 } = {}) {
    const n = Math.min(Math.max(Number(limit) || 500, 1), 1000);
    const off = Math.max(Number(offset) || 0, 0);
    const isOpen = (t) => OPEN_STATUSES.includes(String(t.status || '').toLowerCase());
    if (!pool || !pool.query) return memoryTransfers.filter(isOpen).slice(off, off + n);
    await ensureTables();
    const { rows } = await pool.query(
      `SELECT id, chain_id, from_address, to_address, token_address, quantity::text AS quantity, shadow, status,
              thirdweb_transaction_id, transaction_hash, reference, memo, error,
              requester_role, amount_usd::float8 AS amount_usd, purpose, created_at, updated_at
         FROM thirdweb_server_wallet_transfers
        WHERE status IN ('queued', 'submitted')
        ORDER BY created_at ASC, id ASC
        LIMIT $1 OFFSET $2`,
      [n, off]
    );
    return rows.map(mapTransferRow);
  }

  static async transferById(id) {
    if (!pool || !pool.query) return memoryTransfers.find((t) => t.id === id) || null;
    await ensureTables();
    const { rows } = await pool.query(
      `SELECT id, chain_id, from_address, to_address, token_address, quantity::text AS quantity, shadow, status,
              thirdweb_transaction_id, transaction_hash, reference, memo, error,
              requester_role, amount_usd::float8 AS amount_usd, purpose, created_at, updated_at
         FROM thirdweb_server_wallet_transfers WHERE id = $1`,
      [id]
    );
    return rows[0] ? mapTransferRow(rows[0]) : null;
  }
}

const OPEN_STATUSES = ['queued', 'submitted'];

const NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/** thirdweb returns one row per asset; native rows carry no token address (or the native sentinel). */
function pickBalance(rows, tokenAddress) {
  const list = Array.isArray(rows) ? rows : [rows];
  const isNative = (r) => !r.tokenAddress || lower(r.tokenAddress) === lower(NATIVE_TOKEN);
  const match = tokenAddress
    ? list.find((r) => lower(r.tokenAddress) === lower(tokenAddress))
    : list.find(isNative);
  return match || null;
}

function mapTransferRow(r) {
  return {
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
  requesterRole: r.requester_role,
  amountUsd: r.amount_usd,
  purpose: r.purpose,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  };
}

module.exports = { ThirdwebServerWalletEngine, DEFAULT_API_URL, DEFAULT_IDENTIFIER, toBigInt };
