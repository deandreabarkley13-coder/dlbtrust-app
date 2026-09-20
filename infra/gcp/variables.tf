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

# Payment Hub EE channel connector (paymenthub.tf). Mirrored from Docker Hub
# openmf/ph-ee-connector-channel into Artifact Registry; Cloud Run only pulls
# from registries it can authenticate to.
variable "phee_image" {
  type    = string
  default = "us-east1-docker.pkg.dev/dlb-treasury-management/dlbtrust/ph-ee-connector-channel:mifos-v2.0.0"
}

variable "deploy_phee" {
  description = "Run the PHEE channel connector as the dlbtrust-phee Cloud Run service. Ignored when payment_hub_base_url is set."
  type        = bool
  default     = true
}

variable "payment_hub_base_url" {
  description = "Existing/external PHEE channel connector base URL (https:// or a private *.internal/*.svc host). Empty = use the dlbtrust-phee Cloud Run service."
  type        = string
  default     = ""

  validation {
    condition     = var.payment_hub_base_url == "" || can(regex("^https://", var.payment_hub_base_url)) || can(regex("^http://[^/]+\\.(internal|svc|svc\\.cluster\\.local)(:[0-9]+)?(/|$)", var.payment_hub_base_url))
    error_message = "payment_hub_base_url must be HTTPS or a private *.internal / *.svc address (paymentHubConfig.js isSecureEndpoint)."
  }
}

variable "phee_zeebe_gateway" {
  description = "Zeebe gateway host:port the channel connector orchestrates through (private address reachable from the VPC connector). Points at an unreachable loopback until a Zeebe/ph-ee-engine cluster exists, so transfers fail fast with 412 instead of hanging."
  type        = string
  default     = "127.0.0.1:26500"
}

variable "payment_hub_live" {
  description = "PAYMENT_HUB_LIVE. Apply with false for the shadow/tiny end-to-end check, then true to allow transmission."
  type        = bool
  default     = true
}

