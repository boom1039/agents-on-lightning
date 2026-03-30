import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleJsonBodyError,
  pickSafePublicPeerAddress,
  rejectUnauthorizedOperatorRoute,
  rejectUnauthorizedTestRoute,
  requireDashboardOperatorAuth,
  resolvePublicNodeHost,
  requireJsonWriteContent,
  validatePublicNodeHost,
} from './request-security.js';

function createMockResponse() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

function createMockRequest({
  path = '/api/v1/operator/check',
  remoteAddress = '127.0.0.1',
  headers = {},
} = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );

  return {
    path,
    headers: normalizedHeaders,
    socket: { remoteAddress },
    connection: { remoteAddress },
    get(name) {
      return normalizedHeaders[name.toLowerCase()];
    },
  };
}

function withEnv(overrides, fn) {
  const previous = new Map();
  for (const key of Object.keys(overrides)) {
    previous.set(key, process.env[key]);
    const value = overrides[key];
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('validatePublicNodeHost accepts public hosts and rejects local/private targets', () => {
  assert.equal(validatePublicNodeHost('8.8.8.8:10009').valid, true);
  assert.equal(validatePublicNodeHost('node.example.com:9735').valid, true);

  assert.deepEqual(validatePublicNodeHost('127.0.0.1:10009'), {
    valid: false,
    code: 'private_ipv4',
    reason: 'host must be public host:port. Private, loopback, and .local targets are off-limits.',
  });
  assert.deepEqual(validatePublicNodeHost('localhost:10009'), {
    valid: false,
    code: 'local_host',
    reason: 'host must be public host:port. Private, loopback, and .local targets are off-limits.',
  });
  assert.equal(validatePublicNodeHost('192.168.1.8:10009').code, 'private_ipv4');
  assert.equal(validatePublicNodeHost('10.0.0.2:10009').code, 'private_ipv4');
  assert.equal(validatePublicNodeHost('[::1]:10009').code, 'private_ipv6');
});

test('validatePublicNodeHost rejects overlong and URL-like values', () => {
  const tooLong = validatePublicNodeHost(`${'a'.repeat(501)}:9735`);
  assert.equal(tooLong.valid, false);
  assert.match(tooLong.reason, /max 500 chars/i);

  const withPath = validatePublicNodeHost('node.example.com:9735/path');
  assert.equal(withPath.valid, false);
  assert.match(withPath.reason, /host:port only/i);
});

test('resolvePublicNodeHost rejects hostnames that resolve to private IPs', async () => {
  const result = await resolvePublicNodeHost('peer.example.com:9735', {
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  });
  assert.equal(result.valid, false);
  assert.equal(result.code, 'host_resolution_private');
});

test('pickSafePublicPeerAddress skips private peer addresses', async () => {
  assert.equal(
    await pickSafePublicPeerAddress([
      { addr: '127.0.0.1:9735' },
      { addr: '10.0.0.4:9735' },
      { addr: 'peer.example.com:9735' },
    ], {
      resolveHost: async (candidate) => candidate === 'peer.example.com:9735'
        ? { valid: true, host: candidate }
        : { valid: false, code: 'private_ipv4', reason: 'private host' },
    }),
    'peer.example.com:9735',
  );

  assert.equal(
    await pickSafePublicPeerAddress([
      { addr: '127.0.0.1:9735' },
      { addr: '192.168.1.12:9735' },
    ], {
      resolveHost: async () => ({ valid: false, code: 'private_ipv4', reason: 'private host' }),
    }),
    null,
  );
});

test('requireJsonWriteContent returns a compact helpful JSON error for API writes', () => {
  const req = {
    method: 'POST',
    path: '/api/v1/help',
    headers: { 'content-type': 'text/plain' },
    is() {
      return false;
    },
  };
  const res = createMockResponse();
  let nextCalls = 0;

  requireJsonWriteContent(req, res, () => {
    nextCalls += 1;
  });

  assert.equal(nextCalls, 0);
  assert.equal(res.statusCode, 415);
  assert.deepEqual(Object.keys(res.body).sort(), ['error', 'hint', 'message', 'retryable', 'status']);
  assert.equal(res.body.error, 'unsupported_media_type');
  assert.equal(res.body.status, 415);
  assert.match(res.body.hint, /application\/json/i);
  assert.ok(res.body.message.length <= 120);
  assert.equal('stack' in res.body, false);
});

test('handleJsonBodyError returns a compact helpful error for malformed JSON', () => {
  const err = Object.assign(new SyntaxError('Unexpected token } in JSON'), {
    status: 400,
    body: '{"broken"',
  });
  const req = { path: '/api/v1/help' };
  const res = createMockResponse();
  let nextCalls = 0;

  handleJsonBodyError(err, req, res, () => {
    nextCalls += 1;
  });

  assert.equal(nextCalls, 0);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'validation_error');
  assert.equal(res.body.status, 400);
  assert.equal(res.body.retryable, false);
  assert.match(res.body.message, /malformed json body/i);
  assert.match(res.body.hint, /double-quoted keys/i);
  assert.equal('stack' in res.body, false);
});

test('handleJsonBodyError returns a compact helpful error for oversized JSON bodies', () => {
  const req = { path: '/api/v1/help' };
  const res = createMockResponse();
  let nextCalls = 0;

  handleJsonBodyError({ type: 'entity.too.large' }, req, res, () => {
    nextCalls += 1;
  });

  assert.equal(nextCalls, 0);
  assert.equal(res.statusCode, 413);
  assert.equal(res.body.error, 'payload_too_large');
  assert.equal(res.body.status, 413);
  assert.match(res.body.message, /16kb limit/i);
  assert.match(res.body.hint, /reduce the request body size/i);
  assert.equal('stack' in res.body, false);
});

test('rejectUnauthorizedOperatorRoute returns safe funny denial for remote callers', () => {
  withEnv(
    {
      ENABLE_OPERATOR_ROUTES: '1',
      OPERATOR_API_SECRET: 'top-secret',
    },
    () => {
      const req = createMockRequest({
        remoteAddress: '203.0.113.10',
        headers: { 'x-operator-secret': 'top-secret' },
      });
      const res = createMockResponse();

      rejectUnauthorizedOperatorRoute(req, res);

      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error, 'forbidden');
      assert.equal(res.body.message, 'Nice try. Operator routes are local-only.');
      assert.equal(res.body.hint, 'Run this on the API host and send the operator secret.');
      assert.ok(!JSON.stringify(res.body).includes('127.0.0.1'));
    },
  );
});

