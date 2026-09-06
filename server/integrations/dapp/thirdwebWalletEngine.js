'use strict';

/**
 * thirdweb wallet engine — ERC-4337 smart accounts, bundler and gas
 * sponsorship provided by thirdweb instead of the self-hosted
 * SimpleAccountFactory + SovereignTrustPaymaster stack.
 *
 * This is the wallet provider behind `SmartWalletProvisioner`, selected with
 * SMART_ACCOUNT_PROVIDER=thirdweb (the default). It covers three things:
 *
 *   1. Counterfactual account address prediction, reading
 *      `AccountFactory.getAddress(admin, salt)` exactly as the thirdweb SDK
 *      does, so an address derived here matches what a thirdweb client
 *      (Connect / smartWallet) derives for the same admin.
 *   2. Gas sponsorship, via `pm_sponsorUserOperation` on the thirdweb bundler
 *      at https://<chainId>.bundler.thirdweb.com/v2.
 *   3. Sponsorship eligibility, which on thirdweb is a project-level policy
 *      (configured in the thirdweb dashboard) rather than an on-chain
 *      whitelist transaction — so registering a sender is a local record, not
 *      a chain write, and it never spends gas.
 *
 * NO VALUE MOVES HERE AND NOTHING IS BROADCAST BY DEFAULT. Address prediction
 * is a read; sponsorship requires both THIRDWEB_GAS_SPONSORSHIP_LIVE=true and
 * a secret key, and with THIRDWEB_SHADOW=true (the default) every method
 * returns a shadow result derived off-chain without contacting thirdweb. Live
 * user-operation submission stays with the caller and its own *_LIVE gates.
 */

const crypto = require('crypto');

const { getConfig: getBaseConfig } = require('./config');

let viem;
try { viem = require('viem'); } catch (e) { /* shadow prediction needs no chain client */ }

// Verified against thirdweb SDK v5 (wallets/smart/lib/constants.ts).
const DEFAULT_ACCOUNT_FACTORY_V0_6 = '0x85e23b94e7F5E9cC1fF78BCe78cfb15B81f0DF00';
const DEFAULT_ACCOUNT_FACTORY_V0_7 = '0x4be0ddfebca9a5a4a617dee4dece99e7c862dceb';
const ENTRY_POINT_V0_6 = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
const ENTRY_POINT_V0_7 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

const FACTORY_ABI = viem && viem.parseAbi ? viem.parseAbi([
  'function getAddress(address admin, bytes data) view returns (address)',
  'function createAccount(address admin, bytes data) returns (address)',
]) : [];

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function bool(name, def = false) { const v = process.env[name]; return v ? String(v).toLowerCase() === 'true' : def; }

function checksum(address) {
  if (viem && viem.isAddress && viem.isAddress(address)) return viem.getAddress(address);
  return address;
}

/** thirdweb encodes a string salt as UTF-8 hex; an empty salt is `0x`. */
function saltHex(salt) {
  if (!salt) return '0x';
  if (/^0x[0-9a-fA-F]*$/.test(salt)) return salt;
  return `0x${Buffer.from(String(salt), 'utf8').toString('hex')}`;
}

class ThirdwebWalletEngine {
  static getConfig() {
    const base = getBaseConfig();
    const chainId = base.chainId;
    const entryPoint = str('THIRDWEB_ENTRY_POINT', ENTRY_POINT_V0_6);
    const defaultFactory = entryPoint.toLowerCase() === ENTRY_POINT_V0_7.toLowerCase()
      ? DEFAULT_ACCOUNT_FACTORY_V0_7
      : DEFAULT_ACCOUNT_FACTORY_V0_6;
    return {
      enabled: bool('THIRDWEB_ENABLED', true),
      shadow: bool('THIRDWEB_SHADOW', true),
      sponsorshipLive: bool('THIRDWEB_GAS_SPONSORSHIP_LIVE', false),
      clientId: str('THIRDWEB_CLIENT_ID'),
      secretKey: str('THIRDWEB_SECRET_KEY'),
      chainId,
      entryPoint,
      factory: str('THIRDWEB_ACCOUNT_FACTORY', defaultFactory),
      accountSalt: str('THIRDWEB_ACCOUNT_SALT'),
      bundlerUrl: str('THIRDWEB_BUNDLER_URL', `https://${chainId}.bundler.thirdweb.com/v2`),
      rpcUrl: str('THIRDWEB_RPC_URL') || base.rpcUrl,
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.enabled) issues.push('THIRDWEB_ENABLED=false');
    if (!cfg.clientId && !cfg.secretKey) issues.push('THIRDWEB_CLIENT_ID or THIRDWEB_SECRET_KEY not configured');
    if (!cfg.rpcUrl) issues.push('no RPC URL (THIRDWEB_RPC_URL or DAPP_RPC_URL)');
    return {
      provider: 'thirdweb',
      enabled: cfg.enabled,
      shadow: cfg.shadow,
      chainId: cfg.chainId,
      entryPoint: cfg.entryPoint,
      factory: cfg.factory,
      bundlerUrl: cfg.bundlerUrl,
      // Gas sponsorship needs the live flag AND a secret key; address
      // prediction works without either.
      canSponsorGas: cfg.sponsorshipLive && Boolean(cfg.secretKey) && !cfg.shadow,
      sponsorshipPolicy: 'thirdweb project policy (dashboard), not an on-chain whitelist',
      ready: issues.length === 0 && cfg.enabled,
      issues,
    };
  }

