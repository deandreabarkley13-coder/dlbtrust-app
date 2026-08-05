#!/bin/bash
set -e

DATA_DIR=${DATA_DIR:-/data}
BITCOIN_DIR=${BITCOIN_DIR:-$DATA_DIR/bitcoin}
NBXPLORER_DIR=${NBXPLORER_DIR:-$DATA_DIR/nbxplorer}
BTCPAY_DIR=${BTCPAY_DIR:-$DATA_DIR/btcpay}

mkdir -p "$BITCOIN_DIR" "$NBXPLORER_DIR" "$BTCPAY_DIR" /var/log/supervisor

# Bitcoin RPC credentials must be provided as Fly secrets; do not auto-generate
BTC_RPCUSER=${BTC_RPCUSER:-btcrpc}
if [ -z "$BTC_RPCPASSWORD" ]; then
  echo "ERROR: BTC_RPCPASSWORD is required as a Fly secret" >&2
  exit 1
fi

# Write bitcoin.conf for a pruned mainnet node
# RPC and P2P are bound to loopback only; internal consumers use 127.0.0.1.
cat > "$BITCOIN_DIR/bitcoin.conf" <<EOF
[main]
prune=5120
dbcache=256
maxmempool=128
maxconnections=16
listen=1
bind=127.0.0.1
server=1
txindex=0
disablewallet=1
blockfilterindex=0
rpcuser=$BTC_RPCUSER
rpcpassword=$BTC_RPCPASSWORD
rpcbind=127.0.0.1
rpcallowip=127.0.0.1/32
rpcworkqueue=128
fallbackfee=0.0002
EOF

# Postgres connection strings can be supplied directly as Fly secrets, or parsed from DATABASE_URL.
# Using BTCPAY_POSTGRES / NBXPLORER_POSTGRES avoids fragile URL parsing of passwords with special characters.
parse_postgres_url() {
  local url="$1"
  local db_name="$2"
  local rest="${url#postgres://}"
  local userpass="${rest%%@*}"
  local hostportdb="${rest#*@}"
  local user="${userpass%%:*}"
  local pass="${userpass#*:}"
  local hostport="${hostportdb%%/*}"
  local host="${hostport%%:*}"
  local port="${hostport##*:}"
  local sslmode=""
  [ "$host" = "$port" ] && port=5432
  local query="${hostportdb#*/}"
  if [[ "$query" == *"?"* ]]; then
    query="${query#*?}"
    if [[ "$query" == *"sslmode=disable"* || "$query" == *"sslmode=Disable"* ]]; then
      sslmode="Disable"
    fi
  fi
  [ -z "$sslmode" ] && sslmode="Require"
  echo "User ID=$user;Password=$pass;Host=$host;Port=$port;Database=$db_name;SSL Mode=$sslmode;Application Name=$db_name"
}

if [ -z "$NBXPLORER_POSTGRES" ] || [ -z "$BTCPAY_POSTGRES" ]; then
  if [ -z "$DATABASE_URL" ]; then
    echo "ERROR: DATABASE_URL (or BTCPAY_POSTGRES and NBXPLORER_POSTGRES) is required" >&2
    exit 1
  fi
  NBXPLORER_POSTGRES=${NBXPLORER_POSTGRES:-$(parse_postgres_url "$DATABASE_URL" nbxplorer)}
  BTCPAY_POSTGRES=${BTCPAY_POSTGRES:-$(parse_postgres_url "$DATABASE_URL" btcpay)}
fi
BTCPAY_EXPLORERPOSTGRES=${BTCPAY_EXPLORERPOSTGRES:-$NBXPLORER_POSTGRES}

# Export for supervisor child processes
export NBXPLORER_NETWORK=mainnet
export NBXPLORER_CHAINS=btc
export NBXPLORER_BIND=0.0.0.0:32838
export NBXPLORER_POSTGRES
export NBXPLORER_TRIMEVENTS=10000
export NBXPLORER_SIGNALFILESDIR=/data/nbxplorer
export NBXPLORER_BTCRPCURL=http://127.0.0.1:8332/
export NBXPLORER_BTCRPCUSER=$BTC_RPCUSER
export NBXPLORER_BTCRPCPASSWORD=$BTC_RPCPASSWORD
export NBXPLORER_BTCNODEENDPOINT=127.0.0.1:8333

export BTCPAY_NETWORK=mainnet
export BTCPAY_CHAINS=btc
export BTCPAY_NODEFAULTCHAIN=true
export BTCPAY_BIND=0.0.0.0:23000
export BTCPAY_PORT=23000
export BTCPAY_ROOTPATH=/
export BTCPAY_POSTGRES
export BTCPAY_EXPLORERPOSTGRES
export BTCPAY_BTCEXPLORERURL=http://127.0.0.1:32838/
export BTCPAY_UPDATEURL=https://api.github.com/repos/btcpayserver/btcpayserver/releases/latest
export BTCPAY_DOCKERDEPLOYMENT=true
export BTCPAY_EXTERNALURL=${BTCPAY_EXTERNALURL:-https://dlbtrust-btcpay.fly.dev/}
export BTCPAY_DATADIR=/data/btcpay

# Make sure NBXplorer config dir exists so it can write settings
mkdir -p /root/.nbxplorer

echo "[start.sh] BTCPay data dir: $BTCPAY_DIR"
echo "[start.sh] Bitcoin data dir: $BITCOIN_DIR"
echo "[start.sh] NBXplorer data dir: $NBXPLORER_DIR"
echo "[start.sh] External URL: $BTCPAY_EXTERNALURL"

exec supervisord -c /etc/supervisor/conf.d/supervisord.conf