test('rejectUnauthorizedOperatorRoute keeps misconfiguration guidance short and non-sensitive', () => {
  withEnv(
    {
      ENABLE_OPERATOR_ROUTES: '1',
      OPERATOR_API_SECRET: null,
    },
    () => {
      const req = createMockRequest();
      const res = createMockResponse();

      rejectUnauthorizedOperatorRoute(req, res);

      assert.equal(res.statusCode, 503);
      assert.equal(res.body.error, 'operator_misconfigured');
      assert.equal(res.body.message, 'Operator route unavailable.');
      assert.equal(res.body.hint, 'Configure the operator secret, then retry from a local operator client.');
      assert.ok(!JSON.stringify(res.body).includes('OPERATOR_API_SECRET'));
    },
  );
});

test('rejectUnauthorizedTestRoute uses safe funny denial for remote callers', () => {
  withEnv(
    {
      NODE_ENV: 'development',
      ENABLE_TEST_ROUTES: '1',
    },
    () => {
      const req = createMockRequest({
        path: '/api/v1/test/ping',
        remoteAddress: '198.51.100.20',
      });
      const res = createMockResponse();

      rejectUnauthorizedTestRoute(req, res);

      assert.equal(res.statusCode, 403);
      assert.equal(res.body.message, 'Nice try. Test routes are local-only.');
      assert.equal(res.body.hint, 'Run this request on the API host.');
    },
  );
});

test('requireDashboardOperatorAuth allows local dashboard access in development without auth', () => {
  withEnv(
    {
      NODE_ENV: 'development',
      OPERATOR_API_SECRET: null,
    },
    () => {
      const req = createMockRequest({
        path: '/dashboard',
        remoteAddress: '127.0.0.1',
      });
      const res = createMockResponse();
      let nextCalls = 0;

      requireDashboardOperatorAuth(req, res, () => {
        nextCalls += 1;
      });

      assert.equal(nextCalls, 1);
      assert.equal(res.statusCode, null);
    },
  );
});

test('requireDashboardOperatorAuth still requires auth away from local dev', () => {
  withEnv(
    {
      NODE_ENV: 'production',
      OPERATOR_API_SECRET: 'top-secret',
    },
    () => {
      const req = createMockRequest({
        path: '/dashboard',
        remoteAddress: '203.0.113.10',
      });
      const res = createMockResponse();
      let nextCalls = 0;

      requireDashboardOperatorAuth(req, res, () => {
        nextCalls += 1;
      });

      assert.equal(nextCalls, 0);
      assert.equal(res.statusCode, 401);
    },
  );
});
