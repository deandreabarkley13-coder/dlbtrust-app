variable "project_id" {
  description = "GCP project that hosts the trust platform"
  type        = string
  default     = "dlb-treasury-management"
}

variable "region" {
  description = "Region for Cloud Run, Cloud SQL and the /data bucket (Northflank ran in us-east1)"
  type        = string
  default     = "us-east1"
}

variable "service_name" {
  type    = string
  default = "dlbtrust-app"
}

variable "image" {
  description = "Container image to deploy; the deploy workflow overrides this per commit"
  type        = string
  default     = "us-east1-docker.pkg.dev/dlb-treasury-management/dlbtrust/dlbtrust-app:latest"
}

variable "db_tier" {
  description = "Cloud SQL machine tier. db-g1-small matches the nf-compute-20 addon; use db-custom-2-7680 for production load"
  type        = string
  default     = "db-g1-small"
}

variable "db_disk_gb" {
  type    = number
  default = 10
}

variable "db_name" {
  type    = string
  default = "dlbtrust"
}

variable "db_user" {
  type    = string
  default = "dlbtrust"
}

variable "github_repository" {
  description = "owner/repo allowed to deploy through Workload Identity Federation"
  type        = string
  default     = "deandreabarkley13-coder/dlbtrust-app"
}

variable "runtime_environment" {
  description = "Non-secret runtime variables (mirrors northflank/service-dlbtrust-app.json runtimeEnvironment)"
  type        = map(string)
  default = {
    NODE_ENV                       = "production"
    PAYMENT_HUB_MODE               = "disabled"
    PAYMENT_HUB_LIVE               = "false"
    MELIO_EXPORT_DIR               = "/data/melio-exports"
    COMPLIANCE_PROVIDER            = "opensanctions"
    TRUST_MAKER_EMAIL              = "AnnRobinson1117@gmail.com"
    TRUST_CHECKER_EMAIL            = "deandreabarkley13@gmail.com"
    MELIO_SOURCE_TYPE              = "trust"
    MELIO_SOURCE_ACCOUNT_ID        = "1010"
    MELIO_ALLOWED_SOURCE_ACCOUNTS  = "1010,cash:CA-OPERATING"
    TRUST_SEGREGATED_ACCOUNT_CODES = "1210"
    TRUST_SIGNATURE_DOCUMENT_PATH  = "/data/governance/Trustees_Signature_Page.pdf"
  }
}

variable "secret_names" {
  description = <<-EOT
    Secret Manager secret ids exposed to the service as environment variables of
    the same name. Populate with scripts/gcp/migrate-northflank-secrets.mjs
    --list, which prints the names in the dlbtrust-runtime secret group.
    DATABASE_URL is always added by cloudsql.tf and must not be listed here.
  EOT
  type        = list(string)
  default     = []
}
