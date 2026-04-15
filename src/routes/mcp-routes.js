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
  INTERNAL_AUTH_AUDIENCE_HEADER,
  INTERNAL_AUTH_PAYLOAD_HASH_HEADER,
  INTERNAL_VERIFIED_AGENT_ID_HEADER,
  buildRegistrationAuthPayload,
  buildSignedToolCallPayload,
  canonicalAuthHash,
  canonicalAuthJson,
  stripAgentAuth,
  verifyToolAgentAuth,
  AOL_AUTH_VERSION,
  DEFAULT_AUTH_FRESHNESS_SECONDS,
  AOL_REGISTRATION_AUTH_SCHEME,
  AOL_TOOL_AUTH_SCHEME,
  AOL_KEY_ROTATION_AUTH_SCHEME,
  buildKeyRotationPayload,
} from '../identity/signed-auth.js';
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
import { normalizeRegistrationProfileForSigning } from '../identity/registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = resolve(__dirname, '..', '..', 'docs', 'mcp');
const MCP_SERVER_CARD_PATH = '/.well-known/mcp/server-card.json';
const MCP_PROTOCOL_VERSION = '2025-06-18';
const ALLOWED_HEADER_NAMES = new Set([
  'content-type',
  'idempotency-key',
  'x-idempotency-key',
]);
const RESPONSE_HEADER_NAMES = ['content-type', 'location', 'retry-after'];
const mcpToolContext = new AsyncLocalStorage();
const DEFAULT_INTERNAL_REQUEST_TIMEOUT_MS = 8_000;
const MCP_AGENT_AUTH_HINT = 'Signed agent authorization for this exact MCP tool call. Build the documented signed-tool-call payload locally, sign its canonical JSON with the registered secp256k1 private key as DER-encoded low-S ECDSA, and never expose the private key.';
const MCP_TIMESTAMP_HINT = 'Optional unix timestamp embedded in the instruction before local signing. Usually omit unless you need deterministic signing input.';
const MCP_IDEMPOTENCY_KEY_HINT = 'Optional stable key for retrying the exact same signed request safely. Reuse only when instruction and signature are unchanged.';
const MCP_EXACT_SIGNATURE_HINT = 'Hex signature over the exact instruction object. Sign locally; never expose private keys and never sign an invented or modified instruction.';
const MCP_PUBLIC_AGENT_ID_HINT = 'Public agent id returned by registration or public agent tools; use a real id, not a display name.';
const MCP_PUBLIC_AGENT_ID_ALIAS_HINT = 'Alias for agent_id; send the same public agent id value.';
const MCP_NODE_PUBKEY_HINT = 'Real Lightning node pubkey to inspect before peer, routing, or market decisions.';
const MCP_NODE_PUBKEY_ALIAS_HINT = 'Alias for node_pubkey; send the same Lightning node pubkey value.';
const MCP_PEER_PUBKEY_HINT = 'Real Lightning peer pubkey to evaluate before allocating channel capital or setting fees.';
const MCP_PEER_PUBKEY_ALIAS_HINT = 'Alias for peer_pubkey; send the same Lightning peer pubkey value.';
const MCP_TOURNAMENT_ID_HINT = 'Real tournament id returned by aol_list_tournaments; do not invent ids.';
const MCP_TOURNAMENT_ID_ALIAS_HINT = 'Alias for tournament_id; send the same tournament id value.';
const MCP_CHANNEL_POINT_ALIAS_HINT = 'Alias for chan_id when accepted; send the exact channel id or channel point returned by channel tools.';
const MCP_PROOF_ID_HINT = 'Real proof_id returned by aol_list_my_proofs or a proof view. Use it to read or verify one signed Proof Ledger row owned by your agent.';
const MCP_AGENT_AUTH_SCHEMA = z.object({
  agent_id: z.string().describe('Registered agent id whose secp256k1 key signs this exact tool call.'),
  timestamp: z.number().int().describe(`Unix timestamp in seconds, usually within ${DEFAULT_AUTH_FRESHNESS_SECONDS} seconds of server time.`),
  nonce: z.string().describe('Unique random value for this call. Reusing it with the same signed payload is rejected as replay.'),
  signature: z.string().describe('DER-encoded low-S secp256k1 ECDSA signature hex over the canonical signed-tool-call payload for this exact tool name and arguments.'),
}).describe(MCP_AGENT_AUTH_HINT);
const REGISTRATION_AUTH_SCHEMA = z.object({
  timestamp: z.number().int().describe('Unix timestamp in seconds from the aol_build_registration_payload payload.'),
  nonce: z.string().describe('Unique nonce from the aol_build_registration_payload payload.'),
  signature: z.string().describe('DER-encoded low-S secp256k1 ECDSA signature hex over the exact registration signing_payload string; do not parse or reserialize it before signing.'),
}).describe('Proof that the agent controls the private key for pubkey. Build this with aol_build_registration_payload and sign locally.');
const KEY_ROTATION_AUTH_SCHEMA = z.object({
  timestamp: z.number().int().describe('Unix timestamp in seconds from aol_build_key_rotation_payload.'),
  nonce: z.string().describe('Unique nonce from aol_build_key_rotation_payload.'),
  old_signature: z.string().describe('DER-encoded low-S secp256k1 ECDSA signature hex from the current private key over the exact key-rotation signing_payload.'),
  new_signature: z.string().describe('DER-encoded low-S secp256k1 ECDSA signature hex from the new private key over the exact key-rotation signing_payload.'),
}).describe('Proof that both the old and new private keys authorize this key rotation.');

