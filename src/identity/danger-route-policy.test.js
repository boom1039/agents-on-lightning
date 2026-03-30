import test from 'node:test';
import assert from 'node:assert/strict';
import { DangerRoutePolicyStore } from './danger-route-policy.js';

test('DangerRoutePolicyStore applies shared daily review budget across agents', async () => {
  const store = new DangerRoutePolicyStore();

  await store.recordSuccess({
    scope: 'market_open',
    agentId: 'agent-a',
    amountSats: 450_000,
  });

  const decision = await store.assessAmount({
    scope: 'market_open',
    agentId: 'agent-b',
    amountSats: 75_000,
    autoApproveSats: 100_000,
    hardCapSats: 250_000,
    dailyAutoApproveSats: 250_000,
    dailyHardCapSats: 500_000,
    sharedDailyAutoApproveSats: 500_000,
    sharedDailyHardCapSats: 1_000_000,
  });

  assert.equal(decision.decision, 'review_required');
  assert.equal(decision.decisionReason, 'shared_daily_auto_approve_cap');
  assert.equal(decision.total24h, 0);
  assert.equal(decision.sharedTotal24h, 450_000);
});

test('DangerRoutePolicyStore applies shared daily hard cap across agents', async () => {
  const store = new DangerRoutePolicyStore();

  await store.recordSuccess({
    scope: 'market_open',
    agentId: 'agent-a',
    amountSats: 900_000,
  });

  const decision = await store.assessAmount({
    scope: 'market_open',
    agentId: 'agent-b',
    amountSats: 200_000,
    autoApproveSats: 100_000,
    hardCapSats: 250_000,
    dailyAutoApproveSats: 250_000,
    dailyHardCapSats: 500_000,
    sharedDailyAutoApproveSats: 500_000,
    sharedDailyHardCapSats: 1_000_000,
  });

  assert.equal(decision.decision, 'hard_cap');
  assert.equal(decision.decisionReason, 'shared_daily_hard_cap');
  assert.equal(decision.sharedTotal24h, 900_000);
});

test('DangerRoutePolicyStore tracks shared totals across agents within a scope only', async () => {
  const store = new DangerRoutePolicyStore();

  await store.recordSuccess({
    scope: 'market_open',
    agentId: 'agent-a',
    amountSats: 125_000,
  });
  await store.recordSuccess({
    scope: 'market_open',
    agentId: 'agent-b',
    amountSats: 175_000,
  });
  await store.recordSuccess({
    scope: 'market_close',
    agentId: 'agent-a',
    amountSats: 999_999,
  });

  const decision = await store.assessAmount({
    scope: 'market_open',
    agentId: 'agent-c',
    amountSats: 50_000,
    autoApproveSats: 100_000,
    hardCapSats: 250_000,
    dailyAutoApproveSats: 250_000,
    dailyHardCapSats: 500_000,
    sharedDailyAutoApproveSats: 500_000,
    sharedDailyHardCapSats: 1_000_000,
  });

  assert.equal(decision.decision, 'allow');
  assert.equal(decision.decisionReason, 'allow');
  assert.equal(decision.total24h, 0);
  assert.equal(decision.sharedTotal24h, 300_000);
});
