'use strict';

/**
 * Expense & Asset/Liability Management Engine
 *
 * Tracks hard assets and liabilities by VIN, serial number, deed, account
 * number, etc., plus expenses tied to those assets/liabilities. Integrates
 * with Asset-Debt Proof Engine and Distribution Request Engine so an expense
 * can be paid in one click.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

let MessagingEngine;
try { MessagingEngine = require('../messaging/messagingEngine').MessagingEngine; } catch (e) { MessagingEngine = null; }

let CalendarEngine;
try { CalendarEngine = require('../calendar/calendarEngine').CalendarEngine; } catch (e) { CalendarEngine = null; }

function id(prefix = 'EXP') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

async function query(sql, params) {
  if (!pool || !pool.query) throw new Error('Postgres pool unavailable');
  return pool.query(sql, params);
}

async function withFallback(fn, fallback) {
  try { return await fn(); } catch (e) { if (!pool) return fallback(e); throw e; }
}

function jsonbValue(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') return JSON.parse(raw || '{}');
  return raw;
}

class ExpenseManagementEngine {

  static async ensureTables() {
    await withFallback(async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS asset_liability_records (
          id                TEXT PRIMARY KEY,
          type              TEXT NOT NULL CHECK (type IN ('asset','liability')),
          category          TEXT NOT NULL,
          name              TEXT NOT NULL,
          identifier        TEXT,
          description       TEXT,
          amount_cents      BIGINT NOT NULL DEFAULT 0,
          currency          TEXT NOT NULL DEFAULT 'USD',
          owner             TEXT,
          linked_source_type TEXT,
          linked_source_account_id TEXT,
          documents         JSONB DEFAULT '[]',
          status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','sold','paid','closed')),
          metadata          JSONB DEFAULT '{}',
          created_by        TEXT,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_alr_type ON asset_liability_records(type)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_alr_category ON asset_liability_records(category)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_alr_identifier ON asset_liability_records(identifier)`);

      await query(`
        CREATE TABLE IF NOT EXISTS expense_records (
          id                TEXT PRIMARY KEY,
          expense_type      TEXT NOT NULL,
          amount_cents      BIGINT NOT NULL DEFAULT 0,
          currency          TEXT NOT NULL DEFAULT 'USD',
          payee             TEXT,
          payer             TEXT,
          asset_liability_id TEXT REFERENCES asset_liability_records(id) ON DELETE SET NULL,
          description       TEXT,
          status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','payment_pending','payment_failed','paid')),
          proof_id          TEXT,
          request_id        TEXT,
          payout_id         TEXT,
          receipt_url       TEXT,
          documents         JSONB DEFAULT '[]',
          metadata          JSONB DEFAULT '{}',
          created_by        TEXT,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_exp_status ON expense_records(status)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_exp_al ON expense_records(asset_liability_id)`);
      await query(`ALTER TABLE expense_records DROP CONSTRAINT IF EXISTS expense_records_status_check`);
      await query(`ALTER TABLE expense_records ADD CONSTRAINT expense_records_status_check CHECK (status IN ('pending','approved','rejected','payment_pending','payment_failed','paid'))`);
    }, () => {});
  }

  static async _mem(op, ...args) {
    if (!ExpenseManagementEngine._memory) ExpenseManagementEngine._memory = { assets: new Map(), expenses: new Map() };
    if (op === 'assets.set') { ExpenseManagementEngine._memory.assets.set(args[0], args[1]); return args[1]; }
    if (op === 'assets.get') return ExpenseManagementEngine._memory.assets.get(args[0]) || null;
    if (op === 'assets.list') return Array.from(ExpenseManagementEngine._memory.assets.values());
    if (op === 'assets.del') { ExpenseManagementEngine._memory.assets.delete(args[0]); return { deleted: true }; }
    if (op === 'expenses.set') { ExpenseManagementEngine._memory.expenses.set(args[0], args[1]); return args[1]; }
    if (op === 'expenses.get') return ExpenseManagementEngine._memory.expenses.get(args[0]) || null;
    if (op === 'expenses.list') return Array.from(ExpenseManagementEngine._memory.expenses.values());
    if (op === 'expenses.del') { ExpenseManagementEngine._memory.expenses.delete(args[0]); return { deleted: true }; }
    return null;
  }

  static _jsonCols(table) {
    return table === 'asset_liability_records' ? ['documents', 'metadata'] : ['documents', 'metadata'];
  }

  static async _insert(table, row) {
    return withFallback(async () => {
      const keys = Object.keys(row).filter(k => row[k] !== undefined);
      const cols = keys.join(',');
      const vals = keys.map((_, i) => `$${i + 1}`).join(',');
      const result = await query(`INSERT INTO ${table} (${cols}) VALUES (${vals}) RETURNING *`, keys.map(k => {
        if (['documents', 'metadata'].includes(k)) return JSON.stringify(row[k]);
        return row[k];
      }));
      return result.rows[0];
    }, async () => {
      const op = table === 'asset_liability_records' ? 'assets.set' : 'expenses.set';
      return this._mem(op, row.id, row);
    });
  }

  static async _update(table, id, updates) {
    return withFallback(async () => {
      const keys = Object.keys(updates).filter(k => updates[k] !== undefined);
      if (!keys.length) return this._get(table, id);
      const set = keys.map((k, i) => `${k} = $${i + 1}`).join(',');
      const values = keys.map(k => (['documents', 'metadata'].includes(k) ? JSON.stringify(updates[k]) : updates[k]));
      const result = await query(`UPDATE ${table} SET ${set}, updated_at = NOW() WHERE id = $${keys.length + 1} RETURNING *`, [...values, id]);
      return result.rows[0];
    }, async () => {
      const op = table === 'asset_liability_records' ? 'assets.get' : 'expenses.get';
      const row = await this._mem(op, id);
      if (!row) return null;
      Object.assign(row, updates);
      return this._mem(table === 'asset_liability_records' ? 'assets.set' : 'expenses.set', id, row);
    });
  }

  static async _get(table, id) {
    return withFallback(async () => {
      const result = await query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
      return result.rows[0] || null;
    }, async () => this._mem(table === 'asset_liability_records' ? 'assets.get' : 'expenses.get', id));
  }

  static _rowToObject(row, table) {
    if (!row) return null;
    const jsonCols = this._jsonCols(table);
    const obj = { ...row };
    for (const c of jsonCols) obj[c] = jsonbValue(row[c]) || [];
    return obj;
  }

  // ─── Asset / Liability Records ─────────────────────────────────────────────

  static async createRecord({
    type, category, name, identifier, description,
    amountUsd, currency = 'USD', owner,
    linkedSourceType, linkedSourceAccountId,
    documents = [], metadata = {}, createdBy,
  }) {
    await this.ensureTables();
    if (!type || !category || !name) throw new Error('type, category and name required');
    if (!['asset', 'liability'].includes(type)) throw new Error('type must be asset or liability');
    const amountCents = Math.round((Number(amountUsd) || 0) * 100);
    const row = {
      id: id(type === 'asset' ? 'AST' : 'LIA'),
      type,
      category,
      name,
      identifier: identifier || null,
      description: description || null,
      amount_cents: amountCents,
      currency,
      owner: owner || null,
      linked_source_type: linkedSourceType || null,
      linked_source_account_id: linkedSourceAccountId || null,
      documents,
      status: 'active',
      metadata,
      created_by: createdBy || null,
    };
    const inserted = await this._insert('asset_liability_records', row);
    return this._rowToObject(inserted, 'asset_liability_records');
  }

  static async listRecords({ type, category, status, limit = 100 } = {}) {
    await this.ensureTables();
    return withFallback(async () => {
      const conditions = [];
      const params = [];
      let idx = 1;
      if (type) { conditions.push(`type = $${idx++}`); params.push(type); }
      if (category) { conditions.push(`category = $${idx++}`); params.push(category); }
      if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
      const result = await query(`SELECT * FROM asset_liability_records ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`, [...params, limit, 0]);
      return result.rows.map(r => this._rowToObject(r, 'asset_liability_records'));
    }, async () => {
      let all = await this._mem('assets.list');
      if (type) all = all.filter(r => r.type === type);
      if (category) all = all.filter(r => r.category === category);
      if (status) all = all.filter(r => r.status === status);
      return all.slice(0, limit);
    });
  }

  static async getRecord(id) {
    await this.ensureTables();
    return this._rowToObject(await this._get('asset_liability_records', id), 'asset_liability_records');
  }

  static async updateRecord(id, updates) {
    await this.ensureTables();
    if (updates.amountUsd !== undefined) updates.amount_cents = Math.round(Number(updates.amountUsd) * 100);
    delete updates.amountUsd;
    const allowed = ['category','name','identifier','description','amount_cents','currency','owner','linked_source_type','linked_source_account_id','documents','status','metadata'];
    const filtered = {};
    for (const k of allowed) if (updates[k] !== undefined) filtered[k] = updates[k];
    const updated = await this._update('asset_liability_records', id, filtered);
    return this._rowToObject(updated, 'asset_liability_records');
  }

  static async deleteRecord(id) {
    await this.ensureTables();
    return withFallback(async () => {
      await query('DELETE FROM asset_liability_records WHERE id = $1', [id]);
      return { deleted: true };
    }, async () => this._mem('assets.del', id));
  }

  // ─── Expense Records ───────────────────────────────────────────────────────

  static async createExpense({
    expenseType, amountUsd, currency = 'USD', payee, payer,
    assetLiabilityId, description, receiptUrl,
    documents = [], metadata = {}, createdBy,
  }) {
    await this.ensureTables();
    if (!expenseType || amountUsd == null) throw new Error('expenseType and amountUsd required');
    const amountCents = Math.round(Number(amountUsd) * 100);
    const row = {
      id: id('EXP'),
      expense_type: expenseType,
      amount_cents: amountCents,
      currency,
      payee: payee || null,
      payer: payer || null,
      asset_liability_id: assetLiabilityId || null,
      description: description || null,
      status: 'pending',
      receipt_url: receiptUrl || null,
      documents,
      metadata,
      created_by: createdBy || null,
    };
    const inserted = await this._insert('expense_records', row);
    return this._rowToObject(inserted, 'expense_records');
  }

  static async listExpenses({ status, assetLiabilityId, limit = 100 } = {}) {
    await this.ensureTables();
    return withFallback(async () => {
      const conditions = [];
      const params = [];
      let idx = 1;
      if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
      if (assetLiabilityId) { conditions.push(`asset_liability_id = $${idx++}`); params.push(assetLiabilityId); }
      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
      const result = await query(`SELECT * FROM expense_records ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`, [...params, limit, 0]);
      return result.rows.map(r => this._rowToObject(r, 'expense_records'));
    }, async () => {
      let all = await this._mem('expenses.list');
      if (status) all = all.filter(r => r.status === status);
      if (assetLiabilityId) all = all.filter(r => r.asset_liability_id === assetLiabilityId);
      return all.slice(0, limit);
    });
  }

  static async getExpense(id) {
    await this.ensureTables();
    return this._rowToObject(await this._get('expense_records', id), 'expense_records');
  }

  static async approveExpense(id, { approvedBy, signature }) {
    await this.ensureTables();
    const expense = await this.getExpense(id);
    const metadata = expense?.metadata || {};
    metadata.approvedBy = approvedBy;
    metadata.signature = signature;
    metadata.approvedAt = new Date().toISOString();
    const updated = await this._update('expense_records', id, { status: 'approved', metadata });
    return this._rowToObject(updated, 'expense_records');
  }

  static async rejectExpense(id, { reason }) {
    await this.ensureTables();
    const expense = await this.getExpense(id);
    if (!expense) throw new Error('Expense not found');
    const metadata = expense.metadata || {};
    metadata.rejection = { reason, at: new Date().toISOString() };
    const updated = await this._update('expense_records', id, { status: 'rejected', metadata });
    return this._rowToObject(updated, 'expense_records');
  }

  /**
   * Pay an approved expense by creating a distribution/disbursement request.
   */
  static async payExpense(id, {
    destinationAddress, safeId, sourceType = 'trust', sourceAccountId = '1000',
    proofId, createdBy, expenseAccountCode, accountingCreditAccountCode,
  }) {
    await this.ensureTables();
    let DistributionRequestEngine;
    try { DistributionRequestEngine = require('../dapp/distributionRequestEngine').DistributionRequestEngine; } catch (e) { DistributionRequestEngine = null; }
    if (!DistributionRequestEngine) throw new Error('DistributionRequestEngine not available');
    const expense = await this.getExpense(id);
    if (!expense) throw new Error('Expense not found');
    if (expense.status !== 'approved' && expense.status !== 'pending') throw new Error(`Expense status ${expense.status} cannot be paid`);
    if (!destinationAddress) throw new Error('destinationAddress required to pay expense');

    const amountUsd = (expense.amount_cents / 100).toFixed(2);
    const debitAccountCode = expenseAccountCode
      || expense.metadata?.expenseAccountCode
      || this.getExpenseAccountCode(expense.expense_type);
    const request = await DistributionRequestEngine.createRequest({
      type: 'disbursement',
      requesterRole: 'trustee',
      beneficiaryEmail: expense.payee || createdBy || 'expense@trust',
      beneficiaryName: expense.payee || 'Expense Payee',
      amountUsd,
      currency: expense.currency,
      destinationAddress,
      sourceType,
      sourceAccountId,
      safeId,
      proofId,
      memo: `Expense ${expense.id}: ${expense.description || expense.expense_type}`,
      createdBy,
      metadata: {
        expenseId: expense.id,
        expenseAccountCode: debitAccountCode,
        accountingCreditAccountCode: accountingCreditAccountCode || expense.metadata?.accountingCreditAccountCode || null,
      },
    });

    const updated = await this._update('expense_records', id, {
      status: 'payment_pending',
      request_id: request.id,
      metadata: {
        ...expense.metadata,
        request,
        expenseAccountCode: debitAccountCode,
        paymentStatus: request.status,
      },
    });
    return { expense: this._rowToObject(updated, 'expense_records'), request };
  }

  static getExpenseAccountCode(expenseType) {
    const type = String(expenseType || '').toLowerCase();
    if (type.includes('management')) return '5000';
    if (type.includes('trustee')) return '5100';
    if (type.includes('legal') || type.includes('professional')) return '5200';
    return '5300';
  }

  // ─── Totals / Dashboard ────────────────────────────────────────────────────

  static async getTotals() {
    await this.ensureTables();
    const records = await this.listRecords({ limit: 10000 });
    const expenses = await this.listExpenses({ limit: 10000 });
    const assets = records.filter(r => r.type === 'asset');
    const liabilities = records.filter(r => r.type === 'liability');
    return {
      totalAssetsCents: assets.reduce((s, r) => s + Number(r.amount_cents || 0), 0),
      totalLiabilitiesCents: liabilities.reduce((s, r) => s + Number(r.amount_cents || 0), 0),
      netWorthCents: assets.reduce((s, r) => s + Number(r.amount_cents || 0), 0) - liabilities.reduce((s, r) => s + Number(r.amount_cents || 0), 0),
      totalExpensesCents: expenses.reduce((s, e) => s + Number(e.amount_cents || 0), 0),
      byCategory: this._groupBy(records, 'category'),
      byExpenseType: this._groupByExpenses(expenses),
    };
  }

  static _groupBy(records, key) {
    return records.reduce((acc, r) => {
      const k = r[key] || 'unknown';
      if (!acc[k]) acc[k] = { count: 0, assets_cents: 0, liabilities_cents: 0 };
      acc[k].count++;
      if (r.type === 'asset') acc[k].assets_cents += Number(r.amount_cents || 0);
      if (r.type === 'liability') acc[k].liabilities_cents += Number(r.amount_cents || 0);
      return acc;
    }, {});
  }

  static _groupByExpenses(expenses) {
    return expenses.reduce((acc, e) => {
      const k = e.expense_type || 'other';
      if (!acc[k]) acc[k] = { count: 0, total_cents: 0 };
      acc[k].count++;
      acc[k].total_cents += Number(e.amount_cents || 0);
      return acc;
    }, {});
  }
}

module.exports = { ExpenseManagementEngine };
