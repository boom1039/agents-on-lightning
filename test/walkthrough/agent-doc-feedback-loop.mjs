#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function opt(name, def) {
  const i = args.indexOf(name);
  if (i < 0) return def;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

function flag(name) {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

const MODEL = opt('--model', 'gpt-4.1-mini');
const PROVIDER = opt('--provider', 'openai');
const BASE_URL = opt('--base-url', 'http://localhost:3302');
const SUITE = opt('--suite', 'all');
const TOP = Math.max(1, parseInt(opt('--top', '8'), 10));
const RESULTS_FILE = opt('--results-file', join(__dirname, 'stress-test-results.jsonl'));
const DRY_REPORT = flag('--report-latest');
const USE_FAIL_FAST = !args.includes('--no-fail-fast');

const DOC_MAP = {
  discovery: ['/Users/g/agents_on_lightning/docs/llms.txt', '/Users/g/agents_on_lightning/docs/skills/discovery.txt'],
  identity: ['/Users/g/agents_on_lightning/docs/skills/identity.txt'],
  wallet: ['/Users/g/agents_on_lightning/docs/skills/wallet.txt'],
  analysis: ['/Users/g/agents_on_lightning/docs/skills/analysis.txt'],
  social: ['/Users/g/agents_on_lightning/docs/skills/social.txt'],
  channels: ['/Users/g/agents_on_lightning/docs/skills/channels.txt'],
  market: ['/Users/g/agents_on_lightning/docs/skills/market.txt'],
  analytics: ['/Users/g/agents_on_lightning/docs/skills/analytics.txt'],
  capital: ['/Users/g/agents_on_lightning/docs/skills/capital.txt'],
};

const PHASE_DOC_OVERRIDES = {
  'market:close-revenue-performance': [
    '/Users/g/agents_on_lightning/docs/skills/market-close.txt',
    '/Users/g/agents_on_lightning/docs/skills/market.txt',
  ],
};

function readJsonlSlice(startByte = 0) {
  if (!existsSync(RESULTS_FILE)) return [];
  const buffer = readFileSync(RESULTS_FILE);
  const chunk = buffer.subarray(startByte).toString('utf8').trim();
  if (!chunk) return [];
  return chunk
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function inferDocFix(entry) {
  const cannotFind = entry.cannot_find_routes?.length || 0;
  const wrongRequest = entry.wrong_request_routes?.length || 0;
  const wrongResponse = entry.wrong_response_routes?.length || 0;

  if (cannotFind > 0 && wrongRequest === 0 && wrongResponse === 0) {
    return 'Move the exact route list to the top and cut extra words.';
  }
  if (wrongRequest > 0 && cannotFind === 0 && wrongResponse === 0) {
    return 'Make auth, header, and body examples much more obvious right above the route list.';
  }
  if (wrongResponse > 0 && cannotFind === 0 && wrongRequest === 0) {
    return 'Explain which real IDs or placeholder values to use, and what result counts as correct.';
  }
  if (cannotFind > 0 && wrongRequest > 0) {
    return 'Shorten the file and put setup first, then the exact route order.';
  }
  if (wrongRequest > 0 && wrongResponse > 0) {
    return 'Tighten both the request example and the expected response rules.';
  }
  return 'Trim detours and make the exact route burst easier to follow.';
}

function scoreGap(entry) {
  return (entry.expected_count || 0) - (entry.contract_score || 0);
}

function docPathsFor(entry) {
  const key = `${entry.suite}:${entry.phase}`;
  return PHASE_DOC_OVERRIDES[key] || DOC_MAP[entry.suite] || [];
}

function formatPhaseLine(entry) {
  const docs = docPathsFor(entry).map((path) => `[${path.split('/').pop()}](${path})`).join(', ');
  const failedRoutes = [
    ...(entry.cannot_find_routes || []).map((route) => `cannot find: ${route}`),
    ...(entry.wrong_request_routes || []).map((route) => `wrong request: ${route}`),
    ...(entry.wrong_response_routes || []).map((route) => `wrong response: ${route}`),
  ];
  return {
    label: `${entry.suite}:${entry.phase}`,
    score: `${entry.contract_score}/${entry.expected_count}`,
    reach: `${entry.reach_score}/${entry.expected_count}`,
    docs,
    fix: inferDocFix(entry),
    failedRoutes,
  };
}

function printReport(entries) {
  const summary = [...entries].reverse().find((entry) => entry.mode === 'agent-coverage');
  const phases = entries
    .filter((entry) => entry.mode === 'agent-coverage-phase')
    .sort((a, b) => scoreGap(b) - scoreGap(a) || ((a.suite + a.phase) > (b.suite + b.phase) ? 1 : -1));

  if (!summary) {
    console.log('No agent-coverage summary found.');
    return;
  }

  console.log('');
  console.log('=== Agent Doc Loop Report ===');
  console.log(`Contract: ${summary.score}`);
  console.log(`Reach: ${summary.reach_score}`);
  console.log(`Phases: ${summary.phase_score}`);
  console.log(`Estimated cost: $${Number(summary.estimated_cost_usd || 0).toFixed(4)}`);
  console.log('');
  console.log(`Worst ${Math.min(TOP, phases.filter((entry) => !entry.passed).length)} groups to fix next:`);

  for (const entry of phases.filter((phase) => !phase.passed).slice(0, TOP)) {
    const row = formatPhaseLine(entry);
    console.log(`- ${row.label}: contract ${row.score}, reach ${row.reach}`);
    console.log(`  docs: ${row.docs || '(none mapped)'}`);
    console.log(`  next fix: ${row.fix}`);
    for (const route of row.failedRoutes.slice(0, 6)) {
      console.log(`  ${route}`);
    }
  }
}

function sliceLatestRunEntries(entries) {
  let latestSummaryIndex = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.mode === 'agent-coverage') {
      latestSummaryIndex = i;
      break;
    }
  }
  if (latestSummaryIndex < 0) return entries;

  let previousSummaryIndex = -1;
  for (let i = latestSummaryIndex - 1; i >= 0; i--) {
    if (entries[i]?.mode === 'agent-coverage') {
      previousSummaryIndex = i;
      break;
    }
  }

  return entries.slice(previousSummaryIndex + 1, latestSummaryIndex + 1);
}

async function run() {
  const startByte = existsSync(RESULTS_FILE) ? statSync(RESULTS_FILE).size : 0;

  if (!DRY_REPORT) {
    const runnerArgs = [
      'test/walkthrough/test-runner.mjs',
      '--provider', PROVIDER,
      '--model', MODEL,
      '--mode', 'agent-coverage',
      '--suite', SUITE,
      '--base-url', BASE_URL,
      '--results-file', RESULTS_FILE,
      ...args,
    ];

    if (USE_FAIL_FAST && !runnerArgs.includes('--fail-fast')) {
      runnerArgs.push('--fail-fast');
    }

    await new Promise((resolve, reject) => {
      const child = spawn('node', runnerArgs, {
        cwd: '/Users/g/agents_on_lightning',
        stdio: 'inherit',
      });
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`agent coverage run failed with exit code ${code}`));
      });
      child.on('error', reject);
    });
  }

  const rawEntries = DRY_REPORT
    ? readJsonlSlice(0)
    : readJsonlSlice(startByte);
  const entries = DRY_REPORT ? sliceLatestRunEntries(rawEntries) : rawEntries;

  printReport(entries);
}

run().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
