'use strict';

/**
 * TrustDistributionPolicy driver — the backend side of the trust's on-chain
 * distribution rules (contracts/TrustDistributionPolicy.sol).
 *
 * The contract custodies the settlement asset and holds the rules: beneficiary
 * allow-list, purpose codes, per-distribution and rolling-period ceilings,
 * maker/checker approval, timelock, expiry, escrowed release with a clawback
 * window, vesting, freeze and pause. This module never re-implements those
 * rules — it encodes calls, submits them from the thirdweb server wallet
 * (POST /v1/contracts/write), and reads state back (POST /v1/contracts/read),
 * so the chain stays the source of truth and a rejected call surfaces the
 * contract's own revert reason.
 *
 * Roles are split across keys deliberately: the server wallet is the MAKER (and
 * usually the EXECUTOR), trustee keys are the CHECKERs, and trustee governance
 * owns the contract. A compromised backend key can therefore only propose.
 *
 * Writes are gated exactly like every other live rail: with
 * TRUST_POLICY_LIVE=false (default) a call returns a shadow record describing
 * the encoded call and nothing is submitted. Reads are always allowed.
 */

const { ThirdwebServerWalletEngine } = require('./thirdwebServerWalletEngine');

let viem;
try { viem = require('viem'); } catch (e) { /* keccak refs need viem; validated at call time */ }

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function bool(name, def = false) { const v = process.env[name]; return v ? String(v).toLowerCase() === 'true' : def; }
function num(name, def = 0) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : def; }

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;

const ROLE = { maker: 0, checker: 1, executor: 2, pauser: 3, compliance: 4 };
const STATUS = ['none', 'proposed', 'approved', 'executed', 'cancelled'];

const SIG = {
  propose: 'function propose(address token, address beneficiary, uint256 amount, bytes32 purpose, bytes32 ref, uint64 expiresAt, uint32 installments, uint32 interval) returns (uint256)',
  approve: 'function approve(uint256 distributionId)',
  cancel: 'function cancel(uint256 distributionId, bytes32 reason)',
  execute: 'function execute(uint256 distributionId) returns (uint256)',
  claim: 'function claim(uint256 escrowId) returns (uint256)',
  revoke: 'function revoke(uint256 escrowId, bytes32 reason) returns (uint256)',
  reclaimExpired: 'function reclaimExpired(uint256 escrowId) returns (uint256)',
  setRole: 'function setRole(uint8 role, address account, bool allowed)',
  setPurpose: 'function setPurpose(bytes32 purpose, bool allowed)',
  setTokenLimits: 'function setTokenLimits(address token, bool allowed, uint256 maxPerDistribution, uint256 periodCap, uint32 periodSeconds)',
  setBeneficiary: 'function setBeneficiary(address beneficiary, bool allowed)',
  setBeneficiaryLimits: 'function setBeneficiaryLimits(address beneficiary, address token, uint256 maxPerDistribution, uint256 periodCap, uint32 periodSeconds)',
  setFrozen: 'function setFrozen(address account, bool value)',
  setApprovalThreshold: 'function setApprovalThreshold(uint8 threshold)',
  setReleaseDelay: 'function setReleaseDelay(uint64 seconds_)',
  setClawbackWindow: 'function setClawbackWindow(uint64 seconds_)',
  setClaimWindow: 'function setClaimWindow(uint64 seconds_)',
  pause: 'function pause()',
  unpause: 'function unpause()',
  transferOwnership: 'function transferOwnership(address newOwner)',
  owner: 'function owner() view returns (address)',
  paused: 'function paused() view returns (bool)',
  approvalThreshold: 'function approvalThreshold() view returns (uint8)',
  releaseDelay: 'function releaseDelay() view returns (uint64)',
  clawbackWindow: 'function clawbackWindow() view returns (uint64)',
  claimWindow: 'function claimWindow() view returns (uint64)',
  distributionCount: 'function distributionCount() view returns (uint256)',
  escrowCount: 'function escrowCount() view returns (uint256)',
  available: 'function available(address token) view returns (uint256)',
  reserved: 'function reserved(address token) view returns (uint256)',
  balanceOfToken: 'function balanceOfToken(address token) view returns (uint256)',
  claimable: 'function claimable(uint256 escrowId) view returns (uint256)',
  hasRole: 'function hasRole(uint8 role, address account) view returns (bool)',
  purposeAllowed: 'function purposeAllowed(bytes32 purpose) view returns (bool)',
  beneficiaryAllowed: 'function beneficiaryAllowed(address beneficiary) view returns (bool)',
  frozen: 'function frozen(address account) view returns (bool)',
  escrowOf: 'function escrowOf(uint256 distributionId) view returns (uint256)',
  remainingPeriodAllowance: 'function remainingPeriodAllowance(address token, address beneficiary) view returns (uint256, uint256)',
  distributions: 'function distributions(uint256 distributionId) view returns ((address, address, uint256, bytes32, bytes32, address, uint64, uint64, uint64, uint64, uint32, uint32, uint8, uint8))',
  escrows: 'function escrows(uint256 escrowId) view returns ((uint256, address, address, uint256, uint256, uint64, uint64, uint32, uint32, bool))',
};

