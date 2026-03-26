#!/usr/bin/env bash
# Interactive Outside Agent — blank slate with one tool.
# Opens a terminal session where you tell the agent what to do.
#
# Usage:
#   ./run.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Set ANTHROPIC_API_KEY first"
  exit 1
fi

exec node "$SCRIPT_DIR/agent.mjs" "$@"
