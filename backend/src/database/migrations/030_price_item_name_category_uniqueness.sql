-- Index tenant and category for tenant-scoped duplicate checks.
-- Existing same-category duplicate rows are preserved; the backend rejects new
-- duplicates while allowing price edits to those existing rows.
BEGIN;

CREATE INDEX IF NOT EXISTS price_items_tenant_category_idx
  ON public.price_items (tenant_id, category);

COMMIT;
