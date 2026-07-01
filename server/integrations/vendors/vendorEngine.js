'use strict';

/**
 * Vendor Payment Engine — DLB Trust Platform
 *
 * Manages vendor registry and payment lifecycle:
 *  - Vendor CRUD with bank details (routing, account, payment preference)
 *  - Payment initiation from client sub-ledger or trust GL accounts
 *  - Approval workflow (pending → approved → executed → settled)
 *  - Payment execution via ACH, Wire, or BILL
 *  - Auto-post double-entry journal entries (DR Expense / CR Cash)
 *  - Cashflow event recording
 *  - Full audit trail
 */

const pool = require('../bonds/pgPool');
const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');
let ACHEngine, WireEngine, billClient;
try { ACHEngine = require('../ach/achEngine').ACHEngine; } catch (e) { ACHEngine = null; }
try { WireEngine = require('../wire/wireEngine').WireEngine; } catch (e) { WireEngine = null; }
try { billClient = require('../bill/billClient'); } catch (e) { billClient = null; }

const PAYMENT_STATUSES = ['pending_approval', 'approved', 'rejected', 'processing', 'executed', 'settled', 'failed', 'cancelled'];
const PAYMENT_METHODS = ['ach', 'wire', 'bill', 'auto'];

const ACCOUNT_CODES = {
  CASH: '1000',
  BILL_CASH: '1050',
  EXPENSES: '5200',
  DISTRIBUTIONS: '5100',
  FEES_PAYABLE: '2100',
  VENDOR_PAYABLE: '2000',
};

class VendorEngine {

