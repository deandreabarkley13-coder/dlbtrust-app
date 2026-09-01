import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  muxedAddress, parseMuxed, describeAddress, paymentCreditsAddress, MuxedAddressError,
} = require('../server/integrations/stablecoin/muxedAccount');
const {
  StablecoinPayoutRail,
  CIRCLE_USDC_ISSUERS,
} = require('../server/integrations/os/stablecoinPayoutRail');

const BASE = 'GDMFQ3WV53KJ6XJUVH6JTPVK2ZNQS6QGG5FH7X26FTBQ2MYBOIJWAEGR';
const OTHER_BASE = 'GCZ3EX6GNY7TDSIY54QLA2SK7XJVIZONUU6TDI6QL4TQI6H3TYUOGXQZ';
const DISTRIBUTOR = 'GANCFNWGTHXEZH7EL3L5WTUKUBAUUBQUH562XBKAP62NB7ZEGLB2TVXK';
const DISTRIBUTOR_SECRET = 'SDU7P3JYWUEBWNYFUYWOWWO2DGBNINFUTNECO5WYBJBLGSJQGP5MPDTC';
const MUXED = muxedAddress(BASE, '7');

describe('Muxed addresses', () => {
  it('routes an id within a base account, and reads back the same pair', () => {
    expect(MUXED.startsWith('M')).toBe(true);
    expect(MUXED).toHaveLength(69);
    expect(parseMuxed(MUXED)).toEqual({ baseAddress: BASE, id: '7' });
  });

  it('carries a 64-bit id as a string, since a number would lose the payee', () => {
    const big = '18446744073709551615';
    expect(parseMuxed(muxedAddress(BASE, big)).id).toBe(big);
    expect(() => muxedAddress(BASE, '18446744073709551616')).toThrow(/exceeds the maximum/);
    expect(() => muxedAddress(BASE, '1.5')).toThrow(/whole number/);
  });

  it('refuses anything that is not an address rather than deriving one', () => {
    expect(() => muxedAddress('not-an-address', '1')).toThrow(MuxedAddressError);
    expect(() => parseMuxed(BASE)).toThrow(/not a muxed address/);
    expect(() => describeAddress(`${BASE}X`)).toThrow(/not a Stellar address/);
    // Right shape, wrong checksum: a muxed address is decoded, so this is caught.
    expect(() => parseMuxed(`M${MUXED.slice(1, 68)}A`)).toThrow(/not a muxed address/);
  });

  it('describes both kinds the same way, naming the account that holds the money', () => {
    expect(describeAddress(BASE)).toEqual({
      address: BASE, muxed: false, baseAddress: BASE, muxedId: null,
    });
    expect(describeAddress(MUXED)).toEqual({
      address: MUXED, muxed: true, baseAddress: BASE, muxedId: '7',
    });
  });

  describe('matching a Horizon payment', () => {
    it('accepts a muxed payment, which Horizon reports against the base account', () => {
      const record = { to: BASE, to_muxed: MUXED, to_muxed_id: '7' };
      expect(paymentCreditsAddress(record, MUXED)).toBe(true);
      // Horizon has been known to omit to_muxed; the id still identifies it.
      expect(paymentCreditsAddress({ to: BASE, to_muxed_id: '7' }, MUXED)).toBe(true);
    });

    it('refuses a payment to the base account when a subaccount was owed', () => {
      expect(paymentCreditsAddress({ to: BASE }, MUXED)).toBe(false);
      expect(paymentCreditsAddress({ to: BASE, to_muxed_id: '8' }, MUXED)).toBe(false);
      expect(paymentCreditsAddress({ to: OTHER_BASE, to_muxed_id: '7' }, MUXED)).toBe(false);
    });

    it('still matches a plain account payment', () => {
      expect(paymentCreditsAddress({ to: BASE }, BASE)).toBe(true);
      expect(paymentCreditsAddress({ to: OTHER_BASE }, BASE)).toBe(false);
    });
  });
});

describe('The USDC rail with a muxed payee', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.STABLECOIN_ENABLED = 'true';
    process.env.STABLECOIN_MODE = 'testnet';
    process.env.STABLECOIN_NETWORK = 'testnet';
    process.env.STABLECOIN_ASSET_CODE = 'USDC';
    process.env.STABLECOIN_ISSUER_PUBLIC = CIRCLE_USDC_ISSUERS.testnet;
    process.env.STABLECOIN_DISTRIBUTOR_PUBLIC = DISTRIBUTOR;
    process.env.STABLECOIN_DISTRIBUTOR_SECRET = DISTRIBUTOR_SECRET;
    process.env.PAYER_OS_WALLETS = JSON.stringify({
      'cousin-a': {
        name: 'Cousin A',
        address: MUXED,
        network: 'testnet',
        asset: 'USDC',
        glAccountCode: '5300',
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  it('registers a muxed wallet and names the account that can spend it', () => {
    const wallet = StablecoinPayoutRail.wallet('cousin-a');
    expect(wallet.address).toBe(MUXED);
    expect(wallet.baseAddress).toBe(BASE);
    expect(wallet.muxed).toBe(true);
    expect(wallet.muxedId).toBe('7');
  });

  it('rejects a wallet whose address is neither an account nor muxed', () => {
    process.env.PAYER_OS_WALLETS = JSON.stringify({
      broken: { name: 'Broken', address: 'MNOPE', network: 'testnet', asset: 'USDC', glAccountCode: '5300' },
    });
    expect(() => StablecoinPayoutRail.wallet('broken')).toThrow(/G… account or an M… muxed address/);
  });

  it('confirms a muxed payment that Horizon reports against the base account', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = String(url);
      if (/\/operations/.test(path)) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            _embedded: {
              records: [{
                type: 'payment',
                to: BASE,
                to_muxed: MUXED,
                to_muxed_id: '7',
                amount: '0.3400000',
                asset_code: 'USDC',
                asset_issuer: CIRCLE_USDC_ISSUERS.testnet,
              }],
            },
          }),
        } as any;
      }
      if (/\/transactions\//.test(path)) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ successful: true, ledger: 1, created_at: '2026-09-01T00:00:00Z' }),
        } as any;
      }
      return { status: 404, ok: false } as any;
    }));

    const confirmation = await StablecoinPayoutRail.verify({
      reference: 'abc123',
      wallet: StablecoinPayoutRail.wallet('cousin-a'),
      amountCents: 34,
    });
    expect(confirmation.confirmed).toBe(true);
    expect(confirmation.to).toBe(MUXED);
    expect(confirmation.toBase).toBe(BASE);
    expect(confirmation.toMuxedId).toBe('7');
  });
});
