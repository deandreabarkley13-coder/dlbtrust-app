'use strict';

/**
 * LiveBaselineReset — replace the pre-production test books with a clean live
 * baseline as of the trust's start date.
 *
 * Everything the reset removes from the live tables is first copied verbatim
 * into `<table>_archive` (tagged with the run id), so no financial evidence is
 * lost and the archive can be inspected or restored. After the reset the local
 * trust journal contains only the baseline entries, the Fineract mirror is
 * rebuilt from it, and a `live_baseline_cutoff` is recorded so DataBridge
 * never re-syncs pre-baseline engine rows (test wires, ACH, bond schedules …).
 *
 * Model (BOND_ACCOUNTING_ROLE=issuer — the trust issued the bond):
 *   start date   Dr 1310 Subscription Receivable / Cr 2300 Bonds Payable      face
 *   start date   Dr 1000 Cash                     / Cr 1310                     real cash on hand
 *   each elapsed coupon period   Dr 5400 Interest Expense / Cr 2320 Coupons Payable
 *
 * Always dry-run by default; execution requires confirm: 'RESET_LIVE_BASELINE'.
 */

var pool = require('../bonds/pgPool');
var { DataBridge, ACCOUNTS, BOND_ROLE } = require('./dataBridge');

var CONFIRM_TOKEN = 'RESET_LIVE_BASELINE';

// Live tables whose rows are all pre-baseline evidence: copied to archive, then removed.
var ARCHIVE_ALL = ['trust_journal_lines', 'trust_journal_entries', 'cash_movements', 'coupon_payments'];

var PERIOD_MONTHS = { monthly: 1, quarterly: 3, 'semi-annual': 6, annual: 12 };

function round2(n) { return Math.round(n * 100) / 100; }

function isoDate(d) { return new Date(d).toISOString().slice(0, 10); }

