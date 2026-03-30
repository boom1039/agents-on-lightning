import assert from 'node:assert/strict';
import {
  assertHelpful,
  assertSafe,
  assertStatus,
} from '../coverage-helpers.mjs';
import {
  expectHelpful,
  expectSafe,
  expectStatus,
  reqAuth,
  reqPublic,
} from '../agent-coverage-scoring.mjs';

const AUTH = reqAuth();
const PUBLIC = reqPublic();

export const suite = {
  name: 'wallet',
  phases: [
    {
      name: 'wallet-teaching-and-ledger',
      covers: [
        'GET /api/v1/wallet/mint-quote',
        'POST /api/v1/wallet/deposit',
        'POST /api/v1/wallet/withdraw',
        'GET /api/v1/ledger',
      ],
      agent_expectations: {
        'GET /api/v1/wallet/mint-quote': expectHelpful(405, AUTH, ['see']),
        'POST /api/v1/wallet/deposit': expectHelpful(410, AUTH, ['see']),
        'POST /api/v1/wallet/withdraw': expectHelpful(410, AUTH, ['see']),
        'GET /api/v1/ledger': expectStatus(200, PUBLIC),
      },
      setup: ['auth'],
      async run(ctx) {
        const mintGet = await ctx.request('GET', '/api/v1/wallet/mint-quote', { authAgent: 0 });
        assertHelpful(mintGet, 405, 'GET /api/v1/wallet/mint-quote', ['see']);

        const deposit = await ctx.request('POST', '/api/v1/wallet/deposit', {
          authAgent: 0,
          body: {},
        });
        assertHelpful(deposit, 410, 'POST /api/v1/wallet/deposit', ['see']);

        const withdraw = await ctx.request('POST', '/api/v1/wallet/withdraw', {
          authAgent: 0,
          body: {},
        });
        assertHelpful(withdraw, 410, 'POST /api/v1/wallet/withdraw', ['see']);

        const ledger = await ctx.request('GET', '/api/v1/ledger');
        assertStatus(ledger, 200, 'GET /api/v1/ledger');
        return 'Covered wallet teaching surfaces and public ledger.';
      },
    },
    {
      name: 'mint-balance-history',
      covers: [
        'POST /api/v1/wallet/mint-quote',
        'POST /api/v1/wallet/check-mint-quote',
        'POST /api/v1/wallet/mint',
        'GET /api/v1/wallet/balance',
        'GET /api/v1/wallet/history',
        'POST /api/v1/wallet/restore',
        'POST /api/v1/wallet/reclaim-pending',
      ],
      agent_expectations: {
        'POST /api/v1/wallet/mint-quote': expectSafe(reqAuth({ bodyKeys: ['amount_sats'] })),
        'POST /api/v1/wallet/check-mint-quote': expectStatus(200, reqAuth({ bodyKeys: ['quote_id'] })),
        'POST /api/v1/wallet/mint': expectHelpful(400, reqAuth({ bodyKeys: ['amount_sats'] })),
        'GET /api/v1/wallet/balance': expectStatus(200, AUTH),
        'GET /api/v1/wallet/history': expectStatus(200, AUTH),
        'POST /api/v1/wallet/restore': expectStatus(200, AUTH),
        'POST /api/v1/wallet/reclaim-pending': expectStatus(200, AUTH),
      },
      setup: ['auth'],
      async run(ctx) {
        const mintQuote = await ctx.request('POST', '/api/v1/wallet/mint-quote', {
          authAgent: 0,
          body: { amount_sats: 1000 },
        });
        assertSafe(mintQuote, 'POST /api/v1/wallet/mint-quote');
        const quoteId = mintQuote.json?.quote || mintQuote.json?.quote_id;
        assert.ok(quoteId, 'POST /api/v1/wallet/mint-quote should return a quote value');

        const checkQuote = await ctx.request('POST', '/api/v1/wallet/check-mint-quote', {
          authAgent: 0,
          body: { quote_id: quoteId },
        });
        assertStatus(checkQuote, 200, 'POST /api/v1/wallet/check-mint-quote');

        const mint = await ctx.request('POST', '/api/v1/wallet/mint', {
          authAgent: 0,
          body: { amount_sats: 1000, quote_id: quoteId },
        });
        assertHelpful(mint, 400, 'POST /api/v1/wallet/mint');

        const balance = await ctx.request('GET', '/api/v1/wallet/balance', { authAgent: 0 });
        assertStatus(balance, 200, 'GET /api/v1/wallet/balance');

        const history = await ctx.request('GET', '/api/v1/wallet/history', { authAgent: 0 });
        assertStatus(history, 200, 'GET /api/v1/wallet/history');

        const restore = await ctx.request('POST', '/api/v1/wallet/restore', {
          authAgent: 0,
          body: {},
        });
        assertStatus(restore, 200, 'POST /api/v1/wallet/restore');

        const reclaim = await ctx.request('POST', '/api/v1/wallet/reclaim-pending', {
          authAgent: 0,
          body: { max_age_hours: 1 },
        });
        assertStatus(reclaim, 200, 'POST /api/v1/wallet/reclaim-pending');
        return 'Covered mint flow entry points plus wallet reads/recovery.';
      },
    },
    {
      name: 'melt-send-receive',
      covers: [
        'POST /api/v1/wallet/melt-quote',
        'POST /api/v1/wallet/melt',
        'POST /api/v1/wallet/send',
        'POST /api/v1/wallet/receive',
      ],
      agent_expectations: {
        'POST /api/v1/wallet/melt-quote': expectSafe(reqAuth({ bodyKeys: ['invoice'] })),
        'POST /api/v1/wallet/melt': expectHelpful(400, AUTH),
        'POST /api/v1/wallet/send': expectSafe(reqAuth({ bodyKeys: ['amount_sats'] })),
        'POST /api/v1/wallet/receive': expectSafe(reqAuth({ bodyKeys: ['token'] })),
      },
      setup: ['auth'],
      async run(ctx) {
        const meltQuote = await ctx.request('POST', '/api/v1/wallet/melt-quote', {
          authAgent: 0,
          body: { invoice: 'lnbc1invalid' },
        });
        assertSafe(meltQuote, 'POST /api/v1/wallet/melt-quote');

        const melt = await ctx.request('POST', '/api/v1/wallet/melt', {
          authAgent: 0,
          body: {},
        });
        assertHelpful(melt, 400, 'POST /api/v1/wallet/melt');

        const send = await ctx.request('POST', '/api/v1/wallet/send', {
          authAgent: 0,
          body: { amount_sats: 1 },
        });
        assertSafe(send, 'POST /api/v1/wallet/send');

        const receive = await ctx.request('POST', '/api/v1/wallet/receive', {
          authAgent: 0,
          body: { token: 'cashuAinvalid' },
        });
        assertSafe(receive, 'POST /api/v1/wallet/receive');
        return 'Covered melt/send/receive ecash routes.';
      },
    },
  ],
};
