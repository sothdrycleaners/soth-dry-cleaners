-- Enforce phone uniqueness per tenant using normalized digits, including writes
-- that bypass the API. Customer names remain non-unique.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.customers
    WHERE tenant_id IS NOT NULL
      AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') <> ''
    GROUP BY tenant_id, regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g')
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate normalized phone numbers exist within a tenant. Resolve them before applying migration 032.';
  END IF;
END $$;

-- The old constraint was global across all tenants and only compared raw text.
ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS unique_customer_phone;
ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_phone_key;
DROP INDEX IF EXISTS public.unique_customer_phone;

CREATE UNIQUE INDEX IF NOT EXISTS customers_tenant_normalized_phone_key
  ON public.customers (
    tenant_id,
    (regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'))
  )
  WHERE tenant_id IS NOT NULL
    AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') <> '';

COMMIT;
