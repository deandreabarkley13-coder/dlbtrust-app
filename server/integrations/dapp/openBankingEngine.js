'use strict';

/**
 * Open Banking API Engine with ISO 20022 messaging and pluggable bank connectors.
 *
 * Generates pain.001 credit-transfer instructions, calls configured bank APIs
 * (Column, Increase, Plaid, or generic REST/SOAP), and parses pain.002 status
 * reports. Designed to bypass manual wire submission by integrating directly
 * with a bank or open-banking provider.
 */

let pool;
let CashEngine;
try { pool = require('../bonds/pgPool'); } catch (e) { /* optional */ }
try { ({ CashEngine } = require('../cash/cashEngine')); } catch (e) { /* optional */ }

try { var { SystemSettings } = require('../ach/systemSettings'); } catch (e) { var SystemSettings = null; }

let lib;
try { lib = require('../utils/httpLib'); } catch (e) { /* optional */ }

function generateId(prefix = 'OBP') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

async function getSetting(name) {
  if (SystemSettings && typeof SystemSettings.get === 'function') {
    return SystemSettings.get(name);
  }
  return process.env[name] || null;
}

class ISO20022 {
  static documentId() {
    return `DOC-${Date.now()}`;
  }

  static generatePain001({ paymentId, amount, currency, debtorName, debtorAccount, debtorBic, creditorName, creditorAccount, creditorBic, remittance, requestedExecutionDate } = {}) {
    const docId = paymentId || this.documentId();
    const execDate = requestedExecutionDate ? new Date(requestedExecutionDate).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    const amt = (Number(amount) || 0).toFixed(2);
    return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${docId}</MsgId>
      <CreDtTm>${new Date().toISOString()}</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <CtrlSum>${amt}</CtrlSum>
      <InitgPty><Nm>${escapeXml(debtorName)}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${docId}-PI</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <BtchBookg>true</BtchBookg>
      <ReqdExctnDt>${execDate}</ReqdExctnDt>
      <Dbtr><Nm>${escapeXml(debtorName)}</Nm></Dbtr>
      <DbtrAcct><Id><Othr><Id>${escapeXml(debtorAccount)}</Id></Othr></Id></DbtrAcct>
      <DbtrAgt><FinInstnId>${debtorBic ? `<BICFI>${escapeXml(debtorBic)}</BICFI>` : ''}</FinInstnId></DbtrAgt>
      <CdtTrfTxInf>
        <PmtId><EndToEndId>${docId}</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="${currency || 'USD'}">${amt}</InstdAmt></Amt>
        <CdtrAgt><FinInstnId>${creditorBic ? `<BICFI>${escapeXml(creditorBic)}</BICFI>` : ''}</FinInstnId></CdtrAgt>
        <Cdtr><Nm>${escapeXml(creditorName)}</Nm></Cdtr>
        <CdtrAcct><Id><Othr><Id>${escapeXml(creditorAccount)}</Id></Othr></Id></CdtrAcct>
        <RmtInf><Ustrd>${escapeXml(remittance || 'Payment')}</Ustrd></RmtInf>
      </CdtTrfTxInf>
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>`;
  }

  static generatePain002({ originalMsgId, status, reason } = {}) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.002.001.10">
  <CstmrPmtStsRpt>
    <GrpHdr>
      <MsgId>${generateId('P2')}</MsgId>
      <CreDtTm>${new Date().toISOString()}</CreDtTm>
    </GrpHdr>
    <OrgnlGrpInfAndSts>
      <OrgnlMsgId>${originalMsgId}</OrgnlMsgId>
      <OrgnlMsgNmId>pain.001.001.09</OrgnlMsgNmId>
      <GrpSts>${status}</GrpSts>
    </OrgnlGrpInfAndSts>
    <TxInfAndSts>
      <Sts>${status}</Sts>
      ${reason ? `<StsRsnInf><AddtlInf>${escapeXml(reason)}</AddtlInf></StsRsnInf>` : ''}
    </TxInfAndSts>
  </CstmrPmtStsRpt>
</Document>`;
  }
}

