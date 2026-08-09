'use strict';

/**
 * Skrill.me/rq Payment Link Engine
 *
 * Parses a Skrill consumer request link (e.g. https://skrill.me/rq/DeAndrea/100/USD?key=...),
 * stores it as a payable request, and attempts to settle it via the Skrill Automated
 * Payments Interface (API) / Merchant Query Interface (MQI) send-money flow.
 *
 * Real money leaves the trust's Skrill merchant balance only when Skrill API
 * credentials are configured. If credentials are missing the engine produces a
 * `needs_config` record and a manual payment page.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { /* optional */ }

let SystemSettings, CashEngine;
function loadDeps() {
  try { ({ SystemSettings } = require('../ach/systemSettings')); } catch (e) { SystemSettings = null; }
  try { CashEngine = require('../cash/cashEngine'); } catch (e) { CashEngine = null; }
}

const https = require('https');
const { URL } = require('url');

const TABLE = 'skrill_link_payments';

function generateId(prefix = 'SKP') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

async function getSetting(name) {
  loadDeps();
  if (SystemSettings && typeof SystemSettings.get === 'function') {
    try { return await SystemSettings.get(name); } catch (e) { /* fall through */ }
  }
  return process.env[name] || null;
}

function httpPostForm(urlStr, form) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const params = new URLSearchParams(form).toString();
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(params),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { resolve({ statusCode: res.statusCode, body: data }); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
    req.write(params);
    req.end();
  });
}

function parseSkrillLink(linkUrl) {
  const url = new URL(linkUrl);
  // Expected path: /rq/{recipient}/{amount}/{currency}
  const parts = url.pathname.replace(/^\/+/, '').split('/');
  const recipient = parts[1] || '';
  const amount = Number(parts[2]) || 0;
  const currency = (parts[3] || 'USD').toUpperCase();
  const key = url.searchParams.get('key') || '';
  return { recipient, amount, currency, key, linkUrl };
}

