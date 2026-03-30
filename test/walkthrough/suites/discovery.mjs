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
  reqPublic,
} from '../agent-coverage-scoring.mjs';

const PUBLIC = reqPublic();

export const suite = {
  name: 'discovery',
  phases: [
    {
      name: 'root-and-docs',
      covers: [
        'GET /',
        'GET /llms.txt',
        'GET /health',
        'GET /api/v1/',
      ],
      agent_expectations: {
        'GET /': expectStatus(200, PUBLIC),
        'GET /llms.txt': expectStatus(200, PUBLIC),
        'GET /health': expectStatus(200, PUBLIC, { requiredFields: ['status'] }),
        'GET /api/v1/': expectStatus(200, PUBLIC),
      },
      async run(ctx) {
        const rootJson = await ctx.request('GET', '/', {
          headers: { Accept: 'application/json' },
        });
        assertStatus(rootJson, 200, 'GET /');
        assert.ok(rootJson.json?.api, 'GET / should include api link');

        const rootMarkdown = await ctx.request('GET', '/', {
          headers: { Accept: 'text/markdown' },
        });
        assertStatus(rootMarkdown, 200, 'GET / markdown');
        assert.ok(rootMarkdown.text.includes('/api/v1/'), 'GET / markdown should mention /api/v1/');

        const llms = await ctx.request('GET', '/llms.txt');
        assertStatus(llms, 200, 'GET /llms.txt');
        assert.ok(llms.text.length > 100, 'llms.txt should not be empty');

        const health = await ctx.request('GET', '/health');
        assertStatus(health, 200, 'GET /health');
        assert.ok(health.json?.status, '/health should expose status');

        const apiRoot = await ctx.request('GET', '/api/v1/');
        assertStatus(apiRoot, 200, 'GET /api/v1/');
        return 'Verified app-level discovery surfaces and API index.';
      },
    },
    {
      name: 'platform-ethos-capabilities',
      covers: [
        'GET /api/v1/platform/status',
        'GET /api/v1/platform/decode-invoice',
        'GET /api/v1/ethos',
        'GET /api/v1/capabilities',
      ],
      agent_expectations: {
        'GET /api/v1/platform/status': expectSafe(PUBLIC),
        'GET /api/v1/platform/decode-invoice': expectHelpful(400, reqPublic({ queryKeys: ['invoice'] })),
        'GET /api/v1/ethos': expectStatus(200, PUBLIC),
        'GET /api/v1/capabilities': expectStatus(200, PUBLIC, { requiredFields: ['tiers'] }),
      },
      async run(ctx) {
        const status = await ctx.request('GET', '/api/v1/platform/status');
        assertSafe(status, 'GET /api/v1/platform/status');

        const decode = await ctx.request('GET', '/api/v1/platform/decode-invoice?invoice=lnbc1invalid');
        assertHelpful(decode, 400, 'GET /api/v1/platform/decode-invoice');

        const ethos = await ctx.request('GET', '/api/v1/ethos');
        assertStatus(ethos, 200, 'GET /api/v1/ethos');

        const capabilities = await ctx.request('GET', '/api/v1/capabilities');
        assertStatus(capabilities, 200, 'GET /api/v1/capabilities');
        assert.ok(capabilities.json?.tiers, 'GET /api/v1/capabilities should include tiers');
        return 'Covered public platform metadata, ethos, and capability docs.';
      },
    },
    {
      name: 'strategies-and-knowledge',
      covers: [
        'GET /api/v1/strategies',
        'GET /api/v1/strategies/:name',
        'GET /api/v1/knowledge/:topic',
      ],
      agent_expectations: {
        'GET /api/v1/strategies': expectStatus(200, PUBLIC, { requiredFields: ['strategies'] }),
        'GET /api/v1/strategies/:name': expectStatus(200, PUBLIC),
        'GET /api/v1/knowledge/:topic': expectStatus(200, PUBLIC, { requiredFields: ['content'] }),
      },
      async run(ctx) {
        const strategies = await ctx.request('GET', '/api/v1/strategies');
        assertStatus(strategies, 200, 'GET /api/v1/strategies');
        const first = strategies.json?.strategies?.[0]?.name;
        assert.ok(first, 'GET /api/v1/strategies should return at least one strategy');

        const strategy = await ctx.request('GET', `/api/v1/strategies/${encodeURIComponent(first)}`);
        assertStatus(strategy, 200, 'GET /api/v1/strategies/:name');

        const knowledge = await ctx.request('GET', '/api/v1/knowledge/onboarding');
        assertStatus(knowledge, 200, 'GET /api/v1/knowledge/:topic');
        assert.ok(knowledge.json?.content?.length > 100, 'knowledge topic should include content');
        return 'Covered strategy index/detail and knowledge base access.';
      },
    },
    {
      name: 'skills',
      covers: [
        'GET /api/v1/skills',
        'GET /api/v1/skills/:name',
        'GET /api/v1/skills/:group/:name',
      ],
      agent_expectations: {
        'GET /api/v1/skills': expectStatus(200, PUBLIC, { requiredFields: ['skills'] }),
        'GET /api/v1/skills/:name': expectStatus(200, PUBLIC, { requiredFields: ['content'] }),
        'GET /api/v1/skills/:group/:name': expectStatus(200, PUBLIC, { requiredFields: ['content'] }),
      },
      async run(ctx) {
        const skills = await ctx.request('GET', '/api/v1/skills');
        assertStatus(skills, 200, 'GET /api/v1/skills');
        const names = skills.json?.skills?.map(skill => skill.name) || [];
        assert.ok(names.includes('market'), 'GET /api/v1/skills should list canonical market skill');
        assert.equal(names.includes('market-open-flow'), false, 'GET /api/v1/skills should not list alias-only helper names');
        assert.equal(names.includes('channels-signed'), false, 'GET /api/v1/skills should not list alias-only helper names');
        const first = names[0];
        assert.ok(first, 'GET /api/v1/skills should list at least one skill');

        const skill = await ctx.request('GET', `/api/v1/skills/${encodeURIComponent(first)}`);
        assertStatus(skill, 200, 'GET /api/v1/skills/:name');
        assert.ok(skill.json?.content?.length > 100, 'skill file should include content');

        const helperSkill = await ctx.request('GET', '/api/v1/skills/market/open-flow.txt');
        assertStatus(helperSkill, 200, 'GET /api/v1/skills/:group/:name');
        assert.ok(helperSkill.json?.content?.length > 100, 'nested helper skill should include content');
        return 'Verified canonical skill docs plus one live compatibility alias.';
      },
    },
  ],
};
