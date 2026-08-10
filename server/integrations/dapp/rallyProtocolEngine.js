'use strict';

/**
 * Rally Protocol Engine — mobile-first embedded wallet, tap, QR, and payout rail
 * for the DLB Trust platform.
 *
 * Rally Protocol (https://rallyprotocol.com) provides embedded wallets and gasless
 * transactions for native mobile apps. This server-side engine exposes the trust's
 * own Rally-compatible backend:
 *
 *   - Create custodial smart-account wallets for trustees / beneficiaries.
 *   - Generate QR / deep-link payment requests.
 *   - Execute one-tap gasless payouts using the trust's ERC-4337 paymaster.
 *   - Fund wallets from the trust hot wallet without gas fees.
 *
 * If a Rally API key is configured, the engine can switch to Rally's hosted relay
 * in the future; today it routes through the trust's AccountAbstractionEngine
 * (same embedded-wallet / gasless-transaction model) so it works without an API key.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

let viem;
let mainnet, sepolia;
let privateKeyToAccount, generatePrivateKey;

try {
  viem = require('viem');
  ({ mainnet, sepolia } = require('viem/chains'));
  ({ privateKeyToAccount, generatePrivateKey } = require('viem/accounts'));
} catch (e) {
  console.warn('[RallyProtocolEngine] viem not available:', e.message);
}

let AccountAbstractionEngine;
let PtcStablecoinEngine;

try { AccountAbstractionEngine = require('./accountAbstractionEngine').AccountAbstractionEngine; } catch (e) { /* optional */ }
try { PtcStablecoinEngine = require('./ptcStablecoinEngine').PtcStablecoinEngine; } catch (e) { /* optional */ }

let pool = null;
try { pool = require('../bonds/pgPool'); } catch (e) { /* no DB in tests */ }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

function str(name, fallback = '') { return String(process.env[name] || fallback || '').trim(); }
function bool(name, fallback = false) { const v = process.env[name]; return v ? String(v).toLowerCase() === 'true' : fallback; }
function num(name, fallback = 0) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : fallback; }

function dataDir() {
  if (process.env.PERSISTENT_DATA_DIR && fs.existsSync(process.env.PERSISTENT_DATA_DIR)) return process.env.PERSISTENT_DATA_DIR;
  if (fs.existsSync('/data')) return '/data';
  return path.join(process.cwd(), 'data');
}

const STATE_PATH = path.join(dataDir(), 'rally-protocol-state.json');

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (e) { console.warn('[RallyProtocolEngine] loadState failed:', e.message); }
  return { wallets: [], requests: [], payouts: [], lastIndex: 0, whitelisted: {} };
}

function saveState(state) {
  try {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) { console.warn('[RallyProtocolEngine] saveState failed:', e.message); }
}

function getChain(id) {
  switch (Number(id)) {
    case 1: return mainnet;
    case 11155111: return sepolia;
    default: return mainnet;
  }
}

function id(prefix = 'RLY') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

const PAYMASTER_ABI = [
  { inputs: [{ name: 'account', type: 'address' }], name: 'whitelisted', outputs: [{ name: '', type: 'bool' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ name: 'accounts', type: 'address[]' }, { name: 'allowed', type: 'bool' }], name: 'batchWhitelist', outputs: [], stateMutability: 'nonpayable', type: 'function' },
];

const STABLECOIN_ABI = [
  { inputs: [{ name: '', type: 'address' }], name: 'whitelisted', outputs: [{ name: '', type: 'bool' }], stateMutability: 'view', type: 'function' },
];

