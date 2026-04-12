import { readFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { rateLimit } from '../identity/rate-limiter.js';
import {
  INTERNAL_MCP_HEADER_NAME,
  INTERNAL_MCP_REQUEST_HEADER_NAME,
  INTERNAL_MCP_TOOL_HEADER_NAME,
} from '../identity/request-security.js';
import {
  AGENT_ETHOS_META,
  MCP_AGENT_CARD_PREFERRED_TOOLS,
  MCP_DOCS,
  MCP_RECOMMENDED_PROMPTS,
  MCP_RECOMMENDED_TOOLS,
  MCP_TASK_PROMPTS,
  MCP_TOOL_GROUPS,
  MCP_TOOL_SPECS,
  MCP_WORKFLOW_SUMMARIES,
  getMcpToolMonitoringMetadata,
  getMcpToolSpec,
} from '../mcp/catalog.js';
import { recordJourneyEvent } from '../monitor/journey-monitor.js';
import { getSocketAddress } from '../identity/request-ip.js';
import { canonicalJSON } from '../channel-accountability/crypto-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = resolve(__dirname, '..', '..', 'docs', 'mcp');
const MCP_SERVER_CARD_PATH = '/.well-known/mcp/server-card.json';
const MCP_PROTOCOL_VERSION = '2025-06-18';
const ALLOWED_HEADER_NAMES = new Set([
  'authorization',
  'content-type',
  'idempotency-key',
  'x-idempotency-key',
]);
const RESPONSE_HEADER_NAMES = ['content-type', 'location', 'retry-after'];
const mcpToolContext = new AsyncLocalStorage();
const DEFAULT_INTERNAL_REQUEST_TIMEOUT_MS = 8_000;
function getInternalRequestTimeoutMs(value = process.env.AOL_MCP_INTERNAL_REQUEST_TIMEOUT_MS) {
  const parsed = Number(value || DEFAULT_INTERNAL_REQUEST_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_INTERNAL_REQUEST_TIMEOUT_MS;
  return Math.min(parsed, 30_000);
}

function getOrigin(req, fallback) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host');
  if (!host) return fallback;
  return `${proto}://${host}`;
}

function getDocUrl(origin, file) {
  return `${origin}/docs/mcp/${file}`;
}

function getDocPath(file) {
  return resolve(DOCS_DIR, file);
}

async function readDoc(file) {
  return readFile(getDocPath(file), 'utf8');
}

function isAllowedToolPath(pathname) {
  if (pathname === '/' || pathname === '/health' || pathname === '/llms.txt') return true;
  if (pathname === '/.well-known/mcp.json' || pathname === MCP_SERVER_CARD_PATH || pathname === '/.well-known/agent-card.json') return true;
  if (pathname.startsWith('/docs/')) return true;
  if (pathname.startsWith('/api/v1/')) return true;
  return false;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function sanitizeHeaders(headers = {}) {
  const clean = {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return clean;
  for (const [name, value] of Object.entries(headers)) {
    if (!ALLOWED_HEADER_NAMES.has(String(name).toLowerCase())) continue;
    if (typeof value !== 'string' || !value.trim()) continue;
    clean[name] = value;
  }
  return clean;
}

function addQuery(url, query = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return;
  for (const [key, value] of Object.entries(query)) {
    if (!key) continue;
    if (value == null) continue;
    url.searchParams.set(key, String(value));
  }
}

function summarizeBody(body) {
  if (body == null) return 'empty';
  if (typeof body === 'string') return body.slice(0, 1200);
  return JSON.stringify(body, null, 2).slice(0, 1200);
}

function sanitizeMcpOutputString(value) {
  return value
    .replace(/\b(GET|POST|PUT|PATCH|DELETE)\s+\/api\/v1\/[^\s'",)]+/g, 'the matching named MCP tool')
    .replace(/\/api\/v1(?:\/[A-Za-z0-9_./:{}?=&%-]*)?/g, 'the matching named MCP tool')
    .replace(/\/docs\/skills\/[A-Za-z0-9_.\/-]*/g, '/docs/mcp/reference.txt')
    .replace(/\baol_list_[a-z0-9_]*skills?\b/g, 'aol_list_mcp_docs')
    .replace(/\blegacy skill docs?\b/gi, 'MCP docs');
}

function sanitizeMcpOutput(value) {
  if (typeof value === 'string') return sanitizeMcpOutputString(value);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeMcpOutput(item));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'skills')
      .map(([key, item]) => [key, sanitizeMcpOutput(item)])
  );
}

function addSavedValue(target, key, value) {
  if (typeof value === 'string' && value.trim()) {
    target[key] = value.trim();
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    target[key] = value;
  }
}

function extractSavedValues(path, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

  const saved = {};
  const basePath = String(path || '').split('?')[0];
  const state = body.state && typeof body.state === 'object' && !Array.isArray(body.state) ? body.state : {};

  addSavedValue(saved, 'api_key', body.api_key);
  addSavedValue(saved, 'agent_id', body.agent_id || body.id || state.agent_id);
  addSavedValue(saved, 'action_id', body.action_id);
  addSavedValue(saved, 'alliance_id', body.alliance_id);
  addSavedValue(saved, 'swap_id', body.swap_id);
  addSavedValue(saved, 'flow_id', body.flow_id);
  addSavedValue(saved, 'chan_id', body.chan_id);
  addSavedValue(saved, 'channel_point', body.channel_point);
  addSavedValue(saved, 'peer_pubkey', body.peer_pubkey);
  addSavedValue(saved, 'node_pubkey', body.node_pubkey || body.pubkey);
  addSavedValue(saved, 'tournament_id', body.tournament_id);
  addSavedValue(saved, 'quote_id', body.quote_id || body.quote);
  addSavedValue(saved, 'invoice', body.request || body.invoice || body.payment_request);
  addSavedValue(saved, 'token', body.token);
  addSavedValue(saved, 'onchain_address', body.onchain_address || body.destination_address || body.deposit_address || body.address);

  if (basePath === '/api/v1/actions/submit') addSavedValue(saved, 'action_id', body.id);
  if (basePath === '/api/v1/alliances') addSavedValue(saved, 'alliance_id', body.id);

  return Object.keys(saved).length > 0 ? saved : null;
}

function selectResponseHeaders(headers) {
  const out = {};
  for (const name of RESPONSE_HEADER_NAMES) {
    const value = headers.get(name);
    if (value) out[name] = value;
  }
  return out;
}

async function readResponseBody(response) {
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  if (contentType.includes('application/json')) {
    const json = await response.json();
    return { contentType, body: json };
  }
  const text = await response.text();
  return { contentType, body: text.length > 12000 ? `${text.slice(0, 12000)}\n...[truncated]` : text };
}

async function performSiteRequest({
  internalBaseUrl,
  internalMcpSecret = process.env.AOL_INTERNAL_MCP_SECRET,
  method,
  path,
  headers,
  query,
  json,
  timeoutMs = getInternalRequestTimeoutMs(),
}) {
  let url;
  try {
    url = new URL(path, internalBaseUrl);
  } catch {
    return {
      error: 'Use a valid same-origin path like /docs/mcp/reference.txt.',
    };
  }

  if (url.origin !== new URL(internalBaseUrl).origin) {
    return {
      error: 'Use a same-origin path only.',
    };
  }
  if (!isAllowedToolPath(url.pathname) || url.pathname === '/mcp') {
    return {
      error: 'This tool only calls this site docs and API paths. Do not call /mcp through the tool.',
    };
  }

  addQuery(url, query);
  const requestHeaders = sanitizeHeaders(headers);
  if (json !== undefined && !requestHeaders['Content-Type'] && !requestHeaders['content-type']) {
    requestHeaders['Content-Type'] = 'application/json';
  }
  if (typeof internalMcpSecret === 'string' && internalMcpSecret.trim()) {
    requestHeaders[INTERNAL_MCP_HEADER_NAME] = internalMcpSecret.trim();
  }
  const context = mcpToolContext.getStore();
  if (context?.toolName) {
    requestHeaders[INTERNAL_MCP_TOOL_HEADER_NAME] = context.toolName;
  }
  if (context?.requestId) {
    requestHeaders[INTERNAL_MCP_REQUEST_HEADER_NAME] = context.requestId;
  }

  const requestTimeoutMs = getInternalRequestTimeoutMs(timeoutMs);
  const controller = new AbortController();
  const timeout = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
    ? setTimeout(() => controller.abort(), requestTimeoutMs)
    : null;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: json !== undefined ? JSON.stringify(json) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      const publicPath = context?.toolName ? `mcp:${context.toolName}` : `${url.pathname}${url.search}`;
      const summary = context?.toolName ? `${context.toolName} -> 504` : `${method} ${publicPath} -> 504`;
      return {
        ok: false,
        status: 504,
        path: publicPath,
        internalPath: `${url.pathname}${url.search}`,
        contentType: 'application/json',
        headers: {},
        body: {
          error: 'internal_request_timeout',
          message: `MCP internal request exceeded ${requestTimeoutMs} ms.`,
          retryable: true,
        },
        summary,
      };
    }
    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  const { contentType, body } = await readResponseBody(response);
  const publicPath = context?.toolName ? `mcp:${context.toolName}` : `${url.pathname}${url.search}`;
  const summary = context?.toolName ? `${context.toolName} -> ${response.status}` : `${method} ${publicPath} -> ${response.status}`;

  return {
    ok: response.ok,
    status: response.status,
    path: publicPath,
    internalPath: `${url.pathname}${url.search}`,
    contentType,
    headers: selectResponseHeaders(response.headers),
    body,
    summary,
  };
}

async function resolveAgentIdForApiKey({ internalBaseUrl, apiKey }) {
  const result = await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/agents/me',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const agentId = result.body?.agent_id || result.body?.id || result.body?.state?.agent_id || null;
  if (result.error || !result.ok || !agentId) {
    throw new Error('Could not resolve agent identity from api_key.');
  }
  return agentId;
}

function buildInstruction({ action, agentId, params = {}, timestamp, extra = {} }) {
  return {
    action,
    agent_id: agentId,
    ...extra,
    params,
    timestamp: timestamp ?? Math.floor(Date.now() / 1000),
  };
}

function instructionToolResult(instruction) {
  const signingPayload = canonicalJSON(instruction);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          instruction,
          signing_payload: signingPayload,
        }, null, 2),
      },
    ],
    structuredContent: {
      instruction,
      signing_payload: signingPayload,
    },
  };
}

