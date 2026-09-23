'use strict';

/**
 * Stellar transaction signing, decoupled from where the key lives.
 *
 * Settlement is irreversible, so the distributor key is the most sensitive
 * material in the trust. Backends:
 *
 *   env      — Ed25519 secret from STABLECOIN_DISTRIBUTOR_SECRET. Convenient for
 *              testnet; refused on mainnet unless explicitly opted in.
 *   vault    — HashiCorp Vault Transit. The key never leaves Vault; we send the
 *              32-byte transaction hash and receive a signature.
 *   external — Any HTTPS signer (HSM proxy, Turnkey, Magic, custom) that signs a
 *              hash for a given public key. Same contract as Vault, different wire
 *              format.
 *
 * Remote backends sign Stellar's transaction hash directly: Ed25519 takes the
 * message unhashed, and Stellar's signature payload *is* the 32-byte hash, so a
 * plain Ed25519 sign over those bytes is a valid signature.
 */

let sdk;
try {
  sdk = require('@stellar/stellar-sdk');
} catch (err) {
  sdk = null;
}

const { getConfig, isProduction } = require('./config');

const BACKENDS = new Set(['env', 'vault', 'external']);

function requireSdk() {
  if (!sdk) throw new Error('Stellar SDK is not installed');
  return sdk;
}

/**
 * Attach a raw 64-byte Ed25519 signature to a transaction on behalf of a public
 * key we do not hold the secret for. The signature is verified against that key
 * first, so a spoofed or misconfigured signer fails here rather than as a
 * tx_bad_auth after submission.
 */
function attachSignature(tx, publicKey, signature) {
  const s = requireSdk();
  if (!Buffer.isBuffer(signature) || signature.length !== 64) {
    throw new Error(`Signer returned a ${Buffer.isBuffer(signature) ? signature.length : 'non-buffer'} signature; expected 64 bytes`);
  }
  if (!s.Keypair.fromPublicKey(publicKey).verify(tx.hash(), signature)) {
    throw new Error('Signer returned a signature that does not verify against the distributor public key');
  }
  const raw = s.StrKey.decodeEd25519PublicKey(publicKey);
  const hint = raw.slice(-4);
  tx.signatures.push(new s.xdr.DecoratedSignature({ hint, signature }));
  return tx;
}

class EnvSigner {
  constructor(secret) {
    const s = requireSdk();
    try {
      this.keypair = s.Keypair.fromSecret(secret);
    } catch (e) {
      throw new Error('Invalid Stellar secret key');
    }
  }

  get backend() { return 'env'; }

  publicKey() { return this.keypair.publicKey(); }

  async signTransaction(tx) {
    tx.sign(this.keypair);
    return tx;
  }
}

/**
 * Signs via a remote service that never discloses the key. Subclasses implement
 * signHash().
 */
class RemoteSigner {
  constructor({ publicKey, timeoutMs }) {
    if (!publicKey) {
      throw new Error('STABLECOIN_DISTRIBUTOR_PUBLIC is required when signing with a remote key custodian');
    }
    const s = requireSdk();
    if (!s.StrKey.isValidEd25519PublicKey(publicKey)) {
      throw new Error('STABLECOIN_DISTRIBUTOR_PUBLIC is not a valid Stellar public key');
    }
    this._publicKey = publicKey;
    this.timeoutMs = timeoutMs;
  }

  publicKey() { return this._publicKey; }

  async signTransaction(tx) {
    const signature = await this.signHash(tx.hash());
    return attachSignature(tx, this._publicKey, signature);
  }

  async postJson(url, { headers, body }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = null; }
      if (!res.ok) {
        // Signer responses can echo request material; surface status only.
        throw new Error(`${this.backend} signer rejected the request: HTTP ${res.status}`);
      }
      if (!parsed) throw new Error(`${this.backend} signer returned a non-JSON response`);
      return parsed;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`${this.backend} signer timed out after ${this.timeoutMs}ms`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

class VaultSigner extends RemoteSigner {
  constructor(cfg) {
    super({ publicKey: cfg.distributorPublic, timeoutMs: cfg.signerTimeoutMs });
    if (!cfg.vaultAddr) throw new Error('VAULT_ADDR is required for the vault signer');
    if (!cfg.vaultToken) throw new Error('VAULT_TOKEN is required for the vault signer');
    if (!cfg.vaultKeyName) throw new Error('VAULT_TRANSIT_KEY is required for the vault signer');
    this.cfg = cfg;
  }

  get backend() { return 'vault'; }

