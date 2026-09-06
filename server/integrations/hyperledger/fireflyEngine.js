'use strict';

/**
 * Hyperledger FireFly — the counterparty half of settlement.
 *
 * Fabric (see fabricLedgerEngine) closes the trust's *own* evidence gap. It
 * says nothing to anybody else. Every counterparty handoff in this platform is
 * still a file or a form: a NACHA file over AS2, a CSV an operator downloads,
 * a wire an officer keys in. The counterparty gets the money and, separately
 * and unverifiably, gets told what it was for.
 *
 * FireFly is a supernode that collapses those two into one flow over its REST
 * API, against the same permissioned network:
 *
 *   POST /messages/private          settlement instruction to a named org, with
 *                                   the payload broadcast off-chain and only its
 *                                   hash pinned on the ledger (privacy + proof)
 *   GET  /status                    node, org and namespace identity
 *   GET  /tokens/pools              tokenized value the trust can move
 *   POST /tokens/transfers          transfer with a message attached, so value
 *                                   and remittance advice commit together
 *   POST /subscriptions             event stream the trust books from
 *
 * Booking follows confirmation, never submission. A transfer posts its journal
 * entry when FireFly emits `token_transfer_confirmed` for it (webhook or a
 * `sync` poll), exactly once, guarded by a `booked` flag — the same discipline
 * the thirdweb rails use. A rejected or failed transfer books nothing.
 *
 * Gating: FIREFLY_LIVE must be true to move tokens. Messages are informational
 * (they move no value) so they follow the node's reachability, not the money
 * gate; a transfer without the gate returns a plan.
 */

const crypto = require('crypto');

const { FabricLedgerEngine, digestOf } = require('./fabricLedgerEngine');
const { SourceOfFundsAdapter } = require('../stablecoin/sourceOfFundsAdapter');
const { CanonicalFundingSource } = require('../fineract/canonicalFundingSource');

let TrustAccountingEngine = null;
try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { /* optional */ }

let pool = null;
try { pool = require('../bonds/pgPool'); } catch (e) { /* no DB in tests */ }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

