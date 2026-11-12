# Soth Dry Cleaners: Supabase tenant schema plan

## Purpose and decisions

Lush is a schema and tenant-isolation reference only. Soth will have its own Supabase organization/project and Postgres database. Do not copy Lush tenant rows, customer/order data, passwords, or business settings.

Soth will keep application-level multi-tenancy inside its own database:

- public.tenants stores business tenants.
- Laundry/business tables carry tenant_id.
- RLS policies restrict rows using app_current_tenant_id().
- Soth is inserted as the first tenant in the Soth database.
- Future compatible laundry businesses can be added as tenant rows.

A Supabase organization groups projects; the application tenants table is a separate boundary inside a project's database.

## Lush schema findings supplied so far

The submitted inventory reports 57 public tables; 55 have tenant_id; all 57 have RLS enabled. tenants and schema_patches are the two tables without tenant_id. The inventory includes 19 woodz_* tables, which should be excluded from the initial Soth laundry schema unless the Woodz retail module is intentionally in scope.

The policies show tenant_id checks on the laundry tables. schema_patches has RLS enabled but no policy in the supplied policy list; normal runtime access is therefore denied by default, which is appropriate for migration bookkeeping.

The Lush runtime roles lush_app and woodz_app have LOGIN, but are neither superusers nor RLS bypass roles. Soth should use its own restricted role named soth_app.

Lush currently has five tenant rows (Lush, Hommiez, Tandika, Woodz, TradeFlow). Do not copy those rows into Soth.

## Read-only inspection SQL for the Lush project

Run these queries in Lush's Supabase SQL Editor. They inspect metadata only and do not alter tables.

### 1. Tenant IDs and names

~~~sql
SELECT id, tenant_name, tenant_slug, contact_email, is_active, is_default
FROM public.tenants
ORDER BY id;
~~~

### 2. Public tables, tenant columns, RLS, and columns

~~~sql
SELECT
  t.table_name,
  bool_or(c.column_name = 'tenant_id') AS has_tenant_id,
  COALESCE(tbl.relrowsecurity, false) AS rls_enabled,
  jsonb_agg(
    jsonb_build_object(
      'column', c.column_name,
      'type', CASE
        WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name
        ELSE c.data_type
      END,
      'nullable', c.is_nullable = 'YES',
      'default', c.column_default
    )
    ORDER BY c.ordinal_position
  ) AS columns
FROM information_schema.tables AS t
JOIN information_schema.columns AS c
  ON c.table_schema = t.table_schema
  AND c.table_name = t.table_name
LEFT JOIN pg_catalog.pg_class AS tbl
  ON tbl.relname = t.table_name
  AND tbl.relnamespace = 'public'::regnamespace
WHERE t.table_schema = 'public'
  AND t.table_type = 'BASE TABLE'
GROUP BY t.table_name, tbl.relrowsecurity
ORDER BY t.table_name;
~~~

### 3. RLS policies

~~~sql
SELECT tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
~~~

### 4. Tenant helper functions

~~~sql
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  pg_get_functiondef(p.oid) AS definition
FROM pg_proc AS p
JOIN pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'app_current_tenant_id',
    'app_current_user_id',
    'get_default_tenant_id'
  )
ORDER BY p.proname;
~~~

### 5. Runtime role properties

~~~sql
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
FROM pg_roles
WHERE rolname IN ('lush_app', 'woodz_app')
ORDER BY rolname;
~~~

### 6. Summarize table grants per role

This grouped query avoids the SQL Editor's 100-row display limit.

~~~sql
SELECT
  grantee,
  table_name,
  string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND grantee IN ('lush_app', 'woodz_app')
GROUP BY grantee, table_name
ORDER BY grantee, table_name;
~~~

### 7. Constraints: primary keys, foreign keys, unique/check constraints

~~~sql
SELECT
  conrelid::regclass AS table_name,
  conname AS constraint_name,
  CASE contype
    WHEN 'p' THEN 'PRIMARY KEY'
    WHEN 'f' THEN 'FOREIGN KEY'
    WHEN 'u' THEN 'UNIQUE'
    WHEN 'c' THEN 'CHECK'
    WHEN 'x' THEN 'EXCLUSION'
  END AS constraint_type,
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE connamespace = 'public'::regnamespace
  AND contype IN ('p', 'f', 'u', 'c', 'x')
ORDER BY conrelid::regclass::text, contype, conname;
~~~

### 8. Indexes

~~~sql
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename, indexname;
~~~

### 9. Triggers

~~~sql
SELECT event_object_table AS table_name, trigger_name, event_manipulation,
       action_timing, action_statement
FROM information_schema.triggers
WHERE trigger_schema = 'public'
ORDER BY event_object_table, trigger_name, event_manipulation;
~~~

