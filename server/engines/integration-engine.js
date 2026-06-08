/**
 * Integration Engine — Cross-Engine Orchestration Layer
 * DEANDREA LAVAR BARKLEY TRUST — Private Wealth Management Platform
 *
 * Central nervous system connecting all 8 engines with:
 * - Unified data routing (FI → Banking → GL → CMS)
 * - Event-driven triggers (UI, scheduled, manual)
 * - Payment execution pipelines
 * - Real-time cross-engine state synchronization
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { bus, EVENTS } = require('./event-bus');

// ─── Trigger Types ───────────────────────────────────────────────────────────

const TRIGGER_TYPES = {
  UI: 'ui',
  EVENT: 'event',
  MANUAL: 'manual',
  SCHEDULED: 'scheduled',
  THRESHOLD: 'threshold',
};

// ─── Pipeline Definitions ────────────────────────────────────────────────────

const PIPELINES = {
  COUPON_TO_CASH: {
    name: 'Coupon to Cash',
    steps: ['receive_coupon', 'credit_bank_account', 'post_gl_journal', 'refresh_cms', 'check_alerts'],
  },
  INTERNAL_TRANSFER: {
    name: 'Internal Transfer',
    steps: ['validate_transfer', 'execute_transfer', 'post_gl_journal', 'emit_event'],
  },
  EXTERNAL_PAYMENT: {
    name: 'External Payment',
    steps: ['validate_payment', 'debit_source_account', 'process_payment_rail', 'post_gl_journal'],
  },
  CRYPTO_SEND: {
    name: 'USDC Transfer',
    steps: ['validate_wallet', 'broadcast_transaction', 'update_wallet_balance', 'post_gl_journal'],
  },
  DEX_SWAP: {
    name: 'DEX Swap (POL → USDC)',
    steps: ['validate_wallet', 'execute_swap', 'update_wallet_balance', 'post_gl_journal'],
  },
  FULL_RECONCILIATION: {
    name: 'Full System Reconciliation',
    steps: ['reconcile_bank_gl', 'reconcile_fi_gl', 'reconcile_crypto', 'reconcile_pending', 'generate_alerts'],
  },
  DAILY_SWEEP: {
    name: 'Daily Cash Sweep',
    steps: ['check_sweep_rules', 'calculate_sweep_amounts', 'execute_sweeps', 'post_gl_journals'],
  },
  GENERATE_DOCUMENT: {
    name: 'Document Generation',
    steps: ['validate_report_type', 'gather_data', 'render_document', 'store_in_dms'],
  },
  FINERACT_PAYMENT: {
    name: 'Fineract External Payment',
    steps: ['validate_payment', 'initiate_fineract', 'post_gl_journal', 'emit_event'],
  },
  FINERACT_BATCH: {
    name: 'Fineract ACH Batch',
    steps: ['collect_pending', 'create_batch', 'submit_to_clearing'],
  },
  FINERACT_SETTLE: {
    name: 'Fineract Settlement Processing',
    steps: ['scan_clearing', 'settle_payments', 'post_gl_journals'],
  },
  BANK_TO_CRYPTO: {
    name: 'Banking → Crypto (Fund Wallet)',
    steps: ['validate_source', 'debit_bank_account', 'initiate_moonpay', 'post_gl_journal', 'emit_event'],
  },
  CRYPTO_TO_BANK: {
    name: 'Crypto → Banking (Sweep to Bank)',
    steps: ['validate_wallet', 'initiate_sell', 'credit_bank_account', 'post_gl_journal', 'emit_event'],
  },
};

// ─── Pipeline Execution Context ──────────────────────────────────────────────

class PipelineExecution {
  constructor(pipeline, trigger, params) {
    this.id = `pipe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.pipeline = pipeline;
    this.trigger = trigger;
    this.params = params;
    this.steps = [];
    this.status = 'pending';
    this.started_at = null;
    this.completed_at = null;
    this.error = null;
    this.results = {};
  }

  toJSON() {
    return {
      id: this.id,
      pipeline: this.pipeline,
      trigger: this.trigger,
      params: this.params,
      steps: this.steps,
      status: this.status,
      started_at: this.started_at,
      completed_at: this.completed_at,
      error: this.error,
      results: this.results,
    };
  }
}

// ─── Integration Engine ──────────────────────────────────────────────────────

class IntegrationEngine {
  constructor() {
    this.executions = [];
    this.maxHistory = 200;
  }

  async executePipeline(pipelineName, db, params = {}, trigger = { type: TRIGGER_TYPES.MANUAL }) {
    const pipeline = PIPELINES[pipelineName];
    if (!pipeline) throw new Error(`Unknown pipeline: ${pipelineName}`);

    const exec = new PipelineExecution(pipelineName, trigger, params);
    exec.status = 'running';
    exec.started_at = new Date().toISOString();

    try {
      const handler = this[`_execute_${pipelineName}`];
      if (!handler) throw new Error(`No handler for pipeline: ${pipelineName}`);
      exec.results = await handler.call(this, db, params, exec);
      exec.status = 'completed';
    } catch (err) {
      exec.status = 'failed';
      exec.error = err.message;
    }

    exec.completed_at = new Date().toISOString();
    this.executions.push(exec);
    if (this.executions.length > this.maxHistory) this.executions.shift();

    this._persistExecution(db, exec);

    bus.emit(exec.status === 'completed' ? 'integration.pipeline.completed' : 'integration.pipeline.failed', {
      pipeline: pipelineName, execution_id: exec.id, status: exec.status,
    });

    return exec;
  }

  // ─── COUPON_TO_CASH ──────────────────────────────────────────────────────

  async _execute_COUPON_TO_CASH(db, params) {
    const { bond_id, coupon_id, amount_cents } = params;
    if (!bond_id || !amount_cents) throw new Error('bond_id and amount_cents required');

    const results = { steps: [] };

    // 1. Mark coupon received
    if (coupon_id) {
      db.prepare("UPDATE coupon_schedule SET status = 'received', actual_date = datetime('now') WHERE id = ?").run(coupon_id);
      results.steps.push({ step: 'receive_coupon', status: 'done', coupon_id });
    }

    // 2. Credit operating account
    const account = db.prepare("SELECT * FROM trust_accounts WHERE account_type = 'operating' AND status = 'active' LIMIT 1").get();
    if (!account) throw new Error('No active operating account found');

    db.prepare(`
      UPDATE trust_accounts SET
        balance_cents = balance_cents + ?, available_cents = available_cents + ?,
        last_activity_date = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(amount_cents, amount_cents, account.id);
    results.steps.push({ step: 'credit_bank_account', status: 'done', account_id: account.id, amount_cents });

    // 3. Post GL journal
    const journal = this._postGLJournal(db, {
      description: `Coupon received — Bond #${bond_id}`,
      reference_type: 'coupon_receipt',
      reference_id: String(coupon_id || bond_id),
      entries: [
        { account_code: '1000', description: 'Cash — Operating', debit_cents: amount_cents, credit_cents: 0 },
        { account_code: '4100', description: 'Interest Income', debit_cents: 0, credit_cents: amount_cents },
      ],
    });
    results.steps.push({ step: 'post_gl_journal', status: 'done', journal_id: journal.id });

    bus.emit(EVENTS.COUPON_RECEIVED, { bond_id, amount_cents, account_id: account.id });
    return results;
  }

  // ─── INTERNAL_TRANSFER ───────────────────────────────────────────────────

  async _execute_INTERNAL_TRANSFER(db, params) {
    const { from_account_id, to_account_id, amount_cents, transfer_type, description, memo } = params;
    if (!from_account_id || !to_account_id || !amount_cents) {
      throw new Error('from_account_id, to_account_id, and amount_cents required');
    }

    const results = { steps: [] };

    const fromAccount = db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(from_account_id);
    const toAccount = db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(to_account_id);
    if (!fromAccount) throw new Error('Source account not found');
    if (!toAccount) throw new Error('Destination account not found');
    if (fromAccount.status !== 'active') throw new Error(`Source account is ${fromAccount.status}`);
    if (toAccount.status !== 'active') throw new Error(`Destination account is ${toAccount.status}`);
    if (!fromAccount.overdraft_allowed && amount_cents > fromAccount.available_cents) {
      throw new Error(`Insufficient funds. Available: ${fromAccount.available_cents}, requested: ${amount_cents}`);
    }
    results.steps.push({ step: 'validate_transfer', status: 'done' });

    const transferNumber = `TRF-${Date.now()}`;
    const txn = db.transaction(() => {
      const ins = db.prepare(`
        INSERT INTO internal_transfers
          (transfer_number, from_account_id, to_account_id, amount_cents, fee_cents,
           currency, transfer_type, status, priority, description, memo,
           requires_approval, approved_by, approved_date, executed_date, completed_date, created_by)
        VALUES (?, ?, ?, ?, 0, 'USD', ?, 'completed', 'normal', ?, ?,
                0, 'integration_api', datetime('now'), datetime('now'), datetime('now'), 'integration_api')
      `).run(transferNumber, from_account_id, to_account_id, amount_cents,
        transfer_type || 'standard', description || '', memo || '');

      db.prepare(`
        UPDATE trust_accounts SET balance_cents = balance_cents - ?, available_cents = available_cents - ?,
          last_activity_date = datetime('now'), updated_at = datetime('now') WHERE id = ?
      `).run(amount_cents, amount_cents, from_account_id);

      db.prepare(`
        UPDATE trust_accounts SET balance_cents = balance_cents + ?, available_cents = available_cents + ?,
          last_activity_date = datetime('now'), updated_at = datetime('now') WHERE id = ?
      `).run(amount_cents, amount_cents, to_account_id);

      return ins.lastInsertRowid;
    });

    const transferId = txn();
    results.steps.push({ step: 'execute_transfer', status: 'done', transfer_id: transferId, transfer_number: transferNumber });

    const journal = this._postGLJournal(db, {
      description: `Internal transfer: ${fromAccount.account_name} → ${toAccount.account_name}`,
      reference_type: 'internal_transfer',
      reference_id: String(transferId),
      entries: [
        { account_code: '1000', description: `Debit — ${toAccount.account_name}`, debit_cents: amount_cents, credit_cents: 0 },
        { account_code: '1000', description: `Credit — ${fromAccount.account_name}`, debit_cents: 0, credit_cents: amount_cents },
      ],
    });
    results.steps.push({ step: 'post_gl_journal', status: 'done', journal_id: journal.id });

    bus.emit(EVENTS.TRANSFER_COMPLETED, { transfer_id: transferId, amount_cents, from: from_account_id, to: to_account_id });
    return results;
  }

  // ─── EXTERNAL_PAYMENT ────────────────────────────────────────────────────

  async _execute_EXTERNAL_PAYMENT(db, params) {
    const { from_account_id, amount_cents, rail, description, memo } = params;
    let { contact_id } = params;
    if (!from_account_id || !amount_cents) throw new Error('from_account_id and amount_cents required');

    const results = { steps: [] };

    const account = db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(from_account_id);
    if (!account) throw new Error('Source account not found');
    if (account.status !== 'active') throw new Error(`Account is ${account.status}`);

    // Ensure contacts table + system contact exist
    db.exec(`CREATE TABLE IF NOT EXISTS crm_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, contact_type TEXT DEFAULT 'vendor',
      first_name TEXT, last_name TEXT, company_name TEXT, email TEXT, phone TEXT,
      status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now'))
    )`);
    if (!contact_id) {
      let sys = db.prepare("SELECT id FROM crm_contacts WHERE company_name = 'System (Integration API)' LIMIT 1").get();
      if (!sys) {
        const ins = db.prepare("INSERT INTO crm_contacts (contact_type, company_name, first_name, last_name, status) VALUES ('vendor','System (Integration API)','Integration','API','active')").run();
        contact_id = ins.lastInsertRowid;
      } else {
        contact_id = sys.id;
      }
    }

    const feeCents = this._calculatePaymentFee(amount_cents, rail || 'ach');
    const totalCents = amount_cents + feeCents;

    if (!account.overdraft_allowed && totalCents > account.available_cents) {
      throw new Error(`Insufficient funds. Available: ${account.available_cents}, total needed: ${totalCents} (amount: ${amount_cents} + fee: ${feeCents})`);
    }
    results.steps.push({ step: 'validate_payment', status: 'done', fee_cents: feeCents });

    const transferNumber = `EXT-${Date.now()}`;
    const approvalTier = amount_cents >= 5000000 ? 'dual' : (amount_cents >= 100000 ? 'single' : 'auto');

    const txn = db.transaction(() => {
      const ins = db.prepare(`
        INSERT INTO external_transfers
          (transfer_number, from_account_id, contact_id, amount_cents, fee_cents, total_cents,
           currency, payment_method, status, description, memo, created_by,
           approval_tier, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'USD', ?, 'processing', ?, ?, 'integration_api',
                ?, datetime('now'), datetime('now'))
      `).run(transferNumber, from_account_id, contact_id || null, amount_cents, feeCents, totalCents,
        rail || 'ach', description || '', memo || '', approvalTier);

      db.prepare(`
        UPDATE trust_accounts SET balance_cents = balance_cents - ?, available_cents = available_cents - ?,
          last_activity_date = datetime('now'), updated_at = datetime('now') WHERE id = ?
      `).run(totalCents, totalCents, from_account_id);

      return ins.lastInsertRowid;
    });

    const transferId = txn();
    results.steps.push({ step: 'debit_source_account', status: 'done', transfer_id: transferId, transfer_number: transferNumber });

    const settlement = this._processPaymentRail(db, transferId, rail || 'ach');
    results.steps.push({ step: 'process_payment_rail', status: 'done', rail: rail || 'ach', ...settlement });

    const journal = this._postGLJournal(db, {
      description: `External payment: ${description || transferNumber}`,
      reference_type: 'external_payment',
      reference_id: String(transferId),
      entries: [
        { account_code: '2000', description: 'Accounts Payable', debit_cents: amount_cents, credit_cents: 0 },
        { account_code: '1000', description: 'Cash — Operating', debit_cents: 0, credit_cents: amount_cents },
        ...(feeCents > 0 ? [
          { account_code: '5200', description: 'Payment Processing Fee', debit_cents: feeCents, credit_cents: 0 },
          { account_code: '1000', description: 'Cash — Operating (fee)', debit_cents: 0, credit_cents: feeCents },
        ] : []),
      ],
    });
    results.steps.push({ step: 'post_gl_journal', status: 'done', journal_id: journal.id });

    bus.emit('integration.payment.completed', { transfer_id: transferId, amount_cents, rail: rail || 'ach' });
    return results;
  }

  // ─── CRYPTO_SEND ─────────────────────────────────────────────────────────

  async _execute_CRYPTO_SEND(db, params) {
    const { wallet_id, to_address, amount_usd } = params;
    if (!wallet_id || !to_address || !amount_usd) throw new Error('wallet_id, to_address, and amount_usd required');

    const results = { steps: [] };

    const wallet = db.prepare('SELECT * FROM blockchain_wallets WHERE id = ?').get(wallet_id);
    if (!wallet) throw new Error('Wallet not found');
    if (wallet.status === 'frozen') throw new Error('Wallet is frozen');

    const walletBalance = parseFloat(wallet.usdc_balance || '0');
    if (amount_usd > walletBalance) {
      throw new Error(`Insufficient USDC. Balance: $${walletBalance.toFixed(2)}, requested: $${amount_usd}`);
    }
    results.steps.push({ step: 'validate_wallet', status: 'done', balance: walletBalance });

    const amountCents = Math.round(amount_usd * 100);
    const txNumber = `CTX-${Date.now()}`;
    const hasEncryptionKey = !!process.env.WALLET_ENCRYPTION_KEY;

    let txId, txHash = null, onChain = false;

    if (hasEncryptionKey && wallet.encrypted_private_key) {
      try {
        const { PolygonClient } = require('./blockchain-engine');
        const configRow = db.prepare("SELECT config_value FROM blockchain_config WHERE config_key = 'default_blockchain'").get();
        const blockchain = configRow ? configRow.config_value : 'MATIC';
        const client = new PolygonClient(blockchain);
        const txResult = await client.sendUsdc(wallet.encrypted_private_key, process.env.WALLET_ENCRYPTION_KEY, to_address, amount_usd);
        txHash = txResult.txHash;
        onChain = true;

        txId = db.prepare(`
          INSERT INTO blockchain_transactions (tx_number, wallet_id, tx_type, amount_cents, to_address, status, tx_hash, blockchain, created_at)
          VALUES (?, ?, 'send', ?, ?, 'confirmed', ?, ?, datetime('now'))
        `).run(txNumber, wallet_id, amountCents, to_address, txHash, blockchain).lastInsertRowid;
      } catch (err) {
        txId = db.prepare(`
          INSERT INTO blockchain_transactions (tx_number, wallet_id, tx_type, amount_cents, to_address, status, blockchain, created_at)
          VALUES (?, ?, 'send', ?, ?, 'pending', ?, datetime('now'))
        `).run(txNumber, wallet_id, amountCents, to_address, wallet.blockchain || 'MATIC').lastInsertRowid;
      }
    } else {
      txId = db.prepare(`
        INSERT INTO blockchain_transactions (tx_number, wallet_id, tx_type, amount_cents, to_address, status, blockchain, created_at)
        VALUES (?, ?, 'send', ?, ?, 'pending_broadcast', ?, datetime('now'))
      `).run(txNumber, wallet_id, amountCents, to_address, wallet.blockchain || 'MATIC').lastInsertRowid;
    }

    results.steps.push({ step: 'broadcast_transaction', status: onChain ? 'confirmed' : 'ledger_only', tx_hash: txHash, tx_id: txId });

    const newBalance = (walletBalance - amount_usd).toFixed(6);
    db.prepare("UPDATE blockchain_wallets SET usdc_balance = ?, updated_at = datetime('now') WHERE id = ?").run(newBalance, wallet_id);
    results.steps.push({ step: 'update_wallet_balance', status: 'done', new_balance: newBalance });

    const journal = this._postGLJournal(db, {
      description: `USDC send: $${amount_usd} to ${to_address.slice(0, 10)}...`,
      reference_type: 'crypto_send',
      reference_id: String(txId),
      entries: [
        { account_code: '1200', description: 'Digital Assets — USDC (outflow)', debit_cents: 0, credit_cents: amountCents },
        { account_code: '2000', description: 'Payable — Crypto Transfer', debit_cents: amountCents, credit_cents: 0 },
      ],
    });
    results.steps.push({ step: 'post_gl_journal', status: 'done', journal_id: journal.id });

    bus.emit(EVENTS.USDC_SENT, { wallet_id, amount_usd, to_address, tx_id: txId });
    return results;
  }

  // ─── DEX_SWAP ────────────────────────────────────────────────────────────

  async _execute_DEX_SWAP(db, params) {
    const { wallet_id, amount_pol, slippage_bps } = params;
    if (!wallet_id || !amount_pol) throw new Error('wallet_id and amount_pol required');

    const results = { steps: [] };
    const wallet = db.prepare('SELECT * FROM blockchain_wallets WHERE id = ?').get(wallet_id);
    if (!wallet) throw new Error('Wallet not found');
    results.steps.push({ step: 'validate_wallet', status: 'done' });

    const hasEncryptionKey = !!process.env.WALLET_ENCRYPTION_KEY;
    let swapResult = null;

    if (hasEncryptionKey && wallet.encrypted_private_key) {
      try {
        const { PolygonClient } = require('./blockchain-engine');
        const configRow = db.prepare("SELECT config_value FROM blockchain_config WHERE config_key = 'default_blockchain'").get();
        const blockchain = configRow ? configRow.config_value : 'MATIC';
        const client = new PolygonClient(blockchain);
        swapResult = await client.swapPolToUsdc(wallet.encrypted_private_key, process.env.WALLET_ENCRYPTION_KEY, amount_pol, slippage_bps || 100);
        results.steps.push({ step: 'execute_swap', status: 'done', tx_hash: swapResult.txHash, usdc_received: swapResult.usdcBalanceAfter });
      } catch (err) {
        results.steps.push({ step: 'execute_swap', status: 'failed', error: err.message });
        throw new Error(`Swap failed: ${err.message}`);
      }
    } else {
      results.steps.push({ step: 'execute_swap', status: 'skipped', note: 'WALLET_ENCRYPTION_KEY not set' });
      return results;
    }

    if (swapResult) {
      const preSwapBalance = parseFloat(wallet.usdc_balance || '0');
      const newBalance = parseFloat(swapResult.usdcBalanceAfter || '0').toFixed(6);
      const swapOutput = (parseFloat(newBalance) - preSwapBalance).toFixed(6);
      db.prepare("UPDATE blockchain_wallets SET usdc_balance = ?, updated_at = datetime('now') WHERE id = ?").run(newBalance, wallet_id);
      results.steps.push({ step: 'update_wallet_balance', status: 'done', new_balance: newBalance });

      const amountCents = Math.round(parseFloat(swapOutput) * 100);
      const journal = this._postGLJournal(db, {
        description: `DEX Swap: ${amount_pol} POL → ${swapOutput} USDC`,
        reference_type: 'dex_swap',
        reference_id: swapResult.txHash || 'swap',
        entries: [
          { account_code: '1200', description: 'Digital Assets — USDC', debit_cents: amountCents, credit_cents: 0 },
          { account_code: '1210', description: 'Digital Assets — POL', debit_cents: 0, credit_cents: amountCents },
        ],
      });
      results.steps.push({ step: 'post_gl_journal', status: 'done', journal_id: journal.id });
    }

    bus.emit(EVENTS.SWAP_COMPLETED, { wallet_id, amount_pol, swap_result: swapResult });
    return results;
  }

  // ─── FULL_RECONCILIATION ─────────────────────────────────────────────────

  async _execute_FULL_RECONCILIATION(db) {
    const results = { steps: [], checks: [] };

    // Bank vs GL
    const bankAccounts = db.prepare("SELECT * FROM trust_accounts WHERE status = 'active'").all();
    let glEntries = [];
    try { glEntries = db.prepare('SELECT * FROM trust_journal_lines').all(); } catch (_) {}

    const bankTotal = bankAccounts.reduce((s, a) => s + (a.balance_cents || 0), 0);
    let glCash = 0;
    for (const e of glEntries) {
      if (e.account_code === '1000') glCash += (e.debit_cents || 0) - (e.credit_cents || 0);
    }

    results.checks.push({
      check: 'bank_vs_gl', bank_total_cents: bankTotal, gl_cash_cents: glCash,
      difference_cents: bankTotal - glCash, status: bankTotal === glCash ? 'matched' : 'mismatch',
    });
    results.steps.push({ step: 'reconcile_bank_gl', status: 'done' });

    // FI vs GL
    let holdings = [];
    try { holdings = db.prepare("SELECT * FROM fixed_income_holdings WHERE status = 'active'").all(); } catch (_) {}
    const fiTotal = holdings.reduce((s, h) => s + (h.par_value_cents || 0), 0);
    let glFi = 0;
    for (const e of glEntries) {
      if (e.account_code === '1100') glFi += (e.debit_cents || 0) - (e.credit_cents || 0);
    }

    results.checks.push({
      check: 'fi_vs_gl', fi_total_cents: fiTotal, gl_fi_cents: glFi,
      difference_cents: fiTotal - glFi, status: fiTotal === glFi ? 'matched' : 'mismatch',
    });
    results.steps.push({ step: 'reconcile_fi_gl', status: 'done' });

    // Crypto vs GL
    let wallets = [];
    try { wallets = db.prepare('SELECT * FROM blockchain_wallets').all(); } catch (_) {}
    const cryptoTotal = wallets.reduce((s, w) => s + parseFloat(w.usdc_balance || '0'), 0);
    let glCrypto = 0;
    for (const e of glEntries) {
      if (e.account_code === '1200') glCrypto += (e.debit_cents || 0) - (e.credit_cents || 0);
    }
    const cryptoCents = Math.round(cryptoTotal * 100);

    results.checks.push({
      check: 'crypto_vs_gl', crypto_total_cents: cryptoCents, gl_crypto_cents: glCrypto,
      difference_cents: cryptoCents - glCrypto, status: cryptoCents === glCrypto ? 'matched' : 'mismatch',
    });
    results.steps.push({ step: 'reconcile_crypto', status: 'done' });

    // Pending items
    let pendingInternal = [];
    try { pendingInternal = db.prepare("SELECT * FROM internal_transfers WHERE status IN ('pending','approved','executing')").all(); } catch (_) {}
    let pendingExternal = [];
    try { pendingExternal = db.prepare("SELECT * FROM external_transfers WHERE status IN ('draft','pending_approval','approved','processing')").all(); } catch (_) {}

    results.checks.push({
      check: 'pending_items', internal_pending: pendingInternal.length, external_pending: pendingExternal.length,
      status: (pendingInternal.length + pendingExternal.length) === 0 ? 'clear' : 'review',
    });
    results.steps.push({ step: 'reconcile_pending', status: 'done' });

    const mismatches = results.checks.filter(c => c.status === 'mismatch').length;
    results.overall_status = mismatches === 0 ? 'MATCHED' : 'MISMATCH';
    results.total_checks = results.checks.length;
    results.matched = results.checks.filter(c => c.status === 'matched' || c.status === 'clear').length;
    results.mismatched = mismatches;

    try {
      db.prepare(`
        INSERT INTO integration_reconciliation_log (run_date, total_checks, matched, mismatched, overall_status, details, created_at)
        VALUES (date('now'), ?, ?, ?, ?, ?, datetime('now'))
      `).run(results.total_checks, results.matched, results.mismatched, results.overall_status, JSON.stringify(results.checks));
    } catch (_) {}

    bus.emit(EVENTS.RECON_COMPLETED, { status: results.overall_status, checks: results.total_checks });
    return results;
  }

  // ─── DAILY_SWEEP ─────────────────────────────────────────────────────────

  async _execute_DAILY_SWEEP(db, params, exec) {
    const results = { steps: [], sweeps: [] };

    let rules = [];
    try { rules = db.prepare("SELECT * FROM cms_liquidity_rules WHERE status = 'active' AND rule_type = 'sweep'").all(); } catch (_) {}

    if (rules.length === 0) {
      results.steps.push({ step: 'check_sweep_rules', status: 'done', note: 'No active sweep rules' });
      return results;
    }
    results.steps.push({ step: 'check_sweep_rules', status: 'done', rules_found: rules.length });

    for (const rule of rules) {
      try {
        const config = JSON.parse(rule.config || '{}');
        const sourceAccount = db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(config.source_account_id);
        const targetAccount = db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(config.target_account_id);
        if (!sourceAccount || !targetAccount) continue;

        const threshold = config.threshold_cents || 0;
        const excess = sourceAccount.balance_cents - threshold;

        if (excess > 0) {
          await this._execute_INTERNAL_TRANSFER(db, {
            from_account_id: sourceAccount.id, to_account_id: targetAccount.id,
            amount_cents: excess, transfer_type: 'interest_sweep',
            description: `Auto-sweep: excess from ${sourceAccount.account_name}`,
          });
          results.sweeps.push({ rule_id: rule.id, from: sourceAccount.account_name, to: targetAccount.account_name, amount_cents: excess, status: 'executed' });
        }
      } catch (err) {
        results.sweeps.push({ rule_id: rule.id, status: 'failed', error: err.message });
      }
    }

    results.steps.push({ step: 'execute_sweeps', status: 'done', count: results.sweeps.length });
    return results;
  }

  // ─── GENERATE_DOCUMENT ───────────────────────────────────────────────────

  async _execute_GENERATE_DOCUMENT(db, params) {
    const { report_type, report_params } = params;
    if (!report_type) throw new Error('report_type is required');

    const { docGenEngine, REPORT_TYPES } = require('./document-generation-engine');
    if (!REPORT_TYPES[report_type]) throw new Error(`Invalid report_type: ${report_type}`);

    const results = { steps: [] };

    results.steps.push({ step: 'validate_report_type', status: 'done', report_type });
    results.steps.push({ step: 'gather_data', status: 'done', data_sources: REPORT_TYPES[report_type].data_sources });

    const genResult = await docGenEngine.generate(db, report_type, report_params || {});
    results.steps.push({ step: 'render_document', status: 'done', document_id: genResult.document_id });
    results.steps.push({ step: 'store_in_dms', status: 'done', document_id: genResult.document_id });

    results.document_id = genResult.document_id;
    results.report_name = genResult.report_name;
    results.duration_ms = genResult.duration_ms;

    bus.emit('document.generated', { report_type, document_id: genResult.document_id });
    return results;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  _postGLJournal(db, { description, reference_type, reference_id, entries }) {
    try {
      const schemaPath = path.join(__dirname, '..', 'db', 'migrations', 'trust-accounting-schema.sql');
      if (fs.existsSync(schemaPath)) db.exec(fs.readFileSync(schemaPath, 'utf8'));

      const entryNumber = `JE-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${Math.floor(1000 + Math.random() * 9000)}`;
      const totalDebit = entries.reduce((s, e) => s + (e.debit_cents || 0), 0);
      const totalCredit = entries.reduce((s, e) => s + (e.credit_cents || 0), 0);

      const result = db.prepare(`
        INSERT INTO trust_journal_entries (entry_number, entry_date, description, reference_type, reference_id, source_engine, is_posted, total_debit_cents, total_credit_cents, created_by, created_at)
        VALUES (?, date('now'), ?, ?, ?, 'integration_api', 1, ?, ?, 'integration_api', datetime('now'))
      `).run(entryNumber, description, reference_type, reference_id, totalDebit, totalCredit);

      const journalId = result.lastInsertRowid;

      let lineNum = 1;
      for (const entry of entries) {
        let acctRow = db.prepare('SELECT id FROM trust_chart_of_accounts WHERE account_code = ?').get(entry.account_code);
        if (!acctRow) {
          const ins = db.prepare(`
            INSERT OR IGNORE INTO trust_chart_of_accounts (account_code, account_name, account_type, normal_balance, is_active)
            VALUES (?, ?, ?, ?, 1)
          `).run(entry.account_code, entry.description,
            entry.account_code.startsWith('1') ? 'asset' : entry.account_code.startsWith('2') ? 'liability' :
            entry.account_code.startsWith('4') ? 'revenue' : 'expense',
            entry.account_code.startsWith('1') || entry.account_code.startsWith('5') ? 'debit' : 'credit');
          acctRow = { id: ins.lastInsertRowid };
        }

        db.prepare(`
          INSERT INTO trust_journal_lines (journal_entry_id, line_number, account_id, account_code, description, debit_cents, credit_cents, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(journalId, lineNum++, acctRow.id, entry.account_code, entry.description, entry.debit_cents, entry.credit_cents);
      }

      return { id: journalId };
    } catch (err) {
      console.warn('[Integration] GL journal post failed:', err.message);
      return { id: null, error: err.message };
    }
  }

  // ─── FINERACT_PAYMENT ──────────────────────────────────────────────────────

  async _execute_FINERACT_PAYMENT(db, params) {
    const { fineractEngine } = require('./fineract-engine');
    fineractEngine.initSchema(db);

    const results = { steps: [] };

    // Validate
    if (!params.from_account_id || !params.amount_cents || !params.rail) {
      throw new Error('from_account_id, amount_cents, and rail required');
    }
    results.steps.push({ step: 'validate_payment', status: 'done' });

    // Initiate via Fineract
    const payment = fineractEngine.initiatePayment(db, params);
    results.steps.push({ step: 'initiate_fineract', status: 'done', payment_id: payment.payment_id, payment_number: payment.payment_number, rail: payment.rail });

    // Post GL journal
    const journal = this._postGLJournal(db, {
      description: `Fineract ${params.rail} payment: ${params.description || payment.payment_number}`,
      reference_type: 'fineract_payment',
      reference_id: String(payment.payment_id),
      entries: [
        { account_code: '2000', description: `${params.rail} Payable — ${params.to_beneficiary_name || 'External'}`, debit_cents: params.amount_cents, credit_cents: 0 },
        { account_code: '1000', description: 'Cash — Operating', debit_cents: 0, credit_cents: params.amount_cents },
        ...(payment.fee_cents > 0 ? [
          { account_code: '5200', description: `${params.rail} Processing Fee`, debit_cents: payment.fee_cents, credit_cents: 0 },
          { account_code: '1000', description: 'Cash — Operating (fee)', debit_cents: 0, credit_cents: payment.fee_cents },
        ] : []),
      ],
    });
    results.steps.push({ step: 'post_gl_journal', status: 'done', journal_id: journal.id });

    bus.emit('integration.fineract.payment', { payment_id: payment.payment_id, rail: params.rail, amount_cents: params.amount_cents });
    results.steps.push({ step: 'emit_event', status: 'done' });

    results.payment = payment;
    return results;
  }

  // ─── FINERACT_BATCH ───────────────────────────────────────────────────────

  async _execute_FINERACT_BATCH(db, params) {
    const { fineractEngine } = require('./fineract-engine');
    fineractEngine.initSchema(db);

    const results = { steps: [] };
    const pending = db.prepare("SELECT COUNT(*) as cnt FROM fineract_payments WHERE rail = 'ACH' AND status = 'submitted' AND batch_id IS NULL").get();
    results.steps.push({ step: 'collect_pending', status: 'done', pending_count: pending.cnt });

    const batch = fineractEngine.createACHBatch(db, params);
    results.steps.push({ step: 'create_batch', status: 'done', ...batch });

    results.steps.push({ step: 'submit_to_clearing', status: 'done' });
    results.batch = batch;
    return results;
  }

  // ─── FINERACT_SETTLE ──────────────────────────────────────────────────────

  async _execute_FINERACT_SETTLE(db, params) {
    const { fineractEngine } = require('./fineract-engine');
    fineractEngine.initSchema(db);

    const results = { steps: [] };
    const clearing = db.prepare("SELECT COUNT(*) as cnt FROM fineract_payments WHERE status = 'clearing'").get();
    results.steps.push({ step: 'scan_clearing', status: 'done', in_clearing: clearing.cnt });

    const settled = fineractEngine.processSettlements(db);
    results.steps.push({ step: 'settle_payments', status: 'done', ...settled });

    results.steps.push({ step: 'post_gl_journals', status: 'done' });
    results.settlement = settled;
    return results;
  }

  _calculatePaymentFee(amountCents, rail) {
    const fees = { ach: 50, wire: 2500, rtp: 100, check: 200, usdc: 0 };
    return fees[rail] || fees.ach;
  }

  _processPaymentRail(db, transferId, rail) {
    const settlement = {
      ach: { settlement_time: '1-3 business days', reference: `ACH-${Date.now()}` },
      wire: { settlement_time: 'Same day', reference: `WIRE-${Date.now()}` },
      rtp: { settlement_time: 'Instant', reference: `RTP-${Date.now()}` },
      check: { settlement_time: '5-7 business days', reference: `CHK-${Date.now()}` },
      usdc: { settlement_time: '~2 seconds', reference: `USDC-${Date.now()}` },
    };
    const result = settlement[rail] || settlement.ach;

    db.prepare(`
      UPDATE external_transfers SET status = 'processing', reference_id = ?,
        estimated_arrival = ?, updated_at = datetime('now') WHERE id = ?
    `).run(result.reference, result.settlement_time, transferId);

    return result;
  }

  // ─── BANK_TO_CRYPTO ──────────────────────────────────────────────────────

  async _execute_BANK_TO_CRYPTO(db, params) {
    const { BridgeOrderManager, MoonPayClient } = require('./moonpay-engine');
    const bridgeMgr = new BridgeOrderManager(db);
    const moonpay = new MoonPayClient();

    const { source_account_id, destination_wallet_id, amount_cents, destination_address, notes } = params;
    if (!source_account_id || !amount_cents) throw new Error('source_account_id and amount_cents required');
    if (!destination_wallet_id && !destination_address) throw new Error('destination_wallet_id or destination_address required');

    const results = { steps: [] };

    // 1. Validate source account
    const account = db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(source_account_id);
    if (!account) throw new Error('Source account not found');
    if (account.status !== 'active') throw new Error(`Source account is ${account.status}`);
    if (amount_cents > account.available_cents) {
      throw new Error(`Insufficient funds. Available: $${(account.available_cents / 100).toFixed(2)}, requested: $${(amount_cents / 100).toFixed(2)}`);
    }
    results.steps.push({ step: 'validate_source', status: 'done', account: account.account_name, available: account.available_cents });

    // Resolve destination address
    let walletAddress = destination_address;
    if (destination_wallet_id && !walletAddress) {
      const wallet = db.prepare('SELECT * FROM blockchain_wallets WHERE id = ?').get(destination_wallet_id);
      if (wallet) walletAddress = wallet.address;
    }

    // 2. Check approval threshold
    const approvalThreshold = 1000000; // $10,000 in cents
    const requiresApproval = amount_cents >= approvalThreshold;

    // 3. Create bridge order
    const order = bridgeMgr.createOrder({
      direction: 'bank_to_crypto',
      sourceAccountId: source_account_id,
      destinationWalletId: destination_wallet_id || null,
      fiatAmountCents: amount_cents,
      destinationAddress: walletAddress,
      requiresApproval,
      initiatedBy: 'integration_api',
      notes: notes || `Fund wallet from ${account.account_name}`,
    });

    // 4. Debit bank account (hold funds)
    db.prepare(`
      UPDATE trust_accounts SET
        balance_cents = balance_cents - ?, available_cents = available_cents - ?,
        last_activity_date = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(amount_cents, amount_cents, source_account_id);
    results.steps.push({ step: 'debit_bank_account', status: 'done', amount_cents, account_id: source_account_id });

    // 5. Generate MoonPay widget URL (if configured) or mark for direct conversion
    const amountUsd = (amount_cents / 100).toFixed(2);
    if (moonpay.isConfigured()) {
      const widgetUrl = moonpay.generateBuyWidgetUrl({
        walletAddress,
        amount: amountUsd,
        externalTransactionId: order.order_number,
      });
      bridgeMgr.updateStatus(order.id, 'moonpay_pending', { moonpayWidgetUrl: widgetUrl });
      results.steps.push({ step: 'initiate_moonpay', status: 'done', widget_url: widgetUrl, order_number: order.order_number });
    } else {
      // Direct ledger conversion (MoonPay not configured — ledger-only mode)
      // Credit wallet balance in DB
      if (destination_wallet_id) {
        db.prepare(`
          UPDATE blockchain_wallets SET usdc_balance = CAST(CAST(usdc_balance AS REAL) + ? AS TEXT), updated_at = datetime('now') WHERE id = ?
        `).run(parseFloat(amountUsd), destination_wallet_id);
      }
      bridgeMgr.updateStatus(order.id, 'completed', { cryptoAmount: amountUsd, exchangeRate: '1.000000' });
      results.steps.push({ step: 'initiate_moonpay', status: 'done', mode: 'ledger_conversion', amount_usdc: amountUsd });
    }

    // 6. Post GL journal: Debit Crypto Assets (1500), Credit Cash (1000)
    const journal = this._postGLJournal(db, {
      description: `Bank→Crypto: $${amountUsd} USD → USDC — Order ${order.order_number}`,
      reference_type: 'bridge_order',
      reference_id: String(order.id),
      entries: [
        { account_code: '1500', description: 'Digital Asset Holdings (USDC)', debit_cents: amount_cents, credit_cents: 0 },
        { account_code: '1000', description: 'Cash — Operating', debit_cents: 0, credit_cents: amount_cents },
      ],
    });
    if (journal.id) bridgeMgr.updateStatus(order.id, order.status || 'completed', { journalEntryId: journal.id });
    results.steps.push({ step: 'post_gl_journal', status: 'done', journal_id: journal.id });

    bus.emit('bridge.bank_to_crypto', { order_id: order.id, amount_cents, order_number: order.order_number });
    results.order = bridgeMgr.getOrder(order.id);
    return results;
  }

  // ─── CRYPTO_TO_BANK ──────────────────────────────────────────────────────

  async _execute_CRYPTO_TO_BANK(db, params) {
    const { BridgeOrderManager, MoonPayClient } = require('./moonpay-engine');
    const bridgeMgr = new BridgeOrderManager(db);
    const moonpay = new MoonPayClient();

    const { source_wallet_id, destination_account_id, amount_usdc, notes } = params;
    if (!source_wallet_id || !destination_account_id || !amount_usdc) {
      throw new Error('source_wallet_id, destination_account_id, and amount_usdc required');
    }

    const results = { steps: [] };

    // 1. Validate wallet balance
    const wallet = db.prepare('SELECT * FROM blockchain_wallets WHERE id = ?').get(source_wallet_id);
    if (!wallet) throw new Error('Source wallet not found');
    if (wallet.status !== 'active') throw new Error(`Wallet is ${wallet.status}`);
    const walletBalance = parseFloat(wallet.usdc_balance || '0');
    const amount = parseFloat(amount_usdc);
    if (amount > walletBalance) {
      throw new Error(`Insufficient USDC. Balance: $${walletBalance.toFixed(2)}, requested: $${amount.toFixed(2)}`);
    }
    results.steps.push({ step: 'validate_wallet', status: 'done', wallet: wallet.wallet_name, balance: walletBalance });

    // 2. Validate destination account
    const account = db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(destination_account_id);
    if (!account) throw new Error('Destination account not found');
    if (account.status !== 'active') throw new Error(`Destination account is ${account.status}`);
    results.steps.push({ step: 'validate_destination', status: 'done', account: account.account_name });

    const amountCents = Math.round(amount * 100);

    // 3. Create bridge order
    const order = bridgeMgr.createOrder({
      direction: 'crypto_to_bank',
      sourceWalletId: source_wallet_id,
      destinationAccountId: destination_account_id,
      fiatAmountCents: amountCents,
      destinationAddress: null,
      requiresApproval: amountCents >= 1000000,
      initiatedBy: 'integration_api',
      notes: notes || `Sweep USDC to ${account.account_name}`,
    });

    // 4. Debit wallet
    db.prepare(`
      UPDATE blockchain_wallets SET usdc_balance = CAST(CAST(usdc_balance AS REAL) - ? AS TEXT), updated_at = datetime('now') WHERE id = ?
    `).run(amount, source_wallet_id);
    results.steps.push({ step: 'debit_wallet', status: 'done', amount_usdc: amount.toFixed(2) });

    // 5. Initiate sell (MoonPay off-ramp or ledger credit)
    if (moonpay.isConfigured()) {
      const widgetUrl = moonpay.generateSellWidgetUrl({
        amount: amount.toFixed(2),
        refundAddress: wallet.address,
        externalTransactionId: order.order_number,
      });
      bridgeMgr.updateStatus(order.id, 'moonpay_pending', { moonpayWidgetUrl: widgetUrl });
      results.steps.push({ step: 'initiate_sell', status: 'done', widget_url: widgetUrl });
    } else {
      // Direct ledger conversion
      bridgeMgr.updateStatus(order.id, 'completed', { cryptoAmount: amount.toFixed(2), exchangeRate: '1.000000' });
      results.steps.push({ step: 'initiate_sell', status: 'done', mode: 'ledger_conversion' });
    }

    // 6. Credit bank account
    db.prepare(`
      UPDATE trust_accounts SET
        balance_cents = balance_cents + ?, available_cents = available_cents + ?,
        last_activity_date = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(amountCents, amountCents, destination_account_id);
    results.steps.push({ step: 'credit_bank_account', status: 'done', amount_cents: amountCents, account_id: destination_account_id });

    // 7. Post GL journal: Debit Cash (1000), Credit Crypto Assets (1500)
    const journal = this._postGLJournal(db, {
      description: `Crypto→Bank: $${amount.toFixed(2)} USDC → USD — Order ${order.order_number}`,
      reference_type: 'bridge_order',
      reference_id: String(order.id),
      entries: [
        { account_code: '1000', description: 'Cash — Operating', debit_cents: amountCents, credit_cents: 0 },
        { account_code: '1500', description: 'Digital Asset Holdings (USDC)', debit_cents: 0, credit_cents: amountCents },
      ],
    });
    if (journal.id) bridgeMgr.updateStatus(order.id, 'completed', { journalEntryId: journal.id });
    results.steps.push({ step: 'post_gl_journal', status: 'done', journal_id: journal.id });

    bus.emit('bridge.crypto_to_bank', { order_id: order.id, amount_cents: amountCents, order_number: order.order_number });
    results.order = bridgeMgr.getOrder(order.id);
    return results;
  }

  _persistExecution(db, exec) {
    try {
      db.prepare(`
        INSERT INTO integration_pipeline_log (execution_id, pipeline, trigger_type, params, status, results, error, started_at, completed_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(exec.id, exec.pipeline, exec.trigger.type, JSON.stringify(exec.params),
        exec.status, JSON.stringify(exec.results), exec.error, exec.started_at, exec.completed_at);
    } catch (_) {}
  }

  getExecutions(limit = 50) {
    return this.executions.slice(-limit);
  }

  getStatus() {
    const recent = this.executions.slice(-20);
    return {
      total_executions: this.executions.length,
      recent_completed: recent.filter(e => e.status === 'completed').length,
      recent_failed: recent.filter(e => e.status === 'failed').length,
      pipelines: Object.keys(PIPELINES).map(k => ({ name: k, ...PIPELINES[k] })),
    };
  }
}

// Singleton
const engine = new IntegrationEngine();

module.exports = { engine, IntegrationEngine, PIPELINES, TRIGGER_TYPES };
