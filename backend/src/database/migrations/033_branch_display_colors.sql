-- Persist a stable branch color for order and operations screens.
ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS color CHAR(7);

WITH ranked_branches AS (
  SELECT id, tenant_id,
    ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY is_default DESC, created_at ASC, id ASC) AS branch_position
  FROM public.branches
)
UPDATE public.branches b
SET color = CASE r.branch_position
  WHEN 1 THEN '#3B82F6'
  WHEN 2 THEN '#F97316'
  WHEN 3 THEN '#16A34A'
  WHEN 4 THEN '#A855F7'
  ELSE '#E11D48'
END
FROM ranked_branches r
WHERE r.id = b.id
  AND (b.color IS NULL OR b.color !~ '^#[0-9A-Fa-f]{6}$');

ALTER TABLE public.branches
  ALTER COLUMN color SET DEFAULT '#3B82F6',
  ALTER COLUMN color SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'branches_color_hex_check'
      AND conrelid = 'public.branches'::regclass
  ) THEN
    ALTER TABLE public.branches
      ADD CONSTRAINT branches_color_hex_check
      CHECK (color ~ '^#[0-9A-Fa-f]{6}$');
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS branches_tenant_color_unique
  ON public.branches (tenant_id, upper(color));
