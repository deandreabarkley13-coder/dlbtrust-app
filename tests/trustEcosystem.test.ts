import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
process.env.DAPP_MEMORY_MODE = 'true';

const { TrustEcosystemEngine } = require('../server/integrations/dapp/trustEcosystemEngine');
const { ThirdwebPriceOracle, NATIVE_TOKEN } = require('../server/integrations/dapp/thirdwebPriceOracle');
const { getTrusteeByRole } = require('../server/integrations/dapp/trustees');

const saved = { ...process.env };
const TREASURY = '0x1A904F795a0511C31Ba6347504D08d1bA58E4f89';
const DEST = '0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16';

const beneficiary = { userId: 'u-b', email: 'deandreabarkley13@gmail.com', role: 'beneficiary', roles: ['beneficiary'], walletAddress: DEST, authMethod: 'dapp_user' };
const maker = { userId: 'u-m', email: getTrusteeByRole('maker').email, role: 'trustee_maker', roles: ['trustee_maker', 'beneficiary'] };
const checker = { userId: 'u-c', email: getTrusteeByRole('checker').email, role: 'trustee_checker', roles: ['trustee_checker', 'beneficiary'] };

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, statusText: 'x', json: async () => body } as any;
}

beforeEach(() => {
  process.env.DAPP_CHAIN_ID = '1';
  process.env.THIRDWEB_SECRET_KEY = 'tw-secret';
  process.env.THIRDWEB_SERVER_WALLET_ADDRESS = TREASURY;
  delete process.env.THIRDWEB_SERVER_WALLET_LIVE;
  // $2,500 / ETH, 18 decimals
  vi.spyOn(ThirdwebPriceOracle, 'getPrice').mockResolvedValue({ chainId: 1, tokenAddress: NATIVE_TOKEN, symbol: 'ETH', decimals: 18, priceUsd: 2500, source: 'thirdweb' } as any);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('trust ecosystem', () => {
  it('publishes a secret-free manifest with the policy and treasury state', () => {
    const m = TrustEcosystemEngine.manifest();
    expect(m.policy.limitsUsd).toEqual({ beneficiary: 100000, trustee: 500000 });
    expect(m.treasury).toEqual({ address: TREASURY, shadow: true, canSend: false });
    expect(m.auth.emailOtp.verify).toBe('/api/dapp/auth/verify');
    expect(JSON.stringify(m)).not.toContain('tw-secret');
  });

  it('derives role, limits and capabilities from the session', async () => {
    const b = await TrustEcosystemEngine.session(beneficiary);
    expect(b).toMatchObject({ role: 'beneficiary', walletAddress: DEST, limits: { perTransactionUsd: 100000 }, capabilities: { approveExpense: false, payExpense: false, viewAllExpenses: false } });
    const t = await TrustEcosystemEngine.session(maker);
    expect(t).toMatchObject({ role: 'trustee', trusteeSeat: 'maker', limits: { perTransactionUsd: 500000 }, capabilities: { approveExpense: true, payExpense: true } });
  });

  it('prices the linked wallet portfolio through thirdweb wallet tokens', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      result: { tokens: [{ chainId: 1, tokenAddress: NATIVE_TOKEN, symbol: 'ETH', decimals: 18, balance: '2000000000000000000', priceUsd: 2500 }] },
    }));
    const p = await TrustEcosystemEngine.portfolio({ user: beneficiary });
    expect(p.address).toBe(DEST);
    expect(p.tokens[0]).toMatchObject({ symbol: 'ETH', amount: 2, valueUsd: 5000 });
    expect(p.totalUsd).toBe(5000);
    expect(String(fetchSpy.mock.calls[0][0])).toBe(`https://api.thirdweb.com/v1/wallets/${DEST}/tokens?chainId=1&limit=100`);
    expect(fetchSpy.mock.calls[0][1].headers['x-secret-key']).toBe('tw-secret');
    await expect(TrustEcosystemEngine.portfolio({ user: beneficiary, address: TREASURY })).rejects.toMatchObject({ status: 403 });
    await TrustEcosystemEngine.portfolio({ user: maker, address: TREASURY });
  });

  it('runs submit → two-trustee approval → shadow payment with oracle pricing, enforcing roles and limits', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(TrustEcosystemEngine.submitExpense({ user: beneficiary, amountUsd: 100001, purpose: 'home' })).rejects.toMatchObject({ code: 'DISTRIBUTION_LIMIT_EXCEEDED' });
    await expect(TrustEcosystemEngine.submitExpense({ user: beneficiary, amountUsd: 10, purpose: 'yacht' })).rejects.toThrow(/not permitted/);

    const expense = await TrustEcosystemEngine.submitExpense({ user: beneficiary, amountUsd: 2500, purpose: 'Medical', memo: 'clinic' });
    expect(expense).toMatchObject({ status: 'under_review', requesterRole: 'beneficiary', amountUsd: 2500, purpose: 'medical', limitUsd: 100000, destinationAddress: DEST });

    // beneficiaries see their own, trustees see all
    expect((await TrustEcosystemEngine.listExpenses({ user: beneficiary })).map((e: any) => e.id)).toContain(expense.id);
    expect((await TrustEcosystemEngine.listExpenses({ user: { ...beneficiary, email: 'someone@else.com' } })).map((e: any) => e.id)).not.toContain(expense.id);
    expect((await TrustEcosystemEngine.listExpenses({ user: maker })).map((e: any) => e.id)).toContain(expense.id);

    await expect(TrustEcosystemEngine.approveExpense({ user: beneficiary, requestId: expense.id })).rejects.toMatchObject({ status: 403 });
    await expect(TrustEcosystemEngine.payExpense({ user: beneficiary, requestId: expense.id })).rejects.toMatchObject({ status: 403 });
    await expect(TrustEcosystemEngine.payExpense({ user: maker, requestId: expense.id })).rejects.toMatchObject({ code: 'NOT_APPROVED', status: 409 });

    await expect(TrustEcosystemEngine.approveExpense({ user: checker, requestId: expense.id })).rejects.toThrow(/Maker approval required/);
    expect((await TrustEcosystemEngine.approveExpense({ user: maker, requestId: expense.id })).approvals.map((a: any) => a.role)).toEqual(['maker']);
    expect((await TrustEcosystemEngine.approveExpense({ user: checker, requestId: expense.id })).status).toBe('approved');

    const paid = await TrustEcosystemEngine.payExpense({ user: checker, requestId: expense.id });
    expect(paid.transfer).toMatchObject({ shadow: true, status: 'shadow', to: DEST, quantity: '1000000000000000000', amountUsd: 2500, priceUsd: 2500, priceSource: 'thirdweb', requesterRole: 'beneficiary', purpose: 'medical', reference: expense.id });
    expect(paid.expense.payment).toMatchObject({ shadow: true, symbol: 'ETH', quantity: '1000000000000000000', paidBy: checker.email });
    expect(paid.expense.status).toBe('approved');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
