#!/usr/bin/env bash
# Stand up the Hyperledger side of the DLB Trust wire on a single Linux host:
#
#   - a Fabric network (CA, orderer, peer) fronted by fabconnect, with the
#     trustnotary chaincode committed on its channel
#   - a two-member FireFly stack on a private Ethereum chain with an ERC-20
#     settlement pool, minted to the trust org
#
# then print the FABRIC_* / FIREFLY_* block the app needs. Every step is
# idempotent: re-running on a host that already has the stacks only reprints
# the configuration.
#
#   sudo -v && ./scripts/hyperledger/bootstrap-stack.sh
#
# Tunables (env):
#   FAB_STACK / ETH_STACK      stack names            (dlbfab / dlbeth)
#   FAB_PORT  / ETH_PORT       FireFly core base port (5000 / 7000)
#   FAB_SVC   / ETH_SVC        services base port     (5100 / 7100)
#   POOL_NAME / POOL_SYMBOL    settlement pool        (dlbtrust-settlement-usd / DLBUSD)
#   POOL_MINT                  initial mint, whole tokens (1000000)
#   FF_VERSION / GO_VERSION    toolchain versions     (1.5.0 / 1.23.6)
#   ENV_OUT                    where to write the env block (~/.env.hyperledger)
set -euo pipefail

FAB_STACK="${FAB_STACK:-dlbfab}"
ETH_STACK="${ETH_STACK:-dlbeth}"
FAB_PORT="${FAB_PORT:-5000}"
FAB_SVC="${FAB_SVC:-5100}"
ETH_PORT="${ETH_PORT:-7000}"
ETH_SVC="${ETH_SVC:-7100}"
POOL_NAME="${POOL_NAME:-dlbtrust-settlement-usd}"
POOL_SYMBOL="${POOL_SYMBOL:-DLBUSD}"
POOL_MINT="${POOL_MINT:-1000000}"
FF_VERSION="${FF_VERSION:-1.5.0}"
GO_VERSION="${GO_VERSION:-1.23.6}"
ENV_OUT="${ENV_OUT:-$HOME/.env.hyperledger}"
CHAINCODE_NAME="trustnotary"
CHAINCODE_VERSION="1.0"
CHANNEL="firefly"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHAINCODE_SRC="$REPO_ROOT/chaincode/$CHAINCODE_NAME"
WORK="${WORK:-$HOME/.dlbtrust-hyperledger}"
mkdir -p "$WORK"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1; }
api() { # api <port> <method> <path> [json]
  local port=$1 method=$2 path=$3 body=${4:-}
  if [ -n "$body" ]; then
    curl -sf -X "$method" -H 'Content-Type: application/json' "http://localhost:$port/api/v1$path" -d "$body"
  else
    curl -sf -X "$method" "http://localhost:$port/api/v1$path"
  fi
}
wait_for() { # wait_for <url> <label> [attempts]
  local url=$1 label=$2 attempts=${3:-90}
  for _ in $(seq "$attempts"); do
    curl -sf "$url" >/dev/null 2>&1 && return 0
    sleep 5
  done
  echo "timed out waiting for $label at $url" >&2
  return 1
}

# ---------------------------------------------------------------- toolchain
log "toolchain"
if ! need docker; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER" || true
fi
docker compose version >/dev/null 2>&1 || { echo "docker compose plugin is required" >&2; exit 1; }
if ! docker info >/dev/null 2>&1; then
  echo "docker is installed but this user cannot reach the daemon; log out/in (docker group) or run with sudo" >&2
  exit 1
fi

if ! need go || ! go version | grep -q "go$GO_VERSION"; then
  curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o "$WORK/go.tgz"
  sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf "$WORK/go.tgz"
fi
export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"

if ! need ff || ! ff version 2>/dev/null | grep -q "$FF_VERSION"; then
  curl -fsSL "https://github.com/hyperledger/firefly-cli/releases/download/v${FF_VERSION}/cli_${FF_VERSION}_Linux_x86_64.tar.gz" \
    | tar -xz -C "$WORK" ff
  sudo install -m 0755 "$WORK/ff" /usr/local/bin/ff
