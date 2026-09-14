'use strict';

/**
 * Live Value Runbook OS — one automated entry point for docs/LIVE_VALUE_RUNBOOK.md §2–§4.
 *
 *   fiat top-up (§4a)  → book in the ERP (§4b) → Base ETH for gas → RWA collateral
 *   draw (maker/checker) → policy-governed settlement → Spritz off-ramp (§4e)
 *
 * This engine is orchestration only: every stage is delegated to the engine that
 * owns it (ThirdwebTreasuryFundingEngine, FundingEngine, CollateralOsEngine,
 * SpritzTreasuryLegEngine, ThirdwebSettlementEngine, TrustControlPlaneEngine).
 * Dependencies are loaded lazily so a missing module degrades to a reported gap.
 *
 *   readiness()   synchronous, config-only view of every runbook gate, shaped like
 *                 SpritzTreasuryLegEngine.pipeline() ({ ready, stages[], errors })
 *   readinessFull() readiness plus live treasury balances and the ERP position
 *   plan()        ordered steps to move `amountUsd`, each canExecute or blocked-with-reason
 *   execute()     runs executable steps in order and STOPS at the first closed gate
 *                 or human step (the §4a hosted checkout, a checker approval).
 *
 * Fail closed, shadow by default: `execute` only broadcasts when `live === true`
 * AND the step's own `*_LIVE` gates are set. Settlement always goes through
 * CollateralOsEngine.settle / executeSettlement (policy contract + Spritz leg),
 * never a raw server-wallet send.
 */

function tryRequire(mod) {
  try { return require(mod); } catch (e) { return null; }
}

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function bool(name, def) { const v = str(name); return v ? v.toLowerCase() === 'true' : def; }
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function fromCents(c) { return (Number(c) || 0) / 100; }

const MIN_GAS_ETH_DEFAULT = 0.003; // FundingEngine.neededEthForFirstTx
const NATIVE = 'eth';

const STEP_KEYS = ['preflight', 'topUp', 'book', 'gas', 'draw', 'fund', 'settle', 'release', 'reconcile'];

const BUCKET_BY_ROLE = Object.freeze({ beneficiary: 'coupon_income', trustee: 'trust_operating' });
const IN_FLIGHT_DRAW = new Set(['proposed', 'funded', 'settling']);

class RunbookError extends Error {
  constructor(message, code = 'RUNBOOK_ERROR', status = 409, details = {}) {
    super(message);
    this.name = 'RunbookError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
    this.details = details;
  }
}

async function attempt(fn) {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: e.message, code: e.code || null }; }
}

class LiveValueRunbookOsEngine {
  static _deps() {
    return {
      TreasuryFunding: tryRequire('../dapp/thirdwebTreasuryFundingEngine')?.ThirdwebTreasuryFundingEngine || null,
      ServerWallet: tryRequire('../dapp/thirdwebServerWalletEngine')?.ThirdwebServerWalletEngine || null,
      Settlement: tryRequire('../dapp/thirdwebSettlementEngine')?.ThirdwebSettlementEngine || null,
      Funding: tryRequire('../dapp/fundingEngine')?.FundingEngine || null,
      GasTank: tryRequire('../dapp/operatorGasTank')?.OperatorGasTank || null,
      AccountAbstraction: tryRequire('../dapp/accountAbstractionEngine')?.AccountAbstractionEngine || null,
      ThirdwebWallet: tryRequire('../dapp/thirdwebWalletEngine')?.ThirdwebWalletEngine || null,
      Collateral: tryRequire('./collateralOsEngine')?.CollateralOsEngine || null,
      SpritzLeg: tryRequire('../spritz/spritzTreasuryLegEngine')?.SpritzTreasuryLegEngine || null,
      ControlPlane: tryRequire('../trust/trustControlPlaneEngine')?.TrustControlPlaneEngine || null,
      CanonicalFunding: tryRequire('../fineract/canonicalFundingSource')?.CanonicalFundingSource || null,
      TrustPolicy: tryRequire('../dapp/trustPolicyEngine')?.TrustPolicyEngine || null,
      DappConfig: tryRequire('../dapp/config') || null,
    };
  }

  /** Every env gate the runbook depends on, read once. */
  static gates() {
    const enforced = bool('TRUST_POLICY_ENFORCED', false);
    return {
      SMART_ROUTER_LIVE: bool('SMART_ROUTER_LIVE', false),
      THIRDWEB_SERVER_WALLET_ENABLED: bool('THIRDWEB_SERVER_WALLET_ENABLED', true),
      THIRDWEB_SERVER_WALLET_LIVE: bool('THIRDWEB_SERVER_WALLET_LIVE', false),
      THIRDWEB_SHADOW: bool('THIRDWEB_SHADOW', true),
      THIRDWEB_GAS_SPONSORSHIP_LIVE: bool('THIRDWEB_GAS_SPONSORSHIP_LIVE', false),
      CANONICAL_FUNDING_LIVE: bool('CANONICAL_FUNDING_LIVE', false),
      FUNDING_LIVE: bool('FUNDING_LIVE', false),
      TRUST_POLICY_ENFORCED: enforced,
      TRUST_POLICY_LIVE: bool('TRUST_POLICY_LIVE', false),
      THIRDWEB_SECRET_KEY: Boolean(str('THIRDWEB_SECRET_KEY')),
      THIRDWEB_SERVER_WALLET_ADDRESS: str('THIRDWEB_SERVER_WALLET_ADDRESS') || null,
      TRUST_POLICY_ADDRESS: str('TRUST_POLICY_ADDRESS') || null,
    };
  }

  static minGasEth() {
    const wei = str('THIRDWEB_SERVER_WALLET_MIN_GAS_WEI');
    if (wei && /^\d+$/.test(wei) && wei !== '0') return Number(BigInt(wei)) / 1e18;
    const n = Number(str('LIVE_VALUE_RUNBOOK_MIN_GAS_ETH'));
    return Number.isFinite(n) && n > 0 ? n : MIN_GAS_ETH_DEFAULT;
  }

