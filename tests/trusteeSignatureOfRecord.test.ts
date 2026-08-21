import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { CanonicalConsensusEngine } = require('../server/integrations/dapp/canonicalConsensusEngine');
const {
  getSignatureOfRecord,
  getTrusteeSignatureOfRecord,
} = require('../server/integrations/dapp/trustees');

const maker = getTrusteeSignatureOfRecord('maker');
const checker = getTrusteeSignatureOfRecord('checker');

const proposal = {
  category: 'vendor_bill',
  status: 'pending',
  created_by: 'operator@example.com',
  required_approvals: 2,
  approvals: [],
};

afterEach(() => {
  vi.restoreAllMocks();
});

function mockPendingApproval() {
  const initialProposal = { ...proposal, approvals: [] };
  vi.spyOn(CanonicalConsensusEngine, 'ensureTables').mockResolvedValue(undefined);
  vi.spyOn(CanonicalConsensusEngine, 'getProposal')
    .mockResolvedValueOnce(initialProposal)
    .mockResolvedValueOnce({ ...initialProposal, approvals: [] });
  return vi.spyOn(CanonicalConsensusEngine, '_saveApprovals').mockResolvedValue(undefined);
}

function auditDocument(record: { document: Record<string, unknown> }) {
  const metadata = { ...record.document };
  delete metadata.path;
  return metadata;
}

describe('trustee signature of record', () => {
  it('exposes confirmed legal names and executed document metadata without contents', () => {
    expect(getSignatureOfRecord()).toEqual([maker, checker]);
    expect(maker).toMatchObject({
      role: 'maker',
      legalName: 'Malissa Ann Robinson',
      document: {
        title: 'Trustees Signature Page',
        fileName: 'Trustees_Signature_Page.pdf',
        sha256: '461ccddfb9f29fadae824d4905f74c18b24484f82877b8115cd871c1152ce4b4',
        pageCount: 1,
        executionStatus: 'executed',
      },
    });
    expect(checker.legalName).toBe('DeAndrea Lavar Barkley');
    expect(maker).not.toHaveProperty('contents');
    expect(maker).not.toHaveProperty('base64');
  });

  it.each([
    { label: 'without a signature', signature: undefined, message: 'requires your full legal name signature' },
    { label: 'with the wrong name', signature: 'Someone Else', message: 'does not match the signature of record' },
    { label: 'with a generated placeholder', signature: 'sig-maker-123', message: 'placeholder signatures are not accepted' },
  ])('rejects a vendor_bill approval $label', async ({ signature, message }) => {
    mockPendingApproval();

    await expect(CanonicalConsensusEngine.approveProposal({
      proposalId: 'PROPOSAL-SIGNATURE',
      role: 'maker',
      approverEmail: 'barkley420lavar@gmail.com',
      signature,
    })).rejects.toThrow(message);
  });

  it('accepts punctuation and case variation and persists signature metadata', async () => {
    const save = mockPendingApproval();

    await CanonicalConsensusEngine.approveProposal({
      proposalId: 'PROPOSAL-SIGNATURE',
      role: 'maker',
      approverEmail: 'barkley420lavar@gmail.com',
      signature: '  MALISSA,   ANN ROBINSON. ',
    });

    const approval = save.mock.calls[0][1][0];
    expect(approval).toMatchObject({
      role: 'maker',
      signature: '  MALISSA,   ANN ROBINSON. ',
      signatureOfRecord: {
        legalName: 'Malissa Ann Robinson',
        document: auditDocument(maker),
      },
    });
    expect(approval.signatureOfRecord.document).not.toHaveProperty('path');
    expect(approval.signatureOfRecord.signedAt).toBe(approval.approvedAt);
  });

  it('accepts the checker signature of record', async () => {
    const save = mockPendingApproval();

    await CanonicalConsensusEngine.approveProposal({
      proposalId: 'PROPOSAL-SIGNATURE',
      role: 'checker',
      approverEmail: 'dbarkley1130@gmail.com',
      signature: 'DeAndrea Lavar Barkley',
    });

    expect(save.mock.calls[0][1][0].signatureOfRecord).toMatchObject({
      legalName: 'DeAndrea Lavar Barkley',
      document: auditDocument(checker),
    });
    expect(save.mock.calls[0][1][0].signatureOfRecord.document).not.toHaveProperty('path');
  });

  it('preserves placeholder signatures for non-vendor_bill approvals', async () => {
    const nonVendorProposal = {
      ...proposal,
      category: 'custom',
      required_approvals: 1,
    };
    vi.spyOn(CanonicalConsensusEngine, 'ensureTables').mockResolvedValue(undefined);
    vi.spyOn(CanonicalConsensusEngine, 'getProposal')
      .mockResolvedValueOnce(nonVendorProposal)
      .mockResolvedValueOnce({ ...nonVendorProposal, status: 'pending' });
    const save = vi.spyOn(CanonicalConsensusEngine, '_saveApprovals').mockResolvedValue(undefined);

    await CanonicalConsensusEngine.approveProposal({
      proposalId: 'PROPOSAL-NON-VENDOR',
      role: 'maker',
      approverEmail: 'barkley420lavar@gmail.com',
    });

    expect(save.mock.calls[0][1][0].signature).toMatch(/^sig-maker-/);
    expect(save.mock.calls[0][1][0]).not.toHaveProperty('signatureOfRecord');
  });
});
