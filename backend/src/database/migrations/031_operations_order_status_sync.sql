-- Keep Operations item status aligned when desktop staff change an order status.
CREATE OR REPLACE FUNCTION public.operations_sync_order_ready_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  next_item_status TEXT;
BEGIN
  IF current_setting('app.operations_status_update', TRUE) = 'true' THEN
    RETURN NEW;
  END IF;

  next_item_status := CASE upper(COALESCE(NEW.status::text, ''))
    WHEN 'READY' THEN 'READY'
    WHEN 'PROCESSING' THEN 'PROCESSING'
    WHEN 'PENDING' THEN 'RECEIVED'
    WHEN 'RECEIVED' THEN 'RECEIVED'
    ELSE NULL
  END;

  IF next_item_status IS NOT NULL THEN
    UPDATE public.operations_item_status
    SET status = next_item_status,
        ready_at = CASE WHEN next_item_status = 'READY' THEN COALESCE(ready_at, NOW()) ELSE NULL END,
        updated_at = NOW()
    WHERE tenant_id = NEW.tenant_id
      AND order_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS operations_sync_order_ready_status_trigger ON public.orders;
CREATE TRIGGER operations_sync_order_ready_status_trigger
AFTER UPDATE OF status ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.operations_sync_order_ready_status();
