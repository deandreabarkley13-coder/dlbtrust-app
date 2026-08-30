import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { CamelRouteEngine } = require('../server/integrations/camel/camelRouteEngine');
const { OpenAchRailEngine } = require('../server/integrations/openach/openachRailEngine');
const { installFamilyBankFlow, submitToFlow } = require('../server/integrations/camel/familyBankFlow');
const { renderCamelYaml } = require('../server/integrations/camel/camelYaml');
const { InHouseBankEngine } = require('../server/integrations/inhouseBank/inHouseBankEngine');
const { DualLedgerEngine } = require('../server/integrations/inhouseBank/dualLedgerEngine');
const { KafkaEventBus } = require('../server/integrations/events/kafkaEventBus');
const pg = require('../server/integrations/bonds/pgPool');

type Row = Record<string, any>;

/**
 * In-memory stand-in for the two tables this flow owns: camel_exchanges and
 * ihb_openach_dispatches. Only the statements these engines issue are
 * recognised, so a query nobody wrote a case for surfaces as an empty result
 * rather than silently passing.
 */
function fakeDb() {
  const exchanges: Row[] = [];
  const dispatches: Row[] = [];
  const statusLog: Row[] = [];

  /** Apply a dynamic `SET col = $n` list the way Postgres would. */
  function applySet(row: Row, text: string, params: any[]) {
    const assignments = text.slice(text.indexOf('SET') + 3, text.indexOf('WHERE')).split(',');
    assignments.forEach((assignment) => {
      const [col, value] = assignment.split('=').map((s) => s.trim());
      const match = /^\$(\d+)$/.exec(value || '');
      if (match) row[col] = params[Number(match[1]) - 1];
      else if (/^'(.*)'$/.test(value || '')) row[col] = value.replace(/'/g, '');
      else if (/NOW\(\)/i.test(value || '')) row[col] = new Date();
    });
  }

  const query = vi.fn(async (sql: string, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER|DROP)/i.test(text)) return { rows: [] };

    // ── camel_exchanges ──────────────────────────────────────────────────────
    if (text.startsWith('INSERT INTO camel_exchanges')) {
      const [exchange_id, route_id, message_key, source, body, headers, parent_exchange_id, payment_id] = params;
      if (message_key !== null && exchanges.some((r) => r.route_id === route_id && r.message_key === message_key)) {
        return { rows: [] };
      }
      const row: Row = {
        exchange_id, route_id, message_key, source, body, headers, parent_exchange_id, payment_id,
        state: 'pending', trace: '[]', attempts: 0, next_attempt_at: null, error: null,
        created_at: new Date(), completed_at: null,
      };
      exchanges.push(row);
      return { rows: [row] };
    }
    if (text.startsWith('SELECT * FROM camel_exchanges WHERE route_id =')) {
      return { rows: exchanges.filter((r) => r.route_id === params[0] && r.message_key === params[1]) };
    }
    if (text.startsWith('SELECT * FROM camel_exchanges WHERE exchange_id =')) {
      return { rows: exchanges.filter((r) => r.exchange_id === params[0]) };
    }
    if (text.startsWith("UPDATE camel_exchanges SET state = 'in_progress'")) {
      const row = exchanges.find((r) => r.exchange_id === params[0] && r.state === 'pending');
      if (!row) return { rows: [] };
      row.state = 'in_progress';
      return { rows: [row] };
    }
    if (text.startsWith('UPDATE camel_exchanges SET')) {
      const row = exchanges.find((r) => r.exchange_id === params[0]);
      if (!row) return { rows: [] };
      applySet(row, text, params);
      return { rows: [row] };
    }
    if (text.startsWith("SELECT * FROM camel_exchanges WHERE state = 'pending'")) {
      const due = exchanges.filter((r) => r.state === 'pending'
        && (!r.next_attempt_at || new Date(r.next_attempt_at) <= new Date())
        && (params[0] === null || r.route_id === params[0]));
      return { rows: due };
    }
    if (text.startsWith('SELECT * FROM camel_exchanges WHERE ($1::text IS NULL')) {
      const [routeId, state, paymentId] = params;
      return {
        rows: exchanges.filter((r) => (routeId === null || r.route_id === routeId)
          && (state === null || r.state === state)
          && (paymentId === null || r.payment_id === paymentId)),
      };
    }
    if (text.startsWith('SELECT state, COUNT(*)::int AS count FROM camel_exchanges')) {
      return { rows: [] };
    }
    if (text.startsWith('SELECT route_id, state, COUNT(*)')) return { rows: [] };
    if (text.startsWith('SELECT * FROM camel_exchanges ORDER BY')) return { rows: exchanges };

    // ── ihb_openach_dispatches ───────────────────────────────────────────────
    if (text.startsWith('INSERT INTO ihb_openach_dispatches')) {
      const [dispatch_id, payment_id, rail, sec_code, amount_cents, currency, effective_date,
        payment_type_id, creditor_name, creditor_account_last4, routing_number] = params;
      if (dispatches.some((r) => r.payment_id === payment_id)) return { rows: [] };
      const row: Row = {
        dispatch_id, payment_id, state: 'reserved', rail, sec_code, amount_cents, currency,
        effective_date, payment_type_id, creditor_name, creditor_account_last4, routing_number,
        attempts: 1, payment_profile_id: null, external_account_id: null, payment_schedule_id: null,
        last_error: null, last_status: null, outcome: null, settlement_reference: null,
        reserved_at: new Date(), originated_at: null, confirmed_at: null,
      };
      dispatches.push(row);
      return { rows: [row] };
    }
    if (text.startsWith('SELECT * FROM ihb_openach_dispatches WHERE payment_id =')) {
      return { rows: dispatches.filter((r) => r.payment_id === params[0]) };
    }
    if (text.startsWith('UPDATE ihb_openach_dispatches SET')) {
      const row = dispatches.find((r) => r.payment_id === params[0]);
      if (!row) return { rows: [] };
      applySet(row, text, params);
      return { rows: [row] };
    }
    if (text.startsWith('SELECT * FROM ihb_openach_dispatches WHERE ($1::text IS NULL')) {
      return { rows: dispatches.filter((r) => params[0] === null || r.state === params[0]) };
    }
    if (text.startsWith('INSERT INTO ihb_openach_status_log')) {
      statusLog.push({ dispatch_id: params[0], payment_id: params[1], openach_status: params[2], outcome: params[3], note: params[4] });
      return { rows: [] };
    }
    if (text.startsWith('SELECT * FROM ihb_openach_status_log')) return { rows: statusLog };
    if (text.startsWith('SELECT state, COUNT(*)::int AS count, COALESCE(SUM(amount_cents)')) return { rows: [] };
    if (text.includes('FROM ihb_payments p LEFT JOIN ihb_openach_dispatches')) return { rows: [] };

    return { rows: [] };
  });

  return { exchanges, dispatches, statusLog, query };
}