function escapeXml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

class BaseConnector {
  constructor(name) { this.name = name; }
  async readiness() { return { ready: false, needs: [], message: 'Not configured' }; }
  async sendPayment(payment) { throw new Error('sendPayment not implemented'); }
  async verifyAccount(account) { throw new Error('verifyAccount not implemented'); }
}

class ColumnConnector extends BaseConnector {
  constructor() { super('column'); }
  async readiness() {
    const apiKey = await getSetting('COLUMN_API_KEY');
    return { ready: !!apiKey, needs: apiKey ? [] : ['COLUMN_API_KEY'], message: apiKey ? 'API key present' : 'COLUMN_API_KEY missing' };
  }
  async sendPayment(payment) {
    const apiKey = await getSetting('COLUMN_API_KEY');
    if (!apiKey) throw new Error('COLUMN_API_KEY not configured');
    const body = {
      amount: String(payment.amount_cents / 100),
      currency: payment.currency || 'USD',
      reference_number: payment.payment_id,
      receiving_account_number: payment.creditor_account,
      receiving_routing_number: payment.creditor_routing,
      receiving_account_name: payment.creditor_name,
      description: payment.description || payment.remittance,
    };
    if (!lib) throw new Error('HTTP library not available');
    const res = await lib.request({
      url: 'https://api.column.com/wire-transfers',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
    });
    return { raw: res, status: 'originated', external_id: (res && res.id) || null };
  }
  async verifyAccount({ routing, account }) {
    // Column does not expose public account verification; fall through to wiring only
    return { verified: false, message: 'Account verification not supported by Column connector' };
  }
}

class IncreaseConnector extends BaseConnector {
  constructor() { super('increase'); }
  async readiness() {
    const apiKey = await getSetting('INCREASE_API_KEY');
    return { ready: !!apiKey, needs: apiKey ? [] : ['INCREASE_API_KEY'], message: apiKey ? 'API key present' : 'INCREASE_API_KEY missing' };
  }
  async sendPayment(payment) {
    const apiKey = await getSetting('INCREASE_API_KEY');
    if (!apiKey) throw new Error('INCREASE_API_KEY not configured');
    const body = {
      amount: payment.amount_cents,
      currency: payment.currency || 'USD',
      account_number: payment.creditor_account,
      routing_number: payment.creditor_routing,
      beneficiary_name: payment.creditor_name,
      message_to_beneficiary: payment.description || payment.remittance,
    };
    if (!lib) throw new Error('HTTP library not available');
    const res = await lib.request({
      url: 'https://api.increase.com/wire_transfers',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
    });
    return { raw: res, status: 'originated', external_id: (res && res.id) || null };
  }
}

class PlaidConnector extends BaseConnector {
  constructor() { super('plaid'); }
  async readiness() {
    const clientId = await getSetting('PLAID_CLIENT_ID');
    const secret = await getSetting('PLAID_SECRET');
    const env = (await getSetting('PLAID_ENV')) || 'sandbox';
    return { ready: !!(clientId && secret), needs: clientId ? (secret ? [] : ['PLAID_SECRET']) : ['PLAID_CLIENT_ID','PLAID_SECRET'], message: `env: ${env}` };
  }
  async _post(path, body) {
    const clientId = await getSetting('PLAID_CLIENT_ID');
    const secret = await getSetting('PLAID_SECRET');
    const env = (await getSetting('PLAID_ENV')) || 'sandbox';
    const host = env === 'development' ? 'https://development.plaid.com' : env === 'production' ? 'https://production.plaid.com' : 'https://sandbox.plaid.com';
    if (!lib) throw new Error('HTTP library not available');
    return lib.request({ url: `${host}${path}`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { ...body, client_id: clientId, secret } });
  }
  async sendPayment(payment) {
    const accessToken = await getSetting('PLAID_ACCESS_TOKEN');
    if (!accessToken) throw new Error('PLAID_ACCESS_TOKEN not configured');
    const res = await this._post('/transfer/initiate', {
      access_token: accessToken,
      account_id: payment.creditor_account,
      type: 'credit',
      network: 'ach',
      amount: String(payment.amount_cents / 100),
      ach_class: 'ppd',
      user: { legal_name: payment.creditor_name },
      description: payment.description || payment.remittance,
    });
    return { raw: res, status: 'originated', external_id: (res && res.transfer && res.transfer.id) || null };
  }
  async verifyAccount({ accessToken, accountId }) {
    const res = await this._post('/auth/get', { access_token: accessToken });
    const numbers = (res && res.numbers && res.numbers.ach) || [];
    const match = numbers.find(n => n.account_id === accountId);
    return { verified: !!match, match: match || null };
  }
}

