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
 *   payment-gateway  Payment Gateway OS      PaymentGatewayOsEngine: trust distributions / disbursements
 *   enterprise-network Enterprise Network OS EnterpriseNetworkOsEngine: participants, routing policy, exposure limits
 *   private-payment-network Private Payment Network  PrivatePaymentNetworkOsEngine: ledger ↔ payout-instrument clearing
 *   aggregator       Banking Aggregator      BankingAggregator: provider connections (SimpleFIN → Betterment), handshake, pull/push
 *   accounting       Trust Accounting        Fineract GL + DataBridge + TrustAccountingEngine (corpus / coupon / interest / distributions)
 *   stripe-intake    Stripe Intake & Payout  StripePaymentIntakeEngine (intake) + LiliStripePayoutOriginator (payout to Lili)
 *   treasury-funding-bank Betterment Funding TreasuryFundingBankEngine: Stripe ACH-debit mandate on Betterment Trust Checking
 *   payment-hub      Payment Hub EE          paymentHubConfig / PaymentHubEngine (PHEE orchestration)
 *   openach          OpenACH Rail            OpenAchRailEngine + OpenAchFileRelay + TreasuryOdfiBank (ODFI file delivery)
 *   mft              MFT / File Relay        MftOsEngine channels (SFTP / spool) for NACHA / ISO 20022 file drops
 *   h2h-discovery    H2H Discovery OS        Web data scraping of bank H2H/MFT docs for AS2 ID, client ID, base URL, SFTP host (confirm -> apply)
 *   open-bank-rest-api Open Bank REST API    OBP-style REST surface + Open Banking Tracker directory; file-drop registration onto AS2Partners / MFT
 *
 * Every report carries the same `gcp` block (project, Cloud Run, Cloud SQL
 * connectivity, evidence bucket) plus the engine's own provider / live flags
 * and the Cloud SQL tables it writes, so `GET /api/os/readiness` answers
 * "is this engine wired to the GCP project, and what exactly blocks live?".
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const EXPECTED_PROJECT = 'dlb-treasury-management';

const ENGINE_KEYS = ['payment', 'gateway', 'clearing', 'reconciliation', 'interop', 'credit', 'debt', 'liquidity', 'funding-os', 'payment-processor', 'payment-gateway', 'enterprise-network', 'private-payment-network', 'aggregator', 'accounting', 'stripe-intake', 'treasury-funding-bank', 'payment-hub', 'openach', 'mft', 'fixed-income', 'custody', 'collateral', 'proof-of-asset', 'payer', 'third-party-sender', 'm2m', 'clearing-netting', 'wealth-back-office', 'back-office', 'h2h-discovery', 'open-bank-rest-api', 'egress', 'private-access', 'idp-ocr', 'tax-os', 'private-entity', 'clearing-agent', 'enterprise-odfi'];

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
  'enterprise-network': 'Enterprise Network OS Engine (participants, routing, exposure limits)',
  'private-payment-network': 'Private Electronic Payment Network (ledger clearing & settlement)',
  aggregator: 'Banking Aggregator (provider connections, handshake, pull/push)',
  accounting: 'Core Banking & Treasury (Fineract: trust account of record, savings, GL, DataBridge classification)',
  'stripe-intake': 'Stripe Intake & Payout (disbursing balance, Lili payout account)',
  'treasury-funding-bank': 'Betterment Trust Checking Funding Bank (Stripe ACH-debit mandate)',
  'payment-hub': 'Payment Hub EE (PHEE orchestration, ACH connector)',
  openach: 'OpenACH Rail (ODFI origination, NACHA file relay)',
  mft: 'MFT / File Relay (SFTP / spool channels for NACHA, ISO 20022)',
  'fixed-income': 'Bond & Fixed-Income Income Engine (coupon accrual -> Fineract savings account of record -> beneficiary distributions; income support only, no asset sales)',
  custody: 'Custody OS (safekeeping accounts, fixed-income positions, dual-signed receipts, hash-chained title)',
  collateral: 'Collateral OS (custody-receipted fixed-income as borrowing base; on-chain draw rail retired)',
  'proof-of-asset': 'Proof of Asset OS (bond contract / schedule / Fineract account of record / GL / fiat settlement / custody proven and certified)',
  payer: 'Payer OS (trust-originated ACH credits under dual control from the Trust Operating Account)',
  'third-party-sender': 'Third-Party Sender OS (Nacha TPS register: ODFI agreements, originators, compliance calendar)',
  m2m: 'M2M OS (machine identities and bank partner channels for file delivery)',
  'clearing-netting': 'Clearing & Netting OS (daily obligations netted into one funded settlement position)',
  'wealth-back-office': 'Wealth Back Office OS (family bank desks; hands credits to Payer OS)',
  'back-office': 'Backend OS (Back Office engine: treasury summary, bank reconciliation, batches; distribution execution via PPN only — dapp/on-chain executor retired)',
  'h2h-discovery': 'H2H Discovery OS (web data scraping of bank host-to-host onboarding docs: AS2 ID, client ID, base URL, SFTP host, MDN, cert fingerprint; trustee confirm -> second-trustee apply)',
  'open-bank-rest-api': 'Open Bank REST API OS (OBP-style REST surface over Fineract core banking + Open Banking Tracker directory; bank file-drop registration onto AS2Partners / MFT)',
  'private-access': 'Private Access (family-only, non-public: Cloud Run behind IAP, no allUsers invoker, family identity allow-list, Cloud VPN for trusted sites; PPN family-only mode with Stripe/card rails excluded)',
  egress: 'Egress OS (single outbound door: Serverless VPC connector -> Cloud NAT static IP; destination allow/deny-list, retired rails denied, audited + fail-closed authorize, NAT IP probe)',
  'idp-ocr': 'IDP / OCR OS (Document AI intake of distribution, disbursement, request and vendor-payout documents; classification, redaction, confidence gate, trustee review -> distinct approver -> link to maker-checker request; moves no money)',
  'tax-os': 'Tax OS (Form 1041 + Schedule K-1 reports from the trust journal and Fineract principal / interest-income accounts; JSON / CSV / PDF exports; reports only, no e-file)',
  'private-entity': 'Private Entity OS (trustee-declared Ohio ORC 1111-1112 family trust company profile: private, single-family multigenerational, unlicensed, non-depository, income-support only, PPN settlement; two-trustee attestation; platform audit against the declaration)',
  'enterprise-odfi': 'Enterprise ODFI OS (agentic originator operating system for trust administration: maker/checker originator profile, approved+screened distribution / disbursement / vendor-payout / trustee-expense batches, Vertex AI advisory rail planner with deterministic validator, distinct-trustee release through the Clearing Agent to a verified sponsor ODFI network, returns/NOC handling with Fineract re-deposit, exposure reconciliation; the software is not a bank)',
  'clearing-agent': 'Clearing Agent OS (backend-to-backend agent for the private Electronic Payment Networks: Secret-Manager-referenced credentials, HMAC challenge/verify handshake by two trustees, USA-only conversion to NACHA / ISO 20022 pain.001 + pacs.008 / FedNow + RTP / BAI2, HMAC-signed clear over Egress OS, idempotent post to Fineract core banking)',
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
  'enterprise-network': ['enterprise_network_intents', 'enterprise_network_participants', 'enterprise_network_routing_policies', 'enterprise_network_exposure_limits', 'os_events'],
  'private-payment-network': ['private_payment_network_transactions', 'cash_accounts', 'cash_movements', 'payment_methods', 'payment_gateway_transactions', 'enterprise_network_participants', 'enterprise_network_exposure_limits', 'os_events'],
  aggregator: ['banking_aggregator_connections', 'banking_aggregator_accounts', 'banking_aggregator_transactions', 'banking_aggregator_statements', 'banking_aggregator_events', 'trust_journal_entries'],
  accounting: ['trust_accounts', 'trust_journal_entries', 'fineract_gl_mappings', 'data_bridge_sync_log', 'data_bridge_discrepancies', 'fineract_trust_accounts', 'crm_contacts'],
  'stripe-intake': ['stripe_payment_intakes', 'cash_accounts', 'cash_movements', 'lili_direct_deposits'],
  'treasury-funding-bank': ['treasury_funding_bank', 'stripe_payment_intakes', 'cash_accounts'],
  'payment-hub': ['payment_intents', 'payment_approvals', 'payment_events', 'ach_batches'],
  openach: ['ihb_openach_dispatches', 'ihb_openach_status_log', 'openach_file_relays', 'ach_batches'],
  mft: ['mft_channels', 'mft_files', 'mft_events'],
  'fixed-income': ['bonds', 'bond_balances', 'bond_transactions', 'coupon_payments', 'crm_bond_subscriptions', 'cash_accounts', 'cash_movements', 'system_settings', 'fixed_income_distributions'],
  custody: ['custody_accounts', 'custody_positions', 'custody_receipts', 'custody_events'],
  collateral: ['custody_accounts', 'custody_positions', 'custody_receipts', 'bonds', 'bond_balances'],
  'proof-of-asset': ['proof_of_asset_proofs', 'bonds', 'trust_journal_entries'],
  payer: ['payer_disbursements', 'payer_disbursement_events', 'cash_accounts'],
  'third-party-sender': ['tps_odfi_agreements', 'tps_originators', 'tps_obligations', 'tps_exposure', 'tps_returns', 'tps_events'],
  m2m: ['m2m_identities', 'm2m_partners', 'm2m_events'],
  'clearing-netting': ['clearing_cycles', 'clearing_cycle_legs', 'clearing_cycle_items', 'cash_accounts'],
  'wealth-back-office': ['wealth_credit_pushes', 'payer_disbursements'],
  'back-office': ['back_office_batches', 'back_office_tasks', 'os_events', 'cash_accounts', 'trust_journal_entries'],
  'h2h-discovery': ['h2h_discovery_sources', 'h2h_discovery_candidates', 'h2h_discovery_events', 'as2_partners'],
  'open-bank-rest-api': ['open_bank_providers', 'open_bank_file_drops', 'open_bank_events', 'as2_partners', 'h2h_discovery_sources'],
  egress: ['egress_events', 'egress_probes'],
  'private-access': [],
  'idp-ocr': ['idp_documents', 'idp_events'],
  'tax-os': ['tax_returns_1041', 'k1_schedules', 'trust_config', 'tax_payments', 'tax_report_exports', 'trust_journal_lines', 'fineract_trust_accounts', 'crm_contacts'],
  'private-entity': ['private_entity_profile', 'private_entity_attestations', 'trust_config'],
  'clearing-agent': ['clearing_agent_networks', 'clearing_agent_instructions', 'clearing_agent_events', 'ppn_agent_clearing_receipts', 'ppn_agent_events', 'egress_events'],
  'enterprise-odfi': ['enterprise_odfi_profiles', 'enterprise_odfi_batches', 'enterprise_odfi_items', 'enterprise_odfi_events', 'clearing_agent_networks', 'clearing_agent_instructions'],
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
  'enterprise-network': enterpriseNetworkReadiness,
  'private-payment-network': privatePaymentNetworkReadiness,
  aggregator: aggregatorReadiness,
  accounting: accountingReadiness,
  'stripe-intake': stripeIntakeReadiness,
  'treasury-funding-bank': treasuryFundingBankReadiness,
  'payment-hub': paymentHubReadiness,
  openach: openachReadiness,
  mft: mftReadiness,
  'fixed-income': fixedIncomeReadiness,
  custody: custodyReadiness,
  collateral: collateralReadiness,
  'proof-of-asset': proofOfAssetReadiness,
  payer: payerReadiness,
  'third-party-sender': thirdPartySenderReadiness,
  m2m: m2mReadiness,
  'clearing-netting': clearingNettingReadiness,
  'wealth-back-office': wealthBackOfficeReadiness,
  'back-office': backOfficeReadiness,
  'h2h-discovery': h2hDiscoveryReadiness,
  'open-bank-rest-api': openBankRestApiReadiness,
  egress: egressReadiness,
  'private-access': privateAccessReadiness,
  'idp-ocr': idpOcrReadiness,
  'tax-os': taxOsReadiness,
  'private-entity': privateEntityReadiness,
  'clearing-agent': clearingAgentReadiness,
  'enterprise-odfi': enterpriseOdfiReadiness,
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

