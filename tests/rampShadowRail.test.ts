import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const pool = require('../server/integrations/bonds/pgPool');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const { OnOffRampEngine } = require('../server/integrations/dapp/onOffRampEngine');

// The internal shadow rail moves no value: it exists so the ramp
// quote/propose/approve/execute lifecycle and its fee journal can be exercised
// without provider credentials and without any *_LIVE flag being set.
describe('internal shadow ramp rail', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.RAMP_FEE_BPS = '50';
    delete process.env.RAMP_FEE_BOOKING_ENABLED;
    vi.spyOn(pool, 'query').mockResolvedValue({ rows: [], rowCount: 0 } as any);
  });

  it('is always offered as a ready provider', async () => {
    const providers = await OnOffRampEngine.providers();
    const shadow = providers.find((p: any) => p.id === 'trust_shadow');
    expect(shadow).toMatchObject({ ready: true, issues: [] });
  });

  it('quotes a ready route carrying the configured fee', async () => {
    const quote = await OnOffRampEngine.quote({
      direction: 'onramp',
      sourceAsset: 'USD',
      targetAsset: 'USDC',
      amount: '1000',
    });
    const route = quote.routes.find((r: any) => r.provider === 'trust_shadow');
    expect(route.status).toBe('ready');
    expect(route.fee).toMatchObject({ feeBps: 50, feeAmount: 5, netAmount: 995 });
  });

  it('books the fee on execution without touching an external provider', async () => {
    const post = vi
      .spyOn(TrustAccountingEngine, 'postJournalEntry')
      .mockResolvedValue({ entry_id: 'JRN-SHADOW' } as any);

    const outcome = await OnOffRampEngine._execute({
      id: 'PROP-SHADOW',
      payload: {
        direction: 'onramp',
        provider: 'trust_shadow',
        amount: '1000',
        sourceAsset: 'USD',
        fee: { feeBps: 50 },
      },
    });

    expect(outcome.status).toBe('shadow_recorded');
    expect(outcome.fee).toMatchObject({ status: 'booked', feeAmount: 5, entryId: 'JRN-SHADOW' });
    expect(post).toHaveBeenCalledTimes(1);
  });
});
