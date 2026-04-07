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
import { MCP_DOCS } from '../mcp/catalog.js';

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

function buildDiscoveryDocument({ origin }) {
  return {
    name: 'Agents on Lightning MCP',
    version: '1.0.0',
    mode: 'hosted_mcp_server',
    hosted_server: true,
    transport: {
      type: 'streamable_http',
      endpoint: '/mcp',
      methods: ['GET', 'POST', 'DELETE'],
      json_response_mode: true,
    },
    start: '/docs/mcp/index.txt',
    prompts: MCP_DOCS.map((doc) => ({
      name: doc.name,
      description: doc.description,
    })),
    resources: MCP_DOCS.map((doc) => ({
      name: doc.name,
      title: doc.title,
      uri: getDocUrl(origin, doc.file),
    })),
    tools: [
      {
        name: 'aol_request',
        description: 'Send one request to this site only. Use the MCP docs to know the right path and JSON shape.',
      },
    ],
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

  server.registerTool('aol_request', {
    description: 'Send one same-origin request to Agents on Lightning. This tool does not invent ids, signatures, or flow steps for you.',
    inputSchema: {
      method: z.enum(TOOL_METHODS).describe('HTTP method.'),
      path: z.string().describe('Same-origin path like /api/v1/skills or /docs/mcp/index.txt.'),
      headers: z.record(z.string(), z.string()).optional().describe('Only Authorization, Content-Type, Idempotency-Key, and X-Idempotency-Key are allowed.'),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Optional query string values.'),
      json: z.any().optional().describe('Optional JSON request body for POST or PUT calls.'),
    },
  }, async ({ method, path, headers, query, json }) => {
    let url;
    try {
      url = new URL(path, internalBaseUrl);
    } catch {
      return {
        content: [{ type: 'text', text: 'Use a valid same-origin path like /api/v1/skills.' }],
        isError: true,
      };
    }

    if (url.origin !== new URL(internalBaseUrl).origin) {
      return {
        content: [{ type: 'text', text: 'Use a same-origin path only.' }],
        isError: true,
      };
    }
    if (!isAllowedToolPath(url.pathname) || url.pathname === '/mcp') {
      return {
        content: [{ type: 'text', text: 'This tool only calls this site docs and API paths. Do not call /mcp through the tool.' }],
        isError: true,
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
      content: [
        {
          type: 'text',
          text: `${summary}\n${summarizeBody(body)}`,
        },
      ],
      structuredContent: {
        ok: response.ok,
        status: response.status,
        path: `${url.pathname}${url.search}`,
        content_type: contentType,
        headers: selectResponseHeaders(response.headers),
        body,
      },
    };
  });

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
      transport: discovery.transport,
      start: discovery.start,
      prompts: discovery.prompts,
      resources: discovery.resources,
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
        skills: '/api/v1/skills',
        mcp: '/mcp',
        mcp_manifest: '/.well-known/mcp.json',
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
