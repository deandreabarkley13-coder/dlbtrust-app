'use strict';

/**
 * ACH Acknowledgement Ingestion — MDN and Bank Response Processing
 *
 * Handles delivery receipts (MDN) and bank file acknowledgements separately
 * from settlement, so the app can distinguish "file delivered" from "money settled."
 *
 * Acknowledgement types:
 *   mdn         — AS2 Message Disposition Notification (file delivery confirmation)
 *   file_ack    — Bank file-level acceptance (file parsed, entries queued)
 *   bank_ack    — Bank batch acceptance (entries validated, will process)
 *   rejection   — Bank rejected the file or batch
 */

const pool = require('../bonds/pgPool');
const { ACHEngine } = require('./achEngine');

class ACHAcknowledgement {

  /**
   * Process an MDN (Message Disposition Notification) from the bank.
   * MDN confirms the AS2 file was received, NOT that the money moved.
   *
   * @param {Object} mdn
   * @param {string} mdn.batchId - the batch this MDN relates to
   * @param {string} mdn.messageId - the original AS2 message-id
   * @param {string} mdn.disposition - MDN disposition value
   * @param {string} mdn.rawContent - full MDN body
   * @param {string} mdn.transmissionId - related transmission record
   * @returns {Object} acknowledgement record
   */
  static async processMDN(mdn) {
    const { batchId, messageId, disposition, rawContent, transmissionId } = mdn;

    if (!batchId) throw new Error('batchId is required');
    if (!disposition) throw new Error('disposition is required');

    const batch = await ACHEngine.getBatch(batchId);
    if (!batch) throw new Error(`Batch not found: ${batchId}`);

    // Determine ack status from disposition
    const isAccepted = disposition.toLowerCase().includes('processed') ||
                       disposition.toLowerCase().includes('dispatched');
    const isRejected = disposition.toLowerCase().includes('failed') ||
                       disposition.toLowerCase().includes('error') ||
                       disposition.toLowerCase().includes('rejected');

    const ackStatus = isRejected ? 'rejected' : (isAccepted ? 'accepted' : 'partial');
    const ackType = 'mdn';

    const result = await pool.query(
      `INSERT INTO ach_acknowledgements
        (batch_id, transmission_id, ack_type, ack_status, message_id, raw_response, disposition, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING *`,
      [batchId, transmissionId || null, ackType, ackStatus,
       messageId || null, rawContent || null, disposition]
    );

    // Update the transmission record if we have a transmission_id
    if (transmissionId) {
      await pool.query(
        `UPDATE ach_transmissions SET mdn_received = true, mdn_content = $2
         WHERE transmission_id = $1`,
        [transmissionId, rawContent || disposition]
      );
    }

    // If MDN indicates acceptance and batch is still 'transmitted', auto-transition
    if (ackStatus === 'accepted' && batch.status === 'transmitted') {
      await ACHEngine.acceptBatch(batchId, {
        transmissionId,
        messageId,
        ackType: 'mdn',
        disposition,
        rawResponse: rawContent,
        skipAckRecord: true,
      });
    }

    return result.rows[0];
  }

  /**
   * Process a bank file-level acknowledgement.
   * Banks may send a separate file-ack confirming the ACH file was parsed.
   *
   * @param {Object} ack
   * @param {string} ack.batchId
   * @param {string} ack.status - 'accepted' | 'rejected' | 'partial'
   * @param {string} ack.rawResponse - raw bank response content
   * @param {string} ack.errorDescription - error if rejected
   */
  static async processFileAck(ack) {
    const { batchId, status, rawResponse, errorDescription } = ack;

    if (!batchId) throw new Error('batchId is required');

    const batch = await ACHEngine.getBatch(batchId);
    if (!batch) throw new Error(`Batch not found: ${batchId}`);

    const ackStatus = ['accepted', 'rejected', 'partial'].includes(status) ? status : 'accepted';

    const result = await pool.query(
      `INSERT INTO ach_acknowledgements
        (batch_id, ack_type, ack_status, raw_response, error_description, received_at)
       VALUES ($1, 'file_ack', $2, $3, $4, NOW()) RETURNING *`,
      [batchId, ackStatus, rawResponse || null, errorDescription || null]
    );

    // If accepted and batch is 'transmitted', transition to accepted
    if (ackStatus === 'accepted' && batch.status === 'transmitted') {
      await ACHEngine.acceptBatch(batchId, {
        ackType: 'file_ack',
        rawResponse,
      });
    }

    return result.rows[0];
  }

  /**
   * Process a bank-level batch acknowledgement (e.g., entries validated).
   */
  static async processBankAck(ack) {
    const { batchId, status, messageId, rawResponse, disposition, errorDescription } = ack;

    if (!batchId) throw new Error('batchId is required');

    const batch = await ACHEngine.getBatch(batchId);
    if (!batch) throw new Error(`Batch not found: ${batchId}`);

    const ackStatus = ['accepted', 'rejected', 'partial'].includes(status) ? status : 'accepted';

    const result = await pool.query(
      `INSERT INTO ach_acknowledgements
        (batch_id, ack_type, ack_status, message_id, raw_response, disposition, error_description, received_at)
       VALUES ($1, 'bank_ack', $2, $3, $4, $5, $6, NOW()) RETURNING *`,
      [batchId, ackStatus, messageId || null, rawResponse || null,
       disposition || null, errorDescription || null]
    );

    // Transition batch if appropriate
    if (ackStatus === 'accepted' && batch.status === 'transmitted') {
      await ACHEngine.acceptBatch(batchId, {
        messageId,
        ackType: 'bank_ack',
        rawResponse,
        disposition,
        skipAckRecord: true,
      });
    }

    return result.rows[0];
  }

  /**
   * List all acknowledgements for a batch.
   */
  static async listForBatch(batchId) {
    const result = await pool.query(
      'SELECT * FROM ach_acknowledgements WHERE batch_id = $1 ORDER BY received_at DESC',
      [batchId]
    );
    return result.rows;
  }

  /**
   * Get the latest acknowledgement status for a batch.
   */
  static async getLatestStatus(batchId) {
    const result = await pool.query(
      'SELECT * FROM ach_acknowledgements WHERE batch_id = $1 ORDER BY received_at DESC LIMIT 1',
      [batchId]
    );
    if (!result.rows.length) return null;
    return result.rows[0];
  }
}

module.exports = { ACHAcknowledgement };
