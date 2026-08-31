'use strict';

/**
 * Wealth Back Office OS — the family bank's operations floor
 *
 * Every duty of the in-house family bank already has an engine somewhere in
 * this tree: a general ledger, a cash ledger, a bank aggregator, a bond book, a
 * tax engine, a CRM, a calendar, a message store, a vendor payables desk and
 * Payer OS. What they did not have is one floor to stand on. An operator asking
 * "what does the family bank hold, who is owed, and what leaves today" had to
 * read nine answers in nine shapes and add them up by hand — which is how a
 * back office pays the same obligation twice.
 *
 * This engine is that floor. It does three things and refuses everything else:
 *
 *   • It reads. Each desk (treasury, core banking, bookkeeping, transactions,
 *     payouts, trust accounting, tax, fixed income, CRM, scheduling, messaging)
 *     is read through its own engine and normalised into one vocabulary —
 *     integer cents, ISO timestamps, a stated source of truth. `bookOfRecord`
 *     adds those desks into a single position for the family bank.
 *   • It queues. `creditQueue` unifies every obligation that is waiting on money
 *     leaving the trust — an approved vendor payable, an approved beneficiary
 *     distribution, a credit Payer OS already has in flight — into one list with
 *     one shape, so the same obligation is visible once and only once.
 *   • It hands off. `pushCredit` turns a queued obligation into a Payer OS
 *     disbursement and stops. It does not touch a rail, assemble a file or post
 *     a journal entry.
 *
 * The refusals are the design:
 *
 *   • Nothing here originates money. Rails, dual control, compliance screening
 *     and the ledger posting all stay in Payer OS; this engine cannot approve,
 *     send or settle, so a back-office login is not a payment credential.
 *   • Only credits. An obligation is queued only when it is the trust paying
 *     somebody. There is no entry point that collects, debits or invoices.
 *   • One obligation, one push. Every handoff is recorded against the
 *     originating record under a unique index, so a payable that already has a
 *     live disbursement is refused rather than paid a second time.
 *   • Counterparties stay an allowlist. A queued obligation carries no routing
 *     or account number; it names a Payer OS payee key, and if the obligation's
 *     counterparty is not registered there the push is refused. The back office
 *     cannot invent a destination.
 *   • A total is never quietly wrong. When a desk cannot be read, its error is
 *     reported and the roll-up is marked incomplete instead of silently
 *     omitting a desk and returning a number that looks authoritative.
 */

const pool = require('../bonds/pgPool');

const { PayerOsEngine, PayerOsError } = require('./payerOsEngine');
const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');
const { CashEngine } = require('../cash/cashEngine');
const { BondEngine } = require('../bonds/bondEngine');
const { TaxEngine } = require('../tax/taxEngine');
const { CrmEngine } = require('../crm/crmEngine');
const { CalendarEngine } = require('../calendar/calendarEngine');
const { MessagingEngine } = require('../messaging/messagingEngine');
const { CorporateTreasuryEngine } = require('../finops/corporateTreasuryEngine');
const { BankSyncEngine } = require('../finops/bankSyncEngine');
const { VendorEngine } = require('../vendors/vendorEngine');
const { DistributionRequestEngine } = require('../dapp/distributionRequestEngine');

