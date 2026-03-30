import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { channelMarketRoutes } from './channel-market-routes.js';
import { channelAccountabilityRoutes } from './channel-accountability-routes.js';
import { agentIdentityRoutes } from './agent-identity-routes.js';
import { agentPaidServicesRoutes } from './agent-paid-services-routes.js';
import { dashboardRoutes } from './dashboard-routes.js';
import { DataLayer } from '../data-layer.js';
import { handleJsonBodyError, requireDashboardOperatorAuth, requireJsonWriteContent } from '../identity/request-security.js';
import { resetCounters } from '../identity/rate-limiter.js';

async function withServer(app, run) {
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'aol-security-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withCleanRateLimits(run) {
  await resetCounters();
  try {
    await run();
  } finally {
    await resetCounters();
  }
}

function baseApp() {
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.use(handleJsonBodyError);
  app.use(requireJsonWriteContent);
  return app;
}

function assertCompactHelpfulError(json, {
  error,
  bodyStatus,
  hintIncludes,
  messageIncludes,
  retryable,
  see,
} = {}) {
  assert.equal(typeof json, 'object');
  assert.equal(Array.isArray(json), false);
  if (error !== undefined) assert.equal(json.error, error);
  if (bodyStatus !== undefined) assert.equal(json.status, bodyStatus);
  if (retryable !== undefined) assert.equal(json.retryable, retryable);
  if (see !== undefined) assert.equal(json.see, see);
  assert.equal(typeof json.message, 'string');
  assert.ok(json.message.length > 0);
  assert.ok(json.message.length <= 240);
  if (hintIncludes !== undefined) {
    assert.equal(typeof json.hint, 'string');
    assert.match(json.hint, hintIncludes);
  }
  if (messageIncludes !== undefined) {
    assert.match(json.message, messageIncludes);
  }
  assert.equal('stack' in json, false);
}

test('write endpoints reject non-JSON content types', async () => {
  const app = baseApp();
  app.use(agentIdentityRoutes({
    agentRegistry: {
      async register() {
        return { agent_id: 'deadbeef', api_key: 'lb-agent-test' };
      },
      getByApiKey() { return null; },
    },
  }));

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'name=bad',
    });
    const json = await response.json();
    assert.equal(response.status, 415);
    assertCompactHelpfulError(json, {
      error: 'unsupported_media_type',
      bodyStatus: 415,
      hintIncludes: /application\/json/i,
      messageIncludes: /only accepts application\/json/i,
      retryable: false,
    });
  });
});

test('malformed JSON bodies return a short helpful validation error', async () => {
  const app = baseApp();
  app.post('/api/v1/help', (_req, res) => {
    res.json({ ok: true });
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/help`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"question":"oops"',
    });
    const json = await response.json();

    assert.equal(response.status, 400);
    assertCompactHelpfulError(json, {
      error: 'validation_error',
      bodyStatus: 400,
      hintIncludes: /double-quoted keys/i,
      messageIncludes: /malformed json body/i,
      retryable: false,
    });
  });
});

test('node test-connection verifies credentials via nodeManager and removes the temporary node', async () => {
  await withCleanRateLimits(async () => {
    const addCalls = [];
    const removed = [];
    let persistedState = 0;

    const app = baseApp();
    app.use(agentIdentityRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
          return null;
        },
        async updateState() {
          persistedState++;
        },
      },
      nodeManager: {
        async addNodeFromCredentials(name, creds) {
          addCalls.push({ name, creds });
          return {
            info: {
              alias: 'Remote Test Node',
              identity_pubkey: '02'.padEnd(66, 'a'),
              synced_to_chain: true,
              num_active_channels: 7,
            },
          };
        },
        removeNode(name) {
          removed.push(name);
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/node/test-connection`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner',
        },
        body: JSON.stringify({
          host: '8.8.8.8:10009',
          macaroon: 'a1b2c3',
          tls_cert: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
        }),
      });
      const json = await response.json();

      assert.equal(response.status, 200);
      assert.equal(json.status, 'ok');
      assert.equal(json.message, 'Connection test passed.');
      assert.deepEqual(json.node, {
        alias: 'Remote Test Node',
        pubkey: '02'.padEnd(66, 'a'),
        synced_to_chain: true,
        active_channels: 7,
      });
    });

    assert.equal(addCalls.length, 1);
    assert.match(addCalls[0].name, /^agent-connect-owner-agent-/);
    assert.deepEqual(addCalls[0].creds, {
      host: '8.8.8.8',
      restPort: 10009,
      macaroonHex: 'a1b2c3',
      tlsCertBase64OrPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    });
    assert.deepEqual(removed, [addCalls[0].name]);
    assert.equal(persistedState, 0);
  });
});

test('node connect persists only verified node metadata after credential verification', async () => {
  await withCleanRateLimits(async () => {
    const addCalls = [];
    const removed = [];
    const updateCalls = [];

    const app = baseApp();
    app.use(agentIdentityRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
          return null;
        },
        async updateState(agentId, state) {
          updateCalls.push({ agentId, state });
        },
      },
      nodeManager: {
        async addNodeFromCredentials(name, creds) {
          addCalls.push({ name, creds });
          return {
            info: {
              alias: 'Verified Node',
              identity_pubkey: '03'.padEnd(66, 'b'),
              synced_to_chain: false,
              num_active_channels: 11,
            },
          };
        },
        removeNode(name) {
          removed.push(name);
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/node/connect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner',
        },
        body: JSON.stringify({
          host: '1.1.1.1:8443',
          macaroon: 'deadbeef',
          tls_cert: 'tls-cert-body',
          tier: 'invoice',
        }),
      });
      const json = await response.json();

      assert.equal(response.status, 200);
      assert.equal(json.status, 'connected');
      assert.equal(json.tier, 'invoice');
      assert.equal(json.message, 'Node credentials verified and saved.');
      assert.deepEqual(json.node, {
        alias: 'Verified Node',
        pubkey: '03'.padEnd(66, 'b'),
        synced_to_chain: false,
        active_channels: 11,
      });
    });

    assert.equal(addCalls.length, 1);
    assert.deepEqual(addCalls[0].creds, {
      host: '1.1.1.1',
      restPort: 8443,
      macaroonHex: 'deadbeef',
      tlsCertBase64OrPem: 'tls-cert-body',
    });
    assert.deepEqual(removed, [addCalls[0].name]);
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].agentId, 'owner-agent');
    assert.equal(updateCalls[0].state.node_connected, true);
    assert.equal(updateCalls[0].state.node_host, '1.1.1.1:8443');
    assert.equal(updateCalls[0].state.tier, 'invoice');
    assert.equal(updateCalls[0].state.node_alias, 'Verified Node');
    assert.equal(updateCalls[0].state.node_pubkey, '03'.padEnd(66, 'b'));
    assert.equal(updateCalls[0].state.node_synced_to_chain, false);
    assert.equal(updateCalls[0].state.node_active_channels, 11);
    assert.equal(typeof updateCalls[0].state.node_verified_at, 'number');
    assert.ok(updateCalls[0].state.node_verified_at > 0);
    assert.equal('macaroon' in updateCalls[0].state, false);
    assert.equal('tls_cert' in updateCalls[0].state, false);
  });
});

