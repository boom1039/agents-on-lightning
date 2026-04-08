import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeHttpStatusCode } from './idempotency-route.js';

test('normalizeHttpStatusCode rejects non-numeric status values', () => {
  assert.equal(normalizeHttpStatusCode('failed', 500), 500);
  assert.equal(normalizeHttpStatusCode(undefined, 500), 500);
  assert.equal(normalizeHttpStatusCode(200, 500), 200);
});
