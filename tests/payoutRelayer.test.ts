import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const ACCOUNT = '0x3e53028cf69949f3B961ce786Baf2D4D75166562';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SPRITZ = '0x1111111111111111111111111111111111111111';
const TRUSTEE = '0xD7Fa15572dc6553FEaC54E2304E42dce82443cb0';
const RELAYER_KEY = '0x' + '11'.repeat(32);

process.env.DAPP_CHAIN_ID = '8453';
process.env.DAPP_RPC_URL = 'http://127.0.0.1:1';
process.env.SPRITZ_PAYOUT_WALLET = ACCOUNT;
process.env.THIRDWEB_SETTLEMENT_TOKEN = USDC;
process.env.SPRITZ_RELAYER_PRIVATE_KEY = RELAYER_KEY;

const { privateKeyToAccount } = require('viem/accounts');
const viem = require('viem');
const { PayoutRelayerEngine, PERMISSION_TYPES } = require('../server/integrations/dapp/payoutRelayerEngine');
const { SpritzTreasuryLegEngine } = require('../server/integrations/spritz/spritzTreasuryLegEngine');
const { TrustPolicyEngine } = require('../server/integrations/dapp/trustPolicyEngine');
const { SpritzEngine } = require('../server/integrations/spritz/spritzEngine');

const RELAYER = privateKeyToAccount(RELAYER_KEY).address;

function fakeClient(reads: Record<string, unknown>, code = '0x6001') {
  return {
    getBytecode: async () => code,
    readContract: async ({ functionName }: { functionName: string }) => {
      if (!(functionName in reads)) throw new Error(`unexpected read ${functionName}`);
      return reads[functionName];
    },
  };
}

