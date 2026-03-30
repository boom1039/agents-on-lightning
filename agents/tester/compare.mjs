#!/usr/bin/env node
/**
 * Compare walkthrough test results across models and runs.
 *
 * Reads JSONL from test/walkthrough/stress-test-results.jsonl, groups by model,
 * shows per-phase pass/fail, total scores, and deltas from previous runs.
 * Writes JSON scorecards to agents/tester/scorecards/{model}-latest.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const RESULTS_FILE = join(PROJECT_ROOT, 'test', 'walkthrough', 'stress-test-results.jsonl');
const SCORECARDS_DIR = join(__dirname, 'scorecards');

// ─── Read and parse JSONL ───

function readResults() {
  if (!existsSync(RESULTS_FILE)) {
    console.error('No results file found at', RESULTS_FILE);
    process.exit(1);
  }
  return readFileSync(RESULTS_FILE, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// ─── Group run summaries by model ───

function groupRuns(results) {
  // Run summaries have a "mode" field and a "score" field, but no "type" field
  // Phase results have type: "phase"
  const summaries = results.filter(r => r.mode && r.score && !r.type);
  const phases = results.filter(r => r.type === 'phase');

  // Group summaries by model, preserving chronological order
  const byModel = {};
  for (const s of summaries) {
    const key = s.model;
    if (!byModel[key]) byModel[key] = [];
    byModel[key].push(s);
  }

  // Group phase results by model + run timestamp (use the summary ts as boundary)
  const phasesByModel = {};
  for (const p of phases) {
    const key = p.model;
    if (!phasesByModel[key]) phasesByModel[key] = [];
    phasesByModel[key].push(p);
  }

  return { byModel, phasesByModel };
}

// ─── Build scorecard for a model ───

function buildScorecard(model, runs, phases) {
  const latest = runs[runs.length - 1];
  const previous = runs.length > 1 ? runs[runs.length - 2] : null;

  const [passed, total] = latest.score.split('/').map(Number);
  const prevScore = previous ? previous.score.split('/').map(Number) : null;
  const delta = prevScore ? passed - prevScore[0] : null;

  // Get phase details from the latest run
  const phaseResults = latest.phases || {};

  // Find phase-level details from JSONL for the latest run
  const latestTs = new Date(latest.ts).getTime();
  const latestPhases = (phases || []).filter(p => {
    const pt = new Date(p.ts).getTime();
    // Phases within 10 minutes before the summary
    return pt <= latestTs && pt >= latestTs - 600000;
  });

  return {
    model,
    display: latest.display || `${latest.provider}/${model}`,
    provider: latest.provider,
    score: latest.score,
    passed,
    total,
    delta,
    previous_score: previous ? previous.score : null,
    phases: phaseResults,
    run_count: runs.length,
    latest_ts: latest.ts,
    duration_ms: latest.duration_ms,
    total_tokens: latest.total_tokens,
    total_http_calls: latest.total_http_calls,
    failures: (latest.failure_details || []).map(f => f.phase),
    phase_details: latestPhases.map(p => ({
      phase: p.phase,
      passed: p.passed,
      reason: p.reason,
      duration_ms: p.phase_duration_ms,
      http_calls: p.http_calls,
      token_usage: p.token_usage,
    })),
  };
}

// ─── Render text table ───

function renderTable(scorecards) {
  // Collect all phase names across all scorecards
  const allPhases = [];
  for (const sc of scorecards) {
    for (const phase of Object.keys(sc.phases)) {
      if (!allPhases.includes(phase)) allPhases.push(phase);
    }
  }

  const modelWidth = Math.max(12, ...scorecards.map(sc => sc.display.length));
  const header = 'Model'.padEnd(modelWidth) + '  Score  Delta  ' + allPhases.map(p => p.substring(0, 3)).join(' ');
  const divider = '-'.repeat(header.length);

  console.log('');
  console.log('Walkthrough Test Comparison');
  console.log(divider);
  console.log(header);
  console.log(divider);

  for (const sc of scorecards) {
    const deltaStr = sc.delta === null ? '  -  '
      : sc.delta > 0 ? ` +${sc.delta}  `.substring(0, 5)
      : sc.delta < 0 ? ` ${sc.delta}  `.substring(0, 5)
      : '  =  ';

    const phaseStr = allPhases.map(p => {
      const val = sc.phases[p];
      if (val === true) return ' . ';
      if (val === false) return ' X ';
      return ' ? ';
    }).join('');

    const scoreStr = sc.score.padStart(5);
    console.log(`${sc.display.padEnd(modelWidth)}  ${scoreStr}  ${deltaStr} ${phaseStr}`);
  }

  console.log(divider);
  console.log('');
  console.log('Legend: . = pass, X = fail, ? = not run');
  console.log('');

  // Per-model detail
  for (const sc of scorecards) {
    const deltaNote = sc.delta === null ? '(first run)'
      : sc.delta > 0 ? `(+${sc.delta} from ${sc.previous_score})`
      : sc.delta < 0 ? `(${sc.delta} from ${sc.previous_score})`
      : `(unchanged from ${sc.previous_score})`;

    console.log(`${sc.display}: ${sc.score} ${deltaNote}`);
    console.log(`  Runs: ${sc.run_count}  |  Duration: ${(sc.duration_ms / 1000).toFixed(1)}s  |  Tokens: ${sc.total_tokens}  |  HTTP calls: ${sc.total_http_calls}`);

    if (sc.failures.length > 0) {
      console.log(`  Failed: ${sc.failures.join(', ')}`);
    }
    console.log('');
  }
}

// ─── Write scorecards ───

function writeScorecards(scorecards) {
  if (!existsSync(SCORECARDS_DIR)) mkdirSync(SCORECARDS_DIR, { recursive: true });

  for (const sc of scorecards) {
    const safeName = sc.model.replace(/[/\\:]/g, '-');
    const path = join(SCORECARDS_DIR, `${safeName}-latest.json`);
    writeFileSync(path, JSON.stringify(sc, null, 2) + '\n');
  }

  console.log(`Scorecards written to ${SCORECARDS_DIR}/`);
}

// ─── Main ───

const results = readResults();
const { byModel, phasesByModel } = groupRuns(results);

if (Object.keys(byModel).length === 0) {
  console.log('No run summaries found in results file.');
  console.log('Run tests first: node test/walkthrough/test-runner.mjs --models gpt-4.1-nano');
  process.exit(0);
}

const scorecards = Object.entries(byModel).map(([model, runs]) =>
  buildScorecard(model, runs, phasesByModel[model] || [])
);

// Sort by score descending
scorecards.sort((a, b) => b.passed - a.passed || a.total - b.total);

renderTable(scorecards);
writeScorecards(scorecards);
