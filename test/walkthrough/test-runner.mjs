#!/usr/bin/env node
/**
 * Agent Platform Test Runner — Multi-Model Stress Test + Feedback Collection
 *
 * Runs AI agents through a 21-phase platform navigation test and optionally
 * collects structured feedback about the agent experience. Supports OpenAI,
 * Anthropic, and OpenRouter (200+ models).
 *
 * Usage:
 *   # Single model (backward compatible)
 *   node test-runner.mjs
 *   node test-runner.mjs --provider anthropic --model claude-haiku-4-5-20251001
 *
 *   # Multi-model
 *   node test-runner.mjs --models gpt-4.1-nano,gpt-4.1,claude-haiku
 *   node test-runner.mjs --all
 *
 *   # With feedback collection
 *   node test-runner.mjs --models gpt-4.1,claude-haiku --mode both
 *
 *   # Generate report from saved results
 *   node test-runner.mjs --report
 *   node test-runner.mjs --report --report-file /tmp/report.md
 */

import { writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flag as _flag, opt as _opt, sleep, formatTime, formatBytes, doHttp as _doHttp, createProvider } from './shared.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_FILE = join(__dirname, 'stress-test-results.jsonl');

// ─── CLI ───

const args = process.argv.slice(2);
function flag(name) { return _flag(name, args); }
function opt(name, def) { return _opt(name, def, args); }

const REPORT_ONLY = flag('--report');
const ALL_MODELS = flag('--all');
const MODELS_STR = opt('--models', null);
const MODE = opt('--mode', 'navigation');   // navigation | both
const ONLY_PHASE = opt('--phase', null);
const START_PHASE = parseInt(opt('--start-phase', '0'), 10);
const MAX_RETRIES = parseInt(opt('--retries', '2'), 10);
const MAX_TURNS = parseInt(opt('--max-turns', '1'), 10);
const NUDGE_TIMEOUT_MS = parseInt(opt('--nudge-timeout', '60000'), 10);
const DELAY_SECS = parseInt(opt('--delay', '0'), 10);
const BAIL_AFTER = parseInt(opt('--bail', '2'), 10);  // stop after N consecutive failures
const BASE_URL = opt('--base-url', 'http://localhost:3200');
const REPORT_FILE = opt('--report-file', null);
const TAG = opt('--tag', null);

// Legacy single-model flags
const PROVIDER = opt('--provider', 'openai');
const MODEL = opt('--model',
  PROVIDER === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'gpt-4.1-mini');

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

// ─── Send a nudge and let the agent work ───

async function runNudge(messages, nudge, provider, ctx = {}) {
  const { phaseNum, totalPhases, phaseName, attempt } = ctx;
  const nudgeStart = Date.now();
  const pre = phaseName ? `${String(phaseNum).padStart(2)}/${totalPhases} ${phaseName.padEnd(20)}` : '';
  const att = attempt ? ` ${attempt}/${MAX_RETRIES}` : '';

  messages.push({ role: 'user', content: nudge });
  const httpLog = [];
  let totalTokens = 0;
  let docReads = 0;
  const thinkTimes = [];
  const responseSizes = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (Date.now() - nudgeStart > NUDGE_TIMEOUT_MS) {
      agentLog(`${pre}${att}  TIMEOUT ${formatTime(NUDGE_TIMEOUT_MS)}`);
      break;
    }

    const thinkStart = Date.now();
    let response;
    try {
      response = await provider.call(messages);
    } catch (err) {
      agentLog(`${pre}${att}  ERROR ${err.message.substring(0, 100)}`);
      break;
    }
    const thinkMs = Date.now() - thinkStart;
    thinkTimes.push(thinkMs);

    totalTokens += (response.usage?.input || 0) + (response.usage?.output || 0);

    if (response.text.trim()) {
      const first = response.text.trim().split('\n')[0].substring(0, 120);
      agentLog(`${pre}${att}  think:${(thinkMs / 1000).toFixed(1)}s  agent: ${first}`);
    }

    if (response.toolCalls.length === 0) break;

    const results = [];
    for (const tc of response.toolCalls) {
      const httpResult = await doHttp(tc.input);
      const shortUrl = (tc.input.url || '').replace(BASE_URL, '');
      const bodyStr = tc.input.body ? ` body:${JSON.stringify(tc.input.body).substring(0, 80)}` : '';
      const errStr = httpResult.errSnippet ? ` err:"${String(httpResult.errSnippet).substring(0, 60)}"` : '';
      const sizeStr = `, ${formatBytes(httpResult.responseBytes)}`;

      if (shortUrl.includes('/llms.txt') || shortUrl === '/api/v1/' || shortUrl.includes('/llms-full.txt')) {
        docReads++;
      }

      agentLog(`${pre}${att}  ${tc.input.method} ${shortUrl} → ${httpResult.status} (${httpResult.latency}ms${sizeStr})${bodyStr}${errStr}`);

      responseSizes.push({ url: shortUrl, bytes: httpResult.responseBytes });
      httpLog.push({
        method: tc.input.method, url: tc.input.url, status: httpResult.status,
        latency: httpResult.latency, reqBody: httpResult.reqBody, errSnippet: httpResult.errSnippet,
        responseBytes: httpResult.responseBytes, body: httpResult.parsed,
      });
      results.push({ id: tc.id, content: httpResult.raw });
    }

    provider.push(messages, response.raw, results);
  }

  return { httpLog, totalTokens, docReads, thinkTimes, responseSizes };
}

