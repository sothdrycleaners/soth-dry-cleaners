-- Keep Operations notes separate from notes entered by front-desk staff.
ALTER TABLE public.operations_item_status
  ADD COLUMN IF NOT EXISTS operations_note TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'operations_item_status_note_length_check'
      AND conrelid = 'public.operations_item_status'::regclass
  ) THEN
    ALTER TABLE public.operations_item_status
      ADD CONSTRAINT operations_item_status_note_length_check
      CHECK (operations_note IS NULL OR length(operations_note) <= 500);
  END IF;
END;
$$;