  /**
   * Off-chain stand-in for `AccountFactory.getAddress`. Deterministic per
   * (factory, admin, salt) so shadow mode produces a stable address without
   * an RPC round trip. It is NOT the CREATE2 address; it is only ever used
   * while THIRDWEB_SHADOW=true or when the factory read fails.
   */
  static shadowAddress(admin, salt = this.getConfig().accountSalt) {
    const cfg = this.getConfig();
    const digest = crypto.createHash('sha256')
      .update(`thirdweb:${cfg.chainId}:${String(cfg.factory).toLowerCase()}:${String(admin).toLowerCase()}:${salt || ''}`)
      .digest('hex');
    return checksum(`0x${digest.slice(0, 40)}`);
  }

  /**
   * Counterfactual smart-account address for an admin EOA. Read-only: the
   * account is not deployed until its first sponsored user operation.
   */
  static async predictAccountAddress(admin, salt = this.getConfig().accountSalt) {
    const cfg = this.getConfig();
    if (!admin) throw new Error('admin address required');
    if (cfg.shadow) return { address: this.shadowAddress(admin, salt), mode: 'shadow', provider: 'thirdweb' };
    if (!viem) return { address: this.shadowAddress(admin, salt), mode: 'shadow', provider: 'thirdweb', issue: 'viem not available' };
    try {
      const client = viem.createPublicClient({ transport: viem.http(cfg.rpcUrl) });
      const address = await client.readContract({
        address: cfg.factory,
        abi: FACTORY_ABI,
        functionName: 'getAddress',
        args: [checksum(admin), saltHex(salt)],
      });
      return { address: checksum(address), mode: 'live', provider: 'thirdweb' };
    } catch (e) {
      return { address: this.shadowAddress(admin, salt), mode: 'shadow', provider: 'thirdweb', issue: e.message };
    }
  }

  /**
   * Record a smart account as eligible for trust-sponsored gas. thirdweb
   * gates sponsorship with project-level rules rather than a paymaster
   * whitelist call, so this performs no transaction and costs nothing — it
   * returns the descriptor the provisioner persists for audit.
   */
  static registerSponsoredSender(address, allowed = true) {
    const cfg = this.getConfig();
    return {
      provider: 'thirdweb',
      address: checksum(address),
      allowed,
      shadow: cfg.shadow,
      onChain: false,
      policy: 'thirdweb project sponsorship rules',
      note: 'No on-chain whitelist transaction exists for thirdweb sponsorship; eligibility is enforced by the project policy at sponsorship time.',
    };
  }

  static _headers(cfg) {
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.secretKey) headers['x-secret-key'] = cfg.secretKey;
    else if (cfg.clientId) headers['x-client-id'] = cfg.clientId;
    return headers;
  }

  /**
   * Ask the thirdweb paymaster to sponsor a user operation. Refuses unless
   * THIRDWEB_GAS_SPONSORSHIP_LIVE=true, THIRDWEB_SHADOW=false and a secret
   * key is present; otherwise it reports what it would have sent.
   */
  static async sponsorUserOperation(userOp) {
    const cfg = this.getConfig();
    const status = this.readiness();
    if (!status.canSponsorGas) {
      return {
        shadow: true,
        provider: 'thirdweb',
        sponsored: false,
        reason: cfg.shadow
          ? 'THIRDWEB_SHADOW=true: no sponsorship request sent'
          : 'THIRDWEB_GAS_SPONSORSHIP_LIVE and THIRDWEB_SECRET_KEY are required to sponsor gas',
        entryPoint: cfg.entryPoint,
      };
    }
    const response = await fetch(cfg.bundlerUrl, {
      method: 'POST',
      headers: this._headers(cfg),
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'pm_sponsorUserOperation',
        params: [userOp, cfg.entryPoint],
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) {
      throw new Error(`pm_sponsorUserOperation failed: ${JSON.stringify(body.error || response.statusText)}`);
    }
    return { shadow: false, provider: 'thirdweb', sponsored: true, entryPoint: cfg.entryPoint, ...body.result };
  }
}

module.exports = {
  ThirdwebWalletEngine,
  DEFAULT_ACCOUNT_FACTORY_V0_6,
  DEFAULT_ACCOUNT_FACTORY_V0_7,
  ENTRY_POINT_V0_6,
  ENTRY_POINT_V0_7,
  saltHex,
};
