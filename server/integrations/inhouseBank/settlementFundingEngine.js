'use strict';

/**
 * Settlement Funding — moving the trust's own money to where a rail can spend it
 *
 * The in-house family bank is the source of truth for whose money is whose, but
 * every virtual account is a claim on one real account; a rail that debits a
 * different bank account — Melio debiting its linked funding DDA, for one — can
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
 *     SETTLEMENT_FUNDING_DESTINATIONS and named by key.
 *   • The money is committed once. Available balance is read from the ledger
 *     that owns it, net of settlement funding wires already in flight, so two
 *     operators cannot each promise the same dollars.
 *   • Nothing is simulated. Transmission goes through WireEngine, which refuses
 *     to send without an independent checker and a configured bank channel, and
 *     the settlement account is credited in the GL only when the bank confirms
 *     the wire settled — never when the file was assembled.
 */

const pool = require('../bonds/pgPool');
const { WireEngine } = require('../wire/wireEngine');
const { PartnerBankRails } = require('../rails/partnerBankRails');
const { FundingSourceRegistry, FundingSourceError } = require('./clearing/fundingSourceRegistry');

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

class SettlementFundingError extends Error {
  constructor(message, code = 'SETTLEMENT_FUNDING_ERROR', status = 409) {
    super(message);
    this.name = 'SettlementFundingError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
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

function getSettlementFundingConfig() {
  const defaultKey = text('SETTLEMENT_FUNDING_DEFAULT_DESTINATION', 'melio').toLowerCase();
  const destinations = {};
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
  };
}

const SettlementFundingEngine = {
  SettlementFundingError,
  PAYMENT_TYPE,
  IN_FLIGHT_STATUSES,

  config: getSettlementFundingConfig,

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
   * cancelled or failed wire releases its dollars by itself.
   */
  async inFlightCents(sourceKey) {
    await WireEngine.ensureTables();
    const rows = await pool.query(
      `SELECT COALESCE(SUM(amount_cents), 0) AS cents
         FROM wire_transfers
        WHERE payment_type = $1
          AND status = ANY($2::text[])
          AND metadata->'fundingSource'->>'sourceKey' = $3`,
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
        // The trust's own money changing accounts: the destination bank account
        // gains what the operating account loses. Neither leg is an expense.
        glDebitAccountCode: plan.destination.glAccountCode,
        glCreditAccountCode: String(plan.source.sourceId),
      },
    });

    return { wire, plan };
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
    return WireEngine.cancelWire(wireId, cancelledBy);
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
        'No settlement account is registered: set SETTLEMENT_FUNDING_DESTINATIONS'
        + ' (or SETTLEMENT_FUNDING_ROUTING/_ACCOUNT/_GL_ACCOUNT) to the account the wire credits'
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
  SettlementFundingError,
  getSettlementFundingConfig,
  describeDestination,
  PAYMENT_TYPE,
  IN_FLIGHT_STATUSES,
};
