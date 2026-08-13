'use strict';
var path = require('path');
var fs = require('fs');

// HD = repo root (httpdocs on production, __dirname/.. locally)
var HD = path.resolve(__dirname, '..');

// Use local express (installed via npm install in HD)
var express = require('express');
var app = express();
var PORT = process.env.PORT || 3002;

// ─── Security Middleware ──────────────────────────────────────────────────────
var security = require(path.join(HD, 'server', 'integrations', 'auth', 'securityMiddleware'));

// Helmet.js security headers (XSS, clickjacking, MIME sniffing, CSP, HSTS)
app.use(security.helmetMiddleware());

// CORS lockdown
app.use(security.corsMiddleware());

// Global rate limiting (200 requests/min per IP)
app.use(security.globalRateLimiter());

// Request logging (slow requests and errors)
app.use(security.requestLogger);

// Body parsing
app.use(express.json({
  limit: '5mb',
  verify: function(req, res, buffer) { req.rawBody = Buffer.from(buffer); },
}));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Input sanitization (null bytes, oversized strings)
app.use(security.sanitizeInput);

// ─── Auth Routes (login, logout, user management) ────────────────────────────
try { app.use('/api/auth', require(path.join(HD, 'server', 'routes', 'auth'))); console.log('[auth] loaded'); } catch(e) { console.warn('[auth]', e.message); }

// V2 wealth management routes REMOVED — treasury system is the only platform now

// Analytics routes
try { app.use('/api/analytics', require(path.join(HD, 'server', 'routes', 'analytics'))); console.log('[analytics] loaded'); } catch(e) { console.warn('[analytics]', e.message); }

// Fineract core banking routes
try { app.use('/api/fineract', require(path.join(HD, 'server', 'routes', 'fineract'))); console.log('[fineract] loaded'); } catch(e) { console.warn('[fineract]', e.message); }

// Fixed Income / Bond routes
try { app.use('/api/bonds', require(path.join(HD, 'server', 'routes', 'bonds'))); console.log('[bonds] loaded'); } catch(e) { console.warn('[bonds]', e.message); }

// Cash Management routes
try { app.use('/api/cash', require(path.join(HD, 'server', 'routes', 'cash'))); console.log('[cash] loaded'); } catch(e) { console.warn('[cash]', e.message); }

// CRM Engine routes
try { app.use('/api/crm', require(path.join(HD, 'server', 'routes', 'crm'))); console.log('[crm] loaded'); } catch(e) { console.warn('[crm]', e.message); }

// Admin Control routes
try { app.use('/api/admin', require(path.join(HD, 'server', 'routes', 'admin'))); console.log('[admin] loaded'); } catch(e) { console.warn('[admin]', e.message); }

// Document Management routes
try { app.use('/api/documents', require(path.join(HD, 'server', 'routes', 'documents'))); console.log('[documents] loaded'); } catch(e) { console.warn('[documents]', e.message); }

// Trust Accounting routes
try { app.use('/api/accounting', require(path.join(HD, 'server', 'routes', 'accounting'))); console.log('[accounting] loaded'); } catch(e) { console.warn('[accounting]', e.message); }

// Payment Hub EE orchestration and canonical payment instructions
app.use('/api/payment-hub', require(path.join(HD, 'server', 'routes', 'paymentHub')));
console.log('[payment-hub] loaded');

// Stablecoin Payment Gateway + Treasury + Magic WaaS + WSO2 API Manager
app.use('/api/stablecoin', require(path.join(HD, 'server', 'routes', 'stablecoin')));
console.log('[stablecoin] loaded');

// DeFi DApp — SAFE multisig, deposits, distributions, disbursements, P2P, white-label
try { app.use('/api/dapp', require(path.join(HD, 'server', 'routes', 'dapp'))); console.log('[dapp] loaded'); } catch(e) { console.warn('[dapp]', e.message); }

// OFX Clearing — statement import and OFX payment origination
try { app.use('/api/ofx', require(path.join(HD, 'server', 'routes', 'ofx'))); console.log('[ofx] loaded'); } catch(e) { console.warn('[ofx]', e.message); }

// ACH Pipeline — NACHA generation + AS2 transmission
try { app.use('/api/ach-pipeline', require(path.join(HD, 'server', 'routes', 'achPipeline'))); console.log('[ach-pipeline] loaded'); } catch(e) { console.warn('[ach-pipeline]', e.message); }

// Wire Transfers — Fedwire origination + dual-approval workflow
try { app.use('/api/wire', require(path.join(HD, 'server', 'routes', 'wire'))); console.log('[wire] loaded'); } catch(e) { console.warn('[wire]', e.message); }

// AS2 Server — open source AS2 messaging (certs, partners, send/receive)
try { app.use('/api/as2', require(path.join(HD, 'server', 'routes', 'as2'))); console.log('[as2] loaded'); } catch(e) { console.warn('[as2]', e.message); }

// Tax Engine — Form 1041 & K-1 generation
try { app.use('/api/tax', require(path.join(HD, 'server', 'routes', 'tax'))); console.log('[tax] loaded'); } catch(e) { console.warn('[tax]', e.message); }

// Banking Aggregator — bi-directional financial data hub (pull/push/webhooks).
// Webhook HMAC verification uses req.rawBody captured by express.json's verify above.
try { app.use('/api/aggregator', require(path.join(HD, 'server', 'routes', 'aggregator'))); console.log('[aggregator] loaded'); } catch(e) { console.warn('[aggregator]', e.message); }

// Backup & System Resilience routes
try { app.use('/api/backup', require(path.join(HD, 'server', 'routes', 'backup'))); console.log('[backup] loaded'); } catch(e) { console.warn('[backup]', e.message); }

