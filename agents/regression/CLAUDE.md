# Regression Tracker Agent

Maintains per-model scorecards over time. Tracks how different AI models perform on the 21-phase platform walkthrough, detects regressions, and reports trends.

## Job

- Parse JSONL test results into per-model scorecards
- Detect score regressions (latest run scored lower than previous)
- Detect phase-specific regressions (phases that used to pass but now fail)
- Generate summary reports with heatmaps and trend data

## Files this agent owns

- `agents/regression/` -- all code and output lives here
- `agents/regression/track.mjs` -- main tracking script
- `agents/regression/scorecards/` -- per-model JSON scorecards (written by track.mjs)
- `agents/regression/reports/` -- timestamped regression reports (written by track.mjs)

## Files this agent reads

- `test/walkthrough/stress-test-results.jsonl` -- raw phase + summary results from test-runner

## Files this agent never modifies

- Anything in `test/` -- test code is not ours
- Anything in `src/` -- core platform source is not ours

## Usage

```bash
node agents/regression/track.mjs              # all models
node agents/regression/track.mjs --model gpt-4.1-nano   # single model
```
