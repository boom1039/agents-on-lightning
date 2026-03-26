/**
 * Market Transparency — Unit tests with mocked registries.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MarketTransparency } from './market-transparency.js';
import { mockAgentRegistry, mockAssignmentRegistry, mockLndCache, mockRevenueTracker } from './test-mock-factories.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MarketTransparency', () => {
  const AGENT_1 = 'agent-1';
  const AGENT_2 = 'agent-2';
  const PEER_PUB = '03aabbccddee00112233445566778899aabbccddee00112233445566778899aabb';

  function makeTransparency(overrides = {}) {
    const assignments = overrides.assignments || [
      { chan_id: '111', channel_point: 'abc:0', agent_id: AGENT_1, remote_pubkey: PEER_PUB, capacity: 500000, assigned_at: Date.now() },
      { chan_id: '222', channel_point: 'def:1', agent_id: AGENT_2, remote_pubkey: PEER_PUB, capacity: 300000, assigned_at: Date.now() - 1000 },
    ];
    const agents = overrides.agents || {
      [AGENT_1]: { id: AGENT_1, name: 'Alpha', badge: 'gold', registered_at: Date.now() - 86400000 },
      [AGENT_2]: { id: AGENT_2, name: 'Beta', badge: null, registered_at: Date.now() - 3600000 },
    };

    return new MarketTransparency({
      assignmentRegistry: mockAssignmentRegistry(assignments),
      agentRegistry: mockAgentRegistry(agents),
      lndCache: mockLndCache(overrides.lnd || {}),
      revenueTracker: overrides.revenueTracker || mockRevenueTracker(),
      auditLog: null,
    });
  }

  it('returns market overview', async () => {
    const mt = makeTransparency();
    const overview = await mt.getOverview();

    assert.equal(overview.total_agents, 2);
    assert.equal(overview.total_channels, 2);
    assert.equal(overview.total_capacity_sats, 800000);
    assert.equal(overview.average_channel_size_sats, 400000);
    assert.ok(overview.learn);
  });

  it('returns paginated channels', async () => {
    const mt = makeTransparency();
    const result = await mt.getChannels({ limit: 1, offset: 0 });

    assert.equal(result.channels.length, 1);
    assert.equal(result.total, 2);
    assert.equal(result.has_more, true);
  });

  it('returns all channels when limit exceeds total', async () => {
    const mt = makeTransparency();
    const result = await mt.getChannels({ limit: 50, offset: 0 });

    assert.equal(result.channels.length, 2);
    assert.equal(result.has_more, false);
  });

  it('channel listing includes agent name and fees', async () => {
    const mt = makeTransparency({
      lnd: {
        feeReport: [
          { channel_point: 'abc:0', base_fee_msat: '1000', fee_per_mil: '200' },
        ],
      },
    });
    const result = await mt.getChannels();

    const ch1 = result.channels.find(c => c.channel_point === 'abc:0');
    assert.equal(ch1.agent_name, 'Alpha');
    assert.equal(ch1.base_fee_msat, 1000);
    assert.equal(ch1.fee_rate_ppm, 200);
  });

  it('channel listing includes balance_health field', async () => {
    const mt = makeTransparency({
      lnd: {
        channels: [
          { channel_point: 'abc:0', capacity: '500000', local_balance: '250000', active: true },
          { channel_point: 'def:1', capacity: '300000', local_balance: '50000', active: true },
        ],
      },
    });
    const result = await mt.getChannels();

    const ch1 = result.channels.find(c => c.channel_point === 'abc:0');
    const ch2 = result.channels.find(c => c.channel_point === 'def:1');
    assert.equal(ch1.balance_health, 'balanced');
    assert.equal(ch2.balance_health, 'inbound_heavy');
  });

  it('returns agent public profile', async () => {
    const mt = makeTransparency();
    const profile = await mt.getAgentProfile(AGENT_1);

    assert.equal(profile.agent_id, AGENT_1);
    assert.equal(profile.name, 'Alpha');
    assert.equal(profile.badge, 'gold');
    assert.equal(profile.channels_count, 1);
    // Must NOT expose private data
    assert.equal(profile.capital_balance, undefined);
    assert.equal(profile.deposit_address, undefined);
    assert.equal(profile.cashu_balance, undefined);
  });

  it('returns 404 for unknown agent', async () => {
    const mt = makeTransparency();
    const result = await mt.getAgentProfile('nonexistent');
    assert.equal(result.success, false);
    assert.equal(result.status, 404);
  });

  it('returns peer safety info', async () => {
    const mt = makeTransparency();
    const safety = await mt.getPeerSafety(PEER_PUB);

    assert.equal(safety.peer_pubkey, PEER_PUB);
    assert.equal(safety.agents_with_channels, 2);
    assert.equal(safety.total_capacity_sats, 800000);
    assert.equal(safety.safe, true);
    assert.equal(safety.warnings.length, 0);
  });

  it('peer safety warns about force closes', async () => {
    const mt = makeTransparency({
      lnd: {
        closedChannels: [
          { remote_pubkey: PEER_PUB, close_type: 'REMOTE_FORCE_CLOSE', channel_point: 'old:0' },
        ],
      },
    });
    const safety = await mt.getPeerSafety(PEER_PUB);

    assert.equal(safety.safe, false);
    assert.equal(safety.force_closes, 1);
    assert.ok(safety.warnings[0].includes('force close'));
  });

  it('rejects invalid pubkey for peer safety', async () => {
    const mt = makeTransparency();
    const result = await mt.getPeerSafety('short');
    assert.equal(result.success, false);
    assert.equal(result.status, 400);
  });

  it('returns fee competition for peer', async () => {
    const mt = makeTransparency({
      lnd: {
        feeReport: [
          { channel_point: 'abc:0', base_fee_msat: '1000', fee_per_mil: '200' },
          { channel_point: 'def:1', base_fee_msat: '500', fee_per_mil: '100' },
        ],
      },
    });
    const competition = await mt.getFeeCompetition(PEER_PUB);

    assert.equal(competition.count, 2);
    assert.equal(competition.channels.length, 2);
    assert.ok(competition.learn.includes('2 agent'));
  });

  it('returns empty for peer with no agent channels', async () => {
    const mt = makeTransparency();
    const UNKNOWN_PEER = '03' + '00'.repeat(32);
    const result = await mt.getFeeCompetition(UNKNOWN_PEER);

    assert.equal(result.count, 0);
    assert.ok(result.learn.includes('first'));
  });

  it('overview includes revenue stats when tracker available', async () => {
    const mt = makeTransparency({
      revenueTracker: mockRevenueTracker({
        totalRevenue: {
          total_fees_msat: 50000,
          total_fees_sats: 50,
          total_forwards: 100,
        },
      }),
    });
    const overview = await mt.getOverview();

    assert.equal(overview.total_revenue_sats, 50);
    assert.equal(overview.total_forwards, 100);
  });
});
