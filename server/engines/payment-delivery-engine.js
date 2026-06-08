/**
 * Payment Delivery Engine
 * 
 * Bridges NACHA/Wire file generation → actual money movement
 * 
 * Delivery methods (in priority order):
 * 1. Column Bank API — direct Federal Reserve ACH/Wire via REST API (no SFTP needed)
 * 2. Dwolla API — ACH/RTP/FedNow via REST API (no SFTP needed)
 * 3. OpenACH API — submit ACH through self-hosted OpenACH at ach.dlbtrust.cloud
 * 4. Moov ACH — open-source ACH validation + file management
 * 5. SFTP — auto-upload NACHA files to bank's SFTP endpoint
 * 6. Manual — file stored for download + manual submission
 * 
 * ODFI: Eaton Family Credit Union (ABA 241075470)
 * Originator: DEANDREA LAVAR BARKLEY TRUST
 */

'use strict';

const { OpenACHClient, OpenACHSession } = require('../integrations/openach/openachClient');

// Lazy-load optional integrations (don't crash if files missing)
function loadColumn() { try { return require('../integrations/column/columnClient'); } catch (_) { return null; } }
function loadDwolla() { try { return require('../integrations/dwolla/dwollaClient'); } catch (_) { return null; } }
function loadMoov()   { try { return require('../integrations/moov/moovClient');     } catch (_) { return null; } }

// SFTP config
const SFTP_HOST = process.env.BANK_SFTP_HOST || '';
const SFTP_PORT = parseInt(process.env.BANK_SFTP_PORT || '22');
const SFTP_USER = process.env.BANK_SFTP_USER || '';
const SFTP_PASS = process.env.BANK_SFTP_PASS || '';
const SFTP_KEY  = process.env.BANK_SFTP_KEY  || '';
const SFTP_PATH = process.env.BANK_SFTP_PATH || '/incoming/ach';

// OpenACH Payment Type ID
const PAYMENT_TYPE_ID = process.env.OPENACH_PAYMENT_TYPE_ID || '';

/**
 * Determine the best available delivery method
 */
function getAvailableDeliveryMethod() {
  const Column = loadColumn();
  const Dwolla = loadDwolla();

  if (Column && Column.COLUMN_API_KEY) return 'column';
  if (Dwolla && Dwolla.DWOLLA_KEY && Dwolla.DWOLLA_SECRET) return 'dwolla';
  if (process.env.OPENACH_API_TOKEN && process.env.OPENACH_API_KEY) return 'openach';
  if (SFTP_HOST && SFTP_USER) return 'sftp';
  return 'manual';
}

/**
 * Get all configured delivery methods and their status
 */
async function getAllDeliveryMethods() {
  const methods = [];

  // Column
  const Column = loadColumn();
  if (Column) {
    const health = await Column.healthCheck();
    methods.push({
      name: 'column',
      label: 'Column Bank API',
      type: 'api',
      description: 'Direct Federal Reserve ACH/Wire via REST API — no SFTP needed',
      configured: !!Column.COLUMN_API_KEY,
      ...health,
    });
  }

  // Dwolla
  const Dwolla = loadDwolla();
  if (Dwolla) {
    const health = await Dwolla.healthCheck();
    methods.push({
      name: 'dwolla',
      label: 'Dwolla Payment API',
      type: 'api',
      description: 'ACH, RTP, FedNow, Wire via REST API — no SFTP needed',
      configured: !!(Dwolla.DWOLLA_KEY && Dwolla.DWOLLA_SECRET),
      ...health,
    });
  }

  // OpenACH
  methods.push({
    name: 'openach',
    label: 'OpenACH (Self-Hosted)',
    type: 'self-hosted',
    description: 'Open-source ACH origination on dlbtrust.cloud',
    configured: !!(process.env.OPENACH_API_TOKEN && process.env.OPENACH_API_KEY),
    ...(await checkOpenACHHealth()),
  });

  // Moov
  const Moov = loadMoov();
  if (Moov) {
    const health = await Moov.healthCheck();
    methods.push({
      name: 'moov',
      label: 'Moov ACH (Open-Source)',
      type: 'self-hosted',
      description: 'Open-source ACH validation and file management',
      configured: true,
      ...health,
    });
  }

  // SFTP
  methods.push({
    name: 'sftp',
    label: 'Bank SFTP',
    type: 'file-transfer',
    description: 'Auto-upload NACHA files to bank SFTP endpoint',
    configured: !!(SFTP_HOST && SFTP_USER),
    connected: !!(SFTP_HOST && SFTP_USER),
  });

  // Manual
  methods.push({
    name: 'manual',
    label: 'Manual Download',
    type: 'manual',
    description: 'Download NACHA/Wire file and submit to Eaton Family CU portal',
    configured: true,
    connected: true,
  });

  return methods;
}

