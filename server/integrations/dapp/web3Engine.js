'use strict';

/**
 * Web3Engine
 *
 * Generic multi-chain Web3 operations for the trust: balances, native/token sends,
 * contract reads/writes, and gas price estimation. Works with the operator wallet
 * and any supplied address/wallet.
 */

const { getConfig } = require('./config');

let viem;
try { viem = require('viem'); } catch (e) { viem = null; }

const erc20Abi = [
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
];

function id(prefix = 'W3') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

class Web3Engine {
  static _viem() {
    if (!viem) throw new Error('viem not installed');
    return viem;
  }

  static _cfg() { return getConfig(); }

  static _chain() {
    const { mainnet, sepolia } = require('viem/chains');
    const cfg = this._cfg();
    return cfg.chainId === 11155111 ? sepolia : mainnet;
  }

  static _publicClient(cfg) {
    const v = this._viem();
    return v.createPublicClient({ chain: this._chain(), transport: v.http(cfg.rpcUrl) });
  }

  static _walletClient(cfg) {
    const v = this._viem();
    if (!cfg.privateKey) throw new Error('DAPP_PRIVATE_KEY not configured');
    const { privateKeyToAccount } = require('viem/accounts');
    const account = privateKeyToAccount(cfg.privateKey.startsWith('0x') ? cfg.privateKey : `0x${cfg.privateKey}`);
    return v.createWalletClient({ account, chain: this._chain(), transport: v.http(cfg.rpcUrl) });
  }

  static _tokenAddress(cfg, symbol) {
    const s = String(symbol || '').toUpperCase();
    if (s === 'USDC') return cfg.usdcAddress;
    if (s === 'USDS') return cfg.usdsAddress;
    if (s === 'DAI') return cfg.daiAddress;
    if (s === 'WETH') return cfg.wethAddress;
    return '';
  }

  static async _tokenBalance(publicClient, tokenAddress, address, decimals) {
    try {
      const raw = await publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
      return { raw, formatted: viem.formatUnits(raw, decimals || 6), decimals: decimals || 6 };
    } catch (e) { return { raw: 0n, formatted: '0', decimals: decimals || 6 }; }
  }

  static async getBalances({ address, chain = 'evm' } = {}) {
    if (!address) throw new Error('address required');
    const v = this._viem();
    const cfg = this._cfg();
    const normalized = v.getAddress ? v.getAddress(address) : address.toLowerCase();
    const publicClient = this._publicClient(cfg);

    const [ethWei, usdc, usds, dai, weth] = await Promise.all([
      publicClient.getBalance({ address: normalized }),
      this._tokenBalance(publicClient, cfg.usdcAddress, normalized, 6),
      this._tokenBalance(publicClient, cfg.usdsAddress, normalized, 18),
      this._tokenBalance(publicClient, cfg.daiAddress, normalized, 18),
      this._tokenBalance(publicClient, cfg.wethAddress, normalized, 18),
    ]);

    return {
      chain: cfg.chainId,
      rpcUrl: cfg.rpcUrl.replace(/\/v2\/[^\/]+/, '/v2/[hidden]'),
      address: normalized,
      native: { symbol: cfg.nativeTokenSymbol || 'ETH', balance: v.formatEther(ethWei), raw: String(ethWei) },
      usdc: { symbol: 'USDC', tokenAddress: cfg.usdcAddress, raw: String(usdc.raw), formatted: usdc.formatted, decimals: usdc.decimals },
      usds: { symbol: 'USDS', tokenAddress: cfg.usdsAddress, raw: String(usds.raw), formatted: usds.formatted, decimals: usds.decimals },
      dai: { symbol: 'DAI', tokenAddress: cfg.daiAddress, raw: String(dai.raw), formatted: dai.formatted, decimals: dai.decimals },
      weth: { symbol: 'WETH', tokenAddress: cfg.wethAddress, raw: String(weth.raw), formatted: weth.formatted, decimals: weth.decimals },
    };
  }

  static async getGasPrice() {
    const v = this._viem();
    const cfg = this._cfg();
    const publicClient = this._publicClient(cfg);
    const fees = cfg.getFees ? (cfg.getFees() || {}) : {};
    const [gasPrice, block] = await Promise.all([
      publicClient.getGasPrice().catch(() => null),
      publicClient.getBlock().catch(() => ({}))
    ]);
    return {
      gasPrice: gasPrice ? v.formatGwei(gasPrice) : null,
      baseFeePerGas: block.baseFeePerGas ? v.formatGwei(block.baseFeePerGas) : null,
      suggestedMaxFeePerGas: fees.maxFeePerGas ? v.formatGwei(fees.maxFeePerGas) : null,
      suggestedMaxPriorityFeePerGas: fees.maxPriorityFeePerGas ? v.formatGwei(fees.maxPriorityFeePerGas) : null,
    };
  }

