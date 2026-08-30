'use strict';

/**
 * PTC In-House Family Bank — Direct Send clearing engine
 *
 * Direct Send is the family bank's own way into the correspondent bank's
 * clearing pipeline. Nobody signs into a portal and uploads anything: the trust
 * assembles a raw clearing file out of its own dispatched wires and pushes it at
 * the pipeline itself, either as an mTLS POST or as a signed drop on the pinned
 * host-to-host channel.
 *
 * The whole design question for a no-portal path is "what stops us clearing the
 * same money twice", and the answer is that Direct Send owns no new idempotency
 * scheme. Every payment in a batch is reserved in the *same* wire idempotency
 * vault the single-file path uses, keyed on the payment, with the payment's own
 * pacs.008 bytes as the reserved payload. Consequences that fall out of that:
 *
 *   • a payment already sent as an individual wire cannot enter a batch, and a
 *     payment already batched cannot later be sent individually;
 *   • two operators assembling at the same moment do not both get the payment —
 *     one loses the vault insert and the payment is simply reported skipped;
 *   • the batch itself is a second, coarser guard: one file has one filename,
 *     one row and one state, so a batch that has been transmitted cannot be
 *     transmitted again, only inspected.
 *
 * The other half of the design is what happens when the pipeline's answer is
 * not a clean yes or no. A refusal the bank actually returned means the bytes
 * did not clear, the batch fails and the payments go back in the pool for a
 * later file. A timeout, a dropped socket or a 5xx means the pipeline may hold
 * the file already: the batch goes to `held`, the payments stay claimed, an
 * exception is raised, and an operator — not this engine — decides whether the
 * bank has it. Nothing here ever re-sends bytes the bank might be executing.
 *
 * Money still moves in exactly one place. `InHouseBankEngine` remains the
 * authority on balances and outcomes; the bank's own pacs.002/pacs.004 advices,
 * ingested by the host-to-host engine, are what settle or return the payments
 * this engine cleared. Direct Send transmits and accounts for files.
 */

const crypto = require('crypto');
const pool = require('../../bonds/pgPool');
const { getDirectSendConfig, directSendReadiness } = require('./wireDirectSendConfig');
const { getWireChannelConfig } = require('./wireHostToHostConfig');
const {
  buildClearingFile,
  buildManifest,
  signClearingFile,
  filenameFor,
  WireClearingFileError,
} = require('./wireClearingFile');
const transport = require('./wireDirectSendTransport');
const { WireDirectSendTransportError, dropPathFor } = transport;
const { WireIdempotencyVault, WireVaultError, hashPayload } = require('./wireIdempotencyVault');
const { assertTransition } = require('./wireStateMachine');
const { WireHostToHostEngine } = require('./wireHostToHostEngine');
const { InHouseBankEngine } = require('../inHouseBankEngine');
const { DualLedgerEngine } = require('../dualLedgerEngine');

class WireDirectSendError extends Error {
  constructor(message, code = 'WIRE_DIRECT_SEND_ERROR', status = 400, details = {}) {
    super(message);
    this.name = 'WireDirectSendError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
    this.details = details;
  }
}

/**
 * Batch states. `held` is the important one: it is not a failure and not a
 * success, it is "the pipeline may hold this file and only a human may say".
 */
const BATCH_TRANSITIONS = Object.freeze({
  assembled: ['transmitting', 'cancelled'],
  transmitting: ['transmitted', 'held', 'failed'],
  held: ['transmitted', 'rejected', 'failed'],
  transmitted: ['acknowledged', 'rejected'],
  acknowledged: [],
  rejected: [],
  failed: ['transmitting', 'cancelled'],
  cancelled: [],
});

function assertBatchTransition(from, to, batch) {
  const allowed = BATCH_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new WireDirectSendError(
      `Clearing batch ${batch ? batch.batchId : ''} cannot go from ${from} to ${to}`,
      'WIRE_DIRECT_SEND_BAD_TRANSITION',
      409,
      { from, to, allowed }
    );
  }
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
}

/** The member filename in the vault: the batch file the payment was cleared in. */
function memberFilename(batchFilename, paymentId) {
  return `${batchFilename}#${paymentId}`;
}

let tablesReady = false;

