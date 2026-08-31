'use strict';

/**
 * Buying the USDC the payout rail spends.
 *
 * Payer OS can only pay out what the distributor already holds, so something
 * has to put USDC there. That purchase has two legs, and only one of them is
 * an API call:
 *
 *   USD → Circle   A bank wire the trust pushes from Trust Operating. Circle
 *                  Mint does not pull from your bank, so this engine produces
 *                  the wire instructions and records the intent; the money
 *                  leaves when the bank sends it.
 *   Circle → chain A transfer this engine originates: it registers the
 *                  distributor as a verified recipient on Stellar and asks
 *                  Circle to send USDC there.
 *
 * Rules, which are the payout rail's rules pointed the other way:
 *
 *   • The destination is the trust's own distributor, read from the payout
 *     rail's configuration. This engine cannot send USDC anywhere else, so a
 *     "funding" transfer can never become a payout.
 *   • The chain is Stellar, and the asset must be Circle's USDC for the
 *     configured network. Circle's default recipient chain is Ethereum, and a
 *     transfer sent there would be real money the Stellar rail cannot see.
 *   • Dual control. A purchase is initiated by one trustee and approved by
 *     another before Circle is called at all.
 *   • Arrival is verified, not assumed. Circle reporting `complete` is Circle's
 *     opinion; the journal entry posts only once the distributor's own Horizon
 *     balance has actually risen by the funded amount.
 *   • Nothing is simulated. Without CIRCLE_MINT_API_KEY the engine refuses
 *     rather than pretending to buy.
 *
 * Accounting, in the two legs' own terms:
 *
 *   wire sent        debit  USDC purchases in transit (1215)  credit Trust Operating (1010)
 *   tokens arrived   debit  USDC (1210)                       credit USDC purchases in transit (1215)
 *
 * so dollars are never quietly turned into tokens in one step, and money that
 * has left the bank but not yet arrived on-chain is visible as exactly that.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { CircleMintClient } = require('../stablecoin/circleMintClient');
const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');
const { FundingSourceRegistry } = require('../inhouseBank/clearing/fundingSourceRegistry');
const { StablecoinPayoutRail } = require('./stablecoinPayoutRail');
const { PayerOsEngine } = require('./payerOsEngine');

/** Circle's chain code for Stellar. Their default is ETH, which is not us. */
const STELLAR_CHAIN = 'XLM';

/** A purchase in one of these states is money the trust has already committed. */
const OPEN_STATUSES = ['pending_approval', 'approved', 'wire_sent', 'transferring', 'in_transit'];

class StablecoinTreasuryError extends Error {
  constructor(message, code = 'STABLECOIN_TREASURY_ERROR', status = 409) {
    super(message);
    this.name = 'StablecoinTreasuryError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function text(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === null ? fallback : String(value).trim();
}

function getConfig() {
  return {
    apiKey: text('CIRCLE_MINT_API_KEY'),
    // The Circle bank account the trust wires USD to. Circle issues the
    // instructions; this is only which linked account they belong to.
    wireBankAccountId: text('CIRCLE_MINT_WIRE_BANK_ACCOUNT_ID'),
    // How much USDC the desk wants on hand. A purchase is sized against this,
    // not against a number somebody types twice.
    targetFloorCents: Number(text('STABLECOIN_TARGET_FLOOR_CENTS', '0')) || 0,
    // Where dollars sit between leaving the bank and arriving as tokens.
    inTransitAccount: text('STABLECOIN_PURCHASE_TRANSIT_ACCOUNT', '1215'),
    assetAccount: text('STABLECOIN_ASSET_ACCOUNT', '1210'),
  };
}

function money(cents) {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

function newId() {
  return `USDCBUY-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

const StablecoinTreasuryEngine = {
  StablecoinTreasuryError,
  STELLAR_CHAIN,
  config: getConfig,

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stablecoin_purchases (
        purchase_id          TEXT PRIMARY KEY,
        status               TEXT NOT NULL,
        amount_cents         BIGINT NOT NULL CHECK (amount_cents > 0),
        currency             TEXT NOT NULL DEFAULT 'USD',
        network              TEXT NOT NULL,
        distributor_address  TEXT NOT NULL,
        funding_account_id   TEXT,
        funding_account_name TEXT,
        circle_recipient_id  TEXT,
        circle_transfer_id   TEXT,
        chain_reference      TEXT,
        opening_balance      TEXT,
        initiated_by         TEXT NOT NULL,
        approved_by          TEXT,
        wire_reference       TEXT,
        journal_entry_id     TEXT,
        transit_journal_id   TEXT,
        failure_reason       TEXT,
        memo                 TEXT,
        metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        approved_at          TIMESTAMPTZ,
        funded_at            TIMESTAMPTZ
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_stablecoin_purchases_status
         ON stablecoin_purchases (status)`
    );
    return true;
  },

