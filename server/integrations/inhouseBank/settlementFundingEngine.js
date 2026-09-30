'use strict';

/**
 * Settlement Funding — moving the trust's own money to where a rail can spend it
 *
 * The in-house family bank is the source of truth for whose money is whose, but
 * every virtual account is a claim on one real account; a rail that debits a
 * different bank account — the trust's Lili settlement account, which
 * LiliSettlementBankEngine and the S2S settlement bank registry credit — can
 * only spend dollars that are physically in that account. This engine is the
 * wire that puts them there: it debits the Trust Operating Account in the book
 * of record and credits a pre-registered settlement account at the bank.
 *
 * Four properties are load-bearing:
 *
 *   • The funding side is not a parameter. The account drawn on is resolved
 *     through the clearing funding registry, so a settlement funding wire can
 *     no more spend bond proceeds or a reserve than a vendor payment can.
 *   • The credit side is an allowlist, never free-form. A wire that accepts a
 *     routing and account number from its caller is a wire that can be pointed
 *     at any account in the country; destinations are registered in
 *     SETTLEMENT_FUNDING_DESTINATIONS and named by key. The default,
 *     `lili_settlement`, is not typed in at all: it is the Lili account the
 *     platform's own settlement engine is registered against (LILI_DD_*).
 *   • The money is committed once. Available balance is read from the ledger
 *     that owns it, net of settlement funding wires already in flight, so two
 *     operators cannot each promise the same dollars.
 *   • Nothing is simulated. Transmission goes through WireEngine, which refuses
 *     to send without an independent checker and a configured bank channel, and
 *     the settlement account is credited in the GL only when the bank confirms
 *     the wire settled — never when the file was assembled.
 *
 * Between approval and settlement the dollars are committed but not settled:
 * `commitInTransit` reclassifies them in the GL — DR the in-transit clearing
 * asset (SETTLEMENT_FUNDING_IN_TRANSIT_GL_ACCOUNT, default 1015), CR the
 * funding account — and repoints the wire's settlement credit at the clearing
 * account, so settlement posts DR destination / CR in-transit and the
 * operating account is relieved exactly once. `releaseInTransit` reverses the
 * commitment for a wire that was cancelled, failed or returned before it
 * settled. The clearing account is not a liquid sub-type, so committed dollars
 * are never reported as spendable.
 */

const pool = require('../bonds/pgPool');
const { WireEngine } = require('../wire/wireEngine');
const { PartnerBankRails } = require('../rails/partnerBankRails');
const { FundingSourceRegistry, FundingSourceError } = require('./clearing/fundingSourceRegistry');
const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');
const { ComplianceEngine } = require('../compliance/complianceEngine');
const { FraudComplianceOsEngine, getFraudComplianceConfig } = require('../os/fraudComplianceOsEngine');
const { LiliDirectDepositEngine } = require('../payments/liliDirectDepositEngine');

// A wire in one of these states has been promised to the bank or is about to be,
// so its dollars are spoken for and cannot back a second wire.
const IN_FLIGHT_STATUSES = [
  'initiated',
  'pending_approval',
  'approved',
  'sending',
  'sent',
  'confirmed',
];

const PAYMENT_TYPE = 'settlement_funding';

const DEFAULT_IN_TRANSIT_GL_ACCOUNT = '1015';
const DEFAULT_DESTINATION_KEY = 'lili_settlement';
const DEFAULT_DESTINATION_GL_ACCOUNT = '1040';
const COMMIT_REFERENCE_TYPE = 'settlement_funding_commit';
const RELEASE_REFERENCE_TYPE = 'settlement_funding_release';
// Terminal states in which a committed wire never reached the destination.
const RELEASABLE_STATUSES = ['cancelled', 'failed', 'rejected', 'returned'];
const BANK_SETTLED_STATUSES = ['completed', 'settled'];

class SettlementFundingError extends Error {
  constructor(message, code = 'SETTLEMENT_FUNDING_ERROR', status = 409) {
    super(message);
    this.name = 'SettlementFundingError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (e) { return {}; }
}

function inTransitAccountCode() {
  return String(process.env.SETTLEMENT_FUNDING_IN_TRANSIT_GL_ACCOUNT || DEFAULT_IN_TRANSIT_GL_ACCOUNT).trim();
}

/**
 * The bank's own settlement evidence already recorded on a wire — by the bank
 * adapter at send, or by an operator through POST /api/wire/:id/confirm — or
 * null. Only a provider reference whose status says the money settled counts;
 * nothing generated locally is evidence.
 */
function settlementEvidence(wire) {
  const meta = parseMetadata(wire && wire.metadata);
  const candidates = [
    [meta.providerSettlementReference, meta.providerSettlementStatus],
    [meta.providerConfirmationReference, meta.providerConfirmationStatus],
    [meta.externalProviderReference, meta.externalProviderStatus],
  ];
  for (const [reference, status] of candidates) {
    const providerStatus = String(status || '').trim().toLowerCase();
    if (reference && BANK_SETTLED_STATUSES.includes(providerStatus)) {
      return { reference: String(reference), providerStatus };
    }
  }
  return null;
}

function text(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === null ? fallback : String(value).trim();
}

function parseDestinations(value) {
  if (!value) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SettlementFundingError(
      'SETTLEMENT_FUNDING_DESTINATIONS must be a valid JSON object keyed by destination name',
      'SETTLEMENT_FUNDING_BAD_CONFIG',
      500
    );
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new SettlementFundingError(
      'SETTLEMENT_FUNDING_DESTINATIONS must be a valid JSON object keyed by destination name',
      'SETTLEMENT_FUNDING_BAD_CONFIG',
      500
    );
  }
  return parsed;
}

