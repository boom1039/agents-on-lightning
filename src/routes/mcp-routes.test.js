import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { configureRateLimiterPolicy } from '../identity/rate-limiter.js';
import { createMcpOnlyApiGuard } from '../identity/request-security.js';
import { MCP_DOCS, SIMPLIFIED_MCP_DOC_NAMES } from '../mcp/catalog.js';
import { mcpRoutes } from './mcp-routes.js';

async function startApp() {
  configureRateLimiterPolicy({
    categories: {
      mcp: { limit: 100, windowMs: 60_000 },
    },
    globalCap: { limit: 1_000, windowMs: 60_000 },
    progressive: {
      resetWindowMs: 60_000,
      thresholds: [
        { violations: 10, multiplier: 4 },
        { violations: 5, multiplier: 2 },
      ],
    },
  });

  const app = express();
  app.use(express.json());
  const internalMcpSecret = 'test-internal-mcp-secret';
  app.use(createMcpOnlyApiGuard({
    mode: 'mcp_only',
    internalMcpSecret,
  }));
  app.get('/', (_req, res) => res.json({ ok: true }));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/llms.txt', (_req, res) => res.type('text/plain').send('root llms'));
  app.get('/llms-mcp.txt', (_req, res) => res.type('text/plain').send('mcp llms'));
  app.get('/api/v1/', (_req, res) => res.json({
    ok: true,
    hint: 'Try GET /api/v1/platform/status next.',
  }));
  app.get('/api/v1/skills', (_req, res) => res.json({
    docs: MCP_DOCS.map((doc) => ({
      name: doc.name,
      title: doc.title,
      description: doc.description,
      url: `/docs/mcp/${doc.file}`,
      file: `/docs/mcp/${doc.file}`,
    })),
    skills: [{ file: '/docs/skills/identity.txt' }],
  }));
  app.get('/api/v1/platform/status', (_req, res) => res.json({ block_height: 1, synced_to_chain: true, synced_to_graph: true, node_pubkey: 'abc', node_alias: 'alias', active_channels: 0 }));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  app.use(mcpRoutes({ internalBaseUrl: baseUrl, publicBaseUrl: baseUrl, internalMcpSecret }));
  return { server, baseUrl };
}

test('hosted MCP works in stateless mode without mcp-session-id headers', async () => {
  const { server, baseUrl } = await startApp();
  const seenSessionHeaders = [];
  const fetchWithHeaderCapture = async (input, init) => {
    const response = await fetch(input, init);
    seenSessionHeaders.push(response.headers.get('mcp-session-id'));
    return response;
  };

  const client = new Client({ name: 'mcp-routes-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
    fetch: fetchWithHeaderCapture,
  });

  try {
    const discovery = await fetch(new URL('/mcp', baseUrl));
    assert.equal(discovery.status, 200);

    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = (tools.tools || []).map((tool) => tool.name);
    assert(toolNames.includes('aol_get_root'));
    assert(toolNames.includes('aol_list_mcp_docs'));
    assert(!toolNames.includes('aol_list_skills'));
    assert(!toolNames.includes('aol_request'));
    const manifest = await (await fetch(new URL('/.well-known/mcp.json', baseUrl))).json();
    assert.deepEqual(
      (manifest.resources || []).map((resource) => resource.name),
      [...SIMPLIFIED_MCP_DOC_NAMES],
    );

    const result = await client.callTool({ name: 'aol_get_root', arguments: {} });
    assert.equal(Boolean(result.isError), false);
    const apiResult = await client.callTool({ name: 'aol_get_api_root', arguments: {} });
    assert.equal(Boolean(apiResult.isError), false);
    assert.equal(JSON.stringify(apiResult).includes('/api/v1'), false);
    assert.equal(apiResult.structuredContent.path, 'mcp:aol_get_api_root');
    const docsResult = await client.callTool({ name: 'aol_list_mcp_docs', arguments: {} });
    assert.equal(Boolean(docsResult.isError), false);
    assert.equal(JSON.stringify(docsResult).includes('/docs/skills'), false);
    assert.equal(JSON.stringify(docsResult).includes('"skills"'), false);
    assert.deepEqual(
      docsResult.structuredContent.body.docs.map((doc) => doc.name),
      [...SIMPLIFIED_MCP_DOC_NAMES],
    );
    const directApi = await fetch(new URL('/api/v1/', baseUrl));
    assert.equal(directApi.status, 404);
    assert(seenSessionHeaders.every((value) => value == null));

    const closeResponse = await fetch(new URL('/mcp', baseUrl), { method: 'DELETE' });
    assert.equal(closeResponse.status, 204);
  } finally {
    await transport.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});
