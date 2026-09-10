ALTER TABLE energy_provider_orders
  ADD COLUMN IF NOT EXISTS requested_energy_amount BIGINT;

UPDATE energy_provider_orders
   SET requested_energy_amount = energy_amount
 WHERE requested_energy_amount IS NULL;

ALTER TABLE energy_provider_orders
  ALTER COLUMN requested_energy_amount SET NOT NULL;

UPDATE energy_providers
   SET max_energy_per_order = 130000,
       updated_at = NOW()
 WHERE provider_type = 'kuaizu'
   AND max_energy_per_order > 130000;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'energy_provider_orders_requested_energy_amount_check'
       AND conrelid = 'energy_provider_orders'::regclass
  ) THEN
    ALTER TABLE energy_provider_orders
      ADD CONSTRAINT energy_provider_orders_requested_energy_amount_check
      CHECK (requested_energy_amount BETWEEN 1 AND 10000000);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'energy_providers_kuaizu_package_max_check'
       AND conrelid = 'energy_providers'::regclass
  ) THEN
    ALTER TABLE energy_providers
      ADD CONSTRAINT energy_providers_kuaizu_package_max_check
      CHECK (provider_type <> 'kuaizu' OR max_energy_per_order <= 130000);
  END IF;
END
$$;
