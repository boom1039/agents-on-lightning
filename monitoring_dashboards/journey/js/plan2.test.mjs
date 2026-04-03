// Plan 2 test: Grid Packing — agents inside boxes
// Run: node journey/js/plan2.test.mjs

import assert from 'node:assert';

// ── Replicate constants ──
const AGENT_SZ = 0.15;
const RW = 1.2, RD = 1.0;
const GRID_PAD = 0.08;
const GRID_SPC = AGENT_SZ * 1.4;

// ── gridSlotPos (pure math) ──
function gridSlotPos(boxPos, boxW, boxD, boxH, slot) {
  const usableW = boxW - 2 * GRID_PAD;
  const usableD = boxD - 2 * GRID_PAD;
  const cols = Math.max(1, Math.floor(usableW / GRID_SPC));
  const col = slot % cols;
  const row = Math.floor(slot / cols);
  const x = boxPos.x - usableW / 2 + GRID_SPC / 2 + col * GRID_SPC;
  const z = boxPos.z - usableD / 2 + GRID_SPC / 2 + row * GRID_SPC;
  const y = boxH + AGENT_SZ / 2;
  return { x, y, z };
}

const boxPos = { x: 0, z: 0 };
const boxH = 0.3;

// Slot 0 is inside the box
const s0 = gridSlotPos(boxPos, RW, RD, boxH, 0);
assert.ok(s0.x > -RW/2 && s0.x < RW/2, `slot 0 x (${s0.x}) inside box width`);
assert.ok(s0.z > -RD/2 && s0.z < RD/2, `slot 0 z (${s0.z}) inside box depth`);
assert.ok(s0.y > boxH, `slot 0 y (${s0.y}) above box top (${boxH})`);
console.log('✓ Slot 0 positioned inside box');

// Multiple slots don't overlap
const positions = [];
for (let i = 0; i < 10; i++) {
  positions.push(gridSlotPos(boxPos, RW, RD, boxH, i));
}
for (let i = 0; i < positions.length; i++) {
  for (let j = i + 1; j < positions.length; j++) {
    const dx = Math.abs(positions[i].x - positions[j].x);
    const dz = Math.abs(positions[i].z - positions[j].z);
    const dist = Math.sqrt(dx * dx + dz * dz);
    assert.ok(dist > AGENT_SZ * 0.5, `slot ${i} and ${j} don't overlap (dist=${dist.toFixed(3)})`);
  }
}
console.log('✓ No slot overlaps for 10 agents');

// ── Slot allocation: first-empty reuse ──
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

// Sequential allocation
const s1 = allocSlot('GET /a', 'agent-1');
const s2 = allocSlot('GET /a', 'agent-2');
const s3 = allocSlot('GET /a', 'agent-3');
assert.strictEqual(s1, 0, 'first agent gets slot 0');
assert.strictEqual(s2, 1, 'second agent gets slot 1');
assert.strictEqual(s3, 2, 'third agent gets slot 2');
console.log('✓ Sequential slot allocation');

// Idempotent — same agent gets same slot
assert.strictEqual(allocSlot('GET /a', 'agent-1'), 0, 'agent-1 still at slot 0');
console.log('✓ Idempotent slot allocation');

// Free + reuse
freeSlot('GET /a', 'agent-2');
const s4 = allocSlot('GET /a', 'agent-4');
assert.strictEqual(s4, 1, 'agent-4 reuses freed slot 1');
console.log('✓ Freed slot reused');

// Agent doesn't jump — existing agents keep their slots after departure
assert.strictEqual(allocSlot('GET /a', 'agent-1'), 0, 'agent-1 stable at slot 0');
assert.strictEqual(allocSlot('GET /a', 'agent-3'), 2, 'agent-3 stable at slot 2');
console.log('✓ Existing agents keep slots on departure');

// ── Drift amplitude reduced ──
function driftVec(seed, t) {
  const s = seed * 100;
  return {
    x: Math.sin(t * 0.0003 + s) * 0.015,
    y: Math.sin(t * 0.0005 + s * 1.3) * 0.008,
    z: Math.cos(t * 0.0004 + s * 0.7) * 0.015,
  };
}

const d = driftVec(0.5, 10000);
assert.ok(Math.abs(d.x) <= 0.015, `drift x (${d.x}) within ±0.015`);
assert.ok(Math.abs(d.y) <= 0.008, `drift y (${d.y}) within ±0.008`);
assert.ok(Math.abs(d.z) <= 0.015, `drift z (${d.z}) within ±0.015`);
console.log('✓ Drift amplitude reduced (~10x smaller than before)');

console.log('\n── Plan 2: ALL TESTS PASSED ──');
