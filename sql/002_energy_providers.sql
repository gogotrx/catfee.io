CREATE TABLE IF NOT EXISTS energy_providers (
  id                      BIGSERIAL PRIMARY KEY,
  provider_type           TEXT NOT NULL,
  name                    TEXT NOT NULL UNIQUE,
  enabled                 BOOLEAN NOT NULL DEFAULT FALSE,
  priority                INTEGER NOT NULL DEFAULT 100,
  rent_time               SMALLINT NOT NULL,
  max_energy_per_order    BIGINT NOT NULL DEFAULT 200000,
  daily_order_limit       BIGINT NOT NULL DEFAULT 10,
  daily_energy_limit      BIGINT NOT NULL DEFAULT 1000000,
  credential_id           UUID NOT NULL UNIQUE,
  credential_version      INTEGER NOT NULL DEFAULT 1,
  api_key_encrypted       BYTEA NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (provider_type ~ '^[a-z][a-z0-9_-]{0,31}$'),
  CHECK (char_length(name) BETWEEN 1 AND 100),
  CHECK (priority BETWEEN 0 AND 1000000),
  CHECK (rent_time IN (1, 15)),
  CHECK (max_energy_per_order BETWEEN 1 AND 10000000),
  CHECK (daily_order_limit BETWEEN 1 AND 1000000),
  CHECK (daily_energy_limit BETWEEN max_energy_per_order AND 1000000000000),
  CHECK (credential_version >= 1),
  CHECK (octet_length(api_key_encrypted) > 31)
);

CREATE INDEX IF NOT EXISTS energy_providers_enabled_priority_idx
  ON energy_providers (priority, id) WHERE enabled;

CREATE TABLE IF NOT EXISTS energy_provider_orders (
  id                      BIGSERIAL PRIMARY KEY,
  tx_id                   CHAR(64) NOT NULL UNIQUE REFERENCES broadcast_requests(tx_id) ON DELETE RESTRICT,
  provider_id             BIGINT REFERENCES energy_providers(id) ON DELETE RESTRICT,
  receive_address         TEXT NOT NULL,
  energy_amount           BIGINT NOT NULL,
  rent_time               SMALLINT,
  state                   TEXT NOT NULL,
  provider_order_id       TEXT,
  provider_balance_trx    NUMERIC(38, 18),
  order_cost_trx          NUMERIC(38, 18),
  delegation_tx_hash      CHAR(64),
  sender_addresses        TEXT[],
  failure_code            TEXT,
  failure_message         TEXT,
  attempts                JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (tx_id ~ '^[0-9a-f]{64}$'),
  CHECK (energy_amount BETWEEN 1 AND 10000000),
  CHECK (rent_time IS NULL OR rent_time IN (1, 15)),
  CHECK (state IN ('PENDING', 'ORDERING', 'ACCEPTED', 'FULFILLED', 'REJECTED', 'UNKNOWN')),
  CHECK (jsonb_typeof(attempts) = 'array'),
  CHECK (jsonb_array_length(attempts) <= 256)
);

CREATE INDEX IF NOT EXISTS energy_provider_orders_state_idx
  ON energy_provider_orders (state, updated_at);

CREATE INDEX IF NOT EXISTS energy_provider_orders_provider_idx
  ON energy_provider_orders (provider_id, created_at DESC);

CREATE TABLE IF NOT EXISTS energy_provider_budget_ledger (
  id                      BIGSERIAL PRIMARY KEY,
  utc_day                 DATE NOT NULL,
  order_id                BIGINT NOT NULL REFERENCES energy_provider_orders(id) ON DELETE RESTRICT,
  provider_id             BIGINT NOT NULL REFERENCES energy_providers(id) ON DELETE RESTRICT,
  energy_amount           BIGINT NOT NULL,
  state                   TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, provider_id),
  CHECK (energy_amount BETWEEN 1 AND 10000000),
  CHECK (state IN ('RESERVED', 'CHARGED', 'RELEASED'))
);

CREATE INDEX IF NOT EXISTS energy_provider_budget_ledger_day_state_idx
  ON energy_provider_budget_ledger (utc_day, state, provider_id);

CREATE OR REPLACE FUNCTION protect_energy_provider_budget_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.utc_day IS DISTINCT FROM OLD.utc_day
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
     OR NEW.energy_amount IS DISTINCT FROM OLD.energy_amount THEN
    RAISE EXCEPTION 'energy provider budget ledger identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS energy_provider_budget_identity_guard ON energy_provider_budget_ledger;
CREATE TRIGGER energy_provider_budget_identity_guard
BEFORE UPDATE ON energy_provider_budget_ledger
FOR EACH ROW EXECUTE FUNCTION protect_energy_provider_budget_identity();
