#!/bin/bash
# One-shot bootstrap of an OpenACH installation: originator, ODFI branch,
# settlement account and the credit/debit payment types the trust's ACH rail
# originates against. Run it inside the running Northflank service (see
# docs/OPENACH_NORTHFLANK.md); the schema itself is installed by the entrypoint.
#
# Required:
#   OPENACH_ADMIN_LOGIN, OPENACH_ADMIN_PASSWORD, OPENACH_ADMIN_EMAIL
#   OPENACH_ORIGINATOR_NAME       company name on the ACH batch header (max 16)
#   OPENACH_ORIGINATOR_ID         company identification (EIN, 10 chars)
#   OPENACH_ODFI_ROUTING          9-digit routing number of the ODFI
#   OPENACH_SETTLEMENT_ACCOUNT    settlement account number at the ODFI
# Optional:
#   OPENACH_ODFI_NAME / _CITY / _STATE  seed the FedACH directory entry when the
#       full directory has not been imported (yiic fedachupdate reloadall)
#
# Re-running is safe: each step is skipped when it already exists.
set -euo pipefail

ROOT="${OPENACH_ROOT:-/var/www/openach}"
cd "$ROOT"

require() {
  for var in "$@"; do
    if [ -z "${!var:-}" ]; then
      echo "openach-bootstrap: $var is required" >&2
      exit 1
    fi
  done
}
require OPENACH_ADMIN_LOGIN OPENACH_ADMIN_PASSWORD OPENACH_ADMIN_EMAIL \
        OPENACH_ORIGINATOR_NAME OPENACH_ORIGINATOR_ID OPENACH_ODFI_ROUTING \
        OPENACH_SETTLEMENT_ACCOUNT

# The company name field of a NACHA batch header is 16 characters, and OpenACH
# validates the originator against that rather than truncating it.
if [ "${#OPENACH_ORIGINATOR_NAME}" -gt 16 ]; then
  echo "openach-bootstrap: OPENACH_ORIGINATOR_NAME must be 16 characters or fewer (got ${#OPENACH_ORIGINATOR_NAME})" >&2
  exit 1
fi

DB_URL="${OPENACH_DATABASE_URL:-${DATABASE_URL:-}}"
require DB_URL

sql() { psql -qtAX -v ON_ERROR_STOP=1 "$DB_URL" -c "$1"; }

routing="$OPENACH_ODFI_ROUTING"
if [ "$(sql "SELECT count(*) FROM fedach WHERE fedach_routing_number = '$routing'")" = "0" ]; then
  echo "openach-bootstrap: seeding FedACH directory entry for $routing"
  sql "INSERT INTO fedach VALUES (
        '$routing', 'O', '$routing', '1', '000000', '$routing',
        left('${OPENACH_ODFI_NAME:-Originating Institution}', 36),
        '', '${OPENACH_ODFI_CITY:-Unknown}', '${OPENACH_ODFI_STATE:-US}',
        '00000', '0000', '0000000000', '1', '1')" >/dev/null
fi

user_id="$(sql "SELECT user_id FROM \"user\" WHERE user_login = '$OPENACH_ADMIN_LOGIN'")"
if [ -z "$user_id" ]; then
  echo "openach-bootstrap: creating user $OPENACH_ADMIN_LOGIN"
  php protected/yiic user create \
    --user_login="$OPENACH_ADMIN_LOGIN" \
    --user_password="$OPENACH_ADMIN_PASSWORD" \
    --user_email_address="$OPENACH_ADMIN_EMAIL" \
    --user_first_name="${OPENACH_ADMIN_FIRST_NAME:-DLB}" \
    --user_last_name="${OPENACH_ADMIN_LAST_NAME:-Trust}"
  user_id="$(sql "SELECT user_id FROM \"user\" WHERE user_login = '$OPENACH_ADMIN_LOGIN'")"
fi
[ -n "$user_id" ] || { echo "openach-bootstrap: user was not created" >&2; exit 1; }

originator_info_id="$(sql "SELECT oi.originator_info_id
  FROM originator_info oi
  JOIN originator o ON o.originator_id = oi.originator_info_originator_id
  WHERE o.originator_user_id = '$user_id'
  ORDER BY oi.originator_info_id LIMIT 1")"

if [ -z "$originator_info_id" ]; then
  echo "openach-bootstrap: setting up originator $OPENACH_ORIGINATOR_NAME"
  php protected/yiic user setup \
    --user_id="$user_id" \
    --name="$OPENACH_ORIGINATOR_NAME" \
    --identification="$OPENACH_ORIGINATOR_ID" \
    --routing_number="$routing" \
    --account_number="$OPENACH_SETTLEMENT_ACCOUNT" \
    --plugin="${OPENACH_ODFI_PLUGIN:-Manual}"
  originator_info_id="$(sql "SELECT oi.originator_info_id
    FROM originator_info oi
    JOIN originator o ON o.originator_id = oi.originator_info_originator_id
    WHERE o.originator_user_id = '$user_id'
    ORDER BY oi.originator_info_id LIMIT 1")"
fi
[ -n "$originator_info_id" ] || { echo "openach-bootstrap: originator was not created" >&2; exit 1; }

echo
echo "OpenACH installation ready."
echo "  user_id            = $user_id"
echo "  originator_info_id = $originator_info_id"
echo
echo "Payment types (payment_type_id / name / transaction type):"
sql "SELECT payment_type_id || '  ' || payment_type_name || '  ' || payment_type_transaction_type
     FROM payment_type
     WHERE payment_type_originator_info_id = '$originator_info_id'
       AND payment_type_status = 'enabled'
     ORDER BY payment_type_transaction_type"
echo
echo "Register the trust's api credential next:"
echo "  OPENACH_DATABASE_URL=... OPENACH_BASE_URL=... \\"
echo "    node server/integrations/openach/server-side-setup.js"