class WealthBackOfficeError extends Error {
  constructor(message, code = 'WEALTH_OS_ERROR', status = 409) {
    super(message);
    this.name = 'WealthBackOfficeError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

/**
 * The desks the family bank runs, each named by the duty an operator is
 * accountable for and bound to the engine that owns the records. `sourceOfTruth`
 * is part of the report: two desks can quote cash and an operator has to know
 * which one the ledger will believe.
 */
const DESKS = {
  treasury: {
    desk: 'treasury',
    label: 'Treasury management',
    duties: ['liquidity position', 'cash pools and sweeps', 'liquidity forecast'],
    sourceOfTruth: 'corporate_treasury',
  },
  core_banking: {
    desk: 'core_banking',
    label: 'Core banking',
    duties: ['bank accounts and balances', 'internal cash accounts'],
    sourceOfTruth: 'bank_aggregator + cash_ledger',
  },
  bookkeeping: {
    desk: 'bookkeeping',
    label: 'Bookkeeping',
    duties: ['trial balance', 'journal entries', 'period close'],
    sourceOfTruth: 'trust_general_ledger',
  },
  trust_accounting: {
    desk: 'trust_accounting',
    label: 'Trust accounting',
    duties: ['balance sheet', 'income statement', 'fiduciary periods'],
    sourceOfTruth: 'trust_general_ledger',
  },
  transactions: {
    desk: 'transactions',
    label: 'Transactions',
    duties: ['cash movements', 'treasury transactions'],
    sourceOfTruth: 'cash_ledger',
  },
  payouts: {
    desk: 'payouts',
    label: 'Payouts',
    duties: ['credit pushes in flight', 'vendor payables', 'beneficiary distributions'],
    sourceOfTruth: 'payer_os',
  },
  tax: {
    desk: 'tax',
    label: 'Tax reporting',
    duties: ['1041 preparation', 'K-1 schedules', 'estimated payments'],
    sourceOfTruth: 'tax_engine',
  },
  fixed_income: {
    desk: 'fixed_income',
    label: 'Bond portfolio & fixed income',
    duties: ['carrying value', 'accrued interest', 'coupon and principal payments'],
    sourceOfTruth: 'bond_book',
  },
  crm: {
    desk: 'crm',
    label: 'Client relationships',
    duties: ['contacts and KYC', 'bond subscriptions', 'interaction history'],
    sourceOfTruth: 'crm',
  },
  scheduling: {
    desk: 'scheduling',
    label: 'Scheduling',
    duties: ['operational calendar', 'deadlines and reviews'],
    sourceOfTruth: 'calendar',
  },
  messaging: {
    desk: 'messaging',
    label: 'Messaging',
    duties: ['operator threads', 'notifications against a record'],
    sourceOfTruth: 'messaging',
  },
};

/**
 * How an obligation raised on another desk becomes a Payer OS push. The
 * disbursement type is a property of what is being paid, not of who asks: a
 * business the trust owes is a CCD vendor payout and a beneficiary is a PPD
 * direct deposit, and neither can borrow the other's rail.
 */
const CREDIT_ORIGINS = {
  vendor_payable: {
    origin: 'vendor_payable',
    disbursementType: 'vendor_payout',
    desk: 'payouts',
    table: 'vendor_payments',
    label: 'Approved vendor payable',
    pushableStatuses: ['approved'],
  },
  beneficiary_distribution: {
    origin: 'beneficiary_distribution',
    disbursementType: 'direct_deposit',
    desk: 'payouts',
    table: 'dapp_distribution_requests',
    label: 'Approved beneficiary distribution',
    pushableStatuses: ['approved'],
  },
};

/**
 * Which storage each desk needs before it can answer, and who owns it. Some
 * desks own their schema through an engine that can create it on demand; others
 * read tables that belong to a numbered migration and are applied by whoever
 * runs migrations. The distinction matters operationally: `initDesks` can
 * prepare the first kind and can only *report* the second, and a back office
 * that cannot tell the difference tells an operator to "just restart it" when
 * the real answer is "run this migration".
 */
const DESK_SCHEMA = {
  treasury: { engines: [['corporate_treasury', () => CorporateTreasuryEngine.ensureTables()]], tables: ['corporate_treasury_accounts'] },
  core_banking: { engines: [], tables: ['cash_accounts'], migration: 'migrate-postgres-full.sql' },
  bookkeeping: { engines: [], tables: ['trust_accounts', 'trust_journal_entries', 'trust_journal_lines'], migration: 'migrate-docs-accounting.sql' },
  trust_accounting: { engines: [], tables: ['trust_accounts', 'trust_periods'], migration: 'migrate-docs-accounting.sql' },
  transactions: { engines: [], tables: ['cash_movements'], migration: 'migrate-postgres-full.sql' },
  payouts: {
    engines: [
      ['payer_os', () => PayerOsEngine.ensureTables()],
      ['vendor_payables', () => VendorEngine.ensureTables()],
      ['beneficiary_distributions', () => DistributionRequestEngine.ensureTables()],
      ['wealth_credit_pushes', () => WealthBackOfficeEngine.ensureTables()],
    ],
    tables: ['payer_disbursements', 'vendor_payments', 'dapp_distribution_requests', 'wealth_credit_pushes'],
  },
  tax: { engines: [['tax_engine', () => TaxEngine.ensureTables()]], tables: ['trust_config', 'tax_returns_1041', 'k1_schedules'] },
  fixed_income: { engines: [], tables: ['bonds'], migration: 'migrate-postgres-full.sql' },
  crm: { engines: [], tables: ['crm_contacts'], migration: 'migrate-postgres-full.sql' },
  scheduling: { engines: [['calendar', () => CalendarEngine.ensureTables()]], tables: ['calendar_events'] },
  messaging: { engines: [['messaging', () => MessagingEngine.ensureTables()]], tables: ['message_threads'] },
};

// A push that is recorded against an obligation and has not reached a terminal
// state still speaks for that obligation's dollars.
const OPEN_PUSH_STATUSES = ['pending_approval', 'approved', 'sending', 'sent'];

// A Melio CSV export commits the trust's cash from the moment the file exists:
// anyone with portal access can import it, and the export already carries an
// approved maker-checker proposal and a posted payable. Until it settles, those
// dollars are spoken for on a rail the back office does not originate, so they
// belong in the queue and out of the pushable set.
const OPEN_MELIO_STATUSES = ['exported', 'emailed', 'submitted'];

// How long an export may sit in one manual state before the delay is the
// finding. Import is a same-day desk task; portal settlement takes ACH time.
const MELIO_STALE_DAYS = { awaiting_import: 2, awaiting_settlement: 5 };

function centsFromDollars(value) {
  return Math.round(Number(value || 0) * 100);
}

function dollars(cents) {
  return `$${(Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function daysSince(value) {
  if (!value) return null;
  const then = new Date(value);
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - then.getTime()) / 86400000));
}

function isoDay(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().split('T')[0];
}

/**
 * Read one desk without letting it take the report down with it. A back office
 * that cannot show the tax desk should still show the ledger, as long as it says
 * which desk it could not read.
 */
async function attempt(reader) {
  try {
    return { ok: true, data: await reader() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function tableExists(table) {
  const rows = await pool.query('SELECT to_regclass($1) AS oid', [table]);
  return !!rows.rows[0]?.oid;
}

const WealthBackOfficeEngine = {
  DESKS,
  DESK_SCHEMA,
  CREDIT_ORIGINS,
  OPEN_PUSH_STATUSES,
  OPEN_MELIO_STATUSES,
  WealthBackOfficeError,

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wealth_credit_pushes (
        push_id          TEXT PRIMARY KEY,
        origin           TEXT NOT NULL,
        origin_id        TEXT NOT NULL,
        disbursement_id  TEXT NOT NULL,
        disbursement_type TEXT NOT NULL,
        payee_key        TEXT NOT NULL,
        amount_cents     BIGINT NOT NULL CHECK (amount_cents > 0),
        currency         TEXT NOT NULL DEFAULT 'USD',
        memo             TEXT,
        pushed_by        TEXT NOT NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_wealth_credit_pushes_disbursement
         ON wealth_credit_pushes(disbursement_id)`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_wealth_credit_pushes_origin
         ON wealth_credit_pushes(origin, origin_id)`
    );
    return true;
  },

  /**
   * Open the floor: create the storage every desk that owns its own schema
   * needs, and state plainly which desks are still waiting on a migration
   * somebody has to run. Nothing here drops or rewrites data — each preparer is
   * the desk engine's own guarded `ensureTables` — so this is safe to run
   * against a populated database and is idempotent by construction.
   *
   * A desk is only `ready` when every table it reads is actually present, so a
   * preparer that succeeds while its tables are still missing is reported as
   * unprepared rather than as success.
   */
  async initDesks({ desk = null } = {}) {
    const wanted = desk ? [this.describeDesk(desk)] : Object.values(DESKS);
    const results = [];

    for (const spec of wanted) {
      const schema = DESK_SCHEMA[spec.desk] || { engines: [], tables: [] };
      const prepared = [];
      const failures = [];
      for (const [name, prepare] of schema.engines) {
        const result = await attempt(prepare);
        if (result.ok) prepared.push(name);
        else failures.push({ engine: name, error: result.error });
      }

      const missing = [];
      for (const table of schema.tables) {
        const present = await attempt(() => tableExists(table));
        if (!present.ok) failures.push({ engine: table, error: present.error });
        else if (!present.data) missing.push(table);
      }

      results.push({
        desk: spec.desk,
        label: spec.label,
        prepared,
        ownsSchema: schema.engines.length > 0,
        missingTables: missing,
        failures,
        ready: missing.length === 0 && failures.length === 0,
        action: missing.length === 0
          ? null
          : schema.migration
            ? `${missing.join(', ')} is owned by server/scripts/${schema.migration}; apply that migration to open this desk.`
            : `${missing.join(', ')} is still missing after the desk engine prepared its own schema.`,
      });
    }

    const notReady = results.filter(result => !result.ready);
    return {
      asOf: new Date().toISOString(),
      ready: notReady.length === 0,
      desks: results,
      actions: notReady.map(result => `${result.label}: ${result.action || result.failures.map(failure => `${failure.engine}: ${failure.error}`).join('; ')}`),
      note: 'Desks that own their schema were prepared in place; desks backed by a migration are reported, never migrated implicitly.',
    };
  },

  /** The floor plan: which duties this engine can report on, and from where. */
  desks() {
    return Object.values(DESKS).map(desk => ({ ...desk }));
  },

  describeDesk(desk) {
    const spec = DESKS[String(desk || '').trim().toLowerCase()];
    if (!spec) {
      throw new WealthBackOfficeError(
        `Unknown desk: ${desk}. The back office runs ${Object.keys(DESKS).join(', ')}.`,
        'WEALTH_OS_UNKNOWN_DESK',
        404
      );
    }
    return spec;
  },

  /**
   * One desk, read through the engine that owns it. Amounts are converted to
   * integer cents here so that a caller adding two desks together is never
   * adding a dollar float to a cent integer.
   */
  async deskReport(desk, options = {}) {
    const spec = this.describeDesk(desk);
    const limit = Math.min(200, Math.max(1, Number(options.limit) || 25));
    const asOfDate = options.asOfDate || null;
    const taxYear = Number(options.taxYear) || new Date().getFullYear();

    switch (spec.desk) {
      case 'treasury': {
        const [dashboard, forecast] = await Promise.all([
          attempt(() => CorporateTreasuryEngine.getDashboard()),
          attempt(() => CorporateTreasuryEngine.getLiquidityForecast({ days: Number(options.days) || 30 })),
        ]);
        return this._desk(spec, { dashboard, forecast });
      }
      case 'core_banking': {
        const [cash, bank] = await Promise.all([
          attempt(() => CashEngine.getPositionSummary()),
          attempt(() => BankSyncEngine.getCachedAccounts({})),
        ]);
        return this._desk(spec, {
          cash,
          bankAccounts: bank,
          cashCents: cash.ok ? Number(cash.data.grand_total_cents || 0) : null,
        });
      }
      case 'bookkeeping': {
        const [trialBalance, entries] = await Promise.all([
          attempt(() => TrustAccountingEngine.getTrialBalance({ asOfDate })),
          attempt(() => TrustAccountingEngine.listJournalEntries({ limit })),
        ]);
        return this._desk(spec, { trialBalance, recentEntries: entries });
      }
      case 'trust_accounting': {
        const [balanceSheet, income, periods] = await Promise.all([
          attempt(() => TrustAccountingEngine.getBalanceSheet({ asOfDate })),
          attempt(() => TrustAccountingEngine.getIncomeStatement({ fromDate: options.fromDate, toDate: options.toDate })),
          attempt(() => TrustAccountingEngine.listPeriods({})),
        ]);
        return this._desk(spec, { balanceSheet, incomeStatement: income, periods });
      }
      case 'transactions': {
        const [movements, treasury] = await Promise.all([
          attempt(() => CashEngine.getMovements({ limit })),
          attempt(() => CorporateTreasuryEngine.listTransactions({ limit })),
        ]);
        return this._desk(spec, { cashMovements: movements, treasuryTransactions: treasury });
      }
      case 'payouts': {
        const queue = await attempt(() => this.creditQueue({ limit }));
        return this._desk(spec, { creditQueue: queue });
      }
      case 'tax': {
        const dashboard = await attempt(() => TaxEngine.getDashboard(taxYear));
        return this._desk(spec, { taxYear, dashboard });
      }
      case 'fixed_income': {
        const portfolio = await attempt(() => this.fixedIncomePortfolio());
        return this._desk(spec, { portfolio });
      }
      case 'crm': {
        const [dashboard, contacts] = await Promise.all([
          attempt(() => CrmEngine.getDashboard()),
          attempt(() => CrmEngine.listContacts({ limit })),
        ]);
        return this._desk(spec, { dashboard, contacts });
      }
      case 'scheduling': {
        const events = await attempt(() => CalendarEngine.listEvents({ limit }));
        return this._desk(spec, { events });
      }
      case 'messaging': {
        const threads = await attempt(() => MessagingEngine.listThreads({ limit }));
        return this._desk(spec, { threads });
      }
      default:
        throw new WealthBackOfficeError(`Desk ${spec.desk} has no reader`, 'WEALTH_OS_NO_READER', 500);
    }
  },

  _desk(spec, sections) {
    const errors = [];
    const data = {};
    for (const [name, section] of Object.entries(sections)) {
      if (section && typeof section === 'object' && 'ok' in section) {
        if (section.ok) data[name] = section.data;
        else errors.push({ section: name, error: section.error });
      } else {
        data[name] = section;
      }
    }
    return {
      desk: spec.desk,
      label: spec.label,
      duties: spec.duties,
      sourceOfTruth: spec.sourceOfTruth,
      complete: errors.length === 0,
      errors,
      data,
      asOf: new Date().toISOString(),
    };
  },

  /**
   * The bond book as a portfolio rather than as a list of bonds: carrying value,
   * interest already earned and the interest that has accrued since the last
   * posting but has not reached the ledger yet. The last of those is the number
   * a fixed-income desk is judged on and the one no single bond row states.
   */
  async fixedIncomePortfolio() {
    const bonds = await BondEngine.listBonds();
    const positions = [];
    const totals = { principalCents: 0, accruedCents: 0, unpostedAccrualCents: 0, carryingCents: 0, interestPaidCents: 0 };

    for (const bond of bonds) {
      const dashboard = await attempt(() => BondEngine.getBondDashboard(bond.id));
      if (!dashboard.ok) {
        positions.push({ bondId: bond.id, bondName: bond.bond_name, error: dashboard.error });
        continue;
      }
      const balances = dashboard.data.balances;
      const position = {
        bondId: bond.id,
        bondName: dashboard.data.bond.bond_name,
        isin: dashboard.data.bond.isin,
        status: dashboard.data.bond.status,
        couponRate: dashboard.data.bond.coupon_rate,
        maturityDate: isoDay(dashboard.data.bond.maturity_date),
        principalCents: centsFromDollars(balances.principal_balance),
        accruedCents: centsFromDollars(balances.accrued_interest),
        unpostedAccrualCents: centsFromDollars(balances.pending_accrual),
        carryingCents: centsFromDollars(balances.total_current_value),
        interestPaidCents: centsFromDollars(balances.total_interest_paid),
        lastAccrualDate: isoDay(balances.last_accrual_date),
      };
      positions.push(position);
      totals.principalCents += position.principalCents;
      totals.accruedCents += position.accruedCents;
      totals.unpostedAccrualCents += position.unpostedAccrualCents;
      totals.carryingCents += position.carryingCents;
      totals.interestPaidCents += position.interestPaidCents;
    }

    return {
      bondCount: bonds.length,
      positions,
      totals: { ...totals, carrying: dollars(totals.carryingCents), unpostedAccrual: dollars(totals.unpostedAccrualCents) },
      complete: positions.every(position => !position.error),
      asOf: new Date().toISOString(),
    };
  },

  /**
   * What the family bank holds, in one number per line, from the desks that
   * actually own each figure: the general ledger states assets, liabilities and
   * equity; the cash ledger states spendable cash; the bond book states
   * carrying value. Cash is reported from both the ledger and the cash desk and
   * the difference between them is reported as drift rather than reconciled
   * away — a back office that hides its drift has stopped being one.
   */
  async bookOfRecord({ asOfDate = null, taxYear = null } = {}) {
    const [balanceSheet, cash, bonds, treasury, payouts, tax] = await Promise.all([
      attempt(() => TrustAccountingEngine.getBalanceSheet({ asOfDate })),
      attempt(() => CashEngine.getPositionSummary()),
      attempt(() => this.fixedIncomePortfolio()),
      attempt(() => CorporateTreasuryEngine.getDashboard()),
      attempt(() => this.creditQueue({ limit: 200 })),
      attempt(() => TaxEngine.getDashboard(Number(taxYear) || new Date().getFullYear())),
    ]);

    const errors = [];
    const push = (desk, result) => { if (!result.ok) errors.push({ desk, error: result.error }); };
    push('trust_accounting', balanceSheet);
    push('core_banking', cash);
    push('fixed_income', bonds);
    push('treasury', treasury);
    push('payouts', payouts);
    push('tax', tax);

    const glAssetsCents = balanceSheet.ok ? centsFromDollars(balanceSheet.data.total_assets) : null;
    const glLiabilitiesCents = balanceSheet.ok ? centsFromDollars(balanceSheet.data.total_liabilities) : null;
    const glEquityCents = balanceSheet.ok ? centsFromDollars(balanceSheet.data.total_equity) : null;
    const glCashCents = balanceSheet.ok ? this._ledgerCashCents(balanceSheet.data) : null;
    const cashLedgerCents = cash.ok ? Number(cash.data.grand_total_cents || 0) : null;
    const bondCarryingCents = bonds.ok ? bonds.data.totals.carryingCents : null;
    const committedCents = payouts.ok ? payouts.data.totals.openCents : null;

    return {
      asOf: new Date().toISOString(),
      asOfDate: asOfDate || new Date().toISOString().split('T')[0],
      complete: errors.length === 0,
      errors,
      position: {
        assetsCents: glAssetsCents,
        liabilitiesCents: glLiabilitiesCents,
        equityCents: glEquityCents,
        cashCents: cashLedgerCents,
        bondCarryingCents,
        committedToPayeesCents: committedCents,
        unencumberedCashCents: cashLedgerCents === null || committedCents === null
          ? null
          : cashLedgerCents - committedCents,
      },
      readable: {
        assets: glAssetsCents === null ? null : dollars(glAssetsCents),
        liabilities: glLiabilitiesCents === null ? null : dollars(glLiabilitiesCents),
        equity: glEquityCents === null ? null : dollars(glEquityCents),
        cash: cashLedgerCents === null ? null : dollars(cashLedgerCents),
        bonds: bondCarryingCents === null ? null : dollars(bondCarryingCents),
        committedToPayees: committedCents === null ? null : dollars(committedCents),
      },
      reconciliation: {
        ledgerCashCents: glCashCents,
        cashLedgerCents,
        driftCents: glCashCents === null || cashLedgerCents === null ? null : glCashCents - cashLedgerCents,
        reconciled: glCashCents !== null && cashLedgerCents !== null && glCashCents === cashLedgerCents,
        note: 'The general ledger and the cash ledger are kept separately; a non-zero drift is an unposted movement, not a rounding artefact.',
      },
      desks: {
        trust_accounting: balanceSheet.ok ? balanceSheet.data : null,
        core_banking: cash.ok ? cash.data : null,
        fixed_income: bonds.ok ? bonds.data.totals : null,
        treasury: treasury.ok ? treasury.data : null,
        payouts: payouts.ok ? payouts.data.totals : null,
        tax: tax.ok ? tax.data : null,
      },
    };
  },

  _ledgerCashCents(balanceSheet) {
    const cashAccounts = (balanceSheet.assets || []).filter(account => {
      const subType = String(account.sub_type || '').toLowerCase();
      return subType === 'cash' || subType === 'cash_equivalent' || subType === 'bank';
    });
    return cashAccounts.reduce((total, account) => total + centsFromDollars(account.balance), 0);
  },

  /**
   * Everything the family bank owes and has not yet pushed, in one shape. The
   * queue is the reason this engine exists: a vendor payable, a beneficiary
   * distribution and a credit already in flight are three tables with three
   * vocabularies, and paying an obligation twice is what happens when nobody
   * can see them side by side.
   *
   * A row is `pushable` only when its obligation is approved on its own desk,
   * has no live Payer OS push against it, and names a counterparty registered
   * in the Payer OS allowlist. Anything else is listed with its blockers, since
   * an obligation an operator cannot pay is exactly what the operator needs to
   * see.
   */
  async creditQueue({ limit = 100, origin = null } = {}) {
    await this.ensureTables();
    const cap = Math.min(500, Math.max(1, Number(limit) || 100));
    const wanted = origin ? [this._describeOrigin(origin)] : Object.values(CREDIT_ORIGINS);

    const errors = [];
    const melio = await attempt(() => this.melioExports({ limit: cap }));
    if (!melio.ok) errors.push({ origin: 'melio_export', error: melio.error });
    const openExports = melio.ok ? melio.data.items : [];

    // An obligation bound to a live clearing cycle is being netted with others
    // into one credit; pushing it on its own here would pay it twice.
    const claims = await attempt(() => this._clearingClaims());
    if (!claims.ok) errors.push({ origin: 'clearing_cycle', error: claims.error });
    const clearingClaims = claims.ok ? claims.data : new Map();

    const items = [];
    for (const spec of wanted) {
      const result = await attempt(() => this._queueFor(spec, cap, openExports, clearingClaims));
      if (result.ok) items.push(...result.data);
      else errors.push({ origin: spec.origin, error: result.error });
    }

    const inFlight = await attempt(() => PayerOsEngine.list({ limit: cap }));
    if (!inFlight.ok) errors.push({ origin: 'payer_disbursement', error: inFlight.error });
    const openPushes = inFlight.ok
      ? inFlight.data
        .filter(row => OPEN_PUSH_STATUSES.includes(row.status))
        .map(row => ({
          origin: 'payer_disbursement',
          originId: row.disbursement_id,
          desk: 'payouts',
          label: `Payer OS ${String(row.disbursement_type).replace(/_/g, ' ')}`,
          disbursementType: row.disbursement_type,
          payeeKey: row.payee_key,
          counterparty: row.payee_label || row.payee_name,
          amountCents: Number(row.amount_cents),
          amount: dollars(row.amount_cents),
          currency: row.currency,
          dueDate: null,
          status: row.status,
          pushable: false,
          blockers: [`Already originated as ${row.disbursement_id} (${row.status}); approve or settle it in Payer OS.`],
          disbursementId: row.disbursement_id,
        }))
      : [];

    const melioItems = openExports.map(row => ({
      origin: 'melio_export',
      originId: row.exportId,
      desk: 'payouts',
      label: 'Melio CSV export',
      disbursementType: 'melio_csv',
      payeeKey: null,
      counterparty: row.counterparty,
      amountCents: row.amountCents,
      amount: dollars(row.amountCents),
      currency: row.currency,
      dueDate: row.dueDate,
      status: row.status,
      pushable: false,
      blockers: [row.nextStep],
      disbursementId: null,
    }));

    const queue = [...items, ...openPushes, ...melioItems].sort((a, b) => {
      if (a.dueDate && b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return b.amountCents - a.amountCents;
    });

    const pushable = queue.filter(item => item.pushable);
    const totals = {
      count: queue.length,
      pushableCount: pushable.length,
      openCents: queue.reduce((total, item) => total + item.amountCents, 0),
      pushableCents: pushable.reduce((total, item) => total + item.amountCents, 0),
    };
    totals.open = dollars(totals.openCents);
    totals.pushable = dollars(totals.pushableCents);

    return { asOf: new Date().toISOString(), complete: errors.length === 0, errors, totals, items: queue };
  },

  _describeOrigin(origin) {
    const spec = CREDIT_ORIGINS[String(origin || '').trim().toLowerCase()];
    if (!spec) {
      throw new WealthBackOfficeError(
        `Unknown credit origin: ${origin}. The back office queues ${Object.keys(CREDIT_ORIGINS).join(', ')}.`,
        'WEALTH_OS_UNKNOWN_ORIGIN',
        404
      );
    }
    return spec;
  },

  /**
   * Every Melio CSV export the trust is still on the hook for, with the manual
   * step each one is waiting on. The back office cannot import a file or settle
   * a portal payment, so it reports the step rather than taking it.
   */
  async melioExports({ limit = 100 } = {}) {
    const cap = Math.min(500, Math.max(1, Number(limit) || 100));
    if (!(await tableExists('melio_payments'))) {
      return { asOf: new Date().toISOString(), totals: { count: 0, openCents: 0, open: dollars(0), staleCount: 0 }, items: [] };
    }
    const rows = await pool.query(
      `SELECT id, status, amount_cents, currency, created_at, updated_at,
              COALESCE(result->>'vendorName', vendor_id) AS vendor_name,
              result->>'fileName' AS file_name,
              result->>'portalSubmissionReference' AS portal_reference
         FROM melio_payments
        WHERE status = ANY($1::text[])
        ORDER BY created_at ASC
        LIMIT $2`,
      [OPEN_MELIO_STATUSES, cap]
    );

    const items = rows.rows.map(row => {
      const awaiting = row.status === 'submitted' ? 'awaiting_settlement' : 'awaiting_import';
      const ageDays = daysSince(row.updated_at || row.created_at);
      return {
        exportId: row.id,
        counterparty: row.vendor_name || null,
        amountCents: Number(row.amount_cents || 0),
        amount: dollars(row.amount_cents),
        currency: row.currency || 'USD',
        status: row.status,
        awaiting,
        ageDays,
        stale: ageDays !== null && ageDays >= MELIO_STALE_DAYS[awaiting],
        fileName: row.file_name || null,
        portalReference: row.portal_reference || null,
        exportedOn: isoDay(row.created_at),
        dueDate: null,
        nextStep: awaiting === 'awaiting_settlement'
          ? `Portal submission ${row.portal_reference || '(unreferenced)'} is awaiting settlement;`
            + ' mark it paid with the settlement reference once Melio reports completion.'
          : `Import ${row.file_name || 'the CSV file'} in the Melio Bills portal, then record the portal`
            + ' reference with mark-submitted. Until then no dollars have moved.',
      };
    });

    const openCents = items.reduce((total, item) => total + item.amountCents, 0);
    return {
      asOf: new Date().toISOString(),
      totals: {
        count: items.length,
        openCents,
        open: dollars(openCents),
        staleCount: items.filter(item => item.stale).length,
      },
      items,
    };
  },

  /**
   * An obligation the trust has already committed to a Melio export. Names are
   * matched exactly and the amount must agree, so this catches the same bill
   * queued twice rather than guessing that two payables to one vendor are one.
   */
  _melioCommitment(openExports, counterparty, amountCents) {
    const wanted = String(counterparty || '').trim().toLowerCase();
    if (!wanted || !amountCents) return null;
    return openExports.find(row =>
      String(row.counterparty || '').trim().toLowerCase() === wanted
      && row.amountCents === amountCents
    ) || null;
  },

  /**
   * Which obligations a live clearing cycle already owns. Required lazily for
   * the same reason the runbook does: the netting engine reads this queue.
   */
  async _clearingClaims() {
    const { ClearingNettingEngine } = require('./clearingNettingEngine');
    await ClearingNettingEngine.ensureTables();
    return ClearingNettingEngine._liveClaims();
  },

  async _queueFor(spec, limit, openExports = [], clearingClaims = new Map()) {
    if (!(await tableExists(spec.table))) return [];
    const rows = spec.origin === 'vendor_payable'
      ? (await pool.query(
        `SELECT p.payment_id, p.amount, p.currency, p.status, p.due_date, p.description,
                p.invoice_number, p.payment_method, v.vendor_name, v.vendor_id
           FROM vendor_payments p
           LEFT JOIN vendors v ON v.vendor_id = p.vendor_id
          WHERE p.status = ANY($1::text[])
          ORDER BY p.due_date NULLS LAST, p.created_at ASC
          LIMIT $2`,
        [spec.pushableStatuses, limit]
      )).rows.map(row => ({
        originId: row.payment_id,
        counterparty: row.vendor_name || row.vendor_id,
        amountCents: centsFromDollars(row.amount),
        currency: row.currency || 'USD',
        status: row.status,
        dueDate: isoDay(row.due_date),
        reference: row.invoice_number || row.description || null,
      }))
      : (await pool.query(
        `SELECT id, beneficiary_name, beneficiary_email, amount_cents, currency, status, memo, created_at
           FROM dapp_distribution_requests
          WHERE status = ANY($1::text[])
          ORDER BY created_at ASC
          LIMIT $2`,
        [spec.pushableStatuses, limit]
      )).rows.map(row => ({
        originId: row.id,
        counterparty: row.beneficiary_name || row.beneficiary_email,
        amountCents: Number(row.amount_cents || 0),
        currency: row.currency || 'USD',
        status: row.status,
        dueDate: null,
        reference: row.memo || null,
      }));

    const payees = await attempt(() => PayerOsEngine.payees(spec.disbursementType));
    const registry = payees.ok ? payees.data : [];
    const pushed = await this._pushesByOrigin(spec.origin, rows.map(row => row.originId));

    return rows.map(row => {
      const blockers = [];
      const existing = pushed.get(row.originId) || null;
      if (existing) {
        blockers.push(
          `${row.originId} already has Payer OS push ${existing.disbursement_id} (${existing.status || 'open'}); it cannot be pushed twice.`
        );
      }
      if (row.amountCents <= 0) {
        blockers.push('The obligation carries no positive amount, so there is nothing to credit.');
      }
      const claim = clearingClaims.get(`${spec.origin}:${row.originId}`) || null;
      if (claim) {
        blockers.push(
          `${row.originId} is bound to clearing cycle ${claim.cycle_id} (${claim.status});`
          + ' it will be credited as part of that cycle\'s net leg, so it cannot be pushed on its own.'
        );
      }
      const committed = this._melioCommitment(openExports, row.counterparty, row.amountCents);
      if (committed) {
        blockers.push(
          `Melio CSV export ${committed.exportId} (${committed.status}) already commits ${committed.amount}`
          + ` to ${row.counterparty}; settle or cancel that export before crediting this obligation over ACH.`
        );
      }
      const match = this._matchPayee(registry, row.counterparty);
      if (!payees.ok) {
        blockers.push(`Payer OS payees could not be read: ${payees.error}`);
      } else if (!match) {
        blockers.push(
          `${row.counterparty || 'the counterparty'} is not a registered ${spec.disbursementType} payee;`
          + ' register the account in PAYER_OS_PAYEES before it can be credited.'
        );
      }
      return {
        origin: spec.origin,
        originId: row.originId,
        desk: spec.desk,
        label: spec.label,
        disbursementType: spec.disbursementType,
        payeeKey: match ? match.key : null,
        counterparty: row.counterparty,
        amountCents: row.amountCents,
        amount: dollars(row.amountCents),
        currency: row.currency,
        dueDate: row.dueDate,
        reference: row.reference,
        status: row.status,
        pushable: blockers.length === 0,
        blockers,
        disbursementId: existing ? existing.disbursement_id : null,
      };
    });
  },

  /**
   * The obligation's counterparty against the Payer OS allowlist, by key first
   * and by registered payee name second. Matching is deliberately exact once
   * case and padding are removed: a fuzzy match here would let "ACME PLUMBING"
   * be paid on an invoice from "Acme Plumbing Holdings".
   */
  _matchPayee(registry, counterparty) {
    const wanted = String(counterparty || '').trim().toLowerCase();
    if (!wanted) return null;
    return registry.find(payee => String(payee.key || '').toLowerCase() === wanted)
      || registry.find(payee => String(payee.name || '').trim().toLowerCase() === wanted)
      || registry.find(payee => String(payee.label || '').trim().toLowerCase() === wanted)
      || null;
  },

  async _pushesByOrigin(origin, originIds) {
    const map = new Map();
    if (!originIds.length) return map;
    const rows = await pool.query(
      `SELECT p.origin_id, p.disbursement_id, d.status
         FROM wealth_credit_pushes p
         LEFT JOIN payer_disbursements d ON d.disbursement_id = p.disbursement_id
        WHERE p.origin = $1 AND p.origin_id = ANY($2::text[])`,
      [origin, originIds]
    );
    for (const row of rows.rows) {
      if (row.status && !OPEN_PUSH_STATUSES.includes(row.status)) continue;
      map.set(row.origin_id, row);
    }
    return map;
  },

  /**
   * Hand a queued obligation to Payer OS. This is the whole write surface of the
   * back office, and it deliberately stops at "raised": the disbursement comes
   * back `pending_approval`, so a second trustee still has to sign in Payer OS
   * before a file is built or a wire moves. The handoff is recorded first under
   * a unique index, so two operators pushing the same payable at the same moment
   * produce one disbursement and one refusal rather than two credits.
   */
  async pushCredit({ origin, originId, initiatedBy, payeeKey = null, memo = null, fundingSourceRef = null } = {}) {
    const spec = this._describeOrigin(origin);
    if (!initiatedBy) {
      throw new WealthBackOfficeError(
        'initiatedBy is required: a credit push is raised by a named trustee',
        'WEALTH_OS_NO_MAKER',
        400
      );
    }
    await this.ensureTables();

    const queue = await this.creditQueue({ origin: spec.origin, limit: 500 });
    const item = queue.items.find(row => row.origin === spec.origin && row.originId === String(originId));
    if (!item) {
      throw new WealthBackOfficeError(
        `${spec.label} ${originId} is not awaiting a credit push`
        + ` (it must be ${spec.pushableStatuses.join(' or ')} on its own desk first)`,
        'WEALTH_OS_NOT_QUEUED',
        404
      );
    }
    const resolvedPayee = payeeKey ? String(payeeKey).trim() : item.payeeKey;
    const blockers = item.blockers.filter(blocker => !(payeeKey && blocker.includes('not a registered')));
    if (blockers.length) {
      throw new WealthBackOfficeError(
        `${spec.label} ${item.originId} cannot be pushed: ${blockers.join(' ')}`,
        'WEALTH_OS_BLOCKED',
        409
      );
    }
    if (!resolvedPayee) {
      throw new WealthBackOfficeError(
        `No registered ${spec.disbursementType} payee resolves for ${item.counterparty}`,
        'WEALTH_OS_NO_PAYEE',
        409
      );
    }

    const { disbursement, plan, wire } = await PayerOsEngine.initiate({
      disbursementType: spec.disbursementType,
      amountCents: item.amountCents,
      payee: resolvedPayee,
      fundingSourceRef,
      initiatedBy,
      memo: memo || `${spec.label} ${item.originId}${item.reference ? ` — ${item.reference}` : ''}`,
    });

    try {
      await pool.query(
        `INSERT INTO wealth_credit_pushes
           (push_id, origin, origin_id, disbursement_id, disbursement_type, payee_key, amount_cents, currency, memo, pushed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          `WBO-${disbursement.disbursement_id}`,
          spec.origin,
          item.originId,
          disbursement.disbursement_id,
          spec.disbursementType,
          resolvedPayee,
          item.amountCents,
          item.currency || 'USD',
          memo || null,
          initiatedBy,
        ]
      );
    } catch (error) {
      await PayerOsEngine.cancel(disbursement.disbursement_id, initiatedBy).catch(() => null);
      throw new WealthBackOfficeError(
        `The handoff for ${item.originId} could not be recorded, so the push was cancelled rather than left unlinked: ${error.message}`,
        'WEALTH_OS_HANDOFF_UNRECORDED',
        409
      );
    }

