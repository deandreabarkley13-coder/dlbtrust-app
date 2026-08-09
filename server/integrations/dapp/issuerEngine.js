'use strict';

/**
 * Issuer Engine — Trust as custodian/issuer of bank-backed ledger credits.
 *
 * Creates fiat-backed issuer assets (e.g. DLB-TRUST-USD) and manages issuance,
 * P2P transfer, and redemption against a cash reserve account.
 */

const pool = require('../bonds/pgPool');
let CashEngine;
try { ({ CashEngine } = require('../cash/cashEngine')); } catch (e) { CashEngine = null; }

function generateId(prefix = 'ISS') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

class IssuerEngine {
  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS issuer_assets (
        asset_code TEXT PRIMARY KEY,
        name TEXT,
        reserve_account_id TEXT NOT NULL,
        issued_cents BIGINT NOT NULL DEFAULT 0,
        redeemed_cents BIGINT NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','closed')),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS issuer_balances (
        id TEXT PRIMARY KEY,
        asset_code TEXT NOT NULL REFERENCES issuer_assets(asset_code),
        account_id TEXT NOT NULL,
        balance_cents BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(asset_code, account_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS issuer_operations (
        operation_id TEXT PRIMARY KEY,
        asset_code TEXT NOT NULL REFERENCES issuer_assets(asset_code),
        operation_type TEXT NOT NULL CHECK (operation_type IN ('issue','redeem','transfer','adjust')),
        from_account_id TEXT,
        to_account_id TEXT,
        amount_cents BIGINT NOT NULL,
        cash_movement_id TEXT,
        memo TEXT,
        status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending','completed','failed','reversed')),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  static async createAsset({ assetCode, name, reserveAccountId, initialReserveCents = 0 } = {}) {
    if (!assetCode) throw new Error('assetCode required');
    if (!CashEngine) throw new Error('CashEngine not available');
    await this.ensureTables();

    const reserveId = reserveAccountId || `ISS-RESERVE-${assetCode}`;
    if (!reserveAccountId) {
      const existing = await CashEngine.getAccount(reserveId);
      if (!existing) {
        await CashEngine.createAccount({
          accountId: reserveId,
          accountName: `${assetCode} Issuer Reserve`,
          accountType: 'escrow',
          notes: `Reserve backing ${assetCode}`,
        });
      }
    }

    const result = await pool.query(
      `INSERT INTO issuer_assets (asset_code, name, reserve_account_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (asset_code) DO UPDATE SET name = EXCLUDED.name, reserve_account_id = EXCLUDED.reserve_account_id, updated_at = NOW()
       RETURNING *`,
      [assetCode, name || assetCode, reserveId]
    );

    if (initialReserveCents > 0) {
      // If caller wants to seed reserve, they should move cash separately; just record issue.
    }

    return result.rows[0];
  }

  static async getAsset(assetCode) {
    const result = await pool.query('SELECT * FROM issuer_assets WHERE asset_code = $1', [assetCode]);
    return result.rows[0] || null;
  }

  static async listAssets() {
    const result = await pool.query('SELECT * FROM issuer_assets ORDER BY created_at DESC');
    return result.rows;
  }

  static async getBalance({ assetCode, accountId }) {
    const result = await pool.query(
      'SELECT * FROM issuer_balances WHERE asset_code = $1 AND account_id = $2',
      [assetCode, accountId]
    );
    return result.rows[0] ? parseInt(result.rows[0].balance_cents, 10) : 0;
  }

  static async listBalances(assetCode) {
    const result = await pool.query('SELECT * FROM issuer_balances WHERE asset_code = $1 ORDER BY created_at DESC', [assetCode]);
    return result.rows;
  }

  static async issue({ assetCode, amount, toAccountId, sourceCashAccountId, memo, createdBy } = {}) {
    if (!CashEngine) throw new Error('CashEngine not available');
    await this.ensureTables();
    const cents = toCents(amount);
    if (cents <= 0) throw new Error('amount must be positive');
    if (!toAccountId) throw new Error('toAccountId required');
    if (!sourceCashAccountId) throw new Error('sourceCashAccountId required');

    const asset = await this.getAsset(assetCode);
    if (!asset) throw new Error(`Issuer asset not found: ${assetCode}`);

    const opId = generateId('ISSUE');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Move cash backing from source to reserve
      const cashMovement = await CashEngine.transfer({
        fromAccountId: sourceCashAccountId,
        toAccountId: asset.reserve_account_id,
        amountCents: cents,
        movementType: 'transfer',
        memo: memo || `Issue ${assetCode}`,
        referenceId: opId,
        referenceType: 'issuer_operation',
        initiatedBy: createdBy || 'system',
      });

      // Credit token balance
      await client.query(
        `INSERT INTO issuer_balances (id, asset_code, account_id, balance_cents)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (asset_code, account_id) DO UPDATE SET balance_cents = issuer_balances.balance_cents + EXCLUDED.balance_cents, updated_at = NOW()`,
        [generateId('BAL'), assetCode, toAccountId, cents]
      );

      // Update issued total
      await client.query('UPDATE issuer_assets SET issued_cents = issued_cents + $1, updated_at = NOW() WHERE asset_code = $2', [cents, assetCode]);

      const opResult = await client.query(
        `INSERT INTO issuer_operations (operation_id, asset_code, operation_type, to_account_id, amount_cents, cash_movement_id, memo, status, metadata)
         VALUES ($1,$2,'issue',$3,$4,$5,$6,'completed',$7) RETURNING *`,
        [opId, assetCode, toAccountId, cents, cashMovement.movement_id, memo || `Issue ${assetCode}`, JSON.stringify({ sourceCashAccountId, createdBy })]
      );

      await client.query('COMMIT');
      return { operation: opResult.rows[0], cashMovement };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  static async redeem({ assetCode, amount, fromAccountId, targetCashAccountId, memo, createdBy } = {}) {
    if (!CashEngine) throw new Error('CashEngine not available');
    await this.ensureTables();
    const cents = toCents(amount);
    if (cents <= 0) throw new Error('amount must be positive');
    if (!fromAccountId) throw new Error('fromAccountId required');
    if (!targetCashAccountId) throw new Error('targetCashAccountId required');

    const asset = await this.getAsset(assetCode);
    if (!asset) throw new Error(`Issuer asset not found: ${assetCode}`);

    const balance = await this.getBalance({ assetCode, accountId: fromAccountId });
    if (balance < cents) throw new Error(`Insufficient ${assetCode} balance: ${balance} < ${cents}`);

    const opId = generateId('REDEEM');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Debit token balance
      await client.query(
        'UPDATE issuer_balances SET balance_cents = balance_cents - $1, updated_at = NOW() WHERE asset_code = $2 AND account_id = $3',
        [cents, assetCode, fromAccountId]
      );

      // Move cash backing from reserve to target
      const cashMovement = await CashEngine.transfer({
        fromAccountId: asset.reserve_account_id,
        toAccountId: targetCashAccountId,
        amountCents: cents,
        movementType: 'transfer',
        memo: memo || `Redeem ${assetCode}`,
        referenceId: opId,
        referenceType: 'issuer_operation',
        initiatedBy: createdBy || 'system',
      });

      // Update issued/redeemed totals
      await client.query('UPDATE issuer_assets SET issued_cents = issued_cents - $1, redeemed_cents = redeemed_cents + $1, updated_at = NOW() WHERE asset_code = $2', [cents, assetCode]);

      const opResult = await client.query(
        `INSERT INTO issuer_operations (operation_id, asset_code, operation_type, from_account_id, amount_cents, cash_movement_id, memo, status, metadata)
         VALUES ($1,$2,'redeem',$3,$4,$5,$6,'completed',$7) RETURNING *`,
        [opId, assetCode, fromAccountId, cents, cashMovement.movement_id, memo || `Redeem ${assetCode}`, JSON.stringify({ targetCashAccountId, createdBy })]
      );

      await client.query('COMMIT');
      return { operation: opResult.rows[0], cashMovement };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  static async transfer({ assetCode, amount, fromAccountId, toAccountId, memo, createdBy } = {}) {
    await this.ensureTables();
    const cents = toCents(amount);
    if (cents <= 0) throw new Error('amount must be positive');
    if (!fromAccountId || !toAccountId) throw new Error('fromAccountId and toAccountId required');

    const balance = await this.getBalance({ assetCode, accountId: fromAccountId });
    if (balance < cents) throw new Error(`Insufficient ${assetCode} balance: ${balance} < ${cents}`);

    const opId = generateId('XFER');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE issuer_balances SET balance_cents = balance_cents - $1, updated_at = NOW() WHERE asset_code = $2 AND account_id = $3',
        [cents, assetCode, fromAccountId]
      );
      await client.query(
        `INSERT INTO issuer_balances (id, asset_code, account_id, balance_cents)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (asset_code, account_id) DO UPDATE SET balance_cents = issuer_balances.balance_cents + EXCLUDED.balance_cents, updated_at = NOW()`,
        [generateId('BAL'), assetCode, toAccountId, cents]
      );
      const opResult = await client.query(
        `INSERT INTO issuer_operations (operation_id, asset_code, operation_type, from_account_id, to_account_id, amount_cents, memo, status, metadata)
         VALUES ($1,$2,'transfer',$3,$4,$5,$6,'completed',$7) RETURNING *`,
        [opId, assetCode, fromAccountId, toAccountId, cents, memo || `Transfer ${assetCode}`, JSON.stringify({ createdBy })]
      );
      await client.query('COMMIT');
      return { operation: opResult.rows[0] };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  static async listOperations({ assetCode, limit = 50 } = {}) {
    const params = [];
    let sql = 'SELECT * FROM issuer_operations';
    if (assetCode) { sql += ' WHERE asset_code = $1'; params.push(assetCode); }
    sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);
    const result = await pool.query(sql, params);
    return result.rows;
  }
}

module.exports = { IssuerEngine };
