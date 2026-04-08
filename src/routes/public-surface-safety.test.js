import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizePublicLedgerEntry } from './agent-wallet-routes.js';
import { summarizePublicNetworkHealth } from './agent-analysis-routes.js';
import { summarizePublicChannelStatus } from './channel-accountability-routes.js';

test('sanitizePublicLedgerEntry hides reserved deposit address and flow id', () => {
  const safe = sanitizePublicLedgerEntry({
    type: 'lightning_deposit_failed',
    address: 'bc1p7xmn9qt4nyppuvgesweyl6frruyzdrthv9dkezn4hdyzdje6ka7qra0e83',
    flow_id: '1f1c2b7a-5212-41e5-8094-03efd688b363',
    reference: '1f1c2b7a-5212-41e5-8094-03efd688b363',
    payment_request: 'lnbc1...',
  });

  assert.equal(safe.address, undefined);
  assert.equal(safe.address_hint, '...7qra0e83');
  assert.equal(safe.flow_id, '1f1c2b7a...');
  assert.equal(safe.reference, '1f1c2b7a...');
  assert.equal(safe.payment_request, undefined);
});

test('summarizePublicNetworkHealth omits version and channel balances', () => {
  const summary = summarizePublicNetworkHealth({
    info: {
      identity_pubkey: 'abc',
      alias: 'boom',
      num_active_channels: 2,
      num_inactive_channels: 0,
      num_pending_channels: 1,
      num_peers: 3,
      synced_to_chain: true,
      synced_to_graph: true,
      block_height: 123,
      version: 'secret-version',
    },
    networkInfo: {
      num_nodes: 10,
      num_channels: 20,
      total_network_capacity: '30',
      avg_channel_size: 40,
    },
  });

  assert.equal(summary.node.version, undefined);
  assert.equal(summary.channel_balance, undefined);
  assert.equal(summary.node.block_height, 123);
  assert.equal(summary.network.num_nodes, 10);
});

test('summarizePublicChannelStatus omits poll timing and raw hash', () => {
  const summary = summarizePublicChannelStatus(
    {
      running: true,
      lastPollAt: 123,
      totalPolls: 9,
      violationsDetected: 2,
      lndConnected: true,
      assignedChannels: 4,
      currentBackoffMs: 30000,
    },
    {
      entries: 100,
      lastHash: 'abcdef123456',
      lastTimestamp: 999,
    },
  );

  assert.deepEqual(summary.monitor, {
    running: true,
    violations_detected: 2,
    lnd_connected: true,
    assigned_channels: 4,
  });
  assert.equal(summary.monitor.lastPollAt, undefined);
  assert.equal(summary.chain.has_integrity_anchor, true);
  assert.equal(summary.chain.lastHash, undefined);
});
