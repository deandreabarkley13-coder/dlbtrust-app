--
-- PostgreSQL database dump
--

\restrict 2pP5osaLY5s83ar0w7ggLbpwyBezgqcvmAfq02MQMRQ1hYBFEAoh9zklv0Hz0Mk

-- Dumped from database version 14.23 (Ubuntu 14.23-0ubuntu0.22.04.1)
-- Dumped by pg_dump version 14.23 (Ubuntu 14.23-0ubuntu0.22.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_audit_log (
    id integer NOT NULL,
    admin_user text,
    action text NOT NULL,
    resource_type text,
    resource_id text,
    payload jsonb,
    result jsonb,
    ip_address text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: admin_audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_audit_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_audit_log_id_seq OWNED BY public.admin_audit_log.id;


--
-- Name: aggregator_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aggregator_accounts (
    id text NOT NULL,
    connection_id text NOT NULL,
    external_account_id text NOT NULL,
    name text,
    account_type text,
    currency text DEFAULT 'USD'::text,
    mask text,
    balance_available numeric(20,2),
    balance_current numeric(20,2),
    raw jsonb,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: aggregator_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aggregator_connections (
    id text NOT NULL,
    name text NOT NULL,
    connector_type text NOT NULL,
    direction text DEFAULT 'both'::text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    active boolean DEFAULT true NOT NULL,
    last_pull_at timestamp with time zone,
    last_push_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT aggregator_connections_direction_check CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text, 'both'::text])))
);


--
-- Name: aggregator_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aggregator_events (
    id text NOT NULL,
    connection_id text,
    direction text NOT NULL,
    event_type text NOT NULL,
    payload jsonb,
    status text DEFAULT 'received'::text NOT NULL,
    error text,
    provider_ref text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT aggregator_events_direction_check CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text]))),
    CONSTRAINT aggregator_events_status_check CHECK ((status = ANY (ARRAY['received'::text, 'processed'::text, 'failed'::text, 'sent'::text])))
);


--
-- Name: aggregator_statements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aggregator_statements (
    id text NOT NULL,
    connection_id text NOT NULL,
    external_account_id text,
    external_statement_id text NOT NULL,
    period_start date,
    period_end date,
    format text,
    uri text,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: aggregator_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aggregator_transactions (
    id text NOT NULL,
    connection_id text NOT NULL,
    external_account_id text,
    external_txn_id text NOT NULL,
    posted_date date,
    amount numeric(20,2) NOT NULL,
    currency text DEFAULT 'USD'::text,
    direction text,
    description text,
    category text,
    status text DEFAULT 'posted'::text,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT aggregator_transactions_direction_check CHECK ((direction = ANY (ARRAY['credit'::text, 'debit'::text])))
);


--
-- Name: auth_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_sessions (
    id integer NOT NULL,
    user_id integer NOT NULL,
    token_id character varying(100) NOT NULL,
    ip_address character varying(45),
    user_agent text,
    expires_at timestamp with time zone NOT NULL,
    revoked boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: auth_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auth_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auth_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auth_sessions_id_seq OWNED BY public.auth_sessions.id;


--
-- Name: auth_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_users (
    id integer NOT NULL,
    username character varying(100) NOT NULL,
    password_hash character varying(255) NOT NULL,
    display_name character varying(200),
    email character varying(255),
    role character varying(50) DEFAULT 'viewer'::character varying NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    failed_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    last_login timestamp with time zone,
    last_password_change timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: auth_users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auth_users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auth_users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auth_users_id_seq OWNED BY public.auth_users.id;


--
-- Name: bill_settlement_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bill_settlement_queue (
    id integer NOT NULL,
    settlement_id text NOT NULL,
    deposit_ref text NOT NULL,
    deposit_method text NOT NULL,
    amount numeric(18,2) NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    bill_txn_id text,
    bill_confirmed_at timestamp with time zone,
    expected_settle timestamp with time zone,
    actual_settle timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT bill_settlement_queue_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'clearing'::text, 'settled'::text, 'failed'::text, 'expired'::text])))
);


--
-- Name: bill_settlement_queue_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bill_settlement_queue_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bill_settlement_queue_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bill_settlement_queue_id_seq OWNED BY public.bill_settlement_queue.id;


--
-- Name: bill_sync_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bill_sync_log (
    id integer NOT NULL,
    sync_id text NOT NULL,
    sync_type text DEFAULT 'poll'::text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    bill_balance numeric(18,2),
    gl_balance numeric(18,2),
    balance_matched boolean,
    deposits_synced integer DEFAULT 0,
    settlements_found integer DEFAULT 0,
    discrepancies integer DEFAULT 0,
    details text,
    error_message text,
    started_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    triggered_by text DEFAULT 'system'::text,
    CONSTRAINT bill_sync_log_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT bill_sync_log_sync_type_check CHECK ((sync_type = ANY (ARRAY['poll'::text, 'settlement'::text, 'reconcile'::text, 'full'::text])))
);


--
-- Name: bill_sync_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bill_sync_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bill_sync_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bill_sync_log_id_seq OWNED BY public.bill_sync_log.id;


--
-- Name: bond_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bond_balances (
    id integer NOT NULL,
    bond_id integer NOT NULL,
    principal_balance numeric(18,2) NOT NULL,
    accrued_interest numeric(18,2) DEFAULT 0 NOT NULL,
    total_interest_paid numeric(18,2) DEFAULT 0 NOT NULL,
    total_principal_paid numeric(18,2) DEFAULT 0 NOT NULL,
    last_accrual_date date,
    last_payment_date date,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: bond_balances_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bond_balances_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bond_balances_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bond_balances_id_seq OWNED BY public.bond_balances.id;


--
-- Name: bond_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bond_transactions (
    id integer NOT NULL,
    bond_id integer NOT NULL,
    transaction_type character varying(30) NOT NULL,
    amount numeric(18,2) NOT NULL,
    running_balance numeric(18,2) NOT NULL,
    accrued_interest numeric(18,2) DEFAULT 0 NOT NULL,
    description text,
    fineract_txn_id character varying(100),
    transaction_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: bond_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bond_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bond_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bond_transactions_id_seq OWNED BY public.bond_transactions.id;


--
-- Name: bond_trustees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bond_trustees (
    id integer NOT NULL,
    bond_id integer NOT NULL,
    trustee_id text NOT NULL,
    trustee_name text,
    trustee_role text DEFAULT 'primary'::text,
    effective_date date NOT NULL,
    end_date date,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT bond_trustees_trustee_role_check CHECK ((trustee_role = ANY (ARRAY['primary'::text, 'co-trustee'::text, 'successor'::text, 'special'::text])))
);


--
-- Name: bond_trustees_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bond_trustees_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bond_trustees_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bond_trustees_id_seq OWNED BY public.bond_trustees.id;


--
-- Name: bonds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bonds (
    id integer NOT NULL,
    bond_name text NOT NULL,
    isin text,
    face_value numeric(18,2) DEFAULT 0 NOT NULL,
    coupon_rate numeric(10,6) DEFAULT 0 NOT NULL,
    issue_date date NOT NULL,
    maturity_date date NOT NULL,
    payment_freq text DEFAULT 'monthly'::text,
    day_count text DEFAULT '30/360'::text,
    currency text DEFAULT 'USD'::text,
    status text DEFAULT 'active'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    bond_identifier text,
    bond_type text DEFAULT 'corporate'::text,
    tax_exempt boolean DEFAULT false,
    tax_exempt_type text,
    placement_type text DEFAULT 'public'::text,
    issuer text,
    issuer_state text,
    CONSTRAINT bonds_payment_freq_check CHECK ((payment_freq = ANY (ARRAY['monthly'::text, 'quarterly'::text, 'semi-annual'::text, 'annual'::text]))),
    CONSTRAINT bonds_status_check CHECK ((status = ANY (ARRAY['active'::text, 'matured'::text, 'called'::text, 'defaulted'::text])))
);


--
-- Name: bonds_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bonds_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bonds_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bonds_id_seq OWNED BY public.bonds.id;


--
-- Name: bookkeeping_adjustments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bookkeeping_adjustments (
    id integer NOT NULL,
    adjustment_id text NOT NULL,
    adjustment_type text NOT NULL,
    original_entry_id text,
    correcting_entry_id text,
    amount numeric(18,2) NOT NULL,
    reason text NOT NULL,
    approved_by text,
    approved_at timestamp with time zone,
    status text DEFAULT 'pending'::text NOT NULL,
    created_by text DEFAULT 'bookkeeping_agent'::text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT bookkeeping_adjustments_adjustment_type_check CHECK ((adjustment_type = ANY (ARRAY['reversal'::text, 'correction'::text, 'reclassification'::text, 'write_off'::text, 'accrual'::text]))),
    CONSTRAINT bookkeeping_adjustments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'posted'::text, 'rejected'::text])))
);


--
-- Name: bookkeeping_adjustments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bookkeeping_adjustments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bookkeeping_adjustments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bookkeeping_adjustments_id_seq OWNED BY public.bookkeeping_adjustments.id;


--
-- Name: bookkeeping_reconciliations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bookkeeping_reconciliations (
    id integer NOT NULL,
    recon_id text NOT NULL,
    recon_type text NOT NULL,
    recon_date date DEFAULT CURRENT_DATE NOT NULL,
    items_matched integer DEFAULT 0,
    items_unmatched integer DEFAULT 0,
    total_matched numeric(18,2) DEFAULT 0,
    total_unmatched numeric(18,2) DEFAULT 0,
    details jsonb,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT bookkeeping_reconciliations_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'final'::text, 'reviewed'::text])))
);


--
-- Name: bookkeeping_reconciliations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bookkeeping_reconciliations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bookkeeping_reconciliations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bookkeeping_reconciliations_id_seq OWNED BY public.bookkeeping_reconciliations.id;


--
-- Name: bookkeeping_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bookkeeping_tasks (
    id integer NOT NULL,
    task_id text NOT NULL,
    task_type text NOT NULL,
    category text DEFAULT 'general'::text NOT NULL,
    title text NOT NULL,
    description text,
    status text DEFAULT 'pending'::text NOT NULL,
    priority text DEFAULT 'normal'::text NOT NULL,
    scheduled_date date,
    completed_date timestamp with time zone,
    result jsonb,
    created_by text DEFAULT 'bookkeeping_agent'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT bookkeeping_tasks_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'critical'::text]))),
    CONSTRAINT bookkeeping_tasks_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'completed'::text, 'failed'::text, 'skipped'::text])))
);


--
-- Name: bookkeeping_tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bookkeeping_tasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bookkeeping_tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bookkeeping_tasks_id_seq OWNED BY public.bookkeeping_tasks.id;


--
-- Name: calendar_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_events (
    id text NOT NULL,
    title text NOT NULL,
    description text,
    start_time timestamp with time zone NOT NULL,
    end_time timestamp with time zone,
    all_day boolean DEFAULT false,
    event_type text DEFAULT 'general'::text,
    related_module text,
    reference_id text,
    attendees jsonb DEFAULT '[]'::jsonb,
    created_by text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT calendar_events_event_type_check CHECK ((event_type = ANY (ARRAY['general'::text, 'payment'::text, 'distribution'::text, 'disbursement'::text, 'swap'::text, 'safe'::text, 'meeting'::text, 'deadline'::text, 'review'::text, 'document'::text])))
);


--
-- Name: cash_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cash_accounts (
    id integer NOT NULL,
    account_id text NOT NULL,
    account_name text NOT NULL,
    account_type text NOT NULL,
    linked_fineract_account_id text,
    balance_cents bigint DEFAULT 0,
    currency text DEFAULT 'USD'::text,
    status text DEFAULT 'active'::text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT cash_accounts_account_type_check CHECK ((account_type = ANY (ARRAY['operating'::text, 'reserve'::text, 'distribution'::text, 'bond_proceeds'::text, 'escrow'::text, 'fee'::text]))),
    CONSTRAINT cash_accounts_status_check CHECK ((status = ANY (ARRAY['active'::text, 'frozen'::text, 'closed'::text])))
);


--
-- Name: cash_accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cash_accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cash_accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cash_accounts_id_seq OWNED BY public.cash_accounts.id;


--
-- Name: cash_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cash_movements (
    id integer NOT NULL,
    movement_id text NOT NULL,
    from_account_id text,
    to_account_id text,
    amount_cents bigint NOT NULL,
    movement_type text NOT NULL,
    reference_id text,
    reference_type text,
    gl_journal_id text,
    status text DEFAULT 'settled'::text,
    memo text,
    initiated_by text,
    created_at timestamp with time zone DEFAULT now(),
    settled_at timestamp with time zone DEFAULT now(),
    CONSTRAINT cash_movements_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT cash_movements_movement_type_check CHECK ((movement_type = ANY (ARRAY['transfer'::text, 'bond_proceeds'::text, 'interest_payment'::text, 'principal_payment'::text, 'distribution'::text, 'fee'::text, 'sweep'::text, 'deposit'::text, 'withdrawal'::text]))),
    CONSTRAINT cash_movements_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'settled'::text, 'reversed'::text, 'failed'::text])))
);


--
-- Name: cash_movements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cash_movements_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cash_movements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cash_movements_id_seq OWNED BY public.cash_movements.id;


--
-- Name: client_sub_ledgers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_sub_ledgers (
    id integer NOT NULL,
    sub_ledger_id text NOT NULL,
    contact_id text NOT NULL,
    parent_account_code text NOT NULL,
    sub_account_name text NOT NULL,
    sub_account_type text DEFAULT 'general'::text NOT NULL,
    balance numeric(18,2) DEFAULT 0 NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    fineract_savings_id text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT client_sub_ledgers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'frozen'::text, 'closed'::text]))),
    CONSTRAINT client_sub_ledgers_sub_account_type_check CHECK ((sub_account_type = ANY (ARRAY['bond_investment'::text, 'distribution'::text, 'accrued_interest'::text, 'fee'::text, 'escrow'::text, 'operating'::text, 'general'::text])))
);


--
-- Name: client_sub_ledgers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.client_sub_ledgers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: client_sub_ledgers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.client_sub_ledgers_id_seq OWNED BY public.client_sub_ledgers.id;


--
-- Name: coinbase_hbar_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coinbase_hbar_orders (
    id text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    direction text DEFAULT 'fund'::text NOT NULL,
    fiat_amount numeric(16,2),
    fiat_currency text DEFAULT 'USD'::text,
    hbar_amount text,
    target_address text NOT NULL,
    source_type text,
    source_account_id text,
    reserve_id text,
    order_id text,
    withdrawal_id text,
    tx_hash text,
    tx_explorer text,
    error text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT coinbase_hbar_orders_direction_check CHECK ((direction = ANY (ARRAY['fund'::text, 'withdraw'::text]))),
    CONSTRAINT coinbase_hbar_orders_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'buying'::text, 'withdrawing'::text, 'completed'::text, 'failed'::text, 'needs_deposit'::text])))
);


--
-- Name: coupon_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coupon_payments (
    id integer NOT NULL,
    coupon_payment_id text NOT NULL,
    bond_id integer NOT NULL,
    coupon_date date NOT NULL,
    amount numeric(18,2) NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    ach_batch_id text,
    bondholders_paid integer DEFAULT 0,
    bondholders_skipped integer DEFAULT 0,
    journal_entry_id text,
    error_message text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT coupon_payments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'paid'::text, 'failed'::text])))
);


--
-- Name: coupon_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.coupon_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: coupon_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.coupon_payments_id_seq OWNED BY public.coupon_payments.id;


--
-- Name: crm_bond_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_bond_subscriptions (
    id integer NOT NULL,
    subscription_id text NOT NULL,
    contact_id text NOT NULL,
    bond_id integer NOT NULL,
    subscription_amount numeric(18,2) NOT NULL,
    offering_price numeric(10,6) DEFAULT 1.0,
    settlement_date date NOT NULL,
    status text DEFAULT 'active'::text,
    cash_account_id text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT crm_bond_subscriptions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'redeemed'::text, 'cancelled'::text])))
);


--
-- Name: crm_bond_subscriptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_bond_subscriptions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_bond_subscriptions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crm_bond_subscriptions_id_seq OWNED BY public.crm_bond_subscriptions.id;


--
-- Name: crm_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_contacts (
    id integer NOT NULL,
    contact_id text NOT NULL,
    contact_type text NOT NULL,
    first_name text NOT NULL,
    last_name text NOT NULL,
    company text,
    email text,
    phone text,
    mailing_address text,
    date_of_birth date,
    ssn_last4 text,
    kyc_status text DEFAULT 'pending'::text,
    kyc_verified_at timestamp with time zone,
    aml_status text DEFAULT 'clear'::text,
    fineract_client_id text,
    linked_wallet_id text,
    preferred_payment text DEFAULT 'ach'::text,
    routing_number text,
    account_number text,
    bank_account_type text DEFAULT 'checking'::text,
    bank_name text,
    status text DEFAULT 'active'::text,
    notes text,
    tags text[],
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    approval_status text DEFAULT 'pending_approval'::text,
    approved_by text,
    approved_at timestamp with time zone,
    rejected_by text,
    rejection_reason text,
    CONSTRAINT crm_contacts_aml_status_check CHECK ((aml_status = ANY (ARRAY['clear'::text, 'flagged'::text, 'blocked'::text]))),
    CONSTRAINT crm_contacts_bank_account_type_check CHECK ((bank_account_type = ANY (ARRAY['checking'::text, 'savings'::text]))),
    CONSTRAINT crm_contacts_contact_type_check CHECK ((contact_type = ANY (ARRAY['investor'::text, 'trustee'::text, 'beneficiary'::text, 'counterparty'::text, 'advisor'::text, 'legal'::text, 'admin'::text]))),
    CONSTRAINT crm_contacts_kyc_status_check CHECK ((kyc_status = ANY (ARRAY['pending'::text, 'verified'::text, 'failed'::text, 'expired'::text]))),
    CONSTRAINT crm_contacts_preferred_payment_check CHECK ((preferred_payment = ANY (ARRAY['ach'::text, 'wire'::text, 'check'::text, 'internal'::text]))),
    CONSTRAINT crm_contacts_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'blocked'::text])))
);


--
-- Name: crm_contacts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_contacts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_contacts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crm_contacts_id_seq OWNED BY public.crm_contacts.id;


--
-- Name: crm_interactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_interactions (
    id integer NOT NULL,
    interaction_id text NOT NULL,
    contact_id text NOT NULL,
    interaction_type text NOT NULL,
    subject text,
    body text,
    direction text,
    outcome text,
    follow_up_date date,
    created_by text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT crm_interactions_direction_check CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text, 'internal'::text]))),
    CONSTRAINT crm_interactions_interaction_type_check CHECK ((interaction_type = ANY (ARRAY['call'::text, 'email'::text, 'meeting'::text, 'note'::text, 'document'::text, 'distribution'::text, 'payment'::text])))
);


--
-- Name: crm_interactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_interactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_interactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crm_interactions_id_seq OWNED BY public.crm_interactions.id;


--
-- Name: dapp_deposits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dapp_deposits (
    id text NOT NULL,
    safe_id text,
    asset text NOT NULL,
    amount text NOT NULL,
    from_address text,
    tx_hash text,
    status text DEFAULT 'pending'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dapp_deposits_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'failed'::text])))
);


--
-- Name: dapp_distributions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dapp_distributions (
    id text NOT NULL,
    safe_id text,
    name text,
    asset text NOT NULL,
    total_amount text NOT NULL,
    beneficiaries jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    tx_hash text,
    source_type text,
    source_account_id text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dapp_distributions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'executed'::text, 'failed'::text])))
);


--
-- Name: dapp_payouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dapp_payouts (
    id text NOT NULL,
    safe_id text NOT NULL,
    type text DEFAULT 'payout'::text NOT NULL,
    destination text NOT NULL,
    value text,
    token text,
    token_amount text,
    description text,
    status text DEFAULT 'pending'::text NOT NULL,
    safe_tx_hash text,
    server_signature text,
    signatures jsonb DEFAULT '[]'::jsonb,
    tx_hash text,
    source_type text,
    source_account_id text,
    reserve_id text,
    distribution_id text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dapp_payouts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'executed'::text, 'failed'::text]))),
    CONSTRAINT dapp_payouts_type_check CHECK ((type = ANY (ARRAY['payout'::text, 'disbursement'::text, 'p2p'::text, 'distribution_item'::text])))
);


--
-- Name: dapp_safes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dapp_safes (
    id text NOT NULL,
    label text,
    safe_address text NOT NULL,
    chain_id integer DEFAULT 1 NOT NULL,
    owners jsonb NOT NULL,
    threshold integer NOT NULL,
    salt_nonce text,
    deploy_tx_hash text,
    status text DEFAULT 'pending'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dapp_safes_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'deployed'::text, 'failed'::text])))
);


--
-- Name: dapp_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dapp_users (
    id text NOT NULL,
    email text,
    phone text,
    name text,
    role text DEFAULT 'beneficiary'::text NOT NULL,
    wallet_address text,
    safe_owner_address text,
    linked_wallet_provider text,
    verified boolean DEFAULT false NOT NULL,
    otp_code text,
    otp_expires timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dapp_users_role_check CHECK ((role = ANY (ARRAY['trustee_admin'::text, 'trustee_secretary'::text, 'beneficiary'::text, 'viewer'::text])))
);


--
-- Name: dapp_white_label; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dapp_white_label (
    id text NOT NULL,
    name text NOT NULL,
    slug text,
    primary_color text DEFAULT '#0f172a'::text,
    secondary_color text DEFAULT '#3b82f6'::text,
    logo_url text,
    favicon_url text,
    contact_email text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: data_bridge_discrepancies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.data_bridge_discrepancies (
    id integer NOT NULL,
    discrepancy_id text NOT NULL,
    discrepancy_type text NOT NULL,
    module_a text NOT NULL,
    module_b text NOT NULL,
    account_code text,
    amount_a numeric(18,2),
    amount_b numeric(18,2),
    difference numeric(18,2),
    severity text DEFAULT 'normal'::text NOT NULL,
    resolved boolean DEFAULT false,
    resolution text,
    details jsonb,
    created_at timestamp with time zone DEFAULT now(),
    resolved_at timestamp with time zone,
    CONSTRAINT data_bridge_discrepancies_severity_check CHECK ((severity = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'critical'::text])))
);


--
-- Name: data_bridge_discrepancies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.data_bridge_discrepancies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: data_bridge_discrepancies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.data_bridge_discrepancies_id_seq OWNED BY public.data_bridge_discrepancies.id;


--
-- Name: data_bridge_sync_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.data_bridge_sync_log (
    id integer NOT NULL,
    sync_id text NOT NULL,
    sync_type text NOT NULL,
    source_module text NOT NULL,
    target_module text NOT NULL,
    items_synced integer DEFAULT 0,
    items_skipped integer DEFAULT 0,
    items_failed integer DEFAULT 0,
    details jsonb,
    status text DEFAULT 'completed'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT data_bridge_sync_log_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'partial'::text])))
);


--
-- Name: data_bridge_sync_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.data_bridge_sync_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: data_bridge_sync_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.data_bridge_sync_log_id_seq OWNED BY public.data_bridge_sync_log.id;


--
-- Name: document_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_templates (
    id integer NOT NULL,
    template_id text NOT NULL,
    template_name text NOT NULL,
    template_type text NOT NULL,
    category text DEFAULT 'general'::text,
    description text,
    body_template text NOT NULL,
    header_template text,
    footer_template text,
    variables jsonb DEFAULT '[]'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    version integer DEFAULT 1,
    is_active boolean DEFAULT true,
    is_default boolean DEFAULT false,
    created_by text,
    updated_by text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT document_templates_category_check CHECK ((category = ANY (ARRAY['legal'::text, 'financial'::text, 'compliance'::text, 'investor'::text, 'trustee'::text, 'tax'::text, 'operational'::text, 'general'::text]))),
    CONSTRAINT document_templates_template_type_check CHECK ((template_type = ANY (ARRAY['trust_agreement'::text, 'bond_indenture'::text, 'subscription_agreement'::text, 'distribution_notice'::text, 'tax_form'::text, 'compliance_report'::text, 'trustee_report'::text, 'investor_statement'::text, 'payment_confirmation'::text, 'amendment'::text, 'resolution'::text, 'custom'::text])))
);


--
-- Name: document_templates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.document_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: document_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.document_templates_id_seq OWNED BY public.document_templates.id;


--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id integer NOT NULL,
    document_id text NOT NULL,
    document_name text NOT NULL,
    document_type text NOT NULL,
    category text DEFAULT 'general'::text,
    content text,
    content_type text DEFAULT 'text/plain'::text,
    file_size_bytes integer,
    bond_id integer,
    contact_id text,
    cash_account_id text,
    reference_type text,
    reference_id text,
    tags text[],
    metadata jsonb DEFAULT '{}'::jsonb,
    status text DEFAULT 'active'::text,
    version integer DEFAULT 1,
    parent_document_id text,
    created_by text,
    updated_by text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT documents_category_check CHECK ((category = ANY (ARRAY['legal'::text, 'financial'::text, 'compliance'::text, 'investor'::text, 'trustee'::text, 'tax'::text, 'operational'::text, 'general'::text]))),
    CONSTRAINT documents_content_type_check CHECK ((content_type = ANY (ARRAY['text/plain'::text, 'text/html'::text, 'application/json'::text, 'application/pdf'::text]))),
    CONSTRAINT documents_document_type_check CHECK ((document_type = ANY (ARRAY['trust_agreement'::text, 'bond_indenture'::text, 'subscription_agreement'::text, 'distribution_notice'::text, 'tax_form'::text, 'compliance_report'::text, 'trustee_report'::text, 'investor_statement'::text, 'payment_confirmation'::text, 'amendment'::text, 'resolution'::text, 'correspondence'::text, 'receipt'::text, 'other'::text]))),
    CONSTRAINT documents_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text, 'superseded'::text, 'deleted'::text])))
);


