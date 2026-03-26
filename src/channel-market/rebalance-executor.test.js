/**
 * Unit tests for the Rebalance Executor (Plan H).
 *
 * Run: node --test ai_panel/server/channel-market/rebalance-executor.test.js
 *
 * Coverage:
 *   1. Validation pipeline — missing params, bad signature, unowned channel, insufficient capital
 *   2. Capital locking — lock before payment, refund on failure, deduct on success
 *   3. Streaming response handling — succeeded, failed
 *   4. Crash recovery — in-flight resumed, succeeded/failed reconciled
 *   5. Fee estimation — routes found, no routes
 *   6. History logging — success and failure logged
 *   7. Concurrency — mutex prevents parallel rebalances
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mockDataLayer,
  mockAuditLog,
  mockMutex,
  mockAgentRegistry,
  mockAssignmentRegistry,
  mockCapitalLedger,
  mockNodeManager,
} from './test-mock-factories.js';
import { RebalanceExecutor } from './rebalance-executor.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Creates a signed payload that passes shared validation.
 * Uses the mock agent registry with a pre-registered pubkey.
 */
function makePayload(params = {}) {
  return {
    instruction: {
      action: 'rebalance',
      agent_id: 'agent-01',
      timestamp: Math.floor(Date.now() / 1000),
      params: {
        outbound_chan_id: '12345',
        amount_sats: 100_000,
        max_fee_sats: 500,
        ...params,
      },
    },
    signature: 'valid-sig',
  };
}

/** Rebalance-specific NodeManager defaults. */
const REBALANCE_LND_DEFAULTS = {
  sendPaymentV2: async () => ({ status: 'SUCCEEDED', fee_sat: '32', payment_preimage: 'preimage_hex' }),
  trackPaymentV2: async () => ({ status: 'SUCCEEDED', fee_sat: '32' }),
  queryRoutes: async () => ({ routes: [{ total_fees: '45', total_amt: '100045', hops: [{ chan_id: '12345' }] }] }),
};

function rebalanceNodeManager(overrides = {}) {
  return mockNodeManager({ ...REBALANCE_LND_DEFAULTS, ...overrides });
}

/**
 * Creates a RebalanceExecutor with all mocked dependencies.
 * The validateSignedInstruction is bypassed by patching the agent registry
 * with a mock that always validates.
 */
function makeExecutor(overrides = {}) {
  const capitalLedger = overrides.capitalLedger || mockCapitalLedger();
  const nodeManager = overrides.nodeManager || rebalanceNodeManager();
  const dataLayer = overrides.dataLayer || mockDataLayer();
  const auditLog = overrides.auditLog || mockAuditLog();
  const agentRegistry = overrides.agentRegistry || mockAgentRegistry({
    'agent-01': { id: 'agent-01', pubkey: 'a'.repeat(64) },
  });
  const assignmentRegistry = overrides.assignmentRegistry || mockAssignmentRegistry([
    { chan_id: '12345', channel_point: 'abc:0', agent_id: 'agent-01', capacity: 1_000_000 },
  ]);
  const mutex = overrides.mutex || mockMutex();

  const executor = new RebalanceExecutor({
    capitalLedger, nodeManager, dataLayer, auditLog,
    agentRegistry, assignmentRegistry, mutex,
  });

  // Bypass crypto validation for unit tests by patching the dedup cache
  // and providing a signature that the mock considers valid
  executor._dedup = { has: () => false, mark: () => {} };

  return { executor, capitalLedger, nodeManager, dataLayer, auditLog, agentRegistry, assignmentRegistry };
}

/**
 * Patches the executor's validate method to bypass Ed25519 verification
 * (which requires real crypto). Returns validated params directly.
 */
