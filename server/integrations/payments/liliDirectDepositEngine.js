'use strict';

/**
 * Lili Direct Deposit Engine
 *
 * Unified workflow for funding the trust's Lili business checking account
 * (DB Net Mgmt LLC) by ACH credit / direct deposit.
 *
 * Lili is a receiving bank (RDFI): it has no file intake and its MCP server
 * exposes no payment tools, so an ACH credit must be originated through the
 * trust's ODFI. This engine ties the three sides together in one record:
 *
 *   lili_direct_deposits  ──►  lili_payments (unified payment ledger)
 *                         ──►  ach_batches   (NACHA PPD/CCD credit, entry 22)
 *                         ──►  Lili MCP transaction feed (reconciliation)
 *
 * Lifecycle:
 *   awaiting_odfi  NACHA file generated + journaled, no ODFI channel configured
 *   transmitted    handed to the ODFI (AS2 / MFT / REST / SFTP)
 *   reconciled     matching FUND_TRANSFER credit seen on the Lili account
 *   returned | cancelled
 *
 * Destination account settings (SystemSettings or env):
 *   LILI_DD_ROUTING_NUMBER, LILI_DD_ACCOUNT_NUMBER, LILI_DD_ACCOUNT_NAME
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

let SystemSettings;
let LiliMcpEngine;
let LiliBankEngine;
let ACHEngine;
let PaymentOrchestrator;
let AS2Client;
let AS2Partners;
let validateRouting;
function loadDeps() {
  try { ({ SystemSettings } = require('../ach/systemSettings')); } catch (e) { SystemSettings = null; }
  try { ({ LiliMcpEngine } = require('./liliMcpEngine')); } catch (e) { LiliMcpEngine = null; }
  try { ({ LiliBankEngine } = require('./liliBankEngine')); } catch (e) { LiliBankEngine = null; }
  try { ({ ACHEngine } = require('../ach/achEngine')); } catch (e) { ACHEngine = null; }
  try { ({ PaymentOrchestrator } = require('../ach/paymentOrchestrator')); } catch (e) { PaymentOrchestrator = null; }
  try { ({ AS2Client } = require('../ach/as2Client')); } catch (e) { AS2Client = null; }
  try { ({ AS2Partners } = require('../ach/as2Partners')); } catch (e) { AS2Partners = null; }
  try { ({ validateRouting } = require('../ach/nachaGenerator')); } catch (e) { validateRouting = null; }
}

async function getSetting(name) {
  loadDeps();
  if (SystemSettings && typeof SystemSettings.get === 'function') {
    try {
      const v = await SystemSettings.get(name);
      if (v !== null && v !== undefined && v !== '') return v;
    } catch (e) { /* fall through */ }
  }
  return process.env[name] || null;
}

async function setSetting(name, value, updatedBy = 'system') {
  loadDeps();
  if (SystemSettings && typeof SystemSettings.set === 'function') {
    await SystemSettings.set(name, value, updatedBy);
  }
}

function generateId(prefix = 'LILIDD') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toDate(d) {
  return new Date(d).toISOString().split('T')[0];
}

function addDays(d, n) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return toDate(x);
}

const STATUSES = ['awaiting_odfi', 'transmitted', 'reconciled', 'returned', 'cancelled'];

class LiliDirectDepositEngine {
  static async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lili_direct_deposits (
        id SERIAL PRIMARY KEY,
        deposit_id TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'awaiting_odfi' CHECK (status IN ('awaiting_odfi','transmitted','reconciled','returned','cancelled')),
        amount_cents BIGINT NOT NULL,
        sec_code TEXT NOT NULL DEFAULT 'PPD',
        effective_date DATE NOT NULL,
        memo TEXT,
        payment_type TEXT NOT NULL DEFAULT 'trust_distribution',
        receiver_name TEXT NOT NULL,
        receiver_routing TEXT NOT NULL,
        receiver_account_last4 TEXT NOT NULL,
        lili_payment_id TEXT,
        ach_batch_id TEXT,
        journal_entry_id TEXT,
        lili_transaction_id TEXT,
        reconciled_at TIMESTAMPTZ,
        error_message TEXT,
        created_by TEXT NOT NULL DEFAULT 'system',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_lili_dd_status ON lili_direct_deposits(status)');
  }

  // ── Destination (the trust's Lili checking account) ─────────────────────

