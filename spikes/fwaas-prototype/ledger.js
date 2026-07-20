'use strict';

/**
 * Double-entry ledger for the fiat-wallet-as-a-service spike.
 *
 * Backed by TigerBeetle when TB_ADDRESS is reachable; otherwise falls back to
 * an in-memory double-entry ledger with identical semantics so the demo runs
 * anywhere. The TigerBeetle adapter is the real target — the fallback exists
 * only to keep the spike self-contained.
 *
 * Model (all amounts are integer USD cents; ledger 840 = ISO-4217 USD):
 *   - Two-phase transfers mirror maker/checker: a settlement instruction is
 *     booked as a `pending` transfer (a hold), then `post`ed once the external
 *     rail (Stellar) confirms, or `void`ed if it fails. Funds are never double
 *     spent and the hold is atomic.
 */

const USD_LEDGER = 840;

// Deterministic account codes for readability in the demo.
const CODE = { TRUST_OPERATING: 1000, BENEFICIARY: 2000, CRYPTO_CLEARING: 3000 };

function nowNs() {
  return process.hrtime.bigint();
}

// ─── In-memory fallback ──────────────────────────────────────────────────────
class MemoryLedger {
  constructor() {
    this.accounts = new Map();
    this.transfers = new Map();
    this.backend = 'in-memory';
  }
  async connect() {}
  async close() {}

  async createAccount(id, code) {
    this.accounts.set(id, {
      id, code, ledger: USD_LEDGER,
      debits_pending: 0n, debits_posted: 0n,
      credits_pending: 0n, credits_posted: 0n,
    });
  }

  async _pending(id, debitId, creditId, amount) {
    const d = this.accounts.get(debitId);
    const c = this.accounts.get(creditId);
    d.debits_pending += amount;
    c.credits_pending += amount;
    this.transfers.set(id, { id, debitId, creditId, amount, state: 'pending' });
  }

  async _post(id, pendingId, _amount) {
    const p = this.transfers.get(pendingId);
    if (!p || p.state !== 'pending') throw new Error('pending transfer not found');
    const d = this.accounts.get(p.debitId);
    const c = this.accounts.get(p.creditId);
    d.debits_pending -= p.amount; d.debits_posted += p.amount;
    c.credits_pending -= p.amount; c.credits_posted += p.amount;
    p.state = 'posted';
    this.transfers.set(id, { id, ...p, state: 'posted' });
  }

  async _void(id, pendingId) {
    const p = this.transfers.get(pendingId);
    if (!p || p.state !== 'pending') throw new Error('pending transfer not found');
    const d = this.accounts.get(p.debitId);
    const c = this.accounts.get(p.creditId);
    d.debits_pending -= p.amount;
    c.credits_pending -= p.amount;
    p.state = 'voided';
  }

  async balance(id) {
    const a = this.accounts.get(id);
    return {
      debits_pending: a.debits_pending, debits_posted: a.debits_posted,
      credits_pending: a.credits_pending, credits_posted: a.credits_posted,
    };
  }
}

// ─── TigerBeetle adapter ─────────────────────────────────────────────────────
class TigerBeetleLedger {
  constructor(tb, address) {
    this.tb = tb; // required module
    this.address = address;
    this.backend = 'tigerbeetle@' + address;
  }
  async connect() {
    this.client = this.tb.createClient({
      cluster_id: BigInt(process.env.TB_CLUSTER || '0'),
      replica_addresses: [this.address],
    });
  }
  async close() { if (this.client) this.client.destroy(); }

  _emptyAccount(id, code) {
    return {
      id, debits_pending: 0n, debits_posted: 0n,
      credits_pending: 0n, credits_posted: 0n,
      user_data_128: 0n, user_data_64: 0n, user_data_32: 0,
      reserved: 0, ledger: USD_LEDGER, code, flags: 0, timestamp: 0n,
    };
  }
  async createAccount(id, code) {
    const { CreateAccountStatus } = this.tb;
    const results = await this.client.createAccounts([this._emptyAccount(id, code)]);
    // `created` and `exists` are both acceptable so the demo is re-runnable.
    const bad = results.filter(r =>
      r.status !== CreateAccountStatus.created && r.status !== CreateAccountStatus.exists);
    if (bad.length) throw new Error('createAccounts: ' + JSON.stringify(bad.map(r => CreateAccountStatus[r.status])));
  }

  _baseTransfer(id, code) {
    return {
      id, debit_account_id: 0n, credit_account_id: 0n, amount: 0n,
      pending_id: 0n, user_data_128: 0n, user_data_64: 0n, user_data_32: 0,
      timeout: 0, ledger: USD_LEDGER, code, flags: 0, timestamp: 0n,
    };
  }
  async _submitTransfer(t, label) {
    const { CreateTransferStatus } = this.tb;
    const results = await this.client.createTransfers([t]);
    const bad = results.filter(r => r.status !== CreateTransferStatus.created);
    if (bad.length) throw new Error(`${label}: ` + JSON.stringify(bad.map(r => CreateTransferStatus[r.status])));
  }
  async _pending(id, debitId, creditId, amount) {
    const t = this._baseTransfer(id, 10);
    t.debit_account_id = debitId; t.credit_account_id = creditId; t.amount = amount;
    t.flags = this.tb.TransferFlags.pending;
    await this._submitTransfer(t, 'pending');
  }
  async _post(id, pendingId, amount) {
    const t = this._baseTransfer(id, 10);
    t.pending_id = pendingId;
    // In TigerBeetle 0.17, amount=0 posts zero; pass the explicit pending amount.
    t.amount = BigInt(amount);
    t.flags = this.tb.TransferFlags.post_pending_transfer;
    await this._submitTransfer(t, 'post');
  }
  async _void(id, pendingId) {
    const t = this._baseTransfer(id, 10);
    t.pending_id = pendingId;
    t.flags = this.tb.TransferFlags.void_pending_transfer;
    await this._submitTransfer(t, 'void');
  }
  async balance(id) {
    const [a] = await this.client.lookupAccounts([id]);
    if (!a) throw new Error('account not found: ' + id);
    return {
      debits_pending: a.debits_pending, debits_posted: a.debits_posted,
      credits_pending: a.credits_pending, credits_posted: a.credits_posted,
    };
  }
}

/**
 * Build a ledger, preferring TigerBeetle at TB_ADDRESS, falling back to memory.
 */
async function makeLedger() {
  const address = process.env.TB_ADDRESS;
  if (address) {
    try {
      const tb = require('tigerbeetle-node');
      const l = new TigerBeetleLedger(tb, address);
      await l.connect();
      // probe: a lookup of a random id should not throw on a live cluster
      await l.client.lookupAccounts([1n]);
      return l;
    } catch (err) {
      console.warn(`[ledger] TigerBeetle at ${address} unavailable (${err.message}); using in-memory fallback.`);
    }
  }
  const l = new MemoryLedger();
  await l.connect();
  return l;
}

module.exports = { makeLedger, MemoryLedger, TigerBeetleLedger, CODE, USD_LEDGER, nowNs };
