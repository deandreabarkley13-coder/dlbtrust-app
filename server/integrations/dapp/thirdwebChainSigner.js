'use strict';

/**
 * Chain signer backed by the thirdweb server wallet.
 *
 * Every on-chain act the trust performs as issuer — deploying the bond and
 * trust-token contracts, minting, whitelisting, depositing reserves — is signed
 * by the Vault-held server wallet through the thirdweb API instead of a raw
 * private key on the host:
 *
 *   POST /v1/contracts                        deploy bytecode (CREATE2, deterministic by salt)
 *   POST /v1/contracts/write                  call a state-changing method
 *   POST /v1/contracts/read                   call a view method
 *   GET  /v1/transactions/{transactionId}     QUEUED | SUBMITTED | CONFIRMED | FAILED (+ receipt)
 *
 * Gas is sponsored by the thirdweb project (EIP-7702 execution), so the wallet
 * needs no native balance. Because `/v1/contracts` deploys through a CREATE2
 * factory, a constructor that reads `msg.sender` sees the factory, not the
 * wallet: contracts that take their owner as a constructor argument
 * (PtcBackedStablecoin, PtcReserveVault) deploy directly; BondToken, which does
 * not, is created through BondTokenFactory so ownership lands on the wallet.
 *
 * `clients()` exposes the same shape the viem-based engines already consume
 * (`wallet.deployContract`, `wallet.writeContract`, `publicClient.readContract`,
 * `publicClient.waitForTransactionReceipt`), returning thirdweb transaction ids
 * in place of hashes until the receipt resolves the real hash.
 *
 * Selected with DAPP_SIGNER=thirdweb; otherwise the engines keep using
 * DAPP_PRIVATE_KEY and their own RPC.
 */

const fs = require('fs');
const path = require('path');
const { ThirdwebServerWalletEngine } = require('./thirdwebServerWalletEngine');

const TX_PREFIX = 'tw:';

let viem;
try { viem = require('viem'); } catch (e) { /* signatures fall back to a hand-built encoder */ }

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function num(name, def) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : def; }

function artifact(name) {
  const dir = path.join(process.cwd(), 'artifacts');
  const abiPath = path.join(dir, `${name}.abi`);
  const binPath = path.join(dir, `${name}.bin`);
  if (!fs.existsSync(abiPath) || !fs.existsSync(binPath)) throw new Error(`artifact not found: ${name}`);
  const bin = fs.readFileSync(binPath, 'utf8').trim();
  return { abi: JSON.parse(fs.readFileSync(abiPath, 'utf8')), bytecode: bin.startsWith('0x') ? bin : `0x${bin}` };
}

function typeOf(param) {
  if (param.type === 'tuple') return `(${param.components.map(typeOf).join(',')})`;
  if (param.type.startsWith('tuple[')) return `(${param.components.map(typeOf).join(',')})${param.type.slice(5)}`;
  return param.type;
}

/** `function name(type a,type b) view returns (type)` for the thirdweb method field. */
function signatureFor(abi, functionName) {
  const items = (abi || []).filter((f) => f.type === 'function' && f.name === functionName);
  if (!items.length) throw new Error(`${functionName} not in ABI`);
  const fn = items[0];
  const inputs = fn.inputs.map((i) => (i.name ? `${typeOf(i)} ${i.name}` : typeOf(i))).join(', ');
  const outputs = (fn.outputs || []).map(typeOf).join(', ');
  const view = fn.stateMutability === 'view' || fn.stateMutability === 'pure' ? ' view' : '';
  const ret = outputs ? ` returns (${outputs})` : '';
  return { fn, method: `function ${functionName}(${inputs})${view}${ret}` };
}

function encodeParam(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(encodeParam);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeParam(v)]));
  }
  return value;
}

/** thirdweb returns integers as decimal strings; hand back what viem would. */
function decodeOutput(fn, data) {
  const outputs = fn.outputs || [];
  const one = (type, v) => {
    if (/^u?int/.test(type) && !type.endsWith(']')) return BigInt(v);
    if (type === 'bool') return v === true || v === 'true';
    return v;
  };
  if (outputs.length === 1) return one(typeOf(outputs[0]), data);
  if (Array.isArray(data)) return data.map((v, i) => one(typeOf(outputs[i] || { type: 'string' }), v));
  return data;
}

const deployed = new Map(); // transactionId -> contract address, for waitForTransactionReceipt

