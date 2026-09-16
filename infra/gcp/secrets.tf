# One Secret Manager secret per runtime credential. Terraform owns the
# containers only; the values are written by scripts/gcp/migrate-northflank-secrets.mjs
# (or `gcloud secrets versions add`), so a plan never carries a secret value.

resource "google_secret_manager_secret" "runtime" {
  for_each  = toset(var.secret_names)
  secret_id = each.value

  replication {
    auto {}
  }

  labels = {
    service = var.service_name
    source  = "northflank-dlbtrust-runtime"
  }

  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_iam_member" "runtime_accessor" {
  for_each  = google_secret_manager_secret.runtime
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
