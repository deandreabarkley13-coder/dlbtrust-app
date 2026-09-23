# OpenACH origination processing.
#
# The dlbtrust-openach service only *records* schedules; OpenACH turns them
# into ACH entries -> batches -> NACHA files when its console command
# `yiic cronnightly run` executes (payment scheduler + batch builder + file
# builder). Nothing in the web container runs that, so this job runs it on a
# Cloud Scheduler cadence from the same image, against the same database.
#
# The ODFI branch uses OpenACH's `Manual` bank plugin, whose transfer agent
# writes built files to `runtime/export/` (relative to the yiic working
# directory) and reads confirmation/return files from `runtime/import/`. Those
# directories are backed by a versioned GCS bucket so files survive the job's
# ephemeral filesystem; the app's OpenAchFileRelay then delivers `export/*.ach`
# to the ODFI through MFT Gateway (MFTGATEWAY_PARTNER_AS2_ID) and moves them
# to `sent/`.

locals {
  openach_files_bucket = "${var.project_id}-openach-ach-files"
  openach_runtime_dir  = "/var/www/openach/runtime"
}

resource "google_storage_bucket" "openach_files" {
  name                        = local.openach_files_bucket
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  depends_on = [google_project_service.enabled]
}

resource "google_storage_bucket_iam_member" "openach_files_rw" {
  for_each = {
    openach = google_service_account.openach.email
    app     = google_service_account.runtime.email
  }
  bucket = google_storage_bucket.openach_files.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${each.value}"
}

resource "google_cloud_run_v2_job" "openach_nightly" {
  name                = "dlbtrust-openach-nightly"
  location            = var.region
  deletion_protection = false

  template {
    task_count = 1

    template {
      service_account = google_service_account.openach.email
      max_retries     = 0
      timeout         = "1800s"

      vpc_access {
        connector = google_vpc_access_connector.run.id
        egress    = "PRIVATE_RANGES_ONLY"
      }

      volumes {
        name = "ach-files"
        gcs {
          bucket    = google_storage_bucket.openach_files.name
          read_only = false
        }
      }

      containers {
        image = var.openach_image

        # The image ENTRYPOINT (docker-entrypoint.sh) renders db.php/security.php
        # from the secrets above, then execs these args in place of apache.
        args = [
          "bash", "-c",
          <<-EOT
            set -e
            cd /var/www/openach
            mkdir -p runtime/export runtime/import
            php protected/yiic cronnightly run
            php protected/yiic confirmationprocessor run || true
            php protected/yiic returnchangeprocessor run || true
          EOT
        ]

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        volume_mounts {
          name       = "ach-files"
          mount_path = local.openach_runtime_dir
        }

        dynamic "env" {
          for_each = google_secret_manager_secret.openach
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
    google_secret_manager_secret_version.openach_database_url,
    google_secret_manager_secret_iam_member.openach_accessor,
  ]

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image, client, client_version]
  }
}

resource "google_service_account" "openach_scheduler" {
  account_id   = "dlbtrust-openach-sched"
  display_name = "Cloud Scheduler invoker for dlbtrust-openach-nightly"
}

resource "google_cloud_run_v2_job_iam_member" "openach_nightly_invoker" {
  name     = google_cloud_run_v2_job.openach_nightly.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.openach_scheduler.email}"
}

resource "google_cloud_scheduler_job" "openach_nightly" {
  name        = "dlbtrust-openach-nightly"
  region      = var.region
  description = "OpenACH cronnightly: build ACH entries, batches and NACHA files for due schedules"
  schedule    = var.openach_nightly_schedule
  time_zone   = "America/New_York"

  retry_config {
    retry_count = 1
  }

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.openach_nightly.name}:run"

    oauth_token {
      service_account_email = google_service_account.openach_scheduler.email
    }
  }

  depends_on = [
    google_project_service.enabled,
    google_cloud_run_v2_job_iam_member.openach_nightly_invoker,
  ]
}
