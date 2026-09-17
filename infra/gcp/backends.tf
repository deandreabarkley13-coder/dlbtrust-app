# Apache Fineract (GL source of truth) and OpenACH (ACH origination) move with
# the app so dlbtrust-app never leaves the VPC to reach them. Both are
# internal-ingress Cloud Run services: the app routes all egress through the
# connector and calls their run.app URLs; nothing else can reach them. Both
# authenticate at the application layer (Fineract basic auth, OpenACH API key)
# and Cloud Run would otherwise reject their Authorization headers as malformed
# OIDC tokens, so the IAM invoker check is disabled and reachability is what
# INGRESS_TRAFFIC_INTERNAL_ONLY restricts.
#
# Their PostgreSQL databases live on the same Cloud SQL instance as the ledger
# (separate databases and roles). Neither image ships the Cloud SQL socket
# factory, so they connect over the instance's private IP through the VPC.

locals {
  fineract_databases = ["fineract_tenants", "fineract_default"]
  sql_private_ip     = google_sql_database_instance.ledger.private_ip_address
}

# --- Fineract ---------------------------------------------------------------

resource "google_service_account" "fineract" {
  account_id   = "dlbtrust-fineract-runtime"
  display_name = "Fineract runtime"
}

resource "google_project_iam_member" "fineract_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.fineract.email}"
}

resource "google_sql_database" "fineract" {
  for_each = toset(local.fineract_databases)
  name     = each.value
  instance = google_sql_database_instance.ledger.name
}

# The database role keeps the Northflank password: the tenant store
# (fineract_tenants.tenant_server_connections.schema_password) holds it
# encrypted with Fineract's master password, and a fresh role password would
# make the migrated row unusable. FINERACT_DB_PASSWORD is populated from
# fineract-runtime/FINERACT_DEFAULT_TENANTDB_PWD by migrate-northflank-secrets.mjs
# before this is applied.
data "google_secret_manager_secret_version_access" "fineract_db_password" {
  secret     = google_secret_manager_secret.fineract["FINERACT_DB_PASSWORD"].id
  depends_on = [google_secret_manager_secret.fineract]
}

resource "google_sql_user" "fineract" {
  name     = "fineract"
  instance = google_sql_database_instance.ledger.name
  password = data.google_secret_manager_secret_version_access.fineract_db_password.secret_data
}

# Fineract's admin credential (mifos / FINERACT_PASSWORD) lives in the app's
# runtime secrets (secrets.tf); only the database role secret is declared here.
resource "google_secret_manager_secret" "fineract" {
  for_each  = toset(["FINERACT_DB_PASSWORD"])
  secret_id = each.value
  replication {
    auto {}
  }
  labels = {
    service = "dlbtrust-fineract"
  }
  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_iam_member" "fineract_accessor" {
  for_each  = google_secret_manager_secret.fineract
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.fineract.email}"
}

resource "google_cloud_run_v2_service" "fineract" {
  name                 = "dlbtrust-fineract"
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  invoker_iam_disabled = true
  deletion_protection  = false

  template {
    service_account = google_service_account.fineract.email
    timeout         = "300s"

    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }

    annotations = {
      "run.googleapis.com/cpu-throttling" = "false"
    }

    vpc_access {
      connector = google_vpc_access_connector.run.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = var.fineract_image

      ports {
        container_port = 8443
      }

      resources {
        limits = {
          cpu    = "2"
          memory = "2Gi"
        }
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = {
          FINERACT_SERVER_PORT                     = "8443"
          FINERACT_SERVER_SSL_ENABLED              = "false"
          FINERACT_NODE_ID                         = "1"
          FINERACT_HIKARI_DRIVER_SOURCE_CLASS_NAME = "org.postgresql.Driver"
          FINERACT_HIKARI_JDBC_URL                 = "jdbc:postgresql://${local.sql_private_ip}:5432/fineract_tenants"
          FINERACT_HIKARI_USERNAME                 = google_sql_user.fineract.name
          FINERACT_DEFAULT_TENANTDB_HOSTNAME       = local.sql_private_ip
          FINERACT_DEFAULT_TENANTDB_PORT           = "5432"
          FINERACT_DEFAULT_TENANTDB_NAME           = "fineract_default"
          FINERACT_DEFAULT_TENANTDB_UID            = google_sql_user.fineract.name
          JAVA_TOOL_OPTIONS                        = "-Xmx1536m"
        }
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = toset(["FINERACT_HIKARI_PASSWORD", "FINERACT_DEFAULT_TENANTDB_PWD"])
        content {
          name = env.value
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.fineract["FINERACT_DB_PASSWORD"].secret_id
              version = "latest"
            }
          }
        }
      }

      # Liquibase runs at boot and can take a few minutes on first start.
      startup_probe {
        http_get {
          path = "/fineract-provider/actuator/health"
          port = 8443
        }
        initial_delay_seconds = 60
        period_seconds        = 15
        timeout_seconds       = 10
        failure_threshold     = 40
      }

      liveness_probe {
        http_get {
          path = "/fineract-provider/actuator/health"
          port = 8443
        }
        period_seconds    = 30
        timeout_seconds   = 10
        failure_threshold = 5
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.fineract_accessor,
    google_sql_database.fineract,
  ]

  lifecycle {
    ignore_changes = [client, client_version]
  }
}

