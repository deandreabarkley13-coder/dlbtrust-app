'use strict';

/**
 * Payer OS — the trust originating its own payments
 *
 * Every other rail in this system was built from the receiving end: a
 * processor, a marketplace or an aggregator holds the relationship with the
 * bank, and the trust hands it an instruction and hopes. Payer OS is the other
 * side of that. The trust is the payer: the money leaves an account the book of
 * record owns, over a channel the trust configured, to a party the trust
 * registered in advance.
 *
 * It originates exactly three things, and nothing else:
 *
 *   • settlement_funding — the trust's own dollars moving into one of its
 *     registered settlement accounts, so a rail that debits that bank account
 *     has real money to spend. Carried by wire.
 *   • direct_deposit — a PPD credit to a natural person the trust pays
 *     (a beneficiary distribution paid to a personal account, payroll).
 *   • vendor_payout — a CCD credit to a business the trust owes.
 *
 * The refusals are the product. A payer that can also pull is a payer that can
 * be turned into a collector, so:
 *
 *   • Only credits exist here. There is no debit entry point, `direction` is
 *     fixed at 'credit', and an ACH transaction code that is not a credit to a
 *     checking or savings account is refused before anything is created. The
 *     trust never originates a debit against somebody else's account.
 *   • Counterparties are an allowlist, never free-form. Routing and account
 *     numbers come from PAYER_OS_PAYEES, named by key, and a payee registered
 *     for payroll cannot be paid as a vendor (or the reverse) — the purpose is
 *     bound to the registration.
 *   • The funding side is not a caller's parameter. It resolves through the
 *     clearing funding registry, so a payout can no more spend bond proceeds,
 *     a reserve or an escrow than a vendor bill can.
 *   • The money is committed once. Spendable balance is read from the ledger
 *     that owns it, net of everything Payer OS and the wire ledger already have
 *     in flight against that account.
 *   • Two people, always. The maker cannot be the checker, and no file is
 *     assembled and no wire is transmitted before the second signature.
 *   • Nothing is simulated. ACH origination is refused unless a real bank
 *     channel is configured; the ACH engine's local "direct" fallback writes a
 *     NACHA file to disk and moves no money, so Payer OS treats it as no
 *     channel at all.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { ACHEngine } = require('../ach/achEngine');
const { validateRouting, ODFI_ROUTING, ORIGINATOR_ID } = require('../ach/nachaGenerator');
const { AS2Partners } = require('../ach/as2Partners');
const { SystemSettings } = require('../ach/systemSettings');
const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');
const { PartnerBankRails } = require('../rails/partnerBankRails');
const { FundingSourceRegistry, FundingSourceError } = require('../inhouseBank/clearing/fundingSourceRegistry');
const { SettlementFundingEngine } = require('../inhouseBank/settlementFundingEngine');
const { PaymentComplianceGate } = require('../compliance/paymentComplianceGate');
const { StablecoinPayoutRail } = require('./stablecoinPayoutRail');
const { MftOsEngine } = require('./mftOsEngine');

/**
 * What the trust is allowed to push, and how. `rail` is not negotiable per
 * disbursement: funding a settlement account is a wire because same-day
 * finality is the point of it, and a payout to a person or a business is an
 * ACH credit under the SEC code that matches who is being paid.
 */
const DISBURSEMENT_TYPES = {
  settlement_funding: {
    type: 'settlement_funding',
    rail: 'wire',
    label: 'Fund a registered settlement account',
    payeeSource: 'settlement_funding_destinations',
  },
  direct_deposit: {
    type: 'direct_deposit',
    rail: 'ach',
    secCode: 'PPD',
    entryDescription: 'DIRECT DEP',
    label: 'Direct deposit to a person the trust pays',
    payeeSource: 'payer_os_payees',
  },
  vendor_payout: {
    type: 'vendor_payout',
    rail: 'ach',
    secCode: 'CCD',
    entryDescription: 'VENDOR PAY',
    label: 'Payout to a business the trust owes',
    payeeSource: 'payer_os_payees',
  },
  // No bank is involved in this one, so the funding authority is not cash: it
  // is the trust's USDC position, and the asset must be Circle's USDC.
  stablecoin_payout: {
    type: 'stablecoin_payout',
    rail: 'stablecoin',
    label: 'USDC payout to a registered wallet',
    payeeSource: 'payer_os_wallets',
  },
};

// 22 credits a checking account, 32 credits a savings account. Every other
// NACHA code either debits the receiver or is a prenotification; a payer that
// originates one of those is no longer only pushing money out.
const CREDIT_TRANSACTION_CODES = {
  checking: '22',
  savings: '32',
};

// A disbursement in one of these states has been promised out of the funding
// account, so its dollars are spoken for and cannot back a second one.
const IN_FLIGHT_STATUSES = ['pending_approval', 'approved', 'sending', 'sent'];

const TERMINAL_STATUSES = ['settled', 'cancelled', 'failed', 'returned'];

