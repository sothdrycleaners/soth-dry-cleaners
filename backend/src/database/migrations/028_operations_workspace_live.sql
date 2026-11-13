-- Live Operations workspace state. Orders remain canonical for billing and delivery.
CREATE TABLE IF NOT EXISTS public.operations_item_status (
  id BIGSERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT app_current_tenant_id() REFERENCES public.tenants(id) ON DELETE RESTRICT,
  order_id INTEGER NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  order_item_id INTEGER NOT NULL REFERENCES public.order_items(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','PROCESSING','READY')),
  ready_at TIMESTAMPTZ,
  updated_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, order_item_id)
);
CREATE INDEX IF NOT EXISTS idx_ops_item_tenant_status ON public.operations_item_status(tenant_id,status,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_item_order ON public.operations_item_status(tenant_id,order_id);

CREATE TABLE IF NOT EXISTS public.operations_messages (
  id BIGSERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT app_current_tenant_id() REFERENCES public.tenants(id) ON DELETE RESTRICT,
  branch_id INTEGER REFERENCES public.branches(id) ON DELETE SET NULL,
  order_id INTEGER REFERENCES public.orders(id) ON DELETE SET NULL,
  sender_id INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  message TEXT NOT NULL CHECK(length(trim(message)) BETWEEN 1 AND 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ops_messages_recent ON public.operations_messages(tenant_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_messages_branch ON public.operations_messages(tenant_id,branch_id,created_at DESC);

ALTER TABLE public.operations_item_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operations_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operations_item_status_tenant_policy ON public.operations_item_status;
CREATE POLICY operations_item_status_tenant_policy ON public.operations_item_status USING(tenant_id=app_current_tenant_id()) WITH CHECK(tenant_id=app_current_tenant_id());
DROP POLICY IF EXISTS operations_messages_tenant_policy ON public.operations_messages;
CREATE POLICY operations_messages_tenant_policy ON public.operations_messages USING(tenant_id=app_current_tenant_id()) WITH CHECK(tenant_id=app_current_tenant_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON public.operations_item_status TO soth_app;
GRANT USAGE,SELECT ON SEQUENCE public.operations_item_status_id_seq TO soth_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.operations_messages TO soth_app;
GRANT USAGE,SELECT ON SEQUENCE public.operations_messages_id_seq TO soth_app;

-- Seed existing active orders and make new order items appear automatically.
INSERT INTO public.operations_item_status(tenant_id,order_id,order_item_id,status,ready_at)
SELECT oi.tenant_id,oi.order_id,oi.id,
 CASE WHEN upper(o.status::text)='READY' THEN 'READY' WHEN upper(o.status::text) IN('PROCESSING','PROCESSING') THEN 'PROCESSING' ELSE 'RECEIVED' END,
 CASE WHEN upper(o.status::text)='READY' THEN COALESCE(o.updated_at,NOW()) END
FROM public.order_items oi JOIN public.orders o ON o.id=oi.order_id AND o.tenant_id=oi.tenant_id
WHERE upper(o.status::text) NOT IN('DELIVERED','CANCELLED')
ON CONFLICT(tenant_id,order_item_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.operations_seed_order_item_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO public.operations_item_status(tenant_id,order_id,order_item_id,status)
 SELECT NEW.tenant_id,NEW.order_id,NEW.id,'RECEIVED'
 WHERE EXISTS(SELECT 1 FROM public.orders o WHERE o.id=NEW.order_id AND o.tenant_id=NEW.tenant_id AND upper(o.status::text) NOT IN('DELIVERED','CANCELLED'))
 ON CONFLICT(tenant_id,order_item_id) DO NOTHING;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS operations_seed_order_item_status_trigger ON public.order_items;
CREATE TRIGGER operations_seed_order_item_status_trigger AFTER INSERT ON public.order_items FOR EACH ROW EXECUTE FUNCTION public.operations_seed_order_item_status();

CREATE OR REPLACE FUNCTION public.operations_sync_order_ready_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('app.operations_status_update',TRUE)='true' THEN RETURN NEW; END IF;
 IF upper(NEW.status::text)='READY' AND upper(OLD.status::text)<>'READY' THEN
  UPDATE public.operations_item_status SET status='READY',ready_at=COALESCE(ready_at,NOW()),updated_at=NOW() WHERE tenant_id=NEW.tenant_id AND order_id=NEW.id;
 ELSIF upper(OLD.status::text)='READY' AND upper(NEW.status::text) IN('PENDING','PROCESSING','PROCESSING') THEN
  UPDATE public.operations_item_status SET status='PROCESSING',ready_at=NULL,updated_at=NOW() WHERE tenant_id=NEW.tenant_id AND order_id=NEW.id;
 END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS operations_sync_order_ready_status_trigger ON public.orders;
CREATE TRIGGER operations_sync_order_ready_status_trigger AFTER UPDATE OF status ON public.orders FOR EACH ROW EXECUTE FUNCTION public.operations_sync_order_ready_status();



-- Keep an Operations item tied to the same tenant and order as its source order_item.
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_tenant_order_id_id
  ON public.order_items (tenant_id, order_id, id);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operations_item_source_order_fkey'
      AND conrelid = 'public.operations_item_status'::regclass
  ) THEN
    ALTER TABLE public.operations_item_status
      ADD CONSTRAINT operations_item_source_order_fkey
      FOREIGN KEY (tenant_id, order_id, order_item_id)
      REFERENCES public.order_items (tenant_id, order_id, id)
      ON DELETE CASCADE;
  END IF;
END;
$$;

-- Support newest-first branch work queues and ready-item reports.
CREATE INDEX IF NOT EXISTS idx_operations_ready_report
  ON public.operations_item_status (tenant_id, ready_at DESC, order_item_id)
  WHERE status = 'READY';
CREATE INDEX IF NOT EXISTS idx_operations_orders_branch_date
  ON public.orders (tenant_id, branch_id, (COALESCE(recorded_at, created_at)) DESC, id DESC);

-- Direct staff messaging: one sender, one recipient, and a per-recipient read state.
ALTER TABLE public.operations_messages
  ADD COLUMN IF NOT EXISTS recipient_id INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_operations_messages_recipient_unread
  ON public.operations_messages (tenant_id, recipient_id, created_at DESC)
  WHERE recipient_id IS NOT NULL AND read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_operations_messages_conversation
  ON public.operations_messages (tenant_id, sender_id, recipient_id, created_at DESC)
  WHERE recipient_id IS NOT NULL;

-- Express deadlines belong to the line item so mixed orders can have different due times.
ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS express_due_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_order_items_express_deadline
  ON public.order_items (tenant_id, express_due_at)
  WHERE upper(COALESCE(service_type::text,''))='EXPRESS' AND express_due_at IS NOT NULL;

-- Keep internal staff messages concise and prevent oversized content on future writes.
ALTER TABLE public.operations_messages
  ADD COLUMN IF NOT EXISTS sender_context VARCHAR(16) NOT NULL DEFAULT 'STAFF',
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS unsent_at TIMESTAMPTZ;

-- A new tenant retains internal message history for 30 days by default.
INSERT INTO public.business_settings(tenant_id,setting_key,setting_value,updated_at)
SELECT id,'message_retention_days','30'::jsonb,NOW() FROM public.tenants WHERE is_active=TRUE
ON CONFLICT(tenant_id,setting_key) DO NOTHING;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operations_messages_sender_context_check' AND conrelid='public.operations_messages'::regclass) THEN
    ALTER TABLE public.operations_messages ADD CONSTRAINT operations_messages_sender_context_check CHECK (sender_context IN ('STAFF','OPERATIONS'));
  END IF;
END;
$$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operations_messages_max_2000_chars'
      AND conrelid = 'public.operations_messages'::regclass
  ) THEN
    ALTER TABLE public.operations_messages
      ADD CONSTRAINT operations_messages_max_2000_chars
      CHECK (length(trim(message)) BETWEEN 1 AND 2000) NOT VALID;
  END IF;
END;
$$;
