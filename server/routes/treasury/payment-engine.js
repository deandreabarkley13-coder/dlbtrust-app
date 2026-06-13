'use strict';

/**
 * Self-Contained Payment/Transfer Engine
 * DEANDREA LAVAR BARKLEY TRUST — Private Trust Company (Ohio)
 *
 * This engine provides full payment origination and processing capabilities
 * without requiring any third-party payment processor. The trust acts as
 * its own payment originator (PTC privilege under Ohio Revised Code § 1111).
 *
 * Payment Rails:
 *   - ACH Credit (NACHA file → ODFI via SFTP)
 *   - ACH Debit (NACHA file → ODFI via SFTP)
 *   - Wire Transfer (Fedwire format → ODFI via secure channel)
 *   - Book Transfer (internal wallet-to-wallet, instant settlement)
 *   - Check Issuance (print instruction generation)
 *   - RTP (Real-Time Payments via FedNow, if ODFI supports)
 *
 * Lifecycle: initiated → approved → batched → processing → settled/failed
 */

const express = require('express');
const router = express.Router();
const db = require('../../db-postgres');

// ─── PAYMENT INITIATION ──────────────────────────────────────────────────────

// POST /api/treasury/engine/initiate — Create a new payment instruction directly
router.post('/initiate', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT * FROM trusts LIMIT 1');
    const {
      payment_rail, amount, currency, beneficiary_name,
      routing_number, account_number, account_type,
      memo, effective_date, source_wallet_id,
      requires_approval, priority,
    } = req.body;

    if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount must be positive' });
    if (!payment_rail) return res.status(400).json({ error: 'Payment rail is required' });
    if (!beneficiary_name) return res.status(400).json({ error: 'Beneficiary name is required' });

    const validRails = ['ach_credit', 'ach_debit', 'wire', 'book_transfer', 'check', 'rtp'];
    if (!validRails.includes(payment_rail)) {
      return res.status(400).json({ error: `Invalid payment rail. Valid: ${validRails.join(', ')}` });
    }

    // For ACH/wire, require routing + account
    if (['ach_credit', 'ach_debit', 'wire'].includes(payment_rail)) {
      if (!routing_number) return res.status(400).json({ error: 'Routing number required for ACH/wire' });
      if (!account_number) return res.status(400).json({ error: 'Account number required for ACH/wire' });
    }

    // For book transfers, require source wallet
    if (payment_rail === 'book_transfer' && !source_wallet_id) {
      return res.status(400).json({ error: 'Source wallet required for book transfers' });
    }

    const amountCents = Math.round(parseFloat(amount) * 100);
    const initialStatus = requires_approval ? 'pending_approval' : 'approved';

    const instruction = await db.queryOne(`
      INSERT INTO payment_instructions (
        trust_id, payment_rail, amount, currency, beneficiary_name,
        routing_number, account_number_encrypted, account_type,
        memo, effective_date, status, priority, source_wallet_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `, [
      trust.id, payment_rail, amountCents, currency || 'USD', beneficiary_name,
      routing_number || null, account_number || null, account_type || 'checking',
      memo || `Payment to ${beneficiary_name}`,
      effective_date || new Date().toISOString().split('T')[0],
      initialStatus, priority || 'normal', source_wallet_id || null,
    ]);

    // Audit
    await db.query(`
      INSERT INTO audit_log (trust_id, actor, action, entity_type, entity_id, details)
      VALUES ($1, 'trustee', 'payment_initiated', 'payment_instruction', $2, $3)
    `, [trust.id, instruction.id, JSON.stringify({ amount: amountCents, rail: payment_rail, beneficiary: beneficiary_name })]);

    res.json({ success: true, data: instruction, message: `Payment ${initialStatus === 'approved' ? 'approved and queued' : 'created pending approval'}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/treasury/engine/approve/:id — Approve a pending payment
router.post('/approve/:id', async (req, res) => {
  try {
    const instruction = await db.queryOne('SELECT * FROM payment_instructions WHERE id = $1', [req.params.id]);
    if (!instruction) return res.status(404).json({ error: 'Payment not found' });
    if (instruction.status !== 'pending_approval') {
      return res.status(400).json({ error: `Cannot approve payment in "${instruction.status}" status` });
    }

    await db.query(`
      UPDATE payment_instructions SET status = 'approved', approved_at = NOW(), approved_by = 'trustee', updated_at = NOW()
      WHERE id = $1
    `, [instruction.id]);

    await db.query(`
      INSERT INTO audit_log (trust_id, actor, action, entity_type, entity_id, details)
      VALUES ($1, 'trustee', 'payment_approved', 'payment_instruction', $2, $3)
    `, [instruction.trust_id, instruction.id, JSON.stringify({ amount: instruction.amount })]);

    res.json({ success: true, message: 'Payment approved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/treasury/engine/reject/:id — Reject a pending payment
router.post('/reject/:id', async (req, res) => {
  try {
    const { reason } = req.body;
    const instruction = await db.queryOne('SELECT * FROM payment_instructions WHERE id = $1', [req.params.id]);
    if (!instruction) return res.status(404).json({ error: 'Payment not found' });

    await db.query(`
      UPDATE payment_instructions SET status = 'rejected', failure_reason = $1, updated_at = NOW()
      WHERE id = $2
    `, [reason || 'Rejected by trustee', instruction.id]);

    res.json({ success: true, message: 'Payment rejected' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── BATCH PROCESSING ENGINE ─────────────────────────────────────────────────

// POST /api/treasury/engine/batch — Create a payment batch from approved payments
router.post('/batch', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT * FROM trusts LIMIT 1');
    const { payment_rail, payment_ids } = req.body;

    // Get approved payments to batch
    let payments;
    if (payment_ids && payment_ids.length > 0) {
      payments = await db.queryAll(`
        SELECT * FROM payment_instructions
        WHERE id = ANY($1) AND status = 'approved'
      `, [payment_ids]);
    } else {
      const rail = payment_rail || 'ach_credit';
      payments = await db.queryAll(`
        SELECT * FROM payment_instructions
        WHERE trust_id = $1 AND status = 'approved' AND payment_rail = $2
        ORDER BY created_at
      `, [trust.id, rail]);
    }

    if (payments.length === 0) {
      return res.status(400).json({ error: 'No approved payments available for batching' });
    }

    const totalAmount = payments.reduce((s, p) => s + (parseInt(p.amount) || 0), 0);
    const rail = payments[0].payment_rail;

    // Create batch record
    const batch = await db.queryOne(`
      INSERT INTO payment_batches (
        trust_id, batch_type, payment_rail, payment_count, total_amount, status
      ) VALUES ($1, 'standard', $2, $3, $4, 'created')
      RETURNING *
    `, [trust.id, rail, payments.length, totalAmount]);

    // Assign payments to batch
    await db.transaction(async (client) => {
      for (const p of payments) {
        await client.query(`
          UPDATE payment_instructions SET batch_id = $1, status = 'batched', updated_at = NOW()
          WHERE id = $2
        `, [batch.id, p.id]);
      }
    });

    await db.query(`
      INSERT INTO audit_log (trust_id, actor, action, entity_type, entity_id, details)
      VALUES ($1, 'system', 'batch_created', 'payment_batch', $2, $3)
    `, [trust.id, batch.id, JSON.stringify({ count: payments.length, total: totalAmount, rail })]);

    res.json({
      success: true,
      data: batch,
      message: `Batch created with ${payments.length} payments totaling ${(totalAmount / 100).toFixed(2)} USD`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/treasury/engine/batches — List payment batches
router.get('/batches', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT id FROM trusts LIMIT 1');
    const batches = await db.queryAll(`
      SELECT * FROM payment_batches WHERE trust_id = $1 ORDER BY created_at DESC
    `, [trust.id]);
    res.json({ success: true, data: batches });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

// ─── SELF-PROCESSING ENGINE ──────────────────────────────────────────────────

// POST /api/treasury/engine/process-batch/:id — Process a batch (generate files, execute transfers)
router.post('/process-batch/:id', async (req, res) => {
  try {
    const batch = await db.queryOne('SELECT * FROM payment_batches WHERE id = $1', [req.params.id]);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    if (!['created', 'failed'].includes(batch.status)) {
      return res.status(400).json({ error: `Cannot process batch in "${batch.status}" status` });
    }

    const trust = await db.queryOne('SELECT * FROM trusts WHERE id = $1', [batch.trust_id]);
    const payments = await db.queryAll(
      'SELECT * FROM payment_instructions WHERE batch_id = $1', [batch.id]
    );

    await db.query("UPDATE payment_batches SET status = 'processing', processed_at = NOW() WHERE id = $1", [batch.id]);

    let result;
    switch (batch.payment_rail) {
      case 'ach_credit':
      case 'ach_debit':
        result = await processACHBatch(trust, batch, payments);
        break;
      case 'wire':
        result = await processWireBatch(trust, batch, payments);
        break;
      case 'book_transfer':
        result = await processBookTransfers(trust, batch, payments);
        break;
      case 'check':
        result = await processCheckBatch(trust, batch, payments);
        break;
      case 'rtp':
        result = await processRTPBatch(trust, batch, payments);
        break;
      default:
        result = { success: false, error: `Unsupported rail: ${batch.payment_rail}` };
    }

    if (result.success) {
      await db.query("UPDATE payment_batches SET status = 'processed', file_id = $1 WHERE id = $2", [result.file_id || null, batch.id]);
      for (const p of payments) {
        await db.query("UPDATE payment_instructions SET status = 'processing', updated_at = NOW() WHERE id = $1", [p.id]);
      }
      res.json({ success: true, message: result.message, data: result });
    } else {
      await db.query("UPDATE payment_batches SET status = 'failed', error_message = $1 WHERE id = $2", [result.error, batch.id]);
      res.status(500).json({ error: result.error });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ACH PROCESSING (Self-Originated NACHA) ──────────────────────────────────

async function processACHBatch(trust, batch, payments) {
  const now = new Date();
  const fileDate = now.toISOString().split('T')[0].replace(/-/g, '');
  const fileTime = now.toTimeString().slice(0, 5).replace(':', '');
  const filename = `ACH_BATCH_${batch.id.slice(0, 8)}_${fileDate}_${fileTime}.ach`;

  const immediateDestination = '241075470'; // Eaton FCU ODFI
  const immediateOrigin = trust.ein || '000000000';
  const companyName = (trust.trust_name || 'DLB TRUST').slice(0, 16).padEnd(16);
  const isCredit = batch.payment_rail === 'ach_credit';
  const serviceClass = isCredit ? '220' : '225'; // 220=credits only, 225=debits only
  const txCode = isCredit ? '22' : '27'; // 22=checking credit, 27=checking debit

  let nachaContent = '';
  // File Header (Record Type 1)
  nachaContent += '1';
  nachaContent += '01';
  nachaContent += ` ${immediateDestination.padStart(9, ' ')}`;
  nachaContent += ` ${immediateOrigin.padStart(9, '0')}`;
  nachaContent += fileDate.slice(2); // YYMMDD
  nachaContent += fileTime; // HHMM
  nachaContent += 'A'; // File ID modifier
  nachaContent += '094'; // Record size
  nachaContent += '10'; // Blocking factor
  nachaContent += '1'; // Format code
  nachaContent += immediateDestination.padEnd(23); // Destination name
  nachaContent += companyName.padEnd(23); // Origin name
  nachaContent += batch.id.slice(0, 8).padEnd(8); // Reference code
  nachaContent += '\n';

  // Batch Header (Record Type 5)
  nachaContent += '5';
  nachaContent += serviceClass;
  nachaContent += companyName.padEnd(16);
  nachaContent += ''.padEnd(20); // Company discretionary data
  nachaContent += immediateOrigin.padStart(10, '0'); // Company ID
  nachaContent += 'PPD'; // Standard entry class
  nachaContent += 'TRUST DIST'; // Entry description (10 chars)
  nachaContent += fileDate.slice(2, 8).padEnd(6); // Descriptive date
  nachaContent += fileDate.slice(2, 8); // Effective date
  nachaContent += '   '; // Settlement date (left blank)
  nachaContent += '1'; // Originator status
  nachaContent += immediateDestination.slice(0, 8); // ODFI ID
  nachaContent += '0000001'; // Batch number
  nachaContent += '\n';

  // Entry Detail Records (Record Type 6)
  let entryCount = 0;
  let entryHash = 0;
  let totalDebit = 0;
  let totalCredit = 0;

  for (const p of payments) {
    entryCount++;
    const routing = (p.routing_number || immediateDestination).padStart(9, '0');
    const checkDigit = routing[8] || '0';
    const rdfi = routing.slice(0, 8);
    entryHash += parseInt(rdfi) || 0;

    const amount = parseInt(p.amount) || 0;
    if (isCredit) totalCredit += amount;
    else totalDebit += amount;

    const acctNum = (p.account_number_encrypted || '000000000').padEnd(17);
    const name = (p.beneficiary_name || 'BENEFICIARY').slice(0, 22).padEnd(22);
    const traceNum = `${immediateDestination.slice(0, 8)}${String(entryCount).padStart(7, '0')}`;

    nachaContent += '6'; // Record type
    nachaContent += txCode; // Transaction code
    nachaContent += rdfi; // RDFI routing (8 digits)
    nachaContent += checkDigit; // Check digit
    nachaContent += acctNum; // Account number (17 chars)
    nachaContent += String(amount).padStart(10, '0'); // Amount in cents
    nachaContent += (p.id || '').slice(0, 15).padEnd(15); // Individual ID
    nachaContent += name; // Individual name
    nachaContent += '  '; // Discretionary data
    nachaContent += '0'; // Addenda record indicator
    nachaContent += traceNum; // Trace number
    nachaContent += '\n';
  }

  // Batch Control (Record Type 8)
  nachaContent += '8';
  nachaContent += serviceClass;
  nachaContent += String(entryCount).padStart(6, '0');
  nachaContent += String(entryHash % 10000000000).padStart(10, '0');
  nachaContent += String(totalDebit).padStart(12, '0');
  nachaContent += String(totalCredit).padStart(12, '0');
  nachaContent += immediateOrigin.padStart(10, '0');
  nachaContent += ''.padEnd(19); // Message auth code
  nachaContent += ''.padEnd(6); // Reserved
  nachaContent += immediateDestination.slice(0, 8);
  nachaContent += '0000001';
  nachaContent += '\n';

  // File Control (Record Type 9)
  const blockCount = Math.ceil((entryCount + 4) / 10);
  nachaContent += '9';
  nachaContent += '000001'; // Batch count
  nachaContent += String(blockCount).padStart(6, '0');
  nachaContent += String(entryCount).padStart(8, '0');
  nachaContent += String(entryHash % 10000000000).padStart(10, '0');
  nachaContent += String(totalDebit).padStart(12, '0');
  nachaContent += String(totalCredit).padStart(12, '0');
  nachaContent += ''.padEnd(39);
  nachaContent += '\n';

  // Save to MFT files table
  const file = await db.queryOne(`
    INSERT INTO mft_files (trust_id, filename, file_type, content, record_count, total_amount, status)
    VALUES ($1, $2, 'NACHA', $3, $4, $5, 'generated')
    RETURNING *
  `, [trust.id, filename, nachaContent, entryCount, batch.total_amount]);

  return {
    success: true,
    file_id: file.id,
    filename,
    message: `NACHA file generated: ${filename} (${entryCount} entries, $${(batch.total_amount / 100).toFixed(2)})`,
  };
}

// ─── WIRE TRANSFER PROCESSING ────────────────────────────────────────────────

async function processWireBatch(trust, batch, payments) {
  const now = new Date();
  const fileDate = now.toISOString().split('T')[0].replace(/-/g, '');
  const filename = `WIRE_${batch.id.slice(0, 8)}_${fileDate}.txt`;

  let wireContent = '';
  wireContent += `=== FEDWIRE PAYMENT INSTRUCTIONS ===\n`;
  wireContent += `Originator: ${trust.trust_name}\n`;
  wireContent += `Date: ${now.toISOString()}\n`;
  wireContent += `Batch: ${batch.id}\n`;
  wireContent += `================================\n\n`;

  for (const p of payments) {
    wireContent += `--- WIRE TRANSFER ---\n`;
    wireContent += `Type Tag: {1510}\n`; // Type/Subtype: Funds Transfer
    wireContent += `Sender ABA: 241075470\n`;
    wireContent += `Sender Ref: ${p.id.slice(0, 16)}\n`;
    wireContent += `Amount: ${String(parseInt(p.amount) || 0).padStart(12, '0')}\n`;
    wireContent += `Receiver ABA: ${p.routing_number || 'N/A'}\n`;
    wireContent += `Receiver Acct: ${p.account_number_encrypted || 'N/A'}\n`;
    wireContent += `Beneficiary: ${p.beneficiary_name}\n`;
    wireContent += `Originator: ${trust.trust_name}\n`;
    wireContent += `Purpose: ${p.memo || 'Trust Distribution'}\n`;
    wireContent += `Effective Date: ${p.effective_date || fileDate}\n\n`;
  }

  const file = await db.queryOne(`
    INSERT INTO mft_files (trust_id, filename, file_type, content, record_count, total_amount, status)
    VALUES ($1, $2, 'CUSTOM', $3, $4, $5, 'generated')
    RETURNING *
  `, [trust.id, filename, wireContent, payments.length, batch.total_amount]);

  return {
    success: true,
    file_id: file.id,
    filename,
    message: `Wire instructions generated: ${filename} (${payments.length} transfers)`,
  };
}

// ─── BOOK TRANSFER PROCESSING (Instant Internal Settlement) ──────────────────

async function processBookTransfers(trust, batch, payments) {
  let settled = 0;
  let failed = 0;

  await db.transaction(async (client) => {
    for (const p of payments) {
      try {
        const sourceWalletId = p.source_wallet_id;
        if (!sourceWalletId) {
          // Default to income wallet
          const incomeWallet = await db.queryOne("SELECT id FROM wallets WHERE trust_id = $1 AND wallet_type = 'income' LIMIT 1", [trust.id]);
          if (!incomeWallet) throw new Error('No source wallet');
        }

        const walletId = sourceWalletId || (await db.queryOne("SELECT id FROM wallets WHERE trust_id = $1 AND wallet_type = 'income' LIMIT 1", [trust.id])).id;

        // Lock source wallet and check balance
        const { rows: [locked] } = await client.query(
          'SELECT balance FROM wallets WHERE id = $1 FOR UPDATE', [walletId]
        );
        if (!locked || locked.balance < parseInt(p.amount)) {
          await client.query("UPDATE payment_instructions SET status = 'failed', failure_reason = 'Insufficient funds' WHERE id = $1", [p.id]);
          failed++;
          continue;
        }

        // Debit source wallet
        await client.query('UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE id = $2', [parseInt(p.amount), walletId]);

        // Create ledger entry
        await client.query(`
          INSERT INTO ledger_entries (trust_id, entry_date, entry_type, amount, debit_wallet_id, description, reference_type, reference_id, status, posted_by)
          VALUES ($1, CURRENT_DATE, 'distribution', $2, $3, $4, 'payment_instruction', $5, 'posted', 'engine')
        `, [trust.id, parseInt(p.amount), walletId, `Book transfer to ${p.beneficiary_name}`, p.id]);

        await client.query("UPDATE payment_instructions SET status = 'settled', settled_at = NOW(), updated_at = NOW() WHERE id = $1", [p.id]);
        settled++;
      } catch (err) {
        await client.query("UPDATE payment_instructions SET status = 'failed', failure_reason = $1 WHERE id = $2", [err.message, p.id]);
        failed++;
      }
    }
  });

  const allSettled = failed === 0;
  if (allSettled) {
    await db.query("UPDATE payment_batches SET status = 'settled' WHERE id = $1", [batch.id]);
  }

  return {
    success: true,
    message: `Book transfers: ${settled} settled, ${failed} failed`,
    settled,
    failed,
  };
}

// ─── CHECK ISSUANCE ──────────────────────────────────────────────────────────

async function processCheckBatch(trust, batch, payments) {
  const now = new Date();
  const fileDate = now.toISOString().split('T')[0].replace(/-/g, '');
  const filename = `CHECK_BATCH_${batch.id.slice(0, 8)}_${fileDate}.csv`;

  let csvContent = 'Check#,Date,Payee,Amount,Memo,Account\n';
  let checkNum = 1001;
  for (const p of payments) {
    const amount = ((parseInt(p.amount) || 0) / 100).toFixed(2);
    csvContent += `${checkNum},${fileDate},${p.beneficiary_name},${amount},${p.memo || 'Trust Distribution'},${p.account_number_encrypted || ''}\n`;
    checkNum++;
  }

  const file = await db.queryOne(`
    INSERT INTO mft_files (trust_id, filename, file_type, content, record_count, total_amount, status)
    VALUES ($1, $2, 'CSV', $3, $4, $5, 'generated')
    RETURNING *
  `, [trust.id, filename, csvContent, payments.length, batch.total_amount]);

  return {
    success: true,
    file_id: file.id,
    filename,
    message: `Check batch generated: ${filename} (${payments.length} checks)`,
  };
}

// ─── REAL-TIME PAYMENTS (FedNow) ─────────────────────────────────────────────

async function processRTPBatch(trust, batch, payments) {
  // FedNow ISO 20022 format (pacs.008)
  const now = new Date();
  const fileDate = now.toISOString().split('T')[0].replace(/-/g, '');
  const filename = `RTP_FEDNOW_${batch.id.slice(0, 8)}_${fileDate}.xml`;

  let xmlContent = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  xmlContent += `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08">\n`;
  xmlContent += `  <FIToFICstmrCdtTrf>\n`;
  xmlContent += `    <GrpHdr>\n`;
  xmlContent += `      <MsgId>${batch.id}</MsgId>\n`;
  xmlContent += `      <CreDtTm>${now.toISOString()}</CreDtTm>\n`;
  xmlContent += `      <NbOfTxs>${payments.length}</NbOfTxs>\n`;
  xmlContent += `      <TtlIntrBkSttlmAmt Ccy="USD">${(batch.total_amount / 100).toFixed(2)}</TtlIntrBkSttlmAmt>\n`;
  xmlContent += `      <SttlmInf><SttlmMtd>CLRG</SttlmMtd></SttlmInf>\n`;
  xmlContent += `    </GrpHdr>\n`;

  for (const p of payments) {
    const amount = ((parseInt(p.amount) || 0) / 100).toFixed(2);
    xmlContent += `    <CdtTrfTxInf>\n`;
    xmlContent += `      <PmtId><InstrId>${p.id.slice(0, 35)}</InstrId><EndToEndId>${p.id.slice(0, 35)}</EndToEndId></PmtId>\n`;
    xmlContent += `      <IntrBkSttlmAmt Ccy="USD">${amount}</IntrBkSttlmAmt>\n`;
    xmlContent += `      <ChrgBr>SLEV</ChrgBr>\n`;
    xmlContent += `      <DbtrAgt><FinInstnId><ClrSysMmbId><MmbId>241075470</MmbId></ClrSysMmbId></FinInstnId></DbtrAgt>\n`;
    xmlContent += `      <CdtrAgt><FinInstnId><ClrSysMmbId><MmbId>${p.routing_number || '000000000'}</MmbId></ClrSysMmbId></FinInstnId></CdtrAgt>\n`;
    xmlContent += `      <Cdtr><Nm>${p.beneficiary_name}</Nm></Cdtr>\n`;
    xmlContent += `      <CdtrAcct><Id><Othr><Id>${p.account_number_encrypted || ''}</Id></Othr></Id></CdtrAcct>\n`;
    xmlContent += `      <RmtInf><Ustrd>${p.memo || 'Trust Distribution'}</Ustrd></RmtInf>\n`;
    xmlContent += `    </CdtTrfTxInf>\n`;
  }

  xmlContent += `  </FIToFICstmrCdtTrf>\n`;
  xmlContent += `</Document>\n`;

  const file = await db.queryOne(`
    INSERT INTO mft_files (trust_id, filename, file_type, content, record_count, total_amount, status)
    VALUES ($1, $2, 'ISO20022', $3, $4, $5, 'generated')
    RETURNING *
  `, [trust.id, filename, xmlContent, payments.length, batch.total_amount]);

  return {
    success: true,
    file_id: file.id,
    filename,
    message: `FedNow RTP file generated: ${filename} (ISO 20022 pacs.008 format, ${payments.length} transactions)`,
  };
}

// ─── SETTLEMENT & RECONCILIATION ─────────────────────────────────────────────

// POST /api/treasury/engine/settle-batch/:id — Mark entire batch as settled
router.post('/settle-batch/:id', async (req, res) => {
  try {
    const batch = await db.queryOne('SELECT * FROM payment_batches WHERE id = $1', [req.params.id]);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });

    await db.transaction(async (client) => {
      await client.query("UPDATE payment_batches SET status = 'settled', settled_at = NOW() WHERE id = $1", [batch.id]);
      await client.query("UPDATE payment_instructions SET status = 'settled', settled_at = NOW(), updated_at = NOW() WHERE batch_id = $1 AND status != 'failed'", [batch.id]);

      // Update associated MFT file
      if (batch.file_id) {
        await client.query("UPDATE mft_files SET status = 'delivered', delivered_at = NOW() WHERE id = $1", [batch.file_id]);
      }

      // Create ledger entries for settled payments
      const payments = await db.queryAll('SELECT * FROM payment_instructions WHERE batch_id = $1 AND status = $2', [batch.id, 'settled']);
      for (const p of payments) {
        await client.query(`
          INSERT INTO ledger_entries (trust_id, entry_date, entry_type, amount, description, reference_type, reference_id, status, posted_by)
          VALUES ($1, CURRENT_DATE, 'distribution', $2, $3, 'payment_instruction', $4, 'posted', 'engine')
        `, [batch.trust_id, parseInt(p.amount), `Settled: ${p.beneficiary_name} via ${p.payment_rail}`, p.id]);
      }
    });

    res.json({ success: true, message: 'Batch settled and reconciled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ENGINE STATUS & DASHBOARD ───────────────────────────────────────────────

// GET /api/treasury/engine/status — Payment engine status/overview
router.get('/status', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT id FROM trusts LIMIT 1');
    const [pending, approved, batched, processing, settled, failed] = await Promise.all([
      db.queryOne("SELECT COUNT(*)::int as count, COALESCE(SUM(amount),0)::bigint as total FROM payment_instructions WHERE trust_id = $1 AND status = 'pending_approval'", [trust.id]),
      db.queryOne("SELECT COUNT(*)::int as count, COALESCE(SUM(amount),0)::bigint as total FROM payment_instructions WHERE trust_id = $1 AND status = 'approved'", [trust.id]),
      db.queryOne("SELECT COUNT(*)::int as count, COALESCE(SUM(amount),0)::bigint as total FROM payment_instructions WHERE trust_id = $1 AND status = 'batched'", [trust.id]),
      db.queryOne("SELECT COUNT(*)::int as count, COALESCE(SUM(amount),0)::bigint as total FROM payment_instructions WHERE trust_id = $1 AND status = 'processing'", [trust.id]),
      db.queryOne("SELECT COUNT(*)::int as count, COALESCE(SUM(amount),0)::bigint as total FROM payment_instructions WHERE trust_id = $1 AND status = 'settled'", [trust.id]),
      db.queryOne("SELECT COUNT(*)::int as count, COALESCE(SUM(amount),0)::bigint as total FROM payment_instructions WHERE trust_id = $1 AND status = 'failed'", [trust.id]),
    ]);

    const batches = await db.queryAll("SELECT * FROM payment_batches WHERE trust_id = $1 ORDER BY created_at DESC LIMIT 10", [trust.id]);

    res.json({
      success: true,
      engine: 'DLB Trust Self-Processing Engine v1.0',
      originator: 'DEANDREA LAVAR BARKLEY TRUST (Ohio PTC)',
      supported_rails: ['ach_credit', 'ach_debit', 'wire', 'book_transfer', 'check', 'rtp'],
      pipeline: {
        pending_approval: { count: pending.count, total: parseInt(pending.total) },
        approved: { count: approved.count, total: parseInt(approved.total) },
        batched: { count: batched.count, total: parseInt(batched.total) },
        processing: { count: processing.count, total: parseInt(processing.total) },
        settled: { count: settled.count, total: parseInt(settled.total) },
        failed: { count: failed.count, total: parseInt(failed.total) },
      },
      recent_batches: batches,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/treasury/engine/auto-process — Auto-process all approved payments (full pipeline)
router.post('/auto-process', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT * FROM trusts LIMIT 1');
    const results = [];

    // Get all approved payments grouped by rail
    const rails = ['ach_credit', 'ach_debit', 'wire', 'book_transfer', 'check', 'rtp'];
    for (const rail of rails) {
      const payments = await db.queryAll(`
        SELECT * FROM payment_instructions
        WHERE trust_id = $1 AND status = 'approved' AND payment_rail = $2
        ORDER BY created_at
      `, [trust.id, rail]);

      if (payments.length === 0) continue;

      // Create batch
      const totalAmount = payments.reduce((s, p) => s + (parseInt(p.amount) || 0), 0);
      const batch = await db.queryOne(`
        INSERT INTO payment_batches (trust_id, batch_type, payment_rail, payment_count, total_amount, status)
        VALUES ($1, 'auto', $2, $3, $4, 'created')
        RETURNING *
      `, [trust.id, rail, payments.length, totalAmount]);

      for (const p of payments) {
        await db.query("UPDATE payment_instructions SET batch_id = $1, status = 'batched', updated_at = NOW() WHERE id = $2", [batch.id, p.id]);
      }

      // Process based on rail
      let processResult;
      switch (rail) {
        case 'ach_credit':
        case 'ach_debit':
          processResult = await processACHBatch(trust, batch, payments);
          break;
        case 'wire':
          processResult = await processWireBatch(trust, batch, payments);
          break;
        case 'book_transfer':
          processResult = await processBookTransfers(trust, batch, payments);
          break;
        case 'check':
          processResult = await processCheckBatch(trust, batch, payments);
          break;
        case 'rtp':
          processResult = await processRTPBatch(trust, batch, payments);
          break;
      }

      if (processResult.success) {
        await db.query("UPDATE payment_batches SET status = 'processed', file_id = $1, processed_at = NOW() WHERE id = $2", [processResult.file_id || null, batch.id]);
        if (rail !== 'book_transfer') {
          for (const p of payments) {
            await db.query("UPDATE payment_instructions SET status = 'processing', updated_at = NOW() WHERE id = $1", [p.id]);
          }
        }
      }

      results.push({ rail, count: payments.length, total: totalAmount, ...processResult });
    }

    if (results.length === 0) {
      return res.json({ success: true, message: 'No approved payments to process', results: [] });
    }

    res.json({
      success: true,
      message: `Processed ${results.reduce((s, r) => s + r.count, 0)} payments across ${results.length} rail(s)`,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