  /** Whether live execution is even possible for the whole path (config only). */
  static liveGatesOpen(g = this.gates()) {
    const closed = [];
    if (!g.THIRDWEB_SECRET_KEY) closed.push('THIRDWEB_SECRET_KEY');
    if (!g.THIRDWEB_SERVER_WALLET_ENABLED) closed.push('THIRDWEB_SERVER_WALLET_ENABLED');
    if (!g.THIRDWEB_SERVER_WALLET_LIVE) closed.push('THIRDWEB_SERVER_WALLET_LIVE');
    if (g.THIRDWEB_SHADOW) closed.push('THIRDWEB_SHADOW=false');
    if (!g.CANONICAL_FUNDING_LIVE) closed.push('CANONICAL_FUNDING_LIVE');
    if (!g.TRUST_POLICY_LIVE) closed.push('TRUST_POLICY_LIVE');
    return { open: closed.length === 0, closed };
  }

  // ─── readiness ─────────────────────────────────────────────────────────────

  /**
   * Config-only view of every runbook gate. Never throws; a component that
   * cannot be evaluated becomes a blocked stage plus an entry in `errors`.
   */
  static readiness() {
    const d = this._deps();
    const g = this.gates();
    const errors = [];
    const stage = (key, label, ok, detail, blocking = true, extra = {}) => ({ key, label, ok: Boolean(ok), detail: detail || null, blocking, ...extra });
    const safe = (label, fn, fallback = null) => { try { return fn(); } catch (e) { errors.push(`${label}: ${e.message}`); return fallback; } };

    const funding = d.TreasuryFunding ? safe('treasury funding', () => d.TreasuryFunding.readiness()) : null;
    const wallet = d.ServerWallet ? safe('server wallet', () => d.ServerWallet.readiness()) : null;
    const aa = d.ThirdwebWallet ? safe('thirdweb wallet', () => d.ThirdwebWallet.readiness()) : null;
    const canonical = d.CanonicalFunding ? safe('canonical funding', () => d.CanonicalFunding.readiness()) : null;
    const policy = d.TrustPolicy ? safe('trust policy', () => d.TrustPolicy.readiness()) : null;
    const legCfg = d.SpritzLeg ? safe('spritz treasury leg', () => d.SpritzLeg.config()) : null;
    const collateralCfg = d.Collateral ? safe('collateral os', () => d.Collateral.config()) : null;
    const settlement = d.Settlement ? safe('thirdweb settlement', () => d.Settlement.readiness()) : null;

    if (!d.TreasuryFunding) errors.push('ThirdwebTreasuryFundingEngine not available');
    if (!d.Collateral) errors.push('CollateralOsEngine not available');
    if (!d.SpritzLeg) errors.push('SpritzTreasuryLegEngine not available');
    if (!d.ControlPlane) errors.push('TrustControlPlaneEngine not available');

    const signerType = legCfg ? legCfg.payoutWalletSigner : null;
    const walletAddress = (wallet && wallet.address) || g.THIRDWEB_SERVER_WALLET_ADDRESS || null;

    const stages = [
      stage('thirdwebApi', 'thirdweb API (Universal Bridge top-up, §4a)',
        funding && funding.canTopUp,
        funding ? (funding.canTopUp ? `${funding.provider} chain ${funding.chainId}, hold ${funding.holdSourceType}:${funding.holdSourceAccountId || '?'}` : funding.issues.join('; ')) : 'ThirdwebTreasuryFundingEngine unavailable',
        true, { gate: 'THIRDWEB_SECRET_KEY' }),
      stage('serverWallet', 'Pinned thirdweb server wallet (treasury)',
        wallet && wallet.ready && wallet.address,
        wallet ? (wallet.address ? `${wallet.address} chain ${wallet.chainId} (${wallet.live ? 'live' : 'shadow'})` : [...wallet.issues, 'THIRDWEB_SERVER_WALLET_ADDRESS not pinned'].join('; ')) : 'ThirdwebServerWalletEngine unavailable',
        true, { gate: 'THIRDWEB_SERVER_WALLET_ADDRESS', live: Boolean(wallet && wallet.live) }),
      stage('serverWalletLive', 'THIRDWEB_SERVER_WALLET_LIVE (outbound value may broadcast)',
        g.THIRDWEB_SERVER_WALLET_LIVE,
        g.THIRDWEB_SERVER_WALLET_LIVE ? 'live: sends and Spritz payout signing broadcast' : 'shadow: every outbound leg is recorded, nothing broadcast',
        false, { gate: 'THIRDWEB_SERVER_WALLET_LIVE' }),
      stage('thirdwebShadow', 'THIRDWEB_SHADOW=false (account abstraction / sponsorship leg calls thirdweb)',
        !g.THIRDWEB_SHADOW,
        g.THIRDWEB_SHADOW ? 'THIRDWEB_SHADOW=true: gas sponsorship leg is simulated' : 'THIRDWEB_SHADOW=false',
        false, { gate: 'THIRDWEB_SHADOW' }),
      stage('gasSponsorship', 'THIRDWEB_GAS_SPONSORSHIP_LIVE (paymaster covers gas)',
        aa && aa.canSponsorGas,
        aa ? (aa.canSponsorGas ? `sponsored via ${aa.sponsorshipPolicy}` : `not sponsoring (live=${g.THIRDWEB_GAS_SPONSORSHIP_LIVE}, shadow=${g.THIRDWEB_SHADOW}); wallet must hold >= ${this.minGasEth()} ETH`) : 'ThirdwebWalletEngine unavailable',
        false, { gate: 'THIRDWEB_GAS_SPONSORSHIP_LIVE' }),
      stage('canonicalFunding', 'Treasury-Core ERP (Fineract) canonical funding source, §4b book of record',
        canonical && canonical.ready,
        canonical ? (canonical.ready ? `${canonical.live ? 'CANONICAL_FUNDING_LIVE=true: journal posts to the GL' : 'CANONICAL_FUNDING_LIVE=false: shadow commit, top-ups stay unbooked'}` : canonical.issues.join('; ')) : 'CanonicalFundingSource unavailable',
        true, { gate: 'CANONICAL_FUNDING_LIVE', live: Boolean(canonical && canonical.live) }),
      stage('smartRouter', 'SMART_ROUTER_LIVE (Smart Router deliver, §4d)',
        g.SMART_ROUTER_LIVE,
        g.SMART_ROUTER_LIVE ? 'live: deliver routes to rails whose own gate is open' : 'shadow: deliver returns the routing plan only',
        false, { gate: 'SMART_ROUTER_LIVE' }),
      stage('trustPolicy', 'TrustDistributionPolicy (maker/checker, §5)',
        policy && g.TRUST_POLICY_ADDRESS && g.TRUST_POLICY_LIVE,
        policy
          ? (g.TRUST_POLICY_ADDRESS
            ? `${g.TRUST_POLICY_ADDRESS} enforced=${g.TRUST_POLICY_ENFORCED} live=${g.TRUST_POLICY_LIVE}${!g.TRUST_POLICY_LIVE ? (g.TRUST_POLICY_ENFORCED ? ' — enforced without live would block all outbound value' : ' — TRUST_POLICY_LIVE=false: proposals are shadow, a settled draw would have no executable distribution') : ''}`
            : 'TRUST_POLICY_ADDRESS not configured (draw destination / governed settlement)')
          : 'TrustPolicyEngine unavailable',
        true, { gate: 'TRUST_POLICY_ENFORCED', enforced: g.TRUST_POLICY_ENFORCED, live: g.TRUST_POLICY_LIVE }),
      stage('signer', 'Spritz payout signer (SPRITZ_PAYOUT_WALLET → thirdweb server wallet, §4e)',
        signerType === 'thirdweb',
        legCfg ? `signer.type ${signerType}${signerType === 'thirdweb' ? '' : ' — set SPRITZ_PAYOUT_WALLET to the pinned server wallet'}` : 'SpritzTreasuryLegEngine unavailable',
        true, { signerType }),
      stage('collateralOs', 'Collateral OS (RWA borrowing base → policy contract)',
        collateralCfg && collateralCfg.enabled && collateralCfg.destination,
        collateralCfg ? (collateralCfg.enabled ? `destination ${collateralCfg.destination || 'unset'} chain ${collateralCfg.chainId}` : 'COLLATERAL_OS_ENABLED=false') : 'CollateralOsEngine unavailable',
        true),
      stage('settlementReconcile', 'thirdweb settlement reconcile (webhook + poll)',
        settlement && settlement.ready,
        settlement ? (settlement.ready ? `token ${settlement.settlementToken} chain ${settlement.chainId}` : settlement.issues.join('; ')) : 'ThirdwebSettlementEngine unavailable',
        false),
      stage('treasuryEth', `Treasury ETH for gas (>= ${this.minGasEth()} ETH or sponsorship)`, false, 'not evaluated (config-only view; readinessFull fetches balances)', true, { evaluated: 'config', balance: null }),
      stage('treasuryUsdc', 'Treasury USDC on Base', false, 'not evaluated (config-only view; readinessFull fetches balances)', false, { evaluated: 'config', balance: null }),
      stage('fundingEligible', 'ERP canonical position fundingEligible (drift 0)', false, 'not evaluated (config-only view; readinessFull fetches the position)', true, { evaluated: 'config' }),
    ];

    const liveGates = this.liveGatesOpen(g);
    const blocking = stages.filter((s) => !s.ok && s.blocking).map((s) => s.key);
    return {
      engine: 'live-value-runbook',
      asOf: new Date().toISOString(),
      evaluated: 'config',
      mode: liveGates.open ? 'live' : 'shadow',
      ready: blocking.length === 0 && errors.length === 0,
      stages,
      blocking,
      errors,
      gates: g,
      liveGates,
      signer: { type: signerType },
      treasury: { address: walletAddress, chainId: wallet ? wallet.chainId : null, eth: null, usdc: null, fundingEligible: null },
    };
  }

