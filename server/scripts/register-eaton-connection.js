'use strict';

/**
 * Register (or update) the Eaton Family Credit Union banking-aggregator
 * connection for automatic, machine-to-machine financial-data exchange.
 *
 * The connection uses the generic_rest connector with OAuth2 client-credentials
 * auth: the server fetches a short-lived access token from EATON_TOKEN_URL using
 * EATON_CLIENT_ID / EATON_CLIENT_SECRET and sends it as a Bearer token on every
 * pull/push — no human intervention. Once registered, the auto-sync scheduler
 * pulls transactions on its interval and DataBridge auto-posts them to the GL.
 *
 * NO SECRETS ARE HARDCODED. All sensitive values come from the environment:
 *
 *   EATON_BASE_URL       e.g. https://api.eatonfamilycu.example/v1   (required)
 *   EATON_TOKEN_URL      OAuth2 token endpoint                       (required)
 *   EATON_CLIENT_ID      OAuth2 client id                            (required)
 *   EATON_CLIENT_SECRET  OAuth2 client secret                        (required)
 *   EATON_SCOPE          OAuth2 scope(s), optional
 *   EATON_AUDIENCE       OAuth2 audience, optional
 *   EATON_ACCOUNTS_PATH      default /accounts
 *   EATON_TRANSACTIONS_PATH  default /transactions
 *   EATON_STATEMENTS_PATH    default /statements
 *   EATON_PUSH_PATH          default /payments
 *   EATON_DIRECTION      inbound|outbound|both  (default: both)
 *   EATON_CONNECTION_ID  connection id          (default: CONN-EATON-FCU)
 *   EATON_CONNECTOR      generic_rest | eaton   (default: eaton)
 *
 * When EATON_CONNECTOR=eaton, these payment-file endpoints are also configured
 * (outbound NACHA/ISO file transmit + status + ACH returns pull over REST):
 *   EATON_FILE_INTAKE_PATH   default /ach/files
 *   EATON_FILE_STATUS_PATH   default /ach/files
 *   EATON_RETURNS_PATH       default /ach/returns
 *   EATON_FILE_FORMAT        default nacha
 *
 * Optional mutual TLS (machine-to-machine client cert, additive to OAuth2):
 *   EATON_USE_MTLS=true, EATON_CLIENT_CERT_PATH, EATON_CLIENT_KEY_PATH,
 *   EATON_CLIENT_CA_PATH, EATON_CLIENT_KEY_PASSPHRASE
 *
 * Usage:
 *   node server/scripts/register-eaton-connection.js            # create/update
 *   node server/scripts/register-eaton-connection.js --dry-run  # validate only, no DB write
 */

const CONNECTION_ID = process.env.EATON_CONNECTION_ID || 'CONN-EATON-FCU';
const DRY_RUN = process.argv.includes('--dry-run');

function required(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return String(v).trim();
}

const CONNECTOR = (process.env.EATON_CONNECTOR || 'eaton').trim();

function buildConfig() {
  const config = {
    baseUrl: required('EATON_BASE_URL'),
    endpoints: {
      accounts: process.env.EATON_ACCOUNTS_PATH || '/accounts',
      transactions: process.env.EATON_TRANSACTIONS_PATH || '/transactions',
      statements: process.env.EATON_STATEMENTS_PATH || '/statements',
      push: process.env.EATON_PUSH_PATH || '/payments',
    },
    auth: {
      type: 'oauth2_client_credentials',
      tokenUrl: required('EATON_TOKEN_URL'),
      clientId: required('EATON_CLIENT_ID'),
      clientSecret: required('EATON_CLIENT_SECRET'),
    },
  };
  if (process.env.EATON_SCOPE) config.auth.scope = process.env.EATON_SCOPE.trim();
  if (process.env.EATON_AUDIENCE) config.auth.audience = process.env.EATON_AUDIENCE.trim();

  // Payment-file exchange endpoints for the dedicated Eaton connector.
  if (CONNECTOR === 'eaton') {
    config.endpoints.fileIntake = process.env.EATON_FILE_INTAKE_PATH || '/ach/files';
    config.endpoints.fileStatus = process.env.EATON_FILE_STATUS_PATH || '/ach/files';
    config.endpoints.returns = process.env.EATON_RETURNS_PATH || '/ach/returns';
    config.defaultFileFormat = process.env.EATON_FILE_FORMAT || 'nacha';
  }

  // Optional mutual TLS (client certificate), additive to OAuth2.
  if (String(process.env.EATON_USE_MTLS || '').toLowerCase() === 'true') {
    config.useMtls = true;
    config.clientCertPath = required('EATON_CLIENT_CERT_PATH');
    config.clientKeyPath = required('EATON_CLIENT_KEY_PATH');
    if (process.env.EATON_CLIENT_CA_PATH) config.clientCaPath = process.env.EATON_CLIENT_CA_PATH.trim();
    if (process.env.EATON_CLIENT_KEY_PASSPHRASE) config.clientKeyPassphrase = process.env.EATON_CLIENT_KEY_PASSPHRASE;
  }
  return config;
}

// Redact secret material for logging.
function redactedView(config) {
  const c = JSON.parse(JSON.stringify(config));
  if (c.auth) {
    if (c.auth.clientSecret) c.auth.clientSecret = '***redacted***';
  }
  if (c.clientKeyPassphrase) c.clientKeyPassphrase = '***redacted***';
  return c;
}

async function main() {
  const direction = process.env.EATON_DIRECTION || 'both';
  const config = buildConfig();

  console.log('[eaton] connection id:', CONNECTION_ID);
  console.log('[eaton] connector   :', CONNECTOR);
  console.log('[eaton] direction   :', direction);
  console.log('[eaton] config      :', JSON.stringify(redactedView(config)));

  if (DRY_RUN) {
    console.log('[eaton] --dry-run: configuration valid; no database changes made.');
    return;
  }

  const { BankingAggregator } = require('../integrations/aggregator/bankingAggregator');

  const existing = await BankingAggregator._getConnectionRaw(CONNECTION_ID);
  if (existing) {
    await BankingAggregator.updateConnection(CONNECTION_ID, {
      name: 'Eaton Family Credit Union',
      direction,
      active: true,
      config,
    });
    console.log('[eaton] updated existing connection ' + CONNECTION_ID);
  } else {
    await BankingAggregator.createConnection({
      id: CONNECTION_ID,
      name: 'Eaton Family Credit Union',
      connectorType: CONNECTOR,
      direction,
      active: true,
      config,
    });
    console.log('[eaton] created connection ' + CONNECTION_ID);
  }

  console.log('[eaton] done. The auto-sync scheduler will pull + auto-post to the GL on its interval.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[eaton] registration failed:', err.message);
    process.exit(1);
  });
