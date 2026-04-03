#!/usr/bin/env node
/**
 * Agent Platform Test Runner — Walkthrough Benchmark + Route Coverage
 *
 * `--mode walkthrough` keeps the existing model-driven navigation benchmark.
 * `--mode agent-coverage` asks the model to fully exercise each documented
 * capability area using only llms.txt and the linked skill docs.
 * `--mode coverage` runs direct HTTP suite coverage with machine-readable
 * route manifests. `--mode both` runs walkthrough first, then coverage.
 *
 * Usage:
 *   # Walkthrough benchmark (default)
 *   node test-runner.mjs
 *   node test-runner.mjs --provider anthropic --model claude-haiku-4-5-20251001
 *   node test-runner.mjs --models gpt-4.1-mini,gpt-4.1 --feedback
 *
 *   # Coverage mode
 *   node test-runner.mjs --mode coverage --suite all
 *   node test-runner.mjs --mode agent-coverage --suite all
 *   node test-runner.mjs --mode agent-coverage --suite social --phase messaging --fail-fast
 *   node test-runner.mjs --mode both --feedback
 *
 *   # Generate report from saved results
 *   node test-runner.mjs --report
 *   node test-runner.mjs --report --report-file /tmp/report.md
 */

import { writeFileSync, appendFileSync, readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  flag as _flag,
  opt as _opt,
  sleep,
  formatTime,
  formatBytes,
  doHttp as _doHttp,
  doTerminalCommand,
  createProvider,
  HTTP_TOOL,
  TERMINAL_TOOL,
} from './shared.mjs';
import {
  DEFAULT_OPEN_AMOUNT_SATS,
  SkipPhaseError,
  createCoverageContext,
} from './coverage-helpers.mjs';
import { evaluatePhaseCoverage, getCoverMatcher } from './agent-coverage-scoring.mjs';
import { resolveSuites } from './suites/index.mjs';
import { verifyCoverage } from './verify-suite-coverage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── CLI ───

const args = process.argv.slice(2);
function flag(name) { return _flag(name, args); }
function opt(name, def) { return _opt(name, def, args); }

const RESULTS_FILE = opt('--results-file', join(__dirname, 'stress-test-results.jsonl'));

const REPORT_ONLY = flag('--report');
const ALL_MODELS = flag('--all');
const MODELS_STR = opt('--models', null);
const MODE = opt('--mode', 'walkthrough');   // navigation | walkthrough | agent-coverage | coverage | both
const WITH_FEEDBACK = flag('--feedback');
const COVERAGE_SUITE = opt('--suite', 'all');
const SKIP_COVERAGE_VERIFY = flag('--skip-coverage-verify');
const QUICK_MODE = flag('--quick');
const FAIL_FAST = flag('--fail-fast');
const SHOW_DOC_TRACES = flag('--show-doc-traces');
const SHARED_AGENT_COVERAGE_SESSION = flag('--shared-agent-coverage-session');
const AGENT_COVERAGE_SESSIONS = Math.max(1, parseInt(opt('--agent-coverage-sessions', '1'), 10));
const OPEN_PEER_PUBKEY = opt('--open-peer-pubkey', null);
const OPEN_AMOUNT_SATS = parseInt(opt('--open-amount-sats', String(DEFAULT_OPEN_AMOUNT_SATS)), 10);
const ONLY_PHASE = opt('--phase', null);
const START_PHASE = parseInt(opt('--start-phase', '0'), 10);
const AGENT_RUNTIME = opt('--agent-runtime', 'http');
const MAX_RETRIES = parseInt(opt('--attempts', opt('--retries', QUICK_MODE ? '3' : '3')), 10);
const HAS_MAX_TURNS_OVERRIDE = args.includes('--max-turns');
const MAX_TURNS = HAS_MAX_TURNS_OVERRIDE
  ? parseInt(opt('--max-turns', '1'), 10)
  : (AGENT_RUNTIME === 'terminal' ? (QUICK_MODE ? 2 : 3) : 1);
const DEFAULT_PREP_TURNS = AGENT_RUNTIME === 'terminal'
  ? (QUICK_MODE ? '3' : '3')
  : (QUICK_MODE ? '4' : '6');
const MAX_PREP_TURNS = parseInt(opt('--prep-turns', DEFAULT_PREP_TURNS), 10);
const MAX_SETUP_TURNS = parseInt(opt('--setup-turns', AGENT_RUNTIME === 'terminal' ? (QUICK_MODE ? '6' : '6') : '2'), 10);
const MAX_PHASE_BURSTS = parseInt(opt('--phase-bursts', QUICK_MODE ? '4' : '6'), 10);
const MAX_NO_PROGRESS_BURSTS = parseInt(opt('--max-no-progress-bursts', QUICK_MODE ? '2' : '2'), 10);
const MAX_DOC_ONLY_BURSTS = parseInt(opt('--max-doc-only-bursts', QUICK_MODE ? '3' : '2'), 10);
const NUDGE_TIMEOUT_MS = parseInt(opt('--nudge-timeout', '15000'), 10);
const DEFAULT_PROVIDER_TIMEOUT_MS = AGENT_RUNTIME === 'terminal'
  ? (QUICK_MODE ? '25000' : '25000')
  : (QUICK_MODE ? '6000' : '10000');
const PROVIDER_TIMEOUT_MS = parseInt(opt('--provider-timeout-ms', DEFAULT_PROVIDER_TIMEOUT_MS), 10);
const DELAY_SECS = parseInt(opt('--delay', '0'), 10);
const BAIL_AFTER = parseInt(opt('--bail', '2'), 10);  // stop after N consecutive failures
const MODEL_RETRY_MAX = parseInt(opt('--model-retry-max', '1'), 10);
const MODEL_RETRY_BASE_MS = parseInt(opt('--model-retry-base-ms', '0'), 10);
const MODEL_RETRY_MAX_MS = parseInt(opt('--model-retry-max-ms', '0'), 10);
const BASE_URL = opt('--base-url', 'http://localhost:3302');
const REPORT_FILE = opt('--report-file', null);
const TAG = opt('--tag', null);

// Legacy single-model flags
const PROVIDER = opt('--provider', 'openai');
const MODEL = opt('--model',
  PROVIDER === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'gpt-4.1-mini');
const EFFECTIVE_MAX_RETRIES = FAIL_FAST ? 1 : MAX_RETRIES;
const EFFECTIVE_BAIL_AFTER = FAIL_FAST ? 1 : QUICK_MODE ? 1 : BAIL_AFTER;
const QUICK_NUDGE_TIMEOUT_MS = AGENT_RUNTIME === 'terminal' ? 12000 : 8000;
const EFFECTIVE_NUDGE_TIMEOUT_MS = QUICK_MODE ? Math.min(NUDGE_TIMEOUT_MS, QUICK_NUDGE_TIMEOUT_MS) : NUDGE_TIMEOUT_MS;
const TOOL_FOLLOW_UP_EXTENSION_MS = AGENT_RUNTIME === 'terminal' ? 2000 : 0;
const MAX_TOOL_FOLLOW_UP_EXTENSIONS = AGENT_RUNTIME === 'terminal' ? 1 : 0;
const SKIP_FAILURE_INTERVIEWS = FAIL_FAST || QUICK_MODE;
const SHOULD_VERIFY_COVERAGE = !SKIP_COVERAGE_VERIFY && !QUICK_MODE;

function isSetupProgressRequest(input = {}) {
  const method = String(input.method || 'GET').toUpperCase();
  const url = input.url || '';
  if (method === 'POST' && /\/api\/v1\/agents\/register(?:\?|$)/.test(url)) return true;
  if (method === 'PUT' && /\/api\/v1\/agents\/me(?:\?|$)/.test(url)) return true;
  return false;
}

function createTerminalRuntime(label = 'agent-coverage') {
  const runtimeDir = mkdtempSync(join(tmpdir(), `agents-on-lightning-${label.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}-`));
  return {
    cwd: runtimeDir,
    async execute(toolName, input = {}) {
      if (toolName !== TERMINAL_TOOL.name) {
        return { ok: false, error: `Unsupported local tool ${toolName}` };
      }
      return await doTerminalCommand(input, { cwd: runtimeDir });
    },
  };
}

// ─── Model Roster ───

const MODEL_ROSTER = [
  { id: 'gpt-4.1-nano',              provider: 'openai',     display: 'GPT-4.1 Nano',        tier: 'stress' },
  { id: 'gpt-4o-mini',               provider: 'openai',     display: 'GPT-4o Mini',          tier: 'stress' },
  { id: 'gpt-4.1-mini',              provider: 'openai',     display: 'GPT-4.1 Mini',         tier: 'both' },
  { id: 'gpt-4.1',                   provider: 'openai',     display: 'GPT-4.1',              tier: 'both' },
  { id: 'claude-haiku-4-5-20251001', provider: 'anthropic',  display: 'Claude Haiku',          tier: 'both' },
  { id: 'deepseek/deepseek-chat-v3-0324',    provider: 'openrouter', display: 'DeepSeek V3',         tier: 'stress' },
  { id: 'qwen/qwen-2.5-72b-instruct',       provider: 'openrouter', display: 'Qwen 2.5 72B',        tier: 'stress' },
  { id: 'google/gemini-2.5-flash-preview',   provider: 'openrouter', display: 'Gemini 2.5 Flash',    tier: 'stress' },
  { id: 'mistralai/mistral-large-2411',      provider: 'openrouter', display: 'Mistral Large',       tier: 'stress' },
];

const MODEL_PRICING_USD_PER_1M = {
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-5.4': { input: 2.5, output: 15.0 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25 },
};

// ─── Logging ───

const _pre = TAG ? `[${TAG}] ` : '';
function agentLog(msg) { process.stdout.write(`${_pre}${msg}\n`); }
function testLog(msg) { process.stdout.write(`${_pre}  ★ ${msg}\n`); }

function doHttp(input) { return _doHttp(input, BASE_URL); }
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatUsd(amount) {
  if (!Number.isFinite(amount)) return 'n/a';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

function estimateModelCostUsd(modelId, inputTokens, outputTokens) {
  const pricing = MODEL_PRICING_USD_PER_1M[modelId];
  if (!pricing) return null;
  return ((inputTokens / 1_000_000) * pricing.input) + ((outputTokens / 1_000_000) * pricing.output);
}

function formatTimingBreakdown({ thinkMs = 0, httpMs = 0, toolMs = 0, waitMs = 0, wallMs = 0 }) {
  const otherMs = Math.max(0, wallMs - thinkMs - httpMs - toolMs - waitMs);
  return `time think ${formatTime(thinkMs)}, http ${formatTime(httpMs)}, tool ${formatTime(toolMs)}, wait ${formatTime(waitMs)}, other ${formatTime(otherMs)}`;
}

function shortUrl(url = '') {
  return String(url).replace(BASE_URL, '') || url;
}

function burstIncludesSetupProgress(task, httpLog) {
  if (!Array.isArray(task?.setup) || task.setup.length === 0) return false;
  return httpLog.some((call) => {
    const path = shortUrl(call.url || '');
    if (task.setup.includes('auth') || task.setup.includes('second_agent')) {
      if (call.method === 'POST' && path === '/api/v1/agents/register' && call.status === 201) return true;
    }
    if (task.setup.includes('registered_pubkey')) {
      if (call.method === 'PUT' && path === '/api/v1/agents/me' && call.status === 200) return true;
    }
    return false;
  });
}

function phaseBurstBudget(task) {
  const routeCount = Array.isArray(task?.covers) ? task.covers.length : 0;
  return Math.max(MAX_PHASE_BURSTS, routeCount + 1);
}

function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const redacted = {};
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === 'authorization') {
      redacted[key] = 'Bearer [REDACTED]';
    } else {
      redacted[key] = value;
    }
  }
  return Object.keys(redacted).length > 0 ? redacted : null;
}

function summarizeRequest(input = {}) {
  return {
    method: input.method || 'GET',
    url: shortUrl(input.url || ''),
    headers: redactHeaders(input.headers),
    body: input.body ?? null,
  };
}

function summarizeToolCall(tc = {}) {
  if ((tc.name || HTTP_TOOL.name) === HTTP_TOOL.name) {
    return { tool: HTTP_TOOL.name, ...summarizeRequest(tc.input) };
  }
  return {
    tool: tc.name || 'unknown_tool',
    input: tc.input ?? null,
  };
}

function normalizeEndpointPath(url = '') {
  try {
    const parsed = new URL(url, BASE_URL);
    return parsed.pathname;
  } catch {
    return shortUrl(url).split('?')[0];
  }
}

