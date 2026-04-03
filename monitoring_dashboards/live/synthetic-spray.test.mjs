import test from 'node:test';
import assert from 'node:assert/strict';

import { createSyntheticJourneySprayController } from './synthetic-spray.mjs';

test('synthetic spray emits registration and request lifecycle events', () => {
  const controller = createSyntheticJourneySprayController({
    seed: 3,
    initialBurstSize: 6,
    burstEveryMs: 10_000,
    maxStartsPerTick: 12,
    maxInflight: 24,
  });

  const events = [];
  for (let now = 1_000; now <= 5_000; now += controller.tickMs) {
    events.push(...controller.drain(now));
  }

  assert.ok(events.some((event) => event.event === 'registration_attempt'));
  assert.ok(events.some((event) => event.event === 'request_start'));
  assert.ok(events.some((event) => event.event === 'request_finish'));
  assert.ok(events.some((event) => event.path === '/api/v1/agents/register'));
});

test('synthetic spray moves agents across multiple domains', () => {
  const controller = createSyntheticJourneySprayController({
    seed: 11,
    initialBurstSize: 10,
    burstEveryMs: 10_000,
    maxStartsPerTick: 16,
    maxInflight: 32,
  });

  const finishDomains = new Set();
  const byAgent = new Map();

  for (let now = 1_000; now <= 12_000; now += controller.tickMs) {
    for (const event of controller.drain(now)) {
      if (event.event !== 'request_finish') continue;
      const domain = String(event.path || '');
      finishDomains.add(domain.split('/')[3] || domain || 'root');
      const list = byAgent.get(event.agent_id) || [];
      list.push(event.path);
      byAgent.set(event.agent_id, list);
    }
  }

  assert.ok(finishDomains.size >= 4);
  assert.ok(
    Array.from(byAgent.values()).some((paths) => {
      const groups = new Set(paths.map((path) => path.split('/')[3] || path));
      return groups.size >= 3;
    }),
  );
});
