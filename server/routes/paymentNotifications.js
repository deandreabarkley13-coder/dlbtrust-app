/**
 * Payment Notifications & Receipt Routes — dlbtrust.cloud
 * Mounts at: /api/payments
 *
 * Real-time payment status tracking, notifications, settlement polling,
 * and digital receipt generation.
 */

'use strict';

var express = require('express');
var router = express.Router();
var path = require('path');

var notifEngine = require(path.join(__dirname, '../integrations/payments/paymentNotificationEngine'));

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/dashboard', async function(req, res) {
  try {
    var dashboard = await notifEngine.getPaymentDashboard();
    res.json({ success: true, data: dashboard });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/notifications', async function(req, res) {
  try {
    var notifications = await notifEngine.getNotifications({
      unread_only: req.query.unread === 'true',
      tracking_id: req.query.tracking_id,
      severity: req.query.severity,
      limit: req.query.limit
    });
    var unreadCount = await notifEngine.getUnreadCount();
    res.json({ success: true, unread_count: unreadCount, data: notifications });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/notifications/count', async function(req, res) {
  try {
    var count = await notifEngine.getUnreadCount();
    res.json({ success: true, unread_count: count });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/notifications/:notificationId/read', async function(req, res) {
  try {
    await notifEngine.markNotificationRead(req.params.notificationId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/notifications/read-all', async function(req, res) {
  try {
    var count = await notifEngine.markAllRead();
    res.json({ success: true, marked_read: count });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENT TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/track/:trackingId', async function(req, res) {
  try {
    var detail = await notifEngine.getPaymentDetail(req.params.trackingId);
    if (!detail) return res.status(404).json({ success: false, error: 'Payment not found' });
    res.json({ success: true, data: detail });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// RECEIPT
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/receipt/:trackingId', async function(req, res) {
  try {
    var receipt = await notifEngine.generateReceipt(req.params.trackingId);
    if (!receipt) return res.status(404).json({ success: false, error: 'Payment not found' });
    res.json({ success: true, data: receipt });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/receipt/:trackingId/html', async function(req, res) {
  try {
    var receipt = await notifEngine.generateReceipt(req.params.trackingId);
    if (!receipt) return res.status(404).send('<html><body><h1>Receipt Not Found</h1></body></html>');
    var html = notifEngine.generateReceiptHTML(receipt);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    var safeMsg = (err.message || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    res.status(500).send('<html><body><h1>Error generating receipt</h1><p>' + safeMsg + '</p></body></html>');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SETTLEMENT POLLING
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/poll-settlements', async function(req, res) {
  try {
    var result = await notifEngine.pollBillConfirmations();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
