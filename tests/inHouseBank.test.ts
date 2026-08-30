import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { IngressEngine } = require('../server/integrations/inhouseBank/ingressEngine');
const { RoutingEngine } = require('../server/integrations/inhouseBank/routingEngine');
const { ZeroTrustGateway } = require('../server/integrations/inhouseBank/zeroTrustGateway');
const { VirtualAccountManager } = require('../server/integrations/inhouseBank/virtualAccountManager');
const { Iso20022 } = require('../server/integrations/inhouseBank/iso20022');
const pool = require('../server/integrations/bonds/pgPool');

type Row = Record<string, any>;

/**
 * The in-house bank engines only ever touch their own ihb_* tables, so the
 * fake recognises just those statements. Anything else throws, which keeps a
 * silently-unhandled query from being mistaken for an empty result.
 */
function fakeDb(state: { idempotency: Row[]; nonces: Row[]; liquidity: Row[]; access: Row[] }) {
  return vi.fn(async (sql: string, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER|DROP)/i.test(text)) return { rows: [] };

    if (text.startsWith('INSERT INTO ihb_idempotency')) {
      const existing = state.idempotency.find((r) => r.idempotency_key === params[0]);
      if (existing) return { rows: [] };
      const row = {
        idempotency_key: params[0],
        fingerprint: params[1],
        principal: params[2],
        state: 'in_flight',
        payment_id: null,
        response: null,
      };
      state.idempotency.push(row);
      return { rows: [row] };
    }
    if (text.startsWith('SELECT * FROM ihb_idempotency')) {
      return { rows: state.idempotency.filter((r) => r.idempotency_key === params[0]) };
    }
    if (text.startsWith('UPDATE ihb_idempotency')) {
      const row = state.idempotency.find((r) => r.idempotency_key === params[0]);
      if (!row) return { rows: [] };
      row.state = params[1];
      row.payment_id = params[2];
      row.response = params[3];
      return { rows: [row] };
    }
    if (text.startsWith('DELETE FROM ihb_idempotency')) {
      const index = state.idempotency.findIndex((r) => r.idempotency_key === params[0] && r.state === 'in_flight');
      if (index === -1) return { rows: [] };
      return { rows: state.idempotency.splice(index, 1) };
    }

    if (text.startsWith('INSERT INTO ihb_nonces')) {
      if (state.nonces.some((r) => r.nonce === params[0])) return { rows: [] };
      const row = { nonce: params[0], principal: params[1], scope: params[2] };
      state.nonces.push(row);
      return { rows: [row] };
    }
    if (text.startsWith('INSERT INTO ihb_access_log')) {
      state.access.push({ principal: params[0], scope: params[1], decision: params[3], reason: params[4] });
      return { rows: [] };
    }

    if (text.startsWith('SELECT * FROM ihb_rail_liquidity')) return { rows: state.liquidity };

    throw new Error(`unhandled SQL in test fake: ${text.slice(0, 90)}`);
  });
}

const baseInstruction = {
  debtorAccount: '8842000000001',
  amount: '250.00',
  creditor: { name: 'Barkley Household LLC', accountNumber: '123456789', routingNumber: '021000021' },
};

