'use strict';

/**
 * Private Electronic Payment Network OS Engine — DLB Trust Platform
 *
 * Clears and settles value between internal trust ledger accounts
 * (cash_accounts) and approved external payout instruments (tokenized
 * payment_methods) belonging to enterprise-network participants.
 *
 *   submit()       maker records a network transaction
 *                    book_transfer  internal ledger account → internal ledger account
 *                    payout         internal ledger account → approved payout instrument
 *   approve()      checker (distinct from maker) clears the transaction:
 *                    book_transfer  → CashEngine.transfer (settled on the trust ledger)
 *                    payout         → PaymentGatewayServerEngine.sale, which dispatches
 *                                     through PaymentProcessorServerEngine (cleared,
 *                                     settled by reconcile / webhook)
 *                    payout over mft_as2 → a single-entry NACHA credit file dropped
 *                                     through the trust's MFT Gateway AS2 station
 *                                     (MFTGATEWAY_STATION_AS2_ID) to the participant's
 *                                     AS2 partner (cleared, settled / returned by
 *                                     reconcile / webhook on the AS2 message id)
 *   cancel()       withdraw a submitted transaction
 *   reconcile()    processor settlement / return status back onto the transaction
 *   webhook()      HMAC-verified processor callback → reconcile
 *   pipeline()     transactions by status and type, open exposure by participant
 *
 * Funding source of record is the Fineract core-banking savings account the
 * source ledger account is linked to (cash_accounts.linked_fineract_account_id,
 * else CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID). A real-value payout is admitted
 * only if that account is active, not debit-blocked and has the available
 * balance; on dispatch the amount is withdrawn from it before the processor is
 * called (redeposited if the processor rejects or later returns the payout).
 * Book transfers between ledger accounts linked to different Fineract accounts
 * are mirrored as a withdrawal + deposit. Requires FINERACT_URL and
 * CANONICAL_FUNDING_LIVE=true; PRIVATE_PAYMENT_NETWORK_CORE_BANKING=false
 * disables the core-banking leg (sub-ledger only).
 *
 * Nothing executes unless PRIVATE_PAYMENT_NETWORK_LIVE=true AND the underlying
 * processor is real-value capable (PaymentProcessorOsEngine for payouts; the
 * trust ledger for book transfers) AND the checker supplied both an approvalRef
 * and a screeningRef. Otherwise the approval is recorded in shadow mode and no
 * ledger posting or provider call is made. Payouts are admitted only for
 * enterprise-network participants within their exposure limit. The mft_as2
 * file drop additionally needs PRIVATE_PAYMENT_NETWORK_MFT_LIVE=true and never
 * submits to our own station or a self-loopback partner.
 */

const crypto = require('crypto');

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

function tryRequire(mod) {
  try { return require(mod); } catch (e) { return null; }
}

async function settle(fn) {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: e.message }; }
}

function httpError(message, status = 400) { return Object.assign(new Error(message), { status }); }
function isTrue(v) { return String(v || '').toLowerCase() === 'true'; }

const TABLE = 'private_payment_network_transactions';
const TABLES = [
  TABLE,
  'cash_accounts',
  'cash_movements',
  'payment_methods',
  'payment_gateway_transactions',
  'enterprise_network_participants',
  'enterprise_network_exposure_limits',
  'os_events',
];
const STATUSES = ['submitted', 'approved', 'shadow', 'cleared', 'settled', 'returned', 'failed', 'cancelled'];
const TYPES = ['book_transfer', 'payout'];
const LEDGER_PROCESSOR = 'internal_ledger';
const MFT_PROCESSOR = 'mft_as2';
// Stripe and third-party card/wallet rails are not part of the family network.
const DEFAULT_EXCLUDED_PROCESSORS = 'stripe_treasury,stripe,pdcflow,skrill';
const DEFAULT_FAMILY_TYPES = 'trustee,beneficiary,family';
const MFT_ARCHIVE_PREFIX = 'private-network/outbound/';
const SEC_CODES = ['CCD', 'PPD'];
const METHOD_RAILS = { ach: 'ach', card: 'card', wallet: 'wallet', crypto: 'crypto' };
const SETTLED = new Set(['settled', 'succeeded', 'paid', 'completed', 'posted']);
const RETURNED = new Set(['returned', 'failed', 'reversed', 'declined', 'refunded', 'voided']);

const toCents = (amount) => Math.round(Number(amount) * 100);
const newId = () => 'PPN-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();

function rowToTx(row) {
  if (!row) return null;
  return {
    transactionId: row.transaction_id,
    type: row.type,
    sourceAccountId: row.source_account_id,
    destinationAccountId: row.destination_account_id,
    methodId: row.method_id,
    participantId: row.participant_id,
    processor: row.processor,
    routePolicyId: row.route_policy_id,
    amountCents: Number(row.amount_cents),
    amount: Number(row.amount_cents) / 100,
    currency: row.currency,
    status: row.status,
    realValue: Boolean(row.real_value),
    reference: row.reference,
    memo: row.memo,
    destination: row.destination || {},
    metadata: row.metadata || {},
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    approvalRef: row.approval_ref,
    screeningRef: row.screening_ref,
    movementId: row.movement_id,
    gatewayTxId: row.gateway_tx_id,
    processorTxId: row.processor_tx_id,
    route: row.route,
    result: row.result || null,
    error: row.error_message,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    clearedAt: row.cleared_at,
    settledAt: row.settled_at,
  };
}

class PrivatePaymentNetworkOsEngine {
  static get engineName() { return 'private-payment-network'; }
  static get TABLES() { return TABLES; }
  static get STATUSES() { return STATUSES; }
  static get TYPES() { return TYPES; }

  static _gateway() { return tryRequire('../payments/paymentGatewayServerEngine')?.PaymentGatewayServerEngine || null; }
  static _processorOs() { return tryRequire('./paymentProcessorOsEngine')?.PaymentProcessorOsEngine || null; }
  static _network() { return tryRequire('./enterpriseNetworkOsEngine')?.EnterpriseNetworkOsEngine || null; }
  static _ledger() { return tryRequire('../cash/cashEngine')?.CashEngine || null; }
  static _mft() { return tryRequire('../edi/mftGatewayClient')?.MftGatewayClient || null; }
  static _nacha() { return tryRequire('../ach/nachaGenerator'); }
  static _fileRelay() { return tryRequire('../openach/openachFileRelay')?.OpenAchFileRelay || null; }
  static _paymentCrypto() { return tryRequire('../paymentHub/paymentCrypto'); }
  static _fineract() { return tryRequire('../fineract/fineractClient')?.FineractClient || null; }