/**
 * A single destination may also be given as plain variables, which is what a
 * trust funding one account actually has. It is registered under the default
 * key and the JSON map wins where both name the same key.
 */
function inlineDestination() {
  const routingNumber = text('SETTLEMENT_FUNDING_ROUTING');
  const accountNumber = text('SETTLEMENT_FUNDING_ACCOUNT');
  if (!routingNumber && !accountNumber) return null;
  return {
    label: text('SETTLEMENT_FUNDING_LABEL'),
    beneficiaryName: text('SETTLEMENT_FUNDING_BENEFICIARY_NAME'),
    bankName: text('SETTLEMENT_FUNDING_BANK_NAME'),
    routingNumber,
    accountNumber,
    glAccountCode: text('SETTLEMENT_FUNDING_GL_ACCOUNT'),
  };
}

/**
 * The settlement account the platform's own engine already owns: with
 * SETTLEMENT_FUNDING_ENGINE=lili (the default) it is the Lili account
 * LiliSettlementBankEngine credits, read from the same LILI_DD_* settings, so
 * the funding wire and the settlement engine can never disagree about where
 * the money lands.
 */
function engineDestination() {
  const engine = text('SETTLEMENT_FUNDING_ENGINE', 'lili').toLowerCase();
  if (engine !== 'lili') return null;
  const routingNumber = text('LILI_DD_ROUTING_NUMBER');
  const accountNumber = text('LILI_DD_ACCOUNT_NUMBER');
  if (!routingNumber || !accountNumber) return null;
  return {
    label: 'Lili settlement account (LiliSettlementBankEngine)',
    beneficiaryName: text('LILI_DD_ACCOUNT_NAME', 'DB NET MGMT LLC'),
    bankName: 'Lili Bank',
    routingNumber,
    accountNumber,
    glAccountCode: text('SETTLEMENT_FUNDING_GL_ACCOUNT', DEFAULT_DESTINATION_GL_ACCOUNT),
    engine: 'lili',
  };
}

function getSettlementFundingConfig() {
  const defaultKey = text('SETTLEMENT_FUNDING_DEFAULT_DESTINATION', DEFAULT_DESTINATION_KEY).toLowerCase();
  const destinations = {};
  const fromEngine = engineDestination();
  if (fromEngine) destinations[DEFAULT_DESTINATION_KEY] = fromEngine;
  const inline = inlineDestination();
  if (inline) destinations[defaultKey] = inline;
  for (const [key, value] of Object.entries(parseDestinations(text('SETTLEMENT_FUNDING_DESTINATIONS')))) {
    destinations[String(key).toLowerCase()] = value;
  }
  return {
    defaultKey,
    destinations,
    // Which account the wire is drawn on, in the funding registry's own terms.
    // Left at `operating` it is whatever the registry calls the Trust Operating
    // Account, so this engine carries no second opinion about that.
    fundingSourceRef: text('SETTLEMENT_FUNDING_SOURCE', 'operating'),
    trustName: text('SETTLEMENT_FUNDING_TRUST_NAME', text('TRUST_NAME', 'DLB Trust')),
  };
}

