-- Persist tenant-specific expense categories and keep the runtime app role
-- limited by the tenant RLS policy installed in migration 020.
BEGIN;

ALTER TABLE public.expense_categories
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS color VARCHAR(20) NOT NULL DEFAULT '#3B82F6',
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE public.expense_categories
SET color = '#3B82F6'
WHERE color IS NULL OR color = '';

UPDATE public.expense_categories
SET is_active = TRUE
WHERE is_active IS NULL;

ALTER TABLE public.expense_categories
  ALTER COLUMN color SET NOT NULL,
  ALTER COLUMN is_active SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS expense_categories_tenant_name_key
  ON public.expense_categories (tenant_id, name);

INSERT INTO public.expense_categories (tenant_id, name, description, color, is_active)
SELECT t.id, seed.name, seed.description, seed.color, TRUE
FROM public.tenants AS t
CROSS JOIN (VALUES
  ('Utilities', 'Electricity, water, internet, and other utilities', '#3B82F6'),
  ('Supplies', 'Cleaning products, packaging, and shop supplies', '#10B981'),
  ('Maintenance', 'Equipment repairs and maintenance', '#F59E0B'),
  ('Transport', 'Fuel, deliveries, and transport costs', '#8B5CF6'),
  ('Office', 'Office and administration costs', '#EF4444'),
  ('Other', 'Expenses that do not fit another category', '#6B7280')
) AS seed(name, description, color)
WHERE t.is_active = TRUE
ON CONFLICT (tenant_id, name) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'soth_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.expense_categories TO soth_app';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.expense_categories_id_seq TO soth_app';
  END IF;
END;
$$;

COMMIT;
