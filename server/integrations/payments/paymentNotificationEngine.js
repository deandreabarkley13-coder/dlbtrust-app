'use strict';

/**
 * Payment Notification & Receipt Engine — DLB Trust Platform
 *
 * Real-time payment lifecycle tracking with notifications:
 *  - Payment status tracking: initiated → processing → cleared → settled → posted
 *  - Notification feed with read/unread status
 *  - BILL API confirmation polling for settlement references
 *  - Digital receipt generation (printable HTML)
 *  - Vendor payment confirmation with settlement codes
 */

var pool = require('../bonds/pgPool');
var billClient;
try { billClient = require('../bill/billClient'); } catch (e) { billClient = null; }

var PAYMENT_LIFECYCLE = [
  'initiated',    // Payment created in our system
  'processing',   // Sent to payment network (ACH/Wire/BILL)
  'submitted',    // Accepted by payment processor
  'clearing',     // In the clearing/settlement pipeline
  'settled',      // Funds have moved (confirmed by BILL or bank)
  'posted',       // Journal entry posted in trust accounting
  'completed',    // Fully complete — receipt available
  'failed',       // Payment failed at any stage
  'reversed'      // Payment reversed/refunded
];

var NOTIFICATION_TYPES = [
  'payment_initiated',
  'payment_submitted',
  'payment_clearing',
  'payment_settled',
  'payment_posted',
  'payment_completed',
  'payment_failed',
  'payment_reversed',
  'settlement_confirmed',
  'receipt_available'
];

