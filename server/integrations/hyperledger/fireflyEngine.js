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
 *
 * Retries: every submission carries a FireFly idempotency key, so a POST that
 * errored can be re-sent without risking a double move — FireFly answers 409
 * with the transaction it already accepted and we adopt it. A submit failure
 * is retried once inline; a transfer FireFly itself reported failed (e.g. an
 * EVM revert) can be re-driven once via `retry()`, under a new key.
 *
 * A resend under an existing key re-drives FireFly's *original* transaction,
 * and the transfer it eventually confirms can carry that first attempt's local
 * id rather than the one the resend answered with. The transaction id — which
 * maps 1:1 to our idempotency key — is therefore the durable correlation, and
 * both the webhook and `sync` fall back to it when a local id does not match.
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
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Pool ids, counterparty verifiers and the instruction datatype are node
// registrations, not state: resolve each once per node instead of adding three
// lookups to every settlement.
const resolved = Object.create(null);

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
      // Extra POST attempts when the submission itself errors (same idempotency key).
      submitRetries: Math.max(0, num('FIREFLY_SUBMIT_RETRIES', 1)),
      submitRetryDelayMs: Math.max(0, num('FIREFLY_SUBMIT_RETRY_DELAY_MS', 1500)),
      // How many times a transfer FireFly reported failed may be re-driven.
      transferRetries: Math.max(0, num('FIREFLY_TRANSFER_RETRIES', 1)),
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
        throw Object.assign(
          reject(`firefly ${path} failed: ${detail}`, 'FIREFLY_CALL_FAILED', res.status >= 500 ? 502 : 422),
          { upstreamStatus: res.status },
        );
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
    // FireFly filters balances by pool *id*; a configured pool name matches
    // nothing and silently reads as a zero position, so resolve it first.
    const poolId = cfg.pool ? await this._resolvePoolId(cfg.pool).catch(() => null) : null;
    const query = poolId ? `?pool=${encodeURIComponent(poolId)}` : '';
    const raw = await this._call(this._ns(`/tokens/balances${query}`));
    return (Array.isArray(raw) ? raw : []).map((b) => ({
      pool: b.pool, key: b.key, tokenIndex: b.tokenIndex, balance: b.balance, updated: b.updated,
    }));
  }

  /**
   * Accept a pool name or id everywhere and hand FireFly the id.
   */
  static async _resolvePoolId(nameOrId) {
    const key = `pool:${this.getConfig().apiUrl}:${nameOrId}`;
    if (resolved[key]) return resolved[key];
    const pools = await this.pools();
    const match = pools.find((p) => p.id === nameOrId) || pools.find((p) => p.name === nameOrId);
    if (!match) throw reject(`token pool '${nameOrId}' does not exist on this FireFly node`, 'POOL_NOT_FOUND', 422);
    resolved[key] = match.id;
    return match.id;
  }

  /**
   * A counterparty is configured as an org identity (a DID or org name) because
   * that is what a trustee can recognise in a policy document. FireFly's
   * messaging APIs take exactly that, but a token transfer credits a *blockchain
   * key*, so resolve the identity to its registered verifier rather than
   * handing FireFly a DID it will reject as an address.
   */
  static async _resolveCounterpartyKey(identity) {
    const key = `identity:${this.getConfig().apiUrl}:${identity}`;
    if (resolved[key]) return resolved[key];
    const raw = await this._call(this._ns('/identities?fetchverifiers=true'));
    const list = Array.isArray(raw) ? raw : [];
    const wanted = String(identity);
    const match = list.find((i) => i.did === wanted)
      || list.find((i) => i.name === wanted)
      || list.find((i) => (i.verifiers || []).some((v) => String(v.value).toLowerCase() === wanted.toLowerCase()));
    const verifier = match && (match.verifiers || []).find((v) => v.value);
    if (!verifier) {
      throw reject(
        `counterparty '${identity}' has no registered blockchain verifier on this FireFly node`,
        'COUNTERPARTY_UNRESOLVED',
        422,
      );
    }
    resolved[key] = verifier.value;
    return verifier.value;
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
      await this.ensureDatatype();
      const response = await this._call(this._ns('/messages/private'), {
        method: 'POST',
        body: {
          // `header.group` is the hash FireFly computes; the member list is a
          // sibling of the header, not part of it.
          header: { topics: [topic || cfg.topic], tag: 'settlement_instruction' },
          group: { members: [{ identity: target }] },
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
    return this._transfer(cfg, { amountUsd, reference, counterparty, poolId, memo, sourceType, sourceAccountId, requestedBy }, null);
  }

  /**
   * Re-drive a transfer that failed. Nothing moved the first time — either the
   * POST never got an accepted transfer back, or FireFly reported the transfer
   * failed — so the same instruction is resubmitted under the same reference,
   * up to FIREFLY_TRANSFER_RETRIES times. Anything else is returned untouched.
   */
  static async retry(settlementId, { requestedBy = null } = {}) {
    const record = await this.get(settlementId);
    if (!record) throw reject(`settlement ${settlementId} not found`, 'SETTLEMENT_NOT_FOUND', 404);
    if (record.kind !== 'transfer') return { ...record, retried: false, reason: 'only transfers can be retried' };
    const cfg = this.getConfig();
    const eligibility = this._retryEligibility(cfg, record);
    if (!eligibility.ok) return { ...record, retried: false, reason: eligibility.reason };
    const instruction = (record.detail && record.detail.instruction) || {};
    return this._transfer(cfg, {
      amountUsd: fromCents(record.amountCents),
      reference: record.reference,
      counterparty: record.counterparty,
      poolId: record.pool,
      memo: instruction.memo || null,
      sourceType: record.sourceType,
      sourceAccountId: record.sourceAccountId,
      requestedBy: requestedBy || record.requestedBy,
    }, record);
  }

  static _retryEligibility(cfg, record) {
    if (record.status !== 'failed') return { ok: false, reason: `transfer is ${record.status}, only failed transfers are retried` };
    if (record.booked) return { ok: false, reason: 'transfer is already booked' };
    const attempt = Number((record.detail && record.detail.attempt) || 1);
    if (attempt > cfg.transferRetries) {
      return { ok: false, reason: `retry limit reached (${attempt - 1} of ${cfg.transferRetries} retries used)` };
    }
    return { ok: true, attempt: attempt + 1 };
  }

  static async _transfer(cfg, {
    amountUsd, reference, counterparty, poolId, memo, sourceType, sourceAccountId, requestedBy,
  }, previous) {
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

    const existing = previous || await this._find('transfer', ref);
    if (existing && !previous) {
      // Same reference, failed last time: this call *is* the retry.
      if (!this._retryEligibility(cfg, existing).ok) return { ...existing, idempotent: true };
      previous = existing;
    }
    const attempt = previous ? this._retryEligibility(cfg, previous).attempt : 1;

    const effectiveSourceType = sourceType || cfg.sourceType;
    // The account that is debited is the account that must be checked, so fall
    // back to the cash account this settlement books against rather than
    // letting the adapter look up a "default" account that exists nowhere.
    const effectiveSourceAccount = sourceAccountId || cfg.sourceAccountId || cfg.cashAccountCode;
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
      id: previous ? previous.id : id('FFXFER'),
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
      detail: { instruction, availability, attempt },
      requestedBy,
      createdAt: previous ? previous.createdAt : new Date().toISOString(),
    };
    if (previous) {
      row.detail.priorAttempts = ((previous.detail && previous.detail.priorAttempts) || []).concat([{
        attempt: attempt - 1,
        transferId: previous.transferId || null,
        txHash: previous.txHash || null,
        failureReason: previous.failureReason || null,
        retriedAt: new Date().toISOString(),
      }]);
    }
    // A submission that never came back with a transfer may still have landed,
    // so it is resent under the *same* key; only an attempt FireFly accepted and
    // then reported failed gets a fresh one.
    const keyIndex = 1 + (row.detail.priorAttempts || []).filter((a) => a.transferId).length;

    if (!readiness.canTransfer) {
      row.detail.reason = readiness.live
        ? `transfer blocked: ${readiness.transferIssues.concat(readiness.issues).join('; ')}`
        : 'FIREFLY_LIVE is not true; transfer planned, nothing moved';
      await this._persist(row);
      return row;
    }

    let recipientKey;
    try {
      await this.ensureDatatype();
      recipientKey = await this._resolveCounterpartyKey(target);
    } catch (err) {
      row.status = 'failed';
      row.failureReason = err.message;
      await this._persist(row);
      throw err;
    }
    row.detail.recipientKey = recipientKey;

    // One key per (reference, attempt): a resend of the same attempt can never
    // move value twice, and a re-drive after a reported failure is a new one.
    row.detail.idempotencyKey = this._idempotencyKey(ref, keyIndex);
    const body = {
      pool: await this._resolvePoolId(pool_),
      amount: this._baseUnits(amount, cfg.tokenDecimals),
      to: recipientKey,
      idempotencyKey: row.detail.idempotencyKey,
      message: {
        header: { topics: [cfg.topic], tag: 'settlement_transfer' },
        group: { members: [{ identity: target }] },
        data: [{ datatype: { name: cfg.datatype, version: '1.0.0' }, value: { digest, ...instruction } }],
      },
    };
    if (cfg.signingKey) body.key = cfg.signingKey;

    let response;
    try {
      response = await this._submit(cfg, row, body);
    } catch (err) {
      row.status = 'failed';
      row.failureReason = err.message;
      await this._persist(row);
      throw err;
    }

    row.transferId = response.localId || response.id || null;
    row.fireflyId = row.transferId;
    row.messageId = response.message || null;
    row.txHash = this._txHash(response);
    row.status = String(response.state || 'pending').toLowerCase();
    row.detail.fireflyTx = this._txId(response);
    // The confirmation webhook can arrive before notarization finishes; the
    // transfer id has to be on disk by then or the event finds no settlement.
    await this._persist(row);

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
      await this._attachNotarization(row);
    }

    // Re-read rather than return the local copy: the webhook may already have
    // confirmed and booked this settlement while notarization was in flight.
    return (await this.get(row.id)) || row;
  }

  static _idempotencyKey(reference, keyIndex) {
    return keyIndex > 1 ? `${reference}#${keyIndex}` : String(reference);
  }

  /** The FireFly transaction id a transfer or event belongs to, if it names one. */
  static _txId(source) {
    const tx = source && source.tx;
    if (!tx) return null;
    if (typeof tx === 'string') return tx;
    return typeof tx === 'object' && tx.id ? String(tx.id) : null;
  }

  /**
   * Find the settlement a FireFly transaction belongs to when its transfer id
   * is unknown to us: the transaction's idempotency key is ours, and its
   * reference names the row. A hit adopts the transfer id so later events match
   * directly; an already-booked row is left alone.
   */
  static async _adoptByTransaction(txId, transferId) {
    if (!txId) return null;
    const tx = await this._call(this._ns(`/transactions/${encodeURIComponent(txId)}`)).catch(() => null);
    const key = tx && tx.idempotencyKey ? String(tx.idempotencyKey) : null;
    if (!key) return null;
    const record = await this._find('transfer', key.split('#')[0]);
    if (!record || record.status === 'shadow') return null;
    const ownKey = record.detail && record.detail.idempotencyKey;
    if (ownKey && ownKey !== key) return null;
    if (record.transferId === String(transferId)) return record;
    return this._update(record.id, { transferId: String(transferId) });
  }

  /**
   * The confirmed transfer for a settlement whose stored transfer id FireFly no
   * longer answers for: look the transaction up by our idempotency key and take
   * whichever transfer it produced.
   */
  static async _locateByKey(record) {
    const key = (record.detail && record.detail.idempotencyKey) || String(record.reference);
    const txs = await this._call(this._ns(`/transactions?idempotencyKey=${encodeURIComponent(key)}&limit=1`)).catch(() => null);
    const txId = Array.isArray(txs) && txs[0] ? txs[0].id : (record.detail && record.detail.fireflyTx);
    if (!txId) return null;
    const transfers = await this._call(this._ns(`/tokens/transfers?tx=${encodeURIComponent(txId)}&limit=1`)).catch(() => null);
    return Array.isArray(transfers) && transfers[0] ? transfers[0] : null;
  }

  /**
   * POST the transfer, retrying a failed submission FIREFLY_SUBMIT_RETRIES
   * times under the same idempotency key. If FireFly reports the key already
   * used, the earlier attempt landed after all and that transfer is adopted.
   */
  static async _submit(cfg, row, body) {
    const errors = [];
    for (let sent = 1; sent <= 1 + cfg.submitRetries; sent += 1) {
      try {
        const response = await this._call(this._ns('/tokens/transfers'), { method: 'POST', body });
        row.detail.submit = { sent, errors };
        return response;
      } catch (err) {
        const adopted = await this._adoptIdempotent(err, body.idempotencyKey);
        if (adopted) {
          row.detail.submit = { sent, errors, adopted: true };
          return adopted;
        }
        errors.push({ sent, error: err.message, at: new Date().toISOString() });
        if (sent > cfg.submitRetries) {
          row.detail.submit = { sent, errors };
          throw err;
        }
        if (cfg.submitRetryDelayMs) await sleep(cfg.submitRetryDelayMs);
      }
    }
    throw reject('transfer submission exhausted its attempts', 'FIREFLY_SUBMIT_FAILED', 502);
  }

  static async _adoptIdempotent(err, idempotencyKey) {
    const match = /FF10431.*transaction '([^']+)'/.exec(err && err.message ? err.message : '');
    if (!match || !idempotencyKey) return null;
    try {
      const transfers = await this._call(this._ns(`/tokens/transfers?tx=${encodeURIComponent(match[1])}&limit=1`));
      return Array.isArray(transfers) && transfers[0] ? transfers[0] : null;
    } catch (e) {
      return null;
    }
  }

  /** Poll one transfer and book it if FireFly now calls it confirmed. */
  static async sync(settlementId) {
    const record = await this.get(settlementId);
    if (!record) throw reject(`settlement ${settlementId} not found`, 'SETTLEMENT_NOT_FOUND', 404);
    if (record.kind !== 'transfer') return { ...record, polled: false, reason: 'only transfers settle' };
    if (record.status === 'shadow') return { ...record, polled: false, reason: 'shadow transfer never reached FireFly' };
    if (!record.transferId) return { ...record, polled: false, reason: 'no FireFly transfer id to poll' };

    let raw = await this._call(this._ns(`/tokens/transfers/${encodeURIComponent(record.transferId)}`))
      .catch((err) => { if (err.upstreamStatus === 404) return null; throw err; });
    if (!raw) {
      raw = await this._locateByKey(record);
      if (!raw) return { ...record, polled: true, reason: `FireFly has no transfer ${record.transferId} yet` };
      const adopted = raw.localId || raw.id;
      if (adopted && adopted !== record.transferId) await this._update(record.id, { transferId: String(adopted) });
    }
    const state = String(raw.state || raw.status || '').toLowerCase();
    const confirmed = state === 'confirmed' || Boolean(raw.created && raw.blockchainEvent);
    const failed = state === 'rejected' || state === 'failed';

    const patch = {
      status: confirmed ? 'confirmed' : (failed ? 'failed' : (state || record.status)),
      txHash: await this._resolveTxHash(raw) || record.txHash,
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

    const record = await this._findByTransferId(transferId)
      || await this._adoptByTransaction(this._txId(body) || this._txId(transfer), transferId);
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
      txHash: await this._resolveTxHash(transfer) || record.txHash,
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

  /**
   * FireFly's `tx` on a transfer is a reference object ({ type, id }) until the
   * blockchain event lands and carries the real chain hash. Store a hash or
   * nothing, never a reference dressed up as one.
   */
  static _txHash(source) {
    const event = source && source.blockchainEvent;
    const raw = (event && typeof event === 'object' && (event.tx || event.info))
      || (source && source.tx)
      || null;
    const candidate = raw && typeof raw === 'object'
      ? (raw.transactionHash || raw.blockchainId || raw.hash || null)
      : raw;
    return candidate ? String(candidate) : null;
  }

  /**
   * A transfer carries only the id of its blockchain event, and the chain hash
   * lives on the event. Follow the reference so the settlement record holds
   * something an auditor can look up on the chain, and keep it best-effort:
   * booking must not depend on the hash being readable.
   */
  static async _resolveTxHash(source) {
    const direct = this._txHash(source);
    if (direct) return direct;
    const eventId = source && typeof source.blockchainEvent === 'string' ? source.blockchainEvent : null;
    if (!eventId) return null;
    const event = await this._call(this._ns(`/blockchainevents/${encodeURIComponent(eventId)}`)).catch(() => null);
    if (!event) return null;
    return this._txHash({ blockchainEvent: event }) || (event.info && event.info.transactionHash) || null;
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
   * FireFly refuses a message whose datatype it does not know, and the datatype
   * has to be broadcast to the network before either side can validate against
   * it. Define it once, on first use, so a fresh namespace does not turn every
   * settlement instruction into a 404 on the schema.
   */
  static async ensureDatatype() {
    const cfg = this.getConfig();
    if (!cfg.datatype) return { defined: false, reason: 'no datatype configured' };
    const cacheKey = `datatype:${cfg.apiUrl}:${cfg.namespace}:${cfg.datatype}`;
    if (resolved[cacheKey]) return { defined: false, cached: true, datatype: resolved[cacheKey] };
    const query = `?name=${encodeURIComponent(cfg.datatype)}&version=1.0.0`;
    const existing = await this._call(this._ns(`/datatypes${query}`)).catch(() => []);
    const found = (Array.isArray(existing) ? existing : []).find((d) => d.name === cfg.datatype);
    if (found) {
      resolved[cacheKey] = { id: found.id, name: found.name, version: found.version };
      return { defined: false, datatype: resolved[cacheKey] };
    }

    const created = await this._call(this._ns('/datatypes?confirm=true'), {
      method: 'POST',
      body: {
        name: cfg.datatype,
        version: '1.0.0',
        validator: 'json',
        value: {
          $id: `https://dlbtrust.example/schemas/${cfg.datatype}.json`,
          type: 'object',
          // A settlement instruction always carries what it settles and the
          // digest both sides check it against; the rest is remittance detail
          // that differs per rail, so it is not constrained here.
          required: ['reference', 'digest'],
          properties: {
            reference: { type: 'string' },
            digest: { type: 'string' },
            amountUsd: { type: 'number' },
            currency: { type: 'string' },
            memo: { type: 'string' },
          },
        },
      },
    });
    resolved[cacheKey] = { id: created.id, name: created.name, version: created.version };
    return { defined: true, datatype: resolved[cacheKey] };
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
    if (!pool || !pool.query) {
      const at = memorySettlements.findIndex((r) => r.id === row.id);
      if (at >= 0) memorySettlements[at] = row; else memorySettlements.unshift(row);
      return row;
    }
    await ensureTables();
    await pool.query(
      `INSERT INTO firefly_settlements
         (id, kind, reference, namespace, pool, counterparty, amount_cents, currency,
          source_type, source_account_id, status, booked, firefly_id, transfer_id, message_id,
          tx_hash, instruction_digest, notarization_id, journal_entry_id, failure_reason, detail, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22)
       ON CONFLICT (kind, reference) DO UPDATE SET
         status = EXCLUDED.status,
         transfer_id = EXCLUDED.transfer_id,
         message_id = EXCLUDED.message_id,
         tx_hash = EXCLUDED.tx_hash,
         notarization_id = COALESCE(EXCLUDED.notarization_id, firefly_settlements.notarization_id),
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

  static async _attachNotarization(row) {
    if (!pool || !pool.query) {
      const stored = memorySettlements.find((r) => r.id === row.id);
      if (stored && stored !== row) {
        stored.notarizationId = row.notarizationId;
        stored.detail = { ...(stored.detail || {}), notarization: row.detail.notarization };
      }
      return;
    }
    await ensureTables();
    await pool.query(
      `UPDATE firefly_settlements
          SET notarization_id = COALESCE($2, notarization_id),
              detail = COALESCE(detail, '{}'::jsonb) || $3::jsonb,
              updated_at = NOW()
        WHERE id = $1`,
      [row.id, row.notarizationId, JSON.stringify({ notarization: row.detail.notarization })],
    );
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
              transfer_id = COALESCE($7, transfer_id),
              firefly_id = COALESCE($7, firefly_id),
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [settlementId, patch.status ?? null, patch.booked ?? null, patch.txHash ?? null,
        patch.journalEntryId ?? null, patch.failureReason ?? null, patch.transferId ?? null],
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
  static _resetMemory() {
    memorySettlements.length = 0;
    for (const key of Object.keys(resolved)) delete resolved[key];
  }
}

module.exports = { FireflyEngine };