  client() {
    const cfg = getConfig();
    if (!cfg.apiKey) {
      throw new StablecoinTreasuryError(
        'CIRCLE_MINT_API_KEY is not configured: USDC cannot be bought without a Circle Mint account,'
        + ' and this engine will not pretend it did',
        'CIRCLE_NOT_CONFIGURED',
        503
      );
    }
    return new CircleMintClient();
  },

  /**
   * What the trust holds, what it has already committed, and what it is short
   * of the floor. Reads only.
   */
  async position() {
    const cfg = getConfig();
    const railPosition = await StablecoinPayoutRail.position();
    const inFlightCents = await PayerOsEngine.stablecoinInFlightCents();
    const purchasingCents = await this.openPurchaseCents();

    const heldCents = Number(railPosition.availableCents || 0);
    const spendableCents = Math.max(0, heldCents - inFlightCents);
    const gapCents = cfg.targetFloorCents
      ? Math.max(0, cfg.targetFloorCents - (spendableCents + purchasingCents))
      : 0;

    return {
      network: railPosition.network,
      distributor: railPosition.address,
      asset: railPosition.asset,
      issuer: railPosition.issuer,
      heldCents,
      inFlightCents,
      spendableCents,
      purchasingCents,
      targetFloorCents: cfg.targetFloorCents,
      gapCents,
      held: money(heldCents),
      spendable: money(spendableCents),
      purchasing: money(purchasingCents),
      shortOfFloor: money(gapCents),
      circle: this.circleReadiness(),
    };
  },

  circleReadiness() {
    const cfg = getConfig();
    const issues = [];
    if (!cfg.apiKey) issues.push('CIRCLE_MINT_API_KEY is not set');
    if (!cfg.wireBankAccountId) {
      issues.push('CIRCLE_MINT_WIRE_BANK_ACCOUNT_ID is not set, so wire instructions cannot be fetched');
    }
    return { ready: issues.length === 0, issues };
  },

  /** USD already committed to buying tokens that have not landed yet. */
  async openPurchaseCents() {
    await this.ensureTables();
    const rows = await pool.query(
      `SELECT COALESCE(SUM(amount_cents), 0) AS cents
         FROM stablecoin_purchases
        WHERE status = ANY($1::text[])`,
      [OPEN_STATUSES]
    );
    return Number(rows.rows[0]?.cents || 0);
  },

  /** Circle's own balances, as Circle reports them. */
  async circleBalances() {
    const response = await this.client().getBalances();
    return response && response.data ? response.data : response;
  },

  /**
   * Where to wire the dollars. Circle issues these per linked bank account and
   * they can change, so they are fetched rather than stored.
   */
  async wireInstructions() {
    const cfg = getConfig();
    if (!cfg.wireBankAccountId) {
      throw new StablecoinTreasuryError(
        'CIRCLE_MINT_WIRE_BANK_ACCOUNT_ID is required: link the trust\'s bank account in Circle Mint first',
        'CIRCLE_NO_BANK_ACCOUNT',
        503
      );
    }
    const response = await this.client().getWireInstructions(cfg.wireBankAccountId);
    return response && response.data ? response.data : response;
  },

