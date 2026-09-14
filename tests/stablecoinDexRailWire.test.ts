import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

process.env.DAPP_MEMORY_MODE = 'true';

const { run, parseArgs } = require('../server/scripts/stablecoinDexRailWire');
const { StablecoinDexEngine } = require('../server/integrations/dapp/stablecoinDexEngine');
const { TreasuryDepositEngine } = require('../server/integrations/dapp/treasuryDepositEngine');

const saved = { ...process.env };
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DLBUSD = '0x6ba8d02596a3b091a7246e38e3e078f770d33985';

function dexConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true, shadow: true, chainId: 8453, rpcUrl: 'http://rpc', privateKey: '0x' + '1'.repeat(64),
    usdcAddress: USDC, dlbusdAddress: DLBUSD, poolAddress: '', wethAddress: '',
    operatorAddress: '0x95bb85FdeC42b1517d282e8AD43A789d390aAda2', slippageBps: 100, ...overrides,
  };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (s: string) => out.push(String(s)), error: (s: string) => err.push(String(s)) };
}

beforeEach(() => {
  process.env.DAPP_MEMORY_MODE = 'true';
  process.env.THIRDWEB_SERVER_WALLET_CHAIN_ID = '8453';
  process.env.THIRDWEB_SETTLEMENT_TOKEN = USDC;
  process.env.TREASURY_TOPUP_HOLD_SOURCE_TYPE = 'trust';
  process.env.TREASURY_TOPUP_HOLD_ACCOUNT_ID = '1000';
  vi.spyOn(StablecoinDexEngine, 'getConfig').mockReturnValue(dexConfig());
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('stablecoinDexRailWire (shadow mode)', () => {
  it('parses the documented flags', () => {
    expect(parseArgs(['--fund', '--amount', '250', '--source-type', 'cash', '--source-account', 'CA-BOND-PROCEEDS']))
      .toMatchObject({ fund: true, amount: '250', sourceType: 'cash', sourceAccount: 'CA-BOND-PROCEEDS' });
    expect(parseArgs(['--create-pool', '--target', 'USDC', '--seed-dlbusd', '1', '--seed-usdc', '2']))
      .toMatchObject({ createPool: true, target: 'USDC', seedDlbusd: '1', seedUsdc: '2' });
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/);
  });

  it('--readiness prints both readiness reports and moves nothing', async () => {
    const { out, log, error } = io();
    const declare = vi.spyOn(TreasuryDepositEngine, 'declare');
    const res = await run(['--readiness'], { log, error });
    expect(res.exitCode).toBe(0);
    expect(res.readiness).toMatchObject({ ready: true, mode: 'shadow' });
    expect(res.fundReadiness).toMatchObject({ rail: 'dlbusd-1to1-swap', mode: 'shadow', canFund: false });
    expect(out.join('\n')).toMatch(/stablecoin dex readiness/);
    expect(out.join('\n')).toMatch(/treasury deposit fund readiness/);
    expect(out.join('\n')).not.toMatch(/1{64}/);
    expect(declare).not.toHaveBeenCalled();
  });

  it('--fund refuses in shadow mode, prints the blocking issues and declares/funds nothing', async () => {
    const { err, log, error } = io();
    const declare = vi.spyOn(TreasuryDepositEngine, 'declare');
    const fund = vi.spyOn(TreasuryDepositEngine, 'fund');
    const swap = vi.spyOn(StablecoinDexEngine, 'depositAndSwap');

    const res = await run(['--fund', '--amount', '250'], { log, error });
    expect(res.exitCode).toBe(1);
    expect(res.refused).toBe(true);
    expect(err.join('\n')).toMatch(/refusing to move value: rail dlbusd-1to1-swap is not live/);
    expect(err.join('\n')).toMatch(/shadow mode/);
    expect(declare).not.toHaveBeenCalled();
    expect(fund).not.toHaveBeenCalled();
    expect(swap).not.toHaveBeenCalled();
  });

  it('--create-pool refuses when the DEX is disabled and lists fundReadiness issues', async () => {
    vi.spyOn(StablecoinDexEngine, 'getConfig').mockReturnValue(dexConfig({ enabled: false, shadow: false }));
    const { err, log, error } = io();
    const createPool = vi.spyOn(StablecoinDexEngine, 'createPool');

    const res = await run(['--create-pool', '--target', 'USDC', '--seed-dlbusd', '1', '--seed-usdc', '1'], { log, error });
    expect(res.exitCode).toBe(1);
    expect(res.issues).toEqual(expect.arrayContaining(['STABLECOIN_DEX_ENABLED is not true']));
    expect(err.join('\n')).toMatch(/STABLECOIN_DEX_ENABLED is not true/);
    expect(createPool).not.toHaveBeenCalled();
  });

  it('live readiness: --fund declares then funds and reports funded/code/txHash', async () => {
    vi.spyOn(StablecoinDexEngine, 'getConfig').mockReturnValue(dexConfig({ shadow: false }));
    vi.spyOn(StablecoinDexEngine, 'readiness').mockReturnValue({ ready: true, mode: 'live', issues: [] });
    const { out, log, error } = io();
    const Deposit = {
      fundReadiness: () => ({ rail: 'dlbusd-1to1-swap', mode: 'live', canFund: true, ready: true, issues: [], usdcAddress: USDC, sourceType: 'trust', sourceAccountId: '1000' }),
      declare: vi.fn(async ({ amount }: any) => ({ id: 'TWDEP-1', walletAddress: '0xtreasury', chainId: 8453, expectedAmount: amount, symbol: 'USDC' })),
      fund: vi.fn(async () => ({ funded: true, code: 'CREDITED', swap: { txHash: '0xusdc' }, deposit: { status: 'credited', booked: true, creditedQuantity: '250000000' } })),
    };

    const res = await run(['--fund', '--amount', '250', '--source-type', 'cash', '--source-account', 'CA-BOND-PROCEEDS'], { Deposit, log, error });
    expect(res.exitCode).toBe(0);
    expect(Deposit.declare).toHaveBeenCalledWith({ amount: '250', tokenAddress: USDC });
    expect(Deposit.fund).toHaveBeenCalledWith('TWDEP-1', { sourceType: 'cash', sourceAccountId: 'CA-BOND-PROCEEDS' });
    expect(res.result).toMatchObject({ depositId: 'TWDEP-1', funded: true, code: 'CREDITED', txHash: '0xusdc' });
    expect(out.join('\n')).toMatch(/treasury funded/);
  });
});
