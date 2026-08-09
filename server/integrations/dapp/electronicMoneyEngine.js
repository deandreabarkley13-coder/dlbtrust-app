'use strict';

/**
 * Electronic Money Engine — stored-value fiat ledger
 *
 * Lets the trust issue fiat-denominated e-money balances backed by real cash.
 * Users can transfer P2P instantly, redeem to a source cash account, or route
 * to external rails (wire, ACH, stablecoin) when available. This bypasses a
 * bank partner for on-platform value movement while keeping funds in USD.
 */

let pool;
let CashEngine;
try { pool = require('../bonds/pgPool'); } catch (e) { /* optional */ }
try { ({ CashEngine } = require('../cash/cashEngine')); } catch (e) { /* optional */ }

const EM_RESERVE_ACCOUNT = 'EM_RESERVE';

function generateId(prefix = 'EM') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

class ElectronicMoneyEngine {
  static async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS electronic_money_accounts (
        id TEXT PRIMARY KEY,
        account_id TEXT UNIQUE NOT NULL,
        holder_email TEXT,
        holder_name TEXT,
        balance_cents BIGINT NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','closed')),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS electronic_money_transactions (
        tx_id TEXT PRIMARY KEY,
        from_account_id TEXT,
        to_account_id TEXT,
        amount_cents BIGINT NOT NULL,
        tx_type TEXT NOT NULL CHECK (tx_type IN ('issue','transfer','redeem','payout','fee','adjustment')),
        status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending','completed','failed','reversed')),
        reference_id TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_em_account_id ON electronic_money_transactions(from_account_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_em_to_account_id ON electronic_money_transactions(to_account_id)`);
    await this.ensureReserveAccount();
  }

  static async ensureReserveAccount() {
    if (!CashEngine) return;
    try {
      const existing = await CashEngine.getAccount(EM_RESERVE_ACCOUNT);
      if (existing) return;
      await CashEngine.createAccount({
        accountId: EM_RESERVE_ACCOUNT,
        accountName: 'Electronic Money Reserve',
        accountType: 'escrow',
        notes: 'Backing reserve for e-money balances',
      });
    } catch (e) { /* may already exist */ }
  }

  static async createAccount({ holderEmail, holderName, metadata = {} } = {}) {
    await this.ensureTables();
    const accountId = generateId('EMA');
    const result = await pool.query(
      `INSERT INTO electronic_money_accounts (id, account_id, holder_email, holder_name, balance_cents, metadata)
       VALUES ($1, $2, $3, $4, 0, $5) RETURNING *`,
      [generateId(), accountId, holderEmail || null, holderName || null, JSON.stringify(metadata)]
    );
    return result.rows[0];
  }

  static async getAccount(accountId) {
    await this.ensureTables();
    const result = await pool.query('SELECT * FROM electronic_money_accounts WHERE account_id = $1', [accountId]);
    return result.rows[0] || null;
  }

  static async listAccounts({ limit = 50 } = {}) {
    await this.ensureTables();
    const result = await pool.query('SELECT * FROM electronic_money_accounts ORDER BY created_at DESC LIMIT $1', [limit]);
    return result.rows;
  }

  static async listTransactions({ accountId, limit = 50 } = {}) {
    await this.ensureTables();
    const result = await pool.query(
      `SELECT * FROM electronic_money_transactions
       WHERE from_account_id = $1 OR to_account_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [accountId, limit]
    );
    return result.rows;
  }

  static async issue({ sourceCashAccountId, emAccountId, amount, referenceId, memo, createdBy } = {}) {
    if (!CashEngine) throw new Error('CashEngine not available');
    await this.ensureTables();
    const amountCents = toCents(amount);
    if (amountCents <= 0) throw new Error('amount must be positive');
    if (!sourceCashAccountId) throw new Error('sourceCashAccountId required');
    if (!emAccountId) throw new Error('emAccountId required');

    const emAcct = await this.getAccount(emAccountId);
    if (!emAcct) throw new Error(`E-money account not found: ${emAccountId}`);

    // Move real cash into the EM reserve
    await CashEngine.transfer({
      fromAccountId: sourceCashAccountId,
      toAccountId: EM_RESERVE_ACCOUNT,
      amountCents,
      movementType: 'transfer',
      memo: memo || `Issue e-money to ${emAccountId}`,
      referenceId: referenceId || generateId('EMI'),
      referenceType: 'emoney_issue',
      initiatedBy: createdBy,
    });

    await pool.query(
      `UPDATE electronic_money_accounts SET balance_cents = balance_cents + $1, updated_at = NOW() WHERE account_id = $2`,
      [amountCents, emAccountId]
    );

    const tx = await pool.query(
      `INSERT INTO electronic_money_transactions (tx_id, to_account_id, amount_cents, tx_type, status, reference_id, metadata)
       VALUES ($1, $2, $3, 'issue', 'completed', $4, $5) RETURNING *`,
      [generateId('EMT'), emAccountId, amountCents, referenceId || null, JSON.stringify({ createdBy, sourceCashAccountId, memo })]
    );

    return { account: await this.getAccount(emAccountId), transaction: tx.rows[0] };
  }

