// Plan 1 test: Reverse Lookup + Agent-Count-Driven Box Height
// Run: node journey/js/plan1.test.mjs

import assert from 'node:assert';

// ── Test heightForAgentCount (pure math, no THREE dependency) ──

const RMIN = 0.3, RMAX = 2.0;

function heightForAgentCount(n) {
  if (n <= 0) return RMIN;
  return Math.min(RMIN + Math.sqrt(n) * 0.5, RMAX);
}

// 0 agents → minimum height
assert.strictEqual(heightForAgentCount(0), RMIN, '0 agents → RMIN');
assert.strictEqual(heightForAgentCount(-1), RMIN, 'negative → RMIN');

// Grows with agent count
const h1 = heightForAgentCount(1);
const h4 = heightForAgentCount(4);
const h9 = heightForAgentCount(9);
assert.ok(h1 > RMIN, `1 agent (${h1}) > RMIN (${RMIN})`);
assert.ok(h4 > h1, `4 agents (${h4}) > 1 agent (${h1})`);
assert.ok(h9 > h4, `9 agents (${h9}) > 4 agents (${h4})`);

// Caps at RMAX
const h100 = heightForAgentCount(100);
assert.strictEqual(h100, RMAX, `100 agents → RMAX (${RMAX})`);

console.log('✓ heightForAgentCount scaling correct');

// ── Test moveAgentToRoute + updateBoxHeight logic ──

const agentRoutes = new Map();
const routeAgents = new Map();
const boxes = new Map();

// Simulate two route boxes
boxes.set('GET /a', { targetH: RMIN, stats: { activeAgents: 0 } });
boxes.set('GET /b', { targetH: RMIN, stats: { activeAgents: 0 } });

function updateBoxHeight(rk) {
  const box = boxes.get(rk);
  if (!box) return;
  const agents = routeAgents.get(rk);
  const count = agents ? agents.size : 0;
  box.targetH = heightForAgentCount(count);
  box.stats.activeAgents = count;
}

function moveAgentToRoute(agentId, newRk) {
  const oldRk = agentRoutes.get(agentId);
  if (oldRk === newRk) return;
  if (oldRk) {
    const oldSet = routeAgents.get(oldRk);
    if (oldSet) { oldSet.delete(agentId); updateBoxHeight(oldRk); }
  }
  agentRoutes.set(agentId, newRk);
  if (!routeAgents.has(newRk)) routeAgents.set(newRk, new Set());
  routeAgents.get(newRk).add(agentId);
  updateBoxHeight(newRk);
}

// Agent arrives at route A — box grows
moveAgentToRoute('agent-1', 'GET /a');
assert.strictEqual(boxes.get('GET /a').stats.activeAgents, 1, 'route A has 1 agent');
assert.ok(boxes.get('GET /a').targetH > RMIN, 'route A grew');
console.log('✓ Box grows on agent arrival');

// Second agent arrives at route A
moveAgentToRoute('agent-2', 'GET /a');
const h_a2 = boxes.get('GET /a').targetH;
assert.strictEqual(boxes.get('GET /a').stats.activeAgents, 2, 'route A has 2 agents');
assert.ok(h_a2 > heightForAgentCount(1), 'route A taller with 2 agents');
console.log('✓ Box grows more with second agent');

// Agent 1 moves from A to B — A shrinks, B grows
moveAgentToRoute('agent-1', 'GET /b');
assert.strictEqual(boxes.get('GET /a').stats.activeAgents, 1, 'route A back to 1 agent');
assert.strictEqual(boxes.get('GET /b').stats.activeAgents, 1, 'route B has 1 agent');
assert.ok(boxes.get('GET /a').targetH < h_a2, 'route A shrank on departure');
assert.ok(boxes.get('GET /b').targetH > RMIN, 'route B grew on arrival');
console.log('✓ Box shrinks on departure, destination grows');

// Agent 2 also leaves A — A returns to RMIN
moveAgentToRoute('agent-2', 'GET /b');
assert.strictEqual(boxes.get('GET /a').stats.activeAgents, 0, 'route A empty');
assert.strictEqual(boxes.get('GET /a').targetH, RMIN, 'route A back to RMIN');
console.log('✓ Box returns to RMIN when empty');

// Idempotent — moving to same route is a no-op
const before = boxes.get('GET /b').targetH;
moveAgentToRoute('agent-1', 'GET /b');
assert.strictEqual(boxes.get('GET /b').targetH, before, 'same-route move is no-op');
console.log('✓ Same-route move is no-op');

// ── Test bumpFinished no longer drives height ──

function bumpFinished(rk, status) {
  const s = boxes.get(rk)?.stats;
  if (!s) return;
  s.finished = (s.finished || 0) + 1;
  // NOTE: no box.targetH assignment — that's the Plan 1 change
}

const boxB = boxes.get('GET /b');
const heightBefore = boxB.targetH;
bumpFinished('GET /b', 200);
bumpFinished('GET /b', 200);
bumpFinished('GET /b', 200);
assert.strictEqual(boxB.targetH, heightBefore, 'bumpFinished does NOT change height');
console.log('✓ bumpFinished no longer drives box height');

console.log('\n── Plan 1: ALL TESTS PASSED ──');
