'use strict';

/**
 * Smart Wallet Provisioner — unified wallet issuance for portal users.
 *
 * Bridges Connect & Auth (email OTP / SIWE) to the ERC-4337 stack: every
 * authenticated portal user gets one deterministic smart wallet whose owner is
 * their EOA, plus gas sponsorship so the user never needs native gas.
 *
 * Two providers implement that, chosen with SMART_ACCOUNT_PROVIDER:
 *
 *   thirdweb (default) — thirdweb's AccountFactory, bundler and project-level
 *     gas sponsorship (ThirdwebWalletEngine). Sponsorship eligibility is a
 *     project policy, so there is no on-chain whitelist transaction.
 *   simple_account — the self-hosted SimpleAccountFactory plus the trust's own
 *     SovereignTrustPaymaster (AccountAbstractionEngine), which does whitelist
 *     each sender on chain once AA_SHADOW=false.
 *
 * No value moves here under either provider. Provisioning is address
 * derivation plus a sponsorship registration, and both stay shadow no-ops
 * until the provider's own flag is flipped (THIRDWEB_SHADOW=false /
 * AA_SHADOW=false). While shadow is on — the default — the predicted address
 * is derived off-chain and nothing is broadcast on any chain.
 */

const crypto = require('crypto');

const { AccountAbstractionEngine } = require('./accountAbstractionEngine');
const { ThirdwebWalletEngine } = require('./thirdwebWalletEngine');

const THIRDWEB = 'thirdweb';

let viem;
try { viem = require('viem'); } catch (e) { /* address derivation falls back to the shadow hash */ }

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

const memoryAccounts = new Map();

let columnsReady = null;

function checksum(address) {
  if (viem && viem.isAddress && viem.isAddress(address)) return viem.getAddress(address);
  return address;
}

/**
 * Deterministic owner EOA for a user that has never connected a wallet.
 * Derived from the email and SMART_ACCOUNT_OWNER_SALT so the same user always
 * maps to the same owner/smart-account pair. It is a placeholder identity: no
 * private key exists for it, so it can never sign a live transaction — a real
 * owner replaces it as soon as the user links a wallet.
 */
function derivedOwnerAddress(email) {
  const salt = process.env.SMART_ACCOUNT_OWNER_SALT || 'dlbtrust-smart-account-v1';
  const digest = crypto.createHash('sha256').update(`${salt}:${String(email).toLowerCase()}`).digest('hex');
  return checksum(`0x${digest.slice(0, 40)}`);
}

/**
 * Off-chain stand-in for SimpleAccountFactory.getAddress(owner, salt). Used
 * whenever the factory cannot be read (shadow mode, no RPC, viem missing) so
 * the workflow is identical with and without a live chain.
 */
function shadowSmartAccountAddress(factory, owner, index) {
  const digest = crypto.createHash('sha256')
    .update(`${String(factory).toLowerCase()}:${String(owner).toLowerCase()}:${index}`)
    .digest('hex');
  return checksum(`0x${digest.slice(0, 40)}`);
}

async function ensureColumns() {
  if (!pool || !pool.query) return;
  if (columnsReady) return columnsReady;
  columnsReady = (async () => {
    await pool.query(`ALTER TABLE dapp_users ADD COLUMN IF NOT EXISTS smart_account_address TEXT`);
    await pool.query(`ALTER TABLE dapp_users ADD COLUMN IF NOT EXISTS smart_account_owner TEXT`);
    await pool.query(`ALTER TABLE dapp_users ADD COLUMN IF NOT EXISTS smart_account_mode TEXT`);
    await pool.query(`ALTER TABLE dapp_users ADD COLUMN IF NOT EXISTS smart_account_provider TEXT`);
  })().catch((e) => {
    columnsReady = null;
    throw e;
  });
  return columnsReady;
}

class SmartWalletProvisioner {
  static config() {
    const provider = (process.env.SMART_ACCOUNT_PROVIDER || THIRDWEB).toLowerCase();
    const enabled = (process.env.SMART_ACCOUNT_AUTO_PROVISION || 'true') !== 'false';
    const index = BigInt(process.env.SMART_ACCOUNT_INDEX || '0');
    if (provider === THIRDWEB) {
      const tw = ThirdwebWalletEngine.getConfig();
      return {
        provider: THIRDWEB,
        enabled: enabled && tw.enabled,
        shadow: tw.shadow !== false,
        chainId: tw.chainId,
        factory: tw.factory,
        paymasterAddress: null,
        accountSalt: tw.accountSalt,
        index,
      };
    }
    const aa = AccountAbstractionEngine.getConfig();
    return {
      provider: 'simple_account',
      enabled,
      shadow: aa.aaShadow !== false,
      chainId: aa.chainId,
      factory: aa.factory,
      paymasterAddress: aa.paymasterAddress,
      index,
    };
  }

  /** Owner EOA for a user: their linked wallet, else the derived placeholder. */
  static ownerFor(user = {}) {
    const linked = user.wallet_address || user.walletAddress || user.safe_owner_address || user.safeOwnerAddress;
    if (linked && (!viem || !viem.isAddress || viem.isAddress(linked))) return checksum(linked);
    return derivedOwnerAddress(user.email || user.id || 'unknown');
  }

