'use strict';

/**
 * Treasury On-Ramp Bridge Engine
 *
 * Brings real canonical stablecoins on-chain from trust-managed fiat reserves,
 * then redeems trust-issued internal tokens (DLBUSD / DLB-PTCUSD) 1:1 against
 * the canonical asset. This closes the canonical-asset gap without relying on
 * an external buyer: the trust wires/on-ramps fiat, receives DAI/USDC, and
 * retires internal tokens in exchange at 1:1.
 *
 * Supported on-ramp sources:
 *  - core_banking_wire  -> Wire fiat from core banking to an on-ramp bank account
 *  - circle_mint        -> Use Circle Mint USD balance to on-chain transfer USDC
 *  - coinbase_treasury  -> Stage a fiat deposit from a ledger source via Coinbase
 *  - moonpay            -> MoonPay widget on-ramp
 *  - manual             -> Instructions for an external manual deposit
 */

const { getConfig } = require('./config');

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { /* optional */ }

let SourceOfFundsAdapter;
try { ({ SourceOfFundsAdapter } = require('../stablecoin/sourceOfFundsAdapter')); } catch (e) {}

let TrustAccountingEngine;
try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) {}

let CashEngine;
try { ({ CashEngine } = require('../cash/cashEngine')); } catch (e) {}

let TreasuryEngine;
try { ({ TreasuryEngine } = require('../stablecoin/treasuryEngine')); } catch (e) {}

let FineractClient;
try { ({ FineractClient } = require('../fineract/fineractClient')); } catch (e) {}

let StablecoinDexEngine;
try { ({ StablecoinDexEngine } = require('./stablecoinDexEngine')); } catch (e) {}

let PtcStablecoinEngine;
try { ({ PtcStablecoinEngine } = require('./ptcStablecoinEngine')); } catch (e) {}

let DexAggregatorEngine;
try { ({ DexAggregatorEngine } = require('./dexAggregatorEngine')); } catch (e) {}

let UniswapV3Engine;
try { ({ UniswapV3Engine } = require('./uniswapV3Engine')); } catch (e) {}

let DexSwapEngine;
try { ({ DexSwapEngine } = require('./dexSwapEngine')); } catch (e) {}

let WireOriginationEngine;
try { ({ WireOriginationEngine } = require('./wireOriginationEngine')); } catch (e) {}

let CoinbaseTreasuryBridge;
try { ({ CoinbaseTreasuryBridge } = require('./coinbaseTreasuryBridge')); } catch (e) {}

let MoonPayEngine;
try { ({ MoonPayEngine } = require('./moonPayEngine')); } catch (e) {}

let CircleMintClient;
try { ({ CircleMintClient } = require('../stablecoin/circleMintClient')); } catch (e) {}

let viem;
try { viem = require('viem'); } catch (e) {}

const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD';

function safeJson(obj) {
  return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v);
}

function id(prefix = 'TORB') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

function queryFn(sql, params) {
  if (!pool || !pool.query) throw new Error('Postgres pool unavailable');
  return pool.query(sql, params);
}

function canonicalConsensusEngine() {
  try { return require('./canonicalConsensusEngine').CanonicalConsensusEngine; } catch (e) { return null; }
}

const erc20Abi = [
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
];

const SOURCE_METHODS = {
  manual: { name: 'Manual deposit', note: 'Deposit the paired canonical asset directly to the operator wallet.' },
  circle_mint: { name: 'Circle Mint on-ramp', note: 'Use Circle Mint business USD balance to transfer USDC to the operator wallet.' },
  coinbase_treasury: { name: 'Coinbase Treasury Bridge', note: 'Stage a fiat deposit from a ledger source through Coinbase, then buy and send crypto.' },
  moonpay: { name: 'MoonPay on-ramp', note: 'Generate a MoonPay widget URL to buy crypto into the operator wallet.' },
  core_banking_wire: { name: 'Core-banking wire', note: 'Generate a wire/ACH payout from a core-banking cash account to the on-ramp bank account.' },
};

class TreasuryOnRampBridgeEngine {
  static get config() { return getConfig(); }