// BILL Cash Account integration
try { app.use('/api/bill', require(path.join(HD, 'server', 'routes', 'bill'))); console.log('[bill] loaded'); } catch(e) { console.warn('[bill]', e.message); }

// Sub-Ledger Accounts (per-client accounts within Core Banking)
try { app.use('/api/sub-ledgers', require(path.join(HD, 'server', 'routes', 'subLedger'))); console.log('[sub-ledgers] loaded'); } catch(e) { console.warn('[sub-ledgers]', e.message); }

// Vendor Payments (registry, approval workflow, ACH/Wire/BILL execution)
try { app.use('/api/vendors', require(path.join(HD, 'server', 'routes', 'vendors'))); console.log('[vendors] loaded'); } catch(e) { console.warn('[vendors]', e.message); }

// Electronic Payment & Settlement System
try { app.use('/api/electronic-settlement', require(path.join(HD, 'server', 'routes', 'electronicSettlement'))); console.log('[electronic-settlement] loaded'); } catch(e) { console.warn('[electronic-settlement]', e.message); }

// Apache NiFi Payment File Transfer
try { app.use('/api/nifi', require(path.join(HD, 'server', 'routes', 'nifi'))); console.log('[nifi] loaded'); } catch(e) { console.warn('[nifi]', e.message); }

// HCE (Host Card Emulation) Contactless Payments
try { app.use('/api/hce', require(path.join(HD, 'server', 'routes', 'hce'))); console.log('[hce] loaded'); } catch(e) { console.warn('[hce]', e.message); }

// Trustee Agent & Bookkeeping Agent
try { app.use('/api/agents', require(path.join(HD, 'server', 'routes', 'agents'))); console.log('[agents] loaded'); } catch(e) { console.warn('[agents]', e.message); }

// AI FinOps Agent — natural language commands with human-in-the-loop approvals
try { app.use('/api/finops', require(path.join(HD, 'server', 'routes', 'finops'))); console.log('[finops] loaded'); } catch(e) { console.warn('[finops]', e.message); }

// Private Trust Company command center API
try { app.use('/api/trust-ops', require(path.join(HD, 'server', 'routes', 'trustOps'))); console.log('[trust-ops] loaded'); } catch(e) { console.warn('[trust-ops]', e.message); }

// Transactional & Settlement Server Engine — unified payment gateway + digital/decentralized settlement
try { app.use('/api/transactional-settlement', require(path.join(HD, 'server', 'routes', 'transactionalSettlement'))); console.log('[transactional-settlement] loaded'); } catch(e) { console.warn('[transactional-settlement]', e.message); }

// Rally Protocol — embedded mobile wallet, tap, QR, and gasless payouts
try { app.use('/api/rally', require(path.join(HD, 'server', 'routes', 'rallyProtocol'))); console.log('[rally] loaded'); } catch(e) { console.warn('[rally]', e.message); }

// Treasury Prime — BaaS accounts, balances, book transfers, ACH, wires (decimal-string amounts)
try { app.use('/api/treasury-prime', require(path.join(HD, 'server', 'routes', 'treasuryPrime'))); console.log('[treasury-prime] loaded'); } catch(e) { console.warn('[treasury-prime]', e.message); }

// DeFi dApp — dApp login at /dapp, command center at /dashboard; landing page at root; legacy treasury dashboard at /treasury
function serveDapp(req, res) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(HD, 'public', 'dapp', 'index.html'));
}
function serveLanding(req, res) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(HD, 'public', 'landing', 'index.html'));
}
function serveFinops(req, res) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.redirect('/dashboard');
}
function serveTrustDashboard(req, res) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(HD, 'public', 'dapp', 'trust-dashboard.html'));
}
function serveTrustPortal(req, res) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(HD, 'public', 'trust-portal', 'index.html'));
}
function serveTrustPortalDashboard(req, res) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(HD, 'public', 'trust-portal', 'dashboard.html'));
}
app.get('/', serveLanding);
app.get('/dapp', serveDapp);
app.get('/finops', serveFinops);
app.get('/dashboard', serveTrustDashboard);
app.get('/treasury', function(req, res) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(HD, 'public', 'dashboard.html'));
});
app.get('/trust-portal', serveTrustPortal);
app.get('/trust-portal/dashboard.html', serveTrustPortalDashboard);
app.get('/trust-portal/index.html', serveTrustPortal);
// ─── Health / Data Integrity Endpoint ──────────────────────────────────────
app.get('/api/health', async function(req, res) {
  try {
    var pool = require(path.join(HD, 'server', 'integrations', 'bonds', 'pgPool'));
    var checks = {};

    var [bondRes, cashRes, trustRes, userRes] = await Promise.all([
      pool.query("SELECT COUNT(*) as c, COALESCE(SUM(face_value),0) as total FROM bonds WHERE status = 'active'"),
      pool.query("SELECT COUNT(*) as c FROM cash_accounts WHERE status = 'active'"),
      pool.query("SELECT COUNT(*) as c FROM trust_accounts"),
      pool.query("SELECT COUNT(*) as c FROM auth_users"),
    ]);
    checks.bonds = { ok: bondRes.rows[0].c > 0, count: parseInt(bondRes.rows[0].c), totalValue: Number(bondRes.rows[0].total) };
    checks.cashAccounts = { ok: cashRes.rows[0].c > 0, count: parseInt(cashRes.rows[0].c) };
    checks.trustAccounts = { ok: trustRes.rows[0].c > 0, count: parseInt(trustRes.rows[0].c) };
    checks.authUsers = { ok: userRes.rows[0].c > 0, count: parseInt(userRes.rows[0].c) };
    checks.database = { ok: true };

    var fineractOk = false;
    try {
      var FineractClient = require(path.join(HD, 'server', 'integrations', 'fineract', 'fineractClient')).FineractClient;
      await FineractClient.healthCheck();
      fineractOk = true;
    } catch(e) {}
    checks.fineract = { ok: fineractOk };

    var billOk = false;
    try {
      var billClient = require(path.join(HD, 'server', 'integrations', 'bill', 'billClient'));
      if (billClient.isConfigured()) {
        var billStatus = await billClient.getStatus();
        billOk = billStatus.connected;
        checks.bill = { ok: billOk, configured: true };
      } else {
        checks.bill = { ok: false, configured: false };
      }
    } catch(e) { checks.bill = { ok: false, configured: false, error: e.message }; }

    // Include DB circuit breaker status
    if (pool.getCircuitStatus) {
      checks.dbCircuit = pool.getCircuitStatus();
    }

    var coreOk = checks.bonds.ok && checks.cashAccounts.ok && checks.trustAccounts.ok && checks.authUsers.ok && checks.database.ok;
    res.json({
      status: coreOk ? 'healthy' : 'degraded',
      uptime: process.uptime(),
      startedAt: global.__dlb_startup || new Date().toISOString(),
      checks: checks,
    });
  } catch (e) {
    var pool2 = null;
    try { pool2 = require(path.join(HD, 'server', 'integrations', 'bonds', 'pgPool')); } catch(x) {}
    var circuitInfo = (pool2 && pool2.getCircuitStatus) ? pool2.getCircuitStatus() : null;
    res.status(503).json({ status: 'unhealthy', error: e.message, dbCircuit: circuitInfo });
  }
});