function describeDestination(key, raw) {
  if (!raw || typeof raw !== 'object') {
    throw new SettlementFundingError(
      `Settlement funding destination "${key}" must be an object with routingNumber, accountNumber and glAccountCode`,
      'SETTLEMENT_FUNDING_BAD_DESTINATION',
      500
    );
  }
  const routingNumber = String(raw.routingNumber || raw.routing_number || '').trim();
  const accountNumber = String(raw.accountNumber || raw.account_number || '').trim();
  const glAccountCode = String(raw.glAccountCode || raw.gl_account_code || '').trim();
  if (!/^\d{9}$/.test(routingNumber)) {
    throw new SettlementFundingError(
      `Settlement funding destination "${key}" needs a 9-digit ABA routingNumber`,
      'SETTLEMENT_FUNDING_BAD_DESTINATION',
      500
    );
  }
  if (!accountNumber) {
    throw new SettlementFundingError(
      `Settlement funding destination "${key}" needs the accountNumber the bank credits`,
      'SETTLEMENT_FUNDING_BAD_DESTINATION',
      500
    );
  }
  if (!glAccountCode) {
    throw new SettlementFundingError(
      `Settlement funding destination "${key}" needs glAccountCode: the chart-of-accounts code that carries this bank account, or the credit has nowhere to land`,
      'SETTLEMENT_FUNDING_BAD_DESTINATION',
      500
    );
  }
  return {
    key,
    label: String(raw.label || raw.name || key).trim(),
    beneficiaryName: String(raw.beneficiaryName || raw.beneficiary_name || '').trim(),
    bankName: String(raw.bankName || raw.bank_name || '').trim() || null,
    routingNumber,
    accountNumber,
    accountLast4: accountNumber.slice(-4),
    glAccountCode,
    engine: raw.engine ? String(raw.engine) : null,
  };
}

