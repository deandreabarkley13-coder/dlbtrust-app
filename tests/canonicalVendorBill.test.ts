import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { CanonicalConsensusEngine } = require('../server/integrations/dapp/canonicalConsensusEngine');
const { MelioEngine } = require('../server/integrations/os/osEngine');
const { getTrusteeByRole } = require('../server/integrations/dapp/trustees');

const maker = getTrusteeByRole('maker');
const checker = getTrusteeByRole('checker');

const validBill = {
  vendor_name: 'Canonical Vendor',
  amount: 125.5,
  due_date: '2026-02-15',
  invoice_number: 'INV-CANONICAL-1',
  invoice_date: '2026-01-15',
  memo: 'Approved operating expense',
  source_type: 'trust',
  source_account_id: '1000',
  expenseGlAccount: '5300',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('canonical vendor bill consensus', () => {
  it.each([
    {
      label: 'missing vendor',
      payload: { vendor_name: '', amount: 125, due_date: '2026-02-15' },
      message: 'Business name is required',
    },
    {
      label: 'invalid amount',
      payload: { vendor_name: 'Canonical Vendor', amount: 0, due_date: '2026-02-15' },
      message: 'amount must be positive',
    },
  ])('validates $label vendor bills when proposals are created', async ({ payload, message }) => {
    vi.spyOn(CanonicalConsensusEngine, 'ensureTables').mockResolvedValue(undefined);

    await expect(CanonicalConsensusEngine.createProposal({
      title: 'Invalid vendor bill',
      category: 'vendor_bill',
      payload,
      createdBy: 'maker@example.com',
    })).rejects.toThrow(message);
  });

  it('clamps vendor bill approval thresholds to two', () => {
    expect(CanonicalConsensusEngine._requiredApprovals('vendor_bill', 1)).toBe(2);
    expect(CanonicalConsensusEngine._requiredApprovals('vendor_bill')).toBe(2);
    expect(CanonicalConsensusEngine._requiredApprovals('custom', 1)).toBe(1);
  });

  it('rejects the requester as a vendor bill approver', async () => {
    const proposal = {
      category: 'vendor_bill',
      status: 'pending',
      created_by: maker.email,
      required_approvals: 2,
      approvals: [],
    };
    vi.spyOn(CanonicalConsensusEngine, 'ensureTables').mockResolvedValue(undefined);
    vi.spyOn(CanonicalConsensusEngine, 'getProposal').mockResolvedValue(proposal);

    await expect(CanonicalConsensusEngine.approveProposal({
      proposalId: 'PROPOSAL-REQUESTER',
      role: 'maker',
      approverEmail: maker.email,
    })).rejects.toThrow('The requester cannot approve a vendor_bill proposal');
  });

  it('does not auto-execute until maker and checker have both approved', async () => {
    const proposal = {
      category: 'vendor_bill',
      status: 'pending',
      created_by: 'operator@example.com',
      required_approvals: 2,
      approvals: [],
    };
    const makerApproved = {
      ...proposal,
      approvals: [{ role: 'maker', status: 'approved', email: maker.email }],
    };
    const fullyApproved = {
      ...makerApproved,
      status: 'approved',
      approvals: [
        ...makerApproved.approvals,
        { role: 'checker', status: 'approved', email: checker.email },
      ],
    };
    vi.spyOn(CanonicalConsensusEngine, 'ensureTables').mockResolvedValue(undefined);
    vi.spyOn(CanonicalConsensusEngine, 'getProposal')
      .mockResolvedValueOnce(proposal)
      .mockResolvedValueOnce(makerApproved)
      .mockResolvedValueOnce(makerApproved)
      .mockResolvedValueOnce(fullyApproved);
    vi.spyOn(CanonicalConsensusEngine, '_saveApprovals').mockResolvedValue(undefined);
    const execute = vi.spyOn(CanonicalConsensusEngine, 'executeProposal')
      .mockResolvedValue({ executed: true });

    await CanonicalConsensusEngine.approveProposal({
      proposalId: 'PROPOSAL-TWO-ROLES',
      role: 'maker',
      approverEmail: maker.email,
    });
    expect(execute).not.toHaveBeenCalled();

    await CanonicalConsensusEngine.approveProposal({
      proposalId: 'PROPOSAL-TWO-ROLES',
      role: 'checker',
      approverEmail: checker.email,
    });
    expect(execute).toHaveBeenCalledWith('PROPOSAL-TWO-ROLES');
  });

  it.each([
    { label: 'zero approvals', approvals: [] },
    { label: 'one approval', approvals: [{ role: 'maker', status: 'approved', email: maker.email }] },
  ])('cannot execute with $label', async ({ approvals }) => {
    const proposal = {
      category: 'vendor_bill',
      status: 'pending',
      created_by: 'operator@example.com',
      required_approvals: 2,
      approvals,
      payload: validBill,
    };
    vi.spyOn(CanonicalConsensusEngine, 'ensureTables').mockResolvedValue(undefined);
    vi.spyOn(CanonicalConsensusEngine, 'getProposal').mockResolvedValue(proposal);
    const execute = vi.spyOn(CanonicalConsensusEngine, '_execute');

    await expect(CanonicalConsensusEngine.executeProposal('PROPOSAL-APPROVALS'))
      .rejects.toThrow('vendor_bill requires maker and checker approvals before execution');
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes after distinct maker and checker approvals and returns Melio identifiers', async () => {
    const melioResult = {
      id: 'MEL-CANONICAL-1',
      status: 'exported',
      journalEntryId: 'JE-CANONICAL-1',
      result: { fileName: 'melio-export-MEL-CANONICAL-1.csv', glPosted: true },
    };
    const process = vi.spyOn(MelioEngine, 'process').mockResolvedValue({
      success: true,
      result: melioResult,
    });

    const result = await CanonicalConsensusEngine._executeVendorBill(validBill);

    expect(process).toHaveBeenCalledWith({ action: 'exportPayment', ...validBill });
    expect(result).toMatchObject({
      exportIdentifier: 'MEL-CANONICAL-1',
      paymentId: 'MEL-CANONICAL-1',
      fileName: 'melio-export-MEL-CANONICAL-1.csv',
      journalEntryId: 'JE-CANONICAL-1',
    });
    expect(result.result.result.glPosted).toBe(true);
  });

  it('delegates multi-bill payloads to the Melio batch exporter', async () => {
    const batch = {
      batchId: 'MEL-BATCH-CANONICAL',
      files: [{ fileName: 'melio-export-MEL-BATCH-CANONICAL.csv' }],
      records: [
        { id: 'MEL-ROW-1', journalEntryId: 'JE-ROW-1' },
        { id: 'MEL-ROW-2', journalEntryId: 'JE-ROW-2' },
      ],
    };
    const process = vi.spyOn(MelioEngine, 'process').mockResolvedValue({
      success: true,
      result: batch,
    });
    const payload = {
      source_type: 'trust',
      source_account_id: '1000',
      payables: [
        { vendor_name: 'Vendor One', amount: 10, due_date: '2026-02-01' },
        { vendor_name: 'Vendor Two', amount: 20, due_date: '2026-02-02' },
      ],
    };

    expect(CanonicalConsensusEngine._validateVendorBillPayload(payload))
      .toEqual({ batch: true, count: 2 });
    const result = await CanonicalConsensusEngine._executeVendorBill(payload);

    expect(process).toHaveBeenCalledWith({
      action: 'exportBatch',
      ...payload,
      payables: payload.payables,
    });
    expect(result).toMatchObject({
      exportIdentifier: 'MEL-BATCH-CANONICAL',
      fileNames: ['melio-export-MEL-BATCH-CANONICAL.csv'],
      paymentIds: ['MEL-ROW-1', 'MEL-ROW-2'],
      journalEntryIds: ['JE-ROW-1', 'JE-ROW-2'],
    });
  });

  it('counts only maker and checker as the two required vendor bill approvals', () => {
    const proposal = {
      category: 'vendor_bill',
      required_approvals: 2,
      approvals: [
        { role: 'maker', status: 'approved' },
        { role: 'checker', status: 'approved' },
      ],
    };
    expect(CanonicalConsensusEngine.isApproved(proposal)).toBe(true);
    expect(CanonicalConsensusEngine.isApproved({
      ...proposal,
      approvals: [{ role: 'maker', status: 'approved' }],
    })).toBe(false);
  });
});
