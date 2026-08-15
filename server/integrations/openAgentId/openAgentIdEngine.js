/**
 * OpenAgentIdEngine — Open Agent ID integration for AI-agent identity & credit.
 *
 * Registers a free DID-backed agent on OpenAgentID, stores the wallet + Ed25519
 * keys encrypted at rest, and provides helpers for agent-authenticated signing
 * and public credit-score lookups.
 */

'use strict';

const crypto = require('crypto');
const { Wallet } = require('ethers');
const { query } = require('../bonds/pgPool');

const PREFIX = 'oaid:enc:v1:';
const DEFAULT_BASE_URL = 'https://api.openagentid.org';

let _sdkPromise = null;
let _ensureTablesPromise = null;

function safeJson(obj) {
  return JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? String(v) : v));
}

async function loadSdk() {
  if (!_sdkPromise) {
    _sdkPromise = import('@open-agent-id/sdk');
  }
  return _sdkPromise;
}

function getConfig() {
  const baseUrl = (process.env.OPEN_AGENT_ID_BASE_URL || DEFAULT_BASE_URL).replace(/\/v1\/?$/, '');
  const rawCapabilities = (process.env.OPEN_AGENT_ID_CAPABILITIES || '').trim();
  return {
    baseUrl,
    autoRegister: String(process.env.OPEN_AGENT_ID_AUTO_REGISTER || '').toLowerCase() === 'true',
    agentName: process.env.OPEN_AGENT_ID_AGENT_NAME || 'dlbtrust',
    capabilities: rawCapabilities ? rawCapabilities.split(',').map((s) => s.trim()) : [],
  };
}

function getEncryptionKey() {
  const material = process.env.OPEN_AGENT_ID_ENCRYPTION_KEY
    || process.env.PAYMENT_DATA_ENCRYPTION_KEY
    || (process.env.NODE_ENV !== 'production' ? process.env.ADMIN_SECRET_TOKEN : '');

  if (!material) {
    throw new Error('OPEN_AGENT_ID_ENCRYPTION_KEY or PAYMENT_DATA_ENCRYPTION_KEY must be set');
  }

  if (/^[a-f0-9]{64}$/i.test(material)) {
    return Buffer.from(material, 'hex');
  }

  if (/^[A-Za-z0-9_-]{43}$/.test(material)) {
    const decoded = Buffer.from(material, 'base64url');
    if (decoded.length === 32) return decoded;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('OPEN_AGENT_ID_ENCRYPTION_KEY must be 64 hex chars or 43-char base64url');
  }

  return crypto.createHash('sha256').update(String(material)).digest();
}

function encrypt(value) {
  if (value === undefined || value === null || value === '') return value;
  const text = String(value);
  if (text.startsWith(PREFIX)) return text;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, encrypted].map((p) => p.toString('base64url')).join(':');
}

