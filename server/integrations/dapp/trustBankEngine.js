'use strict';

/**
 * Trust Bank API Engine
 *
 * Lets the trust operate as its own internal bank/custodian: maintain customer
 * accounts, issue deposits, process internal transfers, and originate external
 * ACH/wire/ISO 20022 payments to other banks. External settlement is delegated
 * to WireOriginationEngine, BankTransferEngine, OpenBankingEngine, and ACHEngine.
 */

const pool = require('../bonds/pgPool');

let CashEngine, TrustAccountingEngine, BankTransferEngine, WireOriginationEngine, WireEngine, OpenBankingEngine, ComplianceEngine, ExternalEndpointEngine, LiliBankEngine;
function loadDeps() {
  try { ({ CashEngine } = require('../cash/cashEngine')); } catch (e) { CashEngine = null; }
  try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { TrustAccountingEngine = null; }
  try { ({ BankTransferEngine } = require('./bankTransferEngine')); } catch (e) { BankTransferEngine = null; }
  try { ({ WireOriginationEngine } = require('./wireOriginationEngine')); } catch (e) { WireOriginationEngine = null; }
  try { ({ WireEngine } = require('../wire/wireEngine')); } catch (e) { WireEngine = null; }
  try { ({ OpenBankingEngine } = require('./openBankingEngine')); } catch (e) { OpenBankingEngine = null; }
  try { ({ ComplianceEngine } = require('../compliance/complianceEngine')); } catch (e) { ComplianceEngine = null; }
  try { ({ ExternalEndpointEngine } = require('./externalEndpointEngine')); } catch (e) { ExternalEndpointEngine = null; }
  try { ({ LiliBankEngine } = require('../payments/liliBankEngine')); } catch (e) { LiliBankEngine = null; }
}

function generateId(prefix = 'TBA') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

