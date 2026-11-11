-- Curated Soth laundry schema based on Lush's schema-only reference.
-- No Lush business data, Woodz tables, TradeFlow login, owner changes, or broad API grants.

BEGIN;

CREATE TYPE "public"."order_status" AS ENUM (
    'pending',
    'processing',
    'ready',
    'delivered',
    'cancelled'
);

CREATE TYPE "public"."price_category" AS ENUM (
    'gents',
    'ladies',
    'general',
    'home_services',
    'kids'
);

CREATE TYPE "public"."user_role" AS ENUM (
    'ADMIN',
    'USER',
    'MANAGER',
    'DESKTOP_AGENT'
);

CREATE TYPE "public"."user_status" AS ENUM (
    'PENDING',
    'ACTIVE',
    'SUSPENDED'
);

CREATE TABLE IF NOT EXISTS "public"."tenants" (
    "id" integer NOT NULL,
    "tenant_name" character varying(255) NOT NULL,
    "tenant_slug" character varying(120) NOT NULL,
    "contact_email" character varying(255),
    "is_active" boolean DEFAULT true NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE OR REPLACE FUNCTION public.get_default_tenant_id()
RETURNS INTEGER LANGUAGE plpgsql STABLE AS $$
DECLARE tenant_id_value INTEGER;
BEGIN
 SELECT id INTO tenant_id_value FROM public.tenants WHERE is_default ORDER BY id LIMIT 1;
 IF tenant_id_value IS NULL THEN RAISE EXCEPTION 'No default tenant is configured'; END IF;
 RETURN tenant_id_value;
END $$;
CREATE OR REPLACE FUNCTION public.app_current_tenant_id()
RETURNS INTEGER LANGUAGE plpgsql STABLE AS $$
DECLARE v TEXT;
BEGIN
 v := NULLIF(current_setting('app.current_tenant_id', TRUE), '');
 IF v IS NULL OR v !~ '^[0-9]+$' THEN RETURN NULL; END IF;
 RETURN v::INTEGER;
END $$;

DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM public.tenants) THEN RAISE EXCEPTION 'Expected an empty Soth tenants table'; END IF;
 INSERT INTO public.tenants (id,tenant_name,tenant_slug,contact_email,is_active,is_default)
 VALUES (1,'Soth Dry Cleaners','soth-dry-cleaners',NULL,TRUE,TRUE);
END $$;

