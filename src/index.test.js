import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution } from './index.js';

test('isDirectExecution treats symlinked entrypoints as direct execution', () => {
  const realModulePath = fileURLToPath(new URL('./index.js', import.meta.url));
  const tempDir = mkdtempSync(join(tmpdir(), 'aol-index-main-'));
  const symlinkPath = join(tempDir, 'index-link.js');

  try {
    symlinkSync(realModulePath, symlinkPath);
    assert.equal(isDirectExecution(new URL('./index.js', import.meta.url), symlinkPath), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('isDirectExecution returns false for other entrypoints', () => {
  assert.equal(isDirectExecution(new URL('./index.js', import.meta.url), '/tmp/not-the-app.js'), false);
});