  // ═══════════════════════════════════════════════════════════════════════════
  //  TABLE SETUP
  // ═══════════════════════════════════════════════════════════════════════════

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vendors (
        id                  SERIAL PRIMARY KEY,
        vendor_id           TEXT UNIQUE NOT NULL,
        vendor_name         TEXT NOT NULL,
        vendor_type         TEXT NOT NULL DEFAULT 'general'
                              CHECK (vendor_type IN ('general','legal','accounting','custodian',
                                'broker','consultant','technology','insurance','regulatory','other')),
        contact_name        TEXT,
        contact_email       TEXT,
        contact_phone       TEXT,
        address             TEXT,
        tax_id              TEXT,
        -- Bank details
        bank_name           TEXT,
        routing_number      TEXT,
        account_number      TEXT,
        account_type        TEXT DEFAULT 'checking'
                              CHECK (account_type IN ('checking','savings')),
        -- BILL integration
        bill_vendor_id      TEXT,
        -- Payment preferences
        payment_method      TEXT NOT NULL DEFAULT 'ach'
                              CHECK (payment_method IN ('ach','wire','bill','auto')),
        payment_terms       TEXT DEFAULT 'net_30'
                              CHECK (payment_terms IN ('immediate','net_15','net_30','net_60','net_90')),
        -- Status
        status              TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','inactive','suspended')),
        approved_by         TEXT,
        approved_at         TIMESTAMPTZ,
        notes               TEXT,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        updated_at          TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS vendor_payments (
        id                  SERIAL PRIMARY KEY,
        payment_id          TEXT UNIQUE NOT NULL,
        vendor_id           TEXT NOT NULL,
        -- Source account
        source_type         TEXT NOT NULL DEFAULT 'trust'
                              CHECK (source_type IN ('trust','sub_ledger')),
        source_account_code TEXT NOT NULL DEFAULT '1000',
        sub_ledger_id       TEXT,
        -- Payment details
        amount              NUMERIC(18,2) NOT NULL,
        currency            TEXT NOT NULL DEFAULT 'USD',
        payment_method      TEXT NOT NULL DEFAULT 'ach'
                              CHECK (payment_method IN ('ach','wire','bill')),
        payment_type        TEXT NOT NULL DEFAULT 'vendor_payment'
                              CHECK (payment_type IN ('vendor_payment','fee_payment','legal_fee',
                                'insurance_premium','regulatory_fee','trust_expense','other')),
        description         TEXT,
        invoice_number      TEXT,
        invoice_date        DATE,
        due_date            DATE,
        -- Status & approval
        status              TEXT NOT NULL DEFAULT 'pending_approval'
                              CHECK (status IN ('pending_approval','approved','rejected','processing',
                                'executed','settled','failed','cancelled')),
        initiated_by        TEXT NOT NULL DEFAULT 'system',
        approved_by         TEXT,
        rejected_by         TEXT,
        rejection_reason    TEXT,
        -- Execution references
        ach_batch_id        TEXT,
        wire_id             TEXT,
        bill_payment_id     TEXT,
        journal_entry_id    TEXT,
        -- Timestamps
        approved_at         TIMESTAMPTZ,
        rejected_at         TIMESTAMPTZ,
        executed_at         TIMESTAMPTZ,
        settled_at          TIMESTAMPTZ,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        updated_at          TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_vp_vendor ON vendor_payments(vendor_id);
      CREATE INDEX IF NOT EXISTS idx_vp_status ON vendor_payments(status);
    `);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  VENDOR CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  static generateVendorId() {
    const seq = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `VND-${seq}`;
  }

  static async createVendor(data) {
    const vendorId = VendorEngine.generateVendorId();
    const res = await pool.query(`
      INSERT INTO vendors (vendor_id, vendor_name, vendor_type, contact_name, contact_email,
        contact_phone, address, tax_id, bank_name, routing_number, account_number,
        account_type, bill_vendor_id, payment_method, payment_terms, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *
    `, [
      vendorId, data.vendor_name, data.vendor_type || 'general',
      data.contact_name || null, data.contact_email || null, data.contact_phone || null,
      data.address || null, data.tax_id || null,
      data.bank_name || null, data.routing_number || null, data.account_number || null,
      data.account_type || 'checking', data.bill_vendor_id || null,
      data.payment_method || 'ach', data.payment_terms || 'net_30',
      data.notes || null,
    ]);
    return res.rows[0];
  }

  static async listVendors(filters = {}) {
    let where = ['1=1'];
    let params = [];
    let idx = 1;
    if (filters.status) { where.push(`status = $${idx++}`); params.push(filters.status); }
    if (filters.vendor_type) { where.push(`vendor_type = $${idx++}`); params.push(filters.vendor_type); }
    if (filters.search) { where.push(`(vendor_name ILIKE $${idx} OR contact_name ILIKE $${idx})`); params.push(`%${filters.search}%`); idx++; }
    const res = await pool.query(
      `SELECT * FROM vendors WHERE ${where.join(' AND ')} ORDER BY vendor_name`, params
    );
    return res.rows;
  }

  static async getVendor(vendorId) {
    const res = await pool.query(`SELECT * FROM vendors WHERE vendor_id = $1`, [vendorId]);
    return res.rows[0] || null;
  }

  static async updateVendor(vendorId, data) {
    const fields = [];
    const params = [vendorId];
    let idx = 2;
    const allowed = ['vendor_name','vendor_type','contact_name','contact_email','contact_phone',
      'address','tax_id','bank_name','routing_number','account_number','account_type',
      'bill_vendor_id','payment_method','payment_terms','status','notes'];
    for (const key of allowed) {
      if (data[key] !== undefined) { fields.push(`${key} = $${idx++}`); params.push(data[key]); }
    }
    if (fields.length === 0) return VendorEngine.getVendor(vendorId);
    fields.push(`updated_at = NOW()`);
    const res = await pool.query(
      `UPDATE vendors SET ${fields.join(', ')} WHERE vendor_id = $1 RETURNING *`, params
    );
    return res.rows[0];
  }

  static async deleteVendor(vendorId) {
    const res = await pool.query(`DELETE FROM vendors WHERE vendor_id = $1 RETURNING vendor_id`, [vendorId]);
    return res.rowCount > 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  VENDOR DASHBOARD
  // ═══════════════════════════════════════════════════════════════════════════

  static async getDashboard() {
    const [vendorCount, paymentStats, recentPayments, pendingApprovals] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total,
        COUNT(CASE WHEN status = 'active' THEN 1 END) as active
        FROM vendors`),
      pool.query(`SELECT
        COUNT(*) as total_payments,
        COALESCE(SUM(CASE WHEN status = 'executed' OR status = 'settled' THEN amount ELSE 0 END), 0) as total_paid,
        COALESCE(SUM(CASE WHEN status = 'pending_approval' THEN amount ELSE 0 END), 0) as pending_amount,
        COUNT(CASE WHEN status = 'pending_approval' THEN 1 END) as pending_count
        FROM vendor_payments`),
      pool.query(`SELECT vp.*, v.vendor_name FROM vendor_payments vp
        LEFT JOIN vendors v ON v.vendor_id = vp.vendor_id
        ORDER BY vp.created_at DESC LIMIT 10`),
      pool.query(`SELECT vp.*, v.vendor_name FROM vendor_payments vp
        LEFT JOIN vendors v ON v.vendor_id = vp.vendor_id
        WHERE vp.status = 'pending_approval'
        ORDER BY vp.created_at ASC`),
    ]);

