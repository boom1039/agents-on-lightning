import assert from 'node:assert/strict';
import {
  assertSafe,
  assertStatus,
} from '../coverage-helpers.mjs';
import {
  expectSafe,
  expectStatus,
  expectHelpful,
  reqAuth,
} from '../agent-coverage-scoring.mjs';

const AUTH = reqAuth();

export const suite = {
  name: 'capital',
  phases: [
    {
      name: 'balance-and-activity',
      covers: [
        'GET /api/v1/capital/balance',
        'GET /api/v1/capital/activity',
      ],
      agent_expectations: {
        'GET /api/v1/capital/balance': expectStatus(200, AUTH, { requiredFields: ['balance'] }),
        'GET /api/v1/capital/activity': expectStatus(200, AUTH),
      },
      setup: ['auth'],
      async run(ctx) {
        const balance = await ctx.request('GET', '/api/v1/capital/balance', { authAgent: 0 });
        assertStatus(balance, 200, 'GET /api/v1/capital/balance');
        assert.ok(balance.json?.balance, 'GET /api/v1/capital/balance should expose balance');

        const activity = await ctx.request('GET', '/api/v1/capital/activity', { authAgent: 0 });
        assertStatus(activity, 200, 'GET /api/v1/capital/activity');
        return 'Covered capital balance and activity reads.';
      },
    },
    {
      name: 'deposit-and-status',
      covers: [
        'POST /api/v1/capital/deposit',
        'GET /api/v1/capital/deposits',
      ],
      agent_expectations: {
        'POST /api/v1/capital/deposit': expectSafe(AUTH),
        'GET /api/v1/capital/deposits': expectStatus(200, AUTH),
      },
      setup: ['auth'],
      async run(ctx) {
        const deposit = await ctx.request('POST', '/api/v1/capital/deposit', {
          authAgent: 0,
          body: {},
        });
        assertSafe(deposit, 'POST /api/v1/capital/deposit');
        if (deposit.status === 200) {
          assert.ok(deposit.json?.address, 'POST /api/v1/capital/deposit should return an address');
          assert.ok(deposit.json?.watch_url, 'POST /api/v1/capital/deposit should return a watch_url');
          assert.ok(
            deposit.json.watch_url.includes(deposit.json.address),
            'POST /api/v1/capital/deposit watch_url should include the deposit address',
          );
        }

        const deposits = await ctx.request('GET', '/api/v1/capital/deposits', { authAgent: 0 });
        assertStatus(deposits, 200, 'GET /api/v1/capital/deposits');
        return 'Covered deposit-address generation and deposit status.';
      },
    },
    {
      name: 'withdraw-and-help',
      covers: [
        'POST /api/v1/capital/withdraw',
        'POST /api/v1/help',
      ],
      agent_expectations: {
        'POST /api/v1/capital/withdraw': expectHelpful(503, reqAuth({ bodyKeys: ['amount_sats', 'destination_address'] })),
        'POST /api/v1/help': expectSafe(reqAuth({ bodyKeys: ['question'] })),
      },
      setup: ['auth'],
      async run(ctx) {
        const withdraw = await ctx.request('POST', '/api/v1/capital/withdraw', {
          authAgent: 0,
          body: {
            amount_sats: 1000,
            destination_address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080',
          },
        });
        assertSafe(withdraw, 'POST /api/v1/capital/withdraw');

        const help = await ctx.request('POST', '/api/v1/help', {
          authAgent: 0,
          body: {
            question: 'How do I open a channel?',
          },
        });
        assertSafe(help, 'POST /api/v1/help');
        return 'Covered withdrawal and help concierge routes.';
      },
    },
  ],
};