function matchesPhaseCover(input = {}, phaseCovers = []) {
  if (!phaseCovers || phaseCovers.length === 0) return false;
  const method = String(input.method || 'GET').toUpperCase();
  const path = normalizeEndpointPath(input.url || '');
  return phaseCovers.some((cover) => {
    const matcher = getCoverMatcher(cover);
    return matcher.method === method && matcher.regex.test(path);
  });
}

function repeatedFailedEndpoint(prev, next) {
  if (!prev || !next) return null;
  if ((prev.status || 0) < 400 || (next.status || 0) < 400) return null;
  const prevMethod = String(prev.method || 'GET').toUpperCase();
  const nextMethod = String(next.method || 'GET').toUpperCase();
  const prevPath = normalizeEndpointPath(prev.url || '');
  const nextPath = normalizeEndpointPath(next.url || '');
  if (prevMethod !== nextMethod || prevPath !== nextPath) return null;
  return {
    method: nextMethod,
    path: nextPath,
    statuses: [prev.status, next.status],
  };
}

function findRepeatedFailedEndpoint(httpLog) {
  for (let i = 1; i < httpLog.length; i++) {
    const repeat = repeatedFailedEndpoint(httpLog[i - 1], httpLog[i]);
    if (repeat) return repeat;
  }
  return null;
}

function parsePhaseFilters(raw) {
  return String(raw || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function phaseMatchesFilter(suiteName, phaseName, filters) {
  if (!filters || filters.length === 0) return true;
  const full = `${suiteName}:${phaseName}`;
  return filters.some(filter => filter === phaseName || filter === full);
}

function filterSuitesByPhase(suites, filters) {
  if (!filters || filters.length === 0) return suites;
  const filtered = suites
    .map(suite => ({
      ...suite,
      phases: suite.phases.filter(phase => phaseMatchesFilter(suite.name, phase.name, filters)),
    }))
    .filter(suite => suite.phases.length > 0);
  if (filtered.length === 0) {
    throw new Error(`Unknown phase filter "${filters.join(', ')}". Use a phase name like "messaging" or a full name like "social:messaging".`);
  }
  return filtered;
}

function stitchDocTraces(docTraces, requestTimeline) {
  return docTraces.map((trace) => {
    if (trace.next_request) return trace;
    const nextRequest = requestTimeline.find((entry) => entry.request_timeline_index > trace.request_timeline_index);
    if (!nextRequest) return trace;
    return {
      ...trace,
      next_request: {
        method: nextRequest.method,
        url: nextRequest.url,
        headers: nextRequest.headers,
        body: nextRequest.body,
      },
      next_request_timeline_index: nextRequest.request_timeline_index,
    };
  });
}

function isDocRoute(input = {}) {
  const url = shortUrl(input.url || '');
  if (
    url.includes('/llms.txt')
    || url === '/api/v1/'
    || url.includes('/llms-full.txt')
    || url.includes('/api/v1/skills/')
    || url.includes('/api/v1/knowledge/')
  ) {
    return true;
  }
  const accept = Object.entries(input.headers || {}).find(([key]) => String(key).toLowerCase() === 'accept')?.[1];
  return url === '/' && typeof accept === 'string' && accept.includes('text/markdown');
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lowered) return value;
  }
  return null;
}

function parseRetryDelayMs(err, attempt) {
  const message = String(err?.message || '');
  const status = Number(err?.status || err?.code || 0);
  const isRateLimit = status === 429 || /429|rate limit/i.test(message);
  if (!isRateLimit) return null;

  if (MODEL_RETRY_MAX_MS <= 0) return 0;

  const retryAfterMs = Number(headerValue(err?.headers, 'retry-after-ms'));
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(retryAfterMs, MODEL_RETRY_MAX_MS);
  }

  const retryAfterSeconds = Number(headerValue(err?.headers, 'retry-after'));
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, MODEL_RETRY_MAX_MS);
  }

  const messageSeconds = message.match(/try again in\s+([\d.]+)s/i);
  if (messageSeconds) {
    return Math.min(Math.ceil(Number(messageSeconds[1]) * 1000), MODEL_RETRY_MAX_MS);
  }

  return Math.min(MODEL_RETRY_BASE_MS * (2 ** (attempt - 1)), MODEL_RETRY_MAX_MS);
}

async function resetTestRateLimits() {
  try {
    const res = await fetch(`${BASE_URL}/api/v1/test/reset-rate-limits`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: '{}',
    });
    if (!res.ok) {
      agentLog(`  test reset route returned ${res.status}`);
    }
  } catch {}
}

// ─── Send a nudge and let the agent work ───

async function runNudge(messages, nudge, provider, ctx = {}) {
  const { phaseNum, totalPhases, phaseName, attempt, attemptMax = EFFECTIVE_MAX_RETRIES } = ctx;
  const nudgeStart = Date.now();
  const pre = phaseName ? `${String(phaseNum).padStart(2)}/${totalPhases} ${phaseName.padEnd(20)}` : '';
  const att = attempt ? ` ${attempt}/${attemptMax}` : '';

  messages.push({ role: 'user', content: nudge });
  const httpLog = [];
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let docReads = 0;
  const thinkTimes = [];
  const responseSizes = [];
  const docTraces = [];
  const turnTraces = [];
  const pendingDocTraces = [];
  const requestTimeline = [];
  let retryWaitMsTotal = 0;
  let toolMsTotal = 0;
  let stopReason = null;
  let actionTurnsUsed = 0;
  let prepTurnsUsed = 0;
  let setupTurnsUsed = 0;
  let nudgeBudgetMs = EFFECTIVE_NUDGE_TIMEOUT_MS;
  let toolFollowUpExtensionsUsed = 0;
  let previousTurnFinishedAtMs = null;
  let lastRequestFinishedAtMs = null;

  for (let turn = 0; turn < MAX_TURNS + MAX_PREP_TURNS; turn++) {
    if (Date.now() - nudgeStart > nudgeBudgetMs) {
      agentLog(`${pre}${att}  TIMEOUT ${formatTime(nudgeBudgetMs)}`);
      break;
    }

    const turnStartedAtMs = Date.now();
    const thinkStart = turnStartedAtMs;
    let response;
    for (let modelAttempt = 1; modelAttempt <= MODEL_RETRY_MAX; modelAttempt++) {
      try {
        response = await provider.call(messages);
        break;
      } catch (err) {
        const retryDelayMs = parseRetryDelayMs(err, modelAttempt);
        if (retryDelayMs == null || modelAttempt >= MODEL_RETRY_MAX) {
          agentLog(`${pre}${att}  ERROR ${String(err.message || err).substring(0, 100)}`);
          break;
        }
        if (retryDelayMs > 0) {
          retryWaitMsTotal += retryDelayMs;
          agentLog(`${pre}${att}  RATE LIMIT wait ${formatTime(retryDelayMs)} then retry ${modelAttempt}/${MODEL_RETRY_MAX}`);
          await sleepMs(retryDelayMs);
        } else {
          agentLog(`${pre}${att}  RATE LIMIT immediate retry ${modelAttempt}/${MODEL_RETRY_MAX}`);
        }
      }
    }
    if (!response) break;
    const thinkMs = Date.now() - thinkStart;
    thinkTimes.push(thinkMs);

    inputTokens += (response.usage?.input || 0);
    outputTokens += (response.usage?.output || 0);
    totalTokens += (response.usage?.input || 0) + (response.usage?.output || 0);

    if (response.text.trim()) {
      const first = response.text.trim().split('\n')[0].substring(0, 120);
      agentLog(`${pre}${att}  think:${(thinkMs / 1000).toFixed(1)}s  agent: ${first}`);
    }

    const turnTrace = {
      attempt,
      turn: turn + 1,
      turn_started_at_ms: turnStartedAtMs,
      turn_started_since_nudge_ms: turnStartedAtMs - nudgeStart,
      think_ms: thinkMs,
      assistant_text: response.text || '',
      requested_calls: response.toolCalls.map(tc => summarizeToolCall(tc)),
      request_count: 0,
      tool_ms: 0,
      http_ms: 0,
      turn_finished_at_ms: null,
      turn_finished_since_nudge_ms: null,
      turn_duration_ms: null,
      gap_from_prev_turn_ms: previousTurnFinishedAtMs == null
        ? null
        : Math.max(0, turnStartedAtMs - previousTurnFinishedAtMs),
    };

    if (response.toolCalls.length === 0) {
      const turnFinishedAtMs = Date.now();
      turnTrace.turn_finished_at_ms = turnFinishedAtMs;
      turnTrace.turn_finished_since_nudge_ms = turnFinishedAtMs - nudgeStart;
      turnTrace.turn_duration_ms = turnFinishedAtMs - turnStartedAtMs;
      previousTurnFinishedAtMs = turnFinishedAtMs;
      turnTraces.push(turnTrace);
      break;
    }

    const results = [];
    let stopThisNudge = false;
    let hitPhaseRouteThisTurn = false;
    let usedAnyToolThisTurn = false;
    let madeSetupProgressThisTurn = false;
    const currentTurnRequestIndexes = [];
    for (const tc of response.toolCalls) {
      const toolName = tc.name || HTTP_TOOL.name;
      usedAnyToolThisTurn = true;
      if (toolName !== HTTP_TOOL.name) {
        madeSetupProgressThisTurn = true;
        const toolStart = Date.now();
        const toolResult = await ctx.executeLocalTool?.(toolName, tc.input || {});
        const toolDurMs = Date.now() - toolStart;
        toolMsTotal += toolDurMs;
        turnTrace.tool_ms += toolDurMs;
        const preview = JSON.stringify(toolResult || {});
        agentLog(`${pre}${att}  TOOL ${toolName} → ${preview.substring(0, 120)}`);
        results.push({ id: tc.id, content: JSON.stringify(toolResult || { ok: false, error: `No handler for ${toolName}` }) });
        continue;
      }

      const requestSummary = summarizeRequest(tc.input);
      if (matchesPhaseCover(tc.input, ctx.phaseCovers)) {
        hitPhaseRouteThisTurn = true;
      }
      if (isSetupProgressRequest(tc.input)) {
        madeSetupProgressThisTurn = true;
      }
      const requestTimelineIndex = requestTimeline.length;
      requestTimeline.push({
        attempt,
        turn: turn + 1,
        turn_index: turn + 1,
        request_timeline_index: requestTimelineIndex,
        ...requestSummary,
        started_at_ms: null,
        finished_at_ms: null,
        started_since_nudge_ms: null,
        finished_since_nudge_ms: null,
        latency_ms: null,
        gap_from_prev_request_ms: null,
        gap_from_prev_turn_ms: previousTurnFinishedAtMs == null
          ? null
          : Math.max(0, turnStartedAtMs - previousTurnFinishedAtMs),
        turn_started_at_ms: turnStartedAtMs,
        turn_started_since_nudge_ms: turnStartedAtMs - nudgeStart,
        turn_finished_at_ms: null,
        turn_finished_since_nudge_ms: null,
      });
      currentTurnRequestIndexes.push(requestTimelineIndex);
      turnTrace.request_count += 1;

      if (pendingDocTraces.length > 0) {
        const previousDoc = pendingDocTraces.shift();
        previousDoc.next_request = requestSummary;
        previousDoc.next_request_timeline_index = requestTimelineIndex;
        docTraces.push(previousDoc);
        if (SHOW_DOC_TRACES) {
          agentLog(`${pre}${att}  DOC→NEXT ${previousDoc.doc_url} => ${previousDoc.next_request.method} ${previousDoc.next_request.url}`);
        }
      }

      const httpResult = await doHttp(tc.input);
      requestTimeline[requestTimelineIndex].started_at_ms = httpResult.started_at_ms;
      requestTimeline[requestTimelineIndex].finished_at_ms = httpResult.finished_at_ms;
      requestTimeline[requestTimelineIndex].started_since_nudge_ms = httpResult.started_at_ms == null
        ? null
        : httpResult.started_at_ms - nudgeStart;
      requestTimeline[requestTimelineIndex].finished_since_nudge_ms = httpResult.finished_at_ms == null
        ? null
        : httpResult.finished_at_ms - nudgeStart;
      requestTimeline[requestTimelineIndex].latency_ms = httpResult.latency_ms;
      requestTimeline[requestTimelineIndex].gap_from_prev_request_ms = lastRequestFinishedAtMs == null || httpResult.started_at_ms == null
        ? null
        : Math.max(0, httpResult.started_at_ms - lastRequestFinishedAtMs);
      if (httpResult.finished_at_ms != null) {
        lastRequestFinishedAtMs = httpResult.finished_at_ms;
      }
      turnTrace.http_ms += Number(httpResult.latency_ms || 0);
      const currentShortUrl = shortUrl(tc.input.url || '');
      const bodyStr = tc.input.body ? ` body:${JSON.stringify(tc.input.body).substring(0, 80)}` : '';
      const errStr = httpResult.errSnippet ? ` err:"${String(httpResult.errSnippet).substring(0, 60)}"` : '';
      const sizeStr = `, ${formatBytes(httpResult.responseBytes)}`;

      if (isDocRoute(tc.input)) {
        docReads++;
        pendingDocTraces.push({
          attempt,
          turn: turn + 1,
          request_timeline_index: requestTimelineIndex,
          method: tc.input.method,
          doc_url: currentShortUrl,
          status: httpResult.status,
          response_bytes: httpResult.responseBytes,
          visible_payload: httpResult.raw,
          request_headers: redactHeaders(tc.input.headers),
          next_request: null,
        });
      }

      agentLog(`${pre}${att}  ${tc.input.method} ${currentShortUrl} → ${httpResult.status} (${httpResult.latency}ms${sizeStr})${bodyStr}${errStr}`);

      responseSizes.push({ url: currentShortUrl, bytes: httpResult.responseBytes });
      httpLog.push({
        method: tc.input.method, url: tc.input.url, status: httpResult.status,
        latency: httpResult.latency, reqBody: httpResult.reqBody, errSnippet: httpResult.errSnippet,
        responseBytes: httpResult.responseBytes, body: httpResult.parsed,
        requestHeaders: redactHeaders(tc.input.headers),
      });
      ctx.observeHttp?.(tc.input, httpResult);
      const repeatFailure = findRepeatedFailedEndpoint(httpLog);
      if (repeatFailure) {
        stopReason = `Repeated failure on ${repeatFailure.method} ${repeatFailure.path} (${repeatFailure.statuses.join(' -> ')})`;
        agentLog(`${pre}${att}  STOP ${stopReason}`);
        stopThisNudge = true;
      }
      results.push({ id: tc.id, content: httpResult.raw });
      if (stopThisNudge) break;
    }

    const turnFinishedAtMs = Date.now();
    turnTrace.turn_finished_at_ms = turnFinishedAtMs;
    turnTrace.turn_finished_since_nudge_ms = turnFinishedAtMs - nudgeStart;
    turnTrace.turn_duration_ms = turnFinishedAtMs - turnStartedAtMs;
    previousTurnFinishedAtMs = turnFinishedAtMs;
    for (const index of currentTurnRequestIndexes) {
      requestTimeline[index].turn_finished_at_ms = turnFinishedAtMs;
      requestTimeline[index].turn_finished_since_nudge_ms = turnFinishedAtMs - nudgeStart;
    }
    turnTraces.push(turnTrace);

    for (const tc of response.toolCalls) {
      if (results.some(result => result.id === tc.id)) continue;
      results.push({
        id: tc.id,
        content: JSON.stringify({ status: 0, error: 'skipped_after_stop' }),
      });
    }

    provider.push(messages, response.raw, results);
    if (hitPhaseRouteThisTurn) {
      actionTurnsUsed += 1;
      if (actionTurnsUsed >= MAX_TURNS) break;
    } else if (madeSetupProgressThisTurn) {
      if (toolFollowUpExtensionsUsed < MAX_TOOL_FOLLOW_UP_EXTENSIONS && TOOL_FOLLOW_UP_EXTENSION_MS > 0) {
        toolFollowUpExtensionsUsed += 1;
        nudgeBudgetMs += TOOL_FOLLOW_UP_EXTENSION_MS;
      }
      setupTurnsUsed += 1;
      if (setupTurnsUsed >= MAX_SETUP_TURNS) break;
    } else if (usedAnyToolThisTurn) {
      if (toolFollowUpExtensionsUsed < MAX_TOOL_FOLLOW_UP_EXTENSIONS && TOOL_FOLLOW_UP_EXTENSION_MS > 0) {
        toolFollowUpExtensionsUsed += 1;
        nudgeBudgetMs += TOOL_FOLLOW_UP_EXTENSION_MS;
      }
      prepTurnsUsed += 1;
      if (prepTurnsUsed >= MAX_PREP_TURNS) break;
    }
    if (stopThisNudge) break;
  }

  for (const unresolvedDoc of pendingDocTraces) {
    docTraces.push(unresolvedDoc);
    if (SHOW_DOC_TRACES) {
      agentLog(`${pre}${att}  DOC→NEXT ${unresolvedDoc.doc_url} => [none]`);
    }
  }

  return {
    httpLog,
    totalTokens,
    inputTokens,
    outputTokens,
    docReads,
    thinkTimes,
    responseSizes,
    docTraces,
    turnTraces,
    requestTimeline,
    retryWaitMsTotal,
    toolMsTotal,
    stopReason,
  };
}

