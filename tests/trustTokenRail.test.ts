import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

process.env.DAPP_MEMORY_MODE = 'true';
// dapp/config reads the chain once at load: Base Sepolia for the whole file.
process.env.DAPP_CHAIN_ID = '84532';

const { ThirdwebChainSigner, TX_PREFIX } = require('../server/integrations/dapp/thirdwebChainSigner');
const { ThirdwebServerWalletEngine } = require('../server/integrations/dapp/thirdwebServerWalletEngine');
const { ThirdwebPriceOracle } = require('../server/integrations/dapp/thirdwebPriceOracle');
const { BondTokenizationEngine } = require('../server/integrations/dapp/bondTokenizationEngine');
const { PtcStablecoinEngine } = require('../server/integrations/dapp/ptcStablecoinEngine');
const { BeneficiaryExpenseWalletEngine, TRUST_TOKEN_SOURCE } = require('../server/integrations/dapp/beneficiaryExpenseWalletEngine');
const { TrustTokenRailEngine, STAGES, RECORD_TYPE, UNNOTARIZED } = require('../server/integrations/dapp/trustTokenRailEngine');
const { FixedIncomeDataService } = require('../server/integrations/bonds/fixedIncomeDataService');
const { FabricLedgerEngine } = require('../server/integrations/hyperledger/fabricLedgerEngine');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const { WalletFundingEngine } = require('../server/integrations/dapp/walletFundingEngine');

const saved = { ...process.env };
const TREASURY = '0x95bb85FdeC42b1517d282e8AD43A789d390aAda2';
const EXPENSE = '0x1A904F795a0511C31Ba6347504D08d1bA58E4f89';
const TRUST_TOKEN = '0x1111111111111111111111111111111111111111';
const VAULT = '0x2222222222222222222222222222222222222222';
const BOND_TOKEN = '0x7c0B4BfB63ccD91181349A20E0DDe2bd2d5Bee60';

const ERC20_ABI = [
  { type: 'constructor', inputs: [{ name: 'name_', type: 'string' }, { name: 'owner_', type: 'address' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'whitelisted', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'getReserve', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }, { type: 'uint8' }, { type: 'uint256' }] },
];

function position(overrides: Record<string, any> = {}) {
  return {
    id: 7, bond_name: 'US Treasury 4.25% 2031', isin: 'US91282CJT56', issuer: 'US Treasury', status: 'active',
    principal_balance: 100000, accrued_interest: 1250.5, coupon_rate: 4.25, maturity_date: '2031-05-15', ...overrides,
  };
}

function thirdweb() {
  process.env.DAPP_SIGNER = 'thirdweb';
  process.env.DAPP_CHAIN_ID = '84532';
  process.env.THIRDWEB_SECRET_KEY = 'tw-secret';
  process.env.THIRDWEB_SERVER_WALLET_ADDRESS = TREASURY;
  process.env.THIRDWEB_TX_POLL_MS = '1';
}

/** Shadow rail with a healthy ledger position and nothing deployed yet. */
function shadowRail() {
  thirdweb();
  delete process.env.THIRDWEB_SERVER_WALLET_LIVE;
  vi.spyOn(FixedIncomeDataService, 'listPositions').mockResolvedValue([position()]);
  vi.spyOn(FixedIncomeDataService, 'getPosition').mockImplementation(async (id: number) => (Number(id) === 7 ? position() : null));
  vi.spyOn(FixedIncomeDataService, 'getTokenization').mockResolvedValue({ by_bond: { '7': { tokenized_principal: 99900 } } });
  vi.spyOn(BondTokenizationEngine, 'getTokenByBondId').mockResolvedValue(null);
  vi.spyOn(BondTokenizationEngine, 'listTokens').mockResolvedValue([]);
  vi.spyOn(PtcStablecoinEngine, 'state').mockReturnValue({});
  vi.spyOn(BeneficiaryExpenseWalletEngine, 'listWallets').mockResolvedValue([]);
}

beforeEach(() => {
  process.env.DAPP_MEMORY_MODE = 'true';
  for (const k of ['DAPP_SIGNER', 'DAPP_SHADOW', 'DAPP_PRIVATE_KEY', 'THIRDWEB_SECRET_KEY', 'THIRDWEB_SERVER_WALLET_ADDRESS',
    'THIRDWEB_SERVER_WALLET_LIVE', 'THIRDWEB_SERVER_WALLET_ALLOWED_RECIPIENTS', 'THIRDWEB_DEPLOY_SALT_PREFIX', 'BOND_TOKEN_FACTORY', 'BOND_TOKEN_SHADOW',
    'TRUST_TOKEN_RAIL_ENABLED', 'TRUST_TOKEN_RAIL_MAX_ISSUE_USD', 'TRUST_TOKEN_RAIL_RESERVE_PRICE_USD', 'EXPENSE_WALLET_TOKEN_ADDRESS',
    'EXPENSE_WALLET_HOLD_SOURCE_TYPE', 'FABRIC_LEDGER_LIVE', 'FABRIC_CONNECT_URL', 'SPRITZ_API_KEY', 'THIRDWEB_SETTLEMENT_TOKEN', 'DAPP_USDC_ADDRESS']) {
    delete process.env[k];
  }
  ThirdwebPriceOracle.clearCache();
  FabricLedgerEngine._resetMemory();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  process.env.DAPP_CHAIN_ID = '84532';
});

