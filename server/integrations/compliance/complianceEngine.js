'use strict';

/**
 * Compliance Engine
 *
 * Provides KYC (Know Your Customer), AML (Anti-Money Laundering), and
 * sanctions screening for counterparties before real-money payouts.
 *
 * The default implementation uses rule-based scoring, an optional
 * OFAC/UN/EU local list, and hooks for third-party providers.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

function generateId() {
  return `COMP-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

const HIGH_RISK_COUNTRIES = new Set([
  'AF','BY','CF','CU','IR','IQ','KP','LY','MM','NI','RU','SO','SS','SD','SY','VE','YE','ZW'
]);

const SANCTIONED_LIST = (process.env.COMPLIANCE_SANCTIONED_NAMES || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

class ComplianceEngine {
  static async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS compliance_screenings (
        id SERIAL PRIMARY KEY,
        screening_id TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('kyc','aml','sanctions','combined')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','clear','review','blocked')),
        entity_type TEXT NOT NULL DEFAULT 'individual' CHECK (entity_type IN ('individual','business')),
        full_name TEXT,
        business_name TEXT,
        email TEXT,
        phone TEXT,
        address JSONB,
        identification JSONB,
        bank_account TEXT,
        routing_number TEXT,
        country TEXT,
        date_of_birth DATE,
        risk_score INTEGER NOT NULL DEFAULT 0,
        risk_level TEXT NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low','medium','high','critical')),
        findings JSONB NOT NULL DEFAULT '[]',
        provider TEXT,
        provider_response JSONB,
        screened_by TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_compliance_status ON compliance_screenings(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_compliance_name ON compliance_screenings USING gin(to_tsvector('english', COALESCE(full_name,'') || ' ' || COALESCE(business_name,'')))`);
  }

  static normalizeName(name) {
    return (name || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  static normalizeForSearch(name) {
    return (name || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  static levenshtein(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        const cost = b[i - 1] === a[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost
        );
      }
    }
    return matrix[b.length][a.length];
  }

  static fuzzyNameMatch(input, target) {
    const a = this.normalizeForSearch(input);
    const b = this.normalizeForSearch(target);
    if (!a || !b) return false;
    if (a.includes(b) || b.includes(a)) return true;
    const dist = this.levenshtein(a, b);
    return dist <= Math.min(3, Math.floor(Math.max(a.length, b.length) * 0.2));
  }

  static scoreScreening(data) {
    const findings = [];
    let score = 0;
    const amountCents = toCents(data.amount);

    if (HIGH_RISK_COUNTRIES.has((data.country || '').toUpperCase())) {
      score += 50;
      findings.push({ rule: 'high_risk_country', message: `Country ${data.country} is high-risk` });
    }

    if (amountCents > 100000000) { // > $1M
      score += 30;
      findings.push({ rule: 'large_amount', message: 'Amount exceeds $1,000,000' });
    } else if (amountCents > 10000000) { // > $100k
      score += 15;
      findings.push({ rule: 'elevated_amount', message: 'Amount exceeds $100,000' });
    }

    const nameToCheck = data.fullName || data.businessName || '';
    for (const sanctioned of SANCTIONED_LIST) {
      if (this.fuzzyNameMatch(nameToCheck, sanctioned)) {
        score += 100;
        findings.push({ rule: 'sanctions_match', message: `Name matches sanctioned entry: ${sanctioned}` });
        break;
      }
    }

    if (!data.fullName && !data.businessName) {
      score += 20;
      findings.push({ rule: 'missing_name', message: 'No full or business name provided' });
    }

    if (!data.country) {
      score += 10;
      findings.push({ rule: 'missing_country', message: 'No country provided' });
    }

    if (data.businessName && !data.businessName.match(/[a-z]/i)) {
      score += 10;
      findings.push({ rule: 'invalid_business_name', message: 'Business name appears invalid' });
    }

    let level = 'low';
    if (score >= 80) level = 'critical';
    else if (score >= 50) level = 'high';
    else if (score >= 20) level = 'medium';

    let status = 'clear';
    if (score >= 80) status = 'blocked';
    else if (score >= 20) status = 'review';

    return { score, level, status, findings };
  }

  static async screen({
    type = 'combined',
    entityType = 'individual',
    fullName,
    businessName,
    email,
    phone,
    address,
    identification,
    bankAccount,
    routingNumber,
    country,
    dateOfBirth,
    amount,
    provider = process.env.COMPLIANCE_PROVIDER || 'local',
    screenedBy = 'system',
    notes,
  } = {}) {
    await this.ensureTables();
    const screeningId = generateId();
    const result = this.scoreScreening({
      fullName, businessName, email, country, amount
    });

    if (!pool) {
      return { screening_id: screeningId, ...result, provider, created_at: new Date().toISOString() };
    }

    await pool.query(
      `INSERT INTO compliance_screenings
         (screening_id, type, status, entity_type, full_name, business_name, email, phone, address, identification, bank_account, routing_number, country, date_of_birth, risk_score, risk_level, findings, provider, screened_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [screeningId, type, result.status, entityType, fullName || null, businessName || null, email || null, phone || null,
       address ? JSON.stringify(address) : null,
       identification ? JSON.stringify(identification) : null,
       bankAccount || null, routingNumber || null, country || null, dateOfBirth || null,
       result.score, result.level, JSON.stringify(result.findings), provider, screenedBy, notes || null]
    );

    return this.getScreening(screeningId);
  }

  static async getScreening(screeningId) {
    if (!pool) return null;
    const res = await pool.query('SELECT * FROM compliance_screenings WHERE screening_id = $1', [screeningId]);
    return res.rows[0] || null;
  }

  static async list({ status, limit = 50 } = {}) {
    if (!pool) return [];
    let sql = 'SELECT * FROM compliance_screenings';
    const params = [];
    if (status) { sql += ' WHERE status = $1'; params.push(status); }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    const res = await pool.query(sql, params);
    return res.rows;
  }

  static async updateStatus(screeningId, { status, notes, reviewedBy }) {
    const row = await this.getScreening(screeningId);
    if (!row) throw new Error('Screening not found');
    const extraNotes = notes ? (row.notes ? row.notes + '\n' + notes : notes) : row.notes;
    if (!pool) return { ...row, status, notes: extraNotes, updated_at: new Date().toISOString() };
    await pool.query(
      `UPDATE compliance_screenings SET status=$1, notes=$2, screened_by=$3, updated_at=NOW() WHERE screening_id=$4`,
      [status, extraNotes, reviewedBy || row.screened_by, screeningId]
    );
    return this.getScreening(screeningId);
  }

  static async approve(screeningId, { reviewedBy, notes } = {}) {
    return this.updateStatus(screeningId, { status: 'clear', notes, reviewedBy });
  }

  static async block(screeningId, { reviewedBy, notes } = {}) {
    return this.updateStatus(screeningId, { status: 'blocked', notes, reviewedBy });
  }

  static async screenRecipientForPayout(recipient = {}, amount, sourceAccountId) {
    return this.screen({
      type: 'combined',
      entityType: recipient.businessName ? 'business' : 'individual',
      fullName: recipient.fullName,
      businessName: recipient.businessName,
      email: recipient.email,
      phone: recipient.phone,
      address: recipient.address,
      bankAccount: recipient.bankAccount || recipient.account,
      routingNumber: recipient.routingNumber || recipient.routing,
      country: recipient.country || 'US',
      amount,
      notes: `Source account: ${sourceAccountId || 'unknown'}`,
    });
  }

  static mustPass(screening) {
    if (!screening) throw new Error('Compliance screening required before payout');
    if (screening.status === 'blocked') throw new Error(`Compliance blocked: risk level ${screening.risk_level}`);
    if (screening.status === 'review') throw new Error(`Compliance review required: risk level ${screening.risk_level}`);
    if (screening.status !== 'clear') throw new Error(`Compliance status is ${screening.status}`);
    return true;
  }
}

module.exports = { ComplianceEngine };