function addMonths(date, months) {
  var d = new Date(date);
  var day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  var last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

class LiveBaselineReset {

  static config() {
    return {
      liveBondName: process.env.LIVE_BOND_NAME || 'DLB-PRB',
      liveCashAccountIds: (process.env.LIVE_CASH_ACCOUNTS || 'CA-OPERATING').split(',').map(function(s) { return s.trim(); }).filter(Boolean),
      cashTrustAccount: ACCOUNTS.CASH,
    };
  }

  /**
   * Build the plan: what would be archived, and the baseline entries that would
   * be posted. Read-only.
   */
  static async plan({ asOf } = {}) {
    var cfg = LiveBaselineReset.config();
    var asOfDate = asOf ? new Date(asOf) : new Date();
    if (isNaN(asOfDate.getTime())) throw new Error('Invalid asOf date');

    var bondRes = await pool.query(
      'SELECT id, bond_name, face_value, coupon_rate, payment_freq, issue_date, maturity_date, status FROM bonds WHERE bond_name = $1',
      [cfg.liveBondName]
    );
    if (bondRes.rows.length === 0) throw new Error('Live bond not found: ' + cfg.liveBondName);
    var bond = bondRes.rows[0];
    var face = parseFloat(bond.face_value);
    var rate = parseFloat(bond.coupon_rate);
    var months = PERIOD_MONTHS[bond.payment_freq];
    if (!months) throw new Error('Unsupported payment_freq: ' + bond.payment_freq);
    var startDate = new Date(bond.issue_date);

    var cashRes = await pool.query(
      'SELECT account_id, account_name, account_type, balance_cents, status FROM cash_accounts WHERE account_id = ANY($1::text[])',
      [cfg.liveCashAccountIds]
    );
    var realCash = cashRes.rows.map(function(r) {
      return { accountId: r.account_id, accountName: r.account_name, balance: parseInt(r.balance_cents, 10) / 100 };
    });
    var realCashTotal = round2(realCash.reduce(function(s, r) { return s + r.balance; }, 0));
    if (realCashTotal > face) throw new Error('Real cash exceeds bond face; subscription receivable would be negative');

    // Coupon periods come from the registered schedule (BondStatementEngine.registerCoupons)
    // so the baseline and future syncs share one reference id per period.
    var periodRows = await pool.query(
      `SELECT id, amount, transaction_date FROM bond_transactions
       WHERE bond_id = $1 AND transaction_type = 'coupon_accrual' AND transaction_date <= $2
       ORDER BY transaction_date ASC`,
      [bond.id, asOfDate]
    );
    var periods = periodRows.rows.map(function(r) {
      return { id: r.id, periodEnd: isoDate(r.transaction_date), amount: parseFloat(r.amount) };
    });
    var expectedPeriods = 0;
    for (var pe = addMonths(startDate, months); pe <= asOfDate; pe = addMonths(pe, months)) expectedPeriods++;
    var couponsPayableTotal = round2(periods.reduce(function(s, p) { return s + p.amount; }, 0));

    var entries = [
      {
        entryDate: isoDate(startDate), referenceType: 'opening_balance', referenceId: 'BOND-' + bond.id,
        description: 'Opening balance — Bond ' + bond.bond_name + ' issuance',
        lines: [
          { accountCode: ACCOUNTS.BOND_SUBSCRIPTION_RECEIVABLE, debit: face, credit: 0 },
          { accountCode: ACCOUNTS.BONDS_PAYABLE, debit: 0, credit: face },
        ],
      },
    ];
    realCash.forEach(function(rc) {
      if (rc.balance <= 0) return;
      entries.push({
        entryDate: isoDate(startDate), referenceType: 'opening_balance', referenceId: 'CASH-' + rc.accountId,
        description: 'Opening balance — ' + rc.accountName,
        lines: [
          { accountCode: cfg.cashTrustAccount, debit: rc.balance, credit: 0 },
          { accountCode: ACCOUNTS.BOND_SUBSCRIPTION_RECEIVABLE, debit: 0, credit: rc.balance },
        ],
      });
    });
    periods.forEach(function(p) {
      entries.push({
        entryDate: p.periodEnd, referenceType: 'coupon_period', referenceId: String(p.id),
        description: 'Coupon due — ' + bond.bond_name,
        lines: [
          { accountCode: ACCOUNTS.BOND_INTEREST_EXPENSE, debit: p.amount, credit: 0 },
          { accountCode: ACCOUNTS.COUPONS_PAYABLE, debit: 0, credit: p.amount },
        ],
      });
    });

    var archive = {};
    for (var i = 0; i < ARCHIVE_ALL.length; i++) {
      archive[ARCHIVE_ALL[i]] = await LiveBaselineReset._count(ARCHIVE_ALL[i]);
    }
    archive.bond_transactions = await LiveBaselineReset._count('bond_transactions');
    var retainedBondTxns = await pool.query(
      "SELECT COUNT(*) AS c FROM bond_transactions WHERE bond_id = $1 AND transaction_type IN ('issuance', 'coupon_accrual')", [bond.id]
    );
    var testBonds = await pool.query(
      "SELECT id, bond_name, face_value, status FROM bonds WHERE id <> $1 AND status = 'active' ORDER BY id", [bond.id]
    );
    var cashZero = await pool.query(
      'SELECT account_id, account_name, balance_cents FROM cash_accounts WHERE NOT (account_id = ANY($1::text[])) AND balance_cents <> 0 ORDER BY account_id',
      [cfg.liveCashAccountIds]
    );
    var trustBalances = await pool.query(
      'SELECT account_code, account_name, balance FROM trust_accounts WHERE ABS(balance) > 0.004 ORDER BY account_code'
    );
    var discrepancies = await pool.query('SELECT COUNT(*) AS c FROM data_bridge_discrepancies WHERE resolved = FALSE');
    var subLedgers = await pool.query(
      "SELECT sub_ledger_id, sub_account_name, parent_account_code, balance FROM client_sub_ledgers WHERE parent_account_code = $1 AND ABS(balance) > 0.004",
      [ACCOUNTS.BOND_INVESTMENTS]
    );

    return {
      bondRole: BOND_ROLE,
      asOf: isoDate(asOfDate),
      liveBond: {
        id: bond.id, name: bond.bond_name, faceValue: face, couponRate: rate,
        paymentFreq: bond.payment_freq, issueDate: isoDate(startDate), maturityDate: isoDate(bond.maturity_date),
      },
      realCash: realCash,
      realCashTotal: realCashTotal,
      subscriptionReceivable: round2(face - realCashTotal),
      couponPeriodsRegistered: periods.length,
      couponPeriodsExpected: expectedPeriods,
      couponsPayableTotal: couponsPayableTotal,
      baselineEntries: entries,
      archive: {
        rowCounts: archive,
        bondTransactionsRetained: parseInt(retainedBondTxns.rows[0].c, 10),
        testBondsToRetire: testBonds.rows.map(function(b) { return { id: b.id, name: b.bond_name, faceValue: parseFloat(b.face_value) }; }),
        cashAccountsToZero: cashZero.rows.map(function(c) { return { accountId: c.account_id, name: c.account_name, balance: parseInt(c.balance_cents, 10) / 100 }; }),
        trustAccountsToZero: trustBalances.rows.map(function(t) { return { code: t.account_code, name: t.account_name, balance: parseFloat(t.balance) }; }),
        openDiscrepanciesToResolve: parseInt(discrepancies.rows[0].c, 10),
        subLedgersToReparent: subLedgers.rows.map(function(s) {
          return { subLedgerId: s.sub_ledger_id, name: s.sub_account_name, from: s.parent_account_code, to: ACCOUNTS.BONDS_PAYABLE, balance: parseFloat(s.balance) };
        }),
      },
    };
  }

  static async run({ dryRun, confirm, asOf, performedBy } = {}) {
    var isDryRun = dryRun !== false || confirm !== CONFIRM_TOKEN;
    var runId = 'BASELINE-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    var plan = await LiveBaselineReset.plan({ asOf: asOf });

    if (BOND_ROLE !== 'issuer') {
      plan.warning = 'BOND_ACCOUNTING_ROLE is "' + BOND_ROLE + '"; the baseline posts issuer-side entries. Set BOND_ACCOUNTING_ROLE=issuer before executing.';
    }
    if (isDryRun) {
      return { runId: runId, mode: 'dry_run', plan: plan, note: 'Pass { dryRun: false, confirm: "' + CONFIRM_TOKEN + '" } to execute' };
    }
    if (BOND_ROLE !== 'issuer') throw new Error(plan.warning);

    var { TrustAccountingEngine } = require('./trustAccountingEngine');
    var startedAt = Date.now();
    var cutoff = new Date();
    var client = await pool.connect();
    var archived = {};
    try {
      await client.query('BEGIN');

      for (var i = 0; i < ARCHIVE_ALL.length; i++) {
        archived[ARCHIVE_ALL[i]] = await LiveBaselineReset._archiveRows(client, ARCHIVE_ALL[i], runId, 'TRUE', []);
      }
      archived.bond_transactions = await LiveBaselineReset._archiveRows(
        client, 'bond_transactions', runId,
        "NOT (bond_id = $2 AND transaction_type IN ('issuance', 'coupon_accrual'))", [plan.liveBond.id]
      );
      var testBondIds = plan.archive.testBondsToRetire.map(function(b) { return b.id; });
      if (testBondIds.length > 0) {
        await client.query("UPDATE bonds SET status = 'called', updated_at = NOW() WHERE id = ANY($1::int[])", [testBondIds]);
      }

      await client.query('UPDATE trust_accounts SET balance = 0, updated_at = NOW()');
      await client.query(
        'UPDATE cash_accounts SET balance_cents = 0, updated_at = NOW() WHERE NOT (account_id = ANY($1::text[]))',
        [LiveBaselineReset.config().liveCashAccountIds]
      );
      await client.query(
        `UPDATE data_bridge_discrepancies SET resolved = TRUE, resolution = $1, resolved_at = NOW() WHERE resolved = FALSE`,
        ['archived_by_live_baseline_reset ' + runId]
      );
      await client.query(
        'UPDATE client_sub_ledgers SET parent_account_code = $1, updated_at = NOW() WHERE parent_account_code = $2',
        [ACCOUNTS.BONDS_PAYABLE, ACCOUNTS.BOND_INVESTMENTS]
      );
      if (await LiveBaselineReset._tableExists(client, 'electronic_settlements')) {
        await client.query('UPDATE electronic_settlements SET data_bridge_synced = TRUE WHERE data_bridge_synced = FALSE');
      }
      if (await LiveBaselineReset._tableExists(client, 'wire_transfers')) {
        await client.query('UPDATE wire_transfers SET journal_entry_id = NULL WHERE journal_entry_id IS NOT NULL');
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await DataBridge.setLiveBaselineCutoff(cutoff, performedBy || 'live_baseline_reset');
    await DataBridge._ensureIssuerAccounts();

    var posted = [];
    for (var e = 0; e < plan.baselineEntries.length; e++) {
      var be = plan.baselineEntries[e];
      var je = await TrustAccountingEngine.postJournalEntry({
        entryDate: be.entryDate,
        description: be.description,
        lines: be.lines.map(function(l) { return { accountCode: l.accountCode, debitAmount: l.debit, creditAmount: l.credit, memo: be.description }; }),
        referenceType: be.referenceType,
        referenceId: be.referenceId,
        bondId: plan.liveBond.id,
        postedBy: performedBy || 'live_baseline_reset',
        postToFineract: false,
      });
      posted.push({ entryId: je.entry_id, referenceId: be.referenceId, entryDate: be.entryDate });
    }

    var fineract = await LiveBaselineReset._rebuildFineract();
    var integrity = await DataBridge.verifyTrustBalanceIntegrity();
    var balances = await pool.query('SELECT account_code, account_name, balance FROM trust_accounts WHERE ABS(balance) > 0.004 ORDER BY account_code');

    var summary = {
      runId: runId, mode: 'executed', durationMs: Date.now() - startedAt,
      cutoff: cutoff.toISOString(), archived: archived, posted: posted,
      fineract: fineract, integrity: integrity,
      balances: balances.rows.map(function(b) { return { code: b.account_code, name: b.account_name, balance: parseFloat(b.balance) }; }),
    };
    await DataBridge._logSync(runId, 'live_baseline_reset', 'all_engines', 'trust_accounting',
      posted.length, 0, fineract.error ? 1 : 0, { plan: plan, result: summary });
    return { plan: plan, result: summary };
  }

  static async _rebuildFineract() {
    try {
      await LiveBaselineReset._ensureFineractMappings();
      return await DataBridge.rebuildFineractMirror({ dryRun: false, confirm: 'REBUILD_FINERACT_MIRROR' });
    } catch (err) {
      return { error: err.message, note: 'Local baseline is posted; rerun POST /api/accounting/bridge/fineract/rebuild once Fineract is reachable' };
    }
  }

  /** Create Fineract GL accounts + trust_journal mappings for any trust account that lacks one. */
  static async _ensureFineractMappings() {
    var { FineractClient } = require('../fineract/fineractClient');
    var TYPE_MAP = { asset: 1, liability: 2, equity: 3, income: 4, expense: 5 };
    var unmapped = await pool.query(`
      SELECT ta.account_code, ta.account_name, ta.account_type, ta.sub_type
      FROM trust_accounts ta
      WHERE NOT EXISTS (
        SELECT 1 FROM fineract_gl_mappings m WHERE m.mapping_type = 'trust_journal' AND m.trust_account_code = ta.account_code
      )
      ORDER BY ta.account_code
    `);
    if (unmapped.rows.length === 0) return [];
    var existing = await FineractClient.getGLAccounts();
    var byCode = {};
    (Array.isArray(existing) ? existing : []).forEach(function(a) { byCode[a.glCode] = a.id; });
    var created = [];
    for (var i = 0; i < unmapped.rows.length; i++) {
      var acct = unmapped.rows[i];
      var glId = byCode[acct.account_code];
      if (!glId) {
        var res = await FineractClient.createGLAccount({
          name: acct.account_name, glCode: acct.account_code, type: TYPE_MAP[acct.account_type], usage: 1,
          description: 'Trust account: ' + acct.account_name + ' (' + (acct.sub_type || acct.account_type) + ')',
        });
        glId = res.resourceId || res.id;
      }
      await pool.query(
        `INSERT INTO fineract_gl_mappings (mapping_type, trust_account_code, fineract_gl_id, description)
         SELECT 'trust_journal', $1, $2, $3
         WHERE NOT EXISTS (SELECT 1 FROM fineract_gl_mappings WHERE mapping_type = 'trust_journal' AND trust_account_code = $1)`,
        [acct.account_code, glId, acct.account_name + ' (' + acct.account_type + ')']
      );
      created.push({ accountCode: acct.account_code, fineractGlId: glId });
    }
    return created;
  }

  /** Move rows matching whereSql ($2.. params) into <table>_archive tagged with runId ($1). */
  static async _archiveRows(client, table, runId, whereSql, params) {
    if (!/^[a-z_]+$/.test(table)) throw new Error('Invalid table name');
    var archiveTable = table + '_archive';
    await client.query(
      'CREATE TABLE IF NOT EXISTS ' + archiveTable + ' AS SELECT NULL::text AS archive_run_id, NOW() AS archived_at, t.* FROM ' + table + ' t WHERE FALSE'
    );
    var moved = await client.query(
      'WITH del AS (DELETE FROM ' + table + ' t WHERE ' + whereSql + ' RETURNING t.*) ' +
      'INSERT INTO ' + archiveTable + ' SELECT $1::text, NOW(), del.* FROM del',
      [runId].concat(params)
    );
    return moved.rowCount;
  }

  static async _count(table) {
    if (!/^[a-z_]+$/.test(table)) throw new Error('Invalid table name');
    var r = await pool.query('SELECT COUNT(*) AS c FROM ' + table);
    return parseInt(r.rows[0].c, 10);
  }

  static async _tableExists(client, tableName) {
    var result = await client.query('SELECT to_regclass($1) AS table_name', [tableName]);
    return Boolean(result.rows[0] && result.rows[0].table_name);
  }
}

module.exports = { LiveBaselineReset, CONFIRM_TOKEN };