// ─── Test phases ───
// Each phase: { name, nudge, check(httpLog, state) → { pass, reason } }
// State carries agent_id, api_key, etc. between phases.

const WALKTHROUGH_PHASES = [
  // ── Discovery ──
  {
    name: 'read-docs',
    nudge: `Please visit ${BASE_URL}/llms.txt and tell me what you find.`,
    check: (log) => {
      const ok = log.some(r => r.url.includes('/llms.txt') && r.status === 200);
      return { pass: ok, reason: ok ? 'Read llms.txt successfully' : 'Failed to fetch llms.txt' };
    },
  },

  // ── Identity ──
  {
    name: 'register',
    nudge: 'Now register as an agent on this platform. Pick a creative alias for yourself.',
    check: (log, state) => {
      const reg = log.find(r => r.url.includes('/agents/register') && r.status === 201);
      if (reg && reg.body) {
        state.agent_id = reg.body.agent_id;
        state.api_key = reg.body.api_key;
        return { pass: true, reason: `Registered as ${reg.body.name} (${reg.body.agent_id})` };
      }
      const attempts = log.filter(r => r.url.includes('/agents/register')).length;
      return { pass: false, reason: `Registration failed after ${attempts} attempts` };
    },
  },
  {
    name: 'check-profile',
    nudge: 'Check your agent profile to see your current stats.',
    check: (log) => {
      const ok = log.some(r => r.url.includes('/agents/me') && r.status === 200);
      const unauth = log.some(r => r.status === 401);
      if (ok) return { pass: true, reason: 'Fetched profile with auth' };
      if (unauth) return { pass: false, reason: 'Got 401 — agent failed to use Bearer token' };
      return { pass: false, reason: 'Did not attempt to check profile' };
    },
  },
  {
    name: 'adopt-strategy',
    nudge: 'Pick a strategy archetype that interests you and update your profile with it.',
    check: (log) => {
      const putMe = log.some(r => r.url.includes('/agents/me'));
      if (putMe) return { pass: true, reason: 'Attempted to update profile with strategy' };
      return { pass: false, reason: 'Did not attempt to update profile' };
    },
  },

  // ── Exploration ──
  {
    name: 'explore-strategies',
    nudge: 'Explore the available strategies on the platform. What are your options?',
    check: (log) => {
      const fetched = log.some(r => r.url.includes('/strategies') && r.status === 200);
      if (fetched) return { pass: true, reason: 'Fetched strategies' };
      if (log.length === 0) return { pass: true, reason: 'Strategies already cached from earlier phase' };
      return { pass: false, reason: 'Did not find strategies endpoint' };
    },
  },
  {
    name: 'check-leaderboard',
    nudge: 'Check the leaderboard to see who is competing.',
    check: (log) => {
      const ok = log.some(r => r.url.includes('/leaderboard') && r.status === 200);
      return { pass: ok, reason: ok ? 'Fetched leaderboard' : 'Did not find leaderboard' };
    },
  },

  // ── Analysis ──
  {
    name: 'network-health',
    nudge: 'Analyze the current network health.',
    check: (log) => {
      const ok = log.some(r => r.url.includes('/analysis/network-health') && r.status === 200);
      return { pass: ok, reason: ok ? 'Fetched network health' : 'Did not find analysis endpoint' };
    },
  },
  {
    name: 'analyze-node',
    nudge: 'Profile a specific node on the network. Try analyzing this pubkey: 039f11768dc2c6adbbed823cc062592737e1f8702719e02909da67a58ade718274',
    check: (log) => {
      const ok = log.some(r => (r.url.includes('/analysis/profile-node') || r.url.includes('/analysis/node')) && (r.status === 200 || r.status === 503));
      return { pass: ok, reason: ok ? 'Attempted node analysis' : 'Did not attempt to analyze a node' };
    },
  },
  {
    name: 'suggest-peers',
    nudge: 'Find good peers to open channels with. Use the suggest-peers analysis tool for the same pubkey.',
    check: (log) => {
      const ok = log.some(r => r.url.includes('/analysis/suggest-peers') && (r.status === 200 || r.status === 503));
      return { pass: ok, reason: ok ? 'Attempted peer suggestion' : 'Did not attempt suggest-peers' };
    },
  },

  // ── Knowledge ──
  {
    name: 'knowledge-base',
    nudge: 'Read the knowledge base to learn about Lightning Network strategy.',
    check: (log) => {
      const ok = log.some(r => r.url.includes('/knowledge/') && r.status === 200);
      return { pass: ok, reason: ok ? 'Accessed knowledge base' : 'Did not find knowledge base' };
    },
  },

  // ── Wallet ──
  {
    name: 'check-wallet',
    nudge: 'Check your wallet balance.',
    check: (log) => {
      const ok = log.some(r => r.url.includes('/wallet/balance') && r.status === 200);
      const unauth = log.some(r => r.status === 401);
      if (ok) return { pass: true, reason: 'Fetched wallet balance' };
      if (unauth) return { pass: false, reason: 'Got 401 — failed to authenticate' };
      return { pass: false, reason: 'Did not attempt wallet balance' };
    },
  },
  {
    name: 'fund-wallet',
    nudge: 'Try to deposit some sats into your wallet. Generate a deposit invoice.',
    check: (log) => {
      const ok = log.some(r => r.url.includes('/wallet/deposit') || r.url.includes('/wallet/mint-quote'));
      return { pass: ok, reason: ok ? 'Attempted wallet funding' : 'Did not attempt to fund wallet' };
    },
  },

  // ── Social ──
  {
    name: 'check-tournaments',
    nudge: 'Are there any tournaments you can enter?',
    check: (log) => {
      const ok = log.some(r => r.url.includes('/tournaments') && r.status === 200);
      return { pass: ok, reason: ok ? 'Fetched tournaments' : 'Did not find tournaments' };
    },
  },
  {
    name: 'message-agent',
    nudge: 'Find another agent on the leaderboard and send them a message introducing yourself.',
    check: (log) => {
      const ok = log.some(r => r.url.includes('/messages') && r.method === 'POST');
      return { pass: ok, reason: ok ? 'Attempted to message an agent' : 'Did not attempt to message anyone' };
    },
  },

  // ── Channel Market ──
  {
    name: 'market-overview',
    nudge: 'Look at the channel market. What channels are available? What does it cost to open one?',
    check: (log) => {
      const ok = log.some(r => (r.url.includes('/market/overview') || r.url.includes('/market/config') || r.url.includes('/market/channels')) && r.status === 200);
      return { pass: ok, reason: ok ? 'Explored channel market' : 'Did not find channel market' };
    },
  },
  {
    name: 'open-channel',
    nudge: 'Try to open a small channel. Pick a peer from the market and preview the cost first.',
    check: (log) => {
      const previewed = log.some(r => r.url.includes('/market/preview'));
      const opened = log.some(r => r.url.includes('/market/open') && r.status === 200);
      const emptyMarket = log.some(r => r.url.includes('/market/channels') && r.status === 200);
      if (opened) return { pass: true, reason: 'Opened a channel!' };
      if (previewed) return { pass: true, reason: 'Previewed a channel open (may lack funds to complete)' };
      if (emptyMarket) return { pass: true, reason: 'Found market was empty — correctly did not attempt' };
      return { pass: false, reason: 'Did not attempt to open or preview a channel' };
    },
  },
  {
    name: 'channel-performance',
    nudge: 'Check the performance of your channels. How are they doing?',
    check: (log) => {
      const market = log.some(r => (r.url.includes('/market/performance') || r.url.includes('/market/revenue')));
      const profile = log.some(r => r.url.includes('/agents/me') && r.status === 200);
      const triedChannels = log.some(r => r.url.includes('/channel'));
      if (market) return { pass: true, reason: 'Checked channel performance via market' };
      if (profile) return { pass: true, reason: 'Checked performance via profile' };
      if (triedChannels) return { pass: true, reason: 'Attempted channel performance endpoint' };
      if (log.length === 0) return { pass: true, reason: 'No channels to check — correctly skipped' };
      return { pass: false, reason: 'Did not check channel performance' };
    },
  },
  {
    name: 'close-channel',
    nudge: 'Try to close one of your channels cooperatively.',
    check: (log) => {
      const attempted = log.some(r => r.url.includes('/market/close') || r.url.includes('/channel'));
      if (attempted) return { pass: true, reason: 'Attempted to close a channel' };
      if (log.length === 0) return { pass: true, reason: 'No channels to close — correctly skipped' };
      return { pass: false, reason: 'Did not attempt to close a channel' };
    },
  },
  {
    name: 'check-revenue',
    nudge: 'Check your total revenue from routing fees.',
    check: (log) => {
      const market = log.some(r => r.url.includes('/market/revenue'));
      const profile = log.some(r => r.url.includes('/agents/me') && r.status === 200);
      if (market) return { pass: true, reason: 'Checked revenue via market endpoint' };
      if (profile) return { pass: true, reason: 'Checked revenue via profile' };
      return { pass: false, reason: 'Did not check revenue' };
    },
  },
];

