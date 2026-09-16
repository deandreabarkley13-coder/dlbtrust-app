# Replaces the Northflank PostgreSQL 16 addon `dlbtrust-db`. Private IP only,
# reached from Cloud Run through the Cloud SQL connector (no external access
# is enabled, matching externalAccessEnabled=false on Northflank).

resource "google_compute_network" "vpc" {
  name                    = "dlbtrust"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "run" {
  name                     = "dlbtrust-run"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = "10.8.0.0/24"
  private_ip_google_access = true
}

resource "google_compute_global_address" "sql_range" {
  name          = "dlbtrust-sql-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "sql" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.sql_range.name]
  depends_on              = [google_project_service.enabled]
}

resource "random_id" "db_suffix" {
  byte_length = 2
}

resource "google_sql_database_instance" "ledger" {
  name             = "dlbtrust-db-${random_id.db_suffix.hex}"
  region           = var.region
  database_version = "POSTGRES_16"

  settings {
    tier              = var.db_tier
    availability_type = "ZONAL"
    disk_type         = "PD_SSD"
    disk_size         = var.db_disk_gb
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.vpc.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "06:00"
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 14
      }
    }

    maintenance_window {
      day  = 7
      hour = 8
    }

    insights_config {
      query_insights_enabled = true
    }
  }

  # The ledger is the system of record for GL postings; never let terraform
  # destroy it as a side effect of a refactor.
  deletion_protection = true

  depends_on = [google_service_networking_connection.sql]
}

resource "google_sql_database" "ledger" {
  name     = var.db_name
  instance = google_sql_database_instance.ledger.name
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_user" "app" {
  name     = var.db_user
  instance = google_sql_database_instance.ledger.name
  password = random_password.db.result
}

# The app reads DATABASE_URL (server/integrations/bonds/pgPool.js); the Cloud
# SQL connector exposes the instance on a unix socket, so the URL points at
# /cloudsql/<connection name> instead of a host. DB_SSL must stay unset: the
# socket is already encrypted by the connector and pg rejects ssl over it.
resource "google_secret_manager_secret" "database_url" {
  secret_id = "DATABASE_URL"
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_version" "database_url" {
  secret = google_secret_manager_secret.database_url.id
  secret_data = format(
    "postgresql://%s:%s@localhost/%s?host=/cloudsql/%s",
    google_sql_user.app.name,
    random_password.db.result,
    google_sql_database.ledger.name,
    google_sql_database_instance.ledger.connection_name,
  )
}

resource "google_secret_manager_secret_iam_member" "database_url_runtime" {
  secret_id = google_secret_manager_secret.database_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_vpc_access_connector" "run" {
  name          = "dlbtrust-run"
  region        = var.region
  network       = google_compute_network.vpc.name
  ip_cidr_range = "10.9.0.0/28"
  min_instances = 2
  max_instances = 3
  depends_on    = [google_project_service.enabled]
}
