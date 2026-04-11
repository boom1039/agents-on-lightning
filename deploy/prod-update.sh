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
require_var PROD_APP_DIR
require_var PROD_APP_USER
require_var PROD_SERVICE

PROD_RUNTIME_ARTIFACT="${PROD_RUNTIME_ARTIFACT:-}"
require_var PROD_RUNTIME_ARTIFACT

SSH_ARGS=()
if [[ -n "${PROD_SSH_KEY:-}" ]]; then
  SSH_ARGS+=(-i "$PROD_SSH_KEY")
fi

if [[ ! -f "$PROD_RUNTIME_ARTIFACT" ]]; then
  echo "Runtime artifact not found: $PROD_RUNTIME_ARTIFACT" >&2
  exit 1
fi

REMOTE_ARTIFACT="/tmp/agents-on-lightning-runtime-$(date -u +%Y%m%d%H%M%S)-$$.tar.gz"
scp "${SSH_ARGS[@]}" "$PROD_RUNTIME_ARTIFACT" "$PROD_SSH_TARGET:$REMOTE_ARTIFACT"

echo "Updating $PROD_SSH_TARGET"

ssh "${SSH_ARGS[@]}" "$PROD_SSH_TARGET" bash -s -- \
  "$PROD_APP_DIR" \
  "$PROD_APP_USER" \
  "$PROD_SERVICE" \
  "$REMOTE_ARTIFACT" <<'EOF'
set -euo pipefail

APP_DIR="$1"
APP_USER="$2"
SERVICE="$3"
RUNTIME_ARTIFACT="${4:-}"

remove_legacy_monitor() {
  local removed=0
  if sudo systemctl list-unit-files agents-on-lightning-monitor.service --no-legend 2>/dev/null | grep -q '^agents-on-lightning-monitor\.service'; then
    sudo systemctl disable --now agents-on-lightning-monitor.service || true
    sudo rm -f /etc/systemd/system/agents-on-lightning-monitor.service
    removed=1
  fi
  if [[ "$removed" == "1" ]]; then
    sudo systemctl daemon-reload
  fi
}

artifact_modules_match_host() {
  local release_dir="$1"
  local release_info="$release_dir/RELEASE.txt"
  local host_platform
  local artifact_platform

  [[ -d "$release_dir/node_modules" && -f "$release_info" ]] || return 1

  host_platform="$(uname -s)/$(uname -m)"
  artifact_platform="$(sed -n 's/^build_platform=//p' "$release_info" | head -n1)"
  [[ -n "$artifact_platform" && "$artifact_platform" == "$host_platform" ]]
}

current_runtime_deps_cover_release() {
  local current_dir="$1"
  local release_dir="$2"

  [[ -d "$current_dir/node_modules" && -f "$current_dir/package.json" && -f "$release_dir/package.json" ]] || return 1

  sudo -u "$APP_USER" node - "$current_dir/package.json" "$release_dir/package.json" <<'NODE'
const fs = require('fs');
const [currentPath, releasePath] = process.argv.slice(2);
const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
const currentDeps = current.dependencies || {};
const releaseDeps = release.dependencies || {};

for (const [name, spec] of Object.entries(releaseDeps)) {
  if (currentDeps[name] !== spec) {
    process.exit(1);
  }
}

process.exit(0);
NODE
}

restart_and_report() {
  sudo systemctl restart "$SERVICE"
  sudo systemctl is-active "$SERVICE"
  sudo -u "$APP_USER" readlink -f "$APP_DIR/current"
}

sudo install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR/data"
remove_legacy_monitor

RELEASES_DIR="$APP_DIR/releases"
CURRENT_LINK="$APP_DIR/current"
RELEASE_ID="$(date -u +%Y%m%d%H%M%S)"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
CURRENT_TARGET=""

sudo install -d -o "$APP_USER" -g "$APP_USER" "$RELEASES_DIR"
sudo -u "$APP_USER" mkdir -p "$RELEASE_DIR"
sudo -u "$APP_USER" tar -xzf "$RUNTIME_ARTIFACT" -C "$RELEASE_DIR"

if [[ ! -f "$RELEASE_DIR/package.json" || ! -f "$RELEASE_DIR/package-lock.json" || ! -f "$RELEASE_DIR/src/index.js" ]]; then
  echo "Runtime artifact is missing required runtime files." >&2
  exit 4
fi

if [[ -d "$RELEASE_DIR/node_modules" ]] && ! artifact_modules_match_host "$RELEASE_DIR"; then
  echo "Ignoring bundled node_modules because their build platform does not match this host." >&2
  sudo -u "$APP_USER" rm -rf "$RELEASE_DIR/node_modules"
fi

if [[ -e "$CURRENT_LINK" ]]; then
  CURRENT_TARGET="$(readlink -f "$CURRENT_LINK" || true)"
fi

if [[ -n "$CURRENT_TARGET" && -f "$CURRENT_TARGET/RELEASE.txt" ]]; then
  if ! artifact_modules_match_host "$CURRENT_TARGET"; then
    CURRENT_TARGET=""
  fi
fi

if [[ -z "$CURRENT_TARGET" && -d "$APP_DIR/src" && -f "$APP_DIR/package-lock.json" ]]; then
  CURRENT_TARGET="$APP_DIR"
fi

if [[ -d "$RELEASE_DIR/node_modules" ]]; then
  :
elif [[ -n "$CURRENT_TARGET" ]] && current_runtime_deps_cover_release "$CURRENT_TARGET" "$RELEASE_DIR"; then
  sudo -u "$APP_USER" ln -s "$CURRENT_TARGET/node_modules" "$RELEASE_DIR/node_modules"
else
  echo "Runtime artifact needs host-compatible dependencies." >&2
  echo "Deploy from a matching Linux builder with bundled dependencies, or seed prod dependencies during a maintenance window." >&2
  exit 2
fi

sudo ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
sudo chown -h "$APP_USER:$APP_USER" "$CURRENT_LINK"
sudo rm -f "$RUNTIME_ARTIFACT"

restart_and_report
EOF
