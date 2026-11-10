ALTER TABLE public.sclad
  ADD COLUMN IF NOT EXISTS client_price numeric(12,2);

COMMENT ON COLUMN public.sclad.client_price IS
  'Manual client price for batch Excel rows. NULL means calculate from price and warehouse markup.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sclad_client_price_check'
      AND conrelid = 'public.sclad'::regclass
  ) THEN
    ALTER TABLE public.sclad
      ADD CONSTRAINT sclad_client_price_check
      CHECK (client_price IS NULL OR client_price >= 0::numeric);
  END IF;
END $$;
