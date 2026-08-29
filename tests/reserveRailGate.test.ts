import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ReserveEngine, ReserveShortfallError } = require('../server/integrations/finops/reserveEngine');
const { PaymentProcessorServerEngine } = require('../server/integrations/payments/paymentProcessorServerEngine');
const { PDCflowEngine } = require('../server/integrations/payments/pdcflowEngine');
const { WireEngine } = require('../server/integrations/wire/wireEngine');
const { PartnerBankRails } = require('../server/integrations/rails/partnerBankRails');
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
    return { rows: [] };
  });
  return { rows, query };
}

const SHORTFALL = new ReserveShortfallError(
  'Reserve shortfall: wire origination of $2500 exceeds the $0.26 held at an external custodian for the trust.',
  { attestedReserve: 0.26, shortfall: 2499.74 },
);

describe('external rails gated on attested reserves', () => {
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

  describe('wire origination', () => {
    const wire = {
      wire_id: 'WIRE-RESERVE-1',
      amount_cents: 250000,
      metadata: JSON.stringify({ sourceCashAccountId: 'CA-OPERATING' }),
      beneficiary_name: 'Db Net Mgmt LLC',
    };

    it('does not reach the partner bank when the reserve cannot cover the wire', async () => {
      vi.spyOn(ReserveEngine, 'assertSpendable').mockRejectedValue(SHORTFALL);
      const originate = vi.spyOn(PartnerBankRails, 'originate');
      vi.spyOn(PartnerBankRails, 'isConfigured').mockReturnValue(true);

      await expect(WireEngine._transmitWire(wire, 'https://partner.example/wire'))
        .rejects.toThrow(/Reserve shortfall/);
      expect(originate).not.toHaveBeenCalled();
    });

    it('checks the reserve against the wire amount and its funding account', async () => {
      const assertSpendable = vi.spyOn(ReserveEngine, 'assertSpendable')
        .mockResolvedValue({ allowed: true, shortfall: 0 } as any);
      vi.spyOn(PartnerBankRails, 'isConfigured').mockReturnValue(true);
      vi.spyOn(PartnerBankRails, 'originate').mockResolvedValue({ status: 'submitted' } as any);

      await WireEngine._transmitWire(wire, 'https://partner.example/wire');

      expect(assertSpendable).toHaveBeenCalledWith({
        amountCents: 250000,
        rail: 'wire',
        accountId: 'CA-OPERATING',
      });
    });
  });

  describe('processor origination', () => {
    const payment = {
      rail: 'pdcflow',
      amount: 2500,
      destination: {
        accountHolderName: 'Db Net Mgmt LLC',
        routingNumber: '084106768',
        accountNumber: '112233445566',
      },
      reference: 'CC-RESERVE-1',
      initiatedBy: 'deandreabarkley13@gmail.com',
    };

    it('fails the payment without calling the processor on a shortfall', async () => {
      vi.spyOn(ReserveEngine, 'assertSpendable').mockRejectedValue(SHORTFALL);
      vi.spyOn(PDCflowEngine, 'isConfigured').mockReturnValue(true);
      const originate = vi.spyOn(PDCflowEngine, 'originateAch');

      const result = await PaymentProcessorServerEngine.processPayment(payment);

      expect(originate).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
      expect(result.result.reserveBlocked).toBe(true);
      expect(db.rows[0].status).toBe('failed');
      expect(events.map((e) => e.topic)).toEqual([TOPICS.paymentRequested, TOPICS.paymentFailed]);
    });

    it('leaves an inbound collection unchecked, since money is arriving', async () => {
      const assertSpendable = vi.spyOn(ReserveEngine, 'assertSpendable');
      await PaymentProcessorServerEngine.processPayment({ ...payment, direction: 'inbound' });
      expect(assertSpendable).not.toHaveBeenCalled();
    });

    it('does not gate an internal processor rail on external reserves', async () => {
      const assertSpendable = vi.spyOn(ReserveEngine, 'assertSpendable');
      await PaymentProcessorServerEngine.processPayment({ ...payment, rail: 'book_transfer', processor: 'clearing' });
      expect(assertSpendable).not.toHaveBeenCalled();
    });
  });
});
