'use strict';

/**
 * PayoutRelayerEngine — repeated signing for the Spritz payout leg without a
 * human wallet in the loop for every payout.
 *
 * The payout wallet becomes an ERC-4337 smart account (thirdweb Account /
 * AccountPermissions) whose admin is the trustee governance wallet. The trustee
 * signs ONE EIP-712 `SignerPermissionRequest` granting the server relayer key a
 * scoped session key:
 *
 *   approvedTargets           = [settlement USDC, Spritz settlement contract]
 *   nativeTokenLimitPerTx     = 0
 *   permissionStart/End       = bounded window (SPRITZ_RELAYER_SESSION_SECONDS)
 *
 * From then on `relayPayout()` builds a UserOperation from the smart account
 * (`executeBatch([usdc.approve, spritz.pay])`), signs it with the session key,
 * asks thirdweb to sponsor gas, and submits it to the bundler. The session key
 * can never touch the policy contract, move native ETH, or call any other
 * target: the contract enforces the scope, not this code.
 *
 * Governance stays where it is: distributions are still proposed / approved /
 * released through TrustDistributionPolicy, and only the trustee can grant or
 * revoke the session key. The relayer only signs the last mile.
 *
 * Nothing is broadcast unless SPRITZ_PAYOUT_RELAYER=session_key AND a relayer
 * key is configured; otherwise every method is read-only / prepares payloads.
 */

const crypto = require('crypto');
const { getConfig: getBaseConfig } = require('./config');

let viem, accounts, aa;
try {
  viem = require('viem');
  accounts = require('viem/accounts');
  aa = require('viem/account-abstraction');
} catch (e) { viem = null; accounts = null; aa = null; }
let viemChains;
try { viemChains = require('viem/chains'); } catch (e) { viemChains = null; }

const { ThirdwebWalletEngine, ENTRY_POINT_V0_6, saltHex } = require('./thirdwebWalletEngine');
const { TrustPolicyEngine } = require('./trustPolicyEngine');

// thirdweb AccountFactory (contracts/prebuilts/account/non-upgradeable/AccountFactory.sol).
const FACTORY_ABI = viem && viem.parseAbi ? viem.parseAbi([
  'function getAddress(address admin, bytes data) view returns (address)',
  'function createAccount(address admin, bytes data) returns (address)',
  'function entrypoint() view returns (address)',
]) : [];

// thirdweb Account (AccountCore + AccountPermissions) — verified against
// thirdweb-dev/contracts `contracts/extension/upgradeable/AccountPermissions.sol`
// and `contracts/prebuilts/account/utils/AccountCore.sol`.
const ACCOUNT_ABI = viem && viem.parseAbi ? viem.parseAbi([
  'struct SignerPermissions { address signer; address[] approvedTargets; uint256 nativeTokenLimitPerTransaction; uint128 startTimestamp; uint128 endTimestamp; }',
  'struct SignerPermissionRequest { address signer; uint8 isAdmin; address[] approvedTargets; uint256 nativeTokenLimitPerTransaction; uint128 permissionStartTimestamp; uint128 permissionEndTimestamp; uint128 reqValidityStartTimestamp; uint128 reqValidityEndTimestamp; bytes32 uid; }',
  'function isAdmin(address signer) view returns (bool)',
  'function isActiveSigner(address signer) view returns (bool)',
  'function getPermissionsForSigner(address signer) view returns (SignerPermissions)',
  'function getAllAdmins() view returns (address[])',
  'function setPermissionsForSigner(SignerPermissionRequest req, bytes signature)',
  'function execute(address target, uint256 value, bytes calldata data)',
  'function executeBatch(address[] target, uint256[] value, bytes[] calldata data)',
  'function getNonce() view returns (uint256)',
]) : [];

const ENTRY_POINT_ABI = viem && viem.parseAbi ? viem.parseAbi([
  'function getNonce(address sender, uint192 key) view returns (uint256)',
]) : [];

const PERMISSION_TYPES = {
  SignerPermissionRequest: [
    { name: 'signer', type: 'address' },
    { name: 'isAdmin', type: 'uint8' },
    { name: 'approvedTargets', type: 'address[]' },
    { name: 'nativeTokenLimitPerTransaction', type: 'uint256' },
    { name: 'permissionStartTimestamp', type: 'uint128' },
    { name: 'permissionEndTimestamp', type: 'uint128' },
    { name: 'reqValidityStartTimestamp', type: 'uint128' },
    { name: 'reqValidityEndTimestamp', type: 'uint128' },
    { name: 'uid', type: 'bytes32' },
  ],
};

