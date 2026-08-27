import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pool = require('../server/integrations/bonds/pgPool');
const { BankTransferEngine } = require('../server/integrations/dapp/bankTransferEngine');
const { VendorPaymentEngine } = require('../server/integrations/dapp/vendorPaymentEngine');
const { PaymentComplianceGate } = require('../server/integrations/compliance/paymentComplianceGate');
const { VendorEngine } = require('../server/integrations/vendors/vendorEngine');
const vendorsRouter = require('../server/routes/vendors');
const osRouter = require('../server/routes/os');

afterEach(() => {
  vi.restoreAllMocks();
});

function responseStub() {
  const response: any = {
    statusCode: 200,
    status: vi.fn(function status(code: number) {
      response.statusCode = code;
      return response;
    }),
    json: vi.fn(function json(body: any) {
      response.body = body;
      return response;
    }),
  };
  return response;
}

describe('vendor route authorization', () => {
  it('rejects unauthenticated requests before direct vendor routes', async () => {
    const globalAuth = vendorsRouter.stack[0].handle;
    const response = responseStub();
    const next = vi.fn();

    await globalAuth({ headers: {}, query: {} }, response, next);

    expect(response.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('binds approval identity to the authenticated maker instead of request fields', async () => {
    const route = vendorsRouter.stack.find(
      (layer: any) => layer.route?.path === '/payments/:paymentId/approve',
    );
    const handler = route.route.stack[route.route.stack.length - 1].handle;
    const approve = vi.spyOn(VendorEngine, 'approvePayment').mockResolvedValue({
      payment_id: 'VPAY-1',
      status: 'pending_approval',
    });
    const response = responseStub();

    await handler({
      params: { paymentId: 'VPAY-1' },
      user: {
        email: 'malissa1130@gmail.com',
        role: 'trustee_maker',
        roles: ['trustee_maker', 'beneficiary'],
      },
      body: {
        role: 'checker',
        approved_by: 'deandreabarkley13@gmail.com',
        approverEmail: 'deandreabarkley13@gmail.com',
        signature: 'Malissa Ann Robinson',
      },
    }, response);

    expect(approve).toHaveBeenCalledWith('VPAY-1', {
      role: 'maker',
      approverEmail: 'malissa1130@gmail.com',
      signature: 'Malissa Ann Robinson',
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects non-trustee approval identities', async () => {
    const route = vendorsRouter.stack.find(
      (layer: any) => layer.route?.path === '/payments/:paymentId/approve',
    );
    const handler = route.route.stack[route.route.stack.length - 1].handle;
    const approve = vi.spyOn(VendorEngine, 'approvePayment');
    const response = responseStub();

    await handler({
      params: { paymentId: 'VPAY-1' },
      user: { email: 'admin@example.com', role: 'admin', roles: ['admin'] },
      body: { signature: 'Malissa Ann Robinson' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(approve).not.toHaveBeenCalled();
  });

  it.each([
    ['melio', 'exportBatch'],
    ['melio', 'schedulePayment'],
    ['nickel', 'submitInvoice'],
    ['nickel', 'settlePayment'],
  ])('blocks direct %s %s actions outside the maker-checker workflow', async (engine, action) => {
    const route = osRouter.stack.find(
      (layer: any) => layer.route?.path === '/:engine/process',
    );
    const handler = route.route.stack[route.route.stack.length - 1].handle;
    const response = responseStub();

    await handler({
      params: { engine },
      body: { action },
      user: { email: 'operator@example.com', role: 'operator' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.body.error).toBe(
      'Vendor bill payments must use the authenticated maker-checker workflow',
    );
  });
});

describe('vendor payment segregation and side-effect ordering', () => {
  it('blocks execution until both maker and checker approvals exist', async () => {
    vi.spyOn(VendorEngine, 'ensureTables').mockResolvedValue(undefined);
    vi.spyOn(pool, 'query').mockResolvedValue({
      rowCount: 1,
      rows: [{
        payment_id: 'VPAY-ONE-APPROVAL',
        vendor_id: 'VENDOR-1',
        amount: '10.00',
        source_account_code: '1000',
        payment_method: 'ach',
        status: 'approved',
      }],
    });
    vi.spyOn(VendorEngine, 'hasRequiredApprovals').mockResolvedValue(false);
    const compliance = vi.spyOn(PaymentComplianceGate, 'screenVendorPayment');

    await expect(VendorEngine.executePayment('VPAY-ONE-APPROVAL', 'operator@example.com'))
      .rejects.toThrow('Vendor payment requires maker and checker approvals before execution');
    expect(compliance).not.toHaveBeenCalled();
  });

  it('runs compliance before processing status or payment-rail side effects', async () => {
    vi.spyOn(VendorEngine, 'ensureTables').mockResolvedValue(undefined);
    const query = vi.spyOn(pool, 'query').mockResolvedValue({
      rowCount: 1,
      rows: [{
        payment_id: 'VPAY-COMPLIANCE-FIRST',
        vendor_id: 'VENDOR-1',
        amount: '10.00',
        source_account_code: '1000',
        payment_method: 'ach',
        status: 'approved',
      }],
    });
    vi.spyOn(VendorEngine, 'hasRequiredApprovals').mockResolvedValue(true);
    vi.spyOn(VendorEngine, 'getVendor').mockResolvedValue({
      vendor_id: 'VENDOR-1',
      vendor_name: 'Blocked Vendor',
    });
    vi.spyOn(PaymentComplianceGate, 'screenVendorPayment')
      .mockRejectedValue(new Error('Compliance review required'));
    const executeAch = vi.spyOn(VendorEngine, '_executeACH');

    await expect(VendorEngine.executePayment('VPAY-COMPLIANCE-FIRST', 'operator@example.com'))
      .rejects.toThrow('Compliance review required');

    expect(executeAch).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]: [string]) => /SET status = 'processing'/.test(sql))).toBe(false);
    expect(query.mock.calls.some(([sql]: [string]) => /compliance_screening_id/.test(sql))).toBe(false);
  });

  it('runs compliance before direct bank records, transfers, and payment-run persistence', async () => {
    const query = vi.spyOn(pool, 'query').mockImplementation(async (sql: string) => {
      if (/SELECT \* FROM vendor_bills WHERE bill_id/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            bill_id: 'BILL-1',
            vendor_id: 'VENDOR-1',
            amount_cents: 1000,
            status: 'pending',
            memo: 'Invoice',
          }],
        };
      }
      if (/SELECT \* FROM vendor_payees WHERE vendor_id/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            vendor_id: 'VENDOR-1',
            name: 'Blocked Vendor',
            status: 'active',
            account_number: '1234',
            routing_number: '021000021',
            account_type: 'checking',
            country: 'US',
          }],
        };
      }
      return { rowCount: 0, rows: [] };
    });
    vi.spyOn(VendorPaymentEngine, '_assertConsensusApproval').mockResolvedValue(undefined);
    vi.spyOn(PaymentComplianceGate, 'screenVendorPayment')
      .mockRejectedValue(new Error('OFAC sanctions list is stale'));
    const createBankAccount = vi.spyOn(BankTransferEngine, 'createBankAccount');
    const pushCredit = vi.spyOn(BankTransferEngine, 'pushCredit');

    await expect(VendorPaymentEngine.payBill({
      billId: 'BILL-1',
      consensusProposalId: 'CC-APPROVED',
      sourceCashAccountId: '1000',
      rail: 'bank_transfer',
    })).rejects.toThrow('OFAC sanctions list is stale');

    expect(createBankAccount).not.toHaveBeenCalled();
    expect(pushCredit).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]: [string]) => /INSERT INTO vendor_payment_runs/.test(sql))).toBe(false);
  });

  it('requires a maker-checker proposal for direct vendor bills', async () => {
    vi.spyOn(VendorPaymentEngine, 'ensureTables').mockResolvedValue(undefined);

    await expect(VendorPaymentEngine.payBill({
      billId: 'BILL-NO-CONSENSUS',
      sourceCashAccountId: '1000',
      rail: 'bank_transfer',
    })).rejects.toThrow('Vendor bill payment requires an approved maker-checker proposal');
  });
});
