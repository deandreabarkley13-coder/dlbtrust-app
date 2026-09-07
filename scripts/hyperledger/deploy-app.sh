#!/usr/bin/env bash
# Run the DLB Trust API on the same host as the Fabric + FireFly stacks that
# bootstrap-stack.sh stood up, so the app reaches fabconnect and FireFly over
# loopback and nothing on the ledger side is ever exposed to the internet:
#
#   - Node 22 (the Dockerfile's runtime) and PostgreSQL for the settlement and
#     notarization tables
#   - a systemd service running server/server-3002.js on :3002 (keep that port
#     closed in the cloud firewall) with an env file assembled from the
#     bootstrap's ~/.env.hyperledger
#   - Caddy on :443 as the TLS front door, which never forwards the FireFly
#     webhook (FireFly reaches it over the docker bridge only)
#   - the FireFly webhook subscription pointed at this service
#
# Idempotent: re-run after updating the checkout (git pull / rsync) to install
# the new dependencies and restart; generated secrets are kept.
#
#   sudo -v && ./scripts/hyperledger/deploy-app.sh
#
# Tunables (env):
#   APP_DOMAIN        DNS name for a Let's Encrypt certificate; unset → Caddy's
#                     internal CA on the host's IP (browsers warn, curl -k works)
#   APP_PORT          port the API listens on                      (3002)
#   APP_USER          system user the service runs as              ($USER)
#   ENV_IN            bootstrap output to read FABRIC_*/FIREFLY_*   (~/.env.hyperledger)
#   ENV_OUT           env file the service loads                   (/etc/dlbtrust/app.env)
#                     regenerated on every run; operator-managed settings
#                     (thirdweb, Fineract, live gates, ...) go in the sibling
#                     app.local.env, which is loaded after it and never rewritten
#   PG_DB / PG_USER   settlement database and role                  (dlbtrust / dlbtrust)
#   NODE_MAJOR        Node release line                            (22)
set -euo pipefail