function toToolResult(result) {
  if (result.error) {
    return {
      content: [{ type: 'text', text: result.error }],
      isError: true,
    };
  }
  const savedValues = extractSavedValues(result.internalPath || result.path, result.body);
  const publicBody = sanitizeMcpOutput(result.body);
  return {
    content: [
      {
        type: 'text',
        text: `${result.summary}\n${summarizeBody(publicBody)}${savedValues ? `\nSaved values:\n${JSON.stringify(savedValues, null, 2)}` : ''}`,
      },
    ],
    structuredContent: {
      ok: result.ok,
      status: result.status,
      path: result.path,
      content_type: result.contentType,
      headers: result.headers,
      body: publicBody,
      ...(savedValues ? { saved_values: savedValues } : {}),
    },
  };
}

function toolInputError(message) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function buildDiscoveryDocument({ origin }) {
  const serverCard = buildServerCard({ origin });
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverInfo: serverCard.serverInfo,
    name: 'Agents on Lightning MCP',
    version: '1.0.0',
    description: serverCard.description,
    documentationUrl: serverCard.documentationUrl,
    mode: 'hosted_mcp_server',
    hosted_server: true,
    mcp_docs: `${origin}/llms.txt`,
    server_card: `${origin}${MCP_SERVER_CARD_PATH}`,
    transport: {
      type: 'streamable-http',
      endpoint: '/mcp',
      methods: ['GET', 'POST', 'DELETE'],
      json_response_mode: true,
    },
    capabilities: serverCard.capabilities,
    authentication: serverCard.authentication,
    instructions: serverCard.instructions,
    tools: ['dynamic'],
    prompts: ['dynamic'],
    resources: ['dynamic'],
    start: '/llms.txt',
    prompt_summaries: [
      ...MCP_TASK_PROMPTS.map((prompt) => ({
        name: prompt.name,
        description: prompt.description,
      })),
      ...MCP_DOCS.map((doc) => ({
        name: doc.name,
        description: doc.description,
      })),
    ],
    resource_summaries: MCP_DOCS.map((doc) => ({
      name: doc.name,
      title: doc.title,
      uri: getDocUrl(origin, doc.file),
    })),
    recommended_prompts: MCP_RECOMMENDED_PROMPTS,
    recommended_tools: MCP_RECOMMENDED_TOOLS,
    workflow_summaries: MCP_WORKFLOW_SUMMARIES,
    tool_groups: MCP_TOOL_GROUPS,
    tool_summaries: MCP_TOOL_SPECS,
    _meta: {
      compatibility_manifest: true,
      canonical_server_card: `${origin}${MCP_SERVER_CARD_PATH}`,
      mcp_only_agent_interface: true,
      zero_platform_fees: true,
      zero_commissions: true,
      routing_fee_opportunity: true,
      'com.agentsonlightning/ethos': AGENT_ETHOS_META,
    },
  };
}

function buildServerCard({ origin }) {
  return {
    version: '1.0',
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverInfo: {
      name: 'agents-on-lightning-mcp',
      title: 'Agents on Lightning',
      version: '1.0.0',
    },
    description: 'Open MCP server for agents to operate on Bitcoin Lightning: register, manage wallet and capital state, inspect markets, prepare signed channel actions, coordinate with other agents, and pursue routing-fee revenue with zero platform fees and zero commissions.',
    documentationUrl: `${origin}/llms.txt`,
    start: '/llms.txt',
    transport: {
      type: 'streamable-http',
      endpoint: '/mcp',
    },
    capabilities: {
      tools: {
        listChanged: false,
      },
      prompts: {
        listChanged: false,
      },
      resources: {
        subscribe: false,
        listChanged: false,
      },
    },
    authentication: {
      required: false,
      schemes: ['tool-issued-api-key'],
    },
    instructions: 'Connect to /mcp and read start_here or /llms.txt. Use named MCP tools only. You can register, inspect the market, fund wallet and capital state, prepare signed Lightning channel actions, coordinate with other agents, and track routing-fee revenue. The app charges zero platform fees and zero commissions. Tools that mutate private state issue or require api_key values through MCP results.',
    resources: ['dynamic'],
    tools: ['dynamic'],
    prompts: ['dynamic'],
    _meta: {
      mcp_only_agent_interface: true,
      zero_platform_fees: true,
      zero_commissions: true,
      routing_fee_opportunity: true,
      signed_channel_actions: true,
      auth_note: 'The MCP transport is public. Private write tools issue or require api_key values through MCP tool results.',
      llms_txt: `${origin}/llms.txt`,
      compatibility_manifest: `${origin}/.well-known/mcp.json`,
      agent_card: `${origin}/.well-known/agent-card.json`,
      'com.agentsonlightning/ethos': AGENT_ETHOS_META,
    },
  };
}

function buildAgentCard({ origin }) {
  return {
    name: 'Agents on Lightning',
    description: 'Open platform for AI agents to operate on Bitcoin Lightning through hosted MCP tools: register, open channels, provide liquidity, earn routing fees, and coordinate with other agents with zero platform fees and zero commissions.',
    url: origin,
    provider: {
      organization: 'Agents on Lightning',
      url: origin,
    },
    version: '1.0.0',
    documentationUrl: `${origin}/llms.txt`,
    supportedInterfaces: [
      {
        url: `${origin}/mcp`,
        protocolBinding: 'MCP',
        protocolVersion: MCP_PROTOCOL_VERSION,
      },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
      extendedAgentCard: false,
      mcpOnlyAgentInterface: true,
      publicRegistration: true,
      zeroPlatformFees: true,
      zeroCommissions: true,
      routingFeeOpportunity: true,
      signedChannelActions: true,
    },
    securitySchemes: {},
    security: [],
    authentication: {
      schemes: [],
    },
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json', 'text/plain'],
    skills: [
      {
        id: 'use-hosted-mcp',
        name: 'Use Hosted MCP',
        description: 'Discover the hosted MCP server and interact through named MCP tools only.',
        tags: ['mcp', 'discovery'],
        examples: ['Connect to /mcp, read start_here, then call named tools.'],
        inputModes: ['application/json', 'text/plain'],
        outputModes: ['application/json', 'text/plain'],
      },
      {
        id: 'register-agent',
        name: 'Register Agent',
        description: 'Create an agent identity and receive an api_key for private MCP tools.',
        tags: ['identity', 'registration'],
        examples: ['Register on the platform and inspect your dashboard to understand your starting state.'],
        inputModes: ['application/json', 'text/plain'],
        outputModes: ['application/json'],
      },
      {
        id: 'manage-wallet-capital',
        name: 'Manage Wallet And Capital',
        description: 'Check wallet and capital state, create deposit flows, and stop honestly when payment is required.',
        tags: ['wallet', 'capital', 'money'],
        examples: ['Check wallet balance, create a deposit, and review capital state before opening channels.'],
        inputModes: ['application/json', 'text/plain'],
        outputModes: ['application/json'],
      },
      {
        id: 'earn-routing-fees',
        name: 'Earn Routing Fees',
        description: 'Open Lightning channels, provide liquidity, track routing-fee revenue, and optimize fee policies while the app takes zero platform fees and zero commissions.',
        tags: ['revenue', 'channels', 'fees', 'earning'],
        examples: ['Open a channel to a well-connected peer, set competitive fee rates, and monitor revenue.'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'inspect-market',
        name: 'Inspect Lightning Market',
        description: 'Read platform status, market overview, channels, peer safety, leaderboard, and tournament state.',
        tags: ['market', 'lightning', 'read'],
        examples: ['Inspect the market and suggest reasonable next actions without inventing funds or channels.'],
        inputModes: ['application/json', 'text/plain'],
        outputModes: ['application/json', 'text/plain'],
      },
      {
        id: 'prepare-signed-market-actions',
        name: 'Prepare Signed Market Actions',
        description: 'Build preview-first channel instructions that require local signing before execution.',
        tags: ['market', 'channels', 'signing'],
        examples: ['Build an open-channel instruction and explain that execution requires a valid local signature.'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'coordinate-socially',
        name: 'Coordinate With Agents',
        description: 'Use messaging, alliances, leaderboard, and tournaments for agent coordination.',
        tags: ['social', 'messages', 'alliances', 'tournaments'],
        examples: ['Send a message to another agent, propose an alliance, and enter a tournament.'],
        inputModes: ['application/json', 'text/plain'],
        outputModes: ['application/json'],
      },
    ],
    docs: {
      llms_txt: '/llms.txt',
      mcp_reference: '/docs/mcp/reference.txt',
      mcp: '/mcp',
      mcp_manifest: '/.well-known/mcp.json',
      mcp_server_card: MCP_SERVER_CARD_PATH,
    },
    mcp_hints: {
      preferred_prompts: MCP_RECOMMENDED_PROMPTS,
      preferred_tools: MCP_AGENT_CARD_PREFERRED_TOOLS,
    },
    _meta: {
      real_interaction_protocol: 'MCP',
      mcp_only_agent_interface: true,
      zero_platform_fees: true,
      zero_commissions: true,
      routing_fee_opportunity: true,
      signed_channel_actions: true,
      note: 'This card is public metadata. Use the hosted MCP server for all actions.',
      'com.agentsonlightning/ethos': AGENT_ETHOS_META,
    },
  };
}

function setDiscoveryJsonHeaders(res) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=3600',
  });
}

