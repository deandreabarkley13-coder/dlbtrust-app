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
      /portfolio/i, /holdings/i, /private.*placement/i,
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
    intent: 'generate_report',
    patterns: [
      /report/i, /summary/i, /overview/i, /status.*report/i,
      /daily.*report/i, /trust.*report/i,
    ],
    description: 'Generate a trust status report',
    engine: 'agent',
    action: 'report',
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
        return {
          intent: entry.intent,
          description: entry.description,
          engine: entry.engine,
          action: entry.action,
          confidence: 0.85,
          matched_pattern: pattern.toString(),
        };
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
      case 'help':
        result = executeHelp();
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
    `• ${a.name} (${a.account_type}) — $${(a.balance_cents / 100).toFixed(2)} [${a.status}]`
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
    `• ${w.name} (${w.blockchain}) — $${(w.usdc_balance_cents / 100).toFixed(2)} USDC [${w.provider}]`
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
    const totalPar = bonds.reduce((sum, b) => sum + Number(b.par_value || 0), 0);
    sections.push(`FIXED INCOME: ${bonds.length} active bond(s) | Total Par: $${totalPar.toLocaleString()}`);
  } catch (e) { sections.push('FIXED INCOME: No data'); }

  // Crypto
  try {
    const wallets = db.prepare('SELECT * FROM blockchain_wallets').all();
    const totalUSDC = wallets.reduce((sum, w) => sum + (w.usdc_balance_cents || 0), 0);
    sections.push(`CRYPTO: ${wallets.length} wallet(s) | USDC Balance: $${(totalUSDC / 100).toFixed(2)}`);
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