  static async getDestination() {
    const routing = await getSetting('LILI_DD_ROUTING_NUMBER');
    const account = await getSetting('LILI_DD_ACCOUNT_NUMBER');
    const name = (await getSetting('LILI_DD_ACCOUNT_NAME')) || 'DB NET MGMT LLC';
    return {
      configured: Boolean(routing && account),
      routingNumber: routing || null,
      accountNumberMasked: account ? `****${String(account).slice(-4)}` : null,
      accountName: name,
      _account: account || null,
    };
  }

  static async setDestination({ routingNumber, accountNumber, accountName, updatedBy = 'system' } = {}) {
    loadDeps();
    if (!routingNumber || !accountNumber) throw new Error('routingNumber and accountNumber are required');
    if (validateRouting && !validateRouting(String(routingNumber))) throw new Error(`Invalid routing number: ${routingNumber}`);
    await setSetting('LILI_DD_ROUTING_NUMBER', String(routingNumber), updatedBy);
    await setSetting('LILI_DD_ACCOUNT_NUMBER', String(accountNumber), updatedBy);
    if (accountName) await setSetting('LILI_DD_ACCOUNT_NAME', String(accountName), updatedBy);
    const dest = await this.getDestination();
    delete dest._account;
    return dest;
  }

  /**
   * Pull routing/account details from the Lili MCP account summary so the
   * operator does not have to key them in. Lili only returns the routing
   * number for the primary UBO checking account.
   */
  static async syncDestinationFromLili({ businessUserId, updatedBy = 'system' } = {}) {
    loadDeps();
    if (!LiliMcpEngine) throw new Error('Lili MCP engine not available');
    const summary = await LiliMcpEngine.getAccountSummary(businessUserId);
    if (!summary || typeof summary !== 'object') throw new Error('Lili account summary unavailable');
    const routing = summary.routingNumber;
    const account = summary.accountNumber || null;
    if (!routing) throw new Error('Lili did not return a routing number (only available for the primary UBO checking account)');
    if (!account) {
      return {
        synced: false,
        reason: 'Lili MCP returns the account number masked; enter the full account number via setDestination',
        routingNumber: routing,
        accountNumberMasked: summary.accountNumberMasked || null,
      };
    }
    return { synced: true, ...(await this.setDestination({ routingNumber: routing, accountNumber: account, updatedBy })) };
  }

  // ── ODFI readiness ──────────────────────────────────────────────────────

  static async odfiStatus() {
    loadDeps();
    const channels = [];
    if (ACHEngine && typeof ACHEngine.mftChannelId === 'function' && ACHEngine.mftChannelId()) channels.push('mft');
    if (AS2Client && typeof AS2Client.getConfigStatus === 'function') {
      try { if (AS2Client.getConfigStatus().configured) channels.push('as2'); } catch (e) { /* ignore */ }
    }
    if (AS2Partners && typeof AS2Partners.getDefaultPartnerConfig === 'function') {
      try { if (await AS2Partners.getDefaultPartnerConfig()) channels.push('as2_partner'); } catch (e) { /* ignore */ }
    }
    if (SystemSettings && typeof SystemSettings.getProductionPartnerConfig === 'function') {
      try { if (await SystemSettings.getProductionPartnerConfig()) channels.push('production_partner'); } catch (e) { /* ignore */ }
    }
    if (process.env.ACH_SFTP_URL) channels.push('sftp');
    return { ready: channels.length > 0, channels };
  }

  // ── Create ──────────────────────────────────────────────────────────────

