#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${AOL_DEPLOY_ENV_FILE:-$SCRIPT_DIR/prod.env}"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

usage() {
  echo 'Usage: npm run prod:analytics:query -- --sql "SELECT * FROM mcp_tool_events LIMIT 20"'
}

SQL=""
PARAMS_JSON="[]"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sql)
      SQL="${2:-}"
      shift 2
      ;;
    --params)
      PARAMS_JSON="${2:-[]}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$SQL" ]]; then
  usage >&2
  exit 2
fi

require_var() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing $name" >&2
    exit 1
  fi
}

require_var PROD_SSH_TARGET
require_var PROD_LOCAL_HOST
require_var PROD_LOCAL_PORT

SSH_ARGS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new)
if [[ -n "${PROD_SSH_KEY:-}" ]]; then
  SSH_ARGS+=(-i "$PROD_SSH_KEY")
fi

PAYLOAD_B64="$(
  node --input-type=module - "$SQL" "$PARAMS_JSON" <<'NODE'
const [sql, paramsRaw] = process.argv.slice(2);
let params;
try {
  params = JSON.parse(paramsRaw);
} catch (err) {
  console.error(`Invalid --params JSON: ${err.message}`);
  process.exit(2);
}
if (!Array.isArray(params)) {
  console.error('--params must be a JSON array');
  process.exit(2);
}
const payload = JSON.stringify({ sql, params });
process.stdout.write(Buffer.from(payload).toString('base64'));
NODE
)"

ssh "${SSH_ARGS[@]}" "$PROD_SSH_TARGET" bash -s -- \
  "$PROD_LOCAL_HOST" "$PROD_LOCAL_PORT" "$PAYLOAD_B64" <<'REMOTE'
set -euo pipefail
HOST="$1"
PORT="$2"
PAYLOAD_B64="$3"
ENV_FILE="/etc/agents-on-lightning/agents-on-lightning.env"
SECRET="$(sudo sed -n 's/^OPERATOR_API_SECRET=//p' "$ENV_FILE" | head -n1)"
if [[ -z "$SECRET" ]]; then
  echo "missing OPERATOR_API_SECRET in $ENV_FILE" >&2
  exit 1
fi
PAYLOAD="$(printf '%s' "$PAYLOAD_B64" | base64 -d)"
curl -sS \
  -X POST \
  -H 'content-type: application/json' \
  -H "x-operator-secret: $SECRET" \
  --data "$PAYLOAD" \
  "http://$HOST:$PORT/api/analytics/query"
REMOTE
echo
