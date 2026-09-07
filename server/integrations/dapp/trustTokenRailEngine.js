'use strict';

/**
 * Trust Token Rail — fixed income on chain, value moved programmatically.
 *
 * One run walks a fixed-income position all the way to a beneficiary's
 * expense wallet with no bank, fiat account or partner in the path:
 *
 *   position        the bond/fixed-income record the value comes from
 *   bond_token      that position as an ERC-20 on Base (BondToken via factory)
 *   issuance        maker/checker ticket, then mint of the bond token into the
 *                   treasury wallet against the position's principal
 *   trust_token     PtcBackedStablecoin + PtcReserveVault owned by the trust,
 *                   bond token accepted as reserve at a configured USD price
 *   reserve_deposit bond token locked in the vault, trust token minted 1:1 in
 *                   USD terms to the treasury wallet
 *   distribution    trust token sent to the beneficiary's purpose wallet under
 *                   DistributionPolicy (BeneficiaryExpenseWalletEngine, source
 *                   `trust_token`); a journal entry books the obligation
 *   evidence        the whole run digest-notarized on Fabric
 *   reconcile       chain supply, vault reserves, trust-token supply, wallet
 *                   balances, ledger rows and Fabric all compared
 *
 * Every write is signed by the Vault-held thirdweb server wallet
 * (DAPP_SIGNER=thirdweb); no private key lives on the host. While the dapp is
 * in shadow mode (or THIRDWEB_SERVER_WALLET_LIVE is false) the run produces the
 * full plan — amounts, contracts to deploy, wallet to fund — without touching
 * a chain, and says so on every stage.
 *
 * The outer rail (trust token → USDC → card / bill pay / merchant) is a
 * separate step: `offRamp()` reports which of those hooks are configured.
 */

const crypto = require('crypto');
const viem = require('viem');
const { getConfig: dappConfig } = require('./config');
const { ThirdwebChainSigner } = require('./thirdwebChainSigner');
const { ThirdwebServerWalletEngine } = require('./thirdwebServerWalletEngine');
const { ThirdwebPriceOracle } = require('./thirdwebPriceOracle');
const { BondTokenizationEngine } = require('./bondTokenizationEngine');
const { PtcStablecoinEngine } = require('./ptcStablecoinEngine');
const { BeneficiaryExpenseWalletEngine, TRUST_TOKEN_SOURCE } = require('./beneficiaryExpenseWalletEngine');
const DistributionPolicy = require('./distributionPolicy');
const { getMandate } = require('../trust/trustMandate');

let pool = null;
try { pool = require('../bonds/pgPool'); } catch (e) { /* no DB in tests */ }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

let FixedIncomeDataService = null;
try { ({ FixedIncomeDataService } = require('../bonds/fixedIncomeDataService')); } catch (e) { /* optional */ }
let IssuanceOsEngine = null;
try { ({ IssuanceOsEngine } = require('../os/issuanceOsEngine')); } catch (e) { /* optional */ }
let MintExchangeOsEngine = null;
try { ({ MintExchangeOsEngine } = require('../os/mintExchangeOsEngine')); } catch (e) { /* optional */ }
let CapControlEngine = null;
try { ({ CapControlEngine } = require('../os/capControlEngine')); } catch (e) { /* optional */ }
let FabricLedgerEngine = null;
try { ({ FabricLedgerEngine } = require('../hyperledger/fabricLedgerEngine')); } catch (e) { /* optional */ }

