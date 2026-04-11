import test from 'node:test';
import assert from 'node:assert/strict';

import { LndCache } from './lnd-cache.js';
import { mockNodeManager } from './test-mock-factories.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('LndCache coalesces concurrent reads and reuses cached data inside TTL', async () => {
  let calls = 0;
  const nodeManager = mockNodeManager({
    listChannels: async () => {
      calls += 1;
      await sleep(25);
      return { channels: [{ channel_point: `cp-${calls}` }] };
    },
  });
  const cache = new LndCache(nodeManager, 30_000);

  const [first, second] = await Promise.all([
    cache.getChannels(),
    cache.getChannels(),
  ]);

  assert.equal(calls, 1);
  assert.deepEqual(first, second);

  const third = await cache.getChannels();
  assert.equal(calls, 1);
  assert.deepEqual(third, first);
});

test('LndCache live reads still singleflight while in flight but do not persist stale results', async () => {
  let calls = 0;
  const nodeManager = mockNodeManager({
    feeReport: async () => {
      calls += 1;
      await sleep(25);
      return { channel_fees: [{ channel_point: `cp-${calls}` }] };
    },
  });
  const cache = new LndCache(nodeManager, 30_000);

  const [first, second] = await Promise.all([
    cache.getFeeReportLive(),
    cache.getFeeReportLive(),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);

  const third = await cache.getFeeReportLive();
  assert.equal(calls, 2);
  assert.notDeepEqual(third, first);
});
