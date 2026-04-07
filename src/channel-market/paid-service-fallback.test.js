import test from 'node:test';
import assert from 'node:assert/strict';

import { AnalyticsGateway } from './analytics-gateway.js';
import { HelpEndpoint } from './help-endpoint.js';
import { mockCapitalLedger, mockDataLayer, mockWalletOps } from './test-mock-factories.js';

test('analytics gateway falls back to capital when wallet balance is too low', async () => {
  const walletOps = mockWalletOps({ balance: 0 });
  const capitalLedger = mockCapitalLedger({
    getBalance: async () => ({ available: 100, locked: 0, pending_deposit: 0, pending_close: 0, total_service_spent: 0 }),
  });

  const gateway = new AnalyticsGateway({
    walletOps,
    capitalLedger,
    dataLayer: mockDataLayer(),
    ledger: { record: async () => {} },
  });
  gateway._spawnQuery = async () => ({ ok: true });
  gateway._logQuery = async () => {};

  const result = await gateway.execute('agent-paid', 'network_stats', {});

  assert.equal(result.payment_source, 'capital');
  assert.equal(capitalLedger.serviceSpends.length, 1);
  assert.equal(capitalLedger.serviceSpends[0].amount, 1);
  assert.equal(walletOps.sendCalls.length, 0);
});

test('analytics gateway returns live fallback results when backend is unavailable', async () => {
  const walletOps = mockWalletOps({ balance: 10 });
  const gateway = new AnalyticsGateway({
    walletOps,
    capitalLedger: mockCapitalLedger(),
    dataLayer: mockDataLayer(),
    ledger: { record: async () => {} },
    nodeManager: {
      getScopedDefaultNodeOrNull: () => ({
        getInfo: async () => ({
          alias: 'boom',
          identity_pubkey: '02'.padEnd(66, '1'),
          num_active_channels: '2',
          num_peers: '3',
          synced_to_chain: true,
        }),
        getNetworkInfo: async () => ({
          num_nodes: '100',
          num_channels: '200',
          total_network_capacity: '300000',
        }),
        feeReport: async () => ({
          channel_fees: [{ fee_per_mil: '10' }, { fee_per_mil: '30' }],
        }),
      }),
    },
  });
  gateway._spawnQuery = async () => {
    throw new Error('Python3 not found. Analytics service unavailable.');
  };
  gateway._logQuery = async () => {};

  const result = await gateway.execute('agent-paid', 'network_stats', {});

  assert.equal(result.payment_source, 'wallet');
  assert.equal(result.results.source, 'live_lnd_fallback');
  assert.equal(result.results.network.total_nodes_seen, 100);
});

test('help endpoint falls back to capital when wallet balance is too low', async () => {
  const walletOps = mockWalletOps({ balance: 0 });
  const capitalLedger = mockCapitalLedger({
    getBalance: async () => ({ available: 100, locked: 0, pending_deposit: 0, pending_close: 0, total_service_spent: 0 }),
  });

  const help = new HelpEndpoint({
    agentRegistry: { getById: () => ({ id: 'agent-help', name: 'Help Agent', tier: 'free', registered_at: Date.now() }) },
    assignmentRegistry: { getByAgent: () => [], getAssignment: () => null },
    auditLog: { readAll: async () => [], readByChannel: async () => [] },
    capitalLedger,
    performanceTracker: null,
    marketTransparency: null,
    walletOps,
    dataLayer: mockDataLayer(),
    config: {
      rateLimit: 10,
      rateWindowMs: 60_000,
      upstreamTimeoutMs: 5_000,
      circuitFailureLimit: 3,
      circuitFailureWindowMs: 60_000,
      circuitOpenMs: 60_000,
    },
  });
  help._systemPrompt = 'test';
  help._anthropic = {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: 'Fund capital first, then build and sign the open instruction.' }],
      }),
    },
  };

  const result = await help.ask('agent-help', 'How do I open a channel?', {});

  assert.equal(result.payment_source, 'capital');
  assert.equal(capitalLedger.serviceSpends.length, 1);
  assert.equal(capitalLedger.serviceSpends[0].service, 'help');
  assert.equal(walletOps.sendCalls.length, 0);
});

test('help endpoint returns local fallback guidance when upstream model fails', async () => {
  const walletOps = mockWalletOps({ balance: 10 });
  const help = new HelpEndpoint({
    agentRegistry: { getById: () => ({ id: 'agent-help', name: 'Help Agent', tier: 'free', registered_at: Date.now() }) },
    assignmentRegistry: { getByAgent: () => [], getAssignment: () => null },
    auditLog: { readAll: async () => [], readByChannel: async () => [] },
    capitalLedger: mockCapitalLedger(),
    performanceTracker: null,
    marketTransparency: null,
    walletOps,
    dataLayer: mockDataLayer(),
    config: {
      rateLimit: 10,
      rateWindowMs: 60_000,
      upstreamTimeoutMs: 5_000,
      circuitFailureLimit: 3,
      circuitFailureWindowMs: 60_000,
      circuitOpenMs: 60_000,
    },
  });
  help._systemPrompt = 'test';
  process.env.ANTHROPIC_API_KEY = 'test-key';
  help._anthropic = {
    messages: {
      create: async () => {
        throw new Error('401 invalid x-api-key');
      },
    },
  };

  const result = await help.ask('agent-help', 'How do I fund capital?', {});

  assert.match(result.answer, /capital/i);
  assert.match(result.learn, /3 confirmations/i);
  assert.equal(result.payment_source, 'wallet');
});