test('node connect blocks self-serve admin tier requests', async () => {
  await withCleanRateLimits(async () => {
    const app = baseApp();
    app.use(agentIdentityRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
          return null;
        },
      },
      nodeManager: {
        async addNodeFromCredentials() {
          throw new Error('should not be called');
        },
        removeNode() {},
      },
    }));

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/node/connect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner',
        },
        body: JSON.stringify({
          host: '1.1.1.1:8443',
          macaroon: 'deadbeef',
          tls_cert: 'tls-cert-body',
          tier: 'admin',
        }),
      });
      const json = await response.json();

      assert.equal(response.status, 403);
      assert.equal(json.error, 'tier_requires_operator_approval');
      assert.match(json.hint, /observatory, readonly, wallet, or invoice/i);
    });
  });
});

test('market owner-only resources return 404 to non-owners', async () => {
  const app = baseApp();
  app.use(channelMarketRoutes({
    agentRegistry: {
      getByApiKey(apiKey) {
        if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
        if (apiKey === 'lb-agent-other') return { id: 'other-agent' };
        return null;
      },
    },
    channelAssignments: {
      getAssignment(chanId) {
        if (chanId === '123') return { agent_id: 'owner-agent' };
        return null;
      },
    },
    revenueTracker: {
      getChannelRevenue() {
        return { chan_id: '123', total_fees_sats: 42 };
      },
    },
    swapProvider: {
      getSwapStatus() {
        return { swap_id: 'swap-1', agent_id: 'owner-agent', status: 'invoice_paid' };
      },
    },
    ecashChannelFunder: {
      getFlowStatus() {
        return { flow_id: 'flow-1', agent_id: 'owner-agent', status: 'complete' };
      },
    },
  }));

  await withServer(app, async (baseUrl) => {
    const cases = [
      '/api/v1/market/revenue/123',
      '/api/v1/market/swap/status/swap-1',
      '/api/v1/market/fund-from-ecash/flow-1',
    ];

    for (const path of cases) {
      const denied = await fetch(`${baseUrl}${path}`, {
        headers: { Authorization: 'Bearer lb-agent-other' },
      });
      assert.equal(denied.status, 404, path);
    }

    const allowed = await fetch(`${baseUrl}/api/v1/market/swap/status/swap-1`, {
      headers: { Authorization: 'Bearer lb-agent-owner' },
    });
    assert.equal(allowed.status, 200);
  });
});

test('public channel transparency routes return summary-only data', async () => {
  const app = baseApp();
  app.use(channelAccountabilityRoutes({
    agentRegistry: { getByApiKey() { return null; } },
    channelAuditLog: {
      async readAll() {
        return [{
          _ts: 123,
          type: 'policy_updated',
          chan_id: '123',
          agent_id: 'owner-agent',
          reason: 'policy changed',
          old_policy: { fee_rate_ppm: 100 },
          new_policy: { fee_rate_ppm: 250 },
          hash: 'abcdef1234567890',
          prev_hash: '0123456789abcdef',
        }];
      },
      async readByChannel() {
        return [{
          _ts: 123,
          type: 'violation_detected',
          chan_id: '123',
          agent_id: 'owner-agent',
          reason: 'fee drift',
          hash: 'fedcba0987654321',
        }];
      },
      async verify() {
        return {
          valid: true,
          checked: 3,
          total: 3,
          errors: [{ issue: 'should not leak' }],
          warnings: [{ issue: 'still should not leak' }],
        };
      },
      async readByType() {
        return [{
          _ts: 456,
          type: 'violation_detected',
          chan_id: '456',
          agent_id: 'owner-agent',
          reason: 'rate mismatch',
          hash: '9999999999999999',
        }];
      },
      async getStatus() {
        return { entries: 5, lastHash: 'abcd', lastTimestamp: 999 };
      },
    },
    channelMonitor: {
      getStatus() {
        return {
          running: true,
          assignedChannels: 4,
          violationsDetected: 2,
        };
      },
    },
  }));

  await withServer(app, async (baseUrl) => {
    const audit = await fetch(`${baseUrl}/api/v1/channels/audit`);
    const auditJson = await audit.json();
    assert.equal(audit.status, 200);
    assert.deepEqual(auditJson.entries[0], {
      ts: 123,
      type: 'policy_updated',
      chan_id: '123',
      agent_id: 'owner-agent',
      reason: 'policy changed',
      hash: 'abcdef123456',
    });
    assert.equal('old_policy' in auditJson.entries[0], false);
    assert.equal('new_policy' in auditJson.entries[0], false);
    assert.equal('prev_hash' in auditJson.entries[0], false);

    const verify = await fetch(`${baseUrl}/api/v1/channels/verify/1234567890`);
    const verifyJson = await verify.json();
    assert.equal(verify.status, 200);
    assert.deepEqual(verifyJson, {
      chan_id: '1234567890',
      valid: true,
      checked: 3,
      total: 3,
      error_count: 1,
      warning_count: 1,
    });
    assert.equal('errors' in verifyJson, false);
    assert.equal('warnings' in verifyJson, false);
  });
});

