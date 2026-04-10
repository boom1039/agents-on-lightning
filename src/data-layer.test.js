import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DataLayer } from './data-layer.js';

test('readRuntimeStateJSON repairs a zero-byte runtime state file and quarantines the original', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'aol-data-layer-'));
  const dataLayer = new DataLayer(baseDir);
  const relPath = 'data/security/rate-limits.json';
  const absDir = join(baseDir, 'data/security');
  const absPath = join(absDir, 'rate-limits.json');

  await mkdir(absDir, { recursive: true });
  await writeFile(absPath, '', 'utf-8');

  const fallback = await dataLayer.readRuntimeStateJSON(relPath, {
    defaultValue: () => ({ counters: {}, globalCounter: { count: 0, windowStart: 123 } }),
  });

  assert.deepEqual(fallback, {
    counters: {},
    globalCounter: { count: 0, windowStart: 123 },
  });

  const repaired = JSON.parse(await readFile(absPath, 'utf-8'));
  assert.deepEqual(repaired, fallback);

  const entries = await readdir(absDir);
  const quarantineFiles = entries.filter((name) => name.startsWith('rate-limits.json.corrupt-'));
  assert.equal(quarantineFiles.length, 1);
});

test('readRuntimeStateJSON returns a default value for a missing runtime state file', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'aol-data-layer-'));
  const dataLayer = new DataLayer(baseDir);

  const state = await dataLayer.readRuntimeStateJSON('data/channel-market/performance-uptime.json', {
    defaultValue: { _uptimeCounters: {} },
  });

  assert.deepEqual(state, { _uptimeCounters: {} });
});
