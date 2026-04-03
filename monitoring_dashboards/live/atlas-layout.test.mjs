import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ATLAS_DOMAIN_LAYOUT,
  ATLAS_WORLD,
  buildAtlasLayout,
  buildAtlasRouteSignature,
} from './atlas-layout.mjs';

test('atlas layout keeps route anchors fixed when activity changes', () => {
  const routes = [
    { routeKey: 'GET /', routePath: '/', routeLabel: '/', method: 'GET', domain: 'app-level', group: 'app' },
    { routeKey: 'GET /api/v1/skills/:name', routePath: '/api/v1/skills/:name', routeLabel: '/api/v1/skills/:name', method: 'GET', domain: 'discovery', group: 'skills' },
    { routeKey: 'POST /api/v1/agents/register', routePath: '/api/v1/agents/register', routeLabel: '/api/v1/agents/register', method: 'POST', domain: 'identity', group: 'agents' },
    { routeKey: 'GET /api/v1/market/preview', routePath: '/api/v1/market/preview', routeLabel: '/api/v1/market/preview', method: 'GET', domain: 'market', group: 'market' },
  ];

  const stable = buildAtlasLayout(routes);
  const noisy = buildAtlasLayout(routes.map((route) => ({ ...route, activeAgents: 99, inFlight: 4 })));
  const a = stable.routeAnchors.get('POST /api/v1/agents/register');
  const b = noisy.routeAnchors.get('POST /api/v1/agents/register');

  assert.equal(a.x, b.x);
  assert.equal(a.z, b.z);
  assert.equal(a.envelopeWidth, b.envelopeWidth);
  assert.equal(a.envelopeDepth, b.envelopeDepth);
});

test('every anchor stays inside its fixed domain island', () => {
  const routes = Array.from({ length: 24 }, (_, index) => ({
    routeKey: `GET /api/v1/market/${index}`,
    routePath: `/api/v1/market/${index}`,
    routeLabel: `/api/v1/market/${index}`,
    method: 'GET',
    domain: 'market',
    group: 'market',
  }));

  const layout = buildAtlasLayout(routes);
  const domain = ATLAS_DOMAIN_LAYOUT.market;
  for (const anchor of layout.routeAnchors.values()) {
    assert.ok(anchor.x >= domain.x - domain.width / 2);
    assert.ok(anchor.x <= domain.x + domain.width / 2);
    assert.ok(anchor.z >= domain.z - domain.depth / 2);
    assert.ok(anchor.z <= domain.z + domain.depth / 2);
  }
});

test('route signature changes only when route identity changes', () => {
  const baseRoutes = [
    { routeKey: 'GET /a', routePath: '/a', routeLabel: '/a', method: 'GET', domain: 'app-level', group: 'app' },
    { routeKey: 'GET /b', routePath: '/b', routeLabel: '/b', method: 'GET', domain: 'discovery', group: 'skills' },
  ];

  const sigA = buildAtlasRouteSignature(baseRoutes);
  const sigB = buildAtlasRouteSignature(baseRoutes.map((route) => ({ ...route, activeAgents: 7 })));
  const sigC = buildAtlasRouteSignature([...baseRoutes, { routeKey: 'GET /c', routePath: '/c', routeLabel: '/c', method: 'GET', domain: 'other', group: 'other' }]);

  assert.equal(sigA, sigB);
  assert.notEqual(sigA, sigC);
});

test('world board is larger than every domain footprint', () => {
  for (const spec of Object.values(ATLAS_DOMAIN_LAYOUT)) {
    assert.ok(spec.width < ATLAS_WORLD.width);
    assert.ok(spec.depth < ATLAS_WORLD.depth);
  }
});
