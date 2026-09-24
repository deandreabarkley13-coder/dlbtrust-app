'use strict';

/**
 * Proof of Asset OS — the private placement bond and its fixed income, proven
 * across every system that holds a piece of it.
 *
 * The trust acts as a family financial institution: the contract (the bond)
 * is the asset, the Irrevocable Trust's Fineract account is the account of
 * record for the P&I paid on it, the GL mirrors every movement, and a bank is
 * only a warehouse the held value can optionally be converted into. A proof
 * lines those layers up for one bond (or the whole book) at one instant:
 *
 *   contract   bonds + bond_issuances — face, coupon, schedule, issuer/holder
 *   schedule   LiveBondEngine — accrued to date, next coupon
 *   record     bond_issuance_payments — every P&I booked, by status
 *   fineract   holder / issuer savings balances and the deposit/withdrawal ids
 *   ledger     trust_journal_entries — the holder journal behind each payment
 *   fiat       fixed-income distributions + settlement-bank events for the
 *              payments explicitly sent to bank (Stripe payout -> Lili)
 *   custody    AttestationOsEngine — what outside custodians actually hold
 *
 * The verdict never confuses the layers:
 *
 *   recordOfValue   proven   Fineract covers the held value and the GL agrees
 *                   variance a layer disagrees (each check names by how much)
 *                   unproven a layer could not be read (never a zero dressed
 *                            as a reading)
 *   fiatCustody     what has actually left the record and settled at a bank,
 *                   and what outside custody attests — separate on purpose, so
 *                   an internal balance is never presented as external cash.
 *
 * Every proof is hashed over its canonical evidence and chained to the prior
 * proof, so the register is tamper-evident; an admin may certify a proof,
 * which signs the hash with the certifier's identity.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');

let BondIssuanceEngine = null;
try { ({ BondIssuanceEngine } = require('../bonds/bondIssuanceEngine')); } catch (e) { BondIssuanceEngine = null; }
let FineractClient = null;
try { ({ FineractClient } = require('../fineract/fineractClient')); } catch (e) { FineractClient = null; }
let LiveBondEngine = null;
try { ({ LiveBondEngine } = require('../bonds/liveEngine')); } catch (e) { LiveBondEngine = null; }
let FixedIncomeDistributionEngine = null;
try { ({ FixedIncomeDistributionEngine } = require('./fixedIncomeDistributionEngine')); } catch (e) { FixedIncomeDistributionEngine = null; }
let BankSettlementEngine = null;
try { ({ BankSettlementEngine } = require('../payments/bankSettlementEngine')); } catch (e) { BankSettlementEngine = null; }
let AttestationOsEngine = null;
try { ({ AttestationOsEngine } = require('./attestationOsEngine')); } catch (e) { AttestationOsEngine = null; }

const VERDICTS = ['proven', 'variance', 'unproven'];
const SCOPES = ['bond', 'portfolio'];
const HOLDER_CASH_ACCOUNT = '1020';
const TOLERANCE_CENTS = 1;

const schedulerState = { lastRunAt: null, nextRunAt: null, intervalMinutes: null };

class ProofOfAssetError extends Error {
  constructor(message, code = 'PROOF_OF_ASSET_ERROR', status = 409) {
    super(message);
    this.name = 'ProofOfAssetError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function proofId() { return `POA-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }
function cents(usd) { return Math.round(Number(usd || 0) * 100); }
function isoDate(d) { return d ? new Date(d).toISOString().slice(0, 10) : null; }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  return JSON.stringify(value === undefined ? null : value);
}
function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

function check(name, { expectedCents, actualCents, source, note }) {
  if (actualCents == null) return { name, verdict: 'unproven', expectedCents, actualCents: null, varianceCents: null, source, note: note || `${source} unreadable` };
  const variance = actualCents - expectedCents;
  return { name, verdict: Math.abs(variance) <= TOLERANCE_CENTS ? 'proven' : 'variance', expectedCents, actualCents, varianceCents: variance, source, note: note || null };
}

function worst(checks) {
  if (checks.some((c) => c.verdict === 'unproven')) return 'unproven';
  if (checks.some((c) => c.verdict === 'variance')) return 'variance';
  return 'proven';
}

function rowToProof(row) {
  if (!row) return null;
  const evidence = typeof row.evidence === 'string' ? JSON.parse(row.evidence) : (row.evidence || {});
  return {
    proofId: row.proof_id,
    scope: row.scope,
    bondId: row.bond_id == null ? null : Number(row.bond_id),
    asOf: row.as_of,
    verdict: row.verdict,
    contractValueCents: Number(row.contract_value_cents),
    recordOfValueCents: Number(row.record_of_value_cents),
    fineractHeldCents: row.fineract_held_cents == null ? null : Number(row.fineract_held_cents),
    fiatSettledCents: Number(row.fiat_settled_cents),
    custodyAttestedCents: row.custody_attested_cents == null ? null : Number(row.custody_attested_cents),
    hash: row.hash,
    previousHash: row.previous_hash,
    evidence,
    certifiedBy: row.certified_by,
    certifiedAt: row.certified_at,
    certificationSignature: row.certification_signature,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

const ProofOfAssetOsEngine = {
  ProofOfAssetError,
  VERDICTS,
  SCOPES,
  schedulerState,

  config() {
    const env = process.env;
    const n = Number(env.PROOF_OF_ASSET_INTERVAL_MINUTES);
    return {
      enabled: String(env.PROOF_OF_ASSET_ENABLED || 'true').toLowerCase() !== 'false',
      intervalMinutes: Number.isFinite(n) && n >= 0 ? n : 0,
      holderCashAccount: env.PROOF_OF_ASSET_HOLDER_CASH_ACCOUNT || HOLDER_CASH_ACCOUNT,
    };
  },

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS proof_of_asset_proofs (
        proof_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('bond','portfolio')),
        bond_id INTEGER,
        as_of TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        verdict TEXT NOT NULL CHECK (verdict IN ('proven','variance','unproven')),
        contract_value_cents BIGINT NOT NULL DEFAULT 0,
        record_of_value_cents BIGINT NOT NULL DEFAULT 0,
        fineract_held_cents BIGINT,
        fiat_settled_cents BIGINT NOT NULL DEFAULT 0,
        custody_attested_cents BIGINT,
        hash TEXT NOT NULL,
        previous_hash TEXT,
        evidence JSONB NOT NULL,
        certified_by TEXT,
        certified_at TIMESTAMPTZ,
        certification_signature TEXT,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query('CREATE INDEX IF NOT EXISTS proof_of_asset_proofs_bond_idx ON proof_of_asset_proofs (bond_id, created_at DESC)');
  },

  // ── evidence ───────────────────────────────────────────────────────────────

  async _contract(bondId) {
    const { rows } = await pool.query(`
      SELECT b.id, b.bond_name, b.bond_identifier, b.isin, b.face_value, b.coupon_rate, b.payment_freq, b.issue_date, b.maturity_date,
             b.status AS bond_status, b.placement_type, b.issuer, b.bondholder,
             i.issuer_external_id, i.holder_external_id, i.status AS issuance_status, i.issued_by, i.issued_at
        FROM bonds b LEFT JOIN bond_issuances i ON i.bond_id = b.id
       WHERE b.id = $1`, [bondId]);
    const r = rows[0];
    if (!r) throw new ProofOfAssetError(`bond ${bondId} not found`, 'NOT_FOUND', 404);
    return {
      bondId: Number(r.id), bondName: r.bond_name, bondIdentifier: r.bond_identifier || null, isin: r.isin || null,
      faceValueCents: cents(r.face_value), couponRatePct: Number(r.coupon_rate), paymentFreq: r.payment_freq,
      issueDate: isoDate(r.issue_date), maturityDate: isoDate(r.maturity_date), bondStatus: r.bond_status,
      placementType: r.placement_type || null, issuer: r.issuer || null, bondholder: r.bondholder || null,
      issued: Boolean(r.issuance_status), issuanceStatus: r.issuance_status || null,
      issuerExternalId: r.issuer_external_id || null, holderExternalId: r.holder_external_id || null,
      issuedBy: r.issued_by || null, issuedAt: r.issued_at || null,
    };
  },

  async _schedule(bondId) {
    if (!LiveBondEngine) return { available: false };
    try {
      const m = await LiveBondEngine.getBondLiveMetrics(bondId);
      return {
        available: true, principalBalanceCents: cents(m.principal_balance), accruedInterestCents: cents(m.accrued_interest_total),
        couponPerPeriodCents: cents(m.coupon_per_period), nextCouponDate: m.next_coupon_date || null, daysToMaturity: m.days_to_maturity ?? null,
      };
    } catch (e) { return { available: false, error: e.message }; }
  },

  async _payments(bondId) {
    const { rows } = await pool.query(
      `SELECT payment_id, bond_id, kind, period_date, amount_usd, status, fineract_withdrawal_id, fineract_deposit_id, holder_entry_id, issuer_entry_ids, intake_id
         FROM bond_issuance_payments ${bondId != null ? 'WHERE bond_id = $1' : ''} ORDER BY period_date, payment_id`,
      bondId != null ? [bondId] : []);
    const items = rows.map((r) => ({
      paymentId: r.payment_id, bondId: Number(r.bond_id), kind: r.kind, periodDate: isoDate(r.period_date), amountCents: cents(r.amount_usd), status: r.status,
      fineractWithdrawalId: r.fineract_withdrawal_id || null, fineractDepositId: r.fineract_deposit_id || null,
      holderEntryId: r.holder_entry_id || null, issuerEntryIds: r.issuer_entry_ids || [], intakeId: r.intake_id || null,
    }));
    const sum = (pred) => items.filter(pred).reduce((s, p) => s + p.amountCents, 0);
    return {
      items,
      heldCents: sum((p) => ['held', 'funded'].includes(p.status)),
      sentToBankCents: sum((p) => p.status === 'sent_to_bank'),
      awaitingExternalCents: sum((p) => p.status === 'awaiting_external_funds'),
      failedCents: sum((p) => p.status === 'failed'),
      couponCents: sum((p) => p.kind === 'coupon' && p.status !== 'failed'),
      principalCents: sum((p) => p.kind === 'principal' && p.status !== 'failed'),
    };
  },

  async _fineract() {
    const out = { available: Boolean(FineractClient), issuer: null, holder: null, error: null };
    if (!FineractClient) { out.error = 'FineractClient unavailable'; return out; }
    let parties;
    try { ({ rows: parties } = await pool.query('SELECT role, fineract_client_id, fineract_account_id, fineract_account_no FROM bond_issuance_parties')); } catch (e) { out.error = e.message; return out; }
    for (const role of ['issuer', 'holder']) {
      const p = parties.find((x) => x.role === role);
      if (!p) { out[role] = { provisioned: false }; continue; }
      const view = { provisioned: true, clientId: Number(p.fineract_client_id), accountId: Number(p.fineract_account_id), accountNo: p.fineract_account_no, balanceCents: null, active: null };
      try {
        const acct = await FineractClient.getAccountBalance(p.fineract_account_id);
        const summary = acct && acct.summary ? acct.summary : {};
        view.balanceCents = summary.accountBalance != null ? cents(summary.accountBalance) : null;
        view.totalDepositsCents = summary.totalDeposits != null ? cents(summary.totalDeposits) : null;
        view.totalWithdrawalsCents = summary.totalWithdrawals != null ? cents(summary.totalWithdrawals) : null;
        view.active = Boolean(acct && acct.status && acct.status.active);
      } catch (e) { view.error = e.message; out.error = out.error || `${role}: ${e.message}`; }
      out[role] = view;
    }
    return out;
  },

  async _ledger(payments) {
    const cashAccount = this.config().holderCashAccount;
    const ids = payments.items.map((p) => p.holderEntryId).filter(Boolean);
    if (!ids.length) return { available: true, entries: [], holderCashDebitCents: 0, unbalancedEntries: [], missingEntryIds: [] };
    let rows;
    try {
      ({ rows } = await pool.query(`
        SELECT je.entry_id, je.status, je.reference_id, jl.account_code, jl.debit_amount, jl.credit_amount
          FROM trust_journal_entries je JOIN trust_journal_lines jl ON jl.entry_id = je.entry_id
         WHERE je.entry_id = ANY($1::text[])`, [ids]));
    } catch (e) { return { available: false, error: e.message, entries: [], holderCashDebitCents: null, unbalancedEntries: [], missingEntryIds: ids }; }
    const byEntry = new Map();
    for (const r of rows) {
      const e = byEntry.get(r.entry_id) || { entryId: r.entry_id, status: r.status, referenceId: r.reference_id, debitCents: 0, creditCents: 0, holderCashDebitCents: 0 };
      e.debitCents += cents(r.debit_amount); e.creditCents += cents(r.credit_amount);
      if (String(r.account_code) === String(cashAccount)) e.holderCashDebitCents += cents(r.debit_amount) - cents(r.credit_amount);
      byEntry.set(r.entry_id, e);
    }
    const entries = [...byEntry.values()];
    const posted = entries.filter((e) => e.status === 'posted');
    return {
      available: true, cashAccount, entries,
      holderCashDebitCents: posted.reduce((s, e) => s + e.holderCashDebitCents, 0),
      unbalancedEntries: entries.filter((e) => e.debitCents !== e.creditCents).map((e) => e.entryId),
      missingEntryIds: ids.filter((i) => !byEntry.has(i)),
    };
  },

  async _fiat(payments) {
    const out = { available: true, distributions: [], settlements: [], settledCents: 0, pendingCents: 0 };
    const entryIds = new Set(payments.items.filter((p) => p.status === 'sent_to_bank').map((p) => p.holderEntryId).filter(Boolean));
    if (FixedIncomeDistributionEngine && entryIds.size) {
      try {
        const all = await FixedIncomeDistributionEngine.list({ limit: 1000 });
        out.distributions = all.filter((d) => entryIds.has(String(d.sourceEntryId))).map((d) => ({
          distributionId: d.distributionId, sourceEntryId: String(d.sourceEntryId), status: d.status, amountCents: cents(d.amountUsd), payee: d.payeeName || d.payee || null, fundingReference: d.fundingReference || null,
        }));
      } catch (e) { out.available = false; out.error = e.message; }
    }
    if (BankSettlementEngine) {
      try {
        const refs = new Set([...payments.items.map((p) => p.paymentId), ...out.distributions.map((d) => d.distributionId)]);
        const events = await BankSettlementEngine.list({ limit: 500 });
        out.settlements = events.filter((s) => refs.has(String(s.reference || ''))).map((s) => ({
          settlementId: s.settlementId, bankId: s.bankId, rail: s.rail, status: s.status, live: s.live, amountCents: Number(s.amountCents), reference: s.reference, providerReference: s.providerReference || null,
        }));
      } catch (e) { out.available = false; out.error = out.error || e.message; }
    }
    const settledStatuses = new Set(['settled', 'paid', 'completed', 'succeeded', 'sent']);
    for (const s of out.settlements) {
      if (settledStatuses.has(String(s.status))) out.settledCents += s.amountCents; else if (!/fail|reject|cancel/i.test(String(s.status))) out.pendingCents += s.amountCents;
    }
    return out;
  },

  async _custody() {
    if (!AttestationOsEngine) return { available: false };
    try {
      const snap = await AttestationOsEngine.snapshot();
      const fi = (snap.domains || []).find((d) => d.domain === 'fixed_income') || null;
      return {
        available: true, observedAt: snap.observedAt || null, sourcesObserved: snap.sourcesObserved || 0,
        fixedIncomeClaimedCents: fi ? Number(fi.claimedCents || 0) : null,
        fixedIncomeAttestedCents: fi ? Number(fi.attestedCents || 0) : null,
        totalAttestedCents: Number(snap.attestedCents || 0),
        totalClaimedCents: Number(snap.claimedCents || 0),
      };
    } catch (e) { return { available: false, error: e.message }; }
  },

  // ── the proof ──────────────────────────────────────────────────────────────

  async _assemble({ bondId }) {
    const scope = bondId == null ? 'portfolio' : 'bond';
    let contracts;
    if (scope === 'bond') contracts = [await this._contract(bondId)];
    else {
      const { rows } = await pool.query('SELECT bond_id FROM bond_issuances ORDER BY bond_id');
      contracts = [];
      for (const r of rows) contracts.push(await this._contract(Number(r.bond_id)));
    }
    const schedules = {};
    for (const c of contracts) schedules[c.bondId] = await this._schedule(c.bondId);
    const [payments, fineract, custody] = await Promise.all([this._payments(bondId), this._fineract(), this._custody()]);
    const [ledger, fiat] = await Promise.all([this._ledger(payments), this._fiat(payments)]);

    // Held value of record for this scope, and everything the holder account must cover overall.
    const scopeHeld = payments.heldCents;
    let portfolioHeld = scopeHeld;
    if (scope === 'bond') portfolioHeld = (await this._payments(null)).heldCents;

    const checks = [];
    for (const c of contracts) {
      checks.push({ name: `issued:${c.bondId}`, verdict: c.issued && c.issuanceStatus === 'issued' && c.bondStatus === 'active' ? 'proven' : 'variance', source: 'bond_issuances', note: c.issued ? `issuance ${c.issuanceStatus}, bond ${c.bondStatus}` : 'bond not issued issuer -> holder' });
    }
    const couponEntriesExpected = payments.items.filter((p) => p.kind === 'coupon' && p.status !== 'failed').reduce((s, p) => s + p.amountCents, 0);
    checks.push(check('fineract_deposit_ids', {
      expectedCents: payments.items.filter((p) => p.status !== 'failed').length,
      actualCents: payments.items.filter((p) => p.status !== 'failed' && p.fineractWithdrawalId && p.fineractDepositId).length,
      source: 'bond_issuance_payments', note: 'every booked payment carries its Fineract withdrawal and deposit ids',
    }));
    checks.push(check('fineract_holder_covers_held', {
      expectedCents: portfolioHeld,
      actualCents: fineract.holder && fineract.holder.balanceCents != null ? Math.min(fineract.holder.balanceCents, portfolioHeld) : null,
      source: 'fineract:holder', note: fineract.holder && fineract.holder.balanceCents != null ? `holder balance ${fineract.holder.balanceCents} covers held ${portfolioHeld}` : (fineract.error || 'holder account not provisioned'),
    }));
    checks.push(check('ledger_holder_cash_matches_coupons', {
      expectedCents: couponEntriesExpected,
      actualCents: ledger.available ? ledger.holderCashDebitCents : null,
      source: `trust_journal_lines:${ledger.cashAccount || this.config().holderCashAccount}`,
      note: ledger.missingEntryIds && ledger.missingEntryIds.length ? `missing journal entries: ${ledger.missingEntryIds.join(',')}` : null,
    }));
    if (ledger.unbalancedEntries && ledger.unbalancedEntries.length) {
      checks.push({ name: 'ledger_entries_balanced', verdict: 'variance', source: 'trust_journal_lines', note: `unbalanced: ${ledger.unbalancedEntries.join(',')}` });
    }
    if (payments.sentToBankCents > 0) {
      checks.push(check('fiat_settled_for_sent_to_bank', {
        expectedCents: payments.sentToBankCents, actualCents: fiat.available ? fiat.settledCents : null, source: 'settlement_bank_events',
        note: fiat.pendingCents ? `pending at bank: ${fiat.pendingCents}` : null,
      }));
    }

    const recordVerdict = worst(checks);
    const contractValueCents = contracts.reduce((s, c) => s + c.faceValueCents, 0);
    return {
      scope, bondId: bondId == null ? null : Number(bondId), asOf: new Date().toISOString(),
      verdict: recordVerdict,
      recordOfValue: { verdict: recordVerdict, checks, heldCents: scopeHeld, portfolioHeldCents: portfolioHeld, couponCents: payments.couponCents, principalCents: payments.principalCents, sentToBankCents: payments.sentToBankCents, awaitingExternalCents: payments.awaitingExternalCents, failedCents: payments.failedCents },
      fiatCustody: {
        settledCents: fiat.settledCents, pendingCents: fiat.pendingCents,
        custodyAttestedCents: custody.available ? custody.totalAttestedCents : null,
        note: 'Held value lives in the holder Fineract account of record; only settledCents has been converted to fiat at a bank, and only custodyAttestedCents is confirmed by an outside custodian.',
      },
      contractValueCents,
      contracts, schedules, payments, fineract, ledger, fiat, custody,
    };
  },

  async prove({ bondId = null, createdBy = null } = {}) {
    const cfg = this.config();
    if (!cfg.enabled) throw new ProofOfAssetError('proof of asset disabled', 'DISABLED', 503);
    await this.ensureTables();
    const evidence = await this._assemble({ bondId });
    const prev = await pool.query('SELECT hash FROM proof_of_asset_proofs ORDER BY created_at DESC, proof_id DESC LIMIT 1');
    const previousHash = prev.rows[0] ? prev.rows[0].hash : null;
    const id = proofId();
    const hash = sha256(canonical({ proofId: id, previousHash, evidence }));
    const { rows } = await pool.query(`
      INSERT INTO proof_of_asset_proofs (proof_id, scope, bond_id, as_of, verdict, contract_value_cents, record_of_value_cents, fineract_held_cents,
        fiat_settled_cents, custody_attested_cents, hash, previous_hash, evidence, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14) RETURNING *`,
    [id, evidence.scope, evidence.bondId, evidence.asOf, evidence.verdict, evidence.contractValueCents, evidence.recordOfValue.heldCents,
      evidence.fineract.holder ? evidence.fineract.holder.balanceCents : null, evidence.fiatCustody.settledCents, evidence.fiatCustody.custodyAttestedCents,
      hash, previousHash, JSON.stringify(evidence), createdBy]);
    schedulerState.lastRunAt = new Date().toISOString();
    return rowToProof(rows[0]);
  },

  async proveAll({ createdBy = 'scheduler' } = {}) {
    await this.ensureTables();
    const { rows } = await pool.query('SELECT bond_id FROM bond_issuances ORDER BY bond_id');
    const proofs = [];
    for (const r of rows) proofs.push(await this.prove({ bondId: Number(r.bond_id), createdBy }));
    proofs.push(await this.prove({ bondId: null, createdBy }));
    return proofs;
  },

  async get(id) {
    await this.ensureTables();
    const { rows } = await pool.query('SELECT * FROM proof_of_asset_proofs WHERE proof_id = $1', [id]);
    if (!rows[0]) throw new ProofOfAssetError(`proof ${id} not found`, 'NOT_FOUND', 404);
    return rowToProof(rows[0]);
  },

  async list({ bondId, scope, limit = 50 } = {}) {
    await this.ensureTables();
    const where = []; const params = [];
    if (bondId != null) { params.push(Number(bondId)); where.push(`bond_id = $${params.length}`); }
    if (scope) { params.push(scope); where.push(`scope = $${params.length}`); }
    params.push(Math.min(Number(limit) || 50, 500));
    const { rows } = await pool.query(`SELECT * FROM proof_of_asset_proofs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return rows.map(rowToProof).map((p) => ({ ...p, evidence: undefined, checks: p.evidence.recordOfValue ? p.evidence.recordOfValue.checks : [] }));
  },

  async latest({ bondId = null } = {}) {
    await this.ensureTables();
    const { rows } = await pool.query(
      bondId == null ? `SELECT * FROM proof_of_asset_proofs WHERE scope = 'portfolio' ORDER BY created_at DESC LIMIT 1`
        : 'SELECT * FROM proof_of_asset_proofs WHERE bond_id = $1 ORDER BY created_at DESC LIMIT 1',
      bondId == null ? [] : [Number(bondId)]);
    return rowToProof(rows[0]);
  },

  /** Recompute the hash chain and report the first link that does not hold. */
  async verifyChain({ limit = 1000 } = {}) {
    await this.ensureTables();
    const { rows } = await pool.query('SELECT * FROM proof_of_asset_proofs ORDER BY created_at ASC, proof_id ASC LIMIT $1', [limit]);
    let previousHash = null;
    for (const row of rows) {
      const p = rowToProof(row);
      const expected = sha256(canonical({ proofId: p.proofId, previousHash: p.previousHash, evidence: p.evidence }));
      if (expected !== p.hash) return { valid: false, proofs: rows.length, brokenAt: p.proofId, reason: 'hash mismatch' };
      if (p.previousHash !== previousHash) return { valid: false, proofs: rows.length, brokenAt: p.proofId, reason: 'previous hash mismatch' };
      previousHash = p.hash;
    }
    return { valid: true, proofs: rows.length, headHash: previousHash };
  },

  async certify(id, { certifiedBy, signerName } = {}) {
    if (!certifiedBy) throw new ProofOfAssetError('certifiedBy required', 'CERTIFIER_REQUIRED', 400);
    const p = await this.get(id);
    if (p.certifiedBy) throw new ProofOfAssetError(`proof ${id} already certified by ${p.certifiedBy}`, 'ALREADY_CERTIFIED', 409);
    if (p.verdict !== 'proven') throw new ProofOfAssetError(`proof ${id} is ${p.verdict}; only proven proofs can be certified`, 'NOT_PROVEN', 409);
    const certifiedAt = new Date().toISOString();
    const signature = sha256(canonical({ hash: p.hash, certifiedBy, signerName: signerName || null, certifiedAt }));
    const { rows } = await pool.query(
      'UPDATE proof_of_asset_proofs SET certified_by = $2, certified_at = $3, certification_signature = $4 WHERE proof_id = $1 RETURNING *',
      [id, signerName ? `${signerName} <${certifiedBy}>` : certifiedBy, certifiedAt, signature]);
    return rowToProof(rows[0]);
  },

  async status() {
    const cfg = this.config();
    await this.ensureTables();
    const latest = await this.latest();
    const counts = await pool.query('SELECT verdict, COUNT(*)::int AS n FROM proof_of_asset_proofs GROUP BY verdict');
    const issues = [];
    if (!BondIssuanceEngine) issues.push('BondIssuanceEngine unavailable');
    if (!FineractClient) issues.push('FineractClient unavailable');
    if (!latest) issues.push('no portfolio proof yet (POST /api/proof-of-asset/proofs)');
    else if (latest.verdict !== 'proven') issues.push(`latest portfolio proof is ${latest.verdict}`);
    return {
      enabled: cfg.enabled, ready: cfg.enabled && issues.length === 0, issues,
      scheduler: { ...schedulerState, intervalMinutes: cfg.intervalMinutes },
      latest: latest ? { proofId: latest.proofId, verdict: latest.verdict, asOf: latest.asOf, recordOfValueCents: latest.recordOfValueCents, fineractHeldCents: latest.fineractHeldCents, fiatSettledCents: latest.fiatSettledCents, hash: latest.hash, certifiedBy: latest.certifiedBy } : null,
      counts: counts.rows.map((r) => ({ verdict: r.verdict, count: r.n })),
      layers: ['contract (bonds/bond_issuances)', 'schedule (LiveBondEngine)', 'record (bond_issuance_payments)', 'fineract (holder/issuer accounts of record)', 'ledger (trust_journal_entries)', 'fiat (distributions/settlements -> Lili)', 'custody (AttestationOs)'],
    };
  },
};

module.exports = { ProofOfAssetOsEngine, ProofOfAssetError, VERDICTS, SCOPES };
