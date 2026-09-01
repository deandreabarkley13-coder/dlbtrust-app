import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  planFunding, spendableXlm, reservedXlm, XLM_FOR_TRUSTLINE,
} = require('../server/integrations/stablecoin/accountFunding');

/** A Horizon account response, reduced to what funding depends on. */
function account({ xlm = '100', subentries = 0 } = {}) {
  return {
    subentry_count: subentries,
    balances: [{ asset_type: 'native', balance: xlm }],
  };
}

describe('Funding a Stellar account from value the trust already holds', () => {
  it('reserves the base entries and every subentry, not just the base', () => {
    expect(reservedXlm(account({ subentries: 0 }))).toBe(1);
    expect(reservedXlm(account({ subentries: 2 }))).toBe(2);
    expect(spendableXlm(account({ xlm: '10', subentries: 2 }))).toBe(7.9);
  });

  it('reports nothing spendable for a balance that is all reserve', () => {
    // 1.6 XLM against a trustline looks fundable and is not.
    expect(spendableXlm(account({ xlm: '1.6', subentries: 1 }))).toBe(0);
    expect(spendableXlm(account({ xlm: '0.4' }))).toBe(0);
  });

  it('creates a non-existent destination and pays an existing one', () => {
    expect(planFunding({ source: account(), destinationExists: false })).toMatchObject({
      ok: true, operation: 'createAccount', amount: '2.0000000',
    });
    expect(planFunding({ source: account(), destinationExists: true, amount: 0.5 })).toMatchObject({
      ok: true, operation: 'payment', amount: '0.5000000',
    });
  });

  it('refuses to create an account too small to then open a trustline', () => {
    const plan = planFunding({ source: account(), destinationExists: false, amount: 1.1 });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/cannot then open a USDC trustline/);
  });

  it('refuses to spend into the reserve, naming what is actually available', () => {
    const plan = planFunding({ source: account({ xlm: '2.5' }), destinationExists: false });
    expect(plan.ok).toBe(false);
    expect(plan.spendable).toBe(1.4);
    expect(plan.reason).toMatch(/holds 2.5 XLM but can only send 1.4/);
  });

  it('refuses when the funding account does not exist rather than assuming zero', () => {
    expect(planFunding({ source: null, destinationExists: false })).toMatchObject({
      ok: false, reason: expect.stringMatching(/does not exist on this network/),
    });
  });

  it('refuses a non-positive or unreadable amount', () => {
    for (const amount of [0, -2, NaN, 'lots']) {
      expect(planFunding({ source: account(), destinationExists: true, amount })).toMatchObject({
        ok: false, reason: expect.stringMatching(/positive number of XLM/),
      });
    }
  });

  it('needs 2 XLM to create an account: reserve plus a trustline subentry plus fees', () => {
    expect(XLM_FOR_TRUSTLINE).toBe(2);
  });
});
