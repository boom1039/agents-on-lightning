import test from 'node:test';
import assert from 'node:assert/strict';

import { NodeClient } from './client.js';

function makeClient(name, host = '127.0.0.1') {
  const client = new NodeClient({ name, host, restPort: 8080 });
  client.initFromCredentials(
    '00',
    '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
  );
  return client;
}

test('NodeClient reuses a shared HTTPS agent for the same backend and TLS cert', () => {
  const first = makeClient('first');
  const second = makeClient('second');
  const differentHost = makeClient('third', '127.0.0.2');

  assert.equal(first._agent, second._agent);
  assert.notEqual(first._agent, differentHost._agent);
});

test('NodeClient coalesces concurrent identical GET requests', async () => {
  const client = makeClient('singleflight');
  let calls = 0;
  client._doRequest = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { identity_pubkey: 'abc' };
  };

  const [first, second] = await Promise.all([
    client.getInfo(),
    client.getInfo(),
  ]);

  assert.equal(calls, 1);
  assert.deepEqual(first, second);

  await client.getInfo();
  assert.equal(calls, 2);
});
