import test from 'node:test';
import assert from 'node:assert/strict';

import { ChannelCloser } from './channel-closer.js';
import { CapitalLedger } from './capital-ledger.js';
import {
  mockDataLayer,
  mockAuditLog,
  mockMutex,
  mockAgentRegistry,
  mockAssignmentRegistry,
  mockNodeManager,
} from './test-mock-factories.js';

test('detectSettledCloses reconciles a timed-out close that was rolled back too early', async () => {
  const dataLayer = mockDataLayer();
  const auditLog = mockAuditLog();
  const mutex = mockMutex();
  const capitalLedger = new CapitalLedger({ dataLayer, auditLog, mutex });
  const agentId = 'agent-close-timeout';
  const channelPoint = 'fundingtx:0';

  await dataLayer.writeJSON(`data/channel-market/capital/${agentId}.json`, {
    available: 0,
    locked: 100_000,
    pending_deposit: 0,
    pending_close: 0,
    total_deposited: 100_000,
    total_withdrawn: 0,
    total_revenue_credited: 0,
    total_ecash_funded: 0,
    total_routing_pnl: 0,
    processed_refs: [],
    last_updated: new Date().toISOString(),
  });

  const assignmentRegistry = mockAssignmentRegistry([{
    chan_id: '123',
    channel_point: channelPoint,
    agent_id: agentId,
    remote_pubkey: '02'.padEnd(66, '1'),
    capacity: 100_000,
    assigned_at: Date.now() - 1_000,
  }]);

  const closer = new ChannelCloser({
    capitalLedger,
    nodeManager: mockNodeManager({
      closedChannels: async () => ({
        channels: [{
          channel_point: channelPoint,
          settled_balance: '99849',
          closing_tx_hash: 'close-tx',
          close_type: 'COOPERATIVE_CLOSE',
        }],
      }),
    }),
    dataLayer,
    auditLog,
    agentRegistry: mockAgentRegistry({ [agentId]: { id: agentId, name: 'Closer Test' } }),
    assignmentRegistry,
    mutex,
  });

  closer._state[channelPoint] = {
    agent_id: agentId,
    channel_point: channelPoint,
    status: 'close_failed',
    original_locked: 100_000,
    local_balance_at_close: 100_000,
    requested_at: Date.now() - 30_000,
    error: 'The node did not answer before the close timeout. The channel may still be closing.',
  };

  await closer._detectSettledCloses();

  const balance = await capitalLedger.getBalance(agentId);
  assert.equal(balance.available, 99_849);
  assert.equal(balance.locked, 0);
  assert.equal(balance.pending_close, 0);
  assert.equal(balance.total_routing_pnl, 151);
  assert.equal(closer._state[channelPoint].status, 'settled');
  assert.deepEqual(assignmentRegistry.revoked, [channelPoint]);
});
