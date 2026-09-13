/**
 * Floor Redemption OS Engine
 *
 * Deploys and operates contracts/FloorPriceRedemption.sol — a canonical
 * (USDC/USDS/DAI) reserve the trust funds so any whitelisted holder can redeem
 * DLB-PTCUSD at a fixed floor (default $1) — and runs the peg-defense loop:
 *
 *   deploy    salted, idempotent (same salt → same address through the
 *             thirdweb signer), owner = operator, whitelist the contract on the
 *             trust token so it can pull DLB-PTCUSD
 *   coverage  canonical reserve ÷ DLB-PTCUSD supply, at the floor
 *   fund      move canonical from the operator wallet into the reserve; when the
 *             wallet is short, drive TreasuryOnRampBridgeEngine to bring real
 *             canonical on-chain and report `awaiting_funds` until it lands
 *   redeem    operator-side redemption for a holder
 *   arbCycle  when the AMM prices DLB-PTCUSD below the floor by more than the
 *             spread threshold: buy on the AMM with canonical, redeem at floor,
 *             capture the spread, tighten the peg
 *
 * Nothing is minted or invented: every path that would need canonical the
 * operator does not hold returns `awaiting_funds`, exactly like
 * TreasuryOnRampBridgeEngine._redeemInternal and RedemptionGatewayEngine._spritzPayout.
 * Shadow-by-default; FLOOR_REDEMPTION_OS_SHADOW=false plus the DAPP_SHADOW /
 * THIRDWEB_SERVER_WALLET_LIVE gates are needed before a transaction is signed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getConfig } = require('./config');
const { ThirdwebChainSigner } = require('./thirdwebChainSigner');
const { ThirdwebServerWalletEngine } = require('./thirdwebServerWalletEngine');

let viem = null;
try { viem = require('viem'); } catch (e) { /* optional */ }
let allChains = null;
try { allChains = require('viem/chains'); } catch (e) { /* optional */ }
let privateKeyToAccount = null;
try { ({ privateKeyToAccount } = require('viem/accounts')); } catch (e) { /* optional */ }

let query = null;
try { const pgPool = require('../bonds/pgPool'); query = (...args) => pgPool.query(...args); } catch (e) { /* optional */ }

let PtcStablecoinEngine = null;
try { ({ PtcStablecoinEngine } = require('./ptcStablecoinEngine')); } catch (e) { /* optional */ }
let AmmOsEngine = null;
let StableSwapMath = null;
try { ({ AmmOsEngine, StableSwapMath } = require('./ammOsEngine')); } catch (e) { /* optional */ }
let TreasuryOnRampBridgeEngine = null;
try { ({ TreasuryOnRampBridgeEngine } = require('./treasuryOnRampBridgeEngine')); } catch (e) { /* optional */ }
let TrustAccountingEngine = null;
try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { /* optional */ }
let FabricLedgerEngine = null;
try { ({ FabricLedgerEngine } = require('../hyperledger/fabricLedgerEngine')); } catch (e) { /* optional */ }

const RECORD_TYPE = 'floor_redemption_os_arb';
const PRECISION = 10n ** 18n;
const TRUST_TOKEN_DECIMALS = 18;
const CANONICAL_DECIMALS = { USDC: 6, USDS: 18, DAI: 18 };

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address', name: 'account' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'allowance', inputs: [{ type: 'address', name: 'owner' }, { type: 'address', name: 'spender' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ type: 'address', name: 'spender' }, { type: 'uint256', name: 'amount' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
];

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function num(name, def) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : def; }
function bool(name, def = false) { const v = process.env[name]; return v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(v); }
function isAddress(v) { return /^0x[0-9a-fA-F]{40}$/.test(String(v || '')); }
function newId(prefix = 'FRO') { return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }
function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }
function round6(n) { return Math.round((Number(n) || 0) * 1e6) / 1e6; }
function fmt(raw, decimals) { return Number(raw) / 10 ** decimals; }

function getArtifact() {
  const abiPath = path.join(process.cwd(), 'artifacts', 'contracts_FloorPriceRedemption_sol_FloorPriceRedemption.abi');
  const binPath = path.join(process.cwd(), 'artifacts', 'contracts_FloorPriceRedemption_sol_FloorPriceRedemption.bin');
  if (!fs.existsSync(abiPath)) throw new Error('FloorPriceRedemption artifact not found; run scripts/compileOsEngines.cjs');
  return { abi: JSON.parse(fs.readFileSync(abiPath, 'utf8')), bytecode: '0x' + fs.readFileSync(binPath, 'utf8').trim().replace(/^0x/, '') };
}

function chainById(id) {
  if (!allChains) return undefined;
  return Object.values(allChains).find((c) => c && typeof c === 'object' && Number(c.id) === Number(id)) || allChains.mainnet;
}

function operatorAddress(cfg) {
  if (ThirdwebChainSigner.active()) return ThirdwebChainSigner.address() || cfg.operatorAddress;
  return cfg.operatorAddress;
}

function clients(cfg) {
  if (ThirdwebChainSigner.active()) return ThirdwebChainSigner.clients({ chainId: cfg.chainId });
  if (!viem) throw new Error('viem not installed');
  if (!cfg.privateKey) throw new Error('DAPP_PRIVATE_KEY not configured');
  const account = privateKeyToAccount(cfg.privateKey.startsWith('0x') ? cfg.privateKey : `0x${cfg.privateKey}`);
  const chain = chainById(cfg.chainId);
  const fees = { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') };
  const publicClient = viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) });
  const walletClient = viem.createWalletClient({ account, chain, transport: viem.http(cfg.rpcUrl) });
  return { account, publicClient, walletClient, fees };
}