async function enterpriseNetworkReadiness(ctx) {
  const N = tryRequire('./enterpriseNetworkOsEngine')?.EnterpriseNetworkOsEngine;
  const pipeline = N ? await settle(() => N.pipeline()) : { ok: false, error: 'EnterpriseNetworkOsEngine unavailable' };
  const tables = await tablesPresent(TABLES['enterprise-network']);
  const cfg = N ? N.getConfig() : {};
  const blockers = [];
  if (!ctx.ledger.connected) blockers.push('ledger database (Cloud SQL / DATABASE_URL) not connected');
  if (!N) blockers.push('enterprise network: EnterpriseNetworkOsEngine unavailable');
  else {
    if (!N._processorOs()) blockers.push('enterprise network modules not loadable: paymentProcessorOs (self-loopback checks)');
    if (!cfg.live) blockers.push('ENTERPRISE_NETWORK_LIVE is not true (runtime_environment in infra/gcp/variables.tf); network changes are recorded in shadow mode');
    if (!cfg.requireApproval) blockers.push('ENTERPRISE_NETWORK_REQUIRE_APPROVAL_REF=false disables the approvalRef gate');
    if (!cfg.requireScreening) blockers.push('ENTERPRISE_NETWORK_REQUIRE_SCREENING_REF=false disables the participant screeningRef gate');
    if (!cfg.webhookSecret) blockers.push('ENTERPRISE_NETWORK_WEBHOOK_SECRET not set (screening callbacks to /api/os/enterprise-network/webhook cannot be verified)');
  }
  const missing = missingTables(tables);
  if (missing.length) blockers.push(`Cloud SQL tables missing: ${missing.join(', ')}`);
  return {
    provider: 'enterprise-network registry (no money movement)',
    mode: cfg.live ? 'live' : 'shadow',
    liveFlags: {
      ENTERPRISE_NETWORK_LIVE: Boolean(cfg.live),
      REQUIRE_APPROVAL_REF: cfg.requireApproval !== false,
      REQUIRE_SCREENING_REF: cfg.requireScreening !== false,
      WEBHOOK_SECRET: Boolean(cfg.webhookSecret),
    },
    modules: { pipeline: pipeline.ok ? pipeline.value : { error: pipeline.error } },
    routes: ['/api/os/enterprise-network/{status,readiness,list,process}', '/api/os/enterprise-network/webhook', '/api/os/readiness/enterprise-network'],
    secrets: ['ENTERPRISE_NETWORK_WEBHOOK_SECRET'],
    tables,
    blockers,
  };
}

async function privatePaymentNetworkReadiness(ctx) {
  const N = tryRequire('./privatePaymentNetworkOsEngine')?.PrivatePaymentNetworkOsEngine;
  const inventory = N ? await settle(() => N.processors()) : { ok: false, error: 'PrivatePaymentNetworkOsEngine unavailable' };
  const pipeline = N ? await settle(() => N.pipeline()) : { ok: false, error: 'PrivatePaymentNetworkOsEngine unavailable' };
  const tables = await tablesPresent(TABLES['private-payment-network']);
  const env = process.env;
  const cfg = inventory.ok ? inventory.value.config : (N ? N.getConfig() : {});
  const blockers = [];
  if (!ctx.ledger.connected) blockers.push('ledger database (Cloud SQL / DATABASE_URL) not connected');
  if (!inventory.ok) blockers.push(`private payment network: ${inventory.error}`);
  else {
    const modules = { gateway: Boolean(N._gateway()), paymentProcessorOs: Boolean(N._processorOs()), enterpriseNetwork: Boolean(N._network()), cashLedger: Boolean(N._ledger()) };
    const notLoadable = Object.entries(modules).filter(([, ok]) => !ok).map(([k]) => k);
    if (notLoadable.length) blockers.push(`private payment network modules not loadable: ${notLoadable.join(', ')}`);
    if (!cfg.live) blockers.push('PRIVATE_PAYMENT_NETWORK_LIVE is not true (runtime_environment in infra/gcp/variables.tf); network transactions are recorded in shadow mode');
    if (!cfg.processorLive) blockers.push('PAYMENT_PROCESSOR_LIVE is not true (payouts dispatch through the payment-processor engine)');
    if (!cfg.networkLive) blockers.push('ENTERPRISE_NETWORK_LIVE is not true (payout participants and exposure limits are shadow-only)');
    const external = inventory.value.sources.filter((s) => s.kind === 'payout');
    const ledger = inventory.value.sources.find((s) => s.kind === 'book_transfer');
    if (cfg.familyOnly) {
      if (!ledger || !ledger.realValueCapable) blockers.push(`family-only network: internal_ledger book transfer not real-value capable: ${ledger ? ledger.reason : 'missing'}`);
      const leak = external.filter((s) => s.realValueCapable && cfg.excludedProcessors.some((x) => s.id === x || s.id.startsWith(`${x}_`)));
      if (leak.length) blockers.push(`excluded processors still real-value capable: ${leak.map((s) => s.id).join(', ')}`);
    } else if (!external.some((s) => s.realValueCapable)) {
      const reasons = external.filter((s) => !s.realValueCapable).map((s) => `${s.id}: ${s.reason}`);
      blockers.push(`no real-value payout processor${reasons.length ? `: ${reasons.join('; ')}` : ''}`);
    }
    if (!cfg.requireApproval) blockers.push('PRIVATE_PAYMENT_NETWORK_REQUIRE_APPROVAL_REF=false disables the approvalRef gate');
    if (!cfg.requireScreening) blockers.push('PRIVATE_PAYMENT_NETWORK_REQUIRE_SCREENING_REF=false disables the screeningRef gate');
    if (!cfg.requireParticipant) blockers.push('PRIVATE_PAYMENT_NETWORK_REQUIRE_PARTICIPANT=false allows payouts outside the enterprise-network registry');
    if (!cfg.webhookSecret) blockers.push('PRIVATE_PAYMENT_NETWORK_WEBHOOK_SECRET not set (processor callbacks to /api/os/private-payment-network/webhook cannot be verified)');
    if (inventory.value.coreBankingGate) blockers.push(`core-banking funding source (Fineract): ${inventory.value.coreBankingGate}`);
    else if (cfg.coreBanking?.required && !cfg.coreBanking.defaultSavingsAccountId) blockers.push('CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID not set: only ledger accounts with linked_fineract_account_id can fund payouts');
  }
  if (!env.PAYMENT_DATA_ENCRYPTION_KEY) blockers.push('PAYMENT_DATA_ENCRYPTION_KEY not set (payout instruments are stored encrypted)');
  const missing = missingTables(tables);
  if (missing.length) blockers.push(`Cloud SQL tables missing: ${missing.join(', ')}`);
  const realValue = inventory.ok && inventory.value.anyRealValueCapable;
  return {
    provider: realValue ? inventory.value.realValueCapable.join('+') : 'shadow (no real-value network processor)',
    mode: cfg.live && realValue ? 'live' : 'shadow',
    liveFlags: {
      PRIVATE_PAYMENT_NETWORK_LIVE: Boolean(cfg.live),
      PAYMENT_PROCESSOR_LIVE: Boolean(cfg.processorLive),
      ENTERPRISE_NETWORK_LIVE: Boolean(cfg.networkLive),
      REQUIRE_APPROVAL_REF: cfg.requireApproval !== false,
      REQUIRE_SCREENING_REF: cfg.requireScreening !== false,
      REQUIRE_PARTICIPANT: cfg.requireParticipant !== false,
      MAX_TRANSFER_CENTS: cfg.maxTransferCents || null,
      WEBHOOK_SECRET: Boolean(cfg.webhookSecret),
      MFT_FILE_DROP_LIVE: Boolean(cfg.mftLive),
      FAMILY_ONLY: Boolean(cfg.familyOnly),
      FAMILY_PARTICIPANT_TYPES: cfg.familyParticipantTypes || [],
      EXCLUDED_PROCESSORS: cfg.excludedProcessors || [],
      CORE_BANKING_FUNDING_SOURCE: cfg.coreBanking ? (cfg.coreBanking.required ? cfg.coreBanking.system : 'disabled') : null,
      CANONICAL_FUNDING_LIVE: Boolean(cfg.coreBanking?.live),
      CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID: cfg.coreBanking?.defaultSavingsAccountId || null,
      REAL_VALUE_PROCESSORS: inventory.ok ? inventory.value.realValueCapable : [],
    },
    modules: {
      fundingSource: inventory.ok ? inventory.value.fundingSource : null,
      processors: inventory.ok ? inventory.value.sources : { error: inventory.error },
      pipeline: pipeline.ok ? pipeline.value : { error: pipeline.error },
    },
    routes: ['/api/os/private-payment-network/{status,readiness,list,process}', '/api/os/private-payment-network/webhook', '/api/os/readiness/private-payment-network'],
    secrets: ['PAYMENT_DATA_ENCRYPTION_KEY', 'PRIVATE_PAYMENT_NETWORK_WEBHOOK_SECRET', 'MFTGATEWAY_API_TOKEN_ID + MFTGATEWAY_API_TOKEN_SECRET for the mft_as2 file drop', 'plus the payment-processor secrets of every real-value processor the network pays out over'],
    tables,
    blockers,
  };
}

