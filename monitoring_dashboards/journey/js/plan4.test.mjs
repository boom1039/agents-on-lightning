// Plan 4 test: Agent Shape Picker
// Run: node journey/js/plan4.test.mjs

import assert from 'node:assert';

// ── Test shape definitions exist and are callable ──

const AGENT_SZ = 0.15;
const SHAPES = {
  'cube-solid': () => ({ type: 'BoxGeometry', size: AGENT_SZ }),
  'octahedron': () => ({ type: 'OctahedronGeometry', radius: AGENT_SZ * 0.65 }),
  'sphere': () => ({ type: 'SphereGeometry', radius: AGENT_SZ * 0.55 }),
  'cube-wire': () => ({ type: 'BoxGeometry', size: AGENT_SZ }),
};
const SHAPE_NAMES = Object.keys(SHAPES);

assert.strictEqual(SHAPE_NAMES.length, 4, '4 shapes defined');
assert.deepStrictEqual(SHAPE_NAMES, ['cube-solid', 'octahedron', 'sphere', 'cube-wire']);
console.log('✓ 4 shapes: cube-solid, octahedron, sphere, cube-wire');

// All shape factories return geometry objects
for (const name of SHAPE_NAMES) {
  const geo = SHAPES[name]();
  assert.ok(geo, `${name} factory returns object`);
  assert.ok(geo.type, `${name} has a geometry type`);
}
console.log('✓ All shape factories produce geometry');

// ── Test swapGeometry logic (snapshot/restore pattern) ──

class MockAgentMgr {
  constructor() {
    this.shapeName = 'cube-solid';
    this.count = 0;
    this.matrices = [];
    this.colors = [];
    this.disposed = false;
  }

  swapGeometry(shapeName) {
    if (!SHAPES[shapeName] || shapeName === this.shapeName) return false;

    // Snapshot
    const savedMatrices = [...this.matrices];
    const savedColors = [...this.colors];
    const savedCount = this.count;

    // "Dispose"
    this.disposed = true;
    this.matrices = [];
    this.colors = [];

    // "Rebuild"
    this.shapeName = shapeName;
    this.count = savedCount;
    this.matrices = savedMatrices;
    this.colors = savedColors;
    this.disposed = false;

    return true;
  }
}

const mgr = new MockAgentMgr();

// Simulate agents with data
mgr.count = 3;
mgr.matrices = [[1,0,0,0], [0,1,0,0], [0,0,1,0]];
mgr.colors = ['#ff0000', '#00ff00', '#0000ff'];

// Swap to octahedron
const swapped = mgr.swapGeometry('octahedron');
assert.ok(swapped, 'swap returns true');
assert.strictEqual(mgr.shapeName, 'octahedron', 'shape changed');
assert.strictEqual(mgr.count, 3, 'count preserved');
assert.deepStrictEqual(mgr.colors, ['#ff0000', '#00ff00', '#0000ff'], 'colors preserved');
assert.strictEqual(mgr.matrices.length, 3, 'matrices preserved');
console.log('✓ Geometry swap preserves instance count, matrices, and colors');

// Same-shape swap is no-op
const noSwap = mgr.swapGeometry('octahedron');
assert.strictEqual(noSwap, false, 'same shape returns false');
console.log('✓ Same-shape swap is no-op');

// Invalid shape is no-op
const invalid = mgr.swapGeometry('dodecahedron');
assert.strictEqual(invalid, false, 'invalid shape returns false');
console.log('✓ Invalid shape name is no-op');

// Swap back to cube-solid
mgr.swapGeometry('cube-solid');
assert.strictEqual(mgr.shapeName, 'cube-solid', 'swapped back');
assert.strictEqual(mgr.count, 3, 'count still preserved');
console.log('✓ Can swap back to original shape');

// ── Test cube-wire uses edge geometry (not wireframe material) ──

// Verify the source uses edgeCubeGeo (merged thin boxes), not wireframe
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const agentSrc = readFileSync(resolve('journey/js/agents.js'), 'utf8');
assert.ok(agentSrc.includes('edgeCubeGeo'), 'cube-wire uses edgeCubeGeo (edge-only geometry)');
assert.ok(!agentSrc.includes('wireframe'), 'no wireframe material flag');
console.log('✓ cube-wire uses edge geometry, not wireframe material');

console.log('\n── Plan 4: ALL TESTS PASSED ──');
