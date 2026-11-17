-- Operations and desktop order workflows use READY as a canonical order state.
-- Add it to older installations whose order_status enum predates Operations.
ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'READY';