describe('in-house bank ingress and idempotency', () => {
  let state: { idempotency: Row[]; nonces: Row[]; liquidity: Row[]; access: Row[] };
  let original: any;

  beforeEach(() => {
    state = { idempotency: [], nonces: [], liquidity: [], access: [] };
    original = pool.query;
    pool.query = fakeDb(state);
  });
  afterEach(() => {
    pool.query = original;
    vi.restoreAllMocks();
  });

  it('canonicalizes an instruction whatever shape it arrives in', () => {
    const instruction = IngressEngine.normalize(
      { fromAccount: '8842000000001', amount: '250.00', beneficiary: { name: 'Household', account: '123456789' } },
      { principal: 'operator-1' }
    );
    expect(instruction.amountCents).toBe(25000);
    expect(instruction.debtorAccount).toBe('8842000000001');
    expect(instruction.creditor.name).toBe('Household');
    expect(instruction.currency).toBe('USD');
    expect(instruction.originator).toBe('operator-1');
  });

  it('gives the same fingerprint to a retry and a different one to a changed amount', () => {
    const a = IngressEngine.normalize(baseInstruction, {});
    const b = IngressEngine.normalize(baseInstruction, {});
    const c = IngressEngine.normalize({ ...baseInstruction, amount: '250.01' }, {});
    expect(IngressEngine.fingerprint(a)).toBe(IngressEngine.fingerprint(b));
    expect(IngressEngine.fingerprint(a)).not.toBe(IngressEngine.fingerprint(c));
  });

  it('refuses a submission with no idempotency key rather than risking a double payment', async () => {
    await expect(IngressEngine.accept({ payload: baseInstruction })).rejects.toThrow(/Idempotency-Key/);
  });

  it('replays a completed key instead of creating a second payment', async () => {
    await IngressEngine.accept({ idempotencyKey: 'k1', payload: baseInstruction });
    await IngressEngine.complete('k1', { paymentId: 'IHB-1', response: { paymentId: 'IHB-1' } });
    const second = await IngressEngine.accept({ idempotencyKey: 'k1', payload: baseInstruction });
    expect(second.replay).toBe(true);
    expect(second.record.payment_id).toBe('IHB-1');
  });

  it('refuses a key reused for a different instruction, which would otherwise hide a payment', async () => {
    await IngressEngine.accept({ idempotencyKey: 'k2', payload: baseInstruction });
    await IngressEngine.complete('k2', { paymentId: 'IHB-2' });
    await expect(
      IngressEngine.accept({ idempotencyKey: 'k2', payload: { ...baseInstruction, amount: '9000.00' } })
    ).rejects.toMatchObject({ code: 'IHB_IDEMPOTENCY_CONFLICT' });
  });

  it('refuses a retry while the first attempt is still in flight, and frees the key when it fails', async () => {
    await IngressEngine.accept({ idempotencyKey: 'k3', payload: baseInstruction });
    await expect(IngressEngine.accept({ idempotencyKey: 'k3', payload: baseInstruction })).rejects.toMatchObject({
      code: 'IHB_IN_FLIGHT',
    });
    await IngressEngine.release('k3', 'debtor account not found');
    const retry = await IngressEngine.accept({ idempotencyKey: 'k3', payload: baseInstruction });
    expect(retry.replay).toBe(false);
  });
});

