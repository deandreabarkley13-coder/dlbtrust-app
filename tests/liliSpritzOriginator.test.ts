import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { LiliSpritzOriginator } = require('../server/integrations/payments/liliSpritzOriginator');
const { LiliSettlementBankEngine } = require('../server/integrations/payments/liliSettlementBankEngine');
const { LiliDirectDepositEngine } = require('../server/integrations/payments/liliDirectDepositEngine');
const { LiliMcpEngine } = require('../server/integrations/payments/liliMcpEngine');
const { SpritzEngine } = require('../server/integrations/spritz/spritzEngine');
const { SpritzTreasuryLegEngine } = require('../server/integrations/spritz/spritzTreasuryLegEngine');

const saved = { ...process.env };
const DEST = { configured: true, routingNumber: '121145307', accountNumberMasked: '****2959', accountName: 'DB NET MGMT LLC', _account: '692101092959' };
const LILI_BANK = { id: 'bank-lili', status: 'active', accountNumberLast4: '2959', routingNumberLast4: '5307', institution: { name: 'Lili' }, supportedRails: ['ach_standard', 'ach_same_day', 'rtp'] };
const OTHER_BANK = { id: 'bank-other', status: 'active', accountNumberLast4: '1234', routingNumberLast4: '5307', institution: { name: 'Other' }, supportedRails: ['ach_standard'] };
const CAPS = [{ product: 'crypto_to_fiat', method: 'ach_credit', status: 'active' }];

function mockSpritz({ banks = [LILI_BANK, OTHER_BANK], caps = CAPS, ready = true } = {}) {
  vi.spyOn(LiliDirectDepositEngine, 'getDestination').mockResolvedValue(DEST);
  vi.spyOn(SpritzEngine, 'listBankAccounts').mockResolvedValue(banks);
  vi.spyOn(SpritzEngine, 'capabilities').mockResolvedValue(caps);
  vi.spyOn(SpritzTreasuryLegEngine, 'readiness').mockResolvedValue({ ready, issues: ready ? [] : ['TRUST_POLICY_ADDRESS not configured'], policyContract: '0xpolicy', payoutWallet: '0xpayout', network: 'base' });
}

