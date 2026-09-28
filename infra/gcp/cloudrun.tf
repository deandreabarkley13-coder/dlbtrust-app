# dlbtrust-app on Cloud Run. Pinned to exactly one instance: the journal,
# shutdown state and Melio CSV exports under /data assume a single writer, and
# the in-process schedulers (OpenSanctions refresh, Spritz/Melio status sync)
# must not run concurrently.

# Private, family-only: no allUsers invoker; every request enters through
# Identity-Aware Proxy (family Google identities in var.family_accessors) and
# the app re-verifies the IAP assertion (PRIVATE_ACCESS_MODE=enforce).
resource "google_cloud_run_v2_service" "app" {
  provider            = google-beta
  name                = var.service_name
  location            = var.region
  ingress             = var.private_access_ingress
  launch_stage        = "BETA"
  iap_enabled         = true
  deletion_protection = false

  template {
    service_account = google_service_account.runtime.email

    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }

    # Keep the process alive between requests so background sync loops run.
    annotations = {
      "run.googleapis.com/cpu-throttling" = "false"
    }

    # ALL_TRAFFIC so calls to the internal-ingress Fineract/OpenACH services
    # arrive from the VPC; internet egress leaves via Cloud NAT (backends.tf).
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

    volumes {
      name = "data"
      gcs {
        bucket    = google_storage_bucket.data.name
        read_only = false
      }
    }

    containers {
      image = var.image

      ports {
        container_port = 3002
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        startup_cpu_boost = true
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      volume_mounts {
        name       = "data"
        mount_path = "/data"
      }

      # Cloud Run rejects a name that is both plain and secret-backed; a
      # Secret Manager entry of the same name wins over runtime_environment.
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
        name  = "GCS_CLEARING_EVIDENCE_BUCKET"
        value = google_storage_bucket.clearing_evidence.name
      }

      # NACHA files built by the dlbtrust-openach-nightly job (openach_cron.tf),
      # relayed to the ODFI by OpenAchFileRelay.
      env {
        name  = "OPENACH_ACH_FILES_BUCKET"
        value = google_storage_bucket.openach_files.name
      }

      # Engine readiness (server/integrations/os/engineWiringReadiness.js)
      # checks these against the expected project, dlb-treasury-management.
      env {
        name  = "GCP_PROJECT"
        value = var.project_id
      }

      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }

      # Egress OS (server/integrations/os/egressOsEngine.js): the one outbound
      # door. All egress leaves via the VPC connector and Cloud NAT on this
      # static address (backends.tf); the engine probes it and refuses
      # destinations outside EGRESS_ALLOWED_HOSTS / on the retired-rail deny list.
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
        name  = "PRIVATE_ACCESS_IAP_AUDIENCE"
        value = "/projects/${data.google_project.current.number}/locations/${var.region}/services/${var.service_name}"
      }

      env {
        name  = "PRIVATE_ACCESS_FAMILY_EMAILS"
        value = join(",", [for p in var.family_accessors : trimprefix(p, "user:") if startswith(p, "user:")])
      }

      env {
        name  = "PRIVATE_ACCESS_FAMILY_DOMAINS"
        value = join(",", [for p in var.family_accessors : trimprefix(p, "domain:") if startswith(p, "domain:")])
      }

      env {
        name  = "PRIVATE_ACCESS_SERVICE_ACCOUNTS"
        value = join(",", [for p in local.platform_accessors : trimprefix(p, "serviceAccount:")])
      }

      env {
        name  = "PRIVATE_ACCESS_INGRESS"
        value = var.private_access_ingress
      }

      env {
        name  = "PRIVATE_ACCESS_IAP_ENABLED"
        value = "true"
      }

      env {
        name  = "PRIVATE_ACCESS_PUBLIC_INVOKER"
        value = "false"
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

      dynamic "env" {
        for_each = merge(
          { PAYMENT_HUB_LIVE = var.payment_hub_live ? "true" : "false" },
          local.payment_hub_base_url != "" ? { PAYMENT_HUB_BASE_URL = local.payment_hub_base_url } : {},
        )
        content {
          name  = env.key
          value = env.value
        }
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

      startup_probe {
        http_get {
          path = "/api/health/ready"
          port = 3002
        }
        initial_delay_seconds = 5
        period_seconds        = 10
        timeout_seconds       = 5
        failure_threshold     = 6
      }

      liveness_probe {
        http_get {
          path = "/api/health/live"
          port = 3002
        }
        initial_delay_seconds = 30
        period_seconds        = 20
        timeout_seconds       = 5
        failure_threshold     = 5
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [
    google_secret_manager_secret_iam_member.database_url_runtime,
    google_secret_manager_secret_iam_member.runtime_accessor,
    google_storage_bucket_iam_member.runtime_data,
    google_storage_bucket_iam_member.runtime_clearing_evidence,
    google_compute_router_nat.egress,
  ]

  lifecycle {
    # The deploy workflow rolls new images with `gcloud run deploy`; terraform
    # should not revert them on the next apply.
    ignore_changes = [template[0].containers[0].image, client, client_version]

    # Fail-closed: a live flag in runtime_environment must ship with the
    # Secret Manager credentials that engine needs, or the plan stops here
    # naming the missing secret instead of a 503 at payout time.
    precondition {
      condition     = length(local.missing_live_secrets) == 0
      error_message = "runtime_environment enables a live engine but secret_names lacks: ${join(", ", local.missing_live_secrets)}"
    }

    # Treasury -> Lili ACH credit: LILI_CLEARING_LIVE=true needs every Lili
    # credential container declared (secrets.tf lili_secret_names).
    precondition {
      condition     = length(local.missing_lili_secrets) == 0
      error_message = "LILI_CLEARING_LIVE=true but secret_names lacks ${join(", ", local.missing_lili_secrets)}. Add them to infra/gcp/terraform.tfvars (see terraform.tfvars.example) and seed with `gcloud secrets versions add`. The Lili OAuth tokens may also be captured into system_settings via server/scripts/liliMcpOAuthSetup.js, but the Secret Manager containers are still required for a live plan."
    }

    # Payment Processor OS: PAYMENT_PROCESSOR_LIVE=true needs the processor
    # credentials declared (secrets.tf payment_processor_secret_names) and the
    # approvalRef / screeningRef gates left on.
    precondition {
      condition     = length(local.missing_payment_processor_secrets) == 0
      error_message = "PAYMENT_PROCESSOR_LIVE=true but secret_names lacks ${join(", ", local.missing_payment_processor_secrets)}. Add them to infra/gcp/terraform.tfvars and seed with `gcloud secrets versions add`; GET /api/os/readiness/payment-processor reports the same blockers at runtime."
    }

    precondition {
      condition     = !local.payment_processor_gates_relaxed
      error_message = "PAYMENT_PROCESSOR_LIVE=true requires PAYMENT_PROCESSOR_REQUIRE_APPROVAL_REF and PAYMENT_PROCESSOR_REQUIRE_SCREENING_REF to stay \"true\": every real-value processor submission must carry a maker/checker approvalRef and a compliance screeningRef."
    }

    # Payment Gateway OS (trust distributions / disbursements):
    # PAYMENT_GATEWAY_LIVE=true needs the gateway secrets declared (secrets.tf
    # payment_gateway_secret_names), the processor engine live underneath it,
    # and the approvalRef / screeningRef / distribution-request gates left on.
    precondition {
      condition     = length(local.missing_payment_gateway_secrets) == 0
      error_message = "PAYMENT_GATEWAY_LIVE=true but secret_names lacks ${join(", ", local.missing_payment_gateway_secrets)}. Add them to infra/gcp/terraform.tfvars and seed with `gcloud secrets versions add`; GET /api/os/readiness/payment-gateway reports the same blockers at runtime."
    }

    precondition {
      condition     = !local.payment_gateway_without_processor
      error_message = "PAYMENT_GATEWAY_LIVE=true requires PAYMENT_PROCESSOR_LIVE=true: gateway disbursements dispatch through the payment-processor engine, which otherwise records every intent in shadow mode."
    }

    precondition {
      condition     = !local.payment_gateway_gates_relaxed
      error_message = "PAYMENT_GATEWAY_LIVE=true requires PAYMENT_GATEWAY_REQUIRE_APPROVAL_REF, PAYMENT_GATEWAY_REQUIRE_SCREENING_REF and PAYMENT_GATEWAY_REQUIRE_DISTRIBUTION_REQUEST to stay \"true\": every real-value distribution or disbursement must carry a maker/checker approvalRef, a compliance screeningRef and a two-trustee-approved dapp_distribution_requests row."
    }

    # Enterprise Network OS: ENTERPRISE_NETWORK_LIVE=true needs the callback
    # secret declared (secrets.tf enterprise_network_secret_names) and the
    # approvalRef / screeningRef gates left on.
    precondition {
      condition     = length(local.missing_enterprise_network_secrets) == 0
      error_message = "ENTERPRISE_NETWORK_LIVE=true but secret_names lacks ${join(", ", local.missing_enterprise_network_secrets)}. Add them to infra/gcp/terraform.tfvars and seed with `gcloud secrets versions add`; GET /api/os/readiness/enterprise-network reports the same blockers at runtime."
    }

    precondition {
      condition     = !local.enterprise_network_gates_relaxed
      error_message = "ENTERPRISE_NETWORK_LIVE=true requires ENTERPRISE_NETWORK_REQUIRE_APPROVAL_REF and ENTERPRISE_NETWORK_REQUIRE_SCREENING_REF to stay \"true\": every live registry change needs a checker approvalRef and every participant a compliance screeningRef."
    }

    # Private Electronic Payment Network: PRIVATE_PAYMENT_NETWORK_LIVE=true needs
    # its secrets declared (secrets.tf private_payment_network_secret_names),
    # the payment-processor and enterprise-network engines live underneath it,
    # and the approvalRef / screeningRef / participant gates left on.
    precondition {
      condition     = length(local.missing_private_payment_network_secrets) == 0
      error_message = "PRIVATE_PAYMENT_NETWORK_LIVE=true but secret_names lacks ${join(", ", local.missing_private_payment_network_secrets)}. Add them to infra/gcp/terraform.tfvars and seed with `gcloud secrets versions add`; GET /api/os/readiness/private-payment-network reports the same blockers at runtime."
    }

    precondition {
      condition     = !local.private_payment_network_without_dependencies
      error_message = "PRIVATE_PAYMENT_NETWORK_LIVE=true requires PAYMENT_PROCESSOR_LIVE=true and ENTERPRISE_NETWORK_LIVE=true: payouts dispatch through the payment-processor engine and are admitted only for active enterprise-network participants within an active exposure limit."
    }

    precondition {
      condition     = !local.private_payment_network_gates_relaxed
      error_message = "PRIVATE_PAYMENT_NETWORK_LIVE=true requires PRIVATE_PAYMENT_NETWORK_REQUIRE_APPROVAL_REF, PRIVATE_PAYMENT_NETWORK_REQUIRE_SCREENING_REF and PRIVATE_PAYMENT_NETWORK_REQUIRE_PARTICIPANT to stay \"true\": every real-value network transaction must carry a checker approvalRef and compliance screeningRef, and every payout an enterprise-network participant."
    }

    # Banking Aggregator: AGGREGATOR_DEFAULT_MODE=live needs the admin token and
    # per-connection credentials declared (secrets.tf missing_aggregator_secrets).
    # The approvalRef + screeningRef gate on a live push is not configurable.
    precondition {
      condition     = local.aggregator_mode_valid
      error_message = "AGGREGATOR_DEFAULT_MODE must be \"live\" or \"shadow\" (bankingAggregator.js falls back to shadow for anything else, silently disabling provider pushes)."
    }

    precondition {
      condition     = length(local.missing_aggregator_secrets) == 0
      error_message = "AGGREGATOR_DEFAULT_MODE=live but secret_names lacks ${join(", ", local.missing_aggregator_secrets)}. Add them to infra/gcp/terraform.tfvars and seed with `gcloud secrets versions add`; GET /api/os/readiness/aggregator reports the same blockers at runtime."
    }
  }
}

# Only the IAP service agent may invoke the service; humans reach it through
# IAP with roles/iap.httpsResourceAccessor (private_access.tf).
resource "google_cloud_run_v2_service_iam_member" "iap_invoker" {
  name     = google_cloud_run_v2_service.app.name
  location = google_cloud_run_v2_service.app.location
  role     = "roles/run.invoker"
  member   = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-iap.iam.gserviceaccount.com"
}
