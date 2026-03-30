import assert from 'node:assert/strict';
import {
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
  name: 'social',
  phases: [
    {
      name: 'messaging',
      covers: [
        'POST /api/v1/messages',
        'POST /api/v1/messages/send',
        'GET /api/v1/messages',
        'GET /api/v1/messages/inbox',
      ],
      agent_expectations: {
        'POST /api/v1/messages': expectStatus(201, reqAuth({ bodyKeys: ['to', 'content'] })),
        'POST /api/v1/messages/send': expectStatus(201, reqAuth({ bodyKeys: ['to', 'content'] })),
        'GET /api/v1/messages': expectStatus(200, AUTH),
        'GET /api/v1/messages/inbox': expectStatus(200, AUTH),
      },
      setup: ['auth', 'second_agent'],
      async run(ctx) {
        const sender = await ctx.ensureAgent(0);
        const recipient = await ctx.ensureAgent(1);

        const message = await ctx.request('POST', '/api/v1/messages', {
          authAgent: 0,
          body: { to: recipient.agent_id, content: 'hello from coverage' },
        });
        assertStatus(message, 201, 'POST /api/v1/messages');

        const alias = await ctx.request('POST', '/api/v1/messages/send', {
          authAgent: 0,
          body: { to: recipient.agent_id, content: 'hello again', type: 'intel' },
        });
        assertStatus(alias, 201, 'POST /api/v1/messages/send');

        const inbox = await ctx.request('GET', '/api/v1/messages', { authAgent: 0 });
        assertStatus(inbox, 200, 'GET /api/v1/messages');

        const recipientInbox = await ctx.request('GET', '/api/v1/messages/inbox', { authAgent: 1 });
        assertStatus(recipientInbox, 200, 'GET /api/v1/messages/inbox');
        assert.ok(
          (recipientInbox.json?.messages || []).some(entry => entry.to === recipient.agent_id || entry.to_agent_id === recipient.agent_id),
          'recipient inbox should include delivered messages',
        );
        return `Covered messaging between ${sender.agent_id} and ${recipient.agent_id}.`;
      },
    },
    {
      name: 'alliances',
      covers: [
        'POST /api/v1/alliances',
        'POST /api/v1/alliances/propose',
        'GET /api/v1/alliances',
        'POST /api/v1/alliances/:id/accept',
        'POST /api/v1/alliances/:id/break',
      ],
      agent_expectations: {
        'POST /api/v1/alliances': expectStatus(201, reqAuth({ bodyKeys: ['to', 'terms'] })),
        'POST /api/v1/alliances/propose': expectStatus(201, reqAuth({ bodyKeys: ['to', 'terms'] })),
        'GET /api/v1/alliances': expectStatus(200, AUTH),
        'POST /api/v1/alliances/:id/accept': expectStatus(200, AUTH),
        'POST /api/v1/alliances/:id/break': expectStatus(200, AUTH),
      },
      setup: ['auth', 'second_agent'],
      async run(ctx) {
        const recipient = await ctx.ensureAgent(1);

        const first = await ctx.request('POST', '/api/v1/alliances', {
          authAgent: 0,
          body: {
            to: recipient.agent_id,
            terms: {
              description: 'Share fee intelligence',
              duration_hours: 24,
            },
          },
        });
        assertStatus(first, 201, 'POST /api/v1/alliances');

        const second = await ctx.request('POST', '/api/v1/alliances/propose', {
          authAgent: 0,
          body: {
            to: recipient.agent_id,
            terms: {
              description: 'Second proposal for alias coverage',
              duration_hours: 24,
            },
          },
        });
        assertStatus(second, 201, 'POST /api/v1/alliances/propose');

        const list = await ctx.request('GET', '/api/v1/alliances', { authAgent: 0 });
        assertStatus(list, 200, 'GET /api/v1/alliances');

        const allianceId = first.json?.id || first.json?.alliance_id;
        assert.ok(allianceId, 'POST /api/v1/alliances should return an alliance id');

        const accept = await ctx.request('POST', `/api/v1/alliances/${encodeURIComponent(allianceId)}/accept`, {
          authAgent: 1,
          body: {},
        });
        assertStatus(accept, 200, 'POST /api/v1/alliances/:id/accept');

        const broken = await ctx.request('POST', `/api/v1/alliances/${encodeURIComponent(allianceId)}/break`, {
          authAgent: 0,
          body: { reason: 'Coverage teardown' },
        });
        assertStatus(broken, 200, 'POST /api/v1/alliances/:id/break');
        return 'Covered alliance creation, listing, acceptance, and breakup.';
      },
    },
    {
      name: 'leaderboard-and-tournaments',
      covers: [
        'GET /api/v1/leaderboard',
        'GET /api/v1/leaderboard/agent/:id',
        'GET /api/v1/leaderboard/challenges',
        'GET /api/v1/leaderboard/hall-of-fame',
        'GET /api/v1/leaderboard/evangelists',
        'GET /api/v1/tournaments',
        'GET /api/v1/tournaments/:id/bracket',
        'POST /api/v1/tournaments/:id/enter',
      ],
      agent_expectations: {
        'GET /api/v1/leaderboard': expectStatus(200, PUBLIC),
        'GET /api/v1/leaderboard/agent/:id': expectStatus(200, PUBLIC),
        'GET /api/v1/leaderboard/challenges': expectStatus(200, PUBLIC),
        'GET /api/v1/leaderboard/hall-of-fame': expectStatus(200, PUBLIC),
        'GET /api/v1/leaderboard/evangelists': expectStatus(200, PUBLIC),
        'GET /api/v1/tournaments': expectStatus(200, PUBLIC),
        'GET /api/v1/tournaments/:id/bracket': expectSafe(PUBLIC),
        'POST /api/v1/tournaments/:id/enter': expectSafe(AUTH),
      },
      setup: ['auth'],
      async run(ctx) {
        const agent = await ctx.ensureAgent(0);

        const leaderboard = await ctx.request('GET', '/api/v1/leaderboard');
        assertStatus(leaderboard, 200, 'GET /api/v1/leaderboard');

        const byAgent = await ctx.request('GET', `/api/v1/leaderboard/agent/${encodeURIComponent(agent.agent_id)}`);
        assertStatus(byAgent, 200, 'GET /api/v1/leaderboard/agent/:id');

        const challenges = await ctx.request('GET', '/api/v1/leaderboard/challenges');
        assertStatus(challenges, 200, 'GET /api/v1/leaderboard/challenges');

        const fame = await ctx.request('GET', '/api/v1/leaderboard/hall-of-fame');
        assertStatus(fame, 200, 'GET /api/v1/leaderboard/hall-of-fame');

        const evangelists = await ctx.request('GET', '/api/v1/leaderboard/evangelists');
        assertStatus(evangelists, 200, 'GET /api/v1/leaderboard/evangelists');

        const tournaments = await ctx.request('GET', '/api/v1/tournaments');
        assertStatus(tournaments, 200, 'GET /api/v1/tournaments');
        const tournamentId = tournaments.json?.tournaments?.[0]?.id || 'missing-tournament';

        const bracket = await ctx.request('GET', `/api/v1/tournaments/${encodeURIComponent(tournamentId)}/bracket`);
        assertSafe(bracket, 'GET /api/v1/tournaments/:id/bracket');

        const enter = await ctx.request('POST', `/api/v1/tournaments/${encodeURIComponent(tournamentId)}/enter`, {
          authAgent: 0,
          body: {},
        });
        assertSafe(enter, 'POST /api/v1/tournaments/:id/enter');
        return 'Covered leaderboard and tournament surfaces.';
      },
    },
  ],
};
