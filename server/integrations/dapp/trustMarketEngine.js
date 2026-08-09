'use strict';

/**
 * Trust Market Maker Engine
 *
 * Lets the private trust act as a 1:1 market maker between its own
 * reserve-backed tokens (DLB-PTCUSD, DLB-PRB, DLBUSD, module tokens) and
 * canonical stablecoins (USDC, USDS, DAI) or WETH. Orders are listed on the
 * existing ModuleTokenSwap P2P contract; a buyer fills them on-chain and the
 * trust wallet receives the canonical asset without needing DEX liquidity.
 */

const { getConfig } = require('./config');

let viem;
try { viem = require('viem').viem || require('viem'); } catch (e) { }

let PairedAssetEngine, PtcStablecoinEngine, ModuleP2PSwapEngine;
try { ({ PairedAssetEngine } = require('./pairedAssetEngine')); } catch (e) { }
try { ({ PtcStablecoinEngine } = require('./ptcStablecoinEngine')); } catch (e) { }
try { ({ ModuleP2PSwapEngine } = require('./moduleP2PSwapEngine')); } catch (e) { }

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
];

const GAS_BUFFER = '0.00035'; // ETH needed for approve + createOrder

class TrustMarketEngine {
  static get config() { return getConfig(); }

  static _publicClient() {
    if (!viem) throw new Error('viem not available');
    const { mainnet, sepolia } = require('viem/chains');
    const cfg = this.config;
    const chain = cfg.chainId === 11155111 ? sepolia : mainnet;
    return viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) });
  }

  static async _operatorEthBalance() {
    if (!viem) return 0n;
    const pc = this._publicClient();
    return pc.getBalance({ address: this.config.operatorAddress });
  }

  static async _tokenInfo(symbolOrAddress, reserveModule = null) {
    const cfg = this.config;
    const t = String(symbolOrAddress || '').toUpperCase();
    let address = '';
    let decimals = 6;
    let symbol = t;

    if (t === 'DLB-PTCUSD' || t === 'PTCUSD') {
      const info = PtcStablecoinEngine ? await PtcStablecoinEngine.info().catch(() => ({})) : {};
      address = info.tokenAddress || process.env.DLB_PTCUSD_ADDRESS || cfg.dlbPTCUSDAddress || '';
      decimals = 18;
    } else if (t === 'DLBUSD' || t === 'DLB-USD') {
      if (PairedAssetEngine) {
        const r = await PairedAssetEngine._resolveToken('DLBUSD').catch(() => ({}));
        address = r.address || '';
        decimals = r.decimals || 6;
      }
    } else if (reserveModule) {
      if (PtcStablecoinEngine) {
        const r = await PtcStablecoinEngine._getModuleToken(reserveModule).catch(() => null);
        if (r) { address = r.address; decimals = r.decimals || 6; symbol = r.name || t; }
      }
    } else if (['USDC', 'USDS', 'DAI', 'WETH', 'ETH'].includes(t)) {
      if (PairedAssetEngine) {
        const r = await PairedAssetEngine._resolveToken(t).catch(() => ({}));
        address = r.address || '';
        decimals = r.decimals || 18;
      }
      if (!address) {
        const map = {
          USDC: cfg.usdcAddress,
          USDS: cfg.usdsAddress,
          DAI: cfg.daiAddress,
          WETH: cfg.wethAddress,
          ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
        };
        address = map[t] || '';
        decimals = t === 'USDC' ? 6 : 18;
      }
    }

    if (!address && viem && viem.isAddress && viem.isAddress(symbolOrAddress)) {
      address = symbolOrAddress;
    }

    if (address && viem) {
      const pc = this._publicClient();
      decimals = Number(await pc.readContract({ address, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => decimals));
    }

    return { address, decimals, symbol };
  }

  static async _balance(token, owner) {
    if (!viem || !token.address) return 0n;
    const pc = this._publicClient();
    const raw = await pc.readContract({ address: token.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] }).catch(() => 0n);
    return { raw, formatted: viem.formatUnits(raw, token.decimals), decimals: token.decimals };
  }

  static async _existingOrder({ tokenIn, tokenOut, amountOut }) {
    if (!ModuleP2PSwapEngine) return null;
    const cfg = this.config;
    const orders = await ModuleP2PSwapEngine.listOrders({ maker: cfg.operatorAddress, activeOnly: true }).catch(() => []);
    const needRaw = viem.parseUnits(String(amountOut), tokenOut.decimals);
    return orders.find(o =>
      o.tokenIn.toLowerCase() === tokenIn.address.toLowerCase() &&
      o.tokenOut.toLowerCase() === tokenOut.address.toLowerCase() &&
      BigInt(o.amountOut) >= BigInt(needRaw)
    ) || null;
  }

  static async quote({ trustToken = 'DLB-PTCUSD', pairedAsset = 'USDS', amount = '0', reserveModule = null }) {
    const cfg = this.config;
    const amountNum = Number(amount);
    if (!amountNum || amountNum <= 0) throw new Error('amount must be positive');

    const issues = [];
    if (!cfg.operatorAddress) issues.push('DAPP_OPERATOR_ADDRESS not configured');
    if (!cfg.privateKey) issues.push('DAPP_PRIVATE_KEY not configured');
    if (!ModuleP2PSwapEngine) issues.push('ModuleP2PSwapEngine not available');

    const p2pCfg = ModuleP2PSwapEngine ? ModuleP2PSwapEngine.getConfig() : {};
    if (!p2pCfg.contractAddress) issues.push('MODULE_P2P_SWAP_ADDRESS not configured');

    const tokenIn = await this._tokenInfo(trustToken, reserveModule);
    const tokenOut = await this._tokenInfo(pairedAsset);
    if (!tokenIn.address) issues.push(`Trust token ${trustToken} could not be resolved`);
    if (!tokenOut.address) issues.push(`Paired asset ${pairedAsset} could not be resolved`);

    const eth = await this._operatorEthBalance();
    const ethFormatted = viem ? viem.formatEther(eth) : '0';
    if (viem && viem.parseEther && eth < viem.parseEther(GAS_BUFFER)) issues.push(`Operator wallet needs ~${GAS_BUFFER} ETH for gas; has ${ethFormatted} ETH`);

    const bal = tokenIn.address ? await this._balance(tokenIn, cfg.operatorAddress) : { raw: 0n, formatted: '0' };
    const needInRaw = tokenIn.address && viem ? viem.parseUnits(String(amount), tokenIn.decimals) : 0n;
    if (bal.raw < needInRaw) issues.push(`Operator has ${bal.formatted} ${trustToken}, needs ${amount}`);

    const existing = (tokenIn.address && tokenOut.address && !issues.length) ? await this._existingOrder({ tokenIn, tokenOut, amountOut: amount }) : null;

    if (existing) {
      return {
        status: 'awaiting_buyer',
        trustToken, pairedAsset, amount, price: '1:1',
        tokenIn, tokenOut, balance: bal.formatted,
        orderId: String(existing.orderId),
        instructions: `An active P2P order already exists. Buyer must fill order ${existing.orderId} to send ${amount} ${pairedAsset} to the operator wallet.`,
      };
    }

    if (issues.length) {
      return {
        status: 'needs_setup',
        trustToken, pairedAsset, amount, price: '1:1',
        tokenIn, tokenOut, balance: bal.formatted,
        ethBalance: ethFormatted,
        issues,
        instructions: 'Fix the listed issues then re-quote.',
      };
    }

    // Stablecoin pairs only for 1:1; WETH/ETH needs a price oracle
    if (['WETH', 'ETH'].includes(String(pairedAsset).toUpperCase())) {
      return {
        status: 'needs_oracle',
        trustToken, pairedAsset, amount,
        instructions: 'Paired asset is ETH/WETH; a price oracle is required to set the exchange rate. Use USDC/USDS/DAI for 1:1 trust-backed conversion.',
      };
    }

    return {
      status: 'ready_to_list',
      trustToken, pairedAsset, amount, price: '1:1',
      tokenIn, tokenOut, balance: bal.formatted, ethBalance: ethFormatted,
      instructions: `List a P2P order selling ${amount} ${trustToken} for ${amount} ${pairedAsset}. A buyer fills it to send canonical stablecoin to ${cfg.operatorAddress}.`,
    };
  }

  static async createOffer({ trustToken = 'DLB-PTCUSD', pairedAsset = 'USDS', amount = '0', reserveModule = null, recipient } = {}) {
    const cfg = this.config;
    const quote = await this.quote({ trustToken, pairedAsset, amount, reserveModule });
    if (quote.status !== 'ready_to_list') return quote;

    // For module-token sales, redeem DLB-PTCUSD into the reserve module token first.
    let tokenInAddress = quote.tokenIn.address;
    let tokenInDecimals = quote.tokenIn.decimals;
    let tokenInSymbol = quote.tokenIn.symbol;
    if (reserveModule && PtcStablecoinEngine) {
      const redeemResult = await PtcStablecoinEngine.redeem({ moduleKey: reserveModule, amount: String(amount), recipient: cfg.operatorAddress });
      const reserve = await PtcStablecoinEngine._getModuleToken(reserveModule).catch(() => null);
      if (!reserve) throw new Error('Reserve module token not available after redemption');
      tokenInAddress = reserve.address;
      tokenInDecimals = reserve.decimals || 6;
      tokenInSymbol = reserve.name || reserveModule;
      const reserveBal = await this._balance({ address: tokenInAddress, decimals: tokenInDecimals }, cfg.operatorAddress);
      if (BigInt(redeemResult.reserveAmount || 0) < viem.parseUnits(String(amount), tokenInDecimals)) throw new Error('Reserve redemption did not yield enough module tokens');
    }

    const target = recipient || cfg.operatorAddress;
    const order = await ModuleP2PSwapEngine.createOrder({
      tokenIn: tokenInAddress,
      amountIn: String(amount),
      tokenOut: quote.tokenOut.address,
      amountOut: String(amount),
      recipient: target,
    });

    return {
      status: 'awaiting_buyer',
      trustToken: tokenInSymbol || trustToken,
      pairedAsset,
      amount,
      price: '1:1',
      orderId: order.orderId,
      txHash: order.txHash,
      recipient: target,
      instructions: `Order ${order.orderId} is live. Buyer must fill it by sending ${amount} ${pairedAsset} to ${target} in exchange for ${amount} ${tokenInSymbol || trustToken}.`,
    };
  }

  static async cancelOffer({ orderId } = {}) {
    if (!ModuleP2PSwapEngine) throw new Error('ModuleP2PSwapEngine not available');
    return ModuleP2PSwapEngine.cancelOrder({ orderId });
  }

  static async listOffers({ activeOnly = true } = {}) {
    const cfg = this.config;
    if (!ModuleP2PSwapEngine) return [];
    return ModuleP2PSwapEngine.listOrders({ maker: cfg.operatorAddress, activeOnly }).catch(() => []);
  }

  static async _execute(proposal) {
    const { action = 'create_offer', ...payload } = proposal.payload || {};
    if (action === 'create_offer') return this.createOffer(payload);
    if (action === 'cancel_offer') return this.cancelOffer(payload);
    throw new Error(`Unknown trust market action: ${action}`);
  }
}

module.exports = { TrustMarketEngine };