  /** Predicted counterfactual smart-account address; never deploys anything. */
  static async predictAddress(owner, index = this.config().index) {
    const cfg = this.config();
    if (cfg.provider === THIRDWEB) {
      const predicted = await ThirdwebWalletEngine.predictAccountAddress(owner, cfg.accountSalt);
      return { address: predicted.address, mode: predicted.mode, ...(predicted.issue ? { issue: predicted.issue } : {}) };
    }
    if (!cfg.shadow) {
      try {
        return { address: checksum(await AccountAbstractionEngine.getSmartAccountAddress(owner, index)), mode: 'live' };
      } catch (e) {
        return { address: shadowSmartAccountAddress(cfg.factory, owner, index), mode: 'shadow', issue: e.message };
      }
    }
    return { address: shadowSmartAccountAddress(cfg.factory, owner, index), mode: 'shadow' };
  }

  /**
   * Provision (or re-read) the user's smart account and register it for
   * sponsored gas with the active provider. Best-effort by design: a login
   * must never fail because the chain, the provider, or the database is
   * unavailable.
   */
  static async provisionForUser(user = {}) {
    const cfg = this.config();
    if (!cfg.enabled) return { enabled: false, mode: 'disabled' };

    const owner = this.ownerFor(user);
    const existing = user.smart_account_address || user.smartAccountAddress;
    const sameOwner = String(user.smart_account_owner || '').toLowerCase() === String(owner).toLowerCase();
    // A stored address belongs to the provider that derived it, so switching
    // SMART_ACCOUNT_PROVIDER re-predicts instead of reusing the old address.
    const storedProvider = user.smart_account_provider || user.smartAccountProvider;
    const sameProvider = !storedProvider || storedProvider === cfg.provider;
    const predicted = existing && sameOwner && sameProvider
      ? { address: checksum(existing), mode: user.smart_account_mode || (cfg.shadow ? 'shadow' : 'live') }
      : await this.predictAddress(owner, cfg.index);

    const record = {
      enabled: true,
      provider: cfg.provider,
      owner,
      ownerType: (user.wallet_address || user.walletAddress) ? 'linked_wallet' : 'derived',
      address: predicted.address,
      mode: predicted.mode,
      chainId: cfg.chainId,
      factory: cfg.factory,
      index: String(cfg.index),
      paymaster: null,
      whitelisted: false,
    };
    if (predicted.issue) record.issue = predicted.issue;

    try {
      if (cfg.provider === THIRDWEB) {
        // thirdweb gates sponsorship with a project policy, so eligibility is
        // recorded locally and no whitelist transaction is ever sent.
        const sponsorship = ThirdwebWalletEngine.registerSponsoredSender(record.address, true);
        record.whitelisted = true;
        record.whitelistMode = sponsorship.shadow ? 'shadow' : 'policy';
        record.sponsorship = sponsorship.policy;
      } else {
        const whitelist = await AccountAbstractionEngine.whitelistSender(record.address, true);
        record.whitelisted = Boolean(whitelist && (whitelist.success || whitelist.shadow));
        record.paymaster = (whitelist && whitelist.paymaster) || cfg.paymasterAddress || null;
        if (whitelist && whitelist.shadow) record.whitelistMode = 'shadow';
        else if (whitelist && whitelist.tx) record.whitelistTx = whitelist.tx;
      }
    } catch (e) {
      record.whitelistError = e.message;
    }

    await this._persist(user, record);
    return record;
  }

  static async _persist(user, record) {
    const userId = user.id || user.userId;
    if (!userId) return;
    memoryAccounts.set(String(userId), record);
    if (!pool || !pool.query) return;
    try {
      await ensureColumns();
      await pool.query(
        `UPDATE dapp_users
            SET smart_account_address = $1, smart_account_owner = $2, smart_account_mode = $3,
                smart_account_provider = $4, updated_at = NOW()
          WHERE id = $5`,
        [record.address, record.owner, record.mode, record.provider, userId]
      );
    } catch (e) {
      console.warn('[smartWallet] persist failed:', e.message);
    }
  }

  /** Wallet-provider status for operator readiness views. */
  static readiness() {
    const cfg = this.config();
    if (cfg.provider === THIRDWEB) return { walletProvider: THIRDWEB, autoProvision: cfg.enabled, ...ThirdwebWalletEngine.readiness() };
    return { walletProvider: 'simple_account', autoProvision: cfg.enabled, shadow: cfg.shadow, chainId: cfg.chainId, factory: cfg.factory, paymasterAddress: cfg.paymasterAddress };
  }

  /** Cached view used by request-time auth so logins stay cheap. */
  static cachedForUser(userId) {
    return memoryAccounts.get(String(userId)) || null;
  }

  static describe(user = {}) {
    const cached = this.cachedForUser(user.id || user.userId);
    if (cached) return cached;
    const address = user.smart_account_address || user.smartAccountAddress;
    if (!address) return null;
    const cfg = this.config();
    return {
      enabled: true,
      provider: user.smart_account_provider || user.smartAccountProvider || cfg.provider,
      owner: user.smart_account_owner || user.smartAccountOwner || null,
      address,
      mode: user.smart_account_mode || user.smartAccountMode || 'shadow',
      chainId: cfg.chainId,
    };
  }
}

module.exports = { SmartWalletProvisioner, derivedOwnerAddress, shadowSmartAccountAddress };
