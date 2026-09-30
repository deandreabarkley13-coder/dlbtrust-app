import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// dapp/config.js is read once at load: give the interop engine a configured
// source chain before anything requires it.
process.env.DAPP_RPC_URL = process.env.DAPP_RPC_URL || 'http://127.0.0.1:8545';
process.env.DAPP_USDC_ADDRESS = process.env.DAPP_USDC_ADDRESS || '0x2222222222222222222222222222222222222222';

const pool = require('../server/integrations/bonds/pgPool');
const { EngineWiringReadiness } = require('../server/integrations/os/engineWiringReadiness');
const { ApiGatewayClearingEngine } = require('../server/integrations/dapp/apiGatewayClearingEngine');
const paymentHubConfig = require('../server/integrations/paymentHub/paymentHubConfig');
const OS = require('../server/integrations/os/osEngine');
const { CreditOsEngine } = require('../server/integrations/os/creditOsEngine');
const { DebtOsEngine } = require('../server/integrations/os/debtOsEngine');
const { LiquidityOsEngine } = require('../server/integrations/os/liquidityOsEngine');
const { PaymentProcessorOsEngine } = require('../server/integrations/os/paymentProcessorOsEngine');
const { BankingAggregator } = require('../server/integrations/aggregator/bankingAggregator');
const { FineractClient } = require('../server/integrations/fineract/fineractClient');
const { TrustAccountStructure } = require('../server/integrations/fineract/trustAccountStructure');
const { DataBridge } = require('../server/integrations/accounting/dataBridge');
const { StripePaymentIntakeEngine } = require('../server/integrations/payments/stripePaymentIntakeEngine');
const { LiliStripePayoutOriginator } = require('../server/integrations/payments/liliStripePayoutOriginator');
const { TreasuryFundingBankEngine } = require('../server/integrations/payments/treasuryFundingBankEngine');
const openachRailConfig = require('../server/integrations/openach/openachRailConfig');
const { OpenAchRailEngine } = require('../server/integrations/openach/openachRailEngine');
const { OpenAchFileRelay } = require('../server/integrations/openach/openachFileRelay');
const { TreasuryOdfiBank } = require('../server/integrations/ach/treasuryOdfiBank');
const { MftOsEngine } = require('../server/integrations/os/mftOsEngine');
const { FixedIncomeDistributionEngine } = require('../server/integrations/os/fixedIncomeDistributionEngine');
const { CustodyOsEngine } = require('../server/integrations/custody/custodyOsEngine');
const { ProofOfAssetOsEngine } = require('../server/integrations/os/proofOfAssetOsEngine');
const { PayerOsEngine } = require('../server/integrations/os/payerOsEngine');
const { TpsOsEngine } = require('../server/integrations/os/thirdPartySenderOsEngine');
const { M2mOsEngine } = require('../server/integrations/os/m2mOsEngine');
const { ClearingNettingEngine } = require('../server/integrations/os/clearingNettingEngine');
const { WealthBackOfficeEngine } = require('../server/integrations/os/wealthBackOfficeEngine');

const { BackOfficeEngine } = require('../server/integrations/os/osEngine');
const { H2hDiscoveryOsEngine } = require('../server/integrations/os/h2hDiscoveryOsEngine');
const { OpenBankRestApiOsEngine } = require('../server/integrations/os/openBankRestApiOsEngine');
const { EgressOsEngine } = require('../server/integrations/os/egressOsEngine');
const { IdpOcrOsEngine } = require('../server/integrations/os/idpOcrOsEngine');
const { TaxOsEngine } = require('../server/integrations/os/taxOsEngine');
const { PrivateEntityOsEngine } = require('../server/integrations/os/privateEntityOsEngine');
const { PrivateEquityHoldingsOsEngine } = require('../server/integrations/os/privateEquityHoldingsOsEngine');
const { ClearingAgentOsEngine } = require('../server/integrations/os/clearingAgentOsEngine');
const { EnterpriseOdfiOsEngine } = require('../server/integrations/os/enterpriseOdfiOsEngine');
const { TransferApiOsEngine } = require('../server/integrations/os/transferApiOsEngine');
const { FraudComplianceOsEngine } = require('../server/integrations/os/fraudComplianceOsEngine');

const ALL_ENGINES = ['accounting', 'aggregator', 'back-office', 'clearing', 'clearing-netting', 'collateral', 'credit', 'custody', 'debt', 'egress', 'enterprise-network', 'fixed-income', 'funding-os', 'gateway', 'h2h-discovery', 'interop', 'liquidity', 'm2m', 'mft', 'open-bank-rest-api', 'openach', 'payer', 'payment', 'payment-gateway', 'payment-hub', 'payment-processor', 'private-access', 'private-payment-network', 'proof-of-asset', 'reconciliation', 'stripe-intake', 'third-party-sender', 'treasury-funding-bank', 'wealth-back-office', 'idp-ocr', 'tax-os', 'private-entity', 'private-equity-holdings', 'clearing-agent', 'enterprise-odfi', 'transfer-api', 'fraud-compliance'].sort();
const TOTAL = ALL_ENGINES.length;

const GCP_ENV: Record<string, string> = {
  GCP_PROJECT: 'dlb-treasury-management',
  GOOGLE_CLOUD_PROJECT: 'dlb-treasury-management',
  K_SERVICE: 'dlbtrust-app',
  K_REVISION: 'dlbtrust-app-00042-abc',
  DATABASE_URL: 'postgres://app:pw@10.0.0.5:5432/dlbtrust',
  GCS_CLEARING_EVIDENCE_BUCKET: 'dlb-treasury-management-clearing-evidence',
  API_GATEWAY_PROVIDER: 'lili',
  LILI_CLEARING_LIVE: 'true',
  PAYMENT_HUB_MODE: 'phee',
  PAYMENT_HUB_LIVE: 'true',
  PAYMENT_DATA_ENCRYPTION_KEY: 'ab'.repeat(32),
  CROSS_CHAIN_ENABLED: 'true',
  CROSS_CHAIN_SHADOW: 'true',
  PAYMENT_PROCESSOR_LIVE: 'true',
  PAYMENT_GATEWAY_LIVE: 'true',
  PAYMENT_GATEWAY_WEBHOOK_SECRET: 'whsec-test',
  PAYMENT_SERVER_SERVICE_TOKEN: 'svc-token',
  ENTERPRISE_NETWORK_LIVE: 'true',
  ENTERPRISE_NETWORK_WEBHOOK_SECRET: 'whsec-network',
  PRIVATE_PAYMENT_NETWORK_LIVE: 'true',
  PRIVATE_PAYMENT_NETWORK_WEBHOOK_SECRET: 'whsec-ppn',
  AGGREGATOR_ENABLED: 'true',
  AGGREGATOR_DEFAULT_MODE: 'live',
  AGGREGATOR_PULL_INTERVAL_MS: '900000',
  AGGREGATOR_HANDSHAKE_TIMEOUT_MS: '15000',
  ADMIN_SECRET_TOKEN: 'admin-token-test',
  FINERACT_URL: 'https://dlbtrust-fineract.internal/fineract-provider/api/v1',
  FINERACT_USERNAME: 'mifos',
  FINERACT_PASSWORD: 'pw',
  CANONICAL_FUNDING_LIVE: 'true',
  CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID: '2',
  STRIPE_INTAKE_ENABLED: 'true',
  TREASURY_BANK_ENABLED: 'true',
  BETTERMENT_ROUTING_NUMBER: '000000000',
  BETTERMENT_ACCOUNT_NUMBER: '0000',
  OPENACH_RAIL_ENABLED: 'true',
  ACH_ODFI_BANK: 'betterment',
  MFT_SFTP_HOST: 'sftp.odfi.example',
  FIXED_INCOME_RAIL: 'bank',
  PRIVATE_PAYMENT_NETWORK_CORE_BANKING: 'true',
  PRIVATE_PAYMENT_NETWORK_FAMILY_ONLY: 'true',
  PRIVATE_ACCESS_MODE: 'enforce',
  PRIVATE_ACCESS_IAP_AUDIENCE: '/projects/514695212719/locations/us-east1/services/dlbtrust-app',
  PRIVATE_ACCESS_FAMILY_EMAILS: 'deandreabarkley13@gmail.com',
  PRIVATE_ACCESS_IAP_ENABLED: 'true',
  PRIVATE_ACCESS_PUBLIC_INVOKER: 'false',
  PRIVATE_ACCESS_INGRESS: 'INGRESS_TRAFFIC_ALL',
};