describe('Payout relayer (session-key account abstraction)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.SPRITZ_PAYOUT_RELAYER = 'session_key';
    delete process.env.SPRITZ_RELAYER_APPROVED_TARGETS;
  });
  afterEach(() => { delete process.env.SPRITZ_PAYOUT_RELAYER; });

  it('derives the relayer from its key and stays disabled unless SPRITZ_PAYOUT_RELAYER=session_key', () => {
    expect(PayoutRelayerEngine.config()).toMatchObject({ mode: 'session_key', smartAccount: ACCOUNT, relayer: RELAYER, settlementToken: USDC, chainId: 8453 });
    expect(PayoutRelayerEngine.enabled).toBe(true);
    process.env.SPRITZ_PAYOUT_RELAYER = 'off';
    expect(PayoutRelayerEngine.enabled).toBe(false);
  });

  it('reports the Coinbase EOA payout wallet as not a smart account instead of pretending a session key exists', async () => {
    vi.spyOn(PayoutRelayerEngine as any, '_publicClient').mockReturnValue(fakeClient({}, '0x'));
    const st = await PayoutRelayerEngine.status();
    expect(st).toMatchObject({ enabled: true, isSmartAccount: false, ready: false, smartAccount: ACCOUNT, relayer: RELAYER });
    expect(st.issues.join(' ')).toMatch(/EOA/);
  });

  it('treats an EIP-7702 delegated EOA (Coinbase) as not a thirdweb smart account', async () => {
    const delegate = '0x7702cb554e6bfb442cb743a7df23154544a7176c';
    vi.spyOn(PayoutRelayerEngine as any, '_publicClient').mockReturnValue(fakeClient({}, `0xef0100${delegate.slice(2)}`));
    const st = await PayoutRelayerEngine.status();
    expect(st).toMatchObject({ enabled: true, isSmartAccount: false, ready: false });
    expect(st.eip7702Delegate.toLowerCase()).toBe(delegate);
    expect(st.issues.join(' ')).toMatch(/EIP-7702/);
  });

  it('is ready only for an active, scoped, in-window, non-admin session key on the settlement token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const reads = {
      getAllAdmins: [TRUSTEE],
      isActiveSigner: true,
      isAdmin: false,
      getPermissionsForSigner: { signer: RELAYER, approvedTargets: [USDC, SPRITZ], nativeTokenLimitPerTransaction: 0n, startTimestamp: BigInt(now - 10), endTimestamp: BigInt(now + 20 * 86400) },
    };
    vi.spyOn(PayoutRelayerEngine as any, '_publicClient').mockReturnValue(fakeClient(reads));
    const ok = await PayoutRelayerEngine.status();
    expect(ok.ready).toBe(true);
    expect(ok.admins).toEqual([TRUSTEE]);
    expect(ok.session).toMatchObject({ active: true, isAdmin: false, approvedTargets: [USDC, SPRITZ], nativeTokenLimitPerTransaction: '0' });

    vi.spyOn(PayoutRelayerEngine as any, '_publicClient').mockReturnValue(fakeClient({ ...reads, isAdmin: true }));
    expect((await PayoutRelayerEngine.status()).issues.join(' ')).toMatch(/ADMIN/);

    vi.spyOn(PayoutRelayerEngine as any, '_publicClient').mockReturnValue(fakeClient({ ...reads, getPermissionsForSigner: { ...reads.getPermissionsForSigner, nativeTokenLimitPerTransaction: 1n } }));
    expect((await PayoutRelayerEngine.status()).issues.join(' ')).toMatch(/native ETH/);

    vi.spyOn(PayoutRelayerEngine as any, '_publicClient').mockReturnValue(fakeClient({ ...reads, getPermissionsForSigner: { ...reads.getPermissionsForSigner, approvedTargets: [SPRITZ] } }));
    expect((await PayoutRelayerEngine.status()).issues.join(' ')).toMatch(/settlement token/);
  });

  it('prepares a non-admin, zero-native, time-bounded EIP-712 grant the trustee can sign and the relayer can verify', async () => {
    vi.spyOn(PayoutRelayerEngine as any, '_publicClient').mockReturnValue(fakeClient({ getAllAdmins: [TRUSTEE] }));
    const grant = await PayoutRelayerEngine.prepareSessionKeyGrant({ approvedTargets: [SPRITZ], durationSeconds: 7 * 86400 });
    expect(grant).toMatchObject({ action: 'grantSessionKey', smartAccount: ACCOUNT, chainId: 8453, signer: RELAYER, admins: [TRUSTEE] });
    expect(grant.request.isAdmin).toBe(0);
    expect(grant.request.nativeTokenLimitPerTransaction).toBe('0');
    expect(grant.scope.approvedTargets).toEqual([USDC, SPRITZ]);
    expect(grant.scope.endTimestamp - grant.scope.startTimestamp).toBe(7 * 86400);
    expect(grant.typedData.domain).toEqual({ name: 'Account', version: '1', chainId: 8453, verifyingContract: ACCOUNT });
    expect(grant.typedData.types).toEqual(PERMISSION_TYPES);

    const trustee = privateKeyToAccount('0x' + '22'.repeat(32));
    const msg = { ...grant.request, nativeTokenLimitPerTransaction: 0n, permissionStartTimestamp: BigInt(grant.request.permissionStartTimestamp), permissionEndTimestamp: BigInt(grant.request.permissionEndTimestamp), reqValidityStartTimestamp: BigInt(grant.request.reqValidityStartTimestamp), reqValidityEndTimestamp: BigInt(grant.request.reqValidityEndTimestamp) };
    const signature = await trustee.signTypedData({ ...grant.typedData, message: msg });
    expect(await viem.verifyTypedData({ ...grant.typedData, message: msg, signature, address: trustee.address })).toBe(true);
  });

  it('refuses to submit an admin grant through the relayer path', async () => {
    await expect(PayoutRelayerEngine.submitSessionKeyGrant({ request: { signer: RELAYER, isAdmin: 1, approvedTargets: [], uid: '0x' + '00'.repeat(32) }, signature: '0xabcd' }))
      .rejects.toMatchObject({ code: 'RELAYER_ADMIN_GRANT_FORBIDDEN' });
  });

  it('relayPayout refuses calls outside the session scope before touching the bundler', async () => {
    const now = Math.floor(Date.now() / 1000);
    vi.spyOn(PayoutRelayerEngine as any, '_publicClient').mockReturnValue(fakeClient({
      getAllAdmins: [TRUSTEE], isActiveSigner: true, isAdmin: false,
      getPermissionsForSigner: { signer: RELAYER, approvedTargets: [USDC], nativeTokenLimitPerTransaction: 0n, startTimestamp: 0n, endTimestamp: BigInt(now + 30 * 86400) },
    }));
    await expect(PayoutRelayerEngine.relayPayout({ unsignedTx: { quoteId: 'q', payment: { to: SPRITZ, data: '0x', value: '0' } } }))
      .rejects.toMatchObject({ code: 'RELAYER_TARGET_NOT_APPROVED' });
  });

  it('executePayout books the payout when the session-key relayer settles it, and falls back to the external wallet when the relayer is off', async () => {
    vi.spyOn(TrustPolicyEngine, 'execute').mockResolvedValue({ status: 'released' } as any);
    vi.spyOn(SpritzEngine, 'prepareQuoteTransaction').mockResolvedValue({ quoteId: 'q_9', approve: null, payment: { to: SPRITZ, data: '0x01', value: '0' } } as any);
    const relay = vi.spyOn(PayoutRelayerEngine, 'relayPayout').mockResolvedValue({ txHash: '0xtx', userOpHash: '0xop', signer: { type: 'session_key', relayer: RELAYER } } as any);
    const book = vi.spyOn(SpritzTreasuryLegEngine as any, '_bookPayout').mockImplementation(async (args: any) => ({ status: 'settled', settlement: args.settlement }));

    const settled = await SpritzTreasuryLegEngine.executePayout({ distributionId: '7', spritzQuoteId: 'q_9', reference: 'PAY-9', amountUsd: 100 });
    expect(relay).toHaveBeenCalledWith(expect.objectContaining({ reference: 'PAY-9' }));
    expect(settled).toMatchObject({ status: 'settled', settlement: { txHash: '0xtx', userOpHash: '0xop', signer: 'session_key', relayer: RELAYER } });

    process.env.SPRITZ_PAYOUT_RELAYER = 'off';
    book.mockClear(); relay.mockClear();
    const manual = await SpritzTreasuryLegEngine.executePayout({ distributionId: '7', spritzQuoteId: 'q_9', reference: 'PAY-9', amountUsd: 100 });
    expect(relay).not.toHaveBeenCalled();
    expect(book).not.toHaveBeenCalled();
    expect(manual).toMatchObject({ status: 'awaiting_signature', signer: { type: 'external' } });
  });

  it('predicts the trustee-admin smart account and returns an unsigned createAccount tx without broadcasting', async () => {
    const PREDICTED = '0x2222222222222222222222222222222222222222';
    const DEPLOYER = '0x3333333333333333333333333333333333333333';
    const FACTORY = PayoutRelayerEngine.config().thirdweb.factory;
    vi.spyOn(TrustPolicyEngine, 'status').mockResolvedValue({ owner: TRUSTEE } as any);
    const client = {
      getBytecode: async ({ address }: { address: string }) => (address.toLowerCase() === FACTORY.toLowerCase() ? '0x6001' : '0x'),
      readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
        if (functionName === 'getAddress') {
          if ((args as string[])[0] === RELAYER) return DEPLOYER;
          expect(args).toEqual([viem.getAddress(TRUSTEE), '0x']);
          return PREDICTED;
        }
        if (functionName === 'entrypoint') return PayoutRelayerEngine.config().entryPoint;
        throw new Error(`unexpected read ${functionName}`);
      },
    };
    vi.spyOn(PayoutRelayerEngine as any, '_publicClient').mockReturnValue(client);
    const prep = await PayoutRelayerEngine.prepareSmartAccount();
    expect(prep).toMatchObject({ action: 'deploySmartAccount', admin: viem.getAddress(TRUSTEE), address: PREDICTED, deployed: false, configured: false, factory: viem.getAddress(FACTORY) });
    expect(prep.unsignedTx).toMatchObject({ to: viem.getAddress(FACTORY), value: '0', chainId: 8453 });
    const decoded = viem.decodeFunctionData({ abi: viem.parseAbi(['function createAccount(address admin, bytes data) returns (address)']), data: prep.unsignedTx.data });
    expect(decoded).toEqual({ functionName: 'createAccount', args: [viem.getAddress(TRUSTEE), '0x'] });
    expect(prep.issues.join(' ')).toMatch(/SPRITZ_PAYOUT_WALLET/);
    expect(prep.deployer).toMatchObject({ address: DEPLOYER, admin: RELAYER, deployed: false });

    await expect(PayoutRelayerEngine.prepareSmartAccount({ admin: RELAYER })).rejects.toMatchObject({ code: 'RELAYER_ADMIN_IS_RELAYER' });
    await expect(PayoutRelayerEngine.deploySmartAccount({})).rejects.toMatchObject({ code: 'RELAYER_CONFIRM_REQUIRED' });
  });

  it('falls back to a sponsored UserOp from the relayer helper account when the relayer EOA has no gas', async () => {
    const PREDICTED = '0x2222222222222222222222222222222222222222';
    const DEPLOYER = '0x3333333333333333333333333333333333333333';
    const FACTORY = PayoutRelayerEngine.config().thirdweb.factory;
    vi.spyOn(TrustPolicyEngine, 'status').mockResolvedValue({ owner: TRUSTEE } as any);
    const deployedAfter = { value: false };
    const client = {
      getBalance: async () => 0n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 1n }),
      getBytecode: async ({ address }: { address: string }) => {
        if (address.toLowerCase() === FACTORY.toLowerCase()) return '0x6001';
        if (address === PREDICTED) return deployedAfter.value ? '0x6002' : '0x';
        return '0x';
      },
      readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
        if (functionName === 'getAddress') return (args as string[])[0] === RELAYER ? DEPLOYER : PREDICTED;
        if (functionName === 'entrypoint') return PayoutRelayerEngine.config().entryPoint;
        if (functionName === 'getNonce') return 0n;
        throw new Error(`unexpected read ${functionName}`);
      },
    };
    vi.spyOn(PayoutRelayerEngine as any, '_publicClient').mockReturnValue(client);
    const { ThirdwebWalletEngine } = require('../server/integrations/dapp/thirdwebWalletEngine');
    vi.spyOn(ThirdwebWalletEngine, 'readiness').mockReturnValue({ canSponsorGas: true });
    const sponsor = vi.spyOn(ThirdwebWalletEngine, 'sponsorUserOperation').mockResolvedValue({ sponsored: true, paymasterAndData: '0x' + 'aa'.repeat(40) });
    const sent: any[] = [];
    const aa = require('viem/account-abstraction');
    vi.spyOn(aa, 'createBundlerClient').mockReturnValue({
      request: async ({ method, params }: { method: string; params: any[] }) => {
        if (method === 'eth_estimateUserOperationGas') return { callGasLimit: '0x10000', verificationGasLimit: '0x20000', preVerificationGas: '0x8000' };
        if (method === 'eth_sendUserOperation') { sent.push(params[0]); return '0x' + 'cd'.repeat(32); }
        throw new Error(method);
      },
    });
    vi.spyOn(aa, 'waitForUserOperationReceipt').mockImplementation(async () => { deployedAfter.value = true; return { success: true, receipt: { transactionHash: '0x' + 'ef'.repeat(32) } }; });

    const out = await PayoutRelayerEngine.deploySmartAccount({ confirm: true });
    expect(out).toMatchObject({ action: 'smartAccountDeployed', deployed: true, via: 'sponsored', payer: DEPLOYER, txHash: '0x' + 'ef'.repeat(32), admin: viem.getAddress(TRUSTEE) });
    expect(sponsor).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].sender).toBe(DEPLOYER);
    expect(sent[0].initCode.toLowerCase().startsWith(FACTORY.toLowerCase())).toBe(true);
    expect(sent[0].paymasterAndData).toBe('0x' + 'aa'.repeat(40));
    const exec = viem.decodeFunctionData({ abi: viem.parseAbi(['function execute(address target, uint256 value, bytes data)']), data: sent[0].callData });
    expect(exec.args[0]).toBe(viem.getAddress(FACTORY));
    const inner = viem.decodeFunctionData({ abi: viem.parseAbi(['function createAccount(address admin, bytes data) returns (address)']), data: exec.args[2] as `0x${string}` });
    expect(inner.args).toEqual([viem.getAddress(TRUSTEE), '0x']);

    sponsor.mockResolvedValue({ sponsored: false, reason: 'denied' });
    deployedAfter.value = false;
    await expect(PayoutRelayerEngine.deploySmartAccount({ confirm: true, via: 'sponsored' })).rejects.toMatchObject({ code: 'RELAYER_SPONSORSHIP_DENIED' });
  });
});
