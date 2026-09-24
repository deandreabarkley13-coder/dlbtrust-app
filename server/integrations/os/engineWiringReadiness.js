'use strict';

/**
 * GCP wiring readiness for the five platform engines running in the
 * `dlb-treasury-management` project (infra/gcp):
 *
 *   payment          Payment Initiation      OS PaymentEngine + Payment Hub EE
 *   gateway          Integration & Gateway   ApiGatewayClearingEngine + Apigee / APISIX
 *   clearing         Bank Clearing & Settlement  OS ClearingEngine + SettlementEngine
 *   reconciliation   Reconciliation & Matching   ACH recon, DataBridge, BookkeepingAgent, gateway reconcile
 *   interop          Interoperability OS     CrossChainConversionEngine + M2M OS
 *   credit           Credit OS               CreditOsEngine: funding sources, GL validation, credit pipeline
 *   debt             Debt OS                 DebtOsEngine: private-placement bond obligations, holder compliance, schedule
 *   liquidity        Liquidity OS            LiquidityOsEngine: cash coverage of debt service, reserve tier
 *   funding-os       Funding OS              FundingOsEngine: real-value sources, funding requests → ledger
 *   payment-processor Payment Processor OS   PaymentProcessorOsEngine: gated processor/gateway/hub submissions
 *
 * Every report carries the same `gcp` block (project, Cloud Run, Cloud SQL
 * connectivity, evidence bucket) plus the engine's own provider / live flags
 * and the Cloud SQL tables it writes, so `GET /api/os/readiness` answers
 * "is this engine wired to the GCP project, and what exactly blocks live?".
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const EXPECTED_PROJECT = 'dlb-treasury-management';

const ENGINE_KEYS = ['payment', 'gateway', 'clearing', 'reconciliation', 'interop', 'credit', 'debt', 'liquidity', 'funding-os', 'payment-processor', 'payment-gateway'];

const ENGINE_TITLES = {
  payment: 'Payment Initiation Engine',
  gateway: 'Integration & Gateway Engine',
  clearing: 'Bank Clearing & Settlement Engine',
  reconciliation: 'Reconciliation & Matching Engine',
  interop: 'Interoperability OS Engine',
  credit: 'Credit OS Engine',
  debt: 'Debt OS Engine',
  liquidity: 'Liquidity OS Engine',
  'funding-os': 'Funding OS Engine',
  'payment-processor': 'Payment Processor OS Engine',
  'payment-gateway': 'Payment Gateway OS Engine (distributions & disbursements)',
};

const TABLES = {
  payment: ['os_events', 'payment_methods', 'payment_gateway_transactions', 'payment_processor_transactions', 'payment_intents', 'payment_approvals', 'payment_events'],
  gateway: ['gateway_clearing_events', 'os_events'],
  clearing: ['clearing_settlements', 'settlements', 'stablecoin_clearing_orders', 'os_events'],
  reconciliation: ['ach_reconciliations', 'ach_batches', 'gateway_clearing_events', 'bookkeeping_reconciliations', 'data_bridge_discrepancies'],
  interop: ['cross_chain_requests', 'm2m_identities', 'm2m_partners', 'm2m_events'],
  credit: ['lili_direct_deposits', 'lili_payments', 'ach_batches', 'trust_accounts', 'trust_journal_entries', 'data_bridge_discrepancies', 'os_events'],
  debt: ['bonds', 'bond_balances', 'bond_transactions', 'coupon_payments', 'crm_bond_subscriptions', 'crm_contacts'],
  liquidity: ['cash_accounts', 'cash_movements', 'bonds', 'bond_balances', 'coupon_payments'],
  'funding-os': ['funding_requests', 'cash_accounts', 'cash_movements'],
  'payment-processor': ['payment_processor_transactions', 'payment_gateway_transactions', 'payment_intents', 'payment_approvals', 'payment_processor_submissions', 'os_events'],
  'payment-gateway': ['payment_gateway_intents', 'payment_gateway_transactions', 'payment_methods', 'dapp_distribution_requests', 'os_events'],
};

function tryRequire(mod) {
  try { return require(mod); } catch (e) { return null; }
}

function isTrue(v) { return String(v || '').toLowerCase() === 'true'; }

async function settle(fn) {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: e.message }; }
}

function gcpContext() {
  const env = process.env;
  const project = (env.GCP_PROJECT || env.GOOGLE_CLOUD_PROJECT || '').trim();
  return {
    expectedProject: EXPECTED_PROJECT,
    project: project || null,
    projectMatches: project === EXPECTED_PROJECT,
    cloudRun: Boolean(env.K_SERVICE),
    service: env.K_SERVICE || null,
    revision: env.K_REVISION || null,
    databaseUrlConfigured: Boolean(env.DATABASE_URL),
    evidenceBucket: (env.GCS_CLEARING_EVIDENCE_BUCKET || '').trim() || null,
  };
}

async function ledgerStatus() {
  if (!pool) return { connected: false, error: 'Postgres pool unavailable' };
  try {
    const res = await pool.query('SELECT current_database() AS db, version() AS version');
    const row = res.rows[0] || {};
    return { connected: true, database: row.db || null, backend: 'Cloud SQL for PostgreSQL (infra/gcp/cloudsql.tf) / DATABASE_URL' };
  } catch (e) {
    return { connected: false, error: e.message };
  }
}

async function tablesPresent(names) {
  const out = {};
  for (const n of names) out[n] = false;
  if (!pool) return out;
  try {
    const res = await pool.query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1::text[])',
      [names]
    );
    for (const r of res.rows) out[r.table_name] = true;
  } catch (e) { /* unreachable ledger already reported by ledgerStatus */ }
  return out;
}

