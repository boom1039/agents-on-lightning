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