app.use(express.static(path.join(HD, 'public'), {
  etag: false,
  maxAge: 0,
  lastModified: true,
  setHeaders: function(res, filePath) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
  }
}));
app.get('*', function(req, res) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(HD, 'public', 'dapp', 'index.html'));
});

// ─── Sequential Database Initialization ───────────────────────────────────────
// Runs all migrations serially before accepting requests to avoid connection
// storms and partially initialized payment workflows on cold boot.
async function initializeDatabase() {
  var pool = require(path.join(HD, 'server', 'integrations', 'bonds', 'pgPool'));

  // Step 0: Warmup — establish a live connection before running migrations
  var warmupAttempts = 0;
  var MAX_WARMUP = 5;
  while (warmupAttempts < MAX_WARMUP) {
    try {
      await pool.query('SELECT 1');
      console.log('[startup] Database connection warm (' + (warmupAttempts + 1) + '/' + MAX_WARMUP + ' attempts)');
      break;
    } catch (e) {
      warmupAttempts++;
      if (warmupAttempts >= MAX_WARMUP) {
        console.error('[startup] Database warmup failed after ' + MAX_WARMUP + ' attempts:', e.message);
        throw e;
      }
      console.warn('[startup] Warmup attempt ' + warmupAttempts + ' failed: ' + e.message + ' — retrying in 2s');
      await new Promise(function(r) { setTimeout(r, 2000); });
    }
  }

  // Step 1: Core tables (auth, wire, agents)
  try {
    var UserAuth = require(path.join(HD, 'server', 'integrations', 'auth', 'userAuth')).UserAuth;
    await UserAuth.ensureTables();
    console.log('[auth] tables ensured');
  } catch(e) { console.warn('[auth] table init:', e.message); }

  try {
    var WireEngine = require(path.join(HD, 'server', 'integrations', 'wire', 'wireEngine')).WireEngine;
    await WireEngine.ensureTables();
    console.log('[wire] tables ensured');
  } catch(e) { console.warn('[wire] table init:', e.message); }

  try {
    var WireOriginationEngine = require(path.join(HD, 'server', 'integrations', 'dapp', 'wireOriginationEngine')).WireOriginationEngine;
    await WireOriginationEngine.ensureTables();
    console.log('[wire-origination] tables ensured');
  } catch(e) { console.warn('[wire-origination] table init:', e.message); }

  try {
    var ElectronicMoneyEngine = require(path.join(HD, 'server', 'integrations', 'dapp', 'electronicMoneyEngine')).ElectronicMoneyEngine;
    await ElectronicMoneyEngine.ensureTables();
    console.log('[electronic-money] tables ensured');
  } catch(e) { console.warn('[electronic-money] table init:', e.message); }

  try {
    var OpenBankingEngine = require(path.join(HD, 'server', 'integrations', 'dapp', 'openBankingEngine')).OpenBankingEngine;
    await OpenBankingEngine.ensureTables();
    console.log('[open-banking] tables ensured');
  } catch(e) { console.warn('[open-banking] table init:', e.message); }

  try {
    var TrustDepositEngine = require(path.join(HD, 'server', 'integrations', 'dapp', 'trustDepositEngine')).TrustDepositEngine;
    await TrustDepositEngine.ensureTables();
    console.log('[trust-deposit] tables ensured');
  } catch(e) { console.warn('[trust-deposit] table init:', e.message); }

  try {
    var FineractPayoutBridge = require(path.join(HD, 'server', 'integrations', 'fineract', 'fineractPayoutBridge')).FineractPayoutBridge;
    await FineractPayoutBridge.ensureTables();
    console.log('[fineract-payout] tables ensured');
  } catch(e) { console.warn('[fineract-payout] table init:', e.message); }

  try {
    var SkrillLinkEngine = require(path.join(HD, 'server', 'integrations', 'payments', 'skrillLinkEngine')).SkrillLinkEngine;
    await SkrillLinkEngine.ensureTables();
    console.log('[skrill-link] tables ensured');
  } catch(e) { console.warn('[skrill-link] table init:', e.message); }

  try {
    var BarcodeDepositEngine = require(path.join(HD, 'server', 'integrations', 'payments', 'barcodeDepositEngine')).BarcodeDepositEngine;
    await BarcodeDepositEngine.ensureTables();
    console.log('[barcode-deposit] tables ensured');
  } catch(e) { console.warn('[barcode-deposit] table init:', e.message); }

  try {
    var WebPaymentRailEngine = require(path.join(HD, 'server', 'integrations', 'payments', 'webPaymentRailEngine')).WebPaymentRailEngine;
    await WebPaymentRailEngine.ensureTables();
    console.log('[web-payment-rail] tables ensured');
  } catch(e) { console.warn('[web-payment-rail] table init:', e.message); }

  try {
    var LiliBankEngine = require(path.join(HD, 'server', 'integrations', 'payments', 'liliBankEngine')).LiliBankEngine;
    await LiliBankEngine.ensureTables();
    console.log('[lili-bank] tables ensured');
  } catch(e) { console.warn('[lili-bank] table init:', e.message); }

  try {
    var LiliMcpEngine = require(path.join(HD, 'server', 'integrations', 'payments', 'liliMcpEngine')).LiliMcpEngine;
    await LiliMcpEngine.ensureTables();
    console.log('[lili-mcp] tables ensured');
  } catch(e) { console.warn('[lili-mcp] table init:', e.message); }

  try {
    var IssuerEngine = require(path.join(HD, 'server', 'integrations', 'dapp', 'issuerEngine')).IssuerEngine;
    await IssuerEngine.ensureTables();
    console.log('[issuer] tables ensured');
  } catch(e) { console.warn('[issuer] table init:', e.message); }

  try {
    var BankTransferEngine = require(path.join(HD, 'server', 'integrations', 'dapp', 'bankTransferEngine')).BankTransferEngine;
    await BankTransferEngine.ensureTables();
    console.log('[bank-transfer] tables ensured');
  } catch(e) { console.warn('[bank-transfer] table init:', e.message); }

  try {
    var VendorPaymentEngine = require(path.join(HD, 'server', 'integrations', 'dapp', 'vendorPaymentEngine')).VendorPaymentEngine;
    await VendorPaymentEngine.ensureTables();
    console.log('[vendor-payments] tables ensured');
  } catch(e) { console.warn('[vendor-payments] table init:', e.message); }

  try {
    var TrustBankEngine = require(path.join(HD, 'server', 'integrations', 'dapp', 'trustBankEngine')).TrustBankEngine;
    await TrustBankEngine.ensureTables();
    console.log('[trust-bank] tables ensured');
  } catch(e) { console.warn('[trust-bank] table init:', e.message); }

  try {
    var WealthManagementEngine = require(path.join(HD, 'server', 'integrations', 'dapp', 'wealthManagementEngine')).WealthManagementEngine;
    await WealthManagementEngine.ensureTables();
    console.log('[wealth-management] tables ensured');
  } catch(e) { console.warn('[wealth-management] table init:', e.message); }

  try {
    var TrustAggregatorEngine = require(path.join(HD, 'server', 'integrations', 'dapp', 'trustAggregatorEngine')).TrustAggregatorEngine;
    await TrustAggregatorEngine.ensureTables();
    console.log('[trust-aggregator] tables ensured');
  } catch(e) { console.warn('[trust-aggregator] table init:', e.message); }

  try {
    var ExternalEndpointEngine = require(path.join(HD, 'server', 'integrations', 'dapp', 'externalEndpointEngine')).ExternalEndpointEngine;
    await ExternalEndpointEngine.ensureTables();
    console.log('[external-endpoint] tables ensured');
  } catch(e) { console.warn('[external-endpoint] table init:', e.message); }

  try {
    var PaymentIdEngine = require(path.join(HD, 'server', 'integrations', 'dapp', 'paymentIdEngine')).PaymentIdEngine;
    await PaymentIdEngine.ensureTables();
    console.log('[payment-id] tables ensured');
  } catch(e) { console.warn('[payment-id] table init:', e.message); }

  try {
    var LiveFinTechEndpointEngine = require(path.join(HD, 'server', 'integrations', 'dapp', 'liveFintechEndpointEngine')).LiveFinTechEndpointEngine;
    await LiveFinTechEndpointEngine.ensureTables();
    console.log('[live-fintech] tables ensured');
  } catch(e) { console.warn('[live-fintech] table init:', e.message); }

  try {
    var CorporateTreasuryEngine = require(path.join(HD, 'server', 'integrations', 'finops', 'corporateTreasuryEngine')).CorporateTreasuryEngine;
    await CorporateTreasuryEngine.ensureTables();
    console.log('[corporate-treasury] tables ensured');
  } catch(e) { console.warn('[corporate-treasury] table init:', e.message); }

  try {
    var HostToHostEngine = require(path.join(HD, 'server', 'integrations', 'dapp', 'hostToHostEngine')).HostToHostEngine;
    await HostToHostEngine.ensureTables();
    console.log('[host-to-host] tables ensured');
  } catch(e) { console.warn('[host-to-host] table init:', e.message); }

  try {
    var LiveMoneyMovementEngine = require(path.join(HD, 'server', 'integrations', 'dapp', 'liveMoneyMovementEngine')).LiveMoneyMovementEngine;
    await LiveMoneyMovementEngine.ensureTables();
    console.log('[live-money] tables ensured');
  } catch(e) { console.warn('[live-money] table init:', e.message); }

  try {
    var SettlementEngine = require(path.join(HD, 'server', 'integrations', 'dapp', 'settlementEngine')).SettlementEngine;
    await SettlementEngine.ensureTables();
    console.log('[settlement] tables ensured');
  } catch(e) { console.warn('[settlement] table init:', e.message); }

  try {
    var DepositAndSettlementEngine = require(path.join(HD, 'server', 'integrations', 'payments', 'depositAndSettlementEngine')).DepositAndSettlementEngine;
    await DepositAndSettlementEngine.ensureTables();
    console.log('[deposit-settlement] tables ensured');
  } catch(e) { console.warn('[deposit-settlement] table init:', e.message); }

  try {
    var ClearingApiEngine = require(path.join(HD, 'server', 'integrations', 'payments', 'clearingApiEngine')).ClearingApiEngine;
    await ClearingApiEngine.ensureTables();
    console.log('[clearing-api] tables ensured');
  } catch(e) { console.warn('[clearing-api] table init:', e.message); }

  try {
    var PaymentProcessorServerEngine = require(path.join(HD, 'server', 'integrations', 'payments', 'paymentProcessorServerEngine')).PaymentProcessorServerEngine;
    await PaymentProcessorServerEngine.ensureTables();
    console.log('[payment-processor] tables ensured');
  } catch(e) { console.warn('[payment-processor] table init:', e.message); }

  try {
    var PaymentGatewayServerEngine = require(path.join(HD, 'server', 'integrations', 'payments', 'paymentGatewayServerEngine')).PaymentGatewayServerEngine;
    await PaymentGatewayServerEngine.ensureTables();
    console.log('[payment-gateway] tables ensured');
  } catch(e) { console.warn('[payment-gateway] table init:', e.message); }

  try {
    var ComplianceEngine = require(path.join(HD, 'server', 'integrations', 'compliance', 'complianceEngine')).ComplianceEngine;
    await ComplianceEngine.ensureTables();
    console.log('[compliance] tables ensured');
  } catch(e) { console.warn('[compliance] table init:', e.message); }

  try {
    var TrusteeAgent = require(path.join(HD, 'server', 'integrations', 'agents', 'trusteeAgent')).TrusteeAgent;
    var BookkeepingAgent = require(path.join(HD, 'server', 'integrations', 'agents', 'bookkeepingAgent')).BookkeepingAgent;
    await TrusteeAgent.ensureTables();
    await BookkeepingAgent.ensureTables();
    console.log('[agents] tables ensured (trustee + bookkeeping)');
  } catch(e) { console.warn('[agents] table init:', e.message); }

  try {
    var PaymentHubEngine = require(path.join(HD, 'server', 'integrations', 'paymentHub', 'paymentHubEngine')).PaymentHubEngine;
    await PaymentHubEngine.ensureTables();
    console.log('[payment-hub] tables ensured');
  } catch(e) {
    console.error('[payment-hub] table init failed:', e.message);
    throw e;
  }

  // Stablecoin Payment Gateway + Treasury tables
  try {
    var StablecoinGateway = require(path.join(HD, 'server', 'integrations', 'stablecoin', 'stablecoinGateway')).StablecoinGateway;
    await StablecoinGateway.ensureTables();
    console.log('[stablecoin] tables ensured');
  } catch(e) {
    console.warn('[stablecoin] table init:', e.message);
  }

  // DeFi DApp tables
  try {
    var DappEngine = require(path.join(HD, 'server', 'integrations', 'dapp', 'dappEngine')).DappEngine;
    await DappEngine.ensureTables();
    console.log('[dapp] tables ensured');
    await DappEngine.ensurePortalUsers();
    console.log('[dapp] portal users seeded');
    var PtcPortalEngine = require(path.join(HD, 'server', 'integrations', 'dapp', 'ptcPortalEngine')).PtcPortalEngine;
    await PtcPortalEngine.ensureMembers();
    console.log('[ptc] members seeded');
    var WalletEngine = require(path.join(HD, 'server', 'integrations', 'dapp', 'walletEngine')).WalletEngine;
    await WalletEngine.ensureTables();
    await WalletEngine.ensureWalletsForAllUsers();
    console.log('[dapp] wallets ensured');
  } catch(e) {
    console.warn('[dapp] table init:', e.message);
  }

  // Operator Gas Tank tables
  try {
    var OperatorGasTank = require(path.join(HD, 'server', 'integrations', 'dapp', 'operatorGasTank')).OperatorGasTank;
    await OperatorGasTank.ensureTables();
    console.log('[operator-gas-tank] tables ensured');
  } catch(e) { console.warn('[operator-gas-tank] table init:', e.message); }

  // FinOps AI Agent, Calendar, and Messaging tables
  try {
    var FinOpsAgent = require(path.join(HD, 'server', 'integrations', 'agents', 'finOpsAgent')).FinOpsAgent;
    await FinOpsAgent.ensureTables();
    console.log('[finops-agent] tables ensured');
  } catch(e) { console.warn('[finops-agent] table init:', e.message); }
  try {
    var FinanceOperatingServerEngine = require(path.join(HD, 'server', 'integrations', 'finops', 'financeOperatingServerEngine')).FinanceOperatingServerEngine;
    await FinanceOperatingServerEngine.ensureTables();
    console.log('[finance-operating] tables ensured');
  } catch(e) { console.warn('[finance-operating] table init:', e.message); }
  try {
    var CalendarEngine = require(path.join(HD, 'server', 'integrations', 'calendar', 'calendarEngine')).CalendarEngine;
    await CalendarEngine.ensureTables();
    console.log('[calendar] tables ensured');
  } catch(e) { console.warn('[calendar] table init:', e.message); }
  try {
    var MessagingEngine = require(path.join(HD, 'server', 'integrations', 'messaging', 'messagingEngine')).MessagingEngine;
    await MessagingEngine.ensureTables();
    console.log('[messaging] tables ensured');
  } catch(e) { console.warn('[messaging] table init:', e.message); }

  // Electronic Settlement tables
  try {
    var esEngine = require(path.join(HD, 'server', 'integrations', 'payments', 'electronicSettlementEngine'));
    await esEngine.ensureTables();
    console.log('[electronic-settlement] tables ensured');
  } catch(e) {
    console.error('[electronic-settlement] table init failed:', e.message);
    throw e;
  }

  // Step 2: Data infrastructure (DataBridge, system settings, bonds metadata)
  try {
    var DataBridge = require(path.join(HD, 'server', 'integrations', 'accounting', 'dataBridge')).DataBridge;
    await DataBridge.ensureTables();
    console.log('[data-bridge] tables ensured');
  } catch(e) { console.warn('[data-bridge] table init:', e.message); }

  try {
    var SystemSettings = require(path.join(HD, 'server', 'integrations', 'ach', 'systemSettings')).SystemSettings;
    await SystemSettings.ensureTable();
    var mode = await SystemSettings.getMode();
    console.log('[system-settings] table ensured, mode=' + mode);
  } catch(e) { console.warn('[system-settings] init:', e.message); }

  try {
    await pool.query(`
      ALTER TABLE bonds ADD COLUMN IF NOT EXISTS bond_identifier TEXT;
      ALTER TABLE bonds ADD COLUMN IF NOT EXISTS bond_type TEXT DEFAULT 'corporate';
      ALTER TABLE bonds ADD COLUMN IF NOT EXISTS tax_exempt BOOLEAN DEFAULT FALSE;
      ALTER TABLE bonds ADD COLUMN IF NOT EXISTS tax_exempt_type TEXT;
      ALTER TABLE bonds ADD COLUMN IF NOT EXISTS placement_type TEXT DEFAULT 'public';
      ALTER TABLE bonds ADD COLUMN IF NOT EXISTS issuer TEXT;
      ALTER TABLE bonds ADD COLUMN IF NOT EXISTS issuer_state TEXT;
    `);
    await pool.query(`
      UPDATE bonds SET
        bond_identifier = '19781443-DLB-PRB',
        bond_type = 'municipal',
        tax_exempt = TRUE,
        tax_exempt_type = 'interest',
        placement_type = 'private',
        issuer = 'DeAndrea Lavar Barkley Trust',
        issuer_state = 'CA'
      WHERE bond_name = 'DLB-PRB' AND bond_identifier IS NULL
    `);
    console.log('[bonds] metadata columns ensured (identifier, type, tax status)');
  } catch(e) { console.warn('[bonds] metadata migration:', e.message); }

  // Step 3: Module tables (sub-ledgers, vendors, BILL sync, CRM)
  try {
    var SubLedgerEngine = require(path.join(HD, 'server', 'integrations', 'accounting', 'subLedgerEngine')).SubLedgerEngine;
    await SubLedgerEngine.ensureTables();
    console.log('[sub-ledgers] tables ensured');
  } catch(e) { console.warn('[sub-ledgers] init:', e.message); }

  try {
    var VendorEngine = require(path.join(HD, 'server', 'integrations', 'vendors', 'vendorEngine')).VendorEngine;
    await VendorEngine.ensureTables();
    console.log('[vendors] tables ensured');
  } catch(e) { console.warn('[vendors] init:', e.message); }

  try {
    var BillSyncEngine = require(path.join(HD, 'server', 'integrations', 'bill', 'billSyncEngine')).BillSyncEngine;
    await BillSyncEngine.ensureTables();
    console.log('[bill-sync] tables ensured');
    var billClientCheck = require(path.join(HD, 'server', 'integrations', 'bill', 'billClient'));
    if (billClientCheck.isConfigured()) {
      BillSyncEngine.startAutoSync(5 * 60 * 1000);
    }
  } catch(e) { console.warn('[bill-sync] init:', e.message); }

  try {
    await pool.query(`
      ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'pending_approval';
      ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS approved_by TEXT;
      ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
      ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS rejected_by TEXT;
      ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
    `);
    console.log('[crm] approval workflow columns ensured');
  } catch(e) { console.warn('[crm] approval migration:', e.message); }

  // Step 4: Schedulers (bond accrual, coupon service)
  try {
    var LiveBondEngine = require(path.join(HD, 'server', 'integrations', 'bonds', 'liveEngine')).LiveBondEngine;
    LiveBondEngine.scheduleAccrualJob();
    console.log('[liveEngine] daily accrual scheduler started');
  } catch(e) { console.warn('[liveEngine]', e.message); }

  try {
    var CouponService = require(path.join(HD, 'server', 'integrations', 'bonds', 'couponService')).CouponService;
    await CouponService.ensureTable();
    console.log('[couponService] coupon_payments table ensured');
    var seedResult = await CouponService.seedBondholders();
    if (seedResult.seeded) console.log('[couponService] Seeded ' + seedResult.count + ' bondholder(s)');
    CouponService.scheduleCouponJob();
  } catch(e) { console.warn('[couponService] init:', e.message); }

  console.log('[startup] All database migrations complete');
}