function missingTables(present) {
  return Object.entries(present).filter(([, ok]) => !ok).map(([name]) => name);
}

function osEngines() { return tryRequire('./osEngine'); }

// ─── Per-engine reports ───────────────────────────────────────────────────────

async function paymentReadiness(ctx) {
  const os = osEngines();
  const hubConfig = tryRequire('../paymentHub/paymentHubConfig');
  const status = os ? await settle(() => os.PaymentEngine.status()) : { ok: false, error: 'OS engines unavailable' };
  const hub = hubConfig ? await settle(() => hubConfig.readiness()) : { ok: false, error: 'paymentHubConfig unavailable' };
  const tables = await tablesPresent(TABLES.payment);
  const blockers = [];
  if (!status.ok) blockers.push(`payment engine: ${status.error}`);
  else if (!status.value.integrations.gateway || !status.value.integrations.processor) blockers.push('payment gateway/processor server engines not loadable');
  if (!hub.ok) blockers.push(`payment hub: ${hub.error}`);
  else if (!hub.value.ready) blockers.push(...hub.value.issues.map(i => `payment hub: ${i}`));
  if (!ctx.ledger.connected) blockers.push('ledger database (Cloud SQL / DATABASE_URL) not connected');
  const hubCfg = hub.ok ? hub.value.config : {};
  return {
    provider: hubCfg.mode === 'phee' ? 'payment-hub-ee' : hubCfg.mode || null,
    mode: hub.ok && hub.value.canTransmit ? 'live' : 'shadow',
    liveFlags: { PAYMENT_HUB_LIVE: isTrue(process.env.PAYMENT_HUB_LIVE), PAYMENT_HUB_MODE: process.env.PAYMENT_HUB_MODE || null },
    modules: {
      osPaymentEngine: status.ok ? status.value : { error: status.error },
      paymentHub: hub.ok ? { ready: hub.value.ready, canTransmit: hub.value.canTransmit, issues: hub.value.issues, warnings: hub.value.warnings, config: hubCfg } : { error: hub.error },
    },
    routes: ['/api/os/payment/{status,readiness,process}', '/api/payment-hub/*'],
    secrets: ['PAYMENT_HUB_AUTH_TOKEN', 'PAYMENT_HUB_SERVICE_TOKEN', 'PAYMENT_HUB_WEBHOOK_SECRET', 'PAYMENT_DATA_ENCRYPTION_KEY'],
    tables,
    blockers,
  };
}

async function gatewayReadiness(ctx) {
  const mod = tryRequire('../dapp/apiGatewayClearingEngine');
  const os = osEngines();
  const clearing = mod ? await settle(() => mod.ApiGatewayClearingEngine.readiness()) : { ok: false, error: 'ApiGatewayClearingEngine unavailable' };
  const apigee = os ? await settle(() => os.ApigeeGatewayEngine.status()) : { ok: false, error: 'OS engines unavailable' };
  const apisix = os ? await settle(() => os.ApacheApisixEngine.status()) : { ok: false, error: 'OS engines unavailable' };
  const tables = await tablesPresent(TABLES.gateway);
  const blockers = [];
  if (!clearing.ok) blockers.push(`gateway clearing: ${clearing.error}`);
  else blockers.push(...clearing.value.blockers.map(b => `gateway clearing: ${b}`));
  if (!ctx.gcp.evidenceBucket) blockers.push('GCS_CLEARING_EVIDENCE_BUCKET not set (infra/gcp/cloudrun.tf injects it from the clearing_evidence bucket)');
  const provider = clearing.ok ? clearing.value.provider : null;
  return {
    provider,
    mode: clearing.ok ? clearing.value.mode : 'shadow',
    liveFlags: {
      API_GATEWAY_PROVIDER: process.env.API_GATEWAY_PROVIDER || null,
      LILI_CLEARING_LIVE: isTrue(process.env.LILI_CLEARING_LIVE),
      APIGEE_LIVE: isTrue(process.env.APIGEE_LIVE),
      APISIX_LIVE: isTrue(process.env.APISIX_LIVE),
    },
    modules: {
      apiGatewayClearing: clearing.ok ? clearing.value : { error: clearing.error },
      apigee: apigee.ok ? apigee.value : { error: apigee.error },
      apisix: apisix.ok ? apisix.value : { error: apisix.error },
    },
    routes: ['/api/dapp/clearing-pipeline/{readiness,events}', '/api/os/apigee/{status,readiness}', '/api/os/apisix/{status,readiness}'],
    secrets: provider === 'lili'
      ? ['LILI_OAUTH_CLIENT_ID', 'LILI_OAUTH_ACCESS_TOKEN or LILI_OAUTH_REFRESH_TOKEN', 'LILI_BUSINESS_USER_ID']
      : provider === 'apigee'
        ? ['APIGEE_API_KEY or APIGEE_CLIENT_ID/APIGEE_CLIENT_SECRET', 'APIGEE_ODFI_ACCOUNT']
        : ['APISIX_API_KEY', 'APISIX_ODFI_ACCOUNT', 'APISIX_RDFI_ACCOUNT'],
    tables,
    blockers,
  };
}