--
-- Name: documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: documents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.documents_id_seq OWNED BY public.documents.id;


--
-- Name: electronic_settlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.electronic_settlements (
    id integer NOT NULL,
    settlement_id text NOT NULL,
    payment_ref text NOT NULL,
    payment_type text DEFAULT 'vendor_payment'::text NOT NULL,
    payment_method text DEFAULT 'bill'::text NOT NULL,
    priority text DEFAULT 'standard'::text NOT NULL,
    payer_name text DEFAULT 'DLB Trust'::text NOT NULL,
    payer_account text,
    payee_name text NOT NULL,
    payee_account text,
    payee_routing text,
    payee_bank_name text,
    sub_ledger_id text,
    sub_ledger_txn_id text,
    source_account_code text DEFAULT '1000'::text,
    amount numeric(18,2) NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    status text DEFAULT 'submitted'::text NOT NULL,
    payment_file_hash text,
    transmission_ref text,
    processor_ref text,
    settlement_ref text,
    confirmation_code text,
    integrity_hash text,
    settlement_certificate text,
    bill_ref text,
    ach_batch_id text,
    wire_id text,
    journal_entry_id text,
    tracking_id text,
    retry_count integer DEFAULT 0,
    last_error text,
    submitted_at timestamp with time zone DEFAULT now(),
    transmitted_at timestamp with time zone,
    accepted_at timestamp with time zone,
    clearing_at timestamp with time zone,
    settled_at timestamp with time zone,
    confirmed_at timestamp with time zone,
    finalized_at timestamp with time zone,
    sla_deadline timestamp with time zone,
    initiated_by text DEFAULT 'system'::text NOT NULL,
    description text,
    memo text,
    vendor_id text,
    data_bridge_synced boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    payment_intent_id text,
    payment_hub_txn_id text,
    payment_hub_status text,
    accounting_status text DEFAULT 'pending'::text NOT NULL,
    accounting_error text,
    CONSTRAINT electronic_settlements_accounting_status_check CHECK ((accounting_status = ANY (ARRAY['pending'::text, 'posting'::text, 'posted'::text, 'failed'::text]))),
    CONSTRAINT electronic_settlements_priority_check CHECK ((priority = ANY (ARRAY['standard'::text, 'express'::text, 'urgent'::text, 'immediate'::text]))),
    CONSTRAINT electronic_settlements_status_check CHECK ((status = ANY (ARRAY['submitted'::text, 'transmitted'::text, 'accepted'::text, 'clearing'::text, 'settled'::text, 'confirmed'::text, 'finalized'::text, 'failed'::text, 'returned'::text])))
);


--
-- Name: electronic_settlements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.electronic_settlements_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: electronic_settlements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.electronic_settlements_id_seq OWNED BY public.electronic_settlements.id;


--
-- Name: finops_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finops_tasks (
    id text NOT NULL,
    prompt text NOT NULL,
    intent jsonb DEFAULT '{}'::jsonb,
    status text DEFAULT 'pending_approval'::text,
    required_roles jsonb DEFAULT '["administration", "distribution"]'::jsonb,
    approvals jsonb DEFAULT '[]'::jsonb,
    result jsonb DEFAULT '{}'::jsonb,
    tx_hash text,
    requested_by text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT finops_tasks_status_check CHECK ((status = ANY (ARRAY['pending_approval'::text, 'approved'::text, 'rejected'::text, 'executing'::text, 'executed'::text, 'failed'::text])))
);


--
-- Name: generated_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.generated_documents (
    id integer NOT NULL,
    generation_id text NOT NULL,
    template_id text NOT NULL,
    document_id text,
    bond_id integer,
    contact_id text,
    variables_used jsonb DEFAULT '{}'::jsonb,
    rendered_content text NOT NULL,
    content_type text DEFAULT 'text/html'::text,
    status text DEFAULT 'completed'::text,
    generated_by text,
    generated_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone,
    CONSTRAINT generated_documents_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text, 'expired'::text])))
);


--
-- Name: generated_documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.generated_documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: generated_documents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.generated_documents_id_seq OWNED BY public.generated_documents.id;


--
-- Name: message_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_threads (
    id text NOT NULL,
    subject text,
    participants jsonb DEFAULT '[]'::jsonb,
    reference_type text,
    reference_id text,
    created_by text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id text NOT NULL,
    thread_id text NOT NULL,
    sender text,
    body text,
    attachments jsonb DEFAULT '[]'::jsonb,
    read_by jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: nifi_payment_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nifi_payment_files (
    id integer NOT NULL,
    file_id text NOT NULL,
    direction text DEFAULT 'outbound'::text NOT NULL,
    file_format text DEFAULT 'nacha'::text NOT NULL,
    file_name text NOT NULL,
    file_content text NOT NULL,
    file_size_bytes integer DEFAULT 0 NOT NULL,
    file_hash text NOT NULL,
    hmac_signature text,
    status text DEFAULT 'generated'::text NOT NULL,
    settlement_ids text[],
    payment_count integer DEFAULT 0 NOT NULL,
    total_amount numeric(18,2) DEFAULT 0 NOT NULL,
    source_system text DEFAULT 'core_banking'::text NOT NULL,
    destination_system text DEFAULT 'bill'::text,
    nifi_flow_id text,
    nifi_processor_id text,
    delivery_endpoint text,
    delivery_attempts integer DEFAULT 0,
    last_error text,
    picked_up_at timestamp with time zone,
    delivered_at timestamp with time zone,
    acknowledged_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT nifi_payment_files_direction_check CHECK ((direction = ANY (ARRAY['outbound'::text, 'inbound'::text]))),
    CONSTRAINT nifi_payment_files_file_format_check CHECK ((file_format = ANY (ARRAY['nacha'::text, 'iso20022'::text, 'csv'::text, 'json'::text]))),
    CONSTRAINT nifi_payment_files_status_check CHECK ((status = ANY (ARRAY['generated'::text, 'staged'::text, 'picked_up'::text, 'delivered'::text, 'acknowledged'::text, 'failed'::text, 'expired'::text])))
);


--
-- Name: nifi_payment_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.nifi_payment_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: nifi_payment_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.nifi_payment_files_id_seq OWNED BY public.nifi_payment_files.id;


--
-- Name: ofx_institutions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ofx_institutions (
    id integer NOT NULL,
    name text NOT NULL,
    org text,
    fid text,
    base_url text,
    ofx_version text DEFAULT '200'::text,
    username text,
    password text,
    bank_id text,
    account_id text,
    account_type text DEFAULT 'CHECKING'::text,
    routing_number text,
    status text DEFAULT 'active'::text,
    mode text DEFAULT 'simulate'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT ofx_institutions_mode_check CHECK ((mode = ANY (ARRAY['simulate'::text, 'live'::text]))),
    CONSTRAINT ofx_institutions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text])))
);


--
-- Name: ofx_institutions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ofx_institutions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ofx_institutions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ofx_institutions_id_seq OWNED BY public.ofx_institutions.id;


--
-- Name: ofx_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ofx_payments (
    id integer NOT NULL,
    institution_id integer,
    payment_type text NOT NULL,
    reference text NOT NULL,
    amount_cents bigint NOT NULL,
    currency text DEFAULT 'USD'::text,
    source_account_id text,
    source_type text,
    payee_name text,
    payee_account text,
    payee_bank_id text,
    payee_routing text,
    payee_address1 text,
    payee_address2 text,
    payee_city text,
    payee_state text,
    payee_postal text,
    payee_country text DEFAULT 'USA'::text,
    due_date date,
    memo text,
    ofx_request text,
    ofx_response text,
    server_id text,
    status text DEFAULT 'pending'::text,
    status_detail text,
    submitted_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT ofx_payments_payment_type_check CHECK ((payment_type = ANY (ARRAY['billpay'::text, 'wire'::text, 'intrabank'::text, 'interbank'::text, 'ach'::text]))),
    CONSTRAINT ofx_payments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'submitted'::text, 'accepted'::text, 'rejected'::text, 'cleared'::text, 'cancelled'::text])))
);


--
-- Name: ofx_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ofx_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ofx_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ofx_payments_id_seq OWNED BY public.ofx_payments.id;


--
-- Name: ofx_statements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ofx_statements (
    id integer NOT NULL,
    institution_id integer,
    account_id text,
    currency text,
    start_date date,
    end_date date,
    ledger_balance_cents bigint,
    ledger_balance_date date,
    raw_content text,
    parsed_at timestamp with time zone DEFAULT now()
);


--
-- Name: ofx_statements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ofx_statements_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ofx_statements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ofx_statements_id_seq OWNED BY public.ofx_statements.id;


--
-- Name: ofx_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ofx_transactions (
    id integer NOT NULL,
    statement_id integer,
    fit_id text,
    posted_at date,
    type text,
    amount_cents bigint,
    name text,
    memo text,
    check_number text,
    ref_num text,
    reference text,
    reconciled boolean DEFAULT false
);


--
-- Name: ofx_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ofx_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ofx_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ofx_transactions_id_seq OWNED BY public.ofx_transactions.id;


--
-- Name: payment_approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_approvals (
    id bigint NOT NULL,
    approval_id text NOT NULL,
    intent_id text NOT NULL,
    approver_id text NOT NULL,
    decision text NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_approvals_decision_check CHECK ((decision = ANY (ARRAY['approved'::text, 'rejected'::text])))
);


--
-- Name: payment_approvals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payment_approvals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payment_approvals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payment_approvals_id_seq OWNED BY public.payment_approvals.id;


--
-- Name: payment_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_events (
    id bigint NOT NULL,
    event_id text NOT NULL,
    intent_id text NOT NULL,
    event_type text NOT NULL,
    from_status text,
    to_status text,
    actor_id text NOT NULL,
    external_event_id text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    previous_hash character(64),
    event_hash character(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payment_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payment_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payment_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payment_events_id_seq OWNED BY public.payment_events.id;


--
-- Name: payment_funding_holds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_funding_holds (
    id bigint NOT NULL,
    hold_id text NOT NULL,
    intent_id text NOT NULL,
    source_type text NOT NULL,
    source_id text NOT NULL,
    amount_cents bigint NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    captured_at timestamp with time zone,
    released_at timestamp with time zone,
    release_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_funding_holds_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT payment_funding_holds_source_type_check CHECK ((source_type = ANY (ARRAY['trust_account'::text, 'sub_ledger'::text]))),
    CONSTRAINT payment_funding_holds_status_check CHECK ((status = ANY (ARRAY['active'::text, 'captured'::text, 'released'::text, 'expired'::text])))
);


--
-- Name: payment_funding_holds_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payment_funding_holds_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payment_funding_holds_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payment_funding_holds_id_seq OWNED BY public.payment_funding_holds.id;


--
-- Name: payment_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_intents (
    id bigint NOT NULL,
    intent_id text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    status text DEFAULT 'pending_approval'::text NOT NULL,
    rail text DEFAULT 'ach'::text NOT NULL,
    payment_type text NOT NULL,
    amount_cents bigint NOT NULL,
    currency character(3) DEFAULT 'USD'::bpchar NOT NULL,
    source_type text DEFAULT 'trust_account'::text NOT NULL,
    source_account_code text,
    source_sub_ledger_id text,
    debit_account_code text NOT NULL,
    beneficiary_name text NOT NULL,
    beneficiary_routing_encrypted text NOT NULL,
    beneficiary_routing_hash text NOT NULL,
    beneficiary_routing_last4 character(4) NOT NULL,
    beneficiary_account_encrypted text NOT NULL,
    beneficiary_account_hash text NOT NULL,
    beneficiary_account_last4 character varying(4) NOT NULL,
    beneficiary_account_type text DEFAULT 'checking'::text NOT NULL,
    sec_code character(3) DEFAULT 'CCD'::bpchar NOT NULL,
    effective_date date NOT NULL,
    description text,
    maker_id text NOT NULL,
    approval_count integer DEFAULT 0 NOT NULL,
    required_approvals integer DEFAULT 1 NOT NULL,
    payment_hub_txn_id text,
    ach_batch_id text,
    remote_reference text,
    hold_id text,
    accounting_status text DEFAULT 'pending'::text NOT NULL,
    journal_entry_id text,
    accounting_error text,
    error_code text,
    error_message text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    approved_at timestamp with time zone,
    queued_at timestamp with time zone,
    transmitted_at timestamp with time zone,
    accepted_at timestamp with time zone,
    settled_at timestamp with time zone,
    returned_at timestamp with time zone,
    failed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_intents_accounting_status_check CHECK ((accounting_status = ANY (ARRAY['pending'::text, 'posting'::text, 'posted'::text, 'failed'::text, 'reversed'::text, 'not_required'::text]))),
    CONSTRAINT payment_intents_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT payment_intents_beneficiary_account_type_check CHECK ((beneficiary_account_type = ANY (ARRAY['checking'::text, 'savings'::text]))),
    CONSTRAINT payment_intents_check CHECK ((((source_type = 'trust_account'::text) AND (source_account_code IS NOT NULL)) OR ((source_type = 'sub_ledger'::text) AND (source_sub_ledger_id IS NOT NULL)))),
    CONSTRAINT payment_intents_rail_check CHECK ((rail = ANY (ARRAY['ach'::text, 'wire'::text, 'stablecoin'::text]))),
    CONSTRAINT payment_intents_sec_code_check CHECK ((sec_code = ANY (ARRAY['CCD'::bpchar, 'PPD'::bpchar]))),
    CONSTRAINT payment_intents_source_type_check CHECK ((source_type = ANY (ARRAY['trust_account'::text, 'sub_ledger'::text]))),
    CONSTRAINT payment_intents_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'pending_approval'::text, 'approved'::text, 'queued'::text, 'orchestrating'::text, 'transmitting'::text, 'transmitted'::text, 'accepted'::text, 'clearing'::text, 'settled'::text, 'returned'::text, 'failed'::text, 'rejected'::text, 'cancelled'::text])))
);


--
-- Name: payment_intents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payment_intents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payment_intents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payment_intents_id_seq OWNED BY public.payment_intents.id;


--
-- Name: payment_webhook_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_webhook_receipts (
    id bigint NOT NULL,
    receipt_id text NOT NULL,
    external_event_id text NOT NULL,
    intent_id text,
    event_type text NOT NULL,
    payload_hash character(64) NOT NULL,
    processing_status text DEFAULT 'pending'::text NOT NULL,
    error_message text,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_webhook_receipts_processing_status_check CHECK ((processing_status = ANY (ARRAY['pending'::text, 'processed'::text, 'rejected'::text, 'failed'::text])))
);


--
-- Name: payment_webhook_receipts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payment_webhook_receipts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payment_webhook_receipts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payment_webhook_receipts_id_seq OWNED BY public.payment_webhook_receipts.id;


--
-- Name: security_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.security_audit_log (
    id integer NOT NULL,
    event_type character varying(100) NOT NULL,
    user_id integer,
    username character varying(100),
    ip_address character varying(45),
    user_agent text,
    details jsonb,
    severity character varying(20) DEFAULT 'info'::character varying,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: security_audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.security_audit_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: security_audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.security_audit_log_id_seq OWNED BY public.security_audit_log.id;


--
-- Name: sovereign_ramp_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sovereign_ramp_orders (
    id text NOT NULL,
    token_id text,
    direction text NOT NULL,
    source_type text,
    source_account_id text,
    amount_cents bigint NOT NULL,
    target_address text,
    fiat_destination text,
    on_chain_tx text,
    on_chain_status text,
    status text DEFAULT 'pending'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    source_ref jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sovereign_token_holders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sovereign_token_holders (
    id text NOT NULL,
    token_id text,
    address text NOT NULL,
    balance_cents bigint DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sovereign_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sovereign_tokens (
    id text NOT NULL,
    network text NOT NULL,
    chain_id integer NOT NULL,
    token_address text,
    forwarder_address text,
    token_symbol text DEFAULT 'SIT'::text NOT NULL,
    token_name text DEFAULT 'Sovereign Trust Token'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    shadow boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stablecoin_clearing_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stablecoin_clearing_orders (
    id text NOT NULL,
    wallet_id text,
    source_type text NOT NULL,
    source_account_id text NOT NULL,
    destination_wallet text NOT NULL,
    amount_cents bigint NOT NULL,
    fee_cents bigint DEFAULT 0 NOT NULL,
    total_cents bigint NOT NULL,
    asset_code text DEFAULT 'USDC'::text NOT NULL,
    network text DEFAULT 'testnet'::text NOT NULL,
    wallet_provider text DEFAULT 'direct'::text NOT NULL,
    payment_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    tx_hash text,
    tx_explorer text,
    error_message text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stablecoin_clearing_orders_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT stablecoin_clearing_orders_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'settled'::text, 'failed'::text])))
);


--
-- Name: stablecoin_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stablecoin_payments (
    id text NOT NULL,
    payment_hub_intent_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    amount_cents bigint NOT NULL,
    fee_cents bigint DEFAULT 0 NOT NULL,
    total_cents bigint NOT NULL,
    asset_code text DEFAULT 'USDC'::text NOT NULL,
    network text DEFAULT 'testnet'::text NOT NULL,
    destination_wallet text,
    wallet_provider text,
    source_type text DEFAULT 'treasury'::text,
    source_account_id text,
    source_ref jsonb DEFAULT '{}'::jsonb,
    reserve_id text,
    tx_hash text,
    tx_ledger text,
    tx_explorer text,
    latency_ms integer,
    memo text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stablecoin_payments_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT stablecoin_payments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'settled'::text, 'failed'::text])))
);


--
-- Name: stablecoin_reserves; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stablecoin_reserves (
    reserve_id text NOT NULL,
    payment_id text NOT NULL,
    account_id text NOT NULL,
    amount_cents bigint NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    tx_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    released_at timestamp with time zone,
    CONSTRAINT stablecoin_reserves_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT stablecoin_reserves_status_check CHECK ((status = ANY (ARRAY['active'::text, 'posted'::text, 'released'::text])))
);


--
-- Name: stablecoin_treasury_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stablecoin_treasury_accounts (
    account_id text NOT NULL,
    type text DEFAULT 'hot'::text NOT NULL,
    network text DEFAULT 'testnet'::text NOT NULL,
    asset_code text DEFAULT 'USDC'::text NOT NULL,
    public_address text,
    balance_cents bigint DEFAULT 0 NOT NULL,
    hold_cents bigint DEFAULT 0 NOT NULL,
    available_cents bigint DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stablecoin_wallet_registry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stablecoin_wallet_registry (
    id text NOT NULL,
    label text DEFAULT ''::text NOT NULL,
    source_type text DEFAULT 'treasury'::text NOT NULL,
    source_account_id text DEFAULT 'TREASURY_HOT'::text NOT NULL,
    address text NOT NULL,
    network text DEFAULT 'testnet'::text NOT NULL,
    wallet_provider text DEFAULT 'direct'::text NOT NULL,
    parent_wallet_id text,
    status text DEFAULT 'active'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stablecoin_wallet_registry_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))
);


--
-- Name: stp_processing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stp_processing (
    id integer NOT NULL,
    stp_id text NOT NULL,
    settlement_id text NOT NULL,
    payment_type text NOT NULL,
    payment_method text DEFAULT 'bill'::text NOT NULL,
    amount numeric(18,2) NOT NULL,
    payee_name text NOT NULL,
    bill_vendor_id text,
    bill_bill_id text,
    bill_sent_pay_id text,
    bill_received_pay_id text,
    bill_chart_of_acct text,
    bill_gl_posting_date date,
    bill_payment_terms text DEFAULT 'Net 0'::text,
    bill_bank_account_id text,
    bill_invoice_id text,
    bill_invoice_number text,
    enrichment_complete boolean DEFAULT false,
    enrichment_errors text,
    stp_status text DEFAULT 'pending'::text NOT NULL,
    submitted_at timestamp with time zone DEFAULT now(),
    enriched_at timestamp with time zone,
    transmitted_at timestamp with time zone,
    clearing_at timestamp with time zone,
    cleared_at timestamp with time zone,
    posted_at timestamp with time zone,
    available_at timestamp with time zone,
    settlement_date date,
    availability_date date,
    settlement_timing text DEFAULT 'T+1'::text,
    last_bill_status text,
    last_bill_poll_at timestamp with time zone,
    bill_process_date date,
    bill_clearing_status text,
    stp_hash text,
    clearing_ref text,
    posting_ref text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT stp_processing_stp_status_check CHECK ((stp_status = ANY (ARRAY['pending'::text, 'enriched'::text, 'transmitted'::text, 'clearing'::text, 'cleared'::text, 'posted'::text, 'available'::text, 'failed'::text, 'returned'::text])))
);


--
-- Name: stp_processing_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stp_processing_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stp_processing_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stp_processing_id_seq OWNED BY public.stp_processing.id;


--
-- Name: sub_ledger_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sub_ledger_transactions (
    id integer NOT NULL,
    transaction_id text NOT NULL,
    sub_ledger_id text NOT NULL,
    transaction_type text NOT NULL,
    amount numeric(18,2) NOT NULL,
    running_balance numeric(18,2) NOT NULL,
    description text,
    reference_type text,
    reference_id text,
    journal_entry_id text,
    posted_by text DEFAULT 'system'::text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT sub_ledger_transactions_transaction_type_check CHECK ((transaction_type = ANY (ARRAY['debit'::text, 'credit'::text, 'opening_balance'::text, 'adjustment'::text, 'distribution'::text, 'fee'::text, 'interest'::text, 'transfer'::text])))
);


--
-- Name: sub_ledger_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sub_ledger_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sub_ledger_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sub_ledger_transactions_id_seq OWNED BY public.sub_ledger_transactions.id;


--
-- Name: system_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_settings (
    key character varying(100) NOT NULL,
    value text DEFAULT ''::text NOT NULL,
    updated_at timestamp without time zone DEFAULT now(),
    updated_by character varying(100) DEFAULT 'system'::character varying
);


--
-- Name: trust_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trust_accounts (
    id integer NOT NULL,
    account_code text NOT NULL,
    account_name text NOT NULL,
    account_type text NOT NULL,
    sub_type text,
    parent_account_code text,
    linked_cash_account text,
    linked_fineract_gl text,
    balance numeric(18,2) DEFAULT 0,
    currency text DEFAULT 'USD'::text,
    is_active boolean DEFAULT true,
    description text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT trust_accounts_account_type_check CHECK ((account_type = ANY (ARRAY['asset'::text, 'liability'::text, 'equity'::text, 'income'::text, 'expense'::text]))),
    CONSTRAINT trust_accounts_sub_type_check CHECK ((sub_type = ANY (ARRAY['cash'::text, 'investment'::text, 'receivable'::text, 'payable'::text, 'trust_corpus'::text, 'undistributed_income'::text, 'interest_income'::text, 'fee_income'::text, 'management_fee'::text, 'trustee_fee'::text, 'legal_fee'::text, 'operating_expense'::text, 'distribution'::text, 'unrealized_gain'::text, 'realized_gain'::text, 'tax_provision'::text, 'reserve'::text, 'other'::text])))
);


--
-- Name: trust_accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trust_accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trust_accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trust_accounts_id_seq OWNED BY public.trust_accounts.id;


--
-- Name: trust_journal_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trust_journal_entries (
    id integer NOT NULL,
    entry_id text NOT NULL,
    entry_date date NOT NULL,
    description text NOT NULL,
    reference_type text,
    reference_id text,
    bond_id integer,
    posted_by text,
    fineract_txn_id text,
    status text DEFAULT 'posted'::text,
    reversal_of text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT trust_journal_entries_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'posted'::text, 'reversed'::text, 'void'::text])))
);


--
-- Name: trust_journal_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trust_journal_entries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trust_journal_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trust_journal_entries_id_seq OWNED BY public.trust_journal_entries.id;


--
-- Name: trust_journal_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trust_journal_lines (
    id integer NOT NULL,
    entry_id text NOT NULL,
    account_code text NOT NULL,
    debit_amount numeric(18,2) DEFAULT 0,
    credit_amount numeric(18,2) DEFAULT 0,
    memo text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: trust_journal_lines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trust_journal_lines_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trust_journal_lines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trust_journal_lines_id_seq OWNED BY public.trust_journal_lines.id;


--
-- Name: trust_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trust_periods (
    id integer NOT NULL,
    period_name text NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    status text DEFAULT 'open'::text,
    closed_by text,
    closed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT trust_periods_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closing'::text, 'closed'::text])))
);


--
-- Name: trust_periods_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trust_periods_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trust_periods_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trust_periods_id_seq OWNED BY public.trust_periods.id;


--
-- Name: trustee_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trustee_reviews (
    id integer NOT NULL,
    review_id text NOT NULL,
    review_type text NOT NULL,
    review_date date DEFAULT CURRENT_DATE NOT NULL,
    summary text,
    findings jsonb,
    recommendations jsonb,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT trustee_reviews_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'final'::text, 'acknowledged'::text])))
);


