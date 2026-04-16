import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';

import { configureRateLimiterPolicy } from '../identity/rate-limiter.js';
import { DangerRoutePolicyStore } from '../identity/danger-route-policy.js';
import {
  INTERNAL_AUTH_AUDIENCE_HEADER,
  INTERNAL_AUTH_PAYLOAD_HASH_HEADER,
  INTERNAL_VERIFIED_AGENT_ID_HEADER,
} from '../identity/signed-auth.js';
import { agentPaidServicesRoutes } from './agent-paid-services-routes.js';

const TEST_INTERNAL_MCP_SECRET = 'test-paid-services-internal-mcp';

function authHeaders(agentId) {
  return {
    'x-aol-internal-mcp': TEST_INTERNAL_MCP_SECRET,
    [INTERNAL_VERIFIED_AGENT_ID_HEADER]: agentId,
    [INTERNAL_AUTH_PAYLOAD_HASH_HEADER]: 'b'.repeat(64),
    [INTERNAL_AUTH_AUDIENCE_HEADER]: 'http://127.0.0.1/mcp',
  };
}

function dangerRoutesConfig() {
  return {
    channels: {
      preview: { agentAttemptLimit: 20, perChannelAttemptLimit: 12, sharedAttemptLimit: 100, attemptWindowMs: 60_000 },
      instruct: { agentAttemptLimit: 3, perChannelAttemptLimit: 2, sharedAttemptLimit: 8, attemptWindowMs: 60_000, sharedCooldownMs: 1 },
    },
    capitalWithdraw: {
      attemptLimit: 100,
      attemptWindowMs: 60_000,
      cooldownMs: 1,
      caps: { hardCapSats: 1_000_000, dailyHardCapSats: 1_000_000, sharedDailyHardCapSats: 1_000_000 },
    },
    market: {
      sharedSuccessCooldownMs: 1,
      maxPendingOperations: 10,
      preview: { agentAttemptLimit: 20, sharedAttemptLimit: 100, attemptWindowMs: 60_000, caps: {} },
      open: { agentAttemptLimit: 10, sharedAttemptLimit: 50, attemptWindowMs: 60_000, cooldownMs: 1, caps: {} },
      close: { agentAttemptLimit: 10, sharedAttemptLimit: 50, attemptWindowMs: 60_000, cooldownMs: 1 },
      swap: { agentAttemptLimit: 10, sharedAttemptLimit: 50, attemptWindowMs: 60_000, cooldownMs: 1, caps: {} },
      fundFromEcash: { agentAttemptLimit: 10, sharedAttemptLimit: 50, attemptWindowMs: 60_000, cooldownMs: 1, caps: {} },
      rebalance: { agentAttemptLimit: 10, sharedAttemptLimit: 50, attemptWindowMs: 60_000, cooldownMs: 1, caps: {} },
      rebalanceEstimate: { agentAttemptLimit: 20, sharedAttemptLimit: 100, attemptWindowMs: 60_000 },
    },
  };
}

