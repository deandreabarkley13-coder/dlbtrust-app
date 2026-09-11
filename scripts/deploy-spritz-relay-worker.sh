#!/usr/bin/env bash
# Deploys scripts/spritz-relay-worker.js to Cloudflare Workers via the REST API.
# Env: CLOUDFLARE_API_TOKEN (Workers Scripts: Edit), RELAY_AUTH (shared secret the
# app sends as SPRITZ_PROXY_AUTH), optional WORKER_NAME (default dlbtrust-spritz-relay).
# Prints the workers.dev URL to use as SPRITZ_API_BASE_URL.
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?}" "${RELAY_AUTH:?}"
WORKER_NAME="${WORKER_NAME:-dlbtrust-spritz-relay}"
API=https://api.cloudflare.com/client/v4
H=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
here="$(cd "$(dirname "$0")" && pwd)"

ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-$(curl -sf "${H[@]}" "$API/accounts" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).result[0].id))')}"

META=$(printf '{"main_module":"worker.js","compatibility_date":"2025-01-01","bindings":[{"type":"secret_text","name":"RELAY_AUTH","text":%s}]}' "$(node -e 'console.log(JSON.stringify(process.env.RELAY_AUTH))')")
curl -sf -X PUT "${H[@]}" "$API/accounts/$ACCOUNT_ID/workers/scripts/$WORKER_NAME" \
  -F "metadata=$META;type=application/json" \
  -F "worker.js=@$here/spritz-relay-worker.js;filename=worker.js;type=application/javascript+module" >/dev/null

curl -sf -X POST "${H[@]}" -H 'Content-Type: application/json' -d '{"enabled":true}' \
  "$API/accounts/$ACCOUNT_ID/workers/scripts/$WORKER_NAME/subdomain" >/dev/null

SUB=$(curl -sf "${H[@]}" "$API/accounts/$ACCOUNT_ID/workers/subdomain" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).result.subdomain))')
echo "https://$WORKER_NAME.$SUB.workers.dev"
