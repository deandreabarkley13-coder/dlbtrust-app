import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const {
  ThirdwebWalletEngine,
  DEFAULT_ACCOUNT_FACTORY_V0_6,
  DEFAULT_ACCOUNT_FACTORY_V0_7,
  ENTRY_POINT_V0_7,
  saltHex,
} = require('../server/integrations/dapp/thirdwebWalletEngine');
const { SmartWalletProvisioner } = require('../server/integrations/dapp/smartWalletProvisioner');
const { AccountAbstractionEngine } = require('../server/integrations/dapp/accountAbstractionEngine');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };
const OWNER = '0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16';

beforeEach(() => {
  vi.spyOn(pool, 'query').mockResolvedValue({ rows: [], rowCount: 0 } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('thirdweb wallet engine', () => {
  it('defaults to the thirdweb v0.6 factory and per-chain bundler, shadow and unsponsored', () => {
    const status = ThirdwebWalletEngine.readiness();
    expect(status.provider).toBe('thirdweb');
    expect(status.shadow).toBe(true);
    expect(status.factory).toBe(DEFAULT_ACCOUNT_FACTORY_V0_6);
    expect(status.bundlerUrl).toBe(`https://${status.chainId}.bundler.thirdweb.com/v2`);
    expect(status.canSponsorGas).toBe(false);
  });

  it('selects the v0.7 factory when the v0.7 EntryPoint is configured', () => {
    process.env.THIRDWEB_ENTRY_POINT = ENTRY_POINT_V0_7;
    expect(ThirdwebWalletEngine.getConfig().factory).toBe(DEFAULT_ACCOUNT_FACTORY_V0_7);
  });

  it('encodes account salts the way the thirdweb SDK does', () => {
    expect(saltHex('')).toBe('0x');
    expect(saltHex('trust')).toBe('0x7472757374');
    expect(saltHex('0xabcd')).toBe('0xabcd');
  });

  // Shadow prediction must be a pure local derivation: no RPC, no thirdweb
  // call, and stable across calls so the workflow is reproducible.
  it('predicts a deterministic address off-chain without contacting thirdweb', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const first = await ThirdwebWalletEngine.predictAccountAddress(OWNER);
    const second = await ThirdwebWalletEngine.predictAccountAddress(OWNER);

    expect(first.mode).toBe('shadow');
    expect(first.address).toBe(second.address);
    expect(first.address).toBe(ThirdwebWalletEngine.shadowAddress(OWNER));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects prediction without an admin address', async () => {
    await expect(ThirdwebWalletEngine.predictAccountAddress('')).rejects.toThrow(/admin address/i);
  });

  it('registers sponsorship eligibility without any on-chain transaction', () => {
    const sponsorship = ThirdwebWalletEngine.registerSponsoredSender(OWNER, true);
    expect(sponsorship.onChain).toBe(false);
    expect(sponsorship.allowed).toBe(true);
    expect(sponsorship.shadow).toBe(true);
  });

  it('refuses to sponsor a user operation while shadow is on', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await ThirdwebWalletEngine.sponsorUserOperation({ sender: OWNER });
    expect(result.sponsored).toBe(false);
    expect(result.shadow).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still refuses to sponsor when shadow is off but the live flag or secret is missing', async () => {
    process.env.THIRDWEB_SHADOW = 'false';
    process.env.THIRDWEB_SECRET_KEY = 'sk-test';
    delete process.env.THIRDWEB_GAS_SPONSORSHIP_LIVE;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await ThirdwebWalletEngine.sponsorUserOperation({ sender: OWNER });
    expect(result.sponsored).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('smart wallet provisioning through thirdweb', () => {
  it('issues thirdweb accounts by default and never calls the self-hosted paymaster', async () => {
    const whitelist = vi.spyOn(AccountAbstractionEngine, 'whitelistSender');

    const record = await SmartWalletProvisioner.provisionForUser({
      id: 'user-1',
      email: 'holder@example.com',
    });

    expect(record.provider).toBe('thirdweb');
    expect(record.mode).toBe('shadow');
    expect(record.address).toBe(ThirdwebWalletEngine.shadowAddress(record.owner));
    expect(record.whitelisted).toBe(true);
    expect(record.whitelistMode).toBe('shadow');
    expect(whitelist).not.toHaveBeenCalled();
  });

  it('keeps the self-hosted SimpleAccount path available', async () => {
    process.env.SMART_ACCOUNT_PROVIDER = 'simple_account';
    process.env.AA_SHADOW = 'true';
    const whitelist = vi
      .spyOn(AccountAbstractionEngine, 'whitelistSender')
      .mockResolvedValue({ success: true, shadow: true, paymaster: 'shadow-paymaster-1' } as any);

    const record = await SmartWalletProvisioner.provisionForUser({
      id: 'user-2',
      email: 'holder@example.com',
    });

    expect(record.provider).toBe('simple_account');
    expect(whitelist).toHaveBeenCalledWith(record.address, true);
  });

  // An address stored by one provider is not valid under another, so a
  // provider switch must re-predict rather than reuse it.
  it('re-predicts when the stored account came from a different provider', async () => {
    const owner = SmartWalletProvisioner.ownerFor({ email: 'holder@example.com' });
    const record = await SmartWalletProvisioner.provisionForUser({
      id: 'user-3',
      email: 'holder@example.com',
      smart_account_address: '0x1111111111111111111111111111111111111111',
      smart_account_owner: owner,
      smart_account_provider: 'simple_account',
    });

    expect(record.provider).toBe('thirdweb');
    expect(record.address).toBe(ThirdwebWalletEngine.shadowAddress(owner));
  });

  it('reports the active wallet provider in readiness', () => {
    const status = SmartWalletProvisioner.readiness();
    expect(status.walletProvider).toBe('thirdweb');
    expect(status.autoProvision).toBe(true);
    expect(status.shadow).toBe(true);
  });
});