const SettlementFundingEngine = {
  SettlementFundingError,
  PAYMENT_TYPE,
  IN_FLIGHT_STATUSES,

  config: getSettlementFundingConfig,
  inTransitAccountCode,
  settlementEvidence,

  /** Every account this engine may credit, as registered. */
  destinations(config = null) {
    const settings = config || getSettlementFundingConfig();
    return Object.entries(settings.destinations).map(([key, raw]) => describeDestination(key, raw));
  },

  destination(key = null, config = null) {
    const settings = config || getSettlementFundingConfig();
    const wanted = String(key || settings.defaultKey).toLowerCase();
    const raw = settings.destinations[wanted];
    if (!raw) {
      const known = Object.keys(settings.destinations);
      throw new SettlementFundingError(
        `"${wanted}" is not a registered settlement account`
        + (known.length ? `; registered: ${known.join(', ')}` : '; SETTLEMENT_FUNDING_DESTINATIONS is empty')
        + '. A settlement funding wire credits a pre-registered account only.',
        'SETTLEMENT_FUNDING_DESTINATION_UNKNOWN',
        409
      );
    }
    return describeDestination(wanted, raw);
  },

  /**
   * What the trust has already promised out of one funding source and not yet
   * settled. Read from the wire ledger rather than tracked separately, so a
   * cancelled or failed wire releases its dollars by itself. A wire already
   * committed to the in-transit account is excluded: its dollars have left the
   * funding account's ledger balance, and counting them again would reserve
   * them twice.
   */
  async inFlightCents(sourceKey) {
    await WireEngine.ensureTables();
    const rows = await pool.query(
      `SELECT COALESCE(SUM(amount_cents), 0) AS cents
         FROM wire_transfers
        WHERE payment_type = $1
          AND status = ANY($2::text[])
          AND metadata->'fundingSource'->>'sourceKey' = $3
          AND metadata->'inTransit'->>'entryId' IS NULL`,
      [PAYMENT_TYPE, IN_FLIGHT_STATUSES, sourceKey]
    );
    return Number(rows.rows[0]?.cents || 0);
  },

  /**
   * What this wire would draw on, what is actually there, and whether the two
   * agree. Nothing is created and nothing is reserved: this is the answer an
   * operator gets before committing, and the same check `initiate` repeats.
   */
  async plan({ amountCents, destination = null, fundingSourceRef = null } = {}) {
    const config = getSettlementFundingConfig();
    const amount = Number(amountCents);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new SettlementFundingError(
        'amountCents must be a positive whole number of cents',
        'SETTLEMENT_FUNDING_BAD_AMOUNT',
        400
      );
    }
    const credit = this.destination(destination, config);
    await this.assertEngineDestination(credit);
    const source = await FundingSourceRegistry.resolve(fundingSourceRef || config.fundingSourceRef);

    if (String(source.sourceId) === credit.glAccountCode) {
      throw new SettlementFundingError(
        `${credit.label} is carried on account ${credit.glAccountCode}, which is the account being drawn on:`
        + ' a wire from an account to itself moves no money and would double-count the balance',
        'SETTLEMENT_FUNDING_SELF_WIRE',
        409
      );
    }

    if (source.currency !== 'USD') {
      throw new SettlementFundingError(
        `${source.accountName} is denominated in ${source.currency}; settlement funding originates domestic USD wires only`,
        'SETTLEMENT_FUNDING_CURRENCY',
        409
      );
    }

    const inFlightCents = await this.inFlightCents(source.sourceKey);
    const spendableCents = Math.max(0, source.availableCents - inFlightCents);
    const shortfallCents = Math.max(0, amount - spendableCents);

    return {
      amountCents: amount,
      amount: (amount / 100).toFixed(2),
      currency: source.currency,
      source: {
        sourceType: source.sourceType,
        sourceKey: source.sourceKey,
        sourceId: source.sourceId,
        accountName: source.accountName,
        sourceOfTruth: source.sourceOfTruth,
        debtorName: source.debtorName,
        debtorAccountNumber: source.debtorAccountNumber,
        debtorRouting: source.debtorRouting,
      },
      destination: credit,
      availableCents: source.availableCents,
      available: (source.availableCents / 100).toFixed(2),
      inFlightCents,
      inFlight: (inFlightCents / 100).toFixed(2),
      spendableCents,
      spendable: (spendableCents / 100).toFixed(2),
      shortfallCents,
      funded: shortfallCents === 0,
    };
  },

  /**
   * Create the wire. It always requires an independent checker: funding a
   * settlement account is the trust moving its own money out of the book of
   * record, and WireEngine will not transmit a wire whose maker approved it.
   */
  async initiate({
    amountCents,
    destination = null,
    fundingSourceRef = null,
    initiatedBy,
    memo = null,
    approvalRef = null,
    screeningRef = null,
  } = {}) {
    if (!initiatedBy) {
      throw new SettlementFundingError(
        'initiatedBy is required: a settlement funding wire is made by a named trustee',
        'SETTLEMENT_FUNDING_NO_MAKER',
        400
      );
    }
    const plan = await this.plan({ amountCents, destination, fundingSourceRef });
    if (!plan.funded) {
      throw new SettlementFundingError(
        `${plan.source.accountName} has ${plan.spendable} spendable`
        + ` (${plan.available} on the ledger less ${plan.inFlight} already in flight)`
        + ` and this wire draws ${plan.amount}`,
        'SETTLEMENT_FUNDING_INSUFFICIENT',
        409
      );
    }

    const description = memo
      || `Fund ${plan.destination.label} from ${plan.source.accountName}`;

    await WireEngine.ensureTables();
    const wire = await WireEngine.initiateWire({
      amountCents: plan.amountCents,
      wireType: 'settlement',
      paymentType: PAYMENT_TYPE,
      description,
      purpose: `Settlement funding ${plan.destination.key}`,
      senderName: plan.source.debtorName,
      senderRouting: plan.source.debtorRouting || undefined,
      senderAccount: plan.source.debtorAccountNumber || undefined,
      beneficiaryName: plan.destination.beneficiaryName || plan.source.debtorName,
      beneficiaryRouting: plan.destination.routingNumber,
      beneficiaryAccount: plan.destination.accountNumber,
      beneficiaryBankName: plan.destination.bankName,
      initiatedBy,
      requiresApproval: true,
      metadata: {
        settlementFunding: {
          destination: plan.destination.key,
          label: plan.destination.label,
          accountLast4: plan.destination.accountLast4,
        },
        fundingSource: plan.source,
        ...(approvalRef ? { approvalRef: String(approvalRef) } : {}),
        ...(screeningRef ? { screeningRef: String(screeningRef) } : {}),
        // The trust's own money changing accounts: the destination bank account
        // gains what the operating account loses. Neither leg is an expense.
        glDebitAccountCode: plan.destination.glAccountCode,
        glCreditAccountCode: String(plan.source.sourceId),
      },
    });

    return { wire, plan };
  },

  /**
   * AML / OFAC gate for a funding wire. The screeningRef must be a live FCS-
   * screening from the Fraud & Compliance OS (sanctions list ingested and
   * fresh, DLB fraud rules, checker review), clear, unexpired, for exactly this
   * amount and payee. With consume it is spent, single use, before transmission.
   */
  async verifyScreeningFor({ screeningRef, amountCents, payee, consume = false, consumer = null } = {}) {
    if (!screeningRef) {
      throw new SettlementFundingError(
        'screeningRef is required: a settlement funding wire leaves only against a live Fraud & Compliance screening',
        'SETTLEMENT_FUNDING_NO_SCREENING',
        409
      );
    }
    if (!String(screeningRef).startsWith('FCS-')) {
      throw new SettlementFundingError(
        `screeningRef ${screeningRef} is not a Fraud & Compliance OS (FCS-) screening`,
        'SETTLEMENT_FUNDING_SCREENING',
        409
      );
    }
    const cfg = getFraudComplianceConfig();
    if (!cfg.enabled || !cfg.live) {
      throw new SettlementFundingError(
        'FRAUD_COMPLIANCE_ENABLED and FRAUD_COMPLIANCE_LIVE must be true: a shadow screening cannot authorize a funding wire',
        'SETTLEMENT_FUNDING_SCREENING',
        503
      );
    }
    await ComplianceEngine.assertPaymentReady();
    return FraudComplianceOsEngine.verify({
      screeningRef,
      amountCents: Number(amountCents),
      payee,
      requireLive: true,
      consume,
      consumer,
    });
  },

  async verifyScreening(wireId, { screeningRef = null, consume = false } = {}) {
    const wire = await this._requireFundingWire(wireId);
    const meta = parseMetadata(wire.metadata);
    if (!meta.approvalRef) {
      throw new SettlementFundingError(
        `${wireId} has no approvalRef: a settlement funding wire is transmitted only under a recorded trustee approval`,
        'SETTLEMENT_FUNDING_NO_APPROVAL_REF',
        409
      );
    }
    return this.verifyScreeningFor({
      screeningRef: screeningRef || meta.screeningRef,
      amountCents: Number(wire.amount_cents),
      payee: { name: wire.beneficiary_name, routingNumber: wire.beneficiary_routing, accountNumber: wire.beneficiary_account },
      consume,
      consumer: consume ? `settlement_funding:${wireId}` : null,
    });
  },

  /** Transmit after the screening is verified and consumed. */
  async sendScreened(wireId, { screeningRef = null } = {}) {
    await this.verifyScreening(wireId, { screeningRef, consume: true });
    return this.send(wireId);
  },

  /**
   * An engine-backed destination must still be the account that engine is
   * registered against: a Lili destination updated in system settings
   * (LiliDirectDepositEngine.setDestination) supersedes the environment, and a
   * wire to the stale account is refused rather than sent.
   */
  async assertEngineDestination(credit) {
    if (credit.engine !== 'lili') return;
    const registered = await LiliDirectDepositEngine.getDestination();
    if (!registered.configured) {
      throw new SettlementFundingError(
        'The Lili settlement account is not registered (LILI_DD_ROUTING_NUMBER / LILI_DD_ACCOUNT_NUMBER)',
        'SETTLEMENT_FUNDING_BAD_DESTINATION',
        409
      );
    }
    if (String(registered.routingNumber) !== credit.routingNumber || String(registered._account) !== credit.accountNumber) {
      throw new SettlementFundingError(
        `${credit.label} (…${credit.accountLast4}) is not the account LiliSettlementBankEngine is registered against`
        + ` (${registered.accountNumberMasked}); update LILI_DD_* so both engines name one account`,
        'SETTLEMENT_FUNDING_BAD_DESTINATION',
        409
      );
    }
  },

  /** Second signature. The checker must not be the maker; WireEngine enforces it. */
  async approve(wireId, approvedBy) {
    await this._requireFundingWire(wireId);
    return WireEngine.approveWire(wireId, approvedBy);
  },

  /**
   * Transmit. WireEngine refuses without production mode, an independent
   * checker and a configured partner bank or wire endpoint, so an unconfigured
   * channel surfaces as a refusal rather than a wire that went nowhere.
   */
  async send(wireId) {
    await this._requireFundingWire(wireId);
    return WireEngine.sendWire(wireId);
  },

  /** The bank's acknowledgement that it has the wire. Posts nothing. */
  async confirm(wireId, evidence = {}) {
    await this._requireFundingWire(wireId);
    return WireEngine.confirmWire(wireId, evidence);
  },

  /**
   * Settled: the dollars are in the settlement account. This is the only step
   * that touches the GL — WireEngine posts DR the destination bank account, CR
   * the funding account from the metadata written at initiation.
   */
  async settle(wireId, evidence = {}) {
    await this._requireFundingWire(wireId);
    return WireEngine.settleWire(wireId, evidence);
  },

  async cancel(wireId, cancelledBy) {
    await this._requireFundingWire(wireId);
    const wire = await WireEngine.cancelWire(wireId, cancelledBy);
    if (parseMetadata(wire.metadata).inTransit?.entryId) {
      await this.releaseInTransit(wireId, { releasedBy: cancelledBy, reason: 'cancelled before transmission' });
      return WireEngine.getWire(wireId);
    }
    return wire;
  },

  /** The in-transit clearing asset, created on first use. Refuses a liquid or non-asset account. */
  async ensureInTransitAccount(db = pool) {
    const code = inTransitAccountCode();
    await db.query(
      `INSERT INTO trust_accounts (account_code, account_name, account_type, sub_type, description)
       VALUES ($1, 'Settlement Funding In Transit', 'asset', 'other',
               'Trust cash committed to a settlement funding wire, not yet settled at the bank; not spendable')
       ON CONFLICT (account_code) DO NOTHING`,
      [code]
    );
    const account = await TrustAccountingEngine.getAccount(code);
    if (!account || account.account_type !== 'asset') {
      throw new SettlementFundingError(
        `In-transit account ${code} must be an asset account`,
        'SETTLEMENT_FUNDING_IN_TRANSIT_ACCOUNT',
        409
      );
    }
    if (account.funding_eligible) {
      throw new SettlementFundingError(
        `In-transit account ${code} is classified as spendable (${account.sub_type});`
        + ' committed dollars must not be reported as available',
        'SETTLEMENT_FUNDING_IN_TRANSIT_ACCOUNT',
        409
      );
    }
    return account;
  },

  /**
   * The GL account that carries the destination, created on first use so the
   * settlement entry has somewhere to land. Refuses a non-asset account.
   */
  async ensureDestinationAccount(meta, db = pool) {
    const code = String(meta.glDebitAccountCode || '').trim();
    if (!code) {
      throw new SettlementFundingError('Funding wire records no destination GL account', 'SETTLEMENT_FUNDING_BAD_DESTINATION', 409);
    }
    const key = meta.settlementFunding?.destination || 'settlement';
    await db.query(
      `INSERT INTO trust_accounts (account_code, account_name, account_type, sub_type, description)
       VALUES ($1, $2, 'asset', 'settlement', 'Trust cash held at the settlement bank, credited when a funding wire settles')
       ON CONFLICT (account_code) DO NOTHING`,
      [code, `Settlement Account (${key})`]
    );
    const account = await TrustAccountingEngine.getAccount(code);
    if (!account || account.account_type !== 'asset') {
      throw new SettlementFundingError(
        `Destination account ${code} must be an asset account`,
        'SETTLEMENT_FUNDING_BAD_DESTINATION',
        409
      );
    }
    return account;
  },

  /**
   * What committing this wire would post, without posting it. Refuses a wire
   * that is not in flight, not drawn on the Trust Operating Account, or whose
   * funding account does not hold the amount.
   */
  async commitmentFor(wireId) {
    const wire = await this._requireFundingWire(wireId);
    const meta = parseMetadata(wire.metadata);
    const inTransit = inTransitAccountCode();
    const amountCents = Number(wire.amount_cents);
    if (meta.inTransit?.entryId) {
      return { wire, alreadyCommitted: true, entryId: meta.inTransit.entryId, amountCents };
    }
    if (!IN_FLIGHT_STATUSES.includes(wire.status)) {
      throw new SettlementFundingError(
        `${wireId} is ${wire.status}; only an in-flight wire can be committed to the in-transit account`,
        'SETTLEMENT_FUNDING_NOT_IN_FLIGHT',
        409
      );
    }
    if (meta.fundingSource?.sourceType !== 'trust_operating') {
      throw new SettlementFundingError(
        `${wireId} draws on ${meta.fundingSource?.sourceKey || 'an unrecorded source'};`
        + ' only a wire drawn on the Trust Operating Account GL is committed to the in-transit account',
        'SETTLEMENT_FUNDING_SOURCE',
        409
      );
    }
    if (String(meta.glDebitAccountCode || '') === inTransit) {
      throw new SettlementFundingError(
        `${wireId} settles into ${inTransit}, the in-transit account itself; register the destination on its own GL account`,
        'SETTLEMENT_FUNDING_IN_TRANSIT_STATE',
        409
      );
    }
    const sourceAccountCode = String(meta.glCreditAccountCode || meta.fundingSource.sourceId);
    if (sourceAccountCode === inTransit) {
      throw new SettlementFundingError(
        `${wireId} already credits ${inTransit} at settlement but has no commitment entry`,
        'SETTLEMENT_FUNDING_IN_TRANSIT_STATE',
        409
      );
    }
    const source = await TrustAccountingEngine.getAccount(sourceAccountCode);
    if (!source) {
      throw new SettlementFundingError(`Funding GL account ${sourceAccountCode} not found`, 'SETTLEMENT_FUNDING_SOURCE', 409);
    }
    const sourceBalanceCents = Math.round(Number(source.balance || 0) * 100);
    if (sourceBalanceCents < amountCents) {
      throw new SettlementFundingError(
        `${source.account_name} (${sourceAccountCode}) holds ${(sourceBalanceCents / 100).toFixed(2)}`
        + ` and ${wireId} commits ${(amountCents / 100).toFixed(2)}`,
        'SETTLEMENT_FUNDING_INSUFFICIENT',
        409
      );
    }
    return {
      wire,
      alreadyCommitted: false,
      amountCents,
      amount: (amountCents / 100).toFixed(2),
      debitAccountCode: inTransit,
      creditAccountCode: sourceAccountCode,
    };
  },

  /**
   * DR in-transit / CR the funding account for an in-flight wire, and point the
   * wire's settlement credit at the in-transit account. Idempotent per wire.
   * Posted through TrustAccountingEngine.postJournalEntry; balances are never
   * written directly.
   */
  async commitInTransit(wireId, { committedBy = null, apply = true } = {}) {
    const preview = await this.commitmentFor(wireId);
    if (preview.alreadyCommitted || !apply) return { ...preview, applied: false };
    await this.ensureInTransitAccount();
    await this.ensureDestinationAccount(parseMetadata(preview.wire.metadata));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${COMMIT_REFERENCE_TYPE}:${wireId}`]);
      const locked = await client.query('SELECT * FROM wire_transfers WHERE wire_id = $1 FOR UPDATE', [wireId]);
      const current = locked.rows[0];
      const currentMeta = parseMetadata(current && current.metadata);
      if (!current || currentMeta.inTransit?.entryId || !IN_FLIGHT_STATUSES.includes(current.status)) {
        await client.query('ROLLBACK');
        return { ...(await this.commitmentFor(wireId)), applied: false };
      }
      const amount = preview.amountCents / 100;
      const entry = await TrustAccountingEngine.postJournalEntry({
        entryDate: new Date().toISOString().slice(0, 10),
        description: `Settlement funding ${wireId} committed, not yet settled at the bank`,
        referenceType: COMMIT_REFERENCE_TYPE,
        referenceId: wireId,
        postedBy: committedBy || 'settlement_funding',
        postToFineract: false,
        transactionClient: client,
        lines: [
          { accountCode: preview.debitAccountCode, debitAmount: amount, creditAmount: 0, memo: `In transit: ${wireId}` },
          { accountCode: preview.creditAccountCode, debitAmount: 0, creditAmount: amount, memo: `Committed to ${wireId}` },
        ],
      });
      const inTransit = {
        entryId: entry.entry_id,
        glAccountCode: preview.debitAccountCode,
        sourceAccountCode: preview.creditAccountCode,
        committedAt: new Date().toISOString(),
        committedBy: committedBy || null,
      };
      await client.query(
        `UPDATE wire_transfers
            SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = NOW()
          WHERE wire_id = $1`,
        [wireId, JSON.stringify({ glCreditAccountCode: preview.debitAccountCode, inTransit })]
      );
      await client.query('COMMIT');
      return { ...preview, applied: true, entryId: entry.entry_id, wire: await WireEngine.getWire(wireId) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Reverse the commitment of a wire that will never settle: DR the funding
   * account / CR in-transit, and restore the wire's original settlement credit.
   */
  async releaseInTransit(wireId, { releasedBy = null, reason = null } = {}) {
    const wire = await this._requireFundingWire(wireId);
    const meta = parseMetadata(wire.metadata);
    const committed = meta.inTransit;
    if (!committed?.entryId) return { wire, released: false, reason: 'not committed' };
    if (committed.releaseEntryId) return { wire, released: false, reason: 'already released', entryId: committed.releaseEntryId };
    if (wire.status === 'settled' || wire.journal_entry_id) {
      throw new SettlementFundingError(
        `${wireId} settled; its settlement entry already cleared the in-transit account`,
        'SETTLEMENT_FUNDING_SETTLED',
        409
      );
    }
    if (!RELEASABLE_STATUSES.includes(wire.status)) {
      throw new SettlementFundingError(
        `${wireId} is ${wire.status} and may still settle; cancel it or record the bank's return first`,
        'SETTLEMENT_FUNDING_IN_FLIGHT',
        409
      );
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${COMMIT_REFERENCE_TYPE}:${wireId}`]);
      const locked = await client.query('SELECT * FROM wire_transfers WHERE wire_id = $1 FOR UPDATE', [wireId]);
      const currentMeta = parseMetadata(locked.rows[0] && locked.rows[0].metadata);
      if (currentMeta.inTransit?.releaseEntryId) {
        await client.query('ROLLBACK');
        return { wire, released: false, reason: 'already released', entryId: currentMeta.inTransit.releaseEntryId };
      }
      const amount = Number(wire.amount_cents) / 100;
      const entry = await TrustAccountingEngine.postJournalEntry({
        entryDate: new Date().toISOString().slice(0, 10),
        description: `Settlement funding ${wireId} released from in transit${reason ? `: ${reason}` : ''}`,
        referenceType: RELEASE_REFERENCE_TYPE,
        referenceId: wireId,
        postedBy: releasedBy || 'settlement_funding',
        postToFineract: false,
        transactionClient: client,
        lines: [
          { accountCode: committed.sourceAccountCode, debitAmount: amount, creditAmount: 0, memo: `Released: ${wireId}` },
          { accountCode: committed.glAccountCode, debitAmount: 0, creditAmount: amount, memo: `Released: ${wireId}` },
        ],
      });
      await client.query(
        `UPDATE wire_transfers
            SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = NOW()
          WHERE wire_id = $1`,
        [wireId, JSON.stringify({
          glCreditAccountCode: committed.sourceAccountCode,
          inTransit: { ...committed, releaseEntryId: entry.entry_id, releasedAt: new Date().toISOString(), releasedBy, reason },
        })]
      );
      await client.query('COMMIT');
      return { wire: await WireEngine.getWire(wireId), released: true, entryId: entry.entry_id };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  },

  async get(wireId) {
    return WireEngine.getWire(wireId);
  },

  /** Settlement funding wires, newest first. */
  async list({ status = null, limit = 50 } = {}) {
    await WireEngine.ensureTables();
    const rows = await pool.query(
      `SELECT * FROM wire_transfers
        WHERE payment_type = $1
          AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC
        LIMIT $3`,
      [PAYMENT_TYPE, status, Math.min(500, Math.max(1, Number(limit) || 50))]
    );
    return rows.rows;
  },

  async _requireFundingWire(wireId) {
    const wire = await WireEngine.getWire(wireId);
    if (!wire) {
      throw new SettlementFundingError(`Wire not found: ${wireId}`, 'SETTLEMENT_FUNDING_NOT_FOUND', 404);
    }
    if (wire.payment_type !== PAYMENT_TYPE) {
      throw new SettlementFundingError(
        `${wireId} is a ${wire.payment_type} wire, not a settlement funding wire`,
        'SETTLEMENT_FUNDING_WRONG_WIRE',
        409
      );
    }
    return wire;
  },

  /**
   * Whether this workflow can actually move money, and where it stops if not.
   * A missing bank channel is a blocker, not a warning: the data workflow runs
   * end to end without one and no dollars leave the trust.
   */
  async readiness() {
    const blockers = [];
    const warnings = [];
    let config = null;
    let destinations = [];
    try {
      config = getSettlementFundingConfig();
      destinations = this.destinations(config);
    } catch (error) {
      blockers.push(error.message);
    }
    if (config && !destinations.length) {
      blockers.push(
        'No settlement account is registered: set LILI_DD_ROUTING_NUMBER / LILI_DD_ACCOUNT_NUMBER'
        + ' (SETTLEMENT_FUNDING_ENGINE=lili), SETTLEMENT_FUNDING_DESTINATIONS'
        + ' or SETTLEMENT_FUNDING_ROUTING/_ACCOUNT/_GL_ACCOUNT to the account the wire credits'
      );
    }

    let funding = null;
    try {
      funding = await FundingSourceRegistry.readiness();
      blockers.push(...funding.blockers);
      warnings.push(...funding.warnings);
    } catch (error) {
      blockers.push(error.message);
    }

    let compliance = null;
    try {
      compliance = await FraudComplianceOsEngine.readiness();
      blockers.push(...compliance.blockers.map((b) => `compliance: ${b}`));
    } catch (error) {
      blockers.push(`compliance: ${error.message}`);
    }

    const partnerBank = PartnerBankRails.status();
    if (!partnerBank.ready) {
      blockers.push(
        `No bank channel can originate the wire (partner bank missing ${partnerBank.missingConfiguration.join(', ')}).`
        + ' The instruction is assembled and the ledger check runs, but nothing reaches the Fed.'
      );
    }

    let source = null;
    if (config) {
      try {
        const resolved = await FundingSourceRegistry.resolve(config.fundingSourceRef);
        const inFlightCents = await this.inFlightCents(resolved.sourceKey);
        source = {
          sourceKey: resolved.sourceKey,
          accountName: resolved.accountName,
          available: (resolved.availableCents / 100).toFixed(2),
          inFlight: (inFlightCents / 100).toFixed(2),
          spendable: (Math.max(0, resolved.availableCents - inFlightCents) / 100).toFixed(2),
        };
        if (resolved.availableCents <= 0) {
          warnings.push(`${resolved.accountName} holds nothing, so no settlement funding wire can be funded yet.`);
        }
      } catch (error) {
        if (!(error instanceof FundingSourceError) && !(error instanceof SettlementFundingError)) throw error;
        blockers.push(error.message);
      }
    }

    return {
      ready: blockers.length === 0,
      fundingSource: source,
      destinations: destinations.map(entry => ({
        key: entry.key,
        label: entry.label,
        accountLast4: entry.accountLast4,
        glAccountCode: entry.glAccountCode,
      })),
      compliance: compliance
        ? { ready: compliance.ready, mode: compliance.mode, sanctionsProvider: compliance.status?.sanctions?.provider || null }
        : { ready: false, mode: 'unavailable', sanctionsProvider: null },
      inTransitGlAccount: inTransitAccountCode(),
      partnerBank: {
        ready: partnerBank.ready,
        provider: partnerBank.provider || null,
        missingConfiguration: partnerBank.missingConfiguration,
      },
      blockers,
      warnings,
      note: blockers.length === 0
        ? 'A settlement funding wire can be made, approved by a second trustee, transmitted and settled.'
        : 'Settlement funding is closed until the listed configuration is supplied; it fails closed rather than sending nowhere.',
    };
  },
};

module.exports = {
  SettlementFundingEngine,
  settlementEvidence,
  inTransitAccountCode,
  SettlementFundingError,
  getSettlementFundingConfig,
  describeDestination,
  PAYMENT_TYPE,
  IN_FLIGHT_STATUSES,
};
