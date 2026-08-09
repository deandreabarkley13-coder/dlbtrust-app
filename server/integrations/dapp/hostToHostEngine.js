'use strict';

/**
 * Host-to-Host Engine
 *
 * Sends and receives bank payment files/messages over point-to-point channels:
 * SFTP, FTPS, AS2, HTTPS, and HTTP. Wraps the existing AS2 client, NACHA
 * generator, ISO 20022 builder, and generic HTTP transport so the trust can
 * exchange payment files with a bank or clearing partner host-to-host.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { Readable } = require('stream');
const pool = require('../bonds/pgPool');

let CashEngine;
try { ({ CashEngine } = require('../cash/cashEngine')); } catch (e) { CashEngine = null; }

let SettlementEngine;
try { SettlementEngine = require('./settlementEngine').SettlementEngine; } catch (e) { SettlementEngine = null; }

let ExternalEndpointEngine;
let httpRequest;
let buildSimplePain001;
try {
  const eee = require('./externalEndpointEngine');
  ExternalEndpointEngine = eee.ExternalEndpointEngine;
  httpRequest = eee.httpRequest;
  buildSimplePain001 = eee.buildSimplePain001;
} catch (e) { /* ignore */ }

let AS2Client;
try { ({ AS2Client } = require('../ach/as2Client')); } catch (e) { AS2Client = null; }

let Nacha;
try { Nacha = require('../ach/nachaGenerator'); } catch (e) { Nacha = null; }

const HOLD_ACCOUNT = 'HOST_TO_HOST_HOLD';
const SETTLED_ACCOUNT = 'HOST_TO_HOST_SETTLED';

function id(prefix = 'H2H') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

function dollars(cents) {
  return Number(cents || 0) / 100;
}

function mask(value) {
  const s = String(value || '');
  if (s.length <= 8) return '*'.repeat(s.length);
  return s.slice(0, 4) + '...' + s.slice(-4);
}

function normalizeProtocol(p) {
  if (!p) return 'https';
  const low = String(p).toLowerCase();
  if (['sftp','ftps','as2','http','https'].includes(low)) return low;
  return 'https';
}

