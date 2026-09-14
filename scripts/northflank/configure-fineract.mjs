// Wire Apache Fineract into the Northflank project without committing any
// credential to git.
//
// Writes two secret groups (created if missing, merged if present — see
// set-secrets.mjs for why the raw PATCH must never be issued blind):
//
//   fineract-runtime   restricted to the dlbtrust-fineract service. Plaintext
//                      HTTP on 8443 plus the Hikari / tenant-DB settings the
//                      apache/fineract image reads at boot. The DB user and
//                      password come from the fineract-db addon's
//                      POSTGRES_URI_ADMIN: Fineract creates and owns the
//                      fineract_tenants / fineract_default databases itself, so
//                      it (and the app's Liquibase lock cleanup, which updates
//                      tables Fineract owns) must connect as the addon admin.
//                      Northflank exposes no separate USERNAME/PASSWORD keys.
//
//   dlbtrust-runtime   the app's group. Adds FINERACT_URL, FINERACT_TENANT_ID,
//                      FINERACT_USERNAME, FINERACT_PASSWORD and links the
//                      fineract-db addon so FINERACT_DATABASE_URL,
//                      FINERACT_DB_HOST and FINERACT_DB_PORT follow the addon
//                      (fineractResilience.cleanLiquibaseLocks targets them).
//
// Usage:
//   NORTHFLANK_API_TOKEN=... FINERACT_PASSWORD=... \
//     node scripts/northflank/configure-fineract.mjs [--dry-run]
//
// Optional env: FINERACT_USERNAME (mifos), FINERACT_TENANT_ID (default),
// NORTHFLANK_PROJECT_ID (dlbtrust), NORTHFLANK_FINERACT_SERVICE_ID
// (dlbtrust-fineract), NORTHFLANK_FINERACT_ADDON_ID (fineract-db),
// NORTHFLANK_RUNTIME_SECRET_GROUP (dlbtrust-runtime).
//
// Values are never printed: only key names and variable counts.

const NF_API = process.env.NORTHFLANK_API_HOST || 'https://api.northflank.com';
const PROJECT_ID = process.env.NORTHFLANK_PROJECT_ID || 'dlbtrust';
const FINERACT_SERVICE_ID = process.env.NORTHFLANK_FINERACT_SERVICE_ID || 'dlbtrust-fineract';
const FINERACT_ADDON_ID = process.env.NORTHFLANK_FINERACT_ADDON_ID || 'fineract-db';
const RUNTIME_GROUP = process.env.NORTHFLANK_RUNTIME_SECRET_GROUP || 'dlbtrust-runtime';
const FINERACT_GROUP = 'fineract-runtime';
const FINERACT_PORT = '8443';

const dryRun = process.argv.includes('--dry-run');

