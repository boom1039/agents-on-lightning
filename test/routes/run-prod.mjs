#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { generateTestKeypair, signInstruction } from '../../src/channel-accountability/test-crypto-helpers.js';
import { loadLocalInputs } from './local-inputs.mjs';
import { loadDocsDrivenManifest } from './docs-flow.mjs';
import {
  buildRoutePlan,
  DEPRECATED_ROUTE_KEYS,
  DISABLED_ROUTE_KEYS,
  IDEMPOTENT_ROUTE_KEYS,
  METHOD_BOUNDARY_ROUTE_KEYS,
  SAMPLE_VALUES,
} from './prereqs.mjs';
import { padConsoleTable, writeHtmlReport } from './report-html.mjs';

const AGENT_NAMES = {
  agent_a: 'route-a',
  agent_b: 'route-b',
  agent_c: 'route-c',
  agent_d: 'route-d',
  agent_e: 'route-e',
};

const SAFE_TRANSIENT_RETRY_ROUTE_KEYS = new Set([
  'PUT /api/v1/market/revenue-config',
  'POST /api/v1/capital/deposit',
  'POST /api/v1/help',
]);

const REQUEST_LIMIT = Number.parseInt(process.env.AOL_ROUTE_REQUEST_LIMIT || '1', 10);
const WORKER_LIMIT = Number.parseInt(process.env.AOL_ROUTE_WORKER_LIMIT || '1', 10);
const REQUEST_GAP_MS = Number.parseInt(process.env.AOL_ROUTE_REQUEST_GAP_MS || '250', 10);
const PROBE_DELAY_MS = Number.parseInt(process.env.AOL_ROUTE_PROBE_DELAY_MS || '450', 10);
const PRESSURE_BACKOFF_MS = Number.parseInt(process.env.AOL_ROUTE_PRESSURE_BACKOFF_MS || '1500', 10);
let activeRequests = 0;
const requestWaiters = [];
let pressureBackoffUntil = 0;

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function routeKey(method, path) {
  return `${String(method || '').toUpperCase()} ${String(path || '').split('?')[0] || '/'}`;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function shorten(text, max = 180) {
  const value = `${text ?? ''}`.replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function securityLabel(route) {
  const flags = [];
  if (route.security?.moves_money) flags.push('money');
  if (route.security?.requires_ownership) flags.push('own');
  if (route.security?.requires_signature) flags.push('sig');
  if (route.security?.long_running) flags.push('long');
  return flags.length > 0 ? flags.join(',') : 'none';
}

function hashKey(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function makeMemo() {
  const cache = new Map();
  return async function memo(key, producer) {
    if (!cache.has(key)) {
      cache.set(key, Promise.resolve().then(producer));
    }
    return cache.get(key);
  };
}

function isGatewayPressureStatus(status) {
  return status === 502 || status === 503 || status === 504;
}

function noteGatewayPressure() {
  pressureBackoffUntil = Math.max(pressureBackoffUntil, Date.now() + PRESSURE_BACKOFF_MS);
}

async function waitForPressureCooldown() {
  const remaining = pressureBackoffUntil - Date.now();
  if (remaining > 0) {
    await sleep(remaining);
  }
}

async function runWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) return;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function createRow(route, plan) {
  return {
    route: route.key,
    canonical_doc_path: route.canonical_doc_path || '',
    doc_step: route.doc_step || '',
    domain: route.domain,
    auth: route.auth,
    security: securityLabel(route),
    lane: plan.lane,
    actor: plan.actor,
    prereqs: plan.prereqs.join(', '),
    expected: '',
    observed: '',
    http: '',
    attempts: 0,
    evidence: '',
    duration: '',
    final: 'fail',
    reason: 'unreached_by_docs',
    _plan: plan,
    _route: route,
    _checks: [],
  };
}

async function acquireRequestSlot() {
  if (activeRequests < REQUEST_LIMIT) {
    activeRequests += 1;
    return;
  }
  await new Promise((resolve) => requestWaiters.push(resolve));
  activeRequests += 1;
}

function releaseRequestSlot() {
  activeRequests = Math.max(0, activeRequests - 1);
  const next = requestWaiters.shift();
  if (next) next();
}

async function fetchText(baseUrl, path, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 20000,
} = {}) {
  const url = new URL(path, `${baseUrl}/`);
  const started = Date.now();
  await acquireRequestSlot();
  try {
    await waitForPressureCooldown();
    await sleep(REQUEST_GAP_MS);
    const response = await fetch(url, {
      method,
      headers,
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (isGatewayPressureStatus(response.status)) {
      noteGatewayPressure();
    }
    return {
      ok: response.ok,
      status: response.status,
      text,
      json: parseJson(text),
      duration_ms: Date.now() - started,
      url: url.toString(),
      hard_error: null,
    };
  } catch (error) {
    noteGatewayPressure();
    return {
      ok: false,
      status: null,
      text: '',
      json: null,
      duration_ms: Date.now() - started,
      url: url.toString(),
      hard_error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    releaseRequestSlot();
  }
}

async function fetchWithRetry(baseUrl, path, options = {}, {
  retries = 2,
  retryStatuses = [502, 503, 504],
  retryDelayMs = 1000,
} = {}) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = await fetchText(baseUrl, path, options);
    last = result;
    if (result.hard_error) {
      if (attempt < retries) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
      return result;
    }
    if (!retryStatuses.includes(result.status)) {
      return result;
    }
    if (attempt < retries) {
      await sleep(retryDelayMs * (attempt + 1));
    }
  }
  return last;
}

function authHeaders(agent) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${agent.api_key}`,
  };
}

function buildActorName(runId, key) {
  return `routes-${runId}-${AGENT_NAMES[key]}`;
}

function pickId(list, keys) {
  for (const entry of list || []) {
    for (const key of keys) {
      if (entry?.[key]) return entry[key];
    }
  }
  return null;
}

function classifyBoundaryAcceptance(result, {
  allowGuardrail = false,
  reason = 'wrong_state',
  dynamicMissing = false,
  missingInput = false,
  deprecated = false,
  disabled = false,
  methodBoundary = false,
} = {}) {
  if (result.hard_error) {
    return { final: 'fail', reason: 'timeout', observed: result.hard_error };
  }
  if (result.status >= 200 && result.status < 300) {
    return { final: 'pass_success', reason: 'ok', observed: shorten(result.json?.message || result.text || `HTTP ${result.status}`) };
  }
  if (methodBoundary && result.status === 405) {
    return { final: 'pass_guardrail', reason: 'method_boundary_expected', observed: shorten(result.json?.message || result.text || `HTTP ${result.status}`) };
  }
  if (deprecated && [404, 405, 410, 503].includes(result.status)) {
    return { final: 'pass_guardrail', reason: 'deprecated_expected', observed: shorten(result.json?.message || result.text || `HTTP ${result.status}`) };
  }
  if (disabled && [403, 404, 405, 410, 503].includes(result.status)) {
    return { final: 'pass_guardrail', reason: 'disabled_expected', observed: shorten(result.json?.message || result.text || `HTTP ${result.status}`) };
  }
  if (dynamicMissing && result.status === 404) {
    return { final: 'pass_guardrail', reason: 'not_found_expected', observed: shorten(result.json?.message || result.text || `HTTP ${result.status}`) };
  }
  if ((missingInput || allowGuardrail) && result.status >= 400 && result.status < 600) {
    return { final: 'pass_guardrail', reason: missingInput ? 'missing_input' : reason, observed: shorten(result.json?.message || result.text || `HTTP ${result.status}`) };
  }
  return { final: 'fail', reason: 'wrong_http', observed: shorten(result.json?.message || result.text || `HTTP ${result.status}`) };
}

function mergeEvidence(parts) {
  return Object.entries(parts)
    .filter(([, value]) => value !== null && value !== undefined && `${value}`.trim() !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}

function idempotencyKeyFor(routeKey, runId) {
  return `${runId}-${hashKey(routeKey)}`;
}

function mainRetryCountForRoute(route) {
  if (route.method === 'GET') return 3;
  if (SAFE_TRANSIENT_RETRY_ROUTE_KEYS.has(route.key)) return 2;
  return 0;
}

function createSuiteContext(inputs, docsBundle, rows) {
  const memo = makeMemo();
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const baseUrl = inputs.base_url.replace(/\/+$/, '');
  const rowsByKey = new Map(rows.map((row) => [row.route, row]));
  const state = {
    runId,
    baseUrl,
    inputs,
    docsBundle,
    rowsByKey,
  };

  async function registerAgent(actorKey) {
    return memo(`agent:${actorKey}`, async () => {
      const name = buildActorName(runId, actorKey);
      const result = await fetchText(baseUrl, '/api/v1/agents/register', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name,
          description: 'Docs-driven master route suite agent.',
        }),
        timeoutMs: inputs.timeouts.fetch_ms,
      });
      const data = result.json || {};
      return {
        actor_key: actorKey,
        name,
        result,
        agent_id: data.agent_id || data.id || null,
        api_key: data.api_key || null,
        referral_code: data.referral_code || null,
        synthetic: !(result.ok && data.api_key && data.agent_id),
      };
    });
  }

  async function ensureKeypair(actorKey) {
    return memo(`keypair:${actorKey}`, async () => {
      const pair = generateTestKeypair();
      return {
        ...pair,
        synthetic: false,
      };
    });
  }

  async function ensurePubkey(actorKey) {
    return memo(`pubkey:${actorKey}`, async () => {
      const agent = await registerAgent(actorKey);
      const keypair = await ensureKeypair(actorKey);
      if (!agent.api_key) {
        return {
          pubkey: keypair.pubHex,
          privateKey: keypair.privateKey,
          synthetic: true,
          result: agent.result,
        };
      }
      const result = await fetchText(baseUrl, '/api/v1/agents/me', {
        method: 'PUT',
        headers: {
          ...authHeaders(agent),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: agent.name,
          description: 'Docs-driven master route suite agent.',
          pubkey: keypair.pubHex,
        }),
        timeoutMs: inputs.timeouts.fetch_ms,
      });
      return {
        pubkey: keypair.pubHex,
        privateKey: keypair.privateKey,
        synthetic: !result.ok,
        result,
      };
    });
  }

  async function ensureStrategies() {
    return memo('strategies', async () => {
      const result = await fetchText(baseUrl, '/api/v1/strategies', { timeoutMs: inputs.timeouts.fetch_ms });
      const strategies = result.json?.strategies || [];
      return {
        strategy_name: strategies[0]?.name || SAMPLE_VALUES.strategy_name,
        synthetic: !strategies[0]?.name,
        result,
      };
    });
  }

  async function ensurePlatformStatus() {
    return memo('platform-status', async () => {
      const result = await fetchText(baseUrl, '/api/v1/platform/status', { timeoutMs: inputs.timeouts.fetch_ms });
      return {
        node_pubkey: result.json?.node_pubkey || SAMPLE_VALUES.peer_pubkey,
        synthetic: !result.json?.node_pubkey,
        result,
      };
    });
  }

  async function ensureActionId() {
    return memo('action-id', async () => {
      const agent = await registerAgent('agent_a');
      if (!agent.api_key) {
        return { action_id: SAMPLE_VALUES.action_id, synthetic: true, result: agent.result };
      }
      const result = await fetchText(baseUrl, '/api/v1/actions/submit', {
        method: 'POST',
        headers: {
          ...authHeaders(agent),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action_type: 'open_channel',
          params: { peer_pubkey: SAMPLE_VALUES.peer_pubkey },
          description: 'Docs-driven master route suite action.',
        }),
        timeoutMs: inputs.timeouts.fetch_ms,
      });
      return {
        action_id: result.json?.action_id || SAMPLE_VALUES.action_id,
        synthetic: !result.json?.action_id,
        result,
      };
    });
  }

  async function ensurePublicAgentId() {
    return memo('public-agent-id', async () => {
      const agent = await registerAgent('agent_a');
      return {
        agent_id: agent.agent_id || SAMPLE_VALUES.public_agent_id,
        synthetic: !agent.agent_id,
        result: agent.result,
      };
    });
  }

  async function ensureAllianceId() {
    return memo('alliance-id', async () => {
      const sender = await registerAgent('agent_c');
      const recipient = await registerAgent('agent_d');
      if (!sender.api_key || !recipient.agent_id) {
        return { alliance_id: 'alliance-test-0001', synthetic: true, result: sender.result };
      }
      const result = await fetchText(baseUrl, '/api/v1/alliances', {
        method: 'POST',
        headers: {
          ...authHeaders(sender),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: recipient.agent_id,
          terms: {
            description: 'Share fee intelligence',
            duration_hours: 24,
          },
        }),
        timeoutMs: inputs.timeouts.fetch_ms,
      });
      return {
        alliance_id: result.json?.alliance_id || result.json?.id || 'alliance-test-0001',
        synthetic: !(result.json?.alliance_id || result.json?.id),
        result,
      };
    });
  }

  async function ensureTournamentId() {
    return memo('tournament-id', async () => {
      const result = await fetchText(baseUrl, '/api/v1/tournaments', { timeoutMs: inputs.timeouts.fetch_ms });
      const tournaments = result.json?.tournaments || [];
      const tournament_id = pickId(tournaments, ['tournament_id', 'id']) || SAMPLE_VALUES.tournament_id;
      return {
        tournament_id,
        synthetic: !pickId(tournaments, ['tournament_id', 'id']),
        result,
      };
    });
  }

  async function ensureAuditChanId() {
    return memo('audit-chan-id', async () => {
      const result = await fetchText(baseUrl, '/api/v1/channels/audit', { timeoutMs: inputs.timeouts.fetch_ms });
      const entries = result.json?.entries || [];
      const chan_id = pickId(entries, ['chan_id', 'channel_point']) || SAMPLE_VALUES.audit_chan_id;
      return {
        chan_id,
        synthetic: !pickId(entries, ['chan_id', 'channel_point']),
        result,
      };
    });
  }

  async function ensureOwnedChannel(actorKey = 'agent_a') {
    return memo(`owned-chan:${actorKey}`, async () => {
      const agent = await registerAgent(actorKey);
      if (!agent.api_key) {
        return {
          chan_id: SAMPLE_VALUES.owned_chan_id,
          channel_point: SAMPLE_VALUES.owned_channel_point,
          synthetic: true,
          result: agent.result,
        };
      }
      const result = await fetchText(baseUrl, '/api/v1/channels/mine', {
        headers: authHeaders(agent),
        timeoutMs: inputs.timeouts.fetch_ms,
      });
      const channels = result.json?.channels || [];
      const first = channels[0] || {};
      return {
        chan_id: first.chan_id || SAMPLE_VALUES.owned_chan_id,
        channel_point: first.channel_point || SAMPLE_VALUES.owned_channel_point,
        synthetic: !(first.chan_id || first.channel_point),
        result,
      };
    });
  }

  async function ensureMintQuote(actorKey = 'agent_c') {
    return memo(`mint-quote:${actorKey}`, async () => {
      const agent = await registerAgent(actorKey);
      if (!agent.api_key) {
        return { quote_id: 'quote-test-0001', invoice: SAMPLE_VALUES.external_invoice, synthetic: true, result: agent.result };
      }
      const result = await fetchText(baseUrl, '/api/v1/wallet/mint-quote', {
        method: 'POST',
        headers: {
          ...authHeaders(agent),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount_sats: 1000 }),
        timeoutMs: inputs.timeouts.fetch_ms,
      });
      return {
        quote_id: result.json?.quote_id || 'quote-test-0001',
        invoice: result.json?.request || result.json?.invoice || SAMPLE_VALUES.external_invoice,
        synthetic: !(result.json?.quote_id),
        result,
      };
    });
  }

  async function ensureDeposit(actorKey = 'agent_a') {
    return memo(`deposit:${actorKey}`, async () => {
      const agent = await registerAgent(actorKey);
      if (!agent.api_key) {
        return { address: SAMPLE_VALUES.onchain_address, synthetic: true, result: agent.result };
      }
      const result = await fetchText(baseUrl, '/api/v1/capital/deposit', {
        method: 'POST',
        headers: {
          ...authHeaders(agent),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
        timeoutMs: inputs.timeouts.fetch_ms,
      });
      return {
        address: result.json?.address || SAMPLE_VALUES.onchain_address,
        synthetic: !(result.json?.address),
        result,
      };
    });
  }

  async function ensurePeerTarget() {
    return memo('peer-target', async () => {
      if (inputs.peer_targets.length > 0) {
        return { ...inputs.peer_targets[0], synthetic: false, result: null };
      }
      const platform = await ensurePlatformStatus();
      const pubkey = platform.node_pubkey || SAMPLE_VALUES.peer_pubkey;
      const result = await fetchText(baseUrl, `/api/v1/analysis/suggest-peers/${pubkey}`, {
        timeoutMs: inputs.timeouts.fetch_ms,
      });
      const candidates = result.json?.suggestions || result.json?.peers || [];
      const first = candidates[0] || {};
      return {
        pubkey: first.pubkey || first.node_pubkey || SAMPLE_VALUES.peer_pubkey,
        host: first.host || first.address || '',
        synthetic: !(first.pubkey || first.node_pubkey),
        result,
      };
    });
  }

  async function ensureNodeSecrets() {
    return memo('node-secrets', async () => {
      const provided = Boolean(inputs.node.host && inputs.node.macaroon && inputs.node.tls_cert);
      return {
        host: inputs.node.host,
        macaroon: inputs.node.macaroon,
        tls_cert: inputs.node.tls_cert,
        synthetic: !provided,
        result: null,
      };
    });
  }

  async function ensureMarketAgentId() {
    return memo('market-agent-id', async () => {
      const result = await fetchText(baseUrl, '/api/v1/market/channels', { timeoutMs: inputs.timeouts.fetch_ms });
      const channels = result.json?.channels || [];
      return {
        agent_id: pickId(channels, ['agent_id']) || (await ensurePublicAgentId()).agent_id,
        synthetic: !pickId(channels, ['agent_id']),
        result,
      };
    });
  }

    async function ensurePrereq(tag, actorKey) {
    switch (tag) {
      case 'none':
        return { synthetic: false, value: null };
      case 'agent':
        return registerAgent(actorKey);
      case 'agent_pubkey':
        return ensurePubkey(actorKey);
      case 'strategy_name':
        return ensureStrategies();
      case 'public_agent_id':
        return ensurePublicAgentId();
      case 'market_agent_id':
        return ensureMarketAgentId();
      case 'public_node_pubkey':
        return ensurePlatformStatus();
      case 'node_secrets':
        return ensureNodeSecrets();
      case 'action_id':
        return ensureActionId();
      case 'paid_quote':
        return {
          ...(await ensureMintQuote(actorKey)),
          synthetic: true,
        };
      case 'funded_wallet':
        return {
          ...(await ensureMintQuote(actorKey)),
          synthetic: true,
        };
      case 'cashu_token':
        return { token: SAMPLE_VALUES.cashu_token, synthetic: true, result: null };
      case 'external_invoice':
        return { invoice: inputs.external_invoice || SAMPLE_VALUES.external_invoice, synthetic: !inputs.external_invoice, result: null };
      case 'pending_wallet_state':
        return { synthetic: true, result: null };
      case 'confirmed_deposit':
      case 'funded_capital':
        return {
          ...(await ensureDeposit(actorKey)),
          synthetic: true,
        };
      case 'peer_target':
        return ensurePeerTarget();
      case 'signed_body':
        return ensurePubkey(actorKey);
      case 'owned_chan_id':
        return ensureOwnedChannel(actorKey);
      case 'audit_chan_id':
        return ensureAuditChanId();
      case 'alliance_id':
        return ensureAllianceId();
      case 'tournament_id':
        return ensureTournamentId();
      case 'flow_id':
        return { flow_id: SAMPLE_VALUES.flow_id, synthetic: true, result: null };
      case 'swap_id':
        return { swap_id: SAMPLE_VALUES.swap_id, synthetic: true, result: null };
      case 'onchain_address':
        return { onchain_address: inputs.onchain_address || SAMPLE_VALUES.onchain_address, synthetic: !inputs.onchain_address, result: null };
      default:
        return { synthetic: true, result: null };
    }
  }

  async function collectPrereqs(plan) {
    const values = {};
    for (const tag of plan.prereqs) {
      values[tag] = await ensurePrereq(tag, plan.actor);
    }
    return values;
  }

  return {
    ...state,
    registerAgent,
    ensurePubkey,
    collectPrereqs,
  };
}

async function resolvePathForRoute(route, prereqs) {
  switch (route.key) {
    case 'GET /api/v1/platform/decode-invoice': {
      const invoice = prereqs.external_invoice?.invoice || prereqs.paid_quote?.invoice || SAMPLE_VALUES.external_invoice;
      return `/api/v1/platform/decode-invoice?invoice=${encodeURIComponent(invoice)}`;
    }
    case 'GET /api/v1/strategies/:name':
      return `/api/v1/strategies/${encodeURIComponent(prereqs.strategy_name?.strategy_name || SAMPLE_VALUES.strategy_name)}`;
    case 'GET /api/v1/actions/:id':
      return `/api/v1/actions/${encodeURIComponent(prereqs.action_id?.action_id || SAMPLE_VALUES.action_id)}`;
    case 'GET /api/v1/agents/:id':
      return `/api/v1/agents/${encodeURIComponent(prereqs.public_agent_id?.agent_id || SAMPLE_VALUES.public_agent_id)}`;
    case 'GET /api/v1/agents/:id/lineage':
      return `/api/v1/agents/${encodeURIComponent(prereqs.public_agent_id?.agent_id || SAMPLE_VALUES.public_agent_id)}/lineage`;
    case 'GET /api/v1/analysis/node/:pubkey':
      return `/api/v1/analysis/node/${encodeURIComponent(prereqs.public_node_pubkey?.node_pubkey || SAMPLE_VALUES.peer_pubkey)}`;
    case 'GET /api/v1/analysis/suggest-peers/:pubkey':
      return `/api/v1/analysis/suggest-peers/${encodeURIComponent(prereqs.public_node_pubkey?.node_pubkey || SAMPLE_VALUES.peer_pubkey)}`;
    case 'GET /api/v1/leaderboard/agent/:id':
      return `/api/v1/leaderboard/agent/${encodeURIComponent(prereqs.public_agent_id?.agent_id || SAMPLE_VALUES.public_agent_id)}`;
    case 'GET /api/v1/tournaments/:id/bracket':
      return `/api/v1/tournaments/${encodeURIComponent(prereqs.tournament_id?.tournament_id || SAMPLE_VALUES.tournament_id)}/bracket`;
    case 'POST /api/v1/tournaments/:id/enter':
      return `/api/v1/tournaments/${encodeURIComponent(prereqs.tournament_id?.tournament_id || SAMPLE_VALUES.tournament_id)}/enter`;
    case 'GET /api/v1/channels/audit/:chanId':
      return `/api/v1/channels/audit/${encodeURIComponent(prereqs.audit_chan_id?.chan_id || SAMPLE_VALUES.audit_chan_id)}`;
    case 'GET /api/v1/channels/verify/:chanId':
      return `/api/v1/channels/verify/${encodeURIComponent(prereqs.audit_chan_id?.chan_id || SAMPLE_VALUES.audit_chan_id)}`;
    case 'GET /api/v1/market/agent/:agentId':
      return `/api/v1/market/agent/${encodeURIComponent(prereqs.market_agent_id?.agent_id || SAMPLE_VALUES.market_agent_id)}`;
    case 'GET /api/v1/market/fees/:peerPubkey':
      return `/api/v1/market/fees/${encodeURIComponent(prereqs.peer_target?.pubkey || SAMPLE_VALUES.peer_pubkey)}`;
    case 'GET /api/v1/market/peer-safety/:pubkey':
      return `/api/v1/market/peer-safety/${encodeURIComponent(prereqs.peer_target?.pubkey || SAMPLE_VALUES.peer_pubkey)}`;
    case 'GET /api/v1/market/fund-from-ecash/:flowId':
      return `/api/v1/market/fund-from-ecash/${encodeURIComponent(prereqs.flow_id?.flow_id || SAMPLE_VALUES.flow_id)}`;
    case 'GET /api/v1/market/performance/:chanId':
      return `/api/v1/market/performance/${encodeURIComponent(prereqs.owned_chan_id?.chan_id || SAMPLE_VALUES.owned_chan_id)}`;
    case 'GET /api/v1/market/revenue/:chanId':
      return `/api/v1/market/revenue/${encodeURIComponent(prereqs.owned_chan_id?.chan_id || SAMPLE_VALUES.owned_chan_id)}`;
    case 'GET /api/v1/market/swap/status/:swapId':
      return `/api/v1/market/swap/status/${encodeURIComponent(prereqs.swap_id?.swap_id || SAMPLE_VALUES.swap_id)}`;
    case 'GET /api/v1/market/swap/quote':
      return '/api/v1/market/swap/quote?amount_sats=100000';
    case 'POST /api/v1/alliances/:id/accept':
      return `/api/v1/alliances/${encodeURIComponent(prereqs.alliance_id?.alliance_id || 'alliance-test-0001')}/accept`;
    case 'POST /api/v1/alliances/:id/break':
      return `/api/v1/alliances/${encodeURIComponent(prereqs.alliance_id?.alliance_id || 'alliance-test-0001')}/break`;
    default:
      return route.path;
  }
}

async function buildInstruction(route, prereqs, agent) {
  if (!agent?.actor_key) return null;
  const base = {
    agent_id: agent.agent_id,
    timestamp: Math.floor(Date.now() / 1000),
  };
  switch (route.key) {
    case 'POST /api/v1/channels/preview':
    case 'POST /api/v1/channels/instruct':
      return {
        ...base,
        action: 'set_fee_policy',
        channel_id: prereqs.owned_chan_id?.chan_id || SAMPLE_VALUES.owned_chan_id,
        params: {
          base_fee_msat: 0,
          fee_rate_ppm: 100,
        },
      };
    case 'POST /api/v1/market/preview':
    case 'POST /api/v1/market/open':
    case 'POST /api/v1/market/fund-from-ecash':
      return {
        ...base,
        action: 'channel_open',
        params: {
          local_funding_amount_sats: 100000,
          peer_pubkey: prereqs.peer_target?.pubkey || SAMPLE_VALUES.peer_pubkey,
        },
      };
    case 'POST /api/v1/market/close':
      return {
        ...base,
        action: 'channel_close',
        params: {
          channel_point: prereqs.owned_chan_id?.channel_point || SAMPLE_VALUES.owned_channel_point,
        },
      };
    case 'POST /api/v1/market/rebalance':
      return {
        ...base,
        action: 'rebalance',
        params: {
          outbound_chan_id: prereqs.owned_chan_id?.chan_id || SAMPLE_VALUES.owned_chan_id,
          amount_sats: 10000,
          max_fee_sats: 10,
        },
      };
    default:
      return null;
  }
}

async function buildMainRequest(row, ctx) {
  const { _route: route, _plan: plan } = row;
  const prereqs = await ctx.collectPrereqs(plan);
  const path = await resolvePathForRoute(route, prereqs);
  const actor = plan.actor === 'public' ? null : await ctx.registerAgent(plan.actor);
  const headers = { Accept: 'application/json' };
  const evidence = {};
  let body = null;

  if (actor?.api_key) {
    headers.Authorization = `Bearer ${actor.api_key}`;
    evidence.agent_id = actor.agent_id;
  }

  const syntheticInputs = Object.values(prereqs).filter((value) => value?.synthetic === true);
  const missingInput = syntheticInputs.length > 0;

  switch (route.key) {
    case 'POST /api/v1/agents/register':
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({
        name: `register-${ctx.runId}`,
        description: 'Docs-driven master route suite registration.',
      });
      break;
    case 'PUT /api/v1/agents/me': {
      const keypair = await ctx.ensurePubkey(plan.actor);
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({
        name: buildActorName(ctx.runId, plan.actor),
        description: 'Docs-driven master route suite agent.',
        pubkey: keypair.pubkey,
      });
      evidence.pubkey = keypair.pubkey;
      break;
    }
    case 'POST /api/v1/actions/submit':
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({
        action_type: 'open_channel',
        params: { peer_pubkey: SAMPLE_VALUES.peer_pubkey },
        description: 'Docs-driven master route suite action.',
      });
      break;
    case 'POST /api/v1/node/test-connection':
    case 'POST /api/v1/node/connect': {
      headers['Content-Type'] = 'application/json';
      const secrets = prereqs.node_secrets;
      body = JSON.stringify(secrets.synthetic ? {} : {
        host: secrets.host,
        macaroon: secrets.macaroon,
        tls_cert: secrets.tls_cert,
      });
      break;
    }
    case 'POST /api/v1/wallet/mint-quote':
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ amount_sats: 1000 });
      break;
    case 'POST /api/v1/wallet/check-mint-quote':
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ quote_id: prereqs.paid_quote?.quote_id || 'quote-test-0001' });
      evidence.quote_id = prereqs.paid_quote?.quote_id || 'quote-test-0001';
      break;
    case 'POST /api/v1/wallet/mint':
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({
        amount_sats: 1000,
        quote_id: prereqs.paid_quote?.quote_id || 'quote-test-0001',
      });
      evidence.quote_id = prereqs.paid_quote?.quote_id || 'quote-test-0001';
      break;
    case 'POST /api/v1/wallet/melt-quote':
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ invoice: prereqs.external_invoice?.invoice || SAMPLE_VALUES.external_invoice });
      break;
    case 'POST /api/v1/wallet/melt':
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ quote_id: 'missing-quote-id' });
      break;
    case 'POST /api/v1/wallet/send':
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ amount_sats: 1 });
      break;
    case 'POST /api/v1/wallet/receive':
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ token: prereqs.cashu_token?.token || SAMPLE_VALUES.cashu_token });
      break;
    case 'POST /api/v1/wallet/restore':
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({});
      break;
    case 'POST /api/v1/wallet/reclaim-pending':
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ max_age_hours: 24 });
      break;
    case 'POST /api/v1/wallet/deposit':
    case 'POST /api/v1/wallet/withdraw':
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({});
      break;
    case 'POST /api/v1/messages': {
      const recipient = await ctx.registerAgent('agent_d');
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({
        to: recipient.agent_id || SAMPLE_VALUES.public_agent_id,
        content: 'hello again',
        type: 'intel',
      });
      evidence.to = recipient.agent_id || SAMPLE_VALUES.public_agent_id;
      break;
    }
    case 'POST /api/v1/alliances': {
      const recipient = await ctx.registerAgent('agent_d');
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({
        to: recipient.agent_id || SAMPLE_VALUES.public_agent_id,
        terms: {
          description: 'Share fee intelligence',
          duration_hours: 24,
        },
      });
      evidence.to = recipient.agent_id || SAMPLE_VALUES.public_agent_id;
      break;
    }
    case 'POST /api/v1/alliances/:id/accept':
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({});
      evidence.alliance_id = prereqs.alliance_id?.alliance_id || 'alliance-test-0001';
      break;
    case 'POST /api/v1/alliances/:id/break':
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ reason: 'done' });
      evidence.alliance_id = prereqs.alliance_id?.alliance_id || 'alliance-test-0001';
      break;
    case 'POST /api/v1/tournaments/:id/enter':
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({});
      evidence.tournament_id = prereqs.tournament_id?.tournament_id || SAMPLE_VALUES.tournament_id;
      break;
    case 'POST /api/v1/channels/preview':
    case 'POST /api/v1/channels/instruct':
    case 'POST /api/v1/market/preview':
    case 'POST /api/v1/market/open':
    case 'POST /api/v1/market/close':
    case 'POST /api/v1/market/fund-from-ecash':
    case 'POST /api/v1/market/rebalance': {
      headers['Content-Type'] = 'application/json';
      const pubkey = await ctx.ensurePubkey(plan.actor);
      const instruction = await buildInstruction(route, prereqs, { ...actor, ...pubkey, actor_key: plan.actor });
      const signature = signInstruction(instruction, pubkey.privateKey);
      const payload = {
        instruction,
        signature,
      };
      if (IDEMPOTENT_ROUTE_KEYS.has(route.key)) {
        payload.idempotency_key = idempotencyKeyFor(route.key, ctx.runId);
      }
      body = JSON.stringify(payload);
      evidence.signature = signature.slice(0, 16);
      if (instruction?.channel_id) evidence.chan_id = instruction.channel_id;
      if (instruction?.params?.channel_point) evidence.channel_point = instruction.params.channel_point;
      if (instruction?.params?.peer_pubkey) evidence.peer_pubkey = instruction.params.peer_pubkey;
      break;
    }
    case 'POST /api/v1/market/rebalance/estimate':
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({
        outbound_chan_id: prereqs.owned_chan_id?.chan_id || SAMPLE_VALUES.owned_chan_id,
        amount_sats: 10000,
      });
      evidence.chan_id = prereqs.owned_chan_id?.chan_id || SAMPLE_VALUES.owned_chan_id;
      break;
    case 'PUT /api/v1/market/revenue-config':
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ destination: 'capital' });
      break;
    case 'POST /api/v1/market/swap/lightning-to-onchain':
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({
        amount_sats: 100000,
        onchain_address: prereqs.onchain_address?.onchain_address || SAMPLE_VALUES.onchain_address,
      });
      evidence.onchain_address = prereqs.onchain_address?.onchain_address || SAMPLE_VALUES.onchain_address;
      break;
    case 'POST /api/v1/analytics/quote': {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ query_id: 'network_stats', params: {} });
      break;
    }
    case 'POST /api/v1/analytics/execute': {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({
        query_id: 'network_stats',
        params: {},
        idempotency_key: idempotencyKeyFor(route.key, ctx.runId),
      });
      break;
    }
    case 'POST /api/v1/capital/deposit':
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ idempotency_key: idempotencyKeyFor(route.key, ctx.runId) });
      break;
    case 'POST /api/v1/capital/withdraw':
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({
        amount_sats: 1000,
        destination_address: SAMPLE_VALUES.onchain_address,
      });
      break;
    case 'POST /api/v1/help':
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({
        question: 'How do I open a channel?',
        idempotency_key: idempotencyKeyFor(route.key, ctx.runId),
      });
      break;
    default:
      break;
  }

  const dynamicMissing = route.path.includes(':')
    && Object.values(prereqs).some((value) => value?.synthetic === true)
    && route.method === 'GET';

  return {
    route,
    plan,
    prereqs,
    actor,
    path,
    headers,
    body,
    evidence,
    allow_guardrail: missingInput,
    missing_input: missingInput,
    dynamic_missing: dynamicMissing,
    expected: (() => {
      if (METHOD_BOUNDARY_ROUTE_KEYS.has(route.key)) return 'method boundary or helpful teaching response';
      if (DEPRECATED_ROUTE_KEYS.has(route.key)) return 'deprecated boundary response';
      if (DISABLED_ROUTE_KEYS.has(route.key)) return 'disabled boundary response';
      if (missingInput) return 'helpful guardrail because the run has no real funding or secret input here';
      if (route.method === 'GET' && route.auth === 'public') return 'public read should work';
      if (route.method === 'GET' && route.auth === 'agent') return 'agent read should work';
      return 'documented route should work or fail with a clean guardrail';
    })(),
  };
}

async function runAuthProbe(ctx, request) {
  await sleep(PROBE_DELAY_MS);
  const headers = { ...request.headers };
  delete headers.Authorization;
  const result = await fetchWithRetry(ctx.baseUrl, request.path, {
    method: request.route.method,
    headers,
    body: request.body,
    timeoutMs: request.route.security?.long_running ? ctx.inputs.timeouts.long_poll_ms : ctx.inputs.timeouts.fetch_ms,
  }, {
    retries: 3,
    retryDelayMs: 1200,
  });
  const payload = result.json || {};
  const ok = result.status === 401 && payload.error === 'authentication_required';
  return {
    ok,
    result,
    observed: ok ? '401 authentication_required' : shorten(payload.message || result.text || result.hard_error || `HTTP ${result.status}`),
  };
}

async function runSignatureProbe(ctx, request) {
  await sleep(PROBE_DELAY_MS);
  const payload = parseJson(request.body || '{}') || {};
  payload.signature = '00';
  const result = await fetchWithRetry(ctx.baseUrl, request.path, {
    method: request.route.method,
    headers: request.headers,
    body: JSON.stringify(payload),
    timeoutMs: ctx.inputs.timeouts.fetch_ms,
  }, {
    retries: 3,
    retryDelayMs: 1200,
  });
  const body = result.json || {};
  const ok = result.status && result.status >= 400 && (
    body.failed_at === 'signature_valid'
    || `${body.error || ''}`.includes('signature')
    || `${body.message || ''}`.toLowerCase().includes('signature')
  );
  return {
    ok,
    result,
    observed: ok ? shorten(body.message || body.error || `HTTP ${result.status}`) : shorten(body.message || result.text || result.hard_error || `HTTP ${result.status}`),
  };
}

async function runOwnershipProbe(ctx, request) {
  await sleep(PROBE_DELAY_MS);
  const foreign = await ctx.registerAgent('agent_b');
  const headers = {
    ...request.headers,
    Authorization: foreign.api_key ? `Bearer ${foreign.api_key}` : request.headers.Authorization,
  };
  let body = request.body;
  if (request.route.security?.requires_signature) {
    const pubkey = await ctx.ensurePubkey('agent_b');
    const payload = parseJson(request.body || '{}') || {};
    if (payload.instruction) {
      payload.instruction.agent_id = foreign.agent_id || payload.instruction.agent_id;
      payload.signature = signInstruction(payload.instruction, pubkey.privateKey);
      body = JSON.stringify(payload);
    }
  }
  const result = await fetchWithRetry(ctx.baseUrl, request.path, {
    method: request.route.method,
    headers,
    body,
    timeoutMs: request.route.security?.long_running ? ctx.inputs.timeouts.long_poll_ms : ctx.inputs.timeouts.fetch_ms,
  }, {
    retries: 3,
    retryDelayMs: 1200,
  });
  const ok = !result.ok;
  return {
    ok,
    result,
    observed: ok ? shorten(result.json?.message || result.json?.error || result.text || `HTTP ${result.status}`) : shorten(result.text || `HTTP ${result.status}`),
  };
}

async function runIdempotencyProbe(ctx, request, firstResult) {
  await sleep(PROBE_DELAY_MS);
  const result = await fetchWithRetry(ctx.baseUrl, request.path, {
    method: request.route.method,
    headers: request.headers,
    body: request.body,
    timeoutMs: request.route.security?.long_running ? ctx.inputs.timeouts.long_poll_ms : ctx.inputs.timeouts.fetch_ms,
  }, {
    retries: 2,
    retryDelayMs: 1200,
  });
  const sameStatus = firstResult.status === result.status;
  const sameText = firstResult.text === result.text;
  return {
    ok: sameStatus && sameText,
    result,
    observed: sameStatus && sameText
      ? `same ${result.status} response`
      : `first=${firstResult.status} second=${result.status}`,
  };
}

async function executeRow(row, ctx) {
  const started = Date.now();
  const request = await buildMainRequest(row, ctx);
  row.expected = request.expected;
  const timeoutMs = row._route.security?.long_running ? ctx.inputs.timeouts.long_poll_ms : ctx.inputs.timeouts.fetch_ms;

  const result = await fetchWithRetry(ctx.baseUrl, request.path, {
    method: row._route.method,
    headers: request.headers,
    body: request.body,
    timeoutMs,
  }, {
    retries: mainRetryCountForRoute(row._route),
    retryDelayMs: row._route.method === 'GET' ? 1200 : 2000,
  });
  row.attempts += 1;

  const primary = classifyBoundaryAcceptance(result, {
    allowGuardrail: request.allow_guardrail,
    reason: 'wrong_state',
    dynamicMissing: request.dynamic_missing,
    missingInput: request.missing_input,
    deprecated: DEPRECATED_ROUTE_KEYS.has(row.route),
    disabled: DISABLED_ROUTE_KEYS.has(row.route),
    methodBoundary: METHOD_BOUNDARY_ROUTE_KEYS.has(row.route),
  });

  row.http = result.status ?? 'timeout';
  row.observed = primary.observed;
  row.final = primary.final;
  row.reason = primary.reason;
  row.evidence = mergeEvidence(request.evidence);

  const probeFailures = [];

  if (row._plan.needs_auth_probe) {
    const authProbe = await runAuthProbe(ctx, request);
    row.attempts += 1;
    if (!authProbe.ok) probeFailures.push(`auth wall failed: ${authProbe.observed}`);
  }

  if (!request.missing_input && row._plan.needs_signature_probe) {
    const signatureProbe = await runSignatureProbe(ctx, request);
    row.attempts += 1;
    if (!signatureProbe.ok) probeFailures.push(`signature wall failed: ${signatureProbe.observed}`);
  }

  if (!request.missing_input && row._plan.needs_ownership_probe) {
    const ownershipProbe = await runOwnershipProbe(ctx, request);
    row.attempts += 1;
    if (!ownershipProbe.ok) probeFailures.push(`ownership wall failed: ${ownershipProbe.observed}`);
  }

  if (!request.missing_input && row._plan.needs_idempotency_probe && request.body) {
    const idempotencyProbe = await runIdempotencyProbe(ctx, request, result);
    row.attempts += 1;
    if (!idempotencyProbe.ok) probeFailures.push(`idempotency failed: ${idempotencyProbe.observed}`);
  }

  if (probeFailures.length > 0) {
    row.final = 'fail';
    row.reason = row.reason === 'ok' ? 'wrong_state' : row.reason;
    row.observed = shorten([row.observed, ...probeFailures].join(' | '), 240);
  }

  row.duration = `${Date.now() - started}ms`;
}

function summarizeRows(rows, runId, startedAt, finishedAt) {
  const counts = {
    total_routes: rows.length,
    pass_success: rows.filter((row) => row.final === 'pass_success').length,
    pass_guardrail: rows.filter((row) => row.final === 'pass_guardrail').length,
    fail: rows.filter((row) => row.final === 'fail').length,
    run_id: runId,
    started_at: startedAt,
    finished_at: finishedAt,
  };
  return counts;
}

function printFailureTable(rows) {
  const failed = rows.filter((row) => row.final === 'fail');
  if (failed.length === 0) return;
  const lines = [
    ['Route', 'Final', 'HTTP', 'Reason', 'Observed'],
    ...failed.map((row) => [row.route, row.final, `${row.http}`, row.reason, shorten(row.observed, 100)]),
  ];
  console.log('\nFailures\n');
  console.log(padConsoleTable(lines));
}

async function retrySafeTransientFailures(rows, ctx) {
  const candidates = rows.filter((row) =>
    row.final === 'fail'
    && isGatewayPressureStatus(Number(row.http))
    && SAFE_TRANSIENT_RETRY_ROUTE_KEYS.has(row.route));
  if (candidates.length === 0) return;

  await runWithConcurrency(candidates, 1, async (row) => {
    const fresh = createRow(row._route, row._plan);
    fresh.canonical_doc_path = row.canonical_doc_path;
    fresh.doc_step = row.doc_step;
    await executeRow(fresh, ctx);
    row.attempts += fresh.attempts;
    row.http = fresh.http;
    row.observed = fresh.observed;
    row.final = fresh.final;
    row.reason = fresh.reason;
    row.evidence = fresh.evidence;
    row.duration = fresh.duration;
    await sleep(REQUEST_GAP_MS);
  });
}

async function main() {
  const startedAt = nowIso();
  const inputs = loadLocalInputs();
  const docsBundle = await loadDocsDrivenManifest(inputs.base_url, {
    timeoutMs: inputs.timeouts.fetch_ms,
  });

  const rows = docsBundle.ordered_routes.map((route) => createRow(route, buildRoutePlan(route)));
  const missingDocPath = rows.filter((row) => !row.canonical_doc_path);
  for (const row of missingDocPath) {
    row.final = 'fail';
    row.reason = 'missing_doc_path';
    row.expected = 'route must have one canonical doc path';
    row.observed = 'manifest route has no canonical doc path';
    row.duration = '0ms';
  }

  const ctx = createSuiteContext(inputs, docsBundle, rows);
  const runnableRows = rows.filter((row) => row.reason !== 'missing_doc_path');

  await runWithConcurrency(runnableRows, WORKER_LIMIT, async (row) => {
    await executeRow(row, ctx);
    await sleep(REQUEST_GAP_MS);
  });

  await retrySafeTransientFailures(rows, ctx);

  const finishedAt = nowIso();
  const summary = summarizeRows(rows, ctx.runId, startedAt, finishedAt);
  const report = await writeHtmlReport({
    outputDir: inputs.report_dir,
    runId: ctx.runId,
    baseUrl: ctx.baseUrl,
    summary,
    rows,
  });

  const coverageRows = [
    ['Coverage', 'Count'],
    ['Manifest routes', `${summary.total_routes}`],
    ['pass_success', `${summary.pass_success}`],
    ['pass_guardrail', `${summary.pass_guardrail}`],
    ['fail', `${summary.fail}`],
  ];

  console.log(padConsoleTable(coverageRows));
  console.log(`\nLatest report: ${report.latest_path}`);
  printFailureTable(rows);

  if (summary.fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
