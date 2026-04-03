// Test: No two agents ever share a slot or grid position at the same route
// Run: node journey/js/slot-overlap.test.mjs

import assert from 'node:assert';

// ── Replicate slot allocation from events.js ──
const AGENT_SZ = 0.15, RW = 1.2, RD = 1.0;
const GRID_PAD = 0.08, GRID_SPC = AGENT_SZ * 1.4;

const routeSlots = new Map();

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

function gridSlotPos(boxPos, boxW, boxD, boxH, slot) {
  const usableW = boxW - 2 * GRID_PAD;
  const usableD = boxD - 2 * GRID_PAD;
  const cols = Math.max(1, Math.floor(usableW / GRID_SPC));
  const rows = Math.max(1, Math.floor(usableD / GRID_SPC));
  const perLayer = cols * rows;
  const layer = Math.floor(slot / perLayer);
  const inLayer = slot % perLayer;
  const col = inLayer % cols;
  const row = Math.floor(inLayer / cols);
  const x = boxPos.x - usableW / 2 + GRID_SPC / 2 + col * GRID_SPC;
  const z = boxPos.z - usableD / 2 + GRID_SPC / 2 + row * GRID_SPC;
  const y = GRID_PAD + AGENT_SZ / 2 + layer * GRID_SPC;
  return { x, y, z };
}

const boxPos = { x: 5.0, z: -12.0 };
const boxH = 1.5;
const rk = 'POST /api/v1/agents/register';

// ── Test 1: 20 agents at same route, all unique slots ──
const agents = [];
for (let i = 0; i < 20; i++) agents.push(`agent-${i}`);

const slots = [];
for (const a of agents) slots.push(allocSlot(rk, a));

const uniqueSlots = new Set(slots);
assert.strictEqual(uniqueSlots.size, 20, `Expected 20 unique slots, got ${uniqueSlots.size}`);
console.log('✓ 20 agents at same route: all slots unique');

// ── Test 2: All 20 positions are distinct ──
const positions = slots.map(s => gridSlotPos(boxPos, RW, RD, boxH, s));
for (let i = 0; i < positions.length; i++) {
  for (let j = i + 1; j < positions.length; j++) {
    const a = positions[i], b = positions[j];
    const dist = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
    assert.ok(dist > AGENT_SZ * 0.5,
      `agents ${i} (slot ${slots[i]}) and ${j} (slot ${slots[j]}) overlap at dist=${dist.toFixed(4)}`);
  }
}
console.log('✓ 20 agents: no positions overlap');

// ── Test 3: Agents span multiple layers ──
const cols = Math.floor((RW - 2 * GRID_PAD) / GRID_SPC);
const rows = Math.floor((RD - 2 * GRID_PAD) / GRID_SPC);
const perLayer = cols * rows;
console.log(`  Grid: ${cols}×${rows} = ${perLayer} per layer`);

const layers = new Set(slots.map(s => Math.floor(s / perLayer)));
assert.ok(layers.size >= 2, `Expected ≥2 layers with 20 agents, got ${layers.size}`);
console.log(`✓ Agents span ${layers.size} layers`);

// ── Test 4: Idempotent — re-allocating same agent returns same slot ──
const s0 = allocSlot(rk, 'agent-0');
assert.strictEqual(s0, slots[0], 'Re-allocating agent-0 returns same slot');
console.log('✓ Re-allocation is idempotent');

// ── Test 5: Free + re-alloc gives freed slot to NEW agent ──
freeSlot(rk, 'agent-5');
const freedSlot = slots[5];
const newSlot = allocSlot(rk, 'agent-new');
assert.strictEqual(newSlot, freedSlot, `New agent should get freed slot ${freedSlot}, got ${newSlot}`);
console.log('✓ Freed slot reused by next arrival');

// Verify no overlap still holds
const finalSlots = [];
for (const a of [...agents.filter(a => a !== 'agent-5'), 'agent-new']) {
  const t = getSlotTracker(rk);
  const s = t.slots.get(a);
  if (s !== undefined) finalSlots.push(s);
}
const finalUnique = new Set(finalSlots);
assert.strictEqual(finalUnique.size, finalSlots.length, 'All slots still unique after free+realloc');
console.log('✓ No duplicates after free+realloc');

// ── Test 6: Cross-route move — old slot freed, new slot unique ──
const rk2 = 'GET /api/v1/agents/me';
routeSlots.clear();

// Put 5 agents at rk
for (let i = 0; i < 5; i++) allocSlot(rk, `a${i}`);
// Put 3 agents at rk2
for (let i = 0; i < 3; i++) allocSlot(rk2, `b${i}`);

// Move a2 from rk → rk2 (simulating cross-route flight)
freeSlot(rk, 'a2');
const a2NewSlot = allocSlot(rk2, 'a2');

// Verify a2's new slot doesn't collide with existing rk2 agents
const rk2Tracker = getSlotTracker(rk2);
const rk2Slots = [...rk2Tracker.slots.values()];
const rk2Unique = new Set(rk2Slots);
assert.strictEqual(rk2Unique.size, rk2Slots.length, 'All rk2 slots unique after move');
console.log('✓ Cross-route move: no slot collision at destination');

// Verify positions at rk2 are all distinct
const rk2Positions = rk2Slots.map(s => gridSlotPos({ x: 10, z: -5 }, RW, RD, boxH, s));
for (let i = 0; i < rk2Positions.length; i++) {
  for (let j = i + 1; j < rk2Positions.length; j++) {
    const a = rk2Positions[i], b = rk2Positions[j];
    const dist = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
    assert.ok(dist > AGENT_SZ * 0.5, `rk2 positions ${i} and ${j} overlap`);
  }
}
console.log('✓ Cross-route move: no position overlap at destination');

// ── Test 7: Verify layer stacking Y values ──
routeSlots.clear();
const manySlots = [];
for (let i = 0; i < 40; i++) manySlots.push(allocSlot(rk, `m${i}`));

const manyPos = manySlots.map(s => gridSlotPos(boxPos, RW, RD, boxH, s));
const yValues = [...new Set(manyPos.map(p => p.y.toFixed(4)))].sort();
assert.ok(yValues.length >= 3, `Expected ≥3 Y layers for 40 agents, got ${yValues.length}: [${yValues.join(', ')}]`);
console.log(`✓ 40 agents stack across ${yValues.length} Y layers: [${yValues.join(', ')}]`);

// Verify no two agents share exact position
for (let i = 0; i < manyPos.length; i++) {
  for (let j = i + 1; j < manyPos.length; j++) {
    const a = manyPos[i], b = manyPos[j];
    const dist = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
    assert.ok(dist > AGENT_SZ * 0.3,
      `40-agent test: slots ${manySlots[i]} and ${manySlots[j]} overlap (dist=${dist.toFixed(4)})`);
  }
}
console.log('✓ 40 agents: zero overlapping positions');

console.log('\n── Slot Overlap: ALL TESTS PASSED ──');
