#!/usr/bin/env bash
# Tester agent — run walkthrough tests and save timestamped reports.
#
# Usage:
#   ./agents/tester/run.sh                              # default: gpt-4.1-nano
#   ./agents/tester/run.sh --models gpt-4.1-nano,gpt-4.1-mini
#   ./agents/tester/run.sh --models gpt-4.1-nano --mode both

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REPORTS_DIR="$SCRIPT_DIR/reports"
RUNNER="$PROJECT_ROOT/test/walkthrough/test-runner.mjs"
RESULTS_FILE="$PROJECT_ROOT/test/walkthrough/stress-test-results.jsonl"

MODELS="gpt-4.1-nano"
MODE="navigation"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --models) MODELS="$2"; shift 2 ;;
    --mode)   MODE="$2";   shift 2 ;;
    *)        echo "Unknown arg: $1"; exit 1 ;;
  esac
done

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
REPORT_FILE="$REPORTS_DIR/${TIMESTAMP}-${MODELS//,/_}.txt"

echo "=== Tester Agent ==="
echo "Models:  $MODELS"
echo "Mode:    $MODE"
echo "Report:  $REPORT_FILE"
echo ""

# Snapshot line count before the run so we can extract new results
LINES_BEFORE=0
if [[ -f "$RESULTS_FILE" ]]; then
  LINES_BEFORE=$(wc -l < "$RESULTS_FILE" | tr -d ' ')
fi

# Run the test
node "$RUNNER" --models "$MODELS" --mode "$MODE" 2>&1 | tee "$REPORT_FILE"

# Extract new JSONL lines appended during this run
if [[ -f "$RESULTS_FILE" ]]; then
  LINES_AFTER=$(wc -l < "$RESULTS_FILE" | tr -d ' ')
  NEW_LINES=$((LINES_AFTER - LINES_BEFORE))
  if [[ $NEW_LINES -gt 0 ]]; then
    tail -n "$NEW_LINES" "$RESULTS_FILE" > "$REPORTS_DIR/${TIMESTAMP}-results.jsonl"
    echo ""
    echo "Saved $NEW_LINES new result lines to $REPORTS_DIR/${TIMESTAMP}-results.jsonl"
  fi
fi

# Generate comparison if previous results exist
RESULT_COUNT=0
if [[ -f "$RESULTS_FILE" ]]; then
  RESULT_COUNT=$(wc -l < "$RESULTS_FILE" | tr -d ' ')
fi

if [[ $RESULT_COUNT -gt 0 ]]; then
  echo ""
  echo "=== Score Comparison ==="
  node "$SCRIPT_DIR/compare.mjs"
fi
