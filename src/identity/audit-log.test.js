import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDocKind, getTrackedRequestMeta } from './audit-log.js';

test('classifyDocKind marks the markdown root doc correctly', () => {
  assert.equal(classifyDocKind('/', 'text/markdown'), 'root-markdown');
  assert.equal(classifyDocKind('/llms.txt', '*/*'), 'root');
  assert.equal(classifyDocKind('/docs/skills/market.txt', '*/*'), 'skill-static');
  assert.equal(classifyDocKind('/api/v1/knowledge/strategy', '*/*'), 'knowledge-api');
});

test('getTrackedRequestMeta keeps the full static docs path from originalUrl', () => {
  const meta = getTrackedRequestMeta({
    originalUrl: '/docs/skills/market.txt?cacheBust=1',
    path: '/skills/market.txt',
    headers: { accept: '*/*' },
  });

  assert.equal(meta.tracked, true);
  assert.equal(meta.originalPath, '/docs/skills/market.txt');
  assert.equal(meta.doc_kind, 'skill-static');
});

test('getTrackedRequestMeta only marks root docs when markdown is requested', () => {
  const docMeta = getTrackedRequestMeta({
    originalUrl: '/',
    path: '/',
    headers: { accept: 'text/markdown' },
  });
  const jsonMeta = getTrackedRequestMeta({
    originalUrl: '/',
    path: '/',
    headers: { accept: 'application/json' },
  });

  assert.equal(docMeta.doc_kind, 'root-markdown');
  assert.equal(jsonMeta.doc_kind, null);
});
