import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DataLayer } from '../data-layer.js';
import {
  checkAndIncrement,
  configureRateLimiterPersistence,
  disableRateLimiterPersistence,
} from './rate-limiter.js';

test('persistent rate limiter recovers from a zero-byte runtime state file', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'aol-rate-limit-'));
  const dataLayer = new DataLayer(baseDir);
  const relPath = 'data/security/rate-limits.json';
  const absDir = join(baseDir, 'data/security');
  const absPath = join(absDir, 'rate-limits.json');

  await mkdir(absDir, { recursive: true });
  await writeFile(absPath, '', 'utf-8');

  configureRateLimiterPersistence({
    dataLayer,
    path: relPath,
    mutex: { acquire: async () => () => {} },
  });

  try {
    const result = await checkAndIncrement('mcp:ip:test', 5, 60_000);
    assert.equal(result.allowed, true);

    const persisted = JSON.parse(await readFile(absPath, 'utf-8'));
    assert.equal(persisted.counters['mcp:ip:test'].count, 1);
  } finally {
    disableRateLimiterPersistence();
  }
});
