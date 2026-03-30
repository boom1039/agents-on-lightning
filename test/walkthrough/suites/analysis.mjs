import {
  DEFAULT_NODE_PUBKEY,
  assertSafe,
} from '../coverage-helpers.mjs';
import {
  expectSafe,
  reqPublic,
} from '../agent-coverage-scoring.mjs';

const PUBLIC = reqPublic();

export const suite = {
  name: 'analysis',
  phases: [
    {
      name: 'network-health',
      covers: ['GET /api/v1/analysis/network-health'],
      agent_expectations: {
        'GET /api/v1/analysis/network-health': expectSafe(PUBLIC),
      },
      async run(ctx) {
        const health = await ctx.request('GET', '/api/v1/analysis/network-health');
        assertSafe(health, 'GET /api/v1/analysis/network-health');
        return 'Covered public network-health analysis.';
      },
    },
    {
      name: 'node-profile-aliases',
      covers: [
        'GET /api/v1/analysis/node/:pubkey',
        'GET /api/v1/analysis/profile-node/:pubkey',
        'GET /api/v1/analysis/node-profile/:pubkey',
      ],
      agent_expectations: {
        'GET /api/v1/analysis/node/:pubkey': expectSafe(PUBLIC),
        'GET /api/v1/analysis/profile-node/:pubkey': expectSafe(PUBLIC),
        'GET /api/v1/analysis/node-profile/:pubkey': expectSafe(PUBLIC),
      },
      async run(ctx) {
        const paths = [
          '/api/v1/analysis/node/',
          '/api/v1/analysis/profile-node/',
          '/api/v1/analysis/node-profile/',
        ];
        for (const path of paths) {
          const resp = await ctx.request('GET', `${path}${DEFAULT_NODE_PUBKEY}`);
          assertSafe(resp, `GET ${path}:pubkey`);
        }
        return 'Covered all node-profile route aliases.';
      },
    },
    {
      name: 'suggest-peers',
      covers: ['GET /api/v1/analysis/suggest-peers/:pubkey'],
      agent_expectations: {
        'GET /api/v1/analysis/suggest-peers/:pubkey': expectSafe(PUBLIC),
      },
      async run(ctx) {
        const peers = await ctx.request('GET', `/api/v1/analysis/suggest-peers/${DEFAULT_NODE_PUBKEY}`);
        assertSafe(peers, 'GET /api/v1/analysis/suggest-peers/:pubkey');
        return 'Covered public peer suggestion analysis.';
      },
    },
  ],
};