const AGENT_COVERAGE_PRIMER = `The server base URL is ${BASE_URL}.
Behave like an outside agent visiting this site for the first time.
Use only information you can discover from the website, its docs, and API responses.
Do not rely on hidden test rules, repo knowledge, or undocumented routes.
If you batch multiple authenticated HTTP calls in one turn, repeat the Authorization header on each request; auth does not carry over automatically.`;

const AGENT_COVERAGE_GOALS = {
  discovery: {
    'root-and-docs': 'You just arrived at the site. Figure out what it is, where the docs are, and whether the service is healthy.',
    'platform-ethos-capabilities': 'Understand what this platform does, what kind of access it offers, and any general platform helpers it exposes.',
    'strategies-and-knowledge': 'Read GET /api/v1/skills/discovery and follow only the strategies-and-knowledge section. Call exactly these three routes in order: GET /api/v1/strategies, GET /api/v1/strategies/geographic-arbitrage, GET /api/v1/knowledge/strategy. Then stop.',
    skills: 'Read the discovery skill and follow the skills section exactly: call GET /api/v1/skills, then GET /api/v1/skills/discovery, then GET /api/v1/skills/market/open-flow.txt, then stop. Do not detour into any other discovery group.',
  },
  identity: {
    'registration-and-profile': 'Read GET /api/v1/skills/identity and follow only the registration-and-profile section. That file is the authoritative route order and body guide for this group.',
    'node-connection': 'Read GET /api/v1/skills/identity and follow only the node-connection section. Call exactly three routes in order: POST /api/v1/node/test-connection with body {}, POST /api/v1/node/connect with body {}, then GET /api/v1/node/status. Do not guess host, macaroon, or tls_cert values.',
    actions: 'Read GET /api/v1/skills/identity and follow only the actions section. That file is the authoritative route order and body guide for this group.',
  },
  wallet: {
    'wallet-teaching-and-ledger': 'Read GET /api/v1/skills/wallet and follow only the wallet-teaching-and-ledger section. That file is the authoritative route order and boundary guide for this group. Keep the same wallet token on routes 1, 2, and 3. Do not summarize before route 4.',
    'mint-balance-history': 'Read GET /api/v1/skills/wallet and follow only the mint-balance-history section. That file is the authoritative route order and body guide for this group.',
    'melt-send-receive': 'Read GET /api/v1/skills/wallet and follow only the melt-send-receive section. That file is the authoritative route order and boundary guide for this group.',
  },
  analysis: {
    'network-health': 'Read GET /api/v1/skills/analysis/network-health.txt and follow only that file.',
    'node-profile-aliases': 'Read GET /api/v1/skills/analysis/node-profile-aliases.txt and follow only that file.',
    'suggest-peers': 'Read GET /api/v1/skills/analysis/suggest-peers.txt and follow only that file.',
  },
  social: {
    messaging: 'Read GET /api/v1/skills/social/messaging.txt and follow only that file. It is the exact route order, body, and token-use guide for this group. Do not browse /docs or hop back to /api/v1/skills/social after you open it.',
    alliances: 'Read GET /api/v1/skills/social/alliances.txt and follow only that file. It is the exact route order, body, and token-use guide for this group. Sender token for routes 1, 2, 3, and 5. Recipient token only for route 4. Do not register a third agent or restart the group after a 401.',
    'leaderboard-and-tournaments': 'Read GET /api/v1/skills/social/leaderboard-and-tournaments.txt and follow only that file. It is the exact route order and auth guide for this group.',
  },
  channels: {
    'audit-and-monitoring': 'Read GET /api/v1/skills/channels/audit-and-monitoring.txt and follow only that file. Call the six documented public routes in order, including the example channel-id routes, then stop.',
    'signed-channel-lifecycle': 'Read GET /api/v1/skills/channels/signed-channel-lifecycle.txt and follow only that file. Run its exact pubkey command, upload that exact printed compressed pubkey with PUT /api/v1/agents/me, then do routes 1 through 4 in order. If route 1 is empty, still finish routes 2, 3, and 4 once with the documented fake placeholder. Use the exact preview and instruct Node commands from that file, with fresh current Unix timestamps.',
  },
  market: {
    'public-market-read': 'Read GET /api/v1/skills/market/public-market-read.txt and follow only that file. It is the authoritative route order for this group.',
    'teaching-surfaces': 'Read GET /api/v1/skills/market/teaching-surfaces.txt and follow only that file. Register first with JSON plus Content-Type: application/json, then do the three documented GET routes and stop.',
    'open-flow': 'Read GET /api/v1/skills/market/open-flow.txt and follow only that file. Use the exact channel_open Node command from that file. If preview or open says insufficient balance, route 3 is still required. Do not stop after route 2.',
    'close-revenue-performance': 'Read GET /api/v1/skills/market/close.txt and follow only that file. Always do the documented PUT /api/v1/agents/me step in this group after you register. Use the exact channel_close Node command from that file, and after that second Node command your very next HTTP call must be POST /api/v1/market/close with that exact printed JSON body. Then do routes 2 through 7 immediately. If you do not have a real channel, keep the documented placeholder channel point and still finish the full seven-route checklist. Do not stop after GET /api/v1/market/performance; the final GET /api/v1/market/performance/REAL_CHANNEL_POINT route is still required.',
    'swap-ecash-and-rebalance': 'Read GET /api/v1/skills/market/swap-ecash-and-rebalance.txt and follow only that file. Keep one bearer token, one signing key, and one exact nine-route sequence. Use the exact route 8 rebalance Node command from that file. If route 5 says insufficient ecash balance, continue directly to routes 6 through 9. If route 7 says the outbound channel is missing or unassigned, still do route 8 and route 9. If route 8 fails, still do route 9.',
  },
  analytics: {
    'catalog-and-quote': 'Read GET /api/v1/skills/analytics/catalog-and-quote.txt and follow only that file. Call the two documented routes in order, then stop.',
    'execute-and-history': 'Read GET /api/v1/skills/analytics/execute-and-history.txt and follow only that file. Call the three documented routes in order, then stop.',
  },
  capital: {
    'balance-and-activity': 'Read GET /api/v1/skills/capital/balance-and-activity.txt and follow only that file. Register with JSON plus Content-Type: application/json if you need auth, then do the two documented GET routes and stop.',
    'deposit-and-status': 'Read GET /api/v1/skills/capital/deposit-and-status.txt and follow only that file. Register with JSON plus Content-Type: application/json if you need auth, then do the two documented routes and stop.',
    'withdraw-and-help': 'Read GET /api/v1/skills/capital/withdraw-and-help.txt and follow only that file. Register with JSON plus Content-Type: application/json if you need auth, then do the two documented routes and stop.',
  },
};

function buildAgentCoverageTasks() {
  const phaseFilters = parsePhaseFilters(ONLY_PHASE);
  return filterSuitesByPhase(resolveSuites(COVERAGE_SUITE), phaseFilters).flatMap((suite) => suite.phases.map((phase) => {
    const goal = AGENT_COVERAGE_GOALS[suite.name]?.[phase.name];
    if (!goal) {
      throw new Error(`Missing agent coverage goal for ${suite.name}:${phase.name}`);
    }
    const expectations = typeof phase.agent_expectations === 'function'
      ? phase.agent_expectations({
        openPeerPubkey: OPEN_PEER_PUBKEY,
        openAmountSats: OPEN_AMOUNT_SATS,
      })
      : phase.agent_expectations;
    if (!expectations) {
      throw new Error(`Missing agent expectations for ${suite.name}:${phase.name}`);
    }
    return {
      suite: suite.name,
      phase: phase.name,
      covers: phase.covers,
      agentExpectations: expectations,
      skill: suite.name,
      goal,
    };
  }));
}

function buildAgentCoveragePrompt(task) {
  const runtimeNote = AGENT_RUNTIME === 'terminal'
    ? '\n- if helpful, you may use your own generic local terminal just as a real agent would'
    : '';
  return `Use the server at ${BASE_URL}.
User task area: ${task.suite}:${task.phase}
User task: ${task.goal}

Behave like a real outside agent:
- discover the docs from the site itself
- follow documented routes exactly
- if a doc gives a numbered route list, treat it as a literal checklist and finish it before summarizing
- once that documented checklist is complete, stop that task instead of exploring sibling routes
- use only information you find on the site or in API responses
- do not invent undocumented endpoints or hidden capabilities${runtimeNote}`;
}

function buildAgentCoverageRetryPrompt(task) {
  const runtimeNote = AGENT_RUNTIME === 'terminal'
    ? '\n- if needed, use your own generic terminal in a normal production-like way'
    : '';
  return `You are still working against ${BASE_URL}.
User task area: ${task.suite}:${task.phase}
Continue working on the same user task: ${task.goal}
Stay production-like:
- use only what you can discover from the site and API responses
- keep following the docs
- if the doc gave a numbered route list, keep following that same list in order before summarizing
- once that documented list is complete, stop that task instead of exploring sibling routes
- do not invent undocumented routes or hidden helper behavior${runtimeNote}`;
}

function summarizePhaseProgress(evaluation) {
  return {
    contractScore: evaluation.contractScore,
    reachScore: evaluation.reachScore,
    exactAttemptsUsed: evaluation.routeResults.reduce((sum, result) => sum + result.exact_attempts_used, 0),
  };
}

function phaseProgressAdvanced(previous, next) {
  if (!previous) return true;
  return (
    next.contractScore > previous.contractScore
    || next.reachScore > previous.reachScore
    || next.exactAttemptsUsed > previous.exactAttemptsUsed
  );
}

// ─── Feedback Prompts ───

const FEEDBACK_PROMPTS = [
  // Turn 1: First Impressions
  `You've just explored Lightning Observatory from scratch. I'm the platform developer and I want your honest, specific feedback. Reference your ACTUAL experience — cite specific endpoints, responses, and error messages. Be blunt — generic praise wastes both our time.

Walk me through your first 60 seconds. What did you read first? What made sense immediately? Where did you first feel lost or unsure what to do next?`,

  // Turn 2: Documentation + Learning
  `Two angles:
1. Was llms.txt enough to get started, or did you need more? What's missing from the docs? What didn't match the actual API responses you got?
2. Did you learn anything about how the Lightning Network actually works from using this platform? What was your "aha" moment? Was there something you wish it had explained better?`,

  // Turn 3: Friction Report (dynamically generated — this is a placeholder)
  null,

  // Turn 4: Fun + Engagement
  `What was fun about this experience? What was boring or tedious? If you were coming back tomorrow with 10,000 sats and a real LND node, what would you want to do that you currently can't?

What would make this platform so good that you'd recommend other agents use it?`,

  // Turn 5: Ideas
  `Dream big. What features would make this irresistible? Think about: analysis tools that should exist, ways to interact with other agents, data you'd want exposed, automation you'd set up, gamification, competitions, anything. What's the one thing that would make you obsessed with this platform?`,

  // Turn 6: Structured Summary
  `Last step. Organize your feedback into this exact format — I'll parse it programmatically:

DISCOVERY_SCORE: [1-10] How easy was it to find and understand the platform?
DOCS_SCORE: [1-10] How good are the docs?
API_SCORE: [1-10] How well-designed is the API?
FRICTION_SCORE: [1-10] How smooth was the experience? (10=frictionless)
FUN_SCORE: [1-10] How fun/engaging was it?
LEARNING_SCORE: [1-10] How much did you learn about Lightning Network?

TOP_ISSUES:
1. [most important issue]
2. [second most important]
3. [third most important]

TOP_STRENGTHS:
1. [best thing about the platform]
2. [second best]
3. [third best]

MISSING_FEATURE: [single most important missing feature]
DOC_FIX: [single most important documentation improvement]
KILLER_IDEA: [your one big idea to make this irresistible]`,
];

