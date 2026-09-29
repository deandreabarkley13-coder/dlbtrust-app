'use strict';

/**
 * Trust Administration & Distribution pipeline on GCP. Every engine feeds the
 * next in one ordered, leader-elected cycle (run()) and one status surface:
 *
 *   bankFeed     BankingAggregator (Finlynq/Betterment) -> DataBridge -> trust GL -> Fineract
 *   issuance     BondIssuanceEngine: issuer -> holder P&I booked in Fineract + GL
 *   fineract     CanonicalFundingSource: the treasury ERP GL is the funding authority
 *   proof        ProofOfAssetOsEngine over contract + Fineract + GL + fiat + custody
 *   reserve      ReserveEngine: externally attested, spendable reserve (strict gate)
 *   collateral   CollateralOsEngine facility readiness
 *   distribution FixedIncomeDistributionEngine: posted 1020/1030 -> planned -> staged
 *                against the Fineract canonical GL and Reserve OS
 *   compliance   FraudComplianceOsEngine screeningRef enforcement
 *   funding      TreasuryOdfiBank: the ODFI that accepts the treasury's NACHA files
 *   settlement   BankSettlementEngine -> Lili NACHA credit over OpenACH/MFT/SFTP
 *   ledger       DepositAndSettlementEngine recent deposits
 *
 * run() never moves money: execution still requires maker/checker approvalRef
 * and a cleared screeningRef. Every stage is read best-effort so one
 * unavailable engine never hides the others.
 */

let DepositAndSettlementEngine, BankSettlementEngine, SettlementBankRegistry, FixedIncomeDistributionEngine, DataBridge;
try { ({ DepositAndSettlementEngine } = require('../payments/depositAndSettlementEngine')); } catch (e) { DepositAndSettlementEngine = null; }
try { ({ BankSettlementEngine } = require('../payments/bankSettlementEngine')); } catch (e) { BankSettlementEngine = null; }
try { ({ SettlementBankRegistry } = require('../payments/settlementBankRegistry')); } catch (e) { SettlementBankRegistry = null; }
try { ({ FixedIncomeDistributionEngine } = require('../os/fixedIncomeDistributionEngine')); } catch (e) { FixedIncomeDistributionEngine = null; }
try { ({ DataBridge } = require('../accounting/dataBridge')); } catch (e) { DataBridge = null; }

let BondIssuanceEngine = null;
try { ({ BondIssuanceEngine } = require('../bonds/bondIssuanceEngine')); } catch (e) { BondIssuanceEngine = null; }

let ProofOfAssetOsEngine = null;
try { ({ ProofOfAssetOsEngine } = require('../os/proofOfAssetOsEngine')); } catch (e) { ProofOfAssetOsEngine = null; }

let OdfiApiConnectorEngine = null;
try { ({ OdfiApiConnectorEngine } = require('../ach/odfiApiConnectorEngine')); } catch (e) { OdfiApiConnectorEngine = null; }

let TreasuryOdfiBank = null;
try { ({ TreasuryOdfiBank } = require('../ach/treasuryOdfiBank')); } catch (e) { TreasuryOdfiBank = null; }

let BankingAggregator = null;
try { ({ BankingAggregator } = require('../aggregator/bankingAggregator')); } catch (e) { BankingAggregator = null; }

let aggregatorScheduler = null;
try { aggregatorScheduler = require('../aggregator/aggregatorScheduler'); } catch (e) { aggregatorScheduler = null; }

let CanonicalFundingSource = null;
try { ({ CanonicalFundingSource } = require('../fineract/canonicalFundingSource')); } catch (e) { CanonicalFundingSource = null; }

let ReserveEngine = null;
try { ({ ReserveEngine } = require('../finops/reserveEngine')); } catch (e) { ReserveEngine = null; }

let CollateralOsEngine = null;
try { ({ CollateralOsEngine } = require('../os/collateralOsEngine')); } catch (e) { CollateralOsEngine = null; }

let FraudComplianceOsEngine = null;
try { ({ FraudComplianceOsEngine } = require('../os/fraudComplianceOsEngine')); } catch (e) { FraudComplianceOsEngine = null; }

const STAGES = ['bankFeed', 'issuance', 'fineract', 'proof', 'reserve', 'collateral', 'distribution', 'compliance', 'funding', 'settlement', 'ledger'];
const GATING = ['bankFeed', 'fineract', 'reserve', 'distribution', 'compliance', 'settlement'];

let lastRun = null;
let running = false;

