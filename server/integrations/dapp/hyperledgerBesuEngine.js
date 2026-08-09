'use strict';

const { getConfig: getDappConfig } = require('./config');

let viem;
try { viem = require('viem'); } catch (e) { /* optional */ }

function envBool(name, def = false) {
  const v = process.env[name];
  return v === 'true' || v === '1' || (v === undefined ? def : false);
}

function envStr(name, def = '') { return process.env[name] || def; }
function envNum(name, def = 0) { const v = Number(process.env[name]); return Number.isFinite(v) ? v : def; }

function getBesuConfig() {
  return {
    enabled: envBool('HYPERLEDGER_BESU_ENABLED', false),
    shadow: envBool('HYPERLEDGER_BESU_SHADOW', true),
    rpcUrl: envStr('HYPERLEDGER_BESU_RPC_URL', ''),
    chainId: envNum('HYPERLEDGER_BESU_CHAIN_ID', 1337),
    privateKey: envStr('HYPERLEDGER_BESU_PRIVATE_KEY', ''),
    nativeSymbol: envStr('HYPERLEDGER_BESU_NATIVE_SYMBOL', 'BESU'),
    clearingContractAddress: envStr('HYPERLEDGER_BESU_CLEARING_ADDRESS', ''),
  };
}

function besuChain(cfg) {
  return viem.defineChain({
    id: cfg.chainId,
    name: 'DLB Hyperledger Besu',
    nativeCurrency: { name: 'BESU Ether', symbol: cfg.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
}

class HyperledgerBesuEngine {
  static getConfig() {
    return getBesuConfig();
  }

  static _clients() {
    if (!viem) throw new Error('viem not available');
    const cfg = this.getConfig();
    if (!cfg.enabled || (!cfg.rpcUrl && cfg.shadow)) {
      return { shadow: true, cfg };
    }
    if (!cfg.rpcUrl) throw new Error('HyperledgerBesuEngine: HYPERLEDGER_BESU_RPC_URL not configured');
    if (!cfg.privateKey) throw new Error('HyperledgerBesuEngine: HYPERLEDGER_BESU_PRIVATE_KEY not configured');
    const chain = besuChain(cfg);
    const publicClient = viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) });
    const account = viem.privateKeyToAccount(cfg.privateKey);
    const walletClient = viem.createWalletClient({ account, chain, transport: viem.http(cfg.rpcUrl) });
    return { shadow: false, cfg, publicClient, walletClient, account, chain };
  }

  static async status() {
    const cfg = this.getConfig();
    if (!cfg.enabled) return { enabled: false, shadow: cfg.shadow, message: 'Besu integration disabled' };
    if (cfg.shadow) return { enabled: true, shadow: true, chainId: cfg.chainId, rpcUrl: cfg.rpcUrl, message: 'Running in shadow mode' };
    try {
      const { publicClient } = this._clients();
      const blockNumber = await publicClient.getBlockNumber();
      return { enabled: true, shadow: false, chainId: cfg.chainId, rpcUrl: cfg.rpcUrl, blockNumber: String(blockNumber) };
    } catch (e) {
      return { enabled: true, shadow: false, chainId: cfg.chainId, rpcUrl: cfg.rpcUrl, error: e.message };
    }
  }

  static async deployClearingContract() {
    const { shadow, cfg, walletClient, publicClient, account } = this._clients();
    if (shadow || !walletClient) {
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update('besu-clearing-' + Date.now()).digest('hex');
      const addr = '0xshadow' + hash.slice(0, 34);
      return { shadow: true, clearingAddress: addr, message: 'Shadow clearing contract' };
    }
    const bytecode = envStr('HYPERLEDGER_BESU_CLEARING_BYTECODE');
    if (!bytecode) throw new Error('Set HYPERLEDGER_BESU_CLEARING_BYTECODE to deploy clearing contract on Besu');
    const hash = await walletClient.deployContract({
      abi: this._clearingAbi(),
      bytecode,
      args: [],
      account,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const clearingAddress = receipt.contractAddress;
    process.env.HYPERLEDGER_BESU_CLEARING_ADDRESS = clearingAddress;
    return { clearingAddress, tx: hash };
  }

  static async transferToken({ tokenAddress, to, amount, decimals = 18 }) {
    if (!viem) throw new Error('viem not available');
    if (!viem.isAddress(tokenAddress) || !viem.isAddress(to)) throw new Error('invalid address');
    const { shadow, walletClient, publicClient, account } = this._clients();
    const raw = viem.parseUnits(String(amount), decimals);
    if (shadow || !walletClient) {
      return { shadow: true, tokenAddress, to, amount, raw: String(raw), tx: `shadow-besu-${Date.now()}` };
    }
    const hash = await walletClient.writeContract({
      address: tokenAddress,
      abi: this._erc20Abi(),
      functionName: 'transfer',
      args: [to, raw],
      account,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return { tx: hash, receipt, tokenAddress, to, amount };
  }

  static async getBalance({ tokenAddress, address, decimals = 18 }) {
    if (!viem) return { balance: '0', raw: '0' };
    if (!viem.isAddress(tokenAddress) || !viem.isAddress(address)) throw new Error('invalid address');
    const { shadow, publicClient } = this._clients();
    if (shadow || !publicClient) return { balance: '0', raw: '0', shadow: true };
    const raw = await publicClient.readContract({
      address: tokenAddress,
      abi: this._erc20Abi(),
      functionName: 'balanceOf',
      args: [address],
    });
    return { balance: viem.formatUnits(raw, decimals), raw: String(raw), tokenAddress, address };
  }

  static _erc20Abi() {
    return [
      { type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
      { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
      { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
    ];
  }

  static _clearingAbi() {
    return [
      { type: 'event', name: 'Clear', inputs: [{ indexed: true, name: 'id', type: 'bytes32' }, { indexed: false, name: 'payer', type: 'address' }, { indexed: false, name: 'payee', type: 'address' }, { indexed: false, name: 'amount', type: 'uint256' }] },
      { type: 'function', name: 'clear', inputs: [{ name: 'id', type: 'bytes32' }, { name: 'payer', type: 'address' }, { name: 'payee', type: 'address' }, { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
      { type: 'function', name: 'settlements', inputs: [{ name: '', type: 'bytes32' }], outputs: [{ type: 'bool' }], stateMutability: 'view' },
    ];
  }
}

module.exports = { HyperledgerBesuEngine };
