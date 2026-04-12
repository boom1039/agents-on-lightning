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
require_var PROD_SERVICE
require_var PROD_LOCAL_HOST
require_var PROD_LOCAL_PORT
require_var PROD_PRIMARY_BASE_URL

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
  code="$(curl -L -sS -o /dev/null -w '%{http_code}' --max-time 12 "$url" || true)"
  if [[ "$code" == "$expected" ]]; then
    echo "ok   $code  $label"
  else
    echo "fail $code  $label" >&2
    FAILURES=1
  fi
}

check_remote_health() {
  if ssh "${SSH_ARGS[@]}" "$PROD_SSH_TARGET" bash -s -- "$PROD_SERVICE" "$PROD_LOCAL_HOST" "$PROD_LOCAL_PORT" <<'EOF'
set -euo pipefail
SERVICE="$1"
HOST="$2"
PORT="$3"

[[ "$(systemctl is-active "$SERVICE")" == "active" ]]
for attempt in $(seq 1 20); do
  if curl -fsS --max-time 3 "http://$HOST:$PORT/health" >/dev/null 2>&1; then
    exit 0
  fi
  sleep 0.5
done
exit 4
EOF
  then
    echo "ok   200  remote service + local /health"
  else
    echo "fail ???  remote service + local /health" >&2
    FAILURES=1
  fi
}

check_root_json() {
  node --input-type=module - "$PROD_PRIMARY_BASE_URL" "$ROOT_DIR" <<'NODE'
import { pathToFileURL } from 'node:url';

const baseUrl = process.argv[2];
const rootDir = process.argv[3];
const { getMcpDoc } = await import(new URL('src/mcp/catalog.js', pathToFileURL(`${rootDir}/`)));
const referenceDoc = getMcpDoc('reference');
const referencePath = referenceDoc ? `/docs/mcp/${referenceDoc.file}` : null;
const response = await fetch(new URL('/', baseUrl));
if (!response.ok) throw new Error(`GET / returned ${response.status}`);
const body = await response.json();
const required = {
  name: 'Agents on Lightning',
  agent_start: '/llms.txt',
  mcp_endpoint: '/mcp',
  tool_reference: referencePath,
};
for (const [key, value] of Object.entries(required)) {
  if (body[key] !== value) throw new Error(`root ${key}=${JSON.stringify(body[key])}`);
}
for (const key of ['api', 'machine_start', 'machine_note', 'mcp_start', 'links', 'primary_doc']) {
  if (Object.hasOwn(body, key)) throw new Error(`root still exposes ${key}`);
}
if (body.discovery?.mcp_manifest !== '/.well-known/mcp.json') throw new Error('root discovery manifest missing');
NODE
}

check_mcp_docs() {
  local label="$1"
  local base_url="$2"
  node --input-type=module - "$base_url" "$label" "$ROOT_DIR" <<'NODE'
import { pathToFileURL } from 'node:url';

const [baseUrl, label, rootDir] = process.argv.slice(2);
const { PUBLIC_MCP_DOC_PATHS } = await import(new URL('src/mcp/catalog.js', pathToFileURL(`${rootDir}/`)));
let failures = 0;
for (const docPath of PUBLIC_MCP_DOC_PATHS) {
  const response = await fetch(new URL(docPath, baseUrl));
  await response.arrayBuffer();
  if (response.status === 200) {
    console.log(`ok   200  ${label} ${docPath}`);
  } else {
    console.error(`fail ${response.status}  ${label} ${docPath}`);
    failures = 1;
  }
}
process.exit(failures);
NODE
}

echo "Fast checking production on $PROD_SSH_TARGET"
check_remote_health
if check_root_json; then
  echo "ok   200  primary / root json shape"
else
  echo "fail ???  primary / root json shape" >&2
  FAILURES=1
fi
check_url "primary /llms.txt" "$PROD_PRIMARY_BASE_URL/llms.txt"
check_url "primary /.well-known/mcp.json" "$PROD_PRIMARY_BASE_URL/.well-known/mcp.json"
check_url "primary /.well-known/mcp/server-card.json" "$PROD_PRIMARY_BASE_URL/.well-known/mcp/server-card.json"
check_url "primary /.well-known/agent-card.json" "$PROD_PRIMARY_BASE_URL/.well-known/agent-card.json"
check_url "primary /mcp discovery" "$PROD_PRIMARY_BASE_URL/mcp"
if ! check_mcp_docs "primary" "$PROD_PRIMARY_BASE_URL"; then
  FAILURES=1
fi
check_url "primary /api/v1 hidden externally" "$PROD_PRIMARY_BASE_URL/api/v1/" "404"
check_url "primary /docs/skills hidden externally" "$PROD_PRIMARY_BASE_URL/docs/skills/discovery.txt" "404"

exit "$FAILURES"
