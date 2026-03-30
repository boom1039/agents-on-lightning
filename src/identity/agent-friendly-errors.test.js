import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentSuccess,
  err403LoopbackOnly,
  err403OperatorSecretRequired,
  getPublicHostRequirement,
  tinySuccessGuidance,
} from './agent-friendly-errors.js';

function makeRes() {
  return {
    headers: {},
    statusCode: null,
    jsonBody: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.jsonBody = body;
      return this;
    },
  };
}

test('tinySuccessGuidance returns compact optional guidance only', () => {
  assert.deepEqual(tinySuccessGuidance(), {});
  assert.deepEqual(
    tinySuccessGuidance({
      message: ' Registered ',
      hint: ' Save the key and reuse it. ',
      nextStep: 'Call GET /api/v1/me next.',
    }),
    {
      message: 'Registered',
      hint: 'Save the key and reuse it.',
      next_step: 'Call GET /api/v1/me next.',
    },
  );
});

test('agentSuccess adds guidance without overwriting payload fields', () => {
  const res = makeRes();
  agentSuccess(
    res,
    201,
    { ok: true, message: 'created' },
    { message: 'ignored', hint: 'Store the id.', nextStep: 'Fetch the profile.' },
  );

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.jsonBody, {
    ok: true,
    message: 'created',
    hint: 'Store the id.',
    next_step: 'Fetch the profile.',
  });
});

test('abuse-flavored denial helpers stay short and do not leak internals', () => {
  const loopbackRes = makeRes();
  err403LoopbackOnly(loopbackRes, 'Operator routes', 'Run this on the API host and send the operator secret.');
  assert.equal(loopbackRes.statusCode, 403);
  assert.equal(loopbackRes.jsonBody.error, 'forbidden');
  assert.match(loopbackRes.jsonBody.message, /Nice try\./);
  assert.match(loopbackRes.jsonBody.message, /local-only/);
  assert.ok(!loopbackRes.jsonBody.message.includes('127.0.0.1'));

  const secretRes = makeRes();
  err403OperatorSecretRequired(secretRes);
  assert.equal(secretRes.statusCode, 403);
  assert.equal(secretRes.jsonBody.message, 'Nice try. Operator secret required.');
  assert.ok(!secretRes.jsonBody.hint.includes('OPERATOR_API_SECRET'));
});

test('public host guidance is safe and specific', () => {
  assert.deepEqual(getPublicHostRequirement(), {
    code: 'public_host_required',
    message: 'host must be public host:port.',
    reason: 'host must be public host:port. Private, loopback, and .local targets are off-limits.',
    hint: 'Use a public host reachable from outside this machine.',
  });
});
