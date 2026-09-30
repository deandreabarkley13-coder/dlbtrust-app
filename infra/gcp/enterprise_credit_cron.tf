# Enterprise Credit OS wire (server/scripts/enterpriseCreditWire.js).
#
# The scheduled pass runs `enterpriseCreditWire.js --evaluate`: it recomputes
# asset-backed capacity (collateral-eligible Private Equity Holdings OS value +
# counted custody-position pledges) and each open distribution / disbursement's
# backing verdict. It never books GL lines, edits balances or sends a wire;
# approved allocations are funded through fundSettlementAccount.js pipeline.
#
# One-shot operator passes override the args per execution, e.g.
#   gcloud run jobs execute dlbtrust-enterprise-credit-wire --region us-east1 --wait \
#     --args=server/scripts/enterpriseCreditWire.js,--json

locals {
  enterprise_credit_env = { for k, v in var.runtime_environment : k => v if !contains(local.runtime_secret_names, k) }
  enterprise_credit_unsafe_controls = compact([
    tonumber(lookup(var.runtime_environment, "PAYMENT_APPROVAL_THRESHOLD", "2")) < 2 ? "PAYMENT_APPROVAL_THRESHOLD must be >= 2 (maker/checker)" : "",
  ])
}

resource "google_cloud_run_v2_job" "enterprise_credit_wire" {
  name                = "dlbtrust-enterprise-credit-wire"
  location            = var.region
  deletion_protection = false

  template {
    task_count = 1

    template {
      service_account = google_service_account.runtime.email
      max_retries     = 0
      timeout         = "600s"

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
        args    = ["server/scripts/enterpriseCreditWire.js", "--evaluate", "--actor", "dlbtrust-enterprise-credit-wire"]

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
          for_each = local.enterprise_credit_env
          content {
            name  = env.key
            value = env.value
          }
        }

        env {
          name  = "GCP_PROJECT"
          value = var.project_id
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
      condition     = length(local.enterprise_credit_unsafe_controls) == 0
      error_message = "The enterprise credit wire needs maker/checker approvals: ${join("; ", local.enterprise_credit_unsafe_controls)}."
    }
  }
}

resource "google_service_account" "enterprise_credit_scheduler" {
  account_id   = "dlbtrust-ent-credit-sched"
  display_name = "Cloud Scheduler invoker for dlbtrust-enterprise-credit-wire"
}

resource "google_cloud_run_v2_job_iam_member" "enterprise_credit_wire_invoker" {
  name     = google_cloud_run_v2_job.enterprise_credit_wire.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.enterprise_credit_scheduler.email}"
}

resource "google_cloud_scheduler_job" "enterprise_credit_wire" {
  name        = "dlbtrust-enterprise-credit-wire"
  region      = var.region
  description = "Enterprise Credit OS: recompute asset-backed capacity and backing of open distributions / disbursements"
  schedule    = var.enterprise_credit_wire_schedule
  time_zone   = "America/New_York"

  retry_config {
    retry_count = 0
  }

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.enterprise_credit_wire.name}:run"

    oauth_token {
      service_account_email = google_service_account.enterprise_credit_scheduler.email
    }
  }

  depends_on = [
    google_project_service.enabled,
    google_cloud_run_v2_job_iam_member.enterprise_credit_wire_invoker,
  ]
}