const RECEIPTED_BOND = { positionId: 'POS-1', assetClass: 'fixed_income', instrumentRef: 'bond:1', instrumentName: 'DLB Trust Income Bond', quantity: 1, valuationCents: 9852462751, controlStatus: 'receipted', lastReceiptId: 'RCPT-1', verifiedExternally: false };
const CUSTODY_STATEMENT = { accounts: [{ custodyAccountId: 'CUS-ISSUER-FIXED-INCOME', accountName: 'Issuer fixed income', custodyType: 'self', positions: [RECEIPTED_BOND] }, { custodyAccountId: 'CUS-COLLATERAL-PLEDGES', accountName: 'Collateral pledges', custodyType: 'self', positions: [] }] };

function stubTrustEngines() {
  vi.spyOn(DebtOsEngine, 'recurringCouponConfig').mockResolvedValue({ enabled: true, ledgerAccountId: 'CA-BOND-PROCEEDS', settingKey: 'debt_os_coupon_ledger_account', coreBanking: { system: 'fineract', required: true, configured: true, savingsAccountId: '4', destination: 'interest-income', glIncomeCode: '4000', paymentTypeId: 1, blocker: null }, scheduler: 'CouponService.scheduleCouponJob' });
  const acct = (role: string, id: number, externalId: string, glCode: string) => ({ role, externalId, glCode, found: true, active: true, id, accountNo: String(id).padStart(9, '0'), status: 'Active', balance: 0, availableBalance: 0, blocker: null });
  vi.spyOn(TrustAccountStructure, 'inventory').mockResolvedValue({
    holder: { externalId: 'holder:dlb-irrevocable-trust', name: 'DeAndrea Lavar Barkley Irrevocable Trust' },
    accountOfRecord: { ...acct('account-of-record', 2, 'holder:dlb-irrevocable-trust:savings', '1000'), balance: 7709589.04, availableBalance: 7709589.04 },
    principal: acct('principal', 3, 'holder:dlb-irrevocable-trust:principal', '3000'),
    interestIncome: acct('interest-income', 4, 'holder:dlb-irrevocable-trust:interest-income', '4000'),
    trustees: [acct('trustee', 5, 'trustee:CRM-T1:savings', '1030')],
    beneficiaries: [acct('beneficiary', 6, 'beneficiary:CRM-B1:savings', '1020')],
    counts: { expected: 5, found: 5, active: 5, missing: [] }, complete: true, blockers: [], checkedAt: '2026-09-27T00:00:00Z',
  });
  vi.spyOn(FixedIncomeDistributionEngine, 'readiness').mockResolvedValue({ enabled: true, rail: 'bank', ready: true, issues: [], buckets: [{ bucket: 'income_support', glAccountCode: '2000', payees: [{ key: 'beneficiary' }] }] });
  vi.spyOn(CustodyOsEngine, 'status').mockResolvedValue({ requiredSignatures: 2, reserveLinked: true, reserveEngineAvailable: true, pendingReceipts: 0, fixedIncomeFeed: { issuerAccountId: 'CUS-ISSUER-FIXED-INCOME', issuerName: 'Trust', lastSyncedAt: '2026-09-27T00:00:00Z' }, collateralFeed: { accountId: 'CUS-COLLATERAL-PLEDGES', lastSyncedAt: null }, chain: { events: 12, intact: true, breaks: [] }, statement: CUSTODY_STATEMENT });
  vi.spyOn(CustodyOsEngine, 'statement').mockResolvedValue(CUSTODY_STATEMENT);
  vi.spyOn(ProofOfAssetOsEngine, 'status').mockResolvedValue({ enabled: true, ready: true, issues: [], autoCertify: false, certifier: null, scheduler: { running: false, intervalMinutes: 0 }, latest: { proofId: 'POA-1', verdict: 'proven', certifiedBy: 'trustee' }, counts: [{ verdict: 'proven', count: 1 }], layers: [] });
  vi.spyOn(PayerOsEngine, 'readiness').mockResolvedValue({ ready: true, blockers: [], warnings: [], originates: [], fundingSource: { sourceKey: 'trust_operating', accountName: 'Trust Operating Account' }, payees: [{ key: 'b1' }], achChannel: { ready: true }, odfi: { routingNumber: '000000000' } });
  vi.spyOn(TpsOsEngine, 'status').mockResolvedValue({ engine: 'third-party-sender-os', role: {}, enforced: true, readiness: { ready: true, blockers: [] }, agreements: { total: 1, executed: 1 }, originators: { total: 1, approved: 1 }, obligations: { open: 3, overdue: 0 } });
  vi.spyOn(M2mOsEngine, 'status').mockResolvedValue({ engine: 'm2m-os', identities: { total: 1, active: 1, staged: 0, retired: 0 }, partners: [{ partnerId: 'P1', bankName: 'ODFI', status: 'active', lastHandshakeAt: '2026-09-27T00:00:00Z' }], scheduler: { running: true, intervalMs: 3600000 }, policy: {} });
  vi.spyOn(ClearingNettingEngine, 'funding').mockResolvedValue({ blockers: [], source: { sourceType: 'trust_operating', eligible: true } });
  vi.spyOn(ClearingNettingEngine, 'runbook').mockResolvedValue({ actions: [], breaks: [] });
  vi.spyOn(WealthBackOfficeEngine, 'readiness').mockResolvedValue({ ready: true, canPushCredits: true, desks: [{ desk: 'treasury', readable: true }], warnings: [], blockers: [], schema: { ready: true }, payerOs: { ready: true } });
  vi.spyOn(BackOfficeEngine, 'status').mockResolvedValue({ engine: 'back-office', healthy: true, mode: 'shadow', live: false, integrations: { trustAccounting: true, cash: true, bond: true, corporateTreasury: true, bankSync: true, distribution: true }, distributionCount: 0 });
}