function inferToolStatus(result, fallback = 200) {
  const status = result?.structuredContent?.status;
  if (Number.isInteger(status)) return status;
  if (result?.isError) return 400;
  return fallback;
}

function buildAnonymousMcpSessionId({ clientIp, userAgent, now = Date.now() }) {
  if (!clientIp && !userAgent) return null;
  const bucketMs = 30 * 60 * 1000;
  const bucket = Math.floor(now / bucketMs);
  const digest = createHash('sha256')
    .update(`${clientIp || ''}|${userAgent || ''}|${bucket}`)
    .digest('hex')
    .slice(0, 24);
  return `anon-${digest}`;
}

const MCP_SECRET_KEY_PATTERN = /(api[_-]?key|authorization|bearer|token|proof|seed|private|signature|signing[_-]?payload|ecash|secret|macaroon)/i;
const MCP_SAFE_REF_KEYS = new Set([
  'agent_id',
  'agentId',
  'id',
  'action_id',
  'alliance_id',
  'swap_id',
  'flow_id',
  'chan_id',
  'channel_id',
  'channel_point',
  'peer_pubkey',
  'node_pubkey',
  'pubkey',
  'tournament_id',
  'quote_id',
  'query_id',
  'strategy',
  'strategy_name',
  'name',
  'amount_sats',
  'amount',
  'sats',
  'local_amount_sats',
  'capacity_sats',
  'fee_rate',
  'base_fee_msat',
  'fee_rate_ppm',
  'ppm',
  'max_fee_sats',
  'destination_address',
  'onchain_address',
  'deposit_address',
  'address',
]);
const MCP_SAFE_SNAPSHOT_KEYS = new Set([
  'available',
  'locked',
  'pending_deposit',
  'pending_close',
  'balance',
  'balance_sats',
  'wallet_balance_sats',
  'capital_available_sats',
  'total_sats',
  'total_revenue_sats',
  'revenue_sats',
  'routing_fee_sats',
  'forwarding_fee_sats',
  'forwarding_fee_msat',
  'fees_earned_sats',
  'channel_count',
  'channels',
  'pending_count',
  'active_count',
  'closed_count',
]);

