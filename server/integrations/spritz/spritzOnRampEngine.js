'use strict';

/**
 * SpritzOnRampEngine — the leg that turns Treasury-Core ERP bucket cash into
 * real USDC in the thirdweb treasury server wallet, through Spritz's ACH-debit
 * on-ramp (Plaid-linked funding source -> direct deposit to a wallet address).
 *
 *   ERP bucket cash (1020 coupon / 1030 operating, canonical in Fineract)
 *     --(maker/checker proposal, category spritz_on_ramp)-->
 *   Spritz direct deposit: debit the trust's linked bank, deliver USDC to the
 *   thirdweb server wallet on Base
 *     --(CanonicalFundingSource.commit: Dr 1025|1035 wallet USDC / Cr 1020|1030)-->
 *   wallet USDC now backs the bucket; the erp_treasury route (CanonicalMoneyEngine)
 *   draws from 1025|1035 when it deposits USDC to the policy contract.
 *
 * Segregation: every on-ramp is bucket-tagged; the credit is always the bucket's
 * own cash account and the debit its own wallet account, so coupon income and
 * trust operating never share a GL line or a wallet balance on the books.
 *
 * Nothing is debited unless SPRITZ_ONRAMP_LIVE=true; otherwise the deposit is
 * only prepared (a Spritz quote) and the request records a shadow result.
 */

const { SpritzEngine } = require('./spritzEngine');
const { TrustAllocationEngine } = require('../dapp/trustAllocationEngine');

let CanonicalFundingSource;
try { ({ CanonicalFundingSource } = require('../fineract/canonicalFundingSource')); } catch (e) { CanonicalFundingSource = null; }
let ThirdwebServerWalletEngine;
try { ({ ThirdwebServerWalletEngine } = require('../dapp/thirdwebServerWalletEngine')); } catch (e) { ThirdwebServerWalletEngine = null; }
let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const TABLE = 'spritz_on_ramps';
const CATEGORY = 'spritz_on_ramp';
const STATUSES = ['proposed', 'submitted', 'completed', 'failed', 'cancelled'];
const FINAL_DEPOSIT_OK = new Set(['completed', 'complete', 'settled', 'succeeded', 'success']);
const FINAL_DEPOSIT_BAD = new Set(['failed', 'returned', 'cancelled', 'canceled', 'rejected', 'error']);

let tableReady = false;

function str(name, def = '') { return (process.env[name] || def).trim(); }
function bool(name, def) { const v = str(name); return v ? !['0', 'false', 'no', 'off'].includes(v.toLowerCase()) : def; }
function id() { return `SOR-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

function consensus() {
  const { CanonicalConsensusEngine } = require('../dapp/canonicalConsensusEngine');
  return CanonicalConsensusEngine;
}

async function ensureTable() {
  if (tableReady || !pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      on_ramp_id         TEXT PRIMARY KEY,
      reference          TEXT NOT NULL UNIQUE,
      bucket             TEXT NOT NULL,
      cash_account       TEXT NOT NULL,
      wallet_account     TEXT NOT NULL,
      amount_usd         NUMERIC(18,2) NOT NULL,
      funding_source_id  TEXT,
      wallet_address     TEXT,
      network            TEXT,
      proposal_id        TEXT,
      preparation_id     TEXT,
      deposit_id         TEXT,
      deposit_status     TEXT,
      journal_entry_id   TEXT,
      status             TEXT NOT NULL DEFAULT 'proposed'
                           CHECK (status IN ('proposed','submitted','completed','failed','cancelled')),
      shadow             BOOLEAN NOT NULL DEFAULT FALSE,
      error              TEXT,
      created_by         TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at       TIMESTAMPTZ
    )
  `);
  tableReady = true;
}

function row(r) {
  if (!r) return null;
  return {
    onRampId: r.on_ramp_id,
    reference: r.reference,
    bucket: r.bucket,
    cashAccount: r.cash_account,
    walletAccount: r.wallet_account,
    amountUsd: Number(r.amount_usd),
    fundingSourceId: r.funding_source_id,
    walletAddress: r.wallet_address,
    network: r.network,
    proposalId: r.proposal_id,
    preparationId: r.preparation_id,
    depositId: r.deposit_id,
    depositStatus: r.deposit_status,
    journalEntryId: r.journal_entry_id,
    status: r.status,
    shadow: Boolean(r.shadow),
    error: r.error,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  };
}