async function aggregatorReadiness(ctx) {
  const A = tryRequire('../aggregator/bankingAggregator')?.BankingAggregator;
  const scheduler = tryRequire('../aggregator/aggregatorScheduler');
  const tables = await tablesPresent(TABLES.aggregator);
  const env = process.env;
  const enabled = String(env.AGGREGATOR_ENABLED || 'true').toLowerCase() !== 'false';
  const defaultMode = String(env.AGGREGATOR_DEFAULT_MODE || 'shadow').toLowerCase() === 'live' ? 'live' : 'shadow';
  const status = A && tables.banking_aggregator_connections ? await settle(() => A.status()) : { ok: false, error: A ? 'banking_aggregator_connections table missing' : 'BankingAggregator unavailable' };
  const blockers = [];
  if (!ctx.ledger.connected) blockers.push('ledger database (Cloud SQL / DATABASE_URL) not connected');
  if (!A) blockers.push('BankingAggregator module not loadable');
  if (!enabled) blockers.push('AGGREGATOR_ENABLED=false (runtime_environment in infra/gcp/variables.tf); scheduler and pulls are off');
  if (!scheduler) blockers.push('aggregatorScheduler module not loadable');
  else if (!scheduler.isEnabled()) blockers.push('aggregator scheduler disabled (AGGREGATOR_ENABLED / AGGREGATOR_AUTO_SYNC)');
  const missing = missingTables(tables);
  if (missing.length) blockers.push(`Cloud SQL tables missing: ${missing.join(', ')}`);
  let hs = null;
  if (status.ok) {
    hs = status.value.handshake;
    if (status.value.connections === 0) blockers.push('no banking_aggregator_connections configured (POST /api/aggregator/connections)');
    else if (hs && hs.handshake_required > 0 && hs.verified < hs.handshake_required) {
      blockers.push(`${hs.handshake_required - hs.verified} connection(s) awaiting handshake verification (pending ${hs.by_state.pending}, challenged ${hs.by_state.challenged}, failed ${hs.by_state.failed})`);
    }
  } else {
    blockers.push(`aggregator status: ${status.error}`);
  }
  if (defaultMode === 'live' && !env.ADMIN_SECRET_TOKEN) blockers.push('ADMIN_SECRET_TOKEN not set (aggregator routes are admin-gated)');
  return {
    provider: status.ok ? status.value.connectors_available.join('+') : null,
    mode: defaultMode,
    liveFlags: {
      AGGREGATOR_ENABLED: enabled,
      AGGREGATOR_DEFAULT_MODE: defaultMode,
      AGGREGATOR_PULL_INTERVAL_MS: scheduler ? scheduler.resolveInterval() : null,
      AGGREGATOR_HANDSHAKE_TIMEOUT_MS: hs ? hs.timeout_ms : Number(env.AGGREGATOR_HANDSHAKE_TIMEOUT_MS) || 15000,
      REQUIRE_APPROVAL_REF: true,
      REQUIRE_SCREENING_REF: true,
      SCHEDULER_OIDC: Boolean(env.AGGREGATOR_SCHEDULER_SERVICE_ACCOUNT && env.AGGREGATOR_SCHEDULER_AUDIENCE),
    },
    modules: {
      connections: status.ok ? status.value.connections : null,
      connectionsActive: status.ok ? status.value.connections_active : null,
      verifiedHandshakes: hs ? hs.verified : null,
      handshake: hs,
      accounts: status.ok ? status.value.accounts : null,
      transactions: status.ok ? status.value.transactions : null,
      events: status.ok ? status.value.events : null,
      accountingSync: 'DataBridge.syncAggregatorToAccounting (aggregatorScheduler.runOnce + DataBridge.runFullSync)',
    },
    jobs: ['aggregator-auto-sync (leader-elected in-process, AGGREGATOR_PULL_INTERVAL_MS; sole poller, no Cloud Scheduler job)'],
    routes: ['/api/aggregator/{status,connections}', '/api/aggregator/connections/:id/{handshake,pull,push}', '/api/aggregator/webhooks/:id', '/api/os/readiness/aggregator'],
    secrets: ['ADMIN_SECRET_TOKEN', 'AGGREGATOR_<CONNECTION>_API_KEY / AGGREGATOR_<CONNECTION>_WEBHOOK_SECRET per connection (Secret Manager; loaded into connection config)'],
    tables,
    blockers,
  };
}

async function accountingReadiness(ctx) {
  const env = process.env;
  const fineract = tryRequire('../fineract/fineractClient');
  const bridge = tryRequire('../accounting/dataBridge');
  const trust = tryRequire('../accounting/trustAccountingEngine');
  const tables = await tablesPresent(TABLES.accounting);
  const blockers = [];
  if (!ctx.ledger.connected) blockers.push('ledger database (Cloud SQL / DATABASE_URL) not connected');
  if (!fineract) blockers.push('FineractClient not loadable');
  if (!bridge) blockers.push('DataBridge not loadable');
  if (!trust) blockers.push('TrustAccountingEngine not loadable');
  if (!env.FINERACT_URL) blockers.push('FINERACT_URL not set (infra/gcp: dlbtrust-fineract Cloud Run service)');
  if (!env.FINERACT_USERNAME || !env.FINERACT_PASSWORD) blockers.push('FINERACT_USERNAME / FINERACT_PASSWORD not set (Secret Manager)');
  const health = fineract && env.FINERACT_URL ? await settle(() => fineract.FineractClient.healthCheck()) : { ok: false, error: 'skipped' };
  if (env.FINERACT_URL && !health.ok) blockers.push(`fineract: ${health.error}`);
  let savings = null;
  if (health.ok) {
    const list = await settle(() => fineract.FineractClient.listSavingsAccounts({ limit: 50 }));
    if (list.ok) {
      const items = Array.isArray(list.value?.pageItems) ? list.value.pageItems : Array.isArray(list.value) ? list.value : [];
      savings = items.map((s) => ({
        id: s.id, accountNo: s.accountNo, externalId: s.externalId || null, clientName: s.clientName || null,
        product: s.savingsProductName || null, active: Boolean(s.status?.active),
        availableBalance: s.summary?.availableBalance ?? s.summary?.accountBalance ?? null,
      }));
      if (!savings.some((s) => s.active)) blockers.push('no active Fineract savings account (trust account of record) to fund payouts');
    } else savings = { error: list.error };
  }
  const Structure = tryRequire('../fineract/trustAccountStructure')?.TrustAccountStructure;
  const structure = health.ok && Structure ? await settle(() => Structure.inventory()) : { ok: false, error: Structure ? 'skipped' : 'TrustAccountStructure not loadable' };
  if (structure.ok) {
    for (const b of structure.value.blockers) blockers.push(`trust account structure: ${b}`);
  } else if (health.ok) blockers.push(`trust account structure: ${structure.error}`);
  let lastSync = null;
  if (bridge && tables.data_bridge_sync_log) {
    const hist = await settle(() => bridge.DataBridge.getSyncHistory({ limit: 1 }));
    if (hist.ok && Array.isArray(hist.value) && hist.value[0]) lastSync = hist.value[0];
  }
  const missing = missingTables(tables);
  if (missing.length) blockers.push(`Cloud SQL tables missing: ${missing.join(', ')}`);
  const live = health.ok && ctx.ledger.connected && structure.ok && structure.value.complete;
  return {
    provider: 'fineract-core-banking+data-bridge',
    mode: live ? 'live' : 'shadow',
    liveFlags: {
      FINERACT_URL: Boolean(env.FINERACT_URL),
      FINERACT_TENANT_ID: env.FINERACT_TENANT_ID || 'default',
      FINERACT_CONNECTED: health.ok,
      CANONICAL_FUNDING_LIVE: String(env.CANONICAL_FUNDING_LIVE).toLowerCase() === 'true',
      CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID: env.CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID || null,
      PAYMENT_HUB_ACCOUNTING_OWNER: env.PAYMENT_HUB_ACCOUNTING_OWNER || null,
    },
    modules: {
      fineract: health.ok ? { connected: true, offices: Array.isArray(health.value.offices) ? health.value.offices.length : null } : { error: health.error },
      savingsAccounts: savings,
      trustAccountStructure: structure.ok ? structure.value : { error: structure.error },
      dataBridge: Boolean(bridge),
      trustAccounting: Boolean(trust),
      lastSync,
      glAccounts: bridge ? bridge.ACCOUNTS : null,
      classification: 'DataBridge.classifyAggregatorTxn: coupon → 4100, interest → 4000, principal → 3000, distribution → 2000, operating expense → 5300',
    },
    jobs: ['DataBridge.runFullSync (aggregatorScheduler.runOnce)', 'DataBridge.getReconciliationReport (GET /api/accounting/bridge/report)'],
    routes: ['/api/accounting/*', '/api/accounting/bridge/*', '/api/fineract/*', '/api/fineract/trust-accounts', 'POST /api/fineract/trust-accounts/provision (admin)', '/api/os/readiness/accounting'],
    secrets: ['FINERACT_USERNAME', 'FINERACT_PASSWORD'],
    tables,
    blockers,
  };
}

