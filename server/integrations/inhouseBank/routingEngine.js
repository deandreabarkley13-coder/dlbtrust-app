'use strict';

/**
 * Smart Routing, Liquidity Matrix, and Least-Cost / Velocity Routing
 *
 * A payment instruction says who must be paid and how fast; it does not say
 * which rail to use, and it should not. This engine decides, and the decision
 * is auditable: every rail that was considered is returned with its cost, its
 * projected settlement time, and — if it was rejected — the specific reason.
 *
 * The liquidity matrix is the part that makes the choice honest. A rail is only
 * a candidate if the funding behind it can actually pay: the cheapest rail in
 * the catalog is worthless if the account that funds it is short, and picking
 * it would produce an instruction the partner bank returns. Liquidity is
 * attested per rail (`ihb_rail_liquidity`) and falls back to the settlement
 * account balance, never to an assumption.
 *
 * Ranking is least-cost *subject to velocity*: among the rails that can still
 * meet the requested settlement speed, the cheapest wins; if none can, the
 * fastest is offered instead and the decision says the speed target was missed
 * rather than silently downgrading it. Cutoffs are applied before ranking,
 * because a same-day rail after its window is not a same-day rail.
 */

const pool = require('../bonds/pgPool');
const { RAILS, RAIL_IDS, getConfig } = require('./inHouseBankConfig');
const { VirtualAccountManager } = require('./virtualAccountManager');

/** How long "as fast as asked" means, in minutes to final funds. */
const SPEED_TARGET_MINUTES = Object.freeze({
  instant: 5,
  express: 60,
  same_day: 720,
  standard: 2880,
});

class RoutingError extends Error {
  constructor(message, code = 'IHB_NO_ROUTE', status = 409) {
    super(message);
    this.name = 'RoutingError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function costCentsFor(rail, amountCents) {
  return rail.fixedFeeCents + Math.ceil((amountCents * rail.variableBps) / 10000);
}

function localMinutesNow(offsetMinutes, now = new Date()) {
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return ((utcMinutes + offsetMinutes) % 1440 + 1440) % 1440;
}

class RoutingEngine {
  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ihb_rail_liquidity (
        rail                 TEXT PRIMARY KEY,
        funding_account_code TEXT,
        available_cents      BIGINT NOT NULL DEFAULT 0,
        enabled              BOOLEAN NOT NULL DEFAULT TRUE,
        note                 TEXT,
        attested_by          TEXT,
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    return true;
  }

  static async setLiquidity({ rail, availableCents, fundingAccountCode = null, enabled = true, note = null, attestedBy = 'operator' }) {
    await this.ensureTables();
    if (!RAIL_IDS.includes(rail)) throw new RoutingError(`Unknown rail ${rail}`, 'IHB_UNKNOWN_RAIL', 400);
    const amount = Number(availableCents);
    if (!Number.isSafeInteger(amount) || amount < 0) throw new RoutingError('availableCents must be a non-negative integer', 'IHB_BAD_LIQUIDITY', 400);
    const rows = await pool.query(
      `INSERT INTO ihb_rail_liquidity (rail, funding_account_code, available_cents, enabled, note, attested_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (rail) DO UPDATE SET
         funding_account_code = EXCLUDED.funding_account_code,
         available_cents = EXCLUDED.available_cents,
         enabled = EXCLUDED.enabled,
         note = EXCLUDED.note,
         attested_by = EXCLUDED.attested_by,
         updated_at = NOW()
       RETURNING *`,
      [rail, fundingAccountCode, amount, Boolean(enabled), note, attestedBy]
    );
    return rows.rows[0];
  }

