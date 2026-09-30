'use strict';

/**
 * Settlement funding pipeline — one pass through the maker/checker flow.
 *
 *   ledger check    reconcileTrustBalances (dry run) must show no drift on the
 *                   funding, in-transit or destination GL accounts
 *   plan            SettlementFundingEngine.plan: spendable net of in-flight wires
 *   screening       AML / OFAC: the screeningRef must be a live, clear FCS-
 *                   Fraud & Compliance screening for this amount and payee,
 *                   against an ingested, fresh sanctions list
 *   initiate        maker creates the wire (approvalRef + screeningRef recorded)
 *   commit          DR in-transit / CR operating: committed, not settled
 *   approve         an independent checker signs (WireEngine enforces maker ≠ checker)
 *   send            only with --yes; the screening is re-verified and consumed
 *                   (single use), then WireEngine refuses without production mode
 *                   and a configured bank channel
 *   bank reference  poll the wire for the bank's own settlement reference
 *   settle          DR destination GL / CR in-transit, against that reference only
 *
 * A pass that cannot finish stops at the step that blocks it and says so; it is
 * resumed with --wire. `advance` is the unattended form run by Cloud Scheduler:
 * it initiates nothing and transmits nothing, and settles only wires whose
 * bank reference is already recorded.
 */

const { SettlementFundingEngine, IN_FLIGHT_STATUSES, settlementEvidence } = require('../integrations/inhouseBank/settlementFundingEngine');
const { WireEngine } = require('../integrations/wire/wireEngine');
const { reconcileTrustBalances } = require('./reconcileTrustBalances');

const BANK_SETTLED_STATUSES = ['completed', 'settled'];

class PipelineStop extends Error {
  constructor(step, message, detail = {}, exitCode = 2) {
    super(message);
    this.name = 'PipelineStop';
    this.step = step;
    this.detail = detail;
    this.exitCode = exitCode;
  }
}

const defaultDeps = {
  engine: SettlementFundingEngine,
  wires: WireEngine,
  reconcile: (options) => reconcileTrustBalances(options),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: () => {},
};

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (e) { return {}; }
}

function wireAccounts(wire, engine) {
  const meta = parseMetadata(wire.metadata);
  return [
    meta.inTransit?.sourceAccountCode || meta.fundingSource?.sourceId,
    engine.inTransitAccountCode(),
    meta.glDebitAccountCode,
  ].filter(Boolean).map(String);
}

async function checkLedger(deps, accountCodes, step = 'ledger_check') {
  const result = await deps.reconcile({ apply: false });
  const drift = (result.drift || []).filter((row) => accountCodes.includes(String(row.account_code)));
  if (drift.length) {
    throw new PipelineStop(
      step,
      `Stored balances drift from posted journal lines on ${drift.map((r) => r.account_code).join(', ')}.`
      + ' Run `node server/scripts/reconcileTrustBalances.js`, confirm the drift is the expected postings,'
      + ' then `--apply` before funding. Balances are never edited directly.',
      { drift }
    );
  }
  return (result.balances || [])
    .filter((row) => accountCodes.includes(String(row.account_code)))
    .map((row) => ({ accountCode: row.account_code, accountName: row.account_name, balance: row.derived_balance }));
}

/**
 * The bank's evidence for this wire: what the operator passed (the bank's own
 * reference, e.g. from the wire confirmation) or what the bank adapter/confirm
 * route recorded. Never generated here.
 */
function bankEvidence(wire, options) {
  if (options.reference) {
    const providerStatus = String(options.providerStatus || '').trim().toLowerCase();
    if (!BANK_SETTLED_STATUSES.includes(providerStatus)) {
      throw new PipelineStop(
        'bank_reference',
        '--provider-status must be completed or settled (the bank\'s status for this wire) to settle against --reference',
        {},
        1
      );
    }
    return { reference: options.reference, providerStatus, source: 'operator' };
  }
  const recorded = settlementEvidence(wire);
  return recorded ? { ...recorded, source: 'wire_record' } : null;
}

async function settleWithEvidence(deps, wire, evidence, actor) {
  const payload = {
    reference: evidence.reference,
    providerStatus: evidence.providerStatus,
    confirmedBy: actor || 'settlement_funding_pipeline',
    settledBy: actor || 'settlement_funding_pipeline',
  };
  let current = wire;
  if (current.status === 'sent' || current.status === 'sending') {
    current = await deps.engine.confirm(current.wire_id, payload);
  }
  if (current.status !== 'confirmed') {
    throw new PipelineStop('settle', `${current.wire_id} is ${current.status}; only a confirmed wire settles`, {}, 1);
  }
  return deps.engine.settle(current.wire_id, payload);
}