// ─── Test phases ───
// Each phase: { name, nudge, check(httpLog, state) → { pass, reason } }
// State carries agent_id, api_key, etc. between phases.

const PHASES = [
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
    name: 'check-bounties',
    nudge: 'See if there are any advisory bounties available.',
    check: (log) => {
      const ok = log.some(r => r.url.includes('/bounties') && r.status === 200);
      return { pass: ok, reason: ok ? 'Fetched bounties' : 'Did not find bounties' };
    },
  },
  {
    name: 'post-bounty',
    nudge: 'Post an advisory bounty asking for help choosing the best peer to open a channel with.',
    check: (log) => {
      const ok = log.some(r => r.url.includes('/bounties') && r.method === 'POST');
      return { pass: ok, reason: ok ? 'Attempted to post a bounty' : 'Did not attempt to post a bounty' };
    },
  },
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
    ? PHASES.filter(p => p.name === ONLY_PHASE)
    : PHASES.slice(START_PHASE);

  // Always warm up with read-docs
  if (phases[0]?.name !== 'read-docs') {
    agentLog(`warmup: reading docs`);
    const { httpLog } = await runNudge(messages, PHASES[0].nudge, provider,
      { phaseNum: 0, totalPhases: PHASES.length, phaseName: 'warmup', attempt: 0 });
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
    let errorRecovery = null;  // "helped" | "not_helped" | null

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const nudge = attempt === 1 ? phase.nudge : `Let's try that again. ${phase.nudge}`;
      const { httpLog, totalTokens: tok, docReads, thinkTimes, responseSizes } = await runNudge(messages, nudge, provider, {
        phaseNum, totalPhases: PHASES.length, phaseName: phase.name, attempt,
      });

      phaseHttpLog.push(...httpLog);
      allHttpCalls.push(...httpLog);
      phaseTokens += tok;
      phaseDocReads += docReads;
      phaseThinkTimes.push(...thinkTimes);
      phaseResponseSizes.push(...responseSizes);

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
        if (attempt === MAX_RETRIES) errorRecovery = 'not_helped';
      }
    }

    if (passed) { passCount++; consecutiveFails = 0; } else { consecutiveFails++; }
    const phaseDur = Date.now() - phaseStart;
    totalTokens += phaseTokens;
    totalDocReads += phaseDocReads;

    const score = `(${passCount}/${i + 1})`;
    agentLog(`${String(phaseNum).padStart(2)}/${PHASES.length} ${phase.name.padEnd(20)} ${passed ? '✓ PASS' : '✗ FAIL'} ${score} [${(phaseDur / 1000).toFixed(1)}s] ${phaseHttpLog.length} calls, ${phaseTokens} phase-tok  ${reason}`);
    if (errorRecovery) {
      const firstErr = phaseHttpLog.find(h => h.status >= 400);
      const lastCall = phaseHttpLog[phaseHttpLog.length - 1];
      agentLog(`${String(phaseNum).padStart(2)}/${PHASES.length} ${phase.name.padEnd(20)} recovery: ${firstErr?.status || '?'} → ${lastCall?.status || '?'} ${errorRecovery === 'helped' ? '✓' : '✗'} (error message ${errorRecovery === 'helped' ? 'helped' : "didn't help"})`);
    }

    // Post-failure interview — ask agent what went wrong
    let failureInterview = null;
    if (!passed) {
      const whyNudge = `That phase (${phase.name}) didn't work. In 1-2 sentences: what went wrong, and what would have helped you find the right endpoint or complete this task?`;
      const { totalTokens: whyTok } = await runNudge(messages, whyNudge, provider, {
        phaseNum, totalPhases: PHASES.length, phaseName: phase.name + '/why', attempt: 0,
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
        agentLog(`${String(phaseNum).padStart(2)}/${PHASES.length} ${phase.name.padEnd(20)} WHY: ${failureInterview.split('\n')[0].substring(0, 140)}`);
      }
    }

    results.push({ phase: phase.name, passed, reason, duration_ms: phaseDur, http_calls: phaseHttpLog.length, failureInterview, errorRecovery, responseSizes: phaseResponseSizes, thinkTimes: phaseThinkTimes });

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
    });

    if (BAIL_AFTER > 0 && consecutiveFails >= BAIL_AFTER) {
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
    const phaseNames = PHASES.map(p => p.name);
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

  // Check server is up
  try {
    await fetch(`${BASE_URL}/api/v1/`);
  } catch {
    console.error(`Server not reachable at ${BASE_URL}. Start it first.`);
    process.exit(1);
  }

  // Reset rate limits before test run
  try { await fetch(`${BASE_URL}/api/v1/test/reset-rate-limits`, { method: 'POST' }); } catch {}

  const modelsToRun = resolveModels();
  for (const m of modelsToRun) checkApiKey(m);

  const doFeedback = MODE === 'both';

  const allScores = [];

  for (let mi = 0; mi < modelsToRun.length; mi++) {
    const mc = modelsToRun[mi];
    const wantFeedback = doFeedback && (mc.tier === 'both' || mc.tier === 'feedback' || MODE === 'both');

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

    // Navigation
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

    // Feedback (in same conversation context)
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
}

main().catch(err => { console.error(err.message); process.exit(1); });
