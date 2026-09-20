#!/usr/bin/env bash
# Seed the Payment Hub EE secret values that infra/gcp/secrets.tf declares
# (payment_hub_secret_names). Terraform only creates the containers; this adds
# a first version to each one that has none, generating random values and
# never printing them. Re-running is a no-op for secrets that already have a
# version, so an existing PAYMENT_DATA_ENCRYPTION_KEY (which encrypts data at
# rest and cannot be rotated once payment rows exist) is never replaced.
#
# Usage:
#   GCP_PROJECT=dlb-treasury-management scripts/gcp/payment-hub-secrets.sh
#   # or supply a value instead of generating one:
#   PAYMENT_HUB_AUTH_TOKEN=<token issued by the PHEE operator> scripts/gcp/payment-hub-secrets.sh
set -euo pipefail

PROJECT="${GCP_PROJECT:-dlb-treasury-management}"

seed() {
  local name="$1" generator="$2"
  if [[ -n "$(gcloud secrets versions list "$name" --project "$PROJECT" --filter 'state=ENABLED' --format 'value(name)' --limit 1 2>/dev/null)" ]]; then
    echo "$name: already has an enabled version, leaving it alone"
    return
  fi
  if [[ -n "${!name:-}" ]]; then
    printf '%s' "${!name}" | gcloud secrets versions add "$name" --project "$PROJECT" --data-file=-
    echo "$name: added version from environment"
  else
    eval "$generator" | tr -d '\n' | gcloud secrets versions add "$name" --project "$PROJECT" --data-file=-
    echo "$name: added generated version"
  fi
}

# Bearer token the app sends to the channel connector and the connector validates.
seed PAYMENT_HUB_AUTH_TOKEN      'openssl rand -base64 48'
# Token PHEE presents to POST /api/payment-hub/connectors/us-ach/execute.
seed PAYMENT_HUB_SERVICE_TOKEN   'openssl rand -base64 48'
# HMAC key for X-Payment-Hub-Signature on /api/payment-hub/webhooks/status.
seed PAYMENT_HUB_WEBHOOK_SECRET  'openssl rand -hex 32'
# 64 hex chars = 32-byte AES key (server/integrations/paymentHub/paymentCrypto.js).
seed PAYMENT_DATA_ENCRYPTION_KEY 'openssl rand -hex 32'
