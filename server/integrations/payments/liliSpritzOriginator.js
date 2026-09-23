'use strict';

/**
 * Spritz as the originator of the treasury -> Lili ACH credit.
 *
 * Lili (RDFI) receives; the trust has no ODFI bank account of its own, so the
 * credit is originated by Spritz from the trust's USDC on Base:
 *
 *   ERP / policy contract (USDC) --governed distribution--> payout wallet
 *     --Spritz off-ramp (ach_standard | ach_same_day | rtp)--> Lili ****last4
 *     --Lili MCP feed--> reconciliation
 *
 * The Spritz bank account used is the one linked on the Spritz user that
 * matches the registered Lili destination (routing + account last4); nothing
 * else is ever credited. Selected with LILI_ORIGINATOR=spritz.
 */

const { LiliDirectDepositEngine } = require('./liliDirectDepositEngine');

let SpritzTreasuryLegEngine = null;
let SpritzEngine = null;
function loadDeps() {
  if (SpritzTreasuryLegEngine) return;
  try { ({ SpritzTreasuryLegEngine } = require('../spritz/spritzTreasuryLegEngine')); } catch (e) { SpritzTreasuryLegEngine = null; }
  try { ({ SpritzEngine } = require('../spritz/spritzEngine')); } catch (e) { SpritzEngine = null; }
}

const RAILS = ['ach_standard', 'ach_same_day', 'rtp'];
const CHANNEL = 'spritz';

function last4(v) { return v ? String(v).slice(-4) : null; }
function httpError(message, status, code) { return Object.assign(new Error(message), { status, code }); }

class LiliSpritzOriginator {
  static getConfig() {
    const env = process.env;
    const rail = String(env.LILI_SPRITZ_RAIL || 'ach_standard').toLowerCase();
    return {
      channel: CHANNEL,
      enabled: String(env.LILI_ORIGINATOR || 'nacha').toLowerCase() === CHANNEL,
      rail: RAILS.includes(rail) ? rail : 'ach_standard',
      purpose: env.LILI_SPRITZ_PURPOSE || 'operating',
      bucket: env.LILI_SPRITZ_BUCKET || undefined,
    };
  }

  /**
   * The Spritz bank account that IS the Lili destination, or null. Matched on
   * routing/account last4 against LiliDirectDepositEngine.getDestination().
   */
  static async resolveBankAccount() {
    loadDeps();
    if (!SpritzEngine) throw httpError('Spritz engine not available', 503, 'SPRITZ_UNAVAILABLE');
    const dest = await LiliDirectDepositEngine.getDestination();
    if (!dest.configured) return { dest, account: null, candidates: 0 };
    const list = await SpritzEngine.listBankAccounts();
    const accounts = Array.isArray(list) ? list : [];
    const account = accounts.find((b) => {
      if (!b || (b.status && !/active/i.test(String(b.status)))) return false;
      if (String(b.accountNumberLast4 || '') !== String(last4(dest._account))) return false;
      if (b.routingNumberLast4 && String(b.routingNumberLast4) !== String(last4(dest.routingNumber))) return false;
      return true;
    }) || null;
    return { dest, account, candidates: accounts.length };
  }

