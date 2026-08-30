'use strict';

/**
 * In-House Bank Orchestration — configuration and rail catalog
 *
 * The PTC family bank is an in-house bank: the family's members, entities and
 * purposes hold *virtual* accounts inside a single settlement account at the
 * partner bank. Anything moving between two of those virtual accounts never
 * leaves the trust, and anything leaving must be pushed out over an external
 * rail. The catalog below is what the routing matrix scores: what each rail
 * costs, how fast it settles, what it will carry, and when it closes.
 *
 * Costs are in cents plus basis points, speed is in minutes to final funds,
 * cutoffs are local bank time in the RAIL_TIMEZONE.
 */

const RAILS = Object.freeze({
  internal_book: {
    rail: 'internal_book',
    name: 'On-us book transfer',
    scheme: 'internal',
    fixedFeeCents: 0,
    variableBps: 0,
    settlementMinutes: 0,
    maxAmountCents: null,
    cutoffMinutes: null, // an in-house posting has no cutoff; it is our own ledger
    reversible: true,
    isoMessage: 'pacs.008.internal',
    requiresLiquidity: false,
    note: 'Both sides are virtual accounts on the same settlement account: a book entry, not a payment.',
  },
  ach_standard: {
    rail: 'ach_standard',
    name: 'ACH (next day)',
    scheme: 'nacha',
    fixedFeeCents: 25,
    variableBps: 0,
    settlementMinutes: 1440,
    maxAmountCents: 100000000,
    cutoffMinutes: 15 * 60,
    reversible: true,
    isoMessage: 'pacs.008.001.08',
    requiresLiquidity: true,
    note: 'Cheapest external rail; returns are possible for two banking days.',
  },
  ach_same_day: {
    rail: 'ach_same_day',
    name: 'Same Day ACH',
    scheme: 'nacha',
    fixedFeeCents: 100,
    variableBps: 0,
    settlementMinutes: 360,
    maxAmountCents: 100000000,
    cutoffMinutes: 13 * 60 + 45,
    reversible: true,
    isoMessage: 'pacs.008.001.08',
    requiresLiquidity: true,
    note: 'Same-day windows close early; after cutoff it is tomorrow regardless of price.',
  },
  rtp: {
    rail: 'rtp',
    name: 'RTP / instant credit transfer',
    scheme: 'rtp',
    fixedFeeCents: 45,
    variableBps: 0,
    settlementMinutes: 1,
    maxAmountCents: 100000000,
    cutoffMinutes: null,
    reversible: false,
    isoMessage: 'pacs.008.001.08',
    requiresLiquidity: true,
    note: 'Irrevocable once accepted, so it is never chosen for a payment that governance can still recall.',
  },
  fedwire: {
    rail: 'fedwire',
    name: 'Fedwire funds transfer',
    scheme: 'fedwire',
    fixedFeeCents: 1500,
    variableBps: 0,
    settlementMinutes: 30,
    maxAmountCents: null,
    cutoffMinutes: 17 * 60,
    reversible: false,
    isoMessage: 'pacs.008.001.08',
    requiresLiquidity: true,
    note: 'No amount ceiling and same-day finality; the most expensive way to move small money.',
  },
  stablecoin: {
    rail: 'stablecoin',
    name: 'Stablecoin settlement',
    scheme: 'onchain',
    fixedFeeCents: 5,
    variableBps: 10,
    settlementMinutes: 5,
    maxAmountCents: 25000000,
    cutoffMinutes: null,
    reversible: false,
    isoMessage: 'pacs.008.onchain',
    requiresLiquidity: true,
    note: 'Settles outside banking hours; the beneficiary must have a wallet the trust has whitelisted.',
  },
});

const RAIL_IDS = Object.freeze(Object.keys(RAILS));

