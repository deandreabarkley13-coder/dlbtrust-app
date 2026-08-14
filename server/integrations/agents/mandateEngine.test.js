'use strict';

/**
 * Mandate policy tests. These exercise the pure evaluator and the audit hash
 * chain, so they need no database:
 *
 *   node server/integrations/agents/mandateEngine.test.js
 */

const assert = require('assert');
const { evaluateAgainst, decisionDigest, periodStart } = require('./mandateEngine');

const PAYEE = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

function mandate(overrides = {}) {
  return {
    id: 'MANDATE-1',
    label: 'Operating expenses',
    status: 'active',
    actions: ['payment'],
    assets: ['USDC'],
    payees: [PAYEE],
    max_amount: '5000.00',
    period_limit: '10000.00',
    period: 'day',
    auto_execute_limit: '1000.00',
    purpose: null,
    not_before: null,
    not_after: null,
    ...overrides,
  };
}

function request(overrides = {}) {
  return { action: 'payment', amount: '250.00', asset: 'USDC', payee: PAYEE, at: new Date('2026-03-10T12:00:00Z'), ...overrides };
}

// ── No mandate on file: unchanged behaviour, trustees decide ────────────────
{
  const out = evaluateAgainst([], request());
  assert.strictEqual(out.decision, 'escalate');
  assert.strictEqual(out.mandateId, null);
}

// A revoked or suspended mandate is not a grant, and with nothing else on file
// the request escalates rather than executing.
for (const status of ['revoked', 'suspended']) {
  const out = evaluateAgainst([mandate({ status })], request());
  assert.strictEqual(out.decision, 'escalate', `status ${status}`);
}

// ── Within the mandate and under the autonomous limit ──────────────────────
{
  const out = evaluateAgainst([mandate()], request({ amount: '1000.00' }));
  assert.strictEqual(out.decision, 'allow');
  assert.strictEqual(out.mandateId, 'MANDATE-1');
}

// One cent over the autonomous limit is permitted but must be seen by a trustee.
{
  const out = evaluateAgainst([mandate()], request({ amount: '1000.01' }));
  assert.strictEqual(out.decision, 'escalate');
  assert.strictEqual(out.mandateId, 'MANDATE-1');
}

// A mandate with no autonomous limit never executes unattended.
{
  const out = evaluateAgainst([mandate({ auto_execute_limit: null })], request({ amount: '1.00' }));
  assert.strictEqual(out.decision, 'escalate');
}

// ── Per-transaction ceiling ────────────────────────────────────────────────
{
  const out = evaluateAgainst([mandate()], request({ amount: '5000.01' }));
  assert.strictEqual(out.decision, 'deny');
  assert.ok(out.reasons.some(r => r.includes('per-transaction limit')), out.reasons.join('; '));
}

// Exactly at the ceiling is inside the mandate (escalates: over auto limit).
{
  const out = evaluateAgainst([mandate()], request({ amount: '5000.00' }));
  assert.strictEqual(out.decision, 'escalate');
}

// ── Payee allowlist ────────────────────────────────────────────────────────
{
  const out = evaluateAgainst([mandate()], request({ payee: OTHER }));
  assert.strictEqual(out.decision, 'deny');
  assert.ok(out.reasons.some(r => r.includes('allowlist')));
}

// Allowlist matching ignores case, and "*" opens it to any payee.
{
  assert.strictEqual(evaluateAgainst([mandate()], request({ payee: PAYEE.toUpperCase() })).decision, 'allow');
  assert.strictEqual(evaluateAgainst([mandate({ payees: ['*'] })], request({ payee: OTHER })).decision, 'allow');
  assert.strictEqual(evaluateAgainst([mandate()], request({ payee: null })).decision, 'deny');
}

// ── Action and asset restrictions ──────────────────────────────────────────
{
  assert.strictEqual(evaluateAgainst([mandate()], request({ action: 'dex_swap' })).decision, 'deny');
  assert.strictEqual(evaluateAgainst([mandate()], request({ asset: 'ETH' })).decision, 'deny');
  // An empty list means "unrestricted", not "nothing allowed".
  assert.strictEqual(evaluateAgainst([mandate({ assets: [] })], request({ asset: 'ETH' })).decision, 'allow');
}

// ── Validity window ────────────────────────────────────────────────────────
{
  const window = mandate({ not_before: '2026-04-01T00:00:00Z', not_after: '2026-04-30T00:00:00Z' });
  const early = evaluateAgainst([window], request({ at: new Date('2026-03-31T23:59:59Z') }));
  assert.strictEqual(early.decision, 'deny');
  assert.ok(early.reasons.some(r => r.includes('not effective until')));

  const late = evaluateAgainst([window], request({ at: new Date('2026-05-01T00:00:00Z') }));
  assert.strictEqual(late.decision, 'deny');
  assert.ok(late.reasons.some(r => r.includes('expired')));

  assert.strictEqual(evaluateAgainst([window], request({ at: new Date('2026-04-15T00:00:00Z') })).decision, 'allow');
}