function maskSource(s) {
  if (!s) return null;
  return {
    id: s.id || s.sourceId || s.fundingSourceId || null,
    status: s.status || null,
    institution: (s.institution && s.institution.name) || s.institutionName || s.bankName || null,
    label: s.label || s.name || null,
    last4: s.last4 || s.mask || (s.accountNumberLast4) || null,
    type: s.type || s.accountType || s.subtype || null,
  };
}

class SpritzOnRampEngine {
  static config() {
    return {
      enabled: bool('SPRITZ_ONRAMP_ENABLED', true),
      live: bool('SPRITZ_ONRAMP_LIVE', false),
      fundingSourceId: str('SPRITZ_ONRAMP_FUNDING_SOURCE_ID'),
      priority: str('SPRITZ_ONRAMP_PRIORITY', 'normal'),
      maxAmountUsd: Number(str('SPRITZ_ONRAMP_MAX_AMOUNT_USD', '0')) || 0,
    };
  }

  static async ensureTables() { await ensureTable(); }

  static async _wallet() {
    if (!ThirdwebServerWalletEngine) throw httpError(503, 'ThirdwebServerWalletEngine not available', 'WALLET_UNAVAILABLE');
    const cfg = ThirdwebServerWalletEngine.getConfig();
    const address = await ThirdwebServerWalletEngine.resolveAddress();
    const network = SpritzEngine.chainName(cfg.chainId);
    if (!network) throw httpError(409, `chain ${cfg.chainId} has no Spritz network mapping`, 'SPRITZ_NETWORK_UNSUPPORTED');
    return { address, chainId: cfg.chainId, network };
  }

  /** The Plaid-linked bank Spritz debits: pinned by id, else the single linked source. */
  static async fundingSource() {
    const cfg = this.config();
    const sources = await SpritzEngine.listFundingSources();
    const list = Array.isArray(sources) ? sources : (sources && (sources.data || sources.items)) || [];
    if (cfg.fundingSourceId) {
      const pinned = list.find((s) => String(s.id || s.sourceId) === cfg.fundingSourceId);
      if (!pinned) throw httpError(409, `SPRITZ_ONRAMP_FUNDING_SOURCE_ID ${cfg.fundingSourceId} is not a linked Spritz funding source`, 'ONRAMP_SOURCE_MISSING');
      return { source: pinned, sources: list };
    }
    if (list.length === 1) return { source: list[0], sources: list };
    if (!list.length) throw httpError(409, 'no Spritz funding source linked (link the trust bank via Plaid in Spritz, then set SPRITZ_ONRAMP_FUNDING_SOURCE_ID)', 'ONRAMP_SOURCE_MISSING');
    throw httpError(409, `${list.length} Spritz funding sources linked; pin one with SPRITZ_ONRAMP_FUNDING_SOURCE_ID`, 'ONRAMP_SOURCE_AMBIGUOUS');
  }

  static async readiness() {
    const cfg = this.config();
    const issues = [];
    if (!cfg.enabled) issues.push('SPRITZ_ONRAMP_ENABLED=false');
    if (!str('SPRITZ_API_KEY')) issues.push('SPRITZ_API_KEY not configured');
    if (!CanonicalFundingSource) issues.push('CanonicalFundingSource not available');

    let wallet = null;
    try { wallet = await this._wallet(); } catch (e) { issues.push(e.message); }

    let capability = null;
    let source = null;
    let sources = [];
    let limits = null;
    if (str('SPRITZ_API_KEY')) {
      try {
        const caps = await SpritzEngine.capabilities();
        capability = caps.find((c) => c.product === 'fiat_to_crypto' && c.method === 'ach_debit') || null;
        if (!capability) issues.push('Spritz ACH debit on-ramp not offered on this account');
        else if (capability.status !== 'active') issues.push(`Spritz ACH debit on-ramp is ${capability.status}`);
      } catch (e) { issues.push(`Spritz capabilities: ${e.message}`); }
      try {
        const fs = await this.fundingSource();
        source = fs.source;
        sources = fs.sources;
        const sid = source.id || source.sourceId;
        limits = await SpritzEngine.getFundingSourceDepositLimits(sid).catch(() => null);
      } catch (e) {
        issues.push(e.message);
        try { sources = await SpritzEngine.listFundingSources(); } catch (_) { sources = []; }
      }
    }

    const buckets = [];
    for (const b of TrustAllocationEngine.buckets()) {
      const cash = TrustAllocationEngine.glAccountCode(b.key);
      const walletGl = TrustAllocationEngine.walletGlAccountCode(b.key);
      const entry = { bucket: b.key, cashAccount: cash, walletAccount: walletGl, cash: null, wallet: null };
      if (!cash) issues.push(`${b.key}: ${b.glEnv} not configured`);
      if (CanonicalFundingSource) {
        if (cash) entry.cash = await CanonicalFundingSource.position({ accountCode: cash, purpose: `${b.key} on-ramp` }).catch((e) => ({ error: e.message }));
        entry.wallet = await CanonicalFundingSource.position({ accountCode: walletGl, purpose: `${b.key} wallet` }).catch((e) => ({ error: e.message }));
        if (entry.wallet && entry.wallet.glAccountId === null) issues.push(`${b.key}: wallet GL ${walletGl} not mapped in Fineract (run trust:funding-buckets)`);
      }
      buckets.push(entry);
    }

    return {
      provider: 'spritz-on-ramp',
      ready: issues.length === 0,
      live: cfg.live,
      issues,
      wallet,
      capability: capability ? { status: capability.status } : null,
      fundingSource: maskSource(source),
      fundingSources: (Array.isArray(sources) ? sources : []).map(maskSource),
      depositLimits: limits,
      buckets,
      segregation: 'each on-ramp credits its bucket cash (1020/1030) and debits that bucket\'s wallet USDC account (1025/1035); buckets never share a line',
    };
  }

