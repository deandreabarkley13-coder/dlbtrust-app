/**
 * Bond Issuance Engine — issuer -> holder fixed-income pipeline of record.
 *
 *   issuer  = INCOME_OBLIGOR_* (DEANDREA LAVAR BARKLEY TRUST COMPANY, custodian/issuer)
 *   holder  = TRUST_HOLDER_*   (DeAndrea Lavar Barkley Irrevocable Trust)
 *
 * The trust operates as a family financial institution: the holder's Fineract
 * savings account is the account of record and income is HELD there. A bank is
 * only a warehouse — converting a held payment to fiat (Stripe balance -> Lili
 * direct deposit) is an explicit, optional step.
 *
 *   payDue:      Fineract withdrawal (issuer) -> deposit (holder)
 *                GL: issuer Cr 2320 / Dr 2310|5100, Dr 2320 / Cr 1000 ; holder Dr 1020 / Cr 1200|4100
 *                => status 'held'
 *   sendToBank:  plans the held 1020 journal as fixed-income distributions to the
 *                settlement bank (maker/checker execute via /api/fixed-income) => 'sent_to_bank'
 *   fundExternal: optional Stripe income intake keyed to the payment when external
 *                dollars must be brought in first => 'awaiting_external_funds' -> 'funded' (webhook)
 */

const pool = require('./pgPool');
const { FineractClient } = require('../fineract/fineractClient');
const { LiveBondEngine } = require('./liveEngine');
const { DataBridge } = require('../accounting/dataBridge');

let StripePaymentIntakeEngine = null;
try { ({ StripePaymentIntakeEngine } = require('../payments/stripePaymentIntakeEngine')); } catch (e) { StripePaymentIntakeEngine = null; }
let FixedIncomeDistributionEngine = null;
try { ({ FixedIncomeDistributionEngine } = require('../os/fixedIncomeDistributionEngine')); } catch (e) { FixedIncomeDistributionEngine = null; }

const ROLES = ['issuer', 'holder'];
const KINDS = ['coupon', 'principal'];

function httpError(message, status, code, details) { return Object.assign(new Error(message), { status, code, details }); }
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function isoDate(d) { return new Date(d).toISOString().slice(0, 10); }
function splitName(name) {
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return { firstName: parts.slice(0, -1).join(' ').slice(0, 50), lastName: parts[parts.length - 1].slice(0, 50) };
}
function paymentId() { return `BIP-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`; }

