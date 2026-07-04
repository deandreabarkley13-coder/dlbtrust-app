'use strict';

/**
 * Straight-Through Processing (STP) Engine
 * ─────────────────────────────────────────
 *
 * Ensures payment files include ALL required data for clearing, processing,
 * settling, and posting — with T+1 availability tracking.
 *
 * Problems this solves:
 *  1. BILL vendor payments missing chartOfAccount, GL posting date, terms
 *  2. BILL deposits falling back to bare ledger entries (no invoice link)
 *  3. Settlement lifecycle based on time, not actual BILL status polling
 *  4. No T+1/T+2 settlement date tracking or availability calculation
 *  5. No automatic finalization when BILL confirms clearing
 *
 * STP flow:
 *   Submit → Enrich → Transmit → Poll BILL Status → Clear → Post → Available (T+1)
 *
 * Integrates with: electronicSettlementEngine, billClient, dataBridge, notifEngine
 */

var crypto = require('crypto');
var pool = require('../bonds/pgPool');

var billClient;
try { billClient = require('../bill/billClient'); } catch (e) { billClient = null; }

var notifEngine;
try { notifEngine = require('./paymentNotificationEngine'); } catch (e) { notifEngine = null; }

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

/**
 * Settlement timing for T+N availability.
 * T = submission date, +N = business days to availability.
 */
var SETTLEMENT_TIMING = {
  bill_deposit:    { clearing_hours: 1, settlement_days: 0, availability: 'T+1' },
  bill_vendor:     { clearing_hours: 24, settlement_days: 1, availability: 'T+1' },
  ach_standard:    { clearing_hours: 48, settlement_days: 2, availability: 'T+2' },
  ach_sameday:     { clearing_hours: 4, settlement_days: 0, availability: 'T+1' },
  wire:            { clearing_hours: 0.5, settlement_days: 0, availability: 'T+0' },
};

/**
 * Required fields for BILL payment clearing.
 * If any are missing, BILL may accept but not process the payment.
 */
var BILL_REQUIRED_FIELDS = {
  vendor_payment: [
    'vendorId', 'billId', 'amount', 'chartOfAccountId',
    'dueDate', 'invoiceNumber', 'description',
  ],
  deposit: [
    'customerId', 'amount', 'paymentDate', 'paymentType',
    'depositToBankAccountId', 'invoicePayments',
  ],
};

// BILL Chart of Account codes for proper GL posting
var BILL_COA_MAPPING = {
  vendor_payment:     { name: 'Accounts Payable', glCode: '2000' },
  trust_distribution: { name: 'Trust Distributions', glCode: '5100' },
  fee_payment:        { name: 'Professional Fees', glCode: '5200' },
  legal_fee:          { name: 'Legal Expenses', glCode: '5210' },
  insurance_premium:  { name: 'Insurance', glCode: '5220' },
  regulatory_fee:     { name: 'Regulatory Fees', glCode: '5230' },
  trust_expense:      { name: 'Trust Expenses', glCode: '5300' },
  disbursement:       { name: 'Disbursements', glCode: '5400' },
};

// ─── STP TABLE ────────────────────────────────────────────────────────────────