class PayerOsError extends Error {
  constructor(message, code = 'PAYER_OS_ERROR', status = 409) {
    super(message);
    this.name = 'PayerOsError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function text(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === null ? fallback : String(value).trim();
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function parsePayees(raw) {
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PayerOsError(
      'PAYER_OS_PAYEES must be a valid JSON object keyed by payee name',
      'PAYER_OS_BAD_CONFIG',
      500
    );
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new PayerOsError(
      'PAYER_OS_PAYEES must be a valid JSON object keyed by payee name',
      'PAYER_OS_BAD_CONFIG',
      500
    );
  }
  return parsed;
}

function getPayerOsConfig() {
  return {
    payees: parsePayees(text('PAYER_OS_PAYEES')),
    // Which account every push is drawn on, in the funding registry's own
    // terms. Left at `operating` it is whatever the registry calls the Trust
    // Operating Account, so this engine carries no second opinion about that.
    fundingSourceRef: text('PAYER_OS_FUNDING_SOURCE', 'operating'),
    originatorName: text('PAYER_OS_ORIGINATOR_NAME', text('TRUST_NAME', 'DLB Trust')),
    // 0 disables the ceiling. A push larger than this is refused here, where the
    // refusal names the disbursement, rather than by the bank after the fact.
    maxAmountCents: Number(text('PAYER_OS_MAX_AMOUNT_CENTS', '0')) || 0,
    requireScreening: boolEnv('PAYER_OS_REQUIRE_SCREENING', true),
    // Where USDC sits in the chart of accounts. A stablecoin payout relieves
    // this asset, never the cash account a wire or an ACH credit draws on.
    stablecoinAssetAccount: text('STABLECOIN_ASSET_ACCOUNT', '1210'),
    achEffectiveDateOffsetDays: Number(text('PAYER_OS_ACH_EFFECTIVE_OFFSET_DAYS', '1')) || 0,
  };
}

function describeType(disbursementType) {
  const key = String(disbursementType || '').trim().toLowerCase();
  const spec = DISBURSEMENT_TYPES[key];
  if (!spec) {
    throw new PayerOsError(
      `"${disbursementType}" is not something Payer OS originates.`
      + ` It pushes credits only: ${Object.keys(DISBURSEMENT_TYPES).join(', ')}.`,
      'PAYER_OS_TYPE_NOT_PERMITTED',
      409
    );
  }
  return spec;
}

/**
 * A registered ACH payee, as the trust wrote it down. `purpose` is what binds a
 * payee to one kind of push: a payroll account is not a vendor account, and the
 * distinction is what keeps a mis-typed key from paying the wrong party under
 * the wrong SEC code.
 */
function describePayee(key, raw, spec) {
  if (!raw || typeof raw !== 'object') {
    throw new PayerOsError(
      `Payee "${key}" must be an object with name, routingNumber, accountNumber, purpose and glAccountCode`,
      'PAYER_OS_BAD_PAYEE',
      500
    );
  }
  const purpose = String(raw.purpose || raw.disbursementType || '').trim().toLowerCase();
  const routingNumber = String(raw.routingNumber || raw.routing_number || '').trim();
  const accountNumber = String(raw.accountNumber || raw.account_number || '').trim();
  const accountType = String(raw.accountType || raw.account_type || 'checking').trim().toLowerCase();
  const glAccountCode = String(raw.glAccountCode || raw.gl_account_code || '').trim();
  const name = String(raw.name || raw.beneficiaryName || raw.beneficiary_name || '').trim();

  if (!DISBURSEMENT_TYPES[purpose] || DISBURSEMENT_TYPES[purpose].rail !== 'ach') {
    throw new PayerOsError(
      `Payee "${key}" needs purpose "direct_deposit" or "vendor_payout": a payee registered for neither cannot be paid`,
      'PAYER_OS_BAD_PAYEE',
      500
    );
  }
  if (!name) {
    throw new PayerOsError(
      `Payee "${key}" needs the name that goes on the entry, or the receiving bank cannot post it`,
      'PAYER_OS_BAD_PAYEE',
      500
    );
  }
  if (!validateRouting(routingNumber)) {
    throw new PayerOsError(
      `Payee "${key}" needs a valid 9-digit ABA routingNumber (checksum included)`,
      'PAYER_OS_BAD_PAYEE',
      500
    );
  }
  if (!accountNumber) {
    throw new PayerOsError(`Payee "${key}" needs the accountNumber being credited`, 'PAYER_OS_BAD_PAYEE', 500);
  }
  if (!CREDIT_TRANSACTION_CODES[accountType]) {
    throw new PayerOsError(
      `Payee "${key}" has accountType "${accountType}"; Payer OS credits a checking or savings account only`,
      'PAYER_OS_BAD_PAYEE',
      500
    );
  }
  if (!glAccountCode) {
    throw new PayerOsError(
      `Payee "${key}" needs glAccountCode: the chart-of-accounts code this payment is charged to, or the debit has nowhere to land`,
      'PAYER_OS_BAD_PAYEE',
      500
    );
  }
  if (spec && purpose !== spec.type) {
    throw new PayerOsError(
      `"${key}" is registered for ${purpose}, so it cannot be paid as a ${spec.type}`,
      'PAYER_OS_PAYEE_WRONG_PURPOSE',
      409
    );
  }

  return {
    key,
    purpose,
    label: String(raw.label || name).trim(),
    name,
    identifier: String(raw.identifier || raw.payeeId || key).trim().slice(0, 15),
    bankName: String(raw.bankName || raw.bank_name || '').trim() || null,
    routingNumber,
    accountNumber,
    accountLast4: accountNumber.slice(-4),
    accountType,
    transactionCode: CREDIT_TRANSACTION_CODES[accountType],
    glAccountCode,
    email: String(raw.email || '').trim() || null,
  };
}

function newId(spec) {
  const prefix = spec.rail === 'wire'
    ? 'PAYSF'
    : spec.rail === 'stablecoin'
      ? 'PAYUSDC'
      : (spec.type === 'direct_deposit' ? 'PAYDD' : 'PAYVP');
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function dollars(cents) {
  return (Number(cents) / 100).toFixed(2);
}

function effectiveDate(offsetDays) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + Math.max(0, offsetDays));
  return date.toISOString().split('T')[0];
}

