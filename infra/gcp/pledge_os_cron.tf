# Pledge OS wire (server/scripts/pledgeOsWire.js).
#
# The scheduled pass runs `pledgeOsWire.js --evaluate`: it re-checks every
# recorded pledge (lien evidence, and its backing: a Private Equity Holdings OS
# holding, a Custody OS position, or a bond looked through to its eligible
# private-equity holdings), records counted / not_counted, and reports how much
# of the Collateral OS borrowing base the counted pledges back. It never books
# GL lines, edits balances, draws or sends a wire.
#
# One-shot operator passes override the args per execution, e.g.
#   gcloud run jobs execute dlbtrust-pledge-os-wire --region us-east1 --wait \
#     --args=server/scripts/pledgeOsWire.js,--json

locals {
  pledge_os_env = { for k, v in var.runtime_environment : k => v if !contains(local.runtime_secret_names, k) }
  pledge_os_unsafe_controls = compact([
    tonumber(lookup(var.runtime_environment, "CUSTODY_REQUIRED_SIGNATURES", "2")) < 2 ? "CUSTODY_REQUIRED_SIGNATURES must be >= 2 (maker + second trustee countersignature)" : "",
  ])
}

resource "google_cloud_run_v2_job" "pledge_os_wire" {
  name                = "dlbtrust-pledge-os-wire"
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
        args    = ["server/scripts/pledgeOsWire.js", "--evaluate", "--actor", "dlbtrust-pledge-os-wire"]

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
          for_each = local.pledge_os_env
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
      condition     = length(local.pledge_os_unsafe_controls) == 0
      error_message = "The pledge os wire needs dual-signature custody controls: ${join("; ", local.pledge_os_unsafe_controls)}."
    }
  }
}

resource "google_service_account" "pledge_os_scheduler" {
  account_id   = "dlbtrust-pledge-os-sched"
  display_name = "Cloud Scheduler invoker for dlbtrust-pledge-os-wire"
}

resource "google_cloud_run_v2_job_iam_member" "pledge_os_wire_invoker" {
  name     = google_cloud_run_v2_job.pledge_os_wire.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pledge_os_scheduler.email}"
}

resource "google_cloud_scheduler_job" "pledge_os_wire" {
  name        = "dlbtrust-pledge-os-wire"
  region      = var.region
  description = "Pledge OS: re-evaluate recorded pledges, their lien evidence and asset backing, and Collateral OS coverage"
  schedule    = var.pledge_os_wire_schedule
  time_zone   = "America/New_York"

  retry_config {
    retry_count = 0
  }

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.pledge_os_wire.name}:run"

    oauth_token {
      service_account_email = google_service_account.pledge_os_scheduler.email
    }
  }

  depends_on = [
    google_project_service.enabled,
    google_cloud_run_v2_job_iam_member.pledge_os_wire_invoker,
  ]
}
