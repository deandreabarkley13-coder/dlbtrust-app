'use strict';

/**
 * Where a cleared payment's money comes from
 *
 * The trust funds outbound payments from exactly two kinds of account, and this
 * module is the only place that decides which one a clearing instruction draws
 * on:
 *
 *   • the Trust Operating Account — the trust's own day-to-day account, which
 *     funds trust expenses, vendor bills and fees;
 *   • a Beneficiary Trust Account — the sub-ledger held for one named
 *     beneficiary, which funds that beneficiary's own distributions.
 *
 * Anything else is refused. That is the point: a data workflow hands over a
 * spreadsheet or a JSON export, and the column that names an account is
 * untrusted input. Left unchecked it would let an export fund a wire out of
 * bond proceeds, a reserve, an escrow or a segregated account, which is a
 * breach of the trust's own segregation of funds rather than a formatting bug.
 * So resolution fails closed: an account this module cannot place in one of the
 * two permitted classes stops the instruction and names it.
 *
 * Three further properties are load-bearing:
 *
 *   • Balances are read from the ledger that owns them — the trust chart of
 *     accounts for the operating account, the client sub-ledger for a
 *     beneficiary account — never from the inbound file. A file that claims a
 *     funding balance is ignored.
 *   • The funding decision is internal; the bank still sees one real account.
 *     Beneficiary trust accounts are claims on the trust's settlement account,
 *     so the clearing file names that account as the debtor and identifies the
 *     funding source in the debtor name ("… FBO JANE DOE") and in the
 *     manifest. Nothing here invents a DDA a beneficiary does not have.
 *   • Resolving reserves nothing and moves nothing. This module reports what
 *     each instruction is funded from and whether the money is there; the
 *     ledgers stay untouched until the payment itself posts.
 */

const { getClearingSpecConfig } = require('./clearingSpecConfig');
const { TrustAccountingEngine } = require('../../accounting/trustAccountingEngine');
const { SubLedgerEngine } = require('../../accounting/subLedgerEngine');

const TRUST_OPERATING = 'trust_operating';
const BENEFICIARY_TRUST = 'beneficiary_trust';