  /** readiness() plus the balances / ERP position that need a network call. */
  static async readinessFull() {
    const d = this._deps();
    const r = this.readiness();
    const patch = (key, ok, detail, extra = {}) => {
      const s = r.stages.find((x) => x.key === key);
      if (s) Object.assign(s, { ok: Boolean(ok), detail, evaluated: 'full', ...extra });
    };
    const bal = d.TreasuryFunding ? await attempt(() => d.TreasuryFunding.treasuryBalances()) : { ok: false, error: 'ThirdwebTreasuryFundingEngine not available' };
    if (bal.ok) {
      const { eth, usdc } = this._pickBalances(bal.value);
      r.treasury.address = bal.value.address || r.treasury.address;
      r.treasury.eth = eth;
      r.treasury.usdc = usdc;
      const need = this.minGasEth();
      const sponsored = r.stages.find((s) => s.key === 'gasSponsorship');
      patch('treasuryEth', eth >= need || (sponsored && sponsored.ok), `${eth} ETH on ${r.treasury.address} (need ${need}${sponsored && sponsored.ok ? ', or sponsored' : ''})`, { balance: eth });
      patch('treasuryUsdc', usdc > 0, `${usdc} USDC on ${r.treasury.address}`, { balance: usdc });
    } else {
      r.errors.push(`treasury balances: ${bal.error}`);
      patch('treasuryEth', false, `balance unavailable: ${bal.error}`);
      patch('treasuryUsdc', false, `balance unavailable: ${bal.error}`);
    }
    const pos = d.CanonicalFunding ? await attempt(() => d.CanonicalFunding.position({ purpose: 'live value runbook' })) : { ok: false, error: 'CanonicalFundingSource not available' };
    if (pos.ok) {
      r.treasury.fundingEligible = Boolean(pos.value.fundingEligible);
      patch('fundingEligible', pos.value.fundingEligible, `${pos.value.accountCode || '?'} available $${fromCents(pos.value.availableBalanceCents).toFixed(2)}${pos.value.fundingEligible ? '' : ` — ${pos.value.segregationReason || 'restricted'}`}`, { position: pos.value });
    } else {
      r.errors.push(`canonical position: ${pos.error}`);
      patch('fundingEligible', false, `position unavailable: ${pos.error}`);
    }
    r.evaluated = 'full';
    r.blocking = r.stages.filter((s) => !s.ok && s.blocking).map((s) => s.key);
    r.ready = r.blocking.length === 0 && r.errors.length === 0;
    return r;
  }

