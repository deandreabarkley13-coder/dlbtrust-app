'use strict';

/**
 * Lili MCP OAuth setup script
 *
 * Generates a Lili authorization URL using the deployed app callback.
 * After you open the URL in a browser and authorize Lili, the callback
 * exchanges the code and stores the access/refresh tokens in system_settings.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node server/scripts/liliMcpOAuthSetup.js
 *   # Then open the printed URL and log in.
 *   # Tokens are automatically saved by the deployed callback route.
 */

require('dotenv').config();

const { LiliMcpEngine } = require('../integrations/payments/liliMcpEngine');

async function main() {
  try {
    const redirectUri = process.env.LILI_OAUTH_REDIRECT_URI || 'https://dlbtrust-app.fly.dev/api/finops/lili/mcp/oauth/callback';
    const result = await LiliMcpEngine.startOAuth({ redirectUri });
    console.log('\nOpen this URL in your browser and authorize Lili:');
    console.log(result.authUrl);
    console.log('\nAfter authorization, the callback will save tokens to system_settings.');
    console.log('Check status with: curl -H "x-admin-token: <token>" https://dlbtrust-app.fly.dev/api/finops/lili/mcp/status');
  } catch (err) {
    console.error('Failed to start Lili OAuth:', err.message);
    process.exit(1);
  }
}

main();
