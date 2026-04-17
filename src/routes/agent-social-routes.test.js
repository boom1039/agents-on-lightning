import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';

import { configureRateLimiterPolicy } from '../identity/rate-limiter.js';
import {
  INTERNAL_AUTH_AUDIENCE_HEADER,
  INTERNAL_AUTH_PAYLOAD_HASH_HEADER,
  INTERNAL_VERIFIED_AGENT_ID_HEADER,
} from '../identity/signed-auth.js';
import { agentSocialRoutes } from './agent-social-routes.js';

const TEST_INTERNAL_MCP_SECRET = 'test-social-route-internal-mcp';

function authHeaders(agentId) {
  return {
    'x-aol-internal-mcp': TEST_INTERNAL_MCP_SECRET,
    [INTERNAL_VERIFIED_AGENT_ID_HEADER]: agentId,
    [INTERNAL_AUTH_PAYLOAD_HASH_HEADER]: 'a'.repeat(64),
    [INTERNAL_AUTH_AUDIENCE_HEADER]: 'http://127.0.0.1/mcp',
  };
}

async function startSocialRouteApp(daemon) {
  configureRateLimiterPolicy({
    categories: {
      discovery: { limit: 100, windowMs: 60_000 },
      social_read: { limit: 100, windowMs: 60_000 },
      social_write: { limit: 100, windowMs: 60_000 },
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
  process.env.AOL_INTERNAL_MCP_SECRET = TEST_INTERNAL_MCP_SECRET;
  app.use(agentSocialRoutes(daemon));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

test('message validation tells agents the exact content limits', async () => {
  let sendCalled = false;
  const daemon = {
    agentRegistry: {
      getById: (agentId) => (agentId === 'aaaaaaaa' ? { id: agentId, name: 'sender' } : null),
    },
    messaging: {
      send: async () => {
        sendCalled = true;
        return {};
      },
    },
  };
  const { server, baseUrl } = await startSocialRouteApp(daemon);

  try {
    const response = await fetch(new URL('/api/v1/messages', baseUrl), {
      method: 'POST',
      headers: {
        ...authHeaders('aaaaaaaa'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        to: 'bbbbbbbb',
        content: 'x'.repeat(321),
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, 'validation_error');
    assert.match(body.message, /content lines must be 320 characters or less/);
    assert.match(body.hint, /2,000 characters total, 24 lines, and 320 characters per line/);
    assert.equal(sendCalled, false);
  } finally {
    server.close();
  }
});
