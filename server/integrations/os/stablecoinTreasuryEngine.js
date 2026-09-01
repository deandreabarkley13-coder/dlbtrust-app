'use strict';

/**
 * Buying the USDC the payout rail spends.
 *
 * Payer OS can only pay out what the distributor already holds, so something
 * has to put USDC there. That purchase has two legs, and buying USDC always
 * means debiting dollars at a licensed venue, so which venue decides how much
 * of it this engine can originate:
 *
 *   source 'circle_mint'  USD → Circle is a bank wire the trust pushes from
 *                         Trust Operating (Circle Mint does not pull from your
 *                         bank), and Circle → Stellar is a transfer this engine
 *                         originates against the Circle API.
 *   source 'exchange'     The desk buys USDC at an exchange with a linked bank
 *                         account and withdraws it on Stellar. Both legs happen
 *                         at the venue; this engine sizes the purchase, holds
 *                         dual control, records the venue's references, and
 *                         still refuses to recognise the tokens until Horizon
 *                         shows them. It needs no Circle account, which is why
 *                         it exists.
 *   source 'onramp'       A hosted fiat on-ramp (MoonPay's `usdc_xlm`). This
 *                         engine creates the checkout — exact amount, asset,
 *                         network and destination, signed so none of them can be
 *                         edited in the browser — and a human completes the
 *                         payment under the provider's KYC.
 *   source 'stellar_dex'  No venue and no fiat: the distributor swaps XLM it
 *                         already holds for USDC on Stellar's order books, which
 *                         this engine signs itself. It exchanges assets rather
 *                         than adding any, so it cannot be the first funding.
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
 *   • Nothing is simulated. A Circle purchase without CIRCLE_MINT_API_KEY
 *     refuses rather than pretending to buy, and an exchange purchase records
 *     only references a human can point at.
 *
 * Accounting, in the two legs' own terms:
 *
 *   wire sent        debit  USDC purchases in transit (1215)  credit Trust Operating (1010)
 *   tokens arrived   debit  USDC (1210)                       credit USDC purchases in transit (1215)
 *
 * so dollars are never quietly turned into tokens in one step, and money that
 * has left the bank but not yet arrived on-chain is visible as exactly that.
 *
 * A DEX swap has no fiat leg at all, so it is one entry against the XLM the
 * trust gave up rather than against cash:
 *
 *   tokens arrived   debit  USDC (1210)                       credit XLM (1216)
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { CircleMintClient } = require('../stablecoin/circleMintClient');
const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');
const { FundingSourceRegistry } = require('../inhouseBank/clearing/fundingSourceRegistry');
const { StablecoinPayoutRail } = require('./stablecoinPayoutRail');
const { PayerOsEngine } = require('./payerOsEngine');
const { StellarDexSwap } = require('../stablecoin/stellarDexSwap');
const { onrampProvider } = require('../stablecoin/onrampProvider');

/** Circle's chain code for Stellar. Their default is ETH, which is not us. */
const STELLAR_CHAIN = 'XLM';

/** A purchase in one of these states is money the trust has already committed. */
const OPEN_STATUSES = [
  'pending_approval', 'approved', 'checkout_issued', 'wire_sent', 'transferring', 'in_transit',
];

/**
 * Where the tokens come from. Circle and the Stellar DEX are originated here;
 * an exchange and an on-ramp are executed by a human at the venue.
 */
const SOURCES = ['circle_mint', 'exchange', 'onramp', 'stellar_dex'];

/** Sources with no bank leg, so nothing to record as a wire. */
const NO_FIAT_LEG_SOURCES = ['stellar_dex'];

/** How the tokens got here, for the journal memo. */
const DELIVERY_LABELS = {
  circle_mint: 'Circle transfer',
  exchange: 'Exchange withdrawal',
  onramp: 'On-ramp delivery',
  stellar_dex: 'Order-book swap',
};

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
    // What a DEX swap gives up. A swap spends XLM, not dollars, so it must not
    // relieve the USD transit account.
    xlmAssetAccount: text('STABLECOIN_XLM_ASSET_ACCOUNT', '1216'),
  };
}