    return {
      vendors: {
        total: parseInt(vendorCount.rows[0].total),
        active: parseInt(vendorCount.rows[0].active),
      },
      payments: {
        total: parseInt(paymentStats.rows[0].total_payments),
        total_paid: parseFloat(paymentStats.rows[0].total_paid),
        pending_amount: parseFloat(paymentStats.rows[0].pending_amount),
        pending_count: parseInt(paymentStats.rows[0].pending_count),
      },
      recent_payments: recentPayments.rows,
      pending_approvals: pendingApprovals.rows,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PAYMENT INITIATION
  // ═══════════════════════════════════════════════════════════════════════════

  static generatePaymentId() {
    const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const seq = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `VPAY-${date}-${seq}`;
  }

  static async initiatePayment(data) {
    const vendor = await VendorEngine.getVendor(data.vendor_id);
    if (!vendor) throw new Error('Vendor not found: ' + data.vendor_id);
    if (vendor.status !== 'active') throw new Error('Vendor is not active');

    const method = data.payment_method || vendor.payment_method || 'ach';
    if (method === 'ach' && (!vendor.routing_number || !vendor.account_number)) {
      throw new Error('Vendor has no bank details for ACH payment');
    }
    if (method === 'wire' && (!vendor.routing_number || !vendor.account_number)) {
      throw new Error('Vendor has no bank details for wire payment');
    }

    const paymentId = VendorEngine.generatePaymentId();
    const res = await pool.query(`
      INSERT INTO vendor_payments (payment_id, vendor_id, source_type, source_account_code,
        sub_ledger_id, amount, payment_method, payment_type, description,
        invoice_number, invoice_date, due_date, initiated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
    `, [
      paymentId, data.vendor_id,
      data.source_type || 'trust', data.source_account_code || ACCOUNT_CODES.CASH,
      data.sub_ledger_id || null, data.amount,
      method, data.payment_type || 'vendor_payment',
      data.description || `Payment to ${vendor.vendor_name}`,
      data.invoice_number || null, data.invoice_date || null, data.due_date || null,
      data.initiated_by || 'admin',
    ]);

    return { payment: res.rows[0], vendor_name: vendor.vendor_name };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PAYMENT APPROVAL
  // ═══════════════════════════════════════════════════════════════════════════

  static async approvePayment(paymentId, approvedBy) {
    const res = await pool.query(`
      UPDATE vendor_payments SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW()
      WHERE payment_id = $1 AND status = 'pending_approval' RETURNING *
    `, [paymentId, approvedBy || 'admin']);
    if (res.rowCount === 0) throw new Error('Payment not found or not pending approval');
    return res.rows[0];
  }

  static async rejectPayment(paymentId, rejectedBy, reason) {
    const res = await pool.query(`
      UPDATE vendor_payments SET status = 'rejected', rejected_by = $2, rejection_reason = $3,
        rejected_at = NOW(), updated_at = NOW()
      WHERE payment_id = $1 AND status = 'pending_approval' RETURNING *
    `, [paymentId, rejectedBy || 'admin', reason || '']);
    if (res.rowCount === 0) throw new Error('Payment not found or not pending approval');
    return res.rows[0];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PAYMENT EXECUTION
  // ═══════════════════════════════════════════════════════════════════════════

  static async executePayment(paymentId, executedBy) {
    // Fetch payment + vendor
    const payRes = await pool.query(`SELECT * FROM vendor_payments WHERE payment_id = $1`, [paymentId]);
    if (payRes.rowCount === 0) throw new Error('Payment not found');
    const payment = payRes.rows[0];
    if (payment.status !== 'approved') throw new Error('Payment must be approved before execution');

    const vendor = await VendorEngine.getVendor(payment.vendor_id);
    if (!vendor) throw new Error('Vendor not found');

    // Mark as processing
    await pool.query(`UPDATE vendor_payments SET status = 'processing', updated_at = NOW() WHERE payment_id = $1`, [paymentId]);

    let executionRef = {};

    try {
      // Execute based on method
      switch (payment.payment_method) {
        case 'ach':
          executionRef = await VendorEngine._executeACH(payment, vendor);
          break;
        case 'wire':
          executionRef = await VendorEngine._executeWire(payment, vendor);
          break;
        case 'bill':
          executionRef = await VendorEngine._executeBILL(payment, vendor);
          break;
        default:
          throw new Error('Unknown payment method: ' + payment.payment_method);
      }

      // Post journal entry: DR Expense / CR Cash
      let journalEntry = null;
      try {
        const creditAccount = payment.payment_method === 'bill' ? ACCOUNT_CODES.BILL_CASH : ACCOUNT_CODES.CASH;
        const debitAccount = payment.payment_type === 'fee_payment' ? ACCOUNT_CODES.FEES_PAYABLE
          : payment.payment_type === 'trust_expense' ? ACCOUNT_CODES.EXPENSES
          : ACCOUNT_CODES.EXPENSES;

        journalEntry = await TrustAccountingEngine.postJournalEntry({
          entryDate: new Date(),
          description: `Vendor payment: ${vendor.vendor_name} — ${payment.description || payment.payment_type}`,
          lines: [
            { accountCode: debitAccount, debitAmount: parseFloat(payment.amount), creditAmount: 0,
              memo: `${payment.payment_method.toUpperCase()} to ${vendor.vendor_name} (${paymentId})` },
            { accountCode: creditAccount, debitAmount: 0, creditAmount: parseFloat(payment.amount),
              memo: `Vendor payment outflow: ${paymentId}` },
          ],
          referenceType: 'vendor_payment',
          referenceId: paymentId,
          postedBy: executedBy || 'system',
        });
      } catch (err) {
        console.warn('[VendorEngine] Journal entry failed:', err.message);
      }

      // Record cashflow event
      try {
        await pool.query(`
          INSERT INTO cashflow_events (event_type, category, amount, direction, description, event_date, created_at)
          VALUES ('vendor_payment', 'operating', $1, 'outflow', $2, NOW(), NOW())
        `, [parseFloat(payment.amount), `Vendor: ${vendor.vendor_name} — ${payment.description || paymentId}`]);
      } catch (err) {
        console.warn('[VendorEngine] Cashflow event failed:', err.message);
      }

      // Mark as executed
      await pool.query(`
        UPDATE vendor_payments SET status = 'executed', executed_at = NOW(), updated_at = NOW(),
          ach_batch_id = $2, wire_id = $3, bill_payment_id = $4, journal_entry_id = $5
        WHERE payment_id = $1
      `, [
        paymentId,
        executionRef.ach_batch_id || null,
        executionRef.wire_id || null,
        executionRef.bill_payment_id || null,
        journalEntry ? (journalEntry.entry_id || journalEntry.id || null) : null,
      ]);

      return {
        payment_id: paymentId,
        status: 'executed',
        method: payment.payment_method,
        amount: parseFloat(payment.amount),
        vendor: vendor.vendor_name,
        ...executionRef,
        journal_entry: journalEntry ? (journalEntry.entry_id || journalEntry.id) : null,
      };

    } catch (err) {
      await pool.query(`
        UPDATE vendor_payments SET status = 'failed', updated_at = NOW() WHERE payment_id = $1
      `, [paymentId]);
      throw err;
    }
  }

  // ─── ACH Execution ───────────────────────────────────────────────────────

  static async _executeACH(payment, vendor) {
    if (!ACHEngine) throw new Error('ACH Engine not available');

    const batch = await ACHEngine.createBatch(
      {
        effectiveDate: new Date().toISOString().split('T')[0],
        secCode: 'CCD',
        description: `VENDOR ${vendor.vendor_name.slice(0, 10).toUpperCase()}`,
        createdBy: payment.initiated_by,
      },
      [{
        receivingRouting: vendor.routing_number,
        receivingAccount: vendor.account_number,
        receivingName: vendor.vendor_name,
        amountCents: Math.round(parseFloat(payment.amount) * 100),
        transactionCode: vendor.account_type === 'savings' ? '32' : '22',
        identification: payment.payment_id,
        discretionaryData: payment.invoice_number || '',
      }]
    );

    return { ach_batch_id: batch.batch_id };
  }

  // ─── Wire Execution ──────────────────────────────────────────────────────

  static async _executeWire(payment, vendor) {
    if (!WireEngine) throw new Error('Wire Engine not available');

    const wire = await WireEngine.initiateWire({
      amountCents: Math.round(parseFloat(payment.amount) * 100),
      beneficiaryName: vendor.vendor_name,
      beneficiaryRouting: vendor.routing_number,
      beneficiaryAccount: vendor.account_number,
      beneficiaryBankName: vendor.bank_name || '',
      purpose: `Vendor payment: ${payment.description || payment.payment_type}`,
      description: `${payment.payment_id} — ${vendor.vendor_name}`,
      paymentType: 'vendor_payment',
      wireType: 'funds_transfer',
      initiatedBy: payment.initiated_by,
      requiresApproval: false,
      skipJournalEntry: true,
    });

    return { wire_id: wire.wire_id };
  }

  // ─── BILL Execution ──────────────────────────────────────────────────────

  static async _executeBILL(payment, vendor) {
    if (!billClient) throw new Error('BILL client not available');

    const result = await billClient.recordPayment({
      amount: parseFloat(payment.amount),
      description: `Vendor: ${vendor.vendor_name} — ${payment.description || payment.payment_id}`,
      vendorId: vendor.bill_vendor_id || vendor.vendor_id,
    });

    return { bill_payment_id: result.receivedPayId || result.id || 'recorded' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PAYMENT QUERIES
  // ═══════════════════════════════════════════════════════════════════════════

  static async listPayments(filters = {}) {
    let where = ['1=1'];
    let params = [];
    let idx = 1;
    if (filters.vendor_id) { where.push(`vp.vendor_id = $${idx++}`); params.push(filters.vendor_id); }
    if (filters.status) { where.push(`vp.status = $${idx++}`); params.push(filters.status); }
    if (filters.payment_method) { where.push(`vp.payment_method = $${idx++}`); params.push(filters.payment_method); }
    const res = await pool.query(`
      SELECT vp.*, v.vendor_name, v.vendor_type FROM vendor_payments vp
      LEFT JOIN vendors v ON v.vendor_id = vp.vendor_id
      WHERE ${where.join(' AND ')}
      ORDER BY vp.created_at DESC
      LIMIT ${parseInt(filters.limit) || 50}
    `, params);
    return res.rows;
  }

  static async getPayment(paymentId) {
    const res = await pool.query(`
      SELECT vp.*, v.vendor_name, v.vendor_type, v.bank_name, v.routing_number, v.account_number
      FROM vendor_payments vp LEFT JOIN vendors v ON v.vendor_id = vp.vendor_id
      WHERE vp.payment_id = $1
    `, [paymentId]);
    return res.rows[0] || null;
  }
}

module.exports = { VendorEngine };