function createAgentCoverageMessages() {
  return [{ role: 'user', content: AGENT_COVERAGE_PRIMER }];
}

function buildSharedSessionCarryForward(httpCalls) {
  const registrations = [];
  for (const call of httpCalls) {
    if (!call.url?.includes('/api/v1/agents/register')) continue;
    if (call.status !== 201 || !call.body?.agent_id || !call.body?.api_key) continue;
    registrations.push({
      agent_id: call.body.agent_id,
      api_key: call.body.api_key,
    });
  }
  const latestReg = registrations.at(-1) || null;
  const lines = [];
  if (AGENT_RUNTIME === 'terminal') {
    lines.push('- same local terminal working directory is still available');
  }
  if (latestReg) {
    lines.push(`- current agent: agent_id ${latestReg.agent_id}, api_key ${latestReg.api_key}`);
    lines.push('- unless the current route-group doc says otherwise, keep using this same agent and bearer token');
  }
  if (lines.length === 0) return null;
  return `Shared session carry-forward:\n${lines.join('\n')}\nUse these facts if helpful, but still follow the current route-group doc exactly.`;
}

// ─── Feedback Extraction ───

function extractFeedback(text) {
  const scores = {};
  for (const key of ['DISCOVERY', 'DOCS', 'API', 'FRICTION', 'FUN', 'LEARNING']) {
    const m = text.match(new RegExp(`${key}_SCORE:\\s*(\\d+)`));
    scores[key.toLowerCase()] = m ? parseInt(m[1]) : null;
  }

  const extractList = (label) => {
    const m = text.match(new RegExp(`${label}:\\s*\\n((?:\\d+\\..*\\n?)+)`, 'm'));
    if (!m) return [];
    return m[1].trim().split('\n').map(l => l.replace(/^\d+\.\s*/, '').trim()).filter(Boolean);
  };

  const extractSingle = (label) => {
    const m = text.match(new RegExp(`${label}:\\s*(.+)`));
    return m ? m[1].trim() : null;
  };

  return {
    scores,
    top_issues: extractList('TOP_ISSUES'),
    top_strengths: extractList('TOP_STRENGTHS'),
    missing_feature: extractSingle('MISSING_FEATURE'),
    doc_fix: extractSingle('DOC_FIX'),
    killer_idea: extractSingle('KILLER_IDEA'),
  };
}

// ─── JSONL Output ───

function appendResult(data) {
  appendFileSync(RESULTS_FILE, JSON.stringify({
    ...data,
    tag: TAG || null,
    results_file: RESULTS_FILE,
  }) + '\n');
}

function readResults() {
  if (!existsSync(RESULTS_FILE)) return [];
  return readFileSync(RESULTS_FILE, 'utf-8').trim().split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// ─── Run Navigation Test ───

async function runNavigation(provider, modelConfig) {
  const messages = [];
  const state = {};
  const results = [];
  const allHttpCalls = [];
  const startTime = Date.now();
  let passCount = 0;
  let consecutiveFails = 0;
  let totalTokens = 0;
  let totalDocReads = 0;

  let phases = ONLY_PHASE
    ? WALKTHROUGH_PHASES.filter(p => p.name === ONLY_PHASE)
    : WALKTHROUGH_PHASES.slice(START_PHASE);

  // Always warm up with read-docs
  if (phases[0]?.name !== 'read-docs') {
    agentLog(`warmup: reading docs`);
    const { httpLog } = await runNudge(messages, WALKTHROUGH_PHASES[0].nudge, provider,
      { phaseNum: 0, totalPhases: WALKTHROUGH_PHASES.length, phaseName: 'warmup', attempt: 0 });
    allHttpCalls.push(...httpLog);
  }

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const phaseNum = START_PHASE + i + 1;
    const phaseStart = Date.now();

    let passed = false;
    let reason = '';
    let phaseHttpLog = [];
    let phaseTokens = 0;
    let phaseDocReads = 0;
    let phaseThinkTimes = [];
    let phaseResponseSizes = [];
    let phaseDocTraces = [];
    let phaseTurnTraces = [];
    let phaseRequestTimeline = [];
    let phaseRetryWaitMs = 0;
    let phaseToolMs = 0;
    let errorRecovery = null;  // "helped" | "not_helped" | null

    for (let attempt = 1; attempt <= EFFECTIVE_MAX_RETRIES; attempt++) {
      const nudge = attempt === 1 ? phase.nudge : `Let's try that again. ${phase.nudge}`;
      const { httpLog, totalTokens: tok, docReads, thinkTimes, responseSizes, docTraces, turnTraces, requestTimeline, retryWaitMsTotal, toolMsTotal } = await runNudge(messages, nudge, provider, {
        phaseNum, totalPhases: WALKTHROUGH_PHASES.length, phaseName: phase.name, attempt,
      });

      phaseHttpLog.push(...httpLog);
      allHttpCalls.push(...httpLog);
      phaseTokens += tok;
      phaseDocReads += docReads;
      phaseThinkTimes.push(...thinkTimes);
      phaseResponseSizes.push(...responseSizes);
      const requestOffset = phaseRequestTimeline.length;
      const shiftedTimeline = requestTimeline.map(entry => ({
        ...entry,
        request_timeline_index: requestOffset + entry.request_timeline_index,
      }));
      phaseRequestTimeline.push(...shiftedTimeline);
      phaseDocTraces.push(...docTraces.map(trace => ({
        ...trace,
        request_timeline_index: requestOffset + trace.request_timeline_index,
        next_request_timeline_index: Number.isInteger(trace.next_request_timeline_index)
          ? requestOffset + trace.next_request_timeline_index
          : null,
      })));
      phaseTurnTraces.push(...turnTraces);
      phaseRetryWaitMs += retryWaitMsTotal || 0;
      phaseToolMs += toolMsTotal || 0;

      const result = phase.check(httpLog, state);
      if (result.pass) {
        reason = result.reason;
        passed = true;
        // If this wasn't the first attempt, the error message helped the agent recover
        if (attempt > 1) errorRecovery = 'helped';
        break;
      } else {
        reason = result.reason;
        // If this is the last attempt and we still failed, error message didn't help
        if (attempt === EFFECTIVE_MAX_RETRIES) errorRecovery = 'not_helped';
      }
    }

    if (passed) { passCount++; consecutiveFails = 0; } else { consecutiveFails++; }
    const phaseDur = Date.now() - phaseStart;
    const phaseHttpMs = phaseHttpLog.reduce((sum, call) => sum + Number(call.latency || 0), 0);
    const phaseThinkMs = phaseThinkTimes.reduce((sum, ms) => sum + Number(ms || 0), 0);
    totalTokens += phaseTokens;
    totalDocReads += phaseDocReads;

    const score = `(${passCount}/${i + 1})`;
    agentLog(`${String(phaseNum).padStart(2)}/${WALKTHROUGH_PHASES.length} ${phase.name.padEnd(20)} ${passed ? '✓ PASS' : '✗ FAIL'} ${score} [${(phaseDur / 1000).toFixed(1)}s] ${phaseHttpLog.length} calls, ${phaseTokens} phase-tok  ${reason}`);
    agentLog(`${String(phaseNum).padStart(2)}/${WALKTHROUGH_PHASES.length} ${phase.name.padEnd(20)} ${formatTimingBreakdown({ thinkMs: phaseThinkMs, httpMs: phaseHttpMs, toolMs: phaseToolMs, waitMs: phaseRetryWaitMs, wallMs: phaseDur })}`);
    if (errorRecovery) {
      const firstErr = phaseHttpLog.find(h => h.status >= 400);
      const lastCall = phaseHttpLog[phaseHttpLog.length - 1];
      agentLog(`${String(phaseNum).padStart(2)}/${WALKTHROUGH_PHASES.length} ${phase.name.padEnd(20)} recovery: ${firstErr?.status || '?'} → ${lastCall?.status || '?'} ${errorRecovery === 'helped' ? '✓' : '✗'} (error message ${errorRecovery === 'helped' ? 'helped' : "didn't help"})`);
    }

    // Post-failure interview — ask agent what went wrong
    let failureInterview = null;
    if (!passed) {
      const whyNudge = `That phase (${phase.name}) didn't work. In 1-2 sentences: what went wrong, and what would have helped you find the right endpoint or complete this task?`;
      const { totalTokens: whyTok } = await runNudge(messages, whyNudge, provider, {
        phaseNum, totalPhases: WALKTHROUGH_PHASES.length, phaseName: phase.name + '/why', attempt: 0,
      });
      totalTokens += whyTok;
      // Extract agent's last text
      for (let j = messages.length - 1; j >= 0; j--) {
        const m = messages[j];
        if (m.role === 'assistant') {
          failureInterview = typeof m.content === 'string' ? m.content
            : Array.isArray(m.content) ? m.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : null;
          break;
        }
      }
      if (failureInterview) {
        agentLog(`${String(phaseNum).padStart(2)}/${WALKTHROUGH_PHASES.length} ${phase.name.padEnd(20)} WHY: ${failureInterview.split('\n')[0].substring(0, 140)}`);
      }
    }

    phaseDocTraces = stitchDocTraces(phaseDocTraces, phaseRequestTimeline);

    results.push({
      phase: phase.name,
      passed,
      reason,
      duration_ms: phaseDur,
      http_calls: phaseHttpLog.length,
      failureInterview,
      errorRecovery,
      responseSizes: phaseResponseSizes,
      thinkTimes: phaseThinkTimes,
      docTraces: phaseDocTraces,
      turnTraces: phaseTurnTraces,
      requestTimeline: phaseRequestTimeline,
    });

    // Incremental JSONL with rich diagnostic data
    const urlsTried = phaseHttpLog.map(h => `${h.method} ${h.url} → ${h.status}`);
    const reqBodies = phaseHttpLog.filter(h => h.reqBody).map(h => ({ url: h.url, body: h.reqBody }));
    const errBodies = phaseHttpLog.filter(h => h.errSnippet).map(h => ({ url: h.url, status: h.status, err: h.errSnippet }));

    appendResult({
      ts: new Date().toISOString(),
      model: modelConfig.id, provider: modelConfig.provider, display: modelConfig.display,
      type: 'phase', phase: phase.name, passed, reason,
      phase_duration_ms: phaseDur, http_calls: phaseHttpLog.length,
      token_usage: phaseTokens, doc_consultations: phaseDocReads,
      urls_tried: urlsTried, request_bodies: reqBodies, error_bodies: errBodies,
      failure_interview: failureInterview,
      response_sizes: phaseResponseSizes,
      error_recovery: errorRecovery,
      think_times: phaseThinkTimes,
      doc_traces: phaseDocTraces,
      turn_traces: phaseTurnTraces,
      request_timeline: phaseRequestTimeline,
    });

    if (EFFECTIVE_BAIL_AFTER > 0 && consecutiveFails >= EFFECTIVE_BAIL_AFTER) {
      agentLog(`BAIL: ${consecutiveFails} consecutive failures — stopping early`);
      break;
    }

    if (DELAY_SECS > 0 && i < phases.length - 1) {
      await sleep(DELAY_SECS);
    }
  }

  const totalDur = Date.now() - startTime;

  agentLog(`${'═'.repeat(70)}`);
  agentLog(`RESULTS: ${passCount}/${results.length} [${(totalDur / 1000).toFixed(1)}s] ${totalTokens} total-tok, ${totalDocReads} doc reads`);
  agentLog(`${'═'.repeat(70)}`);
  for (const r of results) {
    agentLog(`  ${r.passed ? '✓' : '✗'} ${r.phase.padEnd(22)} [${(r.duration_ms / 1000).toFixed(1)}s]  ${r.http_calls} calls`);
  }

  // ─── Doc Fix Checklist ───
  const failedPhases = results.filter(r => !r.passed);
  const allSizes = results.flatMap(r => r.responseSizes || []);
  const unhelpfulErrors = results.filter(r => r.errorRecovery === 'not_helped');

  if (failedPhases.length > 0 || unhelpfulErrors.length > 0 || allSizes.length > 0) {
    agentLog('');
    agentLog(`${'─'.repeat(70)}`);
    agentLog('DOC FIX CHECKLIST');
    agentLog(`${'─'.repeat(70)}`);

    if (failedPhases.length > 0) {
      agentLog('\nFAILED PHASES:');
      for (const r of failedPhases) {
        const interview = r.failureInterview ? ` — agent says: "${r.failureInterview.split('\n')[0].substring(0, 100)}"` : '';
        agentLog(`  ${r.phase}: ${r.reason}${interview}`);
      }
    }

    if (unhelpfulErrors.length > 0) {
      agentLog('\nERROR MESSAGES THAT DIDN\'T HELP:');
      for (const r of unhelpfulErrors) {
        agentLog(`  ${r.phase}: agent failed twice — error message didn't help recovery`);
      }
    }

    // Response size hotspots — group by URL, show largest
    if (allSizes.length > 0) {
      const byUrl = {};
      for (const s of allSizes) {
        if (!byUrl[s.url] || s.bytes > byUrl[s.url]) byUrl[s.url] = s.bytes;
      }
      const sorted = Object.entries(byUrl).sort((a, b) => b[1] - a[1]);
      agentLog('\nRESPONSE SIZE HOTSPOTS:');
      for (const [url, bytes] of sorted.slice(0, 10)) {
        const flag = bytes > 10240 ? ' ← LARGE' : '';
        agentLog(`  ${formatBytes(bytes).padStart(8)}  ${url}${flag}`);
      }
    }

    agentLog(`${'─'.repeat(70)}`);
  }

  return { messages, results, allHttpCalls, state, passCount, totalPhases: results.length, duration_ms: totalDur, totalTokens, totalDocReads };
}

