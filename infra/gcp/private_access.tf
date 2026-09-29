# Private, family-only access to dlbtrust-app.
#
#   family device -> (Cloud VPN, optional) -> IAP (family Google identity)
#                 -> Cloud Run dlbtrust-app (iap_enabled, no allUsers invoker)
#                 -> privateAccessGuard re-verifies the x-goog-iap-jwt-assertion
#
# Humans: roles/iap.httpsResourceAccessor per principal in var.family_accessors.
# Machines (Cloud Scheduler OIDC callers): var.scheduler_accessors.

resource "google_iap_web_cloud_run_service_iam_member" "family" {
  for_each               = toset(var.family_accessors)
  provider               = google-beta
  project                = data.google_project.current.number
  location               = var.region
  cloud_run_service_name = google_cloud_run_v2_service.app.name
  role                   = "roles/iap.httpsResourceAccessor"
  member                 = each.value
}

locals {
  # Platform identities that call the private service with a Google OIDC
  # token: the deploy workflow (smoke/readiness) and Cloud Scheduler jobs.
  platform_accessors = distinct(concat(
    ["serviceAccount:${google_service_account.deployer.email}", "serviceAccount:${google_service_account.runtime.email}"],
    var.scheduler_accessors,
    var.transfer_api_enabled ? ["serviceAccount:${local.transfer_gateway_sa_email}"] : [],
  ))
}

resource "google_iap_web_cloud_run_service_iam_member" "scheduler" {
  for_each               = toset(local.platform_accessors)
  provider               = google-beta
  project                = data.google_project.current.number
  location               = var.region
  cloud_run_service_name = google_cloud_run_v2_service.app.name
  role                   = "roles/iap.httpsResourceAccessor"
  member                 = each.value
  depends_on             = [google_service_account.transfer_gateway]
}

# ── Cloud VPN for trusted family sites (optional) ─────────────────────────────
# Created only when var.vpn_peer_ip is set. The IKE pre-shared key is read from
# Secret Manager (var.vpn_shared_secret_secret_id) and never appears in tfvars.

locals {
  vpn_enabled = var.vpn_peer_ip != ""
}

data "google_secret_manager_secret_version" "vpn_shared_secret" {
  count  = local.vpn_enabled ? 1 : 0
  secret = var.vpn_shared_secret_secret_id
}

resource "google_compute_ha_vpn_gateway" "family" {
  count   = local.vpn_enabled ? 1 : 0
  name    = "dlbtrust-family-vpn"
  region  = var.region
  network = google_compute_network.vpc.id
}

resource "google_compute_external_vpn_gateway" "family_peer" {
  count           = local.vpn_enabled ? 1 : 0
  name            = "dlbtrust-family-peer"
  redundancy_type = "SINGLE_IP_INTERNALLY_REDUNDANT"

  interface {
    id         = 0
    ip_address = var.vpn_peer_ip
  }
}

resource "google_compute_router" "family_vpn" {
  count   = local.vpn_enabled ? 1 : 0
  name    = "dlbtrust-family-vpn"
  region  = var.region
  network = google_compute_network.vpc.id

  bgp {
    asn = var.vpn_cloud_asn
  }
}

resource "google_compute_vpn_tunnel" "family" {
  count                           = local.vpn_enabled ? 1 : 0
  name                            = "dlbtrust-family-tunnel-0"
  region                          = var.region
  vpn_gateway                     = google_compute_ha_vpn_gateway.family[0].id
  vpn_gateway_interface           = 0
  peer_external_gateway           = google_compute_external_vpn_gateway.family_peer[0].id
  peer_external_gateway_interface = 0
  shared_secret                   = data.google_secret_manager_secret_version.vpn_shared_secret[0].secret_data
  router                          = google_compute_router.family_vpn[0].id
  ike_version                     = 2
}

resource "google_compute_router_interface" "family" {
  count      = local.vpn_enabled ? 1 : 0
  name       = "dlbtrust-family-if-0"
  region     = var.region
  router     = google_compute_router.family_vpn[0].name
  ip_range   = var.vpn_bgp_ip_range
  vpn_tunnel = google_compute_vpn_tunnel.family[0].name
}

resource "google_compute_router_peer" "family" {
  count                     = local.vpn_enabled ? 1 : 0
  name                      = "dlbtrust-family-peer-0"
  region                    = var.region
  router                    = google_compute_router.family_vpn[0].name
  peer_ip_address           = var.vpn_peer_bgp_ip
  peer_asn                  = var.vpn_peer_asn
  advertised_route_priority = 100
  interface                 = google_compute_router_interface.family[0].name
}
