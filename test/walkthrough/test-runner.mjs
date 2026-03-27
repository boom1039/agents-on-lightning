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
 *   node test-runner.mjs --mode coverage --suite market --manual-funding --open-peer-pubkey <pubkey>
 *   node test-runner.mjs --mode both --feedback
 *
 *   # Generate report from saved results
 *   node test-runner.mjs --report
 *   node test-runner.mjs --report --report-file /tmp/report.md
 */

import { writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flag as _flag, opt as _opt, sleep, formatTime, formatBytes, doHttp as _doHttp, createProvider } from './shared.mjs';
import {
  DEFAULT_FUNDING_TIMEOUT_SECS,
  DEFAULT_OPEN_AMOUNT_SATS,
  SkipPhaseError,
  createCoverageContext,
} from './coverage-helpers.mjs';
import { resolveSuites } from './suites/index.mjs';
import { verifyCoverage } from './verify-suite-coverage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_FILE = join(__dirname, 'stress-test-results.jsonl');

// ─── CLI ───

const args = process.argv.slice(2);
function flag(name) { return _flag(name, args); }
function opt(name, def) { return _opt(name, def, args); }

const REPORT_ONLY = flag('--report');
const ALL_MODELS = flag('--all');
const MODELS_STR = opt('--models', null);
const MODE = opt('--mode', 'walkthrough');   // navigation | walkthrough | agent-coverage | coverage | both
const WITH_FEEDBACK = flag('--feedback');
const COVERAGE_SUITE = opt('--suite', 'all');
const SKIP_COVERAGE_VERIFY = flag('--skip-coverage-verify');
const FAIL_FAST = flag('--fail-fast');
const SHOW_DOC_TRACES = flag('--show-doc-traces');
const MANUAL_FUNDING = flag('--manual-funding');
const OPEN_PEER_PUBKEY = opt('--open-peer-pubkey', null);
const OPEN_AMOUNT_SATS = parseInt(opt('--open-amount-sats', String(DEFAULT_OPEN_AMOUNT_SATS)), 10);
const FUNDING_TIMEOUT_SECS = parseInt(opt('--funding-timeout-secs', String(DEFAULT_FUNDING_TIMEOUT_SECS)), 10);
const CHANNEL_POINT = opt('--channel-point', null);
const ONLY_PHASE = opt('--phase', null);
const START_PHASE = parseInt(opt('--start-phase', '0'), 10);
const MAX_RETRIES = parseInt(opt('--retries', '2'), 10);
const MAX_TURNS = parseInt(opt('--max-turns', '1'), 10);
const NUDGE_TIMEOUT_MS = parseInt(opt('--nudge-timeout', '60000'), 10);
const DELAY_SECS = parseInt(opt('--delay', '0'), 10);
const BAIL_AFTER = parseInt(opt('--bail', '2'), 10);  // stop after N consecutive failures
const MODEL_RETRY_MAX = parseInt(opt('--model-retry-max', '6'), 10);
const MODEL_RETRY_BASE_MS = parseInt(opt('--model-retry-base-ms', '5000'), 10);
const MODEL_RETRY_MAX_MS = parseInt(opt('--model-retry-max-ms', '60000'), 10);
const BASE_URL = opt('--base-url', 'http://localhost:3200');
const REPORT_FILE = opt('--report-file', null);
const TAG = opt('--tag', null);

// Legacy single-model flags
const PROVIDER = opt('--provider', 'openai');
const MODEL = opt('--model',
  PROVIDER === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'gpt-4.1-mini');
const EFFECTIVE_MAX_RETRIES = FAIL_FAST ? 1 : MAX_RETRIES;
const EFFECTIVE_BAIL_AFTER = FAIL_FAST ? 1 : BAIL_AFTER;
const SKIP_FAILURE_INTERVIEWS = FAIL_FAST;

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

// ─── Logging ───

const _pre = TAG ? `[${TAG}] ` : '';
function agentLog(msg) { process.stdout.write(`${_pre}${msg}\n`); }
function testLog(msg) { process.stdout.write(`${_pre}  ★ ${msg}\n`); }

