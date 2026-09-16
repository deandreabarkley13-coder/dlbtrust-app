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
//
// Env overrides: NORTHFLANK_PROJECT_ID (dlbtrust), NORTHFLANK_SECRET_ID
// (dlbtrust-runtime), GCP_PROJECT (dlb-treasury-management).

import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const LIST = argv.includes('--list');
const DRY_RUN = argv.includes('--dry-run');
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

// Owned by the platform on Cloud Run: PORT is injected by Cloud Run, NODE_ENV
// and the non-secret runtime variables come from terraform, DATABASE_URL from
// the Cloud SQL resources.
const SKIP = new Set(['DATABASE_URL', 'PORT', 'NODE_ENV']);
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
  const names = Object.keys(variables)
    .filter((name) => !SKIP.has(name))
    .sort();

  const invalid = names.filter((name) => !SECRET_ID.test(name));
  if (invalid.length) {
    throw new Error(`not valid Secret Manager ids: ${invalid.join(', ')}`);
  }

  if (LIST) {
    console.log('secret_names = [');
    for (const name of names) console.log(`  "${name}",`);
    console.log(']');
    return;
  }

  console.log(`${names.length} variables from ${NF_PROJECT}/${NF_SECRET} → Secret Manager (${GCP_PROJECT})`);
  const missing = [];
  for (const name of names) {
    if (!secretExists(name)) {
      missing.push(name);
      continue;
    }
    if (DRY_RUN) {
      console.log(`  would add version: ${name}`);
      continue;
    }
    gcloud(['secrets', 'versions', 'add', name, '--data-file=-'], variables[name]);
    console.log(`  added version: ${name}`);
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
