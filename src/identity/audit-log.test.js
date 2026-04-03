import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDocKind,
  getAuditLogPolicy,
  getTrackedRequestMeta,
  pruneAuditLogText,
} from './audit-log.js';

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

test('getAuditLogPolicy defaults to seven days and 100MB cap', () => {
  const policy = getAuditLogPolicy({});

  assert.equal(policy.retentionDays, 7);
  assert.equal(policy.maxBytes, 100 * 1024 * 1024);
  assert.equal(policy.warnBytes, 80 * 1024 * 1024);
});

test('pruneAuditLogText drops expired rows and trims oldest rows over cap', () => {
  const now = 1_000_000;
  const mkLine = (idx, ts, extra = '') => JSON.stringify({
    event: 'api_request',
    method: 'GET',
    path: `/api/v1/test/${idx}`,
    status: 200,
    _ts: ts,
    extra,
  });

  const oldLine = mkLine('old', now - 8 * 24 * 60 * 60 * 1000);
  const keep1 = mkLine('keep-1', now - 2_000, 'a'.repeat(40));
  const keep2 = mkLine('keep-2', now - 1_000, 'b'.repeat(40));
  const keep3 = mkLine('keep-3', now, 'c'.repeat(40));

  const text = `${oldLine}\n${keep1}\n${keep2}\n${keep3}\n`;
  const maxBytes = Buffer.byteLength(`${keep2}\n${keep3}\n`);
  const result = pruneAuditLogText(text, {
    now,
    retentionMs: 7 * 24 * 60 * 60 * 1000,
    maxBytes,
  });

  assert.equal(result.droppedExpired, 1);
  assert.equal(result.droppedForSize, 1);
  assert.equal(result.keptLines, 2);
  assert.equal(result.text, `${keep2}\n${keep3}\n`);
});
