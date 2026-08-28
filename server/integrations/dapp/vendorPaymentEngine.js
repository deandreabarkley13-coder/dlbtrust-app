'use strict';

/**
 * Vendor Payments Engine
 *
 * Pay trust bills and vendor invoices in fiat.
 * The sanctioned B2B rail is `melio`: canonical platform → Melio → DB NET MGMT
 * (Lili Bank). Direct wire/ACH/Open Banking rails remain available only when a
 * bank endpoint is explicitly configured.
 */

const pool = require('../bonds/pgPool');
const { PaymentComplianceGate } = require('../compliance/paymentComplianceGate');
const { getClient: getMelioClient } = require('../melio/melioClient');

let BankTransferEngine, OpenBankingEngine, WireOriginationEngine;
function loadDeps() {
  try { ({ BankTransferEngine } = require('./bankTransferEngine')); } catch (e) { BankTransferEngine = null; }
  try { ({ OpenBankingEngine } = require('./openBankingEngine')); } catch (e) { OpenBankingEngine = null; }
  try { ({ WireOriginationEngine } = require('./wireOriginationEngine')); } catch (e) { WireOriginationEngine = null; }
}

function generateId(prefix = 'VENDOR') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

class VendorPaymentEngine {
  static async ensureTables() {
    loadDeps();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vendor_payees (
        vendor_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        account_number TEXT,
        routing_number TEXT,
        bank_name TEXT,
        account_type TEXT DEFAULT 'checking' CHECK (account_type IN ('checking','savings')),
        country TEXT DEFAULT 'US',
        address JSONB DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vendor_bills (
        bill_id TEXT PRIMARY KEY,
        vendor_id TEXT NOT NULL REFERENCES vendor_payees(vendor_id),
        amount_cents BIGINT NOT NULL,
        currency TEXT DEFAULT 'USD',
        due_date DATE,
        memo TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','cancelled','failed')),
        payment_id TEXT,
        transfer_id TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vendor_payment_runs (
        run_id TEXT PRIMARY KEY,
        bill_id TEXT NOT NULL REFERENCES vendor_bills(bill_id),
        vendor_id TEXT NOT NULL REFERENCES vendor_payees(vendor_id),
        amount_cents BIGINT NOT NULL,
        currency TEXT DEFAULT 'USD',
        rail TEXT NOT NULL DEFAULT 'melio' CHECK (rail IN ('melio','bank_transfer','wire','ach','open_banking','web_payment')),
        source_cash_account_id TEXT,
        transfer_id TEXT,
        payment_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','initiated','completed','failed','cancelled')),
        memo TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vendor_bills_status ON vendor_bills(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vendor_payment_runs_status ON vendor_payment_runs(status)`);
    await pool.query('ALTER TABLE vendor_bills ADD COLUMN IF NOT EXISTS compliance_screening_id TEXT');
    await pool.query('ALTER TABLE vendor_payment_runs ADD COLUMN IF NOT EXISTS compliance_screening_id TEXT');
    // Allow the Melio rail on databases created before it existed.
    await pool.query('ALTER TABLE vendor_payment_runs DROP CONSTRAINT IF EXISTS vendor_payment_runs_rail_check');
    await pool.query(`ALTER TABLE vendor_payment_runs ADD CONSTRAINT vendor_payment_runs_rail_check
      CHECK (rail IN ('melio','bank_transfer','wire','ach','open_banking','web_payment'))`);
  }

  static async createVendor({ name, email, phone, accountNumber, routingNumber, bankName, accountType = 'checking', country = 'US', address, metadata } = {}) {
    if (!name) throw new Error('name required');
    await this.ensureTables();
    const vendorId = generateId('VENDOR');
    const result = await pool.query(
      `INSERT INTO vendor_payees (vendor_id, name, email, phone, account_number, routing_number, bank_name, account_type, country, address, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [vendorId, name, email || null, phone || null, accountNumber || null, routingNumber || null, bankName || null, accountType, country, JSON.stringify(address || {}), JSON.stringify(metadata || {})]
    );
    return result.rows[0];
  }

  static async listVendors({ status, limit = 100 } = {}) {
    await this.ensureTables();
    const conditions = [];
    const params = [];
    if (status) { conditions.push(`status = $${params.length + 1}`); params.push(status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const result = await pool.query(`SELECT * FROM vendor_payees ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return result.rows;
  }

  static async getVendor(vendorId) {
    await this.ensureTables();
    const result = await pool.query(`SELECT * FROM vendor_payees WHERE vendor_id = $1`, [vendorId]);
    return result.rows[0] || null;
  }

  static async createBill({ vendorId, amount, dueDate, memo, metadata } = {}) {
    if (!vendorId) throw new Error('vendorId required');
    const cents = toCents(amount);
    if (cents <= 0) throw new Error('amount must be positive');
    const vendor = await this.getVendor(vendorId);
    if (!vendor) throw new Error(`Vendor not found: ${vendorId}`);
    const billId = generateId('BILL');
    const result = await pool.query(
      `INSERT INTO vendor_bills (bill_id, vendor_id, amount_cents, due_date, memo, metadata)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [billId, vendorId, cents, dueDate || null, memo || null, JSON.stringify(metadata || {})]
    );
    return result.rows[0];
  }

  static async listBills({ vendorId, status, limit = 100 } = {}) {
    await this.ensureTables();
    const conditions = [];
    const params = [];
    if (vendorId) { conditions.push(`vendor_id = $${params.length + 1}`); params.push(vendorId); }
    if (status) { conditions.push(`status = $${params.length + 1}`); params.push(status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const result = await pool.query(`SELECT * FROM vendor_bills ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return result.rows;
  }

  static async getBill(billId) {
    await this.ensureTables();
    const result = await pool.query('SELECT * FROM vendor_bills WHERE bill_id = $1', [billId]);
    return result.rows[0] || null;
  }

  static async _assertConsensusApproval(billId, consensusProposalId) {
    if (!consensusProposalId) {
      throw new Error('Vendor bill payment requires an approved maker-checker proposal');
    }
    const result = await pool.query(
      `SELECT category, status, payload, approvals
       FROM canonical_proposals
       WHERE id = $1`,
      [consensusProposalId]
    );
    const proposal = result.rows[0];
    if (!proposal || proposal.category !== 'vendor_bill' || proposal.status !== 'approved') {
      throw new Error('Vendor bill payment requires an approved maker-checker proposal');
    }
    const payload = typeof proposal.payload === 'string'
      ? JSON.parse(proposal.payload || '{}')
      : (proposal.payload || {});
    if (String(payload.vendorPaymentBillId || '') !== String(billId)) {
      throw new Error('Maker-checker proposal does not authorize this vendor bill');
    }
    const approvals = Array.isArray(proposal.approvals)
      ? proposal.approvals
      : JSON.parse(proposal.approvals || '[]');
    const roles = new Set(
      approvals
        .filter((approval) => approval.status === 'approved')
        .map((approval) => String(approval.role || '').toLowerCase())
    );
    if (!roles.has('maker') || !roles.has('checker')) {
      throw new Error('Vendor bill payment requires maker and checker approvals');
    }
  }

  static async payBill({ billId, consensusProposalId, sourceCashAccountId, rail = 'melio', webPaymentAdapter = 'generic', openBankingConnector = 'generic_rest', memo, initiatedBy = 'system' } = {}) {
    if (!billId) throw new Error('billId required');
    await this.ensureTables();
    await this._assertConsensusApproval(billId, consensusProposalId);
    const billRes = await pool.query(`SELECT * FROM vendor_bills WHERE bill_id = $1`, [billId]);
    const bill = billRes.rows[0];
    if (!bill) throw new Error(`Bill not found: ${billId}`);
    if (bill.status === 'paid') throw new Error('Bill already paid');
    if (bill.status === 'cancelled') throw new Error('Bill cancelled');
    const vendor = await this.getVendor(bill.vendor_id);
    if (!vendor) throw new Error(`Vendor not found: ${bill.vendor_id}`);

    const compliance = await PaymentComplianceGate.screenVendorPayment({
      vendor,
      amount: bill.amount_cents / 100,
      sourceAccountId: sourceCashAccountId,
      rail,
      action: 'execute',
      screenedBy: initiatedBy,
      reference: billId,
    });

    const runId = generateId('VPAY');
    let transfer = null;
    let payment = null;
    let status = 'pending';

    if (rail === 'melio') {
      // Platform → Melio → vendor's bank (DB NET MGMT / Lili Bank). Melio is the
      // payment processor: we hand it the bill and it moves the money.
      payment = await this._payViaMelio({ bill, vendor, runId, memo });
      status = payment.status === 'completed' ? 'completed' : 'initiated';
    } else if (rail === 'bank_transfer' && BankTransferEngine) {
      // Create a bank account record for the vendor
      const bankAccount = await BankTransferEngine.createBankAccount({
        name: vendor.name,
        bankName: vendor.bank_name,
        routingNumber: vendor.routing_number,
        accountNumber: vendor.account_number,
        accountType: vendor.account_type,
        country: vendor.country,
      });
      transfer = await BankTransferEngine.pushCredit({
        sourceCashAccountId,
        destinationBankAccountId: bankAccount.account_id,
        amount: bill.amount_cents / 100,
        rail: 'wire',
        memo: memo || bill.memo || `Vendor payment ${runId}`,
        initiatedBy,
      });
      status = transfer.status === 'completed' ? 'completed' : 'initiated';
    } else if (rail === 'wire' && WireOriginationEngine) {
      transfer = await WireOriginationEngine.createPayout({
        sourceType: 'cash',
        sourceAccountId: sourceCashAccountId,
        amount: bill.amount_cents / 100,
        beneficiaryName: vendor.name,
        beneficiaryRouting: vendor.routing_number,
        beneficiaryAccount: vendor.account_number,
        beneficiaryBankName: vendor.bank_name,
        description: memo || bill.memo || `Vendor payment ${runId}`,
        initiatedBy,
      });
      status = transfer.status || 'initiated';
    } else if ((rail === 'open_banking' || rail === 'ach' || rail === 'web_payment') && OpenBankingEngine) {
      payment = await OpenBankingEngine.createPayment({
        connector: openBankingConnector,
        sourceCashAccountId,
        amount: bill.amount_cents / 100,
        creditorName: vendor.name,
        creditorAccount: vendor.account_number,
        creditorRouting: vendor.routing_number,
        remittance: memo || bill.memo || `Vendor payment ${runId}`,
      });
      status = payment.status === 'originated' ? 'initiated' : (payment.status || 'pending');
    } else {
      throw new Error(`Unsupported or unavailable rail: ${rail}`);
    }

    await pool.query(
      `INSERT INTO vendor_payment_runs (run_id, bill_id, vendor_id, amount_cents, rail, source_cash_account_id, transfer_id, payment_id, status, memo, metadata, compliance_screening_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [runId, billId, bill.vendor_id, bill.amount_cents, rail, sourceCashAccountId || null, transfer ? (transfer.transfer_id || transfer.payout_id) : null, payment ? payment.paymentId : null, status, memo || bill.memo || `Vendor payment ${runId}`, JSON.stringify({ vendor, transfer, payment, compliance }), compliance.screeningId]
    );

    await pool.query(`UPDATE vendor_bills SET status = $1, payment_id = $2, transfer_id = $3, compliance_screening_id = $4, updated_at = NOW() WHERE bill_id = $5`,
      [status === 'completed' ? 'paid' : (status === 'failed' ? 'failed' : 'pending'), payment ? payment.paymentId : null, transfer ? (transfer.transfer_id || transfer.payout_id) : null, compliance.screeningId, billId]);

    return { runId, billId, status, transfer, payment, compliance };
  }

  /**
   * Hand a vendor bill to Melio for processing. Returns a payment shape
   * compatible with the other rails ({ paymentId, status, ... }).
   */
  static async _payViaMelio({ bill, vendor, runId, memo }) {
    const melio = getMelioClient();
    const melioVendorId = (vendor.metadata && vendor.metadata.melio_vendor_id)
      || (await melio.createVendor({
        name: vendor.name,
        email: vendor.email || undefined,
        bank_account: {
          account_number: vendor.account_number,
          routing_number: vendor.routing_number,
          account_type: vendor.account_type,
          bank_name: vendor.bank_name,
        },
      })).id;
    const melioBill = await melio.createBill({
      vendor_id: melioVendorId,
      amount: bill.amount_cents / 100,
      currency: bill.currency || 'USD',
      due_date: bill.due_date || undefined,
      description: memo || bill.memo || `Vendor payment ${runId}`,
    });
    const scheduled = await melio.schedulePayment({
      bill_id: melioBill.id,
      vendor_id: melioVendorId,
      amount: bill.amount_cents / 100,
      delivery_method: 'ach',
    });
    return {
      paymentId: scheduled.id,
      status: scheduled.status === 'completed' ? 'completed' : 'initiated',
      provider: 'melio',
      shadow: !!melio.shadow,
      melio_vendor_id: melioVendorId,
      melio_bill_id: melioBill.id,
      estimated_arrival: scheduled.estimated_arrival || null,
    };
  }

  static async listPaymentRuns({ billId, vendorId, status, limit = 100 } = {}) {
    await this.ensureTables();
    const conditions = [];
    const params = [];
    if (billId) { conditions.push(`bill_id = $${params.length + 1}`); params.push(billId); }
    if (vendorId) { conditions.push(`vendor_id = $${params.length + 1}`); params.push(vendorId); }
    if (status) { conditions.push(`status = $${params.length + 1}`); params.push(status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const result = await pool.query(`SELECT * FROM vendor_payment_runs ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return result.rows;
  }
}

module.exports = { VendorPaymentEngine };
