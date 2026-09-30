'use strict';

/**
 * Unified Trust Data OS — one ordered pass over the engines that hold the
 * trust's asset, backing and balance data, producing a single snapshot every
 * dashboard and report can read.
 *
 *   1. custody            Custody OS chain + statement (third-party vs self-custody)
 *   2. pe-holdings        Private Equity Holdings OS evaluate -> eligible collateral, intra-trust book
 *   3. pledge             Pledge OS evaluate -> counted pledges + Collateral OS coverage
 *   4. collateral         Collateral OS revalue -> facility (collateral / spendable / drawn)
 *   5. enterprise-credit    Enterprise Credit OS evaluate -> capacity / used / available
 *   6. enterprise-capacity  Enterprise Capacity OS evaluate -> intra-trust capacity of self-custody assets
 *   7. credit               Credit OS funding sources + ledger validation
 *   8. attestation          Attestation OS latest attested vs claimed
 *   9. ledger               trust_accounts synced to posted journal lines (reconcileTrustBalances)
 *  10. cash                 DataBridge cash-module vs trust-ledger reconciliation
 *  11. network              Egress OS path (VPC connector -> Cloud NAT static IP) + Cloud VPN tunnels
 *
 * Each step runs even when an earlier one fails; failures and cross-engine
 * consistency checks are reported on the snapshot. Nothing here posts journal
 * entries, moves money or changes a collateral / backing verdict rule: the
 * ledger step only aligns cached trust_accounts.balance with posted journal
 * lines when `syncLedger` is set.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');

function tryRequire(mod) {
  try { return require(mod); } catch (e) { return null; }
}

const engines = {
  custody: () => tryRequire('../custody/custodyOsEngine')?.CustodyOsEngine || null,
  pe: () => tryRequire('./privateEquityHoldingsOsEngine')?.PrivateEquityHoldingsOsEngine || null,
  pledge: () => tryRequire('./pledgeOsEngine')?.PledgeOsEngine || null,
  collateral: () => tryRequire('./collateralOsEngine')?.CollateralOsEngine || null,
  enterpriseCredit: () => tryRequire('./enterpriseCreditOsEngine')?.EnterpriseCreditOsEngine || null,
  enterpriseCapacity: () => tryRequire('./enterpriseCapacityOsEngine')?.EnterpriseCapacityOsEngine || null,
  credit: () => tryRequire('./creditOsEngine')?.CreditOsEngine || null,
  attestation: () => tryRequire('./attestationOsEngine')?.AttestationOsEngine || null,
  reconcile: () => tryRequire('../../scripts/reconcileTrustBalances') || null,
  dataBridge: () => tryRequire('../accounting/dataBridge')?.DataBridge || null,
  egress: () => tryRequire('./egressOsEngine')?.EgressOsEngine || null,
};

const LEDGER_ACCOUNTS = {
  '1000': 'cash',
  '1015': 'inTransit',
  '1020': 'couponCash',
  '1030': 'operatingCash',
  '1040': 'settlementAccount',
  '1050': 'billCash',
  '1100': 'bondInvestments',
};

class UnifiedTrustDataError extends Error {
  constructor(message, code = 'UNIFIED_DATA_ERROR', status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function getUnifiedTrustDataConfig(env = process.env) {
  return {
    enabled: String(env.UNIFIED_DATA_ENABLED || 'true').toLowerCase() !== 'false',
    staleHours: Number(env.UNIFIED_DATA_STALE_HOURS || 36),
  };
}

function dollars(cents) { return (Number(cents || 0) / 100).toFixed(2); }

async function step(name, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    return { name, ok: true, ms: Date.now() - started, value };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - started, error: e.message };
  }
}

function vpnStatus(env = process.env) {
  return {
    configured: String(env.PRIVATE_ACCESS_VPN_ENABLED || '').toLowerCase() === 'true',
    gateway: String(env.PRIVATE_ACCESS_VPN_GATEWAY || '').trim() || null,
    tunnels: Number(env.PRIVATE_ACCESS_VPN_TUNNELS) || 0,
  };
}

function need(engine, name) {
  if (!engine) throw new Error(`${name} not loadable`);
  return engine;
}

const UnifiedTrustDataOsEngine = {
  config() { return getUnifiedTrustDataConfig(); },

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS unified_trust_snapshots (
        snapshot_id   TEXT PRIMARY KEY,
        run_by        TEXT NOT NULL,
        ledger_synced BOOLEAN NOT NULL DEFAULT FALSE,
        checks_failed INTEGER NOT NULL DEFAULT 0,
        steps_failed  INTEGER NOT NULL DEFAULT 0,
        snapshot      JSONB NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_unified_trust_snapshots_created ON unified_trust_snapshots (created_at DESC)');
    return true;
  },

  async run({ actor = null, syncLedger = false } = {}) {
    const cfg = this.config();
    if (!cfg.enabled) throw new UnifiedTrustDataError('UNIFIED_DATA_ENABLED is false', 'UNIFIED_DATA_DISABLED', 409);
    const who = String(actor || '').trim();
    if (!who) throw new UnifiedTrustDataError('actor is required', 'UNIFIED_DATA_ACTOR', 400);
    await this.ensureTables();

    const steps = [];
    steps.push(await step('custody', async () => {
      const Custody = need(engines.custody(), 'Custody OS');
      const [chain, statement] = await Promise.all([Custody.verifyChain(), Custody.statement()]);
      return { chain, statement };
    }));
    steps.push(await step('pe-holdings', async () => {
      const Pe = need(engines.pe(), 'Private Equity Holdings OS');
      const evaluateError = await Pe.evaluate({ actor: who }).then(() => null, (e) => e.message);
      const status = await Pe.status();
      return { summary: status.summary, chain: status.chain, evaluateError };
    }));
    steps.push(await step('pledge', async () => {
      const Pledge = need(engines.pledge(), 'Pledge OS');
      const evaluateError = await Pledge.evaluate({ actor: who }).then(() => null, (e) => e.message);
      const [status, coverage] = await Promise.all([Pledge.status(), Pledge.coverage()]);
      return { summary: status.summary, chain: status.chain, coverage, evaluateError };
    }));
    steps.push(await step('collateral', async () => {
      const Collateral = need(engines.collateral(), 'Collateral OS');
      await Collateral.revalue({ actor: who });
      return { facility: await Collateral.facility() };
    }));
    steps.push(await step('enterprise-credit', async () => {
      const Ec = need(engines.enterpriseCredit(), 'Enterprise Credit OS');
      const evaluateError = await Ec.evaluate({ actor: who }).then(() => null, (e) => e.message);
      const status = await Ec.status();
      return { capacity: status.capacity, summary: status.summary, chain: status.chain, evaluateError };
    }));
    steps.push(await step('enterprise-capacity', async () => {
      const Capacity = need(engines.enterpriseCapacity(), 'Enterprise Capacity OS');
      const evaluateError = await Capacity.evaluate({ actor: who }).then(() => null, (e) => e.message);
      const status = await Capacity.status();
      return { capacity: status.capacity, summary: status.summary, chain: status.chain, evaluateError };
    }));
    steps.push(await step('credit', async () => {
      const Credit = need(engines.credit(), 'Credit OS');
      return Credit.status();
    }));
    steps.push(await step('attestation', async () => {
      const Att = need(engines.attestation(), 'Attestation OS');
      const s = await Att.snapshot();
      return { attestedCents: s.attestedCents, claimedCents: s.claimedCents, varianceCents: s.varianceCents, enforcement: s.enforcement };
    }));
    steps.push(await step('ledger', async () => {
      const R = need(engines.reconcile(), 'reconcileTrustBalances');
      const before = await R.reconcileTrustBalances({ apply: false });
      const applied = syncLedger && before.drift.length ? await R.reconcileTrustBalances({ apply: true }) : null;
      const balances = applied ? applied.balances : before.balances;
      return {
        synced: Boolean(applied),
        driftBefore: before.drift.map((d) => ({ accountCode: d.account_code, stored: d.stored_balance, derived: d.derived_balance, drift: d.drift })),
        driftRemaining: applied ? [] : before.drift.map((d) => d.account_code),
        balances: balances.map((b) => ({ accountCode: b.account_code, accountName: b.account_name, accountType: b.account_type, balance: b.derived_balance })),
      };
    }));
    steps.push(await step('cash', async () => {
      const Bridge = need(engines.dataBridge(), 'DataBridge');
      const r = await Bridge.reconcileCashToAccounting();
      return { cashModuleTotal: r.cashModuleTotal, trustAccountingTotal: r.trustAccountingTotal, difference: r.difference, isReconciled: r.isReconciled, discrepancies: (r.discrepancies || []).length };
    }));

    steps.push(await step('network', async () => {
      const Egress = need(engines.egress(), 'Egress OS');
      const s = await Egress.status();
      return {
        path: s.path,
        enforce: s.enforce,
        lastProbe: s.lastProbe ? { matched: s.lastProbe.matched, observedIp: s.lastProbe.observedIp, error: s.lastProbe.error || null, at: s.lastProbe.at } : null,
        vpn: vpnStatus(),
      };
    }));

    const snapshot = this._compose(steps, { actor: who, syncLedger });
    await pool.query(
      `INSERT INTO unified_trust_snapshots (snapshot_id, run_by, ledger_synced, checks_failed, steps_failed, snapshot, created_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [snapshot.snapshotId, who, snapshot.ledger.synced, snapshot.checks.filter((c) => !c.ok).length,
        snapshot.steps.filter((s) => !s.ok).length, JSON.stringify(snapshot), snapshot.createdAt]
    );
    return snapshot;
  },

  _compose(steps, { actor, syncLedger }) {
    const v = Object.fromEntries(steps.map((s) => [s.name, s.ok ? s.value : null]));
    const ledgerRows = v.ledger ? v.ledger.balances : [];
    const ledger = {};
    for (const [code, key] of Object.entries(LEDGER_ACCOUNTS)) {
      const row = ledgerRows.find((r) => r.accountCode === code);
      ledger[key] = row ? { accountCode: code, balance: Number(row.balance.toFixed(2)) } : null;
    }
    const statement = v.custody ? v.custody.statement : null;
    const pe = v['pe-holdings'] ? v['pe-holdings'].summary : null;
    const intra = pe && pe.intraTrust ? pe.intraTrust : { holdings: 0, bookCents: 0, countsAsCollateral: false };
    const facility = v.collateral ? v.collateral.facility : null;
    const cap = v['enterprise-credit'] ? v['enterprise-credit'].capacity : null;
    const pledge = v.pledge ? v.pledge.summary : null;
    const intraCap = v['enterprise-capacity'] && v['enterprise-capacity'].capacity && !v['enterprise-capacity'].capacity.error
      ? v['enterprise-capacity'].capacity : null;

    const chains = {
      custody: v.custody ? v.custody.chain : null,
      peHoldings: v['pe-holdings'] ? v['pe-holdings'].chain : null,
      pledge: v.pledge ? v.pledge.chain : null,
      enterpriseCredit: v['enterprise-credit'] ? v['enterprise-credit'].chain : null,
      enterpriseCapacity: v['enterprise-capacity'] ? v['enterprise-capacity'].chain : null,
    };

    const checks = [];
    const check = (name, ok, detail) => checks.push({ check: name, ok: Boolean(ok), detail });
    for (const [name, c] of Object.entries(chains)) {
      if (c) check(`${name} event chain intact`, c.intact, c.intact ? `${c.events} events` : `${(c.breaks || []).length} break(s)`);
    }
    if (v.ledger) check('trust_accounts match posted journal lines', v.ledger.driftRemaining.length === 0,
      v.ledger.driftRemaining.length ? `drift on ${v.ledger.driftRemaining.join(', ')}` : (v.ledger.synced ? `synced ${v.ledger.driftBefore.length} account(s)` : 'no drift'));
    if (v.cash) check('cash module matches trust ledger cash', v.cash.isReconciled, `difference ${Number(v.cash.difference || 0).toFixed(2)}`);
    if (pe) check('intra-trust holdings excluded from collateral', !intra.countsAsCollateral, `book ${dollars(intra.bookCents)} (not collateral)`);
    if (facility) check('Collateral OS drawn within spendable', Number(facility.drawnUsd || 0) <= Number(facility.spendableUsd || 0) + 0.005,
      `drawn ${Number(facility.drawnUsd || 0).toFixed(2)} / spendable ${Number(facility.spendableUsd || 0).toFixed(2)}`);
    if (intraCap) {
      check('intra capacity excluded from collateral + credit', !intraCap.countsAsCollateral && !intraCap.collateralOsBorrowingBase && !intraCap.enterpriseCreditCapacity,
        `intra ${intraCap.capacity} (not collateral)`);
      check('intra capacity earmarks within capacity', intraCap.usedCents <= intraCap.capacityCents, `earmarked ${intraCap.used} / intra ${intraCap.capacity}`);
      if (statement) check('intra capacity basis matches custody self-custody', intraCap.selfCustodyCents === Number(statement.selfCustodyCents),
        `capacity basis ${intraCap.selfCustody} / custody self-custody ${statement.selfCustody}`);
    }
    if (cap) check('Enterprise Credit used within capacity', cap.usedCents <= cap.capacityCents, `used ${dollars(cap.usedCents)} / capacity ${dollars(cap.capacityCents)}`);

    if (v.network) {
      check('egress on VPC connector + Cloud NAT static IP', Boolean(v.network.path && v.network.path.vpcConnector && v.network.path.staticIp),
        v.network.path ? `${v.network.path.vpcConnector || 'no connector'} -> ${v.network.path.staticIp || 'no static IP'}` : 'no path');
      check('Cloud VPN tunnels up', v.network.vpn.configured && v.network.vpn.tunnels > 0,
        v.network.vpn.configured ? `${v.network.vpn.gateway} (${v.network.vpn.tunnels} tunnel(s))` : 'Cloud VPN not provisioned (vpn_peer_ip unset)');
    }

    const createdAt = new Date().toISOString();
    return {
      snapshotId: `UTD-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      createdAt,
      runBy: actor,
      ledger: { synced: Boolean(v.ledger && v.ledger.synced), requestedSync: Boolean(syncLedger), accounts: ledger, all: ledgerRows, driftBefore: v.ledger ? v.ledger.driftBefore : [] },
      cash: v.cash,
      custody: statement ? {
        held: statement.held, thirdPartyReceipted: statement.thirdPartyReceipted, selfCustody: statement.selfCustody,
        unreceipted: statement.unreceipted, byAssetClass: statement.byAssetClass, accounts: (statement.accounts || []).length,
      } : null,
      backing: {
        peEligibleCollateral: pe ? dollars(pe.eligibleCollateralCents) : null,
        peHoldings: pe ? pe.holdings : null,
        intraTrust: { holdings: intra.holdings, book: dollars(intra.bookCents), countsAsCollateral: Boolean(intra.countsAsCollateral) },
        pledges: pledge ? { total: pledge.pledges, counted: pledge.counted, countedValue: pledge.countedValue, liens: pledge.liens } : null,
        pledgeCoverage: v.pledge ? v.pledge.coverage : null,
        collateralOs: facility ? { collateral: Number(facility.collateralUsd || 0).toFixed(2), spendable: Number(facility.spendableUsd || 0).toFixed(2), drawn: Number(facility.drawnUsd || 0).toFixed(2), openDraws: facility.openDraws || 0 } : null,
        intraCapacity: intraCap ? {
          selfCustody: intraCap.selfCustody, selfCustodyReceipted: intraCap.selfCustodyReceipted.usd, intraRateBps: intraCap.intraRateBps,
          capacity: intraCap.capacity, earmarked: intraCap.used, available: intraCap.available, outsideReceipted: intraCap.outsideReceipted.usd,
          byAccount: intraCap.byAccount, countsAsCollateral: false,
          open: v['enterprise-capacity'].summary ? v['enterprise-capacity'].summary.open : 0,
        } : null,
        enterpriseCredit: cap ? { capacity: dollars(cap.capacityCents), used: dollars(cap.usedCents), available: dollars(cap.availableCents), open: v['enterprise-credit'].summary ? v['enterprise-credit'].summary.open : 0 } : null,
      },
      attestation: v.attestation ? {
        attested: dollars(v.attestation.attestedCents), claimed: dollars(v.attestation.claimedCents), variance: dollars(v.attestation.varianceCents), enforcement: v.attestation.enforcement,
      } : null,
      credit: v.credit ? { mode: v.credit.mode, realValueCapable: Boolean(v.credit.realValueCapable), ledgerValid: Boolean(v.credit.ledger && v.credit.ledger.valid), fundingSources: v.credit.fundingSources || [] } : null,
      network: v.network,
      chains,
      checks,
      steps: steps.map((s) => ({ name: s.name, ok: s.ok, ms: s.ms, error: s.error || null })),
    };
  },

  /** Re-anchor every broken engine event chain, keeping the replaced hashes on a chain_resealed event. */
  async resealChains({ actor = null, reason } = {}) {
    const who = String(actor || '').trim();
    if (!who) throw new UnifiedTrustDataError('actor is required', 'UNIFIED_DATA_ACTOR', 400);
    if (!String(reason || '').trim()) throw new UnifiedTrustDataError('reason is required', 'UNIFIED_DATA_REASON', 400);
    const out = {};
    const targets = [
      ['peHoldings', engines.pe()],
      ['pledge', engines.pledge()],
      ['enterpriseCredit', engines.enterpriseCredit()],
      ['enterpriseCapacity', engines.enterpriseCapacity()],
      ['custody', engines.custody()],
    ];
    for (const [name, engine] of targets) {
      if (!engine) { out[name] = { error: 'not loadable' }; continue; }
      const r = await step(name, async () => {
        const chain = await engine.verifyChain();
        if (chain.intact) return { skipped: true, events: chain.events, intact: true };
        return engine.resealChain({ actor: who, reason });
      });
      out[name] = r.ok ? r.value : { error: r.error };
    }
    return out;
  },

  async latest() {
    await this.ensureTables();
    const { rows } = await pool.query('SELECT * FROM unified_trust_snapshots ORDER BY created_at DESC LIMIT 1');
    if (!rows[0]) return null;
    return typeof rows[0].snapshot === 'string' ? JSON.parse(rows[0].snapshot) : rows[0].snapshot;
  },

  async history({ limit = 30 } = {}) {
    await this.ensureTables();
    const { rows } = await pool.query(
      'SELECT snapshot_id, run_by, ledger_synced, checks_failed, steps_failed, created_at FROM unified_trust_snapshots ORDER BY created_at DESC LIMIT $1',
      [Math.min(Math.max(Number(limit) || 30, 1), 500)]
    );
    return rows.map((r) => ({ snapshotId: r.snapshot_id, runBy: r.run_by, ledgerSynced: r.ledger_synced, checksFailed: r.checks_failed, stepsFailed: r.steps_failed, createdAt: r.created_at }));
  },

  async status() {
    const cfg = this.config();
    const latest = await this.latest();
    return { enabled: cfg.enabled, staleHours: cfg.staleHours, latest, movesMoney: false };
  },

  async health() {
    const s = await this.status();
    return { ok: s.enabled, latestAt: s.latest ? s.latest.createdAt : null };
  },

  async readiness() {
    const status = await this.status();
    const cfg = this.config();
    const blockers = [];
    const warnings = [];
    if (!cfg.enabled) blockers.push('UNIFIED_DATA_ENABLED is false');
    const latest = status.latest;
    if (!latest) warnings.push('no unified snapshot yet (action=run)');
    else {
      const ageH = (Date.now() - new Date(latest.createdAt).getTime()) / 3600000;
      if (ageH > cfg.staleHours) warnings.push(`latest unified snapshot is ${ageH.toFixed(1)}h old`);
      for (const c of latest.checks.filter((x) => !x.ok)) warnings.push(`${c.check}: ${c.detail}`);
      for (const s of latest.steps.filter((x) => !x.ok)) warnings.push(`${s.name} step failed: ${s.error}`);
    }
    return { ready: blockers.length === 0, mode: cfg.enabled ? 'live' : 'disabled', blockers, warnings, status };
  },

  async process({ action, actor = null, ...body } = {}) {
    switch (action) {
      case 'run': return this.run({ actor, syncLedger: Boolean(body.syncLedger) });
      case 'latest': return this.latest();
      case 'history': return this.history(body);
      case 'reseal_chains': return this.resealChains({ actor, reason: body.reason });
      default:
        throw new UnifiedTrustDataError(`unknown action "${action}" (run, latest, history, reseal_chains)`, 'UNIFIED_DATA_UNKNOWN_ACTION', 400);
    }
  },
};

module.exports = { UnifiedTrustDataOsEngine, UnifiedTrustDataError, getUnifiedTrustDataConfig, LEDGER_ACCOUNTS };
