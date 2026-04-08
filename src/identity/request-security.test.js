import test from 'node:test';
import assert from 'node:assert/strict';

import { rejectUnauthorizedJourneyRoute } from './request-security.js';

function mockReq({ remoteAddress = '203.0.113.10', headers = {}, path = '/journey' } = {}) {
  return {
    path,
    agentId: null,
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
