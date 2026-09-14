import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { join } from 'path';

const require = createRequire(import.meta.url);

const POLICY = '0x9682bEF7fbA219DB0dF7A52B5b7151484aFceB64';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SERVER_WALLET = '0x1A904F795a0511C31Ba6347504D08d1bA58E4f89';
const CHECKER_KEY = '0x' + '22'.repeat(32);
const CHECKER_ADDRESS = '0x1563915e194D8CfBA1943570603F7606A3115508';
// Derives to SERVER_WALLET only if it were the server wallet's key; we set the
// server wallet env to the derived address to simulate the misconfiguration.
const MAKER_KEY = '0x' + '33'.repeat(32);
const RPC = 'https://mainnet.base.org';

process.env.TRUST_POLICY_ADDRESS = POLICY;
process.env.THIRDWEB_SETTLEMENT_TOKEN = USDC;
process.env.THIRDWEB_SERVER_WALLET_ADDRESS = SERVER_WALLET;
process.env.THIRDWEB_SERVER_WALLET_CHAIN_ID = '8453';

const { privateKeyToAccount } = require('viem/accounts');
const { TrustPolicyEngine, SIG } = require('../server/integrations/dapp/trustPolicyEngine');
const { ThirdwebServerWalletEngine } = require('../server/integrations/dapp/thirdwebServerWalletEngine');

function setChecker({ key = CHECKER_KEY, rpc = RPC, live = 'true', policyLive = 'true' }: { key?: string | null; rpc?: string | null; live?: string; policyLive?: string } = {}) {
  if (key) process.env.TRUST_POLICY_CHECKER_PRIVATE_KEY = key; else delete process.env.TRUST_POLICY_CHECKER_PRIVATE_KEY;
  if (rpc) process.env.TRUST_POLICY_CHECKER_RPC_URL = rpc; else delete process.env.TRUST_POLICY_CHECKER_RPC_URL;
  process.env.TRUST_POLICY_CHECKER_LIVE = live;
  process.env.TRUST_POLICY_LIVE = policyLive;
}

describe('TrustPolicyEngine.approveAsChecker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.THIRDWEB_SERVER_WALLET_ADDRESS = SERVER_WALLET;
  });

  afterEach(() => {
    delete process.env.TRUST_POLICY_CHECKER_PRIVATE_KEY;
    delete process.env.TRUST_POLICY_CHECKER_RPC_URL;
    delete process.env.TRUST_POLICY_CHECKER_LIVE;
    delete process.env.TRUST_POLICY_LIVE;
  });

  it('submits approve from the checker account, never the server wallet', async () => {
    setChecker();
    const writeContract = vi.fn().mockResolvedValue('0xabc');
    const client = vi.spyOn(TrustPolicyEngine, '_checkerWalletClient').mockReturnValue({ writeContract } as any);
    const serverWrite = vi.spyOn(ThirdwebServerWalletEngine, 'writeContract').mockResolvedValue({ transactionIds: ['nope'], from: SERVER_WALLET } as any);

    const record = await TrustPolicyEngine.approveAsChecker({ distributionId: '7' });

    expect(serverWrite).not.toHaveBeenCalled();
    expect(client).toHaveBeenCalledTimes(1);
    const { account, chain, rpcUrl } = client.mock.calls[0][0];
    expect(account.address).toBe(CHECKER_ADDRESS);
    expect(chain.id).toBe(8453);
    expect(rpcUrl).toBe(RPC);
    expect(writeContract).toHaveBeenCalledTimes(1);
    const args = writeContract.mock.calls[0][0];
    expect(args.address).toBe(POLICY);
    expect(args.functionName).toBe('approve');
    expect(args.args).toEqual([7n]);

    expect(record).toMatchObject({
      provider: 'trust-distribution-policy',
      action: 'approve',
      contract: POLICY,
      chainId: 8453,
      from: CHECKER_ADDRESS,
      call: { contractAddress: POLICY, method: SIG.approve, params: ['7'] },
      shadow: false,
      status: 'submitted',
      transactionId: '0xabc',
      idempotencyKey: 'tdp-approve-7',
    });
    expect(record.from.toLowerCase()).not.toBe(SERVER_WALLET.toLowerCase());
  });

  it('returns a shadow record and submits nothing when TRUST_POLICY_CHECKER_LIVE=false', async () => {
    setChecker({ live: 'false' });
    const client = vi.spyOn(TrustPolicyEngine, '_checkerWalletClient');
    const serverWrite = vi.spyOn(ThirdwebServerWalletEngine, 'writeContract');

    const record = await TrustPolicyEngine.approveAsChecker({ distributionId: 3 });

    expect(client).not.toHaveBeenCalled();
    expect(serverWrite).not.toHaveBeenCalled();
    expect(record).toMatchObject({ shadow: true, status: 'shadow', transactionId: null, from: CHECKER_ADDRESS, action: 'approve' });
    expect(record.reason).toContain('TRUST_POLICY_CHECKER_LIVE=false');
  });

  it('honours TRUST_POLICY_LIVE=false even when the checker signer is live', async () => {
    setChecker({ policyLive: 'false' });
    const client = vi.spyOn(TrustPolicyEngine, '_checkerWalletClient');
    const record = await TrustPolicyEngine.approveAsChecker({ distributionId: 3 });
    expect(client).not.toHaveBeenCalled();
    expect(record.shadow).toBe(true);
    expect(record.reason).toContain('TRUST_POLICY_LIVE=false');
  });

  it('throws 409 when the checker key derives to the server wallet', async () => {
    process.env.THIRDWEB_SERVER_WALLET_ADDRESS = privateKeyToAccount(MAKER_KEY).address;
    setChecker({ key: MAKER_KEY });
    const client = vi.spyOn(TrustPolicyEngine, '_checkerWalletClient');
    await expect(TrustPolicyEngine.approveAsChecker({ distributionId: 1 })).rejects.toMatchObject({ status: 409, code: 'TRUST_POLICY_CHECKER_IS_MAKER' });
    expect(client).not.toHaveBeenCalled();
  });

  it('throws 409 when the key or RPC URL is missing while live', async () => {
    setChecker({ key: null });
    await expect(TrustPolicyEngine.approveAsChecker({ distributionId: 1 })).rejects.toMatchObject({ status: 409, code: 'TRUST_POLICY_CHECKER_NOT_CONFIGURED' });
    setChecker({ rpc: null });
    await expect(TrustPolicyEngine.approveAsChecker({ distributionId: 1 })).rejects.toMatchObject({ status: 409, code: 'TRUST_POLICY_CHECKER_NOT_CONFIGURED' });
  });

  it('never exposes the private key through getConfig consumers like readiness()', () => {
    setChecker();
    const readiness = TrustPolicyEngine.readiness();
    expect(readiness.checkerSignerConfigured).toBe(true);
    expect(JSON.stringify(readiness)).not.toContain(CHECKER_KEY.slice(2));
  });

  it('leaves approve() on the server wallet', async () => {
    setChecker();
    const serverWrite = vi.spyOn(ThirdwebServerWalletEngine, 'writeContract').mockResolvedValue({ transactionIds: ['t1'], from: SERVER_WALLET } as any);
    const client = vi.spyOn(TrustPolicyEngine, '_checkerWalletClient');
    const record = await TrustPolicyEngine.approve({ distributionId: 2 });
    expect(serverWrite).toHaveBeenCalledTimes(1);
    expect(client).not.toHaveBeenCalled();
    expect(record.from).toBe(SERVER_WALLET);
  });
});