describe('zero trust gateway', () => {
  let state: { idempotency: Row[]; nonces: Row[]; liquidity: Row[]; access: Row[] };
  let original: any;

  beforeEach(() => {
    state = { idempotency: [], nonces: [], liquidity: [], access: [] };
    original = pool.query;
    pool.query = fakeDb(state);
    process.env.IHB_SERVICE_TOKEN = 'service-token-under-test';
    process.env.IHB_SIGNING_SECRET = 'signing-secret-under-test';
    process.env.IHB_REQUIRE_SESSION_SIGNATURE = 'true';
  });
  afterEach(() => {
    pool.query = original;
    delete process.env.IHB_SERVICE_TOKEN;
    delete process.env.IHB_SIGNING_SECRET;
    delete process.env.IHB_REQUIRE_SESSION_SIGNATURE;
  });

  function signedHeaders(body: string, extra: Row = {}) {
    const { headers } = ZeroTrustGateway.signRequest({ body, secret: 'signing-secret-under-test' });
    return { 'x-ihb-service-token': 'service-token-under-test', ...headers, ...extra };
  }

  it('admits a correctly signed service call', async () => {
    const body = JSON.stringify(baseInstruction);
    const result = await ZeroTrustGateway.authorize({
      scope: 'payments:initiate',
      headers: signedHeaders(body),
      body,
    });
    expect(result.role).toBe('service');
    expect(result.signed).toBe(true);
  });

  it('refuses a call with no credential at all', async () => {
    await expect(ZeroTrustGateway.authorize({ scope: 'payments:initiate', headers: {}, body: '{}' })).rejects.toMatchObject({
      code: 'IHB_NO_CREDENTIAL',
    });
  });

  it('refuses a signature computed over a different body', async () => {
    const headers = signedHeaders(JSON.stringify(baseInstruction));
    await expect(
      ZeroTrustGateway.authorize({
        scope: 'payments:initiate',
        headers,
        body: JSON.stringify({ ...baseInstruction, amount: '99999.00' }),
      })
    ).rejects.toMatchObject({ code: 'IHB_BAD_SIGNATURE' });
  });

  it('refuses a stale timestamp even when the signature is valid', async () => {
    const body = '{}';
    const stale = Math.floor(Date.now() / 1000) - 4000;
    const { headers } = ZeroTrustGateway.signRequest({ body, secret: 'signing-secret-under-test', timestamp: stale });
    await expect(
      ZeroTrustGateway.authorize({
        scope: 'payments:initiate',
        headers: { 'x-ihb-service-token': 'service-token-under-test', ...headers },
        body,
      })
    ).rejects.toMatchObject({ code: 'IHB_STALE' });
  });

  it('refuses the second use of a nonce, so a captured request cannot be replayed', async () => {
    const body = JSON.stringify(baseInstruction);
    const headers = signedHeaders(body);
    await ZeroTrustGateway.authorize({ scope: 'payments:initiate', headers, body });
    await expect(ZeroTrustGateway.authorize({ scope: 'payments:initiate', headers, body })).rejects.toMatchObject({
      code: 'IHB_REPLAY',
    });
  });

  it('refuses a scope the role does not carry', async () => {
    const body = '{}';
    await expect(
      ZeroTrustGateway.authorize({ scope: 'payments:approve', headers: signedHeaders(body), body })
    ).rejects.toMatchObject({ code: 'IHB_SCOPE_DENIED' });
  });

  it('fails closed when signed ingress is required but no secret is configured', async () => {
    delete process.env.IHB_SIGNING_SECRET;
    const body = '{}';
    await expect(
      ZeroTrustGateway.authorize({
        scope: 'payments:initiate',
        headers: { 'x-ihb-service-token': 'service-token-under-test' },
        body,
      })
    ).rejects.toMatchObject({ code: 'IHB_NOT_READY' });
  });
});

