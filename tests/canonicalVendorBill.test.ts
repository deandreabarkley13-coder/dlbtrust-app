import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'fs';

const require = createRequire(import.meta.url);
const { CanonicalConsensusEngine } = require('../server/integrations/dapp/canonicalConsensusEngine');
const { MelioEngine } = require('../server/integrations/os/osEngine');
const { PaymentComplianceGate } = require('../server/integrations/compliance/paymentComplianceGate');
const { getTrusteeByRole } = require('../server/integrations/dapp/trustees');
const { EmailEngine } = require('../server/integrations/dapp/emailEngine');

const maker = getTrusteeByRole('maker');
const checker = getTrusteeByRole('checker');

const validBill = {
  vendor: { name: 'Canonical Vendor' },
  amount: 125.5,
  due_date: '2026-02-15',
  invoice_number: 'INV-CANONICAL-1',
  invoice_date: '2026-01-15',
  memo: 'Approved operating expense',
  source_type: 'trust',
  source_account_id: '1000',
  accountingClass: 'operating_expense',
  expenseGlAccount: '5300',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('canonical vendor bill consensus', () => {
  it('requires authenticated dual approval and explicit classification in the canonical workflow', () => {
    const workflow = readFileSync(
      'server/scripts/melioCanonicalPaymentWorkflow.js',
      'utf8',
    );
    const compatibilityWorkflow = readFileSync(
      'server/scripts/sendB2BPaymentViaMelio.js',
      'utf8',
    );

    expect(workflow).toContain('TRUST_MAKER_TOKEN');
    expect(workflow).toContain('TRUST_CHECKER_TOKEN');
    expect(workflow).toContain("'invoiceNumber'");
    expect(workflow).toContain("'accountingClass'");
    expect(workflow).toContain('accountingClass: args.accountingClass');
    expect(workflow).toContain('executionMode,');
    expect(workflow).toContain('}, MAKER_TOKEN)');
    expect(workflow).toContain('}, CHECKER_TOKEN)');
    expect(compatibilityWorkflow).toContain('melioCanonicalPaymentWorkflow.js');
    expect(compatibilityWorkflow).toContain("'live_api'");
    expect(compatibilityWorkflow).not.toContain('/api/os/melio/process');
  });

  it.each([
    {
      label: 'missing vendor',
      payload: { vendor_name: '', amount: 125, due_date: '2026-02-15' },
      message: 'vendor_bill requires vendor.name or vendorId',
    },
    {
      label: 'missing export vendor identity',
      payload: { businessName: 'Canonical Vendor', amount: 125, due_date: '2026-02-15' },
      message: 'vendor_bill requires vendor.name or vendorId',
    },
    {
      label: 'invalid amount',
      payload: {
        vendor: { name: 'Canonical Vendor' },
        amount: 0,
        due_date: '2026-02-15',
        invoiceNumber: 'INV-INVALID-AMOUNT',
        accountingClass: 'operating_expense',
      },
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

  it('accepts a proper single-bill vendor identity during creation validation', () => {
    expect(CanonicalConsensusEngine._validateVendorBillPayload(validBill))
      .toEqual({ batch: false, count: 1 });
  });

  it('requires stable invoice and accounting classifications', () => {
    expect(() => CanonicalConsensusEngine._validateVendorBillPayload({
      ...validBill,
      invoice_number: '',
    })).toThrow('vendor_bill requires an explicit invoiceNumber');
    expect(() => CanonicalConsensusEngine._validateVendorBillPayload({
      ...validBill,
      accountingClass: '',
    })).toThrow('vendor_bill requires an explicit accountingClass');
  });

  it('encrypts vendor bank details before canonical proposal persistence', () => {
    const previousKey = process.env.PAYMENT_DATA_ENCRYPTION_KEY;
    process.env.PAYMENT_DATA_ENCRYPTION_KEY = '11'.repeat(32);
    try {
      const protectedPayload = CanonicalConsensusEngine._protectVendorBankDetails({
        ...validBill,
        vendor: {
          name: 'Canonical Vendor',
          bankAccount: {
            accountNumber: '1234567890',
            routingNumber: '111000025',
            accountType: 'checking',
          },
        },
      });

      expect(protectedPayload.vendor.bankAccount).toMatchObject({
        accountNumberLast4: '7890',
        routingNumberLast4: '0025',
        accountType: 'checking',
      });
      expect(protectedPayload.vendor.bankAccount.accountNumber).toBeUndefined();
      expect(protectedPayload.vendor.bankAccount.routingNumber).toBeUndefined();
      expect(protectedPayload.vendor.bankAccount.accountNumberEncrypted).toMatch(/^enc:v1:/);
      expect(protectedPayload.vendor.bankAccount.routingNumberEncrypted).toMatch(/^enc:v1:/);

      const restoredPayload = CanonicalConsensusEngine._restoreVendorBankDetails(protectedPayload);
      expect(restoredPayload.vendor.bankAccount).toMatchObject({
        accountNumber: '1234567890',
        routingNumber: '111000025',
        accountNumberLast4: '7890',
        routingNumberLast4: '0025',
      });
      expect(restoredPayload.vendor.bankAccount.accountNumberEncrypted).toBeUndefined();
      expect(restoredPayload.vendor.bankAccount.routingNumberEncrypted).toBeUndefined();
    } finally {
      if (previousKey === undefined) delete process.env.PAYMENT_DATA_ENCRYPTION_KEY;
      else process.env.PAYMENT_DATA_ENCRYPTION_KEY = previousKey;
    }
  });

  it('rejects a batch item missing the Melio export vendor identity', () => {
    expect(() => CanonicalConsensusEngine._validateVendorBillPayload({
      payables: [
        {
          vendor: { name: 'Vendor One' },
          amount: 10,
          due_date: '2026-02-01',
          invoiceNumber: 'INV-ONE',
          accountingClass: 'operating_expense',
        },
        { businessName: 'Vendor Two', amount: 20, due_date: '2026-02-02' },
      ],
    })).toThrow('vendor_bill payable 2 invalid: vendor_bill payable 2 requires vendor.name or vendorId');
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
      signature: 'Malissa Ann Robinson',
    });
    expect(execute).not.toHaveBeenCalled();

    await CanonicalConsensusEngine.approveProposal({
      proposalId: 'PROPOSAL-TWO-ROLES',
      role: 'checker',
      approverEmail: checker.email,
      signature: 'DeAndrea Lavar Barkley',
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
    vi.spyOn(PaymentComplianceGate, 'screenVendorPayment').mockResolvedValue({
      screeningId: 'COMP-CANONICAL-1',
      status: 'clear',
    });
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

    expect(process).toHaveBeenCalledWith({
      action: 'exportPayment',
      ...validBill,
      metadata: { complianceScreeningId: 'COMP-CANONICAL-1' },
    });
    expect(result).toMatchObject({
      exportIdentifier: 'MEL-CANONICAL-1',
      paymentMode: 'manual_upload',
      complianceScreeningId: 'COMP-CANONICAL-1',
      paymentId: 'MEL-CANONICAL-1',
      fileName: 'melio-export-MEL-CANONICAL-1.csv',
      journalEntryId: 'JE-CANONICAL-1',
    });
    expect(result.result.result.glPosted).toBe(true);
  });

  it('submits an approved single bill through the fail-closed live Melio API path', async () => {
    vi.spyOn(PaymentComplianceGate, 'screenVendorPayment').mockResolvedValue({
      screeningId: 'COMP-CANONICAL-LIVE',
      status: 'clear',
    });
    const ready = vi.spyOn(MelioEngine, 'assertLiveApiReady').mockReturnValue({
      id: 'melio-funding-1',
      field: 'payment_method_id',
    });
    const process = vi.spyOn(MelioEngine, 'process').mockResolvedValue({
      success: true,
      result: {
        id: 'MEL-CANONICAL-LIVE',
        melioPaymentId: 'melio-remote-1',
        status: 'scheduled',
        journalEntryId: 'JE-CANONICAL-LIVE',
        result: { accountingClass: 'management_fee' },
      },
    });
    const payload = {
      ...validBill,
      executionMode: 'live_api',
      accountingClass: 'management_fee',
    };

    const result = await CanonicalConsensusEngine._executeVendorBill(
      payload,
      'CC-1700000000000-ABC123',
    );

    expect(ready).toHaveBeenCalledWith('trust', '1000');
    expect(process).toHaveBeenCalledWith({
      action: 'schedulePayment',
      ...payload,
      paymentId: 'MEL-CC-1700000000000-ABC123',
      metadata: {
        complianceScreeningId: 'COMP-CANONICAL-LIVE',
        consensusProposalId: 'CC-1700000000000-ABC123',
      },
    });
    expect(result).toMatchObject({
      paymentMode: 'live_api',
      paymentId: 'MEL-CANONICAL-LIVE',
      melioPaymentId: 'melio-remote-1',
      complianceScreeningId: 'COMP-CANONICAL-LIVE',
      journalEntryId: 'JE-CANONICAL-LIVE',
    });
  });

  it('rejects unsupported or batch live execution modes before approval', () => {
    expect(() => CanonicalConsensusEngine._validateVendorBillPayload({
      ...validBill,
      executionMode: 'unknown',
    })).toThrow('vendor_bill executionMode must be manual_upload or live_api');
    expect(() => CanonicalConsensusEngine._validateVendorBillPayload({
      executionMode: 'live_api',
      payables: [validBill],
    })).toThrow('live_api vendor_bill execution supports one approved payment at a time');
  });

  it('delegates multi-bill payloads to the Melio batch exporter', async () => {
    vi.spyOn(PaymentComplianceGate, 'screenVendorPayment')
      .mockResolvedValueOnce({ screeningId: 'COMP-BATCH-1', status: 'clear' })
      .mockResolvedValueOnce({ screeningId: 'COMP-BATCH-2', status: 'clear' });
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
        {
          vendor: { name: 'Vendor One' },
          amount: 10,
          due_date: '2026-02-01',
          invoiceNumber: 'INV-ONE',
          accountingClass: 'operating_expense',
        },
        {
          vendor: { name: 'Vendor Two' },
          amount: 20,
          due_date: '2026-02-02',
          invoiceNumber: 'INV-TWO',
          accountingClass: 'operating_expense',
        },
      ],
    };

    expect(CanonicalConsensusEngine._validateVendorBillPayload(payload))
      .toEqual({ batch: true, count: 2 });
    const result = await CanonicalConsensusEngine._executeVendorBill(payload);

    expect(process).toHaveBeenCalledWith({
      action: 'exportBatch',
      ...payload,
      payables: [
        { ...payload.payables[0], metadata: { complianceScreeningId: 'COMP-BATCH-1' } },
        { ...payload.payables[1], metadata: { complianceScreeningId: 'COMP-BATCH-2' } },
      ],
    });
    expect(result).toMatchObject({
      exportIdentifier: 'MEL-BATCH-CANONICAL',
      paymentMode: 'manual_upload',
      complianceScreeningIds: ['COMP-BATCH-1', 'COMP-BATCH-2'],
      fileNames: ['melio-export-MEL-BATCH-CANONICAL.csv'],
      paymentIds: ['MEL-ROW-1', 'MEL-ROW-2'],
      journalEntryIds: ['JE-ROW-1', 'JE-ROW-2'],
    });
  });

  it('emails both signers a vendor bill signature request', async () => {
    const send = vi.spyOn(EmailEngine, 'send').mockResolvedValue({ sent: true, provider: 'smtp' });

    const result = await CanonicalConsensusEngine.notifyApprovers({
      id: 'CC-NOTIFY-1',
      title: 'Melio vendor bill batch',
      description: 'Operating expenses',
      created_by: 'operator@example.com',
      payload: { payables: [{ ...validBill, amount: 40 }, { ...validBill, amount: 60 }] },
    });

    expect(result.notifications.map((n: { role: string; email: string; sent: boolean }) => [n.role, n.email, n.sent]))
      .toEqual([['maker', maker.email, true], ['checker', checker.email, true]]);
    const makerCall = send.mock.calls[0][0];
    expect(makerCall.subject).toContain('CC-NOTIFY-1');
    expect(makerCall.body).toContain('Batch total: $100.00');
    expect(makerCall.body).toContain('Malissa Ann Robinson');
    expect(send.mock.calls[1][0].body).toContain('DeAndrea Lavar Barkley');
  });

  it('does not ask the requester to sign their own vendor bill', async () => {
    const send = vi.spyOn(EmailEngine, 'send').mockResolvedValue({ sent: true, provider: 'smtp' });

    const result = await CanonicalConsensusEngine.notifyApprovers({
      id: 'CC-NOTIFY-2',
      title: 'Melio vendor bill batch',
      created_by: maker.email,
      payload: validBill,
    });

    expect(result.notifications[0]).toMatchObject({ role: 'maker', sent: false });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe(checker.email);
  });

  it('reports unsent signature requests instead of throwing', async () => {
    vi.spyOn(EmailEngine, 'send').mockRejectedValue(new Error('smtp down'));

    const result = await CanonicalConsensusEngine.notifyApprovers({
      id: 'CC-NOTIFY-3',
      title: 'Melio vendor bill batch',
      created_by: 'operator@example.com',
      payload: validBill,
    });

    expect(result.notifications.every((n: { sent: boolean; note?: string }) => n.sent === false && n.note === 'smtp down')).toBe(true);
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
