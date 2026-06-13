'use strict';

/**
 * ACH Gateway API — Direct Payment Origination
 * DEANDREA LAVAR BARKLEY TRUST — Ohio Private Trust Company
 *
 * Self-contained ACH origination API that replaces SFTP-based file delivery.
 * The trust originates payments directly through this API, generating
 * NACHA-compliant files and managing the full payment lifecycle.
 *
 * Endpoints:
 *   POST /api/treasury/ach/originate       — Originate a single ACH payment
 *   POST /api/treasury/ach/batch-originate  — Originate multiple ACH payments
 *   GET  /api/treasury/ach/transactions     — List ACH transactions
 *   GET  /api/treasury/ach/transactions/:id — Get transaction details
 *   POST /api/treasury/ach/return/:id       — Process an ACH return
 *   GET  /api/treasury/ach/status           — Gateway status & health
 *   POST /api/treasury/ach/validate-routing — Validate routing number
 *   GET  /api/treasury/ach/nacha/:batchId   — Download NACHA file for a batch
 *
 * ODFI: Eaton Family Credit Union (routing: 241075470)
 * SEC Codes: PPD (Prearranged Payment/Deposit), CCD (Corporate Credit/Debit)
 */

const express = require('express');
const router = express.Router();
const db = require('../../db-postgres');

const ODFI_ROUTING = '241075470';
const ODFI_NAME = 'EATON FAMILY CU';
const ORIGINATOR_NAME = 'DEANDREA LAVAR BARKLEY TRUST';
const ORIGINATOR_ID = '000000000'; // EIN or Company ID assigned by ODFI

// ─── ABA ROUTING NUMBER VALIDATION ──────────────────────────────────────────

function validateRoutingNumber(routing) {
  if (!routing || routing.length !== 9 || !/^\d{9}$/.test(routing)) return false;
  // ABA checksum: 3*d1 + 7*d2 + d3 + 3*d4 + 7*d5 + d6 + 3*d7 + 7*d8 + d9 ≡ 0 (mod 10)
  const d = routing.split('').map(Number);
  const sum = 3*d[0] + 7*d[1] + d[2] + 3*d[3] + 7*d[4] + d[5] + 3*d[6] + 7*d[7] + d[8];
  return sum % 10 === 0;
}

// ─── NACHA FILE BUILDER ─────────────────────────────────────────────────────

