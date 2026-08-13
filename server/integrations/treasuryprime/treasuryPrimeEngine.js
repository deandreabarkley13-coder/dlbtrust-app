'use strict';

/**
 * TreasuryPrimeEngine
 *
 * Banking layer over Treasury Prime: account/balance sync, the org ledger,
 * and the three money-movement rails (book transfer, ACH, wire) with a local
 * audit trail, webhook-driven status transitions, and GL reconciliation.
 *
 * Amounts stay in Treasury Prime's native decimal-string form ("250.00")
 * everywhere — in the API payloads, in Postgres NUMERIC columns (pg returns
 * NUMERIC as a string), and in the JSON this engine returns. Arithmetic goes
 * through decimalAmount.js, which is exact BigInt math, so no float rounding
 * is ever introduced. This deliberately differs from the internal cash ledger,
 * which uses integer cents; conversion happens only at the GL boundary.
 */

const client = require('./treasuryPrimeClient');
const {
  normalizeAmount,
  coerceAmount,
  subtractAmounts,
  compareAmounts,
  isZeroAmount,
  isPositiveAmount,
  absAmount,
} = require('./decimalAmount');

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const TRANSFER_KINDS = ['book', 'ach', 'wire'];

function safeJson(obj) {
  return JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? String(v) : v));
}

async function query(text, params) {
  if (!pool) throw new Error('Postgres pool not available');
  return pool.query(text, params);
}

function assertKind(kind) {
  if (!TRANSFER_KINDS.includes(kind)) {
    throw new Error(`kind must be one of ${TRANSFER_KINDS.join(', ')} (got "${kind}")`);
  }
}