async function clearingReadiness(ctx) {
  const os = osEngines();
  const clearing = os ? await settle(() => os.ClearingEngine.status()) : { ok: false, error: 'OS engines unavailable' };
  const settlement = os ? await settle(() => os.SettlementEngine.status()) : { ok: false, error: 'OS engines unavailable' };
  const autoFormat = Boolean(tryRequire('../inhouseBank/clearing/clearingAutoFormatEngine'));
  const tables = await tablesPresent(TABLES.clearing);
  const blockers = [];
  if (!clearing.ok) blockers.push(`clearing engine: ${clearing.error}`);
  else if (clearing.value.mode !== 'ready') blockers.push('clearing engine: clearingApi / clearingAndSettlement modules not loadable');
  if (!settlement.ok) blockers.push(`settlement engine: ${settlement.error}`);
  else if (settlement.value.mode !== 'ready') blockers.push('settlement engine: settlement / depositAndSettlement / electronicSettlement modules not loadable');
  if (!autoFormat) blockers.push('clearingAutoFormatEngine (NACHA / ISO 20022 / OFX formatting) not loadable');
  if (!ctx.ledger.connected) blockers.push('ledger database (Cloud SQL / DATABASE_URL) not connected');
  const liliLive = isTrue(process.env.LILI_CLEARING_LIVE);
  return {
    provider: liliLive ? 'lili' : (process.env.CLEARING_API_ENDPOINT ? 'clearing-api' : 'internal-ledger'),
    mode: liliLive || isTrue(process.env.PAYMENT_HUB_LIVE) ? 'live' : 'shadow',
    liveFlags: {
      LILI_CLEARING_LIVE: liliLive,
      PAYMENT_HUB_LIVE: isTrue(process.env.PAYMENT_HUB_LIVE),
      CLEARING_API_ENDPOINT: Boolean(process.env.CLEARING_API_ENDPOINT),
      ACH_ODFI_ROUTING: process.env.ACH_ODFI_ROUTING || null,
    },
    modules: {
      osClearingEngine: clearing.ok ? clearing.value : { error: clearing.error },
      osSettlementEngine: settlement.ok ? settlement.value : { error: settlement.error },
      clearingAutoFormat: autoFormat,
    },
    routes: ['/api/os/clearing/{status,readiness,process}', '/api/os/settlement/{status,readiness,process}', '/api/dapp/ptc/clearing/*', '/api/dapp/settlements'],
    secrets: ['CLEARING_API_KEY (only when CLEARING_API_ENDPOINT is set)', 'APISIX_ODFI_ACCOUNT', 'APISIX_RDFI_ACCOUNT'],
    tables,
    blockers,
  };
}

async function reconciliationReadiness(ctx) {
  const ach = tryRequire('../ach/achReconciliation');
  const bridge = tryRequire('../accounting/dataBridge');
  const bookkeeping = tryRequire('../agents/bookkeepingAgent');
  const gateway = tryRequire('../dapp/apiGatewayClearingEngine');
  const tables = await tablesPresent(TABLES.reconciliation);
  const blockers = [];
  if (!ach) blockers.push('ACHReconciliation not loadable');
  if (!bridge) blockers.push('DataBridge not loadable');
  if (!bookkeeping) blockers.push('BookkeepingAgent not loadable');
  if (!gateway) blockers.push('ApiGatewayClearingEngine.reconcile not loadable');
  if (!ctx.ledger.connected) blockers.push('ledger database (Cloud SQL / DATABASE_URL) not connected');
  else {
    const missing = missingTables(tables);
    if (missing.length) blockers.push(`Cloud SQL tables missing: ${missing.join(', ')}`);
  }
  return {
    provider: 'internal-ledger',
    mode: ctx.ledger.connected ? 'live' : 'shadow',
    liveFlags: { FINERACT_URL: Boolean(process.env.FINERACT_URL) },
    modules: {
      achReconciliation: Boolean(ach),
      dataBridge: Boolean(bridge),
      bookkeepingAgent: Boolean(bookkeeping),
      gatewayReconcile: Boolean(gateway),
    },
    jobs: {
      'ACHReconciliation.runReconciliation': 'POST /api/ach-pipeline/reconciliation/run | POST /api/os/reconciliation/process {"action":"runAch"}',
      'DataBridge.getReconciliationReport': 'GET /api/accounting/bridge/report | POST /api/os/reconciliation/process {"action":"report"}',
      'ApiGatewayClearingEngine.reconcile': 'POST /api/dapp/clearing-pipeline/events/:id/reconcile | POST /api/os/reconciliation/process {"action":"gateway"}',
      'BookkeepingAgent.reconcileACH/Wires': 'POST /api/agents/bookkeeping/reconcile-{ach,wires}',
    },
    routes: ['/api/os/reconciliation/{status,readiness,process}', '/api/ach-pipeline/reconciliation/*', '/api/accounting/bridge/reconcile/*', '/api/agents/bookkeeping/*'],
    secrets: [],
    tables,
    blockers,
  };
}

