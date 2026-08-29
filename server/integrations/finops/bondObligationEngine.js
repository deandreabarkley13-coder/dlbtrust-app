'use strict';

/**
 * Bond Holder & Obligation Engine
 *
 * The portfolio reader treated every active bond as a position the trust holds,
 * and decided what it was worth from the *issuer* alone. That is only half the
 * instrument. Who holds it decides which side of the balance sheet it lands on:
 *
 *   issuer = trust, holder = trust      → nets to nothing. Asset and liability
 *                                         in the same instrument.
 *   issuer = trust, holder = a person   → a liability. The trust owes the holder
 *                                         coupons and principal; the bond is the
 *                                         *holder's* asset, not the trust's, and
 *                                         corpus is only what the holder paid in.
 *   issuer = third party, holder = trust → an asset, and collateral once a
 *                                         securities custodian attests to it.
 *
 * DLB-PRB is the second case: the trust issued it, DeAndrea Lavar Barkley holds
 * 100% of it per subscription SUB-DLB-PRB-001 ($100,000,000 at par), and the PTC
 * administers it as trustee-custodian. So its face value is not trust corpus —
 * the corpus is the cash the subscription actually settled, which this engine
 * computes from external inbound movements into the subscription's cash account
 * rather than assuming the subscription was paid.
 *
 * Nothing here creates or attests value. It reads `bonds`,
 * `crm_bond_subscriptions`, `crm_contacts` and `cash_movements` and reports what
 * each instrument is: an asset of the trust, an obligation of the trust, or an
 * internal round trip.
 */

const pool = require('../bonds/pgPool');

/** How an instrument sits on the trust's books once the holder is known. */
const CLASSIFICATIONS = [
  'self_issued_self_held',
  'trust_obligation',
  'third_party_asset',
];

/**
 * Movement types that can carry subscription money in. A subscription is only
 * paid when value arrives from *outside* the trust's own accounts, which is why
 * an internal transfer between two cash accounts never counts.
 */
const SUBSCRIPTION_INFLOW_TYPES = ['bond_proceeds', 'deposit', 'transfer'];

/** The capacity a holder subscribed in. */
const CAPACITIES = ['personal', 'trust'];

function cents(value) {
  return Math.round(Number(value || 0));
}

function dollars(value) {
  return Number(value || 0) / 100;
}

function normalize(value) {
  return String(value === undefined || value === null ? '' : value).trim().toLowerCase();
}

