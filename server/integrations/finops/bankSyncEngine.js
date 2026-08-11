'use strict';

/**
 * BankSyncEngine
 *
 * Open-banking integration with BankSync (banksync.io).
 * Lists connected banks/accounts, fetches balances and transactions,
 * and can sync them into the trust's cash/trust accounting ledger.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const BASE_URL = (process.env.BANKSYNC_BASE_URL || 'https://api.banksync.io/v1').replace(/\/$/, '');
const API_KEY = process.env.BANKSYNC_API_KEY;

function id(prefix = 'BS') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }
function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }

async function query(text, params) {
  if (!pool) throw new Error('Postgres pool not available');
  return pool.query(text, params);
}

async function banksyncRequest(path, opts = {}) {
  if (!API_KEY) throw new Error('BANKSYNC_API_KEY not configured');
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY, ...(opts.headers || {}) },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json.message || json.error || `BankSync HTTP ${res.status}`);
  return json;
}

class BankSyncEngine {
  static async ensureTables() {
    if (!pool) return;
    await query(`
      CREATE TABLE IF NOT EXISTS banksync_banks (
        id TEXT PRIMARY KEY,
        name TEXT,
        provider TEXT,
        status TEXT,
        raw JSONB,
        synced_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS banksync_accounts (
        id TEXT PRIMARY KEY,
        bank_id TEXT,
        name TEXT,
        type TEXT,
        subtype TEXT,
        currency TEXT,
        balance_current NUMERIC,
        balance_available NUMERIC,
        last_synced_balance NUMERIC,
        raw JSONB,
        synced_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS banksync_transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        bank_id TEXT,
        amount NUMERIC,
        currency TEXT,
        description TEXT,
        date TEXT,
        pending BOOLEAN,
        category TEXT,
        raw JSONB,
        synced_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  static async getWorkspace() {
    return banksyncRequest('/whoami');
  }

  static async listBanks() {
    const data = await banksyncRequest('/banks');
    if (pool && Array.isArray(data?.banks || data?.data)) {
      const banks = data.banks || data.data;
      await this.ensureTables();
      for (const b of banks) {
        await query(`
          INSERT INTO banksync_banks (id, name, provider, status, raw, synced_at)
          VALUES ($1,$2,$3,$4,$5::jsonb,NOW())
          ON CONFLICT (id) DO UPDATE SET name=$2, provider=$3, status=$4, raw=$5::jsonb, synced_at=NOW()
        `, [b.id, b.name, b.provider, b.status, safeJson(b)]).catch(() => {});
      }
    }
    return data;
  }

  static async getBank(bid) {
    return banksyncRequest(`/banks/${encodeURIComponent(bid)}`);
  }

  static async listAccounts(bid) {
    const data = await banksyncRequest(`/banks/${encodeURIComponent(bid)}/accounts`);
    if (pool && Array.isArray(data?.accounts || data?.data)) {
      const accounts = data.accounts || data.data;
      await this.ensureTables();
      for (const a of accounts) {
        const balance = a.balance || a.balances || {};
        const currentBalance = balance.current ?? a.currentBalance ?? null;
        const availableBalance = balance.available ?? a.availableBalance ?? null;
        await query(`
          INSERT INTO banksync_accounts (id, bank_id, name, type, subtype, currency, balance_current, balance_available, raw, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,NOW())
          ON CONFLICT (id) DO UPDATE SET name=$3, type=$4, subtype=$5, currency=$6, balance_current=$7, balance_available=$8, raw=$9::jsonb, synced_at=NOW()
        `, [a.id, bid, a.name, a.type, a.subtype, a.currency, currentBalance, availableBalance, safeJson(a)]).catch(() => {});
      }
    }
    return data;
  }

  static async getAccountBalance(bid, aid) {
    const path = bid
      ? `/banks/${encodeURIComponent(bid)}/accounts/${encodeURIComponent(aid)}/balances`
      : `/accounts/${encodeURIComponent(aid)}/balances`;
    return banksyncRequest(path);
  }

  static async listTransactions(bid, aid, { from, to, cursor, limit = 50 } = {}) {
    let path = bid
      ? `/banks/${encodeURIComponent(bid)}/accounts/${encodeURIComponent(aid)}/transactions`
      : `/accounts/${encodeURIComponent(aid)}/transactions`;
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    if (cursor) qs.set('cursor', cursor);
    if (limit) qs.set('limit', String(limit));
    if (qs.toString()) path += `?${qs.toString()}`;
    const data = await banksyncRequest(path);
    if (pool && Array.isArray(data?.transactions || data?.data)) {
      const txs = data.transactions || data.data;
      await this.ensureTables();
      for (const t of txs) {
        await query(`
          INSERT INTO banksync_transactions (id, account_id, bank_id, amount, currency, description, date, pending, category, raw, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,NOW())
          ON CONFLICT (id) DO UPDATE SET amount=$4, currency=$5, description=$6, date=$7, pending=$8, category=$9, raw=$10::jsonb, synced_at=NOW()
        `, [t.id, aid, bid || null, t.amount, t.currency, t.description, t.date, t.pending, t.category, safeJson(t)]).catch(() => {});
      }
    }
    return data;
  }

  static async syncToLedger({ bankId, accountId, trustAccountCode = '1000', cashAccountId = 'CA-OPERATING' } = {}) {
    await this.ensureTables();
    const balance = await this.getAccountBalance(bankId, accountId);
    const current = Number(balance?.current ?? balance?.balance?.current ?? 0);
    let CashEngine, TrustAccountingEngine;
    try { ({ CashEngine } = require('../cash/cashEngine')); } catch (e) { CashEngine = null; }
    try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { TrustAccountingEngine = null; }
    const account = (await query('SELECT * FROM banksync_accounts WHERE id=$1', [accountId]).catch(() => ({ rows: [] }))).rows[0];
    const memo = `BankSync sync ${account?.name || accountId}`;
    const previousBalance = Number(account?.last_synced_balance ?? 0);
    const diff = Math.round((current - previousBalance) * 100) / 100;

    const result = { accountId, current, previousBalance, diff, balance, memo, cashResult: null, cashError: null, journalResult: null, journalError: null };

    if (CashEngine) {
      try { await CashEngine.createAccount({ accountId: `BS-${accountId}`, accountName: account?.name || `BankSync ${accountId}`, accountType: 'asset' }); } catch (e) {}
      try {
        const acct = await CashEngine.getAccount(`BS-${accountId}`);
        if (acct) {
          const cashDiff = Math.round((current * 100) - (acct.balance_cents || 0));
          if (cashDiff !== 0) {
            result.cashResult = await CashEngine.transfer({ fromAccountId: cashDiff > 0 ? cashAccountId : `BS-${accountId}`, toAccountId: cashDiff > 0 ? `BS-${accountId}` : cashAccountId, amountCents: Math.abs(cashDiff), movementType: 'sync' });
          } else {
            result.cashResult = 'no-change';
          }
        }
      } catch (e) { result.cashError = e.message; }
    }

    if (TrustAccountingEngine) {
      try { await TrustAccountingEngine.createAccount({ accountCode: `BS-${accountId}`, accountName: account?.name || `BankSync ${accountId}`, accountType: 'asset' }); } catch (e) {}
      if (diff !== 0) {
        try {
          const bsDebit = diff > 0 ? diff : 0;
          const bsCredit = diff < 0 ? -diff : 0;
          const trustDebit = diff < 0 ? -diff : 0;
          const trustCredit = diff > 0 ? diff : 0;
          result.journalResult = await TrustAccountingEngine.postJournalEntry({
            entryDate: new Date(),
            description: memo,
            referenceType: 'banksync_sync',
            referenceId: accountId,
            postedBy: 'BankSyncEngine',
            lines: [
              { accountCode: `BS-${accountId}`, debitAmount: bsDebit, creditAmount: bsCredit },
              { accountCode: trustAccountCode, debitAmount: trustDebit, creditAmount: trustCredit },
            ],
          });
          await query('UPDATE banksync_accounts SET last_synced_balance = $1, synced_at = NOW() WHERE id = $2', [current, accountId]).catch(() => {});
        } catch (e) { result.journalError = e.message; }
      } else {
        result.journalResult = 'no-change';
      }
    }

    return result;
  }

  static async getCachedBanks() {
    await this.ensureTables();
    const res = await query('SELECT * FROM banksync_banks ORDER BY synced_at DESC');
    return res.rows;
  }

  static async getCachedAccounts({ bankId } = {}) {
    await this.ensureTables();
    const where = bankId ? 'WHERE bank_id = $1' : '';
    const params = bankId ? [bankId] : [];
    const res = await query(`SELECT * FROM banksync_accounts ${where} ORDER BY synced_at DESC`, params);
    return res.rows;
  }

  static async getCachedTransactions({ accountId, limit = 50, offset = 0 } = {}) {
    await this.ensureTables();
    const res = await query('SELECT * FROM banksync_transactions WHERE account_id = $1 ORDER BY date DESC, synced_at DESC LIMIT $2 OFFSET $3', [accountId, limit, offset]);
    return res.rows;
  }
}

module.exports = { BankSyncEngine };
