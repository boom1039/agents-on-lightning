import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INTERNAL_MCP_HEADER_NAME,
  rejectExternalAgentApiRoute,
  rejectExternalDocRoute,
  rejectUnauthorizedJourneyRoute,
} from './request-security.js';

function mockReq({ remoteAddress = '203.0.113.10', ip = null, headers = {}, path = '/journey' } = {}) {
  return {
    path,
    originalUrl: path,
    url: path,
    agentId: null,
    ip,
    socket: { remoteAddress },
    connection: { remoteAddress },
    get(name) {
      return headers[String(name).toLowerCase()] || null;
    },
  };
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    header(name, value) {
      return this.set(name, value);
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('journey guard blocks remote unauthenticated requests', () => {
  const prev = process.env.OPERATOR_API_SECRET;
  process.env.OPERATOR_API_SECRET = 'topsecret';
  try {
    const res = mockRes();
    const result = rejectUnauthorizedJourneyRoute(mockReq(), res);
    assert.equal(result, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['www-authenticate'], 'Basic realm="Journey"');
    assert.equal(res.body?.error, 'authentication_required');
  } finally {
    if (prev === undefined) delete process.env.OPERATOR_API_SECRET;
    else process.env.OPERATOR_API_SECRET = prev;
  }
});

test('journey guard allows remote requests with valid basic auth password', () => {
  const prev = process.env.OPERATOR_API_SECRET;
  process.env.OPERATOR_API_SECRET = 'topsecret';
  try {
    const auth = `Basic ${Buffer.from('operator:topsecret').toString('base64')}`;
    const res = mockRes();
    const result = rejectUnauthorizedJourneyRoute(mockReq({
      headers: { authorization: auth },
    }), res);
    assert.equal(result, null);
    assert.equal(res.statusCode, 200);
  } finally {
    if (prev === undefined) delete process.env.OPERATOR_API_SECRET;
    else process.env.OPERATOR_API_SECRET = prev;
  }
});

test('journey guard allows loopback requests without extra auth', () => {
  const prev = process.env.OPERATOR_API_SECRET;
  process.env.OPERATOR_API_SECRET = 'topsecret';
  try {
    const res = mockRes();
    const result = rejectUnauthorizedJourneyRoute(mockReq({
      remoteAddress: '127.0.0.1',
    }), res);
    assert.equal(result, null);
    assert.equal(res.statusCode, 200);
  } finally {
    if (prev === undefined) delete process.env.OPERATOR_API_SECRET;
    else process.env.OPERATOR_API_SECRET = prev;
  }
});

test('journey guard blocks forwarded public requests behind a loopback proxy', () => {
  const prev = process.env.OPERATOR_API_SECRET;
  process.env.OPERATOR_API_SECRET = 'topsecret';
  try {
    const res = mockRes();
    const result = rejectUnauthorizedJourneyRoute(mockReq({
      remoteAddress: '127.0.0.1',
      ip: '203.0.113.10',
    }), res);
    assert.equal(result, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body?.error, 'authentication_required');
  } finally {
    if (prev === undefined) delete process.env.OPERATOR_API_SECRET;
    else process.env.OPERATOR_API_SECRET = prev;
  }
});

test('mcp-only api guard hides public api routes', () => {
  const res = mockRes();
  const result = rejectExternalAgentApiRoute(mockReq({
    path: '/api/v1/agents/register',
  }), res, {
    mode: 'mcp_only',
    internalMcpSecret: 'internal-secret',
  });
  assert.equal(result, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body?.error, 'not_found');
});

test('mcp-only api guard allows loopback api routes with internal mcp secret', () => {
  const res = mockRes();
  const result = rejectExternalAgentApiRoute(mockReq({
    remoteAddress: '127.0.0.1',
    path: '/api/v1/agents/me',
    headers: { [INTERNAL_MCP_HEADER_NAME]: 'internal-secret' },
  }), res, {
    mode: 'mcp_only',
    internalMcpSecret: 'internal-secret',
  });
  assert.equal(result, null);
  assert.equal(res.statusCode, 200);
});

test('mcp-only api guard hides loopback api routes without internal mcp secret', () => {
  const res = mockRes();
  const result = rejectExternalAgentApiRoute(mockReq({
    remoteAddress: '127.0.0.1',
    path: '/api/v1/agents/me',
  }), res, {
    mode: 'mcp_only',
    internalMcpSecret: 'internal-secret',
  });
  assert.equal(result, res);
  assert.equal(res.statusCode, 404);
});

test('mcp-only docs guard keeps mcp docs public and hides legacy docs externally', () => {
  const mcpRes = mockRes();
  const mcpResult = rejectExternalDocRoute(mockReq({
    path: '/docs/mcp/index.txt',
  }), mcpRes, { mode: 'mcp_only' });
  assert.equal(mcpResult, null);
  assert.equal(mcpRes.statusCode, 200);

  const skillRes = mockRes();
  const skillResult = rejectExternalDocRoute(mockReq({
    path: '/docs/skills/discovery.txt',
  }), skillRes, { mode: 'mcp_only' });
  assert.equal(skillResult, skillRes);
  assert.equal(skillRes.statusCode, 404);
});
