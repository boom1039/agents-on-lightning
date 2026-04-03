#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_DASHBOARD_URL = 'http://127.0.0.1:3308';

const PROFILES = {
  'identity-short': [
    { method: 'GET', path: '/', status: 200, holdMs: 300, gapMs: 800 },
    { method: 'GET', path: '/llms.txt', status: 200, holdMs: 300, gapMs: 900 },
    { method: 'GET', path: '/api/v1/skills/identity', status: 200, holdMs: 300, gapMs: 900 },
    { event: 'registration_attempt', success: true, gapMs: 150 },
    { method: 'POST', path: '/api/v1/agents/register', status: 201, holdMs: 400, gapMs: 1100 },
    { method: 'GET', path: '/api/v1/agents/me', status: 200, holdMs: 300, gapMs: 1400 },
    { method: 'PUT', path: '/api/v1/agents/me', status: 200, holdMs: 300, gapMs: 400 },
    { method: 'GET', path: '/api/v1/agents/me/referral-code', status: 200, holdMs: 250, gapMs: 1200 },
  ],
  'identity-actions': [
    { method: 'GET', path: '/', status: 200, holdMs: 250, gapMs: 850 },
    { method: 'GET', path: '/llms.txt', status: 200, holdMs: 250, gapMs: 900 },
    { method: 'GET', path: '/api/v1/skills/identity', status: 200, holdMs: 250, gapMs: 900 },
    { event: 'registration_attempt', success: true, gapMs: 150 },
    { method: 'POST', path: '/api/v1/agents/register', status: 201, holdMs: 350, gapMs: 1200 },
    { method: 'POST', path: '/api/v1/actions/submit', status: 201, holdMs: 300, gapMs: 1700 },
    { method: 'GET', path: '/api/v1/actions/history', status: 200, holdMs: 250, gapMs: 1800 },
    { method: 'GET', path: '/api/v1/actions/act-simulated', status: 200, holdMs: 250, gapMs: 0 },
  ],
  'identity-exact-earlier-sequence': [
    { method: 'GET', path: '/', status: 200, holdMs: 4, gapMs: 797 },
    { method: 'GET', path: '/llms.txt', status: 200, holdMs: 8, gapMs: 878 },
    { method: 'GET', path: '/api/v1/skills/identity', status: 200, holdMs: 5, gapMs: 0 },
    { event: 'registration_attempt', success: true, gapMs: 0 },
    { method: 'POST', path: '/api/v1/agents/register', status: 201, holdMs: 10, gapMs: 8256 },
    { method: 'GET', path: '/api/v1/agents/me', status: 200, holdMs: 5, gapMs: 0 },
    { method: 'PUT', path: '/api/v1/agents/me', status: 200, holdMs: 4, gapMs: 1 },
    { method: 'GET', path: '/api/v1/agents/me/referral-code', status: 200, holdMs: 1, gapMs: 949 },
    { method: 'GET', path: '/api/v1/agents/:id', status: 200, holdMs: 4, gapMs: 0, rawPath: '/api/v1/agents/sim-exact-earlier-sequence' },
    { method: 'GET', path: '/docs', status: 200, holdMs: 12, gapMs: 1100 },
    { method: 'GET', path: '/api/v1/skills/identity', status: 200, holdMs: 5, gapMs: 2508 },
    { method: 'POST', path: '/api/v1/node/test-connection', status: 400, holdMs: 3, gapMs: 2026 },
    { method: 'POST', path: '/api/v1/node/connect', status: 400, holdMs: 4, gapMs: 2231 },
    { method: 'GET', path: '/api/v1/node/status', status: 200, holdMs: 4, gapMs: 0 },
    { method: 'GET', path: '/', status: 200, holdMs: 2, gapMs: 1243 },
    { method: 'GET', path: '/llms.txt', status: 200, holdMs: 4, gapMs: 899 },
    { method: 'GET', path: '/api/v1/skills/identity', status: 200, holdMs: 3, gapMs: 0 },
    { method: 'POST', path: '/api/v1/actions/submit', status: 201, holdMs: 8, gapMs: 1775 },
    { method: 'GET', path: '/api/v1/actions/history', status: 200, holdMs: 4, gapMs: 1957, rawPath: '/api/v1/actions/history' },
    { method: 'GET', path: '/api/v1/actions/:id', status: 200, holdMs: 6, gapMs: 0, rawPath: '/api/v1/actions/act-simulated-exact-earlier-sequence' },
  ],
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildSingleSequence(args, agentId) {
  const method = String(args.method || 'GET').toUpperCase();
  const path = String(args.path || '');
  if (!path) throw new Error('Missing --path for single-route simulation');
  return [
    {
      method,
      path,
      status: toInt(args.status, 200),
      holdMs: toInt(args['hold-ms'], 600),
      gapMs: toInt(args['gap-ms'], 0),
      agentId,
    },
  ];
}

function buildProfileSequence(args, agentId) {
  const profile = String(args.profile || '').trim();
  const template = PROFILES[profile];
  if (!template) {
    const known = Object.keys(PROFILES).sort().join(', ');
    throw new Error(`Unknown --profile "${profile}". Known profiles: ${known}`);
  }
  return template.map((step) => ({ ...step, agentId }));
}

async function postEvents(baseUrl, events) {
  const response = await fetch(`${baseUrl}/api/live-events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Dashboard rejected simulated events: ${response.status} ${body}`);
  }
  return response.json();
}

async function sendRegistration(baseUrl, agentId, step) {
  const ts = Date.now();
  const event = {
    event: 'registration_attempt',
    ts,
    success: step.success !== false,
    agent_id: agentId,
  };
  await postEvents(baseUrl, [event]);
  if (step.gapMs > 0) await delay(step.gapMs);
}

async function sendRequest(baseUrl, step, index) {
  const traceId = `${step.agentId}-sim-${index + 1}-${Date.now()}`;
  const startTs = Date.now();
  await postEvents(baseUrl, [{
    event: 'request_start',
    ts: startTs,
    trace_id: traceId,
    agent_id: step.agentId,
    method: step.method,
    path: step.rawPath || step.path,
  }]);

  if (step.holdMs > 0) await delay(step.holdMs);

  const finishTs = Date.now();
  await postEvents(baseUrl, [{
    event: 'request_finish',
    ts: finishTs,
    trace_id: traceId,
    agent_id: step.agentId,
    method: step.method,
    path: step.rawPath || step.path,
    status: step.status,
    duration_ms: finishTs - startTs,
  }]);

  if (step.gapMs > 0) await delay(step.gapMs);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dashboardUrl = String(args['dashboard-url'] || DEFAULT_DASHBOARD_URL).replace(/\/$/, '');
  const agentId = String(args['agent-id'] || `sim-${Date.now().toString(36)}`);
  const sequence = args.profile
    ? buildProfileSequence(args, agentId)
    : buildSingleSequence(args, agentId);

  for (let i = 0; i < sequence.length; i += 1) {
    const step = sequence[i];
    if (step.event === 'registration_attempt') {
      await sendRegistration(dashboardUrl, agentId, step);
      continue;
    }
    await sendRequest(dashboardUrl, step, i);
  }

  const mode = args.profile ? `profile ${args.profile}` : `${sequence[0].method} ${sequence[0].path}`;
  console.log(`simulated ${mode} for ${agentId} on ${dashboardUrl}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
