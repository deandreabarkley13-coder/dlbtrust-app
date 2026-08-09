'use strict';

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config');
const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');

let CrossChainConversionEngine, OnOffRampEngine, CanonicalConsensusEngine, StablecoinDexEngine, DexSwapEngine, ModuleP2PSwapEngine;
try { ({ CrossChainConversionEngine } = require('./crossChainConversionEngine')); } catch (e) { }
try { ({ OnOffRampEngine } = require('./onOffRampEngine')); } catch (e) { }
try { ({ CanonicalConsensusEngine } = require('./canonicalConsensusEngine')); } catch (e) { }
try { ({ StablecoinDexEngine } = require('./stablecoinDexEngine')); } catch (e) { }
try { ({ DexSwapEngine } = require('./dexSwapEngine')); } catch (e) { }
try { ({ ModuleP2PSwapEngine } = require('./moduleP2PSwapEngine')); } catch (e) { }

let viem, privateKeyToAccount;
try { viem = require('viem'); ({ privateKeyToAccount } = require('viem/accounts')); } catch (e) { }

function dataDir() {
  if (process.env.PERSISTENT_DATA_DIR && fs.existsSync(process.env.PERSISTENT_DATA_DIR)) return process.env.PERSISTENT_DATA_DIR;
  if (fs.existsSync('/data')) return '/data';
  return path.join(process.cwd(), 'data');
}

function statePath() { return path.join(dataDir(), 'capital-fund-state.json'); }

function ensureDir() {
  const dir = dataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadState() {
  ensureDir();
  try { if (fs.existsSync(statePath())) return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch (e) { console.warn('[CapitalFundEngine] load state failed:', e.message); }
  return { funds: [] };
}

function saveState(state) {
  ensureDir();
  try { fs.writeFileSync(statePath(), JSON.stringify(state, null, 2)); } catch (e) { console.warn('[CapitalFundEngine] save state failed:', e.message); }
}

function generateId(prefix = 'CF') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function getOperatorAddress() {
  const cfg = getConfig();
  try {
    if (viem && privateKeyToAccount && cfg.privateKey) return privateKeyToAccount(cfg.privateKey).address;
  } catch (e) { /* fall through */ }
  return (cfg.operatorAddress || process.env.DAPP_OPERATOR_ADDRESS || '').trim();
}

function walletClient() {
  if (!viem) throw new Error('viem not installed');
  const cfg = getConfig();
  if (!cfg.privateKey) throw new Error('DAPP_PRIVATE_KEY not configured');
  const account = privateKeyToAccount(cfg.privateKey);
  const chains = require('viem/chains');
  const chain = cfg.chainId === 1 ? chains.mainnet : (chains.sepolia || undefined);
  const fees = cfg.getFees ? (cfg.getFees() || { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') }) : { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') };
  return {
    account,
    fees,
    wallet: viem.createWalletClient({ account, chain, transport: viem.http(cfg.rpcUrl) }),
    publicClient: viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) }),
  };
}