class ThirdwebChainSigner {
  static getConfig() {
    const wallet = ThirdwebServerWalletEngine.getConfig();
    return {
      signer: str('DAPP_SIGNER', 'private-key').toLowerCase(),
      chainId: num('DAPP_CHAIN_ID', wallet.chainId),
      address: wallet.address,
      secretKey: wallet.secretKey,
      timeoutMs: num('THIRDWEB_TX_TIMEOUT_MS', 180000),
      pollMs: num('THIRDWEB_TX_POLL_MS', 3000),
      bondTokenFactory: str('BOND_TOKEN_FACTORY'),
      deploySaltPrefix: str('THIRDWEB_DEPLOY_SALT_PREFIX', 'dlbtrust'),
    };
  }

  static active() { return this.getConfig().signer === 'thirdweb'; }

  static artifact(name) { return artifact(name); }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.secretKey) issues.push('THIRDWEB_SECRET_KEY not configured');
    if (!cfg.address) issues.push('THIRDWEB_SERVER_WALLET_ADDRESS not configured');
    return {
      provider: 'thirdweb-chain-signer',
      active: cfg.signer === 'thirdweb',
      signer: cfg.signer,
      chainId: cfg.chainId,
      address: cfg.address || null,
      gasSponsored: true,
      bondTokenFactory: cfg.bondTokenFactory || null,
      ready: issues.length === 0,
      issues,
    };
  }

  /** The address that owns every contract and holds unsold units. */
  static address() { return this.getConfig().address || null; }

  static async _rawTransaction(transactionId) {
    return ThirdwebServerWalletEngine._request('GET', `/v1/transactions/${encodeURIComponent(transactionId)}`);
  }

  /** Poll until terminal; returns viem-like receipt fields plus the raw thirdweb record. */
  static async wait(transactionId, { timeoutMs, pollMs } = {}) {
    const cfg = this.getConfig();
    const deadline = Date.now() + (timeoutMs || cfg.timeoutMs);
    let tx = await this._rawTransaction(transactionId);
    while (!['CONFIRMED', 'FAILED'].includes(tx.status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs || cfg.pollMs));
      tx = await this._rawTransaction(transactionId);
    }
    if (tx.status !== 'CONFIRMED') {
      const err = new Error(`thirdweb transaction ${transactionId} ${tx.status}${tx.errorMessage ? `: ${tx.errorMessage}` : ''}`);
      err.transactionId = transactionId;
      err.status = tx.status === 'FAILED' ? 502 : 504;
      throw err;
    }
    const receipt = (tx.executionResult && tx.executionResult.receipt) || {};
    return {
      status: 'success',
      transactionId,
      transactionHash: tx.transactionHash || receipt.transactionHash || null,
      blockNumber: tx.confirmedAtBlockNumber ? BigInt(tx.confirmedAtBlockNumber) : null,
      logs: receipt.logs || [],
      contractAddress: deployed.get(transactionId) || null,
      raw: tx,
    };
  }

  /**
   * Deploy bytecode from the server wallet. Deterministic: the same salt on
   * the same chain yields the same address, and a second call returns the
   * existing contract without a transaction.
   */
  static async deploy({ abi, bytecode, args = [], salt, chainId } = {}) {
    const cfg = this.getConfig();
    if (!cfg.address) throw new Error('THIRDWEB_SERVER_WALLET_ADDRESS not configured');
    const ctor = (abi || []).find((f) => f.type === 'constructor') || { inputs: [] };
    const constructorParams = {};
    ctor.inputs.forEach((input, i) => { constructorParams[input.name || `arg${i}`] = encodeParam(args[i]); });
    const body = {
      chainId: Number(chainId || cfg.chainId),
      from: cfg.address,
      bytecode: bytecode.startsWith('0x') ? bytecode : `0x${bytecode}`,
      abi,
      constructorParams,
    };
    if (salt) body.salt = `${cfg.deploySaltPrefix}:${salt}`;
    const result = await ThirdwebServerWalletEngine._request('POST', '/v1/contracts', body);
    const out = { address: result.address, chainId: result.chainId, transactionId: result.transactionId || null, alreadyDeployed: !result.transactionId };
    if (out.transactionId) {
      deployed.set(out.transactionId, out.address);
      const receipt = await this.wait(out.transactionId);
      out.transactionHash = receipt.transactionHash;
    }
    return out;
  }

  /** State-changing call; resolves once confirmed. */
  static async write({ address, abi, functionName, args = [], value, chainId, idempotencyKey } = {}) {
    const cfg = this.getConfig();
    if (!cfg.address) throw new Error('THIRDWEB_SERVER_WALLET_ADDRESS not configured');
    const { method } = signatureFor(abi, functionName);
    const body = {
      chainId: Number(chainId || cfg.chainId),
      from: cfg.address,
      calls: [{ contractAddress: address, method, params: args.map(encodeParam), value: value === undefined ? '0' : String(value) }],
    };
    if (idempotencyKey) body.idempotencyKey = idempotencyKey;
    const result = await ThirdwebServerWalletEngine._request('POST', '/v1/contracts/write', body);
    const transactionId = (result.transactionIds || [])[0];
    if (!transactionId) throw new Error(`thirdweb write ${functionName} returned no transaction id`);
    return transactionId;
  }

  /** View call, decoded like viem would (uints as BigInt). */
  static async read({ address, abi, functionName, args = [], chainId } = {}) {
    const cfg = this.getConfig();
    const { fn, method } = signatureFor(abi, functionName);
    const result = await ThirdwebServerWalletEngine._request('POST', '/v1/contracts/read', {
      chainId: Number(chainId || cfg.chainId),
      calls: [{ contractAddress: address, method, params: args.map(encodeParam) }],
    });
    const row = Array.isArray(result) ? result[0] : result;
    if (!row || row.success === false) throw new Error(`thirdweb read ${functionName} failed: ${row && row.error ? row.error : 'no result'}`);
    return decodeOutput(fn, row.data);
  }

  /**
   * Create a BondToken owned by the server wallet. Goes through
   * BondTokenFactory (deployed deterministically on first use) because
   * BondToken's constructor takes ownership from msg.sender, which under
   * CREATE2 would be the deployer contract.
   */
  static async deployBondToken({ name, symbol, initialSupply = 0n, chainId } = {}) {
    const cfg = this.getConfig();
    const chain = Number(chainId || cfg.chainId);
    const factoryArtifact = artifact('contracts_BondTokenFactory_sol_BondTokenFactory');
    let factory = cfg.bondTokenFactory;
    let factoryDeploy = null;
    if (!factory) {
      factoryDeploy = await this.deploy({ ...factoryArtifact, salt: `bond-token-factory:${chain}`, chainId: chain });
      factory = factoryDeploy.address;
    }
    const transactionId = await this.write({
      address: factory, abi: factoryArtifact.abi, functionName: 'createBondToken', args: [name, symbol, BigInt(initialSupply)], chainId: chain,
    });
    const receipt = await this.wait(transactionId);
    const topic = viem ? viem.keccak256(viem.toBytes('BondTokenCreated(address,string,string,uint256)')) : null;
    const log = receipt.logs.find((l) => String(l.address).toLowerCase() === factory.toLowerCase()
      && (!topic || String((l.topics || [])[0]).toLowerCase() === topic));
    const tokenTopic = log && log.topics && log.topics[1];
    if (!tokenTopic) throw new Error(`BondTokenCreated event not found in ${receipt.transactionHash || transactionId}`);
    const address = `0x${String(tokenTopic).slice(-40)}`;
    return { address: viem && viem.getAddress ? viem.getAddress(address) : address, factory, factoryDeploy, transactionId, transactionHash: receipt.transactionHash };
  }

  /**
   * viem-shaped adapter for the engines: `deployContract`/`writeContract`
   * return `tw:<transactionId>`, `waitForTransactionReceipt` resolves it to a
   * receipt with the on-chain hash (and `contractAddress` for deployments).
   */
  static clients({ chainId } = {}) {
    const cfg = this.getConfig();
    const chain = Number(chainId || cfg.chainId);
    const self = this;
    const toHash = (id) => `${TX_PREFIX}${id}`;
    const fromHash = (hash) => String(hash).startsWith(TX_PREFIX) ? String(hash).slice(TX_PREFIX.length) : String(hash);
    const account = { address: cfg.address };
    const wallet = {
        async deployContract({ abi, bytecode, args, salt }) {
          const out = await self.deploy({ abi, bytecode, args, salt, chainId: chain });
          const id = out.transactionId || `deployed:${out.address}`;
          deployed.set(id, out.address);
          return toHash(id);
        },
        async writeContract({ address, abi, functionName, args, value }) {
          return toHash(await self.write({ address, abi, functionName, args, value, chainId: chain }));
        },
    };
    return {
      account,
      fees: {},
      signer: 'thirdweb',
      wallet,
      walletClient: wallet,
      publicClient: {
        async readContract({ address, abi, functionName, args }) {
          return self.read({ address, abi, functionName, args, chainId: chain });
        },
        async waitForTransactionReceipt({ hash, timeout }) {
          const id = fromHash(hash);
          if (id.startsWith('deployed:')) {
            return { status: 'success', transactionHash: null, contractAddress: id.slice('deployed:'.length), logs: [], alreadyDeployed: true };
          }
          return self.wait(id, { timeoutMs: timeout });
        },
      },
    };
  }
}

ThirdwebChainSigner.artifact = artifact;
ThirdwebChainSigner.signatureFor = signatureFor;

module.exports = { ThirdwebChainSigner, TX_PREFIX };
