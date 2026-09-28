# One Secret Manager secret per runtime credential. Terraform owns the
# containers only; the values are written by scripts/gcp/migrate-northflank-secrets.mjs
# (or `gcloud secrets versions add`), so a plan never carries a secret value.

locals {
  # Always declared, whatever terraform.tfvars lists: Payment Hub EE cannot be
  # enabled without them (paymentHubConfig.js readiness) and NODE_ENV=production
  # refuses to boot without PAYMENT_DATA_ENCRYPTION_KEY. Values are written out
  # of band (scripts/gcp/payment-hub-secrets.sh).
  payment_hub_secret_names = [
    "PAYMENT_HUB_AUTH_TOKEN",
    "PAYMENT_HUB_SERVICE_TOKEN",
    "PAYMENT_HUB_WEBHOOK_SECRET",
    "PAYMENT_DATA_ENCRYPTION_KEY",
    # S2S clearing/settlement server bearer token (server/routes/bankSettlement.js).
    "PAYMENT_SERVER_SERVICE_TOKEN",
    # Stripe payment processing (funding leg of the Lili direct deposit):
    # signing secret of the Stripe webhook endpoint that hits
    # /api/payment-server/v1/stripe/webhook (stripePaymentIntakeEngine.js).
    "STRIPE_WEBHOOK_SECRET",
    # Restricted key scoped to Customers/PaymentIntents/Checkout write (payment
    # processing); the payout key (STRIPE_SECRET_KEY) stays Payouts/Balance only.
    "STRIPE_PAYMENTS_SECRET_KEY",
    # ODFI bank (treasuryOdfiBank.js): routing/account of the trust's Betterment
    # Checking, projected onto the NACHA originator env at startup (and read by
    # treasuryFundingBankEngine.js if enabled); never emitted by the API (last4 only).
    "BETTERMENT_ROUTING_NUMBER",
    "BETTERMENT_ACCOUNT_NUMBER",
  ]
  runtime_secret_names = distinct(concat(var.secret_names, local.payment_hub_secret_names))

  # Env-only credentials each live flag needs (cannot be generated; values come
  # from the provider, so they are listed in terraform.tfvars secret_names once
  # obtained). cloudrun.tf refuses to plan a live flag whose secrets are not
  # declared. Lili is handled separately below (local.missing_lili_secrets):
  # LILI_CLEARING_LIVE=true is a hard failure unless every Lili credential is
  # declared in secret_names, and it is reported at runtime by
  # GET /api/os/readiness/gateway.
  live_engine_requirements = {
    "APIGEE_LIVE" = {
      flag    = lookup(var.runtime_environment, "APIGEE_LIVE", "false") == "true"
      secrets = contains(var.secret_names, "APIGEE_API_KEY") ? [] : ["APIGEE_CLIENT_ID", "APIGEE_CLIENT_SECRET"]
    }
    "APISIX_LIVE" = {
      flag    = lookup(var.runtime_environment, "APISIX_LIVE", "false") == "true"
      secrets = ["APISIX_API_KEY"]
    }
    "CROSS_CHAIN_SHADOW=false" = {
      flag    = lookup(var.runtime_environment, "CROSS_CHAIN_SHADOW", "true") == "false"
      secrets = ["DAPP_RPC_URL", "DAPP_PRIVATE_KEY"]
    }
    # US ACH API Connector OS (odfiApiConnectorEngine.js): a configured
    # bank-as-API ODFI executes real credits, so its key and webhook signing
    # secret must exist before the channel can be planned live.
    "ACH_ODFI_PROVIDER" = {
      flag    = lookup(var.runtime_environment, "ACH_ODFI_PROVIDER", "") != ""
      secrets = ["ACH_ODFI_API_KEY", "ACH_ODFI_WEBHOOK_SECRET"]
    }
  }
  missing_live_secrets = distinct(flatten([
    for name, req in local.live_engine_requirements : [
      for s in req.secrets : "${s} (required by ${name})" if req.flag && !contains(local.runtime_secret_names, s)
    ]
  ]))

  # Treasury -> Lili ACH credit (liliSettlementBankEngine.js). The MCP OAuth
  # tokens feed reconciliation; LILI_DD_ACCOUNT_NUMBER is the full RDFI account
  # number (never in runtime_environment); PAYMENT_SERVER_SERVICE_TOKEN guards
  # the S2S settlement server.
  lili_secret_names = [
    "LILI_OAUTH_CLIENT_ID",
    "LILI_OAUTH_CLIENT_SECRET",
    "LILI_OAUTH_REFRESH_TOKEN",
    "LILI_BUSINESS_USER_ID",
    "LILI_DD_ACCOUNT_NUMBER",
    "PAYMENT_SERVER_SERVICE_TOKEN",
  ]
  lili_clearing_live = lookup(var.runtime_environment, "LILI_CLEARING_LIVE", "false") == "true"
  missing_lili_secrets = [
    for s in local.lili_secret_names : s
    if local.lili_clearing_live && !contains(local.runtime_secret_names, s)
  ]

  # Payment Processor OS (paymentProcessorOsEngine.js). PAYMENT_PROCESSOR_LIVE=true
  # lets an approved submission (approvalRef + screeningRef) reach a processor,
  # so the Stripe payout/payments keys and the payment-data encryption key must
  # exist; the Lili rail additionally inherits lili_secret_names. The
  # approval / screening gates must stay on in a live plan.
  payment_processor_secret_names = [
    "STRIPE_SECRET_KEY",
    "STRIPE_PAYMENTS_SECRET_KEY",
    "PAYMENT_DATA_ENCRYPTION_KEY",
  ]
  payment_processor_live = lookup(var.runtime_environment, "PAYMENT_PROCESSOR_LIVE", "false") == "true"
  missing_payment_processor_secrets = [
    for s in local.payment_processor_secret_names : s
    if local.payment_processor_live && !contains(local.runtime_secret_names, s)
  ]
  payment_processor_gates_relaxed = local.payment_processor_live && (
    lookup(var.runtime_environment, "PAYMENT_PROCESSOR_REQUIRE_APPROVAL_REF", "true") == "false" ||
    lookup(var.runtime_environment, "PAYMENT_PROCESSOR_REQUIRE_SCREENING_REF", "true") == "false"
  )

  # Payment Gateway OS (paymentGatewayOsEngine.js): trust distributions and
  # disbursements to tokenized beneficiary payout methods. PAYMENT_GATEWAY_LIVE
  # =true lets an approved intent reach paymentGatewayServerEngine, so the
  # processor callback HMAC secret, the payment-data encryption key and the
  # Stripe payments key must exist, PAYMENT_PROCESSOR_LIVE must also be true
  # (the gateway dispatches through the processor engine) and the approval /
  # screening / distribution-request gates must stay on.
  payment_gateway_secret_names = [
    "PAYMENT_GATEWAY_WEBHOOK_SECRET",
    "PAYMENT_DATA_ENCRYPTION_KEY",
    "STRIPE_PAYMENTS_SECRET_KEY",
  ]
  payment_gateway_live = lookup(var.runtime_environment, "PAYMENT_GATEWAY_LIVE", "false") == "true"
  missing_payment_gateway_secrets = [
    for s in local.payment_gateway_secret_names : s
    if local.payment_gateway_live && !contains(local.runtime_secret_names, s)
  ]
  payment_gateway_without_processor = local.payment_gateway_live && !local.payment_processor_live
  payment_gateway_gates_relaxed = local.payment_gateway_live && (
    lookup(var.runtime_environment, "PAYMENT_GATEWAY_REQUIRE_APPROVAL_REF", "true") == "false" ||
    lookup(var.runtime_environment, "PAYMENT_GATEWAY_REQUIRE_SCREENING_REF", "true") == "false" ||
    lookup(var.runtime_environment, "PAYMENT_GATEWAY_REQUIRE_DISTRIBUTION_REQUEST", "true") != "true"
  )

  # Enterprise Network OS (enterpriseNetworkOsEngine.js): participant registry,
  # routing policy and exposure limits. ENTERPRISE_NETWORK_LIVE=true makes an
  # approved change an active registry entry, so the screening / partner
  # callback HMAC secret must exist and the approval / screening gates must
  # stay on.
  enterprise_network_secret_names = [
    "ENTERPRISE_NETWORK_WEBHOOK_SECRET",
  ]
  enterprise_network_live = lookup(var.runtime_environment, "ENTERPRISE_NETWORK_LIVE", "false") == "true"
  missing_enterprise_network_secrets = [
    for s in local.enterprise_network_secret_names : s
    if local.enterprise_network_live && !contains(local.runtime_secret_names, s)
  ]
  enterprise_network_gates_relaxed = local.enterprise_network_live && (
    lookup(var.runtime_environment, "ENTERPRISE_NETWORK_REQUIRE_APPROVAL_REF", "true") == "false" ||
    lookup(var.runtime_environment, "ENTERPRISE_NETWORK_REQUIRE_SCREENING_REF", "true") == "false"
  )

  # Private Electronic Payment Network (privatePaymentNetworkOsEngine.js):
  # PRIVATE_PAYMENT_NETWORK_LIVE=true lets an approved transaction post to the
  # trust ledger or reach paymentGatewayServerEngine, so the processor callback
  # HMAC secret, the payment-data encryption key and the Stripe payments key
  # must exist, the processor and enterprise-network engines must be live
  # underneath it and the approval / screening / participant gates must stay on.
  private_payment_network_secret_names = [
    "PRIVATE_PAYMENT_NETWORK_WEBHOOK_SECRET",
    "PAYMENT_DATA_ENCRYPTION_KEY",
    "STRIPE_PAYMENTS_SECRET_KEY",
  ]
  private_payment_network_live = lookup(var.runtime_environment, "PRIVATE_PAYMENT_NETWORK_LIVE", "false") == "true"
  # PRIVATE_PAYMENT_NETWORK_MFT_LIVE=true lets an approved mft_as2 payout drop a
  # NACHA file through the MFT Gateway AS2 station, so its API token pair must
  # be mounted as well.
  private_payment_network_mft_live = local.private_payment_network_live && lookup(var.runtime_environment, "PRIVATE_PAYMENT_NETWORK_MFT_LIVE", "false") == "true"
  private_payment_network_mft_secret_names = [
    "MFTGATEWAY_API_TOKEN_ID",
    "MFTGATEWAY_API_TOKEN_SECRET",
  ]
  # CANONICAL_FUNDING_LIVE=true lets the network withdraw payouts from the
  # Fineract core-banking account of record, so the Fineract credentials must
  # be mounted (FINERACT_URL is the dlbtrust-fineract Cloud Run service URL).
  canonical_funding_live = lookup(var.runtime_environment, "CANONICAL_FUNDING_LIVE", "false") == "true"
  canonical_funding_secret_names = [
    "FINERACT_URL",
    "FINERACT_USERNAME",
    "FINERACT_PASSWORD",
  ]
  # CLEARING_AGENT_LIVE=true lets the Clearing Agent OS clear converted
  # instructions against the family PPN participant endpoint, which admits the
  # agent only with the shared HMAC credential (never persisted or returned).
  clearing_agent_live = lookup(var.runtime_environment, "CLEARING_AGENT_LIVE", "false") == "true"
  clearing_agent_secret_names = [
    "PRIVATE_PAYMENT_NETWORK_AGENT_SECRET",
  ]
  missing_private_payment_network_secrets = concat([
    for s in local.private_payment_network_secret_names : s
    if local.private_payment_network_live && !contains(local.runtime_secret_names, s)
    ], [
    for s in local.clearing_agent_secret_names : s
    if local.clearing_agent_live && !contains(local.runtime_secret_names, s)
    ], [
    for s in local.private_payment_network_mft_secret_names : s
    if local.private_payment_network_mft_live && !contains(local.runtime_secret_names, s)
    ], [
    for s in local.canonical_funding_secret_names : s
    if local.canonical_funding_live && !contains(local.runtime_secret_names, s)
  ])
  private_payment_network_without_dependencies = local.private_payment_network_live && (!local.payment_processor_live || !local.enterprise_network_live)
  private_payment_network_gates_relaxed = local.private_payment_network_live && (
    lookup(var.runtime_environment, "PRIVATE_PAYMENT_NETWORK_REQUIRE_APPROVAL_REF", "true") == "false" ||
    lookup(var.runtime_environment, "PRIVATE_PAYMENT_NETWORK_REQUIRE_SCREENING_REF", "true") == "false" ||
    lookup(var.runtime_environment, "PRIVATE_PAYMENT_NETWORK_REQUIRE_PARTICIPANT", "true") == "false"
  )

  # Banking Aggregator (bankingAggregator.js): AGGREGATOR_DEFAULT_MODE=live lets
  # an approved + screened push reach a provider, so the admin token guarding
  # /api/aggregator/* and at least one per-connection credential
  # (AGGREGATOR_<CONNECTION>_API_KEY / _WEBHOOK_SECRET / _CLIENT_SECRET /
  # _ACCESS_TOKEN / _CREDENTIALS_KEY / _TRANSACTIONS_KEY / _ACCESS_URL, or the
  # workspace-wide BANKSYNC_API_KEY / ORANGERAILS_PLATFORM_API_KEY /
  # SIMPLEFIN_ACCESS_URL used by the banksync / orangerails / simplefin
  # read-only connectors) must be declared. Credentials are
  # loaded into the connection's config from these env names; the API never
  # returns them.
  aggregator_enabled    = lookup(var.runtime_environment, "AGGREGATOR_ENABLED", "true") != "false"
  aggregator_live       = local.aggregator_enabled && lookup(var.runtime_environment, "AGGREGATOR_DEFAULT_MODE", "shadow") == "live"
  aggregator_mode_valid = contains(["live", "shadow"], lookup(var.runtime_environment, "AGGREGATOR_DEFAULT_MODE", "shadow"))
  aggregator_credential_secret_names = [
    for s in local.runtime_secret_names : s
    if can(regex("^AGGREGATOR_[A-Z0-9_]+_(API_KEY|WEBHOOK_SECRET|CLIENT_SECRET|ACCESS_TOKEN|CREDENTIALS_KEY|TRANSACTIONS_KEY|ACCESS_URL)$", s)) || contains(["BANKSYNC_API_KEY", "ORANGERAILS_PLATFORM_API_KEY", "SIMPLEFIN_ACCESS_URL"], s)
  ]
  missing_aggregator_secrets = concat(
    [for s in ["ADMIN_SECRET_TOKEN"] : s if local.aggregator_live && !contains(local.runtime_secret_names, s)],
    local.aggregator_live && length(local.aggregator_credential_secret_names) == 0 ? ["AGGREGATOR_<CONNECTION>_API_KEY / _WEBHOOK_SECRET / _CLIENT_SECRET / _ACCESS_TOKEN / _CREDENTIALS_KEY / _TRANSACTIONS_KEY / _ACCESS_URL, BANKSYNC_API_KEY, ORANGERAILS_PLATFORM_API_KEY or SIMPLEFIN_ACCESS_URL"] : [],
  )
}

# Enforced as a hard precondition on google_cloud_run_v2_service.app in
# cloudrun.tf: a plan with LILI_CLEARING_LIVE=true fails unless every Lili
# credential above is declared.

resource "google_secret_manager_secret" "runtime" {
  for_each  = toset(local.runtime_secret_names)
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
