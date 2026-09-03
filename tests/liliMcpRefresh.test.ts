import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { SystemSettings } = require('../server/integrations/ach/systemSettings');
const { LiliMcpEngine } = require('../server/integrations/payments/liliMcpEngine');

const saved = { ...process.env };

function response(status: number, body: any, headers: Record<string, string> = {}) {
  const map = new Map(Object.entries({ 'content-type': 'application/json', ...headers }));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => map.get(k.toLowerCase()) ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  };
}

describe('Lili MCP — expired access tokens are refreshed and persisted', () => {
  let settings: Record<string, string>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    delete process.env.PAYMENT_DATA_ENCRYPTION_KEY;
    settings = {
      LILI_MCP_ENABLED: 'true',
      LILI_MCP_URL: 'https://mcp.lili.test/mcp',
      LILI_OAUTH_BASE_URL: 'https://mcp.lili.test',
      LILI_OAUTH_CLIENT_ID: 'client-1',
      LILI_OAUTH_ACCESS_TOKEN: 'stale-token',
      LILI_OAUTH_REFRESH_TOKEN: 'refresh-1',
    };
    vi.spyOn(SystemSettings, 'get').mockImplementation(async (k: string) => settings[k] ?? null);
    vi.spyOn(SystemSettings, 'set').mockImplementation(async (k: string, v: string) => { settings[k] = v; });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    LiliMcpEngine._sessionId = 'sess-1';
  });

  const listTools = () => LiliMcpEngine._mcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  it('retries once with a refreshed token after a 401 and stores the new tokens', async () => {
    fetchMock
      .mockResolvedValueOnce(response(401, ''))
      .mockResolvedValueOnce(response(200, { access_token: 'fresh-token', refresh_token: 'refresh-2', expires_in: 3600 }))
      .mockResolvedValueOnce(response(200, { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'lili_create_bill' }] } }));

    const res = await listTools();
    expect(res.result.tools[0].name).toBe('lili_create_bill');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer stale-token');
    expect(fetchMock.mock.calls[1][0]).toBe('https://mcp.lili.test/oauth/token');
    expect(String(fetchMock.mock.calls[1][1].body)).toContain('grant_type=refresh_token');
    expect(String(fetchMock.mock.calls[1][1].body)).toContain('refresh_token=refresh-1');
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer fresh-token');

    expect(settings.LILI_OAUTH_ACCESS_TOKEN).toBe('fresh-token');
    expect(settings.LILI_OAUTH_REFRESH_TOKEN).toBe('refresh-2');
  });

  it('does not loop when the refreshed token is also rejected, and says what to do when the refresh itself fails', async () => {
    fetchMock
      .mockResolvedValueOnce(response(401, ''))
      .mockResolvedValueOnce(response(200, { access_token: 'fresh-token' }))
      .mockResolvedValueOnce(response(401, ''));
    await expect(listTools()).rejects.toThrow(/MCP request failed: 401/);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(response(401, ''))
      .mockResolvedValueOnce(response(400, { error: 'invalid_grant' }));
    await expect(listTools()).rejects.toThrow(/refresh failed: OAuth refresh failed: 400.*re-run the OAuth capture/);
    expect(settings.LILI_OAUTH_ACCESS_TOKEN).toBe('fresh-token');
  });
});
