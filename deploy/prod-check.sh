#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${AOL_DEPLOY_ENV_FILE:-$SCRIPT_DIR/prod.env}"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

require_var() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing $name" >&2
    exit 1
  fi
}

require_var PROD_SSH_TARGET
require_var PROD_SERVICE
require_var PROD_LOCAL_HOST
require_var PROD_LOCAL_PORT
require_var PROD_PRIMARY_BASE_URL

PROD_APP_DIR="${PROD_APP_DIR:-/opt/agents_on_lightning}"
PROD_JOURNEY_DB_PATH="${PROD_JOURNEY_DB_PATH:-/var/lib/agents-on-lightning/data/journey-analytics.duckdb}"
PROD_MAX_APP_RSS_MB="${PROD_MAX_APP_RSS_MB:-384}"

SSH_ARGS=()
if [[ -n "${PROD_SSH_KEY:-}" ]]; then
  SSH_ARGS+=(-i "$PROD_SSH_KEY")
fi

FAILURES=0

check_url() {
  local label="$1"
  local url="$2"
  local expected="${3:-200}"
  local code
  code="$(curl -L -sS -o /dev/null -w '%{http_code}' --max-time 20 "$url" || true)"
  if [[ "$code" == "$expected" ]]; then
    echo "ok   $code  $label"
  else
    echo "fail $code  $label" >&2
    FAILURES=1
  fi
}

check_operator_url() {
  local label="$1"
  local url="$2"
  local expected="${3:-200}"
  local code

  if [[ -n "${PROD_OPERATOR_API_SECRET:-}" ]]; then
    local auth
    auth="$(printf 'operator:%s' "$PROD_OPERATOR_API_SECRET" | base64 | tr -d '\n')"
    code="$(curl -L -sS -o /dev/null -w '%{http_code}' --max-time 20 -H "Authorization: Basic $auth" "$url" || true)"
  else
    code="$(ssh "${SSH_ARGS[@]}" "$PROD_SSH_TARGET" bash -s -- "$url" <<'EOF' || true
set -euo pipefail
URL="$1"
ENV_FILE="/etc/agents-on-lightning/agents-on-lightning.env"
SECRET="$(sudo sed -n 's/^OPERATOR_API_SECRET=//p' "$ENV_FILE" | head -n1)"
if [[ -z "$SECRET" ]]; then
  echo "missing-secret"
  exit 0
fi
curl -L -sS -o /dev/null -w '%{http_code}' --max-time 20 -H "x-operator-secret: $SECRET" "$URL"
EOF
)"
  fi

  if [[ "$code" == "$expected" ]]; then
    echo "ok   $code  $label"
  else
    echo "fail $code  $label" >&2
    FAILURES=1
  fi
}

check_remote_health_and_rss() {
  if ssh "${SSH_ARGS[@]}" "$PROD_SSH_TARGET" bash -s -- \
    "$PROD_SERVICE" "$PROD_LOCAL_HOST" "$PROD_LOCAL_PORT" "$PROD_MAX_APP_RSS_MB" <<'EOF'
set -euo pipefail
SERVICE="$1"
HOST="$2"
PORT="$3"
MAX_RSS_MB="$4"

[[ "$(systemctl is-active "$SERVICE")" == "active" ]]
curl -fsS --max-time 20 "http://$HOST:$PORT/health" >/dev/null

PID="$(systemctl show -p MainPID --value "$SERVICE")"
if [[ -z "$PID" || "$PID" == "0" ]]; then
  echo "no-main-pid" >&2
  exit 2
fi
RSS_KB="$(ps -p "$PID" -o rss= | tr -d ' ')"
RSS_MB="$(((RSS_KB + 1023) / 1024))"
echo "rss_mb=$RSS_MB"
if (( RSS_MB > MAX_RSS_MB )); then
  exit 3
fi
EOF
  then
    echo "ok   200  remote service + local /health + RSS"
  else
    echo "fail ???  remote service + local /health + RSS" >&2
    FAILURES=1
  fi
}

check_state_paths() {
  if ssh "${SSH_ARGS[@]}" "$PROD_SSH_TARGET" bash -s -- "$PROD_APP_DIR" "$PROD_JOURNEY_DB_PATH" <<'EOF'
set -euo pipefail
APP_DIR="$1"
JOURNEY_DB="$2"
CURRENT="$(readlink -f "$APP_DIR/current")"
test -d "$CURRENT"
test ! -e "$CURRENT/data/journey-analytics.duckdb"
test ! -e "$CURRENT/data/journey-analytics.duckdb.wal"
test -f "$JOURNEY_DB"
echo "current=$CURRENT"
echo "journey_db=$JOURNEY_DB"
EOF
  then
    echo "ok   ---  persistent journey DB path"
  else
    echo "fail ---  journey DB path drift" >&2
    FAILURES=1
  fi
}

echo "Checking production on $PROD_SSH_TARGET"
check_remote_health_and_rss
check_state_paths

check_url "primary /llms.txt" "$PROD_PRIMARY_BASE_URL/llms.txt"
check_url "primary /journey/ public block" "$PROD_PRIMARY_BASE_URL/journey/" "401"
check_url "primary /journey/three public block" "$PROD_PRIMARY_BASE_URL/journey/three" "401"
check_url "primary /api/journey public block" "$PROD_PRIMARY_BASE_URL/api/journey" "401"
check_operator_url "primary /journey/ operator auth" "$PROD_PRIMARY_BASE_URL/journey/"
check_operator_url "primary /api/journey operator auth" "$PROD_PRIMARY_BASE_URL/api/journey"

if [[ -n "${PROD_SECONDARY_BASE_URL:-}" ]]; then
  check_url "secondary /llms.txt" "$PROD_SECONDARY_BASE_URL/llms.txt"
  check_url "secondary /journey/ public block" "$PROD_SECONDARY_BASE_URL/journey/" "401"
  check_url "secondary /journey/three public block" "$PROD_SECONDARY_BASE_URL/journey/three" "401"
  check_url "secondary /api/journey public block" "$PROD_SECONDARY_BASE_URL/api/journey" "401"
  check_operator_url "secondary /journey/ operator auth" "$PROD_SECONDARY_BASE_URL/journey/"
  check_operator_url "secondary /api/journey operator auth" "$PROD_SECONDARY_BASE_URL/api/journey"
fi

exit "$FAILURES"