function decrypt(value) {
  if (value === undefined || value === null || value === '') return value;
  const text = String(value);
  if (!text.startsWith(PREFIX)) return text;

  const parts = text.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Invalid OpenAgentID encrypted value');

  const iv = Buffer.from(parts[0], 'base64url');
  const tag = Buffer.from(parts[1], 'base64url');
  const encrypted = Buffer.from(parts[2], 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function mask(value, visible = 4) {
  if (!value) return null;
  const text = String(value);
  const suffix = text.slice(-visible);
  return '*'.repeat(Math.max(4, text.length - visible)) + suffix;
}

class OpenAgentIdEngine {
  static async ensureTables() {
    if (_ensureTablesPromise) return _ensureTablesPromise;
    _ensureTablesPromise = this._ensureTables().catch((err) => {
      _ensureTablesPromise = null;
      throw err;
    });
    return _ensureTablesPromise;
  }

  static async _ensureTables() {
    await query(`
      CREATE TABLE IF NOT EXISTS open_agent_identities (
        id SERIAL PRIMARY KEY,
        agent_name TEXT NOT NULL,
        wallet_address TEXT UNIQUE NOT NULL,
        wallet_private_key_encrypted TEXT NOT NULL,
        ed25519_public_key TEXT NOT NULL,
        ed25519_private_key_encrypted TEXT NOT NULL,
        did TEXT UNIQUE NOT NULL,
        agent_address TEXT UNIQUE,
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_open_agent_identities_did ON open_agent_identities(did)`);
  }

  static getConfig() {
    return getConfig();
  }

  static async getIdentity() {
    await this.ensureTables();
    const res = await query('SELECT * FROM open_agent_identities ORDER BY id DESC LIMIT 1');
    return res.rows[0] || null;
  }

  static async _loadActiveIdentity() {
    const identity = await this.getIdentity();
    if (identity) return this._decryptIdentity(identity);
    const cfg = getConfig();
    if (!cfg.autoRegister) {
      throw new Error('No OpenAgentID identity found. Set OPEN_AGENT_ID_AUTO_REGISTER=true to create one.');
    }
    return this.registerIdentity();
  }

  static _decryptIdentity(identity) {
    return {
      ...identity,
      walletPrivateKey: decrypt(identity.wallet_private_key_encrypted),
      ed25519PrivateKey: decrypt(identity.ed25519_private_key_encrypted),
    };
  }

  static async _getWalletToken(wallet) {
    const sdk = await loadSdk();
    const cfg = getConfig();
    const client = cfg.baseUrl ? new sdk.RegistryClient(cfg.baseUrl) : new sdk.RegistryClient();
    const challenge = await client.requestChallenge(wallet.address);
    const signature = await wallet.signMessage(challenge.challengeText);
    return client.verifyWallet(wallet.address, challenge.challengeId, signature);
  }

  static async registerIdentity({ name, capabilities } = {}) {
    await this.ensureTables();
    const sdk = await loadSdk();
    const cfg = getConfig();
    const agentName = name || cfg.agentName;
    const agentCapabilities = capabilities && capabilities.length ? capabilities : cfg.capabilities;

    const wallet = Wallet.createRandom();
    const keypair = sdk.generateEd25519Keypair();
    const publicKeyB64 = sdk.base64urlEncode(keypair.publicKey);

    const token = await this._getWalletToken(wallet);
    const client = cfg.baseUrl ? new sdk.RegistryClient(cfg.baseUrl) : new sdk.RegistryClient();
    const agent = await client.registerAgent(token, {
      name: agentName,
      publicKey: publicKeyB64,
      capabilities: agentCapabilities,
    });

    const metadata = {
      chain: agent.chain,
      credit_score: agent.credit_score,
      registered_at: agent.created_at,
    };

    const res = await query(
      `INSERT INTO open_agent_identities
        (agent_name, wallet_address, wallet_private_key_encrypted, ed25519_public_key, ed25519_private_key_encrypted, did, agent_address, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        agentName,
        wallet.address,
        encrypt(wallet.privateKey),
        agent.public_key,
        encrypt(sdk.base64urlEncode(keypair.privateKey)),
        agent.did,
        agent.agent_address,
        safeJson(metadata),
      ]
    );

    return this._decryptIdentity(res.rows[0]);
  }

  static _formatIdentity(identity) {
    return {
      did: identity.did,
      agentAddress: identity.agent_address,
      walletAddress: identity.wallet_address,
      publicKey: identity.ed25519_public_key,
      agentName: identity.agent_name,
      metadata: identity.metadata,
      createdAt: identity.created_at,
    };
  }

  static _createRegistryClient(sdk, baseUrl) {
    return baseUrl ? new sdk.RegistryClient(baseUrl) : new sdk.RegistryClient();
  }

  static async getCredit(did) {
    const sdk = await loadSdk();
    const cfg = getConfig();
    const client = this._createRegistryClient(sdk, cfg.baseUrl);
    return client.getCredit(did);
  }

  static async getAgent(did) {
    const sdk = await loadSdk();
    const cfg = getConfig();
    const client = this._createRegistryClient(sdk, cfg.baseUrl);
    return client.getAgent(did);
  }

  static async listAgents() {
    const identity = await this._loadActiveIdentity();
    const sdk = await loadSdk();
    const cfg = getConfig();
    const wallet = new Wallet(identity.walletPrivateKey);
    const token = await this._getWalletToken(wallet);
    const client = this._createRegistryClient(sdk, cfg.baseUrl);
    return client.listAgents(token);
  }

  static async status() {
    const identity = await this._loadActiveIdentity();
    const credit = await this.getCredit(identity.did);
    return {
      ready: true,
      baseUrl: getConfig().baseUrl,
      identity: this._formatIdentity(identity),
      credit,
      mask: {
        walletPrivateKey: mask(identity.walletPrivateKey),
        ed25519PrivateKey: mask(identity.ed25519PrivateKey),
      },
    };
  }

  static async signHttpRequest({ method, url, body }) {
    const identity = await this._loadActiveIdentity();
    const sdk = await loadSdk();
    const privateKey = sdk.base64urlDecode(identity.ed25519PrivateKey);
    const bodyBytes = body
      ? (typeof body === 'string' ? new TextEncoder().encode(body) : new TextEncoder().encode(safeJson(body)))
      : new Uint8Array(0);
    const headers = await sdk.signHttpRequest(privateKey, method.toUpperCase(), url, bodyBytes);
    return {
      ...headers,
      'X-Agent-DID': identity.did,
    };
  }

  static async verifyHttpSignature({ did, method, url, body, timestamp, nonce, signature }) {
    const sdk = await loadSdk();
    const agent = await this.getAgent(did);
    if (!agent || !agent.public_key) {
      throw new Error('Agent not found or has no registered public key');
    }
    const publicKey = sdk.base64urlDecode(agent.public_key);
    const bodyBytes = body
      ? (typeof body === 'string' ? new TextEncoder().encode(body) : new TextEncoder().encode(safeJson(body)))
      : new Uint8Array(0);
    const sigBytes = typeof signature === 'string' ? sdk.base64urlDecode(signature) : signature;
    const valid = sdk.verifyHttpSignature(publicKey, method.toUpperCase(), url, bodyBytes, String(timestamp), nonce, sigBytes);
    return { valid, did, agentName: agent.name, creditScore: agent.credit_score };
  }

  static async initialize() {
    const cfg = getConfig();
    if (cfg.autoRegister) {
      await this._loadActiveIdentity();
    } else {
      await this.ensureTables();
    }
  }
}

module.exports = { OpenAgentIdEngine };
