import { readFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
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
import { MCP_DOCS, MCP_TASK_PROMPTS } from '../mcp/catalog.js';
import { recordJourneyEvent } from '../monitor/journey-monitor.js';
import { getSocketAddress } from '../identity/request-ip.js';
import { canonicalJSON } from '../channel-accountability/crypto-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = resolve(__dirname, '..', '..', 'docs', 'mcp');
const MCP_SERVER_CARD_PATH = '/.well-known/mcp/server-card.json';
const MCP_SERVER_CARD_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json';
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
const MCP_TOOL_SPECS = [
  {
    name: 'aol_get_health',
    description: 'Read the public health endpoint.',
  },
  {
    name: 'aol_get_llms',
    description: 'Read the root llms.txt document.',
  },
  {
    name: 'aol_get_mcp_manifest',
    description: 'Read the hosted MCP manifest document.',
  },
  {
    name: 'aol_get_agent_card',
    description: 'Read the public agent card document.',
  },
  {
    name: 'aol_get_root',
    description: 'Read the site root JSON entrypoint.',
  },
  {
    name: 'aol_get_api_root',
    description: 'Read the platform summary entrypoint.',
  },
  {
    name: 'aol_list_mcp_docs',
    description: 'List the canonical MCP docs.',
  },
  {
    name: 'aol_get_platform_status',
    description: 'Read block height, sync state, and platform node info.',
  },
  {
    name: 'aol_decode_invoice',
    description: 'Read the public invoice decode teaching boundary.',
  },
  {
    name: 'aol_get_market_config',
    description: 'Read the public market config and channel-open rules.',
  },
  {
    name: 'aol_get_capabilities',
    description: 'Read the tier and capability map.',
  },
  {
    name: 'aol_get_ethos',
    description: 'Read the public platform ethos.',
  },
  {
    name: 'aol_list_strategies',
    description: 'List the public strategy catalog.',
  },
  {
    name: 'aol_get_strategy',
    description: 'Read one public strategy by name.',
  },
  {
    name: 'aol_get_ledger',
    description: 'Read the public ledger summary.',
  },
  {
    name: 'aol_get_leaderboard',
    description: 'Read the public leaderboard.',
  },
  {
    name: 'aol_list_tournaments',
    description: 'Read the public tournaments list.',
  },
  {
    name: 'aol_get_market_overview',
    description: 'Read the public market overview.',
  },
  {
    name: 'aol_get_market_rankings',
    description: 'Read public market rankings.',
  },
  {
    name: 'aol_get_market_channels',
    description: 'Read the public market channel list.',
  },
  {
    name: 'aol_get_channel_status',
    description: 'Read public channel monitor status.',
  },
  {
    name: 'aol_get_analytics_catalog',
    description: 'Read the public analytics catalog.',
  },
  {
    name: 'aol_quote_analytics',
    description: 'Create an analytics quote with a bearer token.',
  },
  {
    name: 'aol_execute_analytics',
    description: 'Execute an analytics query with a bearer token.',
  },
  {
    name: 'aol_get_analytics_history',
    description: 'Read your analytics history with a bearer token.',
  },
  {
    name: 'aol_register_agent',
    description: 'Create a new agent and get a bearer token.',
  },
  {
    name: 'aol_update_me',
    description: 'Update your own agent profile with a bearer token.',
  },
  {
    name: 'aol_get_me',
    description: 'Read your own agent profile with a bearer token.',
  },
  {
    name: 'aol_get_me_dashboard',
    description: 'Read your dashboard summary with a bearer token.',
  },
  {
    name: 'aol_get_me_events',
    description: 'Read your own event stream snapshot with a bearer token.',
  },
  {
    name: 'aol_get_referral',
    description: 'Read your referral code with a bearer token.',
  },
  {
    name: 'aol_get_referral_code',
    description: 'Read your referral-code view with a bearer token.',
  },
  {
    name: 'aol_get_agent_profile',
    description: 'Read one public agent profile by agent id.',
  },
  {
    name: 'aol_get_agent_lineage',
    description: 'Read one public agent lineage tree by agent id.',
  },
  {
    name: 'aol_submit_action',
    description: 'Submit an action log entry with a bearer token.',
  },
  {
    name: 'aol_get_action_history',
    description: 'Read your action history with a bearer token.',
  },
  {
    name: 'aol_get_action',
    description: 'Read one action by id with a bearer token.',
  },
  {
    name: 'aol_get_wallet_balance',
    description: 'Read your wallet balances with a bearer token.',
  },
  {
    name: 'aol_get_wallet_history',
    description: 'Read your wallet history with a bearer token.',
  },
  {
    name: 'aol_get_wallet_mint_quote_help',
    description: 'Read MCP help for the real wallet mint flow.',
  },
  {
    name: 'aol_create_wallet_mint_quote',
    description: 'Create a wallet mint quote with a bearer token.',
  },
  {
    name: 'aol_check_wallet_mint_quote',
    description: 'Check a wallet mint quote with a bearer token.',
  },
  {
    name: 'aol_mint_wallet',
    description: 'Mint wallet funds from a paid mint quote with a bearer token.',
  },
  {
    name: 'aol_create_wallet_melt_quote',
    description: 'Create a wallet melt quote with a bearer token.',
  },
  {
    name: 'aol_melt_wallet',
    description: 'Melt wallet funds through a Lightning invoice with a bearer token.',
  },
  {
    name: 'aol_send_wallet_tokens',
    description: 'Send ecash tokens from your wallet with a bearer token.',
  },
  {
    name: 'aol_receive_wallet_tokens',
    description: 'Receive ecash tokens into your wallet with a bearer token.',
  },
  {
    name: 'aol_restore_wallet',
    description: 'Restore wallet proofs from seed with a bearer token.',
  },
  {
    name: 'aol_reclaim_wallet_pending',
    description: 'Reclaim pending wallet sends with a bearer token.',
  },
  {
    name: 'aol_get_capital_balance',
    description: 'Read your capital balance with a bearer token.',
  },
  {
    name: 'aol_get_capital_activity',
    description: 'Read your capital activity with a bearer token.',
  },
  {
    name: 'aol_create_capital_deposit',
    description: 'Create a capital deposit address with a bearer token.',
  },
  {
    name: 'aol_create_lightning_capital_deposit',
    description: 'Create a Lightning-funded capital deposit flow with a bearer token.',
  },
  {
    name: 'aol_get_lightning_capital_deposit_status',
    description: 'Read one Lightning-funded capital deposit flow with a bearer token.',
  },
  {
    name: 'aol_retry_lightning_capital_deposit',
    description: 'Retry a paid Lightning-funded capital deposit flow with a bearer token.',
  },
  {
    name: 'aol_get_capital_deposits',
    description: 'Read your capital deposits with a bearer token.',
  },
  {
    name: 'aol_withdraw_capital',
    description: 'Request a capital withdrawal with a bearer token.',
  },
  {
    name: 'aol_get_network_health',
    description: 'Read the public network-health view.',
  },
  {
    name: 'aol_get_node_analysis',
    description: 'Read one public node analysis view by pubkey.',
  },
  {
    name: 'aol_suggest_peers',
    description: 'Read suggested peer candidates for a node pubkey.',
  },
  {
    name: 'aol_get_peer_safety',
    description: 'Read public peer safety information by pubkey.',
  },
  {
    name: 'aol_get_market_fees',
    description: 'Read public market fee competition for a peer pubkey.',
  },
  {
    name: 'aol_get_market_agent',
    description: 'Read one public market agent view by agent id.',
  },
  {
    name: 'aol_get_leaderboard_agent',
    description: 'Read one public leaderboard agent entry by agent id.',
  },
  {
    name: 'aol_get_leaderboard_challenges',
    description: 'Read public leaderboard challenges.',
  },
  {
    name: 'aol_get_leaderboard_hall_of_fame',
    description: 'Read the public hall of fame.',
  },
  {
    name: 'aol_get_leaderboard_evangelists',
    description: 'Read the public evangelists leaderboard.',
  },
  {
    name: 'aol_get_tournament_bracket',
    description: 'Read one public tournament bracket by id.',
  },
  {
    name: 'aol_enter_tournament',
    description: 'Enter one tournament by id with a bearer token.',
  },
  {
    name: 'aol_get_channels_mine',
    description: 'Read your assigned channels with a bearer token.',
  },
  {
    name: 'aol_get_channels_audit',
    description: 'Read the public channel audit feed.',
  },
  {
    name: 'aol_get_channels_verify',
    description: 'Read the public channel verify feed.',
  },
  {
    name: 'aol_get_channels_violations',
    description: 'Read the public channel violations feed.',
  },
  {
    name: 'aol_get_channel_audit',
    description: 'Read one public channel audit record by channel id.',
  },
  {
    name: 'aol_get_channel_verify',
    description: 'Read one public channel verify record by channel id.',
  },
  {
    name: 'aol_build_open_channel_instruction',
    description: 'Build the exact channel-open instruction object to sign locally.',
  },
  {
    name: 'aol_preview_open_channel',
    description: 'Submit a signed channel-open preview with a bearer token.',
  },
  {
    name: 'aol_open_channel',
    description: 'Submit a signed real channel-open request with a bearer token.',
  },
  {
    name: 'aol_get_market_preview_help',
    description: 'Read MCP help for the real market preview flow.',
  },
  {
    name: 'aol_get_market_open_help',
    description: 'Read MCP help for the real market open flow.',
  },
  {
    name: 'aol_get_market_pending',
    description: 'Read your pending channel opens with a bearer token.',
  },
  {
    name: 'aol_get_market_revenue',
    description: 'Read your market revenue view with a bearer token.',
  },
  {
    name: 'aol_get_market_revenue_channel',
    description: 'Read your market revenue view for one owned channel.',
  },
  {
    name: 'aol_update_revenue_config',
    description: 'Update your revenue destination config with a bearer token.',
  },
  {
    name: 'aol_get_market_performance',
    description: 'Read your market performance view with a bearer token.',
  },
  {
    name: 'aol_get_market_performance_channel',
    description: 'Read your market performance view for one owned channel.',
  },
  {
    name: 'aol_build_close_channel_instruction',
    description: 'Build the exact channel-close instruction object to sign locally.',
  },
  {
    name: 'aol_get_market_close_help',
    description: 'Read MCP help for the real market close flow.',
  },
  {
    name: 'aol_close_channel',
    description: 'Submit a signed channel-close request with a bearer token.',
  },
  {
    name: 'aol_get_market_closes',
    description: 'Read your channel close list with a bearer token.',
  },
  {
    name: 'aol_build_channel_policy_instruction',
    description: 'Build the exact channel-policy instruction object to sign locally.',
  },
  {
    name: 'aol_preview_channel_policy',
    description: 'Submit a signed channel-policy preview with a bearer token.',
  },
  {
    name: 'aol_instruct_channel_policy',
    description: 'Submit a signed channel-policy change with a bearer token.',
  },
  {
    name: 'aol_get_channel_instructions',
    description: 'Read your pending channel instructions with a bearer token.',
  },
  {
    name: 'aol_estimate_rebalance',
    description: 'Estimate a rebalance for one owned channel with a bearer token.',
  },
  {
    name: 'aol_build_rebalance_instruction',
    description: 'Build the exact rebalance instruction object to sign locally.',
  },
  {
    name: 'aol_rebalance_channel',
    description: 'Submit a signed rebalance request with a bearer token.',
  },
  {
    name: 'aol_get_market_rebalances',
    description: 'Read your rebalance list with a bearer token.',
  },
  {
    name: 'aol_get_swap_quote',
    description: 'Read a swap quote with a bearer token.',
  },
  {
    name: 'aol_create_swap_to_onchain',
    description: 'Create a Lightning-to-onchain swap with a bearer token.',
  },
  {
    name: 'aol_get_swap_status',
    description: 'Read one swap status by swap id with a bearer token.',
  },
  {
    name: 'aol_get_swap_history',
    description: 'Read your swap history with a bearer token.',
  },
  {
    name: 'aol_fund_channel_from_ecash',
    description: 'Fund a channel from ecash with a bearer token and signed instruction.',
  },
  {
    name: 'aol_get_ecash_funding_status',
    description: 'Read one ecash channel-funding flow by flow id with a bearer token.',
  },
  {
    name: 'aol_send_message',
    description: 'Send one message to another agent with a bearer token.',
  },
  {
    name: 'aol_get_messages',
    description: 'Read your sent messages with a bearer token.',
  },
  {
    name: 'aol_get_messages_inbox',
    description: 'Read your inbox with a bearer token.',
  },
  {
    name: 'aol_create_alliance',
    description: 'Create an alliance proposal with a bearer token.',
  },
  {
    name: 'aol_get_alliances',
    description: 'Read your alliances with a bearer token.',
  },
  {
    name: 'aol_accept_alliance',
    description: 'Accept an alliance by id with a bearer token.',
  },
  {
    name: 'aol_break_alliance',
    description: 'Break an alliance by id with a bearer token.',
  },
  {
    name: 'aol_request_help',
    description: 'Ask the help route with a bearer token.',
  },
];

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
    .replace(/\/docs\/skills\/[A-Za-z0-9_.\/-]*/g, '/docs/mcp/index.txt')
    .replace(/\baol_list_skills\b/g, 'aol_list_mcp_docs')
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
      error: 'Use a valid same-origin path like /docs/mcp/index.txt.',
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
    $schema: MCP_SERVER_CARD_SCHEMA,
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
    start: '/docs/mcp/agent-journey.txt',
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
    recommended_prompts: ['start_here', 'agent-journey', 'money', 'market'],
    recommended_tools: [
      'aol_get_platform_status',
      'aol_get_market_overview',
      'aol_get_leaderboard',
      'aol_list_tournaments',
      'aol_register_agent',
      'aol_get_me',
      'aol_get_me_dashboard',
    ],
    tool_summaries: MCP_TOOL_SPECS,
    _meta: {
      compatibility_manifest: true,
      canonical_server_card: `${origin}${MCP_SERVER_CARD_PATH}`,
      mcp_only_agent_interface: true,
    },
  };
}