  static _pickBalances(result) {
    const list = Array.isArray(result) ? result : (result && (result.balances || [])) || [];
    let eth = 0; let usdc = 0;
    for (const b of list) {
      const symbol = String(b.symbol || b.name || '').toUpperCase();
      const decimals = Number(b.decimals ?? (symbol === 'USDC' ? 6 : 18));
      const raw = b.value ?? b.balance ?? b.displayValue ?? b.amount ?? '0';
      let amount;
      if (b.displayValue !== undefined) amount = Number(b.displayValue);
      else if (/^\d+$/.test(String(raw))) amount = Number(BigInt(String(raw))) / 10 ** decimals;
      else amount = Number(raw);
      if (!Number.isFinite(amount)) continue;
      const address = String(b.tokenAddress || b.token_address || b.address || '').toLowerCase();
      if (symbol === 'ETH' || address === NATIVE || address === '0x0000000000000000000000000000000000000000' || address === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') eth = amount;
      else if (symbol === 'USDC' || (str('DAPP_USDC_ADDRESS') && address === str('DAPP_USDC_ADDRESS').toLowerCase())) usdc = amount;
    }
    return { eth, usdc };
  }

  // ─── plan ──────────────────────────────────────────────────────────────────

  static _validateAmount(amountUsd) {
    const n = Number(amountUsd);
    if (!Number.isFinite(n) || n <= 0) throw new RunbookError('amountUsd must be a positive USD amount', 'RUNBOOK_INVALID', 400);
    return round2(n);
  }

  static _bucketFor(role) {
    return BUCKET_BY_ROLE[String(role || 'beneficiary').toLowerCase()] || BUCKET_BY_ROLE.beneficiary;
  }

  /**
   * Ordered steps to move `amountUsd` from the trust's fiat to a fiat destination.
   * Each step: { key, section, label, canExecute, human, reason, requires[] }.
   * Never throws for a closed gate; gates become blocked steps.
   */
  static async plan({ amountUsd, role = 'beneficiary', purpose = null, reference = null } = {}) {
    const d = this._deps();
    const amount = this._validateAmount(amountUsd);
    const g = this.gates();
    const readiness = await this.readinessFull();
    const stageOk = (key) => { const s = readiness.stages.find((x) => x.key === key); return Boolean(s && s.ok); };
    const stageDetail = (key) => { const s = readiness.stages.find((x) => x.key === key); return s ? s.detail : null; };
    const bucket = this._bucketFor(role);
    let ref = reference || `LVR-${Date.now().toString(36).toUpperCase()}`;
    const steps = [];
    const step = (key, section, label, fields) => { const s = { key, section, label, canExecute: false, human: false, skip: false, reason: null, requires: [], ...fields }; steps.push(s); return s; };

    // 1. preflight — trust mandate + distribution policy guard
    const pre = d.ControlPlane
      ? await attempt(() => d.ControlPlane.evaluateDistribution({ amountUsd: amount, requesterRole: role, purpose }))
      : { ok: false, error: 'TrustControlPlaneEngine not available' };
    if (!pre.ok) step('preflight', '§2', 'Mandate / distribution policy pre-flight', { reason: pre.error });
    else {
      const ev = pre.value;
      const blocked = !ev.allowed && ev.enforced;
      step('preflight', '§2', 'Mandate / distribution policy pre-flight', {
        canExecute: !blocked,
        reason: ev.allowed ? null : `${blocked ? 'blocked' : 'advisory'}: ${ev.blocking.join(', ')}`,
        evaluation: { allowed: ev.allowed, enforced: ev.enforced, blocking: ev.blocking },
      });
    }

    // 2. §4a top-up — an open (unsettled or unbooked) top-up is synced before
    // anything else; otherwise only when the treasury does not already hold the USDC
    const usdc = readiness.treasury.usdc;
    const openTopUps = d.TreasuryFunding ? await attempt(() => d.TreasuryFunding.openTopUps({ limit: 20 })) : { ok: true, value: [] };
    const open = openTopUps.ok ? openTopUps.value : [];
    if (open.length) {
      const t = open[0];
      const apiOk = stageOk('thirdwebApi');
      step('topUp', '§4a', 'Sync the open treasury top-up (thirdweb checkout → USDC on Base)', {
        canExecute: apiOk, resume: true, reason: apiOk ? null : stageDetail('thirdwebApi'), topUpId: t.id, status: t.status, booked: Boolean(t.booked), link: t.link || null,
        note: `open top-up ${t.id} (${t.status}${t.status === 'COMPLETED' && !t.booked ? ', unbooked' : ''}): syncTopUp polls thirdweb; stops only while the checkout is still pending`,
      });
      step('book', '§4b', 'Book the settled top-up in the ERP', { canExecute: apiOk, reason: apiOk ? null : stageDetail('thirdwebApi'), topUpId: t.id, requires: ['CANONICAL_FUNDING_LIVE'], live: g.CANONICAL_FUNDING_LIVE });
    } else if (usdc !== null && usdc >= amount) {
      step('topUp', '§4a', 'Fund the treasury wallet (fiat → USDC on Base)', { skip: true, reason: `treasury already holds ${usdc} USDC >= $${amount}` });
      step('book', '§4b', 'Book the settled top-up in the ERP', { skip: true, reason: 'no top-up needed' });
    } else {
      const reasons = [];
      if (!stageOk('thirdwebApi')) reasons.push(stageDetail('thirdwebApi'));
      if (!stageOk('serverWallet')) reasons.push(stageDetail('serverWallet'));
      if (!stageOk('fundingEligible')) reasons.push(`ERP: ${stageDetail('fundingEligible')}`);
      step('topUp', '§4a', 'Fund the treasury wallet (fiat → USDC on Base)', {
        canExecute: reasons.length === 0, humanAfter: true, reason: reasons.length ? reasons.join('; ') : null, amountUsd: amount,
        note: 'creates a hosted thirdweb checkout; a trustee must complete the link — execution stops here until it settles',
      });
      step('book', '§4b', 'Book the settled top-up in the ERP', { canExecute: false, reason: 'waits for the §4a checkout to settle (re-run to sync)', requires: ['CANONICAL_FUNDING_LIVE'], live: g.CANONICAL_FUNDING_LIVE });
    }

    // 3. gas — Base ETH on the treasury wallet or sponsorship
    const ethOk = stageOk('treasuryEth');
    if (ethOk) step('gas', '§4', 'Base ETH for gas', { skip: true, reason: stageDetail('treasuryEth') });
    else {
      const operator = d.DappConfig && typeof d.DappConfig.getConfig === 'function' ? (() => { try { return d.DappConfig.getConfig().operatorAddress || null; } catch { return null; } })() : null;
      const sameWallet = operator && readiness.treasury.address && operator.toLowerCase() === readiness.treasury.address.toLowerCase();
      let gasPlan = null;
      if (d.Funding && sameWallet) gasPlan = await attempt(() => d.Funding.buildPlan({ amountUsd: Number(str('OPERATOR_GAS_TANK_TOPUP_USD')) || 25, targetAsset: 'ETH' }));
      const reasons = [];
      if (!sameWallet) reasons.push(`FundingEngine funds the operator ${operator || '(unset)'}, not the treasury ${readiness.treasury.address || '(unset)'}: deposit >= ${this.minGasEth()} ETH manually or enable THIRDWEB_GAS_SPONSORSHIP_LIVE`);
      else if (!gasPlan || !gasPlan.ok) reasons.push(`FundingEngine: ${gasPlan ? gasPlan.error : 'not available'}`);
      else if (!gasPlan.value.canExecute) reasons.push(gasPlan.value.recommendation || (gasPlan.value.missing || []).join('; '));
      if (!g.FUNDING_LIVE) reasons.push('FUNDING_LIVE not set');
      step('gas', '§4', 'Base ETH for gas (FundingEngine.executePlan)', { canExecute: reasons.length === 0, reason: reasons.length ? reasons.join('; ') : null, requires: ['FUNDING_LIVE'], live: g.FUNDING_LIVE, fundingPlan: gasPlan && gasPlan.ok ? { canExecute: gasPlan.value.canExecute, steps: gasPlan.value.steps, missing: gasPlan.value.missing } : null });
    }

    // 4. collateral draw — maker/checker proposal against the RWA facility.
    // An in-flight runbook draw (same reference, or the newest LVR- draw for this
    // amount) is resumed from its recorded state instead of proposed again.
    const inFlight = await this._inFlightDraw(d, { reference, amount });
    if (inFlight) ref = inFlight.reference;
    let facility = null;
    if (inFlight) {
      step('draw', '§4c', 'RWA collateral draw (maker/checker)', { skip: true, reason: `resuming draw ${inFlight.drawId} (${inFlight.status}, ref ${inFlight.reference})`, drawId: inFlight.drawId, drawStatus: inFlight.status, reference: inFlight.reference, proposalId: inFlight.proposalId });
    } else if (d.Collateral) {
      const f = await attempt(() => d.Collateral.facility());
      if (f.ok) facility = f.value; else step('draw', '§4c', 'RWA collateral draw (maker/checker)', { reason: `facility: ${f.error}` });
    } else step('draw', '§4c', 'RWA collateral draw (maker/checker)', { reason: 'CollateralOsEngine not available' });
    if (facility) {
      const reasons = [];
      if (!stageOk('collateralOs')) reasons.push(stageDetail('collateralOs'));
      if (facility.marginCall) reasons.push(`facility in margin call (${facility.utilizationBps} bps)`);
      if (Number(facility.availableUsd || 0) < amount) reasons.push(`facility available $${round2(facility.availableUsd).toFixed(2)} < $${amount} (pledge more RWA)`);
      step('draw', '§4c', 'RWA collateral draw (maker/checker)', { canExecute: reasons.length === 0, reason: reasons.length ? reasons.join('; ') : null, bucket, reference: ref, amountUsd: amount, requires: ['CANONICAL_FUNDING_LIVE'], live: g.CANONICAL_FUNDING_LIVE, facility: { availableUsd: facility.availableUsd, spendableUsd: facility.spendableUsd, drawnUsd: facility.drawnUsd } });
    }
    const FUND_LABEL = 'Checker approves the ERP proposal; reconcile books DR 1210 / CR 2400';
    if (inFlight && inFlight.status === 'proposed') {
      step('fund', '§4c', FUND_LABEL, { canExecute: true, resume: true, drawId: inFlight.drawId, proposalId: inFlight.proposalId, requires: ['CANONICAL_FUNDING_LIVE'], live: g.CANONICAL_FUNDING_LIVE, note: 'reconcile() books the draw if the checker has approved; otherwise stops for the checker' });
    } else if (inFlight) {
      step('fund', '§4c', FUND_LABEL, { skip: true, reason: `draw ${inFlight.drawId} already ${inFlight.status}`, drawId: inFlight.drawId });
    } else {
      step('fund', '§4c', FUND_LABEL, { canExecute: false, human: true, reason: 'checker approval of the canonical_money proposal is a human step; reconcile() runs after it' });
    }

    // 5. governed settlement + Spritz off-ramp
    const settleReasons = [];
    if (!stageOk('trustPolicy')) settleReasons.push(stageDetail('trustPolicy'));
    if (!stageOk('signer')) settleReasons.push(stageDetail('signer'));
    if (!g.THIRDWEB_SERVER_WALLET_LIVE) settleReasons.push('THIRDWEB_SERVER_WALLET_LIVE not set (payout signer not live)');
    const SETTLE_LABEL = 'Stage the Spritz off-ramp under the policy contract (CollateralOsEngine.settle)';
    const RELEASE_LABEL = 'Checker approves the distribution; after the release delay executeSettlement releases via the policy contract and Spritz pays out';
    if (inFlight && ['settling', 'settled'].includes(inFlight.status)) {
      step('settle', '§4e', SETTLE_LABEL, { skip: true, reason: `draw ${inFlight.drawId} already ${inFlight.status}; distribution ${inFlight.distributionId || 'n/a'}, Spritz quote ${inFlight.spritzQuoteId || 'n/a'}`, drawId: inFlight.drawId, distributionId: inFlight.distributionId });
    } else {
      step('settle', '§4e', SETTLE_LABEL, { canExecute: settleReasons.length === 0, reason: settleReasons.length ? settleReasons.join('; ') : null, purpose, drawId: inFlight ? inFlight.drawId : null, requires: ['THIRDWEB_SERVER_WALLET_LIVE', 'TRUST_POLICY_LIVE'], live: g.THIRDWEB_SERVER_WALLET_LIVE && g.TRUST_POLICY_LIVE });
    }
    if (inFlight && inFlight.status === 'settled') {
      step('release', '§4e', RELEASE_LABEL, { skip: true, reason: `draw ${inFlight.drawId} settled`, drawId: inFlight.drawId });
    } else if (inFlight && inFlight.status === 'settling') {
      const rel = await this._releaseState(d, inFlight);
      const runnable = rel.releasable || Boolean(rel.executed);
      step('release', '§4e', RELEASE_LABEL, {
        canExecute: runnable && settleReasons.length === 0, human: !runnable, drawId: inFlight.drawId, distributionId: inFlight.distributionId, distribution: rel.distribution,
        reason: runnable ? (settleReasons.length ? settleReasons.join('; ') : null) : rel.reason, requires: ['THIRDWEB_SERVER_WALLET_LIVE', 'TRUST_POLICY_LIVE'], live: g.THIRDWEB_SERVER_WALLET_LIVE && g.TRUST_POLICY_LIVE,
      });
    } else {
      step('release', '§4e', RELEASE_LABEL, { canExecute: false, human: true, reason: 'checker approval + timelock is a human step; executeSettlement() runs after it' });
    }
    step('reconcile', '§4', 'ThirdwebSettlementEngine.reconcile (confirm on-chain legs, book once)', { canExecute: Boolean(d.Settlement && stageOk('thirdwebApi')), reason: d.Settlement ? (stageOk('thirdwebApi') ? null : stageDetail('thirdwebApi')) : 'ThirdwebSettlementEngine not available' });

    const firstBlocked = steps.find((s) => !s.skip && !s.canExecute);
    const liveGates = this.liveGatesOpen(g);
    return {
      amountUsd: amount,
      role,
      purpose,
      bucket,
      reference: ref,
      resuming: inFlight ? { drawId: inFlight.drawId, status: inFlight.status, reference: inFlight.reference, distributionId: inFlight.distributionId || null } : null,
      mode: liveGates.open ? 'live' : 'shadow',
      liveGates,
      ready: readiness.ready,
      steps,
      executable: steps.filter((s) => s.canExecute && !s.skip).map((s) => s.key),
      firstBlocked: firstBlocked ? { key: firstBlocked.key, section: firstBlocked.section, human: Boolean(firstBlocked.human), reason: firstBlocked.reason } : null,
      readiness: { ready: readiness.ready, blocking: readiness.blocking, errors: readiness.errors, treasury: readiness.treasury },
      generatedAt: new Date().toISOString(),
    };
  }

  // ─── execute ───────────────────────────────────────────────────────────────

  /**
   * Run the executable steps in order. Stops at the first step that needs a
   * human (§4a checkout, checker approval) or whose gate is closed, and says
   * exactly what to do next. Shadow unless `live === true` AND the live gates
   * are open; shadow records what would happen and moves nothing.
   */
  static async execute({ amountUsd, role = 'beneficiary', purpose = null, reference = null, steps = null, live = false, actor = 'live-value-runbook' } = {}) {
    const d = this._deps();
    const plan = await this.plan({ amountUsd, role, purpose, reference });
    const g = this.gates();
    const liveRequested = live === true;
    const liveGates = this.liveGatesOpen(g);
    const isLive = liveRequested && liveGates.open;
    const mode = isLive ? 'live' : 'shadow';
    const shadowReason = !liveRequested ? 'live=false (default): shadow run, nothing moves'
      : (!liveGates.open ? `live requested but gates closed: ${liveGates.closed.join(', ')}` : null);
    const wanted = Array.isArray(steps) && steps.length ? new Set(steps) : null;

    const results = [];
    let stopped = null;
    let fundedDrawId = null;
    let syncedTopUp = null;
    const FUND_STEP = { key: 'fund', section: '§4c', label: 'Checker approves the ERP proposal; reconcile books DR 1210 / CR 2400', human: true };
    const RELEASE_STEP = { key: 'release', section: '§4e', label: 'Checker approves the distribution; executeSettlement releases via the policy contract', human: true };
    const record = (s, status, message, extra = {}) => { const r = { key: s.key, section: s.section, label: s.label, status, mode, message, ...extra }; results.push(r); return r; };
    const stop = (s, message, extra = {}, human = Boolean(s.human)) => { stopped = { key: s.key, section: s.section, human, message }; return record(s, 'stopped', message, extra); };

    for (const s of plan.steps) {
      if (stopped) { record(s, 'pending', 'not reached'); continue; }
      if (wanted && !wanted.has(s.key)) { record(s, 'skipped', 'not selected'); continue; }
      if (s.skip) { record(s, 'skipped', s.reason); continue; }
      if (s.key === 'fund' && fundedDrawId) { record(s, 'skipped', `draw ${fundedDrawId} already funded during this run`); continue; }
      if (s.key === 'book' && syncedTopUp && syncedTopUp.booked) { record(s, 'skipped', `top-up ${syncedTopUp.id} already booked in ${syncedTopUp.bookOfRecord || 'ledger'}`); continue; }
      if (!s.canExecute) {
        if (s.human) { stop(s, `human step: ${s.reason}`); continue; }
        stop(s, `blocked at ${s.section} ${s.key}: ${s.reason}`);
        continue;
      }
      const missingGates = (s.requires || []).filter((k) => !g[k]);
      if (!isLive) {
        record(s, 'shadow', `would run ${s.key} (${s.section})${s.resume ? ` resuming ${s.topUpId || s.drawId}` : ''}${missingGates.length ? `; live would need ${missingGates.join(', ')}` : ''}`, { moved: false, reason: shadowReason });
        if (s.key === 'topUp' && !s.resume) stop(s, `shadow: would create a hosted thirdweb checkout for $${plan.amountUsd} and stop for a trustee to complete it (§4a). Nothing was created.`, {}, true);
        if (s.key === 'draw') stop(s, 'shadow: would raise the maker/checker ERP proposal and stop for the checker (§4c). Nothing was proposed.', {}, true);
        continue;
      }
      if (missingGates.length) { stop(s, `gate closed for ${s.key}: ${missingGates.join(', ')} must be true`); continue; }

      try {
        switch (s.key) {
          case 'preflight':
            record(s, 'done', s.reason ? `passed with advisory: ${s.reason}` : 'passed', { evaluation: s.evaluation });
            break;
          case 'topUp': {
            if (s.resume) {
              const synced = await d.TreasuryFunding.syncTopUp(s.topUpId);
              if (synced.status === 'COMPLETED') { syncedTopUp = synced; record(s, 'done', `top-up ${synced.id} settled${synced.booked ? ` and booked in ${synced.bookOfRecord || 'ledger'}` : ' (not yet booked)'}`, { topUp: synced, moved: false }); }
              else if (synced.status === 'FAILED') stop(s, `top-up ${synced.id} FAILED at thirdweb; create a new top-up`, { topUp: synced });
              else stop(s, `§4a: top-up ${synced.id} is ${synced.status} — a trustee must complete the hosted checkout ${synced.link || s.link || ''}; re-run afterwards to book it.`, { topUpId: synced.id, link: synced.link || s.link }, true);
              break;
            }
            const topUp = await d.TreasuryFunding.createTopUp({ amountFiat: plan.amountUsd, requestedBy: actor, requesterRole: 'trustee' });
            record(s, 'done', `top-up ${topUp.id} created (${topUp.status})`, { topUpId: topUp.id, link: topUp.link, moved: false });
            stop(s, `§4a: a trustee must complete the hosted checkout ${topUp.link || '(no link returned)'} with the trust's card or bank. Then re-run (or: npm run trust:treasury-funding -- --sync ${topUp.id}) to book it.`, { topUpId: topUp.id, link: topUp.link }, true);
            break;
          }
          case 'book': {
            const synced = await d.TreasuryFunding.syncTopUp(s.topUpId);
            if (synced.status === 'COMPLETED' && synced.booked) record(s, 'done', `top-up ${synced.id} booked in ${synced.bookOfRecord || 'ledger'} (journal ${synced.journalEntryId || 'n/a'})`, { topUp: synced });
            else if (synced.status === 'COMPLETED') stop(s, `top-up ${synced.id} settled but is not booked (CANONICAL_FUNDING_LIVE=${g.CANONICAL_FUNDING_LIVE}); re-run once the ERP commit is live`, { topUp: synced });
            else if (synced.status === 'FAILED') stop(s, `top-up ${synced.id} FAILED at thirdweb; create a new top-up`, { topUp: synced });
            else stop(s, `top-up ${synced.id} is ${synced.status}: complete the checkout ${synced.link || ''} and re-run`, { topUp: synced });
            break;
          }
          case 'gas': {
            const out = await d.Funding.executePlan({ amountUsd: Number(str('OPERATOR_GAS_TANK_TOPUP_USD')) || 25, targetAsset: 'ETH', strategy: 'auto' });
            const ok = (out.executed || []).some((e) => e.result && !e.error);
            if (ok) record(s, 'done', `gas provisioned via ${out.executed.filter((e) => e.result).map((e) => e.rail).join(', ')}`, { executed: out.executed });
            else stop(s, `gas provisioning did not complete: ${(out.executed || []).map((e) => `${e.rail}: ${e.error}`).join('; ') || out.recommendation}`, { executed: out.executed });
            break;
          }
          case 'fund': {
            const rec = await d.Collateral.reconcile({ postedBy: actor });
            const mine = (rec.draws || []).find((x) => x.drawId === s.drawId);
            if (mine && mine.status === 'funded') { fundedDrawId = s.drawId; record(s, 'done', `draw ${s.drawId} funded (journal ${mine.journal && mine.journal.entryId ? mine.journal.entryId : 'n/a'})`, { drawId: s.drawId }); }
            else stop(s, `§4c: checker must approve canonical_money proposal ${s.proposalId || '(see draw)'} for draw ${s.drawId}; then re-run to reconcile and settle.`, { drawId: s.drawId, proposalId: s.proposalId }, true);
            break;
          }
          case 'draw': {
            const draw = await d.Collateral.draw({ amountUsd: plan.amountUsd, bucket: plan.bucket, reference: plan.reference, createdBy: actor, autoApprove: false });
            record(s, 'done', `draw ${draw.drawId} ${draw.status}${draw.idempotent ? ' (idempotent)' : ''}`, { drawId: draw.drawId, proposalId: draw.proposalId, requestId: draw.requestId });
            const rec = await d.Collateral.reconcile({ postedBy: actor });
            const mine = (rec.draws || []).find((x) => x.drawId === draw.drawId);
            if (mine && mine.status === 'funded') {
              fundedDrawId = draw.drawId;
              record(FUND_STEP, 'done', `draw ${draw.drawId} funded (journal ${mine.journal && mine.journal.entryId ? mine.journal.entryId : 'n/a'})`, { drawId: draw.drawId });
            } else {
              stop(FUND_STEP, `§4c: checker must approve canonical_money proposal ${draw.proposalId || draw.requestId || '(see draw)'} for draw ${draw.drawId}; then re-run to reconcile and settle.`, { drawId: draw.drawId, proposalId: draw.proposalId });
            }
            break;
          }
          case 'settle': {
            const drawId = fundedDrawId || s.drawId;
            if (!drawId) { stop(s, 'no funded draw to settle; complete §4c first'); break; }
            const settled = await d.Collateral.settle({ drawId, purpose: purpose || undefined, actor });
            record(s, 'done', `draw ${drawId} settling; Spritz quote ${settled.spritzQuoteId || 'n/a'}, distribution ${settled.distributionId || 'n/a'}`, { drawId, payout: settled.payout ? { rail: settled.payout.rail, destination: settled.payout.destination, amountUsd: settled.payout.amountUsd } : null });
            stop(RELEASE_STEP, `§4e: checker must approve distribution ${settled.distributionId || '(staged)'}; after the release delay run executeSettlement for draw ${drawId} (the policy contract releases and Spritz pays out).`, { drawId, distributionId: settled.distributionId });
            break;
          }
          case 'release': {
            const out = await d.Collateral.executeSettlement({ drawId: s.drawId, actor });
            const st = out.settlement || {};
            record(s, 'done', `draw ${s.drawId} settled: policy released distribution ${s.distributionId}, Spritz payout ${st.status || 'submitted'}${st.txHash ? ` tx ${st.txHash}` : ''}`, { drawId: s.drawId, distributionId: s.distributionId, txHash: st.txHash || null, amountUsd: st.amountUsd, feeUsd: st.feeUsd });
            break;
          }
          case 'reconcile': {
            const out = await d.Settlement.reconcile({});
            record(s, 'done', 'settlement reconciled', { reconcile: out });
            break;
          }
          default:
            record(s, 'skipped', 'no executor');
        }
      } catch (e) {
        stop(s, `${s.key} failed: ${e.message}`, { code: e.code || null });
      }
    }

    return {
      amountUsd: plan.amountUsd,
      role,
      purpose,
      bucket: plan.bucket,
      reference: plan.reference,
      mode,
      live: isLive,
      liveRequested,
      liveGates,
      shadowReason,
      moved: isLive && results.some((r) => r.status === 'done' && ['book', 'gas', 'draw', 'fund', 'settle', 'release'].includes(r.key)),
      completed: !stopped,
      stoppedAt: stopped,
      message: stopped ? stopped.message : `all ${results.filter((r) => r.status === 'done').length} executable steps ran in ${mode} mode`,
      results,
      plan: { steps: plan.steps.map((s) => ({ key: s.key, section: s.section, canExecute: s.canExecute, human: s.human, skip: s.skip, reason: s.reason })), firstBlocked: plan.firstBlocked },
      executedAt: new Date().toISOString(),
    };
  }

  /**
   * The runbook draw to resume: the draw with `reference` if given, otherwise
   * the newest in-flight (proposed / funded / settling) LVR- draw for `amount`.
   */
  static async _inFlightDraw(d, { reference, amount }) {
    if (!d.Collateral) return null;
    const r = await attempt(() => d.Collateral.draws({ limit: 200 }));
    if (!r.ok) return null;
    if (reference) return r.value.find((x) => x.reference === reference) || null;
    return r.value.find((x) => IN_FLIGHT_DRAW.has(x.status) && /^LVR-/.test(x.reference || '') && round2(x.amountUsd) === amount) || null;
  }

  /** Whether a settling draw's on-chain distribution is approved and past its release delay. */
  static async _releaseState(d, draw) {
    if (!draw.distributionId) return { releasable: false, reason: `draw ${draw.drawId} is settling with no distribution id (TRUST_POLICY_LIVE was false when it was staged?); repay or re-stage`, distribution: null };
    if (!d.TrustPolicy) return { releasable: false, reason: 'TrustPolicyEngine not available to read the distribution', distribution: null };
    const r = await attempt(() => d.TrustPolicy.distribution(draw.distributionId));
    if (!r.ok) return { releasable: false, reason: `distribution ${draw.distributionId}: ${r.error}`, distribution: null };
    const dist = r.value;
    if (!dist) return { releasable: false, reason: `distribution ${draw.distributionId} not found on the policy contract`, distribution: null };
    const summary = { distributionId: dist.distributionId, status: dist.status, approvals: dist.approvals, releasableAt: dist.releasableAt };
    if (dist.status === 'executed') return { releasable: false, reason: `distribution ${dist.distributionId} already executed on chain; run executeSettlement to book the payout`, distribution: summary, executed: true };
    if (dist.status === 'cancelled') return { releasable: false, reason: `distribution ${dist.distributionId} cancelled on chain; repay the draw`, distribution: summary };
    if (dist.status !== 'approved') return { releasable: false, reason: `checker must approve distribution ${dist.distributionId} on the policy contract (${dist.status}, ${dist.approvals} approval(s))`, distribution: summary };
    if (dist.releasableAt && new Date(dist.releasableAt) > new Date()) return { releasable: false, reason: `release delay: distribution ${dist.distributionId} executable at ${dist.releasableAt}`, distribution: summary };
    return { releasable: true, reason: null, distribution: summary };
  }
}

module.exports = { LiveValueRunbookOsEngine, RunbookError, STEP_KEYS, BUCKET_BY_ROLE };