describe('smart routing, least cost and velocity', () => {
  let state: { idempotency: Row[]; nonces: Row[]; liquidity: Row[]; access: Row[] };
  let original: any;

  beforeEach(() => {
    state = { idempotency: [], nonces: [], liquidity: [], access: [] };
    original = pool.query;
    pool.query = fakeDb(state);
    // Plenty of pooled liquidity, so rail choice is decided by cost and speed.
    vi.spyOn(VirtualAccountManager, 'position').mockResolvedValue({
      settlementBalanceCents: 1_000_000_000,
      virtualBalanceCents: 1_000_000_000,
    });
  });
  afterEach(() => {
    pool.query = original;
    vi.restoreAllMocks();
  });

  const instruction = (overrides: Row = {}) =>
    IngressEngine.normalize({ ...baseInstruction, ...overrides }, {});

  it('keeps an on-us payment on the book and charges nothing for it', async () => {
    const decision = await RoutingEngine.decide(instruction(), { internal: true });
    expect(decision.rail).toBe('internal_book');
    expect(decision.costCents).toBe(0);
  });

  it('picks the cheapest rail that still meets a standard request', async () => {
    const decision = await RoutingEngine.decide(instruction({ requestedSpeed: 'standard' }), { internal: false });
    expect(decision.rail).toBe('ach_standard');
  });

  it('escalates to an instant rail when instant settlement is asked for', async () => {
    const decision = await RoutingEngine.decide(instruction({ requestedSpeed: 'instant' }), { internal: false });
    expect(decision.settlementMinutes).toBeLessThanOrEqual(5);
    expect(['rtp', 'stablecoin']).toContain(decision.rail);
  });

  it('routes a wire-sized payment off ACH, which cannot carry it', async () => {
    const decision = await RoutingEngine.decide(instruction({ amount: '2000000.00' }), { internal: false });
    expect(decision.rail).not.toBe('ach_standard');
    const rejectedAch = decision.rejected.find((c: Row) => c.rail === 'ach_standard');
    expect(rejectedAch.reason).toMatch(/ceiling/);
  });

  it('will not choose a rail that policy has blocked', async () => {
    const decision = await RoutingEngine.decide(instruction(), { internal: false, blockedRails: ['ach_standard'] });
    expect(decision.rail).not.toBe('ach_standard');
  });

  it('refuses to route rather than guess when every rail is blocked', async () => {
    await expect(
      RoutingEngine.decide(instruction(), {
        internal: false,
        allowedRails: ['stablecoin'],
      })
    ).rejects.toMatchObject({ code: 'IHB_NO_ROUTE' });
  });

  it('reports each rail in the liquidity matrix with its cost and cutoff', async () => {
    const matrix = await RoutingEngine.matrix({ amountCents: 100000 });
    expect(matrix.length).toBeGreaterThan(0);
    const wire = matrix.find((r: Row) => r.rail === 'fedwire');
    expect(wire.costCents).toBeGreaterThan(0);
    expect(wire.reversible).toBe(false);
  });
});

describe('dual ledger event chain', () => {
  const { DualLedgerEngine } = require('../server/integrations/inhouseBank/dualLedgerEngine');
  let original: any;
  let events: Row[];

  beforeEach(() => {
    events = [];
    original = pool.query;
    pool.query = vi.fn(async (sql: string, params: any[] = []) => {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (/^(CREATE|ALTER|DROP)/i.test(text)) return { rows: [] };
      if (text.startsWith('SELECT event_hash FROM ihb_events')) {
        const tip = events[events.length - 1];
        return { rows: tip ? [{ event_hash: tip.event_hash }] : [] };
      }
      if (text.startsWith('INSERT INTO ihb_events')) {
        // Postgres hands JSONB back with its keys reordered, which is exactly
        // what a naive hash of the payload would trip over.
        const payload = JSON.parse(params[4]);
        const reordered = Object.keys(payload)
          .sort()
          .reverse()
          .reduce((acc: Row, key) => ({ ...acc, [key]: payload[key] }), {});
        const row = {
          sequence: events.length + 1,
          event_id: params[0],
          event_type: params[1],
          payment_id: params[2],
          actor: params[3],
          payload: reordered,
          prev_hash: params[5],
          event_hash: params[6],
          created_at: new Date(params[7]),
        };
        events.push(row);
        return { rows: [row] };
      }
      if (text.startsWith('SELECT * FROM ihb_events')) return { rows: events };
      throw new Error(`unhandled SQL in test fake: ${text.slice(0, 90)}`);
    });
  });
  afterEach(() => {
    pool.query = original;
  });

  it('verifies a chain that has come back out of the database untouched', async () => {
    await DualLedgerEngine.appendEvent({
      eventType: 'payment.received',
      paymentId: 'IHB-1',
      actor: 'operator',
      payload: { zebra: 1, alpha: 'two', nested: { b: false, a: [3, 2] } },
    });
    await DualLedgerEngine.appendEvent({ eventType: 'payment.settled', paymentId: 'IHB-1', actor: 'rail', payload: { reference: 'TRACE-1' } });
    const result = await DualLedgerEngine.verifyChain();
    expect(result).toMatchObject({ events: 2, intact: true, breaks: [] });
  });

  it('reports the event whose payload was edited behind the API', async () => {
    await DualLedgerEngine.appendEvent({ eventType: 'payment.received', paymentId: 'IHB-1', actor: 'operator', payload: { amountCents: 10000 } });
    await DualLedgerEngine.appendEvent({ eventType: 'payment.settled', paymentId: 'IHB-1', actor: 'rail', payload: { reference: 'TRACE-1' } });
    events[0].payload = { amountCents: 1 };
    const result = await DualLedgerEngine.verifyChain();
    expect(result.intact).toBe(false);
    expect(result.breaks[0].sequence).toBe(1);
  });
});

