-- Operations role and cross-workspace permissions. Safe to run more than once.
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'OPERATIONS';

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS operations_access_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS desktop_workspace_enabled BOOLEAN NOT NULL DEFAULT FALSE;