async function attempt(fn, unavailable) {
  if (!fn) return { available: false, error: unavailable };
  try { return { available: true, ...(await fn()) }; } catch (e) { return { available: true, error: e.message }; }
}

class TrustAdministrationWorkflowEngine {
  static stages() { return STAGES.slice(); }

  static async bankFeed() {
    return attempt(BankingAggregator && (async () => {
      const feeds = await BankingAggregator.feedStatus();
      const issues = [];
      if (!feeds.length) issues.push('no active inbound bank feed');
      for (const f of feeds) {
        if (f.status === 'failing') issues.push(`${f.name}: ${f.error}`);
        else if (f.status === 'never_pulled') issues.push(`${f.name}: never pulled`);
      }
      return { ready: issues.length === 0, status: { issues }, feeds };
    }), 'BankingAggregator unavailable');
  }

  static async ledger({ limit = 10 } = {}) {
    return attempt(DepositAndSettlementEngine && (async () => {
      const deposits = await DepositAndSettlementEngine.list({ direction: 'deposit', limit });
      return { ready: true, deposits };
    }), 'DepositAndSettlementEngine unavailable');
  }

  static async fineract({ includeFineract = false } = {}) {
    return attempt(CanonicalFundingSource && (async () => {
      const status = CanonicalFundingSource.readiness();
      const dataFlow = includeFineract && DataBridge ? await DataBridge.getDataFlowStatus().catch((e) => ({ error: e.message })) : undefined;
      return { ready: Boolean(status.ready), status, ...(dataFlow ? { dataFlow } : {}) };
    }), 'CanonicalFundingSource unavailable');
  }

  static async issuance() {
    return attempt(BondIssuanceEngine && (async () => {
      const status = await BondIssuanceEngine.status();
      return { ready: Boolean(status.ready), status };
    }), 'BondIssuanceEngine unavailable');
  }

  static async reserve() {
    return attempt(ReserveEngine && (async () => {
      const status = await ReserveEngine.status();
      const issues = [];
      if (status.enforcement !== 'strict') issues.push(`RESERVE_ENFORCEMENT=${status.enforcement}: outbound value is not gated on external reserve`);
      if (status.coverage && status.coverage.error) issues.push(`coverage: ${status.coverage.error}`);
      return { ready: issues.length === 0, status: { ...status, issues } };
    }), 'ReserveEngine unavailable');
  }

  static async collateral() {
    return attempt(CollateralOsEngine && (async () => {
      const status = await CollateralOsEngine.readiness();
      return { ready: Boolean(status.ready), status };
    }), 'CollateralOsEngine unavailable');
  }

  static async compliance() {
    return attempt(FraudComplianceOsEngine && (async () => {
      const r = await FraudComplianceOsEngine.readiness();
      return { ready: Boolean(r.ready), mode: r.mode, status: { issues: r.blockers || [] } };
    }), 'FraudComplianceOsEngine unavailable');
  }

  static async distribution() {
    return attempt(FixedIncomeDistributionEngine && (async () => {
      const [readiness, summary] = await Promise.all([
        FixedIncomeDistributionEngine.readiness(),
        FixedIncomeDistributionEngine.summary().catch(() => []),
      ]);
      return { ready: Boolean(readiness.ready), rail: readiness.rail, fundingSource: (readiness.treasury && readiness.treasury.fundingSource) || null, readiness, summary };
    }), 'FixedIncomeDistributionEngine unavailable');
  }

  static async settlement({ limit = 10 } = {}) {
    return attempt(BankSettlementEngine && SettlementBankRegistry && (async () => {
      const banks = [];
      for (const bank of await SettlementBankRegistry.list()) {
        if (bank.enabled === false) continue;
        const r = await BankSettlementEngine.readiness(bank.bankId).catch((e) => ({ bankId: bank.bankId, ready: false, blockers: [e.message] }));
        banks.push({ bankId: r.bankId, provider: r.provider, mode: r.mode, ready: r.ready, blockers: r.blockers || [], bank: r.bank || SettlementBankRegistry.publicView(bank) });
      }
      const recent = await BankSettlementEngine.list({ limit }).catch(() => []);
      const odfi = OdfiApiConnectorEngine ? OdfiApiConnectorEngine.readiness() : null;
      return { ready: banks.length > 0 && banks.every((b) => b.ready), banks, recent, odfiApi: odfi && { ready: odfi.ready, provider: odfi.provider || null, issues: odfi.issues } };
    }), 'BankSettlementEngine unavailable');
  }

