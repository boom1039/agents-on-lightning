/**
 * Revenue Attribution Tracker — Unit tests with mocked LND.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { RevenueAttributionTracker } from './revenue-attribution-tracker.js';
import {
  mockDataLayer, mockAuditLog, mockAssignmentRegistry,
  mockCapitalLedger, mockMutex, mockNodeManager,
} from './test-mock-factories.js';

function revenueNodeManager(forwardingEvents = []) {
  return mockNodeManager({
    forwardingHistory: async () => ({
      forwarding_events: forwardingEvents,
      last_offset_index: String(forwardingEvents.length),
    }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RevenueAttributionTracker', () => {
  const AGENT_ID = 'test-agent-1';
  const CHAN_ID_OUT = '888111222333';

  function makeTracker(overrides = {}) {
    const assignments = overrides.assignments || [{
      chan_id: CHAN_ID_OUT,
      channel_point: 'abc:0',
      agent_id: AGENT_ID,
      remote_pubkey: '03aaa',
      capacity: 500000,
    }];

    return new RevenueAttributionTracker({
      capitalLedger: overrides.capitalLedger || mockCapitalLedger(),
      nodeManager: overrides.nodeManager || revenueNodeManager(overrides.events || []),
      dataLayer: mockDataLayer(),
      auditLog: mockAuditLog(),
      assignmentRegistry: mockAssignmentRegistry(assignments),
      mutex: mockMutex(),
    });
  }

  it('attributes fee to outbound channel agent', async () => {
    const ledger = mockCapitalLedger();
    const tracker = makeTracker({
      capitalLedger: ledger,
      events: [{
        chan_id_in: '999000111',
        chan_id_out: CHAN_ID_OUT,
        fee_msat: '5000',
        timestamp: String(Math.floor(Date.now() / 1000)),
      }],
    });
    await tracker.load();
    await tracker._processForwards();

    assert.equal(ledger.credits.length, 1);
    assert.equal(ledger.credits[0].agentId, AGENT_ID);
    assert.equal(ledger.credits[0].amount, 5); // 5000 msat = 5 sats
  });

  it('does not attribute fee when outbound channel is not agent-managed', async () => {
    const ledger = mockCapitalLedger();
    const tracker = makeTracker({
      capitalLedger: ledger,
      assignments: [], // no assignments
      events: [{
        chan_id_in: '999000111',
        chan_id_out: CHAN_ID_OUT,
        fee_msat: '5000',
        timestamp: String(Math.floor(Date.now() / 1000)),
      }],
    });
    await tracker.load();
    await tracker._processForwards();

    assert.equal(ledger.credits.length, 0);
  });

  it('accumulates sub-sat msat correctly', async () => {
    const ledger = mockCapitalLedger();
    const now = Math.floor(Date.now() / 1000);
    const events = [];
    // 3 forwards at 300 msat each = 900 msat total < 1 sat
    for (let i = 0; i < 3; i++) {
      events.push({
        chan_id_in: '999000111',
        chan_id_out: CHAN_ID_OUT,
        fee_msat: '300',
        timestamp: String(now + i),
      });
    }

    const tracker = makeTracker({ capitalLedger: ledger, events });
    await tracker.load();
    await tracker._processForwards();

    // 900 msat = 0 sats credited, 900 msat pending
    assert.equal(ledger.credits.length, 0);

    const revenue = tracker.getAgentRevenue(AGENT_ID);
    assert.equal(revenue.pending_msat, 900);
    assert.equal(revenue.total_fees_msat, 900);
  });

  it('credits accumulated msat when threshold reached', async () => {
    const ledger = mockCapitalLedger();
    const now = Math.floor(Date.now() / 1000);
    const events = [];
    // 4 forwards at 300 msat = 1200 msat = 1 sat (200 msat remainder)
    for (let i = 0; i < 4; i++) {
      events.push({
        chan_id_in: '999000111',
        chan_id_out: CHAN_ID_OUT,
        fee_msat: '300',
        timestamp: String(now + i),
      });
    }

    const tracker = makeTracker({ capitalLedger: ledger, events });
    await tracker.load();
    await tracker._processForwards();

    assert.equal(ledger.credits.length, 1);
    assert.equal(ledger.credits[0].amount, 1);

    const revenue = tracker.getAgentRevenue(AGENT_ID);
    assert.equal(revenue.pending_msat, 200);
  });

  it('handles multiple agents in one poll cycle', async () => {
    const ledger = mockCapitalLedger();
    const AGENT_2 = 'test-agent-2';
    const CHAN_2 = '777222333444';
    const now = Math.floor(Date.now() / 1000);

    const tracker = makeTracker({
      capitalLedger: ledger,
      assignments: [
        { chan_id: CHAN_ID_OUT, channel_point: 'abc:0', agent_id: AGENT_ID, capacity: 500000 },
        { chan_id: CHAN_2, channel_point: 'def:1', agent_id: AGENT_2, capacity: 300000 },
      ],
      events: [
        { chan_id_in: '999', chan_id_out: CHAN_ID_OUT, fee_msat: '2000', timestamp: String(now) },
        { chan_id_in: '999', chan_id_out: CHAN_2, fee_msat: '3000', timestamp: String(now + 1) },
      ],
    });
    await tracker.load();
    await tracker._processForwards();

    assert.equal(ledger.credits.length, 2);
    assert.equal(ledger.credits[0].agentId, AGENT_ID);
    assert.equal(ledger.credits[0].amount, 2);
    assert.equal(ledger.credits[1].agentId, AGENT_2);
    assert.equal(ledger.credits[1].amount, 3);
  });

  it('returns revenue summary for agent', async () => {
    const tracker = makeTracker({
      events: [{
        chan_id_in: '999',
        chan_id_out: CHAN_ID_OUT,
        fee_msat: '10000',
        timestamp: String(Math.floor(Date.now() / 1000)),
      }],
    });
    await tracker.load();
    await tracker._processForwards();

    const revenue = tracker.getAgentRevenue(AGENT_ID);
    assert.equal(revenue.total_fees_msat, 10000);
    assert.equal(revenue.total_fees_sats, 10);
    assert.equal(revenue.forward_count, 1);
    assert.equal(revenue.channels.length, 1);
    assert.equal(revenue.destination, 'capital');
  });

  it('returns per-channel revenue', async () => {
    const tracker = makeTracker({
      events: [{
        chan_id_in: '999',
        chan_id_out: CHAN_ID_OUT,
        fee_msat: '5000',
        timestamp: String(Math.floor(Date.now() / 1000)),
      }],
    });
    await tracker.load();
    await tracker._processForwards();

    const chanRev = tracker.getChannelRevenue(CHAN_ID_OUT);
    assert.equal(chanRev.total_fees_msat, 5000);
    assert.equal(chanRev.forward_count, 1);
  });

  it('revenue config defaults to capital', async () => {
    const tracker = makeTracker();
    await tracker.load();

    const config = tracker.getRevenueConfig(AGENT_ID);
    assert.equal(config.destination, 'capital');
  });

  it('rejects non-capital destination', async () => {
    const tracker = makeTracker();
    await tracker.load();

    const result = await tracker.setRevenueConfig(AGENT_ID, { destination: 'cashu' });
    assert.equal(result.success, false);
  });

  it('handles zero-fee forwards', async () => {
    const ledger = mockCapitalLedger();
    const tracker = makeTracker({
      capitalLedger: ledger,
      events: [{
        chan_id_in: '999',
        chan_id_out: CHAN_ID_OUT,
        fee_msat: '0',
        timestamp: String(Math.floor(Date.now() / 1000)),
      }],
    });
    await tracker.load();
    await tracker._processForwards();

    assert.equal(ledger.credits.length, 0);
  });
});
