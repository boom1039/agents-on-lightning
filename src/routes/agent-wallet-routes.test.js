import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';

import { configureRateLimiterPolicy } from '../identity/rate-limiter.js';
import { agentWalletRoutes } from './agent-wallet-routes.js';

async function startWalletRouteApp(daemon) {
  configureRateLimiterPolicy({
    categories: {
      wallet_read: { limit: 100, windowMs: 60_000 },
      wallet_write: { limit: 100, windowMs: 60_000 },
      discovery: { limit: 100, windowMs: 60_000 },
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
  app.use(agentWalletRoutes(daemon));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

test('wallet mint quote rejects before invoice when single-channel inbound capacity is too low', async () => {
  const apiKey = `lb-agent-${'a'.repeat(64)}`;
  let mintQuoteCalled = false;
  const daemon = {
    config: {},
    agentRegistry: {
      getByApiKey: (key) => key === apiKey ? { id: 'agent-wallet', name: 'agent-wallet' } : null,
    },
    nodeManager: {
      getScopedDefaultNodeOrNull: () => ({
        listChannels: async () => ({
          channels: [{
            active: true,
            remote_balance: '25000',
            unsettled_balance: '0',
            remote_constraints: { chan_reserve_sat: '1000' },
          }],
        }),
      }),
    },
    agentCashuWallet: {
      mintQuote: async () => {
        mintQuoteCalled = true;
        return { quote: 'quote', request: 'lnbc_should_not_exist', state: 'UNPAID' };
      },
    },
  };
  const { server, baseUrl } = await startWalletRouteApp(daemon);

  try {
    const response = await fetch(new URL('/api/v1/wallet/mint-quote', baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ amount_sats: 100_000 }),
    });
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.equal(body.error, 'wallet_mint_receive_preflight_failed');
    assert.equal(body.receive_preflight.can_receive, false);
    assert.equal(body.receive_preflight.suggested_max_sats, 23_000);
    assert.equal(mintQuoteCalled, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
