'use strict';

/**
 * Barcode Deposit Engine
 *
 * Accepts a scanned barcode/QR string, parses common payment/deposit formats
 * (URLs, SEPA/EPC QR, bank-account text, Cash App / Skrill / Venmo links),
 * stores a record, and optionally credits a trust cash account when the
 * operator confirms the funds have been received.
 *
 * No public API is required; the scanner is the input device.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { /* optional */ }

const TABLE = 'barcode_deposits';

function generateId(prefix = 'BCD') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

function parseUrlValue(rawValue) {
  try {
    const url = new URL(rawValue.trim());
    const pathParts = url.pathname.replace(/^\/+/, '').split('/');
    const out = { type: 'url', host: url.hostname, path: url.pathname, params: {} };
    url.searchParams.forEach((v, k) => { out.params[k] = v; });

    // Cash App / Cash.me: /$cashtag[/amount]
    if (url.hostname === 'cash.app' || url.hostname === 'cash.me') {
      out.scheme = 'cashapp';
      const match = pathParts[0] && pathParts[0].match(/^\$?([A-Za-z0-9_]+)$/);
      out.cashtag = match ? (match[1] ? '$' + match[1] : pathParts[0]) : pathParts[0];
      out.amount = Number(pathParts[1]) || Number(out.params.amount) || 0;
      out.note = out.params.note || out.params.text || '';
      return out;
    }

    // Skrill request link
    if (url.hostname === 'skrill.me' && pathParts[0] === 'rq') {
      out.scheme = 'skrill';
      out.recipient = pathParts[1] || '';
      out.amount = Number(pathParts[2]) || 0;
      out.currency = (pathParts[3] || 'USD').toUpperCase();
      out.key = out.params.key || '';
      return out;
    }

    // Generic payment links with amount/currency
    out.amount = Number(out.params.amount || out.params.amt || 0);
    out.currency = (out.params.currency || out.params.cur || 'USD').toUpperCase();
    return out;
  } catch (e) {
    return null;
  }
}

function parseEpcQr(rawValue) {
  // EPC SEPA QR: starts with BCD\n001\n1\nSCT\n...
  const lines = rawValue.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines[0] !== 'BCD') return null;
  const out = { type: 'epc_sepa', scheme: 'epc' };
  // Reference: BCD, Version, Character set, Function, BIC, Name, IBAN, Amount, Purpose, Ref, Text
  out.bic = lines[4] || '';
  out.beneficiary = lines[5] || '';
  out.iban = lines[6] || '';
  out.amountRaw = lines[7] || '';
  out.amount = Number(String(lines[7]).replace(/[^0-9.]/g, '')) || 0;
  out.currency = String(lines[7]).match(/[A-Z]{3}/)?.[0] || 'EUR';
  out.purpose = lines[8] || '';
  out.reference = lines[9] || '';
  out.note = lines[10] || '';
  return out;
}

