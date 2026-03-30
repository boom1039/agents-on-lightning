# Tester Agent

Runs the 21-phase walkthrough tests against AI models, tracks scores over time, and flags regressions.

## Job

- Execute walkthrough tests against one or more AI models
- Compare results across runs and models
- Generate scorecards and regression reports
- Flag when a model's score drops from a previous run

## Files

### Owns (read/write)

- `agents/tester/` — this directory
- `agents/tester/reports/` — timestamped test run outputs
- `agents/tester/scorecards/` — per-model JSON scorecards

### Reads (never modifies)

- `test/walkthrough/` — test runner, shared utilities, JSONL results
- `docs/llms.txt` — API reference (to understand what agents are tested against)
- `src/routes/` — route handlers (to understand test failures)

### Never touches

- `src/` — core platform code
- `test/walkthrough/test-runner.mjs` — the test runner itself
- `test/walkthrough/shared.mjs` — shared test utilities

## Commands

```bash
# Run tests against default model (gpt-4.1-nano)
./agents/tester/run.sh

# Run tests against specific models
./agents/tester/run.sh --models gpt-4.1-nano,gpt-4.1-mini

# Run with feedback mode
./agents/tester/run.sh --models gpt-4.1-nano --mode both

# Compare results from all runs
node agents/tester/compare.mjs
```

## Results format

The test runner writes JSONL to `test/walkthrough/stress-test-results.jsonl`. Each line is either:
- A **phase result**: `{ type: "phase", model, phase, passed, reason, ... }`
- A **run summary**: `{ mode: "navigation", model, score: "X/Y", phases: {...}, ... }`

The compare script reads these, groups by model, and produces text tables and JSON scorecards.
