import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';

import { configureRateLimiterPolicy } from '../identity/rate-limiter.js';
import { agentIdentityRoutes, validateNodeCredentialsShape } from './agent-identity-routes.js';

test('node credential shape rejects tiny placeholder credentials before network verification', () => {
  assert.match(validateNodeCredentialsShape('00', '00'), /macaroon/);
  assert.match(validateNodeCredentialsShape('ab'.repeat(16), '00'), /tls_cert/);
  assert.equal(validateNodeCredentialsShape('ab'.repeat(16), 'cd'.repeat(32)), null);
});

test('public agent activity returns sanitized params', async () => {
  configureRateLimiterPolicy({
    categories: {
      discovery: { limit: 100, windowMs: 60_000 },
      identity_read: { limit: 100, windowMs: 60_000 },
      identity_write: { limit: 100, windowMs: 60_000 },
      node_write: { limit: 100, windowMs: 60_000 },
      registration: { limit: 100, windowMs: 60_000 },
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
  app.use(agentIdentityRoutes({
    agentRegistry: {
      getPublicProfile: async (agentId) => (agentId === 'abcd1234' ? { id: agentId, name: 'agent' } : null),
      getActivities: async (agentId) => [{
        activity_id: 'activity-1',
        agent_id: agentId,
        activity_type: 'inspect_market',
        description: 'safe public activity',
        status: 'confirmed',
        submitted_at: 2,
        params: {
          channel_id: 'chan-1',
          private_key: 'secret',
          signature: 'secret',
          nested: { value: 1 },
        },
      }],
    },
  }));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/agents/abcd1234/activity?limit=5`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.activities.length, 1);
    assert.equal(body.activities[0].params.channel_id, 'chan-1');
    assert.equal(body.activities[0].params.private_key, undefined);
    assert.equal(body.activities[0].params.signature, undefined);
    assert.equal(body.activities[0].params.nested, '[object]');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
