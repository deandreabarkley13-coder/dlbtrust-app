'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pool = require('../bonds/pgPool');
const { validateRouting } = require('../ach/nachaGenerator');
const { ACHEngine } = require('../ach/achEngine');
const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');
const { SubLedgerEngine } = require('../accounting/subLedgerEngine');
const { PaymentHubClient } = require('./paymentHubClient');
const { USAchConnector } = require('./usAchConnector');
const { getConfig, readiness } = require('./paymentHubConfig');
const paymentCrypto = require('./paymentCrypto');

const TRANSITIONS = Object.freeze({
  draft: new Set(['pending_approval', 'cancelled']),
  pending_approval: new Set(['approved', 'rejected', 'cancelled']),
  approved: new Set(['queued', 'cancelled']),
  queued: new Set(['orchestrating', 'transmitting', 'failed', 'cancelled']),
  orchestrating: new Set(['transmitting', 'transmitted', 'accepted', 'clearing', 'settled', 'returned', 'failed']),
  transmitting: new Set(['transmitted', 'accepted', 'clearing', 'settled', 'returned', 'failed']),
  transmitted: new Set(['accepted', 'clearing', 'settled', 'returned', 'failed']),
  accepted: new Set(['clearing', 'settled', 'returned', 'failed']),
  clearing: new Set(['settled', 'returned', 'failed']),
  settled: new Set(['returned']),
  returned: new Set([]),
  failed: new Set(['approved', 'cancelled']),
  rejected: new Set([]),
  cancelled: new Set([]),
});

const STATUS_RANK = Object.freeze({
  pending_approval: 0, approved: 1, queued: 2, orchestrating: 3, transmitting: 4,
  transmitted: 5, accepted: 6, clearing: 7, settled: 8,
});

const STATUS_TIMESTAMPS = Object.freeze({
  approved: 'approved_at',
  queued: 'queued_at',
  transmitted: 'transmitted_at',
  accepted: 'accepted_at',
  settled: 'settled_at',
  returned: 'returned_at',
  failed: 'failed_at',
  cancelled: 'cancelled_at',
});

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function identifier(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

function actorId(actor) {
  if (!actor) return 'system';
  if (typeof actor === 'string') return actor;
  return actor.username || actor.userId || actor.id || 'system';
}

function cents(input) {
  if (input.amountCents !== undefined) {
    const value = Number(input.amountCents);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('amountCents must be a positive integer');
    return value;
  }
  const raw = String(input.amount === undefined ? '' : input.amount).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw new Error('amount must be a positive USD value with at most two decimals');
  const [whole, fraction = ''] = raw.split('.');
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('amount is outside the supported range');
  return value;
}

function debitAccount(paymentType, provided) {
  if (provided) return String(provided);
  if (paymentType === 'trust_distribution' || paymentType === 'interest_payment') return '5100';
  return '5200';
}

function normalizeStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  const aliases = {
    submitted: 'orchestrating',
    processing: 'orchestrating',
    initiated: 'orchestrating',
    bank_transmitted: 'transmitted',
    acknowledged: 'accepted',
    completed: 'settled',
    successful: 'settled',
    reversed: 'returned',
    rejected: 'failed',
  };
  return aliases[value] || value;
}

