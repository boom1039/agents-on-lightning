import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAtlasLayout,
  buildAtlasRouteSignature,
  computeRouteVisual,
  computeSlotPosition,
} from './atlas-geometry.mjs';

test('atlas layout gives every route a fixed anchor', () => {
  const routes = [
    { routeKey: 'GET /', routePath: '/', routeLabel: '/', method: 'GET', domain: 'app-level', group: 'app' },
    { routeKey: 'GET /llms.txt', routePath: '/llms.txt', routeLabel: '/llms.txt', method: 'GET', domain: 'app-level', group: 'app' },
    { routeKey: 'GET /api/v1/skills/:name', routePath: '/api/v1/skills/:name', routeLabel: '/api/v1/skills/:name', method: 'GET', domain: 'discovery', group: 'skills' },
    { routeKey: 'POST /api/v1/agents/register', routePath: '/api/v1/agents/register', routeLabel: '/api/v1/agents/register', method: 'POST', domain: 'identity', group: 'agents' },
  ];

  const layoutA = buildAtlasLayout(routes);
  const layoutB = buildAtlasLayout(routes.map(route => ({ ...route, activeAgents: 99 })));
  const anchorA = layoutA.routeAnchors.get('POST /api/v1/agents/register');
  const anchorB = layoutB.routeAnchors.get('POST /api/v1/agents/register');

  assert.equal(layoutA.routeAnchors.size, routes.length);
  assert.equal(layoutB.routeAnchors.size, routes.length);
  assert.equal(anchorA.x, anchorB.x);
  assert.equal(anchorA.z, anchorB.z);
  assert.equal(anchorA.width, anchorB.width);
  assert.equal(anchorA.depth, anchorB.depth);
});

test('route growth stays inside the cell envelope', () => {
  const cell = { width: 8, depth: 5.5 };
  const visual = computeRouteVisual(cell, 128, 6);

  assert.ok(visual.width <= cell.width * 0.94);
  assert.ok(visual.depth <= cell.depth * 0.94);
  assert.ok(visual.trayCount >= 2);
});

test('slot positions stack into higher trays after capacity', () => {
  const cell = { x: 10, z: -5, width: 7, depth: 5 };
  const visual = computeRouteVisual(cell, 32, 0, { dotDiameter: 0.5 });
  const first = computeSlotPosition(0, cell, visual);
  const overflow = computeSlotPosition(visual.trayCapacity, cell, visual);

  assert.equal(first.trayIndex, 0);
  assert.equal(overflow.trayIndex, 1);
  assert.ok(overflow.y > first.y);
});

test('route signature changes only when route identity changes', () => {
  const baseRoutes = [
    { routeKey: 'GET /a', routePath: '/a', routeLabel: '/a', method: 'GET', domain: 'app-level', group: 'app' },
    { routeKey: 'GET /b', routePath: '/b', routeLabel: '/b', method: 'GET', domain: 'app-level', group: 'app' },
  ];
  const sigA = buildAtlasRouteSignature(baseRoutes);
  const sigB = buildAtlasRouteSignature(baseRoutes.map(route => ({ ...route, activeAgents: 20 })));
  const sigC = buildAtlasRouteSignature([...baseRoutes, { routeKey: 'GET /c', routePath: '/c', routeLabel: '/c', method: 'GET', domain: 'app-level', group: 'app' }]);

  assert.equal(sigA, sigB);
  assert.notEqual(sigA, sigC);
});