class FundingSourceError extends Error {
  constructor(message, code = 'CLEARING_FUNDING_ERROR', status = 409, { failures = null } = {}) {
    super(message);
    this.name = 'FundingSourceError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
    this.failures = failures;
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

function list(value) {
  return String(value || '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
}

function cents(value) {
  return Math.round(Number(value || 0) * 100);
}

function upper(value) {
  return String(value === null || value === undefined ? '' : value).trim().toUpperCase();
}

function getFundingSourceConfig() {
  const clearing = getClearingSpecConfig();
  return {
    // With enforcement off the resolver still reports what it found, but an
    // unresolved instruction keeps whatever debtor its source data carried.
    enforce: boolEnv('CLEARING_FUNDING_ENFORCE', true),
    requireBalance: boolEnv('CLEARING_FUNDING_REQUIRE_BALANCE', true),

    // The Trust Operating Account, by its chart-of-accounts code.
    operatingAccountCode: text('CLEARING_FUNDING_OPERATING_ACCOUNT', '1010'),
    // The real account the bank debits. Every permitted funding source settles
    // through it; the source itself is an internal claim on it.
    settlementAccountNumber: text('CLEARING_FUNDING_SETTLEMENT_ACCOUNT', clearing.senderAccount),
    settlementRouting: text('CLEARING_FUNDING_SETTLEMENT_ROUTING', clearing.senderRouting),
    trustName: text('CLEARING_FUNDING_TRUST_NAME', clearing.senderName),

    // Which sub-ledgers count as a Beneficiary Trust Account. A beneficiary's
    // fee or accrued-interest sub-ledger is an accounting record, not spendable
    // money, so the eligible sub-account types are configuration.
    beneficiarySubAccountTypes: list(
      text('CLEARING_FUNDING_BENEFICIARY_SUBACCOUNT_TYPES', 'distribution,operating,general')
    ).map(entry => entry.toLowerCase()),
    beneficiaryParentAccounts: list(text('CLEARING_FUNDING_BENEFICIARY_PARENT_ACCOUNTS')),

    // What funds an instruction whose source data names no account.
    defaultSource: text('CLEARING_FUNDING_DEFAULT_SOURCE', 'operating'),
    currency: clearing.currency,
  };
}

/**
 * `trust:1010`, `operating`, `beneficiary:SL-…`, or a bare account code, name,
 * sub-ledger id or contact id. The scope, when given, is authoritative: a ref
 * scoped `beneficiary:` is never matched against the operating account.
 */
function parseRef(ref) {
  const raw = String(ref === null || ref === undefined ? '' : ref).trim();
  if (!raw) return { scope: null, id: null, raw };
  const match = /^([a-z_]+)\s*:\s*(.+)$/i.exec(raw);
  if (!match) return { scope: null, id: raw, raw };
  const scope = match[1].toLowerCase();
  const id = match[2].trim();
  if (['trust', 'trust_account', 'operating', 'trust_operating', 'gl'].includes(scope)) {
    return { scope: TRUST_OPERATING, id, raw };
  }
  if (['beneficiary', 'beneficiary_trust', 'bene', 'subledger', 'sub_ledger'].includes(scope)) {
    return { scope: BENEFICIARY_TRUST, id, raw };
  }
  // An unknown scope is not silently downgraded to a bare lookup: `cash:…`,
  // `bond:…` and friends name accounts this workflow may not spend.
  return { scope: 'unsupported', id, raw, scopeLabel: scope };
}

function beneficiaryName(ledger) {
  const person = [ledger.first_name, ledger.last_name].filter(Boolean).join(' ').trim();
  return person || ledger.company || ledger.sub_account_name || ledger.contact_id;
}

function describeOperating(account, config) {
  const balanceCents = Number(account.balance_cents || 0);
  const eligible = Boolean(account.funding_eligible);
  return {
    sourceType: TRUST_OPERATING,
    sourceKey: `trust:${account.account_code}`,
    sourceId: String(account.account_code),
    sourceOfTruth: 'trust_accounting',
    accountName: account.account_name || 'Trust Operating Account',
    debtorName: upper(config.trustName),
    debtorAccountNumber: config.settlementAccountNumber || null,
    debtorRouting: config.settlementRouting || null,
    currency: (account.currency || config.currency || 'USD').toUpperCase(),
    balanceCents,
    availableCents: Number(account.available_balance_cents || 0),
    eligible,
    ineligibleReason: eligible ? null : account.segregation_reason || 'the account is not eligible payment funds',
    beneficiary: null,
  };
}

function describeBeneficiary(ledger, config) {
  const name = beneficiaryName(ledger);
  const balanceCents = cents(ledger.balance);
  const status = String(ledger.status || 'active').toLowerCase();
  const subType = String(ledger.sub_account_type || '').toLowerCase();
  const contactType = String(ledger.contact_type || '').toLowerCase();

  let ineligibleReason = null;
  if (contactType && contactType !== 'beneficiary') {
    ineligibleReason = `${ledger.contact_id} is a ${contactType}, not a beneficiary of the trust`;
  } else if (status !== 'active') {
    ineligibleReason = `the beneficiary trust account is ${status}`;
  } else if (config.beneficiarySubAccountTypes.length && !config.beneficiarySubAccountTypes.includes(subType)) {
    ineligibleReason = `a ${subType || 'unclassified'} sub-ledger is a record of the beneficiary's entitlement, not spendable trust funds`;
  } else if (
    config.beneficiaryParentAccounts.length
    && !config.beneficiaryParentAccounts.includes(String(ledger.parent_account_code))
  ) {
    ineligibleReason = `the account rolls up to ${ledger.parent_account_code}, which is not approved to fund payments`;
  } else if (balanceCents <= 0) {
    ineligibleReason = 'the beneficiary trust account holds no funds';
  }

  return {
    sourceType: BENEFICIARY_TRUST,
    sourceKey: `beneficiary:${ledger.sub_ledger_id}`,
    sourceId: ledger.sub_ledger_id,
    sourceOfTruth: 'client_sub_ledger',
    accountName: ledger.sub_account_name || `${name} trust account`,
    // A trust wire out of a beneficiary's account is drawn on the trust's own
    // settlement account for the benefit of that beneficiary, which is what the
    // debtor name has to say for the receiving bank to place it.
    debtorName: `${upper(config.trustName)} FBO ${upper(name)}`.trim(),
    debtorAccountNumber: config.settlementAccountNumber || null,
    debtorRouting: config.settlementRouting || null,
    currency: (ledger.currency || config.currency || 'USD').toUpperCase(),
    balanceCents,
    availableCents: ineligibleReason ? 0 : Math.max(0, balanceCents),
    eligible: !ineligibleReason,
    ineligibleReason,
    beneficiary: {
      contactId: ledger.contact_id,
      name,
      parentAccountCode: ledger.parent_account_code,
      subAccountType: ledger.sub_account_type,
    },
  };
}

async function operatingSource(config) {
  const account = await TrustAccountingEngine.getAccount(config.operatingAccountCode);
  if (!account) {
    throw new FundingSourceError(
      `The Trust Operating Account ${config.operatingAccountCode} is not in the chart of accounts; set CLEARING_FUNDING_OPERATING_ACCOUNT to the code the trust uses`,
      'CLEARING_FUNDING_NO_OPERATING_ACCOUNT',
      412
    );
  }
  return describeOperating(account, config);
}

async function beneficiarySources(config) {
  await SubLedgerEngine.ensureTables();
  const ledgers = await SubLedgerEngine.listSubLedgers({ status: 'active' });
  return ledgers
    .filter(ledger => String(ledger.contact_type || '').toLowerCase() === 'beneficiary')
    .map(ledger => describeBeneficiary(ledger, config));
}

/** Does this ref name the Trust Operating Account? */
function matchesOperating(operating, { id }) {
  const wanted = upper(id);
  return [
    operating.sourceId,
    operating.sourceKey,
    operating.accountName,
    operating.debtorAccountNumber,
    'operating',
    'trust operating account',
  ]
    .filter(Boolean)
    .some(candidate => upper(candidate) === wanted);
}

/** Does this ref name a Beneficiary Trust Account? */
function matchesBeneficiary(source, { id }) {
  const wanted = upper(id);
  return [
    source.sourceId,
    source.sourceKey,
    source.accountName,
    source.beneficiary && source.beneficiary.contactId,
    source.beneficiary && source.beneficiary.name,
  ]
    .filter(Boolean)
    .some(candidate => upper(candidate) === wanted);
}

const FundingSourceRegistry = {
  FundingSourceError,
  TRUST_OPERATING,
  BENEFICIARY_TRUST,

  config: getFundingSourceConfig,

  /** Every account this workflow is allowed to draw on, with its position. */
  async list() {
    const config = getFundingSourceConfig();
    const [operating, beneficiaries] = await Promise.all([
      operatingSource(config),
      beneficiarySources(config),
    ]);
    return [operating, ...beneficiaries];
  },

  async readiness() {
    const config = getFundingSourceConfig();
    const blockers = [];
    const warnings = [];
    let sources = [];
    try {
      sources = await this.list();
    } catch (error) {
      blockers.push(error.message);
    }

    const operating = sources.find(source => source.sourceType === TRUST_OPERATING) || null;
    if (operating && !operating.eligible) {
      blockers.push(`The Trust Operating Account ${operating.sourceId} cannot fund payments: ${operating.ineligibleReason}`);
    }
    if (!config.settlementAccountNumber) {
      warnings.push('No CLEARING_FUNDING_SETTLEMENT_ACCOUNT: formatted files name no debtor account, so the bank has to infer which account to debit.');
    }
    if (!config.enforce) {
      warnings.push('CLEARING_FUNDING_ENFORCE is off: an instruction naming an account outside the trust operating and beneficiary trust accounts is reported but not refused.');
    }
    if (!config.requireBalance) {
      warnings.push('CLEARING_FUNDING_REQUIRE_BALANCE is off: a file may be formatted against a funding source that does not hold the money.');
    }

    return {
      ready: blockers.length === 0,
      enforce: config.enforce,
      requireBalance: config.requireBalance,
      operatingAccount: operating ? { sourceId: operating.sourceId, name: operating.accountName, available: (operating.availableCents / 100).toFixed(2) } : null,
      beneficiaryAccounts: sources.filter(source => source.sourceType === BENEFICIARY_TRUST).length,
      defaultSource: config.defaultSource,
      blockers,
      warnings,
      note: blockers.length === 0
        ? 'Payments clear out of the Trust Operating Account or a named Beneficiary Trust Account; every other account is refused.'
        : 'Funding-source resolution is closed until the listed configuration is supplied; it fails closed.',
    };
  },

  /**
   * Resolve one reference against the permitted accounts. `sources` may be
   * passed in when resolving a whole instruction set, so a batch reads each
   * ledger once.
   */
  async resolve(ref, { sources = null, config = null } = {}) {
    const settings = config || getFundingSourceConfig();
    const known = sources || (await this.list());
    const parsed = parseRef(ref === null || ref === undefined || String(ref).trim() === '' ? settings.defaultSource : ref);

    if (parsed.scope === 'unsupported') {
      throw new FundingSourceError(
        `"${parsed.raw}" names a ${parsed.scopeLabel} account: payments clear out of the Trust Operating Account or a Beneficiary Trust Account only`,
        'CLEARING_FUNDING_SOURCE_NOT_PERMITTED',
        409
      );
    }

    const operating = known.find(source => source.sourceType === TRUST_OPERATING) || null;
    const beneficiaries = known.filter(source => source.sourceType === BENEFICIARY_TRUST);

    let resolved = null;
    if (parsed.scope === TRUST_OPERATING) {
      resolved = operating && matchesOperating(operating, parsed) ? operating : null;
      if (!resolved) {
        throw new FundingSourceError(
          `"${parsed.raw}" is not the Trust Operating Account (${operating ? operating.sourceId : 'unconfigured'})`,
          'CLEARING_FUNDING_SOURCE_UNKNOWN',
          409
        );
      }
    } else if (parsed.scope === BENEFICIARY_TRUST) {
      resolved = beneficiaries.find(source => matchesBeneficiary(source, parsed)) || null;
      if (!resolved) {
        throw new FundingSourceError(
          `No beneficiary trust account matches "${parsed.raw}"`,
          'CLEARING_FUNDING_SOURCE_UNKNOWN',
          409
        );
      }
    } else {
      resolved = (operating && matchesOperating(operating, parsed) ? operating : null)
        || beneficiaries.find(source => matchesBeneficiary(source, parsed))
        || null;
      if (!resolved) {
        throw new FundingSourceError(
          `"${parsed.raw}" is neither the Trust Operating Account nor a Beneficiary Trust Account, so it cannot fund a payment`,
          'CLEARING_FUNDING_SOURCE_NOT_PERMITTED',
          409
        );
      }
    }

    if (!resolved.eligible) {
      throw new FundingSourceError(
        `${resolved.accountName} cannot fund this payment: ${resolved.ineligibleReason}`,
        'CLEARING_FUNDING_SOURCE_INELIGIBLE',
        409
      );
    }
    return resolved;
  },

  /** The debtor account an inbound file carries, when it is a permitted source. */
  async _declaredByAccountNumber(instruction, sources, config) {
    const accountNumber = instruction.debtor && instruction.debtor.accountNumber;
    if (!accountNumber) return null;
    try {
      const source = await this.resolve(accountNumber, { sources, config });
      return source.sourceKey;
    } catch (error) {
      if (error instanceof FundingSourceError) return null;
      throw error;
    }
  },

  /**
   * Which instruction is funded from which account, and whether the money is
   * there. Nothing is thrown for a bad instruction: every failure is collected
   * so a data workflow gets one answer for the whole file rather than one
   * rejection at a time. `apply` is the enforcing wrapper.
   */
  async plan(instructions, { fundingSource = null, requireBalance = null, config = null } = {}) {
    const settings = config || getFundingSourceConfig();
    const enforceBalance = requireBalance === null || requireBalance === undefined
      ? settings.requireBalance
      : Boolean(requireBalance);
    const sources = await this.list();

    const failures = [];
    const resolved = [];
    for (const [index, instruction] of instructions.entries()) {
      // A funding source is declared, not inferred from a bank account number:
      // an upstream file's debtor account is honoured only when it names one of
      // the trust's own permitted accounts, and is otherwise stale data from
      // whatever system produced the export rather than an instruction to draw
      // on some other account.
      const declared = fundingSource
        || instruction.fundingSourceRef
        || (instruction.fundingSource && instruction.fundingSource.sourceKey)
        || (await this._declaredByAccountNumber(instruction, sources, settings))
        || settings.defaultSource;
      try {
        const source = await this.resolve(declared, { sources, config: settings });
        resolved.push({ index, instruction, source, declared });
      } catch (error) {
        if (!(error instanceof FundingSourceError)) throw error;
        failures.push({
          instruction: instruction.reference || instruction.endToEndId || `instruction ${index + 1}`,
          field: 'fundingSource',
          declared,
          code: error.code,
          message: error.message,
        });
      }
    }

    // A source is checked against the whole file, not one instruction at a
    // time: three distributions that each fit the balance can still overdraw
    // the account together.
    const drawdown = new Map();
    for (const entry of resolved) {
      const current = drawdown.get(entry.source.sourceKey)
        || { source: entry.source, itemCount: 0, amountCents: 0, instructions: [] };
      current.itemCount += 1;
      current.amountCents += Number(entry.instruction.amountCents || 0);
      current.instructions.push(entry.instruction.reference || entry.instruction.endToEndId || `instruction ${entry.index + 1}`);
      drawdown.set(entry.source.sourceKey, current);
    }

    const draws = [...drawdown.values()].map(entry => {
      const shortfallCents = Math.max(0, entry.amountCents - entry.source.availableCents);
      return {
        sourceType: entry.source.sourceType,
        sourceKey: entry.source.sourceKey,
        sourceId: entry.source.sourceId,
        accountName: entry.source.accountName,
        beneficiary: entry.source.beneficiary,
        currency: entry.source.currency,
        itemCount: entry.itemCount,
        amountCents: entry.amountCents,
        amount: (entry.amountCents / 100).toFixed(2),
        availableCents: entry.source.availableCents,
        available: (entry.source.availableCents / 100).toFixed(2),
        shortfallCents,
        funded: shortfallCents === 0,
        instructions: entry.instructions,
      };
    });

    if (enforceBalance) {
      for (const draw of draws.filter(entry => !entry.funded)) {
        failures.push({
          instruction: draw.instructions.join(', '),
          field: 'fundingSource',
          declared: draw.sourceKey,
          code: 'CLEARING_FUNDING_SOURCE_INSUFFICIENT',
          message: `${draw.accountName} holds ${draw.available} and this file draws ${draw.amount} on it`,
        });
      }
    }

    return {
      sources: draws,
      failures,
      enforced: settings.enforce,
      balanceEnforced: enforceBalance,
      resolved,
    };
  },

  /**
   * Resolve, refuse what cannot be funded, and hand back the instructions the
   * bank file is rendered from — each carrying the account it draws on as its
   * debtor. This is what the clearing pipeline calls.
   */
  async apply(instructions, options = {}) {
    const config = options.config || getFundingSourceConfig();
    const plan = await this.plan(instructions, { ...options, config });

    if (plan.failures.length && config.enforce) {
      const first = plan.failures[0];
      throw new FundingSourceError(
        `The file cannot be funded: ${first.message}`,
        plan.failures.length === 1 ? first.code : 'CLEARING_FUNDING_UNFUNDABLE',
        409,
        { failures: plan.failures }
      );
    }

    const bySource = new Map(plan.resolved.map(entry => [entry.index, entry.source]));
    const funded = instructions.map((instruction, index) => {
      const source = bySource.get(index);
      if (!source) return instruction;
      return {
        ...instruction,
        debtor: {
          ...(instruction.debtor || {}),
          name: source.debtorName,
          accountNumber: source.debtorAccountNumber || (instruction.debtor && instruction.debtor.accountNumber) || null,
          routingNumber: source.debtorRouting || (instruction.debtor && instruction.debtor.routingNumber) || null,
        },
        fundingSource: {
          sourceType: source.sourceType,
          sourceKey: source.sourceKey,
          sourceId: source.sourceId,
          accountName: source.accountName,
          sourceOfTruth: source.sourceOfTruth,
          beneficiary: source.beneficiary,
        },
      };
    });

    return {
      instructions: funded,
      sources: plan.sources,
      failures: plan.failures,
      enforced: plan.enforced,
      balanceEnforced: plan.balanceEnforced,
    };
  },
};

module.exports = {
  FundingSourceRegistry,
  FundingSourceError,
  getFundingSourceConfig,
  describeOperating,
  describeBeneficiary,
  parseRef,
  TRUST_OPERATING,
  BENEFICIARY_TRUST,
};