class TreasuryPrimeEngine {
  static async ensureTables() {
    if (!pool) return;
    await query(`
      CREATE TABLE IF NOT EXISTS treasury_prime_accounts (
        id TEXT PRIMARY KEY,
        org_id TEXT,
        bank_id TEXT,
        name TEXT,
        nickname TEXT,
        account_type TEXT,
        account_number TEXT,
        routing_number TEXT,
        currency TEXT,
        status TEXT,
        available_balance NUMERIC,
        current_balance NUMERIC,
        last_reconciled_balance NUMERIC,
        raw JSONB,
        synced_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS treasury_prime_transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        type TEXT,
        amount NUMERIC,
        balance NUMERIC,
        description TEXT,
        posted_date TEXT,
        extended_timestamp TIMESTAMPTZ,
        ach_id TEXT,
        wire_id TEXT,
        book_id TEXT,
        raw JSONB,
        synced_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS treasury_prime_counterparties (
        id TEXT PRIMARY KEY,
        name_on_account TEXT,
        has_ach BOOLEAN,
        has_wire BOOLEAN,
        raw JSONB,
        synced_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS treasury_prime_transfers (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        account_id TEXT,
        counterparty_id TEXT,
        to_account_id TEXT,
        direction TEXT,
        amount NUMERIC NOT NULL,
        status TEXT,
        error TEXT,
        memo TEXT,
        sec_code TEXT,
        effective_date TEXT,
        hold_transaction_id TEXT,
        initiated_by TEXT,
        raw JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS treasury_prime_webhook_events (
        id TEXT PRIMARY KEY,
        event_type TEXT,
        object_id TEXT,
        object_kind TEXT,
        status TEXT,
        raw JSONB,
        received_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  // ─── Status ───────────────────────────────────────────────────────────────
  static async getStatus() {
    const status = {
      configured: client.isConfigured(),
      baseUrl: client.baseUrl(),
      environment: client.isProduction() ? 'production' : 'sandbox',
      amountFormat: 'decimal-string',
      reachable: false,
      apiVersion: null,
      error: null,
    };
    if (!status.configured) {
      status.error = 'TREASURY_PRIME_API_KEY_ID and TREASURY_PRIME_API_SECRET not set';
      return status;
    }
    try {
      const pong = await client.ping();
      status.reachable = true;
      status.apiVersion = pong.api_version || null;
      status.serverTime = pong.time || null;
    } catch (err) {
      status.error = err.message;
    }
    return status;
  }

  // ─── Accounts ─────────────────────────────────────────────────────────────
  static async syncAccounts() {
    const accounts = await client.listAccounts();
    // The list endpoint omits balances; the detail endpoint carries them.
    const detailed = [];
    for (const summary of accounts) {
      let account = summary;
      try {
        account = await client.getAccount(summary.id);
      } catch (e) { /* keep the summary if detail lookup fails */ }
      detailed.push(this.normalizeAccount(account));
    }
    if (pool && detailed.length) {
      await this.ensureTables();
      for (const a of detailed) {
        await query(`
          INSERT INTO treasury_prime_accounts
            (id, org_id, bank_id, name, nickname, account_type, account_number, routing_number,
             currency, status, available_balance, current_balance, raw, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,NOW())
          ON CONFLICT (id) DO UPDATE SET
            org_id=$2, bank_id=$3, name=$4, nickname=$5, account_type=$6, account_number=$7,
            routing_number=$8, currency=$9, status=$10, available_balance=$11, current_balance=$12,
            raw=$13::jsonb, synced_at=NOW()
        `, [a.id, a.orgId, a.bankId, a.name, a.nickname, a.accountType, a.accountNumber, a.routingNumber,
          a.currency, a.status, a.availableBalance, a.currentBalance, safeJson(a.raw)]).catch(() => {});
      }
    }
    return detailed;
  }

  static normalizeAccount(account) {
    return {
      id: account.id,
      orgId: account.org_id || null,
      bankId: account.bank_id || null,
      name: account.name || null,
      nickname: account.nickname || null,
      accountType: account.account_type || null,
      accountNumber: account.account_number || null,
      routingNumber: account.routing_number || null,
      currency: account.currency || 'USD',
      status: account.status || null,
      availableBalance: coerceAmount(account.available_balance),
      currentBalance: coerceAmount(account.current_balance),
      raw: account,
    };
  }

  static async getAccount(accountId) {
    return this.normalizeAccount(await client.getAccount(accountId));
  }

  static async getBalances() {
    const accounts = await this.syncAccounts();
    return accounts.map((a) => ({
      id: a.id,
      name: a.name,
      accountType: a.accountType,
      accountNumber: a.accountNumber,
      currency: a.currency,
      availableBalance: a.availableBalance,
      currentBalance: a.currentBalance,
    }));
  }

  // ─── Ledger ───────────────────────────────────────────────────────────────
  static normalizeTransaction(tx) {
    return {
      id: tx.id,
      accountId: tx.account_id || null,
      type: tx.type || null,
      amount: coerceAmount(tx.amount),
      balance: coerceAmount(tx.balance),
      description: tx.human_readable_description || tx.desc || null,
      postedDate: tx.date || null,
      extendedTimestamp: tx.extended_timestamp || null,
      achId: tx.ach_id || tx.incoming_ach_id || null,
      wireId: tx.wire_id || tx.incoming_wire_id || null,
      bookId: tx.book_id || null,
      raw: tx,
    };
  }

  static async syncTransactions({ accountId, ...params } = {}) {
    const raw = accountId
      ? await client.listAccountTransactions(accountId, params)
      : await client.listTransactions(params);
    const transactions = raw.map((tx) => {
      const normalized = this.normalizeTransaction(tx);
      // Per-account listings omit account_id; carry it over from the request.
      if (!normalized.accountId && accountId) normalized.accountId = accountId;
      return normalized;
    });
    if (pool && transactions.length) {
      await this.ensureTables();
      for (const t of transactions) {
        await query(`
          INSERT INTO treasury_prime_transactions
            (id, account_id, type, amount, balance, description, posted_date, extended_timestamp,
             ach_id, wire_id, book_id, raw, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,NOW())
          ON CONFLICT (id) DO UPDATE SET
            account_id=$2, type=$3, amount=$4, balance=$5, description=$6, posted_date=$7,
            extended_timestamp=$8, ach_id=$9, wire_id=$10, book_id=$11, raw=$12::jsonb, synced_at=NOW()
        `, [t.id, t.accountId, t.type, t.amount, t.balance, t.description, t.postedDate,
          t.extendedTimestamp, t.achId, t.wireId, t.bookId, safeJson(t.raw)]).catch(() => {});
      }
    }
    return transactions;
  }

  // ─── Counterparties ───────────────────────────────────────────────────────
  static async listCounterparties() {
    const counterparties = await client.listCounterparties();
    if (pool && counterparties.length) {
      await this.ensureTables();
      for (const cp of counterparties) {
        await query(`
          INSERT INTO treasury_prime_counterparties (id, name_on_account, has_ach, has_wire, raw, synced_at)
          VALUES ($1,$2,$3,$4,$5::jsonb,NOW())
          ON CONFLICT (id) DO UPDATE SET name_on_account=$2, has_ach=$3, has_wire=$4, raw=$5::jsonb, synced_at=NOW()
        `, [cp.id, cp.name_on_account, !!cp.ach, !!cp.wire, safeJson(cp)]).catch(() => {});
      }
    }
    return counterparties;
  }

  static async createCounterparty(input) {
    const counterparty = await client.createCounterparty(input);
    if (pool) {
      await this.ensureTables();
      await query(`
        INSERT INTO treasury_prime_counterparties (id, name_on_account, has_ach, has_wire, raw, synced_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,NOW())
        ON CONFLICT (id) DO UPDATE SET name_on_account=$2, has_ach=$3, has_wire=$4, raw=$5::jsonb, synced_at=NOW()
      `, [counterparty.id, counterparty.name_on_account, !!counterparty.ach, !!counterparty.wire, safeJson(counterparty)]).catch(() => {});
    }
    return counterparty;
  }

  // ─── Money movement ───────────────────────────────────────────────────────
  /**
   * Reject a transfer that the funding account cannot cover, before it reaches
   * the bank. Compares decimal strings exactly (no float tolerance).
   */
  static async assertSufficientFunds(accountId, amount) {
    const account = await this.getAccount(accountId);
    const available = account.availableBalance;
    if (available === null) return { checked: false, availableBalance: null };
    if (compareAmounts(available, amount) < 0) {
      throw new Error(`Insufficient available balance on ${accountId}: have ${available}, need ${amount}`);
    }
    return { checked: true, availableBalance: available };
  }

  static async recordTransfer(kind, transfer, { initiatedBy = null, memo = null } = {}) {
    assertKind(kind);
    const row = {
      id: transfer.id,
      kind,
      accountId: transfer.account_id || transfer.from_account_id || null,
      counterpartyId: transfer.counterparty_id || null,
      toAccountId: transfer.to_account_id || null,
      direction: transfer.direction || (kind === 'book' ? 'internal' : 'credit'),
      amount: coerceAmount(transfer.amount),
      status: transfer.status || null,
      error: transfer.error || null,
      memo: memo || transfer.memo || transfer.description || null,
      secCode: transfer.sec_code || null,
      effectiveDate: transfer.effective_date || null,
      holdTransactionId: (transfer.bankdata && transfer.bankdata.hold_id) || null,
    };
    if (pool) {
      await this.ensureTables();
      await query(`
        INSERT INTO treasury_prime_transfers
          (id, kind, account_id, counterparty_id, to_account_id, direction, amount, status, error,
           memo, sec_code, effective_date, hold_transaction_id, initiated_by, raw, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,NOW(),NOW())
        ON CONFLICT (id) DO UPDATE SET
          status=$8, error=$9, hold_transaction_id=$13, raw=$15::jsonb, updated_at=NOW()
      `, [row.id, row.kind, row.accountId, row.counterpartyId, row.toAccountId, row.direction, row.amount,
        row.status, row.error, row.memo, row.secCode, row.effectiveDate, row.holdTransactionId,
        initiatedBy, safeJson(transfer)]).catch(() => {});
    }
    return { ...row, raw: transfer };
  }

  /** Internal transfer between two org accounts — posts instantly, double-entry. */
  static async initiateBookTransfer({ amount, fromAccountId, toAccountId, memo, userdata, initiatedBy, skipBalanceCheck = false }) {
    const normalized = normalizeAmount(amount);
    if (!isPositiveAmount(normalized)) throw new Error('amount must be greater than 0.00');
    if (fromAccountId === toAccountId) throw new Error('fromAccountId and toAccountId must differ');
    if (!skipBalanceCheck) await this.assertSufficientFunds(fromAccountId, normalized);
    const transfer = await client.createBookTransfer({ amount: normalized, fromAccountId, toAccountId, memo, userdata });
    return this.recordTransfer('book', transfer, { initiatedBy, memo });
  }

  /**
   * ACH debit or credit against an external counterparty. A credit creates a
   * hold transaction (available balance drops) before it posts — the hold id
   * comes back on bankdata.hold_id and is retained for reconciliation.
   */
  static async initiateAch({ amount, direction, accountId, counterpartyId, secCode, entryDesc, effectiveDate, service, addenda, userdata, initiatedBy, skipBalanceCheck = false }) {
    const normalized = normalizeAmount(amount);
    if (!isPositiveAmount(normalized)) throw new Error('amount must be greater than 0.00');
    if (direction === 'credit' && !skipBalanceCheck) await this.assertSufficientFunds(accountId, normalized);
    const transfer = await client.createAch({
      amount: normalized, direction, accountId, counterpartyId, secCode, entryDesc, effectiveDate, service, addenda, userdata,
    });
    return this.recordTransfer('ach', transfer, { initiatedBy, memo: entryDesc });
  }

  /** Outbound wire to a counterparty holding wire instructions. */
  static async initiateWire({ amount, accountId, counterpartyId, memo, purpose, instructions, userdata, initiatedBy, skipBalanceCheck = false }) {
    const normalized = normalizeAmount(amount);
    if (!isPositiveAmount(normalized)) throw new Error('amount must be greater than 0.00');
    if (!skipBalanceCheck) await this.assertSufficientFunds(accountId, normalized);
    const transfer = await client.createWire({ amount: normalized, accountId, counterpartyId, memo, purpose, instructions, userdata });
    return this.recordTransfer('wire', transfer, { initiatedBy, memo });
  }

  /** Re-poll a transfer and persist the new status (no webhooks required). */
  static async refreshTransfer(kind, id) {
    assertKind(kind);
    let transfer;
    if (kind === 'book') transfer = await client.getBookTransfer(id);
    else if (kind === 'ach') transfer = await client.getAch(id);
    else transfer = await client.getWire(id);
    return this.recordTransfer(kind, transfer);
  }

  static async listTransfers({ kind, status, limit = 50, offset = 0 } = {}) {
    if (kind) assertKind(kind);
    await this.ensureTables();
    const clauses = [];
    const params = [];
    if (kind) { params.push(kind); clauses.push(`kind = $${params.length}`); }
    if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(Math.min(parseInt(limit, 10) || 50, 500));
    params.push(parseInt(offset, 10) || 0);
    const res = await query(
      `SELECT * FROM treasury_prime_transfers ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return res.rows;
  }

  /** Poll every transfer still in flight and persist any status change. */
  static async refreshPendingTransfers({ limit = 100 } = {}) {
    await this.ensureTables();
    const res = await query(
      `SELECT id, kind, status FROM treasury_prime_transfers
       WHERE status IS NULL OR status NOT IN ('sent','settled','posted','error','canceled','returned')
       ORDER BY created_at DESC LIMIT $1`,
      [Math.min(parseInt(limit, 10) || 100, 500)],
    );
    const results = [];
    for (const row of res.rows) {
      try {
        const updated = await this.refreshTransfer(row.kind, row.id);
        results.push({ id: row.id, kind: row.kind, previousStatus: row.status, status: updated.status, changed: row.status !== updated.status });
      } catch (err) {
        results.push({ id: row.id, kind: row.kind, previousStatus: row.status, error: err.message });
      }
    }
    return { checked: res.rows.length, results };
  }

  // ─── Webhooks ─────────────────────────────────────────────────────────────
  static async listWebhooks() {
    return client.listWebhooks();
  }

  static async createWebhook(input) {
    return client.createWebhook(input);
  }

  static async deleteWebhook(id) {
    return client.deleteWebhook(id);
  }

  /**
   * Ingest a Treasury Prime webhook. The event payload carries the changed
   * object, so the status is persisted from the event and the object is then
   * re-fetched to confirm — a webhook alone is never treated as settlement.
   */
  static async handleWebhook(payload = {}) {
    const eventType = payload.event_type || payload.type || null;
    const object = payload.data || payload.object || payload[eventType] || {};
    const objectId = object.id || payload.object_id || null;
    let objectKind = null;
    if (typeof objectId === 'string') {
      if (objectId.startsWith('ach_')) objectKind = 'ach';
      else if (objectId.startsWith('wire_')) objectKind = 'wire';
      else if (objectId.startsWith('book_')) objectKind = 'book';
    }
    const eventId = payload.id || payload.event_id || `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (pool) {
      await this.ensureTables();
      await query(`
        INSERT INTO treasury_prime_webhook_events (id, event_type, object_id, object_kind, status, raw, received_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,NOW())
        ON CONFLICT (id) DO NOTHING
      `, [eventId, eventType, objectId, objectKind, object.status || null, safeJson(payload)]).catch(() => {});
    }

    let refreshed = null;
    let refreshError = null;
    if (objectKind && objectId) {
      try {
        refreshed = await this.refreshTransfer(objectKind, objectId);
      } catch (err) {
        refreshError = err.message;
      }
    }
    return { eventId, eventType, objectId, objectKind, refreshed, refreshError };
  }

  // ─── GL reconciliation ────────────────────────────────────────────────────
  /**
   * Compare the live Treasury Prime balance against the last reconciled
   * balance and post the difference to the trust GL, mirroring the DataBridge
   * pattern. Amounts stay decimal strings; the GL engine takes the same
   * decimal precision.
   */
  static async reconcileAccount({ accountId, trustAccountCode = '1000', postJournal = true } = {}) {
    if (!accountId) throw new Error('accountId is required');
    await this.ensureTables();
    const account = await this.getAccount(accountId);
    const current = account.currentBalance || account.availableBalance || '0.00';

    const cached = pool
      ? (await query('SELECT last_reconciled_balance FROM treasury_prime_accounts WHERE id = $1', [accountId]).catch(() => ({ rows: [] }))).rows[0]
      : null;
    const previous = coerceAmount(cached && cached.last_reconciled_balance) || '0.00';
    const drift = subtractAmounts(current, previous);

    const result = {
      accountId,
      accountName: account.name,
      currentBalance: current,
      previousBalance: previous,
      drift,
      glAccountCode: `TP-${accountId}`,
      trustAccountCode,
      journalResult: null,
      journalError: null,
      watermarkError: null,
    };

    if (isZeroAmount(drift)) {
      result.journalResult = 'no-change';
      return result;
    }
    if (!postJournal) return result;

    let TrustAccountingEngine;
    try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { TrustAccountingEngine = null; }
    if (!TrustAccountingEngine) {
      result.journalError = 'TrustAccountingEngine unavailable';
      return result;
    }

    try {
      await TrustAccountingEngine.createAccount({
        accountCode: result.glAccountCode,
        accountName: account.name || `Treasury Prime ${accountId}`,
        accountType: 'asset',
      });
    } catch (e) { /* already exists */ }

    const magnitude = absAmount(drift);
    const increased = compareAmounts(drift, '0.00') > 0;
    try {
      result.journalResult = await TrustAccountingEngine.postJournalEntry({
        entryDate: new Date(),
        description: `Treasury Prime reconciliation ${account.name || accountId}`,
        referenceType: 'treasury_prime_reconciliation',
        referenceId: accountId,
        postedBy: 'TreasuryPrimeEngine',
        postToFineract: false,
        lines: [
          { accountCode: result.glAccountCode, debitAmount: increased ? magnitude : '0.00', creditAmount: increased ? '0.00' : magnitude, memo: `TP balance ${previous} → ${current}` },
          { accountCode: trustAccountCode, debitAmount: increased ? '0.00' : magnitude, creditAmount: increased ? magnitude : '0.00', memo: `TP drift ${drift}` },
        ],
      });
    } catch (err) {
      result.journalError = err.message;
      return result;
    }

    if (pool) {
      try {
        // Upsert, not UPDATE: reconciling an account that was never synced has
        // no row yet, and a no-op update would replay this drift on every run.
        await query(`
          INSERT INTO treasury_prime_accounts
            (id, name, account_type, available_balance, current_balance, last_reconciled_balance, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,NOW())
          ON CONFLICT (id) DO UPDATE SET last_reconciled_balance = $6, synced_at = NOW()
        `, [accountId, account.name, account.accountType, account.availableBalance, account.currentBalance, current]);
      } catch (err) {
        // The journal is already posted, so surface this loudly: until the
        // watermark advances the next run would double-post the same drift.
        result.watermarkError = err.message;
      }
    }
    return result;
  }

  // ─── Cached reads ─────────────────────────────────────────────────────────
  static async getCachedAccounts() {
    await this.ensureTables();
    const res = await query('SELECT * FROM treasury_prime_accounts ORDER BY account_type, name');
    return res.rows;
  }

  static async getCachedTransactions({ accountId, limit = 50, offset = 0 } = {}) {
    await this.ensureTables();
    const clauses = [];
    const params = [];
    if (accountId) { params.push(accountId); clauses.push(`account_id = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(Math.min(parseInt(limit, 10) || 50, 500));
    params.push(parseInt(offset, 10) || 0);
    const res = await query(
      `SELECT * FROM treasury_prime_transactions ${where}
       ORDER BY extended_timestamp DESC NULLS LAST, synced_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return res.rows;
  }

  static async getCachedWebhookEvents({ limit = 50 } = {}) {
    await this.ensureTables();
    const res = await query('SELECT * FROM treasury_prime_webhook_events ORDER BY received_at DESC LIMIT $1', [Math.min(parseInt(limit, 10) || 50, 500)]);
    return res.rows;
  }

  // ─── Reference data ───────────────────────────────────────────────────────
  static async lookupRoutingNumber(routingNumber) {
    if (!/^\d{9}$/.test(String(routingNumber || ''))) throw new Error('routingNumber must be 9 digits');
    return client.lookupRoutingNumber(routingNumber);
  }
}

module.exports = { TreasuryPrimeEngine };