// Case is not validated: callers hand us addresses from records and env, and a
// non-checksummed but otherwise valid address must not be rejected.
function isAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || ''));
}

function badRequest(message, code) {
  return Object.assign(new Error(message), { status: 400, code });
}

/** Purpose codes are stored as readable right-padded ASCII so they can be audited on chain. */
function purposeHex(purpose) {
  const text = String(purpose || '').trim();
  if (!text) throw badRequest('purpose required');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > 32) throw badRequest(`purpose "${text}" is longer than 32 bytes`);
  return `0x${Buffer.concat([bytes, Buffer.alloc(32 - bytes.length)]).toString('hex')}`;
}

function purposeFromHex(hex) {
  const clean = String(hex || '').replace(/^0x/, '');
  if (!clean || /^0+$/.test(clean)) return null;
  return Buffer.from(clean, 'hex').toString('utf8').replace(/\0+$/, '');
}

/**
 * The reference that ties an on-chain proposal to the canonical distribution
 * request. Short ids are stored readably; anything longer is hashed, so the
 * uniqueness the contract enforces still holds.
 */
function refHex(reference) {
  const text = String(reference || '').trim();
  if (!text) throw badRequest('reference required');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= 32) return `0x${Buffer.concat([bytes, Buffer.alloc(32 - bytes.length)]).toString('hex')}`;
  if (!viem || !viem.keccak256) throw new Error('viem is required to hash a reference longer than 32 bytes');
  return viem.keccak256(viem.toHex(text));
}

function toBigInt(value, label) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(text)) {
    throw badRequest(`${label} must be an integer in smallest units, got "${text}"`);
  }
  return BigInt(text);
}

/** thirdweb decodes tuples positionally; accept either shape. */
function at(value, index, key) {
  if (Array.isArray(value)) return value[index];
  if (value && typeof value === 'object') return value[key] !== undefined ? value[key] : value[String(index)];
  return undefined;
}

function toNumber(value) { return value === undefined || value === null ? null : Number(value); }
function toText(value) { return value === undefined || value === null ? null : String(value); }
function iso(seconds) {
  const n = Number(seconds || 0);
  return n > 0 ? new Date(n * 1000).toISOString() : null;
}