fi
ff version

# ---------------------------------------------------------------- chaincode
log "package $CHAINCODE_NAME $CHAINCODE_VERSION"
PKG="$WORK/$CHAINCODE_NAME-$CHAINCODE_VERSION.tar.gz"
if [ ! -f "$PKG" ]; then
  BUILD="$WORK/cc-build"; rm -rf "$BUILD"; mkdir -p "$BUILD/src"
  cp -R "$CHAINCODE_SRC"/. "$BUILD/src/"
  (cd "$BUILD/src" && go mod vendor && go build -o /dev/null .)
  # Fabric lifecycle package: metadata.json + code.tar.gz whose root is src/.
  printf '{"path":"","type":"golang","label":"%s_%s"}' "$CHAINCODE_NAME" "$CHAINCODE_VERSION" > "$BUILD/metadata.json"
  tar -czf "$BUILD/code.tar.gz" -C "$BUILD" src
  tar -czf "$PKG" -C "$BUILD" metadata.json code.tar.gz
fi
ls -l "$PKG"

# ---------------------------------------------------------------- fabric stack
log "fabric stack $FAB_STACK (fabconnect on :$((FAB_SVC + 2)))"
if [ ! -d "$HOME/.firefly/stacks/$FAB_STACK" ]; then
  ff init fabric "$FAB_STACK" 2 -p "$FAB_PORT" -s "$FAB_SVC" --sandbox-enabled=false
fi
curl -sf "http://localhost:$FAB_PORT/api/v1/status" >/dev/null 2>&1 || ff start "$FAB_STACK" --no-rollback
wait_for "http://localhost:$FAB_PORT/api/v1/status" "FireFly on Fabric"
FABCONNECT_PORT=$((FAB_SVC + 2))
wait_for "http://localhost:$FABCONNECT_PORT/identities" "fabconnect"

FAB_SIGNER="$(python3 -c "import json;print(json.load(open('$HOME/.firefly/stacks/$FAB_STACK/stack.json'))['members'][0]['orgName'])")"

if ! curl -sf -X POST "http://localhost:$FABCONNECT_PORT/query" -H 'Content-Type: application/json' \
    -d "{\"headers\":{\"signer\":\"$FAB_SIGNER\",\"channel\":\"$CHANNEL\",\"chaincode\":\"$CHAINCODE_NAME\"},\"func\":\"GetRecord\",\"args\":[\"probe\",\"probe\"],\"strongread\":true}" >/dev/null 2>&1; then
  log "deploy $CHAINCODE_NAME to channel $CHANNEL"
  ff deploy fabric "$FAB_STACK" "$PKG" "$CHANNEL" "$CHAINCODE_NAME" "$CHAINCODE_VERSION"
fi

# ---------------------------------------------------------------- firefly (ethereum) stack
log "firefly settlement stack $ETH_STACK (core on :$ETH_PORT)"
if [ ! -d "$HOME/.firefly/stacks/$ETH_STACK" ]; then
  ff init ethereum "$ETH_STACK" 2 -p "$ETH_PORT" -s "$ETH_SVC" --sandbox-enabled=false -t erc20_erc721
fi
curl -sf "http://localhost:$ETH_PORT/api/v1/status" >/dev/null 2>&1 || ff start "$ETH_STACK" --no-rollback
wait_for "http://localhost:$ETH_PORT/api/v1/status" "FireFly member 0"
wait_for "http://localhost:$((ETH_PORT + 1))/api/v1/status" "FireFly member 1"

# Both orgs have to be registered before either can see the other.
for _ in $(seq 60); do
  ORGS="$(api "$ETH_PORT" GET /network/organizations || echo '[]')"
  [ "$(printf '%s' "$ORGS" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))')" -ge 2 ] && break
  sleep 5
done

