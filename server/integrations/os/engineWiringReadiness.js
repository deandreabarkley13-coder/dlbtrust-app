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
 *
 * Every report carries the same `gcp` block (project, Cloud Run, Cloud SQL
 * connectivity, evidence bucket) plus the engine's own provider / live flags
 * and the Cloud SQL tables it writes, so `GET /api/os/readiness` answers
 * "is this engine wired to the GCP project, and what exactly blocks live?".
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const EXPECTED_PROJECT = 'dlb-treasury-management';

const ENGINE_KEYS = ['payment', 'gateway', 'clearing', 'reconciliation', 'interop'];

const ENGINE_TITLES = {
  payment: 'Payment Initiation Engine',
  gateway: 'Integration & Gateway Engine',
  clearing: 'Bank Clearing & Settlement Engine',
  reconciliation: 'Reconciliation & Matching Engine',
  interop: 'Interoperability OS Engine',
};

const TABLES = {
  payment: ['os_events', 'payment_methods', 'payment_gateway_transactions', 'payment_processor_transactions', 'payment_intents', 'payment_approvals', 'payment_events'],
  gateway: ['gateway_clearing_events', 'os_events'],
  clearing: ['clearing_settlements', 'settlements', 'stablecoin_clearing_orders', 'os_events'],
  reconciliation: ['ach_reconciliations', 'ach_batches', 'gateway_clearing_events', 'bookkeeping_reconciliations', 'data_bridge_discrepancies'],
  interop: ['cross_chain_requests', 'm2m_identities', 'm2m_partners', 'm2m_events'],
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
};

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
