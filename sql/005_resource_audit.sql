CREATE TABLE IF NOT EXISTS transaction_resource_audits (
  tx_id                              CHAR(64) PRIMARY KEY
                                     REFERENCES broadcast_requests(tx_id) ON DELETE RESTRICT,
  energy_estimate_raw                BIGINT,
  energy_estimate_safe               BIGINT,
  estimate_safety_bps                INTEGER,
  energy_available_before            BIGINT,
  package_threshold                  BIGINT,
  energy_package_quoted              BIGINT,
  energy_package_attempted           BIGINT,
  energy_unit_price_sun               BIGINT,
  estimated_energy_burn_sun          BIGINT,
  bandwidth_bytes                    BIGINT,
  bandwidth_staked_available         BIGINT,
  bandwidth_free_available           BIGINT,
  bandwidth_source                   TEXT,
  bandwidth_unit_price_sun           BIGINT,
  estimated_bandwidth_burn_sun       BIGINT,
  owner_balance_sun                  BIGINT,
  fee_limit_sun                      BIGINT,
  minimum_fee_limit_sun              BIGINT,
  maximum_fee_limit_sun              BIGINT,
  energy_available_after             BIGINT,
  energy_arrival_delta               BIGINT GENERATED ALWAYS AS (
    CASE
      WHEN energy_available_before IS NULL OR energy_available_after IS NULL THEN NULL
      ELSE energy_available_after - energy_available_before
    END
  ) STORED,
  receipt_energy_usage_total         BIGINT,
  receipt_energy_usage               BIGINT,
  receipt_origin_energy_usage        BIGINT,
  receipt_net_usage                  BIGINT,
  receipt_net_fee_sun                BIGINT,
  receipt_energy_fee_sun             BIGINT,
  receipt_total_fee_sun              BIGINT,
  receipt_result                     TEXT,
  planned_at                         TIMESTAMPTZ,
  energy_arrival_observed_at         TIMESTAMPTZ,
  solidified_at                      TIMESTAMPTZ,
  created_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (energy_estimate_raw IS NULL OR energy_estimate_raw >= 0),
  CHECK (energy_estimate_safe IS NULL OR energy_estimate_safe >= 0),
  CHECK (
    energy_estimate_raw IS NULL OR energy_estimate_safe IS NULL
    OR energy_estimate_safe >= energy_estimate_raw
  ),
  CHECK (estimate_safety_bps IS NULL OR estimate_safety_bps BETWEEN 10000 AND 100000),
  CHECK (energy_available_before IS NULL OR energy_available_before >= 0),
  CHECK (package_threshold IS NULL OR package_threshold > 0),
  CHECK (energy_package_quoted IS NULL OR energy_package_quoted > 0),
  CHECK (energy_package_attempted IS NULL OR energy_package_attempted > 0),
  CHECK (energy_unit_price_sun IS NULL OR energy_unit_price_sun >= 0),
  CHECK (estimated_energy_burn_sun IS NULL OR estimated_energy_burn_sun >= 0),
  CHECK (bandwidth_bytes IS NULL OR bandwidth_bytes >= 0),
  CHECK (bandwidth_staked_available IS NULL OR bandwidth_staked_available >= 0),
  CHECK (bandwidth_free_available IS NULL OR bandwidth_free_available >= 0),
  CHECK (bandwidth_source IS NULL OR bandwidth_source IN ('STAKED', 'FREE', 'TRX')),
  CHECK (bandwidth_unit_price_sun IS NULL OR bandwidth_unit_price_sun >= 0),
  CHECK (estimated_bandwidth_burn_sun IS NULL OR estimated_bandwidth_burn_sun >= 0),
  CHECK (owner_balance_sun IS NULL OR owner_balance_sun >= 0),
  CHECK (fee_limit_sun IS NULL OR fee_limit_sun >= 0),
  CHECK (minimum_fee_limit_sun IS NULL OR minimum_fee_limit_sun >= 0),
  CHECK (maximum_fee_limit_sun IS NULL OR maximum_fee_limit_sun > 0),
  CHECK (energy_available_after IS NULL OR energy_available_after >= 0),
  CHECK (receipt_energy_usage_total IS NULL OR receipt_energy_usage_total >= 0),
  CHECK (receipt_energy_usage IS NULL OR receipt_energy_usage >= 0),
  CHECK (receipt_origin_energy_usage IS NULL OR receipt_origin_energy_usage >= 0),
  CHECK (receipt_net_usage IS NULL OR receipt_net_usage >= 0),
  CHECK (receipt_net_fee_sun IS NULL OR receipt_net_fee_sun >= 0),
  CHECK (receipt_energy_fee_sun IS NULL OR receipt_energy_fee_sun >= 0),
  CHECK (receipt_total_fee_sun IS NULL OR receipt_total_fee_sun >= 0),
  CHECK (receipt_result IS NULL OR char_length(receipt_result) BETWEEN 1 AND 64)
);

ALTER TABLE energy_providers
  DROP CONSTRAINT IF EXISTS energy_providers_kuaizu_package_max_check;

UPDATE energy_providers
   SET max_energy_per_order = 131000,
       daily_energy_limit = GREATEST(daily_energy_limit, 131000),
       updated_at = NOW()
 WHERE provider_type = 'kuaizu'
   AND max_energy_per_order = 130000;

ALTER TABLE energy_providers
  ADD CONSTRAINT energy_providers_kuaizu_package_max_check
  CHECK (provider_type <> 'kuaizu' OR max_energy_per_order <= 131000);
