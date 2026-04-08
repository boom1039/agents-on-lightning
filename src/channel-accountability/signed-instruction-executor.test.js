import test from 'node:test';
import assert from 'node:assert/strict';

import { SignedInstructionExecutor } from './signed-instruction-executor.js';
import {
  mockAgentRegistry,
  mockAssignmentRegistry,
  mockAuditLog,
  mockDataLayer,
  mockNodeManager,
} from '../channel-market/test-mock-factories.js';

test('set_fee_policy preserves current fee fields that were not changed', async () => {
  const node = mockNodeManager({
    feeReport: async () => ({
      channel_fees: [{
        channel_point: 'fundingtx:0',
        base_fee_msat: '1000',
        fee_per_mil: '1',
        time_lock_delta: 40,
      }],
    }),
  })._client;

  let updateArgs = null;
  node.updateChannelPolicy = async (...args) => {
    updateArgs = args;
  };

  const executor = new SignedInstructionExecutor({
    assignmentRegistry: mockAssignmentRegistry([{
      chan_id: '123',
      channel_point: 'fundingtx:0',
      agent_id: 'agent-1',
      capacity: 100000,
    }]),
    auditLog: mockAuditLog(),
    nodeManager: { getScopedDefaultNodeOrNull: () => node },
    agentRegistry: mockAgentRegistry({ 'agent-1': { id: 'agent-1', pubkey: '02'.padEnd(66, '1') } }),
    dataLayer: mockDataLayer(),
  });

  await executor._executeLnd(node, {
    action: 'set_fee_policy',
    channel_id: '123',
    params: { fee_rate_ppm: 2 },
  }, {
    channel_point: 'fundingtx:0',
    capacity: 100000,
  });

  assert.deepEqual(updateArgs, ['fundingtx:0', 1000, 2, 40]);
});