test('test-only reset route is hidden unless explicitly enabled', async () => {
  const daemon = {
    agentRegistry: { getByApiKey() { return null; } },
  };

  const previous = process.env.ENABLE_TEST_ROUTES;
  try {
    delete process.env.ENABLE_TEST_ROUTES;
    const app = baseApp();
    app.use(channelAccountabilityRoutes(daemon));
    await withServer(app, async (baseUrl) => {
      const off = await fetch(`${baseUrl}/api/v1/test/reset-rate-limits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(off.status, 404);
    });

    process.env.ENABLE_TEST_ROUTES = '1';
    const enabledApp = baseApp();
    enabledApp.use(channelAccountabilityRoutes(daemon));
    await withServer(enabledApp, async (baseUrl) => {
      const on = await fetch(`${baseUrl}/api/v1/test/reset-rate-limits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(on.status, 200);
    });
  } finally {
    if (previous === undefined) {
      delete process.env.ENABLE_TEST_ROUTES;
    } else {
      process.env.ENABLE_TEST_ROUTES = previous;
    }
  }
});

test('capital withdrawal is disabled by default', async () => {
  const app = baseApp();
  app.use(agentIdentityRoutes({
    agentRegistry: {
      getByApiKey(apiKey) {
        if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
        return null;
      },
    },
  }));
  app.use(agentPaidServicesRoutes({
    agentRegistry: {
      getByApiKey(apiKey) {
        if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
        return null;
      },
    },
    capitalLedger: {
      async withdraw() {
        throw new Error('should not be called');
      },
    },
  }));

  const previous = process.env.ENABLE_CAPITAL_WITHDRAWALS;
  delete process.env.ENABLE_CAPITAL_WITHDRAWALS;
  try {
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/capital/withdraw`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner',
        },
        body: JSON.stringify({ amount_sats: 1000, destination_address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080' }),
      });
      const json = await response.json();
      assert.equal(response.status, 503);
      assert.equal(json.error, 'capital_withdrawals_disabled');
    });
  } finally {
    if (previous === undefined) delete process.env.ENABLE_CAPITAL_WITHDRAWALS;
    else process.env.ENABLE_CAPITAL_WITHDRAWALS = previous;
  }
});

test('capital withdrawal stays blocked even if the feature flag is flipped on', async () => {
  let withdrawCalls = 0;
  const app = baseApp();
  app.use(agentPaidServicesRoutes({
    agentRegistry: {
      getByApiKey(apiKey) {
        if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
        return null;
      },
    },
    capitalLedger: {
      async withdraw() {
        withdrawCalls++;
        return { available: 0 };
      },
    },
  }));

  const previous = process.env.ENABLE_CAPITAL_WITHDRAWALS;
  process.env.ENABLE_CAPITAL_WITHDRAWALS = '1';
  try {
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/capital/withdraw`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner',
        },
        body: JSON.stringify({ amount_sats: 1000, destination_address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080' }),
      });
      const json = await response.json();
      assert.equal(response.status, 503);
      assertCompactHelpfulError(json, {
        error: 'capital_withdrawals_unimplemented',
        hintIncludes: /keep this route disabled/i,
        messageIncludes: /real on-chain sender/i,
      });
    });
  } finally {
    if (previous === undefined) delete process.env.ENABLE_CAPITAL_WITHDRAWALS;
    else process.env.ENABLE_CAPITAL_WITHDRAWALS = previous;
  }

  assert.equal(withdrawCalls, 0);
});

test('submarine swap creation is disabled by default', async () => {
  const app = baseApp();
  app.use(channelMarketRoutes({
    agentRegistry: {
      getByApiKey(apiKey) {
        if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
        return null;
      },
    },
    swapProvider: {
      async createSwap() {
        throw new Error('should not be called');
      },
    },
  }));

  const previous = process.env.ENABLE_SUBMARINE_SWAPS;
  delete process.env.ENABLE_SUBMARINE_SWAPS;
  try {
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/market/swap/lightning-to-onchain`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner',
        },
        body: JSON.stringify({ amount_sats: 100000, onchain_address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080' }),
      });
      const json = await response.json();
      assert.equal(response.status, 503);
      assert.equal(json.error, 'submarine_swaps_disabled');
    });
  } finally {
    if (previous === undefined) delete process.env.ENABLE_SUBMARINE_SWAPS;
    else process.env.ENABLE_SUBMARINE_SWAPS = previous;
  }
});

test('dashboard is open on localhost in dev and requires auth when configured', async () => {
  const daemon = {
    dataLayer: { readLog: async () => [] },
    agentRegistry: { listAll() { return []; } },
    publicLedger: { getSummary: async () => null },
    nodeManager: { getNodeNames() { return []; } },
  };

  const app = baseApp();
  app.use('/dashboard', requireDashboardOperatorAuth);
  app.use(dashboardRoutes(daemon));

  const previous = process.env.OPERATOR_API_SECRET;
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    delete process.env.OPERATOR_API_SECRET;
    await withServer(app, async (baseUrl) => {
      const open = await fetch(`${baseUrl}/dashboard`);
      assert.equal(open.status, 200);
    });

    process.env.NODE_ENV = 'production';
    process.env.OPERATOR_API_SECRET = 'super-secret';
    await withServer(app, async (baseUrl) => {
      const denied = await fetch(`${baseUrl}/dashboard/api/summary`);
      assert.equal(denied.status, 401);

      const auth = Buffer.from('operator:super-secret').toString('base64');
      const allowed = await fetch(`${baseUrl}/dashboard/api/summary`, {
        headers: { Authorization: `Basic ${auth}` },
      });
      assert.equal(allowed.status, 200);
    });
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_API_SECRET;
    else process.env.OPERATOR_API_SECRET = previous;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('help route replays the original response for the same idempotency key', async () => {
  await withTempDir(async (tempDir) => {
    let calls = 0;
    const app = baseApp();
    app.use(agentPaidServicesRoutes({
      dataLayer: new DataLayer(tempDir),
      agentRegistry: {
        getByApiKey(apiKey) {
          if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
          return null;
        },
      },
      helpEndpoint: {
        async ask() {
          calls++;
          return { answer: 'hello', cost_sats: 3, sources: ['docs'] };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer lb-agent-owner',
        'Idempotency-Key': 'help-1',
      };
      const body = JSON.stringify({ question: 'What should I do next?' });
      const first = await fetch(`${baseUrl}/api/v1/help`, { method: 'POST', headers, body });
      const firstJson = await first.json();
      const second = await fetch(`${baseUrl}/api/v1/help`, { method: 'POST', headers, body });
      const secondJson = await second.json();

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(calls, 1);
      assert.deepEqual(secondJson, firstJson);
    });
  });
});

test('help route advertises self-serve fallbacks when the concierge is unavailable', async () => {
  await withTempDir(async (tempDir) => {
    const app = baseApp();
    app.use(agentPaidServicesRoutes({
      dataLayer: new DataLayer(tempDir),
      agentRegistry: {
        getByApiKey(apiKey) {
          if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
          return null;
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/help`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner',
        },
        body: JSON.stringify({ question: 'How do I recover from a failed swap?' }),
      });
      const json = await response.json();

      assert.equal(response.status, 503);
      assertCompactHelpfulError(json, {
        error: 'service_unavailable',
        bodyStatus: 503,
        hintIncludes: /knowledge\/onboarding/i,
        messageIncludes: /temporarily unavailable/i,
        retryable: true,
        see: 'GET /api/v1/knowledge/onboarding',
      });
    });
  });
});

