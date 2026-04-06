import assert from 'node:assert/strict';
import test from 'node:test';

import { getAgentSurfaceManifest } from '../../src/monitor/agent-surface-inventory.js';
import { createRouteTestHarness } from './route-test-harness.mjs';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const SAMPLE_SEGMENTS = {
  id: 'test0001',
  agentId: 'test0001',
  pubkey: `02${'1'.repeat(64)}`,
  chanId: '1234567890',
  channelId: '1234567890',
  peerPubkey: `03${'2'.repeat(64)}`,
  swapId: 'swap-test',
  flowId: 'flow-test',
  name: 'sample',
};

function materializePath(path) {
  return `${path}`.replace(/:([A-Za-z0-9_]+)/g, (_match, param) => SAMPLE_SEGMENTS[param] || 'sample');
}

function buildRequest(route) {
  const headers = { Accept: 'application/json' };
  const request = { method: route.method, headers };
  if (WRITE_METHODS.has(route.method)) {
    headers['Content-Type'] = 'application/json';
    request.body = JSON.stringify({});
  }
  return request;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function renderTable(rows) {
  const headers = ['Route', 'Status', 'Error', 'Message'];
  const tableRows = rows.map((row) => [
    row.key,
    String(row.status),
    row.error || '',
    row.message || '',
  ]);
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...tableRows.map((row) => row[index].length),
  ));
  const format = (row) => row.map((cell, index) => cell.padEnd(widths[index])).join(' | ');
  return [
    format(headers),
    widths.map((width) => '-'.repeat(width)).join('-|-'),
    ...tableRows.map(format),
  ].join('\n');
}

test('every agent-auth route rejects missing bearer auth', async () => {
  const harness = await createRouteTestHarness();
  try {
    const manifest = getAgentSurfaceManifest();
    const protectedRoutes = manifest.routes.filter((route) => route.auth === 'agent');
    const failures = [];

    for (const route of protectedRoutes) {
      const response = await harness.fetch(materializePath(route.path), buildRequest(route));
      const text = await response.text();
      const payload = parseJson(text);
      const goodStatus = response.status === 401;
      const goodError = payload?.error === 'authentication_required';

      if (!goodStatus || !goodError) {
        failures.push({
          key: route.key,
          status: response.status,
          error: payload?.error || '',
          message: payload?.message || text.slice(0, 120),
        });
      }
    }

    assert.deepEqual(
      failures,
      [],
      failures.length ? `Protected routes missing the no-token auth wall:\n${renderTable(failures)}` : undefined,
    );
  } finally {
    await harness.close();
  }
});
