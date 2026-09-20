#!/usr/bin/env node
'use strict';

/**
 * Send a small test direct deposit into the Lili account for every PTC member
 * sub-ledger context (beneficiary Trust Sub-Ledgers, Trustee Compensation and
 * Trustee Fees sub-ledgers seeded by PtcPortalEngine.ensureSubLedgerAccounts).
 *
 *   node scripts/lili-sub-ledger-test-deposits.cjs [--amount=1.00] [--dry-run]
 *       [--only=beneficiary|trustee] [--skip-transmit] [--skip-reconcile]
 *
 * Fails closed: nothing is created unless LiliDirectDepositEngine reports a
 * configured destination (LILI_DD_ROUTING_NUMBER / LILI_DD_ACCOUNT_NUMBER) and
 * at least one ODFI channel (AS2 / MFT / production partner / SFTP). After the
 * deposits are created, queued batches are transmitted and reconciled against
 * the Lili MCP transaction feed when it is configured.
 *
 * Env: DATABASE_URL (Postgres) plus the Lili / ODFI settings above.
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');
const { LiliDirectDepositEngine } = require(path.join(ROOT, 'server', 'integrations', 'payments', 'liliDirectDepositEngine'));
const { SubLedgerEngine } = require(path.join(ROOT, 'server', 'integrations', 'accounting', 'subLedgerEngine'));
const { PtcPortalEngine, SUB_LEDGER_PLAN } = require(path.join(ROOT, 'server', 'integrations', 'dapp', 'ptcPortalEngine'));

const DEFAULT_AMOUNT = 1.0;

function parseArgs(argv = process.argv.slice(2)) {
  const get = (name, def) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : def;
  };
  const has = (name) => argv.includes(`--${name}`);
  const amount = Number(get('amount', DEFAULT_AMOUNT));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('--amount must be a positive USD amount');
  const only = get('only', 'all');
  if (!['all', 'beneficiary', 'trustee'].includes(only)) throw new Error('--only must be beneficiary, trustee or all');
  return {
    amount,
    only,
    dryRun: has('dry-run'),
    skipTransmit: has('skip-transmit'),
    skipReconcile: has('skip-reconcile'),
  };
}

/** Classify a sub-ledger row against the seeded plan; null when it is not a PTC member ledger. */
function planFor(subLedger) {
  return Object.values(SUB_LEDGER_PLAN).find((p) =>
    p.parentAccountCode === String(subLedger.parent_account_code) && p.subAccountType === String(subLedger.sub_account_type)
  ) || null;
}

/**
 * Build one deposit context per seeded sub-ledger: the sub-ledger id is the
 * sourceAccountId and the memo names the member + ledger so the deposit can
 * be traced back from Lili / the ACH register.
 */
function buildDepositContexts(subLedgers, { amount = DEFAULT_AMOUNT, only = 'all' } = {}) {
  const contexts = [];
  for (const sl of subLedgers || []) {
    if (sl.status && sl.status !== 'active') continue;
    const plan = planFor(sl);
    if (!plan) continue;
    if (only === 'beneficiary' && plan.memberRole !== 'beneficiary') continue;
    if (only === 'trustee' && plan.memberRole !== 'trustee') continue;
    const member = `${sl.first_name || ''} ${sl.last_name || ''}`.trim() || sl.contact_id;
    contexts.push({
      subLedgerId: sl.sub_ledger_id,
      contactId: sl.contact_id,
      member,
      plan: plan.key,
      label: plan.label,
      parentAccountCode: plan.parentAccountCode,
      subAccountType: plan.subAccountType,
      amount,
      sourceAccountId: sl.sub_ledger_id,
      memo: `LILI TEST ${plan.label} — ${member} (${sl.sub_ledger_id})`,
      paymentType: plan.memberRole === 'trustee' ? 'trustee_fee' : 'trust_distribution',
    });
  }
  return contexts;
}

/**
 * Check destination + ODFI readiness. Returns { ready, reason, status, destination }.
 */
async function checkReadiness(engine = LiliDirectDepositEngine) {
  const status = await engine.getWorkflowStatus();
  const destination = await engine.getDestination();
  if (!destination.configured) {
    return { ready: false, status, destination, reason: 'Lili destination account not configured (set LILI_DD_ROUTING_NUMBER / LILI_DD_ACCOUNT_NUMBER)' };
  }
  if (!status.odfi || !status.odfi.ready) {
    return { ready: false, status, destination, reason: 'No ODFI channel configured (AS2 / MFT / production partner / SFTP) — deposits would only queue' };
  }
  return { ready: true, status, destination, reason: null };
}

