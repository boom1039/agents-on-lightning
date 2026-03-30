import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelOpener } from './channel-opener.js';
import {
  mockDataLayer,
  mockAuditLog,
  mockMutex,
  mockAgentRegistry,
  mockAssignmentRegistry,
  mockCapitalLedger,
  mockNodeManager,
} from './test-mock-factories.js';
import { generateTestKeypair, signInstruction } from '../channel-accountability/test-crypto-helpers.js';

const PEER_PUBKEY = '02' + 'a'.repeat(64);
const ORIGINAL_ALLOWLIST = process.env.CHANNEL_OPEN_PEER_ALLOWLIST;
const ORIGINAL_REQUIRE_ALLOWLIST = process.env.CHANNEL_OPEN_REQUIRE_PEER_ALLOWLIST;

function makeSignedPayload(privateKey, params = {}) {
  const instruction = {
    action: 'channel_open',
    agent_id: 'agent-01',
    timestamp: Math.floor(Date.now() / 1000),
    params: {
      peer_pubkey: PEER_PUBKEY,
      local_funding_amount_sats: 150_000,
      ...params,
    },
  };
  return {
    instruction,
    signature: signInstruction(instruction, privateKey),
  };
}

function makeOpener({ pubHex, nodeManager } = {}) {
  return new ChannelOpener({
    capitalLedger: mockCapitalLedger(),
    nodeManager,
    dataLayer: mockDataLayer(),
    auditLog: mockAuditLog(),
    agentRegistry: mockAgentRegistry({
      'agent-01': { id: 'agent-01', pubkey: pubHex },
    }),
    assignmentRegistry: mockAssignmentRegistry([]),
    mutex: mockMutex(),
  });
}

function restorePeerSafetyEnv() {
  if (ORIGINAL_ALLOWLIST === undefined) delete process.env.CHANNEL_OPEN_PEER_ALLOWLIST;
  else process.env.CHANNEL_OPEN_PEER_ALLOWLIST = ORIGINAL_ALLOWLIST;

  if (ORIGINAL_REQUIRE_ALLOWLIST === undefined) delete process.env.CHANNEL_OPEN_REQUIRE_PEER_ALLOWLIST;
  else process.env.CHANNEL_OPEN_REQUIRE_PEER_ALLOWLIST = ORIGINAL_REQUIRE_ALLOWLIST;
}

test.afterEach(() => {
  restorePeerSafetyEnv();
});

test('ChannelOpener rejects peers without a public routable address', async () => {
  const { privateKey, pubHex } = generateTestKeypair();
  const opener = makeOpener({
    pubHex,
    nodeManager: mockNodeManager({
      getNodeInfo: async () => ({
        node: {
          alias: 'loopback-peer',
          addresses: [{ addr: '127.0.0.1:9735' }],
        },
      }),
    }),
  });

  const result = await opener._validate('agent-01', makeSignedPayload(privateKey));
  assert.equal(result.success, false);
  assert.equal(result.failed_at, 'peer_safe_for_open');
  assert.equal(result.status, 400);
  assert.match(result.error, /public routable address/i);
});

test('ChannelOpener rejects peers above the force-close safety limit', async () => {
  const { privateKey, pubHex } = generateTestKeypair();
  const opener = makeOpener({
    pubHex,
    nodeManager: mockNodeManager({
      getNodeInfo: async () => ({
        node: {
          alias: 'force-close-peer',
          addresses: [{ addr: '34.117.59.81:9735' }],
        },
      }),
      closedChannels: async () => ({
        channels: [
          { remote_pubkey: PEER_PUBKEY, close_type: 'REMOTE_FORCE_CLOSE' },
        ],
      }),
    }),
  });

  const result = await opener._validate('agent-01', makeSignedPayload(privateKey));
  assert.equal(result.success, false);
  assert.equal(result.failed_at, 'peer_safe_for_open');
  assert.equal(result.status, 403);
  assert.match(result.error, /force-close safety limit/i);
  assert.match(result.hint, /peer-safety/i);
});

test('ChannelOpener fails closed when peer force-close history cannot be checked', async () => {
  const { privateKey, pubHex } = generateTestKeypair();
  const opener = makeOpener({
    pubHex,
    nodeManager: mockNodeManager({
      getNodeInfo: async () => ({
        node: {
          alias: 'history-unavailable-peer',
          addresses: [{ addr: '34.117.59.81:9735' }],
        },
      }),
      closedChannels: async () => {
        throw new Error('lnd unavailable');
      },
    }),
  });

  const result = await opener._validate('agent-01', makeSignedPayload(privateKey));
  assert.equal(result.success, false);
  assert.equal(result.failed_at, 'peer_safe_for_open');
  assert.equal(result.status, 503);
  assert.match(result.error, /history is temporarily unavailable/i);
});

test('ChannelOpener requires an approved peer allowlist for otherwise-valid opens by default', async () => {
  delete process.env.CHANNEL_OPEN_PEER_ALLOWLIST;
  delete process.env.CHANNEL_OPEN_REQUIRE_PEER_ALLOWLIST;
  const { privateKey, pubHex } = generateTestKeypair();
  const opener = makeOpener({
    pubHex,
    nodeManager: mockNodeManager({
      getNodeInfo: async () => ({
        node: {
          alias: 'public-peer',
          addresses: [{ addr: '34.117.59.81:9735' }],
        },
      }),
    }),
  });

  const result = await opener._validate('agent-01', makeSignedPayload(privateKey));
  assert.equal(result.success, false);
  assert.equal(result.failed_at, 'peer_safe_for_open');
  assert.equal(result.status, 503);
  assert.match(result.error, /approved peers are configured/i);
  assert.match(result.hint, /approved peer/i);
});

