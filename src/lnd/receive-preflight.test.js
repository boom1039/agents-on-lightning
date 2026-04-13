import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSingleChannelReceivePreflight } from './receive-preflight.js';

test('single-channel receive preflight accepts when one active channel can receive amount', async () => {
  const preflight = await buildSingleChannelReceivePreflight({
    listChannels: async () => ({
      channels: [
        {
          active: true,
          remote_balance: '150000',
          unsettled_balance: '0',
          remote_constraints: { chan_reserve_sat: '1000' },
        },
        {
          active: true,
          remote_balance: '20000',
          unsettled_balance: '0',
          remote_constraints: { chan_reserve_sat: '1000' },
        },
      ],
    }),
  }, 100_000);

  assert.equal(preflight.can_receive, true);
  assert.equal(preflight.decision_basis, 'largest_single_active_channel');
  assert.equal(preflight.largest_single_channel_receivable_sats, 148_000);
  assert.equal(preflight.suggested_max_sats, 148_000);
});

test('single-channel receive preflight rejects even when aggregate liquidity is higher', async () => {
  const preflight = await buildSingleChannelReceivePreflight({
    listChannels: async () => ({
      channels: [
        {
          active: true,
          remote_balance: '60000',
          unsettled_balance: '0',
          remote_constraints: { chan_reserve_sat: '1000' },
        },
        {
          active: true,
          remote_balance: '60000',
          unsettled_balance: '0',
          remote_constraints: { chan_reserve_sat: '1000' },
        },
      ],
    }),
  }, 100_000);

  assert.equal(preflight.can_receive, false);
  assert.equal(preflight.largest_single_channel_receivable_sats, 58_000);
  assert.equal(preflight.total_receivable_sats, 116_000);
  assert.equal(preflight.suggested_max_sats, 58_000);
});

test('single-channel receive preflight fails closed when channels cannot be read', async () => {
  const preflight = await buildSingleChannelReceivePreflight({
    listChannels: async () => {
      throw new Error('permission denied');
    },
  }, 100_000);

  assert.equal(preflight.can_receive, false);
  assert.match(preflight.reason, /Could not verify inbound liquidity/);
});