  static async transfer({ fromAccountId, toAccountId, amount, referenceId, memo, createdBy } = {}) {
    await this.ensureTables();
    const amountCents = toCents(amount);
    if (amountCents <= 0) throw new Error('amount must be positive');
    if (!fromAccountId || !toAccountId) throw new Error('fromAccountId and toAccountId required');
    if (fromAccountId === toAccountId) throw new Error('from and to accounts must be different');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const fromResult = await client.query(
        `UPDATE electronic_money_accounts SET balance_cents = balance_cents - $1, updated_at = NOW()
         WHERE account_id = $2 AND status = 'active' RETURNING *`,
        [amountCents, fromAccountId]
      );
      if (!fromResult.rows.length) throw new Error(`Source account not found or not active: ${fromAccountId}`);
      if (parseInt(fromResult.rows[0].balance_cents, 10) < 0) throw new Error(`Insufficient e-money balance in ${fromAccountId}`);

      const toResult = await client.query(
        `UPDATE electronic_money_accounts SET balance_cents = balance_cents + $1, updated_at = NOW()
         WHERE account_id = $2 AND status = 'active' RETURNING *`,
        [amountCents, toAccountId]
      );
      if (!toResult.rows.length) throw new Error(`Destination account not found or not active: ${toAccountId}`);

      const tx = await client.query(
        `INSERT INTO electronic_money_transactions (tx_id, from_account_id, to_account_id, amount_cents, tx_type, status, reference_id, metadata)
         VALUES ($1, $2, $3, $4, 'transfer', 'completed', $5, $6) RETURNING *`,
        [generateId('EMT'), fromAccountId, toAccountId, amountCents, referenceId || null, JSON.stringify({ memo, createdBy })]
      );
      await client.query('COMMIT');
      return { from: fromResult.rows[0], to: toResult.rows[0], transaction: tx.rows[0] };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  static async redeem({ emAccountId, targetCashAccountId, amount, referenceId, memo, createdBy } = {}) {
    if (!CashEngine) throw new Error('CashEngine not available');
    await this.ensureTables();
    const amountCents = toCents(amount);
    if (amountCents <= 0) throw new Error('amount must be positive');
    if (!emAccountId || !targetCashAccountId) throw new Error('emAccountId and targetCashAccountId required');

    const emAcct = await this.getAccount(emAccountId);
    if (!emAcct) throw new Error(`E-money account not found: ${emAccountId}`);
    if (parseInt(emAcct.balance_cents, 10) < amountCents) throw new Error(`Insufficient e-money balance`);

    await pool.query(
      `UPDATE electronic_money_accounts SET balance_cents = balance_cents - $1, updated_at = NOW() WHERE account_id = $2`,
      [amountCents, emAccountId]
    );

    // Return the backing cash to the target account
    await CashEngine.transfer({
      fromAccountId: EM_RESERVE_ACCOUNT,
      toAccountId: targetCashAccountId,
      amountCents,
      movementType: 'transfer',
      memo: memo || `Redeem e-money from ${emAccountId}`,
      referenceId: referenceId || generateId('EMR'),
      referenceType: 'emoney_redeem',
      initiatedBy: createdBy,
    });

    const tx = await pool.query(
      `INSERT INTO electronic_money_transactions (tx_id, from_account_id, amount_cents, tx_type, status, reference_id, metadata)
       VALUES ($1, $2, $3, 'redeem', 'completed', $4, $5) RETURNING *`,
      [generateId('EMT'), emAccountId, amountCents, referenceId || null, JSON.stringify({ targetCashAccountId, memo, createdBy })]
    );

    return { account: await this.getAccount(emAccountId), transaction: tx.rows[0] };
  }

  static async payout({ emAccountId, amount, payoutOptions = {}, createdBy } = {}) {
    // Wrapper that redeems to a cash source, then routes through WireOriginationEngine or PayoutCenter
    await this.ensureTables();
    let WireOriginationEngine;
    try { ({ WireOriginationEngine } = require('./wireOriginationEngine')); } catch (e) { WireOriginationEngine = null; }
    if (!WireOriginationEngine) throw new Error('WireOriginationEngine not available for external payout');

    // Redeem to a temporary cash source account
    const tempSourceAccount = payoutOptions.sourceCashAccountId || 'CA-OPERATING';
    await this.redeem({ emAccountId, targetCashAccountId: tempSourceAccount, amount, memo: 'Redeem for external payout', createdBy });

    return WireOriginationEngine.createPayout({
      sourceType: 'cash',
      sourceAccountId: tempSourceAccount,
      amount,
      initiatedBy: createdBy,
      ...payoutOptions,
    });
  }

  static async getSummary() {
    await this.ensureTables();
    const [accts, txns] = await Promise.all([
      pool.query('SELECT COUNT(*) AS accounts, COALESCE(SUM(balance_cents),0) AS total_cents FROM electronic_money_accounts WHERE status = $1', ['active']),
      pool.query('SELECT COUNT(*) AS tx_count FROM electronic_money_transactions'),
    ]);
    return {
      activeAccounts: parseInt(accts.rows[0].accounts, 10),
      totalBalanceCents: parseInt(accts.rows[0].total_cents, 10),
      totalBalanceDollars: parseInt(accts.rows[0].total_cents, 10) / 100,
      transactionCount: parseInt(txns.rows[0].tx_count, 10),
    };
  }
}

module.exports = { ElectronicMoneyEngine };
