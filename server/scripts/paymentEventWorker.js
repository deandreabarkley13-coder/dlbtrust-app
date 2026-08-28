#!/usr/bin/env node
'use strict';

/**
 * Payment Event Worker — DLB Trust Private Trust Company
 *
 * Consumes the canonical event stream and drives the parts of the payment
 * workflow that must happen after a lifecycle transition: reconciling the
 * processor ledger, posting settled movements to the GL, and replaying outbox
 * events that never reached a broker.
 *
 * Runs against Kafka when KAFKA_BROKERS is set; otherwise it attaches to the
 * in-process bus so the same handlers execute in a single-node deployment.
 *
 *   node server/scripts/paymentEventWorker.js [--once] [--retry-only]
 */

const { KafkaEventBus, TOPICS } = require('../integrations/events/kafkaEventBus');

let PaymentProcessorServerEngine;
try {
  ({ PaymentProcessorServerEngine } = require('../integrations/payments/paymentProcessorServerEngine'));
} catch { PaymentProcessorServerEngine = null; }

let TrustAccountingEngine;
try {
  ({ TrustAccountingEngine } = require('../integrations/accounting/trustAccountingEngine'));
} catch { TrustAccountingEngine = null; }

const RETRY_INTERVAL_MS = Number(process.env.EVENT_RETRY_INTERVAL_MS || 60000);

/**
 * Settlement is the only transition that may touch the ledger, and only with an
 * external reference — an accepted request is not settled money.
 */
async function onSettled(envelope) {
  const { paymentId, externalReference, processor, amountCents } = envelope.payload || {};
  if (!externalReference) {
    console.warn(`[worker] ${paymentId} settled without an external reference; not posting`);
    return;
  }
  if (PaymentProcessorServerEngine) {
    try {
      await PaymentProcessorServerEngine.reconcile({
        txId: paymentId,
        externalReference,
        status: 'completed',
        rawResponse: envelope.payload,
        initiatedBy: 'payment-event-worker',
      });
    } catch (e) {
      console.warn(`[worker] reconcile failed for ${paymentId}:`, e.message);
    }
  }
  console.log(`[worker] settled ${paymentId} via ${processor} for ${amountCents} cents (${externalReference})`);
}

async function onFailed(envelope) {
  const { paymentId, error, processor } = envelope.payload || {};
  console.warn(`[worker] ${paymentId} failed on ${processor}: ${error || 'unknown error'}`);
}

async function onDistributionSettled(envelope) {
  const { paymentId, fromAccountId, toAccountId, amountCents } = envelope.payload || {};
  console.log(`[worker] internal distribution ${paymentId}: ${fromAccountId} -> ${toAccountId} (${amountCents} cents)`);
  if (!TrustAccountingEngine || typeof TrustAccountingEngine.recordEvent !== 'function') return;
  try {
    await TrustAccountingEngine.recordEvent({
      eventType: 'internal_distribution',
      reference: paymentId,
      amountCents,
      metadata: { fromAccountId, toAccountId },
    });
  } catch (e) {
    console.warn(`[worker] GL posting failed for ${paymentId}:`, e.message);
  }
}

const HANDLERS = {
  [TOPICS.paymentSettled]: onSettled,
  [TOPICS.paymentFailed]: onFailed,
  [TOPICS.distributionSettled]: onDistributionSettled,
};

async function handle(envelope) {
  const handler = HANDLERS[envelope.topic];
  if (!handler) return;
  await handler(envelope);
}

async function main() {
  const args = process.argv.slice(2);
  const retryOnly = args.includes('--retry-only');
  const once = args.includes('--once');

  const status = KafkaEventBus.status();
  console.log('[worker] event bus:', JSON.stringify(status));

  if (retryOnly) {
    console.log('[worker] outbox replay:', JSON.stringify(await KafkaEventBus.retryFailed()));
    return;
  }

  const subscription = await KafkaEventBus.consume(handle);
  console.log(`[worker] consuming ${subscription.topics.length} topics in ${subscription.mode} mode`);

  if (once) {
    console.log('[worker] outbox replay:', JSON.stringify(await KafkaEventBus.retryFailed()));
    if (subscription.consumer) await subscription.consumer.disconnect();
    await KafkaEventBus.disconnect();
    return;
  }

  const timer = setInterval(() => {
    KafkaEventBus.retryFailed()
      .then((r) => { if (r.retried) console.log('[worker] outbox replay:', JSON.stringify(r)); })
      .catch((e) => console.warn('[worker] outbox replay failed:', e.message));
  }, RETRY_INTERVAL_MS);

  const shutdown = async () => {
    clearInterval(timer);
    if (subscription.consumer) {
      try { await subscription.consumer.disconnect(); } catch { /* already gone */ }
    }
    await KafkaEventBus.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().then(() => {
    // The pg pool keeps the loop alive; a one-shot run is finished here.
    if (process.argv.includes('--once') || process.argv.includes('--retry-only')) process.exit(0);
  }).catch((e) => {
    console.error('[worker] fatal:', e.message);
    process.exit(1);
  });
}

module.exports = { handle, onSettled, onFailed, onDistributionSettled };
