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

# Cloud Scheduler cron (America/New_York) for the OpenACH `cronnightly` job
# that builds NACHA files for due schedules (openach_cron.tf). Weeknights,
# after the day's settlements have been queued.
variable "openach_nightly_schedule" {
  type    = string
  default = "0 20 * * 1-5"
}

# Payment Hub EE channel connector (paymenthub.tf). Mirrored from Docker Hub
# openmf/ph-ee-connector-channel into Artifact Registry; Cloud Run only pulls
# from registries it can authenticate to.
variable "phee_image" {
  type    = string
  default = "us-east1-docker.pkg.dev/dlb-treasury-management/dlbtrust/ph-ee-connector-channel:mifos-v2.0.0"
}

# Mifos X web app (openmf/web-app), mirrored into Artifact Registry because
# Cloud Run only pulls from registries it can authenticate to. Mirror with:
#   docker pull openmf/web-app:latest
#   docker tag openmf/web-app:latest us-east1-docker.pkg.dev/dlb-treasury-management/dlbtrust/mifos-web-app:latest
#   docker push us-east1-docker.pkg.dev/dlb-treasury-management/dlbtrust/mifos-web-app:latest
variable "mifos_image" {
  type    = string
  default = "us-east1-docker.pkg.dev/dlb-treasury-management/dlbtrust/mifos-web-app:latest"
}

# Mifos X reverse proxy, mirrored from nginx:1.27-alpine. Mirror with:
#   docker pull nginx:1.27-alpine
#   docker tag nginx:1.27-alpine us-east1-docker.pkg.dev/dlb-treasury-management/dlbtrust/nginx:1.27-alpine
#   docker push us-east1-docker.pkg.dev/dlb-treasury-management/dlbtrust/nginx:1.27-alpine
variable "mifos_proxy_image" {
  type    = string
  default = "us-east1-docker.pkg.dev/dlb-treasury-management/dlbtrust/nginx:1.27-alpine"
}

variable "deploy_mifos" {
  description = "Run the Mifos X web app and same-origin Fineract proxy on Cloud Run."
  type        = bool
  default     = true
}

