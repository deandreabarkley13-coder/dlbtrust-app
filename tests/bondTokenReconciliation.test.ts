import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { BondTokenizationEngine } = require('../server/integrations/dapp/bondTokenizationEngine');
const pool = require('../server/integrations/bonds/pgPool');

type Row = Record<string, any>;

function token(overrides: Row = {}): Row {
  return {
    id: 'BTOK-1', bond_id: 1, token_symbol: 'DLB-BOND', token_address: '0x222', status: 'active',
    total_supply: '98822652.72', tokenized_principal: '98822652.72', tokenized_interest: '0', metadata: {}, ...overrides,
  };
}

function mockPool(row: Row) {
  const state = { token: { ...row } };
  const query = vi.fn(async (text: string, params: any[] = []) => {
    if (/SELECT \* FROM bond_tokens WHERE id/.test(text)) return { rows: [state.token] };
    if (/UPDATE bond_tokens SET status = 'retired'/.test(text)) {
      state.token = { ...state.token, status: 'retired', total_supply: 0, tokenized_principal: 0, tokenized_interest: 0, metadata: JSON.parse(params[1]) };
      return { rows: [] };
    }
    if (/UPDATE bond_tokens SET total_supply = \$2/.test(text)) {
      state.token = { ...state.token, total_supply: params[1], tokenized_principal: params[2], tokenized_interest: params[3], metadata: JSON.parse(params[4]) };
      return { rows: [] };
    }
    if (/SELECT id FROM bond_token_holders/.test(text)) return { rows: [{ id: 'BTH-1' }] };
    return { rows: [] };
  });
  vi.spyOn(pool, 'query').mockImplementation(query as any);
  return query;
}

afterEach(() => vi.restoreAllMocks());

describe('BondTokenizationEngine.classifyToken', () => {
  it('separates shadow rows, foreign-chain contracts and deployed-chain contracts', () => {
    expect(BondTokenizationEngine.classifyToken(token({ token_address: 'shadow-1' }), 1)).toBe('shadow');
    expect(BondTokenizationEngine.classifyToken(token({ token_address: null }), 1)).toBe('shadow');
    expect(BondTokenizationEngine.classifyToken(token({ metadata: { chainId: 11155111 } }), 1)).toBe('foreign_chain');
    expect(BondTokenizationEngine.classifyToken(token({ metadata: { chainId: 1 } }), 1)).toBe('on_chain');
    expect(BondTokenizationEngine.classifyToken(token(), 1)).toBe('on_chain');
  });
});

describe('BondTokenizationEngine.retire', () => {
  it('refuses to retire a deployed-chain token that still has supply in circulation', async () => {
    mockPool(token());
    vi.spyOn(BondTokenizationEngine, 'chainSupply').mockResolvedValue(100000000);
    await expect(BondTokenizationEngine.retire({ tokenId: 'BTOK-1', reason: 'stale' }))
      .rejects.toThrow(/still has 100000000 in circulation/);
  });

  it('requires a reason and rejects double retirement', async () => {
    mockPool(token({ status: 'retired' }));
    await expect(BondTokenizationEngine.retire({ tokenId: 'BTOK-1', reason: 'x' })).rejects.toThrow(/already retired/);
    mockPool(token());
    await expect(BondTokenizationEngine.retire({ tokenId: 'BTOK-1' })).rejects.toThrow(/reason is required/);
  });

  it('writes off a stale ledger row once the contract reports zero supply, keeping the audit trail', async () => {
    const query = mockPool(token());
    vi.spyOn(BondTokenizationEngine, 'chainSupply').mockResolvedValue(0);
    const out = await BondTokenizationEngine.retire({ tokenId: 'BTOK-1', reason: 'predecessor of DLB-PRB, burned on chain', retiredBy: 'admin' });
    expect(out.placement).toBe('on_chain');
    expect(out.writtenOff).toEqual({ total_supply: 98822652.72, tokenized_principal: 98822652.72, tokenized_interest: 0 });
    expect(out.token).toMatchObject({ status: 'retired', total_supply: 0, tokenized_principal: 0 });
    expect(out.token.metadata.retired).toMatchObject({ reason: 'predecessor of DLB-PRB, burned on chain', retiredBy: 'admin', chainSupply: 0 });
    expect(query.mock.calls.some((c) => /UPDATE bond_token_holders SET balance = 0/.test(c[0]))).toBe(true);
  });

  it('retires testnet and shadow rows without touching the chain', async () => {
    mockPool(token({ metadata: { chainId: 11155111 } }));
    const chain = vi.spyOn(BondTokenizationEngine, 'chainSupply');
    const out = await BondTokenizationEngine.retire({ tokenId: 'BTOK-1', reason: 'sepolia test artifact' });
    expect(out.placement).toBe('foreign_chain');
    expect(out.chainSupply).toBeNull();
    expect(chain).not.toHaveBeenCalled();
  });
});