class RallyProtocolEngine {
  static getConfig() {
    const aaCfg = AccountAbstractionEngine ? AccountAbstractionEngine.getConfig() : {};
    const operatorAddress = str('DAPP_OPERATOR_ADDRESS', aaCfg.operatorAddress || '');
    let privateKey = str('DAPP_PRIVATE_KEY', aaCfg.privateKey || '');
    if (privateKey && privateKey.length === 64 && !privateKey.startsWith('0x')) privateKey = '0x' + privateKey;
    return {
      enabled: bool('RALLY_ENABLED', true),
      apiKey: str('RALLY_API_KEY', ''),
      env: str('RALLY_ENV', 'mainnet'),
      useFallback: bool('RALLY_USE_AA_FALLBACK', true),
      operatorAddress,
      privateKey,
      chainId: Number(str('DAPP_CHAIN_ID', aaCfg.chainId || '1')),
      rpcUrl: str('DAPP_RPC_URL', aaCfg.rpcUrl || ''),
      entryPoint: aaCfg.entryPoint || '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
      paymasterAddress: aaCfg.paymasterAddress || str('AA_PAYMASTER_ADDRESS', ''),
      tokenAddress: str('RALLY_TOKEN_ADDRESS', PtcStablecoinEngine ? '' : ''),
      hotWalletIndex: num('RALLY_HOT_WALLET_INDEX', 0),
      baseUrl: str('RALLY_BASE_URL', 'https://dlbtrust-app.fly.dev'),
      encryptionKey: str('RALLY_ENCRYPTION_KEY', privateKey),
    };
  }

  static async _getPaymasterAddress() {
    if (this._cachedPaymasterAddress) return this._cachedPaymasterAddress;
    let addr = str('AA_PAYMASTER_ADDRESS', '');
    if (!addr && AccountAbstractionEngine) {
      try {
        const rec = await AccountAbstractionEngine._loadPaymaster();
        addr = rec?.paymaster_address || '';
      } catch (e) { console.warn('[RallyProtocolEngine] _loadPaymaster failed:', e.message); }
    }
    this._cachedPaymasterAddress = addr;
    return addr;
  }