const RECORD_TYPE = 'trust_token_rail';
const BOND_TOKEN_DECIMALS = 6;
const TRUST_TOKEN_DECIMALS = 18;
const ONE_USD_18 = '1000000000000000000';
const STAGES = ['position', 'bond_token', 'issuance', 'trust_token', 'reserve_deposit', 'distribution', 'evidence', 'reconcile'];

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function num(name, def) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : def; }
function bool(name, def = false) { const v = process.env[name]; return v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(v); }
function toCents(usd) { return Math.round(Number(usd) * 100); }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function newId() { return `TTR-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }
function isAddress(v) { return /^0x[0-9a-fA-F]{40}$/.test(String(v || '')); }
function reject(message, code, status = 422) { return Object.assign(new Error(message), { code, status }); }

const memoryRuns = new Map();
let tablesReady = null;
async function ensureTables() {
  if (!pool || !pool.query) return;
  if (tablesReady) return tablesReady;
  tablesReady = pool.query(`
    CREATE TABLE IF NOT EXISTS trust_token_rail_runs (
      id TEXT PRIMARY KEY,
      chain_id INTEGER NOT NULL,
      shadow BOOLEAN NOT NULL,
      status TEXT NOT NULL,
      bond_id INTEGER,
      issue_usd NUMERIC,
      beneficiary TEXT,
      purpose TEXT,
      distribute_usd NUMERIC,
      stages JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch((e) => { tablesReady = null; throw e; });
  return tablesReady;
}

class TrustTokenRailEngine {
  static getConfig() {
    const dapp = dappConfig();
    const bond = BondTokenizationEngine.getConfig();
    const wallet = ThirdwebServerWalletEngine.getConfig();
    const shadow = bond.shadow || !ThirdwebChainSigner.active() || !wallet.live;
    return {
      enabled: bool('TRUST_TOKEN_RAIL_ENABLED', true),
      chainId: Number(dapp.chainId),
      signer: ThirdwebChainSigner.active() ? 'thirdweb' : 'private-key',
      operator: ThirdwebChainSigner.active() ? ThirdwebChainSigner.address() : (dapp.operatorAddress || null),
      shadow,
      // Ceiling on a single run's issuance (bond token minted + trust token issued), in USD.
      maxIssueUsd: num('TRUST_TOKEN_RAIL_MAX_ISSUE_USD', 1000),
      // USD value of one whole bond-token unit; the vault mints trust token at this price.
      reservePriceUsd: num('TRUST_TOKEN_RAIL_RESERVE_PRICE_USD', 1),
      trustTokenName: str('TRUST_TOKEN_NAME', `${getMandate().shortName} USD`),
      trustTokenSymbol: str('TRUST_TOKEN_SYMBOL', 'DLB-PTCUSD'),
      bondTokenDecimals: BOND_TOKEN_DECIMALS,
      walletLive: wallet.live,
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    const bond = BondTokenizationEngine.readiness();
    const ptc = PtcStablecoinEngine.readiness();
    const wallets = BeneficiaryExpenseWalletEngine.readiness();
    const fabric = FabricLedgerEngine ? FabricLedgerEngine.readiness() : { ready: false, issues: ['fabric engine unavailable'] };

    if (!cfg.enabled) issues.push('TRUST_TOKEN_RAIL_ENABLED is false');
    if (cfg.signer !== 'thirdweb') issues.push('DAPP_SIGNER is not thirdweb (Vault-held server wallet signing required for the rail)');
    if (!cfg.operator) issues.push('operator wallet unknown (THIRDWEB_SERVER_WALLET_ADDRESS)');
    if (!FixedIncomeDataService) issues.push('fixed income data service unavailable');
    if (!IssuanceOsEngine || !MintExchangeOsEngine) issues.push('Issuance OS / Mint & Exchange OS unavailable');
    if (!pool && !cfg.shadow) issues.push('database required for a live run');
    issues.push(...bond.issues.map((i) => `bond-token: ${i}`));
    issues.push(...ptc.issues.map((i) => `trust-token: ${i}`));
    if (!fabric.ready) issues.push(...(fabric.issues || []).map((i) => `fabric: ${i}`));

    return {
      provider: 'trust-token-rail',
      trust: getMandate().legalName,
      chainId: cfg.chainId,
      network: cfg.chainId === 8453 ? 'base' : cfg.chainId === 84532 ? 'base-sepolia' : `chain-${cfg.chainId}`,
      signer: cfg.signer,
      operator: cfg.operator,
      shadow: cfg.shadow,
      live: !cfg.shadow,
      walletLive: cfg.walletLive,
      maxIssueUsd: cfg.maxIssueUsd,
      trustToken: { symbol: ptc.tokenSymbol || cfg.trustTokenSymbol, deployed: ptc.deployed, tokenAddress: ptc.tokenAddress, vaultAddress: ptc.vaultAddress, reserveTokens: ptc.reserveTokens },
      components: { bondToken: bond, trustToken: ptc, expenseWallets: wallets, fabric: { ready: fabric.ready, live: fabric.live, canAnchor: fabric.canAnchor } },
      offRamp: this.offRamp(),
      ready: issues.length === 0,
      issues,
    };
  }

  /**
   * The hooks that turn trust token into something a merchant settles in. None
   * are required for the internal rail; each is config, not a rebuild.
   */
  static offRamp() {
    const cfg = this.getConfig();
    const usdc = str('THIRDWEB_SETTLEMENT_TOKEN') || str('DAPP_USDC_ADDRESS');
    return {
      redeemToUsdc: { configured: Boolean(usdc), token: usdc || null, via: 'PtcReserveVault.redeem + thirdweb /v1/bridge/swap' },
      spritz: { configured: Boolean(str('SPRITZ_API_KEY')), rails: ['card', 'bill-pay', 'ach', 'rtp', 'wire'] },
      pushToCard: { configured: Boolean(str('VISA_DIRECT_API_KEY') || str('MASTERCARD_SEND_API_KEY')) },
      hce: { configured: Boolean(str('HCE_ACQUIRER_API_KEY')) },
      chainId: cfg.chainId,
    };
  }

  static async _persist(run) {
    run.updatedAt = new Date().toISOString();
    if (!pool || !pool.query) { memoryRuns.set(run.id, run); return run; }
    await ensureTables();
    await pool.query(
      `INSERT INTO trust_token_rail_runs (id, chain_id, shadow, status, bond_id, issue_usd, beneficiary, purpose, distribute_usd, stages)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, stages = EXCLUDED.stages, updated_at = NOW()`,
      [run.id, run.chainId, run.shadow, run.status, run.request.bondId || null, run.request.issueUsd,
        run.request.beneficiary || null, run.request.purpose || null, run.request.distributeUsd || null,
        JSON.stringify(run.stages)]
    );
    return run;
  }

  static async getRun(id) {
    if (!pool || !pool.query) return memoryRuns.get(id) || null;
    await ensureTables();
    const { rows } = await pool.query('SELECT * FROM trust_token_rail_runs WHERE id = $1', [id]);
    return rows[0] ? this._rowToRun(rows[0]) : null;
  }

  static async listRuns({ limit = 20 } = {}) {
    if (!pool || !pool.query) return [...memoryRuns.values()].slice(-limit).reverse();
    await ensureTables();
    const { rows } = await pool.query('SELECT * FROM trust_token_rail_runs ORDER BY created_at DESC LIMIT $1', [limit]);
    return rows.map((r) => this._rowToRun(r));
  }

  static _rowToRun(r) {
    return {
      id: r.id, chainId: Number(r.chain_id), shadow: r.shadow, status: r.status,
      request: { bondId: r.bond_id, issueUsd: Number(r.issue_usd), beneficiary: r.beneficiary, purpose: r.purpose, distributeUsd: r.distribute_usd === null ? null : Number(r.distribute_usd) },
      stages: r.stages, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  /** Validated request → run skeleton. Nothing is touched. */
  static plan({ bondId, issueUsd, beneficiary, purpose, distributeUsd, requesterRole = 'trustee', initiatedBy, approvedBy, memo } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw reject('trust token rail disabled (TRUST_TOKEN_RAIL_ENABLED)', 'RAIL_DISABLED', 503);
    const issue = Number(issueUsd);
    if (!Number.isFinite(issue) || issue <= 0) throw reject('issueUsd must be a positive number', 'ISSUE_USD_INVALID');
    if (issue > cfg.maxIssueUsd) throw reject(`issueUsd ${issue} exceeds TRUST_TOKEN_RAIL_MAX_ISSUE_USD ${cfg.maxIssueUsd}`, 'ISSUE_CEILING');
    if (Math.round(issue * 100) !== issue * 100) throw reject('issueUsd must be whole cents', 'ISSUE_USD_INVALID');
    const maker = String(initiatedBy || '').trim();
    const checker = String(approvedBy || '').trim();
    if (!maker || !checker) throw reject('initiatedBy and approvedBy are both required (maker/checker)', 'MAKER_CHECKER_REQUIRED');
    if (maker.toLowerCase() === checker.toLowerCase()) throw reject('initiatedBy and approvedBy must be different trustees', 'MAKER_CHECKER_SAME');

    let distribute = null;
    let normalizedPurpose = null;
    if (beneficiary) {
      distribute = distributeUsd === undefined || distributeUsd === null ? issue : Number(distributeUsd);
      if (!Number.isFinite(distribute) || distribute <= 0) throw reject('distributeUsd must be a positive number', 'DISTRIBUTE_USD_INVALID');
      if (distribute > issue) throw reject(`distributeUsd ${distribute} exceeds issueUsd ${issue}`, 'DISTRIBUTE_EXCEEDS_ISSUE');
      // Throws with the policy's own code when the role/purpose/amount is refused.
      normalizedPurpose = DistributionPolicy.enforce({ requesterRole, amountUsd: distribute, purpose, purposeRequired: true }).purpose;
    }

    return {
      id: newId(),
      chainId: cfg.chainId,
      signer: cfg.signer,
      operator: cfg.operator,
      shadow: cfg.shadow,
      status: 'planned',
      request: {
        bondId: bondId === undefined || bondId === null || bondId === '' ? null : Number(bondId),
        issueUsd: issue, beneficiary: beneficiary || null, purpose: normalizedPurpose, distributeUsd: distribute,
        requesterRole, initiatedBy: maker, approvedBy: checker, memo: memo || null,
      },
      stages: STAGES.map((name) => ({ name, status: 'pending' })),
      createdAt: new Date().toISOString(),
    };
  }

  static _stage(run, name) { return run.stages.find((s) => s.name === name); }

  /**
   * Execute the pipeline. Stages run in order; the first failure stops the
   * pipeline but evidence and reconcile still run so the failed run is itself
   * notarized and the books compared.
   */
  static async run(request = {}) {
    const run = this.plan(request);
    run.status = 'running';
    await this._persist(run);
    const ctx = {};

    const steps = {
      position: () => this._position(run, ctx),
      bond_token: () => this._bondToken(run, ctx),
      issuance: () => this._issuance(run, ctx),
      trust_token: () => this._trustToken(run, ctx),
      reserve_deposit: () => this._reserveDeposit(run, ctx),
      distribution: () => this._distribution(run, ctx),
    };

    let failed = false;
    for (const name of Object.keys(steps)) {
      const stage = this._stage(run, name);
      if (failed) { stage.status = 'skipped'; continue; }
      stage.startedAt = new Date().toISOString();
      try {
        const result = await steps[name]();
        stage.status = result && result.skipped ? 'skipped' : run.shadow ? 'shadow' : 'done';
        stage.result = result;
      } catch (err) {
        failed = true;
        stage.status = 'failed';
        stage.error = err.message;
        stage.code = err.code || null;
      }
      stage.finishedAt = new Date().toISOString();
      await this._persist(run);
    }

    const evidence = this._stage(run, 'evidence');
    try {
      evidence.result = await this._evidence(run, ctx);
      evidence.status = evidence.result.skipped ? 'skipped' : evidence.result.status;
    } catch (err) { evidence.status = 'failed'; evidence.error = err.message; }

    const reconcile = this._stage(run, 'reconcile');
    try {
      reconcile.result = await this.reconcile({ run, ctx });
      reconcile.status = reconcile.result.clean ? (run.shadow ? 'shadow' : 'done') : 'discrepancies';
    } catch (err) { reconcile.status = 'failed'; reconcile.error = err.message; }

    run.status = failed ? 'failed' : run.shadow ? 'shadow' : 'completed';
    run.summary = this._summary(run, ctx);
    await this._persist(run);
    return run;
  }

  static _summary(run, ctx) {
    return {
      chainId: run.chainId,
      shadow: run.shadow,
      position: ctx.position ? { bondId: ctx.position.id, name: ctx.position.bond_name, principalUsd: ctx.position.principal_balance, accruedInterestUsd: ctx.position.accrued_interest } : null,
      bondToken: ctx.bondToken ? { id: ctx.bondToken.id, symbol: ctx.bondToken.token_symbol, address: ctx.bondToken.token_address } : null,
      issuance: ctx.issuance ? { issuanceId: ctx.issuance.issuanceId, mintTx: ctx.issuance.txHash, movementId: ctx.issuance.movementId, journalEntryId: ctx.issuance.journalEntryId } : null,
      trustToken: ctx.trustToken ? { symbol: ctx.trustToken.tokenSymbol, tokenAddress: ctx.trustToken.tokenAddress, vaultAddress: ctx.trustToken.vaultAddress } : null,
      reserveDeposit: ctx.deposit ? { reserveUnits: ctx.deposit.amount, mintedTrustToken: ctx.deposit.mintedStablecoin, mintedUsd: ctx.deposit.mintedUsd, txHash: ctx.deposit.txHash } : null,
      distribution: ctx.distribution ? { fundingId: ctx.distribution.fundingId, wallet: ctx.distribution.walletAddress, amountUsd: ctx.distribution.amountUsd, transferId: ctx.distribution.transferId, txHash: ctx.distribution.txHash, journalEntryId: ctx.distribution.journalEntryId } : null,
      evidence: ctx.evidence ? { id: ctx.evidence.id, digest: ctx.evidence.digest, status: ctx.evidence.status, transactionId: ctx.evidence.transactionId } : null,
    };
  }

  // ---------------------------------------------------------------- stages

  static async _position(run, ctx) {
    if (!FixedIncomeDataService) throw reject('fixed income data service unavailable', 'NO_FIXED_INCOME', 503);
    const { bondId, issueUsd } = run.request;
    let position = null;
    if (bondId !== null) {
      position = await FixedIncomeDataService.getPosition(bondId);
      if (!position) throw reject(`fixed-income position ${bondId} not found`, 'POSITION_NOT_FOUND', 404);
    } else {
      const positions = await FixedIncomeDataService.listPositions();
      position = positions.find((p) => p.status === 'active') || positions[0] || null;
      if (!position) throw reject('no fixed-income positions on the ledger', 'NO_POSITIONS', 404);
    }
    if (position.status !== 'active') throw reject(`position ${position.id} is ${position.status}, not active`, 'POSITION_INACTIVE');

    const tokenization = await FixedIncomeDataService.getTokenization([position]);
    const tokenized = (tokenization.by_bond[String(position.id)] || {}).tokenized_principal || 0;
    const headroom = round2(position.principal_balance - tokenized);
    if (issueUsd > headroom) {
      throw reject(`issueUsd ${issueUsd} exceeds untokenized principal ${headroom} on ${position.bond_name} (principal ${position.principal_balance}, tokenized ${tokenized})`, 'PRINCIPAL_HEADROOM');
    }
    ctx.position = position;
    return {
      bondId: position.id, name: position.bond_name, isin: position.isin, issuer: position.issuer,
      principalUsd: position.principal_balance, accruedInterestUsd: position.accrued_interest, couponRate: position.coupon_rate,
      maturityDate: position.maturity_date, alreadyTokenizedUsd: round2(tokenized), headroomUsd: headroom, issueUsd,
      note: 'a ledger position is a record; the bond token below is the on-chain claim the vault accepts as reserve',
    };
  }

  static async _bondToken(run, ctx) {
    const cfg = this.getConfig();
    const bond = ctx.position;
    const tokenName = `${bond.bond_name} Token`;
    const tokenSymbol = `DLBFI${bond.id}`;
    let token = await BondTokenizationEngine.getTokenByBondId(bond.id);
    let created = false;
    if (!token && run.shadow) {
      // Shadow never writes a token row: a planned deploy is reported, not recorded.
      ctx.bondToken = null;
      return {
        shadow: true, created: false, onChain: false, symbol: tokenSymbol, name: tokenName, decimals: cfg.bondTokenDecimals,
        plan: `deploy BondToken ${tokenSymbol} via BondTokenFactory from the Vault wallet on chain ${cfg.chainId}`,
      };
    }
    if (!token) {
      token = await BondTokenizationEngine.createToken({ bondId: bond.id, tokenName, tokenSymbol, decimals: cfg.bondTokenDecimals });
      created = true;
    }
    ctx.bondToken = token;
    const meta = typeof token.metadata === 'string' ? JSON.parse(token.metadata) : (token.metadata || {});
    return {
      tokenId: token.id, symbol: token.token_symbol, name: token.token_name, address: token.token_address,
      decimals: meta.decimals || cfg.bondTokenDecimals, created, onChain: isAddress(token.token_address),
      deployTx: meta.deployTx || null, deployTransactionId: meta.deployTransactionId || null, owner: meta.owner || null,
      ledgerSupply: Number(token.total_supply || 0),
    };
  }

  static async _issuance(run, ctx) {
    const { issueUsd, initiatedBy, approvedBy, memo } = run.request;
    if (!IssuanceOsEngine || !MintExchangeOsEngine) throw reject('Issuance OS unavailable', 'NO_ISSUANCE_OS', 503);
    if (run.shadow) {
      // Shadow assesses the cap (read-only) but raises no ticket and mints nothing.
      let assessment = null;
      if (ctx.bondToken && CapControlEngine && pool) {
        assessment = await CapControlEngine.assess({ tokenId: ctx.bondToken.id, principalCents: toCents(issueUsd), interestCents: 0 });
        if (!assessment.allowed) throw reject(`cap control refuses ${issueUsd}: ${assessment.breaches.join('; ')}`, 'CAP_CONTROL_OVER_CEILING');
      }
      ctx.issuance = { issuanceId: null, txHash: null, movementId: null, journalEntryId: null, shadowOnly: true };
      return {
        shadow: true, principalUsd: issueUsd, initiatedBy, approvedBy,
        capAssessment: assessment ? { allowed: assessment.allowed, ceilingCents: assessment.headroom.ceiling.totalCents, headroomCents: assessment.headroom.totalCents } : null,
        plan: ['IssuanceOsEngine.request (maker)', 'IssuanceOsEngine.approve (checker)', `MintExchangeOsEngine.mint ${issueUsd} bond units to the Vault wallet, GL claim posted`],
      };
    }
    if (!pool) throw reject('issuance tickets need Postgres', 'NO_DATABASE', 503);
    const { issuance, assessment } = await IssuanceOsEngine.request({
      tokenId: ctx.bondToken.id, principalCents: toCents(issueUsd), interestCents: 0, initiatedBy,
      memo: memo || `trust token rail ${run.id}: tokenize ${ctx.position.bond_name} principal for reserve`,
    });
    await IssuanceOsEngine.approve(issuance.issuance_id, approvedBy);
    const minted = await MintExchangeOsEngine.mint({ issuanceId: issuance.issuance_id, mintedBy: approvedBy, expect: { principalCents: toCents(issueUsd), interestCents: 0 } });
    ctx.issuance = {
      issuanceId: issuance.issuance_id, txHash: minted.result.txHash || null, movementId: minted.movement.movement_id,
      journalEntryId: minted.posting.journalEntryId || null,
    };
    ctx.bondToken = minted.result.token;
    return {
      issuanceId: issuance.issuance_id, initiatedBy, approvedBy, principalUsd: issueUsd,
      capAssessment: { ceilingCents: assessment.headroom && assessment.headroom.ceiling ? assessment.headroom.ceiling.totalCents : null, headroomCents: assessment.headroom ? assessment.headroom.totalCents : null },
      mint: { movementId: minted.movement.movement_id, holder: minted.result.holder, mintedUnits: minted.result.minted, txHash: minted.result.txHash || null, journalEntryId: minted.posting.journalEntryId || null, glUnpostedReason: minted.posting.reason || null },
      ledgerSupply: Number(minted.result.token.total_supply || 0),
    };
  }

  static async _trustToken(run, ctx) {
    const cfg = this.getConfig();
    const priceWei = (BigInt(Math.round(cfg.reservePriceUsd * 1e6)) * BigInt(ONE_USD_18) / 1000000n).toString();
    if (run.shadow) {
      const state = PtcStablecoinEngine.state();
      ctx.trustToken = { tokenSymbol: state.tokenSymbol || cfg.trustTokenSymbol, tokenAddress: state.tokenAddress || null, vaultAddress: state.vaultAddress || null, decimals: TRUST_TOKEN_DECIMALS };
      return {
        shadow: true, deployed: Boolean(state.tokenAddress), tokenSymbol: ctx.trustToken.tokenSymbol, tokenAddress: ctx.trustToken.tokenAddress, vaultAddress: ctx.trustToken.vaultAddress,
        plan: ['deploy PtcBackedStablecoin + PtcReserveVault from the Vault wallet (idempotent)', 'whitelist the vault', `accept ${ctx.bondToken ? ctx.bondToken.token_symbol : 'the bond token'} as reserve at $${cfg.reservePriceUsd}/unit`],
        reservePriceWei: priceWei,
      };
    }
    const deployed = await PtcStablecoinEngine.deploy({ tokenName: cfg.trustTokenName, tokenSymbol: cfg.trustTokenSymbol });
    const state = PtcStablecoinEngine.state();
    PtcStablecoinEngine.pinPrice(state);
    const vaultWhitelist = await PtcStablecoinEngine.whitelist(state.vaultAddress, true);
    const reserve = await PtcStablecoinEngine.addReserveToken({ token: ctx.bondToken.token_address, decimals: cfg.bondTokenDecimals, price: priceWei, name: ctx.bondToken.token_symbol });
    ctx.trustToken = { tokenSymbol: state.tokenSymbol, tokenAddress: state.tokenAddress, vaultAddress: state.vaultAddress, decimals: TRUST_TOKEN_DECIMALS };
    return {
      tokenSymbol: state.tokenSymbol, tokenAddress: state.tokenAddress, vaultAddress: state.vaultAddress, owner: state.owner, decimals: TRUST_TOKEN_DECIMALS,
      alreadyDeployed: Boolean(deployed.alreadyDeployed), deployTx: state.deployTx || null, vaultTx: state.vaultTx || null,
      vaultWhitelistTx: vaultWhitelist.txHash || null,
      reserve: { token: ctx.bondToken.token_address, symbol: ctx.bondToken.token_symbol, decimals: cfg.bondTokenDecimals, priceUsd: cfg.reservePriceUsd, priceWei, txHash: reserve.txHash || null, alreadyAccepted: Boolean(reserve.alreadyAccepted) },
      pinnedPrice: { priceUsd: 1, source: 'ptc-issuer' },
    };
  }

  static async _reserveDeposit(run, ctx) {
    const cfg = this.getConfig();
    const { issueUsd } = run.request;
    const units = (BigInt(toCents(issueUsd)) * 10n ** BigInt(cfg.bondTokenDecimals - 2)).toString();
    const expectedTrustToken = (BigInt(units) * BigInt(Math.round(cfg.reservePriceUsd * 1e6)) * BigInt(ONE_USD_18) / 1000000n / 10n ** BigInt(cfg.bondTokenDecimals)).toString();
    const expectedUsd = round2(issueUsd * cfg.reservePriceUsd);
    if (run.shadow) {
      ctx.deposit = { amount: units, mintedStablecoin: expectedTrustToken, mintedUsd: expectedUsd, txHash: null };
      return { shadow: true, reserveToken: ctx.bondToken ? ctx.bondToken.token_address : null, reserveUnits: units, expectedTrustToken, expectedUsd, recipient: cfg.operator, plan: 'approve vault, depositReserve → trust token minted to treasury wallet' };
    }
    // approveAndDeposit takes whole reserve-token units; one bond unit is one dollar of principal.
    const wholeUnits = (toCents(issueUsd) / 100).toFixed(2);
    const supplyBefore = viem.parseEther(await PtcStablecoinEngine.totalSupply());
    const deposit = await PtcStablecoinEngine.approveAndDeposit({ token: ctx.bondToken.token_address, amount: wholeUnits, recipient: cfg.operator });
    const supplyAfter = viem.parseEther(await PtcStablecoinEngine.totalSupply());
    const mintedOnChain = (supplyAfter - supplyBefore).toString();
    if (String(deposit.amount) !== units) {
      throw reject(`reserve deposit moved ${deposit.amount} bond units, expected ${units} (tx ${deposit.txHash})`, 'RESERVE_UNITS_MISMATCH', 502);
    }
    if (mintedOnChain !== expectedTrustToken) {
      throw reject(`vault minted ${mintedOnChain} trust token on chain, expected ${expectedTrustToken} for ${units} reserve units at $${cfg.reservePriceUsd} (tx ${deposit.txHash})`, 'RESERVE_MINT_MISMATCH', 502);
    }
    ctx.deposit = { ...deposit, mintedStablecoin: mintedOnChain, mintedUsd: round2(Number(mintedOnChain) / 1e18) };
    return {
      reserveToken: deposit.token, reserveUnits: deposit.amount, mintedTrustToken: mintedOnChain, mintedUsd: ctx.deposit.mintedUsd,
      expectedTrustToken, recipient: deposit.recipient, txHash: deposit.txHash, matchesExpectation: true,
      supplyBefore: supplyBefore.toString(), supplyAfter: supplyAfter.toString(),
    };
  }

  static async _distribution(run, ctx) {
    const cfg = this.getConfig();
    const { beneficiary, purpose, distributeUsd, requesterRole } = run.request;
    if (!beneficiary) return { skipped: true, reason: 'no beneficiary requested; trust token stays in the treasury wallet' };
    const trustToken = ctx.trustToken && ctx.trustToken.tokenAddress;
    const identifier = BeneficiaryExpenseWalletEngine.identifierFor(beneficiary, purpose);

    if (run.shadow || !trustToken) {
      // Shadow reads the wallet already on record; it never asks thirdweb to provision one.
      const existing = (await BeneficiaryExpenseWalletEngine.listWallets({ beneficiary })).find((w) => w.identifier === identifier) || null;
      const decision = DistributionPolicy.enforce({ requesterRole, amountUsd: distributeUsd, purpose, purposeRequired: true });
      const quantity = (BigInt(toCents(distributeUsd)) * 10n ** BigInt(TRUST_TOKEN_DECIMALS - 2)).toString();
      ctx.distribution = { fundingId: null, walletAddress: existing ? existing.address : null, amountUsd: distributeUsd, transferId: null, txHash: null, journalEntryId: null };
      return {
        shadow: true, wallet: { identifier, address: existing ? existing.address : null, purpose: decision.purpose, provisioned: Boolean(existing) },
        amountUsd: distributeUsd, quantity, decimals: TRUST_TOKEN_DECIMALS,
        policy: decision, source: TRUST_TOKEN_SOURCE, tokenAddress: trustToken || null,
        plan: [existing ? 'reuse the expense wallet on record' : `provision server wallet ${identifier} via thirdweb`, 'whitelist the expense wallet on the trust token', 'send trust token from treasury to the wallet', 'book the beneficiary obligation once confirmed'],
      };
    }

    const wallet = await BeneficiaryExpenseWalletEngine.ensureWallet({ beneficiary, purpose });

    const whitelist = await PtcStablecoinEngine.whitelist(wallet.address, true);
    const funding = await BeneficiaryExpenseWalletEngine.fund({
      beneficiary, purpose, amountUsd: distributeUsd, requesterRole, sourceType: TRUST_TOKEN_SOURCE, tokenAddress: trustToken, chainId: cfg.chainId,
    });
    ctx.distribution = {
      fundingId: funding.id, walletAddress: wallet.address, amountUsd: distributeUsd, transferId: funding.transferId || null,
      txHash: funding.transactionHash || null, journalEntryId: funding.journalEntryId || null,
    };
    return {
      wallet: { identifier: wallet.identifier, address: wallet.address, purpose: wallet.purpose }, whitelistTx: whitelist.txHash || null,
      fundingId: funding.id, amountUsd: distributeUsd, quantity: funding.quantity, priceUsd: funding.priceUsd, source: TRUST_TOKEN_SOURCE, tokenAddress: trustToken,
      transfer: { id: funding.transferId || null, transactionId: funding.transactionId || null, status: funding.transferStatus || null, transactionHash: funding.transactionHash || null },
      journalEntryId: funding.journalEntryId || null, policy: { requesterRole: funding.requesterRole, purpose: funding.purpose, limitUsd: funding.limitUsd },
    };
  }

  /** What Fabric holds for a run: the value summary plus the pipeline stages' outcomes. */
  static _evidencePayload(run, ctx) {
    return {
      runId: run.id, chainId: run.chainId, shadow: run.shadow, trust: getMandate().legalName, ...this._summary(run, ctx),
      stages: run.stages.filter((s) => !['evidence', 'reconcile'].includes(s.name)).map((s) => ({ name: s.name, status: s.status, error: s.error || null })),
    };
  }

  static async _evidence(run, ctx) {
    if (!FabricLedgerEngine) return { skipped: true, reason: 'fabric engine unavailable' };
    const payload = this._evidencePayload(run, ctx);
    ctx.evidencePayload = payload;
    const row = await FabricLedgerEngine.notarize({
      recordType: RECORD_TYPE, recordId: run.id, payload,
      metadata: { trust: getMandate().legalName, pipeline: 'trust-token-rail', chainId: run.chainId },
      notarizedBy: 'trust-token-rail',
    });
    ctx.evidence = { id: row.id, digest: row.digest, status: row.status, transactionId: row.transactionId || null };
    return { ...ctx.evidence, blockNumber: row.blockNumber || null, payloadDigest: row.digest };
  }

  // ------------------------------------------------------------- reconcile

  /**
   * Compare every place the value is recorded. `run`/`ctx` scope the check to
   * one run; without them the whole rail is reconciled from state.
   */
  static async reconcile({ run = null, ctx = {} } = {}) {
    const cfg = this.getConfig();
    const discrepancies = [];
    const checks = [];
    const note = (name, ok, detail) => { checks.push({ name, ok, ...detail }); if (!ok) discrepancies.push({ name, ...detail }); };

    // bond token: ledger supply vs chain supply
    const bondToken = ctx.bondToken || null;
    if (bondToken && isAddress(bondToken.token_address) && !cfg.shadow) {
      try {
        const chain = await BondTokenizationEngine.chainSupply(bondToken.id);
        const ledger = Number(bondToken.total_supply || 0);
        note('bond_token_supply', Math.abs(chain - ledger) < 0.000001, { token: bondToken.token_address, chainSupply: chain, ledgerSupply: ledger });
      } catch (e) { note('bond_token_supply', false, { token: bondToken.token_address, error: e.message }); }
    } else if (bondToken) {
      note('bond_token_supply', true, { token: bondToken.token_address, ledgerSupply: Number(bondToken.total_supply || 0), shadow: true, detail: 'no chain read in shadow mode' });
    }

    // trust token: vault reserves (USD) vs total supply (USD)
    const state = PtcStablecoinEngine.state();
    if (state.tokenAddress && !cfg.shadow) {
      try {
        const [supply, reserves] = await Promise.all([PtcStablecoinEngine.totalSupply(), PtcStablecoinEngine.reserveBalances()]);
        const reserveUsd = reserves.reduce((sum, r) => {
          if (r.error) return sum;
          const priceUsd = Number(BigInt(r.price || ONE_USD_18)) / 1e18;
          return sum + Number(r.vaultBalanceFormatted || 0) * priceUsd;
        }, 0);
        note('trust_token_backing', Math.abs(Number(supply) - reserveUsd) < 0.000001, { tokenAddress: state.tokenAddress, vaultAddress: state.vaultAddress, totalSupplyUsd: Number(supply), reserveUsd: round2(reserveUsd), reserves });
        if (cfg.operator) {
          const treasury = Number(await PtcStablecoinEngine.balanceOf(cfg.operator));
          const walletBalances = [];
          if (ctx.distribution && ctx.distribution.walletAddress) {
            walletBalances.push({ address: ctx.distribution.walletAddress, balance: Number(await PtcStablecoinEngine.balanceOf(ctx.distribution.walletAddress)) });
          }
          const held = treasury + walletBalances.reduce((s, w) => s + w.balance, 0);
          note('trust_token_holders', held <= Number(supply) + 0.000001, { treasury, wallets: walletBalances, totalSupply: Number(supply) });
        }
      } catch (e) { note('trust_token_backing', false, { tokenAddress: state.tokenAddress, error: e.message }); }
    } else {
      note('trust_token_backing', true, { deployed: Boolean(state.tokenAddress), shadow: true, detail: 'no chain read in shadow mode' });
    }

    // this run: minted trust token equals what the deposit should have produced
    if (ctx.deposit && run) {
      const expectedUsd = round2(run.request.issueUsd * cfg.reservePriceUsd);
      note('run_issuance_matches_reserve', Math.abs(Number(ctx.deposit.mintedUsd) - expectedUsd) < 0.005, { mintedUsd: ctx.deposit.mintedUsd, expectedUsd, reserveUnits: ctx.deposit.amount });
    }
    if (ctx.distribution && run && run.request.distributeUsd !== null) {
      note('run_distribution_within_issuance', Number(ctx.distribution.amountUsd) <= Number(run.request.issueUsd), { distributeUsd: ctx.distribution.amountUsd, issueUsd: run.request.issueUsd });
    }

    // fabric: the run's notarized digest still matches what we hold
    if (run && ctx.evidence && FabricLedgerEngine) {
      try {
        const payload = ctx.evidencePayload || this._evidencePayload(run, ctx);
        const verification = await FabricLedgerEngine.verify({ recordType: RECORD_TYPE, recordId: run.id, payload });
        note('fabric_evidence', verification.outcome === 'verified', { outcome: verification.outcome, digest: verification.currentDigest, chainMatch: verification.chainMatch === undefined ? null : verification.chainMatch, status: ctx.evidence.status });
      } catch (e) { note('fabric_evidence', false, { error: e.message }); }
    }

    return { clean: discrepancies.length === 0, shadow: cfg.shadow, chainId: cfg.chainId, checks, discrepancies, generatedAt: new Date().toISOString() };
  }

  /** Readiness + on-chain state + recent runs: the rail's dashboard read. */
  static async status() {
    const readiness = this.readiness();
    const runs = await this.listRuns({ limit: 5 }).catch(() => []);
    let trustToken = null;
    try { trustToken = readiness.shadow ? PtcStablecoinEngine.state() : await PtcStablecoinEngine.info(); } catch (e) { trustToken = { error: e.message }; }
    let bondTokens = [];
    try { bondTokens = (await BondTokenizationEngine.listTokens()).map((t) => ({ id: t.id, bondId: t.bond_id, symbol: t.token_symbol, address: t.token_address, supply: Number(t.total_supply || 0), class: BondTokenizationEngine.classifyToken(t) })); } catch (e) { bondTokens = []; }
    const pinned = ThirdwebPriceOracle.listPinned();
    return { readiness, trustToken, bondTokens, pinnedPrices: pinned, recentRuns: runs.map((r) => ({ id: r.id, status: r.status, shadow: r.shadow, chainId: r.chainId, createdAt: r.createdAt, request: r.request })), generatedAt: new Date().toISOString() };
  }
}

module.exports = { TrustTokenRailEngine, RECORD_TYPE, STAGES };
