import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const { ThirdwebRailEngine, centsToQuantity } = require('../server/integrations/stablecoin/thirdwebRailEngine');
const { StablecoinGateway } = require('../server/integrations/stablecoin/stablecoinGateway');
const { isThirdwebNetwork, isCircleNetwork, isHederaNetwork } = require('../server/integrations/stablecoin/config');
const { ThirdwebServerWalletEngine } = require('../server/integrations/dapp/thirdwebServerWalletEngine');
const { ThirdwebPriceOracle } = require('../server/integrations/dapp/thirdwebPriceOracle');
const { SourceOfFundsAdapter } = require('../server/integrations/stablecoin/sourceOfFundsAdapter');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };
const WALLET = '0x1A904F795a0511C31Ba6347504D08d1bA58E4f89';
const RECIPIENT = '0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

beforeEach(() => {
  vi.spyOn(pool, 'query').mockResolvedValue({ rows: [], rowCount: 0 } as any);
  process.env.STABLECOIN_ENABLED = 'true';
  process.env.STABLECOIN_MODE = 'testnet';
  process.env.STABLECOIN_NETWORK = 'testnet';
  process.env.THIRDWEB_RAIL_ENABLED = 'true';
  process.env.THIRDWEB_RAIL_TOKEN_ADDRESS = USDC;
  process.env.THIRDWEB_SECRET_KEY = 'tw-secret';
  process.env.THIRDWEB_SERVER_WALLET_ADDRESS = WALLET;
  process.env.THIRDWEB_SERVER_WALLET_ENABLED = 'true';
  delete process.env.THIRDWEB_SERVER_WALLET_LIVE;
  delete process.env.THIRDWEB_SERVER_WALLET_MAX_QUANTITY;
  delete process.env.THIRDWEB_SERVER_WALLET_ALLOWED_RECIPIENTS;
  delete process.env.THIRDWEB_RAIL_WAIT_MS;
  vi.spyOn(ThirdwebPriceOracle, 'getPrice').mockResolvedValue({
    chainId: 1, tokenAddress: USDC, symbol: 'USDC', decimals: 6, priceUsd: 1, source: 'thirdweb', fetchedAt: Date.now(),
  } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('network helpers', () => {
  it('recognises the thirdweb network without stealing circle/hedera', () => {
    expect(isThirdwebNetwork('thirdweb')).toBe(true);
    expect(isThirdwebNetwork('thirdweb-base')).toBe(true);
    expect(isThirdwebNetwork('circle')).toBe(false);
    expect(isCircleNetwork('thirdweb')).toBe(false);
    expect(isHederaNetwork('thirdweb')).toBe(false);
  });

  it('converts cents to token units', () => {
    expect(centsToQuantity(12345, 6)).toBe(123450000n);
    expect(centsToQuantity(1, 2)).toBe(1n);
    expect(() => centsToQuantity(0, 6)).toThrow(/positive/);
  });
});

describe('ThirdwebRailEngine readiness', () => {
  it('is ready but shadow when the server wallet is not live', () => {
    const r = new ThirdwebRailEngine().readiness();
    expect(r.ready).toBe(true);
    expect(r.live).toBe(false);
    expect(r.shadow).toBe(true);
    expect(r.tokenAddress).toBe(USDC);
    expect(r.sourceAddress).toBe(WALLET);
    expect(r.warnings).toEqual([expect.stringMatching(/THIRDWEB_SERVER_WALLET_LIVE=false/)]);
  });

  it('warns when live without a recipient allowlist or per-send ceiling', () => {
    process.env.THIRDWEB_SERVER_WALLET_LIVE = 'true';
    const r = new ThirdwebRailEngine().readiness();
    expect(r.live).toBe(true);
    expect(r.shadow).toBe(false);
    expect(r.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/ALLOWED_RECIPIENTS is empty/),
      expect.stringMatching(/MAX_QUANTITY=0/),
    ]));
  });

  it('reports rail-disabled, missing token and missing secret as issues', () => {
    delete process.env.THIRDWEB_RAIL_ENABLED;
    delete process.env.THIRDWEB_RAIL_TOKEN_ADDRESS;
    delete process.env.DAPP_USDC_ADDRESS;
    delete process.env.THIRDWEB_SECRET_KEY;
    const r = new ThirdwebRailEngine().readiness();
    expect(r.ready).toBe(false);
    expect(r.issues).toEqual(expect.arrayContaining([
      expect.stringMatching(/THIRDWEB_RAIL_ENABLED/),
      expect.stringMatching(/THIRDWEB_SECRET_KEY/),
    ]));
  });
});