async function stripeIntakeReadiness(ctx) {
  const env = process.env;
  const Intake = tryRequire('../payments/stripePaymentIntakeEngine')?.StripePaymentIntakeEngine;
  const Payout = tryRequire('../payments/liliStripePayoutOriginator')?.LiliStripePayoutOriginator;
  const intake = Intake ? await settle(() => Intake.status()) : { ok: false, error: 'StripePaymentIntakeEngine unavailable' };
  const payout = Payout ? await settle(() => Payout.status()) : { ok: false, error: 'LiliStripePayoutOriginator unavailable' };
  const tables = await tablesPresent(TABLES['stripe-intake']);
  const blockers = [];
  if (!ctx.ledger.connected) blockers.push('ledger database (Cloud SQL / DATABASE_URL) not connected');
  if (!intake.ok) blockers.push(`stripe intake: ${intake.error}`);
  else blockers.push(...(intake.value.issues || []).map(i => `stripe intake: ${i}`));
  if (!payout.ok) blockers.push(`stripe payout: ${payout.error}`);
  else if (payout.value.enabled) blockers.push(...(payout.value.issues || []).map(i => `stripe payout: ${i}`));
  if (!env.PAYMENT_SERVER_SERVICE_TOKEN) blockers.push('PAYMENT_SERVER_SERVICE_TOKEN not set (/api/payment-server/v1 is service-gated)');
  const missing = missingTables(tables);
  if (missing.length) blockers.push(`Cloud SQL tables missing: ${missing.join(', ')}`);
  const keyMode = intake.ok ? intake.value.mode : null;
  return {
    provider: 'stripe',
    mode: keyMode === 'live' && intake.ok && intake.value.ready ? 'live' : 'shadow',
    liveFlags: {
      STRIPE_INTAKE_ENABLED: intake.ok ? intake.value.enabled : isTrue(env.STRIPE_INTAKE_ENABLED),
      STRIPE_KEY_MODE: keyMode,
      STRIPE_WEBHOOK_SECRET: intake.ok ? intake.value.webhookConfigured : Boolean(env.STRIPE_WEBHOOK_SECRET),
      STRIPE_INTAKE_PAYMENT_METHODS: intake.ok ? intake.value.paymentMethodTypes : null,
      LILI_ORIGINATOR: env.LILI_ORIGINATOR || null,
      STRIPE_PAYOUT_EXTERNAL_ACCOUNT_ID: Boolean(env.STRIPE_PAYOUT_EXTERNAL_ACCOUNT_ID),
    },
    modules: {
      intake: intake.ok ? { ready: intake.value.ready, account: intake.value.account, capabilities: intake.value.capabilities } : { error: intake.error },
      payout: payout.ok ? { enabled: payout.value.enabled, ready: payout.value.ready, account: payout.value.account, externalAccount: payout.value.externalAccount && { bankName: payout.value.externalAccount.bankName, last4: payout.value.externalAccount.last4, status: payout.value.externalAccount.status }, balance: payout.value.balance } : { error: payout.error },
    },
    routes: ['/api/payment-server/v1/stripe-intakes/*', '/api/payment-server/v1/stripe/webhook', '/api/payment-server/v1/stripe-intakes/:id/payout', '/api/os/readiness/stripe-intake'],
    secrets: ['STRIPE_PAYMENTS_SECRET_KEY (rk_live_/sk_live_)', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PAYOUT_EXTERNAL_ACCOUNT_ID', 'PAYMENT_SERVER_SERVICE_TOKEN'],
    tables,
    blockers,
  };
}

async function treasuryFundingBankReadiness(ctx) {
  const env = process.env;
  const T = tryRequire('../payments/treasuryFundingBankEngine')?.TreasuryFundingBankEngine;
  const status = T ? await settle(() => T.status()) : { ok: false, error: 'TreasuryFundingBankEngine unavailable' };
  const tables = await tablesPresent(TABLES['treasury-funding-bank']);
  const blockers = [];
  if (!ctx.ledger.connected) blockers.push('ledger database (Cloud SQL / DATABASE_URL) not connected');
  if (!status.ok) blockers.push(`treasury funding bank: ${status.error}`);
  else blockers.push(...(status.value.issues || []).map(i => `treasury funding bank: ${i}`));
  const missing = missingTables(tables);
  if (missing.length) blockers.push(`Cloud SQL tables missing: ${missing.join(', ')}`);
  const bank = status.ok ? status.value.bank : null;
  return {
    provider: 'betterment-trust-checking via stripe_ach_debit',
    mode: status.ok && status.value.ready ? 'live' : 'shadow',
    liveFlags: {
      TREASURY_BANK_ENABLED: isTrue(env.TREASURY_BANK_ENABLED),
      STRIPE_KEY_MODE: status.ok ? status.value.keyMode : null,
      MANDATE_ACCEPTANCE: status.ok ? status.value.mandateAcceptance : null,
      TREASURY_BANK_REGISTER_SETTLEMENT: isTrue(env.TREASURY_BANK_REGISTER_SETTLEMENT),
      BETTERMENT_ROUTING_NUMBER: Boolean(env.TREASURY_BANK_ROUTING_NUMBER || env.BETTERMENT_ROUTING_NUMBER),
      BETTERMENT_ACCOUNT_NUMBER: Boolean(env.TREASURY_BANK_ACCOUNT_NUMBER || env.BETTERMENT_ACCOUNT_NUMBER),
    },
    modules: {
      bank: bank ? { bankId: bank.bankId, name: bank.name, institution: bank.institution, accountNumberMasked: bank.accountNumberMasked, verification: bank.verification, nextAction: bank.nextAction, linkedAt: bank.linkedAt, verifiedAt: bank.verifiedAt } : null,
      flow: status.ok ? status.value.flow : null,
      warnings: status.ok ? status.value.warnings : [],
    },
    routes: ['/api/payment-server/v1/treasury-bank', '/api/payment-server/v1/treasury-bank/{link,verify,refresh,pull}', '/api/os/readiness/treasury-funding-bank'],
    secrets: ['STRIPE_PAYMENTS_SECRET_KEY (live)', 'BETTERMENT_ROUTING_NUMBER', 'BETTERMENT_ACCOUNT_NUMBER', 'PAYMENT_SERVER_SERVICE_TOKEN'],
    tables,
    blockers,
  };
}

async function paymentHubReadiness(ctx) {
  const env = process.env;
  const hubConfig = tryRequire('../paymentHub/paymentHubConfig');
  const hubEngine = tryRequire('../paymentHub/paymentHubEngine');
  const hub = hubConfig ? await settle(() => hubConfig.readiness()) : { ok: false, error: 'paymentHubConfig unavailable' };
  const tables = await tablesPresent(TABLES['payment-hub']);
  const blockers = [];
  if (!ctx.ledger.connected) blockers.push('ledger database (Cloud SQL / DATABASE_URL) not connected');
  if (!hubEngine) blockers.push('PaymentHubEngine not loadable');
  if (!hub.ok) blockers.push(`payment hub: ${hub.error}`);
  else {
    blockers.push(...(hub.value.issues || []).map(i => `payment hub: ${i}`));
    if (!hub.value.canTransmit) blockers.push('payment hub cannot transmit (PAYMENT_HUB_LIVE / mode)');
  }
  const missing = missingTables(tables);
  if (missing.length) blockers.push(`Cloud SQL tables missing: ${missing.join(', ')}`);
  const cfg = hub.ok ? hub.value.config : {};
  return {
    provider: cfg.mode === 'phee' ? 'payment-hub-ee' : cfg.mode || null,
    mode: hub.ok && hub.value.canTransmit ? 'live' : 'shadow',
    liveFlags: {
      PAYMENT_HUB_LIVE: isTrue(env.PAYMENT_HUB_LIVE),
      PAYMENT_HUB_MODE: cfg.mode || env.PAYMENT_HUB_MODE || null,
      PAYMENT_HUB_TENANT_ID: cfg.tenantId || env.PAYMENT_HUB_TENANT_ID || null,
      PAYMENT_APPROVAL_THRESHOLD: cfg.approvalThreshold || null,
      PAYMENT_HUB_ACCOUNTING_OWNER: cfg.accountingOwner || null,
    },
    modules: { paymentHub: hub.ok ? { ready: hub.value.ready, canTransmit: hub.value.canTransmit, warnings: hub.value.warnings, config: cfg } : { error: hub.error } },
    routes: ['/api/payment-hub/*', '/api/os/readiness/payment-hub'],
    secrets: ['PAYMENT_HUB_AUTH_TOKEN', 'PAYMENT_HUB_SERVICE_TOKEN', 'PAYMENT_HUB_WEBHOOK_SECRET', 'PAYMENT_DATA_ENCRYPTION_KEY'],
    tables,
    blockers,
  };
}

async function openachReadiness(ctx) {
  const env = process.env;
  const railCfg = tryRequire('../openach/openachRailConfig');
  const Rail = tryRequire('../openach/openachRailEngine')?.OpenAchRailEngine;
  const Relay = tryRequire('../openach/openachFileRelay')?.OpenAchFileRelay;
  const Odfi = tryRequire('../ach/treasuryOdfiBank')?.TreasuryOdfiBank;
  const rail = railCfg ? await settle(() => railCfg.openAchRailReadiness()) : { ok: false, error: 'openachRailConfig unavailable' };
  const relay = Relay ? await settle(() => Relay.status()) : { ok: false, error: 'OpenAchFileRelay unavailable' };
  const odfi = Odfi ? await settle(() => Odfi.status()) : { ok: false, error: 'TreasuryOdfiBank unavailable' };
  const pipeline = Rail && ctx.ledger.connected ? await settle(() => Rail.status()) : { ok: false, error: 'skipped' };
  const tables = await tablesPresent(TABLES.openach);
  const blockers = [];
  if (!ctx.ledger.connected) blockers.push('ledger database (Cloud SQL / DATABASE_URL) not connected');
  if (!Rail) blockers.push('OpenAchRailEngine not loadable');
  if (!rail.ok) blockers.push(`openach rail: ${rail.error}`);
  else blockers.push(...(rail.value.blockers || []).map(b => `openach rail: ${b}`));
  if (!odfi.ok) blockers.push(`odfi: ${odfi.error}`);
  else blockers.push(...(odfi.value.issues || []).map(i => `odfi (${odfi.value.bankName || odfi.value.bank || 'unset'}): ${i}`));
  if (!relay.ok) blockers.push(`file relay: ${relay.error}`);
  else if (!relay.value.ready) blockers.push(...(relay.value.issues || []).map(i => `file relay: ${i}`));
  const missing = missingTables(tables);
  if (missing.length) blockers.push(`Cloud SQL tables missing: ${missing.join(', ')}`);
  const odfiReady = odfi.ok && odfi.value.ready;
  return {
    provider: `openach → ${odfi.ok && odfi.value.bankName ? odfi.value.bankName : 'no ODFI'}`,
    mode: rail.ok && rail.value.ready && odfiReady ? 'live' : 'shadow',
    liveFlags: {
      OPENACH_RAIL_ENABLED: isTrue(env.OPENACH_RAIL_ENABLED),
      OPENACH_BASE_URL: Boolean(env.OPENACH_BASE_URL),
      OPENACH_ACH_FILES_BUCKET: Boolean(env.OPENACH_ACH_FILES_BUCKET),
      ACH_ODFI_BANK: env.ACH_ODFI_BANK || null,
      ODFI_FILE_CHANNEL_READY: odfiReady,
      MFTGATEWAY_PARTNER_AS2_ID: Boolean(env.MFTGATEWAY_PARTNER_AS2_ID),
      ACH_SFTP_URL: Boolean(env.ACH_SFTP_URL),
    },
    modules: {
      rail: rail.ok ? rail.value : { error: rail.error },
      odfi: odfi.ok ? { bank: odfi.value.bank, bankName: odfi.value.bankName, accountLast4: odfi.value.accountLast4, channels: odfi.value.channels, ready: odfi.value.ready } : { error: odfi.error },
      fileRelay: relay.ok ? { ready: relay.value.ready, transport: relay.value.transport, partnerAs2Id: Boolean(relay.value.partnerAs2Id) } : { error: relay.error },
      pipeline: pipeline.ok ? { awaitingOrigination: pipeline.value.awaitingOrigination, byState: pipeline.value.byState } : { error: pipeline.error },
    },
    jobs: ['openach-nightly (Cloud Run job, infra/gcp)', 'OpenAchFileRelay.run (OPENACH_FILE_RELAY_INTERVAL_MS)'],
    routes: ['/api/openach/*', '/api/os/readiness/openach'],
    secrets: ['OPENACH_API_TOKEN', 'OPENACH_API_KEY', 'MFTGATEWAY_API_TOKEN_ID', 'MFTGATEWAY_API_TOKEN_SECRET', 'ACH_SFTP_KEY or ACH_SFTP_PASSWORD'],
    tables,
    blockers,
  };
}

async function mftReadiness(ctx) {
  const env = process.env;
  const M = tryRequire('./mftOsEngine')?.MftOsEngine;
  const tables = await tablesPresent(TABLES.mft);
  const status = M && ctx.ledger.connected && tables.mft_channels ? await settle(() => M.status()) : { ok: false, error: M ? 'mft tables missing or ledger disconnected' : 'MftOsEngine unavailable' };
  const blockers = [];
  if (!ctx.ledger.connected) blockers.push('ledger database (Cloud SQL / DATABASE_URL) not connected');
  if (!M) blockers.push('MftOsEngine not loadable');
  if (!status.ok) blockers.push(`mft: ${status.error}`);
  else {
    const channels = status.value.channels || [];
    const ready = channels.filter(c => c.readiness && c.readiness.ready);
    if (!channels.length) blockers.push('no MFT channels registered (POST /api/os/mft/process action=registerChannel)');
    else if (!ready.length) {
      for (const c of channels) blockers.push(`channel ${c.channelId} (${c.transport}): ${(c.readiness && c.readiness.blockers || []).join('; ') || 'not ready'}`);
    }
    if (!status.value.policy.requireApproval) blockers.push('MFT_REQUIRE_APPROVAL=false disables the file approval gate');
  }
  const missing = missingTables(tables);
  if (missing.length) blockers.push(`Cloud SQL tables missing: ${missing.join(', ')}`);
  const anyBankChannel = status.ok && (status.value.channels || []).some(c => c.transport === 'sftp' && c.readiness && c.readiness.ready);
  return {
    provider: anyBankChannel ? 'sftp' : 'spool (no bank host)',
    mode: anyBankChannel ? 'live' : 'shadow',
    liveFlags: {
      MFT_SFTP_HOST: Boolean(env.MFT_SFTP_HOST),
      MFT_REQUIRE_APPROVAL: status.ok ? status.value.policy.requireApproval : true,
      MFT_ALLOW_SPOOL_IN_PRODUCTION: isTrue(env.MFT_ALLOW_SPOOL_IN_PRODUCTION),
      PRIVATE_PAYMENT_NETWORK_MFT_LIVE: isTrue(env.PRIVATE_PAYMENT_NETWORK_MFT_LIVE),
    },
    modules: status.ok ? { channels: status.value.channels, files: status.value.files, inFlightCents: status.value.inFlightCents } : { error: status.error },
    routes: ['/api/os/mft/{status,readiness,list,process}', '/api/os/readiness/mft'],
    secrets: ['MFT_SFTP_PASSWORD or MFT_SFTP_PRIVATE_KEY (or an M2M identity bound to the channel)'],
    tables,
    blockers,
  };
}

async function fixedIncomeReadiness(ctx) {
  const env = process.env;
  const Debt = tryRequire('./debtOsEngine')?.DebtOsEngine;
  const Coupon = tryRequire('../bonds/couponService')?.CouponService;
  const Live = tryRequire('../bonds/liveEngine')?.LiveBondEngine;
  const Dist = tryRequire('./fixedIncomeDistributionEngine')?.FixedIncomeDistributionEngine;
  const tables = await tablesPresent(TABLES['fixed-income']);
  const blockers = [];
  if (!ctx.ledger.connected) blockers.push('ledger database (Cloud SQL / DATABASE_URL) not connected');
  if (!Debt) blockers.push('DebtOsEngine not loadable');
  if (!Coupon) blockers.push('CouponService (coupon scheduler) not loadable');
  if (!Live) blockers.push('LiveBondEngine not loadable');
  if (!Dist) blockers.push('FixedIncomeDistributionEngine not loadable');
  const missing = missingTables(tables);
  if (missing.length) blockers.push(`Cloud SQL tables missing: ${missing.join(', ')}`);
  const [obligations, recurring, dist, schedule] = await Promise.all([
    Debt ? settle(() => Debt.obligations()) : { ok: false, error: 'skipped' },
    Debt ? settle(() => Debt.recurringCouponConfig()) : { ok: false, error: 'skipped' },
    Dist ? settle(() => Dist.readiness()) : { ok: false, error: 'skipped' },
    Debt ? settle(() => Debt.schedule(90)) : { ok: false, error: 'skipped' },
  ]);
  const totals = obligations.ok ? obligations.value.totals : null;
  if (obligations.ok && !(totals && totals.activeBonds > 0)) blockers.push('no active bond: no coupon income stream to fund the trust account of record');
  else if (!obligations.ok) blockers.push(`bond obligations: ${obligations.error}`);
  const coreBanking = recurring.ok ? recurring.value.coreBanking : null;
  if (recurring.ok) {
    if (!recurring.value.enabled) blockers.push('recurring coupon settlement disabled: set debt_os_coupon_ledger_account (POST /api/os/debt/recurring-coupon) to the ledger cash account linked to the Fineract savings account of record');
    else if (coreBanking?.blocker) blockers.push(`coupon -> Fineract core banking: ${coreBanking.blocker}`);
    else if (coreBanking && coreBanking.destination !== 'interest-income') blockers.push(`coupon deposits fall back to the ${coreBanking.destination} (savings ${coreBanking.savingsAccountId}): Fineract interest-income savings account not active (POST /api/fineract/trust-accounts/provision)`);
  } else blockers.push(`recurring coupon config: ${recurring.error}`);
  const Structure = tryRequire('../fineract/trustAccountStructure')?.TrustAccountStructure;
  const structure = Structure && env.FINERACT_URL ? await settle(() => Structure.inventory()) : { ok: false, error: 'skipped' };
  const incomeAccounts = structure.ok ? {
    principal: structure.value.principal, interestIncome: structure.value.interestIncome, accountOfRecord: structure.value.accountOfRecord,
    trustees: structure.value.trustees.length, beneficiaries: structure.value.beneficiaries.length, complete: structure.value.complete,
  } : { error: structure.error };
  if (structure.ok) {
    if (!structure.value.principal?.active) blockers.push('Fineract principal (corpus, GL 3000) savings account not active');
    if (!structure.value.interestIncome?.active) blockers.push('Fineract interest-income (GL 4000) savings account not active');
  }
  if (!env.FINERACT_URL) blockers.push('FINERACT_URL not set (infra/gcp: dlbtrust-fineract Cloud Run service)');
  if (dist.ok) {
    if (dist.value.rail !== 'bank') blockers.push(`FIXED_INCOME_RAIL=${dist.value.rail}: distributions must use the fiat bank rail (blockchain/policy-contract rail retired)`);
    if (!dist.value.enabled) blockers.push('FIXED_INCOME_DISTRIBUTION_ENABLED=false');
  } else blockers.push(`fixed-income distribution readiness: ${dist.error}`);
  const distributionWarnings = dist.ok ? (dist.value.issues || []).map((issue) => `downstream beneficiary distribution: ${issue}`) : [];
  const live = Boolean(coreBanking?.savingsAccountId) && isTrue(env.CANONICAL_FUNDING_LIVE) && dist.ok && dist.value.rail === 'bank';
  return {
    provider: 'bond-engine+coupon-scheduler+fineract',
    mode: live ? 'live' : 'shadow',
    liveFlags: {
      FINERACT_URL: Boolean(env.FINERACT_URL),
      CANONICAL_FUNDING_LIVE: isTrue(env.CANONICAL_FUNDING_LIVE),
      CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID: env.CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID || null,
      PRIVATE_PAYMENT_NETWORK_CORE_BANKING: String(env.PRIVATE_PAYMENT_NETWORK_CORE_BANKING || 'true').toLowerCase() !== 'false',
      FIXED_INCOME_RAIL: dist.ok ? dist.value.rail : env.FIXED_INCOME_RAIL || null,
      FIXED_INCOME_DISTRIBUTION_ENABLED: dist.ok ? dist.value.enabled : null,
      ASSET_SALES: false,
    },
    modules: {
      bonds: totals,
      obligations: obligations.ok ? obligations.value.obligations ?? obligations.value.bonds ?? null : { error: obligations.error },
      schedule90d: schedule.ok ? schedule.value : { error: schedule.error },
      couponSettlement: recurring.ok ? recurring.value : { error: recurring.error },
      fundingChain: 'bond accrual -> coupon_payments -> DebtOsEngine.settleCouponToLedger -> FineractClient.depositSavings(interest-income savings account, GL 4000; falls back to the account of record) + cash_accounts -> PPN payouts (withdraw before dispatch)',
      fineractAccounts: incomeAccounts,
      distribution: dist.ok ? { rail: dist.value.rail, ready: dist.value.ready, issues: dist.value.issues, buckets: (dist.value.buckets || []).map((b) => ({ bucket: b.bucket, glAccountCode: b.glAccountCode, payees: (b.payees || []).length })) } : { error: dist.error },
      accountingSync: 'DataBridge.syncBondsToAccounting (coupon_payments -> Dr 1020 / Cr 4100) + pushToFineract GL',
      warnings: distributionWarnings,
    },
    jobs: ['coupon-payments (leader-elected in-process: CouponService.scheduleCouponJob, startup + every 6h)'],
    routes: ['/api/bonds', '/api/bonds/:id/{live,coupon-schedule,coupon-payments,accrue,deposit-coupon}', '/api/bonds/coupon-check', '/api/os/debt/{status,recurring-coupon,settle-coupon}', '/api/fixed-income/{readiness,summary,sources,distributions,plan,cycle}', '/api/os/readiness/fixed-income'],
    secrets: ['FINERACT_URL', 'FINERACT_TENANT_ID', 'FINERACT_USERNAME', 'FINERACT_PASSWORD', 'ADMIN_SECRET_TOKEN'],
    tables,
    blockers,
  };
}

function baseBlockers(ctx, tables, mod, name) {
  const blockers = [];
  if (!ctx.ledger.connected) blockers.push('ledger database (Cloud SQL / DATABASE_URL) not connected');
  if (!mod) blockers.push(`${name} not loadable`);
  const missing = missingTables(tables);
  if (missing.length) blockers.push(`Cloud SQL tables missing: ${missing.join(', ')}`);
  return blockers;
}

async function custodyReadiness(ctx) {
  const env = process.env;
  const Custody = tryRequire('../custody/custodyOsEngine')?.CustodyOsEngine;
  const tables = await tablesPresent(TABLES.custody);
  const blockers = baseBlockers(ctx, tables, Custody, 'CustodyOsEngine');
  const status = Custody && !missingTables(tables).length ? await settle(() => Custody.status()) : { ok: false, error: 'skipped' };
  let fixedIncome = null;
  if (status.ok) {
    const s = status.value;
    if (s.chain?.error) blockers.push(`custody chain: ${s.chain.error}`);
    else if (s.chain && !s.chain.intact) blockers.push(`custody event chain broken at ${s.chain.breaks.length} event(s)`);
    const issuer = (s.statement?.accounts || []).find((a) => a.custodyAccountId === s.fixedIncomeFeed?.issuerAccountId);
    const positions = issuer ? issuer.positions : [];
    fixedIncome = {
      accountId: s.fixedIncomeFeed?.issuerAccountId, lastSyncedAt: s.fixedIncomeFeed?.lastSyncedAt,
      positions: positions.length, receipted: positions.filter((p) => p.controlStatus === 'receipted').length,
      valuationCents: positions.reduce((t, p) => t + Number(p.valuationCents || 0), 0),
    };
    if (!issuer) blockers.push('issuer fixed-income custody account not opened (CustodyOsEngine.syncFixedIncome runs at startup; CUSTODY_FIXED_INCOME_SYNC)');
    else if (!positions.length) blockers.push('no fixed-income position in custody (no active bond synced)');
    else if (!fixedIncome.receipted) blockers.push(`${s.pendingReceipts} safekeeping receipt(s) awaiting the second trustee countersignature (POST /api/finops/custody/receipts/:id/countersign)`);
  } else if (status.error !== 'skipped') blockers.push(`custody status: ${status.error}`);
  return {
    provider: 'custody-os',
    mode: fixedIncome && fixedIncome.receipted > 0 ? 'live' : 'shadow',
    liveFlags: {
      CUSTODY_REQUIRED_SIGNATURES: status.ok ? status.value.requiredSignatures : Number(env.CUSTODY_REQUIRED_SIGNATURES) || 2,
      CUSTODY_RESERVE_SYNC: String(env.CUSTODY_RESERVE_SYNC || 'true').toLowerCase() !== 'false',
      CUSTODY_FIXED_INCOME_SYNC: String(env.CUSTODY_FIXED_INCOME_SYNC || 'true').toLowerCase() !== 'false',
      CUSTODY_GL_BOOKING_ENABLED: String(env.CUSTODY_GL_BOOKING_ENABLED || 'true').toLowerCase() !== 'false',
    },
    modules: status.ok ? { fixedIncome, pendingReceipts: status.value.pendingReceipts, chain: { events: status.value.chain?.events, intact: status.value.chain?.intact }, accounts: (status.value.statement?.accounts || []).map((a) => ({ id: a.custodyAccountId, type: a.custodyType, positions: a.positions.length })) } : { error: status.error },
    jobs: ['custody fixed-income + collateral feed sync at startup (server-3002 init)'],
    routes: ['/api/finops/custody/{status,statement,accounts,positions,receipts}', '/api/os/readiness/custody'],
    secrets: ['ADMIN_SECRET_TOKEN'],
    tables,
    blockers,
  };
}

async function collateralReadiness(ctx) {
  const env = process.env;
  const Custody = tryRequire('../custody/custodyOsEngine')?.CustodyOsEngine;
  const Debt = tryRequire('./debtOsEngine')?.DebtOsEngine;
  const tables = await tablesPresent(TABLES.collateral);
  const blockers = baseBlockers(ctx, tables, Custody, 'CustodyOsEngine');
  if (!Debt) blockers.push('DebtOsEngine not loadable');
  const [statement, obligations] = await Promise.all([
    Custody && !missingTables(tables).length ? settle(() => Custody.statement()) : { ok: false, error: 'skipped' },
    Debt ? settle(() => Debt.obligations()) : { ok: false, error: 'skipped' },
  ]);
  let base = null;
  if (statement.ok) {
    const positions = (statement.value.accounts || []).flatMap((a) => a.positions.filter((p) => p.assetClass === 'fixed_income'));
    const receipted = positions.filter((p) => p.controlStatus === 'receipted');
    base = {
      positions: positions.length, receipted: receipted.length,
      heldCents: positions.reduce((t, p) => t + Number(p.valuationCents || 0), 0),
      receiptedCents: receipted.reduce((t, p) => t + Number(p.valuationCents || 0), 0),
      principalOutstanding: obligations.ok ? obligations.value.totals.principalOutstanding : null,
    };
    if (!positions.length) blockers.push('no fixed-income position in custody to serve as collateral base');
    else if (!receipted.length) blockers.push('fixed-income custody position not receipted (dual-signed safekeeping receipt required before it counts as collateral)');
  } else if (statement.error !== 'skipped') blockers.push(`custody statement: ${statement.error}`);
  if (isTrue(env.COLLATERAL_DRAWS_LIVE)) blockers.push('COLLATERAL_DRAWS_LIVE=true: on-chain collateral draws (thirdweb/USDC/Spritz) are retired; the trust is income-support only');
  return {
    provider: 'custody-receipted fixed income',
    mode: base && base.receipted > 0 && !isTrue(env.COLLATERAL_DRAWS_LIVE) ? 'live' : 'shadow',
    liveFlags: { COLLATERAL_OS_ENABLED: String(env.COLLATERAL_OS_ENABLED || 'true').toLowerCase() !== 'false', COLLATERAL_DRAWS_LIVE: isTrue(env.COLLATERAL_DRAWS_LIVE), ON_CHAIN_DRAW_RAIL: 'retired', ASSET_SALES: false },
    modules: { base, draws: 'none: income-support-only trust; collateral is held and proven, never drawn against or sold' },
    routes: ['/api/collateral-os/{readiness,status,facility}', '/api/finops/custody/statement', '/api/os/readiness/collateral'],
    secrets: ['ADMIN_SECRET_TOKEN'],
    tables,
    blockers,
  };
}

async function proofOfAssetReadiness(ctx) {
  const env = process.env;
  const Proof = tryRequire('./proofOfAssetOsEngine')?.ProofOfAssetOsEngine;
  const tables = await tablesPresent(TABLES['proof-of-asset']);
  const blockers = baseBlockers(ctx, tables, Proof, 'ProofOfAssetOsEngine');
  const status = Proof && ctx.ledger.connected ? await settle(() => Proof.status()) : { ok: false, error: 'skipped' };
  if (status.ok) for (const issue of status.value.issues || []) blockers.push(issue);
  else if (status.error !== 'skipped') blockers.push(`proof-of-asset status: ${status.error}`);
  if (!env.FINERACT_URL) blockers.push('FINERACT_URL not set (Fineract account of record is a proof layer)');
  const interval = Number(env.PROOF_OF_ASSET_INTERVAL_MINUTES) || 0;
  return {
    provider: 'proof-of-asset-os',
    mode: status.ok && status.value.ready ? 'live' : 'shadow',
    liveFlags: { PROOF_OF_ASSET_ENABLED: status.ok ? status.value.enabled : String(env.PROOF_OF_ASSET_ENABLED || 'true').toLowerCase() !== 'false', PROOF_OF_ASSET_INTERVAL_MINUTES: interval, PROOF_OF_ASSET_AUTO_CERTIFY: isTrue(env.PROOF_OF_ASSET_AUTO_CERTIFY), FINERACT_URL: Boolean(env.FINERACT_URL) },
    modules: status.ok ? { latest: status.value.latest, counts: status.value.counts, layers: status.value.layers, scheduler: status.value.scheduler } : { error: status.error },
    jobs: [interval > 0 ? `proof-of-asset scheduler every ${interval}m (in-process)` : 'proof-of-asset scheduler off (PROOF_OF_ASSET_INTERVAL_MINUTES=0); proofs on demand'],
    routes: ['/api/proof-of-asset/{status,proofs,proofs/:id/certify}', '/api/os/readiness/proof-of-asset'],
    secrets: ['FINERACT_URL', 'FINERACT_USERNAME', 'FINERACT_PASSWORD', 'ADMIN_SECRET_TOKEN'],
    tables,
    blockers,
  };
}

async function payerReadiness(ctx) {
  const env = process.env;
  const Payer = tryRequire('./payerOsEngine')?.PayerOsEngine;
  const tables = await tablesPresent(TABLES.payer);
  const blockers = baseBlockers(ctx, tables, Payer, 'PayerOsEngine');
  const r = Payer && ctx.ledger.connected ? await settle(() => Payer.readiness()) : { ok: false, error: 'skipped' };
  if (r.ok) blockers.push(...(r.value.blockers || []));
  else if (r.error !== 'skipped') blockers.push(`payer readiness: ${r.error}`);
  return {
    provider: 'payer-os',
    mode: r.ok && r.value.ready ? 'live' : 'shadow',
    liveFlags: { NACHA_ODFI_ROUTING: Boolean(env.NACHA_ODFI_ROUTING), PAYER_OS_PAYEES: Boolean(env.PAYER_OS_PAYEES), PAYER_OS_FUNDING_SOURCE: env.PAYER_OS_FUNDING_SOURCE || null },
    modules: r.ok ? { fundingSource: r.value.fundingSource, payees: (r.value.payees || []).length, achChannel: r.value.achChannel, odfi: r.value.odfi, warnings: r.value.warnings } : { error: r.error },
    routes: ['/api/payer/{,payees,disbursements,plan}', '/api/payer/disbursements/:id/{approve,send}', '/api/os/readiness/payer'],
    secrets: ['NACHA_ODFI_ROUTING', 'PAYER_OS_PAYEES', 'ADMIN_SECRET_TOKEN'],
    tables,
    blockers,
  };
}

async function thirdPartySenderReadiness(ctx) {
  const Tps = tryRequire('./thirdPartySenderOsEngine')?.TpsOsEngine;
  const tables = await tablesPresent(TABLES['third-party-sender']);
  const blockers = baseBlockers(ctx, tables, Tps, 'TpsOsEngine');
  const s = Tps && ctx.ledger.connected ? await settle(() => Tps.status()) : { ok: false, error: 'skipped' };
  if (s.ok) blockers.push(...(s.value.readiness?.blockers || []));
  else if (s.error !== 'skipped') blockers.push(`tps status: ${s.error}`);
  return {
    provider: 'third-party-sender-os',
    mode: s.ok && s.value.readiness?.ready ? 'live' : 'shadow',
    liveFlags: { TPS_ENFORCED: s.ok ? s.value.enforced : null },
    modules: s.ok ? { role: s.value.role, agreements: { total: s.value.agreements.total, executed: s.value.agreements.executed }, originators: { total: s.value.originators.total, approved: s.value.originators.approved }, obligations: { open: s.value.obligations.open, overdue: s.value.obligations.overdue } } : { error: s.error },
    routes: ['/api/tps-os/{status,agreements,originators,obligations}', '/api/os/readiness/third-party-sender'],
    secrets: ['ADMIN_SECRET_TOKEN'],
    tables,
    blockers,
  };
}

async function m2mReadiness(ctx) {
  const M2m = tryRequire('./m2mOsEngine')?.M2mOsEngine;
  const tables = await tablesPresent(TABLES.m2m);
  const blockers = baseBlockers(ctx, tables, M2m, 'M2mOsEngine');
  const s = M2m && ctx.ledger.connected && !missingTables(tables).length ? await settle(() => M2m.status()) : { ok: false, error: 'skipped' };
  let activePartners = 0;
  if (s.ok) {
    activePartners = (s.value.partners || []).filter((p) => p.status === 'active').length;
    if (!s.value.identities.active) blockers.push('no active machine identity (POST /api/m2m-os/identities)');
    if (!activePartners) blockers.push('no active bank partner channel: no ODFI/bank has an M2M endpoint registered (Betterment offers none)');
  } else if (s.error !== 'skipped') blockers.push(`m2m status: ${s.error}`);
  return {
    provider: 'm2m-os',
    mode: activePartners > 0 ? 'live' : 'shadow',
    liveFlags: { M2M_CYCLE_INTERVAL_MS: s.ok ? s.value.scheduler.intervalMs : null, SCHEDULER_RUNNING: s.ok ? s.value.scheduler.running : null },
    modules: s.ok ? { identities: s.value.identities, partners: (s.value.partners || []).map((p) => ({ partnerId: p.partnerId, bankName: p.bankName, status: p.status, lastHandshakeAt: p.lastHandshakeAt })), policy: s.value.policy } : { error: s.error },
    jobs: ['m2m key-rotation/handshake cycle (in-process, M2M_CYCLE_INTERVAL_MS)'],
    routes: ['/api/m2m-os/{status,identities,partners}', '/api/os/readiness/m2m'],
    secrets: ['machine identity private keys (m2m_identities, encrypted at rest)'],
    tables,
    blockers,
  };
}

async function clearingNettingReadiness(ctx) {
  const mod = tryRequire('./clearingNettingEngine');
  const instance = mod?.ClearingNettingEngine || null;
  const tables = await tablesPresent(TABLES['clearing-netting']);
  const blockers = baseBlockers(ctx, tables, instance, 'ClearingNettingEngine');
  const [funding, runbook] = await Promise.all([
    instance && ctx.ledger.connected ? settle(() => instance.funding()) : { ok: false, error: 'skipped' },
    instance && ctx.ledger.connected ? settle(() => instance.runbook({ limit: 20 })) : { ok: false, error: 'skipped' },
  ]);
  if (funding.ok) blockers.push(...(funding.value.blockers || []));
  else if (funding.error !== 'skipped') blockers.push(`clearing funding: ${funding.error}`);
  if (runbook.ok) blockers.push(...(runbook.value.breaks || []).map((b) => `clearing break: ${typeof b === 'string' ? b : JSON.stringify(b)}`));
  return {
    provider: 'clearing-netting-os',
    mode: funding.ok && !(funding.value.blockers || []).length ? 'live' : 'shadow',
    liveFlags: {},
    modules: { funding: funding.ok ? funding.value : { error: funding.error }, runbook: runbook.ok ? runbook.value : { error: runbook.error } },
    routes: ['/api/wealth-os/clearing/{candidates,funding,runbook,cycles}', '/api/os/readiness/clearing-netting'],
    secrets: ['ADMIN_SECRET_TOKEN'],
    tables,
    blockers,
  };
}

async function wealthBackOfficeReadiness(ctx) {
  const mod = tryRequire('./wealthBackOfficeEngine');
  const Engine = mod?.WealthBackOfficeEngine || null;
  const tables = await tablesPresent(TABLES['wealth-back-office']);
  const blockers = baseBlockers(ctx, tables, Engine, 'WealthBackOfficeEngine');
  const r = Engine && ctx.ledger.connected ? await settle(() => Engine.readiness()) : { ok: false, error: 'skipped' };
  if (r.ok) blockers.push(...(r.value.blockers || []), ...(r.value.warnings || []));
  else if (r.error !== 'skipped') blockers.push(`wealth back office readiness: ${r.error}`);
  return {
    provider: 'wealth-back-office-os',
    mode: r.ok && r.value.ready ? 'live' : 'shadow',
    liveFlags: { CAN_PUSH_CREDITS: r.ok ? r.value.canPushCredits : null },
    modules: r.ok ? { desks: (r.value.desks || []).map((d) => ({ desk: d.desk, readable: d.readable })), payerOs: r.value.payerOs, schema: r.value.schema } : { error: r.error },
    routes: ['/api/wealth-os/{,desks,desks/:desk,book-of-record,init}', '/api/os/readiness/wealth-back-office'],
    secrets: ['ADMIN_SECRET_TOKEN'],
    tables,
    blockers,
  };
}

async function backOfficeReadiness(ctx, env = process.env) {
  const Engine = tryRequire('./osEngine')?.BackOfficeEngine || null;
  const tables = await tablesPresent(TABLES['back-office']);
  const blockers = baseBlockers(ctx, tables, Engine, 'BackOfficeEngine');
  const s = Engine && ctx.ledger.connected ? await settle(() => Engine.status()) : { ok: false, error: 'skipped' };
  if (!s.ok && s.error !== 'skipped') blockers.push(`back office status: ${s.error}`);
  const integrations = s.ok ? s.value.integrations || {} : {};
  for (const dep of ['trustAccounting', 'cash', 'bond', 'bankSync']) {
    if (s.ok && !integrations[dep]) blockers.push(`back office dependency ${dep} not loadable`);
  }
  if (!env.FINERACT_URL) blockers.push('FINERACT_URL unset: back office treasury summary cannot read the core-banking account of record');
  const dappExecutorLive = isTrue(env.BACK_OFFICE_LIVE);
  if (dappExecutorLive) blockers.push('BACK_OFFICE_LIVE=true: the back-office executeDistribution path settles through the dapp/thirdweb rail (retired); distributions go through the Private Payment Network (Fineract withdraw before dispatch)');
  return {
    provider: 'back-office-os',
    mode: blockers.length === 0 ? 'live' : 'shadow',
    liveFlags: { BACK_OFFICE_LIVE: dappExecutorLive, DAPP_DISTRIBUTION_EXECUTOR: 'retired', DISTRIBUTION_RAIL: 'private-payment-network', ASSET_SALES: false },
    modules: s.ok ? { integrations, distributionCount: s.value.distributionCount, actions: ['treasurySummary', 'bankReconciliation', 'listDistributions', 'getDistribution', 'batchProcess'] } : { error: s.error },
    routes: ['/api/os/back-office/{status,readiness,health,list,process}', '/api/os/readiness/back-office'],
    jobs: ['none: on-demand; batches persisted to back_office_batches'],
    secrets: ['ADMIN_SECRET_TOKEN', 'FINERACT_URL'],
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

async function h2hDiscoveryReadiness(ctx, env = process.env) {
  const H2h = tryRequire('./h2hDiscoveryOsEngine')?.H2hDiscoveryOsEngine;
  const tables = await tablesPresent(TABLES['h2h-discovery']);
  const blockers = baseBlockers(ctx, tables, H2h, 'H2hDiscoveryOsEngine');
  const r = H2h && ctx.ledger.connected && !missingTables(tables).length ? await settle(() => H2h.readiness()) : { ok: false, error: 'skipped' };
  if (r.ok) blockers.push(...r.value.blockers);
  else if (r.error !== 'skipped') blockers.push(`h2h-discovery: ${r.error}`);
  const s = r.ok ? r.value.status : null;
  return {
    provider: 'h2h-discovery (https scrape, allow-listed hosts)',
    mode: r.ok ? r.value.mode : 'shadow',
    liveFlags: {
      H2H_DISCOVERY_ENABLED: String(env.H2H_DISCOVERY_ENABLED || 'true').toLowerCase() !== 'false',
      H2H_DISCOVERY_ALLOWED_HOSTS: s ? s.allowedHosts.length : 0,
      H2H_DISCOVERY_REQUIRE_DISTINCT_APPLIER: s ? s.policy.requireDistinctApplier : true,
    },
    modules: s ? { sources: s.sources, candidates: s.candidates, appliedBanks: s.appliedBanks, fields: s.fields, policy: s.policy } : { error: r.error },
    routes: ['/api/os/h2h-discovery/{status,readiness,list,process}', '/api/os/readiness/h2h-discovery'],
    secrets: ['none — scraped credentials are refused; partner secrets stay in Secret Manager and are referenced by name'],
    tables,
    blockers,
  };
}

async function privateAccessReadiness(ctx, env = process.env) {
  const Guard = tryRequire('../auth/privateAccessGuard');
  const Ppn = tryRequire('./privatePaymentNetworkOsEngine')?.PrivatePaymentNetworkOsEngine;
  const blockers = [];
  if (!Guard) blockers.push('privateAccessGuard not loadable');
  const g = Guard ? Guard.status(env) : null;
  const ppnCfg = Ppn ? Ppn.getConfig(env) : null;
  const ingress = String(env.PRIVATE_ACCESS_INGRESS || '').trim() || null;
  const iapEnabled = isTrue(env.PRIVATE_ACCESS_IAP_ENABLED);
  const publicInvoker = isTrue(env.PRIVATE_ACCESS_PUBLIC_INVOKER);
  const vpn = {
    configured: isTrue(env.PRIVATE_ACCESS_VPN_ENABLED),
    gateway: String(env.PRIVATE_ACCESS_VPN_GATEWAY || '').trim() || null,
    tunnels: Number(env.PRIVATE_ACCESS_VPN_TUNNELS) || 0,
  };
  if (g) {
    if (g.mode !== 'enforce') blockers.push(`PRIVATE_ACCESS_MODE=${g.mode} (requests without a family IAP assertion are ${g.mode === 'off' ? 'not checked' : 'audited, not refused'})`);
    if (!g.iapAudienceConfigured) blockers.push('PRIVATE_ACCESS_IAP_AUDIENCE not set (/projects/<number>/locations/<region>/services/<service>)');
    if (!g.familyEmails && !g.familyDomains) blockers.push('PRIVATE_ACCESS_FAMILY_EMAILS empty: no family identity is allow-listed');
    const business = g.exemptPaths.filter((p) => !/^\/api\/health/.test(p));
    if (business.length) blockers.push(`PRIVATE_ACCESS_EXEMPT_PATHS exposes non-health routes: ${business.join(', ')}`);
  }
  if (!iapEnabled) blockers.push('PRIVATE_ACCESS_IAP_ENABLED not true (Terraform: iap_enabled on google_cloud_run_v2_service.app)');
  if (publicInvoker) blockers.push('PRIVATE_ACCESS_PUBLIC_INVOKER=true: allUsers still holds roles/run.invoker on the service');
  if (ingress && ingress !== 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER' && ingress !== 'INGRESS_TRAFFIC_ALL') blockers.push(`unexpected ingress ${ingress}`);
  if (!ppnCfg) blockers.push('PrivatePaymentNetworkOsEngine not loadable');
  else if (!ppnCfg.familyOnly) blockers.push('PRIVATE_PAYMENT_NETWORK_FAMILY_ONLY not true (payouts may reach non-family participants)');
  else if (!ppnCfg.excludedProcessors.some((p) => /^stripe/.test(p))) blockers.push('PRIVATE_PAYMENT_NETWORK_EXCLUDED_PROCESSORS does not exclude stripe');
  if (!ctx.gcp.projectMatches) blockers.push(`GCP_PROJECT is ${ctx.gcp.project || 'unset'}, expected ${EXPECTED_PROJECT}`);
  if (!ctx.ledger.connected) blockers.push('ledger database (Cloud SQL / DATABASE_URL) not connected');
  const live = blockers.length === 0;
  return {
    provider: 'cloud-run + identity-aware-proxy (family identities) + cloud-vpn (trusted sites)',
    mode: live ? 'live' : 'shadow',
    liveFlags: {
      PRIVATE_ACCESS_MODE: g ? g.mode : null,
      PRIVATE_ACCESS_IAP_ENABLED: iapEnabled,
      PRIVATE_ACCESS_IAP_AUDIENCE: Boolean(g && g.iapAudienceConfigured),
      PRIVATE_ACCESS_PUBLIC_INVOKER: publicInvoker,
      PRIVATE_ACCESS_INGRESS: ingress,
      PRIVATE_ACCESS_FAMILY_EMAILS: g ? g.familyEmails : 0,
      PRIVATE_ACCESS_FAMILY_DOMAINS: g ? g.familyDomains : 0,
      PRIVATE_ACCESS_VPN_ENABLED: vpn.configured,
      PRIVATE_PAYMENT_NETWORK_FAMILY_ONLY: Boolean(ppnCfg && ppnCfg.familyOnly),
      PRIVATE_PAYMENT_NETWORK_EXCLUDED_PROCESSORS: ppnCfg ? ppnCfg.excludedProcessors : [],
    },
    modules: { guard: g, vpn, ppn: ppnCfg ? { familyOnly: ppnCfg.familyOnly, familyParticipantTypes: ppnCfg.familyParticipantTypes, excludedProcessors: ppnCfg.excludedProcessors } : null },
    routes: ['every route (guard mounted before routers in server-3002.js; /api/health/* exempt)', '/api/os/readiness/private-access'],
    secrets: ['none — IAP signs assertions with Google-held keys; VPN shared secrets live in Secret Manager (Terraform var vpn_shared_secret_secret_id), never in the app'],
    tables: {},
    blockers,
  };
}

async function egressReadiness(ctx, env = process.env) {
  const Egress = tryRequire('./egressOsEngine')?.EgressOsEngine;
  const tables = await tablesPresent(TABLES.egress);
  const blockers = baseBlockers(ctx, tables, Egress, 'EgressOsEngine');
  const r = Egress && ctx.ledger.connected && !missingTables(tables).length ? await settle(() => Egress.readiness()) : { ok: false, error: 'skipped' };
  if (r.ok) blockers.push(...r.value.blockers);
  else if (r.error !== 'skipped') blockers.push(`egress: ${r.error}`);
  const s = r.ok ? r.value.status : null;
  return {
    provider: 'egress (Serverless VPC connector -> Cloud NAT static IP; host allow/deny policy)',
    mode: r.ok ? r.value.mode : 'shadow',
    liveFlags: {
      EGRESS_OS_ENABLED: String(env.EGRESS_OS_ENABLED || 'true').toLowerCase() !== 'false',
      EGRESS_ENFORCE: String(env.EGRESS_ENFORCE || 'false').toLowerCase() === 'true',
      EGRESS_STATIC_IP: Boolean(env.EGRESS_STATIC_IP),
      EGRESS_VPC_CONNECTOR: Boolean(env.EGRESS_VPC_CONNECTOR),
      EGRESS_ALLOWED_HOSTS: s ? s.allowedHosts.length : 0,
      EGRESS_DENIED_HOSTS: s ? s.deniedHosts.length : 0,
    },
    modules: s ? { path: s.path, audit: s.audit, last24h: s.last24h, lastProbe: s.lastProbe } : { error: r.error },
    routes: ['/api/os/egress/{status,readiness,list,process}', '/api/os/readiness/egress'],
    secrets: ['none — policy is host names only; EGRESS_STATIC_IP is the public NAT address from terraform output egress_ip'],
    tables,
    blockers,
  };
}

async function idpOcrReadiness(ctx, env = process.env) {
  const Idp = tryRequire('./idpOcrOsEngine')?.IdpOcrOsEngine;
  const tables = await tablesPresent(TABLES['idp-ocr']);
  const blockers = baseBlockers(ctx, tables, Idp, 'IdpOcrOsEngine');
  const r = Idp && ctx.ledger.connected && !missingTables(tables).length ? await settle(() => Idp.readiness()) : { ok: false, error: 'skipped' };
  if (r.ok) blockers.push(...r.value.blockers);
  else if (r.error !== 'skipped') blockers.push(`idp-ocr: ${r.error}`);
  const s = r.ok ? r.value.status : null;
  return {
    provider: 'google document-ai (IDP_OCR_PROCESSOR) + private GCS bucket (IDP_OCR_BUCKET); egress via Egress OS',
    mode: r.ok ? r.value.mode : 'shadow',
    liveFlags: {
      IDP_OCR_ENABLED: String(env.IDP_OCR_ENABLED || 'true').toLowerCase() !== 'false',
      IDP_OCR_LIVE: isTrue(env.IDP_OCR_LIVE),
      IDP_OCR_PROCESSOR: Boolean(env.IDP_OCR_PROCESSOR),
      IDP_OCR_BUCKET: Boolean(env.IDP_OCR_BUCKET),
      IDP_OCR_MIN_CONFIDENCE: s ? s.policy.minConfidence : null,
      IDP_OCR_REQUIRE_DISTINCT_APPROVER: s ? s.policy.requireDistinctApprover : true,
      MOVES_MONEY: false,
    },
    modules: s ? { provider: s.provider, storage: s.storage, policy: s.policy, documents: s.documents } : { error: r.error },
    routes: ['/api/os/idp-ocr/{status,readiness,list,process}', '/api/os/readiness/idp-ocr'],
    secrets: ['none — Document AI and GCS use the Cloud Run runtime identity (roles/documentai.apiUser, roles/storage.objectCreator on IDP_OCR_BUCKET); document bytes never enter Cloud SQL, identifiers are redacted to last-4'],
    tables,
    blockers,
  };
}

async function taxOsReadiness(ctx, env = process.env) {
  const Tax = tryRequire('./taxOsEngine')?.TaxOsEngine;
  const tables = await tablesPresent(TABLES['tax-os']);
  const blockers = baseBlockers(ctx, tables, Tax, 'TaxOsEngine');
  const r = Tax && ctx.ledger.connected && !missingTables(tables).length ? await settle(() => Tax.readiness()) : { ok: false, error: 'skipped' };
  if (r.ok) blockers.push(...r.value.blockers);
  else if (r.error !== 'skipped') blockers.push(`tax-os: ${r.error}`);
  const s = r.ok ? r.value.status : null;
  return {
    provider: 'tax-os (TaxEngine Form 1041 / K-1 arithmetic; trust journal GL 3000 / 4000 / 4100 / 2000; Fineract account structure) — reports only',
    mode: r.ok ? r.value.mode : 'shadow',
    liveFlags: {
      TAX_OS_ENABLED: String(env.TAX_OS_ENABLED || 'true').toLowerCase() !== 'false',
      TAX_OS_LIVE: isTrue(env.TAX_OS_LIVE),
      TAX_OS_FILING_MODE: 'reports_only',
      TAX_OS_EXPORT_BUCKET: Boolean(env.TAX_OS_EXPORT_BUCKET),
      TAX_OS_DECLARED_STATE: String(env.TAX_OS_DECLARED_STATE || 'OH'),
      EFILE: false,
      MOVES_MONEY: false,
    },
    modules: s ? { entity: s.entity, returns: s.returns, beneficiaries: s.beneficiaries, fineractAccounts: s.fineractAccounts, exports: s.exports, storage: s.storage, formats: s.formats, reportTypes: s.reportTypes } : { error: r.error },
    routes: ['/api/tax/reports/{form_1041,schedule_k1,principal_income,package}/export', '/api/os/tax-os/{status,readiness,list,process}', '/api/os/readiness/tax-os'],
    secrets: ['none — EIN lives in trust_config; exports archive with the runtime identity when TAX_OS_EXPORT_BUCKET is set'],
    tables,
    blockers,
  };
}

async function privateEntityReadiness(ctx, env = process.env) {
  const Pe = tryRequire('./privateEntityOsEngine')?.PrivateEntityOsEngine;
  const tables = await tablesPresent(TABLES['private-entity']);
  const blockers = baseBlockers(ctx, tables, Pe, 'PrivateEntityOsEngine');
  const r = Pe && ctx.ledger.connected && !missingTables(tables).length ? await settle(() => Pe.readiness()) : { ok: false, error: 'skipped' };
  if (r.ok) blockers.push(...r.value.blockers);
  else if (r.error !== 'skipped') blockers.push(`private-entity: ${r.error}`);
  const s = r.ok ? r.value.status : null;
  return {
    provider: 'private-entity (trustee-declared profile, two-trustee attestation, platform audit against the declaration)',
    mode: r.ok ? r.value.mode : 'shadow',
    liveFlags: {
      PRIVATE_ENTITY_ENABLED: String(env.PRIVATE_ENTITY_ENABLED || 'true').toLowerCase() !== 'false',
      PRIVATE_ENTITY_LIVE: isTrue(env.PRIVATE_ENTITY_LIVE),
      ENTITY_TYPE: 'family_trust_company',
      JURISDICTION: 'US-OH',
      STATUTE_REFERENCE: 'ORC 1111-1112 (declared)',
      FAMILY_SCOPE: 'single_family_multigenerational',
      PUBLIC_ONBOARDING: isTrue(env.PUBLIC_ONBOARDING_ENABLED),
      DEPOSIT_TAKING: isTrue(env.DEPOSIT_TAKING_ENABLED),
      ASSET_SALES: false,
      SETTLEMENT_RAIL: 'private-payment-network',
    },
    modules: s ? { entity: s.entity, profile: s.profile, requiredAttestations: s.requiredAttestations, audit: s.audit, tax: s.tax, legalStatus: s.legalStatus } : { error: r.error },
    routes: ['/api/os/private-entity/{status,readiness,list,process}', '/api/os/readiness/private-entity'],
    secrets: ['none'],
    tables,
    blockers,
  };
}

async function clearingAgentReadiness(ctx, env = process.env) {
  const Ca = tryRequire('./clearingAgentOsEngine')?.ClearingAgentOsEngine;
  const tables = await tablesPresent(TABLES['clearing-agent']);
  const blockers = baseBlockers(ctx, tables, Ca, 'ClearingAgentOsEngine');
  const r = Ca && ctx.ledger.connected && !missingTables(tables).length ? await settle(() => Ca.readiness()) : { ok: false, error: 'skipped' };
  if (r.ok) blockers.push(...r.value.blockers);
  else if (r.error !== 'skipped') blockers.push(`clearing-agent: ${r.error}`);
  const s = r.ok ? r.value.status : null;
  return {
    provider: 'clearing-agent (HMAC challenge/verify handshake, secret refs only, USA-only bank-format conversion, clear -> post to Fineract)',
    mode: r.ok ? r.value.mode : 'shadow',
    liveFlags: {
      CLEARING_AGENT_ENABLED: String(env.CLEARING_AGENT_ENABLED || 'true').toLowerCase() !== 'false',
      CLEARING_AGENT_LIVE: isTrue(env.CLEARING_AGENT_LIVE),
      CLEARING_AGENT_POST_TO_FINERACT: String(env.CLEARING_AGENT_POST_TO_FINERACT || 'true').toLowerCase() !== 'false',
      CLEARING_AGENT_REQUIRE_DISTINCT_VERIFIER: String(env.CLEARING_AGENT_REQUIRE_DISTINCT_VERIFIER || 'true').toLowerCase() !== 'false',
      CLEARING_AGENT_REQUIRE_APPROVAL: String(env.CLEARING_AGENT_REQUIRE_APPROVAL || 'true').toLowerCase() !== 'false',
      PRIVATE_PAYMENT_NETWORK_FAMILY_ONLY: isTrue(env.PRIVATE_PAYMENT_NETWORK_FAMILY_ONLY),
      PRIVATE_PAYMENT_NETWORK_AGENT_BASE_URL: Boolean(env.PRIVATE_PAYMENT_NETWORK_AGENT_BASE_URL),
      PRIVATE_PAYMENT_NETWORK_AGENT_SECRET: Boolean(env.PRIVATE_PAYMENT_NETWORK_AGENT_SECRET),
      FINERACT_URL: Boolean(env.FINERACT_URL),
      COUNTRY: 'US',
      CURRENCY: 'USD',
    },
    modules: s ? { networks: s.networks, formats: s.formats, instructions: s.instructions, coreBanking: s.coreBanking, policy: s.policy, networkEndpoint: s.networkEndpoint } : { error: r.error },
    routes: ['/api/os/clearing-agent/{status,readiness,health,list,get/:id,process}', '/api/os/readiness/clearing-agent', '/api/os/private-payment-network/agent/{handshake,clear}'],
    secrets: ['per-network credential_ref (Secret Manager env reference; value never persisted or returned)', 'PRIVATE_PAYMENT_NETWORK_AGENT_SECRET', 'FINERACT_USERNAME', 'FINERACT_PASSWORD'],
    tables,
    blockers,
  };
}

async function enterpriseOdfiReadiness(ctx, env = process.env) {
  const Eo = tryRequire('./enterpriseOdfiOsEngine')?.EnterpriseOdfiOsEngine;
  const tables = await tablesPresent(TABLES['enterprise-odfi']);
  const blockers = baseBlockers(ctx, tables, Eo, 'EnterpriseOdfiOsEngine');
  const r = Eo && ctx.ledger.connected && !missingTables(tables).length ? await settle(() => Eo.readiness()) : { ok: false, error: 'skipped' };
  if (r.ok) blockers.push(...r.value.blockers);
  else if (r.error !== 'skipped') blockers.push(`enterprise-odfi: ${r.error}`);
  const s = r.ok ? r.value.status : null;
  return {
    provider: 'enterprise-odfi (originator OS: maker/checker profile, agentic advisory planner + deterministic validator, distinct-trustee release via clearing-agent, returns/NOC, exposure reconciliation)',
    mode: r.ok ? r.value.mode : 'shadow',
    liveFlags: {
      ENTERPRISE_ODFI_ENABLED: String(env.ENTERPRISE_ODFI_ENABLED || 'true').toLowerCase() !== 'false',
      ENTERPRISE_ODFI_LIVE: isTrue(env.ENTERPRISE_ODFI_LIVE),
      ENTERPRISE_ODFI_REQUIRE_DISTINCT_RELEASER: String(env.ENTERPRISE_ODFI_REQUIRE_DISTINCT_RELEASER || 'true').toLowerCase() !== 'false',
      ENTERPRISE_ODFI_AI_ENABLED: isTrue(env.ENTERPRISE_ODFI_AI_ENABLED),
      ENTERPRISE_ODFI_AI_PROJECT: Boolean(env.ENTERPRISE_ODFI_AI_PROJECT || env.GOOGLE_CLOUD_PROJECT),
      PAYMENT_DATA_ENCRYPTION_KEY: Boolean(env.PAYMENT_DATA_ENCRYPTION_KEY),
      CLEARING_AGENT_LIVE: isTrue(env.CLEARING_AGENT_LIVE),
      COUNTRY: 'US',
      CURRENCY: 'USD',
    },
    modules: s ? { profile: s.profile, rails: s.rails, planner: s.planner, exposure: s.exposure, storage: s.storage, policy: s.policy } : { error: r.error },
    routes: ['/api/os/enterprise-odfi/{status,readiness,health,list,get/:id,process}', '/api/os/readiness/enterprise-odfi'],
    secrets: ['PAYMENT_DATA_ENCRYPTION_KEY', 'ENTERPRISE_ODFI_SERVICE_ACCOUNT_KEY (optional; runtime SA identity used on Cloud Run)', 'per-network credential_ref via clearing-agent'],
    tables,
    blockers,
  };
}

async function openBankRestApiReadiness(ctx, env = process.env) {
  const OB = tryRequire('./openBankRestApiOsEngine')?.OpenBankRestApiOsEngine;
  const tables = await tablesPresent(TABLES['open-bank-rest-api']);
  const blockers = baseBlockers(ctx, tables, OB, 'OpenBankRestApiOsEngine');
  const r = OB && ctx.ledger.connected && !missingTables(tables).length ? await settle(() => OB.readiness()) : { ok: false, error: 'skipped' };
  if (r.ok) blockers.push(...r.value.blockers);
  else if (r.error !== 'skipped') blockers.push(`open-bank-rest-api: ${r.error}`);
  const s = r.ok ? r.value.status : null;
  return {
    provider: 'open-bank-rest-api + open-banking-tracker',
    mode: r.ok ? r.value.mode : 'shadow',
    liveFlags: {
      OPEN_BANK_API_ENABLED: String(env.OPEN_BANK_API_ENABLED || 'true').toLowerCase() !== 'false',
      OPEN_BANKING_TRACKER_BASE_URL: Boolean(s && s.tracker.base),
      OPEN_BANK_PUBLIC_BASE_URL: Boolean(env.OPEN_BANK_PUBLIC_BASE_URL),
    },
    modules: s ? { bank: s.bank, apiVersion: s.apiVersion, tracker: s.tracker, providers: s.providers, fileDrops: s.fileDrops, policy: s.policy } : { error: r.error },
    routes: ['/api/open-bank/v1/{banks,accounts,providers,file-drops}', '/api/os/open-bank-rest-api/{status,readiness,list,process}', '/api/os/readiness/open-bank-rest-api'],
    secrets: ['none for the directory (public dataset); bank intake credentials stay in Secret Manager, referenced by name on the AS2 partner / MFT channel'],
    tables,
    blockers,
  };
}

module.exports = { EngineWiringReadiness: { readiness, engineReadiness, gcpContext, ledgerStatus, tablesPresent, ENGINE_KEYS, ENGINE_TITLES, TABLES, EXPECTED_PROJECT } };
