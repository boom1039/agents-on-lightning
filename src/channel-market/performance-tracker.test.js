import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PerformanceTracker } from './performance-tracker.js';
import { classifyBalanceHealth } from './lnd-cache.js';
import {
  mockDataLayer,
  mockAssignmentRegistry,
  mockAgentRegistry,
  mockRevenueTracker,
  mockLndCache,
} from './test-mock-factories.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHAN_POINT_A = 'abc123:0';
const CHAN_POINT_B = 'def456:1';
const CHAN_ID_A = '111';
const CHAN_ID_B = '222';
const AGENT_1 = 'agent-1';
const AGENT_2 = 'agent-2';

function makeTracker({
  assignments = [],
  channels = [],
  feeReport = [],
  channelRevenue = {},
  agentRevenue = {},
  agents = {},
} = {}) {
  return new PerformanceTracker({
    dataLayer: mockDataLayer(),
    assignmentRegistry: mockAssignmentRegistry(assignments),
    revenueTracker: mockRevenueTracker({ channelRevenue, agentRevenue }),
    lndCache: mockLndCache({ channels, feeReport }),
    agentRegistry: mockAgentRegistry(agents),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PerformanceTracker', () => {
  // =========================================================================
  // Uptime counters
  // =========================================================================

  describe('uptime tracking', () => {
    it('increments active_samples for active channels', async () => {
      const tracker = makeTracker({
        assignments: [
          { channel_point: CHAN_POINT_A, chan_id: CHAN_ID_A, agent_id: AGENT_1 },
        ],
        channels: [
          { channel_point: CHAN_POINT_A, chan_id: CHAN_ID_A, active: true, capacity: '1000000', local_balance: '500000', remote_balance: '500000' },
        ],
      });

      await tracker._recordUptimeSamples();
      await tracker._recordUptimeSamples();

      const counter = tracker._uptimeCounters[CHAN_POINT_A];
      assert.equal(counter.total_samples, 2);
      assert.equal(counter.active_samples, 2);
    });

    it('increments total_samples but not active_samples for inactive channels', async () => {
      const tracker = makeTracker({
        assignments: [
          { channel_point: CHAN_POINT_A, chan_id: CHAN_ID_A, agent_id: AGENT_1 },
        ],
        channels: [
          { channel_point: CHAN_POINT_A, chan_id: CHAN_ID_A, active: false, capacity: '1000000', local_balance: '500000', remote_balance: '500000' },
        ],
      });

      await tracker._recordUptimeSamples();

      const counter = tracker._uptimeCounters[CHAN_POINT_A];
      assert.equal(counter.total_samples, 1);
      assert.equal(counter.active_samples, 0);
      assert.ok(counter.last_seen_inactive > 0);
    });

    it('computes correct uptime pct from mixed active/inactive samples', async () => {
      const tracker = makeTracker({
        assignments: [
          { channel_point: CHAN_POINT_A, chan_id: CHAN_ID_A, agent_id: AGENT_1 },
        ],
        channels: [
          { channel_point: CHAN_POINT_A, chan_id: CHAN_ID_A, active: true, capacity: '1000000', local_balance: '500000', remote_balance: '500000' },
        ],
      });

      // 3 active samples
      await tracker._recordUptimeSamples();
      await tracker._recordUptimeSamples();
      await tracker._recordUptimeSamples();

      // Now swap the lndCache to return inactive for 1 sample
      tracker._lndCache = mockLndCache({
        channels: [{ channel_point: CHAN_POINT_A, chan_id: CHAN_ID_A, active: false, capacity: '1000000', local_balance: '500000', remote_balance: '500000' }],
      });
      await tracker._recordUptimeSamples();

      const counter = tracker._uptimeCounters[CHAN_POINT_A];
      assert.equal(counter.total_samples, 4);
      assert.equal(counter.active_samples, 3);
      // 75%
      const pct = Math.round((counter.active_samples / counter.total_samples) * 10000) / 100;
      assert.equal(pct, 75);
    });
  });

  // =========================================================================
  // Balance health classifier (shared export)
  // =========================================================================

  describe('balance health', () => {
    it('classifies balanced (0.2–0.8)', () => {
      assert.equal(classifyBalanceHealth(500_000, 1_000_000), 'balanced');
    });

    it('classifies outbound_heavy (>0.8)', () => {
      assert.equal(classifyBalanceHealth(850_000, 1_000_000), 'outbound_heavy');
    });

    it('classifies inbound_heavy (<0.2)', () => {
      assert.equal(classifyBalanceHealth(150_000, 1_000_000), 'inbound_heavy');
    });

    it('classifies depleted (<0.05 or >0.95)', () => {
      assert.equal(classifyBalanceHealth(30_000, 1_000_000), 'depleted');
      assert.equal(classifyBalanceHealth(960_000, 1_000_000), 'depleted');
    });
  });

  // =========================================================================
  // Leaderboard
  // =========================================================================

  describe('leaderboard', () => {
    it('sorts by fees descending', () => {
      const tracker = makeTracker({
        assignments: [
          { channel_point: CHAN_POINT_A, chan_id: CHAN_ID_A, agent_id: AGENT_1 },
          { channel_point: CHAN_POINT_B, chan_id: CHAN_ID_B, agent_id: AGENT_2 },
        ],
        agentRevenue: {
          [AGENT_1]: { total_fees_msat: 5_000, forward_count: 2 },
          [AGENT_2]: { total_fees_msat: 10_000, forward_count: 3 },
        },
        agents: {
          [AGENT_1]: { name: 'Alpha' },
          [AGENT_2]: { name: 'Beta' },
        },
      });

      const result = tracker.getLeaderboard('fees');
      assert.equal(result.rankings[0].agent_id, AGENT_2);
      assert.equal(result.rankings[0].total_fees_sats, 10);
      assert.equal(result.rankings[1].agent_id, AGENT_1);
      assert.equal(result.rankings[1].total_fees_sats, 5);
    });

    it('sorts by forwards descending', () => {
      const tracker = makeTracker({
        assignments: [
          { channel_point: CHAN_POINT_A, chan_id: CHAN_ID_A, agent_id: AGENT_1 },
          { channel_point: CHAN_POINT_B, chan_id: CHAN_ID_B, agent_id: AGENT_2 },
        ],
        agentRevenue: {
          [AGENT_1]: { total_fees_msat: 5_000, forward_count: 10 },
          [AGENT_2]: { total_fees_msat: 10_000, forward_count: 3 },
        },
        agents: {
          [AGENT_1]: { name: 'Alpha' },
          [AGENT_2]: { name: 'Beta' },
        },
      });

      const result = tracker.getLeaderboard('forwards');
      assert.equal(result.rankings[0].agent_id, AGENT_1);
      assert.equal(result.rankings[0].forward_count, 10);
    });

    it('returns empty rankings when no agents', () => {
      const tracker = makeTracker();
      const result = tracker.getLeaderboard('fees');
      assert.equal(result.rankings.length, 0);
      assert.equal(result.total_agents, 0);
    });

    it('rejects invalid metric', () => {
      const tracker = makeTracker();
      const result = tracker.getLeaderboard('invalid');
      assert.equal(result.success, false);
      assert.equal(result.status, 400);
    });
  });

  // =========================================================================
  // Channel performance
  // =========================================================================

  describe('getChannelPerformance', () => {
    it('combines revenue + balance + uptime into single response', async () => {
      const tracker = makeTracker({
        assignments: [
          { channel_point: CHAN_POINT_A, chan_id: CHAN_ID_A, agent_id: AGENT_1, assigned_at: Date.now() - 3600_000, capacity: 1_000_000, remote_pubkey: '03aa' },
        ],
        channels: [
          { channel_point: CHAN_POINT_A, chan_id: CHAN_ID_A, active: true, capacity: '1000000', local_balance: '500000', remote_balance: '500000' },
        ],
        feeReport: [
          { channel_point: CHAN_POINT_A, base_fee_msat: '1000', fee_per_mil: '100' },
        ],
        channelRevenue: {
          [CHAN_ID_A]: { chan_id: CHAN_ID_A, total_fees_msat: 5000, total_fees_sats: 5, forward_count: 3, last_forward_at: 1000 },
        },
      });

      // Seed some uptime data
      tracker._uptimeCounters[CHAN_POINT_A] = { total_samples: 10, active_samples: 9, last_seen_active: Date.now(), last_seen_inactive: 0, tracking_since: Date.now() - 86400_000 };

      const result = await tracker.getChannelPerformance(CHAN_ID_A, AGENT_1);
      assert.equal(result.chan_id, CHAN_ID_A);
      assert.equal(result.balance_health, 'balanced');
      assert.equal(result.total_fees_sats, 5);
      assert.equal(result.forward_count, 3);
      assert.equal(result.uptime_pct, 90);
      assert.equal(result.base_fee_msat, 1000);
      assert.equal(result.fee_rate_ppm, 100);
      assert.ok(result.learn);
    });

    it('returns zeros for unknown channel', async () => {
      const tracker = makeTracker();
      const result = await tracker.getChannelPerformance('999', AGENT_1);
      assert.equal(result.chan_id, '999');
      assert.equal(result.total_fees_sats, 0);
      assert.equal(result.forward_count, 0);
      assert.equal(result.uptime_pct, null);
    });
  });

  // =========================================================================
  // Agent performance
  // =========================================================================

  describe('getAgentPerformance', () => {
    it('aggregates all channels for an agent', async () => {
      const tracker = makeTracker({
        assignments: [
          { channel_point: CHAN_POINT_A, chan_id: CHAN_ID_A, agent_id: AGENT_1, capacity: 1_000_000, remote_pubkey: '03aa' },
          { channel_point: CHAN_POINT_B, chan_id: CHAN_ID_B, agent_id: AGENT_1, capacity: 500_000, remote_pubkey: '03bb' },
        ],
        channels: [
          { channel_point: CHAN_POINT_A, chan_id: CHAN_ID_A, active: true, capacity: '1000000', local_balance: '500000', remote_balance: '500000' },
          { channel_point: CHAN_POINT_B, chan_id: CHAN_ID_B, active: true, capacity: '500000', local_balance: '250000', remote_balance: '250000' },
        ],
        agentRevenue: {
          [AGENT_1]: { agent_id: AGENT_1, total_fees_msat: 8000, total_fees_sats: 8, forward_count: 5, channels: [] },
        },
      });

      const result = await tracker.getAgentPerformance(AGENT_1);
      assert.equal(result.total_channels, 2);
      assert.equal(result.total_capacity_sats, 1_500_000);
      assert.equal(result.total_fees_sats, 8);
      assert.equal(result.total_forwards, 5);
      assert.equal(result.channels.length, 2);
      assert.ok(result.learn);
    });
  });

  // =========================================================================
  // Daily snapshot
  // =========================================================================

  describe('daily snapshot', () => {
    it('appends snapshot entries and resets uptime counters', async () => {
      const dataLayer = mockDataLayer();
      const logEntries = [];
      dataLayer.appendLog = async (path, entry) => {
        logEntries.push({ path, entry });
      };

      const tracker = new PerformanceTracker({
        dataLayer,
        assignmentRegistry: mockAssignmentRegistry([
          { channel_point: CHAN_POINT_A, chan_id: CHAN_ID_A, agent_id: AGENT_1, capacity: 1_000_000 },
        ]),
        revenueTracker: mockRevenueTracker(),
        lndCache: mockLndCache({
          channels: [
            { channel_point: CHAN_POINT_A, chan_id: CHAN_ID_A, active: true, capacity: '1000000', local_balance: '500000', remote_balance: '500000' },
          ],
        }),
        agentRegistry: mockAgentRegistry(),
      });

      // Seed uptime
      tracker._uptimeCounters[CHAN_POINT_A] = { total_samples: 100, active_samples: 95, last_seen_active: Date.now(), last_seen_inactive: 0, tracking_since: Date.now() };

      await tracker._snapshotDaily();

      // Should have appended one entry
      assert.equal(logEntries.length, 1);
      assert.equal(logEntries[0].entry.chan_id, CHAN_ID_A);
      assert.equal(logEntries[0].entry.uptime_pct, 95);

      // Counters should be reset
      assert.equal(tracker._uptimeCounters[CHAN_POINT_A].total_samples, 0);
      assert.equal(tracker._uptimeCounters[CHAN_POINT_A].active_samples, 0);
    });
  });

  // =========================================================================
  // Restart persistence
  // =========================================================================

  describe('load/persist', () => {
    it('restores uptime counters from disk', async () => {
      const dataLayer = mockDataLayer();
      await dataLayer.writeJSON('data/channel-market/performance-uptime.json', {
        _uptimeCounters: {
          [CHAN_POINT_A]: { total_samples: 50, active_samples: 48, last_seen_active: 1000, last_seen_inactive: 0, tracking_since: 500 },
        },
      });

      const tracker = new PerformanceTracker({
        dataLayer,
        assignmentRegistry: mockAssignmentRegistry([]),
        revenueTracker: mockRevenueTracker(),
        lndCache: mockLndCache(),
        agentRegistry: mockAgentRegistry(),
      });

      await tracker.load();
      assert.equal(tracker._uptimeCounters[CHAN_POINT_A].total_samples, 50);
      assert.equal(tracker._uptimeCounters[CHAN_POINT_A].active_samples, 48);
    });
  });
});
