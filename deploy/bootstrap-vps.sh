#!/usr/bin/env bash

set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "This script must be run as root." >&2
  exit 1
fi

if [[ "$#" -ne 1 ]]; then
  echo "Usage: $0 <java-tron-lan-ip>" >&2
  exit 1
fi

node_host="$1"
app_dir="/opt/tron-seamless"
config_dir="/etc/tron-seamless"
gateway_env="${config_dir}/gateway.env"

if [[ ! "${node_host}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo "java-tron host must be an IPv4 address." >&2
  exit 1
fi

for command_name in openssl psql runuser systemctl install; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Required command is missing: ${command_name}" >&2
    exit 1
  fi
done

if [[ ! -f "${app_dir}/dist/migrate.js" || ! -f "${app_dir}/sql/001_init.sql" ]]; then
  echo "Built application files are missing from ${app_dir}." >&2
  exit 1
fi

if [[ -e "${gateway_env}" ]]; then
  echo "Refusing to overwrite existing ${gateway_env}." >&2
  exit 1
fi

if ! systemctl is-active --quiet postgresql.service; then
  echo "PostgreSQL is not active." >&2
  exit 1
fi

umask 0077
database_password="$(openssl rand -hex 32)"
admin_token="$(openssl rand -hex 32)"
signer_token="$(openssl rand -hex 32)"
provider_master_key="$(openssl rand -hex 32)"
database_url="postgresql://seamless:${database_password}@127.0.0.1:5432/seamless"
temporary_env="$(mktemp)"
trap 'rm -f "${temporary_env}"' EXIT

if [[ "$(runuser -u postgres -- psql --no-psqlrc -Atqc "SELECT 1 FROM pg_roles WHERE rolname = 'seamless'" postgres)" != "1" ]]; then
  runuser -u postgres -- psql --no-psqlrc --set=ON_ERROR_STOP=1 postgres <<'SQL'
CREATE ROLE seamless LOGIN;
SQL
fi

runuser -u postgres -- psql --no-psqlrc --set=ON_ERROR_STOP=1 \
  --set=db_password="${database_password}" postgres <<'SQL'
ALTER ROLE seamless WITH LOGIN PASSWORD :'db_password';
SQL

if [[ "$(runuser -u postgres -- psql --no-psqlrc -Atqc "SELECT 1 FROM pg_database WHERE datname = 'seamless'" postgres)" != "1" ]]; then
  runuser -u postgres -- createdb --owner=seamless seamless
fi

install -d -o root -g root -m 0750 "${config_dir}"
cat >"${temporary_env}" <<EOF
GATEWAY_MODE=sponsor
GATEWAY_LISTEN_HOST=0.0.0.0
GATEWAY_GRPC_PORT=50051
MAX_BROADCAST_BYTES=4194304
UPSTREAM_GRPC_URL=http://${node_host}:50051
NODE_HTTP_URL=http://${node_host}:8090
NODE_SOLIDITY_HTTP_URL=http://${node_host}:8091
NODE_REQUEST_TIMEOUT_MS=10000
DATABASE_URL=${database_url}
ADMIN_LISTEN_HOST=127.0.0.1
ADMIN_PORT=8080
ADMIN_TOKEN=${admin_token}
AUTH_MODE=bound_address
AUTH_ENFORCE_IN_OBSERVE=false
ALLOWED_CONTRACTS=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
ALLOWED_SELECTORS=a9059cbb,095ea7b3
UNSUPPORTED_POLICY=reject
INSUFFICIENT_POLICY=reject
MIN_TRANSACTION_TTL_MS=5000
MAX_TRANSACTION_TTL_MS=600000
MAX_TRANSACTION_AGE_MS=120000
MAX_TRANSACTION_FUTURE_SKEW_MS=30000
SPONSOR_ENERGY=true
SPONSOR_BANDWIDTH=false
ENERGY_SOURCE=provider
ESTIMATE_SAFETY_BPS=11500
ALLOW_OWNER_BANDWIDTH_BURN=true
MAX_OWNER_BANDWIDTH_BURN_SUN=1000000
ALLOW_OWNER_ENERGY_BURN=false
MAX_OWNER_ENERGY_BURN_SUN=5000000
MIN_DELEGATE_SUN=1000000
DELEGATION_CONFIRM_TIMEOUT_MS=12000
DELEGATION_POLL_MS=400
PROVIDER_MASTER_KEY=${provider_master_key}
PROVIDER_ORDER_TIMEOUT_MS=5000
PROVIDER_CONFIRM_TIMEOUT_MS=10000
PROVIDER_POLL_MS=250
PROVIDER_MAX_ENERGY_PER_ORDER=200000
PROVIDER_DAILY_MAX_ORDERS=20
PROVIDER_DAILY_MAX_ENERGY=2000000
SIGNER_URL=http://127.0.0.1:8787
SIGNER_TOKEN=${signer_token}
CONFIRMATION_INTERVAL_MS=3000
RECLAIM_INTERVAL_MS=5000
RECLAIM_DELAY_MS=15000
LOG_LEVEL=info
EOF
install -o root -g tron-seamless -m 0640 "${temporary_env}" "${gateway_env}"

(
  cd "${app_dir}"
  runuser -u tron-seamless -- env DATABASE_URL="${database_url}" \
    /usr/bin/node dist/migrate.js
)

install -o root -g root -m 0644 \
  "${app_dir}/deploy/systemd/seamless-gateway.service" \
  /etc/systemd/system/seamless-gateway.service
install -o root -g root -m 0644 \
  "${app_dir}/deploy/systemd/seamless-signer.service" \
  /etc/systemd/system/seamless-signer.service
systemctl daemon-reload

echo "VPS bootstrap completed."
echo "The gateway remains disabled and stopped in observe mode."
echo "The signer remains disabled and unconfigured; no private key was installed."
