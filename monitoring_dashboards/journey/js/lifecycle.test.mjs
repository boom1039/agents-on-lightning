// Test: Agents NEVER disappear from the dashboard
// Simulates full lifecycle including snapshots, events, and reset scenarios.
// Run: node journey/js/lifecycle.test.mjs

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Verify source code: no release() calls outside AgentMgr definition ──

const eventsSrc = readFileSync(resolve('journey/js/events.js'), 'utf8');
const agentsSrc = readFileSync(resolve('journey/js/agents.js'), 'utf8');

// events.js must NEVER call release()
assert.ok(!eventsSrc.includes('.release('), 'events.js must not call .release()');
console.log('✓ events.js contains zero .release() calls');

// agents.js defines release() but only FlightMgr.land() and updateAgentDrift() should NOT call it
const releaseCallsInAgents = agentsSrc.split('.release(').length - 1;
// One occurrence is the method definition itself: `release(agentId) {`
// Count how many are method definitions vs calls
const releaseDefMatch = agentsSrc.match(/^\s*release\s*\(/m);
assert.ok(releaseDefMatch, 'agents.js defines release() method');
// The only `.release(` should not appear outside the class definition
const outsideClassCalls = agentsSrc.split('agentMgr.release(').length - 1;
assert.strictEqual(outsideClassCalls, 0, 'No code calls agentMgr.release()');
console.log('✓ No code outside AgentMgr calls release()');

// ── Verify applySnapshot uses merge pattern (never releases) ──

assert.ok(eventsSrc.includes('never release existing'), 'applySnapshot has merge comment');
// Extract applySnapshot function body (brace-counting)
const snapStart = eventsSrc.indexOf('function applySnapshot');
let depth = 0, snapEnd = snapStart;
for (let i = snapStart; i < eventsSrc.length; i++) {
  if (eventsSrc[i] === '{') depth++;
  if (eventsSrc[i] === '}') { depth--; if (depth === 0) { snapEnd = i + 1; break; } }
}
const applySnapshotBlock = eventsSrc.slice(snapStart, snapEnd);
assert.ok(!applySnapshotBlock.includes('.release('), 'applySnapshot does not call release()');
assert.ok(!applySnapshotBlock.includes('agents.delete'), 'applySnapshot does not delete from agents map');
console.log('✓ applySnapshot uses merge pattern — never releases agents');

// ── Simulate the event + snapshot lifecycle ──

// Replicate minimal state from events.js
const agentRoutes = new Map();
const routeAgents = new Map();
const routeSlots = new Map();
const agentPool = new Map(); // agentId → { idx, routeKey, phase, slot }

let nextIdx = 0;
const freeList = [];

function acquire(agentId) {
  if (agentPool.has(agentId)) return agentPool.get(agentId);
  let idx;
  if (freeList.length > 0) idx = freeList.pop();
  else idx = nextIdx++;
  const data = { idx, routeKey: null, phase: 0, slot: 0 };
  agentPool.set(agentId, data);
  return data;
}

function release(agentId) {
  const data = agentPool.get(agentId);
  if (!data) return;
  agentPool.delete(agentId);
  freeList.push(data.idx);
}

function getSlotTracker(rk) {
  if (!routeSlots.has(rk)) routeSlots.set(rk, { slots: new Map(), free: [], next: 0 });
  return routeSlots.get(rk);
}

function allocSlot(rk, agentId) {
  const t = getSlotTracker(rk);
  if (t.slots.has(agentId)) return t.slots.get(agentId);
  const slot = t.free.length > 0 ? t.free.pop() : t.next++;
  t.slots.set(agentId, slot);
  return slot;
}

function freeSlot(rk, agentId) {
  const t = routeSlots.get(rk);
  if (!t) return;
  const slot = t.slots.get(agentId);
  if (slot !== undefined) {
    t.slots.delete(agentId);
    t.free.push(slot);
  }
}

function moveAgentToRoute(agentId, newRk) {
  const oldRk = agentRoutes.get(agentId);
  if (oldRk === newRk) return;
  if (oldRk) {
    const oldSet = routeAgents.get(oldRk);
    if (oldSet) {
      oldSet.delete(agentId);
      freeSlot(oldRk, agentId);
    }
  }
  agentRoutes.set(agentId, newRk);
  if (!routeAgents.has(newRk)) routeAgents.set(newRk, new Set());
  routeAgents.get(newRk).add(agentId);
}

// Simulate applySnapshot (MERGE pattern — matches current events.js)
function applySnapshotMerge(snap) {
  for (const agent of snap.agents || []) {
    const data = acquire(agent.id);
    if (!data) continue;
    data.routeKey = agent.routeKey;
    data.phase = agent.phase || 0;
    moveAgentToRoute(agent.id, agent.routeKey);
    data.slot = allocSlot(agent.routeKey, agent.id);
  }
}

// Simulate applyEvent (registration)
function applyRegistration(agentId, routeKey) {
  const data = acquire(agentId);
  if (!data) return;
  data.routeKey = routeKey;
  data.phase = 1;
  moveAgentToRoute(agentId, routeKey);
  data.slot = allocSlot(routeKey, agentId);
}

// Simulate applyEvent (request_start — move to new route)
function applyRequestStart(agentId, routeKey) {
  let data = agentPool.get(agentId);
  if (!data) {
    data = acquire(agentId);
    if (!data) return;
  }
  data.routeKey = routeKey;
  moveAgentToRoute(agentId, routeKey);
  data.slot = allocSlot(routeKey, agentId);
}

// ── Test 1: Agents survive an empty snapshot ──

console.log('\n── Test 1: Empty snapshot does not release agents ──');

applyRegistration('agent-A', 'POST /api/v1/agents/register');
applyRegistration('agent-B', 'POST /api/v1/agents/register');
applyRegistration('agent-C', 'POST /api/v1/agents/register');

assert.strictEqual(agentPool.size, 3, '3 agents in pool before empty snapshot');

// Empty snapshot (what happens when SIMULATE resets server state)
applySnapshotMerge({ agents: [] });

assert.strictEqual(agentPool.size, 3, '3 agents still in pool after empty snapshot');
assert.ok(agentPool.has('agent-A'), 'agent-A survives empty snapshot');
assert.ok(agentPool.has('agent-B'), 'agent-B survives empty snapshot');
assert.ok(agentPool.has('agent-C'), 'agent-C survives empty snapshot');
console.log('✓ All 3 agents survive an empty snapshot');

// ── Test 2: Agents survive a partial snapshot ──

console.log('\n── Test 2: Partial snapshot keeps all agents ──');

applySnapshotMerge({
  agents: [
    { id: 'agent-A', routeKey: 'GET /api/v1/agents/me' },
  ],
});

assert.strictEqual(agentPool.size, 3, '3 agents after partial snapshot');
assert.ok(agentPool.has('agent-A'), 'agent-A present');
assert.ok(agentPool.has('agent-B'), 'agent-B present (not in snapshot, still alive)');
assert.ok(agentPool.has('agent-C'), 'agent-C present (not in snapshot, still alive)');
// agent-A was updated to new route
assert.strictEqual(agentPool.get('agent-A').routeKey, 'GET /api/v1/agents/me', 'agent-A moved to new route');
console.log('✓ All 3 agents survive partial snapshot; agent-A updated');

// ── Test 3: New agents from snapshot are added, old ones kept ──

console.log('\n── Test 3: Snapshot adds new agents, keeps old ──');

applySnapshotMerge({
  agents: [
    { id: 'agent-D', routeKey: 'GET /api/v1/wallet/balance' },
    { id: 'agent-E', routeKey: 'GET /api/v1/wallet/balance' },
  ],
});

assert.strictEqual(agentPool.size, 5, '5 agents total');
assert.ok(agentPool.has('agent-A'), 'agent-A still alive');
assert.ok(agentPool.has('agent-B'), 'agent-B still alive');
assert.ok(agentPool.has('agent-C'), 'agent-C still alive');
assert.ok(agentPool.has('agent-D'), 'agent-D added');
assert.ok(agentPool.has('agent-E'), 'agent-E added');
console.log('✓ 5 agents: 3 old + 2 new from snapshot');

// ── Test 4: Multiple empty snapshots in a row (SSE reconnect scenario) ──

console.log('\n── Test 4: Multiple empty snapshots ──');

for (let i = 0; i < 5; i++) {
  applySnapshotMerge({ agents: [] });
}

assert.strictEqual(agentPool.size, 5, 'All 5 agents survive 5 consecutive empty snapshots');
console.log('✓ 5 empty snapshots in a row: all 5 agents survive');

// ── Test 5: Events after empty snapshot still work ──

console.log('\n── Test 5: Events after empty snapshot ──');

applySnapshotMerge({ agents: [] });
applyRequestStart('agent-A', 'POST /api/v1/market/open');
applyRegistration('agent-F', 'POST /api/v1/agents/register');

assert.strictEqual(agentPool.size, 6, '6 agents total');
assert.strictEqual(agentPool.get('agent-A').routeKey, 'POST /api/v1/market/open', 'agent-A moved via event');
console.log('✓ Events work correctly after empty snapshot');

// ── Test 6: Full simulation cycle (reset → spray → events) ──

console.log('\n── Test 6: Full simulation cycle ──');

const preSimCount = agentPool.size;

// Server resets → empty snapshot
applySnapshotMerge({ agents: [] });
assert.strictEqual(agentPool.size, preSimCount, 'Reset snapshot preserves all agents');

// Spray creates new agents via events
for (let i = 0; i < 20; i++) {
  applyRegistration(`spray-${i}`, 'POST /api/v1/agents/register');
}

assert.strictEqual(agentPool.size, preSimCount + 20, `${preSimCount} old + 20 spray agents`);

// Spray agents move around
for (let i = 0; i < 20; i++) {
  applyRequestStart(`spray-${i}`, 'GET /api/v1/agents/me');
}

// Final snapshot from server (only has spray agents)
applySnapshotMerge({
  agents: Array.from({ length: 20 }, (_, i) => ({
    id: `spray-${i}`,
    routeKey: 'GET /api/v1/agents/me',
  })),
});

// ALL agents must still exist — both old and spray
assert.strictEqual(agentPool.size, preSimCount + 20, 'All agents survive final snapshot');
for (const id of ['agent-A', 'agent-B', 'agent-C', 'agent-D', 'agent-E', 'agent-F']) {
  assert.ok(agentPool.has(id), `${id} survives full simulation cycle`);
}
for (let i = 0; i < 20; i++) {
  assert.ok(agentPool.has(`spray-${i}`), `spray-${i} survives`);
}
console.log(`✓ Full simulation cycle: all ${agentPool.size} agents survive`);

// ── Test 7: Verify the SCORCHED-EARTH pattern WOULD lose agents ──

console.log('\n── Test 7: Prove scorched-earth pattern loses agents ──');

// Replicate the OLD broken applySnapshot that released all agents
const scorchedPool = new Map();
let scorchedNextIdx = 0;
const scorchedFreeList = [];

function scorchedAcquire(id) {
  if (scorchedPool.has(id)) return scorchedPool.get(id);
  const idx = scorchedNextIdx++;
  const data = { idx, routeKey: null };
  scorchedPool.set(id, data);
  return data;
}

function scorchedRelease(id) {
  scorchedPool.delete(id);
}

// Add 5 agents
for (let i = 0; i < 5; i++) {
  const data = scorchedAcquire(`old-${i}`);
  data.routeKey = 'POST /api/v1/agents/register';
}
assert.strictEqual(scorchedPool.size, 5);

// Scorched-earth snapshot: release ALL, re-acquire only snapshot agents
function scorchedApplySnapshot(snap) {
  // This is the OLD broken pattern
  for (const id of scorchedPool.keys()) scorchedRelease(id);
  for (const agent of snap.agents || []) {
    const data = scorchedAcquire(agent.id);
    data.routeKey = agent.routeKey;
  }
}

// Empty snapshot → ALL agents gone
scorchedApplySnapshot({ agents: [] });
assert.strictEqual(scorchedPool.size, 0, 'Scorched-earth: empty snapshot kills all agents');
console.log('✓ Scorched-earth pattern loses all agents on empty snapshot (this is the bug we fixed)');

// ── Test 8: Source code structure verification ──

console.log('\n── Test 8: Source code guards ──');

// Verify positionAgentAtSlot has skipSettle parameter
assert.ok(eventsSrc.includes('positionAgentAtSlot(agentId, rk, skipSettle)'),
  'positionAgentAtSlot accepts skipSettle parameter');

// Verify applySnapshot passes skipSettle=true for existing agents
assert.ok(eventsSrc.includes('positionAgentAtSlot(agent.id, agent.routeKey, existing)'),
  'applySnapshot passes existing flag as skipSettle');

// Verify all event handlers allocate slots
assert.ok(eventsSrc.includes("const slot = allocSlot(toKey, ev.agent_id)"),
  'request_start allocates slot for flights');
assert.ok(eventsSrc.includes("const slot = allocSlot(rk, ev.agent_id)"),
  'request_finish allocates slot');

// Verify startSettle is imported and used
assert.ok(eventsSrc.includes("import { agentMgr, flightMgr, startSettle }"),
  'startSettle imported from agents.js');

console.log('✓ All source code guards verified');

console.log(`\n── Lifecycle: ALL TESTS PASSED (${agentPool.size} agents, zero lost) ──`);