class TrustBankEngine {
  static async ensureTables() {
    loadDeps();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trust_bank_customers (
        customer_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        kyc_status TEXT NOT NULL DEFAULT 'pending' CHECK (kyc_status IN ('pending','clear','review','blocked')),
        compliance_screening JSONB DEFAULT '{}',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trust_bank_accounts (
        account_id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES trust_bank_customers(customer_id),
        account_number TEXT UNIQUE NOT NULL,
        account_name TEXT NOT NULL,
        account_type TEXT NOT NULL DEFAULT 'checking' CHECK (account_type IN ('checking','savings','ledger','reserve')),
        currency TEXT NOT NULL DEFAULT 'USD',
        balance_cents BIGINT NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','closed')),
        linked_cash_account_id TEXT,
        linked_trust_account_code TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trust_bank_transactions (
        transaction_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES trust_bank_accounts(account_id),
        related_account_id TEXT,
        payment_id TEXT,
        amount_cents BIGINT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('debit','credit')),
        balance_after_cents BIGINT NOT NULL,
        description TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trust_bank_payments (
        payment_id TEXT PRIMARY KEY,
        from_account_id TEXT,
        to_account_id TEXT,
        external_routing TEXT,
        external_account TEXT,
        external_account_name TEXT,
        external_bank_name TEXT,
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        rail TEXT NOT NULL CHECK (rail IN ('internal','wire','ach','open_banking','iso20022','book_transfer','external','lili')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','compliance_review','originated','manual_pending','completed','failed','cancelled')),
        raw_message TEXT,
        external_tx_id TEXT,
        error_message TEXT,
        metadata JSONB DEFAULT '{}',
        initiated_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_trust_bank_accounts_customer ON trust_bank_accounts(customer_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_trust_bank_tx_account ON trust_bank_transactions(account_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_trust_bank_payments_status ON trust_bank_payments(status)`);
    // Expand status enum if older constraint exists
    try {
      await pool.query(`ALTER TABLE trust_bank_payments DROP CONSTRAINT IF EXISTS trust_bank_payments_status_check`);
      await pool.query(`ALTER TABLE trust_bank_payments ADD CONSTRAINT trust_bank_payments_status_check CHECK (status IN ('pending','compliance_review','originated','manual_pending','completed','failed','cancelled'))`);
    } catch (e) { console.warn('[trust-bank] status constraint update:', e.message); }
    // Expand rail enum if older constraint exists
    try {
      await pool.query(`ALTER TABLE trust_bank_payments DROP CONSTRAINT IF EXISTS trust_bank_payments_rail_check`);
      await pool.query(`ALTER TABLE trust_bank_payments ADD CONSTRAINT trust_bank_payments_rail_check CHECK (rail IN ('internal','wire','ach','open_banking','iso20022','book_transfer','external','lili'))`);
    } catch (e) { console.warn('[trust-bank] rail constraint update:', e.message); }
  }

  static async createCustomer({ name, email, phone, metadata } = {}) {
    if (!name) throw new Error('name required');
    await this.ensureTables();
    let kyc = { status: 'pending' };
    if (ComplianceEngine) {
      try { kyc = await ComplianceEngine.screen({ type: 'kyc', entityType: 'individual', fullName: name, email, phone }); } catch (e) { /* best effort */ }
    }
    const customerId = generateId('TBC');
    const result = await pool.query(
      `INSERT INTO trust_bank_customers (customer_id, name, email, phone, kyc_status, compliance_screening, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [customerId, name, email || null, phone || null, kyc.status || 'pending', JSON.stringify(kyc), JSON.stringify(metadata || {})]
    );
    return result.rows[0];
  }

  static async getCustomer(customerId) {
    await this.ensureTables();
    const result = await pool.query(`SELECT * FROM trust_bank_customers WHERE customer_id = $1`, [customerId]);
    return result.rows[0] || null;
  }

  static async listCustomers({ limit = 100 } = {}) {
    await this.ensureTables();
    const result = await pool.query(`SELECT * FROM trust_bank_customers ORDER BY created_at DESC LIMIT $1`, [limit]);
    return result.rows;
  }

  static async createAccount({ customerId, accountName, accountType = 'checking', currency = 'USD', linkedCashAccountId, linkedTrustAccountCode, metadata } = {}) {
    if (!customerId || !accountName) throw new Error('customerId and accountName required');
    await this.ensureTables();
    const customer = await this.getCustomer(customerId);
    if (!customer) throw new Error(`Customer not found: ${customerId}`);
    const accountId = generateId('TBA');
    const accountNumber = generateId('TBN').toUpperCase().slice(0, 20);
    const result = await pool.query(
      `INSERT INTO trust_bank_accounts (account_id, customer_id, account_number, account_name, account_type, currency, balance_cents, linked_cash_account_id, linked_trust_account_code, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9) RETURNING *`,
      [accountId, customerId, accountNumber, accountName, accountType, currency, linkedCashAccountId || null, linkedTrustAccountCode || null, JSON.stringify(metadata || {})]
    );
    return result.rows[0];
  }

  static async getAccount(accountId) {
    await this.ensureTables();
    const result = await pool.query(`SELECT * FROM trust_bank_accounts WHERE account_id = $1`, [accountId]);
    return result.rows[0] || null;
  }

  static async listAccounts({ customerId, limit = 100 } = {}) {
    await this.ensureTables();
    const conditions = [];
    const params = [];
    if (customerId) { conditions.push(`customer_id = $${params.length + 1}`); params.push(customerId); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const result = await pool.query(`SELECT * FROM trust_bank_accounts ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return result.rows;
  }

  static async _recordTransaction({ accountId, relatedAccountId, paymentId, amountCents, type, balanceAfter, description, metadata } = {}) {
    const txId = generateId('TBTX');
    await pool.query(
      `INSERT INTO trust_bank_transactions (transaction_id, account_id, related_account_id, payment_id, amount_cents, type, balance_after_cents, description, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [txId, accountId, relatedAccountId || null, paymentId || null, amountCents, type, balanceAfter, description || null, JSON.stringify(metadata || {})]
    );
    return txId;
  }

  static async _updateBalance(accountId, deltaCents) {
    const result = await pool.query(
      `UPDATE trust_bank_accounts SET balance_cents = balance_cents + $2, updated_at = NOW() WHERE account_id = $1 RETURNING *`,
      [accountId, deltaCents]
    );
    if (!result.rows.length) throw new Error(`Account not found: ${accountId}`);
    return result.rows[0];
  }

  static async deposit({ accountId, amount, description, initiatedBy = 'system' } = {}) {
    if (!accountId || !amount) throw new Error('accountId and amount required');
    await this.ensureTables();
    const cents = toCents(amount);
    if (cents <= 0) throw new Error('amount must be positive');
    const account = await this.getAccount(accountId);
    if (!account) throw new Error(`Account not found: ${accountId}`);
    const updated = await this._updateBalance(accountId, cents);
    await this._recordTransaction({ accountId, amountCents: cents, type: 'credit', balanceAfter: updated.balance_cents, description: description || 'Deposit', metadata: { initiatedBy } });
    return { account: updated, transaction_id: updated.account_id };
  }

  static async internalTransfer({ fromAccountId, toAccountId, amount, description, initiatedBy = 'system' } = {}) {
    if (!fromAccountId || !toAccountId || !amount) throw new Error('fromAccountId, toAccountId and amount required');
    if (fromAccountId === toAccountId) throw new Error('from and to must differ');
    await this.ensureTables();
    const cents = toCents(amount);
    if (cents <= 0) throw new Error('amount must be positive');
    const from = await this.getAccount(fromAccountId);
    const to = await this.getAccount(toAccountId);
    if (!from || !to) throw new Error('Account not found');
    if (parseInt(from.balance_cents, 10) < cents) throw new Error(`Insufficient balance in ${fromAccountId}`);

    const paymentId = generateId('TBP');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const fromUpdated = await this._updateBalance(fromAccountId, -cents);
      const toUpdated = await this._updateBalance(toAccountId, cents);
      await client.query(
        `INSERT INTO trust_bank_payments (payment_id, from_account_id, to_account_id, amount_cents, currency, rail, status, initiated_by)
         VALUES ($1, $2, $3, $4, 'USD', 'internal', 'completed', $5)`,
        [paymentId, fromAccountId, toAccountId, cents, initiatedBy]
      );
      await this._recordTransaction({ accountId: fromAccountId, relatedAccountId: toAccountId, paymentId, amountCents: cents, type: 'debit', balanceAfter: fromUpdated.balance_cents, description: description || `Transfer to ${toAccountId}`, metadata: { initiatedBy } });
      await this._recordTransaction({ accountId: toAccountId, relatedAccountId: fromAccountId, paymentId, amountCents: cents, type: 'credit', balanceAfter: toUpdated.balance_cents, description: description || `Transfer from ${fromAccountId}`, metadata: { initiatedBy } });
      await client.query('COMMIT');
      return { paymentId, from: fromUpdated, to: toUpdated, status: 'completed' };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  static async originatePayment({ fromAccountId, externalRouting, externalAccount, externalAccountName, externalBankName, amount, rail = 'wire', currency = 'USD', description, initiatedBy = 'system', endpointId, metadata = {}, recipientEmail } = {}) {
    if (!fromAccountId || !amount) throw new Error('fromAccountId and amount required');
    if (rail !== 'lili' && (!externalAccount || !externalRouting)) throw new Error('externalRouting and externalAccount required for this rail');
    await this.ensureTables();
    const cents = toCents(amount);
    if (cents <= 0) throw new Error('amount must be positive');
    const from = await this.getAccount(fromAccountId);
    if (!from) throw new Error(`Account not found: ${fromAccountId}`);
    if (from.status !== 'active') throw new Error(`Account ${fromAccountId} is ${from.status}`);
    if (parseInt(from.balance_cents, 10) < cents) throw new Error(`Insufficient trust bank balance: ${parseInt(from.balance_cents,10)/100} < ${amount}`);

    const paymentId = generateId('TBP');
    const finalMetadata = { ...metadata, endpointId, recipientEmail };
    await pool.query(
      `INSERT INTO trust_bank_payments (payment_id, from_account_id, external_routing, external_account, external_account_name, external_bank_name, amount_cents, currency, rail, status, initiated_by, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11)`,
      [paymentId, fromAccountId, externalRouting || null, externalAccount || null, externalAccountName || null, externalBankName || null, cents, currency, rail, initiatedBy, JSON.stringify(finalMetadata)]
    );
    return { paymentId, status: 'pending', amount_cents: cents };
  }

  static async sendPayment(paymentId) {
    await this.ensureTables();
    const paymentRes = await pool.query(`SELECT * FROM trust_bank_payments WHERE payment_id = $1`, [paymentId]);
    const payment = paymentRes.rows[0];
    if (!payment) throw new Error(`Payment not found: ${paymentId}`);
    if (payment.status !== 'pending') throw new Error(`Payment already ${payment.status}`);

    const from = await this.getAccount(payment.from_account_id);
    if (!from) throw new Error('Source account missing');
    if (parseInt(from.balance_cents, 10) < parseInt(payment.amount_cents, 10)) throw new Error('Insufficient funds');

    // Compliance screening
    if (ComplianceEngine) {
      const screen = await ComplianceEngine.screen({
        type: 'combined',
        entityType: 'business',
        businessName: payment.external_account_name,
        email: null,
        bankAccount: payment.external_account,
        routingNumber: payment.external_routing,
        amount: payment.amount_cents / 100,
      });
      if (screen.status === 'blocked') {
        await pool.query(`UPDATE trust_bank_payments SET status = 'failed', error_message = $2, updated_at = NOW() WHERE payment_id = $1`, [paymentId, 'Compliance blocked']);
        throw new Error('Compliance blocked payment');
      }
      if (screen.status === 'review') {
        await pool.query(`UPDATE trust_bank_payments SET status = 'compliance_review', updated_at = NOW() WHERE payment_id = $1`, [paymentId]);
        return { paymentId, status: 'compliance_review' };
      }
    }

    let result = null;
    let rawMessage = null;
    let externalTxId = null;
    let status = 'originated';
    let error = null;

    function mapWireStatus(s) {
      if (s === 'completed' || s === 'settled' || s === 'confirmed' || s === 'sent') return 'completed';
      if (s === 'needs_setup' || s === 'manual_pending') return 'manual_pending';
      if (s === 'failed' || s === 'cancelled') return 'failed';
      return 'originated';
    }

    function mapBankTransferStatus(s) {
      if (s === 'completed' || s === 'settled') return 'completed';
      if (s === 'initiated') return 'originated';
      if (s === 'manual_pending' || s === 'needs_setup') return 'manual_pending';
      if (s === 'failed') return 'failed';
      if (s === 'cancelled') return 'cancelled';
      return 'originated';
    }

    try {
      if (payment.rail === 'wire' && WireEngine) {
        let meta = payment.metadata || {};
        if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = {}; } }
        const senderRouting = meta.senderRouting || process.env.PTC_BANK_ROUTING || process.env.TRUST_BANK_ROUTING || '111000025';
        const senderAccount = meta.senderAccount || process.env.PTC_BANK_SETTLEMENT_ACCOUNT || process.env.TRUST_BANK_ACCOUNT || from.account_number;
        const paymentType = meta.paymentType || (payment.description && /interest/i.test(payment.description) ? 'interest_payment' : 'trust_distribution');
        const isPtcInterest = meta.interestIncomeSource === '4000' || meta.paymentType === 'interest_payment' || (payment.description && /interest income/i.test(payment.description));
        if (isPtcInterest) {
          meta.glDebitAccountCode = meta.glDebitAccountCode || '4000';
          meta.glCreditAccountCode = meta.glCreditAccountCode || from.linked_trust_account_code || process.env.PTC_BANK_GL_ACCOUNT || '1010';
          meta.paymentType = meta.paymentType || 'interest_payment';
        }
        const requiresApproval = meta.requiresApproval !== undefined
          ? meta.requiresApproval
          : (process.env.PTC_BANK_WIRE_AUTO_APPROVE === 'true' ? false : true);
        const wire = await WireEngine.initiateWire({
          amountCents: Number(payment.amount_cents),
          beneficiaryName: payment.external_account_name || 'External Beneficiary',
          beneficiaryRouting: payment.external_routing,
          beneficiaryAccount: payment.external_account,
          beneficiaryBankName: payment.external_bank_name,
          senderName: process.env.PTC_BANK_NAME || process.env.TRUST_BANK_NAME || 'DLB Trust PTC Bank',
          senderRouting,
          senderAccount,
          paymentType,
          description: payment.description || `Trust bank payment ${paymentId}`,
          initiatedBy: payment.initiated_by,
          requiresApproval,
          metadata: meta,
        });
        externalTxId = wire.wire_id;
        rawMessage = JSON.stringify(wire);
        status = wire.status === 'approved' ? 'originated' : mapWireStatus(wire.status);
        if (wire.status === 'approved') {
          try {
            const sent = await WireEngine.sendWire(wire.wire_id);
            externalTxId = sent.wire_id;
            rawMessage = JSON.stringify(sent);
            status = mapWireStatus(sent.status);
          } catch (sendErr) {
            status = 'manual_pending';
            error = sendErr.message;
          }
        }
      } else if ((payment.rail === 'ach' || payment.rail === 'open_banking') && BankTransferEngine) {
        const bankAccount = await BankTransferEngine.createBankAccount({
          name: payment.external_account_name || 'External Beneficiary',
          bankName: payment.external_bank_name,
          routingNumber: payment.external_routing,
          accountNumber: payment.external_account,
        });
        const transfer = await BankTransferEngine.pushCredit({
          sourceCashAccountId: from.linked_cash_account_id,
          destinationBankAccountId: bankAccount.account_id,
          amount: payment.amount_cents / 100,
          rail: payment.rail === 'ach' ? 'ach' : 'web_payment',
          memo: `Trust bank payment ${paymentId}`,
          initiatedBy: payment.initiated_by,
        });
        externalTxId = transfer.transfer_id;
        rawMessage = JSON.stringify(transfer);
        status = mapBankTransferStatus(transfer.status);
      } else if (payment.rail === 'iso20022' && OpenBankingEngine) {
        const p = await OpenBankingEngine.createPayment({
          connector: 'generic_rest',
          sourceCashAccountId: from.linked_cash_account_id,
          amount: payment.amount_cents / 100,
          creditorName: payment.external_account_name || 'External Beneficiary',
          creditorAccount: payment.external_account,
          creditorRouting: payment.external_routing,
          remittance: `Trust bank payment ${paymentId}`,
        });
        externalTxId = p.paymentId;
        rawMessage = p.iso20022_message;
        status = p.status === 'originated' ? 'originated' : p.status;
      } else if (payment.rail === 'external' && ExternalEndpointEngine) {
        let meta = payment.metadata || {};
        if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = {}; } }
        let endpointId = meta && meta.endpointId;
        if (!endpointId) {
          const list = await ExternalEndpointEngine.listEndpoints({ enabled: true });
          if (!list.length) throw new Error('No enabled external endpoint configured');
          endpointId = list[0].endpoint_id;
        }
        const epResult = await ExternalEndpointEngine.executePayment({
          endpointId,
          sourceType: 'cash',
          sourceAccountId: from.linked_cash_account_id,
          amount: payment.amount_cents / 100,
          debtorName: 'DLB Trust',
          debtorAccount: from.account_number,
          creditorName: payment.external_account_name || 'External Beneficiary',
          creditorAccount: payment.external_account,
          creditorRouting: payment.external_routing,
          creditorBank: payment.external_bank_name || null,
          paymentType: 'trust_bank_external',
          description: `Trust bank payment ${paymentId}`,
        });
        externalTxId = epResult.externalId;
        rawMessage = JSON.stringify(epResult);
        status = epResult.status === 'completed' ? 'completed' : (epResult.status === 'originated' ? 'originated' : (epResult.status === 'manual_pending' ? 'manual_pending' : 'failed'));
        if (epResult.errorMessage) error = epResult.errorMessage;
      } else if (payment.rail === 'lili' && LiliBankEngine) {
        let meta = payment.metadata || {};
        if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = {}; } }
        const isEmail = payment.external_account && payment.external_account.includes('@') && !payment.external_routing;
        const liliResult = await LiliBankEngine.createPayment({
          amount: payment.amount_cents / 100,
          currency: payment.currency,
          recipientName: payment.external_account_name || 'External Beneficiary',
          recipientAccount: isEmail ? null : payment.external_account,
          recipientRouting: isEmail ? null : payment.external_routing,
          recipientBank: payment.external_bank_name,
          recipientEmail: meta.recipientEmail || (isEmail ? payment.external_account : null),
          sourceAccountId: payment.from_account_id,
          liliBusinessUserId: meta.liliBusinessUserId || null,
          initiatedBy: payment.initiated_by,
        });
        externalTxId = liliResult && (liliResult.external_tx_id || liliResult.payment_id);
        rawMessage = JSON.stringify(liliResult);
        status = liliResult && liliResult.status ? (liliResult.status === 'api_pending' ? 'originated' : (liliResult.status === 'completed' ? 'completed' : (liliResult.status === 'manual_pending' ? 'manual_pending' : liliResult.status))) : 'manual_pending';
      } else if (payment.rail === 'book_transfer') {
        // Internal book transfer to an external account (manual/clearing)
        status = 'originated';
      } else {
        throw new Error('No rail engine available');
      }

      // Debit trust bank account
      const updated = await this._updateBalance(from.account_id, -payment.amount_cents);
      await this._recordTransaction({ accountId: from.account_id, paymentId, amountCents: payment.amount_cents, type: 'debit', balanceAfter: updated.balance_cents, description: `External ${payment.rail} payment ${paymentId}`, metadata: { externalTxId, rail: payment.rail } });

      await pool.query(
        `UPDATE trust_bank_payments SET status = $1, raw_message = $2, external_tx_id = $3, error_message = null, updated_at = NOW() WHERE payment_id = $4`,
        [status, rawMessage, externalTxId, paymentId]
      );
      result = { paymentId, status, externalTxId, rawMessage, account: updated };
    } catch (err) {
      error = err.message;
      await pool.query(`UPDATE trust_bank_payments SET status = 'failed', error_message = $2, updated_at = NOW() WHERE payment_id = $1`, [paymentId, error]);
      throw err;
    }

    return result;
  }

  static async settlePayment(paymentId, externalTxId) {
    await this.ensureTables();
    const result = await pool.query(`UPDATE trust_bank_payments SET status = 'completed', external_tx_id = $2, updated_at = NOW() WHERE payment_id = $1 AND status = 'originated' RETURNING *`, [paymentId, externalTxId || null]);
    if (!result.rows.length) throw new Error('Payment not found or not originated');
    return result.rows[0];
  }

  static async listPayments({ status, limit = 100 } = {}) {
    await this.ensureTables();
    const conditions = [];
    const params = [];
    if (status) { conditions.push(`status = $${params.length + 1}`); params.push(status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const result = await pool.query(`SELECT * FROM trust_bank_payments ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return result.rows;
  }

  static async getPayment(paymentId) {
    await this.ensureTables();
    const result = await pool.query(`SELECT * FROM trust_bank_payments WHERE payment_id = $1`, [paymentId]);
    return result.rows[0] || null;
  }
}

module.exports = { TrustBankEngine };
