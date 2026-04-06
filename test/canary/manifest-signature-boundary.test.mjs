import assert from 'node:assert/strict';
import test from 'node:test';

import { SignedInstructionExecutor } from '../../src/channel-accountability/signed-instruction-executor.js';
import { generateTestKeypair } from '../../src/channel-accountability/test-crypto-helpers.js';
import { ChannelCloser } from '../../src/channel-market/channel-closer.js';
import { EcashChannelFunder } from '../../src/channel-market/ecash-channel-funder.js';
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
  mockWalletOps,
} from '../../src/channel-market/test-mock-factories.js';
import { getAgentSurfaceManifest } from '../../src/monitor/agent-surface-inventory.js';

function makeNodeManager(overrides = {}) {
  const manager = mockNodeManager(overrides);
  return {
    ...manager,
    getScopedDefaultNodeOrNull: () => manager._client,
    getScopedDefaultNode: () => manager._client,
    getNodeNames: () => ['stub'],
  };
}

function buildInstruction(action, agentId, params = {}, extra = {}) {
  return {
    action,
    agent_id: agentId,
    timestamp: Math.floor(Date.now() / 1000),
    params,
    ...extra,
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

function createServices() {
  const { privateKey, pubHex } = generateTestKeypair();
  const agentId = 'test0001';
  const dataLayer = mockDataLayer();
  const auditLog = mockAuditLog();
  const mutex = mockMutex();
  const assignmentRegistry = mockAssignmentRegistry([
    {
      chan_id: 'chan-owned',
      channel_point: 'fundtxowned:0',
      agent_id: agentId,
      remote_pubkey: `02${'1'.repeat(64)}`,
      capacity: 100_000,
      constraints: {},
      assigned_at: Date.now(),
    },
  ]);
  const agentRegistry = mockAgentRegistry({
    [agentId]: { id: agentId, pubkey: pubHex },
  });
  const nodeManager = makeNodeManager();
  const capitalLedger = mockCapitalLedger({
    getBalance: async () => ({ available: 1_000_000, locked: 0, pending_close: 0 }),
  });

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

  const walletOps = mockWalletOps({ balance: 500_000 });
  const funder = new EcashChannelFunder({
    walletOps,
    channelOpener: opener,
    capitalLedger,
    dataLayer,
    auditLog,
    mutex,
  });

  return { agentId, privateKey, opener, closer, rebalancer, channelExecutor, funder };
}

test('every signed manifest route rejects a bad secp256k1 signature', async () => {
  const manifest = getAgentSurfaceManifest();
  const signedRoutes = manifest.routes.filter((route) => route.security?.requires_signature);
  const services = createServices();
  const { agentId, opener, closer, rebalancer, channelExecutor, funder } = services;

  const cases = new Map([
    ['POST /api/v1/channels/preview', async () => channelExecutor.preview(agentId, {
      instruction: buildInstruction('set_fee_policy', agentId, { base_fee_msat: 0, fee_rate_ppm: 100 }, { channel_id: 'chan-owned' }),
      signature: '00',
    })],
    ['POST /api/v1/channels/instruct', async () => channelExecutor.execute(agentId, {
      instruction: buildInstruction('set_fee_policy', agentId, { base_fee_msat: 0, fee_rate_ppm: 100 }, { channel_id: 'chan-owned' }),
      signature: '00',
    })],
    ['POST /api/v1/market/preview', async () => opener.preview(agentId, {
      instruction: buildInstruction('channel_open', agentId, {}),
      signature: '00',
    })],
    ['POST /api/v1/market/open', async () => opener.open(agentId, {
      instruction: buildInstruction('channel_open', agentId, {}),
      signature: '00',
    })],
    ['POST /api/v1/market/close', async () => closer.requestClose(agentId, {
      instruction: buildInstruction('channel_close', agentId, { channel_point: 'fundtxowned:0' }),
      signature: '00',
    })],
    ['POST /api/v1/market/rebalance', async () => rebalancer.validateRequest(agentId, {
      instruction: buildInstruction('rebalance', agentId, { outbound_chan_id: 'chan-owned', amount_sats: 1_000, max_fee_sats: 10 }),
      signature: '00',
    })],
    ['POST /api/v1/market/fund-from-ecash', async () => funder.fundChannelFromEcash(agentId, {
      instruction: buildInstruction('channel_open', agentId, { local_funding_amount_sats: 1_000 }),
      signature: '00',
    })],
  ]);

  assert.equal(cases.size, signedRoutes.length, 'signed route test coverage drifted from the manifest');

  const failures = [];
  for (const route of signedRoutes) {
    const run = cases.get(route.key);
    assert.ok(run, `missing bad-signature test case for ${route.key}`);
    const result = await run();
    if (result?.success !== false || result?.status !== 401 || result?.failed_at !== 'signature_valid') {
      failures.push({
        key: route.key,
        status: result?.status,
        failed_at: result?.failed_at,
        error: result?.error,
      });
    }
  }

  assert.deepEqual(
    failures,
    [],
    failures.length ? `Signed routes missing the bad-signature wall:\n${renderTable(failures)}` : undefined,
  );
});