  /** Size a purchase against the floor without committing anything. */
  async plan({ amountCents = null } = {}) {
    const cfg = getConfig();
    const operatingCode = FundingSourceRegistry.operatingAccountCode();
    const position = await this.position();
    const wanted = amountCents === null ? position.gapCents : Number(amountCents);
    if (!Number.isInteger(wanted) || wanted <= 0) {
      throw new StablecoinTreasuryError(
        position.targetFloorCents
          ? `Nothing to buy: the position is at or above the ${money(position.targetFloorCents)} floor`
          : 'amountCents must be a positive whole number of cents (or set STABLECOIN_TARGET_FLOOR_CENTS)',
        'STABLECOIN_TREASURY_BAD_AMOUNT',
        400
      );
    }

    const funding = await FundingSourceRegistry.resolve('operating').catch(() => null);
    const fundingAccount = funding
      ? {
        id: funding.sourceId,
        name: funding.accountName,
        availableCents: Number(funding.availableCents || 0),
        eligible: Boolean(funding.eligible),
      }
      : null;
    return {
      amountCents: wanted,
      amount: money(wanted),
      position,
      fundingAccount,
      legs: [
        {
          leg: 'usd_to_circle',
          automated: false,
          description: `Wire ${money(wanted)} from Trust Operating to Circle Mint`,
          posts: `debit ${cfg.inTransitAccount} / credit ${operatingCode}`,
        },
        {
          leg: 'circle_to_chain',
          automated: true,
          description: `Circle sends ${money(wanted)} USDC to ${position.distributor} on Stellar ${position.network}`,
          posts: `debit ${cfg.assetAccount} / credit ${cfg.inTransitAccount}, after Horizon confirms arrival`,
        },
      ],
      circle: this.circleReadiness(),
    };
  },

