#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeUsableNow } from './usable-now-eval.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function opt(name, def) {
  const i = args.indexOf(name);
  if (i < 0) return def;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

const MODEL = opt('--model', 'gpt-4.1-mini');
const PROVIDER = opt('--provider', 'openai');
const BASE_URL = opt('--base-url', 'http://localhost:3302');
const TOP = Math.max(1, parseInt(opt('--top', '8'), 10));
const GROUPS_SPEC = opt('--groups', 'discovery,analysis;identity,wallet;social,channels;market,analytics,capital');
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

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseGroups(spec) {
  return spec
    .split(';')
    .map((chunk) => chunk.split(',').map((value) => value.trim()).filter(Boolean))
    .filter((group) => group.length > 0)
    .map((suites, index) => ({
      tag: `W${index + 1}`,
      suites,
      suiteArg: suites.join(','),
    }));
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8').trim();
  if (!text) return [];
  return text.split('\n').map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function inferDocFix(entry) {
  const key = `${entry.suite}:${entry.phase}`;
  if (key === 'identity:node-connection') {
    return 'Tell the agent to send {} on the two POST routes so it gets the helpful 400 boundary, then call status.';
  }
  if (key === 'market:teaching-surfaces') {
    return 'Tell the agent to register first if needed, then repeat the same three GET probes with bearer auth.';
  }
  if (key === 'channels:signed-channel-lifecycle') {
    return 'The remaining miss looks blocked by missing channel assignment in this HTTP-only harness, not just bad docs.';
  }
  if (key === 'market:open-flow' || key === 'market:close-revenue-performance' || key === 'market:swap-ecash-and-rebalance') {
    return 'The remaining miss looks blocked by missing real secp256k1 signing in this HTTP-only harness, not just bad docs.';
  }
  const cannotFind = entry.cannot_find_routes?.length || 0;
  const wrongRequest = entry.wrong_request_routes?.length || 0;
  const wrongResponse = entry.wrong_response_routes?.length || 0;

  if (cannotFind > 0 && wrongRequest === 0 && wrongResponse === 0) return 'Move the exact route list to the top and cut extra words.';
  if (wrongRequest > 0 && cannotFind === 0 && wrongResponse === 0) return 'Make auth, header, and body examples much more obvious right above the route list.';
  if (wrongResponse > 0 && cannotFind === 0 && wrongRequest === 0) return 'Explain which real IDs or placeholders to use, and what result counts as correct.';
  if (cannotFind > 0 && wrongRequest > 0) return 'Shorten the file and put setup first, then the exact route order.';
  if (wrongRequest > 0 && wrongResponse > 0) return 'Tighten both the request example and the expected response rules.';
  return 'Trim detours and make the exact route burst easier to follow.';
}

function docPathsFor(entry) {
  const key = `${entry.suite}:${entry.phase}`;
  return PHASE_DOC_OVERRIDES[key] || DOC_MAP[entry.suite] || [];
}

function scoreGap(entry) {
  return (entry.expected_count || 0) - (entry.contract_score || 0);
}

async function runWorker(worker, resultsFile) {
  const runnerArgs = [
    'test/walkthrough/test-runner.mjs',
    '--provider', PROVIDER,
    '--model', MODEL,
    '--mode', 'agent-coverage',
    '--suite', worker.suiteArg,
    '--base-url', BASE_URL,
    '--results-file', resultsFile,
    '--tag', worker.tag,
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
      else reject(new Error(`${worker.tag} failed with exit code ${code}`));
    });
    child.on('error', reject);
  });
}

async function main() {
  const workers = parseGroups(GROUPS_SPEC);
  const runDir = join(__dirname, 'parallel-results', timestampSlug());
  mkdirSync(runDir, { recursive: true });

  console.log('');
  console.log('=== Parallel Agent Coverage ===');
  for (const worker of workers) {
    console.log(`- ${worker.tag}: ${worker.suiteArg}`);
  }
  console.log('');

  await Promise.all(workers.map((worker) => {
    const resultsFile = join(runDir, `${worker.tag}-${worker.suites.join('_')}.jsonl`);
    worker.resultsFile = resultsFile;
    return runWorker(worker, resultsFile);
  }));

  const allEntries = workers.flatMap((worker) => readJsonl(worker.resultsFile));
  const summaries = allEntries.filter((entry) => entry.mode === 'agent-coverage');
  const phases = allEntries.filter((entry) => entry.mode === 'agent-coverage-phase');

  const totalContract = summaries.reduce((sum, entry) => sum + Number(String(entry.score || '0/0').split('/')[0] || 0), 0);
  const totalExpected = summaries.reduce((sum, entry) => sum + Number(String(entry.score || '0/0').split('/')[1] || 0), 0);
  const totalReach = summaries.reduce((sum, entry) => sum + Number(String(entry.reach_score || '0/0').split('/')[0] || 0), 0);
  const totalCost = summaries.reduce((sum, entry) => sum + Number(entry.estimated_cost_usd || 0), 0);
  const totalPhasePasses = summaries.reduce((sum, entry) => sum + Number(String(entry.phase_score || '0/0').split('/')[0] || 0), 0);
  const totalPhases = summaries.reduce((sum, entry) => sum + Number(String(entry.phase_score || '0/0').split('/')[1] || 0), 0);
  const usableNow = summarizeUsableNow(phases);

  console.log('');
  console.log('=== Worker Scores ===');
  const workerSuites = new Map(workers.map((worker) => [worker.tag, worker.suiteArg]));
  for (const summary of summaries.sort((a, b) => String(a.tag || '').localeCompare(String(b.tag || '')))) {
    console.log(`- ${summary.tag || '?'} = ${workerSuites.get(summary.tag) || 'unknown group'}`);
    console.log(`  contract ${summary.score}, reach ${summary.reach_score}, phases ${summary.phase_score}, est $${Number(summary.estimated_cost_usd || 0).toFixed(4)}`);
  }
  console.log('');
  console.log('=== Merged Report ===');
  console.log(`Contract: ${totalContract}/${totalExpected}`);
  console.log(`Usable-now: ${usableNow.passed}/${usableNow.total}`);
  console.log(`Reach: ${totalReach}/${totalExpected}`);
  console.log(`Phases: ${totalPhasePasses}/${totalPhases}`);
  console.log(`Estimated cost: $${totalCost.toFixed(4)}`);
  console.log(`Run folder: ${runDir}`);
  console.log('');
  console.log(`Worst ${Math.min(TOP, phases.filter((entry) => !entry.passed).length)} groups to fix next:`);

  for (const entry of phases.filter((phase) => !phase.passed).sort((a, b) => scoreGap(b) - scoreGap(a)).slice(0, TOP)) {
    const docs = docPathsFor(entry).map((path) => `[${path.split('/').pop()}](${path})`).join(', ');
    console.log(`- ${entry.tag || '?'} ${entry.suite}:${entry.phase}: contract ${entry.contract_score}/${entry.expected_count}, reach ${entry.reach_score}/${entry.expected_count}`);
    console.log(`  section: ${entry.phase}`);
    console.log(`  docs: ${docs || '(none mapped)'}`);
    console.log(`  next fix: ${inferDocFix(entry)}`);
    for (const route of [
      ...(entry.cannot_find_routes || []).map((value) => `cannot find: ${value}`),
      ...(entry.wrong_request_routes || []).map((value) => `wrong request: ${value}`),
      ...(entry.wrong_response_routes || []).map((value) => `wrong response: ${value}`),
    ].slice(0, 6)) {
      console.log(`  ${route}`);
    }
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