function stubFiatComponents() {
  vi.spyOn(FineractClient, 'healthCheck').mockResolvedValue({ connected: true, offices: [{ id: 1 }] });
  vi.spyOn(FineractClient, 'listSavingsAccounts').mockResolvedValue({ pageItems: [{ id: 2, accountNo: '000000002', externalId: 'holder:dlb-irrevocable-trust:savings', clientName: 'DeAndrea Lavar Barkley Irrevocable Trust', savingsProductName: 'Trust Account of Record (USD)', status: { active: true }, summary: { accountBalance: 7709589.04, availableBalance: 7709589.04 } }] });
  vi.spyOn(DataBridge, 'getSyncHistory').mockResolvedValue([{ sync_id: 'SYNC-1', status: 'completed' }]);
  vi.spyOn(StripePaymentIntakeEngine, 'status').mockResolvedValue({ channel: 'stripe_payments', enabled: true, mode: 'live', paymentMethodTypes: ['card', 'us_bank_account'], webhookConfigured: true, account: { id: 'acct_1', chargesEnabled: true }, capabilities: { card: 'active', us_bank_account: 'active' }, ready: true, issues: [] });
  vi.spyOn(LiliStripePayoutOriginator, 'status').mockResolvedValue({ channel: 'stripe_payout', enabled: true, ready: true, keyMode: 'live', account: { id: 'acct_1', payoutsEnabled: true }, externalAccount: { bankName: 'Lili', last4: '1234', status: 'verified' }, balance: { availableCents: 0, pendingCents: 0, livemode: true }, issues: [] });
  vi.spyOn(TreasuryFundingBankEngine, 'status').mockResolvedValue({ provider: 'treasury_funding_bank', channel: 'stripe_ach_debit', ready: true, issues: [], warnings: [], keyMode: 'live', mandateAcceptance: 'online', bank: { bankId: 'betterment', name: 'Betterment Checking', verification: 'verified', accountNumberMasked: '****3054' }, flow: [] });
  vi.spyOn(openachRailConfig, 'openAchRailReadiness').mockReturnValue({ ready: true, blockers: [], rails: ['ach_standard'], baseUrl: 'https://openach.internal' });
  vi.spyOn(OpenAchRailEngine, 'status').mockResolvedValue({ awaitingOrigination: 0, byState: [] });
  vi.spyOn(OpenAchFileRelay, 'status').mockReturnValue({ ready: true, transport: 'mftgateway', partnerAs2Id: 'ODFI', issues: [] });
  vi.spyOn(TreasuryOdfiBank, 'status').mockReturnValue({ role: 'odfi', enabled: true, ready: true, bank: 'betterment', bankName: 'Betterment Checking', accountLast4: '3054', channels: [{ channel: 'mft_as2', ready: true }], issues: [] });
  vi.spyOn(MftOsEngine, 'status').mockResolvedValue({ channels: [{ channelId: 'default', transport: 'sftp', status: 'active', readiness: { ready: true, transport: 'sftp', blockers: [] } }], files: {}, inFlightCents: 0, policy: { requireApproval: true } });
  vi.spyOn(H2hDiscoveryOsEngine, 'readiness').mockResolvedValue({ ready: true, mode: 'live', blockers: [], status: { allowedHosts: ['examplebank.com'], sources: { total: 1 }, candidates: { confirmed: 3, applied: 3 }, appliedBanks: ['examplebank'], fields: [], policy: { requireDistinctApplier: true } } });
  vi.spyOn(EgressOsEngine, 'readiness').mockResolvedValue({ ready: true, mode: 'live', blockers: [], status: { allowedHosts: ['api.ipify.org'], deniedHosts: ['api.stripe.com'], path: { staticIp: '34.1.2.3', vpcConnector: 'dlbtrust-run', nat: 'dlbtrust-egress' }, audit: { hosts: [], deniedButConfigured: [] }, last24h: { allowed: 0, refused: 0 }, lastProbe: { matched: true } } });
  vi.spyOn(IdpOcrOsEngine, 'readiness').mockResolvedValue({ ready: true, mode: 'live', blockers: [], status: { provider: 'document_ai', storage: { ready: true }, policy: { minConfidence: 0.85, requireDistinctApprover: true }, documents: {} } });
  vi.spyOn(TaxOsEngine, 'readiness').mockResolvedValue({ ready: true, mode: 'live', blockers: [], status: { entity: {}, returns: [], beneficiaries: 1, fineractAccounts: {}, exports: [], storage: {}, formats: [], reportTypes: [] } });
  vi.spyOn(PrivateEntityOsEngine, 'readiness').mockResolvedValue({ ready: true, mode: 'live', blockers: [], status: { entity: {}, profile: {}, requiredAttestations: 2, audit: { failing: [] }, tax: {}, legalStatus: 'declared' } });
  vi.spyOn(PrivateEquityHoldingsOsEngine, 'readiness').mockResolvedValue({ ready: true, mode: 'live', blockers: [], warnings: [], status: { custody: {}, policy: {}, summary: { holdings: 1, collateralEligible: 1 }, chain: { intact: true }, collateralOs: { ready: true, issues: [] }, legalStatus: 'declared' } });
  vi.spyOn(ClearingAgentOsEngine, 'readiness').mockResolvedValue({ ready: true, mode: 'live', blockers: [], status: { networks: { total: 1, verified: 1 }, formats: [], instructions: {}, policy: {} } });
  vi.spyOn(EnterpriseOdfiOsEngine, 'readiness').mockResolvedValue({ ready: true, mode: 'live', blockers: [], status: { profile: { countersigned: true }, rails: { external: [{ networkId: 'SPONSOR-ODFI', kind: 'ach_operator' }] }, planner: { provider: 'rules' }, exposure: {}, storage: {}, policy: { isBank: false } } });
  vi.spyOn(OpenBankRestApiOsEngine, 'readiness').mockResolvedValue({ ready: true, mode: 'live', blockers: [], status: { bank: { id: 'dlb-trust-company' }, apiVersion: 'v1', tracker: { base: 'https://raw.githubusercontent.com/x' }, providers: { total: 1 }, fileDrops: { total: 1, verified: 1 }, policy: {} } });
  vi.spyOn(TransferApiOsEngine, 'readiness').mockResolvedValue({ ready: true, mode: 'live', blockers: [], status: { gateway: { host: 'dlbtrust-transfer-gateway-abc.ue.gateway.dev', serviceAccountOnPlatformList: true }, routes: {}, idempotency: {}, requests: { total: 0 }, policy: { movesMoneyDirectly: false } } });
  vi.spyOn(FraudComplianceOsEngine, 'readiness').mockResolvedValue({ ready: true, mode: 'live', blockers: [], status: { sanctions: { provider: 'opensanctions' }, fraud: { provider: 'sardine', configured: true }, workflow: {}, policy: { enforceSettlement: true }, screenings: {} } });
}

const ENV_KEYS = [...Object.keys(GCP_ENV), 'DAPP_RPC_URL', 'DAPP_USDC_ADDRESS'];
const saved: Record<string, string | undefined> = {};

