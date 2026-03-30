import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluatePhaseCoverage,
  expectHelpful,
  expectSignedBoundary,
  expectStatus,
  reqAuth,
  reqPublic,
} from './agent-coverage-scoring.mjs';

const BASE_URL = 'http://localhost:3302';

function call({
  method = 'GET',
  path,
  status,
  reqBody = null,
  body = null,
  headers = null,
}) {
  return {
    method,
    url: `${BASE_URL}${path}`,
    status,
    reqBody,
    body,
    requestHeaders: headers,
  };
}

test('passes a normal 200 success contract', () => {
  const cover = 'GET /api/v1/ethos';
  const result = evaluatePhaseCoverage(
    [call({ path: '/api/v1/ethos', status: 200, body: { ok: true } })],
    [cover],
    { [cover]: expectStatus(200, reqPublic()) },
    { baseUrl: BASE_URL },
  );

  assert.equal(result.contractScore, 1);
  assert.equal(result.successScore, 1);
  assert.equal(result.boundaryScore, 0);
  assert.equal(result.reachScore, 1);
  assert.equal(result.routeResults[0].category, 'pass_success');
});

test('passes a documented helpful boundary contract', () => {
  const cover = 'GET /api/v1/platform/decode-invoice';
  const result = evaluatePhaseCoverage(
    [call({
      path: '/api/v1/platform/decode-invoice?invoice=lnbc1invalid',
      status: 400,
      body: { error: 'bad invoice', hint: 'use invoice=', see: '/docs' },
    })],
    [cover],
    { [cover]: expectHelpful(400, reqPublic({ queryKeys: ['invoice'] }), ['see']) },
    { baseUrl: BASE_URL },
  );

  assert.equal(result.contractScore, 1);
  assert.equal(result.successScore, 0);
  assert.equal(result.boundaryScore, 1);
  assert.equal(result.routeResults[0].category, 'pass_boundary');
});

test('marks missing exact route hits as cannot_find_endpoint', () => {
  const cover = 'GET /api/v1/skills/:name';
  const result = evaluatePhaseCoverage(
    [call({ path: '/api/v1/skills', status: 200, body: { skills: [] } })],
    [cover],
    { [cover]: expectStatus(200, reqPublic()) },
    { baseUrl: BASE_URL },
  );

  assert.equal(result.contractScore, 0);
  assert.equal(result.reachScore, 0);
  assert.equal(result.routeResults[0].category, 'cannot_find_endpoint');
  assert.ok(result.routeResults[0].near_miss_count >= 1);
});

test('marks exact hits with bad request shape as wrong_request', () => {
  const cover = 'POST /api/v1/analytics/quote';
  const result = evaluatePhaseCoverage(
    [
      call({
        method: 'POST',
        path: '/api/v1/analytics/quote',
        status: 401,
        reqBody: { query_id: 'node_profile' },
        body: { error: 'missing auth' },
      }),
    ],
    [cover],
    { [cover]: expectStatus(200, reqAuth({ bodyKeys: ['query_id', 'params'] })) },
    { baseUrl: BASE_URL },
  );

  assert.equal(result.contractScore, 0);
  assert.equal(result.reachScore, 1);
  assert.equal(result.routeResults[0].category, 'found_endpoint_wrong_request');
  assert.match(result.routeResults[0].failure_reason, /missing bearer auth/i);
});

test('marks valid requests with wrong response status as wrong_response', () => {
  const cover = 'GET /api/v1/agents/me';
  const result = evaluatePhaseCoverage(
    [
      call({
        path: '/api/v1/agents/me',
        status: 401,
        headers: { Authorization: 'Bearer [REDACTED]' },
        body: { error: 'unauthorized' },
      }),
    ],
    [cover],
    { [cover]: expectStatus(200, reqAuth()) },
    { baseUrl: BASE_URL },
  );

  assert.equal(result.contractScore, 0);
  assert.equal(result.reachScore, 1);
  assert.equal(result.routeResults[0].category, 'found_endpoint_wrong_response');
  assert.match(result.routeResults[0].failure_reason, /expected status 200 got 401/i);
});