  /**
   * The liquidity matrix: every rail against what it costs, when it settles,
   * whether its window is open, and what funding stands behind it right now.
   */
  static async matrix({ amountCents = 0, now = new Date() } = {}) {
    await this.ensureTables();
    const config = getConfig();
    const rows = await pool.query('SELECT * FROM ihb_rail_liquidity');
    const attested = new Map(rows.rows.map(row => [row.rail, row]));

    let pooledCents = null;
    try {
      const position = await VirtualAccountManager.position();
      // What the bank can actually move is what it holds for its account
      // holders, not whatever else happens to sit in the trust cash account.
      pooledCents = [position.depositLiabilityCents, position.settlementBalanceCents, position.virtualBalanceCents]
        .find(value => value !== null && value !== undefined);
    } catch (err) {
      pooledCents = null;
    }

    const minutesNow = localMinutesNow(config.railTimezoneOffsetMinutes, now);
    return config.enabledRails.map(railId => {
      const rail = RAILS[railId];
      const liquidity = attested.get(railId);
      // An unattested rail draws on the pooled settlement account; that is the
      // truth of an in-house bank, where rails share one balance.
      const availableCents = liquidity
        ? Number(liquidity.available_cents)
        : (rail.requiresLiquidity ? (pooledCents === null ? null : Math.max(pooledCents - config.liquidityBufferCents, 0)) : null);
      const cutoffPassed = rail.cutoffMinutes !== null && minutesNow > rail.cutoffMinutes;
      return {
        rail: railId,
        name: rail.name,
        scheme: rail.scheme,
        costCents: costCentsFor(rail, amountCents),
        settlementMinutes: cutoffPassed ? rail.settlementMinutes + 1440 : rail.settlementMinutes,
        baseSettlementMinutes: rail.settlementMinutes,
        cutoffMinutes: rail.cutoffMinutes,
        cutoffPassed,
        maxAmountCents: rail.maxAmountCents,
        reversible: rail.reversible,
        requiresLiquidity: rail.requiresLiquidity,
        liquiditySource: liquidity ? 'attested' : (rail.requiresLiquidity ? 'pooled_settlement' : 'internal'),
        availableCents,
        enabled: liquidity ? Boolean(liquidity.enabled) : true,
        isoMessage: rail.isoMessage,
        note: rail.note,
      };
    });
  }