function doHttp(input) { return _doHttp(input, BASE_URL); }
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shortUrl(url = '') {
  return String(url).replace(BASE_URL, '') || url;
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

// ─── Send a nudge and let the agent work ───

async function runNudge(messages, nudge, provider, ctx = {}) {
  const { phaseNum, totalPhases, phaseName, attempt } = ctx;
  const nudgeStart = Date.now();
  const pre = phaseName ? `${String(phaseNum).padStart(2)}/${totalPhases} ${phaseName.padEnd(20)}` : '';
  const att = attempt ? ` ${attempt}/${EFFECTIVE_MAX_RETRIES}` : '';

  messages.push({ role: 'user', content: nudge });
  const httpLog = [];
  let totalTokens = 0;
  let docReads = 0;
  const thinkTimes = [];
  const responseSizes = [];
  const docTraces = [];
  const turnTraces = [];
  const pendingDocTraces = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (Date.now() - nudgeStart > NUDGE_TIMEOUT_MS) {
      agentLog(`${pre}${att}  TIMEOUT ${formatTime(NUDGE_TIMEOUT_MS)}`);
      break;
    }

    const thinkStart = Date.now();
    let response;
    for (let modelAttempt = 1; modelAttempt <= MODEL_RETRY_MAX; modelAttempt++) {
      try {
        response = await provider.call(messages);
        break;
      } catch (err) {
        const retryDelayMs = parseRetryDelayMs(err, modelAttempt);
        if (!retryDelayMs || modelAttempt >= MODEL_RETRY_MAX) {
          agentLog(`${pre}${att}  ERROR ${String(err.message || err).substring(0, 100)}`);
          break;
        }
        agentLog(`${pre}${att}  RATE LIMIT wait ${formatTime(retryDelayMs)} then retry ${modelAttempt}/${MODEL_RETRY_MAX}`);
        await sleepMs(retryDelayMs);
      }
    }
    if (!response) break;
    const thinkMs = Date.now() - thinkStart;
    thinkTimes.push(thinkMs);

    totalTokens += (response.usage?.input || 0) + (response.usage?.output || 0);

    if (response.text.trim()) {
      const first = response.text.trim().split('\n')[0].substring(0, 120);
      agentLog(`${pre}${att}  think:${(thinkMs / 1000).toFixed(1)}s  agent: ${first}`);
    }

    turnTraces.push({
      turn: turn + 1,
      think_ms: thinkMs,
      assistant_text: response.text || '',
      requested_calls: response.toolCalls.map(tc => summarizeRequest(tc.input)),
    });

    if (response.toolCalls.length === 0) break;

    const results = [];
    for (const tc of response.toolCalls) {
      if (pendingDocTraces.length > 0) {
        const previousDoc = pendingDocTraces.shift();
        previousDoc.next_request = summarizeRequest(tc.input);
        docTraces.push(previousDoc);
        if (SHOW_DOC_TRACES) {
          agentLog(`${pre}${att}  DOC→NEXT ${previousDoc.doc_url} => ${previousDoc.next_request.method} ${previousDoc.next_request.url}`);
        }
      }

      const httpResult = await doHttp(tc.input);
      const currentShortUrl = shortUrl(tc.input.url || '');
      const bodyStr = tc.input.body ? ` body:${JSON.stringify(tc.input.body).substring(0, 80)}` : '';
      const errStr = httpResult.errSnippet ? ` err:"${String(httpResult.errSnippet).substring(0, 60)}"` : '';
      const sizeStr = `, ${formatBytes(httpResult.responseBytes)}`;

      if (isDocRoute(tc.input)) {
        docReads++;
        pendingDocTraces.push({
          turn: turn + 1,
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
      });
      results.push({ id: tc.id, content: httpResult.raw });
    }

    provider.push(messages, response.raw, results);
  }

  for (const unresolvedDoc of pendingDocTraces) {
    docTraces.push(unresolvedDoc);
    if (SHOW_DOC_TRACES) {
      agentLog(`${pre}${att}  DOC→NEXT ${unresolvedDoc.doc_url} => [none]`);
    }
  }

  return { httpLog, totalTokens, docReads, thinkTimes, responseSizes, docTraces, turnTraces };
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

const AGENT_COVERAGE_PRIMER = `The server base URL is ${BASE_URL}. Start from ${BASE_URL}/llms.txt.
For this session, you may only learn routes, methods, headers, bodies, and workflow details from /llms.txt and the files it links to.
If you need documentation, reread those files instead of guessing.
You only have HTTP access. If a flow requires cryptographic signing, external payment, on-chain funding, or a second agent account, do the furthest honest documented HTTP attempt you can with the tools you have.
When docs mention aliases, deprecated endpoints, or common mistake / teaching surfaces, exercise those too.`;

const AGENT_COVERAGE_GOALS = {
  discovery: {
    'root-and-docs': 'Start from scratch and find the main docs, entrypoints, health signal, and API index.',
    'platform-ethos-capabilities': 'Understand the live platform status, invoice decoding helper, platform ethos, and access tiers.',
    'strategies-and-knowledge': 'Explore strategy archetypes and read a relevant knowledge-base topic.',
    skills: 'List the available skills and read the relevant skill file for this capability area.',
  },
  identity: {
    'registration-and-profile': 'Register an agent, inspect your own profile and referral info, then inspect your public profile and lineage.',
    'node-connection': 'Understand how an agent would connect its own node: test the connection flow, the real connect flow, and the current node-connection status.',
    actions: 'Submit a sample action, inspect your action history, and fetch the specific action you created.',
  },
  wallet: {
    'wallet-teaching-and-ledger': 'Explore the wallet teaching surfaces, legacy or deprecated wallet paths, and the public ledger.',
    'mint-balance-history': 'Exercise the wallet deposit or mint flow as far as possible, then inspect wallet balance, transaction history, restore, and pending-send recovery.',
    'melt-send-receive': 'Exercise withdraw, send, and receive ecash flows as far as the docs allow.',
  },
  analysis: {
    'network-health': 'Inspect overall live network health from the platform node.',
    'node-profile-aliases': 'Profile a real Lightning node using the documented equivalent profile paths.',
    'suggest-peers': 'Find suggested peers for a real node.',
  },
  social: {
    messaging: 'Use public discovery to find another agent, send them a message, and inspect your inbox surfaces.',
    alliances: 'Create an alliance proposal, inspect alliance listings, and complete the acceptance and breakup lifecycle even if that means using more than one agent account.',
    'leaderboard-and-tournaments': 'Explore public reputation and tournament surfaces, including one specific agent and one intentionally missing tournament.',
  },
  channels: {
    'audit-and-monitoring': 'Explore the public accountability surfaces: audit log, per-channel audit, verify, per-channel verify, violations, and status.',
    'signed-channel-lifecycle': 'Exercise the post-assignment channel-management lifecycle as far as possible from docs alone: list your channels, inspect instruction history, and attempt signed preview or execute flows if you can.',
  },
  market: {
    'public-market-read': 'Explore the public market read surfaces, including market stats, rankings, channel listings, agent market profile, peer safety, and fee competition.',
    'teaching-surfaces': 'Deliberately verify any documented common method mistakes or teaching surfaces for market write actions.',
    'open-flow': 'Exercise the channel-open flow as far as possible from docs alone, including preview, open, and pending-open status.',
    'close-revenue-performance': 'Exercise the close flow plus revenue and performance tracking.',
    'swap-ecash-and-rebalance': 'Exercise swap, ecash channel-funding, rebalance estimation, rebalance submission, and rebalance history.',
  },
  analytics: {
    'catalog-and-quote': 'Explore the analytics catalog and get a price quote for one analytics query.',
    'execute-and-history': 'Attempt to run one analytics query and inspect analytics history.',
  },
  capital: {
    'balance-and-activity': 'Inspect on-chain capital balances and capital activity history.',
    'deposit-and-status': 'Generate an on-chain deposit address and inspect deposit-status tracking.',
    'withdraw-and-help': 'Attempt an on-chain withdrawal and use the help concierge if you need platform guidance.',
  },
};

function buildAgentCoverageTasks() {
  return resolveSuites(COVERAGE_SUITE).flatMap((suite) => suite.phases.map((phase) => {
    const goal = AGENT_COVERAGE_GOALS[suite.name]?.[phase.name];
    if (!goal) {
      throw new Error(`Missing agent coverage goal for ${suite.name}:${phase.name}`);
    }
    return {
      suite: suite.name,
      phase: phase.name,
      covers: phase.covers,
      skill: suite.name,
      goal,
    };
  }));
}

function normalizeRoutePath(url) {
  try {
    const parsed = new URL(url, BASE_URL);
    return `${parsed.pathname}${parsed.search || ''}`;
  } catch {
    return url.replace(BASE_URL, '');
  }
}

const COVER_ROUTE_MATCHERS = new Map();
function getCoverMatcher(cover) {
  let matcher = COVER_ROUTE_MATCHERS.get(cover);
  if (matcher) return matcher;

  const space = cover.indexOf(' ');
  const method = cover.slice(0, space).trim().toUpperCase();
  const rawPath = cover.slice(space + 1).trim().split('?')[0];
  const escaped = rawPath
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:[^/]+/g, '[^/?#]+');
  matcher = { method, regex: new RegExp(`^${escaped}(?:\\?.*)?$`) };
  COVER_ROUTE_MATCHERS.set(cover, matcher);
  return matcher;
}

function matchCoveredRoutes(httpLog, covers) {
  const matched = [];
  const missing = [];

  for (const cover of covers) {
    const matcher = getCoverMatcher(cover);
    const hit = httpLog.some((call) => (
      call.method?.toUpperCase() === matcher.method &&
      matcher.regex.test(normalizeRoutePath(call.url || ''))
    ));
    if (hit) matched.push(cover);
    else missing.push(cover);
  }

  return { matched, missing };
}

function buildAgentCoveragePrompt(task) {
  return `Use the server at ${BASE_URL}. Begin from ${BASE_URL}/llms.txt if you need docs.
Use only /llms.txt and the linked ${task.skill} skill file to fully exercise this capability area.
Goal: ${task.goal}

Rules:
- Learn methods, URLs, bodies, and workflow details only from /llms.txt and the files it links to.
- If you need docs, reread them instead of guessing.
- Cover every documented route relevant to this goal, including aliases, deprecated endpoints, public endpoints, authenticated endpoints, and documented teaching surfaces.
- If a flow requires a second agent account, you may create and use one yourself.
- If a flow requires cryptographic signing, external payment, or on-chain funding, make the furthest honest documented HTTP attempt you can and inspect the response.`;
}

function buildAgentCoverageRetryPrompt(task) {
  return `You are still working against ${BASE_URL}.
You have not fully exercised that documented ${task.skill} capability area yet.
Reread /llms.txt and the linked ${task.skill} skill file, then continue the same goal without inventing undocumented routes or request shapes.
Goal: ${task.goal}`;
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
  appendFileSync(RESULTS_FILE, JSON.stringify(data) + '\n');
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
    let errorRecovery = null;  // "helped" | "not_helped" | null

    for (let attempt = 1; attempt <= EFFECTIVE_MAX_RETRIES; attempt++) {
      const nudge = attempt === 1 ? phase.nudge : `Let's try that again. ${phase.nudge}`;
      const { httpLog, totalTokens: tok, docReads, thinkTimes, responseSizes, docTraces, turnTraces } = await runNudge(messages, nudge, provider, {
        phaseNum, totalPhases: WALKTHROUGH_PHASES.length, phaseName: phase.name, attempt,
      });

      phaseHttpLog.push(...httpLog);
      allHttpCalls.push(...httpLog);
      phaseTokens += tok;
      phaseDocReads += docReads;
      phaseThinkTimes.push(...thinkTimes);
      phaseResponseSizes.push(...responseSizes);
      phaseDocTraces.push(...docTraces);
      phaseTurnTraces.push(...turnTraces);

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
    totalTokens += phaseTokens;
    totalDocReads += phaseDocReads;

    const score = `(${passCount}/${i + 1})`;
    agentLog(`${String(phaseNum).padStart(2)}/${WALKTHROUGH_PHASES.length} ${phase.name.padEnd(20)} ${passed ? '✓ PASS' : '✗ FAIL'} ${score} [${(phaseDur / 1000).toFixed(1)}s] ${phaseHttpLog.length} calls, ${phaseTokens} phase-tok  ${reason}`);
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
  if (!SKIP_COVERAGE_VERIFY) {
    const manifest = verifyCoverage();
    testLog(`coverage manifest: ${manifest.owners.size}/${manifest.expectedRoutes.length} routes claimed`);
  }

  const messages = [{ role: 'user', content: AGENT_COVERAGE_PRIMER }];
  const tasks = buildAgentCoverageTasks();
  const results = [];
  const allHttpCalls = [];
  const matchedRoutes = new Set();
  const startTime = Date.now();
  let passCount = 0;
  let totalTokens = 0;
  let totalDocReads = 0;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const phaseLabel = `${task.suite}:${task.phase}`;
    const phaseStart = Date.now();
    let phaseHttpLog = [];
    let phaseTokens = 0;
    let phaseDocReads = 0;
    let phaseThinkTimes = [];
    let phaseResponseSizes = [];
    let phaseDocTraces = [];
    let phaseTurnTraces = [];
    let matched = [];
    let missing = [...task.covers];
    let passed = false;

    for (let attempt = 1; attempt <= EFFECTIVE_MAX_RETRIES; attempt++) {
      const nudge = attempt === 1
        ? buildAgentCoveragePrompt(task)
        : buildAgentCoverageRetryPrompt(task);
      const { httpLog, totalTokens: tok, docReads, thinkTimes, responseSizes, docTraces, turnTraces } = await runNudge(messages, nudge, provider, {
        phaseNum: i + 1,
        totalPhases: tasks.length,
        phaseName: phaseLabel,
        attempt,
      });

      phaseHttpLog.push(...httpLog);
      allHttpCalls.push(...httpLog);
      phaseTokens += tok;
      phaseDocReads += docReads;
      phaseThinkTimes.push(...thinkTimes);
      phaseResponseSizes.push(...responseSizes);
      phaseDocTraces.push(...docTraces);
      phaseTurnTraces.push(...turnTraces);

      ({ matched, missing } = matchCoveredRoutes(phaseHttpLog, task.covers));
      if (missing.length === 0) {
        passed = true;
        break;
      }
    }

    for (const route of matched) matchedRoutes.add(route);
    if (passed) passCount++;

    const phaseDur = Date.now() - phaseStart;
    totalTokens += phaseTokens;
    totalDocReads += phaseDocReads;
    const reason = passed
      ? `Covered all ${matched.length}/${task.covers.length} documented routes for this capability area.`
      : `Covered ${matched.length}/${task.covers.length}; missing ${missing.length}.`;

    agentLog(
      `${String(i + 1).padStart(2)}/${tasks.length} ${phaseLabel.padEnd(32)} ${passed ? '✓ PASS' : '✗ FAIL'} `
      + `(${matched.length}/${task.covers.length} routes) [${(phaseDur / 1000).toFixed(1)}s] `
      + `${phaseHttpLog.length} calls, ${phaseTokens} phase-tok  ${reason}`,
    );
    if (!passed && missing.length > 0) {
      agentLog(`   missing: ${missing.join(' | ')}`);
    }

    let failureInterview = null;
    if (!passed && !SKIP_FAILURE_INTERVIEWS) {
      const whyNudge = `That capability-area task (${phaseLabel}) did not fully succeed. In 1-2 sentences: what information was missing from /llms.txt or the linked skill file, and what would have helped you find or call the remaining documented routes?`;
      const { totalTokens: whyTok } = await runNudge(messages, whyNudge, provider, {
        phaseNum: i + 1,
        totalPhases: tasks.length,
        phaseName: `${phaseLabel}/why`,
        attempt: 0,
      });
      totalTokens += whyTok;
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

    results.push({
      suite: task.suite,
      phase: task.phase,
      passed,
      reason,
      matched,
      missing,
      duration_ms: phaseDur,
      http_calls: phaseHttpLog.length,
      failureInterview,
      responseSizes: phaseResponseSizes,
      thinkTimes: phaseThinkTimes,
      docTraces: phaseDocTraces,
      turnTraces: phaseTurnTraces,
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
      matched_routes: matched,
      missing_routes: missing,
      covered_count: matched.length,
      expected_count: task.covers.length,
      duration_ms: phaseDur,
      http_calls: phaseHttpLog.length,
      token_usage: phaseTokens,
      doc_consultations: phaseDocReads,
      failure_interview: failureInterview,
      doc_traces: phaseDocTraces,
      turn_traces: phaseTurnTraces,
    });

    if (DELAY_SECS > 0 && i < tasks.length - 1) {
      await sleep(DELAY_SECS);
    }
  }

  const totalDur = Date.now() - startTime;
  const expectedRoutes = [...new Set(tasks.flatMap(task => task.covers))];

  agentLog(`\n${'═'.repeat(70)}`);
  agentLog(`AGENT COVERAGE: ${matchedRoutes.size}/${expectedRoutes.length} routes matched, ${passCount}/${tasks.length} phases complete [${(totalDur / 1000).toFixed(1)}s] ${totalTokens} total-tok, ${totalDocReads} doc reads`);
  agentLog(`${'═'.repeat(70)}`);
  for (const r of results) {
    agentLog(`  ${r.passed ? '✓' : '✗'} ${`${r.suite}:${r.phase}`.padEnd(32)} ${r.matched.length}/${r.missing.length + r.matched.length} routes`);
  }

  return {
    messages,
    results,
    allHttpCalls,
    matchedRoutes: [...matchedRoutes],
    expectedRoutes,
    passCount,
    totalPhases: tasks.length,
    duration_ms: totalDur,
    totalTokens,
    totalDocReads,
  };
}

// ─── Run Coverage Suites ───

async function runCoverageSuites() {
  if (!SKIP_COVERAGE_VERIFY) {
    const manifest = verifyCoverage();
    testLog(`coverage manifest: ${manifest.owners.size}/${manifest.expectedRoutes.length} routes claimed`);
  }

  const suites = resolveSuites(COVERAGE_SUITE);
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
      manualFunding: MANUAL_FUNDING && suite.name === 'market',
      openPeerPubkey: OPEN_PEER_PUBKEY,
      openAmountSats: OPEN_AMOUNT_SATS,
      fundingTimeoutSecs: FUNDING_TIMEOUT_SECS,
      channelPoint: CHANNEL_POINT,
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
  if (!Number.isFinite(OPEN_AMOUNT_SATS) || OPEN_AMOUNT_SATS <= 0) {
    console.error(`Invalid --open-amount-sats value "${OPEN_AMOUNT_SATS}". Use a positive integer.`);
    process.exit(1);
  }
  if (!Number.isFinite(FUNDING_TIMEOUT_SECS) || FUNDING_TIMEOUT_SECS <= 0) {
    console.error(`Invalid --funding-timeout-secs value "${FUNDING_TIMEOUT_SECS}". Use a positive integer.`);
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
  try { await fetch(`${BASE_URL}/api/v1/test/reset-rate-limits`, { method: 'POST' }); } catch {}

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
        try { await fetch(`${BASE_URL}/api/v1/test/reset-rate-limits`, { method: 'POST' }); } catch {}
      }

      let provider;
      try {
        provider = await createProvider(mc);
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
        const agentCoverage = await runAgentCoverage(provider, mc);
        const phases = {};
        for (const r of agentCoverage.results) phases[`${r.suite}:${r.phase}`] = r.passed;

        appendResult({
          ts: new Date().toISOString(),
          model: mc.id,
          provider: mc.provider,
          display: mc.display,
          mode: 'agent-coverage',
          score: `${agentCoverage.matchedRoutes.length}/${agentCoverage.expectedRoutes.length}`,
          phase_score: `${agentCoverage.passCount}/${agentCoverage.totalPhases}`,
          phases,
          failure_details: agentCoverage.results
            .filter(r => !r.passed)
            .map(r => ({ suite: r.suite, phase: r.phase, missing_routes: r.missing })),
          duration_ms: agentCoverage.duration_ms,
          total_http_calls: agentCoverage.allHttpCalls.length,
          total_tokens: agentCoverage.totalTokens,
          total_doc_reads: agentCoverage.totalDocReads,
        });

        allScores.push({
          display: mc.display,
          score: `${agentCoverage.matchedRoutes.length}/${agentCoverage.expectedRoutes.length} routes`,
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
