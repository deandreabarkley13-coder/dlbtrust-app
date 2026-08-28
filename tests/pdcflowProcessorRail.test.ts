import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  PaymentProcessorServerEngine,
} = require('../server/integrations/payments/paymentProcessorServerEngine');
const { PDCflowEngine } = require('../server/integrations/payments/pdcflowEngine');
const { KafkaEventBus, TOPICS } = require('../server/integrations/events/kafkaEventBus');
const pg = require('../server/integrations/bonds/pgPool');

type Row = Record<string, any>;

/** In-memory stand-in for payment_processor_transactions. */
function fakeDb() {
  const rows: Row[] = [];
  const query = vi.fn(async (sql: string, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER)/i.test(text)) return { rows: [] };
    if (text.startsWith('INSERT INTO payment_processor_transactions')) {
      const cols = text.slice(text.indexOf('(') + 1, text.indexOf(')')).split(',').map((c) => c.trim());
      const row: Row = {};
      cols.forEach((c, i) => { row[c] = params[i]; });
      rows.push(row);
      return { rows: [] };
    }
    if (text.startsWith('UPDATE payment_processor_transactions')) {
      const row = rows.find((r) => r.processor_tx_id === params[params.length - 1]);
      if (row) {
        const assignments = text.slice(text.indexOf('SET') + 3, text.indexOf('WHERE')).split(',');
        assignments.forEach((assignment) => {
          const [col, value] = assignment.split('=').map((s) => s.trim());
          const match = /^\$(\d+)$/.exec(value || '');
          if (match) row[col] = params[Number(match[1]) - 1];
        });
      }
      return { rows: [] };
    }
    if (text.startsWith('SELECT * FROM payment_processor_transactions WHERE processor =')) {
      return { rows: rows.filter((r) => r.processor === 'pdcflow' && r.external_reference === params[0]) };
    }
    if (text.startsWith('SELECT * FROM payment_processor_transactions')) {
      return { rows: rows.filter((r) => r.processor_tx_id === params[0]) };
    }
    return { rows: [] };
  });
  return { rows, query };
}

describe('PDCflow as a canonical processor rail', () => {
  const env = { ...process.env };
  let db: ReturnType<typeof fakeDb>;
  let events: any[];
  const unsubscribers: Array<() => void> = [];

  beforeEach(() => {
    delete process.env.KAFKA_BROKERS;
    db = fakeDb();
    vi.spyOn(pg, 'query').mockImplementation(db.query as any);
    events = [];
    for (const topic of Object.values(TOPICS) as string[]) {
      unsubscribers.push(KafkaEventBus.subscribe(topic, (e: any) => { events.push(e); }));
    }
  });

  afterEach(() => {
    while (unsubscribers.length) unsubscribers.pop()!();
    vi.restoreAllMocks();
    process.env = { ...env };
  });

  const payment = {
    rail: 'pdcflow',
    amount: 0.25,
    destination: {
      accountHolderName: 'Db Net Mgmt LLC',
      routingNumber: '084106768',
      accountNumber: '112233445566',
    },
    reference: 'CC-MICRO-1',
    initiatedBy: 'deandreabarkley13@gmail.com',
  };

  it('routes the pdcflow rail to the PDCflow processor and publishes the lifecycle', async () => {
    const originate = vi.spyOn(PDCflowEngine, 'originateAch').mockResolvedValue({
      provider: 'pdcflow',
      direction: 'credit',
      providerReference: '9911',
      providerStatus: 'PENDING',
      settled: false,
    });
    vi.spyOn(PDCflowEngine, 'isConfigured').mockReturnValue(true);

    const result = await PaymentProcessorServerEngine.processPayment(payment);

    expect(originate).toHaveBeenCalledWith('credit', expect.objectContaining({
      amountCents: 25,
      counterpartyName: 'Db Net Mgmt LLC',
      reference: 'CC-MICRO-1',
    }));
    expect(result.processor).toBe('pdcflow');
    // Provider acceptance is pending, not completed.
    expect(result.status).toBe('pending');
    expect(result.externalReference).toBe('9911');
    expect(events.map((e) => e.topic)).toEqual([TOPICS.paymentRequested, TOPICS.paymentTransmitted]);
    expect(JSON.stringify(events)).not.toContain('112233445566');
  });

  it('falls back to manual with the missing configuration instead of transmitting', async () => {
    delete process.env.PDCFLOW_BASE_URL;
    delete process.env.PDCFLOW_USERNAME;
    delete process.env.PDCFLOW_PASSWORD;
    delete process.env.PDCFLOW_ACH_PATH;
    const originate = vi.spyOn(PDCflowEngine, 'originateAch');

    const result = await PaymentProcessorServerEngine.processPayment(payment);

    expect(originate).not.toHaveBeenCalled();
    expect(result.status).toBe('manual');
    expect(result.result.missingConfiguration).toContain('PDCFLOW_BASE_URL');
  });

  it('settles only on a settled postback, matched by provider reference', async () => {
    vi.spyOn(PDCflowEngine, 'isConfigured').mockReturnValue(true);
    vi.spyOn(PDCflowEngine, 'originateAch').mockResolvedValue({
      providerReference: '9911', providerStatus: 'PENDING', settled: false,
    });
    const created = await PaymentProcessorServerEngine.processPayment(payment);
    events.length = 0;

    const pendingPostback = await PaymentProcessorServerEngine.applyPdcflowPostback({
      transactionId: '9911', currentStatus: 'PENDING',
    });
    expect(pendingPostback.status).toBe('pending');

    const settled = await PaymentProcessorServerEngine.applyPdcflowPostback({
      transactionId: '9911', currentStatus: 'SETTLED',
    });
    expect(settled.matched).toBe(true);
    expect(settled.processorTxId).toBe(created.processorTxId);
    expect(settled.status).toBe('completed');
    expect(events.map((e) => e.topic)).toContain(TOPICS.paymentSettled);
  });

  it('does not settle an unknown provider reference', async () => {
    const outcome = await PaymentProcessorServerEngine.applyPdcflowPostback({
      transactionId: 'not-ours', currentStatus: 'SETTLED',
    });
    expect(outcome.matched).toBe(false);
    expect(events).toHaveLength(0);
  });
});