  async signHash(hash) {
    const mount = this.cfg.vaultTransitMount.replace(/^\/|\/$/g, '');
    const url = `${this.cfg.vaultAddr.replace(/\/$/, '')}/v1/${mount}/sign/${encodeURIComponent(this.cfg.vaultKeyName)}`;
    const body = await this.postJson(url, {
      headers: { 'X-Vault-Token': this.cfg.vaultToken },
      // Ed25519 signs the message as-is; the Stellar payload is already the hash.
      body: { input: Buffer.from(hash).toString('base64'), prehashed: false },
    });
    const sig = body && body.data && body.data.signature;
    if (typeof sig !== 'string') throw new Error('vault signer response is missing data.signature');
    // Vault returns "vault:v1:<base64>".
    const encoded = sig.split(':').pop();
    return Buffer.from(encoded, 'base64');
  }
}

class ExternalSigner extends RemoteSigner {
  constructor(cfg) {
    super({ publicKey: cfg.distributorPublic, timeoutMs: cfg.signerTimeoutMs });
    if (!cfg.externalSignerUrl) throw new Error('STABLECOIN_SIGNER_URL is required for the external signer');
    if (!/^https:/i.test(cfg.externalSignerUrl) && isProduction(cfg)) {
      throw new Error('STABLECOIN_SIGNER_URL must use HTTPS on mainnet');
    }
    this.cfg = cfg;
  }

  get backend() { return 'external'; }

  async signHash(hash) {
    const headers = {};
    if (this.cfg.externalSignerToken) headers.Authorization = `Bearer ${this.cfg.externalSignerToken}`;
    const body = await this.postJson(this.cfg.externalSignerUrl, {
      headers,
      body: {
        publicKey: this.publicKey(),
        network: this.cfg.network,
        algorithm: 'ed25519',
        payloadBase64: Buffer.from(hash).toString('base64'),
      },
    });
    const sig = body.signature || body.signatureBase64;
    if (typeof sig !== 'string') throw new Error('external signer response is missing "signature"');
    return Buffer.from(sig, 'base64');
  }
}

function selectedBackend(cfg) {
  const backend = (cfg.signerBackend || 'env').toLowerCase();
  if (!BACKENDS.has(backend)) {
    throw new Error(`STABLECOIN_SIGNER must be one of ${[...BACKENDS].join(', ')} (got "${backend}")`);
  }
  return backend;
}

/**
 * Reject a mainnet configuration that keeps the distributor key in the process
 * environment. Irreversible transfers should be signed by a custodian.
 */
function assertCustodyAllowed(cfg, backend) {
  if (backend !== 'env' || !isProduction(cfg)) return;
  if (cfg.allowEnvKeyOnMainnet) return;
  throw new Error(
    'Refusing to sign mainnet settlement with a distributor key held in the environment: '
    + 'set STABLECOIN_SIGNER=vault|external, or STABLECOIN_ALLOW_ENV_KEY_MAINNET=true to accept the risk'
  );
}

function createSigner(config) {
  const cfg = config || getConfig();
  const backend = selectedBackend(cfg);
  assertCustodyAllowed(cfg, backend);

  if (backend === 'vault') return new VaultSigner(cfg);
  if (backend === 'external') return new ExternalSigner(cfg);
  if (!cfg.distributorSecret) {
    throw new Error('STABLECOIN_DISTRIBUTOR_SECRET not configured');
  }
  return new EnvSigner(cfg.distributorSecret);
}

/**
 * Distributor public key without unlocking a signer — used by readiness checks so
 * a misconfigured custodian still reports rather than throwing.
 */
function distributorPublicKey(config) {
  const cfg = config || getConfig();
  if (cfg.distributorPublic) return cfg.distributorPublic;
  if (selectedBackend(cfg) === 'env' && cfg.distributorSecret && sdk) {
    try {
      return sdk.Keypair.fromSecret(cfg.distributorSecret).publicKey();
    } catch (e) {
      return null;
    }
  }
  return null;
}

function custodyStatus(config) {
  const cfg = config || getConfig();
  let backend = null;
  const issues = [];
  try {
    backend = selectedBackend(cfg);
    assertCustodyAllowed(cfg, backend);
  } catch (e) {
    issues.push(e.message);
  }
  let distributorPublic = cfg.distributorPublic || null;
  if (!distributorPublic && backend) {
    distributorPublic = distributorPublicKey(cfg);
  }
  if (backend === 'env' && !cfg.distributorSecret) {
    issues.push('STABLECOIN_DISTRIBUTOR_SECRET is required to sign settlement transactions');
  }
  return {
    backend,
    custodial: backend === 'vault' || backend === 'external',
    keyInEnvironment: backend === 'env',
    distributorPublic,
    issues,
  };
}

module.exports = {
  createSigner,
  custodyStatus,
  distributorPublicKey,
  attachSignature,
  assertCustodyAllowed,
  selectedBackend,
  EnvSigner,
  VaultSigner,
  ExternalSigner,
  BACKENDS,
};