// ─── Column Bank API Delivery ───────────────────────────────────────────────

async function submitViaColumn(transfer, contact, paymentMethod) {
  const Column = loadColumn();
  if (!Column || !Column.COLUMN_API_KEY) {
    return { success: false, delivery_method: 'column', error: 'Column API not configured' };
  }

  try {
    // Column needs a bank account to send from — check if we have one
    let bankAccountId = process.env.COLUMN_BANK_ACCOUNT_ID;

    if (!bankAccountId) {
      // Create entity + bank account on first use
      const entity = await Column.createBusinessEntity({
        legal_name: 'DEANDREA LAVAR BARKLEY TRUST',
        ein: process.env.TRUST_EIN || '000000000',
      });
      const account = await Column.createBankAccount(entity.id, 'DLB Trust Operating');
      bankAccountId = account.id;

      // In sandbox, fund the account with a simulated wire
      if (Column.COLUMN_API_KEY.startsWith('test_') && account.default_account_number_id) {
        try {
          await Column.simulateIncomingWire({
            destination_account_number_id: account.default_account_number_id,
            amount: 10000000, // $100,000 for testing
          });
        } catch (_) {}
      }
    }

    const result = await Column.disbursement({
      bank_account_id: bankAccountId,
      recipient_name: contact.display_name || `${contact.first_name} ${contact.last_name}`,
      routing_number: paymentMethod.routing_number,
      account_number: paymentMethod.account_number,
      account_type: paymentMethod.account_type || 'CHECKING',
      amount_cents: transfer.amount_cents,
      description: transfer.description || `Payment ${transfer.transfer_number}`,
    });

    return {
      success: true,
      delivery_method: 'column',
      status: 'submitted',
      confirmation: {
        transfer_id: result.transfer_id,
        counterparty_id: result.counterparty_id,
        sandbox: Column.COLUMN_API_KEY.startsWith('test_'),
      },
      message: result.message,
    };
  } catch (err) {
    return { success: false, delivery_method: 'column', error: err.message, fallback: 'dwolla' };
  }
}

// ─── Dwolla API Delivery ────────────────────────────────────────────────────

async function submitViaDwolla(transfer, contact, paymentMethod) {
  const Dwolla = loadDwolla();
  if (!Dwolla || !Dwolla.DWOLLA_KEY) {
    return { success: false, delivery_method: 'dwolla', error: 'Dwolla API not configured' };
  }

  try {
    // Get or create source funding URL
    let sourceFundingUrl = process.env.DWOLLA_SOURCE_FUNDING_URL;

    if (!sourceFundingUrl) {
      return {
        success: false,
        delivery_method: 'dwolla',
        error: 'DWOLLA_SOURCE_FUNDING_URL not configured. Set it to your master account funding source URL.',
        fallback: 'openach',
      };
    }

    const amountDollars = (transfer.amount_cents / 100).toFixed(2);
    const result = await Dwolla.disbursement({
      source_funding_url: sourceFundingUrl,
      recipient_name: contact.display_name || `${contact.first_name} ${contact.last_name}`,
      recipient_email: contact.email,
      routing_number: paymentMethod.routing_number,
      account_number: paymentMethod.account_number,
      account_type: paymentMethod.account_type || 'checking',
      amount_dollars: amountDollars,
      description: transfer.description || `Payment ${transfer.transfer_number}`,
    });

    return {
      success: true,
      delivery_method: 'dwolla',
      status: 'submitted',
      confirmation: {
        transfer_url: result.transfer_url,
        customer_url: result.customer_url,
        environment: result.environment,
      },
      message: result.message,
    };
  } catch (err) {
    return { success: false, delivery_method: 'dwolla', error: err.message, fallback: 'openach' };
  }
}

// ─── OpenACH Delivery ───────────────────────────────────────────────────────

async function submitViaOpenACH(transfer, contact, paymentMethod) {
  const session = new OpenACHSession();
  
  try {
    await session.connect();

    const nameParts = (contact.display_name || `${contact.first_name || ''} ${contact.last_name || ''}`).trim().split(' ');
    const firstName = nameParts[0] || 'Beneficiary';
    const lastName = nameParts.slice(1).join(' ') || 'Unknown';

    let paymentTypeId = PAYMENT_TYPE_ID;
    if (!paymentTypeId) {
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

    const sendDate = getNextBusinessDay();

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
      fallback: 'sftp',
    };
  }
}

// ─── Moov ACH Validation ────────────────────────────────────────────────────

async function validateWithMoov(nachaContent) {
  const Moov = loadMoov();
  if (!Moov) return { validated: false, reason: 'Moov not available' };

  try {
    const result = await Moov.validateFile(nachaContent);
    return { validated: true, result };
  } catch (err) {
    return { validated: false, error: err.message };
  }
}

// ─── SFTP Delivery ──────────────────────────────────────────────────────────