// ---------------------------------------------------------------------------
describe('ThirdwebChainSigner', () => {
  beforeEach(thirdweb);

  it('renders the thirdweb method signature from the ABI', () => {
    expect(ThirdwebChainSigner.signatureFor(ERC20_ABI, 'balanceOf').method).toBe('function balanceOf(address account) view returns (uint256)');
    expect(ThirdwebChainSigner.signatureFor(ERC20_ABI, 'approve').method).toBe('function approve(address spender, uint256 amount) returns (bool)');
    expect(() => ThirdwebChainSigner.signatureFor(ERC20_ABI, 'nope')).toThrow(/not in ABI/);
  });

  it('deploys from the Vault wallet, salts deterministically, and polls to the chain hash', async () => {
    const request = vi.spyOn(ThirdwebServerWalletEngine, '_request')
      .mockResolvedValueOnce({ address: TRUST_TOKEN, chainId: 84532, transactionId: 'tx-deploy' })
      .mockResolvedValueOnce({ status: 'QUEUED' })
      .mockResolvedValueOnce({ status: 'CONFIRMED', transactionHash: '0xabc', confirmedAtBlockNumber: '42', executionResult: { receipt: { logs: [] } } });

    const out = await ThirdwebChainSigner.deploy({ abi: ERC20_ABI, bytecode: '6080', args: ['DLB Trust USD', TREASURY], salt: 'ptc-token' });

    expect(request.mock.calls[0][0]).toBe('POST');
    expect(request.mock.calls[0][1]).toBe('/v1/contracts');
    expect(request.mock.calls[0][2]).toMatchObject({
      chainId: 84532, from: TREASURY, bytecode: '0x6080', salt: 'dlbtrust:ptc-token',
      constructorParams: { name_: 'DLB Trust USD', owner_: TREASURY },
    });
    expect(request.mock.calls[1][1]).toBe('/v1/transactions/tx-deploy');
    expect(out).toMatchObject({ address: TRUST_TOKEN, transactionId: 'tx-deploy', transactionHash: '0xabc', alreadyDeployed: false });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('is idempotent: a salt already on chain returns the address with no transaction', async () => {
    const request = vi.spyOn(ThirdwebServerWalletEngine, '_request').mockResolvedValueOnce({ address: VAULT, chainId: 84532 });
    const out = await ThirdwebChainSigner.deploy({ abi: [], bytecode: '0x60', salt: 'vault' });
    expect(out).toEqual({ address: VAULT, chainId: 84532, transactionId: null, alreadyDeployed: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('writes through /v1/contracts/write with encoded params and returns the transaction id', async () => {
    const request = vi.spyOn(ThirdwebServerWalletEngine, '_request').mockResolvedValueOnce({ transactionIds: ['tx-approve'] });
    const id = await ThirdwebChainSigner.write({ address: BOND_TOKEN, abi: ERC20_ABI, functionName: 'approve', args: [VAULT, 25000000n], idempotencyKey: 'run-1' });
    expect(id).toBe('tx-approve');
    expect(request.mock.calls[0][2]).toEqual({
      chainId: 84532, from: TREASURY, idempotencyKey: 'run-1',
      calls: [{ contractAddress: BOND_TOKEN, method: 'function approve(address spender, uint256 amount) returns (bool)', params: [VAULT, '25000000'], value: '0' }],
    });

    vi.spyOn(ThirdwebServerWalletEngine, '_request').mockResolvedValueOnce({ transactionIds: [] });
    await expect(ThirdwebChainSigner.write({ address: BOND_TOKEN, abi: ERC20_ABI, functionName: 'approve', args: [VAULT, 1n] })).rejects.toThrow(/no transaction id/);
  });

  it('reads through /v1/contracts/read and decodes integers, booleans and tuples like viem', async () => {
    const request = vi.spyOn(ThirdwebServerWalletEngine, '_request')
      .mockResolvedValueOnce([{ success: true, data: '25000000000000000000' }])
      .mockResolvedValueOnce([{ success: true, data: 'true' }])
      .mockResolvedValueOnce([{ success: true, data: [true, '6', '1000000000000000000'] }])
      .mockResolvedValueOnce([{ success: false, error: 'execution reverted' }]);

    expect(await ThirdwebChainSigner.read({ address: TRUST_TOKEN, abi: ERC20_ABI, functionName: 'balanceOf', args: [TREASURY] })).toBe(25000000000000000000n);
    expect(request.mock.calls[0][2]).toEqual({ chainId: 84532, calls: [{ contractAddress: TRUST_TOKEN, method: 'function balanceOf(address account) view returns (uint256)', params: [TREASURY] }] });
    expect(await ThirdwebChainSigner.read({ address: TRUST_TOKEN, abi: ERC20_ABI, functionName: 'whitelisted', args: [EXPENSE] })).toBe(true);
    expect(await ThirdwebChainSigner.read({ address: VAULT, abi: ERC20_ABI, functionName: 'getReserve', args: [BOND_TOKEN] })).toEqual([true, 6n, 1000000000000000000n]);
    await expect(ThirdwebChainSigner.read({ address: TRUST_TOKEN, abi: ERC20_ABI, functionName: 'balanceOf', args: [TREASURY] })).rejects.toThrow(/execution reverted/);
  });

  it('surfaces a FAILED transaction as a 502 with the thirdweb error', async () => {
    vi.spyOn(ThirdwebServerWalletEngine, '_request').mockResolvedValueOnce({ status: 'FAILED', errorMessage: 'out of gas' });
    await expect(ThirdwebChainSigner.wait('tx-bad', { pollMs: 1 })).rejects.toMatchObject({ status: 502, transactionId: 'tx-bad', message: expect.stringMatching(/FAILED: out of gas/) });
  });

  it('exposes a viem-shaped adapter whose hashes round-trip to thirdweb transaction ids', async () => {
    vi.spyOn(ThirdwebServerWalletEngine, '_request')
      .mockResolvedValueOnce({ transactionIds: ['tx-w'] })
      .mockResolvedValueOnce({ status: 'CONFIRMED', transactionHash: '0xdef', executionResult: { receipt: { logs: [{ address: BOND_TOKEN }] } } })
      .mockResolvedValueOnce({ address: VAULT, chainId: 84532 });
    const { walletClient, publicClient, account, signer } = ThirdwebChainSigner.clients({ chainId: 84532 });
    expect(signer).toBe('thirdweb');
    expect(account.address).toBe(TREASURY);

    const hash = await walletClient.writeContract({ address: BOND_TOKEN, abi: ERC20_ABI, functionName: 'approve', args: [VAULT, 1n] });
    expect(hash).toBe(`${TX_PREFIX}tx-w`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    expect(receipt).toMatchObject({ status: 'success', transactionId: 'tx-w', transactionHash: '0xdef', logs: [{ address: BOND_TOKEN }] });

    const deployHash = await walletClient.deployContract({ abi: [], bytecode: '0x60', salt: 'vault' });
    expect(await publicClient.waitForTransactionReceipt({ hash: deployHash })).toMatchObject({ status: 'success', contractAddress: VAULT, alreadyDeployed: true });
  });

  it('refuses to deploy or write without the Vault wallet address', async () => {
    delete process.env.THIRDWEB_SERVER_WALLET_ADDRESS;
    const request = vi.spyOn(ThirdwebServerWalletEngine, '_request');
    await expect(ThirdwebChainSigner.deploy({ abi: [], bytecode: '0x60' })).rejects.toThrow(/THIRDWEB_SERVER_WALLET_ADDRESS/);
    await expect(ThirdwebChainSigner.write({ address: BOND_TOKEN, abi: ERC20_ABI, functionName: 'approve', args: [VAULT, 1n] })).rejects.toThrow(/THIRDWEB_SERVER_WALLET_ADDRESS/);
    expect(request).not.toHaveBeenCalled();
    expect(ThirdwebChainSigner.readiness()).toMatchObject({ active: true, ready: false, issues: ['THIRDWEB_SERVER_WALLET_ADDRESS not configured'] });
  });
});

// ---------------------------------------------------------------------------
describe('issuer-pinned prices', () => {
  it('prices the trust token at the pinned $1 without calling thirdweb', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    ThirdwebPriceOracle.pin({ chainId: 84532, tokenAddress: TRUST_TOKEN, priceUsd: 1, decimals: 18, symbol: 'DLB-PTCUSD', source: 'ptc-issuer' });
    const quote = await ThirdwebPriceOracle.quantityForUsd({ chainId: 84532, tokenAddress: TRUST_TOKEN, amountUsd: 10 });
    expect(quote).toMatchObject({ symbol: 'DLB-PTCUSD', priceUsd: 1, decimals: 18, source: 'ptc-issuer', quantity: '10000000000000000000' });
    expect(ThirdwebPriceOracle.listPinned()).toContainEqual(expect.objectContaining({ tokenAddress: TRUST_TOKEN }));
    expect(fetchSpy).not.toHaveBeenCalled();
    ThirdwebPriceOracle.unpin({ chainId: 84532, tokenAddress: TRUST_TOKEN });
  });

  it('rejects a non-positive pinned price', () => {
    expect(() => ThirdwebPriceOracle.pin({ chainId: 84532, tokenAddress: TRUST_TOKEN, priceUsd: 0, decimals: 18 })).toThrow(/positive/);
  });
});

// ---------------------------------------------------------------------------
describe('expense wallet funding from the trust token', () => {
  const balances = (value: string) => [{ tokenAddress: TRUST_TOKEN, value, decimals: 18 }];

  beforeEach(() => {
    thirdweb();
    ThirdwebPriceOracle.pin({ chainId: 84532, tokenAddress: TRUST_TOKEN, priceUsd: 1, decimals: 18, symbol: 'DLB-PTCUSD', source: 'ptc-issuer' });
    vi.spyOn(ThirdwebServerWalletEngine, 'ensureWallet').mockImplementation(async (identifier: string) => ({ identifier, address: EXPENSE, smartAccountAddress: null, createdAt: '2026-01-01' }));
    vi.spyOn(WalletFundingEngine, 'ensureAccounts').mockResolvedValue(undefined as any);
    vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entry_id: 'je-77' } as any);
  });

  afterEach(() => ThirdwebPriceOracle.unpin({ chainId: 84532, tokenAddress: TRUST_TOKEN }));

  it('funds against the treasury wallet balance with no hold account and no sweep (shadow)', async () => {
    const balance = vi.spyOn(ThirdwebServerWalletEngine, 'balance').mockResolvedValue(balances('25000000000000000000'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const funding = await BeneficiaryExpenseWalletEngine.fund({
      beneficiary: 'Jane Doe', purpose: 'medical', amountUsd: 10, requesterRole: 'trustee', sourceType: TRUST_TOKEN_SOURCE, tokenAddress: TRUST_TOKEN, chainId: 84532,
    });
    expect(balance).toHaveBeenCalledWith({ address: TREASURY, chainId: 84532, tokenAddress: TRUST_TOKEN });
    expect(funding).toMatchObject({
      sourceType: 'trust_token', sourceAccountId: TREASURY, sourceAvailableUsd: null, sourceAvailableQuantity: '25000000000000000000',
      quantity: '10000000000000000000', priceUsd: 1, symbol: 'DLB-PTCUSD', address: EXPENSE, shadow: true, sweptCents: 0, transactionHash: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses when the treasury does not hold enough trust token', async () => {
    vi.spyOn(ThirdwebServerWalletEngine, 'balance').mockResolvedValue(balances('5000000000000000000'));
    const send = vi.spyOn(ThirdwebServerWalletEngine, 'send');
    await expect(BeneficiaryExpenseWalletEngine.fund({
      beneficiary: 'Jane Doe', purpose: 'medical', amountUsd: 10, requesterRole: 'trustee', sourceType: TRUST_TOKEN_SOURCE, tokenAddress: TRUST_TOKEN, chainId: 84532,
    })).rejects.toMatchObject({ code: 'INSUFFICIENT_SOURCE_FUNDS', status: 422 });
    expect(send).not.toHaveBeenCalled();
  });

  it('books the obligation only after the chain confirms a live transfer', async () => {
    process.env.THIRDWEB_SERVER_WALLET_LIVE = 'true';
    process.env.THIRDWEB_SERVER_WALLET_ALLOWED_RECIPIENTS = EXPENSE;
    vi.spyOn(ThirdwebServerWalletEngine, 'balance').mockResolvedValue(balances('25000000000000000000'));
    vi.spyOn(ThirdwebServerWalletEngine, 'send').mockResolvedValue({ id: 'TWX-1', transactionId: 'tx-send', shadow: false, status: 'QUEUED' } as any);
    const wait = vi.spyOn(ThirdwebServerWalletEngine, 'waitForTransaction').mockResolvedValue({ status: 'CONFIRMED', transactionHash: '0xfeed' } as any);

    const funding = await BeneficiaryExpenseWalletEngine.fund({
      beneficiary: 'Jane Doe', purpose: 'medical', amountUsd: 10, requesterRole: 'trustee', sourceType: TRUST_TOKEN_SOURCE, tokenAddress: TRUST_TOKEN, chainId: 84532,
    });
    expect(wait).toHaveBeenCalledWith('tx-send');
    expect(wait.mock.invocationCallOrder[0]).toBeLessThan((TrustAccountingEngine.postJournalEntry as any).mock.invocationCallOrder[0]);
    expect(funding).toMatchObject({ shadow: false, transferId: 'TWX-1', transactionId: 'tx-send', transactionHash: '0xfeed', transferStatus: 'CONFIRMED', journalEntryId: 'je-77' });
  });

  it('leaves no obligation behind when the live transfer fails on chain', async () => {
    process.env.THIRDWEB_SERVER_WALLET_LIVE = 'true';
    process.env.THIRDWEB_SERVER_WALLET_ALLOWED_RECIPIENTS = EXPENSE;
    vi.spyOn(ThirdwebServerWalletEngine, 'balance').mockResolvedValue(balances('25000000000000000000'));
    vi.spyOn(ThirdwebServerWalletEngine, 'send').mockResolvedValue({ id: 'TWX-2', transactionId: 'tx-fail', shadow: false, status: 'QUEUED' } as any);
    vi.spyOn(ThirdwebServerWalletEngine, 'waitForTransaction').mockResolvedValue({ status: 'FAILED', error: 'not whitelisted' } as any);

    await expect(BeneficiaryExpenseWalletEngine.fund({
      beneficiary: 'Jane Doe', purpose: 'medical', amountUsd: 10, requesterRole: 'trustee', sourceType: TRUST_TOKEN_SOURCE, tokenAddress: TRUST_TOKEN, chainId: 84532,
    })).rejects.toMatchObject({ code: 'TRANSFER_NOT_CONFIRMED', status: 502, transactionId: 'tx-fail', message: expect.stringMatching(/not whitelisted/) });
    expect(TrustAccountingEngine.postJournalEntry).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('TrustTokenRailEngine.plan', () => {
  beforeEach(shadowRail);

  const base = { issueUsd: 25, initiatedBy: 'trustee-a', approvedBy: 'trustee-b' };

  it('produces a shadow run skeleton with every stage pending and nothing touched', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const run = TrustTokenRailEngine.plan({ ...base, beneficiary: 'Jane Doe', purpose: 'Medical', distributeUsd: 10, requesterRole: 'trustee' });
    expect(run).toMatchObject({ chainId: 84532, signer: 'thirdweb', operator: TREASURY, shadow: true, status: 'planned' });
    expect(run.request).toMatchObject({ bondId: null, issueUsd: 25, beneficiary: 'Jane Doe', purpose: 'medical', distributeUsd: 10, initiatedBy: 'trustee-a', approvedBy: 'trustee-b' });
    expect(run.stages.map((s: any) => s.name)).toEqual(STAGES);
    expect(run.stages.every((s: any) => s.status === 'pending')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('defaults the distribution to the full issuance when a beneficiary is named', () => {
    expect(TrustTokenRailEngine.plan({ ...base, beneficiary: 'Jane Doe', purpose: 'travel', requesterRole: 'trustee' }).request.distributeUsd).toBe(25);
  });

  it('enforces the issue ceiling, whole cents and maker/checker separation', () => {
    expect(() => TrustTokenRailEngine.plan({ ...base, issueUsd: 0 })).toThrow(expect.objectContaining({ code: 'ISSUE_USD_INVALID' }));
    expect(() => TrustTokenRailEngine.plan({ ...base, issueUsd: 25.001 })).toThrow(expect.objectContaining({ code: 'ISSUE_USD_INVALID' }));
    expect(() => TrustTokenRailEngine.plan({ ...base, issueUsd: 1001 })).toThrow(expect.objectContaining({ code: 'ISSUE_CEILING' }));
    process.env.TRUST_TOKEN_RAIL_MAX_ISSUE_USD = '50';
    expect(() => TrustTokenRailEngine.plan({ ...base, issueUsd: 51 })).toThrow(expect.objectContaining({ code: 'ISSUE_CEILING' }));
    expect(() => TrustTokenRailEngine.plan({ ...base, approvedBy: '' })).toThrow(expect.objectContaining({ code: 'MAKER_CHECKER_REQUIRED' }));
    expect(() => TrustTokenRailEngine.plan({ ...base, approvedBy: 'Trustee-A' })).toThrow(expect.objectContaining({ code: 'MAKER_CHECKER_SAME' }));
  });

  it('applies DistributionPolicy to the beneficiary leg', () => {
    expect(() => TrustTokenRailEngine.plan({ ...base, beneficiary: 'Jane', purpose: 'casino', requesterRole: 'trustee' })).toThrow(/not permitted/);
    expect(() => TrustTokenRailEngine.plan({ ...base, beneficiary: 'Jane', purpose: 'medical', distributeUsd: 30, requesterRole: 'trustee' }))
      .toThrow(expect.objectContaining({ code: 'DISTRIBUTE_EXCEEDS_ISSUE' }));
    expect(() => TrustTokenRailEngine.plan({ ...base, beneficiary: 'Jane', purpose: 'medical', distributeUsd: 0, requesterRole: 'trustee' }))
      .toThrow(expect.objectContaining({ code: 'DISTRIBUTE_USD_INVALID' }));
  });

  it('can be switched off', () => {
    process.env.TRUST_TOKEN_RAIL_ENABLED = 'false';
    expect(() => TrustTokenRailEngine.plan(base)).toThrow(expect.objectContaining({ code: 'RAIL_DISABLED', status: 503 }));
  });
});

// ---------------------------------------------------------------------------
describe('bond token lookup is scoped to the chain', () => {
  it('never returns a token deployed on another chain for the same bond', async () => {
    thirdweb();
    process.env.BOND_TOKEN_SHADOW = 'false';
    const sepolia = await BondTokenizationEngine.createToken({ bondId: 7, tokenName: 'Bond 7 Token', tokenSymbol: 'DLBFI7', tokenAddress: BOND_TOKEN });
    expect(JSON.parse(sepolia.metadata)).toMatchObject({ chainId: 84532 });

    expect((await BondTokenizationEngine.getTokenByBondId(7))?.id).toBe(sepolia.id);
    expect((await BondTokenizationEngine.getTokenByBondId(7, { chainId: 84532 }))?.id).toBe(sepolia.id);
    expect(await BondTokenizationEngine.getTokenByBondId(7, { chainId: 8453 })).toBeNull();
  });

  it('asks for the run chain when resolving the bond token', async () => {
    shadowRail();
    const lookup = BondTokenizationEngine.getTokenByBondId as any;
    await TrustTokenRailEngine.run({ issueUsd: 25, initiatedBy: 'trustee-a', approvedBy: 'trustee-b' });
    expect(lookup).toHaveBeenCalledWith(7, { chainId: 84532 });
  });
});

describe('TrustTokenRailEngine shadow run', () => {
  beforeEach(shadowRail);

  const request = { issueUsd: 25, initiatedBy: 'trustee-a', approvedBy: 'trustee-b', beneficiary: 'Jane Doe', purpose: 'medical', distributeUsd: 10, requesterRole: 'trustee' };

  it('walks every stage as a plan, notarizes the run and reconciles clean without touching thirdweb', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const notarize = vi.spyOn(FabricLedgerEngine, 'notarize');
    const run = await TrustTokenRailEngine.run(request);

    expect(run.status).toBe('shadow');
    expect(run.stages.map((s: any) => [s.name, s.status])).toEqual(STAGES.map((n) => [n, 'shadow']));
    expect(fetchSpy).not.toHaveBeenCalled();

    const stage = (n: string) => run.stages.find((s: any) => s.name === n).result;
    expect(stage('position')).toMatchObject({ bondId: 7, principalUsd: 100000, alreadyTokenizedUsd: 99900, headroomUsd: 100, issueUsd: 25 });
    expect(stage('bond_token')).toMatchObject({ shadow: true, created: false, onChain: false, symbol: 'DLBFI7', decimals: 6 });
    expect(stage('issuance')).toMatchObject({ shadow: true, principalUsd: 25, initiatedBy: 'trustee-a', approvedBy: 'trustee-b' });
    expect(stage('trust_token')).toMatchObject({ shadow: true, deployed: false, tokenSymbol: 'DLB-PTCUSD', reservePriceWei: '1000000000000000000' });
    expect(stage('reserve_deposit')).toMatchObject({ shadow: true, reserveUnits: '25000000', expectedTrustToken: '25000000000000000000', expectedUsd: 25, recipient: TREASURY });
    expect(stage('distribution')).toMatchObject({
      shadow: true, amountUsd: 10, quantity: '10000000000000000000', decimals: 18, source: 'trust_token',
      wallet: { identifier: 'dlbt-exp-jane-doe-medical', address: null, purpose: 'medical', provisioned: false },
    });
    expect(stage('distribution').plan[0]).toMatch(/provision server wallet dlbt-exp-jane-doe-medical/);

    expect(notarize).toHaveBeenCalledWith(expect.objectContaining({ recordType: RECORD_TYPE, recordId: run.id, notarizedBy: 'trust-token-rail' }));
    expect(stage('evidence')).toMatchObject({ status: 'shadow', digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(stage('reconcile')).toMatchObject({ clean: true, shadow: true, discrepancies: [] });
    expect(stage('reconcile').checks.map((c: any) => c.name)).toEqual(expect.arrayContaining(['trust_token_backing', 'run_issuance_matches_reserve', 'run_distribution_within_issuance', 'fabric_evidence']));
    expect(stage('reconcile').checks.find((c: any) => c.name === 'fabric_evidence')).toMatchObject({ ok: true, outcome: 'verified' });

    expect(run.summary).toMatchObject({
      shadow: true, position: { bondId: 7 }, reserveDeposit: { reserveUnits: '25000000', mintedTrustToken: '25000000000000000000', mintedUsd: 25, txHash: null },
      distribution: { amountUsd: 10, fundingId: null, txHash: null },
    });
    expect(await TrustTokenRailEngine.getRun(run.id)).toMatchObject({ id: run.id, status: 'shadow' });
    expect((await TrustTokenRailEngine.listRuns({ limit: 5 }))[0].id).toBe(run.id);
  });

  it('keeps the trust token in the treasury when no beneficiary is named', async () => {
    const run = await TrustTokenRailEngine.run({ issueUsd: 25, initiatedBy: 'trustee-a', approvedBy: 'trustee-b' });
    expect(run.status).toBe('shadow');
    expect(run.stages.find((s: any) => s.name === 'distribution')).toMatchObject({ status: 'skipped', result: { skipped: true } });
    expect(run.summary.distribution).toBeNull();
  });

  it('refuses to issue more than the untokenized principal and still notarizes the failed run', async () => {
    const run = await TrustTokenRailEngine.run({ ...request, issueUsd: 150 });
    expect(run.status).toBe('failed');
    expect(run.stages.find((s: any) => s.name === 'position')).toMatchObject({ status: 'failed', code: 'PRINCIPAL_HEADROOM' });
    for (const n of ['bond_token', 'issuance', 'trust_token', 'reserve_deposit', 'distribution']) {
      expect(run.stages.find((s: any) => s.name === n).status).toBe('skipped');
    }
    expect(run.stages.find((s: any) => s.name === 'evidence').status).toBe('shadow');
    expect((await FabricLedgerEngine.history(RECORD_TYPE, run.id)).length).toBe(1);
  });

  it('rejects an inactive or unknown position', async () => {
    (FixedIncomeDataService.getPosition as any).mockResolvedValueOnce(position({ status: 'matured' }));
    let run = await TrustTokenRailEngine.run({ ...request, bondId: 7 });
    expect(run.stages[0]).toMatchObject({ status: 'failed', code: 'POSITION_INACTIVE' });
    run = await TrustTokenRailEngine.run({ ...request, bondId: 99 });
    expect(run.stages[0]).toMatchObject({ status: 'failed', code: 'POSITION_NOT_FOUND' });
  });

  it('never asks thirdweb to provision an expense wallet while planning', async () => {
    const ensure = vi.spyOn(BeneficiaryExpenseWalletEngine, 'ensureWallet');
    (BeneficiaryExpenseWalletEngine.listWallets as any).mockResolvedValue([{ identifier: 'dlbt-exp-jane-doe-medical', address: EXPENSE }]);
    const run = await TrustTokenRailEngine.run(request);
    expect(ensure).not.toHaveBeenCalled();
    expect(run.stages.find((s: any) => s.name === 'distribution').result.wallet).toMatchObject({ address: EXPENSE, provisioned: true });
    expect(run.summary.distribution.wallet).toBe(EXPENSE);
  });

  it('leaves a run unnotarized when Fabric rejects the evidence, and completes it on notarize', async () => {
    vi.spyOn(FabricLedgerEngine, 'notarize').mockRejectedValueOnce(new Error('fabconnect /transactions failed: Signer org_x does not exist'));
    const run = await TrustTokenRailEngine.run(request);

    expect(run.status).toBe(UNNOTARIZED);
    expect(run.stages.find((s: any) => s.name === 'evidence')).toMatchObject({ status: 'failed', error: expect.stringMatching(/Signer org_x/) });
    expect(run.stages.find((s: any) => s.name === 'distribution').status).toBe('shadow');
    const reconcile = run.stages.find((s: any) => s.name === 'reconcile');
    expect(reconcile.status).toBe('discrepancies');
    expect(reconcile.result.discrepancies).toEqual([expect.objectContaining({ name: 'fabric_evidence', error: expect.stringMatching(/not notarized/) })]);
    expect(run.summary.evidence).toBeNull();

    const stored = await TrustTokenRailEngine.getRun(run.id);
    expect(stored).toMatchObject({ status: UNNOTARIZED, summary: { reserveDeposit: { reserveUnits: '25000000' } }, request: { initiatedBy: 'trustee-a', approvedBy: 'trustee-b' } });

    const fixed = await TrustTokenRailEngine.notarize({ runId: run.id });
    expect(fixed.status).toBe('shadow');
    expect(fixed.stages.find((s: any) => s.name === 'evidence')).toMatchObject({ status: 'shadow', error: null, result: { payload: expect.objectContaining({ runId: run.id, reserveDeposit: { reserveUnits: '25000000', mintedTrustToken: '25000000000000000000', mintedUsd: 25, txHash: null } }) } });
    expect(fixed.stages.find((s: any) => s.name === 'reconcile').result).toMatchObject({ clean: true });
    expect(fixed.summary.evidence).toMatchObject({ digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await FabricLedgerEngine.history(RECORD_TYPE, run.id)).length).toBe(1);

    // idempotent: an already-notarized run is returned untouched
    const notarize = vi.spyOn(FabricLedgerEngine, 'notarize');
    expect((await TrustTokenRailEngine.notarize({ runId: run.id })).status).toBe('shadow');
    expect(notarize).not.toHaveBeenCalled();
    await expect(TrustTokenRailEngine.notarize({ runId: 'TTR-nope' })).rejects.toMatchObject({ status: 404 });
  });

  it('reconciles a stored run from its persisted summary, including the Fabric digest', async () => {
    const run = await TrustTokenRailEngine.run(request);
    const stored = await TrustTokenRailEngine.getRun(run.id);
    const result = await TrustTokenRailEngine.reconcile({ run: stored });
    expect(result.clean).toBe(true);
    expect(result.checks.map((c: any) => c.name)).toEqual(expect.arrayContaining(['run_issuance_matches_reserve', 'run_distribution_within_issuance', 'fabric_evidence']));
    expect(result.checks.find((c: any) => c.name === 'fabric_evidence')).toMatchObject({ ok: true, outcome: 'verified' });
  });

  it('reports readiness, network and the off-ramp hooks', () => {
    const r = TrustTokenRailEngine.readiness();
    expect(r).toMatchObject({ provider: 'trust-token-rail', trust: 'DEANDREA LAVAR BARKLEY FAMILY TRUST', chainId: 84532, network: 'base-sepolia', signer: 'thirdweb', operator: TREASURY, shadow: true, live: false });
    expect(r.offRamp).toMatchObject({ redeemToUsdc: { configured: false }, spritz: { configured: false }, pushToCard: { configured: false }, hce: { configured: false } });
    process.env.SPRITZ_API_KEY = 'k';
    process.env.THIRDWEB_SETTLEMENT_TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    expect(TrustTokenRailEngine.offRamp()).toMatchObject({ redeemToUsdc: { configured: true }, spritz: { configured: true } });
  });
});

// ---------------------------------------------------------------------------
describe('TrustTokenRailEngine live reserve deposit', () => {
  const liveRun = (issueUsd: number) => ({ id: 'TTR-live', shadow: false, request: { issueUsd } });
  const ctx = () => ({ bondToken: { id: 'BT-1', token_address: BOND_TOKEN, token_symbol: 'DLBFI7' } });

  beforeEach(() => {
    thirdweb();
    process.env.THIRDWEB_SERVER_WALLET_LIVE = 'true';
  });

  it('deposits whole bond units and verifies the mint against on-chain supply', async () => {
    vi.spyOn(PtcStablecoinEngine, 'totalSupply').mockResolvedValueOnce('100').mockResolvedValueOnce('125.5');
    const deposit = vi.spyOn(PtcStablecoinEngine, 'approveAndDeposit').mockResolvedValue({ token: BOND_TOKEN, amount: '25500000', mintedStablecoin: '0', recipient: TREASURY, txHash: '0xdep' });
    const c = ctx();
    const out = await TrustTokenRailEngine._reserveDeposit(liveRun(25.5), c);
    expect(deposit).toHaveBeenCalledWith({ token: BOND_TOKEN, amount: '25.50', recipient: TREASURY });
    expect(out).toMatchObject({ reserveUnits: '25500000', mintedTrustToken: '25500000000000000000', mintedUsd: 25.5, expectedTrustToken: '25500000000000000000', txHash: '0xdep', matchesExpectation: true });
    expect(c.deposit).toMatchObject({ amount: '25500000', mintedStablecoin: '25500000000000000000', mintedUsd: 25.5 });
  });

  it('fails the run when the vault mints something other than the valuation', async () => {
    vi.spyOn(PtcStablecoinEngine, 'totalSupply').mockResolvedValueOnce('0').mockResolvedValueOnce('24');
    vi.spyOn(PtcStablecoinEngine, 'approveAndDeposit').mockResolvedValue({ token: BOND_TOKEN, amount: '25000000', mintedStablecoin: '25000000000000000000', recipient: TREASURY, txHash: '0xdep' });
    await expect(TrustTokenRailEngine._reserveDeposit(liveRun(25), ctx())).rejects.toMatchObject({ code: 'RESERVE_MINT_MISMATCH', status: 502 });
  });

  it('fails the run when fewer bond units moved than the issuance', async () => {
    vi.spyOn(PtcStablecoinEngine, 'totalSupply').mockResolvedValue('0');
    vi.spyOn(PtcStablecoinEngine, 'approveAndDeposit').mockResolvedValue({ token: BOND_TOKEN, amount: '25', mintedStablecoin: '0', recipient: TREASURY, txHash: '0xdep' });
    await expect(TrustTokenRailEngine._reserveDeposit(liveRun(25), ctx())).rejects.toMatchObject({ code: 'RESERVE_UNITS_MISMATCH' });
  });

  it('values the reserve at the configured price', async () => {
    process.env.TRUST_TOKEN_RAIL_RESERVE_PRICE_USD = '0.98';
    vi.spyOn(PtcStablecoinEngine, 'totalSupply').mockResolvedValueOnce('0').mockResolvedValueOnce('98');
    vi.spyOn(PtcStablecoinEngine, 'approveAndDeposit').mockResolvedValue({ token: BOND_TOKEN, amount: '100000000', mintedStablecoin: '0', recipient: TREASURY, txHash: '0xdep' });
    const out = await TrustTokenRailEngine._reserveDeposit(liveRun(100), ctx());
    expect(out).toMatchObject({ reserveUnits: '100000000', expectedTrustToken: '98000000000000000000', mintedUsd: 98 });
  });
});
