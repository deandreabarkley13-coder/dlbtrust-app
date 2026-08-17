#!/usr/bin/env bash
# Generate a 32-byte base64 symmetric key for the self-hosted Moov Paygate stack.
# Usage:
#   bash scripts/generate-moov-symmetric-key.sh
# Then copy the printed value into .env as MOOV_PAYGATE_SYMMETRIC_KEY.

set -euo pipefail

KEY="base64key://$(openssl rand -base64 32)"
echo "MOOV_PAYGATE_SYMMETRIC_KEY=$KEY"