async function interopReadiness(ctx) {
  const cross = tryRequire('../dapp/crossChainConversionEngine');
  const m2m = tryRequire('./m2mOsEngine');
  const tables = await tablesPresent(TABLES.interop);
  const blockers = [];
  let crossCfg = null;
  if (!cross) blockers.push('CrossChainConversionEngine not loadable');
  else {
    try { crossCfg = cross.CrossChainConversionEngine.getConfig(); } catch (e) { blockers.push(`cross-chain config: ${e.message}`); }
  }
  if (crossCfg && !crossCfg.enabled) blockers.push('CROSS_CHAIN_ENABLED=false');
  if (crossCfg && !crossCfg.usdcAddress) blockers.push('DAPP_USDC_ADDRESS not set (canonical stablecoin target)');
  if (!process.env.DAPP_RPC_URL) blockers.push('DAPP_RPC_URL not set (source-chain RPC)');
  if (!m2m) blockers.push('M2mOsEngine not loadable');
  if (!process.env.PAYMENT_DATA_ENCRYPTION_KEY) blockers.push('PAYMENT_DATA_ENCRYPTION_KEY not set (M2M identity keys are stored encrypted)');
  if (!ctx.ledger.connected) blockers.push('ledger database (Cloud SQL / DATABASE_URL) not connected');
  const m2mCfg = m2m ? m2m.getM2mConfig() : null;
  return {
    provider: crossCfg ? crossCfg.defaultBridge : null,
    mode: crossCfg && !crossCfg.shadow ? 'live' : 'shadow',
    liveFlags: {
      CROSS_CHAIN_ENABLED: crossCfg ? crossCfg.enabled : null,
      CROSS_CHAIN_SHADOW: crossCfg ? crossCfg.shadow : null,
      CROSS_CHAIN_SOURCE_CHAIN: crossCfg ? crossCfg.sourceChain : null,
      CROSS_CHAIN_BRIDGE: crossCfg ? crossCfg.defaultBridge : null,
      DAPP_RPC_URL: Boolean(process.env.DAPP_RPC_URL),
      M2M_CYCLE_INTERVAL_MS: m2mCfg ? m2mCfg.cycleIntervalMs : null,
    },
    modules: {
      crossChainConversion: crossCfg ? { chains: cross.CrossChainConversionEngine.listChains().length, sourceChain: crossCfg.sourceChain, bridge: crossCfg.defaultBridge } : { error: 'unavailable' },
      m2mOs: m2mCfg ? { keyBits: m2mCfg.keyBits, cycleIntervalMs: m2mCfg.cycleIntervalMs } : { error: 'unavailable' },
    },
    routes: ['/api/os/interop/{status,readiness,process}', '/api/finops/cross-chain/*', '/api/m2m-os/*'],
    secrets: ['DAPP_RPC_URL', 'DAPP_PRIVATE_KEY or THIRDWEB_SECRET_KEY (signer)', 'PAYMENT_DATA_ENCRYPTION_KEY'],
    tables,
    blockers,
  };
}

const REPORTERS = {
  payment: paymentReadiness,
  gateway: gatewayReadiness,
  clearing: clearingReadiness,
  reconciliation: reconciliationReadiness,
  interop: interopReadiness,
  credit: creditReadiness,
  debt: debtReadiness,
  liquidity: liquidityReadiness,
  'funding-os': fundingOsReadiness,
  'payment-processor': paymentProcessorReadiness,
  'payment-gateway': paymentGatewayReadiness,
};

