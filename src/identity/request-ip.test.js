import test from 'node:test';
import assert from 'node:assert/strict';

import { getSocketAddress } from './request-ip.js';

test('getSocketAddress prefers proxy-aware req.ip when present', () => {
  const req = {
    ip: '198.51.100.25',
    socket: { remoteAddress: '127.0.0.1' },
    connection: { remoteAddress: '127.0.0.1' },
  };

  assert.equal(getSocketAddress(req), '198.51.100.25');
});

test('getSocketAddress falls back to socket remote address', () => {
  const req = {
    ip: '',
    socket: { remoteAddress: '203.0.113.9' },
    connection: { remoteAddress: '127.0.0.1' },
  };

  assert.equal(getSocketAddress(req), '203.0.113.9');
});
