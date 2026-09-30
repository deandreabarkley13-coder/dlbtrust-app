# Private Equity Holdings wire (server/scripts/privateEquityHoldingsWire.js).
#
# The scheduled pass runs `privateEquityHoldingsWire.js --evaluate`: it
# re-checks every private-equity holding backing the PFTC-issued
# private-placement bond (PFTC profile attested, private placement compliant,
# Custody OS private_equity position receipted by two trustees at a third-party
# custodian, valuation current and equal to the receipt, certified Proof of
# Asset, custody chain intact) and records each verdict. It never books GL
# lines, edits balances or sends a wire.
#
# One-shot operator passes override the args per execution, e.g.
#   gcloud run jobs execute dlbtrust-pe-holdings-wire --region us-east1 --wait \
#     --args=server/scripts/privateEquityHoldingsWire.js,--plan-draw,--amount,250000,--json

locals {
  pe_holdings_env  = { for k, v in var.runtime_environment : k => v if !contains(local.runtime_secret_names, k) }
  pe_holdings_live = lower(lookup(var.runtime_environment, "PE_HOLDINGS_LIVE", "false")) == "true"
  pe_holdings_unsafe_controls = compact([
    local.pe_holdings_live && lower(lookup(var.runtime_environment, "PRIVATE_ENTITY_LIVE", "false")) != "true" ? "PE_HOLDINGS_LIVE=true needs PRIVATE_ENTITY_LIVE=true (the PFTC is the issuer of record)" : "",
    local.pe_holdings_live && lower(lookup(var.runtime_environment, "PE_HOLDINGS_REQUIRE_THIRD_PARTY_CUSTODY", "true")) == "false" ? "PE_HOLDINGS_LIVE=true cannot accept self-custody receipts as asset backing (PE_HOLDINGS_REQUIRE_THIRD_PARTY_CUSTODY=false)" : "",
    tonumber(lookup(var.runtime_environment, "CUSTODY_REQUIRED_SIGNATURES", "2")) < 2 ? "CUSTODY_REQUIRED_SIGNATURES must be >= 2 (maker + second trustee countersignature)" : "",
  ])
}

resource "google_cloud_run_v2_job" "pe_holdings_wire" {
  name                = "dlbtrust-pe-holdings-wire"
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
        args    = ["server/scripts/privateEquityHoldingsWire.js", "--evaluate", "--actor", "dlbtrust-pe-holdings-wire"]

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
          for_each = local.pe_holdings_env
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
      condition     = length(local.pe_holdings_unsafe_controls) == 0
      error_message = "The private equity holdings wire needs PFTC issuer, third-party custody and dual-signature controls: ${join("; ", local.pe_holdings_unsafe_controls)}."
    }
  }
}

resource "google_service_account" "pe_holdings_scheduler" {
  account_id   = "dlbtrust-pe-holdings-sched"
  display_name = "Cloud Scheduler invoker for dlbtrust-pe-holdings-wire"
}

resource "google_cloud_run_v2_job_iam_member" "pe_holdings_wire_invoker" {
  name     = google_cloud_run_v2_job.pe_holdings_wire.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pe_holdings_scheduler.email}"
}

resource "google_cloud_scheduler_job" "pe_holdings_wire" {
  name        = "dlbtrust-pe-holdings-wire"
  region      = var.region
  description = "Private equity holdings: re-evaluate custody, proof-of-asset and collateral eligibility of the PFTC private-placement bond's asset backing"
  schedule    = var.pe_holdings_wire_schedule
  time_zone   = "America/New_York"

  retry_config {
    retry_count = 0
  }

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.pe_holdings_wire.name}:run"

    oauth_token {
      service_account_email = google_service_account.pe_holdings_scheduler.email
    }
  }

  depends_on = [
    google_project_service.enabled,
    google_cloud_run_v2_job_iam_member.pe_holdings_wire_invoker,
  ]
}
