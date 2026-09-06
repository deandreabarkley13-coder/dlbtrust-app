import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const POLICY = { purpose: 'medical' };

const { ThirdwebServerWalletEngine, DEFAULT_API_URL, DEFAULT_IDENTIFIER } = require('../server/integrations/dapp/thirdwebServerWalletEngine');
const { ThirdwebPriceOracle } = require('../server/integrations/dapp/thirdwebPriceOracle');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };
const WALLET = '0x1A904F795a0511C31Ba6347504D08d1bA58E4f89';
const RECIPIENT = '0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, statusText: 'x', json: async () => body } as any;
}

beforeEach(() => {
  vi.spyOn(pool, 'query').mockResolvedValue({ rows: [], rowCount: 0 } as any);
  process.env.DAPP_CHAIN_ID = '1';
  process.env.THIRDWEB_SECRET_KEY = 'tw-secret';
  process.env.THIRDWEB_SERVER_WALLET_ADDRESS = WALLET;
  delete process.env.THIRDWEB_SERVER_WALLET_LIVE;
  delete process.env.THIRDWEB_SERVER_WALLET_MAX_QUANTITY;
  delete process.env.THIRDWEB_SERVER_WALLET_ALLOWED_RECIPIENTS;
  delete process.env.THIRDWEB_PRICE_FALLBACK_TO_CALLER;
  // Test asset: 0 decimals at $1/unit so quantity == USD.
  vi.spyOn(ThirdwebPriceOracle, 'getPrice').mockResolvedValue({
    chainId: 1, tokenAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', symbol: 'TST', decimals: 0, priceUsd: 1, source: 'thirdweb', fetchedAt: Date.now(),
  } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('thirdweb server wallet readiness', () => {
  it('is shadow by default and cannot send without the live flag', () => {
    const status = ThirdwebServerWalletEngine.readiness();
    expect(status.provider).toBe('thirdweb-server-wallet');
    expect(status.apiUrl).toBe(DEFAULT_API_URL);
    expect(status.identifier).toBe(DEFAULT_IDENTIFIER);
    expect(status.address).toBe(WALLET);
    expect(status.shadow).toBe(true);
    expect(status.canSend).toBe(false);
    expect(status.ready).toBe(true);
  });

  it('reports a missing secret key and an invalid pinned address', () => {
    delete process.env.THIRDWEB_SECRET_KEY;
    process.env.THIRDWEB_SERVER_WALLET_ADDRESS = 'not-an-address';
    const status = ThirdwebServerWalletEngine.readiness();
    expect(status.ready).toBe(false);
    expect(status.issues).toEqual(expect.arrayContaining([
      expect.stringMatching(/THIRDWEB_SECRET_KEY/),
      expect.stringMatching(/THIRDWEB_SERVER_WALLET_ADDRESS/),
    ]));
  });

  it('can send once live with a secret key and a pinned address', () => {
    process.env.THIRDWEB_SERVER_WALLET_LIVE = 'true';
    expect(ThirdwebServerWalletEngine.readiness().canSend).toBe(true);
  });
});

describe('thirdweb server wallet reads', () => {
  it('sends the secret key header and unwraps result for ensureWallet', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      result: { address: WALLET.toLowerCase(), smartAccountAddress: RECIPIENT.toLowerCase(), createdAt: '2026-01-01' },
    }));
    const wallet = await ThirdwebServerWalletEngine.ensureWallet('treasury');
    expect(wallet).toEqual({ identifier: 'treasury', address: WALLET, smartAccountAddress: RECIPIENT, createdAt: '2026-01-01' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${DEFAULT_API_URL}/v1/wallets/server`);
    expect(init.method).toBe('POST');
    expect(init.headers['x-secret-key']).toBe('tw-secret');
    expect(init.headers['x-vault-access-token']).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ identifier: 'treasury' });
  });

  it('forwards the vault access token when configured', async () => {
    process.env.THIRDWEB_VAULT_ACCESS_TOKEN = 'vault-token';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ result: { wallets: [], pagination: null } }));
    await ThirdwebServerWalletEngine.listWallets();
    expect(fetchSpy.mock.calls[0][1].headers['x-vault-access-token']).toBe('vault-token');
  });

  it('reads the pinned wallet balance on the configured chain', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      result: [{ chainId: 1, tokenAddress: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18, value: '10', displayValue: '0.00000000000000001' }],
    }));
    const rows = await ThirdwebServerWalletEngine.balance();
    expect(rows[0].symbol).toBe('ETH');
    expect(fetchSpy.mock.calls[0][0]).toBe(`${DEFAULT_API_URL}/v1/wallets/${WALLET}/balance?chainId=1`);
  });

  it('surfaces thirdweb API errors with the upstream status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: { message: 'unauthorized' } }, 401));
    await expect(ThirdwebServerWalletEngine.listWallets()).rejects.toMatchObject({ status: 401, message: /unauthorized/ });
  });

  it('refuses to call thirdweb without a secret key', async () => {
    delete process.env.THIRDWEB_SECRET_KEY;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(ThirdwebServerWalletEngine.listWallets()).rejects.toThrow(/THIRDWEB_SECRET_KEY/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// Moving value is the whole risk of this wallet: the live flag is the last
// gate and nothing may reach thirdweb before it is set.
describe('thirdweb server wallet send', () => {
  it('records a shadow transfer and contacts nothing while not live', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const record = await ThirdwebServerWalletEngine.send({ ...POLICY, to: RECIPIENT, quantity: '1000', reference: 'PAY-1' });
    expect(record.shadow).toBe(true);
    expect(record.status).toBe('shadow');
    expect(record.from).toBe(WALLET);
    expect(record.to).toBe(RECIPIENT);
    expect(record.asset).toBe('native');
    expect(record.transactionId).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO thirdweb_server_wallet_transfers/), expect.any(Array));
  });

  it('submits a native transfer through /v1/wallets/send when live', async () => {
    process.env.THIRDWEB_SERVER_WALLET_LIVE = 'true';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ result: { transactionIds: ['tx-1'] } }));
    const record = await ThirdwebServerWalletEngine.send({ ...POLICY, to: RECIPIENT, quantity: '0x10' });
    expect(record.shadow).toBe(false);
    expect(record.status).toBe('submitted');
    expect(record.transactionId).toBe('tx-1');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${DEFAULT_API_URL}/v1/wallets/send`);
    expect(JSON.parse(init.body)).toEqual({ from: WALLET, chainId: 1, recipients: [{ address: RECIPIENT, quantity: '16' }] });
  });

  it('adds tokenAddress for ERC-20 transfers', async () => {
    process.env.THIRDWEB_SERVER_WALLET_LIVE = 'true';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ result: { transactionIds: ['tx-2'] } }));
    (ThirdwebPriceOracle.getPrice as any).mockResolvedValue({ chainId: 8453, tokenAddress: USDC, symbol: 'USDC', decimals: 6, priceUsd: 1, source: 'thirdweb' });
    const record = await ThirdwebServerWalletEngine.send({ ...POLICY, to: RECIPIENT, quantity: '5000000', tokenAddress: USDC.toLowerCase(), chainId: 8453 });
    expect(record.asset).toBe('erc20');
    expect(record.amountUsd).toBe(5);
    expect(ThirdwebPriceOracle.getPrice).toHaveBeenCalledWith({ chainId: 8453, tokenAddress: USDC.toLowerCase() });
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toMatchObject({ chainId: 8453, tokenAddress: USDC });
  });

  it('records and rethrows a failed live submission', async () => {
    process.env.THIRDWEB_SERVER_WALLET_LIVE = 'true';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: { message: 'insufficient funds' } }, 400));
    await expect(ThirdwebServerWalletEngine.send({ ...POLICY, to: RECIPIENT, quantity: '1' })).rejects.toThrow(/insufficient funds/);
    const inserted = (pool.query as any).mock.calls.find(([sql]: [string]) => /INSERT INTO thirdweb_server_wallet_transfers/.test(sql));
    expect(inserted[1]).toEqual(expect.arrayContaining(['failed']));
  });

  it('enforces the per-transfer ceiling and recipient allowlist before any call', async () => {
    process.env.THIRDWEB_SERVER_WALLET_LIVE = 'true';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    process.env.THIRDWEB_SERVER_WALLET_MAX_QUANTITY = '100';
    await expect(ThirdwebServerWalletEngine.send({ ...POLICY, to: RECIPIENT, quantity: '101' })).rejects.toThrow(/MAX_QUANTITY/);
    delete process.env.THIRDWEB_SERVER_WALLET_MAX_QUANTITY;
    process.env.THIRDWEB_SERVER_WALLET_ALLOWED_RECIPIENTS = WALLET;
    await expect(ThirdwebServerWalletEngine.send({ ...POLICY, to: RECIPIENT, quantity: '1' })).rejects.toThrow(/ALLOWED_RECIPIENTS/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('enforces the trust distribution policy: $100K beneficiary / $500K trustee, known purpose', async () => {
    process.env.THIRDWEB_SERVER_WALLET_LIVE = 'true';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ result: { transactionIds: ['tx-p'] } }));
    await expect(ThirdwebServerWalletEngine.send({ to: RECIPIENT, quantity: '100001', purpose: 'home' }))
      .rejects.toMatchObject({ code: 'DISTRIBUTION_LIMIT_EXCEEDED', status: 422 });
    await expect(ThirdwebServerWalletEngine.send({ to: RECIPIENT, quantity: '500001', purpose: 'home', requesterRole: 'trustee_maker' }))
      .rejects.toThrow(/\$500,000/);
    await expect(ThirdwebServerWalletEngine.send({ to: RECIPIENT, quantity: '10', purpose: 'yacht' }))
      .rejects.toThrow(/not permitted/);
    await expect(ThirdwebServerWalletEngine.send({ to: RECIPIENT, quantity: '10' }))
      .rejects.toThrow(/purpose required/);
    expect(fetchSpy).not.toHaveBeenCalled();

    const ok = await ThirdwebServerWalletEngine.send({ to: RECIPIENT, quantity: '450000', purpose: 'Education', requesterRole: 'trustee' });
    expect(ok).toMatchObject({ requesterRole: 'trustee', amountUsd: 450000, priceUsd: 1, priceSource: 'thirdweb', purpose: 'education', limitUsd: 500000, transactionId: 'tx-p' });
    const inserted = (pool.query as any).mock.calls.find(([sql]: [string]) => /INSERT INTO thirdweb_server_wallet_transfers/.test(sql));
    expect(inserted[1]).toEqual(expect.arrayContaining(['trustee', 450000, 'education']));
  });

  it('prices sends with the oracle: caller USD is cross-checked, and only trusted as an explicit fallback', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(ThirdwebServerWalletEngine.send({ ...POLICY, to: RECIPIENT, quantity: '1000', amountUsd: 500 }))
      .rejects.toMatchObject({ code: 'PRICE_MISMATCH', status: 422 });
    const close = await ThirdwebServerWalletEngine.send({ ...POLICY, to: RECIPIENT, quantity: '1000', amountUsd: 1020 });
    expect(close).toMatchObject({ amountUsd: 1000, priceSource: 'thirdweb' });

    (ThirdwebPriceOracle.getPrice as any).mockRejectedValue(Object.assign(new Error('no USD price'), { code: 'PRICE_UNAVAILABLE' }));
    await expect(ThirdwebServerWalletEngine.send({ ...POLICY, to: RECIPIENT, quantity: '1000', amountUsd: 1000 }))
      .rejects.toThrow(/no USD price/);
    process.env.THIRDWEB_PRICE_FALLBACK_TO_CALLER = 'true';
    await expect(ThirdwebServerWalletEngine.send({ ...POLICY, to: RECIPIENT, quantity: '1000' })).rejects.toThrow(/no USD price/);
    const fallback = await ThirdwebServerWalletEngine.send({ ...POLICY, to: RECIPIENT, quantity: '1000', amountUsd: 999 });
    expect(fallback).toMatchObject({ amountUsd: 999, priceSource: 'caller', priceUsd: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects bad recipients and non-integer quantities', async () => {
    await expect(ThirdwebServerWalletEngine.send({ ...POLICY, to: 'nope', quantity: '1' })).rejects.toThrow(/recipient/);
    await expect(ThirdwebServerWalletEngine.send({ ...POLICY, to: RECIPIENT, quantity: '1.5' })).rejects.toThrow(/smallest units/);
    await expect(ThirdwebServerWalletEngine.send({ ...POLICY, to: RECIPIENT, quantity: '0' })).rejects.toThrow(/positive/);
  });
});

describe('thirdweb server wallet transaction tracking', () => {
  it('polls until a terminal status and updates the stored transfer', async () => {
    const statuses = [{ status: 'QUEUED' }, { status: 'SUBMITTED' }, { status: 'CONFIRMED', transactionHash: '0xabc' }];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ result: { id: 'tx-1', chainId: '1', ...statuses.shift() } }));
    const final = await ThirdwebServerWalletEngine.waitForTransaction('tx-1', { intervalMs: 1, timeoutMs: 1000 });
    expect(final.status).toBe('CONFIRMED');
    expect(final.transactionHash).toBe('0xabc');
    expect(pool.query).toHaveBeenCalledWith(expect.stringMatching(/UPDATE thirdweb_server_wallet_transfers/), ['tx-1', 'confirmed', '0xabc', null]);
  });
});