describe('ThirdwebRailEngine settle', () => {
  it('records a shadow transfer and never calls thirdweb when not live', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as any);
    const res = await new ThirdwebRailEngine().settle({ destination: RECIPIENT, amountCents: 2500, memo: 'm', purpose: 'medical' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.simulated).toBe(true);
    expect(res.status).toBe('shadow');
    expect(res.quantity).toBe('25000000');
    expect(res.tokenAddress).toBe(USDC);
    expect(res.amount).toBe('25.00');
  });

  it('delegates a live send to ThirdwebServerWalletEngine with policy inputs', async () => {
    process.env.THIRDWEB_SERVER_WALLET_LIVE = 'true';
    const send = vi.spyOn(ThirdwebServerWalletEngine, 'send').mockResolvedValue({
      id: 'TWX-1', shadow: false, status: 'submitted', transactionId: 'tx-abc', transactionHash: null, tokenAddress: USDC, quantity: '25000000',
    } as any);
    const res = await new ThirdwebRailEngine().settle({ destination: RECIPIENT, amountCents: 2500, purpose: 'medical', requesterRole: 'trustee', reference: 'SCP-1' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      to: RECIPIENT, tokenAddress: USDC, quantity: 25000000n, amountUsd: 25, purpose: 'medical', requesterRole: 'trustee', reference: 'SCP-1',
    }));
    expect(res.simulated).toBe(false);
    expect(res.transactionId).toBe('tx-abc');
    expect(res.hash).toBe('thirdweb-tx:tx-abc');
  });

  it('enforces the server-wallet allowlist and ceiling', async () => {
    process.env.THIRDWEB_SERVER_WALLET_ALLOWED_RECIPIENTS = WALLET;
    await expect(new ThirdwebRailEngine().settle({ destination: RECIPIENT, amountCents: 100, purpose: 'medical' }))
      .rejects.toThrow(/ALLOWED_RECIPIENTS/);
    delete process.env.THIRDWEB_SERVER_WALLET_ALLOWED_RECIPIENTS;
    process.env.THIRDWEB_SERVER_WALLET_MAX_QUANTITY = '1000';
    await expect(new ThirdwebRailEngine().settle({ destination: RECIPIENT, amountCents: 100, purpose: 'medical' }))
      .rejects.toThrow(/MAX_QUANTITY/);
  });

  it('requires a distribution purpose', async () => {
    await expect(new ThirdwebRailEngine().settle({ destination: RECIPIENT, amountCents: 100 }))
      .rejects.toThrow(/purpose required/);
  });

  it('refuses when the rail is disabled', async () => {
    delete process.env.THIRDWEB_RAIL_ENABLED;
    await expect(new ThirdwebRailEngine().settle({ destination: RECIPIENT, amountCents: 100, purpose: 'medical' }))
      .rejects.toThrow(/THIRDWEB_RAIL_ENABLED/);
  });
});

describe('StablecoinGateway thirdweb rail selection', () => {
  it('rejects thirdweb payments when the rail is disabled', async () => {
    delete process.env.THIRDWEB_RAIL_ENABLED;
    await expect(StablecoinGateway.createPayment({ amountCents: 100, network: 'thirdweb', destinationWallet: RECIPIENT }))
      .rejects.toThrow(/THIRDWEB_RAIL_ENABLED/);
  });

  it('routes a thirdweb payment through ThirdwebRailEngine and records reconciliation ids', async () => {
    vi.spyOn(SourceOfFundsAdapter, 'reserve').mockResolvedValue({} as any);
    vi.spyOn(SourceOfFundsAdapter, 'post').mockResolvedValue({ ok: true } as any);
    vi.spyOn(SourceOfFundsAdapter, 'recordCrmAndDocuments').mockResolvedValue(undefined);
    const settle = vi.spyOn(ThirdwebRailEngine.prototype, 'settle').mockResolvedValue({
      hash: 'thirdweb-tx:tx-1', status: 'submitted', latencyMs: 1, explorer: '', simulated: false, transactionId: 'tx-1', transferId: 'TWX-9',
    } as any);
    const payment = await StablecoinGateway.createPayment({
      amountCents: 500, network: 'thirdweb', destinationWallet: RECIPIENT,
      metadata: { purpose: 'medical', requesterRole: 'trustee' },
    });
    expect(payment.network).toBe('thirdweb');
    vi.spyOn(StablecoinGateway, 'getPayment').mockResolvedValue({ ...payment, status: 'approved' });
    const settled = await StablecoinGateway.settlePayment(payment.id);
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ destination: RECIPIENT, amountCents: 500, purpose: 'medical', requesterRole: 'trustee' }));
    expect(settled.status).toBe('settled');
    expect(settled.tx_hash).toBe('thirdweb-tx:tx-1');
    expect(settled.metadata.thirdwebTransactionId).toBe('tx-1');
    expect(settled.metadata.thirdwebTransferId).toBe('TWX-9');
  });

  it('includes the thirdweb rail in gateway readiness only when enabled', async () => {
    const on = await StablecoinGateway.readiness();
    expect(on.thirdweb.provider).toBe('thirdweb-server-wallet');
    delete process.env.THIRDWEB_RAIL_ENABLED;
    const off = await StablecoinGateway.readiness();
    expect(off.thirdweb).toEqual({ ready: false, issues: [] });
  });
});
