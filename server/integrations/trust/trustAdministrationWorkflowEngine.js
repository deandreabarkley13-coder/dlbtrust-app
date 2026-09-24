'use strict';

/**
 * Trust Administration Workflow — one status surface for the bank-only
 * administration + distribution pipeline on GCP:
 *
 *   obligor / payer  -> Stripe payment processing (PaymentIntent / Checkout)
 *                    -> signed webhook -> deposit ledger (1100 Cash / PTC-DEPOSIT-CLEARING)
 *                    -> DataBridge -> Fineract GL (ledger of record)
 *   posted 1020/1030 -> FixedIncomeDistributionEngine (FIXED_INCOME_RAIL=bank)
 *                    -> maker/checker (approvalRef + screeningRef)
 *                    -> BankSettlementEngine -> Stripe payout -> Lili direct deposit
 *
 * Every stage is read best-effort so one unavailable engine never hides the
 * others; `ready` is true only when intake, distribution and settlement are.
 */

let StripePaymentIntakeEngine, DepositAndSettlementEngine, BankSettlementEngine, SettlementBankRegistry, FixedIncomeDistributionEngine, DataBridge;
try { ({ StripePaymentIntakeEngine } = require('../payments/stripePaymentIntakeEngine')); } catch (e) { StripePaymentIntakeEngine = null; }
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

const STAGES = ['issuance', 'intake', 'ledger', 'fineract', 'distribution', 'settlement', 'proof'];

async function attempt(fn, unavailable) {
  if (!fn) return { available: false, error: unavailable };
  try { return { available: true, ...(await fn()) }; } catch (e) { return { available: true, error: e.message }; }
}

class TrustAdministrationWorkflowEngine {
  static stages() { return STAGES.slice(); }

  static async intake({ limit = 10 } = {}) {
    return attempt(StripePaymentIntakeEngine && (async () => {
      const [status, recent] = await Promise.all([
        StripePaymentIntakeEngine.status(),
        StripePaymentIntakeEngine.list({ limit }).catch(() => []),
      ]);
      return { ready: Boolean(status.ready), status, recent };
    }), 'StripePaymentIntakeEngine unavailable');
  }

  static async ledger({ limit = 10 } = {}) {
    return attempt(DepositAndSettlementEngine && (async () => {
      const deposits = await DepositAndSettlementEngine.list({ direction: 'deposit', limit });
      return { ready: true, deposits };
    }), 'DepositAndSettlementEngine unavailable');
  }

  static async fineract({ includeFineract = false } = {}) {
    if (!includeFineract) return { available: Boolean(DataBridge), skipped: true, note: 'pass includeFineract=true to read DataBridge status' };
    return attempt(DataBridge && (async () => {
      const status = await DataBridge.getDataFlowStatus();
      return { ready: true, status };
    }), 'DataBridge unavailable');
  }

  static async issuance() {
    return attempt(BondIssuanceEngine && (async () => {
      const status = await BondIssuanceEngine.status();
      return { ready: Boolean(status.ready), status };
    }), 'BondIssuanceEngine unavailable');
  }

  static async distribution() {
    return attempt(FixedIncomeDistributionEngine && (async () => {
      const [readiness, summary] = await Promise.all([
        FixedIncomeDistributionEngine.readiness(),
        FixedIncomeDistributionEngine.summary().catch(() => []),
      ]);
      return { ready: Boolean(readiness.ready), rail: readiness.rail, readiness, summary };
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
      // External real-value rail: the bank-as-API ODFI (informational; the
      // Stripe-payout bank leg above decides readiness until it is configured).
      const odfi = OdfiApiConnectorEngine ? OdfiApiConnectorEngine.readiness() : null;
      return { ready: banks.length > 0 && banks.every((b) => b.ready), banks, recent, odfiApi: odfi && { ready: odfi.ready, provider: odfi.provider || null, issues: odfi.issues } };
    }), 'BankSettlementEngine unavailable');
  }

  static async proof() {
    return attempt(ProofOfAssetOsEngine && (async () => {
      const status = await ProofOfAssetOsEngine.status();
      return { ready: Boolean(status.ready), status };
    }), 'ProofOfAssetOsEngine unavailable');
  }

  static async status({ includeFineract = false, limit = 10 } = {}) {
    const [issuance, intake, ledger, fineract, distribution, settlement, proof] = await Promise.all([
      this.issuance(),
      this.intake({ limit }),
      this.ledger({ limit }),
      this.fineract({ includeFineract }),
      this.distribution(),
      this.settlement({ limit }),
      this.proof(),
    ]);
    const stages = { issuance, intake, ledger, fineract, distribution, settlement, proof };
    const gaps = [];
    for (const name of STAGES) {
      const s = stages[name];
      if (s.skipped) continue;
      if (!s.available) gaps.push(`${name}: ${s.error}`);
      else if (s.error) gaps.push(`${name}: ${s.error}`);
      else if (s.ready === false) {
        const detail = (name === 'intake' || name === 'issuance' || name === 'proof') ? (s.status.issues || []).join('; ')
          : name === 'distribution' ? (s.readiness.issues || []).join('; ')
            : name === 'settlement' ? s.banks.flatMap((b) => b.blockers.map((x) => `${b.bankId}: ${x}`)).join('; ')
              : '';
        gaps.push(`${name}: ${detail || 'not ready'}`);
      }
    }
    return {
      pipeline: 'issuer Fineract account -> holder Fineract account (held, account of record) -> [send-to-bank] fixed-income distribution -> maker/checker -> Stripe payout -> Lili direct deposit; proof of asset over contract + Fineract + GL + fiat + custody',
      ready: gaps.length === 0 && intake.ready === true && distribution.ready === true && settlement.ready === true,
      gaps,
      stages,
      asOf: new Date().toISOString(),
    };
  }
}

module.exports = { TrustAdministrationWorkflowEngine, WORKFLOW_STAGES: STAGES };
