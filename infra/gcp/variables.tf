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
variable "pe_holdings_wire_schedule" {
  description = <<-EOT
    Cloud Scheduler cadence (America/New_York) of dlbtrust-pe-holdings-wire,
    which runs `privateEquityHoldingsWire.js --evaluate`: it re-checks the
    private-equity asset backing of the PFTC private-placement bond and never
    books GL lines or sends a wire.
  EOT
  type        = string
  default     = "0 6 * * 1-5"
}

variable "settlement_funding_pipeline_schedule" {
  description = <<-EOT
    Cloud Scheduler cadence (America/New_York) of dlbtrust-settlement-funding-pipeline,
    which runs `fundSettlementAccount.js pipeline --advance`: it settles only
    funding wires whose bank settlement reference is recorded, and never
    originates or transmits a wire.
  EOT
  type        = string
  default     = "*/30 7-20 * * 1-5"
}

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

variable "family_accessors" {
  description = "IAM principals (user:/domain:) allowed through IAP to dlbtrust-app. The user: emails / domain: names are also the app's PRIVATE_ACCESS_FAMILY_EMAILS / _DOMAINS allow-list."
  type        = list(string)
  default     = ["user:deandreabarkley13@gmail.com"]

  validation {
    condition     = length(var.family_accessors) > 0 && alltrue([for p in var.family_accessors : startswith(p, "user:") || startswith(p, "domain:")])
    error_message = "family_accessors must be non-empty and contain only user: or domain: principals (never allUsers / allAuthenticatedUsers)."
  }
}

variable "scheduler_accessors" {
  description = "Service-account principals (Cloud Scheduler OIDC callers) allowed through IAP to dlbtrust-app."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for p in var.scheduler_accessors : startswith(p, "serviceAccount:")])
    error_message = "scheduler_accessors must contain only serviceAccount: principals."
  }
}

variable "private_access_ingress" {
  description = "Cloud Run ingress for dlbtrust-app. IAP fronts the run.app URL directly; INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER additionally requires a load balancer / VPN path."
  type        = string
  default     = "INGRESS_TRAFFIC_ALL"

  validation {
    condition     = contains(["INGRESS_TRAFFIC_ALL", "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"], var.private_access_ingress)
    error_message = "private_access_ingress must be INGRESS_TRAFFIC_ALL or INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER."
  }
}

# Transfer API facade on GCP API Gateway (transfer_api.tf): one hostname for
# maker/checker transfer clients -> IAP -> Cloud Run /api/transfer/v1 ->
# Enterprise ODFI OS -> Clearing Agent. The gateway is not a payment rail; it
# authenticates, applies quotas and routes. Off by default (paid product).
variable "transfer_api_enabled" {
  description = "Create the API Gateway facade, its service account and read-only API key."
  type        = bool
  default     = false
}

variable "transfer_api_live" {
  description = "TRANSFER_API_LIVE: the facade reports live (still gated by enterprise-odfi readiness: a verified external sponsor network is required)."
  type        = bool
  default     = false
}

variable "transfer_api_id_token_audience" {
  description = "Audience callers must put in their Google ID token (x-google-audiences). Empty = https://transfer.<project_id>.dlbtrust."
  type        = string
  default     = ""
}

variable "iap_oauth_client_id" {
  description = "OAuth client id of the IAP-protected Cloud Run service; the gateway mints its backend OIDC token with this audience so IAP admits it. Empty = backend URL (only valid without IAP)."
  type        = string
  default     = ""
}

variable "transfer_api_write_quota_per_minute" {
  description = "Gateway quota for transfer writes (create / release / cancel) per minute."
  type        = number
  default     = 30
}

variable "transfer_api_read_quota_per_minute" {
  description = "Gateway quota for transfer reads per minute."
  type        = number
  default     = 300
}

# Cloud VPN to a trusted family site (private_access.tf). Off until
# vpn_peer_ip is set; the IKE pre-shared key lives in Secret Manager.
variable "vpn_peer_ip" {
  description = "Public IP of the family site's VPN device. Empty = no VPN."
  type        = string
  default     = ""
}

variable "vpn_shared_secret_secret_id" {
  description = "Secret Manager secret id holding the IKE pre-shared key."
  type        = string
  default     = "VPN_FAMILY_SHARED_SECRET"
}

variable "vpn_cloud_asn" {
  type    = number
  default = 64514
}

variable "vpn_peer_asn" {
  type    = number
  default = 65001
}

variable "vpn_bgp_ip_range" {
  description = "Cloud Router BGP interface address (link-local /30)."
  type        = string
  default     = "169.254.0.1/30"
}