function parseMetadata(row) {
  if (!row) return {};
  const raw = row.metadata;
  if (!raw) return {};
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

const PayerOsEngine = {
  PayerOsError,
  DISBURSEMENT_TYPES,
  CREDIT_TRANSACTION_CODES,
  IN_FLIGHT_STATUSES,

  config: getPayerOsConfig,

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payer_disbursements (
        disbursement_id     TEXT PRIMARY KEY,
        disbursement_type   TEXT NOT NULL,
        rail                TEXT NOT NULL,
        direction           TEXT NOT NULL DEFAULT 'credit',
        status              TEXT NOT NULL,
        amount_cents        BIGINT NOT NULL CHECK (amount_cents > 0),
        currency            TEXT NOT NULL DEFAULT 'USD',
        payee_key           TEXT NOT NULL,
        payee_label         TEXT,
        payee_name          TEXT,
        payee_routing       TEXT,
        payee_account_last4 TEXT,
        sec_code            TEXT,
        transaction_code    TEXT,
        funding_source_key  TEXT NOT NULL,
        funding_account_id  TEXT,
        funding_account_name TEXT,
        gl_debit_account    TEXT,
        gl_credit_account   TEXT,
        memo                TEXT,
        initiated_by        TEXT NOT NULL,
        approved_by         TEXT,
        rail_reference      TEXT,
        settlement_reference TEXT,
        journal_entry_id    TEXT,
        failure_reason      TEXT,
        metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        approved_at         TIMESTAMPTZ,
        sent_at             TIMESTAMPTZ,
        settled_at          TIMESTAMPTZ,
        CONSTRAINT payer_disbursements_credit_only CHECK (direction = 'credit')
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_payer_disbursements_funding
         ON payer_disbursements (funding_source_key, status)`
    );
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payer_disbursement_events (
        sequence        BIGSERIAL PRIMARY KEY,
        disbursement_id TEXT NOT NULL,
        event_type      TEXT NOT NULL,
        actor           TEXT,
        detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    return true;
  },

  /** Every counterparty Payer OS may credit, by kind of push. */
  payees(disbursementType = null, config = null) {
    const settings = config || getPayerOsConfig();
    const spec = disbursementType ? describeType(disbursementType) : null;

    if (spec && spec.rail === 'wire') {
      return SettlementFundingEngine.destinations().map(destination => ({
        key: destination.key,
        purpose: 'settlement_funding',
        label: destination.label,
        name: destination.beneficiaryName || settings.originatorName,
        bankName: destination.bankName,
        routingNumber: destination.routingNumber,
        accountLast4: destination.accountLast4,
        glAccountCode: destination.glAccountCode,
      }));
    }

    if (spec && spec.rail === 'stablecoin') {
      return StablecoinPayoutRail.wallets();
    }

    const ach = Object.entries(settings.payees)
      .map(([key, raw]) => describePayee(String(key).toLowerCase(), raw, null))
      .filter(payee => !spec || payee.purpose === spec.type)
      .map(payee => ({ ...payee, accountNumber: undefined }));

    if (spec) return ach;
    return [...ach, ...this.payees('settlement_funding', settings), ...StablecoinPayoutRail.wallets()];
  },

  payee(disbursementType, key, config = null) {
    const spec = describeType(disbursementType);
    const settings = config || getPayerOsConfig();
    if (spec.rail === 'wire') {
      return SettlementFundingEngine.destination(key);
    }
    if (spec.rail === 'stablecoin') {
      return StablecoinPayoutRail.wallet(key);
    }
    const wanted = String(key || '').trim().toLowerCase();
    if (!wanted) {
      throw new PayerOsError(
        'payee is required: a credit push names a registered payee, never a routing and account number',
        'PAYER_OS_PAYEE_REQUIRED',
        400
      );
    }
    const raw = settings.payees[wanted]
      || settings.payees[Object.keys(settings.payees).find(k => k.toLowerCase() === wanted)];
    if (!raw) {
      const known = Object.keys(settings.payees);
      throw new PayerOsError(
        `"${wanted}" is not a registered payee`
        + (known.length ? `; registered: ${known.join(', ')}` : '; PAYER_OS_PAYEES is empty')
        + '. Payer OS credits pre-registered accounts only.',
        'PAYER_OS_PAYEE_UNKNOWN',
        409
      );
    }
    return describePayee(wanted, raw, spec);
  },

  /**
   * What Payer OS has already promised out of one funding account over ACH and
   * not yet settled. Wires are not counted here: they live in the wire ledger
   * and `SettlementFundingEngine.inFlightCents` reads them from there, so
   * counting them twice would understate what the trust can spend.
   */
  async inFlightCents(sourceKey) {
    await this.ensureTables();
    const rows = await pool.query(
      `SELECT COALESCE(SUM(amount_cents), 0) AS cents
         FROM payer_disbursements
        WHERE rail = 'ach'
          AND status = ANY($1::text[])
          AND funding_source_key = $2`,
      [IN_FLIGHT_STATUSES, sourceKey]
    );
    return Number(rows.rows[0]?.cents || 0);
  },

  /**
   * USDC the trust has already promised out of its token position. It is kept
   * apart from the cash figure because the two are different assets: a pending
   * USDC payout does not reduce what Trust Operating can wire.
   */
  async stablecoinInFlightCents() {
    await this.ensureTables();
    const rows = await pool.query(
      `SELECT COALESCE(SUM(amount_cents), 0) AS cents
         FROM payer_disbursements
        WHERE rail = 'stablecoin' AND status = ANY($1::text[])`,
      [IN_FLIGHT_STATUSES]
    );
    return Number(rows.rows[0]?.cents || 0);
  },

  /**
   * What this push would draw on, who it credits, and whether the dollars are
   * there. Nothing is created and nothing is reserved: this is what an operator
   * sees before committing, and the same check `initiate` repeats.
   */
  async plan({ disbursementType, amountCents, payee = null, fundingSourceRef = null } = {}) {
    const spec = describeType(disbursementType);
    const config = getPayerOsConfig();
    const amount = Number(amountCents);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new PayerOsError(
        'amountCents must be a positive whole number of cents',
        'PAYER_OS_BAD_AMOUNT',
        400
      );
    }
    if (config.maxAmountCents && amount > config.maxAmountCents) {
      throw new PayerOsError(
        `${dollars(amount)} exceeds the Payer OS ceiling of ${dollars(config.maxAmountCents)} per disbursement`,
        'PAYER_OS_AMOUNT_CEILING',
        409
      );
    }

    if (spec.rail === 'stablecoin') {
      const wallet = StablecoinPayoutRail.wallet(payee);
      const position = await StablecoinPayoutRail.position();
      const inFlightCents = await this.stablecoinInFlightCents();
      const spendableCents = Math.max(0, position.availableCents - inFlightCents);
      return {
        disbursementType: spec.type,
        rail: 'stablecoin',
        direction: 'credit',
        amountCents: amount,
        amount: dollars(amount),
        currency: 'USD',
        asset: position.asset,
        issuer: position.issuer,
        network: position.network,
        source: {
          // The token position, named the way the funding registry names an
          // account, so callers do not have to special-case this rail.
          sourceType: 'stablecoin_distributor',
          sourceKey: `stablecoin:${position.address}`,
          sourceId: config.stablecoinAssetAccount,
          accountName: `${position.asset} at …${position.address.slice(-4)}`,
          currency: 'USD',
        },
        payee: {
          key: wallet.key,
          label: wallet.label,
          name: wallet.name,
          routingNumber: null,
          accountLast4: wallet.addressLast4,
          glAccountCode: wallet.glAccountCode,
        },
        glDebitAccountCode: wallet.glAccountCode,
        glCreditAccountCode: config.stablecoinAssetAccount,
        availableCents: position.availableCents,
        inFlightCents,
        inFlight: dollars(inFlightCents),
        spendableCents,
        spendable: dollars(spendableCents),
        shortfallCents: Math.max(0, amount - spendableCents),
        funded: amount <= spendableCents,
      };
    }

    if (spec.rail === 'wire') {
      const funding = await SettlementFundingEngine.plan({
        amountCents: amount,
        destination: payee,
        fundingSourceRef: fundingSourceRef || config.fundingSourceRef,
      });
      const achInFlightCents = await this.inFlightCents(funding.source.sourceKey);
      const spendableCents = Math.max(0, funding.spendableCents - achInFlightCents);
      return {
        disbursementType: spec.type,
        rail: 'wire',
        direction: 'credit',
        amountCents: amount,
        amount: dollars(amount),
        currency: funding.currency,
        source: funding.source,
        payee: {
          key: funding.destination.key,
          label: funding.destination.label,
          name: funding.destination.beneficiaryName || funding.source.debtorName,
          bankName: funding.destination.bankName,
          routingNumber: funding.destination.routingNumber,
          accountLast4: funding.destination.accountLast4,
          glAccountCode: funding.destination.glAccountCode,
        },
        glDebitAccountCode: funding.destination.glAccountCode,
        glCreditAccountCode: String(funding.source.sourceId),
        availableCents: funding.availableCents,
        inFlightCents: funding.inFlightCents + achInFlightCents,
        inFlight: dollars(funding.inFlightCents + achInFlightCents),
        spendableCents,
        spendable: dollars(spendableCents),
        shortfallCents: Math.max(0, amount - spendableCents),
        funded: amount <= spendableCents,
      };
    }

    const credit = this.payee(spec.type, payee, config);
    const source = await FundingSourceRegistry.resolve(fundingSourceRef || config.fundingSourceRef);

    if (source.currency !== 'USD') {
      throw new PayerOsError(
        `${source.accountName} is denominated in ${source.currency}; Payer OS originates domestic USD credits only`,
        'PAYER_OS_CURRENCY',
        409
      );
    }
    if (credit.routingNumber === source.debtorRouting && credit.accountNumber === source.debtorAccountNumber) {
      throw new PayerOsError(
        `${credit.label} is the account being drawn on: a credit from an account to itself moves no money`,
        'PAYER_OS_SELF_CREDIT',
        409
      );
    }

    const wireInFlightCents = await SettlementFundingEngine.inFlightCents(source.sourceKey);
    const achInFlightCents = await this.inFlightCents(source.sourceKey);
    const inFlightCents = wireInFlightCents + achInFlightCents;
    const spendableCents = Math.max(0, source.availableCents - inFlightCents);

    return {
      disbursementType: spec.type,
      rail: 'ach',
      direction: 'credit',
      secCode: spec.secCode,
      transactionCode: credit.transactionCode,
      entryDescription: spec.entryDescription,
      effectiveDate: effectiveDate(config.achEffectiveDateOffsetDays),
      amountCents: amount,
      amount: dollars(amount),
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
      payee: {
        key: credit.key,
        label: credit.label,
        name: credit.name,
        bankName: credit.bankName,
        routingNumber: credit.routingNumber,
        accountLast4: credit.accountLast4,
        accountType: credit.accountType,
        glAccountCode: credit.glAccountCode,
      },
      glDebitAccountCode: credit.glAccountCode,
      glCreditAccountCode: String(source.sourceId),
      availableCents: source.availableCents,
      available: dollars(source.availableCents),
      inFlightCents,
      inFlight: dollars(inFlightCents),
      spendableCents,
      spendable: dollars(spendableCents),
      shortfallCents: Math.max(0, amount - spendableCents),
      funded: amount <= spendableCents,
    };
  },

  /**
   * Raise the push. Nothing leaves the trust here: an ACH credit has no NACHA
   * file yet and a wire is not transmitted, because both wait on a second
   * trustee. The payee is screened now and the screening is recorded, so the
   * checker signs against a counterparty that was actually cleared.
   */
  async initiate({
    disbursementType,
    amountCents,
    payee = null,
    fundingSourceRef = null,
    initiatedBy,
    memo = null,
  } = {}) {
    if (!initiatedBy) {
      throw new PayerOsError(
        'initiatedBy is required: a credit push is made by a named trustee',
        'PAYER_OS_NO_MAKER',
        400
      );
    }
    const spec = describeType(disbursementType);
    const config = getPayerOsConfig();
    const plan = await this.plan({ disbursementType, amountCents, payee, fundingSourceRef });
    if (!plan.funded) {
      throw new PayerOsError(
        `${plan.source.accountName} has ${plan.spendable} spendable`
        + ` (${dollars(plan.availableCents)} on the ledger less ${plan.inFlight} already in flight)`
        + ` and this ${spec.type.replace('_', ' ')} pushes ${plan.amount}`,
        'PAYER_OS_INSUFFICIENT',
        409
      );
    }

    await this.ensureTables();

    if (spec.rail === 'wire') {
      const { wire } = await SettlementFundingEngine.initiate({
        amountCents: plan.amountCents,
        destination: plan.payee.key,
        fundingSourceRef: fundingSourceRef || config.fundingSourceRef,
        initiatedBy,
        memo: memo || `Payer OS settlement funding — ${plan.payee.label}`,
      });
      const row = await this._insert({ spec, plan, initiatedBy, memo, railReference: wire.wire_id, screening: null });
      return { disbursement: row, plan, wire };
    }

    if (spec.rail === 'stablecoin') {
      const wallet = this.payee(spec.type, plan.payee.key, config);
      const walletScreening = config.requireScreening
        ? await PaymentComplianceGate.screenVendorPayment({
          vendor: { businessName: wallet.name, email: wallet.email, country: 'US' },
          amount: Number(plan.amount),
          sourceAccountId: plan.source.sourceId,
          rail: 'stablecoin',
          action: 'execute',
          screenedBy: initiatedBy,
          reference: `payer-os:${spec.type}:${wallet.key}`,
        })
        : null;
      const row = await this._insert({
        spec,
        plan,
        initiatedBy,
        memo,
        railReference: null,
        screening: walletScreening,
      });
      return { disbursement: row, plan };
    }

    const screening = config.requireScreening
      ? await PaymentComplianceGate.screenVendorPayment({
        vendor: {
          businessName: spec.type === 'vendor_payout' ? plan.payee.name : undefined,
          fullName: spec.type === 'direct_deposit' ? plan.payee.name : undefined,
          routingNumber: plan.payee.routingNumber,
          accountNumber: this.payee(spec.type, plan.payee.key, config).accountNumber,
          country: 'US',
        },
        amount: Number(plan.amount),
        sourceAccountId: plan.source.sourceId,
        rail: 'ach',
        action: 'execute',
        screenedBy: initiatedBy,
        reference: `payer-os:${spec.type}:${plan.payee.key}`,
      })
      : null;

    const row = await this._insert({ spec, plan, initiatedBy, memo, railReference: null, screening });
    return { disbursement: row, plan };
  },

  /** Second signature. The maker may never be the checker. */
  async approve(disbursementId, approvedBy) {
    const row = await this._require(disbursementId);
    if (!approvedBy) {
      throw new PayerOsError('approvedBy is required', 'PAYER_OS_NO_CHECKER', 400);
    }
    if (row.status !== 'pending_approval') {
      throw new PayerOsError(
        `${row.disbursement_id} is ${row.status}, so there is nothing to approve`,
        'PAYER_OS_WRONG_STATE',
        409
      );
    }
    if (String(approvedBy).toLowerCase() === String(row.initiated_by).toLowerCase()) {
      throw new PayerOsError(
        'Dual control: the trustee who made this push cannot approve it',
        'PAYER_OS_SELF_APPROVAL',
        409
      );
    }

    if (row.rail === 'wire') {
      await SettlementFundingEngine.approve(row.rail_reference, approvedBy);
    }

    const updated = await this._update(disbursementId, {
      status: 'approved',
      approved_by: approvedBy,
      approved_at: 'NOW()',
    }, 'approved', approvedBy);
    return updated;
  },

  /**
   * Originate. This is where money actually leaves: a wire goes to the bank
   * through WireEngine, and an ACH credit is assembled into a NACHA file and
   * transmitted over the configured channel. Both refuse without a real
   * channel, and the funding check runs again against the current ledger,
   * because approval is not a reservation.
   */
  async send(disbursementId) {
    const row = await this._require(disbursementId);
    if (row.status !== 'approved') {
      throw new PayerOsError(
        row.status === 'pending_approval'
          ? `${row.disbursement_id} still needs a second trustee's approval`
          : `${row.disbursement_id} is ${row.status} and cannot be originated`,
        'PAYER_OS_WRONG_STATE',
        409
      );
    }

    const metadata = parseMetadata(row);
    const plan = await this.plan({
      disbursementType: row.disbursement_type,
      amountCents: Number(row.amount_cents),
      payee: row.payee_key,
      fundingSourceRef: row.funding_source_key,
    });
    if (!plan.funded) {
      throw new PayerOsError(
        `${plan.source.accountName} no longer has ${plan.amount} spendable (${plan.spendable} left), so this push is not originated`,
        'PAYER_OS_INSUFFICIENT',
        409
      );
    }

    if (row.rail === 'stablecoin') {
      if (metadata.screeningId) {
        await PaymentComplianceGate.verifyRecordedScreening(metadata.screeningId);
      } else if (getPayerOsConfig().requireScreening) {
        throw new PayerOsError(
          `${row.disbursement_id} carries no compliance screening, so it cannot be originated`,
          'PAYER_OS_UNSCREENED',
          409
        );
      }
      const wallet = StablecoinPayoutRail.wallet(row.payee_key);
      await this._update(disbursementId, { status: 'sending' }, 'sending');
      let submission;
      try {
        submission = await StablecoinPayoutRail.submit({
          wallet,
          amountCents: Number(row.amount_cents),
          memo: row.memo || null,
        });
      } catch (error) {
        await this._update(disbursementId, {
          status: 'failed',
          failure_reason: error.message,
        }, 'failed', null, { error: error.message });
        throw error;
      }
      const updated = await this._update(disbursementId, {
        status: 'sent',
        sent_at: 'NOW()',
        rail_reference: submission.reference,
      }, 'sent', null, { reference: submission.reference, explorer: submission.explorer });
      return { disbursement: updated, stablecoin: submission };
    }

    if (row.rail === 'wire') {
      const wire = await SettlementFundingEngine.send(row.rail_reference);
      const updated = await this._update(disbursementId, { status: 'sent', sent_at: 'NOW()' }, 'sent', null, {
        wireStatus: wire.status,
      });
      return { disbursement: updated, wire };
    }

    if (metadata.screeningId) {
      await PaymentComplianceGate.verifyRecordedScreening(metadata.screeningId);
    } else if (getPayerOsConfig().requireScreening) {
      throw new PayerOsError(
        `${row.disbursement_id} carries no compliance screening, so it cannot be originated`,
        'PAYER_OS_UNSCREENED',
        409
      );
    }

    const channel = await this.achChannel();
    if (!channel.ready) {
      throw new PayerOsError(
        `No ACH channel can originate this credit: ${channel.reason}.`
        + ' The file would be written to disk and no money would move, so it is refused instead.',
        'PAYER_OS_NO_ACH_CHANNEL',
        503
      );
    }

    const credit = this.payee(row.disbursement_type, row.payee_key);
    await this._update(disbursementId, { status: 'sending' }, 'sending');
    let batch;
    try {
      batch = await ACHEngine.createBatch({
        secCode: row.sec_code,
        description: metadata.entryDescription || DISBURSEMENT_TYPES[row.disbursement_type].entryDescription,
        effectiveDate: plan.effectiveDate,
        createdBy: row.initiated_by,
        partnerId: channel.partnerId || null,
      }, [{
        receivingRouting: credit.routingNumber,
        accountNumber: credit.accountNumber,
        amountCents: Number(row.amount_cents),
        transactionCode: credit.transactionCode,
        individualId: credit.identifier,
        individualName: credit.name,
        memo: row.memo || '',
      }]);
      await ACHEngine.transmitBatch(batch.batch_id, { approvedBy: row.approved_by, actor: row.approved_by });
    } catch (error) {
      await this._update(disbursementId, {
        status: 'failed',
        failure_reason: error.message,
        rail_reference: batch ? batch.batch_id : null,
      }, 'failed', null, { error: error.message });
      throw new PayerOsError(
        `ACH origination failed for ${row.disbursement_id}: ${error.message}`,
        'PAYER_OS_ACH_FAILED',
        502
      );
    }

    const updated = await this._update(disbursementId, {
      status: 'sent',
      sent_at: 'NOW()',
      rail_reference: batch.batch_id,
    }, 'sent', null, { batchId: batch.batch_id, channel: channel.provider });
    return { disbursement: updated, batch: await ACHEngine.getBatch(batch.batch_id) };
  },

  /**
   * Settled: the bank says the credit reached the receiver. This is the only
   * step that touches the ledger, and it needs the bank's own reference —
   * posting on the strength of a file we assembled ourselves is how a GL comes
   * to claim money that never arrived.
   */
  async settle(disbursementId, evidence = {}) {
    const row = await this._require(disbursementId);
    const reference = String(evidence.reference || evidence.settlementReference || '').trim();
    if (!reference) {
      throw new PayerOsError(
        'A settlement reference from the bank is required: the ledger does not post on our own say-so',
        'PAYER_OS_NO_EVIDENCE',
        400
      );
    }
    if (row.status !== 'sent') {
      throw new PayerOsError(
        `${row.disbursement_id} is ${row.status}; only a sent push can settle`,
        'PAYER_OS_WRONG_STATE',
        409
      );
    }

    if (row.rail === 'stablecoin') {
      // The chain is the evidence. A hash Horizon cannot confirm as a payment
      // of this asset, amount and destination does not post a journal entry.
      const confirmation = await StablecoinPayoutRail.verify({
        reference,
        wallet: StablecoinPayoutRail.wallet(row.payee_key),
        amountCents: Number(row.amount_cents),
      });
      if (!confirmation.confirmed) {
        throw new PayerOsError(
          `${row.disbursement_id} is not settled on-chain: ${confirmation.reason}`,
          'PAYER_OS_UNCONFIRMED',
          409
        );
      }
    }

    if (row.rail === 'wire') {
      const wire = await SettlementFundingEngine.settle(row.rail_reference, { ...evidence, reference });
      const updated = await this._update(disbursementId, {
        status: 'settled',
        settled_at: 'NOW()',
        settlement_reference: reference,
        journal_entry_id: wire.journal_entry_id || null,
      }, 'settled', evidence.settledBy || null);
      return { disbursement: updated, wire };
    }

    const amount = Number(row.amount_cents) / 100;
    const journalEntry = await TrustAccountingEngine.postJournalEntry({
      entryDate: evidence.settledAt || new Date(),
      description: `Payer OS ${row.disbursement_type.replace('_', ' ')}: ${row.payee_label || row.payee_name}`,
      lines: [
        {
          accountCode: row.gl_debit_account,
          debitAmount: amount,
          creditAmount: 0,
          memo: `${row.disbursement_id} → ${row.payee_name} (…${row.payee_account_last4})`,
        },
        {
          accountCode: row.gl_credit_account,
          debitAmount: 0,
          creditAmount: amount,
          memo: `${row.rail === 'stablecoin' ? 'USDC' : 'ACH'} credit outflow: ${row.disbursement_id}`,
        },
      ],
      referenceType: 'payer_disbursement',
      referenceId: row.disbursement_id,
      postedBy: evidence.settledBy || row.approved_by || row.initiated_by || 'system',
    });

    if (row.rail === 'ach' && row.rail_reference) {
      await ACHEngine.settleBatch(row.rail_reference, {
        settlementDate: evidence.settlementDate || null,
      }).catch(() => null);
    }

    return {
      disbursement: await this._update(disbursementId, {
        status: 'settled',
        settled_at: 'NOW()',
        settlement_reference: reference,
        journal_entry_id: journalEntry.entry_id,
      }, 'settled', evidence.settledBy || null, { reference }),
      journalEntry,
    };
  },

  /** Give the dollars back before anything is originated. */
  async cancel(disbursementId, cancelledBy) {
    const row = await this._require(disbursementId);
    if (!['pending_approval', 'approved'].includes(row.status)) {
      throw new PayerOsError(
        `${row.disbursement_id} is ${row.status} and can no longer be cancelled`,
        'PAYER_OS_WRONG_STATE',
        409
      );
    }
    if (row.rail === 'wire' && row.rail_reference) {
      await SettlementFundingEngine.cancel(row.rail_reference, cancelledBy);
    }
    return this._update(disbursementId, {
      status: 'cancelled',
      failure_reason: 'Cancelled before origination',
    }, 'cancelled', cancelledBy);
  },

  async get(disbursementId) {
    await this.ensureTables();
    const rows = await pool.query(
      'SELECT * FROM payer_disbursements WHERE disbursement_id = $1',
      [String(disbursementId || '')]
    );
    return rows.rows[0] || null;
  },

  async list({ disbursementType = null, status = null, limit = 50 } = {}) {
    await this.ensureTables();
    const rows = await pool.query(
      `SELECT * FROM payer_disbursements
        WHERE ($1::text IS NULL OR disbursement_type = $1)
          AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC
        LIMIT $3`,
      [
        disbursementType ? describeType(disbursementType).type : null,
        status,
        Math.min(500, Math.max(1, Number(limit) || 50)),
      ]
    );
    return rows.rows;
  },

  async events(disbursementId) {
    await this.ensureTables();
    const rows = await pool.query(
      'SELECT * FROM payer_disbursement_events WHERE disbursement_id = $1 ORDER BY sequence ASC',
      [String(disbursementId || '')]
    );
    return rows.rows;
  },

  /**
   * Whether an ACH credit can actually reach a bank. The ACH engine falls back
   * to writing a validated NACHA file into a local export directory when no
   * partner is configured; that is a useful test mode and a terrible payment,
   * so it is reported here as no channel rather than as a channel.
   */
  async achChannel() {
    let mode = 'unknown';
    try { mode = await SystemSettings.getMode(); } catch { mode = 'unknown'; }

    const mftChannelId = ACHEngine.mftChannelId();
    if (mftChannelId) {
      let channel = null;
      let reason = null;
      try { channel = await MftOsEngine.channel(mftChannelId); } catch (error) { reason = error.message; }
      const ready = Boolean(channel && channel.readiness.ready);
      return {
        ready,
        mode,
        via: 'mft',
        mftChannelId,
        transport: channel ? channel.readiness.transport : null,
        provider: channel ? `MFT ${channel.name}${channel.bankName ? ` (${channel.bankName})` : ''}` : `MFT channel ${mftChannelId}`,
        partnerId: null,
        reason: ready ? null : (reason || `MFT channel ${mftChannelId} cannot transmit: ${channel.readiness.blockers.join('; ')}`),
      };
    }

    let production = null;
    try { production = await SystemSettings.getProductionPartnerConfig(); } catch { production = null; }
    if (production && production.apiBaseUrl && production.apiBaseUrl !== 'direct') {
      return {
        ready: true,
        mode,
        provider: production.partnerName || production.partnerId || 'configured bank endpoint',
        partnerId: production.partnerId || null,
        reason: null,
      };
    }

    if (text('ACH_SFTP_URL')) {
      return {
        ready: true,
        mode,
        provider: text('ACH_SFTP_PARTNER_NAME', 'Bank NACHA SFTP'),
        partnerId: text('ACH_SFTP_PARTNER_ID', 'BANK-SFTP') || null,
        reason: null,
      };
    }

    let partner = null;
    try { partner = await AS2Partners.getDefaultPartnerConfig(); } catch { partner = null; }
    const partnerUrl = partner ? (partner.apiBaseUrl || partner.partnerUrl || '') : '';
    if (partner && partnerUrl && partnerUrl !== 'direct') {
      return {
        ready: true,
        mode,
        provider: partner.partnerName || partner.partnerId || 'AS2 partner',
        partnerId: partner.partnerId || null,
        reason: null,
      };
    }

    return {
      ready: false,
      mode,
      provider: null,
      partnerId: null,
      reason: mode === 'sandbox'
        ? 'the system is in sandbox mode, where NACHA files are exported locally instead of transmitted'
        : 'no bank endpoint, ACH_SFTP_URL or AS2 partner is configured, so the ACH engine would fall back to a local file export',
    };
  },

  /**
   * Whether Payer OS can move money, and exactly where it stops if not. A
   * missing channel is a blocker rather than a warning: everything up to
   * transmission runs without one and no dollars leave the trust.
   */
  async readiness() {
    const blockers = [];
    const warnings = [];
    let config = null;
    let payees = [];
    try {
      config = getPayerOsConfig();
      payees = this.payees(null, config);
    } catch (error) {
      blockers.push(error.message);
    }

    const achPayees = payees.filter(payee => ['direct_deposit', 'vendor_payout'].includes(payee.purpose));
    if (config && !achPayees.length) {
      warnings.push(
        'No direct deposit or vendor payee is registered: set PAYER_OS_PAYEES to the accounts the trust may credit'
      );
    }

    let source = null;
    try {
      const funding = await FundingSourceRegistry.readiness();
      blockers.push(...funding.blockers);
      warnings.push(...funding.warnings);
    } catch (error) {
      blockers.push(error.message);
    }
    if (config) {
      try {
        const resolved = await FundingSourceRegistry.resolve(config.fundingSourceRef);
        const wireInFlight = await SettlementFundingEngine.inFlightCents(resolved.sourceKey);
        const achInFlight = await this.inFlightCents(resolved.sourceKey);
        source = {
          sourceKey: resolved.sourceKey,
          accountName: resolved.accountName,
          available: dollars(resolved.availableCents),
          inFlight: dollars(wireInFlight + achInFlight),
          spendable: dollars(Math.max(0, resolved.availableCents - wireInFlight - achInFlight)),
        };
        if (resolved.availableCents <= 0) {
          warnings.push(`${resolved.accountName} holds nothing, so no credit can be funded yet.`);
        }
      } catch (error) {
        if (!(error instanceof FundingSourceError) && !(error instanceof PayerOsError)) throw error;
        blockers.push(error.message);
      }
    }

    const ach = await this.achChannel();
    if (!ach.ready) {
      blockers.push(`ACH credits cannot be originated: ${ach.reason}.`);
    }
    if (!ODFI_ROUTING) {
      blockers.push(
        'No ODFI routing number is configured (NACHA_ODFI_ROUTING), so a NACHA file cannot name the originating bank'
      );
    }

    const partnerBank = PartnerBankRails.status();
    if (!partnerBank.ready) {
      blockers.push(
        `Settlement funding wires cannot be originated (partner bank missing ${partnerBank.missingConfiguration.join(', ')}).`
      );
    }

    // Reported per rail rather than folded into `blockers`: the USDC rail is
    // here precisely because the fiat channels are unavailable, so what one
    // rail is missing must not read as the whole payer being unable to pay.
    let stablecoinRail = null;
    try {
      stablecoinRail = await StablecoinPayoutRail.readiness();
      if (!stablecoinRail.ready) {
        warnings.push(`USDC payouts cannot be originated: ${stablecoinRail.issues.join(' ')}`);
      }
    } catch (error) {
      warnings.push(`USDC payouts cannot be originated: ${error.message}`);
    }

    let compliance = null;
    try {
      compliance = await PaymentComplianceGate.paymentReadiness({ rail: 'ach', action: 'execute' });
      if (!compliance.ready) {
        blockers.push(...compliance.issues.map(issue => `Compliance: ${issue}`));
      }
    } catch (error) {
      blockers.push(`Compliance: ${error.message}`);
    }

    return {
      ready: blockers.length === 0,
      originates: Object.values(DISBURSEMENT_TYPES).map(spec => ({
        disbursementType: spec.type,
        rail: spec.rail,
        direction: 'credit',
        secCode: spec.secCode || null,
        label: spec.label,
      })),
      fundingSource: source,
      payees: payees.map(payee => ({
        key: payee.key,
        purpose: payee.purpose,
        label: payee.label,
        accountLast4: payee.accountLast4,
        glAccountCode: payee.glAccountCode,
      })),
      achChannel: ach,
      stablecoinRail,
      odfi: { routingNumber: ODFI_ROUTING || null, originatorId: ODFI_ROUTING ? ORIGINATOR_ID : null },
      wireChannel: {
        ready: partnerBank.ready,
        provider: partnerBank.provider || null,
        missingConfiguration: partnerBank.missingConfiguration,
      },
      compliance: compliance ? { ready: compliance.ready, issues: compliance.issues } : null,
      blockers,
      warnings,
      note: blockers.length === 0
        ? 'The trust can push credits to registered settlement accounts, direct deposit payees and vendors, under dual control.'
        : 'Payer OS is closed until the listed configuration is supplied; it fails closed rather than originating a payment that goes nowhere.',
    };
  },

  async _insert({ spec, plan, initiatedBy, memo, railReference, screening }) {
    const disbursementId = newId(spec);
    const metadata = {
      entryDescription: spec.entryDescription || null,
      effectiveDate: plan.effectiveDate || null,
      payee: plan.payee,
      fundingSource: plan.source,
      screeningId: screening ? screening.screeningId : null,
      screening: screening || null,
    };
    const rows = await pool.query(
      `INSERT INTO payer_disbursements
        (disbursement_id, disbursement_type, rail, direction, status, amount_cents, currency,
         payee_key, payee_label, payee_name, payee_routing, payee_account_last4,
         sec_code, transaction_code, funding_source_key, funding_account_id, funding_account_name,
         gl_debit_account, gl_credit_account, memo, initiated_by, rail_reference, metadata)
       VALUES ($1, $2, $3, 'credit', 'pending_approval', $4, $5,
               $6, $7, $8, $9, $10,
               $11, $12, $13, $14, $15,
               $16, $17, $18, $19, $20, $21::jsonb)
       RETURNING *`,
      [
        disbursementId, spec.type, spec.rail, plan.amountCents, plan.currency,
        plan.payee.key, plan.payee.label, plan.payee.name, plan.payee.routingNumber, plan.payee.accountLast4,
        spec.secCode || null, plan.transactionCode || null,
        plan.source.sourceKey, String(plan.source.sourceId), plan.source.accountName,
        plan.glDebitAccountCode, plan.glCreditAccountCode, memo || null, initiatedBy, railReference,
        JSON.stringify(metadata),
      ]
    );
    await this._event(disbursementId, 'initiated', initiatedBy, {
      amount: plan.amount,
      payee: plan.payee.key,
      rail: spec.rail,
      railReference,
    });
    return rows.rows[0];
  },

  async _update(disbursementId, fields, eventType, actor = null, detail = {}) {
    const assignments = [];
    const params = [disbursementId];
    for (const [column, value] of Object.entries(fields)) {
      if (value === 'NOW()') {
        assignments.push(`${column} = NOW()`);
        continue;
      }
      params.push(value);
      assignments.push(`${column} = $${params.length}`);
    }
    const rows = await pool.query(
      `UPDATE payer_disbursements
          SET ${assignments.join(', ')}, updated_at = NOW()
        WHERE disbursement_id = $1
        RETURNING *`,
      params
    );
    if (eventType) await this._event(disbursementId, eventType, actor, detail);
    return rows.rows[0];
  },

  async _event(disbursementId, eventType, actor, detail = {}) {
    await pool.query(
      `INSERT INTO payer_disbursement_events (disbursement_id, event_type, actor, detail)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [disbursementId, eventType, actor || null, JSON.stringify(detail || {})]
    );
  },

  async _require(disbursementId) {
    const row = await this.get(disbursementId);
    if (!row) {
      throw new PayerOsError(`Disbursement not found: ${disbursementId}`, 'PAYER_OS_NOT_FOUND', 404);
    }
    return row;
  },
};

module.exports = {
  PayerOsEngine,
  PayerOsError,
  getPayerOsConfig,
  describePayee,
  describeType,
  DISBURSEMENT_TYPES,
  CREDIT_TRANSACTION_CODES,
  IN_FLIGHT_STATUSES,
  TERMINAL_STATUSES,
};
