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
    externalLeaderboard: {
      getData: () => ({
        entries: [
          {
            rank: 1,
            agent_id: 'agent-route',
            name: 'route-agent',
            total_fees_sats: 7,
            total_capacity_sats: 1000,
            fees_per_sat: 0.007,
            registered_at: 1000,
          },
        ],
        updatedAt: 2000,
        metric: 'all_time_routing_performance',
        sort_order: [
          { column: 'total_fees_sats', direction: 'desc' },
          { column: 'total_capacity_sats', direction: 'desc' },
          { column: 'fees_per_sat', direction: 'desc' },
          { column: 'registered_at', direction: 'asc' },
        ],
        agentCount: 1,
      }),
    },
    proofLedger: {
      getLatestGlobalProof: () => ({
        proof_id: 'proof-route-1',
        global_sequence: 1,
        proof_record_type: 'money_event',
        money_event_type: 'hub_deposit_settled',
        money_event_status: 'settled',
        agent_id: 'agent-route',
        event_source: 'hub_wallet',
        authorization_method: 'system_settlement',
        primary_amount_sats: 1000,
        proof_hash: 'hash-route-1',
        created_at_ms: 2000,
        public_safe_refs: { amount_sats: 1000, status: 'settled' },
      }),
      getLatestProofByRecordType: () => null,
      getLiabilityTotals: () => ({
        wallet_ecash_sats: 0,
        wallet_hub_sats: 1000,
        capital_available_sats: 0,
        capital_locked_sats: 0,
        capital_pending_deposit_sats: 0,
        capital_pending_close_sats: 0,
        capital_service_spent_sats: 0,
        routing_pnl_sats: 0,
        total_tracked_sats: 1000,
      }),
      countProofs: () => 1,
      listAgentIds: () => ['agent-route'],
      getAgentBalance: () => ({
        wallet_ecash_sats: 0,
        wallet_hub_sats: 1000,
        capital_available_sats: 0,
        capital_locked_sats: 0,
        capital_pending_deposit_sats: 0,
        capital_pending_close_sats: 0,
        capital_service_spent_sats: 0,
        routing_pnl_sats: 0,
        total_tracked_sats: 1000,
      }),
      getLatestAgentProof: () => ({
        proof_id: 'proof-route-1',
        global_sequence: 1,
        proof_record_type: 'money_event',
        money_event_type: 'hub_deposit_settled',
        money_event_status: 'settled',
        agent_id: 'agent-route',
        event_source: 'hub_wallet',
        authorization_method: 'system_settlement',
        proof_hash: 'hash-route-1',
        created_at_ms: 2000,
        public_safe_refs: { amount_sats: 1000, status: 'settled' },
      }),
      verifyChain: () => ({ valid: true, checked: 1, latest_hash: 'hash-route-1', errors: [] }),
      getPublicKeyInfo: () => ({ signing_key_id: 'ed25519:route-test' }),
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

    const proofSummary = await fetch(new URL('/api/analytics/proof-ledger/summary', baseUrl), {
      headers: {
        'x-forwarded-for': '203.0.113.10',
        authorization: auth,
      },
    });
    assert.equal(proofSummary.status, 200);
    const proofJson = await proofSummary.json();
    assert.equal(proofJson.source_of_truth, 'proof_ledger');
    assert.equal(proofJson.proof_of_liabilities.total_liability_sats, 1000);
    assert.equal(proofJson.global_chain.valid, true);

    const leaderboard = await fetch(new URL('/api/analytics/leaderboard?limit=1', baseUrl), {
      headers: {
        'x-forwarded-for': '203.0.113.10',
        authorization: auth,
      },
    });
    assert.equal(leaderboard.status, 200);
    const leaderboardJson = await leaderboard.json();
    assert.equal(leaderboardJson.entries.length, 1);
    assert.equal(leaderboardJson.entries[0].agent_id, 'agent-route');
    assert.equal(leaderboardJson.sort_order[0].column, 'total_fees_sats');
  } finally {
    await stopJourneyMonitor();
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.OPERATOR_API_SECRET;
    else process.env.OPERATOR_API_SECRET = prev;
  }
});
