# Mifos X administrative web app. The browser SPA cannot call Fineract's
# internal-ingress service directly, so an nginx sidecar provides the
# same-origin /fineract-provider/ reverse proxy.

data "google_project" "current" {}

locals {
  mifos_url     = "https://dlbtrust-mifos-${data.google_project.current.number}.${var.region}.run.app"
  fineract_host = trimprefix(google_cloud_run_v2_service.fineract.uri, "https://")
}

resource "google_service_account" "mifos" {
  count        = var.deploy_mifos ? 1 : 0
  account_id   = "dlbtrust-mifos-runtime"
  display_name = "Mifos X web app runtime"
}

resource "google_project_iam_member" "mifos_logging" {
  count   = var.deploy_mifos ? 1 : 0
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.mifos[0].email}"
}

resource "google_secret_manager_secret" "mifos_nginx_conf" {
  count     = var.deploy_mifos ? 1 : 0
  secret_id = "MIFOS_NGINX_CONF"

  replication {
    auto {}
  }

  labels = {
    service = "dlbtrust-mifos"
  }

  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_version" "mifos_nginx_conf" {
  count       = var.deploy_mifos ? 1 : 0
  secret      = google_secret_manager_secret.mifos_nginx_conf[0].id
  secret_data = <<-EOT
    server {
      listen 8080;
      resolver 169.254.169.254 valid=60s;
      location = /healthz { return 200 'ok'; add_header Content-Type text/plain; }
      location /fineract-provider/ {
        set $fineract "${local.fineract_host}";
        proxy_pass https://$fineract;
        proxy_ssl_server_name on;
        proxy_set_header Host $fineract;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 120s;
        client_max_body_size 20m;
      }
      location / {
        proxy_pass http://127.0.0.1:80;
        proxy_set_header Host $host;
      }
    }
  EOT
}

resource "google_secret_manager_secret_iam_member" "mifos_nginx_accessor" {
  count     = var.deploy_mifos ? 1 : 0
  secret_id = google_secret_manager_secret.mifos_nginx_conf[0].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.mifos[0].email}"
}

resource "google_cloud_run_v2_service" "mifos" {
  count               = var.deploy_mifos ? 1 : 0
  provider            = google-beta
  name                = "dlbtrust-mifos"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  launch_stage        = "BETA"
  iap_enabled         = true
  deletion_protection = false

  template {
    service_account = google_service_account.mifos[0].email

    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    vpc_access {
      connector = google_vpc_access_connector.run.id
      egress    = "ALL_TRAFFIC"
    }

    volumes {
      name = "mifos-nginx-conf"

      secret {
        secret = google_secret_manager_secret.mifos_nginx_conf[0].secret_id

        items {
          path    = "default.conf"
          version = "latest"
        }
      }
    }

    containers {
      name  = "proxy"
      image = var.mifos_proxy_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      volume_mounts {
        name       = "mifos-nginx-conf"
        mount_path = "/etc/nginx/conf.d"
      }

      startup_probe {
        http_get {
          path = "/healthz"
          port = 8080
        }
        period_seconds    = 10
        timeout_seconds   = 5
        failure_threshold = 18
      }

      depends_on = ["web"]
    }

    containers {
      name  = "web"
      image = var.mifos_image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      dynamic "env" {
        for_each = {
          FINERACT_API_URLS                    = local.mifos_url
          FINERACT_API_URL                     = local.mifos_url
          FINERACT_PLATFORM_TENANT_IDENTIFIER  = "default"
          FINERACT_PLATFORM_TENANTS_IDENTIFIER = "default"
        }
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.mifos_nginx_accessor,
    google_compute_router_nat.egress,
  ]

  lifecycle {
    ignore_changes = [client, client_version]
  }
}

resource "google_cloud_run_v2_service_iam_member" "mifos_iap_invoker" {
  count    = var.deploy_mifos ? 1 : 0
  name     = google_cloud_run_v2_service.mifos[0].name
  location = google_cloud_run_v2_service.mifos[0].location
  role     = "roles/run.invoker"
  member   = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-iap.iam.gserviceaccount.com"
}

resource "google_iap_web_cloud_run_service_iam_member" "mifos_operator" {
  for_each               = var.deploy_mifos ? toset(var.mifos_operators) : toset([])
  project                = data.google_project.current.number
  location               = var.region
  cloud_run_service_name = google_cloud_run_v2_service.mifos[0].name
  role                   = "roles/iap.httpsResourceAccessor"
  member                 = each.value
}