async function pollForEvidence(deps, wireId, options) {
  const intervalMs = Math.max(1, Number(options.pollSeconds ?? 30)) * 1000;
  const polls = Math.floor((Math.max(0, Number(options.timeoutSeconds ?? 0)) * 1000) / intervalMs);
  for (let attempt = 0; ; attempt += 1) {
    const wire = await deps.wires.getWire(wireId);
    const evidence = bankEvidence(wire, options);
    if (evidence || wire.status === 'settled' || !['sending', 'sent', 'confirmed'].includes(wire.status)) {
      return { wire, evidence };
    }
    if (attempt >= polls) return { wire, evidence: null };
    await deps.sleep(intervalMs);
  }
}

function summary(wire) {
  const meta = parseMetadata(wire.metadata);
  return {
    wireId: wire.wire_id,
    status: wire.status,
    amount: (Number(wire.amount_cents) / 100).toFixed(2),
    maker: wire.initiated_by,
    checker: wire.approved_by,
    approvalRef: meta.approvalRef || null,
    screeningRef: meta.screeningRef || null,
    inTransitEntryId: meta.inTransit?.entryId || null,
    settlementEntryId: wire.journal_entry_id || null,
  };
}

/**
 * One pass. New wire: amountCents, maker, checker, approvalRef, screeningRef.
 * Resume: wireId. Transmission requires yes. Returns { status, steps, wire }.
 */
async function runPipeline(options = {}, deps = defaultDeps) {
  const d = { ...defaultDeps, ...deps };
  const steps = [];
  const record = (step, detail = {}) => {
    steps.push({ step, ...detail });
    d.log(step, detail);
  };

  try {
    let wire;
    if (options.wireId) {
      wire = await d.engine.get(options.wireId);
      if (!wire) throw new PipelineStop('resume', `Wire not found: ${options.wireId}`, {}, 1);
      if (wire.payment_type !== d.engine.PAYMENT_TYPE) {
        throw new PipelineStop('resume', `${options.wireId} is not a settlement funding wire`, {}, 1);
      }
      record('resume', { wire: summary(wire) });
    } else {
      const missing = ['amountCents', 'maker', 'checker', 'approvalRef', 'screeningRef'].filter((k) => !options[k]);
      if (missing.length) {
        throw new PipelineStop('initiate', `A new funding wire needs ${missing.join(', ')}`, {}, 1);
      }
      if (String(options.maker).trim().toLowerCase() === String(options.checker).trim().toLowerCase()) {
        throw new PipelineStop('initiate', 'Maker and checker must be different trustees', {}, 1);
      }

      const readiness = await d.engine.readiness();
      record('readiness', { ready: readiness.ready, blockers: readiness.blockers });
      if (!readiness.ready) {
        throw new PipelineStop('readiness', `Settlement funding is closed: ${readiness.blockers.join('; ')}`, { blockers: readiness.blockers });
      }

      const destination = d.engine.destination(options.destination || null);
      const config = d.engine.config();
      const planned = await d.engine.plan({
        amountCents: options.amountCents,
        destination: destination.key,
        fundingSourceRef: options.fundingSourceRef || config.fundingSourceRef,
      });
      const accounts = [String(planned.source.sourceId), d.engine.inTransitAccountCode(), destination.glAccountCode];
      record('ledger_check', { accounts: await checkLedger(d, accounts) });
      record('plan', {
        amount: planned.amount,
        available: planned.available,
        inFlight: planned.inFlight,
        spendable: planned.spendable,
        funded: planned.funded,
        destination: planned.destination.key,
        accountLast4: planned.destination.accountLast4,
      });
      if (!planned.funded) {
        throw new PipelineStop('plan', `${planned.source.accountName} has ${planned.spendable} spendable and this wire draws ${planned.amount}`, { plan: planned });
      }

      await d.engine.verifyScreeningFor({
        screeningRef: options.screeningRef,
        amountCents: planned.amountCents,
        payee: {
          name: planned.destination.beneficiaryName || planned.source.debtorName,
          routingNumber: planned.destination.routingNumber,
          accountNumber: planned.destination.accountNumber,
        },
      });
      record('screening', { screeningRef: options.screeningRef, verified: true });

      const initiated = await d.engine.initiate({
        amountCents: options.amountCents,
        destination: destination.key,
        fundingSourceRef: options.fundingSourceRef || null,
        initiatedBy: options.maker,
        memo: options.memo || null,
        approvalRef: options.approvalRef,
        screeningRef: options.screeningRef,
      });
      wire = initiated.wire;
      record('initiate', { wireId: wire.wire_id, maker: options.maker, approvalRef: options.approvalRef });
    }

    if (IN_FLIGHT_STATUSES.includes(wire.status) && !parseMetadata(wire.metadata).inTransit?.entryId) {
      const committed = await d.engine.commitInTransit(wire.wire_id, { committedBy: options.maker || options.actor || null });
      wire = committed.wire || (await d.engine.get(wire.wire_id));
      record('commit', { entryId: committed.entryId, debit: committed.debitAccountCode, credit: committed.creditAccountCode, amount: committed.amount });
    }

    if (['initiated', 'pending_approval'].includes(wire.status)) {
      if (!options.checker) {
        throw new PipelineStop('approve', `${wire.wire_id} awaits an independent checker: re-run with --wire ${wire.wire_id} --checker …`, { wire: summary(wire) }, 3);
      }
      wire = await d.engine.approve(wire.wire_id, options.checker);
      record('approve', { checker: options.checker });
    }

    if (wire.status === 'approved') {
      if (!options.yes) {
        throw new PipelineStop('send', `${wire.wire_id} is approved and not transmitted: re-run with --wire ${wire.wire_id} --yes to originate it`, { wire: summary(wire) }, 3);
      }
      try {
        await d.engine.verifyScreening(wire.wire_id, { screeningRef: options.screeningRef || null });
      } catch (error) {
        throw new PipelineStop('screening', `Screening refused: ${error.message}`, {}, 1);
      }
      try {
        wire = await d.engine.sendScreened(wire.wire_id, { screeningRef: options.screeningRef || null });
      } catch (error) {
        const after = await d.wires.getWire(wire.wire_id);
        if (after && after.status === 'failed' && parseMetadata(after.metadata).inTransit?.entryId) {
          await d.engine.releaseInTransit(after.wire_id, { releasedBy: options.actor || 'settlement_funding_pipeline', reason: `transmission failed: ${error.message}` });
          record('release', { reason: error.message });
        }
        throw new PipelineStop('send', `Transmission refused: ${error.message}`, {}, 1);
      }
      record('send', { status: wire.status });
    }

    if (wire.status !== 'settled') {
      const polled = await pollForEvidence(d, wire.wire_id, options);
      wire = polled.wire;
      if (wire.status !== 'settled') {
        if (!polled.evidence) {
          throw new PipelineStop(
            'bank_reference',
            `${wire.wire_id} is ${wire.status} with no bank settlement reference; it stays in transit and is not marked settled.`
            + ' Record the bank\'s reference (POST /api/wire/:id/confirm, or --reference/--provider-status) and re-run.',
            { wire: summary(wire) },
            3
          );
        }
        record('bank_reference', { reference: polled.evidence.reference, providerStatus: polled.evidence.providerStatus, source: polled.evidence.source });
        wire = await settleWithEvidence(d, wire, polled.evidence, options.actor);
        record('settle', { journalEntryId: wire.journal_entry_id });
      }
    }

    record('ledger_after', { accounts: await checkLedger(d, wireAccounts(wire, d.engine), 'ledger_after') });
    return { status: 'settled', exitCode: 0, steps, wire: summary(wire) };
  } catch (error) {
    if (!(error instanceof PipelineStop)) throw error;
    record('stopped', { at: error.step, reason: error.message });
    return { status: error.exitCode === 3 ? 'waiting' : 'stopped', exitCode: error.exitCode, stoppedAt: error.step, reason: error.message, steps, detail: error.detail };
  }
}