class HostToHostEngine {
  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS host_to_host_partners (
        partner_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL CHECK (protocol IN ('sftp','ftps','as2','https','http')),
        host TEXT NOT NULL,
        port INTEGER,
        username TEXT DEFAULT '',
        password TEXT DEFAULT '',
        private_key TEXT DEFAULT '',
        remote_path TEXT DEFAULT '',
        as2_id TEXT DEFAULT '',
        as2_url TEXT DEFAULT '',
        as2_signing_cert TEXT DEFAULT '',
        as2_signing_key TEXT DEFAULT '',
        as2_partner_cert TEXT DEFAULT '',
        as2_encryption_alg TEXT DEFAULT 'aes256-cbc',
        as2_signing_alg TEXT DEFAULT 'sha256',
        api_key TEXT DEFAULT '',
        auth_headers JSONB DEFAULT '{}',
        message_type TEXT DEFAULT 'json' CHECK (message_type IN ('nacha','iso20022','json','xml','csv','raw')),
        template TEXT DEFAULT '',
        partner_config JSONB DEFAULT '{}',
        enabled BOOLEAN NOT NULL DEFAULT true,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS host_to_host_transmissions (
        transmission_id TEXT PRIMARY KEY,
        partner_id TEXT REFERENCES host_to_host_partners(partner_id),
        direction TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','transmitted','delivered','failed','acknowledged','received')),
        message_type TEXT DEFAULT '',
        filename TEXT DEFAULT '',
        remote_path TEXT DEFAULT '',
        payload TEXT DEFAULT '',
        payload_size INTEGER DEFAULT 0,
        raw_request TEXT DEFAULT '',
        raw_response TEXT DEFAULT '',
        error_message TEXT DEFAULT '',
        settlement_id TEXT DEFAULT '',
        amount_cents BIGINT DEFAULT 0,
        currency TEXT DEFAULT 'USD',
        creditor_name TEXT DEFAULT '',
        creditor_account TEXT DEFAULT '',
        creditor_routing TEXT DEFAULT '',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_h2h_partner_enabled ON host_to_host_partners(enabled)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_h2h_txn_status ON host_to_host_transmissions(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_h2h_txn_settlement ON host_to_host_transmissions(settlement_id)`);
  }

  static async ensureHoldAccounts() {
    if (!CashEngine || !CashEngine.getOrCreateHoldAccount) return;
    try { await CashEngine.getOrCreateHoldAccount(HOLD_ACCOUNT, { currency: 'USD', description: 'Host-to-host payment hold' }); } catch (e) { console.warn('[h2h] hold account:', e.message); }
    try { await CashEngine.getOrCreateHoldAccount(SETTLED_ACCOUNT, { currency: 'USD', description: 'Host-to-host payment settled' }); } catch (e) { console.warn('[h2h] settled account:', e.message); }
  }

  // ─── Partner CRUD ────────────────────────────────────────────────────────────
  static async createPartner(opts = {}) {
    const partnerId = opts.partnerId || id('H2H-PARTNER');
    const protocol = normalizeProtocol(opts.protocol);
    const defaultPort = protocol === 'sftp' ? 22 : protocol === 'ftps' ? 21 : protocol === 'http' ? 80 : 443;
    await pool.query(`
      INSERT INTO host_to_host_partners
        (partner_id, name, protocol, host, port, username, password, private_key, remote_path, as2_id, as2_url,
         as2_signing_cert, as2_signing_key, as2_partner_cert, as2_encryption_alg, as2_signing_alg,
         api_key, auth_headers, message_type, template, partner_config, enabled, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
      RETURNING *
    `, [
      partnerId, opts.name || 'Host-to-Host Partner', protocol, opts.host || '', opts.port || defaultPort,
      opts.username || '', opts.password || '', opts.privateKey || '', opts.remotePath || '',
      opts.as2Id || '', opts.as2Url || '', opts.as2SigningCert || '', opts.as2SigningKey || '',
      opts.as2PartnerCert || '', opts.as2EncryptionAlg || 'aes256-cbc', opts.as2SigningAlg || 'sha256',
      opts.apiKey || '', JSON.stringify(opts.authHeaders || {}), opts.messageType || 'json',
      opts.template || '', JSON.stringify(opts.partnerConfig || {}), opts.enabled !== false,
      JSON.stringify(opts.metadata || {})
    ]);
    return this.getPartner(partnerId);
  }

  static async listPartners({ enabled } = {}) {
    const where = enabled !== undefined ? 'WHERE enabled = $1' : '';
    const params = enabled !== undefined ? [enabled] : [];
    const res = await pool.query(`SELECT * FROM host_to_host_partners ${where} ORDER BY name`, params);
    return res.rows;
  }

  static async getPartner(partnerId) {
    const res = await pool.query('SELECT * FROM host_to_host_partners WHERE partner_id = $1', [partnerId]);
    return res.rows[0] || null;
  }

  static async updatePartner(partnerId, updates = {}) {
    const allowed = ['name','protocol','host','port','username','password','private_key','remote_path','as2_id','as2_url','as2_signing_cert','as2_signing_key','as2_partner_cert','as2_encryption_alg','as2_signing_alg','api_key','auth_headers','message_type','template','partner_config','enabled','metadata'];
    const sets = []; const params = []; let i = 1;
    for (const k of allowed) {
      if (updates[k] !== undefined) {
        sets.push(`${k} = $${i++}`);
        params.push(typeof updates[k] === 'object' && updates[k] !== null ? JSON.stringify(updates[k]) : updates[k]);
      }
    }
    if (!sets.length) return this.getPartner(partnerId);
    params.push(partnerId);
    await pool.query(`UPDATE host_to_host_partners SET ${sets.join(', ')}, updated_at = NOW() WHERE partner_id = $${i}`, params);
    return this.getPartner(partnerId);
  }

  static async deletePartner(partnerId) {
    await pool.query('DELETE FROM host_to_host_partners WHERE partner_id = $1', [partnerId]);
    return { deleted: partnerId };
  }

  // ─── Payload builders ──────────────────────────────────────────────────────────
  static _buildPayload(partner, payment = {}) {
    const amountCents = Number(payment.amount_cents) || Number(payment.amountCents) || toCents(Number(payment.amount) || 0) || 0;
    const amount = dollars(amountCents);
    const ctx = {
      paymentId: payment.paymentId || payment.transmissionId || id('H2H-PMT'),
      amount,
      amountCents: toCents(amount),
      currency: payment.currency || 'USD',
      date: new Date().toISOString().slice(0, 10),
      timestamp: new Date().toISOString(),
      creditor: {
        name: payment.creditorName || payment.creditor_name || '',
        account: payment.creditorAccount || payment.creditor_account || '',
        routing: payment.creditorRouting || payment.creditor_routing || '',
        bank: payment.creditorBank || payment.creditor_bank || '',
      },
      debtor: {
        name: payment.debtorName || payment.debtor_name || 'DLB Trust',
        account: payment.debtorAccount || payment.debtor_account || '',
        routing: payment.debtorRouting || payment.debtor_routing || '',
        bank: payment.debtorBank || payment.debtor_bank || '',
      },
      memo: payment.memo || payment.description || '',
    };

    if (partner.template) {
      let t = String(partner.template);
      t = t.replace(/\{\{(\w+)\}\}/g, (m, key) => {
        if (key === 'amount') return amount.toFixed(2);
        if (ctx[key] !== undefined) return ctx[key];
        if (ctx.creditor[key] !== undefined) return ctx.creditor[key];
        if (ctx.debtor[key] !== undefined) return ctx.debtor[key];
        return '';
      });
      return { content: t, filename: `${ctx.paymentId}.${this._ext(partner.message_type)}` };
    }

    if (partner.message_type === 'nacha' && Nacha) {
      const content = Nacha.generateNACHAFile({}, [{
        secCode: 'CCD',
        companyEntryDescription: 'PAYMENT',
        effectiveEntryDate: ctx.date,
        serviceClassCode: '220',
        entries: [{
          receivingRouting: ctx.creditor.routing,
          accountNumber: ctx.creditor.account,
          amountCents: toCents(amount),
          transactionCode: '22',
          individualId: ctx.paymentId,
          individualName: ctx.creditor.name,
        }],
      }]);
      return { content, filename: `${ctx.paymentId}.ach` };
    }

    if (partner.message_type === 'iso20022' && buildSimplePain001) {
      const content = buildSimplePain001(ctx);
      return { content, filename: `${ctx.paymentId}.xml` };
    }

    if (partner.message_type === 'xml') {
      const xml = `<?xml version="1.0"?><Payment><Id>${ctx.paymentId}</Id><Amount>${amount.toFixed(2)}</Amount><Currency>${ctx.currency}</Currency><CreditorName>${this._escapeXml(ctx.creditor.name)}</CreditorName><CreditorAccount>${ctx.creditor.account}</CreditorAccount><CreditorRouting>${ctx.creditor.routing}</CreditorRouting><Memo>${this._escapeXml(ctx.memo)}</Memo></Payment>`;
      return { content: xml, filename: `${ctx.paymentId}.xml` };
    }

    if (partner.message_type === 'csv') {
      const csv = `payment_id,amount,currency,creditor_name,creditor_account,creditor_routing,memo\n${ctx.paymentId},${amount.toFixed(2)},${ctx.currency},${ctx.creditor.name},${ctx.creditor.account},${ctx.creditor.routing},${ctx.memo}`;
      return { content: csv, filename: `${ctx.paymentId}.csv` };
    }

    const json = JSON.stringify(ctx, null, 2);
    return { content: json, filename: `${ctx.paymentId}.json` };
  }

  static _ext(type) {
    if (type === 'nacha') return 'ach';
    if (type === 'iso20022' || type === 'xml') return 'xml';
    if (type === 'csv') return 'csv';
    return 'json';
  }

  static _escapeXml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  // ─── Transport ─────────────────────────────────────────────────────────────────
  static async testConnection(partnerId) {
    const partner = await this.getPartner(partnerId);
    if (!partner) throw new Error('Partner not found');
    const protocol = normalizeProtocol(partner.protocol);

    if (protocol === 'https' || protocol === 'http') {
      const url = `${protocol}://${partner.host}${partner.port ? ':' + partner.port : ''}${partner.remote_path || '/'}`;
      const res = await this._httpSend(partner, { method: 'GET', url, body: null });
      return { ok: res.statusCode >= 200 && res.statusCode < 400, statusCode: res.statusCode };
    }

    if (protocol === 'as2') {
      if (!AS2Client || !AS2Client.testConnection) return { ok: false, error: 'AS2Client not available' };
      const cfg = this._as2Config(partner);
      const res = await AS2Client.testConnection(cfg);
      return { ok: res && res.success, detail: res };
    }

    if (protocol === 'sftp') {
      return await this._sftpTest(partner);
    }

    if (protocol === 'ftps') {
      return await this._ftpsTest(partner);
    }

    return { ok: false, error: 'Unsupported protocol' };
  }

  static async sendPayment(opts = {}) {
    const partnerId = opts.partnerId || opts.endpointId;
    if (!partnerId) throw new Error('partnerId or endpointId required');
    const partner = await this.getPartner(partnerId);
    if (!partner) throw new Error('Partner not found');
    if (!partner.enabled) throw new Error('Partner disabled');
    const { content, filename } = this._buildPayload(partner, opts);

    const transmissionId = opts.transmissionId || id('H2H-TXN');
    await this._logTransmission({ transmissionId, partnerId, direction: 'outbound', status: 'pending', messageType: partner.message_type, filename, payload: content, amountCents: toCents(opts.amount), currency: opts.currency || 'USD', settlementId: opts.settlementId || opts.settlement_id || '', creditor: opts.creditor || {} });

    let result = { status: 'pending', rawRequest: '', rawResponse: '', error: '' };
    try {
      if (partner.protocol === 'sftp') {
        result = await this._sendSftp(partner, content, filename);
      } else if (partner.protocol === 'ftps') {
        result = await this._sendFtps(partner, content, filename);
      } else if (partner.protocol === 'as2') {
        result = await this._sendAs2(partner, content, filename);
      } else {
        result = await this._sendHttp(partner, content, filename, opts);
      }
      await this._updateTransmission(transmissionId, { status: result.status, rawRequest: result.rawRequest, rawResponse: result.rawResponse, errorMessage: result.error, remotePath: result.remotePath || '' });
    } catch (e) {
      await this._updateTransmission(transmissionId, { status: 'failed', errorMessage: e.message });
      throw e;
    }

    return { transmissionId, partnerId, status: result.status, filename, rawRequest: result.rawRequest, rawResponse: result.rawResponse };
  }

  static async _logTransmission({ transmissionId, partnerId, direction, status, messageType, filename, payload, payloadSize, rawRequest, rawResponse, errorMessage, amountCents, currency, settlementId, creditor }) {
    await pool.query(`
      INSERT INTO host_to_host_transmissions
        (transmission_id, partner_id, direction, status, message_type, filename, remote_path, payload, payload_size, raw_request, raw_response, error_message, settlement_id, amount_cents, currency, creditor_name, creditor_account, creditor_routing, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (transmission_id) DO UPDATE SET
        status = EXCLUDED.status,
        raw_request = EXCLUDED.raw_request,
        raw_response = EXCLUDED.raw_response,
        error_message = EXCLUDED.error_message,
        updated_at = NOW()
    `, [
      transmissionId, partnerId, direction, status, messageType || '', filename || '', '',
      payload || '', payloadSize || (payload ? Buffer.byteLength(payload) : 0),
      rawRequest || '', rawResponse || '', errorMessage || '', settlementId || '',
      amountCents || 0, currency || 'USD',
      creditor ? creditor.name || '' : '',
      creditor ? creditor.account || '' : '',
      creditor ? creditor.routing || '' : '',
      '{}'
    ]);
  }

  static async _updateTransmission(transmissionId, updates) {
    const allowed = ['status','remote_path','raw_request','raw_response','error_message','metadata'];
    const sets = []; const params = []; let i = 1;
    for (const k of allowed) {
      if (updates[k] !== undefined) { sets.push(`${k} = $${i++}`); params.push(updates[k]); }
    }
    if (!sets.length) return;
    params.push(transmissionId);
    await pool.query(`UPDATE host_to_host_transmissions SET ${sets.join(', ')}, updated_at = NOW() WHERE transmission_id = $${i}`, params);
  }

  // ─── HTTP/HTTPS ───────────────────────────────────────────────────────────────
  static async _sendHttp(partner, content, filename, opts = {}) {
    const url = `${partner.protocol}://${partner.host}${partner.port ? ':' + partner.port : ''}${partner.remote_path || '/'}`;
    const headers = { ...(partner.auth_headers || {}) };
    if (partner.api_key) headers['Authorization'] = `Bearer ${partner.api_key}`;
    if (partner.message_type === 'json') headers['Content-Type'] = 'application/json';
    else if (partner.message_type === 'xml' || partner.message_type === 'iso20022') headers['Content-Type'] = 'application/xml';
    else headers['Content-Type'] = 'text/plain';
    headers['X-H2H-Filename'] = filename;

    const res = await this._httpSend(partner, { url, method: 'POST', headers, body: content });
    const status = res.statusCode >= 200 && res.statusCode < 300 ? 'transmitted' : 'failed';
    return {
      status,
      rawRequest: `POST ${url}\n${JSON.stringify(headers)}\n\n${content}`.slice(0, 20000),
      rawResponse: `${res.statusCode}\n${res.body}`.slice(0, 20000),
      error: status === 'failed' ? `HTTP ${res.statusCode}` : '',
    };
  }

  static _httpSend(partner, { url, method = 'POST', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
      if (httpRequest) {
        httpRequest({ url, method, headers, body, timeoutMs: 60000 }).then(resolve).catch(reject);
        return;
      }
      const parsed = new URL(url);
      const client = parsed.protocol === 'https:' ? https : http;
      const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
      const reqHeaders = { ...headers };
      if (payload) reqHeaders['Content-Length'] = Buffer.byteLength(payload);
      const req = client.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search || ''}`,
        method,
        headers: reqHeaders,
        timeout: 60000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data, json: null }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
      if (payload) req.write(payload);
      req.end();
    });
  }

  // ─── SFTP ─────────────────────────────────────────────────────────────────────
  static async _sftpTest(partner) {
    const { Client } = require('ssh2');
    return new Promise((resolve, reject) => {
      const conn = new Client();
      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) { conn.end(); reject(err); return; }
          const remotePath = partner.remote_path || '.';
          sftp.readdir(remotePath, (err2, list) => {
            conn.end();
            if (err2) reject(err2);
            else resolve({ ok: true, files: (list || []).length });
          });
        });
      });
      conn.on('error', reject);
      conn.connect(this._sshConfig(partner));
    });
  }

  static async _sendSftp(partner, content, filename) {
    const { Client } = require('ssh2');
    const remotePath = (partner.remote_path || '/').replace(/\/$/, '') + '/' + filename;
    return new Promise((resolve, reject) => {
      const conn = new Client();
      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) { conn.end(); reject(err); return; }
          sftp.writeFile(remotePath, content, (err2) => {
            conn.end();
            if (err2) reject(err2);
            else resolve({ status: 'transmitted', rawRequest: `SFTP PUT ${remotePath}\n${content.slice(0, 5000)}`, rawResponse: 'SFTP upload completed', remotePath });
          });
        });
      });
      conn.on('error', reject);
      conn.connect(this._sshConfig(partner));
    });
  }

  static _sshConfig(partner) {
    const cfg = { host: partner.host, port: partner.port || 22, username: partner.username || 'anonymous', readyTimeout: 30000 };
    if (partner.private_key) cfg.privateKey = partner.private_key;
    else if (partner.password) cfg.password = partner.password;
    return cfg;
  }

  // ─── FTPS ─────────────────────────────────────────────────────────────────────
  static async _ftpsTest(partner) {
    const ftp = require('basic-ftp');
    const client = new ftp.Client(30000);
    client.ftp.verbose = false;
    try {
      await client.access({ host: partner.host, port: partner.port || 21, user: partner.username || 'anonymous', password: partner.password || '', secure: true });
      const list = await client.list(partner.remote_path || '/');
      return { ok: true, files: list.length };
    } finally { client.close(); }
  }

  static async _sendFtps(partner, content, filename) {
    const ftp = require('basic-ftp');
    const client = new ftp.Client(60000);
    client.ftp.verbose = false;
    const remotePath = (partner.remote_path || '/').replace(/\/$/, '') + '/' + filename;
    try {
      await client.access({ host: partner.host, port: partner.port || 21, user: partner.username || 'anonymous', password: partner.password || '', secure: true });
      await client.uploadFrom(Readable.from([Buffer.from(content)]), remotePath);
      return { status: 'transmitted', rawRequest: `FTPS PUT ${remotePath}\n${content.slice(0, 5000)}`, rawResponse: 'FTPS upload completed', remotePath };
    } finally { client.close(); }
  }

  // ─── AS2 ────────────────────────────────────────────────────────────────────────
  static _as2Config(partner) {
    return {
      partnerUrl: partner.as2_url || `https://${partner.host}${partner.port ? ':' + partner.port : ''}${partner.remote_path || '/'}}`,
      partnerAs2Id: partner.as2_id || '',
      localAs2Id: (partner.partner_config || {}).localAs2Id || 'DLBTRUST-AS2',
      signingCertPath: '',
      signingKeyPath: '',
      partnerCertPath: '',
      signingCert: partner.as2_signing_cert || undefined,
      signingKey: partner.as2_signing_key || undefined,
      partnerCert: partner.as2_partner_cert || undefined,
      encryptionAlg: partner.as2_encryption_alg || 'aes256-cbc',
      signingAlg: partner.as2_signing_alg || 'sha256',
      requestMdn: true,
    };
  }

  static async _sendAs2(partner, content, filename) {
    if (!AS2Client || !AS2Client.transmit) throw new Error('AS2Client not available');
    const cfg = this._as2Config(partner);
    const res = await AS2Client.transmit(content, filename, cfg);
    return {
      status: res.success ? 'transmitted' : 'failed',
      rawRequest: `AS2 POST ${cfg.partnerUrl}\n${content.slice(0, 5000)}`,
      rawResponse: JSON.stringify(res),
      error: res.error || '',
    };
  }

  // ─── Transmission CRUD ─────────────────────────────────────────────────────────
  static async listTransmissions({ status, partnerId, direction, limit = 50 } = {}) {
    const conditions = []; const params = []; let i = 1;
    if (status) { conditions.push(`status = $${i++}`); params.push(status); }
    if (partnerId) { conditions.push(`partner_id = $${i++}`); params.push(partnerId); }
    if (direction) { conditions.push(`direction = $${i++}`); params.push(direction); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Number(limit) || 50);
    const res = await pool.query(`SELECT * FROM host_to_host_transmissions ${where} ORDER BY created_at DESC LIMIT $${i}`, params);
    return res.rows;
  }

  static async getTransmission(transmissionId) {
    const res = await pool.query('SELECT * FROM host_to_host_transmissions WHERE transmission_id = $1', [transmissionId]);
    return res.rows[0] || null;
  }

  static async getDashboard() {
    const partners = await this.listPartners({ enabled: true });
    const [txns, pending, transmitted, failed] = await Promise.all([
      this.listTransmissions({ limit: 100 }),
      pool.query("SELECT COUNT(*) AS c FROM host_to_host_transmissions WHERE status = 'pending'").then(r => Number(r.rows[0].c)),
      pool.query("SELECT COUNT(*) AS c FROM host_to_host_transmissions WHERE status IN ('transmitted','delivered','acknowledged')").then(r => Number(r.rows[0].c)),
      pool.query("SELECT COUNT(*) AS c FROM host_to_host_transmissions WHERE status = 'failed'").then(r => Number(r.rows[0].c)),
    ]);
    return { partners: partners.length, transmissions: txns, pending, transmitted, failed };
  }

  // ─── Settlement integration ───────────────────────────────────────────────────
  static async executeSettlement(settlement) {
    const partnerId = settlement.endpoint_id || settlement.partner_id;
    if (!partnerId) throw new Error('Host-to-host settlement requires endpoint_id/partner_id');
    const result = await this.sendPayment({
      partnerId,
      settlementId: settlement.settlement_id,
      amount: settlement.amount_cents / 100,
      currency: settlement.currency,
      creditorName: settlement.creditor_name,
      creditorAccount: settlement.creditor_account,
      creditorRouting: settlement.creditor_routing,
      creditorBank: settlement.creditor_bank,
      debtorName: settlement.debtor_name,
      debtorAccount: settlement.debtor_account,
      debtorRouting: settlement.debtor_routing,
      description: settlement.description,
    });
    return result;
  }
}

module.exports = { HostToHostEngine };
