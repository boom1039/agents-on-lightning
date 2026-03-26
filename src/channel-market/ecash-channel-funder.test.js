/**
 * Unit tests for EcashChannelFunder (Plan J).
 *
 * Run: node --test ai_panel/server/channel-market/ecash-channel-funder.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { EcashChannelFunder } from './ecash-channel-funder.js';
import {
  mockDataLayer, mockAuditLog, mockMutex,
  mockWalletOps, mockCapitalLedger, mockChannelOpener,
} from './test-mock-factories.js';

function makeFunder(overrides = {}) {
  const walletOps = overrides.walletOps || mockWalletOps({ balance: 500_000 });
  const channelOpener = overrides.channelOpener || mockChannelOpener();
  const capitalLedger = overrides.capitalLedger || mockCapitalLedger();
  const dataLayer = overrides.dataLayer || mockDataLayer();
  const auditLog = overrides.auditLog || mockAuditLog();
  const mutex = overrides.mutex || mockMutex();

  const funder = new EcashChannelFunder({
    walletOps,
    channelOpener,
    capitalLedger,
    dataLayer,
    auditLog,
    mutex,
  });
  return { funder, walletOps, channelOpener, capitalLedger, dataLayer, auditLog, mutex };
}

function makePayload(amount = 200_000) {
  return {
    instruction: {
      action: 'channel_open',
      params: { local_funding_amount_sats: amount, node_pubkey: '02abcd'.padEnd(66, '0') },
    },
    signature: 'mock-sig',
  };
}

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe('EcashChannelFunder — happy path', () => {
  it('sendEcash → creditEcashFunding → open succeeds → flow complete', async () => {
    const { funder, walletOps, channelOpener, capitalLedger } = makeFunder();
    const result = await funder.fundChannelFromEcash('agent-01', makePayload(200_000));

    assert.equal(result.success, true);
    assert.ok(result.flow_id);
    assert.equal(result.ecash_spent_sats, 200_000);
    assert.ok(result.learn);

    // Verify calls
    assert.equal(walletOps.sendCalls.length, 1);
    assert.equal(walletOps.sendCalls[0].amount, 200_000);
    assert.equal(capitalLedger.ecashCredits.length, 1);
    assert.equal(capitalLedger.ecashCredits[0].amount, 200_000);
    assert.equal(channelOpener.openCalls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 2. Insufficient ecash balance
// ---------------------------------------------------------------------------

describe('EcashChannelFunder — insufficient balance', () => {
  it('returns error when ecash balance is too low, no sendEcash called', async () => {
    const walletOps = mockWalletOps({ balance: 100 });
    const { funder } = makeFunder({ walletOps });
    const result = await funder.fundChannelFromEcash('agent-01', makePayload(200_000));

    assert.equal(result.success, false);
    assert.equal(result.status, 400);
    assert.ok(result.error.includes('Insufficient'));
    assert.equal(walletOps.sendCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 3. sendEcash fails
// ---------------------------------------------------------------------------

describe('EcashChannelFunder — sendEcash failure', () => {
  it('no flow created, no capital credited', async () => {
    const walletOps = mockWalletOps({ balance: 500_000, sendFail: true });
    const capitalLedger = mockCapitalLedger();
    const { funder } = makeFunder({ walletOps, capitalLedger });
    const result = await funder.fundChannelFromEcash('agent-01', makePayload(200_000));

    assert.equal(result.success, false);
    assert.equal(result.status, 402);
    assert.equal(capitalLedger.ecashCredits.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 4. creditEcashFunding fails → receiveEcash refund called
// ---------------------------------------------------------------------------

describe('EcashChannelFunder — credit failure triggers refund', () => {
  it('refunds ecash when capital credit fails', async () => {
    const walletOps = mockWalletOps({ balance: 500_000 });
    const capitalLedger = mockCapitalLedger({
      creditEcashFunding: async () => { throw new Error('credit boom'); },
    });
    const { funder } = makeFunder({ walletOps, capitalLedger });
    const result = await funder.fundChannelFromEcash('agent-01', makePayload(200_000));

    assert.equal(result.success, false);
    assert.equal(result.status, 500);
    assert.ok(result.error.includes('credit boom'));
    // Refund was called
    assert.equal(walletOps.receiveCalls.length, 1);
    assert.equal(walletOps.receiveCalls[0].agentId, 'agent-01');
  });
});

// ---------------------------------------------------------------------------
// 5. Channel open fails → capital in available, no ecash refund
// ---------------------------------------------------------------------------

describe('EcashChannelFunder — open failure', () => {
  it('capital stays in available, no ecash refund on open rejection', async () => {
    const walletOps = mockWalletOps({ balance: 500_000 });
    const channelOpener = mockChannelOpener({ openResult: { success: false, error: 'peer offline', status: 400 } });
    const { funder } = makeFunder({ walletOps, channelOpener });
    const result = await funder.fundChannelFromEcash('agent-01', makePayload(200_000));

    assert.equal(result.success, false);
    assert.ok(result.flow_id);
    assert.equal(result.ecash_spent_sats, 200_000);
    assert.ok(result.learn.includes('capital'));
    // No refund
    assert.equal(walletOps.receiveCalls.length, 0);
  });

  it('handles open() throwing an exception', async () => {
    const channelOpener = mockChannelOpener({ openThrow: true });
    const walletOps = mockWalletOps({ balance: 500_000 });
    const { funder } = makeFunder({ walletOps, channelOpener });
    const result = await funder.fundChannelFromEcash('agent-01', makePayload(200_000));

    assert.equal(result.success, false);
    assert.equal(result.status, 500);
    assert.ok(result.error.includes('Channel open failed'));
    assert.equal(walletOps.receiveCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 6. Concurrent flow blocked by mutex
// ---------------------------------------------------------------------------

describe('EcashChannelFunder — mutex', () => {
  it('serializes concurrent calls for same agent', async () => {
    const order = [];
    const mutex = {
      acquire: async (key) => {
        order.push(`acquire:${key}`);
        return () => order.push(`release:${key}`);
      },
    };
    const { funder } = makeFunder({ mutex });

    await funder.fundChannelFromEcash('agent-01', makePayload());
    assert.ok(order.includes('acquire:ecash-fund:agent-01'));
    assert.ok(order.includes('release:ecash-fund:agent-01'));
  });

  it('mutex released on failure', async () => {
    const released = [];
    const mutex = {
      acquire: async () => () => released.push('released'),
    };
    const walletOps = mockWalletOps({ balance: 0 });
    const { funder } = makeFunder({ mutex, walletOps });

    // This returns early due to balance check (before mutex)
    await funder.fundChannelFromEcash('agent-01', makePayload());
    // Balance check happens before mutex, so no acquire
    assert.equal(released.length, 0);

    // Now test failure after mutex
    const walletOps2 = mockWalletOps({ balance: 500_000, sendFail: true });
    const { funder: funder2 } = makeFunder({ mutex, walletOps: walletOps2 });
    await funder2.fundChannelFromEcash('agent-01', makePayload());
    assert.equal(released.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 7. Flow status queries
// ---------------------------------------------------------------------------

describe('EcashChannelFunder — flow status', () => {
  it('returns flow status after completion', async () => {
    const { funder } = makeFunder();
    const result = await funder.fundChannelFromEcash('agent-01', makePayload());
    const status = funder.getFlowStatus(result.flow_id);

    assert.ok(status);
    assert.equal(status.status, 'complete');
    assert.equal(status.agent_id, 'agent-01');
    assert.equal(status.amount_sats, 200_000);
    assert.equal(status.token, undefined, 'Token should be stripped');
  });

  it('returns null for nonexistent flow', () => {
    const { funder } = makeFunder();
    assert.equal(funder.getFlowStatus('nonexistent'), null);
  });

  it('flow history returns agent flows sorted newest-first', async () => {
    const { funder } = makeFunder();
    await funder.fundChannelFromEcash('agent-01', makePayload(100_000));
    await funder.fundChannelFromEcash('agent-01', makePayload(200_000));
    await funder.fundChannelFromEcash('agent-02', makePayload(300_000));

    const history = funder.getFlowHistory('agent-01');
    assert.equal(history.length, 2);
    assert.ok(history[0].created_at >= history[1].created_at);

    const agent2 = funder.getFlowHistory('agent-02');
    assert.equal(agent2.length, 1);
    assert.equal(agent2[0].amount_sats, 300_000);
  });
});

// ---------------------------------------------------------------------------
// 8. Crash recovery
// ---------------------------------------------------------------------------

describe('EcashChannelFunder — crash recovery', () => {
  it('extracted state → refund on load', async () => {
    const dataLayer = mockDataLayer();
    const walletOps = mockWalletOps({ balance: 500_000 });

    // Simulate a crash: flow persisted in 'extracted' status with token
    const flowId = 'crash-flow-1';
    await dataLayer.writeJSON('data/channel-market/ecash-funding-flows.json', {
      [flowId]: {
        flow_id: flowId,
        agent_id: 'agent-01',
        amount_sats: 200_000,
        status: 'extracted',
        token: 'cashuA_crash_token',
        created_at: new Date().toISOString(),
      },
    });

    const funder = new EcashChannelFunder({
      walletOps,
      channelOpener: mockChannelOpener(),
      capitalLedger: mockCapitalLedger(),
      dataLayer,
      auditLog: mockAuditLog(),
      mutex: mockMutex(),
    });

    await funder.load();

    // receiveEcash should have been called with the token
    assert.equal(walletOps.receiveCalls.length, 1);
    assert.equal(walletOps.receiveCalls[0].token, 'cashuA_crash_token');

    const status = funder.getFlowStatus(flowId);
    assert.equal(status.status, 'refunded_on_recovery');
  });

  it('credited state → mark recovered on load', async () => {
    const dataLayer = mockDataLayer();
    const flowId = 'crash-flow-2';
    await dataLayer.writeJSON('data/channel-market/ecash-funding-flows.json', {
      [flowId]: {
        flow_id: flowId,
        agent_id: 'agent-01',
        amount_sats: 300_000,
        status: 'credited',
        token: null,
        created_at: new Date().toISOString(),
      },
    });

    const walletOps = mockWalletOps({ balance: 500_000 });
    const funder = new EcashChannelFunder({
      walletOps,
      channelOpener: mockChannelOpener(),
      capitalLedger: mockCapitalLedger(),
      dataLayer,
      auditLog: mockAuditLog(),
      mutex: mockMutex(),
    });

    await funder.load();

    // No refund needed — capital is already in available
    assert.equal(walletOps.receiveCalls.length, 0);

    const status = funder.getFlowStatus(flowId);
    assert.equal(status.status, 'recovered_credited');
  });
});

// ---------------------------------------------------------------------------
// 9. Input validation
// ---------------------------------------------------------------------------

describe('EcashChannelFunder — input validation', () => {
  it('rejects missing local_funding_amount_sats', async () => {
    const { funder } = makeFunder();
    const result = await funder.fundChannelFromEcash('agent-01', {
      instruction: { action: 'channel_open', params: {} },
    });
    assert.equal(result.success, false);
    assert.equal(result.status, 400);
  });

  it('rejects zero amount', async () => {
    const { funder } = makeFunder();
    const result = await funder.fundChannelFromEcash('agent-01', makePayload(0));
    assert.equal(result.success, false);
    assert.equal(result.status, 400);
  });
});
