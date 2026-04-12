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

cd "$ROOT_DIR"

echo "1/3 build runtime artifact"
ARTIFACT_PATH="$(bash "$SCRIPT_DIR/build-runtime-artifact.sh" | tail -n1)"
echo "artifact=$ARTIFACT_PATH"

echo "2/3 deploy artifact"
PROD_RUNTIME_ARTIFACT="$ARTIFACT_PATH" bash "$SCRIPT_DIR/prod-update.sh"

echo "3/3 fast prod smoke"
bash "$SCRIPT_DIR/prod-check-fast.sh"

echo "deploy_fast_ok=1"
