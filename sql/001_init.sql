CREATE TABLE IF NOT EXISTS address_bindings (
  address                 TEXT PRIMARY KEY,
  label                   TEXT,
  enabled                 BOOLEAN NOT NULL DEFAULT TRUE,
  max_transactions        BIGINT,
  used_transactions       BIGINT NOT NULL DEFAULT 0,
  reserved_transactions   BIGINT NOT NULL DEFAULT 0,
  expires_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (max_transactions IS NULL OR max_transactions >= 0),
  CHECK (used_transactions >= 0),
  CHECK (reserved_transactions >= 0)
);

CREATE TABLE IF NOT EXISTS broadcast_requests (
  tx_id                   CHAR(64) PRIMARY KEY,
  owner_address           TEXT NOT NULL,
  contract_type           INTEGER NOT NULL,
  contract_address        TEXT,
  function_selector       CHAR(8),
  expiration_ms           BIGINT NOT NULL,
  state                   TEXT NOT NULL,
  energy_required         BIGINT,
  energy_deficit          BIGINT,
  bandwidth_required      BIGINT,
  bandwidth_deficit       BIGINT,
  quota_reserved          BOOLEAN NOT NULL DEFAULT FALSE,
  upstream_response       BYTEA,
  upstream_grpc_status    TEXT,
  error_code              TEXT,
  error_message           TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS broadcast_requests_state_idx
  ON broadcast_requests (state, updated_at);

CREATE TABLE IF NOT EXISTS resource_leases (
  id                      BIGSERIAL PRIMARY KEY,
  tx_id                   CHAR(64) NOT NULL REFERENCES broadcast_requests(tx_id),
  resource_type           TEXT NOT NULL CHECK (resource_type IN ('ENERGY', 'BANDWIDTH')),
  resource_owner_address  TEXT NOT NULL,
  receiver_address        TEXT NOT NULL,
  balance_sun             BIGINT NOT NULL CHECK (balance_sun > 0),
  delegate_tx_id          CHAR(64),
  undelegate_tx_id        CHAR(64),
  state                   TEXT NOT NULL,
  release_after           TIMESTAMPTZ,
  error_message           TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tx_id, resource_type)
);

CREATE INDEX IF NOT EXISTS resource_leases_state_idx
  ON resource_leases (state, release_after);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version                 TEXT PRIMARY KEY,
  applied_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
