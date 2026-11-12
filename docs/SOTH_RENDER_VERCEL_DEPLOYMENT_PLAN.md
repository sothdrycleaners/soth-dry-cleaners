# Soth Dry Cleaners: Render and Vercel Launch Plan

## Current readiness

- The login page no longer shows the Operations demo preview.
- The frontend production build succeeds.
- The backend TypeScript production build succeeds.
- The repository has a root `vercel.json` configured to build `frontend/`, publish `frontend/dist`, and proxy `/api/*` and `/uploads/*` to Render.
- The backend listens on Render's `PORT` and exposes `/api/health`.
- Registration requests are created as pending. A registered Administrator does not become active until an authorized administrator approves the account.
- Soth's tenant 1 currently has an active system-admin account configured through `SYSTEM_ADMIN_EMAILS`. That account can approve the first business administrator.
- Do not run `npm run seed` or `npm run db:reset` on production. The seed script inserts sample accounts and sample business data.

User Management's core registration, approval, role, and workspace-access flows are implemented. Builds establish that the current source compiles; the full production onboarding flow still needs to be exercised after deployment.

## Deployment layout

### Render API service

Create a **Web Service** from the Soth GitHub repository.

- Service name: `soth-dry-cleaners-api` (matches the existing Vercel rewrite target)
- Runtime: Node
- Root directory: `backend`
- Build command: `npm install && npm run build`
- Start command: `npm start`
- Health check path: `/api/health`
- Instance region: choose a region close to the Soth Supabase project and primary users, subject to available Render regions/plans.

Set production environment variables in Render's dashboard, not in Git:

- `NODE_ENV=production`
- `APP_DATABASE_URL`: Soth's restricted `soth_app` connection via the Supabase Transaction Pooler
- `DEPLOYMENT_TENANT_ID=1`
- `RUN_STARTUP_MIGRATIONS=false`
- `JWT_SECRET`: a newly generated high-entropy secret
- `SESSION_SECRET`: a separate newly generated high-entropy secret
- `ADMIN_PIN_PEPPER`: a separate stable high-entropy secret
- `SYSTEM_ADMIN_EMAILS`: the system administrator email(s), comma-separated
- `SUPABASE_URL`: Soth project's URL
- `SUPABASE_SERVICE_ROLE_KEY`: Soth project's service-role key, stored only as a Render secret
- `SUPABASE_STORAGE_BUCKET=profile-pictures`
- `FRONTEND_URL`: the deployed Vercel origin (set after the initial Vercel deployment, then redeploy/restart the API)

Optional Google OAuth, email, SMS, and WhatsApp credentials should only be added when those integrations are configured and their callback URLs have been updated.

Do not put the database-owner credential in the running API service. Use `MIGRATION_DATABASE_URL` only for a deliberate one-off migration operation, then remove it from the service environment. Keep startup migrations disabled.

### Vercel frontend

Import the same repository into Vercel.

- Project root: repository root (so Vercel uses the root `vercel.json`)
- Framework preset: Vite (or Other if Vercel does not auto-detect it)
- Build and output: already specified in root `vercel.json` as `npm install --prefix frontend && npm run build --prefix frontend` and `frontend/dist`
- The existing rewrite targets `https://soth-dry-cleaners-api.onrender.com`; preserve the Render service name above or update the two rewrite destinations if Render assigns a different hostname.
- After deployment, set Render's `FRONTEND_URL` to the exact Vercel origin. If a custom domain is later used, configure the app's CORS origin to match that domain as well.

The existing Vercel config sends `X-Robots-Tag: noindex, nofollow` globally. Remove that header when the public site should be indexed by search engines; it does not prevent users with the URL from accessing the app.

## Database release gate

Before opening registration to staff:

1. Compare the SQL migrations in the repository with the migration history in the Soth Supabase project.
2. Apply any required, unapplied migrations once using the migration/owner connection. Never run the sample seed or database reset commands.
3. Confirm the application connection uses the restricted `soth_app` role and tenant 1 is selected.
4. Confirm the required profile-picture bucket exists and is private if that is the chosen storage policy.
5. Check `/api/health` on the Render URL and verify the frontend can reach the API through the Vercel origin.

## First business administrator onboarding

1. Open the deployed Vercel site and choose **Create account**.
2. Register with the business administrator's own email and select **Administrator**.
3. The new account will be pending and cannot enter the business workspace yet.
4. Sign in with the existing system-admin account already present in Soth tenant 1.
5. Open **User Management → Pending**, review the request, and approve it.
6. Sign out and have the new business administrator sign in. Confirm their account is active and the administrator screens load.
7. Create the remaining staff accounts and approve them according to the business process.

The hidden system-admin account is controlled by `SYSTEM_ADMIN_EMAILS`; it is not a password field in Render or source code. Keep its password in the normal account credential store/password manager and never put it in Git.

## Before connecting GitHub to hosts

Render and Vercel deploy repository commits. The Soth working tree currently contains uncommitted work, and nothing has been pushed as part of this plan. The deployed source must be reviewed and committed to the authorized Soth GitHub repository before either host can build that version. Do not commit `.env`, service-role keys, database passwords, or generated secrets.

The production environment example currently lists `AUTHORIZED_ADMIN_EMAILS`; the active backend uses `SYSTEM_ADMIN_EMAILS` for system-admin privileges. Treat `SYSTEM_ADMIN_EMAILS` as the effective setting and remove or correct the stale example entry before deployment.

## Official setup references

- [Render monorepo root directories](https://render.com/docs/monorepo-support)
- [Render deployments and build commands](https://render.com/docs/deploys)
- [Render environment variables and secrets](https://render.com/docs/configure-environment-variables)
- [Render health checks](https://render.com/docs/health-checks)
- [Vercel build configuration](https://vercel.com/docs/builds/configure-a-build)
- [Vercel Vite deployment](https://vercel.com/docs/frameworks/frontend/vite)
