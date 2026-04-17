import test from 'node:test';
import assert from 'node:assert/strict';

import { ExternalLeaderboard } from './leaderboard.js';

function registry(agents) {
  return {
    listAll: () => agents,
    updateReputation: async () => {},
  };
}

test('leaderboard ranks all-time fees, then deployed capital, then efficiency', async () => {
  const agents = [
    { id: 'zero0000', name: 'zero', registered_at: 1 },
    { id: 'smallcap', name: 'small capital', registered_at: 2 },
    { id: 'market01', name: 'market-agent', registered_at: 3 },
    { id: 'earliest', name: 'earliest', registered_at: 0 },
  ];
  const performance = new Map([
    ['zero0000', { total_fees_sats: 0, total_capacity_sats: 0 }],
    ['smallcap', { total_fees_sats: 0, total_capacity_sats: 50_000 }],
    ['market01', { total_fees_sats: 0, total_capacity_sats: 100_000 }],
    ['earliest', { total_fees_sats: 0, total_capacity_sats: 100_000 }],
  ]);
  const leaderboard = new ExternalLeaderboard(
    { writeJSON: async () => {}, appendLog: async () => {} },
    registry(agents),
    {
      getExternalLeaderboardEntries: async (ids) => ids.map((id) => ({
        agent_id: id,
        ...performance.get(id),
      })),
    },
  );

  await leaderboard.update();

  const data = leaderboard.getData();
  assert.deepEqual(data.entries.map((entry) => entry.agent_id), [
    'earliest',
    'market01',
    'smallcap',
    'zero0000',
  ]);
  assert.equal(data.entries[0].rank, 1);
  assert.equal(data.entries[3].total_capacity_sats, 0);
  assert.equal(data.metric, 'all_time_routing_performance');
  assert.equal(data.sort_order[0].column, 'total_fees_sats');
  assert.equal(data.columns.some((column) => column.name === 'total_capacity_sats'), true);
});

test('leaderboard reranks persisted entries loaded from old sort order', async () => {
  const leaderboard = new ExternalLeaderboard(
    {
      readJSON: async () => ({
        updatedAt: 123,
        entries: [
          { rank: 1, agent_id: 'zero0000', name: 'zero', total_fees_sats: 0, total_capacity_sats: 0, fees_per_sat: 0, registered_at: 1 },
          { rank: 2, agent_id: 'market01', name: 'market-agent', total_fees_sats: 0, total_capacity_sats: 100_000, fees_per_sat: 0, registered_at: 2 },
        ],
      }),
    },
    registry([]),
    null,
  );

  await leaderboard.load();

  assert.deepEqual(leaderboard.getData().entries.map((entry) => [entry.rank, entry.agent_id]), [
    [1, 'market01'],
    [2, 'zero0000'],
  ]);
});