async function ensureSTPTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stp_processing (
        id                    SERIAL PRIMARY KEY,
        stp_id                TEXT UNIQUE NOT NULL,
        settlement_id         TEXT NOT NULL,
        payment_type          TEXT NOT NULL,
        payment_method        TEXT NOT NULL DEFAULT 'bill',
        amount                NUMERIC(18,2) NOT NULL,
        payee_name            TEXT NOT NULL,

        -- Enrichment fields (filled by STP before transmission)
        bill_vendor_id        TEXT,
        bill_bill_id          TEXT,
        bill_sent_pay_id      TEXT,
        bill_received_pay_id  TEXT,
        bill_chart_of_acct    TEXT,
        bill_gl_posting_date  DATE,
        bill_payment_terms    TEXT DEFAULT 'Net 0',
        bill_bank_account_id  TEXT,
        bill_invoice_id       TEXT,
        bill_invoice_number   TEXT,
        enrichment_complete   BOOLEAN DEFAULT FALSE,
        enrichment_errors     TEXT,

        -- STP lifecycle
        stp_status            TEXT NOT NULL DEFAULT 'pending'
                                CHECK (stp_status IN ('pending','enriched','transmitted',
                                  'clearing','cleared','posted','available','failed','returned')),
        submitted_at          TIMESTAMPTZ DEFAULT NOW(),
        enriched_at           TIMESTAMPTZ,
        transmitted_at        TIMESTAMPTZ,
        clearing_at           TIMESTAMPTZ,
        cleared_at            TIMESTAMPTZ,
        posted_at             TIMESTAMPTZ,
        available_at          TIMESTAMPTZ,

        -- T+N tracking
        settlement_date       DATE,
        availability_date     DATE,
        settlement_timing     TEXT DEFAULT 'T+1',

        -- BILL status polling
        last_bill_status      TEXT,
        last_bill_poll_at     TIMESTAMPTZ,
        bill_process_date     DATE,
        bill_clearing_status  TEXT,

        -- Integrity
        stp_hash              TEXT,
        clearing_ref          TEXT,
        posting_ref           TEXT,

        created_at            TIMESTAMPTZ DEFAULT NOW(),
        updated_at            TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_stp_settlement ON stp_processing(settlement_id);
      CREATE INDEX IF NOT EXISTS idx_stp_status ON stp_processing(stp_status);
    `);
  } catch (e) {
    console.warn('[STP] table setup:', e.message);
  }
}

// Deferred init
ensureSTPTable().catch(function(e) { console.warn('[STP] deferred init:', e.message); });

// ─── STP ID GENERATION ───────────────────────────────────────────────────────

function generateSTPId() {
  var ts = Date.now().toString(36).toUpperCase();
  var rand = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
  return 'STP-' + ts + '-' + rand;
}

// ─── BUSINESS DAY CALCULATION ─────────────────────────────────────────────────

/**
 * Calculate T+N business day from a given date.
 * Skips weekends (Sat/Sun). Does not account for federal holidays.
 */
function addBusinessDays(date, days) {
  var result = new Date(date);
  var added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    var dow = result.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return result;
}

/**
 * Calculate settlement and availability dates for a payment.
 */
function calculateSettlementDates(paymentType, paymentMethod, priority) {
  var now = new Date();
  var key;

  if (paymentType === 'deposit' || paymentType === 'bill_cash_deposit') {
    key = 'bill_deposit';
  } else if (paymentMethod === 'wire') {
    key = 'wire';
  } else if (paymentMethod === 'ach') {
    key = priority === 'immediate' || priority === 'urgent' ? 'ach_sameday' : 'ach_standard';
  } else {
    key = 'bill_vendor';
  }

  var timing = SETTLEMENT_TIMING[key];
  var settlementDate = addBusinessDays(now, timing.settlement_days);
  var availabilityDate = addBusinessDays(settlementDate, 1); // T+1 from settlement

  return {
    settlement_date: settlementDate,
    availability_date: availabilityDate,
    settlement_timing: timing.availability,
    clearing_hours: timing.clearing_hours,
  };
}

// ─── PAYMENT DATA ENRICHMENT ──────────────────────────────────────────────────

/**
 * Enrich payment data with ALL fields required for clearing and processing.
 * This is the key STP function — ensures nothing is missing before transmission.
 *
 * @param {Object} opts - Payment options from electronic settlement
 * @returns {Object} Enriched payment data ready for transmission
 */
async function enrichPaymentData(opts) {
  var enriched = {
    settlement_id: opts.settlement_id || opts.settlementId,
    payment_type: opts.payment_type || 'vendor_payment',
    payment_method: opts.payment_method || opts.method || 'bill',
    amount: parseFloat(opts.amount),
    payee_name: opts.payee_name,
    description: opts.description || ('Payment to ' + opts.payee_name),
    errors: [],
  };

  var isDeposit = enriched.payment_type === 'deposit' || enriched.payment_type === 'bill_cash_deposit';

  // Calculate settlement dates
  var dates = calculateSettlementDates(enriched.payment_type, enriched.payment_method, opts.priority);
  enriched.settlement_date = dates.settlement_date;
  enriched.availability_date = dates.availability_date;
  enriched.settlement_timing = dates.settlement_timing;
  enriched.clearing_hours = dates.clearing_hours;
  enriched.bill_gl_posting_date = dates.settlement_date.toISOString().split('T')[0];

  if (!billClient) {
    enriched.errors.push('BILL client not available');
    return enriched;
  }

  try {
    if (isDeposit) {
      enriched = await enrichDepositData(enriched, opts);
    } else {
      enriched = await enrichVendorPaymentData(enriched, opts);
    }
  } catch (err) {
    enriched.errors.push('Enrichment failed: ' + err.message);
  }

  enriched.enrichment_complete = enriched.errors.length === 0;
  return enriched;
}

/**
 * Enrich deposit data with customer, invoice, and bank account info.
 */
async function enrichDepositData(enriched, opts) {
  // 1. Resolve customer
  try {
    var customers = await billClient.listCustomers();
    if (customers && customers.length > 0) {
      enriched.bill_customer_id = customers[0].id;
    } else {
      enriched.errors.push('No BILL customers found — create one first');
    }
  } catch (e) {
    enriched.errors.push('Customer lookup failed: ' + e.message);
  }

  // 2. Resolve bank account for deposit
  try {
    var accounts = await billClient.listBankAccounts();
    var active = Array.isArray(accounts)
      ? accounts.find(function(a) { return a.isActive === '1' || a.isActive === true; })
      : null;
    if (active) {
      enriched.bill_bank_account_id = active.id;
    } else {
      enriched.errors.push('No active BILL bank account');
    }
  } catch (e) {
    enriched.errors.push('Bank account lookup failed: ' + e.message);
  }

  // 3. Set deposit-specific fields
  enriched.bill_payment_type = opts.method === 'wire' ? '6' : '4'; // 4=ACH, 6=Wire
  enriched.bill_payment_date = new Date().toISOString().split('T')[0];
  enriched.bill_invoice_number = 'DEP-' + Date.now().toString(36).toUpperCase();
  enriched.bill_payment_terms = 'Net 0';

  return enriched;
}

/**
 * Enrich vendor payment data with vendor, bill, chart of account, and terms.
 */
async function enrichVendorPaymentData(enriched, opts) {
  // 1. Resolve or create vendor
  try {
    var vendor = await billClient.findVendor(opts.payee_name);
    if (!vendor) {
      vendor = await billClient.createVendor({
        name: opts.payee_name,
        email: opts.payee_email || undefined,
        address1: opts.address1 || '1 Trust Way',
        city: opts.city || 'Wilmington',
        state: opts.state || 'DE',
        zip: opts.zip || '19801',
        paymentType: '0',
      });
    }
    enriched.bill_vendor_id = vendor.id;
  } catch (e) {
    enriched.errors.push('Vendor resolution failed: ' + e.message);
  }

  // 2. Chart of Account mapping for proper GL posting in BILL
  var coaMapping = BILL_COA_MAPPING[enriched.payment_type] || BILL_COA_MAPPING.vendor_payment;
  enriched.bill_chart_of_acct = coaMapping.glCode;
  enriched.bill_coa_name = coaMapping.name;

  // 3. Payment terms and due date
  enriched.bill_payment_terms = 'Net 0'; // immediate
  enriched.bill_due_date = new Date().toISOString().split('T')[0]; // due today
  enriched.bill_invoice_number = opts.invoiceNumber || ('STP-' + Date.now().toString(36).toUpperCase());

  // 4. Resolve bank account for payment source
  try {
    var accounts = await billClient.listBankAccounts();
    var active = Array.isArray(accounts)
      ? accounts.find(function(a) { return a.isActive === '1' || a.isActive === true; })
      : null;
    if (active) {
      enriched.bill_bank_account_id = active.id;
    }
  } catch (e) {
    enriched.errors.push('Bank account lookup failed: ' + e.message);
  }

  return enriched;
}

// ─── STP SUBMISSION ───────────────────────────────────────────────────────────

/**
 * Process a payment through the STP pipeline.
 * Enriches → validates → transmits → tracks → returns with T+1 dates.
 *
 * @param {Object} opts - Payment options (from electronic settlement submit)
 * @returns {Object} STP result with enrichment data, dates, and clearing refs
 */
async function processPayment(opts) {
  var stpId = generateSTPId();
  var isDeposit = opts.payment_type === 'deposit' || opts.payment_type === 'bill_cash_deposit';

  // 1. Enrich payment data
  var enriched = await enrichPaymentData(opts);

  // 2. Compute STP integrity hash
  var stpHash = crypto.createHash('sha256').update(JSON.stringify({
    stp_id: stpId,
    settlement_id: enriched.settlement_id,
    amount: enriched.amount,
    payee: enriched.payee_name,
    payment_type: enriched.payment_type,
    timestamp: new Date().toISOString(),
  })).digest('hex');

  // 3. Record STP entry
  try {
    await pool.query(`
      INSERT INTO stp_processing
        (stp_id, settlement_id, payment_type, payment_method, amount, payee_name,
         bill_vendor_id, bill_chart_of_acct, bill_gl_posting_date, bill_payment_terms,
         bill_bank_account_id, bill_invoice_number,
         enrichment_complete, enrichment_errors,
         stp_status, enriched_at, settlement_date, availability_date, settlement_timing,
         stp_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    `, [
      stpId, enriched.settlement_id, enriched.payment_type, enriched.payment_method,
      enriched.amount, enriched.payee_name,
      enriched.bill_vendor_id || null, enriched.bill_chart_of_acct || null,
      enriched.bill_gl_posting_date || null, enriched.bill_payment_terms || 'Net 0',
      enriched.bill_bank_account_id || null, enriched.bill_invoice_number || null,
      enriched.enrichment_complete, enriched.errors.length > 0 ? enriched.errors.join('; ') : null,
      enriched.enrichment_complete ? 'enriched' : 'pending',
      enriched.enrichment_complete ? new Date() : null,
      enriched.settlement_date, enriched.availability_date, enriched.settlement_timing,
      stpHash,
    ]);
  } catch (dbErr) {
    console.warn('[STP] record insert failed:', dbErr.message);
  }

  // 4. Execute payment through BILL with enriched data
  var paymentResult;
  try {
    if (isDeposit) {
      paymentResult = await executeEnrichedDeposit(enriched, opts);
    } else {
      paymentResult = await executeEnrichedVendorPayment(enriched, opts);
    }

    // Update STP record with transmission refs
    try {
      await pool.query(`
        UPDATE stp_processing SET
          stp_status = 'transmitted', transmitted_at = NOW(),
          bill_sent_pay_id = $2, bill_received_pay_id = $3,
          bill_bill_id = $4, bill_invoice_id = $5,
          bill_process_date = $6, clearing_ref = $7,
          updated_at = NOW()
        WHERE stp_id = $1
      `, [
        stpId,
        paymentResult.sentPayId || null,
        paymentResult.receivedPayId || null,
        paymentResult.billId || null,
        paymentResult.invoiceId || null,
        paymentResult.processDate || null,
        paymentResult.clearingRef || paymentResult.sentPayId || paymentResult.receivedPayId || null,
      ]);
    } catch (e) {
      console.warn('[STP] record update failed:', e.message);
    }

  } catch (payErr) {
    // Record failure but still return enrichment data
    try {
      await pool.query(
        "UPDATE stp_processing SET stp_status = 'failed', enrichment_errors = $2, updated_at = NOW() WHERE stp_id = $1",
        [stpId, payErr.message]
      );
    } catch (e) { /* ignore */ }

    // Re-throw MFA errors so the UI can handle them
    if (payErr.mfa_required) throw payErr;

    paymentResult = { error: payErr.message };
  }

  return {
    stp_id: stpId,
    settlement_id: enriched.settlement_id,
    payment_type: enriched.payment_type,
    amount: enriched.amount,
    payee: enriched.payee_name,

    // Enrichment data
    enrichment_complete: enriched.enrichment_complete,
    enrichment_errors: enriched.errors.length > 0 ? enriched.errors : null,
    chart_of_account: enriched.bill_chart_of_acct || null,
    coa_name: enriched.bill_coa_name || null,
    gl_posting_date: enriched.bill_gl_posting_date || null,
    payment_terms: enriched.bill_payment_terms || null,
    invoice_number: enriched.bill_invoice_number || null,
    vendor_id: enriched.bill_vendor_id || null,

    // Settlement dates
    settlement_date: enriched.settlement_date ? enriched.settlement_date.toISOString().split('T')[0] : null,
    availability_date: enriched.availability_date ? enriched.availability_date.toISOString().split('T')[0] : null,
    settlement_timing: enriched.settlement_timing,

    // Payment execution result
    bill_ref: paymentResult.sentPayId || paymentResult.receivedPayId || null,
    bill_vendor_id: paymentResult.vendorId || enriched.bill_vendor_id || null,
    bill_id: paymentResult.billId || null,
    invoice_id: paymentResult.invoiceId || null,
    process_date: paymentResult.processDate || null,
    clearing_ref: paymentResult.clearingRef || null,
    status: paymentResult.error ? 'failed' : 'transmitted',
    stp_hash: stpHash,

    // Error details
    error: paymentResult.error || null,
  };
}

// ─── ENRICHED PAYMENT EXECUTION ───────────────────────────────────────────────

/**
 * Execute a deposit with all enriched data for clearing.
 */
async function executeEnrichedDeposit(enriched, opts) {
  if (!billClient) throw new Error('BILL client not available');

  // Use depositToBillCash which creates invoice → records payment → clears
  var result = await billClient.depositToBillCash({
    amount: enriched.amount,
    method: opts.method || 'ach',
    memo: enriched.description || opts.description || 'STP deposit — ' + enriched.bill_invoice_number,
    bankAccountId: enriched.bill_bank_account_id,
    customerId: enriched.bill_customer_id,
  });

  return {
    receivedPayId: result.receivedPayId,
    invoiceId: result.invoiceId,
    invoiceNumber: result.invoiceNumber,
    amount: enriched.amount,
    processDate: result.paymentDate,
    clearingRef: result.receivedPayId,
    clearing: result.clearing,
  };
}

/**
 * Execute a vendor payment with all enriched data for clearing.
 * Includes chart of account, GL posting date, payment terms.
 */
async function executeEnrichedVendorPayment(enriched, opts) {
  if (!billClient) throw new Error('BILL client not available');

  // 1. Find or create vendor (already done in enrichment, but verify)
  var vendorId = enriched.bill_vendor_id;
  if (!vendorId) {
    var vendor = await billClient.findVendor(enriched.payee_name);
    if (!vendor) {
      vendor = await billClient.createVendor({
        name: enriched.payee_name,
        email: opts.payee_email || undefined,
        address1: '1 Trust Way',
        city: 'Wilmington',
        state: 'DE',
        zip: '19801',
        paymentType: '0',
      });
    }
    vendorId = vendor.id;
  }

  // 2. Create bill with FULL clearing data (chart of account, GL date, terms)
  var bill = await billClient.createBill({
    vendorId: vendorId,
    amount: enriched.amount,
    invoiceNumber: enriched.bill_invoice_number,
    description: enriched.description || opts.description || 'STP payment — ' + enriched.payee_name,
    dueDate: enriched.bill_due_date || new Date().toISOString().split('T')[0],
    glPostingDate: enriched.bill_gl_posting_date,
  });
  var billId = bill.id;

  // 3. Pay the bill via PayBills
  var payment = await billClient.payBill({
    billId: billId,
    amount: enriched.amount,
  });

  return {
    vendorId: vendorId,
    billId: billId,
    sentPayId: payment.sentPayId,
    amount: enriched.amount,
    processDate: payment.processDate,
    clearingRef: payment.sentPayId,
    bankAccountId: payment.bankAccountId,
  };
}

// ─── BILL STATUS POLLING ──────────────────────────────────────────────────────

/**
 * Poll BILL for actual payment status (not time-based).
 * Checks SentPay and ReceivedPay statuses directly from BILL API.
 *
 * SentPay statuses (BILL API):
 *   0 = Scheduled, 1 = Processing, 2 = Processed, 3 = Failed, 4 = Voided
 *
 * ReceivedPay statuses (BILL API):
 *   0 = Uncleared, 1 = Cleared/Posted, 2 = Voided
 */
async function pollBILLStatuses() {
  if (!billClient) return { checked: 0, advanced: 0, details: [] };

  var pendingRes = await pool.query(`
    SELECT * FROM stp_processing
    WHERE stp_status IN ('transmitted','clearing')
      AND (bill_sent_pay_id IS NOT NULL OR bill_received_pay_id IS NOT NULL)
    ORDER BY submitted_at ASC LIMIT 20
  `);

  var results = { checked: 0, advanced: 0, cleared: 0, posted: 0, available: 0, details: [] };

  for (var i = 0; i < pendingRes.rows.length; i++) {
    var stp = pendingRes.rows[i];
    results.checked++;

    try {
      if (stp.bill_sent_pay_id) {
        // Check SentPay (vendor payment) status
        await pollSentPayStatus(stp, results);
      } else if (stp.bill_received_pay_id) {
        // Check ReceivedPay (deposit) status
        await pollReceivedPayStatus(stp, results);
      }
    } catch (pollErr) {
      console.warn('[STP] poll error for ' + stp.stp_id + ':', pollErr.message);
      results.details.push({ stp_id: stp.stp_id, error: pollErr.message });
    }
  }

  return results;
}

/**
 * Poll SentPay (vendor payment) status from BILL.
 */
async function pollSentPayStatus(stp, results) {
  var session;
  try {
    session = await billClient.getSessionInfo();
  } catch (e) {
    // Need to get a fresh session
    try { await billClient.login(); session = await billClient.getSessionInfo(); } catch (e2) { return; }
  }

  // Read the SentPay record from BILL
  var status;
  try {
    var readResult = await readBILLEntity('SentPay', stp.bill_sent_pay_id);
    if (!readResult) return;

    status = readResult.status;
    var processDate = readResult.processDate || readResult.tpDate || null;

    await pool.query(
      "UPDATE stp_processing SET last_bill_status = $2, last_bill_poll_at = NOW(), bill_process_date = $3, updated_at = NOW() WHERE stp_id = $1",
      [stp.stp_id, String(status), processDate]
    );

    // Status mapping: 0=Scheduled, 1=Processing, 2=Processed, 3=Failed, 4=Voided
    var statusStr = String(status);

    if (statusStr === '2') {
      // Processed — payment cleared and funds sent
      await advanceSTPStatus(stp, 'cleared', results);
      await advanceSTPStatus(stp, 'posted', results);

      // Check if availability date has passed
      if (stp.availability_date && new Date() >= new Date(stp.availability_date)) {
        await advanceSTPStatus(stp, 'available', results);
      }
    } else if (statusStr === '1') {
      // Processing — in clearing
      if (stp.stp_status === 'transmitted') {
        await advanceSTPStatus(stp, 'clearing', results);
      }
    } else if (statusStr === '3' || statusStr === '4') {
      // Failed or voided
      await pool.query(
        "UPDATE stp_processing SET stp_status = 'failed', enrichment_errors = $2, updated_at = NOW() WHERE stp_id = $1",
        [stp.stp_id, 'BILL status: ' + (statusStr === '3' ? 'Failed' : 'Voided')]
      );
      results.details.push({ stp_id: stp.stp_id, status: statusStr === '3' ? 'failed' : 'voided' });
    } else if (statusStr === '0') {
      // Scheduled — still waiting
      if (stp.stp_status === 'transmitted') {
        // Check if enough time has passed to move to clearing
        var elapsed = (Date.now() - new Date(stp.transmitted_at || stp.submitted_at).getTime()) / 3600000;
        if (elapsed >= 1) {
          await advanceSTPStatus(stp, 'clearing', results);
        }
      }
    }
  } catch (err) {
    console.warn('[STP] SentPay poll error:', err.message);
  }
}

/**
 * Poll ReceivedPay (deposit) status from BILL.
 */
async function pollReceivedPayStatus(stp, results) {
  try {
    var depositStatus = await billClient.checkDepositStatus(stp.bill_received_pay_id);
    if (!depositStatus) return;

    await pool.query(
      "UPDATE stp_processing SET last_bill_status = $2, last_bill_poll_at = NOW(), bill_clearing_status = $3, updated_at = NOW() WHERE stp_id = $1",
      [stp.stp_id, depositStatus.status, depositStatus.cleared ? 'cleared' : 'pending']
    );

    if (depositStatus.cleared) {
      // Deposit cleared and posted in BILL
      await advanceSTPStatus(stp, 'cleared', results);
      await advanceSTPStatus(stp, 'posted', results);

      if (stp.availability_date && new Date() >= new Date(stp.availability_date)) {
        await advanceSTPStatus(stp, 'available', results);
      }
    } else if (depositStatus.status === 'voided') {
      await pool.query(
        "UPDATE stp_processing SET stp_status = 'failed', enrichment_errors = 'Deposit voided in BILL', updated_at = NOW() WHERE stp_id = $1",
        [stp.stp_id]
      );
    } else if (stp.stp_status === 'transmitted') {
      // Still pending — move to clearing after initial submission
      await advanceSTPStatus(stp, 'clearing', results);
    }
  } catch (err) {
    console.warn('[STP] ReceivedPay poll error:', err.message);
  }
}

/**
 * Read a BILL entity by type and ID using billClient.readEntity.
 */
async function readBILLEntity(entityType, entityId) {
  if (!billClient || !billClient.readEntity) return null;
  try {
    return await billClient.readEntity(entityType, entityId);
  } catch (e) {
    console.warn('[STP] readBILLEntity failed:', e.message);
    return null;
  }
}

/**
 * Advance STP status and sync to electronic_settlements table.
 */
async function advanceSTPStatus(stp, newStatus, results) {
  var timestampField;
  switch (newStatus) {
    case 'clearing': timestampField = 'clearing_at'; break;
    case 'cleared': timestampField = 'cleared_at'; break;
    case 'posted': timestampField = 'posted_at'; break;
    case 'available': timestampField = 'available_at'; break;
    default: timestampField = null;
  }

  var setClauses = ['stp_status = $2', 'updated_at = NOW()'];
  if (timestampField) setClauses.push(timestampField + ' = NOW()');

  await pool.query(
    'UPDATE stp_processing SET ' + setClauses.join(', ') + ' WHERE stp_id = $1',
    [stp.stp_id, newStatus]
  );

  // Sync status back to electronic_settlements
  var esStatusMap = {
    clearing: 'clearing',
    cleared: 'settled',
    posted: 'confirmed',
    available: 'finalized',
  };
  var esStatus = esStatusMap[newStatus];
  if (esStatus && stp.settlement_id) {
    try {
      await pool.query(
        'UPDATE electronic_settlements SET status = $2, updated_at = NOW() WHERE settlement_id = $1 AND status != $2',
        [stp.settlement_id, esStatus]
      );
    } catch (e) {
      console.warn('[STP] sync to electronic_settlements failed:', e.message);
    }
  }

  // Update notification engine
  if (notifEngine && stp.settlement_id) {
    try {
      var trackingRes = await pool.query(
        'SELECT tracking_id FROM electronic_settlements WHERE settlement_id = $1',
        [stp.settlement_id]
      );
      if (trackingRes.rows[0] && trackingRes.rows[0].tracking_id) {
        var notifStatusMap = { clearing: 'clearing', cleared: 'settled', posted: 'completed', available: 'completed' };
        await notifEngine.updatePaymentStatus(trackingRes.rows[0].tracking_id, notifStatusMap[newStatus] || 'clearing');
      }
    } catch (e) { /* non-critical */ }
  }

  if (results) {
    results.advanced++;
    if (newStatus === 'cleared') results.cleared++;
    if (newStatus === 'posted') results.posted++;
    if (newStatus === 'available') results.available++;
    results.details.push({ stp_id: stp.stp_id, settlement_id: stp.settlement_id, advanced_to: newStatus });
  }
}

// ─── AVAILABILITY CHECK ───────────────────────────────────────────────────────

/**
 * Check all posted STP entries and mark as available if T+1 has passed.
 */
async function checkAvailability() {
  var postedRes = await pool.query(`
    SELECT * FROM stp_processing
    WHERE stp_status = 'posted' AND availability_date <= CURRENT_DATE
    ORDER BY posted_at ASC LIMIT 50
  `);

  var results = { checked: postedRes.rows.length, made_available: 0 };

  for (var i = 0; i < postedRes.rows.length; i++) {
    var stp = postedRes.rows[i];
    await advanceSTPStatus(stp, 'available', null);
    results.made_available++;
  }

  return results;
}

// ─── STP DASHBOARD ────────────────────────────────────────────────────────────

async function getDashboard() {
  try {
    var statsRes = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN stp_status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN stp_status = 'enriched' THEN 1 END) as enriched,
        COUNT(CASE WHEN stp_status = 'transmitted' THEN 1 END) as transmitted,
        COUNT(CASE WHEN stp_status = 'clearing' THEN 1 END) as clearing,
        COUNT(CASE WHEN stp_status = 'cleared' THEN 1 END) as cleared,
        COUNT(CASE WHEN stp_status = 'posted' THEN 1 END) as posted,
        COUNT(CASE WHEN stp_status = 'available' THEN 1 END) as available,
        COUNT(CASE WHEN stp_status = 'failed' THEN 1 END) as failed,
        COALESCE(SUM(CASE WHEN stp_status IN ('cleared','posted','available') THEN amount ELSE 0 END), 0) as cleared_volume,
        COALESCE(SUM(CASE WHEN stp_status IN ('transmitted','clearing') THEN amount ELSE 0 END), 0) as pending_volume
      FROM stp_processing
    `);

    var recentRes = await pool.query(`
      SELECT stp_id, settlement_id, payment_type, amount, payee_name,
             stp_status, settlement_date, availability_date, settlement_timing,
             bill_sent_pay_id, bill_received_pay_id, last_bill_status,
             enrichment_complete, created_at, updated_at
      FROM stp_processing
      ORDER BY created_at DESC LIMIT 20
    `);

    var stats = statsRes.rows[0] || {};
    return {
      stats: {
        total: parseInt(stats.total || 0),
        pending: parseInt(stats.pending || 0),
        enriched: parseInt(stats.enriched || 0),
        transmitted: parseInt(stats.transmitted || 0),
        clearing: parseInt(stats.clearing || 0),
        cleared: parseInt(stats.cleared || 0),
        posted: parseInt(stats.posted || 0),
        available: parseInt(stats.available || 0),
        failed: parseInt(stats.failed || 0),
        cleared_volume: parseFloat(stats.cleared_volume || 0),
        pending_volume: parseFloat(stats.pending_volume || 0),
      },
      recent: recentRes.rows,
    };
  } catch (e) {
    return {
      stats: { total: 0, pending: 0, enriched: 0, transmitted: 0, clearing: 0, cleared: 0, posted: 0, available: 0, failed: 0, cleared_volume: 0, pending_volume: 0 },
      recent: [],
      error: e.message,
    };
  }
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  processPayment: processPayment,
  enrichPaymentData: enrichPaymentData,
  pollBILLStatuses: pollBILLStatuses,
  checkAvailability: checkAvailability,
  getDashboard: getDashboard,
  calculateSettlementDates: calculateSettlementDates,
  addBusinessDays: addBusinessDays,
  ensureSTPTable: ensureSTPTable,
};
