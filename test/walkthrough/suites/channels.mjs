import assert from 'node:assert/strict';
import {
  assertHelpful,
  SkipPhaseError,
  assertSafe,
  assertSignedBoundary,
  assertStatus,
} from '../coverage-helpers.mjs';
import {
  expectSafe,
  expectSignedBoundary,
  expectStatus,
  reqAuth,
  reqPublic,
} from '../agent-coverage-scoring.mjs';

const VALID_LOOKING_CHANNEL_POINT = `${'0'.repeat(64)}:0`;
const AUTH = reqAuth();
const PUBLIC = reqPublic();

export const suite = {
  name: 'channels',
  phases: [
    {
      name: 'audit-and-monitoring',
      covers: [
        'GET /api/v1/channels/audit',
        'GET /api/v1/channels/audit/:chanId',
        'GET /api/v1/channels/verify',
        'GET /api/v1/channels/verify/:chanId',
        'GET /api/v1/channels/violations',
        'GET /api/v1/channels/status',
      ],
      agent_expectations: {
        'GET /api/v1/channels/audit': expectStatus(200, PUBLIC),
        'GET /api/v1/channels/audit/:chanId': expectSafe(PUBLIC),
        'GET /api/v1/channels/verify': expectStatus(200, PUBLIC),
        'GET /api/v1/channels/verify/:chanId': expectSafe(PUBLIC),
        'GET /api/v1/channels/violations': expectStatus(200, PUBLIC),
        'GET /api/v1/channels/status': expectStatus(200, PUBLIC),
      },
      async run(ctx) {
        const audit = await ctx.request('GET', '/api/v1/channels/audit');
        assertStatus(audit, 200, 'GET /api/v1/channels/audit');

        const auditById = await ctx.request('GET', `/api/v1/channels/audit/${encodeURIComponent(VALID_LOOKING_CHANNEL_POINT)}`);
        assertSafe(auditById, 'GET /api/v1/channels/audit/:chanId');

        const verify = await ctx.request('GET', '/api/v1/channels/verify');
        assertStatus(verify, 200, 'GET /api/v1/channels/verify');

        const verifyById = await ctx.request('GET', `/api/v1/channels/verify/${encodeURIComponent(VALID_LOOKING_CHANNEL_POINT)}`);
        assertSafe(verifyById, 'GET /api/v1/channels/verify/:chanId');

        const violations = await ctx.request('GET', '/api/v1/channels/violations');
        assertStatus(violations, 200, 'GET /api/v1/channels/violations');

        const status = await ctx.request('GET', '/api/v1/channels/status');
        assertStatus(status, 200, 'GET /api/v1/channels/status');
        return 'Covered public audit/verify/violation/status surfaces.';
      },
    },
    {
      name: 'signed-channel-lifecycle',
      covers: [
        'GET /api/v1/channels/mine',
        'POST /api/v1/channels/preview',
        'POST /api/v1/channels/instruct',
        'GET /api/v1/channels/instructions',
      ],
      agent_expectations: {
        'GET /api/v1/channels/mine': expectStatus(200, AUTH),
        'POST /api/v1/channels/preview': expectSignedBoundary(reqAuth({ bodyKeys: ['instruction', 'signature'] })),
        'POST /api/v1/channels/instruct': expectSignedBoundary(reqAuth({ bodyKeys: ['instruction', 'signature'] })),
        'GET /api/v1/channels/instructions': expectStatus(200, AUTH),
      },
      setup: ['auth', 'registered_pubkey', 'assigned_channel'],
      async run(ctx) {
        throw new SkipPhaseError(
          'Direct harness execution no longer mutates live channels. Test signed-channel-lifecycle only in the outside-agent real-flow lane.',
        );

        return 'Skipped.';
      },
    },
  ],
};
