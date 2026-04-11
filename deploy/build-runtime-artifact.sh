#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${1:-$ROOT_DIR/output/runtime-artifacts}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aol-runtime.XXXXXX")"
APP_STAGE="$STAGE_DIR/app"
ARTIFACT_PATH="$OUT_DIR/agents-on-lightning-runtime-$STAMP.tar.gz"
AOL_RUNTIME_INCLUDE_NODE_MODULES="${AOL_RUNTIME_INCLUDE_NODE_MODULES:-0}"
BUILD_PLATFORM="$(uname -s)/$(uname -m)"

cleanup() {
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

copy_path() {
  local rel="$1"
  local src="$ROOT_DIR/$rel"
  local dest="$APP_STAGE/$rel"
  mkdir -p "$(dirname "$dest")"
  if [[ -d "$src" ]]; then
    cp -R "$src" "$dest"
  else
    cp "$src" "$dest"
  fi
}

mkdir -p "$OUT_DIR" "$APP_STAGE"

RUNTIME_PATHS=(
  "src"
  "config/default.yaml"
  "docs/llms.txt"
  "docs/llms-mcp.txt"
  "docs/mcp"
  "docs/skills"
  "docs/knowledge"
  "monitoring_dashboards/journey"
  "monitoring_dashboards/live"
  "package.json"
  "package-lock.json"
)

for rel in "${RUNTIME_PATHS[@]}"; do
  copy_path "$rel"
done

find "$APP_STAGE/src" \( -name '*.test.js' -o -name 'test-*.js' \) -delete

if [[ "$(uname -s)" == "Darwin" ]] && command -v xattr >/dev/null 2>&1; then
  xattr -cr "$APP_STAGE" || true
fi

INCLUDES_LINE="includes=src,config/default.yaml,docs,mcp-docs,journey-assets,live-dashboard,manifests-only"
if [[ "$AOL_RUNTIME_INCLUDE_NODE_MODULES" == "1" ]]; then
  (
    cd "$APP_STAGE"
    npm ci --omit=dev --ignore-scripts
  )

  find "$APP_STAGE/node_modules" \
    \( -type d \( -name test -o -name tests -o -name __tests__ -o -name example -o -name examples -o -name benchmark -o -name benchmarks \) -prune -exec rm -rf {} + \)
  find "$APP_STAGE/node_modules" \
    \( -name '*.test.js' -o -name '*.test.ts' -o -name '*.spec.js' -o -name '*.spec.ts' -o -name 'test-*.js' -o -name 'test-*.ts' -o -name '*.tsbuildinfo' \) -delete
  INCLUDES_LINE="includes=src,config/default.yaml,docs,mcp-docs,journey-assets,live-dashboard,prod-node-modules"
fi

cat > "$APP_STAGE/RELEASE.txt" <<EOF
artifact=$ARTIFACT_PATH
git_sha=$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)
built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
build_platform=$BUILD_PLATFORM
$INCLUDES_LINE
EOF

(
  cd "$APP_STAGE"
  export LC_ALL=C
  export COPYFILE_DISABLE=1
  export COPY_EXTENDED_ATTRIBUTES_DISABLE=1
  TAR_ARGS=(-czf "$ARTIFACT_PATH")
  if [[ "$(uname -s)" == "Darwin" ]]; then
    TAR_ARGS+=(--disable-copyfile)
    TAR_ARGS+=(--format ustar)
  fi
  tar "${TAR_ARGS[@]}" .
)

printf '%s\n' "$ARTIFACT_PATH"
