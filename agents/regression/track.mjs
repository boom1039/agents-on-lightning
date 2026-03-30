#!/usr/bin/env node
/**
 * Regression Tracker — reads stress-test-results.jsonl, builds per-model
 * scorecards, detects regressions, prints a summary report.
 *
 * Usage:
 *   node agents/regression/track.mjs                     # all models
 *   node agents/regression/track.mjs --model gpt-4.1-nano  # single model
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const RESULTS_FILE = join(PROJECT_ROOT, 'test', 'walkthrough', 'stress-test-results.jsonl');
const SCORECARDS_DIR = join(__dirname, 'scorecards');
const REPORTS_DIR = join(__dirname, 'reports');

// ─── CLI ───

const args = process.argv.slice(2);
function opt(name) {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}
const MODEL_FILTER = opt('--model');

// ─── Parse JSONL ───

function readResults() {
  if (!existsSync(RESULTS_FILE)) {
    console.error(`No results file at ${RESULTS_FILE}`);
    process.exit(1);
  }
  return readFileSync(RESULTS_FILE, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// ─── Group entries into runs ───
// Entries within 5 minutes of each other (per model) belong to the same run.

const RUN_GAP_MS = 5 * 60 * 1000;

function groupIntoRuns(entries) {
  // model -> [ { ts, phases: [...], summary: {...} | null } ]
  const models = {};

  for (const e of entries) {
    if (!e.model) continue;
    if (!models[e.model]) models[e.model] = [];
    models[e.model].push(e);
  }

  const result = {};

  for (const [model, rows] of Object.entries(models)) {
    rows.sort((a, b) => new Date(a.ts) - new Date(b.ts));

    const runs = [];
    let current = null;

    for (const row of rows) {
      const ts = new Date(row.ts).getTime();
      if (!current || ts - current.lastTs > RUN_GAP_MS) {
        current = { ts: row.ts, lastTs: ts, phases: [], summary: null };
        runs.push(current);
      }
      current.lastTs = ts;

      if (row.type === 'phase') {
        current.phases.push(row);
      } else if (row.mode === 'navigation') {
        current.summary = row;
      }
    }

    result[model] = runs;
  }

  return result;
}

// ─── Build scorecard for a model ───

function buildScorecard(model, runs) {
  const runRecords = [];

  for (const run of runs) {
    const summary = run.summary;
    const phases = run.phases;

    // Derive passed/total from summary if available, else from phases
    let passed, total;
    if (summary && summary.score) {
      const [p, t] = summary.score.split('/').map(Number);
      passed = p;
      total = t;
    } else {
      passed = phases.filter(p => p.passed).length;
      total = phases.length;
    }

    const totalTokens = summary
      ? (summary.total_tokens || 0)
      : phases.reduce((s, p) => s + (p.token_usage || 0), 0);

    const totalLatency = summary
      ? (summary.duration_ms || 0)
      : phases.reduce((s, p) => s + (p.phase_duration_ms || 0), 0);

    const totalHttpCalls = summary
      ? (summary.total_http_calls || 0)
      : phases.reduce((s, p) => s + (p.http_calls || 0), 0);

    // Per-phase results
    const phaseResults = {};
    for (const p of phases) {
      phaseResults[p.phase] = {
        passed: p.passed,
        reason: p.reason || '',
        duration_ms: p.phase_duration_ms || 0,
        tokens: p.token_usage || 0,
      };
    }

    runRecords.push({
      date: run.ts,
      score: `${passed}/${total}`,
      passed,
      total,
      total_tokens: totalTokens,
      total_latency_ms: totalLatency,
      total_http_calls: totalHttpCalls,
      phases: phaseResults,
    });
  }

  return { model, runs: runRecords, updated: new Date().toISOString() };
}

// ─── Detect regressions ───

function detectRegressions(scorecard) {
  const runs = scorecard.runs;
  if (runs.length < 2) return { overall: null, phases: [] };

  const latest = runs[runs.length - 1];
  const previous = runs[runs.length - 2];

  const overall = latest.passed < previous.passed
    ? { from: previous.score, to: latest.score, delta: latest.passed - previous.passed }
    : null;

  // Phase-specific: phases that passed before but fail now
  const phaseRegressions = [];
  for (const [phase, result] of Object.entries(latest.phases)) {
    if (!result.passed && previous.phases[phase] && previous.phases[phase].passed) {
      phaseRegressions.push(phase);
    }
  }

  return { overall, phases: phaseRegressions };
}

// ─── Phase failure heatmap ───

function buildHeatmap(allScorecards) {
  // phase -> { total_runs, failures, failing_models }
  const heatmap = {};

  for (const sc of allScorecards) {
    for (const run of sc.runs) {
      for (const [phase, result] of Object.entries(run.phases)) {
        if (!heatmap[phase]) heatmap[phase] = { total_runs: 0, failures: 0, failing_models: new Set() };
        heatmap[phase].total_runs++;
        if (!result.passed) {
          heatmap[phase].failures++;
          heatmap[phase].failing_models.add(sc.model);
        }
      }
    }
  }

  // Sort by failure count descending
  return Object.entries(heatmap)
    .map(([phase, data]) => ({
      phase,
      failures: data.failures,
      total_runs: data.total_runs,
      fail_rate: `${Math.round(100 * data.failures / data.total_runs)}%`,
      failing_models: [...data.failing_models],
    }))
    .sort((a, b) => b.failures - a.failures);
}

// ─── Text report ───

function printReport(scorecards, regressions, heatmap) {
  const sep = '─'.repeat(80);

  console.log();
  console.log(sep);
  console.log('  REGRESSION TRACKER REPORT');
  console.log(`  ${new Date().toISOString()}`);
  console.log(sep);

  // Per-model summary table
  console.log();
  console.log('  MODEL SUMMARY');
  console.log('  ' + '─'.repeat(76));
  console.log(
    '  ' +
    pad('Model', 36) +
    pad('Latest', 10) +
    pad('Previous', 10) +
    pad('Delta', 8) +
    'Status'
  );
  console.log('  ' + '─'.repeat(76));

  for (const sc of scorecards) {
    const runs = sc.runs;
    const latest = runs[runs.length - 1];
    const previous = runs.length > 1 ? runs[runs.length - 2] : null;
    const delta = previous ? latest.passed - previous.passed : 0;
    const reg = regressions.get(sc.model);
    const status = reg && reg.overall ? 'REGRESSION' : runs.length < 2 ? 'NEW' : 'OK';

    console.log(
      '  ' +
      pad(sc.model, 36) +
      pad(latest.score, 10) +
      pad(previous ? previous.score : '-', 10) +
      pad(delta > 0 ? `+${delta}` : `${delta}`, 8) +
      status
    );
  }

  console.log('  ' + '─'.repeat(76));

  // Regression alerts
  const hasRegressions = [...regressions.values()].some(r => r.overall || r.phases.length > 0);
  console.log();
  if (hasRegressions) {
    console.log('  REGRESSION ALERTS');
    console.log('  ' + '─'.repeat(76));
    for (const [model, reg] of regressions) {
      if (reg.overall) {
        console.log(`  [!] ${model}: score dropped ${reg.overall.from} -> ${reg.overall.to} (${reg.overall.delta})`);
      }
      if (reg.phases.length > 0) {
        console.log(`  [!] ${model}: phase regressions: ${reg.phases.join(', ')}`);
      }
    }
    console.log('  ' + '─'.repeat(76));
  } else {
    console.log('  No regressions detected.');
  }

  // Phase failure heatmap
  const failingPhases = heatmap.filter(h => h.failures > 0);
  if (failingPhases.length > 0) {
    console.log();
    console.log('  PHASE FAILURE HEATMAP');
    console.log('  ' + '─'.repeat(76));
    console.log(
      '  ' +
      pad('Phase', 28) +
      pad('Failures', 12) +
      pad('Runs', 8) +
      pad('Rate', 8) +
      'Failing Models'
    );
    console.log('  ' + '─'.repeat(76));

    for (const h of failingPhases) {
      console.log(
        '  ' +
        pad(h.phase, 28) +
        pad(`${h.failures}`, 12) +
        pad(`${h.total_runs}`, 8) +
        pad(h.fail_rate, 8) +
        h.failing_models.join(', ')
      );
    }
    console.log('  ' + '─'.repeat(76));
  }

  console.log();
}

function pad(s, width) {
  s = String(s);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

// ─── Write outputs ───

function writeScorecards(scorecards) {
  mkdirSync(SCORECARDS_DIR, { recursive: true });
  for (const sc of scorecards) {
    const safe = sc.model.replace(/[/\\:]/g, '_');
    writeFileSync(join(SCORECARDS_DIR, `${safe}.json`), JSON.stringify(sc, null, 2) + '\n');
  }
}

function writeReport(scorecards, regressions, heatmap) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const report = {
    generated: new Date().toISOString(),
    models: scorecards.map(sc => {
      const runs = sc.runs;
      const latest = runs[runs.length - 1];
      const previous = runs.length > 1 ? runs[runs.length - 2] : null;
      const reg = regressions.get(sc.model);
      return {
        model: sc.model,
        latest_score: latest.score,
        previous_score: previous ? previous.score : null,
        delta: previous ? latest.passed - previous.passed : null,
        regression: reg && reg.overall ? true : false,
        phase_regressions: reg ? reg.phases : [],
        total_runs: runs.length,
      };
    }),
    heatmap: heatmap.filter(h => h.failures > 0),
  };

  const path = join(REPORTS_DIR, `regression-${ts}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  return path;
}

// ─── Main ───

const entries = readResults();
const grouped = groupIntoRuns(entries);

let models = Object.keys(grouped).sort();
if (MODEL_FILTER) {
  models = models.filter(m => m === MODEL_FILTER);
  if (models.length === 0) {
    console.error(`No results found for model: ${MODEL_FILTER}`);
    console.error(`Available models: ${Object.keys(grouped).sort().join(', ')}`);
    process.exit(1);
  }
}

const scorecards = models.map(m => buildScorecard(m, grouped[m]));
const regressions = new Map();
for (const sc of scorecards) {
  regressions.set(sc.model, detectRegressions(sc));
}
const heatmap = buildHeatmap(scorecards);

printReport(scorecards, regressions, heatmap);
writeScorecards(scorecards);
const reportPath = writeReport(scorecards, regressions, heatmap);

console.log(`  Scorecards written to: ${SCORECARDS_DIR}/`);
console.log(`  Report written to:     ${reportPath}`);
console.log();
