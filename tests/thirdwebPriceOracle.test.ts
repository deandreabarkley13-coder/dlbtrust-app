import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ThirdwebPriceOracle, NATIVE_TOKEN } = require('../server/integrations/dapp/thirdwebPriceOracle');

const saved = { ...process.env };
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, statusText: 'x', json: async () => body } as any;
}
function tokenResult(overrides: Record<string, unknown>) {
  return { result: { tokens: [{ chainId: 1, address: NATIVE_TOKEN, symbol: 'ETH', decimals: 18, priceUsd: 2500, prices: { USD: 2500 }, ...overrides }] } };
}

beforeEach(() => {
  process.env.THIRDWEB_SECRET_KEY = 'tw-secret';
  ThirdwebPriceOracle.clearCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('ThirdwebPriceOracle', () => {
  it('prices native quantities from /v1/tokens with the secret key and caches the quote', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(tokenResult({})));
    const quote = await ThirdwebPriceOracle.quoteUsd({ chainId: 1, quantity: '1500000000000000000' });
    expect(quote).toMatchObject({ symbol: 'ETH', decimals: 18, priceUsd: 2500, amount: 1.5, amountUsd: 3750, source: 'thirdweb' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(`https://api.thirdweb.com/v1/tokens?chainId=1&tokenAddress=${NATIVE_TOKEN}&limit=1`);
    expect(init.headers['x-secret-key']).toBe('tw-secret');
    await ThirdwebPriceOracle.quoteUsd({ chainId: 1, quantity: '1' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('prices ERC-20 quantities using token decimals', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(tokenResult({ address: USDC, symbol: 'USDC', decimals: 6, priceUsd: 0.9998, prices: { USD: 0.9998 } })));
    const quote = await ThirdwebPriceOracle.quoteUsd({ chainId: 1, tokenAddress: USDC, quantity: '5000000' });
    expect(quote.amount).toBe(5);
    expect(quote.amountUsd).toBe(5);
    const inverse = await ThirdwebPriceOracle.quantityForUsd({ chainId: 1, tokenAddress: USDC, amountUsd: 100 });
    expect(inverse.quantity).toBe('100020004');
  });

  it('fails closed when no price, an upstream error, a stale price, or no secret key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ result: { tokens: [] } }));
    await expect(ThirdwebPriceOracle.getPrice({ chainId: 1 })).rejects.toMatchObject({ code: 'PRICE_UNAVAILABLE', status: 422 });
    fetchSpy.mockResolvedValue(jsonResponse({ error: { message: 'unauthorized' } }, 401));
    await expect(ThirdwebPriceOracle.getPrice({ chainId: 1 })).rejects.toThrow(/unauthorized/);
    fetchSpy.mockResolvedValue(jsonResponse(tokenResult({ priceTimestamp: '2020-01-01T00:00:00Z' })));
    await expect(ThirdwebPriceOracle.getPrice({ chainId: 1 })).rejects.toMatchObject({ code: 'PRICE_STALE' });
    delete process.env.THIRDWEB_SECRET_KEY;
    await expect(ThirdwebPriceOracle.getPrice({ chainId: 1 })).rejects.toMatchObject({ status: 503 });
    expect(ThirdwebPriceOracle.readiness().ready).toBe(false);
  });
});