/** The venue a purchase names. Rows raised before the column default to Circle. */
function sourceOf(row) {
  return String((row && row.source) || 'circle_mint');
}

/** Which account the arriving USDC is credited against, per source. */
function relievedAccount(source, cfg) {
  return source === 'stellar_dex' ? cfg.xlmAssetAccount : cfg.inTransitAccount;
}

function money(cents) {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

function normalizeSource(source) {
  const venue = String(source || 'circle_mint').trim().toLowerCase();
  if (!SOURCES.includes(venue)) {
    throw new StablecoinTreasuryError(
      `${source} is not a funding source; use one of ${SOURCES.join(', ')}`,
      'STABLECOIN_TREASURY_BAD_SOURCE',
      400
    );
  }
  return venue;
}

function newId() {
  return `USDCBUY-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

const StablecoinTreasuryEngine = {
  StablecoinTreasuryError,
  STELLAR_CHAIN,
  SOURCES,
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
        source               TEXT NOT NULL DEFAULT 'circle_mint',
        provider             TEXT,
        provider_reference   TEXT,
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
    // Purchases predate the exchange source, and default to the venue they
    // were raised against.
    await pool.query(
      `ALTER TABLE stablecoin_purchases
         ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'circle_mint'`
    );
    await pool.query('ALTER TABLE stablecoin_purchases ADD COLUMN IF NOT EXISTS provider TEXT');
    await pool.query('ALTER TABLE stablecoin_purchases ADD COLUMN IF NOT EXISTS provider_reference TEXT');
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
      exchange: this.exchangeReadiness(railPosition),
      onramp: this.onrampReadiness(),
      stellarDex: StellarDexSwap.readiness(),
    };
  },

  /** Whether a hosted on-ramp checkout could be signed for this network. */
  onrampReadiness(provider = null) {
    try {
      return onrampProvider(provider).readiness();
    } catch (err) {
      return { provider: provider || null, ready: false, issues: [err.message] };
    }
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

  /**
   * An exchange purchase needs no provider credentials here — the desk holds
   * the exchange account — only somewhere for the tokens to land. Reading the
   * position at all proves the distributor exists and holds the trustline,
   * since the rail refuses to report one otherwise.
   */
  exchangeReadiness(railPosition = null) {
    const issues = [];
    if (!railPosition || !railPosition.address) {
      issues.push('no distributor is configured, so there is nowhere to withdraw to');
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
  async plan({ amountCents = null, source = 'circle_mint' } = {}) {
    const cfg = getConfig();
    const venue = normalizeSource(source);
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
    const dexQuote = venue === 'stellar_dex'
      ? await StellarDexSwap.quote({ amountCents: wanted }).catch(err => ({ error: err.message }))
      : null;

    return {
      amountCents: wanted,
      amount: money(wanted),
      position,
      fundingAccount,
      source: venue,
      dexQuote,
      legs: this._legs(venue, wanted, position, cfg, operatingCode, dexQuote),
      circle: this.circleReadiness(),
      exchange: this.exchangeReadiness(position.distributor ? { address: position.distributor, asset: position.asset } : null),
      onramp: this.onrampReadiness(),
      stellarDex: StellarDexSwap.readiness(),
    };
  },

  /** What each source's legs are, and which of them a human has to perform. */
  _legs(venue, wanted, position, cfg, operatingCode, dexQuote = null) {
    if (venue === 'stellar_dex') {
      const price = dexQuote && !dexQuote.error
        ? ` at about ${dexQuote.sendAmount} XLM (max ${dexQuote.sendMax})`
        : '';
      return [
        {
          leg: 'xlm_to_usdc',
          automated: true,
          description: `Swap the distributor's XLM for ${money(wanted)} USDC on Stellar's order books${price}`,
          posts: `debit ${cfg.assetAccount} / credit ${cfg.xlmAssetAccount}, after Horizon confirms arrival`,
        },
      ];
    }
    if (venue === 'onramp') {
      return [
        {
          leg: 'onramp_checkout',
          automated: false,
          description: `Complete the signed on-ramp checkout for ${money(wanted)} of USDC on Stellar`
            + ` to ${position.distributor}`,
          posts: `debit ${cfg.inTransitAccount} / credit ${operatingCode}, once the payment is taken`,
        },
        {
          leg: 'onramp_delivery',
          automated: false,
          description: `The provider delivers ${money(wanted)} USDC on Stellar`,
          posts: `debit ${cfg.assetAccount} / credit ${cfg.inTransitAccount}, after Horizon confirms arrival`,
        },
      ];
    }
    if (venue === 'exchange') {
      return [
        {
          leg: 'usd_to_exchange',
          automated: false,
          description: `Buy ${money(wanted)} of USDC at the exchange with USD from Trust Operating`,
          posts: `debit ${cfg.inTransitAccount} / credit ${operatingCode}`,
        },
        {
          leg: 'exchange_to_chain',
          automated: false,
          description: `Withdraw ${money(wanted)} USDC on the Stellar network to ${position.distributor}`,
          posts: `debit ${cfg.assetAccount} / credit ${cfg.inTransitAccount}, after Horizon confirms arrival`,
        },
      ];
    }
    return [
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
    ];
  },

  /**
   * Whether the venue this purchase names could actually perform it. Each
   * source is asked its own question, and none of them is asked Circle's.
   */
  sourceReadiness(venue, plan = null) {
    if (venue === 'exchange') {
      return plan ? plan.exchange : this.exchangeReadiness();
    }
    if (venue === 'onramp') return this.onrampReadiness();
    if (venue === 'stellar_dex') return StellarDexSwap.readiness();
    return this.circleReadiness();
  },

  /** Maker raises the purchase. Nothing is called at Circle yet. */
  async initiate({ amountCents, initiatedBy, memo = null, source = 'circle_mint' } = {}) {
    await this.ensureTables();
    const maker = String(initiatedBy || '').trim();
    if (!maker) {
      throw new StablecoinTreasuryError('initiatedBy is required', 'STABLECOIN_TREASURY_NO_MAKER', 400);
    }
    const venue = normalizeSource(source);
    const plan = await this.plan({ amountCents, source: venue });
    const readiness = this.sourceReadiness(venue, plan);
    if (!readiness.ready) {
      throw new StablecoinTreasuryError(
        venue === 'circle_mint'
          ? `Circle Mint is not configured: ${readiness.issues.join(' ')}`
          : `${venue} cannot fund this purchase: ${readiness.issues.join('; ')}`,
        venue === 'circle_mint' ? 'CIRCLE_NOT_CONFIGURED' : 'STABLECOIN_TREASURY_NOT_READY',
        503
      );
    }

    const purchaseId = newId();
    const inserted = await pool.query(
      `INSERT INTO stablecoin_purchases
         (purchase_id, status, amount_cents, network, distributor_address,
          funding_account_id, funding_account_name, initiated_by, memo, source)
       VALUES ($1, 'pending_approval', $2, $3, $4, $5, $6, $7, $8, $9)
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
        venue,
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
    if (NO_FIAT_LEG_SOURCES.includes(sourceOf(row))) {
      throw new StablecoinTreasuryError(
        `${row.purchase_id} is a ${sourceOf(row)} purchase: no dollars leave the bank, so there is no wire to record`,
        'STABLECOIN_TREASURY_WRONG_SOURCE',
        400
      );
    }
    const wireReference = String(reference || '').trim();
    if (!wireReference) {
      throw new StablecoinTreasuryError(
        'A wire reference is required: without it there is no evidence the dollars left',
        'STABLECOIN_TREASURY_NO_REFERENCE',
        400
      );
    }
    if (!['approved', 'checkout_issued'].includes(row.status)) {
      throw new StablecoinTreasuryError(
        `${row.purchase_id} is ${row.status}; approve it before recording the funding wire`,
        'STABLECOIN_TREASURY_WRONG_STATE'
      );
    }

    const venueName = { exchange: 'the exchange', onramp: 'the on-ramp provider' }[sourceOf(row)] || 'Circle Mint';
    const amount = Number(row.amount_cents) / 100;
    const journal = await TrustAccountingEngine.postJournalEntry({
      entryDate: sentAt || new Date(),
      description: `USDC purchase ${row.purchase_id}: USD sent to ${venueName}`,
      lines: [
        {
          accountCode: cfg.inTransitAccount,
          debitAmount: amount,
          creditAmount: 0,
          memo: `USD in transit to ${venueName} (${wireReference})`,
        },
        {
          accountCode: FundingSourceRegistry.operatingAccountCode(),
          debitAmount: 0,
          creditAmount: amount,
          memo: `Funding ${venueName} for ${row.purchase_id}`,
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
    if (sourceOf(row) !== 'circle_mint') {
      const instead = {
        exchange: 'withdraw the USDC on Stellar at the exchange and record it with recordWithdrawal',
        onramp: 'complete the signed checkout, then record the delivery with recordWithdrawal',
        stellar_dex: 'use swap, which signs the order-book trade from the distributor itself',
      }[sourceOf(row)] || 'use the method that source is originated by';
      throw new StablecoinTreasuryError(
        `${row.purchase_id} is a ${sourceOf(row)} purchase, and Circle cannot originate it: ${instead}`,
        'STABLECOIN_TREASURY_WRONG_SOURCE',
        400
      );
    }
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
    this._assertDistributor(row, before);

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
   * Hand the operator a signed on-ramp checkout for exactly this purchase.
   *
   * The amount, the asset, the network and the destination are all inside the
   * signature, so the browser cannot be talked into buying something else or
   * delivering it somewhere else. Completing the payment is the human's job, and
   * issuing the checkout is not evidence that they did.
   */
  async checkout(purchaseId, { issuedBy = null, provider = null, redirectUrl = null } = {}) {
    const row = await this._require(purchaseId);
    if (sourceOf(row) !== 'onramp') {
      throw new StablecoinTreasuryError(
        `${row.purchase_id} is a ${sourceOf(row)} purchase, not an on-ramp one`,
        'STABLECOIN_TREASURY_WRONG_SOURCE',
        400
      );
    }
    if (!['approved', 'checkout_issued'].includes(row.status)) {
      throw new StablecoinTreasuryError(
        `${row.purchase_id} is ${row.status}; a second trustee approves before a checkout is issued`,
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
    this._assertDistributor(row, before);

    const venue = onrampProvider(provider);
    const session = venue.checkout({
      address: row.distributor_address,
      amountCents: Number(row.amount_cents),
      externalTransactionId: row.purchase_id,
      redirectUrl,
    });

    const purchase = await this._update(purchaseId, {
      status: 'checkout_issued',
      provider: venue.name,
      metadata: JSON.stringify({
        checkoutIssuedBy: issuedBy,
        checkoutAsset: session.asset,
        checkoutNetwork: session.network,
        sandbox: session.sandbox === true,
      }),
    });
    return { purchase, checkout: session };
  },

  /** What the provider says happened to this purchase. Not proof of arrival. */
  async onrampStatus(purchaseId, { provider = null } = {}) {
    const row = await this._require(purchaseId);
    if (sourceOf(row) !== 'onramp') {
      throw new StablecoinTreasuryError(
        `${row.purchase_id} is a ${sourceOf(row)} purchase, not an on-ramp one`,
        'STABLECOIN_TREASURY_WRONG_SOURCE',
        400
      );
    }
    const transactions = await onrampProvider(provider || row.provider).transactionsFor(row.purchase_id);
    return { purchase: row, transactions, note: 'Provider status is not evidence of arrival; confirm reads Horizon' };
  },

  /**
   * Swap the distributor's XLM for USDC on Stellar's order books.
   *
   * This is the one funding leg the trust originates itself, so it carries the
   * same controls as a payout: a second trustee, the distributor the purchase
   * was raised for, and a bounded price.
   */
  async swap(purchaseId, { executedBy = null } = {}) {
    const row = await this._require(purchaseId);
    if (sourceOf(row) !== 'stellar_dex') {
      throw new StablecoinTreasuryError(
        `${row.purchase_id} is a ${sourceOf(row)} purchase; only a stellar_dex purchase is swapped on-chain`,
        'STABLECOIN_TREASURY_WRONG_SOURCE',
        400
      );
    }
    if (row.status !== 'approved') {
      throw new StablecoinTreasuryError(
        `${row.purchase_id} is ${row.status} and cannot be swapped`,
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
    this._assertDistributor(row, before);

    const result = await StellarDexSwap.swap({ amountCents: Number(row.amount_cents) });
    if (!result.hash) {
      throw new StablecoinTreasuryError(
        'Stellar returned no transaction hash, so nothing is recorded as swapped',
        'STABLECOIN_TREASURY_NO_HASH',
        502
      );
    }

    const purchase = await this._update(purchaseId, {
      status: 'in_transit',
      chain_reference: result.hash,
      opening_balance: String(before.availableCents),
      metadata: JSON.stringify({
        executedBy,
        sendMaxXlm: result.quote.sendMax,
        quotedXlm: result.quote.sendAmount,
        maxSlippageBps: result.quote.maxSlippageBps,
      }),
    });
    return { purchase, swap: result };
  },

  /** A quote for what an order-book swap would cost right now. Reads only. */
  async dexQuote({ amountCents }) {
    return StellarDexSwap.quote({ amountCents });
  },

  /**
   * Record a delivery the desk arranged at a venue — an exchange withdrawal or
   * a completed on-ramp checkout. This is bookkeeping of an intent, not
   * evidence: the reference is whatever the venue gave the operator, and the
   * tokens are still only recognised by `confirm`.
   */
  async recordWithdrawal(purchaseId, { reference, executedBy = null } = {}) {
    const row = await this._require(purchaseId);
    if (!['exchange', 'onramp'].includes(sourceOf(row))) {
      throw new StablecoinTreasuryError(
        `${row.purchase_id} is a ${sourceOf(row)} purchase, which this engine originates itself;`
        + ` use ${sourceOf(row) === 'stellar_dex' ? 'swap' : 'transfer'}`,
        'STABLECOIN_TREASURY_WRONG_SOURCE',
        400
      );
    }
    const withdrawalReference = String(reference || '').trim();
    if (!withdrawalReference) {
      throw new StablecoinTreasuryError(
        'A withdrawal reference is required: the exchange\'s withdrawal id or the Stellar transaction hash',
        'STABLECOIN_TREASURY_NO_REFERENCE',
        400
      );
    }
    if (!['wire_sent', 'approved', 'checkout_issued'].includes(row.status)) {
      throw new StablecoinTreasuryError(
        `${row.purchase_id} is ${row.status} and cannot be withdrawn against`,
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
    this._assertDistributor(row, before);

    return this._update(purchaseId, {
      status: 'in_transit',
      chain_reference: withdrawalReference,
      provider_reference: withdrawalReference,
      opening_balance: String(before.availableCents),
      metadata: JSON.stringify({ withdrawalReference, executedBy }),
    });
  },

  /**
   * Confirm the tokens actually arrived, on Horizon, and only then post them
   * into the USDC asset account. Circle saying `complete` — or an operator
   * saying they withdrew — is not the evidence: the distributor's balance is.
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
          + ` of the expected ${money(row.amount_cents)}; try again once the venue has released it`,
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
          accountCode: relievedAccount(sourceOf(row), cfg),
          debitAmount: 0,
          creditAmount: amount,
          memo: `${DELIVERY_LABELS[sourceOf(row)] || 'Circle transfer'}`
            + ` ${row.circle_transfer_id || row.chain_reference} delivered`,
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
      chain_reference: row.circle_transfer_id || row.chain_reference,
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

  /** Funding the wrong account is not a rounding difference. */
  _assertDistributor(row, position) {
    if (position.address !== row.distributor_address) {
      throw new StablecoinTreasuryError(
        `${row.purchase_id} was raised for distributor ${row.distributor_address}, but the rail now points at`
        + ` ${position.address}; funding the wrong account is not a rounding difference`,
        'STABLECOIN_TREASURY_DISTRIBUTOR_CHANGED'
      );
    }
    return true;
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
