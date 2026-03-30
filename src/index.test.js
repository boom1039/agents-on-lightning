import test from 'node:test';
import assert from 'node:assert/strict';
import { getListenConfig } from './index.js';

test('getListenConfig defaults to local main on 0.0.0.0:3302', () => {
  assert.deepEqual(getListenConfig({}), {
    host: '0.0.0.0',
    port: 3302,
    role: 'main',
  });
});

test('getListenConfig honors HOST and PORT', () => {
  assert.deepEqual(getListenConfig({
    AOL_SERVER_ROLE: 'scratch',
    HOST: '127.0.0.1',
    PORT: '3306',
  }), {
    host: '127.0.0.1',
    port: 3306,
    role: 'scratch',
  });
});

test('getListenConfig falls back on role default when PORT is invalid', () => {
  assert.deepEqual(getListenConfig({
    AOL_SERVER_ROLE: 'scratch',
    HOST: '127.0.0.1',
    PORT: 'not-a-port',
  }), {
    host: '127.0.0.1',
    port: 3306,
    role: 'scratch',
  });
});

test('getListenConfig defaults to prod role in production', () => {
  assert.deepEqual(getListenConfig({
    NODE_ENV: 'production',
  }), {
    host: '0.0.0.0',
    port: 3302,
    role: 'prod',
  });
});