function publicIntent(row) {
  if (!row) return null;
  return {
    intent_id: row.intent_id,
    idempotency_key: row.idempotency_key,
    status: row.status,
    rail: row.rail,
    payment_type: row.payment_type,
    amount_cents: Number(row.amount_cents),
    amount: (Number(row.amount_cents) / 100).toFixed(2),
    currency: row.currency,
    source_type: row.source_type,
    source_account_code: row.source_account_code,
    source_sub_ledger_id: row.source_sub_ledger_id,
    debit_account_code: row.debit_account_code,
    beneficiary_name: row.beneficiary_name,
    beneficiary_routing: `*****${row.beneficiary_routing_last4}`,
    beneficiary_account: `****${row.beneficiary_account_last4}`,
    beneficiary_account_type: row.beneficiary_account_type,
    sec_code: row.sec_code,
    effective_date: row.effective_date,
    description: row.description,
    maker_id: row.maker_id,
    approval_count: row.approval_count,
    required_approvals: row.required_approvals,
    payment_hub_txn_id: row.payment_hub_txn_id,
    ach_batch_id: row.ach_batch_id,
    remote_reference: row.remote_reference,
    accounting_status: row.accounting_status,
    journal_entry_id: row.journal_entry_id,
    error_code: row.error_code,
    error_message: row.error_message,
    metadata: row.metadata || {},
    approved_at: row.approved_at,
    queued_at: row.queued_at,
    transmitted_at: row.transmitted_at,
    accepted_at: row.accepted_at,
    settled_at: row.settled_at,
    returned_at: row.returned_at,
    failed_at: row.failed_at,
    cancelled_at: row.cancelled_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function internalIntent(row) {
  if (!row) return null;
  return {
    ...row,
    amount_cents: Number(row.amount_cents),
    beneficiary_routing: paymentCrypto.decrypt(row.beneficiary_routing_encrypted),
    beneficiary_account: paymentCrypto.decrypt(row.beneficiary_account_encrypted),
  };
}

class PaymentHubEngine {
  static async ensureTables() {
    if (process.env.NODE_ENV === 'production') paymentCrypto.validateConfiguration();
    const migration = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'migrate-payment-hub.sql'), 'utf8');
    await pool.query(migration);
  }

  static async createIntent(input, actor) {
    const maker = actorId(actor);
    const idempotencyKey = String(input.idempotencyKey || '').trim();
    const paymentType = String(input.paymentType || '').trim();
    const routing = String(input.beneficiaryRouting || '').replace(/\s/g, '');
    const account = String(input.beneficiaryAccount || '').replace(/\s/g, '');
    const beneficiaryName = String(input.beneficiaryName || '').trim();
    const accountType = input.beneficiaryAccountType || 'checking';
    const sourceType = input.sourceType || (input.sourceSubLedgerId ? 'sub_ledger' : 'trust_account');
    const sourceAccountCode = sourceType === 'trust_account' ? String(input.sourceAccountCode || '1000') : null;
    const sourceSubLedgerId = sourceType === 'sub_ledger' ? String(input.sourceSubLedgerId || '') : null;
    const amountCents = cents(input);
    const config = getConfig();

    if (!idempotencyKey || idempotencyKey.length > 128) throw new Error('Idempotency-Key is required and must be at most 128 characters');
    if (!paymentType || paymentType.length > 50) throw new Error('paymentType is required');
    if (!beneficiaryName || beneficiaryName.length > 100) throw new Error('beneficiaryName is required and must be at most 100 characters');
    if (!validateRouting(routing)) throw new Error('beneficiaryRouting must be a valid routing number');
    if (!/^\d{4,17}$/.test(account)) throw new Error('beneficiaryAccount must be 4-17 digits');
    if (!['checking', 'savings'].includes(accountType)) throw new Error('beneficiaryAccountType must be checking or savings');
    if (!['trust_account', 'sub_ledger'].includes(sourceType)) throw new Error('sourceType must be trust_account or sub_ledger');
    if (sourceType === 'sub_ledger' && !sourceSubLedgerId) throw new Error('sourceSubLedgerId is required');

    const secCode = input.secCode || 'CCD';
    if (!['CCD', 'PPD'].includes(secCode)) throw new Error('secCode must be CCD or PPD');
    const effectiveDate = input.effectiveDate || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) throw new Error('effectiveDate must use YYYY-MM-DD');
    const parsedEffectiveDate = new Date(`${effectiveDate}T00:00:00Z`);
    if (Number.isNaN(parsedEffectiveDate.getTime()) || parsedEffectiveDate.toISOString().slice(0, 10) !== effectiveDate) {
      throw new Error('effectiveDate must be a valid calendar date');
    }

    const canonical = {
      paymentType,
      amountCents,
      currency: input.currency || 'USD',
      sourceType,
      sourceAccountCode,
      sourceSubLedgerId,
      debitAccountCode: debitAccount(paymentType, input.debitAccountCode),
      beneficiaryName,
      routing,
      account,
      accountType,
      secCode,
      effectiveDate,
      description: String(input.description || '').trim(),
    };
    if (canonical.currency !== 'USD') throw new Error('Only USD payment instructions are supported');
    const requestHash = paymentCrypto.hash(JSON.stringify(canonical));

    const existing = await pool.query('SELECT * FROM payment_intents WHERE idempotency_key = $1', [idempotencyKey]);
    if (existing.rows.length) {
      if (existing.rows[0].request_hash !== requestHash) {
        const error = new Error('Idempotency-Key was already used for a different payment instruction');
        error.statusCode = 409;
        throw error;
      }
      return { intent: publicIntent(existing.rows[0]), idempotent: true };
    }

    const intentId = identifier('PHI');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO payment_intents (
          intent_id, idempotency_key, request_hash, status, rail, payment_type,
          amount_cents, currency, source_type, source_account_code, source_sub_ledger_id,
          debit_account_code, beneficiary_name, beneficiary_routing_encrypted,
          beneficiary_routing_hash, beneficiary_routing_last4, beneficiary_account_encrypted,
          beneficiary_account_hash, beneficiary_account_last4, beneficiary_account_type,
          sec_code, effective_date, description, maker_id, required_approvals, metadata
        ) VALUES (
          $1,$2,$3,'pending_approval','ach',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
          $15,$16,$17,$18,$19,$20,$21,$22,$23,$24
        ) RETURNING *`,
        [
          intentId, idempotencyKey, requestHash, paymentType, amountCents, canonical.currency,
          sourceType, sourceAccountCode, sourceSubLedgerId, canonical.debitAccountCode,
          beneficiaryName, paymentCrypto.encrypt(routing), paymentCrypto.hash(routing), routing.slice(-4),
          paymentCrypto.encrypt(account), paymentCrypto.hash(account), account.slice(-4), accountType,
          secCode, effectiveDate, canonical.description || null, maker, config.approvalThreshold,
          input.metadata || {},
        ]
      );
      await PaymentHubEngine._recordEvent(client, intentId, 'intent_created', null, 'pending_approval', maker, {
        amountCents,
        paymentType,
        rail: 'ach',
      });
      await client.query('COMMIT');
      return { intent: publicIntent(inserted.rows[0]), idempotent: false };
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') return PaymentHubEngine.createIntent(input, actor);
      throw err;
    } finally {
      client.release();
    }
  }

  static async approveIntent(intentId, actor, reason) {
    const approver = actorId(actor);
    const config = getConfig();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const intent = await PaymentHubEngine._lockIntent(client, intentId);
      if (intent.status !== 'pending_approval') throw new Error(`Intent is not pending approval: ${intent.status}`);
      if (!config.allowSelfApproval && intent.maker_id === approver) throw new Error('Maker cannot approve the same payment instruction');

      await client.query(
        `INSERT INTO payment_approvals (approval_id, intent_id, approver_id, decision, reason)
         VALUES ($1,$2,$3,'approved',$4)`,
        [identifier('APP'), intentId, approver, reason || null]
      );
      const countResult = await client.query(
        `SELECT COUNT(*)::int AS count FROM payment_approvals WHERE intent_id = $1 AND decision = 'approved'`,
        [intentId]
      );
      const count = Number(countResult.rows[0].count);
      let updated = intent;
      if (count >= intent.required_approvals) {
        updated = await PaymentHubEngine._transitionLocked(client, intent, 'approved', approver, 'approval_threshold_met', { count });
      } else {
        const result = await client.query(
          'UPDATE payment_intents SET approval_count = $2, updated_at = NOW(), version = version + 1 WHERE intent_id = $1 RETURNING *',
          [intentId, count]
        );
        updated = result.rows[0];
        await PaymentHubEngine._recordEvent(client, intentId, 'approval_recorded', intent.status, intent.status, approver, { count });
      }
      await client.query('COMMIT');
      return publicIntent(updated);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        const duplicate = new Error('This approver already made a decision for the payment instruction');
        duplicate.statusCode = 409;
        throw duplicate;
      }
      throw err;
    } finally {
      client.release();
    }
  }

  static async rejectIntent(intentId, actor, reason) {
    const approver = actorId(actor);
    if (!reason) throw new Error('A rejection reason is required');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const intent = await PaymentHubEngine._lockIntent(client, intentId);
      if (intent.status !== 'pending_approval') throw new Error(`Intent is not pending approval: ${intent.status}`);
      if (intent.maker_id === approver) throw new Error('Maker cannot reject the same payment instruction');
      await client.query(
        `INSERT INTO payment_approvals (approval_id, intent_id, approver_id, decision, reason)
         VALUES ($1,$2,$3,'rejected',$4)`,
        [identifier('APP'), intentId, approver, reason]
      );
      const updated = await PaymentHubEngine._transitionLocked(client, intent, 'rejected', approver, 'intent_rejected', { reason });
      await client.query('COMMIT');
      return publicIntent(updated);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  static async submitIntent(intentId, actor) {
    const operator = actorId(actor);
    const config = getConfig();
    const status = readiness();
    if (config.mode === 'disabled') throw new Error('Payment submission is disabled');
    if (!status.ready) throw new Error('Payment Hub is not ready: ' + status.issues.join('; '));

    const row = await PaymentHubEngine._getRow(intentId);
    if (!row) throw new Error(`Payment intent not found: ${intentId}`);
    if (row.status !== 'approved') throw new Error(`Payment intent must be approved before submission: ${row.status}`);

    if (config.mode === 'shadow') {
      await PaymentHubEngine._eventWithoutTransition(intentId, 'shadow_validation_passed', operator, { mode: 'shadow' });
      return { intent: publicIntent(row), shadow: true, transmitted: false };
    }
    if (!config.live) throw new Error('Payment transmission is blocked until PAYMENT_HUB_LIVE=true');
    const achReadiness = await USAchConnector.readiness();
    if (!achReadiness.ready) {
      throw new Error('U.S. ACH connector is not ready: ' + achReadiness.issues.join('; '));
    }

    await PaymentHubEngine._reserveAndQueue(intentId, operator);

    if (config.mode === 'phee') {
      await PaymentHubEngine._transition(intentId, 'orchestrating', operator, 'submitted_to_payment_hub', {});
      try {
        const intent = await PaymentHubEngine.getIntentInternal(intentId);
        const result = await PaymentHubClient.submit(intent);
        const updated = await pool.query(
          `UPDATE payment_intents SET payment_hub_txn_id = $2, remote_reference = $3,
           updated_at = NOW(), version = version + 1 WHERE intent_id = $1 RETURNING *`,
          [intentId, result.externalId, result.externalId]
        );
        await PaymentHubEngine._eventWithoutTransition(intentId, 'payment_hub_accepted', operator, {
          paymentHubTxnId: result.externalId,
          status: result.status,
        });
        return { intent: publicIntent(updated.rows[0]), paymentHub: result };
      } catch (err) {
        await PaymentHubEngine._fail(intentId, operator, 'PAYMENT_HUB_SUBMISSION_FAILED', err.message);
        throw err;
      }
    }

    return PaymentHubEngine.executeAchConnector(intentId, operator);
  }

  static async executeAchConnector(intentId, actor) {
    const operator = actorId(actor);
    const config = getConfig();
    const status = readiness();
    if (config.mode === 'disabled' || config.mode === 'shadow') {
      throw new Error(`ACH connector execution is blocked in ${config.mode} mode`);
    }
    if (!config.live) throw new Error('Payment transmission is blocked until PAYMENT_HUB_LIVE=true');
    if (!status.ready) throw new Error('Payment Hub is not ready: ' + status.issues.join('; '));
    const achReadiness = await USAchConnector.readiness();
    if (!achReadiness.ready) throw new Error('U.S. ACH connector is not ready: ' + achReadiness.issues.join('; '));
    const current = await PaymentHubEngine._getRow(intentId);
    if (!current) throw new Error(`Payment intent not found: ${intentId}`);
    if (!['queued', 'orchestrating'].includes(current.status)) {
      if (['transmitted', 'accepted', 'clearing', 'settled'].includes(current.status)) {
        return { intent: publicIntent(current), idempotent: true };
      }
      throw new Error(`ACH connector cannot execute an intent in ${current.status} status`);
    }

    await PaymentHubEngine._transition(intentId, 'transmitting', operator, 'ach_transmission_started', {});
    try {
      const intent = await PaymentHubEngine.getIntentInternal(intentId);
      const result = await USAchConnector.transmit(intent);
      await pool.query(
        `UPDATE payment_intents SET ach_batch_id = $2, remote_reference = COALESCE($3, remote_reference),
         updated_at = NOW(), version = version + 1 WHERE intent_id = $1`,
        [intentId, result.achBatchId, result.transmissionId]
      );
      const target = result.status === 'accepted' ? 'accepted' : 'transmitted';
      const updated = await PaymentHubEngine._transition(intentId, target, operator, 'ach_transmission_completed', {
        achBatchId: result.achBatchId,
        transmissionId: result.transmissionId,
      });
      return { intent: updated, connector: result };
    } catch (err) {
      await PaymentHubEngine._fail(intentId, operator, 'ACH_TRANSMISSION_FAILED', err.message);
      throw err;
    }
  }

  static async applyExternalEvent(event, actor = 'payment-hub-webhook') {
    const externalEventId = String(event.eventId || event.externalEventId || '').trim();
    const eventType = String(event.type || event.eventType || event.status || 'unknown');
    const payloadHash = paymentCrypto.hash(stableStringify(event));
    if (!externalEventId) throw new Error('eventId is required');

    const duplicate = await pool.query('SELECT * FROM payment_webhook_receipts WHERE external_event_id = $1', [externalEventId]);
    let receiptId;
    if (duplicate.rows.length) {
      const receipt = duplicate.rows[0];
      if (receipt.payload_hash !== payloadHash) {
        const conflict = new Error('Webhook event ID was reused with a different payload');
        conflict.statusCode = 409;
        throw conflict;
      }
      if (receipt.processing_status === 'processed') {
        const intent = receipt.intent_id ? await PaymentHubEngine.getIntent(receipt.intent_id) : null;
        return { intent, idempotent: true };
      }
      const pendingAgeMs = Date.now() - new Date(receipt.updated_at || receipt.received_at).getTime();
      if (receipt.processing_status === 'pending' && pendingAgeMs < getConfig().webhookMaxAgeSeconds * 1000) {
        return { intent: null, idempotent: true, processing: true };
      }
      receiptId = receipt.receipt_id;
      const claimed = await pool.query(
        `UPDATE payment_webhook_receipts SET processing_status = 'pending', error_message = NULL,
         processed_at = NULL, updated_at = NOW() WHERE receipt_id = $1
         AND (processing_status <> 'pending' OR updated_at < NOW() - ($2 || ' seconds')::interval)
         RETURNING receipt_id`,
        [receiptId, getConfig().webhookMaxAgeSeconds]
      );
      if (!claimed.rows.length) return { intent: null, idempotent: true, processing: true };
    } else {
      receiptId = identifier('WHR');
      try {
        await pool.query(
          `INSERT INTO payment_webhook_receipts
           (receipt_id, external_event_id, intent_id, event_type, payload_hash)
           VALUES ($1,$2,$3,$4,$5)`,
          [receiptId, externalEventId, event.intentId || null, eventType, payloadHash]
        );
      } catch (err) {
        if (err.code === '23505') return PaymentHubEngine.applyExternalEvent(event, actor);
        throw err;
      }
    }

    try {
      let row;
      if (event.intentId) row = await PaymentHubEngine._getRow(event.intentId);
      if (!row && event.paymentHubTxnId) {
        const found = await pool.query('SELECT * FROM payment_intents WHERE payment_hub_txn_id = $1', [event.paymentHubTxnId]);
        row = found.rows[0];
      }
      if (!row) throw new Error('No payment intent matches the external event');

      const target = normalizeStatus(event.status || event.type);
      const stale = target !== 'returned' && target !== 'failed' && row.status !== target &&
        STATUS_RANK[target] !== undefined && STATUS_RANK[row.status] !== undefined &&
        STATUS_RANK[target] < STATUS_RANK[row.status];
      if (stale) {
        await PaymentHubEngine._eventWithoutTransition(row.intent_id, 'stale_external_status_ignored', actorId(actor), {
          externalEventId,
          eventType,
          target,
        }, externalEventId);
        await pool.query(
          `UPDATE payment_webhook_receipts SET intent_id = $2, processing_status = 'processed',
           processed_at = NOW(), updated_at = NOW() WHERE receipt_id = $1`,
          [receiptId, row.intent_id]
        );
        return { intent: publicIntent(row), idempotent: true, stale: true };
      }
      if (!TRANSITIONS[row.status] || (!TRANSITIONS[row.status].has(target) && row.status !== target)) {
        throw new Error(`External status transition is not allowed: ${row.status} -> ${target}`);
      }

      if (row.ach_batch_id) await PaymentHubEngine._syncAchBatch(row.ach_batch_id, target, event);
      let intent = row.status === target
        ? publicIntent(row)
        : await PaymentHubEngine._transition(row.intent_id, target, actorId(actor), 'external_status_received', {
            externalEventId,
            eventType,
          }, externalEventId);

      if (target === 'settled') {
        await PaymentHubEngine._captureHold(row.intent_id);
        await PaymentHubEngine.postSettlementAccounting(row.intent_id, actorId(actor));
        intent = await PaymentHubEngine.getIntent(row.intent_id);
      } else if (target === 'returned') {
        await PaymentHubEngine._handleReturn(row.intent_id, actorId(actor), event);
        intent = await PaymentHubEngine.getIntent(row.intent_id);
      }

      await PaymentHubEngine._syncLinkedRecords(row.intent_id);
      await pool.query(
        `UPDATE payment_webhook_receipts SET intent_id = $2, processing_status = 'processed', processed_at = NOW(), updated_at = NOW()
         WHERE receipt_id = $1`,
        [receiptId, row.intent_id]
      );
      return { intent, idempotent: false };
    } catch (err) {
      await pool.query(
        `UPDATE payment_webhook_receipts SET processing_status = 'failed', error_message = $2, processed_at = NOW(), updated_at = NOW()
         WHERE receipt_id = $1`,
        [receiptId, err.message]
      );
      throw err;
    }
  }

  static async postSettlementAccounting(intentId, actor) {
    const claimed = await pool.query(
      `UPDATE payment_intents SET accounting_status = 'posting', accounting_error = NULL,
       updated_at = NOW(), version = version + 1
       WHERE intent_id = $1 AND status = 'settled'
         AND (accounting_status IN ('pending','failed')
           OR (accounting_status = 'posting' AND updated_at < NOW() - INTERVAL '5 minutes'))
       RETURNING *`,
      [intentId]
    );
    if (!claimed.rows.length) {
      const current = await PaymentHubEngine._getRow(intentId);
      if (!current) throw new Error(`Payment intent not found: ${intentId}`);
      if (current.status !== 'settled') throw new Error('Settlement accounting requires a settled payment intent');
      if (current.accounting_status === 'posted' || current.accounting_status === 'posting') return publicIntent(current);
      throw new Error(`Settlement accounting cannot run in ${current.accounting_status} status`);
    }

    const row = claimed.rows[0];
    try {
      const existing = await pool.query(
        `SELECT entry_id FROM trust_journal_entries
         WHERE reference_type = 'payment_hub_intent' AND reference_id = $1 AND status = 'posted'
         ORDER BY created_at DESC LIMIT 1`,
        [intentId]
      );
      let journalEntryId = existing.rows[0] ? existing.rows[0].entry_id : null;
      let sourceAccount = row.source_account_code;

      if (row.source_type === 'sub_ledger') {
        const ledger = await SubLedgerEngine.getSubLedger(row.source_sub_ledger_id);
        if (!ledger) throw new Error(`Funding sub-ledger not found: ${row.source_sub_ledger_id}`);
        sourceAccount = ledger.parent_account_code;
        const prior = await pool.query(
          `SELECT transaction_id FROM sub_ledger_transactions
           WHERE reference_type = 'payment_hub_intent' AND reference_id = $1 LIMIT 1`,
          [intentId]
        );
        if (!prior.rows.length) {
          await SubLedgerEngine.postTransaction({
            subLedgerId: row.source_sub_ledger_id,
            transactionType: 'distribution',
            amount: Number(row.amount_cents) / 100,
            description: row.description || row.payment_type,
            referenceType: 'payment_hub_intent',
            referenceId: intentId,
            postedBy: actor,
            postToFineract: false,
          });
        }
      }

      if (!journalEntryId) {
        const journal = await TrustAccountingEngine.postJournalEntry({
          entryDate: row.settled_at || new Date(),
          description: `Settled ${row.payment_type.replace(/_/g, ' ')}: ${row.description || row.beneficiary_name}`,
          lines: [
            {
              accountCode: row.debit_account_code,
              debitAmount: Number(row.amount_cents) / 100,
              creditAmount: 0,
              memo: `Payment Hub intent ${intentId}`,
            },
            {
              accountCode: sourceAccount,
              debitAmount: 0,
              creditAmount: Number(row.amount_cents) / 100,
              memo: `Settled ACH ${row.ach_batch_id || intentId}`,
            },
          ],
          referenceType: 'payment_hub_intent',
          referenceId: intentId,
          postedBy: actor,
          postToFineract: false,
        });
        journalEntryId = journal.entry_id;
      }

      await pool.query(
        `UPDATE payment_intents SET accounting_status = 'posted', journal_entry_id = $2,
         accounting_error = NULL, updated_at = NOW(), version = version + 1 WHERE intent_id = $1`,
        [intentId, journalEntryId]
      );
      await PaymentHubEngine._eventWithoutTransition(intentId, 'settlement_accounting_posted', actor, { journalEntryId });
      await PaymentHubEngine._syncLinkedRecords(intentId);
      return PaymentHubEngine.getIntent(intentId);
    } catch (err) {
      await pool.query(
        `UPDATE payment_intents SET accounting_status = 'failed', accounting_error = $2,
         updated_at = NOW(), version = version + 1 WHERE intent_id = $1`,
        [intentId, err.message]
      );
      await PaymentHubEngine._eventWithoutTransition(intentId, 'settlement_accounting_failed', actor, { error: err.message });
      throw err;
    }
  }

  static async cancelIntent(intentId, actor, reason) {
    const row = await PaymentHubEngine._getRow(intentId);
    if (!row) throw new Error(`Payment intent not found: ${intentId}`);
    if (!['draft', 'pending_approval', 'approved', 'queued'].includes(row.status)) {
      throw new Error(`Payment intent cannot be cancelled in ${row.status} status`);
    }
    const result = await PaymentHubEngine._transition(intentId, 'cancelled', actorId(actor), 'intent_cancelled', { reason: reason || null });
    await PaymentHubEngine._releaseHold(intentId, 'cancelled');
    return result;
  }

  static async retryIntent(intentId, actor) {
    const operator = actorId(actor);
    const row = await PaymentHubEngine._getRow(intentId);
    if (!row) throw new Error(`Payment intent not found: ${intentId}`);
    if (row.status !== 'failed') throw new Error(`Only failed payment intents can be retried: ${row.status}`);
    if (row.payment_hub_txn_id) throw new Error('Payment Hub accepted this instruction; reconcile its status instead of retrying');
    if (process.env.NODE_ENV === 'production') {
      const existingBatch = await pool.query(
        'SELECT batch_id FROM ach_batches WHERE payment_intent_id = $1 LIMIT 1',
        [intentId]
      );
      if (existingBatch.rows.length) {
        throw new Error('ACH transmission was attempted; reconcile the bank status instead of retrying');
      }
    }
    await pool.query(
      `UPDATE payment_intents SET error_code = NULL, error_message = NULL,
       updated_at = NOW(), version = version + 1 WHERE intent_id = $1`,
      [intentId]
    );
    await PaymentHubEngine._transition(intentId, 'approved', operator, 'payment_retry_authorized', {});
    return PaymentHubEngine.submitIntent(intentId, operator);
  }

  static async retryAccounting(intentId, actor) {
    return PaymentHubEngine.postSettlementAccounting(intentId, actorId(actor));
  }

  static async getIntent(intentId) {
    return publicIntent(await PaymentHubEngine._getRow(intentId));
  }

  static async getIntentInternal(intentId) {
    return internalIntent(await PaymentHubEngine._getRow(intentId));
  }

  static async listIntents(filters = {}) {
    const conditions = ['1=1'];
    const params = [];
    let index = 1;
    if (filters.status) {
      conditions.push(`status = $${index++}`);
      params.push(filters.status);
    }
    if (filters.paymentType) {
      conditions.push(`payment_type = $${index++}`);
      params.push(filters.paymentType);
    }
    const limit = Math.min(Math.max(Number.parseInt(filters.limit, 10) || 50, 1), 200);
    const offset = Math.max(Number.parseInt(filters.offset, 10) || 0, 0);
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT * FROM payment_intents WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC LIMIT $${index++} OFFSET $${index}`,
      params
    );
    return result.rows.map(publicIntent);
  }

  static async getEvents(intentId) {
    const result = await pool.query(
      `SELECT event_id, event_type, from_status, to_status, actor_id, external_event_id,
              payload, previous_hash, event_hash, created_at
       FROM payment_events WHERE intent_id = $1 ORDER BY id`,
      [intentId]
    );
    return result.rows;
  }

  static async dashboard() {
    const [statusCounts, totals, accounting, holds, webhookFailures] = await Promise.all([
      pool.query('SELECT status, COUNT(*)::int AS count FROM payment_intents GROUP BY status'),
      pool.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(amount_cents),0)::bigint AS amount_cents
                  FROM payment_intents WHERE status = 'settled'`),
      pool.query(`SELECT accounting_status, COUNT(*)::int AS count FROM payment_intents GROUP BY accounting_status`),
      pool.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(amount_cents),0)::bigint AS amount_cents
                  FROM payment_funding_holds WHERE status = 'active'`),
      pool.query(`SELECT COUNT(*)::int AS count FROM payment_webhook_receipts WHERE processing_status = 'failed'`),
    ]);
    const ach = await USAchConnector.readiness().catch(err => ({ ready: false, issues: [err.message] }));
    return {
      readiness: readiness(),
      achConnector: ach,
      statuses: Object.fromEntries(statusCounts.rows.map(row => [row.status, Number(row.count)])),
      settled: { count: Number(totals.rows[0].count), amountCents: Number(totals.rows[0].amount_cents) },
      accounting: Object.fromEntries(accounting.rows.map(row => [row.accounting_status, Number(row.count)])),
      activeHolds: { count: Number(holds.rows[0].count), amountCents: Number(holds.rows[0].amount_cents) },
      failedWebhooks: Number(webhookFailures.rows[0].count),
    };
  }

  static async verifyAuditChain(intentId) {
    const events = await PaymentHubEngine.getEvents(intentId);
    let previousHash = null;
    for (const event of events) {
      const calculated = PaymentHubEngine._eventHash({
        intentId,
        eventId: event.event_id,
        eventType: event.event_type,
        fromStatus: event.from_status,
        toStatus: event.to_status,
        actor: event.actor_id,
        externalEventId: event.external_event_id,
        payload: event.payload,
        previousHash,
        createdAt: new Date(event.created_at).toISOString(),
      });
      if (event.previous_hash !== previousHash || event.event_hash !== calculated) {
        return { valid: false, eventId: event.event_id };
      }
      previousHash = event.event_hash;
    }
    return { valid: true, eventCount: events.length, latestHash: previousHash };
  }

  static async _getRow(intentId) {
    const result = await pool.query('SELECT * FROM payment_intents WHERE intent_id = $1', [intentId]);
    return result.rows[0] || null;
  }

  static async _lockIntent(client, intentId) {
    const result = await client.query('SELECT * FROM payment_intents WHERE intent_id = $1 FOR UPDATE', [intentId]);
    if (!result.rows.length) throw new Error(`Payment intent not found: ${intentId}`);
    return result.rows[0];
  }

  static async _transition(intentId, target, actor, eventType, payload, externalEventId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const intent = await PaymentHubEngine._lockIntent(client, intentId);
      const updated = await PaymentHubEngine._transitionLocked(client, intent, target, actor, eventType, payload, externalEventId);
      await client.query('COMMIT');
      return publicIntent(updated);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  static async _transitionLocked(client, intent, target, actor, eventType, payload, externalEventId) {
    if (!TRANSITIONS[intent.status] || !TRANSITIONS[intent.status].has(target)) {
      throw new Error(`Payment status transition is not allowed: ${intent.status} -> ${target}`);
    }
    const timestampColumn = STATUS_TIMESTAMPS[target];
    const timestampSql = timestampColumn ? `, ${timestampColumn} = NOW()` : '';
    const result = await client.query(
      `UPDATE payment_intents SET status = $2, approval_count = CASE WHEN $2 = 'approved' THEN required_approvals ELSE approval_count END,
       updated_at = NOW(), version = version + 1${timestampSql} WHERE intent_id = $1 RETURNING *`,
      [intent.intent_id, target]
    );
    await PaymentHubEngine._recordEvent(
      client, intent.intent_id, eventType, intent.status, target, actor, payload || {}, externalEventId
    );
    return result.rows[0];
  }

  static async _eventWithoutTransition(intentId, eventType, actor, payload, externalEventId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const intent = await PaymentHubEngine._lockIntent(client, intentId);
      await PaymentHubEngine._recordEvent(client, intentId, eventType, intent.status, intent.status, actor, payload || {}, externalEventId);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  static async _recordEvent(client, intentId, eventType, fromStatus, toStatus, actor, payload, externalEventId) {
    const previous = await client.query(
      'SELECT event_hash FROM payment_events WHERE intent_id = $1 ORDER BY id DESC LIMIT 1',
      [intentId]
    );
    const previousHash = previous.rows[0] ? previous.rows[0].event_hash : null;
    const eventId = identifier('PHE');
    const createdAt = new Date().toISOString();
    const eventHash = PaymentHubEngine._eventHash({
      intentId,
      eventId,
      eventType,
      fromStatus,
      toStatus,
      actor,
      externalEventId: externalEventId || null,
      payload: payload || {},
      previousHash,
      createdAt,
    });
    await client.query(
      `INSERT INTO payment_events
       (event_id, intent_id, event_type, from_status, to_status, actor_id, external_event_id,
        payload, previous_hash, event_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [eventId, intentId, eventType, fromStatus, toStatus, actor, externalEventId || null,
       payload || {}, previousHash, eventHash, createdAt]
    );
  }

  static _eventHash(event) {
    return paymentCrypto.hash(stableStringify([
      event.intentId,
      event.eventId,
      event.eventType,
      event.fromStatus,
      event.toStatus,
      event.actor,
      event.externalEventId,
      event.payload || {},
      event.previousHash,
      event.createdAt,
    ]));
  }

  static async _reserveAndQueue(intentId, actor) {
    const config = getConfig();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const intent = await PaymentHubEngine._lockIntent(client, intentId);
      if (intent.status !== 'approved') throw new Error(`Payment intent is not approved: ${intent.status}`);
      const sourceId = intent.source_type === 'sub_ledger' ? intent.source_sub_ledger_id : intent.source_account_code;
      let balance;
      if (intent.source_type === 'sub_ledger') {
        const result = await client.query(
          `SELECT balance, status FROM client_sub_ledgers WHERE sub_ledger_id = $1 FOR UPDATE`,
          [sourceId]
        );
        if (!result.rows.length) throw new Error(`Funding sub-ledger not found: ${sourceId}`);
        if (result.rows[0].status !== 'active') throw new Error(`Funding sub-ledger is ${result.rows[0].status}`);
        balance = Number(result.rows[0].balance);
      } else {
        const result = await client.query(
          `SELECT balance, is_active FROM trust_accounts WHERE account_code = $1 FOR UPDATE`,
          [sourceId]
        );
        if (!result.rows.length) throw new Error(`Funding trust account not found: ${sourceId}`);
        if (!result.rows[0].is_active) throw new Error('Funding trust account is inactive');
        balance = Number(result.rows[0].balance);
      }
      const held = await client.query(
        `SELECT COALESCE(SUM(amount_cents),0)::bigint AS amount_cents
         FROM payment_funding_holds WHERE source_type = $1 AND source_id = $2
           AND status = 'active'`,
        [intent.source_type, sourceId]
      );
      const availableCents = Math.round(balance * 100) - Number(held.rows[0].amount_cents);
      if (availableCents < Number(intent.amount_cents)) {
        throw new Error(`Insufficient cleared funds: available ${(availableCents / 100).toFixed(2)} USD`);
      }

      const holdId = identifier('HOLD');
      await client.query(
        `INSERT INTO payment_funding_holds
         (hold_id, intent_id, source_type, source_id, amount_cents, expires_at)
         VALUES ($1,$2,$3,$4,$5,NOW() + ($6 || ' hours')::interval)`,
        [holdId, intentId, intent.source_type, sourceId, intent.amount_cents, config.holdHours]
      );
      await client.query('UPDATE payment_intents SET hold_id = $2 WHERE intent_id = $1', [intentId, holdId]);
      await PaymentHubEngine._transitionLocked(client, intent, 'queued', actor, 'funding_reserved', {
        holdId,
        sourceType: intent.source_type,
        sourceId,
        amountCents: Number(intent.amount_cents),
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  static async _captureHold(intentId) {
    await pool.query(
      `UPDATE payment_funding_holds SET status = 'captured', captured_at = NOW(), updated_at = NOW()
       WHERE intent_id = $1 AND status = 'active'`,
      [intentId]
    );
  }

  static async _releaseHold(intentId, reason) {
    await pool.query(
      `UPDATE payment_funding_holds SET status = 'released', released_at = NOW(), release_reason = $2, updated_at = NOW()
       WHERE intent_id = $1 AND status = 'active'`,
      [intentId, reason]
    );
  }

  static async _fail(intentId, actor, code, message) {
    const row = await PaymentHubEngine._getRow(intentId);
    if (row && TRANSITIONS[row.status] && TRANSITIONS[row.status].has('failed')) {
      await pool.query(
        'UPDATE payment_intents SET error_code = $2, error_message = $3 WHERE intent_id = $1',
        [intentId, code, message]
      );
      await PaymentHubEngine._transition(intentId, 'failed', actor, 'payment_failed', { code, message });
    }
  }

  static async _syncAchBatch(batchId, target, event) {
    const batch = await ACHEngine.getBatch(batchId);
    if (!batch) throw new Error(`ACH batch not found: ${batchId}`);
    if (target === 'accepted' && batch.status === 'transmitted') {
      await ACHEngine.acceptBatch(batchId, {
        ackType: 'bank_ack',
        messageId: event.eventId,
        rawResponse: JSON.stringify(event).substring(0, 4000),
      });
    }
    if (target === 'settled' && batch.status !== 'settled') {
      if (batch.status === 'transmitted') await ACHEngine.acceptBatch(batchId, { skipAckRecord: true });
      await ACHEngine.settleBatch(batchId, {
        settlementDate: event.settlementDate,
        settlementRef: event.eventId || event.externalEventId,
        processorConfirmed: true,
      });
    }
    if (target === 'returned' && batch.status !== 'returned') {
      const returns = Array.isArray(event.returnEntries) && event.returnEntries.length
        ? event.returnEntries
        : [{
            entrySequence: 1,
            returnCode: event.returnCode || 'R00',
            returnReason: event.returnReason || 'Bank return',
            returnAmountCents: event.amountCents,
          }];
      await ACHEngine.processReturns(batchId, returns, { returnFileRef: event.returnFileRef });
    }
  }

  static async _syncLinkedRecords(intentId) {
    const row = await PaymentHubEngine._getRow(intentId);
    if (!row) return;
    const settlementStatus = {
      pending_approval: 'submitted', approved: 'submitted', queued: 'submitted',
      orchestrating: 'transmitted', transmitting: 'transmitted', transmitted: 'transmitted',
      accepted: 'accepted', clearing: 'clearing', settled: 'settled', returned: 'returned', failed: 'failed',
      rejected: 'failed', cancelled: 'failed',
    }[row.status] || 'submitted';
    const tables = await pool.query(
      `SELECT to_regclass('electronic_settlements') AS electronic_settlements,
              to_regclass('vendor_payments') AS vendor_payments`
    );
    if (tables.rows[0].electronic_settlements) {
      await pool.query(
        `UPDATE electronic_settlements SET status = $2, payment_hub_status = $3,
         payment_hub_txn_id = $4, ach_batch_id = $5, journal_entry_id = $6,
         settled_at = CASE WHEN $2 = 'settled' THEN COALESCE(settled_at, NOW()) ELSE settled_at END,
         updated_at = NOW() WHERE payment_intent_id = $1`,
        [intentId, settlementStatus, row.status, row.payment_hub_txn_id, row.ach_batch_id, row.journal_entry_id]
      );
    }
    const vendorStatus = row.status === 'settled' ? 'settled'
      : ['returned', 'failed', 'rejected', 'cancelled'].includes(row.status) ? 'failed'
      : 'processing';
    if (tables.rows[0].vendor_payments) {
      await pool.query(
        `UPDATE vendor_payments SET status = $2, ach_batch_id = $3, journal_entry_id = $4,
         settled_at = CASE WHEN $2 = 'settled' THEN COALESCE(settled_at, NOW()) ELSE settled_at END,
         updated_at = NOW() WHERE payment_intent_id = $1`,
        [intentId, vendorStatus, row.ach_batch_id, row.journal_entry_id]
      );
    }
  }

  static async _handleReturn(intentId, actor, event) {
    const row = await PaymentHubEngine._getRow(intentId);
    if (!row) return;
    if (row.accounting_status === 'posted' && row.journal_entry_id) {
      const existingReversal = await pool.query(
        `SELECT entry_id FROM trust_journal_entries
         WHERE reference_type = 'reversal' AND reference_id = $1 AND status = 'posted'
         ORDER BY created_at DESC LIMIT 1`,
        [row.journal_entry_id]
      );
      const reversal = existingReversal.rows.length
        ? { entry_id: existingReversal.rows[0].entry_id }
        : await TrustAccountingEngine.reverseJournalEntry(row.journal_entry_id, { postedBy: actor });
      if (row.source_type === 'sub_ledger') {
        const prior = await pool.query(
          `SELECT transaction_id FROM sub_ledger_transactions
           WHERE reference_type = 'payment_hub_return' AND reference_id = $1 LIMIT 1`,
          [intentId]
        );
        if (!prior.rows.length) {
          await SubLedgerEngine.postTransaction({
            subLedgerId: row.source_sub_ledger_id,
            transactionType: 'credit',
            amount: Number(row.amount_cents) / 100,
            description: `ACH return ${event.returnCode || ''}`.trim(),
            referenceType: 'payment_hub_return',
            referenceId: intentId,
            postedBy: actor,
            postToFineract: false,
          });
        }
      }
      await pool.query(
        `UPDATE payment_intents SET accounting_status = 'reversed', journal_entry_id = $2,
         updated_at = NOW(), version = version + 1 WHERE intent_id = $1`,
        [intentId, reversal.entry_id]
      );
      await PaymentHubEngine._eventWithoutTransition(intentId, 'settlement_accounting_reversed', actor, {
        returnCode: event.returnCode || null,
        reversalEntryId: reversal.entry_id,
      });
    } else if (row.accounting_status !== 'reversed') {
      await PaymentHubEngine._releaseHold(intentId, 'returned');
    }
  }
}

module.exports = {
  PaymentHubEngine,
  TRANSITIONS,
  normalizeStatus,
  publicIntent,
  cents,
};
