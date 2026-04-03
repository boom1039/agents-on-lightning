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
  recordViolation,
  resetViolations,
  _getPenaltyMultiplier,
  getViolationInfo,
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

test('progressive penalties: no penalty below 5 violations', async () => {
  await resetCounters();
  const agentId = 'agent-penalty-test-1';

  for (let i = 0; i < 4; i++) {
    recordViolation(agentId);
  }
  const info = getViolationInfo(agentId);
  assert.equal(info.count, 4);
  assert.equal(info.multiplier, 1);
  await resetCounters();
});

test('progressive penalties: 2x after 5 violations', async () => {
  await resetCounters();
  const agentId = 'agent-penalty-test-2';

  for (let i = 0; i < 5; i++) {
    recordViolation(agentId);
  }
  const info = getViolationInfo(agentId);
  assert.equal(info.count, 5);
  assert.equal(info.multiplier, 2);
  await resetCounters();
});

test('progressive penalties: 4x after 10 violations', async () => {
  await resetCounters();
  const agentId = 'agent-penalty-test-3';

  for (let i = 0; i < 10; i++) {
    recordViolation(agentId);
  }
  const info = getViolationInfo(agentId);
  assert.equal(info.count, 10);
  assert.equal(info.multiplier, 4);
  await resetCounters();
});

test('progressive penalties: clean requests decay the violation counter', async () => {
  await resetCounters();
  const agentId = 'agent-penalty-test-4';

  for (let i = 0; i < 6; i++) {
    recordViolation(agentId);
  }
  assert.equal(getViolationInfo(agentId).multiplier, 2);

  // Each clean pass reduces by 1
  resetViolations(agentId);
  assert.equal(getViolationInfo(agentId).count, 5);
  resetViolations(agentId);
  assert.equal(getViolationInfo(agentId).count, 4);

  // Below threshold: multiplier drops back to 1
  assert.equal(getViolationInfo(agentId).multiplier, 1);
  await resetCounters();
});

test('progressive penalties: resetCounters clears violation state', async () => {
  const agentId = 'agent-penalty-test-5';
  for (let i = 0; i < 10; i++) {
    recordViolation(agentId);
  }
  assert.equal(getViolationInfo(agentId).multiplier, 4);

  await resetCounters();
  assert.equal(getViolationInfo(agentId).count, 0);
  assert.equal(getViolationInfo(agentId).multiplier, 1);
});
