'use strict';

/**
 * Kafka Event Bus — DLB Trust Private Trust Company
 *
 * The canonical event backbone. Every money-movement lifecycle transition is
 * written to a durable outbox table first and only then published to Kafka, so
 * an event is never lost when a broker is unreachable and the ledger stays the
 * system of record. When no broker is configured the bus still records the
 * outbox row and dispatches to in-process subscribers, which keeps the
 * workflow identical whether or not Kafka is running.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');

const TOPICS = {
  paymentRequested: 'trust.payment.requested',
  paymentApproved: 'trust.payment.approved',
  paymentRejected: 'trust.payment.rejected',
  paymentTransmitted: 'trust.payment.transmitted',
  paymentSettled: 'trust.payment.settled',
  paymentFailed: 'trust.payment.failed',
  distributionProposed: 'trust.distribution.proposed',
  distributionSigned: 'trust.distribution.signed',
  distributionSettled: 'trust.distribution.settled',
  ledgerPosted: 'trust.ledger.posted',
};

const TOPIC_LIST = Object.values(TOPICS);

let Kafka;
try { ({ Kafka } = require('kafkajs')); } catch { Kafka = null; }

/** In-process subscribers, keyed by topic. Always dispatched, Kafka or not. */
const localSubscribers = new Map();

let producer = null;
let producerReady = null;

