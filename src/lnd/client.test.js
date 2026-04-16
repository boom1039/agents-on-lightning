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

test('NodeClient closeChannel uses first stream event from LND close endpoint', async () => {
  const client = makeClient('close-stream');
  let called = null;
  client._deleteStreamFirst = async (path, query, requestOptions) => {
    called = { path, query, requestOptions };
    return { close_pending: { txid: 'close-tx' } };
  };

  const result = await client.closeChannel('fundingtx:1', false, 3, { timeoutMs: 12_345 });

  assert.deepEqual(result, { close_pending: { txid: 'close-tx' } });
  assert.deepEqual(called, {
    path: '/v1/channels/fundingtx/1',
    query: { force: false, sat_per_vbyte: 3 },
    requestOptions: { timeoutMs: 12_345 },
  });
});

test('NodeClient estimateFee maps address amounts into LND REST query params', async () => {
  const client = makeClient('estimate-fee');
  let called = null;
  client._get = async (path, query) => {
    called = { path, query };
    return { fee_sat: '144', sat_per_vbyte: '1' };
  };

  const result = await client.estimateFee('bc1qdest', 99_000, {
    targetConf: 3,
    minConfs: 1,
    spendUnconfirmed: false,
  });

  assert.deepEqual(result, { fee_sat: '144', sat_per_vbyte: '1' });
  assert.deepEqual(called, {
    path: '/v1/transactions/fee',
    query: {
      'AddrToAmount[bc1qdest]': '99000',
      target_conf: 3,
      min_confs: 1,
      spend_unconfirmed: false,
    },
  });
});
