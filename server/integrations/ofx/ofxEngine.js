'use strict';

/**
 * OFX Clearing Engine — parse bank statements and originate OFX payments.
 *
 * Supports OFX 2.0 XML and SGML-style 1.x statement imports (via the `ofx`
 * parser), and builds OFX 2.0 request messages for bill pay, wire, and bank
 * transfers.  Real bank submission requires an institution with baseUrl,
 * username/password, and FI org/fid.
 */

const ofx = require('ofx');
const { v4: uuidv4 } = require('uuid');

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const memory = {
  institutions: new Map(),
  statements: new Map(),
  transactions: new Map(),
  payments: new Map(),
};

let seqId = 0;

let initPromise;

async function dbQuery(text, params) {
  if (initPromise) await initPromise;
  if (pool && pool.query) return pool.query(text, params);
  throw new Error('Postgres pool unavailable');
}

async function ensureTables() {
  if (!pool || !pool.query) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ofx_institutions (
        id              SERIAL PRIMARY KEY,
        name            TEXT NOT NULL,
        org             TEXT,
        fid             TEXT,
        base_url        TEXT,
        ofx_version     TEXT DEFAULT '200',
        username        TEXT,
        password        TEXT,
        bank_id         TEXT,
        account_id      TEXT,
        account_type    TEXT DEFAULT 'CHECKING',
        routing_number  TEXT,
        status          TEXT DEFAULT 'active' CHECK (status IN ('active','paused')),
        mode            TEXT DEFAULT 'simulate' CHECK (mode IN ('simulate','live')),
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS ofx_statements (
        id                  SERIAL PRIMARY KEY,
        institution_id      INTEGER REFERENCES ofx_institutions(id),
        account_id          TEXT,
        currency            TEXT,
        start_date          DATE,
        end_date            DATE,
        ledger_balance_cents BIGINT,
        ledger_balance_date DATE,
        raw_content         TEXT,
        parsed_at           TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS ofx_transactions (
        id              SERIAL PRIMARY KEY,
        statement_id    INTEGER REFERENCES ofx_statements(id),
        fit_id          TEXT,
        posted_at       DATE,
        type            TEXT,
        amount_cents    BIGINT,
        name            TEXT,
        memo            TEXT,
        check_number    TEXT,
        ref_num         TEXT,
        reference       TEXT,
        reconciled      BOOLEAN DEFAULT FALSE,
        UNIQUE(statement_id, fit_id)
      );
      CREATE TABLE IF NOT EXISTS ofx_payments (
        id              SERIAL PRIMARY KEY,
        institution_id  INTEGER REFERENCES ofx_institutions(id),
        payment_type    TEXT NOT NULL CHECK (payment_type IN ('billpay','wire','intrabank','interbank','ach')),
        reference       TEXT UNIQUE NOT NULL,
        amount_cents    BIGINT NOT NULL,
        currency        TEXT DEFAULT 'USD',
        source_account_id TEXT,
        source_type     TEXT,
        payee_name      TEXT,
        payee_account   TEXT,
        payee_bank_id   TEXT,
        payee_routing   TEXT,
        payee_address1  TEXT,
        payee_address2  TEXT,
        payee_city      TEXT,
        payee_state     TEXT,
        payee_postal    TEXT,
        payee_country   TEXT DEFAULT 'USA',
        due_date        DATE,
        memo            TEXT,
        ofx_request     TEXT,
        ofx_response    TEXT,
        server_id       TEXT,
        status          TEXT DEFAULT 'pending' CHECK (status IN ('pending','submitted','accepted','rejected','cleared','cancelled')),
        status_detail   TEXT,
        submitted_at    TIMESTAMPTZ,
        completed_at    TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE ofx_payments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
    `);
  } catch (e) {
    console.warn('[OFX] ensure tables warning:', e.message);
  }
}
initPromise = ensureTables();

function useMemory() {
  return !pool || process.env.OFX_USE_MEMORY === 'true';
}

const MAX_OFX_CONTENT_SIZE = Number(process.env.OFX_MAX_CONTENT_SIZE) || 10 * 1024 * 1024; // 10 MB
const ALLOWED_OFX_SCHEMES = ['https:'];

function getOfxUrlAllowlist() {
  const env = process.env.OFX_BASE_URL_ALLOWLIST;
  if (!env) return [];
  return env.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

function isPrivateHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1\d\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/:/.test(h) && (/^::$|^::1$|^fc|^fd|^fe80:|^ff/.test(h) || /^2001:db8:/i.test(h) || /^::/.test(h))) return true;
  return false;
}

function validateOfxBaseUrl(url) {
  if (!url) throw new Error('OFX baseUrl is required for live mode');
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw new Error('OFX baseUrl is not a valid URL');
  }
  if (!ALLOWED_OFX_SCHEMES.includes(parsed.protocol)) {
    throw new Error('OFX baseUrl must use HTTPS');
  }
  const allowlist = getOfxUrlAllowlist();
  const host = parsed.hostname.toLowerCase();
  if (allowlist.length && !allowlist.includes(host)) {
    throw new Error('OFX baseUrl host is not in allowlist');
  }
  if (!allowlist.length && isPrivateHost(host)) {
    throw new Error('OFX baseUrl host resolves to a private or local address');
  }
}

function sanitizeOfxContent(content) {
  if (!content) return content;
  if (typeof content !== 'string') throw new Error('OFX content must be a string');
  if (content.length > MAX_OFX_CONTENT_SIZE) throw new Error('OFX content exceeds maximum size');
  const sanitized = content
    .replace(/<!DOCTYPE\s+[^>]*(?:>|$)[\s\S]*?>/gi, '')
    .replace(/<!ENTITY\s+[^>]*(?:>|$)[\s\S]*?>/gi, '')
    .replace(/<!DOCTYPE\s[^[>]*\[[\s\S]*?\]\s*>/gi, '')
    .replace(/<!ENTITY\s+%?\s+[^\s]+\s+SYSTEM\s+[^>]+>/gi, '');
  if (/<!DOCTYPE/i.test(sanitized) || /<!ENTITY/i.test(sanitized)) {
    throw new Error('OFX content contains disallowed DTD/ENTITY declarations');
  }
  return sanitized;
}

function makeRef(prefix) {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}`.toUpperCase();
}

function amountToCents(trnamt) {
  if (trnamt == null) return 0;
  const n = Number(String(trnamt).replace(/,/g, ''));
  return Math.round(n * 100);
}

function amountFromCents(cents) {
  return (Number(cents) / 100).toFixed(2);
}

function xmlEscape(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toXml(value, indent) {
  const pad = '  '.repeat(indent || 0);
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map((v) => toXml(v, indent)).join('');
  }
  if (typeof value === 'object') {
    let out = '';
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      if (v == null || typeof v !== 'object') {
        out += `${pad}<${k}>${xmlEscape(v)}</${k}>\n`;
      } else if (Array.isArray(v)) {
        out += toXml(v, indent);
      } else {
        const child = toXml(v, (indent || 0) + 1);
        out += `${pad}<${k}>\n${child}${pad}</${k}>\n`;
      }
    }
    return out;
  }
  return `${pad}${xmlEscape(value)}\n`;
}

function buildEnvelope(header, body) {
  const h = header || {};
  const version = String(h.VERSION || '200');
  const newFileUid = h.NEWFILEUID || uuidv4();
  const oldFileUid = h.OLDFILEUID || 'NONE';
  const security = h.SECURITY || 'NONE';
  const encoding = h.ENCODING || 'UTF-8';

  if (version >= '200') {
    return `<?xml version="1.0" encoding="${encoding}"?>\n<?OFX OFXHEADER="${h.OFXHEADER || '200'}" VERSION="${version}" SECURITY="${security}" OLDFILEUID="${oldFileUid}" NEWFILEUID="${newFileUid}" ?>\n${toXml({ OFX: body })}\n`;
  }

  const ofxHeader = `OFXHEADER:${h.OFXHEADER || '100'}\nDATA:${h.DATA || 'OFXSGML'}\nVERSION:${version}\nSECURITY:${security}\nENCODING:${encoding}\nCHARSET:${h.CHARSET || '1252'}\nCOMPRESSION:${h.COMPRESSION || 'NONE'}\nOLDFILEUID:${oldFileUid}\nNEWFILEUID:${newFileUid}\n`;
  return `${ofxHeader}\n${toXml({ OFX: body })}\n`;
}

function dateTimeOFX(d) {
  const dt = d ? new Date(d) : new Date();
  return dt.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function dateOFX(d) {
  const dt = d ? new Date(d) : new Date();
  return dt.toISOString().slice(0, 10).replace(/-/g, '');
}

function makeBankAccount(inst, accountTypeOverride) {
  return {
    BANKID: inst.bankId || inst.bank_id,
    ACCTID: inst.accountId || inst.account_id,
    ACCTTYPE: accountTypeOverride || inst.accountType || inst.account_type || 'CHECKING',
  };
}

function makePayee(payment) {
  return {
    NAME: payment.payee_name,
    ADDR1: payment.payee_address1 || 'N/A',
    ADDR2: payment.payee_address2 || '',
    CITY: payment.payee_city || 'N/A',
    STATE: payment.payee_state || 'NA',
    POSTALCODE: payment.payee_postal || '00000',
    COUNTRY: payment.payee_country || 'USA',
    PHONE: '0000000000',
  };
}

function makeBankAccountTo(payment) {
  return {
    BANKID: payment.payee_bank_id || payment.payee_routing,
    ACCTID: payment.payee_account,
    ACCTTYPE: 'CHECKING',
  };
}

function buildSignOn(inst) {
  return {
    SIGNONMSGSRQV1: {
      SONRQ: {
        DTCLIENT: dateTimeOFX(),
        USERID: inst.username || 'user',
        USERPASS: inst.password || 'password',
        LANGUAGE: 'ENG',
        FI: { ORG: inst.org || 'DLB', FID: inst.fid || 'DLB' },
        APPID: 'QWIN',
        APPVER: '2600',
      },
    },
  };
}

function buildPaymentMessageSet(inst, payment) {
  const ref = payment.reference;
  const commonXfer = {
    BANKACCTFROM: makeBankAccount(inst),
    BANKACCTTO: makeBankAccountTo(payment),
    TRNAMT: amountFromCents(payment.amount_cents),
    DTDUE: dateOFX(payment.due_date || new Date()),
  };

  if (payment.payment_type === 'intrabank') {
    return {
      INTRAXFERMSGSRQV1: {
        INTRATRNRQ: { TRNUID: ref, INTRARQ: { XFERINFO: commonXfer } },
      },
    };
  }

  if (payment.payment_type === 'interbank' || payment.payment_type === 'ach') {
    return {
      INTERXFERMSGSRQV1: {
        INTERTRNRQ: { TRNUID: ref, INTERRQ: { XFERINFO: commonXfer } },
      },
    };
  }

  if (payment.payment_type === 'wire') {
    return {
      WIREXFERMSGSRQV1: {
        WIRETRNRQ: {
          TRNUID: ref,
          WIRERQ: {
            BANKACCTFROM: makeBankAccount(inst),
            WIREBENEFICIARY: {
              NAME: payment.payee_name,
              BANKACCTTO: makeBankAccountTo(payment),
              MEMO: payment.memo || 'Trust distribution',
            },
            WIREDESTBANK: {
              EXTBANKDESC: {
                NAME: payment.payee_name + ' Bank',
                BANKID: payment.payee_bank_id || payment.payee_routing,
                ADDR1: payment.payee_address1 || 'N/A',
                CITY: payment.payee_city || 'N/A',
                STATE: payment.payee_state || 'NA',
                POSTALCODE: payment.payee_postal || '00000',
                COUNTRY: payment.payee_country || 'USA',
              },
            },
            TRNAMT: amountFromCents(payment.amount_cents),
            DTDUE: dateOFX(payment.due_date || new Date()),
            PAYINSTRUCT: payment.memo || 'Trust distribution',
          },
        },
      },
    };
  }

  // billpay
  const payee = makePayee(payment);
  return {
    BILLPAYMSGSRQV1: {
      PMTTRNRQ: {
        TRNUID: ref,
        PMTRQ: {
          PMTINFO: {
            BANKACCTFROM: makeBankAccount(inst),
            TRNAMT: amountFromCents(payment.amount_cents),
            PAYEEID: '0',
            PAYEE: payee,
            PAYACCT: payment.payee_account,
            DTDUE: dateOFX(payment.due_date || new Date()),
            MEMO: payment.memo || 'Trust distribution',
          },
        },
      },
    },
  };
}

function buildPaymentRequest(inst, payment) {
  const body = {
    ...buildSignOn(inst),
    ...buildPaymentMessageSet(inst, payment),
  };
  return buildEnvelope({
    OFXHEADER: '200',
    DATA: 'OFXSGML',
    VERSION: inst.ofxVersion || inst.ofx_version || '200',
    SECURITY: 'NONE',
    ENCODING: 'UTF-8',
    CHARSET: 'NONE',
    COMPRESSION: 'NONE',
    OLDFILEUID: 'NONE',
    NEWFILEUID: uuidv4(),
  }, body);
}

function coerceArray(val) {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}

function extractStatement(parsed) {
  let root = parsed;
  if (root && root.OFX) root = root.OFX;

  const bank = root && (root.BANKMSGSRSV1 || root.BANKMSGSRSV2);
  const cc = root && (root.CREDITCARDMSGSRSV1 || root.CREDITCARDMSGSRSV2);

  let stmt = null;
  let account = null;
  let type = 'bank';

  if (bank && bank.STMTTRNRS) {
    stmt = bank.STMTTRNRS.STMTRS;
    account = stmt.BANKACCTFROM;
    type = 'bank';
  } else if (cc && cc.CCSTMTTRNRS) {
    stmt = cc.CCSTMTTRNRS.CCSTMTTRS;
    account = stmt.CCACCTFROM;
    type = 'credit_card';
  }

  if (!stmt) throw new Error('No statement response found in OFX file');

  const txnList = stmt.BANKTRANLIST || {};
  const rawTxns = coerceArray(txnList.STMTTRN);
  const transactions = rawTxns.map((t) => ({
    fitId: t.FITID,
    postedAt: t.DTPOSTED ? String(t.DTPOSTED).slice(0, 8) : null,
    type: t.TRNTYPE,
    amountCents: amountToCents(t.TRNAMT),
    name: t.NAME,
    memo: t.MEMO,
    checkNumber: t.CHECKNUM,
    refNum: t.REFNUM,
  }));

  const bal = stmt.LEDGERBAL || {};
  return {
    type,
    account: account || {},
    currency: stmt.CURDEF || 'USD',
    startDate: txnList.DTSTART ? String(txnList.DTSTART).slice(0, 8) : null,
    endDate: txnList.DTEND ? String(txnList.DTEND).slice(0, 8) : null,
    ledgerBalanceCents: amountToCents(bal.BALAMT),
    ledgerBalanceDate: bal.DTASOF ? String(bal.DTASOF).slice(0, 8) : null,
    transactions,
  };
}

function parseStatement(fileContent) {
  if (!fileContent || typeof fileContent !== 'string') throw new Error('OFX content required');
  const safeContent = sanitizeOfxContent(fileContent);
  try {
    const parsed = ofx.parse(safeContent);
    return extractStatement(parsed);
  } catch (e) {
    throw new Error('Failed to parse OFX file: ' + e.message);
  }
}

function rowToInstitution(r) {
  return {
    id: r.id,
    name: r.name,
    org: r.org,
    fid: r.fid,
    baseUrl: r.base_url,
    ofxVersion: r.ofx_version,
    username: r.username,
    password: r.password,
    bankId: r.bank_id,
    accountId: r.account_id,
    accountType: r.account_type,
    routingNumber: r.routing_number,
    status: r.status,
    mode: r.mode,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toPublicInstitution(inst) {
  if (!inst) return inst;
  const out = { ...inst };
  if (out.password) {
    out.hasPassword = true;
    delete out.password;
  } else {
    out.hasPassword = false;
  }
  return out;
}

async function listInstitutions() {
  if (useMemory()) return [...memory.institutions.values()].filter((i) => i.status !== 'deleted').map(toPublicInstitution);
  const res = await dbQuery('SELECT * FROM ofx_institutions WHERE status != $1 ORDER BY created_at DESC', ['deleted']);
  return res.rows.map((r) => toPublicInstitution(rowToInstitution(r)));
}

async function getInstitution(id) {
  if (useMemory()) {
    const inst = memory.institutions.get(String(id));
    return inst ? toPublicInstitution(inst) : null;
  }
  const res = await dbQuery('SELECT * FROM ofx_institutions WHERE id = $1', [id]);
  return res.rows[0] ? toPublicInstitution(rowToInstitution(res.rows[0])) : null;
}

async function getInstitutionWithSecrets(id) {
  if (useMemory()) return memory.institutions.get(String(id));
  const res = await dbQuery('SELECT * FROM ofx_institutions WHERE id = $1', [id]);
  return res.rows[0] ? rowToInstitution(res.rows[0]) : null;
}

async function saveInstitution(data) {
  const payload = {
    name: data.name,
    org: data.org,
    fid: data.fid,
    base_url: data.baseUrl,
    ofx_version: data.ofxVersion || '200',
    username: data.username,
    password: data.password,
    bank_id: data.bankId,
    account_id: data.accountId,
    account_type: data.accountType || 'CHECKING',
    routing_number: data.routingNumber,
    status: data.status || 'active',
    mode: data.mode || 'simulate',
  };
  if (payload.mode === 'live') validateOfxBaseUrl(payload.base_url);
  if (useMemory()) {
    const id = data.id || ++seqId;
    const inst = { ...payload, id, created_at: new Date(), updated_at: new Date() };
    memory.institutions.set(String(id), rowToInstitution(inst));
    return toPublicInstitution(rowToInstitution(inst));
  }
  if (data.id) {
    const res = await dbQuery(`
      UPDATE ofx_institutions SET name=$1, org=$2, fid=$3, base_url=$4, ofx_version=$5,
      username=$6, password=$7, bank_id=$8, account_id=$9, account_type=$10,
      routing_number=$11, status=$12, mode=$13, updated_at=NOW() WHERE id=$14 RETURNING *
    `, [payload.name, payload.org, payload.fid, payload.base_url, payload.ofx_version,
        payload.username, payload.password, payload.bank_id, payload.account_id,
        payload.account_type, payload.routing_number, payload.status, payload.mode, data.id]);
    return res.rows[0] ? toPublicInstitution(rowToInstitution(res.rows[0])) : null;
  }
  const res = await dbQuery(`
    INSERT INTO ofx_institutions (name, org, fid, base_url, ofx_version, username, password,
    bank_id, account_id, account_type, routing_number, status, mode)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *
  `, [payload.name, payload.org, payload.fid, payload.base_url, payload.ofx_version,
      payload.username, payload.password, payload.bank_id, payload.account_id,
      payload.account_type, payload.routing_number, payload.status, payload.mode]);
  return toPublicInstitution(rowToInstitution(res.rows[0]));
}

async function deleteInstitution(id) {
  if (useMemory()) { memory.institutions.delete(String(id)); return { deleted: true }; }
  await dbQuery('DELETE FROM ofx_institutions WHERE id = $1', [id]);
  return { deleted: true };
}

async function importStatement({ institutionId, fileContent, rawStore = true }) {
  const safeContent = sanitizeOfxContent(fileContent);
  const parsed = parseStatement(safeContent);
  const accountId = parsed.account && (parsed.account.ACCTID || parsed.account.ACCTID);

  if (useMemory()) {
    const sid = ++seqId;
    const stmt = {
      id: sid,
      institution_id: institutionId,
      account_id: accountId,
      currency: parsed.currency,
      start_date: parsed.startDate,
      end_date: parsed.endDate,
      ledger_balance_cents: parsed.ledgerBalanceCents,
      ledger_balance_date: parsed.ledgerBalanceDate,
      raw_content: rawStore ? safeContent : null,
    };
    memory.statements.set(String(sid), stmt);
    for (const t of parsed.transactions) {
      const tid = ++seqId;
      memory.transactions.set(String(tid), { statement_id: sid, ...t });
    }
    return { statementId: sid, parsed };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stmtRes = await client.query(`
      INSERT INTO ofx_statements (institution_id, account_id, currency, start_date, end_date,
      ledger_balance_cents, ledger_balance_date, raw_content)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [institutionId || null, accountId, parsed.currency, parsed.startDate, parsed.endDate,
        parsed.ledgerBalanceCents, parsed.ledgerBalanceDate, rawStore ? safeContent : null]);
    const statementId = stmtRes.rows[0].id;
    for (const t of parsed.transactions) {
      await client.query(`
        INSERT INTO ofx_transactions (statement_id, fit_id, posted_at, type, amount_cents,
        name, memo, check_number, ref_num, reference)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (statement_id, fit_id) DO NOTHING
      `, [statementId, t.fitId, t.postedAt, t.type, t.amountCents, t.name, t.memo,
          t.checkNumber, t.refNum, t.fitId || t.refNum]);
    }
    await client.query('COMMIT');
    return { statementId, parsed };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function listStatements(institutionId) {
  if (useMemory()) {
    const out = [...memory.statements.values()];
    return institutionId ? out.filter((s) => String(s.institution_id) === String(institutionId)) : out;
  }
  let sql = 'SELECT * FROM ofx_statements';
  const params = [];
  if (institutionId) { sql += ' WHERE institution_id = $1'; params.push(institutionId); }
  sql += ' ORDER BY parsed_at DESC';
  const res = await dbQuery(sql, params);
  return res.rows;
}

async function listTransactions(statementId) {
  if (useMemory()) return [...memory.transactions.values()].filter((t) => String(t.statement_id) === String(statementId));
  const res = await dbQuery('SELECT * FROM ofx_transactions WHERE statement_id = $1 ORDER BY posted_at DESC', [statementId]);
  return res.rows;
}

async function createPayment(data) {
  const amountCents = data.amountCents || Math.round(parseFloat(data.amount || 0) * 100);
  if (!amountCents || amountCents <= 0) throw new Error('amount or amountCents required');
  if (!data.paymentType || !['billpay','wire','intrabank','interbank','ach'].includes(data.paymentType)) {
    throw new Error('paymentType must be one of billpay, wire, intrabank, interbank, ach');
  }
  if (!data.institutionId && !data.institution) throw new Error('institutionId required');
  const institutionId = data.institutionId || data.institution;
  const reference = data.reference || makeRef('OFXPAY');

  const payload = {
    institution_id: institutionId,
    payment_type: data.paymentType,
    reference,
    amount_cents: amountCents,
    currency: data.currency || 'USD',
    source_account_id: data.sourceAccountId,
    source_type: data.sourceType,
    payee_name: data.payeeName,
    payee_account: data.payeeAccount,
    payee_bank_id: data.payeeBankId,
    payee_routing: data.payeeRouting,
    payee_address1: data.payeeAddress1,
    payee_address2: data.payeeAddress2,
    payee_city: data.payeeCity,
    payee_state: data.payeeState,
    payee_postal: data.payeePostal,
    payee_country: data.payeeCountry || 'USA',
    due_date: data.dueDate,
    memo: data.memo,
  };

  if (useMemory()) {
    const id = ++seqId;
    const pay = { id, ...payload, status: 'pending', created_at: new Date() };
    memory.payments.set(String(id), pay);
    return pay;
  }

  const res = await dbQuery(`
    INSERT INTO ofx_payments (institution_id, payment_type, reference, amount_cents, currency,
    source_account_id, source_type, payee_name, payee_account, payee_bank_id, payee_routing,
    payee_address1, payee_address2, payee_city, payee_state, payee_postal, payee_country,
    due_date, memo, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'pending') RETURNING *
  `, [payload.institution_id, payload.payment_type, payload.reference, payload.amount_cents,
      payload.currency, payload.source_account_id, payload.source_type, payload.payee_name,
      payload.payee_account, payload.payee_bank_id, payload.payee_routing, payload.payee_address1,
      payload.payee_address2, payload.payee_city, payload.payee_state, payload.payee_postal,
      payload.payee_country, payload.due_date, payload.memo]);
  return res.rows[0];
}

async function getPayment(id) {
  if (useMemory()) return memory.payments.get(String(id));
  const res = await dbQuery('SELECT * FROM ofx_payments WHERE id = $1', [id]);
  return res.rows[0];
}

async function listPayments({ limit = 50, offset = 0 } = {}) {
  if (useMemory()) return [...memory.payments.values()].reverse().slice(offset, offset + limit);
  const res = await dbQuery('SELECT * FROM ofx_payments ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset]);
  return res.rows;
}

async function updatePaymentStatus(id, { status, serverId, ofxRequest, ofxResponse, statusDetail, completedAt, submittedAt }) {
  const fields = ['updated_at=NOW()'];
  const params = [];
  let idx = 1;
  if (status) { fields.push(`status=$${idx++}`); params.push(status); }
  if (serverId) { fields.push(`server_id=$${idx++}`); params.push(serverId); }
  if (ofxRequest) { fields.push(`ofx_request=$${idx++}`); params.push(ofxRequest); }
  if (ofxResponse) { fields.push(`ofx_response=$${idx++}`); params.push(ofxResponse); }
  if (statusDetail) { fields.push(`status_detail=$${idx++}`); params.push(statusDetail); }
  if (completedAt) { fields.push(`completed_at=$${idx++}`); params.push(completedAt); }
  if (submittedAt) { fields.push(`submitted_at=$${idx++}`); params.push(submittedAt); }

  if (useMemory()) {
    const pay = memory.payments.get(String(id));
    if (!pay) throw new Error('payment not found');
    if (status) pay.status = status;
    if (serverId) pay.server_id = serverId;
    if (ofxRequest) pay.ofx_request = ofxRequest;
    if (ofxResponse) pay.ofx_response = ofxResponse;
    if (statusDetail) pay.status_detail = statusDetail;
    if (completedAt) pay.completed_at = completedAt;
    if (submittedAt) pay.submitted_at = submittedAt;
    return pay;
  }

  params.push(id);
  await dbQuery(`UPDATE ofx_payments SET ${fields.join(',')} WHERE id=$${idx}`, params);
  return getPayment(id);
}

async function submitPayment(id) {
  const payment = await getPayment(id);
  if (!payment) throw new Error('payment not found');
  if (payment.status !== 'pending') throw new Error(`payment status is ${payment.status}`);

  const institution = await getInstitutionWithSecrets(payment.institution_id);
  if (!institution) throw new Error('institution not found');
  if (institution.status !== 'active') throw new Error('institution is not active');

  const requestXml = buildPaymentRequest(institution, payment);
  payment.ofx_request = requestXml;

  if (institution.mode === 'simulate' || !institution.baseUrl) {
    await updatePaymentStatus(id, {
      status: 'accepted',
      serverId: 'SIM-' + uuidv4().split('-')[0].toUpperCase(),
      ofxRequest: requestXml,
      ofxResponse: '<OFX><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS></OFX>',
      statusDetail: 'Simulated acceptance; no network call made',
      completedAt: new Date(),
      submittedAt: new Date(),
    });
    return getPayment(id);
  }

  // Live submission
  validateOfxBaseUrl(institution.baseUrl);
  const url = institution.baseUrl.replace(/\/$/, '') + '/ofx/' + (institution.ofxVersion || '200');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: requestXml,
    });
    const text = await res.text();
    let status = res.ok ? 'submitted' : 'rejected';
    let serverId = null;
    let detail = `HTTP ${res.status}`;
    try {
      const parsed = ofx.parse(text);
      const ok = parsed && parsed.OFX && (parsed.OFX.SIGNONMSGSRSV1 || {}).SONRS;
      detail += ok ? ' — signon received' : ' — no signon in response';
    } catch (e) { /* ignore parse errors */ }

    await updatePaymentStatus(id, {
      status,
      serverId: serverId || `HTTP-${res.status}`,
      ofxRequest: requestXml,
      ofxResponse: text,
      statusDetail: detail,
      completedAt: new Date(),
      submittedAt: new Date(),
    });
    return getPayment(id);
  } catch (e) {
    await updatePaymentStatus(id, { status: 'rejected', statusDetail: e.message, completedAt: new Date() });
    throw e;
  }
}

async function cancelPayment(id) {
  const payment = await getPayment(id);
  if (!payment) throw new Error('payment not found');
  if (!['pending','submitted'].includes(payment.status)) throw new Error('cannot cancel payment in status ' + payment.status);
  await updatePaymentStatus(id, { status: 'cancelled', completedAt: new Date() });
  return getPayment(id);
}

async function readiness() {
  const institutions = await listInstitutions();
  const active = institutions.filter((i) => i.status === 'active');
  const issues = [];
  if (!pool) issues.push('Postgres pool unavailable');
  if (!active.length) issues.push('No active OFX institutions configured');
  return { ready: issues.length === 0, mode: active.some((i) => i.mode === 'live') ? 'live-ready' : 'simulate-only', issues, institutionCount: institutions.length };
}

module.exports = {
  parseStatement,
  importStatement,
  listStatements,
  listTransactions,
  listInstitutions,
  getInstitution,
  saveInstitution,
  deleteInstitution,
  createPayment,
  getPayment,
  listPayments,
  submitPayment,
  cancelPayment,
  buildPaymentRequest,
  readiness,
};