test('help route preserves danger-tier client statuses when the endpoint rejects risky prompts', async () => {
  await withTempDir(async (tempDir) => {
    const app = baseApp();
    app.use(agentPaidServicesRoutes({
      dataLayer: new DataLayer(tempDir),
      agentRegistry: {
        getByApiKey(apiKey) {
          if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
          return null;
        },
      },
      helpEndpoint: {
        async ask() {
          throw Object.assign(new Error('Danger-tier request requires manual review.'), {
            status: 422,
          });
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/help`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner',
        },
        body: JSON.stringify({ question: 'Give me an unsafe ops plan.' }),
      });
      const json = await response.json();

      assert.equal(response.status, 422);
      assertCompactHelpfulError(json, {
        error: 'help_error',
        hintIncludes: /knowledge\/onboarding/i,
        messageIncludes: /manual review/i,
        retryable: false,
      });
      assert.equal(json.retry_after_seconds, undefined);
    });
  });
});

test('market preview throttles repeated attempts before reaching the opener', async () => {
  await withCleanRateLimits(async () => {
    let previewCalls = 0;
    const app = baseApp();
    app.use(channelMarketRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
          return null;
        },
      },
      channelOpener: {
        async preview() {
          previewCalls++;
          return { valid: true, checks_passed: ['payload_present'] };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer lb-agent-owner',
      };

      for (let i = 0; i < 6; i++) {
        const body = JSON.stringify({
          instruction: {
            params: {
              local_funding_amount_sats: 50_000 + i,
            },
          },
          signature: 'sig',
        });
        const response = await fetch(`${baseUrl}/api/v1/market/preview`, { method: 'POST', headers, body });
        assert.equal(response.status, 200, `preview request ${i + 1}`);
      }

      const body = JSON.stringify({
        instruction: {
          params: {
            local_funding_amount_sats: 60_000,
          },
        },
        signature: 'sig',
      });
      const blocked = await fetch(`${baseUrl}/api/v1/market/preview`, { method: 'POST', headers, body });
      const json = await blocked.json();

      assert.equal(blocked.status, 429);
      assertCompactHelpfulError(json, {
        error: 'cooldown_active',
        hintIncludes: /another preview/i,
        messageIncludes: /too many market preview attempts/i,
        retryable: true,
      });
      assert.ok(json.retry_after_seconds > 0);
    });

    assert.equal(previewCalls, 6);
  });
});

test('market preview enforces the shared node-wide preview cap across agents', async () => {
  await withCleanRateLimits(async () => {
    let previewCalls = 0;
    const app = baseApp();
    app.use(channelMarketRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (/^lb-agent-owner-[1-5]$/.test(apiKey)) {
            return { id: apiKey.replace('lb-agent-', '') };
          }
          return null;
        },
      },
      channelOpener: {
        async preview() {
          previewCalls++;
          return { valid: true, checks_passed: ['payload_present'] };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      for (let i = 0; i < 24; i++) {
        const agentNumber = (i % 4) + 1;
        const body = JSON.stringify({
          instruction: {
            params: {
              local_funding_amount_sats: 50_000 + i,
            },
          },
          signature: 'sig',
        });
        const response = await fetch(`${baseUrl}/api/v1/market/preview`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer lb-agent-owner-${agentNumber}`,
          },
          body,
        });
        assert.equal(response.status, 200, `shared preview request ${i + 1}`);
      }

      const body = JSON.stringify({
        instruction: {
          params: {
            local_funding_amount_sats: 99_999,
          },
        },
        signature: 'sig',
      });
      const blocked = await fetch(`${baseUrl}/api/v1/market/preview`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner-5',
        },
        body,
      });
      const json = await blocked.json();

      assert.equal(blocked.status, 429);
      assertCompactHelpfulError(json, {
        error: 'cooldown_active',
        hintIncludes: /try your preview again/i,
        messageIncludes: /too many market previews/i,
        retryable: true,
      });
      assert.ok(json.retry_after_seconds > 0);
    });

    assert.equal(previewCalls, 24);
  });
});

test('rebalance estimate throttles repeated attempts before running the estimator', async () => {
  await withCleanRateLimits(async () => {
    let estimateCalls = 0;
    const app = baseApp();
    app.use(channelMarketRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
          return null;
        },
      },
      rebalanceExecutor: {
        async estimateRebalanceFee() {
          estimateCalls++;
          return { success: true, estimated_fee_sats: 21 };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer lb-agent-owner',
      };

      for (let i = 0; i < 6; i++) {
        const body = JSON.stringify({
          outbound_chan_id: `12345${i}`,
          amount_sats: 10_000 + i,
        });
        const response = await fetch(`${baseUrl}/api/v1/market/rebalance/estimate`, { method: 'POST', headers, body });
        assert.equal(response.status, 200, `estimate request ${i + 1}`);
      }

      const body = JSON.stringify({
        outbound_chan_id: '1234599',
        amount_sats: 10_999,
      });
      const blocked = await fetch(`${baseUrl}/api/v1/market/rebalance/estimate`, { method: 'POST', headers, body });
      const json = await blocked.json();

      assert.equal(blocked.status, 429);
      assertCompactHelpfulError(json, {
        error: 'cooldown_active',
        hintIncludes: /fee estimate/i,
        messageIncludes: /too many rebalance-estimate attempts/i,
        retryable: true,
      });
      assert.ok(json.retry_after_seconds > 0);
    });

    assert.equal(estimateCalls, 6);
  });
});

test('rebalance estimate enforces the shared node-wide estimate cap across agents', async () => {
  await withCleanRateLimits(async () => {
    let estimateCalls = 0;
    const app = baseApp();
    app.use(channelMarketRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (/^lb-agent-owner-[1-5]$/.test(apiKey)) {
            return { id: apiKey.replace('lb-agent-', '') };
          }
          return null;
        },
      },
      rebalanceExecutor: {
        async estimateRebalanceFee() {
          estimateCalls++;
          return { success: true, estimated_fee_sats: 21 };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      for (let i = 0; i < 24; i++) {
        const agentNumber = (i % 4) + 1;
        const body = JSON.stringify({
          outbound_chan_id: `12345${i}`,
          amount_sats: 10_000 + i,
        });
        const response = await fetch(`${baseUrl}/api/v1/market/rebalance/estimate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer lb-agent-owner-${agentNumber}`,
          },
          body,
        });
        assert.equal(response.status, 200, `shared estimate request ${i + 1}`);
      }

      const body = JSON.stringify({
        outbound_chan_id: '1234599',
        amount_sats: 10_999,
      });
      const blocked = await fetch(`${baseUrl}/api/v1/market/rebalance/estimate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner-5',
        },
        body,
      });
      const json = await blocked.json();

      assert.equal(blocked.status, 429);
      assertCompactHelpfulError(json, {
        error: 'cooldown_active',
        hintIncludes: /another estimate/i,
        messageIncludes: /too many rebalance estimates/i,
        retryable: true,
      });
      assert.ok(json.retry_after_seconds > 0);
    });

    assert.equal(estimateCalls, 24);
  });
});

test('channels preview enforces the shared node-wide preview cap across channel IDs', async () => {
  await withCleanRateLimits(async () => {
    let previewCalls = 0;
    const app = baseApp();
    app.use(channelAccountabilityRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (/^lb-agent-owner-[1-5]$/.test(apiKey)) {
            return { id: apiKey.replace('lb-agent-', '') };
          }
          return null;
        },
      },
      channelExecutor: {
        async preview() {
          previewCalls++;
          return { valid: true, checks_passed: ['payload_present'] };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      for (let i = 0; i < 24; i++) {
        const agentNumber = (i % 4) + 1;
        const response = await fetch(`${baseUrl}/api/v1/channels/preview`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer lb-agent-owner-${agentNumber}`,
          },
          body: JSON.stringify({
            instruction: {
              channel_id: `chan-${i}`,
            },
            signature: 'sig',
          }),
        });
        assert.equal(response.status, 200, `shared channels preview request ${i + 1}`);
      }

      const blocked = await fetch(`${baseUrl}/api/v1/channels/preview`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner-5',
        },
        body: JSON.stringify({
          instruction: {
            channel_id: 'chan-overflow',
          },
          signature: 'sig',
        }),
      });
      const json = await blocked.json();

      assert.equal(blocked.status, 429);
      assertCompactHelpfulError(json, {
        error: 'cooldown_active',
        hintIncludes: /preview your channel change again/i,
        messageIncludes: /too many signed channel previews/i,
        retryable: true,
      });
      assert.ok(json.retry_after_seconds > 0);
    });

    assert.equal(previewCalls, 24);
  });
});