  static async callContract({ address, abi, functionName, args = [] } = {}) {
    if (!address || !functionName) throw new Error('address and functionName required');
    const cfg = this._cfg();
    const publicClient = this._publicClient(cfg);
    let result = await publicClient.readContract({ address, abi, functionName, args });
    if (typeof result === 'bigint') result = String(result);
    if (Array.isArray(result)) result = result.map(v => typeof v === 'bigint' ? String(v) : v);
    return { result };
  }

  static async sendTransaction({ to, value, gas = 21000, data = '0x', maxFeePerGas, maxPriorityFeePerGas } = {}) {
    if (!to) throw new Error('to required');
    const v = this._viem();
    const cfg = this._cfg();
    const wallet = this._walletClient(cfg);
    const fees = cfg.getFees ? (cfg.getFees() || {}) : {};
    const tx = {
      to,
      value: value ? v.parseEther(String(value)) : 0n,
      gas: BigInt(gas),
      data: data || '0x',
      ...fees,
    };
    if (maxFeePerGas) tx.maxFeePerGas = v.parseGwei(String(maxFeePerGas));
    if (maxPriorityFeePerGas) tx.maxPriorityFeePerGas = v.parseGwei(String(maxPriorityFeePerGas));
    const hash = await wallet.sendTransaction(tx);
    return { txHash: hash, to, value: value || '0' };
  }

  static async writeContract({ address, abi, functionName, args = [], value, gas = 100000, maxFeePerGas, maxPriorityFeePerGas } = {}) {
    if (!address || !functionName) throw new Error('address and functionName required');
    const v = this._viem();
    const cfg = this._cfg();
    const wallet = this._walletClient(cfg);
    const publicClient = this._publicClient(cfg);
    const fees = cfg.getFees ? (cfg.getFees() || {}) : {};
    const tx = {
      address,
      abi,
      functionName,
      args,
      gas: BigInt(gas),
      ...fees,
    };
    if (value) tx.value = v.parseEther(String(value));
    if (maxFeePerGas) tx.maxFeePerGas = v.parseGwei(String(maxFeePerGas));
    if (maxPriorityFeePerGas) tx.maxPriorityFeePerGas = v.parseGwei(String(maxPriorityFeePerGas));
    const hash = await wallet.writeContract(tx);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    const serialArgs = (args || []).map(a => typeof a === 'bigint' ? String(a) : a);
    return { txHash: hash, to: address, functionName, args: serialArgs, receipt: {
      status: receipt.status,
      blockNumber: String(receipt.blockNumber || ''),
      gasUsed: String(receipt.gasUsed || ''),
      transactionHash: receipt.transactionHash,
    }};
  }

  static async sendToken({ token, to, amount, decimals, gas = 100000, maxFeePerGas, maxPriorityFeePerGas } = {}) {
    if (!token || !to || !amount) throw new Error('token, to and amount required');
    const v = this._viem();
    const cfg = this._cfg();
    const tokenAddress = token.startsWith('0x') ? token : this._tokenAddress(cfg, token);
    if (!tokenAddress) throw new Error(`Token address not configured for ${token}`);
    const dec = decimals ? Number(decimals) : (await this._decimals(tokenAddress));
    return this.writeContract({ address: tokenAddress, abi: erc20Abi, functionName: 'transfer', args: [to, v.parseUnits(String(amount), dec)], gas, maxFeePerGas, maxPriorityFeePerGas });
  }

  static async _decimals(tokenAddress) {
    const cfg = this._cfg();
    const publicClient = this._publicClient(cfg);
    try { return Number(await publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'decimals' })); } catch (e) { return 6; }
  }

  static async info() {
    const cfg = this._cfg();
    return {
      chainId: cfg.chainId,
      rpcUrl: cfg.rpcUrl.replace(/\/v2\/[^\/]+/, '/v2/[hidden]'),
      operatorAddress: cfg.operatorAddress,
      nativeSymbol: cfg.nativeTokenSymbol || 'ETH',
      usdc: cfg.usdcAddress,
      usds: cfg.usdsAddress,
      dai: cfg.daiAddress,
      weth: cfg.wethAddress,
      viemAvailable: !!viem,
    };
  }
}

module.exports = { Web3Engine };
