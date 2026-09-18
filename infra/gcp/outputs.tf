output "service_url" {
  value = google_cloud_run_v2_service.app.uri
}

output "cloudsql_connection_name" {
  value = google_sql_database_instance.ledger.connection_name
}

output "data_bucket" {
  value = google_storage_bucket.data.name
}

output "clearing_evidence_bucket" {
  value = google_storage_bucket.clearing_evidence.name
}

output "artifact_registry" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "runtime_service_account" {
  value = google_service_account.runtime.email
}

output "deployer_service_account" {
  value = google_service_account.deployer.email
}

output "workload_identity_provider" {
  description = "Set as the GCP_WORKLOAD_IDENTITY_PROVIDER repo variable for .github/workflows/gcp-deploy.yml"
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "fineract_url" {
  value = "${google_cloud_run_v2_service.fineract.uri}/fineract-provider/api/v1"
}

output "openach_base_url" {
  value = "${google_cloud_run_v2_service.openach.uri}/api"
}

output "egress_ip" {
  value = google_compute_address.egress.address
}