/**
 * The scheduled pass: settle every transmitted funding wire whose bank
 * reference is recorded, and report the rest. Creates, approves and transmits
 * nothing.
 */
async function advancePipeline(options = {}, deps = defaultDeps) {
  const d = { ...defaultDeps, ...deps };
  const accounts = [d.engine.inTransitAccountCode()];
  const wires = [];
  for (const status of ['sending', 'sent', 'confirmed', 'initiated', 'pending_approval', 'approved']) {
    wires.push(...(await d.engine.list({ status, limit: 500 })));
  }
  for (const wire of wires) accounts.push(...wireAccounts(wire, d.engine));
  const unique = [...new Set(accounts)];
  try {
    await checkLedger(d, unique);
  } catch (error) {
    if (!(error instanceof PipelineStop)) throw error;
    return { status: 'stopped', exitCode: 2, reason: error.message, detail: error.detail, results: [] };
  }

  const results = [];
  for (const wire of wires) {
    const meta = parseMetadata(wire.metadata);
    if (['initiated', 'pending_approval', 'approved'].includes(wire.status)) {
      results.push({ wireId: wire.wire_id, status: wire.status, action: 'awaiting_operator', committed: Boolean(meta.inTransit?.entryId) });
      continue;
    }
    const evidence = settlementEvidence(wire);
    if (!evidence) {
      results.push({ wireId: wire.wire_id, status: wire.status, action: 'awaiting_bank_reference' });
      continue;
    }
    try {
      const settled = await settleWithEvidence(d, wire, evidence, options.actor || 'settlement_funding_scheduler');
      results.push({ wireId: wire.wire_id, status: settled.status, action: 'settled', reference: evidence.reference, journalEntryId: settled.journal_entry_id });
    } catch (error) {
      results.push({ wireId: wire.wire_id, status: wire.status, action: 'error', error: error.message });
    }
  }
  const failed = results.some((r) => r.action === 'error');
  return { status: failed ? 'errors' : 'ok', exitCode: failed ? 1 : 0, results };
}

module.exports = { runPipeline, advancePipeline, bankEvidence, PipelineStop };