async function creditReadiness(ctx) {
  const mod = tryRequire('./creditOsEngine');
  const Credit = mod ? mod.CreditOsEngine : null;
  const funding = Credit ? await settle(() => Credit.fundingSources()) : { ok: false, error: 'CreditOsEngine unavailable' };
  const ledger = Credit ? await settle(() => Credit.ledgerValidation()) : { ok: false, error: 'CreditOsEngine unavailable' };
  const pipeline = Credit ? await settle(() => Credit.creditPipeline()) : { ok: false, error: 'CreditOsEngine unavailable' };
  const tables = await tablesPresent(TABLES.credit);
  const blockers = [];
  if (!ctx.ledger.connected) blockers.push('ledger database (Cloud SQL / DATABASE_URL) not connected');
  if (!funding.ok) blockers.push(`credit funding sources: ${funding.error}`);
  else if (!funding.value.anyRealValueCapable) {
    blockers.push(`no funded real-value origination source: ${funding.value.sources.map(s => `${s.id} (${s.reason})`).join('; ')}`);
  }
  if (!ledger.ok) blockers.push(`credit ledger validation: ${ledger.error}`);
  else blockers.push(...ledger.value.issues.map(i => `ledger: ${i}`));
  if (pipeline.ok && pipeline.value.unverifiedTransmitted > 0) {
    blockers.push(`${pipeline.value.unverifiedTransmitted} credit(s) marked transmitted with no bank confirmation (lili_transaction_id null)`);
  }
  const missing = missingTables(tables);
  if (missing.length) blockers.push(`Cloud SQL tables missing: ${missing.join(', ')}`);
  const realValue = funding.ok && funding.value.anyRealValueCapable;
  return {
    provider: realValue ? funding.value.realValueCapable.join('+') : 'validation-only',
    mode: realValue ? 'live' : 'shadow',
    liveFlags: {
      STRIPE_KEY_MODE: funding.ok ? (funding.value.sources.find(s => s.id === 'stripe_treasury') || {}).mode : null,
      SKRILL_CONFIGURED: funding.ok ? Boolean((funding.value.sources.find(s => s.id === 'skrill') || {}).configured) : false,
      BANK_ODFI_EXTERNAL: funding.ok ? Boolean((funding.value.sources.find(s => s.id === 'bank_odfi') || {}).realValueCapable) : false,
      FINERACT_URL: Boolean(process.env.FINERACT_URL),
      PAYMENT_APPROVAL_THRESHOLD: Number(process.env.PAYMENT_APPROVAL_THRESHOLD || 2),
    },
    modules: {
      fundingSources: funding.ok ? funding.value : { error: funding.error },
      ledger: ledger.ok ? ledger.value : { error: ledger.error },
      pipeline: pipeline.ok ? pipeline.value : { error: pipeline.error },
    },
    routes: ['/api/os/credit/{status,readiness,process}', '/api/os/readiness/credit', '/api/finops/lili/direct-deposits/status'],
    secrets: ['STRIPE_SECRET_KEY (live) + STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID, or an external bank ODFI partner (AS2/MFT/SFTP/REST)', 'FINERACT_URL', 'FINERACT_USERNAME', 'FINERACT_PASSWORD', 'FINERACT_TENANT_ID'],
    tables,
    blockers,
  };
}

async function debtReadiness(ctx) {
  const Debt = tryRequire('./debtOsEngine')?.DebtOsEngine;
  const obligations = Debt ? await settle(() => Debt.obligations()) : { ok: false, error: 'DebtOsEngine unavailable' };
  const compliance = Debt ? await settle(() => Debt.placementCompliance()) : { ok: false, error: 'DebtOsEngine unavailable' };
  const schedule = Debt ? await settle(() => Debt.schedule(90)) : { ok: false, error: 'DebtOsEngine unavailable' };
  const tables = await tablesPresent(TABLES.debt);
  const blockers = [];
  if (!ctx.ledger.connected) blockers.push('ledger database (Cloud SQL / DATABASE_URL) not connected');
  if (!obligations.ok) blockers.push(`debt obligations: ${obligations.error}`);
  if (!compliance.ok) blockers.push(`placement compliance: ${compliance.error}`);
  else blockers.push(...compliance.value.issues.map(i => `placement: ${i}`));
  const missing = missingTables(tables);
  if (missing.length) blockers.push(`Cloud SQL tables missing: ${missing.join(', ')}`);
  return {
    provider: 'private-placement (trust + family)',
    mode: compliance.ok && compliance.value.compliant ? 'live' : 'shadow',
    liveFlags: {
      PUBLIC_OFFER: false,
      TRANSFERABLE: false,
      ALLOWED_HOLDER_TYPES: Debt ? Debt.ALLOWED_HOLDER_TYPES : [],
      FINERACT_URL: Boolean(process.env.FINERACT_URL),
    },
    modules: {
      obligations: obligations.ok ? obligations.value.totals : { error: obligations.error },
      compliance: compliance.ok ? compliance.value : { error: compliance.error },
      schedule90d: schedule.ok ? schedule.value.totals : { error: schedule.error },
      holderRegister: Debt && compliance.ok && compliance.value.holders !== undefined ? { holders: compliance.value.holders, byType: compliance.value.holdersByType } : null,
    },
    routes: ['/api/os/debt/{status,readiness,process}', '/api/os/readiness/debt', '/api/bonds/*'],
    secrets: ['none (DATABASE_URL only); FINERACT_* for GL posting of accruals/coupons'],
    tables,
    blockers,
  };
}

async function liquidityReadiness(ctx) {
  const Liq = tryRequire('./liquidityOsEngine')?.LiquidityOsEngine;
  const coverage = Liq ? await settle(() => Liq.coverage()) : { ok: false, error: 'LiquidityOsEngine unavailable' };
  const tables = await tablesPresent(TABLES.liquidity);
  const blockers = [];
  if (!ctx.ledger.connected) blockers.push('ledger database (Cloud SQL / DATABASE_URL) not connected');
  if (!coverage.ok) blockers.push(`liquidity coverage: ${coverage.error}`);
  else blockers.push(...coverage.value.issues.map(i => `liquidity: ${i}`));
  const missing = missingTables(tables);
  if (missing.length) blockers.push(`Cloud SQL tables missing: ${missing.join(', ')}`);
  const c = coverage.ok ? coverage.value : null;
  return {
    provider: 'ledger cash (cash_accounts) vs debt service',
    mode: c && c.adequate ? 'live' : 'shadow',
    liveFlags: {
      COVERED_30D: c ? Boolean(c.horizons['30d'] && c.horizons['30d'].covered) : false,
      COVERED_90D: c ? Boolean(c.horizons['90d'] && c.horizons['90d'].covered) : false,
      RESERVE_COVERAGE: c ? c.reserve.coverage : null,
      PAYOUT_REAL_VALUE_CAPABLE: c ? c.payout.realValueCapable : false,
    },
    modules: {
      cash: c ? c.cash : { error: coverage.error },
      horizons: c ? c.horizons : {},
      reserve: c ? c.reserve : null,
    },
    routes: ['/api/os/liquidity/{status,readiness,process}', '/api/os/readiness/liquidity', '/api/cash/*'],
    secrets: ['none (DATABASE_URL only); real-value payout needs a credit-engine funding source'],
    tables,
    blockers,
  };
}

