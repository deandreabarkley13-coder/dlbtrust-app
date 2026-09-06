'use strict';

/**
 * SIWE (Sign-In With Ethereum, EIP-4361) authentication.
 *
 * Lets a connected wallet authenticate against the dApp portal without an
 * email OTP: the client requests a nonce, signs the canonical SIWE message,
 * and posts the message + signature back. Verification is a pure signature
 * check — it never moves value and never touches a live rail; the smart
 * account the session is bound to is still provisioned in shadow mode until
 * the AA_* live flags are set.
 */

const crypto = require('crypto');

let viem;
try { viem = require('viem'); } catch (e) { /* verification reports unavailable deps */ }

let jwt;
try { jwt = require('jsonwebtoken'); } catch (e) { /* token issuance disabled */ }

const { JWT_SECRET } = require('./userAuth');

const NONCE_TTL_MS = Number(process.env.SIWE_NONCE_TTL_MS || 10 * 60 * 1000);
const nonces = new Map();

function pruneNonces(now = Date.now()) {
  for (const [nonce, entry] of nonces) if (entry.expiresAt <= now) nonces.delete(nonce);
}

function allowedDomains() {
  const raw = process.env.SIWE_ALLOWED_DOMAINS || '';
  return raw.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
}

class SiweAuth {
  static config() {
    return {
      enabled: (process.env.SIWE_ENABLED || 'true') !== 'false',
      chainId: Number(process.env.SIWE_CHAIN_ID || process.env.DAPP_CHAIN_ID || 1),
      statement: process.env.SIWE_STATEMENT || 'Sign in to the DLB Trust portal.',
      allowedDomains: allowedDomains(),
      nonceTtlMs: NONCE_TTL_MS,
    };
  }

  static createNonce({ address, domain } = {}) {
    pruneNonces();
    const nonce = crypto.randomBytes(16).toString('hex');
    const issuedAt = new Date();
    const expiresAt = issuedAt.getTime() + NONCE_TTL_MS;
    nonces.set(nonce, {
      address: address ? String(address).toLowerCase() : null,
      domain: domain ? String(domain).toLowerCase() : null,
      expiresAt,
    });
    return { nonce, issuedAt: issuedAt.toISOString(), expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Canonical EIP-4361 message the client is expected to sign. */
  static buildMessage({ domain, address, uri, chainId, nonce, statement, issuedAt } = {}) {
    const cfg = this.config();
    const lines = [
      `${domain} wants you to sign in with your Ethereum account:`,
      address,
      '',
      statement || cfg.statement,
      '',
      `URI: ${uri || `https://${domain}`}`,
      'Version: 1',
      `Chain ID: ${chainId || cfg.chainId}`,
      `Nonce: ${nonce}`,
      `Issued At: ${issuedAt || new Date().toISOString()}`,
    ];
    return lines.join('\n');
  }

  static parseMessage(message) {
    const text = String(message || '');
    const lines = text.split('\n');
    const header = lines[0] || '';
    const domainMatch = header.match(/^(\S+) wants you to sign in with your Ethereum account:$/);
    const field = (name) => {
      const line = lines.find((l) => l.startsWith(`${name}: `));
      return line ? line.slice(name.length + 2).trim() : null;
    };
    return {
      domain: domainMatch ? domainMatch[1] : null,
      address: (lines[1] || '').trim() || null,
      statement: (lines[3] || '').trim() || null,
      uri: field('URI'),
      version: field('Version'),
      chainId: field('Chain ID') ? Number(field('Chain ID')) : null,
      nonce: field('Nonce'),
      issuedAt: field('Issued At'),
      expirationTime: field('Expiration Time'),
    };
  }

  /**
   * Verify a SIWE message + signature. Consumes the nonce on success so a
   * captured signature cannot be replayed.
   */
  static async verify({ message, signature } = {}) {
    const cfg = this.config();
    if (!cfg.enabled) throw new Error('SIWE authentication disabled');
    if (!viem) throw new Error('viem not available for SIWE verification');
    if (!message || !signature) throw new Error('message and signature required');

    const fields = this.parseMessage(message);
    if (!fields.address || !viem.isAddress(fields.address)) throw new Error('invalid SIWE address');
    if (!fields.nonce) throw new Error('SIWE nonce missing');
    if (fields.expirationTime && Date.parse(fields.expirationTime) < Date.now()) throw new Error('SIWE message expired');

    if (cfg.allowedDomains.length && !cfg.allowedDomains.includes(String(fields.domain || '').toLowerCase())) {
      throw new Error(`SIWE domain not allowed: ${fields.domain}`);
    }

    pruneNonces();
    const stored = nonces.get(fields.nonce);
    if (!stored) throw new Error('SIWE nonce unknown or expired');
    if (stored.address && stored.address !== fields.address.toLowerCase()) throw new Error('SIWE nonce address mismatch');

    const valid = await viem.verifyMessage({ address: viem.getAddress(fields.address), message: String(message), signature });
    if (!valid) throw new Error('SIWE signature invalid');

    nonces.delete(fields.nonce);
    return {
      address: viem.getAddress(fields.address),
      chainId: fields.chainId || cfg.chainId,
      domain: fields.domain,
      nonce: fields.nonce,
      issuedAt: fields.issuedAt,
    };
  }

  /** Session token for a verified wallet; mirrors the OTP JWT claim shape. */
  static issueToken({ address, roles = ['beneficiary'], role, userId, email } = {}) {
    if (!jwt) throw new Error('jsonwebtoken not available');
    const payload = {
      userId: userId || `wallet:${String(address).toLowerCase()}`,
      email: email || null,
      walletAddress: address,
      authMethod: 'siwe',
      role: role || roles[0] || 'beneficiary',
      roles,
      tokenId: `SIWE-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
    };
    const expiresIn = process.env.SIWE_TOKEN_TTL || '8h';
    return { token: jwt.sign(payload, JWT_SECRET, { expiresIn }), payload };
  }

  /** Test/support hook: drop cached nonces. */
  static _resetNonces() { nonces.clear(); }
}

module.exports = { SiweAuth };