  static async status() {
    loadDeps();
    const cfg = this.getConfig();
    const issues = [];
    let account = null;
    let capability = null;
    let liquidity = null;
    if (!SpritzTreasuryLegEngine || !SpritzEngine) issues.push('Spritz treasury leg not available');
    else {
      try {
        const r = await this.resolveBankAccount();
        account = r.account;
        if (!r.dest.configured) issues.push('Lili credit destination not configured (LILI_DD_ROUTING_NUMBER / LILI_DD_ACCOUNT_NUMBER)');
        else if (!account) issues.push(`Lili account ****${last4(r.dest._account)} is not linked as a Spritz bank account (${r.candidates} linked)`);
        else if (account.supportedRails && account.supportedRails.length && !account.supportedRails.includes(cfg.rail)) {
          issues.push(`Spritz bank account supports ${account.supportedRails.join(', ')}, not ${cfg.rail}`);
        }
      } catch (e) { issues.push(`spritz bank accounts: ${e.message}`); }
      try {
        const caps = await SpritzEngine.capabilities();
        capability = (Array.isArray(caps) ? caps : []).find((c) => c && c.product === 'crypto_to_fiat' && c.method === 'ach_credit') || null;
        if (!capability) issues.push('Spritz crypto_to_fiat/ach_credit capability not present');
        else if (capability.status !== 'active') issues.push(`Spritz ACH credit off-ramp is ${capability.status}`);
      } catch (e) { issues.push(`spritz capabilities: ${e.message}`); }
      try {
        const readiness = await SpritzTreasuryLegEngine.readiness();
        if (!readiness.ready) issues.push(...(readiness.issues || []).map((i) => `spritz leg: ${i}`));
        liquidity = { policyContract: readiness.policyContract, payoutWallet: readiness.payoutWallet, network: readiness.network };
      } catch (e) { issues.push(`spritz leg: ${e.message}`); }
    }
    return {
      channel: CHANNEL,
      enabled: cfg.enabled,
      ready: issues.length === 0,
      rail: cfg.rail,
      purpose: cfg.purpose,
      bankAccountId: account ? account.id : null,
      bankAccount: account ? { institution: (account.institution && account.institution.name) || null, accountNumberLast4: account.accountNumberLast4 || null, supportedRails: account.supportedRails || [] } : null,
      offramp: capability ? { status: capability.status } : null,
      liquidity,
      issues,
      blocker: issues.length ? issues.join('; ') : null,
    };
  }

  /**
   * Originate one credit. Runs the governed Spritz settlement (funding check,
   * maker proposal, checker approval, release, off-ramp). Returns
   * `originated` once Spritz has the off-ramp, `pending_approval` while the
   * policy contract is waiting on funding/approval/timelock.
   */
  static async send({ amount, reference, description, createdBy = 'api_gateway_clearing' } = {}) {
    loadDeps();
    if (!SpritzTreasuryLegEngine) throw httpError('Spritz treasury leg not available', 503, 'SPRITZ_UNAVAILABLE');
    if (!reference) throw httpError('reference required', 400);
    const cfg = this.getConfig();
    const st = await this.status();
    if (!st.ready) throw httpError(`${st.blocker} — cannot originate the treasury -> Lili credit through Spritz`, 503, 'LILI_SPRITZ_NOT_READY');

    const result = await SpritzTreasuryLegEngine.settle({
      amountUsd: Number(amount),
      bucket: cfg.bucket,
      purpose: cfg.purpose,
      reference,
      rail: cfg.rail,
      memo: [reference, description].filter(Boolean).join(' ').slice(0, 80),
      bankAccountId: st.bankAccountId,
      createdBy,
      transmit: true,
    });

    if (result.status === 'failed') {
      throw httpError(`Spritz settlement failed at ${result.stage}: ${result.detail}`, 502, 'LILI_SPRITZ_FAILED');
    }
    const originated = result.status === 'completed' || result.status === 'submitted';
    return {
      status: originated ? 'originated' : 'pending_approval',
      channel: CHANNEL,
      rail: cfg.rail,
      bankAccountId: st.bankAccountId,
      stage: result.stage,
      detail: result.detail,
      spritzQuoteId: (result.payout && result.payout.spritzQuoteId) || null,
      distributionId: (result.distribution && result.distribution.distributionId) || (result.payout && result.payout.distributionId) || null,
      offRampId: (result.execution && (result.execution.offRampId || result.execution.spritzOffRampId)) || null,
      trail: result.trail || [],
    };
  }
}

module.exports = { LiliSpritzOriginator, LILI_SPRITZ_RAILS: RAILS };
