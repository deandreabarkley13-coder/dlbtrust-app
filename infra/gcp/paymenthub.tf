# Apache Fineract Payment Hub EE (PHEE) for PAYMENT_HUB_MODE=phee.
#
# Endpoint source, in order of precedence:
#   1. var.payment_hub_base_url — an existing/external PHEE channel connector
#      (HTTPS, or a private *.internal / *.svc address; paymentHubConfig.js
#      rejects anything else). Set this to reuse a deployment that lives
#      elsewhere; nothing is created here.
#   2. Otherwise this file runs the PHEE channel connector
#      (openmf/ph-ee-connector-channel, mirrored into Artifact Registry) as an
#      internal-ingress Cloud Run service, the same shape as dlbtrust-openach in
#      backends.tf: only reachable through the VPC connector, IAM invoker check
#      disabled because the app sends its own bearer token
#      (PAYMENT_HUB_AUTH_TOKEN) and Cloud Run would otherwise treat that header
#      as a malformed OIDC token.
#
# The app only talks to the channel connector (POST /channel/transfer,
# GET /channel/transactions/{id}, GET /actuator/health). The connector is the
# REST front door of PHEE; orchestration happens in Zeebe, which it reaches at
# var.phee_zeebe_gateway. Until a Zeebe cluster with the ACH BPMN is deployed
# (Helm ph-ee-engine on GKE, or Camunda SaaS reachable from the VPC), the
# connector answers health checks but rejects transfers with
# 412 "Process definition not found", so intents stay ORCHESTRATING.
#
# Image defaults the connector ships with that Cloud Run cannot satisfy are
# overridden below: it listens on 8443 with a PKCS12 keystore at /tls and puts
# actuator on a second port, so TLS is disabled (Cloud Run terminates TLS),
# server and management share 8080, and the Redis idempotency cache (no
# Memorystore here) is turned off along with its health indicator.

locals {
  deploy_phee          = var.payment_hub_base_url == "" && var.deploy_phee
  payment_hub_base_url = var.payment_hub_base_url != "" ? var.payment_hub_base_url : (local.deploy_phee ? google_cloud_run_v2_service.phee[0].uri : "")
}

resource "google_service_account" "phee" {
  count        = local.deploy_phee ? 1 : 0
  account_id   = "dlbtrust-phee-runtime"
  display_name = "Payment Hub EE channel connector runtime"
}

resource "google_project_iam_member" "phee_logging" {
  count   = local.deploy_phee ? 1 : 0
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.phee[0].email}"
}

resource "google_cloud_run_v2_service" "phee" {
  count                = local.deploy_phee ? 1 : 0
  name                 = "dlbtrust-phee"
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  invoker_iam_disabled = true
  deletion_protection  = false

  template {
    service_account = google_service_account.phee[0].email
    timeout         = "120s"

    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }

    annotations = {
      "run.googleapis.com/cpu-throttling" = "false"
    }

    vpc_access {
      connector = google_vpc_access_connector.run.id
      egress    = "ALL_TRAFFIC"
    }

    containers {
      image = var.phee_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = {
          SERVER_PORT                     = "8080"
          SERVER_SSL_ENABLED              = "false"
          MANAGEMENT_SERVER_PORT          = "8080"
          MANAGEMENT_HEALTH_REDIS_ENABLED = "false"
          REDIS_IDEMPOTENCY_ENABLED       = "false"
          ZEEBE_BROKER_CONTACTPOINT       = var.phee_zeebe_gateway
          DFSPIDS                         = var.payment_hub_tenant_id
          JAVA_TOOL_OPTIONS               = "-Xmx768m"
        }
        content {
          name  = env.key
          value = env.value
        }
      }

      startup_probe {
        http_get {
          path = "/actuator/health"
          port = 8080
        }
        initial_delay_seconds = 20
        period_seconds        = 10
        timeout_seconds       = 5
        failure_threshold     = 18
      }

      liveness_probe {
        http_get {
          path = "/actuator/health/liveness"
          port = 8080
        }
        period_seconds    = 30
        timeout_seconds   = 5
        failure_threshold = 5
      }
    }
  }

  depends_on = [google_project_iam_member.phee_logging]

  lifecycle {
    ignore_changes = [client, client_version]
  }
}