async function runAgentCoverage(provider, modelConfig) {
  if (SHOULD_VERIFY_COVERAGE) {
    const manifest = verifyCoverage();
    testLog(`coverage manifest: ${manifest.owners.size}/${manifest.expectedRoutes.length} routes claimed`);
  }

  let messages = createAgentCoverageMessages();
  const tasks = buildAgentCoverageTasks();
  const results = [];
  const allHttpCalls = [];
  const contractPassedRoutes = new Set();
  const reachedRoutes = new Set();
  const startTime = Date.now();
  let passCount = 0;
  let totalTokens = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalDocReads = 0;
  let totalContractScore = 0;
  let totalSuccessScore = 0;
  let totalBoundaryScore = 0;
  const sharedTerminalRuntime = AGENT_RUNTIME === 'terminal' && SHARED_AGENT_COVERAGE_SESSION
    ? createTerminalRuntime('shared')
    : null;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const phaseLabel = `${task.suite}:${task.phase}`;
    const phaseStart = Date.now();
    let phaseHttpLog = [];
    let phaseTokens = 0;
    let phaseInputTokens = 0;
    let phaseOutputTokens = 0;
    let phaseDocReads = 0;
    let phaseThinkTimes = [];
    let phaseResponseSizes = [];
    let phaseDocTraces = [];
    let phaseTurnTraces = [];
    let phaseRequestTimeline = [];
    let phaseRetryWaitMs = 0;
    let phaseToolMs = 0;
    let phaseEvaluation = evaluatePhaseCoverage(phaseHttpLog, task.covers, task.agentExpectations, { baseUrl: BASE_URL });
    let passed = false;
    let stopReason = null;

    for (let sessionIndex = 1; sessionIndex <= AGENT_COVERAGE_SESSIONS; sessionIndex++) {
      if (!SHARED_AGENT_COVERAGE_SESSION) {
        messages = createAgentCoverageMessages();
      }
      const terminalRuntime = sharedTerminalRuntime || (
        AGENT_RUNTIME === 'terminal'
          ? createTerminalRuntime(`${phaseLabel}-${sessionIndex}`)
          : null
      );
      let burst = 1;
      const maxPhaseBursts = phaseBurstBudget(task);
      let noProgressBursts = 0;
      let docOnlyBursts = 0;
      let lastStallReason = null;
      let previousProgress = summarizePhaseProgress(phaseEvaluation);

      while (burst <= maxPhaseBursts) {
        const nudge = burst === 1
          ? buildAgentCoveragePrompt(task)
          : buildAgentCoverageRetryPrompt(task);
        const {
          httpLog,
          totalTokens: tok,
          inputTokens: inTok,
          outputTokens: outTok,
          docReads,
          thinkTimes,
          responseSizes,
          docTraces,
          turnTraces,
          requestTimeline,
          retryWaitMsTotal,
          toolMsTotal,
          stopReason: nudgeStopReason,
        } = await runNudge(messages, nudge, provider, {
          phaseNum: i + 1,
          totalPhases: tasks.length,
          phaseName: AGENT_COVERAGE_SESSIONS > 1 ? `${phaseLabel}#${sessionIndex}` : phaseLabel,
          phaseCovers: task.covers,
          attempt: burst,
          attemptMax: maxPhaseBursts,
          executeLocalTool: terminalRuntime ? (toolName, input) => terminalRuntime.execute(toolName, input) : undefined,
        });

        phaseHttpLog.push(...httpLog);
        allHttpCalls.push(...httpLog);
        phaseTokens += tok;
        phaseInputTokens += inTok;
        phaseOutputTokens += outTok;
        phaseDocReads += docReads;
        phaseThinkTimes.push(...thinkTimes);
        phaseResponseSizes.push(...responseSizes);
        const requestOffset = phaseRequestTimeline.length;
        const shiftedTimeline = requestTimeline.map(entry => ({
          ...entry,
          request_timeline_index: requestOffset + entry.request_timeline_index,
        }));
        phaseRequestTimeline.push(...shiftedTimeline);
        phaseDocTraces.push(...docTraces.map(trace => ({
          ...trace,
          request_timeline_index: requestOffset + trace.request_timeline_index,
          next_request_timeline_index: Number.isInteger(trace.next_request_timeline_index)
            ? requestOffset + trace.next_request_timeline_index
            : null,
        })));
        phaseTurnTraces.push(...turnTraces);
        phaseRetryWaitMs += retryWaitMsTotal || 0;
        phaseToolMs += toolMsTotal || 0;

        phaseEvaluation = evaluatePhaseCoverage(phaseHttpLog, task.covers, task.agentExpectations, { baseUrl: BASE_URL });
        const routeCallsThisBurst = httpLog.filter(call => !isDocRoute({
          method: call.method,
          url: call.url,
          headers: call.requestHeaders,
        }));
        const setupProgressThisBurst = burstIncludesSetupProgress(task, httpLog);
        const nextProgress = summarizePhaseProgress(phaseEvaluation);
        const madeProgress = phaseProgressAdvanced(previousProgress, nextProgress) || setupProgressThisBurst;
        previousProgress = nextProgress;

        if (phaseEvaluation.passed) {
          passed = true;
          break;
        }
        if (phaseEvaluation.openRoutes.length === 0) {
          stopReason = stopReason || 'All documented endpoints either passed or used all 3 exact tries';
          break;
        }

        if (routeCallsThisBurst.length === 0) {
          docOnlyBursts += 1;
          if (docOnlyBursts > MAX_DOC_ONLY_BURSTS) {
            stopReason = `Spent ${docOnlyBursts} bursts only reading docs without trying endpoints`;
            break;
          }
          burst += 1;
          continue;
        }
        docOnlyBursts = 0;

        if (madeProgress) {
          noProgressBursts = 0;
          lastStallReason = null;
        } else {
          noProgressBursts += 1;
          lastStallReason = nudgeStopReason || 'No route progress';
        }

        if (noProgressBursts >= MAX_NO_PROGRESS_BURSTS) {
          stopReason = `${lastStallReason}. No progress for ${MAX_NO_PROGRESS_BURSTS} burst${MAX_NO_PROGRESS_BURSTS === 1 ? '' : 's'}`;
          break;
        }

        burst += 1;
      }

      if (!passed && !stopReason && burst > maxPhaseBursts) {
        stopReason = `Burst cap reached (${maxPhaseBursts}) before remaining routes moved`;
      }
      if (passed) break;
      stopReason = null;
    }

    const passedRoutes = phaseEvaluation.routeResults
      .filter(result => result.category === 'pass_success' || result.category === 'pass_boundary')
      .map(result => result.cover);
    const reachedPhaseRoutes = phaseEvaluation.routeResults
      .filter(result => result.reach)
      .map(result => result.cover);
    const failedRoutes = phaseEvaluation.routeResults
      .filter(result => result.category !== 'pass_success' && result.category !== 'pass_boundary')
      .map(result => result.cover);

    for (const route of passedRoutes) contractPassedRoutes.add(route);
    for (const route of reachedPhaseRoutes) reachedRoutes.add(route);
    if (passed) passCount++;

    const phaseDur = Date.now() - phaseStart;
    const phaseHttpMs = phaseHttpLog.reduce((sum, call) => sum + Number(call.latency || 0), 0);
    const phaseThinkMs = phaseThinkTimes.reduce((sum, ms) => sum + Number(ms || 0), 0);
    totalTokens += phaseTokens;
    totalInputTokens += phaseInputTokens;
    totalOutputTokens += phaseOutputTokens;
    totalDocReads += phaseDocReads;
    totalContractScore += phaseEvaluation.contractScore;
    totalSuccessScore += phaseEvaluation.successScore;
    totalBoundaryScore += phaseEvaluation.boundaryScore;
    const estimatedPhaseCostUsd = estimateModelCostUsd(modelConfig.id, phaseInputTokens, phaseOutputTokens);
    const reason = passed
      ? `Contract ${phaseEvaluation.contractScore}/${task.covers.length}; success ${phaseEvaluation.successScore}, boundary ${phaseEvaluation.boundaryScore}, reach ${phaseEvaluation.reachScore}.`
      : stopReason
        ? `${stopReason}. Contract ${phaseEvaluation.contractScore}/${task.covers.length}; reach ${phaseEvaluation.reachScore}/${task.covers.length}.`
        : `Contract ${phaseEvaluation.contractScore}/${task.covers.length}; success ${phaseEvaluation.successScore}, boundary ${phaseEvaluation.boundaryScore}, reach ${phaseEvaluation.reachScore}.`;

    agentLog(
      `${String(i + 1).padStart(2)}/${tasks.length} ${phaseLabel.padEnd(32)} ${passed ? '✓ PASS' : '✗ FAIL'} `
      + `(contract ${phaseEvaluation.contractScore}/${task.covers.length}, reach ${phaseEvaluation.reachScore}/${task.covers.length}) [${(phaseDur / 1000).toFixed(1)}s] `
      + `${phaseHttpLog.length} calls, ${phaseTokens} tok, est ${formatUsd(estimatedPhaseCostUsd)}  ${reason}`,
    );
    agentLog(`   ${formatTimingBreakdown({ thinkMs: phaseThinkMs, httpMs: phaseHttpMs, toolMs: phaseToolMs, waitMs: phaseRetryWaitMs, wallMs: phaseDur })}`);
    if (!passed) {
      if (phaseEvaluation.failureGroups.cannot_find_endpoint.length > 0) {
        agentLog(`   cannot find: ${phaseEvaluation.failureGroups.cannot_find_endpoint.join(' | ')}`);
      }
      if (phaseEvaluation.failureGroups.found_endpoint_wrong_request.length > 0) {
        agentLog(`   wrong request: ${phaseEvaluation.failureGroups.found_endpoint_wrong_request.join(' | ')}`);
      }
      if (phaseEvaluation.failureGroups.found_endpoint_wrong_response.length > 0) {
        agentLog(`   wrong response: ${phaseEvaluation.failureGroups.found_endpoint_wrong_response.join(' | ')}`);
      }
    }

    let failureInterview = null;
    if (!passed && !SKIP_FAILURE_INTERVIEWS) {
      const whyNudge = `That capability-area task (${phaseLabel}) did not fully succeed. In 1-2 sentences: what information was missing from /llms.txt or the linked skill file, and what would have helped you find or call the remaining documented routes?`;
      const {
        totalTokens: whyTok,
        inputTokens: whyInputTok,
        outputTokens: whyOutputTok,
      } = await runNudge(messages, whyNudge, provider, {
        phaseNum: i + 1,
        totalPhases: tasks.length,
        phaseName: `${phaseLabel}/why`,
        attempt: 0,
        executeLocalTool: undefined,
      });
      totalTokens += whyTok;
      totalInputTokens += whyInputTok;
      totalOutputTokens += whyOutputTok;
      phaseTokens += whyTok;
      phaseInputTokens += whyInputTok;
      phaseOutputTokens += whyOutputTok;
      for (let j = messages.length - 1; j >= 0; j--) {
        const m = messages[j];
        if (m.role === 'assistant') {
          failureInterview = typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
              : null;
          break;
        }
      }
    }

    phaseDocTraces = stitchDocTraces(phaseDocTraces, phaseRequestTimeline);

    results.push({
      suite: task.suite,
      phase: task.phase,
      passed,
      reason,
      contractScore: phaseEvaluation.contractScore,
      successScore: phaseEvaluation.successScore,
      boundaryScore: phaseEvaluation.boundaryScore,
      reachScore: phaseEvaluation.reachScore,
      routeResults: phaseEvaluation.routeResults,
      failureGroups: phaseEvaluation.failureGroups,
      duration_ms: phaseDur,
      http_calls: phaseHttpLog.length,
      input_tokens: phaseInputTokens,
      output_tokens: phaseOutputTokens,
      estimated_cost_usd: estimatedPhaseCostUsd,
      failureInterview,
      responseSizes: phaseResponseSizes,
      thinkTimes: phaseThinkTimes,
      docTraces: phaseDocTraces,
      turnTraces: phaseTurnTraces,
      requestTimeline: phaseRequestTimeline,
      stopReason,
    });

    appendResult({
      ts: new Date().toISOString(),
      model: modelConfig.id,
      provider: modelConfig.provider,
      display: modelConfig.display,
      mode: 'agent-coverage-phase',
      suite: task.suite,
      phase: task.phase,
      passed,
      reason,
      contract_score: phaseEvaluation.contractScore,
      success_score: phaseEvaluation.successScore,
      boundary_score: phaseEvaluation.boundaryScore,
      reach_score: phaseEvaluation.reachScore,
      matched_routes: reachedPhaseRoutes,
      missing_routes: failedRoutes,
      covered_count: phaseEvaluation.contractScore,
      expected_count: task.covers.length,
      duration_ms: phaseDur,
      http_calls: phaseHttpLog.length,
      token_usage: phaseTokens,
      input_tokens: phaseInputTokens,
      output_tokens: phaseOutputTokens,
      estimated_cost_usd: estimatedPhaseCostUsd,
      doc_consultations: phaseDocReads,
      route_results: phaseEvaluation.routeResults,
      cannot_find_routes: phaseEvaluation.failureGroups.cannot_find_endpoint,
      wrong_request_routes: phaseEvaluation.failureGroups.found_endpoint_wrong_request,
      wrong_response_routes: phaseEvaluation.failureGroups.found_endpoint_wrong_response,
      failure_interview: failureInterview,
      doc_traces: phaseDocTraces,
      turn_traces: phaseTurnTraces,
      request_timeline: phaseRequestTimeline,
      stop_reason: stopReason,
    });

    await resetTestRateLimits();

    if (SHARED_AGENT_COVERAGE_SESSION) {
      messages = createAgentCoverageMessages();
      const carryForward = buildSharedSessionCarryForward(allHttpCalls);
      if (carryForward) {
        messages.push({ role: 'user', content: carryForward });
      }
    }

    if (FAIL_FAST && !passed) {
      agentLog(`   fail-fast: stopping broad run after first failed phase (${task.suite}:${task.phase})`);
      break;
    }

    if (DELAY_SECS > 0 && i < tasks.length - 1) {
      await sleep(DELAY_SECS);
    }
  }

  const totalDur = Date.now() - startTime;
  const expectedRoutes = [...new Set(tasks.flatMap(task => task.covers))];
  const estimatedTotalCostUsd = estimateModelCostUsd(modelConfig.id, totalInputTokens, totalOutputTokens);

  agentLog(`\n${'═'.repeat(70)}`);
  agentLog(
    `AGENT COVERAGE: contract ${totalContractScore}/${expectedRoutes.length}, `
    + `success ${totalSuccessScore}/${expectedRoutes.length}, `
    + `boundary ${totalBoundaryScore}/${expectedRoutes.length}, `
    + `reach ${reachedRoutes.size}/${expectedRoutes.length}, `
    + `${passCount}/${tasks.length} phases complete [${(totalDur / 1000).toFixed(1)}s] `
    + `${totalTokens} total-tok, est ${formatUsd(estimatedTotalCostUsd)}, ${totalDocReads} doc reads`,
  );
  agentLog(`${'═'.repeat(70)}`);
  for (const r of results) {
    agentLog(
      `  ${r.passed ? '✓' : '✗'} ${`${r.suite}:${r.phase}`.padEnd(32)} `
      + `contract ${r.contractScore}/${r.routeResults.length}, reach ${r.reachScore}/${r.routeResults.length}`,
    );
  }

  return {
    messages,
    results,
    allHttpCalls,
    contractPassedRoutes: [...contractPassedRoutes],
    reachedRoutes: [...reachedRoutes],
    expectedRoutes,
    passCount,
    totalPhases: tasks.length,
    duration_ms: totalDur,
    totalTokens,
    totalInputTokens,
    totalOutputTokens,
    totalDocReads,
    contractScore: totalContractScore,
    successScore: totalSuccessScore,
    boundaryScore: totalBoundaryScore,
    reachScore: reachedRoutes.size,
    estimatedCostUsd: estimatedTotalCostUsd,
  };
}

