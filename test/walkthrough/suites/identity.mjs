import assert from 'node:assert/strict';
import {
  assertHelpful,
  assertStatus,
} from '../coverage-helpers.mjs';
import {
  expectHelpful,
  expectStatus,
  reqAuth,
  reqOptional,
  reqPublic,
} from '../agent-coverage-scoring.mjs';

const AUTH = reqAuth();
const PUBLIC = reqPublic();
const PUBLIC_OR_AUTH = reqOptional();

export const suite = {
  name: 'identity',
  phases: [
    {
      name: 'registration-and-profile',
      covers: [
        'POST /api/v1/agents/register',
        'GET /api/v1/agents/me',
        'PUT /api/v1/agents/me',
        'GET /api/v1/agents/me/referral-code',
        'GET /api/v1/agents/:id',
        'GET /api/v1/agents/:id/lineage',
      ],
      agent_expectations: {
        'POST /api/v1/agents/register': expectStatus(201, reqPublic({ bodyKeys: ['name'] }), {
          requiredFields: ['api_key', 'agent_id'],
        }),
        'GET /api/v1/agents/me': expectStatus(200, AUTH, {
          requiredOneOf: [['id', 'agent_id']],
        }),
        'PUT /api/v1/agents/me': expectStatus(200, reqAuth({ bodyAnyKeys: ['name', 'description', 'pubkey'] })),
        'GET /api/v1/agents/me/referral-code': expectStatus(200, AUTH),
        'GET /api/v1/agents/:id': expectStatus(200, PUBLIC_OR_AUTH),
        'GET /api/v1/agents/:id/lineage': expectStatus(200, PUBLIC_OR_AUTH),
      },
      setup: ['auth'],
      async run(ctx) {
        const agent = await ctx.ensureAgent(0);

        const me = await ctx.request('GET', '/api/v1/agents/me', { authAgent: 0 });
        assertStatus(me, 200, 'GET /api/v1/agents/me');
        assert.equal(me.json?.id || me.json?.agent_id, agent.agent_id, 'GET /api/v1/agents/me should return current agent');

        const update = await ctx.request('PUT', '/api/v1/agents/me', {
          authAgent: 0,
          body: {
            name: `coverage-updated-${Date.now()}`,
            description: 'Coverage test agent',
          },
        });
        assertStatus(update, 200, 'PUT /api/v1/agents/me');

        const referral = await ctx.request('GET', '/api/v1/agents/me/referral-code', { authAgent: 0 });
        assertStatus(referral, 200, 'GET /api/v1/agents/me/referral-code');

        const byId = await ctx.request('GET', `/api/v1/agents/${agent.agent_id}`);
        assertStatus(byId, 200, 'GET /api/v1/agents/:id');

        const lineage = await ctx.request('GET', `/api/v1/agents/${agent.agent_id}/lineage`);
        assertStatus(lineage, 200, 'GET /api/v1/agents/:id/lineage');
        return 'Covered registration plus authenticated/public profile routes.';
      },
    },
    {
      name: 'node-connection',
      covers: [
        'POST /api/v1/node/connect',
        'POST /api/v1/node/test-connection',
        'GET /api/v1/node/status',
      ],
      agent_expectations: {
        'POST /api/v1/node/connect': expectHelpful(400, AUTH),
        'POST /api/v1/node/test-connection': expectHelpful(400, AUTH),
        'GET /api/v1/node/status': expectStatus(200, AUTH),
      },
      setup: ['auth'],
      async run(ctx) {
        const testConnection = await ctx.request('POST', '/api/v1/node/test-connection', {
          authAgent: 0,
          body: {},
        });
        assertHelpful(testConnection, 400, 'POST /api/v1/node/test-connection');

        const connect = await ctx.request('POST', '/api/v1/node/connect', {
          authAgent: 0,
          body: {},
        });
        assertHelpful(connect, 400, 'POST /api/v1/node/connect');

        const status = await ctx.request('GET', '/api/v1/node/status', { authAgent: 0 });
        assertStatus(status, 200, 'GET /api/v1/node/status');
        return 'Covered node connection stubs and node status.';
      },
    },
    {
      name: 'actions',
      covers: [
        'POST /api/v1/actions/submit',
        'GET /api/v1/actions/history',
        'GET /api/v1/actions/:id',
      ],
      agent_expectations: {
        'POST /api/v1/actions/submit': expectStatus(201, reqAuth({ bodyKeys: ['action_type', 'params'] }), {
          requiredFields: ['action_id'],
        }),
        'GET /api/v1/actions/history': expectStatus(200, AUTH),
        'GET /api/v1/actions/:id': expectStatus(200, AUTH),
      },
      setup: ['auth'],
      async run(ctx) {
        const submit = await ctx.request('POST', '/api/v1/actions/submit', {
          authAgent: 0,
          body: {
            action_type: 'open_channel',
            params: { peer_pubkey: '03' + 'ab'.repeat(32) },
            description: 'Coverage test action',
          },
        });
        assertStatus(submit, 201, 'POST /api/v1/actions/submit');
        const actionId = submit.json?.action_id;
        assert.ok(actionId, 'POST /api/v1/actions/submit should return action_id');

        const history = await ctx.request('GET', '/api/v1/actions/history', { authAgent: 0 });
        assertStatus(history, 200, 'GET /api/v1/actions/history');

        const action = await ctx.request('GET', `/api/v1/actions/${encodeURIComponent(actionId)}`, { authAgent: 0 });
        assertStatus(action, 200, 'GET /api/v1/actions/:id');
        return 'Covered action submission and lookup routes.';
      },
    },
  ],
};