variable "payment_hub_tenant_id" {
  type    = string
  default = "dlbtrust"
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
    NODE_ENV              = "production"
    APP_URL               = "https://dlbtrust-app-r5oawu76jq-ue.a.run.app"
    AS2_MESSAGE_ID_DOMAIN = "dlbtrust-app-r5oawu76jq-ue.a.run.app"
    # Payment Hub EE (server/integrations/paymentHub). PAYMENT_HUB_BASE_URL is
    # derived in cloudrun.tf from paymenthub.tf; tokens/keys are Secret Manager
    # entries (secrets.tf payment_hub_secret_names).
    PAYMENT_HUB_MODE               = "phee"
    PAYMENT_HUB_ACCOUNTING_OWNER   = "dlbtrust"
    PAYMENT_HUB_TENANT_ID          = "dlbtrust"
    PAYMENT_HUB_TRANSFER_PATH      = "/channel/transfer"
    PAYMENT_HUB_CALLBACK_URL       = "https://dlbtrust-app-r5oawu76jq-ue.a.run.app/api/payment-hub/webhooks/status"
    PAYMENT_HUB_ACH_CONNECTOR_URL  = "https://dlbtrust-app-r5oawu76jq-ue.a.run.app/api/payment-hub/connectors/us-ach/execute"
    PAYMENT_APPROVAL_THRESHOLD     = "2"
    API_GATEWAY_PROVIDER           = "lili"
    LILI_CLEARING_LIVE             = "true"
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
    TRUST_LEGAL_NAME                 = "DEANDREA LAVAR BARKLEY FAMILY TRUST"
    TRUST_NAME                       = "DLB Trust"
    TRUST_MANDATE_RESERVE_INCOME_PCT = "10"
    TRUST_MANDATE_ALLOW_CORPUS       = "false"
    TRUST_MANDATE_REQUIRE_CANONICAL  = "false"
    TRUST_MANDATE_ENFORCE            = "false"
    # Custody OS issuer register feed is self-custody and does not add reserve.
    CUSTODY_ISSUER_NAME        = "DEANDREA LAVAR BARKLEY TRUST COMPANY"
    CUSTODY_FIXED_INCOME_SYNC  = "true"
    CUSTODY_GL_BOOKING_ENABLED = "true"
    CUSTODY_ASSET_GL_ACCOUNT   = "1250"
    CUSTODY_CONTROL_GL_ACCOUNT = "1251"
    CUSTODY_CASH_SYNC          = "true"
    CUSTODY_CASH_ACCOUNT_ID    = "CUS-THIRD-PARTY-CASH"
    # Attestation OS live reserve observer and scheduler.
    ATTESTATION_ENFORCEMENT            = "strict"
    ATTESTATION_FRESH_MINUTES          = "60"
    ATTESTATION_RUN_INTERVAL_MINUTES   = "30"
    FIXED_INCOME_DISTRIBUTION_ENABLED  = "true"
    FIXED_INCOME_AUTO_STAGE            = "false"
    FIXED_INCOME_AUTO_EXECUTE          = "false"
    FIXED_INCOME_MIN_AMOUNT_USD        = "1"
    DISTRIBUTION_LIMIT_BENEFICIARY_USD = "100000"
    DISTRIBUTION_LIMIT_TRUSTEE_USD     = "500000"
    DISTRIBUTION_PURPOSES              = "lifestyle,medical,travel,home,education"

    # Lili (DB NET MGMT LLC) on-us ACH: ODFI = RDFI. Routing is from Lili's ACH
    # instructions letter (Sunrise Banks N.A.). Account numbers live in Secret
    # Manager (APISIX_ODFI_ACCOUNT / APISIX_RDFI_ACCOUNT), never here.
    PAYMENT_MODE                     = "production"
    NACHA_ODFI_ROUTING               = "091017138"
    NACHA_ORIGINATOR_NAME            = "DB NET MGMT"
    NACHA_COMPANY_NAME               = "DB NET MGMT"
    NACHA_IMMEDIATE_ORIGIN_NAME      = "DB NET MGMT"
    NACHA_IMMEDIATE_DESTINATION_NAME = "SUNRISE BANKS NA"
    ACH_IMMEDIATE_ORIGIN             = "1091017138"
    ACH_COMPANY_ID                   = "1091017138"
    # usAchConnector.js originator block (what PHEE hands to /connectors/us-ach/execute)
    ACH_ODFI_ROUTING      = "091017138"
    ACH_ODFI_NAME         = "SUNRISE BANKS NA"
    ACH_ORIGINATOR_NAME   = "DB NET MGMT"
    ACH_COMPANY_NAME      = "DB NET MGMT"
    APISIX_ODFI_ROUTING   = "091017138"
    APISIX_ODFI_NAME      = "DB NET MGMT"
    APISIX_ODFI_BANK_NAME = "Lili (Sunrise Banks N.A.)"
    APISIX_RDFI_ROUTING   = "091017138"
    APISIX_RDFI_NAME      = "DB NET MGMT"
    APISIX_RDFI_BANK_NAME = "Lili (Sunrise Banks N.A.)"
    APISIX_ALLOW_HTTP     = "false"

    # ERP payout → X12 820 remittance over AS2 (server/integrations/edi). Shadow
    # by default: transmission needs EDI_820_LIVE=true AND CANONICAL_FUNDING_LIVE=true.
    # Secret Manager only (list in var.secret_names, never here):
    # MFTGATEWAY_API_TOKEN_ID, MFTGATEWAY_API_TOKEN_SECRET, EDI_820_ODFI_ACCOUNT.
    # Deliberately unset until the bank is registered as a Partner in the MFT
    # Gateway console: MFTGATEWAY_PARTNER_AS2_ID and EDI_820_RECEIVER_ID. Both
    # take the SAME value — the bank's registered AS2 identifier — and are added
    # to this block once that partner profile exists. Go-live order (see
    # docs/GCP_MIGRATION.md "EDI 820 go-live"): token secrets → partner IDs →
    # GET /api/finops/edi/820/readiness reports ready:true with the station
    # found → only then flip EDI_820_LIVE to "true".
    EDI_820_LIVE                 = "false"
    EDI_820_TRANSPORT            = "mftgateway"
    MFTGATEWAY_API_URL           = "https://api.mftgateway.com"
    MFTGATEWAY_STATION_AS2_ID    = "DLBTRUST-AS2"
    EDI_820_SENDER_ID            = "DLBTRUST-AS2"
    EDI_820_SENDER_QUALIFIER     = "ZZ"
    EDI_820_RECEIVER_QUALIFIER   = "ZZ"
    EDI_820_PAYER_NAME           = "DB NET MGMT"
    EDI_820_ODFI_ROUTING         = "091017138"
    ERP_PAYOUT_CASH_GL_CODE      = "1000"
    ERP_PAYOUT_CLEARING_GL_CODE  = "1150"
    ERP_PAYOUT_SOURCE_ACCOUNT_ID = "CA-OPERATING"
  }
}

variable "secret_names" {
  description = <<-EOT
    Secret Manager secret ids exposed to the service as environment variables of
    the same name. Populate with scripts/gcp/migrate-northflank-secrets.mjs
    --list, which prints the names in the dlbtrust-runtime secret group.
    DATABASE_URL is always added by cloudsql.tf and must not be listed here.
    MFTGATEWAY_API_TOKEN_ID and MFTGATEWAY_API_TOKEN_SECRET (EDI 820 / MFT
    Gateway REST token pair) MUST be included in this list (in the untracked
    infra/gcp/terraform.tfvars) and must NOT appear in runtime_environment —
    Cloud Run rejects a name that is both plain env and secret-backed.
  EOT
  type        = list(string)
  default     = []
}

variable "clearing_evidence_retention_days" {
  description = "Bucket-lock retention for API-gateway clearing evidence objects (immutable for this long)."
  type        = number
  default     = 2555 # 7 years
}
