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
let _initPromise = null;
let _registerInProgress = false;

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
    || process.env.PAYMENT_DATA_ENCRYPTION_KEY;

  if (!material) {
    throw new Error('OPEN_AGENT_ID_ENCRYPTION_KEY or PAYMENT_DATA_ENCRYPTION_KEY must be set (64 hex chars or 43-char base64url)');
  }

  if (/^[a-f0-9]{64}$/i.test(material)) {
    return Buffer.from(material, 'hex');
  }

  if (/^[A-Za-z0-9_-]{43}$/.test(material)) {
    const decoded = Buffer.from(material, 'base64url');
    if (decoded.length === 32) return decoded;
  }

  throw new Error('OPEN_AGENT_ID_ENCRYPTION_KEY must be 64 hex chars or 43-char base64url');
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
        is_active BOOLEAN DEFAULT TRUE,
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`ALTER TABLE open_agent_identities ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE`);
    await query(`CREATE INDEX IF NOT EXISTS idx_open_agent_identities_did ON open_agent_identities(did)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_open_agent_identities_active ON open_agent_identities(is_active)`);
    // Ensure only one active identity row; the newest active row wins.
    await query(`
      UPDATE open_agent_identities
      SET is_active = false
      WHERE is_active = true
        AND id NOT IN (
          SELECT id FROM open_agent_identities WHERE is_active = true ORDER BY id DESC LIMIT 1
        )
    `);
    // Enforce a single active row at the database level.
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_open_agent_identities_single_active ON open_agent_identities(is_active) WHERE is_active = true`);
  }

  static getConfig() {
    return getConfig();
  }

  static async getIdentity() {
    await this.ensureTables();
    const res = await query('SELECT * FROM open_agent_identities WHERE is_active = true ORDER BY id DESC LIMIT 1');
    return res.rows[0] || null;
  }

  static async _getActiveIdentity() {
    const identity = await this.getIdentity();
    if (identity) return this._decryptIdentity(identity);
    throw new Error('No active OpenAgentID identity. Set OPEN_AGENT_ID_AUTO_REGISTER=true on startup or POST /api/open-agent-id/register.');
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
    if (_registerInProgress) {
      throw new Error('Registration already in progress. Wait for completion or check /api/open-agent-id/status.');
    }
    _registerInProgress = true;
    try {
      return await this._registerIdentity({ name, capabilities });
    } finally {
      _registerInProgress = false;
    }
  }

  static async _registerIdentity({ name, capabilities } = {}) {
    await this.ensureTables();
    const existing = await this.getIdentity();
    if (existing) {
      throw new Error('An active OpenAgentID identity already exists. Deactivate it or use a different tenant.');
    }

    // Fail fast before creating anything remotely: without a valid key we cannot persist the wallet.
    getEncryptionKey();

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

    const insertRes = await query(
      `INSERT INTO open_agent_identities
        (agent_name, wallet_address, wallet_private_key_encrypted, ed25519_public_key, ed25519_private_key_encrypted, did, agent_address, is_active, metadata)
       SELECT $1, $2, $3, $4, $5, $6, $7, TRUE, $8
       WHERE NOT EXISTS (SELECT 1 FROM open_agent_identities WHERE is_active = true)
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
    ).catch((err) => {
      if (err && err.code === '23505') {
        const conflict = new Error('An active OpenAgentID identity already exists. Deactivate it or use a different tenant.');
        conflict.status = 409;
        throw conflict;
      }
      throw err;
    });

    if (!insertRes.rows[0]) {
      throw new Error('An active OpenAgentID identity already exists. Deactivate it or use a different tenant.');
    }

    return this._decryptIdentity(insertRes.rows[0]);
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
    const identity = await this._getActiveIdentity();
    const sdk = await loadSdk();
    const cfg = getConfig();
    const wallet = new Wallet(identity.walletPrivateKey);
    const token = await this._getWalletToken(wallet);
    const client = this._createRegistryClient(sdk, cfg.baseUrl);
    return client.listAgents(token);
  }

  static async status() {
    await this.ensureTables();
    const identity = await this.getIdentity();
    const cfg = getConfig();
    if (!identity) {
      return {
        ready: false,
        baseUrl: cfg.baseUrl,
        configured: cfg,
        error: 'No active OpenAgentID identity. Set OPEN_AGENT_ID_AUTO_REGISTER=true on startup or POST /api/open-agent-id/register.',
      };
    }
    const decrypted = this._decryptIdentity(identity);
    const credit = await this.getCredit(decrypted.did);
    return {
      ready: true,
      baseUrl: cfg.baseUrl,
      identity: this._formatIdentity(decrypted),
      credit,
      mask: {
        walletPrivateKey: mask(decrypted.walletPrivateKey),
        ed25519PrivateKey: mask(decrypted.ed25519PrivateKey),
      },
    };
  }

  static _toBodyBytes(body) {
    if (body === undefined || body === null) return new Uint8Array(0);
    if (body instanceof Uint8Array) return body;
    if (typeof body === 'string') return new TextEncoder().encode(body);
    return new TextEncoder().encode(safeJson(body));
  }

  static async signHttpRequest({ method, url, body }) {
    const identity = await this._getActiveIdentity();
    const sdk = await loadSdk();
    const privateKey = sdk.base64urlDecode(identity.ed25519PrivateKey);
    const bodyBytes = this._toBodyBytes(body);
    const headers = await sdk.signHttpRequest(privateKey, method.toUpperCase(), url, bodyBytes);
    return {
      ...headers,
      'X-Agent-DID': identity.did,
    };
  }

  static async verifyHttpSignature({ did, method, url, body, timestamp, nonce, signature }) {
    if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof Uint8Array)) {
      throw new Error('body must be the exact raw string or Uint8Array that was signed');
    }
    const sdk = await loadSdk();
    const agent = await this.getAgent(did);
    if (!agent || !agent.public_key) {
      throw new Error('Agent not found or has no registered public key');
    }
    const publicKey = sdk.base64urlDecode(agent.public_key);
    const bodyBytes = this._toBodyBytes(body);
    const sigBytes = typeof signature === 'string' ? sdk.base64urlDecode(signature) : signature;
    const valid = sdk.verifyHttpSignature(publicKey, method.toUpperCase(), url, bodyBytes, String(timestamp), nonce, sigBytes);
    return { valid, did, agentName: agent.name, creditScore: agent.credit_score };
  }

  static async initialize() {
    if (_initPromise) return _initPromise;
    _initPromise = this._initialize().finally(() => { _initPromise = null; });
    return _initPromise;
  }

  static async _initialize() {
    await this.ensureTables();
    const cfg = getConfig();
    if (!cfg.autoRegister) return { ready: false, reason: 'auto-register disabled' };
    const identity = await this.getIdentity();
    if (identity) return { ready: true, identity: this._formatIdentity(this._decryptIdentity(identity)) };
    const newIdentity = await this.registerIdentity();
    return { ready: true, identity: this._formatIdentity(newIdentity) };
  }
}

module.exports = { OpenAgentIdEngine };