class BondObligationEngine {
  /**
   * Capacity is a fact about the holder that the subscription record cannot
   * express: DeAndrea Lavar Barkley is recorded with the trust as his company
   * but holds DLB-PRB personally, with the PTC administering it as trustee and
   * custodian. Declaring it here is what turns the instrument into an obligation
   * of the trust instead of paper it holds itself.
   */
  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bond_holder_capacity (
        subscription_id TEXT PRIMARY KEY,
        capacity        TEXT NOT NULL CHECK (capacity IN ('personal','trust')),
        holder_name     TEXT,
        administered_by TEXT,
        evidence_reference TEXT,
        memo            TEXT,
        recorded_by     TEXT NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  /**
   * Declare the capacity a holder subscribed in. `personal` means the holder
   * owns the bond for themselves, so the trust is the obligor and the bond is
   * the holder's asset; `trust` means the trust holds its own paper.
   */
  static async declareCapacity({
    subscriptionId, capacity, administeredBy = null, evidenceReference = null,
    memo = null, recordedBy,
  } = {}) {
    await this.ensureTables();
    const subscription = normalize(subscriptionId);
    if (!subscription) throw new Error('subscriptionId is required');
    const declared = normalize(capacity);
    if (!CAPACITIES.includes(declared)) {
      throw new Error(`capacity must be one of ${CAPACITIES.join(', ')}`);
    }
    const actor = String(recordedBy || '').trim();
    if (!actor) throw new Error('recordedBy is required to declare a holder capacity');

    const found = await pool.query(
      `SELECT s.subscription_id, c.first_name, c.last_name, c.company
         FROM crm_bond_subscriptions s
         JOIN crm_contacts c ON c.contact_id = s.contact_id
        WHERE LOWER(s.subscription_id) = $1`,
      [subscription]
    );
    const row = found.rows[0];
    if (!row) throw new Error(`Subscription ${subscriptionId} not found`);
    const holderName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim()
      || row.company || null;

    const rows = await pool.query(
      `INSERT INTO bond_holder_capacity
         (subscription_id, capacity, holder_name, administered_by, evidence_reference,
          memo, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (subscription_id) DO UPDATE
         SET capacity = EXCLUDED.capacity,
             holder_name = EXCLUDED.holder_name,
             administered_by = EXCLUDED.administered_by,
             evidence_reference = EXCLUDED.evidence_reference,
             memo = EXCLUDED.memo,
             recorded_by = EXCLUDED.recorded_by,
             updated_at = NOW()
       RETURNING *`,
      [row.subscription_id, declared, holderName, administeredBy, evidenceReference, memo, actor]
    );
    return rows.rows[0];
  }

  static async capacities() {
    await this.ensureTables();
    const rows = await pool.query('SELECT * FROM bond_holder_capacity');
    const map = new Map();
    for (const row of rows.rows) map.set(normalize(row.subscription_id), row);
    return map;
  }

  /**
   * Is this name the trust itself? Matched loosely in both directions so
   * "DLB Trust" and "DeAndrea Lavar Barkley Trust Company" both resolve, which
   * is how a holder recorded under the trust's own name is caught.
   */
  static isTrustName(name, trustNames) {
    const value = normalize(name);
    if (!value) return false;
    return trustNames.some((trust) => value.includes(trust) || trust.includes(value));
  }

  /**
   * Everyone who holds a bond, and whether each holder is the trust or someone
   * else. A holder recorded with the trust as their `company` is still the trust
   * holding its own paper unless the contact is a natural person acting for
   * themselves, which the `holder_capacity` note on the subscription states.
   */
  static async holders(bondId, trustNames) {
    const declared = await this.capacities().catch(() => new Map());
    const rows = await pool.query(
      `SELECT s.subscription_id, s.contact_id, s.subscription_amount, s.offering_price,
              s.settlement_date, s.status, s.cash_account_id, s.notes,
              c.first_name, c.last_name, c.company, c.contact_type, c.status AS contact_status
         FROM crm_bond_subscriptions s
         JOIN crm_contacts c ON c.contact_id = s.contact_id
        WHERE s.bond_id = $1 AND s.status IN ('active','pending')
        ORDER BY s.subscription_amount DESC`,
      [bondId]
    );

    return rows.rows.map((row) => {
      const person = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
      // A declared capacity is authoritative: it is the fact the subscription
      // record cannot carry. Absent one, the holder's own name and company
      // decide, so trust-named holders are treated as the trust holding itself.
      const declaration = declared.get(normalize(row.subscription_id)) || null;
      const capacity = declaration ? declaration.capacity : null;
      const trustHeld = capacity
        ? capacity === 'trust'
        : (this.isTrustName(person, trustNames) || this.isTrustName(row.company, trustNames));

      return {
        subscriptionId: row.subscription_id,
        contactId: row.contact_id,
        holderName: person || row.company || row.contact_id,
        holderCompany: row.company || null,
        holderKind: trustHeld ? 'trust' : 'external',
        capacity: capacity || (trustHeld ? 'trust' : 'personal'),
        capacityDeclared: Boolean(declaration),
        administeredBy: declaration ? declaration.administered_by : null,
        subscribedCents: cents(Number(row.subscription_amount || 0) * 100),
        offeringPrice: Number(row.offering_price || 1),
        settlementDate: row.settlement_date,
        cashAccountId: row.cash_account_id || null,
        subscriptionStatus: row.status,
      };
    });
  }

  /**
   * What a subscription actually paid in, from cash movements rather than from
   * the subscription amount. Only value arriving from outside the trust's own
   * cash accounts counts: `from_account_id IS NULL` is an external arrival,
   * while a movement between two trust accounts is the trust moving its own
   * money and pays no subscription.
   */
  static async paidIn(holder) {
    if (!holder.cashAccountId) {
      const byRef = await pool.query(
        `SELECT COALESCE(SUM(amount_cents),0) AS paid
           FROM cash_movements
          WHERE status = 'settled' AND from_account_id IS NULL
            AND reference_id = $1`,
        [holder.subscriptionId]
      );
      return cents(byRef.rows[0] && byRef.rows[0].paid);
    }

    const rows = await pool.query(
      `SELECT COALESCE(SUM(amount_cents),0) AS paid
         FROM cash_movements
        WHERE status = 'settled'
          AND from_account_id IS NULL
          AND to_account_id = $1
          AND (reference_id = $2 OR movement_type = ANY($3::text[]))`,
      [holder.cashAccountId, holder.subscriptionId, SUBSCRIPTION_INFLOW_TYPES]
    );
    return cents(rows.rows[0] && rows.rows[0].paid);
  }

  /**
   * Read one bond as a balance-sheet item. `carryingCents` is what the portfolio
   * already computes, passed in so this engine stays a classifier and does not
   * duplicate the accrual arithmetic.
   */
  static async assess({ bondId, issuer, carryingCents = 0, trustNames = [] }) {
    const issuedByTrust = normalize(issuer) === ''
      ? true // an unnamed issuer is not an established third party
      : this.isTrustName(issuer, trustNames);

    const holderRecords = await this.holders(bondId, trustNames);
    const holders = [];
    let paidInCents = 0;
    for (const holder of holderRecords) {
      const paid = await this.paidIn(holder);
      paidInCents += paid;
      holders.push({
        ...holder,
        paidInCents: paid,
        paidIn: dollars(paid),
        unpaidCents: Math.max(0, holder.subscribedCents - paid),
        unpaid: dollars(Math.max(0, holder.subscribedCents - paid)),
      });
    }

    const externalHolders = holders.filter((h) => h.holderKind === 'external');
    const subscribedCents = holders.reduce((sum, h) => sum + h.subscribedCents, 0);
    const externalSubscribedCents = externalHolders.reduce((sum, h) => sum + h.subscribedCents, 0);
    const externalPaidInCents = externalHolders.reduce((sum, h) => sum + h.paidInCents, 0);

    let classification;
    let note;
    if (!issuedByTrust) {
      classification = 'third_party_asset';
      note = 'Issued by a third party and held by the trust: an asset, and collateral once a'
        + ' securities custodian attests to holding it.';
    } else if (externalHolders.length > 0) {
      classification = 'trust_obligation';
      note = `Issued by the trust and held by ${externalHolders.map((h) => h.holderName).join(', ')}:`
        + ' a liability of the trust, not trust corpus. Corpus is what the subscription paid in,'
        + ' and coupons are amounts the trust owes the holder.';
    } else {
      classification = 'self_issued_self_held';
      note = 'Issued and held by the trust: asset and liability in the same instrument,'
        + ' so it backs no external obligation.';
    }

    const isObligation = classification === 'trust_obligation';
    return {
      bondId,
      issuer: issuer || null,
      issuedByTrust,
      classification,
      holders,
      holderKind: externalHolders.length > 0 ? 'external' : (holders.length ? 'trust' : 'unrecorded'),
      // What the trust owes on the instrument, and what it received for issuing
      // it. The gap is a subscription receivable — a promise, not corpus.
      obligationCents: isObligation ? cents(carryingCents) : 0,
      obligation: dollars(isObligation ? cents(carryingCents) : 0),
      subscribedCents,
      subscribed: dollars(subscribedCents),
      paidInCents,
      paidIn: dollars(paidInCents),
      unpaidSubscriptionCents: Math.max(0, externalSubscribedCents - externalPaidInCents),
      unpaidSubscription: dollars(Math.max(0, externalSubscribedCents - externalPaidInCents)),
      // Corpus contributed by this instrument: cash that actually settled for an
      // externally held subscription, and nothing at all otherwise.
      corpusCents: isObligation ? externalPaidInCents : 0,
      corpus: dollars(isObligation ? externalPaidInCents : 0),
      couponsPayableToHolders: isObligation,
      note,
    };
  }

  /**
   * Is the trust the obligor on this instrument with someone else holding it?
   * Used by the principal & income ledger: an obligor cannot receive its own
   * coupon, so a coupon on such a bond is a disbursement, never a receipt.
   */
  static async obligationFor(bondRef, trustNames) {
    const ref = normalize(bondRef);
    if (!ref) return null;
    const rows = await pool.query(
      `SELECT b.id, b.issuer, b.bond_name, b.isin, b.bond_identifier,
              b.face_value, bb.principal_balance, bb.accrued_interest
         FROM bonds b
         LEFT JOIN bond_balances bb ON bb.bond_id = b.id
        WHERE LOWER(COALESCE(b.isin,'')) = $1
           OR LOWER(COALESCE(b.bond_identifier,'')) = $1
           OR LOWER(COALESCE(b.bond_name,'')) = $1
        LIMIT 1`,
      [ref]
    );
    const row = rows.rows[0];
    if (!row) return null;
    const carryingCents = cents(Number(row.principal_balance || row.face_value || 0) * 100)
      + cents(Number(row.accrued_interest || 0) * 100);
    return this.assess({
      bondId: row.id,
      issuer: row.issuer,
      carryingCents,
      trustNames,
    });
  }
}

module.exports = {
  BondObligationEngine,
  BOND_CLASSIFICATIONS: CLASSIFICATIONS,
  BOND_HOLDER_CAPACITIES: CAPACITIES,
};