CREATE TABLE IF NOT EXISTS "public"."activity_logs" (
    "id" integer NOT NULL,
    "user_id" integer,
    "user_email" character varying(255),
    "user_name" character varying(255),
    "user_role" character varying(50),
    "action" character varying(100) NOT NULL,
    "resource_type" character varying(50),
    "resource_id" integer,
    "details" "jsonb",
    "ip_address" character varying(45),
    "user_agent" "text",
    "severity" character varying(20) DEFAULT 'INFO'::character varying,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."audit_logs" (
    "id" bigint NOT NULL,
    "table_name" character varying(255),
    "operation" character varying(6),
    "record_id" integer,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL,
    "user_id" character varying(255),
    "old_data" "jsonb",
    "new_data" "jsonb",
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "public"."automated_backup_dates" (
    "id" integer NOT NULL,
    "backup_date" "date" NOT NULL,
    "attempt_date" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "status" character varying(20) NOT NULL,
    "error_message" "text",
    "retry_count" integer DEFAULT 0,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."automation_settings" (
    "id" integer NOT NULL,
    "setting_key" character varying(100) NOT NULL,
    "setting_value" boolean DEFAULT false NOT NULL,
    "description" "text",
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_by" integer,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."backup_attempts" (
    "id" integer NOT NULL,
    "backup_type" character varying(50) NOT NULL,
    "status" character varying(50) NOT NULL,
    "file_path" "text",
    "file_size" bigint,
    "error_message" "text",
    "triggered_by" character varying(100),
    "started_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "completed_at" timestamp without time zone,
    "duration_ms" integer,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."backup_email_settings" (
    "id" integer NOT NULL,
    "enabled" boolean DEFAULT false,
    "email" character varying(255),
    "frequency" character varying(50),
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_by" character varying(255),
    "categories" "jsonb" DEFAULT '["orders", "customers", "payments"]'::"jsonb",
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."backup_history" (
    "id" integer NOT NULL,
    "type" character varying(100),
    "created_by" character varying(255),
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "size" character varying(50),
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."branches" (
    "id" integer NOT NULL,
    "name" character varying(120) NOT NULL,
    "code" character varying(20) NOT NULL,
    "phone" character varying(30),
    "email" character varying(150),
    "location" character varying(200),
    "address" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "payment_modes" "jsonb" DEFAULT '{}'::"jsonb",
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."business_settings" (
    "id" integer NOT NULL,
    "setting_key" character varying(100) NOT NULL,
    "setting_value" "jsonb" NOT NULL,
    "updated_at" timestamp without time zone DEFAULT "now"(),
    "updated_by" integer,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."fiscal_years" (
    "id" integer NOT NULL,
    "year_name" character varying(50) NOT NULL,
    "start_date" "date" NOT NULL,
    "end_date" "date" NOT NULL,
    "status" character varying(20) DEFAULT 'OPEN'::character varying,
    "closing_date" timestamp without time zone,
    "closed_by" integer,
    "opening_balance" numeric(12,2) DEFAULT 0,
    "closing_balance" numeric(12,2),
    "net_profit" numeric(12,2),
    "retained_earnings" numeric(12,2),
    "notes" "text",
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."customers" (
    "id" integer NOT NULL,
    "customer_id" character varying(50) NOT NULL,
    "name" character varying(255) NOT NULL,
    "phone" character varying(50) NOT NULL,
    "email" character varying(255),
    "location" "text",
    "notes" "text",
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "customer_type" character varying(20) DEFAULT 'INDIVIDUAL'::character varying,
    "sms_opt_in" boolean DEFAULT true,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL,
    CONSTRAINT "customers_customer_type_check" CHECK ((("customer_type")::"text" = ANY ((ARRAY['INDIVIDUAL'::character varying, 'BUSINESS'::character varying])::"text"[])))
);

CREATE TABLE IF NOT EXISTS "public"."damage_claims" (
    "id" integer NOT NULL,
    "order_id" integer NOT NULL,
    "order_number" character varying(50),
    "customer_name" character varying(255),
    "item_description" "text" NOT NULL,
    "claim_type" character varying(20) DEFAULT 'DAMAGED'::character varying NOT NULL,
    "description" "text",
    "compensation_amount" integer DEFAULT 0 NOT NULL,
    "status" character varying(20) DEFAULT 'OPEN'::character varying NOT NULL,
    "resolution_notes" "text",
    "logged_by" integer,
    "resolved_by" integer,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL,
    CONSTRAINT "damage_claims_claim_type_check" CHECK ((("claim_type")::"text" = ANY ((ARRAY['DAMAGED'::character varying, 'LOST'::character varying, 'STAINED'::character varying, 'SHRUNK'::character varying, 'OTHER'::character varying])::"text"[]))),
    CONSTRAINT "damage_claims_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['OPEN'::character varying, 'UNDER_REVIEW'::character varying, 'RESOLVED'::character varying, 'REJECTED'::character varying])::"text"[])))
);

CREATE TABLE IF NOT EXISTS "public"."deliveries" (
    "id" integer NOT NULL,
    "order_id" integer NOT NULL,
    "customer_id" integer NOT NULL,
    "delivery_type" character varying(50) DEFAULT 'FREE'::character varying NOT NULL,
    "delivery_revenue" integer DEFAULT 0,
    "delivery_cost" integer DEFAULT 0,
    "scheduled_date" "date",
    "scheduled_time_slot" character varying(50),
    "delivery_zone_id" integer,
    "driver_id" integer,
    "pickup_address" "text",
    "delivery_address" "text" NOT NULL,
    "delivery_status" character varying(50) DEFAULT 'PENDING'::character varying,
    "delivery_notes" "text",
    "delivery_person_name" character varying(255),
    "vehicle_info" character varying(255),
    "driver_name" character varying(255),
    "driver_phone" character varying(50),
    "notes" "text",
    "delivered_at" timestamp without time zone,
    "created_by" integer,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL,
    "payment_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "payment_method" character varying(50),
    "payment_status" character varying(50) DEFAULT 'PENDING'::character varying NOT NULL,
    "payment_date" timestamp without time zone,
    "payment_notes" "text"
);

CREATE TABLE IF NOT EXISTS "public"."delivery_drivers" (
    "id" integer NOT NULL,
    "name" character varying(255) NOT NULL,
    "phone" character varying(50) NOT NULL,
    "vehicle_type" character varying(100),
    "vehicle_number" character varying(100),
    "is_active" boolean DEFAULT true,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."delivery_zones" (
    "id" integer NOT NULL,
    "zone_name" character varying(255) NOT NULL,
    "zone_code" character varying(50) NOT NULL,
    "base_delivery_cost" integer DEFAULT 0,
    "description" "text",
    "is_active" boolean DEFAULT true,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."expense_categories" (
    "id" integer NOT NULL,
    "name" character varying(255) NOT NULL,
    "description" "text",
    "is_active" boolean DEFAULT true,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."expenses" (
    "id" integer NOT NULL,
    "expense_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "category" character varying(100) NOT NULL,
    "description" "text" NOT NULL,
    "amount" integer NOT NULL,
    "payment_method" character varying(50) DEFAULT 'CASH'::character varying,
    "receipt_number" character varying(100),
    "submitted_by" integer,
    "approved_by" integer,
    "status" character varying(50) DEFAULT 'PENDING'::character varying,
    "notes" "text",
    "approval_status" character varying(50) DEFAULT 'PENDING'::character varying,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "fiscal_year_id" integer,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL,
    "branch_id" integer,
    "rejected_by" integer,
    "rejected_at" timestamp without time zone,
    "approved_at" timestamp without time zone,
    "approval_notes" "text",
    "rejection_reason" "text",
    CONSTRAINT "expenses_amount_check" CHECK (("amount" >= 0))
);

CREATE TABLE IF NOT EXISTS "public"."inventory_items" (
    "id" integer NOT NULL,
    "item_name" character varying(255) NOT NULL,
    "category" character varying(100),
    "quantity" integer DEFAULT 0 NOT NULL,
    "unit" character varying(50),
    "unit_cost" integer DEFAULT 0,
    "reorder_level" integer DEFAULT 0,
    "max_stock_quantity" numeric(10,2),
    "expected_duration_value" numeric(10,2),
    "expected_duration_unit" character varying(20),
    "is_long_term" boolean DEFAULT false,
    "low_stock_threshold_percent" numeric(5,2) DEFAULT 20,
    "is_active" boolean DEFAULT true,
    "supplier" character varying(255),
    "notes" "text",
    "last_restocked" timestamp without time zone,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL,
    "asset_value" numeric(14,2),
    "asset_purchase_date" "date",
    "asset_serial_number" character varying(120),
    "asset_condition" character varying(40),
    "asset_location" character varying(200),
    "branch_id" integer,
    CONSTRAINT "inventory_items_expected_duration_unit_check" CHECK ((("expected_duration_unit")::"text" = ANY ((ARRAY['DAYS'::character varying, 'WEEKS'::character varying, 'MONTHS'::character varying, 'YEARS'::character varying])::"text"[]))),
    CONSTRAINT "inventory_items_quantity_check" CHECK (("quantity" >= 0))
);

CREATE TABLE IF NOT EXISTS "public"."inventory_transactions" (
    "id" integer NOT NULL,
    "item_id" integer NOT NULL,
    "transaction_type" character varying(50) NOT NULL,
    "quantity" integer NOT NULL,
    "unit_cost" integer,
    "notes" "text",
    "recorded_by" integer,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."notification_reads" (
    "notification_id" integer NOT NULL,
    "user_id" integer NOT NULL,
    "read_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" integer NOT NULL,
    "user_id" integer,
    "type" character varying(50) NOT NULL,
    "title" character varying(200) NOT NULL,
    "message" "text" NOT NULL,
    "data" "jsonb",
    "is_read" boolean DEFAULT false,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "read_at" timestamp without time zone,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL,
    "sender_id" integer,
    "link" character varying(255)
);

CREATE TABLE IF NOT EXISTS "public"."order_deletions" (
    "id" integer NOT NULL,
    "order_id" integer NOT NULL,
    "order_number" character varying(50),
    "customer_id" integer,
    "customer_name" character varying(255),
    "total_amount" integer,
    "amount_paid" integer,
    "balance" integer,
    "payment_status" character varying(20),
    "status" character varying(20),
    "created_at" timestamp without time zone,
    "cancelled_at" timestamp without time zone,
    "deleted_by" integer,
    "deleted_by_name" character varying(255),
    "deletion_reason" "text",
    "order_items" "jsonb",
    "payments" "jsonb",
    "deleted_at" timestamp without time zone DEFAULT "now"(),
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."order_items" (
    "id" integer NOT NULL,
    "order_id" integer NOT NULL,
    "price_item_id" integer NOT NULL,
    "service_type" character varying(10) NOT NULL,
    "quantity" integer DEFAULT 1 NOT NULL,
    "unit_price" integer NOT NULL,
    "total_price" integer NOT NULL,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL,
    "discount_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "notes" character varying(200),
    "surcharge_amount" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "order_items_service_type_check" CHECK ((("service_type")::"text" = ANY ((ARRAY['wash'::character varying, 'iron'::character varying, 'express'::character varying, 'WASH'::character varying, 'IRON'::character varying, 'EXPRESS'::character varying])::"text"[])))
);

CREATE TABLE IF NOT EXISTS "public"."orders" (
    "id" integer NOT NULL,
    "order_number" character varying(50) NOT NULL,
    "customer_id" integer NOT NULL,
    "user_id" integer NOT NULL,
    "status" "public"."order_status" DEFAULT 'pending'::"public"."order_status",
    "due_date" "date",
    "subtotal" integer DEFAULT 0 NOT NULL,
    "discount" integer DEFAULT 0 NOT NULL,
    "tax" integer DEFAULT 0 NOT NULL,
    "total" integer DEFAULT 0 NOT NULL,
    "notes" "text",
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "payment_status" character varying(50) DEFAULT 'UNPAID'::character varying,
    "payment_method" character varying(50),
    "amount_paid" integer DEFAULT 0,
    "total_amount" integer DEFAULT 0,
    "balance" integer DEFAULT 0,
    "pickup_date" "date",
    "transaction_reference" character varying(255),
    "invoice_number" character varying(50),
    "discount_percentage" numeric(5,2) DEFAULT 0,
    "discount_amount" integer DEFAULT 0,
    "tax_rate" numeric(5,2) DEFAULT 0,
    "tax_amount" integer DEFAULT 0,
    "order_status" character varying(50),
    "express_service" boolean DEFAULT false,
    "created_by" integer,
    "bargain_amount" integer DEFAULT 0,
    "fiscal_year_id" integer,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL,
    "branch_id" integer,
    "surcharge_amount" integer DEFAULT 0 NOT NULL,
    "is_backdated" boolean DEFAULT false NOT NULL,
    "recorded_at" timestamp without time zone,
    "catalogue_kg" numeric(10,2),
    "idempotency_key" "uuid",
    "delivered_at" timestamp without time zone,
    CONSTRAINT "orders_catalogue_kg_check" CHECK ((("catalogue_kg" IS NULL) OR ("catalogue_kg" > (0)::numeric)))
);

CREATE TABLE IF NOT EXISTS "public"."password_reset_requests" (
    "id" integer NOT NULL,
    "user_id" integer NOT NULL,
    "requested_at" timestamp without time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp without time zone,
    "resolved_by" integer,
    "status" character varying(20) DEFAULT 'PENDING'::character varying,
    "notes" "text",
    "created_at" timestamp without time zone DEFAULT "now"(),
    "updated_at" timestamp without time zone DEFAULT "now"(),
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."payments" (
    "id" integer NOT NULL,
    "order_id" integer NOT NULL,
    "customer_id" integer NOT NULL,
    "amount" integer NOT NULL,
    "payment_method" character varying(50) NOT NULL,
    "transaction_reference" character varying(255),
    "payment_date" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "notes" "text",
    "created_by" integer,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "is_refund" boolean DEFAULT false,
    "refund_reason" "text",
    "refunded_payment_id" integer,
    "refund_date" timestamp without time zone,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL,
    "is_cancelled" boolean DEFAULT false NOT NULL,
    "cancelled_at" timestamp without time zone,
    "cancelled_by" integer,
    "cancellation_reason" "text",
    CONSTRAINT "payments_amount_check" CHECK (("amount" > 0))
);

CREATE TABLE IF NOT EXISTS "public"."payroll_employees" (
    "id" integer NOT NULL,
    "employee_name" character varying(255) NOT NULL,
    "employee_id_number" character varying(100),
    "position" character varying(100) NOT NULL,
    "phone" character varying(20),
    "email" character varying(255),
    "salary_amount" numeric(12,2) NOT NULL,
    "payment_frequency" character varying(50) DEFAULT 'MONTHLY'::character varying,
    "bank_account" character varying(100),
    "bank_name" character varying(100),
    "hire_date" "date" NOT NULL,
    "employment_status" character varying(50) DEFAULT 'ACTIVE'::character varying,
    "added_by" integer NOT NULL,
    "notes" "text",
    "created_at" timestamp without time zone DEFAULT "now"(),
    "updated_at" timestamp without time zone DEFAULT "now"(),
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL,
    "branch_id" integer,
    CONSTRAINT "payroll_employees_payment_frequency_check" CHECK ((("payment_frequency")::"text" = ANY ((ARRAY['MONTHLY'::character varying, 'BI_WEEKLY'::character varying, 'WEEKLY'::character varying, 'DAILY'::character varying])::"text"[])))
);

CREATE TABLE IF NOT EXISTS "public"."pending_payments" (
    "id" integer NOT NULL,
    "transaction_reference" character varying(255) NOT NULL,
    "payment_method" character varying(100) NOT NULL,
    "amount" integer NOT NULL,
    "sender_phone" character varying(50) NOT NULL,
    "sender_name" character varying(255),
    "payment_date" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "status" character varying(50) DEFAULT 'PENDING'::character varying NOT NULL,
    "assigned_to_order_id" integer,
    "assigned_by" integer,
    "assigned_at" timestamp without time zone,
    "notes" "text",
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL,
    CONSTRAINT "pending_payments_amount_check" CHECK (("amount" > 0)),
    CONSTRAINT "pending_payments_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['PENDING'::character varying, 'ASSIGNED'::character varying, 'REJECTED'::character varying])::"text"[])))
);

CREATE TABLE IF NOT EXISTS "public"."refund_requests" (
    "id" integer NOT NULL,
    "order_id" integer NOT NULL,
    "requested_amount" integer NOT NULL,
    "refund_reason" "text" NOT NULL,
    "payment_method" character varying(50) DEFAULT 'CASH'::character varying,
    "transaction_reference" character varying(255),
    "notes" "text",
    "requested_by" integer NOT NULL,
    "requested_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "status" character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    "reviewed_by" integer,
    "reviewed_at" timestamp without time zone,
    "rejection_reason" "text",
    "refund_payment_id" integer,
    "cancel_order" boolean DEFAULT true,
    "target_payment_id" integer,
    "refund_type" character varying(50) DEFAULT 'transaction'::character varying,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL,
    CONSTRAINT "refund_requests_refund_reason_check" CHECK (("length"("refund_reason") >= 10)),
    CONSTRAINT "refund_requests_requested_amount_check" CHECK (("requested_amount" > 0)),
    CONSTRAINT "refund_requests_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['PENDING'::character varying, 'APPROVED'::character varying, 'REJECTED'::character varying])::"text"[])))
);

CREATE TABLE IF NOT EXISTS "public"."users" (
    "id" integer NOT NULL,
    "email" character varying(255) NOT NULL,
    "password" character varying(255) NOT NULL,
    "full_name" character varying(255) NOT NULL,
    "phone" character varying(50) NOT NULL,
    "role" "public"."user_role" DEFAULT 'USER'::"public"."user_role",
    "status" "public"."user_status" DEFAULT 'PENDING'::"public"."user_status",
    "created_by" integer,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "auth_provider" character varying(20) DEFAULT 'LOCAL'::character varying,
    "google_id" character varying(255),
    "google_photo" character varying(500),
    "last_login" timestamp without time zone,
    "password_changed_at" timestamp without time zone,
    "session_timeout_minutes" integer DEFAULT 15 NOT NULL,
    "profile_picture" character varying(500),
    "is_active" boolean DEFAULT true,
    "approved_at" timestamp without time zone,
    "approved_by" integer,
    "rejection_reason" "text",
    "rejected_at" timestamp without time zone,
    "rejected_by" integer,
    "deleted_at" timestamp without time zone,
    "max_bargain_amount" integer DEFAULT 0,
    "must_change_password" boolean DEFAULT false,
    "profile_picture_url" "text",
    "profile_picture_storage" "text",
    "profile_picture_migrated_at" timestamp with time zone,
    "failed_login_attempts" integer DEFAULT 0 NOT NULL,
    "account_locked_until" timestamp without time zone,
    "last_failed_login" timestamp without time zone,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL,
    "branch_id" integer,
    "max_item_bargain_amount" integer DEFAULT 0 NOT NULL,
    "is_super_admin" boolean DEFAULT false NOT NULL,
    "temporary_password_used_at" timestamp with time zone,
    "temporary_password_expires_at" timestamp with time zone,
    "temporary_password_login_attempts" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "users_profile_picture_storage_check" CHECK ((("profile_picture_storage" IS NULL) OR ("profile_picture_storage" = ANY (ARRAY['LOCAL'::"text", 'SUPABASE'::"text", 'EXTERNAL'::"text"])))),
    CONSTRAINT "users_session_timeout_minutes_check" CHECK ((("session_timeout_minutes" >= 5) AND ("session_timeout_minutes" <= 30)))
);

CREATE TABLE IF NOT EXISTS "public"."period_comparisons" (
    "id" integer NOT NULL,
    "report_type" character varying(50) NOT NULL,
    "period_1_start" "date" NOT NULL,
    "period_1_end" "date" NOT NULL,
    "period_2_start" "date" NOT NULL,
    "period_2_end" "date" NOT NULL,
    "metric_name" character varying(200) NOT NULL,
    "period_1_value" numeric(12,2),
    "period_2_value" numeric(12,2),
    "variance_amount" numeric(12,2),
    "variance_percentage" numeric(8,2),
    "generated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."price_items" (
    "id" integer NOT NULL,
    "item_id" character varying(50) NOT NULL,
    "name" character varying(255) NOT NULL,
    "category" "public"."price_category" NOT NULL,
    "subcategory" character varying(100),
    "price" integer DEFAULT 0 NOT NULL,
    "ironing_price" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "discount_percentage" numeric(5,2) DEFAULT 0,
    "discount_start_date" "date",
    "discount_end_date" "date",
    "express_price" integer,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL,
    "unit" character varying(20) DEFAULT 'piece'::character varying NOT NULL,
    "pricing_type" character varying(10) DEFAULT 'FIXED'::character varying NOT NULL,
    "price_per_kg" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "price_items_pricing_type_check" CHECK ((("pricing_type")::"text" = ANY ((ARRAY['FIXED'::character varying, 'PER_KG'::character varying])::"text"[])))
);

CREATE TABLE IF NOT EXISTS "public"."promotions" (
    "id" integer NOT NULL,
    "name" character varying(255) NOT NULL,
    "description" "text",
    "discount_percentage" numeric(5,2),
    "start_date" timestamp without time zone,
    "end_date" timestamp without time zone,
    "message" "text" NOT NULL,
    "status" character varying(20) DEFAULT 'PENDING'::character varying,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "created_by" integer,
    "sms_sent" boolean DEFAULT false,
    "sms_sent_at" timestamp without time zone,
    "is_active" boolean DEFAULT true,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."salary_payments" (
    "id" integer NOT NULL,
    "employee_id" integer,
    "payment_date" "date" NOT NULL,
    "payment_period" character varying(100) NOT NULL,
    "amount_paid" numeric(12,2) NOT NULL,
    "payment_method" character varying(50) NOT NULL,
    "transaction_reference" character varying(100),
    "deductions" numeric(12,2) DEFAULT 0,
    "bonuses" numeric(12,2) DEFAULT 0,
    "net_amount" numeric(12,2) NOT NULL,
    "paid_by" integer NOT NULL,
    "payment_status" character varying(50) DEFAULT 'PAID'::character varying,
    "notes" "text",
    "created_at" timestamp without time zone DEFAULT "now"(),
    "fiscal_year_id" integer,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."schema_patches" (
    "name" "text" NOT NULL,
    "applied_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."user_preferences" (
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL,
    "user_id" integer NOT NULL,
    "email_notifications" boolean DEFAULT true NOT NULL,
    "desktop_notifications" boolean DEFAULT false NOT NULL,
    "sound_alerts" boolean DEFAULT false NOT NULL,
    "in_app_notifications" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "public"."whatsapp_messages" (
    "id" integer NOT NULL,
    "customer_id" integer,
    "phone_number" character varying(20) NOT NULL,
    "message_text" "text" NOT NULL,
    "message_type" character varying(50) NOT NULL,
    "status" character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    "whatsapp_message_id" character varying(100),
    "cost_ugx" numeric(10,2) DEFAULT 193.00,
    "sent_at" timestamp without time zone DEFAULT "now"(),
    "delivered_at" timestamp without time zone,
    "read_at" timestamp without time zone,
    "error_message" "text",
    "is_bulk" boolean DEFAULT false,
    "campaign_name" character varying(255),
    "recipient_count" integer DEFAULT 0,
    "created_at" timestamp without time zone DEFAULT "now"(),
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."year_end_snapshots" (
    "id" integer NOT NULL,
    "fiscal_year_id" integer,
    "account_type" character varying(50) NOT NULL,
    "account_name" character varying(200) NOT NULL,
    "account_code" character varying(50),
    "closing_balance" numeric(12,2) NOT NULL,
    "debit_total" numeric(12,2) DEFAULT 0,
    "credit_total" numeric(12,2) DEFAULT 0,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" integer DEFAULT "public"."app_current_tenant_id"() NOT NULL
);

CREATE TABLE public.announcements (
 id SERIAL PRIMARY KEY,
 title VARCHAR(255) NOT NULL,
 message TEXT NOT NULL,
 customer_type VARCHAR(50) DEFAULT 'all',
 discount_percentage INTEGER DEFAULT 0,
 sent_by INTEGER,
 customers_reached INTEGER DEFAULT 0,
 customers_failed INTEGER DEFAULT 0,
 created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
 tenant_id INTEGER NOT NULL DEFAULT public.app_current_tenant_id()
);
CREATE TABLE public.scheduled_announcements (
 id SERIAL PRIMARY KEY,
 festival_name VARCHAR(255) NOT NULL,
 scheduled_date DATE NOT NULL,
 message TEXT NOT NULL,
 discount_percentage INTEGER DEFAULT 0,
 created_by INTEGER,
 status VARCHAR(50) DEFAULT 'pending',
 sent_at TIMESTAMP WITHOUT TIME ZONE,
 created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
 tenant_id INTEGER NOT NULL DEFAULT public.app_current_tenant_id()
);
CREATE TABLE public.security_audit_logs (
 id SERIAL PRIMARY KEY,
 user_id INTEGER,
 email VARCHAR(255),
 event_type VARCHAR(50) NOT NULL,
 ip_address VARCHAR(100),
 user_agent TEXT,
 event_details JSONB,
 created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
 tenant_id INTEGER NOT NULL DEFAULT public.app_current_tenant_id()
);

CREATE OR REPLACE FUNCTION "public"."app_current_user_id"() RETURNS integer
    LANGUAGE "sql" STABLE
    AS $$
  SELECT NULLIF(current_setting('app.current_user_id',TRUE),'')::INTEGER
$$;

CREATE OR REPLACE FUNCTION "public"."assign_fiscal_year"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- Find the fiscal year for this transaction date
  SELECT id INTO NEW.fiscal_year_id
  FROM fiscal_years
  WHERE NEW.created_at::DATE BETWEEN start_date AND end_date
  LIMIT 1;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."prevent_duplicate_salary_payment"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  PERFORM 1
    FROM payroll_employees
   WHERE id = NEW.employee_id
   FOR UPDATE;

  IF EXISTS (
    SELECT 1
      FROM salary_payments
     WHERE employee_id = NEW.employee_id
       AND payment_period = NEW.payment_period
  ) THEN
    RAISE EXCEPTION 'Payroll payment already exists for this employee and period'
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."prevent_order_overpayment"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  order_total NUMERIC;
  active_paid NUMERIC;
BEGIN
  SELECT COALESCE(total_amount, total, 0)
    INTO order_total
    FROM orders
   WHERE id = NEW.order_id
   FOR UPDATE;

  SELECT COALESCE(SUM(amount), 0)
    INTO active_paid
    FROM payments
   WHERE order_id = NEW.order_id
     AND (is_cancelled IS NULL OR is_cancelled = FALSE);

  IF active_paid + NEW.amount > order_total + 0.01 THEN
    RAISE EXCEPTION 'Payment exceeds order total';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."set_order_delivered_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NEW.status = 'delivered' AND OLD.status IS DISTINCT FROM 'delivered' THEN
    NEW.delivered_at := COALESCE(NEW.delivered_at, CURRENT_TIMESTAMP);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$;

CREATE SEQUENCE IF NOT EXISTS "public"."activity_logs_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."activity_logs_id_seq" OWNED BY "public"."activity_logs"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."audit_logs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."audit_logs_id_seq" OWNED BY "public"."audit_logs"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."automated_backup_dates_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."automated_backup_dates_id_seq" OWNED BY "public"."automated_backup_dates"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."automation_settings_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."automation_settings_id_seq" OWNED BY "public"."automation_settings"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."backup_attempts_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."backup_attempts_id_seq" OWNED BY "public"."backup_attempts"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."backup_email_settings_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."backup_email_settings_id_seq" OWNED BY "public"."backup_email_settings"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."backup_history_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."backup_history_id_seq" OWNED BY "public"."backup_history"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."branches_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."branches_id_seq" OWNED BY "public"."branches"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."business_settings_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."business_settings_id_seq" OWNED BY "public"."business_settings"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."customers_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."customers_id_seq" OWNED BY "public"."customers"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."damage_claims_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."damage_claims_id_seq" OWNED BY "public"."damage_claims"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."deliveries_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."deliveries_id_seq" OWNED BY "public"."deliveries"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."delivery_drivers_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."delivery_drivers_id_seq" OWNED BY "public"."delivery_drivers"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."delivery_zones_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."delivery_zones_id_seq" OWNED BY "public"."delivery_zones"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."expense_categories_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."expense_categories_id_seq" OWNED BY "public"."expense_categories"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."expenses_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."expenses_id_seq" OWNED BY "public"."expenses"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."fiscal_years_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."fiscal_years_id_seq" OWNED BY "public"."fiscal_years"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."inventory_items_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."inventory_items_id_seq" OWNED BY "public"."inventory_items"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."inventory_transactions_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."inventory_transactions_id_seq" OWNED BY "public"."inventory_transactions"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."notifications_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."notifications_id_seq" OWNED BY "public"."notifications"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."order_deletions_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."order_deletions_id_seq" OWNED BY "public"."order_deletions"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."order_items_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."order_items_id_seq" OWNED BY "public"."order_items"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."orders_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."orders_id_seq" OWNED BY "public"."orders"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."password_reset_requests_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."password_reset_requests_id_seq" OWNED BY "public"."password_reset_requests"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."payments_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."payments_id_seq" OWNED BY "public"."payments"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."payroll_employees_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."payroll_employees_id_seq" OWNED BY "public"."payroll_employees"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."pending_payments_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."pending_payments_id_seq" OWNED BY "public"."pending_payments"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."period_comparisons_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."period_comparisons_id_seq" OWNED BY "public"."period_comparisons"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."price_items_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."price_items_id_seq" OWNED BY "public"."price_items"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."promotions_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."promotions_id_seq" OWNED BY "public"."promotions"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."refund_requests_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."refund_requests_id_seq" OWNED BY "public"."refund_requests"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."salary_payments_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."salary_payments_id_seq" OWNED BY "public"."salary_payments"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."tenants_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."tenants_id_seq" OWNED BY "public"."tenants"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."users_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."users_id_seq" OWNED BY "public"."users"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."whatsapp_messages_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."whatsapp_messages_id_seq" OWNED BY "public"."whatsapp_messages"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."year_end_snapshots_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."year_end_snapshots_id_seq" OWNED BY "public"."year_end_snapshots"."id";

ALTER TABLE ONLY "public"."activity_logs" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."audit_logs" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."automated_backup_dates" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."automation_settings" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."backup_attempts" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."backup_email_settings" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."backup_history" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."branches" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."business_settings" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."fiscal_years" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."customers" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."damage_claims" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."deliveries" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."delivery_drivers" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."delivery_zones" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."expense_categories" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."expenses" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."inventory_items" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."inventory_transactions" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."notification_reads" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."notifications" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."order_deletions" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."order_items" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."orders" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."password_reset_requests" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."payments" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."payroll_employees" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."pending_payments" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."refund_requests" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."users" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."period_comparisons" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."price_items" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."promotions" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."salary_payments" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."user_preferences" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."whatsapp_messages" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."year_end_snapshots" FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY "public"."activity_logs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."activity_logs_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."audit_logs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."audit_logs_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."automated_backup_dates" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."automated_backup_dates_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."automation_settings" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."automation_settings_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."backup_attempts" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."backup_attempts_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."backup_email_settings" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."backup_email_settings_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."backup_history" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."backup_history_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."branches" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."branches_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."business_settings" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."business_settings_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."customers" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."customers_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."damage_claims" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."damage_claims_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."deliveries" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."deliveries_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."delivery_drivers" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."delivery_drivers_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."delivery_zones" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."delivery_zones_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."expense_categories" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."expense_categories_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."expenses" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."expenses_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."fiscal_years" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."fiscal_years_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."inventory_items" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."inventory_items_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."inventory_transactions" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."inventory_transactions_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."notifications" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."notifications_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."order_deletions" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."order_deletions_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."order_items" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."order_items_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."orders" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."orders_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."password_reset_requests" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."password_reset_requests_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."payments" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."payments_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."payroll_employees" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."payroll_employees_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."pending_payments" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."pending_payments_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."period_comparisons" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."period_comparisons_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."price_items" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."price_items_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."promotions" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."promotions_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."refund_requests" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."refund_requests_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."salary_payments" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."salary_payments_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."tenants" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."tenants_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."users" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."users_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."whatsapp_messages" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."whatsapp_messages_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."year_end_snapshots" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."year_end_snapshots_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."activity_logs"
    ADD CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."automated_backup_dates"
    ADD CONSTRAINT "automated_backup_dates_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."automation_settings"
    ADD CONSTRAINT "automation_settings_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."backup_attempts"
    ADD CONSTRAINT "backup_attempts_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."backup_email_settings"
    ADD CONSTRAINT "backup_email_settings_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."backup_history"
    ADD CONSTRAINT "backup_history_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."branches"
    ADD CONSTRAINT "branches_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."business_settings"
    ADD CONSTRAINT "business_settings_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."damage_claims"
    ADD CONSTRAINT "damage_claims_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."deliveries"
    ADD CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."delivery_drivers"
    ADD CONSTRAINT "delivery_drivers_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."delivery_zones"
    ADD CONSTRAINT "delivery_zones_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."expense_categories"
    ADD CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."fiscal_years"
    ADD CONSTRAINT "fiscal_years_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."inventory_transactions"
    ADD CONSTRAINT "inventory_transactions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."notification_reads"
    ADD CONSTRAINT "notification_reads_pkey" PRIMARY KEY ("notification_id", "user_id");

ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."order_deletions"
    ADD CONSTRAINT "order_deletions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."password_reset_requests"
    ADD CONSTRAINT "password_reset_requests_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."password_reset_requests"
    ADD CONSTRAINT "password_reset_requests_user_id_key" UNIQUE ("user_id");

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."payroll_employees"
    ADD CONSTRAINT "payroll_employees_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."pending_payments"
    ADD CONSTRAINT "pending_payments_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."period_comparisons"
    ADD CONSTRAINT "period_comparisons_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."price_items"
    ADD CONSTRAINT "price_items_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."promotions"
    ADD CONSTRAINT "promotions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."refund_requests"
    ADD CONSTRAINT "refund_requests_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."salary_payments"
    ADD CONSTRAINT "salary_payments_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."schema_patches"
    ADD CONSTRAINT "schema_patches_pkey" PRIMARY KEY ("name");

ALTER TABLE ONLY "public"."tenants"
    ADD CONSTRAINT "tenants_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."tenants"
    ADD CONSTRAINT "tenants_tenant_slug_key" UNIQUE ("tenant_slug");

ALTER TABLE ONLY "public"."price_items"
    ADD CONSTRAINT "unique_name_per_tenant_category" UNIQUE ("tenant_id", "category", "name");

ALTER TABLE ONLY "public"."user_preferences"
    ADD CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("tenant_id", "user_id");

ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."whatsapp_messages"
    ADD CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."year_end_snapshots"
    ADD CONSTRAINT "year_end_snapshots_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."activity_logs"
    ADD CONSTRAINT "activity_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."activity_logs"
    ADD CONSTRAINT "activity_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id");

ALTER TABLE ONLY "public"."automated_backup_dates"
    ADD CONSTRAINT "automated_backup_dates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."automation_settings"
    ADD CONSTRAINT "automation_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."automation_settings"
    ADD CONSTRAINT "automation_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");

ALTER TABLE ONLY "public"."backup_attempts"
    ADD CONSTRAINT "backup_attempts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."backup_email_settings"
    ADD CONSTRAINT "backup_email_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."backup_history"
    ADD CONSTRAINT "backup_history_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."branches"
    ADD CONSTRAINT "branches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."business_settings"
    ADD CONSTRAINT "business_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."business_settings"
    ADD CONSTRAINT "business_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id");

ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."damage_claims"
    ADD CONSTRAINT "damage_claims_logged_by_fkey" FOREIGN KEY ("logged_by") REFERENCES "public"."users"("id");

ALTER TABLE ONLY "public"."damage_claims"
    ADD CONSTRAINT "damage_claims_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."damage_claims"
    ADD CONSTRAINT "damage_claims_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id");

ALTER TABLE ONLY "public"."damage_claims"
    ADD CONSTRAINT "damage_claims_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."deliveries"
    ADD CONSTRAINT "deliveries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");

ALTER TABLE ONLY "public"."deliveries"
    ADD CONSTRAINT "deliveries_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."deliveries"
    ADD CONSTRAINT "deliveries_delivery_zone_id_fkey" FOREIGN KEY ("delivery_zone_id") REFERENCES "public"."delivery_zones"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."deliveries"
    ADD CONSTRAINT "deliveries_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."delivery_drivers"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."deliveries"
    ADD CONSTRAINT "deliveries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."deliveries"
    ADD CONSTRAINT "deliveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."delivery_drivers"
    ADD CONSTRAINT "delivery_drivers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."delivery_zones"
    ADD CONSTRAINT "delivery_zones_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."expense_categories"
    ADD CONSTRAINT "expense_categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_fiscal_year_id_fkey" FOREIGN KEY ("fiscal_year_id") REFERENCES "public"."fiscal_years"("id");

ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_rejected_by_fkey" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id");

ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."fiscal_years"
    ADD CONSTRAINT "fiscal_years_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id");

ALTER TABLE ONLY "public"."fiscal_years"
    ADD CONSTRAINT "fiscal_years_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."inventory_transactions"
    ADD CONSTRAINT "inventory_transactions_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."inventory_transactions"
    ADD CONSTRAINT "inventory_transactions_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id");

ALTER TABLE ONLY "public"."inventory_transactions"
    ADD CONSTRAINT "inventory_transactions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."notification_reads"
    ADD CONSTRAINT "notification_reads_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."notification_reads"
    ADD CONSTRAINT "notification_reads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."notification_reads"
    ADD CONSTRAINT "notification_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."order_deletions"
    ADD CONSTRAINT "order_deletions_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id");

ALTER TABLE ONLY "public"."order_deletions"
    ADD CONSTRAINT "order_deletions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_price_item_id_fkey" FOREIGN KEY ("price_item_id") REFERENCES "public"."price_items"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id");

ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");

ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_fiscal_year_id_fkey" FOREIGN KEY ("fiscal_year_id") REFERENCES "public"."fiscal_years"("id");

ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."password_reset_requests"
    ADD CONSTRAINT "password_reset_requests_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id");

ALTER TABLE ONLY "public"."password_reset_requests"
    ADD CONSTRAINT "password_reset_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."password_reset_requests"
    ADD CONSTRAINT "password_reset_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_refunded_payment_id_fkey" FOREIGN KEY ("refunded_payment_id") REFERENCES "public"."payments"("id");

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."payroll_employees"
    ADD CONSTRAINT "payroll_employees_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id");

ALTER TABLE ONLY "public"."payroll_employees"
    ADD CONSTRAINT "payroll_employees_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."payroll_employees"
    ADD CONSTRAINT "payroll_employees_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."pending_payments"
    ADD CONSTRAINT "pending_payments_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."pending_payments"
    ADD CONSTRAINT "pending_payments_assigned_to_order_id_fkey" FOREIGN KEY ("assigned_to_order_id") REFERENCES "public"."orders"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."pending_payments"
    ADD CONSTRAINT "pending_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."period_comparisons"
    ADD CONSTRAINT "period_comparisons_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."price_items"
    ADD CONSTRAINT "price_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."promotions"
    ADD CONSTRAINT "promotions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");

ALTER TABLE ONLY "public"."promotions"
    ADD CONSTRAINT "promotions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."refund_requests"
    ADD CONSTRAINT "refund_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."refund_requests"
    ADD CONSTRAINT "refund_requests_refund_payment_id_fkey" FOREIGN KEY ("refund_payment_id") REFERENCES "public"."payments"("id");

ALTER TABLE ONLY "public"."refund_requests"
    ADD CONSTRAINT "refund_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id");

ALTER TABLE ONLY "public"."refund_requests"
    ADD CONSTRAINT "refund_requests_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id");

ALTER TABLE ONLY "public"."refund_requests"
    ADD CONSTRAINT "refund_requests_target_payment_id_fkey" FOREIGN KEY ("target_payment_id") REFERENCES "public"."payments"("id");

ALTER TABLE ONLY "public"."refund_requests"
    ADD CONSTRAINT "refund_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."salary_payments"
    ADD CONSTRAINT "salary_payments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."payroll_employees"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."salary_payments"
    ADD CONSTRAINT "salary_payments_fiscal_year_id_fkey" FOREIGN KEY ("fiscal_year_id") REFERENCES "public"."fiscal_years"("id");

ALTER TABLE ONLY "public"."salary_payments"
    ADD CONSTRAINT "salary_payments_paid_by_fkey" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id");

ALTER TABLE ONLY "public"."salary_payments"
    ADD CONSTRAINT "salary_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."user_preferences"
    ADD CONSTRAINT "user_preferences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."user_preferences"
    ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id");

ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id");

ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_rejected_by_fkey" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id");

ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."whatsapp_messages"
    ADD CONSTRAINT "whatsapp_messages_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."whatsapp_messages"
    ADD CONSTRAINT "whatsapp_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY "public"."year_end_snapshots"
    ADD CONSTRAINT "year_end_snapshots_fiscal_year_id_fkey" FOREIGN KEY ("fiscal_year_id") REFERENCES "public"."fiscal_years"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."year_end_snapshots"
    ADD CONSTRAINT "year_end_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE "public"."activity_logs" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."audit_logs" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."automated_backup_dates" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."automation_settings" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."backup_attempts" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."backup_email_settings" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."backup_history" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."branches" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."business_settings" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."customers" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."damage_claims" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."deliveries" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."delivery_drivers" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."delivery_zones" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."expense_categories" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."expenses" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."fiscal_years" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."inventory_items" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."inventory_transactions" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."notification_reads" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."order_deletions" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."order_items" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."password_reset_requests" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."payroll_employees" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."pending_payments" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."period_comparisons" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."price_items" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."promotions" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."refund_requests" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."salary_payments" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."schema_patches" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."tenants" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."user_preferences" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."whatsapp_messages" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."year_end_snapshots" ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX "automated_backup_dates_tenant_date_key" ON "public"."automated_backup_dates" USING "btree" ("tenant_id", "backup_date");

CREATE UNIQUE INDEX "automation_settings_tenant_setting_key_key" ON "public"."automation_settings" USING "btree" ("tenant_id", "setting_key");

CREATE UNIQUE INDEX "backup_email_settings_tenant_key" ON "public"."backup_email_settings" USING "btree" ("tenant_id");

CREATE UNIQUE INDEX "branches_tenant_code_key" ON "public"."branches" USING "btree" ("tenant_id", "code");

CREATE UNIQUE INDEX "business_settings_tenant_setting_key_key" ON "public"."business_settings" USING "btree" ("tenant_id", "setting_key");

CREATE UNIQUE INDEX "customers_tenant_customer_id_key" ON "public"."customers" USING "btree" ("tenant_id", "customer_id");

CREATE UNIQUE INDEX "delivery_zones_tenant_zone_code_key" ON "public"."delivery_zones" USING "btree" ("tenant_id", "zone_code");

CREATE UNIQUE INDEX "expense_categories_tenant_name_key" ON "public"."expense_categories" USING "btree" ("tenant_id", "name");

CREATE UNIQUE INDEX "fiscal_years_tenant_period_key" ON "public"."fiscal_years" USING "btree" ("tenant_id", "start_date", "end_date");

ALTER TABLE public.announcements ADD CONSTRAINT announcements_sent_by_fkey
 FOREIGN KEY (sent_by) REFERENCES public.users(id);
ALTER TABLE public.announcements ADD CONSTRAINT announcements_tenant_id_fkey
 FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;
ALTER TABLE public.scheduled_announcements ADD CONSTRAINT scheduled_announcements_created_by_fkey
 FOREIGN KEY (created_by) REFERENCES public.users(id);
ALTER TABLE public.scheduled_announcements ADD CONSTRAINT scheduled_announcements_tenant_id_fkey
 FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;
ALTER TABLE public.security_audit_logs ADD CONSTRAINT security_audit_logs_user_id_fkey
 FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.security_audit_logs ADD CONSTRAINT security_audit_logs_tenant_id_fkey
 FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;

CREATE INDEX "idx_activity_logs_action" ON "public"."activity_logs" USING "btree" ("action");

CREATE INDEX "idx_activity_logs_created_at" ON "public"."activity_logs" USING "btree" ("created_at" DESC);

CREATE INDEX "idx_activity_logs_resource" ON "public"."activity_logs" USING "btree" ("resource_type", "resource_id");

CREATE INDEX "idx_activity_logs_severity" ON "public"."activity_logs" USING "btree" ("severity");

CREATE INDEX "idx_activity_logs_tenant_id" ON "public"."activity_logs" USING "btree" ("tenant_id");

CREATE INDEX "idx_activity_logs_user_id" ON "public"."activity_logs" USING "btree" ("user_id");

CREATE INDEX "idx_audit_logs_created_at" ON "public"."audit_logs" USING "btree" ("created_at");

CREATE INDEX "idx_audit_logs_operation" ON "public"."audit_logs" USING "btree" ("operation");

CREATE INDEX "idx_audit_logs_tenant_id" ON "public"."audit_logs" USING "btree" ("tenant_id");

CREATE INDEX "idx_automated_backup_dates_tenant_id" ON "public"."automated_backup_dates" USING "btree" ("tenant_id");

CREATE INDEX "idx_automation_settings_key" ON "public"."automation_settings" USING "btree" ("setting_key");

CREATE INDEX "idx_automation_settings_tenant_id" ON "public"."automation_settings" USING "btree" ("tenant_id");

CREATE INDEX "idx_backup_attempts_started_at" ON "public"."backup_attempts" USING "btree" ("started_at" DESC);

CREATE INDEX "idx_backup_attempts_status" ON "public"."backup_attempts" USING "btree" ("status");

CREATE INDEX "idx_backup_attempts_tenant_id" ON "public"."backup_attempts" USING "btree" ("tenant_id");

CREATE INDEX "idx_backup_email_settings_tenant_id" ON "public"."backup_email_settings" USING "btree" ("tenant_id");

CREATE INDEX "idx_backup_history_tenant_id" ON "public"."backup_history" USING "btree" ("tenant_id");

CREATE INDEX "idx_branches_tenant_id" ON "public"."branches" USING "btree" ("tenant_id");

CREATE INDEX "idx_business_settings_key" ON "public"."business_settings" USING "btree" ("setting_key");

CREATE INDEX "idx_business_settings_tenant_id" ON "public"."business_settings" USING "btree" ("tenant_id");

CREATE INDEX "idx_customers_customer_id" ON "public"."customers" USING "btree" ("customer_id");

CREATE INDEX "idx_customers_phone" ON "public"."customers" USING "btree" ("phone");

CREATE INDEX "idx_customers_tenant_id" ON "public"."customers" USING "btree" ("tenant_id");

CREATE INDEX "idx_damage_claims_tenant_id" ON "public"."damage_claims" USING "btree" ("tenant_id");

CREATE INDEX "idx_deliveries_delivery_status" ON "public"."deliveries" USING "btree" ("delivery_status");

CREATE INDEX "idx_deliveries_delivery_type" ON "public"."deliveries" USING "btree" ("delivery_type");

CREATE INDEX "idx_deliveries_order_id" ON "public"."deliveries" USING "btree" ("order_id");

CREATE INDEX "idx_deliveries_payment_status" ON "public"."deliveries" USING "btree" ("payment_status");

CREATE INDEX "idx_deliveries_scheduled_date" ON "public"."deliveries" USING "btree" ("scheduled_date");

CREATE INDEX "idx_deliveries_tenant_id" ON "public"."deliveries" USING "btree" ("tenant_id");

CREATE INDEX "idx_delivery_drivers_active" ON "public"."delivery_drivers" USING "btree" ("is_active");

CREATE INDEX "idx_delivery_drivers_tenant_id" ON "public"."delivery_drivers" USING "btree" ("tenant_id");

CREATE INDEX "idx_delivery_zones_active" ON "public"."delivery_zones" USING "btree" ("is_active");

CREATE INDEX "idx_delivery_zones_tenant_id" ON "public"."delivery_zones" USING "btree" ("tenant_id");

CREATE INDEX "idx_expense_categories_active" ON "public"."expense_categories" USING "btree" ("is_active");

CREATE INDEX "idx_expense_categories_tenant_id" ON "public"."expense_categories" USING "btree" ("tenant_id");

CREATE INDEX "idx_expenses_branch_id" ON "public"."expenses" USING "btree" ("branch_id");

CREATE INDEX "idx_expenses_category" ON "public"."expenses" USING "btree" ("category");

CREATE INDEX "idx_expenses_date" ON "public"."expenses" USING "btree" ("expense_date");

CREATE INDEX "idx_expenses_fiscal_year" ON "public"."expenses" USING "btree" ("fiscal_year_id");

CREATE INDEX "idx_expenses_status" ON "public"."expenses" USING "btree" ("status");

CREATE INDEX "idx_expenses_submitted_by" ON "public"."expenses" USING "btree" ("submitted_by");

CREATE INDEX "idx_expenses_tenant_id" ON "public"."expenses" USING "btree" ("tenant_id");

CREATE INDEX "idx_fiscal_years_dates" ON "public"."fiscal_years" USING "btree" ("start_date", "end_date");

CREATE INDEX "idx_fiscal_years_status" ON "public"."fiscal_years" USING "btree" ("status");

CREATE INDEX "idx_fiscal_years_tenant_id" ON "public"."fiscal_years" USING "btree" ("tenant_id");

CREATE INDEX "idx_inventory_items_active" ON "public"."inventory_items" USING "btree" ("is_active");

CREATE INDEX "idx_inventory_items_branch_id" ON "public"."inventory_items" USING "btree" ("branch_id");

CREATE INDEX "idx_inventory_items_category" ON "public"."inventory_items" USING "btree" ("category");

CREATE INDEX "idx_inventory_items_quantity" ON "public"."inventory_items" USING "btree" ("quantity");

CREATE INDEX "idx_inventory_items_tenant_id" ON "public"."inventory_items" USING "btree" ("tenant_id");

CREATE INDEX "idx_inventory_transactions_item_id" ON "public"."inventory_transactions" USING "btree" ("item_id");

CREATE INDEX "idx_inventory_transactions_tenant_id" ON "public"."inventory_transactions" USING "btree" ("tenant_id");

CREATE INDEX "idx_inventory_transactions_type" ON "public"."inventory_transactions" USING "btree" ("transaction_type");

CREATE INDEX "idx_notification_reads_tenant_id" ON "public"."notification_reads" USING "btree" ("tenant_id");

CREATE INDEX "idx_notification_reads_user" ON "public"."notification_reads" USING "btree" ("user_id");

CREATE INDEX "idx_notifications_created_at" ON "public"."notifications" USING "btree" ("created_at" DESC);

CREATE INDEX "idx_notifications_is_read" ON "public"."notifications" USING "btree" ("is_read");

CREATE INDEX "idx_notifications_tenant_id" ON "public"."notifications" USING "btree" ("tenant_id");

CREATE INDEX "idx_notifications_user_id" ON "public"."notifications" USING "btree" ("user_id");

CREATE INDEX "idx_notifications_user_unread" ON "public"."notifications" USING "btree" ("user_id", "is_read");

CREATE INDEX "idx_order_deletions_tenant_id" ON "public"."order_deletions" USING "btree" ("tenant_id");

CREATE INDEX "idx_order_items_order_id" ON "public"."order_items" USING "btree" ("order_id");

CREATE INDEX "idx_order_items_tenant_id" ON "public"."order_items" USING "btree" ("tenant_id");

CREATE INDEX "idx_orders_branch_id" ON "public"."orders" USING "btree" ("branch_id");

CREATE INDEX "idx_orders_created_at" ON "public"."orders" USING "btree" ("created_at");

CREATE INDEX "idx_orders_customer_id" ON "public"."orders" USING "btree" ("customer_id");

CREATE INDEX "idx_orders_fiscal_year" ON "public"."orders" USING "btree" ("fiscal_year_id");

CREATE INDEX "idx_orders_is_backdated" ON "public"."orders" USING "btree" ("is_backdated");

CREATE INDEX "idx_orders_status" ON "public"."orders" USING "btree" ("status");

CREATE INDEX "idx_orders_tenant_delivered_at" ON "public"."orders" USING "btree" ("tenant_id", "delivered_at") WHERE ("delivered_at" IS NOT NULL);

CREATE INDEX "idx_orders_tenant_id" ON "public"."orders" USING "btree" ("tenant_id");

CREATE INDEX "idx_orders_user_id" ON "public"."orders" USING "btree" ("user_id");

CREATE INDEX "idx_password_reset_requests_resolved_at" ON "public"."password_reset_requests" USING "btree" ("resolved_at");

CREATE INDEX "idx_password_reset_requests_status" ON "public"."password_reset_requests" USING "btree" ("status");

CREATE INDEX "idx_password_reset_requests_tenant_id" ON "public"."password_reset_requests" USING "btree" ("tenant_id");

CREATE INDEX "idx_password_reset_requests_user_id" ON "public"."password_reset_requests" USING "btree" ("user_id");

CREATE INDEX "idx_payments_customer_id" ON "public"."payments" USING "btree" ("customer_id");

CREATE INDEX "idx_payments_is_refund" ON "public"."payments" USING "btree" ("is_refund");

CREATE INDEX "idx_payments_order_id" ON "public"."payments" USING "btree" ("order_id");

CREATE INDEX "idx_payments_payment_date" ON "public"."payments" USING "btree" ("payment_date");

CREATE INDEX "idx_payments_refunded_payment_id" ON "public"."payments" USING "btree" ("refunded_payment_id");

CREATE INDEX "idx_payments_tenant_id" ON "public"."payments" USING "btree" ("tenant_id");

CREATE INDEX "idx_payroll_employees_branch_id" ON "public"."payroll_employees" USING "btree" ("branch_id");

CREATE INDEX "idx_payroll_employees_id_number" ON "public"."payroll_employees" USING "btree" ("employee_id_number");

CREATE INDEX "idx_payroll_employees_status" ON "public"."payroll_employees" USING "btree" ("employment_status");

CREATE INDEX "idx_payroll_employees_tenant_id" ON "public"."payroll_employees" USING "btree" ("tenant_id");

CREATE INDEX "idx_pending_payments_payment_date" ON "public"."pending_payments" USING "btree" ("payment_date");

CREATE INDEX "idx_pending_payments_sender_phone" ON "public"."pending_payments" USING "btree" ("sender_phone");

CREATE INDEX "idx_pending_payments_status" ON "public"."pending_payments" USING "btree" ("status");

CREATE INDEX "idx_pending_payments_tenant_id" ON "public"."pending_payments" USING "btree" ("tenant_id");

CREATE INDEX "idx_pending_payments_transaction_ref" ON "public"."pending_payments" USING "btree" ("transaction_reference");

CREATE INDEX "idx_period_comparisons_tenant_id" ON "public"."period_comparisons" USING "btree" ("tenant_id");

CREATE INDEX "idx_price_items_category" ON "public"."price_items" USING "btree" ("category");

CREATE INDEX "idx_price_items_is_active" ON "public"."price_items" USING "btree" ("is_active");

CREATE INDEX "idx_price_items_tenant_id" ON "public"."price_items" USING "btree" ("tenant_id");

CREATE INDEX "idx_promotions_dates" ON "public"."promotions" USING "btree" ("start_date", "end_date");

CREATE INDEX "idx_promotions_status" ON "public"."promotions" USING "btree" ("status");

CREATE INDEX "idx_promotions_tenant_id" ON "public"."promotions" USING "btree" ("tenant_id");

CREATE INDEX "idx_refund_requests_order_id" ON "public"."refund_requests" USING "btree" ("order_id");

CREATE INDEX "idx_refund_requests_requested_at" ON "public"."refund_requests" USING "btree" ("requested_at" DESC);

CREATE INDEX "idx_refund_requests_requested_by" ON "public"."refund_requests" USING "btree" ("requested_by");

CREATE INDEX "idx_refund_requests_reviewed_by" ON "public"."refund_requests" USING "btree" ("reviewed_by");

CREATE INDEX "idx_refund_requests_status" ON "public"."refund_requests" USING "btree" ("status");

CREATE INDEX "idx_refund_requests_tenant_id" ON "public"."refund_requests" USING "btree" ("tenant_id");

CREATE INDEX "idx_salary_payments_date" ON "public"."salary_payments" USING "btree" ("payment_date");

CREATE INDEX "idx_salary_payments_employee" ON "public"."salary_payments" USING "btree" ("employee_id");

CREATE INDEX "idx_salary_payments_period" ON "public"."salary_payments" USING "btree" ("payment_period");

CREATE INDEX "idx_salary_payments_tenant_id" ON "public"."salary_payments" USING "btree" ("tenant_id");

CREATE UNIQUE INDEX "idx_tenants_single_default" ON "public"."tenants" USING "btree" ("is_default") WHERE ("is_default" = true);

CREATE INDEX "idx_users_branch_id" ON "public"."users" USING "btree" ("branch_id");

CREATE INDEX "idx_users_email" ON "public"."users" USING "btree" ("email");

CREATE INDEX "idx_users_profile_picture_url" ON "public"."users" USING "btree" ("profile_picture_url") WHERE ("profile_picture_url" IS NOT NULL);

CREATE INDEX "idx_users_role" ON "public"."users" USING "btree" ("role");

CREATE INDEX "idx_users_status" ON "public"."users" USING "btree" ("status");

CREATE INDEX "idx_users_tenant_id" ON "public"."users" USING "btree" ("tenant_id");

CREATE INDEX "idx_whatsapp_messages_customer_id" ON "public"."whatsapp_messages" USING "btree" ("customer_id");

CREATE INDEX "idx_whatsapp_messages_sent_at" ON "public"."whatsapp_messages" USING "btree" ("sent_at" DESC);

CREATE INDEX "idx_whatsapp_messages_status" ON "public"."whatsapp_messages" USING "btree" ("status");

CREATE INDEX "idx_whatsapp_messages_tenant_id" ON "public"."whatsapp_messages" USING "btree" ("tenant_id");

CREATE INDEX "idx_whatsapp_messages_whatsapp_id" ON "public"."whatsapp_messages" USING "btree" ("whatsapp_message_id");

CREATE INDEX "idx_year_end_snapshots_fiscal_year" ON "public"."year_end_snapshots" USING "btree" ("fiscal_year_id");

CREATE INDEX "idx_year_end_snapshots_tenant_id" ON "public"."year_end_snapshots" USING "btree" ("tenant_id");

CREATE UNIQUE INDEX "inventory_items_tenant_item_name_key" ON "public"."inventory_items" USING "btree" ("tenant_id", "item_name");

CREATE UNIQUE INDEX "orders_tenant_order_number_key" ON "public"."orders" USING "btree" ("tenant_id", "order_number");

CREATE UNIQUE INDEX "orders_tenant_user_idempotency_key" ON "public"."orders" USING "btree" ("tenant_id", "user_id", "idempotency_key") WHERE ("idempotency_key" IS NOT NULL);

CREATE UNIQUE INDEX "payroll_employees_tenant_employee_number_key" ON "public"."payroll_employees" USING "btree" ("tenant_id", "employee_id_number");

CREATE UNIQUE INDEX "pending_payments_tenant_transaction_reference_key" ON "public"."pending_payments" USING "btree" ("tenant_id", "transaction_reference") WHERE ("transaction_reference" IS NOT NULL);

CREATE UNIQUE INDEX "price_items_tenant_item_id_key" ON "public"."price_items" USING "btree" ("tenant_id", "item_id");

CREATE UNIQUE INDEX "user_preferences_user_id_legacy_key" ON "public"."user_preferences" USING "btree" ("user_id");

CREATE UNIQUE INDEX "users_tenant_email_key" ON "public"."users" USING "btree" ("tenant_id", "email");

CREATE UNIQUE INDEX "users_tenant_google_id_key" ON "public"."users" USING "btree" ("tenant_id", "google_id") WHERE ("google_id" IS NOT NULL);

CREATE INDEX idx_announcements_tenant_created ON public.announcements(tenant_id, created_at DESC);
CREATE INDEX idx_scheduled_announcements_tenant_date ON public.scheduled_announcements(tenant_id, scheduled_date);
CREATE INDEX idx_scheduled_announcements_tenant_status ON public.scheduled_announcements(tenant_id, status);
CREATE INDEX idx_security_audit_logs_tenant_user ON public.security_audit_logs(tenant_id, user_id);
CREATE INDEX idx_security_audit_logs_tenant_event ON public.security_audit_logs(tenant_id, event_type);
CREATE INDEX idx_security_audit_logs_tenant_created ON public.security_audit_logs(tenant_id, created_at DESC);

CREATE OR REPLACE VIEW "public"."current_fiscal_year" WITH ("security_invoker"='true') AS
 SELECT "id",
    "year_name",
    "start_date",
    "end_date",
    "status",
    "closing_date",
    "closed_by",
    "opening_balance",
    "closing_balance",
    "net_profit",
    "retained_earnings",
    "notes",
    "created_at"
   FROM "public"."fiscal_years"
  WHERE ((("status")::"text" = 'OPEN'::"text") AND ("start_date" <= CURRENT_DATE) AND ("end_date" >= CURRENT_DATE))
  ORDER BY "start_date" DESC
 LIMIT 1;

CREATE OR REPLACE VIEW "public"."pending_refund_requests" WITH ("security_invoker"='true') AS
 SELECT "rr"."id",
    "rr"."order_id",
    "o"."order_number",
    "rr"."requested_amount",
    "rr"."refund_reason",
    "rr"."payment_method",
    "rr"."transaction_reference",
    "rr"."notes",
    "rr"."status",
    "rr"."requested_at",
    "rr"."cancel_order",
    "u_requester"."email" AS "requested_by_email",
    "u_requester"."full_name" AS "requested_by_name",
    "u_requester"."role" AS "requested_by_role",
    "o"."total_amount" AS "order_total",
    "o"."amount_paid" AS "order_amount_paid",
    "o"."balance" AS "order_balance",
    "o"."payment_status" AS "order_payment_status",
    "o"."status" AS "order_status",
    "c"."name" AS "customer_name",
    "c"."phone" AS "customer_phone",
    "c"."email" AS "customer_email",
    ("o"."amount_paid" - COALESCE(( SELECT "sum"("abs"("payments"."amount")) AS "sum"
           FROM "public"."payments"
          WHERE (("payments"."order_id" = "o"."id") AND ("payments"."is_refund" = true))), (0)::bigint)) AS "available_for_refund",
        CASE
            WHEN ("rr"."requested_amount" <= ("o"."amount_paid" - COALESCE(( SELECT "sum"("abs"("payments"."amount")) AS "sum"
               FROM "public"."payments"
              WHERE (("payments"."order_id" = "o"."id") AND ("payments"."is_refund" = true))), (0)::bigint))) THEN true
            ELSE false
        END AS "is_valid_amount"
   FROM ((("public"."refund_requests" "rr"
     JOIN "public"."orders" "o" ON (("rr"."order_id" = "o"."id")))
     JOIN "public"."customers" "c" ON (("o"."customer_id" = "c"."id")))
     JOIN "public"."users" "u_requester" ON (("rr"."requested_by" = "u_requester"."id")))
  WHERE (("rr"."status")::"text" = 'PENDING'::"text")
  ORDER BY "rr"."requested_at";

CREATE OR REPLACE VIEW "public"."users_profile_picture_status" WITH ("security_invoker"='true') AS
 SELECT "id",
    "email",
    "profile_picture",
    "profile_picture_url",
    COALESCE("profile_picture_url", ("profile_picture")::"text") AS "effective_profile_picture",
    "profile_picture_storage"
   FROM "public"."users";

ALTER VIEW public.current_fiscal_year SET (security_invoker=true);
ALTER VIEW public.pending_refund_requests SET (security_invoker=true);
ALTER VIEW public.users_profile_picture_status SET (security_invoker=true);

ALTER TABLE public."activity_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."activity_logs" FORCE ROW LEVEL SECURITY;
SELECT setval(pg_get_serial_sequence('public.tenants','id'),1,TRUE);

DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='soth_app') THEN
  CREATE ROLE soth_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 ELSE
  ALTER ROLE soth_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 END IF;
END $$;

CREATE POLICY "activity_logs_tenant_isolation_policy" ON public."activity_logs" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "audit_logs_tenant_isolation_policy" ON public."audit_logs" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."automated_backup_dates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."automated_backup_dates" FORCE ROW LEVEL SECURITY;
CREATE POLICY "automated_backup_dates_tenant_isolation_policy" ON public."automated_backup_dates" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."automation_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."automation_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "automation_settings_tenant_isolation_policy" ON public."automation_settings" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."backup_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."backup_attempts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "backup_attempts_tenant_isolation_policy" ON public."backup_attempts" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."backup_email_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."backup_email_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "backup_email_settings_tenant_isolation_policy" ON public."backup_email_settings" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."backup_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."backup_history" FORCE ROW LEVEL SECURITY;
CREATE POLICY "backup_history_tenant_isolation_policy" ON public."backup_history" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."branches" FORCE ROW LEVEL SECURITY;
CREATE POLICY "branches_tenant_isolation_policy" ON public."branches" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."business_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."business_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "business_settings_tenant_isolation_policy" ON public."business_settings" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."fiscal_years" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."fiscal_years" FORCE ROW LEVEL SECURITY;
CREATE POLICY "fiscal_years_tenant_isolation_policy" ON public."fiscal_years" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."customers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customers_tenant_isolation_policy" ON public."customers" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."damage_claims" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."damage_claims" FORCE ROW LEVEL SECURITY;
CREATE POLICY "damage_claims_tenant_isolation_policy" ON public."damage_claims" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "deliveries_tenant_isolation_policy" ON public."deliveries" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."delivery_drivers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."delivery_drivers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "delivery_drivers_tenant_isolation_policy" ON public."delivery_drivers" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."delivery_zones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."delivery_zones" FORCE ROW LEVEL SECURITY;
CREATE POLICY "delivery_zones_tenant_isolation_policy" ON public."delivery_zones" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."expense_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."expense_categories" FORCE ROW LEVEL SECURITY;
CREATE POLICY "expense_categories_tenant_isolation_policy" ON public."expense_categories" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."expenses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."expenses" FORCE ROW LEVEL SECURITY;
CREATE POLICY "expenses_tenant_isolation_policy" ON public."expenses" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."inventory_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."inventory_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_items_tenant_isolation_policy" ON public."inventory_items" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."inventory_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."inventory_transactions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_transactions_tenant_isolation_policy" ON public."inventory_transactions" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."notification_reads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."notification_reads" FORCE ROW LEVEL SECURITY;
CREATE POLICY "notification_reads_tenant_isolation_policy" ON public."notification_reads" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY "notifications_tenant_isolation_policy" ON public."notifications" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."order_deletions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."order_deletions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_deletions_tenant_isolation_policy" ON public."order_deletions" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."order_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."order_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_items_tenant_isolation_policy" ON public."order_items" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY "orders_tenant_isolation_policy" ON public."orders" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."password_reset_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."password_reset_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "password_reset_requests_tenant_isolation_policy" ON public."password_reset_requests" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "payments_tenant_isolation_policy" ON public."payments" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."payroll_employees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."payroll_employees" FORCE ROW LEVEL SECURITY;
CREATE POLICY "payroll_employees_tenant_isolation_policy" ON public."payroll_employees" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."pending_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."pending_payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pending_payments_tenant_isolation_policy" ON public."pending_payments" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."refund_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."refund_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "refund_requests_tenant_isolation_policy" ON public."refund_requests" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."users" FORCE ROW LEVEL SECURITY;
CREATE POLICY "users_tenant_isolation_policy" ON public."users" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."period_comparisons" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."period_comparisons" FORCE ROW LEVEL SECURITY;
CREATE POLICY "period_comparisons_tenant_isolation_policy" ON public."period_comparisons" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."price_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."price_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "price_items_tenant_isolation_policy" ON public."price_items" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."promotions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."promotions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "promotions_tenant_isolation_policy" ON public."promotions" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."salary_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."salary_payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "salary_payments_tenant_isolation_policy" ON public."salary_payments" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."user_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."user_preferences" FORCE ROW LEVEL SECURITY;
CREATE POLICY "user_preferences_tenant_isolation_policy" ON public."user_preferences" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."whatsapp_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."whatsapp_messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY "whatsapp_messages_tenant_isolation_policy" ON public."whatsapp_messages" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public."year_end_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."year_end_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "year_end_snapshots_tenant_isolation_policy" ON public."year_end_snapshots" TO soth_app
USING (tenant_id = public.app_current_tenant_id())
WITH CHECK (tenant_id = public.app_current_tenant_id());

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcements FORCE ROW LEVEL SECURITY;
CREATE POLICY announcements_tenant_isolation_policy ON public.announcements TO soth_app
USING (tenant_id=public.app_current_tenant_id()) WITH CHECK (tenant_id=public.app_current_tenant_id());
ALTER TABLE public.scheduled_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduled_announcements FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduled_announcements_tenant_isolation_policy ON public.scheduled_announcements TO soth_app
USING (tenant_id=public.app_current_tenant_id()) WITH CHECK (tenant_id=public.app_current_tenant_id());
ALTER TABLE public.security_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY security_audit_logs_tenant_isolation_policy ON public.security_audit_logs TO soth_app
USING (tenant_id=public.app_current_tenant_id()) WITH CHECK (tenant_id=public.app_current_tenant_id());

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_runtime_read_own_policy ON public.tenants FOR SELECT TO soth_app
USING (id=NULLIF(current_setting('app.current_tenant_id',TRUE),'')::INTEGER);
ALTER TABLE public.schema_patches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schema_patches FORCE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA public TO soth_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO soth_app;
GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public TO soth_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO soth_app;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.tenants FROM soth_app;
GRANT SELECT (id,is_active) ON public.tenants TO soth_app;
REVOKE ALL ON public.schema_patches FROM soth_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC,anon,authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC,anon,authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC,anon,authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO soth_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE,SELECT,UPDATE ON SEQUENCES TO soth_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO soth_app;

COMMIT;