/** Cloud SQL stub: connectivity probe answers, every requested table exists unless listed in `missing`. */
function stubCloudSql(missing: string[] = []) {
  vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any = []) => {
    const text = String(sql);
    if (/current_database\(\)/i.test(text)) return { rows: [{ db: 'dlbtrust', version: 'PostgreSQL 16' }] } as any;
    if (/information_schema\.tables/i.test(text)) {
      const names: string[] = params[0] || [];
      return { rows: names.filter(n => !missing.includes(n)).map(table_name => ({ table_name })) } as any;
    }
    return { rows: [] } as any;
  });
}

function stubProviders() {
  vi.spyOn(ApiGatewayClearingEngine, 'readiness').mockResolvedValue({
    provider: 'lili', mode: 'live', ready: true, blockers: [],
    storage: { ledger: { connected: true }, gcpProject: 'dlb-treasury-management' },
  });
  vi.spyOn(paymentHubConfig, 'readiness').mockReturnValue({
    ready: true, canTransmit: true, issues: [], warnings: [],
    config: { mode: 'phee', live: true, accountingOwner: 'dlbtrust', approvalThreshold: 2, baseUrlConfigured: true },
  });
  vi.spyOn(CreditOsEngine, 'fundingSources').mockResolvedValue({
    sources: [{ id: 'bank_odfi', configured: true, mode: 'live', realValueCapable: true, reason: 'external channel(s): sftp', channels: ['sftp'], loopback: [] }],
    realValueCapable: ['bank_odfi'], anyRealValueCapable: true,
  });
  vi.spyOn(CreditOsEngine, 'ledgerValidation').mockResolvedValue({ valid: true, issues: [], trustGl: { balanced: true }, fineractGl: { connected: true }, openDiscrepancies: 0 });
  vi.spyOn(CreditOsEngine, 'creditPipeline').mockResolvedValue({ deposits: {}, achBatches: {}, unverifiedTransmitted: 0, unverified: [] });
  vi.spyOn(DebtOsEngine, 'obligations').mockResolvedValue({ bonds: [], totals: { activeBonds: 1, principalOutstanding: 100000000, accruedInterest: 0, annualCoupon: 1000000 } });
  vi.spyOn(DebtOsEngine, 'placementCompliance').mockResolvedValue({ compliant: true, placement: 'private', publicOffer: false, holders: 2, externalHolders: 0, unverifiedHolders: 0, issues: [] });
  vi.spyOn(DebtOsEngine, 'schedule').mockResolvedValue({ horizonDays: 90, events: [], totals: { coupon: 250000, principal: 0, total: 250000 } });
  vi.spyOn(LiquidityOsEngine, 'coverage').mockResolvedValue({
    adequate: true, issues: [], cash: { liquid: 2000000, reserve: 1000000 },
    horizons: { '30d': { covered: true }, '90d': { covered: true }, '365d': { covered: true } },
    reserve: { balance: 1000000, annualCoupon: 1000000, coverage: 1, target: 1 }, payout: { realValueCapable: true, sources: ['bank_odfi'] },
  });
  vi.spyOn(PaymentProcessorOsEngine, 'processors').mockImplementation(async () => ({
    config: PaymentProcessorOsEngine.getConfig(),
    sources: [{ id: 'payment_hub', liveFlag: 'PAYMENT_HUB_LIVE', mode: 'live', configured: true, realValueCapable: true, reason: null }],
    realValueCapable: ['payment_hub'], anyRealValueCapable: true,
  }));
  vi.spyOn(BankingAggregator, 'status').mockResolvedValue({
    connectors_available: ['generic_rest', 'internal_rails'],
    connections: 2, connections_active: 2, accounts: 3, transactions: 40, events: 12, default_mode: 'live',
    handshake: { handshake_required: 1, verified: 1, by_state: { pending: 0, challenged: 0, verified: 1, failed: 0 }, by_mode: { live: 2, shadow: 0 }, timeout_ms: 15000 },
  });
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(GCP_ENV)) process.env[k] = v;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe('platform engine registry', () => {
  it('registers every engine behind the fourteen capabilities in the OS route map', () => {
    for (const key of ['payment', 'clearing', 'settlement', 'apigee', 'apisix', 'reconciliation', 'interop', 'credit', 'debt', 'liquidity', 'funding-os', 'payment-processor', 'payment-gateway', 'enterprise-network', 'private-payment-network']) {
      expect(OS.engines[key], key).toBeDefined();
      expect(typeof OS.engines[key].readiness).toBe('function');
    }
    expect(OS.PaymentEngine.platformEngine).toBe('payment');
    expect(OS.ClearingEngine.platformEngine).toBe('clearing');
    expect(OS.SettlementEngine.platformEngine).toBe('clearing');
    expect(OS.ApigeeGatewayEngine.platformEngine).toBe('gateway');
    expect(OS.ApacheApisixEngine.platformEngine).toBe('gateway');
    expect(OS.ReconciliationEngine.platformEngine).toBe('reconciliation');
    expect(OS.InteropEngine.platformEngine).toBe('interop');
    expect(OS.CreditEngine.platformEngine).toBe('credit');
    expect(OS.DebtEngine.platformEngine).toBe('debt');
    expect(OS.LiquidityEngine.platformEngine).toBe('liquidity');
    expect(OS.FundingOsPlatformEngine.platformEngine).toBe('funding-os');
    expect(OS.PaymentProcessorPlatformEngine.platformEngine).toBe('payment-processor');
    expect(OS.PaymentGatewayPlatformEngine.platformEngine).toBe('payment-gateway');
    expect(OS.EnterpriseNetworkPlatformEngine.platformEngine).toBe('enterprise-network');
    expect(OS.PrivatePaymentNetworkPlatformEngine.platformEngine).toBe('private-payment-network');
  });

  it('exposes readiness through the OS router and the finops cross-chain router', () => {
    const osRouter = require('../server/routes/os');
    const finops = require('../server/routes/finops');
    const paths = (r: any) => r.stack.filter((l: any) => l.route).map((l: any) => l.route.path);
    expect(paths(osRouter)).toEqual(expect.arrayContaining(['/readiness', '/readiness/:platformEngine', '/:engine/readiness']));
    expect(paths(finops)).toContain('/cross-chain/readiness');
    // literal readiness route is registered ahead of the /:id catch-all
    const fp = paths(finops);
    expect(fp.indexOf('/cross-chain/readiness')).toBeLessThan(fp.indexOf('/cross-chain/:id'));
  });
});