describe('ISO 20022', () => {
  const pain001 = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09">
  <CstmrCdtTrfInitn>
    <GrpHdr><MsgId>PTC-MSG-001</MsgId><CreDtTm>2026-08-30T09:00:00</CreDtTm></GrpHdr>
    <PmtInf>
      <ReqdExctnDt>2026-08-31</ReqdExctnDt>
      <Dbtr><Nm>PTC Family Bank</Nm></Dbtr>
      <DbtrAcct><Id><Othr><Id>8842000000001</Id></Othr></Id></DbtrAcct>
      <CdtTrfTxInf>
        <PmtId><EndToEndId>E2E-0001</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="USD">1250.75</InstdAmt></Amt>
        <CdtrAgt><FinInstnId><ClrSysMmbId><MmbId>021000021</MmbId></ClrSysMmbId></FinInstnId></CdtrAgt>
        <Cdtr><Nm>Barkley Household LLC</Nm></Cdtr>
        <CdtrAcct><Id><Othr><Id>123456789</Id></Othr></Id></CdtrAcct>
        <RmtInf><Ustrd>August household draw</Ustrd></RmtInf>
      </CdtTrfTxInf>
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>`;

  it('parses a pain.001 into canonical instructions', () => {
    const { messageId, instructions } = Iso20022.parsePain001(pain001);
    expect(messageId).toBe('PTC-MSG-001');
    expect(instructions).toHaveLength(1);
    expect(instructions[0]).toMatchObject({
      amountCents: 125075,
      currency: 'USD',
      debtorAccount: '8842000000001',
      endToEndId: 'E2E-0001',
    });
    expect(instructions[0].creditor.name).toBe('Barkley Household LLC');
    expect(instructions[0].creditor.routingNumber).toBe('021000021');
  });

  it('refuses a pain.001 with no amount rather than defaulting one', () => {
    const broken = pain001.replace('<Amt><InstdAmt Ccy="USD">1250.75</InstdAmt></Amt>', '');
    expect(() => Iso20022.parsePain001(broken)).toThrow();
  });

  it('refuses a document that is not a pain.001 at all', () => {
    expect(() => Iso20022.parsePain001('<Document><Nothing/></Document>')).toThrow();
  });

  it('reports each payment status in a pain.002', () => {
    const xml = Iso20022.buildPain002({
      originalMessageId: 'PTC-MSG-001',
      payments: [
        { paymentId: 'IHB-1', endToEndId: 'E2E-0001', status: 'settled' },
        { paymentId: 'IHB-2', endToEndId: 'E2E-0002', status: 'rejected', reason: 'daily outflow limit' },
      ],
    });
    expect(xml).toContain('PTC-MSG-001');
    expect(xml).toContain('ACSC');
    expect(xml).toContain('RJCT');
    expect(xml).toContain('daily outflow limit');
  });

  it('escapes creditor names so a crafted name cannot forge message structure', () => {
    const xml = Iso20022.buildPacs008({
      paymentId: 'IHB-3',
      endToEndId: 'E2E-0003',
      amountCents: 10000,
      currency: 'USD',
      debtorAccountNumber: '8842000000001',
      rail: 'fedwire',
      creditor: { name: 'Evil</Nm><Nm>Payee', accountNumber: '123456789', routingNumber: '021000021' },
    });
    expect(xml).not.toContain('Evil</Nm>');
    expect(xml).toContain('&lt;/Nm&gt;');
  });
});
