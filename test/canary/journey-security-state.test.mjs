import test from 'node:test';
import assert from 'node:assert/strict';

import { LiveJourneyState } from '../../monitoring_dashboards/live/state.mjs';

test('journey state tracks route security warning counters from live events', () => {
  const state = new LiveJourneyState();
  const ts = Date.now();

  state.applyEvent({
    event: 'auth_failure',
    method: 'POST',
    path: '/api/v1/market/open',
    ts,
  });

  state.applyEvent({
    event: 'rate_limit_hit',
    method: 'POST',
    path: '/api/v1/market/open',
    ts: ts + 1,
  });

  state.applyEvent({
    event: 'validation_failure',
    method: 'POST',
    path: '/api/v1/market/open',
    ts: ts + 2,
  });

  state.applyEvent({
    event: 'authz_denied',
    method: 'POST',
    path: '/api/v1/market/open',
    ts: ts + 3,
  });

  state.applyEvent({
    event: 'request_start',
    method: 'POST',
    path: '/api/v1/market/open',
    agent_id: 'agent-1',
    trace_id: 'trace-1',
    ts: ts + 4,
  });

  state.applyEvent({
    event: 'request_finish',
    method: 'POST',
    path: '/api/v1/market/open',
    agent_id: 'agent-1',
    trace_id: 'trace-1',
    status: 429,
    failure_reason: 'Channel does not belong to this agent.',
    failure_stage: 'channel_ownership',
    cooldown_retry_after_ms: 15_000,
    cooldown_retry_at_ms: ts + 15_005,
    ts: ts + 5,
  });

  const snapshot = state.buildSnapshot({ now: ts + 6 });
  const route = snapshot.routes.find((entry) => entry.routeKey === 'POST /api/v1/market/open');
  const agent = snapshot.agents.find((entry) => entry.id === 'agent-1');

  assert.ok(route);
  assert.ok(agent);
  assert.equal(route.authFailures, 1);
  assert.equal(route.rateLimitHits, 1);
  assert.equal(route.validationFailures, 1);
  assert.equal(route.authzDenied, 1);
  assert.deepEqual(route.security, {
    moves_money: true,
    requires_ownership: true,
    requires_signature: true,
    long_running: true,
  });
  assert.equal(agent.lastFailureStage, 'channel_ownership');
  assert.equal(agent.lastFailureReason, 'Channel does not belong to this agent.');
  assert.equal(agent.cooldownRemainingMs, 14_999);
});
