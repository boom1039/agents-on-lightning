import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataLayer } from '../data-layer.js';
import { DedupCache } from './dedup-cache.js';

test('persistent dedup cache survives a restart-like reload', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'aol-dedup-'));
  try {
    const dataLayer = new DataLayer(tempDir);
    const path = 'data/security/test-dedup.json';

    const firstCache = new DedupCache(60_000, { dataLayer, path });
    await firstCache.mark('hash-1');
    assert.equal(await firstCache.has('hash-1'), true);

    const secondCache = new DedupCache(60_000, { dataLayer, path });
    assert.equal(await secondCache.has('hash-1'), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