TRUST_DID="$(api "$ETH_PORT" GET /status | python3 -c 'import json,sys;print(json.load(sys.stdin)["org"]["did"])')"
COUNTERPARTY_DID="$(printf '%s' "$ORGS" | python3 -c "import json,sys;print(next(o['did'] for o in json.load(sys.stdin) if o['did']!='$TRUST_DID'))")"

log "token pool $POOL_NAME"
POOL_ID="$(api "$ETH_PORT" GET "/namespaces/default/tokens/pools?name=$POOL_NAME" | python3 -c 'import json,sys;p=json.load(sys.stdin);print(p[0]["id"] if p else "")')"
if [ -z "$POOL_ID" ]; then
  POOL_ID="$(api "$ETH_PORT" POST '/namespaces/default/tokens/pools?confirm=true' \
    "{\"name\":\"$POOL_NAME\",\"symbol\":\"$POOL_SYMBOL\",\"type\":\"fungible\"}" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')"
  # Pool creation is confirmed on member 0, but member 1 learns of it via broadcast.
  for _ in $(seq 30); do
    api "$((ETH_PORT + 1))" GET "/namespaces/default/tokens/pools/$POOL_ID" >/dev/null 2>&1 && break
    sleep 3
  done
fi
POOL_DECIMALS="$(api "$ETH_PORT" GET "/namespaces/default/tokens/pools/$POOL_ID" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("decimals",18))')"

# FireFly amounts are in base units, so the mint has to be scaled by the pool's decimals.
TRUST_BALANCE="$(api "$ETH_PORT" GET "/namespaces/default/tokens/balances?pool=$POOL_ID" | python3 -c 'import json,sys;b=json.load(sys.stdin);print(sum(int(x["balance"]) for x in b))')"
MINT_SHORTFALL="$(python3 -c "print(max(0, $POOL_MINT * 10**$POOL_DECIMALS - $TRUST_BALANCE))")"
if [ "$MINT_SHORTFALL" != "0" ]; then
  log "mint $POOL_MINT $POOL_SYMBOL ($MINT_SHORTFALL base units) to the trust org"
  api "$ETH_PORT" POST '/namespaces/default/tokens/mint?confirm=true' \
    "{\"pool\":\"$POOL_ID\",\"amount\":\"$MINT_SHORTFALL\"}" >/dev/null
fi

# ff-managed containers default to no restart policy; make both stacks survive a host reboot.
docker ps -q --filter "name=${FAB_STACK}_" --filter "name=${ETH_STACK}_" | xargs -r docker update --restart unless-stopped >/dev/null

# ---------------------------------------------------------------- output
log "writing $ENV_OUT"
cat > "$ENV_OUT" <<EOF
# Generated by scripts/hyperledger/bootstrap-stack.sh on $(hostname) at $(date -u +%FT%TZ)
FABRIC_CONNECT_URL=http://localhost:$FABCONNECT_PORT
FABRIC_CHANNEL=$CHANNEL
FABRIC_CHAINCODE=$CHAINCODE_NAME
FABRIC_SIGNER=$FAB_SIGNER
FABRIC_LEDGER_LIVE=true

FIREFLY_API_URL=http://localhost:$ETH_PORT
FIREFLY_NAMESPACE=default
FIREFLY_TOKEN_POOL=$POOL_NAME
FIREFLY_TOKEN_DECIMALS=$POOL_DECIMALS
FIREFLY_COUNTERPARTY_ORG=$COUNTERPARTY_DID
FIREFLY_TOPIC=trust-settlement
FIREFLY_SUBSCRIPTION_NAME=dlbtrust-settlement
FIREFLY_LIVE=true
EOF
chmod 600 "$ENV_OUT"
cat "$ENV_OUT"

cat <<EOF

Trust org:        $TRUST_DID
Counterparty org: $COUNTERPARTY_DID
Pool id:          $POOL_ID

Next, from the app checkout:
  set -a; . $ENV_OUT; set +a
  node server/scripts/hyperledgerFabricFireflyWire.js --live
EOF
