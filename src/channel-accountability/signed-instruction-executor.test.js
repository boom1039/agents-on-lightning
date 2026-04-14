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

test('set_fee_policy mirrors a zero-sat event into the public ledger', async () => {
  const mirrored = [];
  const proofRows = [];
  const executor = new SignedInstructionExecutor({
    assignmentRegistry: mockAssignmentRegistry(),
    auditLog: mockAuditLog(),
    nodeManager: mockNodeManager(),
    agentRegistry: mockAgentRegistry(),
    dataLayer: mockDataLayer(),
    publicLedger: {
      record: async (entry) => {
        mirrored.push(structuredClone(entry));
        return entry;
      },
    },
    proofLedger: {
      appendProof: async (proof) => {
        proofRows.push(structuredClone(proof));
        return proof;
      },
    },
  });

  await executor._recordPublicLedgerExecution({
    agentId: 'agent-1',
    assignment: { channel_point: 'fundingtx:0' },
    instruction: {
      action: 'set_fee_policy',
      channel_id: '123',
      params: { base_fee_msat: 1500, fee_rate_ppm: 2 },
    },
    executedAt: 1234567890,
    executionMeta: {
      ledgerType: 'channel_fee_policy_updated',
      old_policy: { base_fee_msat: 1000, fee_rate_ppm: 1, time_lock_delta: 40 },
      new_policy: { base_fee_msat: 1500, fee_rate_ppm: 2, time_lock_delta: 40 },
    },
  });

  assert.equal(mirrored.length, 1);
  assert.deepEqual(mirrored[0], {
    type: 'channel_fee_policy_updated',
    agent_id: 'agent-1',
    amount_sats: 0,
    channel_id: '123',
    channel_point: 'fundingtx:0',
    action: 'set_fee_policy',
    params: { base_fee_msat: 1500, fee_rate_ppm: 2 },
    old_policy: { base_fee_msat: 1000, fee_rate_ppm: 1, time_lock_delta: 40 },
    new_policy: { base_fee_msat: 1500, fee_rate_ppm: 2, time_lock_delta: 40 },
    source: 'channels_signed',
    executed_at: 1234567890,
  });
  assert.equal(proofRows.length, 1);
  assert.equal(proofRows[0].proof_record_type, 'money_lifecycle');
  assert.equal(proofRows[0].money_event_type, 'channel_policy_updated');
  assert.equal(proofRows[0].money_event_status, 'confirmed');
  assert.equal(proofRows[0].agent_id, 'agent-1');
  assert.equal(proofRows[0].event_source, 'channels_signed');
  assert.equal(proofRows[0].authorization_method, 'agent_signed_instruction');
  assert.equal(proofRows[0].primary_amount_sats, 0);
  assert.match(proofRows[0].idempotency_key, /^signed-channel-policy:agent-1:/);
  assert.deepEqual(proofRows[0].public_safe_refs, {
    channel_id: '123',
    channel_point: 'fundingtx:0',
    action: 'set_fee_policy',
    instruction_hash: proofRows[0].public_safe_refs.instruction_hash,
    status: 'confirmed',
  });
});
