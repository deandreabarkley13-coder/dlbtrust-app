'use strict';

/**
 * Trust Control Plane
 *
 * One read model over every component the trust runs on — Fineract (canonical
 * cash/GL), the trust sub-ledger, fixed income, the private trust company
 * (custodian) and issuer engines, thirdweb, Hyperledger Fabric/FireFly, the
 * distribution queue and the deployment targets — evaluated against the Trust
 * Mandate. Nothing here is authoritative for a balance; it only compares the
 * authorities against each other and against the mandate, and reports every
 * stage of the beneficiary-support pipeline that is skipped, unavailable or
 * out of policy as an explicit gap.
 *
 * It also supplies the guard the distribution engine consults before paying:
 * evaluateDistribution() applies the funding policy (income-only, reserve,
 * per-role ceilings, canonical funding) and returns a decision that is either
 * recorded (report-only) or enforced (TRUST_MANDATE_ENFORCE=true).
 */

const { getMandate, PIPELINE_STAGES } = require('./trustMandate');
const DistributionPolicy = require('../dapp/distributionPolicy');

function load(path, name) {
  try {
    const mod = require(path);
    return name ? mod[name] : mod;
  } catch (e) {
    return null;
  }
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fromCents = (c) => round2(Number(c || 0) / 100);

async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

function unavailable(component, reason) {
  return { component, available: false, ready: false, mode: null, issues: [reason] };
}

class TrustControlPlaneEngine {
  static _deps() {
    if (this.__deps) return this.__deps;
    this.__deps = {
      CanonicalFundingSource: load('../fineract/canonicalFundingSource', 'CanonicalFundingSource'),
      TrustAccountingEngine: load('../accounting/trustAccountingEngine', 'TrustAccountingEngine'),
      FixedIncomeDataService: load('../bonds/fixedIncomeDataService', 'FixedIncomeDataService'),
      PrivateTrustCompanyEngine: load('../dapp/privateTrustCompanyEngine', 'PrivateTrustCompanyEngine'),
      IssuerEngine: load('../dapp/issuerEngine', 'IssuerEngine'),
      CashEngine: load('../cash/cashEngine', 'CashEngine'),
      DistributionRequestEngine: load('../dapp/distributionRequestEngine', 'DistributionRequestEngine'),
      ThirdwebSettlementEngine: load('../dapp/thirdwebSettlementEngine', 'ThirdwebSettlementEngine'),
      ThirdwebServerWalletEngine: load('../dapp/thirdwebServerWalletEngine', 'ThirdwebServerWalletEngine'),
      ThirdwebTreasuryFundingEngine: load('../dapp/thirdwebTreasuryFundingEngine', 'ThirdwebTreasuryFundingEngine'),
      FabricLedgerEngine: load('../hyperledger/fabricLedgerEngine', 'FabricLedgerEngine'),
      FireflyEngine: load('../hyperledger/fireflyEngine', 'FireflyEngine'),
    };
    return this.__deps;
  }

  static mandate() { return getMandate(); }

  // ─── readiness ───────────────────────────────────────────────────────────

  /** Synchronous, config-only view: which components exist, are configured, and are live. */
  static readiness() {
    const d = this._deps();
    const components = {};

    components.fineract = d.CanonicalFundingSource
      ? this._wrap('fineract', () => {
        const r = d.CanonicalFundingSource.readiness();
        return { ...r, mode: r.live ? 'live' : 'shadow', authority: 'cash and GL' };
      })
      : unavailable('fineract', 'CanonicalFundingSource module not loadable');

    components.subLedger = d.TrustAccountingEngine
      ? { component: 'subLedger', available: true, ready: true, mode: 'postgres', authority: 'trust_accounts (reconciled against Fineract)', issues: [] }
      : unavailable('subLedger', 'TrustAccountingEngine module not loadable');

    components.fixedIncome = d.FixedIncomeDataService
      ? this._wrap('fixedIncome', () => {
        const p = d.FixedIncomeDataService.platformStatus();
        const issues = [];
        if (p.tokenization && p.tokenization.ready === false) issues.push(...(p.tokenization.issues || []).map((i) => `tokenization: ${i}`));
        return { available: true, ready: true, mode: 'postgres', authority: p.dlbtrust.source_of_truth, tokenization: p.tokenization || null, issues };
      })
      : unavailable('fixedIncome', 'FixedIncomeDataService module not loadable');

    components.custodian = d.PrivateTrustCompanyEngine
      ? { component: 'custodian', available: true, ready: true, mode: 'postgres', engine: 'PrivateTrustCompanyEngine', issues: [] }
      : unavailable('custodian', 'PrivateTrustCompanyEngine module not loadable');

    components.issuer = d.IssuerEngine
      ? { component: 'issuer', available: true, ready: true, mode: 'postgres', engine: 'IssuerEngine', issues: [] }
      : unavailable('issuer', 'IssuerEngine module not loadable');

    components.thirdweb = d.ThirdwebSettlementEngine
      ? this._wrap('thirdweb', () => {
        const s = d.ThirdwebSettlementEngine.readiness();
        const funding = d.ThirdwebTreasuryFundingEngine ? d.ThirdwebTreasuryFundingEngine.readiness() : null;
        return {
          available: true,
          ready: s.ready,
          mode: s.live ? 'live' : 'shadow',
          canSend: Boolean(s.serverWallet && s.serverWallet.canSend),
          chainId: s.chainId,
          settlementToken: s.settlementToken,
          serverWallet: s.serverWallet ? s.serverWallet.address : null,
          webhookConfigured: s.webhookConfigured,
          treasuryFunding: funding ? { ready: funding.ready, canTopUp: funding.canTopUp, canSwap: funding.canSwap, issues: funding.issues } : null,
          issues: s.issues,
        };
      })
      : unavailable('thirdweb', 'ThirdwebSettlementEngine module not loadable');

    components.fabric = d.FabricLedgerEngine
      ? this._wrap('fabric', () => {
        const r = d.FabricLedgerEngine.readiness();
        return { ...r, available: true, ready: r.canNotarize, authority: 'evidence (not balances)' };
      })
      : unavailable('fabric', 'FabricLedgerEngine module not loadable');

    components.firefly = d.FireflyEngine
      ? this._wrap('firefly', () => {
        const r = d.FireflyEngine.readiness();
        return { ...r, available: true, ready: r.ready !== undefined ? r.ready : (r.issues || []).length === 0 };
      })
      : unavailable('firefly', 'FireflyEngine module not loadable');

    components.northflank = this._northflank();
    components.vm = this._vm();

    const gaps = [];
    for (const [key, c] of Object.entries(components)) {
      if (!c.available) gaps.push({ component: key, severity: 'high', gap: c.issues[0] });
      else if (!c.ready) gaps.push({ component: key, severity: 'medium', gap: `${key} not ready: ${(c.issues || []).join('; ') || 'see issues'}` });
    }
    const liveRails = ['thirdweb', 'firefly'].filter((k) => components[k].mode === 'live');
    if (!liveRails.length) gaps.push({ component: 'settlement', severity: 'info', gap: 'no settlement rail is live; transfers run in shadow mode' });

    return {
      mandate: getMandate(),
      components,
      live: { fabric: components.fabric.mode === 'live', firefly: components.firefly.mode === 'live', thirdweb: components.thirdweb.mode === 'live', fineract: components.fineract.mode === 'live' },
      gaps,
      ready: gaps.every((g) => g.severity === 'info'),
      generatedAt: new Date().toISOString(),
    };
  }

  static _wrap(component, fn) {
    try {
      return { component, available: true, ...fn() };
    } catch (e) {
      return { component, available: true, ready: false, mode: null, issues: [`readiness failed: ${e.message}`] };
    }
  }

  static _northflank() {
    const project = process.env.NORTHFLANK_PROJECT_ID || process.env.NF_PROJECT_ID || null;
    const service = process.env.NF_SERVICE_ID || process.env.NORTHFLANK_SERVICE_ID || null;
    const configured = Boolean(project || service);
    return {
      component: 'northflank',
      available: true,
      ready: configured,
      mode: configured ? 'configured' : 'not-configured',
      projectId: project,
      serviceId: service,
      region: process.env.NF_REGION || process.env.NORTHFLANK_REGION || null,
      apiTokenConfigured: Boolean(process.env.NORTHFLANK_API_TOKEN),
      issues: configured ? [] : ['NORTHFLANK_PROJECT_ID / NF_SERVICE_ID not set (not deployed on Northflank from this host)'],
    };
  }

  static _vm() {
    const domain = process.env.APP_DOMAIN || null;
    const publicUrl = process.env.APP_PUBLIC_URL || (domain ? `https://${domain}` : null);
    return {
      component: 'vm',
      available: true,
      ready: true,
      mode: domain ? 'dns' : 'ip-only',
      domain,
      publicUrl,
      issues: domain ? [] : ['APP_DOMAIN not set: TLS uses an internal CA until a DNS name points at the host'],
    };
  }

  // ─── unified snapshot ────────────────────────────────────────────────────

  /** Balances and state from every authority, each fetched independently so one outage never hides the rest. */
  static async snapshot() {
    const d = this._deps();
    const mandate = getMandate();

    const [canonical, subLedger, fixedIncome, custodian, issuer, distributions, thirdweb, fabric, firefly] = await Promise.all([
      attempt(async () => {
        if (!d.CanonicalFundingSource) throw new Error('CanonicalFundingSource unavailable');
        const r = d.CanonicalFundingSource.readiness();
        if (!r.ready) throw new Error(`not configured: ${r.issues.join('; ')}`);
        return d.CanonicalFundingSource.reconcile();
      }),
      attempt(async () => {
        if (!d.TrustAccountingEngine) throw new Error('TrustAccountingEngine unavailable');
        const accounts = await d.TrustAccountingEngine.listAccounts({});
        return this._subLedgerTotals(accounts);
      }),
      attempt(async () => {
        if (!d.FixedIncomeDataService) throw new Error('FixedIncomeDataService unavailable');
        const s = await d.FixedIncomeDataService.getUnifiedSnapshot({ includeLive: true });
        return {
          sourceOfTruth: s.source_of_truth,
          positions: (s.bonds || []).length,
          principalUsd: round2(s.totals.total_principal_balance),
          accruedInterestUsd: round2(s.totals.total_accrued_interest),
          faceValueUsd: round2(s.totals.total_face_value),
          annualIncomeUsd: s.live && !s.live.error ? round2(s.live.total_annual_income) : null,
          dailyAccrualUsd: s.live && !s.live.error ? round2(s.live.total_daily_accrual) : null,
          tokenizedPrincipalUsd: s.tokenization ? round2(s.tokenization.total_tokenized_principal) : 0,
          tokenizationCoveragePct: s.tokenization ? s.tokenization.coverage_pct : 0,
          discrepancies: s.discrepancies || [],
        };
      }),
      attempt(async () => {
        if (!d.PrivateTrustCompanyEngine) throw new Error('PrivateTrustCompanyEngine unavailable');
        const sot = await d.PrivateTrustCompanyEngine.getSourceOfTruth();
        const beneficiaries = await d.PrivateTrustCompanyEngine.listBeneficiaries().catch(() => []);
        return {
          netWorthUsd: round2(sot.netWorth),
          principalUsd: round2(sot.principal),
          interestUsd: round2(sot.interest),
          bonds: sot.bonds.length,
          beneficiaries: beneficiaries.length,
        };
      }),
      attempt(async () => {
        if (!d.IssuerEngine) throw new Error('IssuerEngine unavailable');
        if (d.IssuerEngine.ensureTables) await d.IssuerEngine.ensureTables();
        const assets = await d.IssuerEngine.listAssets();
        const out = [];
        for (const a of assets) {
          const outstandingCents = Number(a.issued_cents || 0) - Number(a.redeemed_cents || 0);
          let reserveCents = null;
          if (d.CashEngine) {
            const reserve = await d.CashEngine.getAccount(a.reserve_account_id).catch(() => null);
            reserveCents = reserve ? Number(reserve.balance_cents || 0) : null;
          }
          out.push({
            assetCode: a.asset_code,
            name: a.name,
            status: a.status,
            outstandingUsd: fromCents(outstandingCents),
            reserveUsd: reserveCents === null ? null : fromCents(reserveCents),
            backed: reserveCents === null ? null : reserveCents >= outstandingCents,
          });
        }
        return { assets: out };
      }),
      attempt(async () => {
        if (!d.DistributionRequestEngine) throw new Error('DistributionRequestEngine unavailable');
        const rows = await d.DistributionRequestEngine.listRequests({ limit: 500 });
        return this._distributionTotals(rows);
      }),
      attempt(async () => {
        if (!d.ThirdwebServerWalletEngine) throw new Error('ThirdwebServerWalletEngine unavailable');
        const open = await d.ThirdwebServerWalletEngine.openTransfers({ limit: 1000 });
        return { openTransfers: open.length, openUsd: round2(open.reduce((s, t) => s + Number(t.amount_usd || t.amountUsd || 0), 0)) };
      }),
      attempt(async () => {
        if (!d.FabricLedgerEngine) throw new Error('FabricLedgerEngine unavailable');
        const rows = await d.FabricLedgerEngine.list({ limit: 500 });
        const by = (status) => rows.filter((r) => r.status === status).length;
        return { notarizations: rows.length, anchored: by('anchored'), shadow: by('shadow'), pending: by('pending'), failed: by('failed') };
      }),
      attempt(async () => {
        if (!d.FireflyEngine) throw new Error('FireflyEngine unavailable');
        const rows = await d.FireflyEngine.list({ limit: 500, kind: 'transfer' });
        const confirmed = rows.filter((r) => r.status === 'confirmed');
        return {
          transfers: rows.length,
          confirmed: confirmed.length,
          booked: confirmed.filter((r) => r.booked).length,
          confirmedUnbooked: confirmed.filter((r) => !r.booked).map((r) => ({ id: r.id, reference: r.reference, amountUsd: fromCents(r.amountCents) })),
          pending: rows.filter((r) => r.status === 'pending').length,
          failed: rows.filter((r) => r.status === 'failed').length,
          shadow: rows.filter((r) => r.status === 'shadow').length,
          notarized: rows.filter((r) => r.notarizationId).length,
        };
      }),
    ]);

    return {
      mandate,
      canonical, subLedger, fixedIncome, custodian, issuer, distributions, thirdweb, fabric, firefly,
      generatedAt: new Date().toISOString(),
    };
  }

  static _subLedgerTotals(accounts) {
    const t = { accounts: accounts.length, principalUsd: 0, incomeUsd: 0, cashUsd: 0, fundingEligibleUsd: 0, segregated: 0 };
    for (const a of accounts) {
      const code = String(a.account_code || '');
      const bal = Number(a.balance || 0);
      if (code.startsWith('1000') || code.startsWith('1010')) t.cashUsd += bal;
      if (code.startsWith('1100') || code.startsWith('1210')) t.principalUsd += bal;
      if (code.startsWith('4000') || code.startsWith('4100')) t.incomeUsd += bal;
      if (a.funding_eligible) t.fundingEligibleUsd += fromCents(a.available_balance_cents);
      if (a.segregation_status && a.segregation_status !== 'clear') t.segregated += 1;
    }
    for (const k of ['principalUsd', 'incomeUsd', 'cashUsd', 'fundingEligibleUsd']) t[k] = round2(t[k]);
    return t;
  }

  static _distributionTotals(rows) {
    const since = Date.now() - 365 * 24 * 3600 * 1000;
    const executed = rows.filter((r) => ['executed', 'payout_created'].includes(r.status));
    const recent = executed.filter((r) => new Date(r.created_at || 0).getTime() >= since);
    const meta = (r) => (typeof r.metadata === 'string' ? JSON.parse(r.metadata || '{}') : (r.metadata || {}));
    return {
      total: rows.length,
      pendingApproval: rows.filter((r) => ['requested', 'under_review'].includes(r.status)).length,
      approvedUnexecuted: rows.filter((r) => r.status === 'approved').length,
      executed: executed.length,
      failed: rows.filter((r) => r.status === 'failed').length,
      executedTrailing12mUsd: round2(recent.reduce((s, r) => s + fromCents(r.amount_cents), 0)),
      executedNotNotarized: executed.filter((r) => !meta(r).notarization).map((r) => r.id),
      executedOutsideMandate: executed.filter((r) => meta(r).mandate && meta(r).mandate.allowed === false).map((r) => r.id),
    };
  }

  // ─── pipeline evaluation ─────────────────────────────────────────────────

  /**
   * Distributable income under the mandate: income less the reserve percentage,
   * less what has already gone out over the trailing twelve months.
   * Income is the sub-ledger's booked income (the accounting authority); bond
   * accrued interest is the same interest before/at booking, so it is only
   * used when the sub-ledger cannot be read, never added on top.
   */
  static distributable(snapshot, mandate = getMandate()) {
    const incomeSource = snapshot.subLedger.ok ? 'postgres:trust_accounts' : (snapshot.fixedIncome.ok ? 'postgres:bond_balances' : null);
    const income = snapshot.subLedger.ok ? snapshot.subLedger.value.incomeUsd
      : (snapshot.fixedIncome.ok ? snapshot.fixedIncome.value.accruedInterestUsd : 0);
    const reserve = round2(income * (mandate.fundingPolicy.reserveIncomePct / 100));
    const distributed = snapshot.distributions.ok ? snapshot.distributions.value.executedTrailing12mUsd : 0;
    const known = incomeSource !== null;
    return {
      known,
      incomeSource,
      incomeUsd: round2(income),
      reserveUsd: reserve,
      distributedTrailing12mUsd: round2(distributed),
      distributableUsd: known ? round2(Math.max(0, income - reserve - distributed)) : null,
      corpusDrawUsd: known ? round2(Math.max(0, distributed - (income - reserve))) : null,
    };
  }

  static evaluatePipeline(readiness, snapshot) {
    const mandate = readiness.mandate;
    const c = readiness.components;
    const stages = [];
    const gaps = [];
    const stage = (key, status, detail, gapList = []) => {
      const def = PIPELINE_STAGES.find((s) => s.key === key);
      stages.push({ stage: key, label: def.label, status, detail });
      for (const g of gapList) gaps.push({ stage: key, ...g });
    };

    // 1. income
    if (!snapshot.fixedIncome.ok) stage('income', 'unavailable', { error: snapshot.fixedIncome.error }, [{ severity: 'high', gap: `fixed-income read model unavailable: ${snapshot.fixedIncome.error}` }]);
    else {
      const fi = snapshot.fixedIncome.value;
      const g = [];
      if (fi.positions === 0) g.push({ severity: 'high', gap: 'no active fixed-income positions: nothing funds beneficiary support' });
      if (fi.discrepancies.length) g.push({ severity: 'medium', gap: `${fi.discrepancies.length} fixed-income discrepancy(ies) (tokenized vs principal / live vs ledger)` });
      stage('income', g.length ? 'gap' : 'ok', fi, g);
    }

    // 2. distributable
    const dist = this.distributable(snapshot, mandate);
    {
      const g = [];
      if (!dist.known) g.push({ severity: 'high', gap: 'income cannot be measured: sub-ledger and fixed-income both unavailable' });
      else if (dist.corpusDrawUsd > 0 && !mandate.fundingPolicy.allowCorpusDistributions) g.push({ severity: 'high', gap: `trailing-12m distributions exceed distributable income by $${dist.corpusDrawUsd.toFixed(2)} (drawing on corpus)` });
      if (snapshot.distributions.ok && snapshot.distributions.value.executedOutsideMandate.length) g.push({ severity: 'high', gap: `${snapshot.distributions.value.executedOutsideMandate.length} distribution(s) executed against a failed mandate check` });
      stage('distributable', g.length ? 'gap' : (dist.known ? 'ok' : 'unavailable'), { ...dist, distributions: snapshot.distributions.ok ? snapshot.distributions.value : { error: snapshot.distributions.error } }, g);
    }

    // 3. policy
    {
      const policy = DistributionPolicy.getPolicy();
      const g = [];
      if (!(policy.limitsUsd.beneficiary > 0) || !(policy.limitsUsd.trustee > 0)) g.push({ severity: 'medium', gap: 'a distribution ceiling is 0/unlimited; set DISTRIBUTION_LIMIT_*_USD' });
      stage('policy', g.length ? 'gap' : 'ok', { ...policy, enforce: mandate.fundingPolicy.enforce }, g);
    }

    // 4. funding
    if (!c.fineract.available || !c.fineract.ready) stage('funding', 'unavailable', { issues: c.fineract.issues }, [{ severity: mandate.fundingPolicy.requireCanonicalFunding ? 'high' : 'medium', gap: `canonical Fineract funding source not ready: ${(c.fineract.issues || []).join('; ')}` }]);
    else if (!snapshot.canonical.ok) stage('funding', 'unavailable', { error: snapshot.canonical.error }, [{ severity: 'high', gap: `Fineract reconciliation failed: ${snapshot.canonical.error}` }]);
    else {
      const r = snapshot.canonical.value;
      const g = r.inSync ? [] : [{ severity: 'high', gap: `Fineract GL and trust sub-ledger disagree beyond $${r.toleranceUsd} on ${r.accounts.filter((a) => !a.inSync).map((a) => a.accountCode).join(', ')}` }];
      stage('funding', g.length ? 'gap' : 'ok', r, g);
    }

    // 5. notarize
    {
      const g = [];
      if (!c.fabric.available) g.push({ severity: 'high', gap: 'Fabric engine unavailable' });
      else if (!c.fabric.canNotarize) g.push({ severity: 'medium', gap: `Fabric not configured: ${(c.fabric.issues || []).join('; ')}` });
      else if (c.fabric.mode !== 'live') g.push({ severity: 'info', gap: 'Fabric in shadow mode: digests stored locally, not anchored on-chain' });
      if (snapshot.distributions.ok && snapshot.distributions.value.executedNotNotarized.length) g.push({ severity: 'medium', gap: `${snapshot.distributions.value.executedNotNotarized.length} executed distribution(s) have no Fabric notarization` });
      if (snapshot.firefly.ok && snapshot.firefly.value.transfers > snapshot.firefly.value.notarized) g.push({ severity: 'medium', gap: `${snapshot.firefly.value.transfers - snapshot.firefly.value.notarized} FireFly transfer(s) not notarized` });
      if (snapshot.fabric.ok && snapshot.fabric.value.failed) g.push({ severity: 'medium', gap: `${snapshot.fabric.value.failed} notarization(s) failed` });
      stage('notarize', g.some((x) => x.severity !== 'info') ? 'gap' : 'ok', { fabric: snapshot.fabric.ok ? snapshot.fabric.value : { error: snapshot.fabric.error }, mode: c.fabric.mode }, g);
    }

    // 6. settle
    {
      const rails = { thirdweb: c.thirdweb.mode, firefly: c.firefly.mode, thirdwebCanSend: Boolean(c.thirdweb.canSend), fireflyCanTransfer: Boolean(c.firefly.canTransfer) };
      const g = [];
      if (!c.thirdweb.available && !c.firefly.available) g.push({ severity: 'high', gap: 'no settlement rail available' });
      else if (!rails.thirdwebCanSend && !rails.fireflyCanTransfer) g.push({ severity: 'info', gap: 'no settlement rail can move value live; distributions settle in shadow mode' });
      stage('settle', g.some((x) => x.severity !== 'info') ? 'gap' : 'ok', rails, g);
    }

    // 7. confirm
    {
      const g = [];
      const ff = snapshot.firefly.ok ? snapshot.firefly.value : null;
      const tw = snapshot.thirdweb.ok ? snapshot.thirdweb.value : null;
      if (ff && ff.pending) g.push({ severity: 'info', gap: `${ff.pending} FireFly transfer(s) awaiting confirmation` });
      if (ff && ff.failed) g.push({ severity: 'medium', gap: `${ff.failed} FireFly transfer(s) failed (one retry allowed each)` });
      if (tw && tw.openTransfers) g.push({ severity: 'info', gap: `${tw.openTransfers} thirdweb transfer(s) queued/submitted` });
      if (c.thirdweb.available && c.thirdweb.mode === 'live' && !c.thirdweb.webhookConfigured) g.push({ severity: 'medium', gap: 'thirdweb live without THIRDWEB_WEBHOOK_SECRET: confirmations rely on polling only' });
      stage('confirm', g.some((x) => x.severity !== 'info') ? 'gap' : 'ok', { firefly: ff, thirdweb: tw }, g);
    }

    // 8. book
    {
      const g = [];
      const ff = snapshot.firefly.ok ? snapshot.firefly.value : null;
      if (ff && ff.confirmedUnbooked.length) g.push({ severity: 'high', gap: `${ff.confirmedUnbooked.length} confirmed FireFly transfer(s) not booked (run reconcile)` });
      stage('book', g.length ? 'gap' : 'ok', { confirmedUnbooked: ff ? ff.confirmedUnbooked : null }, g);
    }

    // 9. reconcile
    {
      const g = [];
      const views = {
        fineractCashUsd: snapshot.canonical.ok ? round2(snapshot.canonical.value.accounts.reduce((s, a) => s + Number(a.canonicalUsd || 0), 0)) : null,
        subLedgerCashUsd: snapshot.subLedger.ok ? snapshot.subLedger.value.cashUsd : null,
        subLedgerPrincipalUsd: snapshot.subLedger.ok ? snapshot.subLedger.value.principalUsd : null,
        bondPrincipalUsd: snapshot.fixedIncome.ok ? snapshot.fixedIncome.value.principalUsd : null,
        custodianPrincipalUsd: snapshot.custodian.ok ? snapshot.custodian.value.principalUsd : null,
        subLedgerIncomeUsd: snapshot.subLedger.ok ? snapshot.subLedger.value.incomeUsd : null,
        bondAccruedInterestUsd: snapshot.fixedIncome.ok ? snapshot.fixedIncome.value.accruedInterestUsd : null,
        custodianIncomeUsd: snapshot.custodian.ok ? snapshot.custodian.value.interestUsd : null,
        issuerBacked: snapshot.issuer.ok ? snapshot.issuer.value.assets.every((a) => a.backed !== false) : null,
      };
      const differs = (a, b) => a !== null && b !== null && Math.abs(a - b) > 0.01;
      if (differs(views.subLedgerIncomeUsd, views.bondAccruedInterestUsd)) {
        g.push({ severity: 'medium', gap: `sub-ledger booked income $${views.subLedgerIncomeUsd} != bond accrued interest $${views.bondAccruedInterestUsd} (accrual not booked, or booked without a position)` });
      }
      if (differs(views.custodianIncomeUsd, views.subLedgerIncomeUsd)) {
        g.push({ severity: 'medium', gap: `custodian income view $${views.custodianIncomeUsd} != sub-ledger income $${views.subLedgerIncomeUsd} (custodian view double-counts or is stale); distributable uses the sub-ledger` });
      }
      if (differs(views.custodianPrincipalUsd, views.bondPrincipalUsd)) {
        g.push({ severity: 'medium', gap: `custodian principal view $${views.custodianPrincipalUsd} != bond principal $${views.bondPrincipalUsd}` });
      }
      if (snapshot.issuer.ok) {
        const unbacked = snapshot.issuer.value.assets.filter((a) => a.backed === false);
        if (unbacked.length) g.push({ severity: 'high', gap: `issuer asset(s) under-reserved: ${unbacked.map((a) => a.assetCode).join(', ')}` });
      }
      if (views.subLedgerPrincipalUsd !== null && views.bondPrincipalUsd !== null && views.subLedgerPrincipalUsd > 0 && Math.abs(views.subLedgerPrincipalUsd - views.bondPrincipalUsd) > 0.01) {
        g.push({ severity: 'medium', gap: `sub-ledger investment principal $${views.subLedgerPrincipalUsd} != bond principal $${views.bondPrincipalUsd}` });
      }
      for (const [k, v] of Object.entries(snapshot)) {
        if (v && typeof v === 'object' && v.ok === false) g.push({ severity: 'medium', gap: `${k} view unavailable: ${v.error}` });
      }
      stage('reconcile', g.length ? 'gap' : 'ok', views, g);
    }

    return { stages, gaps, distributable: dist };
  }

  /** Everything: mandate, component readiness, unified snapshot, pipeline stages, gaps. */
  static async controlPlane() {
    const readiness = this.readiness();
    const snapshot = await this.snapshot();
    const pipeline = this.evaluatePipeline(readiness, snapshot);
    const gaps = [...readiness.gaps.map((g) => ({ stage: null, ...g })), ...pipeline.gaps];
    return {
      mandate: readiness.mandate,
      components: readiness.components,
      live: readiness.live,
      snapshot,
      pipeline: pipeline.stages,
      distributable: pipeline.distributable,
      gaps,
      blockingGaps: gaps.filter((g) => g.severity === 'high').length,
      generatedAt: new Date().toISOString(),
    };
  }

  // ─── distribution guard ──────────────────────────────────────────────────

  /**
   * Decide whether one distribution fits the mandate. Never throws; the
   * caller decides whether `allowed === false` is enforced or only recorded.
   */
  static async evaluateDistribution({ amountUsd, requesterRole = 'beneficiary', purpose = null, snapshot = null } = {}) {
    const d = this._deps();
    const mandate = getMandate();
    const checks = [];
    const check = (name, ok, detail, blocking = true) => checks.push({ check: name, ok, blocking: ok ? false : blocking, detail });
    const usd = Number(amountUsd);

    try {
      const p = DistributionPolicy.enforce({ requesterRole, amountUsd: usd, purpose });
      check('policy', true, { limitUsd: p.limitUsd, requesterRole: p.requesterRole, purpose: p.purpose });
    } catch (e) {
      check('policy', false, { error: e.message, code: e.code });
    }

    const snap = snapshot || await this.snapshot();
    const dist = this.distributable(snap, mandate);
    if (!dist.known) check('distributable-income', false, { error: 'income cannot be measured' }, !mandate.fundingPolicy.allowCorpusDistributions);
    else if (Number.isFinite(usd) && usd > dist.distributableUsd) {
      check('distributable-income', false, { requestedUsd: usd, distributableUsd: dist.distributableUsd, source: 'fixed-income', wouldDrawCorpusUsd: round2(usd - dist.distributableUsd) }, !mandate.fundingPolicy.allowCorpusDistributions);
    } else check('distributable-income', true, { requestedUsd: usd, distributableUsd: dist.distributableUsd });

    if (d.CanonicalFundingSource && d.CanonicalFundingSource.readiness().ready) {
      const r = await attempt(() => d.CanonicalFundingSource.assertAvailable({ amountUsd: usd, purpose: purpose || 'beneficiary support' }));
      if (r.ok) check('canonical-funding', true, { accountCode: r.value.accountCode, availableUsd: fromCents(r.value.availableBalanceCents) });
      else check('canonical-funding', false, { error: r.error });
    } else {
      check('canonical-funding', false, { error: 'canonical Fineract funding source not configured' }, mandate.fundingPolicy.requireCanonicalFunding);
    }

    const rails = [];
    if (d.ThirdwebSettlementEngine) { try { const t = d.ThirdwebSettlementEngine.readiness(); rails.push({ rail: 'thirdweb', live: Boolean(t.live), ready: t.ready }); } catch (e) { rails.push({ rail: 'thirdweb', error: e.message }); } }
    if (d.FireflyEngine) { try { const f = d.FireflyEngine.readiness(); rails.push({ rail: 'firefly', live: Boolean(f.live), ready: Boolean(f.canTransfer) }); } catch (e) { rails.push({ rail: 'firefly', error: e.message }); } }
    check('settlement-rail', rails.length > 0, { rails, live: rails.some((r) => r.live && r.ready) }, false);

    const blocking = checks.filter((c) => !c.ok && c.blocking);
    return {
      mandate: { legalName: mandate.legalName, fundingSource: mandate.fundingPolicy.source, enforce: mandate.fundingPolicy.enforce },
      amountUsd: usd,
      allowed: blocking.length === 0,
      enforced: mandate.fundingPolicy.enforce,
      blocking: blocking.map((c) => c.check),
      checks,
      distributable: dist,
      evaluatedAt: new Date().toISOString(),
    };
  }

  /**
   * Evidence for an executed distribution: notarize the record on Fabric
   * (shadow or live per FABRIC_LEDGER_LIVE). Returns null when Fabric is not
   * loadable so the caller can record the gap instead of failing the payout.
   */
  static async notarizeDistribution(request, payment) {
    const d = this._deps();
    if (!d.FabricLedgerEngine) return null;
    const row = await d.FabricLedgerEngine.notarize({
      recordType: 'distribution_request',
      recordId: request.id,
      payload: {
        id: request.id,
        type: request.type,
        amountCents: Number(request.amount_cents),
        destination: request.destination_address,
        beneficiaryEmail: request.beneficiary_email,
        payoutId: payment && payment.id ? payment.id : null,
        txHash: payment && payment.tx_hash ? payment.tx_hash : null,
        status: payment && payment.status ? payment.status : null,
      },
      metadata: { trust: getMandate().legalName, pipeline: 'beneficiary-support' },
      notarizedBy: 'distribution-request-engine',
    });
    return { id: row.id, digest: row.digest, status: row.status, transactionId: row.transactionId || null };
  }
}

module.exports = { TrustControlPlaneEngine };
