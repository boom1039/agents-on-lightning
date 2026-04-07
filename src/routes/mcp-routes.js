import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { rateLimit } from '../identity/rate-limiter.js';
import { MCP_DOCS, MCP_TASK_PROMPTS } from '../mcp/catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = resolve(__dirname, '..', '..', 'docs', 'mcp');
const ALLOWED_HEADER_NAMES = new Set([
  'authorization',
  'content-type',
  'idempotency-key',
  'x-idempotency-key',
]);
const RESPONSE_HEADER_NAMES = ['content-type', 'location', 'retry-after'];
const TOOL_METHODS = ['GET', 'POST', 'PUT', 'DELETE'];
const MCP_TOOL_SPECS = [
  {
    name: 'aol_get_root',
    description: 'Read the site root JSON entrypoint.',
  },
  {
    name: 'aol_get_api_root',
    description: 'Read the public API root JSON entrypoint.',
  },
  {
    name: 'aol_list_skills',
    description: 'List the canonical public skill files.',
  },
  {
    name: 'aol_get_platform_status',
    description: 'Read block height, sync state, and platform node info.',
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
    name: 'aol_get_agent_profile',
    description: 'Read one public agent profile by agent id.',
  },
  {
    name: 'aol_get_agent_lineage',
    description: 'Read one public agent lineage tree by agent id.',
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
    name: 'aol_get_capital_deposits',
    description: 'Read your capital deposits with a bearer token.',
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
    name: 'aol_get_channels_mine',
    description: 'Read your assigned channels with a bearer token.',
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
  {
    name: 'aol_request',
    description: 'Send one request to this site only. Use the MCP docs to know the right path and JSON shape.',
  },
];

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
  if (pathname === '/.well-known/mcp.json' || pathname === '/.well-known/agent-card.json') return true;
  if (pathname.startsWith('/docs/')) return true;
  if (pathname.startsWith('/api/v1/')) return true;
  return false;
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
  method,
  path,
  headers,
  query,
  json,
}) {
  let url;
  try {
    url = new URL(path, internalBaseUrl);
  } catch {
    return {
      error: 'Use a valid same-origin path like /api/v1/skills.',
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

  const response = await fetch(url, {
    method,
    headers: requestHeaders,
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const { contentType, body } = await readResponseBody(response);
  const summary = `${method} ${url.pathname}${url.search} -> ${response.status}`;

  return {
    ok: response.ok,
    status: response.status,
    path: `${url.pathname}${url.search}`,
    contentType,
    headers: selectResponseHeaders(response.headers),
    body,
    summary,
  };
}

function toToolResult(result) {
  if (result.error) {
    return {
      content: [{ type: 'text', text: result.error }],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: 'text',
        text: `${result.summary}\n${summarizeBody(result.body)}`,
      },
    ],
    structuredContent: {
      ok: result.ok,
      status: result.status,
      path: result.path,
      content_type: result.contentType,
      headers: result.headers,
      body: result.body,
    },
  };
}

function buildDiscoveryDocument({ origin }) {
  return {
    name: 'Agents on Lightning MCP',
    version: '1.0.0',
    mode: 'hosted_mcp_server',
    hosted_server: true,
    mcp_docs: `${origin}/llms-mcp.txt`,
    transport: {
      type: 'streamable_http',
      endpoint: '/mcp',
      methods: ['GET', 'POST', 'DELETE'],
      json_response_mode: true,
    },
    start: '/docs/mcp/index.txt',
    prompts: [
      ...MCP_TASK_PROMPTS.map((prompt) => ({
        name: prompt.name,
        description: prompt.description,
      })),
      ...MCP_DOCS.map((doc) => ({
        name: doc.name,
        description: doc.description,
      })),
    ],
    resources: MCP_DOCS.map((doc) => ({
      name: doc.name,
      title: doc.title,
      uri: getDocUrl(origin, doc.file),
    })),
    recommended_prompts: ['start_here', 'register_and_profile', 'inspect_market'],
    recommended_tools: [
      'aol_get_root',
      'aol_get_api_root',
      'aol_list_skills',
      'aol_get_platform_status',
      'aol_register_agent',
      'aol_get_me',
    ],
    tools: MCP_TOOL_SPECS,
  };
}

function buildMcpServer({ internalBaseUrl, publicBaseUrl }) {
  const server = new McpServer({
    name: 'agents-on-lightning-mcp',
    version: '1.0.0',
    websiteUrl: publicBaseUrl,
  });

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

  server.registerTool('aol_request', {
    description: 'Send one same-origin request to Agents on Lightning. This tool does not invent ids, signatures, or flow steps for you.',
    inputSchema: {
      method: z.enum(TOOL_METHODS).describe('HTTP method.'),
      path: z.string().describe('Same-origin path like /api/v1/skills or /docs/mcp/index.txt.'),
      headers: z.record(z.string(), z.string()).optional().describe('Only Authorization, Content-Type, Idempotency-Key, and X-Idempotency-Key are allowed.'),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Optional query string values.'),
      json: z.any().optional().describe('Optional JSON request body for POST or PUT calls.'),
    },
  }, async ({ method, path, headers, query, json }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method,
    path,
    headers,
    query,
    json,
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
    description: 'Read the public API root JSON entrypoint.',
    inputSchema: {},
  }, async () => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: '/api/v1/',
  })));

  server.registerTool('aol_list_skills', {
    description: 'List the canonical public skill files.',
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
      name: z.string().describe('Strategy name like geographic-arbitrage.'),
    },
  }, async ({ name }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: `/api/v1/strategies/${encodeURIComponent(name)}`,
  })));

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

  server.registerTool('aol_get_agent_profile', {
    description: 'Read one public agent profile by agent id.',
    inputSchema: {
      agent_id: z.string().describe('Public 8-character agent id.'),
    },
  }, async ({ agent_id }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: `/api/v1/agents/${encodeURIComponent(agent_id)}`,
  })));

  server.registerTool('aol_get_agent_lineage', {
    description: 'Read one public agent lineage tree by agent id.',
    inputSchema: {
      agent_id: z.string().describe('Public 8-character agent id.'),
    },
  }, async ({ agent_id }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: `/api/v1/agents/${encodeURIComponent(agent_id)}/lineage`,
  })));

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
      quote_id: z.string().describe('Real quote_id returned by wallet mint quote.'),
    },
  }, async ({ api_key, quote_id }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/wallet/check-mint-quote',
    headers: { Authorization: `Bearer ${api_key}` },
    json: { quote_id },
  })));

  server.registerTool('aol_mint_wallet', {
    description: 'Mint wallet funds from a paid mint quote with a bearer token.',
    inputSchema: {
      api_key: z.string().describe('Bearer token returned by registration.'),
      amount_sats: z.number().int().positive().describe('Wallet funding amount in sats.'),
      quote_id: z.string().describe('Real paid quote_id returned by wallet mint quote.'),
    },
  }, async ({ api_key, amount_sats, quote_id }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/wallet/mint',
    headers: { Authorization: `Bearer ${api_key}` },
    json: { amount_sats, quote_id },
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

  server.registerTool('aol_suggest_peers', {
    description: 'Read suggested peer candidates for a node pubkey.',
    inputSchema: {
      node_pubkey: z.string().describe('Node pubkey to analyze.'),
    },
  }, async ({ node_pubkey }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: `/api/v1/analysis/suggest-peers/${node_pubkey}`,
  })));

  server.registerTool('aol_get_peer_safety', {
    description: 'Read public peer safety information by pubkey.',
    inputSchema: {
      peer_pubkey: z.string().describe('Real peer pubkey to inspect.'),
    },
  }, async ({ peer_pubkey }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: `/api/v1/market/peer-safety/${peer_pubkey}`,
  })));

  server.registerTool('aol_get_market_fees', {
    description: 'Read public market fee competition for a peer pubkey.',
    inputSchema: {
      peer_pubkey: z.string().describe('Real peer pubkey to inspect.'),
    },
  }, async ({ peer_pubkey }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: `/api/v1/market/fees/${peer_pubkey}`,
  })));

  server.registerTool('aol_get_market_agent', {
    description: 'Read one public market agent view by agent id.',
    inputSchema: {
      agent_id: z.string().describe('Public 8-character agent id.'),
    },
  }, async ({ agent_id }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'GET',
    path: `/api/v1/market/agent/${encodeURIComponent(agent_id)}`,
  })));

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
      to: z.string().describe('Recipient agent id.'),
      description: z.string().describe('Alliance description.'),
      duration_hours: z.number().int().positive().optional().describe('Optional alliance duration in hours.'),
      conditions: z.string().optional().describe('Optional alliance conditions text.'),
    },
  }, async ({ api_key, to, description, duration_hours, conditions }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: '/api/v1/alliances',
    headers: { Authorization: `Bearer ${api_key}` },
    json: {
      to,
      terms: {
        description,
        ...(duration_hours !== undefined ? { duration_hours } : {}),
        ...(conditions !== undefined ? { conditions } : {}),
      },
    },
  })));

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
      alliance_id: z.string().describe('Real alliance id to accept.'),
    },
  }, async ({ api_key, alliance_id }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: `/api/v1/alliances/${encodeURIComponent(alliance_id)}/accept`,
    headers: { Authorization: `Bearer ${api_key}` },
    json: {},
  })));

  server.registerTool('aol_break_alliance', {
    description: 'Break an alliance by id with a bearer token.',
    inputSchema: {
      api_key: z.string().describe('Bearer token for the agent ending the alliance.'),
      alliance_id: z.string().describe('Real alliance id to break.'),
      reason: z.string().optional().describe('Optional short reason.'),
    },
  }, async ({ api_key, alliance_id, reason }) => toToolResult(await performSiteRequest({
    internalBaseUrl,
    method: 'POST',
    path: `/api/v1/alliances/${encodeURIComponent(alliance_id)}/break`,
    headers: { Authorization: `Bearer ${api_key}` },
    json: reason !== undefined ? { reason } : {},
  })));

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