// Same default as SpritzTreasuryLegEngine (the Coinbase payout wallet).
const DEFAULT_PAYOUT_WALLET = '0xA0f8C3d9e4fE7F531968b11f1Ce298F56483040F';
const DEFAULT_SESSION_SECONDS = 30 * 24 * 3600;
// Salt of the relayer-admin'd helper account used to pay for deployments via
// sponsored UserOperations when the relayer EOA holds no native gas.
const DEPLOYER_SALT = 'dlbtrust-payout-deployer';
const REQ_VALIDITY_SECONDS = 3600;

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function num(name, def) { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : def; }
function same(a, b) { return Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase(); }
function badRequest(message, code = 'BAD_REQUEST') { return Object.assign(new Error(message), { status: 400, code }); }
function conflict(message, code) { return Object.assign(new Error(message), { status: 409, code }); }
function isAddress(a) { return Boolean(viem && viem.isAddress && a && viem.isAddress(a, { strict: false })); }
function jsonSafe(v) { return JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x))); }

function viemChain(chainId) {
  if (!viemChains) return undefined;
  return Object.values(viemChains).find((c) => c && typeof c === 'object' && c.id === Number(chainId));
}

class PayoutRelayerEngine {
  static config() {
    const base = getBaseConfig();
    const tw = ThirdwebWalletEngine.getConfig();
    const relayerKey = str('SPRITZ_RELAYER_PRIVATE_KEY') || base.privateKey || '';
    let relayer = str('SPRITZ_RELAYER_ADDRESS');
    if (!relayer && relayerKey && accounts) {
      try { relayer = accounts.privateKeyToAccount(relayerKey).address; } catch (e) { relayer = ''; }
    }
    if (!relayer) relayer = base.operatorAddress || '';
    return {
      mode: str('SPRITZ_PAYOUT_RELAYER', 'off').toLowerCase(), // off | session_key
      chainId: base.chainId,
      rpcUrl: tw.rpcUrl || base.rpcUrl,
      smartAccount: str('SPRITZ_PAYOUT_WALLET', DEFAULT_PAYOUT_WALLET),
      relayer,
      relayerKey,
      settlementToken: str('THIRDWEB_SETTLEMENT_TOKEN') || base.usdcAddress || '',
      sessionSeconds: num('SPRITZ_RELAYER_SESSION_SECONDS', DEFAULT_SESSION_SECONDS),
      extraTargets: str('SPRITZ_RELAYER_APPROVED_TARGETS').split(',').map((s) => s.trim()).filter(Boolean),
      entryPoint: tw.entryPoint || ENTRY_POINT_V0_6,
      bundlerUrl: tw.bundlerUrl,
      thirdweb: tw,
    };
  }

  static get enabled() { return this.config().mode === 'session_key'; }

  static _publicClient(cfg) {
    if (!viem) throw conflict('viem is required for the payout relayer', 'RELAYER_UNAVAILABLE');
    if (!cfg.rpcUrl) throw conflict('no RPC URL configured (DAPP_RPC_URL / THIRDWEB_RPC_URL)', 'RELAYER_RPC_MISSING');
    return viem.createPublicClient({ chain: viemChain(cfg.chainId), transport: viem.http(cfg.rpcUrl) });
  }

  static _read(client, cfg, functionName, args = []) {
    return client.readContract({ address: cfg.smartAccount, abi: ACCOUNT_ABI, functionName, args });
  }

  /** Targets the session key may call: settlement token + Spritz settlement contract(s). */
  static approvedTargets(cfg = this.config(), spritzContracts = []) {
    const set = new Map();
    for (const t of [cfg.settlementToken, ...cfg.extraTargets, ...spritzContracts]) {
      if (isAddress(t)) set.set(t.toLowerCase(), viem.getAddress(t));
    }
    return [...set.values()];
  }

  /** Policy-contract owner (trustee) — the only sensible default admin for the payout account. */
  static async _trusteeAdmin() {
    try {
      const st = await TrustPolicyEngine.status();
      return st && isAddress(st.owner) ? viem.getAddress(st.owner) : '';
    } catch (e) { return ''; }
  }

