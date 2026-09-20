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

  # Env-only credentials each live flag needs (cannot be generated; values come
  # from the provider, so they are listed in terraform.tfvars secret_names once
  # obtained). cloudrun.tf refuses to plan a live flag whose secrets are not
  # declared. Lili is not here: its OAuth tokens may live encrypted in the
  # system_settings table (dashboard OAuth flow) instead of env, so it is only
  # a warning (check "lili_clearing_secrets") and reported at runtime by
  # GET /api/os/readiness/gateway.
  live_engine_requirements = {
    "APIGEE_LIVE" = {
      flag    = lookup(var.runtime_environment, "APIGEE_LIVE", "false") == "true"
      secrets = contains(var.secret_names, "APIGEE_API_KEY") ? [] : ["APIGEE_CLIENT_ID", "APIGEE_CLIENT_SECRET"]
    }
    "APISIX_LIVE" = {
      flag    = lookup(var.runtime_environment, "APISIX_LIVE", "false") == "true"
      secrets = ["APISIX_API_KEY"]
    }
    "CROSS_CHAIN_SHADOW=false" = {
      flag    = lookup(var.runtime_environment, "CROSS_CHAIN_SHADOW", "true") == "false"
      secrets = ["DAPP_RPC_URL", "DAPP_PRIVATE_KEY"]
    }
  }
  missing_live_secrets = distinct(flatten([
    for name, req in local.live_engine_requirements : [
      for s in req.secrets : "${s} (required by ${name})" if req.flag && !contains(local.runtime_secret_names, s)
    ]
  ]))

  lili_secret_names = ["LILI_OAUTH_CLIENT_ID", "LILI_OAUTH_CLIENT_SECRET", "LILI_OAUTH_REFRESH_TOKEN", "LILI_BUSINESS_USER_ID"]
  missing_lili_secrets = [
    for s in local.lili_secret_names : s
    if lookup(var.runtime_environment, "LILI_CLEARING_LIVE", "false") == "true" && !contains(local.runtime_secret_names, s)
  ]
}

check "lili_clearing_secrets" {
  assert {
    condition     = length(local.missing_lili_secrets) == 0
    error_message = "LILI_CLEARING_LIVE=true but secret_names lacks ${join(", ", local.missing_lili_secrets)}; live Lili clearing then depends on tokens stored in system_settings via the dashboard OAuth flow."
  }
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