  /** Price a deposit without debiting anything (Spritz "prepare"). */
  static async quote({ amountUsd, bucket } = {}) {
    const cfg = this.config();
    const b = TrustAllocationEngine.bucket(bucket);
    const amount = Number(amountUsd);
    if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, 'amountUsd must be a positive number', 'BAD_REQUEST');
    if (cfg.maxAmountUsd && amount > cfg.maxAmountUsd) throw httpError(409, `amount exceeds SPRITZ_ONRAMP_MAX_AMOUNT_USD ${cfg.maxAmountUsd}`, 'ONRAMP_LIMIT');
    const cash = TrustAllocationEngine.glAccountCode(b.key);
    if (!cash) throw httpError(409, `${b.glEnv} not configured`, 'ALLOCATION_SOURCE_MISMATCH');
    const walletGl = TrustAllocationEngine.walletGlAccountCode(b.key);
    if (!CanonicalFundingSource) throw httpError(503, 'CanonicalFundingSource not available', 'ERP_UNAVAILABLE');
    const position = await CanonicalFundingSource.assertAvailable({ amountUsd: amount, accountCode: cash, purpose: `${b.key} on-ramp` });
    const wallet = await this._wallet();
    const { source } = await this.fundingSource();
    const sourceId = source.id || source.sourceId;
    const preparation = await SpritzEngine.prepareDirectDeposit({
      sourceId, address: wallet.address, network: wallet.network, asset: 'USDC', amountUsd: amount, quoteType: 'exact_input', priority: cfg.priority,
    });
    return {
      bucket: b.key, amountUsd: amount, cashAccount: cash, walletAccount: walletGl,
      wallet, fundingSource: maskSource(source), position: { availableBalanceCents: position.availableBalanceCents, canonicalBalanceCents: position.canonicalBalanceCents },
      preparation, live: cfg.live,
    };
  }

  /**
   * Raise a maker/checker proposal to on-ramp `amountUsd` of a bucket's cash
   * into the treasury wallet. Idempotent on `reference`.
   */
  static async propose({ amountUsd, bucket, reference, createdBy, autoApprove = false } = {}) {
    await ensureTable();
    if (!reference) throw httpError(400, 'reference required', 'BAD_REQUEST');
    const cfg = this.config();
    if (!cfg.enabled) throw httpError(409, 'SPRITZ_ONRAMP_ENABLED=false', 'ONRAMP_DISABLED');
    const existing = await this.byReference(reference);
    if (existing) return { ...existing, idempotent: true };

    const q = await this.quote({ amountUsd, bucket });
    const onRampId = id();
    const proposal = await consensus().createProposal({
      category: CATEGORY,
      title: `Spritz on-ramp $${q.amountUsd.toFixed(2)} ${q.bucket} (${q.cashAccount} -> ${q.walletAccount} / wallet ${q.wallet.address})`,
      description: `ACH-debit the linked trust bank via Spritz and deliver USDC to the thirdweb treasury wallet on ${q.wallet.network}. Books Dr ${q.walletAccount} / Cr ${q.cashAccount} (canonical).`,
      payload: { onRampId, reference, bucket: q.bucket, amountUsd: q.amountUsd, cashAccount: q.cashAccount, walletAccount: q.walletAccount, walletAddress: q.wallet.address, network: q.wallet.network, fundingSourceId: q.fundingSource.id },
      createdBy: createdBy || 'operator',
      autoExecute: false,
    });
    await pool.query(
      `INSERT INTO ${TABLE} (on_ramp_id, reference, bucket, cash_account, wallet_account, amount_usd, funding_source_id, wallet_address, network, proposal_id, preparation_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [onRampId, reference, q.bucket, q.cashAccount, q.walletAccount, q.amountUsd, q.fundingSource.id, q.wallet.address, q.wallet.network, proposal.id, (q.preparation && (q.preparation.id || q.preparation.preparationId)) || null, createdBy || 'operator']
    );
    if (autoApprove && consensus().isApproved(proposal)) await consensus().executeProposal(proposal.id);
    return { ...(await this.get(onRampId)), proposal, quote: q.preparation };
  }

  static async approve({ proposalId, role, approverEmail }) {
    return consensus().approveProposal({ proposalId, role, approverEmail });
  }

  /** Consensus hook (category spritz_on_ramp): runs only once the checker approved. */
  static async _execute(proposal) {
    await ensureTable();
    const p = proposal.payload || {};
    const current = await this.get(p.onRampId);
    if (!current) throw httpError(404, `on-ramp ${p.onRampId} not found`, 'ONRAMP_NOT_FOUND');
    if (current.status !== 'proposed') return { status: current.status, onRampId: current.onRampId, idempotent: true };
    const cfg = this.config();
    try {
      // Segregation re-check at execution time: the bucket must still own both accounts.
      const owner = TrustAllocationEngine.bucketForSource({ sourceType: 'canonical', sourceAccountId: current.cashAccount });
      if (!owner || owner.key !== current.bucket || TrustAllocationEngine.walletGlAccountCode(owner.key) !== current.walletAccount) {
        throw httpError(409, `${current.cashAccount} -> ${current.walletAccount} is not the segregated pair of ${current.bucket}`, 'ALLOCATION_SOURCE_MISMATCH');
      }
      const wallet = await this._wallet();
      if (wallet.address.toLowerCase() !== String(current.walletAddress).toLowerCase()) {
        throw httpError(409, `treasury wallet changed since proposal (${current.walletAddress} -> ${wallet.address})`, 'ONRAMP_WALLET_MISMATCH');
      }
      const { source } = await this.fundingSource();
      const sourceId = String(source.id || source.sourceId);
      if (sourceId !== String(current.fundingSourceId)) {
        throw httpError(409, `funding source changed since proposal`, 'ONRAMP_SOURCE_MISMATCH');
      }
      const preparation = await SpritzEngine.prepareDirectDeposit({
        sourceId, address: wallet.address, network: wallet.network, asset: 'USDC', amountUsd: current.amountUsd, quoteType: 'exact_input', priority: cfg.priority,
      });
      const preparationId = preparation.id || preparation.preparationId;
      if (!cfg.live) {
        await pool.query(`UPDATE ${TABLE} SET preparation_id=$1, shadow=TRUE, updated_at=NOW() WHERE on_ramp_id=$2`, [preparationId, current.onRampId]);
        return { status: 'shadow', shadow: true, onRampId: current.onRampId, preparation, reason: 'SPRITZ_ONRAMP_LIVE=false' };
      }
      const deposit = await SpritzEngine.createDirectDeposit({ preparationId, idempotencyKey: current.reference });
      const depositId = deposit.id || deposit.depositId || null;
      const funding = await CanonicalFundingSource.commit({
        amountUsd: current.amountUsd,
        reference: current.reference,
        referenceType: CATEGORY,
        memo: `Spritz on-ramp ${current.bucket}: ${current.cashAccount} -> USDC in treasury wallet ${wallet.address}`,
        cashAccountCode: current.cashAccount,
        assetAccountCode: current.walletAccount,
        postedBy: 'spritz-on-ramp',
        purpose: `${current.bucket} on-ramp`,
      });
      await pool.query(
        `UPDATE ${TABLE} SET status='submitted', preparation_id=$1, deposit_id=$2, deposit_status=$3, journal_entry_id=$4, shadow=$5, updated_at=NOW() WHERE on_ramp_id=$6`,
        [preparationId, depositId, deposit.status || 'submitted', funding.journalEntryId || null, Boolean(funding.shadow), current.onRampId]
      );
      return { status: 'submitted', onRampId: current.onRampId, depositId, funding, journaledBy: 'canonical_funding_source' };
    } catch (e) {
      await pool.query(`UPDATE ${TABLE} SET status='failed', error=$1, updated_at=NOW() WHERE on_ramp_id=$2`, [e.message, current.onRampId]);
      throw e;
    }
  }

  /**
   * Follow submitted deposits: completed once Spritz settles the USDC into the
   * wallet; a returned/failed ACH reverses the ERP journal so the bucket cash is
   * whole again.
   */
  static async reconcile() {
    await ensureTable();
    const { rows } = await pool.query(`SELECT * FROM ${TABLE} WHERE status='submitted' ORDER BY created_at`);
    const results = [];
    for (const r of rows.map(row)) {
      try {
        const dep = await SpritzEngine.getDeposit(r.depositId);
        const st = String(dep.status || '').toLowerCase();
        if (FINAL_DEPOSIT_OK.has(st)) {
          await pool.query(`UPDATE ${TABLE} SET status='completed', deposit_status=$1, completed_at=NOW(), updated_at=NOW() WHERE on_ramp_id=$2`, [dep.status, r.onRampId]);
          results.push({ onRampId: r.onRampId, status: 'completed', depositStatus: dep.status });
        } else if (FINAL_DEPOSIT_BAD.has(st)) {
          let reversal = null;
          if (r.journalEntryId && CanonicalFundingSource) {
            reversal = await CanonicalFundingSource.reverse({ journalEntryId: r.journalEntryId, amountUsd: r.amountUsd, reference: r.reference, postedBy: 'spritz-on-ramp' }).catch((e) => ({ error: e.message }));
          }
          await pool.query(`UPDATE ${TABLE} SET status='failed', deposit_status=$1, error=$2, updated_at=NOW() WHERE on_ramp_id=$3`, [dep.status, `deposit ${dep.status}`, r.onRampId]);
          results.push({ onRampId: r.onRampId, status: 'failed', depositStatus: dep.status, reversal });
        } else {
          await pool.query(`UPDATE ${TABLE} SET deposit_status=$1, updated_at=NOW() WHERE on_ramp_id=$2`, [dep.status || null, r.onRampId]);
          results.push({ onRampId: r.onRampId, status: 'submitted', depositStatus: dep.status });
        }
      } catch (e) {
        results.push({ onRampId: r.onRampId, status: r.status, error: e.message });
      }
    }
    return { checked: rows.length, results };
  }

  static async cancel({ onRampId, reason } = {}) {
    await ensureTable();
    const r = await this.get(onRampId);
    if (!r) throw httpError(404, `on-ramp ${onRampId} not found`, 'ONRAMP_NOT_FOUND');
    if (r.status !== 'proposed') throw httpError(409, `on-ramp ${onRampId} is ${r.status}; only proposed on-ramps can be cancelled`, 'ONRAMP_STATE');
    if (r.proposalId) await consensus().rejectProposal({ proposalId: r.proposalId, role: 'system', rejectorEmail: 'system', reason: reason || 'cancelled' }).catch(() => null);
    await pool.query(`UPDATE ${TABLE} SET status='cancelled', error=$1, updated_at=NOW() WHERE on_ramp_id=$2`, [reason || null, onRampId]);
    return this.get(onRampId);
  }

  static async byReference(reference) {
    await ensureTable();
    const { rows } = await pool.query(`SELECT * FROM ${TABLE} WHERE reference=$1`, [reference]);
    return row(rows[0]);
  }

  static async get(onRampId) {
    await ensureTable();
    const { rows } = await pool.query(`SELECT * FROM ${TABLE} WHERE on_ramp_id=$1`, [onRampId]);
    return row(rows[0]);
  }

  static async list({ status = null, bucket = null, limit = 100 } = {}) {
    await ensureTable();
    const where = [];
    const params = [];
    if (status) { if (!STATUSES.includes(status)) throw httpError(400, `unknown status ${status}`, 'BAD_REQUEST'); params.push(status); where.push(`status=$${params.length}`); }
    if (bucket) { params.push(TrustAllocationEngine.bucket(bucket).key); where.push(`bucket=$${params.length}`); }
    params.push(Number(limit) || 100);
    const { rows } = await pool.query(`SELECT * FROM ${TABLE}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return rows.map(row);
  }

  static async summary() {
    await ensureTable();
    const { rows } = await pool.query(`SELECT bucket, status, COUNT(*)::int AS n, COALESCE(SUM(amount_usd),0) AS usd FROM ${TABLE} GROUP BY bucket, status ORDER BY bucket, status`);
    return rows.map((r) => ({ bucket: r.bucket, status: r.status, count: r.n, amountUsd: Number(r.usd) }));
  }
}

module.exports = { SpritzOnRampEngine, SPRITZ_ON_RAMP_CATEGORY: CATEGORY };
