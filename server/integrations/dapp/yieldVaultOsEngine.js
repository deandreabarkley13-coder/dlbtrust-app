/**
 * Yield Vault OS Engine
 *
 * Turns real trust income into pro-rata distributions of the trust token
 * (DLB-PTCUSD) or canonical USDC:
 *
 *   sources      bond accrued interest (LiveBondEngine / BondEngine),
 *                LP yield accrued on market-maker positions
 *                (InternalMarketMakerEngine.accrueYield), and reserve surplus
 *                held by the PTC vault above DLB-PTCUSD supply
 *   plan         distributable = income sourced minus income already paid out;
 *                split between LP positions (by lp_balance) and token holders
 *                (beneficiary expense wallets + configured holders, by balance)
 *   distribute   transfers per recipient, one journal entry per cycle
 *                (TrustAccountingEngine), Fabric notarization of the cycle
 *
 * Shadow-by-default: the plan is computed and persisted with every amount, but
 * no token moves until YIELD_VAULT_OS_SHADOW=false, DAPP_SHADOW is not set live
 * and — when the thirdweb signer is active — THIRDWEB_SERVER_WALLET_LIVE=true.
 * YIELD_VAULT_OS_ENABLED=false is the kill switch for the whole engine.
 */

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
let InternalMarketMakerEngine = null;
try { ({ InternalMarketMakerEngine } = require('./internalMarketMakerEngine')); } catch (e) { /* optional */ }
let BeneficiaryExpenseWalletEngine = null;
try { ({ BeneficiaryExpenseWalletEngine } = require('./beneficiaryExpenseWalletEngine')); } catch (e) { /* optional */ }
let LiveBondEngine = null;
try { ({ LiveBondEngine } = require('../bonds/liveEngine')); } catch (e) { /* optional */ }
let BondEngine = null;
try { ({ BondEngine } = require('../bonds/bondEngine')); } catch (e) { /* optional */ }
let TrustAccountingEngine = null;
try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { /* optional */ }
let FabricLedgerEngine = null;
try { ({ FabricLedgerEngine } = require('../hyperledger/fabricLedgerEngine')); } catch (e) { /* optional */ }

