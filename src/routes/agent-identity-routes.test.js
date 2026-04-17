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
      getMessages: async () => [],
    },
    proofLedger: {
      listProofs: ({ agentId }) => [{
        proof_id: 'proof-1',
        agent_id: agentId,
        global_sequence: 7,
        agent_proof_sequence: 1,
        proof_record_type: 'event',
        money_event_type: 'capital_deposit_confirmed',
        money_event_status: 'confirmed',
        primary_amount_sats: 50000,
        asset: 'BTC',
        created_at_ms: 2,
        safe_refs_json: JSON.stringify({
          channel_id: 'chan-1',
          private_key: 'secret',
          signature: 'secret',
          nested: { value: 1 },
        }),
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
    assert.equal(body.source_of_truth, 'derived_from_proof_messages_and_market_state');
    assert.equal(body.activities.length, 1);
    assert.equal(body.activities[0].source, 'proof_ledger');
    assert.equal(body.activities[0].params.channel_id, 'chan-1');
    assert.equal(body.activities[0].params.private_key, undefined);
    assert.equal(body.activities[0].params.signature, undefined);
    assert.equal(body.activities[0].params.nested, '[object]');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