    await MessagingEngine.notify({
      subject: `Credit push raised: ${item.counterparty} ${item.amount}`,
      body: `${spec.label} ${item.originId} was handed to Payer OS as ${disbursement.disbursement_id}`
        + ` (${spec.disbursementType}, ${item.amount} to ${resolvedPayee}). It is pending a second trustee's approval.`,
      participants: [initiatedBy],
      referenceType: 'wealth_credit_push',
      referenceId: disbursement.disbursement_id,
      sender: initiatedBy,
    }).catch(() => null);

    return {
      origin: spec.origin,
      originId: item.originId,
      disbursement,
      plan: plan || null,
      wire: wire || null,
      awaiting: 'A second trustee must approve this push in Payer OS before anything is originated.',
    };
  },

  /** Every handoff this engine has made, newest first. */
  async pushes({ origin = null, limit = 50 } = {}) {
    await this.ensureTables();
    const rows = await pool.query(
      `SELECT p.*, d.status AS disbursement_status, d.settled_at, d.settlement_reference
         FROM wealth_credit_pushes p
         LEFT JOIN payer_disbursements d ON d.disbursement_id = p.disbursement_id
        WHERE ($1::text IS NULL OR p.origin = $1)
        ORDER BY p.created_at DESC
        LIMIT $2`,
      [origin ? this._describeOrigin(origin).origin : null, Math.min(500, Math.max(1, Number(limit) || 50))]
    );
    return rows.rows;
  },

  /**
   * One client, across every desk that holds something of theirs: the CRM
   * record, their bond subscriptions, what the trust has distributed to them,
   * their open obligations, their scheduled dates and their message threads.
   */
  async client(contactId, { limit = 25 } = {}) {
    const contact = await CrmEngine.getContact(contactId);
    if (!contact) {
      throw new WealthBackOfficeError(`Contact not found: ${contactId}`, 'WEALTH_OS_NOT_FOUND', 404);
    }
    const [subscriptions, interactions, events, threads, distributions] = await Promise.all([
      attempt(() => CrmEngine.getBondSubscriptions({ contactId })),
      attempt(() => CrmEngine.getInteractions(contactId, { limit })),
      attempt(() => CalendarEngine.listEvents({ referenceId: contactId, limit })),
      attempt(() => MessagingEngine.listThreads({ referenceId: contactId, limit })),
      attempt(() => this._clientDistributions(contact, limit)),
    ]);

    const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.company;
    const report = this._desk(
      { ...DESKS.crm, label: `Client — ${name || contact.contact_id}` },
      { contact, subscriptions, interactions, events, threads, distributions }
    );
    return { ...report, contactId: contact.contact_id };
  },

  async _clientDistributions(contact, limit) {
    if (!(await tableExists('dapp_distribution_requests'))) return [];
    const rows = await pool.query(
      `SELECT id, amount_cents, currency, status, memo, created_at
         FROM dapp_distribution_requests
        WHERE beneficiary_id = $1
           OR ($2::text IS NOT NULL AND LOWER(beneficiary_email) = LOWER($2))
        ORDER BY created_at DESC
        LIMIT $3`,
      [contact.contact_id, contact.email || null, Math.min(200, Math.max(1, Number(limit) || 25))]
    );
    return rows.rows;
  },

  /** Put a duty on the operational calendar. */
  async scheduleDuty({ desk, duty, dueAt, description = null, attendees = [], referenceId = null, createdBy } = {}) {
    const spec = this.describeDesk(desk);
    if (!duty) throw new WealthBackOfficeError('duty is required', 'WEALTH_OS_BAD_REQUEST', 400);
    if (!dueAt) throw new WealthBackOfficeError('dueAt is required', 'WEALTH_OS_BAD_REQUEST', 400);
    return CalendarEngine.createEvent({
      title: `${spec.label}: ${duty}`,
      description,
      start: dueAt,
      eventType: 'deadline',
      relatedModule: 'wealth_back_office',
      referenceId,
      attendees,
      createdBy: createdBy || null,
      metadata: { desk: spec.desk, duty },
    });
  },

  /** Raise an operator thread against a record, on the record's own desk. */
  async postNote({ desk, subject, body, participants = [], referenceId = null, sender } = {}) {
    const spec = this.describeDesk(desk);
    if (!subject || !body) {
      throw new WealthBackOfficeError('subject and body are required', 'WEALTH_OS_BAD_REQUEST', 400);
    }
    return MessagingEngine.notify({
      subject,
      body,
      participants,
      referenceType: `wealth_back_office:${spec.desk}`,
      referenceId,
      sender: sender || 'wealth_back_office',
    });
  },

  /**
   * The day's work, as duties rather than as data: what is owed, what is
   * unposted, what is out of balance, what is unreconciled and what falls due.
   * Each finding names the desk that has to clear it, because an item nobody
   * owns does not get cleared.
   */
  async runbook({ asOfDate = null, taxYear = null } = {}) {
    const year = Number(taxYear) || new Date().getFullYear();
    const [book, bonds, periods, tax, events, melio] = await Promise.all([
      attempt(() => this.bookOfRecord({ asOfDate, taxYear: year })),
      attempt(() => this.fixedIncomePortfolio()),
      attempt(() => TrustAccountingEngine.listPeriods({ status: 'open' })),
      attempt(() => TaxEngine.getDashboard(year)),
      attempt(() => CalendarEngine.listEvents({ start: new Date(), limit: 50 })),
      attempt(() => this.melioExports({ limit: 500 })),
    ]);

    const findings = [];
    const note = (desk, severity, finding, detail = {}) => findings.push({ desk, severity, finding, ...detail });

    if (book.ok) {
      const queue = book.data.desks.payouts;
      if (queue && queue.pushableCount) {
        note('payouts', 'action', `${queue.pushableCount} obligation(s) totalling ${queue.pushable} are approved and awaiting a credit push.`);
      }
      if (book.data.reconciliation.driftCents) {
        note('bookkeeping', 'break', `The general ledger and the cash ledger disagree by ${dollars(Math.abs(book.data.reconciliation.driftCents))}; a cash movement has not been posted.`);
      }
      if (book.data.desks.trust_accounting && book.data.desks.trust_accounting.is_balanced === false) {
        note('trust_accounting', 'break', 'The balance sheet does not balance: assets do not equal liabilities plus equity.');
      }
      const unencumbered = book.data.position.unencumberedCashCents;
      if (unencumbered !== null && unencumbered < 0) {
        note('treasury', 'break', `Committed pushes exceed cash on hand by ${dollars(Math.abs(unencumbered))}; fund the account before approving further credits.`);
      }
      for (const error of book.data.errors) {
        note(error.desk, 'unreadable', error.error);
      }
    } else {
      note('trust_accounting', 'unreadable', book.error);
    }

    if (!melio.ok) {
      note('payouts', 'unreadable', `Melio CSV exports could not be read: ${melio.error}`);
    } else if (melio.data.totals.count) {
      const awaitingImport = melio.data.items.filter(item => item.awaiting === 'awaiting_import');
      const awaitingSettlement = melio.data.items.filter(item => item.awaiting === 'awaiting_settlement');
      if (awaitingImport.length) {
        note('payouts', 'action', `${awaitingImport.length} Melio CSV export(s) totalling ${dollars(awaitingImport.reduce((total, item) => total + item.amountCents, 0))} are waiting to be imported in the Bills portal.`);
      }
      if (awaitingSettlement.length) {
        note('payouts', 'action', `${awaitingSettlement.length} Melio portal submission(s) totalling ${dollars(awaitingSettlement.reduce((total, item) => total + item.amountCents, 0))} are awaiting settlement.`);
      }
      for (const item of melio.data.items.filter(item => item.stale)) {
        note('payouts', 'break', `Melio export ${item.exportId} for ${item.amount} to ${item.counterparty || 'an unnamed payee'} has been ${item.awaiting.replace('_', ' ')} for ${item.ageDays} day(s); the payable is posted but the credit has not been confirmed.`);
      }
    }

    // Clearing is required lazily: the netting engine reads this engine's queue,
    // so importing it at module scope would make the cycle of requires depend on
    // which of the two an entry point happened to load first.
    const clearing = await attempt(() => require('./clearingNettingEngine').ClearingNettingEngine.runbook({ limit: 50 }));
    if (!clearing.ok) {
      note('payouts', 'unreadable', `Clearing cycles could not be read: ${clearing.error}`);
    } else {
      for (const action of clearing.data.actions) note('payouts', 'action', action);
      for (const item of clearing.data.breaks) note('payouts', 'break', item);
    }

    if (bonds.ok && bonds.data.totals.unpostedAccrualCents > 0) {
      note('fixed_income', 'action', `${dollars(bonds.data.totals.unpostedAccrualCents)} of bond interest has accrued since the last posting and is not in the ledger.`);
    }
    if (periods.ok && periods.data.length) {
      note('bookkeeping', 'action', `${periods.data.length} accounting period(s) are still open.`);
    }
    if (tax.ok && !tax.data.latest_return) {
      note('tax', 'action', `No Form 1041 has been prepared for ${year}.`);
    }
    if (events.ok) {
      const soon = events.data.filter(event => {
        const start = new Date(event.start_time);
        return start >= new Date() && start <= new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      });
      if (soon.length) note('scheduling', 'upcoming', `${soon.length} scheduled item(s) fall due within seven days.`);
    }

    return {
      asOf: new Date().toISOString(),
      taxYear: year,
      breaks: findings.filter(finding => finding.severity === 'break').length,
      actions: findings.filter(finding => finding.severity === 'action').length,
      findings,
      clean: findings.length === 0,
    };
  },

  /**
   * Whether the back office can do its job, desk by desk, and where it stops if
   * not. The credit path is reported separately from the reading path: the desks
   * can be perfectly readable while no credit can leave, and an operator needs
   * to know which of those two situations they are in.
   */
  async readiness() {
    const schema = await attempt(() => this.initDesks({}));
    const desks = [];
    for (const spec of Object.values(DESKS)) {
      const result = await attempt(() => this.deskReport(spec.desk, { limit: 1 }));
      desks.push({
        desk: spec.desk,
        label: spec.label,
        readable: result.ok && result.data.complete,
        issues: result.ok ? result.data.errors.map(error => `${error.section}: ${error.error}`) : [result.error],
      });
    }

    const payer = await attempt(() => PayerOsEngine.readiness());
    const blockers = [];
    if (!payer.ok) blockers.push(`Payer OS readiness could not be read: ${payer.error}`);
    else if (!payer.data.ready) blockers.push(...payer.data.blockers);

    const unreadable = desks.filter(desk => !desk.readable);
    return {
      ready: blockers.length === 0 && unreadable.length === 0,
      canPushCredits: payer.ok && payer.data.ready,
      desks,
      warnings: unreadable.map(desk => `${desk.label} is not fully readable: ${desk.issues.join('; ')}`),
      blockers,
      schema: schema.ok ? schema.data : { ready: false, actions: [schema.error] },
      payerOs: payer.ok
        ? { ready: payer.data.ready, originates: payer.data.originates, fundingSource: payer.data.fundingSource }
        : null,
      note: 'The back office reads every desk and hands credits to Payer OS; it never originates a payment itself,'
        + ' so a back-office session cannot approve, transmit or settle one.',
    };
  },
};

module.exports = {
  WealthBackOfficeEngine,
  WealthBackOfficeError,
  DESKS,
  DESK_SCHEMA,
  CREDIT_ORIGINS,
  OPEN_PUSH_STATUSES,
  OPEN_MELIO_STATUSES,
  PayerOsError,
};