  /**
   * Create a direct deposit into the Lili account.
   * One call produces the unified record, the lili_payments row, the NACHA
   * credit batch (+ journal entry + cashflow event) and, when an ODFI channel
   * is configured, transmits the batch.
   */
  static async createDirectDeposit({
    amount,
    amountCents,
    memo,
    effectiveDate,
    secCode = 'PPD',
    paymentType = 'trust_distribution',
    sourceAccountId,
    businessUserId,
    autoTransmit = true,
    createdBy = 'system',
  } = {}) {
    loadDeps();
    if (!pool) throw new Error('Database not available');
    if (!ACHEngine || !PaymentOrchestrator) throw new Error('ACH pipeline not available');
    await this.ensureTables();

    const cents = amountCents != null ? Math.round(Number(amountCents)) : Math.round((Number(amount) || 0) * 100);
    if (!Number.isFinite(cents) || cents <= 0) throw new Error('amount must be positive');
    if (!['PPD', 'CCD'].includes(secCode)) throw new Error('secCode must be PPD or CCD');

    const dest = await this.getDestination();
    if (!dest.configured) throw new Error('Lili destination account not configured (LILI_DD_ROUTING_NUMBER / LILI_DD_ACCOUNT_NUMBER)');

    const effDate = effectiveDate ? toDate(effectiveDate) : toDate(new Date());
    const depositId = generateId();
    const description = (memo || 'LILI DEPOSIT').toUpperCase().slice(0, 10);

    let liliPaymentId = null;
    if (LiliBankEngine) {
      await LiliBankEngine.ensureTables();
      liliPaymentId = generateId('LILIPAY');
      await pool.query(
        `INSERT INTO lili_payments (payment_id, status, type, amount_cents, currency, recipient_name, recipient_account, recipient_routing, recipient_bank, source_account_id, lili_business_user_id, request_body, initiated_by)
         VALUES ($1,'pending','ach',$2,'USD',$3,$4,$5,'Lili',$6,$7,$8,$9)`,
        [liliPaymentId, cents, dest.accountName, dest.accountNumberMasked, dest.routingNumber, sourceAccountId || null, businessUserId || null,
          JSON.stringify({ direction: 'credit', rail: 'ach_direct_deposit', depositId, memo: memo || null }), createdBy]
      );
    }

    const disbursement = await PaymentOrchestrator.createDisbursementWithAccounting({
      entries: [{
        receivingRouting: dest.routingNumber,
        accountNumber: dest._account,
        amountCents: cents,
        transactionCode: '22',
        individualId: depositId.slice(-15),
        individualName: dest.accountName.slice(0, 22),
        memo: memo || '',
      }],
      effectiveDate: effDate,
      secCode,
      description,
      paymentType,
      createdBy,
    });
    const batchId = disbursement.batch.batch_id;
    const journalEntryId = disbursement.journal_entry ? (disbursement.journal_entry.entry_id || disbursement.journal_entry.id || null) : null;

    await pool.query(
      `INSERT INTO lili_direct_deposits (deposit_id, status, amount_cents, sec_code, effective_date, memo, payment_type, receiver_name, receiver_routing, receiver_account_last4, lili_payment_id, ach_batch_id, journal_entry_id, created_by)
       VALUES ($1,'awaiting_odfi',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [depositId, cents, secCode, effDate, memo || null, paymentType, dest.accountName, dest.routingNumber, String(dest._account).slice(-4), liliPaymentId, batchId, journalEntryId ? String(journalEntryId) : null, createdBy]
    );

    const odfi = await this.odfiStatus();
    if (autoTransmit && odfi.ready) {
      await this.transmit(depositId, { actor: createdBy });
    } else if (liliPaymentId) {
      await pool.query(
        `UPDATE lili_payments SET status='manual_pending', error_message=$1, updated_at=NOW() WHERE payment_id=$2`,
        [odfi.ready ? 'NACHA credit generated; awaiting operator transmit' : 'NACHA credit generated; no ODFI channel configured (AS2/MFT/REST/SFTP) — transmits automatically once one is', liliPaymentId]
      );
    }

    return this.getDirectDeposit(depositId);
  }

  // ── Transmit ────────────────────────────────────────────────────────────

  static async transmit(depositId, { approvedBy = null, actor = null } = {}) {
    loadDeps();
    const row = await this._row(depositId);
    if (!row) throw new Error('Direct deposit not found');
    if (row.status !== 'awaiting_odfi') throw new Error(`Cannot transmit direct deposit in '${row.status}' status`);
    if (!row.ach_batch_id) throw new Error('Direct deposit has no ACH batch');

    const odfi = await this.odfiStatus();
    if (!odfi.ready) throw new Error('No ODFI channel configured (AS2/MFT/REST/SFTP); NACHA file remains queued');

    try {
      const result = await ACHEngine.transmitBatch(row.ach_batch_id, { approvedBy, actor });
      const ok = result && result.success !== false;
      await pool.query(
        `UPDATE lili_direct_deposits SET status=$1, error_message=$2, updated_at=NOW() WHERE deposit_id=$3`,
        [ok ? 'transmitted' : 'awaiting_odfi', ok ? null : (result && result.error) || 'Transmission failed', depositId]
      );
      if (row.lili_payment_id) {
        await pool.query(
          `UPDATE lili_payments SET status=$1, external_tx_id=$2, error_message=$3, updated_at=NOW() WHERE payment_id=$4`,
          [ok ? 'api_pending' : 'manual_pending', ok ? (result.message_id || result.transmission_id || row.ach_batch_id) : null, ok ? null : (result && result.error) || 'Transmission failed', row.lili_payment_id]
        );
      }
      return { ...(await this.getDirectDeposit(depositId)), transmission: result };
    } catch (err) {
      await pool.query(
        `UPDATE lili_direct_deposits SET error_message=$1, updated_at=NOW() WHERE deposit_id=$2`,
        [err.message, depositId]
      );
      throw err;
    }
  }

  /** Transmit every queued deposit once an ODFI channel becomes available. */
  static async transmitQueued({ actor = 'system' } = {}) {
    if (!pool) throw new Error('Database not available');
    await this.ensureTables();
    const odfi = await this.odfiStatus();
    if (!odfi.ready) return { transmitted: 0, skipped: 'no ODFI channel configured' };
    const rows = await pool.query(`SELECT deposit_id FROM lili_direct_deposits WHERE status='awaiting_odfi' ORDER BY created_at`);
    const results = [];
    for (const r of rows.rows) {
      try { await this.transmit(r.deposit_id, { actor }); results.push({ depositId: r.deposit_id, ok: true }); }
      catch (err) { results.push({ depositId: r.deposit_id, ok: false, error: err.message }); }
    }
    return { transmitted: results.filter(x => x.ok).length, results };
  }

  // ── Reconcile against the Lili transaction feed ─────────────────────────

  /**
   * Look for incoming FUND_TRANSFER credits on the Lili account matching the
   * amount of each transmitted (or queued) deposit, within a settlement window
   * around the effective date. Marks matches reconciled and completes the
   * linked lili_payments row.
   */
  static async reconcile({ businessUserId, windowDays = 5, depositId } = {}) {
    loadDeps();
    if (!pool) throw new Error('Database not available');
    if (!LiliMcpEngine) throw new Error('Lili MCP engine not available');
    await this.ensureTables();

    const params = [];
    let where = `status IN ('transmitted','awaiting_odfi')`;
    if (depositId) { params.push(depositId); where += ` AND deposit_id=$${params.length}`; }
    const open = await pool.query(`SELECT * FROM lili_direct_deposits WHERE ${where} ORDER BY effective_date`, params);
    if (!open.rows.length) return { matched: 0, unmatched: 0, deposits: [] };

    const startDate = addDays(open.rows[0].effective_date, -1);
    const endDate = addDays(Math.max(...open.rows.map(r => new Date(r.effective_date).getTime())), windowDays);

    const cfg = await LiliMcpEngine.getConfig();
    const args = { startDate, endDate, transactionType: 'FUND_TRANSFER', recordCnt: 100 };
    const bid = businessUserId || cfg.businessUserId;
    if (bid) args.businessUserId = bid;
    const feed = LiliMcpEngine._extractText(await LiliMcpEngine.callTool('lili_search_transactions', args));
    const txns = Array.isArray(feed) ? feed : (feed && (feed.transactions || feed.items || feed.results)) || [];

    const used = new Set();
    const already = await pool.query(`SELECT lili_transaction_id FROM lili_direct_deposits WHERE lili_transaction_id IS NOT NULL`);
    for (const r of already.rows) used.add(String(r.lili_transaction_id));

    const out = [];
    for (const dep of open.rows) {
      const match = txns.find(t => {
        if (!t || used.has(String(t.transactionId))) return false;
        const cents = Math.abs(Math.round(Number(t.amountCents != null ? t.amountCents : Number(t.amountUsd) * 100)));
        if (cents !== Number(dep.amount_cents)) return false;
        if (t.pending === true) return false;
        const ts = t.timestamp ? toDate(t.timestamp) : null;
        return !ts || (ts >= addDays(dep.effective_date, -1) && ts <= addDays(dep.effective_date, windowDays));
      });
      if (!match) { out.push({ depositId: dep.deposit_id, matched: false }); continue; }
      used.add(String(match.transactionId));
      await pool.query(
        `UPDATE lili_direct_deposits SET status='reconciled', lili_transaction_id=$1, reconciled_at=NOW(), error_message=NULL, updated_at=NOW() WHERE deposit_id=$2`,
        [String(match.transactionId), dep.deposit_id]
      );
      if (dep.lili_payment_id) {
        await pool.query(
          `UPDATE lili_payments SET status='completed', external_tx_id=$1, error_message=NULL, updated_at=NOW() WHERE payment_id=$2`,
          [String(match.transactionId), dep.lili_payment_id]
        );
      }
      if (dep.ach_batch_id && ACHEngine && typeof ACHEngine.settleBatch === 'function') {
        try { await ACHEngine.settleBatch(dep.ach_batch_id, { source: 'lili_mcp', liliTransactionId: match.transactionId }); } catch (e) { /* batch may already be settled */ }
      }
      out.push({ depositId: dep.deposit_id, matched: true, liliTransactionId: match.transactionId });
    }
    return { matched: out.filter(x => x.matched).length, unmatched: out.filter(x => !x.matched).length, window: { startDate, endDate }, deposits: out };
  }

  // ── Read ────────────────────────────────────────────────────────────────

  static async _row(depositId) {
    if (!pool) throw new Error('Database not available');
    const res = await pool.query('SELECT * FROM lili_direct_deposits WHERE deposit_id=$1', [depositId]);
    return res.rows[0] || null;
  }

  /** Unified view: deposit + linked lili_payment + ACH batch. */
  static async getDirectDeposit(depositId) {
    const row = await this._row(depositId);
    if (!row) return null;
    let payment = null;
    let batch = null;
    if (row.lili_payment_id) {
      const p = await pool.query('SELECT payment_id, status, amount_cents, external_tx_id, error_message, updated_at FROM lili_payments WHERE payment_id=$1', [row.lili_payment_id]);
      payment = p.rows[0] || null;
    }
    if (row.ach_batch_id) {
      const b = await pool.query('SELECT batch_id, status, filename, sec_code, effective_date, entry_count, total_amount_cents, transmitted_at FROM ach_batches WHERE batch_id=$1', [row.ach_batch_id]);
      batch = b.rows[0] || null;
    }
    return { ...row, amount_usd: Number(row.amount_cents) / 100, lili_payment: payment, ach_batch: batch };
  }

  static async listDirectDeposits({ status, limit = 50 } = {}) {
    if (!pool) throw new Error('Database not available');
    await this.ensureTables();
    const params = [];
    let sql = 'SELECT * FROM lili_direct_deposits';
    if (status) { params.push(status); sql += ` WHERE status=$${params.length}`; }
    params.push(Number(limit) || 50);
    sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const res = await pool.query(sql, params);
    return res.rows.map(r => ({ ...r, amount_usd: Number(r.amount_cents) / 100 }));
  }

  static async cancel(depositId) {
    loadDeps();
    const row = await this._row(depositId);
    if (!row) throw new Error('Direct deposit not found');
    if (row.status !== 'awaiting_odfi') throw new Error(`Only queued (awaiting_odfi) deposits can be cancelled; status is '${row.status}'`);
    if (row.ach_batch_id && ACHEngine) { try { await ACHEngine.cancelBatch(row.ach_batch_id); } catch (e) { /* ignore */ } }
    await pool.query(`UPDATE lili_direct_deposits SET status='cancelled', updated_at=NOW() WHERE deposit_id=$1`, [depositId]);
    if (row.lili_payment_id) await pool.query(`UPDATE lili_payments SET status='cancelled', updated_at=NOW() WHERE payment_id=$1`, [row.lili_payment_id]);
    return this.getDirectDeposit(depositId);
  }

  static async getWorkflowStatus() {
    const dest = await this.getDestination();
    delete dest._account;
    const odfi = await this.odfiStatus();
    let mcp = { configured: false };
    loadDeps();
    if (LiliMcpEngine) { try { mcp = await LiliMcpEngine.getPublicConfig(); } catch (e) { /* ignore */ } }
    let counts = {};
    if (pool) {
      await this.ensureTables();
      const res = await pool.query('SELECT status, COUNT(*)::int AS n, COALESCE(SUM(amount_cents),0)::bigint AS cents FROM lili_direct_deposits GROUP BY status');
      for (const r of res.rows) counts[r.status] = { count: r.n, amountUsd: Number(r.cents) / 100 };
    }
    return {
      flow: 'DLB Trust ledger → NACHA ACH credit (entry 22) → ODFI → Lili (RDFI) → MCP reconciliation',
      destination: dest,
      odfi,
      mcp: { configured: Boolean(mcp.configured), lastRefreshError: mcp.lastRefreshError || null },
      ready: dest.configured && odfi.ready,
      statuses: STATUSES,
      counts,
    };
  }
}

module.exports = { LiliDirectDepositEngine };
