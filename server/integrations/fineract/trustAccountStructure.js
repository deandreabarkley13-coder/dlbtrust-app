/**
 * Fineract Trust Account Structure — core banking accounts of the trust.
 *
 * The trust keeps its money in Fineract savings accounts (core banking), and the
 * GL classifies it. This module declares the structure, finds each account by
 * its stable externalId, provisions the ones that are missing (client + savings
 * account, approve, activate — never a balance movement) and reports the whole
 * structure for the GCP readiness workflow.
 *
 *   role               savings externalId                                  GL
 *   account-of-record  holder:<trust>:savings          (PPN funding source) 1000
 *   principal          holder:<trust>:principal        (corpus)             3000
 *   interest-income    holder:<trust>:interest-income  (coupon receipts)    4000 / 1020
 *   trustee            trustee:<crm contact_id>:savings                     1030
 *   beneficiary        beneficiary:<crm contact_id>:savings                 1020 / 2000
 *
 * Trustees and beneficiaries come from crm_contacts (contact_type, status =
 * active); their Fineract client is the CRM contact (externalId = contact_id).
 */

'use strict';

const { FineractClient } = require('./fineractClient');

let pool = null;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const TABLE = 'fineract_trust_accounts';
const PARTY_ROLES = ['trustee', 'beneficiary'];
const CACHE_TTL_MS = 60 * 1000;

const GL = {
  'account-of-record': { code: '1000', name: 'Trust Cash & Equivalents' },
  principal: { code: '3000', name: 'Trust Corpus' },
  'interest-income': { code: '4000', name: 'Interest Income', cashCode: '1020' },
  trustee: { code: '1030', name: 'Trust Operating Cash — Trustees' },
  beneficiary: { code: '1020', name: 'Coupon Income Cash — Beneficiary Support', payableCode: '2000' },
};

function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] || 'Trust', lastName: parts[0] || 'Trust' };
  return { firstName: parts.slice(0, -1).join(' ').slice(0, 50), lastName: parts[parts.length - 1].slice(0, 50) };
}

function summarize(role, expected, account) {
  if (!account) return { ...expected, role, found: false, active: false, blocker: `${role} account ${expected.externalId} not in Fineract` };
  const active = Boolean(account.status?.active);
  return {
    ...expected,
    role,
    found: true,
    active,
    id: account.id,
    accountNo: account.accountNo || null,
    clientId: account.clientId ?? null,
    clientName: account.clientName || null,
    product: account.savingsProductName || null,
    status: account.status?.value || null,
    balance: account.summary?.accountBalance ?? null,
    availableBalance: account.summary?.availableBalance ?? account.summary?.accountBalance ?? null,
    blocker: active ? null : `${role} account ${account.accountNo || account.id} is ${account.status?.value || 'not active'}`,
  };
}

let cache = { at: 0, value: null };

class TrustAccountStructure {
  static getConfig(env = process.env) {
    const holderId = env.TRUST_HOLDER_ID || 'dlb-irrevocable-trust';
    return {
      holderId,
      holderExternalId: `holder:${holderId}`,
      holderName: env.TRUST_HOLDER_NAME || 'DeAndrea Lavar Barkley Irrevocable Trust',
      externalIds: {
        'account-of-record': `holder:${holderId}:savings`,
        principal: `holder:${holderId}:principal`,
        'interest-income': `holder:${holderId}:interest-income`,
      },
      overrides: {
        principal: env.FINERACT_PRINCIPAL_SAVINGS_ACCOUNT_ID || null,
        'interest-income': env.FINERACT_INTEREST_INCOME_SAVINGS_ACCOUNT_ID || null,
      },
      configured: Boolean(env.FINERACT_URL) && !/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(env.FINERACT_URL),
    };
  }