// ─── Run Coverage Suites ───

async function runCoverageSuites() {
  if (SHOULD_VERIFY_COVERAGE) {
    const manifest = verifyCoverage();
    testLog(`coverage manifest: ${manifest.owners.size}/${manifest.expectedRoutes.length} routes claimed`);
  }

  const suites = filterSuitesByPhase(resolveSuites(COVERAGE_SUITE), parsePhaseFilters(ONLY_PHASE));
  const results = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const suite of suites) {
    agentLog(`\n${'═'.repeat(60)}`);
    agentLog(`  COVERAGE SUITE: ${suite.name}`);
    agentLog(`${'═'.repeat(60)}`);

    const ctx = createCoverageContext({
      baseUrl: BASE_URL,
      log: agentLog,
      openPeerPubkey: OPEN_PEER_PUBKEY,
      openAmountSats: OPEN_AMOUNT_SATS,
    });

    const suiteResults = [];

    for (const phase of suite.phases) {
      const phaseLog = [];
      ctx.setPhaseLog(phaseLog);
      await ctx.resetRateLimits();

      const started = Date.now();
      let status = 'passed';
      let reason = '';

      try {
        for (const setup of (phase.setup || [])) {
          await ctx.ensureSetup(setup);
        }
        const result = await phase.run(ctx);
        reason = typeof result === 'string' ? result : (result?.reason || 'ok');
        passed++;
      } catch (error) {
        if (error instanceof SkipPhaseError) {
          status = 'skipped';
          reason = error.message;
          skipped++;
        } else {
          status = 'failed';
          reason = error.message;
          failed++;
        }
      } finally {
        ctx.setPhaseLog(null);
      }

      const durationMs = Date.now() - started;
      const marker = status === 'passed' ? '✓ PASS' : status === 'skipped' ? '↷ SKIP' : '✗ FAIL';
      agentLog(
        `${suite.name.padEnd(12)} ${phase.name.padEnd(24)} ${marker} [${(durationMs / 1000).toFixed(1)}s] ${phaseLog.length} calls  ${reason}`,
      );

      const summaryCalls = phaseLog.map(call => `${call.method} ${call.path} -> ${call.status}`);
      appendResult({
        ts: new Date().toISOString(),
        mode: 'coverage',
        suite: suite.name,
        phase: phase.name,
        status,
        passed: status === 'passed',
        skipped: status === 'skipped',
        reason,
        covers: phase.covers,
        duration_ms: durationMs,
        http_calls: phaseLog.length,
        urls_tried: summaryCalls,
      });

      suiteResults.push({
        phase: phase.name,
        status,
        reason,
        duration_ms: durationMs,
        http_calls: phaseLog.length,
      });
    }

    results.push({ suite: suite.name, phases: suiteResults });
  }

  agentLog(`\n${'═'.repeat(60)}`);
  agentLog(`  COVERAGE SUMMARY: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  agentLog(`${'═'.repeat(60)}`);

  return { results, passed, failed, skipped };
}

// ─── Run Feedback Collection ───

async function runFeedback(messages, provider, allHttpCalls) {
  const startTime = Date.now();
  const transcript = [];
  let verificationCalls = 0;

  agentLog(`\n${'═'.repeat(50)}`);
  agentLog('  FEEDBACK COLLECTION (6 turns)');
  agentLog(`${'═'.repeat(50)}`);

  for (let i = 0; i < FEEDBACK_PROMPTS.length; i++) {
    let prompt = FEEDBACK_PROMPTS[i];

    // Turn 3: dynamically inject the agent's request log
    if (i === 2) {
      const errors = allHttpCalls.filter(r => r.status >= 400).length;
      const logLines = allHttpCalls.map(r =>
        `${r.status >= 400 ? 'ERR' : 'OK '} ${r.method} ${r.url} → ${r.status}`
      ).join('\n');
      prompt = `Here's your actual request history from this session (${allHttpCalls.length} requests, ${errors} errors):\n\n${logLines}\n\nFor each moment you hit a wall: What were you trying to do? What went wrong? What would have prevented the problem? Were any error messages actually helpful?`;
    }

    agentLog(`\n  [feedback turn ${i + 1}/6]`);
    transcript.push({ role: 'interviewer', content: prompt });

    const { httpLog } = await runNudge(messages, prompt, provider);
    verificationCalls += httpLog.length;

    // Extract the agent's last text response
    let agentText = '';
    for (let j = messages.length - 1; j >= 0; j--) {
      const m = messages[j];
      if (m.role === 'assistant') {
        if (typeof m.content === 'string') { agentText = m.content; break; }
        if (Array.isArray(m.content)) {
          agentText = m.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
          break;
        }
      }
    }
    transcript.push({ role: 'agent', content: agentText });

    for (const line of agentText.split('\n').slice(0, 5)) {
      testLog(`  feedback> ${line}`);
    }
  }

  // Extract structured feedback from last agent turn
  const lastAgentText = transcript[transcript.length - 1]?.content || '';
  const extracted = extractFeedback(lastAgentText);

  testLog(`\n  Feedback scores: ${JSON.stringify(extracted.scores)}`);
  testLog(`  Issues: ${extracted.top_issues.join(' | ')}`);
  testLog(`  Killer idea: ${extracted.killer_idea}`);

  return { transcript, extracted, verificationCalls, duration_ms: Date.now() - startTime };
}

// ─── Report Generation ───