async function ensureTables() {
  if (tablesReady) return;
  await WireIdempotencyVault.ensureTables();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ihb_wire_direct_batches (
      batch_id            TEXT PRIMARY KEY,
      state               TEXT NOT NULL DEFAULT 'assembled'
                          CHECK (state IN ('assembled','transmitting','transmitted','held',
                                           'acknowledged','rejected','failed','cancelled')),
      filename            TEXT NOT NULL UNIQUE,
      payload             TEXT NOT NULL,
      payload_hash        TEXT NOT NULL,
      format              TEXT NOT NULL DEFAULT 'pacs.008.001.08',
      mode                TEXT NOT NULL,
      endpoint            TEXT,
      manifest            JSONB NOT NULL DEFAULT '{}',
      signature_algorithm TEXT,
      signature           TEXT,
      item_count          INTEGER NOT NULL DEFAULT 0,
      total_amount_cents  BIGINT NOT NULL DEFAULT 0,
      currency            TEXT NOT NULL DEFAULT 'USD',
      receipt             JSONB NOT NULL DEFAULT '{}',
      bank_reference      TEXT,
      remote_path         TEXT,
      archive_path        TEXT,
      assembled_by        TEXT,
      attempts            INTEGER NOT NULL DEFAULT 0,
      last_error          TEXT,
      transmitted_at      TIMESTAMPTZ,
      acknowledged_at     TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ihb_wire_direct_batch_items (
      batch_id        TEXT NOT NULL,
      payment_id      TEXT NOT NULL,
      transmission_id TEXT NOT NULL UNIQUE,
      amount_cents    BIGINT NOT NULL DEFAULT 0,
      currency        TEXT NOT NULL DEFAULT 'USD',
      end_to_end_id   TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (batch_id, payment_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ihb_wire_direct_log (
      log_id     TEXT PRIMARY KEY,
      batch_id   TEXT NOT NULL,
      from_state TEXT,
      to_state   TEXT NOT NULL,
      actor      TEXT,
      reason     TEXT,
      evidence   JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ihb_wire_direct_state ON ihb_wire_direct_batches(state)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ihb_wire_direct_items_payment ON ihb_wire_direct_batch_items(payment_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ihb_wire_direct_log_batch ON ihb_wire_direct_log(batch_id)');
  tablesReady = true;
}

function mapBatch(row) {
  if (!row) return null;
  return {
    batchId: row.batch_id,
    state: row.state,
    filename: row.filename,
    payloadHash: row.payload_hash,
    format: row.format,
    mode: row.mode,
    endpoint: row.endpoint,
    manifest: row.manifest || {},
    signatureAlgorithm: row.signature_algorithm,
    signature: row.signature,
    itemCount: Number(row.item_count),
    totalAmountCents: Number(row.total_amount_cents),
    totalAmount: (Number(row.total_amount_cents) / 100).toFixed(2),
    currency: row.currency,
    receipt: row.receipt || {},
    bankReference: row.bank_reference,
    remotePath: row.remote_path,
    archivePath: row.archive_path,
    assembledBy: row.assembled_by,
    attempts: Number(row.attempts),
    lastError: row.last_error,
    transmittedAt: row.transmitted_at,
    acknowledgedAt: row.acknowledged_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class WireDirectSendEngine {
  static config() {
    return getDirectSendConfig();
  }

  static readiness() {
    return directSendReadiness();
  }

  static states() {
    return BATCH_TRANSITIONS;
  }

  static async ensureTables() {
    return ensureTables();
  }

  /**
   * Dispatched wires that Direct Send may clear: external, on a carried rail,
   * past the batching hold, and not already claimed in the wire vault.
   */
  static async pending({ limit = null } = {}) {
    await ensureTables();
    const config = getDirectSendConfig();
    if (!config.rails.length) return [];
    const rows = await pool.query(
      `SELECT p.payment_id, p.rail, p.amount_cents, p.fee_cents, p.currency, p.dispatched_at
         FROM ihb_payments p
         LEFT JOIN ihb_wire_transmissions w ON w.payment_id = p.payment_id
        WHERE p.status = 'dispatched'
          AND p.internal = FALSE
          AND w.transmission_id IS NULL
          AND p.rail = ANY($1::text[])
          AND (p.dispatched_at IS NULL OR p.dispatched_at <= NOW() - ($3 || ' minutes')::interval)
        ORDER BY p.dispatched_at ASC NULLS FIRST
        LIMIT $2`,
      [config.rails, Math.min(Number(limit) || config.maxItems, config.maxItems), String(config.holdMinutes)]
    );
    return rows.rows.map(row => ({
      paymentId: row.payment_id,
      rail: row.rail,
      amountCents: Number(row.amount_cents),
      feeCents: Number(row.fee_cents || 0),
      currency: row.currency,
      dispatchedAt: row.dispatched_at,
    }));
  }

  /** Validate one payment and render its transaction bytes. */
  static async _prepareMember(paymentId, config) {
    const payment = await InHouseBankEngine.require(paymentId);
    if (payment.internal) {
      throw new WireDirectSendError(
        `Payment ${paymentId} is an on-us transfer and never leaves the bank; it belongs in no clearing file`,
        'WIRE_DIRECT_SEND_INTERNAL_PAYMENT',
        409
      );
    }
    if (payment.status !== 'dispatched') {
      throw new WireDirectSendError(
        `Payment ${paymentId} is ${payment.status}; only a dispatched payment has cleared approval and funding to be cleared`,
        'WIRE_DIRECT_SEND_NOT_DISPATCHED',
        409
      );
    }
    if (payment.rail && config.rails.length && !config.rails.includes(payment.rail)) {
      throw new WireDirectSendError(
        `Rail ${payment.rail} is not cleared by Direct Send (${config.rails.join(', ')})`,
        'WIRE_DIRECT_SEND_RAIL_NOT_CARRIED',
        409
      );
    }
    const rendered = await InHouseBankEngine.pacs008(paymentId);
    const pacs008 = typeof rendered === 'string' ? rendered : (rendered && (rendered.xml || rendered.message)) || '';
    if (!pacs008) {
      throw new WireDirectSendError(`No pacs.008 could be rendered for ${paymentId}`, 'WIRE_DIRECT_SEND_NO_MESSAGE', 500);
    }
    return { payment, pacs008 };
  }

  /**
   * Assemble a clearing file from dispatched wires, claiming each one in the
   * wire vault as it goes. Nothing is sent here: the file exists, is signed and
   * is balanced before anybody points it at a bank.
   */
  static async assemble({ actor = 'operator', limit = null, paymentIds = null } = {}) {
    await ensureTables();
    const config = getDirectSendConfig();
    const readiness = this.readiness();
    if (!readiness.ready) {
      throw new WireDirectSendError(
        `Direct Send is not configured: ${readiness.blockers.join('; ')}`,
        'WIRE_DIRECT_SEND_NOT_CONFIGURED',
        412,
        { blockers: readiness.blockers }
      );
    }

    const candidates = Array.isArray(paymentIds) && paymentIds.length
      ? paymentIds.map(paymentId => ({ paymentId }))
      : await this.pending({ limit });
    if (!candidates.length) {
      return { assembled: false, reason: 'no_dispatched_wires', batch: null, skipped: [] };
    }

    const batchId = newId('DSB');
    const createdAt = new Date();
    // The filename is fixed before anything is claimed, so the vault rows and
    // the file that carries them always name each other.
    const filename = filenameFor(batchId, createdAt, config);
    const owner = `${actor}@${process.pid}`;

    const members = [];
    const skipped = [];
    let totalCents = 0;

    for (const candidate of candidates.slice(0, config.maxItems)) {
      let prepared;
      try {
        prepared = await this._prepareMember(candidate.paymentId, config);
      } catch (error) {
        skipped.push({ paymentId: candidate.paymentId, reason: error.code || 'prepare_failed', detail: error.message });
        continue;
      }
      const { payment, pacs008 } = prepared;
      if (config.maxAmountCents && totalCents + Number(payment.amountCents) > config.maxAmountCents) {
        skipped.push({ paymentId: payment.paymentId, reason: 'file_amount_cap', detail: 'the file value cap would be exceeded' });
        continue;
      }

      let claim;
      try {
        claim = await WireIdempotencyVault.reserve({
          paymentId: payment.paymentId,
          filename: memberFilename(filename, payment.paymentId),
          payload: pacs008,
          payloadHash: hashPayload(pacs008),
          owner,
          rail: payment.rail,
          amountCents: payment.amountCents + payment.feeCents,
          currency: payment.currency,
          endToEndId: payment.endToEndId,
          uetr: payment.uetr,
          creditorName: payment.creditor && payment.creditor.name,
          creditorAccount: payment.creditor && payment.creditor.accountNumber,
        });
      } catch (error) {
        if (!(error instanceof WireVaultError)) throw error;
        skipped.push({ paymentId: payment.paymentId, reason: error.code, detail: error.message });
        continue;
      }

      if (!claim.reserved) {
        if (claim.reason === 'previous_attempt_failed') {
          // A payment whose earlier file never reached the bank may be cleared
          // in this one, through the same vault row.
          assertTransition(claim.transmission.state, 'reserved', claim.transmission);
          const retried = await WireIdempotencyVault.apply(claim.transmission.transmissionId, 'reserved', {
            actor,
            reason: `re-claimed for clearing file ${filename}`,
          });
          members.push({ payment, pacs008, transmission: retried });
          totalCents += Number(payment.amountCents);
          continue;
        }
        skipped.push({
          paymentId: payment.paymentId,
          reason: claim.reason,
          detail: `already claimed by transmission ${claim.transmission.transmissionId} (${claim.transmission.state})`,
        });
        continue;
      }

      members.push({ payment, pacs008, transmission: claim.transmission });
      totalCents += Number(payment.amountCents);
    }

    if (members.length < config.minItems) {
      // Give back anything claimed for a file that will not be built.
      for (const member of members) {
        await WireIdempotencyVault.apply(member.transmission.transmissionId, 'failed', {
          actor,
          reason: 'clearing file abandoned before it was built; the payment is released for a later file',
        });
      }
      return {
        assembled: false,
        reason: members.length ? 'below_minimum_items' : 'no_claimable_wires',
        batch: null,
        skipped,
      };
    }

    const file = buildClearingFile({ batchId, members, config, createdAt });
    const signature = signClearingFile(file.payload, config);
    if (config.requireSignature && !signature) {
      throw new WireDirectSendError(
        'Direct Send requires a signed clearing file but no signing key is configured',
        'WIRE_DIRECT_SEND_UNSIGNED',
        412
      );
    }
    const manifest = buildManifest({ file, members, signature, config });

    const rows = await pool.query(
      `INSERT INTO ihb_wire_direct_batches
        (batch_id, state, filename, payload, payload_hash, mode, endpoint, manifest,
         signature_algorithm, signature, item_count, total_amount_cents, currency, assembled_by)
       VALUES ($1,'assembled',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        batchId, file.filename, file.payload, file.payloadHash, config.mode,
        config.endpoint || null, JSON.stringify(manifest),
        signature ? signature.algorithm : null, signature ? signature.value : null,
        file.count, file.totalAmountCents, file.currency, actor,
      ]
    );
    const batch = mapBatch(rows.rows[0]);

    for (const member of members) {
      await pool.query(
        `INSERT INTO ihb_wire_direct_batch_items
          (batch_id, payment_id, transmission_id, amount_cents, currency, end_to_end_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          batchId, member.payment.paymentId, member.transmission.transmissionId,
          member.payment.amountCents, member.payment.currency,
          member.payment.endToEndId || member.payment.paymentId,
        ]
      );
    }

    await this._log(batch, {
      from: null,
      to: 'assembled',
      actor,
      reason: `clearing file assembled with ${file.count} wire(s)`,
      evidence: { payloadHash: file.payloadHash, totalAmountCents: file.totalAmountCents, skipped: skipped.length },
    });
    await DualLedgerEngine.appendEvent({
      eventType: 'wire.direct_send.assembled',
      actor,
      payload: {
        batchId,
        filename: file.filename,
        itemCount: file.count,
        totalAmountCents: file.totalAmountCents,
        payloadHash: file.payloadHash,
        paymentIds: members.map(m => m.payment.paymentId),
      },
    });

    return { assembled: true, reason: null, batch, skipped, items: members.map(m => m.payment.paymentId) };
  }

  /**
   * Push an assembled clearing file at the bank's pipeline. At most one file
   * ever leaves per batch row, and an ambiguous outcome parks the batch instead
   * of resending it.
   */
  static async send(batchId, { actor = 'operator' } = {}) {
    await ensureTables();
    const config = getDirectSendConfig();
    const stored = await this._require(batchId);

    if (['transmitted', 'acknowledged'].includes(stored.state)) {
      return { sent: false, replay: true, reason: 'already_transmitted', batch: stored };
    }
    if (stored.state === 'held') {
      return { sent: false, replay: false, reason: 'held_for_operator', batch: stored };
    }
    if (['rejected', 'cancelled'].includes(stored.state)) {
      return { sent: false, replay: false, reason: stored.state, batch: stored };
    }
    assertBatchTransition(stored.state, 'transmitting', stored);

    const items = await this.items(batchId);
    const target = config.mode === 'pipeline' ? config.endpoint : dropPathFor(config, getWireChannelConfig());
    await this._apply(batchId, 'transmitting', {
      actor,
      reason: `pushing ${stored.filename} to ${target}`,
      patch: { attempts: stored.attempts + 1, lastError: null },
    });
    for (const item of items) {
      const transmission = await WireIdempotencyVault.get(item.transmissionId);
      assertTransition(transmission.state, 'transmitting', transmission);
      await WireIdempotencyVault.apply(item.transmissionId, 'transmitting', {
        actor,
        reason: `clearing file ${stored.filename} is being sent to the bank pipeline`,
      });
    }

    // The bytes sent are the bytes stored at assembly, never re-rendered: the
    // signature and the hash the bank checks are over those exact bytes.
    const payloadRow = await pool.query('SELECT payload FROM ihb_wire_direct_batches WHERE batch_id = $1', [batchId]);
    const file = {
      batchId,
      filename: stored.filename,
      payload: payloadRow.rows[0].payload,
      payloadHash: stored.payloadHash,
      count: stored.itemCount,
      totalAmountCents: stored.totalAmountCents,
      currency: stored.currency,
      createdAt: stored.createdAt,
    };
    const signature = stored.signature ? { algorithm: stored.signatureAlgorithm, value: stored.signature } : null;

    let receipt;
    try {
      receipt = await transport.sendClearingFile({
        file,
        manifest: config.writeManifest ? stored.manifest : null,
        signature,
        config,
      });
    } catch (error) {
      const ambiguous = Boolean(error instanceof WireDirectSendTransportError && error.ambiguous);
      const held = await this._apply(batchId, ambiguous ? 'held' : 'failed', {
        actor,
        reason: ambiguous
          ? 'the pipeline may already hold this file; parked for an operator instead of resent'
          : 'the pipeline refused the file, so nothing was cleared',
        evidence: { error: error.message, code: error.code || null, detail: error.detail || null },
        patch: { lastError: error.message },
      });
      if (ambiguous) {
        await WireHostToHostEngine.raiseException({
          kind: 'direct_send_ambiguous',
          filename: stored.filename,
          detail: `${stored.filename} may have been ingested by the clearing pipeline: ${error.message}. Confirm with the bank before any resend.`,
          context: { batchId, itemCount: stored.itemCount, totalAmountCents: stored.totalAmountCents, code: error.code || null },
        });
      } else {
        // A clear refusal means nothing cleared: release the payments so a
        // later file can carry them.
        for (const item of items) {
          await WireIdempotencyVault.apply(item.transmissionId, 'failed', {
            actor,
            reason: `clearing file ${stored.filename} was refused by the bank pipeline`,
            patch: { lastError: error.message },
          });
        }
      }
      await DualLedgerEngine.appendEvent({
        eventType: ambiguous ? 'wire.direct_send.held' : 'wire.direct_send.failed',
        actor,
        payload: { batchId, filename: stored.filename, error: error.message, itemCount: stored.itemCount },
      });
      if (ambiguous) return { sent: false, replay: false, reason: 'held_for_operator', batch: held, error: error.message };
      throw error;
    }

    const transmitted = await this._apply(batchId, 'transmitted', {
      actor,
      reason: config.mode === 'pipeline' ? 'the clearing pipeline accepted the file' : 'the file was dropped on the bank host',
      evidence: receipt,
      patch: {
        bankReference: receipt.reference || null,
        remotePath: receipt.remotePath || null,
        archivePath: receipt.archivePath || null,
        receipt,
        transmittedAt: new Date().toISOString(),
      },
    });

    for (const item of items) {
      await WireIdempotencyVault.apply(item.transmissionId, 'transmitted', {
        actor,
        reason: `cleared in ${stored.filename}`,
        evidence: { batchId, receipt: receipt.reference || null, mode: receipt.mode },
        patch: { remotePath: receipt.remotePath || receipt.reference || stored.filename },
      });
      await DualLedgerEngine.appendEvent({
        eventType: 'wire.transmitted',
        paymentId: item.paymentId,
        actor,
        payload: {
          transmissionId: item.transmissionId,
          channel: 'direct-send',
          batchId,
          filename: stored.filename,
          payloadHash: stored.payloadHash,
          mode: receipt.mode,
          reference: receipt.reference || null,
        },
      });
    }

    await DualLedgerEngine.appendEvent({
      eventType: 'wire.direct_send.transmitted',
      actor,
      payload: {
        batchId,
        filename: stored.filename,
        mode: receipt.mode,
        reference: receipt.reference || null,
        itemCount: stored.itemCount,
        totalAmountCents: stored.totalAmountCents,
        payloadHash: stored.payloadHash,
      },
    });

    // A pipeline that echoes its own counts has told us whether the file
    // balances. Agreement is an acknowledgement; disagreement is an exception,
    // never a shrug.
    let acknowledged = transmitted;
    if (receipt.acceptedCount !== null && receipt.acceptedCount !== undefined) {
      if (Number(receipt.acceptedCount) === stored.itemCount) {
        acknowledged = await this._acknowledge(transmitted, { actor, receipt, reason: 'the pipeline balanced the file control totals' });
      } else {
        await WireHostToHostEngine.raiseException({
          kind: 'direct_send_control_mismatch',
          filename: stored.filename,
          detail: `The pipeline accepted ${receipt.acceptedCount} of ${stored.itemCount} wires in ${stored.filename}`,
          context: { batchId, acceptedCount: receipt.acceptedCount, itemCount: stored.itemCount, reference: receipt.reference || null },
        });
      }
    }

    return { sent: true, replay: false, reason: null, batch: acknowledged, receipt, items: items.map(i => i.paymentId) };
  }

  /** Assemble and send in one move: the whole no-portal path. */
  static async directSend({ actor = 'operator', limit = null, paymentIds = null } = {}) {
    const assembly = await this.assemble({ actor, limit, paymentIds });
    if (!assembly.assembled) return { ...assembly, sent: false };
    const sent = await this.send(assembly.batch.batchId, { actor });
    return { ...assembly, ...sent };
  }

  /**
   * Record the bank's file-level acknowledgement. Control totals are checked,
   * not trusted: a file the bank counted differently is an exception.
   */
  static async acknowledge(batchId, { actor = 'operator', reference = null, acceptedCount = null, totalAmountCents = null } = {}) {
    await ensureTables();
    const batch = await this._require(batchId);
    if (batch.state === 'acknowledged') return { acknowledged: false, replay: true, batch };
    if (batch.state !== 'transmitted') {
      throw new WireDirectSendError(
        `Clearing batch ${batchId} is ${batch.state}; only a transmitted file can be acknowledged`,
        'WIRE_DIRECT_SEND_NOT_TRANSMITTED',
        409
      );
    }
    const countMismatch = acceptedCount !== null && Number(acceptedCount) !== batch.itemCount;
    const amountMismatch = totalAmountCents !== null && Number(totalAmountCents) !== batch.totalAmountCents;
    if (countMismatch || amountMismatch) {
      const exception = await WireHostToHostEngine.raiseException({
        kind: 'direct_send_control_mismatch',
        filename: batch.filename,
        detail: `The bank acknowledged ${acceptedCount ?? batch.itemCount} wire(s) / ${totalAmountCents ?? batch.totalAmountCents} cents against ${batch.itemCount} / ${batch.totalAmountCents} sent`,
        context: { batchId, acceptedCount, totalAmountCents, reference },
      });
      return { acknowledged: false, replay: false, batch, exception };
    }
    const acknowledged = await this._acknowledge(batch, {
      actor,
      receipt: { reference, acceptedCount, totalAmountCents },
      reason: 'the bank acknowledged the clearing file',
    });
    return { acknowledged: true, replay: false, batch: acknowledged };
  }

  static async _acknowledge(batch, { actor, receipt, reason }) {
    const acknowledged = await this._apply(batch.batchId, 'acknowledged', {
      actor,
      reason,
      evidence: receipt || {},
      patch: {
        bankReference: (receipt && receipt.reference) || batch.bankReference || null,
        acknowledgedAt: new Date().toISOString(),
      },
    });
    await DualLedgerEngine.appendEvent({
      eventType: 'wire.direct_send.acknowledged',
      actor,
      payload: {
        batchId: batch.batchId,
        filename: batch.filename,
        reference: (receipt && receipt.reference) || null,
        itemCount: batch.itemCount,
      },
    });
    return acknowledged;
  }

  /**
   * Give up on an assembled or failed file and release its payments. Only ever
   * legal while the bank has certainly not seen the bytes.
   */
  static async cancel(batchId, { actor = 'operator', reason = 'cancelled by operator' } = {}) {
    await ensureTables();
    const batch = await this._require(batchId);
    assertBatchTransition(batch.state, 'cancelled', batch);
    const items = await this.items(batchId);
    for (const item of items) {
      const transmission = await WireIdempotencyVault.get(item.transmissionId);
      if (!transmission || transmission.state !== 'reserved') continue;
      await WireIdempotencyVault.apply(item.transmissionId, 'failed', {
        actor,
        reason: `clearing file ${batch.filename} cancelled; the payment is released for a later file`,
      });
    }
    const cancelled = await this._apply(batchId, 'cancelled', { actor, reason, patch: { lastError: reason } });
    return { cancelled: true, batch: cancelled, released: items.map(i => i.paymentId) };
  }

  /**
   * An operator has established with the bank what happened to a held file.
   * `received` means the pipeline has it and the batch is transmitted after
   * all; otherwise the file never cleared and its payments are released.
   */
  static async resolveHeld(batchId, { actor = 'operator', received, note }) {
    await ensureTables();
    if (typeof received !== 'boolean') {
      throw new WireDirectSendError(
        'resolveHeld needs an explicit received=true/false established with the bank',
        'WIRE_DIRECT_SEND_NO_DETERMINATION',
        400
      );
    }
    if (!note) {
      throw new WireDirectSendError('A note recording what the bank confirmed is required', 'WIRE_DIRECT_SEND_NO_NOTE', 400);
    }
    const batch = await this._require(batchId);
    if (batch.state !== 'held') {
      throw new WireDirectSendError(`Clearing batch ${batchId} is ${batch.state}, not held`, 'WIRE_DIRECT_SEND_NOT_HELD', 409);
    }
    const items = await this.items(batchId);

    if (received) {
      const transmitted = await this._apply(batchId, 'transmitted', {
        actor,
        reason: `operator confirmed with the bank that the pipeline holds the file: ${note}`,
        patch: { transmittedAt: new Date().toISOString() },
      });
      for (const item of items) {
        await WireIdempotencyVault.apply(item.transmissionId, 'transmitted', {
          actor,
          reason: `cleared in ${batch.filename}; confirmed with the bank`,
          evidence: { batchId, note },
          patch: { remotePath: batch.filename },
        });
      }
      return { resolved: true, received: true, batch: transmitted };
    }

    const failed = await this._apply(batchId, 'failed', {
      actor,
      reason: `operator confirmed with the bank that the file was never ingested: ${note}`,
      patch: { lastError: note },
    });
    for (const item of items) {
      await WireIdempotencyVault.apply(item.transmissionId, 'failed', {
        actor,
        reason: `clearing file ${batch.filename} never reached the pipeline; the payment is released for a later file`,
      });
    }
    return { resolved: true, received: false, batch: failed };
  }

  /**
   * Channel-level reconciliation. Everything it finds becomes a durable wire
   * exception in the same queue the host-to-host channel uses, because an
   * operator should not have two places to look.
   */
  static async reconcile({ actor = 'reconciliation' } = {}) {
    await ensureTables();
    const config = getDirectSendConfig();
    const findings = [];

    const unacknowledged = await pool.query(
      `SELECT * FROM ihb_wire_direct_batches
        WHERE state = 'transmitted'
          AND transmitted_at < NOW() - ($1 || ' minutes')::interval`,
      [String(config.receiptSlaMinutes)]
    );
    for (const row of unacknowledged.rows) {
      const batch = mapBatch(row);
      findings.push(await WireHostToHostEngine.raiseException({
        kind: 'direct_send_unacknowledged',
        filename: batch.filename,
        detail: `${batch.filename} was sent ${batch.transmittedAt} and the bank has not acknowledged it within ${config.receiptSlaMinutes} minutes`,
        context: { batchId: batch.batchId, itemCount: batch.itemCount, totalAmountCents: batch.totalAmountCents },
      }));
    }

    const stuck = await pool.query(
      `SELECT * FROM ihb_wire_direct_batches
        WHERE state = 'transmitting'
          AND updated_at < NOW() - ($1 || ' minutes')::interval`,
      [String(config.stuckMinutes)]
    );
    for (const row of stuck.rows) {
      const batch = mapBatch(row);
      findings.push(await WireHostToHostEngine.raiseException({
        kind: 'direct_send_stuck',
        filename: batch.filename,
        detail: `${batch.filename} has been transmitting since ${batch.updatedAt}; the sending process did not record an outcome and the pipeline may hold the file`,
        context: { batchId: batch.batchId, attempts: batch.attempts },
      }));
    }

    const held = await pool.query("SELECT * FROM ihb_wire_direct_batches WHERE state = 'held'");
    for (const row of held.rows) {
      const batch = mapBatch(row);
      findings.push(await WireHostToHostEngine.raiseException({
        kind: 'direct_send_ambiguous',
        filename: batch.filename,
        detail: `${batch.filename} is held pending a determination from the bank: ${batch.lastError || 'no pipeline response'}`,
        context: { batchId: batch.batchId, itemCount: batch.itemCount },
      }));
    }

    return { checked: new Date().toISOString(), findings, exceptions: findings.length };
  }

  static async items(batchId) {
    await ensureTables();
    const rows = await pool.query(
      'SELECT * FROM ihb_wire_direct_batch_items WHERE batch_id = $1 ORDER BY created_at ASC',
      [batchId]
    );
    return rows.rows.map(row => ({
      batchId: row.batch_id,
      paymentId: row.payment_id,
      transmissionId: row.transmission_id,
      amountCents: Number(row.amount_cents),
      currency: row.currency,
      endToEndId: row.end_to_end_id,
    }));
  }

  static async batch(batchId, { includePayload = false } = {}) {
    await ensureTables();
    const rows = await pool.query('SELECT * FROM ihb_wire_direct_batches WHERE batch_id = $1', [batchId]);
    const batch = mapBatch(rows.rows[0]);
    if (!batch) return null;
    const items = await this.items(batchId);
    const transmissions = [];
    for (const item of items) {
      transmissions.push(await WireIdempotencyVault.get(item.transmissionId));
    }
    return {
      ...batch,
      payload: includePayload ? rows.rows[0].payload : undefined,
      items,
      transmissions,
      history: await this.history(batchId),
    };
  }

  static async list({ state = null, limit = 50 } = {}) {
    await ensureTables();
    const rows = await pool.query(
      `SELECT * FROM ihb_wire_direct_batches
        WHERE ($1::text IS NULL OR state = $1)
        ORDER BY created_at DESC
        LIMIT $2`,
      [state, Math.min(Math.max(Number(limit) || 50, 1), 500)]
    );
    return rows.rows.map(mapBatch);
  }

  static async history(batchId) {
    await ensureTables();
    const rows = await pool.query('SELECT * FROM ihb_wire_direct_log WHERE batch_id = $1 ORDER BY created_at ASC', [batchId]);
    return rows.rows.map(row => ({
      logId: row.log_id,
      batchId: row.batch_id,
      from: row.from_state,
      to: row.to_state,
      actor: row.actor,
      reason: row.reason,
      evidence: row.evidence || {},
      createdAt: row.created_at,
    }));
  }

  /** Operator view of the clearing channel. */
  static async dashboard() {
    await ensureTables();
    const byState = await pool.query(
      `SELECT state, COUNT(*)::int AS count, COALESCE(SUM(total_amount_cents),0)::bigint AS amount_cents
         FROM ihb_wire_direct_batches GROUP BY state`
    );
    const pending = await this.pending();
    const open = await WireHostToHostEngine.exceptions({ resolved: false, limit: 100 });
    const mine = open.filter(exception => String(exception.kind).startsWith('direct_send_'));
    return {
      channel: this.readiness(),
      states: byState.rows.map(row => ({ state: row.state, count: row.count, amountCents: Number(row.amount_cents) })),
      pending: pending.length,
      pendingAmountCents: pending.reduce((sum, item) => sum + item.amountCents, 0),
      recent: await this.list({ limit: 10 }),
      openExceptions: mine.length,
      exceptions: mine,
    };
  }

  static async _require(batchId) {
    const rows = await pool.query('SELECT * FROM ihb_wire_direct_batches WHERE batch_id = $1', [batchId]);
    const batch = mapBatch(rows.rows[0]);
    if (!batch) {
      throw new WireDirectSendError(`Clearing batch ${batchId} not found`, 'WIRE_DIRECT_SEND_NOT_FOUND', 404);
    }
    return batch;
  }

  static async _apply(batchId, toState, { actor = null, reason = null, evidence = {}, patch = {} } = {}) {
    const before = await this._require(batchId);
    const columns = {
      bank_reference: patch.bankReference,
      remote_path: patch.remotePath,
      archive_path: patch.archivePath,
      last_error: patch.lastError,
      attempts: patch.attempts,
      transmitted_at: patch.transmittedAt,
      acknowledged_at: patch.acknowledgedAt,
      receipt: patch.receipt === undefined ? undefined : JSON.stringify(patch.receipt),
    };
    const sets = ['state = $2', 'updated_at = NOW()'];
    const values = [batchId, toState];
    for (const [column, value] of Object.entries(columns)) {
      if (value === undefined) continue;
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    }
    const rows = await pool.query(
      `UPDATE ihb_wire_direct_batches SET ${sets.join(', ')} WHERE batch_id = $1 RETURNING *`,
      values
    );
    const after = mapBatch(rows.rows[0]);
    await this._log(after, { from: before.state, to: toState, actor, reason, evidence });
    return after;
  }

  static async _log(batch, { from, to, actor = null, reason = null, evidence = {} }) {
    await pool.query(
      `INSERT INTO ihb_wire_direct_log (log_id, batch_id, from_state, to_state, actor, reason, evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [newId('DSL'), batch.batchId, from, to, actor, reason, JSON.stringify(evidence || {})]
    );
  }
}

module.exports = {
  WireDirectSendEngine,
  WireDirectSendError,
  WireClearingFileError,
  WireDirectSendTransportError,
  BATCH_TRANSITIONS,
  memberFilename,
};