  /** Maker raises the purchase. Nothing is called at Circle yet. */
  async initiate({ amountCents, initiatedBy, memo = null } = {}) {
    await this.ensureTables();
    const maker = String(initiatedBy || '').trim();
    if (!maker) {
      throw new StablecoinTreasuryError('initiatedBy is required', 'STABLECOIN_TREASURY_NO_MAKER', 400);
    }
    const plan = await this.plan({ amountCents });
    const readiness = this.circleReadiness();
    if (!readiness.ready) {
      throw new StablecoinTreasuryError(
        `Circle Mint is not configured: ${readiness.issues.join(' ')}`,
        'CIRCLE_NOT_CONFIGURED',
        503
      );
    }

    const purchaseId = newId();
    const inserted = await pool.query(
      `INSERT INTO stablecoin_purchases
         (purchase_id, status, amount_cents, network, distributor_address,
          funding_account_id, funding_account_name, initiated_by, memo)
       VALUES ($1, 'pending_approval', $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        purchaseId,
        plan.amountCents,
        plan.position.network,
        plan.position.distributor,
        plan.fundingAccount ? plan.fundingAccount.id : null,
        plan.fundingAccount ? plan.fundingAccount.name : null,
        maker,
        memo,
      ]
    );
    return { purchase: inserted.rows[0], plan };
  },

  /** Checker approves. Must not be the maker. */
  async approve(purchaseId, approvedBy) {
    const row = await this._require(purchaseId);
    const checker = String(approvedBy || '').trim();
    if (!checker) {
      throw new StablecoinTreasuryError('approvedBy is required', 'STABLECOIN_TREASURY_NO_CHECKER', 400);
    }
    if (row.status !== 'pending_approval') {
      throw new StablecoinTreasuryError(
        `${row.purchase_id} is ${row.status}, not awaiting approval`,
        'STABLECOIN_TREASURY_WRONG_STATE'
      );
    }
    if (checker.toLowerCase() === String(row.initiated_by).toLowerCase()) {
      throw new StablecoinTreasuryError(
        'The trustee who raised a USDC purchase cannot also approve it',
        'STABLECOIN_TREASURY_SAME_TRUSTEE'
      );
    }
    return this._update(purchaseId, {
      status: 'approved',
      approved_by: checker,
      approved_at: 'NOW()',
    });
  },

  /**
   * Record that the USD wire has left the bank, and post it as in transit.
   * The wire itself is sent by the bank, not here.
   */
  async recordWire(purchaseId, { reference, sentBy = null, sentAt = null } = {}) {
    const cfg = getConfig();
    const row = await this._require(purchaseId);
    const wireReference = String(reference || '').trim();
    if (!wireReference) {
      throw new StablecoinTreasuryError(
        'A wire reference is required: without it there is no evidence the dollars left',
        'STABLECOIN_TREASURY_NO_REFERENCE',
        400
      );
    }
    if (row.status !== 'approved') {
      throw new StablecoinTreasuryError(
        `${row.purchase_id} is ${row.status}; approve it before recording the funding wire`,
        'STABLECOIN_TREASURY_WRONG_STATE'
      );
    }

    const amount = Number(row.amount_cents) / 100;
    const journal = await TrustAccountingEngine.postJournalEntry({
      entryDate: sentAt || new Date(),
      description: `USDC purchase ${row.purchase_id}: wire to Circle Mint`,
      lines: [
        {
          accountCode: cfg.inTransitAccount,
          debitAmount: amount,
          creditAmount: 0,
          memo: `USD in transit to Circle Mint (${wireReference})`,
        },
        {
          accountCode: FundingSourceRegistry.operatingAccountCode(),
          debitAmount: 0,
          creditAmount: amount,
          memo: `Wire to Circle Mint for ${row.purchase_id}`,
        },
      ],
      referenceType: 'stablecoin_purchase',
      referenceId: row.purchase_id,
      postedBy: sentBy || row.approved_by || row.initiated_by,
    });

    return this._update(purchaseId, {
      status: 'wire_sent',
      wire_reference: wireReference,
      transit_journal_id: journal.entry_id,
    });
  },

  /**
   * Ask Circle to send the USDC to the trust's distributor on Stellar. The
   * destination is not a parameter: it is whatever the payout rail is
   * configured to spend from.
   */
  async transfer(purchaseId, { executedBy = null } = {}) {
    const row = await this._require(purchaseId);
    if (!['wire_sent', 'approved'].includes(row.status)) {
      throw new StablecoinTreasuryError(
        `${row.purchase_id} is ${row.status} and cannot be transferred`,
        'STABLECOIN_TREASURY_WRONG_STATE'
      );
    }
    if (!row.approved_by) {
      throw new StablecoinTreasuryError(
        `${row.purchase_id} has not been approved by a second trustee`,
        'STABLECOIN_TREASURY_UNAPPROVED'
      );
    }

    const before = await StablecoinPayoutRail.position();
    if (before.address !== row.distributor_address) {
      throw new StablecoinTreasuryError(
        `${row.purchase_id} was raised for distributor ${row.distributor_address}, but the rail now points at`
        + ` ${before.address}; funding the wrong account is not a rounding difference`,
        'STABLECOIN_TREASURY_DISTRIBUTOR_CHANGED'
      );
    }

    const client = this.client();
    let recipientId = row.circle_recipient_id;
    if (!recipientId) {
      const recipient = await client.createRecipientAddress({
        address: row.distributor_address,
        chain: STELLAR_CHAIN,
        currency: 'USD',
        description: `DLB Trust USDC distributor (${row.purchase_id})`,
      });
      recipientId = (recipient && recipient.data && recipient.data.id) || (recipient && recipient.id) || null;
      if (!recipientId) {
        throw new StablecoinTreasuryError(
          'Circle did not return a verified recipient address id, so no transfer was attempted',
          'CIRCLE_NO_RECIPIENT',
          502
        );
      }
    }

    const transfer = await client.createTransfer({
      destinationAddressId: recipientId,
      amount: (Number(row.amount_cents) / 100).toFixed(2),
      currency: 'USD',
    });
    const data = (transfer && transfer.data) || transfer || {};
    if (!data.id) {
      throw new StablecoinTreasuryError(
        'Circle did not return a transfer id, so the purchase is not recorded as sent',
        'CIRCLE_NO_TRANSFER',
        502
      );
    }

    return this._update(purchaseId, {
      status: 'in_transit',
      circle_recipient_id: recipientId,
      circle_transfer_id: data.id,
      opening_balance: String(before.availableCents),
      metadata: JSON.stringify({ circleStatus: data.status || null, executedBy }),
    });
  },

  /**
   * Confirm the tokens actually arrived, on Horizon, and only then post them
   * into the USDC asset account. Circle saying `complete` is not the evidence:
   * the distributor's own balance is.
   */
  async confirm(purchaseId, { confirmedBy = null } = {}) {
    const cfg = getConfig();
    const row = await this._require(purchaseId);
    if (row.status === 'funded') return { purchase: row, alreadyFunded: true };
    if (row.status !== 'in_transit') {
      throw new StablecoinTreasuryError(
        `${row.purchase_id} is ${row.status}; there is nothing in transit to confirm`,
        'STABLECOIN_TREASURY_WRONG_STATE'
      );
    }

    const now = await StablecoinPayoutRail.position();
    const opening = Number(row.opening_balance || 0);
    const arrivedCents = Number(now.availableCents || 0) - opening;
    if (arrivedCents < Number(row.amount_cents)) {
      return {
        purchase: row,
        confirmed: false,
        reason: `The distributor holds ${money(now.availableCents)}, up ${money(Math.max(0, arrivedCents))}`
          + ` of the expected ${money(row.amount_cents)}; Circle transfers settle in minutes, so try again shortly`,
      };
    }

    const amount = Number(row.amount_cents) / 100;
    const journal = await TrustAccountingEngine.postJournalEntry({
      entryDate: new Date(),
      description: `USDC purchase ${row.purchase_id}: tokens received on Stellar`,
      lines: [
        {
          accountCode: cfg.assetAccount,
          debitAmount: amount,
          creditAmount: 0,
          memo: `USDC received at …${String(row.distributor_address).slice(-4)}`,
        },
        {
          accountCode: cfg.inTransitAccount,
          debitAmount: 0,
          creditAmount: amount,
          memo: `Circle transfer ${row.circle_transfer_id} delivered`,
        },
      ],
      referenceType: 'stablecoin_purchase',
      referenceId: row.purchase_id,
      postedBy: confirmedBy || row.approved_by || row.initiated_by,
    });

    const purchase = await this._update(purchaseId, {
      status: 'funded',
      funded_at: 'NOW()',
      journal_entry_id: journal.entry_id,
      chain_reference: row.circle_transfer_id,
    });
    return { purchase, confirmed: true, journalEntry: journal, position: now };
  },

  async get(purchaseId) {
    return this._require(purchaseId);
  },

  async list({ status = null, limit = 50 } = {}) {
    await this.ensureTables();
    const rows = status
      ? await pool.query(
        `SELECT * FROM stablecoin_purchases WHERE status = $1 ORDER BY created_at DESC LIMIT $2`,
        [status, limit]
      )
      : await pool.query(
        `SELECT * FROM stablecoin_purchases ORDER BY created_at DESC LIMIT $1`,
        [limit]
      );
    return rows.rows;
  },

  async _require(purchaseId) {
    await this.ensureTables();
    const rows = await pool.query(
      'SELECT * FROM stablecoin_purchases WHERE purchase_id = $1',
      [String(purchaseId || '').trim()]
    );
    if (!rows.rows.length) {
      throw new StablecoinTreasuryError(`${purchaseId} is not a USDC purchase`, 'STABLECOIN_TREASURY_NOT_FOUND', 404);
    }
    return rows.rows[0];
  },

  async _update(purchaseId, changes) {
    const columns = [];
    const values = [];
    Object.entries(changes).forEach(([column, value]) => {
      if (value === 'NOW()') {
        columns.push(`${column} = NOW()`);
        return;
      }
      values.push(value);
      columns.push(`${column} = $${values.length}`);
    });
    values.push(String(purchaseId).trim());
    const rows = await pool.query(
      `UPDATE stablecoin_purchases SET ${columns.join(', ')}, updated_at = NOW()
        WHERE purchase_id = $${values.length}
        RETURNING *`,
      values
    );
    return rows.rows[0];
  },
};

module.exports = { StablecoinTreasuryEngine, StablecoinTreasuryError };
