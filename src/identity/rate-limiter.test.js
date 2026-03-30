import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataLayer } from '../data-layer.js';
import {
  checkAndIncrement,
  configureRateLimiterPersistence,
  disableRateLimiterPersistence,
  resetCounters,
} from './rate-limiter.js';

test('persistent rate limits survive a restart-like reconfigure', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'aol-rate-limit-'));
  try {
    const dataLayer = new DataLayer(tempDir);
    configureRateLimiterPersistence({ dataLayer, path: 'data/security/test-rate-limits.json' });
    await resetCounters();

    const first = await checkAndIncrement('help:agent:test-agent', 1, 60_000);
    assert.equal(first.allowed, true);

    disableRateLimiterPersistence();
    configureRateLimiterPersistence({ dataLayer, path: 'data/security/test-rate-limits.json' });

    const second = await checkAndIncrement('help:agent:test-agent', 1, 60_000);
    assert.equal(second.allowed, false);
    assert.ok(second.retryAfter > 0);
  } finally {
    disableRateLimiterPersistence();
    await resetCounters();
    await rm(tempDir, { recursive: true, force: true });
  }
});