function eventId() {
  return `EVT-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function parseBrokers(raw) {
  return String(raw || '')
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean);
}

class KafkaEventBus {
  static get TOPICS() { return TOPICS; }

  static config() {
    const brokers = parseBrokers(process.env.KAFKA_BROKERS);
    return {
      brokers,
      clientId: process.env.KAFKA_CLIENT_ID || 'dlbtrust-canonical',
      groupId: process.env.KAFKA_CONSUMER_GROUP || 'dlbtrust-payment-workers',
      ssl: process.env.KAFKA_SSL === 'true',
      username: process.env.KAFKA_SASL_USERNAME || null,
      password: process.env.KAFKA_SASL_PASSWORD || null,
      mechanism: process.env.KAFKA_SASL_MECHANISM || 'plain',
    };
  }

  static isConfigured() {
    return Boolean(Kafka) && this.config().brokers.length > 0;
  }

  /** Safe to expose: never includes SASL credentials. */
  static status() {
    const cfg = this.config();
    return {
      driverAvailable: Boolean(Kafka),
      configured: this.isConfigured(),
      brokerCount: cfg.brokers.length,
      clientId: cfg.clientId,
      consumerGroup: cfg.groupId,
      ssl: cfg.ssl,
      saslConfigured: Boolean(cfg.username && cfg.password),
      topics: TOPIC_LIST,
      mode: this.isConfigured() ? 'kafka' : 'outbox_only',
      note: this.isConfigured()
        ? 'Events are recorded in the outbox and published to Kafka.'
        : 'No KAFKA_BROKERS configured: events are recorded in the outbox and dispatched in-process only.',
    };
  }

  static _client() {
    const cfg = this.config();
    const options = { clientId: cfg.clientId, brokers: cfg.brokers, ssl: cfg.ssl };
    if (cfg.username && cfg.password) {
      options.sasl = { mechanism: cfg.mechanism, username: cfg.username, password: cfg.password };
    }
    return new Kafka(options);
  }

  static async ensureTables() {
    if (!pool || !pool.query) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS canonical_event_outbox (
        event_id      TEXT PRIMARY KEY,
        topic         TEXT NOT NULL,
        event_key     TEXT,
        payload       JSONB NOT NULL DEFAULT '{}',
        status        TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','published','failed')),
        attempts      INTEGER NOT NULL DEFAULT 0,
        last_error    TEXT,
        published_at  TIMESTAMPTZ,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_event_outbox_status ON canonical_event_outbox(status, created_at)`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_event_outbox_key ON canonical_event_outbox(event_key)`
    );
  }

  static async _producer() {
    if (!this.isConfigured()) return null;
    if (producer) {
      await producerReady;
      return producer;
    }
    producer = this._client().producer({ idempotent: true, maxInFlightRequests: 1 });
    producerReady = producer.connect().catch((e) => {
      producer = null;
      throw e;
    });
    await producerReady;
    return producer;
  }

  /**
   * Record an event and publish it. `key` should be the canonical reference
   * (payment id, wire id) so Kafka keeps one payment's events on one partition
   * and therefore in order.
   */
  static async publish(topic, payload = {}, { key = null } = {}) {
    if (!TOPIC_LIST.includes(topic)) throw new Error(`Unknown canonical topic: ${topic}`);
    const id = eventId();
    const eventKey = key || payload.paymentId || payload.reference || payload.wireId || null;
    const envelope = {
      eventId: id,
      topic,
      key: eventKey,
      occurredAt: new Date().toISOString(),
      payload,
    };

    await this._record(envelope);
    const published = await this._transmit(envelope);
    await this._dispatchLocal(envelope);
    return { ...envelope, published };
  }

  static async _record(envelope) {
    if (!pool || !pool.query) return;
    try {
      await this.ensureTables();
      await pool.query(
        `INSERT INTO canonical_event_outbox (event_id, topic, event_key, payload)
         VALUES ($1, $2, $3, $4)`,
        [envelope.eventId, envelope.topic, envelope.key, JSON.stringify(envelope.payload)]
      );
    } catch (e) {
      // The outbox must never take down a payment; the local dispatch and the
      // engine's own ledger write remain authoritative.
      console.warn('[events] outbox write failed:', e.message);
    }
  }

  static async _transmit(envelope) {
    if (!this.isConfigured()) return false;
    try {
      const prod = await this._producer();
      await prod.send({
        topic: envelope.topic,
        messages: [{
          key: envelope.key || envelope.eventId,
          value: JSON.stringify(envelope),
          headers: { eventId: envelope.eventId },
        }],
      });
      await this._markPublished(envelope.eventId);
      return true;
    } catch (e) {
      await this._markFailed(envelope.eventId, e.message);
      console.warn(`[events] publish failed for ${envelope.topic}:`, e.message);
      return false;
    }
  }

  static async _markPublished(id) {
    if (!pool || !pool.query) return;
    try {
      await pool.query(
        `UPDATE canonical_event_outbox
         SET status = 'published', attempts = attempts + 1, published_at = NOW()
         WHERE event_id = $1`,
        [id]
      );
    } catch { /* outbox bookkeeping only */ }
  }

  static async _markFailed(id, message) {
    if (!pool || !pool.query) return;
    try {
      await pool.query(
        `UPDATE canonical_event_outbox
         SET status = 'failed', attempts = attempts + 1, last_error = $2
         WHERE event_id = $1`,
        [id, String(message).slice(0, 500)]
      );
    } catch { /* outbox bookkeeping only */ }
  }

  static async _dispatchLocal(envelope) {
    const handlers = localSubscribers.get(envelope.topic) || [];
    for (const handler of handlers) {
      try {
        await handler(envelope);
      } catch (e) {
        console.warn(`[events] local handler for ${envelope.topic} failed:`, e.message);
      }
    }
  }

  /** Register an in-process handler. Returns an unsubscribe function. */
  static subscribe(topic, handler) {
    if (!TOPIC_LIST.includes(topic)) throw new Error(`Unknown canonical topic: ${topic}`);
    const handlers = localSubscribers.get(topic) || [];
    handlers.push(handler);
    localSubscribers.set(topic, handlers);
    return () => {
      localSubscribers.set(topic, (localSubscribers.get(topic) || []).filter((h) => h !== handler));
    };
  }

  /** Replay outbox rows that never reached a broker. */
  static async retryFailed({ limit = 50 } = {}) {
    if (!pool || !pool.query) return { retried: 0, published: 0 };
    await this.ensureTables();
    const result = await pool.query(
      `SELECT * FROM canonical_event_outbox WHERE status IN ('pending','failed')
       ORDER BY created_at ASC LIMIT $1`,
      [limit]
    );
    let published = 0;
    for (const row of result.rows) {
      const envelope = {
        eventId: row.event_id,
        topic: row.topic,
        key: row.event_key,
        occurredAt: row.created_at,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      };
      if (await this._transmit(envelope)) published += 1;
    }
    return { retried: result.rows.length, published };
  }

  static async pendingEvents({ limit = 50 } = {}) {
    if (!pool || !pool.query) return [];
    await this.ensureTables();
    const result = await pool.query(
      `SELECT event_id, topic, event_key, status, attempts, last_error, created_at
       FROM canonical_event_outbox WHERE status <> 'published'
       ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  /**
   * Consume the canonical topics. Used by the payment worker; a no-op when no
   * broker is configured, since in-process subscribers already receive events.
   */
  static async consume(handler, { topics = TOPIC_LIST, fromBeginning = false } = {}) {
    if (!this.isConfigured()) {
      for (const topic of topics) this.subscribe(topic, handler);
      return { mode: 'in_process', topics };
    }
    const consumer = this._client().consumer({ groupId: this.config().groupId });
    await consumer.connect();
    for (const topic of topics) await consumer.subscribe({ topic, fromBeginning });
    await consumer.run({
      eachMessage: async ({ message }) => {
        const envelope = JSON.parse(message.value.toString());
        await handler(envelope);
      },
    });
    return { mode: 'kafka', topics, consumer };
  }

  static async disconnect() {
    if (producer) {
      try { await producer.disconnect(); } catch { /* already gone */ }
      producer = null;
      producerReady = null;
    }
  }
}

module.exports = { KafkaEventBus, TOPICS };
