import test from 'node:test';
import assert from 'node:assert/strict';

import { getRequestRunId, sanitizeRunId } from './request-run.js';

test('sanitizeRunId trims and keeps a safe character set', () => {
  assert.equal(sanitizeRunId('  run 123 / demo  '), 'run-123--demo');
});

test('getRequestRunId prefers x-aol-run-id header', () => {
  const req = {
    headers: { 'x-aol-run-id': 'hermes-local-001' },
    query: {},
  };
  assert.equal(getRequestRunId(req), 'hermes-local-001');
});

test('getRequestRunId falls back to query string', () => {
  const req = {
    headers: {},
    query: { run_id: 'session-42' },
  };
  assert.equal(getRequestRunId(req), 'session-42');
});

test('getRequestRunId returns null when nothing usable is present', () => {
  const req = {
    headers: { 'x-run-id': '   ' },
    query: {},
  };
  assert.equal(getRequestRunId(req), null);
});