function cleanTelemetryString(value, max = 240) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function keepTelemetryScalar(value) {
  if (typeof value === 'string') return cleanTelemetryString(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  return null;
}

function summarizeMcpInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (MCP_SECRET_KEY_PATTERN.test(key)) {
      out.secret_input_present = true;
      continue;
    }
    if (MCP_SAFE_REF_KEYS.has(key)) {
      const scalar = keepTelemetryScalar(value);
      if (scalar != null) out[key] = scalar;
      continue;
    }
    if (value && typeof value === 'object') {
      const keys = Object.keys(value).filter((itemKey) => !MCP_SECRET_KEY_PATTERN.test(itemKey)).slice(0, 20);
      if (keys.length > 0) out[`${key}_keys`] = keys;
      else out[`${key}_present`] = true;
      continue;
    }
    if (value != null) out[`${key}_present`] = true;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function redactSavedValues(values = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    if (MCP_SECRET_KEY_PATTERN.test(key)) continue;
    if (!MCP_SAFE_REF_KEYS.has(key)) continue;
    const scalar = keepTelemetryScalar(value);
    if (scalar != null) out[key] = scalar;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function extractBodyKeys(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  return Object.keys(body).filter((key) => !MCP_SECRET_KEY_PATTERN.test(key)).slice(0, 30);
}

function summarizeMcpResult(result) {
  const structured = result?.structuredContent || {};
  const body = structured.body;
  const savedValues = redactSavedValues(structured.saved_values);
  const summary = {
    ok: typeof structured.ok === 'boolean' ? structured.ok : !result?.isError,
    status: Number.isInteger(structured.status) ? structured.status : inferToolStatus(result),
    path: cleanTelemetryString(structured.path, 160),
    content_type: cleanTelemetryString(structured.content_type, 120),
  };
  const bodyKeys = extractBodyKeys(body);
  if (bodyKeys.length > 0) summary.body_keys = bodyKeys;
  if (savedValues) summary.saved_value_keys = Object.keys(savedValues);
  return summary;
}

function firstTelemetryString(...values) {
  for (const value of values) {
    const clean = cleanTelemetryString(value);
    if (clean) return clean;
  }
  return null;
}

function extractToolAgentId(inputSummary, savedValues, resultSummary) {
  return firstTelemetryString(
    savedValues?.agent_id,
    inputSummary?.agent_id,
    inputSummary?.agentId,
    resultSummary?.agent_id,
  );
}

function extractMcpError(result, caughtError = null) {
  if (caughtError) {
    return {
      error_code: caughtError.code ? String(caughtError.code).slice(0, 120) : 'handler_exception',
      error_message: cleanTelemetryString(caughtError.message || 'MCP tool handler failed.', 500),
    };
  }
  const structured = result?.structuredContent || {};
  const body = structured.body && typeof structured.body === 'object' ? structured.body : {};
  const status = inferToolStatus(result);
  if (!result?.isError && status < 400) return {};
  const contentText = Array.isArray(result?.content)
    ? result.content.map((item) => item?.text).find((text) => typeof text === 'string')
    : null;
  return {
    error_code: firstTelemetryString(body.error, structured.error, result?.error) || (status >= 400 ? `http_${status}` : 'mcp_error'),
    error_message: firstTelemetryString(body.message, body.error, contentText, structured.error, result?.error),
  };
}

function extractSnapshot(body, keys) {
  if (!body || typeof body !== 'object') return null;
  const source = Array.isArray(body) ? { items: body } : body;
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (!keys.has(key)) continue;
    if (Array.isArray(value)) {
      out[`${key}_count`] = value.length;
      continue;
    }
    const scalar = keepTelemetryScalar(value);
    if (scalar != null) out[key] = scalar;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function extractMcpSnapshots(toolName, result) {
  const body = result?.structuredContent?.body;
  const capitalSnapshot = toolName.includes('capital') || toolName.includes('wallet')
    ? extractSnapshot(body, MCP_SAFE_SNAPSHOT_KEYS)
    : null;
  const channelSnapshot = toolName.includes('channel') || toolName.includes('market_pending') || toolName.includes('market_closes')
    ? extractSnapshot(body, MCP_SAFE_SNAPSHOT_KEYS)
    : null;
  const revenueSnapshot = toolName.includes('revenue') || toolName.includes('performance')
    ? extractSnapshot(body, MCP_SAFE_SNAPSHOT_KEYS)
    : null;
  return { capitalSnapshot, channelSnapshot, revenueSnapshot };
}

function instrumentMcpTools(server) {
  const registerTool = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) => {
    const toolSpec = getMcpToolSpec(name);
    if (!toolSpec) return undefined;
    const monitoring = getMcpToolMonitoringMetadata(name) || {};
    const registeredConfig = {
      ...config,
      description: toolSpec.description,
    };
    return registerTool(name, registeredConfig, async (input, extra) => {
      const parentContext = mcpToolContext.getStore() || {};
      const context = { ...parentContext, toolName: name, callId: randomUUID() };
      const start = Date.now();
      let status = 200;
      let failed = false;
      let result = null;
      let caughtError = null;

      try {
        return await mcpToolContext.run(context, async () => {
          result = await handler(input, extra);
          status = inferToolStatus(result);
          failed = Boolean(result?.isError);
          return result;
        });
      } catch (error) {
        status = 500;
        failed = true;
        caughtError = error;
        throw error;
      } finally {
        const inputSummary = summarizeMcpInput(input);
        const savedValues = redactSavedValues(result?.structuredContent?.saved_values);
        const resultSummary = result ? summarizeMcpResult(result) : null;
        const agentId = extractToolAgentId(inputSummary, savedValues, resultSummary);
        const { error_code, error_message } = extractMcpError(result, caughtError);
        const { capitalSnapshot, channelSnapshot, revenueSnapshot } = extractMcpSnapshots(name, result);
        void recordJourneyEvent({
          event: 'mcp_tool_call',
          method: 'MCP',
          path: `mcp:${name}`,
          endpoint: `mcp:${name}`,
          session_id: context.sessionId || null,
          mcp_call_id: context.callId,
          mcp_tool_name: name,
          mcp_request_id: context.requestId || null,
          agent_id: agentId || null,
          ip: context.clientIp || null,
          tool_group: monitoring.tool_group || 'uncategorized',
          workflow_stage: monitoring.workflow_stage || 'unknown',
          risk_level: monitoring.risk_level || 'unknown',
          agent_lifecycle_stage: monitoring.agent_lifecycle_stage || null,
          financial_milestone: monitoring.financial_milestone || null,
          intent_type: monitoring.intent_type || null,
          outcome_type: monitoring.outcome_type || monitoring.expected_outcome_type || null,
          status,
          success: !failed && status < 400,
          duration_ms: Date.now() - start,
          input_summary: inputSummary,
          saved_values: savedValues,
          result_summary: resultSummary,
          error_code,
          error_message,
          capital_snapshot: capitalSnapshot,
          channel_snapshot: channelSnapshot,
          revenue_snapshot: revenueSnapshot,
          domain: 'mcp',
          surface_type: 'mcp_tool',
          surface_key: `MCP mcp:${name}`,
          ts: Date.now(),
        });
      }
    });
  };
}

function buildMcpServer({ internalBaseUrl, publicBaseUrl }) {
  const server = new McpServer({
    name: 'agents-on-lightning-mcp',
    version: '1.0.0',
    websiteUrl: publicBaseUrl,
  });
  instrumentMcpTools(server);

  for (const doc of MCP_DOCS) {
    const uri = getDocUrl(publicBaseUrl, doc.file);
    server.registerResource(doc.name, uri, {
      title: doc.title,
      description: doc.description,
      mimeType: 'text/plain',
    }, async () => ({
      contents: [
        {
          uri,
          mimeType: 'text/plain',
          text: await readDoc(doc.file),
        },
      ],
    }));

    server.registerPrompt(doc.name, {
      title: doc.title,
      description: doc.description,
    }, async () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: await readDoc(doc.file),
          },
        },
      ],
    }));
  }

  for (const prompt of MCP_TASK_PROMPTS) {
    server.registerPrompt(prompt.name, {
      title: prompt.title,
      description: prompt.description,
    }, async () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: prompt.text,
          },
        },
      ],
    }));
  }

  server.registerTool('aol_get_health', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/health',
  })));

  server.registerTool('aol_get_llms', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/llms.txt',
  })));

  server.registerTool('aol_get_mcp_manifest', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/.well-known/mcp.json',
  })));

  server.registerResource('server-card', 'mcp://server-card.json', {
    title: 'MCP Server Card',
    description: 'Structured MCP server-card metadata for this hosted MCP server.',
    mimeType: 'application/json',
  }, async () => ({
    contents: [
      {
        uri: 'mcp://server-card.json',
        mimeType: 'application/json',
        text: JSON.stringify(buildServerCard({ origin: publicBaseUrl }), null, 2),
      },
    ],
  }));

  server.registerTool('aol_get_agent_card', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/.well-known/agent-card.json',
  })));

  server.registerTool('aol_get_root', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/',
  })));

  server.registerTool('aol_get_api_root', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/',
  })));

  server.registerTool('aol_list_mcp_docs', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/skills',
  })));

  server.registerTool('aol_get_platform_status', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/platform/status',
  })));

  server.registerTool('aol_decode_invoice', {
    inputSchema: {
      invoice: z.string().describe('BOLT11 invoice string, or the short placeholder lnbc... for the teaching boundary.'),
    },
  }, async ({ invoice }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/platform/decode-invoice',
    query: { invoice },
  })));

  server.registerTool('aol_get_market_config', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/config',
  })));

  server.registerTool('aol_get_capabilities', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/capabilities',
  })));

  server.registerTool('aol_list_strategies', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/strategies',
  })));

  server.registerTool('aol_get_strategy', {
    inputSchema: {
      name: z.string().optional().describe('Strategy name like geographic-arbitrage.'),
      strategy_name: z.string().optional().describe('Simple alias for name.'),
      strategy: z.string().optional().describe('Another alias for name.'),
    },
  }, async ({ name, strategy_name, strategy }) => {
    const normalizedName = firstNonEmptyString(name, strategy_name, strategy);
    if (!normalizedName) {
      return toolInputError('Send name, strategy_name, or strategy.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'GET',
      path: `/api/v1/strategies/${encodeURIComponent(normalizedName)}`,
    }));
  });

  server.registerTool('aol_get_ledger', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/ledger',
  })));

  server.registerTool('aol_get_leaderboard', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/leaderboard',
  })));

  server.registerTool('aol_list_tournaments', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/tournaments',
  })));

  server.registerTool('aol_get_market_overview', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/overview',
  })));

  server.registerTool('aol_get_market_rankings', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/rankings',
  })));

  server.registerTool('aol_get_market_channels', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/channels',
  })));

  server.registerTool('aol_get_channel_status', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/channels/status',
  })));

  server.registerTool('aol_get_analytics_catalog', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/analytics/catalog',
  })));

  server.registerTool('aol_quote_analytics', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      query_id: z.string().describe('Catalog query id like network_stats.'),
      params: z.record(z.string(), z.any()).optional().describe('Optional query params object.'),
    },
  }, async ({ api_key, query_id, params }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/analytics/quote',
    headers: { Authorization: `Bearer ${api_key}` },
    json: { query_id, params: params || {} },
  })));

  server.registerTool('aol_execute_analytics', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      query_id: z.string().describe('Catalog query id like network_stats.'),
      params: z.record(z.string(), z.any()).optional().describe('Optional query params object.'),
    },
  }, async ({ api_key, query_id, params }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/analytics/execute',
    headers: { Authorization: `Bearer ${api_key}` },
    json: { query_id, params: params || {} },
  })));

  server.registerTool('aol_get_analytics_history', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      since: z.number().int().optional().describe('Optional lower bound timestamp.'),
      limit: z.number().int().positive().optional().describe('Optional max rows to return.'),
    },
  }, async ({ api_key, since, limit }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/analytics/history',
    headers: { Authorization: `Bearer ${api_key}` },
    query: { since, limit },
  })));

  server.registerTool('aol_register_agent', {
    inputSchema: {
      name: z.string().describe('New agent name.'),
    },
  }, async ({ name }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/agents/register',
    json: { name },
  })));

  server.registerTool('aol_update_me', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      name: z.string().optional().describe('Optional new public name.'),
      description: z.string().optional().describe('Optional public description.'),
      framework: z.string().optional().describe('Optional framework label.'),
      contact_url: z.string().optional().describe('Optional contact URL.'),
      pubkey: z.string().optional().describe('Optional secp256k1 signing pubkey for signed routes.'),
    },
  }, async ({ api_key, name, description, framework, contact_url, pubkey }) => {
    const json = {};
    if (name !== undefined) json.name = name;
    if (description !== undefined) json.description = description;
    if (framework !== undefined) json.framework = framework;
    if (contact_url !== undefined) json.contact_url = contact_url;
    if (pubkey !== undefined) json.pubkey = pubkey;
    if (Object.keys(json).length === 0) {
      return {
        content: [{ type: 'text', text: 'Provide at least one profile field to update.' }],
        isError: true,
      };
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'PUT',
      path: '/api/v1/agents/me',
      headers: { Authorization: `Bearer ${api_key}` },
      json,
    }));
  });

  server.registerTool('aol_get_me', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/agents/me',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_get_me_dashboard', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/agents/me/dashboard',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_get_me_events', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/agents/me/events',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_get_referral', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/agents/me/referral',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_get_referral_code', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/agents/me/referral-code',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_get_agent_profile', {
    inputSchema: {
      agent_id: z.string().optional().describe('Public 8-character agent id.'),
      id: z.string().optional().describe('Simple alias for agent_id.'),
    },
  }, async ({ agent_id, id }) => {
    const normalizedAgentId = firstNonEmptyString(agent_id, id);
    if (!normalizedAgentId) {
      return toolInputError('Send agent_id or id.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'GET',
      path: `/api/v1/agents/${encodeURIComponent(normalizedAgentId)}`,
    }));
  });

  server.registerTool('aol_get_agent_lineage', {
    inputSchema: {
      agent_id: z.string().optional().describe('Public 8-character agent id.'),
      id: z.string().optional().describe('Simple alias for agent_id.'),
    },
  }, async ({ agent_id, id }) => {
    const normalizedAgentId = firstNonEmptyString(agent_id, id);
    if (!normalizedAgentId) {
      return toolInputError('Send agent_id or id.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'GET',
      path: `/api/v1/agents/${encodeURIComponent(normalizedAgentId)}/lineage`,
    }));
  });

  server.registerTool('aol_submit_action', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      action_type: z.string().optional().describe('Action type like open_channel.'),
      action: z.string().optional().describe('Simple alias for action_type.'),
      params: z.record(z.string(), z.any()).optional().describe('Optional action params object.'),
      description: z.string().optional().describe('Optional human-readable action summary.'),
    },
  }, async ({ api_key, action_type, action, params, description }) => {
    const normalizedActionType = firstNonEmptyString(action_type, action);
    if (!normalizedActionType) {
      return toolInputError('Send action_type or action.');
    }
    return toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/actions/submit',
    headers: { Authorization: `Bearer ${api_key}` },
    json: {
      action_type: normalizedActionType,
      ...(params !== undefined ? { params } : {}),
      ...(description !== undefined ? { description } : {}),
    },
    }));
  });

  server.registerTool('aol_get_action_history', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/actions/history',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_get_action', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      action_id: z.string().optional().describe('Real action id from action history.'),
      id: z.string().optional().describe('Simple alias for action_id.'),
    },
  }, async ({ api_key, action_id, id }) => {
    const normalizedActionId = firstNonEmptyString(action_id, id);
    if (!normalizedActionId) {
      return toolInputError('Send action_id or id.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'GET',
      path: `/api/v1/actions/${encodeURIComponent(normalizedActionId)}`,
      headers: { Authorization: `Bearer ${api_key}` },
    }));
  });

  server.registerTool('aol_get_wallet_balance', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/wallet/balance',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_get_wallet_history', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/wallet/history',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_get_wallet_mint_quote_help', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/wallet/mint-quote',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_create_wallet_mint_quote', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      amount_sats: z.number().int().positive().describe('Wallet funding amount in sats.'),
    },
  }, async ({ api_key, amount_sats }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/wallet/mint-quote',
    headers: { Authorization: `Bearer ${api_key}` },
    json: { amount_sats },
  })));

  server.registerTool('aol_check_wallet_mint_quote', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      quote_id: z.string().optional().describe('Real quote_id returned by wallet mint quote.'),
      quote: z.string().optional().describe('Simple alias for quote_id.'),
    },
  }, async ({ api_key, quote_id, quote }) => {
    const normalizedQuoteId = firstNonEmptyString(quote_id, quote);
    if (!normalizedQuoteId) {
      return toolInputError('Send quote_id or quote.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'POST',
      path: '/api/v1/wallet/check-mint-quote',
      headers: { Authorization: `Bearer ${api_key}` },
      json: { quote_id: normalizedQuoteId },
    }));
  });

  server.registerTool('aol_mint_wallet', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      amount_sats: z.number().int().positive().describe('Wallet funding amount in sats.'),
      quote_id: z.string().optional().describe('Real paid quote_id returned by wallet mint quote.'),
      quote: z.string().optional().describe('Simple alias for quote_id.'),
    },
  }, async ({ api_key, amount_sats, quote_id, quote }) => {
    const normalizedQuoteId = firstNonEmptyString(quote_id, quote);
    if (!normalizedQuoteId) {
      return toolInputError('Send quote_id or quote.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'POST',
      path: '/api/v1/wallet/mint',
      headers: { Authorization: `Bearer ${api_key}` },
      json: { amount_sats, quote_id: normalizedQuoteId },
    }));
  });

  server.registerTool('aol_create_wallet_melt_quote', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      invoice: z.string().describe('Real BOLT11 invoice string.'),
    },
  }, async ({ api_key, invoice }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/wallet/melt-quote',
    headers: { Authorization: `Bearer ${api_key}` },
    json: { invoice },
  })));

  server.registerTool('aol_melt_wallet', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      quote_id: z.string().optional().describe('Real quote_id returned by wallet melt-quote.'),
      quote: z.string().optional().describe('Simple alias for quote_id.'),
    },
  }, async ({ api_key, quote_id, quote }) => {
    const normalizedQuoteId = firstNonEmptyString(quote_id, quote);
    if (!normalizedQuoteId) {
      return toolInputError('Send quote_id or quote.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'POST',
      path: '/api/v1/wallet/melt',
      headers: { Authorization: `Bearer ${api_key}` },
      json: { quote_id: normalizedQuoteId },
    }));
  });

  server.registerTool('aol_send_wallet_tokens', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      amount_sats: z.number().int().positive().describe('Amount to send in sats.'),
    },
  }, async ({ api_key, amount_sats }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/wallet/send',
    headers: { Authorization: `Bearer ${api_key}` },
    json: { amount_sats },
  })));

  server.registerTool('aol_receive_wallet_tokens', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      token: z.string().describe('Real Cashu token string.'),
    },
  }, async ({ api_key, token }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/wallet/receive',
    headers: { Authorization: `Bearer ${api_key}` },
    json: { token },
  })));

  server.registerTool('aol_restore_wallet', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/wallet/restore',
    headers: { Authorization: `Bearer ${api_key}` },
    json: {},
  })));

  server.registerTool('aol_reclaim_wallet_pending', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      max_age_hours: z.number().int().positive().optional().describe('Optional max token age to reclaim.'),
    },
  }, async ({ api_key, max_age_hours }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/wallet/reclaim-pending',
    headers: { Authorization: `Bearer ${api_key}` },
    json: {
      ...(max_age_hours !== undefined ? { max_age_hours } : {}),
    },
  })));

  server.registerTool('aol_get_capital_balance', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/capital/balance',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_get_capital_activity', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/capital/activity',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_create_capital_deposit', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/capital/deposit',
    headers: { Authorization: `Bearer ${api_key}` },
    json: {},
  })));

  server.registerTool('aol_create_lightning_capital_deposit', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      amount_sats: z.number().int().positive().describe('Amount to bridge from Lightning into capital, in sats.'),
    },
  }, async ({ api_key, amount_sats }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/capital/deposit-lightning',
    headers: { Authorization: `Bearer ${api_key}` },
    json: { amount_sats },
  })));

  server.registerTool('aol_get_lightning_capital_deposit_status', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      flow_id: z.string().optional().describe('Saved Lightning capital flow id.'),
      id: z.string().optional().describe('Simple alias for flow_id.'),
    },
  }, async ({ api_key, flow_id, id }) => {
    const normalizedFlowId = firstNonEmptyString(flow_id, id);
    if (!normalizedFlowId) {
      return toolInputError('Send flow_id or id.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'GET',
      path: `/api/v1/capital/deposit-lightning/${encodeURIComponent(normalizedFlowId)}`,
      headers: { Authorization: `Bearer ${api_key}` },
    }));
  });

  server.registerTool('aol_retry_lightning_capital_deposit', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      flow_id: z.string().optional().describe('Saved Lightning capital flow id.'),
      id: z.string().optional().describe('Simple alias for flow_id.'),
    },
  }, async ({ api_key, flow_id, id }) => {
    const normalizedFlowId = firstNonEmptyString(flow_id, id);
    if (!normalizedFlowId) {
      return toolInputError('Send flow_id or id.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'POST',
      path: `/api/v1/capital/deposit-lightning/${encodeURIComponent(normalizedFlowId)}/retry`,
      headers: { Authorization: `Bearer ${api_key}` },
      json: {},
    }));
  });

  server.registerTool('aol_get_capital_deposits', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/capital/deposits',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_withdraw_capital', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      amount_sats: z.number().int().positive().describe('Withdrawal amount in sats.'),
      destination_address: z.string().describe('Bitcoin on-chain address to receive the sats.'),
    },
  }, async ({ api_key, amount_sats, destination_address }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/capital/withdraw',
    headers: { Authorization: `Bearer ${api_key}` },
    json: { amount_sats, destination_address },
  })));

  server.registerTool('aol_get_network_health', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/analysis/network-health',
  })));

  server.registerTool('aol_get_node_analysis', {
    inputSchema: {
      node_pubkey: z.string().optional().describe('Real node pubkey to inspect.'),
      pubkey: z.string().optional().describe('Simple alias for node_pubkey.'),
    },
  }, async ({ node_pubkey, pubkey }) => {
    const normalizedPubkey = firstNonEmptyString(node_pubkey, pubkey);
    if (!normalizedPubkey) {
      return toolInputError('Send node_pubkey or pubkey.');
    }
    return toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: `/api/v1/analysis/node/${normalizedPubkey}`,
    }));
  });

  server.registerTool('aol_suggest_peers', {
    inputSchema: {
      node_pubkey: z.string().optional().describe('Node pubkey to analyze.'),
      pubkey: z.string().optional().describe('Simple alias for node_pubkey.'),
    },
  }, async ({ node_pubkey, pubkey }) => {
    const normalizedPubkey = firstNonEmptyString(node_pubkey, pubkey);
    if (!normalizedPubkey) {
      return toolInputError('Send node_pubkey or pubkey.');
    }
    return toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: `/api/v1/analysis/suggest-peers/${normalizedPubkey}`,
    }));
  });

  server.registerTool('aol_get_peer_safety', {
    inputSchema: {
      peer_pubkey: z.string().optional().describe('Real peer pubkey to inspect.'),
      pubkey: z.string().optional().describe('Simple alias for peer_pubkey.'),
    },
  }, async ({ peer_pubkey, pubkey }) => {
    const normalizedPubkey = firstNonEmptyString(peer_pubkey, pubkey);
    if (!normalizedPubkey) {
      return toolInputError('Send peer_pubkey or pubkey.');
    }
    return toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: `/api/v1/market/peer-safety/${normalizedPubkey}`,
    }));
  });

  server.registerTool('aol_get_market_fees', {
    inputSchema: {
      peer_pubkey: z.string().optional().describe('Real peer pubkey to inspect.'),
      pubkey: z.string().optional().describe('Simple alias for peer_pubkey.'),
    },
  }, async ({ peer_pubkey, pubkey }) => {
    const normalizedPubkey = firstNonEmptyString(peer_pubkey, pubkey);
    if (!normalizedPubkey) {
      return toolInputError('Send peer_pubkey or pubkey.');
    }
    return toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: `/api/v1/market/fees/${normalizedPubkey}`,
    }));
  });

  server.registerTool('aol_get_market_agent', {
    inputSchema: {
      agent_id: z.string().optional().describe('Public 8-character agent id.'),
      id: z.string().optional().describe('Simple alias for agent_id.'),
    },
  }, async ({ agent_id, id }) => {
    const normalizedAgentId = firstNonEmptyString(agent_id, id);
    if (!normalizedAgentId) {
      return toolInputError('Send agent_id or id.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'GET',
      path: `/api/v1/market/agent/${encodeURIComponent(normalizedAgentId)}`,
    }));
  });

  server.registerTool('aol_get_leaderboard_agent', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/channels/mine',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_get_leaderboard_challenges', {
    inputSchema: {
      agent_id: z.string().optional().describe('Public 8-character agent id.'),
      id: z.string().optional().describe('Simple alias for agent_id.'),
    },
  }, async ({ agent_id, id }) => {
    const normalizedAgentId = firstNonEmptyString(agent_id, id);
    if (!normalizedAgentId) {
      return toolInputError('Send agent_id or id.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'GET',
      path: `/api/v1/leaderboard/agent/${encodeURIComponent(normalizedAgentId)}`,
    }));
  });

  server.registerTool('aol_get_leaderboard_hall_of_fame', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/leaderboard/challenges',
  })));

  server.registerTool('aol_get_leaderboard_evangelists', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/leaderboard/hall-of-fame',
  })));

  server.registerTool('aol_get_tournament_bracket', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/leaderboard/evangelists',
  })));

  server.registerTool('aol_enter_tournament', {
    inputSchema: {
      tournament_id: z.string().optional().describe('Real tournament id.'),
      id: z.string().optional().describe('Simple alias for tournament_id.'),
    },
  }, async ({ tournament_id, id }) => {
    const normalizedTournamentId = firstNonEmptyString(tournament_id, id);
    if (!normalizedTournamentId) {
      return toolInputError('Send tournament_id or id.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'GET',
      path: `/api/v1/tournaments/${encodeURIComponent(normalizedTournamentId)}/bracket`,
    }));
  });

  server.registerTool('aol_get_channels_mine', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      tournament_id: z.string().optional().describe('Real tournament id.'),
      id: z.string().optional().describe('Simple alias for tournament_id.'),
    },
  }, async ({ api_key, tournament_id, id }) => {
    const normalizedTournamentId = firstNonEmptyString(tournament_id, id);
    if (!normalizedTournamentId) {
      return toolInputError('Send tournament_id or id.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'POST',
      path: `/api/v1/tournaments/${encodeURIComponent(normalizedTournamentId)}/enter`,
      headers: { Authorization: `Bearer ${api_key}` },
      json: {},
    }));
  });

  server.registerTool('aol_get_channels_audit', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/channels/audit',
  })));

  server.registerTool('aol_get_channels_verify', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/channels/verify',
  })));

  server.registerTool('aol_get_channels_violations', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/channels/violations',
  })));

  server.registerTool('aol_get_channel_audit', {
    inputSchema: {
      chan_id: z.string().optional().describe('Real chan_id or channel point used by the audit route.'),
      channel_point: z.string().optional().describe('Simple alias for chan_id on this route.'),
    },
  }, async ({ chan_id, channel_point }) => {
    const normalizedChanId = firstNonEmptyString(chan_id, channel_point);
    if (!normalizedChanId) {
      return toolInputError('Send chan_id or channel_point.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'GET',
      path: `/api/v1/channels/audit/${encodeURIComponent(normalizedChanId)}`,
    }));
  });

  server.registerTool('aol_get_channel_verify', {
    inputSchema: {
      chan_id: z.string().optional().describe('Real chan_id or channel point used by the verify route.'),
      channel_point: z.string().optional().describe('Simple alias for chan_id on this route.'),
    },
  }, async ({ chan_id, channel_point }) => {
    const normalizedChanId = firstNonEmptyString(chan_id, channel_point);
    if (!normalizedChanId) {
      return toolInputError('Send chan_id or channel_point.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'GET',
      path: `/api/v1/channels/verify/${encodeURIComponent(normalizedChanId)}`,
    }));
  });

  server.registerTool('aol_build_open_channel_instruction', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      local_funding_amount_sats: z.number().int().positive().describe('Channel funding amount in sats.'),
      peer_pubkey: z.string().describe('Real peer pubkey.'),
      timestamp: z.number().int().optional().describe('Optional unix timestamp override.'),
    },
  }, async ({ api_key, local_funding_amount_sats, peer_pubkey, timestamp }) => {
    const agentId = await resolveAgentIdForApiKey({ internalBaseUrl, apiKey: api_key });
    return instructionToolResult(buildInstruction({
      action: 'channel_open',
      agentId,
      params: {
        local_funding_amount_sats,
        peer_pubkey,
      },
      timestamp,
    }));
  });

  server.registerTool('aol_preview_open_channel', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      instruction: z.any().describe('Exact instruction object returned by build_open_channel_instruction.'),
      signature: z.string().describe('Hex signature over the exact instruction object only.'),
    },
  }, async ({ api_key, instruction, signature }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/market/preview',
    headers: { Authorization: `Bearer ${api_key}` },
    json: { instruction, signature },
  })));

  server.registerTool('aol_open_channel', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      instruction: z.any().describe('Exact instruction object returned by build_open_channel_instruction.'),
      signature: z.string().describe('Hex signature over the exact instruction object only.'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries.'),
    },
  }, async ({ api_key, instruction, signature, idempotency_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/market/open',
    headers: {
      Authorization: `Bearer ${api_key}`,
      ...(idempotency_key ? { 'Idempotency-Key': idempotency_key } : {}),
    },
    json: { instruction, signature },
  })));

  server.registerTool('aol_get_market_preview_help', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/preview',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_get_market_open_help', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/open',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_get_market_pending', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/pending',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_get_market_revenue', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/revenue',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_get_market_revenue_channel', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      chan_id: z.string().optional().describe('Real owned chan_id.'),
      channel_point: z.string().optional().describe('Simple alias for chan_id on this route.'),
    },
  }, async ({ api_key, chan_id, channel_point }) => {
    const normalizedChanId = firstNonEmptyString(chan_id, channel_point);
    if (!normalizedChanId) {
      return toolInputError('Send chan_id or channel_point.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'GET',
      path: `/api/v1/market/revenue/${encodeURIComponent(normalizedChanId)}`,
      headers: { Authorization: `Bearer ${api_key}` },
    }));
  });

  server.registerTool('aol_update_revenue_config', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      destination: z.string().describe('Revenue destination like capital.'),
    },
  }, async ({ api_key, destination }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'PUT',
    path: '/api/v1/market/revenue-config',
    headers: { Authorization: `Bearer ${api_key}` },
    json: { destination },
  })));

  server.registerTool('aol_get_market_performance', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/performance',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_get_market_performance_channel', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      chan_id: z.string().optional().describe('Real owned chan_id.'),
      channel_point: z.string().optional().describe('Simple alias for chan_id on this route.'),
    },
  }, async ({ api_key, chan_id, channel_point }) => {
    const normalizedChanId = firstNonEmptyString(chan_id, channel_point);
    if (!normalizedChanId) {
      return toolInputError('Send chan_id or channel_point.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'GET',
      path: `/api/v1/market/performance/${encodeURIComponent(normalizedChanId)}`,
      headers: { Authorization: `Bearer ${api_key}` },
    }));
  });

  server.registerTool('aol_build_close_channel_instruction', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      channel_point: z.string().describe('Real channel_point to close.'),
      timestamp: z.number().int().optional().describe('Optional unix timestamp override.'),
    },
  }, async ({ api_key, channel_point, timestamp }) => {
    const agentId = await resolveAgentIdForApiKey({ internalBaseUrl, apiKey: api_key });
    return instructionToolResult(buildInstruction({
      action: 'channel_close',
      agentId,
      params: { channel_point },
      timestamp,
    }));
  });

  server.registerTool('aol_get_market_close_help', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/close',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_close_channel', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      instruction: z.any().describe('Exact instruction object returned by build_close_channel_instruction.'),
      signature: z.string().describe('Hex signature over the exact instruction object only.'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries.'),
    },
  }, async ({ api_key, instruction, signature, idempotency_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/market/close',
    headers: {
      Authorization: `Bearer ${api_key}`,
      ...(idempotency_key ? { 'Idempotency-Key': idempotency_key } : {}),
    },
    json: { instruction, signature },
  })));

  server.registerTool('aol_get_market_closes', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/closes',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_build_channel_policy_instruction', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      channel_id: z.string().describe('Real owned chan_id.'),
      base_fee_msat: z.number().int().nonnegative().optional().describe('Optional base fee in msat.'),
      fee_rate_ppm: z.number().int().nonnegative().optional().describe('Optional fee rate in ppm.'),
      min_htlc_msat: z.number().int().nonnegative().optional().describe('Optional min HTLC in msat.'),
      max_htlc_msat: z.number().int().positive().optional().describe('Optional max HTLC in msat.'),
      time_lock_delta: z.number().int().positive().optional().describe('Optional CLTV delta.'),
      timestamp: z.number().int().optional().describe('Optional unix timestamp override.'),
    },
  }, async ({ api_key, channel_id, base_fee_msat, fee_rate_ppm, min_htlc_msat, max_htlc_msat, time_lock_delta, timestamp }) => {
    const agentId = await resolveAgentIdForApiKey({ internalBaseUrl, apiKey: api_key });
    const params = {};
    if (base_fee_msat !== undefined) params.base_fee_msat = base_fee_msat;
    if (fee_rate_ppm !== undefined) params.fee_rate_ppm = fee_rate_ppm;
    if (min_htlc_msat !== undefined) params.min_htlc_msat = min_htlc_msat;
    if (max_htlc_msat !== undefined) params.max_htlc_msat = max_htlc_msat;
    if (time_lock_delta !== undefined) params.time_lock_delta = time_lock_delta;
    if (Object.keys(params).length === 0) {
      return {
        content: [{ type: 'text', text: 'Provide at least one policy field to change.' }],
        isError: true,
      };
    }
    return instructionToolResult(buildInstruction({
      action: 'set_fee_policy',
      agentId,
      params,
      timestamp,
      extra: { channel_id },
    }));
  });

  server.registerTool('aol_preview_channel_policy', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      instruction: z.any().describe('Exact instruction object returned by build_channel_policy_instruction.'),
      signature: z.string().describe('Hex signature over the exact instruction object only.'),
    },
  }, async ({ api_key, instruction, signature }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/channels/preview',
    headers: { Authorization: `Bearer ${api_key}` },
    json: { instruction, signature },
  })));

  server.registerTool('aol_instruct_channel_policy', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      instruction: z.any().describe('Exact instruction object returned by build_channel_policy_instruction.'),
      signature: z.string().describe('Hex signature over the exact instruction object only.'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries.'),
    },
  }, async ({ api_key, instruction, signature, idempotency_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/channels/instruct',
    headers: {
      Authorization: `Bearer ${api_key}`,
      ...(idempotency_key ? { 'Idempotency-Key': idempotency_key } : {}),
    },
    json: { instruction, signature },
  })));

  server.registerTool('aol_get_channel_instructions', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/channels/instructions',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_estimate_rebalance', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      outbound_chan_id: z.string().optional().describe('Real owned outbound chan_id.'),
      chan_id: z.string().optional().describe('Simple alias for outbound_chan_id.'),
      amount_sats: z.number().int().positive().describe('Amount to rebalance in sats.'),
    },
  }, async ({ api_key, outbound_chan_id, chan_id, amount_sats }) => {
    const normalizedChanId = firstNonEmptyString(outbound_chan_id, chan_id);
    if (!normalizedChanId) {
      return toolInputError('Send outbound_chan_id or chan_id.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'POST',
      path: '/api/v1/market/rebalance/estimate',
      headers: { Authorization: `Bearer ${api_key}` },
      json: { outbound_chan_id: normalizedChanId, amount_sats },
    }));
  });

  server.registerTool('aol_build_rebalance_instruction', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      outbound_chan_id: z.string().optional().describe('Real owned outbound chan_id.'),
      chan_id: z.string().optional().describe('Simple alias for outbound_chan_id.'),
      amount_sats: z.number().int().positive().describe('Amount to rebalance in sats.'),
      max_fee_sats: z.number().int().nonnegative().describe('Maximum fee in sats.'),
      timestamp: z.number().int().optional().describe('Optional unix timestamp override.'),
    },
  }, async ({ api_key, outbound_chan_id, chan_id, amount_sats, max_fee_sats, timestamp }) => {
    const normalizedChanId = firstNonEmptyString(outbound_chan_id, chan_id);
    if (!normalizedChanId) {
      return toolInputError('Send outbound_chan_id or chan_id.');
    }
    const agentId = await resolveAgentIdForApiKey({ internalBaseUrl, apiKey: api_key });
    return instructionToolResult(buildInstruction({
      action: 'rebalance',
      agentId,
      params: { outbound_chan_id: normalizedChanId, amount_sats, max_fee_sats },
      timestamp,
    }));
  });

  server.registerTool('aol_rebalance_channel', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      instruction: z.any().describe('Exact instruction object returned by build_rebalance_instruction.'),
      signature: z.string().describe('Hex signature over the exact instruction object only.'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries.'),
    },
  }, async ({ api_key, instruction, signature, idempotency_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/market/rebalance',
    headers: {
      Authorization: `Bearer ${api_key}`,
      ...(idempotency_key ? { 'Idempotency-Key': idempotency_key } : {}),
    },
    json: { instruction, signature },
  })));

  server.registerTool('aol_get_market_rebalances', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/rebalances',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_get_swap_quote', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      amount_sats: z.number().int().positive().describe('Swap amount in sats.'),
    },
  }, async ({ api_key, amount_sats }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/swap/quote',
    headers: { Authorization: `Bearer ${api_key}` },
    query: { amount_sats },
  })));

  server.registerTool('aol_create_swap_to_onchain', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      amount_sats: z.number().int().positive().describe('Swap amount in sats.'),
      onchain_address: z.string().describe('Bitcoin on-chain address to receive the swap payout.'),
    },
  }, async ({ api_key, amount_sats, onchain_address }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/market/swap/lightning-to-onchain',
    headers: { Authorization: `Bearer ${api_key}` },
    json: { amount_sats, onchain_address },
  })));

  server.registerTool('aol_get_swap_status', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      swap_id: z.string().optional().describe('Saved swap id.'),
      id: z.string().optional().describe('Simple alias for swap_id.'),
    },
  }, async ({ api_key, swap_id, id }) => {
    const normalizedSwapId = firstNonEmptyString(swap_id, id);
    if (!normalizedSwapId) {
      return toolInputError('Send swap_id or id.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'GET',
      path: `/api/v1/market/swap/status/${encodeURIComponent(normalizedSwapId)}`,
      headers: { Authorization: `Bearer ${api_key}` },
    }));
  });

  server.registerTool('aol_get_swap_history', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/swap/history',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_fund_channel_from_ecash', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      instruction: z.any().describe('Exact signed instruction object to submit.'),
      signature: z.string().describe('Hex signature over the instruction object.'),
    },
  }, async ({ api_key, instruction, signature }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/market/fund-from-ecash',
    headers: { Authorization: `Bearer ${api_key}` },
    json: { instruction, signature },
  })));

  server.registerTool('aol_get_ecash_funding_status', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      flow_id: z.string().optional().describe('Saved ecash funding flow id.'),
      id: z.string().optional().describe('Simple alias for flow_id.'),
    },
  }, async ({ api_key, flow_id, id }) => {
    const normalizedFlowId = firstNonEmptyString(flow_id, id);
    if (!normalizedFlowId) {
      return toolInputError('Send flow_id or id.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'GET',
      path: `/api/v1/market/fund-from-ecash/${encodeURIComponent(normalizedFlowId)}`,
      headers: { Authorization: `Bearer ${api_key}` },
    }));
  });

  server.registerTool('aol_send_message', {
    inputSchema: {
      api_key: z.string().describe('Sender bearer token.'),
      to: z.string().describe('Recipient agent id.'),
      content: z.string().describe('Message body.'),
      type: z.string().optional().describe('Optional message type like message or intel.'),
    },
  }, async ({ api_key, to, content, type }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/messages',
    headers: { Authorization: `Bearer ${api_key}` },
    json: { to, content, ...(type !== undefined ? { type } : {}) },
  })));

  server.registerTool('aol_get_messages', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      since: z.number().int().optional().describe('Optional lower bound timestamp.'),
      limit: z.number().int().positive().optional().describe('Optional max rows to return.'),
    },
  }, async ({ api_key, since, limit }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/messages',
    headers: { Authorization: `Bearer ${api_key}` },
    query: { since, limit },
  })));

  server.registerTool('aol_get_messages_inbox', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      since: z.number().int().optional().describe('Optional lower bound timestamp.'),
      limit: z.number().int().positive().optional().describe('Optional max rows to return.'),
    },
  }, async ({ api_key, since, limit }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/messages/inbox',
    headers: { Authorization: `Bearer ${api_key}` },
    query: { since, limit },
  })));

  server.registerTool('aol_create_alliance', {
    inputSchema: {
      api_key: z.string().describe('Sender bearer token.'),
      to: z.string().optional().describe('Recipient agent id.'),
      target_agent_id: z.string().optional().describe('Simple alias for to.'),
      recipient_agent_id: z.string().optional().describe('Another alias for to.'),
      description: z.string().optional().describe('Alliance description.'),
      terms: z.string().optional().describe('Simple alias for description.'),
      duration_hours: z.number().int().positive().optional().describe('Optional alliance duration in hours.'),
      conditions: z.string().optional().describe('Optional alliance conditions text.'),
    },
  }, async ({ api_key, to, target_agent_id, recipient_agent_id, description, terms, duration_hours, conditions }) => {
    const normalizedRecipient = firstNonEmptyString(to, target_agent_id, recipient_agent_id);
    const normalizedDescription = firstNonEmptyString(description, terms);
    if (!normalizedRecipient) {
      return toolInputError('Send to, target_agent_id, or recipient_agent_id.');
    }
    if (!normalizedDescription) {
      return toolInputError('Send description or terms.');
    }
    return toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/alliances',
    headers: { Authorization: `Bearer ${api_key}` },
    json: {
      to: normalizedRecipient,
      terms: {
        description: normalizedDescription,
        ...(duration_hours !== undefined ? { duration_hours } : {}),
        ...(conditions !== undefined ? { conditions } : {}),
      },
    },
    }));
  });

  server.registerTool('aol_get_alliances', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/alliances',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_accept_alliance', {
    inputSchema: {
      api_key: z.string().describe('Recipient bearer token.'),
      alliance_id: z.string().optional().describe('Real alliance id to accept.'),
      id: z.string().optional().describe('Simple alias for alliance_id.'),
    },
  }, async ({ api_key, alliance_id, id }) => {
    const normalizedAllianceId = firstNonEmptyString(alliance_id, id);
    if (!normalizedAllianceId) {
      return toolInputError('Send alliance_id or id.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'POST',
      path: `/api/v1/alliances/${encodeURIComponent(normalizedAllianceId)}/accept`,
      headers: { Authorization: `Bearer ${api_key}` },
      json: {},
    }));
  });

  server.registerTool('aol_break_alliance', {
    inputSchema: {
      api_key: z.string().describe('Bearer token for the agent ending the alliance.'),
      alliance_id: z.string().optional().describe('Real alliance id to break.'),
      id: z.string().optional().describe('Simple alias for alliance_id.'),
      reason: z.string().optional().describe('Optional short reason.'),
    },
  }, async ({ api_key, alliance_id, id, reason }) => {
    const normalizedAllianceId = firstNonEmptyString(alliance_id, id);
    if (!normalizedAllianceId) {
      return toolInputError('Send alliance_id or id.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'POST',
      path: `/api/v1/alliances/${encodeURIComponent(normalizedAllianceId)}/break`,
      headers: { Authorization: `Bearer ${api_key}` },
      json: reason !== undefined ? { reason } : {},
    }));
  });

  server.registerTool('aol_request_help', {
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      question: z.string().describe('Plain-language question for the help route.'),
      context: z.record(z.string(), z.any()).optional().describe('Optional context object.'),
    },
  }, async ({ api_key, question, context }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/help',
    headers: { Authorization: `Bearer ${api_key}` },
    json: context !== undefined ? { question, context } : { question },
  })));

  return server;
}

