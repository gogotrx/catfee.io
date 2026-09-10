CREATE TABLE IF NOT EXISTS sponsor_address_claims (
  owner_address           TEXT PRIMARY KEY,
  tx_id                   CHAR(64) NOT NULL UNIQUE REFERENCES broadcast_requests(tx_id) ON DELETE RESTRICT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (tx_id ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS sponsor_address_claims_created_idx
  ON sponsor_address_claims (created_at);
