import assert from 'node:assert/strict';
import test from 'node:test';

import { SignedInstructionExecutor } from '../../src/channel-accountability/signed-instruction-executor.js';
import { signInstruction, generateTestKeypair } from '../../src/channel-accountability/test-crypto-helpers.js';
import { ChannelCloser } from '../../src/channel-market/channel-closer.js';
import { ChannelOpener } from '../../src/channel-market/channel-opener.js';
import { RebalanceExecutor } from '../../src/channel-market/rebalance-executor.js';
import {
  mockAgentRegistry,
  mockAssignmentRegistry,
  mockAuditLog,
  mockCapitalLedger,
  mockDataLayer,
  mockMutex,
  mockNodeManager,
} from '../../src/channel-market/test-mock-factories.js';
import { getAgentSurfaceManifest } from '../../src/monitor/agent-surface-inventory.js';
import { createRouteTestHarness } from './route-test-harness.mjs';

function makeNodeManager(overrides = {}) {
  const manager = mockNodeManager(overrides);
  return {
    ...manager,
    getScopedDefaultNodeOrNull: () => manager._client,
    getScopedDefaultNode: () => manager._client,
    getNodeNames: () => ['stub'],
  };
}

function renderTable(rows) {
  const headers = ['Route', 'Status', 'Failed At', 'Error'];
  const tableRows = rows.map((row) => [
    row.key,
    String(row.status),
    row.failed_at || '',
    row.error || '',
  ]);
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...tableRows.map((row) => row[index].length),
  ));
  const format = (row) => row.map((cell, index) => cell.padEnd(widths[index])).join(' | ');
  return [
    format(headers),
    widths.map((width) => '-'.repeat(width)).join('-|-'),
    ...tableRows.map(format),
  ].join('\n');
}

function buildSignedInstruction(action, agentId, privateKey, params = {}, extra = {}) {
  const instruction = {
    action,
    agent_id: agentId,
    timestamp: Math.floor(Date.now() / 1000),
    params,
    ...extra,
  };
  return {
    instruction,
    signature: signInstruction(instruction, privateKey),
  };
}

function createServiceFixtures() {
  const owner = generateTestKeypair();
  const other = generateTestKeypair();
  const dataLayer = mockDataLayer();
  const auditLog = mockAuditLog();
  const mutex = mockMutex();
  const assignmentRegistry = mockAssignmentRegistry([
    {
      chan_id: 'chan-foreign',
      channel_point: 'fundtxforeign:0',
      agent_id: 'test0002',
      remote_pubkey: `03${'2'.repeat(64)}`,
      capacity: 100_000,
      constraints: {},
      assigned_at: Date.now(),
    },
  ]);
  const agentRegistry = mockAgentRegistry({
    test0001: { id: 'test0001', pubkey: owner.pubHex },
    test0002: { id: 'test0002', pubkey: other.pubHex },
  });
  const capitalLedger = mockCapitalLedger({
    getBalance: async () => ({ available: 1_000_000, locked: 0, pending_close: 0 }),
  });
  const nodeManager = makeNodeManager();

  const opener = new ChannelOpener({
    capitalLedger,
    nodeManager,
    dataLayer,
    auditLog,
    agentRegistry,
    assignmentRegistry,
    mutex,
    config: {
      minChannelSizeSats: 1,
      maxChannelSizeSats: 1_000_000,
      maxTotalChannels: 10,
      maxPerAgent: 10,
      pendingOpenTimeoutBlocks: 6,
      connectPeerTimeoutMs: 15_000,
      peerSafety: {
        requireAllowlist: false,
        forceCloseLimit: 10,
        minPeerChannels: 0,
        maxPeerLastUpdateAgeSeconds: 31_536_000,
      },
      startupPolicyLimits: {
        minBaseFeeMsat: 0,
        maxBaseFeeMsat: 10_000,
        minFeeRatePpm: 0,
        maxFeeRatePpm: 10_000,
        minTimeLockDelta: 1,
        maxTimeLockDelta: 500,
      },
    },
  });

  const closer = new ChannelCloser({
    capitalLedger,
    nodeManager,
    dataLayer,
    auditLog,
    agentRegistry,
    assignmentRegistry,
    mutex,
    config: {
      cooperativeTimeoutMs: 60_000,
      pollIntervalMs: 15_000,
    },
  });

  const rebalancer = new RebalanceExecutor({
    capitalLedger,
    nodeManager,
    dataLayer,
    auditLog,
    agentRegistry,
    assignmentRegistry,
    mutex,
    config: {
      minAmountSats: 1,
      maxAmountSats: 1_000_000,
      maxFeeSats: 100_000,
      paymentTimeoutSeconds: 60,
      maxConcurrentPerAgent: 3,
    },
  });

  const channelExecutor = new SignedInstructionExecutor({
    assignmentRegistry,
    auditLog,
    nodeManager,
    agentRegistry,
    dataLayer,
    safetySettings: {
      signedChannels: {
        defaultCooldownMinutes: 1,
      },
    },
  });

  return {
    owner,
    opener,
    closer,
    rebalancer,
    channelExecutor,
  };
}