  static async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        external_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        party_ref TEXT,
        party_name TEXT,
        gl_code TEXT,
        fineract_client_id BIGINT,
        fineract_account_id BIGINT,
        fineract_account_no TEXT,
        status TEXT,
        provisioned_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
  }

  /**
   * CRM trustees and beneficiaries eligible for a sub-account: active, trustee-approved,
   * KYC verified, AML clear. The same person recorded twice under one role is a duplicate:
   * the oldest contact is provisioned, the rest are reported as blockers, never provisioned.
   */
  static async parties() {
    if (!pool) return [];
    const r = await pool.query(
      `SELECT contact_id, contact_type, first_name, last_name, email, fineract_client_id
         FROM crm_contacts
        WHERE contact_type = ANY($1) AND status = 'active'
          AND approval_status = 'approved' AND kyc_status = 'verified'
          AND COALESCE(aml_status, 'clear') IN ('clear', 'cleared')
        ORDER BY contact_type, created_at, contact_id`, [PARTY_ROLES]);
    const seen = new Map();
    const duplicates = [];
    const rows = [];
    for (const c of r.rows) {
      const key = `${c.contact_type}|${`${c.first_name || ''} ${c.last_name || ''}`.replace(/\s+/g, ' ').trim().toUpperCase()}`;
      if (seen.has(key)) { duplicates.push({ ...c, duplicateOf: seen.get(key) }); continue; }
      seen.set(key, c.contact_id);
      rows.push(c);
    }
    const parties = rows.map((c) => ({
      role: c.contact_type,
      partyRef: c.contact_id,
      partyName: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
      firstName: c.first_name || c.last_name || 'Trust',
      lastName: c.last_name || c.first_name || 'Party',
      email: c.email || null,
      clientExternalId: c.contact_id,
      externalId: `${c.contact_type}:${c.contact_id}:savings`,
      glCode: GL[c.contact_type].code,
      glName: GL[c.contact_type].name,
    }));
    parties.duplicates = duplicates.map((c) => ({
      role: c.contact_type,
      partyRef: c.contact_id,
      partyName: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
      duplicateOf: c.duplicateOf,
    }));
    return parties;
  }

  /** The declared structure: trust-level accounts plus one sub-account per party. */
  static async expected(env = process.env) {
    const cfg = this.getConfig(env);
    const trust = ['account-of-record', 'principal', 'interest-income'].map((role) => ({
      role,
      partyRef: cfg.holderId,
      partyName: cfg.holderName,
      clientExternalId: cfg.holderExternalId,
      externalId: cfg.externalIds[role],
      overrideAccountId: cfg.overrides[role] || null,
      glCode: GL[role].code,
      glName: GL[role].name,
      provisionable: role !== 'account-of-record',
    }));
    const parties = await this.parties();
    const all = [...trust, ...parties.map((p) => ({ ...p, provisionable: true }))];
    all.duplicates = parties.duplicates || [];
    return all;
  }

  static async _find(entry) {
    if (entry.overrideAccountId) {
      const acct = await FineractClient.getAccountBalance(entry.overrideAccountId);
      return acct && acct.id ? acct : null;
    }
    return FineractClient.findSavingsAccountByExternalId(entry.externalId);
  }

  /**
   * Read-only picture of the structure as Fineract has it right now.
   * Cached for a minute so readiness probes stay cheap.
   */
  static async inventory({ fresh = false, env = process.env } = {}) {
    if (!fresh && cache.value && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
    const cfg = this.getConfig(env);
    const expected = await this.expected(env);
    const accounts = [];
    for (const entry of expected) {
      let account = null;
      let error = null;
      if (cfg.configured) {
        try { account = await this._find(entry); } catch (e) { error = e.message; }
      }
      const row = summarize(entry.role, entry, account);
      if (error) row.blocker = `${entry.role} ${entry.externalId}: ${error}`;
      accounts.push(row);
    }
    const byRole = (role) => accounts.filter((a) => a.role === role);
    const blockers = [];
    if (!cfg.configured) blockers.push('FINERACT_URL not set to the core-banking service');
    for (const a of accounts) if (a.blocker) blockers.push(a.blocker);
    if (!byRole('trustee').length) blockers.push('no active trustee in crm_contacts: no trustee sub-account to provision');
    if (!byRole('beneficiary').length) blockers.push('no active beneficiary in crm_contacts: no beneficiary sub-account to provision');
    const duplicates = expected.duplicates || [];
    for (const d of duplicates) {
      blockers.push(`duplicate ${d.role} in crm_contacts: ${d.partyRef} (${d.partyName}) duplicates ${d.duplicateOf}; retire one before provisioning`);
    }
    const value = {
      holder: { externalId: cfg.holderExternalId, name: cfg.holderName },
      accountOfRecord: byRole('account-of-record')[0] || null,
      principal: byRole('principal')[0] || null,
      interestIncome: byRole('interest-income')[0] || null,
      trustees: byRole('trustee'),
      beneficiaries: byRole('beneficiary'),
      duplicates,
      counts: {
        expected: accounts.length,
        found: accounts.filter((a) => a.found).length,
        active: accounts.filter((a) => a.active).length,
        missing: accounts.filter((a) => !a.found).map((a) => a.externalId),
      },
      gl: GL,
      complete: accounts.length > 0 && accounts.every((a) => a.active) && duplicates.length === 0,
      blockers,
      checkedAt: new Date().toISOString(),
    };
    cache = { at: Date.now(), value };
    if (pool) await this._record(accounts).catch(() => {});
    return value;
  }

  static async _record(accounts) {
    await this.ensureTables();
    for (const a of accounts) {
      await pool.query(
        `INSERT INTO ${TABLE} (external_id, role, party_ref, party_name, gl_code, fineract_client_id, fineract_account_id, fineract_account_no, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (external_id) DO UPDATE SET fineract_client_id = EXCLUDED.fineract_client_id,
           fineract_account_id = EXCLUDED.fineract_account_id, fineract_account_no = EXCLUDED.fineract_account_no,
           status = EXCLUDED.status, party_name = EXCLUDED.party_name, updated_at = NOW()`,
        [a.externalId, a.role, a.partyRef, a.partyName, a.glCode, a.clientId ?? null, a.id ?? null, a.accountNo ?? null, a.found ? (a.status || 'unknown') : 'missing']);
    }
  }

  /**
   * Active Fineract savings account id for a role (null when absent or inactive).
   * Trustee / beneficiary sub-accounts are resolved by CRM contact id (opts.partyRef).
   */
  static async resolveAccountId(role, opts = {}) {
    const { partyRef, ...invOpts } = opts;
    const inv = await this.inventory(invOpts);
    let entry = null;
    if (PARTY_ROLES.includes(role)) {
      const list = role === 'trustee' ? inv.trustees : inv.beneficiaries;
      entry = partyRef ? list.find((a) => a.partyRef === String(partyRef)) || null : null;
    } else {
      entry = role === 'interest-income' ? inv.interestIncome : role === 'principal' ? inv.principal : role === 'account-of-record' ? inv.accountOfRecord : null;
    }
    return entry && entry.active ? String(entry.id) : null;
  }

  /**
   * Last recorded Fineract savings account id for a role (and CRM contact id for
   * trustee / beneficiary) from fineract_trust_accounts; no Fineract call. The
   * caller still checks the account is active before moving money on it.
   */
  static async recordedAccountId(role, { partyRef = null } = {}) {
    if (!pool) return null;
    const r = await pool.query(
      `SELECT fineract_account_id FROM ${TABLE}
        WHERE role = $1 AND ($2::text IS NULL OR party_ref = $2) AND fineract_account_id IS NOT NULL AND status <> 'missing'
        ORDER BY updated_at DESC LIMIT 1`, [role, partyRef]);
    const id = r && r.rows && r.rows[0] ? r.rows[0].fineract_account_id : null;
    return id == null ? null : String(id);
  }

  static async _ensureClient(entry, actor) {
    const existing = await FineractClient.findClientByExternalId(entry.clientExternalId);
    if (existing) return { id: existing.id, created: false };
    const { firstName, lastName } = entry.firstName ? { firstName: entry.firstName, lastName: entry.lastName } : splitName(entry.partyName);
    const created = await FineractClient.createClient({ firstName, lastName, externalId: entry.clientExternalId, email: entry.email || undefined });
    const id = created.clientId || created.resourceId || created.id;
    if (!id) throw new Error(`Fineract did not return a client id for ${entry.clientExternalId}`);
    if (pool && PARTY_ROLES.includes(entry.role)) {
      await pool.query('UPDATE crm_contacts SET fineract_client_id = $1, updated_at = NOW() WHERE contact_id = $2', [String(id), entry.partyRef]).catch(() => {});
    }
    return { id, created: true, by: actor };
  }

  /**
   * Create every missing account (client if needed, savings account, approve,
   * activate). Existing accounts are left alone; no deposit or withdrawal is made.
   */
  static async provision({ dryRun = false, actor = 'system', env = process.env } = {}) {
    const cfg = this.getConfig(env);
    if (!cfg.configured) throw new Error('FINERACT_URL not set to the core-banking service');
    const expected = await this.expected(env);
    const Issuance = require('../bonds/bondIssuanceEngine').BondIssuanceEngine;
    const results = [];
    let product = null;
    for (const entry of expected) {
      const found = await this._find(entry);
      if (found) { results.push({ role: entry.role, externalId: entry.externalId, action: 'exists', id: found.id, accountNo: found.accountNo, active: Boolean(found.status?.active) }); continue; }
      if (!entry.provisionable) { results.push({ role: entry.role, externalId: entry.externalId, action: 'missing', error: 'account of record is opened by bond issuance, not here' }); continue; }
      if (dryRun) { results.push({ role: entry.role, externalId: entry.externalId, action: 'would-create', client: entry.clientExternalId, glCode: entry.glCode }); continue; }
      try {
        if (!product) product = await Issuance.ensureSavingsProduct();
        const client = await this._ensureClient(entry, actor);
        const created = await FineractClient.createSavingsAccount({ clientId: client.id, productId: product.id, externalId: entry.externalId });
        const accountId = created.savingsId || created.resourceId || created.id;
        if (!accountId) throw new Error('Fineract did not return a savings account id');
        await FineractClient.commandSavingsAccount(accountId, 'approve');
        await FineractClient.commandSavingsAccount(accountId, 'activate');
        const acct = await FineractClient.getAccountBalance(accountId);
        results.push({ role: entry.role, externalId: entry.externalId, action: 'created', id: accountId, accountNo: acct?.accountNo || null, clientId: client.id, clientCreated: client.created, active: Boolean(acct?.status?.active), glCode: entry.glCode });
      } catch (e) {
        results.push({ role: entry.role, externalId: entry.externalId, action: 'failed', error: e.message });
      }
    }
    cache = { at: 0, value: null };
    const inventory = dryRun ? null : await this.inventory({ fresh: true, env });
    if (pool && !dryRun) {
      await pool.query(`UPDATE ${TABLE} SET provisioned_by = $1 WHERE external_id = ANY($2) AND provisioned_by IS NULL`,
        [actor, results.filter((r) => r.action === 'created').map((r) => r.externalId)]).catch(() => {});
    }
    return { dryRun, actor, results, created: results.filter((r) => r.action === 'created').length, failed: results.filter((r) => r.action === 'failed').length, inventory };
  }
}

module.exports = { TrustAccountStructure, GL, TABLE, PARTY_ROLES };
