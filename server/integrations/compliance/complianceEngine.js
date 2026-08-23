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

let OfacSanctionsListEngine;
try {
  ({ OfacSanctionsListEngine } = require('./ofacSanctionsListEngine'));
} catch (e) {
  OfacSanctionsListEngine = null;
}

function generateId() {
  return `COMP-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

const HIGH_RISK_COUNTRIES = new Set([
  'AF','BY','CF','CU','IR','IQ','KP','LY','MM','NI','RU','SO','SS','SD','SY','VE','YE','ZW'
]);

function configuredSanctionedNames() {
  return (process.env.COMPLIANCE_SANCTIONED_NAMES || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function providerName() {
  return String(process.env.COMPLIANCE_PROVIDER || 'local').trim().toLowerCase();
}

function complianceUnavailable(message) {
  const error = new Error(message);
  error.status = 503;
  error.code = 'COMPLIANCE_UNAVAILABLE';
  return error;
}

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
    if (OfacSanctionsListEngine) await OfacSanctionsListEngine.ensureTables();
  }

  static async initialize() {
    await this.ensureTables();
    if (
      OfacSanctionsListEngine
      && providerName() === 'ofac'
      && process.env.COMPLIANCE_OFAC_AUTO_REFRESH !== 'false'
    ) {
      await OfacSanctionsListEngine.refreshIfStale();
      const intervalHours = Number.parseInt(
        process.env.COMPLIANCE_OFAC_REFRESH_INTERVAL_HOURS || '12',
        10
      );
      if (Number.isFinite(intervalHours) && intervalHours > 0 && !this._refreshTimer) {
        this._refreshTimer = setInterval(() => {
          OfacSanctionsListEngine.refreshIfStale()
            .catch((error) => console.error('[compliance] OFAC refresh failed:', error.message));
        }, intervalHours * 3600000);
        if (typeof this._refreshTimer.unref === 'function') this._refreshTimer.unref();
      }
    }
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

  static scoreScreening(data, sanctionsMatch) {
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

    if (sanctionsMatch) {
      const exact = Number(sanctionsMatch.similarity || 0) === 1;
      score += exact ? 100 : 70;
      findings.push({
        rule: exact ? 'sanctions_exact_match' : 'sanctions_potential_match',
        message: `${exact ? 'Exact' : 'Potential'} OFAC match: ${sanctionsMatch.name}`,
        source: sanctionsMatch.sourceFile || 'configured-list',
        entryUid: sanctionsMatch.entryUid || null,
        similarity: sanctionsMatch.similarity || null,
      });
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

  static async readiness() {
    const provider = providerName();
    const issues = [];
    let providerStatus;
    if (provider === 'ofac') {
      if (!OfacSanctionsListEngine) {
        providerStatus = {
          ready: false,
          provider,
          entryCount: 0,
          issues: ['OFAC sanctions list engine is not available'],
        };
      } else {
        providerStatus = await OfacSanctionsListEngine.readiness();
      }
    } else if (provider === 'local') {
      const entryCount = configuredSanctionedNames().length;
      const productionUnsafe = process.env.NODE_ENV === 'production';
      providerStatus = {
        ready: !productionUnsafe && process.env.COMPLIANCE_ALLOW_LOCAL_SCREENING === 'true' && entryCount > 0,
        provider,
        source: 'COMPLIANCE_SANCTIONED_NAMES',
        entryCount,
        issues: [],
      };
      if (productionUnsafe) providerStatus.issues.push('Local sanctions screening cannot authorize production payments');
      if (process.env.COMPLIANCE_ALLOW_LOCAL_SCREENING !== 'true') {
        providerStatus.issues.push('COMPLIANCE_ALLOW_LOCAL_SCREENING is not enabled');
      }
      if (entryCount <= 0) providerStatus.issues.push('COMPLIANCE_SANCTIONED_NAMES is empty');
    } else {
      providerStatus = {
        ready: false,
        provider,
        entryCount: 0,
        issues: [`Unsupported compliance provider: ${provider}`],
      };
    }
    issues.push(...(providerStatus.issues || []));
    return {
      ready: providerStatus.ready && issues.length === 0,
      engineAvailable: true,
      provider,
      providerStatus,
      sanctionedCount: providerStatus.entryCount || 0,
      issues,
      timestamp: new Date().toISOString(),
    };
  }

  static async assertPaymentReady() {
    const status = await this.readiness();
    if (!status.ready) {
      throw complianceUnavailable(
        `Compliance provider is not ready: ${status.issues.join('; ') || 'unknown readiness failure'}`
      );
    }
    return status;
  }

  static async _sanctionsMatch(name, provider) {
    if (!name) return null;
    if (provider === 'ofac') {
      if (!OfacSanctionsListEngine) throw complianceUnavailable('OFAC sanctions list engine is not available');
      const status = await OfacSanctionsListEngine.readiness();
      if (!status.ready) {
        throw complianceUnavailable(`OFAC sanctions list is not ready: ${status.issues.join('; ')}`);
      }
      return OfacSanctionsListEngine.screenName(name);
    }
    for (const sanctioned of configuredSanctionedNames()) {
      if (this.fuzzyNameMatch(name, sanctioned)) {
        return {
          name: sanctioned,
          entryUid: `configured:${sanctioned}`,
          sourceFile: 'COMPLIANCE_SANCTIONED_NAMES',
          similarity: this.normalizeName(name) === this.normalizeName(sanctioned) ? 1 : 0.9,
        };
      }
    }
    return null;
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
    provider = providerName(),
    screenedBy = 'system',
    notes,
  } = {}) {
    await this.ensureTables();
    const screeningId = generateId();
    provider = String(provider || providerName()).toLowerCase();
    const nameToCheck = fullName || businessName || '';
    const sanctionsMatch = await this._sanctionsMatch(nameToCheck, provider);
    const result = this.scoreScreening({
      fullName, businessName, email, country, amount
    }, sanctionsMatch);
    const providerResponse = {
      provider,
      sanctionsMatch: sanctionsMatch
        ? {
          entryUid: sanctionsMatch.entryUid,
          name: sanctionsMatch.name,
          sourceFile: sanctionsMatch.sourceFile,
          similarity: sanctionsMatch.similarity,
          isAlias: sanctionsMatch.isAlias,
        }
        : null,
    };

    if (!pool) {
      return {
        screening_id: screeningId,
        status: result.status,
        risk_score: result.score,
        risk_level: result.level,
        findings: result.findings,
        provider,
        provider_response: providerResponse,
        created_at: new Date().toISOString(),
      };
    }

    await pool.query(
      `INSERT INTO compliance_screenings
         (screening_id, type, status, entity_type, full_name, business_name, email, phone, address, identification, bank_account, routing_number, country, date_of_birth, risk_score, risk_level, findings, provider, provider_response, screened_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [screeningId, type, result.status, entityType, fullName || null, businessName || null, email || null, phone || null,
       address ? JSON.stringify(address) : null,
       identification ? JSON.stringify(identification) : null,
       bankAccount || null, routingNumber || null, country || null, dateOfBirth || null,
       result.score, result.level, JSON.stringify(result.findings), provider,
       JSON.stringify(providerResponse), screenedBy, notes || null]
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

  static async screenRecipientForPayout(recipient = {}, amount, sourceAccountId, options = {}) {
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
      screenedBy: options.screenedBy || 'system',
      notes: [
        `Source account: ${sourceAccountId || 'unknown'}`,
        options.notes,
      ].filter(Boolean).join('; '),
    });
  }

  static mustPass(screening) {
    let message;
    if (!screening) message = 'Compliance screening required before payout';
    else if (screening.status === 'blocked') message = `Compliance blocked: risk level ${screening.risk_level}`;
    else if (screening.status === 'review') message = `Compliance review required: risk level ${screening.risk_level}`;
    else if (screening.status !== 'clear') message = `Compliance status is ${screening.status || 'missing'}`;
    if (message) {
      const error = new Error(message);
      error.status = 422;
      error.code = 'COMPLIANCE_GATE_BLOCKED';
      throw error;
    }
    return true;
  }
}

module.exports = { ComplianceEngine };