test('foreign owned write routes reject a valid request from the wrong agent', async () => {
  const fixtures = createServiceFixtures();
  const { owner, closer, rebalancer, channelExecutor } = fixtures;
  const agentId = 'test0001';

  const failures = [];
  const cases = [
    {
      key: 'POST /api/v1/channels/preview',
      run: () => channelExecutor.preview(agentId, buildSignedInstruction(
        'set_fee_policy',
        agentId,
        owner.privateKey,
        { base_fee_msat: 0, fee_rate_ppm: 100 },
        { channel_id: 'chan-foreign' },
      )),
      expectStatus: 403,
      expectFailedAt: 'channel_owned',
    },
    {
      key: 'POST /api/v1/channels/instruct',
      run: () => channelExecutor.execute(agentId, buildSignedInstruction(
        'set_fee_policy',
        agentId,
        owner.privateKey,
        { base_fee_msat: 0, fee_rate_ppm: 100 },
        { channel_id: 'chan-foreign' },
      )),
      expectStatus: 403,
      expectFailedAt: 'channel_owned',
    },
    {
      key: 'POST /api/v1/market/close',
      run: () => closer.requestClose(agentId, buildSignedInstruction(
        'channel_close',
        agentId,
        owner.privateKey,
        { channel_point: 'fundtxforeign:0' },
      )),
      expectStatus: 403,
      expectFailedAt: 'channel_ownership',
    },
    {
      key: 'POST /api/v1/market/rebalance',
      run: () => rebalancer.validateRequest(agentId, buildSignedInstruction(
        'rebalance',
        agentId,
        owner.privateKey,
        { outbound_chan_id: 'chan-foreign', amount_sats: 1_000, max_fee_sats: 10 },
      )),
      expectStatus: 403,
      expectFailedAt: 'outbound_channel_owned',
    },
  ];

  for (const item of cases) {
    const result = await item.run();
    if (result?.success !== false || result?.status !== item.expectStatus || result?.failed_at !== item.expectFailedAt) {
      failures.push({
        key: item.key,
        status: result?.status,
        failed_at: result?.failed_at,
        error: result?.error,
      });
    }
  }

  assert.deepEqual(
    failures,
    [],
    failures.length ? `Wrong-owner write routes did not fail cleanly:\n${renderTable(failures)}` : undefined,
  );
});

test('foreign owned status routes stay hidden from the wrong agent', async () => {
  const manifest = getAgentSurfaceManifest();
  const expectedKeys = [
    'GET /api/v1/market/revenue/:chanId',
    'GET /api/v1/market/swap/status/:swapId',
    'GET /api/v1/market/fund-from-ecash/:flowId',
    'GET /api/v1/market/performance/:chanId',
  ];
  for (const key of expectedKeys) {
    const route = manifest.route_lookup?.[key];
    assert.ok(route, `missing manifest route for ${key}`);
    assert.equal(route.security?.requires_ownership, true, `${key} lost ownership protection in the manifest`);
  }

  const harness = await createRouteTestHarness({
    daemonOverrides: {
      channelAssignments: {
        getAssignment: () => ({ agent_id: 'test0002', channel_point: 'fundtxforeign:0' }),
        getByAgent: () => [],
      },
      revenueTracker: {
        getChannelRevenue: () => ({ total_fees_sats: 0 }),
      },
      swapProvider: {
        getSwapStatus: () => ({ swap_id: 'swap-foreign', agent_id: 'test0002' }),
        getSwapHistory: () => [],
      },
      ecashChannelFunder: {
        getFlowStatus: () => ({ flow_id: 'flow-foreign', agent_id: 'test0002' }),
        getPendingForAgent: () => [],
      },
      performanceTracker: {
        getChannelPerformance: async (_chanId, agentId) => (
          agentId === 'test0002'
            ? { chan_id: 'chan-foreign' }
            : { success: false, error: 'Channel not found', status: 404 }
        ),
        getAgentPerformance: async () => ({ channels: [] }),
        getLeaderboard: () => ({ entries: [] }),
      },
    },
  });

  try {
    const authHeaders = {
      Authorization: `Bearer ${harness.agents.primary.api_key}`,
      Accept: 'application/json',
    };
    const failures = [];
    const cases = [
      { key: 'GET /api/v1/market/revenue/:chanId', path: '/api/v1/market/revenue/chan-foreign' },
      { key: 'GET /api/v1/market/swap/status/:swapId', path: '/api/v1/market/swap/status/swap-foreign' },
      { key: 'GET /api/v1/market/fund-from-ecash/:flowId', path: '/api/v1/market/fund-from-ecash/flow-foreign' },
      { key: 'GET /api/v1/market/performance/:chanId', path: '/api/v1/market/performance/chan-foreign' },
    ];

    for (const item of cases) {
      const response = await harness.fetch(item.path, { headers: authHeaders });
      if (response.status !== 404) {
        const text = await response.text();
        failures.push({
          key: item.key,
          status: response.status,
          failed_at: '',
          error: text.slice(0, 120),
        });
      }
    }

    assert.deepEqual(
      failures,
      [],
      failures.length ? `Foreign status routes leaked to the wrong agent:\n${renderTable(failures)}` : undefined,
    );
  } finally {
    await harness.close();
  }
});