  static async ensureTables() {
    if (!pool) return;
    const Network = this._network();
    if (Network && typeof Network.ensureTables === 'function') await Network.ensureTables();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        transaction_id          VARCHAR(64) PRIMARY KEY,
        type                    VARCHAR(20) NOT NULL,
        source_account_id       VARCHAR(64) NOT NULL,
        destination_account_id  VARCHAR(64),
        method_id               VARCHAR(64),
        participant_id          VARCHAR(64),
        processor               VARCHAR(64) NOT NULL,
        route_policy_id         VARCHAR(64),
        amount_cents            BIGINT NOT NULL CHECK (amount_cents > 0),
        currency                VARCHAR(3) NOT NULL DEFAULT 'USD',
        status                  VARCHAR(20) NOT NULL DEFAULT 'submitted',
        real_value              BOOLEAN NOT NULL DEFAULT FALSE,
        reference               TEXT,
        memo                    TEXT,
        destination             JSONB DEFAULT '{}',
        metadata                JSONB DEFAULT '{}',
        requested_by            VARCHAR(255),
        approved_by             VARCHAR(255),
        approval_ref            TEXT,
        screening_ref           TEXT,
        movement_id             TEXT,
        gateway_tx_id           TEXT,
        processor_tx_id         TEXT,
        route                   VARCHAR(96),
        result                  JSONB,
        error_message           TEXT,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        approved_at             TIMESTAMPTZ,
        cleared_at              TIMESTAMPTZ,
        settled_at              TIMESTAMPTZ
      )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ppnt_status ON ${TABLE}(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ppnt_participant ON ${TABLE}(participant_id, status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ppnt_gateway_tx ON ${TABLE}(gateway_tx_id)`);
  }

  // ── Configuration and processor inventory ──────────────────────────────

  static getConfig(env = process.env) {
    return {
      live: isTrue(env.PRIVATE_PAYMENT_NETWORK_LIVE),
      requireApproval: env.PRIVATE_PAYMENT_NETWORK_REQUIRE_APPROVAL_REF !== 'false',
      requireScreening: env.PRIVATE_PAYMENT_NETWORK_REQUIRE_SCREENING_REF !== 'false',
      requireParticipant: env.PRIVATE_PAYMENT_NETWORK_REQUIRE_PARTICIPANT !== 'false',
      defaultProcessor: env.PRIVATE_PAYMENT_NETWORK_DEFAULT_PROCESSOR || null,
      familyOnly: isTrue(env.PRIVATE_PAYMENT_NETWORK_FAMILY_ONLY),
      familyParticipantTypes: String(env.PRIVATE_PAYMENT_NETWORK_FAMILY_PARTICIPANT_TYPES || DEFAULT_FAMILY_TYPES).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
      excludedProcessors: String(env.PRIVATE_PAYMENT_NETWORK_EXCLUDED_PROCESSORS || DEFAULT_EXCLUDED_PROCESSORS).split(',').map((s) => s.trim()).filter(Boolean),
      processorLive: isTrue(env.PAYMENT_PROCESSOR_LIVE),
      networkLive: isTrue(env.ENTERPRISE_NETWORK_LIVE),
      mftLive: isTrue(env.PRIVATE_PAYMENT_NETWORK_MFT_LIVE),
      webhookSecret: Boolean(env.PRIVATE_PAYMENT_NETWORK_WEBHOOK_SECRET),
      encryptionKey: Boolean(env.PAYMENT_DATA_ENCRYPTION_KEY),
      maxTransferCents: Number(env.PRIVATE_PAYMENT_NETWORK_MAX_TRANSFER_CENTS) > 0 ? Number(env.PRIVATE_PAYMENT_NETWORK_MAX_TRANSFER_CENTS) : null,
      coreBanking: {
        system: 'fineract',
        required: env.PRIVATE_PAYMENT_NETWORK_CORE_BANKING !== 'false',
        url: env.FINERACT_URL || null,
        configured: Boolean(env.FINERACT_URL) && !/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(env.FINERACT_URL),
        tenantId: env.FINERACT_TENANT_ID || 'default',
        live: isTrue(env.CANONICAL_FUNDING_LIVE),
        defaultSavingsAccountId: env.CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID || null,
        paymentTypeId: Number(env.CANONICAL_FUNDING_PAYMENT_TYPE_ID) > 0 ? Number(env.CANONICAL_FUNDING_PAYMENT_TYPE_ID) : 1,
      },
    };
  }

  /** Why the Fineract core-banking account of record cannot fund real value (null = it can). */
  static _coreBankingGate(cfg = this.getConfig()) {
    const cb = cfg.coreBanking;
    if (!cb.required) return null;
    if (!cb.configured) return 'FINERACT_URL not set to the core-banking service (Fineract funding source unreachable)';
    if (!this._fineract()) return 'FineractClient unavailable';
    if (!cb.live) return 'CANONICAL_FUNDING_LIVE=false (Fineract core-banking account of record is shadow-only; real-value payouts cannot draw on it)';
    return null;
  }

  static _savingsAccountId(acct, cfg = this.getConfig()) {
    return String(acct?.linked_fineract_account_id || cfg.coreBanking.defaultSavingsAccountId || '').trim() || null;
  }

  /** Live Fineract savings position of a linked ledger account. */
  static async _coreBankingPosition(savingsAccountId) {
    const Fineract = this._fineract();
    if (!Fineract) throw httpError('FineractClient unavailable', 503);
    const acct = await Fineract.getAccountBalance(savingsAccountId);
    const summary = acct?.summary || {};
    const available = summary.availableBalance ?? summary.accountBalance ?? 0;
    return {
      system: 'fineract',
      savingsAccountId: String(savingsAccountId),
      accountNo: acct?.accountNo || null,
      clientName: acct?.clientName || null,
      productName: acct?.savingsProductName || null,
      active: Boolean(acct?.status?.active),
      debitBlocked: Boolean(acct?.subStatus?.block || acct?.subStatus?.blockDebit),
      balanceCents: toCents(summary.accountBalance || 0),
      availableCents: toCents(available),
    };
  }

  /** Withdraw from the linked Fineract account of record (core-banking debit). */
  static async _coreBankingWithdraw(savingsAccountId, tx, note) {
    const Fineract = this._fineract();
    const cfg = this.getConfig();
    const res = await Fineract.withdrawSavings({
      accountId: savingsAccountId,
      amount: tx.amount,
      paymentTypeId: cfg.coreBanking.paymentTypeId,
      note: note || `private payment network ${tx.transactionId}`,
    });
    return {
      system: 'fineract',
      savingsAccountId: String(savingsAccountId),
      withdrawalTransactionId: res?.resourceId != null ? String(res.resourceId) : null,
      amount: tx.amount,
      at: new Date().toISOString(),
    };
  }

  /** Undo a withdrawal after a failed dispatch; a failed redeposit is named in the error so the Fineract movement is never silent. */
  static async _unwindWithdrawal(coreBanking, tx, reason, cause) {
    const undo = await settle(() => this._coreBankingRedeposit(coreBanking, tx, reason));
    if (undo.ok) return new Error(cause);
    return new Error(`${cause}; Fineract withdrawal ${coreBanking.withdrawalTransactionId} on account ${coreBanking.savingsAccountId} NOT redeposited (${undo.error}) — reverse manually`);
  }

  /** Redeposit a prior withdrawal (processor rejected or returned the payout). */
  static async _coreBankingRedeposit(coreBanking, tx, reason) {
    const Fineract = this._fineract();
    if (!Fineract || !coreBanking?.savingsAccountId || coreBanking.reversal) return coreBanking;
    const cfg = this.getConfig();
    const res = await Fineract.depositSavings({
      accountId: coreBanking.savingsAccountId,
      amount: coreBanking.amount ?? tx.amount,
      paymentTypeId: cfg.coreBanking.paymentTypeId,
      note: `private payment network ${tx.transactionId} ${reason}`,
    });
    return {
      ...coreBanking,
      reversal: { depositTransactionId: res?.resourceId != null ? String(res.resourceId) : null, reason, at: new Date().toISOString() },
    };
  }

  static isSelfLoopbackUrl(url, env = process.env) {
    const P = this._processorOs();
    if (P) return P.isSelfLoopbackUrl(url, env);
    const u = String(url || '').trim().toLowerCase();
    return !u ? false : /^(direct|local|self|loopback)$/.test(u) || /^https?:\/\/(localhost|127\.0\.0\.1)/.test(u);
  }

  /** Reject payout destinations that resolve to this platform (self-loopback partner). */
  static loopbackReason(destination = {}, processor) {
    const P = this._processorOs();
    if (P) return P.loopbackReason(destination || {}, processor);
    const d = destination || {};
    if (d.loopback === true || d.selfLoopback === true) return 'destination flagged as self-loopback';
    for (const k of ['url', 'apiBaseUrl', 'partnerUrl', 'endpoint', 'webhookUrl', 'callbackUrl']) {
      if (d[k] && this.isSelfLoopbackUrl(d[k])) return `destination.${k}=${d[k]} points back at this platform`;
    }
    return null;
  }

  /** AS2 partners that are our own station or a self-loopback partner id. */
  static as2LoopbackReason(partnerAs2Id, stationAs2Id) {
    const partner = String(partnerAs2Id || '').trim();
    if (!partner) return null;
    const station = String(stationAs2Id || this._mft()?.getConfig().stationAs2Id || '').trim();
    if (station && partner.toUpperCase() === station.toUpperCase()) return `partner ${partner} is this platform's own AS2 station`;
    return this.loopbackReason({ partnerAs2Id: partner });
  }

  /**
   * AS2 route for an mft_as2 file drop: the destination's partnerAs2Id, else the
   * participant endpoint's, else MFTGATEWAY_PARTNER_AS2_ID. Refuses loopback.
   */
  static _as2Route(destination = {}, participant = null) {
    const Mft = this._mft();
    const mcfg = Mft ? Mft.getConfig() : {};
    const candidates = [
      ['destination', destination?.partnerAs2Id],
      ['participant', participant?.endpoint?.partnerAs2Id],
      ['MFTGATEWAY_PARTNER_AS2_ID', mcfg.partnerAs2Id],
    ];
    const [source, id] = candidates.find(([, v]) => String(v || '').trim()) || [null, null];
    const partnerAs2Id = id ? String(id).trim() : null;
    const stationAs2Id = mcfg.stationAs2Id || null;
    const loop = this.as2LoopbackReason(partnerAs2Id, stationAs2Id);
    if (loop) throw httpError(`self-loopback partner refused: ${loop}`, 409);
    return { stationAs2Id, partnerAs2Id, partnerSource: source };
  }

  /** Why the mft_as2 file drop cannot carry real value (null = it can). */
  static _mftGate(cfg = this.getConfig()) {
    if (!cfg.live) return 'PRIVATE_PAYMENT_NETWORK_LIVE=false';
    if (!cfg.encryptionKey) return 'PAYMENT_DATA_ENCRYPTION_KEY not set (payout instruments cannot be tokenized safely)';
    if (!cfg.networkLive) return 'ENTERPRISE_NETWORK_LIVE=false (payout participants and exposure limits are shadow-only)';
    if (!cfg.mftLive) return 'PRIVATE_PAYMENT_NETWORK_MFT_LIVE=false (NACHA file drop through the MFT Gateway AS2 station is shadow-only)';
    const Mft = this._mft();
    const Nacha = this._nacha();
    if (!Mft || !Nacha || !this._paymentCrypto() || !this._gateway()) return 'MftGatewayClient / nachaGenerator / paymentCrypto / PaymentGatewayServerEngine unavailable';
    const issues = Mft.issues().filter((i) => !/PARTNER_AS2_ID/.test(i));
    if (issues.length) return issues.join('; ');
    if (!Nacha.validateRouting(String(Nacha.ODFI_ROUTING || ''))) return 'NACHA_ODFI_ROUTING is not a valid ABA routing number';
    return null;
  }

  /**
   * Network processors. External payouts inherit real-value capability from
   * the payment-processor engine (every payout dispatches through it via the
   * gateway) and additionally need PRIVATE_PAYMENT_NETWORK_LIVE, the
   * payment-data encryption key and a live enterprise-network registry. Book
   * transfers settle on the trust ledger and need PRIVATE_PAYMENT_NETWORK_LIVE
   * plus a reachable ledger.
   */
  static async processors() {
    const cfg = this.getConfig();
    const P = this._processorOs();
    const upstream = P ? await settle(() => P.processors()) : { ok: false, error: 'PaymentProcessorOsEngine unavailable' };
    const coreBankingGate = this._coreBankingGate(cfg);
    const gate = !cfg.live ? 'PRIVATE_PAYMENT_NETWORK_LIVE=false'
      : !cfg.encryptionKey ? 'PAYMENT_DATA_ENCRYPTION_KEY not set (payout instruments cannot be tokenized safely)'
        : !cfg.networkLive ? 'ENTERPRISE_NETWORK_LIVE=false (payout participants and exposure limits are shadow-only)'
          : !this._gateway() ? 'PaymentGatewayServerEngine unavailable'
            : !upstream.ok ? `payment-processor: ${upstream.error}`
              : !upstream.value.config.live ? 'PAYMENT_PROCESSOR_LIVE=false (payouts dispatch through the payment-processor engine)'
                : coreBankingGate ? `core-banking funding source: ${coreBankingGate}`
                  : null;
    const ledgerGate = !cfg.live ? 'PRIVATE_PAYMENT_NETWORK_LIVE=false'
      : !pool ? 'ledger database unavailable'
        : !this._ledger() ? 'CashEngine unavailable'
          : null;
    const external = (upstream.ok ? upstream.value.sources : []).map((up) => {
      const excluded = this.excludedReason(up.id, cfg);
      return {
        id: up.id,
        kind: 'payout',
        mode: excluded ? 'excluded' : (up.mode || 'unset'),
        configured: Boolean(up.configured),
        realValueCapable: !gate && !excluded && Boolean(up.realValueCapable),
        reason: excluded || (!gate && up.realValueCapable ? null : (gate || up.reason || `${up.id} is not real-value capable`)),
        route: 'PaymentGatewayServerEngine.sale → PaymentProcessorServerEngine.processPayment',
      };
    });
    const ledger = {
      id: LEDGER_PROCESSOR,
      kind: 'book_transfer',
      mode: ledgerGate ? 'shadow' : 'live',
      configured: Boolean(pool && this._ledger()),
      realValueCapable: !ledgerGate,
      reason: ledgerGate,
      route: 'CashEngine.transfer',
    };
    const mftGate = this._mftGate(cfg) || (coreBankingGate ? `core-banking funding source: ${coreBankingGate}` : null);
    const Mft = this._mft();
    const mcfg = Mft ? Mft.getConfig() : {};
    const fileDrop = {
      id: MFT_PROCESSOR,
      kind: 'payout',
      mode: mftGate ? 'shadow' : 'live',
      configured: Boolean(Mft && Mft.configured()),
      realValueCapable: !mftGate,
      reason: mftGate,
      route: 'nachaGenerator → MftGatewayClient.submit (AS2 station file drop)',
      stationAs2Id: mcfg.stationAs2Id || null,
      defaultPartnerAs2Id: mcfg.partnerAs2Id || null,
    };
    const sources = [ledger, ...external, fileDrop];
    const realValueCapable = sources.filter((s) => s.realValueCapable).map((s) => s.id);
    const fundingSource = {
      id: 'fineract_core_banking',
      kind: 'funding_source',
      system: 'fineract',
      mode: coreBankingGate ? 'shadow' : cfg.coreBanking.required ? 'live' : 'disabled',
      required: cfg.coreBanking.required,
      configured: cfg.coreBanking.configured,
      live: cfg.coreBanking.live,
      defaultSavingsAccountId: cfg.coreBanking.defaultSavingsAccountId,
      reason: coreBankingGate,
      route: 'cash_accounts.linked_fineract_account_id → FineractClient.getAccountBalance / withdrawSavings (redeposit on return)',
    };
    return { config: cfg, gate, ledgerGate, mftGate, coreBankingGate, fundingSource, sources, realValueCapable, anyRealValueCapable: realValueCapable.length > 0, familyOnly: cfg.familyOnly, excludedProcessors: cfg.excludedProcessors };
  }

  /** Processors the network refuses outright (retired Stripe and third-party card/wallet rails). */
  static excludedReason(processor, cfg = this.getConfig()) {
    const p = String(processor || '');
    return cfg.excludedProcessors.some((x) => x === p || p.startsWith(`${x}_`)) ? `${p} is excluded from the Private Electronic Payment Network (PRIVATE_PAYMENT_NETWORK_EXCLUDED_PROCESSORS)` : null;
  }

  /** In family-only mode a payout may reach only a trustee / beneficiary participant of the trust. */
  static familyReason(participant, cfg = this.getConfig()) {
    if (!cfg.familyOnly) return null;
    if (!participant) return 'family-only network: payout needs a family participant (trustee / beneficiary)';
    const type = String(participant.participantType || participant.type || '').toLowerCase();
    const flagged = participant.metadata && participant.metadata.family === true;
    if (cfg.familyParticipantTypes.includes(type) || flagged) return null;
    return `family-only network: participant ${participant.participantId || participant.id} is ${type || 'untyped'}, not one of ${cfg.familyParticipantTypes.join('/')} (or metadata.family=true)`;
  }

  static async isRealValue(processor, inventory) {
    const inv = inventory || await this.processors();
    const src = inv.sources.find((s) => s.id === processor);
    return Boolean(inv.config.live && src && src.realValueCapable);
  }

  // ── Admission checks ────────────────────────────────────────────────────

  static async _account(accountId, label, { cents, coreBanking = false } = {}) {
    const Ledger = this._ledger();
    if (!Ledger) throw httpError('CashEngine (trust ledger) not available', 503);
    if (!accountId) throw httpError(`${label} required`);
    const acct = await Ledger.getAccount(accountId);
    if (!acct) throw httpError(`ledger account ${accountId} not found`, 404);
    if (acct.status && acct.status !== 'active') throw httpError(`ledger account ${accountId} is ${acct.status}`, 409);
    if (cents != null && Number(acct.balance_cents) < cents) {
      throw httpError(`insufficient balance in ${accountId}: ${acct.balance_cents} < ${cents} cents`, 409);
    }
    if (!coreBanking) return acct;
    const cfg = this.getConfig();
    if (!cfg.coreBanking.required) return acct;
    const gate = this._coreBankingGate(cfg);
    if (gate) throw httpError(`core-banking funding source: ${gate}`, 409);
    const savingsAccountId = this._savingsAccountId(acct, cfg);
    if (!savingsAccountId) {
      throw httpError(`ledger account ${accountId} is not linked to a Fineract core-banking account (POST /api/cash/accounts/${accountId}/link-fineract or set CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID)`, 409);
    }
    const position = await this._coreBankingPosition(savingsAccountId);
    if (!position.active) throw httpError(`Fineract account ${savingsAccountId} is not active`, 409);
    if (position.debitBlocked) throw httpError(`Fineract account ${savingsAccountId} is debit-blocked`, 409);
    if (cents != null && position.availableCents < cents) {
      throw httpError(`insufficient core-banking balance in Fineract account ${savingsAccountId}: ${position.availableCents} < ${cents} cents available`, 409);
    }
    return { ...acct, coreBanking: position };
  }

  static async _method(methodId) {
    const Gateway = this._gateway();
    if (!Gateway) throw httpError('PaymentGatewayServerEngine not available', 503);
    if (!methodId) throw httpError('methodId (approved payout instrument) required for a payout');
    const method = await Gateway.getMethod(methodId);
    if (!method) throw httpError(`payment method ${methodId} not found`, 404);
    if (method.status && method.status !== 'active') throw httpError(`payment method ${methodId} is ${method.status}`, 409);
    return method;
  }

  static async _admitParticipant(participantId, cents, realValue) {
    const cfg = this.getConfig();
    if (!participantId) {
      if (cfg.requireParticipant || realValue) throw httpError('participantId (enterprise-network participant) is required for a payout', 409);
      return null;
    }
    const Network = this._network();
    if (!Network) throw httpError('EnterpriseNetworkOsEngine not available', 503);
    return Network.admit({ participantId, amountCents: cents, realValue });
  }

  // ── Maker / checker flow ───────────────────────────────────────────────

  static async submit({
    type = 'payout', sourceAccountId, destinationAccountId, methodId, participantId, processor,
    amount, amountCents, currency = 'USD', reference, memo, destination = {}, metadata = {},
    requestedBy, approvalRef, screeningRef,
  } = {}) {
    if (!pool) throw httpError('ledger database unavailable', 503);
    const cfg = this.getConfig();
    if (!TYPES.includes(type)) throw httpError(`type must be one of ${TYPES.join(', ')}`);
    if (!requestedBy) throw httpError('requestedBy required');
    const cents = amountCents != null ? Math.round(Number(amountCents)) : toCents(amount);
    if (!Number.isFinite(cents) || cents <= 0) throw httpError('amount must be > 0');
    if (cfg.maxTransferCents && cents > cfg.maxTransferCents) {
      throw httpError(`amount ${cents} exceeds PRIVATE_PAYMENT_NETWORK_MAX_TRANSFER_CENTS=${cfg.maxTransferCents}`, 409);
    }
    await this._account(sourceAccountId, 'sourceAccountId');

    let chosen;
    let routePolicyId = null;
    let method = null;
    if (type === 'book_transfer') {
      await this._account(destinationAccountId, 'destinationAccountId');
      if (destinationAccountId === sourceAccountId) throw httpError('book transfer source and destination must differ', 409);
      chosen = LEDGER_PROCESSOR;
    } else {
      method = await this._method(methodId);
      const Network = this._network();
      const rail = METHOD_RAILS[method.type] || method.type;
      const route = participantId && Network ? await Network.resolveRoute({ participantId, rail, amountCents: cents }) : null;
      const Gateway = this._gateway();
      chosen = String(processor || route?.processor || (method.processor && method.processor !== 'generic' ? method.processor : '') || cfg.defaultProcessor || Gateway._processorFromMethod(method)).trim();
      if (!chosen) throw httpError('processor required');
      if (chosen === LEDGER_PROCESSOR) throw httpError(`${LEDGER_PROCESSOR} cannot carry an external payout`, 409);
      const excluded = this.excludedReason(chosen, cfg);
      if (excluded) throw httpError(excluded, 409);
      routePolicyId = route && !processor ? route.policyId : null;
      const loop = this.loopbackReason(destination, chosen);
      if (loop) throw httpError(`self-loopback partner refused: ${loop}`, 409);
      if (chosen === MFT_PROCESSOR) {
        if (method.type !== 'ach') throw httpError(`${MFT_PROCESSOR} carries NACHA credits only; payment method ${methodId} is ${method.type}`, 409);
        if (destination?.secCode && !SEC_CODES.includes(String(destination.secCode).toUpperCase())) throw httpError(`destination.secCode must be one of ${SEC_CODES.join(', ')}`);
      }
    }
    const realValue = await this.isRealValue(chosen);
    const admission = type === 'payout' ? await this._admitParticipant(participantId, cents, false) : null;
    if (type === 'payout') {
      const fam = this.familyReason(admission?.participant, cfg);
      if (fam) throw httpError(fam, 409);
    }
    const as2 = chosen === MFT_PROCESSOR ? this._as2Route(destination, admission?.participant) : null;

    const id = newId();
    const res = await pool.query(
      `INSERT INTO ${TABLE} (transaction_id, type, source_account_id, destination_account_id, method_id, participant_id, processor, route_policy_id, amount_cents, currency, status, real_value, reference, memo, destination, metadata, requested_by, approval_ref, screening_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'submitted',$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18) RETURNING *`,
      [id, type, sourceAccountId, type === 'book_transfer' ? destinationAccountId : null, type === 'payout' ? methodId : null,
        participantId || null, chosen, routePolicyId, cents, String(currency).toUpperCase(), realValue, reference || null, memo || null,
        JSON.stringify(destination || {}), JSON.stringify({ ...(metadata || {}), methodType: method ? method.type : null, ...(as2 ? { as2 } : {}) }),
        requestedBy, approvalRef || null, screeningRef || null]
    );
    return rowToTx(res.rows[0]);
  }

  static async approve({ transactionId, approvedBy, approvalRef, screeningRef } = {}) {
    if (!pool) throw httpError('ledger database unavailable', 503);
    if (!transactionId) throw httpError('transactionId required');
    if (!approvedBy) throw httpError('approvedBy required');
    const row = await this._get(transactionId);
    if (!row) throw httpError('transaction not found', 404);
    if (row.status !== 'submitted') throw httpError(`transaction ${transactionId} is ${row.status}, expected submitted`, 409);
    if (row.requested_by && row.requested_by === approvedBy) throw httpError('maker/checker: approver must differ from requester', 409);

    const cfg = this.getConfig();
    const tx = rowToTx(row);
    const inventory = await this.processors();
    if (tx.type === 'payout') {
      const loop = this.loopbackReason(tx.destination, tx.processor)
        || (tx.processor === MFT_PROCESSOR ? this.as2LoopbackReason(tx.metadata?.as2?.partnerAs2Id) : null);
      if (loop) throw httpError(`self-loopback partner refused: ${loop}`, 409);
    }
    const realValue = await this.isRealValue(tx.processor, inventory);
    let as2 = null;
    if (realValue) {
      if (cfg.requireApproval && !approvalRef) throw httpError('approvalRef (maker/checker record) is required from the checker before a real-value network transaction is cleared', 409);
      if (cfg.requireScreening && !screeningRef) throw httpError('screeningRef (compliance screening id) is required from the checker before a real-value network transaction is cleared', 409);
      await this._account(tx.sourceAccountId, 'sourceAccountId', { cents: tx.amountCents, coreBanking: tx.type === 'payout' });
      if (tx.type === 'book_transfer') await this._account(tx.destinationAccountId, 'destinationAccountId');
      else {
        const method = await this._method(tx.methodId);
        const admission = await this._admitParticipant(tx.participantId, 0, true);
        if (tx.processor === MFT_PROCESSOR) {
          if (method.type !== 'ach') throw httpError(`${MFT_PROCESSOR} carries NACHA credits only; payment method ${tx.methodId} is ${method.type}`, 409);
          as2 = this._as2Route(tx.destination, admission?.participant);
          if (!as2.partnerAs2Id) throw httpError('no AS2 partner for the MFT file drop: set destination.partnerAs2Id, the participant endpoint.partnerAs2Id or MFTGATEWAY_PARTNER_AS2_ID', 409);
        }
      }
    }

    await pool.query(
      `UPDATE ${TABLE} SET status = 'approved', approved_by = $2, approval_ref = $3, screening_ref = $4, real_value = $5, approved_at = NOW() WHERE transaction_id = $1`,
      [transactionId, approvedBy, approvalRef || null, screeningRef || null, realValue]
    );

    if (!realValue) {
      const src = inventory.sources.find((s) => s.id === tx.processor);
      const note = (src && src.reason) || (tx.type === 'book_transfer' ? inventory.ledgerGate : inventory.gate) || `${tx.processor} is not real-value capable`;
      await pool.query(`UPDATE ${TABLE} SET status = 'shadow', route = 'shadow', result = $2::jsonb WHERE transaction_id = $1`,
        [transactionId, JSON.stringify({ mode: 'shadow', note })]);
      return { ...rowToTx(await this._get(transactionId)), dispatched: false, note };
    }

    const dispatch = await settle(() => this._dispatch({ ...tx, approvedBy, approvalRef, screeningRef, as2 }));
    if (!dispatch.ok) {
      await pool.query(`UPDATE ${TABLE} SET status = 'failed', error_message = $2 WHERE transaction_id = $1`, [transactionId, dispatch.error]);
      throw httpError(`dispatch failed: ${dispatch.error}`, 502);
    }
    const { route, status, movementId, gatewayTxId, processorTxId, result } = dispatch.value;
    await pool.query(
      `UPDATE ${TABLE} SET status = $2, route = $3, movement_id = $4, gateway_tx_id = $5, processor_tx_id = $6, result = $7::jsonb,
         cleared_at = NOW(), settled_at = CASE WHEN $2 = 'settled' THEN NOW() ELSE settled_at END
       WHERE transaction_id = $1`,
      [transactionId, status, route, movementId || null, gatewayTxId || null, processorTxId || null, JSON.stringify(result || {})]
    );
    return { ...rowToTx(await this._get(transactionId)), dispatched: true };
  }

  /** Real-value clearing; only reached from approve() after every gate passed. */
  static async _dispatch(tx) {
    const metadata = {
      ...tx.metadata,
      network: 'private-payment-network',
      transactionId: tx.transactionId,
      participantId: tx.participantId,
      sourceAccountId: tx.sourceAccountId,
      approvalRef: tx.approvalRef,
      screeningRef: tx.screeningRef,
      approvedBy: tx.approvedBy,
      processor: tx.processor,
    };
    if (tx.type === 'book_transfer') {
      const Ledger = this._ledger();
      if (!Ledger) throw new Error('CashEngine not available');
      const coreBanking = await this._mirrorBookTransfer(tx);
      const movement = await Ledger.transfer({
        fromAccountId: tx.sourceAccountId,
        toAccountId: tx.destinationAccountId,
        amountCents: tx.amountCents,
        movementType: 'private_network_transfer',
        memo: tx.memo || `private payment network ${tx.transactionId}`,
        referenceId: tx.transactionId,
        referenceType: 'private_payment_network',
        initiatedBy: tx.approvedBy,
      });
      return { route: 'CashEngine.transfer', status: 'settled', movementId: movement?.movement_id || null, result: { movement, metadata, coreBanking } };
    }
    const cfg = this.getConfig();
    let coreBanking = null;
    if (cfg.coreBanking.required) {
      const gate = this._coreBankingGate(cfg);
      if (gate) throw new Error(`core-banking funding source: ${gate}`);
      const src = await this._ledger().getAccount(tx.sourceAccountId);
      const savingsAccountId = this._savingsAccountId(src, cfg);
      if (!savingsAccountId) throw new Error(`ledger account ${tx.sourceAccountId} is not linked to a Fineract core-banking account`);
      coreBanking = await this._coreBankingWithdraw(savingsAccountId, tx, tx.memo);
    }
    if (tx.processor === MFT_PROCESSOR) {
      const out = await settle(() => this._dispatchFileDrop(tx, metadata));
      if (!out.ok) {
        throw coreBanking ? await this._unwindWithdrawal(coreBanking, tx, 'file drop failed', out.error) : new Error(out.error);
      }
      return { ...out.value, result: { ...(out.value.result || {}), coreBanking } };
    }
    const Gateway = this._gateway();
    if (!Gateway) throw new Error('PaymentGatewayServerEngine not available');
    const attempt = await settle(() => Gateway.sale({
      amount: tx.amount,
      currency: tx.currency,
      methodId: tx.methodId,
      reference: tx.reference || tx.transactionId,
      direction: 'outbound',
      source: { ledgerAccountId: tx.sourceAccountId },
      destination: tx.destination,
      processor: tx.processor,
      metadata,
      initiatedBy: tx.approvedBy,
    }));
    if (!attempt.ok || attempt.value.status === 'failed') {
      const cause = attempt.ok ? `processor rejected payout ${attempt.value.gatewayTxId || ''}`.trim() : attempt.error;
      throw coreBanking ? await this._unwindWithdrawal(coreBanking, tx, 'processor rejected', cause) : new Error(cause);
    }
    const sale = attempt.value;
    return {
      route: coreBanking ? 'FineractClient.withdrawSavings → PaymentGatewayServerEngine.sale' : 'PaymentGatewayServerEngine.sale',
      status: sale.status === 'settled' ? 'settled' : 'cleared',
      gatewayTxId: sale.gatewayTxId || null,
      processorTxId: sale.processorTxId || null,
      result: { ...sale, coreBanking },
    };
  }

  /**
   * Book transfers between ledger accounts linked to different Fineract accounts
   * move the cash in the core bank too (withdrawal + deposit). Same account (or
   * unlinked, or core banking disabled/shadow) → sub-ledger movement only.
   */
  static async _mirrorBookTransfer(tx) {
    const cfg = this.getConfig();
    if (!cfg.coreBanking.required || this._coreBankingGate(cfg)) return null;
    const Ledger = this._ledger();
    const [src, dst] = await Promise.all([Ledger.getAccount(tx.sourceAccountId), Ledger.getAccount(tx.destinationAccountId)]);
    const from = this._savingsAccountId(src, cfg);
    const to = this._savingsAccountId(dst, cfg);
    if (!from || !to || from === to) return { system: 'fineract', mirrored: false, savingsAccountId: from || to || null };
    const withdrawal = await this._coreBankingWithdraw(from, tx, tx.memo);
    const Fineract = this._fineract();
    const dep = await settle(() => Fineract.depositSavings({ accountId: to, amount: tx.amount, paymentTypeId: cfg.coreBanking.paymentTypeId, note: `private payment network ${tx.transactionId}` }));
    if (!dep.ok) throw await this._unwindWithdrawal(withdrawal, tx, 'destination deposit failed', `Fineract deposit to ${to} failed: ${dep.error}`);
    return { ...withdrawal, mirrored: true, toSavingsAccountId: to, depositTransactionId: dep.value?.resourceId != null ? String(dep.value.resourceId) : null };
  }

  /**
   * Builds a single-entry NACHA credit for the payout instrument, archives it in
   * the OpenACH files bucket (outside the relay's export/ prefix) and submits it
   * from our AS2 station to the partner. The account number never leaves the
   * file: the transaction result only keeps the file hash and AS2 message id.
   */
  static async _dispatchFileDrop(tx, metadata) {
    const Gateway = this._gateway();
    const Mft = this._mft();
    const Nacha = this._nacha();
    const PaymentCrypto = this._paymentCrypto();
    if (!Gateway || !Mft || !Nacha || !PaymentCrypto) throw new Error('MFT file drop dependencies unavailable');
    const as2 = tx.as2;
    if (!as2 || !as2.partnerAs2Id) throw new Error('AS2 partner not resolved');
    const method = await Gateway.getMethod(tx.methodId, true);
    if (!method || method.type !== 'ach' || !method.encrypted_payload) throw new Error(`payment method ${tx.methodId} has no tokenized ACH instrument`);
    let bank;
    try { bank = JSON.parse(PaymentCrypto.decrypt(method.encrypted_payload)); } catch (e) { throw new Error(`payment method ${tx.methodId} could not be decrypted`); }
    const routing = String(bank.routingNumber || '').trim();
    const accountNumber = String(bank.accountNumber || '').trim();
    if (!Nacha.validateRouting(routing)) throw new Error(`payment method ${tx.methodId} has an invalid routing number`);
    if (!/^[0-9A-Za-z-]{1,17}$/.test(accountNumber)) throw new Error(`payment method ${tx.methodId} has an invalid account number`);

    const d = tx.destination || {};
    const secCode = SEC_CODES.includes(String(d.secCode || '').toUpperCase()) ? String(d.secCode).toUpperCase() : 'CCD';
    const savings = /sav/i.test(String(d.accountType || bank.accountType || ''));
    const name = String(d.name || method.billing_details?.name || tx.participantId || '').toUpperCase();
    const content = Nacha.generateNACHAFile({}, [{
      secCode,
      companyEntryDescription: String(d.entryDescription || 'PAYOUT').toUpperCase().slice(0, 10),
      serviceClassCode: '220',
      entries: [{
        receivingRouting: routing,
        accountNumber,
        amountCents: tx.amountCents,
        transactionCode: savings ? '32' : '22',
        individualId: tx.transactionId.slice(-15),
        individualName: name.slice(0, 22),
      }],
    }]);
    const payload = Buffer.from(content, 'utf8');
    const filename = `${tx.transactionId}.ach`;
    const sha256 = crypto.createHash('sha256').update(payload).digest('hex');

    const Relay = this._fileRelay();
    const archivedTo = Relay && Relay.getConfig().bucket ? await Relay.archive(MFT_ARCHIVE_PREFIX + filename, payload) : null;

    const sent = await Mft.submit(payload, filename, {
      stationAs2Id: as2.stationAs2Id,
      partnerAs2Id: as2.partnerAs2Id,
      contentType: 'text/plain',
      subject: `NACHA ${filename}`,
    });
    if (!sent.success) throw new Error(`MFT Gateway ${sent.status_code}: ${sent.response_body || 'submit rejected'}`);
    return {
      route: 'MftGatewayClient.submit',
      status: 'cleared',
      processorTxId: sent.message_id || null,
      result: {
        transport: 'mftgateway',
        as2From: sent.as2_from,
        as2To: sent.as2_to,
        partnerSource: as2.partnerSource,
        messageId: sent.message_id || null,
        filename,
        bytes: payload.length,
        sha256,
        secCode,
        entries: 1,
        archivedTo,
        transmittedAt: sent.transmitted_at,
        metadata,
      },
    };
  }

  static async cancel({ transactionId, cancelledBy, reason } = {}) {
    if (!pool) throw httpError('ledger database unavailable', 503);
    const row = await this._get(transactionId);
    if (!row) throw httpError('transaction not found', 404);
    if (row.status !== 'submitted') throw httpError(`transaction ${transactionId} is ${row.status}; cannot cancel`, 409);
    await pool.query(`UPDATE ${TABLE} SET status = 'cancelled', error_message = $2, result = $3::jsonb WHERE transaction_id = $1`,
      [transactionId, reason || null, JSON.stringify({ cancelledBy: cancelledBy || null, reason: reason || null })]);
    return rowToTx(await this._get(transactionId));
  }

  // ── Status / reconcile / webhook ────────────────────────────────────────

  static async transactionStatus({ transactionId, gatewayTxId } = {}) {
    if (!transactionId && !gatewayTxId) throw httpError('transactionId or gatewayTxId required');
    const row = transactionId ? await this._get(transactionId) : await this._getByTx(gatewayTxId);
    if (!row) throw httpError('transaction not found', 404);
    const tx = rowToTx(row);
    const Gateway = this._gateway();
    const gw = tx.gatewayTxId && Gateway ? await settle(() => Gateway.getStatus(tx.gatewayTxId)) : null;
    return { ...tx, gatewayTransaction: gw ? (gw.ok ? gw.value : { error: gw.error }) : null };
  }

  /**
   * Moves a cleared payout to settled / returned from the processor status and
   * mirrors it onto the gateway transaction. Book transfers settle on approval,
   * so reconciling one only reports its ledger movement.
   */
  static async reconcile({ transactionId, gatewayTxId, processorTxId, status, raw = {} } = {}) {
    if (!pool) throw httpError('ledger database unavailable', 503);
    let row = null;
    if (transactionId) row = await this._get(transactionId);
    else if (gatewayTxId || processorTxId) row = await this._getByTx(gatewayTxId || processorTxId);
    if (!row) throw httpError('transaction not found', 404);
    const tx = rowToTx(row);
    if (tx.type === 'book_transfer') {
      return { transactionId: tx.transactionId, type: tx.type, status: tx.status, movementId: tx.movementId, reconciliation: null };
    }
    const txId = gatewayTxId || tx.gatewayTxId;
    const s = String(status || '').toLowerCase();
    let out;
    if (tx.processor === MFT_PROCESSOR) {
      const messageId = processorTxId || tx.processorTxId;
      if (!messageId) throw httpError('file drop has no MFT Gateway message id to reconcile', 409);
      out = { transport: 'mftgateway', messageId, status: s || null };
    } else {
      if (!txId && !processorTxId && !tx.processorTxId) throw httpError('transaction has no gateway transaction to reconcile', 409);
      const Gateway = this._gateway();
      if (!Gateway) throw httpError('PaymentGatewayServerEngine not available', 503);
      const gatewayStatus = SETTLED.has(s) ? 'settled' : RETURNED.has(s) ? 'failed' : s;
      out = await Gateway.reconcileWebhook({ gatewayTxId: txId, processorTxId: processorTxId || tx.processorTxId, status: gatewayStatus, raw });
    }
    let next = tx.status;
    if (tx.status === 'cleared' && SETTLED.has(s)) next = 'settled';
    else if (['cleared', 'settled'].includes(tx.status) && RETURNED.has(s)) next = 'returned';
    const patch = { reconciliation: { status: s || null, at: new Date().toISOString(), gateway: out } };
    if (next === 'returned' && tx.status !== 'returned' && tx.result?.coreBanking?.withdrawalTransactionId && !tx.result.coreBanking.reversal) {
      const reversed = await settle(() => this._coreBankingRedeposit(tx.result.coreBanking, tx, `payout ${s}`));
      patch.coreBanking = reversed.ok ? reversed.value : { ...tx.result.coreBanking, reversalError: reversed.error };
    }
    await pool.query(
      `UPDATE ${TABLE} SET status = $2, processor_tx_id = COALESCE(processor_tx_id, $3), result = COALESCE(result, '{}'::jsonb) || $4::jsonb,
         settled_at = CASE WHEN $2 = 'settled' AND settled_at IS NULL THEN NOW() ELSE settled_at END
       WHERE transaction_id = $1`,
      [tx.transactionId, next, processorTxId || null, JSON.stringify(patch)]
    );
    return { transactionId: tx.transactionId, gatewayTxId: txId || null, previousStatus: tx.status, status: next, reconciliation: out, coreBanking: patch.coreBanking || tx.result?.coreBanking || null };
  }

  /** Processor callback: HMAC-SHA256 over the raw body with PRIVATE_PAYMENT_NETWORK_WEBHOOK_SECRET. */
  static verifyWebhookSignature(rawBody, signature, env = process.env) {
    const secret = env.PRIVATE_PAYMENT_NETWORK_WEBHOOK_SECRET;
    if (!secret) return { ok: false, reason: 'PRIVATE_PAYMENT_NETWORK_WEBHOOK_SECRET not set' };
    if (!signature) return { ok: false, reason: 'missing signature' };
    const expected = crypto.createHmac('sha256', secret).update(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody || {})).digest('hex');
    const given = String(signature).replace(/^sha256=/, '').trim();
    if (given.length !== expected.length) return { ok: false, reason: 'invalid signature' };
    const ok = crypto.timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'));
    return ok ? { ok: true } : { ok: false, reason: 'invalid signature' };
  }

