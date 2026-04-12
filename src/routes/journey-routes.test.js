import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { startJourneyMonitor, stopJourneyMonitor } from '../monitor/journey-monitor.js';
import { journeyRoutes } from './journey-routes.js';

function fakeDaemon() {
  const publicEntries = [
    {
      ledger_id: 'tx-1',
      recorded_at: 2000,
      type: 'deposit_confirmed',
      agent_id: 'agent-route',
      amount_sats: 1000,
      address: 'bc1qrouteaddress',
      payment_request: 'lnbc-secret',
    },
  ];
  return {
    publicLedger: {
      getAll: async () => ({ entries: structuredClone(publicEntries), total: publicEntries.length }),
    },
    capitalLedger: {
      getAllBalances: async () => ({
        'agent-route': {
          available: 1000,
          locked: 0,
          pending_deposit: 0,
          pending_close: 0,
          total_deposited: 1000,
          total_withdrawn: 0,
          total_revenue_credited: 0,
          total_ecash_funded: 0,
          total_service_spent: 0,
          total_routing_pnl: 0,
        },
      }),
      readActivity: async ({ agentId } = {}) => ({
        entries: agentId === 'agent-route' || !agentId
          ? [{ _ts: 2001, agent_id: 'agent-route', type: 'deposit_confirmed', amount_sats: 1000 }]
          : [],
        total: agentId === 'agent-route' || !agentId ? 1 : 0,
      }),
    },
  };
}

async function startApp() {
  const tempDir = await mkdtemp(join(tmpdir(), 'aol-journey-routes-'));
  const monitor = await startJourneyMonitor({
    dbPath: join(tempDir, 'journey.duckdb'),
    idleShutdownMs: 50,
  });
  monitor.setDaemon(fakeDaemon());

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(journeyRoutes());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    tempDir,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

test('journey agents dashboard and ledger analytics require operator auth remotely', async () => {
  const prev = process.env.OPERATOR_API_SECRET;
  process.env.OPERATOR_API_SECRET = 'topsecret';
  const auth = `Basic ${Buffer.from('operator:topsecret').toString('base64')}`;
  const { server, baseUrl, tempDir } = await startApp();
  try {
    const unauth = await fetch(new URL('/journey/agents', baseUrl), {
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    assert.equal(unauth.status, 401);

    const page = await fetch(new URL('/journey/agents', baseUrl), {
      headers: {
        'x-forwarded-for': '203.0.113.10',
        authorization: auth,
      },
    });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /AOL MCP LEDGER CONSOLE/);

    const ledger = await fetch(new URL('/api/analytics/ledger/recent?limit=1', baseUrl), {
      headers: {
        'x-forwarded-for': '203.0.113.10',
        authorization: auth,
      },
    });
    assert.equal(ledger.status, 200);
    const ledgerJson = await ledger.json();
    assert.equal(ledgerJson.entries.length, 1);
    assert.equal(ledgerJson.entries[0].payment_request, undefined);
    assert.equal(ledgerJson.entries[0].address, undefined);
    assert.equal(ledgerJson.entries[0].address_hint, '...eaddress');
  } finally {
    await stopJourneyMonitor();
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.OPERATOR_API_SECRET;
    else process.env.OPERATOR_API_SECRET = prev;
  }
});