  /**
   * Counterfactual thirdweb Account for the payout leg, with the trustee as
   * sole admin. Read-only: returns the predicted address, whether it is
   * already deployed, and the unsigned factory.createAccount tx any funded
   * wallet may broadcast (the factory is permissionless; only `admin`
   * controls the resulting account). Nothing is signed or sent here.
   */
  static async prepareSmartAccount({ admin, salt } = {}) {
    const cfg = this.config();
    const trustee = admin || await this._trusteeAdmin();
    if (!isAddress(trustee)) throw badRequest('admin (trustee wallet) address required; policy owner could not be read', 'RELAYER_ADMIN_REQUIRED');
    const adminAddr = viem.getAddress(trustee);
    if (same(adminAddr, cfg.relayer)) throw conflict('the relayer key must not be the account admin; admin is the trustee wallet', 'RELAYER_ADMIN_IS_RELAYER');
    const factory = cfg.thirdweb.factory;
    if (!isAddress(factory)) throw conflict('THIRDWEB_ACCOUNT_FACTORY is not a valid address', 'RELAYER_FACTORY_INVALID');
    const data = saltHex(salt !== undefined ? salt : cfg.thirdweb.accountSalt);
    const client = this._publicClient(cfg);

    const factoryCode = await client.getBytecode({ address: factory }).catch(() => null);
    if (!factoryCode || factoryCode === '0x') throw conflict(`no AccountFactory deployed at ${factory} on chain ${cfg.chainId}`, 'RELAYER_FACTORY_MISSING');
    const [predicted, factoryEntryPoint] = await Promise.all([
      client.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'getAddress', args: [adminAddr, data] }),
      client.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'entrypoint' }).catch(() => null),
    ]);
    const address = viem.getAddress(predicted);
    const code = await client.getBytecode({ address }).catch(() => null);
    const deployed = Boolean(code && code !== '0x');
    const issues = [];
    if (factoryEntryPoint && !same(factoryEntryPoint, cfg.entryPoint)) {
      issues.push(`factory entrypoint ${factoryEntryPoint} differs from configured THIRDWEB_ENTRY_POINT ${cfg.entryPoint}`);
    }
    if (!same(address, cfg.smartAccount)) issues.push(`SPRITZ_PAYOUT_WALLET is ${cfg.smartAccount}; set it to ${address} once deployed`);
    const deployer = deployed || !isAddress(cfg.relayer) ? null : await this.deployerAccount(cfg).catch(() => null);

    return jsonSafe({
      action: deployed ? 'smartAccountDeployed' : 'deploySmartAccount',
      chainId: cfg.chainId,
      factory: viem.getAddress(factory),
      entryPoint: cfg.entryPoint,
      admin: adminAddr,
      salt: data,
      address,
      deployed,
      configured: same(address, cfg.smartAccount),
      issues,
      deployer,
      unsignedTx: deployed ? null : {
        to: viem.getAddress(factory),
        value: '0',
        chainId: cfg.chainId,
        data: viem.encodeFunctionData({ abi: FACTORY_ABI, functionName: 'createAccount', args: [adminAddr, data] }),
        description: `AccountFactory.createAccount(${adminAddr}, ${data}) → ${address}`,
      },
      next: [
        deployed ? `account ${address} is deployed` : `broadcast unsignedTx from any funded wallet (or POST /api/finops/spritz/relayer/account/deploy { confirm: true } to send it from the server wallet${deployer ? `, gas-sponsored via helper account ${deployer.address} when the wallet holds no ETH` : ''})`,
        `set SPRITZ_PAYOUT_WALLET=${address} and restart`,
        `trustee owner allow-lists ${address} on TrustDistributionPolicy (POST /api/finops/spritz/wallet/allowlist/prepare { address })`,
        `trustee admin signs the session-key grant for relayer ${cfg.relayer || '(unset)'} (POST /api/finops/spritz/relayer/session-key/prepare)`,
      ],
    });
  }

  /**
   * Broadcast factory.createAccount from the server/relayer key. Requires an
   * explicit `confirm: true`; the sender only pays gas and gains no control
   * over the account (admin is the trustee).
   *
   * `via`: 'eoa' sends a plain tx from the relayer EOA; 'sponsored' routes
   * the same createAccount call through a relayer-admin'd helper thirdweb
   * Account as a gas-sponsored UserOperation (no native balance needed);
   * 'auto' (default) picks 'eoa' when the relayer holds gas, else 'sponsored'.
   */
  static async deploySmartAccount({ admin, salt, confirm = false, via = 'auto' } = {}) {
    if (confirm !== true) throw badRequest('confirm: true is required to broadcast the deployment', 'RELAYER_CONFIRM_REQUIRED');
    const cfg = this.config();
    if (!cfg.relayerKey) throw conflict('no server signing key (SPRITZ_RELAYER_PRIVATE_KEY / DAPP_PRIVATE_KEY) to pay deployment gas', 'RELAYER_NO_KEY');
    const prepared = await this.prepareSmartAccount({ admin, salt });
    if (prepared.deployed) return { ...prepared, txHash: null, broadcast: false };
    const client = this._publicClient(cfg);
    const account = accounts.privateKeyToAccount(cfg.relayerKey);
    let route = String(via || 'auto').toLowerCase();
    if (!['auto', 'eoa', 'sponsored'].includes(route)) throw badRequest(`via must be auto|eoa|sponsored, got ${via}`);
    if (route === 'auto') {
      const balance = await client.getBalance({ address: account.address }).catch(() => 0n);
      route = balance > 0n ? 'eoa' : 'sponsored';
    }
    if (route === 'sponsored') return this._deploySponsored({ cfg, client, prepared, account });
    const wallet = viem.createWalletClient({ account, chain: viemChain(cfg.chainId), transport: viem.http(cfg.rpcUrl) });
    const txHash = await wallet.sendTransaction({ to: prepared.unsignedTx.to, data: prepared.unsignedTx.data, value: 0n });
    const receipt = await client.waitForTransactionReceipt({ hash: txHash });
    const code = await client.getBytecode({ address: prepared.address }).catch(() => null);
    const deployed = Boolean(code && code !== '0x');
    if (!deployed) {
      throw conflict(`createAccount tx ${txHash} ${receipt.status === 'success' ? 'mined but' : 'reverted;'} no code at ${prepared.address}`, 'RELAYER_ACCOUNT_DEPLOY_FAILED');
    }
    return jsonSafe({
      ...prepared,
      action: 'smartAccountDeployed',
      deployed,
      unsignedTx: null,
      broadcast: true,
      txHash,
      status: receipt.status,
      payer: account.address,
      via: 'eoa',
    });
  }

  /** Helper thirdweb Account admin'd by the relayer key; only ever used to pay for deployments. */
  static async deployerAccount(cfg = this.config()) {
    if (!isAddress(cfg.relayer)) throw conflict('relayer address unknown', 'RELAYER_NO_KEY');
    const client = this._publicClient(cfg);
    const factory = viem.getAddress(cfg.thirdweb.factory);
    const relayer = viem.getAddress(cfg.relayer);
    const data = saltHex(DEPLOYER_SALT);
    const address = viem.getAddress(await client.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'getAddress', args: [relayer, data] }));
    const code = await client.getBytecode({ address }).catch(() => null);
    return { address, admin: relayer, factory, salt: data, deployed: Boolean(code && code !== '0x') };
  }

  /**
   * factory.createAccount(trustee) executed by the relayer's helper account as
   * ONE sponsored UserOperation (helper initCode included when it is not yet
   * deployed). The relayer key signs only as admin of the helper; the payout
   * account's admin is still the trustee.
   */
  static async _deploySponsored({ cfg, client, prepared, account }) {
    if (!aa) throw conflict('viem/account-abstraction is required', 'RELAYER_UNAVAILABLE');
    if (!ThirdwebWalletEngine.readiness().canSponsorGas) {
      throw conflict(`relayer ${account.address} has no native balance on chain ${cfg.chainId} and thirdweb gas sponsorship is not live; fund it or set THIRDWEB_GAS_SPONSORSHIP_LIVE=true with THIRDWEB_SECRET_KEY`, 'RELAYER_NO_GAS');
    }
    const deployer = await this.deployerAccount(cfg);
    const sender = deployer.address;
    const nonce = await client.readContract({ address: cfg.entryPoint, abi: ENTRY_POINT_ABI, functionName: 'getNonce', args: [sender, 0n] });
    const initCode = deployer.deployed
      ? '0x'
      : viem.concatHex([deployer.factory, viem.encodeFunctionData({ abi: FACTORY_ABI, functionName: 'createAccount', args: [deployer.admin, deployer.salt] })]);
    const callData = viem.encodeFunctionData({
      abi: ACCOUNT_ABI,
      functionName: 'execute',
      args: [viem.getAddress(prepared.unsignedTx.to), 0n, prepared.unsignedTx.data],
    });
    const fees = await client.estimateFeesPerGas().catch(() => ({ maxFeePerGas: 100000000n, maxPriorityFeePerGas: 1000000n }));
    const userOp = {
      sender,
      nonce,
      initCode,
      callData,
      callGasLimit: 600000n,
      verificationGasLimit: deployer.deployed ? 300000n : 900000n,
      preVerificationGas: 80000n,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      paymasterAndData: '0x',
      signature: '0x' + 'ff'.repeat(65),
    };
    const rpcOp = () => aa.formatUserOperationRequest(userOp);
    const bundler = aa.createBundlerClient({ chain: viemChain(cfg.chainId), client, transport: viem.http(cfg.bundlerUrl, { timeout: 60000 }) });
    const est = await bundler.request({ method: 'eth_estimateUserOperationGas', params: [rpcOp(), cfg.entryPoint] }).catch(() => null);
    if (est) {
      userOp.callGasLimit = BigInt(est.callGasLimit);
      userOp.verificationGasLimit = BigInt(est.verificationGasLimit);
      userOp.preVerificationGas = BigInt(est.preVerificationGas);
    }
    const sponsorship = await ThirdwebWalletEngine.sponsorUserOperation(rpcOp());
    if (!sponsorship || !sponsorship.paymasterAndData) {
      throw conflict(`thirdweb declined to sponsor the deployment from ${sender}: ${(sponsorship && sponsorship.reason) || 'no paymasterAndData'}. Add ${sender} to THIRDWEB_POLICY_ALLOWED_SENDERS or fund relayer ${account.address}.`, 'RELAYER_SPONSORSHIP_DENIED');
    }
    userOp.paymasterAndData = sponsorship.paymasterAndData;
    if (sponsorship.callGasLimit) userOp.callGasLimit = BigInt(sponsorship.callGasLimit);
    if (sponsorship.verificationGasLimit) userOp.verificationGasLimit = BigInt(sponsorship.verificationGasLimit);
    if (sponsorship.preVerificationGas) userOp.preVerificationGas = BigInt(sponsorship.preVerificationGas);
    const userOpHash = aa.getUserOperationHash({ chainId: cfg.chainId, entryPointAddress: cfg.entryPoint, entryPointVersion: '0.6', userOperation: userOp });
    userOp.signature = await account.signMessage({ message: { raw: userOpHash } });
    const submitted = await bundler.request({ method: 'eth_sendUserOperation', params: [rpcOp(), cfg.entryPoint] });
    const receipt = await aa.waitForUserOperationReceipt(bundler, { hash: submitted, timeout: 180000 });
    const txHash = receipt.receipt.transactionHash || null;
    const code = await client.getBytecode({ address: prepared.address }).catch(() => null);
    const deployed = Boolean(code && code !== '0x');
    if (!deployed) {
      throw conflict(`sponsored createAccount userOp ${submitted} (tx ${txHash}) ${receipt.success === false ? 'failed;' : 'mined but'} no code at ${prepared.address}`, 'RELAYER_ACCOUNT_DEPLOY_FAILED');
    }
    return jsonSafe({
      ...prepared,
      action: 'smartAccountDeployed',
      deployed,
      unsignedTx: null,
      broadcast: true,
      txHash,
      userOpHash: submitted,
      status: receipt.success === false ? 'reverted' : 'success',
      payer: sender,
      via: 'sponsored',
      sponsored: true,
      deployer,
    });
  }

  /**
   * Is the relayer an active, in-window session signer on the payout smart
   * account, scoped to the settlement token (and nothing dangerous)?
   */
  static async status() {
    const cfg = this.config();
    const issues = [];
    const out = {
      mode: cfg.mode,
      enabled: cfg.mode === 'session_key',
      chainId: cfg.chainId,
      smartAccount: cfg.smartAccount || null,
      relayer: cfg.relayer || null,
      relayerHasKey: Boolean(cfg.relayerKey),
      entryPoint: cfg.entryPoint,
      bundlerUrl: cfg.bundlerUrl,
      gasSponsorship: ThirdwebWalletEngine.readiness().canSponsorGas,
      admins: [],
      isSmartAccount: null,
      session: null,
      ready: false,
      issues,
    };
    if (cfg.mode !== 'session_key') issues.push('SPRITZ_PAYOUT_RELAYER is not session_key (relayer disabled; payouts need the external wallet to sign)');
    if (!isAddress(cfg.smartAccount)) { issues.push('SPRITZ_PAYOUT_WALLET is not a valid address'); return out; }
    if (!isAddress(cfg.relayer)) { issues.push('no relayer address (SPRITZ_RELAYER_PRIVATE_KEY / DAPP_PRIVATE_KEY)'); return out; }
    if (!cfg.relayerKey) issues.push('relayer has no signing key (SPRITZ_RELAYER_PRIVATE_KEY)');

    let client;
    try { client = this._publicClient(cfg); } catch (e) { issues.push(e.message); return out; }

    const code = await client.getBytecode({ address: cfg.smartAccount }).catch(() => null);
    const delegated7702 = Boolean(code && /^0xef0100/i.test(code));
    out.isSmartAccount = Boolean(code && code !== '0x') && !delegated7702;
    out.eip7702Delegate = delegated7702 ? viem.getAddress(`0x${code.slice(8, 48)}`) : null;
    if (!out.isSmartAccount) {
      issues.push(delegated7702
        ? `payout wallet ${cfg.smartAccount} is an EOA with an EIP-7702 delegation to ${out.eip7702Delegate} (Coinbase), not a thirdweb Account: it cannot hold an AccountPermissions session key. Deploy a thirdweb Account with the trustee as admin and point SPRITZ_PAYOUT_WALLET at it.`
        : `payout wallet ${cfg.smartAccount} has no contract code: it is an EOA (Coinbase), not a smart account. Deploy a thirdweb Account with the trustee as admin and point SPRITZ_PAYOUT_WALLET at it.`);
      return out;
    }
    try {
      const [admins, active, isAdmin, perms] = await Promise.all([
        this._read(client, cfg, 'getAllAdmins'),
        this._read(client, cfg, 'isActiveSigner', [cfg.relayer]),
        this._read(client, cfg, 'isAdmin', [cfg.relayer]),
        this._read(client, cfg, 'getPermissionsForSigner', [cfg.relayer]),
      ]);
      const now = Math.floor(Date.now() / 1000);
      const targets = (perms.approvedTargets || []).map((t) => viem.getAddress(t));
      const wildcard = targets.some((t) => same(t, '0x0000000000000000000000000000000000000001'));
      const hasToken = wildcard || targets.some((t) => same(t, cfg.settlementToken));
      out.admins = admins;
      out.session = {
        active: Boolean(active),
        isAdmin: Boolean(isAdmin),
        approvedTargets: targets,
        wildcardTargets: wildcard,
        nativeTokenLimitPerTransaction: perms.nativeTokenLimitPerTransaction.toString(),
        startTimestamp: Number(perms.startTimestamp),
        endTimestamp: Number(perms.endTimestamp),
        expiresInSeconds: Number(perms.endTimestamp) ? Number(perms.endTimestamp) - now : null,
      };
      if (isAdmin) issues.push('relayer is an ADMIN of the payout account; it must be a scoped session key, not an admin');
      if (!active) issues.push('relayer is not an active session signer: trustee admin must sign the session-key grant');
      else {
        if (!hasToken) issues.push(`session key cannot call the settlement token ${cfg.settlementToken}`);
        if (wildcard) issues.push('session key has wildcard targets; scope it to the settlement token + Spritz contract');
        if (perms.nativeTokenLimitPerTransaction !== 0n) issues.push('session key may move native ETH; set nativeTokenLimitPerTransaction to 0');
        if (Number(perms.endTimestamp) && Number(perms.endTimestamp) - now < 86400) issues.push('session key expires within 24h; renew the grant');
      }
    } catch (e) {
      issues.push(`payout wallet does not expose thirdweb AccountPermissions: ${e.message}`);
      return out;
    }
    out.ready = issues.length === 0;
    return out;
  }

  /**
   * EIP-712 payload for the trustee admin to sign once. Anyone (the relayer)
   * may then submit `setPermissionsForSigner(req, signature)`; the contract
   * checks the signature came from an admin.
   */
  static async prepareSessionKeyGrant({ signer, approvedTargets, durationSeconds, revoke = false } = {}) {
    const cfg = this.config();
    if (!viem) throw conflict('viem is required', 'RELAYER_UNAVAILABLE');
    if (!isAddress(cfg.smartAccount)) throw conflict('SPRITZ_PAYOUT_WALLET is not a valid address', 'RELAYER_NOT_CONFIGURED');
    const sessionSigner = signer || cfg.relayer;
    if (!isAddress(sessionSigner)) throw badRequest('signer must be a valid address');
    const now = Math.floor(Date.now() / 1000);
    const duration = Number(durationSeconds) > 0 ? Number(durationSeconds) : cfg.sessionSeconds;
    const targets = revoke ? [] : this.approvedTargets(cfg, approvedTargets || []);
    if (!revoke && !targets.length) throw conflict('no approved targets: THIRDWEB_SETTLEMENT_TOKEN must be set', 'RELAYER_NO_TARGETS');
    const request = {
      signer: viem.getAddress(sessionSigner),
      isAdmin: 0,
      approvedTargets: targets,
      nativeTokenLimitPerTransaction: 0n,
      permissionStartTimestamp: BigInt(revoke ? 0 : now),
      permissionEndTimestamp: BigInt(revoke ? 0 : now + duration),
      reqValidityStartTimestamp: BigInt(now),
      reqValidityEndTimestamp: BigInt(now + REQ_VALIDITY_SECONDS),
      uid: `0x${crypto.randomBytes(32).toString('hex')}`,
    };
    const typedData = {
      domain: { name: 'Account', version: '1', chainId: cfg.chainId, verifyingContract: viem.getAddress(cfg.smartAccount) },
      types: PERMISSION_TYPES,
      primaryType: 'SignerPermissionRequest',
      message: request,
    };
    let admins = [];
    try { admins = await this._read(this._publicClient(cfg), cfg, 'getAllAdmins'); } catch (e) { admins = []; }
    return jsonSafe({
      action: revoke ? 'revokeSessionKey' : 'grantSessionKey',
      smartAccount: cfg.smartAccount,
      chainId: cfg.chainId,
      signer: request.signer,
      admins,
      scope: { approvedTargets: targets, nativeTokenLimitPerTransaction: '0', startTimestamp: Number(request.permissionStartTimestamp), endTimestamp: Number(request.permissionEndTimestamp) },
      typedData,
      request,
      instructions: `Sign this typed data (eth_signTypedData_v4) from a payout-account admin${admins.length ? ` (${admins.join(', ')})` : ''}, then POST /api/finops/spritz/relayer/session-key/submit { request, signature }.`,
    });
  }

  /** Submit an admin-signed grant with the relayer key (any sender may submit). */
  static async submitSessionKeyGrant({ request, signature } = {}) {
    const cfg = this.config();
    if (!request || !signature) throw badRequest('request and signature required');
    if (!/^0x[0-9a-fA-F]+$/.test(String(signature))) throw badRequest('signature must be hex');
    if (!cfg.relayerKey) throw conflict('relayer has no signing key to submit the grant (SPRITZ_RELAYER_PRIVATE_KEY)', 'RELAYER_NO_KEY');
    const req = {
      signer: viem.getAddress(request.signer),
      isAdmin: Number(request.isAdmin) || 0,
      approvedTargets: (request.approvedTargets || []).map((t) => viem.getAddress(t)),
      nativeTokenLimitPerTransaction: BigInt(request.nativeTokenLimitPerTransaction || 0),
      permissionStartTimestamp: BigInt(request.permissionStartTimestamp || 0),
      permissionEndTimestamp: BigInt(request.permissionEndTimestamp || 0),
      reqValidityStartTimestamp: BigInt(request.reqValidityStartTimestamp || 0),
      reqValidityEndTimestamp: BigInt(request.reqValidityEndTimestamp || 0),
      uid: request.uid,
    };
    if (req.isAdmin !== 0) throw conflict('refusing to submit an admin grant from the relayer path', 'RELAYER_ADMIN_GRANT_FORBIDDEN');
    const account = accounts.privateKeyToAccount(cfg.relayerKey);
    const wallet = viem.createWalletClient({ account, chain: viemChain(cfg.chainId), transport: viem.http(cfg.rpcUrl) });
    const hash = await wallet.writeContract({ address: cfg.smartAccount, abi: ACCOUNT_ABI, functionName: 'setPermissionsForSigner', args: [req, signature] });
    const receipt = await this._publicClient(cfg).waitForTransactionReceipt({ hash });
    return { txHash: hash, status: receipt.status, blockNumber: receipt.blockNumber.toString(), signer: req.signer, session: (await this.status()).session };
  }

  /**
   * Sign and submit the Spritz payment from the smart account with the
   * session key: executeBatch([approve?, pay]) as one sponsored UserOperation.
   * `unsignedTx` is the SpritzEngine.prepareQuoteTransaction() result.
   */
  static async relayPayout({ unsignedTx, reference } = {}) {
    const cfg = this.config();
    if (cfg.mode !== 'session_key') throw conflict('SPRITZ_PAYOUT_RELAYER is not session_key', 'RELAYER_DISABLED');
    if (!unsignedTx || !unsignedTx.payment) throw badRequest('unsignedTx.payment required');
    if (!cfg.relayerKey) throw conflict('relayer has no signing key', 'RELAYER_NO_KEY');
    if (!aa) throw conflict('viem/account-abstraction is required', 'RELAYER_UNAVAILABLE');

    const st = await this.status();
    if (!st.ready) throw conflict(`payout relayer not ready: ${st.issues.join('; ')}`, 'RELAYER_NOT_READY');
    const targets = st.session.approvedTargets;
    const allowed = (t) => st.session.wildcardTargets || targets.some((x) => same(x, t));
    const calls = [];
    if (unsignedTx.approve) calls.push(unsignedTx.approve);
    calls.push(unsignedTx.payment);
    for (const c of calls) {
      if (!allowed(c.to)) throw conflict(`session key is not approved for target ${c.to}; re-grant with SPRITZ_RELAYER_APPROVED_TARGETS including it`, 'RELAYER_TARGET_NOT_APPROVED');
    }

    const client = this._publicClient(cfg);
    const sender = viem.getAddress(cfg.smartAccount);
    const nonce = await client.readContract({ address: cfg.entryPoint, abi: ENTRY_POINT_ABI, functionName: 'getNonce', args: [sender, 0n] });
    const callData = viem.encodeFunctionData({
      abi: ACCOUNT_ABI,
      functionName: 'executeBatch',
      args: [calls.map((c) => viem.getAddress(c.to)), calls.map(() => 0n), calls.map((c) => c.data)],
    });
    const fees = await client.estimateFeesPerGas().catch(() => ({ maxFeePerGas: 100000000n, maxPriorityFeePerGas: 1000000n }));
    const userOp = {
      sender,
      nonce,
      initCode: '0x',
      callData,
      callGasLimit: 400000n,
      verificationGasLimit: 300000n,
      preVerificationGas: 60000n,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      paymasterAndData: '0x',
      signature: '0x' + 'ff'.repeat(65),
    };
    const rpcOp = () => aa.formatUserOperationRequest(userOp);

    const bundler = aa.createBundlerClient({ chain: viemChain(cfg.chainId), client, transport: viem.http(cfg.bundlerUrl, { timeout: 60000 }) });
    const est = await bundler.request({ method: 'eth_estimateUserOperationGas', params: [rpcOp(), cfg.entryPoint] });
    if (est) {
      userOp.callGasLimit = BigInt(est.callGasLimit);
      userOp.verificationGasLimit = BigInt(est.verificationGasLimit);
      userOp.preVerificationGas = BigInt(est.preVerificationGas);
    }
    let sponsorship = null;
    if (st.gasSponsorship) {
      sponsorship = await ThirdwebWalletEngine.sponsorUserOperation(rpcOp());
      if (sponsorship && sponsorship.paymasterAndData) userOp.paymasterAndData = sponsorship.paymasterAndData;
      if (sponsorship && sponsorship.callGasLimit) userOp.callGasLimit = BigInt(sponsorship.callGasLimit);
      if (sponsorship && sponsorship.verificationGasLimit) userOp.verificationGasLimit = BigInt(sponsorship.verificationGasLimit);
      if (sponsorship && sponsorship.preVerificationGas) userOp.preVerificationGas = BigInt(sponsorship.preVerificationGas);
    }
    const userOpHash = aa.getUserOperationHash({ chainId: cfg.chainId, entryPointAddress: cfg.entryPoint, entryPointVersion: '0.6', userOperation: userOp });
    const signer = accounts.privateKeyToAccount(cfg.relayerKey);
    userOp.signature = await signer.signMessage({ message: { raw: userOpHash } });

    const submitted = await bundler.request({ method: 'eth_sendUserOperation', params: [rpcOp(), cfg.entryPoint] });
    const receipt = await aa.waitForUserOperationReceipt(bundler, { hash: submitted });
    return jsonSafe({
      signer: { type: 'session_key', relayer: cfg.relayer, smartAccount: sender },
      reference: reference || null,
      quoteId: unsignedTx.quoteId || null,
      userOpHash: submitted,
      txHash: receipt.receipt.transactionHash || null,
      success: receipt.success !== false,
      sponsored: Boolean(sponsorship && sponsorship.sponsored),
      calls: calls.map((c) => ({ to: c.to, description: c.description || null })),
    });
  }
}

module.exports = { PayoutRelayerEngine, ACCOUNT_ABI, PERMISSION_TYPES };
