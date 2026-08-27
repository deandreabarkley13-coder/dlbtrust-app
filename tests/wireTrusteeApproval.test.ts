import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import type { AddressInfo } from 'net';

const require = createRequire(import.meta.url);
const express = require('express');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../server/integrations/auth/userAuth');
const { WireEngine } = require('../server/integrations/wire/wireEngine');
const wireRoutes = require('../server/routes/wire');

const pendingWire = {
  wire_id: 'WIRE-20260701-PGSYZP',
  status: 'pending_approval',
  amount_cents: '25',
  beneficiary_name: 'DeAndrea Barkley',
  description: 'Micro deposit test',
  initiated_by: 'admin',
  created_at: new Date().toISOString(),
};

function trusteeToken(role: string, email: string) {
  return jwt.sign({ email, role, roles: [role, 'beneficiary'] }, JWT_SECRET, { expiresIn: '1h' });
}

let baseUrl = '';
let server: ReturnType<typeof app.listen>;
const app = express();
app.use(express.json());
app.use('/api/wire', wireRoutes);

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('wire approvals for signed-in trustees', () => {
  it('rejects unauthenticated approval queue reads', async () => {
    const res = await fetch(`${baseUrl}/api/wire/pending-approvals`);
    expect(res.status).toBe(401);
  });

  it('lists wires awaiting approval for a checker portal session', async () => {
    vi.spyOn(WireEngine, 'getPendingApprovals').mockResolvedValue([pendingWire]);

    const res = await fetch(`${baseUrl}/api/wire/pending-approvals`, {
      headers: { Authorization: `Bearer ${trusteeToken('trustee_checker', 'checker@example.com')}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, count: 1, data: [{ wire_id: pendingWire.wire_id }] });
  });

  it('approves as the authenticated checker rather than a generic operator', async () => {
    const approveWire = vi.spyOn(WireEngine, 'approveWire')
      .mockResolvedValue({ ...pendingWire, status: 'approved', approved_by: 'checker@example.com' });

    const res = await fetch(`${baseUrl}/api/wire/${pendingWire.wire_id}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${trusteeToken('trustee_checker', 'checker@example.com')}`,
      },
      body: '{}',
    });

    expect(res.status).toBe(200);
    expect(approveWire).toHaveBeenCalledWith(pendingWire.wire_id, 'checker@example.com');
  });

  it('blocks the maker seat from approving or rejecting wires', async () => {
    const approveWire = vi.spyOn(WireEngine, 'approveWire').mockResolvedValue(pendingWire);
    const rejectWire = vi.spyOn(WireEngine, 'rejectWire').mockResolvedValue(pendingWire);
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${trusteeToken('trustee_maker', 'maker@example.com')}`,
    };

    const approved = await fetch(`${baseUrl}/api/wire/${pendingWire.wire_id}/approve`, { method: 'POST', headers, body: '{}' });
    const rejected = await fetch(`${baseUrl}/api/wire/${pendingWire.wire_id}/reject`, { method: 'POST', headers, body: '{}' });

    expect(approved.status).toBe(403);
    expect(rejected.status).toBe(403);
    expect(approveWire).not.toHaveBeenCalled();
    expect(rejectWire).not.toHaveBeenCalled();
  });

  it('ignores beneficiary-only portal sessions', async () => {
    const res = await fetch(`${baseUrl}/api/wire/pending-approvals`, {
      headers: { Authorization: `Bearer ${trusteeToken('beneficiary', 'beneficiary@example.com')}` },
    });
    expect(res.status).toBe(401);
  });
});