// ─── Graceful Shutdown & Backup Initialization ─────────────────────────────
try {
  var gracefulShutdown = require(path.join(HD, 'server', 'integrations', 'backup', 'gracefulShutdown'));
  gracefulShutdown.install();
} catch(e) { console.warn('[graceful-shutdown]', e.message); }

initializeDatabase().then(function() {
  var server = app.listen(PORT, '0.0.0.0', function() {
  console.log('[dlbtrust-treasury] running on port ' + PORT);

  // Register server for graceful shutdown
  try { gracefulShutdown.registerServer(server); } catch(e) {}

  // Start scheduled backups (every 6 hours)
  try {
    var backupEngine = require(path.join(HD, 'server', 'integrations', 'backup', 'backupEngine'));
    backupEngine.startScheduledBackups();
  } catch(e) { console.warn('[backup-scheduler]', e.message); }

  // Start banking-aggregator auto-sync (hands-off pull + GL posting)
  try {
    var aggregatorScheduler = require(path.join(HD, 'server', 'integrations', 'aggregator', 'aggregatorScheduler'));
    aggregatorScheduler.start();
  } catch(e) { console.warn('[aggregator-scheduler]', e.message); }

  // Start trust cash sweep (hands-off fixed-income cash → Eaton Trust Checking).
  // OFF unless TRUST_SWEEP_ENABLED=true, since it moves money without a human.
  try {
    var trustSweepScheduler = require(path.join(HD, 'server', 'integrations', 'payments', 'trustSweepScheduler'));
    trustSweepScheduler.start();
  } catch(e) { console.warn('[trust-sweep]', e.message); }

  // Master wallet gas seeding — runs in the background so it cannot block the HTTP port binding.
  setImmediate(function() {
    try {
      var MasterWalletEngine = require(path.join(HD, 'server', 'integrations', 'dapp', 'masterWalletEngine')).MasterWalletEngine;
      MasterWalletEngine.ensureMasterWallets().then(function() {
        console.log('[dapp] master wallets ensured');
      }).catch(function(err) {
        console.warn('[dapp] master wallet seeding failed:', err.message);
      });
    } catch(e) { console.warn('[dapp] master wallet seeding setup:', e.message); }
  });

  // Operator Gas Tank auto-check (converts source-ledger USD to operator ETH when low).
  // OFF unless OPERATOR_GAS_TANK_AUTO_CHECK=true to avoid unintended source-ledger reservations.
  try {
    if (process.env.OPERATOR_GAS_TANK_AUTO_CHECK === 'true') {
      var OperatorGasTank = require(path.join(HD, 'server', 'integrations', 'dapp', 'operatorGasTank')).OperatorGasTank;
      var checkIntervalMs = parseInt(process.env.OPERATOR_GAS_TANK_CHECK_INTERVAL_MS || '300000', 10);
      setInterval(function() {
        OperatorGasTank.checkAndTopUp().then(function(result) {
          console.log('[operator-gas-tank] auto-check:', result.status);
        }).catch(function(err) {
          console.warn('[operator-gas-tank] auto-check failed:', err.message);
        });
      }, checkIntervalMs);
      console.log('[operator-gas-tank] auto-check scheduled every ' + checkIntervalMs + 'ms');
    }
  } catch(e) { console.warn('[operator-gas-tank] scheduler:', e.message); }

  // Record server start in transaction journal
  try {
    var journal = require(path.join(HD, 'server', 'integrations', 'backup', 'transactionJournal'));
    journal.record('server_start', { port: PORT, node_version: process.version, pid: process.pid }, 'system');
  } catch(e) {}

  // Auto-seed Fineract GL accounts and post opening balance on startup (with retry)
  async function initFineract(attempt) {
    attempt = attempt || 1;
    var MAX_ATTEMPTS = 5;
    var RETRY_DELAY = 10000; // 10 seconds between retries
    try {
      var FineractClient = require(path.join(HD, 'server', 'integrations', 'fineract', 'fineractClient')).FineractClient;
      var pool = require(path.join(HD, 'server', 'integrations', 'bonds', 'pgPool'));

      // Check Fineract connectivity
      await FineractClient.healthCheck();
      console.log('[fineract-init] Fineract connected — checking GL accounts');

      // Get existing GL accounts
      var existingAccounts = await FineractClient.getGLAccounts();
      var detailAccounts = Array.isArray(existingAccounts)
        ? existingAccounts.filter(function(a) { return a.usage && a.usage.id === 1; })
        : [];

      if (detailAccounts.length >= 15) {
        console.log('[fineract-init] GL accounts already seeded (' + detailAccounts.length + ' detail accounts)');
      } else {
        console.log('[fineract-init] Seeding GL accounts...');
        var TYPE_MAP = { asset: 1, liability: 2, equity: 3, income: 4, expense: 5 };
        var trustAcctsRes = await pool.query('SELECT account_code, account_name, account_type, sub_type FROM trust_accounts ORDER BY account_code');
        var existingCodes = new Set(detailAccounts.map(function(a) { return a.glCode; }));
        var created = 0;

        for (var i = 0; i < trustAcctsRes.rows.length; i++) {
          var acct = trustAcctsRes.rows[i];
          if (existingCodes.has(acct.account_code)) continue;
          var fType = TYPE_MAP[acct.account_type];
          if (!fType) continue;
          try {
            var result = await FineractClient.createGLAccount({
              name: acct.account_name, glCode: acct.account_code,
              type: fType, usage: 1,
              description: 'Trust account: ' + acct.account_name + ' (' + (acct.sub_type || acct.account_type) + ')',
            });
            var fId = result.resourceId || result.id;
            await pool.query(
              "INSERT INTO fineract_gl_mappings (mapping_type, trust_account_code, fineract_gl_id, description) SELECT $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM fineract_gl_mappings WHERE mapping_type = $1 AND trust_account_code = $2)",
              ['trust_journal', acct.account_code, fId, acct.account_name + ' (' + acct.account_type + ')']
            );
            created++;
          } catch (seedErr) {
            console.warn('[fineract-init] skip ' + acct.account_code + ':', seedErr.message);
          }
        }
        console.log('[fineract-init] Created ' + created + ' GL accounts');
      }

      // Check if opening balance journal entry exists
      var journalRes = await FineractClient.getJournalEntries({ limit: 100 });
      var entries = (journalRes && journalRes.pageItems) || [];
      var hasOpeningBalance = entries.some(function(je) {
        return !je.reversed && je.amount === 100000000 && je.comments && je.comments.indexOf('Opening balance') >= 0;
      });

      if (hasOpeningBalance) {
        console.log('[fineract-init] Opening balance already posted');
      } else {
        // Find Bond Investments and Trust Corpus detail account IDs from mappings
        var mappingsRes = await pool.query("SELECT trust_account_code, fineract_gl_id FROM fineract_gl_mappings WHERE trust_account_code IN ('1100', '3000')");
        var bondGlId = null, corpusGlId = null;
        mappingsRes.rows.forEach(function(m) {
          if (m.trust_account_code === '1100') bondGlId = m.fineract_gl_id;
          if (m.trust_account_code === '3000') corpusGlId = m.fineract_gl_id;
        });
        if (bondGlId && corpusGlId) {
          await FineractClient.postJournalEntry({
            transactionDate: new Date(),
            debits: [{ glAccountId: bondGlId, amount: 100000000 }],
            credits: [{ glAccountId: corpusGlId, amount: 100000000 }],
            comments: 'Opening balance — DLB-PRB bond issuance $100M face value',
          });
          console.log('[fineract-init] Posted $100M opening balance (Bond Investments ↔ Trust Corpus)');
        } else {
          console.warn('[fineract-init] Could not find GL mappings for opening balance');
        }
      }

      // Pre-warm GL summary cache so it's available when Fineract disconnects
      try {
        await FineractClient.getGLSummary();
        console.log('[fineract-init] GL summary cache pre-warmed');
      } catch (cacheErr) {
        console.warn('[fineract-init] Cache pre-warm failed:', cacheErr.message);
      }
    } catch (initErr) {
      if (attempt < MAX_ATTEMPTS) {
        console.warn('[fineract-init] Attempt ' + attempt + '/' + MAX_ATTEMPTS + ' failed: ' + initErr.message + ' — retrying in ' + (RETRY_DELAY/1000) + 's');
        setTimeout(function() { initFineract(attempt + 1); }, RETRY_DELAY);
      } else {
        console.warn('[fineract-init] All ' + MAX_ATTEMPTS + ' attempts failed. GL will be managed by local Trust Accounting engine. (' + initErr.message + ')');
      }
    }
  }
  setTimeout(function() { initFineract(1); }, 5000);

  // ─── Fineract Resilience Monitoring ─────────────────────────────────────────
  try {
    var fineractResilience = require(path.join(HD, 'server', 'integrations', 'fineract', 'fineractResilience'));
    fineractResilience.startMonitoring();
    // Clear any stale Liquibase locks on startup
    fineractResilience.cleanLiquibaseLocks().then(function(result) {
      if (result && result.results) {
        var cleared = result.results.filter(function(r) { return r.action === 'cleared'; });
        if (cleared.length > 0) console.log('[fineract-resilience] Cleared stale Liquibase locks on startup');
      }
    }).catch(function(e) { /* non-critical */ });
  } catch(e) { console.warn('[fineract-resilience]', e.message); }

  // ─── Data Integrity Check on Startup ────────────────────────────────────────
  setTimeout(async function() {
    try {
      var pool = require(path.join(HD, 'server', 'integrations', 'bonds', 'pgPool'));
      var checks = { bonds: false, cashAccounts: false, trustAccounts: false, users: false };

      var bondRes = await pool.query("SELECT COUNT(*) as c, COALESCE(SUM(face_value),0) as total FROM bonds WHERE status = 'active'");
      checks.bonds = bondRes.rows[0].c > 0;
      console.log('[data-check] Bonds: ' + bondRes.rows[0].c + ' active ($' + Number(bondRes.rows[0].total).toLocaleString() + ')');

      var cashRes = await pool.query("SELECT COUNT(*) as c FROM cash_accounts WHERE status = 'active'");
      checks.cashAccounts = cashRes.rows[0].c > 0;
      console.log('[data-check] Cash accounts: ' + cashRes.rows[0].c + ' active');

      var trustRes = await pool.query("SELECT COUNT(*) as c FROM trust_accounts");
      checks.trustAccounts = trustRes.rows[0].c > 0;
      console.log('[data-check] Trust accounts: ' + trustRes.rows[0].c);

      var userRes = await pool.query("SELECT COUNT(*) as c FROM auth_users");
      checks.users = userRes.rows[0].c > 0;
      console.log('[data-check] Auth users: ' + userRes.rows[0].c);

      var allOk = Object.values(checks).every(function(v) { return v; });
      console.log('[data-check] Data integrity: ' + (allOk ? 'ALL OK' : 'ISSUES DETECTED — ' + JSON.stringify(checks)));

      // Store startup time for health endpoint
      global.__dlb_startup = new Date().toISOString();
      global.__dlb_data_integrity = checks;
    } catch (e) {
      console.warn('[data-check] Error:', e.message);
    }
  }, 3000);
  });
}).catch(function(e) {
  console.error('[startup] Fatal init error:', e.message);
  process.exit(1);
});
