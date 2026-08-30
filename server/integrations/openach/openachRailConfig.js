'use strict';

/**
 * OpenACH rail configuration — the ACH last mile of the in-house family bank
 *
 * The bank's routing matrix already decides that a payment goes out on an ACH
 * rail; this file says what happens after that decision. OpenACH is the ODFI
 * origination platform, so the settings here are the ones that make an entry
 * originatable: which rails OpenACH carries, which payment type each rail maps
 * to on the OpenACH side, and how an effective date is chosen.
 *
 * A payment type id is not cosmetic. OpenACH holds the origination account, the
 * SEC code and the credit/debit direction against the payment type, so
 * originating with the wrong id would send a correctly-ledgered payment out of
 * the wrong account. The rail therefore refuses to originate when the id for
 * that rail is unset rather than falling back to whatever id exists.
 */

const CARRIED_RAILS = Object.freeze(['ach_standard', 'ach_same_day']);

/** Local cutoff for Same Day ACH origination, in minutes past local midnight. */
const SAME_DAY_CUTOFF_MINUTES = 13 * 60 + 45;

function text(name, fallback = '') {
  const raw = process.env[name];
  return raw === undefined || raw === null || raw === '' ? fallback : String(raw).trim();
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function intEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}

function getOpenAchRailConfig() {
  const rails = text('OPENACH_RAILS', CARRIED_RAILS.join(','))
    .split(',')
    .map(rail => rail.trim())
    .filter(rail => CARRIED_RAILS.includes(rail));

  const standardTypeId = text('OPENACH_PAYMENT_TYPE_ID') || null;
  return {
    enabled: boolEnv('OPENACH_RAIL_ENABLED', true),
    rails: rails.length ? rails : CARRIED_RAILS.slice(),
    baseUrl: text('OPENACH_BASE_URL', 'https://dlbtrust-app.fly.dev/openach/api'),
    credentialsPresent: Boolean(text('OPENACH_API_TOKEN') && text('OPENACH_API_KEY')),
    paymentTypeIds: {
      // Same-day origination is a different payment type in OpenACH (its own
      // origination window), so it is configured separately and only falls back
      // to the standard id when the deployment says the two are the same.
      ach_standard: standardTypeId,
      ach_same_day: text('OPENACH_SAME_DAY_PAYMENT_TYPE_ID') || standardTypeId,
    },
    sameDayCutoffMinutes: intEnv('OPENACH_SAME_DAY_CUTOFF_MINUTES', SAME_DAY_CUTOFF_MINUTES, { min: 0, max: 1439 }),
    timezoneOffsetMinutes: intEnv('OPENACH_TZ_OFFSET_MINUTES', -300, { min: -720, max: 840 }),
    // Consumer entries are PPD; a payment to a family entity is CCD. The rail
    // derives this per payment and only uses the default when it cannot tell.
    defaultSecCode: text('OPENACH_DEFAULT_SEC_CODE', 'PPD').toUpperCase(),
    billingState: text('OPENACH_BILLING_STATE', 'OH').toUpperCase(),
    pollBatch: intEnv('OPENACH_POLL_BATCH', 50, { min: 1, max: 500 }),
    maxOriginationAttempts: intEnv('OPENACH_MAX_ORIGINATION_ATTEMPTS', 3, { min: 1, max: 10 }),
  };
}

function openAchRailReadiness() {
  const config = getOpenAchRailConfig();
  const blockers = [];
  if (!config.enabled) blockers.push('OPENACH_RAIL_ENABLED is off: ACH dispatches stay with the operator');
  if (!config.credentialsPresent) blockers.push('OPENACH_API_TOKEN and OPENACH_API_KEY are unset: the rail cannot open an OpenACH session');
  const missingTypes = config.rails.filter(rail => !config.paymentTypeIds[rail]);
  if (missingTypes.length) {
    blockers.push(`no OpenACH payment type id for ${missingTypes.join(', ')}: originating without one would debit the wrong account`);
  }
  return {
    ready: blockers.length === 0,
    blockers,
    rails: config.rails,
    baseUrl: config.baseUrl,
    note: blockers.length === 0
      ? 'Dispatched ACH payments can be originated at the ODFI through OpenACH.'
      : 'The OpenACH rail is closed; dispatched ACH payments wait rather than being originated wrongly.',
  };
}

module.exports = { getOpenAchRailConfig, openAchRailReadiness, CARRIED_RAILS, SAME_DAY_CUTOFF_MINUTES };