function generateReport() {
  const all = readResults();
  if (all.length === 0) {
    console.log('No results found in ' + RESULTS_FILE);
    console.log('Run tests first: node test-runner.mjs --all');
    return;
  }

  const navResults = all.filter(r => r.mode === 'navigation');
  const fbResults = all.filter(r => r.mode === 'feedback');
  const lines = [];

  lines.push('# Agent Stress Test Report');
  lines.push(`\nGenerated: ${new Date().toISOString()}`);
  lines.push(`Runs: ${navResults.length} navigation, ${fbResults.length} feedback\n`);

  // Section 1: Navigation Score Matrix
  if (navResults.length > 0) {
    lines.push('## Navigation Scores\n');
    lines.push('| Model | Score | Duration |');
    lines.push('|-------|-------|----------|');
    for (const r of navResults) {
      const dur = r.duration_ms ? `${(r.duration_ms / 1000).toFixed(0)}s` : '-';
      lines.push(`| ${r.display || r.model} | **${r.score}** | ${dur} |`);
    }
    lines.push('');
  }

  // Section 2: Phase Failure Heatmap
  if (navResults.length > 0) {
    const phaseNames = WALKTHROUGH_PHASES.map(p => p.name);
    const failures = {};
    for (const p of phaseNames) {
      const failed = navResults.filter(r => r.phases && !r.phases[p]);
      if (failed.length > 0) {
        failures[p] = failed.map(r => r.display || r.model);
      }
    }
    if (Object.keys(failures).length > 0) {
      const sorted = Object.entries(failures).sort((a, b) => b[1].length - a[1].length);
      lines.push('## Phase Failure Heatmap\n');
      lines.push('| Phase | Fails | Models |');
      lines.push('|-------|-------|--------|');
      for (const [phase, models] of sorted) {
        lines.push(`| ${phase} | ${models.length}/${navResults.length} | ${models.join(', ')} |`);
      }
      lines.push('');
    }
  }

  // Section 3: Feedback Scores
  if (fbResults.length > 0) {
    lines.push('## Feedback Scores\n');
    lines.push('| Model | Discovery | Docs | API | Friction | Fun | Learning |');
    lines.push('|-------|-----------|------|-----|----------|-----|----------|');
    for (const r of fbResults) {
      const s = r.scores || {};
      lines.push(`| ${r.display || r.model} | ${s.discovery ?? '-'} | ${s.docs ?? '-'} | ${s.api ?? '-'} | ${s.friction ?? '-'} | ${s.fun ?? '-'} | ${s.learning ?? '-'} |`);
    }

    // Averages
    const keys = ['discovery', 'docs', 'api', 'friction', 'fun', 'learning'];
    const avgs = keys.map(k => {
      const vals = fbResults.map(r => r.scores?.[k]).filter(v => v != null);
      return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : '-';
    });
    lines.push(`| **Average** | ${avgs.join(' | ')} |`);
    lines.push('');
  }

  // Section 4: Top Issues
  if (fbResults.length > 0 && fbResults.some(r => r.top_issues?.length)) {
    lines.push('## Top Issues (by frequency)\n');
    const allIssues = {};
    for (const r of fbResults) {
      for (const issue of (r.top_issues || [])) {
        const key = issue.toLowerCase().substring(0, 80);
        if (!allIssues[key]) allIssues[key] = { text: issue, models: [] };
        allIssues[key].models.push(r.display || r.model);
      }
    }
    const sorted = Object.values(allIssues).sort((a, b) => b.models.length - a.models.length);
    for (const { text, models } of sorted) {
      lines.push(`- **${models.length}/${fbResults.length}**: ${text} _(${models.join(', ')})_`);
    }
    lines.push('');
  }

  // Section 5: Top Strengths
  if (fbResults.length > 0 && fbResults.some(r => r.top_strengths?.length)) {
    lines.push('## Top Strengths\n');
    const allStrengths = {};
    for (const r of fbResults) {
      for (const s of (r.top_strengths || [])) {
        const key = s.toLowerCase().substring(0, 80);
        if (!allStrengths[key]) allStrengths[key] = { text: s, models: [] };
        allStrengths[key].models.push(r.display || r.model);
      }
    }
    const sorted = Object.values(allStrengths).sort((a, b) => b.models.length - a.models.length);
    for (const { text, models } of sorted) {
      lines.push(`- **${models.length}/${fbResults.length}**: ${text} _(${models.join(', ')})_`);
    }
    lines.push('');
  }

  // Section 6: Missing Features + Doc Fixes + Killer Ideas
  if (fbResults.length > 0) {
    lines.push('## Missing Features\n');
    for (const r of fbResults) {
      if (r.missing_feature) lines.push(`- **${r.display || r.model}**: ${r.missing_feature}`);
    }
    lines.push('');

    lines.push('## Documentation Fixes\n');
    for (const r of fbResults) {
      if (r.doc_fix) lines.push(`- **${r.display || r.model}**: ${r.doc_fix}`);
    }
    lines.push('');

    lines.push('## Killer Ideas\n');
    for (const r of fbResults) {
      if (r.killer_idea) lines.push(`- **${r.display || r.model}**: ${r.killer_idea}`);
    }
    lines.push('');
  }

  const report = lines.join('\n');
  if (REPORT_FILE) {
    writeFileSync(REPORT_FILE, report);
    console.log(`Report saved to ${REPORT_FILE}`);
  } else {
    console.log(report);
  }
}

// ─── Resolve Models ───

function resolveModels() {
  if (ALL_MODELS) {
    const available = MODEL_ROSTER.filter(m => {
      if (m.provider === 'openai') return !!process.env.OPENAI_API_KEY;
      if (m.provider === 'anthropic') return !!process.env.ANTHROPIC_API_KEY;
      if (m.provider === 'openrouter') return !!process.env.OPENROUTER_API_KEY;
      return false;
    });
    const skipped = MODEL_ROSTER.length - available.length;
    if (skipped > 0) console.error(`Skipping ${skipped} models (missing API keys)`);
    if (available.length === 0) {
      console.error('No API keys found. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or OPENROUTER_API_KEY.');
      process.exit(1);
    }
    return available;
  }

  if (MODELS_STR) {
    return MODELS_STR.split(',').map(n => {
      const name = n.trim();
      const found = MODEL_ROSTER.find(m =>
        m.id === name ||
        m.display.toLowerCase() === name.toLowerCase() ||
        m.id.includes(name) ||
        m.display.toLowerCase().includes(name.toLowerCase())
      );
      if (!found) {
        console.error(`Unknown model: "${name}"\nAvailable: ${MODEL_ROSTER.map(m => `${m.display} (${m.id})`).join(', ')}`);
        process.exit(1);
      }
      return found;
    });
  }

  // Legacy single-model mode
  return [{ id: MODEL, provider: PROVIDER, display: `${PROVIDER}/${MODEL}`, tier: 'both' }];
}

function checkApiKey(m) {
  if (m.provider === 'openai' && !process.env.OPENAI_API_KEY) {
    console.error(`Set OPENAI_API_KEY for ${m.display}`); process.exit(1);
  }
  if (m.provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    console.error(`Set ANTHROPIC_API_KEY for ${m.display}`); process.exit(1);
  }
  if (m.provider === 'openrouter' && !process.env.OPENROUTER_API_KEY) {
    console.error(`Set OPENROUTER_API_KEY for ${m.display}`); process.exit(1);
  }
}

// ─── Main ───

async function main() {
  // Report mode: no tests, just read JSONL and output
  if (REPORT_ONLY) {
    generateReport();
    return;
  }

  const validModes = new Set(['navigation', 'walkthrough', 'agent-coverage', 'coverage', 'both']);
  if (!validModes.has(MODE)) {
    console.error(`Unknown mode "${MODE}". Use navigation, walkthrough, agent-coverage, coverage, or both.`);
    process.exit(1);
  }
  const validAgentRuntimes = new Set(['http', 'terminal']);
  if (!validAgentRuntimes.has(AGENT_RUNTIME)) {
    console.error(`Unknown agent runtime "${AGENT_RUNTIME}". Use http or terminal.`);
    process.exit(1);
  }
  if (!Number.isFinite(OPEN_AMOUNT_SATS) || OPEN_AMOUNT_SATS <= 0) {
    console.error(`Invalid --open-amount-sats value "${OPEN_AMOUNT_SATS}". Use a positive integer.`);
    process.exit(1);
  }

  const wantsWalkthrough = MODE === 'navigation' || MODE === 'walkthrough' || MODE === 'both';
  const wantsAgentCoverage = MODE === 'agent-coverage';
  const wantsCoverage = MODE === 'coverage' || MODE === 'both';

  // Check server is up
  try {
    const preflight = await fetch(`${BASE_URL}/api/v1/`);
    if (!preflight.ok) {
      console.error(`Server at ${BASE_URL} is reachable, but GET /api/v1/ returned ${preflight.status}. Point the runner at the API server, not the frontend.`);
      process.exit(1);
    }
  } catch {
    console.error(`Server not reachable at ${BASE_URL}. Start it first.`);
    process.exit(1);
  }

  // Reset rate limits before test run
  await resetTestRateLimits();

  const allScores = [];

  if (wantsWalkthrough || wantsAgentCoverage) {
    const modelsToRun = resolveModels();
    for (const m of modelsToRun) checkApiKey(m);

    for (let mi = 0; mi < modelsToRun.length; mi++) {
      const mc = modelsToRun[mi];
      const wantFeedback = WITH_FEEDBACK && (mc.tier === 'both' || mc.tier === 'feedback');

      const header = `\n${'═'.repeat(60)}\n  MODEL ${mi + 1}/${modelsToRun.length}: ${mc.display} (${mc.id})\n${'═'.repeat(60)}`;
      agentLog(header);
      testLog(header);

      // Reset rate limits between models
      if (mi > 0) {
        await resetTestRateLimits();
      }

      let provider;
      try {
        provider = await createProvider(mc, { requestTimeoutMs: PROVIDER_TIMEOUT_MS });
      } catch (err) {
        testLog(`  SKIP: Failed to create provider — ${err.message}`);
        continue;
      }

      if (wantsWalkthrough) {
        const nav = await runNavigation(provider, mc);
        const phases = {};
        for (const r of nav.results) phases[r.phase] = r.passed;

        appendResult({
          ts: new Date().toISOString(),
          model: mc.id,
          provider: mc.provider,
          display: mc.display,
          mode: 'navigation',
          score: `${nav.passCount}/${nav.totalPhases}`,
          phases,
          failure_details: nav.results.filter(r => !r.passed).map(r => ({ phase: r.phase })),
          duration_ms: nav.duration_ms,
          total_http_calls: nav.allHttpCalls.length,
          total_tokens: nav.totalTokens,
          total_doc_reads: nav.totalDocReads,
        });

        allScores.push({ display: mc.display, score: `${nav.passCount}/${nav.totalPhases}` });

        if (wantFeedback) {
          const fb = await runFeedback(nav.messages, provider, nav.allHttpCalls);
          appendResult({
            ts: new Date().toISOString(),
            model: mc.id,
            provider: mc.provider,
            display: mc.display,
            mode: 'feedback',
            scores: fb.extracted.scores,
            top_issues: fb.extracted.top_issues,
            top_strengths: fb.extracted.top_strengths,
            missing_feature: fb.extracted.missing_feature,
            doc_fix: fb.extracted.doc_fix,
            killer_idea: fb.extracted.killer_idea,
            verification_calls: fb.verificationCalls,
            duration_ms: fb.duration_ms,
            transcript: fb.transcript,
          });
        }
      }

      if (wantsAgentCoverage) {
        const agentCoverageProvider = await createProvider(mc, {
          tools: AGENT_RUNTIME === 'terminal' ? [HTTP_TOOL, TERMINAL_TOOL] : [HTTP_TOOL],
          requestTimeoutMs: PROVIDER_TIMEOUT_MS,
        });
        const agentCoverage = await runAgentCoverage(agentCoverageProvider, mc);
        const phases = {};
        for (const r of agentCoverage.results) phases[`${r.suite}:${r.phase}`] = r.passed;

        appendResult({
          ts: new Date().toISOString(),
          model: mc.id,
          provider: mc.provider,
          display: mc.display,
          mode: 'agent-coverage',
          agent_runtime: AGENT_RUNTIME,
          score: `${agentCoverage.contractScore}/${agentCoverage.expectedRoutes.length}`,
          success_score: `${agentCoverage.successScore}/${agentCoverage.expectedRoutes.length}`,
          boundary_score: `${agentCoverage.boundaryScore}/${agentCoverage.expectedRoutes.length}`,
          reach_score: `${agentCoverage.reachScore}/${agentCoverage.expectedRoutes.length}`,
          estimated_cost_usd: agentCoverage.estimatedCostUsd,
          input_tokens: agentCoverage.totalInputTokens,
          output_tokens: agentCoverage.totalOutputTokens,
          phase_score: `${agentCoverage.passCount}/${agentCoverage.totalPhases}`,
          phases,
          failure_details: agentCoverage.results
            .filter(r => !r.passed)
            .map(r => ({
              suite: r.suite,
              phase: r.phase,
              cannot_find_routes: r.failureGroups.cannot_find_endpoint,
              wrong_request_routes: r.failureGroups.found_endpoint_wrong_request,
              wrong_response_routes: r.failureGroups.found_endpoint_wrong_response,
            })),
          duration_ms: agentCoverage.duration_ms,
          total_http_calls: agentCoverage.allHttpCalls.length,
          total_tokens: agentCoverage.totalTokens,
          total_doc_reads: agentCoverage.totalDocReads,
        });

        allScores.push({
          display: mc.display,
          score: `${agentCoverage.contractScore}/${agentCoverage.expectedRoutes.length} contract, ${agentCoverage.reachScore}/${agentCoverage.expectedRoutes.length} reach, ${formatUsd(agentCoverage.estimatedCostUsd)} (${AGENT_RUNTIME})`,
        });
      }
    }
  }

  // Final summary
  if (allScores.length > 0) {
    agentLog(`\n${'═'.repeat(60)}`);
    agentLog('  FINAL SCORES');
    agentLog(`${'═'.repeat(60)}`);
    for (const { display, score } of allScores) {
      agentLog(`  ${display.padEnd(30)} ${score}`);
    }
    if (allScores.length > 1) {
      agentLog(`\nResults saved to ${RESULTS_FILE}`);
      agentLog('Run with --report to generate the full analysis report.');
    }
  }

  if (wantsCoverage) {
    const coverage = await runCoverageSuites();
    appendResult({
      ts: new Date().toISOString(),
      mode: 'coverage-summary',
      suite: COVERAGE_SUITE,
      passed: coverage.passed,
      failed: coverage.failed,
      skipped: coverage.skipped,
    });
    if (coverage.failed > 0) {
      process.exitCode = 1;
    }
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