class TrustPolicyEngine {
  static getConfig() {
    const wallet = ThirdwebServerWalletEngine.getConfig();
    return {
      address: str('TRUST_POLICY_ADDRESS'),
      chainId: num('TRUST_POLICY_CHAIN_ID', wallet.chainId),
      live: bool('TRUST_POLICY_LIVE', false),
      // When true, wallet settlement goes through the contract instead of a direct transfer.
      enforced: bool('TRUST_POLICY_ENFORCED', false),
      settlementToken: str('THIRDWEB_SETTLEMENT_TOKEN', str('DAPP_USDC_ADDRESS')),
      defaultPurpose: str('TRUST_POLICY_DEFAULT_PURPOSE', 'distribution'),
      // Proposals expire this many seconds after they are raised; 0 keeps them open.
      proposalTtlSeconds: num('TRUST_POLICY_PROPOSAL_TTL_SECONDS', 0),
      serverWallet: wallet.address,
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.address) issues.push('TRUST_POLICY_ADDRESS not configured (contract not deployed or not wired)');
    else if (!isAddress(cfg.address)) issues.push('TRUST_POLICY_ADDRESS is not a valid address');
    if (!cfg.settlementToken) issues.push('THIRDWEB_SETTLEMENT_TOKEN not configured');
    if (cfg.enforced && !cfg.live) issues.push('TRUST_POLICY_ENFORCED=true with TRUST_POLICY_LIVE=false: proposals are recorded but never submitted');
    return {
      provider: 'trust-distribution-policy',
      contract: cfg.address || null,
      chainId: cfg.chainId,
      live: cfg.live,
      shadow: !cfg.live,
      enforced: cfg.enforced,
      settlementToken: cfg.settlementToken || null,
      defaultPurpose: cfg.defaultPurpose,
      serverWallet: cfg.serverWallet || null,
      ready: issues.length === 0,
      issues,
    };
  }

  static _contract() {
    const cfg = this.getConfig();
    if (!cfg.address || !isAddress(cfg.address)) {
      throw Object.assign(new Error('TRUST_POLICY_ADDRESS is not configured with a valid contract address'), {
        status: 409, code: 'TRUST_POLICY_NOT_CONFIGURED',
      });
    }
    return cfg;
  }

  // ─── raw calls ─────────────────────────────────────────────────────────────

  static async _read(method, params = []) {
    const cfg = this._contract();
    const [value] = await ThirdwebServerWalletEngine.readContract({
      calls: [{ contractAddress: cfg.address, method, params }],
      chainId: cfg.chainId,
    });
    return value;
  }

  /**
   * Submit one contract call from the server wallet, or describe it when
   * TRUST_POLICY_LIVE=false. `idempotencyKey` prevents a retry from
   * double-submitting the same governance action.
   */
  static async _write(action, method, params, { idempotencyKey = null } = {}) {
    const cfg = this._contract();
    const call = { contractAddress: cfg.address, method, params };
    const record = {
      provider: 'trust-distribution-policy',
      action,
      contract: cfg.address,
      chainId: cfg.chainId,
      from: cfg.serverWallet || null,
      call,
      shadow: !cfg.live,
      status: cfg.live ? 'submitted' : 'shadow',
      transactionId: null,
    };
    if (!cfg.live) {
      record.reason = 'TRUST_POLICY_LIVE=false: call encoded, nothing submitted to thirdweb';
      return record;
    }
    const result = await ThirdwebServerWalletEngine.writeContract({
      calls: [call],
      chainId: cfg.chainId,
      idempotencyKey: idempotencyKey || undefined,
    });
    record.transactionId = result.transactionIds[0] || null;
    record.from = result.from;
    return record;
  }

  // ─── deployment and configuration ──────────────────────────────────────────