test('market open replays the original response for the same idempotency key', async () => {
  await withTempDir(async (tempDir) => {
    let calls = 0;
    const app = baseApp();
    app.use(channelMarketRoutes({
      dataLayer: new DataLayer(tempDir),
      agentRegistry: {
        getByApiKey(apiKey) {
          if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
          return null;
        },
      },
      channelOpener: {
        async open() {
          calls++;
          return { success: true, pending_id: 'open-1' };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer lb-agent-owner',
        'Idempotency-Key': 'market-open-1',
      };
      const body = JSON.stringify({ instruction: { action: 'channel_open' }, signature: 'abc' });
      const first = await fetch(`${baseUrl}/api/v1/market/open`, { method: 'POST', headers, body });
      const firstJson = await first.json();
      const second = await fetch(`${baseUrl}/api/v1/market/open`, { method: 'POST', headers, body });
      const secondJson = await second.json();

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(calls, 1);
      assert.deepEqual(secondJson, firstJson);
    });
  });
});

test('market open enforces cooldown after a successful open', async () => {
  await withCleanRateLimits(async () => {
    let openCalls = 0;
    const app = baseApp();
    app.use(channelMarketRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
          return null;
        },
      },
      channelOpener: {
        getPendingForAgent() {
          return [];
        },
        async open() {
          openCalls++;
          return { success: true, result: { status: 'pending_open', channel_point: 'abc:0' } };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer lb-agent-owner',
      };
      const body = JSON.stringify({
        instruction: {
          params: {
            local_funding_amount_sats: 50_000,
          },
        },
        signature: 'sig',
      });

      const first = await fetch(`${baseUrl}/api/v1/market/open`, { method: 'POST', headers, body });
      assert.equal(first.status, 200);

      const second = await fetch(`${baseUrl}/api/v1/market/open`, { method: 'POST', headers, body });
      const json = await second.json();

      assert.equal(second.status, 429);
      assertCompactHelpfulError(json, {
        error: 'cooldown_active',
        hintIncludes: /cooldown window/i,
        messageIncludes: /recent channel open is still cooling down/i,
        retryable: true,
      });
      assert.ok(json.retry_after_seconds > 0);
    });

    assert.equal(openCalls, 1);
  });
});

test('market open does not auto-review larger self-funded amounts', async () => {
  await withCleanRateLimits(async () => {
    const app = baseApp();
    app.use(channelMarketRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
          return null;
        },
      },
      channelOpener: {
        getPendingForAgent() {
          return [];
        },
        async open() {
          return {
            success: true,
            result: {
              status: 'pending_open',
              channel_point: 'larger:0',
              local_funding_amount_sats: 120_000,
            },
          };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/market/open`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner',
        },
        body: JSON.stringify({
          instruction: {
            params: {
              local_funding_amount_sats: 120_000,
            },
          },
          signature: 'sig',
        }),
      });
      const json = await response.json();

      assert.equal(response.status, 200);
      assert.equal(json.result?.channel_point, 'larger:0');
      assert.equal(json.result?.local_funding_amount_sats, 120_000);
    });
  });
});

test('market open enforces a shared node-wide cooldown after a successful open', async () => {
  await withCleanRateLimits(async () => {
    let openCalls = 0;
    const app = baseApp();
    app.use(channelMarketRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (/^lb-agent-owner-[12]$/.test(apiKey)) {
            return { id: apiKey.replace('lb-agent-', '') };
          }
          return null;
        },
      },
      channelOpener: {
        getPendingForAgent() {
          return [];
        },
        async open() {
          openCalls++;
          return { success: true, result: { status: 'pending_open', channel_point: `abc:${openCalls}` } };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const body = JSON.stringify({
        instruction: { params: { local_funding_amount_sats: 50_000 } },
        signature: 'sig',
      });

      const first = await fetch(`${baseUrl}/api/v1/market/open`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner-1',
        },
        body,
      });
      assert.equal(first.status, 200);

      const second = await fetch(`${baseUrl}/api/v1/market/open`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner-2',
        },
        body,
      });
      const json = await second.json();

      assert.equal(second.status, 429);
      assertCompactHelpfulError(json, {
        error: 'cooldown_active',
        hintIncludes: /another agent opens/i,
        messageIncludes: /node is cooling down after a recent channel open/i,
        retryable: true,
      });
    });

    assert.equal(openCalls, 1);
  });
});

test('market open enforces the shared node-wide attempt cap across agents', async () => {
  await withCleanRateLimits(async () => {
    let openCalls = 0;
    const app = baseApp();
    app.use(channelMarketRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (/^lb-agent-owner-[1-5]$/.test(apiKey)) {
            return { id: apiKey.replace('lb-agent-', '') };
          }
          return null;
        },
      },
      channelOpener: {
        getPendingForAgent() {
          return [];
        },
        async open() {
          openCalls++;
          return { success: true, result: { status: 'pending_open', channel_point: `abc:${openCalls}` } };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const body = JSON.stringify({ instruction: { action: 'channel_open' }, signature: 'sig' });

      for (let i = 0; i < 12; i++) {
        const agentNumber = (i % 4) + 1;
        const response = await fetch(`${baseUrl}/api/v1/market/open`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer lb-agent-owner-${agentNumber}`,
          },
          body,
        });
        assert.equal(response.status, 200, `shared market open request ${i + 1}`);
      }

      const blocked = await fetch(`${baseUrl}/api/v1/market/open`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner-5',
        },
        body,
      });
      const json = await blocked.json();

      assert.equal(blocked.status, 429);
      assertCompactHelpfulError(json, {
        error: 'cooldown_active',
        hintIncludes: /another channel open/i,
        messageIncludes: /too many channel-open attempts/i,
        retryable: true,
      });
      assert.ok(json.retry_after_seconds > 0);
    });

    assert.equal(openCalls, 12);
  });
});

