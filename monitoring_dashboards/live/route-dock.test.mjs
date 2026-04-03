import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DOCK_HOLE_TTL_MS,
  computeDockSlotPosition,
  computeDockVisual,
  syncDockSlots,
} from './route-dock.mjs';

const anchor = {
  x: 0,
  z: 0,
  baseY: 0.4,
  envelopeWidth: 4.2,
  envelopeDepth: 2.8,
  pegRadius: 0.14,
};

test('dock growth bands expand by occupancy', () => {
  const idle = computeDockVisual(anchor, { occupancy: 0, inFlight: 0 });
  const low = computeDockVisual(anchor, { occupancy: 3, inFlight: 0 });
  const medium = computeDockVisual(anchor, { occupancy: 8, inFlight: 0 });
  const high = computeDockVisual(anchor, { occupancy: 18, inFlight: 1 });

  assert.ok(idle.floorWidth < low.floorWidth);
  assert.ok(low.floorWidth < medium.floorWidth);
  assert.ok(medium.floorWidth <= high.floorWidth);
  assert.ok(high.trayCount >= 1);
});

test('new arrivals append after open holes', () => {
  const previous = [
    { agentId: 'a', vacatedAt: null },
    { agentId: null, vacatedAt: 1_000 },
    { agentId: 'b', vacatedAt: null },
  ];
  const synced = syncDockSlots(previous, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], 5_000, {
    holeTtlMs: DOCK_HOLE_TTL_MS,
    levelCapacity: 4,
  });

  assert.deepEqual(synced.slots.map((slot) => slot.agentId), ['a', null, 'b', 'c']);
});

test('expired holes compact forward inside the tray', () => {
  const previous = [
    { agentId: 'a', vacatedAt: null },
    { agentId: null, vacatedAt: 0 },
    { agentId: 'b', vacatedAt: null },
    { agentId: 'c', vacatedAt: null },
  ];
  const synced = syncDockSlots(previous, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], DOCK_HOLE_TTL_MS + 50, {
    holeTtlMs: DOCK_HOLE_TTL_MS,
    levelCapacity: 4,
  });

  assert.deepEqual(synced.slots.map((slot) => slot.agentId), ['a', 'b', 'c']);
});

test('slot positions stack upward on higher tray levels', () => {
  const visual = computeDockVisual(anchor, { occupancy: 24, inFlight: 0 });
  const first = computeDockSlotPosition(0, anchor, visual);
  const later = computeDockSlotPosition(visual.levelCapacity, anchor, visual);

  assert.ok(later.y > first.y);
  assert.ok(Number.isFinite(first.x));
  assert.ok(Number.isFinite(later.z));
});