variable "vpn_peer_bgp_ip" {
  type    = string
  default = "169.254.0.2"
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
    # Direct deposit into Lili (Sunrise Banks N.A., RDFI) is a NACHA CCD credit
    # built by the treasury and transmitted over the ODFI channel
    # (OpenACH/AS2/MFT/SFTP); fixed-income distributions are funded from the
    # bucket's canonical GL account in Fineract (CanonicalFundingSource) and
    # gated by ReserveEngine.assertSpendable. Stripe is not a funding source.
    LILI_ORIGINATOR = "nacha"
    # Stripe payment processing funds that balance: card / us_bank_account ACH
    # debit PaymentIntents and hosted Checkout links, confirmed by the Stripe
    # webhook (STRIPE_WEBHOOK_SECRET) and posted to the treasury ledger
    # (CA-STRIPE-BALANCE) before POST /stripe-intakes/:id/payout moves them to Lili.
    STRIPE_INTAKE_ENABLED         = "true"
    STRIPE_INTAKE_PAYMENT_METHODS = "card,us_bank_account"
    STRIPE_INTAKE_RETURN_URL      = "https://dlbtrust-app-r5oawu76jq-ue.a.run.app"
    # Payment Processor OS (server/integrations/os/paymentProcessorOsEngine.js):
    # maker/checker front door to paymentProcessorServerEngine / gateway /
    # Payment Hub. Shadow until PAYMENT_PROCESSOR_LIVE=true; a live plan needs
    # STRIPE_SECRET_KEY, STRIPE_PAYMENTS_SECRET_KEY and PAYMENT_DATA_ENCRYPTION_KEY
    # in secret_names (cloudrun.tf precondition, secrets.tf
    # missing_payment_processor_secrets). The approval/screening gates cannot be
    # relaxed in a live plan; GET /api/os/readiness/payment-processor lists the blockers.
    PAYMENT_PROCESSOR_LIVE                  = "false"
    PAYMENT_PROCESSOR_REQUIRE_APPROVAL_REF  = "true"
    PAYMENT_PROCESSOR_REQUIRE_SCREENING_REF = "true"
    PAYMENT_PROCESSOR_DEFAULT               = "lili"
    # Payment Gateway OS (server/integrations/os/paymentGatewayOsEngine.js):
    # trust distribution / disbursement gateway over paymentGatewayServerEngine
    # (tokenized beneficiary ACH/card/wallet/crypto methods, submit → approve).
    # Shadow until PAYMENT_GATEWAY_LIVE=true; a live plan additionally needs
    # PAYMENT_PROCESSOR_LIVE=true, PAYMENT_GATEWAY_WEBHOOK_SECRET,
    # PAYMENT_DATA_ENCRYPTION_KEY and STRIPE_PAYMENTS_SECRET_KEY in secret_names
    # (cloudrun.tf precondition, secrets.tf missing_payment_gateway_secrets).
    # REQUIRE_DISTRIBUTION_REQUEST=true binds every intent to an approved
    # dapp_distribution_requests row; MAX_DISBURSEMENT_CENTS caps one intent.
    PAYMENT_GATEWAY_LIVE                         = "false"
    PAYMENT_GATEWAY_REQUIRE_APPROVAL_REF         = "true"
    PAYMENT_GATEWAY_REQUIRE_SCREENING_REF        = "true"
    PAYMENT_GATEWAY_REQUIRE_DISTRIBUTION_REQUEST = "true"
    PAYMENT_GATEWAY_DEFAULT_PROCESSOR            = ""
    PAYMENT_GATEWAY_MAX_DISBURSEMENT_CENTS       = ""
    # Enterprise Network OS (server/integrations/os/enterpriseNetworkOsEngine.js):
    # trust-network registry (participant onboarding, routing policy, per-
    # participant exposure limits) via submit → approve; never moves money.
    # Shadow until ENTERPRISE_NETWORK_LIVE=true; a live plan needs
    # ENTERPRISE_NETWORK_WEBHOOK_SECRET in secret_names (cloudrun.tf
    # precondition, secrets.tf missing_enterprise_network_secrets) and the
    # approvalRef / screeningRef gates left on.
    ENTERPRISE_NETWORK_LIVE                  = "false"
    ENTERPRISE_NETWORK_REQUIRE_APPROVAL_REF  = "true"
    ENTERPRISE_NETWORK_REQUIRE_SCREENING_REF = "true"
    # Private Electronic Payment Network (server/integrations/os/
    # privatePaymentNetworkOsEngine.js): clears trust ledger accounts to
    # approved payout instruments of enterprise-network participants through
    # CashEngine / paymentGatewayServerEngine. Shadow until
    # PRIVATE_PAYMENT_NETWORK_LIVE=true; a live plan additionally needs
    # PAYMENT_PROCESSOR_LIVE=true, ENTERPRISE_NETWORK_LIVE=true,
    # PRIVATE_PAYMENT_NETWORK_WEBHOOK_SECRET, PAYMENT_DATA_ENCRYPTION_KEY and
    # STRIPE_PAYMENTS_SECRET_KEY in secret_names (secrets.tf
    # missing_private_payment_network_secrets) and every REQUIRE_* gate on.
    PRIVATE_PAYMENT_NETWORK_LIVE                  = "false"
    PRIVATE_PAYMENT_NETWORK_REQUIRE_APPROVAL_REF  = "true"
    PRIVATE_PAYMENT_NETWORK_REQUIRE_SCREENING_REF = "true"
    PRIVATE_PAYMENT_NETWORK_REQUIRE_PARTICIPANT   = "true"
    PRIVATE_PAYMENT_NETWORK_DEFAULT_PROCESSOR     = ""
    PRIVATE_PAYMENT_NETWORK_MAX_TRANSFER_CENTS    = ""
    # Family-only network: payouts reach only trustee/beneficiary participants
    # of the trust; Stripe and third-party card/wallet processors are refused
    # (409) and reported non-real-value. Book transfers between the Fineract
    # sub-accounts (internal_ledger) are the intended distribution path.
    PRIVATE_PAYMENT_NETWORK_FAMILY_ONLY              = "true"
    PRIVATE_PAYMENT_NETWORK_FAMILY_PARTICIPANT_TYPES = "trustee,beneficiary,family"
    PRIVATE_PAYMENT_NETWORK_EXCLUDED_PROCESSORS      = "stripe_treasury,stripe,pdcflow,skrill"
    # Private access guard (server/integrations/auth/privateAccessGuard.js):
    # every request must carry an IAP assertion for a family identity or the
    # scheduler's OIDC token; only /api/health is exempt. IAP audience and the
    # family list are stamped from cloudrun.tf (var.family_accessors).
    PRIVATE_ACCESS_MODE         = "enforce"
    PRIVATE_ACCESS_EXEMPT_PATHS = "/api/health"
    # mft_as2 payout processor: approved payouts become a single-entry NACHA
    # credit file submitted from the MFTGATEWAY_STATION_AS2_ID station to the
    # participant's AS2 partner (endpoint.partnerAs2Id, else
    # MFTGATEWAY_PARTNER_AS2_ID). Shadow until this is "true"; also needs
    # PRIVATE_PAYMENT_NETWORK_LIVE=true and MFTGATEWAY_API_TOKEN_ID/SECRET.
    PRIVATE_PAYMENT_NETWORK_MFT_LIVE = "false"
    # Core-banking funding source of record for the private payment network:
    # the Fineract savings account (dlbtrust-fineract Cloud Run; FINERACT_URL,
    # FINERACT_USERNAME, FINERACT_PASSWORD, FINERACT_TENANT_ID come from Secret
    # Manager). A real-value payout is admitted only against the Fineract
    # account linked to the source ledger account (cash_accounts
    # .linked_fineract_account_id, else CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID) and
    # is withdrawn from it before the processor is called (redeposited on
    # return). Shadow until CANONICAL_FUNDING_LIVE=true.
    # PRIVATE_PAYMENT_NETWORK_CORE_BANKING=false runs sub-ledger only.
    CANONICAL_FUNDING_LIVE               = "false"
    CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID = ""
    CANONICAL_FUNDING_PAYMENT_TYPE_ID    = "1"
    PRIVATE_PAYMENT_NETWORK_CORE_BANKING = "true"
    # Fineract trust account structure (server/integrations/fineract/
    # trustAccountStructure.js): principal (corpus, GL 3000), interest income
    # (GL 4000; coupon deposits land here), and one savings sub-account per
    # active CRM trustee / beneficiary, resolved by externalId
    # (holder:<TRUST_HOLDER_ID>:{principal,interest-income},
    # trustee:<contact_id>:savings, beneficiary:<contact_id>:savings).
    # Provisioned with POST /api/fineract/trust-accounts/provision (admin) and
    # reported in /api/os/readiness/{accounting,fixed-income}. Leave the two
    # ids empty to resolve by externalId.
    TRUST_HOLDER_ID                             = "dlb-irrevocable-trust"
    FINERACT_PRINCIPAL_SAVINGS_ACCOUNT_ID       = ""
    FINERACT_INTEREST_INCOME_SAVINGS_ACCOUNT_ID = ""
    # H2H Discovery OS (server/integrations/os/h2hDiscoveryOsEngine): web data
    # scraping of bank host-to-host onboarding docs for AS2 ID / client ID /
    # base URL / SFTP host / MDN / cert fingerprint. HTTPS only, hosts must be
    # allow-listed here (comma-separated; subdomains match), scraped credentials
    # are refused, candidates need trustee confirm + a second trustee to apply.
    H2H_DISCOVERY_ENABLED                  = "true"
    H2H_DISCOVERY_ALLOWED_HOSTS            = "developer.betterment.com,betterment.com,sunrisebanks.com,developer.hsbc.com,developer.jpmorgan.com,developer.citi.com,developer.wellsfargo.com,developer.usbank.com,openbankingtracker.com,raw.githubusercontent.com"
    H2H_DISCOVERY_REQUIRE_DISTINCT_APPLIER = "true"
    # Open Bank REST API OS (server/integrations/os/openBankRestApiOsEngine):
    # /api/open-bank/v1 over Fineract core banking + Open Banking Tracker
    # directory (public dataset not-a-bank/open-banking-tracker-data). File-drop
    # registrations project onto AS2Partners / MFT channels; live only when a
    # drop is verified by a second trustee.
    OPEN_BANK_API_ENABLED          = "true"
    OPEN_BANK_ID                   = "dlb-trust-company"
    OPEN_BANK_NAME                 = "DeAndrea LaVar Barkley Trust Company"
    OPEN_BANK_PUBLIC_BASE_URL      = "https://dlbtrust-app-514695212719.us-east1.run.app"
    OPEN_BANKING_TRACKER_BASE_URL  = "https://raw.githubusercontent.com/not-a-bank/open-banking-tracker-data/master/data/account-providers"
    OPEN_BANKING_TRACKER_INDEX_URL = "https://api.github.com/repos/not-a-bank/open-banking-tracker-data/contents/data/account-providers"
    # Egress OS (server/integrations/os/egressOsEngine): destination policy for
    # the single NAT egress door. Allowed hosts are these plus every host the
    # other engines are configured with (FINERACT_URL, OPENACH_BASE_URL,
    # PAYMENT_HUB_BASE_URL, H2H_DISCOVERY_ALLOWED_HOSTS, Tracker, Google APIs).
    # Retired rails (Stripe, thirdweb, Spritz, chain RPCs) are denied in code.
    # EGRESS_ENFORCE=true makes authorize() fail closed; EGRESS_STATIC_IP /
    # EGRESS_VPC_CONNECTOR / EGRESS_NAT_NAME are stamped from cloudrun.tf.
    EGRESS_OS_ENABLED    = "true"
    EGRESS_ENFORCE       = "true"
    EGRESS_HTTPS_ONLY    = "true"
    EGRESS_ALLOWED_HOSTS = "api.ipify.org,beta-bridge.simplefin.org,simplefin.org,api.orangerails.com,finlynq.com"
    EGRESS_ECHO_URL      = "https://api.ipify.org?format=json"
    # IDP / OCR OS (server/integrations/os/idpOcrOsEngine): Document AI intake
    # of distribution / disbursement / request / vendor-payout documents. Bytes
    # go to the private IDP_OCR_BUCKET (never Cloud SQL); extracted fields are
    # redacted (SSN/EIN/account -> last 4). Text-only extraction (no processor)
    # caps at 0.5 confidence and always needs trustee review. Stays shadow until
    # IDP_OCR_PROCESSOR (projects/<n>/locations/<loc>/processors/<id>) and
    # IDP_OCR_BUCKET exist and IDP_OCR_LIVE=true. Moves no money.
    IDP_OCR_ENABLED                   = "true"
    IDP_OCR_LIVE                      = "false"
    IDP_OCR_PROCESSOR                 = ""
    IDP_OCR_BUCKET                    = ""
    IDP_OCR_MIN_CONFIDENCE            = "0.85"
    IDP_OCR_REQUIRE_DISTINCT_APPROVER = "true"
    # Tax OS (server/integrations/os/taxOsEngine): Form 1041 + Schedule K-1
    # reports from TaxEngine + trust journal + Fineract principal / interest
    # income accounts; JSON / CSV / PDF exports (GET /api/tax/reports/:type/export).
    # Reports only: no e-file, no IRS transmission. TAX_OS_EXPORT_BUCKET is an
    # optional private archive.
    TAX_OS_ENABLED        = "true"
    TAX_OS_LIVE           = "true"
    TAX_OS_DECLARED_STATE = "OH"
    TAX_OS_EXPORT_BUCKET  = ""
    # Private Entity OS (server/integrations/os/privateEntityOsEngine):
    # trustee-declared Ohio ORC 1111-1112 private family trust company profile
    # (single-family multigenerational, unlicensed/unregulated as declared,
    # non-depository, income-support only, PPN settlement). Two distinct
    # trustee attestations + platform audit (IAP enforced, family list, no
    # public invoker, PPN family-only, no Stripe/on-chain, no asset sales).
    # The software records the declaration; it does not establish legal status.
    PRIVATE_ENTITY_ENABLED = "true"
    PRIVATE_ENTITY_LIVE    = "true"
    # Private Equity Holdings OS (server/integrations/os/privateEquityHoldingsOsEngine):
    # private-equity interests backing the PFTC-issued private-placement bond,
    # held as Custody OS private_equity positions. A holding is collateral
    # eligible only when receipted by two trustees at a third-party custodian,
    # valued within PE_HOLDINGS_MAX_VALUATION_AGE_DAYS and covered by a
    # certified Proof of Asset. Evidence only; moves no money.
    PE_HOLDINGS_ENABLED                     = "true"
    PE_HOLDINGS_LIVE                        = "true"
    PE_HOLDINGS_CUSTODY_ACCOUNT_ID          = "CUS-PE-HOLDINGS"
    PE_HOLDINGS_MAX_VALUATION_AGE_DAYS      = "120"
    PE_HOLDINGS_REQUIRE_THIRD_PARTY_CUSTODY = "true"
    # Clearing Agent OS (server/integrations/os/clearingAgentOsEngine):
    # backend-to-backend agent for the private Electronic Payment Networks.
    # Each network is registered with a credential_ref = the NAME of a Secret
    # Manager-backed env var (add it to secret_names; the value is read at call
    # time for HMAC only, never persisted, logged or returned). Handshake =
    # HMAC challenge/verify (registrar + distinct verifier). USA-only: ABA
    # routing on both legs, USD, converted to the network's format (nacha,
    # iso20022_pain001, iso20022_pacs008, fednow, rtp, bai2), HMAC-signed POST
    # <base_url>/clear through Egress OS, then idempotent post to Fineract
    # (withdraw debtor savings, deposit creditor savings). Handshake and
    # conversion never move money; submit needs approvalRef + screeningRef.
    # The trust's own PPN serves the network side of the protocol at
    # PRIVATE_PAYMENT_NETWORK_AGENT_BASE_URL/{handshake,clear} (routes/os.js ->
    # clearingAgentNetworkEndpoint.js), admitting only CLEARING_AGENT_ID with
    # the shared PRIVATE_PAYMENT_NETWORK_AGENT_SECRET (secret_names); the agent
    # registers that network with credential_ref =
    # PRIVATE_PAYMENT_NETWORK_AGENT_SECRET and capabilities.iapAudience so it
    # can cross IAP with the runtime service account's identity token.
    CLEARING_AGENT_ENABLED                   = "true"
    CLEARING_AGENT_LIVE                      = "true"
    PRIVATE_PAYMENT_NETWORK_AGENT_ENABLED    = "true"
    PRIVATE_PAYMENT_NETWORK_AGENT_NETWORK_ID = "PPN-FAMILY"
    PRIVATE_PAYMENT_NETWORK_AGENT_BASE_URL   = "https://dlbtrust-app-514695212719.us-east1.run.app/api/os/private-payment-network/agent"
    CLEARING_AGENT_ID                        = "DLB-TRUST-CLEARING-AGENT"
    CLEARING_AGENT_POST_TO_FINERACT          = "true"
    CLEARING_AGENT_REQUIRE_DISTINCT_VERIFIER = "true"
    CLEARING_AGENT_REQUIRE_APPROVAL          = "true"
    CLEARING_AGENT_TIMEOUT_MS                = "15000"
    # Enterprise ODFI OS (server/integrations/os/enterpriseOdfiOsEngine): the
    # trust company's ORIGINATOR-side operating system for its sponsor ODFI /
    # instant-payment relationship (the software is not a bank and settles
    # nothing itself). Maker/checker originator profile (declare + countersign
    # by distinct trustees), approved+screened distribution / disbursement /
    # vendor-payout / trustee-expense batches, agentic rail planner (Vertex AI
    # Gemini in ENTERPRISE_ODFI_AI_LOCATION when ENTERPRISE_ODFI_AI_ENABLED;
    # only purpose/amount/urgency leave the box, never names or account
    # numbers) re-validated by deterministic rules, release by a DISTINCT
    # trustee through the Clearing Agent (verified network, HMAC, Egress OS,
    # Fineract post), returns/NOC with Fineract re-deposit, exposure
    # reconciliation. Item instructions are AES-256-GCM encrypted under
    # PAYMENT_DATA_ENCRYPTION_KEY. Reports live only once a verified EXTERNAL
    # sponsor network (ach_operator / rtp_participant / fednow_participant) is
    # registered with the Clearing Agent; until then batches plan only.
    ENTERPRISE_ODFI_ENABLED                   = "true"
    ENTERPRISE_ODFI_LIVE                      = "true"
    ENTERPRISE_ODFI_ORIGINATOR_ID             = "DLB-TRUST-ORIGINATOR"
    ENTERPRISE_ODFI_REQUIRE_DISTINCT_RELEASER = "true"
    ENTERPRISE_ODFI_EXPOSURE_LIMIT_CENTS      = "25000000"
    ENTERPRISE_ODFI_SAME_DAY_LIMIT_CENTS      = "100000000"
    ENTERPRISE_ODFI_INSTANT_LIMIT_CENTS       = "100000000"
    ENTERPRISE_ODFI_MAX_BATCH_ITEMS           = "200"
    ENTERPRISE_ODFI_AI_ENABLED                = "true"
    ENTERPRISE_ODFI_AI_PROJECT                = "dlb-treasury-management"
    ENTERPRISE_ODFI_AI_LOCATION               = "us-east1"
    ENTERPRISE_ODFI_AI_MODEL                  = "gemini-2.0-flash"
    ENTERPRISE_ODFI_AI_TIMEOUT_MS             = "20000"
    # Designated roles (portal usernames / emails, comma-separated): makers
    # declare the originator profile and originate batches; checkers
    # countersign and release. Empty = any trustee, distinct-actor rule only.
    ENTERPRISE_ODFI_MAKERS   = "malissa.robinson"
    ENTERPRISE_ODFI_CHECKERS = "deandreabarkley13@gmail.com,legacy-admin"
    # TabaPay (licensed US money-movement processor: ACH next/same-day, RTP,
    # push-to-card) as the trust's external sponsor network, driven through the
    # Clearing Agent adapter (server/integrations/os/clearingAgentTabaPayAdapter).
    # TABAPAY_BASE_URL is the https://FQDN:PORT from TabaPay's credentials file
    # (Egress OS derives the allowed host from it); the bearer key lives ONLY in
    # Secret Manager as TABAPAY_BEARER_TOKEN (secret_names) and is referenced
    # by name when the network is registered:
    #   POST /api/os/clearing-agent/process {action:'register', networkId:'TABAPAY',
    #     kind:'ach_operator', format:'tabapay_json', baseUrl:TABAPAY_BASE_URL,
    #     credentialRef:'TABAPAY_BEARER_TOKEN',
    #     capabilities:{adapter:'tabapay', clientId:<22 chars>, settlementAccountId:<22 chars>}}
    # then challenge (maker) -> verify (checker) = authenticated Retrieve Client.
    TABAPAY_BASE_URL = ""
    # Banking Aggregator (server/integrations/aggregator): provider-agnostic
    # pull (accounts/transactions/statements -> trust GL via DataBridge) and
    # push (payments) hub. AGGREGATOR_ENABLED starts the leader-elected
    # in-process aggregatorScheduler (pull + GL posting every
    # AGGREGATOR_PULL_INTERVAL_MS); AGGREGATOR_DEFAULT_MODE is the outbound mode
    # for connections that do not set config.mode. live = a push reaches the
    # provider only with a checker approvalRef + PaymentComplianceGate
    # screeningRef (fail-closed, same rule as BankSettlementEngine.clearAndSettle);
    # shadow = journal to banking_aggregator_events only. A live plan needs
    # ADMIN_SECRET_TOKEN and at least one AGGREGATOR_<CONNECTION>_API_KEY /
    # AGGREGATOR_<CONNECTION>_WEBHOOK_SECRET in secret_names (cloudrun.tf
    # precondition, secrets.tf missing_aggregator_secrets). Connections whose
    # connector declares a handshake (generic_rest) refuse pull/push until
    # POST /api/aggregator/connections/:id/handshake verifies them within
    # AGGREGATOR_HANDSHAKE_TIMEOUT_MS. GET /api/os/readiness/aggregator lists blockers.
    AGGREGATOR_ENABLED              = "true"
    AGGREGATOR_DEFAULT_MODE         = "live"
    AGGREGATOR_PULL_INTERVAL_MS     = "900000"
    AGGREGATOR_HANDSHAKE_TIMEOUT_MS = "15000"

    # Payer of the trust's fixed-income P&I (custodian/issuer) billed via Stripe ACH debit.
    INCOME_OBLIGOR_NAME             = "DEANDREA LAVAR BARKLEY TRUST COMPANY"
    INCOME_OBLIGOR_EIN              = "99-6411566"
    INCOME_OBLIGOR_EMAIL            = "deandreabarkley13@gmail.com"
    INCOME_OBLIGOR_PAYER_ID         = "dlb-trust-company"
    INCOME_OBLIGOR_ROLE             = "custodian_issuer"
    TRUST_HOLDER_NAME               = "DeAndrea Lavar Barkley Irrevocable Trust"
    TRUST_HOLDER_ID                 = "dlb-irrevocable-trust"
    BOND_ISSUANCE_ENABLED           = "true"
    BOND_ISSUANCE_AUTO_INTAKE       = "false"
    BOND_ISSUANCE_RUN_DUE_MS        = "3600000"
    PROOF_OF_ASSET_ENABLED          = "true"
    PROOF_OF_ASSET_INTERVAL_MINUTES = "1440"
    PROOF_OF_ASSET_AUTO_CERTIFY     = "true"
    PROOF_OF_ASSET_CERTIFIER        = "DeAndrea Lavar Barkley, Trustee"
    # Trust Administration & Distribution pipeline (trustAdministrationWorkflowEngine.run):
    # bank feeds -> Reserve OS -> proof of asset -> fixed-income plan/stage, in order.
    # Never originates a payment. GET/POST /api/trust/administration/workflow[/run].
    TRUST_ADMIN_WORKFLOW_INTERVAL_MS = "21600000"
    # US ACH API Connector OS (server/integrations/ach/odfiApiConnectorEngine.js):
    # the bank-as-API ODFI executing treasury credits from a real funded account.
    # Set ACH_ODFI_PROVIDER to increase|column and ACH_ODFI_ACCOUNT_ID once the
    # Trust Company's origination account exists; secrets.tf then requires
    # ACH_ODFI_API_KEY + ACH_ODFI_WEBHOOK_SECRET in secret_names.
    ACH_ODFI_PROVIDER         = ""
    ACH_ODFI_ACCOUNT_ID       = ""
    ACH_ODFI_SYNC_INTERVAL_MS = "900000"
    # ODFI bank (server/integrations/ach/treasuryOdfiBank.js): the trust's own
    # Betterment Checking (in the trust name) accepts and executes the NACHA
    # files dlb-treasury originates and funds (OpenACH / Payment Hub -> MFT
    # Gateway file drop / SFTP / S2S). At startup its secret-backed routing /
    # account (BETTERMENT_ROUTING_NUMBER / BETTERMENT_ACCOUNT_NUMBER in
    # secret_names) are projected onto ACH_ODFI_ROUTING, NACHA_ODFI_ROUTING,
    # ACH_IMMEDIATE_ORIGIN, CLEARING_FUNDING_SETTLEMENT_ACCOUNT, LILI_ODFI_*,
    # etc., superseding the Lili/Sunrise originator values below. Company id
    # defaults to "1" + INCOME_OBLIGOR_EIN unless Betterment assigns one.
    ACH_ODFI_BANK            = "betterment"
    ACH_ODFI_BANK_NAME       = "BETTERMENT"
    ACH_ODFI_ORIGINATOR_NAME = "DEANDREA LAVAR BARKLEY TRUST COMPANY"
    ACH_ODFI_COMPANY_NAME    = "DLB TRUST CO"
    ACH_ODFI_COMPANY_ID      = ""
    # Optional secondary path (treasuryFundingBankEngine.js): the same account
    # saved in Stripe as an ACH-debit mandate feeding the Stripe balance. Off:
    # dlb-treasury funds the files directly; Betterment is not funding Stripe.
    TREASURY_BANK_ENABLED             = "false"
    TREASURY_BANK_ID                  = "betterment"
    TREASURY_BANK_NAME                = "Betterment Checking"
    TREASURY_BANK_ACCOUNT_HOLDER      = "DEANDREA LAVAR BARKLEY TRUST COMPANY"
    TREASURY_BANK_REGISTER_SETTLEMENT = "true"
    LILI_STRIPE_TREASURY_NETWORK      = "ach"
    LILI_MCP_ENABLED                  = "true"
    LILI_MCP_URL                      = "https://mcp.lili.co/mcp"
    LILI_OAUTH_BASE_URL               = "https://mcp.lili.co"
    LILI_DD_ROUTING_NUMBER            = "121145307"
    LILI_DD_ACCOUNT_NAME              = "DB NET MGMT LLC"
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
    VENDOR_PAYMENT_EXECUTION_MODE = "live"
    COMPLIANCE_PROVIDER           = "opensanctions"
    # Fraud & Compliance OS (docs/FRAUD_COMPLIANCE_OS.md): live screeningRefs
    # from OpenSanctions + DLB internal fraud rules; the trust checker reviews.
    # FRAUD_COMPLIANCE_ENFORCE_SETTLEMENT: live BankSettlementEngine / Clearing
    # Agent settlements must carry a clear, unused FCS- screeningRef.
    FRAUD_COMPLIANCE_ENABLED             = "true"
    FRAUD_COMPLIANCE_LIVE                = "true"
    FRAUD_COMPLIANCE_PROVIDER            = "internal"
    FRAUD_COMPLIANCE_TTL_MINUTES         = "60"
    FRAUD_COMPLIANCE_REVIEWERS           = "deandreabarkley13@gmail.com"
    FRAUD_COMPLIANCE_REVIEW_AMOUNT_CENTS = "1000000"
    FRAUD_COMPLIANCE_ENFORCE_SETTLEMENT  = "true"
    # AML / OFAC sanctions list behind every live screening (complianceEngine.js,
    # openSanctionsListEngine.js). OpenSanctions "sanctions" carries the OFAC SDN
    # and consolidated lists plus UN/EU/UK HMT; readiness blocks every payment
    # until it is ingested, holds MIN_TARGETS entities and is younger than
    # MAX_AGE_HOURS. COMPLIANCE_PROVIDER = "ofac" uses the Treasury SDN feed
    # directly (COMPLIANCE_OFAC_*). Local name lists never authorize a payment.
    COMPLIANCE_OPENSANCTIONS_BASE_URL               = "https://data.opensanctions.org"
    COMPLIANCE_OPENSANCTIONS_DATASET                = "sanctions"
    COMPLIANCE_OPENSANCTIONS_AUTO_REFRESH           = "true"
    COMPLIANCE_OPENSANCTIONS_REFRESH_INTERVAL_HOURS = "12"
    COMPLIANCE_OPENSANCTIONS_MAX_AGE_HOURS          = "48"
    COMPLIANCE_OPENSANCTIONS_MIN_TARGETS            = "5000"
    COMPLIANCE_OFAC_AUTO_REFRESH                    = "true"
    COMPLIANCE_OFAC_REFRESH_INTERVAL_HOURS          = "12"
    COMPLIANCE_OFAC_MAX_AGE_HOURS                   = "48"
    COMPLIANCE_ALLOW_LOCAL_SCREENING                = "false"
    COMPLIANCE_ALLOW_TEST_PAYMENT_EXECUTION         = "false"

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
    ATTESTATION_ENFORCEMENT           = "strict"
    ATTESTATION_FRESH_MINUTES         = "60"
    ATTESTATION_RUN_INTERVAL_MINUTES  = "30"
    FIXED_INCOME_DISTRIBUTION_ENABLED = "true"
    FIXED_INCOME_AUTO_STAGE           = "false"
    FIXED_INCOME_AUTO_EXECUTE         = "false"
    FIXED_INCOME_MIN_AMOUNT_USD       = "1"
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
    # ACH_ORIGINATOR_NAME). CLEARING_FUNDING_SETTLEMENT_ACCOUNT (trust bank
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

    # Trust Operating Account (fundingSourceRegistry.js) and the bank account it
    # settles through. CLEARING_FUNDING_SETTLEMENT_ACCOUNT / _ROUTING are the
    # trust's ODFI account: projected at startup from BETTERMENT_ROUTING_NUMBER /
    # BETTERMENT_ACCOUNT_NUMBER (treasuryOdfiBank.js), Secret Manager only.
    CLEARING_FUNDING_OPERATING_ACCOUNT = "1010"
    CLEARING_FUNDING_OPERATING_ALIASES = "cash:CA-OPERATING"
    CLEARING_FUNDING_DEFAULT_SOURCE    = "operating"
    CLEARING_FUNDING_REQUIRE_BALANCE   = "true"
    CLEARING_FUNDING_TRUST_NAME        = "DEANDREA LAVAR BARKLEY TRUST COMPANY"
    # Settlement funding (settlementFundingEngine.js, fundSettlementAccount.js
    # pipeline; job in settlement_funding_cron.tf). SETTLEMENT_FUNDING_ENGINE =
    # "lili" registers the destination `lili_settlement` from the platform's own
    # Lili settlement engine (LILI_DD_ROUTING_NUMBER above, LILI_DD_ACCOUNT_NUMBER
    # secret), so no caller supplies routing/account and no third-party payables
    # account is involved. Committed funds sit in
    # SETTLEMENT_FUNDING_IN_TRANSIT_GL_ACCOUNT (non-spendable asset) until the
    # bank's settlement reference moves them to SETTLEMENT_FUNDING_GL_ACCOUNT.
    SETTLEMENT_FUNDING_SOURCE                = "operating"
    SETTLEMENT_FUNDING_ENGINE                = "lili"
    SETTLEMENT_FUNDING_DEFAULT_DESTINATION   = "lili_settlement"
    SETTLEMENT_FUNDING_GL_ACCOUNT            = "1040"
    SETTLEMENT_FUNDING_IN_TRANSIT_GL_ACCOUNT = "1015"
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