function buildNACHAFile(batch, entries, trust) {
  const now = new Date();
  const yymmdd = now.toISOString().slice(2, 10).replace(/-/g, '');
  const hhmm = now.toTimeString().slice(0, 5).replace(':', '');
  const companyName = (trust.trust_name || ORIGINATOR_NAME).slice(0, 16).padEnd(16);
  const companyId = (trust.ein || ORIGINATOR_ID).padStart(10, '0');
  const isCredit = batch.sec_code !== 'debit';
  const serviceClass = isCredit ? '220' : '225';
  const secCode = (batch.sec_code || 'PPD').toUpperCase().padEnd(3).slice(0, 3);

  let content = '';

  // Record Type 1 — File Header
  content += '1';                                      // Record Type
  content += '01';                                     // Priority Code
  content += ` ${ODFI_ROUTING.padStart(9, ' ')}`;      // Immediate Destination (space + 9)
  content += ` ${companyId}`;                          // Immediate Origin (space + 10)
  content += yymmdd;                                   // File Creation Date
  content += hhmm;                                     // File Creation Time
  content += 'A';                                      // File ID Modifier
  content += '094';                                    // Record Size
  content += '10';                                     // Blocking Factor
  content += '1';                                      // Format Code
  content += ODFI_NAME.padEnd(23);                     // Immediate Destination Name
  content += companyName.padEnd(23);                   // Immediate Origin Name
  content += (batch.id || '').slice(0, 8).padEnd(8);   // Reference Code
  content += '\n';

  // Record Type 5 — Batch Header
  content += '5';                                      // Record Type
  content += serviceClass;                             // Service Class Code
  content += companyName.padEnd(16);                   // Company Name
  content += ''.padEnd(20);                            // Company Discretionary Data
  content += companyId;                                // Company Identification
  content += secCode;                                  // Standard Entry Class
  content += 'TRUST DIST'.padEnd(10);                  // Company Entry Description
  content += yymmdd;                                   // Company Descriptive Date
  content += yymmdd;                                   // Effective Entry Date
  content += '   ';                                    // Settlement Date
  content += '1';                                      // Originator Status Code
  content += ODFI_ROUTING.slice(0, 8);                 // Originating DFI ID
  content += '0000001';                                // Batch Number
  content += '\n';

  // Record Type 6 — Entry Detail Records
  let entryCount = 0;
  let entryHash = 0;
  let totalDebit = 0;
  let totalCredit = 0;

  for (const entry of entries) {
    entryCount++;
    const routing = (entry.routing_number || '000000000').padStart(9, '0');
    const rdfi = routing.slice(0, 8);
    const checkDigit = routing[8];
    entryHash += parseInt(rdfi) || 0;

    const amountCents = parseInt(entry.amount) || 0;
    // Transaction code: 22=checking credit, 27=checking debit, 32=savings credit, 37=savings debit
    let txCode;
    if (entry.account_type === 'savings') {
      txCode = isCredit ? '32' : '37';
    } else {
      txCode = isCredit ? '22' : '27';
    }

    if (isCredit) totalCredit += amountCents;
    else totalDebit += amountCents;

    content += '6';                                                    // Record Type
    content += txCode;                                                 // Transaction Code
    content += rdfi;                                                   // Receiving DFI (8 digits)
    content += checkDigit;                                             // Check Digit
    content += (entry.account_number || '').padEnd(17).slice(0, 17);   // DFI Account Number
    content += String(amountCents).padStart(10, '0');                  // Amount
    content += (entry.individual_id || entry.id || '').slice(0, 15).padEnd(15); // Individual ID
    content += (entry.individual_name || '').slice(0, 22).padEnd(22);  // Individual Name
    content += '  ';                                                   // Discretionary Data
    content += '0';                                                    // Addenda Record Indicator
    content += ODFI_ROUTING.slice(0, 8) + String(entryCount).padStart(7, '0'); // Trace Number
    content += '\n';
  }

  // Record Type 8 — Batch Control
  content += '8';
  content += serviceClass;
  content += String(entryCount).padStart(6, '0');
  content += String(entryHash % 10000000000).padStart(10, '0');
  content += String(totalDebit).padStart(12, '0');
  content += String(totalCredit).padStart(12, '0');
  content += companyId;
  content += ''.padEnd(19);  // Message Authentication Code
  content += ''.padEnd(6);   // Reserved
  content += ODFI_ROUTING.slice(0, 8);
  content += '0000001';
  content += '\n';

  // Record Type 9 — File Control
  const blockCount = Math.ceil((entryCount + 4) / 10);
  content += '9';
  content += '000001';                                               // Batch Count
  content += String(blockCount).padStart(6, '0');                    // Block Count
  content += String(entryCount).padStart(8, '0');                    // Entry/Addenda Count
  content += String(entryHash % 10000000000).padStart(10, '0');      // Entry Hash
  content += String(totalDebit).padStart(12, '0');                   // Total Debit
  content += String(totalCredit).padStart(12, '0');                  // Total Credit
  content += ''.padEnd(39);                                          // Reserved
  content += '\n';

  // Pad to fill blocking factor (10 records per block)
  const lineCount = 4 + entryCount; // header + batch header + entries + batch control + file control
  const padLines = (blockCount * 10) - lineCount;
  for (let i = 0; i < padLines; i++) {
    content += '9'.repeat(94) + '\n';
  }

  return {
    content,
    entryCount,
    entryHash: entryHash % 10000000000,
    totalDebit,
    totalCredit,
  };
}

// ─── FEDWIRE MESSAGE BUILDER ────────────────────────────────────────────────

