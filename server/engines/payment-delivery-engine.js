/**
 * Payment Delivery Engine
 * 
 * Bridges NACHA/Wire file generation → actual money movement
 * 
 * Delivery methods (in priority order):
 * 1. OpenACH API — submit ACH directly through self-hosted OpenACH at ach.dlbtrust.cloud
 * 2. SFTP — auto-upload NACHA files to bank's SFTP endpoint (Eaton Family CU)
 * 3. Manual — file stored for download + manual submission
 * 
 * ODFI: Eaton Family Credit Union (ABA 241075470)
 * Originator: DEANDREA LAVAR BARKLEY TRUST
 */

'use strict';

const { OpenACHClient, OpenACHSession } = require('../integrations/openach/openachClient');

// SFTP config (set in environment for Eaton Family CU's SFTP endpoint)
const SFTP_HOST = process.env.BANK_SFTP_HOST || '';
const SFTP_PORT = parseInt(process.env.BANK_SFTP_PORT || '22');
const SFTP_USER = process.env.BANK_SFTP_USER || '';
const SFTP_PASS = process.env.BANK_SFTP_PASS || '';
const SFTP_KEY  = process.env.BANK_SFTP_KEY  || '';
const SFTP_PATH = process.env.BANK_SFTP_PATH || '/incoming/ach';

// OpenACH Payment Type ID (credit disbursement)
const PAYMENT_TYPE_ID = process.env.OPENACH_PAYMENT_TYPE_ID || '';

/**
 * Determine the best available delivery method
 */
function getAvailableDeliveryMethod() {
  // Check if OpenACH is configured
  const hasOpenACH = !!(process.env.OPENACH_API_TOKEN && process.env.OPENACH_API_KEY);
  
  // Check if SFTP is configured
  const hasSFTP = !!(SFTP_HOST && SFTP_USER);

  if (hasOpenACH) return 'openach';
  if (hasSFTP) return 'sftp';
  return 'manual';
}

/**
 * Submit ACH payment through OpenACH API
 * This creates real money movement via the Federal Reserve ACH network
 */
async function submitViaOpenACH(transfer, contact, paymentMethod) {
  const session = new OpenACHSession();
  
  try {
    await session.connect();

    // Parse contact name
    const nameParts = (contact.display_name || `${contact.first_name || ''} ${contact.last_name || ''}`).trim().split(' ');
    const firstName = nameParts[0] || 'Beneficiary';
    const lastName = nameParts.slice(1).join(' ') || 'Unknown';

    // Get or determine payment type
    let paymentTypeId = PAYMENT_TYPE_ID;
    if (!paymentTypeId) {
      // Try to get payment types from OpenACH and use the first credit type
      try {
        const types = await OpenACHClient.getPaymentTypes();
        if (types && types.length > 0) {
          paymentTypeId = types[0].payment_type_id || types[0].id;
        }
      } catch (_) {}
    }

    if (!paymentTypeId) {
      throw new Error('No payment_type_id configured. Set OPENACH_PAYMENT_TYPE_ID or configure payment types in OpenACH.');
    }

    // Calculate next business day for send date
    const sendDate = getNextBusinessDay();

    // Full disbursement through OpenACH
    const result = await OpenACHClient.disburseToBeneficiary({
      first_name: firstName,
      last_name: lastName,
      email: contact.email || '',
      external_id: `transfer_${transfer.id}_contact_${contact.id}`,

      bank_name: paymentMethod.bank_name || 'Recipient Bank',
      routing_number: paymentMethod.routing_number,
      account_number: paymentMethod.account_number,
      account_type: (paymentMethod.account_type || 'Checking'),
      billing_address: contact.address || '',
      billing_city: contact.city || '',
      billing_state: contact.state || 'OH',
      billing_zip: contact.zip || '',

      amount: transfer.amount_cents / 100,
      send_date: sendDate,
      payment_type_id: paymentTypeId,
    });

    return {
      success: true,
      delivery_method: 'openach',
      status: 'submitted',
      confirmation: {
        payment_profile_id: result.payment_profile_id,
        external_account_id: result.external_account_id,
        payment_schedule_id: result.payment_schedule_id,
        send_date: sendDate,
      },
      message: result.message,
    };

  } catch (err) {
    return {
      success: false,
      delivery_method: 'openach',
      error: err.message,
      fallback: 'manual',
    };
  }
}

/**
 * Submit NACHA file via SFTP to bank
 */
