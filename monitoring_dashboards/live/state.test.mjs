import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveJourneyState } from './state.mjs';

test('live journey state binds in-flight work to an agent and finishes on the route', () => {
  const state = new LiveJourneyState({
    agentTtlMs: 60_000,
    inflightTtlMs: 60_000,
    seedKnownRoutes: false,
  });

  state.applyEvent({
    event: 'request_start',
    trace_id: 't-1',
    method: 'GET',
    path: '/api/v1/wallet/balance',
    ts: 1000,
  });
  state.applyEvent({
    event: 'agent_bound',
    trace_id: 't-1',
    agent_id: 'agent-1',
    ts: 1001,
  });
  state.applyEvent({
    event: 'request_finish',
    trace_id: 't-1',
    method: 'GET',
    path: '/api/v1/wallet/balance',
    status: 200,
    agent_id: 'agent-1',
    ts: 1002,
  });

  const snapshot = state.buildSnapshot({ now: 1002 });
  assert.equal(snapshot.stats.inFlight, 0);
  assert.equal(snapshot.stats.agents, 1);
  assert.equal(snapshot.agents[0].routeKey, 'GET /api/v1/wallet/balance');
  assert.equal(snapshot.agents[0].status, 200);
  assert.equal(snapshot.routes.find((route) => route.routeKey === 'GET /api/v1/wallet/balance')?.activeAgents, 1);
});

test('registration attempts create a visible agent position', () => {
  const state = new LiveJourneyState({ seedKnownRoutes: false });
  state.applyEvent({
    event: 'registration_attempt',
    success: true,
    agent_id: 'new-agent',
    ts: 2000,
  });

  const snapshot = state.buildSnapshot({ now: 2000 });
  assert.equal(snapshot.stats.agents, 1);
  assert.equal(snapshot.agents[0].routeKey, 'POST /api/v1/agents/register');
  assert.equal(snapshot.agents[0].rawPath, '/api/v1/agents/register');
  assert.equal(snapshot.agents[0].status, 201);
  assert.equal(snapshot.agents[0].registeredAt, 2000);
  assert.equal(snapshot.agents[0].sessionStartedAt, 2000);
  assert.equal(snapshot.agents[0].sessionAgeMs, 0);
});

test('route timing tracks current dwell and prior route dwell history', () => {
  const state = new LiveJourneyState({ seedKnownRoutes: false });

  state.applyEvent({
    event: 'request_start',
    trace_id: 't-2',
    method: 'GET',
    path: '/api/v1/agents/me',
    agent_id: 'agent-2',
    ts: 1000,
  });
  state.applyEvent({
    event: 'request_finish',
    trace_id: 't-2',
    method: 'GET',
    path: '/api/v1/agents/me',
    status: 200,
    agent_id: 'agent-2',
    ts: 1200,
  });
  state.applyEvent({
    event: 'request_start',
    trace_id: 't-3',
    method: 'GET',
    path: '/api/v1/wallet/balance',
    agent_id: 'agent-2',
    ts: 2500,
  });

  const snapshot = state.buildSnapshot({ now: 3100 });
  const agent = snapshot.agents.find((entry) => entry.id === 'agent-2');

  assert.equal(agent.routeKey, 'GET /api/v1/wallet/balance');
  assert.equal(agent.rawPath, '/api/v1/wallet/balance');
  assert.equal(agent.routeEnteredAt, 2500);
  assert.equal(agent.currentRouteMs, 600);
  assert.equal(agent.currentRequestMs, 600);
  assert.equal(agent.sessionStartedAt, 1000);
  assert.equal(agent.sessionAgeMs, 2100);
  assert.equal(agent.dwellHistory.length, 1);
  assert.equal(agent.dwellHistory[0].routeKey, 'GET /api/v1/agents/:id');
  assert.equal(agent.dwellHistory[0].dwellMs, 1500);
});

test('known route catalog is seeded by default', () => {
  const state = new LiveJourneyState();
  const snapshot = state.buildSnapshot({ now: 3000 });

  assert.ok(snapshot.routes.length > 20);
  assert.ok(snapshot.routes.some((route) => route.routeKey === 'GET /api/v1/wallet/balance'));
  assert.ok(snapshot.routes.some((route) => route.routeKey === 'POST /api/v1/agents/register'));
});

test('replay timing fields are preserved on live agents and recent events', () => {
  const state = new LiveJourneyState({ seedKnownRoutes: false });

  state.applyEvent({
    event: 'request_start',
    trace_id: 'trace-replay-1',
    method: 'GET',
    path: '/api/v1/actions/history',
    agent_id: 'agent-replay',
    ts: 5000,
    request_timeline_index: 3,
    started_at_ms: 4800,
    finished_at_ms: null,
    latency_ms: null,
    gap_from_prev_request_ms: 1775,
    turn_started_at_ms: 4100,
    turn_finished_at_ms: 6200,
  });

  state.applyEvent({
    event: 'request_finish',
    trace_id: 'trace-replay-1',
    method: 'GET',
    path: '/api/v1/actions/history',
    agent_id: 'agent-replay',
    status: 200,
    ts: 5200,
    request_timeline_index: 3,
    started_at_ms: 4800,
    finished_at_ms: 5200,
    latency_ms: 400,
    gap_from_prev_request_ms: 1775,
    turn_started_at_ms: 4100,
    turn_finished_at_ms: 6200,
  });

  const snapshot = state.buildSnapshot({ now: 5300 });
  const agent = snapshot.agents.find((entry) => entry.id === 'agent-replay');

  assert.equal(agent.timing.requestTimelineIndex, 3);
  assert.equal(agent.timing.startedAtMs, 4800);
  assert.equal(agent.timing.finishedAtMs, 5200);
  assert.equal(agent.timing.latencyMs, 400);
  assert.equal(agent.timing.gapFromPrevRequestMs, 1775);
  assert.equal(snapshot.recentEvents.at(-1).timing.finishedAtMs, 5200);
});
