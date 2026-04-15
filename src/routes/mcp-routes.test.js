import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { configureRateLimiterPolicy } from '../identity/rate-limiter.js';
import { createMcpOnlyApiGuard } from '../identity/request-security.js';
import {
  MCP_DOCS,
  MCP_RECOMMENDED_PROMPTS,
  MCP_RECOMMENDED_TOOLS,
  MCP_TOOL_NAMES,
  MCP_TOOL_SPECS,
  PUBLIC_MCP_DOC_PATHS,
  SIMPLIFIED_MCP_DOC_NAMES,
} from '../mcp/catalog.js';
import { getJourneyMonitor, startJourneyMonitor, stopJourneyMonitor } from '../monitor/journey-monitor.js';
import { mcpRoutes } from './mcp-routes.js';
import {
  buildToolAuthPayload,
  canonicalAuthJson,
  normalizeSecp256k1DerSignatureToLowS,
} from '../identity/signed-auth.js';

const LEGACY_SECRET_FIELD = ['api', 'key'].join('_');

function base64UrlToBuffer(value) {
  return Buffer.from(value, 'base64url');
}

function makeSecp256k1Identity() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = base64UrlToBuffer(jwk.x);
  const y = base64UrlToBuffer(jwk.y);
  return {
    agentId: 'a1b2c3d4',
    privateKey,
    pubkey: `${(y[y.length - 1] & 1) ? '03' : '02'}${x.toString('hex')}`,
  };
}

function signLowS(privateKey, payload) {
  const signer = createSign('SHA256');
  signer.update(payload, 'utf8');
  signer.end();
  const signature = signer.sign(privateKey).toString('hex');
  const normalized = normalizeSecp256k1DerSignatureToLowS(signature);
  if (!normalized.ok) throw new Error(normalized.message || 'signature normalization failed');
  return normalized.signature;
}

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
  const identity = makeSecp256k1Identity();
  const agentRegistry = {
    getById: (agentId) => agentId === identity.agentId
      ? { id: identity.agentId, name: 'test-agent', pubkey: identity.pubkey }
      : null,
  };
  const signedAuthReplayStore = {
    consume: async () => ({ ok: true }),
  };
  const apiRequests = [];
  app.use(createMcpOnlyApiGuard({
    internalMcpSecret,
  }));
  app.use((req, _res, next) => {
    if (req.path.startsWith('/api/v1')) {
      apiRequests.push({ method: req.method, path: req.path });
    }
    next();
  });
  app.get('/', (_req, res) => res.json({ ok: true }));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/llms.txt', (_req, res) => res.type('text/plain').send('root llms'));
  app.get('/api/v1/', (_req, res) => res.json({
    ok: true,
    hint: 'Try GET /api/v1/platform/status next.',
  }));
  app.get('/api/v1/mcp-docs', (_req, res) => res.json({
    docs: MCP_DOCS.map((doc) => ({
      name: doc.name,
      title: doc.title,
      description: doc.description,
      url: `/docs/mcp/${doc.file}`,
      file: `/docs/mcp/${doc.file}`,
    })),
    skills: [{ file: '/internal/hidden' }],
  }));
  app.get('/api/v1/platform/status', (_req, res) => res.json({ block_height: 1, synced_to_chain: true, synced_to_graph: true, node_pubkey: 'abc', node_alias: 'alias', active_channels: 0 }));
  app.get('/api/v1/proofs/me/balance', (_req, res) => res.json({
    source_of_truth: 'proof_ledger',
    balance: { wallet_ecash_sats: 1000 },
  }));
  app.get('/api/v1/proofs/me', (_req, res) => res.json({
    source_of_truth: 'proof_ledger',
    proofs: [{ proof_id: 'proof-1' }],
  }));
  app.get('/api/v1/proofs/proof/:proofId/verify', (req, res) => res.json({
    proof_id: req.params.proofId,
    verification: { valid: true },
  }));
  app.get('/api/v1/proofs/proof/:proofId/bundle', (req, res) => res.json({
    bundle_version: 'aol-proof-bundle-v1',
    proof: { proof_id: req.params.proofId },
  }));
  app.get('/api/v1/proofs/proof/:proofId', (req, res) => res.json({
    proof: { proof_id: req.params.proofId },
    verification: { valid: true },
  }));
  app.get('/api/v1/proofs/liabilities', (_req, res) => res.json({
    proof_of_liabilities: { status: 'live' },
  }));
  app.get('/api/v1/proofs/reserves', (_req, res) => res.json({
    proof_of_reserves: { status: 'not_yet_published' },
  }));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  app.use(mcpRoutes({
    internalBaseUrl: baseUrl,
    publicBaseUrl: baseUrl,
    internalMcpSecret,
    agentRegistry,
    signedAuthReplayStore,
  }));
  return { server, baseUrl, apiRequests, identity };
}

