/**
 * AI Agent Engine
 * DEANDREA LAVAR BARKLEY TRUST — Platform AI Assistant
 *
 * Open-source, free AI agent that runs platform tasks on command.
 * No external API keys required — uses rule-based NLP + platform API calls.
 *
 * Capabilities:
 *   - Natural language task parsing (intent + entity extraction)
 *   - Execute recurring platform tasks (reconciliation, forecast, reports)
 *   - Schedule automated tasks (cron-based)
 *   - Conversational interface with context
 *   - Cross-engine orchestration
 */

'use strict';

const { bus, EVENTS } = require('./event-bus');

// --- Intent Registry --------------------------------------------------------
// Maps natural language patterns to executable platform actions

const INTENT_REGISTRY = [
  {
    intent: 'run_reconciliation',
    patterns: [
      /reconcil/i, /recon/i, /match.*accounts/i, /check.*balance/i,
      /verify.*gl/i, /compare.*bank/i,
    ],
    description: 'Run cross-engine reconciliation',
    engine: 'cash-management',
    action: 'reconciliation',
  },
  {
    intent: 'generate_forecast',
    patterns: [
      /forecast/i, /project/i, /predict.*cash/i, /cash.*flow/i,
      /90.?day/i, /liquidity.*outlook/i,
    ],
    description: 'Generate 90-day cash flow forecast',
    engine: 'cash-management',
    action: 'forecast',
  },
  {
    intent: 'save_snapshot',
    patterns: [
      /snapshot/i, /save.*position/i, /capture.*balance/i,
      /record.*position/i, /freeze.*state/i,
    ],
    description: 'Save current cash position snapshot',
    engine: 'cash-management',
    action: 'snapshot',
  },
  {
    intent: 'refresh_position',
    patterns: [
      /refresh/i, /update.*position/i, /reload.*balance/i,
      /current.*position/i, /show.*balance/i,
    ],
    description: 'Refresh unified cash position',
    engine: 'cash-management',
    action: 'position',
  },
  {
    intent: 'check_alerts',
    patterns: [
      /alert/i, /warning/i, /notification/i, /issue/i,
      /problem/i, /critical/i,
    ],
    description: 'Check system alerts',
    engine: 'cash-management',
    action: 'alerts',
  },
  {
    intent: 'list_accounts',
    patterns: [
      /list.*account/i, /show.*account/i, /all.*account/i,
      /account.*status/i, /bank.*account/i,
    ],
    description: 'List all trust accounts',
    engine: 'accounts',
    action: 'list',
  },
  {
    intent: 'list_bonds',
    patterns: [
      /list.*bond/i, /show.*bond/i, /fixed.*income/i,
      /list.*holdings/i, /show.*holdings/i, /private.*placement/i,
    ],
    description: 'List fixed income holdings',
    engine: 'fixed-income',
    action: 'list',
  },
  {
    intent: 'list_wallets',
    patterns: [
      /list.*wallet/i, /show.*wallet/i, /crypto.*balance/i,
      /usdc.*balance/i, /blockchain.*wallet/i,
    ],
    description: 'List crypto wallets',
    engine: 'blockchain',
    action: 'wallets',
  },
  {
    intent: 'check_compliance',
    patterns: [
      /compliance/i, /kyc/i, /regulatory/i, /audit/i,
      /prudent.*investor/i, /tax.*status/i,
    ],
    description: 'Check compliance status',
    engine: 'compliance',
    action: 'check',
  },
  {
    intent: 'income_summary',
    patterns: [
      /income/i, /revenue/i, /earning/i, /coupon.*income/i,
      /interest.*income/i, /yield/i,
    ],
    description: 'Get income vs expense summary',
    engine: 'cash-management',
    action: 'income-summary',
  },
  {
    intent: 'list_documents',
    patterns: [
      /list.*document/i, /show.*document/i, /find.*document/i,
      /search.*document/i, /trust.*document/i, /file/i,
    ],
    description: 'List or search trust documents',
    engine: 'documents',
    action: 'list',
  },
  {
    intent: 'generate_statement',
    patterns: [
      /generate.*statement/i, /account.*statement/i, /create.*statement/i,
      /produce.*statement/i, /print.*statement/i,
    ],
    description: 'Generate account statement document',
    engine: 'document-generation',
    action: 'generate',
    report_type: 'ACCOUNT_STATEMENT',
  },
  {
    intent: 'generate_portfolio_report',
    patterns: [
      /portfolio.*report/i, /generate.*portfolio/i, /asset.*report/i,
      /holdings.*report/i, /investment.*report/i,
    ],
    description: 'Generate portfolio report across all asset classes',
    engine: 'document-generation',
    action: 'generate',
    report_type: 'PORTFOLIO_REPORT',
  },
  {
    intent: 'generate_tax_summary',
    patterns: [
      /tax.*summary/i, /tax.*report/i, /k-?1/i, /generate.*tax/i,
      /annual.*tax/i, /tax.*document/i,
    ],
    description: 'Generate tax summary (K-1 worksheet)',
    engine: 'document-generation',
    action: 'generate',
    report_type: 'TAX_SUMMARY',
  },
  {
    intent: 'generate_trial_balance',
    patterns: [
      /trial.*balance/i, /generate.*trial/i, /tb.*report/i,
      /chart.*of.*account.*report/i,
    ],
    description: 'Generate trial balance report',
    engine: 'document-generation',
    action: 'generate',
    report_type: 'TRIAL_BALANCE',
  },
  {
    intent: 'generate_compliance_cert',
    patterns: [
      /compliance.*cert/i, /generate.*cert/i, /attestation/i,
      /compliance.*document/i, /regulatory.*cert/i,
    ],
    description: 'Generate compliance certificate',
    engine: 'document-generation',
    action: 'generate',
    report_type: 'COMPLIANCE_CERTIFICATE',
  },
  {
    intent: 'generate_recon_report',
    patterns: [
      /recon.*report/i, /reconciliation.*report/i, /generate.*recon/i,
      /recon.*document/i,
    ],
    description: 'Generate reconciliation report',
    engine: 'document-generation',
    action: 'generate',
    report_type: 'RECONCILIATION_REPORT',
  },
  {
    intent: 'generate_coupon_schedule_report',
    patterns: [
      /coupon.*report/i, /coupon.*schedule.*report/i, /generate.*coupon.*doc/i,
      /bond.*schedule.*report/i,
    ],
    description: 'Generate coupon schedule report',
    engine: 'document-generation',
    action: 'generate',
    report_type: 'COUPON_SCHEDULE',
  },
  {
    intent: 'generate_distribution_report',
    patterns: [
      /distribution.*report/i, /generate.*distribution/i, /payout.*report/i,
      /beneficiary.*report/i,
    ],
    description: 'Generate distribution report',
    engine: 'document-generation',
    action: 'generate',
    report_type: 'DISTRIBUTION_REPORT',
  },
  {
    intent: 'generate_report',
    patterns: [
      /status.*report/i, /daily.*report/i, /trust.*report/i,
      /overview/i, /general.*report/i,
    ],
    description: 'Generate a trust status report (text summary)',
    engine: 'agent',
    action: 'report',
  },
  {
    intent: 'process_coupon',
    patterns: [
      /process.*coupon/i, /receive.*coupon/i, /collect.*coupon/i,
      /coupon.*payment/i, /coupon.*income/i, /pay.*coupon/i,
    ],
    description: 'Process next due coupon payment (FI → Banking → GL)',
    engine: 'fixed-income',
    action: 'process-coupon',
  },
  {
    intent: 'initialize_gl',
    patterns: [
      /init.*gl/i, /init.*ledger/i, /set.*up.*gl/i, /book.*initial/i,
      /initialize.*accounting/i, /start.*accounting/i, /set.*up.*books/i,
    ],
    description: 'Initialize GL with journal entries for all existing data',
    engine: 'cash-management',
    action: 'initialize-gl',
  },
  {
    intent: 'upcoming_coupons',
    patterns: [
      /upcoming.*coupon/i, /next.*coupon/i, /coupon.*schedule/i,
      /coupon.*due/i, /when.*coupon/i, /coupon.*date/i,
    ],
    description: 'Show upcoming coupon payment dates',
    engine: 'fixed-income',
    action: 'upcoming-coupons',
  },
  {
    intent: 'fineract_payment',
    patterns: [
      /send.*ach/i, /send.*wire/i, /initiate.*payment/i, /external.*payment/i,
      /pay.*external/i, /fineract.*pay/i, /ach.*transfer/i, /wire.*transfer/i,
      /send.*money/i, /transfer.*external/i, /rtp.*payment/i,
    ],
    description: 'Initiate external payment via Fineract (ACH/Wire/RTP)',
    engine: 'fineract',
    action: 'payment',
  },
  {
    intent: 'fineract_status',
    patterns: [
      /fineract.*status/i, /payment.*status/i, /banking.*status/i,
      /settlement.*status/i, /payment.*rails/i, /show.*payments/i,
    ],
    description: 'Check Fineract banking engine status',
    engine: 'fineract',
    action: 'status',
  },
  {
    intent: 'fineract_settle',
    patterns: [
      /settle.*payment/i, /process.*settlement/i, /clear.*payment/i,
      /run.*settlement/i, /fineract.*settle/i,
    ],
    description: 'Process pending payment settlements',
    engine: 'fineract',
    action: 'settle',
  },
  {
    intent: 'fineract_batch',
    patterns: [
      /ach.*batch/i, /create.*batch/i, /batch.*payment/i,
      /nacha.*batch/i, /fineract.*batch/i,
    ],
    description: 'Create ACH batch from pending payments',
    engine: 'fineract',
    action: 'batch',
  },
  {
    intent: 'fineract_sync',
    patterns: [
      /sync.*account/i, /synchronize/i, /fineract.*sync/i,
      /link.*account/i, /map.*account/i,
    ],
    description: 'Sync trust accounts with Fineract savings accounts',
    engine: 'fineract',
    action: 'sync',
  },
  {
    intent: 'fund_wallet',
    patterns: [
      /fund.*wallet/i, /bank.*to.*crypto/i, /convert.*usdc/i,
      /bridge.*crypto/i, /move.*money.*wallet/i, /deposit.*wallet/i,
      /buy.*usdc/i, /on.?ramp/i,
    ],
    description: 'Fund crypto wallet from banking balance (Banking→Crypto bridge)',
    engine: 'bridge',
    action: 'bank-to-crypto',
  },
  {
    intent: 'sweep_to_bank',
    patterns: [
      /sweep.*bank/i, /crypto.*to.*bank/i, /sell.*usdc/i,
      /withdraw.*bank/i, /off.?ramp/i, /convert.*bank/i,
      /move.*crypto.*bank/i,
    ],
    description: 'Sweep USDC from wallet to banking balance (Crypto→Banking bridge)',
    engine: 'bridge',
    action: 'crypto-to-bank',
  },
  {
    intent: 'bridge_status',
    patterns: [
      /bridge.*status/i, /bridge.*order/i, /conversion.*status/i,
      /moonpay.*status/i, /crypto.*bridge/i, /show.*bridge/i,
    ],
    description: 'Check Banking↔Crypto bridge status and orders',
    engine: 'bridge',
    action: 'status',
  },
  {
    intent: 'help',
    patterns: [
      /help/i, /what.*can.*you/i, /capabilities/i, /commands/i,
      /how.*to/i, /guide/i,
    ],
    description: 'Show available commands',
    engine: 'agent',
    action: 'help',
  },
];

