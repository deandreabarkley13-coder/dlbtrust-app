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

# Pinned to the commit the Northflank instance runs (git.properties inside the
# container); Fineract's Liquibase migrates forward at boot, never back, so the
# image must not move ahead of a tested restore.
variable "fineract_image" {
  type    = string
  default = "us-east1-docker.pkg.dev/dlb-treasury-management/dlbtrust/fineract:02b49e20fd9a0b705ddac74258fefe68e647cc61"
}

variable "openach_image" {
  type    = string
  default = "us-east1-docker.pkg.dev/dlb-treasury-management/dlbtrust/openach:latest"
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
    APP_URL                        = "https://dlbtrust-app-r5oawu76jq-ue.a.run.app"
    AS2_MESSAGE_ID_DOMAIN          = "dlbtrust-app-r5oawu76jq-ue.a.run.app"
    PAYMENT_HUB_MODE               = "disabled"
    PAYMENT_HUB_LIVE               = "false"
    API_GATEWAY_PROVIDER           = "lili"
    LILI_CLEARING_LIVE             = "false"
    LILI_BUSINESS_USER_ID          = "aa9ffea8-a548-4ab6-af66-8abc0e0f910e"
    MELIO_EXPORT_DIR               = "/data/melio-exports"
    COMPLIANCE_PROVIDER            = "opensanctions"
    TRUST_MAKER_EMAIL              = "AnnRobinson1117@gmail.com"
    TRUST_CHECKER_EMAIL            = "deandreabarkley13@gmail.com"
    MELIO_SOURCE_TYPE              = "trust"
    MELIO_SOURCE_ACCOUNT_ID        = "1010"
    MELIO_ALLOWED_SOURCE_ACCOUNTS  = "1010,cash:CA-OPERATING"
    TRUST_SEGREGATED_ACCOUNT_CODES = "1210"
    TRUST_SIGNATURE_DOCUMENT_PATH  = "/data/governance/Trustees_Signature_Page.pdf"

    # Family Trust Company mandate + fixed-income distribution (docs/TRUST_CONTROL_PLANE.md)
    TRUST_LEGAL_NAME                   = "DEANDREA LAVAR BARKLEY FAMILY TRUST"
    TRUST_NAME                         = "DLB Trust"
    TRUST_MANDATE_RESERVE_INCOME_PCT   = "10"
    TRUST_MANDATE_ALLOW_CORPUS         = "false"
    TRUST_MANDATE_REQUIRE_CANONICAL    = "false"
    TRUST_MANDATE_ENFORCE              = "false"
    FIXED_INCOME_DISTRIBUTION_ENABLED  = "true"
    FIXED_INCOME_AUTO_STAGE            = "false"
    FIXED_INCOME_AUTO_EXECUTE          = "false"
    FIXED_INCOME_MIN_AMOUNT_USD        = "1"
    DISTRIBUTION_LIMIT_BENEFICIARY_USD = "100000"
    DISTRIBUTION_LIMIT_TRUSTEE_USD     = "500000"
    DISTRIBUTION_PURPOSES              = "lifestyle,medical,travel,home,education"
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

variable "clearing_evidence_retention_days" {
  description = "Bucket-lock retention for API-gateway clearing evidence objects (immutable for this long)."
  type        = number
  default     = 2555 # 7 years
}