test('hosted MCP works in stateless mode without mcp-session-id headers', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'aol-mcp-routes-'));
  const { server, baseUrl, apiRequests, identity } = await startApp();
  let nonceCounter = 0;
  const withAgentAuth = (toolName, args = {}) => {
    const payload = buildToolAuthPayload({
      audience: `${baseUrl}/mcp`,
      agentId: identity.agentId,
      toolName,
      args,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: `test-nonce-${++nonceCounter}`,
    });
    const signingPayload = canonicalAuthJson(payload);
    return {
      ...args,
      agent_auth: {
        agent_id: identity.agentId,
        timestamp: payload.timestamp,
        nonce: payload.nonce,
        signature: signLowS(identity.privateKey, signingPayload),
      },
    };
  };
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
    await startJourneyMonitor({
      dbPath: join(tempDir, 'journey.duckdb'),
      idleShutdownMs: 50,
    });
    const discovery = await fetch(new URL('/mcp', baseUrl));
    assert.equal(discovery.status, 200);

    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = (tools.tools || []).map((tool) => tool.name);
    assert.deepEqual([...toolNames].sort(), [...MCP_TOOL_NAMES].sort());
    assert.equal(JSON.stringify(tools).includes(LEGACY_SECRET_FIELD), false);
    assert.equal(JSON.stringify(tools).includes('agent_auth'), true);
    const toolsByName = new Map((tools.tools || []).map((tool) => [tool.name, tool]));
    for (const spec of MCP_TOOL_SPECS) {
      assert.equal(toolsByName.get(spec.name)?.description, spec.description);
    }
    const manifest = await (await fetch(new URL('/.well-known/mcp.json', baseUrl))).json();
    assert.equal(manifest.server_card, `${baseUrl}/.well-known/mcp/server-card.json`);
    assert.equal(manifest.$schema, undefined);
    assert.equal(manifest.protocolVersion, '2025-06-18');
    assert.equal(manifest.serverInfo.name, 'agents-on-lightning-mcp');
    assert.match(manifest.description, /routing-fee revenue/);
    assert.match(manifest.description, /zero platform fees/);
    assert.match(manifest.description, /zero commissions/);
    assert.equal(manifest.transport.type, 'streamable-http');
    assert.deepEqual(manifest.tools, ['dynamic']);
    assert.deepEqual(manifest.prompts, ['dynamic']);
    assert.deepEqual(manifest.resources, ['dynamic']);
    assert.deepEqual(manifest.recommended_prompts, [...MCP_RECOMMENDED_PROMPTS]);
    assert.deepEqual(manifest.recommended_tools, [...MCP_RECOMMENDED_TOOLS]);
    assert((manifest.workflow_summaries || []).some((workflow) => workflow.name === 'earn-and-monitor'));
    assert((manifest.tool_groups || []).some((group) => group.name === 'signed-channel-work'));
    assert.deepEqual(manifest.tool_summaries, MCP_TOOL_SPECS);
    assert.equal(manifest._meta?.zero_platform_fees, true);
    assert.equal(manifest._meta?.zero_commissions, true);
    assert.equal(manifest._meta?.routing_fee_opportunity, true);
    assert.equal(manifest._meta?.['com.agentsonlightning/ethos']?.audience, 'outside agents');
    assert.equal(JSON.stringify(manifest).includes('/api/v1'), false);
    assert.equal(JSON.stringify(manifest).includes('/docs/agent-route-schema.md'), false);
    assert.equal(JSON.stringify(manifest).includes('/llms-full.txt'), false);
    assert.deepEqual(
      (manifest.resource_summaries || []).map((resource) => resource.name),
      [...SIMPLIFIED_MCP_DOC_NAMES],
    );
    const serverCardResponse = await fetch(new URL('/.well-known/mcp/server-card.json', baseUrl));
    assert.equal(serverCardResponse.status, 200);
    assert.equal(serverCardResponse.headers.get('access-control-allow-origin'), '*');
    assert.match(serverCardResponse.headers.get('content-type') || '', /application\/json/);
    const serverCard = await serverCardResponse.json();
    assert.equal(serverCard.$schema, undefined);
    assert.equal(serverCard.protocolVersion, '2025-06-18');
    assert.equal(serverCard.serverInfo.name, 'agents-on-lightning-mcp');
    assert.equal(serverCard.start, '/llms.txt');
    assert.match(serverCard.description, /zero platform fees/);
    assert.match(serverCard.instructions, /routing-fee revenue/);
    assert.equal(serverCard.transport.endpoint, '/mcp');
    assert.deepEqual(serverCard.tools, ['dynamic']);
    assert.deepEqual(serverCard.prompts, ['dynamic']);
    assert.deepEqual(serverCard.resources, ['dynamic']);
    assert.equal(serverCard._meta?.zero_platform_fees, true);
    assert.equal(serverCard._meta?.zero_commissions, true);
    assert.equal(serverCard._meta?.signed_channel_actions, true);
    assert.equal(JSON.stringify(serverCard).includes('/api/v1'), false);
    assert.equal(JSON.stringify(serverCard).includes('/docs/agent-route-schema.md'), false);
    const agentCardResponse = await fetch(new URL('/.well-known/agent-card.json', baseUrl));
    assert.equal(agentCardResponse.status, 200);
    assert.equal(agentCardResponse.headers.get('access-control-allow-origin'), '*');
    const agentCard = await agentCardResponse.json();
    assert.equal(agentCard.name, 'Agents on Lightning');
    assert.equal(agentCard.version, '1.0.0');
    assert.equal(agentCard.documentationUrl, `${baseUrl}/llms.txt`);
    assert.equal(agentCard.supportedInterfaces[0].url, `${baseUrl}/mcp`);
    assert.equal(agentCard.supportedInterfaces[0].protocolBinding, 'MCP');
    assert.deepEqual(agentCard.defaultInputModes, ['application/json', 'text/plain']);
    assert((agentCard.skills || []).some((skill) => skill.id === 'use-hosted-mcp'));
    assert((agentCard.skills || []).some((skill) => skill.id === 'earn-routing-fees'));
    assert.equal(agentCard.capabilities.zeroPlatformFees, true);
    assert.equal(agentCard.capabilities.zeroCommissions, true);
    assert.equal(agentCard.capabilities.routingFeeOpportunity, true);
    assert.equal(agentCard.capabilities.signedChannelActions, true);
    assert.equal(agentCard._meta?.['com.agentsonlightning/ethos']?.platform_fees, 'none');
    assert.equal(JSON.stringify(agentCard).includes('/api/v1'), false);
    assert.equal(JSON.stringify(agentCard).includes('/docs/agent-route-schema.md'), false);

    const result = await client.callTool({ name: 'aol_get_root', arguments: {} });
    assert.equal(Boolean(result.isError), false);
    const apiResult = await client.callTool({ name: 'aol_get_api_root', arguments: {} });
    assert.equal(Boolean(apiResult.isError), false);
    assert.equal(JSON.stringify(apiResult).includes('/api/v1'), false);
    assert.equal(apiResult.structuredContent.path, 'mcp:aol_get_api_root');
    const docsResult = await client.callTool({ name: 'aol_list_mcp_docs', arguments: {} });
    assert.equal(Boolean(docsResult.isError), false);
    assert.equal(JSON.stringify(docsResult).includes('/docs/agent-route-schema.md'), false);
    assert.equal(JSON.stringify(docsResult).includes('"skills"'), false);
    assert.deepEqual(
      docsResult.structuredContent.body.docs.map((doc) => doc.name),
      [...SIMPLIFIED_MCP_DOC_NAMES],
    );
    apiRequests.length = 0;
    await client.callTool({ name: 'aol_get_my_balance_proof', arguments: withAgentAuth('aol_get_my_balance_proof') });
    await client.callTool({ name: 'aol_list_my_proofs', arguments: withAgentAuth('aol_list_my_proofs', { limit: 5 }) });
    await client.callTool({ name: 'aol_get_proof', arguments: withAgentAuth('aol_get_proof', { proof_id: 'proof-1' }) });
    await client.callTool({ name: 'aol_verify_proof', arguments: withAgentAuth('aol_verify_proof', { id: 'proof-1' }) });
    await client.callTool({ name: 'aol_get_proof_bundle', arguments: withAgentAuth('aol_get_proof_bundle', { proof_id: 'proof-1' }) });
    await client.callTool({ name: 'aol_get_proof_of_liabilities', arguments: {} });
    await client.callTool({ name: 'aol_get_proof_of_reserves', arguments: {} });
    assert.deepEqual(apiRequests, [
      { method: 'GET', path: '/api/v1/proofs/me/balance' },
      { method: 'GET', path: '/api/v1/proofs/me' },
      { method: 'GET', path: '/api/v1/proofs/proof/proof-1' },
      { method: 'GET', path: '/api/v1/proofs/proof/proof-1/verify' },
      { method: 'GET', path: '/api/v1/proofs/proof/proof-1/bundle' },
      { method: 'GET', path: '/api/v1/proofs/liabilities' },
      { method: 'GET', path: '/api/v1/proofs/reserves' },
    ]);
    apiRequests.length = 0;
    await client.callTool({ name: 'aol_get_channels_mine', arguments: withAgentAuth('aol_get_channels_mine') });
    await client.callTool({ name: 'aol_get_leaderboard_agent', arguments: { id: 'agent1234' } });
    await client.callTool({ name: 'aol_get_leaderboard_challenges', arguments: {} });
    await client.callTool({ name: 'aol_get_leaderboard_hall_of_fame', arguments: {} });
    await client.callTool({ name: 'aol_get_leaderboard_evangelists', arguments: {} });
    await client.callTool({ name: 'aol_get_tournament_bracket', arguments: { id: 'daily' } });
    await client.callTool({ name: 'aol_enter_tournament', arguments: withAgentAuth('aol_enter_tournament', { id: 'daily' }) });
    assert.deepEqual(apiRequests, [
      { method: 'GET', path: '/api/v1/channels/mine' },
      { method: 'GET', path: '/api/v1/leaderboard/agent/agent1234' },
      { method: 'GET', path: '/api/v1/leaderboard/challenges' },
      { method: 'GET', path: '/api/v1/leaderboard/hall-of-fame' },
      { method: 'GET', path: '/api/v1/leaderboard/evangelists' },
      { method: 'GET', path: '/api/v1/tournaments/daily/bracket' },
      { method: 'POST', path: '/api/v1/tournaments/daily/enter' },
    ]);
    const resources = await client.listResources();
    const resourceUris = (resources.resources || []).map((resource) => resource.uri);
    assert(resourceUris.includes('mcp://server-card.json'));
    for (const docPath of PUBLIC_MCP_DOC_PATHS) {
      assert(resourceUris.some((uri) => uri.endsWith(docPath)), `Missing MCP resource ${docPath}`);
    }
    const directApi = await fetch(new URL('/api/v1/', baseUrl));
    assert.equal(directApi.status, 404);
    assert(seenSessionHeaders.every((value) => value == null));

    await getJourneyMonitor().analyticsDb.flush();
    const mcpActivity = await getJourneyMonitor().mcpToolActivity({ limit: 20 });
    const rootEvent = mcpActivity.find((event) => event.mcp_tool_name === 'aol_get_root');
    assert(rootEvent);
    assert.equal(rootEvent.tool_group, 'discovery');
    assert.equal(rootEvent.workflow_stage, 'discovery');
    assert.equal(rootEvent.risk_level, 'read_only');
    assert.equal(JSON.stringify(rootEvent).includes(LEGACY_SECRET_FIELD), false);

    const closeResponse = await fetch(new URL('/mcp', baseUrl), { method: 'DELETE' });
    assert.equal(closeResponse.status, 204);
  } finally {
    await transport.close().catch(() => {});
    await stopJourneyMonitor();
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
});