### 10. Enum types

~~~sql
SELECT t.typname AS enum_name, e.enumsortorder, e.enumlabel
FROM pg_type AS t
JOIN pg_enum AS e ON e.enumtypid = t.oid
JOIN pg_namespace AS n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
ORDER BY t.typname, e.enumsortorder;
~~~

## Creating Soth's Supabase project

1. Sign in to the Supabase dashboard and create an organization named Soth Dry Cleaners.
2. Create a project inside it, for example Soth Dry Cleaners Production.
3. Choose a region close to Soth's users from the dashboard's available regions.
4. Set and securely store a strong database password. Do not commit it or paste it into chat.
5. Wait for provisioning, then keep the project ref and connection details in private deployment settings.

Each Supabase project has its own Postgres database; this project will be independent from Lush.

## Schema capture and Soth migrations

1. Finish inspecting constraints, indexes, triggers, functions, grants, and policies in Lush.
2. Select the laundry ERP objects required by Soth. Do not include woodz_* tables by default.
3. Create ordered, version-controlled migrations in the Soth repository. Include required tables, enums, indexes, functions, triggers, tenant policies, and grants.
4. Seed only a Soth tenant row and non-sensitive starter settings. Do not copy Lush tenant or customer data.
5. Create a Soth-only runtime role soth_app with LOGIN, NOSUPERUSER, and NOBYPASSRLS. Grant only the permissions the app needs. Use the administrative database connection for migrations and the restricted role for API requests.
6. Set DEPLOYMENT_TENANT_ID to Soth's actual tenant ID in Render. The current backend pins each deployment to one tenant. To host another compatible tenant in the same database, use another backend deployment with that tenant ID unless the backend is deliberately changed to authorize tenant selection per user.

A schema-only dump can be used as a reference, but a public-schema dump also includes the woodz_* module and must not be applied blindly. Current Supabase CLI versions target local by default, so hosted dump/push operations require an explicit --remote flag. Review the dump and turn selected objects into migrations before applying them.

## Tenant helper function issue

Lush's get_default_tenant_id() selects the default tenant, but its fallback branch also tries to insert a Lush tenant from inside a function marked STABLE. Do not carry that behavior into Soth.

- Seed the Soth tenant explicitly before tenant policies/defaults depend on it.
- Make get_default_tenant_id() read-only, or make missing tenant context fail closed.
- Do not silently route requests with missing tenant context to a default tenant once multiple tenants exist.
- Ensure every request/background job sets tenant context before querying tenant-scoped tables.

The Soth foundation migration has been updated: it seeds and asserts Soth tenant ID 1, removes the fallback insert, and returns NULL when the request tenant context is missing. Verify all request and background-job paths set tenant context before applying it.

## Deployment gate

Do not use npm run migrate or npm run db:reset against production. In this clone, npm run migrate invokes backend/src/database/migrate.ts, which explicitly drops core tables and recreates a small development schema; db:reset also runs the seed script.

Production has RUN_STARTUP_MIGRATIONS=false. Before deployment, define a safe, ordered migration/release step that uses the administrative database connection. Apply it to Soth's empty project and confirm it succeeded before deploying the Render backend. Vercel frontend deployment does not create database tables.

## References

    -https://supabase.com/docs/guides/platform
    - https://supabase.com/docs/guides/database/overview
    - https://supabase.com/docs/guides/database/postgres/row-level-security
    - https://supabase.com/docs/guides/local-development/database-migrations
    - https://supabase.com/docs/reference/cli/supabase-issue-bug
    - https://supabase.com/changelog?
next=Y3Vyc29yOnYyOpK0MjAyMy0xMi0xM1QxOTozNDoyOVrOAFrpTQ%3D%3D&restPage=3

## Final completeness check: schema-only dump and adjacent objects

The queries above are useful for review, but a schema-only dump is the most complete reference for PostgreSQL DDL. It contains definitions, not Lush business rows. It can include the full public schema, including Woodz objects, so treat it as a reference and select the Soth laundry objects before creating Soth migrations.

From a local checkout with the Supabase CLI installed:

~~~powershell
npx supabase login
if (-not (Test-Path .\supabase\config.toml)) { npx supabase init }
npx supabase db dump --remote=<LUSH_PROJECT_REF> --schema=public --file=docs/lush-public-schema.sql
~~~

The dump command excludes data by default. The current CLI uses local targets unless --remote is specified. Do not restore this full dump directly into Soth.

Additional inventory queries:

### Public views and materialized views

~~~sql
SELECT table_name, view_definition
FROM information_schema.views
WHERE table_schema = 'public'
ORDER BY table_name;
~~~

~~~sql
SELECT schemaname, matviewname, definition
FROM pg_matviews
WHERE schemaname = 'public'
ORDER BY matviewname;
~~~