test('market close enforces the shared node-wide attempt cap across agents', async () => {
  await withCleanRateLimits(async () => {
    let closeCalls = 0;
    const app = baseApp();
    app.use(channelMarketRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (/^lb-agent-owner-[1-5]$/.test(apiKey)) {
            return { id: apiKey.replace('lb-agent-', '') };
          }
          return null;
        },
      },
      channelCloser: {
        getPendingForAgent() {
          return [];
        },
        async requestClose() {
          closeCalls++;
          return { success: false, status: 400, error: 'channel_busy' };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const body = JSON.stringify({ instruction: { action: 'channel_close' }, signature: 'sig' });

      for (let i = 0; i < 12; i++) {
        const agentNumber = (i % 4) + 1;
        const response = await fetch(`${baseUrl}/api/v1/market/close`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer lb-agent-owner-${agentNumber}`,
          },
          body,
        });
        assert.equal(response.status, 400, `shared market close request ${i + 1}`);
      }

      const blocked = await fetch(`${baseUrl}/api/v1/market/close`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner-5',
        },
        body,
      });
      const json = await blocked.json();

      assert.equal(blocked.status, 429);
      assertCompactHelpfulError(json, {
        error: 'cooldown_active',
        hintIncludes: /another channel close/i,
        messageIncludes: /too many channel-close attempts/i,
        retryable: true,
      });
      assert.ok(json.retry_after_seconds > 0);
    });

    assert.equal(closeCalls, 12);
  });
});

test('market close enforces a shared node-wide cooldown after a successful close', async () => {
  await withCleanRateLimits(async () => {
    let closeCalls = 0;
    const app = baseApp();
    app.use(channelMarketRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (/^lb-agent-owner-[12]$/.test(apiKey)) {
            return { id: apiKey.replace('lb-agent-', '') };
          }
          return null;
        },
      },
      channelCloser: {
        getPendingForAgent() {
          return [];
        },
        async requestClose() {
          closeCalls++;
          return { success: true, status: 'pending_close', channel_point: `close:${closeCalls}` };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const body = JSON.stringify({ instruction: { action: 'channel_close' }, signature: 'sig' });

      const first = await fetch(`${baseUrl}/api/v1/market/close`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner-1',
        },
        body,
      });
      assert.equal(first.status, 200);

      const second = await fetch(`${baseUrl}/api/v1/market/close`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner-2',
        },
        body,
      });
      const json = await second.json();

      assert.equal(second.status, 429);
      assertCompactHelpfulError(json, {
        error: 'cooldown_active',
        hintIncludes: /another agent closes/i,
        messageIncludes: /node is cooling down after a recent channel close/i,
        retryable: true,
      });
    });

    assert.equal(closeCalls, 1);
  });
});

test('market rebalance enforces the shared node-wide attempt cap across agents', async () => {
  await withCleanRateLimits(async () => {
    let rebalanceCalls = 0;
    const app = baseApp();
    app.use(channelMarketRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (/^lb-agent-owner-[1-5]$/.test(apiKey)) {
            return { id: apiKey.replace('lb-agent-', '') };
          }
          return null;
        },
      },
      rebalanceExecutor: {
        async requestRebalance() {
          rebalanceCalls++;
          return { success: false, status: 400, error: 'rebalance_unavailable', hint: 'test-only failure' };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const body = JSON.stringify({ instruction: { action: 'rebalance', params: {} }, signature: 'sig' });

      for (let i = 0; i < 12; i++) {
        const agentNumber = (i % 4) + 1;
        const response = await fetch(`${baseUrl}/api/v1/market/rebalance`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer lb-agent-owner-${agentNumber}`,
          },
          body,
        });
        assert.equal(response.status, 400, `shared market rebalance request ${i + 1}`);
      }

      const blocked = await fetch(`${baseUrl}/api/v1/market/rebalance`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner-5',
        },
        body,
      });
      const json = await blocked.json();

      assert.equal(blocked.status, 429);
      assertCompactHelpfulError(json, {
        error: 'cooldown_active',
        hintIncludes: /another rebalance/i,
        messageIncludes: /too many rebalance attempts/i,
        retryable: true,
      });
      assert.ok(json.retry_after_seconds > 0);
    });

    assert.equal(rebalanceCalls, 12);
  });
});

test('market rebalance validates the signed request before cooldowns', async () => {
  await withCleanRateLimits(async () => {
    let requestCalls = 0;
    const app = baseApp();
    app.use(channelMarketRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
          return null;
        },
      },
      rebalanceExecutor: {
        async validateRequest() {
          return {
            success: false,
            status: 401,
            error: 'Invalid secp256k1 signature',
            hint: 'Sign the exact instruction again with your registered key.',
          };
        },
        async requestRebalance() {
          requestCalls++;
          return { success: true };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const body = JSON.stringify({
        instruction: { action: 'rebalance', params: { outbound_chan_id: 'missing-outbound-chan', amount_sats: 10_000, max_fee_sats: 10 } },
        signature: 'bad-signature',
      });

      const first = await fetch(`${baseUrl}/api/v1/market/rebalance`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner',
        },
        body,
      });
      const firstJson = await first.json();
      assert.equal(first.status, 401);
      assert.equal(firstJson.error, 'Invalid secp256k1 signature');

      const second = await fetch(`${baseUrl}/api/v1/market/rebalance`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner',
        },
        body,
      });
      const secondJson = await second.json();
      assert.equal(second.status, 401);
      assert.equal(secondJson.error, 'Invalid secp256k1 signature');
    });

    assert.equal(requestCalls, 0);
  });
});

test('market rebalance enforces a shared node-wide cooldown after a successful rebalance', async () => {
  await withCleanRateLimits(async () => {
    let rebalanceCalls = 0;
    const app = baseApp();
    app.use(channelMarketRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (/^lb-agent-owner-[12]$/.test(apiKey)) {
            return { id: apiKey.replace('lb-agent-', '') };
          }
          return null;
        },
      },
      rebalanceExecutor: {
        async requestRebalance() {
          rebalanceCalls++;
          return { success: true, status: 'succeeded', outbound_chan_id: `rebalance-${rebalanceCalls}` };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const body = JSON.stringify({ instruction: { action: 'rebalance', params: {} }, signature: 'sig' });
      const cooldownBody = JSON.stringify({
        instruction: { action: 'rebalance', params: { amount_sats: 10_000 } },
        signature: 'sig',
      });

      const first = await fetch(`${baseUrl}/api/v1/market/rebalance`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner-1',
        },
        body: cooldownBody,
      });
      assert.equal(first.status, 200);

      const second = await fetch(`${baseUrl}/api/v1/market/rebalance`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner-2',
        },
        body: cooldownBody,
      });
      const json = await second.json();

      assert.equal(second.status, 429);
      assertCompactHelpfulError(json, {
        error: 'cooldown_active',
        hintIncludes: /another agent starts a rebalance/i,
        messageIncludes: /node is cooling down after a recent rebalance/i,
        retryable: true,
      });
    });

    assert.equal(rebalanceCalls, 1);
  });
});

