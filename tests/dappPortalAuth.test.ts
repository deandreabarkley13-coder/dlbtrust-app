import { describe, expect, it, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const { DappEngine } = require('../server/integrations/dapp/dappEngine');
const { EmailEngine } = require('../server/integrations/dapp/emailEngine');
const { PtcPortalEngine } = require('../server/integrations/dapp/ptcPortalEngine');
const { MelioEngine } = require('../server/integrations/os/osEngine');

const originalEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  DAPP_OTP_ALWAYS_SHOW_CODE: process.env.DAPP_OTP_ALWAYS_SHOW_CODE,
};

afterEach(() => {
  vi.restoreAllMocks();
  if (originalEnvironment.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnvironment.NODE_ENV;
  if (originalEnvironment.DAPP_OTP_ALWAYS_SHOW_CODE === undefined) delete process.env.DAPP_OTP_ALWAYS_SHOW_CODE;
  else process.env.DAPP_OTP_ALWAYS_SHOW_CODE = originalEnvironment.DAPP_OTP_ALWAYS_SHOW_CODE;
});

function mockOtpUser() {
  vi.spyOn(DappEngine, 'getUserByEmail').mockResolvedValue({
    id: 'USER-1',
    email: 'beneficiary@example.com',
    name: 'Beneficiary',
    role: 'beneficiary',
    roles: ['beneficiary'],
  });
  vi.spyOn(DappEngine, '_update').mockResolvedValue(undefined);
}

describe('dApp portal authentication and role scoping', () => {
  it('does not expose an OTP when email delivery succeeds', async () => {
    mockOtpUser();
    vi.spyOn(EmailEngine, 'sendOtp').mockResolvedValue({ sent: true, provider: 'test' });

    const result = await DappEngine.generateOtp('beneficiary@example.com');

    expect(result.sent).toBe(true);
    expect(result.code).toBeNull();
  });

  it('fails closed when delivery fails unless both development conditions are enabled', async () => {
    mockOtpUser();
    vi.spyOn(EmailEngine, 'sendOtp').mockResolvedValue({ sent: false, provider: 'log' });
    process.env.DAPP_OTP_ALWAYS_SHOW_CODE = 'true';
    process.env.NODE_ENV = 'production';

    try {
      await DappEngine.generateOtp('beneficiary@example.com');
      throw new Error('expected OTP delivery to fail closed');
    } catch (error) {
      expect(error.message).toBe("We couldn't deliver your PIN. Contact the administrator.");
      expect(error.status).toBe(503);
    }

    process.env.NODE_ENV = 'development';
    const result = await DappEngine.generateOtp('beneficiary@example.com');
    expect(result.code).toMatch(/^\d{6}$/);
  });

  it('keeps an emailed OTP usable by verifyOtp', async () => {
    const user = {
      id: 'USER-1',
      email: 'beneficiary@example.com',
      role: 'beneficiary',
      roles: ['beneficiary'],
      otp_code: '123456',
      otp_expires: new Date(Date.now() + 60_000).toISOString(),
    };
    vi.spyOn(DappEngine, 'getUserByEmail').mockResolvedValue(user);
    vi.spyOn(DappEngine, 'getUser').mockResolvedValue({ ...user });
    vi.spyOn(DappEngine, '_update').mockResolvedValue(undefined);

    const result = await DappEngine.verifyOtp({ email: user.email, code: '123456' });

    expect(result.token).toBeTruthy();
    expect(result.email).toBe(user.email);
  });

  it('omits trust-wide fields for beneficiaries while retaining them for trustees', () => {
    const trustWide = {
      sourceOfTruth: { netWorth: 1000000 },
      members: [{ email: 'other@example.com' }],
      pendingRequests: [{ request_id: 'OWN-1' }],
      recentPayouts: [{ payout_id: 'OWN-PAY-1' }],
      myStatement: { member: { email: 'beneficiary@example.com' } },
    };

    const beneficiary = PtcPortalEngine._buildDashboardPayload({
      viewerRole: 'beneficiary',
      viewerRoles: ['beneficiary'],
      ...trustWide,
    });
    expect(beneficiary.viewerRole).toBe('beneficiary');
    expect(beneficiary.sourceOfTruth).toBeUndefined();
    expect(beneficiary.members).toBeUndefined();
    expect(beneficiary.pendingRequests).toEqual(trustWide.pendingRequests);
    expect(beneficiary.recentPayouts).toEqual(trustWide.recentPayouts);

    const trustee = PtcPortalEngine._buildDashboardPayload({
      viewerRole: 'trustee_maker',
      viewerRoles: ['trustee_maker', 'beneficiary'],
      ...trustWide,
    });
    expect(trustee.sourceOfTruth).toEqual(trustWide.sourceOfTruth);
    expect(trustee.members).toEqual(trustWide.members);
  });

  it('rejects traversal-style Melio download identifiers before database lookup', async () => {
    await expect(MelioEngine.getExportFile('../melio-export.csv'))
      .rejects.toThrow('Invalid Melio export identifier');
    await expect(MelioEngine.getExportFile('nested/path'))
      .rejects.toThrow('Invalid Melio export identifier');
  });

  it('never pre-fills or echoes the OTP on public login pages', () => {
    const pages = [
      '../public/dapp/index.html',
      '../public/trust-portal/index.html',
      '../public/dapp/mobile.html',
      '../public/dapp/finops.html',
      '../public/dapp/legacy.html',
    ];
    pages.forEach((page) => {
      const source = fs.readFileSync(path.resolve(testDirectory, page), 'utf8');
      expect(source).not.toContain('res.data.code');
      expect(source).not.toContain('res.data && res.data.code');
      expect(source).not.toMatch(/(?:pin|login-code)\.value\s*=\s*res\.data\.code/);
    });
  });

  it('only exposes trust-wide dashboard panels to trustee viewers', () => {
    const source = fs.readFileSync(path.resolve(testDirectory, '../public/trust-portal/dashboard.html'), 'utf8');
    expect(source).toContain('id="tab-overview"');
    expect(source).toContain('id="tab-portfolio"');
    expect(source).toContain('configureDashboardViewer(dashboard.viewerRole)');
    expect(source).toContain('if (dashboardTrustee)');
    expect(source).toContain('showTab(\'beneficiary\')');
  });
});
