/**
 * Payment Rail Routes — Real Money Movement via Increase
 * DEANDREA LAVAR BARKLEY TRUST — Private Wealth Management Platform
 *
 * Endpoints:
 *   GET    /api/payment-rails/dashboard         - Rail dashboard metrics
 *   GET    /api/payment-rails/config             - Get rail configuration
 *   PUT    /api/payment-rails/config             - Update rail configuration
 *   GET    /api/payment-rails/accounts           - List Increase accounts
 *   POST   /api/payment-rails/accounts/sync      - Sync accounts from Increase
 *   GET    /api/payment-rails/external-accounts  - List Increase external accounts
 *   POST   /api/payment-rails/external-accounts  - Create external account on Increase
 *   POST   /api/payment-rails/send               - Initiate a real payment (ACH/Wire/RTP/Check)
 *   GET    /api/payment-rails/transactions        - List rail transactions
 *   GET    /api/payment-rails/transactions/:id    - Transaction detail
 *   POST   /api/payment-rails/transactions/:id/approve  - Approve a pending transaction
 *   POST   /api/payment-rails/transactions/:id/cancel   - Cancel a transaction
 *   POST   /api/payment-rails/transactions/:id/sync     - Sync status from Increase
 *   GET    /api/payment-rails/reconciliation      - Daily reconciliation report
 *   POST   /api/payment-rails/reconciliation/run  - Run reconciliation for a date
 *   POST   /api/payment-rails/webhooks            - Increase webhook receiver
 *   GET    /api/payment-rails/webhooks/events      - List received webhook events
 *   GET    /api/payment-rails/rails                - Available payment rails info
 *   GET    /api/payment-rails/limits               - Daily limits & usage
 */

'use strict';

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const {
  RAILS,
  ACH_SEC_CODES,
  ACH_RETURN_CODES,
  IncreaseClient,
  generateRailTxNumber,
  generateIdempotencyKey,
  buildACHPayload,
  buildWirePayload,
  buildRTPPayload,
  buildCheckPayload,
  mapIncreaseStatus,
  validateRailRequest,
  checkDailyLimit,
  calculateRailFee,
  maskAccountNumber,
  toDollars,
  buildRailAuditEntry,
} = require('../engines/payment-rail-engine');

// --- DB Setup ---------------------------------------------------------------

function getDb() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'dlbtrust.db');
  return new Database(dbPath);
}

let schemaInitialized = false;

function initSchema(db) {
  if (schemaInitialized) return;
  for (const file of ['banking-schema.sql', 'crm-schema.sql', 'external-transfers-schema.sql', 'payment-rail-schema.sql']) {
    const p = path.join(__dirname, '..', 'db', 'migrations', file);
    if (fs.existsSync(p)) db.exec(fs.readFileSync(p, 'utf8'));
  }
  schemaInitialized = true;
}

// --- Middleware --------------------------------------------------------------

router.use((req, res, next) => {
  try {
    req.db = getDb();
    initSchema(req.db);
    res.on('finish', () => { try { req.db.close(); } catch (_) {} });
    res.on('close',  () => { try { req.db.close(); } catch (_) {} });
    next();
  } catch (err) {
    res.status(500).json({ error: 'Database connection failed', detail: err.message });
  }
});

// --- Helpers ----------------------------------------------------------------

function getConfig(db, key) {
  const row = db.prepare('SELECT config_value FROM rail_config WHERE config_key = ?').get(key);
  return row ? row.config_value : null;
}

function getIncreaseClient(db) {
  const apiKey = process.env.INCREASE_API_KEY || getConfig(db, 'api_key');
  const env = getConfig(db, 'environment') || 'sandbox';
  if (!apiKey) return null;
  return new IncreaseClient(apiKey, env);
}

