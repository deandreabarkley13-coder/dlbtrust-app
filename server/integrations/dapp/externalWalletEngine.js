'use strict';

/**
 * External Wallet Integration Engine
 *
 * Registers hardware/MetaMask/GridPlus wallet addresses as trust ledger sources,
 * reads on-chain balances, and prepares signable Uniswap V2 swaps to DAI/USDS.
 * The private key never touches the server; the user signs with their own wallet.
 */

const { query } = require('../bonds/pgPool');
const { getConfig } = require('./config');
const { DexSwapEngine, UNISWAP_V2_ROUTER_02, erc20Abi, uniswapV2RouterAbi } = require('./dexSwapEngine');

let viem;
try { viem = require('viem'); } catch (e) { }

function canonicalConsensusEngine() {
  try { return require('./canonicalConsensusEngine').CanonicalConsensusEngine; } catch (e) { return null; }
}

function id(prefix = 'EW') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }
function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }

const ERC20_BALANCE_ABI = [
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
];

class ExternalWalletEngine {
  static get config() { return getConfig(); }

  static async ensureTables() {
    await query(`
      CREATE TABLE IF NOT EXISTS external_wallets (
        id          TEXT PRIMARY KEY,
        type        TEXT DEFAULT 'metamask',
        address     TEXT NOT NULL,
        label       TEXT,
        created_by  TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS external_wallet_swaps (
        id            TEXT PRIMARY KEY,
        wallet_id     TEXT,
        proposal_id   TEXT,
        token_in      TEXT,
        token_out     TEXT DEFAULT 'DAI',
        amount_in     TEXT,
        quote         JSONB DEFAULT '{}',
        unsigned_tx   JSONB DEFAULT '{}',
        approve_tx    JSONB DEFAULT '{}',
        tx_hash       TEXT,
        status        TEXT DEFAULT 'pending_signature',
        created_by    TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  static _publicClient() {
    if (!viem) throw new Error('viem not available');
    const cfg = this.config;
    const { mainnet, sepolia } = require('viem/chains');
    const chain = cfg.chainId === 11155111 ? sepolia : mainnet;
    return viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) });
  }

  static async register({ type = 'metamask', address, label, createdBy }) {
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error('Valid Ethereum address required');
    await this.ensureTables();
    const walletId = id();
    const normalized = address.toLowerCase();
    await query(
      `INSERT INTO external_wallets (id, type, address, label, created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (address) DO UPDATE SET type=$2, label=$4 RETURNING id`,
      [walletId, type, normalized, label || `${type} wallet`, createdBy || 'operator']
    );
    return { id: walletId, type, address: normalized, label: label || `${type} wallet` };
  }

  static async list({ limit = 50, offset = 0 } = {}) {
    await this.ensureTables();
    const res = await query('SELECT * FROM external_wallets ORDER BY created_at DESC LIMIT $1 OFFSET $2', [Number(limit), Number(offset)]);
    return res.rows;
  }

  static async getWallet(walletId) {
    await this.ensureTables();
    const res = await query('SELECT * FROM external_wallets WHERE id = $1', [walletId]);
    if (!res.rows.length) throw new Error('External wallet not found');
    return res.rows[0];
  }

  static async getWalletByAddress(address) {
    await this.ensureTables();
    const res = await query('SELECT * FROM external_wallets WHERE address = $1', [String(address).toLowerCase()]);
    if (!res.rows.length) return null;
    return res.rows[0];
  }

  static _tokenList() {
    const cfg = this.config;
    return [
      { symbol: 'ETH', address: null, decimals: 18 },
      { symbol: 'WETH', address: cfg.wethAddress, decimals: 18 },
      { symbol: 'USDC', address: cfg.usdcAddress, decimals: 6 },
      { symbol: 'USDS', address: cfg.usdsAddress, decimals: 18 },
      { symbol: 'DAI', address: cfg.daiAddress, decimals: 18 },
      { symbol: 'DLBUSD', address: process.env.DLBUSD_ADDRESS || cfg.dlbusdAddress || '', decimals: 6 },
      { symbol: 'DLB-PTCUSD', address: process.env.DLB_PTCUSD_ADDRESS || cfg.dlbPTCUSDAddress || '', decimals: 18 },
    ].filter(t => t.symbol === 'ETH' || t.address);
  }

  static _resolveToken(symbolOrAddress) {
    const list = this._tokenList();
    const upper = String(symbolOrAddress || '').toUpperCase();
    const bySymbol = list.find(t => t.symbol === upper);
    if (bySymbol) return bySymbol;
    const byAddress = list.find(t => t.address && t.address.toLowerCase() === String(symbolOrAddress).toLowerCase());
    if (byAddress) return byAddress;
    if (/^0x[a-fA-F0-9]{40}$/.test(symbolOrAddress)) return { symbol: symbolOrAddress.slice(0, 6), address: symbolOrAddress, decimals: 18 };
    throw new Error(`Unknown token: ${symbolOrAddress}`);
  }

  static async balances(address) {
    if (!viem) throw new Error('viem not available');
    const publicClient = this._publicClient();
    const ethBalance = await publicClient.getBalance({ address });
    const results = [{ symbol: 'ETH', address: null, decimals: 18, balance: viem.formatEther(ethBalance), raw: String(ethBalance) }];
    const tokens = this._tokenList().filter(t => t.address);
    for (const token of tokens) {
      try {
        const [raw, decimals, sym] = await Promise.all([
          publicClient.readContract({ address: token.address, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [address] }),
          publicClient.readContract({ address: token.address, abi: ERC20_BALANCE_ABI, functionName: 'decimals' }),
          publicClient.readContract({ address: token.address, abi: ERC20_BALANCE_ABI, functionName: 'symbol' }).catch(() => token.symbol),
        ]);
        results.push({ symbol: sym || token.symbol, address: token.address, decimals: Number(decimals), balance: viem.formatUnits(raw, Number(decimals)), raw: String(raw) });
      } catch (e) { /* ignore unreadable tokens */ }
    }
    return { address, balances: results };
  }

  static async quote({ walletId, tokenIn, tokenOut = 'DAI', amountIn, slippage = 100 } = {}) {
    if (!walletId || !tokenIn || !amountIn || Number(amountIn) <= 0) throw new Error('walletId, tokenIn, and amountIn required');
    const wallet = await this.getWallet(walletId);
    const inToken = this._resolveToken(tokenIn);
    const outToken = this._resolveToken(tokenOut);
    const cfg = this.config;

    const routerAddress = UNISWAP_V2_ROUTER_02;
    let path;
    if (inToken.symbol === 'ETH') {
      path = [cfg.wethAddress, outToken.address];
    } else if (inToken.address.toLowerCase() === cfg.wethAddress.toLowerCase() || outToken.address.toLowerCase() === cfg.wethAddress.toLowerCase()) {
      path = [inToken.address, outToken.address];
    } else {
      path = [inToken.address, cfg.wethAddress, outToken.address];
    }

    const quote = await DexSwapEngine.quoteUniswapV2({
      tokenIn: inToken.address || cfg.wethAddress,
      tokenOut: outToken.address,
      amountIn,
      decimalsIn: inToken.decimals,
      decimalsOut: outToken.decimals,
      router: routerAddress,
      path,
    }).catch(e => ({ error: e.message, amountOut: '0', amountOutMinimum: '0' }));

    if (quote.error) quote.amountOut = '0';

    const deadline = Math.floor(Date.now() / 1000) + 300;
    const rawIn = viem.parseUnits(String(amountIn), inToken.decimals);
    const minOut = quote.amountOutMinimum ? viem.parseUnits(String(quote.amountOutMinimum), outToken.decimals) : 0n;
    const to = wallet.address;

    let unsignedTx = null;
    let approveTx = null;

    if (inToken.symbol === 'ETH') {
      const data = viem.encodeFunctionData({
        abi: uniswapV2RouterAbi,
        functionName: 'swapExactETHForTokens',
        args: [minOut, path, to, BigInt(deadline)],
      });
      unsignedTx = { to: routerAddress, data, value: String(rawIn), gas: '250000' };
    } else {
      approveTx = {
        to: inToken.address,
        data: viem.encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [routerAddress, rawIn] }),
        value: '0',
        gas: '100000',
      };
      unsignedTx = {
        to: routerAddress,
        data: viem.encodeFunctionData({
          abi: uniswapV2RouterAbi,
          functionName: 'swapExactTokensForTokens',
          args: [rawIn, minOut, path, to, BigInt(deadline)],
        }),
        value: '0',
        gas: '300000',
      };
    }

    return {
      wallet,
      tokenIn: inToken,
      tokenOut: outToken,
      amountIn,
      path,
      quote,
      slippageBps: Number(slippage),
      unsignedTx,
      approveTx,
      instructions: approveTx
        ? 'Sign the approve transaction first, then the swap transaction with your GridPlus/MetaMask wallet.'
        : 'Sign the swap transaction with your GridPlus/MetaMask wallet.',
    };
  }

  static async propose({ walletId, tokenIn, tokenOut = 'DAI', amountIn, slippage = 100, createdBy } = {}) {
    const plan = await this.quote({ walletId, tokenIn, tokenOut, amountIn, slippage });
    const CCE = canonicalConsensusEngine();
    if (!CCE) throw new Error('CanonicalConsensusEngine not available');
    await this.ensureTables();
    const requestId = id('EWS');
    const title = `Swap ${amountIn} ${plan.tokenIn.symbol} -> ${plan.tokenOut.symbol} from ${plan.wallet.type} wallet`;
    const proposal = await CCE.createProposal({
      category: 'external_wallet_swap',
      title,
      description: `External wallet ${plan.wallet.address} (${plan.wallet.type}) swap to ${tokenOut}`,
      payload: { requestId, walletId, tokenIn, tokenOut, amountIn, slippage },
      createdBy: createdBy || 'operator',
    });
    await query(
      `INSERT INTO external_wallet_swaps (id, wallet_id, proposal_id, token_in, token_out, amount_in, quote, unsigned_tx, approve_tx, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [requestId, walletId, proposal.id, tokenIn, tokenOut, String(amountIn), safeJson(plan), safeJson(plan.unsignedTx), safeJson(plan.approveTx), 'pending_approval', createdBy || 'operator']
    );
    return { requestId, proposalId: proposal.id, plan, proposal };
  }

  static async listSwaps({ limit = 50, offset = 0 } = {}) {
    await this.ensureTables();
    const res = await query('SELECT * FROM external_wallet_swaps ORDER BY created_at DESC LIMIT $1 OFFSET $2', [Number(limit), Number(offset)]);
    return res.rows;
  }

  static async submitTx({ requestId, txHash, status = 'submitted' } = {}) {
    if (!requestId) throw new Error('requestId required');
    await query("UPDATE external_wallet_swaps SET tx_hash=$1, status=$2, updated_at=NOW() WHERE id=$3", [txHash, status, requestId]);
    return { requestId, txHash, status };
  }

  static async _execute(proposal) {
    const p = proposal.payload;
    const plan = await this.quote({ walletId: p.walletId, tokenIn: p.tokenIn, tokenOut: p.tokenOut, amountIn: p.amountIn, slippage: p.slippage });
    await query("UPDATE external_wallet_swaps SET quote=$1, unsigned_tx=$2, approve_tx=$3, status='awaiting_signature', updated_at=NOW() WHERE proposal_id=$4", [safeJson(plan), safeJson(plan.unsignedTx), safeJson(plan.approveTx), proposal.id]);
    return {
      status: 'awaiting_signature',
      walletAddress: plan.wallet.address,
      unsignedTx: plan.unsignedTx,
      approveTx: plan.approveTx,
      instructions: 'Sign the transactions in your GridPlus/MetaMask wallet and then submit the txHash.',
    };
  }
}

module.exports = { ExternalWalletEngine };
