import assert from 'node:assert/strict';
import test from 'node:test';
import { getAgentSurfaceManifest } from '../../src/monitor/agent-surface-inventory.js';
import { buildEndpointTestMatrix } from './endpoint-test-matrix.mjs';

function isDynamicRoute(row = {}) {
  return Array.isArray(row.tags) && row.tags.includes('dynamic');
}

test('endpoint test matrix stays aligned with the manifest source of truth', () => {
  const manifest = getAgentSurfaceManifest();
  const matrix = buildEndpointTestMatrix();
  const rowsByKey = new Map(matrix.rows.map((row) => [row.key, row]));
  const lookupEntries = Object.entries(manifest.route_lookup || {});

  assert.equal(matrix.total_routes, manifest.routes.length);
  assert.equal(matrix.rows.length, manifest.routes.length);
  assert.equal(lookupEntries.length, manifest.routes.length);

  for (const route of manifest.routes) {
    const row = rowsByKey.get(route.key);
    const lookup = manifest.route_lookup?.[route.key];
    assert.ok(row, `missing matrix row for ${route.key}`);
    assert.ok(lookup, `missing route_lookup entry for ${route.key}`);
    assert.deepEqual(row.security, route.security, `security mismatch for ${route.key}`);
    assert.deepEqual(lookup.security, route.security, `route_lookup security mismatch for ${route.key}`);
    assert.equal(lookup.auth, route.auth, `route_lookup auth mismatch for ${route.key}`);
    assert.equal(lookup.domain, route.domain, `route_lookup domain mismatch for ${route.key}`);
    assert.equal(lookup.subgroup, route.subgroup, `route_lookup subgroup mismatch for ${route.key}`);
    assert.equal(row.auth, route.auth, `auth mismatch for ${route.key}`);
    assert.equal(row.domain, route.domain, `domain mismatch for ${route.key}`);
    assert.equal(row.subgroup, route.subgroup, `subgroup mismatch for ${route.key}`);
    assert.deepEqual(row.docs, route.doc_refs, `doc mismatch for ${route.key}`);
    assert.equal(row.source_file, route.source_file, `source file mismatch for ${route.key}`);
    assert.equal(row.source_line, route.source_line, `source line mismatch for ${route.key}`);
  }
});

test('manifest security contracts stay internally consistent', () => {
  const manifest = getAgentSurfaceManifest();
  const failures = [];

  for (const route of manifest.routes) {
    const security = route.security || {};
    if (security.moves_money && route.auth !== 'agent') {
      failures.push(`${route.key} moves money but is not agent-auth`);
    }
    if (security.moves_money && !security.requires_ownership) {
      failures.push(`${route.key} moves money but does not require ownership`);
    }
    if (security.requires_signature && route.auth !== 'agent') {
      failures.push(`${route.key} requires signature but is not agent-auth`);
    }
    if (security.requires_ownership && route.auth !== 'agent') {
      failures.push(`${route.key} requires ownership but is not agent-auth`);
    }
  }

  assert.deepEqual(failures, [], failures.join('\n'));
});

test('manifest branching does not leave generic manual-review routes behind', () => {
  const matrix = buildEndpointTestMatrix();
  const unresolved = matrix.rows.filter((row) => row.full_success_test === 'manual-review');
  assert.deepEqual(
    unresolved.map((row) => row.key),
    [],
    `manual-review rows should be driven out by manifest security: ${unresolved.map((row) => row.key).join(', ')}`,
  );
});

test('signed routes branch into signed boundary tests', () => {
  const matrix = buildEndpointTestMatrix();
  const signed = matrix.rows.filter((row) => row.security?.requires_signature);

  for (const row of signed) {
    assert.equal(row.boundary_test, 'auto-signed', `${row.key} should use auto-signed boundary checks`);
    assert.equal(row.prod_policy, 'manual-user', `${row.key} should stay manual on prod`);
  }
});

test('money routes never default to a plain same-success lane', () => {
  const matrix = buildEndpointTestMatrix();
  const moneyRoutes = matrix.rows.filter((row) => row.security?.moves_money);

  for (const row of moneyRoutes) {
    assert.notEqual(row.full_success_test, 'same', `${row.key} should not use same-success money testing`);
  }
});

test('public reads and simple private reads keep their low-friction defaults', () => {
  const matrix = buildEndpointTestMatrix();

  for (const row of matrix.rows) {
    if (row.auth === 'public' && row.method === 'GET') {
      assert.equal(row.prod_policy, 'safe-auto', `${row.key} should stay safe-auto`);
      continue;
    }

    if (
      row.auth === 'agent'
      && row.method === 'GET'
      && !row.exact_override
      && !isDynamicRoute(row)
      && !row.security?.moves_money
      && !row.security?.requires_signature
    ) {
      assert.equal(row.full_success_test, 'same', `${row.key} should keep same-success reads`);
      assert.equal(row.prod_policy, 'safe-auto', `${row.key} should stay safe-auto`);
    }
  }
});