function dispatchedAchPayment(overrides: Row = {}): Row {
  return {
    paymentId: 'IHB-1',
    status: 'dispatched',
    internal: false,
    rail: 'ach_standard',
    amountCents: 250_00,
    feeCents: 0,
    currency: 'USD',
    creditorVaId: 'VA-2',
    creditor: {
      name: 'Jordan Barkley',
      routingNumber: '021000021',
      accountNumber: '1234567890',
      accountType: 'checking',
      bankName: 'Partner Bank',
    },
    ...overrides,
  };
}

let db: ReturnType<typeof fakeDb>;

beforeEach(() => {
  db = fakeDb();
  vi.spyOn(pg, 'query').mockImplementation(db.query as any);
  // The taps are fire-and-forget; the bus must not depend on a broker.
  vi.spyOn(KafkaEventBus, 'publish').mockResolvedValue(true as any);
  vi.spyOn(DualLedgerEngine, 'appendEvent').mockResolvedValue({} as any);

  process.env.OPENACH_BASE_URL = 'https://openach.test/api';
  process.env.OPENACH_API_TOKEN = 'test-token';
  process.env.OPENACH_API_KEY = 'test-key';
  process.env.OPENACH_PAYMENT_TYPE_ID = 'PT-STANDARD';
  process.env.OPENACH_SAME_DAY_PAYMENT_TYPE_ID = 'PT-SAMEDAY';
  process.env.CAMEL_MAX_REDELIVERIES = '1';
  process.env.CAMEL_REDELIVERY_DELAY_SECONDS = '1';

  CamelRouteEngine.reset();
  installFamilyBankFlow({ force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OPENACH_BASE_URL;
  delete process.env.OPENACH_API_TOKEN;
  delete process.env.OPENACH_API_KEY;
  delete process.env.OPENACH_PAYMENT_TYPE_ID;
  delete process.env.OPENACH_SAME_DAY_PAYMENT_TYPE_ID;
  delete process.env.CAMEL_MAX_REDELIVERIES;
  delete process.env.CAMEL_REDELIVERY_DELAY_SECONDS;
});

describe('the Camel integration context', () => {
  it('mediates a route step by step and keeps the trace on the exchange', async () => {
    const seen: string[] = [];
    CamelRouteEngine.registerProcessor('noteOne', async () => { seen.push('one'); return { step: 'one' }; });
    CamelRouteEngine.registerProcessor('noteTwo', async () => { seen.push('two'); return { step: 'two' }; });
    CamelRouteEngine.register({
      routeId: 'test-two-steps',
      from: { uri: 'direct:test-two-steps' },
      steps: [
        { type: 'setHeader', name: 'channel', value: 'test' },
        { type: 'process', processor: 'noteOne', updatesBody: true },
        { type: 'process', processor: 'noteTwo', updatesBody: true },
        { type: 'wireTap', topic: 'trust.payment.requested' },
      ],
    });

    const result = await CamelRouteEngine.send('test-two-steps', { hello: 'world' });

    expect(seen).toEqual(['one', 'two']);
    expect(result.exchange.state).toBe('completed');
    expect(result.exchange.headers.channel).toBe('test');
    expect(result.exchange.trace.map((entry: Row) => entry.step)).toEqual([
      'setHeader(channel)', 'process(noteOne)', 'process(noteTwo)', 'wireTap(trust.payment.requested)',
    ]);
    expect(KafkaEventBus.publish).toHaveBeenCalledWith('trust.payment.requested', expect.anything(), expect.anything());
  });

  it('consumes a message key once, so a redelivered instruction is not mediated twice', async () => {
    const ran = vi.fn(async () => ({ ok: true }));
    CamelRouteEngine.registerProcessor('runOnce', ran);
    CamelRouteEngine.register({
      routeId: 'test-idempotent',
      from: { uri: 'direct:test-idempotent' },
      idempotentKeyHeader: 'idempotencyKey',
      steps: [{ type: 'process', processor: 'runOnce' }],
    });

    const first = await CamelRouteEngine.send('test-idempotent', {}, { headers: { idempotencyKey: 'KEY-1' } });
    const second = await CamelRouteEngine.send('test-idempotent', {}, { headers: { idempotencyKey: 'KEY-1' } });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.replay).toBe(true);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('redelivers a failing exchange and dead-letters it once the attempts are exhausted', async () => {
    CamelRouteEngine.registerProcessor('alwaysFails', async () => { throw new Error('the ODFI is unreachable'); });
    CamelRouteEngine.register({
      routeId: 'test-failing',
      from: { uri: 'direct:test-failing' },
      steps: [{ type: 'process', processor: 'alwaysFails' }],
    });

    const first = await CamelRouteEngine.send('test-failing', { paymentId: 'IHB-9' });
    expect(first.exchange.state).toBe('pending');
    expect(first.exchange.error).toBe('the ODFI is unreachable');
    expect(first.exchange.nextAttemptAt).toBeTruthy();

    // The scheduler would wait for the backoff; the test brings the attempt
    // forward rather than sleeping through it.
    db.exchanges[0].next_attempt_at = new Date(Date.now() - 1000);
    const report = await CamelRouteEngine.drive({});

    expect(report.deadLettered).toBe(1);
    const deadLetters = await CamelRouteEngine.deadLetters({});
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].paymentId).toBe('IHB-9');
    expect(KafkaEventBus.publish).toHaveBeenCalledWith('trust.payment.failed', expect.anything(), expect.anything());
  });

  it('stops a route at a filter instead of failing it', async () => {
    const after = vi.fn();
    CamelRouteEngine.registerPredicate('never', () => false);
    CamelRouteEngine.registerProcessor('afterFilter', after);
    CamelRouteEngine.register({
      routeId: 'test-filter',
      from: { uri: 'direct:test-filter' },
      steps: [
        { type: 'filter', predicate: 'never' },
        { type: 'process', processor: 'afterFilter' },
      ],
    });

    const result = await CamelRouteEngine.send('test-filter', {});

    expect(result.exchange.state).toBe('filtered');
    expect(after).not.toHaveBeenCalled();
  });

  it('renders the registered routes as Camel YAML for a JVM runtime', () => {
    const yaml = renderCamelYaml({});
    expect(yaml).toContain('id: family-bank-ingress');
    expect(yaml).toContain('/api/camel/inbox/family-bank-ingress');
    expect(yaml).toContain('id: family-bank-bus-driver');
    // Secrets are referenced as properties, never rendered into the file.
    expect(yaml).toContain('{{dlbtrust.inboxKey}}');
  });
});

describe('the OpenACH rail', () => {
  it('originates a dispatched ACH payment once and never twice', async () => {
    vi.spyOn(InHouseBankEngine, 'require').mockResolvedValue(dispatchedAchPayment());
    const client = {
      disburseToBeneficiary: vi.fn(async () => ({
        success: true,
        payment_profile_id: 'PP-1',
        external_account_id: 'EA-1',
        payment_schedule_id: 'PS-1',
      })),
    };

    const first = await OpenAchRailEngine.originate('IHB-1', { client });
    const second = await OpenAchRailEngine.originate('IHB-1', { client });

    expect(first.originated).toBe(true);
    expect(first.dispatch.state).toBe('originated');
    expect(first.dispatch.paymentScheduleId).toBe('PS-1');
    expect(second.originated).toBe(false);
    expect(second.replay).toBe(true);
    expect(client.disburseToBeneficiary).toHaveBeenCalledTimes(1);
    expect(db.dispatches).toHaveLength(1);
  });

  it('keeps only the last four digits of the beneficiary account', async () => {
    vi.spyOn(InHouseBankEngine, 'require').mockResolvedValue(dispatchedAchPayment());
    const client = {
      disburseToBeneficiary: vi.fn(async () => ({ success: true, payment_profile_id: 'PP-1', external_account_id: 'EA-1', payment_schedule_id: 'PS-1' })),
    };

    const result = await OpenAchRailEngine.originate('IHB-1', { client });

    expect(result.dispatch.creditorAccountLast4).toBe('7890');
    expect(JSON.stringify(result.dispatch)).not.toContain('1234567890');
  });

  it('refuses a payment the rail must not touch', async () => {
    const client = { disburseToBeneficiary: vi.fn() };

    vi.spyOn(InHouseBankEngine, 'require').mockResolvedValue(dispatchedAchPayment({ status: 'approved' }));
    await expect(OpenAchRailEngine.originate('IHB-1', { client })).rejects.toThrow(/only a dispatched payment/);

    vi.spyOn(InHouseBankEngine, 'require').mockResolvedValue(dispatchedAchPayment({ internal: true }));
    await expect(OpenAchRailEngine.originate('IHB-1', { client })).rejects.toThrow(/on-us book transfer/);

    vi.spyOn(InHouseBankEngine, 'require').mockResolvedValue(dispatchedAchPayment({ rail: 'fedwire' }));
    await expect(OpenAchRailEngine.originate('IHB-1', { client })).rejects.toThrow(/does not carry fedwire/);

    vi.spyOn(InHouseBankEngine, 'require').mockResolvedValue(dispatchedAchPayment({ creditor: { name: 'No Bank' } }));
    await expect(OpenAchRailEngine.originate('IHB-1', { client })).rejects.toThrow(/routing and account number/);

    expect(client.disburseToBeneficiary).not.toHaveBeenCalled();
    expect(db.dispatches).toHaveLength(0);
  });

  it('settles only through the bank, with the ODFI schedule as the reference', async () => {
    vi.spyOn(InHouseBankEngine, 'require').mockResolvedValue(dispatchedAchPayment());
    const confirm = vi.spyOn(InHouseBankEngine, 'confirm').mockResolvedValue({ status: 'settled' } as any);
    const client = {
      disburseToBeneficiary: vi.fn(async () => ({ success: true, payment_profile_id: 'PP-1', external_account_id: 'EA-1', payment_schedule_id: 'PS-1' })),
      getPaymentSchedules: vi.fn(async () => ({ payment_schedules: [{ payment_schedule_id: 'PS-1', payment_schedule_status: 'Complete' }] })),
    };

    await OpenAchRailEngine.originate('IHB-1', { client });
    const report = await OpenAchRailEngine.pollStatuses({ client });

    expect(report.confirmed).toEqual([
      { paymentId: 'IHB-1', outcome: 'settled', status: 'Complete', paymentStatus: 'settled' },
    ]);
    expect(confirm).toHaveBeenCalledWith('IHB-1', expect.objectContaining({ outcome: 'settled', reference: 'OPENACH-PS-1' }));
    expect((await OpenAchRailEngine.get('IHB-1')).state).toBe('settled');
  });

  it('treats an R-code as a return and an unknown status as still in flight', async () => {
    vi.spyOn(InHouseBankEngine, 'require').mockResolvedValue(dispatchedAchPayment());
    const confirm = vi.spyOn(InHouseBankEngine, 'confirm').mockResolvedValue({ status: 'returned' } as any);
    const client = {
      disburseToBeneficiary: vi.fn(async () => ({ success: true, payment_profile_id: 'PP-1', external_account_id: 'EA-1', payment_schedule_id: 'PS-1' })),
      getPaymentSchedules: vi.fn(async () => ({ payment_schedules: [{ payment_schedule_id: 'PS-1', payment_schedule_status: 'In Transit' }] })),
    };

    await OpenAchRailEngine.originate('IHB-1', { client });

    const unchanged = await OpenAchRailEngine.pollStatuses({ client });
    expect(unchanged.confirmed).toHaveLength(0);
    expect(unchanged.unchanged).toEqual([{ paymentId: 'IHB-1', status: 'In Transit' }]);
    expect(confirm).not.toHaveBeenCalled();

    const applied = await OpenAchRailEngine.applyStatus({ paymentId: 'IHB-1', status: 'R01', reason: 'insufficient funds' });
    expect(applied.outcome).toBe('returned');
    expect(confirm).toHaveBeenCalledWith('IHB-1', expect.objectContaining({ outcome: 'returned', reference: null }));

    // A second advice for a dispatch that already reached a terminal state must
    // not confirm the payment again.
    const again = await OpenAchRailEngine.applyStatus({ paymentId: 'IHB-1', status: 'R01' });
    expect(again.applied).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

describe('the unified family bank flow', () => {
  it('takes an ACH instruction from any channel to an OpenACH origination', async () => {
    const payment = dispatchedAchPayment();
    vi.spyOn(InHouseBankEngine, 'submit').mockResolvedValue({ replay: false, payment } as any);
    vi.spyOn(InHouseBankEngine, 'require').mockResolvedValue(payment);
    const originate = vi.spyOn(OpenAchRailEngine, 'originate').mockResolvedValue({
      originated: true,
      dispatch: { paymentScheduleId: 'PS-1' },
    } as any);

    const result = await submitToFlow({
      instruction: { debtorAccount: 'VA-1', amount: '250.00' },
      idempotencyKey: 'KEY-ACH-1',
      channel: 'dashboard',
    });

    expect(result.accepted).toBe(true);
    expect(result.exchange.state).toBe('completed');
    expect(originate).toHaveBeenCalledWith('IHB-1', expect.anything());
    const routesTouched = db.exchanges.map((row) => row.route_id);
    expect(routesTouched).toEqual([
      'family-bank-ingress', 'family-bank-dispatch', 'family-bank-openach-dispatch',
    ]);
  });

  it('never sends an on-us book transfer to a rail', async () => {
    const payment = dispatchedAchPayment({ internal: true, rail: 'internal_book' });
    vi.spyOn(InHouseBankEngine, 'submit').mockResolvedValue({ replay: false, payment } as any);
    const originate = vi.spyOn(OpenAchRailEngine, 'originate');

    await submitToFlow({ instruction: {}, idempotencyKey: 'KEY-ONUS-1', channel: 'dashboard' });

    expect(originate).not.toHaveBeenCalled();
    expect(db.exchanges.map((row) => row.route_id)).toEqual([
      'family-bank-ingress', 'family-bank-dispatch', 'family-bank-onus',
    ]);
  });

  it('hands a wire to the host-to-host channel rather than to OpenACH', async () => {
    const payment = dispatchedAchPayment({ rail: 'fedwire' });
    vi.spyOn(InHouseBankEngine, 'submit').mockResolvedValue({ replay: false, payment } as any);
    const { WireDispatchLink } = require('../server/integrations/inhouseBank/wire/wireDispatchLink');
    const kick = vi.spyOn(WireDispatchLink, 'kick').mockResolvedValue({ transmitted: true } as any);
    const originate = vi.spyOn(OpenAchRailEngine, 'originate');

    await submitToFlow({ instruction: {}, idempotencyKey: 'KEY-WIRE-1', channel: 'dashboard' });

    expect(kick).toHaveBeenCalledWith('IHB-1', expect.anything());
    expect(originate).not.toHaveBeenCalled();
  });

  it('stops and records a payment that still needs a trustee signature', async () => {
    const payment = dispatchedAchPayment({ status: 'pending_approval', requiredApprovals: 2 });
    vi.spyOn(InHouseBankEngine, 'submit').mockResolvedValue({ replay: false, payment } as any);
    const execute = vi.spyOn(InHouseBankEngine, 'execute');

    const result = await submitToFlow({ instruction: {}, idempotencyKey: 'KEY-APPROVAL-1' });

    expect(execute).not.toHaveBeenCalled();
    expect(result.exchange.state).toBe('completed');
    expect(DualLedgerEngine.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'flow.awaiting_approval' })
    );
    expect(db.exchanges.map((row) => row.route_id)).toEqual(['family-bank-ingress']);
  });

  it('splits an instruction file into one idempotent exchange per instruction', async () => {
    const result = await CamelRouteEngine.send('family-bank-file-batch', {
      batchId: 'BATCH-1',
      instructions: [{ amount: '10.00' }, { amount: '20.00' }],
    }, { messageKey: 'BATCH-1' });

    expect(result.exchange.state).toBe('completed');
    const children = db.exchanges.filter((row) => row.route_id === 'family-bank-ingress');
    expect(children).toHaveLength(2);
    expect(children.map((row) => row.message_key)).toEqual(['BATCH-1#0', 'BATCH-1#1']);
    // Children wait for the next cycle so one large file cannot hold the bus.
    expect(children.every((row) => row.state === 'pending')).toBe(true);
  });
});