async function startPaidServicesApp(daemon) {
  await DangerRoutePolicyStore.resetAllForTests();
  configureRateLimiterPolicy({
    categories: {
      analytics_query: { limit: 100, windowMs: 60_000 },
      capital_read: { limit: 100, windowMs: 60_000 },
      capital_write: { limit: 100, windowMs: 60_000 },
      discovery: { limit: 100, windowMs: 60_000 },
      wallet_write: { limit: 100, windowMs: 60_000 },
    },
    globalCap: { limit: 1_000, windowMs: 60_000 },
    progressive: {
      resetWindowMs: 60_000,
      thresholds: [
        { violations: 10, multiplier: 4 },
        { violations: 5, multiplier: 2 },
      ],
    },
  });

  const app = express();
  app.use(express.json());
  process.env.AOL_INTERNAL_MCP_SECRET = TEST_INTERNAL_MCP_SECRET;
  app.use(agentPaidServicesRoutes(daemon));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

test('capital withdrawal deducts on-chain miner fee from agent capital', async () => {
  const agentId = 'feedbeef';
  let available = 2_000;
  const withdrawCalls = [];
  const refundCalls = [];
  const sendCalls = [];
  const daemon = {
    config: { dangerRoutes: dangerRoutesConfig() },
    agentRegistry: {
      getById: (id) => id === agentId ? { id: agentId, name: 'fee-agent' } : null,
    },
    capitalLedger: {
      withdraw: async (id, amount, destination, details = {}) => {
        assert.equal(id, agentId);
        if (available < amount) throw new Error(`Insufficient available balance for ${id}: has ${available}, need ${amount}`);
        available -= amount;
        withdrawCalls.push({ amount, destination, details });
        return { available, total_withdrawn: 2_000 - available };
      },
      refundWithdrawal: async (id, amount, destination, reason, details = {}) => {
        assert.equal(id, agentId);
        available += amount;
        refundCalls.push({ amount, destination, reason, details });
        return { available, total_withdrawn: 2_000 - available };
      },
      recordLifecycleProof: async () => {},
    },
    nodeManager: {
      getScopedDefaultNodeOrNull: () => ({
        estimateFee: async (destination, amount, opts) => {
          assert.equal(destination, 'bc1qrvhzs33sns6dg8u7nxjx0ftl8athhrq5qz0927');
          assert.equal(amount, 1_000);
          assert.deepEqual(opts, { targetConf: 3, minConfs: 1, spendUnconfirmed: false });
          return { fee_sat: '144', sat_per_vbyte: '1' };
        },
        sendCoins: async (destination, amount, opts) => {
          sendCalls.push({ destination, amount, opts });
          return { txid: 'withdraw-txid' };
        },
        getTransactions: async () => ({
          transactions: [{
            tx_hash: 'withdraw-txid',
            label: sendCalls[0]?.opts?.label,
            total_fees: '120',
          }],
        }),
      }),
    },
  };
  const { server, baseUrl } = await startPaidServicesApp(daemon);

  try {
    const response = await fetch(new URL('/api/v1/capital/withdraw', baseUrl), {
      method: 'POST',
      headers: {
        ...authHeaders(agentId),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        amount_sats: 1_000,
        destination_address: 'bc1qrvhzs33sns6dg8u7nxjx0ftl8athhrq5qz0927',
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.destination_amount_sats, 1_000);
    assert.equal(body.estimated_fee_sats, 144);
    assert.equal(body.fee_sats, 120);
    assert.equal(body.fee_refund_sats, 24);
    assert.equal(body.total_debited_sats, 1_120);
    assert.equal(body.platform_fee_sats, 0);
    assert.equal(available, 880);
    assert.equal(withdrawCalls[0].amount, 1_144);
    assert.equal(withdrawCalls[0].details.net_amount_sats, 1_000);
    assert.equal(refundCalls[0].amount, 24);
    assert.equal(refundCalls[0].reason, 'withdraw_fee_reserve_refunded');
    assert.equal(sendCalls[0].amount, 1_000);
    assert.equal(sendCalls[0].opts.satPerVbyte, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('capital withdrawal rejects when capital cannot cover amount plus miner fee', async () => {
  const agentId = 'badc0ffe';
  const daemon = {
    config: { dangerRoutes: dangerRoutesConfig() },
    agentRegistry: {
      getById: (id) => id === agentId ? { id: agentId, name: 'fee-agent' } : null,
    },
    capitalLedger: {
      withdraw: async () => {
        throw new Error('Insufficient available balance for badc0ffe: has 1000, need 1144');
      },
    },
    nodeManager: {
      getScopedDefaultNodeOrNull: () => ({
        estimateFee: async () => ({ fee_sat: '144', sat_per_vbyte: '1' }),
      }),
    },
  };
  const { server, baseUrl } = await startPaidServicesApp(daemon);

  try {
    const response = await fetch(new URL('/api/v1/capital/withdraw', baseUrl), {
      method: 'POST',
      headers: {
        ...authHeaders(agentId),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        amount_sats: 1_000,
        destination_address: 'bc1qrvhzs33sns6dg8u7nxjx0ftl8athhrq5qz0927',
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, 'insufficient_capital');
    assert.match(body.message, /estimated 144 sat withdrawal miner fee/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
