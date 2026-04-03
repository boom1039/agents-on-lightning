import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDefaultDemoSpray,
  buildReplayBatches,
  pickLatestReplayRecord,
  stampBatchEvents,
} from './demo-spray.mjs';

const records = [
  {
    suite: 'discovery',
    phase: 'skills',
    request_timeline: [
      {
        request_timeline_index: 0,
        method: 'GET',
        url: '/',
        started_at_ms: 10,
        finished_at_ms: 14,
        latency_ms: 4,
        gap_from_prev_request_ms: null,
        gap_from_prev_turn_ms: null,
        turn_started_at_ms: 0,
        turn_finished_at_ms: 14,
      },
      {
        request_timeline_index: 1,
        method: 'GET',
        url: '/api/v1/skills/identity',
        started_at_ms: 40,
        finished_at_ms: 45,
        latency_ms: 5,
        gap_from_prev_request_ms: 26,
        gap_from_prev_turn_ms: 0,
        turn_started_at_ms: 14,
        turn_finished_at_ms: 45,
      },
    ],
  },
  {
    suite: 'identity',
    phase: 'registration-and-profile',
    request_timeline: [
      {
        request_timeline_index: 0,
        method: 'POST',
        url: '/api/v1/agents/register',
        started_at_ms: 100,
        finished_at_ms: 109,
        latency_ms: 9,
        gap_from_prev_request_ms: null,
        gap_from_prev_turn_ms: null,
        turn_started_at_ms: 90,
        turn_finished_at_ms: 109,
      },
      {
        request_timeline_index: 1,
        method: 'GET',
        url: '/api/v1/agents/me',
        started_at_ms: 200,
        finished_at_ms: 204,
        latency_ms: 4,
        gap_from_prev_request_ms: 91,
        gap_from_prev_turn_ms: 0,
        turn_started_at_ms: 109,
        turn_finished_at_ms: 204,
      },
    ],
  },
  {
    suite: 'identity',
    phase: 'node-connection',
    request_timeline: [
      {
        request_timeline_index: 0,
        method: 'POST',
        url: '/api/v1/node/test-connection',
        started_at_ms: 300,
        finished_at_ms: 305,
        latency_ms: 5,
        gap_from_prev_request_ms: null,
        gap_from_prev_turn_ms: null,
        turn_started_at_ms: 290,
        turn_finished_at_ms: 305,
      },
    ],
  },
  {
    suite: 'identity',
    phase: 'actions',
    request_timeline: [
      {
        request_timeline_index: 0,
        method: 'POST',
        url: '/api/v1/actions/submit',
        started_at_ms: 400,
        finished_at_ms: 408,
        latency_ms: 8,
        gap_from_prev_request_ms: null,
        gap_from_prev_turn_ms: null,
        turn_started_at_ms: 390,
        turn_finished_at_ms: 408,
      },
    ],
  },
];

test('pickLatestReplayRecord returns the last matching timeline', () => {
  const latest = pickLatestReplayRecord([
    ...records,
    {
      suite: 'identity',
      phase: 'actions',
      request_timeline: [{ request_timeline_index: 0, method: 'GET', url: '/api/v1/actions/history' }],
    },
  ], { suite: 'identity', phase: 'actions' });

  assert.equal(latest.request_timeline[0].url, '/api/v1/actions/history');
});

test('buildReplayBatches emits registration, start, and finish batches in order', () => {
  const replay = buildReplayBatches(records[1], {
    agentId: 'demo-profile-01',
    speed: 2,
    startOffsetMs: 50,
  });

  assert.equal(replay.agentId, 'demo-profile-01');
  assert.equal(replay.batches[0].events[0].event, 'registration_attempt');
  assert.equal(replay.batches[1].events[0].event, 'request_start');
  assert.equal(replay.batches[2].events[0].event, 'request_finish');
  assert.ok(replay.durationMs > 0);
});

test('buildDefaultDemoSpray creates a multi-agent realistic burst', () => {
  const spray = buildDefaultDemoSpray(records);

  assert.equal(spray.name, 'big-spray');
  assert.equal(spray.agents, 13);
  assert.ok(spray.totalDurationMs > 0);
  assert.equal(spray.runs[0].agentId.startsWith('demo-discovery-'), true);
  assert.equal(spray.runs.at(-1).agentId.startsWith('demo-actions-'), true);
});

test('stampBatchEvents adds runtime timestamps', () => {
  const stamped = stampBatchEvents([{ event: 'request_start' }, { event: 'request_finish' }], 1234);
  assert.equal(stamped[0].ts, 1234);
  assert.equal(stamped[1].ts, 1235);
});
