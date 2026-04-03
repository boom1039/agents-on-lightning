// Plan 5 test: Tooltip + Polish
// Run: node journey/js/plan5.test.mjs

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const base = resolve('journey/js');

// ── Test tooltip shows live agent count + box size ──
const interactionSrc = readFileSync(resolve(base, 'interaction.js'), 'utf8');

assert.ok(interactionSrc.includes('Agents inside:'), 'route tooltip shows "Agents inside:" (live count)');
assert.ok(!interactionSrc.includes('rb.curW'), 'route tooltip does not reference removed curW');
assert.ok(interactionSrc.includes('rb.curH.toFixed'), 'route tooltip shows current box height');
console.log('✓ Route tooltip shows live agent count + box height');

assert.ok(interactionSrc.includes('data.slot'), 'agent tooltip shows slot number');
console.log('✓ Agent tooltip shows grid slot');

// ── Test style dump includes agentShape ──
assert.ok(interactionSrc.includes('agentShape: agentMgr.shapeName'), 'style dump includes agentShape');
console.log('✓ Style dump (S key) includes agentShape');

// ── Test HUD uses agentMgr.agents for phase badges ──
const hudSrc = readFileSync(resolve(base, 'hud.js'), 'utf8');
assert.ok(hudSrc.includes('agentMgr.agents'), 'HUD counts agents from agentMgr');
assert.ok(hudSrc.includes('data.phase'), 'HUD groups agents by phase');
console.log('✓ HUD phase badges count live agents');

// ── Test style panel has shape picker ──
const styleSrc = readFileSync(resolve(base, 'style-panel.js'), 'utf8');
assert.ok(styleSrc.includes('agentShape'), 'style panel has agentShape knob');
assert.ok(styleSrc.includes('SHAPE_NAMES'), 'style panel imports SHAPE_NAMES');
assert.ok(styleSrc.includes('swapGeometry'), 'style panel calls swapGeometry');
console.log('✓ Style panel has shape picker dropdown');

// ── Verify all module imports resolve (no missing exports) ──
const files = ['constants.js', 'manifest.js', 'scene.js', 'layout.js', 'builder.js',
               'agents.js', 'events.js', 'interaction.js', 'hud.js', 'style-panel.js'];

for (const f of files) {
  const src = readFileSync(resolve(base, f), 'utf8');
  const imports = [...src.matchAll(/import\s+\{([^}]+)\}\s+from\s+'\.\/(\w+)\.js'/g)];
  for (const m of imports) {
    const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
    const targetFile = m[2] + '.js';
    const targetSrc = readFileSync(resolve(base, targetFile), 'utf8');
    for (const name of names) {
      // Match: export const NAME, export function NAME, or NAME in a comma-separated export const line
      const directExport =
        targetSrc.includes(`export const ${name} `) ||
        targetSrc.includes(`export const ${name}=`) ||
        targetSrc.includes(`export function ${name}`) ||
        targetSrc.includes(`export class ${name}`) ||
        targetSrc.includes(`export { ${name}`) ||
        targetSrc.includes(`export let ${name}`);
      // Also check comma-separated: export const A = 1, B = 2, NAME = 3;
      const commaExport = new RegExp(`export const [^;]*\\b${name}\\b`).test(targetSrc);
      assert.ok(
        directExport || commaExport,
        `${f} imports "${name}" from ${targetFile} — must be exported`
      );
    }
  }
}
console.log('✓ All cross-module imports resolve');

// ── Verify no stale references to old function names ──
const allSrc = files.map(f => readFileSync(resolve(base, f), 'utf8')).join('\n');
assert.ok(!allSrc.includes('updateRouteBoxSizes'), 'no references to removed updateRouteBoxSizes');
assert.ok(!allSrc.includes('heightForCount('), 'no references to old heightForCount (replaced by heightForAgentCount)');
assert.ok(!allSrc.includes('widthForAgentCount'), 'no references to removed widthForAgentCount');
assert.ok(!allSrc.includes('RWMAX'), 'no references to removed RWMAX');
console.log('✓ No stale function references');

console.log('\n── Plan 5: ALL TESTS PASSED ──');
