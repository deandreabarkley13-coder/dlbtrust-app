# dlbtrust-app on Cloud Run. Pinned to exactly one instance: the journal,
# shutdown state and Melio CSV exports under /data assume a single writer, and
# the in-process schedulers (OpenSanctions refresh, Spritz/Melio status sync)
# must not run concurrently.

resource "google_cloud_run_v2_service" "app" {
  name                = var.service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
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

      dynamic "env" {
        for_each = var.runtime_environment
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name  = "GCS_CLEARING_EVIDENCE_BUCKET"
        value = google_storage_bucket.clearing_evidence.name
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
        for_each = google_secret_manager_secret.runtime
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
  }
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.app.name
  location = google_cloud_run_v2_service.app.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}
