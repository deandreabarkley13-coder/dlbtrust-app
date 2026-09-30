# PPB debt service wire (server/scripts/ppbDebtServiceWire.js).
#
# Principal and coupon income of the single-family trust's private-placement
# bond, paid to the trust and its beneficiaries. The scheduled pass runs
# `ppbDebtServiceWire.js --plan`: Fixed Income Distribution OS plans a
# distribution per payee for every newly booked coupon (1020) / operating
# (1030) journal, and the Debt OS schedule, bucket funding and Bond Redemption
# OS maturities are reported. Planning never stages or sends a payment: staging
# and executing stay on fixedIncomeDistribution.js (maker/checker, screening and
# the settlement bank's reference).
#
# One-shot operator passes override the args per execution, e.g.
#   gcloud run jobs execute dlbtrust-ppb-debt-service-wire --region us-east1 --wait \
#     --args=server/scripts/ppbDebtServiceWire.js,--plan,--dry-run,--actor,operator

locals {
  ppb_debt_service_env = { for k, v in var.runtime_environment : k => v if !contains(local.runtime_secret_names, k) }
  ppb_debt_service_unsafe_controls = compact([
    tonumber(lookup(var.runtime_environment, "PAYMENT_APPROVAL_THRESHOLD", "2")) < 2 ? "PAYMENT_APPROVAL_THRESHOLD must be >= 2 (maker/checker)" : "",
  ])
}

resource "google_cloud_run_v2_job" "ppb_debt_service_wire" {
  name                = "dlbtrust-ppb-debt-service-wire"
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
        args    = ["server/scripts/ppbDebtServiceWire.js", "--plan", "--actor", "dlbtrust-ppb-debt-service-wire"]

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
          for_each = local.ppb_debt_service_env
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
      condition     = length(local.ppb_debt_service_unsafe_controls) == 0
      error_message = "The PPB debt service wire needs maker/checker approvals: ${join("; ", local.ppb_debt_service_unsafe_controls)}."
    }
  }
}

resource "google_service_account" "ppb_debt_service_scheduler" {
  account_id   = "dlbtrust-ppb-debt-sched"
  display_name = "Cloud Scheduler invoker for dlbtrust-ppb-debt-service-wire"
}

resource "google_cloud_run_v2_job_iam_member" "ppb_debt_service_wire_invoker" {
  name     = google_cloud_run_v2_job.ppb_debt_service_wire.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.ppb_debt_service_scheduler.email}"
}

resource "google_cloud_scheduler_job" "ppb_debt_service_wire" {
  name        = "dlbtrust-ppb-debt-service-wire"
  region      = var.region
  description = "PPB debt service: plan principal + coupon income distributions to the trust and its beneficiaries"
  schedule    = var.ppb_debt_service_wire_schedule
  time_zone   = "America/New_York"

  retry_config {
    retry_count = 0
  }

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.ppb_debt_service_wire.name}:run"

    oauth_token {
      service_account_email = google_service_account.ppb_debt_service_scheduler.email
    }
  }

  depends_on = [
    google_project_service.enabled,
    google_cloud_run_v2_job_iam_member.ppb_debt_service_wire_invoker,
  ]
}