  static getConfig() {
    const cfg = this.config;
    return {
      enabled: (process.env.TREASURY_ON_RAMP_ENABLED || 'true') !== 'false',
      shadow: cfg.dappShadow !== false ? true : cfg.dappShadow,
      chainId: cfg.chainId,
      rpcUrl: cfg.rpcUrl,
      privateKey: cfg.privateKey,
      operatorAddress: cfg.operatorAddress,
      usdcAddress: cfg.usdcAddress,
      daiAddress: cfg.daiAddress,
      usdsAddress: cfg.usdsAddress,
      wethAddress: cfg.wethAddress,
      circleMintApiKey: process.env.CIRCLE_MINT_API_KEY || cfg.circleMintApiKey || '',
      onRampFeeBps: Number(process.env.TREASURY_ON_RAMP_FEE_BPS || '0') || 0,
      wireBeneficiary: {
        name: process.env.TREASURY_ON_RAMP_BANK_NAME || 'Circle Internet Financial',
        routing: process.env.TREASURY_ON_RAMP_BANK_ROUTING || '',
        account: process.env.TREASURY_ON_RAMP_BANK_ACCOUNT || '',
      },
    };
  }

  static async ensureTables() {
    await queryFn(`
      CREATE TABLE IF NOT EXISTS treasury_on_ramp_operations (
        id                TEXT PRIMARY KEY,
        proposal_id       TEXT,
        source_type       TEXT,
        source_account_id TEXT,
        source_method     TEXT NOT NULL DEFAULT 'manual',
        amount            NUMERIC(24,6) NOT NULL DEFAULT 0,
        on_ramp_amount    NUMERIC(24,6) NOT NULL DEFAULT 0,
        internal_asset    TEXT,
        internal_amount   NUMERIC(24,6),
        target_asset      TEXT NOT NULL DEFAULT 'DAI',
        recipient         TEXT,
        status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','quoted','source_reserved','wire_pending','fiat_received','canonical_received','swapped','redeemed','completed','failed','needs_deposit','needs_config')),
        stage             TEXT NOT NULL DEFAULT 'on_ramp',
        result            JSONB DEFAULT '{}',
        error             TEXT,
        metadata          JSONB DEFAULT '{}',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryFn(`CREATE INDEX IF NOT EXISTS idx_treasury_on_ramp_status ON treasury_on_ramp_operations(status)`);
  }

  static async _resolveToken(token) {
    const cfg = this.getConfig();
    const t = String(token || '').toUpperCase();
    if (t === 'DLBUSD') {
      let address = '';
      if (StablecoinDexEngine) {
        try { const tk = await StablecoinDexEngine.getOrCreateDLBUSDToken(); address = tk && tk.token_address; } catch (e) {}
      }
      if (!address) address = process.env.DLBUSD_ADDRESS || '';
      return { address, decimals: 6 };
    }
    if (t === 'DLB-PTCUSD' || t === 'PTC') {
      let address = process.env.DLB_PTCUSD_ADDRESS || cfg.dlbPTCUSDAddress || '';
      if (!address && PtcStablecoinEngine) {
        try { const info = await PtcStablecoinEngine.info(); address = info.tokenAddress || ''; } catch (e) {}
      }
      return { address, decimals: 18 };
    }
    if (t === 'USDS') return { address: cfg.usdsAddress || '', decimals: 18 };
    if (t === 'USDC') return { address: cfg.usdcAddress || '', decimals: 6 };
    if (t === 'DAI') return { address: cfg.daiAddress || '', decimals: 18 };
    if (t === 'WETH' || t === 'ETH') return { address: cfg.wethAddress || '', decimals: 18 };
    return { address: token, decimals: 18 };
  }

  static async _operatorBalance(tokenAddress, decimals = 18) {
    if (!viem || !tokenAddress) return { raw: 0n, formatted: '0', decimals };
    const cfg = this.getConfig();
    const { mainnet, sepolia } = require('viem/chains');
    const chain = cfg.chainId === 11155111 ? sepolia : mainnet;
    const publicClient = viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) });
    try {
      const raw = await publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [cfg.operatorAddress] });
      return { raw, formatted: viem.formatUnits(raw, decimals), decimals };
    } catch (e) { return { raw: 0n, formatted: '0', decimals }; }
  }

  static async _sourceBalance(sourceType, sourceAccountId) {
    if (!sourceAccountId) return null;
    const isAccountCode = /^\d+$/.test(String(sourceAccountId));
    let balanceCents = null;
    if (SourceOfFundsAdapter) {
      try { balanceCents = await SourceOfFundsAdapter.getBalance({ sourceType, sourceAccountId }); } catch (e) {}
    }
    if (balanceCents && balanceCents > 0) return balanceCents;

    // Fall back to the canonical financial engines the user has designated as truth of source.
    if (isAccountCode && TrustAccountingEngine) {
      try {
        const acct = await TrustAccountingEngine.getAccount(sourceAccountId);
        if (acct && acct.balance != null) return toCents(acct.balance);
      } catch (e) {}
    }
    if (sourceType === 'cash' && CashEngine) {
      try {
        const acct = await CashEngine.getAccount(sourceAccountId);
        if (acct && acct.balance_cents != null) return Number(acct.balance_cents);
      } catch (e) {}
    }
    if (sourceType === 'treasury' && TreasuryEngine) {
      try {
        const pos = await TreasuryEngine.getPosition(sourceAccountId);
        if (pos && pos.availableCents != null) return Number(pos.availableCents);
      } catch (e) {}
    }
    if (sourceType === 'fineract' && FineractClient) {
      try {
        const acct = await FineractClient.getAccountBalance(sourceAccountId);
        const balance = (acct && acct.summary && (acct.summary.availableBalance != null ? acct.summary.availableBalance : acct.summary.accountBalance)) || 0;
        if (balance) return toCents(Number(balance));
      } catch (e) {}
    }
    return balanceCents;
  }

  static async _onRampReadiness(method) {
    const cfg = this.getConfig();
    const base = { method, ...SOURCE_METHODS[method], ready: false, issues: [] };
    if (method === 'manual') return { ...base, ready: true };
    if (method === 'moonpay') {
      const r = MoonPayEngine ? MoonPayEngine.readiness() : { issues: ['MoonPayEngine not available'] };
      return { ...base, ready: r.ready, issues: r.issues || [] };
    }
    if (method === 'circle_mint') {
      const ready = !!cfg.circleMintApiKey;
      return { ...base, ready, issues: ready ? [] : ['CIRCLE_MINT_API_KEY not configured'] };
    }
    if (method === 'coinbase_treasury') {
      const enabled = CoinbaseTreasuryBridge ? CoinbaseTreasuryBridge.enabled() : false;
      return { ...base, ready: enabled, issues: enabled ? [] : ['Coinbase Treasury Bridge not enabled'] };
    }
    if (method === 'core_banking_wire') {
      const ready = !!WireOriginationEngine;
      return { ...base, ready, issues: ready ? [] : ['WireOriginationEngine not available'] };
    }
    return { ...base, issues: ['Unknown source method'] };
  }

  static async quote({
    sourceType = '',
    sourceAccountId = '',
    amount = '0',
    internalAsset = 'DLBUSD',
    internalAmount,
    targetAsset = 'DAI',
    sourceMethod = 'core_banking_wire',
    onRampBankDetails = {},
  } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw new Error('Treasury On-Ramp Bridge is not enabled');
    const amountNum = Number(amount);
    if (!amountNum || amountNum <= 0) throw new Error('amount must be positive');

    const sourceBalanceCents = await this._sourceBalance(sourceType, sourceAccountId);
    const internal = await this._resolveToken(internalAsset);
    const target = await this._resolveToken(targetAsset);
    const onRampReady = await this._onRampReadiness(sourceMethod);
    const feeBps = cfg.onRampFeeBps;
    const onRampAmount = amountNum * (1 - feeBps / 10000);
    const targetBal = await this._operatorBalance(target.address, target.decimals);
    const internalBal = await this._operatorBalance(internal.address, internal.decimals);
    const needInternal = Number(internalAmount || amount);

    let status = 'needs_config';
    if (!onRampReady.ready) status = 'needs_config';
    else if (sourceMethod === 'manual') status = 'awaiting_deposit';
    else if (sourceMethod === 'core_banking_wire') status = 'wire_pending';
    else if (sourceBalanceCents !== null && sourceBalanceCents < toCents(amountNum)) status = 'insufficient_source';
    else if (sourceMethod === 'circle_mint') status = 'ready';
    else if (sourceMethod === 'coinbase_treasury') status = 'pending';
    else if (sourceMethod === 'moonpay') status = 'awaiting_onramp';

    const instructions = this._buildInstructions({ sourceMethod, targetAsset, amount: amountNum, onRampAmount, onRampBankDetails, cfg });

    return {
      sourceType,
      sourceAccountId,
      amount: amountNum,
      onRampAmount,
      internalAsset,
      internalAmount: needInternal,
      targetAsset,
      operatorTargetBalance: targetBal.formatted,
      operatorInternalBalance: internalBal.formatted,
      sourceBalanceCents,
      feeBps,
      onRampReady,
      status,
      instructions,
    };
  }

  static _buildInstructions({ sourceMethod, targetAsset, amount, onRampAmount, onRampBankDetails, cfg }) {
    const targetUpper = String(targetAsset).toUpperCase();
    if (sourceMethod === 'manual') return `Deposit ${onRampAmount.toFixed(2)} ${targetUpper} to operator wallet ${cfg.operatorAddress}.`;
    if (sourceMethod === 'moonpay') {
      const url = MoonPayEngine ? MoonPayEngine.buildUrl({ currencyCode: targetUpper.toLowerCase(), walletAddress: cfg.operatorAddress, amount: String(amount) }) : '';
      return { message: `Complete MoonPay on-ramp for ${onRampAmount.toFixed(2)} ${targetUpper}.`, onrampUrl: url };
    }
    if (sourceMethod === 'circle_mint') return `Use Circle Mint to transfer ${onRampAmount.toFixed(2)} USDC to ${cfg.operatorAddress}; then swap USDC -> ${targetUpper} if needed.`;
    if (sourceMethod === 'coinbase_treasury') return `Stage ${amount.toFixed(2)} USD from source ledger through Coinbase Treasury Bridge, buy ${targetUpper}, and send to ${cfg.operatorAddress}.`;
    if (sourceMethod === 'core_banking_wire') {
      const bank = onRampBankDetails.name || cfg.wireBeneficiary.name || 'on-ramp bank';
      return `Originate a wire/ACH of ${amount.toFixed(2)} USD from core-banking source to ${bank} account (routing: ${onRampBankDetails.routing || cfg.wireBeneficiary.routing || 'TBD'}, account: ${onRampBankDetails.account || cfg.wireBeneficiary.account || 'TBD'}). Once the on-ramp credits the wallet, call continue/execute to swap to ${targetUpper} and redeem internal tokens.`;
    }
    return 'Unknown source method.';
  }

  static async propose({
    sourceType = '',
    sourceAccountId = '',
    amount = '0',
    internalAsset = 'DLBUSD',
    internalAmount,
    targetAsset = 'DAI',
    sourceMethod = 'core_banking_wire',
    recipient = '',
    onRampBankDetails = {},
    createdBy = 'operator',
  } = {}) {
    await this.ensureTables();
    const q = await this.quote({ sourceType, sourceAccountId, amount, internalAsset, internalAmount, targetAsset, sourceMethod, onRampBankDetails });
    const operationId = id('TORB-OP');
    const CCE = canonicalConsensusEngine();
    if (!CCE) throw new Error('CanonicalConsensusEngine not available');

    const proposal = await CCE.createProposal({
      category: 'treasury_on_ramp',
      title: `Treasury on-ramp: ${amount} USD -> ${targetAsset} and redeem ${internalAmount || amount} ${internalAsset}`,
      description: `Bridge fiat from ${sourceType}:${sourceAccountId} via ${sourceMethod}, convert to ${targetAsset}, and retire internal tokens 1:1.`,
      payload: {
        operationId,
        sourceType,
        sourceAccountId,
        amount: Number(amount),
        internalAsset,
        internalAmount: Number(internalAmount || amount),
        targetAsset,
        sourceMethod,
        recipient: recipient || this.getConfig().operatorAddress,
        onRampBankDetails,
        quote: q,
      },
      createdBy,
    });

    await queryFn(
      `INSERT INTO treasury_on_ramp_operations (id, proposal_id, source_type, source_account_id, source_method, amount, on_ramp_amount, internal_asset, internal_amount, target_asset, recipient, status, stage, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [operationId, proposal.id, sourceType, sourceAccountId, sourceMethod, Number(amount), q.onRampAmount, internalAsset, Number(internalAmount || amount), targetAsset, recipient || this.getConfig().operatorAddress, q.status, 'on_ramp', safeJson({ quote: q, onRampBankDetails, createdBy })]
    );

    return { operationId, proposalId: proposal.id, quote: q, proposal };
  }

  static _rowToCamel(r) {
    const out = {};
    for (const key of Object.keys(r)) {
      const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      out[camel] = r[key];
    }
    return out;
  }

  static _parseRow(r) {
    const row = this._rowToCamel(r);
    if (typeof row.result === 'string') row.result = JSON.parse(row.result);
    if (typeof row.metadata === 'string') row.metadata = JSON.parse(row.metadata);
    return row;
  }

  static async getOperation(operationId) {
    await this.ensureTables();
    const rows = await queryFn('SELECT * FROM treasury_on_ramp_operations WHERE id = $1', [operationId]);
    if (!rows.rows.length) return null;
    return this._parseRow(rows.rows[0]);
  }

  static async listOperations({ status, limit = 50, offset = 0 } = {}) {
    await this.ensureTables();
    let sql = 'SELECT * FROM treasury_on_ramp_operations';
    const params = [];
    if (status) { sql += ' WHERE status = $1'; params.push(status); }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
    const rows = await queryFn(sql, params);
    return rows.rows.map(r => this._parseRow(r));
  }

  static async approve({ proposalId, role, approverEmail }) {
    const CCE = canonicalConsensusEngine();
    if (!CCE) throw new Error('CanonicalConsensusEngine not available');
    return CCE.approveProposal({ proposalId, role, approverEmail });
  }

  static async executeOperation(operationId, { autoContinue = false } = {}) {
    const op = await this.getOperation(operationId);
    if (!op) throw new Error('Operation not found');
    const CCE = canonicalConsensusEngine();
    if (!CCE) throw new Error('CanonicalConsensusEngine not available');
    const proposal = await CCE.getProposal(op.proposalId);
    if (!proposal) throw new Error('Proposal not found');
    if (proposal.status !== 'approved' && proposal.status !== 'pending') throw new Error(`Proposal status ${proposal.status} cannot be executed`);
    return CCE.executeProposal(proposal.id);
  }

  static async _execute(proposal) {
    const { payload } = proposal;
    const {
      operationId,
      sourceType,
      sourceAccountId,
      amount,
      internalAsset,
      internalAmount,
      targetAsset,
      sourceMethod,
      recipient,
      onRampBankDetails = {},
    } = payload || {};

    if (!operationId) throw new Error('operationId missing from payload');
    const op = await this.getOperation(operationId);
    if (!op) throw new Error('Operation not found');

    try {
      const result = await this._continue(op, onRampBankDetails);
      await queryFn(`UPDATE treasury_on_ramp_operations SET status=$1, result=$2, updated_at=NOW() WHERE id=$3`, [result.status, safeJson(result), operationId]);
      return result;
    } catch (err) {
      await queryFn(`UPDATE treasury_on_ramp_operations SET status='failed', error=$1, result=$2, updated_at=NOW() WHERE id=$3`, [err.message, safeJson({ error: err.message }), operationId]);
      throw err;
    }
  }

  static async _continue(op, onRampBankDetails) {
    const stage = op.stage || 'on_ramp';
    if (stage === 'on_ramp') return this._stageOnRamp(op, onRampBankDetails);
    if (stage === 'canonical_swap') return this._swapToTarget(op);
    if (stage === 'redeem') return this._redeemInternal(op);
    throw new Error(`Unknown stage: ${stage}`);
  }

  static async _stageOnRamp(op, onRampBankDetails) {
    const cfg = this.getConfig();
    const { sourceMethod, sourceType, sourceAccountId, amount, targetAsset } = op;

    if (sourceMethod === 'manual') {
      return { operationId: op.id, stage: 'on_ramp', status: 'awaiting_deposit', instructions: `Deposit ${amount} ${targetAsset.toUpperCase()} to operator wallet ${cfg.operatorAddress}.` };
    }

    if (sourceMethod === 'moonpay') {
      const url = MoonPayEngine ? MoonPayEngine.buildUrl({ currencyCode: String(targetAsset).toLowerCase(), walletAddress: cfg.operatorAddress, amount: String(amount) }) : '';
      return { operationId: op.id, stage: 'on_ramp', status: 'awaiting_onramp', onrampUrl: url, instructions: 'Complete MoonPay widget. Once funds arrive, continue the operation.' };
    }

    if (sourceMethod === 'core_banking_wire') {
      const instructions = this._buildInstructions({ sourceMethod, targetAsset, amount: Number(amount), onRampAmount: Number(amount), onRampBankDetails, cfg });
      try {
        if (!WireOriginationEngine) throw new Error('WireOriginationEngine not available');
        const wire = await WireOriginationEngine.createPayout({
          sourceType,
          sourceAccountId,
          amount,
          beneficiaryName: (onRampBankDetails && onRampBankDetails.name) || cfg.wireBeneficiary.name,
          beneficiaryRouting: (onRampBankDetails && onRampBankDetails.routing) || cfg.wireBeneficiary.routing,
          beneficiaryAccount: (onRampBankDetails && onRampBankDetails.account) || cfg.wireBeneficiary.account,
          beneficiaryBankName: (onRampBankDetails && onRampBankDetails.bankName) || '',
          paymentType: 'vendor_payment',
          purpose: `Treasury on-ramp to ${targetAsset}`,
          description: `Bridge ${amount} USD from core banking to on-ramp for canonical stablecoin`,
          adapter: 'wire',
          initiatedBy: 'treasury-on-ramp',
        });
        await queryFn(`UPDATE treasury_on_ramp_operations SET stage='canonical_swap', status='wire_pending', metadata=jsonb_set(metadata, '{wire}', $1::jsonb) WHERE id=$2`, [safeJson(wire), op.id]);
        return { operationId: op.id, stage: 'canonical_swap', status: 'wire_pending', wire, instructions: 'Wire originated. Once the on-ramp credits the operator wallet, call continue/execute to swap and redeem.' };
      } catch (err) {
        await queryFn(`UPDATE treasury_on_ramp_operations SET stage='canonical_swap', status='wire_pending', error=$1, metadata=jsonb_set(metadata, '{wireError}', $2::jsonb) WHERE id=$3`, [err.message, safeJson({ message: err.message }), op.id]);
        return { operationId: op.id, stage: 'canonical_swap', status: 'wire_pending', error: err.message, instructions };
      }
    }

    if (sourceMethod === 'coinbase_treasury') {
      if (!CoinbaseTreasuryBridge) throw new Error('CoinbaseTreasuryBridge not available');
      const transfer = await CoinbaseTreasuryBridge.stageFromSource({
        sourceType,
        sourceAccountId,
        amount,
        targetAsset,
        targetNetwork: 'ethereum',
        targetAddress: cfg.operatorAddress,
      });
      const newStatus = transfer.status || 'pending';
      await queryFn(`UPDATE treasury_on_ramp_operations SET stage='canonical_swap', status=$1, metadata=jsonb_set(metadata, '{coinbaseTransfer}', $2::jsonb) WHERE id=$3`, [newStatus, safeJson(transfer), op.id]);
      return { operationId: op.id, stage: 'canonical_swap', status: newStatus, transfer, instructions: 'Coinbase treasury transfer staged. Continue once USD settles and crypto is delivered.' };
    }

    if (sourceMethod === 'circle_mint') {
      if (!cfg.circleMintApiKey) throw new Error('CIRCLE_MINT_API_KEY not configured');
      if (!CircleMintClient) throw new Error('CircleMintClient not available');
      const client = new CircleMintClient({ apiKey: cfg.circleMintApiKey, baseUrl: process.env.CIRCLE_MINT_BASE_URL });
      const balances = await client.getBalances().catch(e => { throw new Error(`Circle Mint balance check failed: ${e.message}`); });
      const usd = balances && balances.data && balances.data.find(b => b.currency === 'USD' || b.currency === 'USDC');
      const available = usd ? Number(usd.availableAmount) : 0;
      if (available < Number(amount)) {
        return { operationId: op.id, stage: 'on_ramp', status: 'needs_deposit', available, needed: amount, instructions: `Wire USD to Circle Mint. Current available: ${available} USD.` };
      }
      // Need verified recipient address id; if not configured, return instructions.
      const recipientAddressId = process.env.CIRCLE_MINT_OPERATOR_RECIPIENT_ID;
      if (!recipientAddressId) {
        return { operationId: op.id, stage: 'on_ramp', status: 'needs_recipient_setup', instructions: `Create a verified Circle Mint recipient address for ${cfg.operatorAddress} and set CIRCLE_MINT_OPERATOR_RECIPIENT_ID, then retry.` };
      }
      const tx = await client.createTransfer({ destinationAddressId: recipientAddressId, amount, currency: 'USD' });
      await queryFn(`UPDATE treasury_on_ramp_operations SET stage='canonical_swap', status='pending', metadata=jsonb_set(metadata, '{circleTransfer}', $1::jsonb) WHERE id=$2`, [safeJson(tx), op.id]);
      return { operationId: op.id, stage: 'canonical_swap', status: 'pending', transfer: tx, instructions: 'Circle Mint transfer initiated. Continue once it settles on-chain.' };
    }

    throw new Error(`Source method ${sourceMethod} not implemented`);
  }

  static async _swapToTarget(op) {
    const cfg = this.getConfig();
    const { targetAsset, amount } = op;
    const onRampAmount = Number(op.on_ramp_amount || amount);
    const usdc = await this._resolveToken('USDC');
    const target = await this._resolveToken(targetAsset);
    const targetBal = await this._operatorBalance(target.address, target.decimals);
    const usdcBal = await this._operatorBalance(usdc.address, usdc.decimals);

    // If we already have the target asset, skip swap.
    if (String(targetAsset).toUpperCase() === 'USDC' || Number(targetBal.formatted) >= onRampAmount * 0.999) {
      await queryFn(`UPDATE treasury_on_ramp_operations SET stage='redeem', status='canonical_received' WHERE id=$1`, [op.id]);
      return { operationId: op.id, stage: 'redeem', status: 'canonical_received', targetBalance: targetBal.formatted, instructions: 'Canonical asset in wallet. Continue to redeem internal tokens.' };
    }

    if (Number(usdcBal.formatted) >= onRampAmount * 0.999) {
      // Swap USDC -> target via DEX aggregator or Uniswap V3
      let swap = null;
      if (DexAggregatorEngine) {
        swap = await DexAggregatorEngine.swap({ tokenIn: usdc.address, tokenOut: target.address, amountIn: String(onRampAmount), decimalsIn: usdc.decimals, decimalsOut: target.decimals, recipient: cfg.operatorAddress }).catch(() => null);
      }
      if (!swap && UniswapV3Engine) {
        swap = await UniswapV3Engine.swap({ tokenIn: usdc.address, tokenOut: target.address, amountIn: String(onRampAmount), decimalsIn: usdc.decimals, decimalsOut: target.decimals, recipient: cfg.operatorAddress }).catch(() => null);
      }
      if (!swap) throw new Error('No DEX engine available to swap USDC to target asset');
      await queryFn(`UPDATE treasury_on_ramp_operations SET stage='redeem', status='canonical_received', result=jsonb_set(COALESCE(result,'{}'::jsonb), '{swap}', $1::jsonb) WHERE id=$2`, [safeJson(swap), op.id]);
      return { operationId: op.id, stage: 'redeem', status: 'canonical_received', swap, instructions: 'USDC swapped to target asset. Continue to redeem internal tokens.' };
    }

    return { operationId: op.id, stage: 'canonical_swap', status: 'awaiting_canonical', instructions: `Waiting for ${onRampAmount} USDC or ${targetAsset} to arrive in operator wallet ${cfg.operatorAddress}.` };
  }

  static async _redeemInternal(op) {
    const cfg = this.getConfig();
    const { internalAsset, internalAmount, targetAsset, recipient } = op;
    const target = await this._resolveToken(targetAsset);
    const internal = await this._resolveToken(internalAsset);
    const amountInternal = Number(internalAmount || op.amount);
    const amountCanonical = amountInternal; // 1:1 redemption
    const to = recipient || cfg.operatorAddress;

    const internalBal = await this._operatorBalance(internal.address, internal.decimals);
    const rawInternal = viem.parseUnits(String(amountInternal), internal.decimals);
    if (internalBal.raw < rawInternal) throw new Error(`Insufficient ${internalAsset} balance for redemption: ${internalBal.formatted} < ${amountInternal}. Mint or acquire internal tokens first.`);

    const targetBal = await this._operatorBalance(target.address, target.decimals);
    const rawCanonical = viem.parseUnits(String(amountCanonical), target.decimals);
    if (targetBal.raw < rawCanonical) throw new Error(`Insufficient ${targetAsset} balance for redemption: ${targetBal.formatted} < ${amountCanonical}. Deposit canonical funds first.`);

    if (cfg.shadow) {
      await queryFn(`UPDATE treasury_on_ramp_operations SET stage='completed', status='completed' WHERE id=$1`, [op.id]);
      return { operationId: op.id, stage: 'completed', status: 'completed', mode: 'shadow', burned: amountInternal, sent: amountCanonical, to };
    }

    if (!cfg.privateKey) throw new Error('DAPP_PRIVATE_KEY not configured');
    const { mainnet, sepolia } = require('viem/chains');
    const chain = cfg.chainId === 11155111 ? sepolia : mainnet;
    const { privateKeyToAccount } = require('viem/accounts');
    const account = privateKeyToAccount(cfg.privateKey.startsWith('0x') ? cfg.privateKey : `0x${cfg.privateKey}`);
    const fees = cfg.getFees ? (cfg.getFees() || { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') }) : { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') };
    const wallet = viem.createWalletClient({ account, chain, transport: viem.http(cfg.rpcUrl) });
    const publicClient = viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) });

    // 1. Burn internal token by sending to dead address
    const burnHash = await wallet.writeContract({
      address: internal.address,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [BURN_ADDRESS, rawInternal],
      gas: 100000n,
      ...fees,
    });
    await publicClient.waitForTransactionReceipt({ hash: burnHash, timeout: 120000 });

    // 2. Send canonical to recipient
    const sendHash = await wallet.writeContract({
      address: target.address,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [to, rawCanonical],
      gas: 100000n,
      ...fees,
    });
    await publicClient.waitForTransactionReceipt({ hash: sendHash, timeout: 120000 });

    await queryFn(`UPDATE treasury_on_ramp_operations SET stage='completed', status='completed', result=jsonb_set(COALESCE(result,'{}'::jsonb), '{redeem}', $1::jsonb) WHERE id=$2`, [safeJson({ burnHash, sendHash, burned: amountInternal, sent: amountCanonical, to }), op.id]);
    return { operationId: op.id, stage: 'completed', status: 'completed', burnHash, sendHash, burned: amountInternal, sent: amountCanonical, to };
  }

  static async continue({ operationId, onRampBankDetails = {} } = {}) {
    const op = await this.getOperation(operationId);
    if (!op) throw new Error('Operation not found');
    return this._continue(op, onRampBankDetails);
  }
}

module.exports = { TreasuryOnRampBridgeEngine };