async function fundingOsReadiness(ctx) {
  const F = tryRequire('./fundingOsEngine')?.FundingOsEngine;
  const sources = F ? await settle(() => F.sources()) : { ok: false, error: 'FundingOsEngine unavailable' };
  const pipeline = F ? await settle(() => F.pipeline()) : { ok: false, error: 'FundingOsEngine unavailable' };
  const path = F ? await settle(() => F.unifiedPath()) : { ok: false, error: 'FundingOsEngine unavailable' };
  const tables = await tablesPresent(TABLES['funding-os']);
  const blockers = [];
  if (!ctx.ledger.connected) blockers.push('ledger database (Cloud SQL / DATABASE_URL) not connected');
  if (!sources.ok) blockers.push(`funding sources: ${sources.error}`);
  else if (!sources.value.anyRealValueCapable) {
    blockers.push(`no funded real-value source: ${sources.value.sources.filter(s => !s.realValueCapable).map(s => `${s.id} (${s.reason})`).join('; ')}`);
  }
  if (!pipeline.ok) blockers.push(`funding pipeline: ${pipeline.error}`);
  const missing = missingTables(tables);
  if (missing.length) blockers.push(`Cloud SQL tables missing: ${missing.join(', ')}`);
  const realValue = sources.ok && sources.value.anyRealValueCapable;
  return {
    provider: realValue ? sources.value.realValueCapable.join('+') : 'funding-requests (manual confirm)',
    mode: realValue ? 'live' : 'shadow',
    liveFlags: {
      REAL_VALUE_SOURCE: realValue,
      LILI_DESTINATION_CONFIGURED: sources.ok ? Boolean(sources.value.destination.configured) : false,
      UNIFIED_PATH_REAL_VALUE: path.ok ? path.value.realValueCapable : false,
      PAYMENT_APPROVAL_THRESHOLD: Number(process.env.PAYMENT_APPROVAL_THRESHOLD || 2),
    },
    modules: {
      sources: sources.ok ? sources.value : { error: sources.error },
      pipeline: pipeline.ok ? pipeline.value : { error: pipeline.error },
      unifiedPath: path.ok ? path.value : { error: path.error },
    },
    routes: ['/api/os/funding-os/{status,readiness,process}', '/api/os/readiness/funding-os'],
    secrets: ['STRIPE_SECRET_KEY (live) + STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID, or an external bank ODFI partner; manual_bank_deposit needs none'],
    tables,
    blockers,
  };
}