const CANONICAL_SOURCE_TYPES = new Set(['canonical', 'erp', 'core_banking_canonical']);
const CONFIRMED_EVENTS = new Set(['token_transfer_confirmed']);
const FAILED_EVENTS = new Set(['token_transfer_op_failed', 'token_transfer_failed']);

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function num(name, def = 0) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : def; }
function toCents(usd) { return Math.round((Number(usd) || 0) * 100); }
function fromCents(cents) { return (Number(cents) || 0) / 100; }
function reject(message, code, status = 422) { return Object.assign(new Error(message), { code, status }); }
function id(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

let tablesReady = null;
async function ensureTables() {
  if (!pool || !pool.query) return;
  if (tablesReady) return tablesReady;
  tablesReady = pool.query(`
    CREATE TABLE IF NOT EXISTS firefly_settlements (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      reference TEXT NOT NULL,
      namespace TEXT NOT NULL,
      pool TEXT,
      counterparty TEXT,
      amount_cents BIGINT NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      source_type TEXT,
      source_account_id TEXT,
      status TEXT NOT NULL,
      booked BOOLEAN NOT NULL DEFAULT FALSE,
      firefly_id TEXT,
      transfer_id TEXT,
      message_id TEXT,
      tx_hash TEXT,
      instruction_digest TEXT,
      notarization_id TEXT,
      journal_entry_id TEXT,
      failure_reason TEXT,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      requested_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS firefly_settlements_reference_idx
      ON firefly_settlements (kind, reference);
    CREATE INDEX IF NOT EXISTS firefly_settlements_transfer_idx
      ON firefly_settlements (transfer_id);
  `).catch((e) => { tablesReady = null; throw e; });
  return tablesReady;
}

const memorySettlements = [];

class FireflyEngine {
  static getConfig() {
    return {
      system: 'hyperledger-firefly',
      apiUrl: str('FIREFLY_API_URL').replace(/\/+$/, ''),
      apiKey: str('FIREFLY_API_KEY'),
      namespace: str('FIREFLY_NAMESPACE', 'default'),
      // Token pool the trust settles from (a tokenized deposit / stablecoin pool).
      pool: str('FIREFLY_TOKEN_POOL'),
      // Org identity of the settlement counterparty (partner bank, co-trustee).
      counterparty: str('FIREFLY_COUNTERPARTY_ORG'),
      signingKey: str('FIREFLY_SIGNING_KEY'),
      // Minor units per unit of value in the pool (2 = cents, 6 = USDC-style).
      tokenDecimals: num('FIREFLY_TOKEN_DECIMALS', 2),
      datatype: str('FIREFLY_INSTRUCTION_DATATYPE', 'settlement_instruction'),
      topic: str('FIREFLY_TOPIC', 'trust-settlement'),
      webhookSecret: str('FIREFLY_WEBHOOK_SECRET'),
      subscriptionName: str('FIREFLY_SUBSCRIPTION_NAME', 'dlbtrust-settlement'),
      // Where a confirmed transfer lands in the trust's books.
      tokenAccountCode: str('FIREFLY_TOKEN_ACCOUNT_CODE') || str('TREASURY_TOPUP_CRYPTO_ACCOUNT_CODE', '1210'),
      cashAccountCode: str('FIREFLY_CASH_ACCOUNT_CODE') || str('TREASURY_TOPUP_CASH_ACCOUNT_CODE', '1000'),
      sourceType: str('FIREFLY_SOURCE_TYPE', 'trust'),
      sourceAccountId: str('FIREFLY_SOURCE_ACCOUNT_ID') || null,
      maxTransferUsd: num('FIREFLY_MAX_TRANSFER_USD', 0),
      timeoutMs: num('FIREFLY_TIMEOUT_MS', 20000),
      // Notarize each instruction on the Fabric channel as well as pinning it.
      notarize: str('FIREFLY_NOTARIZE_INSTRUCTIONS', 'true') !== 'false',
      live: str('FIREFLY_LIVE') === 'true',
    };
  }

  static _isCanonical(sourceType) { return CANONICAL_SOURCE_TYPES.has(String(sourceType || '').toLowerCase()); }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.apiUrl) issues.push('FIREFLY_API_URL not configured');
    if (!cfg.namespace) issues.push('FIREFLY_NAMESPACE not configured');
    const transferIssues = [];
    if (!cfg.pool) transferIssues.push('FIREFLY_TOKEN_POOL not configured');
    if (!cfg.counterparty) transferIssues.push('FIREFLY_COUNTERPARTY_ORG not configured');
    const canonical = this._isCanonical(cfg.sourceType) ? CanonicalFundingSource.readiness() : null;
    if (canonical && !canonical.ready) transferIssues.push(...canonical.issues.map((i) => `canonical source: ${i}`));

    return {
      system: cfg.system,
      namespace: cfg.namespace,
      pool: cfg.pool || null,
      counterparty: cfg.counterparty || null,
      live: cfg.live,
      canMessage: issues.length === 0,
      canTransfer: issues.length === 0 && transferIssues.length === 0 && cfg.live,
      mode: cfg.live ? 'live' : 'shadow',
      issues,
      transferIssues,
      webhookVerified: Boolean(cfg.webhookSecret),
      fabric: FabricLedgerEngine.readiness(),
      persistence: pool && pool.query ? 'postgres' : 'memory',
    };
  }

  static async _call(path, { method = 'GET', body = null } = {}) {
    const cfg = this.getConfig();
    if (!cfg.apiUrl) throw reject('FIREFLY_API_URL not configured', 'FIREFLY_NOT_CONFIGURED', 503);
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(`${cfg.apiUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = { raw: text }; }
      if (!res.ok) {
        const detail = (parsed && (parsed.error || parsed.message)) || res.statusText;
        throw reject(`firefly ${path} failed: ${detail}`, 'FIREFLY_CALL_FAILED', res.status >= 500 ? 502 : 422);
      }
      return parsed || {};
    } catch (err) {
      if (err.name === 'AbortError') throw reject(`firefly ${path} timed out after ${cfg.timeoutMs}ms`, 'FIREFLY_TIMEOUT', 504);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  static _ns(path) { return `/api/v1/namespaces/${encodeURIComponent(this.getConfig().namespace)}${path}`; }

  /** Node identity, org and plugin health — what the trust is actually connected to. */
  static async status() {
    const raw = await this._call('/api/v1/status');
    return {
      namespace: raw.namespace && (raw.namespace.name || raw.namespace),
      node: raw.node ? { name: raw.node.name, registered: raw.node.registered } : null,
      org: raw.org ? { name: raw.org.name, did: raw.org.did, registered: raw.org.registered } : null,
      multiparty: raw.multiparty ? { enabled: raw.multiparty.enabled, contract: raw.multiparty.contract || null } : null,
      plugins: raw.plugins ? Object.keys(raw.plugins) : [],
    };
  }

  static async organizations() {
    const raw = await this._call('/api/v1/network/organizations');
    return (Array.isArray(raw) ? raw : []).map((o) => ({ name: o.name, did: o.did, id: o.id, verified: Boolean(o.messages) }));
  }

  static async pools() {
    const raw = await this._call(this._ns('/tokens/pools'));
    return (Array.isArray(raw) ? raw : []).map((p) => ({
      id: p.id, name: p.name, symbol: p.symbol, type: p.type, standard: p.standard,
      decimals: p.decimals, connector: p.connector, state: p.state,
    }));
  }

  static async balances() {
    const cfg = this.getConfig();
    const query = cfg.pool ? `?pool=${encodeURIComponent(cfg.pool)}` : '';
    const raw = await this._call(this._ns(`/tokens/balances${query}`));
    return (Array.isArray(raw) ? raw : []).map((b) => ({
      pool: b.pool, key: b.key, tokenIndex: b.tokenIndex, balance: b.balance, updated: b.updated,
    }));
  }

  /**
   * A settlement instruction the counterparty can verify: the payload goes
   * private (off-chain, member-only), its hash is pinned on the ledger, and the
   * same digest is notarized on the trust's Fabric channel so both sides can
   * prove later what was agreed.
   */
  static async sendInstruction({
    reference, instruction, counterparty = null, topic = null, requestedBy = null,
  } = {}) {
    if (!reference) throw reject('reference is required', 'REFERENCE_REQUIRED');
    if (!instruction || typeof instruction !== 'object') throw reject('instruction object is required', 'INSTRUCTION_REQUIRED');
    const cfg = this.getConfig();
    const target = counterparty || cfg.counterparty;
    if (!target) throw reject('no counterparty org (set FIREFLY_COUNTERPARTY_ORG or pass counterparty)', 'COUNTERPARTY_REQUIRED');

    const existing = await this._find('instruction', reference);
    if (existing) return { ...existing, idempotent: true };

    const digest = digestOf(instruction);
    const readiness = this.readiness();
    const row = {
      id: id('FFMSG'),
      kind: 'instruction',
      reference: String(reference),
      namespace: cfg.namespace,
      pool: null,
      counterparty: target,
      amountCents: toCents(instruction.amountUsd || 0),
      currency: (instruction.currency || 'USD').toUpperCase(),
      sourceType: null,
      sourceAccountId: null,
      status: readiness.canMessage ? 'sent' : 'shadow',
      booked: false,
      fireflyId: null,
      transferId: null,
      messageId: null,
      txHash: null,
      instructionDigest: digest,
      notarizationId: null,
      journalEntryId: null,
      failureReason: null,
      detail: { instruction, topic: topic || cfg.topic },
      requestedBy,
      createdAt: new Date().toISOString(),
    };

    if (readiness.canMessage) {
      const response = await this._call(this._ns('/messages/private'), {
        method: 'POST',
        body: {
          header: {
            type: 'private',
            topics: [topic || cfg.topic],
            tag: 'settlement_instruction',
            group: { members: [{ identity: target }] },
          },
          data: [{ datatype: { name: cfg.datatype, version: '1.0.0' }, value: { reference: String(reference), digest, ...instruction } }],
        },
      });
      row.messageId = response.header ? response.header.id : (response.id || null);
      row.fireflyId = row.messageId;
      row.status = String(response.state || 'sent').toLowerCase();
    } else {
      row.failureReason = readiness.issues.join('; ') || null;
      row.detail.reason = 'FireFly node not configured; instruction digested and stored, nothing sent';
    }

    if (cfg.notarize) {
      const notarization = await FabricLedgerEngine.notarize({
        recordType: 'settlement_instruction',
        recordId: String(reference),
        payload: instruction,
        metadata: { counterparty: target, messageId: row.messageId, namespace: cfg.namespace },
        notarizedBy: requestedBy,
      }).catch((err) => ({ id: null, error: err.message }));
      row.notarizationId = notarization.id || null;
      row.detail.notarization = notarization;
    }

    await this._persist(row);
    return row;
  }

  /**
   * Move tokenized value to the counterparty with the remittance advice
   * attached to the same transfer. Nothing is booked here: the journal entry
   * waits for FireFly to confirm the transfer.
   */
  static async transfer({
    amountUsd, reference, counterparty = null, poolId = null, memo = null,
    sourceType = null, sourceAccountId = null, requestedBy = null,
  } = {}) {
    const cfg = this.getConfig();
    const amount = Number(amountUsd);
    if (!Number.isFinite(amount) || amount <= 0) throw reject('amountUsd must be a positive number', 'AMOUNT_INVALID');
    if (cfg.maxTransferUsd > 0 && amount > cfg.maxTransferUsd) {
      throw reject(`transfer of $${amount} exceeds FIREFLY_MAX_TRANSFER_USD ($${cfg.maxTransferUsd})`, 'AMOUNT_ABOVE_LIMIT');
    }
    const ref = String(reference || id('FFXFER'));
    const target = counterparty || cfg.counterparty;
    const pool_ = poolId || cfg.pool;
    if (!target) throw reject('no counterparty org (set FIREFLY_COUNTERPARTY_ORG or pass counterparty)', 'COUNTERPARTY_REQUIRED');
    if (!pool_) throw reject('no token pool (set FIREFLY_TOKEN_POOL or pass poolId)', 'POOL_REQUIRED');

    const existing = await this._find('transfer', ref);
    if (existing) return { ...existing, idempotent: true };

    const effectiveSourceType = sourceType || cfg.sourceType;
    const effectiveSourceAccount = sourceAccountId || cfg.sourceAccountId;
    const amountCents = toCents(amount);

    // Does the money exist? The ERP answers when the source is canonical.
    let availability;
    if (this._isCanonical(effectiveSourceType)) {
      const position = await CanonicalFundingSource.assertAvailable({ amountUsd: amount, accountCode: effectiveSourceAccount || undefined });
      availability = { authority: 'canonical', availableCents: position.availableBalanceCents };
    } else {
      const position = await SourceOfFundsAdapter.getPosition({ sourceType: effectiveSourceType, sourceAccountId: effectiveSourceAccount, purpose: 'payment' });
      if (position.fundingEligible === false) {
        throw reject(`source ${effectiveSourceType}:${effectiveSourceAccount || 'default'} cannot fund this transfer: ${position.segregationReason || 'segregated'}`, 'SOURCE_INELIGIBLE');
      }
      if (Number(position.availableBalanceCents || 0) < amountCents) {
        throw reject(`source has $${fromCents(position.availableBalanceCents)} available, transfer needs $${amount}`, 'INSUFFICIENT_SOURCE_FUNDS');
      }
      availability = { authority: 'sub_ledger', availableCents: Number(position.availableBalanceCents || 0) };
    }

    const instruction = {
      reference: ref,
      amountUsd: amount,
      currency: 'USD',
      counterparty: target,
      pool: pool_,
      memo: memo || `DLB Trust settlement ${ref}`,
    };
    const digest = digestOf(instruction);
    const readiness = this.readiness();

    const row = {
      id: id('FFXFER'),
      kind: 'transfer',
      reference: ref,
      namespace: cfg.namespace,
      pool: pool_,
      counterparty: target,
      amountCents,
      currency: 'USD',
      sourceType: effectiveSourceType,
      sourceAccountId: effectiveSourceAccount,
      status: readiness.canTransfer ? 'pending' : 'shadow',
      booked: false,
      fireflyId: null,
      transferId: null,
      messageId: null,
      txHash: null,
      instructionDigest: digest,
      notarizationId: null,
      journalEntryId: null,
      failureReason: null,
      detail: { instruction, availability },
      requestedBy,
      createdAt: new Date().toISOString(),
    };

    if (!readiness.canTransfer) {
      row.detail.reason = readiness.live
        ? `transfer blocked: ${readiness.transferIssues.concat(readiness.issues).join('; ')}`
        : 'FIREFLY_LIVE is not true; transfer planned, nothing moved';
      await this._persist(row);
      return row;
    }

    const body = {
      pool: pool_,
      amount: this._baseUnits(amount, cfg.tokenDecimals),
      to: target,
      message: {
        header: { type: 'transfer_private', topics: [cfg.topic], tag: 'settlement_transfer', group: { members: [{ identity: target }] } },
        data: [{ datatype: { name: cfg.datatype, version: '1.0.0' }, value: { digest, ...instruction } }],
      },
    };
    if (cfg.signingKey) body.key = cfg.signingKey;

    let response;
    try {
      response = await this._call(this._ns('/tokens/transfers'), { method: 'POST', body });
    } catch (err) {
      row.status = 'failed';
      row.failureReason = err.message;
      await this._persist(row);
      throw err;
    }

    row.transferId = response.localId || response.id || null;
    row.fireflyId = row.transferId;
    row.messageId = response.message || null;
    row.txHash = (response.blockchainEvent && response.blockchainEvent.tx) || response.tx || null;
    row.status = String(response.state || 'pending').toLowerCase();

    if (cfg.notarize) {
      const notarization = await FabricLedgerEngine.notarize({
        recordType: 'settlement_transfer',
        recordId: ref,
        payload: instruction,
        metadata: { transferId: row.transferId, counterparty: target, pool: pool_ },
        notarizedBy: requestedBy,
      }).catch((err) => ({ id: null, error: err.message }));
      row.notarizationId = notarization.id || null;
      row.detail.notarization = notarization;
    }

    await this._persist(row);
    return row;
  }

  /** Poll one transfer and book it if FireFly now calls it confirmed. */
  static async sync(settlementId) {
    const record = await this.get(settlementId);
    if (!record) throw reject(`settlement ${settlementId} not found`, 'SETTLEMENT_NOT_FOUND', 404);
    if (record.kind !== 'transfer') return { ...record, polled: false, reason: 'only transfers settle' };
    if (record.status === 'shadow') return { ...record, polled: false, reason: 'shadow transfer never reached FireFly' };
    if (!record.transferId) return { ...record, polled: false, reason: 'no FireFly transfer id to poll' };

    const raw = await this._call(this._ns(`/tokens/transfers/${encodeURIComponent(record.transferId)}`));
    const state = String(raw.state || raw.status || '').toLowerCase();
    const confirmed = state === 'confirmed' || Boolean(raw.created && raw.blockchainEvent);
    const failed = state === 'rejected' || state === 'failed';

    const patch = {
      status: confirmed ? 'confirmed' : (failed ? 'failed' : (state || record.status)),
      txHash: (raw.blockchainEvent && raw.blockchainEvent.tx) || raw.tx || record.txHash,
      failureReason: failed ? (raw.message || 'FireFly rejected the transfer') : null,
    };
    let updated = await this._update(record.id, patch);
    if (confirmed && updated && !updated.booked) updated = await this._book(updated);
    return { ...updated, polled: true };
  }

  /**
   * FireFly webhook receiver. Confirmation is the only event that books, and a
   * signature is required whenever FIREFLY_WEBHOOK_SECRET is set — an unsigned
   * body is acknowledged, never trusted.
   */
  static async handleEvent(event, { signature = null, rawBody = null } = {}) {
    const cfg = this.getConfig();
    if (cfg.webhookSecret) {
      if (!this.verifySignature(rawBody, signature)) throw reject('invalid FireFly webhook signature', 'SIGNATURE_INVALID', 401);
    }
    const type = String((event && (event.type || (event.event && event.event.type))) || '').toLowerCase();
    const body = (event && event.event) || event || {};
    const transfer = body.tokenTransfer || (event && event.tokenTransfer) || {};
    const transferId = transfer.localId || transfer.id || body.reference || null;

    if (!type) return { handled: false, reason: 'event has no type' };
    if (!CONFIRMED_EVENTS.has(type) && !FAILED_EVENTS.has(type)) {
      return { handled: false, ignored: true, type, reason: 'event type is not a transfer outcome' };
    }
    if (!transferId) return { handled: false, type, reason: 'event carries no transfer id' };

    const record = await this._findByTransferId(transferId);
    if (!record) return { handled: false, type, transferId, reason: 'no settlement matches this transfer' };

    if (FAILED_EVENTS.has(type)) {
      const failed = await this._update(record.id, {
        status: 'failed',
        failureReason: transfer.message || 'FireFly reported the transfer failed',
        txHash: record.txHash,
      });
      return { handled: true, type, booked: false, settlement: failed };
    }

    let updated = await this._update(record.id, {
      status: 'confirmed',
      txHash: (transfer.blockchainEvent && transfer.blockchainEvent.tx) || transfer.tx || record.txHash,
      failureReason: null,
    });
    if (updated && !updated.booked) updated = await this._book(updated);
    return { handled: true, type, booked: Boolean(updated && updated.booked), settlement: updated };
  }

  /**
   * USD → the pool's smallest unit as a decimal string. Done on cents with
   * integer math so no amount is ever rounded through a float exponent.
   */
  static _baseUnits(amountUsd, decimals) {
    const scale = Math.max(0, Math.trunc(Number(decimals)));
    const cents = BigInt(toCents(amountUsd));
    if (scale === 2) return cents.toString();
    if (scale > 2) return (cents * (10n ** BigInt(scale - 2))).toString();
    const divisor = 10n ** BigInt(2 - scale);
    if (cents % divisor !== 0n) {
      throw reject(`$${amountUsd} cannot be represented in a pool with ${scale} decimals`, 'AMOUNT_PRECISION', 422);
    }
    return (cents / divisor).toString();
  }

  static verifySignature(rawBody, signature) {
    const secret = this.getConfig().webhookSecret;
    if (!secret) return true;
    if (!rawBody || !signature) return false;
    const buffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
    const expected = crypto.createHmac('sha256', secret).update(buffer).digest('hex');
    const provided = String(signature).replace(/^sha256=/i, '').trim().toLowerCase();
    const expectedBuf = Buffer.from(expected, 'utf8');
    const providedBuf = Buffer.from(provided, 'utf8');
    return expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);
  }

  /**
   * One journal entry per confirmed transfer: value leaves trust cash and lands
   * in the tokenized asset account. Canonical sources post to both books.
   */
  static async _book(record) {
    const cfg = this.getConfig();
    const amount = fromCents(record.amountCents);
    if (amount <= 0) return this._update(record.id, { status: record.status, booked: true, journalEntryId: null });

    try {
      if (this._isCanonical(record.sourceType)) {
        const committed = await CanonicalFundingSource.commit({
          amountUsd: amount,
          reference: record.reference,
          referenceType: 'firefly_settlement',
          memo: `FireFly settlement ${record.reference} to ${record.counterparty}`,
          cashAccountCode: record.sourceAccountId || cfg.cashAccountCode,
          assetAccountCode: cfg.tokenAccountCode,
          postedBy: 'firefly-engine',
        });
        return this._update(record.id, {
          status: 'confirmed',
          booked: true,
          journalEntryId: (committed.journalEntry && committed.journalEntry.id) || committed.journalEntryId || null,
        });
      }

      if (!TrustAccountingEngine) return this._update(record.id, { status: 'confirmed', booked: false, failureReason: 'accounting engine unavailable' });

      const entry = await TrustAccountingEngine.postJournalEntry({
        entryDate: new Date().toISOString().slice(0, 10),
        description: `FireFly settlement ${record.reference} to ${record.counterparty}`,
        referenceType: 'firefly_settlement',
        referenceId: record.reference,
        postedBy: 'firefly-engine',
        lines: [
          { accountCode: cfg.tokenAccountCode, debitAmount: amount, creditAmount: 0 },
          { accountCode: record.sourceAccountId || cfg.cashAccountCode, debitAmount: 0, creditAmount: amount },
        ],
      });
      return this._update(record.id, { status: 'confirmed', booked: true, journalEntryId: (entry && entry.id) || null });
    } catch (err) {
      return this._update(record.id, { status: 'confirmed', booked: false, failureReason: `booking failed: ${err.message}` });
    }
  }

  /**
   * Register the event stream and subscription the trust books from, so a
   * confirmation reaches this server even when nobody is polling.
   */
  static async ensureSubscription({ webhookUrl = null } = {}) {
    const cfg = this.getConfig();
    const url = webhookUrl || str('FIREFLY_WEBHOOK_URL');
    if (!url) throw reject('webhookUrl is required (or set FIREFLY_WEBHOOK_URL)', 'WEBHOOK_URL_REQUIRED');
    const existing = await this._call(this._ns('/subscriptions')).catch(() => []);
    const found = (Array.isArray(existing) ? existing : []).find((s) => s.name === cfg.subscriptionName);
    if (found) return { created: false, subscription: { id: found.id, name: found.name, transport: found.transport } };

    const created = await this._call(this._ns('/subscriptions'), {
      method: 'POST',
      body: {
        name: cfg.subscriptionName,
        transport: 'webhooks',
        filter: { events: 'token_transfer_confirmed|token_transfer_op_failed' },
        options: { url, method: 'POST', json: true, retry: { enabled: true, count: 5, initialDelay: '1s' } },
      },
    });
    return { created: true, subscription: { id: created.id, name: created.name, transport: created.transport } };
  }

  /** Every transfer FireFly confirmed but the books never recorded. */
  static async reconcile({ limit = 100 } = {}) {
    const rows = await this.list({ limit, kind: 'transfer' });
    const unbooked = rows.filter((r) => r.status === 'confirmed' && !r.booked);
    const booked = [];
    for (const row of unbooked) booked.push(await this._book(row));
    return {
      inspected: rows.length,
      unbookedBefore: unbooked.length,
      booked: booked.filter((b) => b && b.booked).length,
      stillUnbooked: booked.filter((b) => b && !b.booked).map((b) => ({ id: b.id, reference: b.reference, reason: b.failureReason })),
      pending: rows.filter((r) => r.status === 'pending').map((r) => ({ id: r.id, reference: r.reference, transferId: r.transferId })),
      shadow: rows.filter((r) => r.status === 'shadow').length,
    };
  }

  // ─── persistence ──────────────────────────────────────────────────────────

  static async _persist(row) {
    if (!pool || !pool.query) { memorySettlements.unshift(row); return row; }
    await ensureTables();
    await pool.query(
      `INSERT INTO firefly_settlements
         (id, kind, reference, namespace, pool, counterparty, amount_cents, currency,
          source_type, source_account_id, status, booked, firefly_id, transfer_id, message_id,
          tx_hash, instruction_digest, notarization_id, journal_entry_id, failure_reason, detail, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22)
       ON CONFLICT (kind, reference) DO UPDATE SET
         status = EXCLUDED.status,
         transfer_id = COALESCE(EXCLUDED.transfer_id, firefly_settlements.transfer_id),
         message_id = COALESCE(EXCLUDED.message_id, firefly_settlements.message_id),
         tx_hash = COALESCE(EXCLUDED.tx_hash, firefly_settlements.tx_hash),
         failure_reason = EXCLUDED.failure_reason,
         detail = EXCLUDED.detail,
         updated_at = NOW()`,
      [row.id, row.kind, row.reference, row.namespace, row.pool, row.counterparty, row.amountCents,
        row.currency, row.sourceType, row.sourceAccountId, row.status, row.booked, row.fireflyId,
        row.transferId, row.messageId, row.txHash, row.instructionDigest, row.notarizationId,
        row.journalEntryId, row.failureReason, JSON.stringify(row.detail || {}), row.requestedBy],
    );
    return row;
  }

  static async _update(settlementId, patch) {
    if (!pool || !pool.query) {
      const row = memorySettlements.find((r) => r.id === settlementId);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    }
    await ensureTables();
    const res = await pool.query(
      `UPDATE firefly_settlements
          SET status = COALESCE($2, status),
              booked = COALESCE($3, booked),
              tx_hash = COALESCE($4, tx_hash),
              journal_entry_id = COALESCE($5, journal_entry_id),
              failure_reason = $6,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [settlementId, patch.status ?? null, patch.booked ?? null, patch.txHash ?? null,
        patch.journalEntryId ?? null, patch.failureReason ?? null],
    );
    return res.rows[0] ? this._fromRow(res.rows[0]) : null;
  }

  static async _find(kind, reference) {
    if (!pool || !pool.query) return memorySettlements.find((r) => r.kind === kind && r.reference === String(reference)) || null;
    await ensureTables();
    const res = await pool.query('SELECT * FROM firefly_settlements WHERE kind = $1 AND reference = $2 LIMIT 1', [kind, String(reference)]);
    return res.rows[0] ? this._fromRow(res.rows[0]) : null;
  }

  static async _findByTransferId(transferId) {
    if (!pool || !pool.query) return memorySettlements.find((r) => r.transferId === String(transferId)) || null;
    await ensureTables();
    const res = await pool.query('SELECT * FROM firefly_settlements WHERE transfer_id = $1 LIMIT 1', [String(transferId)]);
    return res.rows[0] ? this._fromRow(res.rows[0]) : null;
  }

  static async get(settlementId) {
    if (!pool || !pool.query) return memorySettlements.find((r) => r.id === settlementId) || null;
    await ensureTables();
    const res = await pool.query('SELECT * FROM firefly_settlements WHERE id = $1', [settlementId]);
    return res.rows[0] ? this._fromRow(res.rows[0]) : null;
  }

  static async list({ limit = 25, kind = null, status = null } = {}) {
    if (!pool || !pool.query) {
      return memorySettlements
        .filter((r) => (!kind || r.kind === kind) && (!status || r.status === status))
        .slice(0, limit);
    }
    await ensureTables();
    const res = await pool.query(
      `SELECT * FROM firefly_settlements
        WHERE ($2::text IS NULL OR kind = $2)
          AND ($3::text IS NULL OR status = $3)
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit, kind, status],
    );
    return res.rows.map((r) => this._fromRow(r));
  }

  static _fromRow(row) {
    return {
      id: row.id,
      kind: row.kind,
      reference: row.reference,
      namespace: row.namespace,
      pool: row.pool,
      counterparty: row.counterparty,
      amountCents: Number(row.amount_cents || 0),
      currency: row.currency,
      sourceType: row.source_type,
      sourceAccountId: row.source_account_id,
      status: row.status,
      booked: Boolean(row.booked),
      fireflyId: row.firefly_id,
      transferId: row.transfer_id,
      messageId: row.message_id,
      txHash: row.tx_hash,
      instructionDigest: row.instruction_digest,
      notarizationId: row.notarization_id,
      journalEntryId: row.journal_entry_id,
      failureReason: row.failure_reason,
      detail: row.detail || {},
      requestedBy: row.requested_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Test seam. */
  static _resetMemory() { memorySettlements.length = 0; }
}

module.exports = { FireflyEngine };