test('channels instruct enforces the shared node-wide attempt cap across agents', async () => {
  await withCleanRateLimits(async () => {
    let executeCalls = 0;
    const app = baseApp();
    app.use(channelAccountabilityRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (/^lb-agent-owner-[1-5]$/.test(apiKey)) {
            return { id: apiKey.replace('lb-agent-', '') };
          }
          return null;
        },
      },
      channelExecutor: {
        async execute(_agentId, body) {
          executeCalls++;
          return {
            success: false,
            status: 400,
            error: 'validation_error',
            hint: `Rejected test update for ${body.instruction.channel_id}.`,
            failed_at: 'constraints_met',
            checks_passed: ['payload_present'],
          };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      for (let i = 0; i < 8; i++) {
        const agentNumber = (i % 4) + 1;
        const response = await fetch(`${baseUrl}/api/v1/channels/instruct`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer lb-agent-owner-${agentNumber}`,
          },
          body: JSON.stringify({
            instruction: {
              channel_id: `chan-${agentNumber}`,
              action: 'set_fee_policy',
              params: { fee_rate_ppm: 100 + i },
            },
            signature: 'sig',
          }),
        });
        assert.equal(response.status, 400, `shared channels instruct request ${i + 1}`);
      }

      const blocked = await fetch(`${baseUrl}/api/v1/channels/instruct`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner-5',
        },
        body: JSON.stringify({
          instruction: {
            channel_id: 'chan-5',
            action: 'set_fee_policy',
            params: { fee_rate_ppm: 999 },
          },
          signature: 'sig',
        }),
      });
      const json = await blocked.json();

      assert.equal(blocked.status, 429);
      assertCompactHelpfulError(json, {
        error: 'cooldown_active',
        hintIncludes: /fee-policy or htlc update/i,
        messageIncludes: /too many signed channel updates/i,
      });
      assert.ok(json.retry_after_seconds > 0);
    });

    assert.equal(executeCalls, 8);
  });
});

test('channels instruct enforces a shared node-wide cooldown after a successful signed update', async () => {
  await withCleanRateLimits(async () => {
    let executeCalls = 0;
    const app = baseApp();
    app.use(channelAccountabilityRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (/^lb-agent-owner-[12]$/.test(apiKey)) {
            return { id: apiKey.replace('lb-agent-', '') };
          }
          return null;
        },
      },
      channelExecutor: {
        async execute(_agentId, body) {
          executeCalls++;
          return {
            success: true,
            result: {
              channel_id: body.instruction.channel_id,
              action: body.instruction.action || 'set_fee_policy',
              params: body.instruction.params || {},
              executed_at: Date.now(),
              next_allowed_at: Date.now() + 60_000,
            },
            learn: 'Applied for testing.',
          };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const first = await fetch(`${baseUrl}/api/v1/channels/instruct`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner-1',
        },
        body: JSON.stringify({
          instruction: {
            channel_id: 'chan-1',
            action: 'set_fee_policy',
            params: { fee_rate_ppm: 111 },
          },
          signature: 'sig',
        }),
      });
      assert.equal(first.status, 200);

      const second = await fetch(`${baseUrl}/api/v1/channels/instruct`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner-2',
        },
        body: JSON.stringify({
          instruction: {
            channel_id: 'chan-2',
            action: 'set_fee_policy',
            params: { fee_rate_ppm: 222 },
          },
          signature: 'sig',
        }),
      });
      const json = await second.json();

      assert.equal(second.status, 429);
      assertCompactHelpfulError(json, {
        error: 'cooldown_active',
        hintIncludes: /anywhere on this node/i,
        messageIncludes: /node is cooling down after a recent signed channel update/i,
      });
    });

    assert.equal(executeCalls, 1);
  });
});

test('channels instruct replays the original response for the same idempotency key', async () => {
  await withTempDir(async (tempDir) => {
    let executeCalls = 0;
    const app = baseApp();
    app.use(channelAccountabilityRoutes({
      dataLayer: new DataLayer(tempDir),
      agentRegistry: {
        getByApiKey(apiKey) {
          if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
          return null;
        },
      },
      channelExecutor: {
        async execute(_agentId, body) {
          executeCalls++;
          return {
            success: true,
            result: {
              channel_id: body.instruction.channel_id,
              action: body.instruction.action,
              params: body.instruction.params,
            },
            learn: 'Applied once.',
          };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer lb-agent-owner',
        'Idempotency-Key': 'channels-instruct-1',
      };
      const body = JSON.stringify({
        instruction: {
          channel_id: 'chan-1',
          action: 'set_fee_policy',
          params: { fee_rate_ppm: 111 },
        },
        signature: 'sig',
      });

      const first = await fetch(`${baseUrl}/api/v1/channels/instruct`, { method: 'POST', headers, body });
      const firstJson = await first.json();
      const second = await fetch(`${baseUrl}/api/v1/channels/instruct`, { method: 'POST', headers, body });
      const secondJson = await second.json();

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(executeCalls, 1);
      assert.deepEqual(secondJson, firstJson);
    });
  });
});

test('channels instruct enforces an agent-wide cap across different channel ids', async () => {
  await withCleanRateLimits(async () => {
    let executeCalls = 0;
    const app = baseApp();
    app.use(channelAccountabilityRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
          return null;
        },
      },
      channelExecutor: {
        async execute(_agentId, body) {
          executeCalls++;
          return {
            success: false,
            status: 400,
            error: 'validation_error',
            hint: `Rejected test update for ${body.instruction.channel_id}.`,
            failed_at: 'constraints_met',
            checks_passed: ['payload_present'],
          };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      for (let i = 0; i < 3; i++) {
        const response = await fetch(`${baseUrl}/api/v1/channels/instruct`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer lb-agent-owner',
          },
          body: JSON.stringify({
            instruction: {
              channel_id: `chan-${i + 1}`,
              action: 'set_fee_policy',
              params: { fee_rate_ppm: 100 + i },
            },
            signature: 'sig',
          }),
        });
        assert.equal(response.status, 400, `agent-wide request ${i + 1}`);
      }

      const blocked = await fetch(`${baseUrl}/api/v1/channels/instruct`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner',
        },
        body: JSON.stringify({
          instruction: {
            channel_id: 'chan-4',
            action: 'set_fee_policy',
            params: { fee_rate_ppm: 999 },
          },
          signature: 'sig',
        }),
      });
      const json = await blocked.json();

      assert.equal(blocked.status, 429);
      assertCompactHelpfulError(json, {
        error: 'cooldown_active',
        hintIncludes: /another signed channel update/i,
        messageIncludes: /across your channels this hour/i,
      });
    });

    assert.equal(executeCalls, 3);
  });
});

test('fund-from-ecash enforces the same cooldown guardrails as channel open', async () => {
  await withCleanRateLimits(async () => {
    let fundCalls = 0;
    const app = baseApp();
    app.use(channelMarketRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
          return null;
        },
      },
      ecashChannelFunder: {
        getPendingForAgent() {
          return [];
        },
        async fundChannelFromEcash() {
          fundCalls++;
          return { success: true, status: 'pending_open', flow_id: 'flow-1' };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer lb-agent-owner',
        'Idempotency-Key': 'fund-1',
      };
      const body = JSON.stringify({
        instruction: {
          params: {
            local_funding_amount_sats: 50_000,
          },
        },
        signature: 'sig',
      });

      const first = await fetch(`${baseUrl}/api/v1/market/fund-from-ecash`, { method: 'POST', headers, body });
      assert.equal(first.status, 200);

      const second = await fetch(`${baseUrl}/api/v1/market/fund-from-ecash`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner',
          'Idempotency-Key': 'fund-2',
        },
        body,
      });
      const json = await second.json();

      assert.equal(second.status, 429);
      assertCompactHelpfulError(json, {
        error: 'cooldown_active',
        hintIncludes: /funding another channel from ecash/i,
        messageIncludes: /still cooling down/i,
      });
    });

    assert.equal(fundCalls, 1);
  });
});

test('fund-from-ecash does not auto-review larger agent-funded amounts', async () => {
  await withCleanRateLimits(async () => {
    const app = baseApp();
    app.use(channelMarketRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
          return null;
        },
      },
      ecashChannelFunder: {
        getPendingForAgent() {
          return [];
        },
        async fundChannelFromEcash() {
          return { success: true, status: 'pending_open', flow_id: 'flow-large' };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/market/fund-from-ecash`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner',
        },
        body: JSON.stringify({
          instruction: {
            params: {
              local_funding_amount_sats: 120_000,
            },
          },
          signature: 'sig',
        }),
      });
      const json = await response.json();

      assert.equal(response.status, 200);
      assert.equal(json.flow_id, 'flow-large');
    });
  });
});