class BondIssuanceEngine {
  static getConfig() {
    const env = process.env;
    return {
      enabled: String(env.BOND_ISSUANCE_ENABLED || 'true').toLowerCase() !== 'false',
      savingsProductId: env.FINERACT_SAVINGS_PRODUCT_ID ? Number(env.FINERACT_SAVINGS_PRODUCT_ID) : null,
      savingsProductName: env.FINERACT_SAVINGS_PRODUCT_NAME || 'Trust Account of Record (USD)',
      paymentTypeName: env.FINERACT_PAYMENT_TYPE_NAME || 'Ledger Transfer',
      autoIntake: String(env.BOND_ISSUANCE_AUTO_INTAKE || 'false').toLowerCase() === 'true',
      parties: {
        issuer: {
          role: 'issuer',
          externalId: `issuer:${env.INCOME_OBLIGOR_PAYER_ID || 'income-obligor'}`,
          name: env.INCOME_OBLIGOR_NAME || null,
          email: env.INCOME_OBLIGOR_EMAIL || null,
          ein: env.INCOME_OBLIGOR_EIN ? String(env.INCOME_OBLIGOR_EIN).replace(/\D/g, '') : null,
        },
        holder: {
          role: 'holder',
          externalId: `holder:${env.TRUST_HOLDER_ID || 'dlb-irrevocable-trust'}`,
          name: env.TRUST_HOLDER_NAME || 'DeAndrea Lavar Barkley Irrevocable Trust',
          email: env.TRUST_HOLDER_EMAIL || env.INCOME_OBLIGOR_EMAIL || null,
          ein: env.TRUST_HOLDER_EIN ? String(env.TRUST_HOLDER_EIN).replace(/\D/g, '') : null,
        },
      },
    };
  }

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bond_issuance_parties (
        role TEXT PRIMARY KEY CHECK (role IN ('issuer','holder')),
        external_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        fineract_client_id BIGINT,
        fineract_account_id BIGINT,
        fineract_account_no TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bond_issuances (
        bond_id INTEGER PRIMARY KEY REFERENCES bonds(id),
        issuer_external_id TEXT NOT NULL,
        holder_external_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','matured','cancelled')),
        issued_by TEXT,
        issued_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bond_issuance_payments (
        payment_id TEXT PRIMARY KEY,
        bond_id INTEGER NOT NULL REFERENCES bonds(id),
        kind TEXT NOT NULL CHECK (kind IN ('coupon','principal')),
        period_date DATE NOT NULL,
        amount_usd NUMERIC(18,2) NOT NULL,
        status TEXT NOT NULL DEFAULT 'held'
          CHECK (status IN ('held','sent_to_bank','awaiting_external_funds','funded','failed')),
        fineract_withdrawal_id TEXT,
        fineract_deposit_id TEXT,
        issuer_entry_ids TEXT[],
        holder_entry_id TEXT,
        intake_id TEXT,
        error_message TEXT,
        initiated_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (bond_id, kind, period_date)
      )`);
  }

  // ── parties ───────────────────────────────────────────────────────────────

  static async _findClient(externalId) {
    const r = await FineractClient.findClientByExternalId(externalId);
    return r || null;
  }

  static async _findSavings(externalId) {
    const r = await FineractClient.findSavingsAccountByExternalId(externalId);
    return r || null;
  }

  /** Savings product the party accounts are opened under: FINERACT_SAVINGS_PRODUCT_ID, else lookup/create by name. */
  static async ensureSavingsProduct() {
    const cfg = this.getConfig();
    const products = await FineractClient.listSavingsProducts();
    if (cfg.savingsProductId) {
      const byId = products.find((p) => Number(p.id) === cfg.savingsProductId);
      if (!byId) throw httpError(`Fineract savings product ${cfg.savingsProductId} (FINERACT_SAVINGS_PRODUCT_ID) not found`, 503, 'SAVINGS_PRODUCT_NOT_FOUND');
      return byId;
    }
    const byName = products.find((p) => p.name === cfg.savingsProductName);
    if (byName) return byName;
    const created = await FineractClient.createSavingsProduct({ name: cfg.savingsProductName, shortName: 'TAOR' });
    return { id: created.resourceId || created.id, name: cfg.savingsProductName };
  }

  /** Payment type stamped on issuer->holder Fineract transactions (lookup/create by name). */
  static async ensurePaymentType() {
    const cfg = this.getConfig();
    const types = await FineractClient.listPaymentTypes();
    const found = types.find((t) => t.name === cfg.paymentTypeName);
    if (found) return Number(found.id);
    const created = await FineractClient.createPaymentType({ name: cfg.paymentTypeName, description: 'Internal ledger transfer between trust accounts of record' });
    return Number(created.resourceId || created.id);
  }

  /** Create/lookup the Fineract client + active savings account for one party. Idempotent. */
  static async ensureParty(role) {
    if (!ROLES.includes(role)) throw httpError(`unknown party role '${role}'`, 400);
    const cfg = this.getConfig();
    const p = cfg.parties[role];
    if (!p.name) throw httpError(`${role} party not configured (${role === 'issuer' ? 'INCOME_OBLIGOR_NAME' : 'TRUST_HOLDER_NAME'})`, 503, 'PARTY_NOT_CONFIGURED');
    await this.ensureTables();

    let client = await this._findClient(p.externalId);
    if (!client) {
      const { firstName, lastName } = splitName(p.name);
      client = await FineractClient.createClient({ firstName, lastName, externalId: p.externalId, email: p.email });
      client = { id: client.clientId || client.resourceId || client.id, externalId: p.externalId };
    }
    const clientId = Number(client.id);

    const acctExternalId = `${p.externalId}:savings`;
    let account = await this._findSavings(acctExternalId);
    if (!account) {
      const product = await this.ensureSavingsProduct();
      const created = await FineractClient.createSavingsAccount({ clientId, productId: Number(product.id), externalId: acctExternalId });
      const accountId = created.savingsId || created.resourceId || created.id;
      await FineractClient.commandSavingsAccount(accountId, 'approve');
      await FineractClient.commandSavingsAccount(accountId, 'activate');
      account = await FineractClient.getAccountBalance(accountId);
    } else if (account.status && account.status.submittedAndPendingApproval) {
      await FineractClient.commandSavingsAccount(account.id, 'approve');
      await FineractClient.commandSavingsAccount(account.id, 'activate');
      account = await FineractClient.getAccountBalance(account.id);
    } else if (account.status && account.status.approved && !account.status.active) {
      await FineractClient.commandSavingsAccount(account.id, 'activate');
      account = await FineractClient.getAccountBalance(account.id);
    }

    await pool.query(`
      INSERT INTO bond_issuance_parties (role, external_id, name, fineract_client_id, fineract_account_id, fineract_account_no)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (role) DO UPDATE SET external_id = EXCLUDED.external_id, name = EXCLUDED.name,
        fineract_client_id = EXCLUDED.fineract_client_id, fineract_account_id = EXCLUDED.fineract_account_id,
        fineract_account_no = EXCLUDED.fineract_account_no, updated_at = NOW()`,
    [role, p.externalId, p.name, clientId, Number(account.id), account.accountNo || null]);

    return this._partyView(role, p, { clientId, account });
  }

  static _partyView(role, p, { clientId, account }) {
    const summary = account && account.summary ? account.summary : {};
    return {
      role,
      name: p.name,
      externalId: p.externalId,
      einMasked: p.ein && p.ein.length === 9 ? `**-***${p.ein.slice(-4)}` : null,
      fineract: {
        clientId,
        accountId: account ? Number(account.id) : null,
        accountNo: account ? account.accountNo || null : null,
        active: Boolean(account && account.status && account.status.active),
        balanceUsd: summary.accountBalance != null ? Number(summary.accountBalance) : null,
        availableUsd: summary.availableBalance != null ? Number(summary.availableBalance) : null,
      },
    };
  }

  static async ensureParties() {
    const issuer = await this.ensureParty('issuer');
    const holder = await this.ensureParty('holder');
    return { issuer, holder };
  }

  static async parties({ live = false } = {}) {
    await this.ensureTables();
    const cfg = this.getConfig();
    const { rows } = await pool.query('SELECT * FROM bond_issuance_parties');
    const out = {};
    for (const role of ROLES) {
      const p = cfg.parties[role];
      const row = rows.find((r) => r.role === role);
      if (!row) { out[role] = { role, name: p.name, externalId: p.externalId, configured: Boolean(p.name), fineract: null }; continue; }
      let account = null;
      if (live) {
        try { account = await FineractClient.getAccountBalance(row.fineract_account_id); } catch (e) { account = null; }
      }
      const view = this._partyView(role, p, { clientId: Number(row.fineract_client_id), account });
      if (!account) view.fineract = { ...view.fineract, accountId: Number(row.fineract_account_id), accountNo: row.fineract_account_no, active: null };
      out[role] = { ...view, configured: true };
    }
    return out;
  }

  /** Record issuer capital in its Fineract account of record (bookkeeping — not external cash). */
  static async fundIssuer({ amountUsd, note, actor } = {}) {
    const amt = round2(amountUsd);
    if (!(amt > 0)) throw httpError('amountUsd must be positive', 400);
    const issuer = await this.ensureParty('issuer');
    const paymentTypeId = await this.ensurePaymentType();
    const txn = await FineractClient.depositSavings({ accountId: issuer.fineract.accountId, amount: amt, paymentTypeId, note: note || `Issuer capital (${actor || 'operator'})` });
    const account = await FineractClient.getAccountBalance(issuer.fineract.accountId);
    return { transactionId: String(txn.resourceId || txn.id || ''), issuer: this._partyView('issuer', this.getConfig().parties.issuer, { clientId: issuer.fineract.clientId, account }) };
  }

  // ── issuance ──────────────────────────────────────────────────────────────

  static async issue({ bondId, actor } = {}) {
    const id = Number(bondId);
    if (!Number.isInteger(id)) throw httpError('bondId required', 400);
    const { rows } = await pool.query('SELECT id, bond_name, status FROM bonds WHERE id = $1', [id]);
    if (!rows[0]) throw httpError(`bond ${id} not found`, 404);
    if (rows[0].status !== 'active') throw httpError(`bond ${id} is ${rows[0].status}, not active`, 409);
    const { issuer, holder } = await this.ensureParties();
    await DataBridge._ensureIssuerAccounts();
    await pool.query('UPDATE bonds SET issuer = $2, bondholder = $3, updated_at = NOW() WHERE id = $1', [id, issuer.name, holder.name]);
    await pool.query(`
      INSERT INTO bond_issuances (bond_id, issuer_external_id, holder_external_id, issued_by)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (bond_id) DO UPDATE SET issuer_external_id = EXCLUDED.issuer_external_id,
        holder_external_id = EXCLUDED.holder_external_id, status = 'issued', updated_at = NOW()`,
    [id, issuer.externalId, holder.externalId, actor || null]);
    return this.get(id);
  }

  static async get(bondId) {
    await this.ensureTables();
    const { rows } = await pool.query(`
      SELECT i.bond_id, i.issuer_external_id, i.holder_external_id, i.status AS issuance_status, i.issued_by, i.issued_at,
             b.bond_name, b.face_value, b.coupon_rate, b.payment_freq, b.maturity_date, b.status AS bond_status
      FROM bond_issuances i JOIN bonds b ON b.id = i.bond_id WHERE i.bond_id = $1`, [bondId]);
    if (!rows[0]) return null;
    const r = rows[0];
    let schedule = null;
    try { schedule = await LiveBondEngine.getBondLiveMetrics(bondId); } catch (e) { schedule = null; }
    const pays = await pool.query('SELECT * FROM bond_issuance_payments WHERE bond_id = $1 ORDER BY period_date DESC LIMIT 24', [bondId]);
    return {
      bondId: r.bond_id, bondName: r.bond_name, status: r.issuance_status, bondStatus: r.bond_status,
      issuer: r.issuer_external_id, holder: r.holder_external_id, issuedBy: r.issued_by, issuedAt: r.issued_at,
      faceValue: Number(r.face_value), couponRate: Number(r.coupon_rate), paymentFreq: r.payment_freq, maturityDate: r.maturity_date,
      nextCouponDate: schedule ? schedule.next_coupon_date : null,
      couponPerPeriod: schedule ? Number(schedule.coupon_per_period) : null,
      payments: pays.rows.map(this._paymentView),
    };
  }

  static async list() {
    await this.ensureTables();
    const { rows } = await pool.query('SELECT bond_id FROM bond_issuances ORDER BY bond_id');
    const out = [];
    for (const r of rows) out.push(await this.get(r.bond_id));
    return out;
  }

  static _paymentView(r) {
    return {
      paymentId: r.payment_id, bondId: r.bond_id, kind: r.kind, periodDate: r.period_date, amountUsd: Number(r.amount_usd),
      status: r.status, fineractWithdrawalId: r.fineract_withdrawal_id, fineractDepositId: r.fineract_deposit_id,
      issuerEntryIds: r.issuer_entry_ids, holderEntryId: r.holder_entry_id, intakeId: r.intake_id,
      error: r.error_message, initiatedBy: r.initiated_by, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  // ── payments ──────────────────────────────────────────────────────────────

  /**
   * Book one due P&I payment: Fineract issuer withdrawal -> holder deposit,
   * issuer + holder GL, then the Stripe income intake for the external leg.
   */
  static async payDue({ bondId, kind = 'coupon', amountUsd, periodDate, actor } = {}) {
    if (!KINDS.includes(kind)) throw httpError(`kind must be one of ${KINDS.join(', ')}`, 400);
    const cfg = this.getConfig();
    if (!cfg.enabled) throw httpError('bond issuance disabled', 503);
    const issuance = await this.get(bondId);
    if (!issuance) throw httpError(`bond ${bondId} is not issued (POST /issuances first)`, 409, 'NOT_ISSUED');
    if (issuance.status !== 'issued') throw httpError(`issuance ${bondId} is ${issuance.status}`, 409);

    const metrics = await LiveBondEngine.getBondLiveMetrics(bondId);
    const amount = round2(amountUsd != null ? amountUsd : (kind === 'coupon' ? metrics.coupon_per_period : 0));
    if (!(amount > 0)) throw httpError('amountUsd must be positive', 400);
    const period = isoDate(periodDate || metrics.next_coupon_date || new Date());
    const bondCode = metrics.bond_name || `BOND-${bondId}`;

    const dup = await pool.query('SELECT payment_id, status FROM bond_issuance_payments WHERE bond_id = $1 AND kind = $2 AND period_date = $3', [bondId, kind, period]);
    if (dup.rows[0] && dup.rows[0].status !== 'failed') throw httpError(`${kind} for ${period} already booked: ${dup.rows[0].payment_id}`, 409, 'DUPLICATE', { paymentId: dup.rows[0].payment_id });

    const partiesRow = await pool.query('SELECT role, fineract_account_id FROM bond_issuance_parties');
    const acct = (role) => { const r = partiesRow.rows.find((x) => x.role === role); return r ? Number(r.fineract_account_id) : null; };
    const issuerAcct = acct('issuer'); const holderAcct = acct('holder');
    if (!issuerAcct || !holderAcct) throw httpError('issuer/holder Fineract accounts not provisioned (POST /issuances/parties)', 409, 'PARTIES_NOT_PROVISIONED');

    const id = dup.rows[0] ? dup.rows[0].payment_id : paymentId();
    await pool.query(`
      INSERT INTO bond_issuance_payments (payment_id, bond_id, kind, period_date, amount_usd, status, initiated_by)
      VALUES ($1, $2, $3, $4, $5, 'held', $6)
      ON CONFLICT (payment_id) DO UPDATE SET status = 'held', error_message = NULL, updated_at = NOW()`,
    [id, bondId, kind, period, amount, actor || null]);

    const label = kind === 'coupon' ? 'Coupon' : 'Principal';
    const note = `${label} ${period} ${bondCode} [${id}]`;
    let withdrawal; let paymentTypeId;
    try {
      paymentTypeId = await this.ensurePaymentType();
      withdrawal = await FineractClient.withdrawSavings({ accountId: issuerAcct, amount, transactionDate: new Date(), paymentTypeId, note: `${note} -> holder` });
    } catch (err) {
      await this._fail(id, `fineract issuer withdrawal: ${err.message}`);
      throw httpError(`Fineract withdrawal from issuer account failed: ${err.message}`, 502, 'FINERACT_WITHDRAWAL_FAILED');
    }
    const withdrawalId = String(withdrawal.resourceId || withdrawal.id || '');
    let deposit;
    try {
      deposit = await FineractClient.depositSavings({ accountId: holderAcct, amount, transactionDate: new Date(), paymentTypeId, note: `${note} <- issuer` });
    } catch (err) {
      await this._fail(id, `fineract holder deposit (issuer withdrawal ${withdrawalId} stands): ${err.message}`);
      throw httpError(`Fineract deposit to holder account failed: ${err.message}`, 502, 'FINERACT_DEPOSIT_FAILED', { withdrawalId });
    }
    const depositId = String(deposit.resourceId || deposit.id || '');

    const issuerEntries = [];
    let holderEntry = null;
    if (kind === 'coupon') {
      const due = await DataBridge._postCouponDue({ amount, entryDate: period, bondCode, bondId, referenceType: 'coupon_period', referenceId: `${id}:DUE` });
      const paid = await DataBridge._postCouponPaid({ amount, entryDate: period, bondCode, bondId, referenceType: 'coupon_paid', referenceId: `${id}:PAID` });
      issuerEntries.push(String(due.entryId || due.entry_id), String(paid.entryId || paid.entry_id));
      const rec = await DataBridge._postCouponReceipt({ amount, entryDate: period, bondCode, bondId, referenceType: 'coupon_payment', referenceId: id });
      holderEntry = String(rec.entryId || rec.entry_id);
    }

    await pool.query(`
      UPDATE bond_issuance_payments SET status = 'held', fineract_withdrawal_id = $2, fineract_deposit_id = $3,
        issuer_entry_ids = $4, holder_entry_id = $5, updated_at = NOW()
      WHERE payment_id = $1`,
    [id, withdrawalId, depositId, issuerEntries, holderEntry]);

    let held = await this.getPayment(id);
    if (cfg.autoIntake) {
      try { held = await this.fundExternal({ paymentId: id, actor }); } catch (err) { held.intakeError = err.message; }
    }
    return { ...held, next: held.status === 'held'
      ? 'income held in the holder Fineract account of record; POST /payments/:id/send-to-bank to convert to fiat (Lili), or /fund-external to bring outside dollars in first'
      : 'issuer completes the Stripe Checkout; webhook marks the intake received -> payment funded -> send-to-bank' };
  }

  static async getPayment(paymentId) {
    const { rows } = await pool.query('SELECT * FROM bond_issuance_payments WHERE payment_id = $1', [paymentId]);
    if (!rows[0]) throw httpError(`payment ${paymentId} not found`, 404);
    return this._paymentView(rows[0]);
  }

  /**
   * Convert a held payment to fiat: its holder 1020 journal becomes fixed-income
   * distributions to the settlement bank (Lili). Execution stays behind
   * maker/checker (approvalRef + screeningRef) in FixedIncomeDistributionEngine.
   */
  static async sendToBank({ paymentId, actor } = {}) {
    const p = await this.getPayment(paymentId);
    if (!['held', 'funded'].includes(p.status)) throw httpError(`payment ${paymentId} is ${p.status}; only held/funded payments can be sent to bank`, 409, 'NOT_HELD');
    if (!p.holderEntryId) throw httpError(`payment ${paymentId} has no holder journal to distribute`, 409, 'NO_HOLDER_ENTRY');
    if (!FixedIncomeDistributionEngine) throw httpError('FixedIncomeDistributionEngine unavailable', 503);
    await FixedIncomeDistributionEngine.plan({ createdBy: actor || 'bond_issuance' });
    const all = await FixedIncomeDistributionEngine.list({ limit: 500 });
    const distributions = all.filter((d) => String(d.sourceEntryId) === String(p.holderEntryId));
    if (!distributions.length) throw httpError('no distribution planned for the holder journal (check FIXED_INCOME_BANK_PAYEES / minAmount)', 409, 'NOT_PLANNED');
    await pool.query(`UPDATE bond_issuance_payments SET status = 'sent_to_bank', updated_at = NOW() WHERE payment_id = $1`, [paymentId]);
    return { ...(await this.getPayment(paymentId)), distributions, next: 'POST /api/fixed-income/distributions/:id/execute {approvalRef, screeningRef} -> Stripe payout -> Lili direct deposit' };
  }

  /** Optional external funding leg: Stripe income intake keyed to the payment. */
  static async fundExternal({ paymentId, actor } = {}) {
    const p = await this.getPayment(paymentId);
    if (p.status !== 'held') throw httpError(`payment ${paymentId} is ${p.status}; only held payments can be externally funded`, 409, 'NOT_HELD');
    if (!StripePaymentIntakeEngine) throw httpError('StripePaymentIntakeEngine unavailable', 503);
    const intake = await StripePaymentIntakeEngine.createIncomePaymentLink({
      amountCents: Math.round(p.amountUsd * 100),
      purpose: p.kind === 'coupon' ? 'coupon_income' : 'principal_repayment',
      reference: p.paymentId,
      description: `${p.kind} ${isoDate(p.periodDate)} bond ${p.bondId} (Fineract ${p.fineractWithdrawalId}->${p.fineractDepositId})`,
      createdBy: actor || 'bond_issuance',
    });
    await pool.query(`UPDATE bond_issuance_payments SET status = 'awaiting_external_funds', intake_id = $2, updated_at = NOW() WHERE payment_id = $1`, [paymentId, intake.intakeId]);
    return { ...(await this.getPayment(paymentId)), intake: { intakeId: intake.intakeId, checkoutUrl: intake.checkoutUrl, expiresAt: intake.expiresAt } };
  }

  static async _fail(id, message) {
    await pool.query(`UPDATE bond_issuance_payments SET status = 'failed', error_message = $2, updated_at = NOW() WHERE payment_id = $1`, [id, message]);
  }

  /** Called by the Stripe webhook / reconciliation: intake received -> payment funded. */
  static async markFunded(intakeId) {
    await this.ensureTables();
    const { rows } = await pool.query(`UPDATE bond_issuance_payments SET status = 'funded', updated_at = NOW() WHERE intake_id = $1 AND status = 'awaiting_external_funds' RETURNING *`, [intakeId]);
    return rows[0] ? this._paymentView(rows[0]) : null;
  }

  /** Book every issued bond whose next coupon date is due (scheduler entry point). */
  static async runDue({ asOf = new Date(), actor = 'scheduler' } = {}) {
    const issuances = await this.list();
    const today = isoDate(asOf);
    const results = [];
    for (const i of issuances) {
      if (i.status !== 'issued' || i.bondStatus !== 'active' || !i.nextCouponDate) continue;
      if (isoDate(i.nextCouponDate) > today) continue;
      try {
        results.push({ bondId: i.bondId, ok: true, payment: await this.payDue({ bondId: i.bondId, kind: 'coupon', actor }) });
      } catch (err) {
        results.push({ bondId: i.bondId, ok: false, code: err.code, error: err.message });
      }
    }
    return { asOf: today, checked: issuances.length, results };
  }

  static async status() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.parties.issuer.name) issues.push('INCOME_OBLIGOR_NAME not set');
    let fineract = false;
    try { await FineractClient.healthCheck(); fineract = true; } catch (e) { issues.push(`fineract: ${e.message}`); }
    const parties = await this.parties({ live: fineract });
    for (const role of ROLES) if (!parties[role].fineract || !parties[role].fineract.accountId) issues.push(`${role} Fineract account not provisioned`);
    const issuances = await this.list();
    const counts = await pool.query('SELECT status, COUNT(*)::int AS n, COALESCE(SUM(amount_usd),0) AS total FROM bond_issuance_payments GROUP BY status');
    return {
      enabled: cfg.enabled, ready: cfg.enabled && issues.length === 0, issues, fineractConnected: fineract,
      parties, issuances: issuances.length, bonds: issuances.map((i) => ({ bondId: i.bondId, bondName: i.bondName, nextCouponDate: i.nextCouponDate, couponPerPeriod: i.couponPerPeriod })),
      payments: counts.rows.map((r) => ({ status: r.status, count: r.n, totalUsd: Number(r.total) })),
      pipeline: 'issuer Fineract account -> holder Fineract account (held, account of record) -> [send-to-bank] fixed-income distribution -> maker/checker -> Stripe payout -> Lili direct deposit',
    };
  }
}

module.exports = { BondIssuanceEngine, ROLES, KINDS };