  /** Funding = the trust's own bank acting as ODFI for the files dlb-treasury originates. */
  static async funding() {
    return attempt(TreasuryOdfiBank && (async () => {
      const odfi = TreasuryOdfiBank.status();
      const issues = odfi.enabled ? odfi.issues : [];
      return { ready: odfi.enabled ? Boolean(odfi.ready) : null, enabled: odfi.enabled, status: { ...odfi, issues }, odfi };
    }), 'TreasuryOdfiBank unavailable');
  }

  static async proof() {
    return attempt(ProofOfAssetOsEngine && (async () => {
      const status = await ProofOfAssetOsEngine.status();
      return { ready: Boolean(status.ready), status };
    }), 'ProofOfAssetOsEngine unavailable');
  }

  static async status({ includeFineract = false, limit = 10 } = {}) {
    const results = await Promise.all([
      this.bankFeed(),
      this.issuance(),
      this.fineract({ includeFineract }),
      this.proof(),
      this.reserve(),
      this.collateral(),
      this.distribution(),
      this.compliance(),
      this.funding(),
      this.settlement({ limit }),
      this.ledger({ limit }),
    ]);
    const stages = Object.fromEntries(STAGES.map((name, i) => [name, results[i]]));
    const gaps = [];
    for (const name of STAGES) {
      const s = stages[name];
      if (!s.available || s.error) gaps.push(`${name}: ${s.error}`);
      else if (s.ready === false) {
        const detail = name === 'distribution' ? (s.readiness.issues || []).join('; ')
          : name === 'settlement' ? s.banks.flatMap((b) => b.blockers.map((x) => `${b.bankId}: ${x}`)).join('; ')
            : ((s.status && s.status.issues) || []).join('; ');
        gaps.push(`${name}: ${detail || 'not ready'}`);
      }
    }
    const blocking = gaps.filter((g) => GATING.includes(g.slice(0, g.indexOf(':'))));
    return {
      pipeline: 'bank feeds (Finlynq) -> DataBridge -> trust GL -> Fineract (treasury ERP, ledger of record) -> bond issuance + proof of asset -> Reserve OS attestation -> fixed-income distribution planned from posted 1020/1030 -> staged against the Fineract canonical GL + Reserve OS -> Fraud & Compliance screeningRef -> maker/checker approvalRef -> Lili NACHA credit originated by dlb-treasury (OpenACH) -> ODFI via MFT Gateway/SFTP -> bank acknowledgement/return evidence',
      ready: blocking.length === 0 && GATING.every((name) => stages[name].ready === true),
      gating: GATING.slice(),
      blocking,
      gaps,
      stages,
      lastRun,
      asOf: new Date().toISOString(),
    };
  }

  /**
   * One ordered administration cycle: refresh bank feeds into the GL and
   * Fineract, re-attest reserves, re-prove assets, then plan (and, when
   * FIXED_INCOME_AUTO_STAGE=true, stage) fixed-income distributions against
   * the freshly reconciled data. No step originates a payment.
   */
  static async run({ actor = 'trust-admin-workflow' } = {}) {
    if (running) return { skipped: true, reason: 'a trust administration cycle is already running', lastRun };
    running = true;
    const startedAt = new Date().toISOString();
    try {
      const steps = {
        bankFeed: await attempt(aggregatorScheduler && (() => aggregatorScheduler.runOnce()), 'aggregatorScheduler unavailable'),
        reserve: await attempt(ReserveEngine && (() => ReserveEngine.verifyLive()), 'ReserveEngine unavailable'),
        proof: await attempt(ProofOfAssetOsEngine && (async () => {
          const proofs = await ProofOfAssetOsEngine.proveAll({ createdBy: actor });
          return { proofs: proofs.map((p) => ({ scope: p.scope, bondId: p.bondId, verdict: p.verdict })) };
        }), 'ProofOfAssetOsEngine unavailable'),
        distribution: await attempt(FixedIncomeDistributionEngine && (() => FixedIncomeDistributionEngine.runCycle({ actor })), 'FixedIncomeDistributionEngine unavailable'),
      };
      const errors = Object.entries(steps).filter(([, v]) => !v.available || v.error).map(([k, v]) => `${k}: ${v.error}`);
      const status = await this.status();
      lastRun = { startedAt, finishedAt: new Date().toISOString(), actor, errors, ready: status.ready, blocking: status.blocking };
      return { ...lastRun, steps, status };
    } finally {
      running = false;
    }
  }
}

module.exports = { TrustAdministrationWorkflowEngine, WORKFLOW_STAGES: STAGES, GATING_STAGES: GATING };
