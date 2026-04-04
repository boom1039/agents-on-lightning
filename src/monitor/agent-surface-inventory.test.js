import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  extractRoutesFromApp,
  registerApp,
  DOC_CATALOG,
  matchAgentFacingRoute,
  matchDocSurface,
  ROUTE_CATALOG,
} from './agent-surface-inventory.js';
import { agentGatewayRoutes } from '../routes/agent-gateway.js';

// Build a real Express app with the gateway mounted so we can walk it.
function buildTestApp() {
  const app = express();
  // Minimal daemon stub — routes only need it for middleware closures
  const daemon = new Proxy({}, { get: () => () => {} });
  app.get('/', (_req, res) => res.end());
  app.get('/llms.txt', (_req, res) => res.end());
  app.use(agentGatewayRoutes(daemon));
  app.get('/health', (_req, res) => res.end());
  return app;
}

test('extractRoutesFromApp walks live Express router and finds routes', () => {
  const app = buildTestApp();
  const routes = extractRoutesFromApp(app);
  assert.ok(routes.length > 100, `expected >100 routes, got ${routes.length}`);
  assert.ok(routes.includes('GET /'), 'should include GET /');
  assert.ok(routes.includes('GET /llms.txt'), 'should include GET /llms.txt');
  assert.ok(routes.includes('POST /api/v1/agents/register'), 'should include register');
  assert.ok(routes.includes('GET /api/v1/wallet/balance'), 'should include wallet balance');
});

test('registerApp populates ROUTE_CATALOG from live router', () => {
  const app = buildTestApp();
  registerApp(app);
  assert.ok(ROUTE_CATALOG.length > 100, `expected >100, got ${ROUTE_CATALOG.length}`);
  assert.equal(DOC_CATALOG.length, 28);
  // Every entry should have key, method, path, domain, regex
  for (const route of ROUTE_CATALOG) {
    assert.ok(route.key, 'route should have key');
    assert.ok(route.method, 'route should have method');
    assert.ok(route.path, 'route should have path');
    assert.ok(route.domain, 'route should have domain');
    assert.ok(route.regex instanceof RegExp, 'route should have regex');
  }
});

test('excluded routes and aliases are handled correctly', () => {
  const app = buildTestApp();
  const routes = extractRoutesFromApp(app);
  assert.ok(!routes.includes('POST /api/v1/test/reset-rate-limits'), 'should exclude test route');
  assert.ok(!routes.includes('POST /api/v1/channels/assign'), 'should exclude assign');
  assert.ok(!routes.some(r => r.startsWith('GET /dashboard')), 'should exclude dashboard');
});

test('matchers recognize dynamic routes and fold aliases onto canonical docs and routes', () => {
  const app = buildTestApp();
  registerApp(app);

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