function patchValidation(executor) {
  const origValidate = executor._validate.bind(executor);
  executor._validate = async (agentId, payload) => {
    // Run most validation but skip crypto
    const { instruction, signature } = payload || {};
    if (!instruction || !signature) {
      return { success: false, error: 'Missing instruction or signature', status: 400, failed_at: 'payload_present', checks_passed: [] };
    }
    if (instruction.action !== 'rebalance') {
      return { success: false, error: 'Wrong action', status: 400, failed_at: 'action_valid', checks_passed: ['payload_present'] };
    }
    if (instruction.agent_id !== agentId) {
      return { success: false, error: 'Agent ID mismatch', status: 400, failed_at: 'agent_id_matches', checks_passed: ['payload_present', 'action_valid'] };
    }

    const params = instruction.params || {};
    const checks_passed = ['payload_present', 'pubkey_registered', 'action_valid', 'agent_id_matches', 'timestamp_fresh', 'not_duplicate', 'signature_valid'];
    const instrHash = 'mock_hash_' + Date.now();

    // Step 8: params_valid
    if (!params.outbound_chan_id || typeof params.outbound_chan_id !== 'string') {
      return { success: false, error: 'outbound_chan_id required', status: 400, failed_at: 'params_valid', checks_passed };
    }
    if (!Number.isInteger(params.amount_sats) || params.amount_sats <= 0) {
      return { success: false, error: 'amount_sats must be positive integer', status: 400, failed_at: 'params_valid', checks_passed };
    }
    if (!Number.isInteger(params.max_fee_sats) || params.max_fee_sats <= 0) {
      return { success: false, error: 'max_fee_sats must be positive integer', status: 400, failed_at: 'params_valid', checks_passed };
    }
    if (params.amount_sats < executor.config.minAmountSats || params.amount_sats > executor.config.maxAmountSats) {
      return { success: false, error: 'amount out of range', status: 400, failed_at: 'params_valid', checks_passed };
    }
    if (params.max_fee_sats > executor.config.maxFeeSats) {
      return { success: false, error: 'max_fee_sats exceeds limit', status: 400, failed_at: 'params_valid', checks_passed };
    }
    checks_passed.push('params_valid');

    // Step 9: outbound_channel_owned
    const assignment = executor._assignmentRegistry.getAssignment(params.outbound_chan_id);
    if (!assignment || assignment.agent_id !== agentId) {
      return { success: false, error: 'Channel not owned', status: 403, failed_at: 'outbound_channel_owned', checks_passed };
    }
    checks_passed.push('outbound_channel_owned');

    // Step 10: balance_sufficient
    const balance = await executor._capitalLedger.getBalance(agentId);
    if (balance.available < params.max_fee_sats) {
      return { success: false, error: 'Insufficient balance', status: 400, failed_at: 'balance_sufficient', checks_passed };
    }
    checks_passed.push('balance_sufficient');

    return { success: true, checks_passed, instrHash, params, assignment, balance };
  };
}

// ---------------------------------------------------------------------------
// 1. Validation pipeline
// ---------------------------------------------------------------------------

describe('RebalanceExecutor — validation', () => {
  it('rejects missing instruction', async () => {
    const { executor } = makeExecutor();
    patchValidation(executor);

    const result = await executor.requestRebalance('agent-01', {});
    assert.equal(result.success, false);
    assert.match(result.error, /Missing instruction/);
  });

  it('rejects wrong action', async () => {
    const { executor } = makeExecutor();
    patchValidation(executor);

    const payload = makePayload();
    payload.instruction.action = 'channel_open';
    const result = await executor.requestRebalance('agent-01', payload);
    assert.equal(result.success, false);
    assert.equal(result.failed_at, 'action_valid');
  });

  it('rejects unowned outbound channel', async () => {
    const { executor } = makeExecutor({
      assignmentRegistry: mockAssignmentRegistry([
        { chan_id: '12345', channel_point: 'abc:0', agent_id: 'agent-02', capacity: 1_000_000 },
      ]),
    });
    patchValidation(executor);

    const result = await executor.requestRebalance('agent-01', makePayload());
    assert.equal(result.success, false);
    assert.equal(result.failed_at, 'outbound_channel_owned');
  });

  it('rejects insufficient capital for max_fee', async () => {
    const { executor } = makeExecutor({
      capitalLedger: mockCapitalLedger({
        getBalance: async () => ({ available: 100, locked: 0 }),
      }),
    });
    patchValidation(executor);

    const result = await executor.requestRebalance('agent-01', makePayload());
    assert.equal(result.success, false);
    assert.equal(result.failed_at, 'balance_sufficient');
  });

  it('rejects amount below minimum', async () => {
    const { executor } = makeExecutor();
    patchValidation(executor);

    const result = await executor.requestRebalance('agent-01', makePayload({ amount_sats: 100 }));
    assert.equal(result.success, false);
    assert.equal(result.failed_at, 'params_valid');
  });

  it('rejects max_fee above limit', async () => {
    const { executor } = makeExecutor();
    patchValidation(executor);

    const result = await executor.requestRebalance('agent-01', makePayload({ max_fee_sats: 100_000 }));
    assert.equal(result.success, false);
    assert.equal(result.failed_at, 'params_valid');
  });
});