// ═══════════════════════════════════════════════════════════════════════════════
//  TABLE SETUP
// ═══════════════════════════════════════════════════════════════════════════════

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_tracker (
      id                  SERIAL PRIMARY KEY,
      tracking_id         TEXT UNIQUE NOT NULL,
      payment_type        TEXT NOT NULL DEFAULT 'deposit'
                            CHECK (payment_type IN ('deposit','vendor_payment','wire_transfer','ach_batch','distribution')),
      payment_method      TEXT NOT NULL DEFAULT 'direct'
                            CHECK (payment_method IN ('direct','ach','wire','bill')),
      direction           TEXT NOT NULL DEFAULT 'outbound'
                            CHECK (direction IN ('inbound','outbound')),
      amount              NUMERIC(18,2) NOT NULL,
      currency            TEXT NOT NULL DEFAULT 'USD',
      -- Source / destination
      source_account      TEXT,
      destination_account TEXT,
      destination_name    TEXT,
      vendor_id           TEXT,
      vendor_name         TEXT,
      -- Status lifecycle
      status              TEXT NOT NULL DEFAULT 'initiated'
                            CHECK (status IN ('initiated','processing','submitted','clearing',
                              'settled','posted','completed','failed','reversed')),
      -- References
      internal_ref        TEXT,
      bill_ref            TEXT,
      bill_settlement_ref TEXT,
      ach_batch_id        TEXT,
      wire_id             TEXT,
      journal_entry_id    TEXT,
      settlement_id       TEXT,
      -- Confirmation
      confirmation_code   TEXT,
      settlement_date     TIMESTAMPTZ,
      clearing_date       TIMESTAMPTZ,
      -- Metadata
      description         TEXT,
      initiated_by        TEXT DEFAULT 'system',
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_notifications (
      id                  SERIAL PRIMARY KEY,
      notification_id     TEXT UNIQUE NOT NULL,
      tracking_id         TEXT NOT NULL,
      notification_type   TEXT NOT NULL,
      title               TEXT NOT NULL,
      message             TEXT NOT NULL,
      severity            TEXT NOT NULL DEFAULT 'info'
                            CHECK (severity IN ('info','success','warning','error')),
      is_read             BOOLEAN DEFAULT FALSE,
      read_at             TIMESTAMPTZ,
      metadata            TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pt_status ON payment_tracker(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pn_read ON payment_notifications(is_read)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pn_tracking ON payment_notifications(tracking_id)`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ID GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

function generateTrackingId() {
  var ts = Date.now().toString(36).toUpperCase();
  var seq = Math.random().toString(36).slice(2, 6).toUpperCase();
  return 'TRK-' + ts + '-' + seq;
}

function generateNotificationId() {
  var ts = Date.now().toString(36).toUpperCase();
  var seq = Math.random().toString(36).slice(2, 6).toUpperCase();
  return 'NTF-' + ts + '-' + seq;
}

function generateConfirmationCode() {
  var ts = Date.now().toString(36).toUpperCase();
  var seq = Math.random().toString(36).slice(2, 8).toUpperCase();
  return 'CONF-' + ts + '-' + seq;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TRACK PAYMENT
// ═══════════════════════════════════════════════════════════════════════════════

async function trackPayment(opts) {
  var trackingId = generateTrackingId();
  await pool.query(`
    INSERT INTO payment_tracker
      (tracking_id, payment_type, payment_method, direction, amount, currency,
       source_account, destination_account, destination_name, vendor_id, vendor_name,
       status, internal_ref, bill_ref, ach_batch_id, wire_id, journal_entry_id,
       settlement_id, description, initiated_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
  `, [
    trackingId,
    opts.payment_type || 'deposit',
    opts.payment_method || 'direct',
    opts.direction || 'outbound',
    opts.amount,
    opts.currency || 'USD',
    opts.source_account || null,
    opts.destination_account || null,
    opts.destination_name || null,
    opts.vendor_id || null,
    opts.vendor_name || null,
    'initiated',
    opts.internal_ref || null,
    opts.bill_ref || null,
    opts.ach_batch_id || null,
    opts.wire_id || null,
    opts.journal_entry_id || null,
    opts.settlement_id || null,
    opts.description || null,
    opts.initiated_by || 'system'
  ]);

  await createNotification(trackingId, 'payment_initiated', {
    title: 'Payment Initiated',
    message: formatCurrency(opts.amount) + ' ' + (opts.payment_type || 'deposit') +
      ' via ' + (opts.payment_method || 'direct').toUpperCase() +
      (opts.destination_name ? ' to ' + opts.destination_name : ''),
    severity: 'info'
  });

  return trackingId;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UPDATE PAYMENT STATUS
// ═══════════════════════════════════════════════════════════════════════════════

async function updatePaymentStatus(trackingId, newStatus, details) {
  details = details || {};
  var updates = ['status = $2', 'updated_at = NOW()'];
  var params = [trackingId, newStatus];
  var idx = 3;

  if (details.bill_ref) { updates.push('bill_ref = $' + idx++); params.push(details.bill_ref); }
  if (details.bill_settlement_ref) { updates.push('bill_settlement_ref = $' + idx++); params.push(details.bill_settlement_ref); }
  if (details.confirmation_code) { updates.push('confirmation_code = $' + idx++); params.push(details.confirmation_code); }
  if (details.journal_entry_id) { updates.push('journal_entry_id = $' + idx++); params.push(details.journal_entry_id); }
  if (details.settlement_id) { updates.push('settlement_id = $' + idx++); params.push(details.settlement_id); }
  if (newStatus === 'settled') { updates.push('settlement_date = NOW()'); }
  if (newStatus === 'clearing') { updates.push('clearing_date = NOW()'); }

  await pool.query(
    'UPDATE payment_tracker SET ' + updates.join(', ') + ' WHERE tracking_id = $1',
    params
  );

  // Create status notification
  var notifConfig = getNotificationForStatus(newStatus, details);
  if (notifConfig) {
    await createNotification(trackingId, notifConfig.type, notifConfig);
  }

  // When settled, generate confirmation code and mark completed
  if (newStatus === 'settled') {
    var confCode = details.confirmation_code || generateConfirmationCode();
    await pool.query(
      'UPDATE payment_tracker SET confirmation_code = $2 WHERE tracking_id = $1 AND confirmation_code IS NULL',
      [trackingId, confCode]
    );
    // Auto-advance to completed after settlement
    await updatePaymentStatus(trackingId, 'completed', { confirmation_code: confCode });
  }

  return { tracking_id: trackingId, status: newStatus };
}

function getNotificationForStatus(status, details) {
  switch (status) {
    case 'processing':
      return { type: 'payment_submitted', title: 'Payment Processing', message: 'Payment submitted to payment network', severity: 'info' };
    case 'submitted':
      return { type: 'payment_submitted', title: 'Payment Accepted', message: 'Payment accepted by processor' + (details.bill_ref ? ' — BILL ref: ' + details.bill_ref : ''), severity: 'info' };
    case 'clearing':
      return { type: 'payment_clearing', title: 'Payment Clearing', message: 'Payment is in the clearing pipeline — funds in transit', severity: 'info' };
    case 'settled':
      return {
        type: 'settlement_confirmed', title: 'Settlement Confirmed',
        message: 'Funds have settled' + (details.bill_settlement_ref ? ' — Settlement ref: ' + details.bill_settlement_ref : '') + (details.confirmation_code ? ' — Confirmation: ' + details.confirmation_code : ''),
        severity: 'success'
      };
    case 'posted':
      return { type: 'payment_posted', title: 'Journal Entry Posted', message: 'Payment recorded in trust accounting' + (details.journal_entry_id ? ' — JE: ' + details.journal_entry_id : ''), severity: 'success' };
    case 'completed':
      return { type: 'receipt_available', title: 'Payment Complete — Receipt Available', message: 'Payment fully processed. Digital receipt is ready for download.', severity: 'success' };
    case 'failed':
      return { type: 'payment_failed', title: 'Payment Failed', message: details.error_message || 'Payment could not be processed', severity: 'error' };
    case 'reversed':
      return { type: 'payment_reversed', title: 'Payment Reversed', message: details.reason || 'Payment has been reversed', severity: 'warning' };
    default:
      return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function createNotification(trackingId, type, opts) {
  var notifId = generateNotificationId();
  await pool.query(`
    INSERT INTO payment_notifications (notification_id, tracking_id, notification_type, title, message, severity, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [
    notifId, trackingId, type,
    opts.title, opts.message, opts.severity || 'info',
    opts.metadata ? JSON.stringify(opts.metadata) : null
  ]);
  return notifId;
}

async function getNotifications(opts) {
  opts = opts || {};
  var where = ['1=1'];
  var params = [];
  var idx = 1;

  if (opts.unread_only) { where.push('is_read = FALSE'); }
  if (opts.tracking_id) { where.push('tracking_id = $' + idx++); params.push(opts.tracking_id); }
  if (opts.severity) { where.push('severity = $' + idx++); params.push(opts.severity); }

  var limit = parseInt(opts.limit) || 50;
  var res = await pool.query(
    'SELECT * FROM payment_notifications WHERE ' + where.join(' AND ') +
    ' ORDER BY created_at DESC LIMIT ' + limit,
    params
  );
  return res.rows;
}

async function markNotificationRead(notificationId) {
  await pool.query(
    'UPDATE payment_notifications SET is_read = TRUE, read_at = NOW() WHERE notification_id = $1',
    [notificationId]
  );
}

async function markAllRead() {
  var res = await pool.query(
    'UPDATE payment_notifications SET is_read = TRUE, read_at = NOW() WHERE is_read = FALSE RETURNING notification_id'
  );
  return res.rowCount;
}

async function getUnreadCount() {
  var res = await pool.query('SELECT COUNT(*) as cnt FROM payment_notifications WHERE is_read = FALSE');
  return parseInt(res.rows[0].cnt) || 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  POLL BILL FOR SETTLEMENT CONFIRMATIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function pollBillConfirmations() {
  if (!billClient || !billClient.isConfigured()) return { checked: 0, confirmed: 0 };

  var pendingPayments = await pool.query(`
    SELECT * FROM payment_tracker
    WHERE status IN ('processing', 'submitted', 'clearing')
      AND payment_method IN ('direct', 'ach', 'wire', 'bill')
      AND bill_ref IS NOT NULL
    ORDER BY created_at ASC
    LIMIT 20
  `);

  if (pendingPayments.rowCount === 0) return { checked: 0, confirmed: 0 };

  var confirmed = 0;
  var receivedPayments = [];
  try {
    receivedPayments = await billClient.listReceivedPayments(50);
  } catch (e) {
    console.warn('[PaymentNotif] BILL listReceivedPayments failed:', e.message);
    return { checked: pendingPayments.rowCount, confirmed: 0, error: e.message };
  }

  var sentPayments = [];
  try {
    sentPayments = await billClient.listSentPayments(50);
  } catch (e) {}

  var allBillPayments = receivedPayments.concat(sentPayments);

  for (var i = 0; i < pendingPayments.rows.length; i++) {
    var payment = pendingPayments.rows[i];
    var billMatch = allBillPayments.find(function(bp) {
      return bp.id === payment.bill_ref ||
        (bp.amount && Math.abs(parseFloat(bp.amount) - parseFloat(payment.amount)) < 0.01);
    });

    if (billMatch) {
      var settlementRef = billMatch.id;
      var billStatus = billMatch.status;
      // BILL status: 0=Entered, 1=Paid, 2=Cleared, 3=Voided, 4=PaidOnline
      if (billStatus === '1' || billStatus === '2' || billStatus === '4' ||
          billStatus === 1 || billStatus === 2 || billStatus === 4) {
        var confCode = generateConfirmationCode();
        await updatePaymentStatus(payment.tracking_id, 'settled', {
          bill_settlement_ref: settlementRef,
          confirmation_code: confCode
        });
        confirmed++;
      } else if (billStatus === '3' || billStatus === 3) {
        await updatePaymentStatus(payment.tracking_id, 'failed', {
          error_message: 'Payment voided in BILL (ref: ' + settlementRef + ')'
        });
      }
    }
  }

  return { checked: pendingPayments.rowCount, confirmed: confirmed };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RECEIPT GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

async function generateReceipt(trackingId) {
  var res = await pool.query('SELECT * FROM payment_tracker WHERE tracking_id = $1', [trackingId]);
  if (res.rowCount === 0) return null;
  var payment = res.rows[0];

  var notifications = await pool.query(
    'SELECT * FROM payment_notifications WHERE tracking_id = $1 ORDER BY created_at ASC',
    [trackingId]
  );

  var receipt = {
    receipt_number: payment.confirmation_code || 'PENDING-' + trackingId,
    tracking_id: trackingId,
    status: payment.status,
    payment_type: payment.payment_type,
    payment_method: payment.payment_method,
    direction: payment.direction,
    amount: parseFloat(payment.amount),
    currency: payment.currency,
    source_account: payment.source_account,
    destination_account: payment.destination_account,
    destination_name: payment.destination_name,
    vendor_name: payment.vendor_name,
    description: payment.description,
    references: {
      internal: payment.internal_ref,
      bill: payment.bill_ref,
      bill_settlement: payment.bill_settlement_ref,
      ach_batch: payment.ach_batch_id,
      wire: payment.wire_id,
      journal_entry: payment.journal_entry_id,
      settlement: payment.settlement_id,
      confirmation: payment.confirmation_code
    },
    timestamps: {
      initiated: payment.created_at,
      clearing: payment.clearing_date,
      settled: payment.settlement_date,
      last_updated: payment.updated_at
    },
    initiated_by: payment.initiated_by,
    timeline: notifications.rows.map(function(n) {
      return {
        time: n.created_at,
        event: n.notification_type,
        title: n.title,
        message: n.message,
        severity: n.severity
      };
    }),
    generated_at: new Date().toISOString(),
    organization: 'DEANDREA LAVAR BARKLEY TRUST',
    system: 'DLB Trust Treasury Management System'
  };

  return receipt;
}

function generateReceiptHTML(receipt) {
  if (!receipt) return '<html><body><h1>Receipt Not Found</h1></body></html>';

  var statusColor = receipt.status === 'completed' ? '#22c55e' :
    receipt.status === 'settled' ? '#22c55e' :
    receipt.status === 'failed' ? '#ef4444' :
    receipt.status === 'reversed' ? '#f59e0b' : '#3b82f6';

  var statusLabel = receipt.status === 'completed' ? 'PAYMENT SUCCESSFUL' :
    receipt.status === 'settled' ? 'SETTLED' :
    receipt.status === 'failed' ? 'FAILED' :
    receipt.status === 'reversed' ? 'REVERSED' :
    receipt.status.toUpperCase();

  var timelineHTML = receipt.timeline.map(function(t) {
    var iconColor = t.severity === 'success' ? '#22c55e' :
      t.severity === 'error' ? '#ef4444' :
      t.severity === 'warning' ? '#f59e0b' : '#3b82f6';
    return '<tr>' +
      '<td style="padding:6px 12px;border-bottom:1px solid #eee;color:#666;font-size:12px;white-space:nowrap;">' +
        new Date(t.time).toLocaleString() + '</td>' +
      '<td style="padding:6px 12px;border-bottom:1px solid #eee;">' +
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + iconColor + ';margin-right:6px;"></span>' +
        '<strong>' + escapeHTML(t.title) + '</strong></td>' +
      '<td style="padding:6px 12px;border-bottom:1px solid #eee;color:#666;font-size:13px;">' + escapeHTML(t.message) + '</td>' +
      '</tr>';
  }).join('\n');

  var refsHTML = '';
  var refs = receipt.references;
  if (refs.confirmation) refsHTML += refRow('Confirmation Code', refs.confirmation);
  if (refs.bill) refsHTML += refRow('BILL Reference', refs.bill);
  if (refs.bill_settlement) refsHTML += refRow('Settlement Reference', refs.bill_settlement);
  if (refs.ach_batch) refsHTML += refRow('ACH Batch ID', refs.ach_batch);
  if (refs.wire) refsHTML += refRow('Wire Transfer ID', refs.wire);
  if (refs.journal_entry) refsHTML += refRow('Journal Entry', refs.journal_entry);
  if (refs.settlement) refsHTML += refRow('Settlement ID', refs.settlement);
  if (refs.internal) refsHTML += refRow('Internal Reference', refs.internal);

  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<title>Payment Receipt — ' + receipt.receipt_number + '</title>\n' +
    '<style>\n' +
    '  * { margin:0; padding:0; box-sizing:border-box; }\n' +
    '  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:#f5f5f5; padding:24px; }\n' +
    '  .receipt { max-width:700px; margin:0 auto; background:#fff; border-radius:8px; box-shadow:0 2px 12px rgba(0,0,0,0.1); overflow:hidden; }\n' +
    '  .header { background:#1a1f2e; color:#fff; padding:24px 32px; }\n' +
    '  .header h1 { font-size:20px; margin-bottom:4px; }\n' +
    '  .header .org { font-size:13px; opacity:0.7; }\n' +
    '  .status-banner { padding:16px 32px; background:' + statusColor + '; color:#fff; text-align:center; }\n' +
    '  .status-banner h2 { font-size:24px; letter-spacing:2px; }\n' +
    '  .body { padding:24px 32px; }\n' +
    '  .detail-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:24px; }\n' +
    '  .detail-item label { display:block; font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:2px; }\n' +
    '  .detail-item .value { font-size:15px; color:#1a1f2e; font-weight:500; }\n' +
    '  .amount-box { text-align:center; padding:20px; background:#f0fdf4; border:2px solid ' + statusColor + '; border-radius:8px; margin-bottom:24px; }\n' +
    '  .amount-box .label { font-size:12px; color:#666; text-transform:uppercase; letter-spacing:1px; }\n' +
    '  .amount-box .amount { font-size:36px; font-weight:700; color:#1a1f2e; }\n' +
    '  .section-title { font-size:14px; font-weight:600; color:#1a1f2e; margin:20px 0 10px; padding-bottom:6px; border-bottom:2px solid #e5e7eb; }\n' +
    '  .ref-table { width:100%; border-collapse:collapse; margin-bottom:16px; }\n' +
    '  .ref-table td { padding:6px 0; font-size:13px; }\n' +
    '  .ref-table td:first-child { color:#888; width:180px; }\n' +
    '  .ref-table td:last-child { font-family:monospace; color:#1a1f2e; font-weight:500; word-break:break-all; }\n' +
    '  .timeline-table { width:100%; border-collapse:collapse; }\n' +
    '  .footer { padding:16px 32px; background:#f9fafb; border-top:1px solid #e5e7eb; text-align:center; color:#999; font-size:11px; }\n' +
    '  @media print { body { background:#fff; padding:0; } .receipt { box-shadow:none; } .no-print { display:none; } }\n' +
    '</style>\n</head>\n<body>\n' +
    '<div class="receipt">\n' +
    '  <div class="header">\n' +
    '    <h1>DLB Trust — Payment Receipt</h1>\n' +
    '    <div class="org">' + escapeHTML(receipt.organization) + '</div>\n' +
    '  </div>\n' +
    '  <div class="status-banner"><h2>' + statusLabel + '</h2></div>\n' +
    '  <div class="body">\n' +
    '    <div class="amount-box">\n' +
    '      <div class="label">Amount</div>\n' +
    '      <div class="amount">' + formatCurrency(receipt.amount) + '</div>\n' +
    '    </div>\n' +
    '    <div class="detail-grid">\n' +
    '      <div class="detail-item"><label>Receipt Number</label><div class="value">' + escapeHTML(receipt.receipt_number) + '</div></div>\n' +
    '      <div class="detail-item"><label>Tracking ID</label><div class="value">' + escapeHTML(receipt.tracking_id) + '</div></div>\n' +
    '      <div class="detail-item"><label>Payment Type</label><div class="value">' + escapeHTML(formatPaymentType(receipt.payment_type)) + '</div></div>\n' +
    '      <div class="detail-item"><label>Method</label><div class="value">' + escapeHTML(receipt.payment_method.toUpperCase()) + '</div></div>\n' +
    (receipt.destination_name ? '      <div class="detail-item"><label>Destination</label><div class="value">' + escapeHTML(receipt.destination_name) + '</div></div>\n' : '') +
    (receipt.vendor_name ? '      <div class="detail-item"><label>Vendor</label><div class="value">' + escapeHTML(receipt.vendor_name) + '</div></div>\n' : '') +
    '      <div class="detail-item"><label>Initiated</label><div class="value">' + new Date(receipt.timestamps.initiated).toLocaleString() + '</div></div>\n' +
    (receipt.timestamps.settled ? '      <div class="detail-item"><label>Settled</label><div class="value">' + new Date(receipt.timestamps.settled).toLocaleString() + '</div></div>\n' : '') +
    '    </div>\n' +
    (receipt.description ? '    <div class="detail-item" style="margin-bottom:16px"><label>Description</label><div class="value">' + escapeHTML(receipt.description) + '</div></div>\n' : '') +
    '    <div class="section-title">References & Confirmation</div>\n' +
    '    <table class="ref-table">' + refsHTML + '</table>\n' +
    '    <div class="section-title">Payment Timeline</div>\n' +
    '    <table class="timeline-table">' + timelineHTML + '</table>\n' +
    '  </div>\n' +
    '  <div class="footer">\n' +
    '    Generated: ' + new Date(receipt.generated_at).toLocaleString() + ' | ' + escapeHTML(receipt.system) + '<br>\n' +
    '    This receipt serves as digital confirmation of payment processing.\n' +
    '  </div>\n' +
    '</div>\n' +
    '<div class="no-print" style="text-align:center;margin:24px;">\n' +
    '  <button onclick="window.print()" style="padding:12px 32px;background:#1a1f2e;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer;">Print Receipt</button>\n' +
    '</div>\n' +
    '</body></html>';
}

function refRow(label, value) {
  return '<tr><td>' + escapeHTML(label) + '</td><td>' + escapeHTML(value) + '</td></tr>';
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PAYMENT HISTORY / DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

async function getPaymentDashboard() {
  var results = await Promise.all([
    pool.query(`
      SELECT status, COUNT(*) as count, COALESCE(SUM(amount), 0) as total
      FROM payment_tracker GROUP BY status
    `),
    pool.query(`
      SELECT * FROM payment_tracker ORDER BY created_at DESC LIMIT 20
    `),
    getUnreadCount(),
    pool.query(`
      SELECT * FROM payment_notifications WHERE is_read = FALSE ORDER BY created_at DESC LIMIT 10
    `)
  ]);

  var statusBreakdown = {};
  results[0].rows.forEach(function(r) {
    statusBreakdown[r.status] = { count: parseInt(r.count), total: parseFloat(r.total) };
  });

  return {
    status_breakdown: statusBreakdown,
    recent_payments: results[1].rows,
    unread_notifications: results[2],
    latest_notifications: results[3].rows
  };
}

async function getPaymentDetail(trackingId) {
  var payment = await pool.query('SELECT * FROM payment_tracker WHERE tracking_id = $1', [trackingId]);
  if (payment.rowCount === 0) return null;

  var notifications = await pool.query(
    'SELECT * FROM payment_notifications WHERE tracking_id = $1 ORDER BY created_at ASC',
    [trackingId]
  );

  return {
    payment: payment.rows[0],
    timeline: notifications.rows
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function formatCurrency(amount) {
  return '$' + parseFloat(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPaymentType(type) {
  var map = {
    deposit: 'Deposit',
    vendor_payment: 'Vendor Payment',
    wire_transfer: 'Wire Transfer',
    ach_batch: 'ACH Batch',
    distribution: 'Distribution'
  };
  return map[type] || type;
}

function escapeHTML(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = {
  ensureTables: ensureTables,
  trackPayment: trackPayment,
  updatePaymentStatus: updatePaymentStatus,
  createNotification: createNotification,
  getNotifications: getNotifications,
  markNotificationRead: markNotificationRead,
  markAllRead: markAllRead,
  getUnreadCount: getUnreadCount,
  pollBillConfirmations: pollBillConfirmations,
  generateReceipt: generateReceipt,
  generateReceiptHTML: generateReceiptHTML,
  getPaymentDashboard: getPaymentDashboard,
  getPaymentDetail: getPaymentDetail,
  generateConfirmationCode: generateConfirmationCode
};