function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function listEnv(name) {
  return String(process.env[name] || '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
}

function getConfig() {
  return {
    bankName: process.env.IHB_BANK_NAME || 'PTC In-House Family Bank',
    bankBic: process.env.IHB_BANK_BIC || 'PTCUUS41XXX',
    // Every virtual account is a claim on this one real account at the partner bank.
    settlementAccountCode: process.env.IHB_SETTLEMENT_ACCOUNT_CODE || '1000',
    settlementRouting: process.env.IHB_SETTLEMENT_ROUTING || '',
    currency: (process.env.IHB_CURRENCY || 'USD').toUpperCase(),
    virtualAccountPrefix: process.env.IHB_VIRTUAL_ACCOUNT_PREFIX || '8842',

    // Zero trust
    serviceToken: process.env.IHB_SERVICE_TOKEN || '',
    signingSecret: process.env.IHB_SIGNING_SECRET || '',
    // Machine callers always sign. Operator sessions are already authenticated
    // by the app session, and a browser cannot hold the signing secret, so
    // signing them is opt-in for deployments that front the API with a signer.
    requireSessionSignature: boolEnv('IHB_REQUIRE_SESSION_SIGNATURE', false),
    signatureMaxAgeSeconds: intEnv('IHB_SIGNATURE_MAX_AGE_SECONDS', 300, { min: 30, max: 3600 }),
    mtlsRequired: boolEnv('IHB_REQUIRE_MTLS', false),
    trustedClientFingerprints: listEnv('IHB_TRUSTED_CLIENT_FINGERPRINTS'),
    allowedOriginators: listEnv('IHB_ALLOWED_ORIGINATORS'),

    // Governance
    dualApprovalThresholdCents: intEnv('IHB_DUAL_APPROVAL_THRESHOLD_CENTS', 2500000),
    requiredApprovals: intEnv('IHB_REQUIRED_APPROVALS', 2, { min: 1, max: 5 }),
    singlePaymentLimitCents: intEnv('IHB_SINGLE_PAYMENT_LIMIT_CENTS', 500000000),
    dailyOutflowLimitCents: intEnv('IHB_DAILY_OUTFLOW_LIMIT_CENTS', 1000000000),
    velocityWindowMinutes: intEnv('IHB_VELOCITY_WINDOW_MINUTES', 60, { min: 1, max: 1440 }),
    velocityMaxPayments: intEnv('IHB_VELOCITY_MAX_PAYMENTS', 25, { min: 1, max: 10000 }),
    velocityMaxAmountCents: intEnv('IHB_VELOCITY_MAX_AMOUNT_CENTS', 250000000),
    screeningRequired: boolEnv('IHB_SCREENING_REQUIRED', true),
    blockedCountries: listEnv('IHB_BLOCKED_COUNTRIES').map(code => code.toUpperCase()),

    // Routing
    enabledRails: (() => {
      const configured = listEnv('IHB_ENABLED_RAILS').filter(rail => RAIL_IDS.includes(rail));
      return configured.length ? configured : RAIL_IDS.slice();
    })(),
    liquidityBufferCents: intEnv('IHB_LIQUIDITY_BUFFER_CENTS', 0),
    railTimezoneOffsetMinutes: intEnv('IHB_RAIL_TZ_OFFSET_MINUTES', -300, { min: -720, max: 840 }),

    // Dual ledger
    mirrorToGeneralLedger: boolEnv('IHB_MIRROR_TO_GL', true),
    glClearingAccountCode: process.env.IHB_GL_CLEARING_ACCOUNT || '2050',
    glOutflowAccountCode: process.env.IHB_GL_OUTFLOW_ACCOUNT || '5200',
  };
}

function readiness() {
  const config = getConfig();
  const blockers = [];
  if (!config.signingSecret && (config.serviceToken || config.requireSessionSignature)) {
    blockers.push('IHB_SIGNING_SECRET is unset while signed ingress is required');
  }
  if (!config.serviceToken && !process.env.ADMIN_SECRET_TOKEN) {
    blockers.push('no IHB_SERVICE_TOKEN and no ADMIN_SECRET_TOKEN: machine callers cannot authenticate');
  }
  if (!config.settlementAccountCode) {
    blockers.push('IHB_SETTLEMENT_ACCOUNT_CODE is unset: virtual balances would have no real account behind them');
  }
  return {
    ready: blockers.length === 0,
    blockers,
    bankName: config.bankName,
    rails: config.enabledRails,
    note: blockers.length === 0
      ? 'The in-house bank can accept signed instructions and post them against the settlement account.'
      : 'Ingress is closed until the listed configuration is supplied; zero trust fails closed.',
  };
}

module.exports = { RAILS, RAIL_IDS, getConfig, readiness };