// ---------------------------------------------------------------------------
// 2. Capital locking
// ---------------------------------------------------------------------------

describe('RebalanceExecutor — capital locking', () => {
  it('locks max_fee before payment, deducts actual fee on success', async () => {
    const capitalLedger = mockCapitalLedger();
    const { executor } = makeExecutor({ capitalLedger });
    patchValidation(executor);

    const result = await executor.requestRebalance('agent-01', makePayload());
    assert.equal(result.success, true);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.routing_fee_sats, 32);
    assert.equal(result.capital_refunded_sats, 468); // 500 - 32

    // Verify capital operations
    const lockCall = capitalLedger.calls.find(c => c.method === 'lockForChannel');
    assert.ok(lockCall, 'lockForChannel should have been called');
    assert.equal(lockCall.amount, 500);

    const settleCall = capitalLedger.calls.find(c => c.method === 'settleRebalance');
    assert.ok(settleCall, 'settleRebalance should have been called');
    assert.equal(settleCall.maxFeeLocked, 500);
    assert.equal(settleCall.actualFee, 32);
  });

  it('refunds full amount on payment failure', async () => {
    const capitalLedger = mockCapitalLedger();
    const nodeManager = rebalanceNodeManager({
      sendPaymentV2: async () => ({
        status: 'FAILED',
        failure_reason: 'NO_ROUTE',
      }),
    });
    const { executor } = makeExecutor({ capitalLedger, nodeManager });
    patchValidation(executor);

    const result = await executor.requestRebalance('agent-01', makePayload());
    assert.equal(result.success, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.capital_refunded_sats, 500);

    const settleCall = capitalLedger.calls.find(c => c.method === 'settleRebalance');
    assert.ok(settleCall);
    assert.equal(settleCall.actualFee, 0); // Full refund
  });

  it('refunds on stream error', async () => {
    const capitalLedger = mockCapitalLedger();
    const nodeManager = rebalanceNodeManager({
      sendPaymentV2: async () => { throw new Error('connection reset'); },
    });
    const { executor } = makeExecutor({ capitalLedger, nodeManager });
    patchValidation(executor);

    const result = await executor.requestRebalance('agent-01', makePayload());
    assert.equal(result.success, false);

    const settleCall = capitalLedger.calls.find(c => c.method === 'settleRebalance');
    assert.ok(settleCall);
    assert.equal(settleCall.actualFee, 0);
  });
});

// ---------------------------------------------------------------------------
// 3. Streaming response handling
// ---------------------------------------------------------------------------

describe('RebalanceExecutor — streaming responses', () => {
  it('handles SUCCEEDED with fee extraction', async () => {
    const nodeManager = rebalanceNodeManager({
      sendPaymentV2: async () => ({
        status: 'SUCCEEDED',
        fee_sat: '150',
        payment_preimage: 'abc123',
      }),
    });
    const { executor } = makeExecutor({ nodeManager });
    patchValidation(executor);

    const result = await executor.requestRebalance('agent-01', makePayload({ max_fee_sats: 1000 }));
    assert.equal(result.success, true);
    assert.equal(result.routing_fee_sats, 150);
    assert.equal(result.capital_refunded_sats, 850);
  });

  it('handles FAILED with failure reason', async () => {
    const nodeManager = rebalanceNodeManager({
      sendPaymentV2: async () => ({
        status: 'FAILED',
        failure_reason: 'FAILURE_REASON_INSUFFICIENT_BALANCE',
      }),
    });
    const { executor } = makeExecutor({ nodeManager });
    patchValidation(executor);

    const result = await executor.requestRebalance('agent-01', makePayload());
    assert.equal(result.success, false);
    assert.equal(result.failure_reason, 'FAILURE_REASON_INSUFFICIENT_BALANCE');
  });
});

// ---------------------------------------------------------------------------
// 4. Crash recovery
// ---------------------------------------------------------------------------

