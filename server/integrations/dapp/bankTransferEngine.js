'use strict';

/**
 * Bank Transfer Engine — reconcile and move fiat between the trust ledger and
 * external bank accounts (Lili, Sunrise, ODFI/RDFI, etc.).
 *
 * Outbound: "push credit" to a bank account via web-payment rail, wire, ACH, or ISO 20022.
 * Inbound: record deposits and optionally mint issuer assets against the reserve.
 */

const pool = require('../bonds/pgPool');
let CashEngine, IssuerEngine, WebPaymentRailEngine, WireOriginationEngine, ACHEngine, LiliMcpEngine;
function loadDeps() {
  try { ({ CashEngine } = require('../cash/cashEngine')); } catch (e) { CashEngine = null; }
  try { ({ IssuerEngine } = require('./issuerEngine')); } catch (e) { IssuerEngine = null; }
  try { ({ WebPaymentRailEngine } = require('../payments/webPaymentRailEngine')); } catch (e) { WebPaymentRailEngine = null; }
  try { ({ WireOriginationEngine } = require('./wireOriginationEngine')); } catch (e) { WireOriginationEngine = null; }
  try { ({ ACHEngine } = require('../ach/achEngine')); } catch (e) { ACHEngine = null; }
  try { ({ LiliMcpEngine } = require('../payments/liliMcpEngine')); } catch (e) { LiliMcpEngine = null; }
}

function generateId(prefix = 'BT') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

