import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectAgentFacingRoutes,
  DOC_CATALOG,
  matchAgentFacingRoute,
  matchDocSurface,
  ROUTE_CATALOG,
} from './agent-surface-inventory.js';

test('route and doc inventories match the current public surface', () => {
  assert.equal(ROUTE_CATALOG.length, 109);
  assert.equal(DOC_CATALOG.length, 28);
});

test('route inventory excludes internal-only endpoints, dashboard routes, and alias-only duplicates', () => {
  const routes = collectAgentFacingRoutes();
  assert.equal(routes.includes('POST /api/v1/test/reset-rate-limits'), false);
  assert.equal(routes.includes('POST /api/v1/channels/assign'), false);
  assert.equal(routes.some(route => route.startsWith('GET /dashboard')), false);
  assert.equal(routes.includes('POST /api/v1/messages/send'), false);
  assert.equal(routes.includes('POST /api/v1/alliances/propose'), false);
  assert.equal(routes.includes('GET /api/v1/analysis/profile-node/:pubkey'), false);
  assert.equal(routes.includes('GET /api/v1/analysis/node-profile/:pubkey'), false);
  assert.equal(routes.includes('GET /api/v1/agents/me/referral'), false);
});

test('matchers recognize dynamic routes and fold aliases onto canonical docs and routes', () => {
  const route = matchAgentFacingRoute('POST', '/api/v1/alliances/ally-42/accept');
  const aliasedRoute = matchAgentFacingRoute('POST', '/api/v1/messages/send');
  const rootDoc = matchDocSurface({
    method: 'GET',
    path: '/',
    doc_kind: 'root-markdown',
  });
  const staticDoc = matchDocSurface({
    method: 'GET',
    path: '/docs/skills/market-close.txt',
  });
  const apiAliasDoc = matchDocSurface({
    method: 'GET',
    path: '/api/v1/skills/market/open-flow.txt',
  });

  assert.equal(route?.key, 'POST /api/v1/alliances/:id/accept');
  assert.equal(aliasedRoute?.key, 'POST /api/v1/messages');
  assert.equal(rootDoc?.key, 'GET / [root-markdown]');
  assert.equal(staticDoc?.key, 'GET /docs/skills/market.txt');
  assert.equal(apiAliasDoc?.key, 'GET /api/v1/skills/market');
});