test('later good retry inside the first three exact tries still passes', () => {
  const cover = 'GET /api/v1/agents/me';
  const result = evaluatePhaseCoverage(
    [
      call({ path: '/api/v1/agents/me', status: 401, body: { error: 'nope' }, headers: null }),
      call({
        path: '/api/v1/agents/me',
        status: 200,
        headers: { Authorization: 'Bearer [REDACTED]' },
        body: { agent_id: 'agent-1' },
      }),
    ],
    [cover],
    { [cover]: expectStatus(200, reqAuth(), { requiredOneOf: [['id', 'agent_id']] }) },
    { baseUrl: BASE_URL },
  );

  assert.equal(result.contractScore, 1);
  assert.equal(result.routeResults[0].category, 'pass_success');
  assert.equal(result.routeResults[0].exact_attempts_used, 2);
});

test('dynamic route scoring ignores literal sibling routes in the same phase', () => {
  const covers = [
    'GET /api/v1/agents/me',
    'GET /api/v1/agents/:id',
  ];
  const result = evaluatePhaseCoverage(
    [
      call({
        path: '/api/v1/agents/me',
        status: 401,
        body: { error: 'authentication_required' },
      }),
      call({
        path: '/api/v1/agents/abc12345',
        status: 200,
        body: { id: 'abc12345' },
      }),
    ],
    covers,
    {
      'GET /api/v1/agents/me': expectStatus(200, reqAuth()),
      'GET /api/v1/agents/:id': expectStatus(200, reqPublic()),
    },
    { baseUrl: BASE_URL },
  );

  assert.equal(result.routeResults[1].category, 'pass_success');
  assert.equal(result.routeResults[1].exact_attempts_used, 1);
});

test('fourth exact try is ignored after three failures', () => {
  const cover = 'GET /api/v1/ethos';
  const result = evaluatePhaseCoverage(
    [
      call({ path: '/api/v1/ethos', status: 500, body: { error: 'boom-1' } }),
      call({ path: '/api/v1/ethos', status: 500, body: { error: 'boom-2' } }),
      call({ path: '/api/v1/ethos', status: 500, body: { error: 'boom-3' } }),
      call({ path: '/api/v1/ethos', status: 200, body: { ok: true } }),
    ],
    [cover],
    { [cover]: expectStatus(200, reqPublic()) },
    { baseUrl: BASE_URL },
  );

  assert.equal(result.contractScore, 0);
  assert.equal(result.routeResults[0].category, 'found_endpoint_wrong_response');
  assert.equal(result.routeResults[0].exact_attempts_used, 3);
});

test('signed boundary passes when checks_passed is present', () => {
  const cover = 'POST /api/v1/channels/preview';
  const result = evaluatePhaseCoverage(
    [
      call({
        method: 'POST',
        path: '/api/v1/channels/preview',
        status: 400,
        headers: { Authorization: 'Bearer [REDACTED]' },
        reqBody: { instruction: { action: 'set_fee_policy' }, signature: 'abc123' },
        body: {
          checks_passed: [
            'pubkey_registered',
            'action_valid',
            'agent_id_matches',
            'timestamp_fresh',
            'not_duplicate',
            'signature_valid',
          ],
        },
      }),
    ],
    [cover],
    { [cover]: expectSignedBoundary(reqAuth({ bodyKeys: ['instruction', 'signature'] })) },
    { baseUrl: BASE_URL },
  );

  assert.equal(result.contractScore, 1);
  assert.equal(result.boundaryScore, 1);
  assert.equal(result.routeResults[0].category, 'pass_boundary');
});

test('signed route also passes on real 200 success', () => {
  const cover = 'POST /api/v1/channels/instruct';
  const result = evaluatePhaseCoverage(
    [
      call({
        method: 'POST',
        path: '/api/v1/channels/instruct',
        status: 200,
        headers: { Authorization: 'Bearer [REDACTED]' },
        reqBody: { instruction: { action: 'set_fee_policy' }, signature: 'abc123' },
        body: {
          status: 'executed',
          channel_id: '123',
          action: 'set_fee_policy',
        },
      }),
    ],
    [cover],
    { [cover]: expectSignedBoundary(reqAuth({ bodyKeys: ['instruction', 'signature'] })) },
    { baseUrl: BASE_URL },
  );

  assert.equal(result.contractScore, 1);
  assert.equal(result.successScore, 1);
  assert.equal(result.boundaryScore, 0);
  assert.equal(result.routeResults[0].category, 'pass_success');
});