class GenericRestConnector extends BaseConnector {
  constructor() { super('generic_rest'); }
  async readiness() {
    const endpoint = await getSetting('OPENBANKING_ENDPOINT');
    const apiKey = await getSetting('OPENBANKING_API_KEY');
    return { ready: !!(endpoint && apiKey), needs: endpoint ? (apiKey ? [] : ['OPENBANKING_API_KEY']) : ['OPENBANKING_ENDPOINT','OPENBANKING_API_KEY'] };
  }
  async sendPayment(payment) {
    const endpoint = await getSetting('OPENBANKING_ENDPOINT');
    const apiKey = await getSetting('OPENBANKING_API_KEY');
    if (!endpoint || !apiKey) throw new Error('OPENBANKING_ENDPOINT and OPENBANKING_API_KEY required');
    const xml = ISO20022.generatePain001({
      paymentId: payment.payment_id,
      amount: payment.amount_cents / 100,
      currency: payment.currency,
      debtorName: payment.debtor_name,
      debtorAccount: payment.debtor_account,
      debtorBic: payment.debtor_bic,
      creditorName: payment.creditor_name,
      creditorAccount: payment.creditor_account,
      creditorBic: payment.creditor_bic,
      remittance: payment.remittance,
    });
    if (!lib) throw new Error('HTTP library not available');
    const res = await lib.request({
      url: endpoint,
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/xml' },
      body: xml,
    });
    return { raw: res, status: 'originated', external_id: (res && res.id) || null, iso20022_message: xml };
  }
}

const CONNECTORS = {
  column: ColumnConnector,
  increase: IncreaseConnector,
  plaid: PlaidConnector,
  generic_rest: GenericRestConnector,
};