async function nfRequest(method, path, body = null) {
  const response = await fetch(`${NF_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NORTHFLANK_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function mergeAddonDependency(existing, dependency) {
  const others = (existing || []).filter((dep) => dep.addonId !== dependency.addonId);
  return [...others, dependency];
}

function describeChange(label, existingVars, nextVars) {
  console.log(`${label}: ${Object.keys(existingVars).length} → ${Object.keys(nextVars).length} variables`);
  for (const key of Object.keys(nextVars).sort()) {
    if (!(key in existingVars)) console.log(`  add    ${key}`);
    else if (existingVars[key] !== nextVars[key]) console.log(`  update ${key}`);
  }
}

async function upsertSecretGroup(id, spec) {
  const path = `/v1/projects/${PROJECT_ID}/secrets/${id}`;
  const current = await nfRequest('GET', path);
  const existingVars = current?.data?.secrets?.variables || {};
  const variables = { ...existingVars, ...spec.variables };
  const addonDependencies = spec.addonDependency
    ? mergeAddonDependency(current?.data?.addonDependencies, spec.addonDependency)
    : current?.data?.addonDependencies;

  describeChange(`${current ? 'update' : 'create'} ${id}`, existingVars, variables);
  if (spec.addonDependency) {
    console.log(`  link   ${spec.addonDependency.addonId} → ${spec.addonDependency.keys
      .map((k) => k.aliases.join(','))
      .join(' ')}`);
  }
  if (dryRun) return;

  const body = {
    name: current?.data?.name || id,
    description: current?.data?.description || spec.description,
    secretType: current?.data?.secretType || 'environment',
    priority: current?.data?.priority ?? spec.priority,
    restrictions: current?.data?.restrictions || spec.restrictions,
    secrets: { variables },
  };
  if (addonDependencies && addonDependencies.length) body.addonDependencies = addonDependencies;

  if (current) {
    await nfRequest('PATCH', path, body);
  } else {
    await nfRequest('POST', `/v1/projects/${PROJECT_ID}/secrets`, { ...body, id });
  }
  console.log(`  wrote  ${id}`);
}

async function main() {
  if (!process.env.NORTHFLANK_API_TOKEN) throw new Error('NORTHFLANK_API_TOKEN is required');
  if (!process.env.FINERACT_PASSWORD) throw new Error('FINERACT_PASSWORD is required (never stored in git)');

  const username = process.env.FINERACT_USERNAME || 'mifos';
  const tenant = process.env.FINERACT_TENANT_ID || 'default';

  const credentials = await nfRequest(
    'GET',
    `/v1/projects/${PROJECT_ID}/addons/${FINERACT_ADDON_ID}/credentials`,
  );
  if (!credentials) throw new Error(`addon ${FINERACT_ADDON_ID} not found — run scripts/northflank/provision.sh first`);
  const envs = credentials.data.envs;
  const pg = new URL(envs.POSTGRES_URI_ADMIN);
  const dbUser = decodeURIComponent(pg.username);
  const dbPassword = decodeURIComponent(pg.password);
  const dbHost = String(envs.HOST);
  const dbPort = String(envs.PORT);

  await upsertSecretGroup(FINERACT_GROUP, {
    description: 'Apache Fineract runtime (DB credentials from the fineract-db addon)',
    priority: 20,
    restrictions: {
      restricted: true,
      nfObjects: [{ id: FINERACT_SERVICE_ID, type: 'service' }],
      tags: [],
      tagMatchCondition: 'or',
    },
    variables: {
      FINERACT_SERVER_PORT: FINERACT_PORT,
      FINERACT_SERVER_SSL_ENABLED: 'false',
      FINERACT_NODE_ID: '1',
      JAVA_TOOL_OPTIONS: '-Xmx1024m',
      FINERACT_HIKARI_DRIVER_SOURCE_CLASS_NAME: 'org.postgresql.Driver',
      FINERACT_HIKARI_JDBC_URL: `jdbc:postgresql://${dbHost}:${dbPort}/fineract_tenants`,
      FINERACT_HIKARI_USERNAME: dbUser,
      FINERACT_HIKARI_PASSWORD: dbPassword,
      FINERACT_DEFAULT_TENANTDB_HOSTNAME: dbHost,
      FINERACT_DEFAULT_TENANTDB_PORT: dbPort,
      FINERACT_DEFAULT_TENANTDB_NAME: 'fineract_default',
      FINERACT_DEFAULT_TENANTDB_UID: dbUser,
      FINERACT_DEFAULT_TENANTDB_PWD: dbPassword,
    },
  });

  await upsertSecretGroup(RUNTIME_GROUP, {
    description: 'dlbtrust-app runtime',
    priority: 10,
    restrictions: { restricted: false, nfObjects: [], tags: [], tagMatchCondition: 'or' },
    variables: {
      FINERACT_URL: `http://${FINERACT_SERVICE_ID}:${FINERACT_PORT}/fineract-provider/api/v1`,
      FINERACT_TENANT_ID: tenant,
      FINERACT_USERNAME: username,
      FINERACT_PASSWORD: process.env.FINERACT_PASSWORD,
      FINERACT_DEFAULT_DB: 'fineract_default',
    },
    addonDependency: {
      addonId: FINERACT_ADDON_ID,
      keys: [
        { keyName: 'POSTGRES_URI_ADMIN', aliases: ['FINERACT_DATABASE_URL'] },
        { keyName: 'HOST', aliases: ['FINERACT_DB_HOST'] },
        { keyName: 'PORT', aliases: ['FINERACT_DB_PORT'] },
      ],
    },
  });

  if (dryRun) console.log('dry run: nothing written');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
