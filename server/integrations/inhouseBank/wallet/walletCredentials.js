'use strict';

/**
 * Wallet API credentials — how a wallet holder (or their app) authenticates
 *
 * The in-house bank's zero-trust gateway authenticates the *trust's* own
 * operators and services. A wallet holder is neither: they must be able to see
 * and spend exactly one wallet and nothing else, from a device the trust does
 * not administer. So they get their own credential type, and it carries the
 * wallet identity itself rather than a role.
 *
 * What makes this safe to hand out:
 *
 *   • The secret is generated here, hashed, and never stored or returned
 *     again. A leaked database gives an attacker a hash of 256 bits of
 *     entropy, which is not searchable — so the hash is a plain SHA-256 and
 *     not a password KDF, because there is no password to stretch.
 *   • Comparison is timing-safe, and a revoked, expired or wrong-wallet
 *     credential is refused before any wallet state is read.
 *   • Scopes are per credential, so a read-only key for a bookkeeper and a
 *     spending key for a family member are different keys with different
 *     blast radii.
 *
 * The credential authenticates; it never authorizes an amount. Every payment a
 * wallet key initiates still passes the wallet's spend controls and then the
 * bank's own governance.
 */

const crypto = require('crypto');
const pool = require('../../bonds/pgPool');
const { WalletEngine, WalletError } = require('./walletEngine');

const SCOPES = Object.freeze(['wallet:read', 'wallet:pay', 'wallet:transfer']);
const DEFAULT_SCOPES = Object.freeze(['wallet:read', 'wallet:pay', 'wallet:transfer']);

