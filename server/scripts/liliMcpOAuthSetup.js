'use strict';

/**
 * Lili MCP OAuth local capture script
 *
 * Run this on the machine where you will log in to Lili.
 *
 * 1. Starts a temporary HTTP server on a random localhost port.
 * 2. Registers/tells the deployed app to start an OAuth session.
 * 3. Opens the Lili authorization URL in the default browser.
 * 4. Captures the authorization code on http://localhost:<port>/callback.
 * 5. Sends the code back to the app, which exchanges it and stores the tokens.
 *
 * Usage:
 *   ADMIN_TOKEN=dlb-admin-2026-trust node server/scripts/liliMcpOAuthSetup.js
 *   ADMIN_TOKEN=... node server/scripts/liliMcpOAuthSetup.js --reset   # forget the
 *     registered client + tokens first (use after "OAuth refresh failed: 400")
 *   PORT=3000 ...   # pin the loopback port (default: random)
 */

const http = require('http');
const { URL } = require('url');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dlb-admin-2026-trust';
const API_BASE = process.env.API_BASE || process.env.APP_URL || 'https://p01--dlbtrust-app--gcq8bn6c4zlp.code.run';
const PORT = process.env.PORT ? Number(process.env.PORT) : 0;
const RESET = process.argv.includes('--reset');

function requestJson(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, API_BASE);
    const postData = body ? JSON.stringify(body) : null;
    const req = require(url.protocol === 'https:' ? 'https' : 'http').request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search || ''}`,
      method,
      headers: {
        'x-admin-token': ADMIN_TOKEN,
        ...(postData ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function openBrowser(url) {
  const { exec } = require('child_process');
  const cmd = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'start' : 'xdg-open');
  exec(`${cmd} ${url}`, (err) => {
    if (err) console.log('Could not auto-open browser. Please open the URL above manually.');
  });
}

async function main() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${actualPort}`);
    if (url.pathname !== '/callback') {
      res.writeHead(404); res.end('Not found'); return;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`OAuth error: ${error} ${errorDescription || ''}`);
      console.error('OAuth error from Lili:', error, errorDescription);
      server.close();
      process.exit(1);
    }

    if (!code || !state) {
      res.writeHead(400); res.end('Missing code or state'); return;
    }

    console.log('Captured Lili authorization code. Exchanging via app...');
    try {
      const result = await requestJson('GET', `/api/finops/lili/mcp/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (result.body && result.body.success) {
        res.end('<h1>Lili MCP connected</h1><p>You can close this tab.</p>');
        console.log('Success:', JSON.stringify(result.body, null, 2));
        const tools = await requestJson('POST', '/api/finops/lili/mcp/tools');
        console.log('tools/list:', JSON.stringify(tools.body, null, 2));
      } else {
        res.end(`<h1>Connection failed</h1><pre>${JSON.stringify(result.body)}</pre>`);
        console.error('Failed:', result.body);
      }
    } catch (e) {
      res.writeHead(500); res.end(e.message);
      console.error('Exchange error:', e.message);
    } finally {
      server.close();
      process.exit(0);
    }
  });

  await new Promise((resolve) => server.listen(PORT, resolve));
  const actualPort = server.address().port;
  const redirectUri = `http://localhost:${actualPort}/callback`;

  console.log('Starting Lili MCP OAuth capture on', redirectUri, RESET ? '(resetting stored client/tokens)' : '');
  const start = await requestJson('POST', '/api/finops/lili/mcp/oauth/start', { redirectUri, reset: RESET });
  if (!start.body || !start.body.success) throw new Error(`oauth/start failed: ${JSON.stringify(start.body)}`);

  const authUrl = start.body.data.authUrl;
  console.log('\nOpen this URL in the same machine\'s browser and log in to Lili:\n', authUrl, '\n');
  openBrowser(authUrl);
}

main().catch((e) => { console.error(e); process.exit(1); });