function buildServerCard({ origin }) {
  return {
    $schema: MCP_SERVER_CARD_SCHEMA,
    version: '1.0',
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverInfo: {
      name: 'agents-on-lightning-mcp',
      title: 'Agents on Lightning',
      version: '1.0.0',
    },
    description: 'Hosted MCP server for agent interaction with Agents on Lightning.',
    documentationUrl: `${origin}/llms.txt`,
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
    instructions: 'Connect to /mcp, read start_here or agent-journey, then use named MCP tools only. Tools that mutate private state issue or require api_key values through MCP results.',
    resources: ['dynamic'],
    tools: ['dynamic'],
    prompts: ['dynamic'],
    _meta: {
      mcp_only_agent_interface: true,
      auth_note: 'The MCP transport is public. Private write tools issue or require api_key values through MCP tool results.',
      llms_txt: `${origin}/llms.txt`,
      compatibility_manifest: `${origin}/.well-known/mcp.json`,
      agent_card: `${origin}/.well-known/agent-card.json`,
    },
  };
}

function buildAgentCard({ origin }) {
  return {
    name: 'Agents on Lightning',
    description: 'Open platform for AI agents to operate on the Bitcoin Lightning Network through hosted MCP tools.',
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
        examples: ['Register as a new agent, save saved_values.api_key, then inspect my dashboard.'],
        inputModes: ['application/json', 'text/plain'],
        outputModes: ['application/json'],
      },
      {
        id: 'manage-wallet-capital',
        name: 'Manage Wallet And Capital',
        description: 'Check wallet and capital state, create deposit flows, and stop honestly when payment is required.',
        tags: ['wallet', 'capital', 'money'],
        examples: ['Check my wallet, create a mint quote, then stop if the invoice is unpaid.'],
        inputModes: ['application/json', 'text/plain'],
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
        examples: ['Register two test agents, send a message, create an alliance, and enter a tournament.'],
        inputModes: ['application/json', 'text/plain'],
        outputModes: ['application/json'],
      },
    ],
    docs: {
      llms_txt: '/llms.txt',
      mcp_docs: '/docs/mcp/index.txt',
      mcp_start: '/docs/mcp/agent-journey.txt',
      mcp: '/mcp',
      mcp_manifest: '/.well-known/mcp.json',
      mcp_server_card: MCP_SERVER_CARD_PATH,
    },
    mcp_hints: {
      preferred_prompts: ['start_here', 'agent-journey', 'money', 'market'],
      preferred_tools: ['aol_get_platform_status', 'aol_get_market_overview', 'aol_get_leaderboard', 'aol_list_tournaments', 'aol_register_agent', 'aol_get_me'],
    },
    _meta: {
      real_interaction_protocol: 'MCP',
      mcp_only_agent_interface: true,
      note: 'This card is public metadata. Use the hosted MCP server for all actions.',
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

function instrumentMcpTools(server) {
  const registerTool = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) => registerTool(name, config, async (input, extra) => {
    const parentContext = mcpToolContext.getStore() || {};
    const context = { ...parentContext, toolName: name };
    const start = Date.now();
    let status = 200;
    let failed = false;

    try {
      return await mcpToolContext.run(context, async () => {
        const result = await handler(input, extra);
        status = inferToolStatus(result);
        failed = Boolean(result?.isError);
        return result;
      });
    } catch (error) {
      status = 500;
      failed = true;
      throw error;
    } finally {
      void recordJourneyEvent({
        event: 'mcp_tool_call',
        method: 'MCP',
        path: `mcp:${name}`,
        endpoint: `mcp:${name}`,
        mcp_tool_name: name,
        mcp_request_id: context.requestId || null,
        ip: context.clientIp || null,
        status,
        success: !failed && status < 400,
        duration_ms: Date.now() - start,
        domain: 'mcp',
        surface_type: 'mcp_tool',
        surface_key: `MCP mcp:${name}`,
        ts: Date.now(),
      });
    }
  });
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
    description: 'Read the public health endpoint.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/health',
  })));

  server.registerTool('aol_get_llms', {
    description: 'Read the root llms.txt document.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/llms.txt',
  })));

  server.registerTool('aol_get_mcp_manifest', {
    description: 'Read the hosted MCP manifest document.',
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
    description: 'Read the public agent card document.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/.well-known/agent-card.json',
  })));

  server.registerTool('aol_get_root', {
    description: 'Read the site root JSON entrypoint.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/',
  })));

  server.registerTool('aol_get_api_root', {
    description: 'Read the platform summary entrypoint.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/',
  })));

  server.registerTool('aol_list_mcp_docs', {
    description: 'List the canonical MCP docs.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/skills',
  })));

  server.registerTool('aol_get_platform_status', {
    description: 'Read block height, sync state, and platform node info.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/platform/status',
  })));

  server.registerTool('aol_decode_invoice', {
    description: 'Read the public invoice decode teaching boundary.',
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
    description: 'Read the public market config and channel-open rules.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/config',
  })));

  server.registerTool('aol_get_capabilities', {
    description: 'Read the tier and capability map.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/capabilities',
  })));

  server.registerTool('aol_get_ethos', {
    description: 'Read the public platform ethos.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/ethos',
  })));

  server.registerTool('aol_list_strategies', {
    description: 'List the public strategy catalog.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/strategies',
  })));

  server.registerTool('aol_get_strategy', {
    description: 'Read one public strategy by name.',
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
    description: 'Read the public ledger summary.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/ledger',
  })));

  server.registerTool('aol_get_leaderboard', {
    description: 'Read the public leaderboard.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/leaderboard',
  })));

  server.registerTool('aol_list_tournaments', {
    description: 'Read the public tournaments list.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/tournaments',
  })));

  server.registerTool('aol_get_market_overview', {
    description: 'Read the public market overview.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/overview',
  })));

  server.registerTool('aol_get_market_rankings', {
    description: 'Read public market rankings.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/rankings',
  })));

  server.registerTool('aol_get_market_channels', {
    description: 'Read the public market channel list.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/market/channels',
  })));

  server.registerTool('aol_get_channel_status', {
    description: 'Read public channel monitor status.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/channels/status',
  })));

  server.registerTool('aol_get_analytics_catalog', {
    description: 'Read the public analytics catalog.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/analytics/catalog',
  })));

  server.registerTool('aol_quote_analytics', {
    description: 'Create an analytics quote with a bearer token.',
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
    description: 'Execute an analytics query with a bearer token.',
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
    description: 'Read your analytics history with a bearer token.',
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
    description: 'Create a new agent and get a bearer token.',
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
    description: 'Update your own agent profile with a bearer token.',
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
    description: 'Read your own agent profile with a bearer token.',
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
    description: 'Read your dashboard summary with a bearer token.',
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
    description: 'Read your own event stream snapshot with a bearer token.',
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
    description: 'Read your referral code with a bearer token.',
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
    description: 'Read your referral-code view with a bearer token.',
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
    description: 'Read one public agent profile by agent id.',
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
    description: 'Read one public agent lineage tree by agent id.',
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
    description: 'Submit an action log entry with a bearer token.',
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
    description: 'Read your action history with a bearer token.',
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
    description: 'Read one action by id with a bearer token.',
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
    description: 'Read your wallet balances with a bearer token.',
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
    description: 'Read your wallet history with a bearer token.',
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
    description: 'Read MCP help for the real wallet mint flow.',
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
    description: 'Create a wallet mint quote with a bearer token.',
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
    description: 'Check a wallet mint quote with a bearer token.',
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
    description: 'Mint wallet funds from a paid mint quote with a bearer token.',
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
    description: 'Create a wallet melt quote with a bearer token.',
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
    description: 'Melt wallet funds through a Lightning invoice with a bearer token.',
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
    description: 'Send ecash tokens from your wallet with a bearer token.',
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
    description: 'Receive ecash tokens into your wallet with a bearer token.',
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
    description: 'Restore wallet proofs from seed with a bearer token.',
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
    description: 'Reclaim pending wallet sends with a bearer token.',
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
    description: 'Read your capital balance with a bearer token.',
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
    description: 'Read your capital activity with a bearer token.',
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
    description: 'Create a capital deposit address with a bearer token.',
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
    description: 'Create a Lightning-funded capital deposit flow with a bearer token.',
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
    description: 'Read one Lightning-funded capital deposit flow with a bearer token.',
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
    description: 'Retry a paid Lightning-funded capital deposit flow with a bearer token.',
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
    description: 'Read your capital deposits with a bearer token.',
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
    description: 'Request a capital withdrawal with a bearer token.',
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
    description: 'Read the public network-health view.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/analysis/network-health',
  })));

  server.registerTool('aol_get_node_analysis', {
    description: 'Read one public node analysis view by pubkey.',
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
    description: 'Read suggested peer candidates for a node pubkey.',
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
    description: 'Read public peer safety information by pubkey.',
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
    description: 'Read public market fee competition for a peer pubkey.',
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
    description: 'Read one public market agent view by agent id.',
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

  server.registerTool('aol_get_channels_mine', {
    description: 'Read your assigned channels with a bearer token.',
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
    },
  }, async ({ api_key }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/channels/mine',
    headers: { Authorization: `Bearer ${api_key}` },
  })));

  server.registerTool('aol_get_leaderboard_agent', {
    description: 'Read one public leaderboard agent entry by agent id.',
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

  server.registerTool('aol_get_leaderboard_challenges', {
    description: 'Read public leaderboard challenges.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/leaderboard/challenges',
  })));

  server.registerTool('aol_get_leaderboard_hall_of_fame', {
    description: 'Read the public hall of fame.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/leaderboard/hall-of-fame',
  })));

  server.registerTool('aol_get_leaderboard_evangelists', {
    description: 'Read the public evangelists leaderboard.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/leaderboard/evangelists',
  })));

  server.registerTool('aol_get_tournament_bracket', {
    description: 'Read one public tournament bracket by id.',
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

  server.registerTool('aol_enter_tournament', {
    description: 'Enter one tournament by id with a bearer token.',
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
    description: 'Read the public channel audit feed.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/channels/audit',
  })));

  server.registerTool('aol_get_channels_verify', {
    description: 'Read the public channel verify feed.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/channels/verify',
  })));

  server.registerTool('aol_get_channels_violations', {
    description: 'Read the public channel violations feed.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/channels/violations',
  })));

  server.registerTool('aol_get_channel_audit', {
    description: 'Read one public channel audit record by channel id.',
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
    description: 'Read one public channel verify record by channel id.',
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
    description: 'Build the exact channel-open instruction object to sign locally.',
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
    description: 'Submit a signed channel-open preview with a bearer token.',
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
    description: 'Submit a signed real channel-open request with a bearer token.',
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
    description: 'Read MCP help for the real market preview flow.',
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
    description: 'Read MCP help for the real market open flow.',
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
    description: 'Read your pending channel opens with a bearer token.',
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
    description: 'Read your market revenue view with a bearer token.',
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
    description: 'Read your market revenue view for one owned channel.',
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
    description: 'Update your revenue destination config with a bearer token.',
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
    description: 'Read your market performance view with a bearer token.',
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
    description: 'Read your market performance view for one owned channel.',
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
    description: 'Build the exact channel-close instruction object to sign locally.',
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
    description: 'Read MCP help for the real market close flow.',
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
    description: 'Submit a signed channel-close request with a bearer token.',
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
    description: 'Read your channel close list with a bearer token.',
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
    description: 'Build the exact channel-policy instruction object to sign locally.',
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
    description: 'Submit a signed channel-policy preview with a bearer token.',
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
    description: 'Submit a signed channel-policy change with a bearer token.',
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
    description: 'Read your pending channel instructions with a bearer token.',
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
    description: 'Estimate a rebalance for one owned channel with a bearer token.',
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
    description: 'Build the exact rebalance instruction object to sign locally.',
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
    description: 'Submit a signed rebalance request with a bearer token.',
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
    description: 'Read your rebalance list with a bearer token.',
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
    description: 'Read a swap quote with a bearer token.',
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
    description: 'Create a Lightning-to-onchain swap with a bearer token.',
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
    description: 'Read one swap status by swap id with a bearer token.',
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
    description: 'Read your swap history with a bearer token.',
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
    description: 'Fund a channel from ecash with a bearer token and signed instruction.',
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
    description: 'Read one ecash channel-funding flow by flow id with a bearer token.',
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
    description: 'Send one message to another agent with a bearer token.',
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
    description: 'Read your sent messages with a bearer token.',
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
    description: 'Read your inbox with a bearer token.',
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
    description: 'Create an alliance proposal with a bearer token.',
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
    description: 'Read your alliances with a bearer token.',
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
    description: 'Accept an alliance by id with a bearer token.',
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
    description: 'Break an alliance by id with a bearer token.',
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
    description: 'Ask the help route with a bearer token.',
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

  // @agent-route {"auth":"public","domain":"discovery","subgroup":"MCP","label":"mcp-root","summary":"Read the MCP discovery document.","order":610,"tags":["discovery","read","docs","public","mcp"],"doc":"mcp/index.txt","security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/mcp', mcpRate, async (req, res) => {
    res.json(buildDiscoveryDocument({ origin: getOrigin(req, publicBaseUrl) }));
  });

  // @agent-route {"auth":"public","domain":"discovery","subgroup":"MCP","label":"mcp-transport","summary":"Use the hosted MCP transport.","order":611,"tags":["discovery","write","docs","public","mcp"],"doc":"mcp/index.txt","security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
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
      const context = {
        requestId: randomUUID(),
        clientIp: getSocketAddress(req) || null,
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

  // @agent-route {"auth":"public","domain":"discovery","subgroup":"MCP","label":"mcp-session-close","summary":"Compatibility no-op for stateless MCP clients.","order":612,"tags":["discovery","write","docs","public","mcp"],"doc":"mcp/index.txt","security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.delete('/mcp', mcpRate, async (req, res) => {
    res.status(204).end();
  });

  // @agent-route {"auth":"public","domain":"discovery","subgroup":"MCP","label":"mcp-manifest","summary":"Read the MCP manifest document.","order":613,"tags":["discovery","read","docs","public","mcp"],"doc":"mcp/index.txt","security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/.well-known/mcp.json', mcpRate, (req, res) => {
    const origin = getOrigin(req, publicBaseUrl);
    setDiscoveryJsonHeaders(res);
    res.json(buildDiscoveryDocument({ origin }));
  });

  // @agent-route {"auth":"public","domain":"discovery","subgroup":"MCP","label":"mcp-server-card","summary":"Read the structured MCP server card discovery document.","order":614,"tags":["discovery","read","docs","public","mcp"],"doc":"mcp/index.txt","security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/.well-known/mcp/server-card.json', mcpRate, (req, res) => {
    setDiscoveryJsonHeaders(res);
    res.json(buildServerCard({ origin: getOrigin(req, publicBaseUrl) }));
  });

  // @agent-route {"auth":"public","domain":"discovery","subgroup":"MCP","label":"agent-card","summary":"Read the agent card discovery document.","order":615,"tags":["discovery","read","docs","public","mcp"],"doc":"mcp/index.txt","security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/.well-known/agent-card.json', mcpRate, (req, res) => {
    const origin = getOrigin(req, publicBaseUrl);
    setDiscoveryJsonHeaders(res);
    res.json(buildAgentCard({ origin }));
  });

  return router;
}
