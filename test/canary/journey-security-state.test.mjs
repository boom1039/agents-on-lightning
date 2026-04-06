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

  const snapshot = state.buildSnapshot({ now: ts + 3 });
  const route = snapshot.routes.find((entry) => entry.routeKey === 'POST /api/v1/market/open');

  assert.ok(route);
  assert.equal(route.authFailures, 1);
  assert.equal(route.rateLimitHits, 1);
  assert.equal(route.validationFailures, 1);
  assert.equal(route.authzDenied, 0);
  assert.deepEqual(route.security, {
    moves_money: true,
    requires_ownership: true,
    requires_signature: true,
    long_running: true,
  });
});
