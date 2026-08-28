import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pool = require('../server/integrations/bonds/pgPool');
const { VendorPaymentEngine } = require('../server/integrations/dapp/vendorPaymentEngine');
const { PaymentComplianceGate } = require('../server/integrations/compliance/paymentComplianceGate');
const { listConnectorTypes } = require('../server/integrations/aggregator/connectors');
const { BANK_REGISTRY } = require('../server/integrations/ach/systemSettings');

afterEach(() => {
  vi.restoreAllMocks();
});

function stubBillQueries() {
  return vi.spyOn(pool, 'query').mockImplementation(async (sql: string) => {
    if (/SELECT \* FROM vendor_bills WHERE bill_id/.test(sql)) {
      return {
        rowCount: 1,
        rows: [{
          bill_id: 'BILL-MELIO',
          vendor_id: 'VENDOR-DBNET',
          amount_cents: 2500,
          currency: 'USD',
          status: 'pending',
          memo: 'DB NET MGMT invoice',
        }],
      };
    }
    if (/SELECT \* FROM vendor_payees WHERE vendor_id/.test(sql)) {
      return {
        rowCount: 1,
        rows: [{
          vendor_id: 'VENDOR-DBNET',
          name: 'DB NET MGMT',
          status: 'active',
          account_number: '1234',
          routing_number: '021000021',
          bank_name: 'Lili Bank',
          account_type: 'checking',
          country: 'US',
          metadata: {},
        }],
      };
    }
    return { rowCount: 0, rows: [] };
  });
}

describe('Melio is the default B2B payment rail', () => {
  it('routes a vendor bill through Melio without touching a bank endpoint', async () => {
    vi.spyOn(VendorPaymentEngine, 'ensureTables').mockResolvedValue(undefined);
    vi.spyOn(VendorPaymentEngine, '_assertConsensusApproval').mockResolvedValue(undefined);
    vi.spyOn(PaymentComplianceGate, 'screenVendorPayment').mockResolvedValue({ screeningId: 'SCR-1' });
    const query = stubBillQueries();

    const result = await VendorPaymentEngine.payBill({
      billId: 'BILL-MELIO',
      consensusProposalId: 'CC-APPROVED',
      sourceCashAccountId: '1000',
    });

    expect(result.status).toBe('initiated');
    expect(result.payment.provider).toBe('melio');
    expect(result.payment.shadow).toBe(true);
    expect(result.transfer).toBeNull();
    const railInsert = query.mock.calls.find(
      ([sql]: [string]) => /INSERT INTO vendor_payment_runs/.test(sql),
    );
    expect(railInsert?.[1]).toContain('melio');
  });
});

describe('Eaton Family Credit Union is fully removed', () => {
  it('no longer registers an Eaton aggregator connector', () => {
    expect(listConnectorTypes()).not.toContain('eaton');
  });

  it('no longer offers an Eaton bank partner template', () => {
    const ids = BANK_REGISTRY.map((p: { id: string }) => p.id);
    expect(ids).not.toContain('eaton-fcu');
    expect(BANK_REGISTRY.some((p: { endpoint_template?: string; wire_endpoint_template?: string }) => (
      /eatonfcu/i.test(p.endpoint_template || '') || /eatonfcu/i.test(p.wire_endpoint_template || '')
    ))).toBe(false);
  });

  it('does not hardcode an ODFI identity in generated NACHA files', () => {
    const nacha = require('../server/integrations/ach/nachaGenerator');
    expect(nacha.ODFI_ROUTING).not.toBe('241075470');
    const file = nacha.generateNACHAFile({
      entries: [{
        routingNumber: '021000021',
        accountNumber: '1234',
        amount: 1.0,
        receiverName: 'DB NET MGMT',
        transactionCode: '22',
      }],
    });
    expect(String(file.content || file)).not.toMatch(/EATON/i);
  });
});