class OpenBankingEngine {
  static async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS open_banking_payments (
        id SERIAL PRIMARY KEY,
        payment_id TEXT UNIQUE NOT NULL,
        connector TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','originated','confirmed','failed','cancelled')),
        source_cash_account_id TEXT,
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        debtor_name TEXT,
        debtor_account TEXT,
        debtor_bic TEXT,
        creditor_name TEXT,
        creditor_account TEXT,
        creditor_routing TEXT,
        creditor_bic TEXT,
        remittance TEXT,
        iso20022_message TEXT,
        raw_request JSONB,
        raw_response JSONB,
        external_id TEXT,
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ob_payments_payment_id ON open_banking_payments(payment_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ob_payments_status ON open_banking_payments(status)`);
  }

  static async getConnectors() {
    const list = [
      { id: 'column', name: 'Column (Wire)' },
      { id: 'increase', name: 'Increase (Wire/ACH)' },
      { id: 'plaid', name: 'Plaid Transfer (ACH)' },
      { id: 'generic_rest', name: 'Generic ISO 20022 REST/SOAP' },
    ];
    const out = [];
    for (const c of list) {
      const Ctor = CONNECTORS[c.id];
      const inst = new Ctor();
      const r = await inst.readiness();
      out.push({ ...c, ready: r.ready, needs: r.needs, message: r.message });
    }
    return out;
  }

  static _connector(name) {
    const Ctor = CONNECTORS[(name || '').toLowerCase()];
    if (!Ctor) throw new Error(`Unknown connector: ${name}`);
    return new Ctor();
  }

  static async _reserveCash(sourceCashAccountId, amountCents, reference) {
    if (!CashEngine) return { movement_id: null };
    if (!sourceCashAccountId) return { movement_id: null };
    const reserve = await CashEngine.getAccount('OPEN_BANKING_HOLD');
    if (!reserve) {
      try { await CashEngine.createAccount({ accountId: 'OPEN_BANKING_HOLD', accountName: 'Open Banking Hold', accountType: 'escrow', notes: 'Open Banking payout reserve' }); } catch (e) { /* may exist */ }
    }
    return CashEngine.transfer({
      fromAccountId: sourceCashAccountId,
      toAccountId: 'OPEN_BANKING_HOLD',
      amountCents,
      movementType: 'transfer',
      memo: `Open Banking reserve ${reference}`,
      referenceId: reference,
      referenceType: 'open_banking_payment',
    });
  }

  static async _releaseCashToSettled(amountCents, reference) {
    if (!CashEngine) return { movement_id: null };
    const settled = await CashEngine.getAccount('OPEN_BANKING_SETTLED');
    if (!settled) {
      try { await CashEngine.createAccount({ accountId: 'OPEN_BANKING_SETTLED', accountName: 'Open Banking Settled', accountType: 'escrow', notes: 'Open Banking confirmed payouts' }); } catch (e) { /* may exist */ }
    }
    return CashEngine.transfer({
      fromAccountId: 'OPEN_BANKING_HOLD',
      toAccountId: 'OPEN_BANKING_SETTLED',
      amountCents,
      movementType: 'transfer',
      memo: `Open Banking confirmed ${reference}`,
      referenceId: reference,
      referenceType: 'open_banking_payment',
    });
  }

  static async _refundCash(sourceCashAccountId, amountCents, reference) {
    if (!CashEngine) return { movement_id: null };
    return CashEngine.transfer({
      fromAccountId: 'OPEN_BANKING_HOLD',
      toAccountId: sourceCashAccountId,
      amountCents,
      movementType: 'transfer',
      memo: `Open Banking refund ${reference}`,
      referenceId: reference,
      referenceType: 'open_banking_payment',
    });
  }

  static async createPayment(opts = {}) {
    if (!pool) throw new Error('Database not available');
    const {
      connector, sourceCashAccountId, amount, currency = 'USD',
      debtorName, debtorAccount, debtorBic,
      creditorName, creditorAccount, creditorRouting, creditorBic,
      remittance, description,
    } = opts;
    const amountCents = toCents(amount);
    if (amountCents <= 0) throw new Error('amount must be positive');
    if (!connector) throw new Error('connector is required');
    if (!creditorName || !creditorAccount) throw new Error('creditorName and creditorAccount are required');
    if (!creditorRouting) throw new Error('creditorRouting is required for US payouts');
    if (CashEngine && sourceCashAccountId) {
      const acct = await CashEngine.getAccount(sourceCashAccountId);
      if (!acct) throw new Error(`Source account not found: ${sourceCashAccountId}`);
      if (parseInt(acct.balance_cents || 0, 10) < amountCents) throw new Error(`Insufficient balance in ${sourceCashAccountId}`);
    }
    const paymentId = generateId('OBP');
    const isoMessage = ISO20022.generatePain001({
      paymentId,
      amount: amountCents / 100,
      currency,
      debtorName: debtorName || 'DLB Trust',
      debtorAccount: debtorAccount,
      debtorBic: debtorBic,
      creditorName,
      creditorAccount,
      creditorBic,
      remittance: remittance || description || `Open banking payout ${paymentId}`,
    });
    const conn = this._connector(connector);
    const ready = await conn.readiness();
    if (!ready.ready) {
      await pool.query(
        `INSERT INTO open_banking_payments (payment_id, connector, status, source_cash_account_id, amount_cents, currency, debtor_name, debtor_account, debtor_bic, creditor_name, creditor_account, creditor_routing, creditor_bic, remittance, iso20022_message, error_message)
         VALUES ($1,$2,'failed',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [paymentId, connector, sourceCashAccountId, amountCents, currency, debtorName || null, debtorAccount || null, debtorBic || null, creditorName, creditorAccount, creditorRouting || null, creditorBic || null, remittance || description || null, isoMessage, `Connector not ready: ${JSON.stringify(ready.needs)}`]
      );
      return { paymentId, status: 'failed', needs: ready.needs };
    }

    let reserveMovement = null;
    if (CashEngine && sourceCashAccountId) {
      reserveMovement = await this._reserveCash(sourceCashAccountId, amountCents, paymentId);
    }

    let result;
    let status = 'pending';
    let error = null;
    let externalId = null;
    try {
      result = await conn.sendPayment({
        payment_id: paymentId,
        amount_cents: amountCents,
        currency,
        debtor_name: debtorName,
        debtor_account: debtorAccount,
        debtor_bic: debtorBic,
        creditor_name: creditorName,
        creditor_account: creditorAccount,
        creditor_routing: creditorRouting,
        creditor_bic: creditorBic,
        remittance: remittance || description,
        description,
      });
      status = result.status || 'originated';
      externalId = result.external_id || null;
      if (status === 'originated' && CashEngine) {
        await this._releaseCashToSettled(amountCents, paymentId);
      }
    } catch (err) {
      error = err.message;
      status = 'failed';
      if (CashEngine && reserveMovement) {
        try { await this._refundCash(sourceCashAccountId, amountCents, paymentId); } catch (e) { /* best effort */ }
      }
    }

    await pool.query(
      `INSERT INTO open_banking_payments (payment_id, connector, status, source_cash_account_id, amount_cents, currency, debtor_name, debtor_account, debtor_bic, creditor_name, creditor_account, creditor_routing, creditor_bic, remittance, iso20022_message, raw_request, raw_response, external_id, error_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [paymentId, connector, status, sourceCashAccountId || null, amountCents, currency, debtorName || null, debtorAccount || null, debtorBic || null, creditorName, creditorAccount, creditorRouting || null, creditorBic || null, remittance || description || null, isoMessage, JSON.stringify({ connector, sourceCashAccountId, amountCents }), JSON.stringify(result || null), externalId, error]
    );

    return { paymentId, status, externalId, error, iso20022_message: isoMessage };
  }

  static async getPayment(paymentId) {
    if (!pool) throw new Error('Database not available');
    const result = await pool.query('SELECT * FROM open_banking_payments WHERE payment_id = $1', [paymentId]);
    return result.rows[0] || null;
  }

  static async listPayments({ limit = 50, status } = {}) {
    if (!pool) throw new Error('Database not available');
    let sql = 'SELECT * FROM open_banking_payments';
    const params = [];
    if (status) { sql += ' WHERE status = $1'; params.push(status); }
    sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);
    const result = await pool.query(sql, params);
    return result.rows;
  }

  static async cancelPayment(paymentId) {
    if (!pool) throw new Error('Database not available');
    const row = await this.getPayment(paymentId);
    if (!row) throw new Error('Payment not found');
    if (row.status !== 'pending') throw new Error(`Cannot cancel payment in ${row.status} status`);
    if (CashEngine && row.source_cash_account_id) {
      await this._refundCash(row.source_cash_account_id, row.amount_cents, paymentId);
    }
    await pool.query(`UPDATE open_banking_payments SET status = 'cancelled', updated_at = NOW() WHERE payment_id = $1`, [paymentId]);
    return this.getPayment(paymentId);
  }

  static async verifyAccount({ connector, accessToken, accountId, routing, account }) {
    const conn = this._connector(connector);
    return conn.verifyAccount({ accessToken, accountId, routing, account });
  }

  static async getSummary() {
    if (!pool) return { count: 0, totalCents: 0 };
    const result = await pool.query('SELECT COUNT(*) AS cnt, COALESCE(SUM(amount_cents),0) AS total FROM open_banking_payments');
    return { count: parseInt(result.rows[0].cnt, 10), totalCents: parseInt(result.rows[0].total, 10) };
  }
}

module.exports = { OpenBankingEngine, ISO20022 };