variable "mifos_operators" {
  description = "IAM principals allowed through IAP to the Mifos X web app."
  type        = list(string)
  default     = ["user:deandreabarkley13@gmail.com"]
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
    PAYMENT_HUB_MODE              = "phee"
    PAYMENT_HUB_ACCOUNTING_OWNER  = "dlbtrust"
    PAYMENT_HUB_TENANT_ID         = "dlbtrust"
    PAYMENT_HUB_TRANSFER_PATH     = "/channel/transfer"
    PAYMENT_HUB_CALLBACK_URL      = "https://dlbtrust-app-r5oawu76jq-ue.a.run.app/api/payment-hub/webhooks/status"
    PAYMENT_HUB_ACH_CONNECTOR_URL = "https://dlbtrust-app-r5oawu76jq-ue.a.run.app/api/payment-hub/connectors/us-ach/execute"
    PAYMENT_APPROVAL_THRESHOLD    = "2"
    # Lili as the settlement bank (server/integrations/payments/liliSettlementBankEngine.js).
    # Lili is RDFI-only: treasury (ODFI) -> NACHA CCD credit -> ODFI channel ->
    # Lili account; the Lili MCP feed is the S2S reconciliation channel. Full
    # account number + OAuth credentials are Secret Manager only
    # (secrets.tf lili_secret_names, enforced when LILI_CLEARING_LIVE=true).
    # Routing/account defaults mirror .env.example APISIX_ODFI/RDFI; confirm with
    # the operator before applying. Bootstrap: server/scripts/configureLiliChannels.js.
    API_GATEWAY_PROVIDER   = "lili"
    LILI_CLEARING_LIVE     = "true"
    LILI_CLEARING_SEC_CODE = "CCD"
    # Direct deposit into Lili (Sunrise Banks N.A., RDFI) is a Stripe Payout
    # (standard ACH) from the trust's live Stripe balance to the Lili account
    # registered as the Stripe external bank account; STRIPE_SECRET_KEY must be
    # live-mode. stripe_treasury (OutboundPayment) needs a live Treasury
    # financial account, which this Stripe account does not have.
    LILI_ORIGINATOR           = "stripe_payout"
    LILI_STRIPE_PAYOUT_METHOD = "standard"
    # The Lili account as registered on the trust's live Stripe account (****2959).
    STRIPE_PAYOUT_EXTERNAL_ACCOUNT_ID = "ba_1U3OcSFE15CwMad3BBD35eGT"
    # Stripe payment processing funds that balance: card / us_bank_account ACH
    # debit PaymentIntents and hosted Checkout links, confirmed by the Stripe
    # webhook (STRIPE_WEBHOOK_SECRET) and posted to the treasury ledger
    # (CA-STRIPE-BALANCE) before POST /stripe-intakes/:id/payout moves them to Lili.
    STRIPE_INTAKE_ENABLED         = "true"
    STRIPE_INTAKE_PAYMENT_METHODS = "card,us_bank_account"
    STRIPE_INTAKE_RETURN_URL      = "https://dlbtrust-app-r5oawu76jq-ue.a.run.app"
    LILI_STRIPE_TREASURY_NETWORK  = "ach"
    LILI_MCP_ENABLED              = "true"
    LILI_MCP_URL                  = "https://mcp.lili.co/mcp"
    LILI_OAUTH_BASE_URL           = "https://mcp.lili.co"
    LILI_DD_ROUTING_NUMBER        = "121145307"
    LILI_DD_ACCOUNT_NAME          = "DB NET MGMT LLC"
    # ODFI channel for the treasury -> Lili credit. Default: OpenACH, the
    # in-project dlbtrust-openach service (OPENACH_BASE_URL/API_TOKEN/API_KEY/
    # PAYMENT_TYPE_ID in secret_names; OPENACH_ODFI_ENABLED=false opts out).
    # Alternatives: MFTGATEWAY_PARTNER_AS2_ID (bank partner on the DLBTRUST-AS2 MFT Gateway
    # station, token pair in secret_names — see the EDI 820 block below),
    # ACH_SFTP_URL (sftp://user@host:port/incoming; key/password in secret_names
    # as ACH_SFTP_KEY / ACH_SFTP_PASSWORD) or ACH_MFT_CHANNEL (MFT OS channel id),
    # or a registered external AS2/production partner. Empty = fail closed:
    # LiliDirectDepositEngine.odfiStatus().ready=false, deposits stay awaiting_odfi.
    ACH_MFT_CHANNEL = ""
    # OpenACH only records schedules; the dlbtrust-openach-nightly job
    # (openach_cron.tf) builds the NACHA files into the OpenACH files bucket and
    # the app relays them to the ODFI through MFT Gateway (OpenAchFileRelay,
    # partner = MFTGATEWAY_PARTNER_AS2_ID). The bucket name is injected by
    # openach_cron.tf; this is the polling cadence (0 disables the relay).
    OPENACH_FILE_RELAY_INTERVAL_MS = "300000"
    ACH_SFTP_URL                   = ""
    # Interoperability OS (crossChainConversionEngine / m2mOsEngine). Live, as
    # on Northflank (DAPP_SHADOW=false there): DAPP_RPC_URL, DAPP_PRIVATE_KEY
    # and PAYMENT_DATA_ENCRYPTION_KEY come from the dlbtrust-runtime secret
    # group via migrate-northflank-secrets.mjs; the cloudrun.tf precondition
    # refuses this setting if they are not in secret_names.
    CROSS_CHAIN_ENABLED      = "true"
    CROSS_CHAIN_SHADOW       = "false"
    CROSS_CHAIN_SOURCE_CHAIN = "ethereum"
    CROSS_CHAIN_BRIDGE       = "circle-cctp"
    MELIO_EXPORT_DIR         = "/data/melio-exports"
    # Compliance gate (paymentComplianceGate.js): "live" permits real vendor
    # payment execution through the gateway clearing engine.
    VENDOR_PAYMENT_EXECUTION_MODE  = "live"
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
    # Bank-only distribution: payees are settlement banks (Lili), funded by the
    # Stripe balance, released through BankSettlementEngine (no policy contract).
    FIXED_INCOME_RAIL                  = "bank"
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
    # and the debtor side of LiliSettlementBankEngine._cfg() (ACH_ODFI_ROUTING /
    # ACH_ORIGINATOR_NAME). CLEARING_FUNDING_OPERATING_ACCOUNT (trust operating
    # account number) is Secret Manager only.
    ACH_ODFI_ROUTING      = "121145307"
    ACH_ODFI_NAME         = "SUNRISE BANKS NA"
    ACH_ORIGINATOR_NAME   = "DB NET MGMT LLC"
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
    # to this block once that partner profile exists. MFTGATEWAY_PARTNER_AS2_ID
    # is also the ODFI channel for NACHA batches (ACHEngine.mftGatewayPartnerConfig). Go-live order (see
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

variable "unseeded_secret_names" {
  description = <<-EOT
    Subset of secret_names whose Secret Manager container exists (declared, IAM
    granted) but has no version yet, so it is not mounted into the Cloud Run
    template: Cloud Run refuses to create a revision that references a secret
    without a version. Remove a name from this list once `gcloud secrets
    versions add` has been run for it. Typical: LILI_OAUTH_CLIENT_SECRET /
    LILI_OAUTH_REFRESH_TOKEN / LILI_BUSINESS_USER_ID before the one-time
    liliMcpOAuthSetup.js capture (those tokens live in system_settings anyway;
    the env value is only a fallback).
  EOT
  type        = list(string)
  default     = []
}

variable "clearing_evidence_retention_days" {
  description = "Bucket-lock retention for API-gateway clearing evidence objects (immutable for this long)."
  type        = number
  default     = 2555 # 7 years
}
