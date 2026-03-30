import {
  DEFAULT_NODE_PUBKEY,
  assertSafe,
  assertStatus,
} from '../coverage-helpers.mjs';
import {
  expectSafe,
  expectStatus,
  reqAuth,
  reqPublic,
} from '../agent-coverage-scoring.mjs';

const AUTH = reqAuth();
const PUBLIC = reqPublic();

export const suite = {
  name: 'analytics',
  phases: [
    {
      name: 'catalog-and-quote',
      covers: [
        'GET /api/v1/analytics/catalog',
        'POST /api/v1/analytics/quote',
      ],
      agent_expectations: {
        'GET /api/v1/analytics/catalog': expectStatus(200, PUBLIC),
        'POST /api/v1/analytics/quote': expectSafe(reqAuth({ bodyKeys: ['query_id'] })),
      },
      setup: ['auth'],
      async run(ctx) {
        const catalog = await ctx.request('GET', '/api/v1/analytics/catalog');
        assertStatus(catalog, 200, 'GET /api/v1/analytics/catalog');

        const quote = await ctx.request('POST', '/api/v1/analytics/quote', {
          authAgent: 0,
          body: {
            query_id: 'node_profile',
            params: { pubkey: DEFAULT_NODE_PUBKEY },
          },
        });
        assertSafe(quote, 'POST /api/v1/analytics/quote');
        return 'Covered analytics catalog and quote flow.';
      },
    },
    {
      name: 'execute-and-history',
      covers: [
        'POST /api/v1/analytics/execute',
        'GET /api/v1/analytics/history',
      ],
      agent_expectations: {
        'POST /api/v1/analytics/execute': expectSafe(reqAuth({ bodyKeys: ['query_id'] })),
        'GET /api/v1/analytics/history': expectStatus(200, AUTH),
      },
      setup: ['auth'],
      async run(ctx) {
        const execute = await ctx.request('POST', '/api/v1/analytics/execute', {
          authAgent: 0,
          body: {
            query_id: 'node_profile',
            params: { pubkey: DEFAULT_NODE_PUBKEY },
          },
        });
        assertSafe(execute, 'POST /api/v1/analytics/execute');

        const history = await ctx.request('GET', '/api/v1/analytics/history', { authAgent: 0 });
        assertStatus(history, 200, 'GET /api/v1/analytics/history');
        return 'Covered analytics execution and history.';
      },
    },
  ],
};