function parsePlainText(rawValue) {
  // Look for routing + account numbers
  const routing = rawValue.match(/routing[:\s#]*(\d{9})/i)?.[1] || null;
  const account = rawValue.match(/account[:\s#]*(\d[\d\- ]*\d)/i)?.[1]?.replace(/\D/g, '') || null;
  const amountMatch = rawValue.match(/(?:amount|amt)[:\s$]*(\d+(?:\.\d{2})?)/i);
  const amount = amountMatch ? Number(amountMatch[1]) : 0;
  const currency = (rawValue.match(/currency[:\s]*([A-Z]{3})/i)?.[1] || 'USD').toUpperCase();
  if (routing && account) {
    return { type: 'bank_account', scheme: 'ach', routing, account, amount, currency };
  }
  return null;
}

function parseBarcode(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') throw new Error('barcode value required');
  const trimmed = rawValue.trim();

  let parsed = parseUrlValue(trimmed);
  if (!parsed) parsed = parseEpcQr(trimmed);
  if (!parsed) parsed = parsePlainText(trimmed);

  if (!parsed) parsed = { type: 'unknown', scheme: 'unknown' };

  parsed.amountCents = toCents(parsed.amount || 0);
  parsed.currency = parsed.currency || 'USD';
  parsed.rawValue = trimmed;
  return parsed;
}

class BarcodeDepositEngine {
  static async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id SERIAL PRIMARY KEY,
        deposit_id TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','deposited','cancelled')),
        raw_value TEXT NOT NULL,
        parsed_type TEXT,
        scheme TEXT,
        amount_cents BIGINT NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        beneficiary TEXT,
        account_number TEXT,
        routing_number TEXT,
        iban TEXT,
        cashtag TEXT,
        email TEXT,
        link_url TEXT,
        reference TEXT,
        notes TEXT,
        parsed JSONB,
        target_account_id TEXT,
        cash_movement_id TEXT,
        initiated_by TEXT NOT NULL DEFAULT 'system',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_status ON ${TABLE}(status)`);
  }

  static async scan({ rawValue, targetAccountId, initiatedBy = 'system' }) {
    await this.ensureTables();
    const parsed = parseBarcode(rawValue);

    const depositId = generateId('BCD');
    const fields = {
      deposit_id: depositId,
      status: 'pending',
      raw_value: parsed.rawValue,
      parsed_type: parsed.type,
      scheme: parsed.scheme,
      amount_cents: parsed.amountCents,
      currency: parsed.currency,
      beneficiary: parsed.beneficiary || parsed.recipient || null,
      account_number: parsed.account || null,
      routing_number: parsed.routing || null,
      iban: parsed.iban || null,
      cashtag: parsed.cashtag || null,
      email: parsed.email || null,
      link_url: parsed.type === 'url' ? parsed.rawValue : null,
      reference: parsed.reference || parsed.key || null,
      notes: parsed.note || parsed.purpose || null,
      parsed: JSON.stringify(parsed),
      target_account_id: (targetAccountId || '').trim().toUpperCase().replace(/\s+/g, '-') || null,
      initiated_by: initiatedBy,
    };

    const cols = Object.keys(fields);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
    const values = cols.map(k => fields[k]);

    await pool.query(
      `INSERT INTO ${TABLE} (${cols.join(',')}) VALUES (${placeholders})`,
      values
    );
    return this.getDeposit(depositId);
  }

  static async getDeposit(depositId) {
    if (!pool) throw new Error('Database not available');
    const result = await pool.query(`SELECT * FROM ${TABLE} WHERE deposit_id = $1`, [depositId]);
    return result.rows[0] || null;
  }

  static async listDeposits({ limit = 50, status } = {}) {
    if (!pool) throw new Error('Database not available');
    let sql = `SELECT * FROM ${TABLE}`;
    const params = [];
    if (status) { sql += ' WHERE status = $1'; params.push(status); }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    const result = await pool.query(sql, params);
    return result.rows;
  }

  static async approveDeposit(depositId, { targetAccountId, initiatedBy = 'system' } = {}) {
    if (!pool) throw new Error('Database not available');
    const row = await this.getDeposit(depositId);
    if (!row) throw new Error('Deposit not found');
    if (!['pending','approved'].includes(row.status)) throw new Error(`Deposit status is ${row.status}`);

    const targetRaw = (targetAccountId || row.target_account_id || 'CA-OPERATING').trim().toUpperCase().replace(/\s+/g, '-');
    const target = targetRaw;

    // Create an external-source cash movement representing the deposit
    const client = await pool.connect();
    let movementId;
    try {
      await client.query('BEGIN');
      const externalId = 'BARCODE-DEPOSIT-EXTERNAL';
      const extRes = await client.query(
        `INSERT INTO cash_accounts (account_id, account_name, account_type, status, balance_cents, created_at, updated_at)
         VALUES ($1, $2, $3, 'active', 0, NOW(), NOW())
         ON CONFLICT (account_id) DO NOTHING`,
        [externalId, 'Barcode Deposit External Source', 'escrow']
      );

      const fromRes = await client.query(
        `UPDATE cash_accounts SET balance_cents = balance_cents - $1, updated_at = NOW()
         WHERE account_id = $2 AND status = 'active' RETURNING *`,
        [row.amount_cents, externalId]
      );
      if (fromRes.rows.length === 0) throw new Error('External source account not found');

      const toRes = await client.query(
        `UPDATE cash_accounts SET balance_cents = balance_cents + $1, updated_at = NOW()
         WHERE account_id = $2 AND status = 'active' RETURNING *`,
        [row.amount_cents, target]
      );
      if (toRes.rows.length === 0) throw new Error(`Target account ${target} not found or not active`);

      movementId = `MOV-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      await client.query(
        `INSERT INTO cash_movements (movement_id, from_account_id, to_account_id, amount_cents, movement_type, reference_id, reference_type, memo, initiated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [movementId, externalId, target, row.amount_cents, 'deposit', row.deposit_id, 'barcode_deposit', `Barcode deposit ${row.deposit_id}`, initiatedBy]
      );
      await client.query(`UPDATE ${TABLE} SET status='deposited', target_account_id=$1, cash_movement_id=$2, updated_at=NOW() WHERE deposit_id=$3`,
        [target, movementId, depositId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return this.getDeposit(depositId);
  }

  static async cancelDeposit(depositId) {
    if (!pool) throw new Error('Database not available');
    const row = await this.getDeposit(depositId);
    if (!row) throw new Error('Deposit not found');
    if (row.status === 'deposited') throw new Error('Cannot cancel a deposited barcode');
    await pool.query(`UPDATE ${TABLE} SET status='cancelled', updated_at=NOW() WHERE deposit_id=$1`, [depositId]);
    return this.getDeposit(depositId);
  }
}

module.exports = { BarcodeDepositEngine, parseBarcode };