--
-- Name: trustee_reviews_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trustee_reviews_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trustee_reviews_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trustee_reviews_id_seq OWNED BY public.trustee_reviews.id;


--
-- Name: trustee_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trustee_tasks (
    id integer NOT NULL,
    task_id text NOT NULL,
    task_type text NOT NULL,
    category text DEFAULT 'general'::text NOT NULL,
    title text NOT NULL,
    description text,
    status text DEFAULT 'pending'::text NOT NULL,
    priority text DEFAULT 'normal'::text NOT NULL,
    scheduled_date date,
    completed_date timestamp with time zone,
    result jsonb,
    created_by text DEFAULT 'trustee_agent'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT trustee_tasks_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'critical'::text]))),
    CONSTRAINT trustee_tasks_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'completed'::text, 'failed'::text, 'skipped'::text])))
);


--
-- Name: trustee_tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trustee_tasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trustee_tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trustee_tasks_id_seq OWNED BY public.trustee_tasks.id;


--
-- Name: vendor_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_payments (
    id integer NOT NULL,
    payment_id text NOT NULL,
    vendor_id text NOT NULL,
    source_type text DEFAULT 'trust'::text NOT NULL,
    source_account_code text DEFAULT '1000'::text NOT NULL,
    sub_ledger_id text,
    amount numeric(18,2) NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    payment_method text DEFAULT 'ach'::text NOT NULL,
    payment_type text DEFAULT 'vendor_payment'::text NOT NULL,
    description text,
    invoice_number text,
    invoice_date date,
    due_date date,
    status text DEFAULT 'pending_approval'::text NOT NULL,
    initiated_by text DEFAULT 'system'::text NOT NULL,
    approved_by text,
    rejected_by text,
    rejection_reason text,
    ach_batch_id text,
    wire_id text,
    bill_payment_id text,
    journal_entry_id text,
    approved_at timestamp with time zone,
    rejected_at timestamp with time zone,
    executed_at timestamp with time zone,
    settled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    payment_intent_id text,
    CONSTRAINT vendor_payments_payment_method_check CHECK ((payment_method = ANY (ARRAY['ach'::text, 'wire'::text, 'bill'::text]))),
    CONSTRAINT vendor_payments_payment_type_check CHECK ((payment_type = ANY (ARRAY['vendor_payment'::text, 'fee_payment'::text, 'legal_fee'::text, 'insurance_premium'::text, 'regulatory_fee'::text, 'trust_expense'::text, 'other'::text]))),
    CONSTRAINT vendor_payments_source_type_check CHECK ((source_type = ANY (ARRAY['trust'::text, 'sub_ledger'::text]))),
    CONSTRAINT vendor_payments_status_check CHECK ((status = ANY (ARRAY['pending_approval'::text, 'approved'::text, 'rejected'::text, 'processing'::text, 'executed'::text, 'settled'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: vendor_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vendor_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vendor_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vendor_payments_id_seq OWNED BY public.vendor_payments.id;


--
-- Name: vendors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendors (
    id integer NOT NULL,
    vendor_id text NOT NULL,
    vendor_name text NOT NULL,
    vendor_type text DEFAULT 'general'::text NOT NULL,
    contact_name text,
    contact_email text,
    contact_phone text,
    address text,
    tax_id text,
    bank_name text,
    routing_number text,
    account_number text,
    account_type text DEFAULT 'checking'::text,
    bill_vendor_id text,
    payment_method text DEFAULT 'ach'::text NOT NULL,
    payment_terms text DEFAULT 'net_30'::text,
    status text DEFAULT 'active'::text NOT NULL,
    approved_by text,
    approved_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT vendors_account_type_check CHECK ((account_type = ANY (ARRAY['checking'::text, 'savings'::text]))),
    CONSTRAINT vendors_payment_method_check CHECK ((payment_method = ANY (ARRAY['ach'::text, 'wire'::text, 'bill'::text, 'auto'::text]))),
    CONSTRAINT vendors_payment_terms_check CHECK ((payment_terms = ANY (ARRAY['immediate'::text, 'net_15'::text, 'net_30'::text, 'net_60'::text, 'net_90'::text]))),
    CONSTRAINT vendors_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'suspended'::text]))),
    CONSTRAINT vendors_vendor_type_check CHECK ((vendor_type = ANY (ARRAY['general'::text, 'legal'::text, 'accounting'::text, 'custodian'::text, 'broker'::text, 'consultant'::text, 'technology'::text, 'insurance'::text, 'regulatory'::text, 'other'::text])))
);


--
-- Name: vendors_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vendors_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vendors_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vendors_id_seq OWNED BY public.vendors.id;


--
-- Name: wire_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wire_audit_log (
    id integer NOT NULL,
    wire_id text NOT NULL,
    action text NOT NULL,
    actor text,
    details jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: wire_audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wire_audit_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wire_audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wire_audit_log_id_seq OWNED BY public.wire_audit_log.id;


--
-- Name: wire_transfers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wire_transfers (
    id integer NOT NULL,
    wire_id text NOT NULL,
    status text DEFAULT 'initiated'::text NOT NULL,
    amount_cents bigint NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    wire_type text DEFAULT 'funds_transfer'::text NOT NULL,
    type_code text DEFAULT '10'::text,
    subtype_code text DEFAULT '00'::text,
    payment_type text DEFAULT 'trust_distribution'::text,
    purpose text,
    description text,
    sender_name text NOT NULL,
    sender_routing text NOT NULL,
    sender_account text NOT NULL,
    sender_address text,
    beneficiary_name text NOT NULL,
    beneficiary_routing text NOT NULL,
    beneficiary_account text NOT NULL,
    beneficiary_bank_name text,
    beneficiary_address text,
    intermediary_routing text,
    intermediary_name text,
    imad text,
    omad text,
    fed_reference text,
    confirmation_number text,
    initiated_by text DEFAULT 'system'::text NOT NULL,
    approved_by text,
    rejected_by text,
    rejection_reason text,
    requires_approval boolean DEFAULT true NOT NULL,
    journal_entry_id text,
    error_message text,
    retry_count integer DEFAULT 0,
    initiated_at timestamp with time zone DEFAULT now(),
    approved_at timestamp with time zone,
    rejected_at timestamp with time zone,
    sent_at timestamp with time zone,
    confirmed_at timestamp with time zone,
    settled_at timestamp with time zone,
    returned_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    accounting_status text DEFAULT 'pending'::text NOT NULL,
    accounting_error text,
    CONSTRAINT wire_transfers_accounting_status_check CHECK ((accounting_status = ANY (ARRAY['pending'::text, 'posting'::text, 'posted'::text, 'failed'::text]))),
    CONSTRAINT wire_transfers_status_check CHECK ((status = ANY (ARRAY['initiated'::text, 'pending_approval'::text, 'approved'::text, 'rejected'::text, 'sending'::text, 'sent'::text, 'confirmed'::text, 'settled'::text, 'failed'::text, 'cancelled'::text, 'returned'::text])))
);


--
-- Name: wire_transfers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wire_transfers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wire_transfers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wire_transfers_id_seq OWNED BY public.wire_transfers.id;


--
-- Name: admin_audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_log ALTER COLUMN id SET DEFAULT nextval('public.admin_audit_log_id_seq'::regclass);


--
-- Name: auth_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions ALTER COLUMN id SET DEFAULT nextval('public.auth_sessions_id_seq'::regclass);


--
-- Name: auth_users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_users ALTER COLUMN id SET DEFAULT nextval('public.auth_users_id_seq'::regclass);


--
-- Name: bill_settlement_queue id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bill_settlement_queue ALTER COLUMN id SET DEFAULT nextval('public.bill_settlement_queue_id_seq'::regclass);


--
-- Name: bill_sync_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bill_sync_log ALTER COLUMN id SET DEFAULT nextval('public.bill_sync_log_id_seq'::regclass);


--
-- Name: bond_balances id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bond_balances ALTER COLUMN id SET DEFAULT nextval('public.bond_balances_id_seq'::regclass);


--
-- Name: bond_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bond_transactions ALTER COLUMN id SET DEFAULT nextval('public.bond_transactions_id_seq'::regclass);


--
-- Name: bond_trustees id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bond_trustees ALTER COLUMN id SET DEFAULT nextval('public.bond_trustees_id_seq'::regclass);


--
-- Name: bonds id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonds ALTER COLUMN id SET DEFAULT nextval('public.bonds_id_seq'::regclass);


--
-- Name: bookkeeping_adjustments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookkeeping_adjustments ALTER COLUMN id SET DEFAULT nextval('public.bookkeeping_adjustments_id_seq'::regclass);


--
-- Name: bookkeeping_reconciliations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookkeeping_reconciliations ALTER COLUMN id SET DEFAULT nextval('public.bookkeeping_reconciliations_id_seq'::regclass);


--
-- Name: bookkeeping_tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookkeeping_tasks ALTER COLUMN id SET DEFAULT nextval('public.bookkeeping_tasks_id_seq'::regclass);


--
-- Name: cash_accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_accounts ALTER COLUMN id SET DEFAULT nextval('public.cash_accounts_id_seq'::regclass);


--
-- Name: cash_movements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_movements ALTER COLUMN id SET DEFAULT nextval('public.cash_movements_id_seq'::regclass);


--
-- Name: client_sub_ledgers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_sub_ledgers ALTER COLUMN id SET DEFAULT nextval('public.client_sub_ledgers_id_seq'::regclass);


--
-- Name: coupon_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupon_payments ALTER COLUMN id SET DEFAULT nextval('public.coupon_payments_id_seq'::regclass);


--
-- Name: crm_bond_subscriptions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_bond_subscriptions ALTER COLUMN id SET DEFAULT nextval('public.crm_bond_subscriptions_id_seq'::regclass);


--
-- Name: crm_contacts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contacts ALTER COLUMN id SET DEFAULT nextval('public.crm_contacts_id_seq'::regclass);


--
-- Name: crm_interactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_interactions ALTER COLUMN id SET DEFAULT nextval('public.crm_interactions_id_seq'::regclass);


--
-- Name: data_bridge_discrepancies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_bridge_discrepancies ALTER COLUMN id SET DEFAULT nextval('public.data_bridge_discrepancies_id_seq'::regclass);


--
-- Name: data_bridge_sync_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_bridge_sync_log ALTER COLUMN id SET DEFAULT nextval('public.data_bridge_sync_log_id_seq'::regclass);


--
-- Name: document_templates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_templates ALTER COLUMN id SET DEFAULT nextval('public.document_templates_id_seq'::regclass);


--
-- Name: documents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents ALTER COLUMN id SET DEFAULT nextval('public.documents_id_seq'::regclass);


--
-- Name: electronic_settlements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.electronic_settlements ALTER COLUMN id SET DEFAULT nextval('public.electronic_settlements_id_seq'::regclass);


--
-- Name: generated_documents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_documents ALTER COLUMN id SET DEFAULT nextval('public.generated_documents_id_seq'::regclass);


--
-- Name: nifi_payment_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nifi_payment_files ALTER COLUMN id SET DEFAULT nextval('public.nifi_payment_files_id_seq'::regclass);


--
-- Name: ofx_institutions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ofx_institutions ALTER COLUMN id SET DEFAULT nextval('public.ofx_institutions_id_seq'::regclass);


--
-- Name: ofx_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ofx_payments ALTER COLUMN id SET DEFAULT nextval('public.ofx_payments_id_seq'::regclass);


--
-- Name: ofx_statements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ofx_statements ALTER COLUMN id SET DEFAULT nextval('public.ofx_statements_id_seq'::regclass);


--
-- Name: ofx_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ofx_transactions ALTER COLUMN id SET DEFAULT nextval('public.ofx_transactions_id_seq'::regclass);


--
-- Name: payment_approvals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_approvals ALTER COLUMN id SET DEFAULT nextval('public.payment_approvals_id_seq'::regclass);


--
-- Name: payment_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_events ALTER COLUMN id SET DEFAULT nextval('public.payment_events_id_seq'::regclass);


--
-- Name: payment_funding_holds id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_funding_holds ALTER COLUMN id SET DEFAULT nextval('public.payment_funding_holds_id_seq'::regclass);


--
-- Name: payment_intents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_intents ALTER COLUMN id SET DEFAULT nextval('public.payment_intents_id_seq'::regclass);


--
-- Name: payment_webhook_receipts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_webhook_receipts ALTER COLUMN id SET DEFAULT nextval('public.payment_webhook_receipts_id_seq'::regclass);


--
-- Name: security_audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_audit_log ALTER COLUMN id SET DEFAULT nextval('public.security_audit_log_id_seq'::regclass);


--
-- Name: stp_processing id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stp_processing ALTER COLUMN id SET DEFAULT nextval('public.stp_processing_id_seq'::regclass);


--
-- Name: sub_ledger_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sub_ledger_transactions ALTER COLUMN id SET DEFAULT nextval('public.sub_ledger_transactions_id_seq'::regclass);


--
-- Name: trust_accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_accounts ALTER COLUMN id SET DEFAULT nextval('public.trust_accounts_id_seq'::regclass);


--
-- Name: trust_journal_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_journal_entries ALTER COLUMN id SET DEFAULT nextval('public.trust_journal_entries_id_seq'::regclass);


--
-- Name: trust_journal_lines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_journal_lines ALTER COLUMN id SET DEFAULT nextval('public.trust_journal_lines_id_seq'::regclass);


--
-- Name: trust_periods id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_periods ALTER COLUMN id SET DEFAULT nextval('public.trust_periods_id_seq'::regclass);


--
-- Name: trustee_reviews id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trustee_reviews ALTER COLUMN id SET DEFAULT nextval('public.trustee_reviews_id_seq'::regclass);


--
-- Name: trustee_tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trustee_tasks ALTER COLUMN id SET DEFAULT nextval('public.trustee_tasks_id_seq'::regclass);


--
-- Name: vendor_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_payments ALTER COLUMN id SET DEFAULT nextval('public.vendor_payments_id_seq'::regclass);


--
-- Name: vendors id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendors ALTER COLUMN id SET DEFAULT nextval('public.vendors_id_seq'::regclass);


--
-- Name: wire_audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wire_audit_log ALTER COLUMN id SET DEFAULT nextval('public.wire_audit_log_id_seq'::regclass);


--
-- Name: wire_transfers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wire_transfers ALTER COLUMN id SET DEFAULT nextval('public.wire_transfers_id_seq'::regclass);


--
-- Data for Name: admin_audit_log; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.admin_audit_log (id, admin_user, action, resource_type, resource_id, payload, result, ip_address, created_at) FROM stdin;
1	admin	health_check	system	\N	\N	{"crm": {"status": "ok", "total_contacts": 1}, "fineract": {"status": "error", "message": "Fineract not reachable — start with: docker compose up -d"}, "postgresql": {"status": "connected"}, "bond_engine": {"status": "ok", "active_bonds": 1}, "cash_engine": {"status": "ok", "tables": {"cash_accounts": true, "cash_movements": true}}, "generated_at": "2026-07-29T13:58:49.920Z", "payment_system": {"mode": "sandbox", "as2_configured": false, "admin_token_secure": true}}	::1	2026-07-29 13:58:49.928941+00
2	admin	health_check	system	\N	\N	{"crm": {"status": "ok", "total_contacts": 1}, "fineract": {"status": "error", "message": "Fineract not reachable — start with: docker compose up -d"}, "postgresql": {"status": "connected"}, "bond_engine": {"status": "ok", "active_bonds": 1}, "cash_engine": {"status": "ok", "tables": {"cash_accounts": true, "cash_movements": true}}, "generated_at": "2026-07-29T14:00:16.152Z", "payment_system": {"mode": "sandbox", "as2_configured": false, "admin_token_secure": true}}	::1	2026-07-29 14:00:16.162905+00
3	admin	health_check	system	\N	\N	{"crm": {"status": "ok", "total_contacts": 1}, "fineract": {"status": "error", "message": "Fineract not reachable — start with: docker compose up -d"}, "postgresql": {"status": "connected"}, "bond_engine": {"status": "ok", "active_bonds": 1}, "cash_engine": {"status": "ok", "tables": {"cash_accounts": true, "cash_movements": true}}, "generated_at": "2026-07-29T14:12:59.078Z", "payment_system": {"mode": "sandbox", "as2_configured": false, "admin_token_secure": true}}	::1	2026-07-29 14:12:59.091608+00
4	admin	health_check	system	\N	\N	{"crm": {"status": "ok", "total_contacts": 1}, "fineract": {"status": "error", "message": "Fineract not reachable — start with: docker compose up -d"}, "postgresql": {"status": "connected"}, "bond_engine": {"status": "ok", "active_bonds": 1}, "cash_engine": {"status": "ok", "tables": {"cash_accounts": true, "cash_movements": true}}, "generated_at": "2026-07-30T02:23:36.485Z", "payment_system": {"mode": "sandbox", "as2_configured": false, "admin_token_secure": true}}	::1	2026-07-30 02:23:36.519155+00
5	admin	health_check	system	\N	\N	{"crm": {"status": "ok", "total_contacts": 1}, "fineract": {"status": "error", "message": "Fineract not reachable — start with: docker compose up -d"}, "postgresql": {"status": "connected"}, "bond_engine": {"status": "ok", "active_bonds": 1}, "cash_engine": {"status": "ok", "tables": {"cash_accounts": true, "cash_movements": true}}, "generated_at": "2026-07-30T15:27:40.518Z", "payment_system": {"mode": "sandbox", "as2_configured": false, "admin_token_secure": true}}	::1	2026-07-30 15:27:40.542363+00
\.


--
-- Data for Name: aggregator_accounts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.aggregator_accounts (id, connection_id, external_account_id, name, account_type, currency, mask, balance_available, balance_current, raw, updated_at) FROM stdin;
\.


--
-- Data for Name: aggregator_connections; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.aggregator_connections (id, name, connector_type, direction, config, active, last_pull_at, last_push_at, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: aggregator_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.aggregator_events (id, connection_id, direction, event_type, payload, status, error, provider_ref, created_at) FROM stdin;
\.


--
-- Data for Name: aggregator_statements; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.aggregator_statements (id, connection_id, external_account_id, external_statement_id, period_start, period_end, format, uri, raw, created_at) FROM stdin;
\.


--
-- Data for Name: aggregator_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.aggregator_transactions (id, connection_id, external_account_id, external_txn_id, posted_date, amount, currency, direction, description, category, status, raw, created_at) FROM stdin;
\.


--
-- Data for Name: auth_sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.auth_sessions (id, user_id, token_id, ip_address, user_agent, expires_at, revoked, created_at) FROM stdin;
1	1	ef1572347bdb7e67d5ded930c5285b219490645b890be9f48bcc05c67b054246	::ffff:127.0.0.1	curl/7.81.0	2026-07-29 10:27:11+00	f	2026-07-29 02:27:11.595164+00
2	1	2671c05634268219de080a5cac99a3aae805a67d32d451b4549ec218cb96c1c9	::ffff:127.0.0.1	curl/7.81.0	2026-07-29 10:28:25+00	f	2026-07-29 02:28:25.852681+00
3	1	7dfbef52eb5f47183419c2c9013ae83de3c7001e4a68ef2a30c121ee66abd406	::ffff:127.0.0.1	curl/7.81.0	2026-07-29 10:29:30+00	f	2026-07-29 02:29:30.40553+00
4	1	549ad941182e6397b78dd1244f394bcf5586096da15cbde1b3e3be5238fc0761	::ffff:127.0.0.1	curl/7.81.0	2026-07-29 10:33:06+00	f	2026-07-29 02:33:06.842467+00
5	1	fedd47e1fdc776cd4a59cb86cddbb76704941aea8015e37cf0054310873f3198	::1	Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36; Devin/1.0; +devin.ai	2026-07-29 10:35:48+00	f	2026-07-29 02:35:48.62536+00
6	1	7991195bcaae61755b2792eb8f0221e6c836818def92d802cc31d0c290182b8e	::ffff:127.0.0.1	curl/7.81.0	2026-07-29 10:39:41+00	f	2026-07-29 02:39:41.354688+00
7	1	4f8068dc78552990f62029c7178e589c8c88831f23c68febeb9b0fc4fee8e552	::1	Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36; Devin/1.0; +devin.ai	2026-07-29 10:41:07+00	f	2026-07-29 02:41:07.194114+00
8	1	21b325543da8fc8d54ae97de01de8ac6336e9e14ef510719d87731fae582652d	::ffff:127.0.0.1	curl/7.81.0	2026-07-29 21:58:09+00	f	2026-07-29 13:58:09.670373+00
9	1	be612105348ac3d8d4367706bea3a9cfc77c35ab599ebdd22b54e380e3666103	::1	Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36; Devin/1.0; +devin.ai	2026-07-29 22:12:59+00	f	2026-07-29 14:12:59.061617+00
10	1	15e67a3b9928e279e54291e5d8ad5cc6cd7a0d364a9e84e87f8fba4233fb39bd	::ffff:127.0.0.1	curl/7.81.0	2026-07-30 05:21:27+00	f	2026-07-29 21:21:27.872418+00
11	1	69359ffac139c0bd18317fdcf8817ba975118f7d09c966257126992d55caaa72	::ffff:127.0.0.1	curl/7.81.0	2026-07-30 10:23:16+00	f	2026-07-30 02:23:16.704642+00
\.


--
-- Data for Name: auth_users; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.auth_users (id, username, password_hash, display_name, email, role, is_active, failed_attempts, locked_until, last_login, last_password_change, created_at, updated_at) FROM stdin;
1	admin	$2a$12$jyhjnQlYY8KzbT2zcHvyxuNqEBh.KWnTQbKWXrLo7z8g0/xK1Ob0a	Trust Administrator	\N	admin	t	0	\N	2026-07-30 02:23:16.70175+00	2026-07-29 02:26:48.875907+00	2026-07-29 02:26:48.875907+00	2026-07-29 02:26:48.875907+00
\.


--
-- Data for Name: bill_settlement_queue; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.bill_settlement_queue (id, settlement_id, deposit_ref, deposit_method, amount, status, bill_txn_id, bill_confirmed_at, expected_settle, actual_settle, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: bill_sync_log; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.bill_sync_log (id, sync_id, sync_type, status, bill_balance, gl_balance, balance_matched, deposits_synced, settlements_found, discrepancies, details, error_message, started_at, completed_at, triggered_by) FROM stdin;
\.


--
-- Data for Name: bond_balances; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.bond_balances (id, bond_id, principal_balance, accrued_interest, total_interest_paid, total_principal_paid, last_accrual_date, last_payment_date, updated_at) FROM stdin;
1	1	99999879.25	2427777.52	0.00	120.75	2026-08-02	2026-07-29	2026-08-02 14:29:50.08366+00
\.


--
-- Data for Name: bond_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.bond_transactions (id, bond_id, transaction_type, amount, running_balance, accrued_interest, description, fineract_txn_id, transaction_date, created_at) FROM stdin;
1	1	issuance	100000000.00	100000000.00	0.00	DLB-PRB Private Placement Bond — Initial Issuance $100M face value @ 1% coupon, 100-year term	\N	2024-02-28	2026-07-29 13:52:14.609177+00
2	1	principal_payment	10.25	99999989.75	0.00	Principal payment of $10.25	\N	2026-07-29	2026-07-29 13:52:51.785045+00
3	1	interest_accrual	2419444.20	99999989.75	2419444.20	Interest accrual: 871 days @ 1.0000% annual (30/360)	\N	2026-07-29	2026-07-29 13:58:01.85716+00
4	1	principal_payment	100.25	99999889.50	2419444.20	Principal payment of $100.25	\N	2026-07-29	2026-07-29 14:01:25.856448+00
5	1	principal_payment	10.25	99999879.25	2419444.20	Principal payment of $10.25	\N	2026-07-29	2026-07-29 14:05:39.724562+00
6	1	interest_accrual	2777.77	99999879.25	2422221.97	Interest accrual: 1 days @ 1.0000% annual (30/360)	\N	2026-07-30	2026-07-30 02:23:05.547236+00
7	1	interest_accrual	5555.55	99999879.25	2427777.52	Interest accrual: 2 days @ 1.0000% annual (30/360)	\N	2026-08-02	2026-08-02 14:29:50.08366+00
\.


--
-- Data for Name: bond_trustees; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.bond_trustees (id, bond_id, trustee_id, trustee_name, trustee_role, effective_date, end_date, notes, created_at) FROM stdin;
\.


--
-- Data for Name: bonds; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.bonds (id, bond_name, isin, face_value, coupon_rate, issue_date, maturity_date, payment_freq, day_count, currency, status, created_at, updated_at, bond_identifier, bond_type, tax_exempt, tax_exempt_type, placement_type, issuer, issuer_state) FROM stdin;
1	DLB-PRB	US-DLB-PRB-2024	100000000.00	0.010000	2024-02-28	2124-02-28	monthly	30/360	USD	active	2026-07-29 13:52:14.60812+00	2026-07-29 13:52:14.60812+00	19781443-DLB-PRB	municipal	t	interest	private	DeAndrea Lavar Barkley Trust	CA
\.


--
-- Data for Name: bookkeeping_adjustments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.bookkeeping_adjustments (id, adjustment_id, adjustment_type, original_entry_id, correcting_entry_id, amount, reason, approved_by, approved_at, status, created_by, created_at) FROM stdin;
\.


--
-- Data for Name: bookkeeping_reconciliations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.bookkeeping_reconciliations (id, recon_id, recon_type, recon_date, items_matched, items_unmatched, total_matched, total_unmatched, details, status, created_at) FROM stdin;
\.


--
-- Data for Name: bookkeeping_tasks; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.bookkeeping_tasks (id, task_id, task_type, category, title, description, status, priority, scheduled_date, completed_date, result, created_by, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: calendar_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.calendar_events (id, title, description, start_time, end_time, all_day, event_type, related_module, reference_id, attendees, created_by, metadata, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: cash_accounts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cash_accounts (id, account_id, account_name, account_type, linked_fineract_account_id, balance_cents, currency, status, notes, created_at, updated_at) FROM stdin;
2	CA-OPERATING	Trust Operating Account	operating	\N	0	USD	active	Day-to-day trust operations	2026-07-29 13:52:14.61016+00	2026-07-29 13:52:14.61016+00
3	CA-RESERVE	Trust Reserve Account	reserve	\N	0	USD	active	Liquidity reserve	2026-07-29 13:52:14.61016+00	2026-07-29 13:52:14.61016+00
4	CA-DISTRIBUTION	Beneficiary Distribution Account	distribution	\N	0	USD	active	Staging account for beneficiary distributions	2026-07-29 13:52:14.61016+00	2026-07-29 13:52:14.61016+00
5	CA-ESCROW	Trustee Escrow Account	escrow	\N	0	USD	active	Trustee-controlled escrow	2026-07-29 13:52:14.61016+00	2026-07-29 13:52:14.61016+00
6	CA-FEE	Management Fee Account	fee	\N	0	USD	active	Trust management fees	2026-07-29 13:52:14.61016+00	2026-07-29 13:52:14.61016+00
1	CA-BOND-PROCEEDS	DLB-PRB Bond Proceeds	bond_proceeds	\N	9999997700	USD	active	Primary bond proceeds account — $100M face value	2026-07-29 13:52:14.61016+00	2026-07-30 02:25:48.381575+00
7	STABLECOIN_CASH_HOLD	Stablecoin Cash Holding	reserve	\N	2300	USD	active	\N	2026-07-29 13:52:26.768946+00	2026-07-30 02:25:48.381575+00
\.


--
-- Data for Name: cash_movements; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cash_movements (id, movement_id, from_account_id, to_account_id, amount_cents, movement_type, reference_id, reference_type, gl_journal_id, status, memo, initiated_by, created_at, settled_at) FROM stdin;
2	MOV-1785333167406-U4USNU	CA-BOND-PROCEEDS	STABLECOIN_CASH_HOLD	1025	sweep	SCP-1785333167401-BHDGL6	stablecoin_payment	\N	settled	Stablecoin funding SCP-1785333167401-BHDGL6	\N	2026-07-29 13:52:47.404942+00	2026-07-29 13:52:47.404942+00
3	MOV-1785333939709-CBLV5N	CA-BOND-PROCEEDS	STABLECOIN_CASH_HOLD	1025	sweep	SCP-1785333939705-K0FAQS	stablecoin_payment	\N	settled	Stablecoin funding SCP-1785333939705-K0FAQS	\N	2026-07-29 14:05:39.708789+00	2026-07-29 14:05:39.708789+00
4	MOV-1785334477200-PYCRNA	CA-BOND-PROCEEDS	STABLECOIN_CASH_HOLD	125	sweep	SCP-1785334461287-NGGVBX	stablecoin_payment	\N	settled	Stablecoin funding SCP-1785334461287-NGGVBX	\N	2026-07-29 14:14:37.199225+00	2026-07-29 14:14:37.199225+00
5	MOV-1785378348382-ODJG0C	CA-BOND-PROCEEDS	STABLECOIN_CASH_HOLD	125	sweep	SCP-1785378341849-2VXE8N	stablecoin_payment	\N	settled	Stablecoin funding SCP-1785378341849-2VXE8N	\N	2026-07-30 02:25:48.381575+00	2026-07-30 02:25:48.381575+00
\.


--
-- Data for Name: client_sub_ledgers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.client_sub_ledgers (id, sub_ledger_id, contact_id, parent_account_code, sub_account_name, sub_account_type, balance, currency, status, fineract_savings_id, notes, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: coinbase_hbar_orders; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.coinbase_hbar_orders (id, status, direction, fiat_amount, fiat_currency, hbar_amount, target_address, source_type, source_account_id, reserve_id, order_id, withdrawal_id, tx_hash, tx_explorer, error, metadata, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: coupon_payments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.coupon_payments (id, coupon_payment_id, bond_id, coupon_date, amount, status, ach_batch_id, bondholders_paid, bondholders_skipped, journal_entry_id, error_message, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: crm_bond_subscriptions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.crm_bond_subscriptions (id, subscription_id, contact_id, bond_id, subscription_amount, offering_price, settlement_date, status, cash_account_id, notes, created_at, updated_at) FROM stdin;
1	SUB-DLB-PRB-001	CRM-INV-001	1	100000000.00	1.000000	2024-02-28	active	\N	\N	2026-07-29 13:57:58.856779+00	2026-07-29 13:57:58.856779+00
\.


--
-- Data for Name: crm_contacts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.crm_contacts (id, contact_id, contact_type, first_name, last_name, company, email, phone, mailing_address, date_of_birth, ssn_last4, kyc_status, kyc_verified_at, aml_status, fineract_client_id, linked_wallet_id, preferred_payment, routing_number, account_number, bank_account_type, bank_name, status, notes, tags, created_at, updated_at, approval_status, approved_by, approved_at, rejected_by, rejection_reason) FROM stdin;
1	CRM-INV-001	investor	DeAndrea	Barkley	DLB Trust	deandreabarkley13@gmail.com	\N	\N	\N	\N	verified	\N	clear	\N	\N	ach	021000021	123456789	checking	JPMorgan Chase	active	Primary bondholder — 100% allocation of DLB-PRB	\N	2026-07-29 13:57:58.856094+00	2026-07-29 13:57:58.856094+00	pending_approval	\N	\N	\N	\N
\.


--
-- Data for Name: crm_interactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.crm_interactions (id, interaction_id, contact_id, interaction_type, subject, body, direction, outcome, follow_up_date, created_by, created_at) FROM stdin;
\.


--
-- Data for Name: dapp_deposits; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.dapp_deposits (id, safe_id, asset, amount, from_address, tx_hash, status, metadata, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: dapp_distributions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.dapp_distributions (id, safe_id, name, asset, total_amount, beneficiaries, status, tx_hash, source_type, source_account_id, metadata, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: dapp_payouts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.dapp_payouts (id, safe_id, type, destination, value, token, token_amount, description, status, safe_tx_hash, server_signature, signatures, tx_hash, source_type, source_account_id, reserve_id, distribution_id, metadata, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: dapp_safes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.dapp_safes (id, label, safe_address, chain_id, owners, threshold, salt_nonce, deploy_tx_hash, status, metadata, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: dapp_users; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.dapp_users (id, email, phone, name, role, wallet_address, safe_owner_address, linked_wallet_provider, verified, otp_code, otp_expires, metadata, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: dapp_white_label; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.dapp_white_label (id, name, slug, primary_color, secondary_color, logo_url, favicon_url, contact_email, metadata, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: data_bridge_discrepancies; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.data_bridge_discrepancies (id, discrepancy_id, discrepancy_type, module_a, module_b, account_code, amount_a, amount_b, difference, severity, resolved, resolution, details, created_at, resolved_at) FROM stdin;
\.


--
-- Data for Name: data_bridge_sync_log; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.data_bridge_sync_log (id, sync_id, sync_type, source_module, target_module, items_synced, items_skipped, items_failed, details, status, created_at) FROM stdin;
1	SYNC-AGG-1785292039053-9S71	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[{"error": "relation \\"trust_journal_entries\\" does not exist", "phase": "query"}]	completed	2026-07-29 02:27:19.056638+00
2	PUSH-GL-1785292039057-3M89	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"trust_journal_entries\\" does not exist", "phase": "query"}]	completed	2026-07-29 02:27:19.060287+00
3	SYNC-AGG-1785292104833-1D12	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[{"error": "relation \\"trust_journal_entries\\" does not exist", "phase": "query"}]	completed	2026-07-29 02:28:24.837122+00
4	PUSH-GL-1785292104838-G8AI	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"trust_journal_entries\\" does not exist", "phase": "query"}]	completed	2026-07-29 02:28:24.841309+00
5	SYNC-AGG-1785292176850-HW67	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[{"error": "relation \\"trust_journal_entries\\" does not exist", "phase": "query"}]	completed	2026-07-29 02:29:36.853281+00
6	PUSH-GL-1785292176854-4UG1	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"trust_journal_entries\\" does not exist", "phase": "query"}]	completed	2026-07-29 02:29:36.857047+00
7	SYNC-AGG-1785292379978-LO2K	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[{"error": "relation \\"trust_journal_entries\\" does not exist", "phase": "query"}]	completed	2026-07-29 02:32:59.982527+00
8	PUSH-GL-1785292379984-O6OO	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"trust_journal_entries\\" does not exist", "phase": "query"}]	completed	2026-07-29 02:32:59.986432+00
9	SYNC-AGG-1785292788777-15L4	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[{"error": "relation \\"trust_journal_entries\\" does not exist", "phase": "query"}]	completed	2026-07-29 02:39:48.781374+00
10	PUSH-GL-1785292788782-1NXN	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"trust_journal_entries\\" does not exist", "phase": "query"}]	completed	2026-07-29 02:39:48.784732+00
11	SYNC-AGG-1785292870680-2OTZ	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[{"error": "relation \\"trust_journal_entries\\" does not exist", "phase": "query"}]	completed	2026-07-29 02:41:10.683618+00
12	PUSH-GL-1785292870685-U7G0	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"trust_journal_entries\\" does not exist", "phase": "query"}]	completed	2026-07-29 02:41:10.687489+00
13	SYNC-AGG-1785293740680-3VFJ	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[{"error": "relation \\"trust_journal_entries\\" does not exist", "phase": "query"}]	completed	2026-07-29 02:55:40.683641+00
14	PUSH-GL-1785293740686-ZUZM	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"trust_journal_entries\\" does not exist", "phase": "query"}]	completed	2026-07-29 02:55:40.689152+00
15	SYNC-AGG-1785294640680-UF7O	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[{"error": "relation \\"trust_journal_entries\\" does not exist", "phase": "query"}]	completed	2026-07-29 03:10:40.683849+00
16	PUSH-GL-1785294640686-LEUB	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"trust_journal_entries\\" does not exist", "phase": "query"}]	completed	2026-07-29 03:10:40.689334+00
17	SYNC-AGG-1785333508866-WI38	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-29 13:58:28.868458+00
18	PUSH-GL-1785333508869-HVCC	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-29 13:58:28.873841+00
19	SYNC-AGG-1785334316544-CSCT	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-29 14:11:56.546229+00
20	PUSH-GL-1785334316547-96KV	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-29 14:11:56.55163+00
21	SYNC-AGG-1785334378862-Z4LJ	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-29 14:12:58.863933+00
22	PUSH-GL-1785334378864-RE6C	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-29 14:12:58.868367+00
23	SYNC-AGG-1785335186545-61R9	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-29 14:26:26.5467+00
24	PUSH-GL-1785335186549-G8YJ	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-29 14:26:26.554596+00
25	SYNC-AGG-1785335278863-CICF	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-29 14:27:58.865294+00
26	PUSH-GL-1785335278868-FTE6	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-29 14:27:58.871739+00
27	SYNC-AGG-1785336086546-68OO	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-29 14:41:26.547704+00
28	PUSH-GL-1785336086553-57UH	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-29 14:41:26.557197+00
29	SYNC-AGG-1785336178863-S83B	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-29 14:42:58.865146+00
30	PUSH-GL-1785336178867-L7D3	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-29 14:42:58.87141+00
31	SYNC-AGG-1785360100932-9NL8	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-29 21:21:40.934086+00
32	PUSH-GL-1785360100934-CRB4	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-29 21:21:40.941204+00
33	SYNC-AGG-1785360970928-JVA8	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-29 21:36:10.929896+00
34	PUSH-GL-1785360970932-0RIC	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-29 21:36:10.936497+00
35	SYNC-AGG-1785361870928-XRFT	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-29 21:51:10.929906+00
36	PUSH-GL-1785361870932-7BRI	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-29 21:51:10.936276+00
37	SYNC-AGG-1785362770933-PGEM	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-29 22:06:10.934529+00
38	PUSH-GL-1785362770937-EZDI	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-29 22:06:10.940745+00
39	SYNC-AGG-1785363670936-8U6R	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-29 22:21:10.938109+00
40	PUSH-GL-1785363670940-3O8H	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-29 22:21:10.944756+00
41	SYNC-AGG-1785364570939-1JKK	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-29 22:36:10.941128+00
42	PUSH-GL-1785364570943-XGZ6	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-29 22:36:10.94776+00
43	SYNC-AGG-1785365470942-AQ0E	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-29 22:51:10.944133+00
44	PUSH-GL-1785365470946-CDLC	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-29 22:51:10.950439+00
45	SYNC-AGG-1785366370943-ISNJ	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-29 23:06:10.945344+00
46	PUSH-GL-1785366370948-PMA2	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-29 23:06:10.952419+00
47	SYNC-AGG-1785367270947-AZFS	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-29 23:21:10.9484+00
48	PUSH-GL-1785367270951-RE8X	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-29 23:21:10.95591+00
49	SYNC-AGG-1785368170948-QPU2	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-29 23:36:10.950374+00
50	PUSH-GL-1785368170953-5Y3Y	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-29 23:36:10.957422+00
51	SYNC-AGG-1785369070951-M10K	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-29 23:51:10.952745+00
52	PUSH-GL-1785369070955-H5US	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-29 23:51:10.960125+00
53	SYNC-AGG-1785378212557-EJ7T	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 02:23:32.560029+00
54	PUSH-GL-1785378212565-TKXG	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 02:23:32.571851+00
55	SYNC-AGG-1785379082552-PPYP	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 02:38:02.553459+00
56	PUSH-GL-1785379082556-VAAT	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 02:38:02.560101+00
57	SYNC-AGG-1785379982553-GH9J	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 02:53:02.554949+00
58	PUSH-GL-1785379982557-V2BG	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 02:53:02.561305+00
59	SYNC-AGG-1785380882555-8S0O	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 03:08:02.55636+00
60	PUSH-GL-1785380882559-1U4F	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 03:08:02.562733+00
61	SYNC-AGG-1785381782556-OC8N	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 03:23:02.557373+00
62	PUSH-GL-1785381782560-397W	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 03:23:02.564861+00
63	SYNC-AGG-1785382682557-SYW1	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 03:38:02.558842+00
64	PUSH-GL-1785382682561-RJYC	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 03:38:02.564626+00
65	SYNC-AGG-1785383582557-9NZX	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 03:53:02.558389+00
66	PUSH-GL-1785383582561-9GNU	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 03:53:02.565138+00
67	SYNC-AGG-1785384482558-TIV6	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 04:08:02.560114+00
68	PUSH-GL-1785384482565-03OA	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 04:08:02.569829+00
69	SYNC-AGG-1785425239823-K84B	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 15:27:19.82524+00
70	PUSH-GL-1785425239832-FCSG	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 15:27:19.838915+00
71	SYNC-AGG-1785426109820-XRCS	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 15:41:49.822081+00
72	PUSH-GL-1785426109825-YIG7	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 15:41:49.82897+00
73	SYNC-AGG-1785427009821-Y8YE	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 15:56:49.82294+00
74	PUSH-GL-1785427009825-MMWY	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 15:56:49.829726+00
75	SYNC-AGG-1785427909823-OWGG	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 16:11:49.82494+00
76	PUSH-GL-1785427909827-ZKXP	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 16:11:49.831397+00
77	SYNC-AGG-1785428277309-37QT	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 16:17:57.311309+00
78	PUSH-GL-1785428277312-YMIB	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 16:17:57.317009+00
79	SYNC-AGG-1785428342053-7DP0	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 16:19:02.055157+00
80	PUSH-GL-1785428342056-PGBT	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 16:19:02.060093+00
81	SYNC-AGG-1785429212050-RCWU	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 16:33:32.0513+00
82	PUSH-GL-1785429212055-Y43A	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 16:33:32.059429+00
83	SYNC-AGG-1785430112050-8BHO	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 16:48:32.052059+00
84	PUSH-GL-1785430112054-W2IH	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 16:48:32.059204+00
85	SYNC-AGG-1785431012054-OIE6	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 17:03:32.055735+00
86	PUSH-GL-1785431012061-O0D0	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 17:03:32.065958+00
87	SYNC-AGG-1785431912058-1BYD	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 17:18:32.059361+00
88	PUSH-GL-1785431912062-I313	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 17:18:32.066864+00
89	SYNC-AGG-1785432812061-XJ5V	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 17:33:32.06272+00
90	PUSH-GL-1785432812065-G4F3	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 17:33:32.069585+00
91	SYNC-AGG-1785433712065-C084	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 17:48:32.06728+00
92	PUSH-GL-1785433712070-UBAE	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 17:48:32.074885+00
93	SYNC-AGG-1785434612065-QD0B	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 18:03:32.067001+00
94	PUSH-GL-1785434612069-AV6G	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 18:03:32.074634+00
95	SYNC-AGG-1785435512068-JPHV	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 18:18:32.069748+00
96	PUSH-GL-1785435512073-85OL	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 18:18:32.078044+00
97	SYNC-AGG-1785436412071-BPXD	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 18:33:32.073339+00
98	PUSH-GL-1785436412076-ZABX	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 18:33:32.080675+00
99	SYNC-AGG-1785437312075-N4VU	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 18:48:32.077045+00
100	PUSH-GL-1785437312079-8GQW	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 18:48:32.084181+00
101	SYNC-AGG-1785438212079-04QX	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 19:03:32.080623+00
102	PUSH-GL-1785438212083-APCD	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 19:03:32.088001+00
103	SYNC-AGG-1785439112080-Z61F	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 19:18:32.082089+00
104	PUSH-GL-1785439112084-DBH7	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 19:18:32.088842+00
105	SYNC-AGG-1785440012083-352P	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 19:33:32.085377+00
106	PUSH-GL-1785440012087-3ZU6	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 19:33:32.091898+00
107	SYNC-AGG-1785440912087-X56X	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 19:48:32.088391+00
108	PUSH-GL-1785440912091-3VLE	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 19:48:32.095782+00
109	SYNC-AGG-1785441812092-W4H5	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 20:03:32.093795+00
110	PUSH-GL-1785441812096-5AD9	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 20:03:32.100275+00
111	SYNC-AGG-1785442712095-VHN6	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-07-30 20:18:32.09724+00
112	PUSH-GL-1785442712099-HIB6	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-07-30 20:18:32.103619+00
113	SYNC-AGG-1785681017095-B6CV	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-08-02 14:30:17.098101+00
114	PUSH-GL-1785681017105-RR19	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-08-02 14:30:17.111568+00
115	SYNC-AGG-1785681131057-7J9F	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-08-02 14:32:11.059369+00
116	PUSH-GL-1785681131060-8UK6	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-08-02 14:32:11.064814+00
117	SYNC-AGG-1785681193194-KIIC	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-08-02 14:33:13.195948+00
118	PUSH-GL-1785681193196-23IX	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-08-02 14:33:13.200345+00
119	SYNC-AGG-1785681269176-CEUQ	aggregator_to_accounting	aggregator	trust_accounting	0	0	0	[]	completed	2026-08-02 14:34:29.178003+00
120	PUSH-GL-1785681269178-C22C	push_to_fineract	trust_accounting	fineract_gl	0	0	0	[{"error": "relation \\"fineract_gl_mappings\\" does not exist", "phase": "query"}]	completed	2026-08-02 14:34:29.182601+00
\.


--
-- Data for Name: document_templates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.document_templates (id, template_id, template_name, template_type, category, description, body_template, header_template, footer_template, variables, metadata, version, is_active, is_default, created_by, updated_by, created_at, updated_at) FROM stdin;
1	TPL-TRUST-AGREE	Trust Agreement	trust_agreement	legal	Standard trust agreement template for DLB Trust	<h1>TRUST AGREEMENT</h1><p>This Trust Agreement is entered into as of {{effectiveDate}} by and between {{trustorName}} ("Trustor") and {{trusteeName}} ("Trustee") for the benefit of {{beneficiaryName}} ("Beneficiary").</p><h2>Article I — Trust Property</h2><p>The Trustor hereby transfers and assigns to the Trustee the following property: {{trustProperty}}</p><h2>Article II — Trust Purpose</h2><p>{{trustPurpose}}</p><h2>Article III — Terms</h2><p>Trust established under the laws of {{jurisdiction}}. Face value: ${{faceValue}}. Coupon rate: {{couponRate}}%.</p><p>This agreement is effective as of {{effectiveDate}}.</p>	\N	\N	["effectiveDate", "trustorName", "trusteeName", "beneficiaryName", "trustProperty", "trustPurpose", "jurisdiction", "faceValue", "couponRate"]	{}	1	t	t	\N	\N	2026-07-29 13:53:01.555784+00	2026-07-29 13:53:01.555784+00
2	TPL-BOND-INDENT	Bond Indenture	bond_indenture	legal	Bond indenture template for private placement bonds	<h1>BOND INDENTURE</h1><p>Bond: {{bondName}} (ISIN: {{isin}})</p><p>Face Value: ${{faceValue}} | Coupon Rate: {{couponRate}}% | Maturity: {{maturityDate}}</p><h2>Terms and Conditions</h2><p>This indenture is between {{issuerName}} and {{trusteeName}}, dated {{issueDate}}.</p><p>Payment Frequency: {{paymentFreq}} | Day Count: {{dayCount}}</p><h2>Covenants</h2><p>{{covenants}}</p>	\N	\N	["bondName", "isin", "faceValue", "couponRate", "maturityDate", "issuerName", "trusteeName", "issueDate", "paymentFreq", "dayCount", "covenants"]	{}	1	t	t	\N	\N	2026-07-29 13:53:01.555784+00	2026-07-29 13:53:01.555784+00
3	TPL-SUB-AGREE	Subscription Agreement	subscription_agreement	investor	Investor subscription agreement for bond purchases	<h1>SUBSCRIPTION AGREEMENT</h1><p>Investor: {{investorName}} ({{investorEmail}})</p><p>Bond: {{bondName}} | Subscription Amount: ${{subscriptionAmount}}</p><p>Settlement Date: {{settlementDate}} | Offering Price: {{offeringPrice}}</p><h2>Representations</h2><p>The undersigned investor represents that they are an accredited investor as defined under Regulation D of the Securities Act of 1933.</p>	\N	\N	["investorName", "investorEmail", "bondName", "subscriptionAmount", "settlementDate", "offeringPrice"]	{}	1	t	t	\N	\N	2026-07-29 13:53:01.555784+00	2026-07-29 13:53:01.555784+00
4	TPL-DIST-NOTICE	Distribution Notice	distribution_notice	financial	Beneficiary distribution notice template	<h1>DISTRIBUTION NOTICE</h1><p>Date: {{distributionDate}}</p><p>To: {{recipientName}}</p><p>Re: Distribution from {{trustName}}</p><p>Amount: ${{amount}} | Payment Method: {{paymentMethod}}</p><p>Period: {{periodStart}} to {{periodEnd}}</p><p>Description: {{description}}</p>	\N	\N	["distributionDate", "recipientName", "trustName", "amount", "paymentMethod", "periodStart", "periodEnd", "description"]	{}	1	t	t	\N	\N	2026-07-29 13:53:01.555784+00	2026-07-29 13:53:01.555784+00
5	TPL-INV-STMT	Investor Statement	investor_statement	investor	Periodic investor account statement	<h1>INVESTOR STATEMENT</h1><p>Statement Period: {{periodStart}} — {{periodEnd}}</p><p>Investor: {{investorName}} | Account: {{accountId}}</p><h2>Holdings</h2><p>Bond: {{bondName}} | Face Value: ${{faceValue}} | Market Value: ${{marketValue}}</p><h2>Income</h2><p>Interest Earned: ${{interestEarned}} | Distributions Paid: ${{distributionsPaid}}</p><h2>Summary</h2><p>Beginning Balance: ${{beginBalance}} | Ending Balance: ${{endBalance}}</p>	\N	\N	["periodStart", "periodEnd", "investorName", "accountId", "bondName", "faceValue", "marketValue", "interestEarned", "distributionsPaid", "beginBalance", "endBalance"]	{}	1	t	t	\N	\N	2026-07-29 13:53:01.555784+00	2026-07-29 13:53:01.555784+00
6	TPL-PAY-CONF	Payment Confirmation	payment_confirmation	financial	Payment confirmation receipt	<h1>PAYMENT CONFIRMATION</h1><p>Confirmation #: {{confirmationNumber}}</p><p>Date: {{paymentDate}} | Amount: ${{amount}}</p><p>From: {{fromAccount}} | To: {{toAccount}}</p><p>Payment Type: {{paymentType}} | Reference: {{referenceId}}</p><p>Memo: {{memo}}</p>	\N	\N	["confirmationNumber", "paymentDate", "amount", "fromAccount", "toAccount", "paymentType", "referenceId", "memo"]	{}	1	t	t	\N	\N	2026-07-29 13:53:01.555784+00	2026-07-29 13:53:01.555784+00
\.


--
-- Data for Name: documents; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.documents (id, document_id, document_name, document_type, category, content, content_type, file_size_bytes, bond_id, contact_id, cash_account_id, reference_type, reference_id, tags, metadata, status, version, parent_document_id, created_by, updated_by, created_at, updated_at) FROM stdin;
11	DOC-1785425468152-28S1XB	Stablecoin Receipt SCP-1785425468144-VSWYJU	receipt	financial	{\n  "id": "SCP-1785425468144-VSWYJU",\n  "payment_hub_intent_id": null,\n  "status": "approved",\n  "amount_cents": "2500",\n  "fee_cents": "25",\n  "total_cents": "2525",\n  "asset_code": "USDC",\n  "network": "circle",\n  "destination_wallet": "0x080e0d0ae80c86cc80bb050dbe0d5e5bdb6cd225",\n  "wallet_provider": "circle",\n  "source_type": "treasury",\n  "source_account_id": "TREASURY_HOT",\n  "source_ref": {\n    "reserveId": "RES-1785425468146-uim5bd",\n    "sourceType": "treasury",\n    "sourceAccountId": "TREASURY_HOT"\n  },\n  "reserve_id": "RES-1785425468146-uim5bd",\n  "tx_hash": "circle-shadow-1785425468150-x2cwjk",\n  "tx_ledger": null,\n  "tx_explorer": null,\n  "latency_ms": null,\n  "memo": "Clearing & Settlement via dashboard",\n  "metadata": {\n    "beneficiaryName": "",\n    "clearingOrderId": "CSO-1785425468143-1H1DUP",\n    "fyStackWalletId": "",\n    "circleSourceAddress": ""\n  },\n  "created_at": "2026-07-30T15:31:08.144Z",\n  "updated_at": "2026-07-30T15:31:08.149Z"\n}	application/json	973	\N	\N	\N	stablecoin_payment	SCP-1785425468144-VSWYJU	\N	{}	active	1	\N	stablecoin-gateway	\N	2026-07-30 15:31:08.152908+00	2026-07-30 15:31:08.152908+00
12	DOC-1785425535432-XWIW36	Stablecoin Receipt SCP-1785425524748-RZJ97B	receipt	financial	{\n  "id": "SCP-1785425524748-RZJ97B",\n  "payment_hub_intent_id": null,\n  "status": "approved",\n  "amount_cents": "100",\n  "fee_cents": "25",\n  "total_cents": "125",\n  "asset_code": "USDC",\n  "network": "testnet",\n  "destination_wallet": "GCLZCZ55FIPFCLJM5W6JAUJE25OGBL5S5EIAE6MBIHWAVYRPQYGZEXXT",\n  "wallet_provider": "direct",\n  "source_type": "treasury",\n  "source_account_id": "TREASURY_HOT",\n  "source_ref": {\n    "reserveId": "RES-1785425524750-5ejkuj",\n    "sourceType": "treasury",\n    "sourceAccountId": "TREASURY_HOT"\n  },\n  "reserve_id": "RES-1785425524750-5ejkuj",\n  "tx_hash": "cf2ef2258c78c26473510eb3ea66f2ba1be4a0a31fd53009394424b248fa4997",\n  "tx_ledger": null,\n  "tx_explorer": null,\n  "latency_ms": null,\n  "memo": "Clearing & Settlement via dashboard",\n  "metadata": {\n    "beneficiaryName": "",\n    "clearingOrderId": "CSO-1785425524745-IQ2CZ6",\n    "fyStackWalletId": "",\n    "circleSourceAddress": ""\n  },\n  "created_at": "2026-07-30T15:32:04.749Z",\n  "updated_at": "2026-07-30T15:32:04.753Z"\n}	application/json	1016	\N	\N	\N	stablecoin_payment	SCP-1785425524748-RZJ97B	\N	{}	active	1	\N	stablecoin-gateway	\N	2026-07-30 15:32:15.432626+00	2026-07-30 15:32:15.432626+00
13	DOC-1785428339485-9GT6XR	Stablecoin Receipt SCP-1785428328065-AFRAOT	receipt	financial	{\n  "id": "SCP-1785428328065-AFRAOT",\n  "payment_hub_intent_id": null,\n  "status": "settled",\n  "amount_cents": "2500",\n  "fee_cents": "25",\n  "total_cents": "2525",\n  "asset_code": "DLBUSD",\n  "network": "hedera-testnet",\n  "destination_wallet": "0.0.101",\n  "wallet_provider": "direct",\n  "source_type": "treasury",\n  "source_account_id": "TREASURY_HOT",\n  "source_ref": {\n    "sourceType": "treasury",\n    "sourceAccountId": "TREASURY_HOT",\n    "reserveId": "RES-1785428339480-uq3yhx",\n    "post": {\n      "sourceType": "treasury",\n      "sourceAccountId": "TREASURY_HOT",\n      "posted": true\n    },\n    "fyStack": {\n      "simulated": true\n    }\n  },\n  "reserve_id": "RES-1785428339480-uq3yhx",\n  "tx_hash": "shadow-1785428339482",\n  "tx_ledger": "",\n  "tx_explorer": "",\n  "latency_ms": 0,\n  "memo": "Hedera shadow test",\n  "metadata": {\n    "beneficiaryName": "",\n    "fyStackWalletId": "",\n    "circleSourceAddress": "",\n    "hederaTokenId": "0.0.shadow-1785428321444"\n  },\n  "created_at": "2026-07-30T16:18:48.065Z",\n  "updated_at": "2026-07-30T16:18:59.483Z"\n}	application/json	1070	\N	\N	\N	stablecoin_payment	SCP-1785428328065-AFRAOT	\N	{}	active	1	\N	stablecoin-gateway	\N	2026-07-30 16:18:59.485443+00	2026-07-30 16:18:59.485443+00
\.


--
-- Data for Name: electronic_settlements; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.electronic_settlements (id, settlement_id, payment_ref, payment_type, payment_method, priority, payer_name, payer_account, payee_name, payee_account, payee_routing, payee_bank_name, sub_ledger_id, sub_ledger_txn_id, source_account_code, amount, currency, status, payment_file_hash, transmission_ref, processor_ref, settlement_ref, confirmation_code, integrity_hash, settlement_certificate, bill_ref, ach_batch_id, wire_id, journal_entry_id, tracking_id, retry_count, last_error, submitted_at, transmitted_at, accepted_at, clearing_at, settled_at, confirmed_at, finalized_at, sla_deadline, initiated_by, description, memo, vendor_id, data_bridge_synced, created_at, updated_at, payment_intent_id, payment_hub_txn_id, payment_hub_status, accounting_status, accounting_error) FROM stdin;
\.


--
-- Data for Name: finops_tasks; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.finops_tasks (id, prompt, intent, status, required_roles, approvals, result, tx_hash, requested_by, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: generated_documents; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.generated_documents (id, generation_id, template_id, document_id, bond_id, contact_id, variables_used, rendered_content, content_type, status, generated_by, generated_at, expires_at) FROM stdin;
\.


--
-- Data for Name: message_threads; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.message_threads (id, subject, participants, reference_type, reference_id, created_by, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: messages; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.messages (id, thread_id, sender, body, attachments, read_by, created_at) FROM stdin;
\.


--
-- Data for Name: nifi_payment_files; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.nifi_payment_files (id, file_id, direction, file_format, file_name, file_content, file_size_bytes, file_hash, hmac_signature, status, settlement_ids, payment_count, total_amount, source_system, destination_system, nifi_flow_id, nifi_processor_id, delivery_endpoint, delivery_attempts, last_error, picked_up_at, delivered_at, acknowledged_at, expires_at, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: ofx_institutions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ofx_institutions (id, name, org, fid, base_url, ofx_version, username, password, bank_id, account_id, account_type, routing_number, status, mode, created_at, updated_at) FROM stdin;
1	OFX Test Bank	OFXTEST	99999	https://ofx.example.com/ofx	200	testuser	testpass	111000025	123456789	CHECKING	\N	active	simulate	2026-07-29 02:37:19.768459+00	2026-07-29 02:37:19.768459+00
2	Test Bank	DLB	1	\N	200	u	p	123	456	CHECKING	\N	active	simulate	2026-07-29 02:39:41.365204+00	2026-07-29 02:39:41.365204+00
\.


--
-- Data for Name: ofx_payments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ofx_payments (id, institution_id, payment_type, reference, amount_cents, currency, source_account_id, source_type, payee_name, payee_account, payee_bank_id, payee_routing, payee_address1, payee_address2, payee_city, payee_state, payee_postal, payee_country, due_date, memo, ofx_request, ofx_response, server_id, status, status_detail, submitted_at, completed_at, created_at, updated_at) FROM stdin;
1	1	wire	OFXPAY-1785292713008-S2QV11	100000	USD	TREASURY_HOT	treasury	Beneficiary LLC	987654321	021000021	\N	123 Main St	\N	New York	NY	10001	USA	2026-07-29	Trust distribution Q3	<?xml version="1.0" encoding="UTF-8"?>\n<?OFX OFXHEADER="200" VERSION="200" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="85bd38b5-2056-4fd4-bd5c-badda69811b3" ?>\n<OFX>\n  <SIGNONMSGSRQV1>\n    <SONRQ>\n      <DTCLIENT>20260729023843</DTCLIENT>\n      <USERID>testuser</USERID>\n      <USERPASS>testpass</USERPASS>\n      <LANGUAGE>ENG</LANGUAGE>\n      <FI>\n        <ORG>OFXTEST</ORG>\n        <FID>99999</FID>\n      </FI>\n      <APPID>QWIN</APPID>\n      <APPVER>2600</APPVER>\n    </SONRQ>\n  </SIGNONMSGSRQV1>\n  <WIREXFERMSGSRQV1>\n    <WIRETRNRQ>\n      <TRNUID>OFXPAY-1785292713008-S2QV11</TRNUID>\n      <WIRERQ>\n        <BANKACCTFROM>\n          <BANKID>111000025</BANKID>\n          <ACCTID>123456789</ACCTID>\n          <ACCTTYPE>CHECKING</ACCTTYPE>\n        </BANKACCTFROM>\n        <WIREBENEFICIARY>\n          <NAME>Beneficiary LLC</NAME>\n          <BANKACCTTO>\n            <BANKID>021000021</BANKID>\n            <ACCTID>987654321</ACCTID>\n            <ACCTTYPE>CHECKING</ACCTTYPE>\n          </BANKACCTTO>\n          <MEMO>Trust distribution Q3</MEMO>\n        </WIREBENEFICIARY>\n        <WIREDESTBANK>\n          <EXTBANKDESC>\n            <NAME>Beneficiary LLC Bank</NAME>\n            <BANKID>021000021</BANKID>\n            <ADDR1>123 Main St</ADDR1>\n            <CITY>New York</CITY>\n            <STATE>NY</STATE>\n            <POSTALCODE>10001</POSTALCODE>\n            <COUNTRY>USA</COUNTRY>\n          </EXTBANKDESC>\n        </WIREDESTBANK>\n        <TRNAMT>1000.00</TRNAMT>\n        <DTDUE>20260729</DTDUE>\n        <PAYINSTRUCT>Trust distribution Q3</PAYINSTRUCT>\n      </WIRERQ>\n    </WIRETRNRQ>\n  </WIREXFERMSGSRQV1>\n</OFX>\n\n	<OFX><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS></OFX>	SIM-F6F75281	accepted	Simulated acceptance; no network call made	2026-07-29 02:38:43.701+00	2026-07-29 02:38:43.701+00	2026-07-29 02:38:33.008646+00	2026-07-29 02:38:43.701886+00
2	2	wire	OFXPAY-1785292793312-KZ71LW	9900	USD	\N	\N	X	1	2	\N	\N	\N	\N	\N	\N	USA	\N	\N	<?xml version="1.0" encoding="UTF-8"?>\n<?OFX OFXHEADER="200" VERSION="200" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="41a1cefa-faee-4fcb-a9f9-b571b8ae92fc" ?>\n<OFX>\n  <SIGNONMSGSRQV1>\n    <SONRQ>\n      <DTCLIENT>20260729023959</DTCLIENT>\n      <USERID>u</USERID>\n      <USERPASS>p</USERPASS>\n      <LANGUAGE>ENG</LANGUAGE>\n      <FI>\n        <ORG>DLB</ORG>\n        <FID>1</FID>\n      </FI>\n      <APPID>QWIN</APPID>\n      <APPVER>2600</APPVER>\n    </SONRQ>\n  </SIGNONMSGSRQV1>\n  <WIREXFERMSGSRQV1>\n    <WIRETRNRQ>\n      <TRNUID>OFXPAY-1785292793312-KZ71LW</TRNUID>\n      <WIRERQ>\n        <BANKACCTFROM>\n          <BANKID>123</BANKID>\n          <ACCTID>456</ACCTID>\n          <ACCTTYPE>CHECKING</ACCTTYPE>\n        </BANKACCTFROM>\n        <WIREBENEFICIARY>\n          <NAME>X</NAME>\n          <BANKACCTTO>\n            <BANKID>2</BANKID>\n            <ACCTID>1</ACCTID>\n            <ACCTTYPE>CHECKING</ACCTTYPE>\n          </BANKACCTTO>\n          <MEMO>Trust distribution</MEMO>\n        </WIREBENEFICIARY>\n        <WIREDESTBANK>\n          <EXTBANKDESC>\n            <NAME>X Bank</NAME>\n            <BANKID>2</BANKID>\n            <ADDR1>N/A</ADDR1>\n            <CITY>N/A</CITY>\n            <STATE>NA</STATE>\n            <POSTALCODE>00000</POSTALCODE>\n            <COUNTRY>USA</COUNTRY>\n          </EXTBANKDESC>\n        </WIREDESTBANK>\n        <TRNAMT>99.00</TRNAMT>\n        <DTDUE>20260729</DTDUE>\n        <PAYINSTRUCT>Trust distribution</PAYINSTRUCT>\n      </WIRERQ>\n    </WIRETRNRQ>\n  </WIREXFERMSGSRQV1>\n</OFX>\n\n	<OFX><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS></OFX>	SIM-758ABE1E	accepted	Simulated acceptance; no network call made	2026-07-29 02:39:59.118+00	2026-07-29 02:39:59.118+00	2026-07-29 02:39:53.31261+00	2026-07-29 02:39:59.118746+00
\.


--
-- Data for Name: ofx_statements; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ofx_statements (id, institution_id, account_id, currency, start_date, end_date, ledger_balance_cents, ledger_balance_date, raw_content, parsed_at) FROM stdin;
1	\N	987654321	USD	2025-01-01	2025-01-31	211450	2025-01-31	<?xml version="1.0" encoding="UTF-8"?>\n<?OFX OFXHEADER="200" VERSION="200" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE" ?>\n<OFX>\n  <SIGNONMSGSRSV1>\n    <SONRS>\n      <STATUS>\n        <CODE>0</CODE>\n        <SEVERITY>INFO</SEVERITY>\n      </STATUS>\n      <DTSERVER>20250115120000</DTSERVER>\n      <LANGUAGE>ENG</LANGUAGE>\n      <FI>\n        <ORG>Test Bank</ORG>\n        <FID>12345</FID>\n      </FI>\n    </SONRS>\n  </SIGNONMSGSRSV1>\n  <BANKMSGSRSV1>\n    <STMTTRNRS>\n      <TRNUID>1001</TRNUID>\n      <STATUS>\n        <CODE>0</CODE>\n        <SEVERITY>INFO</SEVERITY>\n      </STATUS>\n      <STMTRS>\n        <CURDEF>USD</CURDEF>\n        <BANKACCTFROM>\n          <BANKID>123456789</BANKID>\n          <ACCTID>987654321</ACCTID>\n          <ACCTTYPE>CHECKING</ACCTTYPE>\n        </BANKACCTFROM>\n        <BANKTRANLIST>\n          <DTSTART>20250101</DTSTART>\n          <DTEND>20250131</DTEND>\n          <STMTTRN>\n            <TRNTYPE>DEBIT</TRNTYPE>\n            <DTPOSTED>20250115</DTPOSTED>\n            <TRNAMT>-50.00</TRNAMT>\n            <FITID>202501150001</FITID>\n            <NAME>AMAZON PURCHASE</NAME>\n            <MEMO>Order #12345</MEMO>\n          </STMTTRN>\n          <STMTTRN>\n            <TRNTYPE>CREDIT</TRNTYPE>\n            <DTPOSTED>20250116</DTPOSTED>\n            <TRNAMT>1500.00</TRNAMT>\n            <FITID>202501160001</FITID>\n            <NAME>PAYROLL DEPOSIT</NAME>\n            <MEMO>January salary</MEMO>\n          </STMTTRN>\n          <STMTTRN>\n            <TRNTYPE>CHECK</TRNTYPE>\n            <DTPOSTED>20250117</DTPOSTED>\n            <TRNAMT>-200.00</TRNAMT>\n            <FITID>202501170001</FITID>\n            <CHECKNUM>1001</CHECKNUM>\n            <NAME>RENT PAYMENT</NAME>\n            <MEMO>January rent</MEMO>\n          </STMTTRN>\n        </BANKTRANLIST>\n        <LEDGERBAL>\n          <BALAMT>2114.50</BALAMT>\n          <DTASOF>20250131</DTASOF>\n        </LEDGERBAL>\n      </STMTRS>\n    </STMTTRNRS>\n  </BANKMSGSRSV1>\n</OFX>	2026-07-29 02:41:42.108579+00
\.


--
-- Data for Name: ofx_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ofx_transactions (id, statement_id, fit_id, posted_at, type, amount_cents, name, memo, check_number, ref_num, reference, reconciled) FROM stdin;
1	1	202501150001	2025-01-15	DEBIT	-5000	AMAZON PURCHASE	Order #12345	\N	\N	202501150001	f
2	1	202501160001	2025-01-16	CREDIT	150000	PAYROLL DEPOSIT	January salary	\N	\N	202501160001	f
3	1	202501170001	2025-01-17	CHECK	-20000	RENT PAYMENT	January rent	1001	\N	202501170001	f
\.


--
-- Data for Name: payment_approvals; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.payment_approvals (id, approval_id, intent_id, approver_id, decision, reason, created_at) FROM stdin;
\.


--
-- Data for Name: payment_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.payment_events (id, event_id, intent_id, event_type, from_status, to_status, actor_id, external_event_id, payload, previous_hash, event_hash, created_at) FROM stdin;
\.


--
-- Data for Name: payment_funding_holds; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.payment_funding_holds (id, hold_id, intent_id, source_type, source_id, amount_cents, status, expires_at, captured_at, released_at, release_reason, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: payment_intents; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.payment_intents (id, intent_id, idempotency_key, request_hash, status, rail, payment_type, amount_cents, currency, source_type, source_account_code, source_sub_ledger_id, debit_account_code, beneficiary_name, beneficiary_routing_encrypted, beneficiary_routing_hash, beneficiary_routing_last4, beneficiary_account_encrypted, beneficiary_account_hash, beneficiary_account_last4, beneficiary_account_type, sec_code, effective_date, description, maker_id, approval_count, required_approvals, payment_hub_txn_id, ach_batch_id, remote_reference, hold_id, accounting_status, journal_entry_id, accounting_error, error_code, error_message, metadata, version, approved_at, queued_at, transmitted_at, accepted_at, settled_at, returned_at, failed_at, cancelled_at, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: payment_webhook_receipts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.payment_webhook_receipts (id, receipt_id, external_event_id, intent_id, event_type, payload_hash, processing_status, error_message, received_at, processed_at, updated_at) FROM stdin;
\.


--
-- Data for Name: security_audit_log; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.security_audit_log (id, event_type, user_id, username, ip_address, user_agent, details, severity, created_at) FROM stdin;
1	login_success	1	admin	::ffff:127.0.0.1	curl/7.81.0	\N	info	2026-07-29 02:27:11.596706+00
2	login_success	1	admin	::ffff:127.0.0.1	curl/7.81.0	\N	info	2026-07-29 02:28:25.853726+00
3	login_success	1	admin	::ffff:127.0.0.1	curl/7.81.0	\N	info	2026-07-29 02:29:30.406439+00
4	login_success	1	admin	::ffff:127.0.0.1	curl/7.81.0	\N	info	2026-07-29 02:33:06.844041+00
5	login_success	1	admin	::1	Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36; Devin/1.0; +devin.ai	\N	info	2026-07-29 02:35:48.626215+00
6	login_success	1	admin	::ffff:127.0.0.1	curl/7.81.0	\N	info	2026-07-29 02:39:41.356415+00
7	login_success	1	admin	::1	Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36; Devin/1.0; +devin.ai	\N	info	2026-07-29 02:41:07.195722+00
8	login_success	1	admin	::ffff:127.0.0.1	curl/7.81.0	\N	info	2026-07-29 13:58:09.676195+00
9	login_success	1	admin	::1	Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36; Devin/1.0; +devin.ai	\N	info	2026-07-29 14:12:59.063318+00
10	login_success	1	admin	::ffff:127.0.0.1	curl/7.81.0	\N	info	2026-07-29 21:21:27.878904+00
11	login_success	1	admin	::ffff:127.0.0.1	curl/7.81.0	\N	info	2026-07-30 02:23:16.709266+00
\.


--
-- Data for Name: sovereign_ramp_orders; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sovereign_ramp_orders (id, token_id, direction, source_type, source_account_id, amount_cents, target_address, fiat_destination, on_chain_tx, on_chain_status, status, metadata, source_ref, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: sovereign_token_holders; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sovereign_token_holders (id, token_id, address, balance_cents, metadata, created_at, updated_at) FROM stdin;
HOLD-SIT-MINT-1785681293397-NUR2L9	SIT-DEPLOY-1785681045440-K837H1	0x9b3601d3e395d2a40f910161669f87fe64195cf7	10	{"onChainTx": "shadow-tx-mint-1785681293404", "sourceRef": {"sourceType": "treasury", "treasuryDebit": true, "sourceAccountId": "TREASURY_HOT"}}	2026-08-02 14:34:53.404398+00	2026-08-02 14:34:53.404398+00
\.


--
-- Data for Name: sovereign_tokens; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sovereign_tokens (id, network, chain_id, token_address, forwarder_address, token_symbol, token_name, status, shadow, metadata, created_at, updated_at) FROM stdin;
SIT-DEPLOY-1785681045440-K837H1	mainnet	1	shadow-token-1785681045440	shadow-forwarder-1785681045440	SIT	Sovereign Trust Token	active	t	{"name": "Sovereign Trust Token", "symbol": "SIT"}	2026-08-02 14:30:45.440451+00	2026-08-02 14:30:45.440451+00
\.


--
-- Data for Name: stablecoin_clearing_orders; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stablecoin_clearing_orders (id, wallet_id, source_type, source_account_id, destination_wallet, amount_cents, fee_cents, total_cents, asset_code, network, wallet_provider, payment_id, status, tx_hash, tx_explorer, error_message, metadata, created_at, updated_at) FROM stdin;
CSO-1785425455157-QGTHDF	\N	treasury	TREASURY_HOT	0x080e0d0ae80c86cc80bb050dbe0d5e5bdb6cd225	2500	25	2525	USDC	circle	circle	SCP-1785425455159-PYMQJO	failed	\N	\N	Insufficient treasury available balance: 1074 < 2525	{}	2026-07-30 15:30:55.157565+00	2026-07-30 15:30:55.16476+00
CSO-1785425468143-1H1DUP	\N	treasury	TREASURY_HOT	0x080e0d0ae80c86cc80bb050dbe0d5e5bdb6cd225	2500	25	2525	USDC	circle	circle	SCP-1785425468144-VSWYJU	settled	circle-shadow-1785425468150-x2cwjk		\N	{"payment": {"id": "SCP-1785425468144-VSWYJU", "memo": "Clearing & Settlement via dashboard", "status": "pending", "network": "circle", "tx_hash": null, "metadata": {"beneficiaryName": "", "clearingOrderId": "CSO-1785425468143-1H1DUP", "fyStackWalletId": "", "circleSourceAddress": ""}, "fee_cents": 25, "asset_code": "USDC", "created_at": "2026-07-30T15:31:08.144Z", "reserve_id": null, "source_ref": {}, "updated_at": "2026-07-30T15:31:08.144Z", "source_type": "treasury", "total_cents": 2525, "amount_cents": 2500, "wallet_provider": "circle", "source_account_id": "TREASURY_HOT", "destination_wallet": "0x080e0d0ae80c86cc80bb050dbe0d5e5bdb6cd225", "payment_hub_intent_id": null}, "settled": {"id": "SCP-1785425468144-VSWYJU", "memo": "Clearing & Settlement via dashboard", "status": "settled", "network": "circle", "tx_hash": "circle-shadow-1785425468150-x2cwjk", "metadata": {"beneficiaryName": "", "clearingOrderId": "CSO-1785425468143-1H1DUP", "fyStackWalletId": "", "circleSourceAddress": ""}, "fee_cents": "25", "tx_ledger": "success", "asset_code": "USDC", "created_at": "2026-07-30T15:31:08.144Z", "latency_ms": 0, "reserve_id": "RES-1785425468146-uim5bd", "source_ref": {"post": {"posted": true, "sourceType": "treasury", "sourceAccountId": "TREASURY_HOT"}, "fyStack": {"simulated": true}, "reserveId": "RES-1785425468146-uim5bd", "sourceType": "treasury", "sourceAccountId": "TREASURY_HOT"}, "updated_at": "2026-07-30T15:31:08.154Z", "source_type": "treasury", "total_cents": "2525", "tx_explorer": "", "amount_cents": "2500", "wallet_provider": "circle", "source_account_id": "TREASURY_HOT", "destination_wallet": "0x080e0d0ae80c86cc80bb050dbe0d5e5bdb6cd225", "payment_hub_intent_id": null}}	2026-07-30 15:31:08.144147+00	2026-07-30 15:31:08.155577+00
CSO-1785425524745-IQ2CZ6	\N	treasury	TREASURY_HOT	GCLZCZ55FIPFCLJM5W6JAUJE25OGBL5S5EIAE6MBIHWAVYRPQYGZEXXT	100	25	125	USDC	testnet	direct	SCP-1785425524748-RZJ97B	settled	cf2ef2258c78c26473510eb3ea66f2ba1be4a0a31fd53009394424b248fa4997	https://stellar.expert/explorer/testnet/tx/cf2ef2258c78c26473510eb3ea66f2ba1be4a0a31fd53009394424b248fa4997	\N	{"payment": {"id": "SCP-1785425524748-RZJ97B", "memo": "Clearing & Settlement via dashboard", "status": "pending", "network": "testnet", "tx_hash": null, "metadata": {"beneficiaryName": "", "clearingOrderId": "CSO-1785425524745-IQ2CZ6", "fyStackWalletId": "", "circleSourceAddress": ""}, "fee_cents": 25, "asset_code": "USDC", "created_at": "2026-07-30T15:32:04.748Z", "reserve_id": null, "source_ref": {}, "updated_at": "2026-07-30T15:32:04.748Z", "source_type": "treasury", "total_cents": 125, "amount_cents": 100, "wallet_provider": "direct", "source_account_id": "TREASURY_HOT", "destination_wallet": "GCLZCZ55FIPFCLJM5W6JAUJE25OGBL5S5EIAE6MBIHWAVYRPQYGZEXXT", "payment_hub_intent_id": null}, "settled": {"id": "SCP-1785425524748-RZJ97B", "memo": "Clearing & Settlement via dashboard", "status": "settled", "network": "testnet", "tx_hash": "cf2ef2258c78c26473510eb3ea66f2ba1be4a0a31fd53009394424b248fa4997", "metadata": {"beneficiaryName": "", "clearingOrderId": "CSO-1785425524745-IQ2CZ6", "fyStackWalletId": "", "circleSourceAddress": ""}, "fee_cents": "25", "tx_ledger": "3881266", "asset_code": "USDC", "created_at": "2026-07-30T15:32:04.749Z", "latency_ms": 4997, "reserve_id": "RES-1785425524750-5ejkuj", "source_ref": {"post": {"posted": true, "sourceType": "treasury", "sourceAccountId": "TREASURY_HOT"}, "reserveId": "RES-1785425524750-5ejkuj", "sourceType": "treasury", "sourceAccountId": "TREASURY_HOT"}, "updated_at": "2026-07-30T15:32:15.433Z", "source_type": "treasury", "total_cents": "125", "tx_explorer": "https://stellar.expert/explorer/testnet/tx/cf2ef2258c78c26473510eb3ea66f2ba1be4a0a31fd53009394424b248fa4997", "amount_cents": "100", "wallet_provider": "direct", "source_account_id": "TREASURY_HOT", "destination_wallet": "GCLZCZ55FIPFCLJM5W6JAUJE25OGBL5S5EIAE6MBIHWAVYRPQYGZEXXT", "payment_hub_intent_id": null}}	2026-07-30 15:32:04.74788+00	2026-07-30 15:32:15.434235+00
\.


--
-- Data for Name: stablecoin_payments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stablecoin_payments (id, payment_hub_intent_id, status, amount_cents, fee_cents, total_cents, asset_code, network, destination_wallet, wallet_provider, source_type, source_account_id, source_ref, reserve_id, tx_hash, tx_ledger, tx_explorer, latency_ms, memo, metadata, created_at, updated_at) FROM stdin;
SCP-1785333146770-NBACQN	\N	pending	1000	25	1025	USDC	testnet	GAA...TEST	direct	cash	CA-BOND-PROCEEDS	{}	\N	\N	\N	\N	\N	sof-test	{"beneficiaryName": ""}	2026-07-29 13:52:26.770889+00	2026-07-29 13:52:26.770889+00
SCP-1785333162310-YV988C	\N	pending	1000	25	1025	USDC	testnet	GAA...TEST	direct	cash	CA-BOND-PROCEEDS	{}	\N	\N	\N	\N	\N	sof-test	{"beneficiaryName": ""}	2026-07-29 13:52:42.310885+00	2026-07-29 13:52:42.310885+00
SCP-1785333167401-BHDGL6	\N	settled	1000	25	1025	USDC	testnet	GAA...TEST	direct	cash	CA-BOND-PROCEEDS	{"post": {"posted": true, "movementId": "MOV-1785333167406-U4USNU", "sourceType": "cash", "sourceAccountId": "CA-BOND-PROCEEDS"}, "reserveId": "RES-1785333167408-2rg7a9", "movementId": "MOV-1785333167406-U4USNU", "sourceType": "cash", "holdingAccount": "STABLECOIN_CASH_HOLD", "sourceAccountId": "CA-BOND-PROCEEDS"}	RES-1785333167408-2rg7a9	shadow-1785333167412-sfjecj56i9	0	\N	\N	sof-test	{"beneficiaryName": ""}	2026-07-29 13:52:47.402542+00	2026-07-29 13:52:47.416554+00
SCP-1785333171781-6A249T	\N	settled	1000	25	1025	USDC	testnet	GAA...TEST	direct	bond	1	{"post": {"posted": true, "sourceType": "bond", "sourceAccountId": "1", "bondTransactionId": 2, "newPrincipalCents": 9999998975}, "reserveId": "RES-1785333171789-bnkskt", "sourceType": "bond", "sourceAccountId": "1", "bondTransactionId": 2, "newPrincipalCents": 9999998975}	RES-1785333171789-bnkskt	shadow-1785333171793-6j4ey4rd6pi	0	\N	\N	sof-bond-test	{"beneficiaryName": ""}	2026-07-29 13:52:51.78222+00	2026-07-29 13:52:51.799969+00
SCP-1785333204983-HD28TF	\N	settled	1000	25	1025	USDC	testnet	GAA...TEST	direct	trust	TRUST-SRC-TEST	{"post": {"posted": true, "sourceType": "trust", "journalEntryId": "JRN-1785333204986-WG8AMI", "sourceAccountId": "TRUST-SRC-TEST"}, "reserveId": "RES-1785333204993-8dr2eq", "sourceType": "trust", "assetAccount": "1210", "journalEntryId": "JRN-1785333204986-WG8AMI", "sourceAccountId": "TRUST-SRC-TEST"}	RES-1785333204993-8dr2eq	shadow-1785333204997-gal2d4fex8	0	\N	\N	sof-trust-test	{"beneficiaryName": ""}	2026-07-29 13:53:24.984178+00	2026-07-29 13:53:24.999599+00
SCP-1785333243173-8JKT40	\N	settled	1000	25	1025	USDC	testnet	GAA...TEST	direct	trust	TRUST-SRC-TEST2	{"post": {"posted": true, "sourceType": "trust", "journalEntryId": "JRN-1785333243176-8K8BLU", "sourceAccountId": "TRUST-SRC-TEST2"}, "reserveId": "RES-1785333243180-vt28cg", "sourceType": "trust", "assetAccount": "1210", "journalEntryId": "JRN-1785333243176-8K8BLU", "sourceAccountId": "TRUST-SRC-TEST2"}	RES-1785333243180-vt28cg	shadow-1785333243182-l9mel8aw2vb	0	\N	\N	sof-trust-test2	{"beneficiaryName": ""}	2026-07-29 13:54:03.174271+00	2026-07-29 13:54:03.185271+00
SCP-1785333675445-7PQW4L	\N	settled	10000	25	10025	USDC	testnet	GAA_TESTWALLET	direct	bond	1	{"post": {"posted": true, "sourceType": "bond", "sourceAccountId": "1", "bondTransactionId": 4, "newPrincipalCents": 9999988950}, "reserveId": "RES-1785333685858-9a4ytt", "sourceType": "bond", "sourceAccountId": "1", "bondTransactionId": 4, "newPrincipalCents": 9999988950}	RES-1785333685858-9a4ytt	shadow-1785333706537-xgalvdcrdh9	0	\N	\N	DLB Trust stablecoin payment SCP-1785333675445-7PQW4L	{"beneficiaryName": ""}	2026-07-29 14:01:15.446358+00	2026-07-29 14:01:46.545201+00
SCP-1785333939705-K0FAQS	\N	settled	1000	25	1025	USDC	testnet	GAA...TEST	direct	cash	CA-BOND-PROCEEDS	{"post": {"posted": true, "movementId": "MOV-1785333939709-CBLV5N", "sourceType": "cash", "sourceAccountId": "CA-BOND-PROCEEDS"}, "reserveId": "RES-1785333939712-rljjwv", "movementId": "MOV-1785333939709-CBLV5N", "sourceType": "cash", "holdingAccount": "STABLECOIN_CASH_HOLD", "sourceAccountId": "CA-BOND-PROCEEDS"}	RES-1785333939712-rljjwv	shadow-1785333939714-ugpiqz5xw6b	0	\N	\N	sof-fix-test	{"beneficiaryName": ""}	2026-07-29 14:05:39.706191+00	2026-07-29 14:05:39.719801+00
SCP-1785333939722-THDZMT	\N	settled	1000	25	1025	USDC	testnet	GAA...TEST	direct	bond	1	{"post": {"posted": true, "sourceType": "bond", "sourceAccountId": "1", "bondTransactionId": 5, "newPrincipalCents": 9999987925}, "reserveId": "RES-1785333939726-mzopdl", "sourceType": "bond", "sourceAccountId": "1", "bondTransactionId": 5, "newPrincipalCents": 9999987925}	RES-1785333939726-mzopdl	shadow-1785333939727-8jj3scr168v	0	\N	\N	sof-bond-fix	{"beneficiaryName": ""}	2026-07-29 14:05:39.723108+00	2026-07-29 14:05:39.731107+00
SCP-1785334461287-NGGVBX	\N	settled	100	25	125	USDC	testnet	GA24DTS3GEEZVGF25SUIAW6ADLSJF3Y5ABIIJG4UOIMKLKDC3RKZHNKU	direct	cash	CA-BOND-PROCEEDS	{"post": {"posted": true, "movementId": "MOV-1785334477200-PYCRNA", "sourceType": "cash", "sourceAccountId": "CA-BOND-PROCEEDS"}, "reserveId": "RES-1785334477203-nggubr", "movementId": "MOV-1785334477200-PYCRNA", "sourceType": "cash", "holdingAccount": "STABLECOIN_CASH_HOLD", "sourceAccountId": "CA-BOND-PROCEEDS"}	RES-1785334477203-nggubr	shadow-1785334520926-h48hg7oqeot	0	\N	\N	DLB Trust stablecoin payment SCP-1785334461287-NGGVBX	{"beneficiaryName": ""}	2026-07-29 14:14:21.288306+00	2026-07-29 14:15:20.931847+00
SCP-1785359745745-00NHS0	\N	settled	100	25	125	DLBUSD	hedera-testnet	0.0.123	direct	treasury	TREASURY_HOT	{"post": {"posted": true, "sourceType": "treasury", "sourceAccountId": "TREASURY_HOT"}, "reserveId": "RES-1785359745788-4t94ew", "sourceType": "treasury", "sourceAccountId": "TREASURY_HOT"}	RES-1785359745788-4t94ew	shadow-1785359745794	undefined	\N	\N	DLB Trust stablecoin payment SCP-1785359745745-00NHS0	{"hederaTokenId": "0.0.shadow", "beneficiaryName": ""}	2026-07-29 21:15:45.75709+00	2026-07-29 21:15:45.807939+00
SCP-1785360531590-OFEDD8	\N	pending	2550	25	2575	USDC	fystack	0xRecipient123	fystack	treasury	TREASURY_HOT	{}	\N	\N	\N	\N	\N	DLB Trust stablecoin payment SCP-1785360531590-OFEDD8	{"beneficiaryName": "", "fyStackWalletId": "wallet-1"}	2026-07-29 21:28:51.599802+00	2026-07-29 21:28:51.599802+00
SCP-1785360535954-YOMW8Z	\N	settled	1	25	26	USDC	fystack	0xRecipient123	fystack	treasury	TREASURY_HOT	{"post": {"posted": true, "sourceType": "treasury", "sourceAccountId": "TREASURY_HOT"}, "fyStack": {"simulated": true}, "reserveId": "RES-1785360535968-18v3xc", "sourceType": "treasury", "sourceAccountId": "TREASURY_HOT"}	RES-1785360535968-18v3xc	fys-shadow-1785360535970-3wxfz98qitc	COMPLETED	\N	\N	DLB Trust stablecoin payment SCP-1785360535954-YOMW8Z	{"beneficiaryName": "", "fyStackWalletId": "wallet-1"}	2026-07-29 21:28:55.963598+00	2026-07-29 21:28:55.97618+00
SCP-1785378341849-2VXE8N	\N	settled	100	25	125	USDC	circle	0x000000000000000000000000000000000000dEaD	direct	cash	CA-BOND-PROCEEDS	{"post": {"posted": true, "movementId": "MOV-1785378348382-ODJG0C", "sourceType": "cash", "sourceAccountId": "CA-BOND-PROCEEDS"}, "fyStack": {"simulated": true}, "reserveId": "RES-1785378348389-xdl5gl", "movementId": "MOV-1785378348382-ODJG0C", "sourceType": "cash", "holdingAccount": "STABLECOIN_CASH_HOLD", "sourceAccountId": "CA-BOND-PROCEEDS"}	RES-1785378348389-xdl5gl	circle-shadow-1785378362912-bljexy	success	\N	\N	DLB Trust stablecoin payment SCP-1785378341849-2VXE8N	{"beneficiaryName": "", "fyStackWalletId": "", "circleSourceAddress": ""}	2026-07-30 02:25:41.850025+00	2026-07-30 02:26:02.920943+00
SCP-1785378396329-WKGYH4	\N	settled	50	25	75	USDC	circle	0x1111111111111111111111111111111111111111	direct	treasury	TREASURY_HOT	{"post": {"posted": true, "sourceType": "treasury", "sourceAccountId": "TREASURY_HOT"}, "fyStack": {"simulated": true}, "reserveId": "RES-1785378406290-9t4ae3", "sourceType": "treasury", "sourceAccountId": "TREASURY_HOT"}	RES-1785378406290-9t4ae3	circle-shadow-1785378418322-v877de	success	\N	\N	DLB Trust stablecoin payment SCP-1785378396329-WKGYH4	{"beneficiaryName": "", "fyStackWalletId": "", "circleSourceAddress": ""}	2026-07-30 02:26:36.330122+00	2026-07-30 02:26:58.327692+00
SCP-1785425455159-PYMQJO	\N	pending	2500	25	2525	USDC	circle	0x080e0d0ae80c86cc80bb050dbe0d5e5bdb6cd225	circle	treasury	TREASURY_HOT	{}	\N	\N	\N	\N	\N	Clearing & Settlement via dashboard	{"beneficiaryName": "", "clearingOrderId": "CSO-1785425455157-QGTHDF", "fyStackWalletId": "", "circleSourceAddress": ""}	2026-07-30 15:30:55.160126+00	2026-07-30 15:30:55.160126+00
SCP-1785425468144-VSWYJU	\N	settled	2500	25	2525	USDC	circle	0x080e0d0ae80c86cc80bb050dbe0d5e5bdb6cd225	circle	treasury	TREASURY_HOT	{"post": {"posted": true, "sourceType": "treasury", "sourceAccountId": "TREASURY_HOT"}, "fyStack": {"simulated": true}, "reserveId": "RES-1785425468146-uim5bd", "sourceType": "treasury", "sourceAccountId": "TREASURY_HOT"}	RES-1785425468146-uim5bd	circle-shadow-1785425468150-x2cwjk	success	\N	\N	Clearing & Settlement via dashboard	{"beneficiaryName": "", "clearingOrderId": "CSO-1785425468143-1H1DUP", "fyStackWalletId": "", "circleSourceAddress": ""}	2026-07-30 15:31:08.144977+00	2026-07-30 15:31:08.155096+00
SCP-1785425524748-RZJ97B	\N	settled	100	25	125	USDC	testnet	GCLZCZ55FIPFCLJM5W6JAUJE25OGBL5S5EIAE6MBIHWAVYRPQYGZEXXT	direct	treasury	TREASURY_HOT	{"post": {"posted": true, "sourceType": "treasury", "sourceAccountId": "TREASURY_HOT"}, "reserveId": "RES-1785425524750-5ejkuj", "sourceType": "treasury", "sourceAccountId": "TREASURY_HOT"}	RES-1785425524750-5ejkuj	cf2ef2258c78c26473510eb3ea66f2ba1be4a0a31fd53009394424b248fa4997	3881266	https://stellar.expert/explorer/testnet/tx/cf2ef2258c78c26473510eb3ea66f2ba1be4a0a31fd53009394424b248fa4997	4997	Clearing & Settlement via dashboard	{"beneficiaryName": "", "clearingOrderId": "CSO-1785425524745-IQ2CZ6", "fyStackWalletId": "", "circleSourceAddress": ""}	2026-07-30 15:32:04.749107+00	2026-07-30 15:32:15.433512+00
SCP-1785428281753-KTKXZ5	\N	failed	2500	25	2525	DLBUSD	hedera-testnet	0.0.101	direct	treasury	TREASURY_HOT	{"reserveId": "RES-1785428289232-8y8xb8", "sourceType": "treasury", "sourceAccountId": "TREASURY_HOT"}	RES-1785428289232-8y8xb8	\N	\N	\N	\N	Hedera shadow test	{"error": "No Hedera stablecoin token ID configured or created", "beneficiaryName": "", "fyStackWalletId": "", "circleSourceAddress": ""}	2026-07-30 16:18:01.753971+00	2026-07-30 16:18:09.237516+00
SCP-1785428328065-AFRAOT	\N	settled	2500	25	2525	DLBUSD	hedera-testnet	0.0.101	direct	treasury	TREASURY_HOT	{"post": {"posted": true, "sourceType": "treasury", "sourceAccountId": "TREASURY_HOT"}, "fyStack": {"simulated": true}, "reserveId": "RES-1785428339480-uq3yhx", "sourceType": "treasury", "sourceAccountId": "TREASURY_HOT"}	RES-1785428339480-uq3yhx	shadow-1785428339482	\N	\N	\N	Hedera shadow test	{"hederaTokenId": "0.0.shadow-1785428321444", "beneficiaryName": "", "fyStackWalletId": "", "circleSourceAddress": ""}	2026-07-30 16:18:48.065611+00	2026-07-30 16:18:59.486266+00
\.


--
-- Data for Name: stablecoin_reserves; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stablecoin_reserves (reserve_id, payment_id, account_id, amount_cents, status, tx_hash, created_at, released_at) FROM stdin;
RES-1785333167408-2rg7a9	SCP-1785333167401-BHDGL6	TREASURY_HOT	1025	posted	shadow-1785333167412-sfjecj56i9	2026-07-29 13:52:47.409046+00	\N
RES-1785333171789-bnkskt	SCP-1785333171781-6A249T	TREASURY_HOT	1025	posted	shadow-1785333171793-6j4ey4rd6pi	2026-07-29 13:52:51.78984+00	\N
RES-1785333204993-8dr2eq	SCP-1785333204983-HD28TF	TREASURY_HOT	1025	posted	shadow-1785333204997-gal2d4fex8	2026-07-29 13:53:24.993912+00	\N
RES-1785333243180-vt28cg	SCP-1785333243173-8JKT40	TREASURY_HOT	1025	posted	shadow-1785333243182-l9mel8aw2vb	2026-07-29 13:54:03.180508+00	\N
RES-1785333685858-9a4ytt	SCP-1785333675445-7PQW4L	TREASURY_HOT	10025	posted	shadow-1785333706537-xgalvdcrdh9	2026-07-29 14:01:25.858949+00	\N
RES-1785333939712-rljjwv	SCP-1785333939705-K0FAQS	TREASURY_HOT	1025	posted	shadow-1785333939714-ugpiqz5xw6b	2026-07-29 14:05:39.712664+00	\N
RES-1785333939726-mzopdl	SCP-1785333939722-THDZMT	TREASURY_HOT	1025	posted	shadow-1785333939727-8jj3scr168v	2026-07-29 14:05:39.726671+00	\N
RES-1785334477203-nggubr	SCP-1785334461287-NGGVBX	TREASURY_HOT	125	posted	shadow-1785334520926-h48hg7oqeot	2026-07-29 14:14:37.203184+00	\N
RES-1785359745788-4t94ew	SCP-1785359745745-00NHS0	TREASURY_HOT	125	posted	shadow-1785359745794	2026-07-29 21:15:45.788401+00	\N
RES-1785360535968-18v3xc	SCP-1785360535954-YOMW8Z	TREASURY_HOT	26	posted	fys-shadow-1785360535970-3wxfz98qitc	2026-07-29 21:28:55.968585+00	\N
RES-1785378348389-xdl5gl	SCP-1785378341849-2VXE8N	TREASURY_HOT	125	posted	circle-shadow-1785378362912-bljexy	2026-07-30 02:25:48.38998+00	\N
RES-1785378406290-9t4ae3	SCP-1785378396329-WKGYH4	TREASURY_HOT	75	posted	circle-shadow-1785378418322-v877de	2026-07-30 02:26:46.29107+00	\N
RES-1785425468146-uim5bd	SCP-1785425468144-VSWYJU	TREASURY_HOT	2525	posted	circle-shadow-1785425468150-x2cwjk	2026-07-30 15:31:08.146118+00	\N
RES-1785425524750-5ejkuj	SCP-1785425524748-RZJ97B	TREASURY_HOT	125	posted	cf2ef2258c78c26473510eb3ea66f2ba1be4a0a31fd53009394424b248fa4997	2026-07-30 15:32:04.750586+00	\N
RES-1785428289232-8y8xb8	SCP-1785428281753-KTKXZ5	TREASURY_HOT	2525	released	\N	2026-07-30 16:18:09.232587+00	2026-07-30 16:18:09.236943+00
RES-1785428339480-uq3yhx	SCP-1785428328065-AFRAOT	TREASURY_HOT	2525	posted	shadow-1785428339482	2026-07-30 16:18:59.480827+00	\N
\.


--
-- Data for Name: stablecoin_treasury_accounts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stablecoin_treasury_accounts (account_id, type, network, asset_code, public_address, balance_cents, hold_cents, available_cents, metadata, created_at, updated_at) FROM stdin;
TREASURY_HOT	hot	testnet	USDC	\N	7964	0	7964	{"debits": [{"at": "2026-08-02T14:33:41.207Z", "amount": 10, "reason": "test mint", "source": "sovereign_mint"}, {"at": "2026-08-02T14:34:53.398Z", "amount": 10, "reason": "test mint", "source": "sovereign_mint"}], "credits": [{"at": "2026-07-29T13:52:47.407Z", "amount": 1025, "source": "cash", "txHash": null}, {"at": "2026-07-29T13:52:51.788Z", "amount": 1025, "source": "bond", "txHash": null}, {"at": "2026-07-29T13:53:24.992Z", "amount": 1025, "source": "trust", "txHash": null}, {"at": "2026-07-29T13:54:03.179Z", "amount": 1025, "source": "trust", "txHash": null}, {"at": "2026-07-29T14:01:25.857Z", "amount": 10025, "source": "bond", "txHash": null}, {"at": "2026-07-29T14:05:39.711Z", "amount": 1025, "source": "cash", "txHash": null, "movementId": "MOV-1785333939709-CBLV5N", "sourceAccountId": "CA-BOND-PROCEEDS"}, {"at": "2026-07-29T14:05:39.725Z", "amount": 1025, "source": "bond", "txHash": null, "sourceAccountId": "1", "bondTransactionId": 5}, {"at": "2026-07-29T14:14:37.201Z", "amount": 125, "source": "cash", "txHash": null, "movementId": "MOV-1785334477200-PYCRNA", "sourceAccountId": "CA-BOND-PROCEEDS"}, {"at": "2026-07-30T02:25:48.386Z", "amount": 125, "source": "cash", "txHash": null}, {"at": "2026-07-30T15:27:13.110Z", "amount": 500, "source": "test", "txHash": null}, {"at": "2026-07-30T15:31:03.586Z", "amount": 2000, "source": "test", "txHash": null}, {"at": "2026-07-30T16:17:58.569Z", "amount": 5000, "source": "hedera-test", "txHash": null}, {"at": "2026-07-30T16:18:41.436Z", "amount": 5000, "source": "hedera-test", "txHash": null}, {"at": "2026-08-02T14:34:53.402Z", "amount": 10, "source": "sovereign_mint", "target": "0x9B3601d3e395d2A40F910161669F87fe64195CF7", "txHash": null, "paymentId": "SIT-MINT-1785681293397-NUR2L9", "sourceRef": {"sourceType": "treasury", "treasuryDebit": true, "sourceAccountId": "TREASURY_HOT"}, "sourceType": "treasury", "sourceAccountId": "TREASURY_HOT"}]}	2026-07-29 02:26:48.958881+00	2026-08-02 14:34:53.40266+00
\.


--
-- Data for Name: stablecoin_wallet_registry; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stablecoin_wallet_registry (id, label, source_type, source_account_id, address, network, wallet_provider, parent_wallet_id, status, metadata, created_at, updated_at) FROM stdin;
WAL-1785425408284-V1VL2X		treasury	TREASURY_HOT	0x080e0d0ae80c86cc80bb050dbe0d5e5bdb6cd225	circle	circle	\N	active	{}	2026-07-30 15:30:08.284786+00	2026-07-30 15:30:08.284786+00
\.


--
-- Data for Name: stp_processing; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stp_processing (id, stp_id, settlement_id, payment_type, payment_method, amount, payee_name, bill_vendor_id, bill_bill_id, bill_sent_pay_id, bill_received_pay_id, bill_chart_of_acct, bill_gl_posting_date, bill_payment_terms, bill_bank_account_id, bill_invoice_id, bill_invoice_number, enrichment_complete, enrichment_errors, stp_status, submitted_at, enriched_at, transmitted_at, clearing_at, cleared_at, posted_at, available_at, settlement_date, availability_date, settlement_timing, last_bill_status, last_bill_poll_at, bill_process_date, bill_clearing_status, stp_hash, clearing_ref, posting_ref, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: sub_ledger_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sub_ledger_transactions (id, transaction_id, sub_ledger_id, transaction_type, amount, running_balance, description, reference_type, reference_id, journal_entry_id, posted_by, created_at) FROM stdin;
\.


--
-- Data for Name: system_settings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.system_settings (key, value, updated_at, updated_by) FROM stdin;
system_mode	production	2026-07-29 02:26:48.987562	system
bank_name	Open Bank REST API	2026-07-29 02:26:48.988334	system
bank_endpoint		2026-07-29 02:26:48.988646	system
bank_auth_type	none	2026-07-29 02:26:48.988947	system
bank_api_key		2026-07-29 02:26:48.989305	system
bank_api_secret		2026-07-29 02:26:48.989685	system
bank_routing_number		2026-07-29 02:26:48.989994	system
wire_endpoint		2026-07-29 02:26:48.990249	system
wire_auth_type	none	2026-07-29 02:26:48.99041	system
wire_api_key		2026-07-29 02:26:48.990861	system
settlement_webhook_url		2026-07-29 02:26:48.991125	system
auto_settle	true	2026-07-29 02:26:48.991244	system
bank_use_mtls	false	2026-07-29 02:26:48.991526	system
bank_client_cert_path		2026-07-29 02:26:48.991622	system
bank_client_key_path		2026-07-29 02:26:48.991716	system
bank_client_ca_path		2026-07-29 02:26:48.991807	system
bank_client_key_passphrase		2026-07-29 02:26:48.991957	system
\.


--
-- Data for Name: trust_accounts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.trust_accounts (id, account_code, account_name, account_type, sub_type, parent_account_code, linked_cash_account, linked_fineract_gl, balance, currency, is_active, description, created_at, updated_at) FROM stdin;
1	1000	Trust Cash & Equivalents	asset	cash	\N	\N	\N	0.00	USD	t	Primary cash holdings	2026-07-29 13:53:01.556259+00	2026-07-29 13:53:01.556259+00
2	1010	Eaton Family CU Trust Checking	asset	cash	\N	\N	\N	0.00	USD	t	Eaton Family CU trust operating/checking account (ODFI/RDFI 241075470)	2026-07-29 13:53:01.556259+00	2026-07-29 13:53:01.556259+00
3	1050	BILL Cash Account	asset	cash	\N	\N	\N	0.00	USD	t	BILL.com Cash Account (routing 028000024)	2026-07-29 13:53:01.556259+00	2026-07-29 13:53:01.556259+00
4	1100	Bond Investments	asset	investment	\N	\N	\N	0.00	USD	t	Fixed income bond holdings at cost	2026-07-29 13:53:01.556259+00	2026-07-29 13:53:01.556259+00
5	1200	Accrued Interest Receivable	asset	receivable	\N	\N	\N	0.00	USD	t	Interest earned but not yet received	2026-07-29 13:53:01.556259+00	2026-07-29 13:53:01.556259+00
6	1300	Other Receivables	asset	receivable	\N	\N	\N	0.00	USD	t	Other amounts due to the trust	2026-07-29 13:53:01.556259+00	2026-07-29 13:53:01.556259+00
7	2000	Distributions Payable	liability	payable	\N	\N	\N	0.00	USD	t	Approved but unpaid distributions	2026-07-29 13:53:01.556259+00	2026-07-29 13:53:01.556259+00
8	2100	Fees Payable	liability	payable	\N	\N	\N	0.00	USD	t	Accrued management and trustee fees	2026-07-29 13:53:01.556259+00	2026-07-29 13:53:01.556259+00
9	2200	Tax Provisions	liability	tax_provision	\N	\N	\N	0.00	USD	t	Estimated tax liabilities	2026-07-29 13:53:01.556259+00	2026-07-29 13:53:01.556259+00
10	3000	Trust Corpus	equity	trust_corpus	\N	\N	\N	0.00	USD	t	Original trust principal / corpus	2026-07-29 13:53:01.556259+00	2026-07-29 13:53:01.556259+00
11	3100	Undistributed Income	equity	undistributed_income	\N	\N	\N	0.00	USD	t	Accumulated income not yet distributed	2026-07-29 13:53:01.556259+00	2026-07-29 13:53:01.556259+00
12	3200	Unrealized Gains/Losses	equity	unrealized_gain	\N	\N	\N	0.00	USD	t	Mark-to-market unrealized P&L	2026-07-29 13:53:01.556259+00	2026-07-29 13:53:01.556259+00
13	4000	Interest Income	income	interest_income	\N	\N	\N	0.00	USD	t	Bond coupon and interest earnings	2026-07-29 13:53:01.556259+00	2026-07-29 13:53:01.556259+00
14	4100	Fee Income	income	fee_income	\N	\N	\N	0.00	USD	t	Trust fee revenue	2026-07-29 13:53:01.556259+00	2026-07-29 13:53:01.556259+00
15	4200	Realized Gains	income	realized_gain	\N	\N	\N	0.00	USD	t	Gains from asset sales	2026-07-29 13:53:01.556259+00	2026-07-29 13:53:01.556259+00
16	5000	Management Fees	expense	management_fee	\N	\N	\N	0.00	USD	t	Trust management fees	2026-07-29 13:53:01.556259+00	2026-07-29 13:53:01.556259+00
17	5100	Trustee Fees	expense	trustee_fee	\N	\N	\N	0.00	USD	t	Trustee compensation	2026-07-29 13:53:01.556259+00	2026-07-29 13:53:01.556259+00
18	5200	Legal & Professional	expense	legal_fee	\N	\N	\N	0.00	USD	t	Legal and advisory fees	2026-07-29 13:53:01.556259+00	2026-07-29 13:53:01.556259+00
19	5300	Operating Expenses	expense	operating_expense	\N	\N	\N	0.00	USD	t	General trust operating costs	2026-07-29 13:53:01.556259+00	2026-07-29 13:53:01.556259+00
20	TRUST-SRC-TEST	Test Trust Source	asset	cash	\N	\N	\N	10.25	USD	t	\N	2026-07-29 13:53:05.340706+00	2026-07-29 13:53:24.986447+00
22	1210	Stablecoin Asset	asset	cash	\N	\N	\N	-1000.00	USD	t	\N	2026-07-29 13:53:24.980886+00	2026-07-29 13:54:03.176758+00
23	TRUST-SRC-TEST2	Test Trust Source 2	asset	cash	\N	\N	\N	989.75	USD	t	\N	2026-07-29 13:54:03.163327+00	2026-07-29 13:54:03.176758+00
\.


--
-- Data for Name: trust_journal_entries; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.trust_journal_entries (id, entry_id, entry_date, description, reference_type, reference_id, bond_id, posted_by, fineract_txn_id, status, reversal_of, metadata, created_at) FROM stdin;
2	JRN-1785333204986-WG8AMI	2026-07-29	Stablecoin funding SCP-1785333204983-HD28TF	stablecoin_payment	SCP-1785333204983-HD28TF	\N	stablecoin-gateway	\N	posted	\N	{}	2026-07-29 13:53:24.986447+00
3	JRN-1785333243165-A7RHXE	2026-07-29	seed	seed	seed2	\N	test	\N	posted	\N	{}	2026-07-29 13:54:03.16524+00
4	JRN-1785333243176-8K8BLU	2026-07-29	Stablecoin funding SCP-1785333243173-8JKT40	stablecoin_payment	SCP-1785333243173-8JKT40	\N	stablecoin-gateway	\N	posted	\N	{}	2026-07-29 13:54:03.176758+00
\.


--
-- Data for Name: trust_journal_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.trust_journal_lines (id, entry_id, account_code, debit_amount, credit_amount, memo, created_at) FROM stdin;
3	JRN-1785333204986-WG8AMI	TRUST-SRC-TEST	10.25	0.00	Source funds to stablecoin	2026-07-29 13:53:24.986447+00
4	JRN-1785333204986-WG8AMI	1210	0.00	10.25	Stablecoin backing from source	2026-07-29 13:53:24.986447+00
5	JRN-1785333243165-A7RHXE	TRUST-SRC-TEST2	1000.00	0.00	seed	2026-07-29 13:54:03.16524+00
6	JRN-1785333243165-A7RHXE	1210	0.00	1000.00	seed	2026-07-29 13:54:03.16524+00
7	JRN-1785333243176-8K8BLU	1210	10.25	0.00	Stablecoin backing from source	2026-07-29 13:54:03.176758+00
8	JRN-1785333243176-8K8BLU	TRUST-SRC-TEST2	0.00	10.25	Source funds to stablecoin	2026-07-29 13:54:03.176758+00
\.


--
-- Data for Name: trust_periods; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.trust_periods (id, period_name, start_date, end_date, status, closed_by, closed_at, created_at) FROM stdin;
1	2024-Q1	2024-01-01	2024-03-31	closed	\N	\N	2026-07-29 13:53:01.556673+00
2	2024-Q2	2024-04-01	2024-06-30	closed	\N	\N	2026-07-29 13:53:01.556963+00
3	2024-Q3	2024-07-01	2024-09-30	closed	\N	\N	2026-07-29 13:53:01.557094+00
4	2024-Q4	2024-10-01	2024-12-31	closed	\N	\N	2026-07-29 13:53:01.557216+00
5	2025-Q1	2025-01-01	2025-03-31	closed	\N	\N	2026-07-29 13:53:01.557339+00
6	2025-Q2	2025-04-01	2025-06-30	closed	\N	\N	2026-07-29 13:53:01.55744+00
7	2025-Q3	2025-07-01	2025-09-30	closed	\N	\N	2026-07-29 13:53:01.557524+00
8	2025-Q4	2025-10-01	2025-12-31	closed	\N	\N	2026-07-29 13:53:01.557617+00
9	2026-Q1	2026-01-01	2026-03-31	closed	\N	\N	2026-07-29 13:53:01.557701+00
10	2026-Q2	2026-04-01	2026-06-30	open	\N	\N	2026-07-29 13:53:01.557784+00
\.


--
-- Data for Name: trustee_reviews; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.trustee_reviews (id, review_id, review_type, review_date, summary, findings, recommendations, status, created_at) FROM stdin;
\.


--
-- Data for Name: trustee_tasks; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.trustee_tasks (id, task_id, task_type, category, title, description, status, priority, scheduled_date, completed_date, result, created_by, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: vendor_payments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.vendor_payments (id, payment_id, vendor_id, source_type, source_account_code, sub_ledger_id, amount, currency, payment_method, payment_type, description, invoice_number, invoice_date, due_date, status, initiated_by, approved_by, rejected_by, rejection_reason, ach_batch_id, wire_id, bill_payment_id, journal_entry_id, approved_at, rejected_at, executed_at, settled_at, created_at, updated_at, payment_intent_id) FROM stdin;
\.


--
-- Data for Name: vendors; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.vendors (id, vendor_id, vendor_name, vendor_type, contact_name, contact_email, contact_phone, address, tax_id, bank_name, routing_number, account_number, account_type, bill_vendor_id, payment_method, payment_terms, status, approved_by, approved_at, notes, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: wire_audit_log; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.wire_audit_log (id, wire_id, action, actor, details, created_at) FROM stdin;
\.


--
-- Data for Name: wire_transfers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.wire_transfers (id, wire_id, status, amount_cents, currency, wire_type, type_code, subtype_code, payment_type, purpose, description, sender_name, sender_routing, sender_account, sender_address, beneficiary_name, beneficiary_routing, beneficiary_account, beneficiary_bank_name, beneficiary_address, intermediary_routing, intermediary_name, imad, omad, fed_reference, confirmation_number, initiated_by, approved_by, rejected_by, rejection_reason, requires_approval, journal_entry_id, error_message, retry_count, initiated_at, approved_at, rejected_at, sent_at, confirmed_at, settled_at, returned_at, created_at, updated_at, accounting_status, accounting_error) FROM stdin;
\.


--
-- Name: admin_audit_log_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.admin_audit_log_id_seq', 5, true);


--
-- Name: auth_sessions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.auth_sessions_id_seq', 11, true);


--
-- Name: auth_users_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.auth_users_id_seq', 1, true);


--
-- Name: bill_settlement_queue_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.bill_settlement_queue_id_seq', 1, false);


--
-- Name: bill_sync_log_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.bill_sync_log_id_seq', 1, false);


--
-- Name: bond_balances_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.bond_balances_id_seq', 1, true);


--
-- Name: bond_transactions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.bond_transactions_id_seq', 7, true);


--
-- Name: bond_trustees_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.bond_trustees_id_seq', 1, false);


--
-- Name: bonds_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.bonds_id_seq', 1, true);


--
-- Name: bookkeeping_adjustments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.bookkeeping_adjustments_id_seq', 1, false);


--
-- Name: bookkeeping_reconciliations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.bookkeeping_reconciliations_id_seq', 1, false);


--
-- Name: bookkeeping_tasks_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.bookkeeping_tasks_id_seq', 1, false);


--
-- Name: cash_accounts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.cash_accounts_id_seq', 8, true);


--
-- Name: cash_movements_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.cash_movements_id_seq', 5, true);


--
-- Name: client_sub_ledgers_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.client_sub_ledgers_id_seq', 1, false);


--
-- Name: coupon_payments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.coupon_payments_id_seq', 1, false);


--
-- Name: crm_bond_subscriptions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.crm_bond_subscriptions_id_seq', 1, true);


--
-- Name: crm_contacts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.crm_contacts_id_seq', 1, true);


--
-- Name: crm_interactions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.crm_interactions_id_seq', 1, false);


--
-- Name: data_bridge_discrepancies_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.data_bridge_discrepancies_id_seq', 1, false);


--
-- Name: data_bridge_sync_log_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.data_bridge_sync_log_id_seq', 120, true);


--
-- Name: document_templates_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.document_templates_id_seq', 6, true);


--
-- Name: documents_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.documents_id_seq', 13, true);


--
-- Name: electronic_settlements_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.electronic_settlements_id_seq', 1, false);


--
-- Name: generated_documents_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.generated_documents_id_seq', 1, false);


--
-- Name: nifi_payment_files_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.nifi_payment_files_id_seq', 1, false);


--
-- Name: ofx_institutions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.ofx_institutions_id_seq', 2, true);


--
-- Name: ofx_payments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.ofx_payments_id_seq', 2, true);


--
-- Name: ofx_statements_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.ofx_statements_id_seq', 1, true);


--
-- Name: ofx_transactions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.ofx_transactions_id_seq', 3, true);


--
-- Name: payment_approvals_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.payment_approvals_id_seq', 1, false);


--
-- Name: payment_events_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.payment_events_id_seq', 1, false);


--
-- Name: payment_funding_holds_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.payment_funding_holds_id_seq', 1, false);


--
-- Name: payment_intents_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.payment_intents_id_seq', 1, false);


--
-- Name: payment_webhook_receipts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.payment_webhook_receipts_id_seq', 1, false);


--
-- Name: security_audit_log_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.security_audit_log_id_seq', 11, true);


--
-- Name: stp_processing_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.stp_processing_id_seq', 1, false);


--
-- Name: sub_ledger_transactions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sub_ledger_transactions_id_seq', 1, false);


--
-- Name: trust_accounts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.trust_accounts_id_seq', 23, true);


--
-- Name: trust_journal_entries_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.trust_journal_entries_id_seq', 4, true);


--
-- Name: trust_journal_lines_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.trust_journal_lines_id_seq', 8, true);


--
-- Name: trust_periods_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.trust_periods_id_seq', 10, true);


--
-- Name: trustee_reviews_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.trustee_reviews_id_seq', 1, false);


--
-- Name: trustee_tasks_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.trustee_tasks_id_seq', 1, false);


--
-- Name: vendor_payments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.vendor_payments_id_seq', 1, false);


--
-- Name: vendors_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.vendors_id_seq', 1, false);


--
-- Name: wire_audit_log_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.wire_audit_log_id_seq', 1, false);


--
-- Name: wire_transfers_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.wire_transfers_id_seq', 1, false);


--
-- Name: admin_audit_log admin_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_log
    ADD CONSTRAINT admin_audit_log_pkey PRIMARY KEY (id);


--
-- Name: aggregator_accounts aggregator_accounts_connection_id_external_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aggregator_accounts
    ADD CONSTRAINT aggregator_accounts_connection_id_external_account_id_key UNIQUE (connection_id, external_account_id);


--
-- Name: aggregator_accounts aggregator_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aggregator_accounts
    ADD CONSTRAINT aggregator_accounts_pkey PRIMARY KEY (id);


--
-- Name: aggregator_connections aggregator_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aggregator_connections
    ADD CONSTRAINT aggregator_connections_pkey PRIMARY KEY (id);


--
-- Name: aggregator_events aggregator_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aggregator_events
    ADD CONSTRAINT aggregator_events_pkey PRIMARY KEY (id);


--
-- Name: aggregator_statements aggregator_statements_connection_id_external_statement_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aggregator_statements
    ADD CONSTRAINT aggregator_statements_connection_id_external_statement_id_key UNIQUE (connection_id, external_statement_id);


--
-- Name: aggregator_statements aggregator_statements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aggregator_statements
    ADD CONSTRAINT aggregator_statements_pkey PRIMARY KEY (id);


--
-- Name: aggregator_transactions aggregator_transactions_connection_id_external_txn_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aggregator_transactions
    ADD CONSTRAINT aggregator_transactions_connection_id_external_txn_id_key UNIQUE (connection_id, external_txn_id);


--
-- Name: aggregator_transactions aggregator_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aggregator_transactions
    ADD CONSTRAINT aggregator_transactions_pkey PRIMARY KEY (id);


--
-- Name: auth_sessions auth_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (id);


--
-- Name: auth_sessions auth_sessions_token_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_token_id_key UNIQUE (token_id);


--
-- Name: auth_users auth_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_users
    ADD CONSTRAINT auth_users_pkey PRIMARY KEY (id);


--
-- Name: auth_users auth_users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_users
    ADD CONSTRAINT auth_users_username_key UNIQUE (username);


--
-- Name: bill_settlement_queue bill_settlement_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bill_settlement_queue
    ADD CONSTRAINT bill_settlement_queue_pkey PRIMARY KEY (id);


--
-- Name: bill_settlement_queue bill_settlement_queue_settlement_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bill_settlement_queue
    ADD CONSTRAINT bill_settlement_queue_settlement_id_key UNIQUE (settlement_id);


--
-- Name: bill_sync_log bill_sync_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bill_sync_log
    ADD CONSTRAINT bill_sync_log_pkey PRIMARY KEY (id);


--
-- Name: bill_sync_log bill_sync_log_sync_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bill_sync_log
    ADD CONSTRAINT bill_sync_log_sync_id_key UNIQUE (sync_id);


--
-- Name: bond_balances bond_balances_bond_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bond_balances
    ADD CONSTRAINT bond_balances_bond_id_key UNIQUE (bond_id);


--
-- Name: bond_balances bond_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bond_balances
    ADD CONSTRAINT bond_balances_pkey PRIMARY KEY (id);


--
-- Name: bond_transactions bond_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bond_transactions
    ADD CONSTRAINT bond_transactions_pkey PRIMARY KEY (id);


--
-- Name: bond_trustees bond_trustees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bond_trustees
    ADD CONSTRAINT bond_trustees_pkey PRIMARY KEY (id);


--
-- Name: bonds bonds_bond_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonds
    ADD CONSTRAINT bonds_bond_name_key UNIQUE (bond_name);


--
-- Name: bonds bonds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonds
    ADD CONSTRAINT bonds_pkey PRIMARY KEY (id);


--
-- Name: bookkeeping_adjustments bookkeeping_adjustments_adjustment_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookkeeping_adjustments
    ADD CONSTRAINT bookkeeping_adjustments_adjustment_id_key UNIQUE (adjustment_id);


--
-- Name: bookkeeping_adjustments bookkeeping_adjustments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookkeeping_adjustments
    ADD CONSTRAINT bookkeeping_adjustments_pkey PRIMARY KEY (id);


--
-- Name: bookkeeping_reconciliations bookkeeping_reconciliations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookkeeping_reconciliations
    ADD CONSTRAINT bookkeeping_reconciliations_pkey PRIMARY KEY (id);


--
-- Name: bookkeeping_reconciliations bookkeeping_reconciliations_recon_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookkeeping_reconciliations
    ADD CONSTRAINT bookkeeping_reconciliations_recon_id_key UNIQUE (recon_id);


--
-- Name: bookkeeping_tasks bookkeeping_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookkeeping_tasks
    ADD CONSTRAINT bookkeeping_tasks_pkey PRIMARY KEY (id);


--
-- Name: bookkeeping_tasks bookkeeping_tasks_task_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookkeeping_tasks
    ADD CONSTRAINT bookkeeping_tasks_task_id_key UNIQUE (task_id);


--
-- Name: calendar_events calendar_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_pkey PRIMARY KEY (id);


--
-- Name: cash_accounts cash_accounts_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_accounts
    ADD CONSTRAINT cash_accounts_account_id_key UNIQUE (account_id);


--
-- Name: cash_accounts cash_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_accounts
    ADD CONSTRAINT cash_accounts_pkey PRIMARY KEY (id);


--
-- Name: cash_movements cash_movements_movement_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_movements
    ADD CONSTRAINT cash_movements_movement_id_key UNIQUE (movement_id);


--
-- Name: cash_movements cash_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_movements
    ADD CONSTRAINT cash_movements_pkey PRIMARY KEY (id);


--
-- Name: client_sub_ledgers client_sub_ledgers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_sub_ledgers
    ADD CONSTRAINT client_sub_ledgers_pkey PRIMARY KEY (id);


--
-- Name: client_sub_ledgers client_sub_ledgers_sub_ledger_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_sub_ledgers
    ADD CONSTRAINT client_sub_ledgers_sub_ledger_id_key UNIQUE (sub_ledger_id);


--
-- Name: coinbase_hbar_orders coinbase_hbar_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coinbase_hbar_orders
    ADD CONSTRAINT coinbase_hbar_orders_pkey PRIMARY KEY (id);


--
-- Name: coupon_payments coupon_payments_coupon_payment_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupon_payments
    ADD CONSTRAINT coupon_payments_coupon_payment_id_key UNIQUE (coupon_payment_id);


--
-- Name: coupon_payments coupon_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupon_payments
    ADD CONSTRAINT coupon_payments_pkey PRIMARY KEY (id);


--
-- Name: crm_bond_subscriptions crm_bond_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_bond_subscriptions
    ADD CONSTRAINT crm_bond_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: crm_bond_subscriptions crm_bond_subscriptions_subscription_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_bond_subscriptions
    ADD CONSTRAINT crm_bond_subscriptions_subscription_id_key UNIQUE (subscription_id);


--
-- Name: crm_contacts crm_contacts_contact_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contacts
    ADD CONSTRAINT crm_contacts_contact_id_key UNIQUE (contact_id);


--
-- Name: crm_contacts crm_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contacts
    ADD CONSTRAINT crm_contacts_pkey PRIMARY KEY (id);


--
-- Name: crm_interactions crm_interactions_interaction_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_interactions
    ADD CONSTRAINT crm_interactions_interaction_id_key UNIQUE (interaction_id);


--
-- Name: crm_interactions crm_interactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_interactions
    ADD CONSTRAINT crm_interactions_pkey PRIMARY KEY (id);


--
-- Name: dapp_deposits dapp_deposits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dapp_deposits
    ADD CONSTRAINT dapp_deposits_pkey PRIMARY KEY (id);


--
-- Name: dapp_distributions dapp_distributions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dapp_distributions
    ADD CONSTRAINT dapp_distributions_pkey PRIMARY KEY (id);


--
-- Name: dapp_payouts dapp_payouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dapp_payouts
    ADD CONSTRAINT dapp_payouts_pkey PRIMARY KEY (id);


--
-- Name: dapp_safes dapp_safes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dapp_safes
    ADD CONSTRAINT dapp_safes_pkey PRIMARY KEY (id);


--
-- Name: dapp_users dapp_users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dapp_users
    ADD CONSTRAINT dapp_users_email_key UNIQUE (email);


--
-- Name: dapp_users dapp_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dapp_users
    ADD CONSTRAINT dapp_users_pkey PRIMARY KEY (id);


--
-- Name: dapp_white_label dapp_white_label_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dapp_white_label
    ADD CONSTRAINT dapp_white_label_pkey PRIMARY KEY (id);


--
-- Name: dapp_white_label dapp_white_label_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dapp_white_label
    ADD CONSTRAINT dapp_white_label_slug_key UNIQUE (slug);


--
-- Name: data_bridge_discrepancies data_bridge_discrepancies_discrepancy_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_bridge_discrepancies
    ADD CONSTRAINT data_bridge_discrepancies_discrepancy_id_key UNIQUE (discrepancy_id);


--
-- Name: data_bridge_discrepancies data_bridge_discrepancies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_bridge_discrepancies
    ADD CONSTRAINT data_bridge_discrepancies_pkey PRIMARY KEY (id);


--
-- Name: data_bridge_sync_log data_bridge_sync_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_bridge_sync_log
    ADD CONSTRAINT data_bridge_sync_log_pkey PRIMARY KEY (id);


--
-- Name: data_bridge_sync_log data_bridge_sync_log_sync_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_bridge_sync_log
    ADD CONSTRAINT data_bridge_sync_log_sync_id_key UNIQUE (sync_id);


--
-- Name: document_templates document_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_templates
    ADD CONSTRAINT document_templates_pkey PRIMARY KEY (id);


--
-- Name: document_templates document_templates_template_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_templates
    ADD CONSTRAINT document_templates_template_id_key UNIQUE (template_id);


--
-- Name: documents documents_document_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_document_id_key UNIQUE (document_id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: electronic_settlements electronic_settlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.electronic_settlements
    ADD CONSTRAINT electronic_settlements_pkey PRIMARY KEY (id);


--
-- Name: electronic_settlements electronic_settlements_settlement_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.electronic_settlements
    ADD CONSTRAINT electronic_settlements_settlement_id_key UNIQUE (settlement_id);


--
-- Name: finops_tasks finops_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finops_tasks
    ADD CONSTRAINT finops_tasks_pkey PRIMARY KEY (id);


--
-- Name: generated_documents generated_documents_generation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_documents
    ADD CONSTRAINT generated_documents_generation_id_key UNIQUE (generation_id);


--
-- Name: generated_documents generated_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_documents
    ADD CONSTRAINT generated_documents_pkey PRIMARY KEY (id);


--
-- Name: message_threads message_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_threads
    ADD CONSTRAINT message_threads_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: nifi_payment_files nifi_payment_files_file_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nifi_payment_files
    ADD CONSTRAINT nifi_payment_files_file_id_key UNIQUE (file_id);


--
-- Name: nifi_payment_files nifi_payment_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nifi_payment_files
    ADD CONSTRAINT nifi_payment_files_pkey PRIMARY KEY (id);


--
-- Name: ofx_institutions ofx_institutions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ofx_institutions
    ADD CONSTRAINT ofx_institutions_pkey PRIMARY KEY (id);


--
-- Name: ofx_payments ofx_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ofx_payments
    ADD CONSTRAINT ofx_payments_pkey PRIMARY KEY (id);


--
-- Name: ofx_payments ofx_payments_reference_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ofx_payments
    ADD CONSTRAINT ofx_payments_reference_key UNIQUE (reference);


--
-- Name: ofx_statements ofx_statements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ofx_statements
    ADD CONSTRAINT ofx_statements_pkey PRIMARY KEY (id);


--
-- Name: ofx_transactions ofx_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ofx_transactions
    ADD CONSTRAINT ofx_transactions_pkey PRIMARY KEY (id);


--
-- Name: ofx_transactions ofx_transactions_statement_id_fit_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ofx_transactions
    ADD CONSTRAINT ofx_transactions_statement_id_fit_id_key UNIQUE (statement_id, fit_id);


--
-- Name: payment_approvals payment_approvals_approval_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_approvals
    ADD CONSTRAINT payment_approvals_approval_id_key UNIQUE (approval_id);


--
-- Name: payment_approvals payment_approvals_intent_id_approver_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_approvals
    ADD CONSTRAINT payment_approvals_intent_id_approver_id_key UNIQUE (intent_id, approver_id);


--
-- Name: payment_approvals payment_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_approvals
    ADD CONSTRAINT payment_approvals_pkey PRIMARY KEY (id);


--
-- Name: payment_events payment_events_event_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_events
    ADD CONSTRAINT payment_events_event_hash_key UNIQUE (event_hash);


--
-- Name: payment_events payment_events_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_events
    ADD CONSTRAINT payment_events_event_id_key UNIQUE (event_id);


--
-- Name: payment_events payment_events_intent_id_external_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_events
    ADD CONSTRAINT payment_events_intent_id_external_event_id_key UNIQUE (intent_id, external_event_id);


--
-- Name: payment_events payment_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_events
    ADD CONSTRAINT payment_events_pkey PRIMARY KEY (id);


--
-- Name: payment_funding_holds payment_funding_holds_hold_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_funding_holds
    ADD CONSTRAINT payment_funding_holds_hold_id_key UNIQUE (hold_id);


--
-- Name: payment_funding_holds payment_funding_holds_intent_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_funding_holds
    ADD CONSTRAINT payment_funding_holds_intent_id_key UNIQUE (intent_id);


--
-- Name: payment_funding_holds payment_funding_holds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_funding_holds
    ADD CONSTRAINT payment_funding_holds_pkey PRIMARY KEY (id);


--
-- Name: payment_intents payment_intents_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_intents
    ADD CONSTRAINT payment_intents_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: payment_intents payment_intents_intent_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_intents
    ADD CONSTRAINT payment_intents_intent_id_key UNIQUE (intent_id);


--
-- Name: payment_intents payment_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_intents
    ADD CONSTRAINT payment_intents_pkey PRIMARY KEY (id);


--
-- Name: payment_webhook_receipts payment_webhook_receipts_external_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_webhook_receipts
    ADD CONSTRAINT payment_webhook_receipts_external_event_id_key UNIQUE (external_event_id);


--
-- Name: payment_webhook_receipts payment_webhook_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_webhook_receipts
    ADD CONSTRAINT payment_webhook_receipts_pkey PRIMARY KEY (id);


--
-- Name: payment_webhook_receipts payment_webhook_receipts_receipt_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_webhook_receipts
    ADD CONSTRAINT payment_webhook_receipts_receipt_id_key UNIQUE (receipt_id);


--
-- Name: security_audit_log security_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_audit_log
    ADD CONSTRAINT security_audit_log_pkey PRIMARY KEY (id);


--
-- Name: sovereign_ramp_orders sovereign_ramp_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sovereign_ramp_orders
    ADD CONSTRAINT sovereign_ramp_orders_pkey PRIMARY KEY (id);


--
-- Name: sovereign_token_holders sovereign_token_holders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sovereign_token_holders
    ADD CONSTRAINT sovereign_token_holders_pkey PRIMARY KEY (id);


--
-- Name: sovereign_token_holders sovereign_token_holders_token_id_address_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sovereign_token_holders
    ADD CONSTRAINT sovereign_token_holders_token_id_address_key UNIQUE (token_id, address);


--
-- Name: sovereign_tokens sovereign_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sovereign_tokens
    ADD CONSTRAINT sovereign_tokens_pkey PRIMARY KEY (id);


--
-- Name: stablecoin_clearing_orders stablecoin_clearing_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stablecoin_clearing_orders
    ADD CONSTRAINT stablecoin_clearing_orders_pkey PRIMARY KEY (id);


--
-- Name: stablecoin_payments stablecoin_payments_payment_hub_intent_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stablecoin_payments
    ADD CONSTRAINT stablecoin_payments_payment_hub_intent_id_key UNIQUE (payment_hub_intent_id);


--
-- Name: stablecoin_payments stablecoin_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stablecoin_payments
    ADD CONSTRAINT stablecoin_payments_pkey PRIMARY KEY (id);


--
-- Name: stablecoin_reserves stablecoin_reserves_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stablecoin_reserves
    ADD CONSTRAINT stablecoin_reserves_pkey PRIMARY KEY (reserve_id);


--
-- Name: stablecoin_treasury_accounts stablecoin_treasury_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stablecoin_treasury_accounts
    ADD CONSTRAINT stablecoin_treasury_accounts_pkey PRIMARY KEY (account_id);


--
-- Name: stablecoin_wallet_registry stablecoin_wallet_registry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stablecoin_wallet_registry
    ADD CONSTRAINT stablecoin_wallet_registry_pkey PRIMARY KEY (id);


--
-- Name: stp_processing stp_processing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stp_processing
    ADD CONSTRAINT stp_processing_pkey PRIMARY KEY (id);


--
-- Name: stp_processing stp_processing_stp_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stp_processing
    ADD CONSTRAINT stp_processing_stp_id_key UNIQUE (stp_id);


--
-- Name: sub_ledger_transactions sub_ledger_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sub_ledger_transactions
    ADD CONSTRAINT sub_ledger_transactions_pkey PRIMARY KEY (id);


--
-- Name: sub_ledger_transactions sub_ledger_transactions_transaction_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sub_ledger_transactions
    ADD CONSTRAINT sub_ledger_transactions_transaction_id_key UNIQUE (transaction_id);


--
-- Name: system_settings system_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_pkey PRIMARY KEY (key);


--
-- Name: trust_accounts trust_accounts_account_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_accounts
    ADD CONSTRAINT trust_accounts_account_code_key UNIQUE (account_code);


--
-- Name: trust_accounts trust_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_accounts
    ADD CONSTRAINT trust_accounts_pkey PRIMARY KEY (id);


--
-- Name: trust_journal_entries trust_journal_entries_entry_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_journal_entries
    ADD CONSTRAINT trust_journal_entries_entry_id_key UNIQUE (entry_id);


--
-- Name: trust_journal_entries trust_journal_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_journal_entries
    ADD CONSTRAINT trust_journal_entries_pkey PRIMARY KEY (id);


--
-- Name: trust_journal_lines trust_journal_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_journal_lines
    ADD CONSTRAINT trust_journal_lines_pkey PRIMARY KEY (id);


--
-- Name: trust_periods trust_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_periods
    ADD CONSTRAINT trust_periods_pkey PRIMARY KEY (id);


--
-- Name: trustee_reviews trustee_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trustee_reviews
    ADD CONSTRAINT trustee_reviews_pkey PRIMARY KEY (id);


--
-- Name: trustee_reviews trustee_reviews_review_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trustee_reviews
    ADD CONSTRAINT trustee_reviews_review_id_key UNIQUE (review_id);


--
-- Name: trustee_tasks trustee_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trustee_tasks
    ADD CONSTRAINT trustee_tasks_pkey PRIMARY KEY (id);


--
-- Name: trustee_tasks trustee_tasks_task_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trustee_tasks
    ADD CONSTRAINT trustee_tasks_task_id_key UNIQUE (task_id);


--
-- Name: vendor_payments vendor_payments_payment_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_payments
    ADD CONSTRAINT vendor_payments_payment_id_key UNIQUE (payment_id);


--
-- Name: vendor_payments vendor_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_payments
    ADD CONSTRAINT vendor_payments_pkey PRIMARY KEY (id);


--
-- Name: vendors vendors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_pkey PRIMARY KEY (id);


--
-- Name: vendors vendors_vendor_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_vendor_id_key UNIQUE (vendor_id);


--
-- Name: wire_audit_log wire_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wire_audit_log
    ADD CONSTRAINT wire_audit_log_pkey PRIMARY KEY (id);


--
-- Name: wire_transfers wire_transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wire_transfers
    ADD CONSTRAINT wire_transfers_pkey PRIMARY KEY (id);


--
-- Name: wire_transfers wire_transfers_wire_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wire_transfers
    ADD CONSTRAINT wire_transfers_wire_id_key UNIQUE (wire_id);


--
-- Name: idx_bond_txn_bond_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bond_txn_bond_id ON public.bond_transactions USING btree (bond_id);


--
-- Name: idx_bond_txn_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bond_txn_date ON public.bond_transactions USING btree (transaction_date);


--
-- Name: idx_bond_txn_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bond_txn_type ON public.bond_transactions USING btree (transaction_type);


--
-- Name: idx_calendar_events_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_events_ref ON public.calendar_events USING btree (related_module, reference_id);


--
-- Name: idx_calendar_events_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_events_time ON public.calendar_events USING btree (start_time);


--
-- Name: idx_cbhbar_address; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cbhbar_address ON public.coinbase_hbar_orders USING btree (target_address);


--
-- Name: idx_cbhbar_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cbhbar_status ON public.coinbase_hbar_orders USING btree (status);


--
-- Name: idx_dapp_payouts_safe; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dapp_payouts_safe ON public.dapp_payouts USING btree (safe_id);


--
-- Name: idx_dapp_payouts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dapp_payouts_status ON public.dapp_payouts USING btree (status);


--
-- Name: idx_doc_templates_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_templates_active ON public.document_templates USING btree (is_active);


--
-- Name: idx_doc_templates_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_templates_type ON public.document_templates USING btree (template_type);


--
-- Name: idx_documents_bond_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_bond_id ON public.documents USING btree (bond_id);


--
-- Name: idx_documents_contact_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_contact_id ON public.documents USING btree (contact_id);


--
-- Name: idx_documents_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_status ON public.documents USING btree (status);


--
-- Name: idx_documents_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_type ON public.documents USING btree (document_type);


--
-- Name: idx_es_payment_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_es_payment_ref ON public.electronic_settlements USING btree (payment_ref);


--
-- Name: idx_es_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_es_status ON public.electronic_settlements USING btree (status);


--
-- Name: idx_es_sub_ledger; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_es_sub_ledger ON public.electronic_settlements USING btree (sub_ledger_id);


--
-- Name: idx_es_vendor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_es_vendor ON public.electronic_settlements USING btree (vendor_id);


--
-- Name: idx_finops_tasks_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_finops_tasks_status ON public.finops_tasks USING btree (status);


--
-- Name: idx_gen_docs_bond; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gen_docs_bond ON public.generated_documents USING btree (bond_id);


--
-- Name: idx_gen_docs_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gen_docs_template ON public.generated_documents USING btree (template_id);


--
-- Name: idx_messages_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_thread ON public.messages USING btree (thread_id, created_at);


--
-- Name: idx_npf_direction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_npf_direction ON public.nifi_payment_files USING btree (direction);


--
-- Name: idx_npf_file_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_npf_file_id ON public.nifi_payment_files USING btree (file_id);


--
-- Name: idx_npf_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_npf_status ON public.nifi_payment_files USING btree (status);


--
-- Name: idx_payment_events_intent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_events_intent ON public.payment_events USING btree (intent_id, id);


--
-- Name: idx_payment_holds_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_holds_expiry ON public.payment_funding_holds USING btree (status, expires_at);


--
-- Name: idx_payment_holds_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_holds_source ON public.payment_funding_holds USING btree (source_type, source_id, status);


--
-- Name: idx_payment_intents_ach_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_intents_ach_batch ON public.payment_intents USING btree (ach_batch_id);


--
-- Name: idx_payment_intents_hub_txn; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_intents_hub_txn ON public.payment_intents USING btree (payment_hub_txn_id);


--
-- Name: idx_payment_intents_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_intents_status ON public.payment_intents USING btree (status, created_at DESC);


--
-- Name: idx_sco_payment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sco_payment ON public.stablecoin_clearing_orders USING btree (payment_id);


--
-- Name: idx_sco_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sco_status ON public.stablecoin_clearing_orders USING btree (status);


--
-- Name: idx_scp_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scp_status ON public.stablecoin_payments USING btree (status);


--
-- Name: idx_stp_settlement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stp_settlement ON public.stp_processing USING btree (settlement_id);


--
-- Name: idx_stp_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stp_status ON public.stp_processing USING btree (stp_status);


--
-- Name: idx_sub_ledger_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_ledger_contact ON public.client_sub_ledgers USING btree (contact_id);


--
-- Name: idx_sub_ledger_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_ledger_parent ON public.client_sub_ledgers USING btree (parent_account_code);


--
-- Name: idx_sub_txn_ledger; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_txn_ledger ON public.sub_ledger_transactions USING btree (sub_ledger_id);


--
-- Name: idx_sub_txn_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_txn_ref ON public.sub_ledger_transactions USING btree (reference_type, reference_id);


--
-- Name: idx_swr_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_swr_parent ON public.stablecoin_wallet_registry USING btree (parent_wallet_id) WHERE (parent_wallet_id IS NOT NULL);


--
-- Name: idx_swr_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_swr_source ON public.stablecoin_wallet_registry USING btree (source_type, source_account_id);


--
-- Name: idx_trust_accounts_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trust_accounts_type ON public.trust_accounts USING btree (account_type);


--
-- Name: idx_trust_journal_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trust_journal_date ON public.trust_journal_entries USING btree (entry_date);


--
-- Name: idx_trust_journal_lines_acct; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trust_journal_lines_acct ON public.trust_journal_lines USING btree (account_code);


--
-- Name: idx_trust_journal_lines_entry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trust_journal_lines_entry ON public.trust_journal_lines USING btree (entry_id);


--
-- Name: idx_trust_journal_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trust_journal_status ON public.trust_journal_entries USING btree (status);


--
-- Name: idx_trust_periods_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trust_periods_status ON public.trust_periods USING btree (status);


--
-- Name: idx_vp_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vp_status ON public.vendor_payments USING btree (status);


--
-- Name: idx_vp_vendor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vp_vendor ON public.vendor_payments USING btree (vendor_id);


--
-- Name: idx_wire_audit_wire_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wire_audit_wire_id ON public.wire_audit_log USING btree (wire_id);


--
-- Name: idx_wire_beneficiary; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wire_beneficiary ON public.wire_transfers USING btree (beneficiary_name);


--
-- Name: idx_wire_initiated_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wire_initiated_by ON public.wire_transfers USING btree (initiated_by);


--
-- Name: idx_wire_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wire_status ON public.wire_transfers USING btree (status);


--
-- Name: aggregator_accounts aggregator_accounts_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aggregator_accounts
    ADD CONSTRAINT aggregator_accounts_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.aggregator_connections(id) ON DELETE CASCADE;


--
-- Name: aggregator_events aggregator_events_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aggregator_events
    ADD CONSTRAINT aggregator_events_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.aggregator_connections(id) ON DELETE SET NULL;


--
-- Name: aggregator_statements aggregator_statements_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aggregator_statements
    ADD CONSTRAINT aggregator_statements_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.aggregator_connections(id) ON DELETE CASCADE;


--
-- Name: aggregator_transactions aggregator_transactions_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aggregator_transactions
    ADD CONSTRAINT aggregator_transactions_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.aggregator_connections(id) ON DELETE CASCADE;


--
-- Name: auth_sessions auth_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auth_users(id) ON DELETE CASCADE;


--
-- Name: bond_balances bond_balances_bond_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bond_balances
    ADD CONSTRAINT bond_balances_bond_id_fkey FOREIGN KEY (bond_id) REFERENCES public.bonds(id);


--
-- Name: bond_transactions bond_transactions_bond_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bond_transactions
    ADD CONSTRAINT bond_transactions_bond_id_fkey FOREIGN KEY (bond_id) REFERENCES public.bonds(id);


--
-- Name: bond_trustees bond_trustees_bond_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bond_trustees
    ADD CONSTRAINT bond_trustees_bond_id_fkey FOREIGN KEY (bond_id) REFERENCES public.bonds(id) ON DELETE CASCADE;


--
-- Name: cash_movements cash_movements_from_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_movements
    ADD CONSTRAINT cash_movements_from_account_id_fkey FOREIGN KEY (from_account_id) REFERENCES public.cash_accounts(account_id);


--
-- Name: cash_movements cash_movements_to_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_movements
    ADD CONSTRAINT cash_movements_to_account_id_fkey FOREIGN KEY (to_account_id) REFERENCES public.cash_accounts(account_id);


--
-- Name: crm_bond_subscriptions crm_bond_subscriptions_bond_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_bond_subscriptions
    ADD CONSTRAINT crm_bond_subscriptions_bond_id_fkey FOREIGN KEY (bond_id) REFERENCES public.bonds(id);


--
-- Name: crm_bond_subscriptions crm_bond_subscriptions_cash_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_bond_subscriptions
    ADD CONSTRAINT crm_bond_subscriptions_cash_account_id_fkey FOREIGN KEY (cash_account_id) REFERENCES public.cash_accounts(account_id);


--
-- Name: crm_bond_subscriptions crm_bond_subscriptions_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_bond_subscriptions
    ADD CONSTRAINT crm_bond_subscriptions_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.crm_contacts(contact_id);


--
-- Name: crm_interactions crm_interactions_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_interactions
    ADD CONSTRAINT crm_interactions_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.crm_contacts(contact_id) ON DELETE CASCADE;


--
-- Name: dapp_deposits dapp_deposits_safe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dapp_deposits
    ADD CONSTRAINT dapp_deposits_safe_id_fkey FOREIGN KEY (safe_id) REFERENCES public.dapp_safes(id) ON DELETE SET NULL;


--
-- Name: dapp_distributions dapp_distributions_safe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dapp_distributions
    ADD CONSTRAINT dapp_distributions_safe_id_fkey FOREIGN KEY (safe_id) REFERENCES public.dapp_safes(id) ON DELETE SET NULL;


--
-- Name: dapp_payouts dapp_payouts_safe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dapp_payouts
    ADD CONSTRAINT dapp_payouts_safe_id_fkey FOREIGN KEY (safe_id) REFERENCES public.dapp_safes(id) ON DELETE CASCADE;


--
-- Name: documents documents_bond_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_bond_id_fkey FOREIGN KEY (bond_id) REFERENCES public.bonds(id);


--
-- Name: generated_documents generated_documents_bond_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_documents
    ADD CONSTRAINT generated_documents_bond_id_fkey FOREIGN KEY (bond_id) REFERENCES public.bonds(id);


--
-- Name: generated_documents generated_documents_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_documents
    ADD CONSTRAINT generated_documents_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(document_id);


--
-- Name: generated_documents generated_documents_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_documents
    ADD CONSTRAINT generated_documents_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.document_templates(template_id);


--
-- Name: messages messages_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.message_threads(id) ON DELETE CASCADE;


--
-- Name: ofx_payments ofx_payments_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ofx_payments
    ADD CONSTRAINT ofx_payments_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.ofx_institutions(id);


--
-- Name: ofx_statements ofx_statements_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ofx_statements
    ADD CONSTRAINT ofx_statements_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.ofx_institutions(id);


--
-- Name: ofx_transactions ofx_transactions_statement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ofx_transactions
    ADD CONSTRAINT ofx_transactions_statement_id_fkey FOREIGN KEY (statement_id) REFERENCES public.ofx_statements(id);


--
-- Name: sovereign_token_holders sovereign_token_holders_token_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sovereign_token_holders
    ADD CONSTRAINT sovereign_token_holders_token_id_fkey FOREIGN KEY (token_id) REFERENCES public.sovereign_tokens(id) ON DELETE CASCADE;


--
-- Name: trust_accounts trust_accounts_linked_cash_account_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_accounts
    ADD CONSTRAINT trust_accounts_linked_cash_account_fkey FOREIGN KEY (linked_cash_account) REFERENCES public.cash_accounts(account_id);


--
-- Name: trust_journal_entries trust_journal_entries_bond_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_journal_entries
    ADD CONSTRAINT trust_journal_entries_bond_id_fkey FOREIGN KEY (bond_id) REFERENCES public.bonds(id);


--
-- Name: trust_journal_lines trust_journal_lines_account_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_journal_lines
    ADD CONSTRAINT trust_journal_lines_account_code_fkey FOREIGN KEY (account_code) REFERENCES public.trust_accounts(account_code);


--
-- Name: trust_journal_lines trust_journal_lines_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_journal_lines
    ADD CONSTRAINT trust_journal_lines_entry_id_fkey FOREIGN KEY (entry_id) REFERENCES public.trust_journal_entries(entry_id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict 2pP5osaLY5s83ar0w7ggLbpwyBezgqcvmAfq02MQMRQ1hYBFEAoh9zklv0Hz0Mk

