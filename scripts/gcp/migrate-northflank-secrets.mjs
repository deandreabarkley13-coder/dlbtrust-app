#!/usr/bin/env node
// Copy the Northflank `dlbtrust-runtime` secret group into Secret Manager, one
// secret per variable, so the Cloud Run service gets the same environment the
// Northflank service had. Counterpart of scripts/northflank/migrate-fly-secrets.mjs.
//
// Values are never printed: only variable names are logged.
//
// Usage:
//   NORTHFLANK_API_TOKEN=... node scripts/gcp/migrate-northflank-secrets.mjs --list
//       prints the variable names as an HCL list, ready for secret_names in
//       infra/gcp/terraform.tfvars
//   NORTHFLANK_API_TOKEN=... node scripts/gcp/migrate-northflank-secrets.mjs [--dry-run] [--set KEY=VALUE ...]
//       writes a new version of each secret (terraform must have created the
//       containers first). Uses the active `gcloud` credentials.
//   NORTHFLANK_SECRET_ID=openach-runtime node scripts/gcp/migrate-northflank-secrets.mjs \
//       --only OPENACH_ENCRYPTION_KEY,OPENACH_VALIDATION_KEY
//       copies just those variables from another group (the OpenACH keys must
//       move verbatim: the encryption key cannot be rotated once data exists).
//       An entry may be VARIABLE=SECRET to store it under a different id, e.g.
//       --only FINERACT_DEFAULT_TENANTDB_PWD=FINERACT_DB_PASSWORD
//
// Env overrides: NORTHFLANK_PROJECT_ID (dlbtrust), NORTHFLANK_SECRET_ID
// (dlbtrust-runtime), GCP_PROJECT (dlb-treasury-management).

import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const LIST = argv.includes('--list');
const DRY_RUN = argv.includes('--dry-run');
// variable name → Secret Manager id
const ONLY = new Map(
  argv
    .flatMap((arg, index) => (arg === '--only' ? [argv[index + 1]] : []))
    .filter(Boolean)
    .flatMap((list) => list.split(','))
    .map((entry) => {
      const [source, target = source] = entry.split('=');
      return [source, target];
    }),
);
const OVERRIDES = Object.fromEntries(
  argv
    .flatMap((arg, index) => (arg === '--set' ? [argv[index + 1]] : []))
    .filter(Boolean)
    .map((pair) => {
      const separator = pair.indexOf('=');
      if (separator < 1) throw new Error(`--set expects KEY=VALUE, got "${pair}"`);
      return [pair.slice(0, separator), pair.slice(separator + 1)];
    }),
);

const NF_API = process.env.NORTHFLANK_API_HOST || 'https://api.northflank.com';
const NF_PROJECT = process.env.NORTHFLANK_PROJECT_ID || 'dlbtrust';
const NF_SECRET = process.env.NORTHFLANK_SECRET_ID || 'dlbtrust-runtime';
const GCP_PROJECT = process.env.GCP_PROJECT || 'dlb-treasury-management';

// Owned by the platform on Cloud Run: PORT is injected by Cloud Run, DATABASE_URL
// comes from the Cloud SQL resources, DB_SSL must stay unset over the connector
// socket, and the rest are set as plain env from var.runtime_environment
// (infra/gcp/variables.tf) — Cloud Run rejects an env name that is both plain
// and secret-backed.
const SKIP = new Set([
  'DATABASE_URL',
  'PORT',
  'DB_SSL',
  'NODE_ENV',
  'PAYMENT_HUB_MODE',
  'PAYMENT_HUB_LIVE',
  'MELIO_EXPORT_DIR',
  'COMPLIANCE_PROVIDER',
  'TRUST_MAKER_EMAIL',
  'TRUST_CHECKER_EMAIL',
  'MELIO_SOURCE_TYPE',
  'MELIO_SOURCE_ACCOUNT_ID',
  'MELIO_ALLOWED_SOURCE_ACCOUNTS',
  'TRUST_SEGREGATED_ACCOUNT_CODES',
  'TRUST_SIGNATURE_DOCUMENT_PATH',
]);
const SECRET_ID = /^[A-Za-z0-9_-]{1,255}$/;

async function readNorthflankGroup() {
  const token = process.env.NORTHFLANK_API_TOKEN;
  if (!token) throw new Error('NORTHFLANK_API_TOKEN is required');
  const response = await fetch(`${NF_API}/v1/projects/${NF_PROJECT}/secrets/${NF_SECRET}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`GET secret group → ${response.status} ${await response.text()}`);
  }
  const { data } = await response.json();
  return data.secrets?.variables || {};
}

function gcloud(args, input) {
  return execFileSync('gcloud', [...args, '--project', GCP_PROJECT, '--quiet'], {
    input,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
    .toString()
    .trim();
}

function secretExists(name) {
  try {
    gcloud(['secrets', 'describe', name, '--format', 'value(name)']);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const variables = { ...(await readNorthflankGroup()), ...OVERRIDES };
  const allNames = Object.keys(variables)
    .filter((name) => (ONLY.size ? ONLY.has(name) : !SKIP.has(name)))
    .sort();
  const absent = [...ONLY.keys()].filter((name) => !(name in variables));
  if (absent.length) throw new Error(`not in ${NF_SECRET}: ${absent.join(', ')}`);

  // Secret Manager rejects empty payloads and Cloud Run refuses to start when a
  // referenced version is missing; an empty variable is the same as unset to
  // the app, so leave those out of both the tfvars list and the migration.
  const empty = allNames.filter((name) => String(variables[name] ?? '') === '');
  if (empty.length) {
    console.error(`skipping ${empty.length} empty variables: ${empty.join(', ')}`);
  }
  const names = allNames.filter((name) => !empty.includes(name));

  const secretId = (name) => ONLY.get(name) ?? name;
  const invalid = names.filter((name) => !SECRET_ID.test(secretId(name)));
  if (invalid.length) {
    throw new Error(`not valid Secret Manager ids: ${invalid.join(', ')}`);
  }

  if (LIST) {
    console.log('secret_names = [');
    for (const name of names) console.log(`  "${secretId(name)}",`);
    console.log(']');
    return;
  }

  console.log(`${names.length} variables from ${NF_PROJECT}/${NF_SECRET} → Secret Manager (${GCP_PROJECT})`);
  const missing = [];
  for (const name of names) {
    const id = secretId(name);
    if (!secretExists(id)) {
      missing.push(id);
      continue;
    }
    if (DRY_RUN) {
      console.log(`  would add version: ${id}`);
      continue;
    }
    gcloud(['secrets', 'versions', 'add', id, '--data-file=-'], variables[name]);
    console.log(`  added version: ${id}`);
  }

  if (missing.length) {
    console.error(
      `\n${missing.length} secrets do not exist yet — add them to secret_names in infra/gcp/terraform.tfvars and apply:\n  ${missing.join('\n  ')}`,
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