# --- OpenACH ----------------------------------------------------------------

resource "google_service_account" "openach" {
  account_id   = "dlbtrust-openach-runtime"
  display_name = "OpenACH runtime"
}

resource "google_project_iam_member" "openach_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.openach.email}"
}

resource "google_sql_database" "openach" {
  name     = "openach"
  instance = google_sql_database_instance.ledger.name
}

resource "random_password" "openach_db" {
  length  = 32
  special = false
}

resource "google_sql_user" "openach" {
  name     = "openach"
  instance = google_sql_database_instance.ledger.name
  password = random_password.openach_db.result
}

# OPENACH_ENCRYPTION_KEY cannot be rotated once data exists (it encrypts the
# bank-account columns), so both keys are migrated verbatim from Northflank.
resource "google_secret_manager_secret" "openach" {
  for_each  = toset(["OPENACH_DATABASE_URL", "OPENACH_ENCRYPTION_KEY", "OPENACH_VALIDATION_KEY"])
  secret_id = each.value
  replication {
    auto {}
  }
  labels = {
    service = "dlbtrust-openach"
  }
  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_version" "openach_database_url" {
  secret = google_secret_manager_secret.openach["OPENACH_DATABASE_URL"].id
  secret_data = format(
    "postgres://%s:%s@%s:5432/%s?sslmode=require",
    google_sql_user.openach.name,
    random_password.openach_db.result,
    local.sql_private_ip,
    google_sql_database.openach.name,
  )
}

resource "google_secret_manager_secret_iam_member" "openach_accessor" {
  for_each  = google_secret_manager_secret.openach
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.openach.email}"
}

resource "google_cloud_run_v2_service" "openach" {
  name                 = "dlbtrust-openach"
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  invoker_iam_disabled = true
  deletion_protection  = false

  template {
    service_account = google_service_account.openach.email

    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }

    vpc_access {
      connector = google_vpc_access_connector.run.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = var.openach_image

      ports {
        container_port = 80
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
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

      startup_probe {
        tcp_socket {
          port = 80
        }
        period_seconds    = 10
        failure_threshold = 18
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.openach_database_url,
    google_secret_manager_secret_iam_member.openach_accessor,
  ]

  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }
}

# Reaching an internal-ingress run.app URL requires the caller to send all of
# its egress through the VPC, which in turn needs Cloud NAT for the app's
# internet traffic (Spritz, Moov, banks). Side effect: one stable egress IP.
resource "google_compute_router" "egress" {
  name    = "dlbtrust-egress"
  region  = var.region
  network = google_compute_network.vpc.id
}

resource "google_compute_address" "egress" {
  name   = "dlbtrust-egress"
  region = var.region
}

resource "google_compute_router_nat" "egress" {
  name                               = "dlbtrust-egress"
  router                             = google_compute_router.egress.name
  region                             = var.region
  nat_ip_allocate_option             = "MANUAL_ONLY"
  nat_ips                            = [google_compute_address.egress.self_link]
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}
