'use strict';

/**
 * Stablecoin Treasury Management Engine
 *
 * Tracks hot-wallet balances, reserves, and on-chain settlement liquidity.
 * Falls back to an in-memory ledger when PostgreSQL is unavailable.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

const DEFAULT_ACCOUNT = 'TREASURY_HOT';
const memoryAccounts = new Map();
const memoryReserves = new Map();

async function query(sql, params) {
  if (!pool || !pool.query) throw new Error('Postgres pool unavailable');
  return pool.query(sql, params);
}

async function withFallback(fn, fallback) {
  try { return await fn(); } catch (e) { if (!pool) return fallback(e); throw e; }
}

async function withClient(fn) {
  if (!pool || !pool.connect) throw new Error('Postgres pool unavailable');
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

class TreasuryEngine {
  static async ensureTables() {
    if (!pool) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS stablecoin_treasury_accounts (
          account_id TEXT PRIMARY KEY,
          type TEXT NOT NULL DEFAULT 'hot',
          network TEXT NOT NULL DEFAULT 'testnet',
          asset_code TEXT NOT NULL DEFAULT 'USDC',
          public_address TEXT,
          balance_cents BIGINT NOT NULL DEFAULT 0,
          hold_cents BIGINT NOT NULL DEFAULT 0,
          available_cents BIGINT NOT NULL DEFAULT 0,
          metadata JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS stablecoin_reserves (
          reserve_id TEXT PRIMARY KEY,
          payment_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','posted','released')),
          tx_hash TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          released_at TIMESTAMPTZ
        );
      `);
      await query(`
        INSERT INTO stablecoin_treasury_accounts
          (account_id, type, network, asset_code, balance_cents, available_cents)
        VALUES ($1, 'hot', COALESCE(NULLIF(current_setting('stablecoin.network', true), ''), 'testnet'), 'USDC', 0, 0)
        ON CONFLICT (account_id) DO NOTHING;
      `, [DEFAULT_ACCOUNT]);
    } catch (e) {
      console.warn('[treasuryEngine] Postgres table ensure failed:', e.message);
    }
  }

  static async getOrCreateAccount(id, { type = 'hot', network = 'testnet', assetCode = 'USDC', publicAddress = '' } = {}) {
    if (memoryAccounts.has(id)) return memoryAccounts.get(id);
    if (!pool) {
      const account = { account_id: id, type, network, asset_code: assetCode, public_address: publicAddress, balance_cents: 0n, hold_cents: 0n, available_cents: 0n, metadata: {} };
      memoryAccounts.set(id, account);
      return account;
    }
    const rows = await query('SELECT * FROM stablecoin_treasury_accounts WHERE account_id = $1', [id]);
    if (rows.rows.length) return rows.rows[0];
    await query(`
      INSERT INTO stablecoin_treasury_accounts (account_id, type, network, asset_code, public_address, balance_cents, available_cents)
      VALUES ($1, $2, $3, $4, $5, 0, 0)
    `, [id, type, network, assetCode, publicAddress]);
    const inserted = await query('SELECT * FROM stablecoin_treasury_accounts WHERE account_id = $1', [id]);
    return inserted.rows[0];
  }

  static async getPosition(accountId = DEFAULT_ACCOUNT) {
    return withFallback(async () => {
      const rows = await query('SELECT * FROM stablecoin_treasury_accounts WHERE account_id = $1', [accountId]);
      if (!rows.rows.length) throw new Error(`Treasury account not found: ${accountId}`);
      const a = rows.rows[0];
      return {
        accountId: a.account_id,
        type: a.type,
        network: a.network,
        assetCode: a.asset_code,
        publicAddress: a.public_address,
        balanceCents: Number(a.balance_cents),
        holdCents: Number(a.hold_cents),
        availableCents: Number(a.available_cents),
      };
    }, async () => {
      const a = await TreasuryEngine.getOrCreateAccount(accountId);
      return {
        accountId: a.account_id,
        type: a.type,
        network: a.network,
        assetCode: a.asset_code,
        publicAddress: a.public_address,
        balanceCents: Number(a.balance_cents),
        holdCents: Number(a.hold_cents),
        availableCents: Number(a.available_cents),
      };
    });
  }

  static async credit(accountId, amountCents, { source = 'on_ramp', txHash = null, metadata = {} } = {}) {
    if (amountCents <= 0) throw new Error('credit amount must be positive');
    return withFallback(async () => {
      await query(`
        UPDATE stablecoin_treasury_accounts
        SET balance_cents = balance_cents + $2,
            available_cents = available_cents + $2,
            metadata = jsonb_set(metadata, '{credits}', COALESCE(metadata->'credits','[]'::jsonb) || $3::jsonb),
            updated_at = NOW()
        WHERE account_id = $1
      `, [accountId, amountCents, JSON.stringify([{ amount: amountCents, source, txHash, at: new Date().toISOString(), ...metadata }])]);
      return TreasuryEngine.getPosition(accountId);
    }, async () => {
      const a = await TreasuryEngine.getOrCreateAccount(accountId);
      a.balance_cents = BigInt(a.balance_cents) + BigInt(amountCents);
      a.available_cents = BigInt(a.available_cents) + BigInt(amountCents);
      return TreasuryEngine.getPosition(accountId);
    });
  }

  static async debit(accountId, amountCents, { reason = '', source = '' } = {}) {
    if (amountCents <= 0) throw new Error('debit amount must be positive');
    return withFallback(async () => {
      return withClient(async (client) => {
        await client.query('BEGIN');
        try {
          const pos = await client.query('SELECT * FROM stablecoin_treasury_accounts WHERE account_id = $1 FOR UPDATE', [accountId]);
          if (!pos.rows.length) throw new Error(`Treasury account not found: ${accountId}`);
          const a = pos.rows[0];
          const available = Number(a.available_cents);
          if (available < amountCents) throw new Error(`Insufficient treasury available balance: ${available} < ${amountCents}`);
          await client.query(`
            UPDATE stablecoin_treasury_accounts
            SET balance_cents = balance_cents - $2,
                available_cents = available_cents - $2,
                metadata = jsonb_set(metadata, '{debits}', COALESCE(metadata->'debits','[]'::jsonb) || $3::jsonb),
                updated_at = NOW()
            WHERE account_id = $1
          `, [accountId, amountCents, JSON.stringify([{ amount: amountCents, reason, source, at: new Date().toISOString() }])]);
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        }
        return TreasuryEngine.getPosition(accountId);
      });
    }, async () => {
      const a = await TreasuryEngine.getOrCreateAccount(accountId);
      const available = BigInt(a.available_cents);
      if (available < BigInt(amountCents)) throw new Error('Insufficient treasury available balance');
      a.balance_cents = BigInt(a.balance_cents) - BigInt(amountCents);
      a.available_cents = available - BigInt(amountCents);
      return TreasuryEngine.getPosition(accountId);
    });
  }

  static async hold(paymentId, accountId, amountCents) {
    if (amountCents <= 0) throw new Error('hold amount must be positive');
    const reserveId = `RES-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return withFallback(async () => {
      return withClient(async (client) => {
        await client.query('BEGIN');
        try {
          const pos = await client.query('SELECT * FROM stablecoin_treasury_accounts WHERE account_id = $1 FOR UPDATE', [accountId]);
          if (!pos.rows.length) throw new Error(`Treasury account not found: ${accountId}`);
          const a = pos.rows[0];
          const available = Number(a.available_cents);
          if (available < amountCents) throw new Error(`Insufficient treasury available balance: ${available} < ${amountCents}`);
          await client.query(`
            UPDATE stablecoin_treasury_accounts
            SET hold_cents = hold_cents + $2,
                available_cents = available_cents - $2,
                updated_at = NOW()
            WHERE account_id = $1
          `, [accountId, amountCents]);
          await client.query(`
            INSERT INTO stablecoin_reserves (reserve_id, payment_id, account_id, amount_cents, status)
            VALUES ($1, $2, $3, $4, 'active')
          `, [reserveId, paymentId, accountId, amountCents]);
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        }
        return { reserveId, accountId, amountCents, status: 'active' };
      });
    }, async () => {
      const a = await TreasuryEngine.getOrCreateAccount(accountId);
      const available = BigInt(a.available_cents);
      if (available < BigInt(amountCents)) throw new Error(`Insufficient treasury available balance`);
      a.hold_cents = BigInt(a.hold_cents) + BigInt(amountCents);
      a.available_cents = available - BigInt(amountCents);
      memoryReserves.set(reserveId, { reserve_id: reserveId, payment_id: paymentId, account_id: accountId, amount_cents: amountCents, status: 'active' });
      return { reserveId, accountId, amountCents, status: 'active' };
    });
  }

  static async release(reserveId, reason = '') {
    return withFallback(async () => {
      return withClient(async (client) => {
        const rows = await client.query('SELECT * FROM stablecoin_reserves WHERE reserve_id = $1 AND status = $2 FOR UPDATE', [reserveId, 'active']);
        if (!rows.rows.length) return { released: false, reason: 'reserve not found or not active' };
        const r = rows.rows[0];
        await client.query('BEGIN');
        try {
          await client.query(`
            UPDATE stablecoin_treasury_accounts
            SET hold_cents = hold_cents - $2,
                available_cents = available_cents + $2,
                updated_at = NOW()
            WHERE account_id = $1
          `, [r.account_id, r.amount_cents]);
          await client.query(`
            UPDATE stablecoin_reserves
            SET status = 'released', released_at = NOW()
            WHERE reserve_id = $1
          `, [reserveId]);
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        }
        return { released: true, reserveId };
      });
    }, async () => {
      const r = memoryReserves.get(reserveId);
      if (!r || r.status !== 'active') return { released: false, reason: 'reserve not found or not active' };
      const a = await TreasuryEngine.getOrCreateAccount(r.account_id);
      a.hold_cents = BigInt(a.hold_cents) - BigInt(r.amount_cents);
      a.available_cents = BigInt(a.available_cents) + BigInt(r.amount_cents);
      r.status = 'released';
      return { released: true, reserveId };
    });
  }

  /**
   * Finalize a reserve after settlement. By default the full reserve amount is
   * debited from the balance. If `settledAmountCents` is provided, only that
   * amount is debited; the remainder (the gateway fee) is released back to
   * available funds.
   */
  static async post(reserveId, txHash, { settledAmountCents } = {}) {
    return withFallback(async () => {
      return withClient(async (client) => {
        const rows = await client.query('SELECT * FROM stablecoin_reserves WHERE reserve_id = $1 FOR UPDATE', [reserveId]);
        if (!rows.rows.length) throw new Error(`Reserve not found: ${reserveId}`);
        const r = rows.rows[0];
        if (r.status !== 'active') throw new Error(`Reserve is not active: ${r.status}`);
        const settled = Number(settledAmountCents) || Number(r.amount_cents);
        if (settled <= 0 || settled > Number(r.amount_cents)) throw new Error('settledAmountCents must be positive and not exceed the reserve');
        const fee = Number(r.amount_cents) - settled;
        await client.query('BEGIN');
        try {
          await client.query(`
            UPDATE stablecoin_treasury_accounts
            SET hold_cents = hold_cents - $2,
                balance_cents = balance_cents - $3,
                available_cents = available_cents + $4,
                updated_at = NOW()
            WHERE account_id = $1
          `, [r.account_id, r.amount_cents, settled, fee]);
          await client.query(`
            UPDATE stablecoin_reserves
            SET status = 'posted', tx_hash = $2
            WHERE reserve_id = $1
          `, [reserveId, txHash]);
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        }
        return { posted: true, reserveId, txHash, settled, fee };
      });
    }, async () => {
      const r = memoryReserves.get(reserveId);
      if (!r || r.status !== 'active') throw new Error('Reserve not active');
      const a = await TreasuryEngine.getOrCreateAccount(r.account_id);
      const settled = Number(settledAmountCents) || Number(r.amount_cents);
      const fee = Number(r.amount_cents) - settled;
      a.hold_cents = BigInt(a.hold_cents) - BigInt(r.amount_cents);
      a.balance_cents = BigInt(a.balance_cents) - BigInt(settled);
      a.available_cents = BigInt(a.available_cents) + BigInt(fee);
      r.status = 'posted';
      r.tx_hash = txHash;
      return { posted: true, reserveId, txHash, settled, fee };
    });
  }
}

module.exports = { TreasuryEngine, DEFAULT_ACCOUNT };