function privateInputSchema(fields = {}) {
  return {
    agent_auth: MCP_AGENT_AUTH_SCHEMA,
    ...fields,
  };
}

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
    .replace(/\baol_list_[a-z0-9_]*skills?\b/g, 'aol_list_mcp_docs');
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
  if (context?.agentAuth?.agent_id && context?.agentAuth?.auth_payload_hash) {
    requestHeaders[INTERNAL_VERIFIED_AGENT_ID_HEADER] = context.agentAuth.agent_id;
    requestHeaders[INTERNAL_AUTH_PAYLOAD_HASH_HEADER] = context.agentAuth.auth_payload_hash;
    requestHeaders[INTERNAL_AUTH_AUDIENCE_HEADER] = context.agentAuth.payload?.audience || '';
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

function requireCurrentSignedAgentId() {
  const agentId = mcpToolContext.getStore()?.agentAuth?.agent_id || null;
  if (!agentId) throw new Error('Signed agent_auth is required for this private MCP tool.');
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
      schemes: ['per-tool-secp256k1-signature'],
    },
    instructions: 'Connect to /mcp and read start_here or /llms.txt. Use named MCP tools only. You can register with a secp256k1 public key, inspect the market, fund wallet and capital state, prepare signed Lightning channel actions, coordinate with other agents, and track routing-fee revenue. The app charges zero platform fees and zero commissions. Private tools require one-time agent_auth signatures over the exact signed-tool-call payload.',
    resources: ['dynamic'],
    tools: ['dynamic'],
    prompts: ['dynamic'],
    _meta: {
      mcp_only_agent_interface: true,
      zero_platform_fees: true,
      zero_commissions: true,
      routing_fee_opportunity: true,
      signed_channel_actions: true,
      auth_note: 'The MCP transport is public. Private tools require agent_auth: a one-time secp256k1 signature for the exact tool name and arguments.',
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
        description: 'Create an agent identity with a secp256k1 public key. Private MCP tools use one-time signed agent_auth payloads, not reusable shared secrets.',
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

const MCP_SECRET_KEY_PATTERN = /(agent[_-]?auth|authorization|token|proof|seed|private|signature|signing[_-]?payload|ecash|secret|macaroon)/i;
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

function toolAuthAudience(publicBaseUrl) {
  return `${String(publicBaseUrl || 'https://agentsonlightning.com').replace(/\/+$/, '')}/mcp`;
}

function schemaUsesAgentAuth(inputSchema) {
  return Boolean(inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema) && inputSchema.agent_auth);
}

function requireAgentAuthSchema(config = {}) {
  const inputSchema = config.inputSchema && typeof config.inputSchema === 'object' && !Array.isArray(config.inputSchema)
    ? config.inputSchema
    : null;
  if (!inputSchema || !schemaUsesAgentAuth(inputSchema)) return config;
  return {
    ...config,
    inputSchema: {
      ...inputSchema,
      agent_auth: MCP_AGENT_AUTH_SCHEMA,
    },
  };
}

function buildAuthPayloadPreview({ audience, toolName, input }) {
  const agentId = input?.agent_auth?.agent_id || '<agent_id>';
  const timestamp = Number.isSafeInteger(input?.agent_auth?.timestamp)
    ? input.agent_auth.timestamp
    : Math.floor(Date.now() / 1000);
  const nonce = typeof input?.agent_auth?.nonce === 'string' && input.agent_auth.nonce
    ? input.agent_auth.nonce
    : '<unique_nonce>';
  const payload = buildSignedToolCallPayload({
    audience,
    agentId,
    toolName,
    args: input || {},
    timestamp,
    nonce,
  });
  return {
    payload,
    signing_payload: canonicalAuthJson(payload),
    args_hash: payload.args_hash,
  };
}

function authToolError({ code = 'AUTH_REQUIRED', message, audience, toolName, input, status = 401, details = {} }) {
  const preview = buildAuthPayloadPreview({ audience, toolName, input });
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: code,
          message,
          next: 'Build the signed-tool-call payload locally with this exact tool name, args_hash, timestamp, nonce, and audience; sign its canonical JSON with your registered secp256k1 key; retry this same tool with agent_auth.',
          audience,
          tool_name: toolName,
          ...preview,
          ...details,
        }, null, 2),
      },
    ],
    isError: true,
    structuredContent: {
      ok: false,
      status,
      error: code,
      message,
      audience,
      tool_name: toolName,
      ...preview,
      ...details,
    },
  };
}

async function verifyMcpAgentAuth({ name, input, publicBaseUrl, agentRegistry, signedAuthReplayStore }) {
  const audience = toolAuthAudience(publicBaseUrl);
  const result = await verifyToolAgentAuth({
    audience,
    toolName: name,
    args: input || {},
    agentAuth: input?.agent_auth,
    registry: agentRegistry,
    replayStore: signedAuthReplayStore,
  });
  if (result.ok) return result;
  return authToolError({
    code: result.code || 'AUTH_REQUIRED',
    message: result.message || 'agent_auth is required for this private MCP tool.',
    audience,
    toolName: name,
    input,
    details: {
      scheme: AOL_TOOL_AUTH_SCHEME,
      version: AOL_AUTH_VERSION,
      server_time: Math.floor(Date.now() / 1000),
    },
  });
}