async function fetchLinkMeta(linkUrl) {
  try {
    const https = require('https');
    const { URL } = require('url');
    const parsed = new URL(linkUrl);
    return await new Promise((resolve, reject) => {
      const req = https.get({
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search || ''}`,
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 15000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => { resolve(data); });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
    });
  } catch (e) {
    return '';
  }
}

function extractTitle(html) {
  const m = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i);
  return m ? m[1] : '';
}

class SkrillLinkEngine {
  static async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id SERIAL PRIMARY KEY,
        payment_id TEXT UNIQUE NOT NULL,
        link_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','needs_config','manual','paid','failed','cancelled')),
        recipient TEXT,
        recipient_email TEXT,
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        request_key TEXT,
        title TEXT,
        raw_html TEXT,
        external_tx_id TEXT,
        external_status TEXT,
        raw_request JSONB,
        raw_response JSONB,
        error_message TEXT,
        initiated_by TEXT NOT NULL DEFAULT 'system',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_status ON ${TABLE}(status)`);
  }

  static async createPayment({ linkUrl, recipientEmail, initiatedBy = 'system' }) {
    loadDeps();
    await this.ensureTables();
    if (!linkUrl || !linkUrl.includes('skrill.me')) throw new Error('A valid skrill.me link is required');

    const parsed = parseSkrillLink(linkUrl);
    const html = await fetchLinkMeta(linkUrl);
    const title = extractTitle(html);

    const paymentId = generateId('SKP');
    await pool.query(
      `INSERT INTO ${TABLE} (payment_id, link_url, status, recipient, recipient_email, amount_cents, currency, request_key, title, raw_html, initiated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [paymentId, linkUrl, 'pending', parsed.recipient, recipientEmail || null, toCents(parsed.amount), parsed.currency, parsed.key, title, html, initiatedBy]
    );
    return this.getPayment(paymentId);
  }

  static async getPayment(paymentId) {
    if (!pool) throw new Error('Database not available');
    const result = await pool.query(`SELECT * FROM ${TABLE} WHERE payment_id = $1`, [paymentId]);
    return result.rows[0] || null;
  }

  static async listPayments({ limit = 50, status } = {}) {
    if (!pool) throw new Error('Database not available');
    let sql = `SELECT * FROM ${TABLE}`;
    const params = [];
    if (status) { sql += ' WHERE status = $1'; params.push(status); }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    const result = await pool.query(sql, params);
    return result.rows;
  }

  static async pay(paymentId) {
    loadDeps();
    await this.ensureTables();
    const row = await this.getPayment(paymentId);
    if (!row) throw new Error('Payment not found');
    if (!['pending','needs_config','manual'].includes(row.status)) throw new Error(`Payment status is ${row.status}`);

    const merchantEmail = await getSetting('SKRILL_MERCHANT_EMAIL') || process.env.SKRILL_MERCHANT_EMAIL;
    const apiPassword = await getSetting('SKRILL_API_PASSWORD') || process.env.SKRILL_API_PASSWORD;

    if (!merchantEmail || !apiPassword) {
      await pool.query(`UPDATE ${TABLE} SET status='needs_config', error_message=$1, updated_at=NOW() WHERE payment_id=$2`,
        ['SKRILL_MERCHANT_EMAIL and SKRILL_API_PASSWORD are not configured', paymentId]);
      return this.getPayment(paymentId);
    }

    if (!row.recipient_email) {
      await pool.query(`UPDATE ${TABLE} SET status='manual', error_message=$1, updated_at=NOW() WHERE payment_id=$2`,
        ['Recipient Skrill email is required for API payout. Provide recipient_email or open the Skrill link manually.', paymentId]);
      return this.getPayment(paymentId);
    }

    // Skrill API uses MD5 of the API/MQI password
    const crypto = require('crypto');
    const md5Password = crypto.createHash('md5').update(apiPassword).digest('hex');

    const prepareForm = {
      action: 'prepare',
      email: merchantEmail,
      password: md5Password,
      amount: (row.amount_cents / 100).toFixed(2),
      currency: row.currency,
      bnf_email: row.recipient_email,
      subject: `Payment for ${row.recipient}`,
      note: `Skrill link payment ${paymentId} - ${row.link_url}`,
      frn_trn_id: paymentId,
    };

    try {
      const prepare = await httpPostForm('https://www.skrill.com/app/pay.pl', prepareForm);
      // Skrill MQI returns XML; look for a session id
      const sidMatch = prepare.body.match(/<sid>([^<]+)<\/sid>/i);
      if (!sidMatch) {
        const err = prepare.body.match(/<error>([^<]+)<\/error>/i);
        throw new Error(err ? err[1] : 'Skrill prepare failed: no session returned');
      }
      const sid = sidMatch[1];

      const transferForm = {
        action: 'transfer',
        email: merchantEmail,
        password: md5Password,
        sid,
      };
      const transfer = await httpPostForm('https://www.skrill.com/app/pay.pl', transferForm);

      await pool.query(
        `UPDATE ${TABLE} SET status='paid', external_tx_id=$1, external_status='completed', raw_request=$2, raw_response=$3, error_message=null, updated_at=NOW() WHERE payment_id=$4`,
        [sid, JSON.stringify(prepareForm), JSON.stringify({ prepare: prepare.body, transfer: transfer.body }), paymentId]
      );
    } catch (err) {
      await pool.query(
        `UPDATE ${TABLE} SET status='failed', error_message=$1, updated_at=NOW() WHERE payment_id=$2`,
        [err.message, paymentId]
      );
      throw err;
    }

    return this.getPayment(paymentId);
  }

  static async markPaidManually(paymentId, { reference }) {
    const row = await this.getPayment(paymentId);
    if (!row) throw new Error('Payment not found');
    await pool.query(
      `UPDATE ${TABLE} SET status='paid', external_tx_id=$1, external_status='manual', updated_at=NOW() WHERE payment_id=$2`,
      [reference || 'manual', paymentId]
    );
    return this.getPayment(paymentId);
  }

  static async cancel(paymentId) {
    const row = await this.getPayment(paymentId);
    if (!row) throw new Error('Payment not found');
    if (row.status === 'paid') throw new Error('Cannot cancel a paid payment');
    await pool.query(`UPDATE ${TABLE} SET status='cancelled', updated_at=NOW() WHERE payment_id=$1`, [paymentId]);
    return this.getPayment(paymentId);
  }
}

module.exports = { SkrillLinkEngine, parseSkrillLink };
