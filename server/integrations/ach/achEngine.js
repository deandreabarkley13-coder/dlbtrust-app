'use strict';

/**
 * ACH Engine — orchestrates NACHA file generation, batch tracking, and AS2 transmission.
 * PostgreSQL-backed via fineract_tenants pool.
 */

const pool = require('../bonds/pgPool');
const { generateNACHAFile, parseNACHAFile, validateRouting, ODFI_ROUTING, ORIGINATOR_ID } = require('./nachaGenerator');
const { AS2Client } = require('./as2Client');
const path = require('path');
const fs = require('fs');

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

    for (const entry of entries) {
      if (!entry.receivingRouting || !entry.accountNumber || !entry.amountCents) {
        throw new Error('Each entry requires receivingRouting, accountNumber, amountCents');
      }
      if (!validateRouting(String(entry.receivingRouting))) {
        throw new Error(`Invalid routing number: ${entry.receivingRouting}`);
      }
    }

    const batchId = 'ACH-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const effectiveDate = opts.effectiveDate || new Date().toISOString().split('T')[0];
    const secCode = opts.secCode || 'CCD';
    const description = opts.description || 'PAYMENT';

    const nachaContent = generateNACHAFile({}, [{
      secCode,
      companyEntryDescription: description,
      effectiveEntryDate: effectiveDate,
      serviceClassCode: '200',
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

    // Save to filesystem
    ACHEngine.ensureFilesDir();
    const filePath = path.join(ACH_FILES_DIR, filename);
    fs.writeFileSync(filePath, nachaContent);

    // Save to database
    const result = await pool.query(
      `INSERT INTO ach_batches
        (batch_id, filename, status, sec_code, entry_description,
         effective_date, entry_count, total_amount_cents, nacha_content,
         file_path, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       RETURNING *`,
      [batchId, filename, 'pending', secCode, description,
       effectiveDate, entries.length, totalCents, nachaContent,
       filePath, opts.createdBy || 'system']
    );

    // Save individual entries
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      await pool.query(
        `INSERT INTO ach_entries
          (batch_id, entry_sequence, transaction_code, receiving_routing,
           account_number, amount_cents, individual_id, individual_name, memo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [batchId, i + 1, e.transactionCode || '22', e.receivingRouting,
         e.accountNumber, e.amountCents, e.individualId || '',
         e.individualName || '', e.memo || '']
      );
    }

    return result.rows[0];
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

    return { ...batch.rows[0], entries: entries.rows };
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
    return result.rows;
  }

  /**
   * Transmit a batch via AS2 to the bank.
   */
  static async transmitBatch(batchId) {
    const batch = await ACHEngine.getBatch(batchId);
    if (!batch) throw new Error(`Batch not found: ${batchId}`);
    if (batch.status === 'transmitted') throw new Error(`Batch already transmitted: ${batchId}`);
    if (batch.status === 'cancelled') throw new Error(`Batch is cancelled: ${batchId}`);

    const nachaContent = batch.nacha_content;
    if (!nachaContent) throw new Error('Batch has no NACHA content');

    // Update status to transmitting
    await pool.query(
      `UPDATE ach_batches SET status = 'transmitting', updated_at = NOW() WHERE batch_id = $1`,
      [batchId]
    );

    try {
      const result = await AS2Client.transmit(nachaContent, batch.filename);

      // Record transmission
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

      return { ...result, batch_id: batchId, batch_status: newStatus };
    } catch (err) {
      await pool.query(
        `UPDATE ach_batches SET status = 'failed', error_message = $1, updated_at = NOW() WHERE batch_id = $2`,
        [err.message, batchId]
      );
      throw err;
    }
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
    return result.rows[0];
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
    const failedRecent = await pool.query(
      "SELECT COUNT(*) as count FROM ach_batches WHERE status = 'failed' AND created_at > NOW() - INTERVAL '7 days'"
    );

    return {
      as2_config: config,
      as2_connectivity: connectivity,
      pipeline: {
        pending_batches: parseInt(pendingBatches.rows[0].count, 10),
        transmitted_today: parseInt(transmittedToday.rows[0].count, 10),
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
    return batch.rows[0];
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
