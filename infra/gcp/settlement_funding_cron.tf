# Settlement funding pipeline (server/scripts/fundingPipeline.js).
#
# The scheduled pass runs `fundSettlementAccount.js pipeline --advance`: it
# checks that trust_accounts.balance matches the posted journal lines, then
# settles only settlement_funding wires whose bank settlement reference is
# already recorded (DR destination GL / CR in-transit). It never originates,
# approves or transmits a wire and never settles without the bank's reference.
#
# The same job is the one-shot runner for an operator pass, with the args
# overridden per execution (maker/checker, approvalRef, live FCS- screeningRef):
#   gcloud run jobs execute dlbtrust-settlement-funding-pipeline --region us-east1 --wait \
#     --args=server/scripts/fundSettlementAccount.js,pipeline,--amount,25000,--maker,<maker>,\
#   --checker,<checker>,--approval-ref,<APR-…>,--screening-ref,<FCS-…>,--yes

resource "google_cloud_run_v2_job" "settlement_funding_pipeline" {
  name                = "dlbtrust-settlement-funding-pipeline"
  location            = var.region
  deletion_protection = false

  template {
    task_count = 1

    template {
      service_account = google_service_account.runtime.email
      max_retries     = 0
      timeout         = "900s"

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
        args    = ["server/scripts/fundSettlementAccount.js", "pipeline", "--advance", "--actor", "dlbtrust-settlement-funding-pipeline"]

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
          for_each = {
            for k, v in var.runtime_environment : k => v
            if !contains(local.runtime_secret_names, k)
          }
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
      condition     = length(local.settlement_funding_unsafe_controls) == 0
      error_message = "The settlement funding pipeline needs dual control and live AML / OFAC screening: ${join("; ", local.settlement_funding_unsafe_controls)}."
    }

    precondition {
      condition     = !local.settlement_funding_account_missing
      error_message = "SETTLEMENT_FUNDING_ROUTING registers a settlement funding destination but secret_names lacks SETTLEMENT_FUNDING_ACCOUNT. Add it to infra/gcp/terraform.tfvars and seed with `gcloud secrets versions add SETTLEMENT_FUNDING_ACCOUNT --data-file=-`."
    }

    precondition {
      condition     = !local.settlement_funding_account_plain
      error_message = "SETTLEMENT_FUNDING_ACCOUNT is a bank account number: list it in secret_names, never in runtime_environment."
    }
  }
}

resource "google_service_account" "settlement_funding_scheduler" {
  account_id   = "dlbtrust-funding-sched"
  display_name = "Cloud Scheduler invoker for dlbtrust-settlement-funding-pipeline"
}

resource "google_cloud_run_v2_job_iam_member" "settlement_funding_pipeline_invoker" {
  name     = google_cloud_run_v2_job.settlement_funding_pipeline.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.settlement_funding_scheduler.email}"
}

resource "google_cloud_scheduler_job" "settlement_funding_pipeline" {
  name        = "dlbtrust-settlement-funding-pipeline"
  region      = var.region
  description = "Settlement funding: reconcile check, then settle funding wires against their recorded bank settlement reference"
  schedule    = var.settlement_funding_pipeline_schedule
  time_zone   = "America/New_York"

  retry_config {
    retry_count = 0
  }

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.settlement_funding_pipeline.name}:run"

    oauth_token {
      service_account_email = google_service_account.settlement_funding_scheduler.email
    }
  }

  depends_on = [
    google_project_service.enabled,
    google_cloud_run_v2_job_iam_member.settlement_funding_pipeline_invoker,
  ]
}
