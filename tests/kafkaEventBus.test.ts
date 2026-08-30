import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { KafkaEventBus, TOPICS } = require('../server/integrations/events/kafkaEventBus');
const pool = require('../server/integrations/bonds/pgPool');

type Row = Record<string, any>;

/** In-memory stand-in for the canonical_event_outbox table. */
function fakeOutbox() {
  const rows: Row[] = [];
  const query = vi.fn(async (sql: string, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^CREATE/i.test(text)) return { rows: [] };
    if (text.startsWith('INSERT INTO canonical_event_outbox')) {
      rows.push({
        event_id: params[0],
        topic: params[1],
        event_key: params[2],
        payload: params[3],
        status: 'pending',
        attempts: 0,
        created_at: new Date().toISOString(),
      });
      return { rows: [] };
    }
    if (text.startsWith("UPDATE canonical_event_outbox SET status = 'published'")) {
      const row = rows.find((r) => r.event_id === params[0]);
      if (row) { row.status = 'published'; row.attempts += 1; }
      return { rows: [] };
    }
    if (text.startsWith("UPDATE canonical_event_outbox SET status = 'failed'")) {
      const row = rows.find((r) => r.event_id === params[0]);
      if (row) { row.status = 'failed'; row.attempts += 1; row.last_error = params[1]; }
      return { rows: [] };
    }
    if (text.includes('FROM canonical_event_outbox WHERE status IN')) {
      return { rows: rows.filter((r) => r.status !== 'published') };
    }
    if (text.includes("FROM canonical_event_outbox WHERE status <> 'published'")) {
      return { rows: rows.filter((r) => r.status !== 'published') };
    }
    return { rows: [] };
  });
  return { rows, query };
}

describe('canonical Kafka event bus', () => {
  const env = { ...process.env };
  let db: ReturnType<typeof fakeOutbox>;

  beforeEach(() => {
    delete process.env.KAFKA_BROKERS;
    db = fakeOutbox();
    vi.spyOn(pool, 'query').mockImplementation(db.query as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...env };
  });

  it('reports outbox-only mode and no credentials when no broker is configured', () => {
    const status = KafkaEventBus.status();
    expect(status.configured).toBe(false);
    expect(status.mode).toBe('outbox_only');
    expect(status.topics).toContain(TOPICS.paymentSettled);
    expect(JSON.stringify(status)).not.toMatch(/password|secret/i);
  });

  it('never exposes SASL credentials in status', () => {
    process.env.KAFKA_BROKERS = 'broker-1:9092';
    process.env.KAFKA_SASL_USERNAME = 'trust-user';
    process.env.KAFKA_SASL_PASSWORD = 'super-secret-value';
    const status = KafkaEventBus.status();
    expect(status.saslConfigured).toBe(true);
    expect(JSON.stringify(status)).not.toContain('super-secret-value');
    expect(JSON.stringify(status)).not.toContain('trust-user');
  });

  it('records an event in the outbox and dispatches it in-process', async () => {
    const seen: any[] = [];
    const unsubscribe = KafkaEventBus.subscribe(TOPICS.paymentRequested, (e: any) => { seen.push(e); });

    const event = await KafkaEventBus.publish(TOPICS.paymentRequested, {
      paymentId: 'PPS-1', amountCents: 25,
    });

    expect(event.published).toBe(false);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].status).toBe('pending');
    expect(db.rows[0].event_key).toBe('PPS-1');
    expect(seen).toHaveLength(1);
    expect(seen[0].payload.amountCents).toBe(25);
    unsubscribe();
  });

  it('keys events by the canonical payment reference so ordering is preserved', async () => {
    const event = await KafkaEventBus.publish(TOPICS.paymentSettled, { reference: 'WIRE-9' });
    expect(event.key).toBe('WIRE-9');
  });

  it('refuses an unknown topic', async () => {
    await expect(KafkaEventBus.publish('trust.payment.invented', {})).rejects.toThrow(/Unknown canonical topic/);
  });

  it('keeps the payment alive when the outbox write fails', async () => {
    vi.spyOn(pool, 'query').mockRejectedValue(new Error('db down'));
    const seen: any[] = [];
    const unsubscribe = KafkaEventBus.subscribe(TOPICS.paymentFailed, (e: any) => { seen.push(e); });
    await expect(KafkaEventBus.publish(TOPICS.paymentFailed, { paymentId: 'PPS-2' })).resolves.toBeTruthy();
    expect(seen).toHaveLength(1);
    unsubscribe();
  });

  it('leaves unpublished events replayable', async () => {
    await KafkaEventBus.publish(TOPICS.paymentTransmitted, { paymentId: 'PPS-3' });
    const pending = await KafkaEventBus.pendingEvents();
    expect(pending).toHaveLength(1);
    // Without a broker nothing can be transmitted, so the row stays queued.
    const retry = await KafkaEventBus.retryFailed();
    expect(retry.retried).toBe(1);
    expect(retry.published).toBe(0);
  });

  it('attaches handlers in-process when consuming without a broker', async () => {
    const handler = vi.fn();
    const subscription = await KafkaEventBus.consume(handler);
    expect(subscription.mode).toBe('in_process');
    await KafkaEventBus.publish(TOPICS.distributionProposed, { paymentId: 'TBP-1' });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