class BankTransferEngine {
  static async ensureTables() {
    loadDeps();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bank_accounts (
        account_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        bank_name TEXT,
        routing_number TEXT,
        account_number TEXT,
        account_type TEXT DEFAULT 'checking' CHECK (account_type IN ('checking','savings','loan','wallet','other')),
        country TEXT DEFAULT 'US',
        currency TEXT DEFAULT 'USD',
        beneficiary_address TEXT,
        linked_cash_account_id TEXT,
        linked_issuer_asset_code TEXT,
        source TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bank_transfers (
        transfer_id TEXT PRIMARY KEY,
        direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
        amount_cents BIGINT NOT NULL,
        currency TEXT DEFAULT 'USD',
        source_cash_account_id TEXT,
        destination_cash_account_id TEXT,
        from_bank_account_id TEXT,
        to_bank_account_id TEXT,
        rail TEXT NOT NULL DEFAULT 'web_payment' CHECK (rail IN ('web_payment','wire','ach','lili','iso20022','manual','apisix','moov_paygate','external')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','initiated','originated','completed','failed','cancelled','manual_pending')),
        external_tx_id TEXT,
        web_payment_id TEXT,
        wire_payout_id TEXT,
        ach_batch_id TEXT,
        memo TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bank_transfers_status ON bank_transfers(status)`);
    // Expand rail enum on existing tables so new rails (e.g. apisix) can be recorded.
    try {
      await pool.query(`ALTER TABLE bank_transfers DROP CONSTRAINT IF EXISTS bank_transfers_rail_check`);
      await pool.query(`ALTER TABLE bank_transfers ADD CONSTRAINT bank_transfers_rail_check CHECK (rail IN ('web_payment','wire','ach','lili','iso20022','manual','apisix','moov_paygate','external'))`);
    } catch (e) { console.warn('[bank-transfer] rail constraint update:', e.message); }
    // Expand status enum so rails that return 'originated' can be recorded.
    try {
      await pool.query(`ALTER TABLE bank_transfers DROP CONSTRAINT IF EXISTS bank_transfers_status_check`);
      await pool.query(`ALTER TABLE bank_transfers ADD CONSTRAINT bank_transfers_status_check CHECK (status IN ('pending','initiated','originated','completed','failed','cancelled','manual_pending'))`);
    } catch (e) { console.warn('[bank-transfer] status constraint update:', e.message); }
  }

  static async createBankAccount({ name, bankName, routingNumber, accountNumber, accountType = 'checking', country = 'US', currency = 'USD', beneficiaryAddress, linkedCashAccountId, linkedIssuerAssetCode, source, metadata = {} } = {}) {
    await this.ensureTables();
    if (!name) throw new Error('name required');
    const id = generateId('BA');
    const result = await pool.query(
      `INSERT INTO bank_accounts (account_id, name, bank_name, routing_number, account_number, account_type, country, currency, beneficiary_address, linked_cash_account_id, linked_issuer_asset_code, source, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [id, name, bankName || null, routingNumber || null, accountNumber || null, accountType, country, currency, beneficiaryAddress || null, linkedCashAccountId || null, linkedIssuerAssetCode || null, source || null, JSON.stringify(metadata)]
    );
    return result.rows[0];
  }

  static async getBankAccount(id) {
    const result = await pool.query('SELECT * FROM bank_accounts WHERE account_id = $1', [id]);
    return result.rows[0] || null;
  }

  static async listBankAccounts() {
    const result = await pool.query('SELECT * FROM bank_accounts ORDER BY created_at DESC');
    return result.rows;
  }

  static async getBankTransfer(transferId) {
    const result = await pool.query('SELECT * FROM bank_transfers WHERE transfer_id = $1', [transferId]);
    return result.rows[0] || null;
  }

  static async listBankTransfers({ direction, status, limit = 50 } = {}) {
    const params = [];
    const conditions = [];
    if (direction) { conditions.push('direction = $' + (params.length + 1)); params.push(direction); }
    if (status) { conditions.push('status = $' + (params.length + 1)); params.push(status); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(limit);
    const result = await pool.query(`SELECT * FROM bank_transfers ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return result.rows;
  }

  static async pushCredit({
    sourceCashAccountId,
    destinationBankAccountId,
    amount,
    rail = 'web_payment',
    webPaymentAdapter = 'lili',
    memo,
    initiatedBy = 'system',
    destinationDetails,
  } = {}) {
    loadDeps();
    await this.ensureTables();
    const cents = toCents(amount);
    if (cents <= 0) throw new Error('amount must be positive');

    let destination = destinationDetails || null;
    if (destinationBankAccountId) {
      const acct = await this.getBankAccount(destinationBankAccountId);
      if (!acct) throw new Error(`Bank account not found: ${destinationBankAccountId}`);
      destination = {
        name: acct.name,
        bankName: acct.bank_name,
        routingNumber: acct.routing_number,
        accountNumber: acct.account_number,
        accountType: acct.account_type,
        country: acct.country,
        beneficiaryAddress: acct.beneficiary_address,
      };
    }
    if (!destination) throw new Error('destinationBankAccountId or destinationDetails required');

    if (sourceCashAccountId && CashEngine) {
      const acct = await CashEngine.getAccount(sourceCashAccountId);
      if (!acct) throw new Error(`Source cash account not found: ${sourceCashAccountId}`);
      if (parseInt(acct.balance_cents || 0, 10) < cents) throw new Error(`Insufficient cash in ${sourceCashAccountId}`);
    }

    const transferId = generateId('BTO');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO bank_transfers (transfer_id, direction, amount_cents, currency, source_cash_account_id, to_bank_account_id, rail, status, memo, metadata)
         VALUES ($1,'outbound',$2,'USD',$3,$4,$5,'pending',$6,$7)`,
        [transferId, cents, sourceCashAccountId || null, destinationBankAccountId || null, rail, memo || `Push credit to ${destination.name}`, JSON.stringify({ destination, webPaymentAdapter })]
      );

      let webPaymentId = null;
      let wirePayoutId = null;

      if (rail === 'web_payment') {
        if (!WebPaymentRailEngine) throw new Error('WebPaymentRailEngine not available');
        const payment = await WebPaymentRailEngine.createPayment({
          adapterName: webPaymentAdapter,
          amount,
          currency: 'USD',
          recipientName: destination.name,
          recipientAccount: destination.accountNumber,
          recipientBank: destination.bankName,
          recipientRouting: destination.routingNumber,
          recipientCountry: destination.country,
          sourceAccountId: sourceCashAccountId,
          description: memo || `Bank transfer ${transferId} to ${destination.name}`,
          initiatedBy,
        });
        webPaymentId = payment.payment_id;
        await client.query(
          `UPDATE bank_transfers SET web_payment_id = $1, external_tx_id = $2, status = 'initiated', updated_at = NOW() WHERE transfer_id = $3`,
          [webPaymentId, webPaymentId, transferId]
        );
      } else if (rail === 'wire') {
        if (!WireOriginationEngine) throw new Error('WireOriginationEngine not available');
        const payout = await WireOriginationEngine.createPayout({
          sourceType: 'cash',
          sourceAccountId: sourceCashAccountId,
          amount,
          beneficiaryName: destination.name,
          beneficiaryRouting: destination.routingNumber,
          beneficiaryAccount: destination.accountNumber,
          beneficiaryBankName: destination.bankName,
          beneficiaryAddress: destination.beneficiaryAddress,
          adapter: 'wire',
          description: memo || `Bank transfer ${transferId} to ${destination.name}`,
          initiatedBy,
        });
        wirePayoutId = payout.payout_id || payout.data?.payout_id;
        await client.query(
          `UPDATE bank_transfers SET wire_payout_id = $1, external_tx_id = $2, status = 'initiated', updated_at = NOW() WHERE transfer_id = $3`,
          [wirePayoutId, payout.wire_id || wirePayoutId, transferId]
        );
      } else if (rail === 'ach') {
        // ACHEngine.createBatch returns batch_id; actual transmit is separate.
        if (!ACHEngine) throw new Error('ACHEngine not available');
        const batch = await ACHEngine.createBatch({
          description: memo || `Bank transfer ${transferId}`,
          secCode: 'CCD',
          createdBy: initiatedBy,
        }, [{
          receivingRouting: destination.routingNumber,
          accountNumber: destination.accountNumber,
          amountCents: cents,
          transactionCode: '22',
          individualId: transferId,
          individualName: destination.name,
        }]);
        await client.query(
          `UPDATE bank_transfers SET ach_batch_id = $1, external_tx_id = $2, status = 'initiated', updated_at = NOW() WHERE transfer_id = $3`,
          [batch.batch_id, batch.batch_id, transferId]
        );
      } else if (rail === 'lili' && LiliMcpEngine) {
        // LiliMcpEngine payToPayee only supports bill-pay read/prepare; may return manual_pending.
        const lili = await LiliMcpEngine.payToPayee({
          amount,
          recipientName: destination.name,
          recipientAccount: destination.accountNumber,
          recipientRouting: destination.routingNumber,
          recipientBank: destination.bankName,
          memo: memo || `Bank transfer ${transferId}`,
        });
        const status = lili.status === 'api_pending' ? 'initiated' : 'manual_pending';
        await client.query(
          `UPDATE bank_transfers SET status = $1, external_tx_id = $2, metadata = metadata || $3, updated_at = NOW() WHERE transfer_id = $4`,
          [status, lili.externalTxId || null, JSON.stringify({ liliResult: lili }), transferId]
        );
      } else {
        await client.query(
          `UPDATE bank_transfers SET status = 'manual_pending', updated_at = NOW() WHERE transfer_id = $1`,
          [transferId]
        );
      }

      await client.query('COMMIT');
      return this.getBankTransfer(transferId);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  static async sendPushCredit(transferId) {
    loadDeps();
    const transfer = await this.getBankTransfer(transferId);
    if (!transfer) throw new Error('Transfer not found');
    if (transfer.direction !== 'outbound') throw new Error('Only outbound transfers can be sent');

    function mapStatus(s) {
      const allowed = new Set(['pending','initiated','completed','failed','cancelled','manual_pending']);
      if (allowed.has(s)) return s;
      if (s === 'completed' || s === 'sent' || s === 'settled' || s === 'confirmed') return 'completed';
      if (s === 'originating' || s === 'pending_send') return 'initiated';
      if (s === 'needs_setup' || s === 'manual_pending') return 'manual_pending';
      if (s === 'failed' || s === 'cancelled') return s;
      return 'initiated';
    }

    if (transfer.web_payment_id && WebPaymentRailEngine) {
      const payment = await WebPaymentRailEngine.sendPayment(transfer.web_payment_id);
      const status = mapStatus(payment.status);
      await pool.query(
        `UPDATE bank_transfers SET status = $1, external_tx_id = $2, updated_at = NOW() WHERE transfer_id = $3`,
        [status, payment.external_tx_id || transfer.web_payment_id, transferId]
      );
    } else if (transfer.wire_payout_id && WireOriginationEngine) {
      const sent = await WireOriginationEngine.sendPayout(transfer.wire_payout_id);
      const status = mapStatus(sent.status);
      await pool.query(
        `UPDATE bank_transfers SET status = $1, external_tx_id = $2, updated_at = NOW() WHERE transfer_id = $3`,
        [status, sent.wire_id || transfer.wire_payout_id, transferId]
      );
    } else if (transfer.ach_batch_id && ACHEngine) {
      await ACHEngine.transmitBatch(transfer.ach_batch_id);
      await pool.query(
        `UPDATE bank_transfers SET status = 'completed', external_tx_id = $1, updated_at = NOW() WHERE transfer_id = $2`,
        [transfer.ach_batch_id, transferId]
      );
    } else {
      throw new Error('No actionable rail for this transfer');
    }

    return this.getBankTransfer(transferId);
  }

  static async receiveCredit({
    sourceBankAccountId,
    destinationCashAccountId,
    amount,
    memo,
    issueAsset,
    assetCode,
    issueToAccountId,
    initiatedBy = 'system',
  } = {}) {
    loadDeps();
    await this.ensureTables();
    const cents = toCents(amount);
    if (cents <= 0) throw new Error('amount must be positive');
    if (!destinationCashAccountId) throw new Error('destinationCashAccountId required');

    const transferId = generateId('BTI');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO bank_transfers (transfer_id, direction, amount_cents, currency, from_bank_account_id, destination_cash_account_id, rail, status, memo, metadata)
         VALUES ($1,'inbound',$2,'USD',$3,$4,'manual','pending',$5,$6)`,
        [transferId, cents, sourceBankAccountId || null, destinationCashAccountId, memo || `Inbound bank credit`, JSON.stringify({ issueAsset, assetCode, issueToAccountId })]
      );

      let cashMovement = null;
      if (CashEngine) {
        cashMovement = await CashEngine.deposit({
          toAccountId: destinationCashAccountId,
          amountCents: cents,
          memo: memo || `Inbound bank transfer ${transferId}`,
          referenceId: transferId,
          referenceType: 'bank_transfer',
          initiatedBy,
        });
      }

      let issueOp = null;
      if (issueAsset && assetCode && issueToAccountId && IssuerEngine) {
        issueOp = await IssuerEngine.issue({
          assetCode,
          amount,
          toAccountId: issueToAccountId,
          sourceCashAccountId: destinationCashAccountId,
          memo: memo || `Issue ${assetCode} for inbound transfer ${transferId}`,
          createdBy: initiatedBy,
        });
      }

      await client.query(
        `UPDATE bank_transfers SET status = 'completed', updated_at = NOW() WHERE transfer_id = $1`,
        [transferId]
      );

      await client.query('COMMIT');
      return { transfer: await this.getBankTransfer(transferId), cashMovement, issueOperation: issueOp && issueOp.operation };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  static async cancelPushCredit(transferId) {
    const transfer = await this.getBankTransfer(transferId);
    if (!transfer) throw new Error('Transfer not found');
    if (transfer.direction !== 'outbound') throw new Error('Only outbound transfers can be cancelled');
    if (transfer.status === 'completed') throw new Error('Cannot cancel completed transfer');

    if (transfer.web_payment_id && WebPaymentRailEngine) {
      try { await WebPaymentRailEngine.cancelPayment(transfer.web_payment_id); } catch (e) { /* ignore */ }
    } else if (transfer.wire_payout_id && WireOriginationEngine) {
      try { await WireOriginationEngine.cancelPayout(transfer.wire_payout_id); } catch (e) { /* ignore */ }
    }

    await pool.query(`UPDATE bank_transfers SET status = 'cancelled', updated_at = NOW() WHERE transfer_id = $1`, [transferId]);
    return this.getBankTransfer(transferId);
  }

  static async reconcileWithLili(bankAccountId) {
    loadDeps();
    if (!LiliMcpEngine) throw new Error('Lili MCP not available');
    const acct = bankAccountId ? await this.getBankAccount(bankAccountId) : null;
    const summary = await LiliMcpEngine.getAccountSummary();
    return {
      liliAccount: summary,
      localBankAccount: acct,
      note: 'Compare lili availableBalanceUsd to local linked cash account',
    };
  }
}

module.exports = { BankTransferEngine };