let tablesReady = false;
async function ensureTables() {
  if (tablesReady || !query) return;
  await query(`
    CREATE TABLE IF NOT EXISTS floor_redemption_os_contracts (
      id                 TEXT PRIMARY KEY,
      chain_id           INTEGER NOT NULL,
      contract_address   TEXT NOT NULL UNIQUE,
      trust_token        TEXT NOT NULL,
      reserve_token      TEXT NOT NULL,
      reserve_asset      TEXT NOT NULL,
      reserve_decimals   INTEGER NOT NULL,
      floor_price        TEXT NOT NULL,
      owner_address      TEXT,
      deploy_tx          TEXT,
      metadata           JSONB DEFAULT '{}',
      created_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS floor_redemption_os_actions (
      id               TEXT PRIMARY KEY,
      contract_address TEXT,
      kind             TEXT NOT NULL,
      mode             TEXT NOT NULL,
      status           TEXT NOT NULL,
      amount_trust     TEXT,
      amount_canonical TEXT,
      spread_bps       INTEGER,
      profit_canonical TEXT,
      tx_hashes        JSONB DEFAULT '[]',
      detail           JSONB DEFAULT '{}',
      journal_entry_id TEXT,
      fabric_record_id TEXT,
      error            TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query('CREATE INDEX IF NOT EXISTS floor_redemption_os_actions_idx ON floor_redemption_os_actions(contract_address, created_at DESC)');
  tablesReady = true;
}

class FloorRedemptionOsEngine {
  static getConfig() {
    const cfg = getConfig();
    const wallet = ThirdwebServerWalletEngine.getConfig();
    const signerActive = ThirdwebChainSigner.active();
    const shadow = bool('FLOOR_REDEMPTION_OS_SHADOW', true) || cfg.dappShadow === true || (signerActive && !wallet.live);
    const reserveAsset = str('FLOOR_REDEMPTION_OS_RESERVE_ASSET', 'USDC').toUpperCase();
    const reserveAddress = { USDC: cfg.usdcAddress, USDS: cfg.usdsAddress, DAI: cfg.daiAddress }[reserveAsset] || '';
    const floorPrice = str('FLOOR_REDEMPTION_OS_FLOOR_PRICE', '1');
    return {
      enabled: bool('FLOOR_REDEMPTION_OS_ENABLED', true),
      shadow,
      signer: signerActive ? 'thirdweb' : 'private-key',
      walletLive: wallet.live,
      chainId: Number(cfg.chainId),
      rpcUrl: cfg.rpcUrl,
      privateKey: cfg.privateKey,
      operatorAddress: operatorAddress(cfg) || '',
      reserveAsset,
      reserveAddress,
      reserveDecimals: num('FLOOR_REDEMPTION_OS_RESERVE_DECIMALS', CANONICAL_DECIMALS[reserveAsset] || 18),
      contractAddress: str('FLOOR_REDEMPTION_OS_CONTRACT_ADDRESS'),
      floorPrice,
      floorPriceRaw: viem ? viem.parseUnits(floorPrice, 18) : BigInt(Math.round(Number(floorPrice) * 1e18)),
      burnOnRedeem: bool('FLOOR_REDEMPTION_OS_BURN_ON_REDEEM', false),
      // Target reserve as a fraction of DLB-PTCUSD supply the trust wants held at the floor.
      targetCoverageBps: Math.max(0, num('FLOOR_REDEMPTION_OS_TARGET_COVERAGE_BPS', 10000)),
      // AMM discount to the floor (bps) before an arbitrage is worth executing, net of swap fee.
      minSpreadBps: Math.max(1, num('FLOOR_REDEMPTION_OS_MIN_SPREAD_BPS', 25)),
      maxArbUsd: Math.max(0, num('FLOOR_REDEMPTION_OS_MAX_ARB_USD', 500)),
      maxFundUsd: Math.max(0, num('FLOOR_REDEMPTION_OS_MAX_FUND_USD', 5000)),
      onRampSourceType: str('FLOOR_REDEMPTION_OS_ONRAMP_SOURCE_TYPE', 'core_banking'),
      onRampSourceAccountId: str('FLOOR_REDEMPTION_OS_ONRAMP_SOURCE_ACCOUNT_ID'),
      onRampMethod: str('FLOOR_REDEMPTION_OS_ONRAMP_METHOD', 'core_banking_wire'),
      arbIncomeAccount: str('FLOOR_REDEMPTION_OS_INCOME_ACCOUNT', '4200'),
      assetAccount: str('STABLECOIN_ASSET_ACCOUNT', '1210'),
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.enabled) issues.push('FLOOR_REDEMPTION_OS_ENABLED is not true');
    if (!PtcStablecoinEngine) issues.push('PtcStablecoinEngine not available');
    else if (!PtcStablecoinEngine.state().tokenAddress) issues.push('PTC stablecoin not deployed');
    if (!cfg.reserveAddress) issues.push(`reserve ${cfg.reserveAsset} address not configured`);
    if (!(Number(cfg.floorPrice) > 0)) issues.push('FLOOR_REDEMPTION_OS_FLOOR_PRICE must be positive');
    try { getArtifact(); } catch (e) { issues.push(e.message); }
    if (!cfg.shadow) {
      if (cfg.signer === 'thirdweb') issues.push(...ThirdwebChainSigner.readiness().issues);
      else if (!cfg.privateKey) issues.push('DAPP_PRIVATE_KEY not configured');
      if (!cfg.rpcUrl) issues.push('DAPP_RPC_URL not configured');
      if (!cfg.operatorAddress) issues.push('operator address unknown (DAPP_OPERATOR_ADDRESS or THIRDWEB_SERVER_WALLET_ADDRESS)');
    }
    return {
      provider: 'floor-redemption-os',
      ready: issues.length === 0,
      mode: cfg.shadow ? 'shadow' : 'live',
      enabled: cfg.enabled,
      signer: cfg.signer,
      walletLive: cfg.walletLive,
      chainId: cfg.chainId,
      reserveAsset: cfg.reserveAsset,
      floorPrice: cfg.floorPrice,
      issues,
    };
  }

  // ─── Contract record / deploy ────────────────────────────────────────────

  static async getContractRecord() {
    const cfg = this.getConfig();
    if (cfg.contractAddress && isAddress(cfg.contractAddress)) {
      return {
        contract_address: cfg.contractAddress, chain_id: cfg.chainId, trust_token: PtcStablecoinEngine ? PtcStablecoinEngine.state().tokenAddress : null,
        reserve_token: cfg.reserveAddress, reserve_asset: cfg.reserveAsset, reserve_decimals: cfg.reserveDecimals, floor_price: cfg.floorPriceRaw.toString(), source: 'env',
      };
    }
    if (!query) return null;
    await ensureTables();
    const { rows } = await query('SELECT * FROM floor_redemption_os_contracts WHERE chain_id = $1 AND reserve_asset = $2 ORDER BY created_at DESC LIMIT 1', [cfg.chainId, cfg.reserveAsset]);
    return rows[0] ? { ...rows[0], source: 'postgres' } : null;
  }

  static async _recordAction(action) {
    if (!query) return;
    await ensureTables();
    await query(
      `INSERT INTO floor_redemption_os_actions (id, contract_address, kind, mode, status, amount_trust, amount_canonical, spread_bps, profit_canonical, tx_hashes, detail, journal_entry_id, fabric_record_id, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [action.id, action.contractAddress || null, action.kind, action.mode, action.status,
        action.amountTrust != null ? String(action.amountTrust) : null, action.amountCanonical != null ? String(action.amountCanonical) : null,
        action.spreadBps ?? null, action.profitCanonical != null ? String(action.profitCanonical) : null,
        safeJson(action.txHashes || []), safeJson(action.detail || {}), action.journalEntryId || null, action.fabricRecordId || null, action.error || null]
    );
  }

  /**
   * Deploy FloorPriceRedemption with a deterministic salt (idempotent through
   * the thirdweb signer), whitelist it on the trust token so `redeem` can pull
   * DLB-PTCUSD, and whitelist the operator as a redeemer. Shadow returns the plan.
   */
  static async deploy({ force = false } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) { const e = new Error('Floor Redemption OS is disabled (FLOOR_REDEMPTION_OS_ENABLED)'); e.status = 409; e.code = 'DISABLED'; throw e; }
    const existing = await this.getContractRecord();
    if (existing && !force) return { deployed: false, contract: existing, mode: cfg.shadow ? 'shadow' : 'live' };
    const trust = PtcStablecoinEngine ? PtcStablecoinEngine.state().tokenAddress : null;
    if (!trust) throw new Error('PTC stablecoin not deployed');
    if (!cfg.reserveAddress) throw new Error(`reserve ${cfg.reserveAsset} address not configured`);
    const plan = {
      contract: 'FloorPriceRedemption',
      args: { trustToken: trust, reserveToken: cfg.reserveAddress, reserveDecimals: cfg.reserveDecimals, floorPrice: cfg.floorPriceRaw.toString(), owner: cfg.operatorAddress },
      salt: `floor-redemption:${cfg.reserveAsset}:${cfg.chainId}`,
      burnOnRedeem: cfg.burnOnRedeem,
    };
    if (cfg.shadow) {
      await this._recordAction({ id: newId(), kind: 'deploy', mode: 'shadow', status: 'shadow', detail: plan });
      return { deployed: false, mode: 'shadow', plan };
    }
    const readiness = this.readiness();
    if (!readiness.ready) throw new Error(`Floor Redemption OS not ready: ${readiness.issues.join('; ')}`);

    const { publicClient, walletClient, fees, account } = clients(cfg);
    const { abi, bytecode } = getArtifact();
    const owner = cfg.operatorAddress || account.address;
    const hash = await walletClient.deployContract({
      abi, bytecode,
      args: [trust, cfg.reserveAddress, cfg.reserveDecimals, cfg.floorPriceRaw, owner],
      salt: plan.salt,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180000 });
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`FloorPriceRedemption deploy failed: ${hash}`);
    const contractAddress = receipt.contractAddress;
    const txHashes = [receipt.transactionHash || hash];

    if (!receipt.alreadyDeployed) {
      const wl = await walletClient.writeContract({ address: contractAddress, abi, functionName: 'setRedeemer', args: [owner, true], ...fees });
      await publicClient.waitForTransactionReceipt({ hash: wl, timeout: 120000 });
      txHashes.push(wl);
      if (cfg.burnOnRedeem) {
        const b = await walletClient.writeContract({ address: contractAddress, abi, functionName: 'setBurnOnRedeem', args: [true], ...fees });
        await publicClient.waitForTransactionReceipt({ hash: b, timeout: 120000 });
        txHashes.push(b);
      }
    }
    const wlTrust = await PtcStablecoinEngine.whitelist(contractAddress, true);
    if (wlTrust && wlTrust.txHash) txHashes.push(wlTrust.txHash);

    const record = {
      id: newId('FRC'), chain_id: cfg.chainId, contract_address: contractAddress, trust_token: trust, reserve_token: cfg.reserveAddress,
      reserve_asset: cfg.reserveAsset, reserve_decimals: cfg.reserveDecimals, floor_price: cfg.floorPriceRaw.toString(), owner_address: owner, deploy_tx: txHashes[0],
    };
    if (query) {
      await ensureTables();
      await query(
        `INSERT INTO floor_redemption_os_contracts (id, chain_id, contract_address, trust_token, reserve_token, reserve_asset, reserve_decimals, floor_price, owner_address, deploy_tx, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (contract_address) DO NOTHING`,
        [record.id, record.chain_id, record.contract_address, record.trust_token, record.reserve_token, record.reserve_asset, record.reserve_decimals, record.floor_price, record.owner_address, record.deploy_tx, safeJson({ burnOnRedeem: cfg.burnOnRedeem })]
      );
    }
    await this._recordAction({ id: newId(), contractAddress, kind: 'deploy', mode: 'live', status: 'completed', txHashes, detail: plan });
    return { deployed: true, mode: 'live', contract: record, txHashes };
  }

  // ─── Reads ───────────────────────────────────────────────────────────────

  static async _readContract(cfg, address) {
    const { publicClient } = clients(cfg);
    const { abi } = getArtifact();
    const read = (functionName, args = []) => publicClient.readContract({ address, abi, functionName, args });
    const [reserve, floor, paused, totalRedeemed, totalPaidOut, whitelistEnabled, burnOnRedeem] = await Promise.all([
      read('reserveBalance'), read('floorPrice'), read('paused'), read('totalRedeemed'), read('totalPaidOut'), read('whitelistEnabled'), read('burnOnRedeem'),
    ]);
    return { reserve: BigInt(reserve), floorPrice: BigInt(floor), paused: Boolean(paused), totalRedeemed: BigInt(totalRedeemed), totalPaidOut: BigInt(totalPaidOut), whitelistEnabled: Boolean(whitelistEnabled), burnOnRedeem: Boolean(burnOnRedeem) };
  }

  static async _operatorBalance(cfg, token) {
    const { publicClient } = clients(cfg);
    return BigInt(await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [cfg.operatorAddress] }));
  }

  static async _approve(cfg, token, spender, amount) {
    const { publicClient, walletClient, fees } = clients(cfg);
    const allowance = BigInt(await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [cfg.operatorAddress, spender] }));
    if (allowance >= amount) return null;
    const hash = await walletClient.writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [spender, amount], ...fees });
    await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    return hash;
  }

  /**
   * Canonical owed for `trustRaw` at `floorPriceRaw` (1e18 = 1:1), in reserve
   * units — the same arithmetic as FloorPriceRedemption.quoteRedeem.
   */
  static quoteRedeem({ trustRaw, floorPriceRaw, reserveDecimals }) {
    return (BigInt(trustRaw) * BigInt(floorPriceRaw)) / PRECISION / (10n ** BigInt(18 - reserveDecimals));
  }

  /** Coverage of `supplyRaw` DLB-PTCUSD by `reserveRaw` canonical at the floor, in bps. */
  static coverage({ reserveRaw, supplyRaw, floorPriceRaw, reserveDecimals }) {
    const needed = this.quoteRedeem({ trustRaw: supplyRaw, floorPriceRaw, reserveDecimals });
    const coverageBps = needed === 0n ? (BigInt(reserveRaw) > 0n ? 10_000 : 0) : Number((BigInt(reserveRaw) * 10_000n) / needed);
    const shortfall = needed > BigInt(reserveRaw) ? needed - BigInt(reserveRaw) : 0n;
    return {
      reserveRaw: BigInt(reserveRaw).toString(),
      reserve: fmt(reserveRaw, reserveDecimals),
      supply: fmt(supplyRaw, TRUST_TOKEN_DECIMALS),
      neededRaw: needed.toString(),
      needed: fmt(needed, reserveDecimals),
      coverageBps,
      fullyCovered: shortfall === 0n,
      shortfallRaw: shortfall.toString(),
      shortfall: fmt(shortfall, reserveDecimals),
    };
  }

  static async status() {
    const cfg = this.getConfig();
    const readiness = this.readiness();
    const contract = await this.getContractRecord().catch(() => null);
    let chain = null;
    let coverage = null;
    let supplyRaw = 0n;
    if (contract) {
      try {
        const [c, supply] = await Promise.all([
          this._readContract(cfg, contract.contract_address),
          PtcStablecoinEngine.totalSupply().then((s) => viem.parseUnits(String(s || '0'), TRUST_TOKEN_DECIMALS)),
        ]);
        chain = { ...c, reserve: c.reserve.toString(), floorPrice: Number(c.floorPrice) / 1e18, totalRedeemed: fmt(c.totalRedeemed, 18), totalPaidOut: fmt(c.totalPaidOut, Number(contract.reserve_decimals)) };
        supplyRaw = supply;
        coverage = this.coverage({ reserveRaw: c.reserve, supplyRaw: supply, floorPriceRaw: c.floorPrice, reserveDecimals: Number(contract.reserve_decimals) });
      } catch (e) {
        chain = { error: e.message };
      }
    }
    const actions = await this.listActions({ limit: 10 }).catch(() => []);
    const amm = AmmOsEngine ? await AmmOsEngine.snapshot().catch((e) => ({ exists: false, error: e.message })) : { exists: false };
    return {
      provider: 'floor-redemption-os',
      mode: cfg.shadow ? 'shadow' : 'live',
      enabled: cfg.enabled,
      readiness,
      reserveAsset: cfg.reserveAsset,
      floorPrice: cfg.floorPrice,
      targetCoverageBps: cfg.targetCoverageBps,
      minSpreadBps: cfg.minSpreadBps,
      maxArbUsd: cfg.maxArbUsd,
      contract,
      chain,
      supply: fmt(supplyRaw, TRUST_TOKEN_DECIMALS),
      coverage,
      amm: amm.exists ? { poolAddress: amm.poolAddress, price: amm.price, deviationBps: amm.deviationBps } : amm,
      recentActions: actions,
    };
  }

  static async listActions({ limit = 20 } = {}) {
    if (!query) return [];
    await ensureTables();
    const { rows } = await query('SELECT * FROM floor_redemption_os_actions ORDER BY created_at DESC LIMIT $1', [Math.min(200, Math.max(1, Number(limit) || 20))]);
    return rows;
  }

  // ─── Fund ────────────────────────────────────────────────────────────────

  /**
   * Fund the reserve with `amount` canonical (defaults to the coverage
   * shortfall toward FLOOR_REDEMPTION_OS_TARGET_COVERAGE_BPS, capped). The
   * operator wallet is the only source: when it is short, an on-ramp
   * operation is proposed through TreasuryOnRampBridgeEngine and the result is
   * `awaiting_funds` until real canonical lands in the wallet.
   */
  static async fund({ amount, onRamp = true } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) { const e = new Error('Floor Redemption OS is disabled (FLOOR_REDEMPTION_OS_ENABLED)'); e.status = 409; e.code = 'DISABLED'; throw e; }
    const mode = cfg.shadow ? 'shadow' : 'live';
    const contract = await this.getContractRecord();
    if (!contract) return { status: 'no_contract', mode };
    const reserveDecimals = Number(contract.reserve_decimals);

    let target;
    if (amount != null) {
      target = viem.parseUnits(String(amount), reserveDecimals);
    } else {
      if (cfg.shadow) return { status: 'shadow', mode, note: 'amount required in shadow mode; coverage shortfall needs a chain read' };
      const [c, supply] = await Promise.all([
        this._readContract(cfg, contract.contract_address),
        PtcStablecoinEngine.totalSupply().then((s) => viem.parseUnits(String(s || '0'), TRUST_TOKEN_DECIMALS)),
      ]);
      const needed = this.quoteRedeem({ trustRaw: (supply * BigInt(cfg.targetCoverageBps)) / 10_000n, floorPriceRaw: c.floorPrice, reserveDecimals });
      target = needed > c.reserve ? needed - c.reserve : 0n;
    }
    const cap = viem.parseUnits(String(cfg.maxFundUsd), reserveDecimals);
    if (target > cap) target = cap;
    if (target === 0n) return { status: 'covered', mode, amount: 0 };

    const action = { id: newId(), contractAddress: contract.contract_address, kind: 'fund', mode, status: mode, amountCanonical: target, detail: { asset: cfg.reserveAsset } };
    if (cfg.shadow) {
      await this._recordAction(action);
      return { status: 'shadow', mode, amount: fmt(target, reserveDecimals), amountRaw: target.toString(), asset: cfg.reserveAsset };
    }

    const balance = await this._operatorBalance(cfg, contract.reserve_token);
    if (balance < target) {
      const shortfall = target - balance;
      let onRampOperation = null;
      let onRampError = null;
      if (onRamp && TreasuryOnRampBridgeEngine) {
        try {
          onRampOperation = await TreasuryOnRampBridgeEngine.propose({
            sourceType: cfg.onRampSourceType,
            sourceAccountId: cfg.onRampSourceAccountId,
            amount: String(fmt(shortfall, reserveDecimals)),
            internalAsset: 'DLB-PTCUSD',
            internalAmount: String(fmt(shortfall, reserveDecimals)),
            targetAsset: cfg.reserveAsset,
            sourceMethod: cfg.onRampMethod,
            recipient: cfg.operatorAddress,
            createdBy: 'floor-redemption-os',
          });
        } catch (e) { onRampError = e.message; }
      }
      action.status = 'awaiting_funds';
      action.error = `operator holds ${fmt(balance, reserveDecimals)} ${cfg.reserveAsset}, needs ${fmt(target, reserveDecimals)}`;
      action.detail = { ...action.detail, shortfallRaw: shortfall.toString(), onRampOperation, onRampError };
      await this._recordAction(action);
      return {
        status: 'awaiting_funds', mode, asset: cfg.reserveAsset,
        needed: fmt(target, reserveDecimals), available: fmt(balance, reserveDecimals), shortfall: fmt(shortfall, reserveDecimals),
        onRampOperation, onRampError, error: action.error,
      };
    }

    try {
      const { publicClient, walletClient, fees } = clients(cfg);
      const { abi } = getArtifact();
      const txHashes = [];
      const ap = await this._approve(cfg, contract.reserve_token, contract.contract_address, target);
      if (ap) txHashes.push(ap);
      const hash = await walletClient.writeContract({ address: contract.contract_address, abi, functionName: 'fundReserve', args: [target], ...fees });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
      if (receipt.status !== 'success') throw new Error(`fundReserve failed: ${hash}`);
      txHashes.push(receipt.transactionHash || hash);
      action.status = 'completed';
      action.txHashes = txHashes;
      await this._recordAction(action);
      return { status: 'completed', mode, asset: cfg.reserveAsset, amount: fmt(target, reserveDecimals), txHashes };
    } catch (e) {
      action.status = 'failed';
      action.error = e.message;
      await this._recordAction(action);
      throw e;
    }
  }

  // ─── Redeem ──────────────────────────────────────────────────────────────

  /** Operator redeems `amount` DLB-PTCUSD at the floor, canonical paid to `to` (default operator). */
  static async redeem({ amount, to } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) { const e = new Error('Floor Redemption OS is disabled (FLOOR_REDEMPTION_OS_ENABLED)'); e.status = 409; e.code = 'DISABLED'; throw e; }
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    const mode = cfg.shadow ? 'shadow' : 'live';
    const contract = await this.getContractRecord();
    if (!contract) return { status: 'no_contract', mode };
    const reserveDecimals = Number(contract.reserve_decimals);
    const trustRaw = viem.parseUnits(String(amount), TRUST_TOKEN_DECIMALS);
    const recipient = to && isAddress(to) ? to : cfg.operatorAddress;
    const floorRaw = BigInt(contract.floor_price || cfg.floorPriceRaw);
    const expected = this.quoteRedeem({ trustRaw, floorPriceRaw: floorRaw, reserveDecimals });
    const action = { id: newId(), contractAddress: contract.contract_address, kind: 'redeem', mode, status: mode, amountTrust: trustRaw, amountCanonical: expected, detail: { to: recipient } };
    if (cfg.shadow) {
      await this._recordAction(action);
      return { status: 'shadow', mode, amount: Number(amount), canonicalOut: fmt(expected, reserveDecimals), to: recipient };
    }
    const c = await this._readContract(cfg, contract.contract_address);
    const canonicalOut = this.quoteRedeem({ trustRaw, floorPriceRaw: c.floorPrice, reserveDecimals });
    if (c.reserve < canonicalOut) {
      action.status = 'awaiting_funds';
      action.error = `reserve holds ${fmt(c.reserve, reserveDecimals)} ${cfg.reserveAsset}, redemption needs ${fmt(canonicalOut, reserveDecimals)}`;
      await this._recordAction(action);
      return { status: 'awaiting_funds', mode, needed: fmt(canonicalOut, reserveDecimals), available: fmt(c.reserve, reserveDecimals), error: action.error };
    }
    const trustBal = await this._operatorBalance(cfg, contract.trust_token);
    if (trustBal < trustRaw) throw new Error(`Insufficient DLB-PTCUSD: ${fmt(trustBal, 18)} < ${amount}`);
    try {
      const { publicClient, walletClient, fees } = clients(cfg);
      const { abi } = getArtifact();
      const txHashes = [];
      const ap = await this._approve(cfg, contract.trust_token, contract.contract_address, trustRaw);
      if (ap) txHashes.push(ap);
      const hash = await walletClient.writeContract({ address: contract.contract_address, abi, functionName: 'redeem', args: [trustRaw, recipient], ...fees });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
      if (receipt.status !== 'success') throw new Error(`redeem failed: ${hash}`);
      txHashes.push(receipt.transactionHash || hash);
      action.status = 'completed';
      action.txHashes = txHashes;
      action.amountCanonical = canonicalOut;
      await this._recordAction(action);
      return { status: 'completed', mode, amount: Number(amount), canonicalOut: fmt(canonicalOut, reserveDecimals), to: recipient, txHashes };
    } catch (e) {
      action.status = 'failed';
      action.error = e.message;
      await this._recordAction(action);
      throw e;
    }
  }

  // ─── Arbitrage / peg defense ─────────────────────────────────────────────

  /**
   * Size an arbitrage against a StableSwap pool state: spend canonical on the
   * AMM while DLB-PTCUSD is cheaper than the floor by at least `minSpreadBps`
   * net of fee, then redeem at the floor. Amounts are raw; `reserveRaw` bounds
   * the redemption so the reserve is never overdrawn.
   */
  static planArb({ reserves, rates, A, feeBps, trustIndex, floorPriceRaw, reserveDecimals, reserveRaw, canonicalBalanceRaw, minSpreadBps, maxArbRaw }) {
    if (!StableSwapMath) throw new Error('AmmOsEngine not available');
    const canonicalIndex = trustIndex === 0 ? 1 : 0;
    const price0in1 = StableSwapMath.price({ reserves, rates, A });
    const ammPrice = trustIndex === 1 && price0in1 > 0n ? (PRECISION * PRECISION) / price0in1 : price0in1;
    const floorPrice = BigInt(floorPriceRaw);
    if (ammPrice === 0n) return { actionable: false, reason: 'amm has no liquidity', ammPrice: 0, spreadBps: 0 };
    const spreadBps = Number(((floorPrice - ammPrice) * 10_000n) / floorPrice);
    if (spreadBps <= 0) return { actionable: false, reason: 'amm price at or above floor', ammPrice: Number(ammPrice) / 1e18, spreadBps };
    if (spreadBps - Number(feeBps) < Number(minSpreadBps)) return { actionable: false, reason: `spread ${spreadBps} bps below threshold ${minSpreadBps} + fee ${feeBps}`, ammPrice: Number(ammPrice) / 1e18, spreadBps };

    // Spend up to the cap / wallet balance; bring the pool to parity at most.
    let spend = StableSwapMath.rebalanceAmountIn({ reserves, rates, i: canonicalIndex });
    if (spend > BigInt(maxArbRaw)) spend = BigInt(maxArbRaw);
    if (spend > BigInt(canonicalBalanceRaw)) spend = BigInt(canonicalBalanceRaw);
    if (spend <= 0n) {
      return { actionable: false, status: BigInt(canonicalBalanceRaw) === 0n ? 'awaiting_funds' : 'no_size', reason: BigInt(canonicalBalanceRaw) === 0n ? 'operator holds no canonical to buy with' : 'no size', ammPrice: Number(ammPrice) / 1e18, spreadBps };
    }
    // Only buy what the reserve can redeem: canonical value of the reserve at the AMM price.
    let awaitingFunds = false;
    let reserveShortfall = 0n;
    const reserveCapSpend = (BigInt(reserveRaw) * ammPrice) / floorPrice;
    if (spend > reserveCapSpend) {
      awaitingFunds = true;
      reserveShortfall = (spend * floorPrice) / ammPrice - BigInt(reserveRaw);
      spend = reserveCapSpend;
    }
    if (spend <= 0n) {
      return { actionable: false, status: 'awaiting_funds', reason: 'floor reserve holds no canonical to redeem against', ammPrice: Number(ammPrice) / 1e18, spreadBps, reserveRaw: BigInt(reserveRaw).toString() };
    }
    const q = StableSwapMath.quote({ reserves, rates, A, feeBps, i: canonicalIndex, amountIn: spend });
    let trustBought = q.amountOut;
    let redeemOut = this.quoteRedeem({ trustRaw: trustBought, floorPriceRaw: floorPrice, reserveDecimals });
    if (redeemOut > BigInt(reserveRaw)) {
      // Curve rounding can still overshoot slightly; redeem only what the reserve honours.
      const affordable = (BigInt(reserveRaw) * (10n ** BigInt(18 - reserveDecimals)) * PRECISION) / floorPrice;
      trustBought = affordable < trustBought ? affordable : trustBought;
      redeemOut = this.quoteRedeem({ trustRaw: trustBought, floorPriceRaw: floorPrice, reserveDecimals });
    }
    const profit = redeemOut - spend;
    return {
      actionable: profit > 0n,
      status: profit <= 0n ? 'unprofitable' : awaitingFunds ? 'awaiting_funds' : 'arb',
      reserveLimited: awaitingFunds,
      ammPrice: Number(ammPrice) / 1e18,
      floorPrice: Number(floorPrice) / 1e18,
      spreadBps,
      spendRaw: spend.toString(),
      spend: fmt(spend, reserveDecimals),
      trustBoughtRaw: q.amountOut.toString(),
      trustBought: fmt(q.amountOut, 18),
      redeemTrustRaw: trustBought.toString(),
      redeemOutRaw: redeemOut.toString(),
      redeemOut: fmt(redeemOut, reserveDecimals),
      profitRaw: profit.toString(),
      profit: fmt(profit, reserveDecimals),
      reserveShortfallRaw: reserveShortfall.toString(),
      reserveShortfall: fmt(reserveShortfall, reserveDecimals),
      priceAfter: Number(trustIndex === 1 && q.priceAfter > 0n ? (PRECISION * PRECISION) / q.priceAfter : q.priceAfter) / 1e18,
    };
  }

  static async _book(cfg, action, profitRaw, reserveDecimals) {
    if (!TrustAccountingEngine || !(profitRaw > 0n)) return null;
    const usd = round6(fmt(profitRaw, reserveDecimals));
    const entry = await TrustAccountingEngine.postJournalEntry({
      entryDate: new Date().toISOString().slice(0, 10),
      description: `Floor Redemption OS arbitrage ${action.id} — spread captured in ${cfg.reserveAsset}`,
      lines: [
        { accountCode: cfg.assetAccount, debitAmount: usd, creditAmount: 0, description: `${cfg.reserveAsset} received from floor redemption` },
        { accountCode: cfg.arbIncomeAccount, debitAmount: 0, creditAmount: usd, description: 'Peg-defense arbitrage income' },
      ],
      referenceType: RECORD_TYPE,
      referenceId: action.id,
      postedBy: 'floor-redemption-os',
      postToFineract: false,
    });
    return entry && (entry.id || entry.journal_entry_id || entry.entryId) ? String(entry.id || entry.journal_entry_id || entry.entryId) : null;
  }

  static async _notarize(cfg, action, payload) {
    if (!FabricLedgerEngine) return null;
    const row = await FabricLedgerEngine.notarize({
      recordType: RECORD_TYPE,
      recordId: action.id,
      payload,
      metadata: { pipeline: 'floor-redemption-os', chainId: cfg.chainId },
      notarizedBy: 'floor-redemption-os',
    });
    return row && row.id ? String(row.id) : null;
  }

  /**
   * One peg-defense pass: read the AMM and the reserve, plan the arbitrage,
   * and — live only — buy DLB-PTCUSD on the AMM then redeem it at the floor.
   * Books the spread as income and notarizes the pass.
   */
  static async arbCycle() {
    const cfg = this.getConfig();
    if (!cfg.enabled) { const e = new Error('Floor Redemption OS is disabled (FLOOR_REDEMPTION_OS_ENABLED)'); e.status = 409; e.code = 'DISABLED'; throw e; }
    const mode = cfg.shadow ? 'shadow' : 'live';
    const contract = await this.getContractRecord();
    if (!contract) return { status: 'no_contract', mode };
    if (!AmmOsEngine) return { status: 'no_amm', mode };
    const pool = await AmmOsEngine.getPoolRecord();
    if (!pool) return { status: 'no_amm', mode };
    const ammCfg = AmmOsEngine.getConfig();
    if (ammCfg.canonicalAddress.toLowerCase() !== String(contract.reserve_token).toLowerCase()) {
      return { status: 'asset_mismatch', mode, ammCanonical: ammCfg.canonicalAsset, reserveAsset: cfg.reserveAsset };
    }
    const reserveDecimals = Number(contract.reserve_decimals);
    const t = AmmOsEngine._tokens(ammCfg);
    const rates = [10n ** BigInt(18 - t.decimals0), 10n ** BigInt(18 - t.decimals1)];
    const [chainPool, c, canonicalBalance] = await Promise.all([
      AmmOsEngine._readPool(ammCfg, pool.pool_address),
      this._readContract(cfg, contract.contract_address),
      cfg.shadow ? Promise.resolve(null) : this._operatorBalance(cfg, contract.reserve_token),
    ]);
    const maxArbRaw = viem.parseUnits(String(cfg.maxArbUsd), reserveDecimals);
    const plan = this.planArb({
      reserves: chainPool.reserves, rates, A: chainPool.A, feeBps: chainPool.feeBps, trustIndex: t.trustIndex,
      floorPriceRaw: c.floorPrice, reserveDecimals, reserveRaw: c.reserve,
      canonicalBalanceRaw: canonicalBalance === null ? maxArbRaw : canonicalBalance,
      minSpreadBps: cfg.minSpreadBps, maxArbRaw,
    });
    const action = {
      id: newId(), contractAddress: contract.contract_address, kind: 'arb', mode, status: mode,
      amountTrust: plan.trustBoughtRaw || null, amountCanonical: plan.spendRaw || null, spreadBps: plan.spreadBps, profitCanonical: plan.profitRaw || null,
      detail: { plan, poolAddress: pool.pool_address, paused: c.paused },
    };
    if (!plan.actionable) {
      action.status = plan.status === 'awaiting_funds' ? 'awaiting_funds' : 'hold';
      await this._recordAction(action);
      return { status: action.status, mode, plan };
    }
    if (c.paused) {
      action.status = 'paused';
      await this._recordAction(action);
      return { status: 'paused', mode, plan };
    }
    if (cfg.shadow) {
      await this._recordAction(action);
      return { status: 'shadow', mode, plan };
    }
    if (plan.status === 'awaiting_funds' && BigInt(plan.redeemTrustRaw) === 0n) {
      action.status = 'awaiting_funds';
      action.error = `reserve holds ${fmt(c.reserve, reserveDecimals)} ${cfg.reserveAsset}; fund the reserve before redeeming`;
      await this._recordAction(action);
      return { status: 'awaiting_funds', mode, plan, error: action.error };
    }

    const txHashes = [];
    try {
      const { publicClient, walletClient, fees } = clients(cfg);
      const ammAbi = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'artifacts', 'contracts_StableAmmPool_sol_StableAmmPool.abi'), 'utf8'));
      const { abi } = getArtifact();
      const spend = BigInt(plan.spendRaw);
      const minOut = (BigInt(plan.trustBoughtRaw) * (10_000n - BigInt(ammCfg.slippageBps))) / 10_000n;

      const ap1 = await this._approve(cfg, contract.reserve_token, pool.pool_address, spend);
      if (ap1) txHashes.push(ap1);
      const buy = await walletClient.writeContract({ address: pool.pool_address, abi: ammAbi, functionName: 'swap', args: [contract.reserve_token, spend, minOut, cfg.operatorAddress], ...fees });
      const buyReceipt = await publicClient.waitForTransactionReceipt({ hash: buy, timeout: 120000 });
      if (buyReceipt.status !== 'success') throw new Error(`AMM buy failed: ${buy}`);
      txHashes.push(buyReceipt.transactionHash || buy);

      const redeemTrust = BigInt(plan.redeemTrustRaw);
      const ap2 = await this._approve(cfg, contract.trust_token, contract.contract_address, redeemTrust);
      if (ap2) txHashes.push(ap2);
      const red = await walletClient.writeContract({ address: contract.contract_address, abi, functionName: 'redeem', args: [redeemTrust, cfg.operatorAddress], ...fees });
      const redReceipt = await publicClient.waitForTransactionReceipt({ hash: red, timeout: 120000 });
      if (redReceipt.status !== 'success') throw new Error(`floor redeem failed: ${red}`);
      txHashes.push(redReceipt.transactionHash || red);

      const profitRaw = BigInt(plan.redeemOutRaw) - spend;
      action.status = plan.status === 'awaiting_funds' ? 'partial_awaiting_funds' : 'completed';
      action.txHashes = txHashes;
      action.profitCanonical = profitRaw;
      try { action.journalEntryId = await this._book(cfg, action, profitRaw, reserveDecimals); } catch (e) { action.detail.bookingError = e.message; }
      try { action.fabricRecordId = await this._notarize(cfg, action, { actionId: action.id, plan, txHashes, profitRaw: profitRaw.toString() }); } catch (e) { action.detail.notarizeError = e.message; }
      await this._recordAction(action);
      return { status: action.status, mode, plan, txHashes, profit: fmt(profitRaw, reserveDecimals), journalEntryId: action.journalEntryId, fabricRecordId: action.fabricRecordId };
    } catch (e) {
      action.status = 'failed';
      action.error = e.message;
      action.txHashes = txHashes;
      await this._recordAction(action);
      throw e;
    }
  }
}

module.exports = { FloorRedemptionOsEngine };
