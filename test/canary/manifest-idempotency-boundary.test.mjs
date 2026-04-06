import assert from 'node:assert/strict';
import test from 'node:test';

import { getAgentSurfaceManifest } from '../../src/monitor/agent-surface-inventory.js';
import { createRouteTestHarness } from './route-test-harness.mjs';

function renderTable(rows) {
  const headers = ['Route', 'Calls', 'First', 'Second'];
  const tableRows = rows.map((row) => [
    row.key,
    String(row.calls),
    row.first,
    row.second,
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

test('active idempotent routes do not double-apply the same request key', async () => {
  const manifest = getAgentSurfaceManifest();
  const manifestKeys = new Set(manifest.routes.map((route) => route.key));
  const failures = [];

  const cases = [
    {
      key: 'POST /api/v1/analytics/execute',
      build: () => {
        let calls = 0;
        return {
          daemonOverrides: {
            analyticsGateway: {
              getCatalog: () => ({ queries: [] }),
              getQuote: () => ({ price_sats: 0 }),
              execute: async () => {
                calls += 1;
                return { query_id: 'health', price_sats: 7, rows: [{ run: calls }] };
              },
              getHistory: async () => ({ entries: [], total: 0 }),
            },
          },
          request: {
            path: '/api/v1/analytics/execute',
            body: { query_id: 'health', params: {}, idempotency_key: 'same-key' },
          },
          getCalls: () => calls,
        };
      },
    },
    {
      key: 'POST /api/v1/capital/deposit',
      build: () => {
        let calls = 0;
        return {
          daemonOverrides: {
            depositTracker: {
              generateAddress: async () => {
                calls += 1;
                return { address: `bcrt1ptestaddress${calls.toString().padStart(4, '0')}` };
              },
              getDepositStatus: () => ({ deposits: [] }),
              _confirmationsRequired: 3,
            },
          },
          request: {
            path: '/api/v1/capital/deposit',
            body: { idempotency_key: 'same-key' },
          },
          getCalls: () => calls,
        };
      },
    },
    {
      key: 'POST /api/v1/help',
      build: () => {
        let calls = 0;
        return {
          daemonOverrides: {
            helpEndpoint: {
              ask: async () => {
                calls += 1;
                return { answer: `reply-${calls}` };
              },
            },
          },
          request: {
            path: '/api/v1/help',
            body: { question: 'how do I fund?', context: {}, idempotency_key: 'same-key' },
          },
          getCalls: () => calls,
        };
      },
    },
    {
      key: 'POST /api/v1/channels/instruct',
      build: () => {
        let calls = 0;
        return {
          daemonOverrides: {
            channelExecutor: {
              preview: async () => ({ ok: true }),
              execute: async () => {
                calls += 1;
                return { success: true, result: { applied_run: calls }, learn: 'ok' };
              },
              getInstructions: async () => [],
              resetForTests: async () => {},
            },
          },
          request: {
            path: '/api/v1/channels/instruct',
            body: {
              instruction: { channel_id: 'chan-owned', action: 'set_fee_policy' },
              signature: '00',
              idempotency_key: 'same-key',
            },
          },
          getCalls: () => calls,
        };
      },
    },
    {
      key: 'POST /api/v1/market/open',
      build: () => {
        let calls = 0;
        return {
          daemonOverrides: {
            channelOpener: {
              getConfig: () => ({ ok: true }),
              preview: async () => ({ ok: true }),
              open: async () => {
                calls += 1;
                return { success: true, status: 'pending_open', open_id: `open-${calls}` };
              },
              getPendingForAgent: () => [],
            },
          },
          request: {
            path: '/api/v1/market/open',
            body: {
              instruction: { action: 'channel_open', params: {} },
              signature: '00',
              idempotency_key: 'same-key',
            },
          },
          getCalls: () => calls,
        };
      },
    },
    {
      key: 'POST /api/v1/market/close',
      build: () => {
        let calls = 0;
        return {
          daemonOverrides: {
            channelCloser: {
              refreshNow: async () => {},
              requestClose: async () => {
                calls += 1;
                return { success: true, status: 'pending_close', close_id: `close-${calls}` };
              },
              getClosesForAgent: () => [],
            },
          },
          request: {
            path: '/api/v1/market/close',
            body: {
              instruction: { action: 'channel_close', params: { channel_point: 'fundtx:0' } },
              signature: '00',
              idempotency_key: 'same-key',
            },
          },
          getCalls: () => calls,
        };
      },
    },
    {
      key: 'POST /api/v1/market/rebalance',
      build: () => {
        let calls = 0;
        return {
          daemonOverrides: {
            rebalanceExecutor: {
              validateRequest: async () => ({ success: true }),
              requestRebalance: async () => {
                calls += 1;
                return { success: true, status: 'in_flight', rebalance_id: `rebalance-${calls}` };
              },
              estimateRebalanceFee: async () => ({ fee_sats: 0 }),
              getRebalanceHistory: async () => ({ entries: [], total: 0 }),
              getPendingForAgent: () => [],
            },
          },
          request: {
            path: '/api/v1/market/rebalance',
            body: {
              instruction: { action: 'rebalance', params: {} },
              signature: '00',
              idempotency_key: 'same-key',
            },
          },
          getCalls: () => calls,
        };
      },
    },
  ];

  for (const item of cases) {
    assert.ok(manifestKeys.has(item.key), `missing manifest route for ${item.key}`);
    const built = item.build();
    const harness = await createRouteTestHarness({
      withDataLayer: true,
      daemonOverrides: built.daemonOverrides,
    });

    try {
      const headers = {
        Authorization: `Bearer ${harness.agents.primary.api_key}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };

      const first = await harness.fetch(built.request.path, {
        method: 'POST',
        headers,
        body: JSON.stringify(built.request.body),
      });
      const firstText = await first.text();

      const second = await harness.fetch(built.request.path, {
        method: 'POST',
        headers,
        body: JSON.stringify(built.request.body),
      });
      const secondText = await second.text();

      const sameStatus = first.status === second.status;
      const sameBody = firstText === secondText;
      const singleCall = built.getCalls() === 1;

      if (!sameStatus || !sameBody || !singleCall) {
        failures.push({
          key: item.key,
          calls: built.getCalls(),
          first: `${first.status} ${firstText.slice(0, 60)}`,
          second: `${second.status} ${secondText.slice(0, 60)}`,
        });
      }
    } finally {
      await harness.close();
    }
  }

  assert.deepEqual(
    failures,
    [],
    failures.length ? `Idempotent routes re-applied the same request:\n${renderTable(failures)}` : undefined,
  );
});
