-- Create a dedicated runtime role that is subject to row-level security.
-- Run with the migration/admin role only after 020 has enabled tenant policies.
-- Set a strong password outside source control, then configure APP_DATABASE_URL
-- with the Supabase shared-pooler username `soth_app.<project-ref>`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'soth_app') THEN
    CREATE ROLE soth_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE soth_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO soth_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO soth_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO soth_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO soth_app;

-- The application may validate tenants, but tenant lifecycle is admin-only.
REVOKE SELECT ON public.tenants FROM soth_app;
GRANT SELECT (id, is_active) ON public.tenants TO soth_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.tenants FROM soth_app;

-- Migration bookkeeping is not part of the application API.
REVOKE ALL ON public.schema_patches FROM soth_app;

-- Preserve the same grants on new objects created by the postgres migration owner.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO soth_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO soth_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO soth_app;
