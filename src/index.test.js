import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getJourneyDbPath, isDirectExecution } from './index.js';

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

test('getJourneyDbPath keeps analytics state under AOL_DATA_DIR by default', () => {
  const dataDir = join(tmpdir(), 'aol-data-root');
  assert.equal(
    getJourneyDbPath({ AOL_DATA_DIR: dataDir }),
    join(dataDir, 'data', 'journey-analytics.duckdb'),
  );
});

test('getJourneyDbPath lets explicit journey DB path override AOL_DATA_DIR', () => {
  assert.equal(
    getJourneyDbPath({
      AOL_DATA_DIR: '/wrong',
      AOL_JOURNEY_DB_PATH: '/persistent/journey.duckdb',
    }),
    '/persistent/journey.duckdb',
  );
});