  static async webhook({ rawBody, signature, payload = {} } = {}) {
    const check = this.verifyWebhookSignature(rawBody ?? payload, signature);
    if (!check.ok) throw httpError(`webhook rejected: ${check.reason}`, 401);
    return this.reconcile({ transactionId: payload.transactionId, gatewayTxId: payload.gatewayTxId, processorTxId: payload.processorTxId, status: payload.status, raw: payload });
  }

  static async listTransactions({ status, type, participantId, processor, limit = 50 } = {}) {
    if (!pool) return [];
    const where = [];
    const params = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (type) { params.push(type); where.push(`type = $${params.length}`); }
    if (participantId) { params.push(participantId); where.push(`participant_id = $${params.length}`); }
    if (processor) { params.push(processor); where.push(`processor = $${params.length}`); }
    params.push(Math.min(Number(limit) || 50, 500));
    const res = await pool.query(`SELECT * FROM ${TABLE} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return res.rows.map(rowToTx);
  }

  static async pipeline() {
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, { count: 0, amountCents: 0 }]));
    const byType = Object.fromEntries(TYPES.map((t) => [t, { count: 0, amountCents: 0 }]));
    const openByParticipant = {};
    let liveExposureCents = 0;
    if (pool) {
      const res = await pool.query(`SELECT status, type, participant_id, real_value, COUNT(*)::int AS n, COALESCE(SUM(amount_cents),0)::bigint AS cents FROM ${TABLE} GROUP BY status, type, participant_id, real_value`);
      for (const r of res.rows) {
        if (!byStatus[r.status]) byStatus[r.status] = { count: 0, amountCents: 0 };
        if (!byType[r.type]) byType[r.type] = { count: 0, amountCents: 0 };
        byStatus[r.status].count += Number(r.n);
        byStatus[r.status].amountCents += Number(r.cents);
        byType[r.type].count += Number(r.n);
        byType[r.type].amountCents += Number(r.cents);
        const open = ['submitted', 'approved', 'cleared'].includes(r.status);
        if (open && r.participant_id) openByParticipant[r.participant_id] = (openByParticipant[r.participant_id] || 0) + Number(r.cents);
        if (r.real_value && open) liveExposureCents += Number(r.cents);
      }
    }
    return {
      byStatus, byType, openByParticipant, liveExposureCents,
      gates: { approvalRef: true, screeningRef: true, distinctApprover: true, selfLoopbackRefused: true, participantAdmitted: true, exposureLimit: true },
    };
  }

  static async status() {
    const [inventory, pipeline] = await Promise.all([this.processors(), settle(() => this.pipeline())]);
    return {
      engine: 'private-payment-network',
      healthy: Boolean(this._gateway() && this._ledger()),
      mode: inventory.config.live && inventory.anyRealValueCapable ? 'live' : 'shadow',
      live: inventory.config.live,
      gate: inventory.gate,
      ledgerGate: inventory.ledgerGate,
      mftGate: inventory.mftGate,
      realValueCapable: inventory.anyRealValueCapable,
      realValueProcessors: inventory.realValueCapable,
      familyOnly: inventory.familyOnly,
      familyParticipantTypes: inventory.config.familyParticipantTypes,
      excludedProcessors: inventory.excludedProcessors,
      processors: inventory.sources,
      types: TYPES,
      integrations: {
        gateway: Boolean(this._gateway()),
        paymentProcessorOs: Boolean(this._processorOs()),
        enterpriseNetwork: Boolean(this._network()),
        cashLedger: Boolean(this._ledger()),
        mftGateway: Boolean(this._mft()),
        webhookSecret: inventory.config.webhookSecret,
      },
      pipeline: pipeline.ok ? pipeline.value : { error: pipeline.error },
      timestamp: new Date().toISOString(),
    };
  }

  static async readiness() {
    const { EngineWiringReadiness } = require('./engineWiringReadiness');
    return EngineWiringReadiness.engineReadiness('private-payment-network');
  }

  static async _get(id) {
    const res = await pool.query(`SELECT * FROM ${TABLE} WHERE transaction_id = $1`, [id]);
    return res.rows[0] || null;
  }

  static async _getByTx(txId) {
    const res = await pool.query(`SELECT * FROM ${TABLE} WHERE gateway_tx_id = $1 OR processor_tx_id = $1 ORDER BY created_at DESC LIMIT 1`, [txId]);
    return res.rows[0] || null;
  }
}

module.exports = { PrivatePaymentNetworkOsEngine };
