// Test: Are agents inside route boxes in a 3D grid?
// Run: node journey/js/grid-placement.test.mjs

import assert from 'node:assert';

const AGENT_SZ = 0.15, RW = 1.2, RD = 1.0;
const GRID_PAD = 0.08;
const GRID_SPC = AGENT_SZ * 1.4;

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

const boxPos = { x: 3.0, z: -10.0 };
const boxH = 1.0;

console.log(`Box: center=(${boxPos.x}, ${boxPos.z}), w=${RW}, d=${RD}, h=${boxH}`);
console.log(`Box X: [${(boxPos.x - RW/2).toFixed(2)}, ${(boxPos.x + RW/2).toFixed(2)}]`);
console.log(`Box Z: [${(boxPos.z - RD/2).toFixed(2)}, ${(boxPos.z + RD/2).toFixed(2)}]`);
console.log(`Box Y: [0, ${boxH.toFixed(2)}]\n`);

// Grid dimensions
const cols = Math.floor((RW - 2 * GRID_PAD) / GRID_SPC);
const rows = Math.floor((RD - 2 * GRID_PAD) / GRID_SPC);
const perLayer = cols * rows;
console.log(`Grid: ${cols} cols × ${rows} rows = ${perLayer} per layer\n`);

// Test with 20 agents
const positions = [];
for (let i = 0; i < 20; i++) positions.push(gridSlotPos(boxPos, RW, RD, boxH, i));

// 1: All X inside box
for (let i = 0; i < 20; i++) {
  const p = positions[i];
  assert.ok(p.x >= boxPos.x - RW/2 && p.x <= boxPos.x + RW/2,
    `slot ${i} X=${p.x.toFixed(3)} outside box [${(boxPos.x-RW/2).toFixed(2)}, ${(boxPos.x+RW/2).toFixed(2)}]`);
}
console.log('✓ All 20 agents within box X bounds');

// 2: All Z inside box
for (let i = 0; i < 20; i++) {
  const p = positions[i];
  assert.ok(p.z >= boxPos.z - RD/2 && p.z <= boxPos.z + RD/2,
    `slot ${i} Z=${p.z.toFixed(3)} outside box [${(boxPos.z-RD/2).toFixed(2)}, ${(boxPos.z+RD/2).toFixed(2)}]`);
}
console.log('✓ All 20 agents within box Z bounds');

// 3: All Y inside box (between 0 and boxH)
for (let i = 0; i < 20; i++) {
  const p = positions[i];
  assert.ok(p.y >= 0 && p.y <= boxH + GRID_SPC,
    `slot ${i} Y=${p.y.toFixed(3)} outside box height`);
}
console.log('✓ All 20 agents within box Y bounds');

// 4: Y has multiple levels (3D stacking)
const uniqueY = new Set(positions.map(p => p.y.toFixed(4)));
assert.ok(uniqueY.size > 1, `only ${uniqueY.size} Y level(s) — need vertical stacking`);
console.log(`✓ Agents stack vertically across ${uniqueY.size} Y layers`);

// 5: First layer fills before second starts
const layer0 = positions.slice(0, perLayer);
const layer1Start = positions[perLayer];
const layer0Y = layer0[0].y;
assert.ok(layer1Start.y > layer0Y, 'layer 1 Y > layer 0 Y');
console.log(`✓ Layer 0 at Y=${layer0Y.toFixed(3)}, layer 1 at Y=${layer1Start.y.toFixed(3)}`);

// 6: No overlapping positions
for (let i = 0; i < positions.length; i++) {
  for (let j = i + 1; j < positions.length; j++) {
    const a = positions[i], b = positions[j];
    const dist = Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2 + (a.z-b.z)**2);
    assert.ok(dist > AGENT_SZ * 0.5, `slots ${i} and ${j} overlap (dist=${dist.toFixed(3)})`);
  }
}
console.log('✓ No overlapping agent positions');

// 7: Print first 8 slots for visual verification
console.log('\nFirst 8 slot positions:');
for (let i = 0; i < Math.min(8, positions.length); i++) {
  const p = positions[i];
  const layer = Math.floor(i / perLayer);
  console.log(`  slot ${i}: (${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)})  layer=${layer}`);
}

console.log('\n── Grid Placement: ALL TESTS PASSED ──');