describe('EngineWiringReadiness on dlb-treasury-management', () => {
  it('reports every registered engine ready and healthy with the GCP config in place', async () => {
    stubCloudSql();
    stubProviders();
    stubFiatComponents();
    stubTrustEngines();
    const report = await EngineWiringReadiness.readiness();

    expect(report.project).toBe('dlb-treasury-management');
    expect(report.gcp.projectMatches).toBe(true);
    expect(report.gcp.cloudRun).toBe(true);
    expect(report.gcp.ledger.connected).toBe(true);
    expect(report.gcp.evidenceBucket).toBe(GCP_ENV.GCS_CLEARING_EVIDENCE_BUCKET);
    expect(Object.keys(report.engines).sort()).toEqual(ALL_ENGINES);
    for (const [key, engine] of Object.entries<any>(report.engines)) {
      expect(engine.blockers, `${key} blockers`).toEqual([]);
      expect(engine.ready, key).toBe(true);
      expect(engine.healthy, key).toBe(true);
      expect(engine.gcp.project).toBe('dlb-treasury-management');
      expect(Object.values(engine.tables).every(Boolean), `${key} tables`).toBe(true);
    }
    expect(report.ready).toBe(true);
    expect(report.readyCount).toBe(TOTAL);
    expect(report.total).toBe(TOTAL);

    expect(report.engines.payment.mode).toBe('live');
    expect(report.engines.payment.provider).toBe('payment-hub-ee');
    expect(report.engines.gateway.provider).toBe('lili');
    expect(report.engines.gateway.mode).toBe('live');
    expect(report.engines.clearing.mode).toBe('live');
    expect(report.engines.reconciliation.mode).toBe('live');
    expect(report.engines.interop.mode).toBe('shadow');
    expect(report.engines.interop.liveFlags.CROSS_CHAIN_SHADOW).toBe(true);
    expect(report.engines.credit.mode).toBe('live');
    expect(report.engines.credit.provider).toBe('bank_odfi');
    expect(report.engines.debt.mode).toBe('live');
    expect(report.engines.debt.liveFlags.PUBLIC_OFFER).toBe(false);
    expect(report.engines.liquidity.mode).toBe('live');
    expect(report.engines.liquidity.liveFlags.RESERVE_COVERAGE).toBe(1);
    expect(report.engines['payment-processor'].mode).toBe('live');
    expect(report.engines['payment-processor'].provider).toBe('payment_hub');
    expect(report.engines['payment-processor'].liveFlags.PAYMENT_PROCESSOR_LIVE).toBe(true);
    expect(report.engines['payment-gateway'].mode).toBe('live');
    expect(report.engines['payment-gateway'].provider).toBe('payment_hub');
    expect(report.engines['payment-gateway'].liveFlags.PAYMENT_GATEWAY_LIVE).toBe(true);
    expect(report.engines['enterprise-network'].mode).toBe('live');
    expect(report.engines['private-payment-network'].mode).toBe('live');
    expect(report.engines.aggregator.mode).toBe('live');
    expect(report.engines.aggregator.modules.connections).toBe(2);
    expect(report.engines.aggregator.modules.verifiedHandshakes).toBe(1);
    expect(report.engines.aggregator.liveFlags.AGGREGATOR_PULL_INTERVAL_MS).toBe(900000);
    expect(report.engines.aggregator.liveFlags.REQUIRE_APPROVAL_REF).toBe(true);
    expect(report.engines.accounting.mode).toBe('live');
    expect(report.engines.accounting.liveFlags.FINERACT_CONNECTED).toBe(true);
    expect(report.engines['stripe-intake'].mode).toBe('live');
    expect(report.engines['treasury-funding-bank'].mode).toBe('live');
    expect(report.engines['treasury-funding-bank'].modules.bank.verification).toBe('verified');
    expect(report.engines['payment-hub'].mode).toBe('live');
    expect(report.engines['payment-hub'].provider).toBe('payment-hub-ee');
    expect(report.engines.openach.mode).toBe('live');
    expect(report.engines.openach.liveFlags.ODFI_FILE_CHANNEL_READY).toBe(true);
    expect(report.engines.mft.mode).toBe('live');
    expect(report.engines['fixed-income'].mode).toBe('live');
    expect(report.engines['fixed-income'].liveFlags.ASSET_SALES).toBe(false);
    expect(report.engines['fixed-income'].modules.couponSettlement.coreBanking).toMatchObject({ savingsAccountId: '4', destination: 'interest-income' });
    expect(report.engines['fixed-income'].modules.fineractAccounts).toMatchObject({ complete: true, trustees: 1, beneficiaries: 1, principal: { id: 3, glCode: '3000' }, interestIncome: { id: 4, glCode: '4000' } });
    expect(report.engines.accounting.modules.trustAccountStructure.complete).toBe(true);
    expect(report.engines.custody.mode).toBe('live');
    expect(report.engines.custody.modules.fixedIncome.receipted).toBe(1);
    expect(report.engines.collateral.mode).toBe('live');
    expect(report.engines.collateral.liveFlags.ON_CHAIN_DRAW_RAIL).toBe('retired');
    expect(report.engines.collateral.modules.base.receiptedCents).toBe(9852462751);
    expect(report.engines['proof-of-asset'].mode).toBe('live');
    expect(report.engines.payer.mode).toBe('live');
    expect(report.engines['third-party-sender'].mode).toBe('live');
    expect(report.engines.m2m.mode).toBe('live');
    expect(report.engines['clearing-netting'].mode).toBe('live');
    expect(report.engines['wealth-back-office'].mode).toBe('live');
    expect(report.engines['back-office'].mode).toBe('live');
    expect(report.engines['back-office'].liveFlags).toMatchObject({ BACK_OFFICE_LIVE: false, DAPP_DISTRIBUTION_EXECUTOR: 'retired', DISTRIBUTION_RAIL: 'private-payment-network', ASSET_SALES: false });
  });

  it('back-office (Backend OS) refuses the retired dapp distribution executor and reports missing dependencies', async () => {
    stubCloudSql();
    stubProviders();
    stubTrustEngines();
    vi.spyOn(BackOfficeEngine, 'status').mockResolvedValue({ engine: 'back-office', healthy: true, mode: 'live', live: true, integrations: { trustAccounting: true, cash: true, bond: true, bankSync: false, distribution: true }, distributionCount: 2 });
    process.env.BACK_OFFICE_LIVE = 'true';
    try {
      const r = await EngineWiringReadiness.engineReadiness('back-office');
      expect(r.mode).toBe('shadow');
      expect(r.blockers).toEqual([
        'back office dependency bankSync not loadable',
        'BACK_OFFICE_LIVE=true: the back-office executeDistribution path settles through the dapp/thirdweb rail (retired); distributions go through the Private Payment Network (Fineract withdraw before dispatch)',
      ]);
      expect(await BackOfficeEngine.readiness()).toMatchObject({ engine: 'back-office', ready: false });
    } finally { delete process.env.BACK_OFFICE_LIVE; }
  });

  it('fixed-income blocks when coupon settlement has no Fineract savings account of record, but keeps downstream distribution issues as warnings', async () => {
    stubCloudSql();
    stubProviders();
    stubTrustEngines();
    vi.spyOn(DebtOsEngine, 'recurringCouponConfig').mockResolvedValue({ enabled: true, ledgerAccountId: 'CA-BOND-PROCEEDS', coreBanking: { system: 'fineract', required: true, configured: true, savingsAccountId: null, paymentTypeId: 1, blocker: 'cash account CA-BOND-PROCEEDS has no linked_fineract_account_id and CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID is unset' } });
    vi.spyOn(FixedIncomeDistributionEngine, 'readiness').mockResolvedValue({ enabled: true, rail: 'bank', ready: false, issues: ['Lili MCP not configured'], buckets: [] });
    const r = await EngineWiringReadiness.engineReadiness('fixed-income');
    expect(r.mode).toBe('shadow');
    expect(r.blockers).toEqual(['coupon -> Fineract core banking: cash account CA-BOND-PROCEEDS has no linked_fineract_account_id and CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID is unset']);
    expect(r.modules.warnings).toEqual(['downstream beneficiary distribution: Lili MCP not configured']);
  });

  it('fixed-income refuses the retired policy-contract rail and an inactive bond book', async () => {
    stubCloudSql();
    stubProviders();
    stubTrustEngines();
    vi.spyOn(DebtOsEngine, 'obligations').mockResolvedValue({ bonds: [], totals: { activeBonds: 0, principalOutstanding: 0, accruedInterest: 0, annualCoupon: 0 } });
    vi.spyOn(FixedIncomeDistributionEngine, 'readiness').mockResolvedValue({ enabled: true, rail: 'policy_contract', ready: true, issues: [], buckets: [] });
    const r = await EngineWiringReadiness.engineReadiness('fixed-income');
    expect(r.mode).toBe('shadow');
    expect(r.blockers).toContain('no active bond: no coupon income stream to fund the trust account of record');
    expect(r.blockers).toContain('FIXED_INCOME_RAIL=policy_contract: distributions must use the fiat bank rail (blockchain/policy-contract rail retired)');
  });

  it('custody and collateral stay shadow until the fixed-income position carries a dual-signed receipt', async () => {
    stubCloudSql();
    stubProviders();
    stubTrustEngines();
    const pending = { accounts: [{ custodyAccountId: 'CUS-ISSUER-FIXED-INCOME', custodyType: 'self', positions: [{ ...RECEIPTED_BOND, controlStatus: 'pending_receipt' }] }] };
    vi.spyOn(CustodyOsEngine, 'status').mockResolvedValue({ requiredSignatures: 2, reserveLinked: true, reserveEngineAvailable: true, pendingReceipts: 1, fixedIncomeFeed: { issuerAccountId: 'CUS-ISSUER-FIXED-INCOME', lastSyncedAt: null }, collateralFeed: {}, chain: { events: 3, intact: true, breaks: [] }, statement: pending });
    vi.spyOn(CustodyOsEngine, 'statement').mockResolvedValue(pending);
    const custody = await EngineWiringReadiness.engineReadiness('custody');
    expect(custody.mode).toBe('shadow');
    expect(custody.blockers).toEqual(['1 safekeeping receipt(s) awaiting the second trustee countersignature (POST /api/finops/custody/receipts/:id/countersign)']);
    const collateral = await EngineWiringReadiness.engineReadiness('collateral');
    expect(collateral.mode).toBe('shadow');
    expect(collateral.blockers).toEqual(['fixed-income custody position not receipted (dual-signed safekeeping receipt required before it counts as collateral)']);
  });

  it('collateral refuses to re-enable on-chain draws and never treats the bond as saleable', async () => {
    stubCloudSql();
    stubProviders();
    stubTrustEngines();
    process.env.COLLATERAL_DRAWS_LIVE = 'true';
    try {
      const r = await EngineWiringReadiness.engineReadiness('collateral');
      expect(r.mode).toBe('shadow');
      expect(r.liveFlags.ASSET_SALES).toBe(false);
      expect(r.blockers).toEqual(['COLLATERAL_DRAWS_LIVE=true: on-chain collateral draws (thirdweb/USDC/Spritz) are retired; the trust is income-support only']);
    } finally { delete process.env.COLLATERAL_DRAWS_LIVE; }
  });

  it('proof-of-asset, payer, third-party-sender, m2m, clearing-netting and wealth-back-office surface their own blockers', async () => {
    stubCloudSql();
    stubProviders();
    stubTrustEngines();
    vi.spyOn(ProofOfAssetOsEngine, 'status').mockResolvedValue({ enabled: true, ready: false, issues: ['no portfolio proof yet (POST /api/proof-of-asset/proofs)'], scheduler: {}, latest: null, counts: [], layers: [] });
    vi.spyOn(PayerOsEngine, 'readiness').mockResolvedValue({ ready: false, blockers: ['ACH credits cannot be originated: no ODFI channel.'], warnings: [], payees: [] });
    vi.spyOn(TpsOsEngine, 'status').mockResolvedValue({ enforced: false, readiness: { ready: false, blockers: ['no executed ODFI origination agreement'] }, agreements: { total: 0, executed: 0 }, originators: { total: 0, approved: 0 }, obligations: { open: 0, overdue: 0 } });
    vi.spyOn(M2mOsEngine, 'status').mockResolvedValue({ identities: { total: 0, active: 0 }, partners: [], scheduler: { running: false, intervalMs: 0 }, policy: {} });
    vi.spyOn(ClearingNettingEngine, 'funding').mockResolvedValue({ blockers: ['The funding registry returned no Trust Operating Account.'], source: null });
    vi.spyOn(WealthBackOfficeEngine, 'readiness').mockResolvedValue({ ready: false, canPushCredits: false, desks: [], warnings: [], blockers: ['Payer OS readiness could not be read: boom'], schema: {}, payerOs: null });
    const report = await EngineWiringReadiness.readiness();
    expect(report.engines['proof-of-asset'].blockers).toContain('no portfolio proof yet (POST /api/proof-of-asset/proofs)');
    expect(report.engines.payer.blockers).toEqual(['ACH credits cannot be originated: no ODFI channel.']);
    expect(report.engines['third-party-sender'].blockers).toEqual(['no executed ODFI origination agreement']);
    expect(report.engines.m2m.blockers).toEqual(['no active machine identity (POST /api/m2m-os/identities)', 'no active bank partner channel: no ODFI/bank has an M2M endpoint registered (Betterment offers none)']);
    expect(report.engines['clearing-netting'].blockers).toEqual(['The funding registry returned no Trust Operating Account.']);
    expect(report.engines['wealth-back-office'].blockers).toEqual(['Payer OS readiness could not be read: boom']);
    for (const k of ['proof-of-asset', 'payer', 'third-party-sender', 'm2m', 'clearing-netting', 'wealth-back-office']) expect(report.engines[k].mode, k).toBe('shadow');
    expect(report.ready).toBe(false);
  });

  it('treasury-funding-bank stays shadow with the Stripe mandate blocker until Betterment is linked and verified', async () => {
    stubCloudSql();
    stubFiatComponents();
    vi.spyOn(TreasuryFundingBankEngine, 'status').mockResolvedValue({ provider: 'treasury_funding_bank', channel: 'stripe_ach_debit', ready: false, issues: ['treasury bank not linked in Stripe (POST /treasury-bank/link)'], warnings: [], keyMode: 'live', mandateAcceptance: 'online', bank: { bankId: 'betterment', verification: 'unlinked' }, flow: [] });
    const r = await EngineWiringReadiness.engineReadiness('treasury-funding-bank');
    expect(r.ready).toBe(false);
    expect(r.mode).toBe('shadow');
    expect(r.liveFlags.TREASURY_BANK_ENABLED).toBe(true);
    expect(r.blockers).toContain('treasury funding bank: treasury bank not linked in Stripe (POST /treasury-bank/link)');
  });

  it('openach and mft fail closed without a bank file-delivery channel instead of claiming live', async () => {
    stubCloudSql();
    stubFiatComponents();
    vi.spyOn(TreasuryOdfiBank, 'status').mockReturnValue({ role: 'odfi', enabled: true, ready: false, bank: 'betterment', bankName: 'Betterment Checking', channels: [], issues: ['no ready file-delivery channel to the ODFI bank (OpenACH/MFT relay, MFTGATEWAY_PARTNER_AS2_ID, ACH_SFTP_URL or ACH_MFT_CHANNEL)'] });
    vi.spyOn(OpenAchFileRelay, 'status').mockReturnValue({ ready: false, transport: 'mftgateway', partnerAs2Id: null, issues: ['MFTGATEWAY_PARTNER_AS2_ID not configured'] });
    vi.spyOn(MftOsEngine, 'status').mockResolvedValue({ channels: [{ channelId: 'default', transport: 'spool', status: 'active', readiness: { ready: false, transport: 'spool', blockers: ['channel has no bank host and spool transmission is not allowed in production'] } }], files: {}, inFlightCents: 0, policy: { requireApproval: true } });
    const o = await EngineWiringReadiness.engineReadiness('openach');
    expect(o.mode).toBe('shadow');
    expect(o.ready).toBe(false);
    expect(o.liveFlags.ODFI_FILE_CHANNEL_READY).toBe(false);
    expect(o.blockers.some((b: string) => /no ready file-delivery channel/.test(b))).toBe(true);
    const m = await EngineWiringReadiness.engineReadiness('mft');
    expect(m.mode).toBe('shadow');
    expect(m.blockers).toContain('channel default (spool): channel has no bank host and spool transmission is not allowed in production');
  });

  it('accounting blocks when Fineract is unreachable', async () => {
    stubCloudSql();
    stubFiatComponents();
    vi.spyOn(FineractClient, 'healthCheck').mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await EngineWiringReadiness.engineReadiness('accounting');
    expect(r.mode).toBe('shadow');
    expect(r.blockers).toContain('fineract: ECONNREFUSED');
  });

  it('aggregator engine blocks on unverified handshakes, missing tables and AGGREGATOR_ENABLED=false', async () => {
    stubCloudSql(['banking_aggregator_events']);
    stubProviders();
    (BankingAggregator.status as any).mockResolvedValue({
      connectors_available: ['generic_rest', 'internal_rails'],
      connections: 3, connections_active: 3, accounts: 0, transactions: 0, events: 0, default_mode: 'shadow',
      handshake: { handshake_required: 2, verified: 0, by_state: { pending: 1, challenged: 0, verified: 0, failed: 1 }, by_mode: { live: 0, shadow: 3 }, timeout_ms: 15000 },
    });
    process.env.AGGREGATOR_ENABLED = 'false';
    process.env.AGGREGATOR_DEFAULT_MODE = 'shadow';
    const agg = await EngineWiringReadiness.engineReadiness('aggregator');
    expect(agg.ready).toBe(false);
    expect(agg.mode).toBe('shadow');
    expect(agg.tables.banking_aggregator_events).toBe(false);
    expect(agg.blockers).toContain('Cloud SQL tables missing: banking_aggregator_events');
    expect(agg.blockers.some((b: string) => b.startsWith('AGGREGATOR_ENABLED=false'))).toBe(true);
    expect(agg.blockers.some((b: string) => /2 connection\(s\) awaiting handshake verification/.test(b))).toBe(true);
  });

  it('payment-processor engine is the tenth blocker until PAYMENT_PROCESSOR_LIVE and a real-value processor exist', async () => {
    stubCloudSql();
    stubProviders();
    stubFiatComponents();
    stubTrustEngines();
    delete process.env.PAYMENT_PROCESSOR_LIVE;
    (PaymentProcessorOsEngine.processors as any).mockImplementation(async () => ({
      config: PaymentProcessorOsEngine.getConfig(),
      sources: [{ id: 'stripe_treasury', liveFlag: 'STRIPE_SECRET_KEY', mode: 'test', realValueCapable: false, reason: 'STRIPE_SECRET_KEY is sk_test_ (test mode)' }],
      realValueCapable: [], anyRealValueCapable: false,
    }));
    const report = await EngineWiringReadiness.readiness();
    expect(report.ready).toBe(false);
    expect(report.readyCount).toBe(TOTAL - 3);
    expect(report.total).toBe(TOTAL);
    expect(report.engines['payment-gateway'].ready).toBe(false);
    expect(report.engines['private-payment-network'].ready).toBe(false);
    expect(report.engines['private-payment-network'].blockers.some((b: string) => b.startsWith('PAYMENT_PROCESSOR_LIVE is not true'))).toBe(true);
    expect(report.engines['payment-gateway'].blockers.some((b: string) => b.startsWith('PAYMENT_PROCESSOR_LIVE is not true'))).toBe(true);
    const pp = report.engines['payment-processor'];
    expect(pp.ready).toBe(false);
    expect(pp.mode).toBe('shadow');
    expect(pp.blockers.some((b: string) => b.startsWith('PAYMENT_PROCESSOR_LIVE is not true'))).toBe(true);
    expect(pp.blockers.some((b: string) => /no real-value processor: stripe_treasury: STRIPE_SECRET_KEY is sk_test_/.test(b))).toBe(true);
  });

  it('debt engine blocks a public placement or a holder outside the trust/family', async () => {
    stubCloudSql();
    stubProviders();
    (DebtOsEngine.placementCompliance as any).mockResolvedValue({
      compliant: false, placement: 'private', publicOffer: false, holders: 3, externalHolders: 1, unverifiedHolders: 1,
      issues: [
        "bond DLB-PRB (#1) placement_type=public; must be 'private' (no public offer)",
        '1 holder(s) outside trust/family (contact_type not in trustee/beneficiary): CT-EXT-1',
        '1 holder(s) without verified KYC: CT-FAM-2',
      ],
    });
    const debt = await EngineWiringReadiness.engineReadiness('debt');
    expect(debt.ready).toBe(false);
    expect(debt.mode).toBe('shadow');
    expect(debt.blockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/placement: bond DLB-PRB .* must be 'private'/),
      expect.stringMatching(/placement: 1 holder\(s\) outside trust\/family/),
      expect.stringMatching(/placement: 1 holder\(s\) without verified KYC/),
    ]));
  });

  it('liquidity engine blocks when debt service is not covered by liquid cash or the reserve tier is thin', async () => {
    stubCloudSql();
    stubProviders();
    (LiquidityOsEngine.coverage as any).mockResolvedValue({
      adequate: false, cash: { liquid: 100000, reserve: 0 },
      horizons: { '30d': { covered: true }, '90d': { covered: false, due: 250000, liquidCash: 100000, shortfall: 150000 }, '365d': { covered: false } },
      reserve: { balance: 0, annualCoupon: 1000000, coverage: 0, target: 1 }, payout: { realValueCapable: false, sources: [] },
      issues: ['90d debt service 250000 exceeds liquid cash 100000 (shortfall 150000)', 'reserve 0 covers 0x of annual coupon 1000000 (target >= 1x)', 'no funded real-value source to pay coupons out (see credit engine)'],
    });
    const liq = await EngineWiringReadiness.engineReadiness('liquidity');
    expect(liq.ready).toBe(false);
    expect(liq.mode).toBe('shadow');
    expect(liq.liveFlags.COVERED_30D).toBe(true);
    expect(liq.liveFlags.COVERED_90D).toBe(false);
    expect(liq.liveFlags.PAYOUT_REAL_VALUE_CAPABLE).toBe(false);
    expect(liq.blockers.some((b: string) => /shortfall 150000/.test(b))).toBe(true);
    expect(liq.blockers.some((b: string) => /reserve 0 covers 0x/.test(b))).toBe(true);
  });

  it('credit engine stays validation-only and blocked when every funding source is test-mode, Skrill or a loopback ODFI', async () => {
    stubCloudSql();
    stubProviders();
    (CreditOsEngine.fundingSources as any).mockResolvedValue({
      sources: [
        { id: 'stripe_treasury', configured: true, mode: 'test', realValueCapable: false, reason: 'test-mode key (sandbox)' },
        { id: 'skrill', configured: true, mode: 'live', realValueCapable: false, reason: 'Skrill-to-Skrill only' },
        { id: 'bank_odfi', configured: true, mode: 'loopback', realValueCapable: false, reason: 'Only self-loopback ODFI partner(s) configured (as2_partner:DLBTRUST-DIRECT)', channels: [], loopback: ['as2_partner:DLBTRUST-DIRECT'] },
      ],
      realValueCapable: [], anyRealValueCapable: false,
    });
    (CreditOsEngine.creditPipeline as any).mockResolvedValue({ deposits: { transmitted: 2 }, achBatches: { accepted: 2 }, unverifiedTransmitted: 2, unverified: [] });
    const credit = await EngineWiringReadiness.engineReadiness('credit');
    expect(credit.ready).toBe(false);
    expect(credit.healthy).toBe(true);
    expect(credit.mode).toBe('shadow');
    expect(credit.provider).toBe('validation-only');
    expect(credit.liveFlags.STRIPE_KEY_MODE).toBe('test');
    expect(credit.liveFlags.BANK_ODFI_EXTERNAL).toBe(false);
    expect(credit.blockers.some((b: string) => /no funded real-value origination source/.test(b) && /DLBTRUST-DIRECT/.test(b))).toBe(true);
    expect(credit.blockers.some((b: string) => /2 credit\(s\) marked transmitted with no bank confirmation/.test(b))).toBe(true);
  });

  it('routes every OS engine readiness() onto its platform report', async () => {
    stubCloudSql();
    stubProviders();
    const pairs: Array<[any, string]> = [
      [OS.PaymentEngine, 'payment'], [OS.ClearingEngine, 'clearing'], [OS.SettlementEngine, 'clearing'],
      [OS.ApigeeGatewayEngine, 'gateway'], [OS.ApacheApisixEngine, 'gateway'],
      [OS.ReconciliationEngine, 'reconciliation'], [OS.InteropEngine, 'interop'],
      [OS.PaymentProcessorPlatformEngine, 'payment-processor'],
    ];
    for (const [Engine, key] of pairs) {
      const r = await Engine.readiness();
      expect(r.engine, Engine.engineName).toBe(key);
      expect(r.ready, Engine.engineName).toBe(true);
    }
  });

  it('names the project mismatch when deployed against the wrong GCP project', async () => {
    stubCloudSql();
    stubProviders();
    process.env.GCP_PROJECT = 'dlb-treasury';
    process.env.GOOGLE_CLOUD_PROJECT = 'dlb-treasury';
    const report = await EngineWiringReadiness.readiness();
    expect(report.ready).toBe(false);
    for (const engine of Object.values<any>(report.engines)) {
      expect(engine.ready).toBe(false);
      expect(engine.blockers).toContain('GCP_PROJECT is dlb-treasury, expected dlb-treasury-management');
    }
  });

  it('flags missing reconciliation tables on Cloud SQL and a missing evidence bucket', async () => {
    stubCloudSql(['ach_reconciliations']);
    stubProviders();
    delete process.env.GCS_CLEARING_EVIDENCE_BUCKET;
    const recon = await EngineWiringReadiness.engineReadiness('reconciliation');
    expect(recon.ready).toBe(false);
    expect(recon.tables.ach_reconciliations).toBe(false);
    expect(recon.blockers).toContain('Cloud SQL tables missing: ach_reconciliations');
    expect(recon.jobs['ACHReconciliation.runReconciliation']).toContain('/api/ach-pipeline/reconciliation/run');
    expect(recon.jobs['DataBridge.getReconciliationReport']).toContain('/api/accounting/bridge/report');
    expect(recon.jobs['ApiGatewayClearingEngine.reconcile']).toContain('/api/dapp/clearing-pipeline/events/:id/reconcile');

    const gateway = await EngineWiringReadiness.engineReadiness('gateway');
    expect(gateway.ready).toBe(false);
    expect(gateway.blockers.some((b: string) => b.startsWith('GCS_CLEARING_EVIDENCE_BUCKET not set'))).toBe(true);
  });

  it('reports the exact secret that keeps an engine from going live', async () => {
    stubCloudSql();
    stubProviders();
    delete process.env.PAYMENT_DATA_ENCRYPTION_KEY;
    (paymentHubConfig.readiness as any).mockReturnValue({
      ready: false, canTransmit: false, issues: ['PAYMENT_HUB_AUTH_TOKEN is required'], warnings: [],
      config: { mode: 'phee', live: true },
    });
    const interop = await EngineWiringReadiness.engineReadiness('interop');
    expect(interop.ready).toBe(false);
    expect(interop.blockers).toContain('PAYMENT_DATA_ENCRYPTION_KEY not set (M2M identity keys are stored encrypted)');

    const payment = await EngineWiringReadiness.engineReadiness('payment');
    expect(payment.ready).toBe(false);
    expect(payment.mode).toBe('shadow');
    expect(payment.blockers).toContain('payment hub: PAYMENT_HUB_AUTH_TOKEN is required');
  });

  it('reports Cloud SQL down as a blocker on every engine', async () => {
    vi.spyOn(pool, 'query').mockRejectedValue(new Error('connect ECONNREFUSED'));
    stubProviders();
    const report = await EngineWiringReadiness.readiness();
    expect(report.gcp.ledger.connected).toBe(false);
    for (const [key, engine] of Object.entries<any>(report.engines)) {
      if (key === 'gateway') continue; // gateway delegates ledger state to ApiGatewayClearingEngine.readiness (stubbed)
      expect(engine.blockers, key).toContain('ledger database (Cloud SQL / DATABASE_URL) not connected');
    }
  });

  it('rejects an unknown platform engine with 404', async () => {
    await expect(EngineWiringReadiness.engineReadiness('nope')).rejects.toMatchObject({ status: 404 });
  });
});