  /**
   * Deploy the policy contract from the server wallet. `owner` is trustee
   * governance (a multisig, not the server wallet) and holds every setter.
   */
  static async deploy({ owner, approvalThreshold = 2, releaseDelaySeconds = 86400, clawbackWindowSeconds = 86400, abi, bytecode, chainId, salt } = {}) {
    if (!isAddress(owner)) throw badRequest('owner must be a valid address');
    const threshold = Number(approvalThreshold);
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 10) throw badRequest('approvalThreshold must be 1-10');
    const cfg = this.getConfig();
    if (!cfg.live) {
      return {
        shadow: true,
        status: 'shadow',
        reason: 'TRUST_POLICY_LIVE=false: deployment parameters validated, nothing submitted',
        constructorParams: { owner_: owner, approvalThreshold_: threshold, releaseDelay_: String(releaseDelaySeconds), clawbackWindow_: String(clawbackWindowSeconds) },
        chainId: Number(chainId || cfg.chainId),
      };
    }
    const deployed = await ThirdwebServerWalletEngine.deployContract({
      abi,
      bytecode,
      constructorParams: {
        owner_: owner,
        approvalThreshold_: threshold,
        releaseDelay_: String(releaseDelaySeconds),
        clawbackWindow_: String(clawbackWindowSeconds),
      },
      chainId: Number(chainId || cfg.chainId),
      salt,
    });
    return { ...deployed, shadow: false, status: 'submitted' };
  }

  static _role(role) {
    const key = String(role || '').toLowerCase();
    if (!(key in ROLE)) throw badRequest(`role must be one of ${Object.keys(ROLE).join(', ')}`);
    return ROLE[key];
  }

  static async setRole({ role, account, allowed = true } = {}) {
    if (!isAddress(account)) throw badRequest('account must be a valid address');
    return this._write('setRole', SIG.setRole, [this._role(role), account, Boolean(allowed)]);
  }

  static async setPurpose({ purpose, allowed = true } = {}) {
    return this._write('setPurpose', SIG.setPurpose, [purposeHex(purpose), Boolean(allowed)]);
  }

  static async setTokenLimits({ token, allowed = true, maxPerDistribution = '0', periodCap = '0', periodSeconds = 0 } = {}) {
    const address = token === null || token === undefined || token === '' ? ZERO_ADDRESS : token;
    if (!isAddress(address)) throw badRequest('token must be a valid address (or null for the native asset)');
    return this._write('setTokenLimits', SIG.setTokenLimits, [
      address,
      Boolean(allowed),
      toBigInt(maxPerDistribution, 'maxPerDistribution').toString(),
      toBigInt(periodCap, 'periodCap').toString(),
      Number(periodSeconds) || 0,
    ]);
  }

  static async setBeneficiary({ beneficiary, allowed = true } = {}) {
    if (!isAddress(beneficiary)) throw badRequest('beneficiary must be a valid address');
    return this._write('setBeneficiary', SIG.setBeneficiary, [beneficiary, Boolean(allowed)]);
  }

  static async setBeneficiaryLimits({ beneficiary, token, maxPerDistribution = '0', periodCap = '0', periodSeconds = 0 } = {}) {
    if (!isAddress(beneficiary)) throw badRequest('beneficiary must be a valid address');
    const cfg = this.getConfig();
    const asset = token === null || token === undefined || token === '' ? cfg.settlementToken : token;
    if (!isAddress(asset)) throw badRequest('token must be a valid address');
    return this._write('setBeneficiaryLimits', SIG.setBeneficiaryLimits, [
      beneficiary,
      asset,
      toBigInt(maxPerDistribution, 'maxPerDistribution').toString(),
      toBigInt(periodCap, 'periodCap').toString(),
      Number(periodSeconds) || 0,
    ]);
  }

  static async setFrozen({ account, frozen = true } = {}) {
    if (!isAddress(account)) throw badRequest('account must be a valid address');
    return this._write('setFrozen', SIG.setFrozen, [account, Boolean(frozen)]);
  }

  static async setGovernance({ approvalThreshold, releaseDelaySeconds, clawbackWindowSeconds, claimWindowSeconds } = {}) {
    const results = [];
    if (approvalThreshold !== undefined) {
      const t = Number(approvalThreshold);
      if (!Number.isInteger(t) || t < 1 || t > 10) throw badRequest('approvalThreshold must be 1-10');
      results.push(await this._write('setApprovalThreshold', SIG.setApprovalThreshold, [t]));
    }
    if (releaseDelaySeconds !== undefined) results.push(await this._write('setReleaseDelay', SIG.setReleaseDelay, [String(Number(releaseDelaySeconds) || 0)]));
    if (clawbackWindowSeconds !== undefined) results.push(await this._write('setClawbackWindow', SIG.setClawbackWindow, [String(Number(clawbackWindowSeconds) || 0)]));
    if (claimWindowSeconds !== undefined) results.push(await this._write('setClaimWindow', SIG.setClaimWindow, [String(Number(claimWindowSeconds) || 0)]));
    if (!results.length) throw badRequest('nothing to change');
    return results;
  }

  static async pause() { return this._write('pause', SIG.pause, []); }
  static async unpause() { return this._write('unpause', SIG.unpause, []); }

  /**
   * Hand governance to trustee governance. Deploying with the server wallet as
   * owner, configuring, then transferring is the only way the app can bootstrap
   * roles and limits: every setter is onlyOwner and the app cannot sign for a
   * trustee's wallet. After this call the server wallet can only propose/execute.
   */
  static async transferOwnership({ newOwner } = {}) {
    if (!isAddress(newOwner)) throw badRequest('newOwner must be a valid address');
    if (/^0x0{40}$/.test(newOwner)) throw badRequest('newOwner must not be the zero address');
    return this._write('transferOwnership', SIG.transferOwnership, [newOwner]);
  }

  // ─── distribution lifecycle ────────────────────────────────────────────────

  /**
   * Raise an on-chain distribution proposal. Nothing is reserved or moved: the
   * contract still requires the checker threshold, the timelock and the
   * ceilings before any value can be released.
   */
  static async propose({
    beneficiary, quantity, tokenAddress, purpose, reference,
    expiresAt, installments = 1, intervalSeconds = 0,
  } = {}) {
    const cfg = this._contract();
    if (!isAddress(beneficiary)) throw badRequest('beneficiary must be a valid address');
    const token = tokenAddress === null || tokenAddress === undefined || tokenAddress === ''
      ? cfg.settlementToken
      : tokenAddress;
    if (!isAddress(token)) throw badRequest('tokenAddress must be a valid address, and THIRDWEB_SETTLEMENT_TOKEN is unset');
    const amount = toBigInt(quantity, 'quantity');
    if (amount <= 0n) throw badRequest('quantity must be positive');
    const tranches = Number(installments) || 1;
    if (!Number.isInteger(tranches) || tranches < 1) throw badRequest('installments must be a positive integer');
    const interval = Number(intervalSeconds) || 0;
    if (tranches > 1 && interval <= 0) throw badRequest('intervalSeconds is required for an installment schedule');
    const expiry = expiresAt !== undefined && expiresAt !== null && expiresAt !== ''
      ? Math.floor(new Date(expiresAt).getTime() / 1000)
      : (cfg.proposalTtlSeconds > 0 ? Math.floor(Date.now() / 1000) + cfg.proposalTtlSeconds : 0);
    if (!Number.isFinite(expiry)) throw badRequest('expiresAt is not a valid date');

    const record = await this._write('propose', SIG.propose, [
      token,
      beneficiary,
      amount.toString(),
      purposeHex(purpose || cfg.defaultPurpose),
      refHex(reference),
      String(expiry),
      tranches,
      interval,
    ], { idempotencyKey: `tdp-propose-${refHex(reference)}` });

    return {
      ...record,
      token,
      beneficiary,
      quantity: amount.toString(),
      purpose: purpose || cfg.defaultPurpose,
      reference,
      ref: refHex(reference),
      expiresAt: expiry > 0 ? iso(expiry) : null,
      installments: tranches,
      intervalSeconds: interval,
    };
  }

  /** Checker approval. The contract refuses the proposer and repeat approvals. */
  static async approve({ distributionId } = {}) {
    const id = toBigInt(distributionId, 'distributionId');
    return this._write('approve', SIG.approve, [id.toString()], { idempotencyKey: `tdp-approve-${id}` });
  }

  static async cancel({ distributionId, reason = 'cancelled' } = {}) {
    const id = toBigInt(distributionId, 'distributionId');
    return this._write('cancel', SIG.cancel, [id.toString(), purposeHex(reason)], { idempotencyKey: `tdp-cancel-${id}` });
  }

  /** Commit an approved distribution once its timelock has run: reserves it into an escrow. */
  static async execute({ distributionId } = {}) {
    const id = toBigInt(distributionId, 'distributionId');
    return this._write('execute', SIG.execute, [id.toString()], { idempotencyKey: `tdp-execute-${id}` });
  }

  /** Pay the beneficiary everything vested and unclaimed on an escrow. */
  static async claim({ escrowId } = {}) {
    const id = toBigInt(escrowId, 'escrowId');
    return this._write('claim', SIG.claim, [id.toString()], { idempotencyKey: `tdp-claim-${id}-${Date.now()}` });
  }

  /** Clawback: return an escrow's unclaimed remainder to the trust. */
  static async revoke({ escrowId, reason = 'revoked' } = {}) {
    const id = toBigInt(escrowId, 'escrowId');
    return this._write('revoke', SIG.revoke, [id.toString(), purposeHex(reason)], { idempotencyKey: `tdp-revoke-${id}` });
  }

  static async reclaimExpired({ escrowId } = {}) {
    const id = toBigInt(escrowId, 'escrowId');
    return this._write('reclaimExpired', SIG.reclaimExpired, [id.toString()], { idempotencyKey: `tdp-reclaim-${id}` });
  }

  // ─── state ─────────────────────────────────────────────────────────────────

  /** Governance parameters and treasury position as the contract reports them. */
  static async status({ token } = {}) {
    const cfg = this._contract();
    const asset = token || cfg.settlementToken || ZERO_ADDRESS;
    const calls = [
      { contractAddress: cfg.address, method: SIG.owner, params: [] },
      { contractAddress: cfg.address, method: SIG.paused, params: [] },
      { contractAddress: cfg.address, method: SIG.approvalThreshold, params: [] },
      { contractAddress: cfg.address, method: SIG.releaseDelay, params: [] },
      { contractAddress: cfg.address, method: SIG.clawbackWindow, params: [] },
      { contractAddress: cfg.address, method: SIG.claimWindow, params: [] },
      { contractAddress: cfg.address, method: SIG.distributionCount, params: [] },
      { contractAddress: cfg.address, method: SIG.escrowCount, params: [] },
      { contractAddress: cfg.address, method: SIG.balanceOfToken, params: [asset] },
      { contractAddress: cfg.address, method: SIG.reserved, params: [asset] },
      { contractAddress: cfg.address, method: SIG.available, params: [asset] },
    ];
    const [owner, paused, threshold, delay, clawback, claimWindow, distributions, escrows, balance, reserved, available] =
      await ThirdwebServerWalletEngine.readContract({ calls, chainId: cfg.chainId });
    return {
      contract: cfg.address,
      chainId: cfg.chainId,
      owner: toText(owner),
      paused: Boolean(paused),
      approvalThreshold: toNumber(threshold),
      releaseDelaySeconds: toNumber(delay),
      clawbackWindowSeconds: toNumber(clawback),
      claimWindowSeconds: toNumber(claimWindow),
      distributionCount: toText(distributions),
      escrowCount: toText(escrows),
      treasury: {
        token: asset,
        balance: toText(balance),
        reserved: toText(reserved),
        available: toText(available),
      },
      live: cfg.live,
      enforced: cfg.enforced,
    };
  }

  static _mapDistribution(id, tuple, escrowId) {
    const expiresAt = at(tuple, 9, 'expiresAt');
    return {
      distributionId: String(id),
      token: toText(at(tuple, 0, 'token')),
      beneficiary: toText(at(tuple, 1, 'beneficiary')),
      quantity: toText(at(tuple, 2, 'amount')),
      purpose: purposeFromHex(at(tuple, 3, 'purpose')),
      ref: toText(at(tuple, 4, 'ref')),
      proposer: toText(at(tuple, 5, 'proposer')),
      proposedAt: iso(at(tuple, 6, 'proposedAt')),
      approvedAt: iso(at(tuple, 7, 'approvedAt')),
      releasableAt: iso(at(tuple, 8, 'eta')),
      expiresAt: iso(expiresAt),
      installments: toNumber(at(tuple, 10, 'installments')),
      intervalSeconds: toNumber(at(tuple, 11, 'interval')),
      approvals: toNumber(at(tuple, 12, 'approvals')),
      status: STATUS[Number(at(tuple, 13, 'status')) || 0] || 'unknown',
      escrowId: escrowId && String(escrowId) !== '0' ? String(escrowId) : null,
    };
  }

  static async distribution(distributionId) {
    const cfg = this._contract();
    const id = toBigInt(distributionId, 'distributionId').toString();
    const [tuple, escrowId] = await ThirdwebServerWalletEngine.readContract({
      calls: [
        { contractAddress: cfg.address, method: SIG.distributions, params: [id] },
        { contractAddress: cfg.address, method: SIG.escrowOf, params: [id] },
      ],
      chainId: cfg.chainId,
    });
    const mapped = this._mapDistribution(id, tuple, escrowId);
    if (mapped.status === 'none') return null;
    return mapped;
  }

  /** Most recent proposals, newest first — the on-chain distribution queue. */
  static async distributions({ limit = 25 } = {}) {
    const cfg = this._contract();
    const n = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const count = BigInt(await this._read(SIG.distributionCount, []));
    if (count === 0n) return [];
    const ids = [];
    for (let i = 0n; i < BigInt(n) && count - i > 0n; i += 1n) ids.push((count - i).toString());
    const calls = ids.flatMap((id) => ([
      { contractAddress: cfg.address, method: SIG.distributions, params: [id] },
      { contractAddress: cfg.address, method: SIG.escrowOf, params: [id] },
    ]));
    const results = await ThirdwebServerWalletEngine.readContract({ calls, chainId: cfg.chainId });
    return ids.map((id, index) => this._mapDistribution(id, results[index * 2], results[index * 2 + 1]));
  }

  /**
   * Find the proposal raised for a canonical record. The contract keys replay
   * protection on the reference, so at most one proposal can carry it; the
   * scan walks back from the newest proposal since `propose` returns its id
   * on chain rather than to the caller.
   */
  static async findByReference(reference, { limit = 100 } = {}) {
    const wanted = refHex(reference).toLowerCase();
    const recent = await this.distributions({ limit });
    return recent.find((d) => String(d.ref || '').toLowerCase() === wanted) || null;
  }

  static async escrow(escrowId) {
    const cfg = this._contract();
    const id = toBigInt(escrowId, 'escrowId').toString();
    const [tuple, claimable] = await ThirdwebServerWalletEngine.readContract({
      calls: [
        { contractAddress: cfg.address, method: SIG.escrows, params: [id] },
        { contractAddress: cfg.address, method: SIG.claimable, params: [id] },
      ],
      chainId: cfg.chainId,
    });
    const amount = toText(at(tuple, 3, 'amount'));
    if (!amount || amount === '0') return null;
    return {
      escrowId: id,
      distributionId: toText(at(tuple, 0, 'distributionId')),
      token: toText(at(tuple, 1, 'token')),
      beneficiary: toText(at(tuple, 2, 'beneficiary')),
      quantity: amount,
      claimed: toText(at(tuple, 4, 'claimed')),
      claimableAt: iso(at(tuple, 5, 'claimableAt')),
      expiresAt: iso(at(tuple, 6, 'expiresAt')),
      installments: toNumber(at(tuple, 7, 'installments')),
      intervalSeconds: toNumber(at(tuple, 8, 'interval')),
      revoked: Boolean(at(tuple, 9, 'revoked')),
      claimableNow: toText(claimable),
    };
  }

  static async owner() {
    return toText(await this._read(SIG.owner, []));
  }

  /**
   * Encode `onlyOwner` setters as unsigned transactions for the contract owner
   * (trustee governance) to sign in its own wallet. The server wallet does not
   * own the contract after hand-off, so it cannot submit these itself.
   */
  static async prepareOwnerCalls(calls) {
    const cfg = this._contract();
    if (!viem || !viem.encodeFunctionData || !viem.parseAbi) throw new Error('viem is required to encode owner calls');
    const owner = await this.owner();
    const txs = calls.map(({ action, method, params }) => ({
      action,
      from: owner,
      to: cfg.address,
      chainId: cfg.chainId,
      value: '0x0',
      data: viem.encodeFunctionData({ abi: viem.parseAbi([method]), args: params }),
      call: { contractAddress: cfg.address, method, params: params.map((p) => (typeof p === 'bigint' ? p.toString() : p)) },
    }));
    return { owner, contract: cfg.address, chainId: cfg.chainId, serverWalletIsOwner: !!cfg.serverWallet && cfg.serverWallet.toLowerCase() === String(owner).toLowerCase(), txs };
  }

  /** Unsigned owner transactions that allow-list a beneficiary and set its per-token ceilings. */
  static async prepareBeneficiaryAllowlist({ beneficiary, token, maxPerDistribution = '0', periodCap = '0', periodSeconds = 0 } = {}) {
    if (!isAddress(beneficiary)) throw badRequest('beneficiary must be a valid address');
    const cfg = this.getConfig();
    const asset = token === null || token === undefined || token === '' ? cfg.settlementToken : token;
    if (!isAddress(asset)) throw badRequest('token must be a valid address');
    return this.prepareOwnerCalls([
      { action: 'setBeneficiary', method: SIG.setBeneficiary, params: [beneficiary, true] },
      {
        action: 'setBeneficiaryLimits',
        method: SIG.setBeneficiaryLimits,
        params: [beneficiary, asset, toBigInt(maxPerDistribution, 'maxPerDistribution'), toBigInt(periodCap, 'periodCap'), Number(periodSeconds) || 0],
      },
    ]);
  }

  /** Whether a beneficiary/token pair could be paid right now, and its remaining headroom. */
  static async beneficiaryStatus({ beneficiary, token } = {}) {
    const cfg = this._contract();
    if (!isAddress(beneficiary)) throw badRequest('beneficiary must be a valid address');
    const asset = token || cfg.settlementToken || ZERO_ADDRESS;
    const [allowed, isFrozen, remaining] = await ThirdwebServerWalletEngine.readContract({
      calls: [
        { contractAddress: cfg.address, method: SIG.beneficiaryAllowed, params: [beneficiary] },
        { contractAddress: cfg.address, method: SIG.frozen, params: [beneficiary] },
        { contractAddress: cfg.address, method: SIG.remainingPeriodAllowance, params: [asset, beneficiary] },
      ],
      chainId: cfg.chainId,
    });
    return {
      beneficiary,
      token: asset,
      allowed: Boolean(allowed),
      frozen: Boolean(isFrozen),
      remainingPeriodAllowance: {
        beneficiary: toText(at(remaining, 0, '0')),
        token: toText(at(remaining, 1, '1')),
      },
    };
  }
}

module.exports = {
  TrustPolicyEngine,
  ROLE,
  STATUS,
  SIG,
  purposeHex,
  purposeFromHex,
  refHex,
  ZERO_ADDRESS,
  ZERO_BYTES32,
};