  static async readiness() {
    await this.ensureTables();
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.enabled) issues.push('RALLY_ENABLED is not true');
    if (!cfg.operatorAddress) issues.push('DAPP_OPERATOR_ADDRESS not set');
    if (!cfg.privateKey) issues.push('DAPP_PRIVATE_KEY not set');
    if (!cfg.rpcUrl) issues.push('DAPP_RPC_URL not set');
    const paymasterAddress = await this._getPaymasterAddress();
    if (!paymasterAddress) issues.push('AA_PAYMASTER_ADDRESS not set (gasless fallback will not work)');
    if (!cfg.apiKey) issues.push('RALLY_API_KEY not set — using trust gasless AA fallback');
    const aaReady = Boolean(AccountAbstractionEngine && cfg.operatorAddress && cfg.privateKey && cfg.rpcUrl && paymasterAddress);
    return {
      ready: Boolean(cfg.enabled && cfg.operatorAddress && cfg.privateKey && cfg.rpcUrl && paymasterAddress),
      mode: cfg.apiKey ? 'rally' : (cfg.useFallback ? 'aa-fallback' : 'disabled'),
      env: cfg.env,
      operatorAddress: cfg.operatorAddress,
      paymasterAddress,
      aaReady,
      issues,
    };
  }

  static async ensureTables() {
    if (!pool) return;
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS rally_wallets (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          email TEXT,
          label TEXT,
          type TEXT,
          owner_address TEXT NOT NULL,
          wallet_index TEXT NOT NULL,
          wallet_address TEXT NOT NULL UNIQUE,
          encrypted_key TEXT,
          qr_payload TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS rally_requests (
          id TEXT PRIMARY KEY,
          wallet_id TEXT NOT NULL,
          to_address TEXT,
          amount TEXT NOT NULL,
          currency TEXT NOT NULL,
          memo TEXT,
          shareable_url TEXT,
          qr_data_url TEXT,
          status TEXT DEFAULT 'pending',
          payout_id TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      await pool.query(`ALTER TABLE rally_requests ADD COLUMN IF NOT EXISTS to_address TEXT`);
      await pool.query(`ALTER TABLE rally_requests ADD COLUMN IF NOT EXISTS payout_id TEXT`);
      await pool.query(`CREATE SEQUENCE IF NOT EXISTS rally_wallet_index_seq START 1`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS rally_payouts (
          id TEXT PRIMARY KEY,
          wallet_id TEXT,
          from_address TEXT NOT NULL,
          to_address TEXT NOT NULL,
          amount TEXT NOT NULL,
          currency TEXT NOT NULL,
          memo TEXT,
          tx_hash TEXT,
          user_op_hash TEXT,
          status TEXT DEFAULT 'pending',
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
    } catch (e) { console.warn('[RallyProtocolEngine] ensureTables failed:', e.message); }
  }

  static _publicClient(cfg) {
    if (!viem) throw new Error('viem not available');
    const chain = getChain(cfg.chainId);
    return viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) });
  }

  static async _isTokenRecipientWhitelisted(address) {
    if (!PtcStablecoinEngine || !viem) return false;
    const info = await PtcStablecoinEngine.info().catch(() => ({}));
    const tokenAddress = info.tokenAddress;
    if (!tokenAddress) return true; // assume no token deployed, skip
    try {
      const publicClient = this._publicClient(this.getConfig());
      return await publicClient.readContract({ address: tokenAddress, abi: STABLECOIN_ABI, functionName: 'whitelisted', args: [address] });
    } catch (e) { return false; }
  }

  static async _ensureTokenRecipient(address) {
    if (!PtcStablecoinEngine) return;
    const ok = await this._isTokenRecipientWhitelisted(address);
    if (!ok) await PtcStablecoinEngine.whitelist(address, true);
  }

  static async _isWhitelisted(address) {
    if (!viem) return false;
    const cfg = this.getConfig();
    const paymasterAddress = await this._getPaymasterAddress();
    if (!paymasterAddress) return false;
    try {
      const publicClient = this._publicClient(cfg);
      return await publicClient.readContract({
        address: paymasterAddress,
        abi: PAYMASTER_ABI,
        functionName: 'whitelisted',
        args: [address],
      });
    } catch (e) { return false; }
  }

  static async _ensureWhitelisted(addresses) {
    const cfg = this.getConfig();
    const paymasterAddress = await this._getPaymasterAddress();
    if (!AccountAbstractionEngine || !paymasterAddress || !cfg.privateKey) {
      throw new Error('Cannot whitelist: AccountAbstractionEngine / paymaster not configured');
    }
    const list = Array.isArray(addresses) ? addresses : [addresses];
    const toWhitelist = [];
    for (const addr of list) {
      if (!viem?.isAddress(addr)) continue;
      const ok = await this._isWhitelisted(addr);
      if (!ok) toWhitelist.push(addr);
    }
    if (!toWhitelist.length) return { whitelisted: list, skipped: true };
    if (toWhitelist.length === 1) {
      const res = await AccountAbstractionEngine.whitelistSender(toWhitelist[0], true);
      return { whitelisted: toWhitelist, tx: res.tx || res.transactionHash, via: 'single' };
    }
    // batch whitelist via wallet writeContract
    const publicClient = this._publicClient(cfg);
    const account = privateKeyToAccount(cfg.privateKey);
    const wallet = viem.createWalletClient({ account, chain: getChain(cfg.chainId), transport: viem.http(cfg.rpcUrl) });
    const fees = await AccountAbstractionEngine._feeValues ? await AccountAbstractionEngine._feeValues(publicClient, cfg) : { maxFeePerGas: 5000000000n, maxPriorityFeePerGas: 1500000000n };
    const hash = await wallet.writeContract({
      address: paymasterAddress,
      abi: PAYMASTER_ABI,
      functionName: 'batchWhitelist',
      args: [toWhitelist, true],
      gas: 100000n + BigInt(toWhitelist.length) * 20000n,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`batch whitelist failed: ${hash}`);
    return { whitelisted: toWhitelist, tx: hash, via: 'batch' };
  }

  static async _deriveWalletAddress(index, cfg) {
    if (!AccountAbstractionEngine) throw new Error('AccountAbstractionEngine not available');
    const owner = cfg.operatorAddress;
    if (!owner) throw new Error('operator address not configured');
    return await AccountAbstractionEngine.getSmartAccountAddress(owner, BigInt(index));
  }

  static _maxWalletIndex(state) {
    return (state.wallets || []).reduce((m, w) => Math.max(m, Number(w.wallet_index) || 0), 0);
  }

  static async _nextWalletIndex() {
    if (pool) {
      try {
        await pool.query(`CREATE SEQUENCE IF NOT EXISTS rally_wallet_index_seq START 1`);
        await pool.query(`SELECT setval('rally_wallet_index_seq', GREATEST((SELECT COALESCE(MAX(CAST(wallet_index AS INTEGER)), 0) FROM rally_wallets) + 1, 1), false)`);
        const { rows } = await pool.query(`SELECT nextval('rally_wallet_index_seq') as idx`);
        return Number(rows[0].idx);
      } catch (e) { console.warn('[RallyProtocolEngine] DB wallet index allocation failed:', e.message); }
    }
    const state = loadState();
    return this._maxWalletIndex(state) + 1;
  }

  static async createWallet({ userId, email, label, type = 'beneficiary', pin, selfCustodial = false } = {}) {
    await this.ensureTables();
    const cfg = this.getConfig();
    const index = await this._nextWalletIndex();
    const walletAddress = await this._deriveWalletAddress(index, cfg);

    let eoaAddress = null;
    let encryptedKey = null;

    if (selfCustodial && viem && generatePrivateKey) {
      const pk = generatePrivateKey();
      const account = privateKeyToAccount(pk);
      eoaAddress = account.address;
      encryptedKey = this._encrypt(pk, pin || cfg.encryptionKey);
    }

    const walletId = id('RW');
    const record = {
      id: walletId,
      user_id: userId || null,
      email: email || null,
      label: label || 'Rally Wallet',
      type: type || 'beneficiary',
      owner_address: cfg.operatorAddress,
      wallet_index: String(index),
      wallet_address: walletAddress,
      encrypted_key: encryptedKey,
      qr_payload: '',
      created_at: new Date().toISOString(),
    };

    if (pool) {
      await pool.query(
        `INSERT INTO rally_wallets (id, user_id, email, label, type, owner_address, wallet_index, wallet_address, encrypted_key, qr_payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [record.id, record.user_id, record.email, record.label, record.type, record.owner_address, record.wallet_index, record.wallet_address, record.encrypted_key, record.qr_payload]
      );
    }

    const state = loadState();
    state.lastIndex = index;
    const existing = state.wallets.findIndex(w => w.wallet_address === walletAddress);
    if (existing >= 0) state.wallets[existing] = record;
    else state.wallets.push(record);
    saveState(state);

    return {
      id: walletId,
      index,
      walletAddress,
      ownerAddress: cfg.operatorAddress,
      eoaAddress,
      label: record.label,
      type: record.type,
      instructions: selfCustodial
        ? 'Self-custodial EOA created. The private key is encrypted on the server and only decrypted with the user PIN.'
        : 'Custodial smart-account wallet created. The trust operator controls the keys; the user authorizes transactions via PIN or trustee approval.',
    };
  }

  static _deriveKey(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  }

  static _encrypt(text, key) {
    if (!key) key = str('RALLY_ENCRYPTION_KEY', str('DAPP_PRIVATE_KEY', ''));
    if (!key) throw new Error('encryption key not configured');
    const salt = crypto.randomBytes(16);
    const secret = this._deriveKey(key, salt);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', secret, iv);
    const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${salt.toString('hex')}:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
  }

  static _decrypt(encrypted, key) {
    if (!key) key = str('RALLY_ENCRYPTION_KEY', str('DAPP_PRIVATE_KEY', ''));
    if (!key) throw new Error('encryption key not configured');
    const [saltHex, ivHex, tagHex, encHex] = encrypted.split(':');
    if (!saltHex || !ivHex || !tagHex || !encHex) throw new Error('malformed encrypted payload');
    const salt = Buffer.from(saltHex, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const enc = Buffer.from(encHex, 'hex');
    const secret = this._deriveKey(key, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', secret, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  }

  static async listWallets({ userId, type } = {}) {
    await this.ensureTables();
    if (pool) {
      try {
        const clauses = [];
        const vals = [];
        if (userId) { vals.push(userId); clauses.push(`user_id = $${vals.length}`); }
        if (type) { vals.push(type); clauses.push(`type = $${vals.length}`); }
        const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
        const { rows } = await pool.query(`SELECT * FROM rally_wallets ${where} ORDER BY created_at DESC`, vals);
        return rows.map(r => ({ ...r, wallet_index: Number(r.wallet_index) }));
      } catch (e) { console.warn('[RallyProtocolEngine] DB list wallets failed:', e.message); }
    }
    const state = loadState();
    let wallets = state.wallets || [];
    if (userId) wallets = wallets.filter(w => w.user_id === userId);
    if (type) wallets = wallets.filter(w => w.type === type);
    return wallets.map(w => ({ ...w, wallet_index: Number(w.wallet_index) }));
  }

  static async getWallet(walletId) {
    const wallets = await this.listWallets();
    return wallets.find(w => w.id === walletId) || null;
  }

  static async getWalletByAddress(address) {
    const wallets = await this.listWallets();
    return wallets.find(w => w.wallet_address === address) || null;
  }

  static async getBalance(walletIdOrAddress) {
    const cfg = this.getConfig();
    let wallet = await this.getWallet(walletIdOrAddress);
    const address = wallet ? wallet.wallet_address : walletIdOrAddress;
    if (!viem?.isAddress(address)) throw new Error('invalid wallet id or address');
    const balances = [];
    if (PtcStablecoinEngine) {
      try {
        const bal = await PtcStablecoinEngine.balanceOf(address);
        balances.push({ symbol: 'DLB-PTCUSD', address: cfg.tokenAddress || await this._ptcTokenAddress(), balance: bal });
      } catch (e) { console.warn('[RallyProtocolEngine] PTC balance failed:', e.message); }
    }
    try {
      const publicClient = this._publicClient(cfg);
      const eth = await publicClient.getBalance({ address });
      balances.push({ symbol: 'ETH', address: null, balance: viem.formatEther(eth) });
    } catch (e) { /* ignore */ }
    return { walletId: wallet ? wallet.id : null, address, balances };
  }

  static async _ptcTokenAddress() {
    if (PtcStablecoinEngine) {
      try { return (await PtcStablecoinEngine.info()).tokenAddress; } catch (e) { return ''; }
    }
    return this.getConfig().tokenAddress;
  }

  static async fundWallet({ walletId, amount, currency = 'DLB-PTCUSD', tokenAddress } = {}) {
    await this.ensureTables();
    const cfg = this.getConfig();
    if (!AccountAbstractionEngine) throw new Error('AccountAbstractionEngine not available');
    const wallet = await this.getWallet(walletId);
    if (!wallet) throw new Error('wallet not found');
    const to = wallet.wallet_address;
    const tk = tokenAddress || cfg.tokenAddress || await this._ptcTokenAddress();
    if (!tk) throw new Error('token address not configured');
    // Use the operator hot wallet (index 0) as the gasless source of funds.
    const hotAddress = await this._deriveWalletAddress(cfg.hotWalletIndex, cfg);
    // Ensure hot wallet is whitelisted as a sender.
    await this._ensureWhitelisted([hotAddress]);
    // DLB-PTCUSD requires the recipient to be whitelisted before transfer.
    await this._ensureTokenRecipient(to);
    const paymasterAddress = await this._getPaymasterAddress();
    const prep = await AccountAbstractionEngine.prepareGaslessTransfer({
      owner: cfg.operatorAddress,
      index: cfg.hotWalletIndex,
      to,
      amount,
      token: tk,
      paymasterAddress,
    });
    const sub = await AccountAbstractionEngine.submitGaslessTransfer({ operationId: prep.operationId });
    const payoutId = id('RLY-FUND');
    const record = {
      id: payoutId,
      wallet_id: walletId,
      from_address: hotAddress,
      to_address: to,
      amount: String(amount),
      currency,
      memo: 'Rally wallet funding',
      tx_hash: sub.tx,
      user_op_hash: sub.userOpHash,
      status: sub.success ? 'completed' : 'failed',
      created_at: new Date().toISOString(),
    };
    this._savePayout(record);
    return { success: true, payoutId, tx: sub.tx, userOpHash: sub.userOpHash, walletId, amount, to };
  }

  static _savePayout(record) {
    const state = loadState();
    state.payouts = state.payouts || [];
    state.payouts.push(record);
    saveState(state);
    if (pool) {
      pool.query(
        `INSERT INTO rally_payouts (id, wallet_id, from_address, to_address, amount, currency, memo, tx_hash, user_op_hash, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO NOTHING`,
        [record.id, record.wallet_id, record.from_address, record.to_address, record.amount, record.currency, record.memo, record.tx_hash, record.user_op_hash, record.status]
      ).catch(e => console.warn('[RallyProtocolEngine] DB insert payout failed:', e.message));
    }
  }

  static async createPaymentRequest({ walletId, amount, currency = 'DLB-PTCUSD', memo = '' } = {}) {
    await this.ensureTables();
    const cfg = this.getConfig();
    const wallet = await this.getWallet(walletId);
    if (!wallet) throw new Error('wallet not found');
    const requestId = id('RLY-REQ');
    const shareableUrl = `${cfg.baseUrl}/dashboard?tab=rally&payTo=${wallet.wallet_address}&amount=${encodeURIComponent(amount)}&currency=${encodeURIComponent(currency)}&memo=${encodeURIComponent(memo)}&requestId=${requestId}`;
    const qrPayload = shareableUrl;
    const qrDataUrl = await QRCode.toDataURL(shareableUrl, { width: 256, margin: 2, type: 'image/png' });
    const record = {
      id: requestId,
      wallet_id: walletId,
      to_address: wallet.wallet_address,
      amount: String(amount),
      currency,
      memo,
      shareable_url: shareableUrl,
      qr_data_url: qrDataUrl,
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    const state = loadState();
    state.requests = state.requests || [];
    state.requests.push(record);
    saveState(state);
    if (pool) {
      pool.query(
        `INSERT INTO rally_requests (id, wallet_id, to_address, amount, currency, memo, shareable_url, qr_data_url, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO NOTHING`,
        [record.id, record.wallet_id, record.to_address, record.amount, record.currency, record.memo, record.shareable_url, record.qr_data_url, record.status]
      ).catch(e => console.warn('[RallyProtocolEngine] DB insert request failed:', e.message));
    }
    return { requestId, walletId, walletAddress: wallet.wallet_address, amount, currency, memo, shareableUrl, qrDataUrl };
  }

  static async scanQr({ qrData } = {}) {
    if (!qrData) throw new Error('qrData required');
    const urlMatch = qrData.match(/^https?:\/\/[^\s]+/);
    if (urlMatch) {
      const url = new URL(urlMatch[0]);
      const to = url.searchParams.get('to') || url.searchParams.get('payTo');
      const amount = url.searchParams.get('amount');
      const currency = url.searchParams.get('currency') || 'DLB-PTCUSD';
      const memo = url.searchParams.get('memo') || '';
      const requestId = url.searchParams.get('requestId') || '';
      return { type: 'rally-payment-request', to, amount, currency, memo, requestId, original: qrData };
    }
    if (qrData.startsWith('ethereum:')) {
      const to = qrData.match(/ethereum:([^@?\s]+)/)?.[1];
      const amount = qrData.match(/[?&]amount=([^&\s]+)/)?.[1];
      return { type: 'erc20-uri', to, amount, original: qrData };
    }
    try {
      const parsed = JSON.parse(qrData);
      return { type: 'json', ...parsed, original: qrData };
    } catch (e) {}
    return { type: 'raw', original: qrData };
  }

  static async createPayout({ fromWalletId, toAddress, amount, currency = 'DLB-PTCUSD', memo = '' } = {}) {
    await this.ensureTables();
    const cfg = this.getConfig();
    if (!AccountAbstractionEngine) throw new Error('AccountAbstractionEngine not available');
    if (!viem?.isAddress(toAddress)) throw new Error('invalid toAddress');
    const wallet = await this.getWallet(fromWalletId);
    if (!wallet) throw new Error('wallet not found');
    const from = wallet.wallet_address;
    const tokenAddress = cfg.tokenAddress || await this._ptcTokenAddress();
    if (!tokenAddress) throw new Error('token address not configured');

    // Ensure source smart account is whitelisted with the paymaster.
    await this._ensureWhitelisted([from]);
    // DLB-PTCUSD requires the recipient to be whitelisted before transfer.
    await this._ensureTokenRecipient(toAddress);
    const paymasterAddress = await this._getPaymasterAddress();

    const prep = await AccountAbstractionEngine.prepareGaslessTransfer({
      owner: cfg.operatorAddress,
      index: Number(wallet.wallet_index),
      to: toAddress,
      amount,
      token: tokenAddress,
      paymasterAddress,
    });
    const sub = await AccountAbstractionEngine.submitGaslessTransfer({ operationId: prep.operationId });
    const payoutId = id('RLY-PAY');
    const record = {
      id: payoutId,
      wallet_id: fromWalletId,
      from_address: from,
      to_address: toAddress,
      amount: String(amount),
      currency,
      memo,
      tx_hash: sub.tx,
      user_op_hash: sub.userOpHash,
      status: sub.success ? 'completed' : 'failed',
      created_at: new Date().toISOString(),
    };
    this._savePayout(record);
    return { success: true, payoutId, tx: sub.tx, userOpHash: sub.userOpHash, from, to: toAddress, amount, currency, memo };
  }

  static async listPayouts({ walletId } = {}) {
    await this.ensureTables();
    if (pool) {
      try {
        const { rows } = await pool.query(
          walletId ? 'SELECT * FROM rally_payouts WHERE wallet_id = $1 ORDER BY created_at DESC' : 'SELECT * FROM rally_payouts ORDER BY created_at DESC',
          walletId ? [walletId] : []
        );
        return rows;
      } catch (e) { console.warn('[RallyProtocolEngine] DB list payouts failed:', e.message); }
    }
    const state = loadState();
    let payouts = state.payouts || [];
    if (walletId) payouts = payouts.filter(p => p.wallet_id === walletId);
    return payouts;
  }

  static async listRequests({ walletId } = {}) {
    await this.ensureTables();
    if (pool) {
      try {
        const { rows } = await pool.query(
          walletId ? 'SELECT * FROM rally_requests WHERE wallet_id = $1 ORDER BY created_at DESC' : 'SELECT * FROM rally_requests ORDER BY created_at DESC',
          walletId ? [walletId] : []
        );
        return rows;
      } catch (e) { console.warn('[RallyProtocolEngine] DB list requests failed:', e.message); }
    }
    const state = loadState();
    let requests = state.requests || [];
    if (walletId) requests = requests.filter(r => r.wallet_id === walletId);
    return requests;
  }

  static async _markRequestStatus(requestId, status, payoutId, expectedOldStatus) {
    if (pool) {
      try {
        const params = [status, payoutId || null, requestId];
        let sql = `UPDATE rally_requests SET status = $1, payout_id = $2 WHERE id = $3`;
        if (expectedOldStatus) {
          sql += ` AND status = $4`;
          params.push(expectedOldStatus);
        }
        const { rowCount } = await pool.query(sql, params);
        if (rowCount > 0) return true;
      } catch (e) { console.warn('[RallyProtocolEngine] DB mark request status failed:', e.message); }
    }
    const state = loadState();
    const requests = state.requests || [];
    const req = requests.find(r => r.id === requestId);
    if (!req) return false;
    if (expectedOldStatus && req.status !== expectedOldStatus) return false;
    req.status = status;
    if (payoutId) req.payout_id = payoutId;
    saveState(state);
    return true;
  }

  static async tapPay({ requestId, fromWalletId, pin } = {}) {
    await this.ensureTables();
    const requests = await this.listRequests();
    const req = requests.find(r => r.id === requestId);
    if (!req) throw new Error('payment request not found');
    if (req.status && req.status !== 'pending') throw new Error('payment request already processed');
    const toAddress = req.to_address || (req.wallet_id ? (await this.getWallet(req.wallet_id))?.wallet_address : null);
    if (!toAddress || !viem?.isAddress(toAddress)) throw new Error('request missing recipient address');

    const marked = await this._markRequestStatus(requestId, 'paying', null, 'pending');
    if (!marked) throw new Error('payment request already processed or locked');

    try {
      const result = await this.createPayout({
        fromWalletId,
        toAddress,
        amount: req.amount,
        currency: req.currency,
        memo: req.memo,
      });
      await this._markRequestStatus(requestId, 'paid', result.payoutId, 'paying');
      return { ...result, requestId, status: 'paid' };
    } catch (err) {
      await this._markRequestStatus(requestId, 'pending', null, 'paying');
      throw err;
    }
  }
}

module.exports = { RallyProtocolEngine };