test('market rebalance does not auto-review larger agent-funded amounts', async () => {
  await withCleanRateLimits(async () => {
    const app = baseApp();
    app.use(channelMarketRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
          return null;
        },
      },
      rebalanceExecutor: {
        async requestRebalance() {
          return { success: true, status: 'succeeded', outbound_chan_id: 'rebalance-large' };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/market/rebalance`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer lb-agent-owner',
        },
        body: JSON.stringify({
          instruction: {
            params: {
              amount_sats: 120_000,
              max_fee_sats: 5_000,
            },
          },
          signature: 'sig',
        }),
      });
      const json = await response.json();

      assert.equal(response.status, 200);
      assert.equal(json.outbound_chan_id, 'rebalance-large');
    });
  });
});

test('market preview shares identical in-flight work for duplicate requests', async () => {
  await withCleanRateLimits(async () => {
    let previewCalls = 0;
    const app = baseApp();
    app.use(channelMarketRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
          return null;
        },
      },
      channelOpener: {
        async preview() {
          previewCalls++;
          await new Promise(resolve => setTimeout(resolve, 20));
          return { valid: true, checks_passed: ['payload_present'] };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer lb-agent-owner',
      };
      const body = JSON.stringify({
        instruction: {
          params: {
            local_funding_amount_sats: 50_000,
          },
        },
        signature: 'sig',
      });

      const [first, second] = await Promise.all([
        fetch(`${baseUrl}/api/v1/market/preview`, { method: 'POST', headers, body }),
        fetch(`${baseUrl}/api/v1/market/preview`, { method: 'POST', headers, body }),
      ]);

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
    });

    assert.equal(previewCalls, 1);
  });
});

test('rebalance estimate shares identical in-flight work for duplicate requests', async () => {
  await withCleanRateLimits(async () => {
    let estimateCalls = 0;
    const app = baseApp();
    app.use(channelMarketRoutes({
      agentRegistry: {
        getByApiKey(apiKey) {
          if (apiKey === 'lb-agent-owner') return { id: 'owner-agent' };
          return null;
        },
      },
      rebalanceExecutor: {
        async estimateRebalanceFee() {
          estimateCalls++;
          await new Promise(resolve => setTimeout(resolve, 20));
          return { success: true, estimated_fee_sats: 12 };
        },
      },
    }));

    await withServer(app, async (baseUrl) => {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer lb-agent-owner',
      };
      const body = JSON.stringify({
        outbound_chan_id: '123',
        amount_sats: 50_000,
      });

      const [first, second] = await Promise.all([
        fetch(`${baseUrl}/api/v1/market/rebalance/estimate`, { method: 'POST', headers, body }),
        fetch(`${baseUrl}/api/v1/market/rebalance/estimate`, { method: 'POST', headers, body }),
      ]);

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
    });

    assert.equal(estimateCalls, 1);
  });
});

test('operator routes require a configured secret', async () => {
  const daemon = {
    agentRegistry: {
      getByApiKey() { return null; },
      getById() { return { id: 'owner-agent' }; },
    },
    nodeManager: {
      getDefaultNodeOrNull() {
        return {
          async listChannels() {
            return { channels: [] };
          },
        };
      },
    },
    channelAssignments: {
      async assign() {
        throw new Error('should not be called');
      },
    },
  };

  const previousEnabled = process.env.ENABLE_OPERATOR_ROUTES;
  const previousSecret = process.env.OPERATOR_API_SECRET;
  try {
    process.env.ENABLE_OPERATOR_ROUTES = '1';
    delete process.env.OPERATOR_API_SECRET;
    const app = baseApp();
    app.use(channelAccountabilityRoutes(daemon));
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/channels/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: 'owner-agent', channel_point: 'abc:0' }),
      });
      const json = await response.json();
      assert.equal(response.status, 503);
      assert.equal(json.error, 'operator_misconfigured');
    });
  } finally {
    if (previousEnabled === undefined) delete process.env.ENABLE_OPERATOR_ROUTES;
    else process.env.ENABLE_OPERATOR_ROUTES = previousEnabled;
    if (previousSecret === undefined) delete process.env.OPERATOR_API_SECRET;
    else process.env.OPERATOR_API_SECRET = previousSecret;
  }
});
