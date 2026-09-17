#!/usr/bin/env bash
# One-time project bootstrap before `terraform init` in infra/gcp:
# enables the APIs terraform itself needs and creates the state bucket.
#
# Usage: GCP_PROJECT=dlb-treasury-management scripts/gcp/bootstrap.sh
set -euo pipefail

PROJECT="${GCP_PROJECT:-dlb-treasury-management}"
REGION="${GCP_REGION:-us-east1}"
BUCKET="${TF_STATE_BUCKET:-${PROJECT}-tfstate}"

gcloud config set project "$PROJECT" >/dev/null

if ! gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' | grep -q True; then
  echo "billing is not enabled on $PROJECT — Cloud SQL and Cloud Run cannot be created" >&2
  exit 1
fi

gcloud services enable \
  cloudresourcemanager.googleapis.com \
  serviceusage.googleapis.com \
  iam.googleapis.com \
  storage.googleapis.com \
  compute.googleapis.com

if ! gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$BUCKET" \
    --location="$REGION" \
    --uniform-bucket-level-access \
    --public-access-prevention
  gcloud storage buckets update "gs://$BUCKET" --versioning
fi

echo "state bucket: gs://$BUCKET"
echo "next: cd infra/gcp && terraform init -backend-config=\"bucket=$BUCKET\""