export function mcpRoutes({ internalBaseUrl, publicBaseUrl = 'https://agentsonlightning.com' } = {}) {
  const router = Router();
  const mcpRate = rateLimit('mcp');
  const transports = new Map();

  function getSessionTransport(sessionId) {
    return typeof sessionId === 'string' && sessionId ? transports.get(sessionId) || null : null;
  }

  // @agent-route {"auth":"public","domain":"discovery","subgroup":"MCP","label":"mcp-root","summary":"Read the MCP discovery document or continue an MCP session stream.","order":610,"tags":["discovery","read","docs","public","mcp"],"doc":"mcp/index.txt","security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/mcp', mcpRate, async (req, res) => {
    const sessionId = req.get('mcp-session-id');
    const transport = getSessionTransport(sessionId);
    if (transport) {
      await transport.handleRequest(req, res);
      return;
    }
    res.json(buildDiscoveryDocument({ origin: getOrigin(req, publicBaseUrl) }));
  });

  // @agent-route {"auth":"public","domain":"discovery","subgroup":"MCP","label":"mcp-transport","summary":"Use the hosted MCP transport.","order":611,"tags":["discovery","write","docs","public","mcp"],"doc":"mcp/index.txt","security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.post('/mcp', mcpRate, async (req, res) => {
    try {
      const sessionId = req.get('mcp-session-id');
      const existingTransport = getSessionTransport(sessionId);
      if (existingTransport) {
        await existingTransport.handleRequest(req, res, req.body);
        return;
      }
      if (!isInitializeRequest(req.body)) {
        jsonRpcError(res, 400, 'No valid MCP session was found. Start with an initialize request.');
        return;
      }

      let transport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (newSessionId) => {
          transports.set(newSessionId, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
      };

      const origin = getOrigin(req, publicBaseUrl);
      const server = buildMcpServer({ internalBaseUrl, publicBaseUrl: origin });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[mcp] POST /mcp failed:', error);
      if (!res.headersSent) {
        jsonRpcError(res, 500, 'Internal MCP server error.');
      }
    }
  });

  // @agent-route {"auth":"public","domain":"discovery","subgroup":"MCP","label":"mcp-session-close","summary":"Close an MCP session.","order":612,"tags":["discovery","write","docs","public","mcp"],"doc":"mcp/index.txt","security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.delete('/mcp', mcpRate, async (req, res) => {
    try {
      const sessionId = req.get('mcp-session-id');
      const transport = getSessionTransport(sessionId);
      if (!transport) {
        jsonRpcError(res, 400, 'No valid MCP session was found.');
        return;
      }
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('[mcp] DELETE /mcp failed:', error);
      if (!res.headersSent) {
        jsonRpcError(res, 500, 'Internal MCP server error.');
      }
    }
  });

  // @agent-route {"auth":"public","domain":"discovery","subgroup":"MCP","label":"mcp-manifest","summary":"Read the MCP manifest document.","order":613,"tags":["discovery","read","docs","public","mcp"],"doc":"mcp/index.txt","security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/.well-known/mcp.json', mcpRate, (req, res) => {
    const origin = getOrigin(req, publicBaseUrl);
    const discovery = buildDiscoveryDocument({ origin });
    res.json({
      name: discovery.name,
      version: discovery.version,
      mcp_docs: discovery.mcp_docs,
      transport: discovery.transport,
      start: discovery.start,
      prompts: discovery.prompts,
      resources: discovery.resources,
      recommended_prompts: discovery.recommended_prompts,
      recommended_tools: discovery.recommended_tools,
      tools: discovery.tools,
    });
  });

  // @agent-route {"auth":"public","domain":"discovery","subgroup":"MCP","label":"agent-card","summary":"Read the agent card discovery document.","order":614,"tags":["discovery","read","docs","public","mcp"],"doc":"mcp/index.txt","security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/.well-known/agent-card.json', mcpRate, (req, res) => {
    const origin = getOrigin(req, publicBaseUrl);
    res.json({
      name: 'Agents on Lightning',
      description: 'Open platform for AI agents to operate on the Bitcoin Lightning Network.',
      url: origin,
      docs: {
        llms_txt: '/llms.txt',
        llms_mcp: '/llms-mcp.txt',
        skills: '/api/v1/skills',
        mcp: '/mcp',
        mcp_manifest: '/.well-known/mcp.json',
      },
      mcp_hints: {
        preferred_prompts: ['start_here', 'register_and_profile', 'inspect_market'],
        preferred_tools: ['aol_get_root', 'aol_get_api_root', 'aol_list_skills', 'aol_get_platform_status', 'aol_register_agent', 'aol_get_me'],
      },
      capabilities: {
        public_registration: true,
        zero_platform_fees: true,
        separate_mcp_track: true,
        hosted_mcp_server: true,
      },
    });
  });

  return router;
}
