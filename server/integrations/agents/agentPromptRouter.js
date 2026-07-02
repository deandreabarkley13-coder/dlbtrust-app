'use strict';

/**
 * Agent Prompt Router — Natural Language Command Interpreter
 *
 * Parses natural language prompts and routes them to the appropriate
 * Trustee Agent or Bookkeeping Agent methods. Uses keyword/intent
 * scoring to match user requests to available actions.
 */

var path = require('path');

// ─── Intent Definitions ──────────────────────────────────────────────────────

var TRUSTEE_INTENTS = [
  {
    id: 'asset_review',
    keywords: ['asset', 'review', 'portfolio', 'holdings', 'bonds', 'bond', 'cash position', 'inspect', 'examine assets', 'investment', 'check assets', 'look at assets', 'asset oversight', 'review assets', 'show assets', 'what assets', 'how are the assets', 'trust assets', 'inspect holdings'],
    phrases: ['run asset review', 'asset review', 'review the assets', 'check portfolio', 'inspect portfolio', 'look at bonds', 'check bonds', 'show bond portfolio', 'what is our cash position', 'how much cash do we have', 'whats the portfolio look like', 'review trust assets', 'examine the trust holdings', 'show me the assets', 'what does the portfolio look like', 'analyze assets', 'audit assets'],
    description: 'Inspect bond portfolio, cash positions, and GL balances',
    action: 'runAssetReview',
  },
  {
    id: 'compliance_check',
    keywords: ['compliance', 'compliant', 'trial balance', 'balanced', 'books balanced', 'integrity', 'audit', 'regulatory', 'fiduciary', 'verify books', 'check compliance', 'run compliance', 'accounting integrity', 'corpus'],
    phrases: ['run compliance check', 'check compliance', 'are the books balanced', 'verify compliance', 'trial balance check', 'is everything compliant', 'check accounting integrity', 'verify the books', 'audit the books', 'fiduciary compliance', 'are we in compliance', 'regulatory check', 'trust compliance', 'check the trial balance', 'is the corpus intact', 'verify corpus integrity'],
    description: 'Validate trust accounting integrity, balanced books, and authorization',
    action: 'runComplianceCheck',
  },
  {
    id: 'review_distributions',
    keywords: ['distribution', 'distributions', 'payment', 'payments', 'pending payment', 'disbursement', 'payout', 'wire', 'ach', 'coupon', 'approve payment', 'pending wire', 'pending ach'],
    phrases: ['review distributions', 'show distributions', 'pending payments', 'any payments pending', 'what payments are due', 'show pending wires', 'show pending ach', 'review pending distributions', 'check distributions', 'list distributions', 'what needs to be paid', 'any disbursements', 'review payouts', 'check pending transfers', 'approve distributions'],
    description: 'Review and approve pending wire, ACH, and coupon distributions',
    action: 'reviewDistributions',
  },
  {
    id: 'generate_duties',
    keywords: ['generate duties', 'create tasks', 'daily duties', 'schedule tasks', 'generate tasks', 'today duties', 'create duties', 'trustee duties', 'daily tasks'],
    phrases: ['generate today duties', 'generate todays duties', 'create daily tasks', 'what are my duties today', 'generate trustee duties', 'create trustee tasks', 'schedule today tasks', 'set up todays duties', 'plan today', 'what should i do today', 'start the day', 'morning duties', 'daily checklist', 'generate task list'],
    description: 'Generate and schedule daily trustee tasks and duties',
    action: 'generateDuties',
  },
  {
    id: 'execute_task',
    keywords: ['execute task', 'run task', 'complete task', 'perform task', 'do task'],
    phrases: ['execute task', 'run task', 'complete task', 'perform task', 'finish task', 'do task'],
    description: 'Execute a specific trustee task by ID',
    action: 'executeTask',
    requiresParam: 'taskId',
    paramPattern: /(?:task|id)\s*[:#]?\s*([A-Z0-9_-]+)/i,
    altPattern: /\b(T-\d+[A-Z0-9]*)\b/i,
  },
  {
    id: 'list_tasks',
    keywords: ['list tasks', 'show tasks', 'view tasks', 'my tasks', 'task list', 'open tasks', 'pending tasks', 'all tasks'],
    phrases: ['list tasks', 'show tasks', 'show my tasks', 'what tasks are there', 'list all tasks', 'view task list', 'show pending tasks', 'open tasks', 'what tasks do i have', 'outstanding tasks'],
    description: 'List all trustee tasks',
    action: 'listTasks',
  },
  {
    id: 'list_reviews',
    keywords: ['list reviews', 'show reviews', 'view reviews', 'past reviews', 'review history', 'all reviews'],
    phrases: ['list reviews', 'show reviews', 'review history', 'show past reviews', 'what reviews have been done', 'list all reviews', 'view review history'],
    description: 'List past trustee reviews and reports',
    action: 'listReviews',
  },
  {
    id: 'dashboard',
    keywords: ['dashboard', 'overview', 'summary', 'status', 'health', 'quick look', 'snapshot'],
    phrases: ['show dashboard', 'show me the dashboard', 'trust overview', 'give me a summary', 'system status', 'health check', 'quick summary', 'whats the status', 'how is the trust doing', 'trust snapshot', 'give me an overview'],
    description: 'Show trustee dashboard with health indicators and summary',
    action: 'getDashboard',
  },
];

var BOOKKEEPING_INTENTS = [
  {
    id: 'reconcile_ach',
    keywords: ['reconcile ach', 'ach reconciliation', 'match ach', 'ach entries', 'ach payments', 'reconcile ach payments'],
    phrases: ['reconcile ach', 'reconcile ach payments', 'match ach entries', 'run ach reconciliation', 'ach reconciliation', 'match ach to journal', 'reconcile the ach batches', 'check ach reconciliation', 'are ach payments reconciled'],
    description: 'Match settled ACH payments to journal entries',
    action: 'reconcileACH',
  },
  {
    id: 'reconcile_wires',
    keywords: ['reconcile wire', 'wire reconciliation', 'match wire', 'wire entries', 'wire payments', 'reconcile wires'],
    phrases: ['reconcile wires', 'reconcile wire transfers', 'match wire entries', 'run wire reconciliation', 'wire reconciliation', 'match wires to journal', 'reconcile the wire transfers', 'check wire reconciliation', 'are wires reconciled'],
    description: 'Match settled wire transfers to journal entries',
    action: 'reconcileWires',
  },
  {
    id: 'reconcile_all',
    keywords: ['reconcile all', 'full reconciliation', 'reconcile everything', 'reconcile payments'],
    phrases: ['reconcile all payments', 'reconcile everything', 'full reconciliation', 'reconcile all', 'run full reconciliation', 'match all payments'],
    description: 'Run both ACH and wire reconciliation',
    action: 'reconcileAll',
  },
  {
    id: 'auto_post',
    keywords: ['auto post', 'auto-post', 'post unreconciled', 'journal entries', 'post entries', 'unreconciled', 'create journal'],
    phrases: ['auto post', 'auto-post unreconciled', 'post journal entries', 'create journal entries for unmatched', 'post unreconciled entries', 'auto post journal entries', 'create entries for unmatched payments', 'post missing journal entries'],
    description: 'Auto-post journal entries for unreconciled settled payments',
    action: 'autoPostUnreconciled',
  },
  {
    id: 'financial_summary',
    keywords: ['financial summary', 'financial report', 'balance sheet', 'income statement', 'trial balance', 'financial statements', 'report', 'financials'],
    phrases: ['generate financial summary', 'show financial summary', 'financial report', 'show me the financials', 'balance sheet', 'income statement', 'trial balance', 'generate report', 'show financial statements', 'whats our financial position', 'financial overview', 'how are the books looking', 'generate financial report'],
    description: 'Generate balance sheet, income statement, and trial balance',
    action: 'generateFinancialSummary',
  },
  {
    id: 'anomaly_scan',
    keywords: ['anomaly', 'anomalies', 'scan', 'detect', 'discrepancy', 'discrepancies', 'imbalance', 'suspicious', 'irregular', 'stale', 'negative balance'],
    phrases: ['scan for anomalies', 'detect anomalies', 'anomaly scan', 'check for discrepancies', 'any irregularities', 'find anomalies', 'check for imbalances', 'look for suspicious activity', 'stale payments', 'negative balances', 'anything unusual', 'check for problems', 'audit scan'],
    description: 'Scan for imbalances, stale payments, negative balances, and other anomalies',
    action: 'detectAnomalies',
  },
  {
    id: 'generate_duties',
    keywords: ['generate duties', 'create tasks', 'daily duties', 'schedule tasks', 'generate tasks', 'today duties', 'bookkeeping duties', 'daily tasks'],
    phrases: ['generate today duties', 'generate todays duties', 'create daily tasks', 'what are my duties today', 'generate bookkeeping duties', 'create bookkeeping tasks', 'schedule today tasks', 'daily bookkeeping checklist', 'plan today', 'morning duties', 'what should i do today'],
    description: 'Generate daily bookkeeping tasks',
    action: 'generateDuties',
  },
  {
    id: 'execute_task',
    keywords: ['execute task', 'run task', 'complete task', 'perform task', 'do task'],
    phrases: ['execute task', 'run task', 'complete task', 'perform task', 'finish task'],
    description: 'Execute a specific bookkeeping task by ID',
    action: 'executeTask',
    requiresParam: 'taskId',
    paramPattern: /(?:task|id)\s*[:#]?\s*([A-Z0-9_-]+)/i,
    altPattern: /\b(BK-\d+[A-Z0-9]*)\b/i,
  },
  {
    id: 'post_ach_entry',
    keywords: ['post ach', 'journal entry ach', 'ach journal'],
    phrases: ['post journal entry for ach', 'post ach batch', 'create ach journal entry', 'record ach batch'],
    description: 'Post a journal entry for a specific ACH batch',
    action: 'postACHJournalEntry',
    requiresParam: 'batchId',
    paramPattern: /(?:batch|id)\s*[:#]?\s*([A-Z0-9_-]+)/i,
    altPattern: /\b(ACH-[A-Z0-9-]+)\b/i,
  },
  {
    id: 'post_wire_entry',
    keywords: ['post wire', 'journal entry wire', 'wire journal'],
    phrases: ['post journal entry for wire', 'post wire transfer', 'create wire journal entry', 'record wire transfer'],
    description: 'Post a journal entry for a specific wire transfer',
    action: 'postWireJournalEntry',
    requiresParam: 'wireId',
    paramPattern: /(?:wire|id)\s*[:#]?\s*([A-Z0-9_-]+)/i,
    altPattern: /\b(W-[A-Z0-9-]+)\b/i,
  },
  {
    id: 'list_tasks',
    keywords: ['list tasks', 'show tasks', 'view tasks', 'my tasks', 'task list', 'open tasks'],
    phrases: ['list tasks', 'show tasks', 'what tasks are there', 'list all tasks', 'show pending tasks', 'outstanding tasks'],
    description: 'List all bookkeeping tasks',
    action: 'listTasks',
  },
  {
    id: 'list_reconciliations',
    keywords: ['list reconciliations', 'show reconciliations', 'reconciliation history', 'past reconciliations', 'recon history'],
    phrases: ['list reconciliations', 'show reconciliation history', 'past reconciliations', 'view reconciliations', 'reconciliation history'],
    description: 'List reconciliation history',
    action: 'listReconciliations',
  },
  {
    id: 'dashboard',
    keywords: ['dashboard', 'overview', 'summary', 'status', 'health', 'snapshot'],
    phrases: ['show dashboard', 'show me the dashboard', 'bookkeeping overview', 'give me a summary', 'system status', 'quick summary', 'whats the status'],
    description: 'Show bookkeeping dashboard summary',
    action: 'getDashboard',
  },
  {
    id: 'reverse_transaction',
    keywords: ['reverse', 'reversal', 'void', 'undo', 'cancel entry', 'reverse entry', 'reverse transaction', 'undo transaction'],
    phrases: ['reverse transaction', 'reverse entry', 'reverse this entry', 'void transaction', 'undo transaction', 'cancel journal entry', 'reverse the last entry', 'reverse the duplicate', 'void the entry', 'undo the posting'],
    description: 'Reverse a journal entry (creates mirror reversal entry)',
    action: 'reverseTransaction',
    requiresParam: 'entryId',
    paramPattern: /(?:entry|id|JRN)\s*[:#]?\s*(JRN-[A-Z0-9-]+|[A-Z0-9_-]+)/i,
    altPattern: /\b(JRN-[A-Z0-9-]+)\b/i,
  },
  {
    id: 'detect_duplicates',
    keywords: ['duplicate', 'duplicates', 'double', 'double posted', 'double entry', 'find duplicates', 'detect duplicates'],
    phrases: ['detect duplicates', 'find duplicates', 'scan for duplicates', 'check for duplicates', 'is there a duplicate', 'find double posted', 'double posted transaction', 'i double posted', 'duplicate detection', 'check for double entries'],
    description: 'Scan for duplicate transactions by amount and timing',
    action: 'detectDuplicates',
  },
  {
    id: 'reverse_duplicate',
    keywords: ['reverse duplicate', 'fix duplicate', 'correct duplicate', 'undo duplicate'],
    phrases: ['reverse the duplicate', 'fix the duplicate', 'correct the duplicate', 'reverse duplicate transaction', 'undo the duplicate', 'fix double posting'],
    description: 'Find and reverse a duplicate transaction by amount',
    action: 'reverseDuplicate',
    requiresParam: 'amount',
    paramPattern: /\$?\s*([\d,]+(?:\.\d{2})?)/,
  },
  {
    id: 'post_adjustment',
    keywords: ['adjustment', 'adjusting entry', 'correction', 'correct', 'reclassify', 'write off', 'accrual'],
    phrases: ['post adjustment', 'post adjusting entry', 'make a correction', 'post correction', 'reclassify entry', 'write off', 'post accrual', 'adjusting journal entry', 'correct the entry'],
    description: 'Post an adjusting/correcting journal entry',
    action: 'postAdjustment',
  },
  {
    id: 'reconcile_bill',
    keywords: ['reconcile bill', 'bill reconciliation', 'bill cash reconciliation', 'reconcile bill cash', 'match bill'],
    phrases: ['reconcile bill cash', 'run bill reconciliation', 'match bill deposits', 'reconcile bill.com', 'bill cash reconciliation', 'check bill reconciliation'],
    description: 'Reconcile BILL Cash deposits with journal entries',
    action: 'reconcileBILLCash',
  },
  {
    id: 'monthly_close',
    keywords: ['monthly close', 'close month', 'period close', 'month end', 'close the books', 'close period'],
    phrases: ['monthly close', 'close the month', 'run monthly close', 'month end close', 'close the books', 'close this period', 'period close procedures', 'end of month', 'run close procedures'],
    description: 'Run monthly close procedures (reconcile all, post accruals, generate reports)',
    action: 'monthlyClose',
  },
  {
    id: 'approve_payment',
    keywords: ['approve payment', 'approve', 'payment approval', 'authorize payment'],
    phrases: ['approve payment', 'approve the payment', 'authorize payment', 'approve vendor payment', 'approve pending payment'],
    description: 'Approve a pending vendor payment',
    action: 'approvePayment',
    requiresParam: 'paymentId',
    paramPattern: /(?:payment|id)\s*[:#]?\s*([A-Z0-9_-]+)/i,
    altPattern: /\b(VP-[A-Z0-9-]+)\b/i,
  },
  {
    id: 'process_payments',
    keywords: ['process payments', 'execute payments', 'run payments', 'send payments', 'pay vendors'],
    phrases: ['process payments', 'process pending payments', 'execute approved payments', 'run vendor payments', 'pay the vendors', 'process all payments', 'send the payments'],
    description: 'Process and execute all approved vendor payments',
    action: 'processPendingPayments',
  },
  {
    id: 'pending_payments',
    keywords: ['pending payments', 'awaiting approval', 'payment queue', 'unapproved payments'],
    phrases: ['show pending payments', 'list pending payments', 'what payments are pending', 'payments awaiting approval', 'payment queue', 'unapproved payments', 'payments needing approval'],
    description: 'Show payments awaiting approval',
    action: 'getPendingPayments',
  },
  {
    id: 'data_bridge_sync',
    keywords: ['sync', 'bridge', 'data bridge', 'full sync', 'sync all', 'sync modules', 'cross module', 'data flow'],
    phrases: ['run full sync', 'sync all modules', 'data bridge sync', 'sync everything', 'run data bridge', 'cross module sync', 'sync data flow', 'bridge the data', 'sync bonds and ach', 'sync all data'],
    description: 'Run full cross-module data sync (bonds, ACH, BILL, Fineract)',
    action: 'dataBridgeSync',
  },
  {
    id: 'data_bridge_reconcile',
    keywords: ['reconcile cash', 'reconcile gl', 'fineract reconcile', 'cash reconciliation', 'gl reconciliation', 'reconciliation report', 'data reconciliation'],
    phrases: ['reconcile with fineract', 'reconcile cash balances', 'generate reconciliation report', 'check data reconciliation', 'cross module reconciliation', 'are modules in sync', 'check sync status', 'reconcile all modules'],
    description: 'Reconcile trust accounting with cash management and Fineract GL',
    action: 'dataBridgeReconcile',
  },
  {
    id: 'data_bridge_status',
    keywords: ['bridge status', 'sync status', 'data flow status', 'module status', 'sync health'],
    phrases: ['show bridge status', 'data flow status', 'sync health', 'how is the sync', 'are modules synced', 'check sync health', 'data bridge status', 'show data flow'],
    description: 'Show cross-module data flow status and sync health',
    action: 'dataBridgeStatus',
  },
];

// ─── Scoring Engine ──────────────────────────────────────────────────────────

function normalizeInput(text) {
  return text.toLowerCase().replace(/['']/g, "'").replace(/[?!.,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function scoreIntent(input, intent) {
  var score = 0;
  var normalized = normalizeInput(input);

  // Exact phrase match (highest weight)
  for (var i = 0; i < intent.phrases.length; i++) {
    if (normalized.indexOf(intent.phrases[i]) !== -1) {
      score += 10;
      break;
    }
  }

  // Keyword matching (partial)
  var matchedKeywords = 0;
  for (var k = 0; k < intent.keywords.length; k++) {
    if (normalized.indexOf(intent.keywords[k]) !== -1) {
      matchedKeywords++;
    }
  }
  score += matchedKeywords * 3;

  // Individual word overlap with keywords
  var words = normalized.split(' ');
  for (var w = 0; w < words.length; w++) {
    if (words[w].length < 3) continue;
    for (var j = 0; j < intent.keywords.length; j++) {
      if (intent.keywords[j].indexOf(words[w]) !== -1 || words[w].indexOf(intent.keywords[j]) !== -1) {
        score += 1;
      }
    }
  }

  return score;
}

function extractParam(input, intent) {
  if (!intent.requiresParam) return null;
  var match = input.match(intent.paramPattern);
  if (match) return match[1];
  if (intent.altPattern) {
    match = input.match(intent.altPattern);
    if (match) return match[1];
  }
  // Try to find any ID-like token
  var tokens = input.match(/\b[A-Z0-9]+-[A-Z0-9-]+\b/gi);
  if (tokens && tokens.length > 0) return tokens[0];
  return null;
}

// ─── Router ──────────────────────────────────────────────────────────────────

class AgentPromptRouter {

  /**
   * Route a natural language prompt to the Trustee Agent.
   * Returns { intent, action, description, result, message }
   */
  static async routeTrustee(prompt) {
    var { TrusteeAgent } = require(path.join(__dirname, 'trusteeAgent'));

    var bestScore = 0;
    var bestIntent = null;
    for (var i = 0; i < TRUSTEE_INTENTS.length; i++) {
      var s = scoreIntent(prompt, TRUSTEE_INTENTS[i]);
      if (s > bestScore) {
        bestScore = s;
        bestIntent = TRUSTEE_INTENTS[i];
      }
    }

    if (!bestIntent || bestScore < 3) {
      return {
        understood: false,
        message: 'I didn\'t understand that request. Here are the trustee duties I can perform:',
        availableActions: TRUSTEE_INTENTS.map(function(i) { return { id: i.id, description: i.description, example: i.phrases[0] }; }),
      };
    }

    var param = extractParam(prompt, bestIntent);
    if (bestIntent.requiresParam && !param) {
      return {
        understood: true,
        needsParam: true,
        intent: bestIntent.id,
        message: 'I need a ' + bestIntent.requiresParam + ' to execute this action. Please provide the task ID.',
        description: bestIntent.description,
      };
    }

    var result;
    try {
      switch (bestIntent.action) {
        case 'runAssetReview':
          result = await TrusteeAgent.runAssetReview();
          break;
        case 'runComplianceCheck':
          result = await TrusteeAgent.runComplianceCheck();
          break;
        case 'reviewDistributions':
          result = await TrusteeAgent.reviewDistributions();
          break;
        case 'generateDuties':
          result = await TrusteeAgent.generateDuties();
          break;
        case 'executeTask':
          result = await TrusteeAgent.executeTask(param);
          break;
        case 'listTasks':
          result = await TrusteeAgent.listTasks({});
          break;
        case 'listReviews':
          result = await TrusteeAgent.listReviews({});
          break;
        case 'getDashboard':
          result = await TrusteeAgent.getDashboard();
          break;
        default:
          return { understood: false, message: 'Action not implemented: ' + bestIntent.action };
      }
    } catch (err) {
      return {
        understood: true,
        intent: bestIntent.id,
        action: bestIntent.action,
        description: bestIntent.description,
        error: err.message,
        message: 'Error executing ' + bestIntent.description + ': ' + err.message,
      };
    }

    return {
      understood: true,
      intent: bestIntent.id,
      action: bestIntent.action,
      description: bestIntent.description,
      confidence: Math.min(bestScore / 15, 1),
      result: result,
      message: formatTrusteeResult(bestIntent, result),
    };
  }

  /**
   * Route a natural language prompt to the Bookkeeping Agent.
   * Returns { intent, action, description, result, message }
   */
  static async routeBookkeeping(prompt) {
    var { BookkeepingAgent } = require(path.join(__dirname, 'bookkeepingAgent'));

    var bestScore = 0;
    var bestIntent = null;
    for (var i = 0; i < BOOKKEEPING_INTENTS.length; i++) {
      var s = scoreIntent(prompt, BOOKKEEPING_INTENTS[i]);
      if (s > bestScore) {
        bestScore = s;
        bestIntent = BOOKKEEPING_INTENTS[i];
      }
    }

    if (!bestIntent || bestScore < 3) {
      return {
        understood: false,
        message: 'I didn\'t understand that request. Here are the bookkeeping duties I can perform:',
        availableActions: BOOKKEEPING_INTENTS.map(function(i) { return { id: i.id, description: i.description, example: i.phrases[0] }; }),
      };
    }

    var param = extractParam(prompt, bestIntent);
    if (bestIntent.requiresParam && !param) {
      return {
        understood: true,
        needsParam: true,
        intent: bestIntent.id,
        message: 'I need a ' + bestIntent.requiresParam + ' to execute this action. Please provide it in your request.',
        description: bestIntent.description,
      };
    }

    var result;
    try {
      switch (bestIntent.action) {
        case 'reconcileACH':
          result = await BookkeepingAgent.reconcileACH();
          break;
        case 'reconcileWires':
          result = await BookkeepingAgent.reconcileWires();
          break;
        case 'reconcileAll':
          var achResult = await BookkeepingAgent.reconcileACH();
          var wireResult = await BookkeepingAgent.reconcileWires();
          result = { ach: achResult, wires: wireResult };
          break;
        case 'autoPostUnreconciled':
          result = await BookkeepingAgent.autoPostUnreconciled();
          break;
        case 'generateFinancialSummary':
          result = await BookkeepingAgent.generateFinancialSummary();
          break;
        case 'detectAnomalies':
          result = await BookkeepingAgent.detectAnomalies();
          break;
        case 'generateDuties':
          result = await BookkeepingAgent.generateDuties();
          break;
        case 'executeTask':
          result = await BookkeepingAgent.executeTask(param);
          break;
        case 'postACHJournalEntry':
          result = await BookkeepingAgent.postACHJournalEntry(param);
          break;
        case 'postWireJournalEntry':
          result = await BookkeepingAgent.postWireJournalEntry(param);
          break;
        case 'listTasks':
          result = await BookkeepingAgent.listTasks({});
          break;
        case 'listReconciliations':
          result = await BookkeepingAgent.listReconciliations({});
          break;
        case 'getDashboard':
          result = await BookkeepingAgent.getDashboard();
          break;
        case 'reverseTransaction':
          result = await BookkeepingAgent.reverseTransaction(param, { reason: 'Reversed via prompt', approvedBy: 'admin' });
          break;
        case 'detectDuplicates':
          result = await BookkeepingAgent.detectDuplicates({ windowHours: 168, minAmount: 1000 });
          break;
        case 'reverseDuplicate':
          var amt = param ? parseFloat(param.replace(/,/g, '')) : null;
          if (!amt) return { understood: true, needsParam: true, intent: 'reverse_duplicate', message: 'I need the dollar amount of the duplicate to reverse.' };
          result = await BookkeepingAgent.reverseDuplicate(amt, { reason: 'Duplicate reversal via prompt' });
          break;
        case 'postAdjustment':
          return { understood: true, needsParam: true, intent: 'post_adjustment', message: 'To post an adjustment, please use the Bookkeeping panel and specify: description, accounts, amounts, and reason.' };
        case 'reconcileBILLCash':
          result = await BookkeepingAgent.reconcileBILLCash();
          break;
        case 'monthlyClose':
          result = await BookkeepingAgent.monthlyClose({ closedBy: 'admin' });
          break;
        case 'approvePayment':
          result = await BookkeepingAgent.approvePayment(param, { approvedBy: 'admin' });
          break;
        case 'processPendingPayments':
          result = await BookkeepingAgent.processPendingPayments();
          break;
        case 'getPendingPayments':
          result = await BookkeepingAgent.getPendingPayments();
          break;
        case 'dataBridgeSync':
          var { DataBridge } = require(path.join(__dirname, '../accounting/dataBridge'));
          result = await DataBridge.runFullSync();
          break;
        case 'dataBridgeReconcile':
          var { DataBridge: DB2 } = require(path.join(__dirname, '../accounting/dataBridge'));
          result = await DB2.getReconciliationReport();
          break;
        case 'dataBridgeStatus':
          var { DataBridge: DB3 } = require(path.join(__dirname, '../accounting/dataBridge'));
          result = await DB3.getDataFlowStatus();
          break;
        default:
          return { understood: false, message: 'Action not implemented: ' + bestIntent.action };
      }
    } catch (err) {
      return {
        understood: true,
        intent: bestIntent.id,
        action: bestIntent.action,
        description: bestIntent.description,
        error: err.message,
        message: 'Error executing ' + bestIntent.description + ': ' + err.message,
      };
    }

    return {
      understood: true,
      intent: bestIntent.id,
      action: bestIntent.action,
      description: bestIntent.description,
      confidence: Math.min(bestScore / 15, 1),
      result: result,
      message: formatBookkeepingResult(bestIntent, result),
    };
  }
}

// ─── Result Formatters ────────────────────────────────────────────────────────

function formatCurrency(val) {
  if (val == null) return '$0.00';
  return '$' + Number(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatTrusteeResult(intent, result) {
  switch (intent.action) {
    case 'runAssetReview':
      var findings = result.findings || [];
      var msg = 'Asset Review Complete (ID: ' + result.reviewId + '). ';
      if (result.summary.bonds) msg += 'Bonds: ' + result.summary.bonds.count + ' active (' + formatCurrency(result.summary.bonds.totalFaceValue) + '). ';
      if (result.summary.cash) msg += 'Cash: ' + formatCurrency(result.summary.cash.totalBalance) + '. ';
      if (result.summary.accounting) msg += 'Books: ' + (result.summary.accounting.isBalanced ? 'Balanced' : 'IMBALANCED') + '. ';
      if (findings.length > 0) {
        msg += findings.length + ' finding(s): ';
        msg += findings.map(function(f) { return '[' + f.severity + '] ' + f.issue; }).join('; ');
      } else {
        msg += 'No issues found.';
      }
      return msg;

    case 'runComplianceCheck':
      return (result.allPassed ? 'All compliance checks passed' : result.passed + '/' + result.total + ' checks passed') + '. ' +
        result.checks.map(function(c) { return (c.passed ? 'PASS' : 'FAIL') + ' ' + c.check + ': ' + c.detail; }).join('. ');

    case 'reviewDistributions':
      if (result.items.length === 0) return 'No pending distributions at this time.';
      return result.pendingCount + ' pending distribution(s) totaling ' + formatCurrency(result.totalPendingAmount) + '. ' +
        result.items.map(function(i) { return i.type.toUpperCase() + ' ' + i.id + ': ' + formatCurrency(i.amount) + ' (' + i.status + ')'; }).join('; ');

    case 'generateDuties':
      return result.generated + ' trustee task(s) generated for ' + result.date + '.';

    case 'executeTask':
      return 'Task executed. Status: ' + result.status + (result.result ? '. ' + JSON.stringify(result.result) : '');

    case 'listTasks':
      if (!result || result.length === 0) return 'No trustee tasks found. Generate duties to create tasks.';
      return result.length + ' task(s): ' + result.slice(0, 5).map(function(t) { return t.task_id + ' — ' + t.title + ' [' + t.status + ']'; }).join('; ') +
        (result.length > 5 ? '... and ' + (result.length - 5) + ' more.' : '');

    case 'listReviews':
      if (!result || result.length === 0) return 'No reviews found. Run an asset review or compliance check to generate one.';
      return result.length + ' review(s): ' + result.slice(0, 5).map(function(r) { return r.review_id + ' — ' + r.review_type + ' [' + r.status + ']'; }).join('; ');

    case 'getDashboard':
      var h = result.health || {};
      return 'Trust Overview: ' + result.pendingTasks + ' pending task(s), ' + result.completedThisMonth + ' completed this month. ' +
        'Bonds: ' + (h.bonds != null ? h.bonds : '—') + ' active. ' +
        'Cash: ' + (h.cash ? formatCurrency(h.cash.balance) + ' across ' + h.cash.accounts + ' account(s)' : '—') + '.';

    default:
      return 'Action completed successfully.';
  }
}

function formatBookkeepingResult(intent, result) {
  switch (intent.action) {
    case 'reconcileACH':
      return 'ACH Reconciliation Complete. Matched: ' + result.matched + ' (' + formatCurrency(result.totalMatched) + '). Unmatched: ' + result.unmatched + ' (' + formatCurrency(result.totalUnmatched) + ').';

    case 'reconcileWires':
      return 'Wire Reconciliation Complete. Matched: ' + result.matched + ' (' + formatCurrency(result.totalMatched) + '). Unmatched: ' + result.unmatched + ' (' + formatCurrency(result.totalUnmatched) + ').';

    case 'reconcileAll':
      return 'Full Reconciliation Complete. ACH: ' + result.ach.matched + ' matched, ' + result.ach.unmatched + ' unmatched. Wires: ' + result.wires.matched + ' matched, ' + result.wires.unmatched + ' unmatched.';

    case 'autoPostUnreconciled':
      return 'Auto-Post Complete. ACH entries posted: ' + result.achPosted + '. Wire entries posted: ' + result.wirePosted + '. Errors: ' + result.errors + '.';

    case 'generateFinancialSummary':
      var s = result.summary || result;
      var msg = 'Financial Summary: ';
      if (s.balanceSheet) msg += 'Total Assets: ' + formatCurrency(s.balanceSheet.totalAssets) + '. Total Liabilities: ' + formatCurrency(s.balanceSheet.totalLiabilities) + '. Equity: ' + formatCurrency(s.balanceSheet.equity) + '. ';
      if (s.trialBalance) msg += 'Trial Balance: ' + (s.trialBalance.isBalanced ? 'Balanced' : 'IMBALANCED') + '.';
      return msg;

    case 'detectAnomalies':
      if (result.anomalyCount === 0) return 'Anomaly scan complete. No anomalies detected.';
      return result.anomalyCount + ' anomaly(ies) found (' + result.highSeverity + ' high severity): ' +
        result.anomalies.map(function(a) { return '[' + a.severity + '] ' + a.type + ': ' + a.detail; }).join('; ');

    case 'generateDuties':
      return result.generated + ' bookkeeping task(s) generated for ' + result.date + '.';

    case 'executeTask':
      return 'Task executed. Status: ' + result.status + '.';

    case 'postACHJournalEntry':
      return 'Journal entry posted for ACH batch. Entry ID: ' + (result.entryId || 'N/A') + '.';

    case 'postWireJournalEntry':
      return 'Journal entry posted for wire transfer. Entry ID: ' + (result.entryId || 'N/A') + '.';

    case 'listTasks':
      if (!result || result.length === 0) return 'No bookkeeping tasks found. Generate duties to create tasks.';
      return result.length + ' task(s): ' + result.slice(0, 5).map(function(t) { return t.task_id + ' — ' + t.title + ' [' + t.status + ']'; }).join('; ') +
        (result.length > 5 ? '... and ' + (result.length - 5) + ' more.' : '');

    case 'listReconciliations':
      if (!result || result.length === 0) return 'No reconciliations found. Run an ACH or wire reconciliation to create one.';
      return result.length + ' reconciliation(s): ' + result.slice(0, 5).map(function(r) { return r.recon_id + ' — ' + r.recon_type + ' [' + r.status + ']'; }).join('; ');

    case 'getDashboard':
      return 'Bookkeeping Overview: ' + result.pendingTasks + ' pending task(s), ' + result.completedThisMonth + ' completed this month. ' +
        'Journal entries (7d): ' + result.journalsLast7Days + '. Recent reconciliations: ' + (result.recentReconciliations ? result.recentReconciliations.length : 0) + '.';

    case 'dataBridgeSync':
      return 'Full Sync Complete (' + result.durationMs + 'ms). Synced: ' + result.totalSynced + '. Failed: ' + result.totalFailed + '. ' +
        'Bonds: ' + (result.results.bonds.synced || 0) + ' | ACH: ' + (result.results.ach.synced || 0) + ' | BILL: ' + (result.results.bill.synced || 0) + ' | Fineract push: ' + (result.results.fineractPush.synced || 0) + '.';

    case 'dataBridgeReconcile':
      var sections = result.sections || [];
      var msgs = sections.map(function(s) {
        if (s.error) return s.title + ': Error';
        if (s.isReconciled !== undefined) return s.title + ': ' + (s.isReconciled ? 'Reconciled' : 'Diff $' + (s.difference || 0));
        if (s.matched !== undefined) return s.title + ': ' + s.matched + ' matched, ' + s.unmatched + ' unmatched';
        if (s.achUnsyncedBatches !== undefined) return 'Unsynced: ACH ' + s.achUnsyncedBatches + ', Bonds ' + s.bondUnsyncedAccruals + ', Wires ' + s.wiresMissingJE;
        if (s.count !== undefined) return s.count + ' unresolved discrepancies';
        return s.title;
      });
      return 'Reconciliation Report (' + (result.syncHealth || 'unknown') + '): ' + msgs.join('. ') + '.';

    case 'dataBridgeStatus':
      var health = result.syncHealth || 'unknown';
      var ta = result.modules.trust_accounting || {};
      var cashMod = result.modules.cash_management || {};
      return 'Data Flow Status: ' + health.toUpperCase() + '. Trust JEs: ' + (ta.journalEntries || 0) + ' (' + (ta.unsyncedToFineract || 0) + ' unsynced). ' +
        'Cash: ' + formatCurrency(cashMod.totalBalance || 0) + '. Discrepancies: ' + (result.unresolvedDiscrepancies || 0) + '.';

    default:
      return 'Action completed successfully.';
  }
}

module.exports = { AgentPromptRouter };