test('ChannelOpener allows an approved peer when the allowlist contains the peer pubkey', async () => {
  process.env.CHANNEL_OPEN_PEER_ALLOWLIST = PEER_PUBKEY;
  delete process.env.CHANNEL_OPEN_REQUIRE_PEER_ALLOWLIST;
  const { privateKey, pubHex } = generateTestKeypair();
  const opener = makeOpener({
    pubHex,
    nodeManager: mockNodeManager({
      getNodeInfo: async () => ({
        node: {
          alias: 'approved-public-peer',
          addresses: [{ addr: '34.117.59.81:9735' }],
        },
      }),
    }),
  });

  const result = await opener._validate('agent-01', makeSignedPayload(privateKey));
  assert.equal(result.success, true);
  assert.ok(result.checks_passed.includes('peer_safe_for_open'));
});

test('ChannelOpener preview includes requested startup policy', async () => {
  process.env.CHANNEL_OPEN_PEER_ALLOWLIST = PEER_PUBKEY;
  const { privateKey, pubHex } = generateTestKeypair();
  const opener = makeOpener({
    pubHex,
    nodeManager: mockNodeManager({
      getNodeInfo: async () => ({
        node: {
          alias: 'approved-public-peer',
          addresses: [{ addr: '34.117.59.81:9735' }],
        },
      }),
    }),
  });

  const preview = await opener.preview('agent-01', makeSignedPayload(privateKey, {
    base_fee_msat: 1000,
    fee_rate_ppm: 120,
    min_htlc_msat: 1000,
    max_htlc_msat: 50000000,
    time_lock_delta: 40,
  }));

  assert.equal(preview.valid, true);
  assert.deepEqual(preview.would_execute.startup_policy, {
    base_fee_msat: 1000,
    fee_rate_ppm: 120,
    min_htlc_msat: 1000,
    max_htlc_msat: 50000000,
    time_lock_delta: 40,
  });
});

test('ChannelOpener passes open-time startup policy fields into LND openChannel', async () => {
  process.env.CHANNEL_OPEN_PEER_ALLOWLIST = PEER_PUBKEY;
  const { privateKey, pubHex } = generateTestKeypair();
  const openCalls = [];
  const opener = makeOpener({
    pubHex,
    nodeManager: mockNodeManager({
      getNodeInfo: async () => ({
        node: {
          alias: 'approved-public-peer',
          addresses: [{ addr: '34.117.59.81:9735' }],
        },
      }),
      openChannel: async (_pubKey, _amount, _pushSat, opts) => {
        openCalls.push(opts);
        return { funding_txid_str: 'f'.repeat(64), output_index: 0 };
      },
      connectPeer: async () => ({}),
    }),
  });
  await opener.load();

  const result = await opener.open('agent-01', makeSignedPayload(privateKey, {
    base_fee_msat: 1500,
    fee_rate_ppm: 150,
    min_htlc_msat: 2000,
  }));

  assert.equal(result.success, true);
  assert.deepEqual(openCalls[0], {
    private: false,
    satPerVbyte: null,
    baseFeeMsat: 1500,
    feeRatePpm: 150,
    minHtlcMsat: 2000,
  });
});

test('ChannelOpener applies activation-time startup policy after the channel becomes active', async () => {
  process.env.CHANNEL_OPEN_PEER_ALLOWLIST = PEER_PUBKEY;
  const { privateKey, pubHex } = generateTestKeypair();
  const updateCalls = [];
  const nodeManager = mockNodeManager({
    getNodeInfo: async () => ({
      node: {
        alias: 'approved-public-peer',
        addresses: [{ addr: '34.117.59.81:9735' }],
      },
    }),
    openChannel: async () => ({ funding_txid_str: 'e'.repeat(64), output_index: 1 }),
    connectPeer: async () => ({}),
    listChannels: async () => ({
      channels: [{
        chan_id: '12345',
        channel_point: `${'e'.repeat(64)}:1`,
        capacity: '150000',
        active: true,
      }],
    }),
    getBestBlock: async () => ({ block_height: 1000 }),
    feeReport: async () => ({
      channel_fees: [{
        channel_point: `${'e'.repeat(64)}:1`,
        base_fee_msat: '1000',
        fee_per_mil: '1',
        time_lock_delta: 40,
        min_htlc_msat: '1000',
        max_htlc_msat: '150000000',
      }],
    }),
    updateChannelPolicy: async (...args) => {
      updateCalls.push(args);
      return {};
    },
  });
  const opener = makeOpener({ pubHex, nodeManager });
  await opener.load();

  const opened = await opener.open('agent-01', makeSignedPayload(privateKey, {
    base_fee_msat: 2500,
    fee_rate_ppm: 200,
    min_htlc_msat: 3000,
    max_htlc_msat: 90000000,
    time_lock_delta: 80,
  }));
  assert.equal(opened.success, true);

  await opener.pollPendingChannels();

  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0], [
    `${'e'.repeat(64)}:1`,
    2500,
    200,
    80,
    90000000,
    3000,
  ]);
});