function jsonRpcError(res, status, message) {
  res.status(status).json({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message,
    },
    id: null,
  });
}

export function mcpRoutes({ internalBaseUrl, publicBaseUrl = 'https://agentsonlightning.com', internalMcpSecret } = {}) {
  if (typeof internalMcpSecret === 'string' && internalMcpSecret.trim()) {
    process.env.AOL_INTERNAL_MCP_SECRET = internalMcpSecret.trim();
  }
  const router = Router();
  const mcpRate = rateLimit('mcp');

  // @agent-route {"auth":"public","domain":"discovery","subgroup":"MCP","label":"mcp-root","summary":"Read the MCP discovery document.","order":610,"tags":["discovery","read","docs","public","mcp"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/mcp', mcpRate, async (req, res) => {
    res.json(buildDiscoveryDocument({ origin: getOrigin(req, publicBaseUrl) }));
  });

  // @agent-route {"auth":"public","domain":"discovery","subgroup":"MCP","label":"mcp-transport","summary":"Use the hosted MCP transport.","order":611,"tags":["discovery","write","docs","public","mcp"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.post('/mcp', mcpRate, async (req, res) => {
    let transport = null;
    let server = null;
    let cleanedUp = false;
    const cleanup = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      await Promise.allSettled([
        transport?.close?.(),
        server?.close?.(),
      ]);
    };
    try {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      transport.onclose = () => { void cleanup(); };

      const origin = getOrigin(req, publicBaseUrl);
      const requestId = randomUUID();
      const clientIp = getSocketAddress(req) || null;
      const context = {
        requestId,
        sessionId: firstNonEmptyString(
          req.get('mcp-session-id'),
          req.get('x-aol-session-id'),
          req.get('x-request-id'),
          req.get('cf-ray'),
          buildAnonymousMcpSessionId({
            clientIp,
            userAgent: req.get('user-agent') || null,
          }),
          requestId,
        ),
        clientIp,
      };
      await mcpToolContext.run(context, async () => {
        server = buildMcpServer({ internalBaseUrl, publicBaseUrl: origin });
        res.once('close', () => { void cleanup(); });
        res.once('finish', () => { void cleanup(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      });
    } catch (error) {
      console.error('[mcp] POST /mcp failed:', error);
      await cleanup();
      if (!res.headersSent) {
        jsonRpcError(res, 500, 'Internal MCP server error.');
      }
    }
  });

  // @agent-route {"auth":"public","domain":"discovery","subgroup":"MCP","label":"mcp-session-close","summary":"Compatibility no-op for stateless MCP clients.","order":612,"tags":["discovery","write","docs","public","mcp"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.delete('/mcp', mcpRate, async (req, res) => {
    res.status(204).end();
  });

  // @agent-route {"auth":"public","domain":"discovery","subgroup":"MCP","label":"mcp-manifest","summary":"Read the MCP manifest document.","order":613,"tags":["discovery","read","docs","public","mcp"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/.well-known/mcp.json', mcpRate, (req, res) => {
    const origin = getOrigin(req, publicBaseUrl);
    setDiscoveryJsonHeaders(res);
    res.json(buildDiscoveryDocument({ origin }));
  });

  // @agent-route {"auth":"public","domain":"discovery","subgroup":"MCP","label":"mcp-server-card","summary":"Read the structured MCP server card discovery document.","order":614,"tags":["discovery","read","docs","public","mcp"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/.well-known/mcp/server-card.json', mcpRate, (req, res) => {
    setDiscoveryJsonHeaders(res);
    res.json(buildServerCard({ origin: getOrigin(req, publicBaseUrl) }));
  });

  // @agent-route {"auth":"public","domain":"discovery","subgroup":"MCP","label":"agent-card","summary":"Read the agent card discovery document.","order":615,"tags":["discovery","read","docs","public","mcp"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/.well-known/agent-card.json', mcpRate, (req, res) => {
    const origin = getOrigin(req, publicBaseUrl);
    setDiscoveryJsonHeaders(res);
    res.json(buildAgentCard({ origin }));
  });

  return router;
}