// ── Purpose ────────────────────────────────────────────────────────────────
{
  const restricted = mandate({ purpose: 'property tax' });
  assert.strictEqual(evaluateAgainst([restricted], request({ purpose: 'Pay the Property Tax bill' })).decision, 'allow');
  const wrong = evaluateAgainst([restricted], request({ purpose: 'pay the landscaper' }));
  assert.strictEqual(wrong.decision, 'deny');
  assert.ok(wrong.reasons.some(r => r.includes('purpose must reference')));
}

// ── Cumulative period cap ──────────────────────────────────────────────────
{
  const m = mandate();
  const spend = { 'MANDATE-1': '9900.00' };
  const under = evaluateAgainst([m], request({ amount: '100.00' }), spend);
  assert.strictEqual(under.decision, 'allow'); // brings the day to exactly 10000.00

  const over = evaluateAgainst([m], request({ amount: '100.01' }), spend);
  assert.strictEqual(over.decision, 'deny');
  assert.ok(over.reasons.some(r => r.includes('day limit')), over.reasons.join('; '));
}

// Cent-level arithmetic must be exact — three 0.10 payments are 0.30, and the
// classic float sum (0.30000000000000004) must not push it over a 0.30 cap.
{
  const m = mandate({ max_amount: '0.30', period_limit: '0.30', auto_execute_limit: '0.30' });
  assert.strictEqual(evaluateAgainst([m], request({ amount: '0.10' }), { 'MANDATE-1': '0.20' }).decision, 'allow');
  assert.strictEqual(evaluateAgainst([m], request({ amount: '0.11' }), { 'MANDATE-1': '0.20' }).decision, 'deny');
}

// Amounts stay decimal strings, never floats.
{
  const out = evaluateAgainst([mandate({ max_amount: '250.00', auto_execute_limit: '250.00' })], request({ amount: '250.00' }));
  assert.strictEqual(out.decision, 'allow');
  assert.throws(() => evaluateAgainst([mandate()], request({ amount: 0.1 + 0.2 })), /decimal string/);
  assert.throws(() => evaluateAgainst([mandate()], request({ amount: '0.00' })), /must be positive/);
}

// ── Several mandates: the first one that fits wins ──────────────────────────
{
  const narrow = mandate({ id: 'NARROW', payees: [OTHER] });
  const broad = mandate({ id: 'BROAD', label: 'Broad', payees: [PAYEE] });
  const out = evaluateAgainst([narrow, broad], request({ amount: '500.00' }));
  assert.strictEqual(out.decision, 'allow');
  assert.strictEqual(out.mandateId, 'BROAD');

  // When every mandate rejects it, the denial explains all of them.
  const denied = evaluateAgainst([narrow, broad], request({ payee: 'ambiguous' }));
  assert.strictEqual(denied.decision, 'deny');
  assert.strictEqual(denied.reasons.length, 2);
}

// ── Period boundaries are UTC ──────────────────────────────────────────────
{
  const at = new Date('2026-03-10T12:34:56Z'); // Tuesday
  assert.strictEqual(periodStart('day', at).toISOString(), '2026-03-10T00:00:00.000Z');
  assert.strictEqual(periodStart('week', at).toISOString(), '2026-03-08T00:00:00.000Z');
  assert.strictEqual(periodStart('month', at).toISOString(), '2026-03-01T00:00:00.000Z');
}

// ── Audit chain ────────────────────────────────────────────────────────────
{
  const fields = {
    id: 'MDEC-1', agent: 'finops', action: 'payment', amount: '250.00', asset: 'USDC',
    payee: PAYEE, decision: 'allow', mandateId: 'MANDATE-1', reasons: ['within mandate'],
    decidedAt: '2026-03-10T12:00:00.000Z',
  };
  const first = decisionDigest(null, fields);
  assert.match(first, /^[0-9a-f]{64}$/);
  // Deterministic, chained, and sensitive to every field.
  assert.strictEqual(decisionDigest(null, fields), first);
  assert.notStrictEqual(decisionDigest(first, fields), first);
  assert.notStrictEqual(decisionDigest(null, { ...fields, amount: '250.01' }), first);
  assert.notStrictEqual(decisionDigest(null, { ...fields, decision: 'deny' }), first);
  assert.notStrictEqual(decisionDigest(null, { ...fields, payee: OTHER }), first);
}

console.log('Mandate policy validation passed');