describe('POST /trust-policy/distributions/:id/approve', () => {
  const router = require('../server/routes/dapp');
  const layer = router.stack.find((l: any) => l.route?.path === '/trust-policy/distributions/:distributionId/approve' && l.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;

  function responseStub() {
    const response: any = {
      status: vi.fn(function status(code: number) { response.statusCode = code; return response; }),
      json: vi.fn(function json(body: any) { response.body = body; return response; }),
    };
    return response;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TRUST_POLICY_CHECKER_PRIVATE_KEY;
  });

  it('routes through approveAsChecker when the checker key is configured', async () => {
    process.env.TRUST_POLICY_CHECKER_PRIVATE_KEY = CHECKER_KEY;
    const asChecker = vi.spyOn(TrustPolicyEngine, 'approveAsChecker').mockResolvedValue({ from: CHECKER_ADDRESS } as any);
    const asMaker = vi.spyOn(TrustPolicyEngine, 'approve').mockResolvedValue({ from: SERVER_WALLET } as any);
    const res = responseStub();
    await handler({ params: { distributionId: '9' }, body: {} }, res);
    expect(asChecker).toHaveBeenCalledWith({ distributionId: '9' });
    expect(asMaker).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(201);
    expect(res.body.data.from).toBe(CHECKER_ADDRESS);
  });

  it('falls back to approve() when no checker key is configured', async () => {
    const asChecker = vi.spyOn(TrustPolicyEngine, 'approveAsChecker');
    const asMaker = vi.spyOn(TrustPolicyEngine, 'approve').mockResolvedValue({ from: SERVER_WALLET } as any);
    const res = responseStub();
    await handler({ params: { distributionId: '9' }, body: {} }, res);
    expect(asMaker).toHaveBeenCalledWith({ distributionId: '9' });
    expect(asChecker).not.toHaveBeenCalled();
  });
});

describe('trust dashboard policy buttons', () => {
  const html = readFileSync(join(__dirname, '..', 'public', 'dapp', 'trust-dashboard.html'), 'utf8');

  function body(fnName: string) {
    const start = html.indexOf(`function ${fnName}(`);
    expect(start, `${fnName} not found`).toBeGreaterThan(-1);
    let depth = 0; let i = html.indexOf('{', start);
    for (; i < html.length; i += 1) {
      if (html[i] === '{') depth += 1;
      else if (html[i] === '}') { depth -= 1; if (depth === 0) break; }
    }
    return html.slice(start, i + 1);
  }

  function handlers(source: string) {
    return Array.from(source.matchAll(/onclick=\\?"([A-Za-z_$][\w$.]*)\(/g)).map((m) => m[1]);
  }

  const defined = new Set(Array.from(html.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)).map((m) => m[1]));
  defined.add('loadPolicyProposeOptions.sync');

  it('every policyActions and Distributions queue button maps to a defined handler', () => {
    const sources = [body('policyActions'), body('loadDistributions')];
    const policyTab = html.slice(html.indexOf('id="tab-policy"'), html.indexOf('id="tab-ramps"'));
    sources.push(policyTab);
    const used = sources.flatMap(handlers);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(defined.has(name), `handler ${name} is not defined`).toBe(true);
  });

  it('labels the seats explicitly and gates them', () => {
    const actions = body('policyActions');
    expect(actions).toContain('Checker Approve');
    expect(actions).toContain("policySeatGate('checker')");
    expect(html).toContain('>Maker Propose</button>');
    expect(html).toContain("policySeatGate('maker')");
  });
});