describe('LiliSpritzOriginator', () => {
  beforeEach(() => {
    process.env.LILI_CLEARING_LIVE = 'true';
    process.env.LILI_ORIGINATOR = 'spritz';
    process.env.LILI_SPRITZ_RAIL = 'ach_standard';
    process.env.LILI_DD_ROUTING_NUMBER = '121145307';
    process.env.LILI_DD_ACCOUNT_NUMBER = '692101092959';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  it('resolves only the Spritz bank account that is the registered Lili destination', async () => {
    mockSpritz();
    const st = await LiliSpritzOriginator.status();
    expect(st.ready).toBe(true);
    expect(st.bankAccountId).toBe('bank-lili');
    expect(st.bankAccount.accountNumberLast4).toBe('2959');
    expect(st.offramp.status).toBe('active');
  });

  it('fails closed when the Lili account is not linked on Spritz', async () => {
    mockSpritz({ banks: [OTHER_BANK] });
    const st = await LiliSpritzOriginator.status();
    expect(st.ready).toBe(false);
    expect(st.bankAccountId).toBeNull();
    expect(st.blocker).toMatch(/not linked as a Spritz bank account/);
    const settle = vi.spyOn(SpritzTreasuryLegEngine, 'settle');
    await expect(LiliSpritzOriginator.send({ amount: 1, reference: 'REF-1' })).rejects.toMatchObject({ status: 503, code: 'LILI_SPRITZ_NOT_READY' });
    expect(settle).not.toHaveBeenCalled();
  });

  it('fails closed when the off-ramp capability or the Spritz leg is not ready', async () => {
    mockSpritz({ caps: [{ product: 'crypto_to_fiat', method: 'ach_credit', status: 'requirements_needed' }], ready: false });
    const st = await LiliSpritzOriginator.status();
    expect(st.ready).toBe(false);
    expect(st.issues).toEqual(expect.arrayContaining([expect.stringMatching(/off-ramp is requirements_needed/), expect.stringMatching(/spritz leg: TRUST_POLICY_ADDRESS/)]));
  });

  it('send() runs the governed Spritz settlement against the Lili bank account and maps statuses', async () => {
    mockSpritz();
    const settle = vi.spyOn(SpritzTreasuryLegEngine, 'settle')
      .mockResolvedValueOnce({ reference: 'REF-2', stage: 'approval', status: 'blocked', detail: 'checker must approve', trail: [], payout: { spritzQuoteId: 'q1', distributionId: 7 } })
      .mockResolvedValueOnce({ reference: 'REF-2', stage: 'execute', status: 'submitted', detail: 'off-ramp submitted', trail: [], payout: { spritzQuoteId: 'q1' }, distribution: { distributionId: 7 }, execution: { offRampId: 'or-1' } })
      .mockResolvedValueOnce({ reference: 'REF-2', stage: 'funding', status: 'failed', detail: 'ERP credit push failed', trail: [] });

    const first = await LiliSpritzOriginator.send({ amount: 25, reference: 'REF-2', description: 'settlement' });
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: 25, reference: 'REF-2', rail: 'ach_standard', bankAccountId: 'bank-lili', purpose: 'operating', transmit: true }));
    expect(first).toMatchObject({ status: 'pending_approval', stage: 'approval', distributionId: 7, spritzQuoteId: 'q1' });

    const second = await LiliSpritzOriginator.send({ amount: 25, reference: 'REF-2' });
    expect(second).toMatchObject({ status: 'originated', stage: 'execute', offRampId: 'or-1' });

    await expect(LiliSpritzOriginator.send({ amount: 25, reference: 'REF-2' })).rejects.toMatchObject({ status: 502, code: 'LILI_SPRITZ_FAILED' });
  });

  it('LiliSettlementBankEngine uses Spritz as the originator when LILI_ORIGINATOR=spritz', async () => {
    mockSpritz();
    vi.spyOn(LiliMcpEngine, 'getPublicConfig').mockResolvedValue({ configured: false });
    const odfi = vi.spyOn(LiliDirectDepositEngine, 'odfiStatus');
    const dd = vi.spyOn(LiliDirectDepositEngine, 'createDirectDeposit');
    vi.spyOn(SpritzTreasuryLegEngine, 'settle').mockResolvedValue({ reference: 'REF-3', stage: 'execute', status: 'completed', detail: 'done', trail: [] });

    const status = await LiliSettlementBankEngine.status();
    expect(status.originator).toBe('spritz');
    expect(status.originationReady).toBe(true);
    expect(status.odfi.channels).toEqual(['spritz:bank-lili']);
    expect(odfi).not.toHaveBeenCalled();

    const sent = await LiliSettlementBankEngine._sendPayment({ amount: 10, reference: 'REF-3', description: 'x' });
    expect(sent).toMatchObject({ status: 'originated', originator: 'spritz', destination: { routingNumber: '121145307', accountLast4: '2959' } });
    expect(dd).not.toHaveBeenCalled();

    await expect(LiliSettlementBankEngine._sendPayment({ amount: 10, reference: 'REF-4', destination: { routingNumber: '011000015', accountNumber: '1' } })).rejects.toMatchObject({ status: 400 });
  });

  it('defaults to the NACHA originator', async () => {
    delete process.env.LILI_ORIGINATOR;
    vi.spyOn(LiliDirectDepositEngine, 'getDestination').mockResolvedValue(DEST);
    vi.spyOn(LiliDirectDepositEngine, 'odfiStatus').mockResolvedValue({ ready: false, channels: [], loopback: [], blocker: 'No ODFI channel configured (OpenACH/AS2/MFT/REST/SFTP)' });
    vi.spyOn(LiliMcpEngine, 'getPublicConfig').mockResolvedValue({ configured: false });
    const status = await LiliSettlementBankEngine.status();
    expect(status.originator).toBe('nacha');
    expect(status.odfi.originator).toBe('nacha');
    expect(status.originationReady).toBe(false);
  });
});