APP_PORT="${APP_PORT:-3002}"
APP_USER="${APP_USER:-$USER}"
APP_DOMAIN="${APP_DOMAIN:-}"
ENV_IN="${ENV_IN:-$HOME/.env.hyperledger}"
ENV_OUT="${ENV_OUT:-/etc/dlbtrust/app.env}"
ENV_LOCAL="$(dirname "$ENV_OUT")/app.local.env"
PG_DB="${PG_DB:-dlbtrust}"
PG_USER="${PG_USER:-dlbtrust}"
NODE_MAJOR="${NODE_MAJOR:-22}"
SERVICE=dlbtrust-app

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1; }
env_get() { # env_get <file> <key>  (empty when the file or key is absent)
  [ -r "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | tail -1
}
wait_for() { # wait_for <url> <label> [attempts]
  local url=$1 label=$2 attempts=${3:-30}
  for _ in $(seq "$attempts"); do
    curl -sfk "$url" >/dev/null 2>&1 && return 0
    sleep 2
  done
  echo "timed out waiting for $label at $url" >&2
  return 1
}

[ -f "$ENV_IN" ] || { echo "$ENV_IN not found — run bootstrap-stack.sh first" >&2; exit 1; }

# ---------------------------------------------------------------- toolchain
log "toolchain"
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq curl ca-certificates gnupg python3 make g++ sqlite3 postgresql postgresql-client >/dev/null

if ! need node || [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi
node -v

if ! need caddy; then
  sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq caddy >/dev/null
fi
caddy version

# ---------------------------------------------------------------- database
log "postgres role and database"
sudo systemctl enable --now postgresql >/dev/null
sudo install -d -m 750 -o root -g "$APP_USER" "$(dirname "$ENV_OUT")"

PG_PASSWORD="$(env_get "$ENV_OUT" DATABASE_URL | sed -n 's#^postgres://[^:]*:\([^@]*\)@.*#\1#p')"
if [ -z "$PG_PASSWORD" ]; then
  PG_PASSWORD="$(openssl rand -hex 24)"
fi
(cd / && sudo -u postgres psql -v ON_ERROR_STOP=1 -qtA) <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$PG_USER') THEN
    CREATE ROLE "$PG_USER" LOGIN PASSWORD '$PG_PASSWORD';
  ELSE
    ALTER ROLE "$PG_USER" WITH LOGIN PASSWORD '$PG_PASSWORD';
  END IF;
END \$\$;
SELECT 'CREATE DATABASE "$PG_DB" OWNER "$PG_USER"' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$PG_DB') \gexec
SQL
DATABASE_URL="postgres://$PG_USER:$PG_PASSWORD@127.0.0.1:5432/$PG_DB"

# the same schema the dev environment seeds; every statement is IF NOT EXISTS /
# WHERE NOT EXISTS, so re-running is a no-op
log "schema"
for migration in migrate-postgres-full migrate-docs-accounting migrate-ofx; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/server/scripts/$migration.sql"
done

# ---------------------------------------------------------------- app
log "dependencies"
cd "$REPO_ROOT"
npm ci --omit=dev --no-audit --no-fund >/dev/null
mkdir -p data/journal data/backups data/shutdown-state logs

# ---------------------------------------------------------------- env file
log "service environment → $ENV_OUT"
ADMIN_SECRET_TOKEN="$(env_get "$ENV_OUT" ADMIN_SECRET_TOKEN)"; [ -n "$ADMIN_SECRET_TOKEN" ] || ADMIN_SECRET_TOKEN="$(openssl rand -hex 32)"
JWT_SECRET="$(env_get "$ENV_OUT" JWT_SECRET)";                 [ -n "$JWT_SECRET" ]         || JWT_SECRET="$(openssl rand -hex 48)"
PAYMENT_DATA_ENCRYPTION_KEY="$(env_get "$ENV_OUT" PAYMENT_DATA_ENCRYPTION_KEY)"; [ -n "$PAYMENT_DATA_ENCRYPTION_KEY" ] || PAYMENT_DATA_ENCRYPTION_KEY="$(openssl rand -hex 32)"
DOCKER_BRIDGE_IP="$(ip -4 -o addr show docker0 2>/dev/null | awk '{print $4}' | cut -d/ -f1)"
WEBHOOK_URL="http://${DOCKER_BRIDGE_IP:-172.17.0.1}:$APP_PORT/api/hyperledger/firefly/webhook"

{
  echo "# generated by scripts/hyperledger/deploy-app.sh on $(date -u +%FT%TZ)"
  echo "NODE_ENV=production"
  echo "PORT=$APP_PORT"
  echo "DATABASE_URL=$DATABASE_URL"
  echo "ADMIN_SECRET_TOKEN=$ADMIN_SECRET_TOKEN"
  echo "JWT_SECRET=$JWT_SECRET"
  echo "PAYMENT_DATA_ENCRYPTION_KEY=$PAYMENT_DATA_ENCRYPTION_KEY"
  echo "PAYMENT_HUB_MODE=disabled"
  echo "PAYMENT_HUB_LIVE=false"
  echo "COMPLIANCE_PROVIDER=opensanctions"
  echo "TRUST_SEGREGATED_ACCOUNT_CODES=1210"
  echo "FIREFLY_WEBHOOK_URL=$WEBHOOK_URL"
  echo "FIREFLY_SOURCE_TYPE=trust"
  echo "FIREFLY_SOURCE_ACCOUNT_ID=1000"
  echo
  echo "# from $ENV_IN"
  grep -E '^(FABRIC|FIREFLY)_[A-Z_]+=' "$ENV_IN"
} | sudo tee "$ENV_OUT.tmp" >/dev/null
sudo chown root:"$APP_USER" "$ENV_OUT.tmp" && sudo chmod 640 "$ENV_OUT.tmp" && sudo mv "$ENV_OUT.tmp" "$ENV_OUT"
if ! sudo test -e "$ENV_LOCAL"; then
  printf '# operator-managed settings; loaded after %s and never rewritten by deploy-app.sh\n' "$ENV_OUT" \
    | sudo tee "$ENV_LOCAL" >/dev/null
  sudo chown root:"$APP_USER" "$ENV_LOCAL" && sudo chmod 640 "$ENV_LOCAL"
fi

# ---------------------------------------------------------------- systemd
log "systemd unit"
sudo tee /etc/systemd/system/$SERVICE.service >/dev/null <<UNIT
[Unit]
Description=DLB Trust API (server/server-3002.js)
After=network-online.target postgresql.service docker.service
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$REPO_ROOT
EnvironmentFile=$ENV_OUT
EnvironmentFile=-$ENV_LOCAL
ExecStart=$(command -v node) server/server-3002.js
Restart=always
RestartSec=3
KillSignal=SIGINT
TimeoutStopSec=15
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE" >/dev/null
sudo systemctl restart "$SERVICE"
wait_for "http://127.0.0.1:$APP_PORT/api/health" "the API"

# ---------------------------------------------------------------- caddy
log "caddy (TLS front door)"
PUBLIC_IP="$(curl -sf -H 'Metadata-Flavor: Google' http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip 2>/dev/null || true)"
LOCAL_IP="$(hostname -I | awk '{print $1}')"
if [ -n "$APP_DOMAIN" ]; then
  SITE="$APP_DOMAIN"; TLS=""
else
  # no DNS name: certificates from Caddy's own CA for every address a client
  # can reach us on (SNI-less IP connections are matched by the local address)
  SITE="https://127.0.0.1, https://$LOCAL_IP${PUBLIC_IP:+, https://$PUBLIC_IP}"; TLS="tls internal"
fi
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
{
	admin off
}

$SITE {
	$TLS
	encode gzip
	@webhook path /api/hyperledger/firefly/webhook
	respond @webhook 404
	reverse_proxy 127.0.0.1:$APP_PORT
}
CADDY
sudo caddy validate --config /etc/caddy/Caddyfile >/dev/null
sudo systemctl enable caddy >/dev/null
sudo systemctl restart caddy
wait_for "https://127.0.0.1/api/health" "caddy"

# ---------------------------------------------------------------- firefly webhook
log "firefly webhook subscription → $WEBHOOK_URL"
curl -sf -X POST "http://127.0.0.1:$APP_PORT/api/hyperledger/firefly/subscription" \
  -H "x-admin-token: $ADMIN_SECRET_TOKEN" -H 'Content-Type: application/json' -d '{}' >/dev/null \
  || echo "subscription not registered (FireFly not live or unreachable); rerun once it is" >&2

# ---------------------------------------------------------------- summary
log "deployed"
PUBLIC_IP="${PUBLIC_IP:-$LOCAL_IP}"
cat <<EOF
service     systemctl status $SERVICE   |  journalctl -u $SERVICE -f
env         $ENV_OUT  (ADMIN_SECRET_TOKEN for x-admin-token lives here; never copy it into the repo)
            $ENV_LOCAL  (operator settings, e.g. THIRDWEB_*; survives redeploys)
url         https://${APP_DOMAIN:-$PUBLIC_IP}/api/hyperledger/readiness
readiness   curl -sk https://${APP_DOMAIN:-$PUBLIC_IP}/api/hyperledger/readiness | jq .data.firefly.mode
wire        set -a && . $ENV_OUT && . $ENV_LOCAL && set +a && npm run trust:hyperledger -- --live --reference <ref> --transfer <usd>
EOF
[ -n "$APP_DOMAIN" ] || echo "TLS uses Caddy's internal CA — set APP_DOMAIN=<dns name> and rerun for a public certificate"
echo "open tcp/443 to this host in the cloud firewall; keep $APP_PORT, 5xxx and 7xxx closed"
