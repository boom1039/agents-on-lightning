/**
 * Channel Closer — Unit tests with mocked LND.
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelCloser } from './channel-closer.js';
import {
  mockDataLayer, mockAuditLog, mockAgentRegistry,
  mockAssignmentRegistry, mockCapitalLedger, mockMutex,
  mockNodeManager,
} from './test-mock-factories.js';

// Ed25519 helpers
import { generateTestKeypair, signInstruction } from '../channel-accountability/test-crypto-helpers.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChannelCloser', () => {
  const CHAN_POINT = 'abc123def456:0';
  const AGENT_ID = 'test-agent-1';
  let keypair;

  before(() => {
    keypair = generateTestKeypair();
  });

  function makeCloser(overrides = {}) {
    const channels = overrides.channels || [{
      channel_point: CHAN_POINT,
      local_balance: '400000',
      remote_balance: '100000',
      capacity: '500000',
      active: true,
      remote_pubkey: '03aaa',
    }];
    const assignments = overrides.assignments || [{
      chan_id: '12345',
      channel_point: CHAN_POINT,
      agent_id: AGENT_ID,
      remote_pubkey: '03aaa',
      capacity: 500000,
    }];
    const agents = overrides.agents || {
      [AGENT_ID]: { id: AGENT_ID, name: 'TestAgent', pubkey: keypair.pubHex },
    };

    return new ChannelCloser({
      capitalLedger: overrides.capitalLedger || mockCapitalLedger(),
      nodeManager: overrides.nodeManager || mockNodeManager({
        listChannels: async () => ({ channels }),
        closedChannels: async () => ({ channels: overrides.closedChannels || [] }),
      }),
      dataLayer: mockDataLayer(),
      auditLog: mockAuditLog(),
      agentRegistry: mockAgentRegistry(agents),
      assignmentRegistry: overrides.assignmentRegistry || mockAssignmentRegistry(assignments),
      mutex: mockMutex(),
    });
  }

  function makeInstruction(overrides = {}) {
    return {
      action: 'channel_close',
      agent_id: AGENT_ID,
      timestamp: Math.floor(Date.now() / 1000),
      params: { channel_point: CHAN_POINT, force: false },
      ...overrides,
    };
  }

  function makeSignedPayload(instrOverrides = {}) {
    const instruction = makeInstruction(instrOverrides);
    const signature = signInstruction(instruction, keypair.privateKey);
    return { instruction, signature };
  }

  it('validates and initiates a cooperative close', async () => {
    const closer = makeCloser();
    await closer.load();
    const result = await closer.requestClose(AGENT_ID, makeSignedPayload());

    assert.equal(result.success, true);
    assert.equal(result.status, 'pending_close');
    assert.equal(result.close_type, 'cooperative');
    assert.equal(result.local_balance_at_close, 400000);
    assert.equal(result.original_funding_sats, 500000);
  });

  it('rejects missing instruction', async () => {
    const closer = makeCloser();
    await closer.load();
    const result = await closer.requestClose(AGENT_ID, {});
    assert.equal(result.success, false);
    assert.equal(result.failed_at, 'payload_present');
  });

  it('rejects wrong action', async () => {
    const closer = makeCloser();
    await closer.load();
    const payload = makeSignedPayload({ action: 'channel_open' });
    const result = await closer.requestClose(AGENT_ID, payload);
    assert.equal(result.success, false);
    assert.equal(result.failed_at, 'action_valid');
  });

  it('rejects agent_id mismatch', async () => {
    const closer = makeCloser();
    await closer.load();
    const payload = makeSignedPayload({ agent_id: 'wrong-agent' });
    const result = await closer.requestClose(AGENT_ID, payload);
    assert.equal(result.success, false);
    assert.equal(result.failed_at, 'agent_id_matches');
  });

  it('rejects stale timestamp', async () => {
    const closer = makeCloser();
    await closer.load();
    const payload = makeSignedPayload({ timestamp: Math.floor(Date.now() / 1000) - 600 });
    const result = await closer.requestClose(AGENT_ID, payload);
    assert.equal(result.success, false);
    assert.equal(result.failed_at, 'timestamp_fresh');
  });

  it('rejects channel not assigned to agent', async () => {
    const closer = makeCloser({
      assignments: [{
        chan_id: '12345', channel_point: CHAN_POINT,
        agent_id: 'other-agent', remote_pubkey: '03aaa', capacity: 500000,
      }],
    });
    await closer.load();
    const result = await closer.requestClose(AGENT_ID, makeSignedPayload());
    assert.equal(result.success, false);
    assert.equal(result.failed_at, 'channel_ownership');
    assert.equal(result.status, 403);
  });

  it('rejects channel not found in registry', async () => {
    const closer = makeCloser({ assignments: [] });
    await closer.load();
    const result = await closer.requestClose(AGENT_ID, makeSignedPayload());
    assert.equal(result.success, false);
    assert.equal(result.failed_at, 'channel_ownership');
    assert.equal(result.status, 404);
  });

  it('rejects duplicate instruction', async () => {
    const closer = makeCloser();
    await closer.load();
    const payload = makeSignedPayload();
    await closer.requestClose(AGENT_ID, payload);

    const result = await closer.requestClose(AGENT_ID, payload);
    assert.equal(result.success, false);
    assert.equal(result.failed_at, 'not_duplicate');
  });

  it('returns close info for agent', async () => {
    const closer = makeCloser();
    await closer.load();
    await closer.requestClose(AGENT_ID, makeSignedPayload());

    const closes = closer.getClosesForAgent(AGENT_ID);
    assert.equal(closes.length, 1);
    assert.equal(closes[0].status, 'pending_close');
    assert.equal(closes[0].channel_point, CHAN_POINT);
  });

  it('handles zero-balance channel close', async () => {
    const closer = makeCloser({
      channels: [{
        channel_point: CHAN_POINT, local_balance: '0', remote_balance: '500000',
        capacity: '500000', active: true, remote_pubkey: '03aaa',
      }],
    });
    await closer.load();
    const result = await closer.requestClose(AGENT_ID, makeSignedPayload());

    assert.equal(result.success, true);
    assert.equal(result.local_balance_at_close, 0);
  });

  it('requests force close when force: true', async () => {
    const closer = makeCloser();
    await closer.load();
    const payload = makeSignedPayload({
      params: { channel_point: CHAN_POINT, force: true },
    });
    const result = await closer.requestClose(AGENT_ID, payload);

    assert.equal(result.success, true);
    assert.equal(result.close_type, 'force');
  });
});