describe('BondTokenizationEngine.syncSupplyFromChain', () => {
  it('is a no-op when ledger and contract agree', async () => {
    mockPool(token({ total_supply: '10', tokenized_principal: '10' }));
    vi.spyOn(BondTokenizationEngine, 'chainSupply').mockResolvedValue(10);
    expect(await BondTokenizationEngine.syncSupplyFromChain({ tokenId: 'BTOK-1' })).toMatchObject({ delta: 0, changed: false });
  });

  it('moves the ledger to the contract supply and applies the delta to principal and the largest holding', async () => {
    const query = mockPool(token({ token_symbol: 'DLBUSD', total_supply: '109223721.78', tokenized_principal: '109223721.78' }));
    vi.spyOn(BondTokenizationEngine, 'chainSupply').mockResolvedValue(109223722.78);
    const out = await BondTokenizationEngine.syncSupplyFromChain({ tokenId: 'BTOK-1', syncedBy: 'admin' });
    expect(out).toMatchObject({ delta: 1, changed: true, ledgerSupply: 109223721.78, chainSupply: 109223722.78 });
    expect(out.token).toMatchObject({ total_supply: 109223722.78, tokenized_principal: 109223722.78 });
    expect(out.token.metadata.chainSync).toMatchObject({ from: 109223721.78, to: 109223722.78, delta: 1, syncedBy: 'admin' });
    const holderUpdate = query.mock.calls.find((c) => /UPDATE bond_token_holders SET balance = GREATEST/.test(c[0]));
    expect(holderUpdate?.[1]).toEqual(['BTH-1', 1]);
  });

  it('refuses to sync a shadow or foreign-chain row', async () => {
    mockPool(token({ token_address: 'shadow-1' }));
    await expect(BondTokenizationEngine.syncSupplyFromChain({ tokenId: 'BTOK-1' })).rejects.toThrow(/not a contract on the deployed chain/);
  });
});

describe('BondTokenizationEngine.syncSupplyToPrincipal', () => {
  it('raises one pending burn per over-cap token and never executes it', async () => {
    const { MintExchangeOsEngine } = require('../server/integrations/os/mintExchangeOsEngine');
    vi.spyOn(BondTokenizationEngine, 'listTokens').mockResolvedValue([
      token({ id: 'PRB', token_symbol: 'DLB-PRB' }),
      token({ id: 'SEP', metadata: { chainId: 11155111 } }),
      token({ id: 'MOD', bond_id: null }),
      token({ id: 'OLD', status: 'retired' }),
    ]);
    vi.spyOn(MintExchangeOsEngine, 'burnRequired').mockResolvedValue({
      requiredCents: 147537249, required: '$1475372.49', principalCents: 147537249, interestCents: 0,
      ceiling: { basis: 'bond' }, holders: [{ holderAddress: '0xop', balanceCents: 10000000000 }],
    });
    vi.spyOn(MintExchangeOsEngine, 'list').mockResolvedValue([]);
    const request = vi.spyOn(MintExchangeOsEngine, 'request').mockResolvedValue({ movement_id: 'BURN-1' });
    const execute = vi.spyOn(MintExchangeOsEngine, 'execute');

    const out = await BondTokenizationEngine.syncSupplyToPrincipal({ initiatedBy: 'sync' });
    expect(out.checked).toBe(1);
    expect(out.results).toEqual([{ tokenId: 'PRB', symbol: 'DLB-PRB', requiredCents: 147537249, action: 'raised', movementId: 'BURN-1' }]);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'burn', tokenId: 'PRB', holderAddress: '0xop', principalCents: 147537249, interestCents: 0, initiatedBy: 'sync',
    }));
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not raise a second burn while one is already open', async () => {
    const { MintExchangeOsEngine } = require('../server/integrations/os/mintExchangeOsEngine');
    vi.spyOn(BondTokenizationEngine, 'listTokens').mockResolvedValue([token({ id: 'PRB' })]);
    vi.spyOn(MintExchangeOsEngine, 'burnRequired').mockResolvedValue({
      requiredCents: 100, required: '$1.00', principalCents: 100, interestCents: 0, ceiling: { basis: 'bond' }, holders: [],
    });
    vi.spyOn(MintExchangeOsEngine, 'list').mockResolvedValue([{ movement_id: 'BURN-0', status: 'pending_approval' }]);
    const request = vi.spyOn(MintExchangeOsEngine, 'request');
    const out = await BondTokenizationEngine.syncSupplyToPrincipal();
    expect(out.results[0]).toMatchObject({ action: 'pending', movementId: 'BURN-0' });
    expect(request).not.toHaveBeenCalled();
  });
});