// --- Intent Parser ----------------------------------------------------------

function parseIntent(prompt) {
  const normalizedPrompt = prompt.trim().toLowerCase();

  for (const entry of INTENT_REGISTRY) {
    for (const pattern of entry.patterns) {
      if (pattern.test(normalizedPrompt)) {
        const result = {
          intent: entry.intent,
          description: entry.description,
          engine: entry.engine,
          action: entry.action,
          confidence: 0.85,
          matched_pattern: pattern.toString(),
        };
        if (entry.report_type) result.report_type = entry.report_type;
        return result;
      }
    }
  }

  return {
    intent: 'unknown',
    description: 'Could not determine intent',
    engine: null,
    action: null,
    confidence: 0,
  };
}

// --- Task Executor ----------------------------------------------------------

async function executeTask(db, parsedIntent, prompt) {
  const startTime = Date.now();
  const taskRecord = {
    task_type: parsedIntent.intent,
    prompt,
    parsed_intent: JSON.stringify(parsedIntent),
    status: 'running',
  };

  // Insert task record
  const insertResult = db.prepare(`
    INSERT INTO agent_task_history (task_type, prompt, parsed_intent, status, created_by)
    VALUES (?, ?, ?, 'running', 'user')
  `).run(parsedIntent.intent, prompt, JSON.stringify(parsedIntent));
  const taskId = insertResult.lastInsertRowid;

  try {
    let result;

    switch (parsedIntent.intent) {
      case 'run_reconciliation':
        result = await executeReconciliation(db);
        break;
      case 'generate_forecast':
        result = await executeForecast(db);
        break;
      case 'save_snapshot':
        result = await executeSnapshot(db);
        break;
      case 'refresh_position':
        result = await executeRefreshPosition(db);
        break;
      case 'check_alerts':
        result = await executeCheckAlerts(db);
        break;
      case 'list_accounts':
        result = await executeListAccounts(db);
        break;
      case 'list_bonds':
        result = await executeListBonds(db);
        break;
      case 'list_wallets':
        result = await executeListWallets(db);
        break;
      case 'check_compliance':
        result = await executeCheckCompliance(db);
        break;
      case 'income_summary':
        result = await executeIncomeSummary(db);
        break;
      case 'list_documents':
        result = await executeListDocuments(db, prompt);
        break;
      case 'generate_report':
        result = await executeGenerateReport(db);
        break;
      case 'process_coupon':
        result = await executeProcessCoupon(db);
        break;
      case 'initialize_gl':
        result = await executeInitializeGL(db);
        break;
      case 'upcoming_coupons':
        result = await executeUpcomingCoupons(db);
        break;
      case 'help':
        result = executeHelp();
        break;
      case 'generate_statement':
      case 'generate_portfolio_report':
      case 'generate_tax_summary':
      case 'generate_trial_balance':
      case 'generate_compliance_cert':
      case 'generate_recon_report':
      case 'generate_coupon_schedule_report':
      case 'generate_distribution_report':
        result = await executeDocumentGeneration(db, parsedIntent);
        break;
      case 'fineract_payment':
        result = await executeFineractPayment(db, prompt);
        break;
      case 'fineract_status':
        result = await executeFineractStatus(db);
        break;
      case 'fineract_settle':
        result = await executeFineractSettle(db);
        break;
      case 'fineract_batch':
        result = await executeFineractBatch(db);
        break;
      case 'fineract_sync':
        result = await executeFineractSync(db);
        break;
      case 'fund_wallet':
        result = await executeBridgeFundWallet(db);
        break;
      case 'sweep_to_bank':
        result = await executeBridgeSweepToBank(db);
        break;
      case 'bridge_status':
        result = await executeBridgeStatus(db);
        break;
      default:
        result = {
          summary: `I'm not sure how to handle that request. Try asking me to:\n` +
            INTENT_REGISTRY.filter(i => i.intent !== 'help')
              .map(i => `• ${i.description}`)
              .join('\n'),
          data: null,
        };
    }

    const executionTime = Date.now() - startTime;

    // Update task record
    db.prepare(`
      UPDATE agent_task_history
      SET status = 'completed', result_summary = ?, result_data = ?,
          execution_time_ms = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(result.summary, JSON.stringify(result.data), executionTime, taskId);

    bus.emit(EVENTS.AGENT_TASK_COMPLETED, {
      task_id: taskId,
      intent: parsedIntent.intent,
      execution_time_ms: executionTime,
    });

    return {
      task_id: taskId,
      intent: parsedIntent.intent,
      status: 'completed',
      summary: result.summary,
      data: result.data,
      execution_time_ms: executionTime,
    };

  } catch (err) {
    const executionTime = Date.now() - startTime;

    db.prepare(`
      UPDATE agent_task_history
      SET status = 'failed', error_message = ?, execution_time_ms = ?,
          completed_at = datetime('now')
      WHERE id = ?
    `).run(err.message, executionTime, taskId);

    return {
      task_id: taskId,
      intent: parsedIntent.intent,
      status: 'failed',
      summary: `Task failed: ${err.message}`,
      data: null,
      execution_time_ms: executionTime,
    };
  }
}

// --- Data Gathering (mirrors cash-management routes pattern) ----------------

function gatherPositionData(db) {
  let accounts = [];
  try { accounts = db.prepare('SELECT * FROM trust_accounts').all(); } catch (e) { /* */ }

  let wallets = [];
  try { wallets = db.prepare('SELECT * FROM blockchain_wallets').all(); } catch (e) { /* */ }

  let holdings = [];
  try { holdings = db.prepare('SELECT * FROM fixed_income_holdings').all(); } catch (e) { /* */ }

  let pendingTransfers = [];
  try { pendingTransfers = db.prepare("SELECT * FROM internal_transfers WHERE status IN ('pending', 'approved', 'executing')").all(); } catch (e) { /* */ }

  let pendingBlockchainTxns = [];
  try { pendingBlockchainTxns = db.prepare("SELECT * FROM blockchain_transactions WHERE status IN ('pending_approval', 'initiated', 'submitted', 'confirming')").all(); } catch (e) { /* */ }

  return { accounts, wallets, holdings, pendingTransfers, pendingBlockchainTxns };
}

function gatherForecastData(db) {
  const posData = gatherPositionData(db);
  let scheduledPayments = [];
  try { scheduledPayments = db.prepare("SELECT * FROM external_transfers WHERE status IN ('draft', 'pending_approval', 'approved') AND scheduled_date IS NOT NULL").all(); } catch (e) { /* */ }
  return { accounts: posData.accounts, holdings: posData.holdings, wallets: posData.wallets, scheduledPayments, recurringTransfers: [] };
}

function gatherReconData(db) {
  const posData = gatherPositionData(db);
  let glBalances = [];
  try {
    glBalances = db.prepare('SELECT * FROM trust_chart_of_accounts WHERE is_active = 1').all();
    const balances = db.prepare(`SELECT jl.account_code, SUM(jl.debit_cents) as total_debit, SUM(jl.credit_cents) as total_credit FROM trust_journal_lines jl JOIN trust_journal_entries je ON je.id = jl.journal_entry_id WHERE je.is_posted = 1 GROUP BY jl.account_code`).all();
    const balMap = {};
    for (const b of balances) { balMap[b.account_code] = b; }
    glBalances = glBalances.map(gl => {
      const b = balMap[gl.account_code] || {};
      const balance = gl.normal_balance === 'debit' ? (b.total_debit || 0) - (b.total_credit || 0) : (b.total_credit || 0) - (b.total_debit || 0);
      return { ...gl, balance_cents: balance };
    });
  } catch (e) { /* */ }

  let transfers = [];
  try { transfers = db.prepare('SELECT * FROM internal_transfers').all(); } catch (e) { /* */ }
  let blockchainTxns = [];
  try { blockchainTxns = db.prepare('SELECT * FROM blockchain_transactions').all(); } catch (e) { /* */ }

  return { accounts: posData.accounts, wallets: posData.wallets, glBalances, transfers, blockchainTxns };
}

// --- Task Implementations ---------------------------------------------------

async function executeReconciliation(db) {
  const { reconcile } = require('./cash-management-engine');
  const data = gatherReconData(db);
  const recon = reconcile(data);

  return {
    summary: `Reconciliation complete: ${recon.summary.overall_status.toUpperCase()}\n` +
      `Checks: ${recon.summary.total_checks} | Matched: ${recon.summary.matched} | ` +
      `Mismatched: ${recon.summary.mismatched} | Review: ${recon.summary.pending_review}`,
    data: recon,
  };
}

async function executeForecast(db) {
  const { buildForecast } = require('./cash-management-engine');
  const data = gatherForecastData(db);
  const forecast = buildForecast(data, 90);

  return {
    summary: `90-day forecast generated:\n` +
      `Periods: ${forecast.periods ? forecast.periods.length : 0}\n` +
      `Total Inflow: +$${((forecast.total_inflow_cents || 0) / 100).toFixed(2)}\n` +
      `Total Outflow: -$${((forecast.total_outflow_cents || 0) / 100).toFixed(2)}`,
    data: forecast,
  };
}

async function executeSnapshot(db) {
  const { buildCashPosition } = require('./cash-management-engine');
  const posData = gatherPositionData(db);
  const position = buildCashPosition(posData);
  const s = position.summary;

  // Save snapshot
  let snapshotId = null;
  try {
    const result = db.prepare(`
      INSERT INTO cms_position_snapshots (bank_balance_cents, bank_available_cents, bank_account_count, crypto_usdc_cents, crypto_wallet_count, fi_par_value_cents, fi_market_value_cents, fi_accrued_cents, fi_holding_count, pending_inflow_cents, pending_outflow_cents, total_liquid_cents, total_assets_cents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      s.bank_balance_cents, position.bank_accounts.total_available_cents || 0, s.account_count || 0,
      s.crypto_balance_cents, s.wallet_count || 0,
      position.fixed_income.total_par_cents || 0, s.fixed_income_market_cents || 0, s.accrued_interest_cents || 0, s.holding_count || 0,
      position.pending.inflow_cents || 0, position.pending.outflow_cents || 0,
      s.total_liquid_cents, s.total_assets_cents
    );
    snapshotId = result.lastInsertRowid;
  } catch (e) { /* */ }

  return {
    summary: `Position snapshot saved${snapshotId ? ` (ID: ${snapshotId})` : ''}.\n` +
      `Total Assets: $${(s.total_assets_cents / 100).toFixed(2)}`,
    data: { snapshot_id: snapshotId, position },
  };
}

async function executeRefreshPosition(db) {
  const { buildCashPosition } = require('./cash-management-engine');
  const posData = gatherPositionData(db);
  const position = buildCashPosition(posData);
  const s = position.summary;

  const bankTotal = (s.bank_balance_cents / 100).toFixed(2);
  const cryptoTotal = (s.crypto_balance_cents / 100).toFixed(2);
  const fiTotal = (s.fixed_income_market_cents / 100).toFixed(2);
  const totalAssets = (s.total_assets_cents / 100).toFixed(2);

  return {
    summary: `Cash Position:\n` +
      `• Bank Accounts: $${bankTotal}\n` +
      `• Crypto (USDC): $${cryptoTotal}\n` +
      `• Fixed Income: $${fiTotal}\n` +
      `• Total Assets: $${totalAssets}`,
    data: position,
  };
}

async function executeCheckAlerts(db) {
  const { buildCashPosition, buildForecast, reconcile, generateAlerts } = require('./cash-management-engine');
  const posData = gatherPositionData(db);
  const position = buildCashPosition(posData);
  const forecastData = gatherForecastData(db);
  const forecast = buildForecast(forecastData, 90);
  const reconData = gatherReconData(db);
  const recon = reconcile(reconData);
  const alerts = generateAlerts(position, forecast, recon);

  if (alerts.length === 0) {
    return { summary: 'No active alerts. All systems normal.', data: alerts };
  }

  const alertSummary = alerts.map(a =>
    `• [${a.severity.toUpperCase()}] ${a.type}: ${a.message}`
  ).join('\n');

  return {
    summary: `${alerts.length} active alert(s):\n${alertSummary}`,
    data: alerts,
  };
}

async function executeListAccounts(db) {
  let accounts = [];
  try { accounts = db.prepare('SELECT * FROM trust_accounts').all(); } catch (e) { /* */ }

  if (accounts.length === 0) {
    return { summary: 'No trust accounts found.', data: [] };
  }

  const summary = accounts.map(a =>
    `• ${a.account_name} (${a.account_type}) — $${(a.balance_cents / 100).toFixed(2)} [${a.status}]`
  ).join('\n');

  return {
    summary: `${accounts.length} account(s):\n${summary}`,
    data: accounts,
  };
}

async function executeListBonds(db) {
  let bonds = [];
  try { bonds = db.prepare("SELECT * FROM fixed_income_holdings WHERE status = 'active'").all(); } catch (e) { /* */ }

  if (bonds.length === 0) {
    return { summary: 'No active bonds in portfolio.', data: [] };
  }

  const summary = bonds.map(b =>
    `• ${b.security_name} — Par: $${(b.par_value_cents / 100).toLocaleString()} | Coupon: ${(b.coupon_rate * 100).toFixed(2)}% | Maturity: ${b.maturity_date}`
  ).join('\n');

  return {
    summary: `${bonds.length} active bond(s):\n${summary}`,
    data: bonds,
  };
}

async function executeListWallets(db) {
  let wallets = [];
  try { wallets = db.prepare('SELECT * FROM blockchain_wallets').all(); } catch (e) { /* */ }

  if (wallets.length === 0) {
    return { summary: 'No crypto wallets found.', data: [] };
  }

  const summary = wallets.map(w =>
    `• ${w.wallet_name} (${w.blockchain}) — $${parseFloat(w.usdc_balance || '0').toFixed(2)} USDC [${w.provider}]`
  ).join('\n');

  return {
    summary: `${wallets.length} wallet(s):\n${summary}`,
    data: wallets,
  };
}

async function executeCheckCompliance(db) {
  let issues = [];
  try {
    const compliance = db.prepare(`
      SELECT * FROM trust_accounts WHERE status = 'frozen'
    `).all();
    if (compliance.length > 0) {
      issues.push(`${compliance.length} frozen account(s) requiring review`);
    }
  } catch (e) { /* */ }

  try {
    const expiring = db.prepare(`
      SELECT * FROM dms_documents
      WHERE is_latest = 1 AND status = 'active'
        AND expiration_date IS NOT NULL
        AND expiration_date <= date('now', '+30 days')
    `).all();
    if (expiring.length > 0) {
      issues.push(`${expiring.length} document(s) expiring within 30 days`);
    }
  } catch (e) { /* */ }

  if (issues.length === 0) {
    return { summary: 'No compliance issues detected. All clear.', data: [] };
  }

  return {
    summary: `${issues.length} compliance issue(s):\n${issues.map(i => `• ${i}`).join('\n')}`,
    data: issues,
  };
}

async function executeIncomeSummary(db) {
  const { buildIncomeExpenseSummary } = require('./cash-management-engine');
  const posData = gatherPositionData(db);

  let payments = [];
  try { payments = db.prepare('SELECT * FROM external_transfers').all(); } catch (e) { /* */ }

  const income = buildIncomeExpenseSummary({ holdings: posData.holdings, accounts: posData.accounts, payments });

  return {
    summary: `Income Summary (Annual Projected):\n` +
      `• Coupon Income: $${((income.coupon_income_cents || 0) / 100).toFixed(2)}\n` +
      `• Interest Income: $${((income.interest_income_cents || 0) / 100).toFixed(2)}\n` +
      `• Total Projected: $${((income.total_projected_income_cents || 0) / 100).toFixed(2)}`,
    data: income,
  };
}

async function executeListDocuments(db, prompt) {
  const dmsEngine = require('./document-management-engine');

  // Extract search term if present
  const searchMatch = prompt.match(/(?:search|find|look for|about)\s+["""]?(.+?)["""]?\s*$/i);
  const searchTerm = searchMatch ? searchMatch[1] : null;

  let docs;
  if (searchTerm) {
    docs = dmsEngine.searchDocuments(db, searchTerm);
  } else {
    docs = dmsEngine.listDocuments(db, { limit: 10 });
  }

  if (docs.length === 0) {
    return { summary: 'No documents found.', data: [] };
  }

  const summary = docs.map(d =>
    `• ${d.title} (${d.category}) — ${d.file_type.toUpperCase()} | ${d.status} | ${d.created_at}`
  ).join('\n');

  return {
    summary: `${docs.length} document(s):\n${summary}`,
    data: docs,
  };
}

async function executeGenerateReport(db) {
  // Aggregate data from all engines into a single report
  const sections = [];

  // Accounts
  try {
    const accounts = db.prepare('SELECT * FROM trust_accounts').all();
    const activeAccounts = accounts.filter(a => a.status === 'active');
    const totalBalance = accounts.reduce((sum, a) => sum + (a.balance_cents || 0), 0);
    sections.push(`ACCOUNTS: ${activeAccounts.length} active of ${accounts.length} total | Balance: $${(totalBalance / 100).toFixed(2)}`);
  } catch (e) { sections.push('ACCOUNTS: No data'); }

  // Fixed Income
  try {
    const bonds = db.prepare("SELECT * FROM fixed_income_holdings WHERE status = 'active'").all();
    const totalPar = bonds.reduce((sum, b) => sum + (b.par_value_cents || 0), 0);
    sections.push(`FIXED INCOME: ${bonds.length} active bond(s) | Total Par: $${(totalPar / 100).toLocaleString()}`);
  } catch (e) { sections.push('FIXED INCOME: No data'); }

  // Crypto
  try {
    const wallets = db.prepare('SELECT * FROM blockchain_wallets').all();
    const totalUSDC = wallets.reduce((sum, w) => sum + parseFloat(w.usdc_balance || '0'), 0);
    sections.push(`CRYPTO: ${wallets.length} wallet(s) | USDC Balance: $${totalUSDC.toFixed(2)}`);
  } catch (e) { sections.push('CRYPTO: No data'); }

  // Documents
  try {
    const docCount = db.prepare('SELECT COUNT(*) as count FROM dms_documents WHERE is_latest = 1').get();
    sections.push(`DOCUMENTS: ${docCount.count} document(s) on file`);
  } catch (e) { sections.push('DOCUMENTS: No data'); }

  // Pending activity
  try {
    const pending = db.prepare("SELECT COUNT(*) as count FROM internal_transfers WHERE status = 'pending'").get();
    sections.push(`PENDING: ${pending.count} pending transfer(s)`);
  } catch (e) { /* */ }

  return {
    summary: `Trust Status Report (${new Date().toLocaleDateString()}):\n\n${sections.join('\n')}`,
    data: { sections, generated_at: new Date().toISOString() },
  };
}

async function executeProcessCoupon(db) {
  // Find the next due coupon (accrued or scheduled, earliest date)
  let coupons;
  try {
    coupons = db.prepare(`
      SELECT cp.*, h.security_name
      FROM coupon_payments cp
      JOIN fixed_income_holdings h ON cp.holding_id = h.id
      WHERE cp.status IN ('accrued', 'scheduled')
      ORDER BY cp.payment_date ASC
    `).all();
  } catch (e) {
    return { summary: 'No coupon schedule found. Try "generate coupon schedule" first.', data: null };
  }

  if (coupons.length === 0) {
    return { summary: 'No pending coupons to process. All coupons have been received.', data: null };
  }

  const coupon = coupons[0];
  const amountUsd = (coupon.amount_cents / 100).toFixed(2);

  // Process the coupon: mark as received, credit bank account, post GL entry
  db.prepare("UPDATE coupon_payments SET status = 'received', received_at = datetime('now') WHERE id = ?").run(coupon.id);

  // Credit operating account
  let creditedAccount = null;
  const account = db.prepare("SELECT * FROM trust_accounts WHERE account_type = 'operating' AND status = 'active' ORDER BY id LIMIT 1").get();
  if (account) {
    db.prepare('UPDATE trust_accounts SET balance_cents = balance_cents + ?, available_cents = available_cents + ?, last_activity_date = date(?) WHERE id = ?')
      .run(coupon.amount_cents, coupon.amount_cents, new Date().toISOString(), account.id);
    creditedAccount = account.account_name;

    try {
      db.prepare("INSERT INTO cms_event_log (event_name, source_engine, event_data) VALUES ('coupon_received', 'fixed_income', ?)")
        .run(JSON.stringify({ coupon_id: coupon.id, account_id: account.id, amount_cents: coupon.amount_cents, security_name: coupon.security_name }));
    } catch (_) { /* event log optional */ }
  }

  // Post journal entry
  let journalEntryId = null;
  const cashAcct = db.prepare("SELECT id FROM trust_chart_of_accounts WHERE account_code = '1010' AND is_active = 1").get();
  const incomeAcct = db.prepare("SELECT id FROM trust_chart_of_accounts WHERE account_code = '4000' AND is_active = 1").get();
  if (cashAcct && incomeAcct) {
    const entryNum = `CPN-${Date.now()}`;
    const entryDate = new Date().toISOString().split('T')[0];
    const result = db.prepare(`
      INSERT INTO trust_journal_entries (entry_number, entry_date, entry_type, description, source_engine, is_posted, total_debit_cents, total_credit_cents, created_by)
      VALUES (?, ?, 'coupon_income', ?, 'fixed_income', 1, ?, ?, 'system')
    `).run(entryNum, entryDate, `Coupon income — ${coupon.security_name} (${coupon.payment_date})`, coupon.amount_cents, coupon.amount_cents);
    journalEntryId = result.lastInsertRowid;

    db.prepare('INSERT INTO trust_journal_lines (journal_entry_id, line_number, account_id, account_code, debit_cents, credit_cents, description) VALUES (?, 1, ?, ?, ?, 0, ?)')
      .run(journalEntryId, cashAcct.id, '1010', coupon.amount_cents, 'Cash received — coupon');
    db.prepare('INSERT INTO trust_journal_lines (journal_entry_id, line_number, account_id, account_code, debit_cents, credit_cents, description) VALUES (?, 2, ?, ?, 0, ?, ?)')
      .run(journalEntryId, incomeAcct.id, '4000', coupon.amount_cents, 'Interest income — coupon');
  }

  // Update PP bond if applicable
  try {
    const ppBond = db.prepare('SELECT * FROM private_placement_bonds WHERE holding_id = ?').get(coupon.holding_id);
    if (ppBond) {
      db.prepare('UPDATE private_placement_bonds SET total_interest_paid_cents = total_interest_paid_cents + ?, total_payments_made_cents = total_payments_made_cents + ? WHERE id = ?')
        .run(coupon.amount_cents, coupon.amount_cents, ppBond.id);
    }
  } catch (_) { /* optional */ }

  const remaining = coupons.length - 1;
  let summary = `Coupon processed: $${amountUsd} from ${coupon.security_name}\n`;
  summary += `• Payment date: ${coupon.payment_date}\n`;
  if (creditedAccount) summary += `• Credited to: ${creditedAccount}\n`;
  if (journalEntryId) summary += `• Journal entry: #${journalEntryId} (Debit Cash / Credit Interest Income)\n`;
  summary += `• Remaining coupons: ${remaining}`;

  return {
    summary,
    data: { coupon_id: coupon.id, amount_cents: coupon.amount_cents, credited_account: creditedAccount, journal_entry_id: journalEntryId, remaining_coupons: remaining },
  };
}

async function executeInitializeGL(db) {
  // Check if GL already has entries
  const existingCount = db.prepare('SELECT COUNT(*) as cnt FROM trust_journal_entries').get().cnt;
  if (existingCount > 0) {
    return {
      summary: `GL already initialized with ${existingCount} journal entries. Use the API directly with { "force": true } to re-initialize.`,
      data: { existing_entries: existingCount },
    };
  }

  // Resolve GL accounts
  const glAccounts = {};
  for (const code of ['1010', '1100', '1500', '3000', '4000']) {
    const acct = db.prepare("SELECT id FROM trust_chart_of_accounts WHERE account_code = ? AND is_active = 1").get(code);
    if (!acct) return { summary: `GL account ${code} not found in chart of accounts`, data: null };
    glAccounts[code] = acct.id;
  }

  const now = new Date().toISOString().split('T')[0];
  const entries = [];

  const insertEntry = db.prepare(`
    INSERT INTO trust_journal_entries (entry_number, entry_date, entry_type, description, source_engine, is_posted, total_debit_cents, total_credit_cents, created_by)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'system')
  `);
  const insertLine = db.prepare(`
    INSERT INTO trust_journal_lines (journal_entry_id, line_number, account_id, account_code, debit_cents, credit_cents, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Bank accounts → Debit Cash / Credit Corpus
  const accounts = db.prepare("SELECT * FROM trust_accounts WHERE status = 'active'").all();
  for (const acct of accounts) {
    if (acct.balance_cents <= 0) continue;
    const result = insertEntry.run(`INIT-BANK-${acct.id}-${Date.now()}`, now, 'initial_funding', `Initial funding — ${acct.account_name}`, 'banking', acct.balance_cents, acct.balance_cents);
    const eid = result.lastInsertRowid;
    insertLine.run(eid, 1, glAccounts['1010'], '1010', acct.balance_cents, 0, `Cash — ${acct.account_name}`);
    insertLine.run(eid, 2, glAccounts['3000'], '3000', 0, acct.balance_cents, 'Trust corpus');
    entries.push({ type: 'bank', name: acct.account_name, cents: acct.balance_cents });
  }

  // Holdings → Debit FI Investments / Credit Corpus
  const holdings = db.prepare("SELECT * FROM fixed_income_holdings WHERE status = 'active'").all();
  for (const h of holdings) {
    const valueCents = h.purchase_price_cents || h.par_value_cents;
    if (valueCents <= 0) continue;
    const result = insertEntry.run(`INIT-FI-${h.id}-${Date.now()}`, h.purchase_date || now, 'bond_purchase', `Bond — ${h.security_name}`, 'fixed_income', valueCents, valueCents);
    const eid = result.lastInsertRowid;
    insertLine.run(eid, 1, glAccounts['1100'], '1100', valueCents, 0, `FI — ${h.security_name}`);
    insertLine.run(eid, 2, glAccounts['3000'], '3000', 0, valueCents, 'Trust corpus');
    entries.push({ type: 'bond', name: h.security_name, cents: valueCents });
  }

  // Accrued interest
  let totalAccrued = 0;
  try {
    const { analyzeBond } = require('./fixed-income-engine');
    for (const h of holdings) {
      totalAccrued += (analyzeBond(h).accrued_interest_cents || 0);
    }
  } catch (_) { /* */ }

  if (totalAccrued > 0) {
    const result = insertEntry.run(`INIT-AI-${Date.now()}`, now, 'accrued_interest', 'Accrued interest receivable', 'fixed_income', totalAccrued, totalAccrued);
    const eid = result.lastInsertRowid;
    insertLine.run(eid, 1, glAccounts['1500'], '1500', totalAccrued, 0, 'Accrued interest');
    insertLine.run(eid, 2, glAccounts['4000'], '4000', 0, totalAccrued, 'Interest income');
    entries.push({ type: 'accrued', name: 'Accrued interest', cents: totalAccrued });
  }

  const totalCents = entries.reduce((s, e) => s + e.cents, 0);
  let summary = `GL initialized with ${entries.length} journal entries:\n`;
  for (const e of entries) {
    summary += `• ${e.type}: ${e.name} — $${(e.cents / 100).toFixed(2)}\n`;
  }
  summary += `Total: $${(totalCents / 100).toFixed(2)}`;

  return { summary, data: { entries, total_cents: totalCents } };
}

async function executeUpcomingCoupons(db) {
  let coupons;
  try {
    const todayStr = new Date().toISOString().split('T')[0];
    coupons = db.prepare(`
      SELECT cp.*, h.security_name, h.coupon_rate
      FROM coupon_payments cp
      JOIN fixed_income_holdings h ON cp.holding_id = h.id
      WHERE cp.status IN ('scheduled', 'accrued')
      ORDER BY cp.payment_date ASC
      LIMIT 10
    `).all();
  } catch (e) {
    return { summary: 'No coupon schedule found. Try "generate coupon schedule" first.', data: null };
  }

  if (coupons.length === 0) {
    return { summary: 'No upcoming coupons. All scheduled coupons have been received.', data: null };
  }

  const totalCents = coupons.reduce((s, c) => s + c.amount_cents, 0);
  let summary = `${coupons.length} upcoming coupon(s) — Total: $${(totalCents / 100).toFixed(2)}\n\n`;
  for (const c of coupons) {
    summary += `• ${c.payment_date} — $${(c.amount_cents / 100).toFixed(2)} from ${c.security_name} [${c.status}]\n`;
  }

  return { summary, data: { coupons, total_cents: totalCents } };
}

function executeHelp() {
  const commands = INTENT_REGISTRY
    .filter(i => i.intent !== 'help')
    .map(i => `• "${i.description}" — try: "${i.patterns[0].source.replace(/[/\\^$.*+?()[\]{}|]/g, '')}"`)
    .join('\n');

  return {
    summary: `I can help with these tasks:\n\n${commands}\n\nJust type what you need in natural language!`,
    data: INTENT_REGISTRY.map(i => ({ intent: i.intent, description: i.description })),
  };
}

// --- Conversation Manager ---------------------------------------------------

function saveConversation(db, role, content, taskId = null) {
  db.prepare(`
    INSERT INTO agent_conversations (role, content, task_id)
    VALUES (?, ?, ?)
  `).run(role, content, taskId);
}

function getConversationHistory(db, limit = 50) {
  return db.prepare(`
    SELECT * FROM agent_conversations
    ORDER BY created_at DESC LIMIT ?
  `).all(limit).reverse();
}

// --- Task History -----------------------------------------------------------

function getTaskHistory(db, limit = 20) {
  return db.prepare(`
    SELECT * FROM agent_task_history
    ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

// --- Scheduled Tasks --------------------------------------------------------

function listScheduledTasks(db) {
  return db.prepare('SELECT * FROM agent_scheduled_tasks ORDER BY next_run_at ASC').all();
}

function createScheduledTask(db, task) {
  const result = db.prepare(`
    INSERT INTO agent_scheduled_tasks (name, task_type, schedule_cron, parameters, is_active)
    VALUES (?, ?, ?, ?, 1)
  `).run(task.name, task.task_type, task.schedule_cron, task.parameters ? JSON.stringify(task.parameters) : null);
  return { id: result.lastInsertRowid };
}

function toggleScheduledTask(db, id, isActive) {
  db.prepare('UPDATE agent_scheduled_tasks SET is_active = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(isActive ? 1 : 0, id);
  return { success: true };
}

// --- Document Generation Integration ----------------------------------------

async function executeDocumentGeneration(db, parsedIntent) {
  const { docGenEngine, REPORT_TYPES } = require('./document-generation-engine');
  const reportType = parsedIntent.report_type;

  if (!reportType || !REPORT_TYPES[reportType]) {
    return { summary: `Unknown document type: ${reportType}`, data: null };
  }

  const template = REPORT_TYPES[reportType];
  const result = await docGenEngine.generate(db, reportType, {});

  return {
    summary: `${template.name} generated successfully.\n\n` +
      `• Document ID: ${result.document_id}\n` +
      `• Stored in DMS as: ${template.category}\n` +
      `• Duration: ${result.duration_ms}ms\n` +
      `• Preview: /api/document-generation/preview/${result.document_id}`,
    data: {
      document_id: result.document_id,
      report_type: reportType,
      report_name: template.name,
      category: template.category,
      duration_ms: result.duration_ms,
      preview_url: `/api/document-generation/preview/${result.document_id}`,
    },
  };
}

// ─── Fineract Executor Functions ─────────────────────────────────────────────

async function executeFineractStatus(db) {
  const { fineractEngine } = require('./fineract-engine');
  fineractEngine.initSchema(db);
  const status = fineractEngine.getStatus(db);
  const rails = status.available_rails.map(r => `• ${r.code}: ${r.name} (${r.fee}, ${r.settlement})`).join('\n');
  return {
    summary: `Fineract Banking Engine: ${status.mode} mode\n\n` +
      `Payments: ${status.stats.total} total | ${status.stats.pending} pending | ${status.stats.settled} settled | ${status.stats.failed} failed\n` +
      `Today: $${(status.stats.volume_today_cents / 100).toFixed(2)} volume | $${(status.stats.settled_today_cents / 100).toFixed(2)} settled\n` +
      `Pending ACH Batches: ${status.pending_batches}\n\n` +
      `Available Rails:\n${rails}`,
    data: status,
  };
}

async function executeFineractPayment(db, prompt) {
  const { fineractEngine } = require('./fineract-engine');
  fineractEngine.initSchema(db);

  // Extract amount from prompt (look for $ amounts)
  const amountMatch = prompt.match(/\$?([\d,]+\.?\d*)/);
  const amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : null;

  // Determine rail from prompt
  let rail = 'ACH';
  if (/wire/i.test(prompt)) rail = 'WIRE';
  else if (/rtp|real.?time/i.test(prompt)) rail = 'RTP';
  else if (/check/i.test(prompt)) rail = 'CHECK';

  // Find active account
  const account = db.prepare("SELECT * FROM trust_accounts WHERE status = 'active' ORDER BY balance_cents DESC LIMIT 1").get();
  if (!account) {
    return { summary: 'No active trust account found to initiate payment from.', data: null };
  }

  if (!amount) {
    return {
      summary: `Ready to initiate ${rail} payment from ${account.account_name}.\n\n` +
        `Please specify the amount (e.g., "send $5000 via ACH") and destination:\n` +
        `• Routing number\n• Account number\n• Beneficiary name\n\n` +
        `Or use the Fineract Banking UI to fill in all details.`,
      data: { rail, from_account: account.account_name, balance: `$${(account.balance_cents / 100).toFixed(2)}` },
    };
  }

  const amountCents = Math.round(amount * 100);
  const payment = fineractEngine.initiatePayment(db, {
    from_account_id: account.id,
    amount_cents: amountCents,
    rail,
    to_routing_number: '021000021', // Placeholder — JP Morgan Chase
    to_account_number: '000000000',
    to_bank_name: 'External Bank',
    to_beneficiary_name: 'External Recipient',
    description: `AI Agent initiated ${rail} payment`,
  });

  return {
    summary: `${rail} payment initiated: $${amount.toFixed(2)}\n\n` +
      `• Payment #: ${payment.payment_number}\n` +
      `• Status: ${payment.status}\n` +
      `• Fee: $${(payment.fee_cents / 100).toFixed(2)}\n` +
      `• Settlement: ${payment.estimated_settlement}\n` +
      `• Approval: ${payment.approval_tier}`,
    data: payment,
  };
}

async function executeFineractSettle(db) {
  const { fineractEngine } = require('./fineract-engine');
  fineractEngine.initSchema(db);
  const result = fineractEngine.processSettlements(db);
  return {
    summary: `Settlement processing complete.\n\n` +
      `• Payments settled: ${result.processed}\n` +
      `• Remaining in clearing: ${result.remaining_clearing}`,
    data: result,
  };
}

async function executeFineractBatch(db) {
  const { fineractEngine } = require('./fineract-engine');
  fineractEngine.initSchema(db);
  const result = fineractEngine.createACHBatch(db);
  if (!result.batch_id) {
    return { summary: 'No pending ACH payments to batch.', data: result };
  }
  return {
    summary: `ACH Batch created: ${result.batch_number}\n\n` +
      `• Entries: ${result.entry_count}\n` +
      `• Total Debit: $${(result.total_debit_cents / 100).toFixed(2)}\n` +
      `• Effective Date: ${result.effective_date}`,
    data: result,
  };
}

async function executeFineractSync(db) {
  const { fineractEngine } = require('./fineract-engine');
  fineractEngine.initSchema(db);
  const result = fineractEngine.syncTrustAccounts(db);
  return {
    summary: `Account sync complete.\n\n` +
      `• Total trust accounts: ${result.total}\n` +
      `• Newly synced to Fineract: ${result.synced}`,
    data: result,
  };
}

// --- Bridge Functions --------------------------------------------------------

async function executeBridgeFundWallet(db) {
  const { BridgeOrderManager } = require('./moonpay-engine');
  const { engine: integrationEngine } = require('./integration-engine');

  // Find first active account and wallet
  const account = db.prepare("SELECT * FROM trust_accounts WHERE status = 'active' ORDER BY available_cents DESC LIMIT 1").get();
  const wallet = db.prepare("SELECT * FROM blockchain_wallets WHERE status = 'active' LIMIT 1").get();

  if (!account) return { summary: 'No active banking account found. Create one first.', data: null };
  if (!wallet) return { summary: 'No active crypto wallet found. Create one first in Crypto Rails.', data: null };

  // Default to $1000 conversion
  const amountCents = 100000;
  const result = await integrationEngine.executePipeline('BANK_TO_CRYPTO', db, {
    source_account_id: account.id,
    destination_wallet_id: wallet.id,
    amount_cents: amountCents,
  }, { type: 'manual', source: 'ai_agent' });

  if (result.status === 'failed') {
    return { summary: `Fund wallet failed: ${result.error}`, data: result.toJSON() };
  }

  const order = result.results.order;
  return {
    summary: `Banking→Crypto bridge executed successfully!\n\n` +
      `• Order: ${order.order_number}\n` +
      `• Source: ${account.account_name}\n` +
      `• Destination: ${wallet.wallet_name}\n` +
      `• Amount: $${(amountCents / 100).toFixed(2)} → ${(amountCents / 100).toFixed(2)} USDC\n` +
      `• Status: ${order.status}\n` +
      `• GL Journal Posted: Yes`,
    data: result.toJSON(),
  };
}

async function executeBridgeSweepToBank(db) {
  const { engine: integrationEngine } = require('./integration-engine');

  const wallet = db.prepare("SELECT * FROM blockchain_wallets WHERE status = 'active' AND CAST(usdc_balance AS REAL) > 0 ORDER BY CAST(usdc_balance AS REAL) DESC LIMIT 1").get();
  const account = db.prepare("SELECT * FROM trust_accounts WHERE status = 'active' ORDER BY id LIMIT 1").get();

  if (!wallet) return { summary: 'No wallet with USDC balance found.', data: null };
  if (!account) return { summary: 'No active banking account found.', data: null };

  const sweepAmount = Math.min(parseFloat(wallet.usdc_balance || '0'), 1000).toFixed(2);
  if (parseFloat(sweepAmount) <= 0) return { summary: 'No USDC balance to sweep.', data: null };

  const result = await integrationEngine.executePipeline('CRYPTO_TO_BANK', db, {
    source_wallet_id: wallet.id,
    destination_account_id: account.id,
    amount_usdc: sweepAmount,
  }, { type: 'manual', source: 'ai_agent' });

  if (result.status === 'failed') {
    return { summary: `Sweep failed: ${result.error}`, data: result.toJSON() };
  }

  const order = result.results.order;
  return {
    summary: `Crypto→Banking sweep executed successfully!\n\n` +
      `• Order: ${order.order_number}\n` +
      `• Source: ${wallet.wallet_name}\n` +
      `• Destination: ${account.account_name}\n` +
      `• Amount: ${sweepAmount} USDC → $${sweepAmount}\n` +
      `• Status: ${order.status}\n` +
      `• GL Journal Posted: Yes`,
    data: result.toJSON(),
  };
}

async function executeBridgeStatus(db) {
  const { BridgeOrderManager, MoonPayClient } = require('./moonpay-engine');

  // Ensure bridge schema exists
  const path = require('path');
  const fs = require('fs');
  const schema = path.join(__dirname, '..', 'db', 'migrations', 'banking-crypto-bridge-schema.sql');
  if (fs.existsSync(schema)) { try { db.exec(fs.readFileSync(schema, 'utf8')); } catch (_) {} }

  const bridgeMgr = new BridgeOrderManager(db);
  const moonpay = new MoonPayClient();
  const stats = bridgeMgr.getStats();
  const recentOrders = bridgeMgr.listOrders({ limit: 5 });

  let summary = `Banking ↔ Crypto Bridge Status\n\n`;
  summary += `• MoonPay: ${moonpay.isConfigured() ? 'Configured (Live)' : 'Not configured (Ledger-only mode)'}\n`;
  summary += `• Total Orders: ${stats.total}\n`;
  summary += `• Pending: ${stats.pending}\n`;
  summary += `• Completed: ${stats.completedCount} ($${(stats.completedVolumeCents / 100).toFixed(2)} total)\n`;
  summary += `• Bank→Crypto: ${stats.bankToCrypto.count} orders ($${(stats.bankToCrypto.volumeCents / 100).toFixed(2)})\n`;
  summary += `• Crypto→Bank: ${stats.cryptoToBank.count} orders ($${(stats.cryptoToBank.volumeCents / 100).toFixed(2)})\n`;

  if (recentOrders.length > 0) {
    summary += `\nRecent Orders:\n`;
    for (const o of recentOrders) {
      summary += `  ${o.order_number} | ${o.direction} | $${(o.fiat_amount_cents / 100).toFixed(2)} | ${o.status}\n`;
    }
  }

  return { summary, data: { stats, recent: recentOrders, moonpay_configured: moonpay.isConfigured() } };
}

module.exports = {
  INTENT_REGISTRY,
  parseIntent,
  executeTask,
  saveConversation,
  getConversationHistory,
  getTaskHistory,
  listScheduledTasks,
  createScheduledTask,
  toggleScheduledTask,
};
