import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const { SmartWalletProvisioner } = require('../server/integrations/dapp/smartWalletProvisioner');
const { AccountAbstractionEngine } = require('../server/integrations/dapp/accountAbstractionEngine');
const { SiweAuth } = require('../server/integrations/auth/siweAuth');
const { ChainTransferReconciler } = require('../server/integrations/events/chainTransferReconciler');
const { KafkaEventBus } = require('../server/integrations/events/kafkaEventBus');
const { DocumentStorageAdapter } = require('../server/integrations/documents/storageAdapter');
const { RampFeeEngine } = require('../server/integrations/dapp/rampFeeEngine');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const pool = require('../server/integrations/bonds/pgPool');
const viem = require('viem');
const { privateKeyToAccount } = require('viem/accounts');

const saved = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('smart wallet provisioning (shadow)', () => {
  beforeEach(() => {
    vi.spyOn(pool, 'query').mockResolvedValue({ rows: [], rowCount: 0 } as any);
    vi.spyOn(AccountAbstractionEngine, 'whitelistSender').mockResolvedValue({ shadow: true, paymaster: 'shadow-paymaster' } as any);
  });

  it('derives the same counterfactual account for the same email and never deploys', async () => {
    const user = { id: 'U-1', email: 'Beneficiary@example.com' };
    const first = await SmartWalletProvisioner.provisionForUser(user);
    const second = await SmartWalletProvisioner.provisionForUser({ id: 'U-1', email: 'beneficiary@example.com' });

    expect(first.mode).toBe('shadow');
    expect(first.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(second.address).toBe(first.address);
    expect(first.ownerType).toBe('derived');
    expect(first.whitelisted).toBe(true);
  });

  it('prefers a linked wallet as the smart-account owner', async () => {
    const wallet = '0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16';
    const record = await SmartWalletProvisioner.provisionForUser({ id: 'U-2', email: 'w@example.com', wallet_address: wallet });
    expect(record.ownerType).toBe('linked_wallet');
    expect(record.owner.toLowerCase()).toBe(wallet.toLowerCase());
    expect(record.address).not.toBe(
      (await SmartWalletProvisioner.provisionForUser({ id: 'U-3', email: 'w@example.com' })).address
    );
  });

  it('still returns an address when the paymaster whitelist call fails', async () => {
    // Whitelist calls only exist on the self-hosted paymaster provider.
    process.env.SMART_ACCOUNT_PROVIDER = 'simple_account';
    vi.spyOn(AccountAbstractionEngine, 'whitelistSender').mockRejectedValue(new Error('paymaster not deployed'));
    const record = await SmartWalletProvisioner.provisionForUser({ id: 'U-4', email: 'x@example.com' });
    expect(record.address).toMatch(/^0x/);
    expect(record.whitelisted).toBe(false);
    expect(record.whitelistError).toContain('paymaster');
  });
});

describe('SIWE wallet authentication', () => {
  const key = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const account = privateKeyToAccount(key);

  beforeEach(() => { SiweAuth._resetNonces(); });

  async function signIn(overrides: Record<string, any> = {}) {
    const { nonce, issuedAt } = SiweAuth.createNonce({ address: account.address, domain: 'localhost:3002' });
    const message = SiweAuth.buildMessage({
      domain: 'localhost:3002', address: account.address,
      uri: 'http://localhost:3002', nonce, issuedAt, ...overrides,
    });
    const signature = await account.signMessage({ message });
    return { message, signature, nonce };
  }

  it('verifies a signed message and binds the session to the recovered address', async () => {
    const { message, signature } = await signIn();
    const verified = await SiweAuth.verify({ message, signature });
    expect(verified.address).toBe(viem.getAddress(account.address));
    expect(verified.domain).toBe('localhost:3002');
  });

  it('consumes the nonce so a captured signature cannot be replayed', async () => {
    const { message, signature } = await signIn();
    await SiweAuth.verify({ message, signature });
    await expect(SiweAuth.verify({ message, signature })).rejects.toThrow(/nonce unknown or expired/);
  });

  it('rejects a signature from a different key', async () => {
    const { nonce, issuedAt } = SiweAuth.createNonce({ domain: 'localhost:3002' });
    const other = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');
    const message = SiweAuth.buildMessage({
      domain: 'localhost:3002', address: account.address, uri: 'http://localhost:3002', nonce, issuedAt,
    });
    const signature = await other.signMessage({ message });
    await expect(SiweAuth.verify({ message, signature })).rejects.toThrow(/signature invalid/);
  });

  it('issues a wallet session token carrying the address and roles', () => {
    const { token, payload } = SiweAuth.issueToken({ address: account.address, roles: ['beneficiary'] });
    expect(token.split('.')).toHaveLength(3);
    expect(payload.walletAddress).toBe(account.address);
    expect(payload.authMethod).toBe('siwe');
  });
});

describe('chain transfer reconciliation into the canonical outbox', () => {
  const address = '0x3e53028cf69949f3B961ce786Baf2D4D75166562';
  const transfers = [
    { hash: '0xaaa', direction: 'in', asset: 'USDC', value: 25, from: '0xdead', to: address, timestamp: '2026-01-01T00:00:00Z', category: 'erc20' },
    { hash: '0xbbb', direction: 'out', asset: 'ETH', value: 0.1, from: address, to: '0xbeef', timestamp: '2026-01-02T00:00:00Z', category: 'external' },
    { hash: '', direction: 'in', asset: 'USDC', value: 1 },
  ];

  beforeEach(() => {
    ChainTransferReconciler._resetMemory();
    vi.spyOn(pool, 'query').mockResolvedValue({ rows: [], rowCount: 0 } as any);
  });

  it('publishes one canonical event per confirmed transfer and skips unconfirmed ones', async () => {
    const publish = vi.spyOn(KafkaEventBus, 'publish').mockImplementation(async () => ({ eventId: `EVT-${Math.random()}`, published: false } as any));
    const summary = await ChainTransferReconciler.reconcileAddress(address, { transfers });

    expect(summary.scanned).toBe(3);
    expect(summary.reconciled).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(publish).toHaveBeenCalledTimes(2);
    const [topic, payload] = publish.mock.calls[0];
    expect(topic).toBe('trust.chain.transfer.reconciled');
    expect(payload).toMatchObject({ txHash: '0xaaa', direction: 'in', asset: 'USDC', mode: 'reconciliation' });
  });

  it('does not re-publish a transfer that was already reconciled', async () => {
    const publish = vi.spyOn(KafkaEventBus, 'publish').mockResolvedValue({ eventId: 'EVT-1', published: false } as any);
    await ChainTransferReconciler.reconcileAddress(address, { transfers });
    const second = await ChainTransferReconciler.reconcileAddress(address, { transfers });

    expect(second.reconciled).toBe(0);
    expect(second.duplicates).toBe(2);
    expect(publish).toHaveBeenCalledTimes(2);
  });
});

describe('document storage anchoring', () => {
  it('hashes content and returns a shadow URI by default', async () => {
    const anchor = await DocumentStorageAdapter.anchor({ documentId: 'DOC-1', content: 'bond receipt' });
    expect(anchor.contentHash).toBe(
      'sha256:' + require('crypto').createHash('sha256').update('bond receipt').digest('hex')
    );
    expect(anchor.mode).toBe('shadow');
    expect(anchor.storageUri).toBe('shadow://none/DOC-1');
    expect(DocumentStorageAdapter.status().live).toBe(false);
  });

  it('stays in shadow mode when a backend is configured but the live flag is not set', async () => {
    process.env.DOCUMENT_STORAGE_BACKEND = 's3';
    process.env.DOCUMENT_STORAGE_S3_BUCKET = 'anchor-bucket';
    const anchor = await DocumentStorageAdapter.anchor({ documentId: 'DOC-2', content: 'x' });
    expect(anchor.mode).toBe('shadow');
    expect(anchor.storageUri).toBe('shadow://s3/DOC-2');
  });

  it('keeps the hash and falls back to shadow when a live pin fails', async () => {
    process.env.DOCUMENT_STORAGE_BACKEND = 'ipfs';
    process.env.DOCUMENT_STORAGE_LIVE = 'true';
    process.env.DOCUMENT_STORAGE_IPFS_API_URL = '';
    process.env.DOCUMENT_STORAGE_ENCRYPTION_KEY = 'a'.repeat(64);
    const anchor = await DocumentStorageAdapter.anchor({ documentId: 'DOC-3', content: 'y' });
    expect(anchor.contentHash).toMatch(/^sha256:/);
    expect(anchor.mode).toBe('shadow');
    expect(anchor.error).toContain('IPFS_API_URL');
    delete process.env.DOCUMENT_STORAGE_ENCRYPTION_KEY;
  });

  it('refuses a live pin when no encryption key is configured', async () => {
    process.env.DOCUMENT_STORAGE_BACKEND = 'thirdweb';
    process.env.DOCUMENT_STORAGE_LIVE = 'true';
    const anchor = await DocumentStorageAdapter.anchor({ documentId: 'DOC-4', content: 'z' });
    expect(anchor.mode).toBe('shadow');
    expect(anchor.error).toContain('DOCUMENT_STORAGE_ENCRYPTION_KEY not configured');
  });
});

describe('ramp fee capture', () => {
  beforeEach(() => {
    process.env.RAMP_FEE_BPS = '50';
  });

  it('quotes the configured bps spread and nets it out of the gross amount', () => {
    const fee = RampFeeEngine.quote({ amount: '1000', direction: 'onramp', asset: 'USD' });
    expect(fee).toMatchObject({ feeBps: 50, grossAmount: 1000, feeAmount: 5, netAmount: 995 });
  });

  it('quotes no fee when RAMP_FEE_BPS is unset', () => {
    delete process.env.RAMP_FEE_BPS;
    expect(RampFeeEngine.quote({ amount: '1000' }).feeAmount).toBe(0);
  });

  it('books a balanced journal to the revenue account on execution', async () => {
    vi.spyOn(pool, 'query').mockResolvedValue({ rows: [], rowCount: 0 } as any);
    const post = vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entry_id: 'JRN-1' } as any);

    const result = await RampFeeEngine.book({ referenceId: 'PROP-1', amount: '1000', direction: 'onramp' });

    expect(result).toMatchObject({ status: 'booked', booked: true, entryId: 'JRN-1', feeAmount: 5 });
    const lines = post.mock.calls[0][0].lines;
    expect(lines.reduce((s: number, l: any) => s + Number(l.debitAmount || 0), 0))
      .toBe(lines.reduce((s: number, l: any) => s + Number(l.creditAmount || 0), 0));
    expect(lines.find((l: any) => Number(l.creditAmount) > 0).accountCode).toBe('4100');
    expect(post.mock.calls[0][0].postToFineract).toBe(false);
  });

  it('is idempotent: a re-executed reference does not double-charge', async () => {
    vi.spyOn(pool, 'query').mockResolvedValue({ rows: [{ entry_id: 'JRN-EXISTING' }], rowCount: 1 } as any);
    const post = vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entry_id: 'JRN-2' } as any);

    const result = await RampFeeEngine.book({ referenceId: 'PROP-1', amount: '1000' });

    expect(result.status).toBe('already_booked');
    expect(result.entryId).toBe('JRN-EXISTING');
    expect(post).not.toHaveBeenCalled();
  });

  it('does not book anything when booking is disabled', async () => {
    process.env.RAMP_FEE_BOOKING_ENABLED = 'false';
    const post = vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entry_id: 'JRN-3' } as any);
    const result = await RampFeeEngine.book({ referenceId: 'PROP-2', amount: '1000' });
    expect(result.status).toBe('booking_disabled');
    expect(post).not.toHaveBeenCalled();
  });
});