  /**
   * @param {object} instruction canonical instruction
   * @param {object} [context]
   * @param {boolean} [context.internal]  the creditor is a virtual account here
   * @param {string[]|null} [context.allowedRails]
   * @param {string[]} [context.blockedRails]
   * @param {boolean} [context.recallRequired] governance can still recall the
   *        payment, so an irrevocable rail must not be chosen
   */
  static async decide(instruction, context = {}) {
    const { internal = false, allowedRails = null, blockedRails = [], recallRequired = false, now = new Date() } = context;
    const amountCents = Number(instruction.amountCents);
    const targetMinutes = SPEED_TARGET_MINUTES[instruction.requestedSpeed] ?? SPEED_TARGET_MINUTES.standard;

    if (internal) {
      const rail = RAILS.internal_book;
      return {
        rail: 'internal_book',
        railName: rail.name,
        costCents: 0,
        settlementMinutes: 0,
        meetsRequestedSpeed: true,
        requestedSpeed: instruction.requestedSpeed,
        targetMinutes,
        internal: true,
        candidates: [{ rail: 'internal_book', costCents: 0, settlementMinutes: 0, eligible: true, meetsSpeed: true, reason: rail.note }],
        rejected: [],
        note: 'Both parties are virtual accounts on the same settlement account, so the payment is an on-us book transfer: no rail, no fee, no external exposure.',
      };
    }

    const rows = await this.matrix({ amountCents, now });
    const candidates = [];
    const rejected = [];

    for (const entry of rows) {
      if (entry.rail === 'internal_book') {
        rejected.push({ ...entry, reason: 'The creditor is not a virtual account of this bank, so it cannot be paid on-us.' });
        continue;
      }
      if (!entry.enabled) {
        rejected.push({ ...entry, reason: 'The rail is disabled in the liquidity matrix.' });
        continue;
      }
      if (allowedRails && Array.isArray(allowedRails) && allowedRails.length && !allowedRails.includes(entry.rail)) {
        rejected.push({ ...entry, reason: 'Policy restricts this account to other rails.' });
        continue;
      }
      if (blockedRails.includes(entry.rail)) {
        rejected.push({ ...entry, reason: 'Policy blocks this rail for this payment.' });
        continue;
      }
      if (entry.maxAmountCents !== null && amountCents > entry.maxAmountCents) {
        rejected.push({ ...entry, reason: `Above the rail's ${(entry.maxAmountCents / 100).toFixed(2)} ceiling.` });
        continue;
      }
      if (entry.requiresLiquidity && entry.availableCents !== null && entry.availableCents < amountCents) {
        rejected.push({
          ...entry,
          reason: `Funding behind the rail is ${(entry.availableCents / 100).toFixed(2)}, short of the payment.`,
        });
        continue;
      }
      if (recallRequired && !entry.reversible) {
        rejected.push({ ...entry, reason: 'Irrevocable rails cannot carry a payment that is still recallable.' });
        continue;
      }
      // Instrument compatibility: the beneficiary details have to fit the rail.
      const creditor = instruction.creditor;
      if (['ach_standard', 'ach_same_day', 'rtp'].includes(entry.rail) && !creditor.routingNumber) {
        rejected.push({ ...entry, reason: 'No routing number on the creditor, so a domestic bank credit cannot be built.' });
        continue;
      }
      if (entry.rail === 'fedwire' && !(creditor.routingNumber || creditor.bic)) {
        rejected.push({ ...entry, reason: 'A wire needs a routing number or BIC for the beneficiary bank.' });
        continue;
      }
      if (entry.rail === 'stablecoin' && !creditor.walletAddress) {
        rejected.push({ ...entry, reason: 'No whitelisted wallet address on the creditor.' });
        continue;
      }
      candidates.push({ ...entry, eligible: true, meetsSpeed: entry.settlementMinutes <= targetMinutes });
    }

    if (!candidates.length) {
      throw new RoutingError(
        `No rail can carry this payment: ${rejected.map(entry => `${entry.rail} — ${entry.reason}`).join('; ') || 'no rail is enabled'}`,
        'IHB_NO_ROUTE'
      );
    }

    if (instruction.requestedRail) {
      const forced = candidates.find(entry => entry.rail === instruction.requestedRail);
      if (!forced) {
        const why = rejected.find(entry => entry.rail === instruction.requestedRail);
        throw new RoutingError(
          `Requested rail ${instruction.requestedRail} is not available: ${why ? why.reason : 'it is not in the enabled catalog'}`,
          'IHB_RAIL_UNAVAILABLE'
        );
      }
      return {
        rail: forced.rail,
        railName: forced.name,
        costCents: forced.costCents,
        settlementMinutes: forced.settlementMinutes,
        meetsRequestedSpeed: forced.meetsSpeed,
        requestedSpeed: instruction.requestedSpeed,
        targetMinutes,
        internal: false,
        forced: true,
        candidates,
        rejected,
        note: `${forced.name} was requested explicitly, so least-cost routing was not applied.`,
      };
    }

    const inSpeed = candidates.filter(entry => entry.meetsSpeed);
    const pool_ = inSpeed.length ? inSpeed : candidates;
    // Least cost first; a tie is broken by whichever settles sooner. When
    // nothing meets the requested speed we rank by speed instead, because the
    // caller asked for time and the cheapest slow rail is not an answer.
    const ranked = pool_.slice().sort((a, b) => (
      inSpeed.length
        ? (a.costCents - b.costCents) || (a.settlementMinutes - b.settlementMinutes)
        : (a.settlementMinutes - b.settlementMinutes) || (a.costCents - b.costCents)
    ));
    const chosen = ranked[0];

    return {
      rail: chosen.rail,
      railName: chosen.name,
      costCents: chosen.costCents,
      settlementMinutes: chosen.settlementMinutes,
      meetsRequestedSpeed: Boolean(inSpeed.length),
      requestedSpeed: instruction.requestedSpeed,
      targetMinutes,
      internal: false,
      forced: false,
      candidates: ranked,
      rejected,
      note: inSpeed.length
        ? `${chosen.name} is the cheapest rail that still settles inside the ${targetMinutes}-minute target (fee ${(chosen.costCents / 100).toFixed(2)}).`
        : `No rail settles inside the ${targetMinutes}-minute target; ${chosen.name} is the fastest available at ${chosen.settlementMinutes} minutes and the requested speed will be missed.`,
    };
  }
}

module.exports = { RoutingEngine, RoutingError, SPEED_TARGET_MINUTES };
