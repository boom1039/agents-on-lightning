#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
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
require_var PROD_APP_DIR
require_var PROD_APP_USER
require_var PROD_SERVICE
require_var PROD_LOCAL_HOST
require_var PROD_LOCAL_PORT
require_var PROD_PRIMARY_BASE_URL

PROOF_REQUESTS="${AOL_DEPLOY_PROOF_REQUESTS:-1000}"
PROOF_CONCURRENCY="${AOL_DEPLOY_PROOF_CONCURRENCY:-16}"
PROOF_RPS="${AOL_DEPLOY_PROOF_RPS:-200}"

cd "$ROOT_DIR"

echo "1/5 pre-deploy proof"
if [[ "${AOL_DEPLOY_SKIP_PROOF:-0}" != "1" ]]; then
  npm run proof:hardening -- \
    "--requests=$PROOF_REQUESTS" \
    "--concurrency=$PROOF_CONCURRENCY" \
    "--rps=$PROOF_RPS"
else
  echo "skip proof: AOL_DEPLOY_SKIP_PROOF=1"
fi

echo "2/5 build runtime artifact"
ARTIFACT_PATH="$(bash "$SCRIPT_DIR/build-runtime-artifact.sh" | tail -n1)"
echo "artifact=$ARTIFACT_PATH"

echo "3/5 deploy artifact"
PROD_RUNTIME_ARTIFACT="$ARTIFACT_PATH" bash "$SCRIPT_DIR/prod-update.sh"

echo "4/5 prod smoke"
bash "$SCRIPT_DIR/prod-check.sh"

echo "5/5 hosted MCP and public surface"
npm run test:mcp:prod
npm run test:surface:prod

echo "deploy_ok=1"