### Installed extensions

~~~sql
SELECT e.extname, e.extversion, n.nspname AS extension_schema
FROM pg_extension AS e
JOIN pg_namespace AS n ON n.oid = e.extnamespace
ORDER BY e.extname;
~~~

### Supabase Storage buckets and policies

The backend has a Supabase Storage integration, so inspect the Lush buckets/policies if Soth will use Storage for profile pictures or other uploads. This metadata is separate from the public table schema.

~~~sql
SELECT id, name, public, file_size_limit, allowed_mime_types
FROM storage.buckets
ORDER BY id;
~~~

~~~sql
SELECT tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'storage'
ORDER BY tablename, policyname;
~~~

Tenant 1 does not have a private table schema of its own. The same public table definitions serve every tenant; tenant_id values and RLS policies separate their rows. The Soth schema should include the laundry tables and necessary shared tenant/security objects only.

## Lush production schema export reviewed (2026-11-10)

The schema-only export is saved at `docs/lush-public-schema.sql`. It was produced from the Lush production project reference `xrkptygpwjdizvhkgvpo` using an explicit remote target. It contains schema definitions, not tenant business rows. Keep this file as a reference; do not restore it directly into Soth.

The dump contains 58 public base tables. Fifty-six have `tenant_id`; the two shared/global tables are `tenants` and `schema_patches`. All 58 have RLS enabled; 56 also have FORCE ROW LEVEL SECURITY. The dump contains 60 policies, 180 indexes, four enum types, nine functions, and three views. It has trigger-function definitions but no `CREATE TRIGGER` statements, so those functions are not shown as attached triggers in this dump. Confirm whether the application relies on any trigger behavior before deciding what Soth should include.

The dump includes 19 `woodz_*` retail tables. The Soth dry-cleaning app source does not currently reference those tables, so leave them out unless a future Soth feature specifically needs them. The three views are `current_fiscal_year`, `pending_refund_requests`, and `users_profile_picture_status`.

### Source objects that must not be copied unchanged

- The dump grants broad privileges on public tables and sequences to `anon` and `authenticated`, and includes broad default privileges for future objects. Do not copy those grants into Soth. Keep API exposure off for new tables and explicitly grant only the Soth backend role the permissions it needs.
- `app_current_tenant_id()` falls back to the default tenant when no tenant context is set. `get_default_tenant_id()` attempts to insert a Lush tenant from a function declared `STABLE`. For Soth, seed the Soth tenant explicitly and make missing request context fail closed; never route an unscoped request to a default tenant.
- `tradeflow_login()` is a `SECURITY DEFINER` function hard-coded for tenant ID 5. It is unrelated to the Soth laundry application and must not be copied or exposed.
- Custom role definitions are not included in the schema dump, though the dump contains grants to `lush_app` and `woodz_app`. Create only the intended Soth roles and grants in Soth migrations; do not assume those source roles exist in a new project.

### Profile picture storage

Soth uses a private `profile-pictures` bucket with a 5 MiB maximum and MIME types `image/jpeg`, `image/jpg`, `image/png`, `image/gif`, and `image/webp`. Migration `20261110200000_soth_private_profile_pictures_bucket.sql` was applied to the Soth production project on 2026-11-11 and verified with `public = false`.

The backend stores images under `tenants/{tenantId}/users/{userId}/...`, including tenant 1 in the path. It keeps the service-role key server-side and returns short-lived signed URLs to authenticated clients. The frontend refreshes the current user profile periodically so displayed image URLs are renewed. Do not expose service-role credentials or make the bucket public.

### Soth initial schema applied (2026-11-10)

Migration supabase/migrations/20261110190000_soth_initial_laundry_schema.sql was applied to **Soth Dry Cleaners Production** (vbpxdrfmfzssksvcrbky) using an explicit remote target. The migration is recorded in Soth's Supabase migration history.

The curated schema contains 42 public tables: the 37 laundry tables from the Lush reference, the shared tenants and schema_patches tables, plus announcements, scheduled_announcements, and security_audit_logs required by the cloned backend but absent from the Lush export. It includes four enums, the three application views, tenant-aware indexes, and tenant RLS policies. It excludes Woodz tables, tradeflow_login(), Lush data, broad anon/authenticated grants, and source ownership changes.

Read-only verification confirmed:

- Soth is the only tenant row: ID 1, slug soth-dry-cleaners, active and default.
- All 42 public tables have RLS enabled and forced; 41 policies are present (the shared migration bookkeeping table has no application policy).
- The soth_app role exists, can log in, and does not bypass RLS.
- No Lush business rows were copied. The business tables are empty.

The soth_app role still needs a privately configured password before it can be used in APP_DATABASE_URL. The private profile-pictures bucket and signed-URL backend flow are configured; no service-role key belongs in frontend configuration.