async function submitViaSFTP(nachaContent, filename) {
  if (!SFTP_HOST || !SFTP_USER) {
    return { success: false, error: 'SFTP not configured', fallback: 'manual' };
  }

  try {
    let Client;
    try {
      Client = require('ssh2-sftp-client');
    } catch (_) {
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
      confirmation: { host: SFTP_HOST, path: remotePath, uploaded_at: new Date().toISOString() },
      message: `NACHA file uploaded to ${SFTP_HOST}:${remotePath}`,
    };

  } catch (err) {
    return { success: false, delivery_method: 'sftp', error: err.message, fallback: 'manual' };
  }
}

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
      confirmation: { host: SFTP_HOST, path: `${SFTP_PATH}/${filename}`, uploaded_at: new Date().toISOString() },
      message: `NACHA file uploaded via SCP to ${SFTP_HOST}`,
    };
  } catch (err) {
    return { success: false, delivery_method: 'sftp', error: err.message, fallback: 'manual' };
  } finally {
    try { unlinkSync(tmpFile); } catch (_) {}
  }
}

// ─── Main Delivery Function ─────────────────────────────────────────────────

/**
 * Deliver payment through the best available channel
 * Priority: Column → Dwolla → OpenACH → Moov → SFTP → Manual
 */
async function deliverPayment(transfer, contact, paymentMethod, nachaFile) {
  const attempts = [];
  let result;

  // 1. Column Bank API (direct Fed connection, no SFTP)
  const Column = loadColumn();
  if (Column && Column.COLUMN_API_KEY && transfer.payment_method === 'ach') {
    result = await submitViaColumn(transfer, contact, paymentMethod);
    attempts.push({ method: 'column', ...result });
    if (result.success) {
      result.attempts = attempts;
      return result;
    }
  }

  // 2. Dwolla API (ACH via REST, no SFTP)
  const Dwolla = loadDwolla();
  if (Dwolla && Dwolla.DWOLLA_KEY && Dwolla.DWOLLA_SECRET && transfer.payment_method === 'ach') {
    result = await submitViaDwolla(transfer, contact, paymentMethod);
    attempts.push({ method: 'dwolla', ...result });
    if (result.success) {
      result.attempts = attempts;
      return result;
    }
  }

  // 3. OpenACH (self-hosted)
  if (process.env.OPENACH_API_TOKEN && process.env.OPENACH_API_KEY && transfer.payment_method === 'ach') {
    result = await submitViaOpenACH(transfer, contact, paymentMethod);
    attempts.push({ method: 'openach', ...result });
    if (result.success) {
      result.attempts = attempts;
      return result;
    }
  }

  // 4. Validate with Moov before SFTP/manual
  if (nachaFile) {
    const moovResult = await validateWithMoov(nachaFile.content);
    if (moovResult.validated) {
      attempts.push({ method: 'moov-validation', validated: true });
    }
  }

  // 5. SFTP delivery
  if (SFTP_HOST && SFTP_USER && nachaFile) {
    result = await submitViaSFTP(nachaFile.content, nachaFile.filename);
    attempts.push({ method: 'sftp', ...result });
    if (result.success) {
      result.attempts = attempts;
      return result;
    }
  }

  // 6. Manual fallback
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
    attempts,
  };
}

/**
 * Submit wire transfer (Column supports wires too)
 */
async function deliverWire(transfer, wireMessage) {
  // Try Column for wires
  const Column = loadColumn();
  if (Column && Column.COLUMN_API_KEY) {
    try {
      const bankAccountId = process.env.COLUMN_BANK_ACCOUNT_ID;
      if (bankAccountId && wireMessage.metadata) {
        const counterparty = await Column.createCounterparty({
          routing_number: wireMessage.metadata.receiverBank?.routingNumber || '',
          account_number: wireMessage.metadata.receiverBank?.accountNumber || '',
          name: wireMessage.metadata.beneficiary?.name || 'Wire Recipient',
        });

        const wire = await Column.createWireTransfer({
          bank_account_id: bankAccountId,
          counterparty_id: counterparty.id,
          amount: transfer.amount_cents,
          description: transfer.description || `Wire ${transfer.transfer_number}`,
        });

        return {
          success: true,
          delivery_method: 'column',
          status: 'submitted',
          confirmation: { transfer_id: wire.id, sandbox: Column.COLUMN_API_KEY.startsWith('test_') },
          message: `Wire submitted via Column Bank API (${Column.COLUMN_API_KEY.startsWith('test_') ? 'sandbox' : 'LIVE'})`,
        };
      }
    } catch (err) {
      // Fall through to manual
    }
  }

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
  getAllDeliveryMethods,
  submitViaColumn,
  submitViaDwolla,
  submitViaOpenACH,
  submitViaSFTP,
  validateWithMoov,
  getNextBusinessDay,
};
