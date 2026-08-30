// Set individual variables in a Northflank secret group without dropping the
// rest of the group.
//
// `PATCH /secrets/<id>` replaces `secrets.variables` wholesale, so writing one
// variable with the raw api deletes every other variable in the group. This
// reads the group first, merges the requested keys and writes the result back.
//
// Usage:
//   NORTHFLANK_API_TOKEN=... node scripts/northflank/set-secrets.mjs \
//     --group dlbtrust-runtime [--dry-run] KEY=VALUE [KEY=VALUE ...]
//
// Values are never printed: only key names and the resulting variable count.

const NF_API = process.env.NORTHFLANK_API_HOST || 'https://api.northflank.com';
const PROJECT_ID = process.env.NORTHFLANK_PROJECT_ID || 'dlbtrust';

function parseArgv(argv) {
  const assignments = {};
  let group = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--group') {
      group = argv[i + 1];
      i += 1;
    } else {
      const split = arg.indexOf('=');
      if (split <= 0) throw new Error(`expected KEY=VALUE, got "${arg}"`);
      assignments[arg.slice(0, split)] = arg.slice(split + 1);
    }
  }
  return { group, dryRun, assignments };
}

async function nfRequest(method, path, body = null) {
  const response = await fetch(`${NF_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NORTHFLANK_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function main() {
  const { group, dryRun, assignments } = parseArgv(process.argv.slice(2));
  if (!process.env.NORTHFLANK_API_TOKEN) throw new Error('NORTHFLANK_API_TOKEN is required');
  if (!group) throw new Error('--group <secret group id> is required');
  const keys = Object.keys(assignments);
  if (keys.length === 0) throw new Error('no KEY=VALUE assignments given');

  const path = `/v1/projects/${PROJECT_ID}/secrets/${group}`;
  const { data } = await nfRequest('GET', path);
  const existing = data.secrets?.variables || {};
  const variables = { ...existing, ...assignments };

  console.log(`group ${group}: ${Object.keys(existing).length} variables`);
  for (const key of keys.sort()) {
    console.log(`  ${key in existing ? 'update' : 'add'} ${key}`);
  }
  console.log(`result: ${Object.keys(variables).length} variables`);
  if (dryRun) {
    console.log('dry run: nothing written');
    return;
  }

  await nfRequest('PATCH', path, {
    name: data.name,
    description: data.description,
    secretType: data.secretType,
    priority: data.priority,
    secrets: { variables },
  });
  console.log(`wrote secret group ${group}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
