import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getDefaultPortForRole,
  getServerRole,
  reserveServerSlot,
  validateServerPort,
} from './server-instance-guard.js';

function makeRegistryFile() {
  return join(mkdtempSync(join(tmpdir(), 'aol-server-guard-')), 'registry.json');
}

test('getServerRole defaults to main locally', () => {
  assert.equal(getServerRole({}), 'main');
});

test('getServerRole defaults to prod in production', () => {
  assert.equal(getServerRole({ NODE_ENV: 'production' }), 'prod');
});

test('getDefaultPortForRole returns the standard ports', () => {
  assert.equal(getDefaultPortForRole('main'), 3302);
  assert.equal(getDefaultPortForRole('scratch'), 3306);
  assert.equal(getDefaultPortForRole('prod'), 3302);
});

test('validateServerPort rejects nonstandard ports by default', () => {
  assert.throws(
    () => validateServerPort('scratch', 3304, {}),
    /must use port 3306/,
  );
});

test('reserveServerSlot rejects a duplicate local main server', () => {
  const registryFile = makeRegistryFile();
  const env = {
    NODE_ENV: 'development',
    AOL_ENFORCE_SERVER_LIMITS: '1',
  };
  const livePids = new Set([101, 202]);
  const isPidRunning = (pid) => livePids.has(pid);

  const mainLease = reserveServerSlot({
    role: 'main',
    host: '127.0.0.1',
    port: 3302,
    env,
    registryFile,
    pid: 101,
    isPidRunning,
  });

  assert.throws(
    () => reserveServerSlot({
      role: 'main',
      host: '127.0.0.1',
      port: 3302,
      env,
      registryFile,
      pid: 202,
      isPidRunning,
    }),
    /main server is already running/,
  );

  mainLease.release();
});

test('reserveServerSlot allows exactly one main and one scratch locally', () => {
  const registryFile = makeRegistryFile();
  const env = {
    NODE_ENV: 'development',
    AOL_ENFORCE_SERVER_LIMITS: '1',
  };
  const livePids = new Set([101, 202, 303]);
  const isPidRunning = (pid) => livePids.has(pid);

  const mainLease = reserveServerSlot({
    role: 'main',
    host: '127.0.0.1',
    port: 3302,
    env,
    registryFile,
    pid: 101,
    isPidRunning,
  });
  const scratchLease = reserveServerSlot({
    role: 'scratch',
    host: '127.0.0.1',
    port: 3306,
    env,
    registryFile,
    pid: 202,
    isPidRunning,
  });

  assert.ok(mainLease);
  assert.ok(scratchLease);

  mainLease.release();
  scratchLease.release();
});

test('reserveServerSlot rejects a second production server', () => {
  const registryFile = makeRegistryFile();
  const env = {
    NODE_ENV: 'production',
    AOL_ENFORCE_SERVER_LIMITS: '1',
  };
  const livePids = new Set([401, 402]);
  const isPidRunning = (pid) => livePids.has(pid);

  const prodLease = reserveServerSlot({
    role: 'prod',
    host: '127.0.0.1',
    port: 3302,
    env,
    registryFile,
    pid: 401,
    isPidRunning,
  });

  assert.throws(
    () => reserveServerSlot({
      role: 'prod',
      host: '127.0.0.1',
      port: 3302,
      env,
      registryFile,
      pid: 402,
      isPidRunning,
    }),
    /production server is already running/,
  );

  prodLease.release();
});
