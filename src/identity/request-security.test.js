import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INTERNAL_MCP_HEADER_NAME,
  rejectExternalAgentApiRoute,
  rejectExternalDocRoute,
  rejectUnauthorizedAnalyticsQueryRoute,
  rejectUnauthorizedJourneyRoute,
} from './request-security.js';
import { PUBLIC_MCP_DOC_PATHS } from '../mcp/catalog.js';

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

test('analytics SQL query guard allows remote operator-authenticated requests without broad operator routes', () => {
  const prevSecret = process.env.OPERATOR_API_SECRET;
  const prevEnabled = process.env.ENABLE_OPERATOR_ROUTES;
  process.env.OPERATOR_API_SECRET = 'topsecret';
  delete process.env.ENABLE_OPERATOR_ROUTES;
  try {
    const res = mockRes();
    const result = rejectUnauthorizedAnalyticsQueryRoute(mockReq({
      path: '/api/analytics/query',
      headers: { 'x-operator-secret': 'topsecret' },
    }), res);
    assert.equal(result, null);
    assert.equal(res.statusCode, 200);
  } finally {
    if (prevSecret === undefined) delete process.env.OPERATOR_API_SECRET;
    else process.env.OPERATOR_API_SECRET = prevSecret;
    if (prevEnabled === undefined) delete process.env.ENABLE_OPERATOR_ROUTES;
    else process.env.ENABLE_OPERATOR_ROUTES = prevEnabled;
  }
});

test('analytics SQL query guard requires operator secret even on loopback', () => {
  const prev = process.env.OPERATOR_API_SECRET;
  process.env.OPERATOR_API_SECRET = 'topsecret';
  try {
    const res = mockRes();
    const result = rejectUnauthorizedAnalyticsQueryRoute(mockReq({
      remoteAddress: '127.0.0.1',
      path: '/api/analytics/query',
    }), res);
    assert.equal(result, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body?.error, 'forbidden');
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
    internalMcpSecret: 'internal-secret',
  });
  assert.equal(result, res);
  assert.equal(res.statusCode, 404);
});

test('mcp-only docs guard keeps mcp docs public and hides legacy docs externally', () => {
  for (const docPath of PUBLIC_MCP_DOC_PATHS) {
    const mcpRes = mockRes();
    const mcpResult = rejectExternalDocRoute(mockReq({
      path: docPath,
    }), mcpRes);
    assert.equal(mcpResult, null);
    assert.equal(mcpRes.statusCode, 200);
  }

  const nonMcpDocRes = mockRes();
  const nonMcpDocResult = rejectExternalDocRoute(mockReq({
    path: '/docs/agent-route-schema.md',
  }), nonMcpDocRes);
  assert.equal(nonMcpDocResult, nonMcpDocRes);
  assert.equal(nonMcpDocRes.statusCode, 404);
});