async function paymentProcessorReadiness(ctx) {
  const P = tryRequire('./paymentProcessorOsEngine')?.PaymentProcessorOsEngine;
  const inventory = P ? await settle(() => P.processors()) : { ok: false, error: 'PaymentProcessorOsEngine unavailable' };
  const pipeline = P ? await settle(() => P.pipeline()) : { ok: false, error: 'PaymentProcessorOsEngine unavailable' };
  const tables = await tablesPresent(TABLES['payment-processor']);
  const env = process.env;
  const cfg = inventory.ok ? inventory.value.config : (P ? P.getConfig() : {});
  const blockers = [];
  if (!ctx.ledger.connected) blockers.push('ledger database (Cloud SQL / DATABASE_URL) not connected');
  if (!inventory.ok) blockers.push(`payment processor: ${inventory.error}`);
  else {
    const modules = { processor: Boolean(P._processor()), gateway: Boolean(P._gateway()), paymentHub: Boolean(P._hub()), bankSettlement: Boolean(P._settlement()), gatewayClearing: Boolean(P._gatewayClearing()) };
    const notLoadable = Object.entries(modules).filter(([, ok]) => !ok).map(([k]) => k);
    if (notLoadable.length) blockers.push(`payment processor modules not loadable: ${notLoadable.join(', ')}`);
    if (!cfg.live) blockers.push('PAYMENT_PROCESSOR_LIVE is not true (runtime_environment in infra/gcp/variables.tf); submissions are recorded in shadow mode');
    if (!inventory.value.anyRealValueCapable) {
      const reasons = inventory.value.sources.filter((s) => s.liveFlag && !s.realValueCapable).map((s) => `${s.id}: ${s.reason}`);
      blockers.push(`no real-value processor: ${reasons.join('; ')}`);
    }
    if (!cfg.requireApproval) blockers.push('PAYMENT_PROCESSOR_REQUIRE_APPROVAL_REF=false disables the approvalRef gate');
    if (!cfg.requireScreening) blockers.push('PAYMENT_PROCESSOR_REQUIRE_SCREENING_REF=false disables the screeningRef gate');
    if (cfg.stripeKeyMode === 'live' && !cfg.stripePaymentsKeyMode) blockers.push('STRIPE_PAYMENTS_SECRET_KEY not set (restricted payments key; secrets.tf payment_hub_secret_names)');
    if (cfg.stripePaymentsKeyMode === 'test') blockers.push('STRIPE_PAYMENTS_SECRET_KEY is sk_test_ (test mode)');
    if (cfg.liliClearingLive && !env.PAYMENT_SERVER_SERVICE_TOKEN) blockers.push('PAYMENT_SERVER_SERVICE_TOKEN not set (S2S settlement server behind the Lili rail)');
    if (cfg.clearingApiEndpoint && !cfg.clearingApiKey) blockers.push('CLEARING_API_KEY not set while CLEARING_API_ENDPOINT is configured');
  }
  if (!env.PAYMENT_DATA_ENCRYPTION_KEY) blockers.push('PAYMENT_DATA_ENCRYPTION_KEY not set (payment methods are stored encrypted)');
  const missing = missingTables(tables);
  if (missing.length) blockers.push(`Cloud SQL tables missing: ${missing.join(', ')}`);
  const realValue = inventory.ok && inventory.value.anyRealValueCapable;
  return {
    provider: realValue ? inventory.value.realValueCapable.join('+') : 'shadow (no real-value processor)',
    mode: cfg.live && realValue ? 'live' : 'shadow',
    liveFlags: {
      PAYMENT_PROCESSOR_LIVE: Boolean(cfg.live),
      STRIPE_KEY_MODE: cfg.stripeKeyMode || null,
      STRIPE_PAYMENTS_KEY_MODE: cfg.stripePaymentsKeyMode || null,
      PAYMENT_HUB_LIVE: isTrue(env.PAYMENT_HUB_LIVE),
      LILI_CLEARING_LIVE: isTrue(env.LILI_CLEARING_LIVE),
      CLEARING_API_ENDPOINT: cfg.clearingApiEndpoint || null,
      REQUIRE_APPROVAL_REF: cfg.requireApproval !== false,
      REQUIRE_SCREENING_REF: cfg.requireScreening !== false,
      REAL_VALUE_PROCESSORS: inventory.ok ? inventory.value.realValueCapable : [],
    },
    modules: {
      processors: inventory.ok ? inventory.value.sources : { error: inventory.error },
      pipeline: pipeline.ok ? pipeline.value : { error: pipeline.error },
    },
    routes: ['/api/os/payment-processor/{status,readiness,list,process}', '/api/os/readiness/payment-processor', '/api/os/canonical-money/process action=pipeline (payment_processor stage)'],
    secrets: ['PAYMENT_DATA_ENCRYPTION_KEY', 'STRIPE_SECRET_KEY (live) + STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID', 'STRIPE_PAYMENTS_SECRET_KEY', 'PAYMENT_HUB_AUTH_TOKEN', 'PAYMENT_HUB_SERVICE_TOKEN', 'PAYMENT_HUB_WEBHOOK_SECRET', 'PAYMENT_SERVER_SERVICE_TOKEN + Lili OAuth secrets (Lili rail)', 'CLEARING_API_KEY (only when CLEARING_API_ENDPOINT is set)'],
    tables,
    blockers,
  };
}

