'use strict';

/**
 * Credit OS Engine — control tower for outbound credits (treasury → bank) and
 * the ledgers that must agree before one is allowed to leave the platform.
 *
 * It does not move money. It answers, from the GCP-hosted ledgers:
 *   fundingSources()   which real-value origination sources exist (Stripe Treasury,
 *                      Skrill, bank ODFI channel) and whether each is live + funded
 *   ledgerValidation() trust GL trial balance, Fineract GL tie-out, open discrepancies
 *   creditPipeline()   lili_direct_deposits / ach_batches by status, incl. credits
 *                      marked transmitted that no bank has ever confirmed
 *   gate(amountCents)  can a credit of this size be originated honestly right now?
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

function tryRequire(mod) {
  try { return require(mod); } catch (e) { return null; }
}

async function settle(fn) {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: e.message }; }
}

function stripeKeyMode(key) {
  const k = String(key || '').trim();
  if (!k) return null;
  if (k.startsWith('sk_live_') || k.startsWith('rk_live_')) return 'live';
  if (k.startsWith('sk_test_') || k.startsWith('rk_test_')) return 'test';
  return 'unknown';
}

async function countBy(table, column, where = '', params = []) {
  if (!pool) return {};
  try {
    const res = await pool.query(`SELECT ${column} AS k, COUNT(*)::int AS n FROM ${table} ${where} GROUP BY ${column}`, params);
    const out = {};
    for (const r of res.rows) out[r.k || 'null'] = r.n;
    return out;
  } catch (e) {
    return { error: e.message };
  }
}

const TABLES = ['lili_direct_deposits', 'lili_payments', 'ach_batches', 'trust_accounts', 'trust_journal_entries', 'data_bridge_discrepancies', 'os_events'];

class CreditOsEngine {
  static get engineName() { return 'credit'; }
  static get TABLES() { return TABLES; }

  // ── Funding sources ─────────────────────────────────────────────────────

  static async fundingSources() {
    const env = process.env;
    const sources = [];

    const stripeMode = stripeKeyMode(env.STRIPE_SECRET_KEY);
    const stripeFa = Boolean((env.STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID || '').trim());
    sources.push({
      id: 'stripe_treasury',
      name: 'Stripe Treasury financial account',
      configured: Boolean(stripeMode) && stripeFa,
      mode: stripeMode,
      realValueCapable: stripeMode === 'live' && stripeFa,
      reason: !stripeMode ? 'STRIPE_SECRET_KEY not set'
        : stripeMode === 'test' ? 'test-mode key (sandbox): test dollars only, cannot reach an external bank'
          : !stripeFa ? 'STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID not set'
            : 'live key + financial account configured (balance must be funded)',
      secrets: ['STRIPE_SECRET_KEY', 'STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID'],
    });

    const Skrill = tryRequire('../payments/skrillLinkEngine')?.SkrillLinkEngine;
    const skrill = Skrill ? Skrill.readiness() : { ready: false, missing: ['SKRILL_MERCHANT_EMAIL', 'SKRILL_API_PASSWORD'], capabilities: {} };
    sources.push({
      id: 'skrill',
      name: 'Skrill merchant wallet',
      configured: skrill.ready,
      mode: skrill.ready ? 'live' : null,
      realValueCapable: false,
      reason: skrill.ready
        ? 'Automated Payments API sends Skrill-to-Skrill only; Skrill → bank withdrawal is a manual operator step'
        : `${(skrill.missing || []).join(', ')} not configured`,
      capabilities: skrill.capabilities,
      secrets: ['SKRILL_MERCHANT_EMAIL', 'SKRILL_API_PASSWORD'],
    });

    const Lili = tryRequire('../payments/liliDirectDepositEngine')?.LiliDirectDepositEngine;
    const odfi = Lili ? await settle(() => Lili.odfiStatus()) : { ok: false, error: 'LiliDirectDepositEngine unavailable' };
    const odfiValue = odfi.ok ? odfi.value : { ready: false, channels: [], loopback: [], blocker: odfi.error };
    sources.push({
      id: 'bank_odfi',
      name: 'Bank ODFI channel (AS2 / MFT / SFTP / REST)',
      configured: odfiValue.channels.length > 0 || (odfiValue.loopback || []).length > 0,
      mode: odfiValue.ready ? 'live' : ((odfiValue.loopback || []).length ? 'loopback' : null),
      realValueCapable: Boolean(odfiValue.ready),
      reason: odfiValue.ready ? `external channel(s): ${odfiValue.channels.join(', ')}` : odfiValue.blocker,
      channels: odfiValue.channels,
      loopback: odfiValue.loopback || [],
    });

    const capable = sources.filter(s => s.realValueCapable).map(s => s.id);
    return { sources, realValueCapable: capable, anyRealValueCapable: capable.length > 0 };
  }

  // ── Ledger validation ───────────────────────────────────────────────────

  static async ledgerValidation() {
    const Trust = tryRequire('../accounting/trustAccountingEngine')?.TrustAccountingEngine;
    const Fineract = tryRequire('../fineract/fineractClient')?.FineractClient;

    const trial = Trust && pool ? await settle(() => Trust.getTrialBalance()) : { ok: false, error: 'TrustAccountingEngine / ledger unavailable' };
    const fineract = Fineract ? await settle(() => Fineract.healthCheck()) : { ok: false, error: 'FineractClient unavailable' };

    let openDiscrepancies = null;
    if (pool) {
      try {
        const r = await pool.query(`SELECT COUNT(*)::int AS n FROM data_bridge_discrepancies WHERE COALESCE(status, 'open') NOT IN ('resolved', 'closed', 'dismissed')`);
        openDiscrepancies = r.rows[0].n;
      } catch (e) { openDiscrepancies = null; }
    }

    const issues = [];
    if (!trial.ok) issues.push(`trust GL: ${trial.error}`);
    else if (!trial.value.is_balanced) issues.push(`trust GL trial balance out of balance (debits ${trial.value.total_debits} vs credits ${trial.value.total_credits})`);
    if (!fineract.ok) issues.push(`Fineract GL: ${fineract.error}`);
    if (openDiscrepancies) issues.push(`${openDiscrepancies} open ledger discrepancy(ies) in data_bridge_discrepancies`);

    return {
      valid: issues.length === 0,
      trustGl: trial.ok
        ? { balanced: trial.value.is_balanced, accounts: (trial.value.accounts || []).length, totalDebits: trial.value.total_debits, totalCredits: trial.value.total_credits, asOf: trial.value.as_of_date }
        : { error: trial.error },
      fineractGl: fineract.ok
        ? { connected: true, offices: Array.isArray(fineract.value.offices) ? fineract.value.offices.length : null, urlConfigured: Boolean(process.env.FINERACT_URL) }
        : { connected: false, error: fineract.error, urlConfigured: Boolean(process.env.FINERACT_URL) },
      openDiscrepancies,
      issues,
    };
  }

  // ── Credit pipeline ─────────────────────────────────────────────────────

  static async creditPipeline() {
    const deposits = await countBy('lili_direct_deposits', 'status');
    const batches = await countBy('ach_batches', 'status');
    let unverified = [];
    if (pool) {
      try {
        const r = await pool.query(
          `SELECT deposit_id, amount_cents, ach_batch_id, status, created_at
             FROM lili_direct_deposits
            WHERE status = 'transmitted' AND lili_transaction_id IS NULL
            ORDER BY created_at DESC LIMIT 50`
        );
        unverified = r.rows;
      } catch (e) { /* table absent → reported via tables */ }
    }
    return {
      direction: 'treasury (ODFI, debtor) → Lili business checking (RDFI, creditor)',
      deposits,
      achBatches: batches,
      unverifiedTransmitted: unverified.length,
      unverified,
      note: unverified.length
        ? 'transmitted but never confirmed by a bank (no lili_transaction_id) — treat as not delivered'
        : null,
    };
  }

  // ── Gate ────────────────────────────────────────────────────────────────

  static async gate(amountCents = 0) {
    const [funding, ledger] = await Promise.all([this.fundingSources(), this.ledgerValidation()]);
    const blockers = [];
    if (!funding.anyRealValueCapable) blockers.push('no funded real-value origination source (Stripe Treasury is test-mode, Skrill cannot push to bank, bank ODFI is loopback/unset)');
    blockers.push(...ledger.issues);
    return {
      amountCents: Number(amountCents) || 0,
      allowed: blockers.length === 0,
      blockers,
      fundingSources: funding.realValueCapable,
      ledgerValid: ledger.valid,
      approvalThreshold: Number(process.env.PAYMENT_APPROVAL_THRESHOLD || 2),
    };
  }

  // ── Status ──────────────────────────────────────────────────────────────

  static async status() {
    const [funding, ledger, pipeline] = await Promise.all([this.fundingSources(), this.ledgerValidation(), this.creditPipeline()]);
    return {
      engine: 'credit',
      healthy: true,
      mode: funding.anyRealValueCapable && ledger.valid ? 'live' : 'validation-only',
      realValueCapable: funding.anyRealValueCapable,
      fundingSources: funding.sources,
      ledger,
      pipeline,
      timestamp: new Date().toISOString(),
    };
  }
}

module.exports = { CreditOsEngine };