function insertAudit(db, entry) {
  try {
    db.prepare(`
      INSERT INTO banking_audit_log (event_type, entity_type, entity_id, actor, action, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(entry.event_type, entry.entity_type, entry.entity_id, entry.actor, entry.action, entry.details);
  } catch (_) {}
}

// ============================================================================
// ROUTES
// ============================================================================

// --- GET /dashboard — Rail dashboard metrics --------------------------------
router.get('/dashboard', (req, res) => {
  try {
    const db = req.db;

    const totalTx = db.prepare('SELECT COUNT(*) as count FROM rail_transactions').get();
    const byStatus = db.prepare(`
      SELECT status, COUNT(*) as count, COALESCE(SUM(amount_cents), 0) as total
      FROM rail_transactions GROUP BY status
    `).all();
    const byRail = db.prepare(`
      SELECT rail, COUNT(*) as count, COALESCE(SUM(amount_cents), 0) as total
      FROM rail_transactions GROUP BY rail
    `).all();
    const totalSent = db.prepare(`
      SELECT COALESCE(SUM(amount_cents), 0) as total FROM rail_transactions
      WHERE status IN ('completed', 'sent', 'submitted')
    `).get();
    const totalFees = db.prepare(`
      SELECT COALESCE(SUM(fee_cents), 0) as total FROM rail_transactions
    `).get();
    const pending = db.prepare(`
      SELECT COUNT(*) as count FROM rail_transactions
      WHERE status IN ('pending_submission', 'submitted', 'pending_approval', 'processing')
    `).get();
    const failed = db.prepare(`
      SELECT COUNT(*) as count FROM rail_transactions WHERE status IN ('failed', 'returned')
    `).get();
    const webhookCount = db.prepare('SELECT COUNT(*) as count FROM rail_webhook_events').get();
    const increaseAccounts = db.prepare('SELECT COUNT(*) as count FROM increase_accounts').get();
    const externalAccounts = db.prepare('SELECT COUNT(*) as count FROM increase_external_accounts').get();

    const env = getConfig(db, 'environment') || 'sandbox';
    const provider = getConfig(db, 'provider') || 'increase';
    const hasApiKey = !!(process.env.INCREASE_API_KEY || getConfig(db, 'api_key'));

    res.json({
      provider,
      environment: env,
      api_connected: hasApiKey,
      total_transactions: totalTx.count,
      total_sent_usd: toDollars(totalSent.total),
      total_fees_usd: toDollars(totalFees.total),
      pending_count: pending.count,
      failed_count: failed.count,
      increase_accounts: increaseAccounts.count,
      external_accounts: externalAccounts.count,
      webhook_events: webhookCount.count,
      by_status: byStatus.map(r => ({ status: r.status, count: r.count, total_usd: toDollars(r.total) })),
      by_rail: byRail.map(r => ({ rail: r.rail, count: r.count, total_usd: toDollars(r.total) })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /config — Rail configuration ---------------------------------------
router.get('/config', (req, res) => {
  try {
    const rows = req.db.prepare('SELECT config_key, config_value, description FROM rail_config').all();
    // Mask sensitive values
    const config = rows.map(r => ({
      key: r.config_key,
      value: r.config_key === 'api_key' || r.config_key === 'webhook_secret'
        ? (r.config_value ? '****' + r.config_value.slice(-4) : '(not set)')
        : r.config_value,
      description: r.description,
    }));
    res.json({ config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- PUT /config — Update rail configuration --------------------------------
router.put('/config', (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || value === undefined) {
      return res.status(400).json({ error: 'key and value are required' });
    }
    const allowed = ['environment', 'api_key', 'webhook_secret', 'default_ach_sec_code',
      'default_wire_statement', 'auto_submit_threshold_cents', 'require_dual_approval_cents',
      'daily_ach_limit_cents', 'daily_wire_limit_cents', 'api_base_url'];
    if (!allowed.includes(key)) {
      return res.status(400).json({ error: `Config key '${key}' is not updatable` });
    }

    req.db.prepare(`
      INSERT INTO rail_config (config_key, config_value, description, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(config_key) DO UPDATE SET config_value = excluded.config_value, updated_at = datetime('now')
    `).run(key, String(value), '');

    insertAudit(req.db, buildRailAuditEntry('config_update', 0, 'update_config', req.body.actor || 'admin', { key, value: key.includes('key') || key.includes('secret') ? '****' : value }));
    res.json({ message: `Config '${key}' updated`, key, value: key.includes('key') || key.includes('secret') ? '****' : value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /rails — Available payment rails info ------------------------------
router.get('/rails', (req, res) => {
  const rails = Object.entries(RAILS).map(([id, info]) => ({
    id,
    name: info.name,
    speed: info.speed,
    fee_cents: info.fee,
    fee_usd: toDollars(info.fee),
    endpoint: info.endpoint,
  }));
  res.json({ rails, sec_codes: ACH_SEC_CODES, return_codes: ACH_RETURN_CODES });
});

// --- GET /limits — Daily limits and usage -----------------------------------
router.get('/limits', (req, res) => {
  try {
    const db = req.db;
    const achLimit = checkDailyLimit(db, 'ach', 0, 'daily_ach_limit_cents');
    const wireLimit = checkDailyLimit(db, 'wire', 0, 'daily_wire_limit_cents');
    res.json({
      ach: {
        daily_limit_usd: toDollars(achLimit.limit),
        used_usd: toDollars(achLimit.current),
        remaining_usd: toDollars(achLimit.remaining),
      },
      wire: {
        daily_limit_usd: toDollars(wireLimit.limit),
        used_usd: toDollars(wireLimit.current),
        remaining_usd: toDollars(wireLimit.remaining),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /accounts — List Increase accounts ---------------------------------
router.get('/accounts', (req, res) => {
  try {
    const rows = req.db.prepare(`
      SELECT ia.*, ta.account_number as trust_acct_number, ta.account_name as trust_acct_name, ta.balance_cents as trust_balance
      FROM increase_accounts ia
      LEFT JOIN trust_accounts ta ON ia.trust_account_id = ta.id
      ORDER BY ia.created_at DESC
    `).all();
    res.json({ accounts: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /accounts/sync — Sync accounts from Increase ----------------------
router.post('/accounts/sync', async (req, res) => {
  try {
    const client = getIncreaseClient(req.db);
    if (!client) {
      return res.status(400).json({ error: 'Increase API key not configured. Set INCREASE_API_KEY or update via /config' });
    }

    const result = await client.listAccounts();
    const accounts = result.data || [];
    let synced = 0;

    for (const acct of accounts) {
      req.db.prepare(`
        INSERT INTO increase_accounts (increase_account_id, account_name, status, currency, bank, interest_rate, entity_id, program_id, last_synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(increase_account_id) DO UPDATE SET
          account_name = excluded.account_name,
          status = excluded.status,
          currency = excluded.currency,
          bank = excluded.bank,
          interest_rate = excluded.interest_rate,
          entity_id = excluded.entity_id,
          program_id = excluded.program_id,
          last_synced_at = datetime('now'),
          updated_at = datetime('now')
      `).run(acct.id, acct.name, acct.status, acct.currency, acct.bank, acct.interest_rate, acct.entity_id, acct.program_id);

      // Sync balance
      try {
        const bal = await client.getAccountBalance(acct.id);
        req.db.prepare(`
          UPDATE increase_accounts SET balance_cents = ?, available_balance_cents = ? WHERE increase_account_id = ?
        `).run(bal.current_balance || 0, bal.available_balance || 0, acct.id);
      } catch (_) {}

      synced++;
    }

    insertAudit(req.db, buildRailAuditEntry('account_sync', 0, 'sync_increase_accounts', 'system', { synced }));
    res.json({ message: `Synced ${synced} Increase accounts`, count: synced });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /external-accounts — List Increase external accounts ---------------
router.get('/external-accounts', (req, res) => {
  try {
    const rows = req.db.prepare(`
      SELECT iea.*, cc.display_name as contact_name, cc.contact_type
      FROM increase_external_accounts iea
      LEFT JOIN crm_contacts cc ON iea.contact_id = cc.id
      ORDER BY iea.created_at DESC
    `).all();
    res.json({ external_accounts: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /external-accounts — Create external account on Increase ----------
router.post('/external-accounts', async (req, res) => {
  try {
    const { contact_id, routing_number, account_number, account_holder, funding, description } = req.body;
    if (!routing_number || !account_number) {
      return res.status(400).json({ error: 'routing_number and account_number are required' });
    }

    const client = getIncreaseClient(req.db);
    const idemKey = generateIdempotencyKey('ext_acct');

    let increaseResult = null;
    if (client) {
      increaseResult = await client.createExternalAccount({
        routing_number,
        account_number,
        account_holder: account_holder || 'business',
        funding: funding || 'checking',
        description: description || 'DLB Trust Counterparty',
      }, idemKey);
    }

    const extAcctId = increaseResult ? increaseResult.id : `local_ext_${Date.now()}`;

    req.db.prepare(`
      INSERT INTO increase_external_accounts
        (increase_ext_acct_id, contact_id, account_holder, account_number, routing_number, description, funding, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      extAcctId,
      contact_id || null,
      account_holder || 'business',
      maskAccountNumber(account_number),
      routing_number,
      description || null,
      funding || 'checking'
    );

    // Link to CRM payment method if contact_id provided
    if (contact_id) {
      const lastId = req.db.prepare('SELECT last_insert_rowid() as id').get().id;
      req.db.prepare(`
        UPDATE increase_external_accounts SET payment_method_id = (
          SELECT id FROM crm_payment_methods WHERE contact_id = ? AND is_default = 1 LIMIT 1
        ) WHERE id = ?
      `).run(contact_id, lastId);
    }

    insertAudit(req.db, buildRailAuditEntry('external_account_created', 0, 'create_external_account', req.body.actor || 'system', { increase_id: extAcctId, routing: routing_number }));

    res.status(201).json({
      message: 'External account created',
      increase_external_account_id: extAcctId,
      live: !!client,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /send — Initiate a real payment -----------------------------------
router.post('/send', async (req, res) => {
  try {
    const db = req.db;
    const errors = validateRailRequest(req.body);
    if (errors.length > 0) return res.status(400).json({ errors });

    const {
      rail, amount, amount_cents, from_account_id, increase_account_id,
      external_account_id, increase_ext_acct_id, contact_id,
      recipient_name, recipient_routing, recipient_account, recipient_bank,
      description, memo, sec_code, settlement_schedule,
      mailing_address, external_transfer_id,
    } = req.body;

    const amountCents = amount_cents || Math.round(parseFloat(amount) * 100);
    const feeCents = calculateRailFee(rail);
    const idemKey = generateIdempotencyKey(rail);
    const railTxNumber = generateRailTxNumber();

    // Check daily limits
    const limitKey = rail === 'wire' ? 'daily_wire_limit_cents' : 'daily_ach_limit_cents';
    const limitCheck = checkDailyLimit(db, rail, amountCents, limitKey);
    if (limitCheck.exceeded) {
      return res.status(400).json({
        error: `Daily ${rail.toUpperCase()} limit exceeded`,
        limit_usd: toDollars(limitCheck.limit),
        used_usd: toDollars(limitCheck.current),
        remaining_usd: toDollars(limitCheck.remaining),
      });
    }

    // Resolve Increase account ID
    let resolvedIncreaseAcctId = increase_account_id;
    if (!resolvedIncreaseAcctId && from_account_id) {
      const linked = db.prepare('SELECT increase_account_id FROM increase_accounts WHERE trust_account_id = ?').get(from_account_id);
      if (linked) resolvedIncreaseAcctId = linked.increase_account_id;
    }

    // Resolve Increase external account ID
    let resolvedExtAcctId = increase_ext_acct_id || external_account_id;
    if (!resolvedExtAcctId && contact_id) {
      const linked = db.prepare('SELECT increase_ext_acct_id FROM increase_external_accounts WHERE contact_id = ? LIMIT 1').get(contact_id);
      if (linked) resolvedExtAcctId = linked.increase_ext_acct_id;
    }

    // Create local rail transaction record
    db.prepare(`
      INSERT INTO rail_transactions (
        rail_tx_number, external_transfer_id, increase_account_id, increase_ext_acct_id,
        rail, direction, amount_cents, currency,
        sec_code, recipient_name, recipient_routing, recipient_account, recipient_bank,
        status, fee_cents, idempotency_key, initiated_by
      ) VALUES (?, ?, ?, ?, ?, 'credit', ?, 'USD', ?, ?, ?, ?, ?, 'pending_submission', ?, ?, ?)
    `).run(
      railTxNumber, external_transfer_id || null,
      resolvedIncreaseAcctId || null, resolvedExtAcctId || null,
      rail, amountCents,
      sec_code || null,
      recipient_name || null, recipient_routing || null,
      maskAccountNumber(recipient_account) || null, recipient_bank || null,
      feeCents, idemKey, req.body.actor || 'system'
    );

    const railTxId = db.prepare('SELECT last_insert_rowid() as id').get().id;

    // Attempt to submit to Increase if API key configured
    const client = getIncreaseClient(db);
    let increaseResult = null;
    let submitted = false;

    if (client && resolvedIncreaseAcctId) {
      try {
        switch (rail) {
          case 'ach':
            increaseResult = await client.createACHTransfer(
              buildACHPayload({
                accountId: resolvedIncreaseAcctId,
                externalAccountId: resolvedExtAcctId,
                amount: amountCents,
                description: description || 'DLB Trust Payment',
                secCode: sec_code,
                settlementSchedule: settlement_schedule,
              }),
              idemKey
            );
            break;
          case 'wire':
            increaseResult = await client.createWireTransfer(
              buildWirePayload({
                accountId: resolvedIncreaseAcctId,
                externalAccountId: resolvedExtAcctId,
                accountNumber: recipient_account,
                routingNumber: recipient_routing,
                amount: amountCents,
                beneficiaryName: recipient_name,
                memo: memo,
              }),
              idemKey
            );
            break;
          case 'rtp':
            increaseResult = await client.createRTPTransfer(
              buildRTPPayload({
                accountId: resolvedIncreaseAcctId,
                externalAccountId: resolvedExtAcctId,
                amount: amountCents,
                creditorName: 'DLB Trust',
                remittanceInfo: description || 'Payment',
              }),
              idemKey
            );
            break;
          case 'check':
            increaseResult = await client.createCheckTransfer(
              buildCheckPayload({
                accountId: resolvedIncreaseAcctId,
                amount: amountCents,
                recipientName: recipient_name,
                mailingAddress: mailing_address,
                memo: memo || description,
              }),
              idemKey
            );
            break;
        }

        if (increaseResult) {
          submitted = true;
          const mappedStatus = mapIncreaseStatus(increaseResult.status) || 'submitted';
          db.prepare(`
            UPDATE rail_transactions SET
              increase_transfer_id = ?,
              increase_tx_id = ?,
              status = ?,
              submitted_at = datetime('now'),
              updated_at = datetime('now')
            WHERE id = ?
          `).run(increaseResult.id, increaseResult.transaction_id || null, mappedStatus, railTxId);
        }
      } catch (apiErr) {
        db.prepare(`
          UPDATE rail_transactions SET status = 'failed', failure_reason = ?, failed_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?
        `).run(apiErr.message, railTxId);
      }
    }

    // Link to external transfer if provided
    if (external_transfer_id) {
      try {
        db.prepare(`UPDATE external_transfers SET reference_id = ?, status = 'processing', sent_date = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
          .run(railTxNumber, external_transfer_id);
      } catch (_) {}
    }

    insertAudit(db, buildRailAuditEntry('rail_payment_initiated', railTxId, 'send_payment', req.body.actor || 'system', {
      rail, amount_usd: toDollars(amountCents), rail_tx: railTxNumber, submitted, increase_id: increaseResult?.id,
    }));

    const tx = db.prepare('SELECT * FROM rail_transactions WHERE id = ?').get(railTxId);
    tx.amount_usd = toDollars(tx.amount_cents);
    tx.fee_usd = toDollars(tx.fee_cents);

    res.status(201).json({
      message: submitted ? `${RAILS[rail].name} payment submitted to Increase` : `${RAILS[rail].name} payment created (offline — connect API to submit)`,
      transaction: tx,
      increase_response: increaseResult,
      live: submitted,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /transactions — List rail transactions -----------------------------
router.get('/transactions', (req, res) => {
  try {
    const { status, rail, limit, offset } = req.query;
    let where = [];
    let params = [];

    if (status) { where.push('rt.status = ?'); params.push(status); }
    if (rail) { where.push('rt.rail = ?'); params.push(rail); }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    const lim = Math.min(parseInt(limit) || 100, 500);
    const off = parseInt(offset) || 0;

    const rows = req.db.prepare(`
      SELECT rt.*, et.transfer_number as ext_transfer_number, et.contact_id,
             cc.display_name as contact_name
      FROM rail_transactions rt
      LEFT JOIN external_transfers et ON rt.external_transfer_id = et.id
      LEFT JOIN crm_contacts cc ON et.contact_id = cc.id
      ${whereClause}
      ORDER BY rt.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, lim, off);

    const total = req.db.prepare(`SELECT COUNT(*) as count FROM rail_transactions rt ${whereClause}`).get(...params);

    rows.forEach(r => {
      r.amount_usd = toDollars(r.amount_cents);
      r.fee_usd = toDollars(r.fee_cents);
    });

    res.json({ transactions: rows, total: total.count, limit: lim, offset: off });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /transactions/:id — Transaction detail -----------------------------
router.get('/transactions/:id', (req, res) => {
  try {
    const tx = req.db.prepare(`
      SELECT rt.*, et.transfer_number as ext_transfer_number, et.contact_id, et.description as ext_description,
             cc.display_name as contact_name, cc.contact_type, cc.email as contact_email
      FROM rail_transactions rt
      LEFT JOIN external_transfers et ON rt.external_transfer_id = et.id
      LEFT JOIN crm_contacts cc ON et.contact_id = cc.id
      WHERE rt.id = ?
    `).get(req.params.id);

    if (!tx) return res.status(404).json({ error: 'Transaction not found' });

    tx.amount_usd = toDollars(tx.amount_cents);
    tx.fee_usd = toDollars(tx.fee_cents);

    // Get related webhook events
    const events = req.db.prepare(`
      SELECT * FROM rail_webhook_events WHERE associated_object_id = ? ORDER BY created_at DESC
    `).all(tx.increase_transfer_id || '');

    res.json({ transaction: tx, webhook_events: events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /transactions/:id/approve — Approve a pending transaction ---------
router.post('/transactions/:id/approve', async (req, res) => {
  try {
    const db = req.db;
    const tx = db.prepare('SELECT * FROM rail_transactions WHERE id = ?').get(req.params.id);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status !== 'pending_approval') {
      return res.status(400).json({ error: `Cannot approve transaction in '${tx.status}' status` });
    }

    const client = getIncreaseClient(db);
    let increaseResult = null;

    if (client && tx.increase_transfer_id) {
      switch (tx.rail) {
        case 'ach': increaseResult = await client.approveACHTransfer(tx.increase_transfer_id); break;
        case 'wire': increaseResult = await client.approveWireTransfer(tx.increase_transfer_id); break;
        case 'check': increaseResult = await client.approveCheckTransfer(tx.increase_transfer_id); break;
      }
    }

    const newStatus = increaseResult ? mapIncreaseStatus(increaseResult.status) : 'approved';
    db.prepare(`UPDATE rail_transactions SET status = ?, approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
      .run(newStatus, tx.id);

    insertAudit(db, buildRailAuditEntry('rail_payment_approved', tx.id, 'approve_payment', req.body.approved_by || 'admin', { rail: tx.rail }));
    res.json({ message: 'Transaction approved', status: newStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /transactions/:id/cancel — Cancel a transaction -------------------
router.post('/transactions/:id/cancel', async (req, res) => {
  try {
    const db = req.db;
    const tx = db.prepare('SELECT * FROM rail_transactions WHERE id = ?').get(req.params.id);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });

    const cancellable = ['pending_submission', 'submitted', 'pending_approval', 'approved', 'processing'];
    if (!cancellable.includes(tx.status)) {
      return res.status(400).json({ error: `Cannot cancel transaction in '${tx.status}' status` });
    }

    const client = getIncreaseClient(db);
    if (client && tx.increase_transfer_id) {
      try {
        switch (tx.rail) {
          case 'ach': await client.cancelACHTransfer(tx.increase_transfer_id); break;
          case 'wire': await client.cancelWireTransfer(tx.increase_transfer_id); break;
          case 'check': await client.cancelCheckTransfer(tx.increase_transfer_id); break;
        }
      } catch (_) {}
    }

    db.prepare(`UPDATE rail_transactions SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(tx.id);
    insertAudit(db, buildRailAuditEntry('rail_payment_cancelled', tx.id, 'cancel_payment', req.body.actor || 'admin', { reason: req.body.reason }));
    res.json({ message: 'Transaction cancelled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /transactions/:id/sync — Sync status from Increase ----------------
router.post('/transactions/:id/sync', async (req, res) => {
  try {
    const db = req.db;
    const tx = db.prepare('SELECT * FROM rail_transactions WHERE id = ?').get(req.params.id);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (!tx.increase_transfer_id) {
      return res.status(400).json({ error: 'No Increase transfer ID to sync' });
    }

    const client = getIncreaseClient(db);
    if (!client) return res.status(400).json({ error: 'Increase API not configured' });

    let increaseData;
    switch (tx.rail) {
      case 'ach': increaseData = await client.getACHTransfer(tx.increase_transfer_id); break;
      case 'wire': increaseData = await client.getWireTransfer(tx.increase_transfer_id); break;
      case 'rtp': increaseData = await client.getRTPTransfer(tx.increase_transfer_id); break;
      case 'check': increaseData = await client.getCheckTransfer(tx.increase_transfer_id); break;
    }

    if (increaseData) {
      const newStatus = mapIncreaseStatus(increaseData.status);
      const updates = { status: newStatus };

      if (increaseData.submission) {
        updates.ach_trace_number = increaseData.submission.trace_number;
        updates.expected_settlement = increaseData.submission.expected_funds_settlement_at;
      }
      if (increaseData.return) {
        updates.ach_return_code = increaseData.return.return_reason_code;
        updates.return_reason = increaseData.return.reason;
      }
      if (increaseData.transaction_id) {
        updates.increase_tx_id = increaseData.transaction_id;
      }

      db.prepare(`
        UPDATE rail_transactions SET
          status = ?, increase_tx_id = COALESCE(?, increase_tx_id),
          ach_trace_number = COALESCE(?, ach_trace_number),
          expected_settlement = COALESCE(?, expected_settlement),
          ach_return_code = COALESCE(?, ach_return_code),
          return_reason = COALESCE(?, return_reason),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        updates.status, updates.increase_tx_id || null,
        updates.ach_trace_number || null, updates.expected_settlement || null,
        updates.ach_return_code || null, updates.return_reason || null,
        tx.id
      );

      res.json({ message: 'Transaction synced', status: updates.status, increase_status: increaseData.status });
    } else {
      res.json({ message: 'No data returned from Increase' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /webhooks — Receive Increase webhook events -----------------------
router.post('/webhooks', (req, res) => {
  try {
    const db = req.db;
    const event = req.body;

    if (!event.id || !event.category) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    // Store event
    db.prepare(`
      INSERT OR IGNORE INTO rail_webhook_events
        (event_id, category, associated_object_type, associated_object_id, payload, status)
      VALUES (?, ?, ?, ?, ?, 'received')
    `).run(
      event.id,
      event.category,
      event.associated_object_type || null,
      event.associated_object_id || null,
      JSON.stringify(event)
    );

    // Process event — update local rail transaction status
    const objectId = event.associated_object_id;
    if (objectId) {
      const tx = db.prepare('SELECT * FROM rail_transactions WHERE increase_transfer_id = ?').get(objectId);
      if (tx) {
        let newStatus = null;
        const category = event.category;

        if (category.includes('.updated') || category.includes('.created')) {
          // Map known categories to statuses
          if (category.includes('returned')) newStatus = 'returned';
          else if (category.includes('completed') || category.includes('deposited')) newStatus = 'completed';
          else if (category.includes('submitted')) newStatus = 'submitted';
          else if (category.includes('reversed')) newStatus = 'reversed';
          else if (category.includes('canceled') || category.includes('stopped')) newStatus = 'cancelled';
          else if (category.includes('failed') || category.includes('rejected')) newStatus = 'failed';
        }

        if (newStatus && newStatus !== tx.status) {
          db.prepare(`UPDATE rail_transactions SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(newStatus, tx.id);

          // Update linked external transfer if exists
          if (tx.external_transfer_id) {
            const extStatusMap = {
              completed: 'completed', returned: 'failed', failed: 'failed',
              reversed: 'failed', cancelled: 'cancelled', submitted: 'processing',
            };
            const extStatus = extStatusMap[newStatus];
            if (extStatus) {
              db.prepare(`UPDATE external_transfers SET status = ?, updated_at = datetime('now') WHERE id = ?`)
                .run(extStatus, tx.external_transfer_id);
            }
          }
        }

        db.prepare(`UPDATE rail_webhook_events SET status = 'processed', processed_at = datetime('now') WHERE event_id = ?`).run(event.id);
      }
    }

    insertAudit(db, buildRailAuditEntry('webhook_received', 0, 'process_webhook', 'increase', { category: event.category, object_id: objectId }));
    res.status(200).json({ received: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /webhooks/events — List webhook events -----------------------------
router.get('/webhooks/events', (req, res) => {
  try {
    const { status, limit } = req.query;
    let where = '';
    let params = [];
    if (status) { where = 'WHERE status = ?'; params.push(status); }
    const lim = Math.min(parseInt(limit) || 50, 200);

    const rows = req.db.prepare(`SELECT * FROM rail_webhook_events ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, lim);
    res.json({ events: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /reconciliation — Reconciliation reports ---------------------------
router.get('/reconciliation', (req, res) => {
  try {
    const { date, rail } = req.query;
    let where = [];
    let params = [];
    if (date) { where.push('recon_date = ?'); params.push(date); }
    if (rail) { where.push('rail = ?'); params.push(rail); }
    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    const rows = req.db.prepare(`SELECT * FROM rail_reconciliation ${whereClause} ORDER BY recon_date DESC LIMIT 30`).all(...params);
    rows.forEach(r => {
      r.total_sent_usd = toDollars(r.total_sent_cents);
      r.total_received_usd = toDollars(r.total_received_cents);
      r.total_fees_usd = toDollars(r.total_fees_cents);
    });
    res.json({ reconciliation: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /reconciliation/run — Run reconciliation for a date ---------------
router.post('/reconciliation/run', (req, res) => {
  try {
    const db = req.db;
    const date = req.body.date || new Date().toISOString().slice(0, 10);

    for (const rail of Object.keys(RAILS)) {
      const stats = db.prepare(`
        SELECT
          COUNT(*) as tx_count,
          COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_cents ELSE 0 END), 0) as sent,
          COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_cents ELSE 0 END), 0) as received,
          COALESCE(SUM(fee_cents), 0) as fees,
          COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as matched,
          COALESCE(SUM(CASE WHEN status IN ('failed', 'returned') THEN 1 ELSE 0 END), 0) as unmatched
        FROM rail_transactions
        WHERE rail = ? AND DATE(created_at) = ?
      `).get(rail, date);

      if (stats.tx_count > 0) {
        db.prepare(`
          INSERT INTO rail_reconciliation (recon_date, rail, total_sent_cents, total_received_cents, total_fees_cents, transactions_count, matched_count, unmatched_count, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT DO NOTHING
        `).run(
          date, rail, stats.sent, stats.received, stats.fees,
          stats.tx_count, stats.matched, stats.unmatched,
          stats.unmatched > 0 ? 'exception' : 'matched'
        );
      }
    }

    insertAudit(db, buildRailAuditEntry('reconciliation_run', 0, 'run_reconciliation', req.body.actor || 'system', { date }));
    res.json({ message: `Reconciliation completed for ${date}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