const RECORD_TYPE = 'yield_vault_os_cycle';
const TRUST_TOKEN_DECIMALS = 18;
const SOURCES = ['bond_interest', 'lp_yield', 'reserve_surplus'];

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address', name: 'account' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'transfer', inputs: [{ type: 'address', name: 'to' }, { type: 'uint256', name: 'amount' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
];

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function num(name, def) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : def; }
function bool(name, def = false) { const v = process.env[name]; return v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(v); }
function list(name) { return str(name).split(',').map((s) => s.trim()).filter(Boolean); }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function round6(n) { return Math.round((Number(n) || 0) * 1e6) / 1e6; }
function isAddress(v) { return /^0x[0-9a-fA-F]{40}$/.test(String(v || '')); }
function newId() { return `YVO-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }
function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }

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
    CREATE TABLE IF NOT EXISTS yield_vault_os_cycles (
      id            TEXT PRIMARY KEY,
      status        TEXT NOT NULL,
      mode          TEXT NOT NULL,
      payout_asset  TEXT NOT NULL,
      chain_id      INTEGER,
      distributable NUMERIC(20,6) NOT NULL DEFAULT 0,
      distributed   NUMERIC(20,6) NOT NULL DEFAULT 0,
      sources       JSONB DEFAULT '{}',
      plan          JSONB DEFAULT '{}',
      result        JSONB DEFAULT '{}',
      journal_entry_id TEXT,
      fabric_record_id TEXT,
      error         TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS yield_vault_os_distributions (
      id            TEXT PRIMARY KEY,
      cycle_id      TEXT NOT NULL REFERENCES yield_vault_os_cycles(id),
      recipient     TEXT NOT NULL,
      recipient_class TEXT NOT NULL,
      weight        NUMERIC(38,0) NOT NULL DEFAULT 0,
      amount        NUMERIC(20,6) NOT NULL,
      payout_asset  TEXT NOT NULL,
      tx_hash       TEXT,
      status        TEXT NOT NULL,
      metadata      JSONB DEFAULT '{}',
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query('CREATE INDEX IF NOT EXISTS yield_vault_os_distributions_cycle_idx ON yield_vault_os_distributions(cycle_id)');
  tablesReady = true;
}

/**
 * Split `total` across `weights` ([{ key, weight: bigint }]) proportionally,
 * rounding down to 6 decimals and handing the rounding dust to the largest
 * weight so the allocation sums exactly to `total`.
 */
function proRata(total, weights) {
  const positive = weights.filter((w) => w.weight > 0n);
  const sum = positive.reduce((s, w) => s + w.weight, 0n);
  if (sum === 0n || !(total > 0)) return positive.map((w) => ({ ...w, amount: 0 }));
  const totalMicro = BigInt(Math.floor(round6(total) * 1e6));
  let allocated = 0n;
  const out = positive.map((w) => {
    const micro = (totalMicro * w.weight) / sum;
    allocated += micro;
    return { ...w, micro };
  });
  let largest = out[0];
  for (const o of out) if (o.weight > largest.weight) largest = o;
  largest.micro += totalMicro - allocated;
  return out.map(({ micro, ...w }) => ({ ...w, amount: Number(micro) / 1e6 }));
}

class YieldVaultOsEngine {
  static getConfig() {
    const cfg = getConfig();
    const wallet = ThirdwebServerWalletEngine.getConfig();
    const signerActive = ThirdwebChainSigner.active();
    const shadow = bool('YIELD_VAULT_OS_SHADOW', true) || cfg.dappShadow === true || (signerActive && !wallet.live);
    const payoutAsset = str('YIELD_VAULT_OS_PAYOUT_ASSET', 'DLB-PTCUSD').toUpperCase();
    return {
      enabled: bool('YIELD_VAULT_OS_ENABLED', true),
      shadow,
      signer: signerActive ? 'thirdweb' : 'private-key',
      walletLive: wallet.live,
      chainId: Number(cfg.chainId),
      rpcUrl: cfg.rpcUrl,
      privateKey: cfg.privateKey,
      operatorAddress: operatorAddress(cfg) || '',
      payoutAsset: payoutAsset === 'USDC' ? 'USDC' : 'DLB-PTCUSD',
      usdcAddress: cfg.usdcAddress,
      // Share of each cycle routed to LP positions; the remainder goes to token holders.
      lpShareBps: Math.min(10000, Math.max(0, num('YIELD_VAULT_OS_LP_SHARE_BPS', 3000))),
      // Extra token-holder addresses weighted by DLB-PTCUSD balance, alongside beneficiary expense wallets.
      holders: list('YIELD_VAULT_OS_HOLDERS').filter(isAddress),
      minDistributionUsd: num('YIELD_VAULT_OS_MIN_DISTRIBUTION_USD', 1),
      maxDistributionUsd: num('YIELD_VAULT_OS_MAX_DISTRIBUTION_USD', 1000),
      // Fraction of vault reserve surplus considered distributable per cycle (bps of surplus).
      reserveSurplusBps: Math.min(10000, Math.max(0, num('YIELD_VAULT_OS_RESERVE_SURPLUS_BPS', 0))),
      expenseAccount: str('YIELD_VAULT_OS_EXPENSE_ACCOUNT', '5100'),
      assetAccount: str('STABLECOIN_ASSET_ACCOUNT', '1210'),
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.enabled) issues.push('YIELD_VAULT_OS_ENABLED is not true');
    if (!PtcStablecoinEngine) issues.push('PtcStablecoinEngine not available');
    else if (!PtcStablecoinEngine.state().tokenAddress) issues.push('PTC stablecoin not deployed');
    if (!InternalMarketMakerEngine) issues.push('InternalMarketMakerEngine not available');
    if (!query) issues.push('Postgres not available');
    if (!cfg.shadow) {
      if (cfg.signer === 'thirdweb') issues.push(...ThirdwebChainSigner.readiness().issues);
      else if (!cfg.privateKey) issues.push('DAPP_PRIVATE_KEY not configured');
      if (!cfg.rpcUrl) issues.push('DAPP_RPC_URL not configured');
      if (!cfg.operatorAddress) issues.push('operator address unknown (DAPP_OPERATOR_ADDRESS or THIRDWEB_SERVER_WALLET_ADDRESS)');
      if (cfg.payoutAsset === 'USDC' && !cfg.usdcAddress) issues.push('DAPP_USDC_ADDRESS not configured');
    }
    return {
      provider: 'yield-vault-os',
      ready: issues.length === 0,
      mode: cfg.shadow ? 'shadow' : 'live',
      enabled: cfg.enabled,
      signer: cfg.signer,
      walletLive: cfg.walletLive,
      payoutAsset: cfg.payoutAsset,
      chainId: cfg.chainId,
      issues,
    };
  }

  // ─── Income sources ──────────────────────────────────────────────────────

  static async _bondInterest() {
    if (!BondEngine) return { total: 0, detail: [], error: 'BondEngine unavailable' };
    try {
      const bonds = await BondEngine.listBonds();
      const detail = [];
      let total = 0;
      for (const b of bonds) {
        let accrued = Number(b.accrued_interest || 0);
        if (LiveBondEngine && typeof LiveBondEngine.getBondLiveMetrics === 'function') {
          try {
            const m = await LiveBondEngine.getBondLiveMetrics(b.id);
            if (m && Number.isFinite(Number(m.accrued_interest_total))) accrued = Number(m.accrued_interest_total);
          } catch (e) { /* fall back to ledger accrual */ }
        }
        detail.push({ bondId: b.id, name: b.bond_name || b.name || null, accrued: round2(accrued) });
        total += accrued;
      }
      return { total: round2(total), detail };
    } catch (e) {
      return { total: 0, detail: [], error: e.message };
    }
  }

  static async _lpYield() {
    if (!InternalMarketMakerEngine) return { total: 0, detail: [], error: 'InternalMarketMakerEngine unavailable' };
    try {
      const positions = await InternalMarketMakerEngine.listPositions();
      const detail = [];
      let total = 0;
      for (const p of positions) {
        const raw = BigInt(String(p.accrued_yield || '0').split('.')[0] || '0');
        const usd = Number(raw) / 10 ** TRUST_TOKEN_DECIMALS;
        detail.push({ positionId: p.id, poolId: p.pool_id, holder: p.holder, lpBalance: String(p.lp_balance || '0'), accrued: round6(usd) });
        total += usd;
      }
      return { total: round2(total), detail };
    } catch (e) {
      return { total: 0, detail: [], error: e.message };
    }
  }

  static async _reserveSurplus(cfg) {
    if (!PtcStablecoinEngine) return { total: 0, surplus: 0, error: 'PtcStablecoinEngine unavailable' };
    try {
      const [supplyStr, reserves] = await Promise.all([
        PtcStablecoinEngine.totalSupply(),
        PtcStablecoinEngine.reserveBalances(),
      ]);
      const supply = Number(supplyStr || 0);
      const reserveUsd = reserves.reduce((s, r) => s + Number(r.vaultBalanceFormatted || 0) * Number(r.priceUsd || r.price || 1), 0);
      const surplus = Math.max(0, reserveUsd - supply);
      return { total: round2(surplus * cfg.reserveSurplusBps / 10000), surplus: round2(surplus), supply: round2(supply), reserveUsd: round2(reserveUsd) };
    } catch (e) {
      return { total: 0, surplus: 0, error: e.message };
    }
  }

  static async _alreadyDistributed() {
    const out = Object.fromEntries(SOURCES.map((s) => [s, 0]));
    if (!query) return out;
    await ensureTables();
    const { rows } = await query(
      `SELECT sources FROM yield_vault_os_cycles WHERE status IN ('completed', 'shadow')`
    );
    for (const r of rows) {
      const used = (r.sources && r.sources.used) || {};
      for (const s of SOURCES) out[s] += Number(used[s] || 0);
    }
    return out;
  }

  /** Income sourced so far, what has already been paid out of it, and what remains. */
  static async sources() {
    const cfg = this.getConfig();
    const [bond, lp, reserve, paid] = await Promise.all([
      this._bondInterest(), this._lpYield(), this._reserveSurplus(cfg), this._alreadyDistributed(),
    ]);
    const gross = { bond_interest: bond.total, lp_yield: lp.total, reserve_surplus: reserve.total };
    const available = Object.fromEntries(SOURCES.map((s) => [s, round2(Math.max(0, gross[s] - paid[s]))]));
    return {
      gross, paid, available,
      distributable: round2(SOURCES.reduce((s, k) => s + available[k], 0)),
      detail: { bond, lp, reserve },
    };
  }

  // ─── Recipients ──────────────────────────────────────────────────────────

  static async _lpWeights() {
    if (!InternalMarketMakerEngine) return [];
    const positions = await InternalMarketMakerEngine.listPositions().catch(() => []);
    const byHolder = new Map();
    for (const p of positions) {
      if (!isAddress(p.holder)) continue;
      const lp = BigInt(String(p.lp_balance || '0').split('.')[0] || '0');
      const key = p.holder.toLowerCase();
      byHolder.set(key, (byHolder.get(key) || 0n) + lp);
    }
    return [...byHolder.entries()].map(([recipient, weight]) => ({ recipient, class: 'lp', weight }));
  }

  static async _holderWeights(cfg) {
    const addresses = new Set(cfg.holders.map((a) => a.toLowerCase()));
    if (BeneficiaryExpenseWalletEngine) {
      const wallets = await BeneficiaryExpenseWalletEngine.listWallets().catch(() => []);
      for (const w of wallets) {
        const addr = w.smartAccountAddress || w.address;
        if (isAddress(addr)) addresses.add(addr.toLowerCase());
      }
    }
    if (cfg.operatorAddress) addresses.delete(cfg.operatorAddress.toLowerCase());
    const out = [];
    for (const recipient of addresses) {
      let weight = 0n;
      if (PtcStablecoinEngine) {
        const bal = await PtcStablecoinEngine.balanceOf(recipient).catch(() => '0');
        weight = viem ? viem.parseUnits(String(bal || '0'), TRUST_TOKEN_DECIMALS) : BigInt(Math.floor(Number(bal || 0) * 1e6));
      }
      out.push({ recipient, class: 'holder', weight });
    }
    return out;
  }

  /**
   * Allocate `total` between LP positions and holders. When one class has no
   * weight its share falls through to the other so nothing is stranded.
   */
  static allocate({ total, lpWeights, holderWeights, lpShareBps }) {
    const lpEligible = lpWeights.some((w) => w.weight > 0n);
    const holderEligible = holderWeights.some((w) => w.weight > 0n);
    if (!lpEligible && !holderEligible) return [];
    let lpTotal = round6(total * lpShareBps / 10000);
    let holderTotal = round6(total - lpTotal);
    if (!lpEligible) { holderTotal = round6(total); lpTotal = 0; }
    if (!holderEligible) { lpTotal = round6(total); holderTotal = 0; }
    return [
      ...proRata(lpTotal, lpWeights),
      ...proRata(holderTotal, holderWeights),
    ].filter((a) => a.amount > 0).map((a) => ({ ...a, weight: String(a.weight) }));
  }

  static async plan() {
    const cfg = this.getConfig();
    const sources = await this.sources();
    const [lpWeights, holderWeights] = await Promise.all([this._lpWeights(), this._holderWeights(cfg)]);
    const capped = Math.min(sources.distributable, cfg.maxDistributionUsd);
    const total = capped >= cfg.minDistributionUsd ? round2(capped) : 0;
    const allocations = this.allocate({ total, lpWeights, holderWeights, lpShareBps: cfg.lpShareBps });
    const distributed = round6(allocations.reduce((s, a) => s + a.amount, 0));
    // Consume sources in order so `used` records exactly which income paid the cycle.
    const used = {};
    let remaining = distributed;
    for (const s of SOURCES) {
      const take = Math.min(remaining, sources.available[s]);
      used[s] = round6(take);
      remaining = round6(remaining - take);
    }
    let reason = null;
    if (!cfg.enabled) reason = 'disabled';
    else if (sources.distributable < cfg.minDistributionUsd) reason = `distributable ${sources.distributable} below minimum ${cfg.minDistributionUsd}`;
    else if (!allocations.length) reason = 'no eligible recipients (no LP positions or holders with balance)';
    return {
      mode: cfg.shadow ? 'shadow' : 'live',
      enabled: cfg.enabled,
      payoutAsset: cfg.payoutAsset,
      chainId: cfg.chainId,
      sources: { ...sources, used },
      lpShareBps: cfg.lpShareBps,
      recipients: { lp: lpWeights.length, holders: holderWeights.length },
      total: distributed,
      allocations,
      actionable: allocations.length > 0 && cfg.enabled,
      reason,
    };
  }

  // ─── Distribution ────────────────────────────────────────────────────────

  static async _payout(cfg, recipient, amount) {
    if (cfg.payoutAsset === 'DLB-PTCUSD') {
      const res = await PtcStablecoinEngine.transfer({ to: recipient, amount: String(amount) });
      return res.txHash || null;
    }
    if (!viem) throw new Error('viem not installed');
    const { publicClient, walletClient, fees } = clients(cfg);
    const hash = await walletClient.writeContract({
      address: cfg.usdcAddress,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [recipient, viem.parseUnits(String(amount), 6)],
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`USDC transfer failed: ${hash}`);
    return receipt.transactionHash || hash;
  }

  static async _book(cfg, cycle) {
    if (!TrustAccountingEngine || !(cycle.distributed > 0)) return null;
    const entry = await TrustAccountingEngine.postJournalEntry({
      entryDate: new Date().toISOString().slice(0, 10),
      description: `Yield Vault OS distribution ${cycle.id} (${cycle.mode}) — ${cycle.payoutAsset}`,
      lines: [
        { accountCode: cfg.expenseAccount, debitAmount: cycle.distributed, creditAmount: 0, description: 'Yield distributed to holders / LPs' },
        { accountCode: cfg.assetAccount, debitAmount: 0, creditAmount: cycle.distributed, description: `${cycle.payoutAsset} paid out` },
      ],
      referenceType: RECORD_TYPE,
      referenceId: cycle.id,
      postedBy: 'yield-vault-os',
      postToFineract: false,
    });
    return entry && (entry.id || entry.journal_entry_id || entry.entryId) ? String(entry.id || entry.journal_entry_id || entry.entryId) : null;
  }

  static async _notarize(cfg, cycle) {
    if (!FabricLedgerEngine) return null;
    const row = await FabricLedgerEngine.notarize({
      recordType: RECORD_TYPE,
      recordId: cycle.id,
      payload: { cycleId: cycle.id, mode: cycle.mode, payoutAsset: cycle.payoutAsset, distributed: cycle.distributed, sources: cycle.sources.used, allocations: cycle.result.allocations },
      metadata: { pipeline: 'yield-vault-os', chainId: cfg.chainId },
      notarizedBy: 'yield-vault-os',
    });
    return row && row.id ? String(row.id) : null;
  }

  static async _persist(cycle) {
    if (!query) return;
    await ensureTables();
    await query(
      `INSERT INTO yield_vault_os_cycles (id, status, mode, payout_asset, chain_id, distributable, distributed, sources, plan, result, journal_entry_id, fabric_record_id, error, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, distributed=EXCLUDED.distributed, sources=EXCLUDED.sources, result=EXCLUDED.result,
         journal_entry_id=EXCLUDED.journal_entry_id, fabric_record_id=EXCLUDED.fabric_record_id, error=EXCLUDED.error, updated_at=NOW()`,
      [cycle.id, cycle.status, cycle.mode, cycle.payoutAsset, cycle.chainId, cycle.distributable, cycle.distributed,
        safeJson(cycle.sources), safeJson(cycle.plan), safeJson(cycle.result), cycle.journalEntryId, cycle.fabricRecordId, cycle.error]
    );
  }

  /**
   * Execute a plan. Without `plan` a fresh one is computed. In shadow mode
   * every allocation is recorded with status `shadow`; live allocations are
   * transferred one by one and the cycle is booked and notarized once.
   */
  static async distribute({ plan } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) { const e = new Error('Yield Vault OS is disabled (YIELD_VAULT_OS_ENABLED)'); e.status = 409; e.code = 'DISABLED'; throw e; }
    const p = plan || await this.plan();
    const cycle = {
      id: newId(),
      status: 'running',
      mode: cfg.shadow ? 'shadow' : 'live',
      payoutAsset: cfg.payoutAsset,
      chainId: cfg.chainId,
      distributable: p.sources.distributable,
      distributed: 0,
      sources: { used: Object.fromEntries(SOURCES.map((s) => [s, 0])), available: p.sources.available },
      plan: p,
      result: { allocations: [] },
      journalEntryId: null,
      fabricRecordId: null,
      error: null,
    };
    if (!p.allocations.length) {
      cycle.status = 'skipped';
      cycle.result.reason = p.reason || 'nothing to distribute';
      await this._persist(cycle);
      return cycle;
    }
    await this._persist(cycle);

    if (!cfg.shadow) {
      const readiness = this.readiness();
      if (!readiness.ready) { cycle.status = 'failed'; cycle.error = readiness.issues.join('; '); await this._persist(cycle); return cycle; }
    }

    let failed = 0;
    for (const a of p.allocations) {
      const row = { id: newId(), recipient: a.recipient, class: a.class, weight: a.weight, amount: a.amount, status: cfg.shadow ? 'shadow' : 'pending', txHash: null, error: null };
      if (!cfg.shadow) {
        try {
          row.txHash = await this._payout(cfg, a.recipient, a.amount);
          row.status = 'completed';
        } catch (e) {
          row.status = 'failed';
          row.error = e.message;
          failed++;
        }
      }
      if (row.status !== 'failed') cycle.distributed = round6(cycle.distributed + a.amount);
      cycle.result.allocations.push(row);
      if (query) {
        await query(
          `INSERT INTO yield_vault_os_distributions (id, cycle_id, recipient, recipient_class, weight, amount, payout_asset, tx_hash, status, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [row.id, cycle.id, row.recipient, row.class, row.weight, row.amount, cfg.payoutAsset, row.txHash, row.status, safeJson({ error: row.error })]
        );
      }
    }

    // Consume income in source order for exactly what was paid (or shadow-recorded).
    let remaining = cycle.distributed;
    for (const s of SOURCES) {
      const take = Math.min(remaining, Number(p.sources.available[s] || 0));
      cycle.sources.used[s] = round6(take);
      remaining = round6(remaining - take);
    }

    try { cycle.journalEntryId = await this._book(cfg, cycle); } catch (e) { cycle.result.bookingError = e.message; }
    try { cycle.fabricRecordId = await this._notarize(cfg, cycle); } catch (e) { cycle.result.notarizeError = e.message; }

    cycle.status = failed === p.allocations.length ? 'failed' : cfg.shadow ? 'shadow' : failed ? 'partial' : 'completed';
    if (failed) cycle.error = `${failed} of ${p.allocations.length} payouts failed`;
    await this._persist(cycle);
    return cycle;
  }

  static async runCycle() {
    const plan = await this.plan();
    if (!plan.actionable) {
      return { skipped: true, reason: plan.reason || 'nothing to distribute', plan };
    }
    const cycle = await this.distribute({ plan });
    return { skipped: false, cycle };
  }

  static async listCycles({ limit = 20 } = {}) {
    if (!query) return [];
    await ensureTables();
    const { rows } = await query('SELECT * FROM yield_vault_os_cycles ORDER BY created_at DESC LIMIT $1', [Math.min(200, Math.max(1, Number(limit) || 20))]);
    return rows;
  }

  static async status() {
    const cfg = this.getConfig();
    const readiness = this.readiness();
    const [sources, cycles] = await Promise.all([
      this.sources().catch((e) => ({ error: e.message, distributable: 0 })),
      this.listCycles({ limit: 10 }).catch(() => []),
    ]);
    const totals = cycles.reduce((acc, c) => {
      if (c.status === 'completed' || c.status === 'partial') acc.live += Number(c.distributed || 0);
      if (c.status === 'shadow') acc.shadow += Number(c.distributed || 0);
      return acc;
    }, { live: 0, shadow: 0 });
    return {
      provider: 'yield-vault-os',
      mode: cfg.shadow ? 'shadow' : 'live',
      enabled: cfg.enabled,
      readiness,
      payoutAsset: cfg.payoutAsset,
      lpShareBps: cfg.lpShareBps,
      limits: { min: cfg.minDistributionUsd, max: cfg.maxDistributionUsd },
      sources,
      recentCycles: cycles,
      totals: { liveDistributed: round2(totals.live), shadowDistributed: round2(totals.shadow) },
    };
  }
}

module.exports = { YieldVaultOsEngine, proRata };