/**
 * Create the test deposits, then transmit + reconcile. Injectable deps keep
 * this unit-testable without a database.
 */
async function runTestDeposits(options = {}, deps = {}) {
  const engine = deps.engine || LiliDirectDepositEngine;
  const subLedgerEngine = deps.subLedgerEngine || SubLedgerEngine;
  const ptcEngine = deps.ptcEngine || PtcPortalEngine;
  const log = deps.log || ((...a) => console.log(...a));
  const opts = { amount: DEFAULT_AMOUNT, only: 'all', dryRun: false, skipTransmit: false, skipReconcile: false, ...options };

  const readiness = await checkReadiness(engine);
  const summary = {
    ready: readiness.ready,
    skipped: !readiness.ready,
    reason: readiness.reason,
    destination: { configured: readiness.destination.configured, routingNumber: readiness.destination.routingNumber, accountNumberMasked: readiness.destination.accountNumberMasked },
    odfi: readiness.status.odfi,
    contexts: [],
    deposits: [],
    transmit: null,
    reconcile: null,
  };

  if (!readiness.ready) {
    log(`[lili-test-deposits] SKIPPED — ${readiness.reason}`);
    log(`[lili-test-deposits] destination configured: ${readiness.destination.configured}; ODFI ready: ${Boolean(readiness.status.odfi && readiness.status.odfi.ready)}`);
    return summary;
  }

  if (opts.ensureSeed !== false && ptcEngine && ptcEngine.ensureSubLedgerAccounts) {
    await ptcEngine.ensureSubLedgerAccounts();
  }
  const subLedgers = await subLedgerEngine.listSubLedgers({ status: 'active' });
  summary.contexts = buildDepositContexts(subLedgers, opts);
  if (!summary.contexts.length) {
    log('[lili-test-deposits] No PTC member sub-ledgers found — run the server once so they are provisioned.');
    return summary;
  }

  log(`[lili-test-deposits] ${summary.contexts.length} sub-ledger context(s) × $${opts.amount.toFixed(2)}${opts.dryRun ? ' (dry run)' : ''}`);
  for (const ctx of summary.contexts) {
    log(`  • ${ctx.label.padEnd(28)} ${ctx.member.padEnd(22)} ${ctx.subLedgerId}  GL ${ctx.parentAccountCode}/${ctx.subAccountType}`);
    if (opts.dryRun) continue;
    try {
      const deposit = await engine.createDirectDeposit({
        amount: ctx.amount,
        memo: ctx.memo,
        sourceAccountId: ctx.sourceAccountId,
        paymentType: ctx.paymentType,
        secCode: 'PPD',
        createdBy: 'scripts/lili-sub-ledger-test-deposits',
      });
      summary.deposits.push({ context: ctx, depositId: deposit.deposit_id || deposit.depositId, status: deposit.status, ok: true });
      log(`    → ${deposit.deposit_id || deposit.depositId} ${deposit.status}`);
    } catch (e) {
      summary.deposits.push({ context: ctx, ok: false, error: e.message });
      log(`    → FAILED: ${e.message}`);
    }
  }

  if (opts.dryRun) return summary;

  if (!opts.skipTransmit) {
    summary.transmit = await engine.transmitQueued({ actor: 'scripts/lili-sub-ledger-test-deposits' });
    log(`[lili-test-deposits] transmitQueued → ${JSON.stringify(summary.transmit)}`);
  }
  if (!opts.skipReconcile) {
    try {
      summary.reconcile = await engine.reconcile({});
      log(`[lili-test-deposits] reconcile → ${JSON.stringify(summary.reconcile)}`);
    } catch (e) {
      summary.reconcile = { error: e.message };
      log(`[lili-test-deposits] reconcile skipped: ${e.message}`);
    }
  }
  return summary;
}

async function main() {
  const opts = parseArgs();
  const summary = await runTestDeposits(opts);
  const failed = summary.deposits.filter((d) => !d.ok).length;
  const created = summary.deposits.filter((d) => d.ok).length;
  if (summary.skipped) {
    console.log('[lili-test-deposits] nothing created.');
  } else {
    console.log(`[lili-test-deposits] created ${created} deposit(s), ${failed} failed.`);
  }
  return failed ? 1 : 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => { console.error('[lili-test-deposits] error:', e.message); process.exit(1); });
}

module.exports = { parseArgs, planFor, buildDepositContexts, checkReadiness, runTestDeposits, DEFAULT_AMOUNT };
