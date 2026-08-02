'use strict';

const Safe = require('@safe-global/protocol-kit').default;
const { privateKeyToAccount } = require('viem/accounts');
const {
  createPublicClient, createWalletClient, http,
  encodeFunctionData, parseAbi, recoverMessageAddress, hexToBytes, toHex,
} = require('viem');
const { mainnet, sepolia, polygon, arbitrum, base } = require('viem/chains');
const { getConfig } = require('./config');

function chainById(id) {
  switch (id) {
    case 1: return mainnet;
    case 11155111: return sepolia;
    case 137: return polygon;
    case 42161: return arbitrum;
    case 8453: return base;
    default: return mainnet;
  }
}

class SafeEngine {
  static _validate() {
    const cfg = getConfig();
    if (!cfg.dappEnabled) throw new Error('DApp is disabled');
    if (!cfg.privateKey) throw new Error('DAPP_PRIVATE_KEY is not configured');
    return cfg;
  }

  static _account() {
    const cfg = this._validate();
    return privateKeyToAccount(cfg.privateKey.startsWith('0x') ? cfg.privateKey : `0x${cfg.privateKey}`);
  }

  static _publicClient() {
    const cfg = this._validate();
    return createPublicClient({ chain: chainById(cfg.chainId), transport: http(cfg.rpcUrl) });
  }

  static _walletClient() {
    const cfg = this._validate();
    return createWalletClient({ account: this._account(), chain: chainById(cfg.chainId), transport: http(cfg.rpcUrl) });
  }

  static async _getKit({ safeAddress, predictedSafe } = {}) {
    const cfg = this._validate();
    const opts = { provider: cfg.rpcUrl, signer: cfg.privateKey };
    if (safeAddress) opts.safeAddress = safeAddress;
    if (predictedSafe) opts.predictedSafe = predictedSafe;
    return Safe.init(opts);
  }

  static async predictSafeAddress({ owners, threshold, saltNonce = '0' }) {
    if (!Array.isArray(owners) || owners.length < threshold) throw new Error('Invalid owners/threshold');
    const kit = await this._getKit({ predictedSafe: { safeAccountConfig: { owners, threshold }, safeDeploymentConfig: { saltNonce: BigInt(saltNonce).toString() } } });
    const address = await kit.getAddress();
    const deploymentTransaction = await kit.createSafeDeploymentTransaction();
    return {
      safeAddress: address,
      owners,
      threshold,
      saltNonce,
      deploymentTransaction,
      isDeployed: await kit.isSafeDeployed(),
    };
  }

  static async deploySafe({ owners, threshold, saltNonce = '0' }) {
    if (!Array.isArray(owners) || owners.length < threshold) throw new Error('Invalid owners/threshold');
    const cfg = this._validate();
    const kit = await this._getKit({ predictedSafe: { safeAccountConfig: { owners, threshold }, safeDeploymentConfig: { saltNonce: BigInt(saltNonce).toString() } } });
    const predictedAddress = await kit.getAddress();
    const deploymentTx = await kit.createSafeDeploymentTransaction();

    if (cfg.dappShadow) {
      return { safeAddress: predictedAddress, txHash: `shadow-${Date.now()}`, simulated: true };
    }

    const wallet = this._walletClient();
    const hash = await wallet.sendTransaction({
      to: deploymentTx.to,
      value: BigInt(deploymentTx.value),
      data: deploymentTx.data,
    });
    const publicClient = this._publicClient();
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const { getSafeAddressFromDeploymentTx } = require('@safe-global/protocol-kit');
    const safeAddress = getSafeAddressFromDeploymentTx(receipt);
    return { safeAddress, txHash: hash, receipt, simulated: false };
  }

  static async createTransaction({ safeAddress, predictedSafe, to, value = '0', data = '0x', token, tokenAmount }) {
    if (!safeAddress) throw new Error('safeAddress required');
    const cfg = this._validate();
    const kit = await this._getKit(safeAddress && !predictedSafe ? { safeAddress } : { predictedSafe });
    if (!cfg.dappShadow && safeAddress) {
      const deployed = await kit.isSafeDeployed();
      if (!deployed) throw new Error('Safe is not deployed yet');
    }

    let transactions;
    if (token && tokenAmount) {
      const erc20Abi = parseAbi(['function transfer(address to,uint256 value) returns (bool)']);
      const transferData = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, BigInt(tokenAmount)] });
      transactions = [{ to: token, value: '0', data: transferData }];
    } else {
      transactions = [{ to, value: String(value), data }];
    }

    const safeTx = await kit.createTransaction({ transactions });
    const safeTxHash = await kit.getTransactionHash(safeTx);
    const serverSig = await kit.signHash(safeTxHash);
    safeTx.addSignature(serverSig);
    return { safeTx, safeTxHash, serverSignature: serverSig.data, proposer: serverSig.signer };
  }

  static async addSignature({ safeAddress, safeTx, signature, safeTxHash, owners }) {
    if (!safeAddress || !safeTxHash || !signature) throw new Error('safeAddress, safeTxHash and signature required');
    const recovered = await this.recoverSigner(safeTxHash, signature);
    const cfg = this._validate();
    if (!cfg.dappShadow) {
      const kit = await this._getKit({ safeAddress });
      const chainOwners = owners || (await kit.getOwners());
      if (!chainOwners.map(a => a.toLowerCase()).includes(recovered.toLowerCase())) {
        throw new Error(`Recovered signer ${recovered} is not a Safe owner`);
      }
    }
    const { EthSafeSignature } = require('@safe-global/protocol-kit');
    const sig = new EthSafeSignature(recovered, signature, false);
    safeTx.addSignature(sig);
    return { safeTx, recovered };
  }

  static async executeTransaction({ safeAddress, safeTx }) {
    const cfg = this._validate();
    if (cfg.dappShadow) return { txHash: `shadow-${Date.now()}`, simulated: true };
    const kit = await this._getKit({ safeAddress });
    const result = await kit.executeTransaction(safeTx);
    return { txHash: result.hash, simulated: false };
  }

  static rebuildTransaction(txData, signatures = []) {
    const { EthSafeTransaction } = require('@safe-global/protocol-kit');
    const safeTx = new EthSafeTransaction(txData);
    for (const sig of signatures) {
      const { EthSafeSignature } = require('@safe-global/protocol-kit');
      safeTx.addSignature(new EthSafeSignature(sig.signer, sig.signature, false));
    }
    return safeTx;
  }

  static async recoverSigner(safeTxHash, signature) {
    // Safe signHash signatures use v = yParity + 31 for eth_sign; viem expects 27/28
    const bytes = typeof signature === 'string' ? hexToBytes(signature) : signature;
    if (bytes[64] >= 30) bytes[64] -= 4;
    const adjusted = toHex(bytes);
    return recoverMessageAddress({ message: { raw: safeTxHash }, signature: adjusted });
  }

  static async getSafeInfo(safeAddress) {
    const kit = await this._getKit({ safeAddress });
    const [owners, threshold, nonce, balance, isDeployed] = await Promise.all([
      kit.getOwners(),
      kit.getThreshold(),
      kit.getNonce(),
      kit.getBalance().catch(() => '0'),
      kit.isSafeDeployed(),
    ]);
    return { safeAddress, owners, threshold, nonce, balance: String(balance), isDeployed };
  }
}

module.exports = { SafeEngine };
