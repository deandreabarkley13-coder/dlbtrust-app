# Unified Trust Data workflow (server/scripts/unifiedTrustDataWorkflow.js).
#
# The scheduled pass runs `unifiedTrustDataWorkflow.js --run --sync-ledger`:
# custody -> PE holdings -> pledge -> collateral -> enterprise credit -> credit
# -> attestation -> trust ledger -> cash module, stored in
# unified_trust_snapshots. --sync-ledger aligns trust_accounts.balance with
# posted journal lines; no journal entry is posted and no wire is sent.
# The job runs on the platform's private network path: Serverless VPC
# connector -> Cloud NAT static IP, plus the Cloud VPN tunnels when configured.
#
# One-shot operator passes override the args per execution, e.g.
#   gcloud run jobs execute dlbtrust-unified-trust-data --region us-east1 --wait \
#     --args=server/scripts/unifiedTrustDataWorkflow.js,--reseal-chains,--reason,<why>,--actor,<id>

locals {
  unified_data_env = { for k, v in var.runtime_environment : k => v if !contains(local.runtime_secret_names, k) }
  unified_data_unsafe_controls = compact([
    tonumber(lookup(var.runtime_environment, "PAYMENT_APPROVAL_THRESHOLD", "2")) < 2 ? "PAYMENT_APPROVAL_THRESHOLD must be >= 2 (maker/checker)" : "",
  ])
}

resource "google_cloud_run_v2_job" "unified_trust_data" {
  name                = "dlbtrust-unified-trust-data"
  location            = var.region
  deletion_protection = false

  template {
    task_count = 1

    template {
      service_account = google_service_account.runtime.email
      max_retries     = 0
      timeout         = "1200s"

      vpc_access {
        connector = google_vpc_access_connector.run.id
        egress    = "ALL_TRAFFIC"
      }

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.ledger.connection_name]
        }
      }

      containers {
        image   = var.image
        command = ["node"]
        args    = ["server/scripts/unifiedTrustDataWorkflow.js", "--run", "--sync-ledger", "--actor", "dlbtrust-unified-trust-data"]

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }

        dynamic "env" {
          for_each = local.unified_data_env
          content {
            name  = env.key
            value = env.value
          }
        }

        env {
          name  = "GCP_PROJECT"
          value = var.project_id
        }

        # Same private network path as dlbtrust-app: VPC connector -> Cloud NAT
        # static IP (backends.tf) and, when vpn_peer_ip is set, the Cloud VPN
        # tunnels on the dlbtrust VPC (private_access.tf).
        env {
          name  = "EGRESS_STATIC_IP"
          value = google_compute_address.egress.address
        }

        env {
          name  = "EGRESS_VPC_CONNECTOR"
          value = google_vpc_access_connector.run.name
        }

        env {
          name  = "EGRESS_NAT_NAME"
          value = google_compute_router_nat.egress.name
        }

        env {
          name  = "PRIVATE_ACCESS_VPN_ENABLED"
          value = local.vpn_enabled ? "true" : "false"
        }

        env {
          name  = "PRIVATE_ACCESS_VPN_GATEWAY"
          value = local.vpn_enabled ? google_compute_ha_vpn_gateway.family[0].name : ""
        }

        env {
          name  = "PRIVATE_ACCESS_VPN_TUNNELS"
          value = tostring(length(google_compute_vpn_tunnel.family))
        }

        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.database_url.secret_id
              version = "latest"
            }
          }
        }

        dynamic "env" {
          for_each = {
            for k, s in google_secret_manager_secret.runtime : k => s
            if !contains(var.unseeded_secret_names, k)
          }
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = env.value.secret_id
                version = "latest"
              }
            }
          }
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.database_url_runtime,
    google_secret_manager_secret_iam_member.runtime_accessor,
  ]

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image, client, client_version]

    precondition {
      condition     = length(local.unified_data_unsafe_controls) == 0
      error_message = "The unified trust data job needs maker/checker approvals: ${join("; ", local.unified_data_unsafe_controls)}."
    }
  }
}

resource "google_service_account" "unified_data_scheduler" {
  account_id   = "dlbtrust-unified-data-sched"
  display_name = "Cloud Scheduler invoker for dlbtrust-unified-trust-data"
}

resource "google_cloud_run_v2_job_iam_member" "unified_trust_data_invoker" {
  name     = google_cloud_run_v2_job.unified_trust_data.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.unified_data_scheduler.email}"
}

resource "google_cloud_scheduler_job" "unified_trust_data" {
  name        = "dlbtrust-unified-trust-data"
  region      = var.region
  description = "Unified Trust Data: ordered custody/PE/pledge/collateral/credit/attestation/ledger/cash pass"
  schedule    = var.unified_trust_data_schedule
  time_zone   = "America/New_York"

  retry_config {
    retry_count = 0
  }

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.unified_trust_data.name}:run"

    oauth_token {
      service_account_email = google_service_account.unified_data_scheduler.email
    }
  }

  depends_on = [
    google_project_service.enabled,
    google_cloud_run_v2_job_iam_member.unified_trust_data_invoker,
  ]
}
