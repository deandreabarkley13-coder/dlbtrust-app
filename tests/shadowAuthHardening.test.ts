import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const { AccountAbstractionEngine } = require('../server/integrations/dapp/accountAbstractionEngine');
const { dappAuth } = require('../server/integrations/auth/securityMiddleware');
const { JWT_SECRET } = require('../server/integrations/auth/userAuth');
const pool = require('../server/integrations/bonds/pgPool');
const jwt = require('jsonwebtoken');

const saved = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
});

// Whitelisting in shadow mode only records intent off-chain, so it must not
// depend on the live operator signing key. Live paymaster calls still require
// the full credential set.
describe('shadow paymaster whitelisting', () => {
  it('records the whitelist off-chain without an operator signing key', async () => {
    process.env.AA_SHADOW = 'true';
    delete process.env.DAPP_PRIVATE_KEY;
    delete process.env.AA_PAYMASTER_ADDRESS;
    vi.spyOn(pool, 'query').mockResolvedValue({ rows: [], rowCount: 0 } as any);

    const result = await AccountAbstractionEngine.whitelistSender(
      '0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16',
      true
    );
    expect(result.shadow).toBe(true);
    expect(result.allowed).toBe(true);
  });
});

describe('dApp auth identity resolution', () => {
  it('keeps the user session as the identity when an admin token is sent alongside it', async () => {
    process.env.ADMIN_SECRET_TOKEN = 'test-admin-token';
    const token = jwt.sign(
      { email: 'holder@example.com', roles: ['beneficiary'], role: 'beneficiary' },
      JWT_SECRET
    );

    const req: any = {
      headers: { authorization: `Bearer ${token}`, 'x-admin-token': 'test-admin-token' },
      query: {},
    };
    const next = vi.fn();
    await dappAuth({ role: 'admin' })(req, { status: () => ({ json: () => undefined }) } as any, next);

    expect(next).toHaveBeenCalled();
    expect(req.user.email).toBe('holder@example.com');
    expect(req.authMethod).toBe('dapp_user');
  });
});