class WalletCredentialError extends Error {
  constructor(message, code = 'WALLET_CREDENTIAL_DENIED', status = 401) {
    super(message);
    this.name = 'WalletCredentialError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a == null ? '' : a));
  const right = Buffer.from(String(b == null ? '' : b));
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

function publicCredential(row) {
  if (!row) return null;
  return {
    credentialId: row.credential_id,
    keyId: row.key_id,
    walletId: row.wallet_id,
    label: row.label,
    scopes: Array.isArray(row.scopes) ? row.scopes : JSON.parse(row.scopes || '[]'),
    status: row.status,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
  };
}

class WalletCredentials {
  static scopes() {
    return SCOPES.slice();
  }

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ihb_wallet_credentials (
        credential_id TEXT PRIMARY KEY,
        key_id        TEXT UNIQUE NOT NULL,
        wallet_id     TEXT NOT NULL,
        secret_hash   TEXT NOT NULL,
        label         TEXT,
        scopes        JSONB NOT NULL DEFAULT '[]',
        status        TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','revoked')),
        last_used_at  TIMESTAMPTZ,
        expires_at    TIMESTAMPTZ,
        created_by    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at    TIMESTAMPTZ,
        revoked_by    TEXT
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ihb_wallet_credentials_wallet ON ihb_wallet_credentials (wallet_id, status)`);
    return true;
  }

  /**
   * Issue a key pair for a wallet. The secret in the response is the only time
   * it exists outside the caller's hands; losing it means issuing a new one.
   */
  static async issue(walletRef, { label = null, scopes = DEFAULT_SCOPES, expiresInDays = null, createdBy = 'operator' } = {}) {
    await this.ensureTables();
    const wallet = await WalletEngine.require(walletRef);
    if (wallet.status === 'closed') {
      throw new WalletError(`Wallet ${wallet.handle} is closed and cannot be given credentials`, 'WALLET_INACTIVE');
    }
    const requested = Array.from(new Set(scopes && scopes.length ? scopes : DEFAULT_SCOPES));
    const unknown = requested.filter(scope => !SCOPES.includes(scope));
    if (unknown.length) {
      throw new WalletCredentialError(`Unknown wallet scope(s): ${unknown.join(', ')}`, 'WALLET_BAD_SCOPE', 400);
    }

    const keyId = `wk_${crypto.randomBytes(8).toString('hex')}`;
    const secret = `ws_${crypto.randomBytes(32).toString('base64url')}`;
    const expiresAt = expiresInDays
      ? new Date(Date.now() + Math.max(1, Math.round(Number(expiresInDays))) * 86400000)
      : null;

    const rows = await pool.query(
      `INSERT INTO ihb_wallet_credentials (credential_id, key_id, wallet_id, secret_hash, label, scopes, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        `WKC-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
        keyId, wallet.walletId, hashSecret(secret), label, JSON.stringify(requested), expiresAt, createdBy,
      ]
    );

    return {
      credential: publicCredential(rows.rows[0]),
      keyId,
      secret,
      note: 'The secret is shown once and is not recoverable; store it in the holder\'s key store now.',
    };
  }

  static async list(walletRef, { includeRevoked = false } = {}) {
    await this.ensureTables();
    const wallet = await WalletEngine.require(walletRef);
    const rows = await pool.query(
      `SELECT * FROM ihb_wallet_credentials
        WHERE wallet_id = $1 AND ($2::boolean OR status = 'active')
        ORDER BY created_at DESC`,
      [wallet.walletId, Boolean(includeRevoked)]
    );
    return rows.rows.map(publicCredential);
  }

  static async revoke(keyId, { actor = 'operator' } = {}) {
    await this.ensureTables();
    const rows = await pool.query(
      `UPDATE ihb_wallet_credentials
          SET status = 'revoked', revoked_at = NOW(), revoked_by = $2
        WHERE key_id = $1 AND status = 'active'
        RETURNING *`,
      [keyId, actor]
    );
    if (!rows.rows[0]) {
      throw new WalletCredentialError(`Wallet credential ${keyId} is not active`, 'WALLET_CREDENTIAL_NOT_ACTIVE', 404);
    }
    return publicCredential(rows.rows[0]);
  }

  /** Revoke and reissue in one step, so a rotation cannot leave a wallet with no key. */
  static async rotate(keyId, { actor = 'operator' } = {}) {
    await this.ensureTables();
    const rows = await pool.query('SELECT * FROM ihb_wallet_credentials WHERE key_id = $1', [keyId]);
    const existing = publicCredential(rows.rows[0]);
    if (!existing) throw new WalletCredentialError(`Wallet credential ${keyId} not found`, 'WALLET_CREDENTIAL_NOT_FOUND', 404);
    const issued = await this.issue(existing.walletId, {
      label: existing.label ? `${existing.label} (rotated)` : 'rotated',
      scopes: existing.scopes,
      createdBy: actor,
    });
    if (existing.status === 'active') await this.revoke(keyId, { actor });
    return { ...issued, replaced: keyId };
  }

  /**
   * Verify a presented credential for one operation.
   * @returns {{principal: string, walletId: string, handle: string, scopes: string[], keyId: string}}
   */
  static async verify({ keyId, secret, scope = null } = {}) {
    await this.ensureTables();
    if (!keyId || !secret) {
      throw new WalletCredentialError('A wallet key id and secret are required', 'WALLET_NO_CREDENTIAL', 401);
    }
    const rows = await pool.query('SELECT * FROM ihb_wallet_credentials WHERE key_id = $1', [keyId]);
    const record = rows.rows[0];
    // Hash the presented secret regardless, so a missing key and a wrong
    // secret take the same work and cannot be told apart by timing.
    const presented = hashSecret(secret);
    if (!record || !safeEqual(presented, record.secret_hash)) {
      throw new WalletCredentialError('Wallet credential is not valid', 'WALLET_BAD_CREDENTIAL', 401);
    }
    if (record.status !== 'active') {
      throw new WalletCredentialError('Wallet credential has been revoked', 'WALLET_CREDENTIAL_REVOKED', 401);
    }
    if (record.expires_at && new Date(record.expires_at).getTime() < Date.now()) {
      throw new WalletCredentialError('Wallet credential has expired', 'WALLET_CREDENTIAL_EXPIRED', 401);
    }

    const credential = publicCredential(record);
    if (scope && !credential.scopes.includes(scope)) {
      throw new WalletCredentialError(`This wallet key may not ${scope}`, 'WALLET_SCOPE_DENIED', 403);
    }

    const wallet = await WalletEngine.require(credential.walletId);
    if (wallet.status === 'closed') {
      throw new WalletCredentialError(`Wallet ${wallet.handle} is closed`, 'WALLET_INACTIVE', 403);
    }

    await pool.query('UPDATE ihb_wallet_credentials SET last_used_at = NOW() WHERE key_id = $1', [keyId])
      .catch(() => null);

    return {
      principal: `wallet:${wallet.handle}`,
      keyId,
      credentialId: credential.credentialId,
      walletId: wallet.walletId,
      handle: wallet.handle,
      status: wallet.status,
      scopes: credential.scopes,
      scope,
      verifiedAt: new Date().toISOString(),
    };
  }
}

module.exports = { WalletCredentials, WalletCredentialError, WALLET_SCOPES: SCOPES };