async function getTokenBalance(tokenAddress, holder) {
  if (!viem || !tokenAddress || !holder) return 0;
  try {
    const { publicClient } = walletClient();
    const raw = await publicClient.readContract({
      address: tokenAddress,
      abi: [{ type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
      functionName: 'balanceOf',
      args: [holder],
    });
    const decimals = Number(await publicClient.readContract({ address: tokenAddress, abi: [{ type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' }], functionName: 'decimals' }).catch(() => 6));
    return Number(viem.formatUnits(raw, decimals));
  } catch (e) {
    console.warn('[CapitalFundEngine] getTokenBalance failed:', e.message);
    return 0;
  }
}

function targetAddressFor(asset) {
  const t = String(asset).toUpperCase();
  const cfg = getConfig();
  if (t === 'USDC') return cfg.usdcAddress || process.env.DAPP_USDC_ADDRESS || '';
  if (t === 'USDS') return process.env.DAPP_USDS_ADDRESS || '';
  if (t === 'DAI') return process.env.DAPP_DAI_ADDRESS || '0x6B175474E89094C44Da98b954EedeAC495271d0F';
  if (t === 'WETH' || t === 'ETH') return cfg.wethAddress || process.env.DAPP_WETH_ADDRESS || '';
  return '';
}

function targetDecimalsFor(asset) {
  const t = String(asset).toUpperCase();
  if (['WETH', 'ETH', 'DAI', 'USDS'].includes(t)) return 18;
  return 6;
}

class CapitalFundEngine {
  static listFunds({ status, limit = 100 } = {}) {
    const state = loadState();
    let funds = state.funds || [];
    if (status) funds = funds.filter(f => f.status === status);
    return funds.slice(0, Number(limit) || 100);
  }

  static getFund(fundId) {
    const state = loadState();
    return (state.funds || []).find(f => f.id === fundId) || null;
  }

  static async listSourceAccounts() {
    const accounts = await TrustAccountingEngine.listAccounts({ isActive: true });
    return accounts.filter(a => ['asset', 'liability', 'equity'].includes(a.account_type));
  }

  static async createFund({
    name,
    sourceType = 'trust',
    sourceAccountId,
    amount,
    targetAsset = 'USDC',
    strategy = 'p2p_sell',
    targetAllocation = 'reserve',
    createdBy = 'operator',
  } = {}) {
    if (!name || !sourceAccountId || !amount) throw new Error('name, sourceAccountId and amount required');
    const amountNum = round2(amount);
    if (amountNum <= 0) throw new Error('amount must be positive');

    const sourceAccount = await TrustAccountingEngine.getAccount(sourceAccountId);
    if (!sourceAccount) throw new Error(`Source account not found: ${sourceAccountId}`);
    const sourceBalance = round2(sourceAccount.balance || 0);
    if (sourceBalance < amountNum) throw new Error(`Insufficient balance in ${sourceAccountId}: ${sourceBalance} < ${amountNum}`);

    const id = generateId('CF');
    const accountCode = `CF-${Date.now()}`;

    await TrustAccountingEngine.createAccount({
      accountCode,
      accountName: `Capital Fund: ${name}`,
      accountType: 'asset',
      subType: 'reserve',
      description: `Capital fund managed account for ${id}`,
    });

    const journal = await TrustAccountingEngine.postJournalEntry({
      entryDate: new Date(),
      description: `Stage capital fund ${id} from ${sourceType}:${sourceAccountId}`,
      referenceType: 'capital_fund',
      referenceId: id,
      postedBy: createdBy,
      postToFineract: false,
      lines: [
        { accountCode, debitAmount: amountNum, creditAmount: 0, memo: 'Stage capital for canonical conversion' },
        { accountCode: sourceAccountId, debitAmount: 0, creditAmount: amountNum, memo: 'Move funds to capital fund' },
      ],
    });

    const fund = {
      id,
      name,
      accountCode,
      sourceType,
      sourceAccountId,
      amount: amountNum,
      targetAsset: String(targetAsset).toUpperCase(),
      strategy,
      targetAllocation,
      status: 'staged',
      proposalId: null,
      requestId: null,
      orderId: null,
      poolAddress: null,
      canonicalAmount: null,
      canonicalTxHash: null,
      journalEntryId: journal.entry_id,
      createdBy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (strategy === 'p2p_sell') {
      if (!CrossChainConversionEngine) throw new Error('CrossChainConversionEngine not available');
      const proposal = await CrossChainConversionEngine.propose({
        sourceType: 'trust',
        sourceAccountId: accountCode,
        amount: String(amountNum),
        targetAsset: fund.targetAsset,
        routeName: 'p2p_order',
        createdBy,
      });
      fund.requestId = proposal.requestId;
      fund.proposalId = proposal.proposalId;
      fund.status = 'pending_approval';
      fund.route = proposal.chosenRoute || proposal.route;
    } else if (strategy === 'onramp') {
      if (!OnOffRampEngine) throw new Error('OnOffRampEngine not available');
      const quote = await OnOffRampEngine.quote({
        direction: 'onramp',
        sourceAsset: 'USD',
        targetAsset: fund.targetAsset,
        amount: String(amountNum),
        sourceType: 'trust',
        sourceAccountId: accountCode,
        targetAddress: getOperatorAddress(),
      });
      const provider = quote.recommended?.provider || (quote.routes && quote.routes[0] && quote.routes[0].provider) || null;
      if (!provider) throw new Error('No on-ramp provider available for this fiat-to-stablecoin conversion');
      const proposal = await OnOffRampEngine.propose({
        direction: 'onramp',
        sourceAsset: 'USD',
        targetAsset: fund.targetAsset,
        amount: String(amountNum),
        provider,
        sourceType: 'trust',
        sourceAccountId: accountCode,
        targetAddress: getOperatorAddress(),
        createdBy,
      });
      fund.proposalId = proposal.proposalId;
      fund.rampProvider = provider;
      fund.rampQuote = quote;
      fund.status = 'pending_approval';
    } else if (strategy === 'seed_pool') {
      if (!CanonicalConsensusEngine) throw new Error('CanonicalConsensusEngine not available');
      const proposal = await CanonicalConsensusEngine.createProposal({
        category: 'capital_fund',
        title: `Seed ${fund.targetAsset} pool from capital fund ${id}`,
        description: `Mint DLBUSD and seed a ${fund.targetAsset} liquidity pool`,
        payload: { fundId: id, action: 'seed_pool' },
        createdBy,
      });
      fund.proposalId = proposal.id;
      fund.status = 'pending_approval';
    } else {
      throw new Error(`Unknown capital fund strategy: ${strategy}`);
    }

    const state = loadState();
    state.funds = [fund, ...(state.funds || [])];
    saveState(state);
    return fund;
  }

  static async approveFund({ fundId, role, approverEmail }) {
    if (!CanonicalConsensusEngine) throw new Error('CanonicalConsensusEngine not available');
    const state = loadState();
    const fund = (state.funds || []).find(f => f.id === fundId);
    if (!fund) throw new Error(`Fund not found: ${fundId}`);
    if (!fund.proposalId) throw new Error('Fund has no proposal to approve');

    const proposal = await CanonicalConsensusEngine.approveProposal({ proposalId: fund.proposalId, role, approverEmail });
    const result = proposal.result || {};

    if (proposal.status === 'executed') {
      if (fund.strategy === 'p2p_sell') {
        fund.status = 'awaiting_buyer';
        fund.orderId = result.orderId ? String(result.orderId) : null;
        fund.canonicalTxHash = result.txHash || result.mintTxHash || null;
      } else if (fund.strategy === 'onramp') {
        if (result.status === 'awaiting_onramp' || result.onrampUrl || result.status === 'needs_recipient_setup' || result.status === 'awaiting_funds') {
          fund.status = 'awaiting_onramp';
          fund.onrampResult = result;
        } else {
          fund.status = 'completed';
          fund.canonicalAmount = result.amount || result.targetAmount || null;
          fund.canonicalTxHash = result.txHash || null;
        }
      } else if (fund.strategy === 'seed_pool') {
        fund.status = result.status || 'completed';
        fund.poolAddress = result.poolAddress || null;
        fund.canonicalTxHash = result.txHash || result.canonicalTxHash || null;
        fund.canonicalAmount = result.canonicalAmount || null;
      }
    } else {
      fund.status = 'approved';
    }

    fund.updatedAt = new Date().toISOString();
    saveState(state);
    return fund;
  }

  static async executeFund(fundId) {
    const state = loadState();
    const fund = (state.funds || []).find(f => f.id === fundId);
    if (!fund) throw new Error(`Fund not found: ${fundId}`);

    if (fund.strategy === 'p2p_sell') {
      if (!CrossChainConversionEngine || !fund.requestId) throw new Error('Cross-chain request not available');
      const req = await CrossChainConversionEngine.getRequest(fund.requestId);
      if (!req) throw new Error('Cross-chain request not found');
      if (req.status === 'executed' || req.status === 'awaiting_buyer') {
        const result = req.result || {};
        fund.status = 'awaiting_buyer';
        fund.orderId = result.orderId ? String(result.orderId) : null;
        fund.canonicalTxHash = result.txHash || result.mintTxHash || null;
      } else if (req.status === 'failed') {
        fund.status = 'failed';
      } else {
        const result = await CrossChainConversionEngine.executeRequest(fund.requestId);
        fund.status = 'awaiting_buyer';
        fund.orderId = result.orderId ? String(result.orderId) : null;
        fund.canonicalTxHash = result.txHash || result.mintTxHash || null;
      }
    } else if (fund.strategy === 'onramp') {
      if (!CanonicalConsensusEngine || !fund.proposalId) throw new Error('Proposal not available');
      const proposal = await CanonicalConsensusEngine.executeProposal(fund.proposalId);
      const result = proposal.result || {};
      if (result.status === 'awaiting_onramp' || result.onrampUrl || result.status === 'needs_recipient_setup' || result.status === 'awaiting_funds') {
        fund.status = 'awaiting_onramp';
        fund.onrampResult = result;
      } else {
        fund.status = 'completed';
        fund.canonicalAmount = result.amount || result.targetAmount || null;
        fund.canonicalTxHash = result.txHash || null;
      }
    } else if (fund.strategy === 'seed_pool') {
      return this._seedPool(fund, state);
    }

    fund.updatedAt = new Date().toISOString();
    saveState(state);
    return fund;
  }

  static async _seedPool(fund, stateRef) {
    if (!StablecoinDexEngine || !DexSwapEngine) throw new Error('StablecoinDexEngine or DexSwapEngine not available');
    const operator = getOperatorAddress();
    if (!operator) throw new Error('DAPP_OPERATOR_ADDRESS not configured');

    const token = await StablecoinDexEngine.getOrCreateDLBUSDToken();
    const targetAddress = targetAddressFor(fund.targetAsset);
    if (!targetAddress) throw new Error(`Target asset ${fund.targetAsset} has no configured token address`);

    const half = round2(fund.amount / 2);
    const mint = await StablecoinDexEngine.mintFromSource({ sourceType: 'trust', sourceAccountId: fund.accountCode, amount: half, targetAddress: operator });
    const poolResult = await DexSwapEngine.createPool({
      tokenA: token.token_address,
      tokenB: targetAddress,
      amountA: half,
      amountB: half,
      decimalsA: 6,
      decimalsB: targetDecimalsFor(fund.targetAsset),
    });

    fund.poolAddress = poolResult.poolAddress;
    fund.canonicalTxHash = poolResult.txHash;
    fund.status = 'completed';
    fund.canonicalAmount = half;

    const state = stateRef || loadState();
    const idx = (state.funds || []).findIndex(f => f.id === fund.id);
    if (idx >= 0) state.funds[idx] = fund;
    saveState(state);
    return fund;
  }

  static async syncFund(fundId) {
    const state = loadState();
    const fund = (state.funds || []).find(f => f.id === fundId);
    if (!fund) throw new Error(`Fund not found: ${fundId}`);

    if (fund.strategy === 'onramp' && (fund.status === 'awaiting_onramp' || fund.status === 'allocating')) {
      const targetAddress = targetAddressFor(fund.targetAsset);
      if (targetAddress) {
        const balance = await getTokenBalance(targetAddress, getOperatorAddress());
        if (balance >= round2(fund.amount * 0.99)) {
          fund.depositedAmount = balance;
          if (fund.targetAllocation === 'seed_pool') {
            await this._seedPool({ ...fund, amount: balance }, state);
          } else if (fund.targetAllocation === 'p2p_buy') {
            await this._p2pBuy({ ...fund, amount: balance }, state);
          } else {
            fund.status = 'completed';
            fund.canonicalAmount = balance;
          }
        }
      }
    }

    if (fund.strategy === 'p2p_sell' && fund.status === 'awaiting_buyer') {
      if (CrossChainConversionEngine && fund.requestId) {
        const req = await CrossChainConversionEngine.getRequest(fund.requestId);
        if (req && req.status === 'executed') {
          const result = req.result || {};
          fund.status = 'completed';
          fund.canonicalAmount = result.amountOut || result.actualAmountOut || null;
          fund.canonicalTxHash = result.swapTxHash || result.txHash || result.fillHash || null;
        }
      }
    }

    fund.updatedAt = new Date().toISOString();
    saveState(state);
    return fund;
  }

  static async _p2pBuy(fund, stateRef) {
    if (!ModuleP2PSwapEngine) throw new Error('ModuleP2PSwapEngine not available');
    const token = StablecoinDexEngine ? await StablecoinDexEngine.getOrCreateDLBUSDToken() : { token_address: process.env.DAPP_DLBUSD_ADDRESS || '' };
    const targetAddress = targetAddressFor(fund.targetAsset);
    const amount = round2(fund.amount || fund.depositedAmount || 0);
    if (!token.token_address || !targetAddress) throw new Error('DLBUSD or target asset address not configured');
    const order = await ModuleP2PSwapEngine.createOrder({
      tokenIn: targetAddress,
      amountIn: amount,
      tokenOut: token.token_address,
      amountOut: amount,
      recipient: getOperatorAddress(),
    });
    fund.orderId = order && order.orderId ? String(order.orderId) : null;
    fund.canonicalTxHash = order && order.txHash ? order.txHash : null;
    fund.status = 'awaiting_seller';
    const state = stateRef || loadState();
    const idx = (state.funds || []).findIndex(f => f.id === fund.id);
    if (idx >= 0) state.funds[idx] = fund;
    saveState(state);
    return fund;
  }

  static async getFundDetail(fundId) {
    const fund = this.getFund(fundId);
    if (!fund) return null;
    return this.syncFund(fundId);
  }
}

module.exports = { CapitalFundEngine };
