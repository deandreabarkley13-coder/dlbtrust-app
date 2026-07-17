'use strict';

/**
 * ACH Engine — orchestrates NACHA file generation, batch tracking, and AS2 transmission.
 * PostgreSQL-backed via fineract_tenants pool.
 */

const pool = require('../bonds/pgPool');
const { generateNACHAFile, parseNACHAFile, validateRouting } = require('./nachaGenerator');
const { AS2Client } = require('./as2Client');
const { AS2Partners } = require('./as2Partners');
const { OpenBankApi } = require('./openBankApi');
const path = require('path');
const fs = require('fs');
const paymentCrypto = require('../paymentHub/paymentCrypto');

const ACH_FILES_DIR = process.env.ACH_FILES_DIR || path.join(__dirname, '..', '..', '..', 'data', 'ach-files');

class ACHEngine {
  /**
   * Ensure the ach-files directory exists.
   */
  static ensureFilesDir() {
    if (!fs.existsSync(ACH_FILES_DIR)) {
      fs.mkdirSync(ACH_FILES_DIR, { recursive: true });
    }
  }

  /**
   * Create a new ACH batch from pending entries.
   * Each entry: { receivingRouting, accountNumber, amountCents, transactionCode,
   *               individualId, individualName, secCode, memo }
   *
   * @param {Object} opts - { effectiveDate, secCode, description, createdBy }
   * @param {Array} entries - payment entries
   * @returns {Object} batch record with generated NACHA content
   */
  static async createBatch(opts = {}, entries = []) {
    if (!entries.length) throw new Error('At least one entry is required');

    const creditCodes = new Set(['22', '23', '24', '32', '33', '34']);
    const debitCodes = new Set(['27', '28', '29', '37', '38', '39']);
    let hasCredits = false;
    let hasDebits = false;
    for (const entry of entries) {
      if (!entry.receivingRouting || !entry.accountNumber || entry.amountCents === undefined) {
        throw new Error('Each entry requires receivingRouting, accountNumber, amountCents');
      }
      if (!validateRouting(String(entry.receivingRouting))) {
        throw new Error(`Invalid routing number: ${entry.receivingRouting}`);
      }
      if (!/^\d{4,17}$/.test(String(entry.accountNumber))) throw new Error('ACH account number must be 4-17 digits');
      if (!Number.isSafeInteger(Number(entry.amountCents)) || Number(entry.amountCents) <= 0) {
        throw new Error('ACH entry amountCents must be a positive integer');
      }
      const transactionCode = String(entry.transactionCode || '22');
      if (creditCodes.has(transactionCode)) hasCredits = true;
      else if (debitCodes.has(transactionCode)) hasDebits = true;
      else throw new Error(`Unsupported ACH transaction code: ${transactionCode}`);
    }

    const batchId = 'ACH-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const effectiveDate = opts.effectiveDate || new Date().toISOString().split('T')[0];
    const secCode = opts.secCode || 'CCD';
    const description = opts.description || 'PAYMENT';
    const serviceClassCode = hasCredits && hasDebits ? '200' : hasDebits ? '225' : '220';

    const nachaContent = generateNACHAFile(opts.nachaConfig || {}, [{
      secCode,
      companyEntryDescription: description,
      effectiveEntryDate: effectiveDate,
      serviceClassCode,
      entries: entries.map(e => ({
        receivingRouting: e.receivingRouting,
        accountNumber: e.accountNumber,
        amountCents: e.amountCents,
        transactionCode: e.transactionCode || '22',
        individualId: e.individualId || '',
        individualName: e.individualName || '',
      })),
    }]);

    const totalCents = entries.reduce((sum, e) => sum + Number(e.amountCents), 0);
    const filename = `${batchId}.ach`;
    const encryptedContent = paymentCrypto.encrypt(nachaContent);

    ACHEngine.ensureFilesDir();
    const filePath = path.join(ACH_FILES_DIR, `${filename}.enc`);
    fs.writeFileSync(filePath, encryptedContent, { mode: 0o600 });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO ach_batches
          (batch_id, filename, status, sec_code, entry_description,
           effective_date, entry_count, total_amount_cents, nacha_content,
           file_path, created_by, partner_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
         RETURNING *`,
        [batchId, filename, 'pending', secCode, description,
         effectiveDate, entries.length, totalCents, encryptedContent,
         filePath, opts.createdBy || 'system', opts.partnerId || null]
      );

      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        await client.query(
          `INSERT INTO ach_entries
            (batch_id, entry_sequence, transaction_code, receiving_routing,
             account_number, amount_cents, individual_id, individual_name, memo)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [batchId, i + 1, e.transactionCode || '22', e.receivingRouting,
           paymentCrypto.mask(e.accountNumber), e.amountCents, e.individualId || '',
           e.individualName || '', e.memo || '']
        );
      }
      await client.query('COMMIT');
      const { nacha_content: encryptedNacha, file_path: storedFilePath, ...publicBatch } = result.rows[0];
      return publicBatch;
    } catch (err) {
      await client.query('ROLLBACK');
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get a batch by ID.
   */
  static async getBatch(batchId) {
    const batch = await pool.query('SELECT * FROM ach_batches WHERE batch_id = $1', [batchId]);
    if (!batch.rows.length) return null;

    const entries = await pool.query(
      'SELECT * FROM ach_entries WHERE batch_id = $1 ORDER BY entry_sequence',
      [batchId]
    );

    const { nacha_content: encryptedContent, file_path: filePath, ...publicBatch } = batch.rows[0];
    return {
      ...publicBatch,
      entries: entries.rows.map(entry => ({
        ...entry,
        receiving_routing: paymentCrypto.mask(entry.receiving_routing),
        account_number: paymentCrypto.mask(entry.account_number),
      })),
    };
  }

  /**
   * List batches with optional filters.
   */
  static async listBatches({ status, fromDate, toDate, limit = 50, offset = 0 } = {}) {
    let sql = 'SELECT * FROM ach_batches WHERE 1=1';
    const params = [];
    let idx = 1;

    if (status) {
      sql += ` AND status = $${idx++}`;
      params.push(status);
    }
    if (fromDate) {
      sql += ` AND created_at >= $${idx++}`;
      params.push(fromDate);
    }
    if (toDate) {
      sql += ` AND created_at <= $${idx++}`;
      params.push(toDate);
    }

    sql += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await pool.query(sql, params);
    return result.rows.map(row => {
      const { nacha_content: encryptedContent, file_path: filePath, ...publicBatch } = row;
      return publicBatch;
    });
  }

  /**
   * Transmit a batch via AS2 to the bank.
   * Looks up batch.partner_id to route to the correct AS2 partner.
   * Falls back to default partner or global AS2_CONFIG if no partner_id.
   */
  static async transmitBatch(batchId) {
    const batch = await ACHEngine.getBatch(batchId);
    if (!batch) throw new Error(`Batch not found: ${batchId}`);
    const file = await ACHEngine.downloadBatch(batchId);
    const nonTransmittable = ['transmitting', 'transmitted', 'accepted', 'settled', 'returned', 'cancelled'];
    if (nonTransmittable.includes(batch.status)) {
      throw new Error(`Cannot transmit batch in '${batch.status}' status — only 'pending' or 'failed' batches can be transmitted`);
    }

    const nachaContent = file.nacha_content;
    if (!nachaContent) throw new Error('Batch has no NACHA content');

    const { SystemSettings } = require('./systemSettings');
    const systemMode = await SystemSettings.getMode();
    if (process.env.NODE_ENV === 'production' && systemMode !== 'production') {
      throw new Error('ACH transmission blocked: System Settings must be in production mode');
    }
    let partnerConfig = batch.partner_id
      ? await AS2Partners.getPartnerConfig(batch.partner_id)
      : null;

    if (systemMode === 'production') {
      if (!partnerConfig) partnerConfig = await SystemSettings.getProductionPartnerConfig();
      if (!partnerConfig) {
        throw new Error('ACH transmission blocked: no production ODFI endpoint is configured');
      }
      if (partnerConfig.protocol === 'as2' && process.env.AS2_PRODUCTION_APPROVED !== 'true') {
        throw new Error('ACH transmission blocked: AS2 bank certification is not approved');
      }
      console.log(`[ACH] transmitBatch(${batchId}): PRODUCTION MODE → ${partnerConfig.partnerName}`);
    } else {
      if (!partnerConfig) partnerConfig = await AS2Partners.getDefaultPartnerConfig();
      if (!partnerConfig) {
        partnerConfig = {
          partnerId: batch.partner_id || 'DLBTRUST-DIRECT',
          partnerName: 'DLB Trust Direct',
          protocol: 'rest_api',
          apiBaseUrl: 'direct',
          localAs2Id: 'DLBTRUST-AS2',
        };
      }
    }

    // Update status to transmitting
    console.log(`[ACH] transmitBatch(${batchId}): partner=${partnerConfig.partnerId}, protocol=${partnerConfig.protocol}, mode=${systemMode}`);
    await pool.query(
      `UPDATE ach_batches SET status = 'transmitting', updated_at = NOW() WHERE batch_id = $1`,
      [batchId]
    );

    try {
      // Route through a configured outbound bank connector.
      const protocol = partnerConfig.protocol || 'rest_api';
      console.log(`[ACH] transmitBatch(${batchId}): calling ${protocol} transmit`);

      let result;
      if (protocol === 'bill_api') {
        throw new Error('BILL deposit recording cannot transmit outbound ACH batches');
      }
      result = protocol === 'rest_api'
        ? await OpenBankApi.transmit(nachaContent, batch.filename, partnerConfig)
        : await AS2Client.transmit(nachaContent, batch.filename, partnerConfig);

      console.log(`[ACH] transmitBatch(${batchId}): transmit result success=${result.success}, mode=${result.mode}`);
      const publicResult = { ...result };
      delete publicResult.response_body;
      delete publicResult.response_headers;
      delete publicResult.export_path;

      // Record transmission with system mode
      await pool.query(
        `INSERT INTO ach_transmissions
          (batch_id, transmission_id, message_id, status_code,
           mdn_received, response_body, transmitted_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [batchId,
         'TX-' + Date.now(),
         result.message_id,
         result.status_code,
         result.mdn_received,
         result.response_body || '']
      );

      const newStatus = result.success ? 'transmitted' : 'failed';
      await pool.query(
        `UPDATE ach_batches SET status = $1, transmitted_at = NOW(), updated_at = NOW() WHERE batch_id = $2`,
        [newStatus, batchId]
      );

      // Update entry statuses on successful transmission
      if (result.success) {
        await pool.query(
          `UPDATE ach_entries SET status = 'transmitted' WHERE batch_id = $1 AND status = 'pending'`,
          [batchId]
        );

        // In PRODUCTION mode: do NOT auto-accept — wait for external bank confirmation
        // In SANDBOX mode: auto-accept on self-transmit
        if (systemMode === 'production') {
          console.log(`[ACH] transmitBatch(${batchId}): PRODUCTION — transmitted to external bank, awaiting confirmation`);
          return { ...publicResult, batch_id: batchId, batch_status: 'transmitted', system_mode: 'production', awaiting_confirmation: true };
        }

        // Sandbox: Auto-accept on self-transmit
        const isSelfTransmit = result.mode === 'remote' && partnerConfig.partnerId === 'DLBTRUST-DIRECT';
        if (isSelfTransmit) {
          console.log(`[ACH] transmitBatch(${batchId}): self-transmit success → auto-accepting`);
          await pool.query(
            `UPDATE ach_batches SET status = 'accepted', accepted_at = NOW(), updated_at = NOW() WHERE batch_id = $1`,
            [batchId]
          );
          await pool.query(
            `UPDATE ach_entries SET status = 'accepted' WHERE batch_id = $1 AND status = 'transmitted'`,
            [batchId]
          );
          return { ...publicResult, batch_id: batchId, batch_status: 'accepted', auto_accepted: true, system_mode: 'sandbox' };
        }
      }

      return { ...publicResult, batch_id: batchId, batch_status: newStatus, system_mode: systemMode };
    } catch (err) {
      console.error(`[ACH] transmitBatch(${batchId}) FAILED:`, err.message);
      await pool.query(
        `UPDATE ach_batches SET status = 'failed', error_message = $1, updated_at = NOW() WHERE batch_id = $2`,
        [err.message, batchId]
      ).catch(e => console.error(`[ACH] Failed to set batch status to failed:`, e.message));
      throw err;
    }
  }

  /**
   * Transition a batch to 'accepted' after bank acknowledgement.
   */
  static async acceptBatch(batchId, metadata = {}) {
    const batch = await ACHEngine.getBatch(batchId);
    if (!batch) throw new Error(`Batch not found: ${batchId}`);
    if (batch.status !== 'transmitted') {
      throw new Error(`Batch must be in 'transmitted' status to accept, current: ${batch.status}`);
    }

    await pool.query(
      `UPDATE ach_batches SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
       WHERE batch_id = $1`,
      [batchId]
    );

    // Update entry statuses
    await pool.query(
      `UPDATE ach_entries SET status = 'accepted' WHERE batch_id = $1 AND status = 'transmitted'`,
      [batchId]
    );

    // Record acknowledgement (best-effort — don't fail the accept if ack insert has constraint issues)
    if (!metadata.skipAckRecord && (metadata.transmissionId || metadata.messageId)) {
      const validAckTypes = ['mdn', 'file_ack', 'bank_ack'];
      const ackType = validAckTypes.includes(metadata.ackType) ? metadata.ackType : 'bank_ack';
      try {
        await pool.query(
          `INSERT INTO ach_acknowledgements
            (batch_id, transmission_id, ack_type, ack_status, message_id, raw_response, disposition, received_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
          [batchId, metadata.transmissionId || null, ackType,
           'accepted', metadata.messageId || null,
           metadata.rawResponse || null, metadata.disposition || null]
        );
      } catch (ackErr) {
        console.warn(`[ACH] acceptBatch(${batchId}): ack record insert failed (non-fatal):`, ackErr.message);
      }
    }

    return ACHEngine.getBatch(batchId);
  }

  /**
   * Transition a batch to 'settled' after bank confirms settlement.
   */
  static async settleBatch(batchId, metadata = {}) {
    const batch = await ACHEngine.getBatch(batchId);
    if (!batch) throw new Error(`Batch not found: ${batchId}`);
    if (batch.status !== 'accepted' && batch.status !== 'transmitted') {
      throw new Error(`Batch must be in 'accepted' or 'transmitted' status to settle, current: ${batch.status}`);
    }
    if (!metadata.processorConfirmed || !metadata.settlementRef) {
      throw new Error('ACH settlement requires processor confirmation and a settlement reference');
    }

    const settlementDate = metadata.settlementDate || new Date().toISOString().split('T')[0];

    await pool.query(
      `UPDATE ach_batches
       SET status = 'settled', settled_at = NOW(), settlement_date = $2, updated_at = NOW()
       WHERE batch_id = $1`,
      [batchId, settlementDate]
    );

    // Update entry statuses
    await pool.query(
      `UPDATE ach_entries SET status = 'settled', settled_at = NOW()
       WHERE batch_id = $1 AND status IN ('transmitted', 'accepted')`,
      [batchId]
    );

    return ACHEngine.getBatch(batchId);
  }

  /**
   * Process an ACH return for individual entries in a batch.
   * Marks affected entries with return codes and transitions batch if all entries returned.
   *
   * @param {string} batchId
   * @param {Array} returnEntries - [{ entrySequence|traceNumber, returnCode, returnReason, returnAmountCents, returnDate, addendaInfo }]
   * @param {Object} metadata - { returnFileRef }
   */
  static async processReturns(batchId, returnEntries = [], metadata = {}) {
    const batch = await ACHEngine.getBatch(batchId);
    if (!batch) throw new Error(`Batch not found: ${batchId}`);
    if (!['transmitted', 'accepted', 'settled'].includes(batch.status)) {
      throw new Error(`Batch must be in transmitted/accepted/settled to process returns, current: ${batch.status}`);
    }
    if (!returnEntries.length) throw new Error('At least one return entry is required');

    const processedReturns = [];

    for (const ret of returnEntries) {
      // Find the matching entry
      let entryRow;
      if (ret.traceNumber) {
        const r = await pool.query(
          'SELECT * FROM ach_entries WHERE batch_id = $1 AND trace_number = $2',
          [batchId, ret.traceNumber]
        );
        entryRow = r.rows[0];
      }
      if (!entryRow && ret.entrySequence) {
        const r = await pool.query(
          'SELECT * FROM ach_entries WHERE batch_id = $1 AND entry_sequence = $2',
          [batchId, ret.entrySequence]
        );
        entryRow = r.rows[0];
      }

      const entryId = entryRow ? entryRow.id : null;

      // Insert return record
      const returnResult = await pool.query(
        `INSERT INTO ach_returns
          (batch_id, entry_id, original_trace, return_code, return_reason,
           return_amount_cents, return_date, addenda_info, return_file_ref, processed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW()) RETURNING *`,
        [batchId, entryId, ret.traceNumber || null, ret.returnCode, ret.returnReason,
         ret.returnAmountCents || (entryRow ? entryRow.amount_cents : null),
         ret.returnDate || new Date().toISOString().split('T')[0],
         ret.addendaInfo || null, metadata.returnFileRef || null]
      );
      processedReturns.push(returnResult.rows[0]);

      // Update entry with return info
      if (entryId) {
        await pool.query(
          `UPDATE ach_entries
           SET status = 'returned', return_code = $2, return_reason = $3, returned_at = NOW()
           WHERE id = $1`,
          [entryId, ret.returnCode, ret.returnReason]
        );
      }
    }

    // Check if all entries are now returned — if so, mark batch as returned
    const remaining = await pool.query(
      `SELECT COUNT(*) as count FROM ach_entries WHERE batch_id = $1 AND status != 'returned'`,
      [batchId]
    );
    const allReturned = parseInt(remaining.rows[0].count, 10) === 0;

    if (allReturned) {
      await pool.query(
        `UPDATE ach_batches
         SET status = 'returned', returned_at = NOW(),
             return_code = $2, return_reason = $3, updated_at = NOW()
         WHERE batch_id = $1`,
        [batchId, returnEntries[0].returnCode, returnEntries[0].returnReason]
      );
    } else {
      await pool.query(
        `UPDATE ach_batches SET updated_at = NOW() WHERE batch_id = $1`,
        [batchId]
      );
    }

    const updatedBatch = await pool.query('SELECT * FROM ach_batches WHERE batch_id = $1', [batchId]);
    return {
      batch: updatedBatch.rows[0],
      returns_processed: processedReturns.length,
      all_entries_returned: allReturned,
      returns: processedReturns,
    };
  }

  /**
   * Get returns for a batch.
   */
  static async getReturns(batchId) {
    const result = await pool.query(
      'SELECT * FROM ach_returns WHERE batch_id = $1 ORDER BY processed_at DESC',
      [batchId]
    );
    return result.rows;
  }

  /**
   * Get acknowledgements for a batch.
   */
  static async getAcknowledgements(batchId) {
    const result = await pool.query(
      'SELECT * FROM ach_acknowledgements WHERE batch_id = $1 ORDER BY received_at DESC',
      [batchId]
    );
    return result.rows;
  }

  /**
   * Get entry-level status for a batch.
   */
  static async getEntryStatuses(batchId) {
    const result = await pool.query(
      `SELECT e.*, r.return_code as latest_return_code, r.return_reason as latest_return_reason, r.processed_at as return_processed_at
       FROM ach_entries e
       LEFT JOIN LATERAL (
         SELECT return_code, return_reason, processed_at FROM ach_returns
         WHERE entry_id = e.id ORDER BY processed_at DESC LIMIT 1
       ) r ON true
       WHERE e.batch_id = $1
       ORDER BY e.entry_sequence`,
      [batchId]
    );
    return result.rows.map(entry => ({
      ...entry,
      receiving_routing: paymentCrypto.mask(entry.receiving_routing),
      account_number: paymentCrypto.mask(entry.account_number),
    }));
  }

  /**
   * Cancel a pending batch.
   */
  static async cancelBatch(batchId) {
    const result = await pool.query(
      `UPDATE ach_batches SET status = 'cancelled', updated_at = NOW()
       WHERE batch_id = $1 AND status = 'pending' RETURNING *`,
      [batchId]
    );
    if (!result.rows.length) throw new Error(`Batch not found or not in pending status: ${batchId}`);
    return ACHEngine.getBatch(batchId);
  }

  /**
   * Get transmission history for a batch.
   */
  static async getTransmissions(batchId) {
    const result = await pool.query(
      'SELECT * FROM ach_transmissions WHERE batch_id = $1 ORDER BY transmitted_at DESC',
      [batchId]
    );
    return result.rows;
  }

  /**
   * Get AS2 pipeline status — config + connectivity.
   */
  static async getPipelineStatus() {
    const config = AS2Client.getConfigStatus();
    let connectivity = { connected: false, error: 'Not tested' };

    if (config.configured) {
      try {
        connectivity = await AS2Client.testConnection();
      } catch (e) {
        connectivity = { connected: false, error: e.message };
      }
    }

    const pendingBatches = await pool.query(
      "SELECT COUNT(*) as count FROM ach_batches WHERE status = 'pending'"
    );
    const transmittedToday = await pool.query(
      "SELECT COUNT(*) as count FROM ach_batches WHERE status = 'transmitted' AND transmitted_at::date = CURRENT_DATE"
    );
    const acceptedBatches = await pool.query(
      "SELECT COUNT(*) as count FROM ach_batches WHERE status = 'accepted'"
    );
    const settledBatches = await pool.query(
      "SELECT COUNT(*) as count FROM ach_batches WHERE status = 'settled'"
    );
    const returnedBatches = await pool.query(
      "SELECT COUNT(*) as count FROM ach_batches WHERE status = 'returned'"
    );
    const failedRecent = await pool.query(
      "SELECT COUNT(*) as count FROM ach_batches WHERE status = 'failed' AND created_at > NOW() - INTERVAL '7 days'"
    );

    return {
      as2_config: config,
      as2_connectivity: connectivity,
      pipeline: {
        pending_batches: parseInt(pendingBatches.rows[0].count, 10),
        transmitted_today: parseInt(transmittedToday.rows[0].count, 10),
        accepted_batches: parseInt(acceptedBatches.rows[0].count, 10),
        settled_batches: parseInt(settledBatches.rows[0].count, 10),
        returned_batches: parseInt(returnedBatches.rows[0].count, 10),
        failed_last_7_days: parseInt(failedRecent.rows[0].count, 10),
      },
    };
  }

  /**
   * Create a disbursement batch from CRM contacts with bank info.
   * Pulls contacts + their bank accounts, creates ACH entries.
   */
  static async createDisbursementBatch({ contactIds, amountCents, description, effectiveDate, createdBy }) {
    if (!contactIds || !contactIds.length) throw new Error('contactIds required');
    if (!amountCents || amountCents <= 0) throw new Error('amountCents must be positive');

    const placeholders = contactIds.map((_, i) => `$${i + 1}`).join(',');
    const contacts = await pool.query(
      `SELECT * FROM crm_contacts WHERE contact_id = ANY($1) AND status = 'active'`,
      [contactIds]
    );

    if (!contacts.rows.length) throw new Error('No active contacts found');

    const entries = [];
    for (const contact of contacts.rows) {
      if (!contact.routing_number || !contact.account_number) {
        continue; // skip contacts without bank info
      }
      entries.push({
        receivingRouting: contact.routing_number,
        accountNumber: contact.account_number,
        amountCents,
        transactionCode: contact.bank_account_type === 'savings' ? '32' : '22',
        individualId: contact.contact_id,
        individualName: `${contact.first_name} ${contact.last_name}`.substring(0, 22),
        memo: description || 'Trust Distribution',
      });
    }

    if (!entries.length) throw new Error('No contacts with bank account info found');

    return ACHEngine.createBatch({
      effectiveDate: effectiveDate || new Date().toISOString().split('T')[0],
      secCode: 'PPD',
      description: (description || 'TRUST DIST').substring(0, 10),
      createdBy,
    }, entries);
  }

  /**
   * Download NACHA file content for a batch.
   */
  static async downloadBatch(batchId) {
    const batch = await pool.query(
      'SELECT batch_id, filename, nacha_content FROM ach_batches WHERE batch_id = $1',
      [batchId]
    );
    if (!batch.rows.length) throw new Error(`Batch not found: ${batchId}`);
    return {
      ...batch.rows[0],
      nacha_content: paymentCrypto.decrypt(batch.rows[0].nacha_content),
    };
  }

  /**
   * Validate a NACHA file content string.
   */
  static validateNACHA(content) {
    try {
      const parsed = parseNACHAFile(content);
      const errors = [];

      if (!parsed.fileHeader) errors.push('Missing file header record');
      if (!parsed.batches.length) errors.push('No batch records found');
      if (!parsed.fileControl) errors.push('Missing file control record');

      for (const batch of parsed.batches) {
        if (!batch.entries.length) {
          errors.push(`Batch "${batch.companyName}" has no entries`);
        }
        if (batch.control) {
          if (batch.control.entryCount !== batch.entries.length) {
            errors.push(`Batch entry count mismatch: control=${batch.control.entryCount}, actual=${batch.entries.length}`);
          }
        }
      }

      return {
        valid: errors.length === 0,
        errors,
        parsed,
      };
    } catch (e) {
      return { valid: false, errors: [e.message], parsed: null };
    }
  }
}

module.exports = { ACHEngine };