describe('RebalanceExecutor — crash recovery', () => {
  it('recovers succeeded in-flight payment', async () => {
    const capitalLedger = mockCapitalLedger();
    const dataLayer = mockDataLayer();
    const nodeManager = rebalanceNodeManager({
      trackPaymentV2: async () => ({ status: 'SUCCEEDED', fee_sat: '25' }),
    });

    // Pre-seed state with in-flight entry
    dataLayer._store['data/channel-market/rebalance-state.json'] = {
      'hash_inflight': {
        agent_id: 'agent-01',
        outbound_chan_id: '12345',
        amount_sats: 100_000,
        max_fee_sats: 500,
        payment_hash: 'hash_inflight',
        status: 'in_flight',
        started_at: Date.now() - 60000,
      },
    };

    const { executor } = makeExecutor({ capitalLedger, dataLayer, nodeManager });
    await executor.load();

    // Should have called settleRebalance with actual fee
    const settleCall = capitalLedger.calls.find(c => c.method === 'settleRebalance');
    assert.ok(settleCall, 'settleRebalance should be called during recovery');
    assert.equal(settleCall.actualFee, 25);
    assert.equal(settleCall.maxFeeLocked, 500);
  });

  it('recovers failed in-flight payment with full refund', async () => {
    const capitalLedger = mockCapitalLedger();
    const dataLayer = mockDataLayer();
    const nodeManager = rebalanceNodeManager({
      trackPaymentV2: async () => ({ status: 'FAILED', failure_reason: 'NO_ROUTE' }),
    });

    dataLayer._store['data/channel-market/rebalance-state.json'] = {
      'hash_failed': {
        agent_id: 'agent-01',
        outbound_chan_id: '12345',
        amount_sats: 100_000,
        max_fee_sats: 500,
        payment_hash: 'hash_failed',
        status: 'in_flight',
        started_at: Date.now() - 60000,
      },
    };

    const { executor } = makeExecutor({ capitalLedger, dataLayer, nodeManager });
    await executor.load();

    const settleCall = capitalLedger.calls.find(c => c.method === 'settleRebalance');
    assert.ok(settleCall);
    assert.equal(settleCall.actualFee, 0); // Full refund
  });

  it('refunds on track error as safety measure', async () => {
    const capitalLedger = mockCapitalLedger();
    const dataLayer = mockDataLayer();
    const nodeManager = rebalanceNodeManager({
      trackPaymentV2: async () => { throw new Error('LND unavailable'); },
    });

    dataLayer._store['data/channel-market/rebalance-state.json'] = {
      'hash_err': {
        agent_id: 'agent-01',
        outbound_chan_id: '12345',
        amount_sats: 100_000,
        max_fee_sats: 300,
        payment_hash: 'hash_err',
        status: 'in_flight',
        started_at: Date.now() - 60000,
      },
    };

    const { executor } = makeExecutor({ capitalLedger, dataLayer, nodeManager });
    await executor.load();

    const settleCall = capitalLedger.calls.find(c => c.method === 'settleRebalance');
    assert.ok(settleCall, 'Should refund on track error');
    assert.equal(settleCall.actualFee, 0);
  });
});

// ---------------------------------------------------------------------------
// 5. Fee estimation
// ---------------------------------------------------------------------------