async function submitViaSFTP(nachaContent, filename) {
  if (!SFTP_HOST || !SFTP_USER) {
    return { success: false, error: 'SFTP not configured', fallback: 'manual' };
  }

  try {
    // Use Node.js ssh2-sftp-client if available, otherwise fall back to system sftp
    let Client;
    try {
      Client = require('ssh2-sftp-client');
    } catch (_) {
      // ssh2-sftp-client not installed — use system sftp command
      return await submitViaSFTPSystem(nachaContent, filename);
    }

    const sftp = new Client();
    const connectOpts = {
      host: SFTP_HOST,
      port: SFTP_PORT,
      username: SFTP_USER,
    };

    if (SFTP_KEY) {
      connectOpts.privateKey = SFTP_KEY;
    } else if (SFTP_PASS) {
      connectOpts.password = SFTP_PASS;
    }

    await sftp.connect(connectOpts);
    const remotePath = `${SFTP_PATH}/${filename}`;
    await sftp.put(Buffer.from(nachaContent), remotePath);
    await sftp.end();

    return {
      success: true,
      delivery_method: 'sftp',
      status: 'submitted',
      confirmation: {
        host: SFTP_HOST,
        path: remotePath,
        uploaded_at: new Date().toISOString(),
      },
      message: `NACHA file uploaded to ${SFTP_HOST}:${remotePath}`,
    };

  } catch (err) {
    return {
      success: false,
      delivery_method: 'sftp',
      error: err.message,
      fallback: 'manual',
    };
  }
}

/**
 * Fallback: use system sftp/scp command
 */
async function submitViaSFTPSystem(nachaContent, filename) {
  const { writeFileSync, unlinkSync } = require('fs');
  const { execSync } = require('child_process');
  const path = require('path');
  const tmpFile = path.join('/tmp', filename);

  try {
    writeFileSync(tmpFile, nachaContent);

    const dest = `${SFTP_USER}@${SFTP_HOST}:${SFTP_PATH}/${filename}`;
    const cmd = SFTP_KEY
      ? `scp -i "${SFTP_KEY}" -P ${SFTP_PORT} "${tmpFile}" "${dest}"`
      : `sshpass -p "${SFTP_PASS}" scp -P ${SFTP_PORT} "${tmpFile}" "${dest}"`;

    execSync(cmd, { timeout: 30000 });

    return {
      success: true,
      delivery_method: 'sftp',
      status: 'submitted',
      confirmation: {
        host: SFTP_HOST,
        path: `${SFTP_PATH}/${filename}`,
        uploaded_at: new Date().toISOString(),
      },
      message: `NACHA file uploaded via SCP to ${SFTP_HOST}`,
    };
  } catch (err) {
    return { success: false, delivery_method: 'sftp', error: err.message, fallback: 'manual' };
  } finally {
    try { unlinkSync(tmpFile); } catch (_) {}
  }
}

/**
 * Main delivery function — tries OpenACH first, then SFTP, then manual
 */
async function deliverPayment(transfer, contact, paymentMethod, nachaFile) {
  const method = getAvailableDeliveryMethod();
  let result;

  // ACH payments: try OpenACH API first (real-time submission)
  if (method === 'openach' && transfer.payment_method === 'ach') {
    result = await submitViaOpenACH(transfer, contact, paymentMethod);
    if (result.success) return result;
    // Fall through to SFTP if OpenACH fails
  }

  // Try SFTP delivery for ACH (upload NACHA file)
  if ((method === 'sftp' || (result && !result.success)) && nachaFile) {
    const sftpResult = await submitViaSFTP(nachaFile.content, nachaFile.filename);
    if (sftpResult.success) return sftpResult;
  }

  // Manual fallback — file is stored in DB, user downloads and submits manually
  return {
    success: true,
    delivery_method: 'manual',
    status: 'generated',
    confirmation: {
      filename: nachaFile ? nachaFile.filename : null,
      stored: true,
      instruction: 'Download the payment file and submit it to Eaton Family Credit Union via their business banking portal or SFTP.',
    },
    message: 'Payment file generated — submit to bank manually',
  };
}

/**
 * Submit wire transfer
 * Wires cannot be auto-submitted in most cases (require bank portal/call)
 * But we can format the message and provide submission instructions
 */
async function deliverWire(transfer, wireMessage) {
  return {
    success: true,
    delivery_method: 'manual',
    status: 'generated',
    confirmation: {
      filename: wireMessage.filename,
      format: wireMessage.format,
      imad: wireMessage.metadata.imad,
      instruction: wireMessage.format === 'fedwire'
        ? 'Submit this Fedwire message through Eaton Family CU wire portal or call their wire desk.'
        : 'Submit this SWIFT MT103 message through your international wire correspondent bank.',
    },
    message: `${wireMessage.format.toUpperCase()} message generated — submit through bank wire desk`,
  };
}

/**
 * Check OpenACH health/connectivity
 */
async function checkOpenACHHealth() {
  try {
    const types = await OpenACHClient.getPaymentTypes();
    return {
      connected: true,
      payment_types: types,
      delivery_method: 'openach',
      message: 'OpenACH API is live — ACH payments will auto-submit',
    };
  } catch (err) {
    return {
      connected: false,
      error: err.message,
      delivery_method: getAvailableDeliveryMethod(),
      message: `OpenACH unavailable: ${err.message}. Using ${getAvailableDeliveryMethod()} delivery.`,
    };
  }
}

/**
 * Get next business day (skip weekends)
 */
function getNextBusinessDay() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  while (date.getDay() === 0 || date.getDay() === 6) {
    date.setDate(date.getDate() + 1);
  }
  return date.toISOString().split('T')[0];
}

module.exports = {
  deliverPayment,
  deliverWire,
  checkOpenACHHealth,
  getAvailableDeliveryMethod,
  submitViaOpenACH,
  submitViaSFTP,
  getNextBusinessDay,
};