async function paymentGatewayReadiness(ctx) {
  const G = tryRequire('./paymentGatewayOsEngine')?.PaymentGatewayOsEngine;
  const inventory = G ? await settle(() => G.processors()) : { ok: false, error: 'PaymentGatewayOsEngine unavailable' };
  const pipeline = G ? await settle(() => G.pipeline()) : { ok: false, error: 'PaymentGatewayOsEngine unavailable' };
  const tables = await tablesPresent(TABLES['payment-gateway']);
  const env = process.env;
  const cfg = inventory.ok ? inventory.value.config : (G ? G.getConfig() : {});
  const blockers = [];
  if (!ctx.ledger.connected) blockers.push('ledger database (Cloud SQL / DATABASE_URL) not connected');
  if (!inventory.ok) blockers.push(`payment gateway: ${inventory.error}`);
  else {
    const modules = { gateway: Boolean(G._gateway()), paymentProcessorOs: Boolean(G._processorOs()), distributionRequests: Boolean(G._distributions()) };
    const notLoadable = Object.entries(modules).filter(([, ok]) => !ok).map(([k]) => k);
    if (notLoadable.length) blockers.push(`payment gateway modules not loadable: ${notLoadable.join(', ')}`);
    if (!cfg.live) blockers.push('PAYMENT_GATEWAY_LIVE is not true (runtime_environment in infra/gcp/variables.tf); disbursement intents are recorded in shadow mode');
    if (!cfg.processorLive) blockers.push('PAYMENT_PROCESSOR_LIVE is not true (the gateway dispatches through the payment-processor engine)');
    if (!inventory.value.anyRealValueCapable) {
      const reasons = inventory.value.sources.filter((s) => s.liveFlag && !s.realValueCapable).map((s) => `${s.id}: ${s.reason}`);
      blockers.push(`no real-value gateway processor: ${reasons.join('; ')}`);
    }
    if (!cfg.requireApproval) blockers.push('PAYMENT_GATEWAY_REQUIRE_APPROVAL_REF=false disables the approvalRef gate');
    if (!cfg.requireScreening) blockers.push('PAYMENT_GATEWAY_REQUIRE_SCREENING_REF=false disables the screeningRef gate');
    if (cfg.stripePaymentsKeyMode === 'test') blockers.push('STRIPE_PAYMENTS_SECRET_KEY is sk_test_ (test mode)');
    if (!cfg.webhookSecret) blockers.push('PAYMENT_GATEWAY_WEBHOOK_SECRET not set (processor callbacks to /api/os/payment-gateway/webhook cannot be verified)');
  }
  if (!env.PAYMENT_DATA_ENCRYPTION_KEY) blockers.push('PAYMENT_DATA_ENCRYPTION_KEY not set (beneficiary payout methods are stored encrypted)');
  const missing = missingTables(tables);
  if (missing.length) blockers.push(`Cloud SQL tables missing: ${missing.join(', ')}`);
  const realValue = inventory.ok && inventory.value.anyRealValueCapable;
  return {
    provider: realValue ? inventory.value.realValueCapable.join('+') : 'shadow (no real-value gateway processor)',
    mode: cfg.live && realValue ? 'live' : 'shadow',
    liveFlags: {
      PAYMENT_GATEWAY_LIVE: Boolean(cfg.live),
      PAYMENT_PROCESSOR_LIVE: Boolean(cfg.processorLive),
      STRIPE_PAYMENTS_KEY_MODE: cfg.stripePaymentsKeyMode || null,
      REQUIRE_APPROVAL_REF: cfg.requireApproval !== false,
      REQUIRE_SCREENING_REF: cfg.requireScreening !== false,
      REQUIRE_DISTRIBUTION_REQUEST: Boolean(cfg.requireDistributionRequest),
      MAX_DISBURSEMENT_CENTS: cfg.maxDisbursementCents || null,
      WEBHOOK_SECRET: Boolean(cfg.webhookSecret),
      REAL_VALUE_PROCESSORS: inventory.ok ? inventory.value.realValueCapable : [],
    },
    modules: {
      processors: inventory.ok ? inventory.value.sources : { error: inventory.error },
      pipeline: pipeline.ok ? pipeline.value : { error: pipeline.error },
    },
    routes: ['/api/os/payment-gateway/{status,readiness,list,process}', '/api/os/payment-gateway/webhook', '/api/os/readiness/payment-gateway', '/api/os/canonical-money/process action=pipeline (payment_gateway stage)'],
    secrets: ['PAYMENT_DATA_ENCRYPTION_KEY', 'PAYMENT_GATEWAY_WEBHOOK_SECRET', 'STRIPE_PAYMENTS_SECRET_KEY (live)', 'plus the payment-processor secrets of every real-value processor the gateway disburses over'],
    tables,
    blockers,
  };
}

async function context() {
  const gcp = gcpContext();
  const ledger = await ledgerStatus();
  return { gcp, ledger };
}

function finish(key, ctx, report) {
  const blockers = [...report.blockers];
  if (!ctx.gcp.projectMatches) {
    blockers.push(ctx.gcp.project
      ? `GCP_PROJECT is ${ctx.gcp.project}, expected ${EXPECTED_PROJECT}`
      : 'GCP_PROJECT / GOOGLE_CLOUD_PROJECT not set (infra/gcp/cloudrun.tf injects var.project_id)');
  }
  return {
    engine: key,
    title: ENGINE_TITLES[key],
    ready: blockers.length === 0,
    healthy: !blockers.some(b => /not loadable|unavailable/.test(b)),
    provider: report.provider,
    mode: report.mode,
    liveFlags: report.liveFlags,
    gcp: { ...ctx.gcp, ledger: ctx.ledger },
    modules: report.modules,
    jobs: report.jobs,
    routes: report.routes,
    tables: report.tables,
    secrets: report.secrets,
    blockers,
    generatedAt: new Date().toISOString(),
  };
}

async function engineReadiness(key, ctx) {
  const reporter = REPORTERS[key];
  if (!reporter) throw Object.assign(new Error(`Unknown platform engine: ${key}`), { status: 404 });
  const c = ctx || await context();
  const report = await reporter(c);
  return finish(key, c, report);
}

async function readiness() {
  const ctx = await context();
  const engines = {};
  for (const key of ENGINE_KEYS) {
    try { engines[key] = await engineReadiness(key, ctx); } catch (e) {
      engines[key] = finish(key, ctx, { provider: null, mode: 'shadow', liveFlags: {}, modules: {}, routes: [], tables: {}, secrets: [], blockers: [`${e.message}`] });
    }
  }
  const values = Object.values(engines);
  return {
    project: EXPECTED_PROJECT,
    ready: values.every(e => e.ready),
    readyCount: values.filter(e => e.ready).length,
    total: values.length,
    gcp: { ...ctx.gcp, ledger: ctx.ledger },
    engines,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { EngineWiringReadiness: { readiness, engineReadiness, gcpContext, ledgerStatus, tablesPresent, ENGINE_KEYS, ENGINE_TITLES, TABLES, EXPECTED_PROJECT } };
