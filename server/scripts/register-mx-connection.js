'use strict';

/**
 * Register (or update) an MX Platform API banking-aggregator connection.
 *
 * MX (mx.com) is a bank-data aggregator. This closes the "we don't know which
 * core the credit union runs" gap: link the institution once through MX, then
 * this connection pulls accounts/transactions for the linked MX user on the
 * auto-sync schedule and DataBridge auto-posts them to the GL — hands-off.
 *
 * MX Platform API specifics handled here:
 *   - Auth is HTTP Basic: username = MX Client ID, password = MX API Key
 *     (NOT OAuth2 client-credentials).
 *   - Every request must send  Accept: application/vnd.mx.api.v1+json
 *   - Accounts/transactions are user-scoped: /users/{userGuid}/accounts, etc.
 *   - List/field shapes are mapped to the aggregator's normalized form.
 *
 * NO SECRETS ARE HARDCODED — all sensitive values come from the environment:
 *
 *   MX_CLIENT_ID    MX Client ID   (required)  -> Basic auth username
 *   MX_API_KEY      MX API Key     (required)  -> Basic auth password
 *   MX_USER_GUID    MX user GUID   (required)  e.g. USR-xxxxxxxx
 *   MX_BASE_URL     API base       (default https://int-api.mx.com  = sandbox;
 *                                   production is https://api.mx.com)
 *   MX_API_VERSION  Accept version (default application/vnd.mx.api.v1+json)
 *   MX_DIRECTION    inbound|outbound|both  (default: inbound)
 *   MX_CONNECTION_ID  connection id        (default: CONN-MX)
 *
 * Usage:
 *   node server/scripts/register-mx-connection.js            # create/update
 *   node server/scripts/register-mx-connection.js --dry-run  # validate only
 */

const CONNECTION_ID = process.env.MX_CONNECTION_ID || 'CONN-MX';
const DRY_RUN = process.argv.includes('--dry-run');

function required(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing required environment variable ${name}`);
  return String(v).trim();
}

function buildConfig() {
  const baseUrl = (process.env.MX_BASE_URL || 'https://int-api.mx.com').trim();
  const userGuid = required('MX_USER_GUID');
  const accept = (process.env.MX_API_VERSION || 'application/vnd.mx.api.v1+json').trim();

  return {
    baseUrl,
    headers: { Accept: accept },
    endpoints: {
      accounts: `/users/${userGuid}/accounts`,
      transactions: `/users/${userGuid}/transactions`,
    },
    auth: {
      type: 'basic',
      username: required('MX_CLIENT_ID'),
      password: required('MX_API_KEY'),
    },
    // Where the arrays live in MX responses.
    listPaths: { accounts: 'accounts', transactions: 'transactions' },
    // Map MX field names -> aggregator normalized shape.
    mapping: {
      accounts: {
        externalAccountId: 'guid',
        name: 'name',
        accountType: 'type',
        currency: 'currency_code',
        balanceAvailable: 'available_balance',
        balanceCurrent: 'balance',
      },
      transactions: {
        externalTxnId: 'guid',
        externalAccountId: 'account_guid',
        postedDate: 'transacted_at',
        amount: 'amount',
        // MX returns type 'DEBIT'/'CREDIT'; the connector lowercases it.
        direction: 'type',
        currency: 'currency_code',
        description: 'description',
        category: 'category',
        status: 'status',
      },
    },
  };
}

function redactedView(config) {
  const c = JSON.parse(JSON.stringify(config));
  if (c.auth) {
    if (c.auth.username) c.auth.username = '***redacted***';
    if (c.auth.password) c.auth.password = '***redacted***';
  }
  return c;
}

async function main() {
  const direction = process.env.MX_DIRECTION || 'inbound';
  const config = buildConfig();

  console.log('[mx] connection id:', CONNECTION_ID);
  console.log('[mx] direction   :', direction);
  console.log('[mx] config      :', JSON.stringify(redactedView(config)));

  if (DRY_RUN) {
    console.log('[mx] --dry-run: configuration valid; no database changes made.');
    return;
  }

  const { BankingAggregator } = require('../integrations/aggregator/bankingAggregator');

  const existing = await BankingAggregator._getConnectionRaw(CONNECTION_ID);
  if (existing) {
    await BankingAggregator.updateConnection(CONNECTION_ID, {
      name: 'MX Platform (aggregator)',
      direction,
      active: true,
      config,
    });
    console.log('[mx] updated existing connection ' + CONNECTION_ID);
  } else {
    await BankingAggregator.createConnection({
      id: CONNECTION_ID,
      name: 'MX Platform (aggregator)',
      connectorType: 'generic_rest',
      direction,
      active: true,
      config,
    });
    console.log('[mx] created connection ' + CONNECTION_ID);
  }

  console.log('[mx] done. The auto-sync scheduler will pull + auto-post to the GL on its interval.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[mx] registration failed:', err.message);
    process.exit(1);
  });