function instrumentMcpTools(server, { publicBaseUrl, agentRegistry, signedAuthReplayStore } = {}) {
  const registerTool = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) => {
    const toolSpec = getMcpToolSpec(name);
    if (!toolSpec) return undefined;
    const requiresAgentAuth = schemaUsesAgentAuth(config?.inputSchema);
    const monitoring = getMcpToolMonitoringMetadata(name) || {};
    const registeredConfig = {
      ...requireAgentAuthSchema(config),
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
          let handlerInput = input;
          if (requiresAgentAuth) {
            const auth = await verifyMcpAgentAuth({
              name,
              input,
              publicBaseUrl,
              agentRegistry,
              signedAuthReplayStore,
            });
            if (auth?.isError) {
              result = auth;
              status = inferToolStatus(result, 401);
              failed = true;
              return result;
            }
            context.agentAuth = auth;
            handlerInput = stripAgentAuth(input || {});
          }
          result = await handler(handlerInput, extra);
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
        const agentId = context.agentAuth?.agent_id || extractToolAgentId(inputSummary, savedValues, resultSummary);
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

function buildMcpServer({ internalBaseUrl, publicBaseUrl, agentRegistry, signedAuthReplayStore }) {
  const server = new McpServer({
    name: 'agents-on-lightning-mcp',
    version: '1.0.0',
    websiteUrl: publicBaseUrl,
  });
  instrumentMcpTools(server, { publicBaseUrl, agentRegistry, signedAuthReplayStore });

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
    path: '/api/v1/mcp-docs',
  })));

  server.registerTool('aol_get_platform_status', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/platform/status',
  })));

  server.registerTool('aol_build_registration_payload', {
    inputSchema: {
      name: z.string().describe('Public name for the new agent identity.'),
      pubkey: z.string().describe('Compressed secp256k1 public key hex for this agent. Register only the public key; keep the private key local and do not print it.'),
      description: z.string().optional().describe('Optional public description for this agent. Do not include secrets.'),
      framework: z.string().optional().describe('Optional public framework or runtime label for this agent.'),
      contact_url: z.string().optional().describe('Optional public contact URL for coordination. Do not include credentials or tokens.'),
      forked_from: z.string().optional().describe('Optional public agent id this agent forked from.'),
      referred_by: z.string().optional().describe('Optional referral code from another agent.'),
      timestamp: z.number().int().optional().describe('Optional unix timestamp in seconds for deterministic signing; omit for server time.'),
      nonce: z.string().optional().describe('Optional unique nonce. Omit unless you already generated one.'),
    },
  }, async ({ name, pubkey, description, framework, contact_url, forked_from, referred_by, timestamp, nonce }) => {
    try {
      const profile = normalizeRegistrationProfileForSigning({
        name,
        description,
        framework,
        contact_url,
        forked_from,
        referred_by,
      });
      const payload = buildRegistrationAuthPayload({
        audience: toolAuthAudience(publicBaseUrl),
        pubkey: pubkey.trim(),
        profile,
        timestamp: timestamp ?? Math.floor(Date.now() / 1000),
        nonce: nonce || randomUUID(),
      });
      const signingPayload = canonicalAuthJson(payload);
      const signing_guidance = {
        sign_exact: 'Sign the signing_payload string exactly as returned. Do not parse it, reserialize it, pretty-print it, or sign the payload object.',
        signature_format: 'DER-encoded low-S secp256k1 ECDSA signature hex.',
        key_check: 'The private key used to sign must match the compressed pubkey you passed to this tool.',
      };
      const registrationAuthTemplate = {
        timestamp: payload.timestamp,
        nonce: payload.nonce,
        signature: '<DER low-S secp256k1 ECDSA signature hex over signing_payload>',
      };
      const registerArgumentsTemplate = {
        name: profile.name,
        pubkey: payload.pubkey,
        registration_auth: registrationAuthTemplate,
      };
      for (const field of ['description', 'framework', 'contact_url', 'forked_from', 'referred_by']) {
        if (profile[field] != null) registerArgumentsTemplate[field] = profile[field];
      }
      const next_call = {
        tool_name: 'aol_register_agent',
        arguments_template: registerArgumentsTemplate,
        warning: 'Place the signature inside registration_auth.signature. Do not send signature as a top-level aol_register_agent argument.',
      };
      const body = {
        payload,
        signing_payload: signingPayload,
        signing_guidance,
        next_call,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
        structuredContent: {
          payload,
          signing_payload: signingPayload,
          signing_guidance,
          next_call,
          scheme: AOL_REGISTRATION_AUTH_SCHEME,
          version: AOL_AUTH_VERSION,
          audience: payload.audience,
          server_time: Math.floor(Date.now() / 1000),
        },
      };
    } catch (err) {
      return toolInputError(err?.message || 'Could not build registration payload.');
    }
  });

  server.registerTool('aol_build_key_rotation_payload', {
    inputSchema: {
      agent_id: z.string().describe('Registered agent id whose key is being rotated.'),
      old_pubkey: z.string().describe('Current registered compressed secp256k1 public key hex.'),
      new_pubkey: z.string().describe('New compressed secp256k1 public key hex. Keep the new private key local and do not print it.'),
      timestamp: z.number().int().optional().describe('Optional unix timestamp in seconds for deterministic signing; omit for server time.'),
      nonce: z.string().optional().describe('Optional unique nonce. Omit unless you already generated one.'),
    },
  }, async ({ agent_id, old_pubkey, new_pubkey, timestamp, nonce }) => {
    try {
      const payload = buildKeyRotationPayload({
        audience: toolAuthAudience(publicBaseUrl),
        agentId: agent_id,
        oldPubkey: old_pubkey,
        newPubkey: new_pubkey,
        timestamp: timestamp ?? Math.floor(Date.now() / 1000),
        nonce: nonce || randomUUID(),
      });
      const signingPayload = canonicalAuthJson(payload);
      return {
        content: [{ type: 'text', text: JSON.stringify({ payload, signing_payload: signingPayload }, null, 2) }],
        structuredContent: {
          payload,
          signing_payload: signingPayload,
          scheme: AOL_KEY_ROTATION_AUTH_SCHEME,
          version: AOL_AUTH_VERSION,
          audience: payload.audience,
          server_time: Math.floor(Date.now() / 1000),
        },
      };
    } catch (err) {
      return toolInputError(err?.message || 'Could not build key rotation payload.');
    }
  });

  server.registerTool('aol_decode_invoice', {
    inputSchema: {
      invoice: z.string().describe('BOLT11 Lightning invoice to decode only. This does not pay the invoice; invoices can expire and payment is not assumed from decoding.'),
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
      name: z.string().optional().describe('Strategy name returned by aol_list_strategies, such as geographic-arbitrage.'),
      strategy_name: z.string().optional().describe('Alias for name; send the same strategy name returned by aol_list_strategies.'),
      strategy: z.string().optional().describe('Alias for name; send the same strategy name returned by aol_list_strategies.'),
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

  server.registerTool('aol_get_my_balance_proof', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/proofs/me/balance',
  })));

  server.registerTool('aol_list_my_proofs', {
    inputSchema: privateInputSchema({
      limit: z.number().int().positive().optional().describe('Optional maximum number of signed proof rows to return for your agent. Use this to page through your own Proof Ledger history.'),
      offset: z.number().int().nonnegative().optional().describe('Optional row offset for paging through your own signed proof rows.'),
    }),
  }, async ({ limit, offset }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/proofs/me',
    query: { limit, offset },
  })));

  server.registerTool('aol_get_proof', {
    inputSchema: privateInputSchema({
      proof_id: z.string().optional().describe(MCP_PROOF_ID_HINT),
      id: z.string().optional().describe('Alias for proof_id; send the same signed Proof Ledger proof id value.'),
    }),
  }, async ({ proof_id, id }) => {
    const normalizedProofId = firstNonEmptyString(proof_id, id);
    if (!normalizedProofId) {
      return toolInputError('Send proof_id or id from aol_list_my_proofs.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'GET',
      path: `/api/v1/proofs/proof/${encodeURIComponent(normalizedProofId)}`,
    }));
  });

  server.registerTool('aol_verify_proof', {
    inputSchema: privateInputSchema({
      proof_id: z.string().optional().describe(MCP_PROOF_ID_HINT),
      id: z.string().optional().describe('Alias for proof_id; send the same signed Proof Ledger proof id value.'),
    }),
  }, async ({ proof_id, id }) => {
    const normalizedProofId = firstNonEmptyString(proof_id, id);
    if (!normalizedProofId) {
      return toolInputError('Send proof_id or id from aol_list_my_proofs.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'GET',
      path: `/api/v1/proofs/proof/${encodeURIComponent(normalizedProofId)}/verify`,
    }));
  });

  server.registerTool('aol_get_proof_bundle', {
    inputSchema: privateInputSchema({
      proof_id: z.string().optional().describe(MCP_PROOF_ID_HINT),
      id: z.string().optional().describe('Alias for proof_id; send the same signed Proof Ledger proof id value.'),
    }),
  }, async ({ proof_id, id }) => {
    const normalizedProofId = firstNonEmptyString(proof_id, id);
    if (!normalizedProofId) {
      return toolInputError('Send proof_id or id from aol_list_my_proofs.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'GET',
      path: `/api/v1/proofs/proof/${encodeURIComponent(normalizedProofId)}/bundle`,
    }));
  });

  server.registerTool('aol_get_proof_of_liabilities', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/proofs/liabilities',
  })));

  server.registerTool('aol_get_proof_of_reserves', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/proofs/reserves',
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
    inputSchema: privateInputSchema({
      query_id: z.string().describe('Analytics query id from aol_get_analytics_catalog, such as network_stats. Quote before execute so cost is visible.'),
      params: z.record(z.string(), z.any()).optional().describe('Optional analytics parameters required by the catalog entry. Do not include secrets, private keys, signatures, or seed material.'),
    }),
  }, async ({ query_id, params }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/analytics/quote',
    json: { query_id, params: params || {} },
  })));

  server.registerTool('aol_execute_analytics', {
    inputSchema: privateInputSchema({
      query_id: z.string().describe('Analytics query id from aol_get_analytics_catalog. Execute only after quoting and accepting the cost.'),
      params: z.record(z.string(), z.any()).optional().describe('Optional analytics parameters required by the catalog entry. Use the same intended params you quoted; do not include secrets.'),
    }),
  }, async ({ query_id, params }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/analytics/execute',
    json: { query_id, params: params || {} },
  })));

  server.registerTool('aol_get_analytics_history', {
    inputSchema: privateInputSchema({
      since: z.number().int().optional().describe('Optional lower-bound unix timestamp for analytics history. Use it to resume from a known point.'),
      limit: z.number().int().positive().optional().describe('Optional maximum number of analytics history rows to return.'),
    }),
  }, async ({ since, limit }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/analytics/history',
    query: { since, limit },
  })));

  server.registerTool('aol_register_agent', {
    inputSchema: {
      name: z.string().describe('Public name for the new agent identity.'),
      pubkey: z.string().describe('Compressed secp256k1 public key hex for this agent. Register only the public key; keep the private key local and private.'),
      registration_auth: REGISTRATION_AUTH_SCHEMA,
      description: z.string().optional().describe('Optional public description for this agent. Do not include secrets.'),
      framework: z.string().optional().describe('Optional public framework or runtime label for this agent.'),
      contact_url: z.string().optional().describe('Optional public contact URL for coordination. Do not include private credentials or tokens.'),
      forked_from: z.string().optional().describe('Optional public agent id this agent forked from.'),
      referred_by: z.string().optional().describe('Optional referral code from another agent.'),
    },
  }, async ({ name, pubkey, registration_auth, description, framework, contact_url, forked_from, referred_by }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/agents/register',
    json: {
      name,
      pubkey,
      registration_auth,
      audience: toolAuthAudience(publicBaseUrl),
      ...(description !== undefined ? { description } : {}),
      ...(framework !== undefined ? { framework } : {}),
      ...(contact_url !== undefined ? { contact_url } : {}),
      ...(forked_from !== undefined ? { forked_from } : {}),
      ...(referred_by !== undefined ? { referred_by } : {}),
    },
  })));

  server.registerTool('aol_rotate_agent_key', {
    inputSchema: privateInputSchema({
      new_pubkey: z.string().describe('New compressed secp256k1 public key hex. Keep the new private key local and do not print it.'),
      key_rotation_auth: KEY_ROTATION_AUTH_SCHEMA,
    }),
  }, async ({ new_pubkey, key_rotation_auth }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'PUT',
    path: '/api/v1/agents/me/pubkey',
    json: { new_pubkey, key_rotation_auth },
  })));

  server.registerTool('aol_update_me', {
    inputSchema: privateInputSchema({
      name: z.string().optional().describe('Optional public display name for this agent. Do not include secrets.'),
      description: z.string().optional().describe('Optional public description for this agent. Do not include private keys, seed material, or credentials.'),
      framework: z.string().optional().describe('Optional public framework or runtime label for this agent.'),
      contact_url: z.string().optional().describe('Optional public contact URL for coordination. Do not include private credentials or tokens.'),
    }),
  }, async ({ name, description, framework, contact_url }) => {
    const json = {};
    if (name !== undefined) json.name = name;
    if (description !== undefined) json.description = description;
    if (framework !== undefined) json.framework = framework;
    if (contact_url !== undefined) json.contact_url = contact_url;
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
      json,
    }));
  });

  server.registerTool('aol_get_me', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/agents/me',
  })));

  server.registerTool('aol_get_me_dashboard', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/agents/me/dashboard',
  })));

  server.registerTool('aol_get_me_events', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/agents/me/events',
  })));

  server.registerTool('aol_get_referral', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/agents/me/referral',
  })));

  server.registerTool('aol_get_referral_code', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/agents/me/referral-code',
  })));

  server.registerTool('aol_get_agent_profile', {
    inputSchema: {
      agent_id: z.string().optional().describe(MCP_PUBLIC_AGENT_ID_HINT),
      id: z.string().optional().describe(MCP_PUBLIC_AGENT_ID_ALIAS_HINT),
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
      agent_id: z.string().optional().describe(MCP_PUBLIC_AGENT_ID_HINT),
      id: z.string().optional().describe(MCP_PUBLIC_AGENT_ID_ALIAS_HINT),
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
    inputSchema: privateInputSchema({
      action_type: z.string().optional().describe('Public action type, such as open_channel. Use for honest reputation records, not invented payment or channel state.'),
      action: z.string().optional().describe('Alias for action_type; send the same public action type value.'),
      params: z.record(z.string(), z.any()).optional().describe('Optional public action parameters. Include only safe ids or public facts; never include private keys, signatures, tokens, or seed material.'),
      description: z.string().optional().describe('Optional public action summary. Do not claim payment, deposit, channel, or routing success unless tools confirmed it.'),
    }),
  }, async ({ action_type, action, params, description }) => {
    const normalizedActionType = firstNonEmptyString(action_type, action);
    if (!normalizedActionType) {
      return toolInputError('Send action_type or action.');
    }
    return toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/actions/submit',
    json: {
      action_type: normalizedActionType,
      ...(params !== undefined ? { params } : {}),
      ...(description !== undefined ? { description } : {}),
    },
    }));
  });

  server.registerTool('aol_get_action_history', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/actions/history',
  })));

  server.registerTool('aol_get_action', {
    inputSchema: privateInputSchema({
      action_id: z.string().optional().describe('Real action id returned by aol_get_action_history or aol_submit_action.'),
      id: z.string().optional().describe('Alias for action_id; send the same real action id value.'),
    }),
  }, async ({ action_id, id }) => {
    const normalizedActionId = firstNonEmptyString(action_id, id);
    if (!normalizedActionId) {
      return toolInputError('Send action_id or id.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'GET',
      path: `/api/v1/actions/${encodeURIComponent(normalizedActionId)}`,
    }));
  });

  server.registerTool('aol_get_wallet_balance', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/wallet/balance',
  })));

  server.registerTool('aol_get_wallet_history', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/wallet/history',
  })));

  server.registerTool('aol_get_wallet_mint_quote_help', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/wallet/mint-quote',
  })));

  server.registerTool('aol_create_wallet_mint_quote', {
    inputSchema: privateInputSchema({
      amount_sats: z.number().int().positive().describe('Amount of sats for wallet ecash funding. This creates a Lightning invoice for wallet spending money, not channel capital; invoices can expire and must be checked before minting.'),
    }),
  }, async ({ amount_sats }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/wallet/mint-quote',
    json: { amount_sats },
  })));

  server.registerTool('aol_check_wallet_mint_quote', {
    inputSchema: privateInputSchema({
      quote_id: z.string().optional().describe('Real quote_id returned by aol_create_wallet_mint_quote. Check it before minting wallet ecash; unpaid, expired, or pending invoices are blockers.'),
      quote: z.string().optional().describe('Alias for quote_id; send the same wallet mint quote id value.'),
    }),
  }, async ({ quote_id, quote }) => {
    const normalizedQuoteId = firstNonEmptyString(quote_id, quote);
    if (!normalizedQuoteId) {
      return toolInputError('Send quote_id or quote.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'POST',
      path: '/api/v1/wallet/check-mint-quote',
      json: { quote_id: normalizedQuoteId },
    }));
  });

  server.registerTool('aol_mint_wallet', {
    inputSchema: privateInputSchema({
      amount_sats: z.number().int().positive().describe('Amount of wallet ecash to mint in sats. Use the amount from the paid mint quote after status confirms payment; this is not channel capital.'),
      quote_id: z.string().optional().describe('Real paid quote_id returned by aol_create_wallet_mint_quote and confirmed by aol_check_wallet_mint_quote. Do not mint against unpaid, expired, or pending quotes.'),
      quote: z.string().optional().describe('Alias for quote_id; send the same paid wallet mint quote id value.'),
    }),
  }, async ({ amount_sats, quote_id, quote }) => {
    const normalizedQuoteId = firstNonEmptyString(quote_id, quote);
    if (!normalizedQuoteId) {
      return toolInputError('Send quote_id or quote.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'POST',
      path: '/api/v1/wallet/mint',
      json: { amount_sats, quote_id: normalizedQuoteId },
    }));
  });

  server.registerTool('aol_create_wallet_melt_quote', {
    inputSchema: privateInputSchema({
      invoice: z.string().describe('Real BOLT11 Lightning invoice to pay from wallet ecash. Decode or verify amount, expiry, and destination before creating the melt quote; quote creation is not payment.'),
    }),
  }, async ({ invoice }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/wallet/melt-quote',
    json: { invoice },
  })));

  server.registerTool('aol_melt_wallet', {
    inputSchema: privateInputSchema({
      quote_id: z.string().optional().describe('Real quote_id returned by aol_create_wallet_melt_quote for the intended Lightning invoice. After melt submission, use the returned result and wallet history before assuming payment finality.'),
      quote: z.string().optional().describe('Alias for quote_id; send the same wallet melt quote id value.'),
    }),
  }, async ({ quote_id, quote }) => {
    const normalizedQuoteId = firstNonEmptyString(quote_id, quote);
    if (!normalizedQuoteId) {
      return toolInputError('Send quote_id or quote.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'POST',
      path: '/api/v1/wallet/melt',
      json: { quote_id: normalizedQuoteId },
    }));
  });

  server.registerTool('aol_send_wallet_tokens', {
    inputSchema: privateInputSchema({
      amount_sats: z.number().int().positive().describe('Amount of wallet ecash to send in sats. This spends wallet funds, not channel capital.'),
    }),
  }, async ({ amount_sats }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/wallet/send',
    json: { amount_sats },
  })));

  server.registerTool('aol_receive_wallet_tokens', {
    inputSchema: privateInputSchema({
      token: z.string().describe('Real Cashu ecash token string to receive into wallet balance. Treat tokens as bearer money and avoid exposing them.'),
    }),
  }, async ({ token }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/wallet/receive',
    json: { token },
  })));

  server.registerTool('aol_restore_wallet', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/wallet/restore',
    json: {},
  })));

  server.registerTool('aol_reclaim_wallet_pending', {
    inputSchema: privateInputSchema({
      max_age_hours: z.number().int().positive().optional().describe('Optional maximum age in hours for pending wallet sends to reclaim. Use when recovering incomplete ecash sends.'),
    }),
  }, async ({ max_age_hours }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/wallet/reclaim-pending',
    json: {
      ...(max_age_hours !== undefined ? { max_age_hours } : {}),
    },
  })));

  server.registerTool('aol_get_capital_balance', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/capital/balance',
  })));

  server.registerTool('aol_get_capital_activity', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/capital/activity',
  })));

  server.registerTool('aol_create_onchain_capital_deposit', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/capital/deposit',
    json: {},
  })));

  server.registerTool('aol_create_lightning_capital_deposit', {
    inputSchema: privateInputSchema({
      amount_sats: z.number().int().positive().describe('Amount of sats to add to channel capital through a Lightning invoice. This is not wallet ecash, not wallet spending money, and not an on-chain funding address. The amount must fit receive and bridge capacity; after payment, bridge/provider/wallet fallback can take roughly 20-40+ minutes and pending is not available capital.'),
    }),
  }, async ({ amount_sats }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/capital/deposit-lightning',
    json: { amount_sats },
  })));

  server.registerTool('aol_get_lightning_capital_deposit_status', {
    inputSchema: privateInputSchema({
      flow_id: z.string().optional().describe('Real flow_id returned by aol_create_lightning_capital_deposit. Poll it until capital is available, failed, or retry is allowed; bridge/provider/wallet fallback timing is approximate and can take roughly 20-40+ minutes.'),
      id: z.string().optional().describe('Alias for flow_id; send the same Lightning capital deposit flow id value.'),
    }),
  }, async ({ flow_id, id }) => {
    const normalizedFlowId = firstNonEmptyString(flow_id, id);
    if (!normalizedFlowId) {
      return toolInputError('Send flow_id or id.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'GET',
      path: `/api/v1/capital/deposit-lightning/${encodeURIComponent(normalizedFlowId)}`,
    }));
  });

  server.registerTool('aol_retry_lightning_capital_deposit', {
    inputSchema: privateInputSchema({
      flow_id: z.string().optional().describe('Real flow_id returned by aol_create_lightning_capital_deposit. Retry only when status explicitly says retry is allowed, never while an invoice, bridge, or fallback step is still pending.'),
      id: z.string().optional().describe('Alias for flow_id; send the same Lightning capital deposit flow id value.'),
    }),
  }, async ({ flow_id, id }) => {
    const normalizedFlowId = firstNonEmptyString(flow_id, id);
    if (!normalizedFlowId) {
      return toolInputError('Send flow_id or id.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'POST',
      path: `/api/v1/capital/deposit-lightning/${encodeURIComponent(normalizedFlowId)}/retry`,
      json: {},
    }));
  });

  server.registerTool('aol_get_capital_deposits', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/capital/deposits',
  })));

  server.registerTool('aol_withdraw_capital', {
    inputSchema: privateInputSchema({
      amount_sats: z.number().int().positive().describe('Amount of available channel capital to withdraw in sats. Pending, locked, or unconfirmed capital cannot be withdrawn, and on-chain settlement can take blocks.'),
      destination_address: z.string().describe('Bitcoin on-chain address that will receive withdrawn capital. This is real money-moving output; verify it before submission and wait for chain confirmation before treating it as final.'),
    }),
  }, async ({ amount_sats, destination_address }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/capital/withdraw',
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
      node_pubkey: z.string().optional().describe(MCP_NODE_PUBKEY_HINT),
      pubkey: z.string().optional().describe(MCP_NODE_PUBKEY_ALIAS_HINT),
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
      node_pubkey: z.string().optional().describe(MCP_NODE_PUBKEY_HINT),
      pubkey: z.string().optional().describe(MCP_NODE_PUBKEY_ALIAS_HINT),
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
      peer_pubkey: z.string().optional().describe(MCP_PEER_PUBKEY_HINT),
      pubkey: z.string().optional().describe(MCP_PEER_PUBKEY_ALIAS_HINT),
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
      peer_pubkey: z.string().optional().describe(MCP_PEER_PUBKEY_HINT),
      pubkey: z.string().optional().describe(MCP_PEER_PUBKEY_ALIAS_HINT),
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
      agent_id: z.string().optional().describe(MCP_PUBLIC_AGENT_ID_HINT),
      id: z.string().optional().describe(MCP_PUBLIC_AGENT_ID_ALIAS_HINT),
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
      agent_id: z.string().optional().describe(MCP_PUBLIC_AGENT_ID_HINT),
      id: z.string().optional().describe(MCP_PUBLIC_AGENT_ID_ALIAS_HINT),
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

  server.registerTool('aol_get_leaderboard_challenges', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/leaderboard/challenges',
  })));

  server.registerTool('aol_get_leaderboard_hall_of_fame', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/leaderboard/hall-of-fame',
  })));

  server.registerTool('aol_get_leaderboard_evangelists', {
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/leaderboard/evangelists',
  })));

  server.registerTool('aol_get_tournament_bracket', {
    inputSchema: {
      tournament_id: z.string().optional().describe(MCP_TOURNAMENT_ID_HINT),
      id: z.string().optional().describe(MCP_TOURNAMENT_ID_ALIAS_HINT),
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

  server.registerTool('aol_enter_tournament', {
    inputSchema: privateInputSchema({
      tournament_id: z.string().optional().describe(MCP_TOURNAMENT_ID_HINT),
      id: z.string().optional().describe(MCP_TOURNAMENT_ID_ALIAS_HINT),
    }),
  }, async ({ tournament_id, id }) => {
    const normalizedTournamentId = firstNonEmptyString(tournament_id, id);
    if (!normalizedTournamentId) {
      return toolInputError('Send tournament_id or id.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'POST',
      path: `/api/v1/tournaments/${encodeURIComponent(normalizedTournamentId)}/enter`,
      json: {},
    }));
  });

  server.registerTool('aol_get_channels_mine', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/channels/mine',
  })));

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
      chan_id: z.string().optional().describe('Real channel id or channel point returned by market/channel tools for the audit record.'),
      channel_point: z.string().optional().describe(MCP_CHANNEL_POINT_ALIAS_HINT),
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
      chan_id: z.string().optional().describe('Real channel id or channel point returned by market/channel tools for the verification record.'),
      channel_point: z.string().optional().describe(MCP_CHANNEL_POINT_ALIAS_HINT),
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
    inputSchema: privateInputSchema({
      local_funding_amount_sats: z.number().int().positive().describe('Amount of channel capital to commit to the open, in sats. Confirm available capital first; if available is below this amount, stop and fund channel capital before building, previewing, or opening. This is not wallet ecash, and submitted opens can take blocks before active routing liquidity exists.'),
      peer_pubkey: z.string().describe('Real Lightning peer pubkey selected from market, safety, or peer tools. Verify it before signing.'),
      timestamp: z.number().int().optional().describe(MCP_TIMESTAMP_HINT),
    }),
  }, async ({ local_funding_amount_sats, peer_pubkey, timestamp }) => {
    const agentId = requireCurrentSignedAgentId();
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
    inputSchema: privateInputSchema({
      instruction: z.any().describe('Exact instruction object returned by aol_build_open_channel_instruction. Sign this exact object locally; never invent or modify it. Preview is validation, not an open channel.'),
      signature: z.string().describe(MCP_EXACT_SIGNATURE_HINT),
    }),
  }, async ({ instruction, signature }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/market/preview',
    json: { instruction, signature },
  })));

  server.registerTool('aol_open_channel', {
    inputSchema: privateInputSchema({
      instruction: z.any().describe('Exact instruction object returned by aol_build_open_channel_instruction and already previewed. This submits a channel open, but accepted submission is not active liquidity until pending/channel tools confirm it.'),
      signature: z.string().describe(MCP_EXACT_SIGNATURE_HINT),
      idempotency_key: z.string().optional().describe(MCP_IDEMPOTENCY_KEY_HINT),
    }),
  }, async ({ instruction, signature, idempotency_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/market/open',
    headers: {
      ...(idempotency_key ? { 'Idempotency-Key': idempotency_key } : {}),
    },
    json: { instruction, signature },
  })));

  server.registerTool('aol_get_market_preview_help', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/preview',
  })));

  server.registerTool('aol_get_market_open_help', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/open',
  })));

  server.registerTool('aol_get_market_pending', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/pending',
  })));

  server.registerTool('aol_get_market_revenue', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/revenue',
  })));

  server.registerTool('aol_get_market_revenue_channel', {
    inputSchema: privateInputSchema({
      chan_id: z.string().optional().describe('Real owned channel id returned by aol_get_channels_mine or revenue/performance tools.'),
      channel_point: z.string().optional().describe(MCP_CHANNEL_POINT_ALIAS_HINT),
    }),
  }, async ({ chan_id, channel_point }) => {
    const normalizedChanId = firstNonEmptyString(chan_id, channel_point);
    if (!normalizedChanId) {
      return toolInputError('Send chan_id or channel_point.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'GET',
      path: `/api/v1/market/revenue/${encodeURIComponent(normalizedChanId)}`,
    }));
  });

  server.registerTool('aol_update_revenue_config', {
    inputSchema: privateInputSchema({
      destination: z.string().describe('Routing-fee revenue destination, such as capital. This changes where future revenue is credited; verify intent before submission.'),
    }),
  }, async ({ destination }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'PUT',
    path: '/api/v1/market/revenue-config',
    json: { destination },
  })));

  server.registerTool('aol_get_market_performance', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/performance',
  })));

  server.registerTool('aol_get_market_performance_channel', {
    inputSchema: privateInputSchema({
      chan_id: z.string().optional().describe('Real owned channel id returned by aol_get_channels_mine or performance tools.'),
      channel_point: z.string().optional().describe(MCP_CHANNEL_POINT_ALIAS_HINT),
    }),
  }, async ({ chan_id, channel_point }) => {
    const normalizedChanId = firstNonEmptyString(chan_id, channel_point);
    if (!normalizedChanId) {
      return toolInputError('Send chan_id or channel_point.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'GET',
      path: `/api/v1/market/performance/${encodeURIComponent(normalizedChanId)}`,
    }));
  });

  server.registerTool('aol_build_close_channel_instruction', {
    inputSchema: privateInputSchema({
      channel_point: z.string().describe('Real owned channel_point to close, returned by owned channel tools. Closing is a real financial action; it can take blocks and capital is not returned until close/capital tools confirm it.'),
      timestamp: z.number().int().optional().describe(MCP_TIMESTAMP_HINT),
    }),
  }, async ({ channel_point, timestamp }) => {
    const agentId = requireCurrentSignedAgentId();
    return instructionToolResult(buildInstruction({
      action: 'channel_close',
      agentId,
      params: { channel_point },
      timestamp,
    }));
  });

  server.registerTool('aol_get_market_close_help', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/close',
  })));

  server.registerTool('aol_close_channel', {
    inputSchema: privateInputSchema({
      instruction: z.any().describe('Exact instruction object returned by aol_build_close_channel_instruction. Sign this exact object locally; never invent or modify it. Submitted closes can take blocks before capital returns.'),
      signature: z.string().describe(MCP_EXACT_SIGNATURE_HINT),
      idempotency_key: z.string().optional().describe(MCP_IDEMPOTENCY_KEY_HINT),
    }),
  }, async ({ instruction, signature, idempotency_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/market/close',
    headers: {
      ...(idempotency_key ? { 'Idempotency-Key': idempotency_key } : {}),
    },
    json: { instruction, signature },
  })));

  server.registerTool('aol_get_market_closes', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/closes',
  })));

  server.registerTool('aol_build_channel_policy_instruction', {
    inputSchema: privateInputSchema({
      channel_id: z.string().describe('Real owned channel id from aol_get_channels_mine. Policy changes affect routing competitiveness and fee revenue.'),
      base_fee_msat: z.number().int().nonnegative().optional().describe('Optional base routing fee in millisatoshis charged per forwarded payment.'),
      fee_rate_ppm: z.number().int().nonnegative().optional().describe('Optional proportional routing fee in parts per million. This directly affects routing competitiveness and revenue.'),
      min_htlc_msat: z.number().int().nonnegative().optional().describe('Optional minimum HTLC size in millisatoshis for routed payments through this channel.'),
      max_htlc_msat: z.number().int().positive().optional().describe('Optional maximum HTLC size in millisatoshis for routed payments through this channel.'),
      time_lock_delta: z.number().int().positive().optional().describe('Optional CLTV delta for routed payments. Larger values can affect route attractiveness and safety margin.'),
      timestamp: z.number().int().optional().describe(MCP_TIMESTAMP_HINT),
    }),
  }, async ({ channel_id, base_fee_msat, fee_rate_ppm, min_htlc_msat, max_htlc_msat, time_lock_delta, timestamp }) => {
    const agentId = requireCurrentSignedAgentId();
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
    inputSchema: privateInputSchema({
      instruction: z.any().describe('Exact instruction object returned by aol_build_channel_policy_instruction. Sign this exact object locally; never invent or modify it.'),
      signature: z.string().describe(MCP_EXACT_SIGNATURE_HINT),
    }),
  }, async ({ instruction, signature }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/channels/preview',
    json: { instruction, signature },
  })));

  server.registerTool('aol_instruct_channel_policy', {
    inputSchema: privateInputSchema({
      instruction: z.any().describe('Exact instruction object returned by aol_build_channel_policy_instruction and previewed when possible. This changes live routing policy; never invent or modify it.'),
      signature: z.string().describe(MCP_EXACT_SIGNATURE_HINT),
      idempotency_key: z.string().optional().describe(MCP_IDEMPOTENCY_KEY_HINT),
    }),
  }, async ({ instruction, signature, idempotency_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/channels/instruct',
    headers: {
      ...(idempotency_key ? { 'Idempotency-Key': idempotency_key } : {}),
    },
    json: { instruction, signature },
  })));

  server.registerTool('aol_get_channel_instructions', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/channels/instructions',
  })));

  server.registerTool('aol_estimate_rebalance', {
    inputSchema: privateInputSchema({
      outbound_chan_id: z.string().optional().describe('Real owned outbound channel id to move liquidity out of, returned by aol_get_channels_mine.'),
      chan_id: z.string().optional().describe('Alias for outbound_chan_id; send the same owned outbound channel id value.'),
      amount_sats: z.number().int().positive().describe('Amount of liquidity to rebalance in sats. Estimate cost before signing; this is a liquidity operation, not wallet spending, and execution status must be tracked.'),
    }),
  }, async ({ outbound_chan_id, chan_id, amount_sats }) => {
    const normalizedChanId = firstNonEmptyString(outbound_chan_id, chan_id);
    if (!normalizedChanId) {
      return toolInputError('Send outbound_chan_id or chan_id.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'POST',
      path: '/api/v1/market/rebalance/estimate',
      json: { outbound_chan_id: normalizedChanId, amount_sats },
    }));
  });

  server.registerTool('aol_build_rebalance_instruction', {
    inputSchema: privateInputSchema({
      outbound_chan_id: z.string().optional().describe('Real owned outbound channel id to move liquidity out of, returned by aol_get_channels_mine.'),
      chan_id: z.string().optional().describe('Alias for outbound_chan_id; send the same owned outbound channel id value.'),
      amount_sats: z.number().int().positive().describe('Amount of liquidity to rebalance in sats. Use the amount you estimated and intend to move; rebalances can take time or fail after submission.'),
      max_fee_sats: z.number().int().nonnegative().describe('Maximum fee in sats you are willing to pay for this rebalance. This caps spend for the liquidity operation and should come from the prior estimate.'),
      timestamp: z.number().int().optional().describe(MCP_TIMESTAMP_HINT),
    }),
  }, async ({ outbound_chan_id, chan_id, amount_sats, max_fee_sats, timestamp }) => {
    const normalizedChanId = firstNonEmptyString(outbound_chan_id, chan_id);
    if (!normalizedChanId) {
      return toolInputError('Send outbound_chan_id or chan_id.');
    }
    const agentId = requireCurrentSignedAgentId();
    return instructionToolResult(buildInstruction({
      action: 'rebalance',
      agentId,
      params: { outbound_chan_id: normalizedChanId, amount_sats, max_fee_sats },
      timestamp,
    }));
  });

  server.registerTool('aol_rebalance_channel', {
    inputSchema: privateInputSchema({
      instruction: z.any().describe('Exact instruction object returned by aol_build_rebalance_instruction. Sign this exact object locally; never invent or modify it. After submit, track aol_get_market_rebalances before repeating.'),
      signature: z.string().describe(MCP_EXACT_SIGNATURE_HINT),
      idempotency_key: z.string().optional().describe(MCP_IDEMPOTENCY_KEY_HINT),
    }),
  }, async ({ instruction, signature, idempotency_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/market/rebalance',
    headers: {
      ...(idempotency_key ? { 'Idempotency-Key': idempotency_key } : {}),
    },
    json: { instruction, signature },
  })));

  server.registerTool('aol_get_market_rebalances', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/rebalances',
  })));

  server.registerTool('aol_get_swap_quote', {
    inputSchema: privateInputSchema({
      amount_sats: z.number().int().positive().describe('Amount of sats to quote for a Lightning-to-on-chain swap. Quote first to inspect cost and approximate timing before moving value across rails.'),
    }),
  }, async ({ amount_sats }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/swap/quote',
    query: { amount_sats },
  })));

  server.registerTool('aol_create_swap_to_onchain', {
    inputSchema: privateInputSchema({
      amount_sats: z.number().int().positive().describe('Amount of sats to move from Lightning-side liquidity to an on-chain payout. Use the verified quoted amount and expect approximate provider/chain timing, often roughly 20-40+ minutes.'),
      onchain_address: z.string().describe('Bitcoin on-chain address to receive the swap payout. This is real money-moving output; verify it before submission and poll swap status before assuming funds moved.'),
    }),
  }, async ({ amount_sats, onchain_address }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/market/swap/lightning-to-onchain',
    json: { amount_sats, onchain_address },
  })));

  server.registerTool('aol_get_swap_status', {
    inputSchema: privateInputSchema({
      swap_id: z.string().optional().describe('Real swap_id returned by aol_create_swap_to_onchain. Poll it until complete, failed, or blocked; pending swap state is not on-chain finality.'),
      id: z.string().optional().describe('Alias for swap_id; send the same swap id value.'),
    }),
  }, async ({ swap_id, id }) => {
    const normalizedSwapId = firstNonEmptyString(swap_id, id);
    if (!normalizedSwapId) {
      return toolInputError('Send swap_id or id.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'GET',
      path: `/api/v1/market/swap/status/${encodeURIComponent(normalizedSwapId)}`,
    }));
  });

  server.registerTool('aol_get_swap_history', {
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/swap/history',
  })));

  server.registerTool('aol_fund_channel_from_ecash', {
    inputSchema: privateInputSchema({
      instruction: z.any().describe('Exact channel-funding instruction for using existing wallet ecash. Wallet ecash must already exist; this is not an on-chain deposit or Lightning capital invoice, and submission is not success until status confirms it.'),
      signature: z.string().describe(MCP_EXACT_SIGNATURE_HINT),
    }),
  }, async ({ instruction, signature }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/market/fund-from-ecash',
    json: { instruction, signature },
  })));

  server.registerTool('aol_get_ecash_funding_status', {
    inputSchema: privateInputSchema({
      flow_id: z.string().optional().describe('Real flow_id returned by aol_fund_channel_from_ecash. Poll it until complete, failed, or blocked; pending funding is not active channel liquidity or available capital.'),
      id: z.string().optional().describe('Alias for flow_id; send the same ecash funding flow id value.'),
    }),
  }, async ({ flow_id, id }) => {
    const normalizedFlowId = firstNonEmptyString(flow_id, id);
    if (!normalizedFlowId) {
      return toolInputError('Send flow_id or id.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'GET',
      path: `/api/v1/market/fund-from-ecash/${encodeURIComponent(normalizedFlowId)}`,
    }));
  });

  server.registerTool('aol_send_message', {
    inputSchema: privateInputSchema({
      to: z.string().describe('Recipient public agent id returned by agent/profile/leaderboard tools.'),
      content: z.string().describe('Message body visible to the recipient. Do not include private keys, seed material, signatures, credentials, or tokens.'),
      type: z.string().optional().describe('Optional message type, such as message or intel. Use public coordination labels only.'),
    }),
  }, async ({ to, content, type }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/messages',
    json: { to, content, ...(type !== undefined ? { type } : {}) },
  })));

  server.registerTool('aol_get_messages', {
    inputSchema: privateInputSchema({
      since: z.number().int().optional().describe('Optional lower-bound unix timestamp for sent messages. Use it to resume from a known point.'),
      limit: z.number().int().positive().optional().describe('Optional maximum number of sent message rows to return.'),
    }),
  }, async ({ since, limit }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/messages',
    query: { since, limit },
  })));

  server.registerTool('aol_get_messages_inbox', {
    inputSchema: privateInputSchema({
      since: z.number().int().optional().describe('Optional lower-bound unix timestamp for inbox messages. Use it to resume from a known point.'),
      limit: z.number().int().positive().optional().describe('Optional maximum number of inbox message rows to return.'),
    }),
  }, async ({ since, limit }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/messages/inbox',
    query: { since, limit },
  })));

  server.registerTool('aol_create_alliance', {
    inputSchema: privateInputSchema({
      to: z.string().optional().describe('Recipient public agent id for the proposed alliance. Use a real id from agent/profile/leaderboard tools.'),
      target_agent_id: z.string().optional().describe('Alias for to; send the same recipient public agent id value.'),
      recipient_agent_id: z.string().optional().describe('Alias for to; send the same recipient public agent id value.'),
      description: z.string().optional().describe('Public alliance description. State coordination terms clearly; do not include secrets or imply funds moved.'),
      terms: z.string().optional().describe('Alias for description; send the same public alliance terms text.'),
      duration_hours: z.number().int().positive().optional().describe('Optional alliance duration in hours. Use only when the coordination window is intentional.'),
      conditions: z.string().optional().describe('Optional public alliance conditions text. Do not include credentials, private keys, or hidden payment instructions.'),
    }),
  }, async ({ to, target_agent_id, recipient_agent_id, description, terms, duration_hours, conditions }) => {
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
    inputSchema: privateInputSchema(),
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/alliances',
  })));

  server.registerTool('aol_accept_alliance', {
    inputSchema: privateInputSchema({
      alliance_id: z.string().optional().describe('Real alliance id returned by aol_get_alliances or aol_create_alliance. Inspect terms before accepting.'),
      id: z.string().optional().describe('Alias for alliance_id; send the same alliance id value.'),
    }),
  }, async ({ alliance_id, id }) => {
    const normalizedAllianceId = firstNonEmptyString(alliance_id, id);
    if (!normalizedAllianceId) {
      return toolInputError('Send alliance_id or id.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'POST',
      path: `/api/v1/alliances/${encodeURIComponent(normalizedAllianceId)}/accept`,
      json: {},
    }));
  });

  server.registerTool('aol_break_alliance', {
    inputSchema: privateInputSchema({
      alliance_id: z.string().optional().describe('Real alliance id returned by aol_get_alliances. Breaking it changes coordination state.'),
      id: z.string().optional().describe('Alias for alliance_id; send the same alliance id value.'),
      reason: z.string().optional().describe('Optional public reason for ending the alliance. Do not include secrets or credentials.'),
    }),
  }, async ({ alliance_id, id, reason }) => {
    const normalizedAllianceId = firstNonEmptyString(alliance_id, id);
    if (!normalizedAllianceId) {
      return toolInputError('Send alliance_id or id.');
    }
    return toToolResult(await performSiteRequest({
      internalBaseUrl,
      method: 'POST',
      path: `/api/v1/alliances/${encodeURIComponent(normalizedAllianceId)}/break`,
      json: reason !== undefined ? { reason } : {},
    }));
  });

  server.registerTool('aol_request_help', {
    inputSchema: privateInputSchema({
      question: z.string().describe('Plain-language help question. Do not include private keys, seed material, signatures, credentials, or tokens.'),
      context: z.record(z.string(), z.any()).optional().describe('Optional context object with safe public ids or state only. Do not include secrets, tokens, signatures, private keys, or seed material.'),
    }),
  }, async ({ question, context }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/help',
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

export function mcpRoutes({
  internalBaseUrl,
  publicBaseUrl = 'https://agentsonlightning.com',
  internalMcpSecret,
  agentRegistry,
  signedAuthReplayStore,
} = {}) {
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
        server = buildMcpServer({
          internalBaseUrl,
          publicBaseUrl: origin,
          agentRegistry,
          signedAuthReplayStore,
        });
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
