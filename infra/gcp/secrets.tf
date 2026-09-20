# One Secret Manager secret per runtime credential. Terraform owns the
# containers only; the values are written by scripts/gcp/migrate-northflank-secrets.mjs
# (or `gcloud secrets versions add`), so a plan never carries a secret value.

locals {
  # Always declared, whatever terraform.tfvars lists: Payment Hub EE cannot be
  # enabled without them (paymentHubConfig.js readiness) and NODE_ENV=production
  # refuses to boot without PAYMENT_DATA_ENCRYPTION_KEY. Values are written out
  # of band (scripts/gcp/payment-hub-secrets.sh).
  payment_hub_secret_names = [
    "PAYMENT_HUB_AUTH_TOKEN",
    "PAYMENT_HUB_SERVICE_TOKEN",
    "PAYMENT_HUB_WEBHOOK_SECRET",
    "PAYMENT_DATA_ENCRYPTION_KEY",
  ]
  runtime_secret_names = distinct(concat(var.secret_names, local.payment_hub_secret_names))
}

resource "google_secret_manager_secret" "runtime" {
  for_each  = toset(local.runtime_secret_names)
  secret_id = each.value

  replication {
    auto {}
  }

  labels = {
    service = var.service_name
    source  = "northflank-dlbtrust-runtime"
  }

  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_iam_member" "runtime_accessor" {
  for_each  = google_secret_manager_secret.runtime
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
