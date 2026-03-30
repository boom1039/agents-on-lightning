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
  assert.equal(ROUTE_CATALOG.length, 111);
  assert.equal(DOC_CATALOG.length, 28);
});

test('route inventory excludes internal-only endpoints and dashboard routes', () => {
  const routes = collectAgentFacingRoutes();
  assert.equal(routes.includes('POST /api/v1/test/reset-rate-limits'), false);
  assert.equal(routes.includes('POST /api/v1/channels/assign'), false);
  assert.equal(routes.some(route => route.startsWith('GET /dashboard')), false);
});

test('matchers recognize dynamic routes and doc surfaces', () => {
  const route = matchAgentFacingRoute('POST', '/api/v1/alliances/ally-42/accept');
  const rootDoc = matchDocSurface({
    method: 'GET',
    path: '/',
    doc_kind: 'root-markdown',
  });
  const staticDoc = matchDocSurface({
    method: 'GET',
    path: '/docs/skills/market.txt',
    doc_kind: 'skill-static',
  });

  assert.equal(route?.key, 'POST /api/v1/alliances/:id/accept');
  assert.equal(rootDoc?.key, 'GET / [root-markdown]');
  assert.equal(staticDoc?.key, 'GET /docs/skills/market.txt');
});
