# Transfer API facade: GCP API Gateway -> (IAP) -> Cloud Run dlbtrust-app
# /api/transfer/v1 -> Enterprise ODFI OS (maker/checker) -> Clearing Agent.
#
#   maker/checker client --(Google ID token | x-api-key)--> API Gateway
#     -> quotas, edge auth, logging
#     -> OIDC token of google_service_account.transfer_gateway, audience =
#        IAP OAuth client, through IAP to Cloud Run
#     -> privateAccessGuard: platform identity (PRIVATE_ACCESS_SERVICE_ACCOUNTS)
#     -> routes/transferApi.js: caller = x-apigateway-api-userinfo
#
# The API key (google_apikeys_key) is read-only at the application layer and
# never enters the app or Terraform state outputs; writes need a Google identity.
# Created only when var.transfer_api_enabled is true (API Gateway is a paid
# product; ~USD 3 per million calls, no fixed monthly fee).

locals {
  transfer_api_enabled      = var.transfer_api_enabled
  transfer_gateway_sa_email = "dlbtrust-transfer-gateway@${var.project_id}.iam.gserviceaccount.com"
  # Deterministic Cloud Run URL so the gateway config does not depend on the
  # service (whose env in turn carries the gateway hostname).
  transfer_api_backend  = "https://${var.service_name}-${data.google_project.current.number}.${var.region}.run.app/api/transfer"
  transfer_api_audience = var.transfer_api_id_token_audience != "" ? var.transfer_api_id_token_audience : "https://transfer.${var.project_id}.dlbtrust"
}

resource "google_project_service" "transfer_api" {
  for_each = local.transfer_api_enabled ? toset([
    "apigateway.googleapis.com",
    "servicemanagement.googleapis.com",
    "servicecontrol.googleapis.com",
    "apikeys.googleapis.com",
  ]) : toset([])
  service            = each.value
  disable_on_destroy = false
}

resource "google_service_account" "transfer_gateway" {
  count        = local.transfer_api_enabled ? 1 : 0
  account_id   = "dlbtrust-transfer-gateway"
  display_name = "DLB Trust Transfer API Gateway (calls dlbtrust-app through IAP)"
}

resource "google_cloud_run_v2_service_iam_member" "transfer_gateway_invoker" {
  count    = local.transfer_api_enabled ? 1 : 0
  project  = google_cloud_run_v2_service.app.project
  location = google_cloud_run_v2_service.app.location
  name     = google_cloud_run_v2_service.app.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.transfer_gateway[0].email}"
}

# IAP access + PRIVATE_ACCESS_SERVICE_ACCOUNTS membership come from
# local.platform_accessors (private_access.tf), which lists this SA by its
# deterministic email so the for_each is known at plan time.

resource "google_api_gateway_api" "transfer" {
  count        = local.transfer_api_enabled ? 1 : 0
  provider     = google-beta
  api_id       = "dlbtrust-transfer-api"
  display_name = "DLB Trust Transfer API"
  depends_on   = [google_project_service.transfer_api]
}

resource "google_api_gateway_api_config" "transfer" {
  count                = local.transfer_api_enabled ? 1 : 0
  provider             = google-beta
  api                  = google_api_gateway_api.transfer[0].api_id
  api_config_id_prefix = "transfer-"
  display_name         = "DLB Trust Transfer API config"

  openapi_documents {
    document {
      path = "transfer_api_openapi.yaml"
      contents = base64encode(templatefile("${path.module}/transfer_api_openapi.yaml.tpl", {
        api_version            = "v1"
        backend_address        = local.transfer_api_backend
        backend_jwt_audience   = var.iap_oauth_client_id != "" ? var.iap_oauth_client_id : local.transfer_api_backend
        id_token_audience      = local.transfer_api_audience
        write_quota_per_minute = var.transfer_api_write_quota_per_minute
        read_quota_per_minute  = var.transfer_api_read_quota_per_minute
      }))
    }
  }

  gateway_config {
    backend_config {
      google_service_account = google_service_account.transfer_gateway[0].email
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "google_api_gateway_gateway" "transfer" {
  count        = local.transfer_api_enabled ? 1 : 0
  provider     = google-beta
  api_config   = google_api_gateway_api_config.transfer[0].id
  gateway_id   = "dlbtrust-transfer-gateway"
  region       = var.region
  display_name = "DLB Trust Transfer API Gateway"
}

# Read-only key for monitoring clients; restricted to this managed service.
resource "google_apikeys_key" "transfer_readonly" {
  count        = local.transfer_api_enabled ? 1 : 0
  name         = "dlbtrust-transfer-readonly"
  display_name = "DLB Trust Transfer API (read-only)"

  restrictions {
    api_targets {
      service = google_api_gateway_api.transfer[0].managed_service
    }
  }
}

resource "google_project_service" "transfer_managed_service" {
  count              = local.transfer_api_enabled ? 1 : 0
  service            = google_api_gateway_api.transfer[0].managed_service
  disable_on_destroy = false
}

locals {
  transfer_api_env = local.transfer_api_enabled ? {
    TRANSFER_API_ENABLED                 = "true"
    TRANSFER_API_LIVE                    = var.transfer_api_live ? "true" : "false"
    TRANSFER_API_GATEWAY_HOST            = google_api_gateway_gateway.transfer[0].default_hostname
    TRANSFER_API_GATEWAY_SERVICE_ACCOUNT = google_service_account.transfer_gateway[0].email
    TRANSFER_API_AUDIENCE                = local.transfer_api_audience
    } : {
    TRANSFER_API_ENABLED = "true"
    TRANSFER_API_LIVE    = "false"
  }
}

output "transfer_api_gateway_host" {
  description = "Hostname of the Transfer API gateway (empty when disabled). Callers: https://<host>/v1/transfers with Authorization: Bearer <Google ID token, aud = TRANSFER_API_AUDIENCE>."
  value       = local.transfer_api_enabled ? google_api_gateway_gateway.transfer[0].default_hostname : ""
}