## Tenant 1 scope clarification

Lush tenant 1 is the laundry business partition inside Lush's shared `public` schema. It is not a separate set of PostgreSQL tables. Laundry tenants share the same table definitions and are separated by `tenant_id`; Lush Woodz is another tenant with an additional `woodz_*` retail module. The exported dump is project-wide schema and does not contain a tenant-specific DDL snapshot.

For Soth, use the laundry/common table model from the dump and omit the unrelated Woodz retail module. Do not copy Lush tenant rows or tenant 1's business records. In Soth's independent Supabase project, seed only `Soth Dry Cleaners` as the first/default tenant. Verify the inserted row has `id = 1` before configuring `DEPLOYMENT_TENANT_ID=1`; make the migration fail if the expected ID is not 1. Reserve later tenant IDs for future businesses in Soth's database.

The Soth initial migration inserts Soth as the default tenant and aborts unless the assigned ID is 1. The backend defaults to deployment tenant ID 1. Its tenant helper returns NULL for a missing or invalid request tenant setting, and the default-tenant lookup raises an error instead of inserting a tenant. This keeps tenant-one mapping deliberate and prevents missing context from silently selecting Soth.

## Soth connection and hidden developer administrator

The Soth initial schema is now installed, so the next steps are to configure the soth_app password, create the developer admin account, and then configure the backend connection. Do not use `npm run migrate`, `npm run db:reset`, or the legacy `backend/setup-admin.ts`: the migration/reset scripts can drop or recreate tables, and the old admin script changes schema and does not scope its insert to a tenant.

The clone recognizes the developer system administrator through the backend `SYSTEM_ADMIN_EMAILS` environment allowlist. It is not the `users.is_super_admin` database flag from Lush; that field is documented for the separate Woodz tenant and is not used by Soth's current auth code. Set `SYSTEM_ADMIN_EMAILS` to the developer's confirmed email in the backend environment. The account itself must be a password-hashed, active `ADMIN` user with `tenant_id = 1`. Public registration creates pending accounts, so bootstrap the developer account after the schema migration using `backend/scripts/seed-soth-system-admin.ts`. That script verifies tenant 1 is Soth, verifies the email is allowlisted, refuses to overwrite an account, and hashes the password. Supply the password as a temporary hidden environment value; never place it in SQL text or source control.

The user-management controller already excludes allowlisted system-admin accounts from business-admin lists and target actions. The generic `/api/users` routes have now also been updated to hide those accounts from list/detail/mutation endpoints. The account must be created before the public backend is opened to registrations, to prevent an unverified registration from claiming the address first.

After the schema and runtime role exist, configure the Render API with `APP_DATABASE_URL` for the restricted `soth_app` role using the Soth project Transaction Pooler, `DEPLOYMENT_TENANT_ID=1`, `SYSTEM_ADMIN_EMAILS`, and Soth's `SUPABASE_URL`/server-only service key for Storage. Keep the owner/migration URL in a one-off migration process, not the long-running API service. The frontend must call the backend and must not receive database passwords or the service-role key.

The Soth environment templates now use Soth placeholders instead of Lush's project ref. Obtain the runtime Transaction Pooler values from Soth's Connect panel and keep database passwords and service-role keys out of source control.

## Optional administrator sign-in PIN

The backend and frontend now support an optional four-digit PIN for `ADMIN` accounts. PIN setup is not part of account registration. An administrator enables it from Profile after confirming their current password; successful email/password authentication then receives a five-minute, PIN-only challenge token. That challenge cannot access authenticated API routes. A normal session token is issued only after correct PIN verification.

PIN values are not stored in plaintext. The backend stores a tenant- and user-bound HMAC using `ADMIN_PIN_PEPPER` when configured, with the strong backend `JWT_SECRET` as the fallback key. Failed PIN attempts are counted and lock the PIN step after five attempts. The login form presents four masked digit cells and an on-screen number pad, and incorrect entry receives red shake feedback.

An administrator who enabled a PIN may update it after confirming their password, but cannot turn it off personally. They can request removal from Profile or from the PIN screen. Only an address in `SYSTEM_ADMIN_EMAILS` can see and approve or deny these requests. Approval clears the PIN and allows password-only login; the administrator can then optionally enable a new PIN. The systems administrator can also enable or disable their own PIN in Profile. Password reset and PIN reset remain separate processes.

The schema change is in `supabase/migrations/20261111130000_admin_pin_security.sql`. Apply it to the Soth project before starting the updated backend against Supabase. It adds optional PIN fields to `public.users` and a tenant-scoped, RLS-protected `public.admin_pin_reset_requests` table, with access granted to the restricted `soth_app` runtime role. The migration is additive and does not change existing user PIN settings (all default to disabled).