function buildFedwireMessage(payment, trust) {
  const now = new Date();
  const amount = parseInt(payment.amount) || 0;
  return {
    format: 'fedwire',
    type_subtype: '{1510}',
    sender_aba: ODFI_ROUTING,
    sender_reference: payment.id.slice(0, 16),
    amount: String(amount).padStart(12, '0'),
    sender_name: trust.trust_name || ORIGINATOR_NAME,
    receiver_aba: payment.routing_number,
    receiver_account: payment.account_number,
    receiver_name: payment.beneficiary_name,
    business_function: 'CTR',
    originator: {
      name: trust.trust_name,
      address: trust.jurisdiction || 'Ohio',
      id: trust.ein || '',
    },
    beneficiary: {
      name: payment.beneficiary_name,
      account: payment.account_number,
    },
    purpose: payment.memo || 'Trust Distribution',
    created_at: now.toISOString(),
  };
}

// ─── POST /originate — Originate a single ACH payment ───────────────────────

router.post('/originate', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT * FROM trusts LIMIT 1');
    const {
      beneficiary_name, routing_number, account_number, account_type,
      amount, memo, sec_code, effective_date, source_wallet_id,
    } = req.body;

    // Validation
    if (!beneficiary_name) return res.status(400).json({ error: 'beneficiary_name required' });
    if (!routing_number) return res.status(400).json({ error: 'routing_number required' });
    if (!account_number) return res.status(400).json({ error: 'account_number required' });
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'amount must be positive' });

    if (!validateRoutingNumber(routing_number)) {
      return res.status(400).json({ error: 'Invalid ABA routing number (checksum failed)' });
    }

    const amountCents = Math.round(parseFloat(amount) * 100);

    // Debit source wallet if specified
    if (source_wallet_id) {
      const wallet = await db.queryOne('SELECT * FROM wallets WHERE id = $1', [source_wallet_id]);
      if (!wallet) return res.status(404).json({ error: 'Source wallet not found' });
      if (parseInt(wallet.balance) < amountCents) {
        return res.status(400).json({ error: 'Insufficient wallet balance' });
      }
    }

    // Create ACH transaction record
    const txn = await db.queryOne(`
      INSERT INTO ach_transactions (
        trust_id, transaction_type, sec_code, beneficiary_name,
        routing_number, account_number, account_type,
        amount, memo, effective_date, source_wallet_id, status
      ) VALUES ($1, 'credit', $2, $3, $4, $5, $6, $7, $8, $9, $10, 'originated')
      RETURNING *
    `, [
      trust.id, sec_code || 'PPD', beneficiary_name,
      routing_number, account_number, account_type || 'checking',
      amountCents, memo || `ACH to ${beneficiary_name}`,
      effective_date || new Date().toISOString().split('T')[0],
      source_wallet_id || null,
    ]);

    // Debit the source wallet within a transaction
    if (source_wallet_id) {
      await db.transaction(async (client) => {
        const { rows: [locked] } = await client.query(
          'SELECT balance FROM wallets WHERE id = $1 FOR UPDATE', [source_wallet_id]
        );
        if (locked.balance < amountCents) throw new Error('Insufficient funds (concurrent check)');

        await client.query('UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE id = $2',
          [amountCents, source_wallet_id]);

        await client.query(`
          INSERT INTO ledger_entries (trust_id, entry_date, entry_type, debit_wallet_id, amount, description, reference_type, reference_id, status, posted_by)
          VALUES ($1, CURRENT_DATE, 'distribution', $2, $3, $4, 'ach_transaction', $5, 'posted', 'ach_gateway')
        `, [trust.id, source_wallet_id, amountCents, `ACH Credit: ${beneficiary_name}`, txn.id]);
      });
    }

    // Audit
    await db.query(`
      INSERT INTO audit_log (trust_id, actor, action, entity_type, entity_id, details)
      VALUES ($1, 'ach_gateway', 'ach_originated', 'ach_transaction', $2, $3)
    `, [trust.id, txn.id, JSON.stringify({
      type: 'credit', amount: amountCents, routing: routing_number, beneficiary: beneficiary_name,
    })]);

    res.json({
      success: true,
      data: {
        transaction_id: txn.id,
        status: 'originated',
        type: 'ach_credit',
        amount: amountCents,
        amount_formatted: `$${(amountCents / 100).toFixed(2)}`,
        beneficiary: beneficiary_name,
        routing_number,
        account_last4: account_number.slice(-4),
        effective_date: txn.effective_date,
        trace_number: `${ODFI_ROUTING.slice(0, 8)}${txn.id.slice(0, 7)}`,
      },
      message: `ACH credit originated: $${(amountCents / 100).toFixed(2)} to ${beneficiary_name}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /batch-originate — Originate multiple ACH payments ────────────────

router.post('/batch-originate', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT * FROM trusts LIMIT 1');
    const { payments, sec_code, effective_date, source_wallet_id } = req.body;

    if (!payments || !Array.isArray(payments) || payments.length === 0) {
      return res.status(400).json({ error: 'payments array required (non-empty)' });
    }

    // Validate all payments first
    for (const p of payments) {
      if (!p.beneficiary_name || !p.routing_number || !p.account_number || !p.amount) {
        return res.status(400).json({ error: `Missing required fields for payment to ${p.beneficiary_name || 'unknown'}` });
      }
      if (!validateRoutingNumber(p.routing_number)) {
        return res.status(400).json({ error: `Invalid routing number for ${p.beneficiary_name}: ${p.routing_number}` });
      }
    }

    const totalAmount = payments.reduce((s, p) => s + Math.round(parseFloat(p.amount) * 100), 0);

    // Check wallet balance if source specified
    if (source_wallet_id) {
      const wallet = await db.queryOne('SELECT * FROM wallets WHERE id = $1', [source_wallet_id]);
      if (!wallet || parseInt(wallet.balance) < totalAmount) {
        return res.status(400).json({ error: `Insufficient wallet balance. Need $${(totalAmount / 100).toFixed(2)}` });
      }
    }

    // Create batch
    const batch = await db.queryOne(`
      INSERT INTO ach_batches (
        trust_id, sec_code, entry_count, total_credit, total_debit,
        effective_date, source_wallet_id, status
      ) VALUES ($1, $2, $3, $4, 0, $5, $6, 'created')
      RETURNING *
    `, [trust.id, sec_code || 'PPD', payments.length, totalAmount,
        effective_date || new Date().toISOString().split('T')[0],
        source_wallet_id || null]);

    // Create individual transactions
    const txns = [];
    await db.transaction(async (client) => {
      for (const p of payments) {
        const amountCents = Math.round(parseFloat(p.amount) * 100);
        const { rows: [txn] } = await client.query(`
          INSERT INTO ach_transactions (
            trust_id, batch_id, transaction_type, sec_code, beneficiary_name,
            routing_number, account_number, account_type, amount, memo,
            effective_date, source_wallet_id, status
          ) VALUES ($1, $2, 'credit', $3, $4, $5, $6, $7, $8, $9, $10, $11, 'originated')
          RETURNING *
        `, [
          trust.id, batch.id, sec_code || 'PPD', p.beneficiary_name,
          p.routing_number, p.account_number, p.account_type || 'checking',
          amountCents, p.memo || `ACH to ${p.beneficiary_name}`,
          effective_date || new Date().toISOString().split('T')[0],
          source_wallet_id || null,
        ]);
        txns.push(txn);
      }

      // Debit source wallet for total
      if (source_wallet_id) {
        const { rows: [locked] } = await client.query(
          'SELECT balance FROM wallets WHERE id = $1 FOR UPDATE', [source_wallet_id]
        );
        if (locked.balance < totalAmount) throw new Error('Insufficient funds');

        await client.query('UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE id = $2',
          [totalAmount, source_wallet_id]);

        await client.query(`
          INSERT INTO ledger_entries (trust_id, entry_date, entry_type, debit_wallet_id, amount, description, reference_type, reference_id, status, posted_by)
          VALUES ($1, CURRENT_DATE, 'distribution', $2, $3, $4, 'ach_batch', $5, 'posted', 'ach_gateway')
        `, [trust.id, source_wallet_id, totalAmount, `ACH Batch: ${payments.length} payments`, batch.id]);
      }
    });

    // Generate NACHA file for the batch
    const nachaEntries = txns.map(t => ({
      id: t.id,
      routing_number: t.routing_number,
      account_number: t.account_number,
      account_type: t.account_type,
      amount: t.amount,
      individual_id: t.id.slice(0, 15),
      individual_name: t.beneficiary_name,
    }));

    const nachaResult = buildNACHAFile(batch, nachaEntries, trust);
    const filename = `ACH_${(trust.trust_name || 'DLB').replace(/\s+/g, '_').slice(0, 20)}_${batch.id.slice(0, 8)}.ach`;

    // Save NACHA file
    const file = await db.queryOne(`
      INSERT INTO mft_files (trust_id, filename, file_type, content, record_count, total_amount, status)
      VALUES ($1, $2, 'NACHA', $3, $4, $5, 'generated')
      RETURNING id, filename
    `, [trust.id, filename, nachaResult.content, nachaResult.entryCount, totalAmount]);

    // Update batch with file reference
    await db.query("UPDATE ach_batches SET nacha_file_id = $1, status = 'originated' WHERE id = $2", [file.id, batch.id]);

    await db.query(`
      INSERT INTO audit_log (trust_id, actor, action, entity_type, entity_id, details)
      VALUES ($1, 'ach_gateway', 'batch_originated', 'ach_batch', $2, $3)
    `, [trust.id, batch.id, JSON.stringify({
      count: payments.length, total: totalAmount, file: filename,
    })]);

    res.json({
      success: true,
      data: {
        batch_id: batch.id,
        nacha_file: filename,
        nacha_file_id: file.id,
        entry_count: txns.length,
        total_amount: totalAmount,
        total_formatted: `$${(totalAmount / 100).toFixed(2)}`,
        effective_date: batch.effective_date,
        transactions: txns.map(t => ({
          id: t.id, beneficiary: t.beneficiary_name, amount: parseInt(t.amount),
          routing: t.routing_number, status: t.status,
        })),
      },
      message: `ACH batch originated: ${txns.length} payments, $${(totalAmount / 100).toFixed(2)} total`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /wire/originate — Originate a wire transfer ───────────────────────

router.post('/wire/originate', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT * FROM trusts LIMIT 1');
    const {
      beneficiary_name, routing_number, account_number,
      amount, memo, source_wallet_id,
    } = req.body;

    if (!beneficiary_name) return res.status(400).json({ error: 'beneficiary_name required' });
    if (!routing_number) return res.status(400).json({ error: 'routing_number required' });
    if (!account_number) return res.status(400).json({ error: 'account_number required' });
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'amount must be positive' });

    const amountCents = Math.round(parseFloat(amount) * 100);

    // Create wire transaction
    const txn = await db.queryOne(`
      INSERT INTO ach_transactions (
        trust_id, transaction_type, sec_code, beneficiary_name,
        routing_number, account_number, account_type,
        amount, memo, effective_date, source_wallet_id, status
      ) VALUES ($1, 'wire', 'WIRE', $2, $3, $4, 'checking', $5, $6, CURRENT_DATE, $7, 'originated')
      RETURNING *
    `, [trust.id, beneficiary_name, routing_number, account_number,
        amountCents, memo || `Wire to ${beneficiary_name}`, source_wallet_id || null]);

    // Build Fedwire message
    const fedwire = buildFedwireMessage({
      ...txn, account_number, beneficiary_name,
    }, trust);

    // Debit wallet if specified
    if (source_wallet_id) {
      await db.transaction(async (client) => {
        const { rows: [locked] } = await client.query(
          'SELECT balance FROM wallets WHERE id = $1 FOR UPDATE', [source_wallet_id]
        );
        if (locked.balance < amountCents) throw new Error('Insufficient funds');

        await client.query('UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE id = $2',
          [amountCents, source_wallet_id]);

        await client.query(`
          INSERT INTO ledger_entries (trust_id, entry_date, entry_type, debit_wallet_id, amount, description, reference_type, reference_id, status, posted_by)
          VALUES ($1, CURRENT_DATE, 'distribution', $2, $3, $4, 'ach_transaction', $5, 'posted', 'ach_gateway')
        `, [trust.id, source_wallet_id, amountCents, `Wire: ${beneficiary_name}`, txn.id]);
      });
    }

    // Save wire instruction as file
    const wireContent = JSON.stringify(fedwire, null, 2);
    const filename = `WIRE_${txn.id.slice(0, 8)}_${new Date().toISOString().split('T')[0]}.json`;
    await db.query(`
      INSERT INTO mft_files (trust_id, filename, file_type, content, record_count, total_amount, status)
      VALUES ($1, $2, 'CUSTOM', $3, 1, $4, 'generated')
    `, [trust.id, filename, wireContent, amountCents]);

    await db.query(`
      INSERT INTO audit_log (trust_id, actor, action, entity_type, entity_id, details)
      VALUES ($1, 'ach_gateway', 'wire_originated', 'ach_transaction', $2, $3)
    `, [trust.id, txn.id, JSON.stringify({ amount: amountCents, beneficiary: beneficiary_name })]);

    res.json({
      success: true,
      data: {
        transaction_id: txn.id,
        type: 'wire',
        status: 'originated',
        amount: amountCents,
        amount_formatted: `$${(amountCents / 100).toFixed(2)}`,
        beneficiary: beneficiary_name,
        fedwire_message: fedwire,
      },
      message: `Wire transfer originated: $${(amountCents / 100).toFixed(2)} to ${beneficiary_name}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /transactions — List ACH/wire transactions ─────────────────────────

router.get('/transactions', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT id FROM trusts LIMIT 1');
    const { status, type, limit } = req.query;
    let sql = 'SELECT * FROM ach_transactions WHERE trust_id = $1';
    const params = [trust.id];
    let idx = 2;
    if (status) { sql += ` AND status = $${idx++}`; params.push(status); }
    if (type) { sql += ` AND transaction_type = $${idx++}`; params.push(type); }
    sql += ' ORDER BY created_at DESC';
    if (limit) sql += ` LIMIT ${parseInt(limit) || 50}`;

    const txns = await db.queryAll(sql, params);
    res.json({ success: true, data: txns });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

// ─── GET /transactions/:id — Get single transaction ─────────────────────────

router.get('/transactions/:id', async (req, res) => {
  try {
    const txn = await db.queryOne('SELECT * FROM ach_transactions WHERE id = $1', [req.params.id]);
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });
    res.json({ success: true, data: txn });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /settle/:id — Mark transaction as settled ─────────────────────────

router.post('/settle/:id', async (req, res) => {
  try {
    const txn = await db.queryOne('SELECT * FROM ach_transactions WHERE id = $1', [req.params.id]);
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });

    await db.query("UPDATE ach_transactions SET status = 'settled', settled_at = NOW() WHERE id = $1", [txn.id]);

    await db.query(`
      INSERT INTO audit_log (trust_id, actor, action, entity_type, entity_id, details)
      VALUES ($1, 'ach_gateway', 'txn_settled', 'ach_transaction', $2, $3)
    `, [txn.trust_id, txn.id, JSON.stringify({ amount: parseInt(txn.amount), type: txn.transaction_type })]);

    res.json({ success: true, message: 'Transaction settled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /return/:id — Process an ACH return ──────────────────────────────

router.post('/return/:id', async (req, res) => {
  try {
    const { return_code, reason } = req.body;
    const txn = await db.queryOne('SELECT * FROM ach_transactions WHERE id = $1', [req.params.id]);
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });

    await db.query(`
      UPDATE ach_transactions SET status = 'returned', return_code = $1, return_reason = $2, returned_at = NOW()
      WHERE id = $3
    `, [return_code || 'R01', reason || 'Insufficient Funds', txn.id]);

    // Reverse the wallet debit if source wallet was specified
    if (txn.source_wallet_id) {
      await db.transaction(async (client) => {
        await client.query('UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE id = $2',
          [parseInt(txn.amount), txn.source_wallet_id]);

        await client.query(`
          INSERT INTO ledger_entries (trust_id, entry_date, entry_type, credit_wallet_id, amount, description, reference_type, reference_id, status, posted_by)
          VALUES ($1, CURRENT_DATE, 'adjustment', $2, $3, $4, 'ach_transaction', $5, 'posted', 'ach_gateway')
        `, [txn.trust_id, txn.source_wallet_id, parseInt(txn.amount),
            `ACH Return ${return_code || 'R01'}: ${txn.beneficiary_name}`, txn.id]);
      });
    }

    res.json({ success: true, message: `ACH return processed: ${return_code || 'R01'}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /validate-routing — Validate an ABA routing number ────────────────

router.post('/validate-routing', (req, res) => {
  const { routing_number } = req.body;
  const valid = validateRoutingNumber(routing_number);
  res.json({
    success: true,
    valid,
    routing_number,
    message: valid ? 'Valid ABA routing number' : 'Invalid ABA routing number (checksum failed)',
  });
});

// ─── GET /batches — List ACH batches ────────────────────────────────────────

router.get('/batches', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT id FROM trusts LIMIT 1');
    const batches = await db.queryAll(
      'SELECT * FROM ach_batches WHERE trust_id = $1 ORDER BY created_at DESC', [trust.id]
    );
    res.json({ success: true, data: batches });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

// ─── GET /nacha/:batchId — Download NACHA file for a batch ──────────────────

router.get('/nacha/:batchId', async (req, res) => {
  try {
    const batch = await db.queryOne('SELECT * FROM ach_batches WHERE id = $1', [req.params.batchId]);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    if (!batch.nacha_file_id) return res.status(404).json({ error: 'No NACHA file for this batch' });

    const file = await db.queryOne('SELECT * FROM mft_files WHERE id = $1', [batch.nacha_file_id]);
    if (!file) return res.status(404).json({ error: 'NACHA file not found' });

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.content);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /status — Gateway status and health ────────────────────────────────

router.get('/status', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT id, trust_name, ein FROM trusts LIMIT 1');
    const [originated, settled, returned, totalAmount] = await Promise.all([
      db.queryOne("SELECT COUNT(*)::int as count FROM ach_transactions WHERE trust_id = $1 AND status = 'originated'", [trust.id]),
      db.queryOne("SELECT COUNT(*)::int as count FROM ach_transactions WHERE trust_id = $1 AND status = 'settled'", [trust.id]),
      db.queryOne("SELECT COUNT(*)::int as count FROM ach_transactions WHERE trust_id = $1 AND status = 'returned'", [trust.id]),
      db.queryOne("SELECT COALESCE(SUM(amount),0)::bigint as total FROM ach_transactions WHERE trust_id = $1", [trust.id]),
    ]);
    const batchCount = await db.queryOne("SELECT COUNT(*)::int as count FROM ach_batches WHERE trust_id = $1", [trust.id]);

    res.json({
      success: true,
      gateway: 'DLB Trust ACH Gateway v1.0',
      originator: trust.trust_name,
      odfi: ODFI_NAME,
      odfi_routing: ODFI_ROUTING,
      status: 'active',
      capabilities: ['ach_credit', 'ach_debit', 'wire_transfer', 'routing_validation', 'nacha_generation', 'return_processing'],
      stats: {
        originated: originated.count,
        settled: settled.count,
        returned: returned.count,
        total_volume: parseInt(totalAmount.total),
        total_batches: batchCount.count,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
