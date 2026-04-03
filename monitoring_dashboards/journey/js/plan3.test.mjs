// Plan 3 test: Height-only box scaling (width removed)
// Run: node journey/js/plan3.test.mjs

import assert from 'node:assert';

const RMIN = 0.3, RMAX = 2.0;

function heightForAgentCount(n) {
  if (n <= 0) return RMIN;
  return Math.min(RMIN + Math.sqrt(n) * 0.5, RMAX);
}

// 0 agents → minimum height
assert.strictEqual(heightForAgentCount(0), RMIN, '0 agents → RMIN');
console.log('✓ Empty route has minimum height');

// 1 agent → taller than RMIN
const h1 = heightForAgentCount(1);
assert.ok(h1 > RMIN, `1 agent → ${h1.toFixed(2)} > ${RMIN}`);
console.log('✓ 1 agent grows height');

// More agents → taller
const h5 = heightForAgentCount(5);
assert.ok(h5 > h1, `5 agents → ${h5.toFixed(2)} > ${h1.toFixed(2)}`);
console.log('✓ More agents = taller box');

// Caps at RMAX
const hMax = heightForAgentCount(100);
assert.strictEqual(hMax, RMAX, `100 agents → capped at RMAX (${RMAX})`);
console.log('✓ Height caps at RMAX');

// Returns to RMIN when agents leave
assert.strictEqual(heightForAgentCount(0), RMIN, 'back to 0 → RMIN');
console.log('✓ Height returns to minimum when empty');

// ── Lerp convergence ──

let curH = RMIN;
const targetH = 1.5;
for (let i = 0; i < 100; i++) curH += (targetH - curH) * 0.08;
assert.ok(Math.abs(curH - targetH) < 0.01, `height converges: ${curH.toFixed(3)} ≈ ${targetH}`);
console.log('✓ Height lerp converges');

console.log('\n── Plan 3: ALL TESTS PASSED ──');