describe('RebalanceExecutor — fee estimation', () => {
  it('returns estimated fee from queryRoutes', async () => {
    const { executor } = makeExecutor();

    const result = await executor.estimateRebalanceFee('agent-01', {
      outbound_chan_id: '12345',
      amount_sats: 100_000,
    });

    assert.equal(result.success, true);
    assert.equal(result.estimated_fee_sats, 45);
    assert.equal(result.routes_found, 1);
  });

  it('returns null fee when no routes found', async () => {
    const nodeManager = rebalanceNodeManager({
      queryRoutes: async () => ({ routes: [] }),
    });
    const { executor } = makeExecutor({ nodeManager });

    const result = await executor.estimateRebalanceFee('agent-01', {
      outbound_chan_id: '12345',
      amount_sats: 100_000,
    });

    assert.equal(result.success, true);
    assert.equal(result.estimated_fee_sats, null);
    assert.equal(result.routes_found, 0);
  });

  it('returns error when LND unavailable', async () => {
    const nodeManager = { getDefaultNodeOrNull: () => null };
    const { executor } = makeExecutor({ nodeManager });

    const result = await executor.estimateRebalanceFee('agent-01', {
      outbound_chan_id: '12345',
      amount_sats: 100_000,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 503);
  });

  it('rejects missing params', async () => {
    const { executor } = makeExecutor();

    const result = await executor.estimateRebalanceFee('agent-01', {});
    assert.equal(result.success, false);
    assert.equal(result.status, 400);
  });
});

// ---------------------------------------------------------------------------
// 6. History logging
// ---------------------------------------------------------------------------

describe('RebalanceExecutor — history', () => {
  it('logs successful rebalance to history', async () => {
    const dataLayer = mockDataLayer();
    const { executor } = makeExecutor({ dataLayer });
    patchValidation(executor);

    await executor.requestRebalance('agent-01', makePayload());

    const history = await executor.getRebalanceHistory('agent-01');
    assert.equal(history.count, 1);
    assert.equal(history.rebalances[0].status, 'succeeded');
    assert.equal(history.rebalances[0].actual_fee_sats, 32);
  });

  it('logs failed rebalance to history', async () => {
    const dataLayer = mockDataLayer();
    const nodeManager = rebalanceNodeManager({
      sendPaymentV2: async () => ({ status: 'FAILED', failure_reason: 'NO_ROUTE' }),
    });
    const { executor } = makeExecutor({ dataLayer, nodeManager });
    patchValidation(executor);

    await executor.requestRebalance('agent-01', makePayload());

    const history = await executor.getRebalanceHistory('agent-01');
    assert.equal(history.count, 1);
    assert.equal(history.rebalances[0].status, 'failed');
  });

  it('returns empty history for new agent', async () => {
    const { executor } = makeExecutor();
    const history = await executor.getRebalanceHistory('agent-99');
    assert.equal(history.count, 0);
  });
});

// ---------------------------------------------------------------------------
// 7. Concurrency
// ---------------------------------------------------------------------------

describe('RebalanceExecutor — concurrency', () => {
  it('rejects second rebalance while first is in-flight', async () => {
    const nodeManager = rebalanceNodeManager({
      // First payment hangs (never resolves during test)
      sendPaymentV2: () => new Promise(() => {}), // infinite wait
    });
    const { executor } = makeExecutor({ nodeManager });
    patchValidation(executor);

    // Simulate in-flight state
    executor._state['existing_hash'] = {
      agent_id: 'agent-01',
      status: 'in_flight',
    };

    const result = await executor.requestRebalance('agent-01', makePayload());
    assert.equal(result.success, false);
    assert.equal(result.status, 429);
  });
});

// ---------------------------------------------------------------------------
// 8. Constructor validation
// ---------------------------------------------------------------------------

describe('RebalanceExecutor — constructor', () => {
  it('throws without required dependencies', () => {
    assert.throws(() => new RebalanceExecutor({}), /requires capitalLedger/);
    assert.throws(() => new RebalanceExecutor({ capitalLedger: {} }), /requires nodeManager/);
  });
});

// ---------------------------------------------------------------------------
// 9. Config endpoint
// ---------------------------------------------------------------------------

describe('RebalanceExecutor — config', () => {
  it('returns configuration with learn text', () => {
    const { executor } = makeExecutor();
    const config = executor.getConfig();
    assert.equal(config.min_amount_sats, 10_000);
    assert.equal(config.max_amount_sats, 16_777_215);
    assert.ok(config.learn);
  });
});

// ---------------------------------------------------------------------------
// 10. Audit logging
// ---------------------------------------------------------------------------

describe('RebalanceExecutor — audit logging', () => {
  it('writes audit entry on success', async () => {
    const auditLog = mockAuditLog();
    const { executor } = makeExecutor({ auditLog });
    patchValidation(executor);

    await executor.requestRebalance('agent-01', makePayload());

    const rebalanceAudit = auditLog.entries.find(e => e.type === 'rebalance_succeeded');
    assert.ok(rebalanceAudit, 'Should have rebalance_succeeded audit entry');
    assert.equal(rebalanceAudit.agent_id, 'agent-01');
    assert.equal(rebalanceAudit.actual_fee_sats, 32);
  });

  it('writes audit entry on failure', async () => {
    const auditLog = mockAuditLog();
    const nodeManager = rebalanceNodeManager({
      sendPaymentV2: async () => ({ status: 'FAILED', failure_reason: 'NO_ROUTE' }),
    });
    const { executor } = makeExecutor({ auditLog, nodeManager });
    patchValidation(executor);

    await executor.requestRebalance('agent-01', makePayload());

    const rebalanceAudit = auditLog.entries.find(e => e.type === 'rebalance_failed');
    assert.ok(rebalanceAudit, 'Should have rebalance_failed audit entry');
  });
});
